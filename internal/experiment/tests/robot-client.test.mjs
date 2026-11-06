import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRobotClient, RobotError } from '../robot-client.mjs'
import { healthyRobot, startFakeRobot } from './fake-robot.mjs'

const config = url => ({ url, timeoutMs: 2000, maxBytes: 65536, maxProtocolBytes: 65536 })
const protocol = 'metadata = {}\n\ndef run(protocol):\n    pass\n'

test('projects health, instruments, door, and emergency stop without credentials', async () => {
  const robot = await startFakeRobot(healthyRobot())
  try {
    const client = createRobotClient(config(robot.url))
    const status = await client.status()
    assert.deepEqual(status.health, { available: true, name: 'FakeBot', model: 'OT-3 Standard', apiVersion: '9.0.0', systemVersion: 'v0.0.1' })
    assert.deepEqual(status.instruments, [{ mount: 'left', name: 'p1000_single_v3.6' }, { mount: 'right', name: 'p1000_multi_v3.5' }])
    assert.deepEqual(status.door, { status: 'closed', requiredClosedForProtocol: true })
    assert.deepEqual(status.estop, { status: 'disengaged' })
    assert.ok(robot.requests.every(request => request.headers['opentrons-version'] === '4'))
  } finally { await robot.close() }
})

test('uploads a protocol with the files field, creates a run, plays it, and reads it back', async () => {
  const robot = await startFakeRobot(request => {
    if (request.method === 'POST' && request.path === '/protocols') return { status: 201, body: { data: { id: 'protocol-1' } } }
    if (request.method === 'POST' && request.path === '/runs') return { status: 201, body: { data: { id: 'run-1' } } }
    if (request.method === 'POST' && request.path === '/runs/run-1/actions') return { status: 201, body: { data: { id: 'action-1', actionType: 'play' } } }
    if (request.method === 'GET' && request.path === '/runs/run-1') return { body: { data: { id: 'run-1', status: 'running', current: true, errors: [] } } }
    if (request.method === 'GET' && request.path === '/runs/run-1/commands') return { body: { data: [{ id: 'c1', commandType: 'home', status: 'succeeded' }] } }
    return healthyRobot()({ method: request.method, path: request.path, query: new URLSearchParams(), headers: request.headers, body: request.body })
  })
  try {
    const client = createRobotClient(config(robot.url))
    const uploaded = await client.uploadProtocol(protocol, 'exp.py')
    assert.equal(uploaded.protocolId, 'protocol-1')
    const upload = robot.requests.find(request => request.path === '/protocols')
    const uploadText = upload.body.toString('utf8')
    assert.match(uploadText, /name="files"/)
    assert.match(uploadText, /filename="exp.py"/)
    assert.match(uploadText, /metadata = \{\}/)

    const created = await client.createRun(uploaded.protocolId)
    assert.equal(created.runId, 'run-1')
    const runRequest = robot.requests.find(request => request.path === '/runs' && request.method === 'POST')
    assert.deepEqual(JSON.parse(runRequest.body.toString('utf8')), { data: { protocolId: 'protocol-1' } })

    assert.deepEqual(await client.runAction(created.runId, 'play'), { action: 'play', accepted: true })
    const actionRequest = robot.requests.find(request => request.path === '/runs/run-1/actions')
    assert.deepEqual(JSON.parse(actionRequest.body.toString('utf8')), { data: { actionType: 'play' } })

    const run = await client.getRun(created.runId)
    assert.equal(run.runId, 'run-1')
    assert.equal(run.status, 'running')
    assert.ok(run.current)
    assert.deepEqual(await client.getCommands(created.runId), [{ id: 'c1', commandType: 'home', status: 'succeeded', error: null }])
  } finally { await robot.close() }
})

test('rejects unsupported actions and invalid run ids before requesting the robot', async () => {
  const robot = await startFakeRobot(healthyRobot())
  try {
    const client = createRobotClient(config(robot.url))
    await assert.rejects(client.runAction('run-1', 'explode'), error => error instanceof RobotError && error.code === 'RUN_ACTION_INVALID')
    await assert.rejects(client.getRun(''), error => error instanceof RobotError && error.code === 'RUN_ID_REQUIRED')
    assert.equal(robot.requests.length, 0)
  } finally { await robot.close() }
})

test('bounds failures and never repeats the configured URL', async () => {
  const robot = await startFakeRobot(() => ({ status: 500, body: { error: 'denied' } }))
  try {
    const client = createRobotClient(config(robot.url))
    await assert.rejects(client.uploadProtocol(protocol, 'exp.py'), error => {
      assert.ok(error instanceof RobotError)
      assert.equal(error.code, 'ROBOT_HTTP_ERROR')
      assert.match(error.message, /HTTP 500/)
      assert.ok(!error.message.includes(robot.url))
      return true
    })
  } finally { await robot.close() }
})

test('enforces the timeout and response size limits', async () => {
  const slow = await startFakeRobot(request => new Promise(resolve => setTimeout(() => resolve({ body: { data: { id: 'run-1' } } }), 300)))
  try {
    const client = createRobotClient({ ...config(slow.url), timeoutMs: 30 })
    await assert.rejects(client.uploadProtocol(protocol, 'exp.py'), error => error instanceof RobotError && error.code === 'ROBOT_TIMEOUT')
  } finally { await slow.close() }
  const large = await startFakeRobot(request => ({ body: { data: [{ mount: 'left', instrumentModel: 'x'.repeat(2000) }] } }))
  try {
    const client = createRobotClient({ ...config(large.url), maxBytes: 256 })
    const status = await client.status()
    assert.equal(status.health.available, false)
    assert.match(status.health.reason, /size limit/)
  } finally { await large.close() }
})

test('sends credentials from the configured URL as basic auth and strips them', async () => {
  let authorization = null
  const robot = await startFakeRobot(request => {
    authorization = request.headers.authorization ?? authorization
    return healthyRobot()({ method: request.method, path: request.path, query: request.query, headers: request.headers, body: request.body })
  })
  try {
    const withCredentials = new URL(robot.url)
    withCredentials.username = 'operator'
    withCredentials.password = 'secret'
    const client = createRobotClient(config(withCredentials.toString()))
    await client.status()
    assert.equal(authorization, `Basic ${Buffer.from('operator:secret').toString('base64')}`)
    assert.equal(client.base.includes('operator'), false)
    assert.equal(client.base.includes('secret'), false)
    assert.ok(robot.requests.every(request => !String(request.headers.authorization ?? '').includes('secret')))
  } finally { await robot.close() }
})

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])

test('reads camera state and captures a preview image as raw bytes', async () => {
  const robot = await startFakeRobot(request => {
    if (request.method === 'GET' && request.path === '/camera') return { body: { cameraEnabled: true, liveStreamEnabled: false, errorRecoveryCameraEnabled: true } }
    if (request.method === 'POST' && request.path === '/camera/capturePreviewImage') return { body: JPEG, headers: { 'Content-Type': 'image/jpeg' } }
    return healthyRobot()(request)
  })
  try {
    const client = createRobotClient(config(robot.url))
    assert.deepEqual(await client.cameraStatus(), { cameraEnabled: true, liveStreamEnabled: false, errorRecoveryCameraEnabled: true })
    const image = await client.capturePreviewImage()
    assert.equal(image.contentType, 'image/jpeg')
    assert.deepEqual(image.data, JPEG)
    const captureRequest = robot.requests.find(request => request.path === '/camera/capturePreviewImage')
    assert.equal(captureRequest.method, 'POST')
    assert.deepEqual(JSON.parse(captureRequest.body.toString('utf8')), { data: {} })
    assert.equal(captureRequest.headers['opentrons-version'], '4')
  } finally { await robot.close() }
})

test('rejects camera responses that are not encoded images', async () => {
  const notAnImage = await startFakeRobot(() => ({ body: '<html>not a camera</html>', headers: { 'Content-Type': 'text/html' } }))
  try {
    const client = createRobotClient(config(notAnImage.url))
    await assert.rejects(client.capturePreviewImage(), error => error instanceof RobotError && error.code === 'CAMERA_UNSUPPORTED_IMAGE')
  } finally { await notAnImage.close() }
  const truncated = await startFakeRobot(() => ({ body: Buffer.from('<html>'), headers: { 'Content-Type': 'image/jpeg' } }))
  try {
    const client = createRobotClient(config(truncated.url))
    await assert.rejects(client.capturePreviewImage(), error => error instanceof RobotError && error.code === 'CAMERA_INVALID_IMAGE')
  } finally { await truncated.close() }
})

test('reports an active run blocking preview capture with a stable code', async () => {
  const robot = await startFakeRobot(() => ({ status: 422, body: { message: 'Cannot capture preview photo, run is active.', errorCode: '4000' } }))
  try {
    const client = createRobotClient(config(robot.url))
    await assert.rejects(client.capturePreviewImage(), error => {
      assert.ok(error instanceof RobotError)
      assert.equal(error.code, 'CAMERA_RUN_ACTIVE')
      assert.match(error.message, /active run/)
      return true
    })
  } finally { await robot.close() }
})
