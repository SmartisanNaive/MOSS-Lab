import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDelegation } from './delegation.mjs'
import { handleMessage } from './bridge.mjs'
import { workbenchRoute } from './workbench-route.mjs'

function fixture(options = {}) {
  const listeners = new Map()
  const requests = []
  let created = 0
  const delegation = createDelegation({
    controller: { async create() { return {sessionId: `s${++created}`} }, async rename() {}, async prompt(input) { requests.push(input) } },
    workspaces: {list: () => [{id:'workspace'}]}, events: {on(key, fn) {listeners.set(key,fn);return () => listeners.delete(key)}}, ...options,
  })
  return {delegation, requests, get created() {return created}, finish(reply = '请补充最终体积') {
    const request = requests.at(-1)
    listeners.get('agent/inbox/claimed')({agent:{id:request.sessionId},message:{source:{rpcId:request.requestId}},turn:1})
    const event = listeners.get('session/event')
    event({id:request.sessionId},{type:'assistant/message',data:{turn:1,message:{content:[{type:'text',text:reply}]}}})
    event({id:request.sessionId},{type:'turn/end',data:{turn:1,reason:{kind:'completed'}}})
  }}
}

test('a clarification and a parameter revision continue the same experiment; explicit new experiment replaces it', async () => {
  const f = fixture()
  try {
    const first = await f.delegation.submit('每组3个重复')
    const sequence = f.delegation.workbench().sequence
    f.finish()
    assert.equal(f.delegation.workbench().sequence, sequence)
    const second = await f.delegation.submit('每孔100微升，重复数改成4')
    assert.equal(second.sessionId, first.sessionId)
    assert.equal(f.created,1)
    assert.ok(f.delegation.workbench().sequence > sequence)
    f.finish('已更新方案')
    const third = await f.delegation.submit('新的实验', {newExperiment:true})
    assert.notEqual(third.sessionId,first.sessionId)
    assert.equal(f.created,2)
  } finally {f.delegation.close()}
})

test('the next voice message restores the persisted identity rather than creating a new session', async () => {
  const dir=mkdtempSync(join(tmpdir(),'moss-voice-binding-'))
  const bindingPath=join(dir,'voice.json')
  const first=fixture({bindingPath})
  let second
  try {
    const original=await first.delegation.submit('方案')
    first.finish()
    first.delegation.close()
    second=fixture({bindingPath})
    const next=await second.delegation.submit('修改方案')
    assert.equal(next.sessionId,original.sessionId)
    assert.equal(second.created,0)
  } finally {first.delegation.close();second?.delegation.close();rmSync(dir,{recursive:true,force:true})}
})

test('text fallback shares the voice session and rejects other origins, oversized bodies, and arbitrary session ids', async () => {
  const f=fixture()
  const route=workbenchRoute(f.delegation)
  const request=(body,headers={})=>new Request('http://localhost/api/xiaozhi-workbench',{method:'POST',headers:{'Content-Type':'application/json','Origin':'http://localhost',...headers},body:JSON.stringify(body)})
  try {
    assert.equal((await route(request({message:'x'},{Origin:'https://other.invalid'}))).status,403)
    assert.equal((await route(request({message:'x'},{Origin:'null'}))).status,403)
    assert.equal((await route(request({message:'x',newExperiment:null}))).status,400)
    assert.equal((await route(request({message:'x',sessionId:'victim'}))).status,400)
    assert.equal((await route(request({message:'x'.repeat(13000)}))).status,400)
    const accepted=await route(request({message:'实验需求'}))
    assert.equal(accepted.status,200)
    const body=await accepted.json()
    const state=await (await route(new Request('http://localhost/api/xiaozhi-workbench'))).json()
    assert.equal(state.sessionId,body.sessionId)
    assert.equal(state.status,'running')
    const amended = await route(request({message:'最新修改'}))
    assert.equal(amended.status,200)
    assert.equal((await amended.json()).sessionId,body.sessionId)
  } finally {f.delegation.close()}
})


test('a failed binding write preserves the previous active conversation and sequence', async () => {
  const dir=mkdtempSync(join(tmpdir(),'moss-binding-failure-'))
  const bindingPath=join(dir,'voice.json')
  const f=fixture({bindingPath})
  try {
    const initial=await f.delegation.submit('first')
    f.finish()
    const saved=readFileSync(bindingPath)
    const sequence=f.delegation.workbench().sequence
    rmSync(bindingPath);mkdirSync(bindingPath)
    await assert.rejects(f.delegation.submit('new', {newExperiment:true}))
    assert.equal(f.delegation.activeSessionId(),initial.sessionId)
    assert.equal(f.delegation.workbench().sequence,sequence)
    rmSync(bindingPath,{recursive:true});writeFileSync(bindingPath,saved)
    const next=await f.delegation.submit('continue')
    assert.equal(next.sessionId,initial.sessionId)
  } finally {f.delegation.close();rmSync(dir,{recursive:true,force:true})}
})

test('the saved and current session follows rollover even when an initial session was configured', async () => {
  const dir=mkdtempSync(join(tmpdir(),'moss-binding-initial-'))
  const bindingPath=join(dir,'voice.json')
  const f=fixture({sessionId:'configured',bindingPath})
  let restored
  try {
    const initial=await f.delegation.submit('first')
    assert.equal(initial.sessionId,'configured');f.finish()
    const next=await f.delegation.submit('new',{newExperiment:true});f.finish()
    const calls=[]
    const store={getForSession(session,id) {calls.push(session);return {id,revision:1}},getChecksForSession(){return []}}
    await handleMessage({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'moss_experiment_status',arguments:{id:'experiment'}}},store,'configured',f.delegation)
    assert.deepEqual(calls,[next.sessionId])
    restored=fixture({sessionId:'configured',bindingPath})
    assert.equal(restored.delegation.activeSessionId(),next.sessionId)
  } finally {f.delegation.close();restored?.delegation.close();rmSync(dir,{recursive:true,force:true})}
})


test('restored sessions with another preset fail without replacing the conversation', async () => {
  let checks=0
  const f=fixture({sessionId:'old-coding-session',agentPreset:'moss-experiment',validateSession:async()=>{checks++;throw new Error('wrong preset')}})
  try {
    await assert.rejects(f.delegation.submit('继续'),/wrong preset/)
    assert.equal(checks,1)
    assert.equal(f.created,0)
    assert.equal(f.requests.length,0)
    assert.equal(f.delegation.activeSessionId(),'old-coding-session')
    assert.equal((await f.delegation.submit('开始新实验',{newExperiment:true})).sessionId,'s1')
  } finally {f.delegation.close()}
})
