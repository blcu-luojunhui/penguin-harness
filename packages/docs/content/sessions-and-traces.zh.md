---
title: Session 与 Trace
description: 逻辑 Trace 层级、协议 v3 存储与基于 checkpoint 的 Session 恢复。
---

PenguinHarness 将运行数据保存在本地文件系统。协议 v3 把不可变执行事实与可恢复模型上下文分开：逻辑 Trace 解释实际执行过程，Context checkpoint 负责延续 Session，不再让物理上下文分片充当产品身份。

## 运行模型

执行层级随运行模式变化：

```text
Project → Agent → Workspace → Session
  ├─ Goal Run Trace
  │    └─ Task × 0..N
  │         └─ Agent Step × 0..N
  └─ Standalone Task Trace
       └─ Agent Step × 0..N

Agent Step → LLM Request × 1 → Attempt × 1..N
          └→ Tool / Subagent execution × 0..N
```

| 概念 | 定义 |
| --- | --- |
| Session | 同一 Agent 与 Workspace 下的连续对话；模型和 Workspace 在创建时固定 |
| Logical Trace | 一次 Goal Run 或 Standalone Task；Trace 工作区展示的稳定根 |
| Task | 一次完整 `runTask`；一个 Goal Run 可以包含多个 Task |
| Agent Step | Task 内一次“观察 → 模型决策 → 工具结果”迭代 |
| LLM Request | 一次可能包含重试的逻辑模型决策 |
| Attempt | LLM Request 内一次真实 Provider 调用 |

Goal 可以在首个 Task 前结束，Task 也可以在首个 Agent Step 前结束，因此空根是合法且可观测的状态。

## 数据目录

`PENGUIN_HOME` 指定数据根目录，默认是 `~/.penguin/data`。每个 Agent 的 Trace 数据布局如下：

```text
<root>/<project>/agents/<agent>/
├── agent_state/
├── traces/
│   └── <sessionId>/
│       ├── session.jsonl
│       ├── traces/
│       │   └── <traceId>/events.jsonl
│       └── checkpoints/
│           └── <checkpointId>.json
├── scratchpad/<sessionId>/
├── workspaces/
├── benchmarks/
└── snapshots/
```

`traces/<yyyy-mm-dd>/<sessionId>_<index3>.jsonl` 下的 v1/v2 旧文件保持原样。协议 v3 恢复与 Goal/Task 工作区不会读取或推断它们。

## Trace-first 存储

`events.jsonl` 是一个逻辑 Trace 的执行事实来源。每行是一条完整的协议 v3 [OmniMessage](/omni-message)，携带稳定 `event_id` 与 `trace.trace_id`。模型上下文压缩时该文件不会轮转。

Session journal 只保存链接，不复制执行历史：

- `session_fact` 保存 Session 不变量与已解析工具快照；
- `trace_link` 保存逻辑 Trace 身份、根类型与首次出现顺序；
- `context_checkpoint_link` 标识 Context checkpoint 及其最后纳入的 Event。

流式 `partial_*` 分片不落盘，完成消息会落盘。子 Agent 消息只写入子 Session 的 Trace；父 Trace 保存显式子 Agent 链接，并在可用时记录精确 child logical Trace。

每条 JSONL 记录串行、单次追加。恢复写入前会探测既有文件尾；若进程崩溃留下残行，下一条记录先补换行，后续有效记录不会与残行粘连。读取端保留未知事件、容忍末尾截断，并把缺失生命周期终态显示为 partial，而不是补造结果。

## Session 恢复

Context checkpoint 是以原子 `rename` 发布的不可变快照，用于加速恢复，但不是执行事实。checkpoint link 只使用受控文件名与 `after_event_id`，拒绝绝对路径和路径穿越。

`resumeSession` 按以下流程执行：

1. 打开 `<sessionId>/session.jsonl` 并恢复 `session_meta`；
2. 从新到旧尝试 checkpoint link；
3. 加载最新有效 checkpoint，并按 journal 顺序重放其后的 Trace Events；
4. checkpoint 缺失或损坏时回退到更早快照；
5. 所有 checkpoint 均不可用时，重放全部协议 v3 Trace Events。

只有已提交 Request 会进入恢复后的 Provider history。工具调用与输出保持结构配对；未完成的模型响应可以被丢弃。进程硬崩可能留下未闭合 Trace 或 Span，界面会显示 partial。正常完成、失败、abort 与生成器取消都会写入显式终态。

恢复要求原 Workspace 与模型配置仍然可用。v1/v2 Session 不会迁移：升级前先备份或导出仍需访问的数据，升级后新建 Session。

## 上下文压缩

压缩改变的是可恢复 Context，不是逻辑 Trace 身份。Task 内自动压缩继续写入同一个 `events.jsonl`；成功的 `compaction_end` 会发布 checkpoint。因此无论替换多少次 Context，逻辑 Trace 文件都保持稳定。

## 模型切换（`/model`）

切换模型会在同一 Workspace 创建新 Session。首条消息的 `[model_switch_from]` 块指向源 Session Trace bundle 目录，而不是某个上下文分片。历史不会跨 Provider 注入；新模型需要时可以检查源 bundle。源 Session 不会被修改。

## 字段保真与大输出

Provider 的不透明 `fidelity` 数据——思考签名、加密推理、phase 标签等——会逐字保存并重放。改写这些字段可能导致 Provider 拒绝恢复历史。

工具输出超过 `maxOutputLength` 时，Trace 只记录模型与客户端实际看到的有界头部、截断提示和 Session scratchpad recovery 路径。显式删除 Session 时会同时删除 Trace bundle 与 scratchpad。

## 可观测性

Web Trace 工作区只读取显式生命周期和观察记录。Session 一级列出 Goal Run 与 Standalone Task 根；Goal 内列出 Tasks；Task 内使用可搜索的 Agent Step 导航。Span 投影为执行节点，显式 Observation Event 投影为只读观察节点；系统不会把自由文本重新分类为规划、验证或评估。
