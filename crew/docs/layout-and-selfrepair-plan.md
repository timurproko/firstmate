# Dual-layout crew and pull-request self-repair

Plan only. Implementation waits for approval of the draft pull request.

## Scope

Change only files under `crew/`. Keep this repository's nested layout; do not move files, change the Herdr plugin, add repository infrastructure, or carry out the repository migration. The same tool source must also work when its files are installed at a repository root.

This plan follows the task instructions and sections 2 and 6 of the split investigation: crew has no Firstmate runtime dependency, but its repository discovery and self-repair paths assume a nested layout, and its current direct push to main conflicts with pull-request protection.

## Implementation outcomes

### 1. Repository discovery and repair scope work in both layouts

- In `crew.mjs`, infer the tool repository from a `.git` entry beside the module (file or directory), otherwise use its parent as today; preserve `CREW_TOOL_ROOT`.
- Define one tool-relative path prefix, empty at the root and `crew/` when nested. Use it for repair instructions, the suite command, and other literal references to the tool's own files. Leave unrelated home paths and legacy `crew/<id>` branch names intact.
- Replace the broad folder-prefix repair check with an explicit allowlist: the tool module, its test module, its README, and descendants of its own `bin/` and `docs/`. Repository infrastructure stays forbidden in either layout.
- Keep installed-copy detection, clone detection, update, and rollback behavior unchanged for existing installations.

### 2. Checked self-repairs are delivered as pull requests and kept until merged

- Retain the worker-reported, clean-copy, fetch/rebase, nonempty-change, file-scope, and full-suite checks before publication. The fixer still commits without pushing or opening a pull request.
- After checks pass, build a shared-delivery body with Proposal, ticked Implementation outcomes describing the repair, and Acceptance; omit Automation. Check it with `delivery check-body --final` when delivery is available.
- Push only the repair branch, open its pull request against main with `gh`, and record its URL on the task. Reuse the repository-owner account selection used by `crew land`. Never push to main, merge, or update the installed tool in this command.
- An already recorded pull request returns its link without creating another. Preserve compatibility with previously recorded published repairs.
- Add `crew selfrepair` as the preferred command and keep `crew selfmerge` as its compatibility alias. Explain that the person's merge is followed by `crew update` or the next `crew start`.
- Adapt finish/branch cleanup so an unmerged repair retains the branch holding its commits, and a merged repair can be cleaned up like another ship.

### 3. Isolated regressions cover both layouts and the pull-request lifecycle

- Update the existing nested-layout fixtures to use allowlisted paths and fake GitHub behavior rather than arbitrary files under `crew/` and direct publication to main.
- Assert refusal before push for an out-of-scope change and a failing suite; preserve the existing ownership, report, dirty-copy, empty-change, and rebase coverage.
- Assert branch publication, unchanged origin main and installed revision, recorded URL, repeat-command idempotency, account selection, and a valid three-section body with ticked repair outcomes.
- Cover finish before and after merge, the old command alias, and installation update only after a simulated merge followed by update/start.
- Copy this checkout's actual `crew/` contents into a temporary repository root and execute that copied source with fake Core/tools. Cover version, home, update against a fake origin, rollback, fix instructions without nested tool paths, and successful/refused self-repair. Include `.git` file recognition as well as ordinary clone directories.
- Keep root-layout checks bounded and use the existing small self-test override for publication fixtures rather than recursively running the entire suite. The completed change must pass `node crew/crew.test.mjs`.

### 4. Help and coordinator guidance describe the new behavior

- Rewrite the embedded coordinator repair rules around fix, wait, selfrepair, the person's merge, update/start, and retry. Retain the two-refusals rule and rollback guidance; remove the promise of publication without asking.
- Update command usage, related repair messages, and the README's commands and self-repair section for both layouts and the stricter file scope. Explain the old command name once as an alias.
- Bump VERSION from 0.11.0 for the implemented behavior change.

## Completion boundaries

This submission contains only this plan, not implementation or passing-test claims. After approval, deliver the four outcomes in order on the existing branch and draft pull request, updating its outcome checkboxes as each lands. Do not mark the pull request ready or merge it. The report and task completion notification are the explicit output exceptions outside this repository copy.
