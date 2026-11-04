import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const active = job => job && ['running', 'timeout'].includes(job.status)

/** Reject work based on voice requirements that were superseded or not admitted yet. */
export class VoiceIntentError extends Error {
  constructor(code) { super('最新语音要求已更新，请按最新要求继续；不要提交旧方案。'); this.code = code }
}

/** Own the endpoint conversation, latest accepted intent, and phase-driven navigation. */
export function createDelegation({ controller, workspaces, events, timeoutMs = 300000, sessionId = null, bindingPath = null, workspacePath = null, agentPreset = 'standard', validateSession = async () => {}, cancelSession = async () => {}, removePendingVoice = async () => {} }) {
  const jobs = new Map(), subscribers = new Set()
  let closed = false, activeSession = sessionId, sequence = 0, latest = null
  let focusSequence = 0, focusReason = null, presented = false
  let admission = Promise.resolve()
  if (bindingPath && existsSync(bindingPath)) {
    const saved = JSON.parse(readFileSync(bindingPath, 'utf8'))
    if (typeof saved.sessionId !== 'string' || !saved.sessionId.trim() || !Number.isSafeInteger(saved.sequence) || saved.sequence < 0) throw new Error('语音会话记录无效，请检查本地记录')
    activeSession = saved.sessionId; sequence = saved.sequence
  }
  const persist = (nextSession, nextSequence) => {
    if (!bindingPath || nextSession === null) return
    const temporary = bindingPath + '.' + randomUUID() + '.tmp'
    try {
      writeFileSync(temporary, JSON.stringify({ sessionId: nextSession, sequence: nextSequence }), { mode: 0o600, flag: 'wx' })
      renameSync(temporary, bindingPath)
    } catch (error) {
      try { unlinkSync(temporary) } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') throw cleanupError }
      throw error
    }
  }
  const changed = () => { for (const listener of subscribers) { try { listener() } catch { console.warn('xiaozhi task observer failed') } } }
  const focus = reason => { focusSequence = Math.max(focusSequence + 1, Date.now()); focusReason = reason }
  const publicJob = job => ({ jobId: job.jobId, sessionId: job.sessionId, status: job.status, result: job.result, cycleId: job.cycleId, phase: job.phase, question: job.question, preview: job.preview, supersededBy: job.supersededBy })

  async function admit(message, newExperiment) {
    if (closed) throw new Error('委派服务已关闭')
    const previous = latest
    const replacing = active(previous)
    if (jobs.size >= 100) jobs.delete(jobs.keys().next().value)
    const jobId = randomUUID()
    const job = { jobId, status: 'running', sessionId: null, result: null, cycleId: replacing && !newExperiment ? previous.cycleId : jobId, phase: 'preparing', question: null, preview: null, supersededBy: null, claimed: false }
    jobs.set(jobId, job)
    let stopClaim, stopEvent, stopDiscard, timer
    let promptStarted = false, observing = true, observationClosed = false
    const cleanup = () => { observing = false; clearTimeout(timer); stopClaim?.(); stopEvent?.(); stopDiscard?.() }
    const finish = (status, result) => {
      if (!observing) return
      job.status = status; job.result = result
      if (status === 'error') job.phase = 'error'
      if (status === 'completed' && job.phase === 'preparing') job.phase = 'reply'
      cleanup(); changed()
    }
    job.finish = finish
    job.cancelObservation = () => { observationClosed = true; finish('error', '委派服务已关闭，无法继续跟踪；任务可能仍在网页中运行') }
    const checkOpen = () => { if (closed) throw new Error('委派服务已关闭') }
    try {
      if (activeSession === null || newExperiment) {
        const workspace = workspaces.list()[0]
        if (!workspace && !workspacePath) throw new Error('网页中尚无工作区，请先创建工作区')
        const created = await controller.create(workspace ? { workspaceId: workspace.id, agentPreset } : { cwd: workspacePath, agentPreset })
        job.sessionId = created.sessionId; checkOpen()
        await controller.rename({ sessionId: job.sessionId, title: '小智实验 ' + new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) })
        checkOpen()
      } else { await validateSession(activeSession, agentPreset); checkOpen(); job.sessionId = activeSession }
      const nextSequence = Math.max(sequence + 1, Date.now())
      persist(job.sessionId, nextSequence)
      activeSession = job.sessionId; sequence = nextSequence; latest = job
      if (replacing) {
        await removePendingVoice(previous.sessionId, previous.requestId)
        checkOpen()
        previous.supersededBy = jobId
        previous.finish('superseded', '已按最新要求继续，旧任务不再作为当前结果。')
        if (newExperiment && previous.sessionId !== job.sessionId) await cancelSession(previous.sessionId)
      }
      const requestId = randomUUID()
      job.requestId = requestId
      let turn, finalText = ''
      stopClaim = events.on('agent/inbox/claimed', ({ agent, message: claimed, turn: claimedTurn }) => {
        if (agent.id === job.sessionId && claimed.source?.rpcId === requestId) { turn = claimedTurn; job.claimed = true; changed() }
      }, { global: true })
      stopDiscard = events.on('agent/inbox/discarded', ({ agent, message: discarded }) => {
        if (agent.id === job.sessionId && discarded.source?.rpcId === requestId) finish('error', '任务在执行前被取消')
      }, { global: true })
      stopEvent = events.on('session/event', (session, event) => {
        if (session.id !== job.sessionId || turn === undefined || event.data?.turn !== turn) return
        if (event.type === 'assistant/message' && !event.data.interrupted) {
          const content = event.data.message?.content
          if (Array.isArray(content)) finalText = content.filter(part => part.type === 'text').map(part => part.text).join('\n').slice(0, 4000)
        }
        if (event.type === 'turn/end') {
          if (event.data.reason?.kind === 'completed' && finalText.trim()) finish('completed', finalText)
          else finish('error', event.data.reason?.kind === 'aborted' ? '本次生成已停止' : '生成未完成，请查看对话中的说明')
        }
      }, { global: true })
      timer = setTimeout(() => { if (observing) { job.status = 'timeout'; job.result = '等待结果超时，仍在跟踪，请查看网页会话'; changed() } }, timeoutMs)
      if (!presented) { presented = true; focus('first_open') }
      changed()
      promptStarted = true
      const latestNote = replacing && !newExperiment ? '\n这是最新补充；以此覆盖此前相冲突的要求。沿用同一实验ID，读取当前版本后按最新要求更新并重新分析。' : ''
      await controller.prompt({ sessionId: job.sessionId, requestId, mode: replacing && !newExperiment ? 'steer' : 'queue', content: [{ type: 'text', text: '来自小智的委派：\n' + message + latestNote }] }, new AbortController().signal)
      return { jobId, sessionId: job.sessionId, status: job.status, note: observationClosed ? '服务已停止观察，任务可能仍在网页中运行。' : '任务已接受，等待期间可以直接补充或修改要求。' }
    } catch (error) {
      if (promptStarted) {
        if (observing && active(job)) job.result = '提交结果未知：' + error.message + '；任务可能仍在网页中运行，请查看会话'
        return { jobId, sessionId: job.sessionId, status: job.status, note: observationClosed ? '委派服务已关闭，无法继续跟踪；任务可能仍在网页中运行。' : observing ? '提交结果未知，请查询任务状态并查看网页会话。' : '任务已有结果，请查询任务状态。' }
      }
      finish('error', '委派失败：' + error.message)
      if (latest !== job) jobs.delete(jobId)
      throw error
    }
  }

  return {
    submit(message, { newExperiment = false } = {}) {
      if (typeof newExperiment !== 'boolean') return Promise.reject(new Error('新实验标记必须为布尔值'))
      if (typeof message !== 'string' || !message.trim() || Buffer.byteLength(message) > 8000) return Promise.reject(new Error('委派内容须为不超过 8000 字节的非空文字'))
      const operation = admission.then(() => admit(message, newExperiment))
      admission = operation.then(() => {}, () => {})
      return operation
    },
    subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener) },
    activeSessionId() { return activeSession },
    workbench() {
      const job = latest
      return { sequence, focusSequence, focusReason, sessionId: activeSession, jobId: job?.jobId ?? null, status: job?.status ?? 'idle', result: job?.result ?? null, phase: job?.phase ?? 'idle', question: job?.question ?? null, preview: job?.preview ?? null }
    },
    get(jobId) { const job = jobs.get(jobId); if (!job) throw new Error('任务不存在或服务已重启'); return publicJob(job) },
    captureIntent(id) {
      if (id !== activeSession) return { assertCurrent() {}, needsInput() {}, previewReady() {} }
      const owner = latest
      const voice = active(owner) ? owner : null
      if (voice && !voice.claimed) throw new VoiceIntentError('VOICE_INTENT_PENDING')
      const current = () => !closed && activeSession === id && latest === owner && owner?.status !== 'superseded'
      const assertCurrent = () => { if (!current()) throw new VoiceIntentError('VOICE_SUPERSEDED') }
      const publish = (phase, fields) => {
        // A newer intent suppresses focus without rolling back a committed preview.
        if (!current()) return false
        if (voice) {
          if (phase === 'preview_ready' && voice.preview?.id === fields.preview.id && voice.preview.revision === fields.preview.revision) return true
          if (phase === 'needs_input' && voice.phase === phase && voice.question === fields.question) return true
          Object.assign(voice, fields)
          if (voice.status !== 'error') voice.phase = phase
        } else {
          latest = { jobId: null, sessionId: id, status: 'completed', result: null, phase, question: null, preview: null, ...fields }
        }
        focus(phase); changed(); return true
      }
      return {
        assertCurrent,
        needsInput: question => publish('needs_input', { question }),
        previewReady: ({ id, revision }) => publish('preview_ready', { preview: { id, revision } }),
      }
    },
    close() { closed = true; for (const job of jobs.values()) if (active(job)) job.cancelObservation?.(); subscribers.clear() },
  }
}
