import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '../../../vendor/cordis/src/index.ts'
import * as plugin from '../vision-plugin.mjs'
import { startFakeRobot } from './fake-robot.mjs'

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])

function cameraRobot() {
  return startFakeRobot(request => {
    if (request.method === 'GET' && request.path === '/camera') return { body: { cameraEnabled: true, liveStreamEnabled: true, errorRecoveryCameraEnabled: true } }
    if (request.method === 'POST' && request.path === '/camera/capturePreviewImage') return { body: JPEG, headers: { 'Content-Type': 'image/jpeg' } }
    return { status: 404, body: { error: 'not found' } }
  })
}

async function setup(url) {
  const directory = await mkdtemp(join(tmpdir(), 'moss-vision-plugin-'))
  const script = join(directory, 'vision_check.py')
  const weights = join(directory, 'deck_v2_best.pt')
  await writeFile(script, '')
  await writeFile(weights, '')
  const ctx = new Context()
  let route
  ctx.provide('connection', { fetch: { register(value) { route = value; return () => { route = undefined } } } })
  const fiber = ctx.plugin(plugin, {
    url,
    python: process.execPath,
    script,
    weights,
    captureRoot: join(directory, 'captures'),
    calibrationPath: '',
    timeoutMs: 2000,
    maxImageBytes: 1024 * 1024,
    analyzeTimeoutMs: 2000,
  })
  await fiber.await()
  return {
    ctx,
    fiber,
    route: () => route,
    async close() {
      await fiber.dispose()
      await ctx.fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

test('registers the camera route and serves a captured photo', async () => {
  const robot = await cameraRobot()
  const instance = await setup(robot.url)
  try {
    const route = instance.route()
    assert.equal(route.path, '/api/robot-camera')
    assert.deepEqual(route.methods, ['GET'])
    assert.equal(route.requestBody, 'buffered')
    const photo = await instance.ctx.experimentVision.capture()
    assert.equal(photo.contentType, 'image/jpeg')
    const response = await route.fetch(new Request(`http://localhost${photo.imageUrl}`))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'image/jpeg')
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), JPEG)
  } finally {
    await instance.close()
    await robot.close()
  }
})

test('keeps the route mounted but reports an unconfigured robot', async () => {
  const instance = await setup('')
  try {
    assert.equal(instance.route().path, '/api/robot-camera')
    await assert.rejects(instance.ctx.experimentVision.capture(), error => error.code === 'ROBOT_NOT_CONFIGURED')
  } finally { await instance.close() }
})

test('rejects incomplete configuration and missing vision files', async () => {
  const empty = {}
  assert.throws(() => plugin.apply(empty, undefined), /robot-vision requires/)
  const base = { url: '', python: process.execPath, script: 'x.py', weights: 'x.pt', captureRoot: 'x', calibrationPath: '', timeoutMs: 1, maxImageBytes: 1, analyzeTimeoutMs: 1 }
  for (const key of ['python', 'script', 'weights', 'captureRoot']) {
    assert.throws(() => plugin.apply(empty, { ...base, [key]: '' }), /robot-vision requires/)
  }
  for (const key of ['timeoutMs', 'maxImageBytes', 'analyzeTimeoutMs']) {
    assert.throws(() => plugin.apply(empty, { ...base, [key]: 0 }), /robot-vision requires/)
  }
  assert.throws(() => plugin.apply(empty, base), /vision script not found/)
  const directory = await mkdtemp(join(tmpdir(), 'moss-vision-config-'))
  try {
    const script = join(directory, 'vision_check.py')
    await writeFile(script, '')
    assert.throws(() => plugin.apply(empty, { ...base, script }), /weights not found/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
