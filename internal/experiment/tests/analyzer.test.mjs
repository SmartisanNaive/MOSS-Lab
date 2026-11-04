import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeProtocol } from '../run-example.mjs'

test('does not spawn when the sandbox is unavailable and cleans up its input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'analyzer-denied-'))
  let spawned = false
  try {
    await assert.rejects(analyzeProtocol({
      temporaryRoot: directory, python: '/python', timeoutMs: 1000,
      sandbox: { async confine() { throw new Error('sandbox unavailable') } },
      subprocess: { async resolveExecutable() { return '/python' }, spawn() { spawned = true } },
    }, 'def run(protocol): pass'), /sandbox unavailable/)
    assert.equal(spawned, false)
    assert.deepEqual(await readdir(directory), [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('reports structured protocol errors instead of an unrelated traceback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'analyzer-error-'))
  try {
    const subprocess = {
      async resolveExecutable() { return '/python' },
      spawn({ cwd }) {
        const done = writeFile(join(cwd, 'analysis.json'), JSON.stringify({ errors: [{ detail: 'Unknown labware example in protocol.py line 8' }] })).then(() => ({ exitCode: 255, signal: null }))
        return { done, terminate() {}, async waitForExit() { return true }, collected: { stderr: { readFrom() { return { text: 'long traceback' } } } } }
      },
    }
    await assert.rejects(analyzeProtocol({ temporaryRoot: directory, python: '/python', timeoutMs: 1000, sandbox: { async confine(argv) { return { argv } } }, subprocess }, 'def run(protocol): pass'), /Unknown labware example in protocol.py line 8/)
    assert.deepEqual(await readdir(directory), [])
  } finally { await rm(directory, { recursive: true, force: true }) }
})
