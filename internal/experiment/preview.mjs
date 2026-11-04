import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ExperimentError } from './index.mjs'

const sceneBuilder = join(dirname(fileURLToPath(import.meta.url)), 'build_scene.py')
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const MAX_ANALYSIS_BYTES = 16 * 1024 * 1024

/**
 * Build a temporary scene only from a current, successfully completed analysis.
 * The check producer must create the analysis itself and store its full digest in
 * result.analysisSha256; arbitrary caller-supplied check results are not trusted.
 * The caller owns the returned directory and must remove it when finished.
 */
export async function buildPreview({ store, id, revision, sessionId, analysis, python, flexRoot, temporaryRoot, timeoutMs }) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) throw new ExperimentError('INVALID_INPUT', 'a session id is required')
  if (!Buffer.isBuffer(analysis) || analysis.length === 0 || analysis.length > MAX_ANALYSIS_BYTES) {
    throw new ExperimentError('INVALID_INPUT', 'analysis must be a bounded nonempty byte buffer')
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new ExperimentError('INVALID_INPUT', 'a positive scene timeout is required')
  const capturedAnalysis = Buffer.from(analysis)
  const digest = sha256(capturedAnalysis)
  const verify = () => {
    const current = store.get(id)
    if (current.revision !== revision || !current.protocolHash || current.snapshot.sessionId !== sessionId) throw new ExperimentError('STALE_TASK', 'preview does not belong to the current experiment revision and session')
    const checks = store.getChecks(id, revision).filter(check => check.name === 'protocol-analysis')
    const latest = checks.at(-1)
    if (!latest || latest.status !== 'passed' || latest.protocolHash !== current.protocolHash || latest.result?.analysisSha256 !== digest) {
      throw new ExperimentError('PREVIEW_NOT_READY', 'current protocol has no matching successful analysis')
    }
    return latest.taskId
  }
  const taskId = verify()
  const directory = await mkdtemp(join(resolve(temporaryRoot), 'flex-preview-'))
  try {
    const input = join(directory, 'analysis.json')
    await writeFile(input, capturedAnalysis, { mode: 0o600, flag: 'wx' })
    await runScene({ python, flexRoot, input, directory, timeoutMs })
    if (verify() !== taskId) throw new ExperimentError('STALE_TASK', 'protocol analysis changed while building the preview')
    const info = JSON.parse(await readFile(join(directory, 'info.json'), 'utf8'))
    const view = JSON.parse(await readFile(join(directory, 'view.json'), 'utf8'))
    if (!Array.isArray(info.steps) || !Array.isArray(view.frames) || view.frames.length === 0) throw new ExperimentError('INVALID_PREVIEW', 'scene generator returned incomplete data')
    return { id, revision, sessionId, taskId, analysisSha256: digest, directory }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

function runScene({ python, flexRoot, input, directory, timeoutMs }) {
  return new Promise((resolvePromise, reject) => {
    const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: directory, TMPDIR: directory, FLEX3D_EXPORT: directory, PYTHONNOUSERSITE: '1' }
    const child = spawn(python, ['-I', sceneBuilder, resolve(flexRoot), input, directory], { cwd: directory, env, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    let timedOut = false
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8192) })
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => {
      clearTimeout(timer)
      if (timedOut) reject(new ExperimentError('PREVIEW_TIMEOUT', 'scene generation timed out'))
      else if (code !== 0) reject(new ExperimentError('PREVIEW_FAILED', 'scene generation failed', { diagnostic: stderr }))
      else resolvePromise()
    })
  })
}
