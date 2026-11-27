/** Bound automatic speech across one task and its amendments; result queries stay cancellable. */

/**
 * Render one assistant reply as a single short spoken sentence. Markdown tables,
 * code fences, links and headings are dropped, then the first sentence is kept
 * and clipped to the spoken limit so a voice turn never reads a report aloud.
 * @param {unknown} value Assistant reply text.
 * @param {{ limit?: number }} [options] Maximum spoken length before clipping.
 * @returns {string} Spoken summary, or an empty string when nothing speakable remains.
 */
export function spokenReply(value, { limit = 40 } = {}) {
  const text = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*\|.*$/gm, ' ')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[#>`*_~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return ''
  const sentence = (text.match(/^[^。！？!?]*[。！？!?]/)?.[0] ?? text).trim()
  const head = sentence.replace(/[，、,；;：:]$/, '')
  const clipped = head.length <= limit ? head : `${head.slice(0, limit).replace(/[，、,；;：:]$/, '')}。`
  const more = clipped.length < text.length
  if (!more) return clipped
  return `${clipped.replace(/[。！？!?]$/, '')}。详情看电脑。`
}

export function createVoiceFeedback({ delegation, offsetsMs, pollWaitMs, settleMs = 0, now = Date.now }) {
  if (!Array.isArray(offsetsMs) || offsetsMs.length !== 3 || offsetsMs[0] !== 0 || offsetsMs.some((value, index) => !Number.isSafeInteger(value) || value < 0 || index > 0 && value <= offsetsMs[index - 1]) || !Number.isSafeInteger(pollWaitMs) || pollWaitMs < 1) throw new Error('voice feedback requires three increasing offsets beginning at zero and a positive pollWaitMs')
  if (!Number.isSafeInteger(settleMs) || settleMs < 0) throw new Error('voice feedback requires a non-negative settleMs')
  const cycles = new Map()
  const lifetime = new AbortController()
  /**
   * Keep spoken answers short: a long console question is condensed to its leading
   * clause plus a pointer to the workbench, so the device never reads tables or lists.
   * @param {unknown} value Console-side question or result text.
   * @returns {string} Text safe to read aloud once.
   */
  const spoken = value => {
    const flat = String(value ?? '').replace(/\s+/g, ' ').trim()
    if (!flat || flat.length <= 80) return flat
    const colon = flat.indexOf('：')
    const head = (colon > 0 && colon <= 80 ? flat.slice(0, colon) : flat.slice(0, 80)).replace(/[，、,：:；;]$/, '')
    return `${head}。详细问题请看电脑。`
  }
  /**
   * One spoken decision. `next` tells the voice caller how the reply must end:
   * `poll` keeps observing, `end-turn` releases the device to listen again, and
   * `wait` stays quiet while observation continues.
   * @param {object} cycle Speech budget for this task cycle.
   * @param {boolean} speak Whether the caller should read `text` aloud.
   * @param {string} text Sentence to read.
   * @param {string} reason Why this decision was made.
   * @param {'poll'|'end-turn'|'wait'} next Required turn continuation.
   * @returns {object} Public speech decision.
   */
  const speech = (cycle, speak, text, reason, next = 'wait') => ({
    speak, text, reason, next,
    waitingCount: cycle.count, waitingLimit: 3,
    instruction: reason === 'needs_input'
      ? (speak ? '只朗读 text 一次，不加任何口头语、不复述用户原话；然后开始等用户回答；不要朗读 result 或 question 里的详细内容。' : '保持安静，等用户回答。')
      : next === 'poll'
        ? '只朗读 text 一次，不加任何口头语、不复述用户原话；然后继续调用 moss_task_status 观察该任务，不要结束本轮。'
        : next === 'end-turn'
          ? '只朗读 text 一次，不加任何口头语、不复述用户原话；然后立即结束本轮回复，不要再调用任何工具，让设备回到聆听状态。'
          : '保持安静，不播报等待、处理中或任何同义句。继续调用 moss_task_status 观察当前任务，不要结束本轮；用户改口应立即调用 moss_delegate。',
  })
  const state = id => delegation.get(id)
  const cycleFor = job => {
    if (!cycles.has(job.cycleId)) {
      if (cycles.size >= 100) cycles.delete(cycles.keys().next().value)
      cycles.set(job.cycleId, { startedAt: now(), count: 0, reported: false })
    }
    return cycles.get(job.cycleId)
  }
  const terminal = job => !['running', 'timeout'].includes(job.status)
  const pendingQuestion = job => job.phase === 'needs_input' && job.status !== 'superseded' && !job.followJobId && job.question
  const questionReported = (job, cycle) => cycle.question?.jobId === job.jobId && cycle.question.text === job.question
  function report(job, userQuery = false, accepted = false) {
    const cycle = cycleFor(job)
    if (job.status === 'superseded' || job.followJobId) return { ...job, result: null, question: null, awaitingConfirmation: false, speech: speech(cycle, false, '', job.followJobId ? 'continued' : 'superseded'), followJobId: job.followJobId ?? job.supersededBy }
    if (pendingQuestion(job)) {
      const speak = userQuery || !questionReported(job, cycle)
      const short = typeof job.voiceQuestion === 'string' && job.voiceQuestion ? job.voiceQuestion : spoken(job.question)
      cycle.question = { jobId: job.jobId, text: job.question }
      return { ...job, result: short, question: short, awaitingConfirmation: true, detailsAvailableInWorkbench: true, speech: speech(cycle, speak, speak ? short : '', 'needs_input', 'end-turn') }
    }
    job = { ...job, awaitingConfirmation: false }
    if (terminal(job)) {
      const duplicate = cycle.reported
      cycle.reported = true
      // Speak the answer itself, not a pointer to the screen; the full report stays in the workbench.
      const summary = spokenReply(job.result)
      const fallback = job.status === 'error' ? '这次没做成，看电脑。' : '做好了，看电脑。'
      const text = summary || fallback
      return { ...job, result: text, detailsAvailableInWorkbench: true, speech: speech(cycle, userQuery || !duplicate, userQuery || !duplicate ? text : '', duplicate ? 'already_reported' : job.phase, 'end-turn') }
    }
    if (userQuery) return { ...job, speech: speech(cycle, true, '还在做。', 'user_query', 'end-turn') }
    const due = cycle.count < offsetsMs.length && now() - cycle.startedAt >= offsetsMs[cycle.count]
    if (due) {
      const messages = ['收到。', '还在做。', '还在做。']
      const text = accepted && cycle.count > 0 ? '收到修改。' : messages[cycle.count]
      const next = cycle.count === 0 ? 'poll' : 'end-turn'
      cycle.count++
      return { ...job, speech: speech(cycle, true, text, 'waiting', next) }
    }
    return { ...job, speech: speech(cycle, false, '', 'quiet_wait') }
  }
  const ready = job => terminal(job) || (pendingQuestion(job) && !questionReported(job, cycleFor(job)))
  const waitUntilReady = async (id, timeoutMs, signal) => {
    if (ready(state(id))) return
    const scope = AbortSignal.any([signal, lifetime.signal])
    if (scope.aborted) return
    await new Promise(resolve => {
      let timer
      const finish = () => { clearTimeout(timer); stop(); scope.removeEventListener('abort', finish); resolve() }
      timer = setTimeout(finish, timeoutMs)
      const stop = delegation.subscribe(() => { if (ready(state(id))) finish() })
      scope.addEventListener('abort', finish, { once: true })
    })
  }
  return {
    receipt(id) { return report(state(id), false, true) },
    /**
     * Wait briefly for this job to finish, then report it. Used so one delegate
     * call can already carry the answer for short tasks.
     * @param {string} id Receipt job id.
     * @param {{ waitMs?: number, signal?: AbortSignal }} [options] Bound wait and caller cancellation.
     * @returns {Promise<object>} Latest speech report.
     */
    async settle(id, { waitMs = settleMs, signal = new AbortController().signal } = {}) {
      if (lifetime.signal.aborted) throw new Error('语音反馈服务已关闭')
      const job = state(id)
      if (!job) throw new Error('任务不存在')
      if (waitMs > 0 && ['running', 'timeout'].includes(job.status)) {
        await waitUntilReady(id, waitMs, signal)
      }
      return report(state(id))
    },
    /**
     * Explicitly report the latest job, including a finished answer that was not
     * spoken while the device was disconnected. Only a caller that asked for it
     * receives an old result, so a new request never replays the previous one.
     * @param {string} id Receipt job id.
     * @param {{ userQuery?: boolean, signal?: AbortSignal }} [options] Explicit-query and cancellation options.
     * @returns {Promise<object>} Latest speech report.
     */
    async status(id, { userQuery = false, signal = new AbortController().signal } = {}) {
      if (lifetime.signal.aborted) throw new Error('语音反馈服务已关闭')
      if (signal.aborted) throw new Error('语音状态查询已取消')
      let job = state(id)
      if (!ready(job) && !userQuery) {
        const scope = AbortSignal.any([signal, lifetime.signal])
        if (!scope.aborted) await new Promise(resolve => {
          const finish = () => { clearTimeout(timer); stop(); scope.removeEventListener('abort', finish); resolve() }
          const timer = setTimeout(finish, pollWaitMs)
          const stop = delegation.subscribe(() => { if (ready(state(id))) finish() })
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


