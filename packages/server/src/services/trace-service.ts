/**
 * Trace service.
 *
 * History messages: all of the Session's index files concatenated in order
 * (readTraceTolerant, tolerating a truncated last line and skipping malformed
 * middle lines), containing only the complete messages and events that were
 * actually written to Trace (naturally excluding partial_*); in-flight
 * increments are continued by SSE.
 * Performance analysis is derived from a single Trace file: nearest-neighbor
 * pairing of request_begin/end, tool call duration pairing, reconnect / compaction
 * counts, and Token trend.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  isSessionMeta,
  parseTraceLines,
  parseUserSteeringText,
  readTraceTolerant,
  tracesDir,
} from "@prismshadow/penguin-core";
import type { OmniMessage } from "@prismshadow/penguin-core";
import type {
  AgentTraceSessionEntry,
  AgentTracesResponse,
  RequestSpan,
  SessionCategory,
  SessionCategoryCounts,
  ToolCallSpan,
  TraceAnalysisResponse,
  TraceEventsResponse,
  TraceFileInfo,
  TraceImportResponse,
  TraceHistoryDiagnostic,
  TraceHistoryInfo,
  TraceModelSegment,
  TraceOtherSpan,
  TraceRootKind,
  TraceRootResponse,
  TraceRootSubagent,
  TraceRootsResponse,
  TraceRootSummary,
  TraceStepSummary,
  TraceTaskSummary,
  TraceTaskStats,
  TraceToolSpan,
  TraceTurnResponse,
  TraceTurnSubagent,
  TraceTurnsResponse,
  TraceTurnSummary,
  UsageTrendPointInTrace,
} from "../api/types.js";
import type { SessionRow } from "../db/repos/sessions.js";
import type { TraceFileRow, TraceSessionRow } from "../db/repos/trace-index.js";
import { HttpError } from "../http/errors.js";
import { formatLocalDate } from "../internal/dates.js";
import type { SessionSources } from "../runtime/session-sources.js";
import {
  cloneScanState,
  deserializePrefix,
  encodeCursor,
  finalizeScan,
  initialScanState,
  scanMessages,
  serializePrefix,
} from "./message-window.js";
import type {
  ChildAggregate,
  MessageCursor,
  ScanState,
  WindowPriorStats,
} from "./message-window.js";
import { TraceIndexService, traceFilePath } from "./trace-index.js";

const TRACE_FILE_RE = /^(.+)_(\d{3})\.jsonl$/;

/**
 * session_id an imported Trace file may declare: same alphabet as resource ids plus a length
 * cap. The value becomes part of the target **filename**, so this is a path-traversal defense,
 * checked right next to the path construction — never trust the caller to have validated it.
 */
const IMPORT_SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Recursion depth cap for sub-session expansion (run_subagent depth is already constrained by the SDK; this is just a defensive backstop against cycles). */
const MAX_SUBAGENT_DEPTH = 4;

interface LocatedFile {
  path: string;
  date: string;
  index: number;
  /** Last observed size from the index row (the page-stats cache write guard). */
  sizeBytes: number;
}

/**
 * Runtime view of additive protocol-v2 fields; on-disk JSON is not runtime-validated by the
 * parser. Server and Web maintainers keep this read-only shard path together until a release
 * explicitly drops v1/v2 inspection after shipping a documented backup or bulk-export path.
 * Removing the reader never authorizes deleting the legacy files themselves.
 */
function explicitTraceRecord(
  message: OmniMessage,
): { turnId: string; spanId?: string; payload: Record<string, unknown> } | null {
  if (message.protocol_version !== 2 || message.trace === undefined) return null;
  const legacyTrace = message.trace as unknown as { turn_id?: unknown; span_id?: unknown };
  const turnId: unknown = legacyTrace.turn_id;
  if (typeof turnId !== "string" || turnId.length === 0) return null;
  const spanId: unknown = legacyTrace.span_id;
  const payload = message.payload as unknown;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  return {
    turnId,
    ...(typeof spanId === "string" && spanId.length > 0 ? { spanId } : {}),
    payload: payload as Record<string, unknown>,
  };
}

/** Materializes only explicit `agent.turn` root Span lifecycles; it never infers V1 turns. */
function explicitTurnSummaries(records: OmniMessage[]): TraceTurnsResponse {
  const supported = records.some((message) => message.protocol_version === 2);
  if (!supported) return { supported: false, protocolVersion: null, turns: [] };

  const recordCounts = new Map<string, number>();
  const byTurn = new Map<string, TraceTurnSummary>();
  const rootEnds = new Map<string, { timestamp: string; status?: string }>();
  const turns: TraceTurnSummary[] = [];
  for (const message of records) {
    const explicit = explicitTraceRecord(message);
    if (explicit === null) continue;
    recordCounts.set(explicit.turnId, (recordCounts.get(explicit.turnId) ?? 0) + 1);

    if (message.type !== "event_msg") continue;
    const lifecycleType = explicit.payload.type;
    if (
      lifecycleType === "span_begin" &&
      explicit.payload.span_kind === "agent.turn" &&
      explicit.spanId !== undefined &&
      typeof message.timestamp === "string" &&
      message.timestamp.length > 0 &&
      !byTurn.has(explicit.turnId)
    ) {
      const summary: TraceTurnSummary = {
        turnId: explicit.turnId,
        rootSpanId: explicit.spanId,
        startTs: message.timestamp,
        recordCount: 0,
      };
      byTurn.set(explicit.turnId, summary);
      turns.push(summary);
      continue;
    }

    if (
      lifecycleType !== "span_end" ||
      explicit.payload.span_kind !== "agent.turn" ||
      explicit.spanId === undefined
    ) {
      continue;
    }
    if (typeof message.timestamp !== "string" || message.timestamp.length === 0) continue;
    const key = `${explicit.turnId}\u0000${explicit.spanId}`;
    if (!rootEnds.has(key)) {
      rootEnds.set(key, {
        timestamp: message.timestamp,
        ...(typeof explicit.payload.status === "string" ? { status: explicit.payload.status } : {}),
      });
    }
  }
  for (const turn of turns) {
    turn.recordCount = recordCounts.get(turn.turnId) ?? 0;
    const end = rootEnds.get(`${turn.turnId}\u0000${turn.rootSpanId}`);
    if (end === undefined) continue;
    turn.endTs = end.timestamp;
    if (end.status !== undefined) turn.status = end.status;
  }
  return { supported: true, protocolVersion: 2, turns };
}

interface LogicalTraceLink {
  traceId: string;
  rootKind: TraceRootKind;
  taskId?: string;
}

interface LogicalTraceEventLink {
  traceId: string;
  eventId: string;
}

interface LogicalHistoryPayload {
  message: OmniMessage;
  storedTraceId: string;
  actualTraceId?: string;
  eventId: string;
  claimed: boolean;
}

interface ExplicitV3Record {
  message: OmniMessage;
  payload: Record<string, unknown>;
  taskId?: string;
  stepId?: string;
  spanId?: string;
}

interface SpanTerminal {
  spanId: string;
  timestamp?: string;
  status?: string;
}

interface SpanLifecycle {
  begin?: { spanId: string; timestamp?: string };
  firstEnd?: SpanTerminal;
  ends: Map<string, SpanTerminal>;
}

interface StepAccumulator {
  stepId: string;
  taskId: string;
  recordCount: number;
  lifecycle: SpanLifecycle;
}

interface TaskAccumulator {
  taskId: string;
  recordCount: number;
  lifecycle: SpanLifecycle;
  steps: Map<string, StepAccumulator>;
}

interface ProjectedLogicalTrace {
  root: TraceRootSummary;
  tasks: TraceTaskSummary[];
}

interface LogicalHistorySegment {
  /** Stable 1-based ordinal of the source record in the append-only Session journal. */
  cursorIndex: number;
  messages: OmniMessage[];
}

interface LogicalSessionHistory {
  supported: boolean;
  segments: LogicalHistorySegment[];
  diagnostics: TraceHistoryDiagnostic[];
}

interface LogicalProjectedEvent {
  /** 1-based physical line ordinal in session.jsonl. */
  journalOrdinal: number;
  traceId: string;
  eventId: string;
  message: OmniMessage;
}

interface LogicalJournalEntry {
  /** 1-based physical line ordinal; malformed and empty lines still occupy ordinals. */
  lineOrdinal: number;
  value: OmniMessage;
}

interface LogicalSessionProjection {
  supported: boolean;
  journal: LogicalJournalEntry[];
  links: LogicalTraceLink[];
  events: LogicalProjectedEvent[];
  diagnostics: TraceHistoryDiagnostic[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function rootKindOf(value: unknown): TraceRootKind | undefined {
  return value === "goal_run" || value === "task" ? value : undefined;
}

function isMissingPath(error: unknown): boolean {
  const code = asRecord(error)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Runtime validation for the protocol-v3 Session journal's append-only Trace links. */
function logicalTraceLink(value: unknown, sessionId: string): LogicalTraceLink | null {
  const record = asRecord(value);
  if (
    record === null ||
    record.protocol_version !== 3 ||
    record.record_type !== "trace_link" ||
    record.session_id !== sessionId
  ) {
    return null;
  }
  const traceId = nonEmptyString(record.trace_id);
  const rootKind = rootKindOf(record.root_kind);
  if (traceId === undefined || rootKind === undefined || !IMPORT_SESSION_ID_RE.test(traceId)) {
    return null;
  }
  const taskId = nonEmptyString(record.task_id);
  return { traceId, rootKind, ...(taskId !== undefined ? { taskId } : {}) };
}

/** Runtime validation for the v3 journal's exact history-order links. */
function logicalTraceEventLink(value: unknown, sessionId: string): LogicalTraceEventLink | null {
  const record = asRecord(value);
  if (
    record === null ||
    record.protocol_version !== 3 ||
    record.record_type !== "trace_event_link" ||
    record.session_id !== sessionId
  ) {
    return null;
  }
  const traceId = nonEmptyString(record.trace_id);
  const eventId = nonEmptyString(record.event_id);
  return traceId !== undefined &&
    eventId !== undefined &&
    IMPORT_SESSION_ID_RE.test(traceId) &&
    IMPORT_SESSION_ID_RE.test(eventId)
    ? { traceId, eventId }
    : null;
}

/** Exact marker that opts a Session into journal-ordinal history reconstruction. */
function isLogicalSessionFormat(value: unknown, sessionId: string): boolean {
  const record = asRecord(value);
  return (
    record !== null &&
    record.record_type === "session_format" &&
    record.protocol_version === 3 &&
    record.format === "penguin.trace.session" &&
    record.format_version === 1 &&
    record.session_id === sessionId
  );
}

/** Runtime validation for a v3 journal-wrapped Session fact. */
function logicalSessionFact(value: unknown): OmniMessage | null {
  const record = asRecord(value);
  if (record === null || record.protocol_version !== 3 || record.record_type !== "session_fact") {
    return null;
  }
  const message = asRecord(record.message);
  if (message === null) return null;
  if (message.type === "session_meta") return message as unknown as OmniMessage;
  const payload = asRecord(message.payload);
  return message.type === "event_msg" && payload?.type === "tool_list_ready"
    ? (message as unknown as OmniMessage)
    : null;
}

/** Runtime view of one explicit protocol-v3 execution record for the requested root. */
function explicitV3Record(message: OmniMessage, traceId: string): ExplicitV3Record | null {
  const envelope = asRecord(message);
  if (envelope === null || envelope.protocol_version !== 3) return null;
  const trace = asRecord(envelope.trace);
  const payload = asRecord(envelope.payload);
  if (trace === null || payload === null || trace.trace_id !== traceId) return null;
  const taskId = nonEmptyString(trace.task_id);
  const stepId = nonEmptyString(trace.step_id);
  const spanId = nonEmptyString(trace.span_id);
  return {
    message,
    payload,
    ...(taskId !== undefined ? { taskId } : {}),
    ...(stepId !== undefined ? { stepId } : {}),
    ...(spanId !== undefined ? { spanId } : {}),
  };
}

function logicalHistoryPointerKey(message: OmniMessage): string | null {
  const envelope = asRecord(message);
  const payload = asRecord(envelope?.payload);
  const trace = asRecord(envelope?.trace);
  return envelope?.protocol_version === 3 &&
    payload?.type === "subagent" &&
    typeof payload.session_id === "string" &&
    payload.session_id.length > 0 &&
    typeof trace?.span_id === "string" &&
    trace.span_id.length > 0
    ? `${payload.session_id}\u0000${trace.span_id}`
    : null;
}

function emptyLifecycle(): SpanLifecycle {
  return { ends: new Map() };
}

function messageTimestamp(message: OmniMessage): string | undefined {
  return nonEmptyString(asRecord(message)?.timestamp);
}

function noteSpanLifecycle(
  lifecycle: SpanLifecycle,
  record: ExplicitV3Record,
  spanKind: "agent.task" | "agent.step",
): void {
  if (record.payload.span_kind !== spanKind || record.spanId === undefined) return;
  const timestamp = messageTimestamp(record.message);
  if (record.payload.type === "span_begin") {
    if (lifecycle.begin === undefined) {
      lifecycle.begin = {
        spanId: record.spanId,
        ...(timestamp !== undefined ? { timestamp } : {}),
      };
    }
    return;
  }
  if (record.payload.type !== "span_end") return;
  const terminal: SpanTerminal = {
    spanId: record.spanId,
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(typeof record.payload.status === "string" ? { status: record.payload.status } : {}),
  };
  if (lifecycle.firstEnd === undefined) lifecycle.firstEnd = terminal;
  if (!lifecycle.ends.has(record.spanId)) lifecycle.ends.set(record.spanId, terminal);
}

function materializeStep(step: StepAccumulator): TraceStepSummary {
  const spanId = step.lifecycle.begin?.spanId ?? step.lifecycle.firstEnd?.spanId;
  const end = spanId !== undefined ? step.lifecycle.ends.get(spanId) : undefined;
  return {
    stepId: step.stepId,
    taskId: step.taskId,
    ...(spanId !== undefined ? { spanId } : {}),
    ...(step.lifecycle.begin?.timestamp !== undefined
      ? { startTs: step.lifecycle.begin.timestamp }
      : {}),
    ...(end?.timestamp !== undefined ? { endTs: end.timestamp } : {}),
    ...(end?.status !== undefined ? { status: end.status } : {}),
    recordCount: step.recordCount,
    partial: step.lifecycle.begin === undefined || end === undefined,
  };
}

function materializeTask(task: TaskAccumulator): TraceTaskSummary {
  const spanId = task.lifecycle.begin?.spanId ?? task.lifecycle.firstEnd?.spanId;
  const end = spanId !== undefined ? task.lifecycle.ends.get(spanId) : undefined;
  return {
    taskId: task.taskId,
    ...(spanId !== undefined ? { spanId } : {}),
    ...(task.lifecycle.begin?.timestamp !== undefined
      ? { startTs: task.lifecycle.begin.timestamp }
      : {}),
    ...(end?.timestamp !== undefined ? { endTs: end.timestamp } : {}),
    ...(end?.status !== undefined ? { status: end.status } : {}),
    recordCount: task.recordCount,
    partial: task.lifecycle.begin === undefined || end === undefined,
    steps: [...task.steps.values()].map(materializeStep),
  };
}

/** Projects one events.jsonl in append order; no timestamp or free-text inference is used. */
function projectLogicalTrace(
  link: LogicalTraceLink,
  records: ExplicitV3Record[],
): ProjectedLogicalTrace {
  let begin: { rootKind: TraceRootKind; timestamp?: string } | undefined;
  const rootEnds = new Map<TraceRootKind, { timestamp?: string; status?: string }>();
  let firstEnd: { rootKind: TraceRootKind; timestamp?: string; status?: string } | undefined;
  const tasks = new Map<string, TaskAccumulator>();

  const ensureTask = (taskId: string): TaskAccumulator => {
    let task = tasks.get(taskId);
    if (task === undefined) {
      task = { taskId, recordCount: 0, lifecycle: emptyLifecycle(), steps: new Map() };
      tasks.set(taskId, task);
    }
    return task;
  };
  if (link.taskId !== undefined) ensureTask(link.taskId);

  for (const record of records) {
    const rootKind = rootKindOf(record.payload.root_kind);
    const timestamp = messageTimestamp(record.message);
    if (record.payload.type === "trace_begin" && rootKind !== undefined && begin === undefined) {
      begin = { rootKind, ...(timestamp !== undefined ? { timestamp } : {}) };
    } else if (record.payload.type === "trace_end" && rootKind !== undefined) {
      const terminal = {
        rootKind,
        ...(timestamp !== undefined ? { timestamp } : {}),
        ...(typeof record.payload.status === "string" ? { status: record.payload.status } : {}),
      };
      if (firstEnd === undefined) firstEnd = terminal;
      if (!rootEnds.has(rootKind)) rootEnds.set(rootKind, terminal);
    }

    if (record.taskId === undefined) continue;
    const task = ensureTask(record.taskId);
    task.recordCount += 1;
    noteSpanLifecycle(task.lifecycle, record, "agent.task");
    if (record.stepId === undefined) continue;
    let step = task.steps.get(record.stepId);
    if (step === undefined) {
      step = {
        stepId: record.stepId,
        taskId: record.taskId,
        recordCount: 0,
        lifecycle: emptyLifecycle(),
      };
      task.steps.set(record.stepId, step);
    }
    step.recordCount += 1;
    noteSpanLifecycle(step.lifecycle, record, "agent.step");
  }

  const rootKind = begin?.rootKind ?? link.rootKind ?? firstEnd?.rootKind ?? null;
  const rootEnd = rootKind !== null ? rootEnds.get(rootKind) : undefined;
  const projectedTasks = [...tasks.values()].map(materializeTask);
  const inconsistentKind = begin !== undefined && begin.rootKind !== link.rootKind;
  return {
    root: {
      traceId: link.traceId,
      rootKind,
      ...(begin?.timestamp !== undefined ? { startTs: begin.timestamp } : {}),
      ...(rootEnd?.timestamp !== undefined ? { endTs: rootEnd.timestamp } : {}),
      ...(rootEnd?.status !== undefined ? { status: rootEnd.status } : {}),
      recordCount: records.length,
      taskCount: projectedTasks.length,
      partial: begin === undefined || rootEnd === undefined || inconsistentKind,
    },
    tasks: projectedTasks,
  };
}

/** A windowed history read's request shape (see readMessagesPage). */
export type MessagesPageRequest =
  { kind: "tail"; limit: number } | { kind: "before"; cursor: MessageCursor; limit: number };

/** A windowed history read's result (route maps it onto MessagesResponse.page). */
export interface MessagesPageResult {
  messages: OmniMessage[];
  /** Cursor of the window's first unit; absent = the window reaches the beginning. */
  before?: string;
  /** Cumulative stats before the window (earlierTurns = prior.turns). */
  prior: WindowPriorStats;
  /** Present when this expanded window touched protocol-v3 storage. */
  history?: TraceHistoryInfo;
}

export interface MessagesReadResult {
  messages: OmniMessage[];
  /** Present when this expanded transcript touched protocol-v3 storage. */
  history?: TraceHistoryInfo;
}

/**
 * Per-request expansion context: `projectScanned` caps the miss-path force reconcile at
 * one per request; `ancestry` guards cycles; `raw` memoizes each child session's
 * concatenated shard messages so the window expansion and the subagent-token
 * aggregation never read the same child twice within one request.
 */
interface ExpandCtx {
  projectScanned: boolean;
  ancestry: Set<string>;
  depth: number;
  raw: Map<string, OmniMessage[] | null>;
  logicalHistorySeen: boolean;
  diagnostics: TraceHistoryDiagnostic[];
}

function noteLogicalHistory(ctx: ExpandCtx, history: LogicalSessionHistory): void {
  if (!history.supported) return;
  ctx.logicalHistorySeen = true;
  ctx.diagnostics.push(...history.diagnostics);
}

function historyInfo(ctx: ExpandCtx): TraceHistoryInfo | undefined {
  return ctx.logicalHistorySeen
    ? { protocolVersion: 3, partial: ctx.diagnostics.length > 0, diagnostics: ctx.diagnostics }
    : undefined;
}

/**
 * A **direct sub-session pointer** (the `subagent` event in the parent Trace) ->
 * the sub-session's Session id. The pointer only
 * records the Session id; the sub-session's Agent is located within the Project by
 * its Trace file.
 */
function subagentPointer(msg: OmniMessage): string | null {
  if (msg.type !== "event_msg") return null;
  const p = msg.payload as { type?: string; session_id?: unknown };
  if (p.type !== "subagent" || typeof p.session_id !== "string" || p.session_id === "") {
    return null;
  }
  return p.session_id;
}

/**
 * Read-only slice of the Session index the paginated listing consults (SessionsRepo
 * structurally satisfies it; injected so service tests need no full app): one indexed
 * query answers title / archived / workspace / client for every DB-tracked Session of
 * the Agent.
 */
export interface TraceSessionIndex {
  listByAgent(projectId: string, agentId: string): SessionRow[];
}

/** TraceService wiring (the trace-file index is required: every listing/locating path serves from it — no directory walks). */
export interface TraceServiceDeps {
  index: TraceIndexService;
  /** Optional (narrow tests may omit): DB rows supplying titles / archived / workspace / client. */
  sessions?: TraceSessionIndex;
  /** Optional (narrow tests may omit): the shared in-process Session-origin registry (single source of truth for `source`). */
  sources?: SessionSources;
  /**
   * Test observability: called with the path of every Trace shard this service reads
   * from disk (windowed-read tests assert an old-window request never touches the
   * newest shard and vice versa). Production wiring omits it.
   */
  observeShardRead?: (path: string) => void;
}

/** One Session's classification result (see classify): its sidebar category + Workspace path ("" = unknown). */
interface TraceSessionFacts {
  category: SessionCategory;
  workspace: string;
}

export class TraceService {
  constructor(
    private readonly root: string,
    private readonly deps: TraceServiceDeps,
  ) {}

  private logicalSessionDir(projectId: string, agentId: string, sessionId: string): string {
    return path.join(tracesDir(this.root, projectId, agentId), sessionId);
  }

  /** Reads one optional v3 JSONL file with the Trace reader's torn-tail/malformed-line policy. */
  private async readOptionalLogicalFile(file: string): Promise<OmniMessage[]> {
    return (await this.readOptionalLogicalFileState(file)).records;
  }

  /** Same read with ENOENT preserved so a journaled root can diagnose a missing file. */
  private async readOptionalLogicalFileState(
    file: string,
  ): Promise<{ exists: boolean; records: OmniMessage[] }> {
    try {
      const records = await readTraceTolerant(file);
      this.deps.observeShardRead?.(file);
      return { exists: true, records };
    } catch (error) {
      if (isMissingPath(error)) return { exists: false, records: [] };
      throw error;
    }
  }

  /**
   * Reads session.jsonl without compacting away malformed physical lines. Journal line
   * ordinals are wire cursors, so a tolerant parser that returns only valid values would
   * make cursors drift after corruption.
   */
  private async readLogicalSessionJournalFile(
    projectId: string,
    agentId: string,
    sessionId: string,
  ): Promise<{ entries: LogicalJournalEntry[]; diagnostics: TraceHistoryDiagnostic[] }> {
    const file = path.join(this.logicalSessionDir(projectId, agentId, sessionId), "session.jsonl");
    let content: string;
    try {
      content = await fs.readFile(file, "utf8");
      this.deps.observeShardRead?.(file);
    } catch (error) {
      if (isMissingPath(error)) return { entries: [], diagnostics: [] };
      throw error;
    }

    const entries: LogicalJournalEntry[] = [];
    const diagnostics: TraceHistoryDiagnostic[] = [];
    const lines = content.split("\n");
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex]!;
      if (line.trim().length === 0) continue;
      try {
        entries.push({
          lineOrdinal: lineIndex + 1,
          value: JSON.parse(line) as OmniMessage,
        });
      } catch {
        diagnostics.push({
          code: "malformed_session_journal",
          sessionId,
          journalIndex: lineIndex,
          message: `Session history journal line ${lineIndex + 1} is malformed or crash-torn and was skipped.`,
        });
      }
    }
    return { entries, diagnostics };
  }

  /**
   * Matches protocol-v3 payloads onto first-winning Session-journal event links. This
   * projector is the only ordering source for both chat history and logical-root APIs.
   */
  private async readLogicalSessionProjection(
    projectId: string,
    agentId: string,
    sessionId: string,
  ): Promise<LogicalSessionProjection> {
    const parsedJournal = await this.readLogicalSessionJournalFile(projectId, agentId, sessionId);
    const journal = parsedJournal.entries;
    const supported = journal.some((entry) => asRecord(entry.value)?.protocol_version === 3);
    if (!supported) {
      if (parsedJournal.diagnostics.length > 0) {
        throw new HttpError(
          409,
          "trace_history_unsupported",
          "This Session journal has no readable protocol-v3 format marker and cannot be reconstructed safely.",
        );
      }
      return { supported: false, journal, links: [], events: [], diagnostics: [] };
    }
    if (!journal.some((entry) => isLogicalSessionFormat(entry.value, sessionId))) {
      throw new HttpError(
        409,
        "trace_history_unsupported",
        "This protocol-v3 Session predates explicit history-order links and cannot be reconstructed safely.",
      );
    }

    const links: LogicalTraceLink[] = [];
    const seenLinks = new Set<string>();
    const traceIds: string[] = [];
    const seenTraceIds = new Set<string>();
    for (const entry of journal) {
      const source = entry.value;
      const rootLink = logicalTraceLink(source, sessionId);
      if (rootLink !== null && !seenLinks.has(rootLink.traceId)) {
        seenLinks.add(rootLink.traceId);
        links.push(rootLink);
      }
      const traceId = rootLink?.traceId ?? logicalTraceEventLink(source, sessionId)?.traceId;
      if (traceId === undefined || seenTraceIds.has(traceId)) continue;
      seenTraceIds.add(traceId);
      traceIds.push(traceId);
    }

    const diagnostics: TraceHistoryDiagnostic[] = [...parsedJournal.diagnostics];
    const payloadDiagnostics: TraceHistoryDiagnostic[] = [];
    const payloads = new Map<string, LogicalHistoryPayload[]>();
    const allPayloads: LogicalHistoryPayload[] = [];
    const tracePayloadFiles = await Promise.all(
      traceIds.map((storedTraceId) =>
        this.readOptionalLogicalFileState(
          path.join(
            this.logicalSessionDir(projectId, agentId, sessionId),
            "traces",
            storedTraceId,
            "events.jsonl",
          ),
        ),
      ),
    );
    for (let traceIndex = 0; traceIndex < traceIds.length; traceIndex += 1) {
      const storedTraceId = traceIds[traceIndex]!;
      const payloadFile = tracePayloadFiles[traceIndex]!;
      if (!payloadFile.exists && seenLinks.has(storedTraceId)) {
        payloadDiagnostics.push({
          code: "missing_trace_event_file",
          sessionId,
          traceId: storedTraceId,
          message: `Trace ${storedTraceId} is linked from the Session journal, but its events.jsonl file is missing.`,
        });
      }
      const raw = payloadFile.records;
      for (const message of raw) {
        const envelope = asRecord(message);
        if (envelope?.protocol_version !== 3) continue;
        const eventId = nonEmptyString(envelope.event_id);
        const actualTraceId = nonEmptyString(asRecord(envelope.trace)?.trace_id);
        if (eventId === undefined) {
          payloadDiagnostics.push({
            code: "unlinked_trace_event",
            sessionId,
            traceId: storedTraceId,
            message: `A protocol-v3 event in Trace ${storedTraceId} has no event_id and cannot be linked into Session history.`,
          });
          continue;
        }
        const payload: LogicalHistoryPayload = {
          message,
          storedTraceId,
          ...(actualTraceId !== undefined ? { actualTraceId } : {}),
          eventId,
          claimed: false,
        };
        const key = `${storedTraceId}\u0000${eventId}`;
        const bucket = payloads.get(key);
        if (bucket === undefined) payloads.set(key, [payload]);
        else bucket.push(payload);
        allPayloads.push(payload);
      }
    }

    const events: LogicalProjectedEvent[] = [];
    const seenEventLinks = new Set<string>();
    for (const entry of journal) {
      const source = entry.value;
      const link = logicalTraceEventLink(source, sessionId);
      if (link === null) continue;
      const key = `${link.traceId}\u0000${link.eventId}`;
      if (seenEventLinks.has(key)) {
        diagnostics.push({
          code: "duplicate_trace_event_link",
          sessionId,
          journalIndex: entry.lineOrdinal - 1,
          traceId: link.traceId,
          eventId: link.eventId,
          message: `Session history has more than one link for event ${link.eventId} in Trace ${link.traceId}; the first link wins.`,
        });
        continue;
      }
      seenEventLinks.add(key);

      const payload = payloads.get(key)?.[0];
      if (payload === undefined) {
        diagnostics.push({
          code: "dangling_trace_event_link",
          sessionId,
          journalIndex: entry.lineOrdinal - 1,
          traceId: link.traceId,
          eventId: link.eventId,
          message: `Session history links event ${link.eventId} in Trace ${link.traceId}, but its payload is missing.`,
        });
        continue;
      }
      payload.claimed = true;
      if (payload.actualTraceId !== link.traceId) {
        diagnostics.push({
          code: "trace_event_mismatch",
          sessionId,
          journalIndex: entry.lineOrdinal - 1,
          traceId: link.traceId,
          eventId: link.eventId,
          message: `Linked event ${link.eventId} belongs to Trace ${payload.actualTraceId ?? "<missing>"}, not Trace ${link.traceId}.`,
        });
        continue;
      }
      events.push({
        journalOrdinal: entry.lineOrdinal,
        traceId: link.traceId,
        eventId: link.eventId,
        message: payload.message,
      });
    }

    for (const payload of allPayloads) {
      if (payload.claimed) continue;
      payloadDiagnostics.push({
        code: "unlinked_trace_event",
        sessionId,
        traceId: payload.storedTraceId,
        eventId: payload.eventId,
        message: `Event ${payload.eventId} in Trace ${payload.storedTraceId} has no first-winning Session history link.`,
      });
    }
    diagnostics.push(...payloadDiagnostics);
    diagnostics.sort(
      (left, right) =>
        (left.journalIndex ?? Number.MAX_SAFE_INTEGER) -
        (right.journalIndex ?? Number.MAX_SAFE_INTEGER),
    );
    return { supported: true, journal, links, events, diagnostics };
  }

  /** Materializes the chat transcript from the shared journal-link projection. */
  private async readLogicalSessionHistory(
    projectId: string,
    agentId: string,
    sessionId: string,
  ): Promise<LogicalSessionHistory> {
    const projection = await this.readLogicalSessionProjection(projectId, agentId, sessionId);
    if (!projection.supported) {
      return { supported: false, segments: [], diagnostics: [] };
    }

    const events = new Map(
      projection.events.map((event) => [event.journalOrdinal, event.message] as const),
    );
    const segments: LogicalHistorySegment[] = [];
    const seenPointers = new Set<string>();
    for (const entry of projection.journal) {
      const fact = logicalSessionFact(entry.value);
      if (fact !== null) {
        const payload = asRecord(fact.payload);
        if (
          fact.type !== "session_meta" ||
          (payload !== null && payload.session_id === sessionId)
        ) {
          segments.push({ cursorIndex: entry.lineOrdinal, messages: [fact] });
        }
        continue;
      }
      const message = events.get(entry.lineOrdinal);
      if (message === undefined) continue;
      const pointerKey = logicalHistoryPointerKey(message);
      if (pointerKey !== null) {
        if (seenPointers.has(pointerKey)) continue;
        seenPointers.add(pointerKey);
      }
      segments.push({ cursorIndex: entry.lineOrdinal, messages: [message] });
    }
    return {
      supported: true,
      segments,
      diagnostics: projection.diagnostics,
    };
  }

  /** Selects one root from the shared journal-link projection. */
  private logicalTraceRecords(
    projection: LogicalSessionProjection,
    traceId: string,
  ): { raw: OmniMessage[]; explicit: ExplicitV3Record[] } {
    const raw = projection.events
      .filter((event) => event.traceId === traceId)
      .map((event) => event.message);
    const explicit: ExplicitV3Record[] = [];
    for (const message of raw) {
      const record = explicitV3Record(message, traceId);
      if (record !== null) explicit.push(record);
    }
    return { raw: explicit.map((record) => record.message), explicit };
  }

  /** Resolves a child Session through the unified legacy/v3 Session index. */
  private async resolveLogicalChildAgent(
    projectId: string,
    sessionId: string,
    ctx: { projectScanned: boolean },
  ): Promise<string | null> {
    return this.resolveChildAgent(projectId, sessionId, ctx);
  }

  private async logicalTraceSubagents(
    projectId: string,
    records: ExplicitV3Record[],
  ): Promise<TraceRootSubagent[]> {
    const subagents: TraceRootSubagent[] = [];
    const positions = new Map<string, number>();
    for (const record of records) {
      if (record.payload.type !== "subagent") continue;
      const sessionId = nonEmptyString(record.payload.session_id);
      if (sessionId === undefined) continue;
      const envelope = asRecord(record.message)!;
      const eventId = nonEmptyString(envelope.event_id);
      const childTraceId = nonEmptyString(record.payload.trace_id);
      const childTaskId = nonEmptyString(record.payload.task_id);
      const key = `${sessionId}\u0000${record.spanId ?? ""}`;
      const existingPosition = positions.get(key);
      if (existingPosition === undefined) {
        positions.set(key, subagents.length);
        subagents.push({
          sessionId,
          ...(childTraceId !== undefined ? { childTraceId } : {}),
          ...(childTaskId !== undefined ? { childTaskId } : {}),
          ...(record.spanId !== undefined ? { invocationSpanId: record.spanId } : {}),
          ...(eventId !== undefined ? { eventId } : {}),
        });
        continue;
      }
      const existing = subagents[existingPosition]!;
      // Core may first record a session-only pointer and append a refined pointer once
      // the child trace_begin arrives. Preserve the invocation's first position while
      // replacing its navigation target with the most precise later record.
      if (childTraceId !== undefined) existing.childTraceId = childTraceId;
      if (childTaskId !== undefined) existing.childTaskId = childTaskId;
      if (eventId !== undefined && (childTraceId !== undefined || existing.eventId === undefined)) {
        existing.eventId = eventId;
      }
    }

    const resolved = new Map<string, string | null>();
    const resolveCtx = { projectScanned: false };
    for (const subagent of subagents) {
      let agentId = resolved.get(subagent.sessionId);
      if (agentId === undefined) {
        agentId = await this.resolveLogicalChildAgent(projectId, subagent.sessionId, resolveCtx);
        resolved.set(subagent.sessionId, agentId);
      }
      if (agentId !== null) subagent.agentId = agentId;
    }
    return subagents;
  }

  /** Lists protocol-v3 logical roots in Session-journal order; V1/v2 is never inferred. */
  async readRoots(
    projectId: string,
    agentId: string,
    sessionId: string,
  ): Promise<TraceRootsResponse> {
    const projection = await this.readLogicalSessionProjection(projectId, agentId, sessionId);
    if (!projection.supported) {
      return { supported: false, protocolVersion: null, roots: [] };
    }
    const roots: TraceRootSummary[] = [];
    for (const link of projection.links) {
      const records = this.logicalTraceRecords(projection, link.traceId);
      const root = projectLogicalTrace(link, records.explicit).root;
      if (
        projection.diagnostics.some(
          (diagnostic) => diagnostic.traceId === undefined || diagnostic.traceId === link.traceId,
        )
      ) {
        root.partial = true;
      }
      roots.push(root);
    }
    return {
      supported: true,
      protocolVersion: 3,
      roots,
      ...(projection.diagnostics.length > 0 ? { diagnostics: projection.diagnostics } : {}),
    };
  }

  /** Reads one Session-scoped logical root and its explicit Tasks, records, and child links. */
  async readRoot(
    projectId: string,
    agentId: string,
    sessionId: string,
    traceId: string,
  ): Promise<TraceRootResponse> {
    const projection = await this.readLogicalSessionProjection(projectId, agentId, sessionId);
    const link = projection.links.find((candidate) => candidate.traceId === traceId);
    if (!projection.supported || link === undefined) {
      throw new HttpError(
        404,
        "trace_root_not_found",
        `This Session has no explicit protocol-v3 Trace root with id ${traceId}.`,
      );
    }
    const records = this.logicalTraceRecords(projection, traceId);
    const projected = projectLogicalTrace(link, records.explicit);
    const diagnostics = projection.diagnostics.filter(
      (diagnostic) => diagnostic.traceId === undefined || diagnostic.traceId === traceId,
    );
    if (diagnostics.length > 0) projected.root.partial = true;
    return {
      protocolVersion: 3,
      root: projected.root,
      tasks: projected.tasks,
      records: records.raw,
      subagents: await this.logicalTraceSubagents(projectId, records.explicit),
      ...(diagnostics.length > 0 ? { diagnostics } : {}),
    };
  }

  /**
   * All of this Session's Trace files (sorted by index ascending), served from the
   * index. An empty answer force-reconciles once and retries before being believed:
   * disk is the source of truth, and a gate blind spot (a backdated write, or an
   * in-place append, which moves no directory mtime — see trace-index's header) must
   * cost one extra scan, never a false 404. Note this retry only covers a WHOLE-session
   * miss: a session with some shards indexed and a later one missed is served as-is.
   */
  private async locateAll(
    projectId: string,
    agentId: string,
    sessionId: string,
  ): Promise<LocatedFile[]> {
    await this.deps.index.reconcileAgent(projectId, agentId);
    let rows = this.deps.index.repo.listFilesBySession(projectId, agentId, sessionId);
    if (rows.length === 0) {
      await this.deps.index.reconcileAgent(projectId, agentId, { force: true });
      rows = this.deps.index.repo.listFilesBySession(projectId, agentId, sessionId);
    }
    return rows.map((r) => ({
      path: traceFilePath(this.root, r),
      date: r.date,
      index: r.fileIndex,
      sizeBytes: r.sizeBytes,
    }));
  }

  /** All shard reads funnel through here (deps.observeShardRead is the windowed-read tests' proof of which files were touched). */
  private async readShard(path: string): Promise<OmniMessage[]> {
    this.deps.observeShardRead?.(path);
    return readTraceTolerant(path);
  }

  /** Deletes this Session's legacy shards and protocol-v3 bundle; the index rows go with them. */
  async deleteSessionTraces(projectId: string, agentId: string, sessionId: string): Promise<void> {
    const files = await this.locateAll(projectId, agentId, sessionId);
    for (const file of files) {
      await fs.rm(file.path, { force: true });
    }
    await fs.rm(path.join(tracesDir(this.root, projectId, agentId), sessionId), {
      recursive: true,
      force: true,
    });
    this.deps.index.removeSession(projectId, agentId, sessionId);
  }

  /**
   * History messages: all index files concatenated in order, with sub-sessions
   * **expanded in place**.
   *
   * The parent Trace only records a `subagent` pointer event at the spawn point
   * (recording just the child Session id; the content lives in the child
   * Session's own Trace). Here the pointer is used to locate the child Trace
   * within the Project, read it recursively, and splice the child messages —
   * tagged with an origin chain — back in at the pointer's position, so that when
   * the session is reopened, the frontend can re-attach the sub-session to the
   * run_subagent tool card via origin (the child Trace's first `session_meta`,
   * once given an origin, takes the same shape as what's forwarded over the live
   * stream). When expansion succeeds, the pointer event itself is no longer
   * emitted; when the child Trace is missing (deleted), the pointer event is kept
   * so API consumers can still know it existed.
   */
  async readMessagesResult(
    projectId: string,
    agentId: string,
    sessionId: string,
  ): Promise<MessagesReadResult> {
    const ctx: ExpandCtx = {
      projectScanned: false,
      ancestry: new Set([sessionId]),
      depth: 0,
      raw: new Map(),
      logicalHistorySeen: false,
      diagnostics: [],
    };
    const logical = await this.readLogicalSessionHistory(projectId, agentId, sessionId);
    if (logical.supported) {
      noteLogicalHistory(ctx, logical);
      const messages = await this.expandMessages(
        projectId,
        logical.segments.flatMap((segment) => segment.messages),
        ctx,
      );
      return { messages, history: historyInfo(ctx)! };
    }
    const files = await this.locateAll(projectId, agentId, sessionId);
    const out: OmniMessage[] = [];
    for (const file of files) {
      out.push(...(await this.expandMessages(projectId, await this.readShard(file.path), ctx)));
    }
    const history = historyInfo(ctx);
    return { messages: out, ...(history !== undefined ? { history } : {}) };
  }

  /** Backward-compatible service helper for callers that only consume message payloads. */
  async readMessages(
    projectId: string,
    agentId: string,
    sessionId: string,
  ): Promise<OmniMessage[]> {
    return (await this.readMessagesResult(projectId, agentId, sessionId)).messages;
  }

  /**
   * Locates a subagent pointer's owning Agent within the Project: a single index
   * lookup (the old implementation walked EVERY Agent's whole traces tree to build a
   * sessionId → agentId map per readMessages call). On a miss, the whole Project is
   * force-reconciled ONCE per readMessages call and the lookup retried — a child
   * Trace written by an external process is one scan away, never invisible.
   */
  private async resolveChildAgent(
    projectId: string,
    childSid: string,
    ctx: { projectScanned: boolean },
  ): Promise<string | null> {
    const hit = this.deps.index.repo.findAgentBySession(projectId, childSid);
    if (hit !== null || ctx.projectScanned) return hit;
    ctx.projectScanned = true;
    await this.deps.index.reconcileProject(projectId, { force: true });
    return this.deps.index.repo.findAgentBySession(projectId, childSid);
  }

  /** A child Session's v3 transcript or legacy shards, memoized per request. */
  private async readChildRaw(
    projectId: string,
    childSid: string,
    ctx: ExpandCtx,
  ): Promise<OmniMessage[] | null> {
    const cached = ctx.raw.get(childSid);
    if (cached !== undefined) return cached;
    const childAgent = await this.resolveChildAgent(projectId, childSid, ctx);
    let raw: OmniMessage[] | null = null;
    if (childAgent) {
      const logical = await this.readLogicalSessionHistory(projectId, childAgent, childSid);
      if (logical.supported) {
        noteLogicalHistory(ctx, logical);
        raw = logical.segments.flatMap((segment) => segment.messages);
      } else {
        const files = await this.locateAll(projectId, childAgent, childSid);
        if (files.length > 0) {
          raw = [];
          for (const file of files) raw.push(...(await this.readShard(file.path)));
        }
      }
    }
    ctx.raw.set(childSid, raw);
    return raw;
  }

  /**
   * Expand subagent pointers within one message span (the whole transcript on the full
   * path, one window on the paged path — same recursive shape either way).
   */
  private async expandMessages(
    projectId: string,
    messages: readonly OmniMessage[],
    ctx: ExpandCtx,
  ): Promise<OmniMessage[]> {
    const out: OmniMessage[] = [];
    for (const msg of messages) {
      // The depth cap guards against runaway recursion; ancestry guards against a
      // cyclic pointer (a tampered Trace pointing to itself/an ancestor is not expanded).
      const childSid = ctx.depth < MAX_SUBAGENT_DEPTH ? subagentPointer(msg) : null;
      if (!childSid || ctx.ancestry.has(childSid)) {
        out.push(msg);
        continue;
      }
      const raw = await this.readChildRaw(projectId, childSid, ctx);
      let nested: OmniMessage[] = [];
      if (raw !== null) {
        ctx.ancestry.add(childSid);
        nested = await this.expandMessages(projectId, raw, { ...ctx, depth: ctx.depth + 1 });
        ctx.ancestry.delete(childSid);
      }
      // Child Trace missing (deleted): keep the pointer event, since the sub-session's content can't be recovered.
      if (nested.length === 0) {
        out.push(msg);
        continue;
      }
      for (const m of nested) out.push({ ...m, origin: [childSid, ...(m.origin ?? [])] });
    }
    return out;
  }

  /**
   * A subagent pointer's subtree aggregate for the window scanner (message-window.ts):
   * descendant token_usage request totals plus the subtree's max timestamp — the same
   * contributions the expanded messages make to the Web's parent-level stats tracker.
   * The recursion mirrors expandMessages' depth/ancestry rules exactly, so an
   * unexpandable pointer contributes nothing on both paths.
   */
  private async aggregateChild(
    projectId: string,
    childSid: string,
    ctx: ExpandCtx,
  ): Promise<ChildAggregate | null> {
    if (ctx.depth >= MAX_SUBAGENT_DEPTH || ctx.ancestry.has(childSid)) return null;
    const raw = await this.readChildRaw(projectId, childSid, ctx);
    if (raw === null || raw.length === 0) return null;
    let requestTokens = 0;
    let maxTsMs: number | null = null;
    ctx.ancestry.add(childSid);
    for (const msg of raw) {
      const ms = Date.parse(msg.timestamp);
      if (Number.isFinite(ms) && (maxTsMs === null || ms > maxTsMs)) maxTsMs = ms;
      const p = msg.payload as { type?: string; request?: { total?: number } };
      if (msg.type === "event_msg" && p.type === "token_usage") {
        requestTokens += typeof p.request?.total === "number" ? p.request.total : 0;
        continue;
      }
      const grandchild = subagentPointer(msg);
      if (grandchild !== null) {
        const agg = await this.aggregateChild(projectId, grandchild, {
          ...ctx,
          depth: ctx.depth + 1,
        });
        if (agg !== null) {
          requestTokens += agg.requestTokens;
          if (agg.maxTsMs !== null && (maxTsMs === null || agg.maxTsMs > maxTsMs)) {
            maxTsMs = agg.maxTsMs;
          }
        }
      }
    }
    ctx.ancestry.delete(childSid);
    return { requestTokens, maxTsMs };
  }

  /**
   * End-of-shard scan states for files[0..upto] (cumulative from the transcript's
   * beginning), served from the trace_files.page_stats cache. A missing/stale record
   * costs one read of THAT shard — once ever: every shard here is immutable (rotation
   * opens a new shard; the newest shard never appears in a prefix, because windows are
   * suffixes and their first shard is always read anyway). The write-back is guarded on
   * the indexed size, so an externally rewritten shard can only invalidate, never
   * poison, the cache.
   */
  private async prefixStates(
    projectId: string,
    agentId: string,
    sessionId: string,
    files: LocatedFile[],
    upto: number,
    ctx: ExpandCtx,
  ): Promise<ScanState[]> {
    const states: ScanState[] = [];
    for (let j = 0; j <= upto; j++) {
      const file = files[j]!;
      const cached = deserializePrefix(
        this.deps.index.repo.getPageStats(projectId, agentId, sessionId, file.index),
      );
      if (cached !== null) {
        states.push(cached);
        continue;
      }
      const state = cloneScanState(j === 0 ? initialScanState() : states[j - 1]!);
      const messages = await this.readShard(file.path);
      await scanMessages(
        state,
        messages,
        () => {},
        (sid) => this.aggregateChild(projectId, sid, ctx),
      );
      this.deps.index.repo.setPageStats(
        projectId,
        agentId,
        sessionId,
        file.index,
        file.sizeBytes,
        serializePrefix(state),
      );
      states.push(state);
    }
    return states;
  }

  /**
   * Correctness-first v3 paging. Cursor `fileIndex` is the 1-based source-record
   * ordinal in session.jsonl, preserving the existing numeric `<index>:<ordinal>` wire
   * shape while remaining stable under append-only journal growth.
   */
  private async readLogicalMessagesPage(
    projectId: string,
    sessionId: string,
    history: LogicalSessionHistory,
    req: MessagesPageRequest,
  ): Promise<MessagesPageResult> {
    const ctx: ExpandCtx = {
      projectScanned: false,
      ancestry: new Set([sessionId]),
      depth: 0,
      raw: new Map(),
      logicalHistorySeen: false,
      diagnostics: [],
    };
    noteLogicalHistory(ctx, history);
    const empty = (): MessagesPageResult => ({
      messages: [],
      prior: initialScanState().totals,
      history: historyInfo(ctx)!,
    });
    const segments = history.segments;
    if (segments.length === 0) return empty();

    let endPos: number;
    let endOrdinal: number | null = null;
    if (req.kind === "tail") {
      endPos = segments.length - 1;
    } else {
      endPos = segments.findIndex((segment) => segment.cursorIndex === req.cursor.fileIndex);
      if (endPos < 0) return empty();
      endOrdinal = req.cursor.ordinal;
    }

    // v3 roots are appendable and have no trace_files cache rows. Replay prefix state
    // from the explicit journal order for now; the child/raw memo keeps recursive reads
    // bounded within this request.
    const prefixes: ScanState[] = [];
    for (let pos = 0; pos < endPos; pos += 1) {
      const state = cloneScanState(pos === 0 ? initialScanState() : prefixes[pos - 1]!);
      await scanMessages(
        state,
        segments[pos]!.messages,
        () => {},
        (sid) => this.aggregateChild(projectId, sid, ctx),
      );
      prefixes.push(state);
    }

    let boundaries: Array<{ pos: number; ordinal: number; stats: WindowPriorStats }> = [];
    let startPos = endPos + 1;
    while (boundaries.length <= req.limit && startPos > 0) {
      startPos -= 1;
      const messages = segments[startPos]!.messages;
      const state = cloneScanState(startPos === 0 ? initialScanState() : prefixes[startPos - 1]!);
      const segmentBoundaries: Array<{
        pos: number;
        ordinal: number;
        stats: WindowPriorStats;
      }> = [];
      const to = startPos === endPos && endOrdinal !== null ? endOrdinal : messages.length;
      await scanMessages(
        state,
        messages,
        (ordinal, stats) => segmentBoundaries.push({ pos: startPos, ordinal, stats }),
        (sid) => this.aggregateChild(projectId, sid, ctx),
        0,
        Math.min(to, messages.length),
      );
      boundaries = [...segmentBoundaries, ...boundaries];
    }

    let start: { pos: number; ordinal: number };
    let before: string | undefined;
    let prior: WindowPriorStats;
    if (boundaries.length > req.limit) {
      const boundary = boundaries[boundaries.length - req.limit]!;
      start = { pos: boundary.pos, ordinal: boundary.ordinal };
      before = encodeCursor({
        fileIndex: segments[boundary.pos]!.cursorIndex,
        ordinal: boundary.ordinal,
      });
      prior = boundary.stats;
    } else {
      start = { pos: 0, ordinal: 0 };
      prior = initialScanState().totals;
    }

    const windowRaw: OmniMessage[] = [];
    for (let pos = start.pos; pos <= endPos; pos += 1) {
      const messages = segments[pos]!.messages;
      const from = pos === start.pos ? start.ordinal : 0;
      const to =
        pos === endPos && endOrdinal !== null
          ? Math.min(endOrdinal, messages.length)
          : messages.length;
      for (let ordinal = from; ordinal < to; ordinal += 1) {
        windowRaw.push(messages[ordinal]!);
      }
    }
    const expanded = await this.expandMessages(projectId, windowRaw, ctx);
    return {
      messages: expanded,
      ...(before !== undefined ? { before } : {}),
      prior,
      history: historyInfo(ctx)!,
    };
  }

  /**
   * Windowed history read (the `tailLimit` / `before` forms of GET /messages). The
   * window is a run of whole units — cut points and unit semantics live in
   * message-window.ts — assembled by reading ONLY the shards the window overlaps
   * (plus, once ever per old shard, the prefix-cache backfill above). Subagent
   * pointers are expanded exactly as the full path expands them, but only within the
   * window: children referenced by older windows load when those windows do.
   */
  async readMessagesPage(
    projectId: string,
    agentId: string,
    sessionId: string,
    req: MessagesPageRequest,
  ): Promise<MessagesPageResult> {
    const empty = (): MessagesPageResult => ({
      messages: [],
      prior: initialScanState().totals,
    });
    const logical = await this.readLogicalSessionHistory(projectId, agentId, sessionId);
    if (logical.supported) {
      return this.readLogicalMessagesPage(projectId, sessionId, logical, req);
    }

    const files = await this.locateAll(projectId, agentId, sessionId);
    if (files.length === 0) return empty();
    const ctx: ExpandCtx = {
      projectScanned: false,
      ancestry: new Set([sessionId]),
      depth: 0,
      raw: new Map(),
      logicalHistorySeen: false,
      diagnostics: [],
    };

    // The window's exclusive end: the newest shard's end (tail), or the cursor (before).
    let endPos: number;
    let endOrdinal: number | null = null; // null = to the shard's end
    if (req.kind === "tail") {
      endPos = files.length - 1;
    } else {
      endPos = files.findIndex((f) => f.index === req.cursor.fileIndex);
      // Cursor shard no longer on disk (external deletion — locateAll already
      // force-retried): the history it pointed into is gone; report end-of-history
      // rather than a guess at what used to precede it.
      if (endPos < 0) return empty();
      endOrdinal = req.cursor.ordinal;
    }

    const prefixes = await this.prefixStates(projectId, agentId, sessionId, files, endPos - 1, ctx);

    // Walk backward from the end, scanning whole shards (each from its cached carry-in)
    // until the window has more units than requested or the beginning is reached.
    const shardMessages = new Map<number, OmniMessage[]>();
    let boundaries: Array<{ pos: number; ordinal: number; stats: WindowPriorStats }> = [];
    let startPos = endPos + 1;
    while (boundaries.length <= req.limit && startPos > 0) {
      startPos -= 1;
      const messages = await this.readShard(files[startPos]!.path);
      shardMessages.set(startPos, messages);
      const state = cloneScanState(startPos === 0 ? initialScanState() : prefixes[startPos - 1]!);
      const shardBoundaries: Array<{ pos: number; ordinal: number; stats: WindowPriorStats }> = [];
      const to = startPos === endPos && endOrdinal !== null ? endOrdinal : messages.length;
      await scanMessages(
        state,
        messages,
        (ordinal, stats) => shardBoundaries.push({ pos: startPos, ordinal, stats }),
        (sid) => this.aggregateChild(projectId, sid, ctx),
        0,
        Math.min(to, messages.length),
      );
      boundaries = [...shardBoundaries, ...boundaries];
    }

    // Window start: the last `limit` units, or the very beginning (preamble included)
    // when the whole remaining history fits — then there is no `before` cursor.
    let start: { pos: number; ordinal: number };
    let before: string | undefined;
    let prior: WindowPriorStats;
    if (boundaries.length > req.limit) {
      const wb = boundaries[boundaries.length - req.limit]!;
      start = { pos: wb.pos, ordinal: wb.ordinal };
      before = encodeCursor({ fileIndex: files[wb.pos]!.index, ordinal: wb.ordinal });
      prior = wb.stats;
    } else {
      start = { pos: 0, ordinal: 0 };
      prior = initialScanState().totals;
    }

    const windowRaw: OmniMessage[] = [];
    for (let pos = start.pos; pos <= endPos; pos++) {
      const messages = shardMessages.get(pos) ?? (await this.readShard(files[pos]!.path));
      const from = pos === start.pos ? start.ordinal : 0;
      const to =
        pos === endPos && endOrdinal !== null
          ? Math.min(endOrdinal, messages.length)
          : messages.length;
      for (let i = from; i < to; i++) windowRaw.push(messages[i]!);
    }
    const expanded = await this.expandMessages(projectId, windowRaw, ctx);
    const history = historyInfo(ctx);
    return {
      messages: expanded,
      ...(before !== undefined ? { before } : {}),
      prior,
      ...(history !== undefined ? { history } : {}),
    };
  }

  /** List of Trace files (index / date / size / mtime). */
  async listTraceFiles(
    projectId: string,
    agentId: string,
    sessionId: string,
  ): Promise<TraceFileInfo[]> {
    const files = await this.locateAll(projectId, agentId, sessionId);
    const out: TraceFileInfo[] = [];
    for (const file of files) {
      const stat = await fs.stat(file.path);
      out.push({
        index: file.index,
        date: file.date,
        sizeBytes: stat.size,
        mtime: stat.mtime.toISOString(),
      });
    }
    return out;
  }

  /** Reads events from the Trace file at the given index, paginated by line (for loading large files in pages). */
  async readEvents(
    projectId: string,
    agentId: string,
    sessionId: string,
    index: number,
    offset: number,
    limit: number,
  ): Promise<TraceEventsResponse> {
    const messages = await this.readFileByIndex(projectId, agentId, sessionId, index);
    return {
      events: messages.slice(offset, offset + limit),
      offset,
      limit,
      total: messages.length,
    };
  }

  /** Lists explicitly recorded ReAct Turns in one shard without applying legacy heuristics. */
  async readTurns(
    projectId: string,
    agentId: string,
    sessionId: string,
    index: number,
  ): Promise<TraceTurnsResponse> {
    return explicitTurnSummaries(await this.readFileByIndex(projectId, agentId, sessionId, index));
  }

  /** Reads all protocol-v2 records for one explicitly recorded ReAct Turn. */
  async readTurn(
    projectId: string,
    agentId: string,
    sessionId: string,
    index: number,
    turnId: string,
  ): Promise<TraceTurnResponse> {
    const records = await this.readFileByIndex(projectId, agentId, sessionId, index);
    const turn = explicitTurnSummaries(records).turns.find(
      (candidate) => candidate.turnId === turnId,
    );
    if (turn === undefined) {
      throw new HttpError(
        404,
        "trace_turn_not_found",
        `This Trace file has no explicit Turn with id ${turnId}.`,
      );
    }
    const turnRecords = records.filter(
      (message) => explicitTraceRecord(message)?.turnId === turnId,
    );
    const subagents: TraceTurnSubagent[] = [];
    const seenSubagents = new Set<string>();
    const resolveCtx = { projectScanned: false };
    for (const message of turnRecords) {
      const childSessionId = subagentPointer(message);
      if (childSessionId === null || seenSubagents.has(childSessionId)) continue;
      seenSubagents.add(childSessionId);
      const childAgentId = await this.resolveChildAgent(projectId, childSessionId, resolveCtx);
      if (childAgentId !== null) {
        subagents.push({ sessionId: childSessionId, agentId: childAgentId });
      }
    }
    return {
      protocolVersion: 2,
      turn,
      records: turnRecords,
      subagents,
    };
  }

  /** Performance analysis: derived from a single Trace file. */
  async analyze(
    projectId: string,
    agentId: string,
    sessionId: string,
    index: number,
  ): Promise<TraceAnalysisResponse> {
    const messages = await this.readFileByIndex(projectId, agentId, sessionId, index);

    const requests: RequestSpan[] = [];
    let openRequest: RequestSpan | null = null;
    const toolCalls: ToolCallSpan[] = [];
    const openToolCalls = new Map<string, ToolCallSpan>();
    let reconnectCount = 0;
    let compactionCount = 0;
    const usageTrend: UsageTrendPointInTrace[] = [];
    // Timeline (serial-duration estimation): Trace records completion times; model
    // messages are produced
    // serially (autoregressive decoding), so each segment's start = the previous
    // event's time (the request's first segment = request_begin); a tool's
    // approval/execution runs in parallel with model decoding, on its own lane;
    // prevSerialTs is cleared after request_end, and the next request_begin
    // restarts the count (which presumes all of the previous round's
    // tool_call_output have already come back).
    const modelSegments: TraceModelSegment[] = [];
    const toolSpans: TraceToolSpan[] = [];
    const otherSpans: TraceOtherSpan[] = [];
    const openSpansById = new Map<string, TraceToolSpan>();
    // Open mcp_connect_begin (first-run MCP connect + discovery), closed by its end event
    // into a synthetic tool span so the timeline shows the wait ahead of the next Task.
    let openMcpConnect: { beginTs: string } | null = null;
    let prevSerialTs: string | null = null;
    // Task grouping: one user turn contains multiple Request rounds (the Agent
    // loop sends another round each time it calls a tool); the turn ends once the
    // model produces only text with no further tool call. Consecutive Requests are
    // merged into one Task on this basis, and each Task gets its own independent
    // timeline — different Tasks can be far apart in time (the user is thinking or
    // has stepped away), and sharing one timeline would leave large gaps.
    // Compaction forms its own turn: both compaction_begin/compaction_end break a
    // continuation, so the compaction request becomes its own Task, and the
    // request that resumes after compaction starts yet another Task.
    let taskIndex = -1;
    let continuation = false; // The previous round's Request called a tool -> the next request_begin continues the same Task
    /** Inside the image run that follows a `[user_steering]` text (see the turn-start rule below). */
    let steeringImages = false;
    let sawToolCallThisRequest = false;
    // Compaction interval (compaction_begin..compaction_end): the compaction
    // request's request_begin/request_end and token_usage all fall inside it (see
    // core context-engine's summarize flow), which is used to exclude the
    // compaction request entirely from TPS — matching the same convention as
    // compactionActive in the Chat page's task-stats.
    let compactionActive = false;
    // Token / duration totals per Task (computed server-side over the whole file:
    // frontend events are fetched in pages, so summing them there would be
    // mismatched).
    const taskStats = new Map<number, TraceTaskStats>();
    const ensureTask = (ti: number): TraceTaskStats => {
      let t = taskStats.get(ti);
      if (t === undefined) {
        t = {
          taskIndex: ti,
          messageFrom: -1,
          messageTo: -1,
          startTs: "",
          endTs: "",
          tokens: { cacheRead: 0, cacheWrite: 0, output: 0 },
          llmMs: 0,
        };
        taskStats.set(ti, t);
      }
      return t;
    };

    /**
     * Which turn each message belongs to: **decided definitively in one
     * sequential pass**, not left for the frontend to guess by timestamp.
     *
     * Timestamp boundaries can't be pulled apart — the same millisecond can
     * contain "the previous turn's last reply, compaction_begin, the compaction
     * prompt, and the next turn's request_begin" all at once, so assigning by
     * time would inevitably misfile this turn's reply into the next turn.
     *
     * Rule (a turn = one user turn; `request_end` is the end of some Request
     * within a turn):
     *   - The **starting marker** of a new turn: the main session's user Prompt
     *     (outside compaction), or compaction_begin (compaction forms its own
     *     turn). Messages after the marker and before that turn's first
     *     `request_begin` (subsequent images from a multi-image send, the
     *     compaction prompt) are always held pending, waiting for
     *     `request_begin` to settle the new taskIndex before the whole span is
     *     assigned at once — they belong to the **new** turn, not the tail of
     *     the previous one.
     *   - Other messages belong to the current taskIndex: tool output and
     *     approval decisions arriving after request_end still belong to this
     *     turn (they're the results of tools this turn's Request initiated).
     */
    const msgTask: number[] = new Array<number>(messages.length).fill(-1);
    /** The pending new turn's starting point (message index); settled once request_begin determines the taskIndex. */
    let pendingFrom: number | null = null;

    for (let mi = 0; mi < messages.length; mi++) {
      const msg = messages[mi]!;
      const p = msg.payload as Record<string, unknown> & { type?: string };
      // The timeline only looks at the main session (a Trace itself never contains origin messages; this is a defensive skip).
      const hasOrigin = msg.origin !== undefined && msg.origin.length > 0;

      // Starting marker of a new turn: the main session's user Prompt (outside
      // compaction) -> a new user turn; compaction_begin -> a compaction turn
      // (compaction forms its own turn). A single send can be "text + multiple
      // images" = multiple messages; only the **first** one counts (once
      // pendingFrom is set, it's not changed again), otherwise the turn's start
      // would shift to the last image.
      // Mid-run steering (`[user_steering]`-wrapped user text, delivered between turns of a
      // running Task): never a turn starter — same exclusion idea as the compaction summary —
      // and it forces the next request to be a continuation (a steering-only continuation
      // turn has no preceding tool call, but it is still the same Task).
      const isSteeringText =
        !hasOrigin &&
        msg.type === "model_msg" &&
        p.type === "text" &&
        p.role === "user" &&
        typeof p.text === "string" &&
        parseUserSteeringText(p.text) !== null;
      if (isSteeringText) continuation = true;
      // Images sent with a steering message ride immediately behind its text, exactly as a
      // Prompt's images ride behind theirs — and they inherit its exclusion: still the same
      // Task, so `steeringImages` keeps the window open across the whole run of them and
      // anything else on the main session closes it (an images-only Prompt after a steering
      // message is a genuine new turn). A subagent's messages pass through without closing it:
      // they belong to another session's stream and say nothing about this one's grouping.
      // The Web answers the same "what is one Task" question over the live stream — see
      // `openSteering` in web/src/lib/omni/stream-model.ts; the two need to stay in step.
      const isImage = !hasOrigin && msg.type === "model_msg" && p.type === "image_url";
      if (!hasOrigin && !isSteeringText && !(isImage && steeringImages)) steeringImages = false;
      if (isSteeringText) steeringImages = true;
      const startsUserTurn =
        !hasOrigin &&
        !compactionActive &&
        !isSteeringText &&
        !steeringImages &&
        msg.type === "model_msg" &&
        ((p.type === "text" && p.role === "user") || p.type === "image_url");
      const startsCompactionTurn =
        !hasOrigin && msg.type === "event_msg" && p.type === "compaction_begin";
      if (startsUserTurn || startsCompactionTurn) {
        if (pendingFrom === null) pendingFrom = mi;
        // A user Prompt **always starts a new turn**: judging continuation solely
        // by "did the previous turn call a tool" isn't enough — if the previous
        // turn ended in a retryable status (given up after exhausting retries),
        // retryable would leave continuation at true, and this new message would
        // get merged into that failed turn, smearing the two turns' messages /
        // Tokens / TPS / duration together.
        if (startsUserTurn) continuation = false;
      }
      // A main-session message that isn't pending belongs to the current turn immediately (taskIndex < 0 = before the first request_begin, e.g. session_meta).
      if (!hasOrigin && pendingFrom === null) msgTask[mi] = taskIndex;

      if (msg.type === "event_msg") {
        if (p.type === "request_begin") {
          if (!hasOrigin) {
            prevSerialTs = msg.timestamp;
            if (!continuation) taskIndex++; // Not a continuation -> a new Task
            sawToolCallThisRequest = false;
          }
          // Settle taskIndex before opening the span: the span belongs directly to
          // the current Task. Nearest-neighbor pairing: if the previous begin was
          // never closed (process exited mid-run), the span is left open.
          openRequest = { beginTs: msg.timestamp, taskIndex };
          if (compactionActive) openRequest.compaction = true;
          requests.push(openRequest);
          if (!hasOrigin) {
            const t = ensureTask(taskIndex);
            if (compactionActive) t.compaction = true; // This turn is a compaction turn
            // This turn's duration starts at the first request_begin. It doesn't
            // use the timestamp of the user Prompt / compaction summary or other
            // user text: `[context_summary]` is created during compaction but only
            // written to disk on the next run, so resuming the next day would
            // stretch the first turn out by a whole day for no reason; the Prompt
            // to request-dispatch gap is only ever milliseconds anyway.
            if (t.startTs === "") t.startTs = msg.timestamp;
            // The new turn's taskIndex is only settled here: the pending span
            // (user Prompt / multiple images / compaction prompt) is assigned in
            // full to **this** turn — they're the start of the new turn, not the
            // tail of the previous one.
            if (pendingFrom !== null) {
              for (let k = pendingFrom; k < mi; k++) {
                if (messages[k]!.origin === undefined) msgTask[k] = taskIndex;
              }
              pendingFrom = null;
            }
            msgTask[mi] = taskIndex;
          }
        } else if (p.type === "approval_decision") {
          if (!hasOrigin && typeof p.tool_call_id === "string") {
            const span = openSpansById.get(p.tool_call_id);
            if (span && span.approvalTs === undefined) {
              span.approvalTs = msg.timestamp;
              if (typeof p.decision === "string") span.decision = p.decision;
              // Approval wait time is subtracted out of the LLM generation
              // duration: core does `await approve(tc)` inside the streaming loop,
              // so the entire manual wait sits between request_begin and
              // request_end (see RequestSpan.approvalWaitMs). Without subtracting
              // it, "5s generation + 55s approval wait" would show 100 tok/s as 8 tok/s.
              if (openRequest) {
                const wait = Date.parse(msg.timestamp) - Date.parse(span.callTs);
                if (Number.isFinite(wait) && wait > 0) {
                  openRequest.approvalWaitMs = (openRequest.approvalWaitMs ?? 0) + wait;
                }
              }
            }
          }
        } else if (p.type === "request_end") {
          const status = typeof p.status === "string" ? p.status : undefined;
          // A status core reconnects on within the same run (context-engine's retry
          // loop) leaves the resent Request in **the same user turn**: it must
          // continue the turn, otherwise a single blip would split that turn's
          // Tokens/duration/TPS across two Tasks and inflate the Task count.
          //
          // This list must track the engine's, and the engine's differs by loop:
          // the turn loop retries `failed` too, while compaction deliberately fails
          // fast and stops on it (core's TURN_RETRY_STATUSES vs
          // COMPACTION_RETRY_STATUSES). Hence the compactionActive guard — a failed
          // compaction request really is the end of that request, and counting it
          // as a reconnect would invent an attempt that never happened.
          const retryable =
            status === "timeout" ||
            status === "malformed" ||
            (status === "failed" && !compactionActive);
          if (!hasOrigin) {
            prevSerialTs = null;
            continuation = sawToolCallThisRequest || retryable;
          }
          if (retryable) reconnectCount++;
          if (openRequest) {
            openRequest.endTs = msg.timestamp;
            const dur = Date.parse(msg.timestamp) - Date.parse(openRequest.beginTs);
            if (Number.isFinite(dur)) {
              openRequest.durationMs = dur;
              openRequest.activeMs = Math.max(0, dur - (openRequest.approvalWaitMs ?? 0));
            }
            if (status !== undefined) openRequest.status = status;
            // TPS denominator: accumulated per the turn a Request belongs to. A
            // compaction request counts too — it belongs to **its own compaction
            // turn** (compaction forms its own turn), so it neither pollutes a
            // user turn's TPS, nor does the compaction turn fail to report its own
            // generation speed accurately. A failed retry's duration is counted as
            // well — it belongs to the same turn as the retry that eventually
            // succeeded, and "how long this turn took to produce these tokens"
            // should include the retries by definition.
            if (!hasOrigin && openRequest.activeMs !== undefined) {
              ensureTask(openRequest.taskIndex).llmMs += openRequest.activeMs;
            }
            openRequest = null;
          }
        } else if (p.type === "mcp_connect_begin") {
          if (!hasOrigin) openMcpConnect = { beginTs: msg.timestamp };
        } else if (p.type === "mcp_connect_end") {
          // The connect pair becomes an "other" span (not a tool span — nothing was
          // called) attached to the FOLLOWING Task (taskIndex + 1: Task 0 at file start;
          // after an in-file resume, the next Task), so the timeline renders the
          // pre-request connect wait inside that Task's group under its own lane.
          if (!hasOrigin && openMcpConnect) {
            const q = p as { status?: string };
            const failed = q.status !== "completed";
            otherSpans.push({
              key: `mcp-connect-${openMcpConnect.beginTs}`,
              name: "mcp connect",
              startTs: openMcpConnect.beginTs,
              endTs: msg.timestamp,
              taskIndex: taskIndex + 1,
              ...(failed ? { failed: true } : {}),
            });
            openMcpConnect = null;
          }
        } else if (p.type === "compaction_begin") {
          compactionCount++;
          // Compaction forms its own turn: otherwise, if the previous turn called
          // a tool, continuation would still be true and the compaction request
          // would get merged into the previous Task.
          if (!hasOrigin) {
            continuation = false;
            compactionActive = true;
          }
        } else if (p.type === "compaction_end") {
          // Both ends of compaction break a continuation. This closing one can't
          // be skipped: if the compaction request itself exhausts its retries and
          // ends in timeout, the retryable check above would mark it as "continued",
          // and without clearing it here, the next user turn after compaction
          // would get merged into this compaction Task.
          if (!hasOrigin) {
            continuation = false;
            compactionActive = false;
          }
        } else if (p.type === "token_usage") {
          const request = p.request as
            | { total?: number; cache_read?: number; cache_write?: number; output?: number }
            | undefined;
          const session = p.session as { total?: number } | undefined;
          usageTrend.push({
            ts: msg.timestamp,
            requestTotal: request?.total ?? 0,
            sessionTotal: session?.total ?? 0,
          });
          if (!hasOrigin) {
            const t = ensureTask(taskIndex);
            // Cumulative usage for this turn (a running total): those tokens were
            // actually paid for, so the cost can't be dropped. `tokens.output` also
            // doubles as the numerator for output TPS — compaction's output
            // belongs to **its own compaction turn** (compaction forms its own
            // turn), so a user turn's TPS isn't polluted by it, while the
            // compaction turn can still accurately report "how fast the summary
            // was generated".
            t.tokens.cacheRead += request?.cache_read ?? 0;
            t.tokens.cacheWrite += request?.cache_write ?? 0;
            t.tokens.output += request?.output ?? 0;
            if (!compactionActive) {
              // The context snapshot only takes non-compaction Requests: tokens
              // consumed by compaction aren't the post-compaction context
              // footprint. A later write overwrites an earlier one -> this
              // naturally leaves behind the snapshot of the Task's **last**
              // non-compaction Request = the context footprint at the end of this
              // turn. Accumulating would be wrong: each Request's input carries
              // the entire history afresh (see TraceTaskStats).
              t.context = {
                cacheRead: request?.cache_read ?? 0,
                cacheWrite: request?.cache_write ?? 0,
                output: request?.output ?? 0,
              };
            }
          }
        }
        continue;
      }
      if (msg.type !== "model_msg") continue;
      // Model serial segments: assistant-side thinking/text/tool_call (a user input sent instantaneously occupies no segment).
      if (
        !hasOrigin &&
        prevSerialTs !== null &&
        (p.type === "thinking" ||
          p.type === "tool_call" ||
          (p.type === "text" && p.role === "assistant"))
      ) {
        const segment: TraceModelSegment = {
          kind: p.type === "thinking" ? "thinking" : p.type === "tool_call" ? "tool_call" : "text",
          startTs: prevSerialTs,
          endTs: msg.timestamp,
          taskIndex,
        };
        if (p.type === "tool_call" && typeof p.tool_call_id === "string") {
          segment.toolCallId = p.tool_call_id;
          if (typeof p.name === "string") segment.name = p.name;
        }
        modelSegments.push(segment);
        prevSerialTs = msg.timestamp;
      }
      if (p.type === "tool_call" && typeof p.tool_call_id === "string") {
        if (!hasOrigin) sawToolCallThisRequest = true; // This turn called a tool -> the next turn continues the same Task
        const callStop = typeof p.stop_reason === "string" ? p.stop_reason : undefined;
        const span: ToolCallSpan = {
          toolCallId: p.tool_call_id,
          name: typeof p.name === "string" ? p.name : "",
          startTs: msg.timestamp,
        };
        if (callStop !== undefined) span.stopReason = callStop;
        openToolCalls.set(p.tool_call_id, span);
        toolCalls.push(span);
        // The timeline lane only accepts calls that "will actually be executed":
        // an interrupt-compensation tool_call (stop_reason other than completed)
        // never gets an approval/output, and putting it on a lane would render as
        // a phantom "executing" state spanning the whole timeline — so it's
        // skipped outright.
        if (!hasOrigin && (callStop === undefined || callStop === "completed")) {
          const timeline: TraceToolSpan = {
            toolCallId: p.tool_call_id,
            name: typeof p.name === "string" ? p.name : "",
            callTs: msg.timestamp,
            taskIndex,
          };
          openSpansById.set(p.tool_call_id, timeline);
          toolSpans.push(timeline);
        }
      } else if (p.type === "tool_call_output" && typeof p.tool_call_id === "string") {
        const span = openToolCalls.get(p.tool_call_id);
        if (span && span.endTs === undefined) {
          span.endTs = msg.timestamp;
          const dur = Date.parse(msg.timestamp) - Date.parse(span.startTs);
          if (Number.isFinite(dur)) span.durationMs = dur;
          if (typeof p.stop_reason === "string") span.stopReason = p.stop_reason;
        }
        const timeline = openSpansById.get(p.tool_call_id);
        if (timeline && timeline.outputTs === undefined) {
          timeline.outputTs = msg.timestamp;
          if (typeof p.stop_reason === "string") timeline.stopReason = p.stop_reason;
        }
      }
    }

    // A pending span that never got a request_begin (interrupted right after the
    // user sent it / the process exited): it's a turn that never got to run,
    // and forms its own turn — reattaching it to the previous turn would smear
    // two separate user sends together.
    if (pendingFrom !== null) {
      taskIndex++;
      for (let k = pendingFrom; k < messages.length; k++) {
        if (messages[k]!.origin === undefined) msgTask[k] = taskIndex;
      }
      ensureTask(taskIndex);
    }

    // Each turn's message index range and end-of-turn time are always derived from
    // the per-message assignment done above (same source, so they never disagree
    // with each other). Messages before the first request_begin (session_meta)
    // have taskIndex -1 and are assigned to the first turn, otherwise they'd have
    // nowhere to sit on the page. The turn duration's **starting point** isn't
    // decided here — it was already settled at request_begin (duration only looks
    // at LLM requests; timestamps of the user Prompt / compaction summary or other
    // user text don't participate, see TraceTaskStats.startTs).
    const firstTask = [...taskStats.keys()].sort((a, b) => a - b)[0];
    for (let k = 0; k < messages.length; k++) {
      let ti = msgTask[k]!;
      if (ti < 0) {
        if (firstTask === undefined) continue;
        ti = firstTask;
        msgTask[k] = ti;
      }
      const t = ensureTask(ti);
      if (t.messageFrom < 0 || k < t.messageFrom) t.messageFrom = k;
      if (k > t.messageTo) t.messageTo = k;
      // session_meta is only **listed** in the first turn, and doesn't count
      // toward the end-of-turn time: it's metadata written when the session was
      // created, and its timestamp has nothing to do with this turn (it also gets
      // rewritten verbatim at the start of a new file after compaction splits the file).
      if (messages[k]!.type === "session_meta") continue;
      const ts = messages[k]!.timestamp;
      if (t.endTs === "" || ts > t.endTs) t.endTs = ts;
    }

    const tasks = [...taskStats.values()].sort((a, b) => a.taskIndex - b.taskIndex);
    // Total elapsed time = **the sum of each turn's duration**, matching exactly
    // the scope shown per-turn below (**including compaction turns** — their wall
    // clock time genuinely elapsed, each turn's card has its own duration, and the
    // overall total is their sum, so the numbers must add up). It is not "last
    // message timestamp minus first message timestamp": that would be the whole
    // file's wall-clock span, counting in the gaps **between** turns (the user
    // thinking, stepping out for coffee, coming back the next day) — none of which
    // is time the Agent spent working. A degenerate turn with no Request has an
    // empty startTs and counts as 0.
    // Note this uses a different convention from the Session's cumulative elapsed
    // time on the Chat page: that one only accumulates user turns (compaction
    // after a turn ends doesn't count toward the turn).
    const elapsedMs = tasks.reduce((sum, t) => {
      const span = Date.parse(t.endTs) - Date.parse(t.startTs);
      return sum + (Number.isFinite(span) ? Math.max(0, span) : 0);
    }, 0);
    return {
      elapsedMs,
      requests,
      tasks,
      toolCalls,
      modelSegments,
      toolSpans,
      otherSpans,
      reconnectCount,
      compactionCount,
      usageTrend,
    };
  }

  /**
   * Agent-level browsing, served from the trace-file index (one mtime-gated reconcile,
   * then pure DB — no directory walks, no head-reads). Without `paging`: the legacy full
   * drill-down (newest first: Agent -> date -> Session -> Trace files; sizes are the
   * index's last observed values). With `paging`: session-group-centric — Sessions
   * ordered by id descending (ids embed a timestamp, so that is reverse chronological),
   * optionally filtered to one sidebar `category`, CLI-origin Sessions excluded unless
   * `includeCli` (the "show CLI sessions" preference; the legacy shape is never
   * filtered — back-compat), and only the returned slice gets per-file `fs.stat` for
   * fresh sizes (written back to the index).
   */
  async agentTraces(
    projectId: string,
    agentId: string,
    paging?: { offset: number; limit: number } | null,
    opts: { category?: SessionCategory; includeCli?: boolean } = {},
  ): Promise<AgentTracesResponse> {
    await this.deps.index.reconcileAgent(projectId, agentId);
    const files = this.deps.index.repo.listFilesByAgent(projectId, agentId);
    if (paging) return this.agentTracesPage(projectId, agentId, files, paging, opts);
    const byDate = new Map<string, Map<string, { index: number; sizeBytes: number }[]>>();
    for (const f of files) {
      const sessions =
        byDate.get(f.date) ?? new Map<string, { index: number; sizeBytes: number }[]>();
      const list = sessions.get(f.sessionId) ?? [];
      list.push({ index: f.fileIndex, sizeBytes: f.sizeBytes });
      sessions.set(f.sessionId, list);
      byDate.set(f.date, sessions);
    }
    return {
      dates: [...byDate.keys()]
        .sort()
        .reverse()
        .map((date) => ({
          date,
          // session_id embeds a timestamp, so reverse lexicographic order is reverse chronological order.
          sessions: [...byDate.get(date)!.entries()]
            .sort((a, b) => b[0].localeCompare(a[0]))
            .map(([sessionId, list]) => ({
              sessionId,
              files: list.sort((a, b) => a.index - b.index),
            })),
        })),
    };
  }

  /**
   * Classification (no IO): `archived` comes exactly from the DB row; the origin comes
   * from the shared sources registry, else from the Session's registration-time facts
   * (trace_sessions — the reconciler head-read its earliest shard once when the file
   * first appeared, so by listing time every indexed Session is classified exactly).
   */
  private classify(
    sessionId: string,
    row: SessionRow | undefined,
    facts: TraceSessionRow | undefined,
  ): TraceSessionFacts {
    const known = this.deps.sources?.get(sessionId);
    // Registry answer (including null = known user-created) wins — it can be fresher
    // (subagent registration happens at spawn, before any reconcile); else the stored facts.
    const source = known !== undefined ? known : (facts?.source ?? undefined);
    const category: SessionCategory =
      (row?.archivedAt ?? null) !== null
        ? "archived"
        : source === "subagent" || source === "schedule"
          ? source
          : "active";
    return { category, workspace: row?.workspace ?? facts?.workspace ?? "" };
  }

  /** The paginated listing behind agentTraces: pure index reads; per-file stat only for the returned slice (sizes written back). */
  private async agentTracesPage(
    projectId: string,
    agentId: string,
    files: TraceFileRow[],
    paging: { offset: number; limit: number },
    opts: { category?: SessionCategory; includeCli?: boolean },
  ): Promise<AgentTracesResponse> {
    const bySession = new Map<string, TraceFileRow[]>();
    for (const f of files) {
      const list = bySession.get(f.sessionId) ?? [];
      list.push(f);
      bySession.set(f.sessionId, list);
    }
    // One indexed query per source: the Agent's DB rows (title / archived / workspace /
    // client — CLI rows included) and the registration-time facts.
    const rows = new Map(
      (this.deps.sessions?.listByAgent(projectId, agentId) ?? []).map((r) => [r.sessionId, r]),
    );
    const factsBySession = new Map(
      this.deps.index.repo.listSessionsByAgent(projectId, agentId).map((r) => [r.sessionId, r]),
    );
    /**
     * CLI-origin = no web-created DB row AND not a subagent/schedule Session. Server-created
     * Sessions always have a row (creation / subagent registration insert one), so rowless =
     * external CLI; adopted CLI rows carry client='cli'. The default listing excludes these —
     * the same "show CLI sessions" preference the sidebar applies — while subagent/schedule
     * Sessions stay in their folders regardless of which process ran them.
     */
    const cliOrigin = (sessionId: string, facts: TraceSessionFacts): boolean => {
      if (facts.category === "subagent" || facts.category === "schedule") return false;
      const row = rows.get(sessionId);
      return !(
        row !== undefined &&
        (row.client === null || row.client === undefined || row.client === "web")
      );
    };
    // v3 Sessions deliberately have no trace_files rows. The paged inventory is the
    // union of legacy shard groups and explicitly indexed Session bundles.
    const ids = [...new Set([...bySession.keys(), ...factsBySession.keys()])].sort((a, b) =>
      b.localeCompare(a),
    );
    // Classify every group once; the same result drives the CLI/category filters, the
    // counts AND the returned fields, so a row can never appear in a bucket its own
    // `category` denies. Hidden CLI-origin groups are excluded from counts too.
    const counts: SessionCategoryCounts = { active: 0, subagent: 0, schedule: 0, archived: 0 };
    const workspaceCounts: Record<string, SessionCategoryCounts> = {};
    const factsById = new Map<string, TraceSessionFacts>();
    const visible: string[] = [];
    for (const id of ids) {
      const facts = this.classify(id, rows.get(id), factsBySession.get(id));
      if (opts.includeCli !== true && cliOrigin(id, facts)) continue;
      factsById.set(id, facts);
      visible.push(id);
      counts[facts.category] += 1;
      const ws = (workspaceCounts[facts.workspace] ??= {
        active: 0,
        subagent: 0,
        schedule: 0,
        archived: 0,
      });
      ws[facts.category] += 1;
    }
    const filtered =
      opts.category === undefined
        ? visible
        : visible.filter((id) => factsById.get(id)!.category === opts.category);
    const page = filtered.slice(paging.offset, paging.offset + paging.limit);
    const sessions: AgentTraceSessionEntry[] = [];
    for (const sessionId of page) {
      const shard = (bySession.get(sessionId) ?? []).sort((a, b) => a.fileIndex - b.fileIndex);
      // Fresh sizes for the returned page only (an actively-appended shard grows without
      // moving any directory mtime): bounded metadata stats, written back to the index.
      const withSize = await Promise.all(
        shard.map(async (f) => {
          let sizeBytes = f.sizeBytes;
          try {
            sizeBytes = (await fs.stat(traceFilePath(this.root, f))).size;
            if (sizeBytes !== f.sizeBytes) {
              this.deps.index.repo.updateFileSize(
                projectId,
                agentId,
                sessionId,
                f.fileIndex,
                sizeBytes,
              );
            }
          } catch {
            /* Vanished mid-request: serve the last observed size; the next reconcile settles the rows. */
          }
          return { index: f.fileIndex, date: f.date, sizeBytes };
        }),
      );
      const facts = factsById.get(sessionId)!;
      // Title: DB row first (?? sends both "no row" and "row with NULL title" onward);
      // else the registration-time first-prompt fallback stored in trace_sessions.
      const title = rows.get(sessionId)?.title ?? factsBySession.get(sessionId)?.title ?? undefined;
      sessions.push({
        sessionId,
        ...(title !== undefined ? { title } : {}),
        category: facts.category,
        workspace: facts.workspace,
        files: withSize,
      });
    }
    return { dates: [], sessions, totalSessions: filtered.length, counts, workspaceCounts };
  }

  private async readFileByIndex(
    projectId: string,
    agentId: string,
    sessionId: string,
    index: number,
  ): Promise<OmniMessage[]> {
    const file = await this.locateByIndex(projectId, agentId, sessionId, index);
    return readTraceTolerant(file.path);
  }

  private async locateByIndex(
    projectId: string,
    agentId: string,
    sessionId: string,
    index: number,
  ): Promise<LocatedFile> {
    const files = await this.locateAll(projectId, agentId, sessionId);
    const file = files.find((f) => f.index === index);
    if (!file) {
      throw new HttpError(
        404,
        "trace_not_found",
        `This Session has no Trace file with index ${index}.`,
      );
    }
    return file;
  }

  /** Raw bytes of the Trace file at the given index (export/download: the file is served verbatim). */
  async readFileRaw(
    projectId: string,
    agentId: string,
    sessionId: string,
    index: number,
  ): Promise<Buffer> {
    const file = await this.locateByIndex(projectId, agentId, sessionId, index);
    return fs.readFile(file.path);
  }

  /**
   * Imports an uploaded Trace file (raw JSONL content). Validates the content itself —
   * parseable JSONL whose first record is a `session_meta` carrying a filename-safe
   * `session_id` (400 invalid_trace otherwise) — then writes it under the Agent's traces
   * directory as a **new Session**: a session id the Agent already has is rejected with
   * 409 `trace_session_exists` (splicing a further index into an existing Session would
   * corrupt its concatenated transcript, silently become its resume point, and could
   * collide with a live Writer's rotation), so the imported file is always index 1. The
   * date dir comes from the first record's timestamp (falling back to now), formatted as
   * a **local** date — the same convention as core's Trace Writer — so an export →
   * import round-trip lands in the same date dir on non-UTC servers.
   */
  async importTraceFile(
    projectId: string,
    agentId: string,
    content: string,
  ): Promise<TraceImportResponse> {
    const invalid = (message: string) => new HttpError(400, "invalid_trace", message);
    let records: OmniMessage[];
    try {
      // Strict parse: import is the gate for user-supplied files, so a malformed middle
      // line is reported as 400 rather than silently dropped (read paths skip it instead).
      records = parseTraceLines(content, { onMalformed: "throw" });
    } catch {
      throw invalid("The file is not valid Trace JSONL.");
    }
    if (records.length === 0) throw invalid("The file contains no Trace records.");
    const first = records[0]!;
    if (!isSessionMeta(first))
      throw invalid("The first record of a Trace file must be session_meta.");
    // The payload type declares session_id: string, but the value came from user-supplied JSON —
    // re-check the runtime shape before it becomes part of a filename.
    const sessionId: unknown = (first.payload as { session_id?: unknown }).session_id;
    if (typeof sessionId !== "string" || !IMPORT_SESSION_ID_RE.test(sessionId)) {
      throw invalid("session_meta carries a missing or invalid session_id.");
    }
    const duplicate = () =>
      new HttpError(
        409,
        "trace_session_exists",
        `This Agent already has a Session with id ${sessionId}; a duplicate Trace cannot be imported.`,
      );
    if ((await this.locateAll(projectId, agentId, sessionId)).length > 0) throw duplicate();
    const ts = Date.parse(first.timestamp);
    const date = formatLocalDate(Number.isNaN(ts) ? new Date() : new Date(ts));
    const index = 1;
    const dir = path.join(tracesDir(this.root, projectId, agentId), date);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${sessionId}_${String(index).padStart(3, "0")}.jsonl`);
    const body = content.replace(/\n+$/, "") + "\n";
    try {
      // Normalize to exactly one trailing newline (the JSONL convention the writer
      // follows). `wx` closes the check-then-write race: two concurrent imports of the
      // same new session id both pass the locateAll check, but only one can create the
      // file — the loser's EEXIST maps to the same 409 as the pre-check.
      await fs.writeFile(file, body, { encoding: "utf8", flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") throw duplicate();
      throw err;
    }
    // Write-time registration: this path knows the file's identity and already holds the
    // parsed records, so the index row + session facts land synchronously (no re-read).
    this.deps.index.registerImportedFile({
      projectId,
      agentId,
      sessionId,
      fileIndex: index,
      date,
      sizeBytes: Buffer.byteLength(body, "utf8"),
      records,
    });
    return { sessionId, index, date };
  }
}
