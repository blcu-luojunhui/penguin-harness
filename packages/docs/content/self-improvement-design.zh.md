---
title: 自我进化的设计剖析
description: 设计者视角——PenguinHarness 如何以「提示词即策略」在普通 Agent 机制之上编排自我进化闭环，及其相对 RL / 进化算法的取舍。
---

> 本文是 [自我进化](/self-improvement) 的设计者视角补充：官方文档客观描述功能如何工作，本文剖析它**为什么这样设计**、关键的机制取舍与潜在风险，并把两个经常被问到的点展开——`run_subagent` 的两阶段执行如何支撑起「并行评测矩阵」，以及「提示词即策略」相对传统 RL / 进化算法（Eureka、FunSearch）在 Agent 改进上的取舍。

## 设计哲学：没有引擎，只有 Skill

**PenguinHarness 没有「自我进化引擎」这种专门代码。** 整个自我进化是**用 Skill（提示词）编排普通的 Agent 机制**完成的：评测是普通的 Session，优化是普通的文件编辑，Benchmark 与 Scoreboard 是普通的文件。

这是整个设计的第一性原理，值得展开：

- ReAct 循环、`Session.run()`、`run_subagent` 子代理、Trace、文件层——这些都是平台**本来就有的能力**；
- 自我进化只是把「评测 = 跑一个 Session 再打分」「优化 = 编辑 `AGENTS.md`」这两个平凡操作，用四个 Skill 的提示词串成一个闭环；
- 因此平台代码不需要任何进化专用逻辑。真正的心智都在 **Skill 文档**里（四个核心 Skill 合计约 500 行 `SKILL.md`），它们约束 Agent 的行为契约。

这不是偷懒，而是刻意的架构选择（详见下文「与 RL / 进化算法的对比」）：**进化策略本身是需要被进化验证的东西，所以它住在可编辑的 Agent State 层，而不是编译进 SDK**。想改优化策略，改的是 Skill 文件，不需要发版。

## 系统骨架：两个独立步骤 × 四个角色

```
第一步（一个顶层 Session）：Builder
  ├─ 1. agent-creation    → 创建 Target Agent（写 AGENTS.md、装 Skills、设版本）
  └─ 2. benchmark-design  → 设计并校准 Benchmark，冻结，记录 Formal Baseline

第二步（另一个顶层 Session、新对话）：Optimizer
  └─ 3. agent-optimization → 读 Baseline → 诊断 → 假设 → 改状态 → 评测 → 接受/回滚
```

| 角色 | 是谁 | 职责 |
| --- | --- | --- |
| Builder | 顶层 Agent | 直接遵循 `agent-creation` 再遵循 `benchmark-design` |
| Target Agent | 被改进对象 | 只在它自己的隔离 Workspace 里执行评测任务 |
| Evaluator | `run_subagent` 创建的叶子 worker | 运行并私下评分一个 Benchmark Case 的某次 Run |
| Optimizer | 新的顶层 Agent | 遵循 `agent-optimization` 驱动改进循环 |

关键约束：**顶层 Session 只做编排（跑循环、调度），真正执行评测的一定是 `run_subagent` 派生的 Evaluator**。Optimizer 永不直接运行 Target Agent——这保证了「打分者」与「被改进者」的上下文隔离，是下面所有隔离机制的根基。

两个步骤刻意**分开**：Builder 会话结束时 Benchmark 已冻结、Formal Baseline 已记录；用户在**新对话**中启动 Optimizer。这样评测契约（Benchmark）和优化循环（Optimizer）互不知晓对方的会话历史，职责边界清晰。

## 三段流水线

### 第一段：创建与校准（agent-creation → benchmark-design）

存储结构（`benchmarks/<id>/`，每个 Target Agent 一套）：

```text
benchmarks/<id>/
├── benchmark_config.toml       # 配置（Builder 阶段 runs 固定 = 1）
├── CASE-<nnn>-<name>/
│   ├── statement/README.md     # 公开：给 Target Agent 的任务
│   └── rubric/README.md        # 私有：评分细则 + Gold 答案，Target 永不可见
└── scoreboard.yaml             # 评测记录（唯一权威来源）
```

这条结构承载了三条关键设计决策：

1. **statement 与 rubric 刻意分离。** Target Agent 只看到题面，永远接触不到评分规则（见 `agent-evaluation` 的 Workspace 隔离：只拷贝 `statement/` 进隔离 Workspace）。这是「进化对象与评价标准解耦」原则的文件层落实——否则 Target 会学到「按评分规则答题」而非「真实能力」。

2. **Case 设计的核心是区分「目标行为」与「捷径行为」。** 设计者要先私下想清楚：目标行为会产生什么可打分产出、一个强模型可能走的捷径会产生什么不同的产出，两者分数必须不同。大部分分数应落在「决定或简洁产物」上——即目标行为与捷径产生不同结果的地方——避免格式、证据罗列、分析完整度这类所有模型都能做好的行为形成「保底分」（高地板）。

3. **校准是一个迭代的 Pilot 循环。** 每个 Case 先跑 1 次（Pilot 迭代 1）；用分数和 Trace 重建 Target 的实际解题策略，找出它「缺的能力」；每次 refinement 前必须做**分离预测**——预测旧策略会得到什么结果、期望行为会得到什么、影响多少分；**如果预测两者分数相同，这个 refinement 无效，不派发**。达到期望分数就提前 Freeze；否则在迭代上限内冻结「最低分」的有效版本（以最低分版本为基线，是为了避免基准对 Agent 过严）。

三条配套纪律：

- **能力契约（Capability Contract）**：设计前先明确要测量的可观察过程、常见弱行为、以及应该被训练出的「可复用 Agent 状态行为」。难度校准的目标是测「可复用能力的边界」，不是让分数变低——**明确禁止用能力无关的随机隐藏映射来故意压分**。
- **一致性检查 + 泄漏检查（leak check）**：每次派发前检查 Statement 自洽、Rubric 与 Statement 及私有标准一致、评分项只依赖已定义前提；并把公开文件与私有 Rubric 对比，确认没有泄漏 Gold、隐藏条件或提示。
- **Formal Baseline 不重跑**：Freeze 后，被选中 Pilot 的单次运行结果**直接**记录为 Formal Baseline，不重跑、不回填。这个「单点基线」是后文风险部分要讨论的点。

### 第二段：评测协议（agent-evaluation）

Evaluator 是 `run_subagent` 派生的叶子 worker，一次请求只处理一个 cell（一个 Case × 一次 Run）。它的执行契约：

1. 在 `<test_agent>/workspaces/` 下建**唯一隔离 Workspace**，只拷贝 `statement/`；
2. 用 Penguin CLI 前台跑一次 Target Agent（`--approve allow-all`，显式指定 provider/model，**绝不回退到 Project 默认**）；
3. 运行后校验：State 版本、thinking_level、statement/rubric 快照都没变（防评测过程产生副作用）；
4. 从 Trace 绑定唯一的根 Session（校验 Workspace、Agent 路径、provider、model 都匹配），`session_id` 自此关联评测记录；
5. 用私有 Rubric 打分，返回**纯 YAML 协议**——不许有叙述、代码围栏、Markdown 标题，否则不算有效协议（上层会要求同一 Evaluator 重发干净 YAML，且不重跑 Target）。

**四种失败码**贯穿整个系统，让上层按码分流而非模糊重试：

| 失败码 | 含义 | 上层处理 |
| --- | --- | --- |
| `invalid_request` | 请求不完整或自相矛盾 | 纠正后重发 |
| `benchmark_invalid` | Statement / Rubric / 评分契约损坏 | Builder 修复 Case 重跑；Optimizer 停止 |
| `version_changed` | Agent 版本与请求不符或运行中变了 | 放弃当前结果，等版本稳定 |
| `evaluation_failed` | 启动 / Trace 绑定 / 评分失败 | 保持同一 Candidate，只修失败 cell |

两条原则值得强调：

- **错误答案也要打分。** Target 跑完了但答案错 / 产物缺失 / 格式错，是有效评分（`status: ok`），不得重试。只有启动器、Trace 绑定这类**非 Target 责任**的失败才是 `evaluation_failed`。这保证分数只反映 Target 能力，不反映基建问题；也避免了「重试直到答案变好」污染评测。
- **失败重试哲学：无数字上限。** 每次重试必须基于新诊断、应用新的安全修复；绝不重复未改变的请求。可穷尽的诊断 + 具体修复，而非「再试一次」。

### 第三段：优化循环（agent-optimization）

每轮：

```
Reference（当前最优版本）→ 诊断能力缺口 → 可证伪假设 → 生成 1 个有界 Candidate
→ 并行评测 Case×runs 矩阵 → 严格更高分才接受 → 否则回滚 → 追加 scoreboard
```

关键机制：

- **Reference 语义**：始终保留「当前最优 Agent State + 它在冻结 Benchmark 上的完整评测」。每轮从 Reference 出发，只产出一个**有界** Candidate。
- **有界 Candidate**：行为指导放 `AGENTS.md`、可复用的 Target 能力放独立 Skill、运行限制放 `system_config.yaml` 安全字段。**禁止改 `system_prompt`、禁止改模型 `thinking_level`**（评分运行时是冻结的，见下）。版本号只增不减（Reference version + 1，从不复用被拒版本）。
- **快照保护**：改动前先确保 `snapshots/v<version>.tar.gz` 存在（打包 `agent_state/`，**排除 `.vault.toml`——密钥永不进快照**）。快照既保障快速回滚，也保证「失败的优化不留下痕迹」。若优化失败要回滚，按「原始文件记录」恢复并删除 Candidate 新建的文件。
- **严格接受标准**：只有所有 cell 有效**且**顶层平均分**严格高于** Reference 时接受。预测的行为变化**单独报告**——分数提高但假设未被支持，也接受 Candidate（分数是最终裁判），但**不能把无关的单次波动说成因果证据**。
- **评分运行时冻结**：`(provider, model_id, thinking_level)` 一旦解析就冻结整个流程；任何 Evaluator 返回的运行时与冻结值不符，整矩阵作废。这是「不同模型测出的分数不可比」这一事实的直接推论。
- **信任边界**：Server 与 Web UI **只读** Scoreboard，**信任存储的聚合值，不重算、不交叉校验**（`score` 两位小数、`cost` 六位、`duration_ms` 取整，写入规则由 Skill 约定）。这避免了「server 重算逻辑与模型写入逻辑漂移」这个典型的脆弱点——代价是校验完全依赖 Skill 的指令纪律（见风险部分）。

## 支撑机制：文件层是事实来源

- **Benchmark / Scoreboard / Snapshots / Traces 全是文件**，位于 `~/.penguin/data`（开发环境为 `~/.penguin/dev-data`）下的各 Agent 目录。职责按「事实来源」切分：core 拥有协议与执行，server 拥有多用户运行时，**文件层拥有所有可编辑、可记录的内容**。
- **版本化**：`system_config.yaml` 的 `version` 在优化成功后自增；Web UI 支持导出/导入快照，导入版本不高于当前版本需显式确认。版本号是 Evaluator 校验 `version_changed` 的依据——整个系统靠它在「评测期间 Agent 状态被并行改动」时立刻发现并中止。
- **全程可审计**：每个 Evaluator 运行是普通 Session（完整 Trace），Scoreboard 记录经 `session_id` 回链到该 Session。**分数不是黑盒输出——每个数字都能追溯到产生它的那次运行。** Web 评测页是这些文件的只读视图（趋势图只看 Score，明细表把 model 与 thinking_level 分列）。

## 深挖一：`run_subagent` 的两阶段执行，为什么支撑得起「并行评测矩阵」

一个容易忽略的事实：**顶层 Agent 是一个单线程 ReAct 循环，一次只能执行一个工具调用。** 如果每个评测 cell 都同步阻塞，Case × runs 的矩阵只能串行跑，一轮优化（比如 5 Case × 3 runs）要等 15 次完整 Agent 运行逐个结束。`run_subagent` 的两阶段语义（`packages/core/src/environment/tools/run-subagent.ts`，与 `exec_command` 同构）正是为打破这个瓶颈设计的。

### 阶段一：yield window（同步窗口）

调用 `run_subagent` 后，在 `yield_time_ms`（默认 300 秒，被工具的 `timeoutMs` 上限钳制）窗口内，`collectWindow`（`packages/core/src/environment/tools/subagent/collect.ts`）做三件事：

- **实时转发**子会话的 OmniMessage（已带 origin 标签）给前端渲染——父调用方和用户能看到子 Agent 的工具调用与 token 用量；
- 把**直接子层**（origin 一跳）的文本增量**复制为父工具自身的输出 delta**，喂回父 LLM——父模型在窗口内能「看到」子 Agent 在说什么；
- 通过 `attachApprovalSink` 把子会话的**审批队列逐个转发给 Human**（`ctx.approve`），一次一个。

若子 Agent 在窗口内完成，返回终态并释放子会话；**若窗口到期仍未完成**，进入阶段二。

### 阶段二：后台化（background）

- 子会话被注册进 `BackgroundRegistry`（与命令会话共享，`packages/core/src/environment/tools/background/registry.ts`），分配 `subagent_id`，`run_subagent` **立即返回**（`stopReason: completed` + 提示用 `input_subagent` 访问）；
- 窗口外的输出进入缓冲：消息缓冲 cap 4096 条、文本缓冲 cap 1 MiB，**溢出丢最旧**——注意这只影响前端回放，子会话自己的 Trace 与文本缓冲不受影响；
- 子会话内的工具审批请求在后台期间**排队**，子 Agent 阻塞等待；下次通过 `input_subagent` 访问时再补审（`first-to-arrive-wins`，迟到决定仍生效）。

### 为什么这构成了「并行」

关键在于：**窗口到期后父 LLM 被释放**。父 LLM 拿到 `subagent_id` 后，可以立刻发起下一个 `run_subagent` 派发下一个 cell——多个子会话在**进程内**通过各自的异步泵（`ManagedSubagentSession.pump`）并发推进。所以：

> **并行度不是引擎提供的，而是父 LLM 主动派发的并发后台会话数。** 引擎是单线程事件循环，但每个子会话是一个不阻塞事件循环的异步任务；评测矩阵的编排（派发哪些 cell、如何收集）是 Optimizer 的 Skill 提示词职责。

这与「引擎级线程/进程池」的并行有本质区别：它是**编排层**（提示词）利用**机制层**（两阶段工具）实现的逻辑并行，因此并行度上限只受两个软/硬约束约束：

- **并发上限**：`BackgroundRegistry` 的 `makeRoom(false)`——subagent 在**启动前**检查容量，满了就拒绝派发；**运行中的子会话绝不驱逐**（丢弃进行中的评测工作语义上不可接受，与命令会话的 LRU 驱逐策略相反）。这保证了评测矩阵要么被完整派发、要么被明确拒绝，不存在「悄悄少测几个 cell」。
- **审批漏斗**：若 Evaluator 在隔离 Workspace 里需要审批，窗口内直连 Human；后台化后排队。评测通常用 `--approve allow-all`（见 `agent-evaluation`），所以评测矩阵一般不受审批阻塞。

### 小结

`run_subagent` 的两阶段设计把「长时运行」（一次 Agent 评测可以跑几分钟）从「阻塞父循环」中解放出来：窗口内实时可见、窗口后转后台。评测矩阵的并行因此是**父 LLM 主动并行**，而非平台替它并行——这与整套设计「编排心智在提示词里」的哲学完全一致。

## 深挖二：「提示词即策略」vs 传统 RL / 进化算法

把 Agent 改进问题放进统一的抽象框架（个体表征 / 变异算子 / 适应度 / 选择），三个代表性流派的对比如下：

| | **提示词即策略**（本仓库） | **Eureka**（NVIDIA, 2023） | **FunSearch**（DeepMind, 2023） |
| --- | --- | --- | --- |
| 个体表征 | 提示词文件：`AGENTS.md` / Skills / 配置 | 奖励函数（可执行代码） | 程序（Python 函数） |
| 变异算子 | LLM 有向编辑（诊断→假设→改提示词） | LLM 生成/重写奖励函数 | LLM 交叉/变异（island-based 进化） |
| 适应度 | Benchmark 的 LLM 评分（多 Run 平均） | 环境交互下的策略性能（RL 训练回报） | 确定性数学目标（可精确求值） |
| 选择 | 单 Reference 爬山：严格更高分才接受 | 迭代保留改进奖励 | 程序池 + 多样性维持（类似 map-elites） |
| 搜索单位 | 每次 1 个 Candidate | 每次 1 个奖励函数 | 每代大量程序并采样 |

三个流派共享同一骨架——**LLM 作为黑盒 meta-optimizer 驱动一个外部的评估循环**——但表征、信号和搜索策略的取舍完全不同。逐维分析：

### 个体表征：文本 vs 权重

- **提示词**：人类可读、可审计、可解释；改进以「编辑历史」形式累积，天然支持版本与回滚。但**不可微分、无梯度信号**，改进粒度粗（一次改动是一段自然语言，无法精细到「哪个 token 起了作用」）。
- **权重**：可梯度优化、信号强，但不可解释、需要大规模 RL 基建（环境交互 + 算力 + 训练循环）。
- **推论**：只有当「Agent 的行为主要由提示词配置决定」时，提示词表征才覆盖完整的改进空间。本仓库的 Target Agent 是「通用 LLM + 提示词配置」——它的可进化面就是文本，所以提示词表征不是妥协，而是与模型形态自洽的选择。

### 适应度信号：Benchmark 评分 vs 精确奖励

- **Benchmark 的 LLM 评分**：灵活、无需 ground truth，能测「能力/行为」而非「任务损失」，评测即运行 Agent（无需环境模拟器）。但**有噪声、有偏**——judge 本身是 LLM，一致性与风格偏好无法根除。
- **Eureka 的动机**恰恰是传统奖励设计的痛点：奖励塑形（reward shaping）难以手工设计、容易 hack（reward hacking），所以让 LLM 生成奖励函数。但 Eureka 的适应度最终仍是环境回报（精确、无噪声），只是奖励函数本身由 LLM 进化。
- **FunSearch** 的适应度是确定性数学目标（如 cap set 规模）——**可精确验证**，因此它的进化压力最干净，但只适用于「目标可程序化求值」的问题。
- **推论**：PenguinHarness 用 LLM 评分是因为**评测维度是开放的（Agent 能力行为），没有可程序化的 ground truth**。代价是必须在进化循环里处理评测噪声（多 Run 平均、区分 Case 行为变化、严格提高才接受）。

### 变异算子与搜索策略：有向变异 vs 梯度 vs 种群

- **LLM 做变异算子**：利用 LLM 的世界知识与对 Agent 行为的理解做**语义空间的有向变异**——相比随机变异或梯度，搜索效率在语义空间高（它知道「加一个规划步骤」比「随机改一个词」更可能提升）。但变异是**黑盒、不稳定、不可复现**（同输入不同输出），所以需要保守的选择策略（严格提高才接受）来对冲。
- **FunSearch 的种群**显式维持多样性（island-based / 程序池），降低局部最优风险；**Eureka** 每次只进化一个奖励函数（点式迭代），与 PenguinHarness 相似——但 Eureka 的每个候选奖励都要跑完整 RL 训练来评估，代价极高。
- **PenguinHarness 的选择是单 Reference 爬山**：无种群、无交叉。逃逸局部最优靠两件事——每轮从分数和 Trace 出发做**新诊断**，以及把**历史被拒 Candidate 作为后续假设的证据**（隐式记忆）。这是最便宜的搜索策略，但也最依赖 LLM 诊断质量。

### 计算成本与工程门槛

| | 样本/调用成本 | 基建门槛 | 改进边界 |
| --- | --- | --- | --- |
| 提示词即策略 | 每次评测 = 一次完整 Agent 运行（若干 LLM 调用），随 runs×cases×rounds 线性增长；无采样探索，是「少而精」的有向搜索 | **零训练基建**：无环境模拟器、无 RL 循环、无 GPU 集群 | 提示词空间内（不能学新工具、不能改权重） |
| Eureka | 每个候选奖励 = 一次完整 RL 训练，**极贵** | GPU 环境模拟器（Isaac Gym 等）+ RL 栈 | 权重空间 + 奖励空间 |
| FunSearch | 每代大量程序采样求值（可并行，但量大） | 目标可程序化求值的环境 | 程序空间 |

### 为什么这套取舍对本仓库是合理的

1. **产品形态自洽**：平台交付的是「通用 LLM + 提示词配置」的 Agent，改进边界就是文本——提示词表征覆盖完整改进空间；
2. **可审计/可回滚是产品价值**：每个分数可追溯到 Trace、每个版本有快照、失败可回滚——这直接服务于「可信任的 Agent 平台」定位，而权重训练天然不可审计；
3. **用户可参与**：进化不是一次性训练流水线，而是用户可在 Web/CLI 上执行的工作流（评测中心、快照导出/导入）；策略本身是 Skill，可被进化验证——**元层级闭合**；
4. **零基建门槛**：评测即运行 Agent，任何有模型凭证的环境都能跑完整闭环。

**诚实的边界**：这套方案的进化效率上限低于有梯度/有种群的方案，且受 LLM 诊断质量与评测噪声双重制约。它是「少而精、可解释、可审计」的路线，不是「大规模探索、强信号」的路线——两类路线分别适配「产品化 Agent 平台」与「研究性自动化」场景。

## 风险与设计审视

以下审视区分**事实**（可验证）、**推断**（有依据未验证）、**假设**（未经支撑）：

1. **评测噪声 × 严格提高 → 过拟合 Benchmark 风险**（推断）。小样本下，Candidate 的多 Run 平均仍可能有噪声，「严格提高」无法完全区分「真能力提升」与「碰巧答好」。缓解设计是存在的：Case 设计强调「区分目标行为与捷径」、分数应落在「可复用能力」而非一次性事实、假设是否在预期 Case 上得到支持被单独报告。但**只要 judge 是 LLM，这个风险就无法根除**——它能被压低，不能被消除。
2. **信任模型：Scoreboard 是「模型自写、server 只读不验」**（事实）。这条约束防住了 server 重算逻辑漂移，但把正确性完全押在 SKILL.md 的指令纪律上——若 Optimizer 不遵守（乱写分数、写错聚合），**没有任何机制层兜底**。这是「提示词即策略」的固有代价。
3. **Formal Baseline 是单点基线**（事实）：单 Run 记录，之后所有 Candidate 都与此比较，且第一次比较允许 Candidate 多 Run 平均直接对比 Baseline 单 Run 分数。这引入了基线侧的抽样方差，文档明确选择「不重跑、不回填」。这是**有意的**（省成本、避免基准被优化），但对比的统计基础是偏弱的（推断）。
4. **单 Reference 爬山可能停滞**（假设）：无种群意味着没有显式多样性保护，逃逸局部最优依赖 LLM 的「新诊断」。对诊断质量差的优化器，可能长期停在局部最优——目前没有机制层的检测或惩罚（如长期无改进就强制换方向）。
5. **LLM judge 风格偏差**（推断）：LLM 评分可能系统性偏好某种输出风格（更长的分析、特定格式），即使 rubric 强调「简洁产物」也无法完全避免——这与评测用例设计共同作用，值得在 Benchmark 校准阶段留意。

## 相关参考

- 功能级描述：[自我进化](/self-improvement)
- 协议与工具：[Session 与 Trace](/sessions-and-traces)、[工具](/tools)、[技能系统](/skills)
- 相关 Skill：[`agent-creation`](../../skills/skills/agent-creation/SKILL.zh.md)、[`benchmark-design`](../../skills/skills/benchmark-design/SKILL.zh.md)、[`agent-evaluation`](../../skills/skills/agent-evaluation/SKILL.zh.md)、[`agent-optimization`](../../skills/skills/agent-optimization/SKILL.zh.md)（中文阅读版；英文原文即 `packages/skills/skills/<skill>/SKILL.md`；运行时安装在 `~/.penguin/data/agents/<agent>/agent_state/skills/<skill>/SKILL.md`，`default_agent` 预装整个库，总览见 [技能系统](/skills)）
- 关键实现：`packages/core/src/environment/tools/run-subagent.ts`（两阶段工具）、`packages/core/src/environment/tools/subagent/*` 与 `background/*`（窗口收集、后台注册）、`packages/core/src/state/example-benchmark.ts`（示例数据）、`packages/server/src/services/snapshot-service.ts`（快照/导入导出）
