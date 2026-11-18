/** Checksum-pinned external plugin installation; downloaded source is never maintained by MOSS. */
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import extractZip from 'extract-zip'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const MAX_ARCHIVE = 256 * 1024 * 1024

/** Validate the on-disk version lock before network or filesystem effects.
 * @param {unknown} value Parsed lock file.
 * @returns {object} Validated lock.
 */
export function validateLock(value) {
  if (!value || value.schema !== 1 || value.artifact_api !== 1 || !/^\d+\.\d+\.\d+$/.test(value.version)
    || !/^[a-f0-9]{64}$/.test(value.sha256) || !['source', 'release'].includes(value.kind)
    || !/^(?:[a-f0-9]{40}|v\d+\.\d+\.\d+)$/.test(value.revision)) throw new Error('Invalid LabscriptAI version lock')
  const url = new URL(value.url)
  const source = `https://codeload.github.com/KRATSZ/labscriptai-ot/zip/${value.revision}`
  const release = `https://github.com/KRATSZ/labscriptai-ot/releases/download/${value.revision}/labscriptai-ot-${value.version}.zip`
  if (value.url !== (value.kind === 'source' ? source : release) || url.protocol !== 'https:') throw new Error('Untrusted LabscriptAI archive URL')
  if (value.kind === 'source' && !/^[a-f0-9]{40}$/.test(value.revision)) throw new Error('Source version must pin an exact commit')
  if (value.kind === 'release' && value.revision !== `v${value.version}`) throw new Error('Release version mismatch')
  return value
}

/** Read a bounded network response, including responses without Content-Length.
 * @param {Response} response Network response.
 * @param {number} limit Byte limit.
 * @returns {Promise<Buffer>} Response bytes.
 */
export async function boundedResponse(response, limit) {
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`)
  const reader = response.body.getReader()
  const chunks = []
  let length = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > limit) throw new Error('Download exceeds size limit')
      chunks.push(chunk.value)
    }
    return Buffer.concat(chunks)
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
}

/** Extract only regular files below the archive's single root; reject links and oversized archives.
 * @param {string} archive Verified ZIP path.
 * @param {string} target Empty extraction directory.
 * @returns {Promise<void>} Completion after all streams close.
 */
export async function extractPlugin(archive, target) {
  const unpack = await mkdtemp(join(target, 'unpack-'))
  let root
  let total = 0
  let count = 0
  try {
    await extractZip(archive, { dir: unpack, onEntry(entry) {
      const parts = entry.fileName.split('/')
      root ??= parts[0]
      const mode = (entry.externalFileAttributes >>> 16) & 0o170000
      if (parts[0] !== root || !root || parts.some(part => part === '..' || part === '.')
        || entry.fileName.includes('\\') || entry.fileName.startsWith('/') || entry.fileName.includes(':')
        || (mode && mode !== 0o100000 && mode !== 0o040000) || entry.isEncrypted()) throw new Error('Unsafe plugin archive entry')
      if (++count > 12000 || (total += entry.uncompressedSize) > 512 * 1024 * 1024 || entry.uncompressedSize > 64 * 1024 * 1024) throw new Error('Plugin archive exceeds limits')
    } })
    if (!root) throw new Error('Empty plugin archive')
    for (const name of await readdir(join(unpack, root))) await rename(join(unpack, root, name), join(target, name))
  } finally {
    await rm(unpack, { recursive: true, force: true })
  }
}

/** Run the plugin-owned dependency installer without forwarding model credentials.
 * @param {string} root External plugin root.
 * @param {string} dependencyHome Plugin-managed dependency cache.
 * @returns {Promise<void>} Successful plugin installer exit.
 */
export async function installDependencies(root, dependencyHome) {
  const env = Object.fromEntries(['PATH', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'SystemRoot', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'].filter(key => process.env[key]).map(key => [key, process.env[key]]))
  await new Promise((accept, reject) => {
    const child = spawn(process.execPath, [join(root, 'scripts/install-runtime.mjs')], {
      cwd: root, env: { ...env, LABSCRIPTAI_HOME: dependencyHome, PLUGIN_DATA: join(dependencyHome, 'data') }, stdio: 'inherit', timeout: 1800000,
    })
    child.once('error', reject)
    child.once('close', (code, signal) => code === 0 ? accept() : reject(new Error(`Plugin installer failed (${code ?? signal})`)))
  })
}

/** Resolve one immutable runtime for this process; failed installs cannot replace an installed version.
 * @param {string} project MOSS project directory.
 * @param {object} options Development root, persistent data/cache directories, network provider and installer.
 * @returns {Promise<object>} Runtime paths and pinned identity.
 */
export async function ensurePluginRuntime(project, { dataHome = project, cacheHome = join(dataHome, '.dsh-local/plugins'), override = process.env.LABSCRIPTAI_OT_ROOT, fetcher = fetch, installer = installDependencies } = {}) {
  const lock = validateLock(JSON.parse(await readFile(join(project, 'labscriptai-ot.lock.json'), 'utf8')))
  const managed = cacheHome
  const dependencyHome = join(managed, 'dependencies')
  const target = join(managed, lock.sha256)
  let root = override ? await realpath(override) : target
  await mkdir(managed, { recursive: true, mode: 0o700 })
  if (!override) {
    let installed = false
    try { installed = JSON.parse(await readFile(join(target, '.moss-install.json'), 'utf8')).sha256 === lock.sha256 } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (!installed) {
      const stage = join(managed, `install-${randomUUID()}`)
      const archive = `${stage}.zip`
      await mkdir(stage, { mode: 0o700 })
      try {
        const bytes = await boundedResponse(await fetcher(lock.url, { signal: AbortSignal.timeout(180000) }), MAX_ARCHIVE)
        if (sha256(bytes) !== lock.sha256) throw new Error('LabscriptAI archive checksum mismatch; existing runtime retained')
        await writeFile(archive, bytes, { mode: 0o600, flag: 'wx' })
        await extractPlugin(archive, stage)
        const version = JSON.parse(await readFile(join(stage, '.codex-plugin/plugin.json'), 'utf8')).version
        if (version !== lock.version) throw new Error('LabscriptAI package version mismatch')
        await writeFile(join(stage, '.moss-install.json'), JSON.stringify(lock) + '\n', { flag: 'wx', mode: 0o600 })
        try { await rename(stage, target) } catch (error) {
          if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error
          if (JSON.parse(await readFile(join(target, '.moss-install.json'), 'utf8')).sha256 !== lock.sha256) throw error
        }
      } finally {
        await rm(stage, { recursive: true, force: true })
        await rm(archive, { force: true })
      }
    }
  }
  root = await realpath(root)
  await stat(join(root, 'servers/opentrons-mcp/index.js'))
  await installer(root, dependencyHome)
  const data = join(managed, 'data', override ? 'development' : lock.sha256)
  await mkdir(data, { recursive: true, mode: 0o700 })
  return { root, data: await realpath(data), dependencyHome, version: override ? JSON.parse(await readFile(join(root, '.codex-plugin/plugin.json'), 'utf8')).version : lock.version, revision: override ? 'development' : lock.revision, artifact_api: lock.artifact_api }
}
