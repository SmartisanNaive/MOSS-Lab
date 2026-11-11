---
kind: upgrade-guide
description: "生成实验转移协议现在要求显式提供 initialVolumeUl 参数。"
---
# 为生成的转移协议声明起始液量

[English](guide.md) | 中文

## 变更

内部实验工作流原先根据 `source`、`destinations` 和 `volumeUl` 生成转移协议，不声明起始装液。省略 `protocol` 的调用现在还必须提供 `initialVolumeUl`；缺失时以 `INVALID_INPUT` 失败。生成的协议通过 `define_liquid` 和 `load_liquid` 声明传入的起始体积。

## 迁移

1. 更新模板调用方，提供声明的起始源液体积，例如 `{ source: "A1", destinations: ["A1", "A2"], volumeUl: 50, initialVolumeUl: 1000 }`。不能用 100 µL 转移总量代替未知起始体积。该值必须有限、足够完成全部转移且不超过 15000 µL；另行计入适用的死体积。
2. 对于提供完整 Python 源码的 Agent 工具，在源码中声明已知起始液体。其可选 `parameters.initialVolumeUl` 必须与声明一致；省略时必须在 `parameters.assumptions` 中明确记录 unknown。已有存储协议保持不变；要添加声明，须修订并重新分析。
3. 运行 `node --import tsx/esm --test internal/experiment/tests/workflow.test.mjs internal/experiment/tests/agent-tools.test.mjs`，检查生成源码在吸液前使用传入体积调用 `load_liquid`。参见[内部实验参考](../../../../internal/experiment/README.zh.md)。
