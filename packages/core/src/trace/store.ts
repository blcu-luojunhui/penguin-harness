/**
 * Protocol-v3 Trace-first storage.
 *
 * A Session owns a small journal, while every logical Trace owns its event history:
 *
 *   <tracesDir>/<sessionId>/session.jsonl
 *   <tracesDir>/<sessionId>/traces/<traceId>/events.jsonl
 *   <tracesDir>/<sessionId>/checkpoints/<checkpointId>.json
 *
 * Legacy date/index Trace files are intentionally neither read nor modified here.
 */
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  createProtocolId,
  isCompleteModelMessage,
  isEventMessage,
  isSessionMeta,
} from "../omnimessage/index.js";
import type { OmniMessage, SessionMetaMessage, TraceRootKind } from "../omnimessage/index.js";
import type { TraceSink } from "../engine/context-engine.js";
import { parseTraceLines, resumeTrace } from "./resume.js";
import type { ResumeResult } from "./resume.js";

export interface TraceStoreOptions {
  tracesDir: string;
  sessionId: string;
}

export interface SessionFormatRecord {
  record_type: "session_format";
  protocol_version: 3;
  format: "penguin.trace.session";
  format_version: 1;
  session_id: string;
}

export interface SessionFactRecord {
  record_type: "session_fact";
  protocol_version: 3;
  timestamp: string;
  message: OmniMessage;
}

export interface TraceLinkRecord {
  record_type: "trace_link";
  protocol_version: 3;
  timestamp: string;
  session_id: string;
  trace_id: string;
  root_kind: TraceRootKind;
  task_id?: string;
}

export interface TraceEventLinkRecord {
  record_type: "trace_event_link";
  protocol_version: 3;
  timestamp: string;
  session_id: string;
  trace_id: string;
  event_id: string;
}

export interface ContextCheckpointLinkRecord {
  record_type: "context_checkpoint_link";
  protocol_version: 3;
  timestamp: string;
  session_id: string;
  checkpoint_id: string;
  trace_id: string;
  after_event_id: string;
  /** Controlled basename inside this Session's checkpoints directory. */
  checkpoint_file: string;
}

export type SessionJournalRecord =
  | SessionFormatRecord
  | SessionFactRecord
  | TraceLinkRecord
  | TraceEventLinkRecord
  | ContextCheckpointLinkRecord;

export interface TraceLoadDiagnostic {
  code:
    | "dangling_trace_event_link"
    | "trace_event_mismatch"
    | "duplicate_trace_event_link"
    | "unlinked_trace_event"
    | "missing_trace_event_file"
    | "malformed_session_journal";
  line?: number;
  journal_index?: number;
  trace_id?: string;
  event_id?: string;
  message: string;
}

export interface ContextCheckpoint {
  protocol_version: 3;
  checkpoint_id: string;
  session_id: string;
  trace_id: string;
  after_event_id: string;
  created_at: string;
  state: ResumeResult;
}

export interface LoadedV3Session {
  journal: SessionJournalRecord[];
  events: OmniMessage[];
  resumed: ResumeResult;
  sessionPath: string;
  partial: boolean;
  diagnostics: TraceLoadDiagnostic[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function isRecordableTraceEvent(msg: OmniMessage): boolean {
  if (msg.origin && msg.origin.length > 0) return false;
  return isCompleteModelMessage(msg) || isEventMessage(msg);
}

function isSessionFact(msg: OmniMessage): boolean {
  if (isSessionMeta(msg)) return true;
  return isEventMessage(msg) && msg.payload.type === "tool_list_ready";
}

function parseJournalDetailed(content: string): {
  records: SessionJournalRecord[];
  diagnostics: TraceLoadDiagnostic[];
} {
  const records: SessionJournalRecord[] = [];
  const diagnostics: TraceLoadDiagnostic[] = [];
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as SessionJournalRecord);
    } catch {
      diagnostics.push({
        code: "malformed_session_journal",
        line: index + 1,
        message: `Malformed Session journal record at line ${index + 1}`,
      });
    }
  }
  return { records, diagnostics };
}

function parseJournal(content: string): SessionJournalRecord[] {
  return parseJournalDetailed(content).records;
}

async function readUtf8OrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

/**
 * Serial callers get one append syscall per JSONL record. The first append to a path probes
 * its tail and inserts a newline when the previous process died mid-record. A short write
 * invalidates the probe cache so the next append heals that new torn tail as well.
 */
class JsonlAppender {
  private readonly cleanTail = new Set<string>();

  async append(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(path, "a+");
    try {
      let prefix = "";
      if (!this.cleanTail.has(path)) {
        const { size } = await handle.stat();
        if (size > 0) {
          const tail = Buffer.allocUnsafe(1);
          const { bytesRead } = await handle.read(tail, 0, 1, size - 1);
          if (bytesRead === 1 && tail[0] !== 0x0a) prefix = "\n";
        }
      }
      const data = Buffer.from(`${prefix}${JSON.stringify(value)}\n`, "utf8");
      const { bytesWritten } = await handle.write(data);
      if (bytesWritten !== data.length) {
        this.cleanTail.delete(path);
        throw new Error(`Trace append wrote ${bytesWritten} of ${data.length} bytes`);
      }
      this.cleanTail.add(path);
    } catch (error) {
      this.cleanTail.delete(path);
      throw error;
    } finally {
      await handle.close();
    }
  }
}

/** Append-only writer/router for protocol-v3 logical Traces. */
export class TraceStore implements TraceSink {
  private readonly sessionDir: string;
  private readonly sessionId: string;
  private chain: Promise<void> = Promise.resolve();
  private readonly appender = new JsonlAppender();
  private hydrated = false;
  private readonly linkedTraces = new Set<string>();
  private readonly linkedEvents = new Map<string, string>();
  private hasSessionMeta = false;

  constructor(opts: TraceStoreOptions) {
    this.sessionId = opts.sessionId;
    this.sessionDir = join(opts.tracesDir, opts.sessionId);
  }

  sessionPath(): string {
    return join(this.sessionDir, "session.jsonl");
  }

  tracePath(traceId: string): string {
    return join(this.sessionDir, "traces", traceId, "events.jsonl");
  }

  checkpointPath(checkpointId: string): string {
    return join(this.sessionDir, "checkpoints", `${checkpointId}.json`);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chain.then(operation);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async hydrateLinks(): Promise<void> {
    if (this.hydrated) return;
    const records = parseJournal(await readUtf8OrEmpty(this.sessionPath()));
    if (records.length === 0) {
      await this.appender.append(this.sessionPath(), {
        record_type: "session_format",
        protocol_version: 3,
        format: "penguin.trace.session",
        format_version: 1,
        session_id: this.sessionId,
      } satisfies SessionFormatRecord);
    } else {
      const marker = records[0];
      if (
        marker?.record_type !== "session_format" ||
        marker.protocol_version !== 3 ||
        marker.format !== "penguin.trace.session" ||
        marker.format_version !== 1 ||
        marker.session_id !== this.sessionId
      ) {
        throw new Error(`Unsupported protocol-v3 Session journal format: ${this.sessionPath()}`);
      }
    }
    for (const record of records) {
      if (record.record_type === "trace_link") this.linkedTraces.add(record.trace_id);
      if (record.record_type === "session_fact" && isSessionMeta(record.message)) {
        this.hasSessionMeta = true;
      }
      if (record.record_type === "trace_event_link" && !this.linkedEvents.has(record.event_id)) {
        this.linkedEvents.set(record.event_id, record.trace_id);
      }
    }
    this.hydrated = true;
  }

  async write(msg: OmniMessage): Promise<void> {
    if (msg.origin && msg.origin.length > 0) return;
    if (!isSessionFact(msg) && !isRecordableTraceEvent(msg)) return;
    return this.enqueue(async () => {
      await this.hydrateLinks();
      if (isSessionFact(msg)) {
        await this.appender.append(this.sessionPath(), {
          record_type: "session_fact",
          protocol_version: 3,
          timestamp: msg.timestamp,
          message: msg,
        } satisfies SessionFactRecord);
        if (isSessionMeta(msg)) this.hasSessionMeta = true;
        return;
      }

      if (!this.hasSessionMeta) {
        throw new Error("Protocol-v3 execution cannot be written before session_meta");
      }

      const trace = msg.trace;
      if (!trace?.trace_id) {
        const payloadType = (msg.payload as { type?: string }).type ?? msg.type;
        throw new Error(`Protocol-v3 execution event ${payloadType} is missing trace.trace_id`);
      }
      const isTraceBegin = isEventMessage(msg) && msg.payload.type === "trace_begin";
      if (!this.linkedTraces.has(trace.trace_id) && !isTraceBegin) {
        throw new Error(
          `Protocol-v3 Trace ${trace.trace_id} has no trace_begin link in the Session journal`,
        );
      }
      if (isTraceBegin && !this.linkedTraces.has(trace.trace_id)) {
        await this.appender.append(this.sessionPath(), {
          record_type: "trace_link",
          protocol_version: 3,
          timestamp: msg.timestamp,
          session_id: this.sessionId,
          trace_id: trace.trace_id,
          root_kind: (msg.payload as { root_kind: TraceRootKind }).root_kind,
          ...(trace.task_id !== undefined ? { task_id: trace.task_id } : {}),
        } satisfies TraceLinkRecord);
        this.linkedTraces.add(trace.trace_id);
      }
      if (!msg.event_id) {
        throw new Error("Protocol-v3 execution event is missing event_id");
      }
      const existingTrace = this.linkedEvents.get(msg.event_id);
      if (existingTrace !== undefined && existingTrace !== trace.trace_id) {
        throw new Error(
          `Protocol-v3 event ${msg.event_id} is already linked to Trace ${existingTrace}`,
        );
      }
      if (existingTrace === undefined) {
        await this.appender.append(this.sessionPath(), {
          record_type: "trace_event_link",
          protocol_version: 3,
          timestamp: msg.timestamp,
          session_id: this.sessionId,
          trace_id: trace.trace_id,
          event_id: msg.event_id,
        } satisfies TraceEventLinkRecord);
        this.linkedEvents.set(msg.event_id, trace.trace_id);
      } else {
        const existing = parseTraceLines(
          await readUtf8OrEmpty(this.tracePath(trace.trace_id)),
        ).some((event) => event.event_id === msg.event_id);
        if (existing) return;
      }
      await this.appender.append(this.tracePath(trace.trace_id), msg);

      if (
        isEventMessage(msg) &&
        msg.payload.type === "compaction_end" &&
        msg.payload.status === "completed" &&
        msg.event_id
      ) {
        try {
          await this.createCheckpoint(trace.trace_id, msg.event_id);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          process.stderr.write(`[trace] checkpoint creation failed: ${detail}\n`);
        }
      }
    });
  }

  async writeAll(messages: OmniMessage[]): Promise<void> {
    for (const message of messages) await this.write(message);
  }

  /** Logical Traces do not rotate when the model context is compacted. */
  async rotate(): Promise<false> {
    return false;
  }

  private async createCheckpoint(traceId: string, afterEventId: string): Promise<void> {
    const journal = parseJournal(await readUtf8OrEmpty(this.sessionPath()));
    const { messages: events } = await readLinkedEvents(this.sessionDir, journal);
    const meta = firstSessionMeta(journal);
    if (!meta) throw new Error("Cannot checkpoint a Session without session_meta");
    const state = resumeTrace([meta, ...events]);
    const checkpointId = createProtocolId();
    const checkpoint: ContextCheckpoint = {
      protocol_version: 3,
      checkpoint_id: checkpointId,
      session_id: this.sessionId,
      trace_id: traceId,
      after_event_id: afterEventId,
      created_at: nowIso(),
      state,
    };
    const target = this.checkpointPath(checkpointId);
    const temp = `${target}.${createProtocolId()}.tmp`;
    await mkdir(dirname(target), { recursive: true });
    try {
      await writeFile(temp, `${JSON.stringify(checkpoint)}\n`, "utf8");
      await rename(temp, target);
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    }
    await this.appender.append(this.sessionPath(), {
      record_type: "context_checkpoint_link",
      protocol_version: 3,
      timestamp: checkpoint.created_at,
      session_id: this.sessionId,
      checkpoint_id: checkpointId,
      trace_id: traceId,
      after_event_id: afterEventId,
      checkpoint_file: basename(target),
    } satisfies ContextCheckpointLinkRecord);
  }
}

function firstSessionMeta(journal: SessionJournalRecord[]): SessionMetaMessage | null {
  for (const record of journal) {
    if (record.record_type === "session_fact" && isSessionMeta(record.message)) {
      return record.message;
    }
  }
  return null;
}

async function readLinkedEvents(
  sessionDir: string,
  journal: SessionJournalRecord[],
): Promise<{ messages: OmniMessage[]; diagnostics: TraceLoadDiagnostic[] }> {
  const payloads = new Map<string, Map<string, OmniMessage>>();
  const unlinked: Array<{ traceId: string; eventId: string }> = [];
  const seenTraces = new Set<string>();
  const diagnostics: TraceLoadDiagnostic[] = [];
  for (const record of journal) {
    if (record.record_type !== "trace_link" || seenTraces.has(record.trace_id)) continue;
    seenTraces.add(record.trace_id);
    const path = join(sessionDir, "traces", record.trace_id, "events.jsonl");
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        payloads.set(record.trace_id, new Map());
        diagnostics.push({
          code: "missing_trace_event_file",
          trace_id: record.trace_id,
          message: `Session journal links a missing Trace event file: ${path}`,
        });
        continue;
      }
      throw error;
    }
    const byId = new Map<string, OmniMessage>();
    for (const message of parseTraceLines(content)) {
      if (message.event_id && !byId.has(message.event_id)) byId.set(message.event_id, message);
    }
    payloads.set(record.trace_id, byId);
  }

  const messages: OmniMessage[] = [];
  const linked = new Set<string>();
  for (let journalIndex = 0; journalIndex < journal.length; journalIndex += 1) {
    const record = journal[journalIndex]!;
    if (record.record_type !== "trace_event_link") continue;
    const key = `${record.trace_id}\u0000${record.event_id}`;
    if (linked.has(key)) {
      diagnostics.push({
        code: "duplicate_trace_event_link",
        journal_index: journalIndex,
        trace_id: record.trace_id,
        event_id: record.event_id,
        message: `Duplicate Trace event link ${record.event_id} was ignored`,
      });
      continue;
    }
    linked.add(key);
    const message = payloads.get(record.trace_id)?.get(record.event_id);
    if (!message) {
      diagnostics.push({
        code: "dangling_trace_event_link",
        journal_index: journalIndex,
        trace_id: record.trace_id,
        event_id: record.event_id,
        message: `Trace event link ${record.event_id} has no persisted payload`,
      });
      continue;
    }
    if (message.trace?.trace_id !== record.trace_id || message.event_id !== record.event_id) {
      diagnostics.push({
        code: "trace_event_mismatch",
        journal_index: journalIndex,
        trace_id: record.trace_id,
        event_id: record.event_id,
        message: `Trace event link ${record.event_id} does not match its payload`,
      });
      continue;
    }
    messages.push(message);
  }
  for (const [traceId, byId] of payloads) {
    for (const eventId of byId.keys()) {
      if (!linked.has(`${traceId}\u0000${eventId}`)) unlinked.push({ traceId, eventId });
    }
  }
  for (const { traceId, eventId } of unlinked) {
    diagnostics.push({
      code: "unlinked_trace_event",
      trace_id: traceId,
      event_id: eventId,
      message: `Trace event payload ${eventId} has no Session-journal link`,
    });
  }
  return { messages, diagnostics };
}

function mergeCheckpointTail(
  checkpoint: ContextCheckpoint,
  meta: SessionMetaMessage,
  tail: OmniMessage[],
): ResumeResult {
  const contextTail = tail.filter(
    (message) =>
      !(
        isEventMessage(message) &&
        (message.payload.type === "trace_begin" ||
          message.payload.type === "trace_end" ||
          message.payload.type === "span_begin" ||
          message.payload.type === "span_end")
      ),
  );
  if (contextTail.length === 0) return checkpoint.state;
  const delta = resumeTrace([meta, ...contextTail]);
  const resetInTail = contextTail.some(
    (message) =>
      isEventMessage(message) &&
      message.payload.type === "compaction_end" &&
      message.payload.status === "completed",
  );
  if (resetInTail) {
    return {
      ...delta,
      sessionTokens:
        delta.sessionTokens.total === 0 ? checkpoint.state.sessionTokens : delta.sessionTokens,
    };
  }
  const requestStarted = contextTail.some(
    (message) => isEventMessage(message) && message.payload.type === "request_begin",
  );
  return {
    ...delta,
    history: [...checkpoint.state.history, ...delta.history],
    renderMessages: [...checkpoint.state.renderMessages, ...delta.renderMessages],
    sessionTokens:
      delta.sessionTokens.total === 0 ? checkpoint.state.sessionTokens : delta.sessionTokens,
    lastRequestTotal:
      delta.lastRequestTotal === 0 ? checkpoint.state.lastRequestTotal : delta.lastRequestTotal,
    sessionTurns: checkpoint.state.sessionTurns + delta.sessionTurns,
    ...(!requestStarted && checkpoint.state.pendingSummary && !delta.pendingSummary
      ? { pendingSummary: checkpoint.state.pendingSummary }
      : {}),
  };
}

/** Loads only the v3 Session directory; legacy date/index files are deliberately ignored. */
export async function loadV3Session(
  tracesDir: string,
  sessionId: string,
): Promise<LoadedV3Session | null> {
  const sessionDir = join(tracesDir, sessionId);
  const sessionPath = join(sessionDir, "session.jsonl");
  const content = await readUtf8OrEmpty(sessionPath);
  if (!content) return null;
  const parsedJournal = parseJournalDetailed(content);
  const journal = parsedJournal.records;
  const marker = journal[0];
  if (
    marker?.record_type !== "session_format" ||
    marker.protocol_version !== 3 ||
    marker.format !== "penguin.trace.session" ||
    marker.format_version !== 1 ||
    marker.session_id !== sessionId
  ) {
    throw new Error(`Unsupported protocol-v3 Session journal format: ${sessionPath}`);
  }
  const meta = firstSessionMeta(journal);
  if (!meta) throw new Error(`Session journal is missing session_meta: ${sessionPath}`);
  const linked = await readLinkedEvents(sessionDir, journal);
  const events = linked.messages;
  const diagnostics = [...parsedJournal.diagnostics, ...linked.diagnostics];

  const links = journal.filter(
    (record): record is ContextCheckpointLinkRecord =>
      record.record_type === "context_checkpoint_link",
  );
  for (let index = links.length - 1; index >= 0; index -= 1) {
    const link = links[index]!;
    if (
      link.checkpoint_file !== basename(link.checkpoint_file) ||
      link.checkpoint_file !== `${link.checkpoint_id}.json`
    ) {
      continue;
    }
    try {
      const raw = await readFile(join(sessionDir, "checkpoints", link.checkpoint_file), "utf8");
      const checkpoint = JSON.parse(raw) as ContextCheckpoint;
      if (
        checkpoint.protocol_version !== 3 ||
        checkpoint.session_id !== sessionId ||
        checkpoint.checkpoint_id !== link.checkpoint_id ||
        checkpoint.trace_id !== link.trace_id ||
        checkpoint.after_event_id !== link.after_event_id
      ) {
        continue;
      }
      const cursor = events.findIndex((message) => message.event_id === link.after_event_id);
      if (cursor < 0) continue;
      return {
        journal,
        events,
        resumed: mergeCheckpointTail(checkpoint, meta, events.slice(cursor + 1)),
        sessionPath,
        partial: diagnostics.length > 0,
        diagnostics,
      };
    } catch {
      // Try the previous atomic checkpoint. If all are unusable, replay the v3 event history.
    }
  }

  return {
    journal,
    events,
    resumed: resumeTrace([meta, ...events]),
    sessionPath,
    partial: diagnostics.length > 0,
    diagnostics,
  };
}

/** Latest v3 Session id. Session ids are time-sortable, so no event timestamps are inferred. */
export async function latestV3SessionId(tracesDir: string): Promise<string | null> {
  let entries;
  try {
    entries = await readdir(tracesDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const journal = await readUtf8OrEmpty(join(tracesDir, entry.name, "session.jsonl"));
    const records = parseJournal(journal);
    if (
      records[0]?.record_type === "session_format" &&
      records.some((record) => record.record_type === "trace_link")
    ) {
      candidates.push(entry.name);
    }
  }
  candidates.sort().reverse();
  return candidates[0] ?? null;
}

/** Controlled bundle directory for one protocol-v3 Session. */
export function v3SessionPath(tracesDir: string, sessionId: string): string {
  return join(tracesDir, sessionId);
}

/** Lightweight existence probe; does not parse or replay the Session bundle. */
export async function findV3Session(tracesDir: string, sessionId: string): Promise<string | null> {
  const sessionDir = v3SessionPath(tracesDir, sessionId);
  try {
    await access(join(sessionDir, "session.jsonl"));
    return sessionDir;
  } catch {
    return null;
  }
}
