# Personal Skills

个人维护的 [Agent Skills](https://skills.sh/) 集合，为 Codex、Claude Code 等编码 Agent 提供可复用的工作流。每个 skill 独立存放在 `skills/<name>/` 中。

## 当前 Skills

| Skill | 用途 |
| --- | --- |
| [`frontend-design`](skills/frontend-design/SKILL.md) | 设计、重塑和审查前端界面。 |
| [`scalable-hierarchy-html`](skills/scalable-hierarchy-html/SKILL.md) | 生成和优化可流畅浏览的超大规模层级 HTML 报告。 |
| [`session-analysis`](skills/session-analysis/SKILL.md) | 分析本地 Codex 或 Claude Code 会话并生成脱敏审计。 |

## 安装

```bash
# 查看仓库中的 skill，不执行安装
npx skills add Zigerry/personal-skills --list

# 安装一个 skill 到指定 Agent
npx skills add Zigerry/personal-skills --skill frontend-design --agent codex --global

# 将仓库中的全部 skill 安装到指定 Agent
npx skills add Zigerry/personal-skills --skill '*' --agent codex --global

# 将仓库中的全部 skill 安装到全部 Agent
npx skills add Zigerry/personal-skills --all
```

- `--skill`：选择要安装的 skill。
- `--agent`：选择目标 Agent，常用值有 `codex`、`claude-code`、`cursor` 和 `opencode`；完整列表见 [`skills` CLI 文档](https://skills.sh/docs/cli)。
- `--list`：只显示仓库中可用的 skill，不执行安装。
- `--all`：安装仓库中的全部 skill 到全部 Agent，并跳过确认。
- `--global`：安装到用户目录，所有项目都可使用；省略该参数则只安装到当前项目。`skills add` 没有 `--local` 参数。

## 使用

安装后，可在支持显式调用的 Agent 中使用 skill 名称：

```text
使用 $frontend-design 重新设计这个页面，并完成视觉复查。
```

## 添加新 Skill

在 `skills/<name>/` 下添加 `SKILL.md`，并在 frontmatter 中提供 `name` 和 `description`。需要时可附带 `agents/`、`scripts/` 等资源。

## License

[MIT](LICENSE)
