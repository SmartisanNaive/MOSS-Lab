import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '../../packages/client/connection/src/rpc-host.ts'
import { registerWorkbench } from './workbench-route.mjs'

test('registered owner routes preserve body modes, exact paths and Origin checks', async () => {
  const ctx=new Context()
  const fiber=ctx.plugin(scope=>{new HostConnectionService(scope,[],{})})
  await fiber.await()
  const connection=ctx.get('connection')
  let calls=0
  const release=registerWorkbench(connection,{workbench:()=>({status:'idle'}),submit:async()=>{calls++;return {status:'running'}}})
  const shared=connection.createSharedFetchHandler('/api')
  const owner=connection.browserPeer
  const base='https://localhost'
  try {
    assert.equal(shared.requestBodyMode({method:'GET',url:new URL(base+'/api/xiaozhi-workbench')}),'buffered')
    assert.equal(shared.requestBodyMode({method:'POST',url:new URL(base+'/api/xiaozhi-workbench/message')}),'streaming')
    assert.equal((await shared.fetch(new Request(base+'/api/xiaozhi-workbench'),owner)).status,200)
    const request=origin=>new Request(base+'/api/xiaozhi-workbench/message',{method:'POST',headers:{Host:'localhost:443','Content-Type':'application/json',...(origin?{Origin:origin}:{})},body:'{"message":"需求"}'})
    assert.equal((await shared.fetch(request(),owner)).status,403)
    assert.equal((await shared.fetch(request('null'),owner)).status,403)
    assert.equal((await shared.fetch(request('https://localhost'),owner)).status,200)
    assert.equal(calls,1)
    assert.equal((await shared.fetch(new Request(base+'/api/xiaozhi-workbench',{method:'POST'}),owner)).status,404)
    await release()
    assert.equal((await shared.fetch(new Request(base+'/api/xiaozhi-workbench'),owner)).status,404)
  } finally {await release();await fiber.dispose();await ctx.fiber.dispose()}
})
