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
crew project add <name> <git folder>     register a project   (crew project list)
crew project remove <name>               forget a project with no unfinished tasks
crew start | crew end                    take or release the home for this session
crew spawn <id> --project <name> [--kind scout|ship] [--type <type>] [who] "<task>"
    who: [--agent a1|pi|claude] [--model <id>] [--effort <level>] [--account <claude account>] [--rule <n>] [--no-fallback]
crew agents [--role scout|ship|review|fix] [who] [--json]   who would do the work now: profiles, quota, fallback order
crew relaunch <id> [who] ["<why>"]       hand unfinished work to another agent in the same working copy
crew wait <id>... [--timeout seconds] [--no-fallback]   block until each worker reports; one that ran out of quota is replaced
crew status [--all] [--json]             tasks and their terminals
crew stop <id> [--force]                 ask the worker to leave
crew finish <id> [--force]               stop it, remove its terminal, working copy and merged branch
crew done [<id>]                         (worker) my report is written
crew tools [--json]                      Firstmate's tools on this machine and what crew does with each
crew backlog [tasks-axi command...]      the durable list of work in this home (tasks-axi)
crew tell <id> "<message>"               send the worker a follow-up; it reports again
crew review <id> [who]                   start a reviewer on a ship task's branch
crew land <id> [--title "<title>"]       push a ship task's branch and open a pull request
crew fix [who] "<problem>"               start a worker that repairs crew itself
crew selfmerge <id>                      publish that repair if it stays in crew/ and the tests pass
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
  terminal. `crew wait` reads the task file once a second; it asks Core only to notice a
  terminal that ended without a report.
- **Finish.** A worker still working is never closed without `--force`. A1 leaves through
  its integration API (`session.exit`, proven by `session-unavailable`); other agents are
  closed once idle. Then the terminal and the working copy are removed; the report and, for
  `ship`, the branch stay.

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
  tightest of the account's windows (for Claude: the session window or the week, whichever has less left).
- **A project's own list.** `"projects": { "<name>": [ ...profiles ] }` (or `{ "default": [...], "roles": {...} }`) is used
  for that project instead of the general lists: for a project where an agent of the general list cannot work.
  `"crew:self"` names crew's own source, which `crew fix` works on. Order of precedence: the project's role list,
  the project's list, the general role list, `default`.
- **The list is a fallback chain, in the person's order.** The order is never rearranged; a
  candidate is only passed over for a known reason: its quota is used up, its login is no
  longer accepted, or its program is not installed. A quota that could not be read is
  uncertainty, not an empty account, and the candidate stays. What the command line names
  (`--agent`, `--model`, `--effort`, `--account`, or `--rule <n>`) goes first and the
  configured list stands behind it; `--no-fallback` keeps only that. Without the file, crew
  starts `a1` as it always did.
- **Quota** comes from quota-axi as it is. One ordinary reading covers the candidates that
  spend from the machine's own logins (A1's are found through `PI_CODING_AGENT_DIR`). For each
  saved Claude account the plugin's helper writes that account's current login into an empty
  temporary folder (`session-dir.js refresh <account> --into <folder>`, which also rotates
  tokens that are about to expire, under the plugin's lock), quota-axi reads exactly that
  folder (`CLAUDE_CONFIG_DIR=<folder> quota-axi --provider claude --profile-only --json`), and
  the folder is removed. With a single candidate nothing is read.
- **While work is under way.** `crew wait` looks at a worker that is no longer working: when
  the last lines of its screen say it stopped on a limit or a lost login, the next candidate
  of the task's chain is started in the same working copy and told to go on from what is
  there (`git status`, `git log`, the report). The task keeps its id; its record holds
  `launch` (who works now), `chain` (who is left) and `fallbacks` (who stopped, and why).
  The same happens when the agent is gone: the terminal is still there but Core sees no agent in it and no
  report was written (a crash at start, an agent that left). That counts only 45 seconds after the worker
  was started (`CREW_DEAD_SECONDS`) and when two checks in a row see it, since a starting agent looks the same,
  and only for agents Core recognises in a terminal (`a1`, `claude`).
  `crew relaunch <id>` does the same by hand. Only when nobody is left does the wait end with
  "needs a person", and a spawn with "Nobody can take this work now", each with the reason
  per candidate.
- `crew agents` shows the list as it stands, with every candidate's quota; `crew status`
  shows who works on each task.

## Delivering a code change

A ship task ends with commits on branch `<type>/<id>`. From there:

- `crew review <id>` starts a read-only task `<id>-review` whose brief points at that branch.
  Its report starts with `APPROVE` or `CHANGES NEEDED`. `--agent` (or `CREW_REVIEW_AGENT`)
  picks a different agent for it.
- `crew tell <id> "<message>"` pastes a follow-up into the worker's terminal and reopens the
  task; the worker rewrites its report and runs `crew done` again. Refused when the worker is
  gone or is waiting for a person.
- `crew land <id>` pushes the branch to the project's `origin` and opens a pull request with
  `gh`, against the branch the project folder is on (or the default branch), with the report
  as its text. If the machine is signed in to GitHub as the repository's owner among several
  accounts, that account is used. crew never merges a project's pull request.

## The tools Firstmate works with

crew runs without any of them and uses each one that is installed. `crew tools` lists them
with their versions; the Herdr plugin installs them (Settings > Plugins > Crew).

| Tool | What crew does with it |
| --- | --- |
| `gh` | `crew land` opens the pull request with it. |
| `gh-axi`, `chrome-devtools-axi`, `jq` | A worker's brief names the ones on the machine (GitHub, browser, JSON). |
| `lavish-axi` | The coordinator's rules say when to use it: showing a decision or long report as a page. |
| `quota-axi` | Crew reads it, unchanged, when it chooses who works (see "Who does the work"): one ordinary reading for the machine's own logins, and one `--profile-only` reading per saved Claude account. |
| `tasks-axi` | `crew backlog <tasks-axi command…>` keeps the durable list of work in `<home>/backlog.md`. A task with the same id as a backlog item moves it: In flight at spawn, Done at `land` (ship, with the pull request) or `finish` (scout). Reading is open to any session; changes are the owner's. |
| `delivery` | The shared delivery workflow's command. `crew spawn` asks it for the task's copy (`delivery start <type>/<id> --json`, or `--detach <id>` for a scout) and `crew finish` hands the copy back (`delivery finish <copy> --force`, after crew's own refusal of unsaved ship work and of a keep marker). The copy is cut from the project's published default branch. Whether copies are pooled is one setting of the machine, `delivery pool`. |
| `treehouse` | The pool `delivery` takes reused copies from. Crew does not call it for new tasks; the `--treehouse` option of `crew project add` is accepted and ignored. |
| `no-mistakes` | A project that has the gate (a `no-mistakes` remote) is delivered through it: the ship worker's brief tells it to run `no-mistakes axi run --yes --intent-file <task>` and follow it to a pull request. `crew land` then pushes nothing and only records that pull request (from the report, or from `gh pr view`). The gate's CI watch is left out by default (`--skip ci`): delivery ends at the open pull request. `crew project add <name> <folder> --gate-skip ci,lint` leaves out more steps (rebase, review, test, document, lint, ci) where they cannot run on the machine; `--gate-skip none` keeps the watch. |

`CREW_TOOL_<NAME>` (for example `CREW_TOOL_TASKS_AXI`) names a tool's program explicitly;
otherwise it is looked up on `PATH`.

`crew status` shows the pull request link of a delivered task.

## Crew repairs itself

A defect in crew is handled like any other work: a worker fixes it on a branch, in a copy
of crew's own source. The coordinator's rules tell it to do this instead of working around
the defect, and without asking the person.

| Command | What it does |
| --- | --- |
| `crew fix "<problem>"` | Starts a fixer (`fix-1`, `fix-2`, …) on crew's source. One at a time. Recent crash records are attached. |
| `crew selfmerge <id>` | Publishes the repair to `main` of the source and updates this machine. |
| `crew update` | Fast-forwards this machine's crew to the published `main`. |
| `crew rollback` | Puts this machine back on the revision before its last update. |

`crew selfmerge` is the only gate, so it refuses unless all of this holds: the fixer
reported; nothing is uncommitted; the branch rebases cleanly onto the published `main`; every
changed file is under `crew/`; and `node crew/crew.test.mjs` exits 0 in the fixer's copy. The
push is an ordinary one (never forced), with the machine's own git credentials.

The copy Herdr installed (`~/.crew/core`, or `~/.crew/tool` from before 0.7) fast-forwards itself at each `crew start`, so a
repair published from one machine reaches the others at their next session. A developer's
checkout never updates itself. After `crew rollback` the machine stays on the older revision
until something newer than the one it left is published. `crew start` also rewrites the
home's `AGENTS.md` when the rules of the running version differ, so do not keep notes there.

A command that fails with an unexpected error exits 70 and writes a record to
`~/.crew/state/crashes/`.

What this does not protect against: a repair that passes the suite and is still wrong. It
reaches every machine at its next session; `crew rollback` is per machine.

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

`crew finish` removes a working copy only when the task's own terminal is the only one in it. Handing a pool slot
back ends every process whose working folder is in the slot (treehouse does that so the next task gets a quiet
folder), and on Windows a shell keeps the folder it was opened in even after `cd`. A terminal a person opened
from a worker's tab, with their own agent in it, would be ended with the worker. So finish asks Core for the
live terminals of this machine, and when another one sits in the copy it stops, names it and removes nothing,
with or without `--force`. A Core that does not answer is treated the same way.

## Tests

`node crew/crew.test.mjs` runs everything against a fake Core.
The suite needs only Node.js and git.
