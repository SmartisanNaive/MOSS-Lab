"""示例模拟：单通道将水从储液槽分装到四个孔，不代表现场实验。"""
from opentrons import protocol_api

metadata = {
    "protocolName": "模拟示例：单通道分装 50 µL 到四孔",
    "description": "仅供本地模拟。耗材、台面及水量均为假设，未核实现场情况。",
}
requirements = {"robotType": "Flex", "apiLevel": "2.24"}


def run(protocol: protocol_api.ProtocolContext) -> None:
    trash = protocol.load_trash_bin("A3")
    tips = protocol.load_labware("opentrons_flex_96_tiprack_1000ul", "C2")
    source = protocol.load_labware("nest_12_reservoir_15ml", "B3")
    plate = protocol.load_labware("corning_96_wellplate_360ul_flat", "C3")
    pipette = protocol.load_instrument("flex_1channel_1000", "left", tip_racks=[tips])
    # Example assumption: 1000 µL initially loaded, not the 200 µL transfer total.
    water = protocol.define_liquid(name="Water", description="Assumed example starting liquid; confirm on site", display_color="#0088CC")
    source["A1"].load_liquid(liquid=water, volume=1000)
    pipette.pick_up_tip()
    for well in ("A1", "A2", "A3", "A4"):
        pipette.aspirate(50, source["A1"])
        pipette.dispense(50, plate[well])
    pipette.drop_tip(trash)
