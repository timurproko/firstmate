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
// A terminal as Core sees it now, or null when Core has no such terminal.
function terminal(address) {
  if (!address) return null;
  const { code, value } = hcJson(['get', '--json', address]);
  return code === 0 && value && !value.error ? value : null;
}
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
  const live = mine || terminal(owner.terminal)?.state === 'live';
  return { owner, live, mine };
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
- Never work inside \`worktrees/\` yourself and never edit a project directly.
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
  if (verb !== 'add' || !validId(name) || !source) refuse('Usage: crew project add <name> <git folder> | crew project list');
  const folder = path.resolve(source);
  const top = run('git', ['-C', folder, 'rev-parse', '--show-toplevel']);
  if (top.code !== 0) refuse(`${folder} is not a git repository.`);
  h.config.projects[name] = { path: slash(folder) };
  writeJson(path.join(h.dir, 'crew.json'), h.config);
  console.log(`project ${name}: ${slash(folder)}`);
}

function cmdStart() {
  const h = home();
  const mine = me();
  if (!mine) refuse('crew start must run inside a Herdr terminal (no HC_TERMINAL_ID).', 3);
  const { owner, live } = ownerState(h);
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
    [agent.command, instruction, ...(agent.args ?? [])].map(shq).join(' '),
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
  saveTask(h, { ...record, state: 'working', terminal: address, spawned: now() });
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
  const deadline = Date.now() + timeout * 1000, settled = new Map();
  for (let tick = 0; settled.size < ids.length && Date.now() < deadline; tick++) {
    for (const id of ids) {
      if (settled.has(id)) continue;
      const task = loadTask(h, id);
      if (['reported', 'stopped', 'closed', 'failed'].includes(task.state)) { settled.set(id, task.state); continue; }
      // Every few seconds ask Core whether the terminal still exists; a worker that is gone
      // without a report has failed, whatever the reason.
      if (tick % 5 === 4 && terminal(task.terminal)?.state !== 'live') {
        saveTask(h, { ...task, state: 'failed', error: 'The worker terminal ended without a report.' });
        settled.set(id, 'failed');
      }
    }
    if (settled.size < ids.length) sleep(1000);
  }
  let pending = 0;
  for (const id of ids) {
    const task = loadTask(h, id), state = settled.get(id);
    if (!state) { pending++; console.log(`== ${id}: still working after ${timeout}s (terminal ${task.terminal})`); continue; }
    console.log(`== ${id}: ${state}${task.error ? ` - ${task.error}` : ''}`);
    if (fs.existsSync(task.report)) console.log(fs.readFileSync(task.report, 'utf8').trim().split(/\r?\n/).slice(0, 60).join('\n'));
  }
  if (pending) process.exitCode = 124;
}

// A1's public integration API: exact session and runtime, admitted only when idle.
function a1Api(type, target) {
  const request = JSON.stringify({ version: 1, id: `crew-${process.pid}-${Date.now()}`, type, target: { scope: 'session', ...target } });
  // Through bash: a1 is an npm shim on Windows, and one single-quoted argument survives intact.
  const r = run(bashProgram(), ['-c', `a1 api ${shq(request)}`], { timeout: 20000, env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  try { return JSON.parse(r.stdout); } catch { return null; }
}
function stopWorker(task, { force = false } = {}) {
  let t = terminal(task.terminal);
  if (!t || t.state !== 'live') return { stopped: true, how: 'terminal already gone' };
  // A worker reports from inside its last turn; give that turn a moment to end before
  // deciding it is still busy.
  for (let i = 0; task.state === 'reported' && !force && t?.state === 'live' && t.status?.state === 'working' && i < (Number(process.env.CREW_SETTLE_SECONDS) || 45); i++) {
    sleep(1000);
    t = terminal(task.terminal);
  }
  if (!t || t.state !== 'live') return { stopped: true, how: 'terminal already gone' };
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
  return { stopped: true, how: working ? 'cancelled' : 'idle; terminal will be closed' };
}

function cmdStop(args) {
  const h = home();
  requireOwner(h);
  const force = args.includes('--force'), id = args.find(a => !a.startsWith('--'));
  const task = loadTask(h, id);
  const result = stopWorker(task, { force });
  if (result.stopped && task.state !== 'closed') saveTask(h, { ...task, state: task.state === 'reported' ? 'reported' : 'stopped', stopped: now() });
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
  if (task.terminal && terminal(task.terminal)) { hc(['kill', task.terminal]); hc(['rm', task.terminal]); }
  if (terminal(task.terminal)) refuse(`Core still has terminal ${task.terminal}; the working copy was kept.`, 6);
  const project = h.config.projects[task.project];
  // Removing a working copy can fail on the first try while the closed terminal's processes
  // let go of the folder, and a failed try may already have detached it from git. So: ask
  // git, and whatever it says, make sure the folder is gone and git's list is pruned.
  for (let i = 0; fs.existsSync(task.worktree) && i < 8; i++) {
    if (project) run('git', ['-C', project.path, 'worktree', 'remove', '--force', task.worktree]);
    if (fs.existsSync(task.worktree)) { try { fs.rmSync(task.worktree, { recursive: true, force: true }); } catch { sleep(1000); } }
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

function cmdStatus(args) {
  const h = home();
  const json = args.includes('--json'), all = args.includes('--all');
  const { owner, live, mine } = ownerState(h);
  const tasks = allTasks(h).filter(t => all || t.state !== 'closed').map(t => {
    const core = ['closed', 'failed'].includes(t.state) ? null : terminal(t.terminal);
    return { id: t.id, state: t.state, kind: t.kind, agent: t.agent, project: t.project, terminal: t.terminal,
      core: core ? { state: core.state, agent: core.status?.app ?? null, status: core.status?.state ?? null } : null,
      report: fs.existsSync(t.report) ? t.report : null, error: t.error ?? null };
  });
  if (json) { console.log(JSON.stringify({ home: slash(h.dir), owner: owner ? { terminal: owner.terminal, live, mine } : null, tasks })); return; }
  console.log(`home ${slash(h.dir)} - ${owner ? `owner ${owner.terminal}${mine ? ' (you)' : live ? ' (live, you are read-only)' : ' (gone)'}` : 'no owner'}`);
  if (!tasks.length) console.log(all ? 'no tasks' : 'no unfinished tasks');
  for (const t of tasks) console.log(`${t.id}\t${t.state}\t${t.kind}/${t.agent}\t${t.project}\t${t.terminal ?? '-'}${t.core ? ` (${t.core.status ?? t.core.state})` : ''}${t.error ? `\t${t.error}` : ''}`);
}

const COMMANDS = { init: cmdInit, project: cmdProject, start: cmdStart, end: cmdEnd, spawn: cmdSpawn, done: cmdDone, wait: cmdWait, stop: cmdStop, finish: cmdFinish, status: cmdStatus };
const USAGE = `crew ${VERSION} - a small crew tool on Herdr Core
  crew init [folder]                       create a crew home (default ~/.crew/home)
  crew project add <name> <git folder>     register a project   (crew project list)
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
