import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mossPythonEnvironment } from './moss-python-env.mjs'

const project = resolve(fileURLToPath(new URL('..', import.meta.url)))

test('web child Python and uv use the project environment', () => {
  const env = mossPythonEnvironment(project, { ...process.env, PYTHONHOME: '/wrong', PYTHONPATH: '/wrong' })
  assert.equal(env.PYTHONHOME, undefined)
  assert.equal(env.PYTHONPATH, undefined)
  assert.equal(env.VIRTUAL_ENV, resolve(project, 'labscriptai-ot/.venv'))
  const code = 'import sys, opentrons; print(sys.prefix); print(opentrons.__version__)'
  const otherProject = mkdtempSync(join(tmpdir(), 'moss-other-project-'))
  try {
    writeFileSync(join(otherProject, 'pyproject.toml'), '[project]\nname = "other-project"\nversion = "0.1.0"\n')
    for (const cwd of [project, otherProject]) {
      for (const command of [`python -c '${code}'`, `python3 -c '${code}'`, `uv run --active --no-project python -c '${code}'`]) {
        const result = spawnSync('/bin/bash', ['-c', command], { cwd, env, encoding: 'utf8' })
        assert.equal(result.status, 0, result.stderr)
        const [prefix, version] = result.stdout.trim().split('\n')
        assert.equal(prefix, env.VIRTUAL_ENV)
        assert.match(version, /^\d+\./)
      }
    }
  } finally { rmSync(otherProject, { recursive: true, force: true }) }
})

test('missing project virtual environment fails clearly', () => {
  assert.throws(() => mossPythonEnvironment('/nonexistent-moss-project', {}), /缺少项目 uv 虚拟环境/)
})
