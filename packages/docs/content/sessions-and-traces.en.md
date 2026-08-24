---
title: Sessions & Traces
description: Logical Trace hierarchy, protocol-v3 storage, and checkpoint-based Session recovery.
---

PenguinHarness stores runtime data on the local file system. Protocol v3 separates immutable execution facts from recoverable model context: logical Traces explain what ran, while Context checkpoints let a Session continue without turning physical context shards into product identities.

## Run model

The execution hierarchy adapts to the run mode:

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

| Concept | Definition |
| --- | --- |
| Session | A continuous conversation under one Agent and Workspace; model and Workspace are fixed at creation |
| Logical Trace | One Goal Run or one standalone Task; the stable root shown in the Trace workspace |
| Task | One complete `runTask`; a Goal Run can contain multiple Tasks |
| Agent Step | One observe → model decision → tool-result iteration inside a Task |
| LLM Request | One logical model decision that may retry |
| Attempt | One physical provider call inside an LLM Request |

A Goal may stop before starting a Task, and a Task may stop before starting an Agent Step. Empty roots are therefore valid and remain observable.

## Data layout

`PENGUIN_HOME` selects the data root and defaults to `~/.penguin/data`. Trace data lives below each Agent:

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

Legacy v1/v2 files under `traces/<yyyy-mm-dd>/<sessionId>_<index3>.jsonl` are left untouched. Protocol-v3 recovery and the Goal/Task workspace do not read or infer them.

## Trace-first storage

`events.jsonl` is the execution source of truth for one logical Trace. Each line is one complete protocol-v3 [OmniMessage](/omni-message) with stable `event_id` and `trace.trace_id`. The file is append-only and does not rotate when model context is compacted.

The Session journal contains links rather than duplicate execution history:

- `session_fact` stores Session invariants and the resolved tool snapshot;
- `trace_link` records logical Trace identity, root kind, and first-seen order;
- `context_checkpoint_link` identifies a Context checkpoint and its last included Event.

Streaming `partial_*` fragments are not persisted; their complete messages are. Child Agent messages remain in the child Session's Trace. The parent stores an explicit subagent link, including the child logical Trace when it is known.

Every JSONL append is serialized and written as one record. A resumed writer probes a pre-existing tail and inserts a newline after a crash-torn record, so later valid records remain parseable. Readers retain unknown events, tolerate a truncated final line, and mark missing lifecycle endings as partial instead of inventing terminal state.

## Session recovery

Context checkpoints are immutable snapshots published with an atomic rename. They accelerate recovery but are not execution facts. A checkpoint link uses a controlled filename and an `after_event_id`; absolute or traversing paths are rejected.

`resumeSession` performs the following steps:

1. open `<sessionId>/session.jsonl` and restore `session_meta`;
2. try checkpoint links newest first;
3. load the newest valid checkpoint and replay later Trace events in journal order;
4. if a checkpoint is missing or invalid, fall back to an earlier one;
5. if none are usable, replay all protocol-v3 Trace events.

Only committed Requests enter recovered provider history. Tool calls and outputs remain structurally paired; an incomplete model response may be discarded. A hard process crash can leave an open Trace or Span, which remains visible as partial. Normal completion, failure, abort, and generator cancellation write explicit terminal lifecycle events.

Recovery requires the original Workspace and model configuration. Existing v1/v2 Sessions are not migrated: back up or export data that must remain accessible, then start a new Session after upgrading.

## Context compaction

Compaction changes recoverable Context, not logical Trace identity. Automatic compaction during a Task continues writing to the same `events.jsonl`; a successful `compaction_end` publishes a checkpoint. Logical Trace files therefore remain stable across any number of Context replacements.

## Model switch (`/model`)

Switching models creates a new Session in the same Workspace. The first message contains a `[model_switch_from]` block pointing at the source Session Trace bundle directory, not one context shard. History is not injected across providers; the new model can inspect the source bundle when needed. The source Session remains unchanged.

## Field fidelity and large outputs

Opaque provider `fidelity` data—thinking signatures, encrypted reasoning, phase labels, and similar fields—is stored and replayed verbatim. Rewriting it can make a provider reject recovered history.

When tool output exceeds `maxOutputLength`, the Trace records the same bounded head, truncation marker, and Session scratchpad recovery path seen by the model and clients. Explicit Session deletion removes both the Trace bundle and its scratchpad.

## Observability

The Web Trace workspace reads explicit lifecycle and observation records only. It lists Goal Run and standalone Task roots at Session level, Tasks inside a Goal, and searchable Agent Steps inside a Task. Span records become execution nodes; explicit Observation Events become read-only observation nodes. Free text is never reclassified as planning, verification, or evaluation.
