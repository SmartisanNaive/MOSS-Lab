import { ExperimentError } from './index.mjs'

/** Generate only a single-channel Flex transfer with explicitly supplied parameters. */
export function generateTransfer(parameters) {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new ExperimentError('INVALID_INPUT', 'transfer parameters are required')
  const keys = Object.keys(parameters).sort()
  if (keys.join(',') !== 'destinations,initialVolumeUl,source,volumeUl') throw new ExperimentError('INVALID_INPUT', 'provide source, destinations, volumeUl, and initialVolumeUl')
  const { source, destinations, volumeUl, initialVolumeUl } = parameters
  if (typeof source !== 'string' || !/^A(?:[1-9]|1[0-2])$/.test(source)) throw new ExperimentError('INVALID_INPUT', 'source must be a reservoir well A1 to A12')
  if (!Array.isArray(destinations) || destinations.length < 1 || destinations.length > 24 || destinations.some(well => typeof well !== 'string' || !/^[A-H](?:[1-9]|1[0-2])$/.test(well)) || new Set(destinations).size !== destinations.length) throw new ExperimentError('INVALID_INPUT', 'provide 1 to 24 distinct destination wells A1 to H12')
  if (typeof volumeUl !== 'number' || !Number.isFinite(volumeUl) || volumeUl < 5 || volumeUl > 200) throw new ExperimentError('INVALID_INPUT', 'volumeUl must be between 5 and 200')
  if (typeof initialVolumeUl !== 'number' || !Number.isFinite(initialVolumeUl) || initialVolumeUl < volumeUl * destinations.length || initialVolumeUl > 15000) throw new ExperimentError('INVALID_INPUT', 'initialVolumeUl must cover all transfers and be at most 15000; supply the declared starting volume, not a calculated transfer total')
  const volume = JSON.stringify(volumeUl)
  return `from opentrons import protocol_api\n\nmetadata = {"protocolName": "单通道分液预览", "description": "模拟预览；台面和源液量需现场核实"}\nrequirements = {"robotType": "Flex", "apiLevel": "2.24"}\n\ndef run(protocol: protocol_api.ProtocolContext) -> None:\n    trash = protocol.load_trash_bin("A3")\n    tips = protocol.load_labware("opentrons_flex_96_tiprack_1000ul", "C2")\n    source = protocol.load_labware("nest_12_reservoir_15ml", "B3")\n    plate = protocol.load_labware("corning_96_wellplate_360ul_flat", "C3")\n    pipette = protocol.load_instrument("flex_1channel_1000", "left", tip_racks=[tips])\n    liquid = protocol.define_liquid(name="Source liquid", description="Declared initial source liquid; verify on site", display_color="#0088CC")\n    source[${JSON.stringify(source)}].load_liquid(liquid=liquid, volume=${JSON.stringify(initialVolumeUl)})\n    pipette.pick_up_tip()\n    for well in ${JSON.stringify(destinations)}:\n        pipette.aspirate(${volume}, source[${JSON.stringify(source)}])\n        pipette.dispense(${volume}, plate[well])\n    pipette.drop_tip(trash)\n`
}
