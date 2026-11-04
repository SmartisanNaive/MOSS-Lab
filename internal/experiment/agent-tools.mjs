import { defineTool } from '../../packages/core/tools/src/schema.ts'

/** Tools for the current session's experiments. */
export const name = 'experiment-agent-tools'
export const inject = ['tools', 'systemPrompt', 'experimentWorkflow']

const output = {
  schema: { type: 'json' },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}
const id = { type: 'string', required: true, description: 'Experiment id returned by create_experiment.' }
const requirement = { type: 'string', required: true, description: 'Complete experiment requirement.' }
const protocol = { type: 'string', required: true, description: 'Complete Opentrons Flex Python protocol, including metadata and run(protocol). Use the simulation API only and do not connect to or command a robot.' }
const parameters = {
  type: 'object', additionalProperties: false, required: true,
  description: 'Record the experimental setup and assumptions used to write the protocol.',
  properties: {
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
    text: 'For an Opentrons protocol or 3D animation request, use create_experiment or update_experiment with complete Python source, then analyze_experiment on the returned current revision. Use only the configured project uv virtual environment for Python work: use the Python at $MOSS_PYTHON, or uv run --active --no-project for commands; use uv pip with --python "$MOSS_PYTHON" when managing dependencies. Do not use another interpreter or create another environment. The Opentrons analysis tool already uses this environment. Use the existing Flex3D preview, not a separate player. Report only results supported by tool output: preview_ready means local Opentrons analysis and preview generation succeeded, not complete validation, device readiness, experimental safety, or that a user saw the animation. Distinguish user-confirmed choices from assumptions and predictions; simulation does not observe physical results. A protocol comment or relative delay does not schedule an absolute time or record an observation. Report only steps actually present in the protocol, including any human confirmation or pause. State unconfirmed equipment, labware, deck positions, volumes, and other assumptions as assumptions. For repeated transfers, state the tip reuse policy and any cross-contamination risk; source volume must cover all transfers plus any applicable dead volume. Ask for essential missing details, or label assumptions for a requested example. If analysis or preview fails, explain it without claiming success. If a preview is unavailable after restart, analyze the current revision again. Never initiate a real robot run.',
  }), 'experiment-agent-tools.guidance')
  ctx.tools.register(defineTool({
    name: 'request_experiment_input',
    description: 'Ask the operator for essential missing experimental conditions before writing or revising a protocol. Submit one concise question, then wait for their reply. Do not guess critical volumes, concentrations or equipment.',
    parameters: { question: { type: 'string', required: true, description: 'Concise question in the user language, at most 2000 UTF-8 bytes.' } },
    output,
    async execute(args, exec) {
      if (!args.question.trim() || Buffer.byteLength(args.question) > 2000) throw new Error('A concise nonempty question is required.')
      const current = sessionId(exec)
      const intent = ctx.get('mossVoiceIntent')?.captureIntent(current)
      intent?.assertCurrent()
      intent?.needsInput(args.question)
      return { status: 'needs_input', question: args.question }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'create_experiment',
    description: 'Create an Opentrons Flex experiment from a complete Python protocol for local simulation. After saving, call analyze_experiment to generate its animation. Ask for essential missing experimental details, or clearly state assumptions for a requested example. Do not initiate a robot run. Reuse the creation key on retry.',
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
    description: 'Read an experiment, its current revision, and available checks for this session.',
    parameters: { id },
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
    description: 'Submit the saved protocol for analysis and preview. This does not establish experimental safety or device readiness. Ask the user for missing information needed to design the experiment before proceeding.',
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
