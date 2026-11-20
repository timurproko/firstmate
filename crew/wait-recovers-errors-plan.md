# Recover stopped workers during crew wait

## Scope and observed gap

This is an implementation plan only; no runtime behavior changes until the plan is approved.
All implementation, regression tests, and documentation changes stay under `crew/`.

A provider or network error can end a worker's turn while its terminal and agent stay alive.
The reported examples are `Error: no healthy upstream` and an upstream connection failure, with Core reporting `status.state: error`.
The existing `cmdWait` handles quota/login stops and missing agents, but otherwise leaves an error or idle worker waiting until timeout.
A manual `crew tell` resumes the affected worker, but also changes task reporting state and its `tells` counter, so automatic recovery must send through Core directly instead.
These observations come from the supplied incident and inspection of the command paths, not a new live-provider reproduction.

## Implementation outcomes

### 1. Provider and network error stops recover with bounded retries and hand-over

- Keep recovery inside the existing owner-only hand-over permission and honor both `--no-fallback` and `CREW_NO_FALLBACK=1`.
- Check quota/login stops first and retain their immediate hand-over without a continue message.
- Require two consecutive Core error observations before acting on another error, then send a short continue message through the same Core send operation used by `crew tell`.
- Centralize recovery timings with one documented environment override for accelerated tests, using default error retry delays of 30, 120, and 300 seconds, an idle delay of 120 seconds, and a sustained-working reset period of 30 seconds.
- Record automatic sends separately as nudge history with timestamp, reason, worker terminal, and attempt information; never increment `tells` or reopen a reported task.
- Preserve the active recovery episode and retry timing across repeated waits so restarting a wait cannot bypass the three-attempt limit.
- Reset the error episode only after sustained working observations, not a brief working flicker, and give a replacement terminal its own episode.
- After the third send, observe whether the worker resumes before handing unrecovered work to the existing `relaunch` path with the last screen error line as the reason.
- When no candidate can take over, return `needs a person` with the last error and a summary of the three attempts.
- Print one action line per automatic message or hand-over, including the error and attempt count.
- Preserve newer task records if a worker reports while Core is delivering a message, and handle send failures without claiming a successful nudge.
- Extend fake-Core coverage for the two-check requirement, retry spacing and cap, last-error hand-over, exhausted candidates, sustained recovery reset, quota precedence, owner-only behavior, and both opt-outs.

### 2. Idle workers without reports receive one reminder before escalation

- Track sustained `idle` or `done` observations only while a task is still working and has no report.
- After the idle delay, send one reminder to continue, or write the report and run `crew done` if finished, recording it separately from coordinator follow-ups.
- Allow another full idle interval after the reminder before returning `needs a person` if the worker has not resumed or reported.
- Do not treat blocked or unknown Core states as idle, and keep permission questions and other blocked workers as immediate requests for a person without sending anything.
- Skip reported tasks and existing reports, including a report that arrives during recovery.
- Add fake-Core cases for one idle reminder, resumed work, repeated idle escalation, blocked workers, and reported tasks or report files receiving no nudges.

### 3. Recovery is visible in status and documented for coordinators

- Add recorded nudge information and continuation counts to `crew status --json`, and show the current Core error state and count in text status without sending messages.
- Keep reporting-stage interpretation, task state, and coordinator `tells` semantics unchanged.
- Add one or two lines to `COORDINATOR_RULES` describing automatic error recovery, eventual hand-over, and forwarding action lines to the person afterwards rather than asking them to intervene first.
- Update the README work-under-way section with provider-error and idle behavior, limits, timing defaults, environment override, opt-outs, and blocked/report exclusions.
- Bump `VERSION` and add read-only text/JSON status regressions.
- Remove this temporary plan document once its approved outcomes are implemented.

## Integration and verification

Keep `cmdWait` edits compact and reuse `relaunch` rather than introducing another candidate-selection path.
Pull request 36 changes candidate-chain retention and relaunch behavior; rebase after it lands and preserve its full candidate chain.
The regression suite will drive fake Core status/screen transitions and inspect its send log, with shortened recovery timings to keep execution reasonable.
After implementation, `node crew/crew.test.mjs` must exit 0.
No runtime tests are required to claim this plan complete, and the plan makes no claim that recovery is already implemented.
