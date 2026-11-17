# crew

A small, agent-agnostic crew tool on Herdr Core. One coordinator agent hands work to worker
agents, each in its own Core terminal and its own git worktree. It lives in this fork next
to Firstmate, borrows Firstmate's ideas (briefs, scout and ship tasks, written reports,
isolated copies, one owner per home) and none of its runtime: no watcher, no hooks, no
background service. Every command is one short Node process that talks to Core through `hc`.

It exists because Firstmate's shell runtime starts thousands of small processes per task,
which is slow on Windows (Git Bash). Measured on the same machine and task (three read-only
scouts requested at once): about 1 minute with crew against about 31 minutes with Firstmate.

## Layout on a machine

```
~/.crew/tool/        this repository, when installed from the Herdr plugin
~/.crew/home/        the default crew home: crew.json, AGENTS.md, CLAUDE.md, owner.json, tasks/<id>/
~/.crew/worktrees/   workers' copies: <home tag>/<task id>
```

A worker's copy is never inside the home: agents read instruction files from their folder
upwards, so a worker placed there loads the coordinator's rules and acts as a second
coordinator.

## Commands

```
crew init [folder]                       create a crew home (default ~/.crew/home)
crew project add <name> <git folder>     register a project   (crew project list)
crew project remove <name>               forget a project with no unfinished tasks
crew start | crew end                    take or release the home for this session
crew spawn <id> --project <name> [--kind scout|ship] [--agent a1|pi|claude] "<task>"
crew wait <id>... [--timeout seconds]    block until each worker reports
crew status [--all] [--json]             tasks and their terminals
crew stop <id> [--force]                 ask the worker to leave
crew finish <id> [--force]               stop it, remove its terminal and working copy
crew done [<id>]                         (worker) my report is written
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

## Limits

- Nothing is enforced by agent hooks; the coordinator follows its rules file, and the tool
  refuses unsafe operations (second owner, reporting for another terminal, closing a busy
  worker).
- Closing a non-A1 agent's terminal can leave helper processes of that agent behind.
- No pull-request, merge, review or hold handling yet; `ship` ends with a local branch.
- One machine per home. Tested live on Windows with A1 and Pi workers and an A1 coordinator.

## Tests

`node crew/crew.test.mjs` runs everything against a fake Core.
