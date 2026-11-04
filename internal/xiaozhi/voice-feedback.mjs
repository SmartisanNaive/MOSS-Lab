/** Bound automatic speech across one task and its amendments; result queries stay cancellable. */
export function createVoiceFeedback({ delegation, offsetsMs, pollWaitMs, now = Date.now }) {
  if (!Array.isArray(offsetsMs) || offsetsMs.length !== 3 || offsetsMs[0] !== 0 || offsetsMs.some((value, index) => !Number.isSafeInteger(value) || value < 0 || index > 0 && value <= offsetsMs[index - 1]) || !Number.isSafeInteger(pollWaitMs) || pollWaitMs < 1) throw new Error('voice feedback requires three increasing offsets beginning at zero and a positive pollWaitMs')
  const cycles = new Map()
  const lifetime = new AbortController()
  const speech = (cycle, speak, text, reason) => ({ speak, text, reason, waitingCount: cycle.count, waitingLimit: 3, instruction: speak ? '只朗读 text 一次，不复述任务状态、JSON、工具名或额外解释。' : '保持安静，不播报等待、处理中或任何同义句。继续观察当前任务；用户改口应立即调用 moss_delegate，不能要求等本轮结束。' })
  const state = id => delegation.get(id)
  const cycleFor = job => {
    if (!cycles.has(job.cycleId)) {
      if (cycles.size >= 100) cycles.delete(cycles.keys().next().value)
      cycles.set(job.cycleId, { startedAt: now(), count: 0, reported: false })
    }
    return cycles.get(job.cycleId)
  }
  const terminal = job => !['running', 'timeout'].includes(job.status)
  function report(job, userQuery = false, accepted = false) {
    const cycle = cycleFor(job)
    if (job.status === 'superseded') return { ...job, speech: speech(cycle, false, '', 'superseded'), followJobId: job.supersededBy }
    if (terminal(job)) {
      const duplicate = cycle.reported
      cycle.reported = true
      const text = job.status === 'error' ? '这次处理没有完成，请看电脑上的说明。'
        : job.phase === 'needs_input' ? job.question
          : job.phase === 'preview_ready' ? '预览已更新，请看电脑。' : '电脑已回复，请看工作台。'
      return { ...job, result: text, detailsAvailableInWorkbench: true, speech: speech(cycle, userQuery || !duplicate, userQuery || !duplicate ? text : '', duplicate ? 'already_reported' : job.phase) }
    }
    if (userQuery) return { ...job, speech: speech(cycle, true, '还在处理，完成后会提示你。', 'user_query') }
    const due = cycle.count < offsetsMs.length && now() - cycle.startedAt >= offsetsMs[cycle.count]
    if (due) {
      const messages = ['收到，正在准备。', '还在准备方案，你可以继续补充要求。', '仍在处理中，接下来安静等待结果。']
      const text = accepted && cycle.count > 0 ? '已收到修改，按最新要求继续。' : messages[cycle.count]
      cycle.count++
      return { ...job, speech: speech(cycle, true, text, 'waiting') }
    }
    return { ...job, speech: speech(cycle, false, '', 'quiet_wait') }
  }
  return {
    receipt(id) { return report(state(id), false, true) },
    async status(id, { userQuery = false, signal = new AbortController().signal } = {}) {
      if (lifetime.signal.aborted) throw new Error('语音反馈服务已关闭')
      let job = state(id)
      if (!terminal(job) && !userQuery) {
        const scope = AbortSignal.any([signal, lifetime.signal])
        if (!scope.aborted) await new Promise(resolve => {
          const finish = () => { clearTimeout(timer); stop(); scope.removeEventListener('abort', finish); resolve() }
          const timer = setTimeout(finish, pollWaitMs)
          const stop = delegation.subscribe(() => { if (terminal(state(id))) finish() })
          scope.addEventListener('abort', finish, { once: true })
        })
        if (scope.aborted) throw new Error('语音状态查询已取消')
        job = state(id)
      }
      return report(job, userQuery)
    },
    snapshot() {
      const latest = delegation.workbench().jobId
      const current = latest ? cycles.get(state(latest).cycleId) : null
      return { waitingCount: current?.count ?? 0, waitingLimit: 3 }
    },
    close() { lifetime.abort() },
  }
}
