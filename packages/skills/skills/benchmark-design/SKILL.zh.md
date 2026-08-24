---
name: benchmark-design
description: 设计并校准一个多 Case 能力 Benchmark，并建立可追溯的 Formal Baseline。
short_description: 设计并校准 Agent 能力 Benchmark。
short_description_zh: 设计并校准 Agent 能力评测 Benchmark。
version: 7
updated: 2026-08-04T00:00:00Z
---

# Benchmark 设计

为一个 Test Agent 构建多 Case Benchmark，每个 Case 运行一次来校准难度，并把选定的冻结 Pilot 记录为 Formal Baseline。

本 Skill 只改动 Benchmark，绝不改动 Test Agent。它不运行也不评分 Test Agent。每次评测都用 `run_subagent` 委托，并告诉每个 worker 使用 `agent-evaluation`。在 Baseline 之后停止；不要开始优化。

> 本文是 [SKILL.md](SKILL.md) 的中文阅读版（仅供人阅读；运行时加载的始终是英文 `SKILL.md`）。

## 开始之前

如果请求没有指明 Test Agent、目标能力、期望基线分数和 Pilot 迭代上限，问清缺失的输入。当它们已经提供时，直接继续，不要请用户复述。把当前 Agent 当作 **Builder**。用户指定的评测 `(provider, model_id)` 优先；否则从 Environment 继承当前 Builder Session 的完整 `Provider` 和 `Model ID`。绝不用 Project 默认作为隐式评测运行时。

## 工作流

- **Pilot** 是一次每个 Case 运行一次的评测，用来改进 Benchmark。未被选中的 Pilot 结果绝不进入 Scoreboard；被选中的结果在 Freeze 后成为 Formal Baseline。
- **Freeze** 指 Benchmark 修订版和评测设置停止变化。
- **Formal Baseline** 是被选中的完整有效 Pilot 修订版在被接受后的结果，记录于该确切修订版在一个未变化的 Agent State 版本上冻结之后。

按这个顺序进行：

1. 校验 Test Agent、目标能力、已解析的评测 Runtime 和评测访问权限。
2. 编写能力契约（Capability Contract），定义要测量的可观察过程、常见的更弱行为，以及 Benchmark 应训练的通用 Agent State 改进。
3. 规划完整的初始 Case 集与分值分配。对每个 Case，私下记录预期行为、一个强 Test Agent 可能走的合理捷径，以及该 Case 如何区分两者。编写并泄漏检查完整的初始 Benchmark。
4. 为每个已规划的 Case 完成一次有效评测。这些结果合起来构成 Pilot 迭代 1；先完成这一整套，再精炼任何 Case。
5. 对后续 Pilot 迭代，用分数和 Trace 重建 Test Agent 是如何解每个 Case 的。单次迭代可以精炼多个 Case 或多个难度维度；重跑所有受影响的 Case。
6. 冻结第一个达到期望基线分数的有效 Pilot 修订版。若在请求的有效迭代上限内没有一个达到，则恢复并冻结分数最低的有效 Pilot 修订版。
7. 当每个 cell 都有效、Agent State 版本保持不变、且没有已知设计缺陷时，冻结所选修订版并把其完整的每个 Case 运行一次的 Pilot 结果记录为 Formal Baseline。不要重跑或补齐它。Formal 分数不决定有效性。

## 设置与访问

需要 Test Agent id、目标能力、固定 `0..100` 标尺上的期望基线分数，以及一个正的 Pilot 迭代上限。必要时推导一个简短语义化的 Benchmark id。在第一次 Pilot 之前一次性解析 `(provider, model_id)`：用户提供的完整组合优先，否则从 Environment 继承当前 Builder Session 的 `Provider` 和 `Model ID`。拒绝只给一半的组合或不可用的继承值。从 Test Agent 的 `agent_state/system_config.yaml` 的 `model.thinking_level` 读取 `thinking_level`，仅当该字段缺失时使用正常的 Agent 配置默认 `medium`。不要从 Trace 读取 `thinking_level`，也不要检查 Project 配置。

当前 Session 必须提供 `run_subagent`，且当前 Agent 必须已安装 `agent-evaluation`。任一缺失，停下来解释需要什么。

使用 Environment 的 `App Data Dir` 和显式的 Test Agent id：

```text
TEST_AGENT_DIR = <app_data_dir>/agents/<test_agent_id>
BENCHMARK_DIR = <app_data_dir>/agents/<test_agent_id>/benchmarks/<benchmark_id>
SCOREBOARD = <benchmark_dir>/scoreboard.yaml
```

只访问指定的 Test Agent 和 Benchmark：Agent State、完整 Benchmark、以及来自有效评测的 Test Trace 或产物。不要访问其他 Agent、Project 密钥，或 Evaluator State、Workspace、Trace。

从 `agent_state/system_config.yaml` 的顶层 `version` 读取 Agent State 版本；仅在缺失时用 1。

## 构建 Benchmark

```text
<benchmark_id>/
├── benchmark_config.toml
├── scoreboard.yaml
└── CASE-<nnn>-<semantic-name>/
    ├── statement/
    │   ├── README.md
    │   └── <可选的公开材料>
    └── rubric/
        └── README.md
```

每个 Case 包含：

- `statement/`，对 Test Agent 公开，定义目标、可用材料和所需产物。
- `rubric/`，是私有的，定义可观察的评分项、分值和 Gold 答案。

两个目录都需要一个 `README.md`，可能还含辅助文件。不要把被评测实例的 Gold 答案、隐藏映射或私有评分条件放进 `statement/`。

创建 `benchmark_config.toml`，含 `title`、`description` 和 `runs = 1`。Benchmark 设计始终每个 Case 一次运行；不要要求或接受其他 Run 数量。用 `evaluations: []` 初始化 `scoreboard.yaml`。

在每一个 Pilot Evaluator 请求中显式传入解析出的 `(provider, model_id)`，从第一个 cell 开始。冻结该组合和 Test Agent 配置的 `thinking_level`，用于整个 Benchmark 工作流。每个已评分的 Evaluator 结果必须报告请求的组合和同一配置的 thinking level。不匹配就作废整个矩阵。

在规划 Case 之前，陈述能力契约：

- 提供给 Test Agent 的公开证据；
- 该能力要求的可观察决策、中间产物和检查；
- Benchmark 应区分的更弱行为或捷径；
- 可以改进被测能力的可复用 Agent State 行为。

在编写每个 Case 之前，私下记录所需行为、一个强 Test Agent 可能的合理捷径、所选的难度、每种行为应产生的不同计分决策或产物，以及为什么这个区分能测量目标能力。设计 Case 使被测能力影响分数。不要为了让 Test Agent 成功而优化 Statement，也不要把这份设计理由复制进去。

Statement 呈现任务，而不是 Benchmark 的教学意图或设计意图。它描述目标、可用材料、选项含义、输出格式和必要约束。它绝不能规定推理顺序、指明关键证据、点名捷径，或揭示私有评分偏好。当需要可审计产物时，要求提供简洁的支持性证据，而不规定如何获取。

保持评测契约定义清晰，但不要要求公开 Statement 唯一确定 Gold。公开信息可以是不完整或冲突的，Rubric 可以编码私有决策标准或偏好。在评测该修订版之前固定这个私有标准，在看到被评测答案之后绝不改变其 Gold。标准必须始终与目标能力相关：它应表达一种稳定的可复用策略、优先级、推断边界或其它更好的 Agent State 可跨实例应用的行为。不要用与能力无关的随机隐藏映射来故意压分，也不要仅仅为了让公开任务完整而披露每个关键前提或优先级。

第一个完整修订版是一次探索性试探。用它的 Pilot 来学习 Test Agent 如何解读任务、形成候选规则、使用捷径；在把它当作已校准之前先精炼 Benchmark。后续修订版可以有目的地增加信息缺口、冲突、私有偏好或其它与能力相关的区分，以回应早前的 Trace，前提是下一修订版的 Rubric 在派发前已固定。

每个 Case Rubric 有固定的 100 分上限，含可观察的评分项和有意义的部分给分。在每个 Case 内，把大部分分值分配在预期行为与合理捷径产生不同结果的决策或简洁产物上。避免让通用格式合规、证据罗列和分析完整度形成高分保底，除非这些本身就是目标能力。在第一次 Pilot 之前从能力覆盖出发分配分值。不要仅仅为了让分数达到期望值而改动评分项；当重新设计改变覆盖时，在评测修订后的 Case 集之前，重新规划该 Case 的 100 分分配。当最终选择无法区分预期行为与捷径时，给一个简洁的可审计产物打分，但只定义其所需内容或格式——不定义产生它的方法。

在每次派发新的或变更的 Case 修订版之前，做一次一致性检查：

- 确认当前 Statement 内部自洽。故意的冲突必须呈现为来源、规则或立场之间的冲突，而不是 Benchmark 自身的矛盾主张。
- 确认当前 Rubric 与当前 Statement 和固定私有标准一致。它必须自包含，不得引用更早的修订版或缺失的上下文。
- 确认每个评分项都适用于该 Case 实际请求的输出，且只依赖在固定标准下已定义、已提供或明确私有的前提。

这次检查不要求公开 Statement 包含足够信息来复现私有标准或唯一推导每个 Gold 答案。未变化的 Case 在该迭代中不需要再检查。把这次检查留在 Builder 的分析与 Trace 中；通过修复 Case 来修正缺陷，而不是创建单独的审计产物。

还要把全部公开文件与私有 Rubric 比对。确认没有公开文件泄露 Gold 答案、私有评分条件或指明预期解法的提示。这就是泄漏检查（leak check）。

## 委托评测

对每个 Case × Run cell，用下面的请求调用 `run_subagent`。在可用并发内并行派发独立的 cell。

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

对每个已评分结果，要求非空的 `provider`、`model_id` 和 `thinking_level`。要求模型组合等于显式解析出的组合，thinking level 等于派发前读取的 Test Agent 配置。拒绝 cell 报告混合或不匹配 runtimes 的 Pilot 结果。Evaluator 从根 Trace 校验 provider/model，并从未变化的 Target Agent 配置报告 thinking；它不需要 Trace 元数据来给出 thinking。

纠正并重发 `invalid_request`。对 `benchmark_invalid`，在 Pilot 期间修复并重跑受影响的 Case。对 `version_changed`，丢弃当前 Pilot 结果，在 Agent 版本稳定后重新开始。

对 `evaluation_failed`，保持同一个 Benchmark 修订版和 cell。诊断失败，并且只在有证据证明 Test Agent 未启动且重试应用了新的、具体的修复时重试。不要设置数字重试上限，也不要重复未改变的启动。当不再有新的安全修复、需要外部配置、或不清楚 Test Agent 是否启动时，停止。绝不把评测失败当作零分。

## 精炼 Benchmark

把第一稿当作一个假设。来自每个已规划 Case 的第一个有效结果合起来构成 Pilot 迭代 1。后续迭代在一次难度精炼后开始，并在每个受影响 Case 都有新的有效结果时完成。请求修正、有效性修复和评测重跑保持在当前迭代内，不消耗请求的迭代预算。使用记录的 Agent State 版本和固定评测运行时。

让未选中的 Pilot 结果不进 Scoreboard。在校准期间，只保留一个临时可恢复副本：目前见过的分数最低的完整有效修订版，包括其每个 Case 一次运行的结果。把它存放在 `benchmarks/` 之外，只在更低的完整有效修订版出现时替换它，绝不保留无效修订版。

用 Pilot 找到当前 Test Agent 的能力边界。

在编辑之前，区分有效性修复与难度精炼。有效性修复修复不可用的任务或评分契约，留在当前 Pilot 迭代内。难度精炼改变 Benchmark 实际测量的内容，并在每个受影响 Case 都有有效结果后完成下一次迭代。

在编辑之前，估算计划中的精炼能影响多少分。如果范围太小、无法实质性接近期望分数，就修改更多受影响的 Case、使用不止一个难度维度，或替换低信号 Case。

优先采用能产生一个或多个计分分离决策的精炼。一次精炼可以改变公开任务或证据、引入或保留合理的信息缺口或冲突，或应用一个固定的私有标准。当观察到的策略仍能照做而到达 Gold 时，增加另一条显式规则、例外、来源或检查清单并不是难度提升。Rubric-only 的精炼允许但非首选，前提是公开任务已包含相关信息、当前 Rubric 未能区分「仅仅提及它」与「正确处理它」，且 Builder 能解释新评分区分测量的是哪个可复用能力。不要仅仅因为此前 Test Agent 漏了某个措辞就加分。在派发前固定修订后的 Rubric，并把它当作已变更的 Case 修订版。

每个精炼迭代：

1. **观察到的策略（Observed strategy）。** 从分数、产物和 Trace 重建 Test Agent 的实际解法。
2. **缺失的行为（Missing behavior）。** 找出观察到的策略跳过或简化了的通用行为。在提高难度之前，修复缺失的证据、任意映射、歧义或评分缺陷。
3. **分离预测（Separating prediction）。** 在派发之前，预测观察到的策略将产生的决策或产物、期望行为将产生的不同结果，以及受影响的分数区间。如果两种行为预期得到相同的计分结果，选择另一种精炼。
4. 更新任意数量的被诊断 Case 或难度维度，对每个变更的修订版跑一致性检查和泄漏检查，并重跑每个受影响的 Case。

只有当 Case 修订版、评分、Agent State 版本和评测运行时都未变化时，才复用 Pilot 结果。

信息缺口或受支持的替代方案不自动构成设计缺陷。仅当任务或固定私有标准不自洽、在评测后变化、泄露答案，或没有可复用的 Agent 行为能合理解释地提高分数时，才把它当作缺陷。

当观察到的策略仍能解该 Case 时，更多的行、字段、干扰项、文件、近似重复示例或显式规则层不会增加难度。精炼要基于观察到的行为，并在每次评测前固定 Gold。

当一个完整有效的 Pilot 迭代达到期望基线分数且没有已知设计缺陷时，立即 Freeze。不要仅仅为了创造更多分数余量而再做一次难度精炼。否则在请求的有效迭代上限内继续。如果期望分数仍未达到，恢复临时保存的分数最低的有效修订版并进入 Freeze。只有当没有任何有效 Pilot 修订版可产出、或评测失败阻碍有效选择时，才报告 `calibration_failed`；仅未达到期望分数不是失败。

## Freeze 并记录 Formal Baseline

选定 Pilot 修订版后，必要时恢复那个确切修订版及其完整结果。对所有 Case 做一次完整的一致性检查和最终泄漏检查。如果检查发现缺陷，修复它，并为修复后的修订版产出一个完整有效的每个 Case 一次运行的 Pilot 结果，然后再选择并 Freeze。冻结 Benchmark 并记录当前 Agent State 版本。不要启动全新的 Formal 矩阵、重跑选中的 Pilot，或把它补齐到其它 Run 数量。

当每个 Case 恰好有一次有效 Run、每个 cell 都报告冻结的评测运行时、Agent State 版本保持不变、私有评分标准保持固定、且每个失分都反映能力契约时，接受选中的 Pilot 结果作为 Formal Baseline。即使其分数没有达到期望基线分数，也记录 Formal Baseline。

只有当没有任何有效修订版可保留、或评测失败阻碍完整的选中 Pilot 结果时，才报告 `calibration_failed`。绝不把部分、放弃、无效或未选中的 Pilot 结果记录为 Formal Baseline。

## 记录并收尾

校验之后，从环境获取当前 UTC 时间戳，例如用 `date -u +"%Y-%m-%dT%H:%M:%SZ"`，而不要从显示的本地时间推断 UTC。只把被接受的 Formal Baseline 按如下确切结构追加到 `scoreboard.yaml`：

```yaml
evaluations:
  - time: <ISO-8601 timestamp>
    version: <Agent State version>
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

每个 Run 和 Case 的分数都在固定 `0..100` 标尺上。不要写 `max_score`。直接在 Scoreboard 里计算并写入每个 Case 和 Evaluation 的平均值：对成本求平均时忽略 `null` 值，且仅当所有贡献成本都未知时才写 `null`；`score` 平均值保留两位小数，`cost` 平均值保留六位小数，`duration_ms` 平均值取最接近的整数。这些存储值是权威的——不要添加会重算或校验它们的 server、前端、脚本或一致性检查。不要添加 `aggregate` 对象，也不要使用 `case_id`、`mean_score`、`mean_cost` 或 `mean_duration_ms`。

报告 Benchmark 路径、配置、Agent State 版本、Evaluation 平均值与 Case Run 分数、Test Session id，以及已知局限。为每个 Pilot 迭代给出紧凑的一行：分数、诊断出的能力缺口、难度调整，以及 Freeze 或停止决定。指明哪个每个 Case 一次运行的 Pilot 结果被记录为 Formal Baseline。

记录完被接受的 Formal Baseline 后，删除临时最低修订版副本及其它 Builder 校准脚手架。保留冻结的 Benchmark、Scoreboard、评测 Workspace 和关联分数的 Trace。

不要透露 Rubric、Gold 答案、潜在规则、逐项分数或私有评分信息。报告 Baseline 后停止；不要修改 Test Agent 或开始优化。
