# crew

A small, agent-agnostic crew tool on Herdr Core. One coordinator agent hands work to worker
agents, each in its own Core terminal and its own git worktree. It lives in this fork next
to Firstmate, borrows Firstmate's ideas (briefs, scout and ship tasks, written reports,
isolated copies, one owner per home) and none of its runtime: no watcher, no hooks, no
background service. Every command is one short Node process that talks to Core through `hc`.

It exists because Firstmate's shell runtime starts thousands of small processes per task,
which is slow on Windows (Git Bash). Measured on the same machine and task (three read-only
scouts requested at once): about 1 minute with crew against about 31 minutes with Firstmate.

Where the work stands, why it went this way and what is left: [`docs/plan.md`](docs/plan.md).

## Layout on a machine

```
~/.crew/                the default crew home: crew.json, owner.json, backlog.md
~/.crew/core/           this repository, when installed from the Herdr plugin
~/.crew/coordinator/    the coordinator's rules (AGENTS.md, CLAUDE.md); the folder it starts in
~/.crew/tasks/<id>/     task record, brief and report
~/.crew/.worktrees/<id> workers' copies, on a machine without the shared delivery workflow
~/.crew/state/          update and crash records
```

A worker's copy is never inside the home: agents read instruction files from their folder
upwards, so a worker placed there loads the coordinator's rules and acts as a second
coordinator.

## Commands

```
crew init [folder]                       create a crew home (default ~/.crew)
crew project add <name> <git folder> [--gate-skip <steps>|none] [--workflow delivery|plain]   register a project   (crew project list)
crew project remove <name>               forget a project with no unfinished tasks
crew start | crew end                    take or release the home for this session
crew spawn <id> --project <name> [--kind scout|ship] [--type <type>] [who] "<task>"
    who: [--agent a1|pi|claude] [--model <id>] [--effort <level>] [--account <claude account>] [--rule <n>] [--no-fallback]
crew agents [--role scout|ship|review|fix] [--project <name>] [who] [--json]   candidates and quota now, next choice marked
crew relaunch <id> [who] ["<why>"]       end the current session and hand over working, stopped or failed work; copy stays
crew wait <id>... [--timeout seconds] [--no-fallback]   wait for reports; recover stopped or idle workers
crew status [--all] [--json]             tasks, terminals and elapsed time; JSON also shows delivery kind, standby eligibility and recovery
crew stop <id> [--force]                 ask the worker to leave
crew finish <id> [--force]               close the task; return its copy and proved-merged branch now or later
crew done [<id>]                         (worker) my report is written
crew tools [--json]                      Firstmate's tools on this machine and what crew does with each
crew backlog [tasks-axi command...]      the durable list of work in this home (tasks-axi)
crew tell <id> "<message>"               send the worker a follow-up; it reports again
crew review <id> [who]                   start a reviewer on a ship task's branch
crew land <id> [--title "<title>"]       push a ship task's branch and open a pull request, or record the one its workflow or gate opened
crew fix [who] "<problem>"               start a worker that repairs crew itself
crew selfrepair <id>                     check that repair and open its pull request
crew update | crew rollback              bring this machine's crew up to date, or back one step
```

The coordinator's rules are the home's `AGENTS.md` (`CLAUDE.md` points at it), written by
`crew init`. Any agent that can run shell commands can coordinate.

## How it works

- **Owner.** `crew start` records the calling Core terminal as the home's owner. Another
  session is refused and may only read while Core says that terminal is live; when it is
  gone, the next `start` takes over and is told which tasks were left unfinished.
- **Spawn.** Where the shared delivery workflow is installed, `delivery start` makes the copy and decides between a reused pool slot and a new folder (`<project>/.worktrees/<id>`); crew does not know which. Otherwise `git worktree add` (detached for `scout`, a new branch `<type>/<id>` for `ship`, where `--type` is `feature` (default), `fix`, `refactor`, `docs`, `test`, `chore` or `style`, as the shared delivery workflow names branches),
  a brief file, then one `hc run` with labels `crew.task`, `crew.home` and the Herdr
  space/tab labels. The agent starts with one instruction as its command-line argument
  ("read the brief…"), so nothing is typed into it.
- **Report.** The worker writes `tasks/<id>/report.md` and runs `crew done` from its own
  terminal.
  `crew wait` reads the task file once a second.
  Every few seconds it asks Core about ended terminals, missing agents, quota/login stops on non-working screens, provider errors, idle workers, and questions or permissions that need a person, as described under work under way below.
- **Finish.** A worker still working is never closed without `--force`. A1 leaves through
  its integration API (`session.exit`, proven by `session-unavailable`); other agents are
  closed once idle. The terminal is removed; the copy's return can be postponed. The report
  stays, as do ship branches not proved merged.

## Agents

| Agent | Start | Leave |
|---|---|---|
| `a1` | `a1 "<instruction>"` | A1 API, graceful |
| `pi` | `pi "<instruction>"` | terminal closed when idle |
| `claude` | `claude "<instruction>"` | terminal closed when idle |

Adding one is a line in `AGENTS` in `crew.mjs`.

## Who does the work

Firstmate's model is kept, in its own file and format: `<home>/config/crew-dispatch.json`.
A *profile* names the agent program and optionally its model and effort; `default` is an
ordered list of them, `rules` pair a description of a kind of work with the profiles to use
for it, `shared_quota: true` turns quota reading off. Crew adds two things for a machine with
several logins: `roles` (a list per `scout`, `ship`, `review`, `fix`), and `account` on a
Claude profile.

```json
{
  "default": [
    { "harness": "a1", "model": "openai-codex/gpt-x", "effort": "high" },
    { "harness": "a1", "model": "github-copilot/gpt-x" },
    { "harness": "claude", "model": "opus" }
  ],
  "roles": { "review": [{ "harness": "claude", "model": "sonnet", "account": "me@example.com" }] },
  "rules": [{ "when": "A small mechanical edit", "use": { "harness": "claude", "model": "haiku", "effort": "low" } }]
}
```

- **A1 and Pi** choose their login with the model: `<provider>/<id>` is started as
  `--provider <provider> --model <id>`, so Codex and Copilot are two profiles of the same agent.
- **Claude accounts** are the logins saved by the account-switcher plugin (asked from its
  `session-dir.js list`; `CREW_CLAUDE_ACCOUNTS` names them on a machine without it). A profile
  with `account` is started through the plugin's launcher as that account. A Claude profile
  without one stands for every saved account, each a candidate of its own, with
  `CREW_CLAUDE_ACCOUNT` (what Herdr's account choice sets) first.
- **A floor** (`"floor": 50` on a profile, Firstmate's field) is the share of its quota, in percent, a profile
  keeps in reserve: once it is known to have less left, it yields to the next. It is not dropped but moved
  behind the others, so when everybody else is out it is still used and work goes on. The figure is the
  minimum remaining percentage of applicable effective availability from quota-axi: account-wide
  scopes and the model's or product's own bounds, not raw window percentages.
- **A project's own list.** `"projects": { "<name>": [ ...profiles ] }` (or `{ "default": [...], "roles": {...} }`) is used
  for that project instead of the general lists: for a project where an agent of the general list cannot work.
  `"crew:self"` names crew's own source, which `crew fix` works on. Order of precedence: the project's role list,
  the project's list, the general role list, `default`. `crew agents --project <name>` inspects it.
- **The list is a fallback chain, in the person's order.** Only a floor changes that order:
  normal and unknown quota come before below-floor candidates, preserving order within each
  group. Exhausted quota, rejected logins and missing programs are passed over, not forgotten.
  Unreadable quota is uncertainty, not an empty account. Candidates are deduplicated by agent,
  model and account; profiles differing only in effort or floor are one attempt, first wins.
- **Command-line choices.** `--agent` starts a clean profile. `--model`, `--effort` or
  `--account` alone adjusts the first selected profile, keeping its other fields. That choice
  goes first, with the selected list behind it. `--rule <n>` replaces the ordinary list with
  that rule's `use`; numbers start at one, and crew does not match `when` text to tasks.
  `--no-fallback` keeps one profile before Claude account expansion, so also name `--account`
  for exactly one Claude account. Without a configured list, spawn defaults to `a1`, review to
  `CREW_REVIEW_AGENT` or the author's agent, and fix to `CREW_FIX_AGENT` or `a1`. Configured
  project, role and default lists take precedence over these legacy defaults.
- **Quota** comes from quota-axi as it is. A profile's optional `provider` overrides the
  quota-axi family, not the launch program's `--provider` (that comes from the model prefix).
  One ordinary reading covers the candidates that
  spend from the machine's own logins (A1's are found through `PI_CODING_AGENT_DIR`). For each
  saved Claude account the plugin's helper writes that account's current login into an empty
  temporary folder (`session-dir.js refresh <account> --into <folder>`, which also rotates
  tokens that are about to expire, under the plugin's lock), quota-axi reads exactly that
  folder (`CLAUDE_CONFIG_DIR=<folder> quota-axi --provider claude --profile-only --json`), and
  the folder is removed. Ordinary initial selection skips quota and installation checks for
  one candidate; `crew agents` and hand-over check even one. `shared_quota: true` disables
  quota reads; so do `CREW_NO_QUOTA=1` and a missing quota-axi. Installation checks still apply
  when choosing among candidates or inspecting them.
- **While work is under way.** `crew wait` looks at a worker that is no longer working: when
  the last lines of its screen say it stopped on a limit or a lost login, the next candidate
  of the task's chain is started in the same working copy and told to go on from what is
  there (`git status`, `git log`, the report). The task keeps its id; its record holds
  `launch` (who works now), the complete original `candidates`, `chain` (untried choices in
  original order), and `fallbacks` (who stopped, and why). At hand-over, all untried choices
  are checked again, including those passed over earlier. Only the owning coordinator hands
  over automatically, unless wait has `--no-fallback` or `CREW_NO_FALLBACK=1`.
  The same happens when the agent is gone: the terminal is still there but Core sees no agent in it and no
  report was written (a crash at start, an agent that left). That counts only 45 seconds after the worker
  was started (`CREW_DEAD_SECONDS`) and when two checks in a row see it, since a starting agent looks the same,
  and only for agents Core recognises in a terminal (`a1`, `claude`).
  A terminal that actually ended without a report instead fails the task, without hand-over.
  Wait says "needs a person" when nobody else can work, or when the worker asks a question
  or permission, even with candidates left. A spawn with nobody usable gives the reason per candidate.
  `crew relaunch <id>` accepts working, stopped and failed tasks, not a reported task. It ends
  the current session even if busy, without an idle test or `--force`; the copy stays. Without
  selection flags it uses the saved list and excludes every tried candidate. A selection flag
  rebuilds the list from current configuration and excludes only the current candidate.
  A provider or network error is different: after two consecutive Core `error` observations, crew sends a short message to continue from where the worker stopped.
  The first message waits 30 seconds from the first error observation; the second waits two minutes after the first message, and the third waits five minutes after the second.
  After three messages and two further error observations without recovery, the existing hand-over starts the next candidate with the last screen error as its reason.
  With nobody left, the wait ends with "needs a person" and says what was tried.
  Thirty seconds of observed working ends a stop and resets its retry allowance; a brief working flicker does not.
  Attempts and retry timing survive another `crew wait`, and a replacement worker gets its own allowance.
  Quota or login stops are still checked first and handed over immediately, without continuation messages.
  A worker that stays `idle` or `done` for two minutes while its task is still working and has no report gets one reminder to continue, or write the report and run `crew done` if finished.
  If it stays idle for another two minutes after the reminder, the wait ends with "needs a person" instead of sending repeated reminders.
  Reported tasks and idle workers with an existing report are never nudged; a `blocked` permission or question still needs a person immediately.
  Only the session owning the home sends recovery messages or hands tasks over, and `--no-fallback` or `CREW_NO_FALLBACK=1` disables both.
  Automatic messages are recorded as `nudges`, not coordinator follow-ups: they do not change task state, report stage, or `tells`.
  Each action prints one line for the coordinator to pass on to the person afterwards, rather than asking them to resume the worker.
  `CREW_RECOVERY_SECONDS` overrides the common delay unit (a non-negative number, default `30`): error delays are 1, 4, and 10 units, idle intervals are 4 units, and sustained-working recovery is 1 unit.
  Core checks normally remain five seconds apart; units below five seconds shorten checks too, down to 10 milliseconds, so tests can use `CREW_RECOVERY_SECONDS=0` while retaining the consecutive-observation checks.
- `crew agents` shows rows in original order and marks the next choice, not a sorted fallback list.
  Status JSON retains `standby` labels and `standbyStatus`: each remaining candidate's recorded status, note, `passedOver` and `checkedAt`.
  Status does not reread quota; an old task can only reconsider the chain it saved.
  `crew status` shows who works on each task, its current Core error state, and how many continuation messages that worker received.
  `crew status --json` also includes `nudges` history, the worker's `continuations` count, and its active `recovery` record.
  Both status forms only read; they never send recovery messages.

## Delivering a code change

How a ship task is delivered depends on the project. There are three kinds, and the kind is
decided once, at spawn, and recorded on the task so the worker's brief, `crew land` and
`crew status --json` agree (`deliveryKind`: `gate`, `workflow` or `plain`; `null` for non-ships):

- **Shared delivery workflow.** The repository follows the `change-delivery` skill. A project
  counts as one when it was added with `--workflow delivery`, or, without that choice, when
  `delivery` is installed and the worker's copy carries the shared instructions (`delivery
  instructions` reports a match, or `AGENTS.md` has the template's header line, which also
  covers a repository on an older template). `--workflow plain` turns that off, not a selected
  gate. Re-adding a project replaces its registration: omitted `--workflow` and `--gate-skip`
  choices are dropped, so repeat options you want to keep. The worker is
  told to follow the skill. A change that needs a plan is planned first as a draft pull request,
  then the worker stops and reports. Every report starts with `Plan: <link>` or
  `Implementation: <link>`, and `crew done` records that stage and link. The coordinator approves
  the plan itself (`crew tell <id> "approved, implement"`) and asks the person only about a
  decision that is theirs. `crew status` shows `plan awaiting approval`, `plan` or
  `implementation` without asking GitHub. `crew land` refuses a plan, and refuses while the copy
  has commits its pushed branch lacks (the worker pushes them). For an implementation it pushes
  nothing and opens nothing: it records the pull request (from the report's first line, else
  `gh pr view <branch>`) and moves the backlog item. When GitHub answers, it also prints draft
  or ready, plus ticked outcomes if `## Implementation` has checkboxes. No summary does not
  mean land failed. The repository's bot marks it ready; the person merges.
- **no-mistakes gate.** A project with the gate's remote and the `no-mistakes` tool installed
  is delivered by the gate; `crew land` only records its pull request. The gate wins over
  the workflow. Without the tool, crew uses workflow detection or plain delivery instead.
- **Plain project.** The task ends with commits on branch `<type>/<id>`. From there:

- `crew review <id>` starts a read-only task on that branch, usually `<id>-review` (truncated
  at the ID limit, numbered if taken). Use the printed ID. Its report starts with `APPROVE`
  or `CHANGES NEEDED`. An explicit `--agent` overrides a configured review list; the legacy
  defaults above need not choose a different agent from the author.
- `crew tell <id> "<message>"` pastes a follow-up into the worker's terminal and reopens the
  task; the worker rewrites its report and runs `crew done` again. Refused when the worker is
  gone or is waiting for a person.
- `crew land <id>` pushes the branch to the project's `origin` and opens a pull request with
  `gh`, against the branch the project folder is on (or the default branch), with the first
  200 report lines followed by task, agent and commit-count attribution. If the machine is
  signed in to GitHub as the repository's owner among several
  accounts, that account is used. crew never merges a project's pull request.
- `crew review` and `crew tell` work the same way for a workflow project's implementation.

For every kind, first land requires a reported worker, an existing copy, and clean tracked
and untracked files, even when it only records a link. An already-landed PR can return early.

## The tools Firstmate works with

crew runs without any of them and uses each one that is installed. `crew tools` lists them
with their versions; the Herdr plugin installs them (Settings > Plugins > Crew).

| Tool | What crew does with it |
| --- | --- |
| `gh` | `crew land` opens the pull request with it. |
| `gh-axi`, `chrome-devtools-axi`, `jq` | A worker's brief names the ones on the machine (GitHub, browser, JSON). |
| `lavish-axi` | The coordinator's rules say when to use it: showing a decision or long report as a page. |
| `quota-axi` | Crew reads it, unchanged, when it chooses who works (see "Who does the work"): one ordinary reading for the machine's own logins, and one `--profile-only` reading per saved Claude account. |
| `tasks-axi` | `crew backlog <tasks-axi command…>` keeps the durable list of work in `<home>/backlog.md`. A task with the same id as a backlog item moves it: In flight at spawn, Done at `land` (ship, with the pull request) or `finish` (reported scout, excluding reviewers except legacy treehouse tasks). Reading is open to any session; changes are the owner's. |
| `delivery` | The shared delivery workflow's command. `crew spawn` asks it for the task's copy (`delivery start <type>/<id> --json`, or `--detach <id>` for a scout) and `crew finish` hands the copy back (`delivery finish <copy> --force`, after crew's own refusal of unsaved ship work and of a keep marker). The copy is cut from the project's published default branch. Whether copies are pooled is one setting of the machine, `delivery pool`. |
| `treehouse` | The pool `delivery` takes reused copies from. Crew does not call it for new tasks; the `--treehouse` option of `crew project add` is accepted and ignored. |
| `no-mistakes` | A project with a `no-mistakes` remote uses the installed tool for ship delivery; without the tool it falls back to workflow detection or plain delivery: the ship worker's brief tells it to run `no-mistakes axi run --yes --intent-file <task>` and follow it to a pull request. `crew land` then pushes nothing and only records that pull request (from the report, or from `gh pr view`). The gate's CI watch is left out by default (`--skip ci`): delivery ends at the open pull request. `crew project add <name> <folder> --gate-skip ci,lint` leaves out more steps (rebase, review, test, document, lint, ci) where they cannot run on the machine; `--gate-skip none` keeps the watch. |

`CREW_TOOL_<NAME>` (for example `CREW_TOOL_TASKS_AXI`) names a tool's program explicitly;
otherwise it is looked up on `PATH`.

`crew status` shows pull request links and elapsed time (`elapsedSeconds` in JSON), from the
original spawn or creation to report, stop, failure, closure, or now. Relaunch does not reset it.

## Crew repairs itself

A defect in crew is handled like any other work: a worker fixes it on a branch, in a copy
of crew's own source. The coordinator's rules tell it to do this instead of working around
the defect. The person reviews and merges the repair's pull request.

| Command | What it does |
| --- | --- |
| `crew fix "<problem>"` | Starts a fixer (`fix-1`, `fix-2`, …) on crew's source. One at a time. Recent crash records are attached. |
| `crew selfrepair <id>` | Checks the repair, pushes its branch, and opens and records its pull request against `main`. No merge or local update. |
| `crew update` | Fast-forwards this machine's crew to the published `main`. |
| `crew rollback` | Puts this machine back on the revision before its last update. |

`crew selfmerge` remains an alias for `crew selfrepair`. The fixer commits and stops;
it does not push or open the pull request itself. Crew refuses delivery unless the fixer
reported, nothing is uncommitted, the branch can incorporate the published `main`,
and the whole suite passes in the fixer's copy (`node crew/crew.test.mjs`).

Only the tool's own `crew.mjs`, `crew.test.mjs`, `README.md`, and files inside its `bin/`
and `docs/` may change, with the allowlist written relative to the tool's own folder. Repository
infrastructure such as `.github/`, root agent instructions, package metadata, scripts,
licence, ignore and attribute files is excluded. The repository root README
is also excluded; the tool's README is `crew/README.md`.

Crew checks the shared-delivery pull request body with `delivery check-body --final` when
installed. The body has Proposal, ticked repair Implementation, and Acceptance sections,
without Automation. It pushes only the repair branch (never forcibly or directly to main)
and opens a draft pull request with `gh`, using the repository owner's signed-in account
when available, as `crew land` does. Repeating delivery prints the recorded link instead
of opening another pull request. New repairs use `fix/<home tag>-<id>` so different homes'
first repairs do not compete for `fix/fix-1`; existing tasks keep their recorded branch.
`crew finish` keeps an unmerged repair's branch because it holds the commits; after merge
the branch can go as for any other ship.

If the branch push succeeds but opening the pull request fails, repeat `crew selfrepair`.
Before publication, crew rebases private commits onto main. Once the branch is published,
it brings newer main commits in with a merge instead, preserving the published repair's
history for an ordinary push. If the published branch has history missing from this copy,
crew asks the worker to reconcile it rather than rewriting it or recommending a blind retry.

The copy Herdr installed (`~/.crew/core`, or `~/.crew/tool` from before 0.7) fast-forwards itself at each `crew start`, so a
repair reaches other machines only after the person merges its pull request, at their next
session or an explicit `crew update`. Opening the pull request does not update any machine.
After the merge and update, retry the command that failed. A developer's
checkout never updates itself. After `crew rollback` the machine stays on the older revision
until something newer than the one it left is published. `crew start` also rewrites the
home's `AGENTS.md` when the rules of the running version differ, so do not keep notes there.

A command that fails with an unexpected error exits 70 and writes a record to
`~/.crew/state/crashes/`.

What this does not protect against: a repair that passes the suite, is merged, and is still
wrong. It reaches installed machines at update or their next session; `crew rollback` is
per machine.

## Limits

- Nothing is enforced by agent hooks; the coordinator follows its rules file, and the tool
  refuses unsafe operations (second owner, reporting for another terminal, closing a busy
  worker).
- Closing a non-A1 agent's terminal can leave helper processes of that agent behind.
- No merge, queue or hold handling yet; `crew land` ends with an open pull request.
- Delivery through the no-mistakes gate ends at the open pull request; its CI watch is left
  out unless the project asks for it.
- One machine per home. Tested live on Windows with A1 and Pi workers and an A1 coordinator.

## Finish and other terminals

`crew finish` hands a working copy back only when the task's own terminal was the only one in it. Handing a pool
slot back ends every process whose working folder is in the slot (treehouse does that so the next task gets a
quiet folder), and on Windows a shell keeps the folder it was opened in even after `cd`. A terminal a person
opened from a worker's tab, with their own agent in it, would be ended with the worker. So finish asks Core for
the live terminals of this machine. When another one sits in the copy, with or without `--force`, finish still
does everything else (stops the worker, removes its terminal, forgets the Claude folder trust, closes the task,
moves a reported scout's backlog item, excluding reviewers except legacy treehouse tasks) and
only postpones handing the copy back. Ship backlog items move at land, not finish. The task record keeps `copyToReturn`, and the
output names the terminal that holds the copy. Herdr's shell integration reports where a shell is now in the
label `custom.cwd`; when that is elsewhere, the message says "opened in the copy, now in <folder>", so a tab
that looks unrelated is recognised. Holding is still decided by Core's `cwd`, because that is what treehouse
acts on.

Crew has no background process. `crew start` and successful `crew finish` handling, including
an already-closed task, sweep waiting copies; an earlier refusal skips the sweep. A free,
unprotected copy goes back through delivery, legacy treehouse or git, and its proved-merged
branch is dropped. A copy deleted by hand is pruned from git. A failed automatic return is
reported but does not fail the triggering command. An explicit `crew finish <closed-id> --force`
does refuse if Core is silent, a terminal holds the copy, or the return fails.

Finish records changed and untracked file times and the keep marker before stopping. The
non-forced ship refusal uses that same inspection, not an earlier clean result. Ignored
entries get a stat-only walk, without following symlinks or reading contents. Each ignored
root stores file count, newest modification time, total size and a metadata digest, so edits,
additions and removals inside a large folder are visible without storing every file. There
is no file-count limit; a 30-second budget or unreadable entry records an incomplete snapshot
and keeps the copy waiting with the reason. Older snapshots without this protection also wait.
The later return keeps the copy waiting, with a reason, when work changed since the snapshot,
a `.artifacts/KEEP` marker appeared, a
rebase, merge, cherry-pick, revert, bisect or `git worktree lock` began there, or the copy's HEAD reached a
commit that no branch or tag holds (its own reflog is read, so moving back does not hide it), for any kind of
task. Stashes and branches made in the copy live in the repository and outlive it. A `--force` given at finish covers only what was there then. `crew finish <id>` on such a
closed task tries its copy again and says how it stands. `crew finish <id> --force` accepts what
is there now and can cancel a still-busy worker whose stop was pending, but never another
terminal. It compares again after any retried stop/removal; known newer writes keep waiting.
If inspection cannot be completed, the current `--force` authorizes discarding the contents
unseen instead. Stop/removal confirmation and the other-terminal check still apply; output
explicitly says when work was discarded unseen. Automatic retries never inherit earlier force. A Core that does not answer keeps every waiting copy and
says which. A project keeps its registration while a finished task waits for its copy.
`crew status --all` shows holders, new work, keep/history protections, a free copy, or an
unanswered Core query. Unconfirmed worker stops and terminal removals are shown as pending,
never free; reading status never returns a copy. JSON's `copyToReturn` has `why`, `kept`,
`pending` and `free`. Plain status ends with a count of waiting copies.

Protective refusals come before stopping: uncommitted ship work, a failed work inspection,
`.artifacts/KEEP`, a busy worker without `--force`, or an unanswered initial Core query leave
the worker and copy intact. Before immediate return, the whole snapshot is compared after
stopping and terminal removal, including ignored files and scout scratch, even with `--force`.
Work written while leaving postpones return rather than refusing with the worker gone. A silent
second terminal listing, unconfirmed stop or terminal removal, or failed return also leaves a closed
task with its copy waiting. The next finish or start retries safely, as the output says.

## Tests

`node crew/crew.test.mjs` runs everything against a fake Core. Self-repair delivery,
updates, and rollback use isolated repositories, fake GitHub responses, and local remotes;
no real terminals or GitHub are touched.
The suite needs only Node.js and git.
