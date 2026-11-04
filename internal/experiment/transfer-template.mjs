import { ExperimentError } from './index.mjs'

/** Generate only a single-channel Flex transfer with explicitly supplied parameters. */
export function generateTransfer(parameters) {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new ExperimentError('INVALID_INPUT', 'transfer parameters are required')
  const keys = Object.keys(parameters).sort()
  if (keys.join(',') !== 'destinations,source,volumeUl') throw new ExperimentError('INVALID_INPUT', 'provide source, destinations, and volumeUl')
  const { source, destinations, volumeUl } = parameters
  if (typeof source !== 'string' || !/^A(?:[1-9]|1[0-2])$/.test(source)) throw new ExperimentError('INVALID_INPUT', 'source must be a reservoir well A1 to A12')
  if (!Array.isArray(destinations) || destinations.length < 1 || destinations.length > 24 || destinations.some(well => typeof well !== 'string' || !/^[A-H](?:[1-9]|1[0-2])$/.test(well)) || new Set(destinations).size !== destinations.length) throw new ExperimentError('INVALID_INPUT', 'provide 1 to 24 distinct destination wells A1 to H12')
  if (typeof volumeUl !== 'number' || !Number.isFinite(volumeUl) || volumeUl < 5 || volumeUl > 200) throw new ExperimentError('INVALID_INPUT', 'volumeUl must be between 5 and 200')
  const volume = JSON.stringify(volumeUl)
  return `from opentrons import protocol_api\n\nmetadata = {"protocolName": "单通道分液预览", "description": "模拟预览；台面和源液量需现场核实"}\nrequirements = {"robotType": "Flex", "apiLevel": "2.24"}\n\ndef run(protocol: protocol_api.ProtocolContext) -> None:\n    trash = protocol.load_trash_bin("A3")\n    tips = protocol.load_labware("opentrons_flex_96_tiprack_1000ul", "C2")\n    source = protocol.load_labware("nest_12_reservoir_15ml", "B3")\n    plate = protocol.load_labware("corning_96_wellplate_360ul_flat", "C3")\n    pipette = protocol.load_instrument("flex_1channel_1000", "left", tip_racks=[tips])\n    pipette.pick_up_tip()\n    for well in ${JSON.stringify(destinations)}:\n        pipette.aspirate(${volume}, source[${JSON.stringify(source)}])\n        pipette.dispense(${volume}, plate[well])\n    pipette.drop_tip(trash)\n`
}
