import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/** Select the project's Python environment for the web process and its children. */
export function mossPythonEnvironment(project, inherited) {
  const virtualEnv = join(project, 'labscriptai-ot', '.venv')
  const bin = join(virtualEnv, 'bin')
  const python = join(bin, 'python')
  if (!existsSync(python)) throw new Error(`缺少项目 uv 虚拟环境：${python}`)
  const env = { ...inherited, VIRTUAL_ENV: virtualEnv, MOSS_PYTHON: python, PATH: [bin, inherited.PATH].filter(Boolean).join(delimiter) }
  // Inherited Python overrides can redirect even an activated virtual environment.
  delete env.PYTHONHOME
  delete env.PYTHONPATH
  return env
}
