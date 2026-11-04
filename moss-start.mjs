import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadEnvFile } from 'node:process'
import { ExperimentStore } from './internal/experiment/index.mjs'
import { mossPythonEnvironment } from './internal/moss-python-env.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const project = root
const envPath = resolve(project, '.env')
if (!existsSync(envPath)) throw new Error('缺少项目根目录的 .env 配置')
loadEnvFile(envPath)
for (const key of ['AI_API_KEY', 'AI_API_URL', 'AI_MODEL']) {
  if (!process.env[key]) throw new Error(`.env 缺少 ${key}`)
}
const apiUrl = new URL(process.env.AI_API_URL)
if (apiUrl.protocol !== 'https:' || !apiUrl.pathname.endsWith('/chat/completions')) {
  throw new Error('AI_API_URL 应为 HTTPS 的 chat/completions 地址')
}
const dataDir = resolve(project, '.dsh-local')
mkdirSync(dataDir, { recursive: true, mode: 0o700 })
const previewDir = resolve(dataDir, 'previews')
mkdirSync(previewDir, { recursive: true, mode: 0o700 })
const experimentDb = resolve(dataDir, 'experiments.sqlite')
if (!existsSync(experimentDb)) {
  const store = new ExperimentStore({ path: experimentDb, create: true })
  store.close()
}
const originalPatch = readFileSync(resolve(root, 'moss-model.patch.yml'), 'utf8')
const chatName = "name: './internal/chat-tools.mjs'"
if (!originalPatch.includes(chatName)) throw new Error('moss-model.patch.yml 缺少 chat 工具插件配置')
const patchPath = resolve(root, `.moss-model-${randomUUID()}.patch.yml`)
const cleanup = () => rmSync(patchPath, { force: true })
const chatUrl = pathToFileURL(resolve(root, 'internal/chat-tools.mjs')).href
writeFileSync(patchPath, originalPatch.replace(chatName, `name: ${JSON.stringify(chatUrl)}`), { mode: 0o600, flag: 'wx' })
const child = spawn(process.execPath, [
  '--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'web',
  '--patch', patchPath, ...process.argv.slice(2),
], { cwd: root, env: { ...mossPythonEnvironment(project, process.env), DSH_HOME: dataDir, MOSS_EXPERIMENT_DB: experimentDb, MOSS_FLEX_ROOT: resolve(project, 'labscriptai-ot/automation/flex3d'), MOSS_PREVIEW_TMP: previewDir }, stdio: 'inherit' })
process.on('exit', cleanup)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('error', error => { console.error('网页启动失败:', error.message); process.exitCode = 1 })
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })
