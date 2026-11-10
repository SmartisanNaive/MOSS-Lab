# Issue management

English | [中文](README.zh.md)

MOSS-Lab enforces a repository-local pull-request description check; the upstream organization Project board and its GitHub App are not part of this repository.

## Pull-request policy

[Issue policy](../workflows/issue-policy.yml) runs on every non-draft, human-authored pull request, using the workflow definition from the trusted default branch. A pull request needs a non-empty title and a body that still has content after HTML comments are removed; HTML comments and hidden text do not count as a description. Draft pull requests and Bot or App authors (including Dependabot) are exempt and finish successfully.

The check reads live pull-request state with the repository `GITHUB_TOKEN`; it uses no secrets, no external actions beyond checkout, and never writes to GitHub.

## Verification

The focused, keyless suite runs from the repository root:

```sh
node .github/issue-management/policy.test.mjs
```

[Workflow tests](../../scripts/ci-workflow.spec.ts) verify the trigger and permission declarations.

## Limitations

The check validates only the description. The upstream label taxonomy, priority matching, and Project lifecycle tracking require organization Projects and a dedicated GitHub App; this repository intentionally does not reproduce them.
