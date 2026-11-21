// Runs with plain `node crew/crew.test.mjs`. Core is replaced by a small fake `hc`, so no
// terminal, agent or machine is touched; the live checks are recorded in crew/README.md.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validId, shq, bashPath, briefText, agentCommand, cleanProfile, quotaVerdict, githubOwner, AGENTS, TOOLS, main, snapshotCopy, repairFile } from './crew.mjs';

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
// A plain and a gated ship brief stay exactly what they were before the shared delivery workflow
// was known; a scout's brief does not change for a workflow project; the gate wins over it.
{
  const ship = { id: 't1', kind: 'ship', task: 'x', worktree: 'W', project: 'p', report: 'R' };
  const ends = '- When you are finished, write your result to `R` in Markdown, with the answer in the first lines.\n- Then run `crew done t1` and stop. Do not start any other work.\n- If you cannot finish, write what blocked you to the same file and still run the command.\n';
  const start = '# Task t1 (ship)\n\nx\n\n## Rules\n- Work only inside `W`. It is your own copy of the project `p`; nobody else uses it.\n';
  assert.equal(briefText(ship), `${start}- Make your changes on the branch already checked out here and commit them. Do not push or open a pull request unless the task says so.\n${ends}`);
  const gated = `${start}- Make your changes on the branch already checked out here and commit them.\n- This project is delivered through the no-mistakes gate, which reviews, tests, pushes and opens the pull request itself. After committing, run \`no-mistakes axi run --yes --intent-file I --skip ci\` here and do what it prints (\`no-mistakes axi --help\`) until it reports an outcome. A wait that runs out is not a failure: run the same command again to go on. Do not push or open a pull request any other way.\n- The gate ends when the pull request is open. Its checks are not watched here: the person reads them on the pull request.\n- Put the pull request link the gate gives you in the first lines of your report. If the gate stops on something only a person can decide, say exactly what in the report.\n${ends}`;
  assert.equal(briefText({ ...ship, gate: 'I', gateSkip: ['ci'] }), gated);
  assert.equal(briefText({ ...ship, gate: 'I', gateSkip: ['ci'], workflow: true, branch: 'fix/t1' }), gated);
  assert.equal(briefText({ ...ship, kind: 'scout', workflow: true }), briefText({ ...ship, kind: 'scout' }));
  const flow = briefText({ ...ship, workflow: true, branch: 'fix/t1' });
  for (const line of ['load the `change-delivery` skill', 'Run `delivery update`', '`delivery start fix/t1` returns this same folder', 'then STOP', '`Plan: <pull request link>`', '`Implementation: <pull request link>`', 'Never mark the pull request ready and never merge it.', 'crew done t1']) assert.ok(flow.includes(line), line);
  assert.ok(!flow.includes('Do not push or open a pull request'), flow);
}

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
else if (a[0] === 'get') { const t = w.terminals[a.at(-1)]; if (t?.steps?.length) Object.assign(t, t.steps.shift()); save(); if (!t) { console.error(JSON.stringify({ error: { kind: 'not_found' } })); process.exit(3); } console.log(JSON.stringify(t)); }
else if (a[0] === 'kill') { const t = w.terminals[a.at(-1)]; if (t) t.state = 'finished'; if (w.writeOnKill) fs.writeFileSync(w.writeOnKill, 'written while stopping'); if (w.silentAfterKill) w.silent = true; save(); }
else if (a[0] === 'rm') { if (!w.failRm) delete w.terminals[a.at(-1)]; if (w.silentLsAfterRm) w.silentLs = true; if (w.silentAfterRm) w.silent = true; save(); }
else if (a[0] === 'ls' && w.silentLs) { save(); console.error('Core transport unavailable'); process.exit(1); }
else if (a[0] === 'ls') { save(); console.log(JSON.stringify({ terminals: Object.values(w.terminals).map(t => ({ address: t.address, agent: t.agent ?? null, cwd: t.cwd, state: t.state })) })); }
else if (a[0] === 'read') { save(); process.stdout.write(w.terminals[a[1]]?.screen ?? ''); }
else if (a[0] === 'send') {
  const t = w.terminals[a[1]];
  if (t?.sendError) { save(); console.error('send transport unavailable'); process.exit(1); }
  if (t?.onSends?.length) Object.assign(t, t.onSends.shift());
  if (t?.reportOnSend) {
    const task = JSON.parse(fs.readFileSync(t.reportOnSend, 'utf8'));
    fs.writeFileSync(task.report, 'Complete');
    fs.writeFileSync(t.reportOnSend, JSON.stringify({ ...task, state: 'reported', reported: new Date().toISOString(), tells: 9 }));
  }
  save();
}
else save();
`);
const readWorld = () => JSON.parse(fs.readFileSync(world, 'utf8'));
const setTerminal = (address, patch) => { const w = readWorld(); Object.assign(w.terminals[address], patch); fs.writeFileSync(world, JSON.stringify(w)); };

const homeDir = path.join(root, 'home'), project = path.join(root, 'project'), fakeUser = path.join(root, 'user');
fs.mkdirSync(fakeUser);
const claudeConfig = path.join(root, 'claude.json');
fs.writeFileSync(claudeConfig, JSON.stringify({ theme: 'dark', projects: { 'C:/mine': { hasTrustDialogAccepted: true, history: [1] } } }));
function crew(args, { terminal, cwd = homeDir, env: extra = {}, script = path.join(here, 'crew.mjs') } = {}) {
  const env = { ...process.env, CREW_CLAUDE_CONFIG: claudeConfig, HOME: fakeUser, USERPROFILE: fakeUser, CREW_HC: fake, CREW_SETTLE_SECONDS: '2', CREW_WORKTREES: path.join(root, 'copies'), CREW_HOME: '', HC_TERMINAL_ID: '', CREW_TERMINAL: terminal ?? '',
    // No tool of the machine the suite runs on is seen, unless a test names a fake one.
    CREW_TOOL_PATH: path.join(root, 'no-tools'), ...Object.fromEntries(TOOLS.map(t => [`CREW_TOOL_${t.id.toUpperCase().replace(/-/g, '_')}`, ''])), ...extra };
  delete env.CREW_HOME;
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: fs.existsSync(cwd) ? cwd : root, env, shell: false });
  return { code: r.status, out: r.stdout + r.stderr };
}
const git = (...args) => { const r = spawnSync('git', args, { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
const who = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid'];
const commit = (folder, files, message) => {
  for (const [name, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true }); fs.writeFileSync(path.join(folder, name), text); }
  git('-C', folder, 'add', '-A'); git('-C', folder, ...who, 'commit', '-q', '-m', message);
  return git('-C', folder, 'rev-parse', 'HEAD').trim();
};

// Run a focused regression with --gaps=ignored (or all new regressions with --gaps).
const gapTests = {};
gapTests['repair-scope'] = () => {
  for (const file of ['crew.mjs', 'crew.test.mjs', 'README.md', 'bin/crew', 'bin/crew.cmd', 'docs/guide.md']) assert.ok(repairFile(file), file);
  for (const file of ['.github/workflows/ci.yml', 'AGENTS.md', 'CLAUDE.md', 'package.json', 'scripts/build.mjs', 'LICENSE', '.gitignore', '.gitattributes', 'other.mjs', 'bin-other/file']) assert.ok(!repairFile(file), file);
};
function repairFixture(name) {
  const dir = path.join(root, `repair-${name}`), seed = path.join(dir, 'seed'), repo = path.join(dir, 'core'), origin = path.join(dir, 'github.com', 'acme', 'crew.git'), home = path.join(dir, 'home');
  const owner = `repair-owner-${name}`;
  fs.mkdirSync(seed, { recursive: true }); git('-C', seed, 'init', '-q', '-b', 'main');
  fs.cpSync(here, path.join(seed, 'crew'), { recursive: true });
  commit(seed, { 'package.json': '{"private":true}\n', 'crew/docs/selftest.mjs': "import fs from 'node:fs'; process.exit(fs.existsSync(new URL('./broken', import.meta.url)) ? 1 : 0);\n" }, 'baseline');
  git('clone', '-q', '--bare', seed, origin); git('clone', '-q', slash(origin), repo);
  git('-C', repo, 'config', 'user.name', 't'); git('-C', repo, 'config', 'user.email', 't@example.invalid');
  const fakeGh = path.join(dir, 'gh.mjs'), log = path.join(dir, 'gh.json'), merged = path.join(dir, 'merged'), deliveryLog = path.join(dir, 'delivery.json'), delivery = path.join(dir, 'delivery.mjs');
  fs.writeFileSync(log, '[]'); fs.writeFileSync(deliveryLog, '[]');
  fs.writeFileSync(fakeGh, `import fs from 'node:fs';
const a = process.argv.slice(2), file = ${JSON.stringify(log)}, log = JSON.parse(fs.readFileSync(file, 'utf8'));
log.push({ a, token: process.env.GH_TOKEN === 'fake-token', body: a.includes('--body-file') ? fs.readFileSync(a[a.indexOf('--body-file') + 1], 'utf8') : null }); fs.writeFileSync(file, JSON.stringify(log));
if (a[0] === 'auth') { console.log('fake-token'); process.exit(0); }
if (a[1] === 'list') { console.log(fs.existsSync(${JSON.stringify(merged)}) ? fs.readFileSync(${JSON.stringify(merged)}, 'utf8') : ''); process.exit(0); }
console.log('https://github.com/acme/crew/pull/1');
`);
  fs.writeFileSync(delivery, `import fs from 'node:fs'; const a = process.argv.slice(2), f = ${JSON.stringify(deliveryLog)}; fs.writeFileSync(f, JSON.stringify([...JSON.parse(fs.readFileSync(f, 'utf8')), a])); if (a[0] !== 'check-body' || !a.includes('--final')) process.exit(1);`);
  const script = path.join(repo, 'crew', 'crew.mjs');
  const w = readWorld(); w.terminals[owner] = { address: owner, state: 'live', labels: {} }; fs.writeFileSync(world, JSON.stringify(w));
  const env = { CREW_CLAUDE_ACCOUNTS: '', CREW_GH: fakeGh, CREW_SELFTEST: 'node crew/docs/selftest.mjs', CREW_WORKTREES: path.join(dir, 'copies') };
  const call = (args, extra = {}) => crew(args, { script, cwd: home, terminal: owner, env: { ...env, ...extra } });
  assert.equal(call(['init', home]).code, 0); assert.equal(call(['start']).code, 0);
  const task = id => JSON.parse(fs.readFileSync(path.join(home, 'tasks', id, 'task.json'), 'utf8'));
  const reported = t => { fs.writeFileSync(t.report, 'Repaired.'); const r = crew(['done', t.id], { script, cwd: home, terminal: t.terminal, env }); assert.equal(r.code, 0, r.out); };
  return { dir, repo, origin, home, call, task, reported, log, merged, delivery, deliveryLog };
}
gapTests.selfrepair = () => {
  const f = repairFixture('nested'), first = git('-C', f.origin, 'rev-parse', 'main').trim();
  let r = f.call(['fix', '--agent', 'pi', 'Repair the reported defect.']); assert.equal(r.code, 0, r.out);
  const t = f.task('fix-1'); f.reported(t);
  commit(t.worktree, { 'crew/unrelated.txt': 'Not a tool file.\n' }, 'outside the allowlist');
  r = f.call(['selfrepair', t.id]); assert.equal(r.code, 6, r.out); assert.match(r.out, /outside crew's own files/);
  assert.equal(JSON.parse(fs.readFileSync(f.log, 'utf8')).length, 0);
  git('-C', t.worktree, 'reset', '-q', '--hard', 'HEAD~1');
  commit(t.worktree, { 'crew/docs/repair.md': 'The repair.\n' }, 'fix(crew): repair the reported defect');
  const rejectedBody = path.join(f.dir, 'rejected-body.mjs'); fs.writeFileSync(rejectedBody, "console.error('invalid repair body'); process.exit(1);\n");
  r = f.call(['selfrepair', t.id], { CREW_TOOL_DELIVERY: rejectedBody }); assert.equal(r.code, 6, r.out); assert.match(r.out, /body was rejected/);
  assert.equal(spawnSync('git', ['-C', f.origin, 'rev-parse', '--verify', `refs/heads/${t.branch}`]).status, 128, 'Body rejection must precede publication');
  r = f.call(['selfrepair', t.id], { CREW_TOOL_DELIVERY: f.delivery }); assert.equal(r.code, 0, r.out);
  assert.match(r.out, /https:\/\/github.com\/acme\/crew\/pull\/1/); assert.match(r.out, /not updated/);
  assert.equal(f.task(t.id).pr, 'https://github.com/acme/crew/pull/1');
  assert.equal(git('-C', f.origin, 'rev-parse', 'main').trim(), first);
  assert.equal(git('-C', f.repo, 'rev-parse', 'HEAD').trim(), first);
  const tip = git('-C', t.worktree, 'rev-parse', 'HEAD').trim();
  assert.equal(git('-C', f.origin, 'rev-parse', t.branch).trim(), tip);
  const calls = JSON.parse(fs.readFileSync(f.log, 'utf8')), made = calls.find(x => x.a[1] === 'create');
  assert.deepEqual(calls.find(x => x.a[0] === 'auth').a, ['auth', 'token', '--user', 'acme']); assert.ok(made.token);
  assert.ok(made.a.includes('--draft')); assert.equal(made.a[made.a.indexOf('--base') + 1], 'main');
  assert.match(made.body, /^## Proposal[\s\S]*## Implementation\n\n- \[x\] [^\n]+[\s\S]*## Acceptance/); assert.ok(!made.body.includes('## Automation'));
  assert.equal((made.body.match(/^- \[x\]/gm) || []).length, 1, 'One delivered outcome describes this repair');
  assert.ok(made.body.includes('fix(crew): repair the reported defect')); assert.ok(!made.body.includes('- [ ]'));
  assert.deepEqual(JSON.parse(fs.readFileSync(f.deliveryLog, 'utf8'))[0].filter(a => a.startsWith('--')), ['--body-file', '--final']);
  r = f.call(['selfmerge', t.id]); assert.equal(r.code, 0, r.out); assert.match(r.out, /already has a pull request/);
  assert.equal(JSON.parse(fs.readFileSync(f.log, 'utf8')).filter(x => x.a[1] === 'create').length, 1);
  r = f.call(['finish', t.id]); assert.equal(r.code, 0, r.out);
  assert.ok(git('-C', f.repo, 'branch', '--list', t.branch).trim(), 'An unmerged repair keeps its commits');
  assert.equal(f.call(['fix', '--agent', 'pi', 'Repair another defect.']).code, 0);
  const t2 = f.task('fix-2'); f.reported(t2);
  const tip2 = commit(t2.worktree, { 'crew/docs/second.md': 'Second repair.\n' }, 'fix(crew): repair another defect');
  assert.equal(f.call(['selfrepair', t2.id]).code, 0);
  fs.writeFileSync(f.merged, tip2);
  r = f.call(['finish', t2.id]); assert.equal(r.code, 0, r.out); assert.match(r.out, /merged branch fix\/fix-2 deleted/);
};
function gapFixture(name, extra = {}) {
  const dir = path.join(root, `gap-${name}`), home = path.join(dir, 'home'), repo = path.join(dir, 'repo');
  fs.mkdirSync(repo, { recursive: true }); git('-C', repo, 'init', '-q');
  commit(repo, { 'README.md': 'baseline\n', '.gitignore': 'scratch/\nloose.log\n' }, 'baseline');
  const owner = `owner-${name}`, w = readWorld(); w.terminals[owner] = { address: owner, state: 'live', labels: {} }; fs.writeFileSync(world, JSON.stringify(w));
  const call = (args, env = {}) => crew(args, { cwd: home, terminal: owner, env: { CREW_CLAUDE_ACCOUNTS: '', ...extra, ...env } });
  assert.equal(call(['init', home]).code, 0);
  assert.equal(call(['project', 'add', 'demo', repo]).code, 0);
  assert.equal(call(['start']).code, 0);
  const taskFile = id => path.join(home, 'tasks', id, 'task.json');
  const task = id => JSON.parse(fs.readFileSync(taskFile(id), 'utf8'));
  const save = t => fs.writeFileSync(taskFile(t.id), JSON.stringify(t));
  const spawn = (id, flags = []) => { const r = call(['spawn', id, '--project', 'demo', ...flags, 'Count lines.']); assert.equal(r.code, 0, r.out); return task(id); };
  const guest = t => { const w = readWorld(); w.terminals[`guest-${name}`] = { address: `guest-${name}`, state: 'live', labels: {}, cwd: t.worktree }; fs.writeFileSync(world, JSON.stringify(w)); };
  const leave = () => { const w = readWorld(); delete w.terminals[`guest-${name}`]; fs.writeFileSync(world, JSON.stringify(w)); };
  return { dir, home, repo, call, task, save, spawn, guest, leave };
}
gapTests.ignored = () => {
  const f = gapFixture('ignored'), count = Math.max(12001, Number(process.env.CREW_TEST_IGNORED_FILES) || 12001);
  const fill = t => { fs.mkdirSync(path.join(t.worktree, 'scratch')); for (let i = 0; i < count; i++) fs.writeFileSync(path.join(t.worktree, 'scratch', `${i}.txt`), 'old'); fs.utimesSync(path.join(t.worktree, 'scratch'), 1700000000, 1700000000); };
  const changed = f.spawn('changed'); fill(changed); f.guest(changed);
  let r = f.call(['finish', changed.id]); assert.equal(r.code, 0, r.out);
  const before = fs.statSync(path.join(changed.worktree, 'scratch'));
  fs.writeFileSync(path.join(changed.worktree, 'scratch', '0.txt'), 'new');
  fs.utimesSync(path.join(changed.worktree, 'scratch'), before.atime, before.mtime);
  f.leave(); r = f.call(['start']); assert.equal(r.code, 0, r.out);
  assert.ok(fs.existsSync(changed.worktree), 'An existing ignored file changed after finish must keep the copy');
  assert.match(r.out, /work written since finish.*scratch/);
  r = f.call(['finish', changed.id]); assert.equal(r.code, 0, r.out); assert.ok(fs.existsSync(changed.worktree));
  r = f.call(['finish', changed.id, '--force']); assert.equal(r.code, 0, r.out); assert.ok(!fs.existsSync(changed.worktree));

  const untouched = f.spawn('untouched'); fill(untouched); f.guest(untouched);
  const start = performance.now(), snapshot = snapshotCopy(untouched.worktree), elapsed = performance.now() - start;
  console.log(`ignored walk: ${count} files, ${elapsed.toFixed(1)} ms, ${JSON.stringify(snapshot).length} stored bytes`);
  assert.equal(snapshot.ignored['scratch/'].files, count); assert.equal(snapshot.incomplete, null);
  assert.ok(JSON.stringify(snapshot).length < 2000, 'The stored fingerprint is bounded independently of file count');
  r = f.call(['finish', untouched.id]); assert.equal(r.code, 0, r.out);
  f.leave(); r = f.call(['start']); assert.equal(r.code, 0, r.out); assert.ok(!fs.existsSync(untouched.worktree), r.out);

  const uncertain = f.spawn('uncertain'); fill(uncertain); f.guest(uncertain);
  const tree = path.join(uncertain.worktree, 'scratch'), first = snapshotCopy(uncertain.worktree).ignored['scratch/'];
  fs.rmSync(path.join(tree, '0.txt'));
  assert.equal(snapshotCopy(uncertain.worktree).ignored['scratch/'].files, count - 1, 'Removal changes the fingerprint');
  fs.writeFileSync(path.join(tree, 'added.txt'), 'old');
  assert.notEqual(snapshotCopy(uncertain.worktree).ignored['scratch/'].metadata, first.metadata, 'Same-count, same-size replacement changes the metadata digest');
  const outside = path.join(f.dir, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'external.txt'), 'one');
  fs.symlinkSync(outside, path.join(tree, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const linked = snapshotCopy(uncertain.worktree).ignored['scratch/'];
  fs.writeFileSync(path.join(outside, 'external.txt'), 'changed outside');
  assert.deepEqual(snapshotCopy(uncertain.worktree).ignored['scratch/'], linked, 'Directory symlink targets are not inspected');
  assert.match(snapshotCopy(uncertain.worktree, { budgetMs: 0 }).incomplete, /time budget/);
  const lstat = fs.lstatSync;
  try {
    fs.lstatSync = (file, ...args) => { if (String(file).endsWith(`${path.sep}added.txt`)) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return lstat(file, ...args); };
    assert.match(snapshotCopy(uncertain.worktree).incomplete, /could not read.*added\.txt/);
  } finally { fs.lstatSync = lstat; }
  r = f.call(['finish', uncertain.id]); assert.equal(r.code, 0, r.out); f.leave();
  const saved = f.task(uncertain.id); saved.copyToReturn.left.incomplete = 'ignored walk exceeded its time budget'; f.save(saved);
  r = f.call(['start']); assert.ok(fs.existsSync(uncertain.worktree)); assert.match(r.out, /time budget/);
  delete saved.copyToReturn.left.ignoredVersion; delete saved.copyToReturn.left.incomplete; f.save(saved);
  r = f.call(['start']); assert.ok(fs.existsSync(uncertain.worktree)); assert.match(r.out, /older snapshot/);
  assert.equal(f.call(['finish', uncertain.id, '--force']).code, 0);
};

gapTests.finish = () => {
  const f = gapFixture('finish'), patch = p => { const w = readWorld(); Object.assign(w, p); fs.writeFileSync(world, JSON.stringify(w)); };
  const dirty = f.spawn('dirty', ['--kind', 'ship']);
  const untouched = (task, message) => {
    const before = readWorld().log.length, original = fs.readFileSync(path.join(f.home, 'tasks', task.id, 'task.json'), 'utf8');
    const r = f.call(['finish', task.id]); assert.equal(r.code, 6, r.out); assert.match(r.out, message);
    assert.equal(readWorld().terminals[task.terminal].state, 'live', 'Refusing finish must leave the worker alive');
    assert.ok(!readWorld().log.slice(before).some(a => ['kill', 'rm'].includes(a[0])), 'A refusal sends no stop/removal command');
    assert.equal(fs.readFileSync(path.join(f.home, 'tasks', task.id, 'task.json'), 'utf8'), original);
    assert.ok(fs.existsSync(task.worktree));
  };
  fs.writeFileSync(path.join(dirty.worktree, 'half.txt'), 'unsaved'); untouched(dirty, /has uncommitted work/); fs.rmSync(path.join(dirty.worktree, 'half.txt'));
  const keep = f.spawn('keep'); fs.mkdirSync(path.join(keep.worktree, '.artifacts')); fs.writeFileSync(path.join(keep.worktree, '.artifacts', 'KEEP'), '');
  untouched(keep, /marked to keep/); fs.rmSync(path.join(keep.worktree, '.artifacts'), { recursive: true });
  const gitFile = path.join(dirty.worktree, '.git'); fs.renameSync(gitFile, `${gitFile}-saved`); fs.writeFileSync(gitFile, 'gitdir: missing\n');
  untouched(dirty, /Could not check.*uncommitted work/); fs.rmSync(gitFile); fs.renameSync(`${gitFile}-saved`, gitFile);
  assert.equal(f.call(['finish', keep.id]).code, 0);

  patch({ writeOnKill: path.join(dirty.worktree, 'late.txt') });
  let r = f.call(['finish', dirty.id]); assert.equal(r.code, 0, r.out); patch({ writeOnKill: null });
  assert.equal(f.task(dirty.id).state, 'closed'); assert.ok(fs.existsSync(path.join(dirty.worktree, 'late.txt'))); assert.match(r.out, /kept for now.*work written|kept for now.*uncommitted/);
  r = f.call(['start']); assert.ok(fs.existsSync(dirty.worktree)); assert.match(r.out, /work written since finish/);
  assert.equal(f.call(['finish', dirty.id, '--force']).code, 0);

  const stopping = f.spawn('stopping'); patch({ silentAfterKill: true });
  r = f.call(['finish', stopping.id]); assert.equal(r.code, 0, r.out);
  assert.ok(f.task(stopping.id).copyToReturn?.stopPending && fs.existsSync(stopping.worktree), 'An unconfirmed stop postpones return instead of refusing after changing the worker');
  patch({ silentAfterKill: false, silent: false }); r = f.call(['start']); assert.equal(r.code, 0, r.out); assert.ok(!fs.existsSync(stopping.worktree));

  const second = f.spawn('second'); patch({ silentLsAfterRm: true });
  r = f.call(['finish', second.id]); assert.equal(r.code, 0, r.out);
  assert.equal(f.task(second.id).state, 'closed'); assert.ok(f.task(second.id).copyToReturn && fs.existsSync(second.worktree));
  assert.match(r.out, /Core did not say.*crew (?:start|finish)|Core did not say.*next.*(?:start|finish)/);
  patch({ silentLsAfterRm: false, silentLs: false }); r = f.call(['start']); assert.equal(r.code, 0, r.out); assert.ok(!fs.existsSync(second.worktree));

  const removal = f.spawn('removal'); patch({ silentAfterRm: true });
  r = f.call(['finish', removal.id]); assert.equal(r.code, 0, r.out); assert.ok(f.task(removal.id).copyToReturn && fs.existsSync(removal.worktree));
  patch({ silentAfterRm: false, silent: false }); r = f.call(['finish', removal.id]); assert.equal(r.code, 0, r.out); assert.ok(!fs.existsSync(removal.worktree));

  // A proved API exit can leave the wrapper shell live. A persisted cleanup retries that
  // shell too; it must never become an indefinitely held copy after the worker has left.
  const shell = f.spawn('shell');
  f.save({ ...shell, state: 'closed', closed: new Date().toISOString(), copyToReturn: { since: new Date().toISOString(), left: snapshotCopy(shell.worktree), cleanupTerminal: true } });
  r = f.call(['finish', shell.id]); assert.equal(r.code, 0, r.out); assert.ok(!fs.existsSync(shell.worktree), r.out);
  assert.ok(!readWorld().terminals[shell.terminal]);
};

gapTests.chain = () => {
  const dir = path.join(root, 'gap-quota'); fs.mkdirSync(dir); const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  for (const name of ['a1', 'pi', 'claude']) fs.writeFileSync(path.join(bin, name), '');
  const quota = path.join(dir, 'quota.json'), log = path.join(dir, 'reads.log'), tool = path.join(dir, 'quota.mjs');
  fs.writeFileSync(tool, `import fs from 'node:fs';
const q = JSON.parse(fs.readFileSync(${JSON.stringify(quota)}, 'utf8')), a = process.argv.slice(2), families = a[a.indexOf('--provider') + 1].split(',');
fs.appendFileSync(${JSON.stringify(log)}, families.join(',') + '\\n');
console.log(JSON.stringify({providers: families.map(provider => q[provider] === 'login' ? {provider, state: {error: 'unauthorized'}, quotaSemantics: {status: 'unknown'}} : {provider, quotaSemantics: {status: 'known', effectiveAvailability: [{scope: 'all_models', effectivePercentRemaining: q[provider]}]}})}));`);
  const setQuota = q => fs.writeFileSync(quota, JSON.stringify(q)); setQuota({ codex: 0, claude: 'login', copilot: 70 });
  const f = gapFixture('chain', { CREW_TOOL_QUOTA_AXI: tool, CREW_AGENT_PATH: bin }); fs.mkdirSync(path.join(f.home, 'config'));
  fs.writeFileSync(path.join(f.home, 'config', 'crew-dispatch.json'), JSON.stringify({ default: [
    { harness: 'a1', model: 'custom/gpt-x', provider: 'codex' }, { harness: 'claude', model: 'opus' }, { harness: 'pi', model: 'github-copilot/gpt-x' }] }));
  const task = f.spawn('recover'); assert.equal(task.agent, 'pi');
  assert.deepEqual(task.chain.map(c => c.harness), ['a1', 'claude'], 'Passed-over candidates remain in the original chain');
  let shown = JSON.parse(f.call(['status', '--json']).out).tasks.find(t => t.id === task.id);
  assert.deepEqual(shown.standbyStatus.map(c => [c.status, c.passedOver]), [['exhausted', true], ['signed-out', true]]);
  assert.ok(shown.standbyStatus.every(c => c.checkedAt && c.note));
  setQuota({ codex: 60, claude: 'login', copilot: 0 }); fs.writeFileSync(log, '');
  setTerminal(task.terminal, { status: { state: 'error', app: 'pi' }, screen: 'usage limit reached' });
  let r = f.call(['wait', task.id, '--timeout', '6']); assert.equal(r.code, 124, r.out);
  assert.equal(f.task(task.id).agent, 'a1', 'Automatic hand-over reconsiders recovered candidates');
  assert.equal(f.task(task.id).launch.family, 'codex', 'The quota-family override survives saving and hand-over');
  assert.ok(!fs.readFileSync(log, 'utf8').includes('copilot'), 'The current/tried worker is not read again');
  setQuota({ codex: 0, claude: 70, copilot: 80 }); fs.writeFileSync(log, '');
  r = f.call(['relaunch', task.id]); assert.equal(r.code, 0, r.out); assert.equal(f.task(task.id).agent, 'claude', 'Unnamed relaunch reconsiders a recovered login');
  assert.equal(fs.readFileSync(log, 'utf8').trim(), 'claude', 'Only the untried candidate is read');
  assert.deepEqual(f.task(task.id).candidates.map(c => c.harness), ['a1', 'claude', 'pi']);
  assert.equal(f.call(['relaunch', task.id]).code, 8, 'Unnamed relaunch never repeats an already tried candidate');
  setQuota({ codex: 70, claude: 70, copilot: 80 });
  assert.equal(f.call(['relaunch', task.id, '--agent', 'a1', '--model', 'openai-codex/gpt-x']).code, 0, 'A named relaunch may retry an earlier choice');
  assert.equal(f.call(['finish', task.id, '--force']).code, 0);
};

gapTests['review-stop-race'] = () => {
  const f = gapFixture('review-race'), patch = p => { const w = readWorld(); Object.assign(w, p); fs.writeFileSync(world, JSON.stringify(w)); };
  const lost = [];
  for (const [id, flags, file, closed] of [
    ['ship-ignored', ['--kind', 'ship'], 'scratch/late.txt', false],
    ['scout-scratch', [], 'late.txt', false],
    ['forced-ship', ['--kind', 'ship', '--force'], 'late.txt', false],
    ['forced-scout', ['--force'], 'scratch/late.txt', false],
    ['closed-force', ['--force'], 'late.txt', true],
    ['closed-normal', [], 'late.txt', true],
  ]) {
    const force = flags.includes('--force'), t = f.spawn(id, flags.filter(flag => flag !== '--force'));
    if (file.startsWith('scratch/')) { fs.mkdirSync(path.join(t.worktree, 'scratch')); fs.writeFileSync(path.join(t.worktree, 'scratch', 'before.txt'), 'accepted'); }
    if (force && !closed) setTerminal(t.terminal, { status: { state: 'working', app: t.agent } });
    if (closed) f.save({ ...t, state: 'closed', closed: new Date().toISOString(), copyToReturn: { since: new Date().toISOString(), left: snapshotCopy(t.worktree), cleanupTerminal: true } });
    const late = path.join(t.worktree, file); patch({ writeOnKill: late });
    let r = f.call(['finish', id, ...(force ? ['--force'] : [])]); patch({ writeOnKill: null });
    assert.equal(r.code, 0, r.out);
    if (!fs.existsSync(late)) { lost.push(`${id}: work written while stopping was deleted`); continue; }
    assert.equal(f.task(id).state, 'closed'); assert.ok(f.task(id).copyToReturn, r.out);
    assert.match(r.out, /work written since finish/);
    r = f.call(['start']); assert.equal(r.code, 0, r.out); assert.ok(fs.existsSync(late), 'Automatic sweeps do not inherit the original force');
    r = f.call(['finish', id]); assert.equal(r.code, 0, r.out); assert.ok(fs.existsSync(late), 'A normal retry still protects late work');
    assert.equal(f.call(['finish', id, '--force']).code, 0); assert.ok(!fs.existsSync(t.worktree), 'Only a new explicit forced finish accepts the late work');
  }
  assert.deepEqual(lost, [], 'Every initial and resumed finish compares the post-stop copy, even with force');
};

gapTests['review-force-retry'] = () => {
  const f = gapFixture('review-force'), patch = p => { const w = readWorld(); Object.assign(w, p); fs.writeFileSync(world, JSON.stringify(w)); };
  const t = f.spawn('pending'); setTerminal(t.terminal, { status: { state: 'working', app: t.agent } }); patch({ unkillable: true });
  let r = f.call(['finish', t.id, '--force']); assert.equal(r.code, 0, r.out); assert.ok(f.task(t.id).copyToReturn.stopPending);
  patch({ unkillable: false }); const before = readWorld().log.length;
  r = f.call(['start']); assert.equal(r.code, 0, r.out); assert.equal(readWorld().terminals[t.terminal].state, 'live');
  assert.ok(!readWorld().log.slice(before).some(a => a[0] === 'kill'), 'Automatic retries do not force a busy worker');
  r = f.call(['finish', t.id, '--force']); assert.equal(r.code, 0, r.out);
  assert.ok(!readWorld().terminals[t.terminal] && !fs.existsSync(t.worktree), 'An explicitly forced retry cancels and returns the pending copy');
  const writing = f.spawn('pending-write'); setTerminal(writing.terminal, { status: { state: 'working', app: writing.agent } }); patch({ unkillable: true });
  assert.equal(f.call(['finish', writing.id, '--force']).code, 0);
  const late = path.join(writing.worktree, 'late.txt'); patch({ unkillable: false, writeOnKill: late });
  r = f.call(['finish', writing.id, '--force']); patch({ writeOnKill: null }); assert.equal(r.code, 0, r.out);
  assert.ok(fs.existsSync(late) && f.task(writing.id).copyToReturn, 'A forced stop retry also protects work written during its own cancellation');
  assert.equal(f.call(['finish', writing.id, '--force']).code, 0); assert.ok(!fs.existsSync(writing.worktree));
};

gapTests['review-pending-status'] = () => {
  const f = gapFixture('review-status'), patch = p => { const w = readWorld(); Object.assign(w, p); fs.writeFileSync(world, JSON.stringify(w)); };
  const t = f.spawn('pending'); setTerminal(t.terminal, { status: { state: 'working', app: t.agent } }); patch({ unkillable: true });
  let r = f.call(['finish', t.id, '--force']); assert.equal(r.code, 0, r.out); patch({ unkillable: false });
  const assertPending = (task, why, text) => {
    const before = readWorld().log.length;
    const shown = JSON.parse(f.call(['status', '--all', '--json']).out).tasks.find(s => s.id === task.id).copyToReturn;
    assert.equal(shown.free, false, 'A pending lifecycle confirmation must not be presented as a free copy');
    assert.equal(shown.why, why); assert.match(shown.pending, text);
    const line = f.call(['status', '--all']).out.split(/\r?\n/).find(line => line.startsWith(`${task.id}\t`));
    assert.match(line, text); assert.ok(!line.includes('free now') && !line.includes('--force discards it'), line);
    assert.ok(!readWorld().log.slice(before).some(a => ['kill', 'rm'].includes(a[0])), 'Status is observational only');
  };
  assertPending(t, 'stop pending', /worker stop is not confirmed/);
  const removal = f.spawn('removal'); patch({ failRm: true }); r = f.call(['finish', removal.id]); assert.equal(r.code, 0, r.out);
  assertPending(removal, 'terminal removal pending', /worker terminal removal is not confirmed/);
  patch({ failRm: false }); assert.equal(f.call(['finish', t.id, '--force']).code, 0); assert.equal(f.call(['finish', removal.id]).code, 0);
};

gapTests['review2-baseline-race'] = () => {
  const f = gapFixture('review2-baseline'), t = f.spawn('racing', ['--kind', 'ship']);
  const late = path.join(t.worktree, 'late.txt'), preload = slash(path.join(f.dir, 'race.cjs'));
  // Return a genuinely clean first status result, then let the worker write before the
  // coordinator receives it. NODE_OPTIONS applies the hook only to this fake-Core command.
  fs.writeFileSync(preload, `const cp = require('node:child_process'), fs = require('node:fs'), original = cp.spawnSync;
let written = false;
cp.spawnSync = function(command, args, options) {
  const result = original(command, args, options);
  if (!written && command === 'git' && args[1] === ${JSON.stringify(t.worktree)} && args.includes('status') && args.includes('--porcelain') && result.status === 0) {
    written = true; fs.writeFileSync(${JSON.stringify(late)}, 'written after the clean result');
  }
  return result;
};
require('node:module').syncBuiltinESMExports();`);
  const r = f.call(['finish', t.id], { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ${JSON.stringify(preload)}` });
  assert.ok([0, 6].includes(r.code), r.out);
  assert.ok(fs.existsSync(late), 'Work between the clean result and baseline must not be silently accepted and deleted');
  if (r.code === 6) assert.equal(readWorld().terminals[t.terminal].state, 'live', 'A refusal leaves the worker intact');
  else assert.ok(f.task(t.id).copyToReturn, 'Work outside the accepted baseline postpones return');
  assert.equal(f.call(['finish', t.id, '--force']).code, 0); assert.ok(!fs.existsSync(t.worktree));
};

gapTests['review2-unseen-force'] = () => {
  const f = gapFixture('review2-unseen'), patch = p => { const w = readWorld(); Object.assign(w, p); fs.writeFileSync(world, JSON.stringify(w)); };
  const corrupt = t => { const file = path.join(t.worktree, '.git'); fs.renameSync(file, `${file}-saved`); fs.writeFileSync(file, 'gitdir: missing\n'); };
  const t = f.spawn('unseen', ['--kind', 'ship']); fs.writeFileSync(path.join(t.worktree, 'unsaved.txt'), 'discard only by explicit request'); corrupt(t);
  let r = f.call(['finish', t.id]); assert.equal(r.code, 6, r.out); assert.match(r.out, /Pass --force to discard it unseen/); assert.equal(readWorld().terminals[t.terminal].state, 'live');
  r = f.call(['finish', t.id, '--force']); assert.equal(r.code, 0, r.out);
  assert.ok(!fs.existsSync(t.worktree), 'Explicit force must discard an uninspectable copy on the first attempt');
  assert.match(r.out, /discarded unseen/); assert.ok(!f.task(t.id).copyToReturn);

  const closed = f.spawn('closed', ['--kind', 'ship']);
  f.save({ ...closed, state: 'closed', closed: new Date().toISOString(), copyToReturn: { since: new Date().toISOString(), left: snapshotCopy(closed.worktree), cleanupTerminal: true } });
  corrupt(closed);
  r = f.call(['finish', closed.id]); assert.equal(r.code, 0, r.out); assert.ok(fs.existsSync(closed.worktree)); assert.match(r.out, /--force.*discards/);
  f.guest(closed);
  r = f.call(['finish', closed.id, '--force']); assert.equal(r.code, 6, r.out); assert.ok(fs.existsSync(closed.worktree), 'Unseen discard still cannot override another terminal');
  f.leave(); patch({ silentLs: true }); r = f.call(['finish', closed.id, '--force']); assert.equal(r.code, 4, r.out); assert.ok(fs.existsSync(closed.worktree));
  patch({ silentLs: false }); r = f.call(['finish', closed.id, '--force']); assert.equal(r.code, 0, r.out); assert.ok(!fs.existsSync(closed.worktree), r.out); assert.match(r.out, /discarded unseen/);
};

gapTests['review2-missing-git'] = () => {
  const f = gapFixture('review2-missing'), t = f.spawn('missing', ['--kind', 'ship']);
  fs.renameSync(path.join(t.worktree, '.git'), path.join(t.worktree, '.git-saved'));
  fs.writeFileSync(path.join(t.worktree, 'unsaved.txt'), 'not inspectable without the Git marker');
  let r = f.call(['finish', t.id]); assert.equal(r.code, 6, 'A missing Git marker is an inspection failure, not proof of a clean ship');
  assert.equal(readWorld().terminals[t.terminal].state, 'live'); assert.ok(fs.existsSync(path.join(t.worktree, 'unsaved.txt')));
  r = f.call(['finish', t.id, '--force']); assert.equal(r.code, 0, r.out); assert.ok(!fs.existsSync(t.worktree)); assert.match(r.out, /discarded unseen/);
};

gapTests['review3-prototype-names'] = () => {
  const f = gapFixture('review3-names'), names = ['__proto__', 'constructor', 'toString'];
  const writeNames = t => { for (const name of names) fs.writeFileSync(path.join(t.worktree, name), 'accepted before finish'); };
  const assertOwnNames = record => { for (const name of names) assert.ok(Object.hasOwn(record, name), `${name} must be an own filename key`); };
  for (const [i, name] of names.entries()) {
    const t = f.spawn(`untracked-${i}`, ['--kind', 'ship']); fs.writeFileSync(path.join(t.worktree, name), 'uncommitted');
    const snapshot = snapshotCopy(t.worktree), r = f.call(['finish', t.id]);
    assert.equal(r.code, 6, `Uncommitted ${name} must refuse finish: ${r.out}`);
    assert.ok(fs.existsSync(path.join(t.worktree, name))); assert.equal(readWorld().terminals[t.terminal].state, 'live');
    assert.ok(Object.hasOwn(snapshot.files, name)); assert.equal(Object.getPrototypeOf(snapshot.files), null);
    assert.equal(f.call(['finish', t.id, '--force']).code, 0);
  }

  // Saved JSON (including older records) has ordinary-object dictionaries. Unchanged
  // accepted filenames must round-trip without either losing names or inventing changes.
  const oldFiles = f.spawn('old-files', ['--kind', 'ship']); writeNames(oldFiles); f.guest(oldFiles);
  assert.equal(f.call(['finish', oldFiles.id, '--force']).code, 0);
  const savedFiles = f.task(oldFiles.id); assert.equal(Object.getPrototypeOf(savedFiles.copyToReturn.left.files), Object.prototype); assertOwnNames(savedFiles.copyToReturn.left.files);
  f.save(JSON.parse(JSON.stringify(savedFiles))); f.leave();
  let r = f.call(['finish', oldFiles.id]); assert.equal(r.code, 0, r.out); assert.ok(!fs.existsSync(oldFiles.worktree), r.out);

  const oldLost = f.spawn('old-lost', ['--kind', 'ship']); fs.writeFileSync(path.join(oldLost.worktree, '__proto__'), 'older writer omitted this key'); f.guest(oldLost);
  assert.equal(f.call(['finish', oldLost.id, '--force']).code, 0);
  const lost = f.task(oldLost.id); delete lost.copyToReturn.left.files.__proto__; f.save(lost); f.leave();
  r = f.call(['finish', oldLost.id]); assert.equal(r.code, 0, r.out); assert.ok(fs.existsSync(path.join(oldLost.worktree, '__proto__')), 'A name omitted by an older snapshot cannot be inferred safe to discard');
  assert.equal(f.call(['finish', oldLost.id, '--force']).code, 0);

  fs.appendFileSync(path.join(f.repo, '.git', 'info', 'exclude'), `\n${names.map(name => `/${name}`).join('\n')}\n`);
  const oldIgnored = f.spawn('old-ignored', ['--kind', 'ship']); writeNames(oldIgnored); f.guest(oldIgnored);
  const snapshot = snapshotCopy(oldIgnored.worktree); assert.equal(Object.getPrototypeOf(snapshot.ignored), null); assertOwnNames(snapshot.ignored);
  assert.equal(f.call(['finish', oldIgnored.id]).code, 0);
  const savedIgnored = f.task(oldIgnored.id); assert.equal(Object.getPrototypeOf(savedIgnored.copyToReturn.left.ignored), Object.prototype); assertOwnNames(savedIgnored.copyToReturn.left.ignored);
  f.save(JSON.parse(JSON.stringify(savedIgnored))); f.leave();
  r = f.call(['finish', oldIgnored.id]); assert.equal(r.code, 0, r.out); assert.ok(!fs.existsSync(oldIgnored.worktree), r.out);

  for (const [i, name] of names.entries()) {
    const t = f.spawn(`ignored-${i}`, ['--kind', 'ship']); fs.writeFileSync(path.join(t.worktree, name), 'accepted'); f.guest(t);
    assert.equal(f.call(['finish', t.id]).code, 0);
    const older = f.task(t.id);
    if (name === '__proto__') { delete older.copyToReturn.left.ignored.__proto__; f.save(older); }
    fs.writeFileSync(path.join(t.worktree, name), 'work written after finish');
    f.leave(); r = f.call(['start']); assert.equal(r.code, 0, r.out);
    assert.ok(fs.existsSync(path.join(t.worktree, name)), `Ignored ${name} must be protected after finish`); assert.match(r.out, /work written since finish/);
    assert.equal(f.call(['finish', t.id, '--force']).code, 0);
  }
};

gapTests.status = () => {
  const f = gapFixture('delivery'), ship = f.spawn('ship', ['--kind', 'ship']), scout = f.spawn('scout');
  for (const [fields, expected] of [[{}, 'plain'], [{ workflow: 'delivery' }, 'workflow'], [{ gate: 'no-mistakes', workflow: 'delivery' }, 'gate']]) {
    f.save({ ...ship, ...fields });
    const tasks = JSON.parse(f.call(['status', '--json']).out).tasks;
    assert.equal(tasks.find(t => t.id === ship.id).deliveryKind, expected);
    assert.equal(tasks.find(t => t.id === scout.id).deliveryKind, null);
  }
  assert.equal(f.call(['finish', ship.id]).code, 0); assert.equal(f.call(['finish', scout.id]).code, 0);
};

try {
  const onlyGaps = process.argv.find(a => a === '--gaps' || a.startsWith('--gaps='));
  for (const [name, test] of Object.entries(gapTests)) if (!onlyGaps || onlyGaps === '--gaps' || onlyGaps === `--gaps=${name}`) { test(); console.log(`PASS: gap ${name}`); }
  if (!onlyGaps) {
  // The focused fixtures have their own homes and copies, but share the fake Core transport.
  fs.writeFileSync(world, JSON.stringify({ seq: 0, terminals: {}, log: [] }));
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
  assert.match(crew(['init'], { cwd: root }).out, /crew home created: \S*\/user\/\.crew\r?\n/, 'The default home is ~/.crew itself');
  assert.ok(crew(['status'], { cwd: root }).out.includes('/user/.crew - no owner'), 'crew finds the default home from any folder');
  {
    const now = path.join(fakeUser, '.crew'), rules = path.join(now, 'coordinator');
    assert.equal(slash(crew(['home'], { cwd: root }).out.trim()), slash(rules), 'crew home prints the folder the coordinator starts in');
    assert.ok(fs.readFileSync(path.join(rules, 'AGENTS.md'), 'utf8').includes('crew spawn') && !fs.existsSync(path.join(now, 'AGENTS.md')), 'The rules are in their own folder, not above the workers');
    // A home from before 0.7 (~/.crew/crew, earlier ~/.crew/home) keeps working and is unpacked
    // into ~/.crew once, when nobody uses it.
    for (const name of ['crew', 'home']) {
      const old = path.join(now, name);
      fs.rmSync(now, { recursive: true, force: true }); fs.mkdirSync(path.join(old, 'tasks', 'k1'), { recursive: true });
      fs.writeFileSync(path.join(old, 'crew.json'), JSON.stringify({ version: 1, tag: 'old', projects: {} }));
      fs.writeFileSync(path.join(old, 'AGENTS.md'), 'old rules'); fs.writeFileSync(path.join(old, 'CLAUDE.md'), '@AGENTS.md\n'); fs.writeFileSync(path.join(old, 'backlog.md'), 'b\n');
      fs.writeFileSync(path.join(old, 'tasks', 'k1', 'task.json'), JSON.stringify({ id: 'k1', state: 'closed', report: `${slash(old)}/tasks/k1/report.md`, brief: `${slash(old)}/tasks/k1/brief.md`, worktree: 'C:/elsewhere/k1' }));
      assert.ok(crew(['status'], { cwd: root }).out.includes(`.crew/${name} - no owner`), 'The old place still works');
      assert.equal(slash(crew(['home'], { cwd: root }).out.trim()), slash(old), 'An old home is where its coordinator starts');
      assert.equal(crew(['init'], { cwd: root }).code, 2, 'No second default home beside the old one');
      let w0 = readWorld(); w0.terminals.old1 = { address: 'old1', state: 'live', labels: {} }; fs.writeFileSync(world, JSON.stringify(w0));
      fs.writeFileSync(path.join(old, 'owner.json'), JSON.stringify({ terminal: 'old1' }));
      let m = crew(['home', '--ensure'], { cwd: root });
      assert.ok(m.out.includes('for now: a session still holds it') && fs.existsSync(path.join(old, 'crew.json')) && !fs.existsSync(path.join(now, 'crew.json')), m.out);
      w0 = readWorld(); delete w0.terminals.old1; fs.writeFileSync(world, JSON.stringify(w0));
      m = crew(['home', '--ensure'], { cwd: root });
      assert.ok(m.out.includes('the home moved from') && !fs.existsSync(old) && fs.existsSync(path.join(now, 'crew.json')), m.out);
      assert.ok(m.out.split(/\r?\n/).map(slash).includes(slash(rules)), m.out);
      assert.deepEqual([fs.readFileSync(path.join(rules, 'AGENTS.md'), 'utf8'), fs.readFileSync(path.join(now, 'backlog.md'), 'utf8')], ['old rules', 'b\n'], 'Rules go to coordinator/, the rest to ~/.crew');
      const k1 = JSON.parse(fs.readFileSync(path.join(now, 'tasks', 'k1', 'task.json'), 'utf8'));
      assert.deepEqual([k1.report, k1.brief, k1.worktree], [`${slash(now)}/tasks/k1/report.md`, `${slash(now)}/tasks/k1/brief.md`, 'C:/elsewhere/k1'], 'Task records follow the home');
    }
    // Something already in the way: nothing is moved, and the old home stays whole.
    fs.rmSync(now, { recursive: true, force: true }); fs.mkdirSync(path.join(now, 'crew'), { recursive: true }); fs.mkdirSync(path.join(now, 'tasks'));
    fs.writeFileSync(path.join(now, 'crew', 'crew.json'), JSON.stringify({ version: 1, tag: 'old', projects: {} })); fs.mkdirSync(path.join(now, 'crew', 'tasks'));
    let m = crew(['home', '--ensure'], { cwd: root });
    assert.ok(/for now: \S*\/\.crew\/tasks already exists/.test(m.out) && fs.existsSync(path.join(now, 'crew', 'crew.json')) && !fs.existsSync(path.join(now, 'coordinator')), m.out);
    fs.rmSync(now, { recursive: true, force: true });
    m = crew(['home', '--ensure'], { cwd: root });
    assert.ok(m.code === 0 && fs.existsSync(path.join(now, 'crew.json')), 'With no home at all, --ensure creates the default one');
    // Update and crash records from before 0.7 move into state/ when a command uses them, and
    // not before: a command that has nothing to do with them leaves them where they are.
    fs.writeFileSync(path.join(now, 'tool-previous'), 'abc\n'); crew(['home'], { cwd: root });
    assert.ok(fs.existsSync(path.join(now, 'tool-previous')) && !fs.existsSync(path.join(now, 'state')), 'Nothing moves until it is used');
    assert.equal(crew(['rollback'], { cwd: root, env: { CREW_TOOL_ROOT: root } }).code, 2, 'A folder that is no clone has no revision to go back from');
    assert.ok(!fs.existsSync(path.join(now, 'tool-previous')) && fs.readFileSync(path.join(now, 'state', 'previous'), 'utf8') === 'abc\n');
  }
  fs.rmSync(path.join(fakeUser, '.crew'), { recursive: true, force: true });
  assert.equal(crew(['init', homeDir]).code, 0);
  assert.ok(fs.readFileSync(path.join(homeDir, 'coordinator', 'AGENTS.md'), 'utf8').includes('crew spawn'));
  {
    // A workflow task's draft pull request is open from its plan on: the rules finish a task
    // only after land recorded it, never merely because a pull request is open.
    const rules = fs.readFileSync(path.join(homeDir, 'coordinator', 'AGENTS.md'), 'utf8');
    assert.ok(rules.includes('task only once `crew land` has recorded the pull request') && !rules.includes('once the pull request is open'), rules);
    assert.ok(rules.includes('provider or network error') && rules.includes('pass it on to the person afterwards'), rules);
  }
  assert.equal(fs.readFileSync(path.join(homeDir, 'coordinator', 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
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
  assert.ok(git('-C', project, 'branch', '--list', 'feature/f1').includes('feature/f1'), 'The branch stays');
  // A branch whose commits are merged holds nothing more and goes with the working copy.
  assert.equal(crew(['spawn', 'f4', '--project', 'demo', '--kind', 'ship', '--agent', 'pi', 'x'], { terminal: 'c2' }).code, 0);
  commit(path.join(copies, 'f4'), { 'merged.txt': 'in\n' }, 'Merged work'); git('-C', project, 'merge', '-q', '--ff-only', 'feature/f4');
  r = crew(['finish', 'f4', '--force'], { terminal: 'c2' }); assert.equal(r.code, 0, r.out); assert.match(r.out, /; merged branch feature\/f4 deleted/);
  assert.equal(git('-C', project, 'branch', '--list', 'feature/f4').trim(), '', 'A merged branch is deleted');
  // --type names the branch the way the shared delivery workflow does; only a ship task has one.
  r = crew(['spawn', 'f5', '--project', 'demo', '--kind', 'ship', '--type', 'bugfix', '--agent', 'pi', 'x'], { terminal: 'c2' }); assert.equal(r.code, 2); assert.match(r.out, /Unknown type: bugfix/);
  r = crew(['spawn', 'f5', '--project', 'demo', '--type', 'fix', '--agent', 'pi', 'x'], { terminal: 'c2' }); assert.equal(r.code, 2); assert.match(r.out, /Only a ship task has a branch/);
  assert.equal(crew(['spawn', 'f5', '--project', 'demo', '--kind', 'ship', '--type', 'fix', '--agent', 'pi', 'x'], { terminal: 'c2' }).code, 0);
  const f5copy = path.join(copies, 'f5');
  assert.equal(git('-C', f5copy, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'fix/f5');
  // A copy marked to keep is not removed unasked. The marker's folder is ignored, as in a delivery repository.
  fs.mkdirSync(path.join(f5copy, '.artifacts')); fs.writeFileSync(path.join(f5copy, '.artifacts', '.gitignore'), '*\n'); fs.writeFileSync(path.join(f5copy, '.artifacts', 'KEEP'), '');
  r = crew(['finish', 'f5'], { terminal: 'c2' }); assert.equal(r.code, 6); assert.match(r.out, /marked to keep by \.artifacts\/KEEP/);
  assert.ok(fs.existsSync(f5copy), 'A kept copy stays');
  r = crew(['finish', 'f5', '--force'], { terminal: 'c2' }); assert.equal(r.code, 0, r.out); assert.match(r.out, /; merged branch fix\/f5 deleted/);
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
  // machine (a second clone). The small suite fails on an allowlisted broken marker.
  const origin = path.join(root, 'origin.git'), tool = path.join(root, 'tool'), peer = path.join(root, 'peer'), seed = path.join(root, 'seed');
  fs.mkdirSync(seed); git('-C', seed, 'init', '-q', '-b', 'main');
  commit(seed, { 'crew/docs/check.mjs': "import fs from 'node:fs'; process.exit(fs.existsSync('crew/docs/broken') ? 1 : 0);\n", 'crew/docs/tool.txt': 'one\n', 'README.md': 'outside\n' }, 'seed');
  git('clone', '-q', '--bare', seed, origin); git('clone', '-q', origin, tool); git('clone', '-q', origin, peer);
  for (const folder of [tool, peer]) { git('-C', folder, 'config', 'user.name', 't'); git('-C', folder, 'config', 'user.email', 't@example.invalid'); }
  const selfGh = path.join(root, 'self-gh.mjs'), selfLog = path.join(root, 'self-gh.json');
  fs.writeFileSync(selfLog, '[]');
  fs.writeFileSync(selfGh, `import fs from 'node:fs'; const a = process.argv.slice(2), f = ${JSON.stringify(selfLog)}; fs.writeFileSync(f, JSON.stringify([...JSON.parse(fs.readFileSync(f, 'utf8')), { a, body: a.includes('--body-file') ? fs.readFileSync(a[a.indexOf('--body-file') + 1], 'utf8') : null }])); if (a[1] !== 'list') console.log('https://github.com/acme/crew/pull/1');`);
  const self = { CREW_TOOL_ROOT: tool, CREW_SELFTEST: 'node crew/docs/check.mjs', CREW_GH: selfGh };
  const sm = (args, terminal = 'c2', env = {}) => crew(args, { terminal, env: { ...self, ...env } });
  const head = folder => git('-C', folder, 'rev-parse', 'HEAD').trim();
  const taskOf = id => JSON.parse(fs.readFileSync(path.join(homeDir, 'tasks', id, 'task.json'), 'utf8'));
  const first = head(tool);

  // A crash is written down and points at the repair command.
  const crashHome = path.join(root, 'crash-home'); fs.mkdirSync(crashHome);
  fs.writeFileSync(path.join(crashHome, 'crew.json'), JSON.stringify({ version: 1, tag: 'crash' }));
  r = crew(['project', 'list'], { cwd: crashHome }); assert.equal(r.code, 70, r.out);
  assert.match(r.out, /internal error[\s\S]*defect in crew itself[\s\S]*crew fix "/);
  const crashFiles = fs.readdirSync(path.join(fakeUser, '.crew', 'state', 'crashes'));
  assert.equal(crashFiles.length, 1);
  assert.match(fs.readFileSync(path.join(fakeUser, '.crew', 'state', 'crashes', crashFiles[0]), 'utf8'), /command: crew project list[\s\S]*TypeError/);

  // fix: only the owner, one at a time, a ship task on crew's own source with the crash attached.
  assert.equal(sm(['fix', 'x'], 'c1').code, 3);
  assert.equal(sm(['fix']).code, 2);
  r = sm(['fix', '--agent', 'pi', 'crew project list crashed', 'instead of printing nothing']); assert.equal(r.code, 0, r.out);
  assert.match(r.out, /spawned fix-1: pi ship in terminal (t\d+)[\s\S]*next: crew wait fix-1, then crew selfrepair fix-1/);
  const fix1 = taskOf('fix-1'), fixCopy = path.join(copies, 'fix-1');
  assert.ok(readWorld().log.filter(a => a[0] === 'run').at(-1).includes('crew.kind=fix'), 'A fixer is labelled as one');
  assert.deepEqual([fix1.selfFix, fix1.project, fix1.projectPath, fix1.base], [true, 'crew:self', slash(tool), first]);
  const fixBrief = fs.readFileSync(fix1.brief, 'utf8');
  assert.ok(fixBrief.includes('crew project list crashed instead of printing nothing') && fixBrief.includes(crashFiles[0]) && fixBrief.includes('`crew/crew.mjs`') && fixBrief.includes('Repository infrastructure is out of scope'), fixBrief);
  assert.equal(git('-C', fixCopy, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'fix/fix-1');
  r = sm(['fix', 'another']); assert.equal(r.code, 2); assert.match(r.out, /already open: fix-1/);

  // selfmerge: every gate refuses and publishes nothing.
  assert.equal(sm(['selfmerge', 'fix-1'], 'c1').code, 3);
  r = sm(['selfmerge', 'fix-1']); assert.equal(r.code, 2); assert.match(r.out, /only after its worker reported/);
  fs.writeFileSync(fix1.report, 'fixed'); assert.equal(crew(['done', 'fix-1'], { terminal: fix1.terminal }).code, 0);
  r = sm(['selfmerge', 'fix-1']); assert.equal(r.code, 6); assert.match(r.out, /changes nothing/);
  fs.writeFileSync(path.join(fixCopy, 'crew', 'half.txt'), 'x');
  r = sm(['selfmerge', 'fix-1']); assert.equal(r.code, 6); assert.match(r.out, /uncommitted files \(crew\/half\.txt\)/);
  fs.rmSync(path.join(fixCopy, 'crew', 'half.txt'));
  commit(fixCopy, { 'README.md': 'changed outside\n', 'crew/docs/tool.txt': 'two\n' }, 'too wide');
  r = sm(['selfmerge', 'fix-1']); assert.equal(r.code, 6); assert.match(r.out, /outside crew's own files \(README\.md\)/);
  git('-C', fixCopy, 'reset', '-q', '--hard', 'HEAD~1');
  commit(fixCopy, { 'crew/docs/tool.txt': 'two\n', 'crew/docs/broken': '' }, 'breaks the suite');
  r = sm(['selfmerge', 'fix-1']); assert.equal(r.code, 6); assert.match(r.out, /the test suite fails \(node crew\/docs\/check\.mjs, exit 1\)/);
  assert.deepEqual([head(origin), head(tool)], [first, first], 'A refused repair reaches nobody');
  assert.equal(spawnSync('git', ['-C', origin, 'rev-parse', '--verify', 'refs/heads/fix/fix-1']).status, 128, 'Neither an out-of-scope repair nor a failing suite publishes a branch');
  assert.equal(JSON.parse(fs.readFileSync(selfLog, 'utf8')).length, 0, 'Refusals do not ask GitHub to open a pull request');
  git('-C', fixCopy, 'reset', '-q', '--hard', 'HEAD~1');
  commit(fixCopy, { 'crew/docs/tool.txt': 'two\n' }, 'the repair');
  // Meanwhile another machine published something else: the repair goes on top of it.
  const theirs = commit(peer, { 'crew/peer.txt': 'theirs\n' }, 'from another machine'); git('-C', peer, 'push', '-q', 'origin', 'HEAD:main');
  r = sm(['selfmerge', 'fix-1']); assert.equal(r.code, 0, r.out);
  assert.match(r.out, /delivered repair fix-1: https:\/\/github.com\/acme\/crew\/pull\/1; tests passed[\s\S]*This machine was not updated/);
  assert.equal(head(origin), theirs, 'Delivery does not move the published main');
  assert.equal(head(tool), first, 'Delivery does not update the installed source');
  const second = head(fixCopy);
  assert.equal(git('-C', origin, 'rev-parse', 'fix/fix-1').trim(), second);
  assert.equal(git('-C', fixCopy, 'rev-parse', 'HEAD~1').trim(), theirs, 'The repair rebases on the other machine\'s published change');
  assert.equal(taskOf('fix-1').pr, 'https://github.com/acme/crew/pull/1');
  assert.equal(taskOf('fix-1').merged, undefined);
  assert.match(sm(['selfrepair', 'fix-1']).out, /already has a pull request/);
  assert.equal(JSON.parse(fs.readFileSync(selfLog, 'utf8')).filter(x => x.a[1] === 'create').length, 1);
  // Simulate the person's merge, then the explicit update that installs the repair.
  git('-C', peer, 'fetch', '-q', 'origin', 'fix/fix-1'); git('-C', peer, 'merge', '-q', '--ff-only', 'FETCH_HEAD'); git('-C', peer, 'push', '-q', 'origin', 'HEAD:main');
  assert.equal(sm(['update']).code, 0); assert.equal(head(tool), second);
  assert.equal(fs.readFileSync(path.join(tool, 'crew', 'docs', 'tool.txt'), 'utf8').replace(/\r/g, ''), 'two\n');
  assert.equal(sm(['finish', 'fix-1']).code, 0);
  assert.equal(git('-C', tool, 'branch', '--list', 'fix/fix-1').trim(), '', 'A published repair leaves no branch behind');
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
  fs.writeFileSync(path.join(homeDir, 'coordinator', 'AGENTS.md'), 'old rules');
  assert.match(crew(['start'], { terminal: 'c2' }).out, /coordinator rules changed/);
  const repairRules = fs.readFileSync(path.join(homeDir, 'coordinator', 'AGENTS.md'), 'utf8').split('## When crew itself is wrong')[1];
  for (const text of ['crew selfrepair', 'wait for their merge', 'crew update', 'After two refused repairs', 'crew rollback']) assert.ok(repairRules.includes(text), text);
  assert.ok(!repairRules.includes('without asking the person')); assert.equal((repairRules.match(/crew selfmerge/g) || []).length, 1);

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
if (a[0] === 'pr' && a[1] === 'view' && a.includes('isDraft,body')) { console.log(JSON.stringify({ isDraft: true, body: '## Proposal\\n\\nWhy.\\n\\n## Implementation\\n\\n- [x] The first outcome is delivered.\\n- [ ] The second outcome is delivered.\\n\\n## Acceptance\\n\\n- [ ] not an outcome\\n' })); process.exit(0); }
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
  assert.ok(fs.readFileSync(review.brief, 'utf8').includes('git diff HEAD...feature/s1') && fs.readFileSync(review.brief, 'utf8').includes('`APPROVE` or `CHANGES NEEDED`'));
  assert.match(own(['review', 's1', '--agent', 'claude']).out, /spawned s1-review-2: claude scout/);
  // land: refused with unsaved work, without a place to push to, and honest when GitHub says no.
  fs.writeFileSync(path.join(s1copy, 'loose.txt'), 'x');
  r = own(['land', 's1']); assert.equal(r.code, 6); assert.match(r.out, /uncommitted files \(loose\.txt\)/);
  fs.rmSync(path.join(s1copy, 'loose.txt'));
  r = own(['land', 's1']); assert.equal(r.code, 6); assert.match(r.out, /no `origin` to push to/);
  const projectOrigin = path.join(root, 'project-origin.git'); git('clone', '-q', '--bare', project, projectOrigin); git('-C', project, 'remote', 'add', 'origin', projectOrigin);
  const baseBranch = git('-C', project, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  fs.writeFileSync(ghDown, '');
  r = own(['land', 's1']); assert.equal(r.code, 4); assert.match(r.out, /branch feature\/s1 is pushed, but the pull request was not opened \(gh: not signed in\)/);
  assert.equal(git('-C', projectOrigin, 'rev-parse', 'feature/s1').trim(), head(s1copy), 'The branch is published');
  assert.equal(taskOf('s1').pr, undefined);
  fs.rmSync(ghDown);
  r = own(['land', 's1']); assert.equal(r.code, 0, r.out);
  assert.ok(r.out.includes(`delivered s1: https://example.invalid/acme/demo/pull/7 (against ${baseBranch}, 1 commit)`), r.out);
  const made = JSON.parse(fs.readFileSync(ghLog, 'utf8')).at(-1);
  assert.deepEqual(made.a.slice(0, 8), ['pr', 'create', '--base', baseBranch, '--head', 'feature/s1', '--title', 'Add a third line']);
  assert.match(made.body, /# Done\nAdded a line\.[\s\S]*crew task `s1` \(pi\), 1 commit/);
  assert.equal(taskOf('s1').pr, 'https://example.invalid/acme/demo/pull/7');
  r = own(['status', '--json']); assert.equal(r.code, 0, r.out);
  assert.equal(JSON.parse(r.out).tasks.find(t => t.id === 's1').pr, 'https://example.invalid/acme/demo/pull/7');
  r = own(['status']); assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^s1\t[^\r\n]*\thttps:\/\/example\.invalid\/acme\/demo\/pull\/7\r?$/m);
  assert.match(own(['land', 's1', '--title', 'x']).out, /already has a pull request/);
  for (const id of ['s1-review', 's1-review-2', 's2', 's1']) assert.equal(own(['finish', id, '--force']).code, 0, id);
  assert.ok(git('-C', project, 'branch', '--list', 'feature/s1').includes('feature/s1'), 'A branch whose pull request is not merged stays');
  // A squash merge leaves no ancestry: GitHub's merged pull request with this exact head counts.
  assert.equal(own(['spawn', 'm1', '--project', 'demo', '--kind', 'ship', '--agent', 'pi', 'x']).code, 0);
  const m1head = commit(path.join(copies, 'm1'), { 'squashed.txt': 'x\n' }, 'Squashed work');
  fs.writeFileSync(ghMerged, 'another-commit\n');
  assert.equal(own(['spawn', 'm2', '--project', 'demo', '--kind', 'ship', '--agent', 'pi', 'x']).code, 0);
  commit(path.join(copies, 'm2'), { 'later.txt': 'x\n' }, 'Work after the merged head');
  r = own(['finish', 'm2', '--force']); assert.equal(r.code, 0, r.out); assert.ok(!r.out.includes('deleted'), r.out);
  assert.ok(git('-C', project, 'branch', '--list', 'feature/m2').includes('feature/m2'), 'Commits the merged pull request did not have keep the branch');
  fs.writeFileSync(ghMerged, m1head + '\n');
  r = own(['finish', 'm1', '--force']); assert.equal(r.code, 0, r.out); assert.match(r.out, /; merged branch feature\/m1 deleted/);
  assert.equal(git('-C', project, 'branch', '--list', 'feature/m1').trim(), '');
  fs.rmSync(ghMerged);

  // --- the tools Firstmate works with ----------------------------------------------------
  assert.deepEqual(TOOLS.map(t => t.id), ['gh', 'gh-axi', 'chrome-devtools-axi', 'lavish-axi', 'tasks-axi', 'quota-axi', 'delivery', 'treehouse', 'no-mistakes', 'jq']);
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
else if (a[0] === 'return') spawnSync('git', ['-C', a.at(-1), 'checkout', '-q', '--detach']);
`);
  const T = { CREW_GH: fakeGh, CREW_TOOL_TASKS_AXI: fakeTasks, CREW_TOOL_TREEHOUSE: fakeTree, CREW_TOOL_NO_MISTAKES: fakeVersion };
  const tl = (args, terminal = 'c2', env = T) => crew(args, { terminal, env });
  // tools: what is here and what crew does with it; nothing is required.
  r = crew(['tools'], { terminal: 'c2' }); assert.equal(r.code, 0);
  assert.equal(r.out.split('\n').filter(l => l.includes('not installed')).length, TOOLS.length, r.out); assert.match(r.out, /Missing tools are optional/);
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

  // delivery: where the shared delivery workflow is installed it makes and takes back the copies,
  // and crew does not know whether one is a pool slot or a new folder.
  const TEMPLATE = '# Agent instructions\n\nThis file is `templates/AGENTS.md` of `owner/workflows`, identical in every repository that uses it.\n';
  const fakeDelivery = path.join(root, 'fake-delivery.mjs'), deliveryLog = path.join(root, 'delivery-log.json'), stuck = path.join(root, 'pool-stuck');
  fs.writeFileSync(deliveryLog, '[]');
  fs.writeFileSync(fakeDelivery, `import fs from 'node:fs'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
const a = process.argv.slice(2), file = ${JSON.stringify(deliveryLog)}, log = JSON.parse(fs.readFileSync(file, 'utf8'));
log.push({ a, cwd: process.cwd() }); fs.writeFileSync(file, JSON.stringify(log));
const git = (...args) => spawnSync('git', args, { encoding: 'utf8' });
if (a[0] === 'start') {
  const detach = a.indexOf('--detach'), branch = detach < 0 ? a[1] : null;
  const listed = git('worktree', 'list', '--porcelain').stdout.split(/\\r?\\n\\r?\\n/).map(b => ({ path: /^worktree (.*)$/m.exec(b)?.[1], branch: /^branch refs\\/heads\\/(.*)$/m.exec(b)?.[1] }));
  const existing = branch ? listed.find(w => w.branch === branch) : null;
  if (existing) { console.log(JSON.stringify({ path: existing.path, branch, created: false, pooled: true })); process.exit(0); }
  const slot = path.join(${JSON.stringify(poolDir)}, String(log.length), 'demo');
  const r = git('worktree', 'add', ...(branch ? ['-b', branch] : ['--detach']), slot, 'HEAD');
  if (r.status !== 0) { console.error(r.stderr); process.exit(2); }
  console.error('started in a pool slot'); console.log(JSON.stringify({ path: slot, branch, created: true, pooled: true }));
} else if (a[0] === 'finish') {
  if (fs.existsSync(${JSON.stringify(stuck)})) { console.log('kept ' + a[1] + ': the worktree is locked. Nothing was removed.'); process.exit(1); }
  git('-C', a[1], 'reset', '-q', '--hard'); git('-C', a[1], 'clean', '-qfd'); git('-C', a[1], 'checkout', '-q', '--detach');
  console.log('finished ' + a[1] + ': slot returned to the pool');
} else if (a[0] === 'instructions') {
  // Like the real one: a match only for the template exactly, a list of differences otherwise.
  const text = fs.existsSync('AGENTS.md') ? fs.readFileSync('AGENTS.md', 'utf8') : null;
  if (text === ${JSON.stringify(TEMPLATE)}) console.log('Agent instructions match the shared template.');
  else { console.log(text === null ? 'AGENTS.md is missing' : 'AGENTS.md differs from the shared template'); process.exit(1); }
}
`);
  const D = { ...T, CREW_TOOL_DELIVERY: fakeDelivery }, dl = args => tl(args, 'c2', D);
  const calls = () => JSON.parse(fs.readFileSync(deliveryLog, 'utf8'));
  // Pooled copies are no longer a choice per project: the old flag is accepted and ignored.
  r = tl(['project', 'add', 'pooled', project, '--treehouse']); assert.equal(r.code, 0, r.out); assert.match(r.out, /--treehouse is no longer a project choice/);
  assert.match(tl(['project', 'list']).out, /^pooled\t[^\t\r\n]*\r?$/m);
  r = dl(['spawn', 'p1', '--project', 'pooled', '--kind', 'ship', '--type', 'fix', '--agent', 'pi', 'Change it.']); assert.equal(r.code, 0, r.out); assert.match(r.out, /\(pool slot\)/);
  const p1 = taskOf('p1');
  assert.deepEqual([p1.via, p1.pooled, p1.branch], ['delivery', true, 'fix/p1']); assert.ok(p1.worktree.startsWith(slash(poolDir)) && p1.worktree.endsWith('/demo'), p1.worktree);
  assert.equal(git('-C', p1.worktree, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'fix/p1');
  assert.equal(readWorld().log.filter(a => a[0] === 'run').at(-1)[readWorld().log.filter(a => a[0] === 'run').at(-1).indexOf('--cwd') + 1], p1.worktree);
  const asked = calls().find(e => e.a[0] === 'start');
  assert.deepEqual(asked.a, ['start', 'fix/p1', '--json']); assert.equal(slash(asked.cwd).toLowerCase(), slash(fs.realpathSync(project)).toLowerCase());
  // A copy that was already there belongs to other work: the task fails and the copy is left alone.
  git('-C', project, 'worktree', 'add', '-q', '-b', 'feature/taken', path.join(root, 'taken'), 'HEAD');
  r = dl(['spawn', 'taken', '--project', 'pooled', '--kind', 'ship', '--agent', 'pi', 'x']); assert.equal(r.code, 5); assert.match(r.out, /feature\/taken already has a working copy at .*; it was left alone/);
  assert.equal(taskOf('taken').state, 'failed'); assert.ok(fs.existsSync(path.join(root, 'taken')) && !calls().some(e => e.a[0] === 'finish'));
  // A failure after stopping closes the task with a durable postponed return, not a dead worker on an open task.
  fs.writeFileSync(stuck, '');
  r = dl(['finish', 'p1']); assert.equal(r.code, 0); assert.match(r.out, /delivery did not take the working copy back \(kept .*the worktree is locked/);
  assert.equal(taskOf('p1').state, 'closed'); assert.ok(taskOf('p1').copyToReturn, 'A failed return remains retryable');
  fs.rmSync(stuck);
  r = dl(['finish', 'p1']); assert.equal(r.code, 0, r.out); assert.match(r.out, /working copy returned to the pool/);
  assert.deepEqual(calls().at(-1).a, ['finish', p1.worktree, '--force']);
  assert.equal(taskOf('p1').state, 'closed');
  assert.match(r.out, /; merged branch fix\/p1 deleted/); assert.equal(git('-C', project, 'branch', '--list', 'fix/p1').trim(), '', 'A returned slot leaves no merged branch behind');
  // A scout gets a copy without a branch, and its leftovers go with it.
  assert.equal(dl(['spawn', 'p2', '--project', 'pooled', '--agent', 'pi', 'Look.']).code, 0);
  assert.deepEqual(calls().filter(e => e.a[0] === 'start').at(-1).a, ['start', '--detach', 'p2', '--json']);
  fs.writeFileSync(path.join(taskOf('p2').worktree, 'notes.tmp'), 'x');
  assert.equal(dl(['finish', 'p2']).code, 0); assert.ok(!fs.existsSync(path.join(taskOf('p2').worktree, 'notes.tmp')));
  // A ship task's unsaved work is still crew's own refusal, before delivery is asked.
  assert.equal(dl(['spawn', 'p3', '--project', 'pooled', '--kind', 'ship', '--agent', 'pi', 'x']).code, 0);
  fs.writeFileSync(path.join(taskOf('p3').worktree, 'half.txt'), 'x'); const askedSoFar = calls().length;
  r = dl(['finish', 'p3']); assert.equal(r.code, 6); assert.match(r.out, /has uncommitted work .*half\.txt/); assert.equal(calls().length, askedSoFar);
  assert.equal(dl(['finish', 'p3', '--force']).code, 0);
  // A task from before 0.8 whose project took its copies from treehouse is still given back to it.
  assert.equal(tl(['spawn', 'p4', '--project', 'pooled', '--agent', 'pi', 'Look.']).code, 0);
  { const file = path.join(homeDir, 'tasks', 'p4', 'task.json'); fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), pool: 'treehouse' })); }
  r = tl(['finish', 'p4']); assert.equal(r.code, 0, r.out); assert.match(r.out, /working copy returned to treehouse/);
  assert.deepEqual(JSON.parse(fs.readFileSync(treeLog, 'utf8')).at(-1).a, ['return', '--force', taskOf('p4').worktree]);
  // Such a task's reported scout moves its backlog item even after a review, as it always did.
  tl(['backlog', 'add', 'p5', 'Look at the legacy pool']);
  assert.equal(tl(['spawn', 'p5', '--project', 'pooled', '--agent', 'pi', 'Look.']).code, 0);
  { const file = path.join(homeDir, 'tasks', 'p5', 'task.json'); fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), pool: 'treehouse', reviews: 1 })); }
  fs.writeFileSync(taskOf('p5').report, 'seen'); assert.equal(crew(['done', 'p5'], { terminal: taskOf('p5').terminal }).code, 0);
  r = tl(['finish', 'p5']); assert.equal(r.code, 0, r.out); assert.match(r.out, /working copy returned to treehouse[\s\S]*backlog: done p5 -> Done/);

  // The shared delivery workflow: a repository that carries its instructions is delivered its
  // own way. The worker plans in a draft pull request; crew never pushes or opens one for it.
  assert.equal(p1.workflow, undefined, 'A copy without the shared instructions is a plain one');
  assert.ok(fs.readFileSync(p1.brief, 'utf8').includes('Do not push or open a pull request unless'));
  commit(project, { 'AGENTS.md': TEMPLATE }, 'Use the shared workflow');
  r = dl(['spawn', 'w1', '--project', 'pooled', '--kind', 'ship', '--agent', 'pi', 'Add a feature.']); assert.equal(r.code, 0, r.out);
  assert.match(r.out, /follows the repository's delivery workflow/);
  const w1 = taskOf('w1'), w1brief = fs.readFileSync(w1.brief, 'utf8');
  assert.equal(w1.workflow, 'delivery');
  assert.deepEqual(calls().filter(e => e.a[0] === 'instructions').map(e => slash(e.cwd).toLowerCase()).at(-1), slash(w1.worktree).toLowerCase(), 'Decided in the copy the worker gets');
  assert.ok(w1brief.includes('`change-delivery` skill') && w1brief.includes('`delivery start feature/w1`') && w1brief.includes('`Plan: <pull request link>`') && !w1brief.includes('Do not push or open a pull request'), w1brief);
  const ghCalls = () => JSON.parse(fs.readFileSync(ghLog, 'utf8')).map(e => e.a);
  // Its first report is a plan: status says so, and land refuses it until the plan is approved.
  fs.writeFileSync(w1.report, 'Plan: https://github.com/acme/demo/pull/11\n\nTwo outcomes.\n');
  assert.equal(crew(['done', 'w1'], { terminal: w1.terminal }).code, 0);
  assert.deepEqual([taskOf('w1').stage, taskOf('w1').pr], ['plan', 'https://github.com/acme/demo/pull/11']);
  assert.match(dl(['status']).out, /^w1\treported \(plan awaiting approval\)\t[^\r\n]*\thttps:\/\/github\.com\/acme\/demo\/pull\/11\r?$/m);
  assert.equal(JSON.parse(dl(['status', '--json']).out).tasks.find(t => t.id === 'w1').stage, 'plan');
  r = dl(['land', 'w1']); assert.equal(r.code, 6); assert.match(r.out, /plan awaiting approval[\s\S]*crew tell w1 "approved, implement"/);
  assert.equal(taskOf('w1').landed, undefined);
  r = dl(['tell', 'w1', 'approved, implement']); assert.equal(r.code, 0, r.out);
  assert.match(dl(['status']).out, /^w1\tworking \(plan\)\t/m);
  // The implementation report: land records the pull request and reads its state, and nothing else.
  commit(w1.worktree, { 'feature.txt': 'x\n' }, 'feat: add a feature');
  fs.writeFileSync(w1.report, 'Implementation: https://github.com/acme/demo/pull/11\n\nDone.\n');
  assert.equal(crew(['done', 'w1'], { terminal: w1.terminal }).code, 0);
  assert.match(dl(['status']).out, /^w1\treported \(implementation\)\t/m);
  // Delivered means pushed: a branch the worker never pushed, or a commit it did not push, is refused.
  const workerPush = (copy, branch) => git('-C', copy, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`);
  r = dl(['land', 'w1']); assert.equal(r.code, 6); assert.match(r.out, /branch feature\/w1 is not pushed\. Tell the worker: crew tell w1 "push your branch/);
  workerPush(w1.worktree, 'feature/w1'); const pushedW1 = head(w1.worktree);
  commit(w1.worktree, { 'late.txt': 'x\n' }, 'fix: a late fix');
  r = dl(['land', 'w1']); assert.equal(r.code, 6); assert.match(r.out, /its copy has 1 commit that the pushed branch feature\/w1 lacks\. Tell the worker: crew tell w1 "push your last commits/);
  assert.equal(taskOf('w1').landed, undefined);
  assert.equal(git('-C', projectOrigin, 'rev-parse', 'feature/w1').trim(), pushedW1, 'crew pushed nothing itself');
  workerPush(w1.worktree, 'feature/w1');
  const ghBefore = ghCalls().length;
  r = dl(['land', 'w1']); assert.equal(r.code, 0, r.out);
  assert.match(r.out, /delivered w1: https:\/\/github\.com\/acme\/demo\/pull\/11 \(draft, 1 of 2 outcomes ticked\)\. It follows the repository's delivery workflow/);
  assert.deepEqual(ghCalls().slice(ghBefore), [['pr', 'view', 'https://github.com/acme/demo/pull/11', '--json', 'isDraft,body']], 'Only read, never opened');
  assert.ok(taskOf('w1').landed);
  assert.match(dl(['land', 'w1']).out, /already has a pull request: https:\/\/github\.com\/acme\/demo\/pull\/11/);
  // No link on the first line: the pull request GitHub has for the branch, never another one
  // the report mentions further down.
  assert.equal(dl(['spawn', 'w2', '--project', 'pooled', '--kind', 'ship', '--agent', 'pi', 'x']).code, 0);
  workerPush(taskOf('w2').worktree, 'feature/w2');
  fs.writeFileSync(taskOf('w2').report, 'Implemented it.\n\nConflicts with https://github.com/acme/demo/pull/5\n'); assert.equal(crew(['done', 'w2'], { terminal: taskOf('w2').terminal }).code, 0);
  r = dl(['land', 'w2']); assert.equal(r.code, 0, r.out); assert.match(r.out, /delivered w2: https:\/\/example\.invalid\/acme\/demo\/pull\/7/);
  assert.ok(ghCalls().some(a => a.join(' ') === 'pr view feature/w2 --json url --jq .url'));
  assert.ok(!ghCalls().some(a => a[1] === 'create' && a.includes('feature/w2')));
  assert.equal(taskOf('w2').pr, 'https://example.invalid/acme/demo/pull/7');
  // No pull request anywhere: land says what to tell the worker and records nothing.
  assert.equal(dl(['spawn', 'w3', '--project', 'pooled', '--kind', 'ship', '--agent', 'pi', 'x']).code, 0);
  workerPush(taskOf('w3').worktree, 'feature/w3');
  fs.writeFileSync(taskOf('w3').report, 'Implementation: not opened yet\n'); assert.equal(crew(['done', 'w3'], { terminal: taskOf('w3').terminal }).code, 0);
  fs.writeFileSync(ghDown, '');
  r = dl(['land', 'w3']); assert.equal(r.code, 6); assert.match(r.out, /has not opened its pull request yet\. Tell it: crew tell w3 "open the draft pull request/);
  assert.deepEqual([taskOf('w3').pr, taskOf('w3').landed], [undefined, undefined]);
  fs.rmSync(ghDown);
  // A repository on an older template still counts: the template's header line is enough.
  commit(project, { 'AGENTS.md': `${TEMPLATE}\nAn older line.\n` }, 'Older template');
  assert.equal(dl(['spawn', 'w4', '--project', 'pooled', '--kind', 'ship', '--agent', 'pi', 'x']).code, 0);
  assert.equal(taskOf('w4').workflow, 'delivery');
  // The project's own choice wins over detection, either way, and is shown in the list.
  assert.equal(dl(['project', 'add', 'pooled', project, '--workflow', 'maybe']).code, 2);
  r = dl(['project', 'add', 'pooled', project, '--workflow', 'plain']); assert.equal(r.code, 0, r.out); assert.match(r.out, /\(workflow: plain\)/);
  assert.match(dl(['project', 'list']).out, /^pooled\t[^\t\r\n]*\tworkflow plain\r?$/m);
  assert.equal(dl(['spawn', 'w5', '--project', 'pooled', '--kind', 'ship', '--agent', 'pi', 'x']).code, 0);
  assert.equal(taskOf('w5').workflow, undefined); assert.ok(fs.readFileSync(taskOf('w5').brief, 'utf8').includes('Do not push or open a pull request unless'));
  git('-C', project, 'rm', '-q', 'AGENTS.md'); git('-C', project, ...who, 'commit', '-q', '-m', 'Back to plain');
  dl(['project', 'add', 'pooled', project, '--workflow', 'delivery']);
  assert.equal(dl(['spawn', 'w6', '--project', 'pooled', '--kind', 'ship', '--agent', 'pi', 'x']).code, 0);
  assert.equal(taskOf('w6').workflow, 'delivery', 'Delivered by pull request without the shared instructions');
  // Like --gate-skip, the choice is part of the registration: adding again without it drops it.
  dl(['project', 'add', 'pooled', project]); assert.match(dl(['project', 'list']).out, /^pooled\t[^\t\r\n]*\r?$/m);
  assert.equal(dl(['spawn', 'w7', '--project', 'pooled', '--kind', 'ship', '--agent', 'pi', 'x']).code, 0);
  assert.equal(taskOf('w7').workflow, undefined);
  for (const id of ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7']) assert.equal(dl(['finish', id, '--force']).code, 0, id);

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
  assert.notEqual(spawnSync('git', ['-C', projectOrigin, 'rev-parse', '--verify', '-q', 'feature/g1']).status, 0, 'crew pushed nothing itself');
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
  // The gate wins over the shared delivery workflow: a gated project keeps the gate's flow.
  r = tl(['project', 'add', 'demo', project, '--gate-skip', 'none', '--workflow', 'delivery']); assert.equal(r.code, 0, r.out);
  assert.equal(tl(['spawn', 'g5', '--project', 'demo', '--kind', 'ship', '--agent', 'pi', 'x']).code, 0);
  assert.deepEqual([taskOf('g5').gate, taskOf('g5').workflow], ['no-mistakes', undefined]);
  assert.ok(fs.readFileSync(taskOf('g5').brief, 'utf8').includes('no-mistakes axi run') && !fs.readFileSync(taskOf('g5').brief, 'utf8').includes('change-delivery'));
  assert.equal(tl(['finish', 'g5', '--force']).code, 0);
  tl(['project', 'add', 'demo', project, '--gate-skip', 'none']);

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

  // --- who does the work: profiles, accounts, quota and fallback ---------------------------
  // Pure parts first.
  assert.deepEqual(cleanProfile({ harness: 'a1', model: 'github-copilot/gpt-x', effort: 'high' }), { harness: 'a1', model: 'github-copilot/gpt-x', effort: 'high' });
  assert.throws(() => cleanProfile({ harness: 'a1', account: 'me@example.com' }), /Only Claude Code has saved accounts/);
  assert.throws(() => cleanProfile({ harness: 'a1', model: "x'; rm -rf ~" }), /Not a usable model/);
  assert.throws(() => cleanProfile({ harness: 'gpt' }), /Unknown agent: gpt/);
  assert.equal(agentCommand('a1', AGENTS.a1, 'do it', {}, { harness: 'a1', model: 'github-copilot/gpt-x', effort: 'high' }), "'a1' '--provider' 'github-copilot' '--model' 'gpt-x' '--thinking' 'high' 'do it'", 'A1 takes provider and model before the instruction');
  assert.equal(agentCommand('pi', AGENTS.pi, 'do it', {}, { harness: 'pi', model: 'plain' }), "'pi' '--model' 'plain' 'do it'");
  assert.ok(agentCommand('claude', AGENTS.claude, 'do it', {}, { harness: 'claude', model: 'opus', effort: 'low' }).startsWith("'claude' 'do it' '--model' 'opus' '--effort' 'low' '--permission-mode'"), 'Claude takes its options after the instruction');
  assert.throws(() => agentCommand('claude', AGENTS.claude, 'x', { CREW_CLAUDE_LAUNCHER: path.join(root, 'missing.sh') }, { harness: 'claude', account: 'me@example.com' }), /cannot be started as me@example.com/, 'A chosen account never silently becomes the default one');
  {
    const row = (left, runway) => ({ provider: 'codex', windows: [{ id: 'weekly', kind: 'weekly', resetsAt: '2030-01-01T00:00:00Z' }], state: { status: 'fresh' },
      quotaSemantics: { status: 'known', effectiveAvailability: [{ scope: 'all_models', effectivePercentRemaining: left, limitingWindowIds: ['weekly'], runway: { status: runway } }, { scope: 'model:other', effectivePercentRemaining: 0, runway: { status: 'exhausted_now' } }] } });
    assert.equal(quotaVerdict(row(40, 'projected_exhaustion'), 'openai-codex/gpt-x').status, 'ok', 'Another model\'s empty scope does not count');
    assert.match(quotaVerdict(row(0, 'exhausted_now'), 'gpt-x').note, /quota used up, back 2030/);
    assert.equal(quotaVerdict(row(40, 'ok'), 'openai-codex/other').status, 'exhausted', 'The model\'s own scope counts');
    assert.equal(quotaVerdict({ provider: 'copilot', state: { status: 'unavailable', error: 'keychain_prompt_required' }, quotaSemantics: { status: 'unknown' } }).status, 'unknown', 'An unreadable quota is uncertainty, not an empty account');
    assert.equal(quotaVerdict({ provider: 'claude', state: { status: 'unavailable', error: 'unauthorized' }, quotaSemantics: { status: 'unknown' } }).status, 'signed-out');
    assert.equal(quotaVerdict(undefined).status, 'unknown');
  }
  {
    // A home of its own, a fake quota-axi and a fake account-switcher with three saved logins.
    const home2 = path.join(root, 'home2'), bin = path.join(root, 'agents-bin'), switcher = path.join(root, 'switcher'), quotaFile = path.join(root, 'quota.json'), quotaLog = path.join(root, 'quota.log');
    fs.mkdirSync(bin); fs.mkdirSync(switcher);
    for (const name of ['a1', 'claude']) fs.writeFileSync(path.join(bin, name), '');
    fs.writeFileSync(path.join(switcher, 'claude-as.sh'), '#!/bin/sh');
    fs.writeFileSync(path.join(switcher, 'session-dir.js'), `
const fs = require('fs'), path = require('path'), [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'list') console.log('1. one@example.com  (Org, max)\\n2. two@example.com\\n3. gone@example.com\\n4. empty@example.com  (no saved login)');
else if (cmd === 'refresh') {
  if (rest[0] === 'gone@example.com') { console.log(JSON.stringify({ state: 'failed', email: rest[0], error: 'invalid_grant' })); process.exit(2); }
  fs.writeFileSync(path.join(rest[rest.indexOf('--into') + 1], '.credentials.json'), JSON.stringify({ who: rest[0] }));
  console.log(JSON.stringify({ state: 'fresh', email: rest[0] }));
}`);
    const fakeQuota = path.join(root, 'fake-quota.mjs');
    fs.writeFileSync(fakeQuota, `
import fs from 'node:fs'; import path from 'node:path';
const a = process.argv.slice(2), q = JSON.parse(fs.readFileSync(${JSON.stringify(quotaFile)}, 'utf8')), dir = process.env.CLAUDE_CONFIG_DIR;
const who = a.includes('--profile-only') ? JSON.parse(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8')).who : null;
fs.appendFileSync(${JSON.stringify(quotaLog)}, (who ?? a[a.indexOf('--provider') + 1]) + '\\n');
const row = (provider, left) => left === undefined ? { provider, notSetUp: true } : left === null ? { provider, state: { status: 'unavailable', error: 'keychain_prompt_required' }, quotaSemantics: { status: 'unknown' } }
  : { provider, windows: [], state: { status: 'fresh' }, quotaSemantics: { status: 'known', effectiveAvailability: [{ scope: 'all_models', effectivePercentRemaining: left, runway: { status: left > 0 ? 'ok' : 'exhausted_now' } }] } };
console.log(JSON.stringify({ schemaVersion: 5, providers: who ? [row('claude', q[who])] : a[a.indexOf('--provider') + 1].split(',').map(p => row(p, q[p])) }));
if (a[0] === '--version') process.exit(0);`);
    const setQuota = q => fs.writeFileSync(quotaFile, JSON.stringify(q));
    const E = { CREW_AGENT_PATH: bin, CREW_CLAUDE_LAUNCHER: path.join(switcher, 'claude-as.sh'), CREW_TOOL_QUOTA_AXI: fakeQuota, CREW_HOME: home2 };
    const crew2 = (args, terminal = 'k1', more = {}) => { const r = spawnSync(process.execPath, [path.join(here, 'crew.mjs'), ...args], { encoding: 'utf8', cwd: root, env: { ...process.env, CREW_CLAUDE_CONFIG: claudeConfig, HOME: fakeUser, USERPROFILE: fakeUser, CREW_HC: fake, CREW_WORKTREES: path.join(root, 'copies2'), HC_TERMINAL_ID: '', CREW_TERMINAL: terminal, CREW_TOOL_PATH: path.join(root, 'no-tools'), ...Object.fromEntries(TOOLS.map(t => [`CREW_TOOL_${t.id.toUpperCase().replace(/-/g, '_')}`, ''])), ...E, ...more } }); return { code: r.status, out: r.stdout + r.stderr }; };
    const task2 = id => JSON.parse(fs.readFileSync(path.join(home2, 'tasks', id, 'task.json'), 'utf8'));
    const lastRun = () => readWorld().log.filter(a => a[0] === 'run').at(-1).at(-1);
    assert.equal(crew2(['init', home2]).code, 0); assert.equal(crew2(['project', 'add', 'demo', project]).code, 0); assert.equal(crew2(['start']).code, 0);

    // Without a configuration nothing changes: a1 as before, no quota reading for a single candidate.
    setQuota({});
    let q = crew2(['spawn', 'plain', '--project', 'demo', 'Count lines.']); assert.equal(q.code, 0, q.out);
    assert.match(q.out, /spawned plain: a1 scout in terminal \S+, working copy \S+\r?\n/); assert.ok(lastRun().includes("'a1' 'Read the brief"), lastRun());
    assert.deepEqual(task2('plain').launch, { harness: 'a1', source: 'built-in' }); assert.ok(!fs.existsSync(quotaLog), 'One candidate: quota is not read');
    q = crew2(['spawn', 'bogus', '--project', 'demo', '--modle', 'x', 'Count.']); assert.equal(q.code, 2); assert.match(q.out, /Unknown option: --modle/); assert.ok(!fs.existsSync(path.join(home2, 'tasks', 'bogus')), 'A mistyped option makes no task');
    q = crew2(['spawn', 'bogus', '--project', 'demo', '--agent', 'a1', '--account', 'one@example.com', 'Count.']); assert.equal(q.code, 2); assert.match(q.out, /Only Claude Code has saved accounts/);
    // --agent claude alone stands for every saved login, the unusable ones passed over.
    setQuota({ 'one@example.com': 0, 'two@example.com': 55 });
    q = crew2(['spawn', 'acc', '--project', 'demo', '--agent', 'claude', '--model', 'opus', 'Count.']); assert.equal(q.code, 0, q.out);
    assert.match(q.out, /passed over claude opus as one@example\.com: quota used up/); assert.match(q.out, /; claude opus as two@example\.com\r?\n/);
    assert.ok(lastRun().includes("claude-as.sh' --as 'two@example.com' --command") && lastRun().includes("'--model' 'opus' '--permission-mode'"), lastRun());
    assert.deepEqual(task2('acc').chain.map(c => c.account), ['one@example.com', 'gone@example.com'], 'An exhausted or rejected login remains available for reconsideration');
    assert.deepEqual(fs.readFileSync(quotaLog, 'utf8').trim().split('\n'), ['one@example.com', 'two@example.com'], 'Each saved account is read by itself; the one whose login is gone is not');

    // The person's list: Firstmate's dispatch file, with roles and an account-less Claude profile.
    fs.mkdirSync(path.join(home2, 'config'));
    const dispatch = path.join(home2, 'config', 'crew-dispatch.json');
    fs.writeFileSync(dispatch, '{ broken');
    q = crew2(['spawn', 'cfg', '--project', 'demo', 'Count.']); assert.equal(q.code, 2); assert.match(q.out, /crew-dispatch\.json is not valid JSON/);
    fs.writeFileSync(dispatch, JSON.stringify({
      default: [{ harness: 'a1', model: 'openai-codex/gpt-x', effort: 'high' }, { harness: 'a1', model: 'github-copilot/gpt-x' }, { harness: 'pi', model: 'openai-codex/gpt-x' }, { harness: 'claude', model: 'opus' }],
      roles: { review: [{ harness: 'claude', model: 'sonnet', account: 'two@example.com' }] },
      rules: [{ when: 'A small mechanical edit', use: { harness: 'claude', model: 'haiku', effort: 'low' }, why: 'cheap' }] }));
    setQuota({ codex: 0, copilot: null, 'one@example.com': 70, 'two@example.com': 55 });
    q = crew2(['agents', '--json']); assert.equal(q.code, 0, q.out);
    const shown = JSON.parse(q.out);
    assert.deepEqual(shown.candidates.map(c => [c.label, c.status, c.next]), [
      ['a1 openai-codex/gpt-x (high)', 'exhausted', false], ['a1 github-copilot/gpt-x', 'unknown', true], ['pi openai-codex/gpt-x', 'missing', false],
      ['claude opus as one@example.com', 'ok', false], ['claude opus as two@example.com', 'ok', false], ['claude opus as gone@example.com', 'signed-out', false]]);
    assert.equal(shown.rules[0].use[0], 'claude haiku (low)');
    assert.match(crew2(['agents', '--role', 'review']).out, /-> claude sonnet as two@example\.com\s+ok\s+55% left/);
    assert.match(crew2(['agents']).out, /rule 1: A small mechanical edit\r?\n\s+use claude haiku \(low\)/);

    // Spawn: the exhausted first choice is passed over, the rest stands behind the worker.
    q = crew2(['spawn', 'cfg', '--project', 'demo', 'Count.']); assert.equal(q.code, 0, q.out);
    assert.match(q.out, /passed over a1 openai-codex\/gpt-x \(high\): quota used up/); assert.match(q.out, /; a1 github-copilot\/gpt-x, 2 more can take over/);
    assert.ok(lastRun().includes("'a1' '--provider' 'github-copilot' '--model' 'gpt-x' 'Read the brief"), lastRun());
    assert.deepEqual(task2('cfg').chain.map(c => c.account), [undefined, undefined, 'one@example.com', 'two@example.com', 'gone@example.com']);
    assert.match(crew2(['status']).out, /cfg\tworking\tscout\/a1 github-copilot\/gpt-x\t/);
    assert.equal(JSON.parse(crew2(['status', '--json']).out).tasks.find(t => t.id === 'cfg').standby.length, 5);

    // The worker stops on a limit: `crew wait` hands the task to the next candidate and goes on waiting.
    const first = task2('cfg').terminal;
    setTerminal(first, { status: { state: 'error', app: 'a1' }, screen: 'read crew.mjs\n Error: Codex error: The usage limit has been reached\n' });
    q = crew2(['wait', 'cfg', '--timeout', '8']); assert.equal(q.code, 124, q.out);
    assert.match(q.out, /== cfg: a1 github-copilot\/gpt-x stopped \(Error: Codex error: The usage limit has been reached\); claude opus as one@example\.com continues it in terminal/);
    const moved = task2('cfg');
    assert.equal(moved.agent, 'claude'); assert.equal(moved.state, 'working'); assert.notEqual(moved.terminal, first); assert.equal(readWorld().terminals[first], undefined, 'The stopped worker\'s terminal is gone');
    assert.deepEqual(moved.chain.map(c => c.account), [undefined, undefined, 'two@example.com', 'gone@example.com']); assert.equal(moved.fallbacks.length, 1);
    assert.ok(lastRun().includes("--as 'one@example.com'") && lastRun().includes('Another worker (a1 github-copilot/gpt-x) began this task and had to stop') && lastRun().includes('continue from there'), lastRun());
    assert.equal(readWorld().terminals[moved.terminal].cwd, moved.worktree, 'Same working copy');
    assert.match(crew2(['status']).out, /scout\/claude opus as one@example\.com \(after a1 github-copilot\/gpt-x\)/);
    // A worker that is merely idle, or working with old text on screen, is left alone.
    setTerminal(moved.terminal, { status: { state: 'working', app: 'claude' }, screen: 'usage limit reached' });
    q = crew2(['wait', 'cfg', '--timeout', '6']); assert.equal(q.code, 124); assert.equal(task2('cfg').terminal, moved.terminal, 'A working agent is never replaced');
    // --no-fallback keeps the worker; a session that does not hold the home never hands over.
    setTerminal(moved.terminal, { status: { state: 'idle', app: 'claude' }, screen: "You've hit your limit · resets 3pm" });
    q = crew2(['wait', 'cfg', '--timeout', '6', '--no-fallback']); assert.equal(q.code, 124); assert.equal(task2('cfg').terminal, moved.terminal);
    q = crew2(['wait', 'cfg', '--timeout', '6'], 'k9'); assert.equal(q.code, 124); assert.equal(task2('cfg').terminal, moved.terminal, 'Only the owner hands work over');
    // Two more limits: the last candidate, then nobody. That is said, not looped on.
    q = crew2(['wait', 'cfg', '--timeout', '6']); assert.match(q.out, /claude opus as two@example\.com continues it/);
    setTerminal(task2('cfg').terminal, { status: { state: 'idle', app: 'claude' }, screen: 'Please run /login' });
    q = crew2(['wait', 'cfg', '--timeout', '8']); assert.equal(q.code, 7, q.out);
    assert.match(q.out, /== cfg: needs a person - claude opus as two@example\.com stopped \(Please run \/login\) and nobody else can take it:/);
    // By hand: the coordinator (or the person) names who takes it. The quota has come back for codex.
    setQuota({ codex: 30, copilot: null, 'one@example.com': 70, 'two@example.com': 55 });
    q = crew2(['relaunch', 'cfg', '--agent', 'a1', '--model', 'openai-codex/gpt-x', 'quota is back']); assert.equal(q.code, 0, q.out);
    assert.match(q.out, /relaunched cfg: a1 openai-codex\/gpt-x in terminal/); assert.equal(task2('cfg').agent, 'a1'); assert.ok(lastRun().includes('had to stop: quota is back'), lastRun());

    // Recovery uses Core send, not tell: its limits and history survive another wait.
    const recovering = (id, terminalPatch = {}, taskPatch = {}) => {
      const dir = path.join(home2, 'tasks', id), address = `recover-${id}`;
      fs.mkdirSync(dir);
      const task = { ...task2('plain'), id, terminal: address, state: 'working', tells: 2, candidates: taskPatch.chain ?? [], chain: [],
        worktree: path.join(dir, 'copy'), brief: path.join(dir, 'brief.md'), report: path.join(dir, 'report.md'), ...taskPatch };
      fs.mkdirSync(task.worktree);
      fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify(task));
      const w = readWorld();
      w.terminals[address] = { address, state: 'live', labels: {}, status: { state: 'error', app: 'a1' },
        screen: 'Error: no healthy upstream\n', ...terminalPatch };
      fs.writeFileSync(world, JSON.stringify(w));
      return task;
    };
    const sendsTo = address => readWorld().log.filter(a => a[0] === 'send' && a[1] === address);
    const quickWait = (id, more = {}, args = [], terminal = 'k1', timeout = '4') => crew2(['wait', id, '--timeout', timeout, ...args], terminal, { CREW_RECOVERY_SECONDS: '0', ...more });
    const errorState = { status: { state: 'error', app: 'a1' } }, workingState = { status: { state: 'working', app: 'a1' } };
    {
      const task = recovering('error-once', { steps: [errorState, workingState] });
      q = quickWait(task.id, {}, [], 'k1', '0.6'); assert.equal(q.code, 124, q.out);
      assert.equal(sendsTo(task.terminal).length, 0, 'One error observation is not a stop');
      const observed = readWorld().log.filter(a => a[0] === 'get' && a.at(-1) === task.terminal);
      assert.ok(observed.length >= 2, 'Both the error and working state were observed');
    }
    {
      const task = recovering('error-cap');
      q = quickWait(task.id, { CREW_RECOVERY_SECONDS: '0.06' }); assert.equal(q.code, 7, q.out);
      const nudges = task2(task.id).nudges;
      assert.deepEqual(nudges.map(n => [n.kind, n.attempt]), [['error', 1], ['error', 2], ['error', 3]]);
      assert.ok(Date.parse(nudges[0].at) - Date.parse(task2(task.id).recovery.since) >= 60, 'First message waits one unit');
      assert.ok(Date.parse(nudges[1].at) - Date.parse(nudges[0].at) >= 240, 'Second message waits four units');
      assert.ok(Date.parse(nudges[2].at) - Date.parse(nudges[1].at) >= 600, 'Third message waits ten units');
      assert.equal(task2(task.id).tells, 2); assert.equal(task2(task.id).state, 'working');
      assert.match(q.out, /stopped on an error \(Error: no healthy upstream\); told to continue \(1 of 3\)/);
      assert.match(q.out, /needs a person.*told to continue 3 times without recovery.*no other candidate/);
      const log = readWorld().log, sent = log.findIndex(a => a[0] === 'send' && a[1] === task.terminal);
      assert.ok(log.slice(0, sent).filter(a => a[0] === 'get' && a.at(-1) === task.terminal).length >= 2);
      q = quickWait(task.id); assert.equal(q.code, 7, q.out);
      assert.equal(sendsTo(task.terminal).length, 3, 'Another wait cannot bypass the cap');
    }
    {
      const lastError = 'Error: upstream connect error or disconnect/reset before headers: remote connection failure';
      const task = recovering('error-handover', { onSends: [{}, {}, { screen: `${lastError}\n` }] }, {
        chain: [{ harness: 'a1', model: 'openai-codex/gpt-x' }],
        candidates: [{ harness: 'a1' }, { harness: 'a1', model: 'github-copilot/gpt-x' }, { harness: 'a1', model: 'openai-codex/gpt-x' }],
      });
      q = quickWait(task.id, {}, [], 'k1', '2'); assert.equal(q.code, 124, q.out);
      const moved = task2(task.id);
      assert.notEqual(moved.terminal, task.terminal, q.out); assert.equal(sendsTo(task.terminal).length, 3);
      assert.equal(moved.fallbacks.at(-1).why, lastError);
      assert.equal(moved.launch.model, 'github-copilot/gpt-x', 'Error hand-over rechecks the full saved candidates, not just the old usable chain');
      assert.deepEqual(moved.candidates, task.candidates); assert.deepEqual(moved.chain, task.chain);
      assert.equal(readWorld().terminals[moved.terminal].cwd, task.worktree);
      assert.ok(lastRun().includes(lastError), lastRun());
    }
    {
      const task = recovering('error-reset', { onSends: [
        { steps: [workingState, workingState, workingState, workingState, errorState, errorState] },
        { status: { state: 'blocked', msg: 'permission needed' } },
      ] });
      q = quickWait(task.id, { CREW_RECOVERY_SECONDS: '0.05' }); assert.equal(q.code, 7, q.out);
      assert.deepEqual(task2(task.id).nudges.map(n => n.attempt), [1, 1], 'Sustained work starts a fresh stop');
    }
    {
      const task = recovering('error-flicker', { onSends: [{ steps: [workingState, errorState, errorState] }] });
      q = quickWait(task.id, { CREW_RECOVERY_SECONDS: '0.1' }); assert.equal(q.code, 7, q.out);
      assert.deepEqual(task2(task.id).nudges.map(n => n.attempt), [1, 2, 3], 'A working flicker does not reset retries');
    }
    {
      const task = recovering('error-quota', { screen: 'Error: usage limit reached\n' });
      q = quickWait(task.id); assert.equal(q.code, 7, q.out);
      assert.equal(sendsTo(task.terminal).length, 0, 'Quota is handled before transient errors');
      assert.match(q.out, /stopped \(Error: usage limit reached\)/);
    }
    for (const [id, env, args, owner] of [
      ['error-no-flag', {}, ['--no-fallback'], 'k1'],
      ['error-no-env', { CREW_NO_FALLBACK: '1' }, [], 'k1'],
      ['error-not-owner', {}, [], 'k9'],
    ]) {
      const task = recovering(id), before = task2(id);
      q = quickWait(id, env, args, owner, '0.4'); assert.equal(q.code, 124, q.out);
      assert.deepEqual(task2(id), before, 'Disabled recovery does not change the task');
      assert.equal(sendsTo(task.terminal).length, 0);
    }
    {
      const task = recovering('error-send-fails', { sendError: true });
      q = quickWait(task.id); assert.equal(q.code, 7, q.out);
      assert.match(q.out, /needs a person.*did not deliver.*send transport unavailable/);
      assert.equal(task2(task.id).nudges, undefined); assert.equal(task2(task.id).recovery.errors, 0);
    }
    {
      const task = recovering('error-fast-report');
      setTerminal(task.terminal, { reportOnSend: path.join(home2, 'tasks', task.id, 'task.json') });
      q = quickWait(task.id); assert.equal(q.code, 0, q.out);
      assert.equal(task2(task.id).state, 'reported', 'A report during send is not overwritten');
      assert.equal(task2(task.id).tells, 9, 'Newest task fields survive send');
      assert.equal(task2(task.id).nudges.length, 1);
      q = quickWait(task.id); assert.equal(q.code, 0); assert.equal(sendsTo(task.terminal).length, 1);
    }

    // Idle/done workers get one delayed reminder, never a substitute answer to a question.
    for (const state of ['idle', 'done']) {
      const task = recovering(`idle-${state}`, { status: { state, app: 'a1' } });
      q = quickWait(task.id, { CREW_RECOVERY_SECONDS: '0.2' }, [], 'k1', '0.5'); assert.equal(q.code, 124, q.out);
      assert.equal(sendsTo(task.terminal).length, 0, 'The idle delay has not elapsed');
      const since = task2(task.id).recovery.since;
      q = quickWait(task.id, { CREW_RECOVERY_SECONDS: '0.2' }); assert.equal(q.code, 7, q.out);
      assert.equal(sendsTo(task.terminal).length, 1);
      assert.ok(Date.parse(task2(task.id).nudges[0].at) - Date.parse(since) >= 800);
      assert.equal(task2(task.id).nudges[0].kind, 'idle'); assert.equal(task2(task.id).tells, 2);
      assert.match(sendsTo(task.terminal)[0][2], new RegExp(`crew done ${task.id}`));
      assert.match(q.out, /needs a person.*idle without a report after its reminder/);
      q = quickWait(task.id); assert.equal(q.code, 7, q.out);
      assert.equal(sendsTo(task.terminal).length, 1, 'The reminder is not repeated in another wait');
    }
    {
      const task = recovering('idle-resumes', { status: { state: 'idle', app: 'a1' }, onSends: [workingState] });
      q = quickWait(task.id, {}, [], 'k1', '0.5'); assert.equal(q.code, 124, q.out);
      assert.equal(sendsTo(task.terminal).length, 1); assert.equal(task2(task.id).state, 'working');
    }
    {
      const task = recovering('idle-blocked', { status: { state: 'blocked', msg: 'Allow this command?' }, screen: 'Error: usage limit reached\n' });
      q = quickWait(task.id); assert.equal(q.code, 7, q.out);
      assert.match(q.out, /needs a person - Allow this command\?/);
      assert.equal(sendsTo(task.terminal).length, 0);
    }
    for (const [id, state] of [['idle-reported', 'reported'], ['idle-report-file', 'working']]) {
      const task = recovering(id, { status: { state: 'idle', app: 'a1' } }, { state });
      fs.writeFileSync(task.report, 'Already finished.');
      const before = task2(id);
      q = quickWait(id, {}, [], 'k1', '0.4'); assert.equal(q.code, state === 'reported' ? 0 : 124, q.out);
      assert.equal(sendsTo(task.terminal).length, 0); assert.deepEqual(task2(id), before);
    }
    {
      const task = recovering('idle-fast-report', { status: { state: 'idle', app: 'a1' } });
      setTerminal(task.terminal, { reportOnSend: path.join(home2, 'tasks', task.id, 'task.json') });
      q = quickWait(task.id); assert.equal(q.code, 0, q.out);
      assert.equal(task2(task.id).state, 'reported'); assert.equal(task2(task.id).nudges.length, 1);
    }

    // Status combines live Core state with recorded sends and never performs recovery.
    {
      const task = task2('error-cap'), before = task2(task.id), sent = sendsTo(task.terminal).length;
      q = crew2(['status']); assert.equal(q.code, 0, q.out);
      assert.match(q.out, /error-cap\tworking\t[^\r\n]*\(error; told to continue 3 times\)/);
      q = crew2(['status', '--json']); assert.equal(q.code, 0, q.out);
      const shown = JSON.parse(q.out).tasks.find(t => t.id === task.id);
      assert.equal(shown.core.status, 'error'); assert.equal(shown.continuations, 3);
      assert.deepEqual(shown.nudges, task.nudges); assert.equal(shown.recovery.errors, 3);
      assert.deepEqual(task2(task.id), before); assert.equal(sendsTo(task.terminal).length, sent);
      setTerminal(task.terminal, workingState);
      const changed = JSON.parse(crew2(['status', '--json']).out).tasks.find(t => t.id === task.id);
      assert.equal(changed.core.status, 'working'); assert.equal(changed.continuations, 3);
      assert.deepEqual(task2(task.id), before, 'Status does not reset recovery or send messages');
      const fresh = recovering('status-error', {}, { nudges: [{ kind: 'error', terminal: 'old-worker', attempt: 1 }] });
      q = crew2(['status']); assert.match(q.out, /status-error\tworking\t[^\r\n]*\(error; told to continue 0 times\)/);
      const zero = JSON.parse(crew2(['status', '--json']).out).tasks.find(t => t.id === fresh.id);
      assert.equal(zero.continuations, 0); assert.equal(zero.nudges.length, 1);
      assert.equal(sendsTo(fresh.terminal).length, 0);
    }

    // finish never takes somebody else's terminal down with the working copy: returning a pool slot
    // ends every process that sits in it, and a person's own session may have been opened there.
    // Finish then does everything else and only postpones returning the copy; a later start or
    // finish returns it once nothing holds it.
    {
      const mine = task2('plain'), w = readWorld(), setWorld = f => { const v = readWorld(); f(v); fs.writeFileSync(world, JSON.stringify(v)); };
      // Opened from the worker's tab, then moved on: Core's cwd is still the copy, the label says where it is now.
      w.terminals.guest = { address: 'guest', agent: 'claude-code', state: 'live', labels: { 'custom.cwd': 'C:/elsewhere' }, status: null, cwd: mine.worktree.replace(/\//g, '\\').toUpperCase() };
      w.terminals['pc2/t1'] = { address: 'pc2/t1', state: 'live', labels: {}, status: null, cwd: mine.worktree };
      w.terminals.sibling = { address: 'sibling', state: 'live', labels: {}, status: null, cwd: `${mine.worktree}-other` };
      fs.writeFileSync(world, JSON.stringify(w));
      // A Core that cannot list its terminals still stops everything.
      setWorld(v => { v.silentLs = true; });
      q = crew2(['finish', 'plain']); assert.equal(q.code, 4, q.out); assert.match(q.out, /Core did not answer about the terminals in/);
      assert.ok(fs.existsSync(mine.worktree) && readWorld().terminals[mine.terminal]?.state === 'live' && task2('plain').state !== 'closed', 'Nothing was stopped or removed');
      setWorld(v => { delete v.silentLs; });
      // The refusals that protect work still come first.
      fs.mkdirSync(path.join(mine.worktree, '.artifacts')); fs.writeFileSync(path.join(mine.worktree, '.artifacts', 'KEEP'), '');
      q = crew2(['finish', 'plain']); assert.equal(q.code, 6, q.out); assert.match(q.out, /marked to keep by \.artifacts\/KEEP/); assert.notEqual(task2('plain').state, 'closed');
      fs.rmSync(path.join(mine.worktree, '.artifacts'), { recursive: true });
      q = crew2(['spawn', 'dirty', '--project', 'demo', '--kind', 'ship', 'x']); assert.equal(q.code, 0, q.out);
      const dirty = task2('dirty'); fs.writeFileSync(path.join(dirty.worktree, 'half.txt'), 'x');
      setWorld(v => { v.terminals.guest2 = { address: 'guest2', state: 'live', labels: {}, status: null, cwd: dirty.worktree }; });
      q = crew2(['finish', 'dirty']); assert.equal(q.code, 6, q.out); assert.match(q.out, /has uncommitted work .*half\.txt/); assert.notEqual(task2('dirty').state, 'closed');
      fs.rmSync(path.join(dirty.worktree, 'half.txt'));
      // Now finish goes through: the task is closed, its own terminal removed, the copy and the guest kept.
      q = crew2(['finish', 'plain']); assert.equal(q.code, 0, q.out);
      assert.ok(!q.out.includes('still held by another terminal'), 'One line: the sweep does not repeat the task just finished');
      assert.match(q.out, /finished plain \([^)]*\); its working copy is kept for now \(terminal guest claude-code \(opened in the copy, now in C:\/elsewhere\) holds it\) and crew returns it by itself once nothing holds it/);
      assert.ok(!q.out.includes('pc2/t1') && !q.out.includes('sibling'), 'A terminal of another machine or of a sibling folder does not hold the copy');
      assert.equal(task2('plain').state, 'closed'); assert.ok(task2('plain').copyToReturn);
      assert.equal(readWorld().terminals[mine.terminal], undefined, 'Its own terminal is gone');
      assert.ok(fs.existsSync(mine.worktree) && readWorld().terminals.guest.state === 'live', 'The copy and the guest are kept');
      // Nothing is hidden: status says it, --all shows who holds it.
      assert.match(crew2(['status']).out, /1 working copy of finished tasks still to be returned \(crew status --all\)/);
      assert.match(crew2(['status', '--all']).out, /plain\tclosed\t.*working copy still to be returned, held by guest claude-code \(opened in the copy, now in C:\/elsewhere\)/);
      assert.match(JSON.parse(crew2(['status', '--all', '--json']).out).tasks.find(t => t.id === 'plain').copyToReturn.heldBy, /^guest claude-code/);
      // While it is held, start and other finishes leave it.
      q = crew2(['start']); assert.equal(q.code, 0, q.out); assert.match(q.out, /1 working copy of finished tasks still held by another terminal/);
      assert.ok(fs.existsSync(mine.worktree));
    }
    {
      const plain = task2('plain'), dirty = task2('dirty'), setWorld = f => { const v = readWorld(); f(v); fs.writeFileSync(world, JSON.stringify(v)); };
      q = crew2(['finish', 'dirty']); assert.equal(q.code, 0, q.out); assert.match(q.out, /finished dirty .*kept for now \(terminal guest2 holds it\)/);
      assert.match(q.out, /1 working copy of finished tasks still held by another terminal/, 'The other waiting copy (plain) is still summed up');
      assert.ok(fs.existsSync(plain.worktree) && fs.existsSync(dirty.worktree));
      // The guest of plain closes, but somebody marked the copy to keep meanwhile: it waits, and says why.
      setWorld(v => { delete v.terminals.guest; });
      fs.mkdirSync(path.join(plain.worktree, '.artifacts')); fs.writeFileSync(path.join(plain.worktree, '.artifacts', 'KEEP'), '');
      q = crew2(['spawn', 'other', '--project', 'demo', 'x']); assert.equal(q.code, 0, q.out);
      q = crew2(['finish', 'other']); assert.equal(q.code, 0, q.out);
      assert.match(q.out, /the working copy of finished task plain waits: it was marked to keep by \.artifacts\/KEEP since finish\. `crew finish plain --force` discards it/);
      assert.ok(fs.existsSync(path.join(plain.worktree, '.artifacts', 'KEEP')) && task2('plain').copyToReturn);
      assert.equal(JSON.parse(crew2(['status', '--all', '--json']).out).tasks.find(t => t.id === 'plain').copyToReturn.why, 'marked to keep');
      // Once the marker is gone the next finish of another task returns plain's copy.
      fs.rmSync(path.join(plain.worktree, '.artifacts'), { recursive: true });
      // A commit made in the (detached) scout copy after finish leaves status clean, but no
      // branch holds it: the copy waits rather than lose it.
      git('-C', plain.worktree, ...who, 'commit', '--allow-empty', '-qm', 'mine');
      const mineCommit = git('-C', plain.worktree, 'rev-parse', 'HEAD').trim();
      q = crew2(['spawn', 'other2', '--project', 'demo', 'x']); assert.equal(q.code, 0, q.out);
      q = crew2(['finish', 'other2']); assert.equal(q.code, 0, q.out);
      assert.match(q.out, new RegExp(`the working copy of finished task plain waits: it has commits made since finish that no branch holds \\(${mineCommit.slice(0, 8)}\\)`));
      assert.ok(fs.existsSync(plain.worktree)); assert.equal(JSON.parse(crew2(['status', '--all', '--json']).out).tasks.find(t => t.id === 'plain').copyToReturn.why, 'commits');
      // Moving back to where it was does not hide it: the copy's own reflog still names it.
      git('-C', plain.worktree, 'checkout', '-q', '--detach', 'HEAD~1');
      assert.match(crew2(['start']).out, /plain waits: it has commits made since finish that no branch holds/);
      // Once a branch holds the commit, nothing is lost with the copy and it goes back. A branch
      // created and checked out there, and a stash made there, live in the repository and stay.
      git('-C', plain.worktree, 'switch', '-q', '-c', 'keep-mine', mineCommit);
      fs.writeFileSync(path.join(plain.worktree, 'stashed.txt'), 'put aside');
      git('-C', plain.worktree, ...who, 'stash', 'push', '-q', '-u', '-m', 'put aside in the copy');
      q = crew2(['finish', 'other2']); assert.equal(q.code, 0, q.out);
      assert.match(q.out, /returned the working copy of finished task plain/); assert.match(q.out, /1 working copy of finished tasks still held by another terminal/);
      assert.equal(git('-C', project, 'rev-parse', 'keep-mine').trim(), mineCommit, 'The branch made in the copy outlives it');
      assert.match(git('-C', project, 'stash', 'list'), /put aside in the copy/, 'So does a stash made there');
      git('-C', project, 'stash', 'drop', '-q'); git('-C', project, 'branch', '-D', 'keep-mine');
      assert.ok(!fs.existsSync(plain.worktree) && !task2('plain').copyToReturn && task2('plain').copyReturned, 'Returned and no longer marked');
      assert.ok(fs.existsSync(dirty.worktree), 'A copy still held is left');
      // The guest of dirty closes after writing into the copy: start keeps the copy and its work.
      setWorld(v => { delete v.terminals.guest2; });
      fs.writeFileSync(path.join(dirty.worktree, 'later.txt'), 'new work');
      q = crew2(['start']); assert.equal(q.code, 0, q.out); assert.match(q.out, /the working copy of finished task dirty waits: it has work written since finish \(later\.txt\)/);
      assert.ok(fs.existsSync(path.join(dirty.worktree, 'later.txt')) && task2('dirty').copyToReturn, 'Work written after finish is never discarded unasked');
      assert.match(crew2(['status', '--all']).out, /dirty\tclosed\t.*waits: it has work written since finish \(later\.txt\) \(crew finish dirty --force discards it\)/);
      assert.equal(JSON.parse(crew2(['status', '--all', '--json']).out).tasks.find(t => t.id === 'dirty').copyToReturn.why, 'uncommitted work');
      // `finish --force` on the closed task is the person's word to discard it, but never while a terminal holds it.
      setWorld(v => { v.terminals.guest3 = { address: 'guest3', state: 'live', labels: {}, status: null, cwd: dirty.worktree }; });
      q = crew2(['finish', 'dirty', '--force']); assert.equal(q.code, 6, q.out); assert.match(q.out, /still held by guest3; nothing was removed/);
      assert.ok(fs.existsSync(path.join(dirty.worktree, 'later.txt')));
      setWorld(v => { delete v.terminals.guest3; });
      q = crew2(['finish', 'dirty']); assert.equal(q.code, 0, q.out); assert.match(q.out, /dirty is already closed; its working copy still waits/); assert.ok(fs.existsSync(dirty.worktree));
      q = crew2(['finish', 'dirty', '--force']); assert.equal(q.code, 0, q.out); assert.match(q.out, /returned the working copy of finished task dirty; merged branch \S+ deleted/);
      assert.ok(!fs.existsSync(dirty.worktree) && !task2('dirty').copyToReturn);
      assert.ok(!crew2(['status']).out.includes('still to be returned'));
      // A waiting copy removed by hand: start forgets it in git and drops its merged branch.
      q = crew2(['spawn', 'byhand', '--project', 'demo', '--kind', 'ship', 'x']); assert.equal(q.code, 0, q.out);
      const byhand = task2('byhand');
      setWorld(v => { v.terminals.guest4 = { address: 'guest4', state: 'live', labels: {}, status: null, cwd: byhand.worktree }; });
      q = crew2(['finish', 'byhand']); assert.equal(q.code, 0, q.out); assert.match(q.out, /kept for now/);
      setWorld(v => { delete v.terminals.guest4; });
      fs.rmSync(byhand.worktree, { recursive: true, force: true });
      q = crew2(['start']); assert.equal(q.code, 0, q.out); assert.match(q.out, /the working copy of finished task byhand was already gone; merged branch feature\/byhand deleted/);
      assert.ok(!git('-C', project, 'worktree', 'list').includes(slash(byhand.worktree)) && !task2('byhand').copyToReturn, 'Its stale entry is pruned');
      assert.equal(git('-C', project, 'branch', '--list', 'feature/byhand').trim(), '');
      // A --force given at finish covers only what was in the copy then: work written later
      // stays, and the files it did cover go with the copy once that is free.
      q = crew2(['spawn', 'forced', '--project', 'demo', '--kind', 'ship', 'x']); assert.equal(q.code, 0, q.out);
      const forced = task2('forced');
      setTerminal(forced.terminal, { status: { state: 'working', app: 'a1' } });
      setWorld(v => { v.terminals.guest6 = { address: 'guest6', state: 'live', labels: {}, status: null, cwd: forced.worktree }; });
      fs.writeFileSync(path.join(forced.worktree, 'half.txt'), 'covered by --force');
      // git quotes a name like this in its text output; the snapshot must still see the file.
      const notes = 'заметки ü.md';
      fs.writeFileSync(path.join(forced.worktree, notes), 'covered by --force');
      q = crew2(['finish', 'forced', '--force']); assert.equal(q.code, 0, q.out); assert.match(q.out, /finished forced \(cancelled; terminal ended\); its working copy is kept for now/);
      fs.writeFileSync(path.join(forced.worktree, 'later.txt'), 'written after finish');
      setWorld(v => { delete v.terminals.guest6; });
      q = crew2(['start']); assert.equal(q.code, 0, q.out); assert.match(q.out, /the working copy of finished task forced waits: it has work written since finish \(later\.txt\)/);
      assert.ok(fs.existsSync(path.join(forced.worktree, 'later.txt')), 'A --force given at finish never discards later work');
      fs.writeFileSync(path.join(forced.worktree, 'half.txt'), 'changed after finish');
      q = crew2(['start']); assert.match(q.out, /forced waits: it has work written since finish \(half\.txt, later\.txt\)/, 'A covered file changed later counts as new work');
      fs.rmSync(path.join(forced.worktree, 'later.txt')); fs.rmSync(path.join(forced.worktree, 'half.txt'));
      assert.ok(Object.entries(task2('forced').copyToReturn.left.files).some(([file, time]) => file === notes && typeof time === 'number'), 'The quoted name is recorded with its time');
      fs.writeFileSync(path.join(forced.worktree, notes), 'changed after finish');
      q = crew2(['start']); assert.match(q.out, /forced waits: it has work written since finish \(заметки ü\.md\)/, 'A covered file with a quoted name changed later counts as new work');
      assert.equal(fs.readFileSync(path.join(forced.worktree, notes), 'utf8'), 'changed after finish');
      fs.rmSync(path.join(forced.worktree, notes));
      // An ignored file goes with the copy too, so one written since finish keeps it as well.
      const exclude = path.join(project, '.git', 'info', 'exclude'); fs.mkdirSync(path.dirname(exclude), { recursive: true }); fs.appendFileSync(exclude, '\nscratch/\n');
      fs.mkdirSync(path.join(forced.worktree, 'scratch')); fs.writeFileSync(path.join(forced.worktree, 'scratch', 'notes.md'), 'mine');
      q = crew2(['start']); assert.match(q.out, /forced waits: it has work written since finish \(scratch\/\)/); assert.ok(fs.existsSync(path.join(forced.worktree, 'scratch', 'notes.md')));
      fs.rmSync(path.join(forced.worktree, 'scratch'), { recursive: true });
      // A merge (or rebase, cherry-pick...) begun in the copy after finish keeps it as well.
      const forcedGitDir = git('-C', forced.worktree, 'rev-parse', '--absolute-git-dir').trim();
      fs.writeFileSync(path.join(forcedGitDir, 'MERGE_HEAD'), `${git('-C', forced.worktree, 'rev-parse', 'HEAD').trim()}\n`);
      q = crew2(['start']); assert.match(q.out, /forced waits: it has a merge in progress since finish/); assert.ok(fs.existsSync(forced.worktree));
      fs.rmSync(path.join(forcedGitDir, 'MERGE_HEAD'));
      // `git worktree lock` is somebody's word to keep it.
      git('-C', project, 'worktree', 'lock', forced.worktree);
      q = crew2(['start']); assert.match(q.out, /forced waits: it has a lock \(git worktree lock\) since finish/); assert.ok(fs.existsSync(forced.worktree));
      git('-C', project, 'worktree', 'unlock', forced.worktree);
      q = crew2(['start']); assert.match(q.out, /returned the working copy of finished task forced/); assert.ok(!fs.existsSync(forced.worktree));
      // A waiting copy keeps its project, which is needed to hand it back.
      assert.equal(crew2(['project', 'add', 'side', project]).code, 0);
      q = crew2(['spawn', 'retry', '--project', 'side', '--kind', 'ship', 'x']); assert.equal(q.code, 0, q.out);
      const retry = task2('retry');
      setWorld(v => { v.terminals.guest5 = { address: 'guest5', state: 'live', labels: {}, status: null, cwd: retry.worktree }; });
      q = crew2(['finish', 'retry']); assert.equal(q.code, 0, q.out); assert.match(q.out, /kept for now/);
      q = crew2(['project', 'remove', 'side']); assert.equal(q.code, 2, q.out); assert.match(q.out, /Project side still has working copies of finished tasks to return: retry/);
      // A silent Core during the sweep keeps everything and still says which copies wait.
      setWorld(v => { v.silentLs = true; });
      q = crew2(['start']); assert.equal(q.code, 0, q.out); assert.match(q.out, /Core did not answer about the terminals in the working copies of finished tasks; 1 copy waits to be returned and was kept \(retry\)/);
      setWorld(v => { delete v.silentLs; });
      assert.ok(fs.existsSync(retry.worktree));
      // Asking again for a closed task whose copy is now free returns it, without --force.
      q = crew2(['finish', 'retry']); assert.equal(q.code, 0, q.out); assert.match(q.out, /retry is already closed; its working copy still waits to be returned: the working copy of retry is still held by guest5/);
      setWorld(v => { delete v.terminals.guest5; });
      q = crew2(['finish', 'retry']); assert.equal(q.code, 0, q.out); assert.match(q.out, /retry is already closed; returned the working copy of finished task retry/);
      assert.ok(!fs.existsSync(retry.worktree) && !task2('retry').copyToReturn);
      assert.equal(crew2(['project', 'remove', 'side']).code, 0);
    }
    // A rule, a role, and nobody left.
    q = crew2(['spawn', 'ruled', '--project', 'demo', '--rule', '1', 'Rename x.']); assert.equal(q.code, 0, q.out);
    assert.deepEqual([task2('ruled').launch.model, task2('ruled').launch.effort, task2('ruled').launch.source], ['haiku', 'low', 'rule 1']);
    assert.equal(crew2(['spawn', 'ruled2', '--project', 'demo', '--rule', '4', 'x']).code, 2);
    setQuota({ codex: 0, copilot: 0, 'one@example.com': 0, 'two@example.com': 0 });
    q = crew2(['spawn', 'nobody', '--project', 'demo', 'Count.']); assert.equal(q.code, 8, q.out);
    assert.match(q.out, /Nobody can take this work now:\r?\n\s+a1 openai-codex\/gpt-x \(high\) - quota used up/); assert.match(q.out, /pi openai-codex\/gpt-x - pi is not installed/); assert.match(q.out, /gone@example\.com - its saved login is no longer accepted \(invalid_grant\)/);
    assert.ok(!fs.existsSync(path.join(home2, 'tasks', 'nobody')), 'No task, copy or terminal is made when nobody can work');
    // shared_quota: Firstmate's switch for one shared pool; nothing is read and the order decides.
    fs.writeFileSync(dispatch, JSON.stringify({ shared_quota: true, default: [{ harness: 'a1', model: 'openai-codex/gpt-x' }, { harness: 'claude', account: 'one@example.com' }] }));
    // A floor: an account under it yields to the next, and is still used when nobody else can work.
    fs.writeFileSync(dispatch, JSON.stringify({ default: [{ harness: 'a1', model: 'openai-codex/gpt-x' }, { harness: 'claude', model: 'opus', account: 'one@example.com', floor: 50 }, { harness: 'claude', model: 'opus', account: 'two@example.com', floor: 50 }, { harness: 'claude', model: 'opus', account: 'gone@example.com' }] }));
    setQuota({ codex: 0, 'one@example.com': 49, 'two@example.com': 80 });
    q = crew2(['spawn', 'floor1', '--project', 'demo', 'Count.']); assert.equal(q.code, 0, q.out);
    assert.match(q.out, /passed over claude opus as one@example\.com: 49% left, under its floor of 50%/); assert.equal(task2('floor1').launch.account, 'two@example.com');
    assert.deepEqual(task2('floor1').chain.map(c => [c.account, c.floor]), [[undefined, undefined], ['one@example.com', 50], ['gone@example.com', undefined]], 'The complete original order and floors survive for later reconsideration');
    setQuota({ codex: 0, 'one@example.com': 49, 'two@example.com': 20 });
    q = crew2(['spawn', 'floor2', '--project', 'demo', 'Count.']); assert.equal(q.code, 0, q.out);
    assert.match(q.out, /claude opus as one@example\.com is under its floor \(49% left, under its floor of 50%\), but nobody above their floor can take the work/); assert.equal(task2('floor2').launch.account, 'one@example.com');
    assert.match(crew2(['agents']).out, /claude opus as two@example\.com\s+low\s+20% left, under its floor of 50%/);
    assert.throws(() => cleanProfile({ harness: 'claude', floor: 140 }), /Not a usable floor/);
    fs.writeFileSync(dispatch, JSON.stringify({ shared_quota: true, default: [{ harness: 'a1', model: 'openai-codex/gpt-x' }, { harness: 'claude', account: 'one@example.com' }] }));
    fs.rmSync(quotaLog); q = crew2(['spawn', 'pool', '--project', 'demo', 'Count.']); assert.equal(q.code, 0, q.out); assert.equal(task2('pool').launch.model, 'openai-codex/gpt-x'); assert.ok(!fs.existsSync(quotaLog));

    // A worker whose agent is gone (crashed at start, or left) with no report: the next candidate takes over.
    const deadTerminal = task2('pool').terminal;
    setTerminal(deadTerminal, { status: null, screen: 'A1 stopped after an unexpected error. Diagnostic: C:/x/fatal-1.json\ncrew on HEAD\n> ' });
    q = crew2(['wait', 'pool', '--timeout', '8']); assert.equal(q.code, 124, q.out); assert.equal(task2('pool').terminal, deadTerminal, 'A worker that only just started is given time');
    q = crew2(['wait', 'pool', '--timeout', '7'], 'k1', { CREW_DEAD_SECONDS: '0' }); assert.equal(q.code, 124); assert.equal(task2('pool').terminal, deadTerminal, 'One look is not enough');
    q = crew2(['wait', 'pool', '--timeout', '13', '--no-fallback'], 'k1', { CREW_DEAD_SECONDS: '0' }); assert.equal(task2('pool').terminal, deadTerminal);
    q = crew2(['wait', 'pool', '--timeout', '13'], 'k1', { CREW_DEAD_SECONDS: '0' }); assert.equal(q.code, 124, q.out);
    assert.match(q.out, /== pool: a1 openai-codex\/gpt-x is gone: its agent ended without a report \(A1 stopped after an unexpected error\. Diagnostic: C:\/x\/fatal-1\.json\); claude as one@example\.com continues it in terminal/);
    assert.equal(task2('pool').agent, 'claude'); assert.ok(lastRun().includes('had to stop: its agent ended without a report'), lastRun());
    q = crew2(['wait', 'pool', '--timeout', '8'], 'k1', { CREW_DEAD_SECONDS: '0' }); assert.equal(q.code, 124, q.out); assert.equal(task2('pool').fallbacks.length, 1, 'The worker that took over gets its own time to start');
    setTerminal(task2('pool').terminal, { status: null, screen: '' });
    q = crew2(['wait', 'pool', '--timeout', '13'], 'k1', { CREW_DEAD_SECONDS: '0' }); assert.equal(q.code, 7, q.out);
    assert.match(q.out, /== pool: needs a person - claude as one@example\.com is gone: its agent ended without a report, and there is no other candidate in its chain/);

    // A project with a list of its own: for one where an agent of the general list cannot work.
    fs.writeFileSync(dispatch, JSON.stringify({ shared_quota: true, default: [{ harness: 'a1', model: 'openai-codex/gpt-x' }], roles: { review: [{ harness: 'a1' }] },
      projects: { demo: [{ harness: 'claude', model: 'opus', account: 'two@example.com' }], other: { default: [{ harness: 'pi' }], roles: { ship: [{ harness: 'claude', account: 'one@example.com' }] } } } }));
    assert.equal(JSON.parse(crew2(['agents', '--json']).out).candidates[0].label, 'a1 openai-codex/gpt-x');
    let listed = JSON.parse(crew2(['agents', '--json', '--project', 'demo', '--role', 'review']).out); assert.deepEqual([listed.source, listed.candidates[0].label], ['projects.demo', 'claude opus as two@example.com'], 'A project list comes before the general role list');
    listed = JSON.parse(crew2(['agents', '--json', '--project', 'other', '--role', 'ship']).out); assert.deepEqual([listed.source, listed.candidates[0].label], ['projects.other.roles.ship', 'claude as one@example.com']);
    q = crew2(['spawn', 'proj', '--project', 'demo', 'Count.']); assert.equal(q.code, 0, q.out); assert.deepEqual([task2('proj').launch.account, task2('proj').launch.source], ['two@example.com', 'projects.demo']);
    q = crew2(['spawn', 'proj2', '--project', 'demo', '--agent', 'a1', 'Count.']); assert.equal(q.code, 0, q.out); assert.deepEqual([task2('proj2').agent, task2('proj2').chain.map(c => c.account)], ['a1', ['two@example.com']], 'A named choice goes first and the project list stands behind it');
    fs.writeFileSync(dispatch, JSON.stringify({ projects: { demo: { roles: { build: [{ harness: 'a1' }] } } } }));
    q = crew2(['agents']); assert.equal(q.code, 2); assert.match(q.out, /projects\.demo\.roles\.build is not a role/);
    fs.writeFileSync(dispatch, JSON.stringify({ shared_quota: true, default: [{ harness: 'a1', model: 'openai-codex/gpt-x' }, { harness: 'claude', account: 'one@example.com' }] }));
  }

  console.log('PASS: who does the work (profiles, per-account quota, passing over, hand-over on a limit, relaunch), Firstmate\'s tools (list, backlog, copies from the delivery workflow, no-mistakes delivery, a repository\'s own delivery workflow), follow-ups, review, delivery as a pull request, self-repair (crash record, fix, guarded pull request, update after merge, rollback) and crew helpers, status durations, home and project setup, single ownership, spawn request, worker report, wait outcomes, guarded finish, owner takeover, project removal, the Claude worker command, its folder trust and account choice, and the five reviewed defects');
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
