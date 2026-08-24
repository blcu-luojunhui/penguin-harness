---
name: agent-optimization
description: 通过冻结 Benchmark 上的版本化分数与分数关联 Trace 改进一个 Agent State。
short_description: 根据测量的 Benchmark 结果改进 Agent。
short_description_zh: 根据 Benchmark 结果改进 Agent。
version: 9
updated: 2026-08-04T00:00:00Z
---

# Agent 优化

通过 证据 → 假设 → Candidate → 评测 → 接受或回滚 的循环改进一个 Test Agent。把公开 Statements、分数和 Test Traces 当作黑盒反馈。把每次评测都委托给 `agent-evaluation` 子代理；绝不直接运行或评分 Test Agent。

> 本文是 [SKILL.md](SKILL.md) 的中文阅读版（仅供人阅读；运行时加载的始终是英文 `SKILL.md`）。

## 开始之前

如果请求没有指明 Test Agent、冻结 Benchmark、期望目标分数、正的 Run 数量和轮次上限，问清缺失的输入。当它们已经提供时，直接继续，不要请用户复述。

## 目标与契约

要求一个显式 Test Agent、一个带完整有效 Formal Baseline 的冻结 Benchmark、一个期望目标分数、一个正的 `runs` 值和一个正的轮次上限。`runs` 是本优化 Session 中每个 Candidate 的每个 Case 的 Run 数量。为本 Session 冻结它；不要从 `benchmark_config.toml` 或 Formal Baseline 推断。从与当前 Agent State 匹配的完整 Evaluation 中读取评测 `(provider, model_id, thinking_level)`；不要要求用户重复。缺少运行时任一部分的 Evaluation 就是不完整的，不能用作 Reference。顶层 Session 必须提供 `run_subagent`，且当前 Agent 必须拥有 `agent-evaluation` Skill。任一前置条件缺失，停下来解释需要什么。不要创建缺失的 Agent、Benchmark 或 Baseline，也不要直接评测 Test Agent。

**Reference** 是当前作为最优保留的 Agent State，连同它在冻结 Benchmark 上的完整 Evaluation。

每轮从 Reference 出发，测试一个有界、通用的 **Candidate**。在冻结 Case 集上以请求的 `runs` 数量和 Reference 评测运行时评测每个 Candidate。初始 Formal Baseline 每个 Case 一次 Run；不要把它重跑或补齐到请求的数量。即使 Run 数量不同，也直接把每个 Candidate 存储的顶层平均值与当前 Reference 分数比较。仅当变更可接受、其 Evaluation 完整有效、且其顶层 `score` 严格高于 Reference Evaluation 的 `score` 时，才接受 Candidate。被接受的 Candidate 及其 Evaluation 成为下一个 Reference；否则恢复之前的 Reference。当 Reference 达到期望目标时提前停止；否则运行不超过请求数量的完整有效 Candidate 轮次。

## 访问与变更

从 Environment 的 App Data Dir 解析路径，不递归发现 Project：

```text
PROJECT_DIR = <app_data_dir>
PROJECT_ID = <basename_of_project_dir>
PENGUIN_HOME = <parent_of_project_dir>
TARGET = <app_data_dir>/agents/<test_agent_id>
STATE = <target>/agent_state
TRACES = <target>/traces
BENCHMARK = <target>/benchmarks/<benchmark_id>
SCOREBOARD = <benchmark>/scoreboard.yaml
SNAPSHOTS = <target>/snapshots
```

只检查被请求的 Test Agent 和 Benchmark：Agent State、公开 Statements、Scoreboard，以及来自 Baseline 和本次优化的分数关联 Test Traces 或产物，包括被拒绝的 Candidate。

不要检查 Rubrics、Gold 答案、私有评分条件、Evaluator State、Workspace 或 Trace、其它 Agent 或 Project 密钥。如果私有评测信息进入 Optimizer 上下文，恢复活动 Candidate 并作为已污染停止。

只修改 Test Agent State 和为保护它所需的版本化快照。不要改变冻结的 Benchmark、Test Traces 或 Project 配置。唯一的 Benchmark 写入是把完整的已接受 Candidate Evaluation 追加到 `scoreboard.yaml`。

## 优化循环

每轮：

1. **建立 Reference。** 确认其完整 Evaluation 覆盖冻结 Case 集、使用冻结评测运行时、且与当前 Agent State 版本匹配。不要要求其 Run 数量等于请求的 Candidate `runs` 数量。
2. **诊断能力缺口。** 比较每个 Case 的 `runs[].score`（固定 `0..100` 标尺）；只对整版本比较使用 Evaluation 的顶层平均 `score`。使用公开 Statements、分数关联 Test Traces，以及此前接受或拒绝的尝试，找出通用 Agent State 变更能改善的可观察行为。用重复 Runs 区分稳定行为与波动。
3. **陈述可证伪的假设。** 选择要处理的相关缺口，把它们连到一个有界 Candidate，并陈述哪些可观察决策或产物应改变以及为什么。只增加分析步骤而不预测行为变化的变更不是有用的假设。如果当前诊断已穷尽，用剩余的公开证据和此前尝试构造一个不同的可接受 Candidate。
4. **从 Reference 创建一个 Candidate。** 按下面的构造与回滚规则应用变更及其 Candidate 版本。不要把被拒绝的 Candidate 文件带进下一次尝试。
5. **检查可接受性。** 确认变更是通用的、不使用私有评测信息、且只修改允许的 Test Agent State。
6. **评测 Candidate。** 在评测规则下并行委托完整冻结 Case 集 × 请求 `runs` 矩阵，并组装所有返回的 cell。任何 cell 在途时都不要修改 Candidate。
7. **决定。** 仅当每个 cell 都有效且其 Evaluation 的顶层平均 `score` 严格高于 Reference Evaluation 的 `score` 时接受 Candidate。否则恢复 Reference。单独记录预测的 Case 行为是否变化；即使陈述的假设未被支持，更高的 Evaluation 分数也接受 Candidate。
8. **持久化并继续。** 在开始另一轮之前，立即追加并校验每个已接受的 Candidate Evaluation。被接受的 Candidate 成为下一个 Reference。只把来自被拒绝 Candidate 的有效结果当作后续假设的证据。当 Reference 达到期望目标时停止。否则完成请求数量的有效 Candidate 轮次，除非基建、污染、并发 State 变更或无法构造任何可接受 Candidate 构成具体阻塞。到达轮次上限时，保留最高分的已接受 Reference。

一轮只在某个 Candidate 拥有完整有效 Evaluation 后才算数。修正请求、有效性修复和评测重试不消耗轮次上限。被拒绝 Candidate 的完整有效 Evaluation 算一轮。

## 构造并回滚 Candidate

每轮从当前 Reference 创建一个 Candidate。把行为指导放进 `AGENTS.md`，把可复用的目标自有能力放进一个专注的 Skill，把运行限制放进安全的 `system_config.yaml` 字段。不要编辑 `system_prompt`（除非被请求）、不要为目标特定行为修改库提供的 Skill、不要改变 `model.thinking_level`；Reference Scoreboard 固定评测 thinking level。

Candidate 版本号只增不减。从 `Reference version + 1` 开始，绝不复用被拒绝的版本。在改变 Agent State 之前，保存原始内容并记录 Candidate 创建的任何文件。

在改变每个 Reference State 之前，确保 `<target>/snapshots/v<Reference version>.tar.gz` 存在。存在就复用。否则在编辑之前自己创建它：原子归档 `agent_state/` 并排除 `.vault.toml`；校验归档的版本，绝不覆盖同版本已有快照。如果快照创建失败，在改变 Agent State 之前停止并报告失败。

保留确切的原始文件记录，用于轮内快速回滚。

如果 Candidate 被拒绝或无法评测，恢复 Reference 文件和版本、删除 Candidate 创建的文件并校验恢复。如果另一进程改变了 Agent State，停止而不覆盖它。

## 委托评测

对每个冻结 Case，派发恰好请求数量的 Run cell，使用从 1 开始的 Run 索引 `1..runs`。对每个 cell 调用 `run_subagent`，带：

```text
Use the `agent-evaluation` Skill. Run the specified Test Agent on the specified Case exactly once, then score that single execution.
protocol_version: 1
case_id: <case_id>
run: <1_based_run_index>
expected_version: <test_agent_state_version>
test_agent_id: <test_agent_id>
benchmark_id: <benchmark_id>
provider: <provider>
model_id: <model_id>
```

检查完整的流式与最终 worker 响应。在读取 `status`、`score` 或任何其它协议字段之前，确认 worker 撰写的文本恰好是一个纯协议 YAML 文档。叙述、标题、代码围栏、摘要或评分细节都不是有效协议。让同一个 Evaluator 基于其已有结果只重发干净 YAML；不要为格式修复重跑 Test Agent，也不要自己从无效响应中提取 YAML。`run_subagent` 添加的传输元数据不是 worker 撰写的文本。出现私有评测信息时，按上面的污染规则处理。

对每个已评分结果，要求其实际 `provider`、`model_id` 和 `thinking_level` 等于 Reference 运行时。不匹配会使 Candidate 矩阵无效并停止优化；绝不比较或记录在不同运行时下产生的分数。

纠正并重发 `invalid_request`。在 `version_changed` 或 `benchmark_invalid` 时停止。

对 `evaluation_failed`，保持同一个 Candidate 和不完整矩阵。让同一个 Evaluator 诊断并修复失败的 cell，然后在有证据证明 Test Agent 未启动时只重跑那个 cell。每次重试必须应用新的、具体的修复；绝不重复未改变的请求或启动，也不要在仍有不同的安全修复可做时设置数字重试上限。不要检查私有 Evaluator State，也不要放弃 Candidate 去设计下一个版本。当不再有新的安全修复、需要外部配置、或不清楚 Test Agent 是否启动时停止。

## 记录与报告

每次接受后立即把每个完整已接受的 Candidate Evaluation 追加到 `scoreboard.yaml`，并在继续之前校验存储的版本、分数、矩阵和 Session id。从环境获取当前 UTC 时间戳，例如用 `date -u +"%Y-%m-%dT%H:%M:%SZ"`，而不要从显示的本地时间推断 UTC。使用与 Baseline 相同的字段名：

```yaml
- time: <ISO-8601 timestamp>
  version: <Candidate version>
  provider: <provider>
  model_id: <model_id>
  thinking_level: <thinking_level>
  summary_title: >-
    <public title>
  summary: >-
    <public summary>
  score: <average of the Case scores>
  cost: <average of known Case costs, or null when every Case cost is null>
  duration_ms: <average of the Case durations>
  cases:
    - case: <case_id>
      score: <average of the Run scores>
      cost: <average of known Run costs, or null when every Run cost is null>
      duration_ms: <average of the Run durations>
      runs:
        - score: <Run score>
          cost: <Run cost or null>
          duration_ms: <Run duration>
          session_id: <Test Session id>
```

写完以后，解析完整的 `scoreboard.yaml` 并在报告成功或继续之前校验追加的 Evaluation。

每个 Run 和 Case 分数都在固定 `0..100` 标尺上。不要写 `max_score`。直接在 Scoreboard 里计算并写入每个 Case 和 Evaluation 平均值：对成本求平均时忽略 `null` 值，且仅当所有贡献成本都未知时才写 `null`；`score` 平均值保留两位小数，`cost` 平均值保留六位小数，`duration_ms` 平均值取最接近的整数。这些存储值是权威的——不要添加会重算或校验它们的 server、前端、脚本或一致性检查。不要添加 `aggregate` 对象，也不要使用 `case_id`、`mean_score`、`mean_cost` 或 `mean_duration_ms`。不要把被拒绝的 Candidate 记录进 Scoreboard。

报告 Baseline 和每个完整评测过的 Candidate，含其分数、Run 数量、版本、变更、决定和 Test Session id。让单 Run 的 Formal Baseline 和请求的 Candidate `runs` 数量保持显式。对每个 Candidate，把接受决定与它的陈述假设是否被预测的 Case 行为支持区分开。包含最终保留的版本、停止原因和已知局限。绝不报告未经评测的 Agent State 的分数。
