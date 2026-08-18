# Personal Skills

个人维护的 Codex plugin 与独立 [Agent Skills](https://skills.sh/) 集合。

## Codex Plugin：Grill Codex

[`grill-codex`](plugins/grill-codex/.codex-plugin/plugin.json) 将 4 个相关工作流作为一个插件安装，同时保持每个 skill 独立触发：

| Skill | 用途 |
| --- | --- |
| [`grill-me-codex`](plugins/grill-codex/skills/grill-me-codex/SKILL.md) | 对模糊或高风险需求逐项追问、冻结方案并独立审查。 |
| [`grill-with-docs-codex`](plugins/grill-codex/skills/grill-with-docs-codex/SKILL.md) | 对照领域术语、`CONTEXT.md`、ADR 和代码明确方案。 |
| [`codex-review`](plugins/grill-codex/skills/codex-review/SKILL.md) | 使用独立只读 subagent 对已有方案进行多视角审查。 |
| [`codex-build`](plugins/grill-codex/skills/codex-build/SKILL.md) | 按已批准方案保持单一写入者实施、验证和复查。 |

这些 skill 改编自 [chaseai-yt/grill-me-codex](https://github.com/chaseai-yt/grill-me-codex)，已重写为 Codex 原生多代理工作流，不依赖其他编程工具、第三方 skill 或嵌套 Codex CLI。

### 从 GitHub 安装

先添加本仓库的 marketplace，再安装插件：

```bash
# marketplace 只需添加一次
codex plugin marketplace add Zigerry/personal-skills

# 安装或重新安装整套插件
codex plugin add grill-codex@personal
```

更新已添加的远程 marketplace 后，重新安装插件：

```bash
codex plugin marketplace upgrade personal
codex plugin add grill-codex@personal
```

安装或更新后开启一个新会话，让 Codex 重新加载插件中的 skill。

### 本地开发安装

在本仓库根目录执行：

```bash
codex plugin marketplace add .
codex plugin add grill-codex@personal
```

本地源和 GitHub 源二选一，不要同时注册两个同名的 `personal` marketplace。

### 自动路由

正常对话中，Codex 会根据 `SKILL.md` 的 `description` 自动选择，不要求每次输入 `$skill-name`：

| 当前任务状态 | 自动路由 |
| --- | --- |
| 模糊或高风险需求，需要逐项对齐 | `grill-me-codex` |
| 还需同步 `CONTEXT.md`、领域术语或 ADR | `grill-with-docs-codex` |
| 已有完整方案，只需压力测试 | `codex-review` |
| 方案已批准，用户明确要求实施 | `codex-build` |

支持 subagent 时采用独立并行审查；不支持时由主代理分角色顺序复查。这 4 个 skill 不调用、不依赖、也不捆绑 Superpowers。若用户另外安装了 Superpowers，只需遵守通用的流程所有权规则：同一任务只能有一个规划主流程和一个执行主流程；这是共存边界，不是集成关系。

## 独立 Skills

以下 skill 不属于 `grill-codex` plugin，仍可使用 `npx skills` 单独安装：

| Skill | 用途 |
| --- | --- |
| [`frontend-design`](skills/frontend-design/SKILL.md) | 设计、重塑和审查前端界面。 |
| [`scalable-hierarchy-html`](skills/scalable-hierarchy-html/SKILL.md) | 生成和优化可流畅浏览的超大规模层级 HTML 报告。 |
| [`session-analysis`](skills/session-analysis/SKILL.md) | 分析本地 Codex 或 Claude Code 会话并生成脱敏审计。 |

```bash
# 查看仓库中的独立 skill
npx skills add Zigerry/personal-skills --list

# 安装一个独立 skill 到 Codex
npx skills add Zigerry/personal-skills --skill frontend-design --agent codex --global
```

`npx skills` 是 skill 安装器，不会处理 `.codex-plugin/plugin.json` 或 marketplace，因此不再用于安装 `grill-codex` 整套插件。

## 添加内容

- 插件内的新 workflow 放在 `plugins/grill-codex/skills/<name>/`。
- 独立 skill 放在 `skills/<name>/`。
- 每个 skill 的 `SKILL.md` 必须提供 `name` 和 `description`；需要时可附带 `agents/`、`scripts/` 等资源。

## License

[MIT](LICENSE)。引入内容的版权和许可见 [插件第三方声明](plugins/grill-codex/THIRD-PARTY-NOTICES.md)。
