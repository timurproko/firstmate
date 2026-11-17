// Runs with plain `node crew/crew.test.mjs`. Core is replaced by a small fake `hc`, so no
// terminal, agent or machine is touched; the live checks are recorded in crew/README.md.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validId, shq, bashPath, briefText, agentCommand, AGENTS, main } from './crew.mjs';

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
  assert.equal(agentCommand('claude', AGENTS.claude, 'do it', {}), "'claude' 'do it' '--permission-mode' 'acceptEdits' '--allowedTools' 'Bash,Read,Edit,Write,Glob,Grep'");
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
  const env = { ...process.env, CREW_CLAUDE_CONFIG: claudeConfig, HOME: fakeUser, USERPROFILE: fakeUser, CREW_HC: fake, CREW_SETTLE_SECONDS: '2', CREW_WORKTREES: path.join(root, 'copies'), CREW_HOME: '', HC_TERMINAL_ID: '', CREW_TERMINAL: terminal ?? '', ...extra };
  delete env.CREW_HOME;
  const r = spawnSync(process.execPath, [path.join(here, 'crew.mjs'), ...args], { encoding: 'utf8', cwd: fs.existsSync(cwd) ? cwd : root, env, shell: false });
  return { code: r.status, out: r.stdout + r.stderr };
}
const git = (...args) => { const r = spawnSync('git', args, { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout; };

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
      { id: 'failed', state: 'failed', spawned: ago(7200), updated: ago(3600), seconds: 3600, text: '1h' },
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
        assert.ok(output.includes(`${task.id}\t${task.state}\tship/pi\tdemo\t-\t${task.text}`), task.id);
      }
      assert.ok(!output.some(line => line.startsWith('closed\t')), 'Closed tasks stay hidden by default');
      output.length = 0;
      main(['status', '--all', '--json']);
      const tasks = JSON.parse(output[0]).tasks;
      for (const task of cases) assert.equal(tasks.find(t => t.id === task.id).elapsedSeconds, task.seconds, task.id);
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
  assert.ok(crew(['init'], { cwd: root }).out.includes('/user/.crew/home'), 'The default home is under the user folder');
  assert.ok(crew(['status'], { cwd: root }).out.includes('.crew/home - no owner'), 'crew finds the default home from any folder');
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
  for (const want of ['--bg', '--keep', '--no-parent', '--no-notify', 'crew.task=t1', 'herdr.right-click=menu']) assert.ok(call.includes(want), want);
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
  assert.ok(claudeLine.includes("'claude' 'Read the brief at ") && claudeLine.includes(" and carry it out exactly.' '--permission-mode' 'acceptEdits' '--allowedTools' 'Bash,Read,Edit,Write,Glob,Grep'; exec bash"), claudeLine);
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
  fs.writeFileSync(path.join(f1copy, 'half-done.txt'), 'unsaved');
  r = crew(['finish', 'f1'], { terminal: 'c2' }); assert.equal(r.code, 6); assert.match(r.out, /has uncommitted work .*half-done\.txt/);
  assert.equal(fs.readFileSync(path.join(f1copy, 'half-done.txt'), 'utf8'), 'unsaved');
  assert.equal(crew(['finish', 'f1', '--force'], { terminal: 'c2' }).code, 0);
  assert.ok(!fs.existsSync(f1copy), 'Discarding was asked for');
  assert.ok(git('-C', project, 'branch', '--list', 'crew/f1').includes('crew/f1'), 'The branch stays');
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
  const who = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid'];
  const commit = (folder, files, message) => {
    for (const [name, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true }); fs.writeFileSync(path.join(folder, name), text); }
    git('-C', folder, 'add', '-A'); git('-C', folder, ...who, 'commit', '-q', '-m', message);
    return git('-C', folder, 'rev-parse', 'HEAD').trim();
  };
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

  console.log('PASS: self-repair (crash record, fix, guarded selfmerge, update at start, rollback) and crew helpers, status durations, home and project setup, single ownership, spawn request, worker report, wait outcomes, guarded finish, owner takeover, project removal, the Claude worker command, its folder trust and account choice, and the five reviewed defects');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
