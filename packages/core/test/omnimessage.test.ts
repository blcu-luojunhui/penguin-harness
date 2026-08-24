import { describe, expect, it } from "vitest";
import {
  PartialAggregator,
  OMNI_PROTOCOL_VERSION,
  aggregateAll,
  abortEvent,
  addTokenCounts,
  approvalDecision,
  assistantText,
  emptyTokenCounts,
  isCompleteModelMessage,
  observation,
  partialText,
  partialToolCall,
  partialToolCallOutput,
  spanBegin,
  spanEnd,
  toolCall,
  toolCallOutput,
  userText,
  withTraceContext,
} from "../src/omnimessage/index.js";
import type {
  TextPayload,
  ToolCallOutputPayload,
  ToolCallPayload,
} from "../src/omnimessage/index.js";

describe("builders", () => {
  it("stamps an ISO 8601 timestamp and correct shells", () => {
    const m = userText("hi");
    expect(m.type).toBe("model_msg");
    expect(m.payload.type).toBe("text");
    expect(m.payload.role).toBe("user");
    expect(new Date(m.timestamp).toISOString()).toBe(m.timestamp);
    expect(m.protocol_version).toBe(OMNI_PROTOCOL_VERSION);
    expect(m.event_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("builds Span lifecycle and explicit observation events with stable Trace context", () => {
    const traceId = "trace-1";
    const taskId = "task-1";
    const stepId = "step-1";
    const requestId = "request-1";
    const attemptId = "attempt-1";
    const begin = spanBegin({
      kind: "llm.attempt",
      traceId,
      taskId,
      stepId,
      spanId: attemptId,
      parentSpanId: requestId,
      attributes: { input_event_ids: ["input-1"], attempt: 2 },
    });

    expect(begin.payload).toEqual({
      type: "span_begin",
      span_kind: "llm.attempt",
      capabilities: {
        editable_input: false,
        repeatable: true,
        rerunnable: false,
        skippable: false,
      },
      attributes: { input_event_ids: ["input-1"], attempt: 2 },
    });
    expect(begin.trace).toEqual({
      trace_id: traceId,
      task_id: taskId,
      step_id: stepId,
      span_id: attemptId,
      parent_span_id: requestId,
    });

    const end = spanEnd({
      kind: "llm.attempt",
      traceId,
      taskId,
      stepId,
      spanId: attemptId,
      parentSpanId: requestId,
      status: "skipped",
    });
    expect(end.payload).toMatchObject({
      type: "span_end",
      span_kind: "llm.attempt",
      status: "skipped",
    });

    const observed = withTraceContext(
      observation({ kind: "planning", content: "Inspect the failing request." }),
      {
        trace_id: traceId,
        task_id: taskId,
        step_id: stepId,
        span_id: attemptId,
        parent_span_id: requestId,
      },
    );
    expect(observed.payload).toEqual({
      type: "observation",
      kind: "planning",
      content: "Inspect the failing request.",
    });
    expect(observed.trace?.span_id).toBe(attemptId);
    expect(new Set([begin.event_id, end.event_id, observed.event_id]).size).toBe(3);
  });

  it("builds event messages", () => {
    const a = approvalDecision("allow", "call_1");
    expect(a.type).toBe("event_msg");
    expect(a.payload).toMatchObject({
      type: "approval_decision",
      decision: "allow",
      tool_call_id: "call_1",
    });
    expect(abortEvent("stop").payload).toMatchObject({
      type: "abort",
      reason: "stop",
    });
  });

  it("toolCallOutput carries optional images and round-trips through JSON", () => {
    const dataUrl = "data:image/png;base64,AAAA";
    const msg = toolCallOutput({
      output: "image/png, 4 B",
      toolCallId: "call_img",
      images: [dataUrl],
    });
    expect(msg.payload).toMatchObject({
      type: "tool_call_output",
      role: "user",
      output: "image/png, 4 B",
      images: [dataUrl],
      tool_call_id: "call_img",
      stop_reason: "completed",
    });
    // A JSON serialization round-trip preserves images (same shape as Trace persistence / replay).
    const revived = JSON.parse(JSON.stringify(msg)) as { payload: ToolCallOutputPayload };
    expect(revived.payload.images).toEqual([dataUrl]);
    // The images field is not produced when omitted or given an empty array (absence means no
    // images; serialization does not carry an empty field).
    expect("images" in toolCallOutput({ output: "x", toolCallId: "c" }).payload).toBe(false);
    expect("images" in toolCallOutput({ output: "x", toolCallId: "c", images: [] }).payload).toBe(
      false,
    );
  });

  it("partialToolCallOutput delta carries optional images (whole image in one delta)", () => {
    const dataUrl = "data:image/png;base64,AAAA";
    const msg = partialToolCallOutput({
      eventType: "delta",
      toolCallId: "call_img",
      images: [dataUrl],
    });
    expect(msg.payload).toMatchObject({
      type: "partial_tool_call_output",
      event_type: "delta",
      output: "",
      images: [dataUrl],
      tool_call_id: "call_img",
    });
    // The images field is not produced when omitted or given an empty array (same as the complete message).
    expect("images" in partialToolCallOutput({ eventType: "delta", toolCallId: "c" }).payload).toBe(
      false,
    );
    expect(
      "images" in
        partialToolCallOutput({ eventType: "delta", toolCallId: "c", images: [] }).payload,
    ).toBe(false);
  });

  it("adds token counts", () => {
    const a = { cache_read: 1, cache_write: 2, output: 3, total: 6 };
    const b = { cache_read: 10, cache_write: 20, output: 30, total: 60 };
    expect(addTokenCounts(a, b)).toEqual({
      cache_read: 11,
      cache_write: 22,
      output: 33,
      total: 66,
    });
    expect(emptyTokenCounts()).toEqual({
      cache_read: 0,
      cache_write: 0,
      output: 0,
      total: 0,
    });
  });
});

describe("isCompleteModelMessage", () => {
  it("distinguishes complete from partial model messages", () => {
    expect(isCompleteModelMessage(assistantText("done"))).toBe(true);
    expect(isCompleteModelMessage(partialText("delta", "x"))).toBe(false);
    expect(isCompleteModelMessage(approvalDecision("deny", "c"))).toBe(false);
  });
});

describe("PartialAggregator", () => {
  it("folds a partial_text stream into one complete text message", () => {
    const out = aggregateAll([
      partialText("start", "Hel"),
      partialText("delta", "lo "),
      partialText("delta", "world"),
      partialText("stop", "", "completed"),
    ]);
    expect(out).toHaveLength(1);
    expect(isCompleteModelMessage(out[0]!)).toBe(true);
    const p = out[0]!.payload as TextPayload;
    expect(p.type).toBe("text");
    expect(p.text).toBe("Hello world");
    expect(p.stop_reason).toBe("completed");
  });

  it("accumulates partial_tool_call arguments and preserves tool_call_id", () => {
    const out = aggregateAll([
      partialToolCall({ eventType: "start", name: "exec_command", toolCallId: "c1" }),
      partialToolCall({
        eventType: "delta",
        name: "exec_command",
        arguments: '{"cmd":"ls',
        toolCallId: "c1",
      }),
      partialToolCall({
        eventType: "delta",
        name: "exec_command",
        arguments: ' -la"}',
        toolCallId: "c1",
      }),
      partialToolCall({ eventType: "stop", name: "exec_command", toolCallId: "c1" }),
    ]);
    expect(out).toHaveLength(1);
    const p = out[0]!.payload as ToolCallPayload;
    expect(p.type).toBe("tool_call");
    expect(p.name).toBe("exec_command");
    expect(p.tool_call_id).toBe("c1");
    expect(p.arguments).toBe('{"cmd":"ls -la"}');
  });

  it("folds tool output image deltas into the complete tool_call_output (concatenated == complete)", () => {
    const dataUrl = "data:image/png;base64,AAAA";
    const out = aggregateAll([
      partialToolCallOutput({ eventType: "start", toolCallId: "c9" }),
      partialToolCallOutput({ eventType: "delta", output: "image/png, 4 B", toolCallId: "c9" }),
      partialToolCallOutput({ eventType: "delta", toolCallId: "c9", images: [dataUrl] }),
      partialToolCallOutput({ eventType: "stop", toolCallId: "c9" }),
    ]);
    expect(out).toHaveLength(1);
    const p = out[0]!.payload as ToolCallOutputPayload;
    expect(p.type).toBe("tool_call_output");
    expect(p.output).toBe("image/png, 4 B");
    expect(p.images).toEqual([dataUrl]);
  });

  it("passes through complete and event messages unchanged and keeps order", () => {
    const tc = toolCall({ name: "x", arguments: "{}", toolCallId: "c2" });
    const out = aggregateAll([userText("q"), tc, approvalDecision("allow", "c2")]);
    expect(out).toHaveLength(3);
    // The session_meta payload has no inner type field, so consumers must first narrow by the
    // outer type; here we assert order and passthrough with a loose read.
    const payloadTypes = out.map((m) => (m.payload as { type?: string }).type);
    expect(payloadTypes).toEqual(["text", "tool_call", "approval_decision"]);
    expect(out.map((m) => m.type)).toEqual(["model_msg", "model_msg", "event_msg"]);
  });

  it("flush emits unterminated fragments", () => {
    const agg = new PartialAggregator();
    expect(agg.push(partialText("start", "abc"))).toEqual([]);
    expect(agg.push(partialText("delta", "def"))).toEqual([]);
    const flushed = agg.flush();
    expect(flushed).toHaveLength(1);
    expect((flushed[0]!.payload as TextPayload).text).toBe("abcdef");
  });
});
