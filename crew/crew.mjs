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

export const VERSION = '0.1.0';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WINDOWS = process.platform === 'win32';
// Everything of crew on a machine lives under ~/.crew: tool/ (this code, when installed from
// Herdr), home/ (the default crew home) and worktrees/ (workers' copies).
export const DEFAULT_HOME = path.join(os.homedir(), '.crew', 'home');

// --- agents ------------------------------------------------------------------
// The only per-agent knowledge: how to start it with one instruction, and how it can be
// asked to leave. `close` means the terminal is closed once the agent is no longer working.
// `args` follow the instruction: Claude Code reads a prompt placed after --allowedTools as
// one more tool name. A Claude worker keeps its permission system; it is only told up front
// that editing files and using its ordinary tools inside its own working copy is expected,
// so it does not stop to ask for each one. Folder trust: see trustClaudeFolder below.
export const AGENTS = {
  a1: { command: 'a1', exit: 'a1-api' },
  pi: { command: 'pi', exit: 'close' },
  claude: { command: 'claude', exit: 'close', trust: 'claude', args: ['--permission-mode', 'acceptEdits', '--allowedTools', 'Bash,Read,Edit,Write,Glob,Grep'] },
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
  return fs.existsSync(path.join(DEFAULT_HOME, 'crew.json')) ? DEFAULT_HOME : null;
}
function home() {
  const dir = findHome();
  if (!dir || !fs.existsSync(path.join(dir, 'crew.json'))) refuse('No crew home yet. Run `crew init` once (it creates ~/.crew/home), or `crew init <folder>` for a home elsewhere.');
  const config = readJson(path.join(dir, 'crew.json'));
  if (!config || config.version !== 1) refuse(`${path.join(dir, 'crew.json')} is not a version 1 crew home.`);
  // Working copies live OUTSIDE the home. Agents read instruction files from their folder
  // upwards, so a worker inside the home would load the coordinator's rules and act as one.
  const worktrees = path.join(process.env.CREW_WORKTREES || path.join(os.homedir(), '.crew', 'worktrees'), String(config.tag));
  return { dir, config, tasks: path.join(dir, 'tasks'), worktrees, owner: path.join(dir, 'owner.json') };
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
   - \`ship\`: changes code on a branch of its own.
   - Independent tasks may be spawned one after another without waiting; they run together.
2. \`crew wait <id> [<id>...]\` blocks until each worker reports (or fails). It prints the reports.
3. Tell the person the result in your own words. Do not paste the whole report unless asked.
4. \`crew finish <id>\` stops the worker and removes its terminal and working copy.
   Finish only after the person has their answer; never finish a task that is still working
   unless they asked you to cancel it.

## Rules
- Never work in a worker's copy yourself and never edit a project directly.
- \`crew wait\` saying a worker needs a person: tell the person which terminal is waiting and
  why; do not finish it. Wait again once they have answered.
- A worker that failed or went quiet: read \`crew status\`, look at its terminal with
  \`hc read <terminal> --lines 80\`, then either spawn a fresh worker or tell the person.
- \`crew project list\` shows the projects you may use. Ask before adding one.
- When you are done for the session, run \`crew end\`.
`;

function cmdInit(args) {
  const dir = args[0] ? path.resolve(args[0]) : DEFAULT_HOME;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'crew.json');
  if (fs.existsSync(file)) refuse(`${dir} is already a crew home.`);
  fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true });
  writeJson(file, { version: 1, tag: Math.random().toString(16).slice(2, 10), projects: {} });
  for (const [name, text] of [['AGENTS.md', COORDINATOR_RULES], ['CLAUDE.md', '@AGENTS.md\n']]) {
    if (!fs.existsSync(path.join(dir, name))) fs.writeFileSync(path.join(dir, name), text);
  }
  console.log(`crew home created: ${slash(dir)}`);
}

function cmdProject(args) {
  const h = home();
  const [verb, name, source] = args;
  if (verb === 'list' || !verb) {
    for (const [key, p] of Object.entries(h.config.projects)) console.log(`${key}\t${p.path}`);
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
  if (verb !== 'add' || !validId(name) || !source || source.startsWith('--')) refuse('Usage: crew project add <name> <git folder> [--replace] | crew project remove <name> | crew project list');
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
  h.config.projects[name] = { path: slash(folder) };
  writeJson(path.join(h.dir, 'crew.json'), h.config);
  console.log(`project ${name}: ${slash(folder)}`);
}

function cmdStart() {
  const h = home();
  const mine = me();
  if (!mine) refuse('crew start must run inside a Herdr terminal (no HC_TERMINAL_ID).', 3);
  const { owner, live, unknown } = ownerState(h);
  if (owner && unknown && owner.terminal !== mine) refuse(`${CORE_SILENT} the owner terminal ${owner.terminal}, so this home was not taken over. Try again.`, 4);
  if (owner && live && owner.terminal !== mine) refuse(`Read-only: this home is owned by live terminal ${owner.terminal}.`, 3);
  writeJson(h.owner, { terminal: mine, since: now(), previous: owner && owner.terminal !== mine ? owner.terminal : undefined });
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

export function briefText({ id, kind, task, worktree, project, report }) {
  return [
    `# Task ${id} (${kind})`, '', task.trim(), '',
    '## Rules',
    `- Work only inside \`${worktree}\`. It is your own copy of the project \`${project}\`; nobody else uses it.`,
    kind === 'scout'
      ? '- This is a read-only investigation: do not change project files, commit, push or open a pull request.'
      : '- Make your changes on the branch already checked out here and commit them. Do not push or open a pull request unless the task says so.',
    `- When you are finished, write your result to \`${report}\` in Markdown, with the answer in the first lines.`,
    `- Then run \`crew done ${id}\` and stop. Do not start any other work.`,
    '- If you cannot finish, write what blocked you to the same file and still run the command.', '',
  ].join('\n');
}

function cmdSpawn(args) {
  const h = home();
  requireOwner(h);
  const opts = { kind: 'scout', agent: 'a1' }, rest = [];
  for (let i = 0; i < args.length; i++) {
    const m = /^--(project|kind|agent)$/.exec(args[i]);
    if (m) opts[m[1]] = args[++i]; else rest.push(args[i]);
  }
  const [id, ...words] = rest;
  const task = words.join(' ').trim();
  if (!validId(id) || !task) refuse('Usage: crew spawn <id> --project <name> [--kind scout|ship] [--agent a1|pi|claude] "<task>"');
  if (!['scout', 'ship'].includes(opts.kind)) refuse(`Unknown kind: ${opts.kind}`);
  const agent = AGENTS[opts.agent] ?? refuse(`Unknown agent: ${opts.agent}. Known: ${Object.keys(AGENTS).join(', ')}`);
  const project = h.config.projects[opts.project] ?? refuse(`Unknown project: ${opts.project}. See \`crew project list\`.`);
  if (fs.existsSync(taskDir(h, id))) refuse(`Task ${id} already exists.`);

  const dir = taskDir(h, id), worktree = slash(path.join(h.worktrees, id)), report = slash(path.join(dir, 'report.md')), brief = slash(path.join(dir, 'brief.md'));
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(h.worktrees, { recursive: true });
  const record = { id, kind: opts.kind, agent: opts.agent, project: opts.project, state: 'preparing', created: now(), worktree, report, brief, terminal: null };
  saveTask(h, record);

  const wt = opts.kind === 'ship'
    ? run('git', ['-C', project.path, 'worktree', 'add', '-b', `crew/${id}`, worktree, 'HEAD'])
    : run('git', ['-C', project.path, 'worktree', 'add', '--detach', worktree, 'HEAD']);
  if (wt.code !== 0) { saveTask(h, { ...record, state: 'failed', error: wt.stderr.trim().slice(0, 400) }); refuse(`Could not create the working copy: ${wt.stderr.trim()}`, 5); }
  fs.writeFileSync(brief, briefText({ id, kind: opts.kind, task, worktree, project: opts.project, report }));

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
    '--label', `crew.task=${id}`, '--label', `crew.home=${tag}`,
    '--label', `herdr.space=fm-crew-${tag}`, '--label', `herdr.tab=${tag}-${id}`, '--label', 'herdr.right-click=menu',
    '--', bashProgram(), '--login', '-i', '-c', line]);
  const address = started.value?.address;
  if (started.code !== 0 || !address) {
    run('git', ['-C', project.path, 'worktree', 'remove', '--force', worktree]);
    saveTask(h, { ...record, state: 'failed', error: JSON.stringify(started.value).slice(0, 400) });
    refuse(`Core did not start the worker terminal: ${JSON.stringify(started.value)}`, 5);
  }
  // The worker is already running and may have reported before this line (a fast failure
  // report, or a slow answer from Core). Add the terminal to what is on disk now rather than
  // writing the record this command started with over an accepted report.
  const current = readJson(taskFile(h, id)) ?? record;
  saveTask(h, { ...current, state: current.state === 'reported' ? 'reported' : 'working', terminal: address, spawned: now() });
  console.log(`spawned ${id}: ${opts.agent} ${opts.kind} in terminal ${address}, working copy ${worktree}`);
}

function cmdDone(args) {
  const h = home();
  const id = args[0] ?? process.env.CREW_TASK;
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
  const task = loadTask(h, id);
  const result = stopWorker(task, { force });
  if (result.stopped && task.state !== 'closed') saveTask(h, { ...loadTask(h, id), state: task.state === 'reported' ? 'reported' : 'stopped', stopped: now() });
  console.log(`${result.stopped ? 'stopped' : 'not stopped'} ${id}: ${result.how}`);
  if (!result.stopped) process.exitCode = 6;
}

function cmdFinish(args) {
  const h = home();
  requireOwner(h);
  const force = args.includes('--force'), id = args.find(a => !a.startsWith('--'));
  const task = loadTask(h, id);
  if (task.state === 'closed') { console.log(`${id} is already closed`); return; }
  const result = stopWorker(task, { force });
  if (!result.stopped) refuse(`Task ${id} could not be stopped (${result.how}); nothing was removed.`, 6);
  const project = h.config.projects[task.project];
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
  for (let i = 0; fs.existsSync(task.worktree) && i < 8; i++) {
    if (project) removal = run('git', ['-C', project.path, 'worktree', 'remove', '--force', task.worktree]);
    if (!fs.existsSync(task.worktree)) break;
    const detached = !project || /is not a working tree/i.test(removal.stderr);
    if (detached || force) { try { fs.rmSync(task.worktree, { recursive: true, force: true }); } catch { /* still held: retry */ } }
    if (fs.existsSync(task.worktree)) sleep(1000);
  }
  if (project) run('git', ['-C', project.path, 'worktree', 'prune']);
  if (AGENTS[task.agent]?.trust === 'claude') forgetClaudeFolder(task.worktree);
  // An emptied folder that something still sits in (a helper process the agent left behind)
  // is not worth failing for: the work is gone from disk and from git; say so and move on.
  let leftover = '';
  if (fs.existsSync(task.worktree)) {
    if (fs.readdirSync(task.worktree).length) refuse(`The terminal is closed, but the working copy is still in use and could not be removed: ${task.worktree}`, 6);
    leftover = `; its empty folder is still held by another process (${task.worktree})`;
  }
  saveTask(h, { ...task, state: 'closed', closed: now(), outcome: task.state === 'reported' ? 'reported' : task.state });
  console.log(`finished ${id} (${result.how}); report kept at ${task.report}${leftover}`);
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
      report: fs.existsSync(t.report) ? t.report : null, error: t.error ?? null, elapsedSeconds: taskElapsedSeconds(t, currentTime) };
  });
  if (json) { console.log(JSON.stringify({ home: slash(h.dir), owner: owner ? { terminal: owner.terminal, live, mine } : null, tasks })); return; }
  console.log(`home ${slash(h.dir)} - ${owner ? `owner ${owner.terminal}${mine ? ' (you)' : live ? ' (live, you are read-only)' : ' (gone)'}` : 'no owner'}`);
  if (!tasks.length) console.log(all ? 'no tasks' : 'no unfinished tasks');
  for (const t of tasks) console.log(`${t.id}\t${t.state}\t${t.kind}/${t.agent}\t${t.project}\t${t.terminal ?? '-'}${t.core ? ` (${t.core.status ?? t.core.state})` : ''}\t${formatDuration(t.elapsedSeconds)}${t.error ? `\t${t.error}` : ''}`);
}

const COMMANDS = { init: cmdInit, project: cmdProject, start: cmdStart, end: cmdEnd, spawn: cmdSpawn, done: cmdDone, wait: cmdWait, stop: cmdStop, finish: cmdFinish, status: cmdStatus };
const USAGE = `crew ${VERSION} - a small crew tool on Herdr Core
  crew init [folder]                       create a crew home (default ~/.crew/home)
  crew project add <name> <git folder>     register a project   (crew project list)
  crew project remove <name>               forget a project with no unfinished tasks
  crew start | crew end                    take or release the home for this session
  crew spawn <id> --project <name> [--kind scout|ship] [--agent ${Object.keys(AGENTS).join('|')}] "<task>"
  crew wait <id>... [--timeout seconds]    block until each worker reports
  crew status [--all] [--json]             tasks and their terminals
  crew stop <id> [--force]                 ask the worker to leave
  crew finish <id> [--force]               stop it, remove its terminal and working copy
  crew done [<id>]                         (worker) my report is written`;

export function main(argv) {
  const [name, ...args] = argv;
  if (name === '--version') { console.log(VERSION); return; }
  const command = COMMANDS[name];
  if (!command) { console.log(USAGE); process.exitCode = name && name !== '--help' && name !== 'help' ? 2 : 0; return; }
  try { command(args); } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    console.error(`crew: ${error.message}`);
    process.exitCode = error.exitCode;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
