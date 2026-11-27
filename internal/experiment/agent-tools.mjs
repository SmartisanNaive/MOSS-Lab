import { defineTool } from '@deepseek-ai/dsh-tools'

/** Tools for the current session's experiments. */
export const name = 'experiment-agent-tools'
export const inject = ['tools', 'systemPrompt', 'experimentWorkflow']

const output = {
  schema: { type: 'json' },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}
const id = { type: 'string', required: true, description: 'Experiment id returned by create_experiment.' }
const requirement = { type: 'string', required: true, description: 'Complete experiment requirement.' }
const protocol = { type: 'string', required: true, description: 'Complete Opentrons Flex or OT-2 Python protocol, including requirements.robotType, a compatible apiLevel, metadata, and run(protocol). Declare known initial liquids with define_liquid and well.load_liquid before transfers; never substitute transfer totals for starting volumes. Mark undeclared starting volumes as unknown in assumptions. Explicitly declare operator-confirmed empty destination wells with well.load_liquid(liquid=..., volume=0), or labware.load_empty for apiLevel 2.22 or later, so setup data preserves the known empty state. Use the simulation API only and do not connect to or command a robot. Common single-channel simulation load names are Flex flex_1channel_50 with opentrons_flex_96_tiprack_50ul, Flex flex_1channel_1000 with opentrons_flex_96_tiprack_1000ul, and OT-2 p300_single_gen2 with opentrons_96_tiprack_300ul. Common labware names are nest_12_reservoir_15ml and corning_96_wellplate_360ul_flat. Flex has no flex_1channel_200. Use confirmed equipment or explicitly stated simulation assumptions. Flex API 2.16 or later requires protocol.load_trash_bin("A3") or protocol.load_waste_chute() before discarding tips; reserve that fixture slot. OT-2 uses its fixed trash and must not call load_trash_bin.' }
const parameters = {
  type: 'object', additionalProperties: false, required: true,
  description: 'Record the experimental setup and assumptions used to write the protocol.',
  properties: {
    initialVolumeUl: { type: 'number', description: 'Declared initial source volume in µL for a single-source transfer. Omit when unknown and say unknown in assumptions; never infer it from transfer totals. Match the protocol load_liquid volume and cover transfers plus applicable dead volume without exceeding source capacity (15000 µL for nest_12_reservoir_15ml).' },
    assumptions: { type: 'string', required: true, description: 'Equipment, labware, positions, liquid volumes, and any assumed values requiring confirmation.' },
  },
}

function sessionId(exec) {
  const id = exec?.agent?.session?.id
  if (typeof id !== 'string' || !id.trim()) throw new Error('A session identity is required for experiment operations.')
  return id
}

/** Register session-scoped experiment tools for the lifetime of this plugin.
 * @param {object} ctx Cordis context with tools and experimentWorkflow services.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'labscriptai:experiment-workflow', order: 2550,
    text: 'For an Opentrons protocol or 3D animation request, use create_experiment or update_experiment with complete Python source, then analyze_experiment on the returned current revision. Simulation and visualization use the pinned LabscriptAI plugin through analyze_experiment. Do not install simulation dependencies, import private plugin modules, or create another player. Report only results supported by tool output: preview_ready means local Opentrons analysis and preview generation succeeded, not complete validation, device readiness, experimental safety, or that a user saw the animation. Distinguish user-confirmed choices from assumptions and predictions; simulation does not observe physical results. A protocol comment or relative delay does not schedule an absolute time or record an observation. Report only steps actually present in the protocol, including any human confirmation or pause. State unconfirmed equipment, labware, deck positions, volumes, and other assumptions as assumptions. For repeated transfers, state the tip reuse policy and any cross-contamination risk; source volume must cover all transfers plus any applicable dead volume. Confirm the robot type (Flex or OT-2) before choosing its API level, pipettes and deck layout. Ask for essential missing details, or label assumptions for a requested example. If analysis or preview fails, explain it without claiming success. If a preview is unavailable after restart, analyze the current revision again. These experiment tools operate locally. For an explicitly requested physical run, use the separate robot tools when available.',
  }), 'experiment-agent-tools.guidance')
  ctx.tools.register(defineTool({
    name: 'request_experiment_input',
    description: 'Ask one concise question for essential experiment details, then wait for the operator to answer. When the message came from 小智, also pass voice_question: one short spoken line naming only the missing facts, at most 30 characters, for example 还需要：目标板孔位、每孔体积。',
    parameters: {
      question: { type: 'string', required: true, description: 'Question in the operator’s language.' },
      voice_question: { type: 'string', description: 'Optional spoken one-liner for the voice device: only the missing facts, at most 30 characters.' },
    },
    output,
    async execute(args, exec) {
      if (!args.question.trim() || Buffer.byteLength(args.question) > 2000) throw new Error('A concise nonempty question is required.')
      const voice = typeof args.voice_question === 'string' ? args.voice_question.trim() : ''
      if (voice && [...voice].length > 40) throw new Error('voice_question must be at most 40 characters.')
      const intent = ctx.get('mossVoiceIntent')?.captureIntent(sessionId(exec))
      intent?.assertCurrent()
      intent?.needsInput(args.question, voice || undefined)
      return { status: 'needs_input', question: args.question, ...(voice ? { voice_question: voice } : {}) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'create_experiment',
    description: 'Create an Opentrons Flex or OT-2 experiment from a complete Python protocol for local simulation. After saving, call analyze_experiment to generate its animation. Ask for essential missing experimental details, or clearly state assumptions for a requested example. Do not initiate a robot run. Reuse the creation key on retry.',
    parameters: {
      creationKey: { type: 'string', required: true, description: 'Stable key for retries of the same creation request.' },
      requirement,
      parameters,
      protocol,
    },
    output,
    async execute(args, exec) {
      return ctx.experimentWorkflow.create({ sessionId: sessionId(exec), creationKey: args.creationKey, requirement: args.requirement, parameters: args.parameters, protocol: args.protocol })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_experiment',
    description: 'Read an experiment and its current checks. Omit id to read the latest experiment in this session.',
    parameters: { id: { type: 'string', description: 'Experiment identifier. Omit for the latest one.' } },
    output,
    async execute(args, exec) {
      return ctx.experimentWorkflow.get({ sessionId: sessionId(exec), id: args.id })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'update_experiment',
    description: 'Revise an experiment and its complete simulation protocol. Call analyze_experiment for the new revision to generate its animation. Use the latest revision to avoid overwriting a concurrent update.',
    parameters: {
      id,
      expectedRevision: { type: 'integer', required: true, description: 'Current positive revision returned by the experiment.' },
      requirement,
      parameters,
      protocol,
    },
    output,
    async execute(args, exec) {
      return ctx.experimentWorkflow.update({ sessionId: sessionId(exec), id: args.id, expectedRevision: args.expectedRevision, requirement: args.requirement, parameters: args.parameters, protocol: args.protocol })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'analyze_experiment',
    description: 'Submit the saved protocol for analysis and preview. This does not establish experimental safety or device readiness. Ask the user for missing information needed to design the experiment before proceeding. After a simulation error, use its diagnostic to update the same experiment and analyze the new revision. If the correction is uncertain or the same error repeats, stop and explain the remaining issue instead of probing another Python environment.',
    parameters: {
      id,
      revision: { type: 'integer', required: true, description: 'Current positive revision containing the protocol to analyze.' },
    },
    output,
    async execute(args, exec) {
      return ctx.experimentWorkflow.analyze({ sessionId: sessionId(exec), id: args.id, revision: args.revision })
    },
  }))
}
