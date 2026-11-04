import { NativeToolExecutor } from '../packages/core/tool-executor-native/src/index.ts'

/** Suppress tool schemas and deny tool execution for the enclosing preset. */
export const name = 'chat-tools'
export const inject = ['tools']

/** @param {object} ctx Cordis context for the preset. */
export function apply(ctx) {
  const native = new NativeToolExecutor(ctx)
  ctx.tools.restrict({ allow: [] })
  ctx.tools.guard(() => 'Tools are unavailable in chat mode.')
  ctx.tools.setExecutor({
    describe: () => ({ schemas: [] }),
    execute: input => native.execute(input),
  })
}
