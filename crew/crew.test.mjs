// Runs with plain `node crew/crew.test.mjs`. Core is replaced by a small fake `hc`, so no
// terminal, agent or machine is touched; the live checks are recorded in crew/README.md.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validId, shq, bashPath, briefText, agentCommand, githubOwner, AGENTS, TOOLS, main } from './crew.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-test-'));
const slash = p => p.replace(/\\/g, '/');

// Pure helpers.
assert.ok(validId('readme-lines') && validId('a1') && !validId('Bad') && !validId('-x') && !validId('a'.repeat(41)) && !validId('../x'));
assert.equal(shq("it's"), `'it'\\''s'`);
assert.equal(bashPath('D:\\Git\\x y'), '/d/Git/x y'); assert.equal(bashPath('/home/u/x'), '/home/u/x');
assert.deepEqual(Object.keys(AGENTS), ['a1', 'pi', 'claude']);
const brief = briefText({ id: 't1', kind: 'scout', task: 'Count lines.', worktree: 'W', project: 'p', report: 'R' });
assert.match(brief, /read-only investigation/); assert.match(brief, /crew done t1/); assert.match(brief, /`R`/);
assert.match(briefText({ id: 't1', kind: 'ship', task: 'x', worktree: 'W', project: 'p', report: 'R' }), /commit them/);

// Claude account choice: only for Claude, only through the launcher, never an unchecked value.
{
  const launcher = path.join(root, 'claude-as.sh'); fs.writeFileSync(launcher, '#!/bin/sh');
  const env = { CREW_CLAUDE_ACCOUNT: 'me@example.com', CREW_CLAUDE_LAUNCHER: launcher };
  assert.equal(agentCommand('a1', AGENTS.a1, 'do it', env), "'a1' 'do it'", 'The account applies to Claude Code only');
  assert.equal(agentCommand('claude', AGENTS.claude, 'do it', {}), "'claude' 'do it' '--permission-mode' 'acceptEdits' '--allowedTools' 'Bash,PowerShell,Read,Edit,Write,Glob,Grep'");
  const line = agentCommand('claude', AGENTS.claude, "it's", env);
  assert.ok(line.startsWith("bash --noprofile --norc '") && line.includes("claude-as.sh' --as 'me@example.com' --command \"$(type -P claude || type -P claude.exe)\" -- 'it'\\''s' '--permission-mode' 'acceptEdits'"), line);
  assert.throws(() => agentCommand('claude', AGENTS.claude, 'x', { ...env, CREW_CLAUDE_ACCOUNT: "a'; rm -rf ~" }), /Not an account name/);
  assert.equal(agentCommand('claude', AGENTS.claude, 'x', { CREW_CLAUDE_ACCOUNT: 'me@example.com', CREW_CLAUDE_LAUNCHER: path.join(root, 'missing.sh') }).startsWith("'claude' 'x'"), true, 'No launcher: the default account, with a warning');
}

// A fake Core: terminals live in a JSON file; `run` creates one, `get` reads, `kill`/`rm` remove.
const fake = path.join(root, 'fake-hc.mjs'), world = path.join(root, 'world.json');
fs.writeFileSync(world, JSON.stringify({ seq: 0, terminals: {}, log: [] }));
fs.writeFileSync(fake, `
import fs from 'node:fs';
const file = ${JSON.stringify(world)}, w = JSON.parse(fs.readFileSync(file, 'utf8')), a = process.argv.slice(2);
w.log.push(a); const save = () => fs.writeFileSync(file, JSON.stringify(w));
if (a[0] === 'run') { const address = 't' + (++w.seq); const labels = {}; a.forEach((v, i) => { if (v === '--label') { const [k, ...r] = a[i + 1].split('='); labels[k] = r.join('='); } });
  w.terminals[address] = { address, state: 'live', labels, status: null, cwd: a[a.indexOf('--cwd') + 1] }; save(); console.log(JSON.stringify({ address })); }
else if (a[0] === 'get' && w.silent) { save(); console.error('Core transport unavailable'); process.exit(1); }
else if (a[0] === 'kill' && w.unkillable) { save(); }
else if (a[0] === 'get') { const t = w.terminals[a.at(-1)]; save(); if (!t) { console.error(JSON.stringify({ error: { kind: 'not_found' } })); process.exit(3); } console.log(JSON.stringify(t)); }
else if (a[0] === 'kill') { const t = w.terminals[a.at(-1)]; if (t) t.state = 'finished'; save(); }
else if (a[0] === 'rm') { delete w.terminals[a.at(-1)]; save(); }
else save();
`);
const readWorld = () => JSON.parse(fs.readFileSync(world, 'utf8'));
const setTerminal = (address, patch) => { const w = readWorld(); Object.assign(w.terminals[address], patch); fs.writeFileSync(world, JSON.stringify(w)); };

const homeDir = path.join(root, 'home'), project = path.join(root, 'project'), fakeUser = path.join(root, 'user');
fs.mkdirSync(fakeUser);
const claudeConfig = path.join(root, 'claude.json');
fs.writeFileSync(claudeConfig, JSON.stringify({ theme: 'dark', projects: { 'C:/mine': { hasTrustDialogAccepted: true, history: [1] } } }));
function crew(args, { terminal, cwd = homeDir, env: extra = {} } = {}) {
  const env = { ...process.env, CREW_CLAUDE_CONFIG: claudeConfig, HOME: fakeUser, USERPROFILE: fakeUser, CREW_HC: fake, CREW_SETTLE_SECONDS: '2', CREW_WORKTREES: path.join(root, 'copies'), CREW_HOME: '', HC_TERMINAL_ID: '', CREW_TERMINAL: terminal ?? '',
    // No tool of the machine the suite runs on is seen, unless a test names a fake one.
    CREW_TOOL_PATH: path.join(root, 'no-tools'), ...Object.fromEntries(TOOLS.map(t => [`CREW_TOOL_${t.id.toUpperCase().replace(/-/g, '_')}`, ''])), ...extra };
  delete env.CREW_HOME;
  const r = spawnSync(process.execPath, [path.join(here, 'crew.mjs'), ...args], { encoding: 'utf8', cwd: fs.existsSync(cwd) ? cwd : root, env, shell: false });
  return { code: r.status, out: r.stdout + r.stderr };
}
const git = (...args) => { const r = spawnSync('git', args, { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
const who = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid'];
const commit = (folder, files, message) => {
  for (const [name, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true }); fs.writeFileSync(path.join(folder, name), text); }
  git('-C', folder, 'add', '-A'); git('-C', folder, ...who, 'commit', '-q', '-m', message);
  return git('-C', folder, 'rev-parse', 'HEAD').trim();
};

try {
  // Status uses spawn time (creation while preparing), freezes settled tasks, and formats
  // elapsed time without contacting Core or depending on the wall clock.
  {
    const statusHome = path.join(root, 'durations'), clock = Date.parse('2026-06-01T12:00:00Z');
    const ago = seconds => new Date(clock - seconds * 1000).toISOString();
    fs.mkdirSync(path.join(statusHome, 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(statusHome, 'crew.json'), JSON.stringify({ version: 1, tag: 'durations', projects: {} }));
    const cases = [
      { id: 'preparing', state: 'preparing', created: ago(45), seconds: 45, text: '45s' },
      { id: 'working', state: 'working', spawned: ago(93784), seconds: 93784, text: '1d 2h' },
      { id: 'minutes', state: 'working', spawned: ago(125), seconds: 125, text: '2m 5s' },
      { id: 'reported', state: 'reported', spawned: ago(200), reported: ago(75), seconds: 125, text: '2m 5s' },
      { id: 'stopped', state: 'stopped', spawned: ago(200), stopped: ago(141), seconds: 59, text: '59s' },
      { id: 'failed', state: 'failed', spawned: ago(7200), updated: ago(3600), seconds: 3600, text: '1h', pr: 'https://example.invalid/acme/demo/pull/8', error: 'delivery failed' },
      { id: 'future', state: 'working', spawned: ago(-60), seconds: 0, text: '0s' },
      { id: 'unknown', state: 'preparing', created: 'invalid', seconds: null, text: '-' },
      { id: 'closed', state: 'closed', spawned: ago(7200), closed: ago(3600), seconds: 3600, text: '1h' },
    ];
    for (const { seconds, text, ...task } of cases) {
      const dir = path.join(statusHome, 'tasks', task.id);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify({ created: ago(200000), kind: 'ship', agent: 'pi',
        project: 'demo', terminal: null, report: path.join(dir, 'report.md'), ...task }));
    }
    const oldHome = process.env.CREW_HOME, oldNow = Date.now, oldLog = console.log;
    const output = [];
    try {
      process.env.CREW_HOME = statusHome;
      Date.now = () => clock;
      console.log = line => output.push(line);
      main(['status']);
      for (const task of cases.filter(t => t.state !== 'closed')) {
        assert.ok(output.includes(`${task.id}\t${task.state}\tship/pi\tdemo\t-\t${task.text}${task.pr ? `\t${task.pr}` : ''}${task.error ? `\t${task.error}` : ''}`), task.id);
      }
      assert.ok(!output.some(line => line.startsWith('closed\t')), 'Closed tasks stay hidden by default');
      output.length = 0;
      main(['status', '--all', '--json']);
      const tasks = JSON.parse(output[0]).tasks;
      for (const task of cases) {
        assert.equal(tasks.find(t => t.id === task.id).elapsedSeconds, task.seconds, task.id);
        assert.equal(tasks.find(t => t.id === task.id).pr, task.pr ?? null, task.id);
      }
      output.length = 0;
      main(['status', '--all']);
      assert.ok(output.includes('closed\tclosed\tship/pi\tdemo\t-\t1h'), 'Closed duration stays fixed');
    } finally {
      if (oldHome === undefined) delete process.env.CREW_HOME; else process.env.CREW_HOME = oldHome;
      Date.now = oldNow;
      console.log = oldLog;
    }
  }

  fs.mkdirSync(project); git('-C', project, 'init', '-q'); fs.writeFileSync(path.join(project, 'README.md'), 'one\ntwo\n');
  git('-C', project, 'add', '-A'); git('-C', project, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'init');

  // A home, with coordinator rules any agent reads, and a registered project.
  assert.match(crew(['status'], { cwd: root }).out, /No crew home yet/);
  // With no folder, the home is the per-user one, and crew then works from anywhere.
  assert.ok(crew(['init'], { cwd: root }).out.includes('/user/.crew/crew'), 'The default home is under the user folder, in a folder named crew');
  assert.ok(crew(['status'], { cwd: root }).out.includes('.crew/crew - no owner'), 'crew finds the default home from any folder');
  // A home from before 0.6 (~/.crew/home) keeps working and is moved once, when nobody uses it.
  {
    const now = path.join(fakeUser, '.crew', 'crew'), old = path.join(fakeUser, '.crew', 'home');
    assert.equal(slash(crew(['home'], { cwd: root }).out.trim()), slash(now));
    fs.renameSync(now, old);
    fs.mkdirSync(path.join(old, 'tasks', 'k1'), { recursive: true });
    fs.writeFileSync(path.join(old, 'tasks', 'k1', 'task.json'), JSON.stringify({ id: 'k1', state: 'closed', report: `${slash(old)}/tasks/k1/report.md`, brief: `${slash(old)}/tasks/k1/brief.md`, worktree: 'C:/elsewhere/k1' }));
    assert.ok(crew(['status'], { cwd: root }).out.includes('.crew/home - no owner'), 'The old place still works');
    assert.equal(crew(['init'], { cwd: root }).code, 2, 'No second default home beside the old one');
    let w0 = readWorld(); w0.terminals.old1 = { address: 'old1', state: 'live', labels: {} }; fs.writeFileSync(world, JSON.stringify(w0));
    fs.writeFileSync(path.join(old, 'owner.json'), JSON.stringify({ terminal: 'old1' }));
    let m = crew(['home', '--ensure'], { cwd: root });
    assert.ok(m.out.includes('for now: a session still holds it') && fs.existsSync(old) && !fs.existsSync(now), m.out);
    w0 = readWorld(); delete w0.terminals.old1; fs.writeFileSync(world, JSON.stringify(w0));
    m = crew(['home', '--ensure'], { cwd: root });
    assert.ok(m.out.includes('the home moved to') && !fs.existsSync(old) && fs.existsSync(path.join(now, 'crew.json')), m.out);
    const k1 = JSON.parse(fs.readFileSync(path.join(now, 'tasks', 'k1', 'task.json'), 'utf8'));
    assert.deepEqual([k1.report, k1.brief, k1.worktree], [`${slash(now)}/tasks/k1/report.md`, `${slash(now)}/tasks/k1/brief.md`, 'C:/elsewhere/k1'], 'Task records follow the home');
    fs.rmSync(path.join(fakeUser, '.crew'), { recursive: true, force: true });
    m = crew(['home', '--ensure'], { cwd: root });
    assert.ok(m.code === 0 && fs.existsSync(path.join(now, 'crew.json')), 'With no home at all, --ensure creates the default one');
  }
  fs.rmSync(path.join(fakeUser, '.crew'), { recursive: true, force: true });
  assert.equal(crew(['init', homeDir]).code, 0);
  assert.ok(fs.readFileSync(path.join(homeDir, 'AGENTS.md'), 'utf8').includes('crew spawn'));
  assert.equal(fs.readFileSync(path.join(homeDir, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
  assert.equal(crew(['init', homeDir]).code, 2, 'A home is never re-initialised');
  assert.equal(crew(['project', 'add', 'demo', project]).code, 0);
  assert.equal(crew(['project', 'add', 'bad', root]).code, 2, 'Only git repositories are projects');

  // One owner. Nothing changes the home without holding it; a second live session is read-only.
  assert.equal(crew(['spawn', 't1', '--project', 'demo', 'Count the lines.'], { terminal: 'c1' }).code, 3);
  assert.equal(crew(['start']).code, 3, 'start needs a Herdr terminal');
  let w = readWorld(); w.terminals.c1 = { address: 'c1', state: 'live', labels: {} }; w.terminals.c2 = { address: 'c2', state: 'live', labels: {} }; fs.writeFileSync(world, JSON.stringify(w));
  assert.match(crew(['start'], { terminal: 'c1' }).out, /you hold .* \(terminal c1\)/);
  let r = crew(['start'], { terminal: 'c2' }); assert.equal(r.code, 3); assert.match(r.out, /owned by live terminal c1/);
  r = crew(['spawn', 't1', '--project', 'demo', 'x'], { terminal: 'c2' }); assert.equal(r.code, 3); assert.match(r.out, /Read-only/);

  // Missing task ids give command-specific usage, including when only --force is passed.
  for (const [args, usage] of [
    [['wait'], 'Usage: crew wait <id> [<id>...] [--timeout seconds]'],
    [['finish'], 'Usage: crew finish <id> [--force]'],
    [['finish', '--force'], 'Usage: crew finish <id> [--force]'],
    [['stop'], 'Usage: crew stop <id> [--force]'],
    [['stop', '--force'], 'Usage: crew stop <id> [--force]'],
    [['done'], 'Usage: crew done [<id>]'],
  ]) {
    const result = crew(args, { terminal: 'c1', env: { CREW_TASK: '' } });
    assert.equal(result.code, 2, args.join(' '));
    assert.ok(result.out.includes(usage), result.out);
  }

  // Spawn: its own working copy, a brief, a labelled terminal started with one instruction.
  for (const bad of [['spawn', 'Bad Id', '--project', 'demo', 'x'], ['spawn', 't1', '--project', 'nope', 'x'], ['spawn', 't1', '--project', 'demo', '--agent', 'vim', 'x'], ['spawn', 't1', '--project', 'demo']]) {
    assert.equal(crew(bad, { terminal: 'c1' }).code, 2, bad.join(' '));
  }
  r = crew(['spawn', 't1', '--project', 'demo', '--agent', 'pi', 'Count the lines of README.md.'], { terminal: 'c1' });
  assert.equal(r.code, 0, r.out); assert.match(r.out, /spawned t1: pi scout in terminal t1/);
  const copies = path.join(root, 'copies', JSON.parse(fs.readFileSync(path.join(homeDir, 'crew.json'), 'utf8')).tag);
  const wt = path.join(copies, 't1');
  assert.ok(!slash(wt).startsWith(slash(homeDir) + '/'), 'A working copy is never inside the home, where the coordinator rules live');
  assert.equal(fs.readFileSync(path.join(wt, 'README.md'), 'utf8').replace(/\r/g, ''), 'one\ntwo\n');
  const call = readWorld().log.find(a => a[0] === 'run');
  for (const want of ['--bg', '--keep', '--no-parent', '--no-notify', 'crew.task=t1', 'crew.kind=scout', 'herdr.right-click=menu']) assert.ok(call.includes(want), want);
  assert.ok(call.some(v => /^herdr\.space=fm-crew-[0-9a-f]+$/.test(v)), 'Workers share one automatic space');
  assert.equal(call[call.indexOf('--cwd') + 1], slash(wt));
  const line = call.at(-1);
  assert.match(line, /^export CREW_HOME='[^']+' CREW_TASK='t1' PATH='[^']+crew\/bin':"\$PATH"; 'pi' 'Read the brief at [^']+brief\.md and carry it out exactly\.'; exec bash --login -i$/);
  assert.equal(crew(['spawn', 't1', '--project', 'demo', 'again'], { terminal: 'c1' }).code, 2, 'An id is used once');

  // Done: only the task's own terminal, and only with a report.
  assert.equal(crew(['done', 't1'], { terminal: 't1' }).code, 2, 'No report yet');
  fs.writeFileSync(path.join(homeDir, 'tasks', 't1', 'report.md'), '# Result\n2 lines\n');
  assert.equal(crew(['done', 't1'], { terminal: 'c2' }).code, 3, 'Another terminal cannot report for it');
  assert.equal(crew(['done', 't1'], { terminal: 't1' }).code, 0);
  assert.equal(crew(['done'], { terminal: 't1', env: { CREW_TASK: 't1' } }).code, 0, 'done still accepts CREW_TASK instead of an explicit id');
  r = crew(['wait', 't1'], { terminal: 'c1' }); assert.equal(r.code, 0); assert.match(r.out, /== t1: reported\n# Result\n2 lines/);
  assert.match(crew(['status'], { terminal: 'c2' }).out, /owner c1 \(live, you are read-only\)[\s\S]*t1\treported\tscout\/pi\tdemo\tt1/);

  // A worker whose terminal is gone without a report has failed; a working one is not closed.
  assert.equal(crew(['spawn', 't2', '--project', 'demo', 'x'], { terminal: 'c1' }).code, 0);
  setTerminal('t2', { status: { app: 'pi', state: 'working' } });
  r = crew(['finish', 't2'], { terminal: 'c1' }); assert.equal(r.code, 6); assert.match(r.out, /still working/);
  assert.ok(fs.existsSync(path.join(copies, 't2')), 'A refused finish removes nothing');
  r = crew(['wait', 't2', '--timeout', '1'], { terminal: 'c1' }); assert.equal(r.code, 124); assert.match(r.out, /still working after 1s/);
  // A worker waiting for a person is handed back at once, not waited on.
  setTerminal('t2', { status: { app: 'claude-code', state: 'blocked', kind: 'permission', msg: 'trust this folder' } });
  r = crew(['wait', 't2', '--timeout', '30'], { terminal: 'c1' }); assert.equal(r.code, 7); assert.ok(r.out.includes('== t2: needs a person - trust this folder (terminal t2); it is still running'), r.out);
  assert.ok(crew(['status'], { terminal: 'c1' }).out.includes('t2\tworking'), 'Its task is unchanged');
  setTerminal('t2', { status: { app: 'pi', state: 'working' } });
  setTerminal('t2', { state: 'finished' });
  r = crew(['wait', 't2', '--timeout', '20'], { terminal: 'c1' }); assert.equal(r.code, 0); assert.match(r.out, /== t2: failed - The worker terminal ended without a report/);

  // A reported worker still inside its last turn gets a short grace, then counts as busy.
  setTerminal('t1', { status: { app: 'pi', state: 'working' } });
  r = crew(['finish', 't1'], { terminal: 'c1' }); assert.equal(r.code, 6); assert.match(r.out, /still working/);
  setTerminal('t1', { status: { app: 'pi', state: 'done' } });
  // Finish: terminal and working copy go, the report stays; then the home can be released.
  assert.equal(crew(['finish', 't1'], { terminal: 'c2' }).code, 3);
  r = crew(['finish', 't1'], { terminal: 'c1' }); assert.equal(r.code, 0, r.out);
  assert.ok(!readWorld().terminals.t1 && !fs.existsSync(wt) && fs.existsSync(path.join(homeDir, 'tasks', 't1', 'report.md')));
  assert.equal(crew(['finish', 't2', '--force'], { terminal: 'c1' }).code, 0);
  assert.match(crew(['status'], { terminal: 'c1' }).out, /no unfinished tasks/);
  assert.match(crew(['status', '--all', '--json'], { terminal: 'c1' }).out, /"id":"t1","state":"closed"/);
  assert.equal(crew(['end'], { terminal: 'c2' }).code, 3);
  assert.equal(crew(['end'], { terminal: 'c1' }).code, 0);
  // A dead owner is replaced, and the newcomer is told what was left behind.
  assert.equal(crew(['start'], { terminal: 'c1' }).code, 0); assert.equal(crew(['spawn', 't3', '--project', 'demo', 'x'], { terminal: 'c1' }).code, 0);
  setTerminal('c1', { state: 'finished' });
  r = crew(['start'], { terminal: 'c2' }); assert.equal(r.code, 0); assert.match(r.out, /unfinished tasks: t3\[working\]/);
  assert.equal(crew(['finish', 't3'], { terminal: 'c2' }).code, 0);
  // Claude Code: the instruction comes before its options, and it keeps its permission system.
  assert.equal(crew(['spawn', 'tc', '--project', 'demo', '--agent', 'claude', 'x'], { terminal: 'c2' }).code, 0);
  const claudeLine = readWorld().log.filter(a => a[0] === 'run').at(-1).at(-1);
  assert.ok(claudeLine.includes("'claude' 'Read the brief at ") && claudeLine.includes(" and carry it out exactly.' '--permission-mode' 'acceptEdits' '--allowedTools' 'Bash,PowerShell,Read,Edit,Write,Glob,Grep'; exec bash"), claudeLine);
  assert.ok(!claudeLine.includes('skip-permissions'), 'A worker is never started with its permission checks switched off');
  // Its copy is recorded as trusted in Claude's config, beside what was there; a1/pi copies are not.
  const copyKey = slash(path.join(copies, 'tc'));
  let cc = JSON.parse(fs.readFileSync(claudeConfig, 'utf8'));
  assert.deepEqual(cc.projects[copyKey], { hasTrustDialogAccepted: true, crewWorkerCopy: true });
  assert.deepEqual([cc.theme, cc.projects['C:/mine']], ['dark', { hasTrustDialogAccepted: true, history: [1] }], 'Nothing else in the config is touched');
  assert.deepEqual(Object.keys(cc.projects).length, 2, 'Only the Claude worker got an entry');
  assert.equal(crew(['finish', 'tc', '--force'], { terminal: 'c2' }).code, 0);
  cc = JSON.parse(fs.readFileSync(claudeConfig, 'utf8'));
  assert.deepEqual(Object.keys(cc.projects), ['C:/mine'], 'Finish removes the entry crew made and no other');
  // A config crew cannot parse is never overwritten; the worker still starts.
  fs.writeFileSync(claudeConfig, '{ not json');
  const r2 = crew(['spawn', 'td', '--project', 'demo', '--agent', 'claude', 'x'], { terminal: 'c2' });
  assert.equal(r2.code, 0); assert.match(r2.out, /could not record the working copy as trusted/);
  assert.equal(fs.readFileSync(claudeConfig, 'utf8'), '{ not json');
  // Remove: refused while an unfinished task uses the project; afterwards the entry goes, the folder stays.
  r = crew(['project', 'remove', 'demo'], { terminal: 'c2' }); assert.equal(r.code, 2); assert.match(r.out, /used by unfinished tasks: td\[working\]/);
  assert.match(crew(['project', 'list']).out, /^demo\t/m, 'A refused remove keeps the project');
  assert.equal(crew(['project', 'remove', 'nope'], { terminal: 'c2' }).code, 2, 'Only a registered project can be removed');
  assert.equal(crew(['finish', 'td', '--force'], { terminal: 'c2' }).code, 0);
  r = crew(['project', 'remove', 'demo'], { terminal: 'c2' }); assert.equal(r.code, 0, r.out); assert.match(r.out, /project demo removed/);
  assert.equal(crew(['project', 'list']).out.trim(), '');
  assert.ok(fs.existsSync(path.join(project, 'README.md')), 'The project folder is untouched');
  assert.equal(crew(['spawn', 'te', '--project', 'demo', 'x'], { terminal: 'c2' }).code, 2, 'A removed project cannot be used');

  // --- the five reviewed defects -------------------------------------------------------
  const setWorld = patch => { const w = readWorld(); Object.assign(w, patch); fs.writeFileSync(world, JSON.stringify(w)); };
  const other = path.join(root, 'other'); fs.mkdirSync(other); git('-C', other, 'init', '-q');
  assert.equal(crew(['project', 'add', 'demo', project], { terminal: 'c2' }).code, 0);
  // (4) The project list belongs to the session that holds the home, and a name is only
  // pointed elsewhere on request and never under an unfinished task.
  r = crew(['project', 'add', 'demo', other], { terminal: 'c1' }); assert.equal(r.code, 3); assert.match(r.out, /Only that session may change its projects/);
  r = crew(['project', 'remove', 'demo'], { terminal: 'c1' }); assert.equal(r.code, 3);
  r = crew(['project', 'add', 'demo', other], { terminal: 'c2' }); assert.equal(r.code, 2); assert.match(r.out, /Pass --replace/);
  assert.equal(crew(['project', 'add', 'demo', project], { terminal: 'c2' }).code, 0, 'Adding the same folder again is not a replacement');
  assert.equal(crew(['spawn', 'f1', '--project', 'demo', '--kind', 'ship', '--agent', 'pi', 'x'], { terminal: 'c2' }).code, 0);
  r = crew(['project', 'add', 'demo', other, '--replace'], { terminal: 'c2' }); assert.equal(r.code, 2); assert.match(r.out, /used by unfinished tasks: f1/);
  const f1 = JSON.parse(fs.readFileSync(path.join(homeDir, 'tasks', 'f1', 'task.json'), 'utf8')), f1copy = path.join(copies, 'f1');

  // (1) A Core that does not answer is not a terminal that is gone: nothing is taken over,
  // failed, stopped or deleted on a failed query.
  setTerminal(f1.terminal, { status: { app: 'pi', state: 'working' } });
  setWorld({ silent: true });
  r = crew(['finish', 'f1'], { terminal: 'c2' }); assert.equal(r.code, 4); assert.match(r.out, /Core did not answer about terminal/);
  assert.ok(fs.existsSync(path.join(f1copy, 'README.md')), 'The busy worker kept its files');
  r = crew(['stop', 'f1', '--force'], { terminal: 'c2' }); assert.equal(r.code, 4);
  r = crew(['wait', 'f1', '--timeout', '7'], { terminal: 'c2' }); assert.equal(r.code, 124, 'An unanswered query does not fail a healthy worker');
  r = crew(['start'], { terminal: 'c1' }); assert.equal(r.code, 4); assert.match(r.out, /was not taken over/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(homeDir, 'owner.json'), 'utf8')).terminal, 'c2');
  setWorld({ silent: false });
  assert.equal(JSON.parse(fs.readFileSync(path.join(homeDir, 'tasks', 'f1', 'task.json'), 'utf8')).state, 'working');

  // (3) stop really stops, and says so only when Core shows the terminal ended.
  setWorld({ unkillable: true });
  r = crew(['stop', 'f1', '--force'], { terminal: 'c2' }); assert.equal(r.code, 6); assert.match(r.out, /not stopped f1: Core still shows the terminal as live/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(homeDir, 'tasks', 'f1', 'task.json'), 'utf8')).state, 'working', 'A stop that did not happen is not recorded');
  setWorld({ unkillable: false });
  r = crew(['stop', 'f1', '--force'], { terminal: 'c2' }); assert.equal(r.code, 0); assert.match(r.out, /stopped f1: cancelled; terminal ended/);
  assert.equal(readWorld().terminals[f1.terminal].state, 'finished');
  assert.equal(JSON.parse(fs.readFileSync(path.join(homeDir, 'tasks', 'f1', 'task.json'), 'utf8')).state, 'stopped');

  // (2) A ship task's uncommitted work is not thrown away by an ordinary finish.
  commit(f1copy, { 'saved.txt': 'kept\n' }, 'Saved work');
  fs.writeFileSync(path.join(f1copy, 'half-done.txt'), 'unsaved');
  r = crew(['finish', 'f1'], { terminal: 'c2' }); assert.equal(r.code, 6); assert.match(r.out, /has uncommitted work .*half-done\.txt/);
  assert.equal(fs.readFileSync(path.join(f1copy, 'half-done.txt'), 'utf8'), 'unsaved');
  assert.equal(crew(['finish', 'f1', '--force'], { terminal: 'c2' }).code, 0);
  assert.ok(!fs.existsSync(f1copy), 'Discarding was asked for');
  assert.ok(git('-C', project, 'branch', '--list', 'crew/f1').includes('crew/f1'), 'The branch stays');
  // A branch whose commits are merged holds nothing more and goes with the working copy.
  assert.equal(crew(['spawn', 'f4', '--project', 'demo', '--kind', 'ship', '--agent', 'pi', 'x'], { terminal: 'c2' }).code, 0);
  commit(path.join(copies, 'f4'), { 'merged.txt': 'in\n' }, 'Merged work'); git('-C', project, 'merge', '-q', '--ff-only', 'crew/f4');
  r = crew(['finish', 'f4', '--force'], { terminal: 'c2' }); assert.equal(r.code, 0, r.out); assert.match(r.out, /; merged branch crew\/f4 deleted/);
  assert.equal(git('-C', project, 'branch', '--list', 'crew/f4').trim(), '', 'A merged branch is deleted');
  // A scout's leftovers are scratch.
  assert.equal(crew(['spawn', 'f2', '--project', 'demo', '--agent', 'pi', 'x'], { terminal: 'c2' }).code, 0);
  fs.writeFileSync(path.join(copies, 'f2', 'notes.tmp'), 'x');
  assert.equal(crew(['finish', 'f2'], { terminal: 'c2' }).code, 0);

  // (5) A report accepted while spawn was still waiting for Core is not overwritten.
  fs.writeFileSync(fake, fs.readFileSync(fake, 'utf8').replace("if (a[0] === 'run') {", `if (a[0] === 'run' && w.reportDuringRun) {
  const dir = ${JSON.stringify(path.join(homeDir, 'tasks'))} + '/' + w.reportDuringRun, file = dir + '/task.json';
  const task = JSON.parse(fs.readFileSync(file, 'utf8')); fs.writeFileSync(dir + '/report.md', 'early');
  fs.writeFileSync(file, JSON.stringify({ ...task, state: 'reported', reported: 'early' }));
}
if (a[0] === 'run') {`));
  setWorld({ reportDuringRun: 'f3' });
  assert.equal(crew(['spawn', 'f3', '--project', 'demo', '--agent', 'pi', 'x'], { terminal: 'c2' }).code, 0);
  setWorld({ reportDuringRun: null });
  const f3 = JSON.parse(fs.readFileSync(path.join(homeDir, 'tasks', 'f3', 'task.json'), 'utf8'));
  assert.deepEqual([f3.state, f3.reported, Boolean(f3.terminal)], ['reported', 'early', true]);
  assert.equal(crew(['finish', 'f3'], { terminal: 'c2' }).code, 0);

  // --- crew maintains itself -----------------------------------------------------------
  // A published source (bare), this machine's installed tool (a clone of it) and another
  // machine (a second clone). The "suite" is a small script that fails when crew/broken exists.
  const origin = path.join(root, 'origin.git'), tool = path.join(root, 'tool'), peer = path.join(root, 'peer'), seed = path.join(root, 'seed');
  fs.mkdirSync(seed); git('-C', seed, 'init', '-q', '-b', 'main');
  commit(seed, { 'crew/check.mjs': "import fs from 'node:fs'; process.exit(fs.existsSync('crew/broken') ? 1 : 0);\n", 'crew/tool.txt': 'one\n', 'README.md': 'outside\n' }, 'seed');
  git('clone', '-q', '--bare', seed, origin); git('clone', '-q', origin, tool); git('clone', '-q', origin, peer);
  for (const folder of [tool, peer]) { git('-C', folder, 'config', 'user.name', 't'); git('-C', folder, 'config', 'user.email', 't@example.invalid'); }
  const self = { CREW_TOOL_ROOT: tool, CREW_SELFTEST: 'node crew/check.mjs' };
  const sm = (args, terminal = 'c2', env = {}) => crew(args, { terminal, env: { ...self, ...env } });
  const head = folder => git('-C', folder, 'rev-parse', 'HEAD').trim();
  const taskOf = id => JSON.parse(fs.readFileSync(path.join(homeDir, 'tasks', id, 'task.json'), 'utf8'));
  const first = head(tool);

  // A crash is written down and points at the repair command.
  const crashHome = path.join(root, 'crash-home'); fs.mkdirSync(crashHome);
  fs.writeFileSync(path.join(crashHome, 'crew.json'), JSON.stringify({ version: 1, tag: 'crash' }));
  r = crew(['project', 'list'], { cwd: crashHome }); assert.equal(r.code, 70, r.out);
  assert.match(r.out, /internal error[\s\S]*defect in crew itself[\s\S]*crew fix "/);
  const crashFiles = fs.readdirSync(path.join(fakeUser, '.crew', 'crashes'));
  assert.equal(crashFiles.length, 1);
  assert.match(fs.readFileSync(path.join(fakeUser, '.crew', 'crashes', crashFiles[0]), 'utf8'), /command: crew project list[\s\S]*TypeError/);

  // fix: only the owner, one at a time, a ship task on crew's own source with the crash attached.
  assert.equal(sm(['fix', 'x'], 'c1').code, 3);
  assert.equal(sm(['fix']).code, 2);
  r = sm(['fix', '--agent', 'pi', 'crew project list crashed', 'instead of printing nothing']); assert.equal(r.code, 0, r.out);
  assert.match(r.out, /spawned fix-1: pi ship in terminal (t\d+)[\s\S]*next: crew wait fix-1, then crew selfmerge fix-1/);
  const fix1 = taskOf('fix-1'), fixCopy = path.join(copies, 'fix-1');
  assert.ok(readWorld().log.filter(a => a[0] === 'run').at(-1).includes('crew.kind=fix'), 'A fixer is labelled as one');
  assert.deepEqual([fix1.selfFix, fix1.project, fix1.projectPath, fix1.base], [true, 'crew:self', slash(tool), first]);
  const fixBrief = fs.readFileSync(fix1.brief, 'utf8');
  assert.ok(fixBrief.includes('crew project list crashed instead of printing nothing') && fixBrief.includes(crashFiles[0]) && fixBrief.includes('under `crew/` only'), fixBrief);
  assert.equal(git('-C', fixCopy, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'crew/fix-1');
  r = sm(['fix', 'another']); assert.equal(r.code, 2); assert.match(r.out, /already open: fix-1/);

  // selfmerge: every gate refuses and publishes nothing.
  assert.equal(sm(['selfmerge', 'fix-1'], 'c1').code, 3);
  r = sm(['selfmerge', 'fix-1']); assert.equal(r.code, 2); assert.match(r.out, /only after its worker reported/);
  fs.writeFileSync(fix1.report, 'fixed'); assert.equal(crew(['done', 'fix-1'], { terminal: fix1.terminal }).code, 0);
  r = sm(['selfmerge', 'fix-1']); assert.equal(r.code, 6); assert.match(r.out, /changes nothing/);
  fs.writeFileSync(path.join(fixCopy, 'crew', 'half.txt'), 'x');
  r = sm(['selfmerge', 'fix-1']); assert.equal(r.code, 6); assert.match(r.out, /uncommitted files \(crew\/half\.txt\)/);
  fs.rmSync(path.join(fixCopy, 'crew', 'half.txt'));
  commit(fixCopy, { 'README.md': 'changed outside\n', 'crew/tool.txt': 'two\n' }, 'too wide');
  r = sm(['selfmerge', 'fix-1']); assert.equal(r.code, 6); assert.match(r.out, /outside crew\/ \(README\.md\)/);
  git('-C', fixCopy, 'reset', '-q', '--hard', 'HEAD~1');
  commit(fixCopy, { 'crew/tool.txt': 'two\n', 'crew/broken': '' }, 'breaks the suite');
  r = sm(['selfmerge', 'fix-1']); assert.equal(r.code, 6); assert.match(r.out, /the test suite fails \(node crew\/check\.mjs, exit 1\)/);
  assert.deepEqual([head(origin), head(tool)], [first, first], 'A refused repair reaches nobody');
  git('-C', fixCopy, 'reset', '-q', '--hard', 'HEAD~1');
  commit(fixCopy, { 'crew/tool.txt': 'two\n' }, 'the repair');
  // Meanwhile another machine published something else: the repair goes on top of it.
  const theirs = commit(peer, { 'crew/peer.txt': 'theirs\n' }, 'from another machine'); git('-C', peer, 'push', '-q', 'origin', 'HEAD:main');
  r = sm(['selfmerge', 'fix-1']); assert.equal(r.code, 0, r.out);
  assert.match(r.out, /published fix-1 as [0-9a-f]{8} \(1 file: crew\/tool\.txt\); tests passed[\s\S]*this machine now runs [0-9a-f]{8} \(was [0-9a-f]{8}\)[\s\S]*crew finish fix-1/);
  const second = head(origin);
  assert.equal(head(tool), second, 'The installed tool is updated at once');
  assert.equal(git('-C', origin, 'rev-parse', 'HEAD~1').trim(), theirs, 'On top of what the other machine published');
  assert.equal(fs.readFileSync(path.join(tool, 'crew', 'tool.txt'), 'utf8').replace(/\r/g, ''), 'two\n');
  assert.equal(taskOf('fix-1').merged, second);
  assert.match(sm(['selfmerge', 'fix-1']).out, /already published/);
  assert.equal(sm(['finish', 'fix-1']).code, 0);
  assert.equal(git('-C', tool, 'branch', '--list', 'crew/fix-1').trim(), '', 'A published repair leaves no branch behind');
  assert.equal(crew(['spawn', 'no', '--project', 'crew:self', 'x'], { terminal: 'c2' }).code, 2, "crew's own source is not a project for ordinary tasks");

  // rollback: this machine goes back one step and stays there while that revision is the latest.
  r = sm(['rollback']); assert.equal(r.code, 0, r.out); assert.equal(head(tool), first);
  assert.equal(sm(['rollback']).code, 2, 'One step only');
  r = sm(['start'], 'c2', { CREW_AUTO_UPDATE: '1' }); assert.equal(r.code, 0, r.out);
  assert.match(r.out, /crew stays at [0-9a-f]{8} after a rollback/); assert.equal(head(tool), first);
  // A developer's checkout (not the installed copy) never updates itself.
  git('-C', peer, 'pull', '-q', 'origin', 'main'); const third = commit(peer, { 'crew/peer.txt': 'newer\n' }, 'newer'); git('-C', peer, 'push', '-q', 'origin', 'HEAD:main');
  r = sm(['start']); assert.equal(r.code, 0); assert.equal(head(tool), first);
  // Something newer than the bad revision releases the hold; start updates and runs again.
  r = sm(['start'], 'c2', { CREW_AUTO_UPDATE: '1' }); assert.equal(r.code, 0, r.out);
  assert.match(r.out, /crew updated itself [0-9a-f]{8} -> [0-9a-f]{8}[\s\S]*you hold /); assert.equal(head(tool), third);
  assert.match(sm(['update']).out, /crew is up to date/);
  // An unreachable source never blocks a session.
  git('-C', tool, 'remote', 'set-url', 'origin', path.join(root, 'nowhere.git'));
  r = sm(['start'], 'c2', { CREW_AUTO_UPDATE: '1' }); assert.equal(r.code, 0, r.out); assert.match(r.out, /did not check for updates[\s\S]*you hold /);
  assert.equal(sm(['update']).code, 4);
  // A newer crew brings its coordinator rules into an existing home.
  fs.writeFileSync(path.join(homeDir, 'AGENTS.md'), 'old rules');
  assert.match(crew(['start'], { terminal: 'c2' }).out, /coordinator rules changed/);
  assert.ok(fs.readFileSync(path.join(homeDir, 'AGENTS.md'), 'utf8').includes('crew selfmerge'));

  // --- follow-ups, review and delivery ---------------------------------------------------
  assert.deepEqual(['https://github.com/acme/tool.git', 'git@github.com:acme/tool', 'https://github.com/acme/tool/', path.join(root, 'x.git')].map(githubOwner), ['acme', 'acme', 'acme', null]);
  const fakeGh = path.join(root, 'fake-gh.mjs'), ghLog = path.join(root, 'gh-log.json'), ghDown = path.join(root, 'gh-down'), ghMerged = path.join(root, 'gh-merged');
  fs.writeFileSync(ghLog, '[]');
  fs.writeFileSync(fakeGh, `import fs from 'node:fs';
const a = process.argv.slice(2), file = ${JSON.stringify(ghLog)}, log = JSON.parse(fs.readFileSync(file, 'utf8'));
log.push({ a, body: a.includes('--body-file') ? fs.readFileSync(a[a.indexOf('--body-file') + 1], 'utf8') : null }); fs.writeFileSync(file, JSON.stringify(log));
if (a[0] === 'auth') process.exit(1);
if (fs.existsSync(${JSON.stringify(ghDown)})) { console.error('gh: not signed in'); process.exit(1); }
if (a[0] === 'pr' && a[1] === 'list') { console.log(fs.existsSync(${JSON.stringify(ghMerged)}) ? fs.readFileSync(${JSON.stringify(ghMerged)}, 'utf8') : ''); process.exit(0); }
console.log('https://example.invalid/acme/demo/pull/7');
`);
  const own = (args, terminal = 'c2') => crew(args, { terminal, env: { CREW_GH: fakeGh } });
  assert.equal(own(['spawn', 's1', '--project', 'demo', '--kind', 'ship', '--agent', 'pi', 'Change the readme.']).code, 0);
  assert.equal(own(['spawn', 's2', '--project', 'demo', '--agent', 'pi', 'Look.']).code, 0);
  const s1 = taskOf('s1'), s1copy = path.join(copies, 's1');
  // tell: only the owner, only a worker that is there and not waiting for a person.
  assert.equal(own(['tell', 's1']).code, 2); assert.equal(own(['tell', 's1', 'x'], 'c1').code, 3);
  assert.equal(own(['tell', 't1', 'x']).code, 2, 'A closed task has no worker');
  setTerminal(s1.terminal, { status: { app: 'pi', state: 'blocked', msg: 'allow?' } });
  assert.equal(own(['tell', 's1', 'x']).code, 7);
  setTerminal(s1.terminal, { status: { app: 'pi', state: 'working' } });
  r = own(['tell', 's1', 'Keep the first line.']); assert.equal(r.code, 0, r.out); assert.match(r.out, /told s1; next: crew wait s1/);
  let sent = readWorld().log.filter(a => a[0] === 'send').at(-1);
  assert.equal(sent[1], s1.terminal); assert.ok(sent[2].includes('Keep the first line.') && sent[2].includes('crew done s1'), sent[2]);
  // Nothing is reviewed or delivered before the worker reported, and a scout has no branch.
  for (const verb of ['review', 'land']) { assert.equal(own([verb]).code, 2); assert.equal(own([verb, 's1']).code, 2, verb); assert.equal(own([verb, 's2']).code, 2, verb); assert.equal(own([verb, 's1'], 'c1').code, 3); }
  commit(s1copy, { 'README.md': 'one\ntwo\nthree\n' }, 'Add a third line');
  fs.writeFileSync(s1.report, '# Done\nAdded a line.\n'); assert.equal(crew(['done', 's1'], { terminal: s1.terminal }).code, 0);
  // A follow-up reopens a reported task; the same worker reports again.
  assert.equal(own(['tell', 's1', 'Also say why.']).code, 0);
  assert.deepEqual([taskOf('s1').state, taskOf('s1').tells], ['working', 2]);
  assert.equal(own(['land', 's1']).code, 2, 'Reopened work is not delivered');
  assert.equal(crew(['done', 's1'], { terminal: s1.terminal }).code, 0);
  // review: a read-only task for another worker, pointed at the branch.
  r = own(['review', 's1', '--agent', 'vim']); assert.equal(r.code, 2);
  r = own(['review', 's1']); assert.equal(r.code, 0, r.out); assert.match(r.out, /spawned s1-review: pi scout[\s\S]*next: crew wait s1-review/);
  const review = taskOf('s1-review');
  assert.ok(readWorld().log.filter(a => a[0] === 'run').at(-1).includes('crew.kind=review'), 'A reviewer is labelled as one');
  assert.deepEqual([review.kind, review.reviews, review.project], ['scout', 's1', 'demo']);
  assert.ok(fs.readFileSync(review.brief, 'utf8').includes('git diff HEAD...crew/s1') && fs.readFileSync(review.brief, 'utf8').includes('`APPROVE` or `CHANGES NEEDED`'));
  assert.match(own(['review', 's1', '--agent', 'claude']).out, /spawned s1-review-2: claude scout/);
  // land: refused with unsaved work, without a place to push to, and honest when GitHub says no.
  fs.writeFileSync(path.join(s1copy, 'loose.txt'), 'x');
  r = own(['land', 's1']); assert.equal(r.code, 6); assert.match(r.out, /uncommitted files \(loose\.txt\)/);
  fs.rmSync(path.join(s1copy, 'loose.txt'));
  r = own(['land', 's1']); assert.equal(r.code, 6); assert.match(r.out, /no `origin` to push to/);
  const projectOrigin = path.join(root, 'project-origin.git'); git('clone', '-q', '--bare', project, projectOrigin); git('-C', project, 'remote', 'add', 'origin', projectOrigin);
  const baseBranch = git('-C', project, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  fs.writeFileSync(ghDown, '');
  r = own(['land', 's1']); assert.equal(r.code, 4); assert.match(r.out, /branch crew\/s1 is pushed, but the pull request was not opened \(gh: not signed in\)/);
  assert.equal(git('-C', projectOrigin, 'rev-parse', 'crew/s1').trim(), head(s1copy), 'The branch is published');
  assert.equal(taskOf('s1').pr, undefined);
  fs.rmSync(ghDown);
  r = own(['land', 's1']); assert.equal(r.code, 0, r.out);
  assert.ok(r.out.includes(`delivered s1: https://example.invalid/acme/demo/pull/7 (against ${baseBranch}, 1 commit)`), r.out);
  const made = JSON.parse(fs.readFileSync(ghLog, 'utf8')).at(-1);
  assert.deepEqual(made.a.slice(0, 8), ['pr', 'create', '--base', baseBranch, '--head', 'crew/s1', '--title', 'Add a third line']);
  assert.match(made.body, /# Done\nAdded a line\.[\s\S]*crew task `s1` \(pi\), 1 commit/);
  assert.equal(taskOf('s1').pr, 'https://example.invalid/acme/demo/pull/7');
  r = own(['status', '--json']); assert.equal(r.code, 0, r.out);
  assert.equal(JSON.parse(r.out).tasks.find(t => t.id === 's1').pr, 'https://example.invalid/acme/demo/pull/7');
  r = own(['status']); assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^s1\t[^\r\n]*\thttps:\/\/example\.invalid\/acme\/demo\/pull\/7\r?$/m);
  assert.match(own(['land', 's1', '--title', 'x']).out, /already has a pull request/);
  for (const id of ['s1-review', 's1-review-2', 's2', 's1']) assert.equal(own(['finish', id, '--force']).code, 0, id);
  assert.ok(git('-C', project, 'branch', '--list', 'crew/s1').includes('crew/s1'), 'A branch whose pull request is not merged stays');
  // A squash merge leaves no ancestry: GitHub's merged pull request with this exact head counts.
  assert.equal(own(['spawn', 'm1', '--project', 'demo', '--kind', 'ship', '--agent', 'pi', 'x']).code, 0);
  const m1head = commit(path.join(copies, 'm1'), { 'squashed.txt': 'x\n' }, 'Squashed work');
  fs.writeFileSync(ghMerged, 'another-commit\n');
  assert.equal(own(['spawn', 'm2', '--project', 'demo', '--kind', 'ship', '--agent', 'pi', 'x']).code, 0);
  commit(path.join(copies, 'm2'), { 'later.txt': 'x\n' }, 'Work after the merged head');
  r = own(['finish', 'm2', '--force']); assert.equal(r.code, 0, r.out); assert.ok(!r.out.includes('deleted'), r.out);
  assert.ok(git('-C', project, 'branch', '--list', 'crew/m2').includes('crew/m2'), 'Commits the merged pull request did not have keep the branch');
  fs.writeFileSync(ghMerged, m1head + '\n');
  r = own(['finish', 'm1', '--force']); assert.equal(r.code, 0, r.out); assert.match(r.out, /; merged branch crew\/m1 deleted/);
  assert.equal(git('-C', project, 'branch', '--list', 'crew/m1').trim(), '');
  fs.rmSync(ghMerged);

  // --- the tools Firstmate works with ----------------------------------------------------
  assert.deepEqual(TOOLS.map(t => t.id), ['gh', 'gh-axi', 'chrome-devtools-axi', 'lavish-axi', 'tasks-axi', 'quota-axi', 'treehouse', 'no-mistakes', 'jq']);
  const fakeTasks = path.join(root, 'fake-tasks-axi.mjs'), fakeTree = path.join(root, 'fake-treehouse.mjs'), fakeVersion = path.join(root, 'fake-version.mjs');
  const treeLog = path.join(root, 'treehouse-log.json'), poolDir = path.join(root, 'pool');
  fs.writeFileSync(fakeVersion, "console.log('tool version v1.106.1');\n");
  // A backlog like tasks-axi keeps it: one "- [ ] <id> - <title> (<state>)" line per item.
  fs.writeFileSync(fakeTasks, `import fs from 'node:fs';
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('0.2.6'); process.exit(0); }
if (a[0] === '--help') { console.log('usage: tasks-axi [command] [args] [flags]'); process.exit(0); }
const file = a[a.indexOf('--file') + 1], lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\\n').filter(Boolean) : [];
const at = lines.findIndex(l => l.startsWith('- [ ] ' + a[1] + ' ') || l.startsWith('- [x] ' + a[1] + ' '));
const save = () => fs.writeFileSync(file, lines.join('\\n') + '\\n');
if (a[0] === 'add') { lines.push('- [ ] ' + a[1] + ' - ' + a[2] + ' (queued)'); save(); console.log('ok: added ' + a[1] + ' -> Queued'); }
else if (a[0] === 'list') console.log(lines.join('\\n'));
else if (at < 0) { console.error('error: "Task not found in this backlog"'); process.exit(1); }
else if (a[0] === 'start') { lines[at] = lines[at].replace('(queued)', '(in flight)'); save(); console.log('ok: start ' + a[1] + ' -> In flight'); }
else if (a[0] === 'done') { lines[at] = lines[at].replace('- [ ]', '- [x]').replace('(in flight)', '(done' + (a.includes('--pr') ? ' ' + a[a.indexOf('--pr') + 1] : '') + ')'); save(); console.log('ok: done ' + a[1] + ' -> Done'); }
`);
  // A pool like treehouse's: \`get --lease --json\` hands out a slot outside the repository.
  fs.writeFileSync(treeLog, '[]');
  fs.writeFileSync(fakeTree, `import fs from 'node:fs'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
const a = process.argv.slice(2), file = ${JSON.stringify(treeLog)}, log = JSON.parse(fs.readFileSync(file, 'utf8'));
log.push({ a, cwd: process.cwd() }); fs.writeFileSync(file, JSON.stringify(log));
if (a[0] === '--version') console.log('v3.1.8');
else if (a[0] === 'get') {
  const slot = path.join(${JSON.stringify(poolDir)}, String(log.length), 'demo'), b = a.indexOf('-b');
  const r = spawnSync('git', ['worktree', 'add', ...(b < 0 ? ['--detach'] : ['-b', a[b + 1]]), slot, 'HEAD'], { encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr); process.exit(1); }
  console.error('Leased worktree'); console.log(JSON.stringify({ path: slot, lease_id: 'x' }));
} else if (a[0] === 'return' && fs.existsSync(${JSON.stringify(path.join(root, 'pool-stuck'))})) { console.error('foreign process remains'); process.exit(1); }
else if (a[0] === 'return') spawnSync('git', ['-C', a[1], 'checkout', '-q', '--detach']);
`);
  const T = { CREW_GH: fakeGh, CREW_TOOL_TASKS_AXI: fakeTasks, CREW_TOOL_TREEHOUSE: fakeTree, CREW_TOOL_NO_MISTAKES: fakeVersion };
  const tl = (args, terminal = 'c2', env = T) => crew(args, { terminal, env });
  // tools: what is here and what crew does with it; nothing is required.
  r = crew(['tools'], { terminal: 'c2' }); assert.equal(r.code, 0);
  assert.equal(r.out.split('\n').filter(l => l.includes('not installed')).length, 9, r.out); assert.match(r.out, /Missing tools are optional/);
  const seen = JSON.parse(tl(['tools', '--json']).out).tools;
  assert.deepEqual(seen.filter(t => t.installed).map(t => [t.id, t.version]), [['tasks-axi', '0.2.6'], ['treehouse', '3.1.8'], ['no-mistakes', '1.106.1']]);

  // backlog: kept in the home by tasks-axi; reading is free, changing it is the owner's.
  assert.equal(crew(['backlog'], { terminal: 'c2' }).code, 4, 'No tasks-axi, no backlog');
  assert.equal(tl(['backlog', 'add', 'b1', 'Count the lines'], 'c1').code, 3);
  r = tl(['backlog', 'add', 'b1', 'Count the lines']); assert.equal(r.code, 0, r.out); assert.match(r.out, /ok: added b1 -> Queued/);
  tl(['backlog', 'add', 'g1', 'Ship through the gate']);
  assert.match(tl(['backlog'], 'c1').out, /- \[ \] b1 - Count the lines \(queued\)/);
  assert.equal(tl(['backlog', 'start', 'nope']).code, 1, "tasks-axi's own refusal is passed on");
  // Help is a question: it reaches nothing. (Seen live: `crew done --help` was read as a task id.)
  for (const cmd of ['done', 'finish', 'spawn', 'fix', 'land']) { r = tl([cmd, '--help'], 'c1'); assert.equal(r.code, 0, cmd); assert.match(r.out, /crew spawn <id> --project/); }
  r = tl(['backlog', '--help'], 'c1'); assert.equal(r.code, 0, r.out); assert.ok(!r.out.includes('backlog.md'), 'Its help is asked without the file flag');
  // A task named like a backlog item moves it; any other task leaves the backlog alone.
  r = tl(['spawn', 'b1', '--project', 'demo', '--agent', 'pi', 'Count.'], 'c2', { ...T, CREW_TOOL_GH_AXI: fakeVersion, CREW_TOOL_JQ: fakeVersion });
  assert.equal(r.code, 0, r.out); assert.match(r.out, /backlog: start b1 -> In flight/);
  const b1 = taskOf('b1'), b1brief = fs.readFileSync(b1.brief, 'utf8');
  assert.ok(b1brief.includes('## Tools on this machine') && b1brief.includes('`gh-axi --help`') && b1brief.includes('`jq`') && !b1brief.includes('chrome-devtools-axi'), b1brief);
  r = tl(['spawn', 'b2', '--project', 'demo', '--agent', 'pi', 'Count.']); assert.equal(r.code, 0); assert.ok(!r.out.includes('backlog:'));
  assert.ok(!fs.readFileSync(taskOf('b2').brief, 'utf8').includes('Tools on this machine'), 'No tool, no hint');
  fs.writeFileSync(b1.report, 'two'); assert.equal(crew(['done', 'b1'], { terminal: b1.terminal }).code, 0);
  r = tl(['finish', 'b1']); assert.equal(r.code, 0, r.out); assert.match(r.out, /backlog: done b1 -> Done/);
  assert.match(fs.readFileSync(path.join(homeDir, 'backlog.md'), 'utf8'), /- \[x\] b1 - Count the lines \(done\)/);
  assert.equal(tl(['finish', 'b2', '--force']).code, 0);

  // treehouse: a project can take its working copies from the pool, and gives them back.
  r = crew(['project', 'add', 'pooled', project, '--treehouse'], { terminal: 'c2' }); assert.equal(r.code, 4); assert.match(r.out, /treehouse is not installed/);
  r = tl(['project', 'add', 'pooled', project, '--treehouse']); assert.equal(r.code, 0, r.out);
  assert.match(tl(['project', 'list']).out, /^pooled\t.*\ttreehouse$/m);
  r = crew(['spawn', 'p0', '--project', 'pooled', '--agent', 'pi', 'x'], { terminal: 'c2' }); assert.equal(r.code, 5); assert.match(r.out, /treehouse, which is not installed/);
  r = tl(['spawn', 'p1', '--project', 'pooled', '--kind', 'ship', '--agent', 'pi', 'Change it.']); assert.equal(r.code, 0, r.out); assert.match(r.out, /\(treehouse\)/);
  const p1 = taskOf('p1');
  assert.equal(p1.pool, 'treehouse'); assert.ok(p1.worktree.startsWith(slash(poolDir)) && p1.worktree.endsWith('/demo'), p1.worktree);
  assert.equal(git('-C', p1.worktree, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'crew/p1');
  assert.equal(readWorld().log.filter(a => a[0] === 'run').at(-1)[readWorld().log.filter(a => a[0] === 'run').at(-1).indexOf('--cwd') + 1], p1.worktree);
  const lease = JSON.parse(fs.readFileSync(treeLog, 'utf8')).find(e => e.a[0] === 'get');
  assert.deepEqual(lease.a, ['get', '--lease', '--json', '-b', 'crew/p1']); assert.equal(slash(lease.cwd).toLowerCase(), slash(fs.realpathSync(project)).toLowerCase());
  fs.writeFileSync(path.join(root, 'pool-stuck'), '');
  r = tl(['finish', 'p1']); assert.equal(r.code, 6); assert.match(r.out, /treehouse did not take the working copy back \(foreign process remains\)/);
  assert.equal(taskOf('p1').state, 'working', 'A copy that was not returned keeps its task open');
  fs.rmSync(path.join(root, 'pool-stuck'));
  r = tl(['finish', 'p1']); assert.equal(r.code, 0, r.out); assert.match(r.out, /working copy returned to treehouse/);
  assert.deepEqual(JSON.parse(fs.readFileSync(treeLog, 'utf8')).at(-1).a, ['return', p1.worktree]);
  assert.equal(taskOf('p1').state, 'closed');
  assert.match(r.out, /; merged branch crew\/p1 deleted/); assert.equal(git('-C', project, 'branch', '--list', 'crew/p1').trim(), '', 'A returned slot leaves no merged branch behind');

  // no-mistakes: a project with the gate is delivered by it; crew only records the result.
  git('-C', project, 'remote', 'add', 'no-mistakes', projectOrigin);
  r = crew(['spawn', 'g0', '--project', 'demo', '--kind', 'ship', '--agent', 'pi', 'x'], { terminal: 'c2' }); assert.equal(r.code, 0);
  assert.equal(taskOf('g0').gate, undefined, 'Without no-mistakes on the machine the task is an ordinary one');
  r = tl(['spawn', 'g1', '--project', 'demo', '--kind', 'ship', '--agent', 'pi', 'Add a fourth line.']); assert.equal(r.code, 0, r.out);
  assert.match(r.out, /delivered through no-mistakes[\s\S]*backlog: start g1/);
  const g1 = taskOf('g1'), g1brief = fs.readFileSync(g1.brief, 'utf8'), intentFile = slash(path.join(homeDir, 'tasks', 'g1', 'intent.md'));
  assert.equal(g1.gate, 'no-mistakes');
  assert.ok(g1brief.includes(`no-mistakes axi run --yes --intent-file ${intentFile}`) && !g1brief.includes('Do not push or open a pull request unless'), g1brief);
  assert.equal(fs.readFileSync(intentFile, 'utf8'), 'Add a fourth line.\n');
  r = tl(['spawn', 'g2', '--project', 'demo', '--agent', 'pi', 'Look.']); assert.ok(!fs.readFileSync(taskOf('g2').brief, 'utf8').includes('no-mistakes'), 'A scout is not gated');
  commit(path.join(copies, 'g1'), { 'README.md': 'one\ntwo\nthree\nfour\n' }, 'Add a fourth line');
  fs.writeFileSync(g1.report, 'The gate stopped.'); assert.equal(crew(['done', 'g1'], { terminal: g1.terminal }).code, 0);
  fs.writeFileSync(ghDown, '');
  r = tl(['land', 'g1']); assert.equal(r.code, 6); assert.match(r.out, /gate has not opened a pull request for it yet/);
  fs.writeFileSync(g1.report, 'Done: https://github.com/acme/demo/pull/9 is open.');
  r = tl(['land', 'g1']); assert.equal(r.code, 0, r.out);
  assert.match(r.out, /delivered g1 through no-mistakes: https:\/\/github\.com\/acme\/demo\/pull\/9\.[\s\S]*backlog: done g1 -> Done/);
  assert.notEqual(spawnSync('git', ['-C', projectOrigin, 'rev-parse', '--verify', '-q', 'crew/g1']).status, 0, 'crew pushed nothing itself');
  assert.match(fs.readFileSync(path.join(homeDir, 'backlog.md'), 'utf8'), /- \[x\] g1 .*\(done https:\/\/github\.com\/acme\/demo\/pull\/9\)/);
  fs.rmSync(ghDown);
  assert.ok(g1brief.includes(intentFile + ' --skip ci`') && g1brief.includes('The gate ends when the pull request is open'), 'By default the gate stops at the open pull request');
  for (const id of ['g0', 'g1', 'g2']) assert.equal(tl(['finish', id, '--force']).code, 0, id);
  // A project says which gate steps it leaves out; push and pull request never are.
  for (const bad of ['push', 'ci,pr', 'nonsense', '']) assert.equal(tl(['project', 'add', 'demo', project, '--gate-skip', bad]).code, 2, bad);
  r = tl(['project', 'add', 'demo', project, '--gate-skip', 'ci,lint']); assert.equal(r.code, 0, r.out); assert.ok(r.out.includes('(gate skips: ci, lint)'));
  assert.equal(tl(['spawn', 'g3', '--project', 'demo', '--kind', 'ship', '--agent', 'pi', 'x']).code, 0);
  assert.ok(fs.readFileSync(taskOf('g3').brief, 'utf8').includes(' --skip ci,lint`'));
  assert.equal(tl(['finish', 'g3', '--force']).code, 0);
  r = tl(['project', 'add', 'demo', project, '--gate-skip', 'none']); assert.ok(r.out.includes('(gate skips: nothing)'));
  assert.equal(tl(['spawn', 'g4', '--project', 'demo', '--kind', 'ship', '--agent', 'pi', 'x']).code, 0);
  const g4brief = fs.readFileSync(taskOf('g4').brief, 'utf8');
  assert.ok(!g4brief.includes('--skip') && g4brief.includes('no-mistakes axi handoff') && g4brief.includes('ten minutes'), 'A watched gate is told how its watch ends');
  assert.equal(tl(['finish', 'g4', '--force']).code, 0);

  // show: the page is opened by lavish-axi, and its address goes on the terminal as the labels
  // Herdr's status bar reads, so the person can open it from wherever they sit.
  const fakeLavish = path.join(root, 'fake-lavish.mjs'), page = path.join(root, 'report.html');
  fs.writeFileSync(page, '<h1>Report</h1>');
  const lavishArgs = path.join(root, 'lavish-args.txt');
  fs.writeFileSync(fakeLavish, `import fs from 'node:fs';
const a = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(lavishArgs)}, a.join(' '));
if (a[0] === '--version') console.log('0.1.96');
else if (a[0].endsWith('broken.html')) { console.error('error: the user ended this session'); process.exit(1); }
else console.log('session: opened\\nurl: "http://127.0.0.1:4387/session/d849b898fa86dff9"\\nfile: ' + a[0]);
`);
  const L = { CREW_TOOL_LAVISH_AXI: fakeLavish };
  assert.equal(crew(['show'], { terminal: 'c2', env: L }).code, 2);
  assert.equal(crew(['show', path.join(root, 'none.html')], { terminal: 'c2', env: L }).code, 2);
  assert.equal(crew(['show', page], { terminal: 'c2' }).code, 4, 'No lavish-axi, no page');
  r = crew(['show', page], { terminal: 'c2', env: L }); assert.equal(r.code, 0, r.out);
  assert.match(r.out, /shown: http:\/\/127\.0\.0\.1:4387\/session\/d849b898fa86dff9\n.*Lavish link in the status bar/);
  // In a Herdr terminal no browser is opened on this machine; a timed request label asks
  // Herdr to open the page where the person is.
  assert.ok(fs.readFileSync(lavishArgs, 'utf8').endsWith('--no-open'));
  assert.match(readWorld().log.filter(a => a[0] === 'label').at(-1)[2], /^custom\.preview\.open=\d{13}$/);
  assert.deepEqual(readWorld().log.filter(a => a[0] === 'label').slice(-3, -1), [['label', 'c2', 'custom.preview.url=http://127.0.0.1:4387/session/d849b898fa86dff9'], ['label', 'c2', 'custom.preview.label=Lavish']]);
  const before = readWorld().log.length;
  r = crew(['show', page], { env: L }); assert.equal(r.code, 0); assert.match(r.out, /not a Herdr terminal/);
  assert.ok(!fs.readFileSync(lavishArgs, 'utf8').includes('--no-open'), 'Outside Herdr lavish-axi opens the page itself');
  assert.equal(readWorld().log.length, before, 'Outside a terminal nothing is labelled');
  fs.writeFileSync(path.join(root, 'broken.html'), 'x');
  r = crew(['show', path.join(root, 'broken.html')], { terminal: 'c2', env: L }); assert.equal(r.code, 4); assert.match(r.out, /did not open the page: error: the user ended this session/);

  console.log('PASS: Firstmate\'s tools (list, backlog, treehouse copies, no-mistakes delivery), follow-ups, review, delivery as a pull request, self-repair (crash record, fix, guarded selfmerge, update at start, rollback) and crew helpers, status durations, home and project setup, single ownership, spawn request, worker report, wait outcomes, guarded finish, owner takeover, project removal, the Claude worker command, its folder trust and account choice, and the five reviewed defects');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
