import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ExperimentStore } from '../index.mjs'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'experiment-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return { dir, path: join(dir, 'experiments.sqlite') }
}

const initial = { requirement: 'transfer', parameters: { volume: 10 }, device: { pipette: 'test' }, protocol: 'print(1)' }
const isCode = code => error => error.code === code

test('creation is idempotent and revisions survive reopening and concurrent writers', t => {
  const { path } = fixture(t)
  const first = new ExperimentStore({ path, create: true })
  const second = new ExperimentStore({ path, create: false })
  const created = first.create({ creationKey: 'request-1', snapshot: initial })
  assert.equal(created.created, true)
  const id = created.experiment.id
  assert.deepEqual(second.create({ creationKey: 'request-1', snapshot: { protocol: 'print(1)', device: { pipette: 'test' }, parameters: { volume: 10 }, requirement: 'transfer' } }), { created: false, experiment: created.experiment })
  assert.throws(() => second.create({ creationKey: 'request-1', snapshot: { ...initial, requirement: 'different' } }), isCode('IDEMPOTENCY_CONFLICT'))
  const changed = first.update({ id, expectedRevision: 1, snapshot: { ...initial, parameters: { volume: 20 } } })
  assert.equal(changed.revision, 2)
  assert.throws(() => second.update({ id, expectedRevision: 1, snapshot: initial }), error => error.code === 'REVISION_CONFLICT' && error.details.currentRevision === 2)
  assert.deepEqual(second.get(id, 1).snapshot, initial)
  assert.equal(second.get(id).snapshot.parameters.volume, 20)
  assert.equal(second.create({ creationKey: 'request-1', snapshot: initial }).experiment.revision, 1)
  first.close()
  second.close()
  const reopened = new ExperimentStore({ path, create: false })
  assert.equal(reopened.get(id).revision, 2)
  assert.deepEqual(reopened.get(id, 1).snapshot, initial)
  reopened.close()
  const db = new DatabaseSync(path)
  assert.throws(() => db.prepare('UPDATE revisions SET snapshot_json = ? WHERE experiment_id = ? AND revision = 1').run('{}', id))
  assert.throws(() => db.prepare('DELETE FROM revisions WHERE experiment_id = ? AND revision = 1').run(id))
  db.close()
})

test('session operations isolate creation keys and enforce immutable ownership', t => {
  const { path } = fixture(t)
  const store = new ExperimentStore({ path, create: true })
  const peer = new ExperimentStore({ path, create: false })
  t.after(() => { store.close(); peer.close() })
  const input = { creationKey: 'same', snapshot: initial }
  const alice = store.createForSession('alice', input).experiment
  const bob = peer.createForSession('bob', input).experiment
  assert.notEqual(alice.id, bob.id)
  assert.deepEqual(peer.createForSession('alice', input), { created: false, experiment: alice })
  assert.throws(() => store.createForSession('alice', { ...input, snapshot: { ...initial, protocol: 'other' } }), isCode('IDEMPOTENCY_CONFLICT'))
  assert.throws(() => store.createForSession('alice', { ...input, snapshot: { ...initial, sessionId: 'bob' } }), isCode('SESSION_MISMATCH'))
  assert.throws(() => store.createForSession('', input), isCode('INVALID_INPUT'))
  const legacy = store.create({ creationKey: 'same', snapshot: initial }).experiment
  assert.throws(() => store.getForSession('alice', legacy.id), isCode('SESSION_MISMATCH'))
  assert.throws(() => store.updateForSession('alice', { id: legacy.id, expectedRevision: 1, snapshot: { ...initial, sessionId: 'alice' } }), isCode('SESSION_MISMATCH'))
  assert.throws(() => store.getForSession('bob', alice.id), isCode('SESSION_MISMATCH'))
  assert.throws(() => store.getChecksForSession('bob', alice.id, 1), isCode('SESSION_MISMATCH'))
  assert.throws(() => store.updateForSession('bob', { id: alice.id, expectedRevision: 1, snapshot: { ...initial, sessionId: 'bob' } }), isCode('SESSION_MISMATCH'))
  for (const snapshot of [initial, { ...initial, sessionId: 'bob' }, { ...initial, sessionId: null }]) {
    assert.throws(() => store.update({ id: alice.id, expectedRevision: 1, snapshot }), isCode('SESSION_MISMATCH'))
    assert.throws(() => store.updateForSession('alice', { id: alice.id, expectedRevision: 1, snapshot }), isCode('SESSION_MISMATCH'))
  }
  const task = store.startCheck({ id: alice.id, revision: 1, protocolHash: alice.protocolHash, name: 'test' })
  store.finishCheck({ ...task, status: 'passed', result: {} })
  assert.equal(store.getChecksForSession('alice', alice.id, 1)[0].status, 'passed')
  assert.equal(store.updateForSession('alice', { id: alice.id, expectedRevision: 1, snapshot: { ...initial, sessionId: 'alice', protocol: 'new' } }).revision, 2)
  assert.throws(() => peer.updateForSession('alice', { id: alice.id, expectedRevision: 1, snapshot: { ...initial, sessionId: 'alice' } }), isCode('REVISION_CONFLICT'))
  assert.equal(peer.getForSession('alice', alice.id, 1).revision, 1)
  assert.equal(peer.getForSession('alice', alice.id).revision, 2)
  assert.throws(() => peer.getChecksForSession('alice', legacy.id, 1), isCode('SESSION_MISMATCH'))
  const reopened = new ExperimentStore({ path, create: false })
  try {
    assert.deepEqual(reopened.createForSession('alice', input), { created: false, experiment: alice })
  } finally {
    reopened.close()
  }
})

test('latestForSession returns the most recently created experiment of a session', t => {
  const { path } = fixture(t)
  const store = new ExperimentStore({ path, create: true })
  t.after(() => store.close())
  const first = store.createForSession('alice', { creationKey: 'one', snapshot: initial }).experiment
  const second = store.createForSession('alice', { creationKey: 'two', snapshot: initial }).experiment
  const third = store.createForSession('bob', { creationKey: 'one', snapshot: initial }).experiment
  store.updateForSession('alice', { id: second.id, expectedRevision: 1, snapshot: { ...initial, sessionId: 'alice', protocol: 'new' } })
  assert.equal(store.latestForSession('alice').id, second.id)
  assert.equal(store.latestForSession('alice').revision, 2)
  assert.equal(store.latestForSession('bob').id, third.id)
  assert.equal(store.latestForSession('carol'), null)
  assert.throws(() => store.latestForSession(''), isCode('INVALID_INPUT'))
})

test('schema 1 databases migrate and reject historically changed ownership', t => {
  const { path } = fixture(t)
  const store = new ExperimentStore({ path, create: true })
  const bound = store.create({ creationKey: 'old', snapshot: { ...initial, sessionId: 'alice' } }).experiment
  store.close()
  const db = new DatabaseSync(path)
  db.exec('DROP TABLE session_creation_keys; PRAGMA user_version = 1')
  db.prepare('INSERT INTO revisions VALUES (?, 2, ?, ?, ?)').run(bound.id, JSON.stringify({ ...initial, sessionId: 'bob' }), bound.protocolHash, new Date().toISOString())
  db.prepare('UPDATE experiments SET current_revision = 2 WHERE id = ?').run(bound.id)
  db.close()
  const reopened = new ExperimentStore({ path, create: false })
  t.after(() => reopened.close())
  assert.equal(reopened.getForSession('alice', bound.id, 1).id, bound.id)
  assert.throws(() => reopened.getForSession('alice', bound.id), isCode('SESSION_MISMATCH'))
  assert.throws(() => reopened.getForSession('bob', bound.id), isCode('SESSION_MISMATCH'))
  assert.throws(() => reopened.getChecksForSession('alice', bound.id, 2), isCode('SESSION_MISMATCH'))
  assert.throws(() => reopened.updateForSession('alice', { id: bound.id, expectedRevision: 2, snapshot: { ...initial, sessionId: 'alice' } }), isCode('SESSION_MISMATCH'))
  const created = reopened.createForSession('alice', { creationKey: 'old', snapshot: initial })
  assert.notEqual(created.experiment.id, bound.id)
  assert.equal(reopened.db.prepare('PRAGMA user_version').get().user_version, 2)
})

test('checks bind revision and protocol hash, rejecting late and superseded results', t => {
  const { path } = fixture(t)
  const store = new ExperimentStore({ path, create: true })
  t.after(() => store.close())
  const one = store.create({ creationKey: 'one', snapshot: initial }).experiment
  const other = store.create({ creationKey: 'two', snapshot: initial }).experiment
  const request = { id: one.id, revision: 1, protocolHash: one.protocolHash, name: 'simulation' }
  assert.throws(() => store.startCheck({ ...request, protocolHash: 'wrong' }), isCode('PROTOCOL_MISMATCH'))
  const old = store.startCheck(request)
  const active = store.startCheck(request)
  assert.throws(() => store.finishCheck({ ...old, status: 'passed', result: {} }), isCode('STALE_TASK'))
  store.finishCheck({ ...active, status: 'failed', result: { log: 'bad' } })
  assert.throws(() => store.finishCheck({ ...active, status: 'passed', result: {} }), isCode('STALE_TASK'))
  assert.deepEqual(store.getChecks(one.id, 1).map(check => check.status), ['superseded', 'failed'])
  assert.deepEqual(store.getChecks(other.id, 1), [])
  const late = store.startCheck(request)
  const two = store.update({ id: one.id, expectedRevision: 1, snapshot: { ...initial, device: { pipette: 'new' } } })
  assert.equal(two.protocolHash, one.protocolHash)
  assert.throws(() => store.finishCheck({ ...late, status: 'passed', result: {} }), isCode('STALE_TASK'))
  assert.deepEqual(store.getChecks(one.id, 2), [])
  const newTask = store.startCheck({ ...request, revision: 2 })
  assert.throws(() => store.finishCheck({ ...newTask, protocolHash: 'wrong', status: 'passed', result: {} }), isCode('PROTOCOL_MISMATCH'))
  store.finishCheck({ ...newTask, status: 'blocked', result: { reason: 'tool unavailable' } })
  assert.equal(store.getChecks(one.id, 2)[0].status, 'blocked')
  const three = store.update({ id: one.id, expectedRevision: 2, snapshot: { ...initial, protocol: null } })
  assert.throws(() => store.startCheck({ ...request, revision: 3 }), isCode('PROTOCOL_MISMATCH'))
  assert.equal(three.protocolHash, null)
})

test('explicit storage selection fails on missing, replaced, malformed, or unsupported database', t => {
  const { dir, path } = fixture(t)
  assert.throws(() => new ExperimentStore({ path: 'relative', create: true }), isCode('INVALID_INPUT'))
  assert.throws(() => new ExperimentStore({ path, create: false }), isCode('STORAGE_UNAVAILABLE'))
  const store = new ExperimentStore({ path, create: true })
  assert.throws(() => new ExperimentStore({ path, create: true }), error => error.code === 'EEXIST')
  const exp = store.create({ creationKey: 'key', snapshot: initial }).experiment
  renameSync(path, join(dir, 'moved.sqlite'))
  assert.throws(() => store.update({ id: exp.id, expectedRevision: 1, snapshot: initial }), isCode('STORAGE_UNAVAILABLE'))
  assert.throws(() => store.get(exp.id), isCode('STORAGE_UNAVAILABLE'))
  renameSync(join(dir, 'moved.sqlite'), path)
  assert.throws(() => store.get(exp.id), isCode('STORAGE_UNAVAILABLE'))
  store.close()
  const recovered = new ExperimentStore({ path, create: false })
  assert.equal(recovered.get(exp.id).revision, 1)
  recovered.close()
  const malformed = join(dir, 'malformed.sqlite')
  writeFileSync(malformed, 'not a sqlite database')
  assert.throws(() => new ExperimentStore({ path: malformed, create: false }))
  const future = join(dir, 'future.sqlite')
  const db = new DatabaseSync(future)
  db.exec('PRAGMA user_version = 99')
  db.close()
  assert.throws(() => new ExperimentStore({ path: future, create: false }), isCode('SCHEMA_ERROR'))
})

test('online backups include WAL data and retain only this source’s backups', async t => {
  const { dir, path } = fixture(t)
  const destination = join(dir, 'backups')
  mkdirSync(destination)
  const store = new ExperimentStore({ path, create: true })
  t.after(() => store.close())
  store.db.exec('PRAGMA journal_mode = WAL')
  const experiment = store.create({ creationKey: 'one', snapshot: initial }).experiment
  const first = await store.backup({ directory: destination, retain: 2 })
  store.update({ id: experiment.id, expectedRevision: 1, snapshot: { ...initial, protocol: 'updated' } })
  const second = await store.backup({ directory: destination, retain: 2 })
  const other = new ExperimentStore({ path: join(dir, 'other.sqlite'), create: true })
  t.after(() => other.close())
  const otherBackup = await other.backup({ directory: destination, retain: 1 })
  const unrelated = join(destination, 'other.sqlite')
  writeFileSync(unrelated, 'keep')
  const third = await store.backup({ directory: destination, retain: 2 })
  assert.equal(existsSync(first), false)
  assert.equal(existsSync(second), true)
  assert.equal(existsSync(third), true)
  assert.equal(existsSync(otherBackup), true)
  assert.equal(existsSync(unrelated), true)
  const restored = new ExperimentStore({ path: third, create: false })
  t.after(() => restored.close())
  assert.equal(restored.get(experiment.id).snapshot.protocol, 'updated')
  assert.equal(restored.get(experiment.id, 1).snapshot.protocol, initial.protocol)
})

test('backup rejects invalid destinations and source loss without pruning', async t => {
  const { dir, path } = fixture(t)
  const destination = join(dir, 'backups')
  mkdirSync(destination)
  const store = new ExperimentStore({ path, create: true })
  t.after(() => store.close())
  await assert.rejects(store.backup({ directory: 'relative', retain: 1 }), isCode('INVALID_INPUT'))
  await assert.rejects(store.backup({ directory: destination, retain: 0 }), isCode('INVALID_INPUT'))
  await assert.rejects(store.backup({ directory: join(dir, 'missing'), retain: 1 }))
  const previous = await store.backup({ directory: destination, retain: 1 })
  renameSync(path, join(dir, 'moved.sqlite'))
  await assert.rejects(store.backup({ directory: destination, retain: 1 }), isCode('STORAGE_UNAVAILABLE'))
  assert.deepEqual(readdirSync(destination), [basename(previous)])
})

test('backup holds the store open and releases it after success or failure', async t => {
  const { dir, path } = fixture(t)
  const destination = join(dir, 'backups')
  mkdirSync(destination)
  const store = new ExperimentStore({ path, create: true })
  const pending = store.backup({ directory: destination, retain: 1 })
  assert.throws(() => store.close(), isCode('BACKUP_IN_PROGRESS'))
  await assert.rejects(store.backup({ directory: destination, retain: 1 }), error => error.code === 'EEXIST')
  await pending
  const failing = store.backup({ directory: destination, retain: 1 })
  renameSync(path, join(dir, 'moved.sqlite'))
  await assert.rejects(failing, isCode('STORAGE_UNAVAILABLE'))
  store.close()
})

test('retention never follows matching symlinks', async t => {
  const { dir, path } = fixture(t)
  const destination = join(dir, 'backups')
  mkdirSync(destination)
  const store = new ExperimentStore({ path, create: true })
  t.after(() => store.close())
  const first = await store.backup({ directory: destination, retain: 1 })
  const moved = join(dir, 'protected.sqlite')
  renameSync(first, moved)
  try {
    symlinkSync(moved, first)
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('symlink creation requires privileges')
    throw error
  }
  await store.backup({ directory: destination, retain: 1 })
  assert.equal(existsSync(moved), true)
  assert.equal(existsSync(first), true)
})

test('rejects lossy snapshots and invalid expected revisions', t => {
  const { path } = fixture(t)
  const store = new ExperimentStore({ path, create: true })
  t.after(() => store.close())
  assert.throws(() => store.create({ creationKey: 'a', snapshot: { protocol: 'x', parameter: undefined } }), isCode('INVALID_INPUT'))
  assert.throws(() => store.create({ creationKey: 'a', snapshot: { protocol: 'x', parameter: NaN } }), isCode('INVALID_INPUT'))
  const { id } = store.create({ creationKey: 'a', snapshot: initial }).experiment
  assert.throws(() => store.update({ id, snapshot: initial }), isCode('INVALID_INPUT'))
  assert.equal(store.get(id).revision, 1)
})
