/** Pure selection and filtering helpers for the protocol-v3 logical Trace workspace. */
import type { OmniMessage } from "@prismshadow/penguin-core/omnimessage";
import type {
  TraceRootSubagent,
  TraceRootSummary,
  TraceStepSummary,
  TraceTaskSummary,
} from "@prismshadow/penguin-server/api";

/** Server append order is causal display order; these helpers never sort by timestamps. */
export function initialRoot(
  roots: readonly TraceRootSummary[],
  preferredTraceId?: string | null,
): TraceRootSummary | null {
  if (roots.length === 0) return null;
  if (preferredTraceId !== undefined && preferredTraceId !== null) {
    return roots.find((root) => root.traceId === preferredTraceId) ?? null;
  }
  return roots[0]!;
}

export function initialTask(
  root: TraceRootSummary,
  tasks: readonly TraceTaskSummary[],
  preferredTaskId?: string | null,
): TraceTaskSummary | null {
  if (tasks.length === 0) return null;
  if (preferredTaskId !== undefined && preferredTaskId !== null) {
    const preferred = tasks.find((task) => task.taskId === preferredTaskId);
    if (preferred !== undefined) return preferred;
  }
  if (root.rootKind === "task") {
    return tasks.find((task) => task.taskId === root.traceId) ?? tasks[0]!;
  }
  return tasks[0]!;
}

export function initialStep(task: TraceTaskSummary | null): TraceStepSummary | null {
  return task?.steps[0] ?? null;
}

/** Goal roots expose their Task collection; standalone Task roots enter the workspace directly. */
export function showsTaskList(root: TraceRootSummary, tasks: readonly TraceTaskSummary[]): boolean {
  return root.rootKind === "goal_run" || tasks.length > 1;
}

/** Match the visible ordinal as well as stable ids and status; preserve append order. */
export function filterTraceSteps(
  steps: readonly TraceStepSummary[],
  query: string,
): TraceStepSummary[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle.length === 0) return [...steps];
  return steps.filter((step, index) =>
    [String(index + 1), step.stepId, step.spanId, step.status, step.partial ? "partial" : undefined]
      .filter((value): value is string => value !== undefined)
      .some((value) => value.toLocaleLowerCase().includes(needle)),
  );
}

/** V1/v2 records have no step_id and therefore never enter the v3 Step graph. */
export function recordsForTraceStep(
  records: readonly OmniMessage[],
  stepId: string,
): OmniMessage[] {
  return records.filter(
    (record) => record.protocol_version === 3 && record.trace?.step_id === stepId,
  );
}

/** Never borrow another invocation's target; only a session-only record is a safe fallback. */
export function subagentForSpan(
  subagents: readonly TraceRootSubagent[],
  childSessionId: string,
  spanId: string,
): TraceRootSubagent | undefined {
  return (
    subagents.find(
      (subagent) => subagent.sessionId === childSessionId && subagent.invocationSpanId === spanId,
    ) ??
    subagents.find(
      (subagent) =>
        subagent.sessionId === childSessionId && subagent.invocationSpanId === undefined,
    )
  );
}

/** Preserve every explicit child identity in a shareable Trace deep link. */
export function childTraceHref(subagent: TraceRootSubagent): string | null {
  if (subagent.agentId === undefined) return null;
  const params = new URLSearchParams({
    agentId: subagent.agentId,
    sessionId: subagent.sessionId,
  });
  if (subagent.childTraceId !== undefined) params.set("traceId", subagent.childTraceId);
  if (subagent.childTaskId !== undefined) params.set("taskId", subagent.childTaskId);
  return `/traces?${params.toString()}`;
}
