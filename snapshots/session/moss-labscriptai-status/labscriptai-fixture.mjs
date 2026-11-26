/** Inject a predictable robot status behind the experiment assistant's real MCP tool registration. */
export const name = 'moss-labscriptai-fixture'
export const inject = ['workingDirectory']

/** Provide a scoped test catalog and one read-only call. */
export function apply(ctx) {
  const robot = { origin: 'http://robot.invalid:31950' }
  const directory = ctx.workingDirectory
  ctx.effect(() => {
    const contextText = directory.contextText
    directory.contextText = () => 'The current experiment does not use files.'
    return () => { directory.contextText = contextText }
  }, 'fixture.directory-context')
  ctx.effect(() => ctx.provide('experimentStore', { latestForSession: () => null }), 'fixture.experiment')
  ctx.effect(() => ctx.provide('robotControl', { target: () => robot }), 'fixture.robot')
  ctx.effect(() => ctx.provide('labscriptaiRuntime', {
    workflow: async () => 'Read the connected robot before working on the protocol.',
    catalog: async () => [{
      name: 'robot_status', description: 'Read the connected robot.',
      inputSchema: { type: 'object', properties: { include_modules: { type: 'boolean' } } },
    }],
    async experiment(target, name, args, { sessionId }) {
      if (target !== robot || name !== 'robot_status' || args.session_id !== sessionId || args.robot_ip !== robot.origin || args.include_modules !== true) {
        throw new Error('Unexpected request to the LabscriptAI status fixture.')
      }
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, data: { modules: [{ slot: 'C1', model: 'temperatureModuleV2' }] } }) }] }
    },
  }), 'fixture.labscriptai')
}
