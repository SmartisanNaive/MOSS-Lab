#!/usr/bin/env node

/** Repository-local pull-request description validation for MOSS-Lab. */

import fs from 'node:fs'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const API_VERSION = '2026-03-10'
const HTML_COMMENT = /<!--[\s\S]*?-->/g

function readEvent() {
  if (!process.env.GITHUB_EVENT_PATH) throw new Error('GITHUB_EVENT_PATH 未设置')
  return JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
}

/**
 * Read one pull request from the repository running this workflow.
 * @param {number} number Pull-request number.
 * @returns {Promise<object>} Live REST pull-request data; rejects any failed read.
 */
async function fetchPullRequest(number) {
  const repository = process.env.GITHUB_REPOSITORY
  const token = process.env.GITHUB_TOKEN
  if (!repository || !token) throw new Error('需要 GITHUB_REPOSITORY 与 GITHUB_TOKEN')
  const response = await fetch(
    `${process.env.GITHUB_API_URL ?? 'https://api.github.com'}/repos/${repository}/pulls/${number}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': API_VERSION,
        'User-Agent': 'moss-issue-policy',
      },
    },
  )
  if (!response.ok) {
    throw new Error(`GET pulls/${number}: ${response.status} ${await response.text()}`)
  }
  return response.json()
}

/**
 * Remove HTML comments and surrounding whitespace from a pull-request body.
 * @param {string|null|undefined} body Raw pull-request body.
 * @returns {string} Visible body text; empty for absent or comment-only bodies.
 */
export function visibleBody(body) {
  return (body ?? '').replace(HTML_COMMENT, '').trim()
}

function isExempt(pull) {
  return pull.draft === true || ['Bot', 'App'].includes(pull.user?.type ?? 'User')
}

/**
 * Validate one live pull request's description.
 * @param {{title?: string|null, body?: string|null, draft?: boolean, user?: {type?: string}}} pull REST pull-request data.
 * @returns {string[]} Violations for human non-draft pull requests; always empty for exempt ones.
 */
export function validatePullRequest(pull) {
  if (isExempt(pull)) return []
  const errors = []
  if (!`${pull.title ?? ''}`.trim()) errors.push('PR 标题不能为空')
  if (!visibleBody(pull.body)) errors.push('PR 正文不能为空（HTML 注释不计入正文）')
  return errors
}

async function main(argv) {
  const [command] = argv
  if (command !== 'pr') throw new Error('用法：policy.mjs pr')
  const event = readEvent()
  const number = event.pull_request?.number
  if (typeof number !== 'number') throw new Error('事件缺少 pull_request.number')
  const pull = await fetchPullRequest(number)
  const errors = validatePullRequest(pull)
  if (errors.length > 0) {
    for (const error of errors) process.stdout.write(`::error::${error}\n`)
    throw new Error(`Issue policy 未通过，共 ${errors.length} 项`)
  }
  process.stdout.write(
    isExempt(pull)
      ? 'Issue policy exempt：Draft 或 Bot/App PR 不在强制范围。\n'
      : 'Issue policy 通过。\n',
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
