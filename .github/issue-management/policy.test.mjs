import test from 'node:test'
import assert from 'node:assert/strict'

import { validatePullRequest, visibleBody } from './policy.mjs'

test('visibleBody removes HTML comments and trims whitespace', () => {
  assert.equal(visibleBody('  <!-- hidden -->  '), '')
  assert.equal(visibleBody('<!-- a -->\nreal body\n<!-- b -->'), 'real body')
  assert.equal(visibleBody(null), '')
  assert.equal(visibleBody(undefined), '')
})

test('requires a non-empty title and a visible body for human pull requests', () => {
  const human = { title: 'fix: repair the deck', body: 'Explains the change.', draft: false, user: { type: 'User' } }
  assert.deepEqual(validatePullRequest(human), [])
  assert.deepEqual(validatePullRequest({ ...human, user: undefined }), [])
  assert.deepEqual(validatePullRequest({ ...human, title: '   ' }), ['PR 标题不能为空'])
  assert.deepEqual(
    validatePullRequest({ ...human, body: '<!-- only a comment -->' }),
    ['PR 正文不能为空（HTML 注释不计入正文）'],
  )
  assert.deepEqual(validatePullRequest({ ...human, title: '', body: '' }), [
    'PR 标题不能为空',
    'PR 正文不能为空（HTML 注释不计入正文）',
  ])
})

test('exempts drafts and automated authors', () => {
  for (const pull of [
    { title: '', body: '', draft: true, user: { type: 'User' } },
    { title: '', body: '', draft: false, user: { type: 'Bot' } },
    { title: '', body: '', draft: false, user: { type: 'App' } },
  ]) {
    assert.deepEqual(validatePullRequest(pull), [])
  }
})
