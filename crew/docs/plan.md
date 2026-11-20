# Crew and Firstmate on Windows — plan v1

Plan version: 1 (2026-11-17). This is the single current plan. It replaces the earlier
"Firstmate–Herdr integration" plans (v5–v7), which were private working notes.
How to use crew is in [`../README.md`](../README.md); this document covers where the work
stands, why it went this way, and what is left.

Status: crew 0.6.0 is the working route for orchestration from Herdr on Windows. The
original Firstmate still runs from this fork with a small series of Windows fixes and is
kept as it is.

## 1. What this is

Two machines: the **main PC**, where the Herdr app is used, and **pc2**, reached over SSH,
which does the work as a server. Herdr Core runs every terminal on both.

This repository is a fork of Firstmate (`kunchenguid/firstmate`) and holds two things:

| Part | Where | Role |
|---|---|---|
| Firstmate, with Windows fixes | everything outside `crew/` | the original orchestrator; preserved, started by hand |
| crew | `crew/` | a small orchestration tool built directly on Herdr Core; the route in daily use |

A Herdr profile marked **Run as crew coordinator** starts an agent (A1, Pi or Claude Code)
as a crew coordinator on the profile's machine. The coordinator runs `crew` commands;
crew starts workers as Core terminals, each in its own working copy, and collects their
reports. Herdr only launches and displays; crew owns tasks and working copies; Core owns
the terminals.

## 2. Why crew exists

Firstmate was first made to work on native Windows (section 5). It works, but its shell
scripts run on the order of a thousand small commands per step, and process creation in
Git Bash makes every step slow:

| Measurement | Firstmate on Windows | crew |
|---|---|---|
| Coordinator ready after launch | 80–113 s | about 5 s |
| One-line scout, request to answer | 9.5–11.7 min | 22–44 s |
| Three scouts requested at once | 31 min, one at a time | 59 s, all three at once |
| Spawn / finish | about 110 s / 117 s | 0.5–2 s |

Trimming the scripts further gave diminishing returns, so crew was written as one
dependency-free Node file in the same fork, with Firstmate's code close by as reference.

## 3. Layout

| Folder | What it is |
|---|---|
| `~/.crew/core` | the installed copy of this fork on each machine (`~/.crew/tool` before 0.7); updates itself at `crew start` |
| `~/.crew` | the home: projects (`crew.json`), `tasks/`, backlog, pages |
| `~/.crew/coordinator` | the coordinator's rules and the folder it starts in. Herdr names the space after the folder, so the space is called "coordinator" |
| `~/.crew/.worktrees` | workers' working copies on a machine without the shared delivery workflow (never under `coordinator/`, so a worker never loads the coordinator's rules). With it, `delivery start` makes the copy: a treehouse pool slot or `<project>/.worktrees/<id>` |
| `~/.crew/state` | update and crash records |
| `D:\Git\crew` | development clone of this fork on both machines. On pc2 it is also the Firstmate install and holds Firstmate's untracked `config/`, `data/`, `projects/`, `state/` |

Do not edit `~/.crew/core`; change crew in the development clone and merge to `main`.

## 4. Crew: verified state

All on native Windows, most on pc2 with a real coordinator.

| Capability | Result |
|---|---|
| A1 and Pi workers; A1 and Claude Code coordinators | PASS |
| Claude Code workers (normal permissions, working copy pre-trusted, account chosen in Herdr) | PASS |
| Second coordinator on the same home | PASS: refused, read-only status |
| Owner terminal killed mid-task, new owner takes over | PASS |
| Code-changing task on its own branch, project checkout untouched | PASS |
| Follow-up to a worker, read-only review, pull request (`tell`, `review`, `land`) | PASS |
| crew repairs itself (`fix`, `selfmerge`, self-update, `rollback`) | PASS: real defect fixed and published in about 3.5 min; pc2 updated itself |
| Firstmate's tools: backlog, treehouse pool, gh-axi, chrome-devtools-axi, quota-axi, jq, lavish-axi | PASS |
| Delivery through the no-mistakes gate | PASS with the CI and lint steps skipped (section 7) |
| `crew show`: page opened with lavish-axi, link in Herdr's status bar, reachable from the main PC | PASS for the link and the forwarded page; automatic opening in the main PC's browser not yet confirmed by eye |
| Pi as coordinator on pc2 | FAIL, not understood: Pi showed an animated screen and never processed the message |

Rules crew keeps: one live owner per home; an unknown answer from Core never justifies
takeover, failure or deletion; uncommitted work in a code task is kept unless forced;
crew never merges a project's pull request; a self-repair may only touch `crew/` and must
pass the full test suite before it is published.

## 5. Firstmate on Windows: state of the fork

Upstream Firstmate had not been run on Windows with A1, so each stage after launch needed
a small fix. `main` is upstream `427056c4` plus:

| PR | What it fixes |
|---|---|
| #1 | Core `hello` handshake on Windows; A1 workers stop through `a1 api` |
| #2 | Session lock recognises an A1 coordinator on Windows |
| #3 | Worker folder detection behind the Windows `bash.exe` launcher |
| #4 | Lock library reads `/proc` instead of spawning `ps` |
| #5, #6 | Visible "Firstmate is starting (Ns)…" line during startup |
| #7 | Opt-in background home-summary refresh; home tag derived once |

Verified with A1 as coordinator and worker: launch from a Herdr profile, home lock,
dispatch into an isolated working copy, report relayed correctly, graceful worker stop,
coordinator exit through `a1 api`. Three workers requested at once gave three correct
answers but ran one at a time.

Known gaps: four Firstmate test cases fail on Windows on upstream code too; the largest
lock suite needs more than 15 minutes on Windows; Linux/macOS suites and shellcheck were
not run for this series; `state/.lock` survives a clean coordinator exit and is reclaimed
as stale at the next start. The tag `archive/fork-main-pre-reset` points at the fork's
earlier line.

## 6. Herdr side

Kept in the user's private Herdr customizations, not in this repository:

- **Crew plugin**: requirements checklist per machine ("Install on" chooses whose list is
  shown and installed to); installs this fork into `~/.crew/core`; the tools from section 4
  are optional rows.
- **Profile checkbox** "Run as crew coordinator", offered for a profile on any machine;
  crew is checked on the profile's own machine at launch.
- **Pane title chip**: "Crew" on the coordinator; Scout / Ship / Review / Fix on workers.
- **Status bar**: a "Lavish" item for a page opened with `crew show`; for a terminal on
  pc2 the page is served to the main PC through the existing SSH forward.

## 7. Open items

Crew, in order:

1. Timeouts and retry for quiet or blocked workers (a worker waiting at a permission
   prompt currently sits until someone notices).
2. Queue and holds; task history.
3. Confirm in the app: a coordinator started by clicking the profile, with the Claude
   account dropdown; a Lavish page opening on the main PC and not on pc2.
4. Pi as coordinator on pc2.
5. A self-repair that passes the suite but is wrong still reaches every machine;
   `rollback` is per machine.
6. Confirm in real use: a coordinator spawning and finishing workers whose copies come from
   `delivery start`, pooled and plain, including a self-repair of crew.

Environment:

- GitHub Actions has started no run on this fork since 2026-11-13, so the gate skips its
  CI step by default (`crew project add … --gate-skip`).
- The fork's gate lint command is a bash script and cannot run on pc2 (no shellcheck or
  actionlint on the gate's PATH), so lint is skipped there as well.
- Two Claude Code workers started in the same second can log each other out; that is in
  the account launcher, outside crew.

Firstmate, only if it is taken further:

1. Upstream the fork series, smallest first (#1, #4, #3).
2. Fix or scope the four Windows test failures so a full run can be green.
3. Performance of spawn and teardown; then concurrency and recovery tests.

## 8. Working rules

- Fail closed. No typed keystrokes into an agent, no forced exits, no answering an agent's
  permission or trust prompt on the person's behalf.
- Test crew with `node crew/crew.test.mjs` and check the exit code explicitly.
- A live trial uses its own home (`CREW_HOME`) and ends with the coordinator closed and
  its working copies removed.
- Report PASS / FAIL / NOT RUN as observed; a passing automated check is not the same as
  having seen it in the app.

## 9. History in brief

| Date | Step |
|---|---|
| 2026-11-15 | Inventory and first integration design for Firstmate in Herdr |
| 2026-11-16 – 17 | Firstmate fixed for Windows (PRs #1–#7); single-worker lifecycle passes; too slow for daily use |
| 2026-11-17 | Decision to build crew on Herdr Core; prototype, live tests, merged (PR #8, 0.1.0) |
| 2026-11-17 | Claude workers and account choice (#9–#11); reviewed defects fixed (#12) |
| 2026-11-17 | Self-repair (#13, 0.2.0); delivery workflow (#14–#15, 0.3.0); Firstmate's tools (#16, 0.4.0) |
| 2026-11-17 | Two end-to-end runs on pc2; `crew show`; gate options (#17–#24, 0.5.x) |
| 2026-11-17 | Home renamed to `~/.crew/crew`; pages open on the person's PC (#25, 0.6.0) |
| 2026-11-20 | `crew finish` deletes a merged branch (#27). Aligned with the shared delivery workflow (#28, 0.7.0): flat `~/.crew` layout with `coordinator/`, branches named `<type>/<id>`, `.artifacts/KEEP` honoured, pooled copies returned with `--force` when their files are scratch |
| 2026-11-20 | Workers' copies come from the shared delivery workflow (`delivery start` / `delivery finish`, 0.8.0); pooled copies are one machine setting, `delivery pool`, and the per-project `--treehouse` choice is gone |
