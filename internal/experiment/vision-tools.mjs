import { defineTool } from '../../packages/core/tools/src/schema.ts'

/** Deck-camera observation tools for the experiment assistant preset. */
export const name = 'vision-tools'
export const inject = ['tools', 'systemPrompt', 'experimentVision']

const output = {
  schema: { type: 'json' },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

/**
 * Register deck-camera tools inside the experiment-assistant preset.
 * Both tools are observation-only: they take or analyze a photo and never move
 * the robot or change persistent camera settings. Their results include a
 * ready-made Markdown image line so the chat can show the photo inline.
 * @param {object} ctx Cordis context for the preset with tools and experimentVision.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'labscriptai:deck-vision', order: 2560,
    text: 'Deck vision is available. capture_deck_photo takes one photo with the robot\'s built-in deck camera; inspect_deck runs the lab-trained detector on the newest or a chosen photo and reports which labware occupies the 12 Flex slots. After either call, place the returned photoMarkdown or annotatedMarkdown line verbatim as its own line in your reply, exactly once and outside code blocks, so the operator sees the photo inline in the chat; if the line is absent, say the photo is saved but could not be shown. Both tools are observation-only: they do not move the robot or change camera settings, and their output is not committed deck truth. Compare observations with get_robot_status and with the protocol\'s confirmed deck layout, and report conflicts instead of silently preferring one. Slots reported unknown, detections marked needsHumanReview, and low-confidence labels are uncertain and need operator confirmation; never present them as established facts. A camera photo cannot prove experimental results, liquid states, or device readiness.',
  }), 'vision-tools.guidance')

  ctx.tools.register(defineTool({
    name: 'capture_deck_photo',
    description: 'Take one photo with the physical robot\'s built-in deck camera and save it. Observation only: no robot motion and no camera setting changes. Returns a capture id, the saved path, and photoMarkdown; copy that Markdown image line verbatim into your reply once so the operator sees the photo inline in the chat. Use inspect_deck to analyze the deck layout.',
    parameters: {},
    output,
    execute: async () => ctx.experimentVision.capture(),
  }))

  ctx.tools.register(defineTool({
    name: 'inspect_deck',
    description: 'Identify the labware on the physical deck with the lab-trained local detector. Captures a fresh photo unless a capture id is supplied. Returns per-slot observations for the 12 Flex slots, detected labware with confidence, and annotatedMarkdown; copy that Markdown image line verbatim into your reply once so the operator sees the annotated photo inline. Observation only: it does not move the robot; low-confidence or unmapped detections need operator confirmation and do not replace committed deck facts.',
    parameters: {
      photoId: { type: 'string', description: 'Capture id returned by capture_deck_photo. Omit to use the newest photo.' },
    },
    output,
    async execute(args) {
      return ctx.experimentVision.inspect(args.photoId === undefined ? {} : { photoId: args.photoId })
    },
  }))
}
