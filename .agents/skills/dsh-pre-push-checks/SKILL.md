---
name: dsh-pre-push-checks
description: Select focused checks before publishing MOSS-Lab changes, reuse passing evidence, and verify the pushed branch and its CI without rehearsing unused upstream DSH features.
---

# MOSS pre-push checks

MOSS-Lab uses DSH as its framework. Check the behavior changed by a pull request; do not rehearse the upstream release, coverage, benchmark, or platform matrix for ordinary MOSS development.

## Inspect and select

1. Confirm the branch, worktree changes, and live PR base with Git. Fetch the base and inspect the diff; `pnpm run change-scope --base origin/main` is available when a structured report helps.
2. Run the smallest checks that cover the diff using the table below. Reuse passing results while their inputs remain unchanged.
3. Commit through the normal hooks, inspect any staged lint fixes, and push. The existing pre-push hook runs incremental type checking for matching files.
4. Confirm the remote head matches the intended commit and inspect the PR checks. Pending checks remain pending; inspect failures before blaming the environment or overriding them.

| Changed behavior | Local evidence |
|---|---|
| Experiment or voice logic | Run the affected tests under `internal/experiment/tests/` or `internal/xiaozhi/`; include adjacent tests when shared behavior changes. |
| Client UI | Run the owning client tests and build. Exercise the changed user flow when behavior or presentation changes. |
| Dependencies or build configuration | Run `pnpm install --frozen-lockfile`, the affected tests, and `pnpm run build`. Include `pnpm run constraints` when workspace versions or dependency declarations change. |
| Repository scripts | Run the owning script tests; TypeScript changes also need `pnpm run build:check` against current artifacts, or `pnpm run build`. |
| Ordinary documentation or process instructions | Check changed links, formatting, and any edited bilingual pair. Use `pnpm run test:docs` when the affected checks are not clear. Full `doc-sync` is reserved for documentation generators, catalogs, shared documentation rules, or explicit requests. |
| Core framework, durable data, sandbox, or lifecycle behavior | Follow the owning package rules and add its focused tests or snapshots. Framework changes still require their compatibility and safety evidence. |

Run `git diff --check` before committing. Do not rerun passing tests merely because a commit, push, or PR creation follows. Do not default to full coverage, benchmarks, npm publication checks, unrelated provider tests, or real-device operations.

## Publishing and merging

Report only commands actually run and distinguish local evidence from CI. Never hide a failing check with a broader exclusion, disabled validation, or a hook bypass. A relevant failure blocks dependent work until fixed or explicitly resolved with the user.

For a rewritten branch, fetch and record the remote commit first, then use an exact `--force-with-lease`; never use raw `--force`. A `gh stack sync` may publish before local validation: validate changed layers immediately and keep them unmerged until the selected checks pass.

When a PR has no checks, inspect merge conflicts and workflow triggers before pushing empty commits or toggling draft state. Do not change unrelated PRs or close issues as part of publishing a fix unless authorized.
