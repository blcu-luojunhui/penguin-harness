# Trace-first Goal and Task observability

- **Date:** 2026-08-20
- **Type:** feature
- **Scope:** `core`, `server`, `web`, `docs`
- **Breaking:** yes — protocol v3 replaces shard-based v1/v2 recovery and Turn graphs with logical Trace storage

[中文版](2026-08-20-trace-first-observability.zh.md)

PenguinHarness replaced context-shard Traces with protocol-v3 logical Traces rooted at each Goal
Run or standalone Task.

## Details

- Added stable Trace, Task, Step, Span, and Event identities plus explicit root, Task, Step,
  Request, Attempt, tool, and subagent lifecycles.
- Stored each logical Trace in its own append-only event history while keeping Session facts and
  Context checkpoint links in a separate journal.
- Rebuilt Session recovery around atomic Context checkpoints with event-tail replay and fallback
  to earlier checkpoints or the full protocol-v3 history.
- Added Session-scoped logical Trace inventory and detail APIs that preserve unknown explicit
  events without inferring semantic stages from free text.
- Reworked the Web Trace workspace around Goal Run or standalone Task roots, nested Tasks, and a
  searchable Agent Step navigator instead of unbounded Turn tabs.
- Kept child Agent execution in its own Session Trace and linked the parent invocation to that
  child Session or exact logical Trace when available.

## Compatibility

Back up or export any v1/v2 Trace data that must remain portable before upgrading, then start a new
Session. The exact read-only legacy scope and its removal condition are recorded in
[backward compatibility](2026-08-20-backward-compatibility.md).
