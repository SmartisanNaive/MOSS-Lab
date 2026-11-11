import { randomUUID } from 'node:crypto'

/** Own one web-visible session per delegated task, with latest-request result tracking. */
export function createDelegation({ controller, workspaces, events, timeoutMs = 300000 }) {
  const jobs = new Map()
  let closed = false

  function createJob() {
    if (jobs.size >= 100) jobs.delete(jobs.keys().next().value)
    const job = { jobId: randomUUID(), status: 'running', sessionId: null, result: null, generation: 0, waitingAnnouncements: 0, terminalAnnounced: false }
    jobs.set(job.jobId, job)
    let stopClaim, stopEvent, stopDiscard, timer
    let observing = true
    let observationClosed = false
    const cleanup = () => {
      observing = false
      clearTimeout(timer)
      stopClaim?.(); stopEvent?.(); stopDiscard?.()
    }
    const finish = (status, result) => {
      if (!observing) return
      job.status = status
      job.result = result
      cleanup()
    }
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
        const workspace = workspaces.list()[0]
        if (!workspace) throw new Error('网页中尚无工作区，请先创建工作区')
        const created = await controller.create({ workspaceId: workspace.id, agentPreset: 'standard' })
        job.sessionId = created.sessionId
        checkOpen()
        await controller.rename({ sessionId: job.sessionId, title: `小智委派实验 ${new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}` })
        checkOpen()
        stopClaim = events.on('agent/inbox/claimed', ({ agent, message: claimed, turn }) => {
          const request = job.request
          if (agent.id === job.sessionId && claimed.source?.rpcId === request.requestId) {
            request.turn = turn
            request.finalText = ''
          }
        }, { global: true })
        stopDiscard = events.on('agent/inbox/discarded', ({ agent, message: discarded }) => {
          if (agent.id === job.sessionId && discarded.source?.rpcId === job.request.requestId) finish('error', '任务在执行前被取消，请查看网页会话')
        }, { global: true })
        stopEvent = events.on('session/event', (session, event) => {
          const request = job.request
          if (session.id !== job.sessionId || request.turn === undefined || event.data?.turn !== request.turn) return
          if (event.type === 'assistant/message' && !event.data.interrupted) {
            const content = event.data.message?.content
            if (Array.isArray(content)) request.finalText = content.filter(part => part.type === 'text').map(part => part.text).join('\n').slice(0, 4000)
          }
          if (event.type === 'turn/end') {
            if (event.data.reason?.kind === 'completed' && request.finalText.trim()) finish('completed', request.finalText)
            else finish('error', `任务未正常完成：${event.data.reason?.kind ?? '未知原因'}；请查看网页会话`)
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
    job.revise = async message => {
      const request = { requestId: randomUUID(), generation: ++job.generation, turn: undefined, finalText: '' }
      job.request = request
      job.result = null
      const previous = admission
      const pending = (async () => {
        await previous
        checkOpen()
        if (job.request !== request) return
        try {
          await controller.prompt({ sessionId: job.sessionId, requestId: request.requestId, mode: request.generation === 1 ? 'queue' : 'steer', content: [{ type: 'text', text: request.generation === 1
            ? `来自小智的委派：\n${message}\n这是本任务第 1 版要求；后续改口以版本号最大的要求为准。`
            : `来自小智的最新要求（第 ${request.generation} 版）：\n${message}\n同一任务以版本号最大的要求为准；与此前要求冲突的分析和预览均已失效，请重新生成当前结果。` }] }, new AbortController().signal)
        } catch (error) {
          if (observing && job.request === request) job.result = `提交结果未知：${error.message}；任务可能仍在网页中运行，请查看会话`
        }
      })()
      // A prompt failure is contained above; setup or closure failures still reject callers.
      admission = pending
      await pending
      return { jobId: job.jobId, sessionId: job.sessionId, status: job.status, generation: request.generation, currentGeneration: job.generation, note: observationClosed
        ? '委派服务已关闭，无法继续跟踪；任务可能仍在网页中运行。'
        : job.request !== request ? '此要求已被更新版本替代，请查询最新任务状态。'
          : job.result && observing ? '提交结果未知或等待超时，请查询任务状态并查看网页会话。'
            : observing ? '最新要求已发送到本地网页工作区，请查询结果。' : '任务已有结果，请查询任务状态。' }
    }
    return job
  }

  async function submit(message) {
    if (closed) throw new Error('委派服务已关闭')
    if (typeof message !== 'string' || !message.trim() || Buffer.byteLength(message) > 8000) throw new Error('委派内容须为不超过 8000 字节的非空文字')
    const job = [...jobs.values()].find(job => job.status === 'running' || job.status === 'timeout') ?? createJob()
    return job.revise(message)
  }

  return {
    submit,
    /** Read machine state and consume this job's next speech decision.
     * Decisions are shared by all callers: three waiting replies across revisions,
     * then silence; one terminal reply. Lost responses are not replayed.
     * @param {string} jobId Delegated job identity.
     * @returns {object} Machine state, current generation, unchanged result and speech { speak, text }.
     */
    get(jobId) {
      const job = jobs.get(jobId)
      if (!job) throw new Error('任务不存在或服务已重启，请在网页会话中查看原任务，确认结果后再委派')
      let speech = { speak: false, text: null }
      if (job.status === 'running' || job.status === 'timeout') {
        if (job.waitingAnnouncements < 3) {
          job.waitingAnnouncements++
          speech = { speak: true, text: job.result
            ? '任务结果尚未确定，请在网页会话中查看进展。'
            : '任务仍在处理中，请稍候。' }
        }
      } else if (!job.terminalAnnounced) {
        job.terminalAnnounced = true
        speech = { speak: true, text: job.status === 'completed'
          ? '任务已完成，请在网页会话中查看结果。'
          : '任务未正常完成，请在网页会话中核查状态后再决定下一步。' }
      }
      return { jobId: job.jobId, sessionId: job.sessionId, status: job.status, generation: job.generation, result: job.result, speech }
    },
    close() {
      closed = true
      for (const job of jobs.values()) if (job.status === 'running' || job.status === 'timeout') job.cancelObservation?.()
    },
  }
}
