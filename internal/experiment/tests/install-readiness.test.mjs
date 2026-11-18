import assert from 'node:assert/strict'
import {test} from 'node:test'
import {apply, inject} from '../install-readiness.mjs'

test('packaged readiness identifies this launch after all required services load', async t => {
  const previous = {nonce: process.env.MOSS_RUN_NONCE, identity: process.env.MOSS_RELEASE_ID}
  t.after(() => {
    for (const [key, value] of [['MOSS_RUN_NONCE', previous.nonce], ['MOSS_RELEASE_ID', previous.identity]]) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  let route
  const ctx = {effect: effect => effect(), connection: {fetch: {register: value => {route = value; return () => {route = undefined}}}}}
  delete process.env.MOSS_RUN_NONCE
  delete process.env.MOSS_RELEASE_ID
  assert.throws(() => apply(ctx), /requires its launch identity/)
  assert.equal(route, undefined)
  process.env.MOSS_RUN_NONCE = 'a'.repeat(32)
  process.env.MOSS_RELEASE_ID = 'b'.repeat(64)
  apply(ctx)
  assert.ok(inject.includes('experimentWorkflow') && inject.includes('robotControl') && inject.includes('sessionPersistence'))
  assert.deepEqual(route.methods, ['GET'])
  const response = await route.fetch()
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
  assert.deepEqual(await response.json(), {ready: true, nonce: 'a'.repeat(32), identity: 'b'.repeat(64)})
})
