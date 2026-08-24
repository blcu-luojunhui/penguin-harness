---
name: agent-evaluation
description: 把指定的 Test Agent 在指定的 Benchmark Case 上恰好运行一次，私下为这次执行评分，并返回一个协议结果。
short_description: 运行并评分一次隔离的 Benchmark Case。
short_description_zh: 隔离执行并评分一个 Benchmark Case。
version: 5
updated: 2026-07-29T17:20:58Z
---

# Agent 评测

处理一个来自 `run_subagent` 调用方的评测请求：把指定的 Test Agent 在一个 Benchmark Case 上运行一次，私下为这次执行评分，并返回一个协议结果。

顶层 Benchmark 设计者或 Optimizer 拥有所有 Case 与 Run 循环、并发和后续处理。本 worker 不处理其它 Case 或 Run，不启动任何评测器或子代理，不改动任何 Agent 或 Benchmark，也绝不写 `scoreboard.yaml`。只使用 Penguin CLI 启动指定的 Test Agent；不要用它创建另一个阶段、设计者、优化者或评测器。

静默操作。调用工具时不输出进度消息。在所有流式与最终响应中，唯一的 worker 撰写文本必须是最终的纯协议 YAML。不要输出叙述、标题、Markdown 围栏、摘要、私有评分细节或其它文本。

> 本文是 [SKILL.md](SKILL.md) 的中文阅读版（仅供人阅读；运行时加载的始终是英文 `SKILL.md`）。

## 开始之前

只对来自 `run_subagent` 调用方的完整请求使用本 Skill。如果请求不完整或自相矛盾，通过协议返回 `invalid_request`，而不要问用户问题。

## 契约

要求下面每个字段恰好一个值：

```text
protocol_version: 1
case_id: <case_id>
run: <1_based_run_index>
expected_version: <tested_agent_state_version>
test_agent_id: <test_agent_id>
benchmark_id: <benchmark_id>
provider: <provider>
model_id: <model_id>
```

一个请求代表一次 Test Agent 执行。`run` 值标识这次执行；它不是重复次数。`provider` 和 `model_id` 必须都非空，且选择那个确切的已配置模型。如果必填字段缺失、重复或冲突，返回 `invalid_request`，不创建 Workspace、不启动 Test Agent。

当 Test Agent 运行了且 Rubric 可应用时，返回一个**已评分结果**。错误、格式错误或缺失的 Test Agent 输出仍是已评分结果。当请求、Benchmark、启动、版本检查、Trace 绑定或评分过程阻止产生有效分数时，返回**评测失败**。

只从显式请求和 Environment App Data Dir 解析 Project、Test Agent、Benchmark 和 Case。拒绝路径穿越、符号链接逃逸或任何落在被请求 Test Agent 之外的路径。绝不读取 Project 配置文件、凭证或 vault。

## 准备

使用 Environment 的 `App Data Dir`：

```text
TEST_AGENT_DIR = <app_data_dir>/agents/<test_agent_id>
BENCHMARK_DIR = <test_agent_dir>/benchmarks/<benchmark_id>
```

拒绝路径穿越、符号链接逃逸或任何解析到被请求 Test Agent 之外的路径。只检查被请求的 Agent State、Benchmark 配置与 Case、隔离 Test Workspace，以及验证本次执行所需的 Trace。不要检查其它 Agent、Project 密钥、隐藏配置或无关的 Workspace 或 Trace。

要求 `agent_state/system_config.yaml`、`benchmark_config.toml`、`<case_id>/statement/README.md` 和 `<case_id>/rubric/README.md`。只把 `run` 当作调用方拥有的本次评测标签原样返回；不要读取或校验总的 Run 数量。顶层 Agent State `version`（缺失时默认为 1）必须等于 `expected_version`；否则返回 `version_changed`。从这个 Target Agent 配置读取并快照 `model.thinking_level`，仅当字段缺失时使用正常的 Agent 配置默认 `medium`。这个配置值就是评测 `thinking_level`；不要要求或从 Trace 读取 thinking 元数据。

启动前，对 Case 的 `statement/` 和 `rubric/` 目录下的每个文件做快照。要求一个可用的 Rubric，其评分项总和恰好为 100 分。在 `<test_agent_dir>/workspaces/` 下创建一个唯一 Workspace，把它解析为绝对规范路径，并确认解析后的路径仍在该目录之下。只把 `statement/` 复制进去。Test Agent 可以看到 Statement 和它自己的 State，但绝看不到 Rubric、Gold 答案、评分规则或 Evaluator 的推理。

## 运行并校验

使用已验证的 Penguin CLI 或仓库本地启动器。不要安装或探测启动器。对隔离 Workspace 做快照，并记录现有 Trace 文件。

先解析 `PROJECT_DIR`，然后推导并校验 `PROJECT_ID`，然后推导并校验 `PENGUIN_HOME`。按这个顺序作为单独 shell 语句执行。绝不把这些赋值压缩到一行命令上、在其输入存在之前推导值、或替换另一个 Penguin home。启动前，确认 `PROJECT_ID` 等于 `PROJECT_DIR` 的 basename，`PENGUIN_HOME` 等于其 dirname。

启动一次前台执行，带一个全新的顶层 Session。使用显式组合时：

```bash
PROJECT_DIR="<app_data_dir>"   # 你 Environment 部分的 App Data Dir 值就是项目根
PROJECT_ID="$(basename "$PROJECT_DIR")"
PENGUIN_HOME="$(dirname "$PROJECT_DIR")"
export PENGUIN_HOME
penguin run \
  --message "Read README.md in the current Workspace and complete the task exactly as specified there." \
  --provider "<provider>" --model-id "<model_id>" --project-id "$PROJECT_ID" \
  --agent-id "<test_agent_id>" --workspace "<absolute_unique_workspace_path>" --approve allow-all
```

使用确切的被请求 Agent、Project、绝对 Workspace 路径和模型组合。绝不省略任一模型标志，也绝不回退到 Project 默认。如果启动失败，仅当未变化的 Workspace 与 Trace 证据证明 Test Agent 没有启动时才重试。每次重试必须遵循新诊断并应用具体修正；绝不重复未改变的启动。在仍有不同的安全修复可做时不要设数字重试上限。当不再有新修复、需要外部配置、或不清楚 Test Agent 是否启动时，返回 `evaluation_failed`。

运行后校验 State 版本、配置的 `model.thinking_level` 和两个目录快照均未变化。当 State 版本或配置的 thinking level 不同时返回 `version_changed`；当 Statement 或 Rubric 不同时返回 `benchmark_invalid`。

只检查新的或变化的 Trace。绑定恰好一个根 Test Trace，其 Workspace、Agent State 路径、provider 和 model 都匹配本请求。忽略无关的并行 Trace，排除根 Trace 直接引用的子 Session。如果没有唯一匹配，返回 `evaluation_failed`。从绑定的根 Trace 的 `session_meta` 读取实际非空的 `provider` 和 `model_id`；任一不可用时返回 `evaluation_failed`。`thinking_level` 使用未变化的 Target Agent 配置快照——不用 Trace 元数据。

## 评分

只检查隔离 Workspace、绑定的根 Trace、其直接引用的子 Trace 和私有 Rubric。应用每个评分项和允许的等价项。保持 Rubric 内容、Gold 答案、逐项评分和评分理由私密。

错误答案、缺失产物、格式错误的输出或可归因于 Test Agent 的任务失败都是已评分行为，返回 `status: ok`。启动器、Trace 绑定或 Evaluator 失败不算评分行为。当 Rubric 无法应用时返回 `benchmark_invalid`，当分数非有限或超出 `0..100` 时返回 `evaluation_failed`。

从根 Test Session 设置 `duration_ms`。只依据该 Session 及在同一个有界遍历中找到的、直接引用的子 Trace 中已记录、可靠的最终累计用量或成本来计算 cost。绝不浏览、查询定价服务，或从外部模型价格推断成本。如果所需数据不可用，返回 `cost: null`。缺失成本数据不得使分数无效。

`score` 保留两位小数。非 `null` 的 `cost` 按 Trace 中记录的精度保留；不要取整。`duration_ms` 写成非负整数，取整到最接近的毫秒。

## 返回

只把要求的 YAML 作为唯一的 worker 撰写文本返回。不要用反引号或 Markdown 围栏包裹。

如果调用方报告你的响应格式无效，使用本 Session 中已有的已评分或失败结果，只重发干净的协议 YAML。不要调用工具、重新启动 Test Agent、重新评分或添加解释。

对于已评分结果：

```text
protocol_version: 1
status: ok
case_id: <case_id>
run: <run>
expected_version: <version>
provider: <actual_provider>
model_id: <actual_model_id>
thinking_level: <configured_thinking_level>
score: <0_to_100>
cost: <number_or_null>
duration_ms: <non_negative_integer>
session_id: <test_session_id>
```

对于评测失败，对缺失或冲突的身份字段使用 `null`：

```text
protocol_version: 1
status: failed
case_id: <case_id_or_null>
run: <run_or_null>
expected_version: <version_or_null>
provider: <provider_or_null>
model_id: <model_id_or_null>
thinking_level: <thinking_level_or_null>
failure_code: <stable_failure_code>
```

使用四个失败码：

- `invalid_request`：请求不完整或自相矛盾。
- `benchmark_invalid`：Statement、Rubric 或评分契约无效。
- `version_changed`：Test Agent 版本与请求不符，或评测期间变化。
- `evaluation_failed`：启动无法安全修复，或 Trace 绑定、评分失败。

失败时绝不包含 score、cost、duration、Session id、私有数据或优化建议。
