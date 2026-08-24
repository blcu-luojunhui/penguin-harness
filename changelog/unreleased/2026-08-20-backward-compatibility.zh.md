# 向后兼容：协议 v3 Trace 断代

- **Date:** 2026-08-20
- **Type:** process
- **Scope:** `core`, `server`, `web`

[English](2026-08-20-backward-compatibility.md)

本批次引入了新的磁盘 Trace 协议，并明确断代，不从旧记录猜测 Goal 或 Task 身份。

## v1/v2 旧 Trace 文件

**容忍的旧形态。** 既有按日期分片的 v1/v2 JSONL 文件保持逐字节不变。物理文件、Raw Event、性能
分析、下载以及显式 v2 Turn 的读取路径继续只读可用；它们不会被合成为虚假的 Goal Run 或 Task。

**影响范围。** 协议 v3 的 Session 恢复只读取新的 Session bundle，不续跑、迁移、重写或推断
v1/v2 历史。升级后需要继续执行的 Session 必须重新创建；仍需迁移携带的数据应先下载或备份。

**移除条件。** Server 与 Web 维护者需要成对保留旧分片 reader 和视图，直到未来某次发布在提供已
文档化的备份或批量导出路径后，明确终止 v1/v2 检查能力。该发布必须一次性删除 v2 routes、投影、
测试与 Web 入口。移除兼容代码不代表获准删除旧文件；只有显式删除 Session 或用户主动清理才能
删除它们。
