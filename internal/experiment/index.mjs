import { backup, DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, realpathSync, rmSync, rmdirSync, statSync, unlinkSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'

const SCHEMA_VERSION = 2
const CHECK_STATUSES = new Set(['passed', 'failed', 'error', 'blocked'])

/** An expected experiment-domain failure with a stable code and optional details. */
export class ExperimentError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'ExperimentError'
    this.code = code
    this.details = details
  }
}

function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new ExperimentError('INVALID_INPUT', `${name} must be a non-empty string`)
}

function revisionNumber(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new ExperimentError('INVALID_INPUT', 'revision must be a positive safe integer')
}

// Canonical JSON makes idempotency insensitive to object key order and rejects lossy input.
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${Array.from({ length: value.length }, (_, index) => canonical(value[index])).join(',')}]`
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  throw new ExperimentError('INVALID_INPUT', 'data must contain only JSON values')
}

function snapshot(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ExperimentError('INVALID_INPUT', 'snapshot must be a JSON object')
  if (data.protocol !== null && typeof data.protocol !== 'string') throw new ExperimentError('INVALID_INPUT', 'snapshot.protocol must be a string or null')
  const json = canonical(data)
  const protocolHash = data.protocol === null ? null : createHash('sha256').update(data.protocol, 'utf8').digest('hex')
  return { json, protocolHash }
}

/**
 * Owns one explicitly selected SQLite database. Close the instance when finished.
 * @param {{ path: string, create: boolean }} options Absolute database path and explicit creation mode.
 */
export class ExperimentStore {
  constructor({ path, create }) {
    if (typeof path !== 'string' || !isAbsolute(path) || typeof create !== 'boolean') throw new ExperimentError('INVALID_INPUT', 'an absolute path and explicit create flag are required')
    this.path = path
    this.directory = dirname(path)
    this.failure = null
    this.pendingBackups = 0
    if (create) closeSync(openSync(path, 'wx', 0o600))
    // Refuse SQLite's default create-on-open behavior when the configured file is absent.
    this.identity = this.storageIdentity()
    this.db = new DatabaseSync(path, { open: true, readOnly: false })
    try {
      this.assertStorage()
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000')
      const integrity = this.db.prepare('PRAGMA integrity_check').all()
      if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new ExperimentError('INTEGRITY_ERROR', 'SQLite integrity check failed', { results: integrity })
      const version = this.db.prepare('PRAGMA user_version').get().user_version
      if (create) {
        if (version !== 0) throw new ExperimentError('SCHEMA_ERROR', 'new database has an unexpected schema version')
        this.transaction(() => {
          this.db.exec(`
            CREATE TABLE experiments (id TEXT PRIMARY KEY, creation_key TEXT NOT NULL UNIQUE, initial_json TEXT NOT NULL, current_revision INTEGER NOT NULL);
            CREATE TABLE revisions (experiment_id TEXT NOT NULL REFERENCES experiments(id), revision INTEGER NOT NULL, snapshot_json TEXT NOT NULL, protocol_hash TEXT, created_at TEXT NOT NULL, PRIMARY KEY (experiment_id, revision));
            CREATE TABLE checks (sequence INTEGER PRIMARY KEY, experiment_id TEXT NOT NULL, revision INTEGER NOT NULL, check_name TEXT NOT NULL, protocol_hash TEXT NOT NULL, task_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, result_json TEXT, updated_at TEXT NOT NULL, FOREIGN KEY (experiment_id, revision) REFERENCES revisions(experiment_id, revision));
            CREATE TABLE session_creation_keys (session_id TEXT NOT NULL, creation_key TEXT NOT NULL, experiment_id TEXT NOT NULL REFERENCES experiments(id), PRIMARY KEY (session_id, creation_key), UNIQUE (experiment_id));
            CREATE INDEX checks_by_revision ON checks (experiment_id, revision, check_name, sequence);
            CREATE TRIGGER revisions_no_update BEFORE UPDATE ON revisions BEGIN SELECT RAISE(ABORT, 'revisions are immutable'); END;
            CREATE TRIGGER revisions_no_delete BEFORE DELETE ON revisions BEGIN SELECT RAISE(ABORT, 'revisions are immutable'); END;
            PRAGMA user_version = ${SCHEMA_VERSION};
          `)
        })
      } else if (version === 1) {
        this.transaction(() => {
          this.db.exec(`CREATE TABLE IF NOT EXISTS session_creation_keys (session_id TEXT NOT NULL, creation_key TEXT NOT NULL, experiment_id TEXT NOT NULL REFERENCES experiments(id), PRIMARY KEY (session_id, creation_key), UNIQUE (experiment_id)); PRAGMA user_version = ${SCHEMA_VERSION};`)
        })
      } else if (version !== SCHEMA_VERSION) {
        throw new ExperimentError('SCHEMA_ERROR', 'unsupported experiment database schema', { found: version, supported: SCHEMA_VERSION })
      }
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  storageIdentity() {
    try {
      const directory = statSync(this.directory)
      const file = statSync(this.path)
      if (!directory.isDirectory() || !file.isFile()) throw new Error('storage path is not a regular file in a directory')
      return { directoryDev: directory.dev, directoryIno: directory.ino, fileDev: file.dev, fileIno: file.ino }
    } catch (cause) {
      throw new ExperimentError('STORAGE_UNAVAILABLE', 'configured experiment storage is unavailable', { cause })
    }
  }

  assertStorage() {
    if (this.failure !== null) throw this.failure
    try {
      const identity = this.storageIdentity()
      if (Object.keys(identity).some(key => identity[key] !== this.identity[key])) throw new ExperimentError('STORAGE_UNAVAILABLE', 'configured experiment storage has changed; reopen after checking storage')
    } catch (error) {
      this.failure = error
      throw error
    }
  }

  transaction(operation) {
    this.assertStorage()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const value = operation()
      this.assertStorage()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch (rollbackError) {
        this.failure = new AggregateError([error, rollbackError], 'transaction and rollback failed; close this store')
        throw this.failure
      }
      throw error
    }
  }

  /** Create one experiment per creation key; replay must carry the same initial snapshot.
   * @param {{ creationKey: string, snapshot: object }} input Creation key and full snapshot.
   * @returns {{ created: boolean, experiment: object }} Initial revision, including on replay.
   */
  create(input) {
    requiredString(input.creationKey, 'creationKey')
    const data = snapshot(input.snapshot)
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT id, initial_json FROM experiments WHERE creation_key = ?').get(input.creationKey)
      if (existing) {
        if (existing.initial_json !== data.json) throw new ExperimentError('IDEMPOTENCY_CONFLICT', 'creation key was already used with a different snapshot')
        return { created: false, experiment: this.readRevision(existing.id, 1) }
      }
      const id = randomUUID()
      const now = new Date().toISOString()
      this.db.prepare('INSERT INTO experiments VALUES (?, ?, ?, 1)').run(id, input.creationKey, data.json)
      this.db.prepare('INSERT INTO revisions VALUES (?, 1, ?, ?, ?)').run(id, data.json, data.protocolHash, now)
      return { created: true, experiment: this.readRevision(id, 1) }
    })
  }

  /** Create within a server-supplied session and isolate the creation key by session.
   * @param {string} sessionId Trusted session identity.
   * @param {{ creationKey: string, snapshot: object }} input Creation request.
   * @returns {{ created: boolean, experiment: object }} Initial revision, including on replay.
   */
  createForSession(sessionId, input) {
    requiredString(sessionId, 'sessionId')
    requiredString(input.creationKey, 'creationKey')
    if (!input.snapshot || typeof input.snapshot !== 'object' || Array.isArray(input.snapshot)) throw new ExperimentError('INVALID_INPUT', 'snapshot must be a JSON object')
    if (Object.hasOwn(input.snapshot, 'sessionId') && input.snapshot.sessionId !== sessionId) throw new ExperimentError('SESSION_MISMATCH', 'snapshot sessionId does not match the session')
    snapshot(input.snapshot)
    const data = snapshot({ ...input.snapshot, sessionId })
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT e.id, e.initial_json FROM session_creation_keys s JOIN experiments e ON e.id = s.experiment_id WHERE s.session_id = ? AND s.creation_key = ?').get(sessionId, input.creationKey)
      if (existing) {
        this.assertSession(existing.id, sessionId, 1)
        if (existing.initial_json !== data.json) throw new ExperimentError('IDEMPOTENCY_CONFLICT', 'creation key was already used with a different snapshot')
        return { created: false, experiment: this.readRevision(existing.id, 1) }
      }
      const id = randomUUID()
      let key
      do { key = `session-internal:${randomUUID()}` } while (this.db.prepare('SELECT 1 FROM experiments WHERE creation_key = ?').get(key))
      this.db.prepare('INSERT INTO experiments VALUES (?, ?, ?, 1)').run(id, key, data.json)
      this.db.prepare('INSERT INTO session_creation_keys VALUES (?, ?, ?)').run(sessionId, input.creationKey, id)
      this.db.prepare('INSERT INTO revisions VALUES (?, 1, ?, ?, ?)').run(id, data.json, data.protocolHash, new Date().toISOString())
      return { created: true, experiment: this.readRevision(id, 1) }
    })
  }

  /** Return the latest created experiment owned by the supplied session. */
  latestForSession(sessionId) {
    requiredString(sessionId, 'sessionId')
    this.assertStorage()
    const row = this.db.prepare('SELECT experiment_id FROM session_creation_keys WHERE session_id = ? ORDER BY rowid DESC LIMIT 1').get(sessionId)
    return row ? this.assertSession(row.experiment_id, sessionId, this.currentRevision(row.experiment_id)) : null
  }

  initialOwner(id) {
    const row = this.db.prepare('SELECT initial_json FROM experiments WHERE id = ?').get(id)
    if (!row) throw new ExperimentError('NOT_FOUND', 'experiment not found', { id })
    const owner = JSON.parse(row.initial_json).sessionId
    return typeof owner === 'string' && owner.trim() ? owner : null
  }

  assertSession(id, sessionId, revision) {
    if (this.initialOwner(id) !== sessionId) throw new ExperimentError('SESSION_MISMATCH', 'experiment is not owned by the session')
    const result = this.readRevision(id, revision)
    if (result.snapshot.sessionId !== sessionId) throw new ExperimentError('SESSION_MISMATCH', 'revision does not match the session')
    return result
  }

  readRevision(id, revision) {
    const row = this.db.prepare('SELECT experiment_id, revision, snapshot_json, protocol_hash, created_at FROM revisions WHERE experiment_id = ? AND revision = ?').get(id, revision)
    if (!row) throw new ExperimentError('NOT_FOUND', 'experiment revision not found', { id, revision })
    return { id: row.experiment_id, revision: row.revision, snapshot: JSON.parse(row.snapshot_json), protocolHash: row.protocol_hash, createdAt: row.created_at }
  }

  currentRevision(id) {
    const row = this.db.prepare('SELECT current_revision FROM experiments WHERE id = ?').get(id)
    if (!row) throw new ExperimentError('NOT_FOUND', 'experiment not found', { id })
    return row.current_revision
  }

  /** Read the current revision or an explicit historical revision.
   * @param {string} id Experiment identifier.
   * @param {number} [revision] Historical revision, or omit for current.
   * @returns {object} Persisted snapshot and protocol hash.
   */
  get(id, revision) {
    requiredString(id, 'id')
    if (revision !== undefined) revisionNumber(revision)
    this.assertStorage()
    return this.readRevision(id, revision === undefined ? this.currentRevision(id) : revision)
  }

  /** Read a revision belonging to a server-supplied session.
   * @param {string} sessionId Trusted session identity.
   * @param {string} id Experiment identifier.
   * @param {number} [revision] Historical revision, or omit for current.
   * @returns {object} Persisted revision.
   */
  getForSession(sessionId, id, revision) {
    requiredString(sessionId, 'sessionId')
    requiredString(id, 'id')
    if (revision !== undefined) revisionNumber(revision)
    this.assertStorage()
    return this.assertSession(id, sessionId, revision === undefined ? this.currentRevision(id) : revision)
  }

  /** Replace the full snapshot with a new immutable revision.
   * @param {{ id: string, expectedRevision: number, snapshot: object }} input Update request.
   * @returns {object} Committed revision; stale writers receive REVISION_CONFLICT.
   */
  update(input) {
    return this.updateRevision(input)
  }

  /** Update an experiment owned by a server-supplied session.
   * @param {string} sessionId Trusted session identity.
   * @param {{ id: string, expectedRevision: number, snapshot: object }} input Update request.
   * @returns {object} Committed revision.
   */
  updateForSession(sessionId, input) {
    requiredString(sessionId, 'sessionId')
    return this.updateRevision(input, sessionId)
  }

  updateRevision(input, sessionId) {
    requiredString(input.id, 'id')
    revisionNumber(input.expectedRevision)
    const data = snapshot(input.snapshot)
    return this.transaction(() => {
      const current = this.currentRevision(input.id)
      const owner = this.initialOwner(input.id)
      if (sessionId !== undefined) this.assertSession(input.id, sessionId, current)
      if (owner !== null && input.snapshot.sessionId !== owner) throw new ExperimentError('SESSION_MISMATCH', 'initial sessionId cannot be changed')
      if (current !== input.expectedRevision) throw new ExperimentError('REVISION_CONFLICT', 'experiment revision changed', { expectedRevision: input.expectedRevision, currentRevision: current })
      if (!Number.isSafeInteger(current + 1)) throw new ExperimentError('REVISION_LIMIT', 'experiment revision limit reached')
      const next = current + 1
      this.db.prepare('INSERT INTO revisions VALUES (?, ?, ?, ?, ?)').run(input.id, next, data.json, data.protocolHash, new Date().toISOString())
      this.db.prepare('UPDATE experiments SET current_revision = ? WHERE id = ?').run(next, input.id)
      return this.readRevision(input.id, next)
    })
  }

  /** Start a named check for the current revision, superseding any prior task of that name.
   * @param {{ id: string, revision: number, protocolHash: string, name: string }} input Check identity.
   * @returns {object} Task identity required to commit its result.
   */
  startCheck(input) {
    requiredString(input.id, 'id')
    requiredString(input.name, 'name')
    requiredString(input.protocolHash, 'protocolHash')
    revisionNumber(input.revision)
    return this.transaction(() => {
      this.assertCurrentCheck(input)
      const taskId = randomUUID()
      const now = new Date().toISOString()
      this.db.prepare(`UPDATE checks SET status = 'superseded', updated_at = ? WHERE experiment_id = ? AND revision = ? AND check_name = ? AND status = 'running'`).run(now, input.id, input.revision, input.name)
      this.db.prepare(`INSERT INTO checks (experiment_id, revision, check_name, protocol_hash, task_id, status, result_json, updated_at) VALUES (?, ?, ?, ?, ?, 'running', NULL, ?)`).run(input.id, input.revision, input.name, input.protocolHash, taskId, now)
      return { ...input, taskId }
    })
  }

  assertCurrentCheck(input) {
    const current = this.currentRevision(input.id)
    if (current !== input.revision) throw new ExperimentError('STALE_TASK', 'check belongs to an older experiment revision', { currentRevision: current })
    const version = this.readRevision(input.id, current)
    if (version.protocolHash === null || version.protocolHash !== input.protocolHash) throw new ExperimentError('PROTOCOL_MISMATCH', 'check protocol hash does not match the current revision')
  }

  /** Commit a check result only while its revision, hash, and task are current.
   * @param {{ id: string, revision: number, protocolHash: string, name: string, taskId: string, status: string, result: object }} input Completed task.
   * @returns {object} Persisted check.
   */
  finishCheck(input) {
    requiredString(input.id, 'id')
    requiredString(input.name, 'name')
    requiredString(input.protocolHash, 'protocolHash')
    requiredString(input.taskId, 'taskId')
    revisionNumber(input.revision)
    if (!CHECK_STATUSES.has(input.status)) throw new ExperimentError('INVALID_INPUT', 'invalid check status')
    const result = canonical(input.result)
    return this.transaction(() => {
      this.assertCurrentCheck(input)
      const changed = this.db.prepare(`UPDATE checks SET status = ?, result_json = ?, updated_at = ? WHERE experiment_id = ? AND revision = ? AND check_name = ? AND protocol_hash = ? AND task_id = ? AND status = 'running'`).run(input.status, result, new Date().toISOString(), input.id, input.revision, input.name, input.protocolHash, input.taskId)
      if (changed.changes !== 1) throw new ExperimentError('STALE_TASK', 'check task has been superseded or already completed')
      return this.readChecks(input.id, input.revision).find(check => check.taskId === input.taskId)
    })
  }

  readChecks(id, revision) {
    return this.db.prepare('SELECT check_name, protocol_hash, task_id, status, result_json, updated_at FROM checks WHERE experiment_id = ? AND revision = ? ORDER BY sequence').all(id, revision).map(row => ({ name: row.check_name, protocolHash: row.protocol_hash, taskId: row.task_id, status: row.status, result: row.result_json === null ? null : JSON.parse(row.result_json), updatedAt: row.updated_at }))
  }

  /** Read checks for a revision; no check is inherited from another revision.
   * @param {string} id Experiment identifier.
   * @param {number} revision Revision to inspect.
   * @returns {object[]} Checks for that revision.
   */
  getChecks(id, revision) {
    requiredString(id, 'id')
    revisionNumber(revision)
    this.assertStorage()
    this.readRevision(id, revision)
    return this.readChecks(id, revision)
  }

  /** Read checks for a revision owned by a server-supplied session.
   * @param {string} sessionId Trusted session identity.
   * @param {string} id Experiment identifier.
   * @param {number} revision Revision to inspect.
   * @returns {object[]} Checks for that revision.
   */
  getChecksForSession(sessionId, id, revision) {
    requiredString(sessionId, 'sessionId')
    requiredString(id, 'id')
    revisionNumber(revision)
    this.assertStorage()
    this.assertSession(id, sessionId, revision)
    return this.readChecks(id, revision)
  }

  /** Create and verify an online backup in an existing directory, then apply retention.
   * @param {{ directory: string, retain: number }} options Absolute destination and positive backup count.
   * @returns {Promise<string>} Path of the verified backup. Keep the store open until settled.
   */
  async backup({ directory, retain }) {
    if (typeof directory !== 'string' || !isAbsolute(directory) || !Number.isSafeInteger(retain) || retain < 1) {
      throw new ExperimentError('INVALID_INPUT', 'an absolute backup directory and positive retain count are required')
    }
    this.assertStorage()
    const target = realpathSync(directory)
    const identity = statSync(target)
    if (!identity.isDirectory()) throw new ExperimentError('INVALID_INPUT', 'backup directory must be an existing directory')
    const assertDirectory = () => {
      const current = statSync(directory)
      if (!current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino) throw new ExperimentError('STORAGE_UNAVAILABLE', 'backup directory has changed')
    }
    const key = createHash('sha256').update(realpathSync(this.path)).digest('hex')
    const prefix = `experiment-backup-${key}-`
    const lock = join(target, `${prefix}lock`)
    // The lock serializes retention across store instances and processes for this source.
    mkdirSync(lock, { mode: 0o700 })
    this.pendingBackups++
    let temp
    let result
    let failure
    try {
      assertDirectory()
      this.assertStorage()
      temp = mkdtempSync(join(target, '.experiment-backup-'))
      const staged = join(temp, 'backup.sqlite')
      await backup(this.db, staged)
      chmodSync(staged, 0o600)
      this.assertStorage()
      assertDirectory()
      const copy = new DatabaseSync(staged, { readOnly: true })
      try {
        const integrity = copy.prepare('PRAGMA integrity_check').all()
        if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new ExperimentError('INTEGRITY_ERROR', 'backup integrity check failed', { results: integrity })
      } finally {
        copy.close()
      }
      const name = `${prefix}${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.sqlite`
      result = join(target, name)
      linkSync(staged, result)
      const pattern = new RegExp(`^${prefix}\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.sqlite$`)
      const candidates = readdirSync(target).filter(name => pattern.test(name) && name !== basename(result)).sort().reverse()
      const source = statSync(this.path)
      for (const candidate of candidates.slice(retain - 1)) {
        assertDirectory()
        this.assertStorage()
        const path = join(target, candidate)
        const file = lstatSync(path)
        if (file.isFile() && !(file.dev === source.dev && file.ino === source.ino)) unlinkSync(path)
      }
    } catch (error) {
      failure = error
    }
    try {
      try {
        if (temp) rmSync(temp, { recursive: true, force: true })
      } finally {
        rmdirSync(lock)
      }
    } catch (error) {
      failure = failure ? new AggregateError([failure, error], 'backup and cleanup failed') : error
    } finally {
      this.pendingBackups--
    }
    if (failure) throw failure
    return result
  }

  /** Close the SQLite connection after all backups have settled. */
  close() {
    if (this.pendingBackups) throw new ExperimentError('BACKUP_IN_PROGRESS', 'wait for backups to finish before closing the store')
    this.db.close()
  }
}
