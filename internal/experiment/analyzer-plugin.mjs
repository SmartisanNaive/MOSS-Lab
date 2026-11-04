import { analyzeProtocol } from './run-example.mjs'

export const name = 'protocol-analyzer'
export const inject = ['sandbox', 'subprocess']

/** Analyze saved protocol source in a DSH-confined uv Python process. */
export function apply(ctx, config) {
  if (!config || typeof config.temporaryRoot !== 'string' || typeof config.python !== 'string' || !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0) throw new Error('protocol-analyzer requires temporaryRoot, python and a positive timeoutMs')
  ctx.effect(() => ctx.provide('protocolAnalyzer', {
    analyze(protocol) {
      return analyzeProtocol({ ...config, sandbox: ctx.sandbox, subprocess: ctx.subprocess }, protocol)
    },
  }), 'protocol-analyzer.service')
}
