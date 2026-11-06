import { existsSync } from 'node:fs'
import { createRobotClient } from './robot-client.mjs'
import { createVisionService, VISION_ROUTE } from './vision.mjs'

export const name = 'robot-vision'
export const inject = ['connection']

/**
 * Provide deck-camera photo capture and local deck analysis.
 * Capture and analysis are observation-only: they never move the robot and never
 * change persistent camera settings. OPENTRONS_URL is read once at load time;
 * an empty value leaves capture unavailable while the service stays mounted.
 * @param {object} ctx Cordis context with the authenticated connection carrier.
 * @param {object} config Robot URL, Python environment, vision script and weights, and limits.
 */
export function apply(ctx, config) {
  if (!config || typeof config.url !== 'string'
    || typeof config.python !== 'string' || !config.python.trim()
    || typeof config.script !== 'string' || !config.script.trim()
    || typeof config.weights !== 'string' || !config.weights.trim()
    || typeof config.captureRoot !== 'string' || !config.captureRoot.trim()
    || typeof config.calibrationPath !== 'string'
    || !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0
    || !Number.isSafeInteger(config.maxImageBytes) || config.maxImageBytes <= 0
    || !Number.isSafeInteger(config.analyzeTimeoutMs) || config.analyzeTimeoutMs <= 0) {
    throw new Error('robot-vision requires url, python, script, weights, captureRoot, calibrationPath, and positive timeoutMs, maxImageBytes, and analyzeTimeoutMs')
  }
  if (!existsSync(config.script)) throw new Error(`robot-vision vision script not found: ${config.script}`)
  if (!existsSync(config.weights)) throw new Error(`robot-vision weights not found: ${config.weights}`)
  const url = config.url.trim()
  const client = url === '' ? null : createRobotClient({ url, timeoutMs: config.timeoutMs, maxBytes: config.maxImageBytes })
  const service = createVisionService({
    client,
    python: config.python,
    script: config.script,
    weights: config.weights,
    captureRoot: config.captureRoot,
    calibrationPath: config.calibrationPath,
    analyzeTimeoutMs: config.analyzeTimeoutMs,
  })
  ctx.effect(() => ctx.provide('experimentVision', service), 'robot-vision.service')
  ctx.effect(() => ctx.connection.fetch.register({
    path: VISION_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: request => service.fetch(request),
  }), 'robot-vision.route')
}
