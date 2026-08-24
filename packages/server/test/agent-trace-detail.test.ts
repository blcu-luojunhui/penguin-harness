/**
 * Agent-level Trace detail endpoint integration tests (FD-3):
 * The Trace page directory tree comes from an Agent-level scan (including unmanaged
 * subagent child Sessions / Sessions created by the CLI), but the Session-level detail
 * endpoint looks up the sessions table, so unmanaged ones return 404 directly. The new
 * Agent-level detail endpoint locates the Trace file directly by
 * (projectId, agentId, sessionId), with access controlled via requireProjectAccess.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  requestBegin,
  requestEnd,
  sessionMeta,
  spanBegin,
  spanEnd,
  subagentEvent,
  traceBegin,
  traceEnd,
  userText,
  withTraceContext,
} from "@prismshadow/penguin-core";
import type { OmniMessage, SessionMetaPayload } from "@prismshadow/penguin-core";
import type {
  AgentTracesResponse,
  MessagesResponse,
  ProjectCreateResponse,
  TraceAnalysisResponse,
  TraceEventsResponse,
  TraceRootResponse,
  TraceRootsResponse,
  TraceTurnResponse,
  TraceTurnsResponse,
} from "../src/api/types.js";
import {
  apiClient,
  createTestApp,
  provisionUser,
  writeLogicalTraceEvents,
  writeLogicalTraceJournal,
  writeTraceFile,
} from "./helpers.js";
import type { TestApp } from "./helpers.js";

/** An unmanaged child Session (only written to Trace, not inserted into the sessions table). */
const UNMANAGED = "session-2026-07-06-09-00-00-cafe0001";
const TURN_ID = "turn-cafe0001-0001";
const CHILD_SESSION = "session-2026-07-06-09-01-00-cafe0002";
const LOGICAL_SESSION = "session-2026-07-06-10-00-00-cafe0003";
const LOGICAL_TRACE = "trace-cafe0003-0001";
const LOGICAL_TASK = "task-cafe0003-0001";
const CHILD_LOGICAL_TRACE = "trace-cafe0002-0001";
const CHILD_LOGICAL_TASK = "task-cafe0002-0001";

function turnSpan(type: "span_begin" | "span_end"): OmniMessage {
  return {
    timestamp: "2026-07-06T09:00:01.000Z",
    type: "event_msg",
    protocol_version: 2,
    event_id: `event-${type}-cafe0001`,
    trace: { turn_id: TURN_ID, span_id: "span-turn-cafe0001" },
    payload: {
      type,
      span_kind: "agent.turn",
      ...(type === "span_end" ? { status: "completed" } : {}),
    },
  } as unknown as OmniMessage;
}

function legacyV2Record(
  message: OmniMessage,
  trace: { turn_id: string; span_id?: string; parent_span_id?: string },
): OmniMessage {
  return { ...message, protocol_version: 2, trace } as unknown as OmniMessage;
}

function legacyRecord(message: OmniMessage): OmniMessage {
  const copy = { ...message };
  delete copy.protocol_version;
  delete copy.event_id;
  delete copy.trace;
  return copy;
}

function metaPayload(sessionId = UNMANAGED): SessionMetaPayload {
  return {
    session_id: sessionId,
    model_id: "sub-model",
    provider: "custom",
    model_context_window: 1000,
    system_prompt: "",
    agent_state: "/tmp/a",
    workspace: "/tmp/w",
  };
}

function sessionFormat(sessionId: string) {
  return {
    record_type: "session_format",
    protocol_version: 3,
    format: "penguin.trace.session",
    format_version: 1,
    timestamp: "2026-07-06T09:59:59.000Z",
    session_id: sessionId,
  };
}

function traceEventLink(sessionId: string, traceId: string, message: OmniMessage) {
  return {
    record_type: "trace_event_link",
    protocol_version: 3,
    timestamp: message.timestamp,
    session_id: sessionId,
    trace_id: traceId,
    event_id: message.event_id,
  };
}

describe("agent-trace-detail", () => {
  let t: TestApp;
  let owner: ReturnType<typeof apiClient>;
  let outsider: ReturnType<typeof apiClient>;
  let projectId: string;
  const base = () => `/api/projects/${projectId}/agents/default_agent/traces`;

  beforeEach(async () => {
    t = await createTestApp();
    const a = await provisionUser(t.app, "owner");
    const b = await provisionUser(t.app, "outsider");
    owner = apiClient(t.app, a.cookie);
    outsider = apiClient(t.app, b.cookie);
    const created = (await (
      await owner.post("/api/projects", { projectId: "owner-trace", name: "Project" })
    ).json()) as ProjectCreateResponse;
    projectId = created.project.projectId;
    await writeTraceFile(t.root, projectId, "child_agent", "2026-07-06", CHILD_SESSION, 1, [
      sessionMeta(metaPayload(CHILD_SESSION)),
    ]);
    await writeTraceFile(t.root, projectId, "default_agent", "2026-07-06", UNMANAGED, 1, [
      sessionMeta(metaPayload()),
      userText("child session input"),
      turnSpan("span_begin"),
      legacyV2Record(subagentEvent(CHILD_SESSION), {
        turn_id: TURN_ID,
        span_id: "span-subagent-cafe0002",
        parent_span_id: "span-turn-cafe0001",
      }),
      requestBegin(),
      requestEnd("completed"),
      turnSpan("span_end"),
    ]);
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it("unmanaged Session: 404 via the Session-level endpoint, readable at Agent level", async () => {
    // Session-level: no such row in the sessions table -> 404.
    expect((await owner.get(`/api/sessions/${UNMANAGED}/traces/1`)).status).toBe(404);
    // Agent-level detail: locates the Trace file directly -> 200.
    const res = await owner.get(`${base()}/${UNMANAGED}/1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as TraceEventsResponse;
    expect(body.total).toBe(7);
    expect((body.events[1]!.payload as { text: string }).text).toBe("child session input");
  });

  it("explicit Turn endpoints work at Agent level and for a tracked Session", async () => {
    const listed = await owner.get(`${base()}/${UNMANAGED}/1/turns`);
    expect(listed.status).toBe(200);
    const listBody = (await listed.json()) as TraceTurnsResponse;
    expect(listBody).toMatchObject({ supported: true, protocolVersion: 2 });
    expect(listBody.turns).toEqual([
      expect.objectContaining({
        turnId: TURN_ID,
        rootSpanId: "span-turn-cafe0001",
        status: "completed",
        recordCount: 3,
      }),
    ]);

    const detail = await owner.get(`${base()}/${UNMANAGED}/1/turns/${TURN_ID}`);
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as TraceTurnResponse;
    expect(detailBody.turn.turnId).toBe(TURN_ID);
    expect(detailBody.records).toHaveLength(3);
    expect(detailBody.subagents).toEqual([{ sessionId: CHILD_SESSION, agentId: "child_agent" }]);
    expect((await owner.get(`${base()}/${UNMANAGED}/1/turns/turn-missing`)).status).toBe(404);

    t.deps.sessionsRepo.insert({
      sessionId: UNMANAGED,
      projectId,
      agentId: "default_agent",
      provider: "custom",
      modelId: "sub-model",
      workspace: "/tmp/w",
      approvalMode: "allow-all",
      title: null,
      createdAt: "2026-07-06T09:00:00.000Z",
      lastActiveAt: "2026-07-06T09:00:00.000Z",
    });
    expect((await owner.get(`/api/sessions/${UNMANAGED}/traces/1/turns`)).status).toBe(200);
    const sessionDetail = await owner.get(`/api/sessions/${UNMANAGED}/traces/1/turns/${TURN_ID}`);
    expect(sessionDetail.status).toBe(200);
    const sessionDetailBody = (await sessionDetail.json()) as TraceTurnResponse;
    expect(sessionDetailBody.turn.turnId).toBe(TURN_ID);
    expect(sessionDetailBody.subagents).toEqual([
      { sessionId: CHILD_SESSION, agentId: "child_agent" },
    ]);

    await writeTraceFile(t.root, projectId, "default_agent", "2026-07-06", UNMANAGED, 2, [
      legacyRecord(userText("legacy shard")),
    ]);
    const legacy = (await (
      await owner.get(`${base()}/${UNMANAGED}/2/turns`)
    ).json()) as TraceTurnsResponse;
    expect(legacy).toEqual({ supported: false, protocolVersion: null, turns: [] });
  });

  it("protocol-v3 logical roots are session-scoped and expose one refined child link", async () => {
    await writeLogicalTraceJournal(t.root, projectId, "child_agent", CHILD_SESSION, [
      sessionFormat(CHILD_SESSION),
      {
        record_type: "session_fact",
        protocol_version: 3,
        timestamp: "2026-07-06T10:00:00.000Z",
        message: sessionMeta(metaPayload(CHILD_SESSION)),
      },
      {
        record_type: "trace_link",
        protocol_version: 3,
        timestamp: "2026-07-06T10:00:01.000Z",
        session_id: CHILD_SESSION,
        trace_id: CHILD_LOGICAL_TRACE,
        root_kind: "task",
        task_id: CHILD_LOGICAL_TASK,
      },
    ]);
    await writeLogicalTraceEvents(
      t.root,
      projectId,
      "child_agent",
      CHILD_SESSION,
      CHILD_LOGICAL_TRACE,
      [],
    );
    const invocationSpanId = "span-subagent-cafe0003";
    const records = [
      traceBegin({ rootKind: "task", traceId: LOGICAL_TRACE, taskId: LOGICAL_TASK }),
      spanBegin({
        kind: "agent.task",
        traceId: LOGICAL_TRACE,
        taskId: LOGICAL_TASK,
        spanId: "span-task-cafe0003",
      }),
      withTraceContext(subagentEvent(CHILD_SESSION), {
        trace_id: LOGICAL_TRACE,
        task_id: LOGICAL_TASK,
        span_id: invocationSpanId,
      }),
      withTraceContext(
        subagentEvent(CHILD_SESSION, {
          traceId: CHILD_LOGICAL_TRACE,
          taskId: CHILD_LOGICAL_TASK,
        }),
        {
          trace_id: LOGICAL_TRACE,
          task_id: LOGICAL_TASK,
          span_id: invocationSpanId,
        },
      ),
      spanEnd({
        kind: "agent.task",
        traceId: LOGICAL_TRACE,
        taskId: LOGICAL_TASK,
        spanId: "span-task-cafe0003",
        status: "completed",
      }),
      traceEnd({
        rootKind: "task",
        traceId: LOGICAL_TRACE,
        taskId: LOGICAL_TASK,
        status: "completed",
      }),
    ].map((record, index) => ({
      ...record,
      timestamp: `2026-07-06T10:00:0${index + 2}.000Z`,
    }));
    await writeLogicalTraceJournal(t.root, projectId, "default_agent", LOGICAL_SESSION, [
      sessionFormat(LOGICAL_SESSION),
      {
        record_type: "session_fact",
        protocol_version: 3,
        timestamp: "2026-07-06T10:00:00.000Z",
        message: sessionMeta(metaPayload(LOGICAL_SESSION)),
      },
      {
        record_type: "trace_link",
        protocol_version: 3,
        timestamp: "2026-07-06T10:00:01.000Z",
        session_id: LOGICAL_SESSION,
        trace_id: LOGICAL_TRACE,
        root_kind: "task",
        task_id: LOGICAL_TASK,
      },
      ...records.map((record) => traceEventLink(LOGICAL_SESSION, LOGICAL_TRACE, record)),
    ]);
    await writeLogicalTraceEvents(
      t.root,
      projectId,
      "default_agent",
      LOGICAL_SESSION,
      LOGICAL_TRACE,
      records,
    );

    const listed = await owner.get(`${base()}/${LOGICAL_SESSION}/roots`);
    expect(listed.status).toBe(200);
    const inventory = (await listed.json()) as TraceRootsResponse;
    expect(inventory).toMatchObject({ supported: true, protocolVersion: 3 });
    expect(inventory.roots.map((root) => root.traceId)).toEqual([LOGICAL_TRACE]);

    const detail = await owner.get(`${base()}/${LOGICAL_SESSION}/roots/${LOGICAL_TRACE}`);
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as TraceRootResponse;
    expect(body.root).toMatchObject({
      traceId: LOGICAL_TRACE,
      rootKind: "task",
      status: "completed",
      partial: false,
    });
    expect(body.tasks).toEqual([
      expect.objectContaining({ taskId: LOGICAL_TASK, status: "completed", partial: false }),
    ]);
    expect(body.subagents).toEqual([
      expect.objectContaining({
        sessionId: CHILD_SESSION,
        agentId: "child_agent",
        childTraceId: CHILD_LOGICAL_TRACE,
        childTaskId: CHILD_LOGICAL_TASK,
        invocationSpanId,
      }),
    ]);

    t.deps.sessionsRepo.insert({
      sessionId: LOGICAL_SESSION,
      projectId,
      agentId: "default_agent",
      provider: "custom",
      modelId: "sub-model",
      workspace: "/tmp/w",
      approvalMode: "allow-all",
      title: null,
      createdAt: "2026-07-06T10:00:00.000Z",
      lastActiveAt: "2026-07-06T10:00:00.000Z",
    });
    expect((await owner.get(`/api/sessions/${LOGICAL_SESSION}/traces/roots`)).status).toBe(200);
    expect(
      (await owner.get(`/api/sessions/${LOGICAL_SESSION}/traces/roots/${LOGICAL_TRACE}`)).status,
    ).toBe(200);
    const history = await owner.get(`/api/sessions/${LOGICAL_SESSION}/messages`);
    expect(history.status).toBe(200);
    const historyBody = (await history.json()) as MessagesResponse;
    expect(historyBody.history).toEqual({
      protocolVersion: 3,
      partial: false,
      diagnostics: [],
    });

    const unsupported = (await (
      await owner.get(`${base()}/${UNMANAGED}/roots`)
    ).json()) as TraceRootsResponse;
    expect(unsupported).toEqual({ supported: false, protocolVersion: null, roots: [] });
    expect((await owner.get(`${base()}/${LOGICAL_SESSION}/roots/trace-missing`)).status).toBe(404);
  });

  it("Agent-level detail pagination params take effect", async () => {
    const res = await owner.get(`${base()}/${UNMANAGED}/1?offset=1&limit=2`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as TraceEventsResponse;
    expect(body.offset).toBe(1);
    expect(body.limit).toBe(2);
    expect(body.events).toHaveLength(2);
    // Invalid index / limit -> 400.
    expect((await owner.get(`${base()}/${UNMANAGED}/0`)).status).toBe(400);
    expect((await owner.get(`${base()}/${UNMANAGED}/1?limit=5000`)).status).toBe(400);
  });

  it("Agent-level analysis endpoint derives Request pairings", async () => {
    const res = await owner.get(`${base()}/${UNMANAGED}/1/analysis`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as TraceAnalysisResponse;
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0]!.status).toBe("completed");
  });

  it("nonexistent index → 404 trace_not_found", async () => {
    expect((await owner.get(`${base()}/${UNMANAGED}/9`)).status).toBe(404);
  });

  it("listing without limit keeps the legacy full shape; with limit it pages Session groups and resolves titles", async () => {
    // Legacy request: full date drill-down, no paging fields.
    const legacy = (await (await owner.get(base())).json()) as AgentTracesResponse;
    expect(legacy.dates.map((d) => d.date)).toEqual(["2026-07-06"]);
    expect(legacy.sessions).toBeUndefined();
    expect(legacy.totalSessions).toBeUndefined();

    // Default paged request: the unmanaged Session is CLI-origin (no web sessions-table
    // row, not subagent/schedule), so the "show CLI sessions" OFF default excludes it
    // from the listing AND the counts.
    const hidden = (await (await owner.get(`${base()}?limit=10`)).json()) as AgentTracesResponse;
    expect(hidden.sessions).toEqual([]);
    expect(hidden.totalSessions).toBe(0);
    expect(hidden.counts).toEqual({ active: 0, subagent: 0, schedule: 0, archived: 0 });

    // cli=1: visible, with title derived from the first user prompt and category /
    // workspace from the registration-time facts (the index head-read the earliest
    // shard once when the file was first seen — exact on the FIRST request).
    const paged = (await (
      await owner.get(`${base()}?limit=10&cli=1`)
    ).json()) as AgentTracesResponse;
    expect(paged.totalSessions).toBe(1);
    expect(paged.sessions!.map((s) => s.sessionId)).toEqual([UNMANAGED]);
    expect(paged.sessions![0]!.title).toBe("child session input");
    expect(paged.sessions![0]!.files.map((f) => ({ index: f.index, date: f.date }))).toEqual([
      { index: 1, date: "2026-07-06" },
    ]);
    expect(paged.sessions![0]!.category).toBe("active");
    expect(paged.sessions![0]!.workspace).toBe("/tmp/w");
    expect(paged.counts).toEqual({ active: 1, subagent: 0, schedule: 0, archived: 0 });
    expect(paged.workspaceCounts!["/tmp/w"]).toEqual({
      active: 1,
      subagent: 0,
      schedule: 0,
      archived: 0,
    });

    // A sessions-table title (one batched lookup for the page) wins over the fallback.
    t.deps.sessionsRepo.insert({
      sessionId: UNMANAGED,
      projectId,
      agentId: "default_agent",
      provider: "custom",
      modelId: "sub-model",
      workspace: "/tmp/w",
      approvalMode: "allow-all",
      title: "已生成的标题",
      client: "cli",
      createdAt: "2026-07-06T09:00:00.000Z",
      lastActiveAt: "2026-07-06T09:00:00.000Z",
    });
    const titled = (await (
      await owner.get(`${base()}?limit=10&cli=1`)
    ).json()) as AgentTracesResponse;
    expect(titled.sessions![0]!.title).toBe("已生成的标题");
    // The adopted row carries client='cli': it stays behind the preference by default.
    const stillHidden = (await (
      await owner.get(`${base()}?limit=10`)
    ).json()) as AgentTracesResponse;
    expect(stillHidden.sessions).toEqual([]);

    // offset pages past the only group; offset without limit is a client error.
    const empty = (await (
      await owner.get(`${base()}?limit=10&offset=10&cli=1`)
    ).json()) as AgentTracesResponse;
    expect(empty.sessions).toEqual([]);
    expect(empty.totalSessions).toBe(1);
    expect((await owner.get(`${base()}?offset=1`)).status).toBe(400);

    // Category filter: pages within one bucket (totalSessions = the bucket's count);
    // unknown values, category-without-limit, and a bad cli value are client errors.
    const filtered = (await (
      await owner.get(`${base()}?limit=10&category=subagent&cli=1`)
    ).json()) as AgentTracesResponse;
    expect(filtered.sessions).toEqual([]);
    expect(filtered.totalSessions).toBe(0);
    expect((await owner.get(`${base()}?limit=10&category=bogus`)).status).toBe(400);
    expect((await owner.get(`${base()}?category=active`)).status).toBe(400);
    expect((await owner.get(`${base()}?limit=10&cli=2`)).status).toBe(400);
  });

  it("user without access → 404 (requireProjectAccess)", async () => {
    expect((await outsider.get(`${base()}/${UNMANAGED}/1`)).status).toBe(404);
    expect((await outsider.get(`${base()}/${UNMANAGED}/1/analysis`)).status).toBe(404);
    expect((await outsider.get(`${base()}/${UNMANAGED}/1/turns`)).status).toBe(404);
    expect((await outsider.get(`${base()}/${UNMANAGED}/1/turns/${TURN_ID}`)).status).toBe(404);
    expect((await outsider.get(`${base()}/${LOGICAL_SESSION}/roots`)).status).toBe(404);
    expect((await outsider.get(`${base()}/${LOGICAL_SESSION}/roots/${LOGICAL_TRACE}`)).status).toBe(
      404,
    );
  });
});
