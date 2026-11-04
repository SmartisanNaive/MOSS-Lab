import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

const macScript = readFileSync(new URL('./workbench-macos.jxa', import.meta.url), 'utf8')
const browsers = ['Google Chrome', 'Microsoft Edge', 'Safari']

/** A failed wake never cancels an accepted model turn. */
export class WorkbenchWakeError extends Error {
  constructor(code) { super('工作台窗口未能自动显示，请手动打开工作台。'); this.code = code }
}

/** Run trusted browser automation without putting the login URL in argv or logs. */
export function runMacWake({ url, browserApp, authenticate, focus = true, timeoutMs, signal, spawnProcess = spawn }) {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(parsed.hostname) || parsed.username || parsed.password) throw new WorkbenchWakeError('invalid_local_url')
  if (!browsers.includes(browserApp)) throw new WorkbenchWakeError('unsupported_browser')
  const input = 'var cfg = ' + JSON.stringify({ url, origin: parsed.origin, browserApp, authenticate, focus }) + ';\n' + macScript
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG'].includes(key) || key.startsWith('LC_')))
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new WorkbenchWakeError('cancelled')); return }
    let child
    try { child = spawnProcess('/usr/bin/osascript', ['-l', 'JavaScript', '-'], { env, stdio: ['pipe', 'pipe', 'pipe'] }) }
    catch { reject(new WorkbenchWakeError('launch_failed')); return }
    let output = '', diagnostic = '', failure = null
    const stop = () => { failure = 'cancelled'; child.kill('SIGKILL') }
    const timer = setTimeout(() => { failure = 'timeout'; child.kill('SIGKILL') }, timeoutMs)
    signal.addEventListener('abort', stop, { once: true })
    child.stdout.on('data', chunk => { output = (output + chunk).slice(0, 4096) })
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(0, 8192) })
    child.stdin.on('error', () => { failure ??= 'launch_failed' })
    child.on('error', () => { failure ??= 'launch_failed' })
    child.on('close', code => {
      clearTimeout(timer); signal.removeEventListener('abort', stop)
      if (failure !== null) { reject(new WorkbenchWakeError(failure)); return }
      if (code !== 0) { reject(new WorkbenchWakeError(/-1743|not authorized|不允许发送/.test(diagnostic) ? 'automation_denied' : 'browser_failed')); return }
      let result
      try { result = JSON.parse(output) } catch { reject(new WorkbenchWakeError('invalid_response')); return }
      if (!['focused', 'opened', 'existing'].includes(result?.action)) { reject(new WorkbenchWakeError('invalid_response')); return }
      resolve(result)
    })
    child.stdin.end(input)
  })
}

/** Own one cancellable wake at a time; browser focus errors remain observable. */
export function createWorkbenchWakeup({ enabled, browserApp, timeoutMs, url, platform = process.platform, run = runMacWake }) {
  if (typeof enabled !== 'boolean' || !browsers.includes(browserApp) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || typeof url !== 'function') throw new Error('xiaozhi wakeup requires enabled, browserApp, timeoutMs and a local URL provider')
  let state = { status: enabled ? 'idle' : 'disabled', reason: null, updatedAt: Date.now() }
  let authenticated = false
  let pending = null
  let pendingFocus = false
  let closed = false
  const controller = new AbortController()
  const update = (status, reason = null) => { state = { status, reason, updatedAt: Date.now() }; return { ...state } }
  const request = (focus) => {
      if (closed || !enabled) return Promise.resolve({ ...state })
      if (pending !== null) return focus && !pendingFocus ? pending.then(() => request(true)) : pending
      if (platform !== 'darwin') return Promise.resolve(update('error', 'unsupported_platform'))
      update('waking')
      pendingFocus = focus
      pending = Promise.resolve().then(async () => {
        try {
          const result = await run({ url: url(), browserApp, authenticate: !authenticated, focus, timeoutMs, signal: controller.signal })
          authenticated = true
          return update(result.action)
        } catch (error) { return update('error', error instanceof WorkbenchWakeError ? error.code : 'browser_failed') }
        finally { pending = null }
      })
      return pending
  }
  return {
    state: () => ({ ...state }),
    wake: () => request(true),
    ensureOpen: () => request(false),
    async close() { closed = true; controller.abort(); await pending; update('closed') },
  }
}
