import { describe, expect, it } from "vitest";
import type { OmniMessage } from "@prismshadow/penguin-core/omnimessage";
import type {
  TraceRootSubagent,
  TraceRootSummary,
  TraceStepSummary,
  TraceTaskSummary,
} from "@prismshadow/penguin-server/api";
import {
  childTraceHref,
  filterTraceSteps,
  initialRoot,
  initialStep,
  initialTask,
  recordsForTraceStep,
  showsTaskList,
  subagentForSpan,
} from "../src/features/traces/logical-trace-model";

function step(taskId: string, index: number): TraceStepSummary {
  return {
    stepId: `${taskId}-step-${index}`,
    spanId: `${taskId}-step-${index}`,
    taskId,
    status: index === 35 ? "failed" : "completed",
    recordCount: index,
    partial: index === 34,
  };
}

function task(taskId: string, stepCount: number): TraceTaskSummary {
  return {
    taskId,
    spanId: taskId,
    status: "completed",
    recordCount: stepCount,
    partial: false,
    steps: Array.from({ length: stepCount }, (_, index) => step(taskId, index + 1)),
  };
}

function root(
  traceId: string,
  rootKind: TraceRootSummary["rootKind"],
  taskCount: number,
): TraceRootSummary {
  return {
    traceId,
    rootKind,
    status: "completed",
    recordCount: 100,
    taskCount,
    partial: false,
  };
}

describe("logical Trace navigation", () => {
  it("prefers an exact deep-linked root without reordering the inventory", () => {
    const roots = [root("goal-a", "goal_run", 2), root("goal-b", "goal_run", 1)];

    expect(initialRoot(roots, "goal-b")?.traceId).toBe("goal-b");
    expect(initialRoot(roots, "missing")).toBeNull();
    expect(initialRoot(roots)?.traceId).toBe("goal-a");
    expect(roots.map((item) => item.traceId)).toEqual(["goal-a", "goal-b"]);
  });

  it("keeps 35 Steps inside three Tasks for a Goal root", () => {
    const tasks = [task("task-a", 12), task("task-b", 12), task("task-c", 11)];
    const goal = root("goal-1", "goal_run", 3);

    expect(tasks.flatMap((item) => item.steps)).toHaveLength(35);
    expect(showsTaskList(goal, tasks)).toBe(true);
    expect(initialTask(goal, tasks)?.taskId).toBe("task-a");
    expect(initialStep(tasks[0]!)?.stepId).toBe("task-a-step-1");
  });

  it("opens a standalone Task directly without inventing a Goal layer", () => {
    const standalone = root("task-b", "task", 1);
    const tasks = [task("task-a", 1), task("task-b", 2)];

    expect(initialTask(standalone, tasks)?.taskId).toBe("task-b");
    expect(showsTaskList(standalone, [tasks[1]!])).toBe(false);
  });

  it("prefers an exact deep-linked Task inside the selected root", () => {
    const goal = root("goal-1", "goal_run", 2);
    const tasks = [task("task-a", 1), task("task-b", 2)];

    expect(initialTask(goal, tasks, "task-b")?.taskId).toBe("task-b");
    expect(initialTask(goal, tasks, "missing")?.taskId).toBe("task-a");
  });

  it("filters a long Step list by ordinal, id, status, and partial marker", () => {
    const steps = task("task-a", 35).steps;

    expect(filterTraceSteps(steps, "")).toEqual(steps);
    expect(filterTraceSteps(steps, "task-a-step-35").map((item) => item.stepId)).toEqual([
      "task-a-step-35",
    ]);
    expect(filterTraceSteps(steps, "failed").map((item) => item.stepId)).toEqual([
      "task-a-step-35",
    ]);
    expect(filterTraceSteps(steps, "partial").map((item) => item.stepId)).toEqual([
      "task-a-step-34",
    ]);
  });
});

describe("logical Trace record projection", () => {
  const message = (protocol: number, stepId?: string): OmniMessage =>
    ({
      timestamp: "2026-08-20T00:00:00.000Z",
      protocol_version: protocol,
      event_id: `${protocol}-${stepId ?? "legacy"}`,
      type: "event_msg",
      payload: { type: "custom" },
      ...(stepId === undefined
        ? { trace: { turn_id: "legacy-turn" } }
        : { trace: { trace_id: "trace-1", task_id: "task-1", step_id: stepId } }),
    }) as unknown as OmniMessage;

  it("selects only protocol-v3 records owned by the focused Step", () => {
    const selected = recordsForTraceStep(
      [message(2), message(3, "step-2"), message(3, "step-1")],
      "step-1",
    );
    expect(selected.map((record) => record.event_id)).toEqual(["3-step-1"]);
  });

  it("resolves repeated child invocations by exact Span before Session fallback", () => {
    const subagents: TraceRootSubagent[] = [
      { sessionId: "child", agentId: "agent", invocationSpanId: "invoke-1" },
      { sessionId: "child", agentId: "agent", invocationSpanId: "invoke-2" },
      { sessionId: "legacy-child", agentId: "agent" },
    ];
    expect(subagentForSpan(subagents, "child", "invoke-2")?.invocationSpanId).toBe("invoke-2");
    expect(subagentForSpan(subagents, "child", "unknown")).toBeUndefined();
    expect(subagentForSpan(subagents, "legacy-child", "unknown")?.sessionId).toBe("legacy-child");
  });

  it("keeps child Trace and Task identity in the navigation URL", () => {
    expect(
      childTraceHref({
        sessionId: "child session",
        agentId: "agent/one",
        childTraceId: "goal:two",
        childTaskId: "task?three",
      }),
    ).toBe(
      "/traces?agentId=agent%2Fone&sessionId=child+session&traceId=goal%3Atwo&taskId=task%3Fthree",
    );
    expect(childTraceHref({ sessionId: "child" })).toBeNull();
  });
});
