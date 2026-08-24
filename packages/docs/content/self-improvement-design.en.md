---
title: Self-Improvement, Design Autopsy
description: The designer's view — how PenguinHarness builds a self-improvement loop from ordinary Agent machinery via "prompt-as-policy", and how that trades off against RL / evolutionary algorithms.
---

> This page complements [Self-Improvement](/self-improvement) from a designer's perspective: the official page describes what the feature does; this one analyzes **why it is designed this way**, the key mechanism trade-offs and risks, and expands the two questions that come up most often — how `run_subagent`'s two-phase execution supports the "parallel evaluation matrix", and how "prompt-as-policy" trades off against traditional RL / evolutionary algorithms (Eureka, FunSearch) for improving agents.

## Design philosophy: no engine, only Skills

**PenguinHarness has no dedicated "self-improvement engine" code.** The whole loop is **orchestrated by Skills (prompts) over ordinary Agent machinery**: evaluation is an ordinary Session, optimization is ordinary file editing, and the Benchmark and Scoreboard are ordinary files.

This is the first principle of the design, and it is worth unpacking:

- The ReAct loop, `Session.run()`, the `run_subagent` tool, Traces, and the file layer are all capabilities the platform **already has**;
- Self-improvement merely strings two mundane operations — "evaluation = run a Session, then score it" and "optimization = edit `AGENTS.md`" — into a closed loop via the prompts of four Skills;
- Platform code therefore needs no evolution-specific logic. The actual intelligence lives in the **Skill documents** (the four core Skills total ~500 lines of `SKILL.md`), which constrain the agents' behavioral contracts.

This is not laziness but a deliberate architectural choice (see "vs RL / evolutionary algorithms" below): **the evolution policy is itself something that needs to be validated by evolution, so it lives in the editable Agent State layer rather than compiled into the SDK.** To change the optimization policy, you edit a Skill file — no release required.

## Skeleton: two independent steps × four roles

```
Step 1 (one top-level Session): Builder
  ├─ 1. agent-creation    → create the Target Agent (write AGENTS.md, install Skills, set version)
  └─ 2. benchmark-design  → design and calibrate a Benchmark, freeze it, record the Formal Baseline

Step 2 (another top-level Session, new conversation): Optimizer
  └─ 3. agent-optimization → read Baseline → diagnose → hypothesize → edit state → evaluate → accept/rollback
```

| Role | Who | Responsibility |
| --- | --- | --- |
| Builder | top-level Agent | follows `agent-creation`, then `benchmark-design` |
| Target Agent | the object being improved | runs evaluation tasks only inside its own isolated Workspace |
| Evaluator | leaf worker created via `run_subagent` | runs and privately scores one Run of one Benchmark Case |
| Optimizer | new top-level Agent | follows `agent-optimization` and drives the improvement loop |

Key constraint: **top-level Sessions only orchestrate (drive the loops, dispatch work); the actual evaluation is always performed by `run_subagent`-spawned Evaluators.** The Optimizer never runs the Target Agent directly — this guarantees context isolation between "the scorer" and "the thing being improved", the root of every isolation mechanism below.

The two steps are deliberately **separated**: when the Builder session ends, the Benchmark is frozen and the Formal Baseline is recorded; the user starts the Optimizer in a **new conversation**. The evaluation contract (Benchmark) and the optimization loop (Optimizer) thus never see each other's session history, keeping responsibilities clean.

## The three-stage pipeline

### Stage 1: Creation and calibration (agent-creation → benchmark-design)

Storage layout (per Target Agent, under `benchmarks/<id>/`):

```text
benchmarks/<id>/
├── benchmark_config.toml       # config (Builder phase fixes runs = 1)
├── CASE-<nnn>-<name>/
│   ├── statement/README.md     # public: the task given to the Target Agent
│   └── rubric/README.md        # private: scoring items + Gold answers, never visible to the Target
└── scoreboard.yaml             # evaluation records (the single source of truth)
```

This layout encodes three key design decisions:

1. **Statement and rubric are deliberately separated.** The Target Agent sees only the task; it never touches the scoring rules (`agent-evaluation` copies only `statement/` into the isolated Workspace). This is the file-layer realization of decoupling "the evolved object" from "the evaluation standard" — otherwise the Target learns to answer to the rubric rather than to develop real capability.

2. **Case design centers on distinguishing "intended behavior" from "a shortcut".** The designer first records, privately: what scored output the intended behavior produces, what a plausible shortcut from a strong model would produce, and why the two differ. Most points should rest on decisions or concise artifacts where intended behavior and shortcut diverge — avoiding a "high floor" from generic format compliance, evidence enumeration, or analysis completeness that every model can do.

3. **Calibration is an iterative Pilot loop.** Each Case runs once per Pilot iteration; scores and Traces are used to reconstruct the Target's actual strategy and find the capability it lacks. Before each refinement the Builder makes a **separating prediction** — what the observed strategy will produce, what the desired behavior will produce, and how many points are at stake; **if both would reach the same scored result, the refinement is invalid and not dispatched**. Freeze happens on the first valid revision meeting the desired score; otherwise the **lowest-scoring** valid revision within the iteration limit is frozen (using the lowest score avoids calibrating the baseline too harshly against the Agent).

Three accompanying disciplines:

- **Capability Contract**: before designing, state the observable process to measure, the common weaker behavior, and the reusable Agent State behavior the Benchmark should train. Difficulty calibration targets the boundary of a reusable capability, not low scores — **deliberately lowering scores with capability-irrelevant random hidden mappings is explicitly forbidden**.
- **Consistency review + leak check**: before dispatch, verify the Statement is coherent, the Rubric agrees with the Statement and the fixed private standard, and every scoring item rests on defined/provided/privately-explicit premises; and compare all public files against the private Rubric to confirm no Gold answers, hidden conditions, or hints leak out.
- **The Formal Baseline is never rerun**: after Freeze, the selected Pilot's one-Run result is recorded **directly** as the Formal Baseline — no rerun, no backfill. This single-point baseline is a point we return to under Risks.

### Stage 2: The evaluation protocol (agent-evaluation)

An Evaluator is a `run_subagent`-spawned leaf worker handling exactly one cell (one Case × one Run) per request. Its execution contract:

1. Create a **unique isolated Workspace** under `<test_agent>/workspaces/` and copy only `statement/` into it;
2. Launch the Target Agent once via the Penguin CLI (`--approve allow-all`, explicit provider/model, **never falling back to a Project default**);
3. After the run, verify the State version, thinking level, and both directory snapshots are unchanged (evaluation must not have side effects);
4. Bind the unique root Session from the Traces (Workspace, Agent State path, provider, model must all match); `session_id` links the record from here on;
5. Score with the private Rubric and return a **plain protocol YAML** — no narration, headings, code fences, or Markdown; anything else is not valid protocol (the caller asks the same Evaluator to resend clean YAML without rerunning the Target).

**Four failure codes** thread through the whole system, letting the upper layers dispatch by code instead of vague retries:

| Code | Meaning | Upper-layer handling |
| --- | --- | --- |
| `invalid_request` | request incomplete or self-contradictory | correct and resend |
| `benchmark_invalid` | Statement / Rubric / scoring contract broken | Builder repairs the Case and reruns; Optimizer stops |
| `version_changed` | Agent version mismatch, or changed during the run | discard the result, wait for a stable version |
| `evaluation_failed` | launch / Trace-binding / scoring failure | keep the same Candidate, repair only the failed cell |

Two principles worth emphasizing:

- **A wrong answer is still a score.** If the Target ran but produced a wrong answer, missing artifact, or malformed output, that is valid scored behavior (`status: ok`) and must not be retried. Only launcher, Trace-binding, or Evaluator failures — things outside the Target's responsibility — are `evaluation_failed`. This keeps scores a pure measure of Target capability and prevents retry-until-good from polluting evaluation.
- **Failure retry has no numeric limit.** Every retry must follow a new diagnosis and apply a distinct, safe repair; an unchanged request is never repeated. Exhaustible diagnosis plus a specific fix — not "try again".

### Stage 3: The optimization loop (agent-optimization)

Each round:

```
Reference (current best) → diagnose capability gaps → falsifiable hypothesis → build 1 bounded Candidate
→ evaluate the Case×runs matrix in parallel → accept only on a strictly higher score → else roll back → append scoreboard
```

Key mechanisms:

- **Reference semantics**: keep "the current best Agent State + its complete evaluation on the frozen Benchmark". Each round starts from the Reference and produces exactly one **bounded** Candidate.
- **Bounded Candidate**: behavioral guidance goes into `AGENTS.md`, reusable target-owned capabilities into a dedicated Skill, runtime limits into safe `system_config.yaml` fields. **`system_prompt` is never edited, and `model.thinking_level` is never changed** (the evaluation runtime is frozen, below). Version numbers only increase (Reference version + 1; rejected versions are never reused).
- **Snapshot protection**: before touching the Agent State, ensure `snapshots/v<version>.tar.gz` exists (packing `agent_state/`, **excluding `.vault.toml` — secrets never enter a snapshot**). Snapshots enable fast rollback and guarantee "a failed optimization leaves no trace". On rollback, restore the recorded original files and remove files the Candidate created.
- **Strict acceptance**: a Candidate is accepted only when every cell is valid **and** its top-level average score is **strictly higher** than the Reference's. Whether the predicted Case behavior changed is reported separately — a higher score accepts the Candidate even when the stated hypothesis was not supported (score is the final judge), but unrelated single-run variation must not be presented as causal evidence.
- **Frozen evaluation runtime**: once `(provider, model_id, thinking_level)` is resolved, it stays fixed for the whole workflow; any Evaluator returning a mismatched runtime invalidates the entire matrix. This follows directly from the fact that scores from different models are not comparable.
- **Trust boundary**: the Server and Web UI **read only** the Scoreboard and **trust the stored aggregate values — they never recompute or cross-check** (`score` to two decimals, `cost` to six, `duration_ms` rounded; the write rules are agreed in the Skill). This avoids the classic fragile spot of "server recomputation logic drifting from model-written logic" — at the cost that correctness depends entirely on Skill discipline (see Risks).

## Supporting machinery: the file layer is the source of truth

- **Benchmark / Scoreboard / Snapshots / Traces are all files** under `~/.penguin/data` (development: `~/.penguin/dev-data`), per Agent directory. Responsibilities split by "source of truth": core owns the protocol and execution, the server owns the multi-user runtime, and **the file layer owns everything editable and recordable**.
- **Versioning**: `system_config.yaml`'s `version` increments after a successful optimization; the Web UI can export/import snapshots, and importing a version not higher than the current one requires explicit confirmation. The version number is what Evaluators check for `version_changed` — it is how the system detects and aborts when the Agent State is concurrently modified mid-evaluation.
- **Auditable end to end**: every Evaluator run is an ordinary Session (full Trace); Scoreboard records link back via `session_id`. **Scores are not black-box output — every number can be traced to the run that produced it.** The Web evaluation pages are read-only views of these files (the trend chart shows Score only; the detail table separates model ID and thinking level).

## Deep dive 1: why `run_subagent`'s two-phase execution supports the "parallel evaluation matrix"

An easy fact to miss: **a top-level Agent is a single-threaded ReAct loop that executes one tool call at a time.** If every evaluation cell blocked synchronously, the Case × runs matrix would only run serially — one round (say 5 Cases × 3 runs) would wait for 15 complete Agent runs to finish one by one. `run_subagent`'s two-phase semantics (`packages/core/src/environment/tools/run-subagent.ts`, structurally mirroring `exec_command`) exist precisely to break this bottleneck.

### Phase 1: the yield window

After invoking `run_subagent`, within the `yield_time_ms` window (default 300 s, clamped by the tool's `timeoutMs`), `collectWindow` (`packages/core/src/environment/tools/subagent/collect.ts`) does three things:

- **forwards** the child session's OmniMessages in real time (already origin-tagged) to the frontend — the caller and the user see the child Agent's tool calls and token usage;
- copies the **direct child layer's** (origin one hop) text deltas **back as the parent tool's own output deltas** to the parent LLM — the parent model can "see" what the child is saying within the window;
- attaches an approval sink (`attachApprovalSink`) to forward the child session's **approval queue to the Human one at a time** via `ctx.approve`.

If the child finishes within the window, its terminal state is returned and the child session is released; **if the window expires while it is still running**, it moves to phase 2.

### Phase 2: background

- The child session is registered into the `BackgroundRegistry` (shared with command sessions, `packages/core/src/environment/tools/background/registry.ts`), gets a `subagent_id`, and `run_subagent` **returns immediately** (`stopReason: completed` plus a hint to access it via `input_subagent`);
- Output produced outside the window goes into buffers: a message buffer capped at 4096 entries and a text buffer capped at 1 MiB, **overflow dropping the oldest** — note this only affects frontend replay; the child Session's own Trace and text buffer are unaffected;
- The child session's tool approval requests are **queued** while in the background (the child blocks waiting); they are reviewed on the next `input_subagent` access (`first-to-arrive-wins`, a late decision still takes effect).

### Why this constitutes "parallelism"

The key is that **the parent LLM is released when the window expires.** Once it holds a `subagent_id`, it can immediately issue the next `run_subagent` to dispatch the next cell — multiple child sessions advance concurrently, in-process, via their own async pumps (`ManagedSubagentSession.pump`). So:

> **The parallelism is not provided by the engine — it is the number of concurrent background child sessions the parent LLM actively dispatches.** The engine is a single-threaded event loop, but each child session is an async task that never blocks the loop; orchestrating the matrix (which cells to dispatch, how to collect them) is the Optimizer's Skill-prompt responsibility.

This differs fundamentally from "engine-level thread/process pools": it is **logical parallelism at the orchestration layer** (prompts) achieved over **mechanism-layer tools** (two-phase execution). Its degree is bounded by two soft/hard constraints:

- **Concurrency cap**: `BackgroundRegistry.makeRoom(false)` — subagent capacity is checked **before launch**; if full, dispatch is rejected; **a running subagent is never evicted** (discarding in-progress evaluation work is semantically unacceptable, opposite to the command-session LRU-eviction policy). This guarantees the evaluation matrix is either dispatched in full or explicitly refused — never silently short a few cells.
- **Approval funnel**: if an Evaluator needs approval inside its isolated Workspace, it connects to the Human within the window and queues afterward. Evaluation typically uses `--approve allow-all` (see `agent-evaluation`), so the matrix is usually not blocked by approvals.

### Summary

`run_subagent`'s two-phase design decouples long-running work (a single evaluation can take minutes) from blocking the parent loop: real-time visibility in the window, background afterwards. The matrix's parallelism is therefore **the parent LLM being parallel**, not the platform parallelizing for it — fully consistent with the whole design's philosophy that "orchestration intelligence lives in the prompts".

## Deep dive 2: "prompt-as-policy" vs traditional RL / evolutionary algorithms

Putting agent improvement into one shared abstract frame (individual representation / variation operator / fitness / selection), the three representative families compare as follows:

| | **Prompt-as-policy** (this repo) | **Eureka** (NVIDIA, 2023) | **FunSearch** (DeepMind, 2023) |
| --- | --- | --- | --- |
| Representation | prompt files: `AGENTS.md` / Skills / config | reward function (executable code) | programs (Python functions) |
| Variation | LLM directed edits (diagnose → hypothesize → edit prompts) | LLM generates/rewrites reward functions | LLM crossover/mutation (island-based evolution) |
| Fitness | LLM-graded Benchmark (multi-Run average) | policy performance from environment interaction (RL training return) | deterministic mathematical objective (exactly evaluable) |
| Selection | single-Reference hill-climbing: accept only strictly higher | keep the improved reward iteratively | program pool + diversity maintenance (map-elites-like) |
| Search unit | 1 Candidate at a time | 1 reward function at a time | large per-generation program samples |

All three share the same skeleton — **an LLM acting as a black-box meta-optimizer driving an external evaluation loop** — but differ completely in representation, signal, and search strategy. Dimension by dimension:

### Representation: text vs weights

- **Prompts**: human-readable, auditable, explainable; improvements accumulate as an edit history, naturally supporting versions and rollback. But **non-differentiable, no gradient signal**, and coarse-grained (a change is a stretch of natural language; you cannot attribute effects to a specific token).
- **Weights**: gradient-optimizable with strong signal, but uninterpretable and requiring large-scale RL infrastructure (environment interaction + compute + training loops).
- **Implication**: prompt representation covers the full improvement space only when "the Agent's behavior is largely determined by prompt configuration". This repo's Target Agent is "a general LLM + prompt configuration" — its evolvable surface *is* text, so prompt representation is not a compromise but the representation that matches the model form.

### Fitness signal: Benchmark grading vs precise reward

- **LLM-graded Benchmark**: flexible, no ground truth needed, can measure "capability/behavior" rather than "task loss", and evaluation is just running the Agent (no environment simulator). But it is **noisy and biased** — the judge is itself an LLM; consistency and stylistic preference cannot be fully eliminated.
- **Eureka's motivation** is precisely the pain of hand-designed reward shaping: hard to write, easy to hack (reward hacking) — so it lets the LLM generate the reward function. But Eureka's fitness ultimately remains environment return (precise, noiseless); only the reward function is LLM-evolved.
- **FunSearch's fitness** is a deterministic mathematical objective (e.g. cap set size) — **exactly verifiable**, so its evolutionary pressure is the cleanest — but it only applies to problems whose objective can be evaluated programmatically.
- **Implication**: PenguinHarness uses LLM grading because the evaluation dimension is open (agent capability behavior) with no programmable ground truth. The price is having to handle evaluation noise inside the evolution loop (multi-Run averaging, distinguishing Case-behavior changes, accept-only-on-strict-improvement).

### Variation and search: directed mutation vs gradient vs population

- **LLM as variation operator**: leverages world knowledge and an understanding of agent behavior for **semantic-space directed mutation** — far more efficient than random mutation or gradients in semantic space (it knows "add a planning step" is likelier to help than "change a random word"). But mutation is **black-box, unstable, non-reproducible** (same input, different output), which is why a conservative selection policy (strict improvement) hedges it.
- **FunSearch's population** explicitly maintains diversity (island-based / program pool), reducing local-optimum risk; **Eureka** evolves one reward function at a time (point-wise iteration), like PenguinHarness — but every Eureka candidate requires a full RL training run to evaluate, at enormous cost.
- **PenguinHarness chooses single-Reference hill-climbing**: no population, no crossover. Escaping local optima relies on two things — a **fresh diagnosis each round** from scores and Traces, and using **rejected Candidates as evidence for later hypotheses** (implicit memory). It is the cheapest search strategy, but the most dependent on LLM diagnosis quality.

### Compute cost and engineering threshold

| | Sample/call cost | Infra threshold | Improvement boundary |
| --- | --- | --- | --- |
| Prompt-as-policy | each evaluation = one full Agent run (several LLM calls), growing linearly with runs×cases×rounds; no sampling exploration — a "few-but-targeted" directed search | **zero training infra**: no simulator, no RL loop, no GPU cluster | within prompt space (cannot learn new tools, cannot change weights) |
| Eureka | each candidate reward = one full RL training run, **very expensive** | GPU environment simulator (Isaac Gym etc.) + RL stack | weight + reward space |
| FunSearch | many program samples evaluated per generation (parallelizable but voluminous) | environment whose objective is programmatically evaluable | program space |

### Why this trade-off is reasonable for this repo

1. **Self-consistent with the product form**: the platform delivers "general LLM + prompt-configured" agents; the improvement boundary is text — prompt representation covers the full improvement space;
2. **Auditability/rollback is product value**: every score traces to a Trace, every version has a snapshot, failures roll back — this directly serves a "trustworthy agent platform", while weight training is inherently unauditable;
3. **User participation**: evolution is not a one-off training pipeline but a workflow users run in the Web app / CLI (evaluation center, snapshot export/import); the policy itself is a Skill, evolvable and verifiable — **meta-level closure**;
4. **Zero infra threshold**: evaluation is just running the Agent — any environment with model credentials can run the full loop.

**An honest boundary**: this approach's evolution efficiency ceiling is below gradient- or population-based methods, and it is doubly constrained by LLM diagnosis quality and evaluation noise. It is the "few-but-targeted, explainable, auditable" route, not the "large-scale exploration, strong signal" route — the two fit "productized agent platforms" and "research-grade automation" respectively.

## Risks and design review

The following distinguish **fact** (verifiable), **inference** (supported but unverified), and **hypothesis** (unsupported):

1. **Evaluation noise × strict improvement → Benchmark overfitting risk** (inference). At small sample sizes a Candidate's multi-Run average still carries noise; "strictly higher" cannot fully separate "real capability gain" from "lucky answer". Mitigations exist by design: Cases emphasize distinguishing intended behavior from shortcuts, points rest on reusable capabilities rather than one-off facts, and whether the hypothesis held on the expected Cases is reported separately. But **as long as the judge is an LLM, this risk cannot be eliminated** — reduced, not removed.
2. **The trust model: the Scoreboard is "model-written, server read-only"** (fact). This constraint prevents server recomputation drift, but pins correctness entirely on SKILL.md's instruction discipline — if an Optimizer misbehaves (writes bogus scores, miscalculates aggregates), **no mechanism layer backstops it**. This is the inherent cost of prompt-as-policy.
3. **The Formal Baseline is a single-point baseline** (fact): a one-Run record that every Candidate is compared against, and the first comparison may directly compare a Candidate's multi-Run average with the Baseline's one-Run score. This introduces sampling variance on the baseline side; the docs explicitly choose "no rerun, no backfill". It is **deliberate** (saves cost, avoids optimizing the baseline) but the statistical footing of the comparison is weak (inference).
4. **Single-Reference hill-climbing can stall** (hypothesis): without a population there is no explicit diversity protection; escaping local optima depends on the LLM's "fresh diagnosis". A weak-diagnosis optimizer may sit at a local optimum indefinitely — currently no mechanism-level detection or penalty (e.g. forcing a direction change after sustained non-improvement).
5. **LLM-judge stylistic bias** (inference): LLM grading may systematically favor certain output styles (longer analyses, particular formatting) even when rubrics emphasize concise artifacts — this interacts with Case design and is worth watching during Benchmark calibration.

## Related references

- Functional description: [Self-Improvement](/self-improvement)
- Protocol & tools: [Sessions & Traces](/sessions-and-traces), [Tools](/tools), [Skills](/skills)
- Related Skills: [`agent-creation`](../../skills/skills/agent-creation/SKILL.zh.md), [`benchmark-design`](../../skills/skills/benchmark-design/SKILL.zh.md), [`agent-evaluation`](../../skills/skills/agent-evaluation/SKILL.zh.md), [`agent-optimization`](../../skills/skills/agent-optimization/SKILL.zh.md) (Chinese reading versions; the English source is `packages/skills/skills/<skill>/SKILL.md`; at runtime they are installed at `~/.penguin/data/agents/<agent>/agent_state/skills/<skill>/SKILL.md`, with `default_agent` shipping the whole library — see the [Skills](/skills) overview)
- Key implementation: `packages/core/src/environment/tools/run-subagent.ts` (two-phase tool), `packages/core/src/environment/tools/subagent/*` and `background/*` (window collection, background registry), `packages/core/src/state/example-benchmark.ts` (sample data), `packages/server/src/services/snapshot-service.ts` (snapshot / export-import)
