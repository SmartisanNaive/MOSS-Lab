/** Authenticated, per-launch installation readiness after the MOSS services load. */
export const name = 'moss-install-readiness'
export const inject = ['connection', 'experimentStore', 'experimentWorkflow', 'experimentPreview',
  'protocolAnalyzer', 'labscriptaiRuntime', 'robotControl', 'agents', 'sessionController', 'sessionPersistence', 'agentPresets']

/**
 * Register only for a packaged launch with a private installer nonce.
 * @param {object} ctx Scoped MOSS service context.
 * @returns {void} Readiness route lifetime is owned by the context.
 */
export function apply(ctx) {
  const nonce = process.env.MOSS_RUN_NONCE
  const identity = process.env.MOSS_RELEASE_ID
  if (!/^[a-f0-9]{32}$/.test(nonce ?? '') || !/^[a-f0-9]{64}$/.test(identity ?? '')) {
    throw new Error('Packaged MOSS readiness requires its launch identity')
  }
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/moss-install-ready', methods: ['GET'], requestBody: 'buffered',
    fetch: async () => Response.json({ ready: true, nonce, identity }, { headers: { 'Cache-Control': 'private, no-store' } }),
  }), 'moss-install-readiness.route')
}
