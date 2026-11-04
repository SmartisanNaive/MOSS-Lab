import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Analyze protocol source with the configured uv environment and DSH process services. */
export async function analyzeProtocol({ temporaryRoot, python, timeoutMs, sandbox, subprocess }, protocol) {
  const directory = await mkdtemp(join(await realpath(temporaryRoot), 'analysis-'))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let handle
  let quiescent = true
  try {
    await writeFile(join(directory, 'protocol.py'), protocol, { mode: 0o600, flag: 'wx' })
    const executable = await subprocess.resolveExecutable(python, undefined, controller.signal)
    const confined = await sandbox.confine([executable, '-I', '-m', 'opentrons.cli', 'analyze', '--check', '--json-output', 'analysis.json', 'protocol.py'], { mode: 'workspace-write', workspaceRoot: directory }, controller.signal)
    handle = subprocess.spawn({
      argv: confined.argv, cwd: directory, signal: controller.signal, graceMs: 2000,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 8192 } },
      env: { HOME: directory, TMPDIR: directory, PYTHONNOUSERSITE: '1' },
    })
    quiescent = false
    const outcome = await handle.done
    handle.terminate()
    quiescent = await handle.waitForExit(AbortSignal.timeout(5000))
    if (!quiescent) throw new Error('analysis process did not terminate; temporary directory retained')
    if (controller.signal.aborted) throw new Error('protocol analysis timed out')
    const output = join(directory, 'analysis.json')
    if (outcome.exitCode !== 0) {
      let diagnostic
      try {
        if ((await stat(output)).size <= 16 * 1024 * 1024) {
          const failed = JSON.parse(await readFile(output, 'utf8'))
          if (Array.isArray(failed.errors)) diagnostic = failed.errors.map(error => typeof error?.detail === 'string' ? error.detail : '').filter(Boolean).join('\n').slice(0, 1800)
        }
      } catch (error) {
        // Opentrons may fail before it writes a readable analysis file; use stderr instead.
      }
      diagnostic ||= handle.collected.stderr.readFrom(0).text.slice(-1800)
      throw new Error(`protocol analysis failed (exit ${outcome.exitCode}, signal ${outcome.signal}): ${diagnostic}`)
    }
    if ((await stat(output)).size > 16 * 1024 * 1024) throw new Error('protocol analysis exceeds output limit')
    const bytes = await readFile(output)
    const analysis = JSON.parse(bytes)
    if (!Array.isArray(analysis.commands) || analysis.errors?.length) throw new Error('protocol analysis contains errors or no commands')
    return bytes
  } finally {
    clearTimeout(timer)
    if (handle && !quiescent) {
      handle.terminate()
      quiescent = await handle.waitForExit(AbortSignal.timeout(5000))
    }
    if (quiescent) await rm(directory, { recursive: true, force: true })
  }
}
