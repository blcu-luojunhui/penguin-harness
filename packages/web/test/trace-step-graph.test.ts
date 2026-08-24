import { describe, expect, it } from "vitest";
import type { OmniMessage } from "@prismshadow/penguin-core/omnimessage";
import { layoutTraceStepGraph, projectTraceStep } from "../src/features/traces/trace-step-model";

const TRACE_ID = "trace-1";
const TASK_ID = "task-1";
const STEP_ID = "step-1";

function record(args: {
  id: string;
  ts: string;
  payload: Record<string, unknown>;
  spanId?: string;
  parentSpanId?: string;
  causedByEventId?: string;
  type?: "event_msg" | "model_msg";
}): OmniMessage {
  return {
    timestamp: args.ts,
    protocol_version: 3,
    event_id: args.id,
    type: args.type ?? "event_msg",
    payload: args.payload,
    trace: {
      trace_id: TRACE_ID,
      task_id: TASK_ID,
      step_id: STEP_ID,
      ...(args.spanId !== undefined ? { span_id: args.spanId } : {}),
      ...(args.parentSpanId !== undefined ? { parent_span_id: args.parentSpanId } : {}),
      ...(args.causedByEventId !== undefined ? { caused_by_event_id: args.causedByEventId } : {}),
    },
  } as unknown as OmniMessage;
}

function begin(
  id: string,
  ts: string,
  spanId: string,
  spanKind: string,
  opts: { parentSpanId?: string; causedByEventId?: string; attributes?: object } = {},
): OmniMessage {
  return record({
    id,
    ts,
    spanId,
    payload: {
      type: "span_begin",
      span_kind: spanKind,
      capabilities: {
        editable_input: false,
        repeatable: spanKind === "llm.attempt",
        rerunnable: false,
        skippable: false,
      },
      ...(opts.attributes !== undefined ? { attributes: opts.attributes } : {}),
    },
    ...(opts.parentSpanId !== undefined ? { parentSpanId: opts.parentSpanId } : {}),
    ...(opts.causedByEventId !== undefined ? { causedByEventId: opts.causedByEventId } : {}),
  });
}

function end(
  id: string,
  ts: string,
  spanId: string,
  spanKind: string,
  status: string,
): OmniMessage {
  return record({
    id,
    ts,
    spanId,
    payload: { type: "span_end", span_kind: spanKind, status },
  });
}

describe("projectTraceStep", () => {
  it("keeps retry attempts separate and uses append order when timestamps disagree", () => {
    const records = [
      begin("step-b", "2026-08-19T00:00:00.090Z", "step", "agent.step"),
      begin("req-b", "2026-08-19T00:00:00.080Z", "request", "llm.request", {
        parentSpanId: "step",
      }),
      begin("a1-b", "2026-08-19T00:00:00.070Z", "attempt-1", "llm.attempt", {
        parentSpanId: "request",
        attributes: { attempt: 1 },
      }),
      end("a1-e", "2026-08-19T00:00:00.060Z", "attempt-1", "llm.attempt", "timeout"),
      begin("a2-b", "2026-08-19T00:00:00.050Z", "attempt-2", "llm.attempt", {
        parentSpanId: "request",
        attributes: { attempt: 2 },
      }),
      record({
        id: "answer",
        ts: "2026-08-19T00:00:00.040Z",
        type: "model_msg",
        spanId: "attempt-2",
        payload: { type: "text", role: "assistant", text: "done" },
      }),
      record({
        id: "usage",
        ts: "2026-08-19T00:00:00.035Z",
        spanId: "attempt-2",
        payload: {
          type: "token_usage",
          request: { cache_read: 10, cache_write: 2, output: 3, total: 15 },
          session: { cache_read: 20, cache_write: 4, output: 6, total: 30 },
        },
      }),
      end("a2-e", "2026-08-19T00:00:00.030Z", "attempt-2", "llm.attempt", "completed"),
      end("req-e", "2026-08-19T00:00:00.020Z", "request", "llm.request", "completed"),
      end("step-e", "2026-08-19T00:00:00.010Z", "step", "agent.step", "completed"),
    ];

    const graph = projectTraceStep(records, STEP_ID);

    expect(
      graph.nodes
        .filter((node) => node.nodeType === "span" && node.spanKind === "llm.attempt")
        .map((node) => ({
          label: node.label,
          status: node.status,
          repeatable: node.nodeType === "span" ? node.capabilities?.repeatable : undefined,
        })),
    ).toEqual([
      { label: "LLM Attempt #1", status: "timeout", repeatable: true },
      { label: "LLM Attempt #2", status: "completed", repeatable: true },
    ]);
    expect(graph.nodes.map((node) => node.id)).toEqual([
      "span:step",
      "span:request",
      "span:attempt-1",
      "span:attempt-2",
      "event:answer",
    ]);
    expect(graph.nodes.find((node) => node.id === "event:answer")).toMatchObject({
      nodeType: "observation",
      observationKind: "output",
      output: "done",
    });
    expect(graph.nodes.find((node) => node.id === "span:attempt-2")).toMatchObject({
      output: {
        status: "completed",
        token_usage: {
          request: { cache_read: 10, cache_write: 2, output: 3, total: 15 },
          session: { cache_read: 20, cache_write: 4, output: 6, total: 30 },
        },
      },
    });
  });

  it("connects a tool execution to its explicit proposal event", () => {
    const graph = projectTraceStep(
      [
        begin("step-b", "2026-08-19T00:00:00.000Z", "step", "agent.step"),
        begin("attempt-b", "2026-08-19T00:00:00.010Z", "attempt", "llm.attempt", {
          parentSpanId: "step",
        }),
        record({
          id: "proposal",
          ts: "2026-08-19T00:00:00.020Z",
          type: "model_msg",
          spanId: "attempt",
          payload: {
            type: "tool_call",
            role: "assistant",
            name: "search",
            arguments: '{"q":"penguin"}',
            tool_call_id: "call-1",
          },
        }),
        begin("tool-b", "2026-08-19T00:00:00.030Z", "tool", "tool.execute", {
          parentSpanId: "step",
          causedByEventId: "proposal",
          attributes: { tool_name: "search", tool_call_id: "call-1" },
        }),
        record({
          id: "result",
          ts: "2026-08-19T00:00:00.040Z",
          type: "model_msg",
          spanId: "tool",
          payload: {
            type: "tool_call_output",
            role: "user",
            output: "found",
            tool_call_id: "call-1",
          },
        }),
      ],
      STEP_ID,
    );

    expect(graph.edges).toContainEqual({
      id: "causal:event:proposal>span:tool",
      source: "event:proposal",
      target: "span:tool",
      kind: "causal",
    });
    expect(graph.edges).toContainEqual({
      id: "hierarchy:span:tool>event:result",
      source: "span:tool",
      target: "event:result",
      kind: "hierarchy",
    });
    const layout = layoutTraceStepGraph(graph);
    const proposal = layout.nodes.find((item) => item.node.id === "event:proposal")!;
    const tool = layout.nodes.find((item) => item.node.id === "span:tool")!;
    expect(tool.x).toBeGreaterThan(proposal.x);
  });

  it("projects a future explicit observation kind without inferring it from text", () => {
    const graph = projectTraceStep(
      [
        begin("attempt-b", "2026-08-19T00:00:00.000Z", "attempt", "llm.attempt"),
        record({
          id: "evaluation",
          ts: "2026-08-19T00:00:00.010Z",
          spanId: "attempt",
          payload: {
            type: "observation",
            kind: "evaluation",
            input: { rubric: "correctness" },
            output: { score: 0.9 },
          },
        }),
      ],
      STEP_ID,
    );

    expect(graph.nodes.find((node) => node.id === "event:evaluation")).toMatchObject({
      nodeType: "observation",
      observationKind: "evaluation",
      input: { rubric: "correctness" },
      output: { score: 0.9 },
    });
  });

  it("keeps an unclosed span visible as running and ignores control events", () => {
    const graph = projectTraceStep(
      [
        begin("attempt-b", "2026-08-19T00:00:00.000Z", "attempt", "llm.attempt"),
        record({
          id: "usage",
          ts: "2026-08-19T00:00:00.010Z",
          spanId: "attempt",
          payload: { type: "token_usage", request: { total: 10 } },
        }),
        record({
          id: "future-control",
          ts: "2026-08-19T00:00:00.020Z",
          spanId: "attempt",
          payload: { type: "future_control", command: "pause" },
        }),
      ],
      STEP_ID,
    );

    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]).toMatchObject({
      id: "span:attempt",
      nodeType: "span",
      status: "running",
    });
  });

  it("attaches an explicit subagent pointer to its invoke span without rendering a control node", () => {
    const graph = projectTraceStep(
      [
        begin("step-b", "2026-08-19T00:00:00.000Z", "step", "agent.step"),
        begin("child-b", "2026-08-19T00:00:00.010Z", "child", "subagent.invoke", {
          parentSpanId: "step",
        }),
        record({
          id: "child-pointer",
          ts: "2026-08-19T00:00:00.020Z",
          spanId: "child",
          payload: { type: "subagent", session_id: "child-session" },
        }),
        end("child-e", "2026-08-19T00:00:00.030Z", "child", "subagent.invoke", "completed"),
      ].reverse(),
      STEP_ID,
    );

    expect(graph.nodes.find((node) => node.id === "span:child")).toMatchObject({
      nodeType: "span",
      spanKind: "subagent.invoke",
      childSessionId: "child-session",
      rawPayloads: expect.arrayContaining([{ type: "subagent", session_id: "child-session" }]),
    });
    expect(graph.nodes.find((node) => node.id === "event:child-pointer")).toBeUndefined();
  });
});
