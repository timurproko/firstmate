#!/usr/bin/env node
// crew - a small, agent-agnostic crew tool on Herdr Core.
//
// One coordinator agent owns a crew home and calls these commands; each worker is an
// ordinary agent in its own Core terminal and its own git worktree. Everything is one
// short process talking to Core through `hc`; there is no watcher, no hook and no
// background service. See crew/README.md for the design and its limits.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION = '0.7.0';
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
// PowerShell is in the list beside Bash: on Windows Claude Code runs its commands through
// that tool, and without it every command (`crew done` included) waits for a person.
export const AGENTS = {
  a1: { command: 'a1', exit: 'a1-api' },
  pi: { command: 'pi', exit: 'close' },
  claude: { command: 'claude', exit: 'close', trust: 'claude', args: ['--permission-mode', 'acceptEdits', '--allowedTools', 'Bash,PowerShell,Read,Edit,Write,Glob,Grep'] },
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
1. \`crew spawn <id> --project <name> --kind scout|ship --agent a1 "<task for the worker>"\`
   - \`scout\`: read-only investigation, ends with a written report.
   - \`ship\`: changes code on a branch of its own, \`<type>/<id>\`. Say what the work is with
     \`--type feature|fix|refactor|docs|test|chore|style\` (default \`feature\`).
   - Independent tasks may be spawned one after another without waiting; they run together.
2. \`crew wait <id> [<id>...]\` blocks until each worker reports (or fails). It prints the reports.
3. Tell the person the result in your own words. Do not paste the whole report unless asked.
4. \`crew finish <id>\` stops the worker and removes its terminal and working copy.
   Finish only after the person has their answer; never finish a task that is still working
   unless they asked you to cancel it.

## Code changes (ship tasks)
1. After the worker reported, have the change checked unless it is trivial:
   \`crew review <id>\` starts a reviewer (\`--agent\` picks another agent for a second opinion);
   \`crew wait <id>-review\`. Its report starts with \`APPROVE\` or \`CHANGES NEEDED\`.
2. On \`CHANGES NEEDED\`: \`crew tell <id> "<the defects, as the reviewer wrote them>"\`, then
   \`crew wait <id>\` and review again. After two rounds that still fail, tell the person.
3. \`crew land <id>\` pushes the branch and opens a pull request. Give the person the link.
   Never merge a project's pull request yourself unless the person told you to.
4. Finish the reviewer and the task once the pull request is open.
- \`crew tell <id> "<message>"\` is also how you answer a worker's question or correct its
  course; the worker reports again when it has dealt with it.

## Rules
- Never work in a worker's copy yourself and never edit a project directly.
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
- **Quota** (\`quota-axi\`): before starting several workers at once, run \`quota-axi\` and give
  the work to an agent whose account has room (\`--agent\`). Skip it for a single small task.
- **GitHub** (\`gh-axi\`): read issues, pull requests and checks with it. \`crew land\` opens
  pull requests itself.
- **Browser** (\`chrome-devtools-axi\`): for looking at a web page. Workers are told about it.
- **Showing instead of telling** (\`lavish-axi\`): when the person must choose between several
  options, or a report is long, write it as a page (\`lavish-axi --help\` says how) and open
  it with \`crew show <page.html>\`, never with \`lavish-axi <page.html>\` directly: the person
  may be at another machine, and \`crew show\` also puts a Lavish link in the status bar of
  your terminal, and Herdr opens the page in their browser where they are. Say that it is open. Wait for
  their answer with \`lavish-axi poll <page.html>\`. A yes-or-no question stays in chat.
- **treehouse**: a project added with \`crew project add <name> <folder> --treehouse\` gives
  its workers prepared copies from the treehouse pool. Nothing else changes for you.
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
    for (const [key, p] of Object.entries(h.config.projects)) console.log(`${key}\t${p.path}${p.worktrees ? `\t${p.worktrees}` : ''}`);
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
    delete h.config.projects[name];
    writeJson(path.join(h.dir, 'crew.json'), h.config);
    console.log(`project ${name} removed (its folder is untouched)`);
    return;
  }
  if (verb !== 'add' || !validId(name) || !source || source.startsWith('--')) refuse('Usage: crew project add <name> <git folder> [--replace] [--treehouse] [--gate-skip <steps>|none] | crew project remove <name> | crew project list');
  const pooled = args.includes('--treehouse');
  // Which steps of the no-mistakes gate are left out for this project (see gateSkipOf).
  const skipAt = args.indexOf('--gate-skip'), skipText = skipAt < 0 ? null : String(args[skipAt + 1] ?? '');
  const gateSkip = skipText === null ? null : skipText === 'none' ? [] : skipText.split(',').map(s => s.trim()).filter(Boolean);
  if (gateSkip && (!skipText || gateSkip.some(s => !GATE_STEPS.includes(s)))) refuse(`--gate-skip takes ${GATE_STEPS.join(', ')} (comma-separated), or none. Push and pull request cannot be skipped: they are the delivery.`);
  if (pooled && !toolPath('treehouse')) refuse('treehouse is not installed on this machine (Herdr: Settings > Plugins > Crew).', 4);
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
  }
  h.config.projects[name] = { path: slash(folder), ...(pooled ? { worktrees: 'treehouse' } : {}), ...(gateSkip ? { gateSkip } : {}) };
  writeJson(path.join(h.dir, 'crew.json'), h.config);
  console.log(`project ${name}: ${slash(folder)}${pooled ? ' (working copies from treehouse)' : ''}${gateSkip ? ` (gate skips: ${gateSkip.join(', ') || 'nothing'})` : ''}`);
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

// The shell words that start an agent with one instruction. For Claude Code a saved account
// can be chosen with CREW_CLAUDE_ACCOUNT (set by the Herdr plugin, or by hand): the worker is
// then started through the account-switcher launcher as that account, exactly as the
// person's own `claude` wrapper does plus `--as`. Without the variable, or without that
// launcher on the machine, plain `claude` runs (the wrapper's default account).
export function agentCommand(name, agent, instruction, env = process.env) {
  const plain = [agent.command, instruction, ...(agent.args ?? [])].map(shq).join(' ');
  const account = name === 'claude' ? String(env.CREW_CLAUDE_ACCOUNT ?? '').trim() : '';
  if (!account) return plain;
  if (!/^[A-Za-z0-9._@+-]{1,100}$/.test(account)) refuse(`Not an account name: ${account}`);
  const launcher = env.CREW_CLAUDE_LAUNCHER || path.join(os.homedir(), '.claude', 'plugins-local', 'account-switcher', 'bin', 'claude-as.sh');
  if (!fs.existsSync(launcher)) {
    console.error(`crew: CREW_CLAUDE_ACCOUNT is set, but the account launcher is not on this machine (${slash(launcher)}); starting Claude Code on its default account.`);
    return plain;
  }
  return `bash --noprofile --norc ${shq(bashPath(launcher))} --as ${shq(account)} --command "$(type -P claude || type -P claude.exe)" -- ${[instruction, ...(agent.args ?? [])].map(shq).join(' ')}`;
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
  { id: 'quota-axi', crew: 'the coordinator checks which agent has room before a batch' },
  { id: 'treehouse', crew: 'worker copies of a project added with --treehouse come from its pool' },
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

export function briefText({ id, kind, task, worktree, project, report, tools = [], gate = null, gateSkip = [] }) {
  const skip = gateSkip.length ? ` --skip ${gateSkip.join(',')}` : '', watched = !gateSkip.includes('ci');
  const hints = TOOLS.filter(t => t.brief && tools.includes(t.id)).map(t => `- ${t.brief}`);
  return [
    `# Task ${id} (${kind})`, '', task.trim(), '',
    '## Rules',
    `- Work only inside \`${worktree}\`. It is your own copy of the project \`${project}\`; nobody else uses it.`,
    kind === 'scout'
      ? '- This is a read-only investigation: do not change project files, commit, push or open a pull request.'
      : gate
        ? '- Make your changes on the branch already checked out here and commit them.'
        : '- Make your changes on the branch already checked out here and commit them. Do not push or open a pull request unless the task says so.',
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
  const opts = { kind: 'scout', agent: 'a1' }, rest = [];
  for (let i = 0; i < args.length; i++) {
    const m = /^--(project|kind|agent|type)$/.exec(args[i]);
    if (m) opts[m[1]] = args[++i]; else rest.push(args[i]);
  }
  const [id, ...words] = rest;
  const task = words.join(' ').trim();
  if (!validId(id) || !task) refuse('Usage: crew spawn <id> --project <name> [--kind scout|ship] [--type feature|fix|...] [--agent a1|pi|claude] "<task>"');
  if (!['scout', 'ship'].includes(opts.kind)) refuse(`Unknown kind: ${opts.kind}`);
  if (opts.type !== undefined && (opts.kind !== 'ship' || !BRANCH_TYPES.includes(opts.type))) refuse(opts.kind !== 'ship' ? 'Only a ship task has a branch, so only it takes --type.' : `Unknown type: ${opts.type}. Known: ${BRANCH_TYPES.join(', ')}`);
  const agent = AGENTS[opts.agent] ?? refuse(`Unknown agent: ${opts.agent}. Known: ${Object.keys(AGENTS).join(', ')}`);
  const project = h.config.projects[opts.project] ?? refuse(`Unknown project: ${opts.project}. See \`crew project list\`.`);
  if (fs.existsSync(taskDir(h, id))) refuse(`Task ${id} already exists.`);
  launchWorker(h, { id, opts, agent, project, task });
}

// Creates the task, its working copy and its terminal. `extra` is kept on the task record.
function launchWorker(h, { id, opts, agent, project, task, extra = {} }) {
  const dir = taskDir(h, id), report = slash(path.join(dir, 'report.md')), brief = slash(path.join(dir, 'brief.md'));
  let worktree = slash(path.join(h.worktrees, id));
  const branch = opts.kind === 'ship' ? `${extra.selfFix ? 'fix' : opts.type ?? 'feature'}/${id}` : null;
  // A project added with --treehouse takes its copies from the treehouse pool (already set
  // up, dependencies and all) instead of a fresh git worktree.
  const pool = project.worktrees === 'treehouse' ? 'treehouse' : null;
  if (pool && !toolPath('treehouse')) refuse(`Project ${opts.project} takes its working copies from treehouse, which is not installed on this machine.`, 5);
  // A project with the no-mistakes gate (its `no-mistakes` remote) is delivered through it.
  const gated = opts.kind === 'ship' && !extra.selfFix && toolPath('no-mistakes') && run('git', ['-C', project.path, 'remote', 'get-url', 'no-mistakes']).code === 0;
  const intent = gated ? slash(path.join(dir, 'intent.md')) : null;
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(h.worktrees, { recursive: true });
  let record = { id, kind: opts.kind, agent: opts.agent, project: opts.project, state: 'preparing', created: now(), worktree, report, brief, terminal: null,
    ...(branch ? { branch } : {}), ...(pool ? { pool } : {}), ...(gated ? { gate: 'no-mistakes' } : {}), ...extra };
  saveTask(h, record);

  const failed = why => { saveTask(h, { ...record, state: 'failed', error: why.slice(0, 400) }); refuse(`Could not create the working copy: ${why}`, 5); };
  if (pool) {
    const got = runTool('treehouse', ['get', '--lease', '--json', ...(branch ? ['-b', branch] : [])], { cwd: project.path, timeout: 600000 });
    let leased = null;
    try { leased = JSON.parse(got.stdout).path; } catch { /* reported below */ }
    if (got.code !== 0 || !leased) failed(`treehouse gave no working copy (${lastLine(got.stderr || got.stdout)})`);
    worktree = slash(leased);
    record = { ...record, worktree };
    saveTask(h, record);
  } else {
    const wt = branch
      ? run('git', ['-C', project.path, 'worktree', 'add', '-b', branch, worktree, 'HEAD'])
      : run('git', ['-C', project.path, 'worktree', 'add', '--detach', worktree, 'HEAD']);
    if (wt.code !== 0) failed(wt.stderr.trim());
  }
  if (intent) fs.writeFileSync(intent, `${task.trim()}\n`);
  fs.writeFileSync(brief, briefText({ id, kind: opts.kind, task, worktree, project: opts.project, report, tools: installedTools(), gate: intent, gateSkip: gateSkipOf(project) }));

  if (agent.trust === 'claude' && !trustClaudeFolder(worktree)) console.error('crew: could not record the working copy as trusted for Claude Code; it may stop at its trust question.');
  // The agent starts with one instruction as its argument, so nothing is typed into it and
  // there is no race with its startup. The shell stays afterwards so the terminal survives
  // the agent leaving; `crew finish` removes it.
  const instruction = `Read the brief at ${brief} and carry it out exactly.`;
  const line = [
    `export CREW_HOME=${shq(bashPath(h.dir))} CREW_TASK=${shq(id)} PATH=${shq(`${bashPath(path.join(HERE, 'bin'))}`)}:"$PATH"`,
    agentCommand(opts.agent, agent, instruction),
    'exec bash --login -i',
  ].join('; ');
  const tag = h.config.tag;
  const started = hcJson(['run', '--json', '--bg', '--keep', '--no-parent', '--no-notify', '--cwd', worktree,
    // crew.kind is what the worker is, for anything that shows terminals (Herdr's pane header).
    '--label', `crew.task=${id}`, '--label', `crew.home=${tag}`, '--label', `crew.kind=${extra.selfFix ? 'fix' : extra.reviews ? 'review' : opts.kind}`,
    '--label', `herdr.space=fm-crew-${tag}`, '--label', `herdr.tab=${tag}-${id}`, '--label', 'herdr.right-click=menu',
    '--', bashProgram(), '--login', '-i', '-c', line]);
  const address = started.value?.address;
  if (started.code !== 0 || !address) {
    if (pool) runTool('treehouse', ['return', worktree], { cwd: project.path, timeout: 120000 });
    else run('git', ['-C', project.path, 'worktree', 'remove', '--force', worktree]);
    saveTask(h, { ...record, state: 'failed', error: JSON.stringify(started.value).slice(0, 400) });
    refuse(`Core did not start the worker terminal: ${JSON.stringify(started.value)}`, 5);
  }
  // The worker is already running and may have reported before this line (a fast failure
  // report, or a slow answer from Core). Add the terminal to what is on disk now rather than
  // writing the record this command started with over an accepted report.
  const current = readJson(taskFile(h, id)) ?? record;
  saveTask(h, { ...current, state: current.state === 'reported' ? 'reported' : 'working', terminal: address, spawned: now() });
  console.log(`spawned ${id}: ${opts.agent} ${opts.kind} in terminal ${address}, working copy ${worktree}${pool ? ' (treehouse)' : ''}${gated ? '; delivered through no-mistakes' : ''}`);
  backlogMove(h, id, 'start');
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
  saveTask(h, { ...task, state: 'reported', reported: now() });
  console.log(`reported ${id}. You are finished; stop here.`);
}

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function cmdWait(args) {
  const h = home();
  let timeout = 1800;
  const ids = [];
  for (let i = 0; i < args.length; i++) { if (args[i] === '--timeout') timeout = Number(args[++i]) || timeout; else ids.push(args[i]); }
  if (!ids.length) refuse('Usage: crew wait <id> [<id>...] [--timeout seconds]');
  ids.forEach(id => loadTask(h, id));
  const deadline = Date.now() + timeout * 1000, settled = new Map(), blocked = new Map();
  for (let tick = 0; settled.size < ids.length && Date.now() < deadline; tick++) {
    for (const id of ids) {
      if (settled.has(id)) continue;
      const task = loadTask(h, id);
      if (['reported', 'stopped', 'closed', 'failed'].includes(task.state)) { settled.set(id, task.state); continue; }
      // Every few seconds ask Core whether the terminal still exists; a worker that is gone
      // without a report has failed, whatever the reason.
      if (tick % 5 !== 4 || !task.terminal) continue;
      const { state: seen, t } = probe(task.terminal);
      if (seen === 'unknown') continue; // Core did not answer: that says nothing about the worker
      if (seen !== 'live') {
        saveTask(h, { ...task, state: 'failed', error: 'The worker terminal ended without a report.' });
        settled.set(id, 'failed');
      } else if (t.status?.state === 'blocked') {
        // The agent itself says it is waiting for a person (a permission or a question).
        // Waiting longer cannot help; hand that back so somebody looks at the terminal.
        blocked.set(id, String(t.status.msg ?? t.status.kind ?? 'it is waiting for an answer').slice(0, 120));
        settled.set(id, 'needs a person');
      }
    }
    if (settled.size < ids.length) sleep(1000);
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
function stopWorker(task, { force = false } = {}) {
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
      for (let i = 0; i < 15; i++) {
        if (a1Api('session.lifecycle', target)?.error?.code === 'session-unavailable') return { stopped: true, how: 'a1 exit api' };
        sleep(1000);
      }
      return { stopped: false, how: 'a1 admitted the exit but is still there' };
    }
    if (!force) refuse(`A1 refused to exit (${reply?.error?.code ?? 'no answer'}). Nothing was closed.`, 6);
  }
  // Every other agent (and a forced stop of an A1 that would not leave) is stopped by ending
  // the terminal's program, then asking Core again: only a terminal seen finished or gone
  // counts.
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
  if (task.kind !== 'ship' || task.selfFix || !project?.path) return '';
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

function cmdFinish(args) {
  const h = home();
  requireOwner(h);
  const force = args.includes('--force'), id = args.find(a => !a.startsWith('--'));
  if (!id) refuse('Usage: crew finish <id> [--force]');
  const task = loadTask(h, id);
  if (task.state === 'closed') { console.log(`${id} is already closed`); return; }
  const result = stopWorker(task, { force });
  if (!result.stopped) refuse(`Task ${id} could not be stopped (${result.how}); nothing was removed.`, 6);
  // A self-fix works on crew's own source, which is not a registered project.
  const project = task.projectPath ? { path: task.projectPath } : h.config.projects[task.project];
  // Work that exists only in the working copy is lost when the copy goes: a ship task's
  // branch keeps commits, nothing keeps uncommitted or untracked files. So a ship task
  // with such files is not cleaned up unless discarding them was asked for. (A scout is
  // read-only by its brief; what it leaves behind is scratch.)
  if (task.kind === 'ship' && !force && fs.existsSync(path.join(task.worktree, '.git'))) {
    const dirty = run('git', ['-C', task.worktree, 'status', '--porcelain']);
    if (dirty.code !== 0) refuse(`Could not check ${task.worktree} for uncommitted work; nothing was removed. Pass --force to discard it unseen.`, 6);
    const files = dirty.stdout.split(/\r?\n/).filter(Boolean);
    if (files.length) refuse(`Task ${id} has uncommitted work in ${task.worktree} (${files.slice(0, 5).map(l => l.slice(3)).join(', ')}${files.length > 5 ? ', …' : ''}). Nothing was removed. Commit it there, or pass --force to discard it.`, 6);
  }
  // A copy marked to keep (the shared delivery workflow's marker) is not removed unasked.
  if (!force && fs.existsSync(path.join(task.worktree, '.artifacts', 'KEEP'))) refuse(`Task ${id} is marked to keep by .artifacts/KEEP in ${task.worktree}. Nothing was removed. Delete the marker, or pass --force.`, 6);
  if (task.terminal) {
    let seen = probe(task.terminal).state;
    if (seen === 'unknown') refuse(`${CORE_SILENT} terminal ${task.terminal}; the working copy was kept. Try again.`, 4);
    if (seen !== 'absent') { hc(['kill', task.terminal]); hc(['rm', task.terminal]); seen = probe(task.terminal).state; }
    if (seen !== 'absent') refuse(`Core ${seen === 'unknown' ? 'did not confirm that' : 'still has'} terminal ${task.terminal}${seen === 'unknown' ? ' is gone' : ''}; the working copy was kept.`, 6);
  }
  // Git removes the copy. A first try can fail while the closed terminal's processes let go
  // of the folder, so it is retried. The folder is deleted directly only when git no longer
  // knows it as a working copy (an earlier, half-finished removal) or with --force.
  let removal = { code: 0, stderr: '' };
  if (task.pool === 'treehouse') {
    // The copy is a pool slot: it goes back to treehouse, which cleans it and keeps it.
    // treehouse refuses a slot with loose files unless told to clean it. A scout's leftovers
    // are scratch, and --force is the person's word to discard; a ship task's unsaved work
    // without --force was refused above.
    const back = runTool('treehouse', ['return', ...(force || task.kind === 'scout' ? ['--force'] : []), task.worktree], { cwd: project?.path, timeout: 180000 });
    if (!back) refuse(`Task ${id} uses a treehouse working copy, and treehouse is not installed here; nothing was returned.`, 6);
    if (back.code !== 0 && fs.existsSync(task.worktree)) refuse(`treehouse did not take the working copy back (${lastLine(back.stderr || back.stdout)}); it was kept: ${task.worktree}`, 6);
    if (AGENTS[task.agent]?.trust === 'claude') forgetClaudeFolder(task.worktree);
    saveTask(h, { ...task, state: 'closed', closed: now(), outcome: task.state === 'reported' ? 'reported' : task.state });
    console.log(`finished ${id} (${result.how}); working copy returned to treehouse; report kept at ${task.report}${dropMergedBranch(project, task)}`);
    if (task.kind === 'scout' && task.state === 'reported') backlogMove(h, id, 'done');
    return;
  }
  for (let i = 0; fs.existsSync(task.worktree) && i < 8; i++) {
    if (project) removal = run('git', ['-C', project.path, 'worktree', 'remove', '--force', task.worktree]);
    if (!fs.existsSync(task.worktree)) break;
    const detached = !project || /is not a working tree/i.test(removal.stderr);
    if (detached || force) { try { fs.rmSync(task.worktree, { recursive: true, force: true }); } catch { /* still held: retry */ } }
    if (fs.existsSync(task.worktree)) sleep(1000);
  }
  if (project) run('git', ['-C', project.path, 'worktree', 'prune']);
  // A published self-fix is on main; its branch has nothing left to keep.
  if (task.selfFix && task.merged && !fs.existsSync(task.worktree)) run('git', ['-C', project.path, 'branch', '-D', branchOf(task)]);
  if (AGENTS[task.agent]?.trust === 'claude') forgetClaudeFolder(task.worktree);
  // An emptied folder that something still sits in (a helper process the agent left behind)
  // is not worth failing for: the work is gone from disk and from git; say so and move on.
  let leftover = '';
  if (fs.existsSync(task.worktree)) {
    if (fs.readdirSync(task.worktree).length) refuse(`The terminal is closed, but the working copy is still in use and could not be removed: ${task.worktree}`, 6);
    leftover = `; its empty folder is still held by another process (${task.worktree})`;
  }
  saveTask(h, { ...task, state: 'closed', closed: now(), outcome: task.state === 'reported' ? 'reported' : task.state });
  console.log(`finished ${id} (${result.how}); report kept at ${task.report}${leftover}${fs.existsSync(task.worktree) ? '' : dropMergedBranch(project, task)}`);
  if (task.kind === 'scout' && task.state === 'reported' && !task.reviews) backlogMove(h, id, 'done');
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
  let agentName = null; const rest = [];
  for (let i = 0; i < args.length; i++) { if (args[i] === '--agent') agentName = args[++i]; else rest.push(args[i]); }
  const id = rest[0];
  if (!id) refuse(`Usage: crew review <id> [--agent ${Object.keys(AGENTS).join('|')}]`);
  const task = loadTask(h, id);
  if (task.kind !== 'ship' || task.selfFix) refuse(`Task ${id} is not a ship task of a project; only those have a branch to review.`);
  if (task.state !== 'reported') refuse(`Task ${id} is ${task.state}; review it after its worker reported.`);
  const project = h.config.projects[task.project] ?? refuse(`Unknown project: ${task.project}.`);
  const opts = { kind: 'scout', agent: agentName ?? process.env.CREW_REVIEW_AGENT ?? task.agent, project: task.project };
  const agent = AGENTS[opts.agent] ?? refuse(`Unknown agent: ${opts.agent}. Known: ${Object.keys(AGENTS).join(', ')}`);
  let n = 1, reviewId = `${id}-review`.slice(0, 40);
  while (fs.existsSync(taskDir(h, reviewId))) reviewId = `${id.slice(0, 30)}-review-${++n}`;
  const text = [
    `Review the work of task ${id}. It is the branch \`${branchOf(task)}\` of this repository; you are on the commit it started from.`,
    '', `- See it with \`git log HEAD..${branchOf(task)}\` and \`git diff HEAD...${branchOf(task)}\`. Read the changed files whole where the diff is not enough.`,
    `- What it was asked to do is in \`${task.brief}\`; what its author says it did is in \`${task.report}\`.`,
    '- Look for defects: wrong behaviour, missed cases, broken or missing tests, changes beyond the task. Run the project\'s tests if that is cheap. Ignore style.',
    '- Start your report with one line: `APPROVE` or `CHANGES NEEDED`. Then each defect with file and line, what goes wrong, and how to see it. No defect, no text.',
  ].join('\n');
  launchWorker(h, { id: reviewId, opts, agent, project, task: text, extra: { reviews: id } });
  console.log(`next: crew wait ${reviewId}; on CHANGES NEEDED: crew tell ${id} "<the defects>", wait, and review again`);
}

// land: hand a finished ship task to the person as a pull request. Merging stays with them.
export const githubOwner = url => /github\.com[:/]+([^/]+)\/[^/]+?(?:\.git)?\/?$/.exec(String(url).trim())?.[1] ?? null;
const GH = process.env.CREW_GH || 'gh';
const gh = (args, options) => (GH.endsWith('.mjs') ? run(process.execPath, [GH, ...args], options) : run(GH, args, options));
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
  if (task.pr) { console.log(`${id} already has a pull request: ${task.pr}`); return; }
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
    const reported = fs.existsSync(task.report) ? /https:\/\/[^\s)>\]]+\/pulls?\/\d+/.exec(fs.readFileSync(task.report, 'utf8'))?.[0] : null;
    const asked = reported ? null : gh(['pr', 'view', git('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim(), '--json', 'url', '--jq', '.url'], { cwd: wt, timeout: 60000 });
    const found = reported ?? /https?:\/\/\S+/.exec(asked?.stdout ?? '')?.[0];
    if (!found) no(`the no-mistakes gate has not opened a pull request for it yet. Ask the worker where the gate stands: crew tell ${id} "run no-mistakes axi status and finish the gate"`);
    saveTask(h, { ...loadTask(h, id), pr: found, landed: now() });
    console.log(`delivered ${id} through no-mistakes: ${found}. Merging it is the person's decision.`);
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
  const owner = githubOwner(remote.stdout), token = owner ? gh(['auth', 'token', '--user', owner]) : null;
  const env = token?.code === 0 && token.stdout.trim() ? { ...process.env, GH_TOKEN: token.stdout.trim() } : process.env;
  const made = gh(['pr', 'create', '--base', base, '--head', `${branchOf(task)}`, '--title', title || subjects[0], '--body-file', bodyFile], { cwd: wt, env, timeout: 120000 });
  const url = /https?:\/\/\S+/.exec(made.stdout)?.[0];
  if (made.error || made.code !== 0 || !url) no(`its branch ${branchOf(task)} is pushed, but the pull request was not opened (${made.error?.message ?? lastLine(made.stderr || made.stdout)}). Run \`crew land ${id}\` again, or open it by hand.`, 4);
  saveTask(h, { ...loadTask(h, id), pr: url, landed: now() });
  console.log(`delivered ${id}: ${url} (against ${base}, ${subjects.length} commit${subjects.length === 1 ? '' : 's'}). Merging it is the person's decision.`);
  backlogMove(h, id, 'done', ['--pr', url]);
}

// --- crew maintains itself -------------------------------------------------------
// A defect in crew is repaired the way any other work is done: by a worker, on a branch, in
// its own copy - here a copy of crew's own source. `crew selfmerge` is the only gate between
// that branch and every machine, so it checks what it can check without a person: the change
// stays inside crew/, it sits on top of the published main, and the whole test suite passes.
// Machines pick the result up at their next `crew start`; `crew rollback` undoes it locally.
const TOOL_ROOT = slash(path.resolve(process.env.CREW_TOOL_ROOT || path.join(HERE, '..')));
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
  const opts = { kind: 'ship', agent: process.env.CREW_FIX_AGENT || 'a1', project: SELF_PROJECT }, words = [];
  for (let i = 0; i < args.length; i++) { if (args[i] === '--agent') opts.agent = args[++i]; else words.push(args[i]); }
  const problem = words.join(' ').trim();
  if (!problem) refuse(`Usage: crew fix [--agent ${Object.keys(AGENTS).join('|')}] "<what you ran, what happened, what you expected>"`);
  const agent = AGENTS[opts.agent] ?? refuse(`Unknown agent: ${opts.agent}. Known: ${Object.keys(AGENTS).join(', ')}`);
  if (!isClone()) refuse(`crew's own source (${TOOL_ROOT}) is not a git clone, so it cannot be repaired from here.`);
  // One repair at a time: two fixers on the same few files would only undo each other.
  const open = allTasks(h).filter(t => t.selfFix && t.state !== 'closed');
  if (open.length) refuse(`A repair is already open: ${open.map(t => `${t.id}[${t.state}]`).join(' ')}. Wait for it and merge or finish it first.`);
  let n = 1;
  while (fs.existsSync(taskDir(h, `fix-${n}`))) n++;
  const id = `fix-${n}`, crashes = recentCrashes();
  const task = [
    'Repair a defect in the crew tool itself. This working copy is crew\'s own source: the tool is `crew/crew.mjs`, its tests are `crew/crew.test.mjs`, its design is in `crew/README.md`.',
    '', '## The problem, as the coordinator saw it', problem,
    ...(crashes.length ? ['', '## Crash records from this machine (read them)', ...crashes.map(f => `- \`${slash(f)}\``)] : []),
    '', '## What to do',
    '1. Find the cause in `crew/crew.mjs`. Say so in the report if the problem is not a defect in crew.',
    '2. Add a check to `crew/crew.test.mjs` that fails because of the defect, then make the smallest change that fixes it.',
    '3. Change files under `crew/` only. A change anywhere else is rejected unseen.',
    '4. Run `node crew/crew.test.mjs` and keep going until it exits 0. The fix is published only if the whole suite passes.',
    '5. Commit on this branch. Do not push: the coordinator publishes it with `crew selfmerge`.',
    '6. In the report give the cause, the change and the new check, each in a line or two.',
  ].join('\n');
  launchWorker(h, { id, opts, agent, project: { path: TOOL_ROOT }, task, extra: { selfFix: true, projectPath: TOOL_ROOT, base: toolRevision() } });
  console.log(`next: crew wait ${id}, then crew selfmerge ${id}`);
}

function cmdSelfmerge(args) {
  const h = home();
  requireOwner(h);
  const id = args[0], task = loadTask(h, id);
  if (!task.selfFix) refuse(`Task ${id} is not a repair of crew; \`crew selfmerge\` publishes only those.`);
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
  const files = git('diff', '--name-only', 'origin/main', 'HEAD').stdout.split(/\r?\n/).filter(Boolean);
  if (!files.length) no('it changes nothing compared with the published main.');
  const outside = files.filter(f => !f.startsWith('crew/'));
  if (outside.length) no(`it changes files outside crew/ (${outside.slice(0, 5).join(', ')}). A repair may only touch crew's own folder.`);
  // The suite runs as it would on a clean machine: nothing of this session leaks into it.
  const command = process.env.CREW_SELFTEST || 'node crew/crew.test.mjs';
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CREW_|HC_TERMINAL_ID$)/i.test(key)));
  const tested = run(command, [], { shell: true, cwd: wt, env, timeout: 15 * 60 * 1000 });
  if (tested.code !== 0) no(`the test suite fails (${command}, exit ${tested.code ?? 'timeout'}):\n${`${tested.stdout}\n${tested.stderr}`.trim().split(/\r?\n/).slice(-12).join('\n')}`);
  const revision = git('rev-parse', 'HEAD').stdout.trim();
  // An ordinary push: if main moved in these seconds it is refused, and the next try rebases again.
  const pushed = git('push', '--quiet', 'origin', 'HEAD:main');
  if (pushed.code !== 0) no(`the push was refused (${lastLine(pushed.stderr)}). Run \`crew selfmerge ${id}\` again.`, 4);
  saveTask(h, { ...loadTask(h, id), merged: revision, mergedAt: now() });
  console.log(`published ${id} as ${short(revision)} (${files.length} file${files.length === 1 ? '' : 's'}: ${files.slice(0, 5).join(', ')}); tests passed`);
  const u = updateTool();
  console.log(u.changed ? `this machine now runs ${short(u.revision)} (was ${short(u.from)}); \`crew rollback\` goes back`
    : u.failed ? `this machine was not updated: ${u.note}. Run \`crew update\`.` : `this machine already runs ${short(u.revision)}`);
  console.log(`other machines update at their next \`crew start\`. Now: crew finish ${id}, then retry what failed.`);
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
    return { id: t.id, state: t.state, kind: t.kind, agent: t.agent, project: t.project, terminal: t.terminal,
      core: core ? { state: core.state, agent: core.status?.app ?? null, status: core.status?.state ?? null } : null,
      report: fs.existsSync(t.report) ? t.report : null, pr: t.pr ?? null, error: t.error ?? null, elapsedSeconds: taskElapsedSeconds(t, currentTime) };
  });
  if (json) { console.log(JSON.stringify({ home: slash(h.dir), owner: owner ? { terminal: owner.terminal, live, mine } : null, tasks })); return; }
  console.log(`home ${slash(h.dir)} - ${owner ? `owner ${owner.terminal}${mine ? ' (you)' : live ? ' (live, you are read-only)' : ' (gone)'}` : 'no owner'}`);
  if (!tasks.length) console.log(all ? 'no tasks' : 'no unfinished tasks');
  for (const t of tasks) console.log(`${t.id}\t${t.state}\t${t.kind}/${t.agent}\t${t.project}\t${t.terminal ?? '-'}${t.core ? ` (${t.core.status ?? t.core.state})` : ''}\t${formatDuration(t.elapsedSeconds)}${t.pr ? `\t${t.pr}` : ''}${t.error ? `\t${t.error}` : ''}`);
}

const COMMANDS = { init: cmdInit, project: cmdProject, start: cmdStart, end: cmdEnd, spawn: cmdSpawn, done: cmdDone, wait: cmdWait, stop: cmdStop, finish: cmdFinish, status: cmdStatus,
  home: cmdHome, tools: cmdTools, backlog: cmdBacklog, show: cmdShow, tell: cmdTell, review: cmdReview, land: cmdLand, fix: cmdFix, selfmerge: cmdSelfmerge, update: cmdUpdate, rollback: cmdRollback };
const USAGE = `crew ${VERSION} - a small crew tool on Herdr Core
  crew init [folder]                       create a crew home (default ~/.crew)
  crew project add <name> <git folder> [--treehouse] [--gate-skip <steps>|none]   register a project   (crew project list)
  crew project remove <name>               forget a project with no unfinished tasks
  crew start | crew end                    take or release the home for this session
  crew spawn <id> --project <name> [--kind scout|ship] [--type <type>] [--agent ${Object.keys(AGENTS).join('|')}] "<task>"
  crew wait <id>... [--timeout seconds]    block until each worker reports
  crew status [--all] [--json]             tasks and their terminals
  crew stop <id> [--force]                 ask the worker to leave
  crew finish <id> [--force]               stop it, remove its terminal, working copy and merged branch
  crew done [<id>]                         (worker) my report is written
  crew tell <id> "<message>"               send the worker a follow-up; it reports again
  crew review <id> [--agent <agent>]       start a reviewer on a ship task's branch
  crew land <id> [--title "<title>"]       push a ship task's branch and open a pull request
  crew tools [--json]                      Firstmate's tools on this machine and what crew does with each
  crew backlog [tasks-axi command...]      the durable list of work in this home (tasks-axi)
  crew show <page.html>                    open a page for the person (lavish-axi) with a link in Herdr's status bar
  crew fix [--agent <agent>] "<problem>"   start a worker that repairs crew itself
  crew selfmerge <id>                      publish that repair if it stays in crew/ and the tests pass
  crew update | crew rollback              bring this machine's crew up to date, or back one step`;

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
