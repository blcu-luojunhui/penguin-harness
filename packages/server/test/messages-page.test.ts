/**
 * Windowed history reads (TraceService.readMessagesPage + GET /messages paging params).
 *
 * Covers: tail/before window slicing mid-shard and across shard boundaries, cursor
 * round-trips, pairing-safe cut points (a window never separates a tool_call from its
 * output, a compaction span, or a steering group), subagent expansion happening only
 * for pointers inside the window, outline-turn counting (`earlierTurns`) staying in
 * step with the Web's buildOutline rule (its twin fixtures live in
 * web/test/outline-model.test.ts and stream-model.test.ts — keep the two sides
 * agreeing), prior stats (elapsed / subagent tokens / session tokens / context), the
 * shard-read discipline (an old-window request never reads the newest shard and vice
 * versa, once the per-shard prefix cache is primed), and the no-params full read
 * staying byte-identical with no `page` envelope.
 */
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  abortEvent,
  assistantText,
  compactionBegin,
  compactionEnd,
  imageUrlMessage,
  requestBegin,
  requestEnd,
  sessionMeta,
  subagentEvent,
  tokenUsage,
  toolCall,
  toolCallOutput,
  toolListReady,
  traceBegin,
  traceEnd,
  userText,
  withTraceContext,
} from "@prismshadow/penguin-core";
import { buildHandoffMessage } from "@prismshadow/penguin-core/markers";
import type { OmniMessage, SessionMetaPayload, TokenCounts } from "@prismshadow/penguin-core";
import { decodeCursor, encodeCursor } from "../src/services/message-window.js";
import type { TraceService } from "../src/services/trace-service.js";
import {
  makeTempRoot,
  makeTraceHarness,
  writeLogicalTraceEvents,
  writeLogicalTraceJournal,
  writeTraceFile,
} from "./helpers.js";

const P = "project-w";
const A = "agent-w";
const S = "session-2026-07-20-10-00-00-aabb0001";
const CHILD = "session-2026-07-20-10-00-05-ccdd0002";

function at(ts: string, msg: OmniMessage): OmniMessage {
  return { ...msg, timestamp: ts };
}

function counts(total: number): TokenCounts {
  return { cache_read: 0, cache_write: 0, output: total, total };
}

function metaPayload(over: Partial<SessionMetaPayload> = {}): SessionMetaPayload {
  return {
    session_id: S,
    model_id: "m1",
    provider: "custom",
    model_context_window: 1000,
    system_prompt: "sp",
    agent_state: "/tmp/a",
    workspace: "/tmp/w",
    ...over,
  };
}

/** One complete turn (prompt → request → reply → usage), 4 messages, spaced inside one minute `mm`. */
function turn(mm: number, n: number, sessionTotal: number): OmniMessage[] {
  const t = (s: string) => `2026-07-20T10:${String(mm).padStart(2, "0")}:${s}Z`;
  return [
    at(t("00.000"), userText(`q${n}`)),
    at(t("01.000"), requestBegin()),
    at(t("02.000"), assistantText(`a${n}`)),
    at(t("03.000"), requestEnd("completed")),
    at(t("03.500"), tokenUsage(counts(sessionTotal), counts(100 + n))),
  ];
}

function v3Turn(
  traceId: string,
  taskId: string,
  mm: number,
  n: number,
  sessionTotal: number,
): OmniMessage[] {
  const stamp = (message: OmniMessage): OmniMessage =>
    withTraceContext(message, { trace_id: traceId, task_id: taskId });
  return [
    at(
      `2026-07-20T10:${String(mm).padStart(2, "0")}:00.000Z`,
      traceBegin({ rootKind: "task", traceId, taskId }),
    ),
    ...turn(mm, n, sessionTotal).map(stamp),
    at(
      `2026-07-20T10:${String(mm).padStart(2, "0")}:04.000Z`,
      traceEnd({ rootKind: "task", traceId, taskId, status: "completed" }),
    ),
  ];
}

function sessionFormat(sessionId: string) {
  return {
    record_type: "session_format",
    protocol_version: 3,
    format: "penguin.trace.session",
    format_version: 1,
    timestamp: "2026-07-20T09:59:57.000Z",
    session_id: sessionId,
  };
}

function traceEventLink(sessionId: string, message: OmniMessage) {
  const traceId = message.trace?.trace_id;
  if (traceId === undefined || message.event_id === undefined) {
    throw new Error("Protocol-v3 history fixtures require trace_id and event_id");
  }
  return {
    record_type: "trace_event_link",
    protocol_version: 3,
    timestamp: message.timestamp,
    session_id: sessionId,
    trace_id: traceId,
    event_id: message.event_id,
  };
}

const textOf = (m: OmniMessage): string | undefined => (m.payload as { text?: string }).text;
const userTexts = (ms: OmniMessage[]): string[] =>
  ms
    .filter(
      (m) =>
        m.type === "model_msg" &&
        (m.payload as { type?: string; role?: string }).type === "text" &&
        (m.payload as { role?: string }).role === "user",
    )
    .map((m) => textOf(m)!);

describe("messages windowed reads", () => {
  let root: string;
  let service: TraceService;
  let harness: ReturnType<typeof makeTraceHarness>;

  beforeEach(async () => {
    root = await makeTempRoot();
    harness = makeTraceHarness(root);
    service = harness.service;
  });
  afterEach(async () => {
    harness.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("tail mid-shard: newest N units, before cursor round-trips to the previous window, beginning ends the chain", async () => {
    await writeTraceFile(root, P, A, "2026-07-20", S, 1, [
      sessionMeta(metaPayload()),
      ...turn(0, 1, 1000),
      ...turn(1, 2, 2000),
      ...turn(2, 3, 3000),
      ...turn(3, 4, 4000),
    ]);

    const tail = await service.readMessagesPage(P, A, S, { kind: "tail", limit: 2 });
    expect(userTexts(tail.messages)).toEqual(["q3", "q4"]);
    expect(tail.messages.some((m) => m.type === "session_meta")).toBe(false);
    expect(tail.before).toBeDefined();
    expect(tail.prior.turns).toBe(2);
    // The cursor names the window's first unit: shard 1, ordinal of q3 (meta + 2×5 turns).
    expect(decodeCursor(tail.before!)).toEqual({ fileIndex: 1, ordinal: 11 });

    const mid = await service.readMessagesPage(P, A, S, {
      kind: "before",
      cursor: decodeCursor(tail.before!)!,
      limit: 1,
    });
    expect(userTexts(mid.messages)).toEqual(["q2"]);
    expect(mid.prior.turns).toBe(1);
    expect(mid.before).toBeDefined();

    // The oldest window absorbs the preamble (session_meta) and carries no cursor.
    const first = await service.readMessagesPage(P, A, S, {
      kind: "before",
      cursor: decodeCursor(mid.before!)!,
      limit: 5,
    });
    expect(userTexts(first.messages)).toEqual(["q1"]);
    expect(first.messages[0]!.type).toBe("session_meta");
    expect(first.before).toBeUndefined();
    expect(first.prior).toEqual({
      turns: 0,
      subagentTokens: 0,
      elapsedMs: 0,
      sessionTokens: 0,
      contextTokens: 0,
    });

    // Windows tile the transcript exactly: concatenated they equal the full read.
    const full = await service.readMessages(P, A, S);
    expect([...first.messages, ...mid.messages, ...tail.messages]).toEqual(full);
  });

  it("v3 full/tail/before follow exact Session-journal order across facts and roots", async () => {
    const roots = [1, 2, 3].map((n) => ({
      traceId: `trace-v3-aabb000${n}`,
      taskId: `task-v3-aabb000${n}`,
    }));
    const rootEvents = roots.map((linked, index) =>
      v3Turn(linked.traceId, linked.taskId, index, index + 1, (index + 1) * 1000),
    );
    const metaFact = {
      record_type: "session_fact",
      protocol_version: 3,
      timestamp: "2026-07-20T09:59:58.000Z",
      message: at("2026-07-20T09:59:58.000Z", sessionMeta(metaPayload())),
    };
    const toolFact = {
      record_type: "session_fact",
      protocol_version: 3,
      timestamp: "2026-07-20T10:00:00.500Z",
      message: at("2026-07-20T10:00:00.500Z", toolListReady([])),
    };
    const traceLink = (index: number) => ({
      record_type: "trace_link",
      protocol_version: 3,
      timestamp: rootEvents[index]![0]!.timestamp,
      session_id: S,
      trace_id: roots[index]!.traceId,
      root_kind: "task",
      task_id: roots[index]!.taskId,
    });
    const journal = [
      sessionFormat(S),
      metaFact,
      traceLink(0),
      traceEventLink(S, rootEvents[0]![0]!),
      traceEventLink(S, rootEvents[0]![1]!),
      toolFact,
      ...rootEvents[0]!.slice(2).map((message) => traceEventLink(S, message)),
      { record_type: "future_record", protocol_version: 3 },
      traceLink(1),
      ...rootEvents[1]!.map((message) => traceEventLink(S, message)),
      traceLink(2),
      ...rootEvents[2]!.map((message) => traceEventLink(S, message)),
    ];
    await writeLogicalTraceJournal(root, P, A, S, journal);
    for (let index = 0; index < roots.length; index += 1) {
      await writeLogicalTraceEvents(root, P, A, S, roots[index]!.traceId, rootEvents[index]!);
    }

    const fullResult = await service.readMessagesResult(P, A, S);
    const full = fullResult.messages;
    expect(fullResult.history).toEqual({
      protocolVersion: 3,
      partial: false,
      diagnostics: [],
    });
    expect(full[0]!.type).toBe("session_meta");
    const q1Index = full.findIndex((message) => textOf(message) === "q1");
    const toolIndex = full.findIndex(
      (message) => (message.payload as { type?: string }).type === "tool_list_ready",
    );
    const q2Index = full.findIndex((message) => textOf(message) === "q2");
    expect(q1Index).toBeGreaterThan(0);
    expect(toolIndex).toBeGreaterThan(q1Index);
    expect(toolIndex).toBeLessThan(q2Index);
    expect(userTexts(full)).toEqual(["q1", "q2", "q3"]);

    const eventOrdinal = (message: OmniMessage): number =>
      journal.findIndex(
        (record) =>
          (record as { record_type?: string; event_id?: string }).record_type ===
            "trace_event_link" && (record as { event_id?: string }).event_id === message.event_id,
      ) + 1;
    const q2 = rootEvents[1]!.find((message) => textOf(message) === "q2")!;
    const q3 = rootEvents[2]!.find((message) => textOf(message) === "q3")!;

    const tail = await service.readMessagesPage(P, A, S, { kind: "tail", limit: 1 });
    expect(userTexts(tail.messages)).toEqual(["q3"]);
    expect(tail.prior.turns).toBe(2);
    expect(tail.history?.partial).toBe(false);
    expect(decodeCursor(tail.before!)).toEqual({
      fileIndex: eventOrdinal(q3),
      ordinal: 0,
    });

    const middle = await service.readMessagesPage(P, A, S, {
      kind: "before",
      cursor: decodeCursor(tail.before!)!,
      limit: 1,
    });
    expect(userTexts(middle.messages)).toEqual(["q2"]);
    expect(middle.prior.turns).toBe(1);
    expect(decodeCursor(middle.before!)).toEqual({
      fileIndex: eventOrdinal(q2),
      ordinal: 0,
    });

    const first = await service.readMessagesPage(P, A, S, {
      kind: "before",
      cursor: decodeCursor(middle.before!)!,
      limit: 10,
    });
    expect(first.messages[0]!.type).toBe("session_meta");
    expect(
      first.messages.some(
        (message) => (message.payload as { type?: string }).type === "tool_list_ready",
      ),
    ).toBe(true);
    expect(userTexts(first.messages)).toEqual(["q1"]);
    expect(first.before).toBeUndefined();
    expect([...first.messages, ...middle.messages, ...tail.messages]).toEqual(full);
  });

  it("v3 child history expands once for session-only plus refined pointers in full and paged reads", async () => {
    const parentTrace1 = "trace-v3-parent-aabb0001";
    const parentTask1 = "task-v3-parent-aabb0001";
    const parentTrace2 = "trace-v3-parent-aabb0002";
    const parentTask2 = "task-v3-parent-aabb0002";
    const childTrace = "trace-v3-child-ccdd0002";
    const childTask = "task-v3-child-ccdd0002";
    const sessionFact = (sessionId: string) => ({
      record_type: "session_fact",
      protocol_version: 3,
      timestamp: "2026-07-20T09:59:58.000Z",
      message: at("2026-07-20T09:59:58.000Z", sessionMeta(metaPayload({ session_id: sessionId }))),
    });
    const traceLink = (sessionId: string, traceId: string, taskId: string) => ({
      record_type: "trace_link",
      protocol_version: 3,
      timestamp: "2026-07-20T10:00:00.000Z",
      session_id: sessionId,
      trace_id: traceId,
      root_kind: "task",
      task_id: taskId,
    });
    const parentContext = { trace_id: parentTrace1, task_id: parentTask1 };
    const invocationContext = {
      ...parentContext,
      span_id: "span-v3-child-invoke-ccdd0002",
    };
    const parentEvents1 = [
      at(
        "2026-07-20T10:00:00.000Z",
        traceBegin({ rootKind: "task", traceId: parentTrace1, taskId: parentTask1 }),
      ),
      withTraceContext(at("2026-07-20T10:00:00.100Z", userText("q1")), parentContext),
      withTraceContext(at("2026-07-20T10:00:01.000Z", requestBegin()), parentContext),
      withTraceContext(at("2026-07-20T10:00:02.000Z", subagentEvent(CHILD)), invocationContext),
      withTraceContext(
        at(
          "2026-07-20T10:00:02.100Z",
          subagentEvent(CHILD, { traceId: childTrace, taskId: childTask }),
        ),
        invocationContext,
      ),
      withTraceContext(at("2026-07-20T10:00:03.000Z", assistantText("a1")), parentContext),
      withTraceContext(at("2026-07-20T10:00:04.000Z", requestEnd("completed")), parentContext),
      withTraceContext(
        at("2026-07-20T10:00:04.500Z", tokenUsage(counts(1000), counts(100))),
        parentContext,
      ),
      at(
        "2026-07-20T10:00:05.000Z",
        traceEnd({
          rootKind: "task",
          traceId: parentTrace1,
          taskId: parentTask1,
          status: "completed",
        }),
      ),
    ];
    const parentEvents2 = v3Turn(parentTrace2, parentTask2, 1, 2, 2000);
    const childEvents = [
      at(
        "2026-07-20T10:00:02.200Z",
        traceBegin({ rootKind: "task", traceId: childTrace, taskId: childTask }),
      ),
      withTraceContext(at("2026-07-20T10:00:02.300Z", assistantText("child v3 says")), {
        trace_id: childTrace,
        task_id: childTask,
      }),
      withTraceContext(at("2026-07-20T10:00:02.400Z", tokenUsage(counts(400), counts(400))), {
        trace_id: childTrace,
        task_id: childTask,
      }),
      at(
        "2026-07-20T10:00:02.500Z",
        traceEnd({
          rootKind: "task",
          traceId: childTrace,
          taskId: childTask,
          status: "completed",
        }),
      ),
    ];
    await writeLogicalTraceJournal(root, P, A, S, [
      sessionFormat(S),
      sessionFact(S),
      traceLink(S, parentTrace1, parentTask1),
      ...parentEvents1.map((message) => traceEventLink(S, message)),
      traceLink(S, parentTrace2, parentTask2),
      ...parentEvents2.map((message) => traceEventLink(S, message)),
    ]);
    await writeLogicalTraceJournal(root, P, A, CHILD, [
      sessionFormat(CHILD),
      sessionFact(CHILD),
      traceLink(CHILD, childTrace, childTask),
      ...childEvents.map((message) => traceEventLink(CHILD, message)),
    ]);
    await writeLogicalTraceEvents(root, P, A, S, parentTrace1, parentEvents1);
    await writeLogicalTraceEvents(root, P, A, S, parentTrace2, parentEvents2);
    await writeLogicalTraceEvents(root, P, A, CHILD, childTrace, childEvents);

    const fullResult = await service.readMessagesResult(P, A, S);
    const full = fullResult.messages;
    expect(fullResult.history?.partial).toBe(false);
    expect(full.filter((message) => textOf(message) === "child v3 says")).toHaveLength(1);
    expect(
      full.filter((message) => message.type === "session_meta" && message.origin?.[0] === CHILD),
    ).toHaveLength(1);
    expect(full.some((message) => (message.payload as { type?: string }).type === "subagent")).toBe(
      false,
    );

    const tail = await service.readMessagesPage(P, A, S, { kind: "tail", limit: 1 });
    expect(userTexts(tail.messages)).toEqual(["q2"]);
    expect(tail.messages.some((message) => textOf(message) === "child v3 says")).toBe(false);
    expect(tail.prior.subagentTokens).toBe(400);

    const older = await service.readMessagesPage(P, A, S, {
      kind: "before",
      cursor: decodeCursor(tail.before!)!,
      limit: 10,
    });
    expect(older.messages.filter((message) => textOf(message) === "child v3 says")).toHaveLength(1);
    expect([...older.messages, ...tail.messages]).toEqual(full);
  });

  it("rejects pre-marker v3 history instead of guessing cross-file order", async () => {
    const traceId = "trace-v3-legacy-aabb0001";
    const taskId = "task-v3-legacy-aabb0001";
    const events = v3Turn(traceId, taskId, 0, 1, 1000);
    await writeLogicalTraceJournal(root, P, A, S, [
      {
        record_type: "session_fact",
        protocol_version: 3,
        timestamp: "2026-07-20T09:59:58.000Z",
        message: at("2026-07-20T09:59:58.000Z", sessionMeta(metaPayload())),
      },
      {
        record_type: "trace_link",
        protocol_version: 3,
        timestamp: events[0]!.timestamp,
        session_id: S,
        trace_id: traceId,
        root_kind: "task",
        task_id: taskId,
      },
    ]);
    await writeLogicalTraceEvents(root, P, A, S, traceId, events);

    await expect(service.readMessagesResult(P, A, S)).rejects.toMatchObject({
      status: 409,
      code: "trace_history_unsupported",
    });
    await expect(
      service.readMessagesPage(P, A, S, { kind: "tail", limit: 1 }),
    ).rejects.toMatchObject({ status: 409, code: "trace_history_unsupported" });
    await expect(service.readRoots(P, A, S)).rejects.toMatchObject({
      status: 409,
      code: "trace_history_unsupported",
    });
    await expect(service.readRoot(P, A, S, traceId)).rejects.toMatchObject({
      status: 409,
      code: "trace_history_unsupported",
    });
  });

  it("keeps marker-backed history readable while diagnosing link holes and conflicts", async () => {
    const traceId = "trace-v3-partial-aabb0001";
    const taskId = "task-v3-partial-aabb0001";
    const good = at("2026-07-20T10:00:00.000Z", traceBegin({ rootKind: "task", traceId, taskId }));
    const mismatched = withTraceContext(at("2026-07-20T10:00:01.000Z", userText("wrong Trace")), {
      trace_id: "trace-v3-other-aabb0002",
      task_id: taskId,
    });
    const unlinked = withTraceContext(at("2026-07-20T10:00:02.000Z", assistantText("unlinked")), {
      trace_id: traceId,
      task_id: taskId,
    });
    const goodLink = traceEventLink(S, good);
    await writeLogicalTraceJournal(root, P, A, S, [
      sessionFormat(S),
      {
        record_type: "session_fact",
        protocol_version: 3,
        timestamp: "2026-07-20T09:59:58.000Z",
        message: at("2026-07-20T09:59:58.000Z", sessionMeta(metaPayload())),
      },
      {
        record_type: "trace_link",
        protocol_version: 3,
        timestamp: good.timestamp,
        session_id: S,
        trace_id: traceId,
        root_kind: "task",
        task_id: taskId,
      },
      goodLink,
      goodLink,
      {
        record_type: "trace_event_link",
        protocol_version: 3,
        timestamp: mismatched.timestamp,
        session_id: S,
        trace_id: traceId,
        event_id: mismatched.event_id,
      },
      {
        record_type: "trace_event_link",
        protocol_version: 3,
        timestamp: "2026-07-20T10:00:03.000Z",
        session_id: S,
        trace_id: traceId,
        event_id: "event-v3-missing-aabb0003",
      },
    ]);
    await writeLogicalTraceEvents(root, P, A, S, traceId, [good, mismatched, unlinked]);

    const full = await service.readMessagesResult(P, A, S);
    expect(full.messages.map((message) => message.type)).toEqual(["session_meta", "event_msg"]);
    expect(full.history?.partial).toBe(true);
    expect(full.history?.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "duplicate_trace_event_link",
      "trace_event_mismatch",
      "dangling_trace_event_link",
      "unlinked_trace_event",
    ]);

    const page = await service.readMessagesPage(P, A, S, { kind: "tail", limit: 1 });
    expect(page.messages).toEqual(full.messages);
    expect(page.history).toEqual(full.history);
  });

  it("preserves physical journal cursors and root order across a malformed middle line", async () => {
    const traceId = "trace-v3-malformed-aabb0001";
    const taskId = "task-v3-malformed-aabb0001";
    const context = { trace_id: traceId, task_id: taskId };
    const firstTurn = turn(9, 1, 1000).map((message) => withTraceContext(message, context));
    const secondTurn = turn(1, 2, 2000).map((message) => withTraceContext(message, context));
    const journalPath = await writeLogicalTraceJournal(root, P, A, S, [
      sessionFormat(S),
      {
        record_type: "session_fact",
        protocol_version: 3,
        timestamp: "2026-07-20T09:59:58.000Z",
        message: at("2026-07-20T09:59:58.000Z", sessionMeta(metaPayload())),
      },
      {
        record_type: "trace_link",
        protocol_version: 3,
        timestamp: firstTurn[0]!.timestamp,
        session_id: S,
        trace_id: traceId,
        root_kind: "task",
        task_id: taskId,
      },
      ...firstTurn.map((message) => traceEventLink(S, message)),
      ...secondTurn.map((message) => traceEventLink(S, message)),
    ]);
    const lines = (await fs.readFile(journalPath, "utf8")).trimEnd().split("\n");
    lines.splice(8, 0, '{"record_type":"trace_event_link"');
    await fs.writeFile(journalPath, `${lines.join("\n")}\n`, "utf8");
    // Payload-file order and timestamps both disagree with the journal links.
    await writeLogicalTraceEvents(root, P, A, S, traceId, [...secondTurn, ...firstTurn]);

    const full = await service.readMessagesResult(P, A, S);
    expect(userTexts(full.messages)).toEqual(["q1", "q2"]);
    expect(full.history?.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "malformed_session_journal",
    ]);

    const tail = await service.readMessagesPage(P, A, S, { kind: "tail", limit: 1 });
    expect(userTexts(tail.messages)).toEqual(["q2"]);
    expect(decodeCursor(tail.before!)).toEqual({ fileIndex: 10, ordinal: 0 });
    const older = await service.readMessagesPage(P, A, S, {
      kind: "before",
      cursor: decodeCursor(tail.before!)!,
      limit: 1,
    });
    expect(userTexts(older.messages)).toEqual(["q1"]);
    expect(older.messages[0]!.type).toBe("session_meta");
    expect([...older.messages, ...tail.messages]).toEqual(full.messages);

    const detail = await service.readRoot(P, A, S, traceId);
    expect(detail.records.map((record) => record.event_id)).toEqual(
      [...firstTurn, ...secondTurn].map((record) => record.event_id),
    );
    expect(detail.root.partial).toBe(true);
    expect(detail.diagnostics?.map((diagnostic) => diagnostic.code)).toEqual([
      "malformed_session_journal",
    ]);
  });

  it("windows span shard boundaries; a mid-Task rotation stays glued to its Task's window", async () => {
    // Shard 1: turn 1, then turn 2 begins and rotates mid-Task (auto compaction with
    // carry-over): the continuation lives in shard 2 with no new user prompt.
    await writeTraceFile(root, P, A, "2026-07-20", S, 1, [
      sessionMeta(metaPayload()),
      ...turn(0, 1, 1000),
      at("2026-07-20T10:01:00.000Z", userText("q2")),
      at("2026-07-20T10:01:01.000Z", requestBegin()),
      at("2026-07-20T10:01:02.000Z", requestEnd("completed")),
      at("2026-07-20T10:01:02.100Z", tokenUsage(counts(2000), counts(900))),
      at(
        "2026-07-20T10:01:03.000Z",
        compactionBegin({ reason: "context", mode: "summarize", context: 900, turns: 2 }),
      ),
      at("2026-07-20T10:01:04.000Z", requestBegin()),
      at("2026-07-20T10:01:05.000Z", assistantText("[summary]s[/summary]")),
      at("2026-07-20T10:01:06.000Z", requestEnd("completed")),
      at(
        "2026-07-20T10:01:07.000Z",
        compactionEnd({ reason: "context", mode: "summarize", status: "completed" }),
      ),
    ]);
    await writeTraceFile(root, P, A, "2026-07-20", S, 2, [
      sessionMeta(metaPayload()),
      at("2026-07-20T10:01:08.000Z", userText("[context_summary]\ns\n[/context_summary]")),
      at("2026-07-20T10:01:09.000Z", requestBegin()),
      at("2026-07-20T10:01:10.000Z", assistantText("a2")),
      at("2026-07-20T10:01:11.000Z", requestEnd("completed")),
      at("2026-07-20T10:01:11.500Z", tokenUsage(counts(2500), counts(300))),
      ...turn(2, 3, 3000),
    ]);

    // Tail of 2 units = turn 2 (which spans BOTH shards, compaction included) + turn 3.
    const tail = await service.readMessagesPage(P, A, S, { kind: "tail", limit: 2 });
    expect(userTexts(tail.messages)[0]).toBe("q2");
    expect(userTexts(tail.messages)).toContain("q3");
    expect(
      tail.messages.some((m) => (m.payload as { type?: string }).type === "compaction_begin"),
    ).toBe(true);
    // The rotated shard's rewritten session_meta and summary injection ride along inside the window.
    expect(tail.messages.filter((m) => m.type === "session_meta")).toHaveLength(1);
    expect(decodeCursor(tail.before!)).toEqual({ fileIndex: 1, ordinal: 6 });
    expect(tail.prior.turns).toBe(1);

    const older = await service.readMessagesPage(P, A, S, {
      kind: "before",
      cursor: decodeCursor(tail.before!)!,
      limit: 10,
    });
    expect(userTexts(older.messages)).toEqual(["q1"]);
    expect(older.before).toBeUndefined();
    const full = await service.readMessages(P, A, S);
    expect([...older.messages, ...tail.messages]).toEqual(full);
  });

  it("a compaction the user quit out of keeps the conversation after it visible (issue #288)", async () => {
    // The process died mid-compaction, leaving compaction_begin with no end; core's resume
    // closes the span as `failed` before the session continues the shard. The scanner must
    // treat everything after the closure as ordinary conversation again — before the fix,
    // the unclosed begin kept `compactionActive` set for the rest of the shard and every
    // later prompt vanished from the window (no boundary, no unit, no messages).
    await writeTraceFile(root, P, A, "2026-07-20", S, 1, [
      sessionMeta(metaPayload()),
      ...turn(0, 1, 1000),
      at(
        "2026-07-20T10:01:00.000Z",
        compactionBegin({ reason: "context", mode: "summarize", context: 900, turns: 1 }),
      ),
      at("2026-07-20T10:01:01.000Z", userText("COMPACT NOW")),
      at("2026-07-20T10:01:02.000Z", requestBegin()),
      // ...process died; the resume closed the span before writing anything else:
      at(
        "2026-07-20T10:01:30.000Z",
        compactionEnd({ reason: "context", mode: "summarize", status: "failed" }),
      ),
      ...turn(2, 2, 2000),
    ]);

    const tail = await service.readMessagesPage(P, A, S, { kind: "tail", limit: 1 });
    // The post-crash prompt is a unit of its own and stays visible.
    expect(userTexts(tail.messages)).toEqual(["q2"]);
    expect(tail.prior.turns).toBe(1);

    // The windows still tile the transcript exactly.
    const older = await service.readMessagesPage(P, A, S, {
      kind: "before",
      cursor: decodeCursor(tail.before!)!,
      limit: 10,
    });
    const full = await service.readMessages(P, A, S);
    expect([...older.messages, ...tail.messages]).toEqual(full);
  });

  it("a mid-task compaction the user interrupted keeps its own turn's messages in the window", async () => {
    // The user hit stop during a mid-task compaction: the engine closes the pair and ends
    // the run with an abort, all inside the turn that q1 opened. The abort does not cut a
    // window of its own, and the interrupted compaction stays attached to its turn.
    await writeTraceFile(root, P, A, "2026-07-20", S, 1, [
      sessionMeta(metaPayload()),
      ...turn(0, 1, 1000),
      at(
        "2026-07-20T10:01:00.000Z",
        compactionBegin({ reason: "context", mode: "summarize", context: 900, turns: 1 }),
      ),
      at("2026-07-20T10:01:01.000Z", userText("COMPACT NOW")),
      at(
        "2026-07-20T10:01:02.000Z",
        compactionEnd({ reason: "context", mode: "summarize", status: "aborted" }),
      ),
      at("2026-07-20T10:01:03.000Z", abortEvent("aborted during compaction")),
      ...turn(2, 2, 2000),
    ]);

    const tail = await service.readMessagesPage(P, A, S, { kind: "tail", limit: 1 });
    expect(userTexts(tail.messages)).toEqual(["q2"]);
    const older = await service.readMessagesPage(P, A, S, {
      kind: "before",
      cursor: decodeCursor(tail.before!)!,
      limit: 10,
    });
    const full = await service.readMessages(P, A, S);
    expect([...older.messages, ...tail.messages]).toEqual(full);
  });

  it("cuts are pairing-safe: a tool_call and its output never split, steering images stay with their chip", async () => {
    await writeTraceFile(root, P, A, "2026-07-20", S, 1, [
      sessionMeta(metaPayload()),
      ...turn(0, 1, 1000),
      // Turn 2: tool call whose output lands after request_end, steering + image mid-run.
      at("2026-07-20T10:01:00.000Z", userText("q2")),
      at("2026-07-20T10:01:01.000Z", requestBegin()),
      at("2026-07-20T10:01:02.000Z", toolCall({ name: "exec", arguments: "{}", toolCallId: "t1" })),
      at("2026-07-20T10:01:03.000Z", requestEnd("completed")),
      at("2026-07-20T10:01:04.000Z", toolCallOutput({ output: "out", toolCallId: "t1" })),
      at("2026-07-20T10:01:05.000Z", userText("[user_steering]\nfaster\n[/user_steering]")),
      at("2026-07-20T10:01:05.100Z", imageUrlMessage("data:image/png;base64,AAAA")),
      at("2026-07-20T10:01:06.000Z", requestBegin()),
      at("2026-07-20T10:01:07.000Z", assistantText("a2")),
      at("2026-07-20T10:01:08.000Z", requestEnd("completed")),
      at("2026-07-20T10:01:08.500Z", tokenUsage(counts(2000), counts(200))),
    ]);

    // limit 1 must take the WHOLE second turn: the cut lands at q2, never at the
    // steering text, its image, or between t1's call and output.
    const tail = await service.readMessagesPage(P, A, S, { kind: "tail", limit: 1 });
    expect(userTexts(tail.messages)[0]).toBe("q2");
    const kinds = tail.messages.map((m) => (m.payload as { type?: string }).type);
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("tool_call_output");
    expect(kinds).toContain("image_url");
    // Steering opened no new unit: the previous window holds exactly turn 1.
    const older = await service.readMessagesPage(P, A, S, {
      kind: "before",
      cursor: decodeCursor(tail.before!)!,
      limit: 10,
    });
    expect(userTexts(older.messages)).toEqual(["q1"]);
  });

  it("a text+images send is one unit and one outline turn; banner and goal-round prompts cut but never count", async () => {
    await writeTraceFile(root, P, A, "2026-07-20", S, 1, [
      sessionMeta(metaPayload()),
      // Send 1: text + two images (one entry, one unit).
      at("2026-07-20T10:00:00.000Z", userText("look")),
      at("2026-07-20T10:00:00.100Z", imageUrlMessage("data:image/png;base64,AAAA")),
      at("2026-07-20T10:00:00.200Z", imageUrlMessage("data:image/png;base64,BBBB")),
      at("2026-07-20T10:00:01.000Z", requestBegin()),
      at("2026-07-20T10:00:02.000Z", assistantText("a1")),
      at("2026-07-20T10:00:03.000Z", requestEnd("completed")),
      at("2026-07-20T10:00:03.500Z", tokenUsage(counts(1000), counts(100))),
      // A handoff banner send: machine-only, no outline entry (buildOutline returns null body).
      at(
        "2026-07-20T10:01:00.000Z",
        userText(buildHandoffMessage({ agentId: "worker", workspace: "/tmp/w" })),
      ),
      at("2026-07-20T10:01:01.000Z", requestBegin()),
      at("2026-07-20T10:01:02.000Z", assistantText("a2")),
      at("2026-07-20T10:01:03.000Z", requestEnd("completed")),
      at("2026-07-20T10:01:03.500Z", tokenUsage(counts(2000), counts(200))),
      // A goal round-2 re-send: starts a Task but opens no outline entry.
      at("2026-07-20T10:02:00.000Z", userText("[goal]\nround: 2\nbudget: unlimited\n[/goal]\ngo")),
      at("2026-07-20T10:02:01.000Z", requestBegin()),
      at("2026-07-20T10:02:02.000Z", assistantText("a3")),
      at("2026-07-20T10:02:03.000Z", requestEnd("completed")),
      at("2026-07-20T10:02:03.500Z", tokenUsage(counts(3000), counts(300))),
      ...turn(3, 4, 4000),
    ]);

    // Four units in total (each send cuts), but only ONE outline entry precedes q4:
    // the text+images send counts once, the banner and the goal round count zero —
    // exactly buildOutline's rule, so q4 renders as global turn 2 with offset 1.
    const tail = await service.readMessagesPage(P, A, S, { kind: "tail", limit: 1 });
    expect(userTexts(tail.messages)).toEqual(["q4"]);
    expect(tail.prior.turns).toBe(1);

    // Walk one more window back: the goal-round unit alone; still 1 entry before it.
    const goalWin = await service.readMessagesPage(P, A, S, {
      kind: "before",
      cursor: decodeCursor(tail.before!)!,
      limit: 1,
    });
    expect(userTexts(goalWin.messages)[0]).toContain("[goal]");
    expect(goalWin.prior.turns).toBe(1);

    const bannerWin = await service.readMessagesPage(P, A, S, {
      kind: "before",
      cursor: decodeCursor(goalWin.before!)!,
      limit: 1,
    });
    expect(bannerWin.prior.turns).toBe(1); // only the image send precedes the banner
    const firstWin = await service.readMessagesPage(P, A, S, {
      kind: "before",
      cursor: decodeCursor(bannerWin.before!)!,
      limit: 1,
    });
    expect(firstWin.prior.turns).toBe(0);
    expect(firstWin.before).toBeUndefined();
    // The text and its two images stayed one unit.
    expect(userTexts(firstWin.messages)).toEqual(["look"]);
    expect(
      firstWin.messages.filter((m) => (m.payload as { type?: string }).type === "image_url"),
    ).toHaveLength(2);
  });

  it("prior stats: finished-Task elapsed, session/context token readings", async () => {
    await writeTraceFile(root, P, A, "2026-07-20", S, 1, [
      sessionMeta(metaPayload()),
      ...turn(0, 1, 1000), // request_begin 10:00:01 → request_end 10:00:03 = 2s... elapsed = lastReqEnd - firstMsg(q1 at 10:00:00) = 3s
      ...turn(1, 2, 2000),
      ...turn(2, 3, 3000),
    ]);
    const tail = await service.readMessagesPage(P, A, S, { kind: "tail", limit: 1 });
    // Web semantics: a turn's elapsed = last request_end − its first message = 3s each.
    expect(tail.prior.elapsedMs).toBe(2 * 3000);
    expect(tail.prior.sessionTokens).toBe(2000); // last session.total before the window
    expect(tail.prior.contextTokens).toBe(102); // last request.total before the window (turn(…, 2) writes 100+2)
    expect(tail.prior.subagentTokens).toBe(0);
  });

  it("subagent pointers expand only inside the window; earlier children feed prior.subagentTokens without appearing", async () => {
    const child2 = "session-2026-07-20-10-02-00-eeff0003";
    await writeTraceFile(root, P, A, "2026-07-20", S, 1, [
      sessionMeta(metaPayload()),
      // Turn 1 spawns CHILD.
      at("2026-07-20T10:00:00.000Z", userText("q1")),
      at("2026-07-20T10:00:01.000Z", requestBegin()),
      at(
        "2026-07-20T10:00:02.000Z",
        toolCall({ name: "run_subagent", arguments: "{}", toolCallId: "c1" }),
      ),
      at("2026-07-20T10:00:03.000Z", subagentEvent(CHILD)),
      at("2026-07-20T10:00:04.000Z", requestEnd("completed")),
      at("2026-07-20T10:00:05.000Z", toolCallOutput({ output: "done", toolCallId: "c1" })),
      at("2026-07-20T10:00:06.000Z", tokenUsage(counts(1000), counts(100))),
      // Turn 2 spawns child2.
      at("2026-07-20T10:01:00.000Z", userText("q2")),
      at("2026-07-20T10:01:01.000Z", requestBegin()),
      at(
        "2026-07-20T10:01:02.000Z",
        toolCall({ name: "run_subagent", arguments: "{}", toolCallId: "c2" }),
      ),
      at("2026-07-20T10:01:03.000Z", subagentEvent(child2)),
      at("2026-07-20T10:01:04.000Z", requestEnd("completed")),
      at("2026-07-20T10:01:05.000Z", toolCallOutput({ output: "done", toolCallId: "c2" })),
      at("2026-07-20T10:01:06.000Z", tokenUsage(counts(2000), counts(120))),
    ]);
    await writeTraceFile(root, P, A, "2026-07-20", CHILD, 1, [
      sessionMeta(metaPayload({ session_id: CHILD })),
      at("2026-07-20T10:00:03.500Z", assistantText("child says")),
      at("2026-07-20T10:00:03.800Z", tokenUsage(counts(400), counts(400))),
    ]);
    await writeTraceFile(root, P, A, "2026-07-20", child2, 1, [
      sessionMeta(metaPayload({ session_id: child2 })),
      at("2026-07-20T10:01:03.500Z", assistantText("child2 says")),
      at("2026-07-20T10:01:03.800Z", tokenUsage(counts(70), counts(70))),
    ]);

    const tail = await service.readMessagesPage(P, A, S, { kind: "tail", limit: 1 });
    // The window (turn 2) expands child2 in place, origin-tagged, pointer replaced.
    const origins = tail.messages.filter((m) => m.origin !== undefined);
    expect(origins.length).toBeGreaterThan(0);
    for (const m of origins) expect(m.origin).toEqual([child2]);
    expect(tail.messages.some((m) => (m.payload as { type?: string }).type === "subagent")).toBe(
      false,
    );
    // CHILD (turn 1) is NOT in the window — its usage rides prior.subagentTokens instead.
    expect(tail.messages.some((m) => textOf(m) === "child says")).toBe(false);
    expect(tail.prior.subagentTokens).toBe(400);

    // The older window then expands CHILD with the exact shape the full path produces.
    const older = await service.readMessagesPage(P, A, S, {
      kind: "before",
      cursor: decodeCursor(tail.before!)!,
      limit: 10,
    });
    const full = await service.readMessages(P, A, S);
    expect([...older.messages, ...tail.messages]).toEqual(full);
  });

  it("shard-read discipline: after priming, old-window requests never read the newest shard and tail requests never read old shards", async () => {
    await writeTraceFile(root, P, A, "2026-07-20", S, 1, [
      sessionMeta(metaPayload()),
      ...turn(0, 1, 1000),
      ...turn(1, 2, 2000),
    ]);
    await writeTraceFile(root, P, A, "2026-07-21", S, 2, [
      sessionMeta(metaPayload()),
      ...turn(2, 3, 3000),
    ]);
    await writeTraceFile(root, P, A, "2026-07-21", S, 3, [
      sessionMeta(metaPayload()),
      ...turn(3, 4, 4000),
      ...turn(4, 5, 5000),
    ]);

    // Priming: the first windowed read backfills the per-shard prefix cache (reads old shards once).
    const primed = await service.readMessagesPage(P, A, S, { kind: "tail", limit: 1 });
    expect(userTexts(primed.messages)).toEqual(["q5"]);

    // A tail request now touches ONLY the newest shard.
    harness.shardReads.length = 0;
    await service.readMessagesPage(P, A, S, { kind: "tail", limit: 1 });
    expect(harness.shardReads).toHaveLength(1);
    expect(harness.shardReads[0]).toContain(`${S}_003.jsonl`);

    // An old-window request touches ONLY its own shard — never the newest one.
    harness.shardReads.length = 0;
    const older = await service.readMessagesPage(P, A, S, {
      kind: "before",
      cursor: { fileIndex: 2, ordinal: 1 },
      limit: 1,
    });
    expect(userTexts(older.messages)).toEqual(["q2"]);
    expect(harness.shardReads.every((p) => !p.includes(`${S}_003.jsonl`))).toBe(true);
    expect(harness.shardReads.some((p) => p.includes(`${S}_001.jsonl`))).toBe(true);
  });

  it("cursor edge cases: unknown shard yields an empty end-of-history page; empty sessions page cleanly", async () => {
    expect(await service.readMessagesPage(P, A, S, { kind: "tail", limit: 5 })).toEqual({
      messages: [],
      prior: { turns: 0, subagentTokens: 0, elapsedMs: 0, sessionTokens: 0, contextTokens: 0 },
    });
    await writeTraceFile(root, P, A, "2026-07-20", S, 1, [
      sessionMeta(metaPayload()),
      ...turn(0, 1, 1000),
    ]);
    const gone = await service.readMessagesPage(P, A, S, {
      kind: "before",
      cursor: { fileIndex: 9, ordinal: 4 },
      limit: 5,
    });
    expect(gone.messages).toEqual([]);
    expect(gone.before).toBeUndefined();
    // Round-trip of the cursor encoding itself.
    expect(decodeCursor(encodeCursor({ fileIndex: 12, ordinal: 345 }))).toEqual({
      fileIndex: 12,
      ordinal: 345,
    });
    expect(decodeCursor("12:")).toBeNull();
    expect(decodeCursor("a:b")).toBeNull();
  });

  it("tail covering the whole transcript returns everything with no cursor and equals the full read", async () => {
    await writeTraceFile(root, P, A, "2026-07-20", S, 1, [
      sessionMeta(metaPayload()),
      ...turn(0, 1, 1000),
      ...turn(1, 2, 2000),
    ]);
    const tail = await service.readMessagesPage(P, A, S, { kind: "tail", limit: 50 });
    expect(tail.before).toBeUndefined();
    expect(tail.prior.turns).toBe(0);
    expect(tail.messages).toEqual(await service.readMessages(P, A, S));
  });
});
