---
kind: upgrade-guide
description: "Generated experiment transfers now require an explicit initialVolumeUl parameter."
---
# Declare initial liquid volume for generated transfers

English | [中文](guide.zh.md)

## Change

The internal experiment workflow previously generated transfers from `source`, `destinations`, and `volumeUl` without declaring initial liquid loading. Calls that omit `protocol` now also require `initialVolumeUl`; missing values fail with `INVALID_INPUT`. Generated protocols declare this supplied starting volume with `define_liquid` and `load_liquid`.

## Migration

1. Update template callers to supply the declared starting source volume, for example `{ source: "A1", destinations: ["A1", "A2"], volumeUl: 50, initialVolumeUl: 1000 }`. Do not substitute the 100 µL transfer total for an unknown starting volume. The value must be finite, cover all transfers, and be at most 15000 µL; account separately for applicable dead volume.
2. For Agent tools that supply complete Python source, declare known starting liquids in that source. Their optional `parameters.initialVolumeUl` must match the declaration; when omitted, explicitly record unknown in `parameters.assumptions`. Existing stored protocols are unchanged; revise and analyze them again to add declarations.
3. Run `node --import tsx/esm --test internal/experiment/tests/workflow.test.mjs internal/experiment/tests/agent-tools.test.mjs` and inspect the generated source for the supplied `load_liquid` volume before aspiration. See the [internal experiment reference](../../../../internal/experiment/README.md).
