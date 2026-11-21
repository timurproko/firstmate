#!/usr/bin/env node
// crew - a small, agent-agnostic crew tool on Herdr Core.
//
// One coordinator agent owns a crew home and calls these commands; each worker is an
// ordinary agent in its own Core terminal and its own git worktree. Everything is one
// short process talking to Core through `hc`; there is no watcher, no hook and no
// background service. See the sibling README.md for the design and its limits.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION = '0.11.0';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WINDOWS = process.platform === 'win32';
// Everything of crew on a machine lives under ~/.crew, which is also the default home:
// core/ (this code, when installed from Herdr), coordinator/ (the coordinator's rules and the
// folder it starts in), tasks/, .worktrees/ (workers' copies), state/ (update and crash
// records) and crew.json (the registered projects).
const CREW_DIR = path.join(os.homedir(), '.crew');
export const DEFAULT_HOME = CREW_DIR;

// --- agents ------------------------------------------------------------------
// The only per-agent knowledge: how to start it with one instruction, and how it can be
// asked to leave. `close` means the terminal is closed once the agent is no longer working.
// `args` follow the instruction: Claude Code reads a prompt placed after --allowedTools as
// one more tool name. A Claude worker keeps its permission system; it is only told up front
// that editing files and using its ordinary tools inside its own working copy is expected,
// so it does not stop to ask for each one. Folder trust: see trustClaudeFolder below.
// `seen` marks an agent Core recognises in a terminal (it reports the agent and whether it is
// working); only for those can crew tell that the agent is gone while the terminal lives on.
// PowerShell is in the list beside Bash: on Windows Claude Code runs its commands through
// that tool, and without it every command (`crew done` included) waits for a person.
export const AGENTS = {
  a1: { command: 'a1', exit: 'a1-api', seen: true },
  pi: { command: 'pi', exit: 'close' },
  claude: { command: 'claude', exit: 'close', seen: true, trust: 'claude', args: ['--permission-mode', 'acceptEdits', '--allowedTools', 'Bash,PowerShell,Read,Edit,Write,Glob,Grep'] },
};

// --- small helpers -----------------------------------------------------------
class Refusal extends Error { constructor(message, code = 2) { super(message); this.exitCode = code; } }
const refuse = (message, code) => { throw new Refusal(message, code); };
export const validId = id => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(id);
const slash = p => String(p).replace(/\\/g, '/');
// Single-quoted for a POSIX shell, whatever the text contains.
export const shq = text => `'${String(text).replace(/'/g, `'\\''`)}'`;
// A Windows path as Git Bash spells it (D:\x -> /d/x); other paths unchanged.
export const bashPath = p => { const s = slash(p); return /^[A-Za-z]:\//.test(s) ? `/${s[0].toLowerCase()}${s.slice(2)}` : s; };
const now = () => new Date().toISOString();

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}
function run(command, args, options = {}) {
  const r = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, ...options });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error ?? null };
}

// --- Core --------------------------------------------------------------------
// CREW_HC names another hc binary; a .mjs path is run with node (the tests' fake Core).
const HC = process.env.CREW_HC || 'hc';
function hc(args) {
  const r = HC.endsWith('.mjs') ? run(process.execPath, [HC, ...args]) : run(HC, args);
  if (r.error) refuse(`herdr-core (hc) could not be run: ${r.error.message}`, 4);
  return r;
}
function hcJson(args) {
  const r = hc(args);
  try { return { code: r.code, value: JSON.parse(r.stdout || r.stderr) }; } catch { return { code: r.code, value: null }; }
}
// What Core says about a terminal, in three distinct answers. `absent` only when Core
// itself says it has no such terminal; any other failed query is `unknown`, and an unknown
// answer never justifies taking a home over, failing a task or deleting a worker's files.
function probe(address) {
  if (!address) return { state: 'absent', t: null };
  const { code, value } = hcJson(['get', '--json', address]);
  if (code === 0 && value && !value.error && typeof value.state === 'string') return { state: value.state === 'live' ? 'live' : 'finished', t: value };
  if (value?.error?.kind === 'not_found') return { state: 'absent', t: null };
  return { state: 'unknown', t: null };
}
// The terminal for display purposes, or null when Core gave no terminal (for any reason).
const terminal = address => probe(address).t;
const CORE_SILENT = 'Core did not answer about';
const me = () => process.env.CREW_TERMINAL || process.env.HC_TERMINAL_ID || null;

// --- home --------------------------------------------------------------------
function findHome() {
  if (process.env.CREW_HOME) return path.resolve(process.env.CREW_HOME);
  for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'crew.json'))) return dir;
    if (path.dirname(dir) === dir) break;
  }
  // Otherwise the per-user home, so `crew` works from any folder on the machine.
  return [DEFAULT_HOME, ...LEGACY_HOMES].find(dir => fs.existsSync(path.join(dir, 'crew.json'))) ?? null;
}
// The default home used to be one folder holding everything: ~/.crew/home until 0.6, then
// ~/.crew/crew. Since 0.7 the home is ~/.crew itself and the coordinator's rules have their
// own folder, so tasks and settings no longer sit under a second "crew". An existing home
// is unpacked once, and only when nobody can be using it: no live owner. Until then the old
// place keeps working. Task records hold paths into the home, so those are rewritten.
const LEGACY_HOMES = ['crew', 'home'].map(name => path.join(CREW_DIR, name));
const RULE_FILES = ['AGENTS.md', 'CLAUDE.md'];
const legacyHome = () => LEGACY_HOMES.find(dir => fs.existsSync(path.join(dir, 'crew.json'))) ?? null;
function moveLegacyHome() {
  const old = legacyHome();
  if (!old || fs.existsSync(path.join(DEFAULT_HOME, 'crew.json'))) return null;
  const target = name => (RULE_FILES.includes(name) ? path.join(DEFAULT_HOME, 'coordinator', name) : path.join(DEFAULT_HOME, name));
  const done = [];
  try {
    const owner = readJson(path.join(old, 'owner.json'));
    if (owner?.terminal && probe(owner.terminal).state !== 'absent' && probe(owner.terminal).state !== 'finished') return { old, why: 'a session still holds it' };
    const names = fs.readdirSync(old), taken = names.find(name => fs.existsSync(target(name)));
    if (taken) return { old, why: `${slash(target(taken))} already exists` };
    fs.mkdirSync(path.join(DEFAULT_HOME, 'coordinator'), { recursive: true });
    // crew.json goes last: until it has moved, the old folder is still the home.
    for (const name of [...names.filter(n => n !== 'crew.json'), 'crew.json']) { fs.renameSync(path.join(old, name), target(name)); done.push(name); }
  } catch (error) {
    // Something in it is held open: put back what already moved, so the old home stays whole.
    for (const name of done.reverse()) { try { fs.renameSync(target(name), path.join(old, name)); } catch { /* reported below */ } }
    return { old, why: `it is in use (${error.code ?? error.message})` };
  }
  try { fs.rmdirSync(old); } catch { /* a terminal still sits in the emptied folder */ }
  const from = `${slash(old)}/`, to = `${slash(DEFAULT_HOME)}/`, tasks = path.join(DEFAULT_HOME, 'tasks');
  for (const id of fs.existsSync(tasks) ? fs.readdirSync(tasks) : []) {
    const file = path.join(tasks, id, 'task.json'), task = readJson(file);
    if (!task) continue;
    for (const key of ['report', 'brief']) if (typeof task[key] === 'string' && task[key].startsWith(from)) task[key] = to + task[key].slice(from.length);
    writeJson(file, task);
  }
  return { old, moved: true };
}
// `crew home` prints the folder the coordinator starts in; `--ensure` first unpacks an old
// home when that is safe and creates the default home when there is none. Herdr runs it
// before it starts a coordinator, to know which folder to start it in.
function cmdHome(args) {
  if (args.includes('--ensure') && !process.env.CREW_HOME) {
    const moved = moveLegacyHome();
    if (moved?.moved) console.error(`crew: the home moved from ${slash(moved.old)} to ${slash(DEFAULT_HOME)}`);
    else if (moved) console.error(`crew: the home stays at ${slash(moved.old)} for now: ${moved.why}`);
    if (!fs.existsSync(path.join(DEFAULT_HOME, 'crew.json')) && !legacyHome()) createHome(DEFAULT_HOME);
  }
  console.log(slash(home().coordinator));
}
function home() {
  const dir = findHome();
  if (!dir || !fs.existsSync(path.join(dir, 'crew.json'))) refuse('No crew home yet. Run `crew init` once (it creates ~/.crew), or `crew init <folder>` for a home elsewhere.');
  const config = readJson(path.join(dir, 'crew.json'));
  if (!config || config.version !== 1) refuse(`${path.join(dir, 'crew.json')} is not a version 1 crew home.`);
  // A home from before 0.7 holds the coordinator's rules itself; a newer one keeps them in
  // coordinator/. Working copies are never under the folder with those rules: agents read
  // instruction files from their folder upwards, so a worker placed there would load the
  // coordinator's rules and act as one.
  const unpacked = fs.existsSync(path.join(dir, 'coordinator'));
  const coordinator = unpacked ? path.join(dir, 'coordinator') : dir;
  const worktrees = process.env.CREW_WORKTREES ? path.join(process.env.CREW_WORKTREES, String(config.tag))
    : unpacked ? path.join(dir, '.worktrees') : path.join(CREW_DIR, '.worktrees', String(config.tag));
  return { dir, config, coordinator, tasks: path.join(dir, 'tasks'), worktrees, owner: path.join(dir, 'owner.json') };
}
const taskDir = (h, id) => path.join(h.tasks, id);
const taskFile = (h, id) => path.join(taskDir(h, id), 'task.json');
function loadTask(h, id) {
  if (!validId(id)) refuse(`Not a task id: ${id}`);
  const task = readJson(taskFile(h, id));
  if (!task) refuse(`No task ${id} in ${h.dir}.`);
  return task;
}
const saveTask = (h, task) => writeJson(taskFile(h, task.id), { ...task, updated: now() });
function allTasks(h) {
  if (!fs.existsSync(h.tasks)) return [];
  return fs.readdirSync(h.tasks).filter(validId).map(id => readJson(taskFile(h, id))).filter(Boolean)
    .sort((a, b) => String(a.created).localeCompare(String(b.created)));
}

// --- ownership ---------------------------------------------------------------
// One coordinator per home. The owner is a Core terminal; it is live while Core says that
// terminal is live. A second session gets a refusal and may only read.
function ownerState(h) {
  const owner = readJson(h.owner);
  if (!owner?.terminal) return { owner: null, live: false, mine: false };
  const mine = owner.terminal === me();
  if (mine) return { owner, live: true, mine, unknown: false };
  // An owner Core could not be asked about is treated as still there: nobody takes over on
  // a failed query.
  const state = probe(owner.terminal).state;
  return { owner, live: state === 'live' || state === 'unknown', mine, unknown: state === 'unknown' };
}
function requireOwner(h) {
  const { owner, live, mine } = ownerState(h);
  if (mine) return;
  if (owner && live) refuse(`Read-only: this home is owned by terminal ${owner.terminal}. Only that session may change it.`, 3);
  refuse('This session does not hold the home. Run `crew start` first.', 3);
}

// --- Claude Code folder trust ---------------------------------------------------
// Claude Code asks "do you trust this folder?" for every new path whose project carries
// Claude settings, and a worker's copy is always a new path, so every Claude worker would
// stop at a dialog nobody is watching. Registering a project with `crew project add` is
// the person's decision that agents may work on it; a worker's copy is that same code. So
// crew records the copy as trusted in Claude's own config before starting the worker, the
// way Claude itself records an accepted dialog, and removes the entry again at finish.
// This means the project's Claude settings (hooks included) load in the worker unasked.
const claudeConfigFile = () => process.env.CREW_CLAUDE_CONFIG || path.join(os.homedir(), '.claude.json');
function editClaudeProjects(edit) {
  const file = claudeConfigFile();
  let config;
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') return false; // unreadable or not JSON: never overwrite it
    config = {};
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false;
  if (!config.projects || typeof config.projects !== 'object') config.projects = {};
  if (!edit(config.projects)) return true;
  const tmp = `${file}.crew-${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(config, null, 2)); fs.renameSync(tmp, file); return true; }
  catch { fs.rmSync(tmp, { force: true }); return false; }
}
export const trustClaudeFolder = folder => editClaudeProjects(projects => {
  const key = slash(folder);
  if (projects[key]?.hasTrustDialogAccepted === true) return false;
  projects[key] = { ...(projects[key] ?? {}), hasTrustDialogAccepted: true, crewWorkerCopy: true };
  return true;
});
const forgetClaudeFolder = folder => editClaudeProjects(projects => {
  const key = slash(folder);
  if (!projects[key]?.crewWorkerCopy) return false; // only entries crew made
  delete projects[key];
  return true;
});

// --- commands ----------------------------------------------------------------
const COORDINATOR_RULES = `# Crew coordinator

You coordinate workers for the person you are talking to. You do not do the project work
yourself; you hand each piece to a worker with the \`crew\` command and report results.

## Every session
1. Run \`crew start\`. If it refuses, another session owns this home: you are read-only,
   say so, and do not spawn, stop or finish anything.
2. Run \`crew status\` to see work left by an earlier session and finish it by the book.

## One task
1. \`crew spawn <id> --project <name> --kind scout|ship "<task for the worker>"\`
   - \`scout\`: read-only investigation, ends with a written report.
   - \`ship\`: changes code on a branch of its own, \`<type>/<id>\`. Say what the work is with
     \`--type feature|fix|refactor|docs|test|chore|style\` (default \`feature\`). How it is
     delivered depends on the project: see "Code changes".
   - Independent tasks may be spawned one after another without waiting; they run together.
   - Who does it is crew's choice unless the person said otherwise: see "Who does the work".
2. \`crew wait <id> [<id>...]\` blocks until each worker reports (or fails). It prints the reports.
3. Tell the person the result in your own words. Do not paste the whole report unless asked.
4. \`crew finish <id>\` stops the worker and removes its terminal and working copy.
   Finish only after the person has their answer; never finish a task that is still working
   unless they asked you to cancel it.

## Code changes (ship tasks)
\`crew spawn\` says how the project delivers. There are three kinds:
- **Shared delivery workflow** (the repository follows the \`change-delivery\` skill):
  1. The worker's first report is its plan with a draft pull request. Read the plan (in the
     worker's copy or the pull request) and decide yourself: \`crew tell <id> "approved, implement"\`,
     or send it back with what to change. Ask the person only when the plan needs a decision
     that is theirs (scope, direction, a risk the task did not cover); otherwise tell them the
     plan and that you approved it, in a line or two.
  2. After it reports the implementation, have it checked as for a plain project (steps 1-2).
  3. \`crew land <id>\` records its pull request. Give the person the link.
- **no-mistakes gate**: see Tools. Skip \`crew review\`; \`crew land\` records the gate's pull request.
- **Plain project**:
  1. After the worker reported, have the change checked unless it is trivial:
     \`crew review <id>\` starts a reviewer (\`--agent\`, \`--model\` or \`--account\` picks another one
     for a second opinion); \`crew wait <id>-review\`. Its report starts with \`APPROVE\` or \`CHANGES NEEDED\`.
  2. On \`CHANGES NEEDED\`: \`crew tell <id> "<the defects, as the reviewer wrote them>"\`, then
     \`crew wait <id>\` and review again. After two rounds that still fail, tell the person.
  3. \`crew land <id>\` pushes the branch and opens a pull request. Give the person the link.
- Merging is the person's: never merge a project's pull request unless they told you to.
  Finish the reviewer and the task only once \`crew land\` has recorded the pull request (a
  workflow task's draft is open from its plan on; finishing it then loses the worker).
- \`crew tell <id> "<message>"\` is also how you answer a worker's question or correct its
  course; the worker reports again when it has dealt with it.
- A repository that delivers by pull request but is not recognised (or the other way round):
  ask the person, then \`crew project add <name> <folder> --workflow delivery|plain\`.

## Who does the work
The person's agents, models and accounts are in \`config/crew-dispatch.json\` of this home, as an
ordered list: the first that has quota and a working login takes the task, the others stand
behind it. Crew reads the quota itself (quota-axi, each saved Claude account separately).
- \`crew agents\` shows the list as it stands now, with quota, and its numbered rules.
  \`crew agents --role ship|review|fix\` shows it for that kind of work, \`--project <name>\` for a
  project that has a list of its own.
- Say nothing and crew chooses. When a rule's \`when\` describes the task, add \`--rule <n>\`.
- When the person names an agent, model or account, pass it: \`--agent a1|pi|claude\`,
  \`--model <id>\` (for a1 and pi \`<provider>/<id>\`, e.g. \`github-copilot/...\`, which chooses the
  login), \`--effort <level>\`, \`--account <claude account>\`. The list still stands behind that
  choice; \`--no-fallback\` only when the person wants that one and nothing else.
- A worker that runs out of quota, loses its login, or whose agent crashed or left without a
  report is not a failure: \`crew wait\` hands its
  task to the next in the list, in the same working copy, and keeps waiting. It says so in a
  line; pass that on to the person. \`crew relaunch <id> [--agent ...]\` does the same by hand.
- \`crew wait\` tells a worker stopped on a provider or network error to continue, then hands the task over if that does not help.
  It reports each action in a line; pass it on to the person afterwards rather than asking them to resume the worker.
- "Nobody can take this work now" lists why for each candidate. Tell the person exactly that;
  do not retry in a loop.

## Rules
- Never work in a worker's copy yourself and never edit a project directly.
- When the person has you do a piece of work yourself, follow the shared delivery workflow
  (the \`change-delivery\` skill) for your working copy, as workers do.
- \`crew finish\` saying the working copy is kept because another terminal holds it: the task is
  finished; only the copy waits, since returning it would end that terminal (the person's or
  another agent's). Crew returns the copy by itself at a later \`crew start\` or \`crew finish\`
  once nothing holds it. Never close that terminal yourself. A waiting copy that has new
  uncommitted work or a keep marker stays until the person decides; \`crew finish <id> --force\`
  discards that and returns it, only when they say so.
- \`crew wait\` saying a worker needs a person: tell the person which terminal is waiting and
  why; do not finish it. Wait again once they have answered.
- A worker that failed or went quiet: read \`crew status\`, look at its terminal with
  \`hc read <terminal> --lines 80\`, then either spawn a fresh worker or tell the person.
- \`crew project list\` shows the projects you may use. Ask before adding one.
- When you are done for the session, run \`crew end\`.

## Tools
\`crew tools\` shows which of these are installed on this machine. Use the ones that are; none
is required. For any of them, read its \`--help\` before the first use instead of guessing.
- **Backlog** (\`tasks-axi\`): \`crew backlog\` is the durable list of work, kept in this home.
  \`crew backlog add <id> "<title>"\` queues something the person mentions for later;
  \`crew backlog ready\` shows what can be started. Give a task the same id as its backlog
  item and crew moves the item itself: In flight at spawn, Done at land (ship) or finish
  (scout). A decision that waits for the person: \`crew backlog hold <id> --reason "<why>"\`.
- **Quota** (\`quota-axi\`): crew reads it when it chooses who works; \`crew agents\` shows the result.
  You do not need to run it yourself.
- **GitHub** (\`gh-axi\`): read issues, pull requests and checks with it. \`crew land\` opens
  pull requests itself.
- **Browser** (\`chrome-devtools-axi\`): for looking at a web page. Workers are told about it.
- **Showing instead of telling** (\`lavish-axi\`): when the person must choose between several
  options, or a report is long, write it as a page (\`lavish-axi --help\` says how) and open
  it with \`crew show <page.html>\`, never with \`lavish-axi <page.html>\` directly: the person
  may be at another machine, and \`crew show\` also puts a Lavish link in the status bar of
  your terminal, and Herdr opens the page in their browser where they are. Say that it is open. Wait for
  their answer with \`lavish-axi poll <page.html>\`. A yes-or-no question stays in chat.
- **delivery**: where the shared delivery workflow is installed, it makes each worker's copy
  and decides between a reused pool slot and a new folder. A repository that uses it is
  delivered its way (see Code changes).
- **no-mistakes**: a project that has its gate is delivered through it. The worker runs the
  gate, which reviews, tests, pushes and opens the pull request; skip \`crew review\` for such
  a task, and \`crew land <id>\` then only records the pull request the gate opened. The gate
  stops at the open pull request; it does not watch the checks unless the project was added
  with \`--gate-skip none\`. A project whose lint or tests cannot run on this machine is added
  with \`--gate-skip ci,lint\` (ask the person before leaving a step out).

## When crew itself is wrong
A crew command that prints \`internal error\`, or that plainly does something other than what
these rules and \`crew --help\` say, is a defect in crew, not in the project. Do not work
around it by hand and never edit crew's own files yourself.
1. \`crew fix "<the command you ran, what happened, what you expected>"\` starts a fixer on
   crew's own source. Then \`crew wait <fix id>\`.
2. \`crew selfmerge <fix id>\` publishes the repair by itself, without asking the person, but
   only if it stays inside crew's folder and crew's whole test suite passes. It then updates
   this machine; other machines update when their next session starts.
3. \`crew finish <fix id>\`, retry the command that failed, and go on with the work.
4. Tell the person in one line what was wrong and that it is repaired.
- If \`crew selfmerge\` refuses, read why. Finish that fix and start one new \`crew fix\` that
  includes the refusal. After two refused repairs of the same problem, stop and tell the person.
- If crew got worse right after an update, run \`crew rollback\` and tell the person.
`;

function cmdInit(args) {
  const old = legacyHome();
  if (!args[0] && old) refuse(`There is already a crew home at ${slash(old)}. \`crew home --ensure\` moves it to ${slash(DEFAULT_HOME)}.`);
  createHome(args[0] ? path.resolve(args[0]) : DEFAULT_HOME);
}
function createHome(dir) {
  const file = path.join(dir, 'crew.json'), rules = path.join(dir, 'coordinator');
  if (fs.existsSync(file)) refuse(`${dir} is already a crew home.`);
  fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true });
  fs.mkdirSync(rules, { recursive: true });
  writeJson(file, { version: 1, tag: Math.random().toString(16).slice(2, 10), projects: {} });
  for (const [name, text] of [['AGENTS.md', COORDINATOR_RULES], ['CLAUDE.md', '@AGENTS.md\n']]) {
    if (!fs.existsSync(path.join(rules, name))) fs.writeFileSync(path.join(rules, name), text);
  }
  console.log(`crew home created: ${slash(dir)}`);
}

function cmdProject(args) {
  const h = home();
  const [verb, name, source] = args;
  if (verb === 'list' || !verb) {
    for (const [key, p] of Object.entries(h.config.projects)) console.log(`${key}\t${p.path}${p.workflow ? `\tworkflow ${p.workflow}` : ''}`);
    return;
  }
  // The project list decides which repository a task works in and is cleaned up against, so
  // while another session holds the home it is that session's to change. Before any session
  // has started (first setup) there is no owner and changes are allowed.
  const held = ownerState(h);
  if (held.owner && held.live && !held.mine) refuse(`Read-only: this home is owned by terminal ${held.owner.terminal}. Only that session may change its projects.`, 3);
  const replace = args.includes('--replace');
  if (verb === 'remove' && validId(name) && !source) {
    if (!h.config.projects[name]) refuse(`Unknown project: ${name}. See \`crew project list\`.`);
    // A task that is not closed still has, or may still have, a working copy of this project;
    // `crew finish` needs the project's path to remove it, so the project stays until then.
    const users = allTasks(h).filter(t => t.project === name && t.state !== 'closed');
    if (users.length) refuse(`Project ${name} is used by unfinished tasks: ${users.map(t => `${t.id}[${t.state}]`).join(' ')}. Finish them first.`);
    // A finished task whose copy still waits needs the project to hand it back.
    const waiting = allTasks(h).filter(t => t.project === name && t.state === 'closed' && t.copyToReturn);
    if (waiting.length) refuse(`Project ${name} still has working copies of finished tasks to return: ${waiting.map(t => t.id).join(' ')}. They go back once no terminal holds them (crew status --all).`);
    delete h.config.projects[name];
    writeJson(path.join(h.dir, 'crew.json'), h.config);
    console.log(`project ${name} removed (its folder is untouched)`);
    return;
  }
  if (verb !== 'add' || !validId(name) || !source || source.startsWith('--')) refuse('Usage: crew project add <name> <git folder> [--replace] [--gate-skip <steps>|none] [--workflow delivery|plain] | crew project remove <name> | crew project list');
  // Compatibility: pooled copies were a choice per project until 0.8. They are now the machine's one setting.
  if (args.includes('--treehouse')) console.error('crew: --treehouse is no longer a project choice and was ignored. Pooled copies are one setting of the machine: `delivery pool`.');
  // Which steps of the no-mistakes gate are left out for this project (see gateSkipOf).
  const skipAt = args.indexOf('--gate-skip'), skipText = skipAt < 0 ? null : String(args[skipAt + 1] ?? '');
  const gateSkip = skipText === null ? null : skipText === 'none' ? [] : skipText.split(',').map(s => s.trim()).filter(Boolean);
  if (gateSkip && (!skipText || gateSkip.some(s => !GATE_STEPS.includes(s)))) refuse(`--gate-skip takes ${GATE_STEPS.join(', ')} (comma-separated), or none. Push and pull request cannot be skipped: they are the delivery.`);
  // Whether the project follows the shared delivery workflow, when detection cannot tell (see
  // followsWorkflow). Like --gate-skip, it is part of the registration: re-adding without it drops it.
  const flowAt = args.indexOf('--workflow'), workflow = flowAt < 0 ? null : String(args[flowAt + 1] ?? '');
  if (workflow !== null && !WORKFLOWS.includes(workflow)) refuse(`--workflow takes ${WORKFLOWS.join(' or ')}.`);
  const folder = path.resolve(source);
  const top = run('git', ['-C', folder, 'rev-parse', '--show-toplevel']);
  if (top.code !== 0) refuse(`${folder} is not a git repository.`);
  // Pointing an existing name at another repository is a replacement, not an addition: it has
  // to be asked for, and it waits until no unfinished task still belongs to the old one.
  const existing = h.config.projects[name];
  if (existing && existing.path !== slash(folder)) {
    if (!replace) refuse(`Project ${name} already points at ${existing.path}. Pass --replace to point it at ${slash(folder)} instead.`);
    const users = allTasks(h).filter(t => t.project === name && t.state !== 'closed');
    if (users.length) refuse(`Project ${name} is used by unfinished tasks: ${users.map(t => `${t.id}[${t.state}]`).join(' ')}. Finish them first.`);
    const waiting = allTasks(h).filter(t => t.project === name && t.state === 'closed' && t.copyToReturn);
    if (waiting.length) refuse(`Project ${name} still has working copies of finished tasks to return: ${waiting.map(t => t.id).join(' ')}. They go back once no terminal holds them (crew status --all).`);
  }
  h.config.projects[name] = { path: slash(folder), ...(gateSkip ? { gateSkip } : {}), ...(workflow ? { workflow } : {}) };
  writeJson(path.join(h.dir, 'crew.json'), h.config);
  console.log(`project ${name}: ${slash(folder)}${gateSkip ? ` (gate skips: ${gateSkip.join(', ') || 'nothing'})` : ''}${workflow ? ` (workflow: ${workflow})` : ''}`);
}

// A project follows the shared delivery workflow (the `change-delivery` skill) when it was
// registered with `--workflow delivery`, or, without that choice, when its copy carries the
// shared instructions. `delivery instructions` is strict (an older template or one stray
// instruction file fails it), so the template's own header line in AGENTS.md also counts.
const WORKFLOWS = ['delivery', 'plain'];
const WORKFLOW_HEADER = '`templates/AGENTS.md` of';
function followsWorkflow(project, worktree) {
  if (project.workflow) return project.workflow === 'delivery';
  if (!toolPath('delivery')) return false;
  const said = runTool('delivery', ['instructions'], { cwd: worktree, timeout: 60000 });
  if (said?.code === 0 && /match the shared template/.test(said.stdout)) return true;
  try { return fs.readFileSync(path.join(worktree, 'AGENTS.md'), 'utf8').includes(WORKFLOW_HEADER); } catch { return false; }
}

// The gate's steps a project may leave out. Unless a project says otherwise, the gate's CI
// watch is left out: for crew a change is delivered when its pull request is open, the person
// reads the checks there and merges, and a gate that keeps watching (for days, by default)
// would hold the worker and its copy for nothing. A project whose lint or tests cannot run on
// this machine names those too: `crew project add <name> <folder> --gate-skip ci,lint`.
const GATE_STEPS = ['rebase', 'review', 'test', 'document', 'lint', 'ci'];
const gateSkipOf = project => (Array.isArray(project?.gateSkip) ? project.gateSkip.filter(s => GATE_STEPS.includes(s)) : ['ci']);

function cmdStart() {
  const h = home();
  const mine = me();
  if (!mine) refuse('crew start must run inside a Herdr terminal (no HC_TERMINAL_ID).', 3);
  // The installed tool brings itself up to date here, once per session, so a fix published
  // from any machine reaches this one without anybody installing it. The command then runs
  // again as the new version. A machine that went back after a bad update stays where it is
  // until something newer than that bad revision is published.
  if (installedCopy() && !process.env.CREW_NO_UPDATE) {
    const u = updateTool({ respectPin: true });
    if (u.pinned) console.log(`crew stays at ${short(toolRevision())} after a rollback from ${short(u.pinned)}; \`crew update\` returns to the latest.`);
    else if (u.failed) console.log(`crew did not check for updates: ${u.note}`);
    else if (u.changed) {
      console.log(`crew updated itself ${short(u.from)} -> ${short(u.revision)}`);
      const again = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'start'], { stdio: 'inherit', env: { ...process.env, CREW_NO_UPDATE: '1' } });
      process.exitCode = again.status ?? 1;
      return;
    }
  }
  const { owner, live, unknown } = ownerState(h);
  if (owner && unknown && owner.terminal !== mine) refuse(`${CORE_SILENT} the owner terminal ${owner.terminal}, so this home was not taken over. Try again.`, 4);
  if (owner && live && owner.terminal !== mine) refuse(`Read-only: this home is owned by live terminal ${owner.terminal}.`, 3);
  writeJson(h.owner, { terminal: mine, since: now(), previous: owner && owner.terminal !== mine ? owner.terminal : undefined });
  // The rules file belongs to the tool: a newer crew may have changed what a coordinator does.
  const rules = path.join(h.coordinator, 'AGENTS.md');
  if (fs.existsSync(rules) && fs.readFileSync(rules, 'utf8') !== COORDINATOR_RULES) {
    fs.writeFileSync(rules, COORDINATOR_RULES);
    console.log(`the coordinator rules changed with this crew version: read ${slash(rules)} again before going on`);
  }
  const open = allTasks(h).filter(t => t.state !== 'closed');
  console.log(`you hold ${slash(h.dir)} (terminal ${mine})`);
  console.log(open.length ? `unfinished tasks: ${open.map(t => `${t.id}[${t.state}]`).join(' ')}` : 'no unfinished tasks');
  returnWaitingCopies(h);
}

function cmdEnd() {
  const h = home();
  const { mine } = ownerState(h);
  if (!mine) refuse('This session does not hold the home.', 3);
  fs.rmSync(h.owner, { force: true });
  console.log('home released');
}

function bashProgram() {
  if (!WINDOWS) return 'bash';
  const candidates = [process.env.CREW_BASH, 'C:/Program Files/Git/bin/bash.exe', path.join(process.env.LOCALAPPDATA ?? '', 'Programs/Git/bin/bash.exe')].filter(Boolean);
  return candidates.find(p => fs.existsSync(p)) ?? refuse('Git Bash was not found; set CREW_BASH to bash.exe.', 4);
}

// The shell words that start an agent with one instruction. `pick` is what was chosen for this
// worker (see "who does the work" below): a model, an effort, and for Claude Code a saved
// account. A1 and Pi take a model as provider/id, which is how one of their logins is chosen
// (openai-codex/..., github-copilot/...). A Claude account starts the worker through the
// account-switcher launcher as that account, exactly as the person's own `claude` wrapper
// does plus `--as`. CREW_CLAUDE_ACCOUNT (set by the Herdr plugin, or by hand) is the account
// when none was chosen; only for that unchosen default does a machine without the launcher
// fall back to plain `claude`. A chosen account that cannot be used is refused instead.
const EFFORT_FLAG = { claude: '--effort', a1: '--thinking', pi: '--thinking' };
const ACCOUNT = /^[A-Za-z0-9._@+-]{1,100}$/;
const claudeLauncher = env => env.CREW_CLAUDE_LAUNCHER || path.join(os.homedir(), '.claude', 'plugins-local', 'account-switcher', 'bin', 'claude-as.sh');
export function agentCommand(name, agent, instruction, env = process.env, pick = {}) {
  const tune = [];
  if (pick.model) {
    const cut = name === 'claude' ? -1 : pick.model.indexOf('/');
    tune.push(...(cut > 0 ? ['--provider', pick.model.slice(0, cut), '--model', pick.model.slice(cut + 1)] : ['--model', pick.model]));
  }
  if (pick.effort) tune.push(EFFORT_FLAG[name], pick.effort);
  // Claude Code reads a prompt placed after --allowedTools as one more tool name, so its
  // options follow the instruction; A1 and Pi take theirs before it.
  const words = name === 'claude' ? [instruction, ...tune, ...(agent.args ?? [])] : [...tune, instruction, ...(agent.args ?? [])];
  const plain = [agent.command, ...words].map(shq).join(' ');
  const account = name === 'claude' ? String(pick.account ?? env.CREW_CLAUDE_ACCOUNT ?? '').trim() : '';
  if (!account) return plain;
  if (!ACCOUNT.test(account)) refuse(`Not an account name: ${account}`);
  const launcher = claudeLauncher(env);
  if (!fs.existsSync(launcher)) {
    if (pick.account) refuse(`Claude Code cannot be started as ${account}: the account launcher is not on this machine (${slash(launcher)}).`, 4);
    console.error(`crew: CREW_CLAUDE_ACCOUNT is set, but the account launcher is not on this machine (${slash(launcher)}); starting Claude Code on its default account.`);
    return plain;
  }
  return `bash --noprofile --norc ${shq(bashPath(launcher))} --as ${shq(account)} --command "$(type -P claude || type -P claude.exe)" -- ${words.map(shq).join(' ')}`;
}

// --- who does the work ----------------------------------------------------------------
// Firstmate's model, kept: a *profile* names the agent program, and optionally its model and
// effort ({ "harness": "a1", "model": "openai-codex/gpt-x", "effort": "high" }), and
// <home>/config/crew-dispatch.json lists them: `default` is an ordered array, `rules` pair a
// description of a kind of work (`when`) with the profiles to `use` for it, `shared_quota`
// turns quota reading off. Added for crew: `roles` (an array per scout, ship, review, fix),
// and `account` on a Claude profile, a login saved by the account-switcher plugin. A Claude
// profile without one stands for every saved account, each a candidate of its own.
// `floor` (Firstmate's too) is the share of quota, in percent, a profile keeps in reserve.
// `projects` gives one project a list of its own (an array, or { default, roles }), for a
// project where an agent of the general list cannot work; "crew:self" is crew's own source.
// The resulting ordered list is a fallback chain. Before a worker starts, candidates whose
// quota is used up or whose login is gone are passed over; when a running worker stops on a
// limit or a lost login, `crew wait` hands its task to the next one (see relaunch). Work
// stops only when nobody in the chain can take it, and then crew says why for each.
const WORD = /^[A-Za-z0-9][A-Za-z0-9._@+:/-]{0,119}$/;
const QUOTA_FAMILY = { 'openai-codex': 'codex', openai: 'codex', 'github-copilot': 'copilot', anthropic: 'claude', xai: 'grok', zai: 'zai' };
const ROLES = ['scout', 'ship', 'review', 'fix'];
const PICK_FLAGS = ['agent', 'model', 'effort', 'account', 'rule'];
export const pickLabel = c => [c.harness, c.model, c.effort && `(${c.effort})`, c.account && `as ${c.account}`].filter(Boolean).join(' ');
const pickKey = c => [c.harness, c.model ?? '', c.account ?? ''].join('|');

// Arguments of a command: `--name value` for the names in `valued`, bare `--name` for those in
// `bools`. Any other lone --word is refused instead of quietly becoming part of a task text.
function takeFlags(args, valued, bools = []) {
  const flags = {}, rest = [];
  for (let i = 0; i < args.length; i++) {
    const m = /^--([a-z][a-z0-9-]*)$/.exec(args[i]);
    if (!m) rest.push(args[i]);
    else if (bools.includes(m[1])) flags[m[1]] = true;
    else if (!valued.includes(m[1])) refuse(`Unknown option: ${args[i]}`);
    else if (args[i + 1] === undefined || /^--[a-z]/.test(args[i + 1])) refuse(`${args[i]} needs a value.`);
    else flags[m[1]] = args[++i];
  }
  return { flags, rest };
}

export function cleanProfile(raw, where = '') {
  const at = where ? `${where}: ` : '', p = typeof raw === 'string' ? { harness: raw } : raw;
  if (!p || typeof p !== 'object' || Array.isArray(p)) refuse(`${at}not a profile ({ "harness": "a1", "model": ..., "effort": ..., "account": ... }).`);
  const harness = p.harness ?? p.agent;
  if (!AGENTS[harness]) refuse(`${at}Unknown agent: ${harness}. Known: ${Object.keys(AGENTS).join(', ')}`);
  const out = { harness };
  for (const key of ['model', 'effort', 'account']) {
    if (p[key] === undefined || p[key] === null || p[key] === '') continue;
    if (!(key === 'account' ? ACCOUNT : WORD).test(String(p[key]))) refuse(`${at}Not a usable ${key}: ${p[key]}`);
    out[key] = String(p[key]);
  }
  if (out.account && harness !== 'claude') refuse(`${at}Only Claude Code has saved accounts. ${harness} chooses its login with the model, as in "github-copilot/<id>".`);
  // Firstmate's optional `floor`: the share of quota, in percent, below which this profile yields to the next.
  if (p.floor !== undefined && p.floor !== null) {
    const floor = Number(p.floor);
    if (!Number.isFinite(floor) || floor < 0 || floor > 100) refuse(`${at}Not a usable floor (0 to 100): ${p.floor}`);
    out.floor = floor;
  }
  // Firstmate's optional `provider` is the quota-axi family the profile spends from.
  const provider = p.provider ?? p.family; // `family` is the normalized form in saved candidates.
  if (typeof provider === 'string' && WORD.test(provider)) out.family = provider;
  return out;
}

const dispatchFile = h => path.join(h.dir, 'config', 'crew-dispatch.json');
function dispatchConfig(h) {
  const file = dispatchFile(h), none = { file, present: false, shared: false, default: [], roles: {}, rules: [], projects: {} };
  if (!fs.existsSync(file)) return none;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { refuse(`${slash(file)} is not valid JSON (${error.message}). Correct it, or remove it to use the built-in default.`); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) refuse(`${slash(file)} must hold one object.`);
  const list = (value, where) => (value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]).map((p, i) => cleanProfile(p, `${where}[${i}] in ${slash(file)}`));
  const roles = (value, where) => {
    const unknown = Object.keys(value ?? {}).find(r => !ROLES.includes(r));
    if (unknown) refuse(`${slash(file)}: ${where}.${unknown} is not a role. Roles: ${ROLES.join(', ')}`);
    return Object.fromEntries(Object.entries(value ?? {}).map(([role, v]) => [role, list(v, `${where}.${role}`)]));
  };
  // A project's own list: an array of profiles, or { default, roles } like the file itself.
  const projects = Object.fromEntries(Object.entries(raw.projects ?? {}).map(([name, value]) => [name, Array.isArray(value) || typeof value !== 'object' || value === null || value.harness || value.agent
    ? { default: list(value, `projects.${name}`), roles: {} } : { default: list(value.default, `projects.${name}.default`), roles: roles(value.roles, `projects.${name}.roles`) }]));
  return { file, present: true, shared: raw.shared_quota === true, default: list(raw.default, 'default'),
    roles: roles(raw.roles, 'roles'), projects,
    rules: (Array.isArray(raw.rules) ? raw.rules : []).map((r, i) => ({ when: String(r?.when ?? ''), why: String(r?.why ?? ''), use: list(r?.use, `rules[${i}].use`) })) };
}

// The Claude logins the account-switcher plugin has saved, asked from its own helper.
// CREW_CLAUDE_ACCOUNTS (comma-separated) names them instead, for a machine without it.
function claudeAccounts(env = process.env) {
  if (env.CREW_CLAUDE_ACCOUNTS !== undefined) return String(env.CREW_CLAUDE_ACCOUNTS).split(',').map(a => a.trim()).filter(a => ACCOUNT.test(a));
  const launcher = claudeLauncher(env), helper = path.join(path.dirname(launcher), 'session-dir.js');
  if (!fs.existsSync(launcher) || !fs.existsSync(helper)) return [];
  const listed = run(process.execPath, [helper, 'list'], { timeout: 20000 });
  if (listed.code !== 0) return [];
  return listed.stdout.split(/\r?\n/).map(l => /^\d+\.\s+(\S+)(.*)$/.exec(l.trim())).filter(m => m && !/no saved login/.test(m[2]) && ACCOUNT.test(m[1])).map(m => m[1]);
}

// The ordered candidates for one piece of work. What the command line names comes first and
// the configured chain follows it as its fallback; `--no-fallback` keeps only the first.
// `legacy` is the agent crew used before there was any configuration.
function workChain(h, role, flags, legacy, project = null, env = process.env) {
  const config = dispatchConfig(h), own = config.projects[project] ?? null;
  // The project's own list comes before the general one, a role's list before a default.
  const [configured, from] = own?.roles[role]?.length ? [own.roles[role], `projects.${project}.roles.${role}`] : own?.default.length ? [own.default, `projects.${project}`]
    : config.roles[role]?.length ? [config.roles[role], `roles.${role}`] : [config.default, config.default.length ? 'default' : 'built-in'];
  let base;
  if (flags.rule !== undefined) {
    const rule = config.rules[Number(flags.rule) - 1];
    if (!rule) refuse(`No rule ${flags.rule} in ${slash(config.file)}${config.rules.length ? ` (it has ${config.rules.length}; see \`crew agents\`)` : ' (it has none)'}.`);
    base = rule.use;
  } else base = configured;
  const named = ['agent', 'model', 'effort', 'account'].some(key => flags[key] !== undefined);
  // --agent starts a clean choice, so an account or model of another agent is never carried
  // over; --model, --effort or --account alone adjust the first configured profile.
  const start = flags.agent !== undefined ? {} : base[0] ?? { harness: legacy };
  const first = named ? cleanProfile({ ...start, ...Object.fromEntries(['model', 'effort', 'account'].filter(k => flags[k] !== undefined).map(k => [k, flags[k]])), ...(flags.agent !== undefined ? { harness: flags.agent } : {}) }) : null;
  let chain = first ? [first, ...base] : base.length ? base : [cleanProfile({ harness: legacy })];
  if (flags['no-fallback']) chain = chain.slice(0, 1);
  const saved = claudeAccounts(env), preferred = String(env.CREW_CLAUDE_ACCOUNT ?? '').trim();
  const accounts = saved.includes(preferred) ? [preferred, ...saved.filter(a => a !== preferred)] : saved;
  const candidates = [], seen = new Set();
  for (const profile of chain) {
    const each = profile.harness === 'claude' && !profile.account && accounts.length ? accounts.map(account => ({ ...profile, account })) : [profile];
    for (const c of each) { if (!seen.has(pickKey(c))) { seen.add(pickKey(c)); candidates.push(c); } }
  }
  return { candidates, config, source: flags.rule !== undefined ? `rule ${flags.rule}` : named ? 'named' : from };
}

// The provider an A1 or Pi profile without a model spends from: the agent's own saved default.
function nativeProvider(harness) {
  const settings = readJson(path.join(os.homedir(), harness === 'a1' ? '.a1' : '.pi', 'agent', 'settings.json'));
  return typeof settings?.defaultProvider === 'string' ? settings.defaultProvider : null;
}
const familyOf = c => c.family ?? (c.harness === 'claude' ? 'claude' : QUOTA_FAMILY[c.model?.includes('/') ? c.model.split('/')[0] : nativeProvider(c.harness)] ?? null);

// One provider row of a quota-axi --json reading, as it bears on a model. Firstmate's rule:
// a candidate is out only when a scope that bounds it is exhausted now or has nothing left;
// a reading that could not be taken is uncertainty, never proof of an empty account.
export function quotaVerdict(row, model) {
  if (!row || row.notSetUp) return { status: 'unknown', note: 'quota-axi has no reading for it' };
  const why = [row.state?.error, row.state?.reason].filter(Boolean).join(', ');
  if (row.quotaSemantics?.status !== 'known') {
    return /unauthori[sz]ed|logged.?out|not.?logged|sign(ed)?.?(in|out)|invalid.?(token|credential|grant)|credential.?(missing|expired)|no.?credential/i.test(why)
      ? { status: 'signed-out', note: `not signed in (${why})` } : { status: 'unknown', note: `quota could not be read${why ? ` (${why})` : ''}` };
  }
  const bare = String(model ?? '').split('/').pop();
  const scopes = (row.quotaSemantics.effectiveAvailability ?? []).filter(s => ['all_models', 'all_products', `model:${bare}`, `product:${bare}`].includes(s.scope));
  const left = scopes.map(s => s.effectivePercentRemaining).filter(Number.isFinite);
  const empty = scopes.find(s => s.runway?.status === 'exhausted_now' || (Number.isFinite(s.effectivePercentRemaining) && s.effectivePercentRemaining <= 0));
  if (empty) {
    const window = (row.windows ?? []).find(w => (empty.limitingWindowIds ?? []).includes(w.id) || w.kind === empty.boundedBy?.[0]);
    return { status: 'exhausted', remaining: 0, note: `quota used up${window?.resetsAt ? `, back ${window.resetsAt}` : ''}` };
  }
  return left.length ? { status: 'ok', remaining: Math.min(...left), note: `${Math.round(Math.min(...left))}% left` } : { status: 'unknown', note: 'no quota figure for it' };
}

// What quota-axi knows about each candidate, keyed like pickKey. quota-axi is used as it is:
// one ordinary reading covers every candidate that spends from the machine's own logins, and
// each saved Claude account gets a reading of its own. For that, the account-switcher's
// helper writes the account's current login into an empty folder (rotating the tokens first
// when they are about to expire, under the plugin's own lock), quota-axi reads exactly that
// folder with --profile-only, and the folder is removed again.
function quotaFacts(candidates, { shared = false, env = process.env } = {}) {
  const facts = new Map(), all = fact => { for (const c of candidates) facts.set(pickKey(c), fact); return facts; };
  if (shared) return all({ status: 'unknown', note: 'shared_quota: quota is not read' });
  if (env.CREW_NO_QUOTA === '1' || !toolPath('quota-axi')) return all({ status: 'unknown', note: 'quota-axi is not installed here' });
  const reading = (args, extra = {}) => {
    const r = runTool('quota-axi', [...args, '--json'], { timeout: 90000, env: { ...env, ...extra } });
    // quota-axi exits nonzero when a provider could not be measured and still prints its snapshot.
    try { return JSON.parse(r.stdout).providers ?? []; } catch { return null; }
  };
  const plain = candidates.filter(c => !c.account), families = [...new Set(plain.map(familyOf).filter(Boolean))];
  let rows = null;
  if (families.length) {
    // A1 keeps its logins in its own folder; quota-axi reads a Pi-style login from the folder
    // PI_CODING_AGENT_DIR names, so that is pointed at A1's when A1 is among the candidates.
    const a1Root = path.join(os.homedir(), '.a1', 'agent');
    rows = reading(['--provider', families.join(','), '--max-age', '2m'], plain.some(c => c.harness === 'a1') && !env.PI_CODING_AGENT_DIR && fs.existsSync(a1Root) ? { PI_CODING_AGENT_DIR: a1Root } : {});
  }
  const helper = path.join(path.dirname(claudeLauncher(env)), 'session-dir.js'), byAccount = new Map();
  for (const c of candidates) {
    if (!c.account) {
      const family = familyOf(c);
      facts.set(pickKey(c), !family ? { status: 'unknown', note: 'crew does not know which quota it spends' } : !rows ? { status: 'unknown', note: 'quota-axi gave no reading' } : quotaVerdict(rows.find(r => r.provider === family), c.model));
      continue;
    }
    if (!byAccount.has(c.account)) byAccount.set(c.account, (() => {
      if (!fs.existsSync(helper)) return { note: 'the account-switcher helper is not on this machine' };
      const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-quota-'));
      try {
        const seeded = run(process.execPath, [helper, 'refresh', c.account, '--into', folder], { timeout: 60000 });
        let said = null; try { said = JSON.parse(lastLine(seeded.stdout)); } catch { /* judged by the exit code */ }
        // The helper exits 2 when the saved login is no longer accepted, 3 when it could not ask.
        if (seeded.code === 2) return { out: `its saved login is no longer accepted${said?.error ? ` (${String(said.error).slice(0, 80)})` : ''}; log in as it once` };
        if (!fs.existsSync(path.join(folder, '.credentials.json'))) return { note: `its login could not be prepared (${lastLine(seeded.stderr || seeded.stdout).slice(0, 80)})` };
        const read = reading(['--provider', 'claude', '--profile-only'], { CLAUDE_CONFIG_DIR: folder });
        return read ? { row: read.find(r => r.provider === 'claude') } : { note: 'quota-axi gave no reading' };
      } finally { fs.rmSync(folder, { recursive: true, force: true }); }
    })());
    const got = byAccount.get(c.account);
    facts.set(pickKey(c), got.out ? { status: 'signed-out', note: got.out } : got.note ? { status: 'unknown', note: got.note } : quotaVerdict(got.row, c.model));
  }
  return facts;
}

// An agent whose program is not on this machine cannot take work. Looked up on the real PATH
// (CREW_AGENT_PATH replaces it in the tests); `true` when that cannot be told.
function agentInstalled(harness, env = process.env) {
  const command = AGENTS[harness].command, names = WINDOWS ? [command, `${command}.exe`, `${command}.cmd`, `${command}.bat`] : [command];
  const dirs = String(env.CREW_AGENT_PATH ?? env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return !dirs.length || dirs.some(dir => names.some(name => fs.existsSync(path.join(dir, name))));
}

// Reads quota and selects candidates that can work now. Only floors rearrange the order;
// each group otherwise keeps the person's preference. Known exclusions apply to this
// selection, never to the saved original chain. One known to be under its own `floor` is kept but goes behind the
// others, in order: it is saved for when nobody else can work, so a floor never stops work.
// Ordinary initial selection skips reads for one candidate; agents and relaunch check it.
function usableCandidates(candidates, { shared = false, always = false, env = process.env } = {}) {
  const check = candidates.length > 1 || always, facts = check ? quotaFacts(candidates, { shared, env }) : new Map();
  if (check) for (const c of candidates) if (!agentInstalled(c.harness, env)) facts.set(pickKey(c), { status: 'missing', note: `${AGENTS[c.harness].command} is not installed on this machine` });
  const rows = candidates.map(c => ({ ...c, fact: facts.get(pickKey(c)) ?? { status: 'unknown', note: 'not checked: the only candidate' } }));
  for (const r of rows) if (r.fact.status === 'ok' && r.floor !== undefined && r.fact.remaining < r.floor) r.fact = { ...r.fact, status: 'low', note: `${r.fact.note}, under its floor of ${r.floor}%` };
  const strip = ({ fact, ...c }) => c;
  return { rows, usable: [...rows.filter(r => ['ok', 'unknown'].includes(r.fact.status)), ...rows.filter(r => r.fact.status === 'low')].map(strip) };
}
const candidateLines = rows => rows.map(r => `  ${pickLabel(r)} - ${r.fact.note}`).join('\n');
const candidateChecks = rows => ({ checkedAt: now(), facts: Object.fromEntries(rows.map(r => [pickKey(r), r.fact])) });

// Who takes a new piece of work, and who stands behind them.
function chooseWorker(h, role, flags, legacy, project = null) {
  const { candidates, config, source } = workChain(h, role, flags, legacy, project);
  const { rows, usable } = usableCandidates(candidates, { shared: config.shared });
  if (!usable.length) refuse(`Nobody can take this work now:\n${candidateLines(rows)}\nAdd another profile to ${slash(config.file)}, or name one: --agent <agent> [--model <id>] [--account <account>].`, 8);
  const taken = rows.find(r => pickKey(r) === pickKey(usable[0]));
  for (const r of rows) { if (r === taken) break; console.log(`passed over ${pickLabel(r)}: ${r.fact.note}`); }
  if (taken.fact.status === 'low') console.log(`${pickLabel(taken)} is under its floor (${taken.fact.note}), but nobody above their floor can take the work`);
  return { pick: usable[0], rest: candidates.filter(c => pickKey(c) !== pickKey(usable[0])), candidates, checks: candidateChecks(rows), available: usable.length - 1, source };
}

function cmdAgents(args) {
  const h = home();
  const { flags } = takeFlags(args, ['role', 'project', ...PICK_FLAGS], ['json', 'no-fallback']);
  if (flags.role !== undefined && !ROLES.includes(flags.role)) refuse(`Unknown role: ${flags.role}. Roles: ${ROLES.join(', ')}`);
  const role = flags.role ?? 'scout', { candidates, config, source } = workChain(h, role, flags, 'a1', flags.project ?? null);
  const { rows, usable } = usableCandidates(candidates, { shared: config.shared, always: true });
  const first = usable[0] ? pickKey(usable[0]) : null;
  if (flags.json) {
    console.log(JSON.stringify({ config: config.present ? slash(config.file) : null, role, source, sharedQuota: config.shared,
      candidates: rows.map(({ fact, family, ...c }) => ({ ...c, label: pickLabel(c), status: fact.status, remaining: fact.remaining ?? null, note: fact.note, next: pickKey(c) === first })),
      rules: config.rules.map((r, i) => ({ rule: i + 1, when: r.when, why: r.why, use: r.use.map(pickLabel) })) }));
    return;
  }
  console.log(config.present ? `profiles from ${slash(config.file)} (${source}), for ${role} work${flags.project ? ` in ${flags.project}` : ''}:` : `no ${slash(config.file)}: the built-in default, for ${role} work:`);
  for (const r of rows) console.log(`${pickKey(r) === first ? '->' : '  '} ${pickLabel(r).padEnd(52)} ${r.fact.status.padEnd(11)}${r.fact.note}`);
  if (!first) console.log('Nobody can take work now.');
  config.rules.forEach((r, i) => console.log(`rule ${i + 1}: ${r.when}\n        use ${r.use.map(pickLabel).join(', then ')}  (--rule ${i + 1})`));
}

// --- the tools Firstmate works with -----------------------------------------------
// crew runs without any of them. Each one that is installed is used for what it is good at:
// by crew itself (`crew` column) or by the agents, who are told about it in their brief or
// rules. `brief` is the line a worker gets when the tool is on this machine.
export const TOOLS = [
  { id: 'gh', crew: '`crew land` opens the pull request with it' },
  { id: 'gh-axi', crew: 'agents read and write GitHub with it', brief: 'For GitHub (issues, pull requests, checks) use `gh-axi`; run `gh-axi --help` first.' },
  { id: 'chrome-devtools-axi', crew: 'agents look at web pages with it', brief: 'To look at a web page or check something in a browser use `chrome-devtools-axi`; run `chrome-devtools-axi --help` first.' },
  { id: 'lavish-axi', crew: '`crew show` opens a decision or a long report as a page, with a link in the Herdr status bar' },
  { id: 'tasks-axi', crew: '`crew backlog` keeps the queue with it; spawn, land and finish move the item' },
  { id: 'quota-axi', crew: 'crew reads each candidate\'s quota with it (every saved Claude account separately) before a worker starts or takes over' },
  { id: 'delivery', crew: "makes and removes workers' copies (`delivery start`, `delivery finish`); it alone decides between a pool slot and a new folder" },
  { id: 'treehouse', crew: 'the pool the shared delivery workflow takes reused copies from; crew does not call it for new tasks' },
  { id: 'no-mistakes', crew: 'a project with its gate is delivered through it' },
  { id: 'jq', crew: 'for `crew status --json` in scripts', brief: '`jq` is installed for reading JSON.' },
];
// Where a tool is: CREW_TOOL_<NAME> (a .mjs path is run with node, as in the tests), else
// the first hit on PATH (CREW_TOOL_PATH replaces PATH for this lookup). No process is started.
export function toolPath(id, env = process.env) {
  const named = env[`CREW_TOOL_${id.toUpperCase().replace(/-/g, '_')}`];
  if (named) return fs.existsSync(named) ? named : null;
  const names = WINDOWS ? [`${id}.exe`, `${id}.cmd`, `${id}.bat`] : [id];
  for (const dir of String(env.CREW_TOOL_PATH ?? env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const name of names) { const file = path.join(dir, name); if (fs.existsSync(file)) return file; }
  }
  return null;
}
// Runs an installed tool; null when it is not installed. An npm tool on Windows is a .cmd
// shim, which mangles arguments; its sh twin beside it is run through Git Bash instead.
function runTool(id, args, options = {}) {
  const file = toolPath(id);
  if (!file) return null;
  if (file.endsWith('.mjs')) return run(process.execPath, [file, ...args], options);
  if (WINDOWS && /\.(cmd|bat)$/i.test(file)) {
    const twin = file.replace(/\.(cmd|bat)$/i, '');
    return fs.existsSync(twin) ? run(bashProgram(), [bashPath(twin), ...args], options) : run(`"${file}"`, args, { ...options, shell: true });
  }
  return run(file, args, options);
}
const installedTools = () => TOOLS.filter(t => toolPath(t.id)).map(t => t.id);

function cmdTools(args) {
  const rows = TOOLS.map(t => {
    const file = toolPath(t.id);
    const said = file ? runTool(t.id, ['--version'], { timeout: 20000 }) : null;
    const version = said ? (/\d+\.\d+(\.\d+)?/.exec(`${said.stdout} ${said.stderr}`)?.[0] ?? 'installed') : null;
    return { id: t.id, installed: Boolean(file), version, path: file ? slash(file) : null, use: t.crew };
  });
  if (args.includes('--json')) { console.log(JSON.stringify({ tools: rows })); return; }
  for (const r of rows) console.log(`${r.id.padEnd(20)}${(r.version ?? 'not installed').padEnd(15)}${r.use}`);
  if (rows.some(r => !r.installed)) console.log('Missing tools are optional. Install them in Herdr: Settings > Plugins > Crew.');
}

// show: a page for the person. lavish-axi serves it on this machine only (127.0.0.1), and the
// person may be sitting at another one, with this machine reached over SSH. So the page's
// address is also put on this terminal as a label Herdr understands: its status bar then
// shows a "Lavish" link for this terminal that opens the page on the person's own machine
// (through an SSH forward when this one is remote), at any time, not only when it was made.
const PAGE_URL = /https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/[^\s"'<>)\]]*)?/;
function cmdShow(args) {
  const file = args.find(a => !a.startsWith('--')), mine = me();
  if (!file) refuse('Usage: crew show <page.html> [--reopen]');
  if (!fs.existsSync(file)) refuse(`No such page: ${file}`);
  if (!toolPath('lavish-axi')) refuse('Showing a page needs lavish-axi, which is not installed here (Herdr: Settings > Plugins > Crew, or `npm install -g lavish-axi`).', 4);
  // In a Herdr terminal the page is not opened in a browser on this machine (the person may
  // not be here); the request label below makes Herdr open it where the person is.
  const opened = runTool('lavish-axi', [path.resolve(file), ...(args.includes('--reopen') ? ['--reopen'] : []), ...(mine ? ['--no-open'] : [])], { timeout: 120000 });
  const said = `${opened.stdout}\n${opened.stderr}`, url = PAGE_URL.exec(said)?.[0];
  if (opened.code !== 0 || !url) refuse(`lavish-axi did not open the page: ${lastLine(said)}`, 4);
  console.log(`shown: ${url}`);
  if (!mine) { console.log('This is not a Herdr terminal, so no link was added to a status bar.'); return; }
  // custom.preview.open is a request with its time: Herdr opens the page once for it, in the
  // browser of the machine its window is on.
  const labelled = [`custom.preview.url=${url}`, 'custom.preview.label=Lavish', `custom.preview.open=${Date.now()}`].map(label => hc(['label', mine, label]));
  console.log(labelled.every(r => r.code === 0)
    ? 'Herdr opens it in the person\'s browser on their own machine, and keeps a Lavish link in the status bar of this terminal for later. Tell them it is there.'
    : `Core did not label this terminal (${lastLine(labelled.find(r => r.code !== 0).stderr)}); give the person the address instead.`);
}

// The backlog is one Markdown file in the home, kept by tasks-axi. A crew task with the
// same id as a backlog item moves that item: In flight at spawn, Done at land or finish.
const backlogFile = h => path.join(h.dir, 'backlog.md');
const BACKLOG_READS = ['list', 'show', 'ready', 'render'];
function cmdBacklog(args) {
  const h = home();
  if (!toolPath('tasks-axi')) refuse('The backlog needs tasks-axi, which is not installed here (Herdr: Settings > Plugins > Crew, or `npm install -g tasks-axi`).', 4);
  const words = args.length ? args : ['list'];
  // tasks-axi wants its flags after a command, so a bare help flag is its own help, as it is.
  const help = words[0].startsWith('-');
  if (!help && !BACKLOG_READS.includes(words[0])) requireOwner(h);
  const r = runTool('tasks-axi', help ? ['--help'] : [...words, '--file', backlogFile(h)], { timeout: 60000 });
  process.stdout.write(r.stdout); process.stderr.write(r.stderr);
  process.exitCode = r.code ?? 1;
}
// Best effort: a task without a backlog item, or a machine without tasks-axi, is fine.
function backlogMove(h, id, verb, more = []) {
  try {
    const file = backlogFile(h);
    if (!fs.existsSync(file) || !new RegExp(`^- \\[.\\] ${id} `, 'm').test(fs.readFileSync(file, 'utf8'))) return;
    const r = runTool('tasks-axi', [verb, id, ...more, '--file', file], { timeout: 60000 });
    if (r?.code === 0) console.log(`backlog: ${r.stdout.trim().split(/\r?\n/)[0].replace(/^ok: /, '')}`);
    else if (r) console.error(`crew: the backlog item ${id} was not moved (${lastLine(r.stderr || r.stdout)})`);
  } catch { /* the backlog never stops the work */ }
}

export function briefText({ id, kind, task, worktree, project, report, tools = [], gate = null, gateSkip = [], workflow = false, branch = null }) {
  const skip = gateSkip.length ? ` --skip ${gateSkip.join(',')}` : '', watched = !gateSkip.includes('ci');
  const hints = TOOLS.filter(t => t.brief && tools.includes(t.id)).map(t => `- ${t.brief}`);
  return [
    `# Task ${id} (${kind})`, '', task.trim(), '',
    '## Rules',
    `- Work only inside \`${worktree}\`. It is your own copy of the project \`${project}\`; nobody else uses it.`,
    ...(kind === 'scout'
      ? ['- This is a read-only investigation: do not change project files, commit, push or open a pull request.']
      : gate
        ? ['- Make your changes on the branch already checked out here and commit them.']
        : workflow
          // The repository delivers by its own pull-request workflow; the coordinator approves the plan.
          ? [`- This repository uses the shared delivery workflow. Run \`delivery update\`, then load the \`change-delivery\` skill and follow it. Your copy and its branch \`${branch}\` already exist: \`delivery start ${branch}\` returns this same folder.`,
            `- A change the skill says needs a plan: open the plan as a draft pull request in the skill's body format, then STOP: write \`Plan: <pull request link>\` as the first line of your report, the plan in a few lines below it, and run \`crew done ${id}\`. Implement only after you are told the plan is approved.`,
            '- A small fix the skill allows without a plan: implement it in a draft pull request with the body in the skill\'s format, ticking each outcome as it lands.',
            '- Once implemented, the first line of your report is `Implementation: <pull request link>`. Every report starts with one of these two lines.',
            '- Never mark the pull request ready and never merge it.']
          : ['- Make your changes on the branch already checked out here and commit them. Do not push or open a pull request unless the task says so.']),
    ...(kind === 'ship' && gate ? [
      `- This project is delivered through the no-mistakes gate, which reviews, tests, pushes and opens the pull request itself. After committing, run \`no-mistakes axi run --yes --intent-file ${gate}${skip}\` here and do what it prints (\`no-mistakes axi --help\`) until it reports an outcome. A wait that runs out is not a failure: run the same command again to go on. Do not push or open a pull request any other way.`,
      watched
        ? '- The gate also watches the pull request\'s checks. Once they have passed, end its watch with `no-mistakes axi handoff`; if no check has appeared ten minutes after the pull request opened, say so in the report and stop waiting.'
        : '- The gate ends when the pull request is open. Its checks are not watched here: the person reads them on the pull request.',
      '- Put the pull request link the gate gives you in the first lines of your report. If the gate stops on something only a person can decide, say exactly what in the report.',
    ] : []),
    `- When you are finished, write your result to \`${report}\` in Markdown, with the answer in the first lines.`,
    `- Then run \`crew done ${id}\` and stop. Do not start any other work.`,
    '- If you cannot finish, write what blocked you to the same file and still run the command.', '',
    ...(hints.length ? ['## Tools on this machine', ...hints, ''] : []),
  ].join('\n');
}

// A ship task works on a branch named the way the shared delivery workflow names them:
// <type>/<task id>. Tasks from before 0.7 are on crew/<id>.
const BRANCH_TYPES = ['feature', 'fix', 'refactor', 'docs', 'test', 'chore', 'style'];
const branchOf = task => task.branch ?? `crew/${task.id}`;

function cmdSpawn(args) {
  const h = home();
  requireOwner(h);
  const { flags, rest } = takeFlags(args, ['project', 'kind', 'type', ...PICK_FLAGS], ['no-fallback']);
  const opts = { kind: flags.kind ?? 'scout', project: flags.project, ...(flags.type !== undefined ? { type: flags.type } : {}) };
  const [id, ...words] = rest;
  const task = words.join(' ').trim();
  if (!validId(id) || !task) refuse(`Usage: crew spawn <id> --project <name> [--kind scout|ship] [--type feature|fix|...] ${PICK_USAGE} "<task>"`);
  if (!['scout', 'ship'].includes(opts.kind)) refuse(`Unknown kind: ${opts.kind}`);
  if (opts.type !== undefined && (opts.kind !== 'ship' || !BRANCH_TYPES.includes(opts.type))) refuse(opts.kind !== 'ship' ? 'Only a ship task has a branch, so only it takes --type.' : `Unknown type: ${opts.type}. Known: ${BRANCH_TYPES.join(', ')}`);
  // Checked before anything is created: an unknown agent or a bad profile makes no task.
  if (flags.agent !== undefined && !AGENTS[flags.agent]) refuse(`Unknown agent: ${flags.agent}. Known: ${Object.keys(AGENTS).join(', ')}`);
  const project = h.config.projects[opts.project] ?? refuse(`Unknown project: ${opts.project}. See \`crew project list\`.`);
  if (fs.existsSync(taskDir(h, id))) refuse(`Task ${id} already exists.`);
  launchWorker(h, { id, opts, chosen: chooseWorker(h, opts.kind, flags, 'a1', opts.project), project, task });
}
const PICK_USAGE = `[--agent ${Object.keys(AGENTS).join('|')}] [--model <id>] [--effort <level>] [--account <claude account>] [--rule <n>] [--no-fallback]`;

// Starts the terminal in which `pick` works on a task. The agent starts with one instruction
// as its argument, so nothing is typed into it and there is no race with its startup. The
// shell stays afterwards so the terminal survives the agent leaving; `crew finish` removes it.
function startTerminal(h, { id, worktree, label, pick, instruction }) {
  const agent = AGENTS[pick.harness];
  if (agent.trust === 'claude' && !trustClaudeFolder(worktree)) console.error('crew: could not record the working copy as trusted for Claude Code; it may stop at its trust question.');
  const line = [
    `export CREW_HOME=${shq(bashPath(h.dir))} CREW_TASK=${shq(id)} PATH=${shq(`${bashPath(path.join(HERE, 'bin'))}`)}:"$PATH"`,
    agentCommand(pick.harness, agent, instruction, process.env, pick),
    'exec bash --login -i',
  ].join('; ');
  const tag = h.config.tag;
  return hcJson(['run', '--json', '--bg', '--keep', '--no-parent', '--no-notify', '--cwd', worktree,
    // crew.kind is what the worker is, for anything that shows terminals (Herdr's pane header).
    '--label', `crew.task=${id}`, '--label', `crew.home=${tag}`, '--label', `crew.kind=${label}`,
    '--label', `herdr.space=fm-crew-${tag}`, '--label', `herdr.tab=${tag}-${id}`, '--label', 'herdr.right-click=menu',
    '--', bashProgram(), '--login', '-i', '-c', line]);
}
const kindLabel = task => (task.selfFix ? 'fix' : task.reviews ? 'review' : task.kind);
const roleOf = kindLabel;

// Creates the task, its working copy and its terminal. `extra` is kept on the task record.
// `chosen` is who does it (`pick`), who stands behind them (`rest`) and where that came from.
function launchWorker(h, { id, opts, chosen, project, task, extra = {} }) {
  const { pick } = chosen;
  opts = { ...opts, agent: pick.harness };
  const dir = taskDir(h, id), report = slash(path.join(dir, 'report.md')), brief = slash(path.join(dir, 'brief.md'));
  let worktree = slash(path.join(h.worktrees, id));
  const branch = opts.kind === 'ship' ? `${extra.selfFix ? 'fix' : opts.type ?? 'feature'}/${id}` : null;
  // Where the shared delivery workflow is installed, it makes the copy: crew asks for a task's
  // copy and does not know whether that is a reused pool slot or a new folder. Without it,
  // crew makes a plain git worktree itself.
  const delivered = Boolean(toolPath('delivery'));
  // A project with the no-mistakes gate (its `no-mistakes` remote) is delivered through it.
  const gated = opts.kind === 'ship' && !extra.selfFix && toolPath('no-mistakes') && run('git', ['-C', project.path, 'remote', 'get-url', 'no-mistakes']).code === 0;
  const intent = gated ? slash(path.join(dir, 'intent.md')) : null;
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(h.worktrees, { recursive: true });
  let record = { id, kind: opts.kind, agent: opts.agent, project: opts.project, state: 'preparing', created: now(), worktree, report, brief, terminal: null,
    // Keep the original order, even for candidates that cannot work now: hand-over rereads
    // them. `chain` is the untried remainder; `candidates` also retains the attempted choices.
    launch: { ...pick, source: chosen.source }, candidates: chosen.candidates, chain: chosen.rest, candidateChecks: chosen.checks,
    ...(branch ? { branch } : {}), ...(delivered ? { via: 'delivery' } : {}), ...(gated ? { gate: 'no-mistakes' } : {}), ...extra };
  saveTask(h, record);

  const failed = why => { saveTask(h, { ...record, state: 'failed', error: why.slice(0, 400) }); refuse(`Could not create the working copy: ${why}`, 5); };
  if (delivered) {
    const got = runTool('delivery', ['start', ...(branch ? [branch] : ['--detach', id]), '--json'], { cwd: project.path, timeout: 600000 });
    let started = null;
    try { started = JSON.parse(lastLine(got.stdout)); } catch { /* reported below */ }
    if (got.code !== 0 || typeof started?.path !== 'string') failed(`delivery gave no working copy (${lastLine(got.stderr || got.stdout)})`);
    // Invariant: a task gets a copy made for it. One that was already there belongs to other work and is left alone.
    if (started.created !== true) failed(`${branch ?? id} already has a working copy at ${slash(started.path)}; it was left alone`);
    worktree = slash(started.path);
    record = { ...record, worktree, ...(started.pooled ? { pooled: true } : {}) };
    saveTask(h, record);
  } else {
    const wt = branch
      ? run('git', ['-C', project.path, 'worktree', 'add', '-b', branch, worktree, 'HEAD'])
      : run('git', ['-C', project.path, 'worktree', 'add', '--detach', worktree, 'HEAD']);
    if (wt.code !== 0) failed(wt.stderr.trim());
  }
  if (intent) fs.writeFileSync(intent, `${task.trim()}\n`);
  // Decided once, in the copy the worker gets, and kept on the task so land and status agree
  // with what the worker was told. The gate, where there is one, delivers instead.
  const workflow = opts.kind === 'ship' && !extra.selfFix && !gated && followsWorkflow(project, worktree);
  if (workflow) { record = { ...record, workflow: 'delivery' }; saveTask(h, record); }
  fs.writeFileSync(brief, briefText({ id, kind: opts.kind, task, worktree, project: opts.project, report, tools: installedTools(), gate: intent, gateSkip: gateSkipOf(project), workflow, branch }));

  const started = startTerminal(h, { id, worktree, label: kindLabel(record), pick, instruction: `Read the brief at ${brief} and carry it out exactly.` });
  const address = started.value?.address;
  if (started.code !== 0 || !address) {
    if (delivered) runTool('delivery', ['finish', worktree, '--force'], { cwd: project.path, timeout: 120000 });
    else run('git', ['-C', project.path, 'worktree', 'remove', '--force', worktree]);
    saveTask(h, { ...record, state: 'failed', error: JSON.stringify(started.value).slice(0, 400) });
    refuse(`Core did not start the worker terminal: ${JSON.stringify(started.value)}`, 5);
  }
  // The worker is already running and may have reported before this line (a fast failure
  // report, or a slow answer from Core). Add the terminal to what is on disk now rather than
  // writing the record this command started with over an accepted report.
  const current = readJson(taskFile(h, id)) ?? record;
  saveTask(h, { ...current, state: current.state === 'reported' ? 'reported' : 'working', terminal: address, spawned: now() });
  const detail = pickLabel(pick) !== pick.harness || chosen.available ? `; ${pickLabel(pick)}${chosen.available ? `, ${chosen.available} more can take over` : ''}` : '';
  console.log(`spawned ${id}: ${opts.agent} ${opts.kind} in terminal ${address}, working copy ${worktree}${record.pooled ? ' (pool slot)' : ''}${gated ? '; delivered through no-mistakes' : ''}${workflow ? '; follows the repository\'s delivery workflow (plan first as a draft pull request)' : ''}${detail}`);
  backlogMove(h, id, 'start');
}

// relaunch: the same task, the same working copy, another agent. This is the fallback while
// work is under way: a worker that stopped on a used-up quota or a lost login is replaced by
// the next candidate of its chain, which is told to go on from what is already there.
// Returns the new pick, or null with `why` when nobody else can take the task.
function relaunch(h, task, reason, flags = null) {
  const before = task.launch ?? { harness: task.agent }, tried = new Set([...(task.tried ?? []), pickKey(before)]);
  const role = roleOf(task), named = flags && [...PICK_FLAGS, 'no-fallback'].some(key => flags[key] !== undefined);
  const config = dispatchConfig(h);
  // The task's own chain as it stood at launch; a task from before there were chains, or an
  // explicit choice on the command line, takes the configured one as it stands now.
  const original = named || !task.chain ? workChain(h, role, flags ?? {}, task.agent, task.project).candidates : task.candidates ?? task.chain;
  const candidates = original.filter(c => named ? pickKey(c) !== pickKey(before) : !tried.has(pickKey(c)));
  const { rows, usable } = usableCandidates(candidates, { shared: config.shared, always: true }), checks = candidateChecks(rows);
  if (!usable.length) {
    saveTask(h, { ...task, candidateChecks: checks });
    return { pick: null, why: rows.length ? `nobody else can take it:\n${candidateLines(rows)}` : 'there is no other candidate in its chain' };
  }
  const [pick, ...rest] = usable;
  const chain = original.filter(c => pickKey(c) !== pickKey(pick) && !tried.has(pickKey(c)));
  if (task.terminal) {
    let seen = probe(task.terminal).state;
    if (seen === 'unknown') refuse(`${CORE_SILENT} terminal ${task.terminal}; task ${task.id} was left as it is. Try again.`, 4);
    if (seen !== 'absent') { hc(['kill', task.terminal]); hc(['rm', task.terminal]); seen = probe(task.terminal).state; }
    if (seen !== 'absent') refuse(`Core still has terminal ${task.terminal}; task ${task.id} was not handed over.`, 6);
  }
  const instruction = `Read the brief at ${task.brief} and carry it out exactly. Another worker (${pickLabel(before)}) began this task and had to stop: ${reason}. What it did is already in this working copy: look at \`git status\` and \`git log\`, and at ${task.report} if it exists, then continue from there instead of starting again.`;
  const started = startTerminal(h, { id: task.id, worktree: task.worktree, label: kindLabel(task), pick, instruction });
  const address = started.value?.address;
  if (started.code !== 0 || !address) {
    saveTask(h, { ...task, state: 'failed', terminal: null, error: `Core did not start the next worker: ${JSON.stringify(started.value).slice(0, 300)}` });
    refuse(`Core did not start the next worker for ${task.id}: ${JSON.stringify(started.value)}. Its working copy is kept: ${task.worktree}`, 5);
  }
  const { error, ...kept } = task;
  saveTask(h, { ...kept, agent: pick.harness, launch: { ...pick, source: 'fallback' }, candidates: original, chain, candidateChecks: checks, tried: [...tried], state: 'working', terminal: address, relaunched: now(),
    fallbacks: [...(task.fallbacks ?? []), { at: now(), from: pickLabel(before), to: pickLabel(pick), why: reason }] });
  return { pick, rest, address };
}

// What on a stopped worker's screen says it cannot go on for want of quota or a login. Only
// the last lines count, and only while the agent is not working: text the worker itself wrote
// about limits earlier is not a stop.
const STOPPED_ON = /usage limit|rate limit(?:ed)?\b.{0,40}(?:reached|exceeded|hit)|(?:quota|credits?|tokens?)\b.{0,30}(?:exceeded|exhausted|used up|ran out|run out)|out of (?:credits|quota|usage)|credit balance is too low|hit your\b.{0,20}limit|limit (?:has been )?reached|insufficient[_ ]quota|not logged in|please (?:run )?\/login|invalid (?:api key|x-api-key|authentication)|authentication[_ ](?:failed|error)|oauth token (?:has )?expired|401 unauthorized/i;
function stoppedOn(address, lines) {
  const read = hc(['read', address, '--lines', String(lines)]);
  if (read.code !== 0) return null;
  const hit = read.stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(-lines).reverse().find(l => STOPPED_ON.test(l));
  return hit ? hit.replace(/\s+/g, ' ').slice(0, 140) : null;
}

// A worker whose agent is gone: its terminal is live (the shell stays) but Core sees no agent in
// it and no report was written. That is an agent that crashed at start or left mid-task. Core
// also shows no agent in the first moments of a start, so this only counts some time after the
// worker was started (CREW_DEAD_SECONDS, default 45) and when seen twice in a row.
const DEAD_AFTER = () => (process.env.CREW_DEAD_SECONDS !== undefined ? Number(process.env.CREW_DEAD_SECONDS) : 45) * 1000;
const startedLongAgo = task => Date.now() - Date.parse(task.relaunched ?? task.spawned ?? task.created) > DEAD_AFTER();
// What the agent last said, for the person and for whoever takes over.
function lastWords(address) {
  const read = hc(['read', address, '--lines', '30']);
  if (read.code !== 0) return '';
  const lines = read.stdout.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('[hc]'));
  return (lines.reverse().find(l => /error|stopp|crash|fatal|exception|unexpected|denied|not found/i.test(l)) ?? '').replace(/\s+/g, ' ').slice(0, 160);
}

// One unit controls recovery delays: 30s, 2m, 5m for error retries, 2m for idle,
// and 30s of observed work to end a stop. Shorter checks make the same path testable.
function recoveryTimings() {
  const seconds = process.env.CREW_RECOVERY_SECONDS === undefined ? 30 : Number(process.env.CREW_RECOVERY_SECONDS);
  if (!Number.isFinite(seconds) || seconds < 0) refuse('CREW_RECOVERY_SECONDS must be a non-negative number of seconds.');
  const unit = seconds * 1000;
  return { error: [unit, 4 * unit, 10 * unit], idle: 4 * unit, working: unit, check: Math.max(10, Math.min(5000, unit)) };
}

// Recovery is separate from a coordinator follow-up: no task state, report stage or tells
// counter is changed. Attempts survive a new wait; observations must be consecutive here.
function recoverWorker(h, task, state, observed, timing) {
  let current = loadTask(h, task.id);
  if (current.state !== 'working' || current.terminal !== task.terminal) return {};
  const error = state === 'error', idle = state === 'idle';
  if (idle && fs.existsSync(current.report)) return {};
  const previous = current.recovery?.terminal === task.terminal ? current.recovery : null;
  if (!previous && !error && !idle) return {};
  let recovery = previous ? { ...previous } : { terminal: task.terminal, errors: 0 };
  if (recovery.state !== state) { recovery.state = state; recovery.since = now(); }
  const persist = () => {
    const latest = loadTask(h, task.id);
    if (latest.state === 'working' && latest.terminal === task.terminal && JSON.stringify(latest.recovery) !== JSON.stringify(recovery)) saveTask(h, { ...latest, recovery });
  };
  if (state === 'working' && Date.now() - observed.since >= timing.working) {
    recovery = { terminal: task.terminal, errors: 0, state, since: recovery.since };
  }
  if (!error && !idle) { persist(); return {}; }
  const since = idle ? Math.max(Date.parse(recovery.since), Date.parse(recovery.idleNudged ?? recovery.since))
    : Date.parse(recovery.lastErrorNudge ?? recovery.since);
  const delay = error ? timing.error[recovery.errors] ?? timing.check : timing.idle;
  if ((error && observed.checks < 2) || Date.now() - since < delay) { persist(); return {}; }
  const from = pickLabel(task.launch ?? { harness: task.agent });
  const line = error ? lastWords(task.terminal) || 'Core reports an error' : null;
  // Reading the screen can take time; a report accepted meanwhile is never reopened.
  current = loadTask(h, task.id);
  if (current.state !== 'working' || current.terminal !== task.terminal || (idle && fs.existsSync(current.report))) return {};
  if (error && recovery.errors >= 3) { persist(); return { handover: line, tried: `${from} stopped on an error (${line}); told to continue 3 times without recovery` }; }
  if (idle && recovery.idleNudged) { persist(); return { blocked: `${from} is idle without a report after its reminder to continue or report and run crew done` }; }
  const message = error ? 'Continue from where you stopped; the provider or network error may have passed.'
    : `Continue your task. If you are finished, write your complete result to ${task.report}, run \`crew done ${task.id}\`, and stop.`;
  const sent = hc(['send', task.terminal, message]);
  if (sent.code !== 0) { persist(); return { blocked: `Core did not deliver the recovery message to ${from}: ${lastLine(sent.stderr || sent.stdout)}` }; }
  const at = now(), attempt = error ? recovery.errors + 1 : 1;
  if (error) { recovery.errors = attempt; recovery.lastErrorNudge = at; }
  else recovery.idleNudged = at;
  const latest = loadTask(h, task.id);
  // A fast worker may have reported during send: append history to its newest record.
  saveTask(h, { ...latest, ...(latest.terminal === task.terminal ? { recovery } : {}),
    nudges: [...(latest.nudges ?? []), { at, kind: error ? 'error' : 'idle', why: line ?? 'idle without a report', terminal: task.terminal, attempt }] });
  observed.checks = 0; // observe the effect before another message or hand-over
  console.log(error ? `== ${task.id}: ${from} stopped on an error (${line}); told to continue (${attempt} of 3)`
    : `== ${task.id}: ${from} is idle without a report; told to continue or report and run crew done (1 of 1)`);
  return {};
}

function cmdRelaunch(args) {
  const h = home();
  requireOwner(h);
  const { flags, rest } = takeFlags(args, PICK_FLAGS, ['no-fallback']);
  const [id, ...words] = rest;
  if (!id) refuse(`Usage: crew relaunch <id> ${PICK_USAGE} ["<why>"]`);
  const task = loadTask(h, id);
  if (!['working', 'stopped', 'failed'].includes(task.state)) refuse(`Task ${id} is ${task.state}; only unfinished work is handed to another agent.`);
  if (!fs.existsSync(task.worktree)) refuse(`Task ${id} has no working copy any more (${task.worktree}); spawn a new task instead.`, 6);
  const moved = relaunch(h, task, words.join(' ').trim() || 'the coordinator handed the task over', flags);
  if (!moved.pick) refuse(`Task ${id} was not handed over: ${moved.why}`, 8);
  console.log(`relaunched ${id}: ${pickLabel(moved.pick)} in terminal ${moved.address}${moved.rest.length ? `, ${moved.rest.length} more can take over` : ''}; next: crew wait ${id}`);
}

function cmdDone(args) {
  const h = home();
  const id = args[0] ?? process.env.CREW_TASK;
  if (!id) refuse('Usage: crew done [<id>]');
  const task = loadTask(h, id);
  const mine = me();
  if (task.terminal && mine && task.terminal !== mine) refuse(`Task ${id} belongs to terminal ${task.terminal}, not this one.`, 3);
  if (!fs.existsSync(task.report) || !fs.readFileSync(task.report, 'utf8').trim()) refuse(`Write your result to ${task.report} first.`);
  if (task.state === 'closed') refuse(`Task ${id} is already closed.`);
  saveTask(h, { ...task, state: 'reported', reported: now(), ...(task.workflow ? reportedStage(task.report) : {}) });
  console.log(`reported ${id}. You are finished; stop here.`);
}

// A worker in a repository with the shared delivery workflow starts every report with
// `Plan: <link>` or `Implementation: <link>`. That line is what status and land go by, so
// nobody has to ask GitHub which stage a task is in.
const PR_LINK = /https:\/\/[^\s)>\]]+\/pulls?\/\d+/;
function reportedStage(report) {
  const first = fs.readFileSync(report, 'utf8').trim().split(/\r?\n/)[0] ?? '';
  const m = /^\W*(plan|implementation)\W*:/i.exec(first), link = PR_LINK.exec(first)?.[0];
  return m ? { stage: m[1].toLowerCase(), ...(link ? { pr: link } : {}) } : { stage: null };
}

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function cmdWait(args) {
  const h = home();
  const { flags, rest: ids } = takeFlags(args, ['timeout'], ['no-fallback']);
  const timeout = Number(flags.timeout) || 1800;
  if (!ids.length) refuse('Usage: crew wait <id> [<id>...] [--timeout seconds] [--no-fallback]');
  // Handing a stopped worker's task to the next candidate changes the home, so only its owner does it.
  const handover = !flags['no-fallback'] && process.env.CREW_NO_FALLBACK !== '1' && ownerState(h).mine;
  const quiet = new Map(); // how many checks in a row found no agent in a worker's terminal
  const observations = new Map(), timing = recoveryTimings();
  let nextCheck = Date.now() + Math.min(4000, timing.check);
  ids.forEach(id => loadTask(h, id));
  const deadline = Date.now() + timeout * 1000, settled = new Map(), blocked = new Map();
  while (settled.size < ids.length && Date.now() < deadline) {
    const check = Date.now() >= nextCheck;
    if (check) nextCheck = Date.now() + timing.check;
    for (const id of ids) {
      if (settled.has(id)) continue;
      const task = loadTask(h, id);
      if (['reported', 'stopped', 'closed', 'failed'].includes(task.state)) { settled.set(id, task.state); continue; }
      // Every few seconds ask Core whether the terminal still exists; a worker that is gone
      // without a report has failed, whatever the reason.
      if (!check || !task.terminal) continue;
      const { state: seen, t } = probe(task.terminal);
      const state = seen === 'live' ? (t.status?.state === 'done' ? 'idle' : t.status?.state) : seen;
      const previous = observations.get(id);
      const observed = previous?.terminal === task.terminal && previous.state === state
        ? { ...previous, checks: previous.checks + 1 } : { terminal: task.terminal, state, since: Date.now(), checks: 1 };
      observations.set(id, observed);
      if (seen === 'unknown') {
        quiet.delete(id);
        if (handover) recoverWorker(h, task, 'unknown', observed, timing);
        continue; // Core did not answer: that says nothing about the worker
      }
      if (t?.status?.state) quiet.delete(id);
      if (seen !== 'live') {
        saveTask(h, { ...task, state: 'failed', error: 'The worker terminal ended without a report.' });
        settled.set(id, 'failed');
      } else if (handover && AGENTS[task.agent]?.seen && !t.status?.state && startedLongAgo(task) && quiet.set(id, (quiet.get(id) ?? 0) + 1).get(id) >= 2) {
        // The agent is gone and left no report: the next candidate takes the task over.
        quiet.delete(id);
        const said = lastWords(task.terminal), reason = `its agent ended without a report${said ? ` (${said})` : ''}`, from = pickLabel(task.launch ?? { harness: task.agent });
        const moved = relaunch(h, loadTask(h, id), reason);
        if (moved.pick) console.log(`== ${id}: ${from} is gone: ${reason}; ${pickLabel(moved.pick)} continues it in terminal ${moved.address}`);
        else { blocked.set(id, `${from} is gone: ${reason}, and ${moved.why}`); settled.set(id, 'needs a person'); }
      } else if (handover && t.status?.state && !['working', 'blocked'].includes(t.status.state) && stoppedOn(task.terminal, t.status.state === 'error' ? 40 : 12)) {
        // The worker cannot go on for want of quota or a login: the next candidate of its
        // chain takes the task over in the same working copy, and the wait goes on.
        const reason = stoppedOn(task.terminal, t.status.state === 'error' ? 40 : 12), from = pickLabel(task.launch ?? { harness: task.agent });
        const moved = relaunch(h, loadTask(h, id), reason);
        if (moved.pick) console.log(`== ${id}: ${from} stopped (${reason}); ${pickLabel(moved.pick)} continues it in terminal ${moved.address}`);
        else { blocked.set(id, `${from} stopped (${reason}) and ${moved.why}`); settled.set(id, 'needs a person'); }
      } else if (t.status?.state === 'blocked') {
        // The agent itself says it is waiting for a person (a permission or a question).
        // Waiting longer cannot help; hand that back so somebody looks at the terminal.
        blocked.set(id, String(t.status.msg ?? t.status.kind ?? 'it is waiting for an answer').slice(0, 120));
        settled.set(id, 'needs a person');
        if (handover) recoverWorker(h, task, 'blocked', observed, timing);
      } else if (handover) {
        const recovery = recoverWorker(h, task, state, observed, timing);
        if (recovery.handover) {
          const latest = loadTask(h, id);
          if (latest.state !== 'working' || latest.terminal !== task.terminal) continue;
          const moved = relaunch(h, latest, recovery.handover);
          if (moved.pick) console.log(`== ${id}: ${recovery.tried}; ${pickLabel(moved.pick)} continues it in terminal ${moved.address}`);
          else { blocked.set(id, `${recovery.tried}, and ${moved.why}`); settled.set(id, 'needs a person'); }
        } else if (recovery.blocked) { blocked.set(id, recovery.blocked); settled.set(id, 'needs a person'); }
      }
    }
    if (settled.size < ids.length) sleep(Math.min(1000, timing.check));
  }
  let pending = 0, stuck = 0;
  for (const id of ids) {
    const task = loadTask(h, id), state = settled.get(id);
    if (!state) { pending++; console.log(`== ${id}: still working after ${timeout}s (terminal ${task.terminal})`); continue; }
    if (blocked.has(id)) { stuck++; console.log(`== ${id}: needs a person - ${blocked.get(id)} (terminal ${task.terminal}); it is still running`); continue; }
    console.log(`== ${id}: ${state}${task.error ? ` - ${task.error}` : ''}`);
    if (fs.existsSync(task.report)) console.log(fs.readFileSync(task.report, 'utf8').trim().split(/\r?\n/).slice(0, 60).join('\n'));
  }
  if (pending) process.exitCode = 124; else if (stuck) process.exitCode = 7;
}

// A1's public integration API: exact session and runtime, admitted only when idle.
function a1Api(type, target) {
  const request = JSON.stringify({ version: 1, id: `crew-${process.pid}-${Date.now()}`, type, target: { scope: 'session', ...target } });
  // Through bash: a1 is an npm shim on Windows, and one single-quoted argument survives intact.
  const r = run(bashProgram(), ['-c', `a1 api ${shq(request)}`], { timeout: 20000, env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  try { return JSON.parse(r.stdout); } catch { return null; }
}
// Makes the worker's agent leave and proves it, or says why not. { stopped, how }.
// `stopped: true` is returned only for something that was observed: Core says the terminal
// is finished or gone, or A1 itself says the session no longer exists. A Core that does not
// answer is never read as "gone".
function stopWorker(task, { force = false, onStop = null } = {}) {
  let { state, t } = probe(task.terminal);
  if (state === 'unknown') refuse(`${CORE_SILENT} terminal ${task.terminal}; nothing was stopped or removed. Try again.`, 4);
  if (state !== 'live') return { stopped: true, how: 'terminal already gone' };
  // A worker reports from inside its last turn; give that turn a moment to end before
  // deciding it is still busy.
  for (let i = 0; task.state === 'reported' && !force && state === 'live' && t.status?.state === 'working' && i < (Number(process.env.CREW_SETTLE_SECONDS) || 45); i++) {
    sleep(1000);
    ({ state, t } = probe(task.terminal));
  }
  if (state === 'unknown') refuse(`${CORE_SILENT} terminal ${task.terminal}; nothing was stopped or removed. Try again.`, 4);
  if (state !== 'live') return { stopped: true, how: 'terminal already gone' };
  const working = t.status?.state === 'working';
  if (working && !force) refuse(`Task ${task.id} is still working. Wait for it, or pass --force to cancel it.`, 6);
  if (AGENTS[task.agent]?.exit === 'a1-api' && t.status?.app === 'a1' && t.labels?.['a1.session'] && t.labels?.['a1.runtime']) {
    const target = { sessionId: t.labels['a1.session'], runtimeId: t.labels['a1.runtime'] };
    const reply = a1Api('session.exit', target);
    if (reply?.success) {
      onStop?.();
      for (let i = 0; i < 15; i++) {
        if (a1Api('session.lifecycle', target)?.error?.code === 'session-unavailable') return { stopped: true, how: 'a1 exit api' };
        sleep(1000);
      }
      return { stopped: false, how: 'a1 admitted the exit but is still there' };
    }
    // No reply cannot prove the exit request was rejected; only an explicit rejection can
    // still be a refusal with the worker intact. Finish must retain an unconfirmed attempt.
    if (onStop && !reply && !force) { onStop(); return { stopped: false, how: 'A1 did not confirm the exit request' }; }
    if (!force) refuse(`A1 refused to exit (${reply?.error?.code ?? 'no answer'}). Nothing was closed.`, 6);
  }
  // Every other agent (and a forced stop of an A1 that would not leave) is stopped by ending
  // the terminal's program, then asking Core again: only a terminal seen finished or gone
  // counts.
  onStop?.();
  hc(['kill', task.terminal]);
  for (let i = 0; i < 10; i++) {
    const after = probe(task.terminal).state;
    if (after === 'finished' || after === 'absent') return { stopped: true, how: working ? 'cancelled; terminal ended' : 'terminal ended' };
    sleep(500);
  }
  return { stopped: false, how: 'Core still shows the terminal as live after it was told to end it' };
}

function cmdStop(args) {
  const h = home();
  requireOwner(h);
  const force = args.includes('--force'), id = args.find(a => !a.startsWith('--'));
  if (!id) refuse('Usage: crew stop <id> [--force]');
  const task = loadTask(h, id);
  const result = stopWorker(task, { force });
  if (result.stopped && task.state !== 'closed') saveTask(h, { ...loadTask(h, id), state: task.state === 'reported' ? 'reported' : 'stopped', stopped: now() });
  console.log(`${result.stopped ? 'stopped' : 'not stopped'} ${id}: ${result.how}`);
  if (!result.stopped) process.exitCode = 6;
}

// A ship task's branch outlives its working copy on purpose: it holds the commits.
// Once they are merged it holds nothing, so it goes with the copy. Merged means: reachable
// from the project's current or default branch, or GitHub has a merged pull request whose
// head is exactly this commit (a squash merge leaves no ancestry). Anything unsure keeps it.
function dropMergedBranch(project, task) {
  if (task.kind !== 'ship' || !project?.path) return '';
  const branch = branchOf(task), git = (...a) => run('git', ['-C', project.path, ...a], { timeout: 60000 });
  const tip = git('rev-parse', '--verify', '-q', `refs/heads/${branch}`).stdout.trim();
  if (!tip) return '';
  let merged = ['HEAD', 'refs/remotes/origin/HEAD'].some(ref => git('merge-base', '--is-ancestor', tip, ref).code === 0);
  if (!merged && git('remote', 'get-url', 'origin').code === 0) {
    const asked = gh(['pr', 'list', '--head', branch, '--state', 'merged', '--limit', '1', '--json', 'headRefOid', '--jq', '.[0].headRefOid'], { cwd: project.path, timeout: 60000 });
    merged = asked.code === 0 && asked.stdout.trim() === tip;
  }
  return merged && git('branch', '-D', branch).code === 0 ? `; merged branch ${branch} deleted` : '';
}

// Other terminals whose folder is inside a working copy. Removing a copy ends what runs in it:
// the delivery workflow returns a pool slot through treehouse, which terminates every process
// whose working folder is in the slot, and a shell opened there keeps that folder for the
// system even after `cd`. A person's own session started from such a shell would die with the
// worker. `null` when Core could not be asked.
function otherTerminalsIn(folder, own) {
  const { code, value } = hcJson(['ls', '--json']);
  if (code !== 0 || !Array.isArray(value?.terminals)) return null;
  const norm = p => slash(path.resolve(String(p))).replace(/\/+$/, '').toLowerCase(), root = norm(folder);
  // A terminal of another machine (`machine/t1`) names a folder there, not here.
  return value.terminals.filter(t => t.state === 'live' && t.address !== own && !String(t.address).includes('/') && t.cwd && (norm(t.cwd) === root || norm(t.cwd).startsWith(`${root}/`)));
}
// The terminals holding a copy, named so the person recognises them. Holding is decided by
// Core's `cwd` alone, because that is the folder treehouse acts on. Herdr's shell integration
// reports where the shell is now in the label `custom.cwd`; `hc ls` does not carry labels, so
// each holder is asked once. A tab that moved on is said to have, since it looks unrelated.
function describeHolders(holders, folder) {
  const norm = p => slash(path.resolve(String(p))).replace(/\/+$/, '').toLowerCase(), root = norm(folder);
  return holders.map(t => {
    const name = `${t.address}${t.agent ? ` ${String(t.agent).split(/[\\/]/).pop()}` : ''}`;
    const now = probe(t.address).t?.labels?.['custom.cwd'];
    const moved = now && norm(now) !== root && !norm(now).startsWith(`${root}/`);
    return moved ? `${name} (opened in the copy, now in ${slash(now)})` : name;
  }).join(', ');
}

// Hands a closed worker's copy back the way it was made: through the delivery workflow, the
// legacy treehouse pool, or git. Never refuses: { ok, said, leftover } or { ok: false, why },
// so finish can refuse with `why` and the later sweep can report it and go on.
function returnCopy(task, project, { force = false } = {}) {
  if (task.via === 'delivery') {
    // The shared delivery workflow made the copy, so it takes it back: a pool slot is returned,
    // a plain folder removed. Crew has already refused unsaved ship work and a keep marker,
    // so what is left in the copy is scratch and `--force` is crew's word to discard it.
    // A first try can fail while the closed terminal's processes let go of the folder.
    let back = { code: 0, stdout: '', stderr: '' };
    for (let i = 0; fs.existsSync(path.join(task.worktree, '.git')) && i < 6; i++) {
      back = runTool('delivery', ['finish', task.worktree, '--force'], { cwd: project?.path, timeout: 180000 });
      if (!back) return { ok: false, why: `Task ${task.id}'s working copy was made by the shared delivery workflow, which is not installed here now; nothing was removed: ${task.worktree}` };
      if (back.code === 0) break;
      sleep(1000);
    }
    if (back.code !== 0) return { ok: false, why: `delivery did not take the working copy back (${lastLine(back.stdout || back.stderr)}); it was kept: ${task.worktree}` };
    return { ok: true, said: `; working copy ${task.pooled ? 'returned to the pool' : 'removed'}`, leftover: '', released: true };
  }
  // Compatibility: a task from before 0.8 whose project took its copies from treehouse directly.
  if (task.pool === 'treehouse') {
    // The copy is a pool slot: it goes back to treehouse, which cleans it and keeps it.
    // treehouse refuses a slot with loose files unless told to clean it. A scout's leftovers
    // are scratch, and --force is the person's word to discard; a ship task's unsaved work
    // without --force was refused by finish.
    const back = runTool('treehouse', ['return', ...(force || task.kind === 'scout' ? ['--force'] : []), task.worktree], { cwd: project?.path, timeout: 180000 });
    if (!back) return { ok: false, why: `Task ${task.id} uses a treehouse working copy, and treehouse is not installed here; nothing was returned.` };
    if (back.code !== 0 && fs.existsSync(task.worktree)) return { ok: false, why: `treehouse did not take the working copy back (${lastLine(back.stderr || back.stdout)}); it was kept: ${task.worktree}` };
    return { ok: true, said: '; working copy returned to treehouse', leftover: '', released: true };
  }
  // Git removes the copy. A first try can fail while the closed terminal's processes let go
  // of the folder, so it is retried. The folder is deleted directly only when git no longer
  // knows it as a working copy (an earlier, half-finished removal) or with --force.
  let removal = { code: 0, stderr: '' };
  for (let i = 0; fs.existsSync(task.worktree) && i < 8; i++) {
    if (project) removal = run('git', ['-C', project.path, 'worktree', 'remove', '--force', task.worktree]);
    if (!fs.existsSync(task.worktree)) break;
    const detached = !project || /is not a working tree/i.test(removal.stderr);
    if (detached || force) { try { fs.rmSync(task.worktree, { recursive: true, force: true }); } catch { /* still held: retry */ } }
    if (fs.existsSync(task.worktree)) sleep(1000);
  }
  if (project) run('git', ['-C', project.path, 'worktree', 'prune']);
  // An emptied folder that something still sits in (a helper process the agent left behind)
  // is not worth failing for: the work is gone from disk and from git; say so and move on.
  if (fs.existsSync(task.worktree)) {
    if (fs.readdirSync(task.worktree).length) return { ok: false, why: `The terminal is closed, but the working copy is still in use and could not be removed: ${task.worktree}` };
    return { ok: true, said: '', leftover: `; its empty folder is still held by another process (${task.worktree})`, released: false };
  }
  return { ok: true, said: '', leftover: '', released: true };
}
const projectOf = (h, task) => (task.projectPath ? { path: task.projectPath } : h.config.projects[task.project]);

// Work in a copy that its removal would lose: a ship task's uncommitted or untracked files
// (its branch keeps only commits) and the shared delivery workflow's keep marker. A scout is
// read-only by its brief; what it leaves behind is scratch. Derive protection from the exact
// snapshot that will become the accepted baseline, never an earlier clean inspection.
// { dirty: files or null when git could not tell, keep }.
function workInCopy(task, snapshot) {
  const dirty = task.kind === 'ship' ? snapshot ? Object.keys(snapshot.files) : null : [];
  return { dirty, keep: snapshot ? snapshot.keep !== null : fs.existsSync(path.join(task.worktree, '.artifacts', 'KEEP')) };
}
// `git status` of a folder as [{ code, file }], or null when git could not tell. Read with -z:
// the text form quotes names with non-ASCII or special characters, and such a quoted name is
// not a path that can be looked at. A rename or copy names its source in one more field.
function gitStatus(folder, ...more) {
  const r = run('git', ['-C', folder, 'status', '--porcelain', '-z', ...more]);
  if (r.code !== 0) return null;
  const fields = r.stdout.split('\0'), entries = [];
  for (let i = 0; i < fields.length; i++) {
    if (!fields[i]) continue;
    const code = fields[i].slice(0, 2);
    entries.push({ code, file: fields[i].slice(3) });
    if (/[RC]/.test(code)) i++;
  }
  return entries;
}
const listFiles = files => `${files.slice(0, 5).join(', ')}${files.length > 5 ? ', …' : ''}`;
// Metadata only: one fingerprint per ignored root, even for a large dependency tree. The
// digest includes names and individual metadata: count/max/size alone can hide a rename,
// a same-size edit below the newest timestamp, or two changes whose sizes cancel out.
// Never follow symlinks or read contents. A slow/unreadable walk is uncertainty, not clean.
export function snapshotCopy(folder, { budgetMs = 30000 } = {}) {
  const deadline = performance.now() + budgetMs;
  const stamp = p => { try { return fs.lstatSync(path.join(folder, p)).mtimeMs; } catch { return null; } };
  // An existing copy without its Git marker is uninspectable, not empty. A copy already
  // gone is handled separately by finish/return and has no contents left to compare.
  const git = (...a) => (fs.existsSync(path.join(folder, '.git')) ? gitStatus(folder, ...a) : fs.existsSync(folder) ? null : []);
  const changed = git('--untracked-files=all'), roots = git('--ignored');
  if (!changed || !roots) return null;
  // Filenames are arbitrary keys, including __proto__, constructor and toString.
  const files = Object.create(null), ignored = Object.create(null);
  let incomplete = null;
  const checkTime = () => { if (performance.now() >= deadline) throw new Error('ignored walk exceeded its time budget'); };
  try {
    for (const { code, file } of changed) {
      files[file] = stamp(file);
      if (files[file] === null && !code.includes('D')) throw new Error(`could not read ${file}`);
    }
    for (const { file } of roots.filter(e => e.code === '!!')) {
      const hash = createHash('sha256'), summary = { files: 0, newestMtimeMs: 0, totalSize: 0 };
      const walk = name => {
        checkTime();
        let stat;
        try { stat = fs.lstatSync(path.join(folder, name)); } catch { throw new Error(`could not read ${name}`); }
        hash.update(JSON.stringify([name, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs]));
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
          let names;
          try { names = fs.readdirSync(path.join(folder, name)).sort(); } catch { throw new Error(`could not read ${name}`); }
          for (const child of names) walk(`${name.replace(/\/$/, '')}/${child}`);
        } else {
          summary.files++;
          summary.newestMtimeMs = Math.max(summary.newestMtimeMs, stat.mtimeMs);
          summary.totalSize += stat.size;
        }
        checkTime();
      };
      // Strip git's trailing slash before lstat: otherwise a directory symlink can be followed.
      walk(file.replace(/\/$/, ''));
      ignored[file] = { ...summary, metadata: hash.digest('hex') };
    }
    checkTime();
  } catch (error) { incomplete = error.message; }
  return { files, ignoredVersion: 1, ignored, incomplete, keep: stamp(path.join('.artifacts', 'KEEP')), ...historyOf(folder) };
}
// Where the copy's history stood: its HEAD and branch, how many entries its own HEAD reflog
// has (a linked copy's reflog is its own and goes with it), and which git operations are
// under way in it. Commits made in the copy after finish show up as new reflog entries.
// `locked` is `git worktree lock`: somebody's explicit word to keep the copy.
const OPERATIONS = { 'rebase-merge': 'a rebase in progress', 'rebase-apply': 'a rebase or patch series in progress', MERGE_HEAD: 'a merge in progress', CHERRY_PICK_HEAD: 'a cherry-pick in progress',
  REVERT_HEAD: 'a revert in progress', BISECT_LOG: 'a bisect in progress', locked: 'a lock (git worktree lock)' };
function historyOf(folder) {
  if (!fs.existsSync(path.join(folder, '.git'))) return { head: null, branch: null, reflog: 0, operations: [] };
  const git = (...a) => run('git', ['-C', folder, ...a]);
  const reflog = git('reflog', 'show', '--format=%H', 'HEAD'), dir = git('rev-parse', '--absolute-git-dir').stdout.trim();
  return { head: git('rev-parse', '-q', '--verify', 'HEAD').stdout.trim() || null, branch: git('symbolic-ref', '--short', '-q', 'HEAD').stdout.trim() || null,
    reflog: reflog.code === 0 ? reflog.stdout.split(/\r?\n/).filter(Boolean).length : 0,
    operations: dir ? Object.keys(OPERATIONS).filter(name => fs.existsSync(path.join(dir, name))) : [] };
}
// Commits the copy's HEAD reached since finish that no branch or tag holds: they would be
// lost with the copy (a scout's copy is detached, and its reflog goes with it).
function commitsOnlyInCopy(folder, before) {
  const git = (...a) => run('git', ['-C', folder, ...a]);
  const log = git('reflog', 'show', '--format=%H', 'HEAD'), entries = log.code === 0 ? log.stdout.split(/\r?\n/).filter(Boolean) : [];
  const now = git('rev-parse', '-q', '--verify', 'HEAD').stdout.trim();
  const reached = new Set(entries.slice(0, Math.max(0, entries.length - (before.reflog ?? 0))));
  if (now && now !== before.head) reached.add(now);
  return [...reached].filter(sha => !git('for-each-ref', '--count=1', '--contains', sha, '--format=%(refname)', 'refs/heads', 'refs/tags').stdout.trim());
}
// Whether a postponed copy can go back unasked. The copy was held by a terminal somebody
// works in, so anything written or marked after finish is theirs and keeps it: a file that
// is new or changed since finish's snapshot, or a keep marker that was not there then. Only
// `crew finish <id> --force` on the closed task discards that. { kept, leftovers }: `kept`
// says why it waits (or null), `leftovers` that finish's accepted files are still there.
function checkWaitingCopy(task, before = task.copyToReturn?.left, { discardUnseen = false } = {}) {
  const seen = snapshotCopy(task.worktree);
  const uncertain = !seen ? 'it could not be checked for work written since finish' : !before ? 'the original snapshot could not be read' : before.ignoredVersion !== 1 ? 'its older snapshot did not inspect ignored files' : before.incomplete ?? seen.incomplete;
  // Only this invocation's explicit force authorizes discarding unseen contents. A failed
  // comparison is not proof of new work; without that authority it still protects the copy.
  if (uncertain) return { kept: discardUnseen ? null : { why: 'uncommitted work', text: !seen ? uncertain : `changes cannot be determined: ${uncertain}` }, leftovers: true, unseen: discardUnseen ? uncertain : null };
  if (seen.keep !== null && seen.keep !== before.keep) return { kept: { why: 'marked to keep', text: 'it was marked to keep by .artifacts/KEEP since finish' }, leftovers: true };
  // JSON-parsed older snapshots have ordinary-object dictionaries. Copy their own keys
  // into prototype-free records before comparing, without changing the saved format.
  const beforeFiles = Object.assign(Object.create(null), before.files), beforeIgnored = Object.assign(Object.create(null), before.ignored);
  const ignored = new Set([...Object.keys(beforeIgnored), ...Object.keys(seen.ignored)]);
  const added = [...Object.keys(seen.files).filter(file => !Object.hasOwn(beforeFiles, file) || beforeFiles[file] !== seen.files[file]),
    ...[...ignored].filter(file => JSON.stringify(beforeIgnored[file]) !== JSON.stringify(seen.ignored[file]))];
  if (added.length) return { kept: { why: 'uncommitted work', text: `it has work written since finish (${listFiles(added)})` }, leftovers: true };
  const started = seen.operations.filter(name => !(before.operations ?? []).includes(name));
  if (started.length) return { kept: { why: 'operation in progress', text: `it has ${started.map(name => OPERATIONS[name]).join(' and ')} since finish` }, leftovers: true };
  const commits = commitsOnlyInCopy(task.worktree, before);
  if (commits.length) return { kept: { why: 'commits', text: `it has commits made since finish that no branch holds (${listFiles(commits.map(sha => sha.slice(0, 8)))})` }, leftovers: true };
  return { kept: null, leftovers: Object.keys(seen.files).length > 0 || Object.keys(seen.ignored).length > 0 || seen.keep !== null };
}

// Copies whose return finish postponed because another terminal held them. They go back
// here, at `crew start` and at every `crew finish`, once nothing holds them any more: crew is
// one short process per command and has no watcher to do it in between. Nothing in here
// fails the command that triggered it; a copy that cannot go back now waits for next time.
// `skip` is the task a finish has just closed: its own line already said its copy waits.
function returnWaitingCopies(h, { skip = null } = {}) {
  let held = 0;
  const waiting = allTasks(h).filter(t => t.state === 'closed' && t.copyToReturn && t.id !== skip);
  for (const [i, task] of waiting.entries()) {
    try {
      const back = returnWaiting(h, task);
      // Core is silent: nobody is seen, so nothing is removed, and the copies are still named.
      if (back.state === 'silent') { const left = waiting.length - i + held; console.log(`${CORE_SILENT} the terminals in the working copies of finished tasks; ${left} ${left === 1 ? 'copy waits' : 'copies wait'} to be returned and ${left === 1 ? 'was' : 'were'} kept (${waiting.slice(i).map(t => t.id).join(', ')}${held ? ' and the ones still held' : ''})`); return; }
      if (back.state === 'held') held++;
      else console.log(back.line);
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      console.log(`the working copy of ${task.id} was not returned yet: ${error.message}`);
    }
  }
  if (held) console.log(`${held} working ${held === 1 ? 'copy' : 'copies'} of finished tasks still held by another terminal; crew returns ${held === 1 ? 'it' : 'them'} once nothing holds ${held === 1 ? 'it' : 'them'}`);
}
// Called only after a proved worker stop (or its persisted retry). A1's API exit can leave
// the wrapper shell live: end that shell too. Unknown answers still postpone removal.
function removeStoppedTerminal(task) {
  try {
    let seen = probe(task.terminal).state;
    if (seen === 'live') { hc(['kill', task.terminal]); seen = probe(task.terminal).state; }
    if (seen === 'finished') { hc(['rm', task.terminal]); seen = probe(task.terminal).state; }
    return seen === 'absent' ? null : { state: seen === 'unknown' ? 'silent' : 'held',
      text: `Core ${seen === 'unknown' ? 'did not confirm removal of' : 'still has'} worker terminal ${task.terminal}` };
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    return { state: 'silent', text: error.message };
  }
}
// One postponed copy, handed back the way finish would have: never while a terminal holds it,
// and not over work written or marked in it since finish, unless the person asks for that
// now (`crew finish <id> --force` on the closed task). A --force given at finish covered only
// what was there then. { state: returned | gone | held | silent | kept | failed, line }.
function returnWaiting(h, task, { force = false } = {}) {
  const { copyToReturn, ...rest } = task, project = projectOf(h, task);
  // A new explicit force accepts what is here now, not work written during the stop/removal
  // it is about to retry. Keep the original durable baseline if more work appears meanwhile.
  const accepted = force ? snapshotCopy(task.worktree) : copyToReturn.left;
  if (copyToReturn.stopPending) {
    // The stop was requested but not confirmed. Reapply idle/busy protection before any
    // further lifecycle action; uncertainty never grants permission to discard the copy.
    try {
      const result = stopWorker(task, { force });
      if (!result.stopped) return { state: 'held', line: `The working copy of ${task.id} is kept: its worker stop is not confirmed (${result.how}). The next crew finish or crew start retries it.` };
      copyToReturn.stopPending = false;
      saveTask(h, task);
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      return { state: error.exitCode === 4 ? 'silent' : 'held', line: `The working copy of ${task.id} is kept: ${error.message}` };
    }
  }
  if (copyToReturn.cleanupTerminal) {
    const pending = removeStoppedTerminal(task);
    if (pending) return { state: pending.state, line: `${pending.text}; the working copy of ${task.id} is kept. The next crew finish or crew start retries it.` };
    saveTask(h, { ...task, copyToReturn: { ...copyToReturn, cleanupTerminal: false } });
  }
  if (!fs.existsSync(task.worktree)) {
    // Removed by hand: git still lists it and the merged branch is still there.
    if (project?.path) run('git', ['-C', project.path, 'worktree', 'prune']);
    saveTask(h, { ...rest, copyReturned: now() });
    return { state: 'gone', line: `the working copy of finished task ${task.id} was already gone${dropMergedBranch(project, task)}` };
  }
  const holders = otherTerminalsIn(task.worktree, task.terminal);
  if (holders === null) return { state: 'silent', line: `${CORE_SILENT} the terminals in ${task.worktree}; the working copy of ${task.id} was kept. Try again.` };
  if (holders.length) return { state: 'held', line: `the working copy of ${task.id} is still held by ${describeHolders(holders, task.worktree)}; nothing was removed.` };
  const check = checkWaitingCopy(task, accepted, { discardUnseen: force });
  if (check.kept) return { state: 'kept', line: `the working copy of finished task ${task.id} waits: ${check.kept.text}. ${force ? 'The copy changed during this forced attempt; stop writes to it before retrying force.' : `\`crew finish ${task.id} --force\` discards its present contents and returns the copy.`}` };
  // What is left was accepted at finish (or now): discarding it is what was asked.
  const back = returnCopy(task, project, { force: check.leftovers });
  if (!back.ok) return { state: 'failed', line: `the working copy of ${task.id} was not returned yet: ${back.why}` };
  saveTask(h, { ...rest, copyReturned: now() });
  return { state: 'returned', line: `returned the working copy of finished task ${task.id}${back.said}${check.unseen ? '; discarded unseen after explicit --force' : ''}${back.leftover}${back.released ? dropMergedBranch(project, task) : ''}` };
}

function cmdFinish(args) {
  const h = home();
  requireOwner(h);
  const force = args.includes('--force'), id = args.find(a => !a.startsWith('--'));
  if (!id) refuse('Usage: crew finish <id> [--force]');
  const task = loadTask(h, id);
  if (task.state === 'closed') {
    // A closed task whose copy still waits: --force is the person's word to discard what was
    // found in it and return it now. A terminal in it still keeps it, forced or not.
    if (task.copyToReturn && force) {
      const back = returnWaiting(h, task, { force: true });
      if (['held', 'silent', 'failed'].includes(back.state)) refuse(back.line, back.state === 'silent' ? 4 : 6);
      console.log(back.line);
    } else if (task.copyToReturn) {
      // Asked again, perhaps after the tab was closed: try this copy now and say how it stands.
      const back = returnWaiting(h, task);
      console.log(back.state === 'returned' || back.state === 'gone' ? `${id} is already closed; ${back.line}` : `${id} is already closed; its working copy still waits to be returned: ${back.line}`);
    } else console.log(`${id} is already closed`);
    returnWaitingCopies(h, { skip: id });
    return;
  }
  // Somebody else's terminal in the copy is never ended with it, forced or not: the copy then
  // stays until it is free, and everything else is finished. Core is asked before anything is
  // stopped, so a Core that cannot list its terminals still leaves everything as it was.
  if (fs.existsSync(task.worktree) && otherTerminalsIn(task.worktree, task.terminal) === null) refuse(`${CORE_SILENT} the terminals in ${task.worktree}; nothing was removed. Try again.`, 4);
  // Establish the accepted baseline first, and derive the protective refusal from it.
  // A separate earlier clean result must never authorize dirty work found by this snapshot.
  const left = snapshotCopy(task.worktree);
  const work = force ? { dirty: [], keep: false } : workInCopy(task, left);
  if (work.dirty === null) refuse(`Could not check ${task.worktree} for uncommitted work; nothing was removed. Pass --force to discard it unseen.`, 6);
  if (work.dirty.length) refuse(`Task ${id} has uncommitted work in ${task.worktree} (${listFiles(work.dirty)}). Nothing was removed. Commit it there, or pass --force to discard it.`, 6);
  // A copy marked to keep (the shared delivery workflow's marker) is not removed unasked.
  if (work.keep) refuse(`Task ${id} is marked to keep by .artifacts/KEEP in ${task.worktree}. Nothing was removed. Delete the marker, or pass --force.`, 6);
  let attempted = false, result;
  try { result = stopWorker(task, { force, onStop: () => { attempted = true; } }); }
  catch (error) {
    if (!attempted || !(error instanceof Refusal)) throw error;
    result = { stopped: false, how: error.message };
  }
  if (!result.stopped && !attempted) refuse(`Task ${id} could not be stopped (${result.how}); nothing was removed.`, 6);
  const project = projectOf(h, task);
  const forget = () => (AGENTS[task.agent]?.trust === 'claude' || task.fallbacks?.length) && forgetClaudeFolder(task.worktree);
  const closed = { ...task, state: 'closed', closed: now(), outcome: task.state === 'reported' ? 'reported' : task.state };
  // Record the remaining work before asking Core again, so an interrupted removal is retried.
  const waiting = { ...closed, copyToReturn: { since: now(), heldBy: [], left, stopPending: !result.stopped, cleanupTerminal: true } };
  saveTask(h, waiting);
  const cleanup = result.stopped ? removeStoppedTerminal(task) : { text: `its worker stop is not confirmed (${result.how})` };
  waiting.copyToReturn.cleanupTerminal = Boolean(cleanup);
  const holders = cleanup ? null : fs.existsSync(task.worktree) ? otherTerminalsIn(task.worktree, task.terminal) : [];
  let reason = cleanup?.text ?? (holders === null ? 'Core did not say which terminals are in it' : holders.length ? `${holders.length === 1 ? 'terminal' : 'terminals'} ${describeHolders(holders, task.worktree)} ${holders.length === 1 ? 'holds' : 'hold'} it` : null);
  // Only after stopping and removing the terminal can we compare everything written while
  // leaving, including ignored files and scout scratch. Even force accepted only the pre-stop
  // contents. Known changes postpone return with the original baseline. An uninspectable
  // copy needs explicit discard-unseen authority; never infer that authority for a retry.
  const comparison = reason ? null : checkWaitingCopy(waiting, left, { discardUnseen: force });
  reason ??= comparison?.kept?.text ?? null;
  const back = reason ? null : returnCopy(task, project, { force });
  reason ??= back && !back.ok ? back.why : null;
  forget();
  if (reason) {
    waiting.copyToReturn.heldBy = holders?.map(t => t.address) ?? [];
    saveTask(h, waiting);
    console.log(`finished ${id} (${result.how}); its working copy is kept for now (${reason})${holders?.length ? ' and crew returns it by itself once nothing holds it' : '; the next crew finish or crew start retries its return'}; report kept at ${task.report}`);
  } else {
    saveTask(h, closed);
    console.log(`finished ${id} (${result.how})${back.said}${comparison?.unseen ? '; discarded unseen after explicit --force' : ''}; report kept at ${task.report}${back.leftover}${back.released ? dropMergedBranch(project, task) : ''}`);
  }
  // A legacy treehouse task moves its scout's item even after a review, as it always did.
  if (task.kind === 'scout' && task.state === 'reported' && (task.pool === 'treehouse' || !task.reviews)) backlogMove(h, id, 'done');
  returnWaitingCopies(h, { skip: id });
}

// --- follow-ups, review and delivery ------------------------------------------------
// tell: one more round with the same worker, which still has everything in its head.
function cmdTell(args) {
  const h = home();
  requireOwner(h);
  const [id, ...words] = args, message = words.join(' ').trim();
  if (!id || !message) refuse('Usage: crew tell <id> "<message for the worker>"');
  const task = loadTask(h, id);
  if (!['working', 'reported'].includes(task.state)) refuse(`Task ${id} is ${task.state}; there is no worker to tell. Spawn a new task instead.`);
  const { state: seen, t } = probe(task.terminal);
  if (seen === 'unknown') refuse(`${CORE_SILENT} terminal ${task.terminal}; nothing was sent. Try again.`, 4);
  if (seen !== 'live') refuse(`The worker terminal of ${id} is gone; spawn a new task instead.`, 6);
  if (t.status?.state === 'blocked') refuse(`The worker of ${id} is waiting for a person (terminal ${task.terminal}); nothing was sent.`, 7);
  const text = `Message from the coordinator about task ${id}: ${message}\nWhen you have dealt with it, rewrite ${task.report} so it holds the complete, current result, then run \`crew done ${id}\` again and stop.`;
  // The task is open again BEFORE the message goes out, so a fast worker's new report is
  // never overwritten by this command.
  saveTask(h, { ...task, state: 'working', told: now(), tells: (task.tells ?? 0) + 1 });
  const sent = hc(['send', task.terminal, text]);
  if (sent.code !== 0) {
    saveTask(h, { ...loadTask(h, id), state: task.state });
    refuse(`Core did not deliver the message to terminal ${task.terminal}: ${lastLine(sent.stderr || sent.stdout)}`, 4);
  }
  console.log(`told ${id}; next: crew wait ${id}`);
}

// review: a second pair of eyes on a ship task's branch, as an ordinary read-only task.
function cmdReview(args) {
  const h = home();
  requireOwner(h);
  const { flags, rest } = takeFlags(args, PICK_FLAGS, ['no-fallback']);
  const id = rest[0];
  if (!id) refuse(`Usage: crew review <id> ${PICK_USAGE}`);
  if (flags.agent !== undefined && !AGENTS[flags.agent]) refuse(`Unknown agent: ${flags.agent}. Known: ${Object.keys(AGENTS).join(', ')}`);
  const task = loadTask(h, id);
  if (task.kind !== 'ship' || task.selfFix) refuse(`Task ${id} is not a ship task of a project; only those have a branch to review.`);
  if (task.state !== 'reported') refuse(`Task ${id} is ${task.state}; review it after its worker reported.`);
  const project = h.config.projects[task.project] ?? refuse(`Unknown project: ${task.project}.`);
  const opts = { kind: 'scout', project: task.project };
  // Without a choice and without a review chain in the configuration: CREW_REVIEW_AGENT, else the author's agent.
  const legacy = process.env.CREW_REVIEW_AGENT ?? task.agent;
  if (!AGENTS[legacy]) refuse(`Unknown agent: ${legacy}. Known: ${Object.keys(AGENTS).join(', ')}`);
  let n = 1, reviewId = `${id}-review`.slice(0, 40);
  while (fs.existsSync(taskDir(h, reviewId))) reviewId = `${id.slice(0, 30)}-review-${++n}`;
  const text = [
    `Review the work of task ${id}. It is the branch \`${branchOf(task)}\` of this repository; you are on the commit it started from.`,
    '', `- See it with \`git log HEAD..${branchOf(task)}\` and \`git diff HEAD...${branchOf(task)}\`. Read the changed files whole where the diff is not enough.`,
    `- What it was asked to do is in \`${task.brief}\`; what its author says it did is in \`${task.report}\`.`,
    '- Look for defects: wrong behaviour, missed cases, broken or missing tests, changes beyond the task. Run the project\'s tests if that is cheap. Ignore style.',
    '- Start your report with one line: `APPROVE` or `CHANGES NEEDED`. Then each defect with file and line, what goes wrong, and how to see it. No defect, no text.',
  ].join('\n');
  launchWorker(h, { id: reviewId, opts, chosen: chooseWorker(h, 'review', flags, legacy, task.project), project, task: text, extra: { reviews: id } });
  console.log(`next: crew wait ${reviewId}; on CHANGES NEEDED: crew tell ${id} "<the defects>", wait, and review again`);
}

// land: hand a finished ship task to the person as a pull request. Merging stays with them.
export const githubOwner = url => /github\.com[:/]+([^/]+)\/[^/]+?(?:\.git)?\/?$/.exec(String(url).trim())?.[1] ?? null;
const GH = process.env.CREW_GH || 'gh';
const gh = (args, options) => (GH.endsWith('.mjs') ? run(process.execPath, [GH, ...args], options) : run(GH, args, options));
// The pull request a worker (or its gate) opened: a link in its report, else what GitHub has
// for its branch. A workflow worker puts its own link on the first line, and a link further
// down may be another pull request it mentions, so for it only the first line is read.
function pullRequestOf(task, branch, { firstLine = false } = {}) {
  const text = fs.existsSync(task.report) ? fs.readFileSync(task.report, 'utf8') : '';
  const reported = PR_LINK.exec(firstLine ? text.trim().split(/\r?\n/)[0] ?? '' : text)?.[0];
  if (reported) return reported;
  const asked = gh(['pr', 'view', branch, '--json', 'url', '--jq', '.url'], { cwd: task.worktree, timeout: 60000 });
  return /https?:\/\/\S+/.exec(asked?.stdout ?? '')?.[0] ?? null;
}
// Commits of the copy that its pushed branch lacks: 0 when all is pushed, null when the branch
// is not on origin at all, undefined when origin could not be asked.
function unpushedCommits(git, branch) {
  const listed = git('ls-remote', '--exit-code', '--heads', 'origin', branch);
  if (listed.code === 2) return null;
  if (listed.code !== 0 || git('fetch', '--quiet', 'origin', branch).code !== 0) return undefined;
  return Number(git('rev-list', '--count', 'FETCH_HEAD..HEAD').stdout.trim()) || 0;
}
// "draft, 2 of 3 outcomes ticked" from one read of the pull request; null when GitHub does not answer.
function pullRequestState(url) {
  const asked = gh(['pr', 'view', url, '--json', 'isDraft,body'], { timeout: 60000 });
  let pr = null;
  try { pr = JSON.parse(asked.stdout); } catch { return null; }
  if (asked.code !== 0 || !pr) return null;
  const outcomes = /^## Implementation\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(pr.body ?? '')?.[1] ?? '';
  const ticked = (outcomes.match(/^\s*- \[[xX]\]/gm) ?? []).length, all = ticked + (outcomes.match(/^\s*- \[ \]/gm) ?? []).length;
  return `${pr.isDraft ? 'draft' : 'ready'}${all ? `, ${ticked} of ${all} outcomes ticked` : ''}`;
}
function cmdLand(args) {
  const h = home();
  requireOwner(h);
  let title = null; const rest = [];
  for (let i = 0; i < args.length; i++) { if (args[i] === '--title') title = args[++i]; else rest.push(args[i]); }
  const id = rest[0];
  if (!id) refuse('Usage: crew land <id> [--title "<pull request title>"]');
  const task = loadTask(h, id);
  if (task.selfFix) refuse(`Task ${id} repairs crew itself; publish it with \`crew selfmerge ${id}\`.`);
  if (task.kind !== 'ship') refuse(`Task ${id} is a scout; it has a report, not a branch.`);
  // A workflow task's link is recorded already when its worker reports; it lands only once.
  if (task.pr && (task.landed || !task.workflow)) { console.log(`${id} already has a pull request: ${task.pr}`); return; }
  if (task.state !== 'reported') refuse(`Task ${id} is ${task.state}; it is delivered only after its worker reported.`);
  const project = h.config.projects[task.project] ?? refuse(`Unknown project: ${task.project}.`);
  const wt = task.worktree, git = (...a) => run('git', ['-C', wt, ...a], { timeout: 120000 });
  const no = (why, code = 6) => refuse(`Task ${id} was not delivered: ${why}`, code);
  if (!fs.existsSync(path.join(wt, '.git'))) no(`its working copy ${wt} is gone. Its commits are still on branch ${branchOf(task)} in ${project.path}.`);
  const dirty = git('status', '--porcelain');
  if (dirty.code !== 0 || dirty.stdout.trim()) no(`its working copy has uncommitted files (${dirty.stdout.trim().split(/\r?\n/).slice(0, 5).map(l => l.slice(3)).join(', ')}). Tell the worker to commit them: crew tell ${id} "..."`);
  const remote = git('remote', 'get-url', 'origin');
  if (task.gate === 'no-mistakes') {
    // The gate reviewed, pushed and opened the pull request while the worker drove it; what
    // is left is to find that pull request: in the report, or by asking GitHub for the branch.
    const found = pullRequestOf(task, git('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim());
    if (!found) no(`the no-mistakes gate has not opened a pull request for it yet. Ask the worker where the gate stands: crew tell ${id} "run no-mistakes axi status and finish the gate"`);
    saveTask(h, { ...loadTask(h, id), pr: found, landed: now() });
    console.log(`delivered ${id} through no-mistakes: ${found}. Merging it is the person's decision.`);
    backlogMove(h, id, 'done', ['--pr', found]);
    return;
  }
  if (task.workflow) {
    // The repository's own workflow: the worker opened the draft pull request and ticks it,
    // the repository's bot marks it ready. Crew only records it; it never pushes or opens one.
    if (task.stage === 'plan') no(`its last report is a plan awaiting approval, not an implementation. Read the plan, then: crew tell ${id} "approved, implement", or send it back with what to change.`);
    // Delivered means the pull request holds every commit of the copy; the worker pushes them.
    if (remote.code !== 0) no('the project has no `origin`, so it has no pull request to record.');
    const behind = unpushedCommits(git, branchOf(task));
    if (behind === undefined) no('the project\'s origin could not be reached. Try again.', 4);
    if (behind === null) no(`its branch ${branchOf(task)} is not pushed. Tell the worker: crew tell ${id} "push your branch and open the draft pull request as the change-delivery skill says"`);
    if (behind) no(`its copy has ${behind} commit${behind === 1 ? '' : 's'} that the pushed branch ${branchOf(task)} lacks. Tell the worker: crew tell ${id} "push your last commits to the pull request"`);
    const found = pullRequestOf(task, branchOf(task), { firstLine: true });
    if (!found) no(`the worker has not opened its pull request yet. Tell it: crew tell ${id} "open the draft pull request as the change-delivery skill says and put Implementation: <its link> in the first line of your report"`);
    saveTask(h, { ...loadTask(h, id), pr: found, landed: now() });
    const shown = pullRequestState(found);
    console.log(`delivered ${id}: ${found}${shown ? ` (${shown})` : ''}. It follows the repository's delivery workflow: its bot marks it ready; merging is the person's decision.`);
    backlogMove(h, id, 'done', ['--pr', found]);
    return;
  }
  if (remote.code !== 0) no(`the project has no \`origin\` to push to. The work stays on branch ${branchOf(task)} in ${project.path}.`);
  // The pull request goes against the branch the project folder is on, if that branch is
  // published; otherwise against the repository's default branch.
  const current = run('git', ['-C', project.path, 'rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  const published = name => name && name !== 'HEAD' && git('ls-remote', '--exit-code', '--heads', 'origin', name).code === 0;
  const fallback = git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD').stdout.trim().replace(/^origin\//, '');
  const base = published(current) ? current : published(fallback) ? fallback : no('no published branch to open the pull request against was found.');
  if (git('fetch', '--quiet', 'origin', base).code !== 0) no('the project\'s origin could not be reached. Try again.', 4);
  const subjects = git('log', '--reverse', '--format=%s', `FETCH_HEAD..HEAD`).stdout.split(/\r?\n/).filter(Boolean);
  if (!subjects.length) no(`its branch has no commits beyond ${base}.`);
  const pushed = git('push', '--quiet', 'origin', `HEAD:refs/heads/${branchOf(task)}`);
  if (pushed.code !== 0) no(`the push was refused (${lastLine(pushed.stderr)}).`, 4);
  const bodyFile = path.join(taskDir(h, id), 'pull-request.md');
  const report = fs.existsSync(task.report) ? fs.readFileSync(task.report, 'utf8').trim().split(/\r?\n/).slice(0, 200).join('\n') : '';
  fs.writeFileSync(bodyFile, `${report}\n\n---\nWork of crew task \`${id}\` (${task.agent}), ${subjects.length} commit${subjects.length === 1 ? '' : 's'}.\n`);
  // A machine can be signed in to GitHub as several people. If one of them is the owner of
  // the repository, the pull request is opened as that one.
  const env = githubEnvironment(remote.stdout);
  const made = gh(['pr', 'create', '--base', base, '--head', `${branchOf(task)}`, '--title', title || subjects[0], '--body-file', bodyFile], { cwd: wt, env, timeout: 120000 });
  const url = /https?:\/\/\S+/.exec(made.stdout)?.[0];
  if (made.error || made.code !== 0 || !url) no(`its branch ${branchOf(task)} is pushed, but the pull request was not opened (${made.error?.message ?? lastLine(made.stderr || made.stdout)}). Run \`crew land ${id}\` again, or open it by hand.`, 4);
  saveTask(h, { ...loadTask(h, id), pr: url, landed: now() });
  console.log(`delivered ${id}: ${url} (against ${base}, ${subjects.length} commit${subjects.length === 1 ? '' : 's'}). Merging it is the person's decision.`);
  backlogMove(h, id, 'done', ['--pr', url]);
}

function githubEnvironment(remote) {
  const owner = githubOwner(remote), token = owner ? gh(['auth', 'token', '--user', owner]) : null;
  return token?.code === 0 && token.stdout.trim() ? { ...process.env, GH_TOKEN: token.stdout.trim() } : process.env;
}

// --- crew maintains itself -------------------------------------------------------
// A worker commits a repair; crew checks its scope, rebases and tests before opening a PR.
// The person merges it. Machines pick it up at update/start; rollback stays per machine.
export function toolLayout(folder, override) {
  const repository = fs.existsSync(path.join(folder, '.git')) ? folder : path.dirname(folder);
  const relative = slash(path.relative(repository, folder));
  return { root: slash(path.resolve(override || repository)), prefix: relative ? `${relative}/` : '' };
}
export function repairFile(file, prefix) {
  const own = file.startsWith(prefix) ? file.slice(prefix.length) : null;
  return own !== null && (['crew.mjs', 'crew.test.mjs', 'README.md'].includes(own)
    || /^(bin|docs)\/.+/.test(own));
}
const { root: TOOL_ROOT, prefix: TOOL_PREFIX } = toolLayout(HERE, process.env.CREW_TOOL_ROOT);
const toolFile = name => `${TOOL_PREFIX}${name}`;
// Update and crash records. Before 0.7 they sat directly in ~/.crew; one found there is moved
// the first time a command uses it.
const STATE = path.join(CREW_DIR, 'state');
function stateFile(name, before) {
  const file = path.join(STATE, name), old = path.join(CREW_DIR, before);
  try { if (!fs.existsSync(file) && fs.existsSync(old)) { fs.mkdirSync(STATE, { recursive: true }); fs.renameSync(old, file); } } catch { /* stays where it was */ }
  return file;
}
// Functions, not values: nothing on disk moves until a command really uses the record, so
// importing this file (the tests do) never touches the machine's own ~/.crew.
const PREVIOUS = () => stateFile('previous', 'tool-previous'), PINNED = () => stateFile('pinned', 'tool-pinned'), CRASHES = () => stateFile('crashes', 'crashes');
const SELF_PROJECT = 'crew:self'; // not a valid project name, so it can never be a registered one
const toolGit = (...args) => run('git', ['-C', TOOL_ROOT, ...args], { timeout: 120000 });
const toolRevision = () => { const r = toolGit('rev-parse', 'HEAD'); return r.code === 0 ? r.stdout.trim() : null; };
const short = revision => String(revision ?? '').slice(0, 8) || 'unknown';
const lastLine = text => String(text ?? '').trim().split(/\r?\n/).filter(Boolean).at(-1) ?? 'no message';
const readLine = file => { try { return fs.readFileSync(file, 'utf8').trim() || null; } catch { return null; } };
const isClone = () => fs.existsSync(path.join(TOOL_ROOT, '.git'));
// Only the copy Herdr installed updates itself; a developer's checkout is left alone.
const installedCopy = () => process.env.CREW_AUTO_UPDATE === '1' || ['core', 'tool'].some(name => slash(path.join(CREW_DIR, name)).toLowerCase() === TOOL_ROOT.toLowerCase());

// Fast-forwards the tool to the published main. Never merges, rebases or discards anything.
function updateTool({ respectPin = false } = {}) {
  if (!isClone()) return { failed: true, note: `${TOOL_ROOT} is not a git clone` };
  const before = toolRevision();
  const fetched = toolGit('fetch', '--quiet', 'origin', 'main');
  if (fetched.code !== 0) return { failed: true, note: `the source could not be reached (${lastLine(fetched.stderr)})` };
  const target = toolGit('rev-parse', 'origin/main').stdout.trim();
  const pinned = readLine(PINNED());
  if (pinned && respectPin && pinned === target) return { pinned };
  if (pinned) fs.rmSync(PINNED(), { force: true });
  if (!target || target === before) return { changed: false, revision: before };
  if (toolGit('merge-base', '--is-ancestor', before, target).code !== 0) return { failed: true, note: 'this copy has commits the published main does not have; it was left as it is' };
  const merged = toolGit('merge', '--ff-only', '--quiet', target);
  if (merged.code !== 0) return { failed: true, note: lastLine(merged.stderr) };
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(PREVIOUS(), `${before}\n`);
  return { changed: true, from: before, revision: target };
}

function cmdUpdate() {
  const u = updateTool();
  if (u.failed) refuse(`crew was not updated: ${u.note}`, 4);
  console.log(u.changed ? `crew updated ${short(u.from)} -> ${short(u.revision)}` : `crew is up to date (${short(u.revision)})`);
}

function cmdRollback() {
  const previous = readLine(PREVIOUS()), current = toolRevision();
  if (!previous || !current) refuse('No earlier crew revision is recorded on this machine.');
  if (previous === current) refuse(`crew is already at ${short(previous)}.`);
  if (toolGit('status', '--porcelain', '--untracked-files=no').stdout.trim()) refuse(`${TOOL_ROOT} has uncommitted changes; nothing was rolled back.`, 6);
  const back = toolGit('reset', '--hard', '--quiet', previous);
  if (back.code !== 0) refuse(`Could not go back to ${short(previous)}: ${lastLine(back.stderr)}`, 6);
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(PINNED(), `${current}\n`);
  fs.rmSync(PREVIOUS(), { force: true });
  console.log(`crew went back ${short(current)} -> ${short(previous)} on this machine. It stays there until something newer than ${short(current)} is published, or until \`crew update\`.`);
}

function recordCrash(argv, error) {
  try {
    fs.mkdirSync(CRASHES(), { recursive: true });
    const file = path.join(CRASHES(), `${now().replace(/[:.]/g, '-')}-${process.pid}.txt`);
    fs.writeFileSync(file, [`crew ${VERSION} at ${short(toolRevision())} (${TOOL_ROOT})`, `when: ${now()}`, `platform: ${process.platform}, node ${process.version}`,
      `command: crew ${argv.join(' ')}`, `folder: ${slash(process.cwd())}`, '', String(error?.stack ?? error), ''].join('\n'));
    return file;
  } catch { return null; }
}
function recentCrashes() {
  try {
    return fs.readdirSync(CRASHES()).filter(n => n.endsWith('.txt')).sort().slice(-3).map(n => path.join(CRASHES(), n))
      .filter(f => Date.now() - fs.statSync(f).mtimeMs < 24 * 3600 * 1000);
  } catch { return []; }
}

function cmdFix(args) {
  const h = home();
  requireOwner(h);
  const opts = { kind: 'ship', project: SELF_PROJECT }, { flags, rest: words } = takeFlags(args, PICK_FLAGS, ['no-fallback']);
  const problem = words.join(' ').trim();
  if (!problem) refuse(`Usage: crew fix ${PICK_USAGE} "<what you ran, what happened, what you expected>"`);
  const legacy = process.env.CREW_FIX_AGENT || 'a1';
  for (const name of [flags.agent, legacy]) if (name !== undefined && !AGENTS[name]) refuse(`Unknown agent: ${name}. Known: ${Object.keys(AGENTS).join(', ')}`);
  if (!isClone()) refuse(`crew's own source (${TOOL_ROOT}) is not a git clone, so it cannot be repaired from here.`);
  // One repair at a time: two fixers on the same few files would only undo each other.
  const open = allTasks(h).filter(t => t.selfFix && t.state !== 'closed');
  if (open.length) refuse(`A repair is already open: ${open.map(t => `${t.id}[${t.state}]`).join(' ')}. Wait for it and merge or finish it first.`);
  let n = 1;
  while (fs.existsSync(taskDir(h, `fix-${n}`))) n++;
  const id = `fix-${n}`, crashes = recentCrashes();
  const task = [
    `Repair a defect in the crew tool itself. This working copy is crew's own source: the tool is \`${toolFile('crew.mjs')}\`, its tests are \`${toolFile('crew.test.mjs')}\`, its design is in \`${toolFile('README.md')}\`.`,
    '', '## The problem, as the coordinator saw it', problem,
    ...(crashes.length ? ['', '## Crash records from this machine (read them)', ...crashes.map(f => `- \`${slash(f)}\``)] : []),
    '', '## What to do',
    `1. Find the cause in \`${toolFile('crew.mjs')}\`. Say so in the report if the problem is not a defect in crew.`,
    `2. Add a check to \`${toolFile('crew.test.mjs')}\` that fails because of the defect, then make the smallest change that fixes it.`,
    `3. Change only \`${toolFile('crew.mjs')}\`, \`${toolFile('crew.test.mjs')}\`, \`${toolFile('README.md')}\`, or files under \`${toolFile('bin/')}\` and \`${toolFile('docs/')}\`. Repository infrastructure is out of scope.`,
    `4. Run \`node ${toolFile('crew.test.mjs')}\` and keep going until it exits 0. The fix is published only if the whole suite passes.`,
    '5. Commit on this branch. Do not push: the coordinator publishes it with `crew selfmerge`.',
    '6. In the report give the cause, the change and the new check, each in a line or two.',
  ].join('\n');
  launchWorker(h, { id, opts, chosen: chooseWorker(h, 'fix', flags, legacy, SELF_PROJECT), project: { path: TOOL_ROOT }, task, extra: { selfFix: true, projectPath: TOOL_ROOT, base: toolRevision() } });
  console.log(`next: crew wait ${id}, then crew selfmerge ${id}`);
}

function cmdSelfmerge(args) {
  const h = home();
  requireOwner(h);
  const id = args[0], task = loadTask(h, id);
  if (!task.selfFix) refuse(`Task ${id} is not a repair of crew; \`crew selfmerge\` publishes only those.`);
  if (task.pr) { console.log(`${id} already has a pull request: ${task.pr}. After the person merges it, run \`crew update\` or use the next \`crew start\`.`); return; }
  if (task.merged) { console.log(`${id} is already published as ${short(task.merged)}`); return; }
  if (task.state !== 'reported') refuse(`Task ${id} is ${task.state}; a repair is published only after its worker reported.`);
  const wt = task.worktree, git = (...a) => run('git', ['-C', wt, ...a], { timeout: 120000 });
  const no = (why, code = 6) => refuse(`Repair ${id} was not published: ${why}`, code);
  if (!fs.existsSync(path.join(wt, '.git'))) no(`its working copy ${wt} is gone.`);
  const dirty = git('status', '--porcelain');
  if (dirty.code !== 0 || dirty.stdout.trim()) no(`its working copy has uncommitted files (${dirty.stdout.trim().split(/\r?\n/).slice(0, 5).map(l => l.slice(3)).join(', ')}). The fixer must commit or remove them.`);
  const fetched = git('fetch', '--quiet', 'origin', 'main');
  if (fetched.code !== 0) no(`the source could not be reached (${lastLine(fetched.stderr)}). Try again.`, 4);
  // On top of what is published now, so a fix made on another machine meanwhile is kept.
  const rebased = git('rebase', '--quiet', 'origin/main');
  if (rebased.code !== 0) { git('rebase', '--abort'); no(`it does not apply on top of the published main (${lastLine(rebased.stderr || rebased.stdout)}). Finish it and start a new repair.`); }
  const changed = git('diff', '--name-only', '-z', '--no-renames', 'origin/main', 'HEAD');
  if (changed.code !== 0) no('its changed files could not be read; nothing was pushed.');
  const files = changed.stdout.split('\0').filter(Boolean);
  if (!files.length) no('it changes nothing compared with the published main.');
  const outside = files.filter(f => !repairFile(f, TOOL_PREFIX));
  if (outside.length) no(`it changes files outside crew's own files (${outside.slice(0, 5).join(', ')}). Repository infrastructure is out of scope.`);
  // The suite runs as it would on a clean machine: nothing of this session leaks into it.
  const command = process.env.CREW_SELFTEST || `node ${toolFile('crew.test.mjs')}`;
  const testEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CREW_|HC_TERMINAL_ID$)/i.test(key)));
  const tested = run(command, [], { shell: true, cwd: wt, env: testEnv, timeout: 15 * 60 * 1000 });
  if (tested.code !== 0) no(`the test suite fails (${command}, exit ${tested.code ?? 'timeout'}):\n${`${tested.stdout}\n${tested.stderr}`.trim().split(/\r?\n/).slice(-12).join('\n')}`);
  const subject = git('log', '--reverse', '--format=%s', 'origin/main..HEAD').stdout.split(/\r?\n/).find(Boolean) || 'Repair the reported crew defect';
  // Commit subjects are untrusted prose, not PR-body markup. Keep the outcome one bounded line.
  let outcome = `Crew's reported defect is repaired: ${subject.replace(/https?:\/\/\S+|[@<>`]/g, '').replace(/\s+/g, ' ').trim()}`;
  while (Buffer.byteLength(outcome) > 280) outcome = Array.from(outcome).slice(0, -1).join('');
  const bodyFile = path.join(taskDir(h, id), 'pull-request.md');
  fs.writeFileSync(bodyFile, `## Proposal\n\nRepair the reported defect in crew's own source without changing repository infrastructure. The repair is delivered for the person's merge rather than pushed to main.\n\n## Implementation\n\n- [x] ${outcome}\n\n## Acceptance\n\n- The reported crew defect is repaired on a branch based on the published main.\n- Repository infrastructure remains unchanged by this repair.\n`);
  const checked = runTool('delivery', ['check-body', '--body-file', bodyFile, '--final'], { cwd: wt, timeout: 60000 });
  if (checked && checked.code !== 0) no(`its pull request body was rejected by delivery (${lastLine(checked.stderr || checked.stdout)}). Nothing was pushed.`);
  const branch = branchOf(task), remote = git('remote', 'get-url', 'origin');
  const env = githubEnvironment(remote.stdout);
  const pushed = git('push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`);
  if (pushed.code !== 0) no(`the push was refused (${lastLine(pushed.stderr)}). Run \`crew selfrepair ${id}\` again.`, 4);
  const made = gh(['pr', 'create', '--draft', '--base', 'main', '--head', branch, '--title', subject, '--body-file', bodyFile], { cwd: wt, env, timeout: 120000 });
  const url = /https?:\/\/\S+/.exec(made.stdout)?.[0];
  if (made.error || made.code !== 0 || !url) no(`its branch ${branch} is pushed, but the pull request was not opened (${made.error?.message ?? lastLine(made.stderr || made.stdout)}). Run \`crew selfrepair ${id}\` again.`, 4);
  saveTask(h, { ...loadTask(h, id), pr: url, landed: now() });
  console.log(`delivered repair ${id}: ${url}; tests passed. Merging it is the person's decision.`);
  console.log('This machine was not updated. After the person merges it, run `crew update` or use the next `crew start`, then retry what failed.');
}

function taskElapsedSeconds(task, currentTime) {
  const start = Date.parse(task.spawned ?? task.created);
  const end = Date.parse(task.state === 'closed' ? task.closed : task.state === 'reported' ? task.reported
    : task.state === 'stopped' ? task.stopped : task.state === 'failed' ? task.updated : null);
  if (!Number.isFinite(start)) return null;
  return Math.max(0, Math.floor(((Number.isFinite(end) ? end : currentTime) - start) / 1000));
}
function formatDuration(seconds) {
  if (seconds === null) return '-';
  const parts = [];
  for (const [unit, size] of [['d', 86400], ['h', 3600], ['m', 60], ['s', 1]]) {
    const count = Math.floor(seconds / size);
    if (count) parts.push(`${count}${unit}`);
    seconds %= size;
  }
  return parts.slice(0, 2).join(' ') || '0s';
}

function cmdStatus(args) {
  const h = home();
  const json = args.includes('--json'), all = args.includes('--all');
  const { owner, live, mine } = ownerState(h);
  const currentTime = Date.now();
  const tasks = allTasks(h).filter(t => all || t.state !== 'closed').map(t => {
    const core = ['closed', 'failed'].includes(t.state) ? null : terminal(t.terminal);
    return { id: t.id, state: t.state, kind: t.kind, agent: t.agent, launch: t.launch ? { ...t.launch, label: pickLabel(t.launch) } : null, standby: (t.chain ?? []).map(pickLabel),
      standbyStatus: (t.chain ?? []).map(c => { const fact = t.candidateChecks?.facts?.[pickKey(c)]; return { ...c, label: pickLabel(c), status: fact?.status ?? 'unknown', note: fact?.note ?? 'no recorded reading', remaining: fact?.remaining ?? null, passedOver: Boolean(fact && !['ok', 'unknown'].includes(fact.status)), checkedAt: t.candidateChecks?.checkedAt ?? null }; }), fallbacks: t.fallbacks ?? [], project: t.project, terminal: t.terminal,
      core: core ? { state: core.state, agent: core.status?.app ?? null, status: core.status?.state ?? null } : null,
      nudges: t.nudges ?? [], continuations: (t.nudges ?? []).filter(n => n.kind === 'error' && n.terminal === t.terminal).length,
      recovery: t.recovery?.terminal === t.terminal ? t.recovery : null,
      report: fs.existsSync(t.report) ? t.report : null, pr: t.pr ?? null, error: t.error ?? null, elapsedSeconds: taskElapsedSeconds(t, currentTime),
      deliveryKind: t.kind === 'ship' ? t.gate ? 'gate' : t.workflow ? 'workflow' : 'plain' : null,
      ...(t.workflow ? { workflow: t.workflow, stage: t.stage ?? null } : {}),
      ...(t.copyToReturn ? { copyToReturn: copyWaiting(t) } : {}) };
  });
  // A closed task whose copy still waits to be returned is not hidden: --all lists it with its
  // holders, and plain status (which is about unfinished work) says how many there are.
  const waiting = all ? 0 : allTasks(h).filter(t => t.state === 'closed' && t.copyToReturn).length;
  if (json) { console.log(JSON.stringify({ home: slash(h.dir), owner: owner ? { terminal: owner.terminal, live, mine } : null, tasks, ...(all ? {} : { copiesToReturn: waiting }) })); return; }
  console.log(`home ${slash(h.dir)} - ${owner ? `owner ${owner.terminal}${mine ? ' (you)' : live ? ' (live, you are read-only)' : ' (gone)'}` : 'no owner'}`);
  if (!tasks.length) console.log(all ? 'no tasks' : 'no unfinished tasks');
  // A workflow task's stage is what its last report said it is; GitHub is not asked here.
  const stageOf = t => (!t.stage ? '' : t.stage === 'plan' && t.state === 'reported' ? ' (plan awaiting approval)' : ` (${t.stage})`);
  for (const t of tasks) console.log(`${t.id}\t${t.state}${stageOf(t)}\t${t.kind}/${t.launch?.label ?? t.agent}${t.fallbacks.length ? ` (after ${t.fallbacks.map(f => f.from).join(', ')})` : ''}\t${t.project}\t${t.terminal ?? '-'}${t.core ? ` (${t.core.status ?? t.core.state}${t.core.status === 'error' ? `; told to continue ${t.continuations} ${t.continuations === 1 ? 'time' : 'times'}` : ''})` : ''}\t${formatDuration(t.elapsedSeconds)}${t.pr ? `\t${t.pr}` : ''}${t.error ? `\t${t.error}` : ''}${t.copyToReturn ? `\tworking copy still to be returned, ${t.copyToReturn.pending ? `waits: ${t.copyToReturn.pending}${t.copyToReturn.heldBy ? `; held by ${t.copyToReturn.heldBy}` : ''}` : t.copyToReturn.heldBy ? `held by ${t.copyToReturn.heldBy}` : t.copyToReturn.kept ? `waits: ${t.copyToReturn.kept} (crew finish ${t.id} --force discards it)` : t.copyToReturn.free ? 'free now (returned at the next crew start or finish)' : 'Core did not say who holds it'}` : ''}`);
  if (waiting) console.log(`${waiting} working ${waiting === 1 ? 'copy' : 'copies'} of finished tasks still to be returned (crew status --all)`);
}
// Where a postponed copy stands now, asked of Core: { worktree, since, heldBy, free }.
function copyWaiting(task) {
  const holders = fs.existsSync(task.worktree) ? otherTerminalsIn(task.worktree, task.terminal) : [];
  const { stopPending, cleanupTerminal } = task.copyToReturn;
  const pending = stopPending ? 'its worker stop is not confirmed' : cleanupTerminal ? 'its worker terminal removal is not confirmed' : null;
  const free = !pending && Array.isArray(holders) && !holders.length, kept = free && fs.existsSync(task.worktree) ? checkWaitingCopy(task).kept : null;
  const why = stopPending ? 'stop pending' : cleanupTerminal ? 'terminal removal pending' : holders === null ? 'unknown' : holders.length ? 'held' : kept ? kept.why : 'free';
  return { worktree: task.worktree, since: task.copyToReturn.since ?? null, why, heldBy: holders?.length ? describeHolders(holders, task.worktree) : null, kept: kept?.text ?? null, pending, free: why === 'free' };
}

const COMMANDS = { init: cmdInit, project: cmdProject, start: cmdStart, end: cmdEnd, spawn: cmdSpawn, done: cmdDone, wait: cmdWait, stop: cmdStop, finish: cmdFinish, status: cmdStatus,
  home: cmdHome, tools: cmdTools, backlog: cmdBacklog, show: cmdShow, tell: cmdTell, review: cmdReview, land: cmdLand, fix: cmdFix, agents: cmdAgents, relaunch: cmdRelaunch, selfrepair: cmdSelfmerge, selfmerge: cmdSelfmerge, update: cmdUpdate, rollback: cmdRollback };
const USAGE = `crew ${VERSION} - a small crew tool on Herdr Core
  crew init [folder]                       create a crew home (default ~/.crew)
  crew project add <name> <git folder> [--gate-skip <steps>|none] [--workflow delivery|plain]   register a project   (crew project list)
      re-adding replaces the registration: omitted workflow and gate-skip choices are dropped
  crew project remove <name>               forget a project with no unfinished tasks
  crew start | crew end                    take or release the home for this session
  crew spawn <id> --project <name> [--kind scout|ship] [--type <type>] [who] "<task>"
      who: ${PICK_USAGE}
  crew agents [--role scout|ship|review|fix] [--project <name>] [who] [--json]   original rows and quota now, next choice marked
  crew relaunch <id> [who] ["<why>"]       end the current session, even busy; hand over working, stopped or failed work; copy stays
      no choice: reread all untried saved candidates, including earlier skips; a choice rebuilds the list and excludes only the current worker
  crew wait <id>... [--timeout seconds] [--no-fallback]   wait for reports; recover stopped or idle workers
      CREW_NO_FALLBACK=1 also disables recovery and hand-over; questions/permissions need a person even with candidates left; ended terminals fail without hand-over
  crew status [--all] [--json]             tasks, terminals, PR links and elapsed time; --all also shows why finished copies wait
      JSON: elapsedSeconds, recorded deliveryKind (gate/workflow/plain, null for non-ships), standby labels and standbyStatus with recorded skip reasons; no quota refresh
      recovery: current Core errors and continuation counts; JSON includes nudges history and the active recovery record; no messages sent
  crew stop <id> [--force]                 ask the worker to leave
  crew finish <id> [--force]               close the task; return its copy and proved-merged branch now or later
      protective refusals use the accepted baseline before stop; later uncertainty postpones return; status alone returns nothing
      current --force can discard uninspectable contents unseen, but never override an unconfirmed stop/removal or another terminal
      sweeps follow successful handling only; forced finish of a closed task refuses held, silent or failed returns
      backlog: only reported scouts move here (not reviewers, except legacy treehouse); ships move at land
  crew done [<id>]                         (worker) my report is written
  crew tell <id> "<message>"               send the worker a follow-up; it reports again
  crew review <id> [who]                   start a read-only reviewer; use its printed ID (truncated or numbered when needed)
  crew land <id> [--title "<title>"]       push/open a plain PR, or record the workflow/gate PR
      first land requires a reported worker, existing copy and clean tracked/untracked files; an already-landed PR can return early
      plain PR text uses the first 200 report lines plus attribution; workflow draft/outcome summary is best-effort
  crew tools [--json]                      Firstmate's tools on this machine and what crew does with each
  crew backlog [tasks-axi command...]      the durable list of work in this home (tasks-axi)
  crew show <page.html>                    open a page for the person (lavish-axi) with a link in Herdr's status bar
  crew fix [who] "<problem>"               start a worker that repairs crew itself
  crew selfmerge <id>                      publish that repair if it stays in crew/ and the tests pass
  crew update | crew rollback              bring this machine's crew up to date, or back one step

  Choices: --agent starts clean; model/effort/account alone modify the first selected profile.
  --rule replaces the list by its one-based number; descriptions are not matched to tasks.
  --no-fallback keeps one profile before Claude account expansion; also name --account for one login.
  Lists override legacy defaults: spawn a1, review CREW_REVIEW_AGENT or author, fix CREW_FIX_AGENT or a1.
  Only floors rearrange candidates: normal/unknown before low, order kept within groups.
  Profiles sharing agent/model/account are one attempt even if effort or floor differs.
  Profile provider selects the quota family, not the launch provider; floors use applicable effective availability.
  Initial selection skips reads for one candidate; agents/hand-over check even one. Shared quota,
  CREW_NO_QUOTA=1 or missing quota-axi skips quota reads, not applicable installation checks.
  Gate delivery needs both the no-mistakes remote and installed tool; otherwise workflow/plain.
`;

export function main(argv) {
  const [name, ...args] = argv;
  if (name === '--version') { console.log(VERSION); return; }
  const command = COMMANDS[name];
  // `crew <command> --help` is a question, never an id or a task text.
  if (command && name !== 'backlog' && args.some(a => a === '--help' || a === '-h')) { console.log(USAGE); return; }
  if (!command) { console.log(USAGE); process.exitCode = name && name !== '--help' && name !== 'help' ? 2 : 0; return; }
  try { command(args); } catch (error) {
    if (error instanceof Refusal) {
      console.error(`crew: ${error.message}`);
      process.exitCode = error.exitCode;
      return;
    }
    // Anything else is a defect in crew. It is written down where a fixer will find it.
    const record = recordCrash(argv, error);
    console.error(`crew: internal error - ${error?.message ?? error}`);
    console.error(`This is a defect in crew itself, not in the task.${record ? ` Record: ${slash(record)}` : ''}`);
    console.error('To have it repaired: crew fix "<what you ran and what you expected>"');
    process.exitCode = 70;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
