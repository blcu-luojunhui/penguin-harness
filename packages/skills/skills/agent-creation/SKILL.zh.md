---
name: agent-creation
description: 根据用户需求创建一个可用的 Agent：编写 AGENTS.md、设置身份元数据，并只安装需要的 Skill。
short_description: 把需求变成可用的 Agent。
short_description_zh: 把需求变成可用的 Agent。
version: 7
updated: 2026-08-03T04:03:59Z
---

# Agent 创建

本 Skill 把一个用户需求变成一份可用的 Agent 配置——即目标 agent 目录里的一堆普通文件。

> 本文是 [SKILL.md](SKILL.md) 的中文阅读版（仅供人阅读；运行时加载的始终是英文 `SKILL.md`）。

## 开始之前

如果用户的消息只是调用了本 Skill（例如「use agent-creation skill」）而没有具体需求，问清用户想要什么 Agent、用来做什么。但当需求已经很具体——哪怕只是一句话，比如「一个精通 X 的专家」——**不要再追问**：从这句话推导角色和规则、套用下面的默认值，并在最终回复里列出你的假设。

## 解析继承的运行时

把当前 Agent 当作 **Builder**。在创建新 Agent 之前解析运行时：

- `provider` 和 `model_id` 是一组成对的值。如果用户显式提供两者，用这组值。如果两者都不提供，从 Environment 继承当前 Builder Session 的 `Provider` 和 `Model ID`。拒绝只提供一半的组合。
- `thinking_level` 是独立的。如果用户显式提供，用该值。否则读取 Builder 自己的 `agent_state/system_config.yaml` 里的 `model.thinking_level`；字段缺失时用 Agent 配置的默认 `medium`。

把解析出的 `thinking_level` 写进一个全新 Target Agent 的 `model.thinking_level`，并保留所有其余复制的 `model` 字段。Penguin 不在 Agent State 中持久化 `provider` 或 `model_id`，所以永远不要向 `system_config.yaml` 添加这两个字段。当同一个请求继续进入 Benchmark 设计时，把已解析的模型组合显式带过去，使评测使用 Builder 运行时而不是 Project 默认。配置既有 Agent 时，只有当用户显式要求该运行时变更时，才修改 `model.thinking_level`。

## 定位目标 agent

本 Project 的所有 agent 并排放在 App Data Dir 下的 `agents/` 里：

```bash
APP_DATA_DIR="<app_data_dir>"     # 你 Environment 部分的 App Data Dir 值
ls "$APP_DATA_DIR/agents"         # 现有 agents（每个是一个文件夹）
TARGET="$APP_DATA_DIR/agents/<agent_id>"   # 要配置的 agent
```

一个 agent 目录包含 `agent_state/`（`system_config.yaml`、`AGENTS.md`、`skills/`、`memory/`、`tools/`）以及 `scratchpad/`——还有 `traces/`，一旦该 agent 至少运行过一次就会出现。

## 编写 AGENTS.md

`agent_state/AGENTS.md` 会被注入到 agent 的系统提示词中——在这里，用户需求变成行为。保持 `system_config.yaml` 的 `system_prompt` 不动（那是稳定的系统层）；把一切需求专属的内容放进 AGENTS.md：

- 角色（Role）——这个 agent 是做什么的，一两句话。
- 领域指导（Domain guidance）——从用户需求推导出的具体规则、步骤和约束。

要简洁：AGENTS.md 是提示词上下文，不是文档。对于一个从知识库回答的领域专家，一份好的 AGENTS.md 只有几行：角色句、『严格按提供的上下文块回答』、引用规则（『按行内 [1][2] 引用块』）、对上下文无法回答的问题的拒绝规则，以及『按提问的语言回答』。

## 安装 skills

一个 skill 是目录 `agent_state/skills/<skill_name>/`，内含一个 `SKILL.md`：

```md
---
name: <skill_name>
description: <skill_description>
version: <自然数 —— 每次内容变更都递增>
updated: <ISO 8601 时间戳 —— 与 version 一起更新>
---

<skill_instructions>
```

frontmatter 还可以带可选的 `short_description` 和 `short_description_zh` 行（供 UI 显示的一段简短介绍及其中文变体）——UI 优先用它们展示，而提示词注入始终使用英文 `description`。

安装本身就完成了全部工作：`skills/` 下每个 `SKILL.md` 的 frontmatter 元数据会自动注入到目标 agent 的系统提示词中——不要到 AGENTS.md 里注册 skill。

自己写 skill，或用 shell 命令（`curl`、`git clone`）从网上取现有的，放到 `skills/` 下。任何从网上取来的东西都必须先完整阅读并审查再安装——skill 会成为目标 agent 在今后每个会话都会遵循的持久指令；绝不安装一个你还没读过的，并告诉用户它做什么。

库中的 skill 可以从任何已装有的 agent 复制（比如 `default_agent`，它自带整个库）——复制整个 `skills/<skill_name>/` 目录。常见组合，以免给目标配少了：

- **应用构建者**（构建应用或 Web 前端）：`penguin-sdk`、`web-design`、`agenthub-models`。
- **知识专家**（基于文档集回答问题）：通常**不需要** harness agent——改用它自带嵌入 agent 的 penguin-sdk skill 构建 RAG 应用，并配置应用的嵌入 agent（见下）。
- **评测循环**：`benchmark-design`、`agent-evaluation`、`agent-optimization`。

创建 Test Agent 时，只安装它解决普通任务所需的能力。

## 设置名称与描述

在目标的 `agent_state/system_config.yaml` 中，设置顶层 `name:` 和 `description:` 字段，使该 agent 在列表中可辨认。对于既有 Agent，除非用户显式要求 `thinking_level` 变更，只编辑这两个字段。

## 创建全新 agent

优先配置用户已创建的 agent。如果用户要求新 Agent，确认 `TARGET` 不存在。如果已存在，停下来告诉用户；绝不静默覆盖、重新初始化或在同一 id 下复用一个既有 Agent。

确认目标不存在后，用字母、数字、`_` 或 `-` 选一个短 id，以默认 Agent 的 `system_config.yaml` 为基底复制，并创建上面描述的目录结构：

```bash
mkdir -p "$TARGET/agent_state/skills" "$TARGET/agent_state/memory" "$TARGET/agent_state/tools" "$TARGET/scratchpad"
cp "$APP_DATA_DIR/agents/default_agent/agent_state/system_config.yaml" "$TARGET/agent_state/"
```

然后设置顶层 `name`、`description` 和 `version: 1`，把 `model.thinking_level` 设为解析值，写 `agent_state/AGENTS.md`（它位于 `agent_state/` 下，而不是 agent 目录根），并只安装用户需求所需的 Skill。不要把解析出的 provider/model 组合持久化到 Agent State。

## 校验并报告

完成前：

- 解析 `agent_state/system_config.yaml` 并确认 `name`、`description`、一个正整数 `version` 和预期的 `model.thinking_level`；
- 确认 `agent_state/AGENTS.md` 存在且非空；
- 确认每个已安装 Skill 的 `SKILL.md` 可解析，且其 `name` 与目录名一致；
- 确认 `TARGET` 之外的 Agent 没有被改动。

报告目标路径、是配置了既有 Agent 还是创建了新 Agent、假设、已安装的 Skill、解析出的运行时及每个值是用户指定还是继承来的，以及校验结果。

## SDK 应用的嵌入 agent

用 penguin-sdk skill 构建的应用在项目内自带自己的 agent（`createAgent({ root })` 首次运行时在 `<app>/penguin_data/default_project/agents/default_agent/` 初始化）。该目录的布局与这里描述的完全一致，本 Skill 里的所有内容都适用于它：把应用的个性写进它的 `agent_state/AGENTS.md`（penguin-sdk 配方把事实来源保留在项目的 `persona.md` 中，并在 ingest 时复制进去），并在 `system_config.yaml` 里设置 `name`/`description` 使应用可辨认。这就是『应用成为 X 的专家』的实现方式：个性存在于嵌入 agent 的 AGENTS.md 中，而不是应用代码里。
