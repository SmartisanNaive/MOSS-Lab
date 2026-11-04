import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createWorkbenchWakeup, runMacWake, WorkbenchWakeError } from './workbench-wakeup.mjs'

const config = { enabled: true, browserApp: 'Google Chrome', timeoutMs: 1000, platform: 'darwin', url: () => 'http://127.0.0.1:3095/?token=private' }

test('accepted followups reuse the tab without reloading its authentication URL', async () => {
  const calls = []
  const wake = createWorkbenchWakeup({ ...config, run: async request => { calls.push(request); return { action: calls.length === 1 ? 'opened' : 'focused' } } })
  try {
    assert.equal((await wake.wake()).status, 'opened')
    assert.equal((await wake.wake()).status, 'focused')
    assert.deepEqual(calls.map(call => call.authenticate), [true, false])
    assert.equal(JSON.stringify(wake.state()).includes('private'), false)
  } finally { await wake.close() }
})

test('concurrent wakes share one operation; shutdown aborts it and waits for settlement', async () => {
  let release, aborted = false
  const wake = createWorkbenchWakeup({ ...config, run: ({ signal }) => new Promise((resolve, reject) => {
    release = () => reject(new WorkbenchWakeError('cancelled'))
    signal.addEventListener('abort', () => { aborted = true }, { once: true })
  }) })
  const first = wake.wake()
  assert.equal(wake.wake(), first)
  await new Promise(resolve => setImmediate(resolve))
  let closed = false
  const stopping = wake.close().then(() => { closed = true })
  assert.equal(aborted, true)
  assert.equal(closed, false)
  release()
  await stopping
  assert.equal(wake.state().status, 'closed')
  assert.equal((await wake.wake()).status, 'closed')
})

test('a synchronous wake failure remains retryable and does not expose diagnostics', async () => {
  let count = 0
  const wake = createWorkbenchWakeup({ ...config, run: () => {
    if (count++ === 0) throw new WorkbenchWakeError('automation_denied')
    return Promise.resolve({ action: 'focused' })
  } })
  try {
    assert.equal((await wake.wake()).reason, 'automation_denied')
    assert.equal((await wake.wake()).status, 'focused')
    assert.equal(count, 2)
  } finally { await wake.close() }
})

test('disabled or unsupported wakeup never starts native automation', async () => {
  let calls = 0
  for (const options of [{ enabled: false }, { platform: 'linux' }]) {
    const wake = createWorkbenchWakeup({ ...config, ...options, run: async () => { calls++; return { action: 'opened' } } })
    try { assert.equal((await wake.wake()).status, options.enabled === false ? 'disabled' : 'error') }
    finally { await wake.close() }
  }
  assert.equal(calls, 0)
})

test('native automation passes the login URL only over stdin and scrubs credential env', async () => {
  const secretName = 'MOSS_TEST_SECRET'
  const previous = process.env[secretName]
  process.env[secretName] = 'must-not-inherit'
  let input
  try {
    const result = await runMacWake({ ...config, url: config.url(), authenticate: true, signal: new AbortController().signal,
      spawnProcess: (command, args, options) => {
        assert.equal(command, '/usr/bin/osascript')
        assert.deepEqual(args, ['-l', 'JavaScript', '-'])
        assert.equal(options.env[secretName], undefined)
        const child = new EventEmitter()
        child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
        input = ''; child.stdin.on('data', data => { input += data })
        child.stdin.on('finish', () => { child.stdout.write('{"action":"focused"}'); child.emit('close', 0) })
        return child
      } })
    assert.equal(result.action, 'focused')
    assert.match(input, /token=private/)
    assert.match(input, /cfg\.authenticate/)
  } finally { if (previous === undefined) delete process.env[secretName]; else process.env[secretName] = previous }
})

test('native timeout kills the helper and waits for close before reporting failure', async () => {
  let close, killed = false, settled = false
  const operation = runMacWake({ ...config, timeoutMs: 5, url: config.url(), authenticate: true, signal: new AbortController().signal,
    spawnProcess: () => {
      const child = new EventEmitter()
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
      child.kill = signal => { assert.equal(signal, 'SIGKILL'); killed = true }
      close = () => child.emit('close', null)
      return child
    } })
  const observed = operation.then(() => { settled = true }, error => { settled = true; assert.equal(error.code, 'timeout') })
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(killed, true); assert.equal(settled, false)
  close(); await observed
})

test('remote URLs and unsupported browser names are rejected before spawn', () => {
  const options = { ...config, authenticate: true, signal: new AbortController().signal, spawnProcess: () => { throw new Error('must not spawn') } }
  assert.throws(() => runMacWake({ ...options, url: 'https://example.com/?token=private' }), error => error.code === 'invalid_local_url')
  assert.throws(() => runMacWake({ ...options, url: config.url(), browserApp: 'unknown' }), error => error.code === 'unsupported_browser')
})

test('ordinary accepted messages ensure a tab exists without activating an existing window', async () => {
  const calls = []
  const wake = createWorkbenchWakeup({ ...config, run: async request => { calls.push(request); return { action: request.focus ? 'focused' : 'existing' } } })
  try {
    assert.equal((await wake.ensureOpen()).status, 'existing')
    await wake.ensureOpen()
    await wake.wake()
    assert.deepEqual(calls.map(call => call.focus), [false, false, true])
    assert.deepEqual(calls.map(call => call.authenticate), [true, false, false])
  } finally { await wake.close() }
})
