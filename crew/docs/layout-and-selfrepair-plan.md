# Pull-request self-repair for crew

Implementation approved, with the subsequent scope reduction reflected below. The repository remains nested. Moving crew to a repository root is a separate, one-time migration; this change must not carry dual-layout support.

## Scope

Change only files under `crew/`. Do not move files, change the Herdr plugin, add repository infrastructure, or carry out the repository migration. Keep `TOOL_ROOT` and the nested `crew/` tool paths as on main.

The original dual-layout work is withdrawn: remove filesystem-based repository detection, the tool-relative path prefix, and every root-layout test and fixture. No new root-layout compatibility is part of this pull request.

## Implementation outcomes

### 1. Repairs are limited to crew's explicit file allowlist

- Check only crew's module, test module, README, and descendants of its own `bin/` and `docs/`.
- Express the allowlist in names relative to the tool's folder, separate from the existing nested repository path. The list itself will not change during the later move.
- Exclude repository infrastructure, including workflow files, agent instructions, package metadata, scripts, licence, ignore and attribute files. Also reject arbitrary files merely placed under `crew/`.

### 2. Checked self-repairs are delivered as pull requests and kept until merged

- Retain the worker-reported, clean-copy, fetch and safe integration of main, nonempty-change, file-scope, and full-suite checks before publication. The fixer still commits without pushing or opening a pull request.
- Build a shared-delivery body with Proposal, one ticked Implementation outcome describing the repair, and Acceptance; omit Automation. Check it with `delivery check-body --final` when delivery is available.
- Push only the repair branch, open its pull request against main with `gh`, and record its URL on the task. Reuse the repository-owner account selection used by `crew land`. Never push to main, merge the pull request, or update the installed tool in this command.
- New repair branches include the home tag so independent homes do not publish the same local repair number. Existing task records remain authoritative for their branch names.
- Rebase only unpublished repairs. Once the repair branch is published, merge newer main history rather than rewriting already published commits when retrying after a GitHub failure.
- An already recorded pull request returns its link without creating another. Preserve compatibility with previously recorded published repairs.
- Add `crew selfrepair` as the preferred command and keep `crew selfmerge` as its compatibility alias. Explain that the person's merge is followed by `crew update` or the next `crew start`.
- Adapt finish/branch cleanup so an unmerged repair retains the branch holding its commits, and a merged repair can be cleaned up like another ship.

### 3. Isolated regressions cover guarded repair delivery in the existing layout

- Update existing nested-layout fixtures to use allowlisted paths and fake GitHub behavior rather than arbitrary files under `crew/` and direct publication to main.
- Assert refusal before push for out-of-scope files, a failing suite, and an invalid delivery body; preserve ownership, report, dirty-copy, empty-change, and rebase checks.
- Assert repair-branch publication, unchanged origin main and installed revision, recorded URL, repeat-command idempotency, account selection, and a valid three-section body with a ticked repair outcome.
- Cover finish before and after merge, the old command alias, and installation update only after a simulated merge followed by update/start. Retain existing update and rollback coverage.
- Reproduce and fix independent homes publishing their first repairs to one origin, and retrying a published repair after GitHub fails and main advances. Cover recorded legacy branch names as well.
- Use fake Core, GitHub, and remotes. No root-layout fixtures or tests remain. The completed change must pass `node crew/crew.test.mjs`.

### 4. Help and coordinator guidance describe pull-request self-repair

- Rewrite coordinator repair rules around fix, wait, selfrepair, the person's merge, update/start, and retry. Retain the two-refusals rule and rollback guidance; remove the promise of publication without asking.
- Update usage, repair messages, and the README's commands and self-repair section for the narrower file scope and pull-request flow. Explain the old command name once as an alias.
- Bump VERSION from 0.11.0 for the implemented behavior change.

## Deferred work

Root-layout paths will be changed once during the separately authorized creation of the new repository. No filesystem detection or dual-layout abstraction is needed here.
