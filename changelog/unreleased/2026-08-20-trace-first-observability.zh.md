# Trace-first Goal 与 Task 观测

- **Date:** 2026-08-20
- **Type:** feature
- **Scope:** `core`, `server`, `web`, `docs`
- **Breaking:** yes — 协议 v3 以逻辑 Trace 存储替换了基于分片的 v1/v2 恢复与 Turn 图

[English](2026-08-20-trace-first-observability.md)

PenguinHarness 使用协议 v3 逻辑 Trace 替换了模型上下文分片 Trace；每个 Goal Run 或 Standalone
Task 都是一个 Trace 根。

## 细节

- 新增稳定的 Trace、Task、Step、Span 与 Event 身份，并显式记录根、Task、Step、Request、
  Attempt、工具和子 Agent 生命周期。
- 每个逻辑 Trace 使用独立的追加式事件历史；Session 事实与 Context checkpoint 链接保存在单独
  journal 中。
- Session 恢复改为原子 Context checkpoint 加事件尾部重放；checkpoint 损坏时依次回退到更早快照
  或完整协议 v3 历史。
- 新增 Session 级逻辑 Trace 清单与详情 API；未知显式事件仍会保留，不从自由文本推断语义阶段。
- Web Trace 工作区改为 Goal Run 或 Standalone Task 根、嵌套 Task 与可搜索 Agent Step 导航，不再
  使用无边界 Turn tabs。
- 子 Agent 执行保留在自己的 Session Trace 中；父调用在可用时链接到子 Session 或精确逻辑 Trace。

## 兼容性

升级前请备份或导出仍需迁移携带的 v1/v2 Trace 数据，升级后新建 Session。只读旧数据的确切范围与
移除条件记录在[向后兼容](2026-08-20-backward-compatibility.zh.md)条目中。
