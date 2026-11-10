# Issue 管理

[English](README.md) | 中文

MOSS-Lab 在仓库内执行 PR 描述检查；上游组织 Project 看板及其 GitHub App 不属于本仓库。

## PR 策略

[Issue policy](../workflows/issue-policy.yml) 从受信任的默认分支取工作流定义，对每个非草稿、由人类创建的 PR 运行。PR 需要非空标题，以及去除 HTML 注释后仍有内容的正文；HTML 注释与隐藏文本不计入描述。草稿 PR 与 Bot/App 作者（包括 Dependabot）豁免并成功结束。

检查使用仓库 `GITHUB_TOKEN` 读取 PR 实时状态；不使用任何 secret，除 checkout 外不使用外部 action，也不向 GitHub 写入。

## 验证

在仓库根目录运行无密钥的定向测试：

```sh
node .github/issue-management/policy.test.mjs
```

[工作流测试](../../scripts/ci-workflow.spec.ts)校验触发与权限声明。

## 限制

检查只校验描述。上游的标签分类、优先级匹配与 Project 生命周期跟踪依赖组织 Projects 与专用 GitHub App；本仓库有意不复刻。
