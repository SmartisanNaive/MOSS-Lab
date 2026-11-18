/** Confined adapter for the public LabscriptAI MCP interface. */
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { ExperimentError } from './index.mjs'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const MAX_ANALYSIS = 16 * 1024 * 1024
const MAX_DOCUMENT = 64 * 1024 * 1024

/** Read a bounded regular plugin artifact beneath this invocation's data directory.
 * @param {string} directory Owned invocation directory.
 * @param {string} path Public artifact path returned by MCP.
 * @param {number} limit Maximum bytes.
 * @returns {Promise<Buffer>} Verified local bytes.
 */
export async function readPluginFile(directory, path, limit) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new ExperimentError('PLUGIN_RESPONSE_INVALID', 'plugin returned an invalid artifact path')
  const canonical = await realpath(path)
  const rel = relative(await realpath(directory), canonical)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new ExperimentError('PLUGIN_RESPONSE_INVALID', 'plugin artifact is outside its invocation directory')
  const info = await stat(canonical)
  if (!info.isFile() || info.size < 1 || info.size > limit) throw new ExperimentError('PLUGIN_RESPONSE_INVALID', 'plugin artifact exceeds size limits')
  const bytes = await readFile(canonical)
  if (!bytes.length || bytes.length > limit) throw new ExperimentError('PLUGIN_RESPONSE_INVALID', 'plugin artifact exceeds size limits')
  return bytes
}

async function writeProtocol(directory, protocol) {
  const path = join(directory, 'protocol.py')
  await writeFile(path, protocol, { mode: 0o600, flag: 'wx' })
  return path
}

/** Create a confined MCP client for simulation, documents and configured robot operations.
 * @param {object} config Frozen plugin paths, version, timeout, and sandbox service.
 * @returns {object} Analysis, portable-document and robot methods; caller awaits operations before disposal.
 */
export function createPluginClient(config) {
  for (const key of ['root', 'data', 'dependencyHome', 'version']) {
    if (typeof config?.[key] !== 'string' || !config[key]) throw new Error(`LabscriptAI client requires ${key}`)
  }
  if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 150000 || !config.sandbox) throw new Error('LabscriptAI client requires sandbox and timeoutMs >= 150000')
  async function invoke(operation, robot, beforeDispatch) {
    const directory = await mkdtemp(join(await realpath(config.data), 'mcp-'))
    const home = join(directory, 'home')
    await mkdir(home)
    const timeoutMs = robot && !beforeDispatch ? Math.min(config.timeoutMs, 30000) : config.timeoutMs
    const signal = AbortSignal.timeout(timeoutMs)
    let confined
    try { confined = await config.sandbox.confine([process.execPath, join(config.root, 'servers/opentrons-mcp/index.js')], { mode: 'workspace-write', workspaceRoot: directory }, signal) } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw error
    }
    const env = Object.fromEntries(['PATH', 'SystemRoot', 'ComSpec', 'LOCALAPPDATA', 'USERPROFILE'].filter(key => process.env[key]).map(key => [key, process.env[key]]))
    const transport = new StdioClientTransport({ command: confined.argv[0], args: confined.argv.slice(1), cwd: directory, stderr: 'pipe',
      env: { ...env, HOME: home, TMPDIR: directory, TEMP: directory, TMP: directory, PYTHONDONTWRITEBYTECODE: '1',
        PLUGIN_DATA: directory, OPENTRONS_PLUGIN_ROOT: config.root, LABSCRIPTAI_HOME: config.dependencyHome,
        LABSCRIPTAI_INHERIT_PRIVATE_ACL: process.platform === 'win32' ? '1' : '0',
        FLEX3D_EXPORT: join(directory, 'export'), OPENTRONS_CONNECTION_FILE: join(directory, 'robot.json'),
        ...(robot ? { OPENTRONS_HOST: robot.origin, ...(robot.authorization ? { OPENTRONS_AUTHORIZATION: robot.authorization } : {}) } : {}), MUJOCO_GL: 'disable' }, maxBufferSize: 12 * 1024 * 1024,
    })
    const client = new Client({ name: 'moss-lab-artifacts', version: '1' })
    let diagnostic = ''
    transport.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-4096) })
    let unsettled = false
    try {
      await client.connect(transport, { signal, timeout: timeoutMs })
      if (client.getServerVersion()?.version !== config.version) throw new ExperimentError('PLUGIN_VERSION_MISMATCH', 'plugin version differs from the lock; rerun installation')
      const call = async (name, args) => {
        const allowed = robot ? ['robot_status', 'get_protocols', 'query_history', 'run_protocol', 'preflight_run_setup', 'control_run'] : ['simulate_protocol', 'protocol_artifacts']
        if (!allowed.includes(name)) throw new Error('MCP operation is not allowed')
        beforeDispatch?.()
        unsettled = true
        const response = await client.callTool({ name, arguments: args }, { signal, timeout: timeoutMs })
        unsettled = false
        const text = response.content?.find(item => item.type === 'text')?.text
        let envelope
        try { envelope = JSON.parse(text) } catch (error) { throw new ExperimentError('PLUGIN_RESPONSE_INVALID', 'plugin returned unreadable JSON', { cause: error.message }) }
        if (response.isError || envelope.success !== true) {
          const blocked = envelope.data?.blocked_real_execution === true
          throw new ExperimentError(blocked ? 'ROBOT_PREFLIGHT_BLOCKED' : 'PLUGIN_CALL_FAILED',
            robot ? (blocked ? 'OT blocked this run during its software checks.' : 'OT could not confirm the robot operation. Check its current state before retrying.') : envelope.error?.message || 'plugin operation failed',
            robot ? { runId: envelope.run_id, stage: envelope.data?.gate_stage } : {})
        }
        return envelope.data
      }
      return await operation(call, directory)
    } catch (error) {
      if (error instanceof ExperimentError) throw error
      throw new ExperimentError('PLUGIN_CALL_FAILED', 'LabscriptAI operation failed; check the installed version and retry', { diagnostic, cause: error.message })
    } finally {
      await client.close()
      // An interrupted server can leave a child process alive. Retain its private
      // workspace on failure rather than delete a directory it may still own.
      if (!unsettled) await rm(directory, { recursive: true, force: true })
      else console.error('LabscriptAI operation failed; private invocation files retained:', directory)
    }
  }
  return {
    robot(robot, name, args, protocol, beforeDispatch) {
      return invoke(async (call, directory) => {
        if (protocol === undefined) return call(name, args)
        return call(name, { ...args, file_path: await writeProtocol(directory, protocol) })
      }, robot, beforeDispatch)
    },
    analyze(protocol) {
      return invoke(async (call, directory) => {
        const result = await call('simulate_protocol', { protocol_path: await writeProtocol(directory, protocol), analysis_only: true })
        if (!result?.ok) {
          const detail = result?.analyze_errors?.map(error => error.detail || error.error || '').filter(Boolean).join('\n') || result?.error?.error || result?.stderr || 'plugin analysis failed'
          throw new ExperimentError('ANALYSIS_FAILED', `protocol analysis failed: ${String(detail).slice(0, 1800)}`)
        }
        const bytes = await readPluginFile(directory, result.analysis_path, MAX_ANALYSIS)
        const analysis = JSON.parse(bytes)
        if (!Array.isArray(analysis.commands) || analysis.errors?.length) throw new ExperimentError('ANALYSIS_FAILED', 'protocol analysis contains errors or no commands')
        return bytes
      })
    },
    documents(analysis) {
      if (!Buffer.isBuffer(analysis) || !analysis.length || analysis.length > MAX_ANALYSIS) throw new ExperimentError('INVALID_INPUT', 'analysis must be a bounded nonempty buffer')
      const captured = Buffer.from(analysis)
      return invoke(async (call, directory) => {
        const input = join(directory, 'analysis.json')
        await writeFile(input, captured, { mode: 0o600, flag: 'wx' })
        const result = await call('protocol_artifacts', { analysis_path: input })
        return readPluginDocuments(result, digest(captured), config.version, directory)
      })
    },
  }
}

/** Validate a public artifact manifest and read only matching invocation-owned HTML.
 * @param {object} result MCP artifact response.
 * @param {string} analysisSha256 Expected analysis digest.
 * @param {string} version Pinned plugin version.
 * @param {string} directory Private invocation directory.
 * @returns {Promise<object>} Independently available document buffers.
 */
export async function readPluginDocuments(result, analysisSha256, version, directory) {
  if (!result?.ok || result.artifact_api !== 1 || result.plugin_version !== version || result.analysis_sha256 !== analysisSha256) {
    const detail = value => typeof value === 'string' ? value.slice(0, 2000) : null
    throw new ExperimentError('PLUGIN_RESPONSE_INVALID', 'plugin artifacts do not match the analysis or supported API version', {
      pluginMessage: detail(result?.message), animationMessage: detail(result?.documents?.animation?.message),
      setupMessage: detail(result?.documents?.setup?.message),
    })
  }
  const documents = {}
  for (const name of ['animation', 'setup']) {
    const entry = result.documents?.[name]
    if (entry?.status === 'unavailable') { documents[name] = null; continue }
    if (entry?.status !== 'ready' || entry.mime !== 'text/html' || !Number.isSafeInteger(entry.bytes) || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new ExperimentError('PLUGIN_RESPONSE_INVALID', 'invalid document metadata')
    const bytes = await readPluginFile(directory, entry.path, MAX_DOCUMENT)
    if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256) throw new ExperimentError('PLUGIN_RESPONSE_INVALID', 'document checksum mismatch')
    documents[name] = bytes
  }
  if (!Array.isArray(result.attachments) || result.attachments.length > 64) throw new ExperimentError('PLUGIN_RESPONSE_INVALID', 'invalid attachment list')
  const files = []
  let total = 0
  const names = new Set()
  for (const entry of result.attachments) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry?.name) || names.has(entry.name) || !['image/png', 'text/csv', 'application/json'].includes(entry.mime)
      || !Number.isSafeInteger(entry.bytes) || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new ExperimentError('PLUGIN_RESPONSE_INVALID', 'invalid attachment metadata')
    names.add(entry.name)
    const bytes = await readPluginFile(directory, entry.path, 32 * 1024 * 1024)
    total += bytes.length
    if (total > 128 * 1024 * 1024 || bytes.length !== entry.bytes || digest(bytes) !== entry.sha256) throw new ExperimentError('PLUGIN_RESPONSE_INVALID', 'attachment checksum or size mismatch')
    files.push({ name: entry.name, mime: entry.mime, bytes })
  }
  return { ...documents, files }
}
