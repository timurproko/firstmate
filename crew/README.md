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
~/.crew/tool/        this repository, when installed from the Herdr plugin
~/.crew/crew/        the default crew home: crew.json, AGENTS.md, CLAUDE.md, owner.json, tasks/<id>/
~/.crew/worktrees/   workers' copies: <home tag>/<task id>
```

A worker's copy is never inside the home: agents read instruction files from their folder
upwards, so a worker placed there loads the coordinator's rules and acts as a second
coordinator.

## Commands

```
crew init [folder]                       create a crew home (default ~/.crew/crew)
crew project add <name> <git folder>     register a project   (crew project list)
crew project remove <name>               forget a project with no unfinished tasks
crew start | crew end                    take or release the home for this session
crew spawn <id> --project <name> [--kind scout|ship] [--agent a1|pi|claude] "<task>"
crew wait <id>... [--timeout seconds]    block until each worker reports
crew status [--all] [--json]             tasks and their terminals
crew stop <id> [--force]                 ask the worker to leave
crew finish <id> [--force]               stop it, remove its terminal, working copy and merged branch
crew done [<id>]                         (worker) my report is written
crew tools [--json]                      Firstmate's tools on this machine and what crew does with each
crew backlog [tasks-axi command...]      the durable list of work in this home (tasks-axi)
crew tell <id> "<message>"               send the worker a follow-up; it reports again
crew review <id> [--agent <agent>]       start a reviewer on a ship task's branch
crew land <id> [--title "<title>"]       push a ship task's branch and open a pull request
crew fix [--agent <agent>] "<problem>"   start a worker that repairs crew itself
crew selfmerge <id>                      publish that repair if it stays in crew/ and the tests pass
crew update | crew rollback              bring this machine's crew up to date, or back one step
```

The coordinator's rules are the home's `AGENTS.md` (`CLAUDE.md` points at it), written by
`crew init`. Any agent that can run shell commands can coordinate.

## How it works

- **Owner.** `crew start` records the calling Core terminal as the home's owner. Another
  session is refused and may only read while Core says that terminal is live; when it is
  gone, the next `start` takes over and is told which tasks were left unfinished.
- **Spawn.** `git worktree add` (detached for `scout`, a new branch `crew/<id>` for `ship`),
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

## Delivering a code change

A ship task ends with commits on branch `crew/<id>`. From there:

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
| `lavish-axi`, `quota-axi` | The coordinator's rules say when to use them: showing a decision or long report as a page; checking which agent has room before a batch. |
| `tasks-axi` | `crew backlog <tasks-axi command…>` keeps the durable list of work in `<home>/backlog.md`. A task with the same id as a backlog item moves it: In flight at spawn, Done at `land` (ship, with the pull request) or `finish` (scout). Reading is open to any session; changes are the owner's. |
| `treehouse` | `crew project add <name> <folder> --treehouse`: that project's workers get a leased copy from the treehouse pool (`treehouse get --lease`), and `crew finish` gives it back (`treehouse return`). The copy is cut from the branch treehouse infers, not from the folder's current commit. |
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

The copy Herdr installed (`~/.crew/tool`) fast-forwards itself at each `crew start`, so a
repair published from one machine reaches the others at their next session. A developer's
checkout never updates itself. After `crew rollback` the machine stays on the older revision
until something newer than the one it left is published. `crew start` also rewrites the
home's `AGENTS.md` when the rules of the running version differ, so do not keep notes there.

A command that fails with an unexpected error exits 70 and writes a record to
`~/.crew/crashes/`.

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

## Tests

`node crew/crew.test.mjs` runs everything against a fake Core.
The suite needs only Node.js and git.
