---
name: dsh-pr-description
description: Write concise MOSS-Lab pull request descriptions covering the problem, final changes, validation results, and material limitations without upstream release paperwork.
user-invocable: false
---

# MOSS pull request descriptions

Use the repository [PR template](../../../.github/pull_request_template.md). Write in Chinese unless the user requests another language. Scale detail to the change: a small fix usually needs a few sentences and a short list of validation results.

## Required content

Use three sections: `## 问题`, `## 修改`, and `## 验证`.

- **问题:** State the concrete trigger and its consequence. Link a relevant issue or PR when one exists; do not create an issue or cite an unrelated one to satisfy a template. Use `Refs #N` for context. Use a closing keyword only when the issue is fully resolved and closing it is authorized.
- **修改:** Describe the final behavior. Mention changed commands, configuration, stored data, APIs, or failure handling when relevant. Include meaningful limitations or compatibility risks; omit empty categories and abandoned approaches.
- **验证:** List commands or manual steps actually run, their results, and any untested platform or behavior that matters. Distinguish local runs from CI. Include output excerpts or images only when they help review the change; screenshots and GIFs are not required for nonvisual changes.

An AI participation score, badge, stage table, per-test proof block, and before/after test matrix are not required. Keep attribution requested by the session at the end of the description. User-visible UI changes should include concise visual evidence when available, or state why the flow was not exercised.

## Publish and maintain

Write the body to a Git-ignored file or a temporary file, then pass it with `gh pr create --body-file` or `gh pr edit --body-file`. Check the submitted body after creating or updating it.

Before editing an existing description, read it and preserve author-written content that remains accurate. Update the problem, changes, and evidence when the final implementation changes; do not append a work diary. Do not edit unrelated pull requests or close issues without authorization.
