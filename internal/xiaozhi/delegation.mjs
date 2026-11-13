import { randomUUID } from 'node:crypto'

const ACTIVE = new Set(['running', 'timeout'])
const NEW_EXPERIMENT = /(新开|新建|另开|另一个实验|新实验|换个实验|换一个实验|重开一个实验|重新开始)/

/** Read the human-facing text of an `ask_user_question` call, if it can be read. */
function questionOf(argumentsValue) {
  let parsed = argumentsValue
  if (typeof argumentsValue === 'string') {
    try { parsed = JSON.parse(argumentsValue) } catch { return null }
  }
  if (!Array.isArray(parsed?.questions)) return null
  const lines = parsed.questions
    .map(question => typeof question?.question === 'string' ? question.question.trim() : '')
    .filter(Boolean)
  return lines.length ? lines.join('\n').slice(0, 2000) : null
}

/** Whether a final reply is asking the user to decide or supply missing conditions. */
function asksForConfirmation(text) {
  const value = text.trim()
  return /[?？]\s*$/.test(value)
    || /(请确认|确认一下|请补充|告诉我|要不要|需要你确认|请选择)/.test(value.slice(-300))
}

/** Keep only the question-shaped part of a final reply for voice playback. */
function confirmationOf(text) {
  const value = text.trim()
  const sentences = value.split(/(?<=[。！？!?])|\n+/).map(sentence => sentence.trim()).filter(Boolean)
  const question = [...sentences].reverse().find(sentence =>
    /[?？]\s*$/.test(sentence) || /(请确认|确认一下|请补充|告诉我|要不要|需要你确认|请选择)/.test(sentence))
  return (question ?? value).slice(0, 1000)
}

/** Own one web-visible experiment conversation, with one receipt per accepted request.
 * @param {{ controller: object, workspaces: object, events: object, timeoutMs?: number, sessionId?: string|null }} options Delegation dependencies and the deployment-selected initial session.
 * @returns {{ submit: Function, activeSessionId: Function, get: Function, close: Function }} Delegation service.
 */
export function createDelegation({ controller, workspaces, events, timeoutMs = 300000, sessionId = null }) {
  const jobs = new Map()
  let closed = false
  let activeSession = sessionId

  function createJob(sessionId) {
    if (jobs.size >= 100) jobs.delete(jobs.keys().next().value)
    const job = {
      jobId: randomUUID(),
      status: 'running',
      sessionId,
      result: null,
      generation: 0,
      awaitingConfirmation: false,
      question: null,
      waitingAnnouncements: 0,
      terminalAnnounced: false,
      supersededBy: null,
      nextJobId: null,
    }
    jobs.set(job.jobId, job)
    let stopClaim, stopEvent, stopDiscard, timer
    let observing = true
    let observationClosed = false
    const cleanup = () => {
      observing = false
      clearTimeout(timer)
      stopClaim?.(); stopEvent?.(); stopDiscard?.()
    }
    const finish = (status, result, extra = {}) => {
      if (!observing) return
      job.status = status
      job.result = result
      Object.assign(job, extra)
      cleanup()
    }
    job.finish = finish
    job.cancelObservation = () => {
      if (!observing) return
      observationClosed = true
      job.status = 'error'
      job.result = '委派服务已关闭，无法继续跟踪；任务可能仍在网页中运行'
      cleanup()
    }
    const checkOpen = () => { if (closed) throw new Error('委派服务已关闭') }
    job.ready = (async () => {
      try {
        if (job.sessionId === null) {
          const workspace = workspaces.list()[0]
          if (!workspace) throw new Error('网页中尚无工作区，请先创建工作区')
          const created = await controller.create({ workspaceId: workspace.id, agentPreset: 'standard' })
          job.sessionId = created.sessionId
          checkOpen()
          await controller.rename({ sessionId: job.sessionId, title: `小智委派实验 ${new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}` })
          activeSession = created.sessionId
        }
        checkOpen()
        stopClaim = events.on('agent/inbox/claimed', ({ agent, message: claimed, turn }) => {
          const request = job.request
          if (agent.id !== job.sessionId || request === undefined || claimed.source?.rpcId !== request.requestId) return
          request.turn = turn
          request.finalText = ''
        }, { global: true })
        stopDiscard = events.on('agent/inbox/discarded', ({ agent, message: discarded }) => {
          if (agent.id !== job.sessionId || discarded.source?.rpcId !== job.request?.requestId) return
          finish('error', '任务在执行前被取消，请查看网页会话')
        }, { global: true })
        stopEvent = events.on('session/event', (session, event) => {
          const request = job.request
          if (session.id !== job.sessionId || request?.turn === undefined || event.data?.turn !== request.turn) return
          if (event.type === 'tool/call' && event.data.name === 'ask_user_question') {
            request.pendingQuestion = {
              callId: event.data.callId,
              text: questionOf(event.data.arguments),
            }
            request.questionAnnounced = false
            job.awaitingConfirmation = true
            return
          }
          if (event.type === 'tool/result' && request.pendingQuestion?.callId === event.data.callId) {
            request.pendingQuestion = null
            job.awaitingConfirmation = false
            return
          }
          if (event.type === 'user/message' && event.data.source?.kind === 'user-question-reply'
            && request.pendingQuestion?.callId === event.data.source.callId) {
            request.pendingQuestion = null
            job.awaitingConfirmation = false
            return
          }
          if (event.type === 'assistant/message' && !event.data.interrupted) {
            const content = event.data.message?.content
            if (Array.isArray(content)) request.finalText = content.filter(part => part.type === 'text').map(part => part.text).join('\n').slice(0, 4000)
            return
          }
          if (event.type === 'turn/end') {
            const pending = request.pendingQuestion
            const question = pending?.text ?? null
            const finalText = request.finalText
            job.awaitingConfirmation = pending !== null || asksForConfirmation(finalText)
            job.question = (question ?? (job.awaitingConfirmation ? confirmationOf(finalText) : null)) || null
            request.pendingQuestion = null
            if (event.data.reason?.kind === 'completed' && (finalText.trim() || pending !== null)) {
              finish('completed', finalText.trim() || `实验助手在等你确认：${question ?? '请在网页会话中查看问题'}`)
            } else {
              job.awaitingConfirmation = false
              finish('error', `任务未正常完成：${event.data.reason?.kind ?? '未知原因'}；请查看网页会话`)
            }
          }
        }, { global: true })
        timer = setTimeout(() => {
          if (!observing) return
          job.status = 'timeout'
          job.result = job.result ? `${job.result}；等待结果已超时，仍在跟踪` : '等待结果超时，任务仍被跟踪，请稍后查询或查看网页会话'
        }, timeoutMs)
      } catch (error) {
        finish('error', `委派失败：${error.message}`)
        throw error
      }
    })()
    let admission = job.ready
    job.start = async (message, { followUp = false } = {}) => {
      const pending = job.request?.pendingQuestion ?? null
      const request = {
        requestId: randomUUID(),
        generation: ++job.generation,
        turn: undefined,
        finalText: '',
        pendingQuestion: null,
        questionAnnounced: false,
      }
      job.request = request
      job.result = null
      job.awaitingConfirmation = Boolean(pending)
      job.question = pending?.text ?? null
      const previous = admission
      const pendingAdmission = (async () => {
        await previous
        checkOpen()
        if (job.request !== request) return
        const answering = pending !== null
        if (answering && typeof controller.cancel === 'function') {
          try { await controller.cancel({ sessionId: job.sessionId }) } catch (error) {
            // Best effort: the queued request below still continues the same Session.
          }
          checkOpen()
          if (job.request !== request) return
        }
        const mode = answering || request.generation === 1 ? 'queue' : 'steer'
        const text = answering
          ? `来自小智的最新要求（第 ${request.generation} 版）：\n${message}\n你刚才在等待用户确认；这条消息就是用户对确认的回复。请继续同一实验会话，不要另建实验。`
          : followUp
            ? `来自小智的后续消息：\n${message}\n继续同一实验会话；如果用户是在回答上一轮的问题，请沿用该实验，不要另建实验。`
            : request.generation === 1
              ? `来自小智的委派：\n${message}\n这是本任务第 1 版要求；后续改口以版本号最大的要求为准。`
              : `来自小智的最新要求（第 ${request.generation} 版）：\n${message}\n同一任务以版本号最大的要求为准；与此前要求冲突的分析和预览均已失效，请重新生成当前结果。`
        try {
          await controller.prompt({ sessionId: job.sessionId, requestId: request.requestId, mode, content: [{ type: 'text', text }] }, new AbortController().signal)
        } catch (error) {
          if (!observing || job.request !== request) return
          if (error?.code === 'session/not-found') {
            if (job.sessionId === activeSession) activeSession = null
            finish('error', '原实验会话不存在，请明确开始新实验；网页会话列表中的旧对话仍保留。')
            return
          }
          job.result = `提交结果未知：${error.message}；任务可能仍在网页中运行，请查看会话`
        }
      })()
      // A prompt failure is contained above; setup or closure failures still reject callers.
      admission = pendingAdmission
      await pendingAdmission
      return {
        jobId: job.jobId,
        sessionId: job.sessionId,
        status: job.status,
        generation: request.generation,
        currentGeneration: job.generation,
        note: observationClosed
          ? '委派服务已关闭，无法继续跟踪；任务可能仍在网页中运行。'
          : job.request !== request ? '此要求已被更新版本替代，请查询最新任务状态。'
            : job.result && observing ? '提交结果未知或等待超时，请查询任务状态并查看网页会话。'
              : observing ? '最新要求已发送到本地网页工作区，请查询结果。' : '任务已有结果，请查询任务状态。',
      }
    }
    return job
  }

  function activeJob() {
    return [...jobs.values()].find(job => ACTIVE.has(job.status))
  }

  async function submit(message, { newTask = false } = {}) {
    if (closed) throw new Error('委派服务已关闭')
    if (typeof newTask !== 'boolean') throw new Error('新实验标记必须为布尔值')
    if (typeof message !== 'string' || !message.trim() || Buffer.byteLength(message) > 8000) throw new Error('委派内容须为不超过 8000 字节的非空文字')
    // A voice caller can set newTask while answering a confirmation. Treat an
    // explicit new-task flag as intent only when the wording is also explicit;
    // otherwise the answer would replace the waiting experiment with a new one.
    const latest = [...jobs.values()].at(-1)
    const awaitingAnswer = latest?.awaitingConfirmation === true && latest.sessionId === activeSession
    const requestedNewTask = newTask && (!awaitingAnswer || NEW_EXPERIMENT.test(message))
    const active = activeJob()
    if (requestedNewTask) {
      activeSession = null
      const job = createJob(null)
      if (active !== undefined) {
        active.supersededBy = job.jobId
        active.finish('error', '已开始新实验，旧任务停止跟踪；请查看原会话。', { supersededBy: job.jobId })
        if (active.sessionId !== null && typeof controller.cancel === 'function') {
          void controller.cancel({ sessionId: active.sessionId }).catch(error => {
            // The new task does not depend on stopping the old turn.
            void error
          })
        }
      }
      return job.start(message)
    }
    if (active !== undefined) return active.start(message)
    if (activeSession !== null) {
      const previous = [...jobs.values()].at(-1)
      const job = createJob(activeSession)
      const receipt = await job.start(message, { followUp: true })
      if (previous?.sessionId === activeSession) previous.nextJobId = job.jobId
      return receipt
    }
    return createJob(null).start(message)
  }

  return {
    submit,
    /** Current delegated conversation, or the deployer-selected session when no delegation ran. */
    activeSessionId() { return activeSession },
    /** Read machine state and consume this job's next speech decision.
     * Decisions are shared by all callers: three waiting replies across revisions,
     * then silence; one confirmation or terminal reply. Lost responses are not replayed.
     * An explicit progress question bypasses the waiting budget.
     * @param {string} jobId Delegated job identity.
     * @param {{ userQuery?: boolean }} [options] Whether the user explicitly asked for progress.
     * @returns {object} Machine state, current generation, unchanged result, pending confirmation and speech { speak, text }.
     */
    get(jobId, { userQuery = false } = {}) {
      const job = jobs.get(jobId)
      if (!job) throw new Error('任务不存在或服务已重启，请在网页会话中查看原任务，确认结果后再委派')
      if (job.supersededBy !== null) {
        const swapped = job.terminalAnnounced
        job.terminalAnnounced = true
        return {
          jobId: job.jobId,
          sessionId: job.sessionId,
          status: job.status,
          generation: job.generation,
          result: job.result,
          awaitingConfirmation: false,
          question: null,
          speech: { speak: !swapped, text: swapped ? null : '这条语音要求已被更新的要求替代，请查看最新任务。', reason: 'superseded' },
          supersededBy: job.supersededBy,
        }
      }
      if (job.nextJobId !== null) {
        return {
          jobId: job.jobId,
          sessionId: job.sessionId,
          status: job.status,
          generation: job.generation,
          result: job.result,
          awaitingConfirmation: false,
          question: null,
          speech: { speak: false, text: null, reason: 'continued' },
          followJobId: job.nextJobId,
        }
      }
      const pending = job.request?.pendingQuestion ?? null
      const awaitingConfirmation = Boolean(pending) || job.awaitingConfirmation
      const question = pending?.text ?? job.question ?? null
      let speech = { speak: false, text: null, reason: null }
      if (ACTIVE.has(job.status)) {
        if (pending !== null) {
          if (!job.request.questionAnnounced || userQuery) {
            job.request.questionAnnounced = true
            speech = { speak: true, text: question ?? '实验助手需要你确认，请在网页会话中查看。', reason: 'needs_input' }
          }
        } else if (userQuery) {
          speech = { speak: true, text: job.result ? '任务结果尚未确定，请在网页会话中查看进展。' : '还在处理，完成后会提示你。', reason: 'user_query' }
        } else if (job.waitingAnnouncements < 3) {
          job.waitingAnnouncements++
          speech = { speak: true, text: job.result ? '任务结果尚未确定，请在网页会话中查看进展。' : '任务仍在处理中，请稍候。', reason: 'waiting' }
        }
      } else if (!job.terminalAnnounced) {
        job.terminalAnnounced = true
        const alreadyAnnounced = job.request?.questionAnnounced === true
        if (!(awaitingConfirmation && alreadyAnnounced)) {
          const text = job.status === 'completed'
            ? awaitingConfirmation
              ? question ?? '实验助手在等你确认，请直接说出你的选择或补充条件。'
              : '任务已完成，请在网页会话中查看结果。'
            : '任务未正常完成，请在网页会话中核查状态后再决定下一步。'
          speech = { speak: true, text, reason: awaitingConfirmation ? 'needs_input' : job.status }
        }
      }
      return {
        jobId: job.jobId,
        sessionId: job.sessionId,
        status: job.status,
        generation: job.generation,
        result: job.result,
        awaitingConfirmation,
        question,
        speech,
      }
    },
    close() {
      closed = true
      for (const job of jobs.values()) if (ACTIVE.has(job.status)) job.cancelObservation?.()
    },
  }
}
