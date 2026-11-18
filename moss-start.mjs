import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadEnvFile } from 'node:process'
import { ExperimentStore } from './internal/experiment/index.mjs'
import { ensurePluginRuntime } from './scripts/labscriptai-runtime.mjs'

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
const runtime = await ensurePluginRuntime(project)
console.error(`LabscriptAI OT ${runtime.version} (${runtime.revision}), artifact API ${runtime.artifact_api}`)
let modelPatch = readFileSync(resolve(root, 'moss-model.patch.yml'), 'utf8')
for (const file of ['internal/chat-tools.mjs', 'internal/experiment/robot-tools.mjs']) {
  const name = `name: './${file}'`
  if (!modelPatch.includes(name)) throw new Error(`moss-model.patch.yml 缺少 ${file} 插件配置`)
  modelPatch = modelPatch.replace(name, `name: ${JSON.stringify(pathToFileURL(resolve(root, file)).href)}`)
}
const patchPath = resolve(root, `.moss-model-${randomUUID()}.patch.yml`)
const cleanup = () => rmSync(patchPath, { force: true })
writeFileSync(patchPath, modelPatch, { mode: 0o600, flag: 'wx' })
const child = spawn(process.execPath, [
  '--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'web',
  '--patch', patchPath, ...process.argv.slice(2),
], { cwd: root, env: { ...process.env, DSH_HOME: dataDir, MOSS_EXPERIMENT_DB: experimentDb, MOSS_PLUGIN_ROOT: runtime.root, MOSS_PLUGIN_DATA: runtime.data, LABSCRIPTAI_HOME: runtime.dependencyHome, MOSS_PLUGIN_VERSION: runtime.version, MOSS_PREVIEW_TMP: previewDir }, stdio: 'inherit' })
process.on('exit', cleanup)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('error', error => { console.error('网页启动失败:', error.message); process.exitCode = 1 })
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })
