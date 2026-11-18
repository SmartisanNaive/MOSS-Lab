/** Exercise the installed wheel in Chromium with real model calls and pinned OT simulation. */
import assert from 'node:assert/strict'
import {readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync} from 'node:fs'
import {spawn, execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {createServer, request as httpsRequest} from 'node:https'
import {join, resolve} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {zstdDecompressSync} from 'node:zlib'
import {chromium} from '../apps/web/node_modules/playwright/index.mjs'

const [python, homeArgument, reportArgument] = process.argv.slice(2)
if (!python || !homeArgument || !reportArgument) throw new Error('Usage: node scripts/check-moss-installed.mjs PYTHON HOME REPORT')
const home=resolve(homeArgument), reportRoot=resolve(reportArgument)+'/'
mkdirSync(home,{recursive:true});mkdirSync(reportRoot,{recursive:true})
const key=process.env.MOSS_INSTALL_API_KEY
if(!key)throw new Error('Real model test requires MOSS_INSTALL_API_KEY; no simulated model pass is allowed')
const certificate=join(home,'loopback.crt'),privateKey=join(home,'loopback.key')
const config=join(home,'loopback.cnf')
writeFileSync(config,'[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n')
execFileSync(process.env.MOSS_TEST_OPENSSL||'openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','2','-config',config,'-keyout',privateKey,'-out',certificate],{stdio:'ignore'})
const usage=[];let requests=0,totalTokens=0
const proxy=createServer({key:readFileSync(privateKey),cert:readFileSync(certificate)},(incoming,outgoing)=>{
 const chunks=[];let size=0
 incoming.on('data',chunk=>{size+=chunk.length;if(size>8*1024*1024)incoming.destroy();else chunks.push(chunk)})
 incoming.on('end',()=>{
  if(incoming.url!=='/chat/completions'||incoming.method!=='POST'||requests>=40||totalTokens>=300000){outgoing.writeHead(429);outgoing.end('Test request budget exhausted');return}
  requests++;const body=JSON.parse(Buffer.concat(chunks));body.max_tokens=Math.min(body.max_tokens||4096,4096)
  const raw=Buffer.from(JSON.stringify(body)),responseChunks=[]
  const upstream=httpsRequest('https://api.deepseek.com/chat/completions',{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json','content-length':raw.length}},response=>{
   outgoing.writeHead(response.statusCode,{'content-type':response.headers['content-type']||'application/json'})
   response.on('data',chunk=>{responseChunks.push(chunk);outgoing.write(chunk)})
   response.on('end',()=>{
    const text=Buffer.concat(responseChunks).toString()
    let tokenCount=0
    for(const line of text.split('\n')){try{const value=JSON.parse(line.replace(/^data: /,''));tokenCount+=value.usage?.total_tokens||0}catch(error){/* SSE delimiters are not JSON. */}}
    totalTokens+=tokenCount;usage.push({status:response.statusCode,tokens:tokenCount});outgoing.end()
   })
  });upstream.setTimeout(120000,()=>upstream.destroy(new Error('Model transport timed out')));upstream.on('error',()=>{outgoing.destroy()});upstream.end(raw)
 })
})
await new Promise(accept=>proxy.listen(0,'127.0.0.1',accept))
writeFileSync(join(home,'.env'),`AI_API_URL="https://127.0.0.1:${proxy.address().port}/chat/completions"\nAI_MODEL="${process.env.MOSS_TEST_MODEL||'deepseek-v4-flash'}"\nAI_API_KEY="loopback-placeholder"\nXIAOZHI_WSS_URL=""\nOPENTRONS_URL=""\nMOSS_ALLOW_LIVE_ROBOT="0"\n`,{mode:0o600})
const applicationEnv={...process.env}
for(const name of Object.keys(applicationEnv))if(/KEY|TOKEN|SECRET|PASSWORD/.test(name)||['AI_API_URL','AI_MODEL','XIAOZHI_WSS_URL','OPENTRONS_URL'].includes(name))delete applicationEnv[name]
const child=spawn(python,['-m','moss_lab','--home',home,'start','--no-open','--port','0','--timeout','1800'],{
 env:{...applicationEnv,NODE_EXTRA_CA_CERTS:certificate,MOSS_ALLOW_LIVE_ROBOT:'0'},stdio:['ignore','pipe','pipe']})
let output='';child.stdout.on('data',v=>output+=v);child.stderr.on('data',v=>output+=v)
const exited=new Promise(accept=>child.on('exit',accept))
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function until(read,timeout=180000){const start=Date.now();while(Date.now()-start<timeout){const value=await read();if(value)return value;if(child.exitCode!==null)throw new Error('Installed application exited before task completed');await sleep(700)}throw new Error('Timed out waiting for actual workflow state')}
function state(session){
 const database=new DatabaseSync(join(home,'.dsh-local/experiments.sqlite'),{readOnly:true,timeout:5000}),experiments=[]
 try{for(const e of database.prepare('SELECT e.id,e.current_revision,r.snapshot_json FROM experiments e JOIN revisions r ON r.experiment_id=e.id AND r.revision=e.current_revision').all()){
  const snapshot=JSON.parse(e.snapshot_json);if(snapshot.sessionId!==session)continue
  const row=database.prepare('SELECT status,result_json FROM checks WHERE experiment_id=? AND revision=? ORDER BY sequence DESC LIMIT 1').get(e.id,e.current_revision)
  experiments.push({id:e.id,revision:e.current_revision,snapshot,check:row?{status:row.status,result:row.result_json?JSON.parse(row.result_json):null}:null})
 }}finally{database.close()}
 const root=join(home,'.dsh-local/sessions');let log
 function find(folder){if(!existsSync(folder))return;for(const entry of readdirSync(folder,{withFileTypes:true})){const path=join(folder,entry.name);if(entry.isDirectory())find(path);else if(entry.name==='session.v4.jsonl.zstd'&&path.includes(session))log=path}}
 find(root);let events=[]
 if(log){try{const bytes=readFileSync(log),chunks=[];let position=0;while(position<bytes.length){const frame=zstdDecompressSync(bytes.subarray(position),{info:true});if(!frame.engine.bytesWritten)throw new Error('Incomplete session frame');chunks.push(frame.buffer);position+=frame.engine.bytesWritten}events=Buffer.concat(chunks).toString().trim().split('\n').filter(Boolean).map(JSON.parse)}catch(error){return {experiments,ends:[]}}}
 return {experiments,ends:events.filter(e=>e.type==='turn/end')}
}
async function send(page,text){await page.locator('[data-composer-input][contenteditable="true"]').last().fill(text);const start=Date.now();await page.getByRole('button',{name:/^(发送消息|Send message)$/}).click();return start}
function checked(session,revision){const current=state(session);assert.ok(current.experiments.length<=1);const experiment=current.experiments[0];if(!experiment||experiment.revision<revision)return null;if(['failed','error','blocked'].includes(experiment.check?.status))throw new Error('Real OT analysis failed: '+JSON.stringify(experiment.check.result));return experiment.revision===revision&&experiment.check?.status==='passed'?experiment:null}
function inspectAnalysis(experiment,volume,robot) {
  const analysis=JSON.parse(Buffer.from(experiment.check.result.analysisBase64,'base64'))
  assert.ok(analysis.robotType.includes(robot==='Flex'?'OT-3':'OT-2')||analysis.robotType===robot)
  const commands=analysis.commands
  const labware=commands.filter(c=>c.commandType==='loadLabware')
  const source=labware.find(c=>c.params.loadName.includes('reservoir')).result.labwareId
  const target=labware.find(c=>c.params.loadName.includes('wellplate')).result.labwareId
  const balances=new Map([[source+'/A1',1000],[target+'/A1',0],[target+'/A2',0]])
  const tips=commands.filter(c=>c.commandType==='pickUpTip')
  assert.equal(tips.length,2)
  assert.equal(new Set(tips.map(c=>c.params.labwareId+'/'+c.params.wellName)).size,2)
  let currentTip=-1,sourceTaken=0
  const tipDestinations=new Map()
  for(const command of commands){
    if(command.commandType==='pickUpTip'){currentTip++;tipDestinations.set(currentTip,new Set())}
    if(!['aspirate','dispense'].includes(command.commandType))continue
    const p=command.params,key=p.labwareId+'/'+p.wellName
    assert.ok(balances.has(key),'Liquid handling must stay within the requested source and targets')
    if(command.commandType==='aspirate'){
      assert.ok(balances.get(key)>=p.volume,'Cannot aspirate beyond the declared well volume')
      balances.set(key,balances.get(key)-p.volume)
      if(p.labwareId===source)sourceTaken+=p.volume
    }else{
      balances.set(key,balances.get(key)+p.volume)
      if(p.labwareId===target)tipDestinations.get(currentTip).add(p.wellName)
    }
  }
  assert.equal(sourceTaken,volume*2)
  assert.equal(balances.get(source+'/A1'),1000-volume*2)
  assert.equal(balances.get(target+'/A1'),volume)
  assert.equal(balances.get(target+'/A2'),volume)
  assert.ok([...tipDestinations.values()].every(destinations=>destinations.size===1),'Each destination must have a separate tip')
  const loads=commands.filter(c=>c.commandType==='loadLiquid')
  assert.ok(loads.some(c=>c.params.volumeByWell?.A1===1000),'Initial source must remain1000')
  return analysis
}
async function player(page) {
  const frame=page.frameLocator('iframe[title="Experiment animation"],iframe[title="实验动画"]')
  const play=frame.locator('#play')
  await play.waitFor({timeout:30000})
  await play.click()
  assert.match(await play.innerText(),/暂停|Pause|⏸/)
  await sleep(350)
  const range=frame.locator('#time')
  assert.ok(Number(await range.inputValue())>0,'Play must advance the time')
  await play.click()
  await range.focus();await range.press('End')
  assert.ok(Math.abs(Number(await range.inputValue())-Number(await range.getAttribute('max')))<=Number(await range.getAttribute('step')))
  await range.press('Home')
}
async function artifacts(page,label,experiment,volume) {
  const results=[]
  for(const name of ['setup.png','setup.json','wells.csv']){
    const link=page.getByRole('link',{name,exact:true})
    if(!await link.isVisible())await page.getByText(/^(下载|Download)$/,{exact:true}).click()
    const href=new URL(await link.getAttribute('href'),page.url())
    assert.equal(href.searchParams.get('id'),experiment.id)
    assert.equal(Number(href.searchParams.get('revision')),experiment.revision)
    const [file]=await Promise.all([page.waitForEvent('download',{timeout:20000}),link.click()])
    assert.equal(await file.failure(),null)
    const path=reportRoot+label+'-'+name
    await file.saveAs(path)
    const bytes=readFileSync(path)
    assert.ok(bytes.length>20)
    results.push({name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')})

  }
  const setup=JSON.parse(readFileSync(reportRoot+label+'-setup.json','utf8'))
  assert.equal(setup.analysis_sha256,experiment.check.result.analysisSha256)
  assert.ok(setup.title.includes(String(volume)),'Downloaded title must carry current volume')
  const source=setup.labware.find(l=>l.load_name.includes('reservoir'))
  assert.equal(Object.values(source.initial.A1).reduce((a,b)=>a+b,0),1000)
  const target=setup.labware.find(l=>l.load_name.includes('wellplate'))
  for(const well of ['A1','A2']){
    assert.ok(Object.hasOwn(target.initial,well),'Confirmed empty target must be declared: '+well)
    assert.equal(Object.values(target.initial[well]).reduce((a,b)=>a+b,0),0)
  }
  return results
}

let browser;const results=[];const startup=Date.now()
try{
 console.log('Waiting for installed application readiness')
 const url=await until(()=>output.match(/MOSS [\d.]+ ready\. (http[^\s]+)/)?.[1],1900000)
 browser=await chromium.launch({headless:process.env.MOSS_TEST_HEADLESS==='1'})
 for(const robot of ['Flex','OT-2']){
  console.log('Testing installed '+robot+' workflow')
  const result={robot,status:'RUNNING',startupMs:Date.now()-startup};results.push(result)
  const context=await browser.newContext({locale:'zh-CN',acceptDownloads:true,viewport:{width:1440,height:1000}}),page=await context.newPage()
  try{
   await page.goto(url);await page.locator('[data-composer-input][contenteditable="true"]').last().waitFor({timeout:30000});await sleep(1600)
   await page.getByRole('button',{name:'新建会话',exact:true}).last().click();await page.getByText('实验助手',{exact:true}).waitFor({timeout:15000})
   const first=await send(page,`请作为实验助手，帮我规划一次 ${robot} 液体转移模拟：从储液槽 A1 转移到空的96孔板 A1、A2。来源初始1000微升水，每个目标孔用新枪头。每孔转移体积还没说，请先向我询问缺失信息再开始模拟。允许标准兼容耗材作为假设，只做本地水模拟，不连接实体设备。`)
   await page.locator('[data-chat-running]:not([aria-hidden="true"])').first().waitFor({timeout:15000});result.firstFeedbackMs=Date.now()-first
   const session=await page.locator('[data-conversation-session]:visible').last().getAttribute('data-conversation-session');assert.ok(session);result.sessionId=session
   await until(()=>state(session).ends.length>=1);console.log(robot+' missing-volume question completed');assert.equal(state(session).experiments.length,0,'Must ask for missing volume');result.questionMs=Date.now()-first
   const answer=await send(page,'A1和A2各50微升。接受标准兼容配置作为模拟假设；初始为空的目标孔请在协议中保留，来源仍是1000微升，每个目标孔使用新枪头。')
   const initial=await until(()=>checked(session,1));console.log(robot+' real simulation revision 1 passed');result.experimentId=initial.id;inspectAnalysis(initial,50,robot)
   await page.locator('[data-experiment-revision="1"]').waitFor({timeout:30000});await player(page);result.answerToPlayableMs=Date.now()-answer
   await page.getByRole('button',{name:/^(配置图|Setup image)$/}).click();await page.locator('iframe[title="配置图"],iframe[title="Setup image"]').waitFor({timeout:20000})
   result.initialDownloads=await artifacts(page,robot+'-r1',initial,50);await until(()=>state(session).ends.length>=2)
   const change=await send(page,'只把每个目标孔的转移体积从50改为40微升，其余所有条件和同一个实验不变。重新仿真并更新预览。')
   const revised=await until(()=>checked(session,2));console.log(robot+' real simulation revision 2 passed');assert.equal(revised.id,initial.id);inspectAnalysis(revised,40,robot)
   await page.getByRole('button',{name:/^(动画|Animation)$/}).click();await page.locator('[data-experiment-revision="2"]').waitFor({timeout:30000});await player(page);result.changeToPlayableMs=Date.now()-change
   result.revisedDownloads=await artifacts(page,robot+'-r2',revised,40);await page.reload();await page.locator('[data-experiment-revision="2"]').waitFor({timeout:30000});await player(page)
   result.refreshRecovered=true;await page.screenshot({path:reportRoot+robot+'-passed.png',fullPage:true});result.status='PASS'
  }catch(error){result.status='FAIL';result.error=String(error);await page.screenshot({path:reportRoot+robot+'-failure.png',fullPage:true});throw error}finally{await context.close()}
 }
}finally{
 if(browser)await browser.close();if(child.exitCode===null)child.kill(process.platform==='win32'?'SIGTERM':'SIGINT');await exited;proxy.closeAllConnections();await new Promise(accept=>proxy.close(accept))
 writeFileSync(reportRoot+'installed-browser.json',JSON.stringify({platform:process.platform,arch:process.arch,requests,totalTokens,usage,results},null,2)+'\n')
 console.log(JSON.stringify({platform:process.platform,requests,totalTokens,results}))
}
