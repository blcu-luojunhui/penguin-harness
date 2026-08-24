/**
 * Session resume: `agent.resumeSession` and setHistory injection.
 *
 * - Resume source is the Trace file with the latest index; config carries over from session_meta
 *   (Workspace / Model cannot be swapped).
 * - Pairing-fallback placeholders, once constructed, are written into the original trace file;
 *   session_meta is never written twice.
 * - Errors when the session doesn't exist / the workspace is missing / the model is no longer in the project config.
 * - `groupHistoryToUniMessages` groups by adjacent same role; `GenerativeModel.setHistory` injects into AgentHub.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgent } from "../src/index.js";
import {
  abortEvent,
  assistantText,
  compactionBegin,
  compactionEnd,
  requestBegin,
  requestEnd,
  sessionMeta,
  spanBegin,
  spanEnd,
  tokenUsage,
  toolCall,
  traceBegin,
  traceEnd,
  userText,
  withTraceContext,
} from "../src/omnimessage/index.js";
import type { OmniMessage, TokenCounts } from "../src/omnimessage/index.js";
import { GenerativeModel, groupHistoryToUniMessages } from "../src/llm/index.js";
import { readTrace, TraceStore } from "../src/trace/index.js";
import { tracesDir } from "../src/state/paths.js";
import { stubProviderKeys } from "./provider-keys.js";

// The default project config ships with this model ((provider, model_id) pair reference; model_id is the upstream id).
const MODEL = { provider: "anthropic", model_id: "claude-sonnet-4-6" };

let tmpRoot: string;
let workspace: string;
let prevHome: string | undefined;
let restoreKeys: () => void;

beforeEach(async () => {
  prevHome = process.env.PENGUIN_HOME;
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "penguin-resume-"));
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "penguin-resume-ws-"));
  process.env.PENGUIN_HOME = tmpRoot;
  restoreKeys = stubProviderKeys();
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.PENGUIN_HOME;
  else process.env.PENGUIN_HOME = prevHome;
  restoreKeys();
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.rm(workspace, { recursive: true, force: true });
});

const usage = (total: number): TokenCounts => ({
  cache_read: 0,
  cache_write: 0,
  output: 1,
  total,
});

/** Manually constructs a protocol-v3 Session bundle left behind by a previous process. */
async function writeTraceFile(
  root: string,
  sessionId: string,
  messages: OmniMessage[],
  opts?: { dateDir?: string; index?: string },
): Promise<string> {
  const store = new TraceStore({
    tracesDir: tracesDir(root, "default_project", "default_agent"),
    sessionId,
  });
  const meta = messages.find((message) => message.type === "session_meta");
  if (meta) await store.write(meta);
  const execution = messages.filter((message) => message.type !== "session_meta");
  if (execution.length === 0) return store.sessionPath();
  const suffix = opts?.index ?? "001";
  const traceId = `trace-${suffix}`;
  const taskId = `task-${suffix}`;
  await store.write(traceBegin({ rootKind: "task", traceId, taskId }));
  await store.write(spanBegin({ kind: "agent.task", traceId, taskId, spanId: taskId }));
  for (const message of execution) {
    await store.write(withTraceContext(message, { trace_id: traceId, task_id: taskId }));
  }
  await store.write(
    spanEnd({ kind: "agent.task", traceId, taskId, spanId: taskId, status: "completed" }),
  );
  await store.write(traceEnd({ rootKind: "task", traceId, taskId, status: "completed" }));
  return store.tracePath(traceId);
}

function metaFor(
  sessionId: string,
  workspaceDir: string,
  model = MODEL,
  source?: "subagent" | "schedule",
): OmniMessage {
  return sessionMeta({
    session_id: sessionId,
    provider: model.provider,
    model_id: model.model_id,
    model_context_window: 1000000,
    system_prompt: "ORIGINAL SYSTEM PROMPT",
    agent_state: "/agent/state",
    workspace: workspaceDir,
    ...(source !== undefined ? { source } : {}),
  });
}

describe("agent.resumeSession", () => {
  const SID = "session-2026-07-06-10-00-00-abcdef01";

  it("resumes from the latest trace file and exposes render history", async () => {
    const agent = await createAgent({});
    await writeTraceFile(tmpRoot, SID, [
      metaFor(SID, workspace),
      userText("hello"),
      requestBegin(),
      assistantText("hi there"),
      requestEnd("completed"),
      tokenUsage(usage(42), usage(42)),
    ]);

    const session = await agent.resumeSession({ sessionId: SID });
    expect(session.sessionId).toBe(SID);
    expect(session.provider).toBe(MODEL.provider);
    expect(session.modelId).toBe(MODEL.model_id);
    expect(session.workspaceDir).toBe(workspace);
    const texts = (session.resumedHistory ?? []).map(
      (m) => (m.payload as { text?: string }).text ?? "",
    );
    expect(texts).toEqual(["hello", "hi there"]);
  });

  it.each(["text", "request_end", "compaction_end"])(
    "fails closed when a journal-linked %s payload is missing",
    async (missingType) => {
      const agent = await createAgent({});
      const eventPath = await writeTraceFile(tmpRoot, SID, [
        metaFor(SID, workspace),
        userText("hello"),
        requestBegin(),
        assistantText("hi"),
        requestEnd("completed"),
        compactionBegin({ reason: "manual", mode: "discard", context: 1, turns: 1 }),
        compactionEnd({ reason: "manual", mode: "discard", status: "completed" }),
      ]);
      const lines = (await fs.readFile(eventPath, "utf8")).trim().split("\n");
      const filtered = lines.filter((line) => {
        const message = JSON.parse(line) as OmniMessage;
        return (message.payload as { type?: string }).type !== missingType;
      });
      await fs.writeFile(eventPath, `${filtered.join("\n")}\n`, "utf8");

      await expect(agent.resumeSession({ sessionId: SID })).rejects.toThrow(
        /Session Trace is partial/,
      );
    },
  );

  it("preserves the stored session source across resume (and its absence for user sessions)", async () => {
    const agent = await createAgent({});
    await writeTraceFile(tmpRoot, SID, [
      metaFor(SID, workspace, MODEL, "subagent"),
      userText("child task"),
      requestBegin(),
      assistantText("done"),
      requestEnd("completed"),
    ]);
    const session = await agent.resumeSession({ sessionId: SID });
    // The rebuilt session_meta carries the origin over (a rotated Trace file must re-record it).
    expect((session.metaMessage.payload as { source?: string }).source).toBe("subagent");
    session.dispose();

    // A user-created session's meta has no source key, and resume must not invent one.
    const SID2 = "session-2026-07-06-11-00-00-abcdef02";
    await writeTraceFile(tmpRoot, SID2, [metaFor(SID2, workspace), userText("hi")]);
    const plain = await agent.resumeSession({ sessionId: SID2 });
    expect("source" in (plain.metaMessage.payload as unknown as Record<string, unknown>)).toBe(
      false,
    );
    plain.dispose();

    // On-disk values are untrusted: a junk source written by a third party is dropped on
    // resume (only the exact known origins pass), not cast through into the rebuilt meta.
    const SID3 = "session-2026-07-06-12-00-00-abcdef03";
    await writeTraceFile(tmpRoot, SID3, [
      metaFor(SID3, workspace, MODEL, "weird-origin" as unknown as "subagent"),
      userText("hi"),
    ]);
    const junk = await agent.resumeSession({ sessionId: SID3 });
    expect("source" in (junk.metaMessage.payload as unknown as Record<string, unknown>)).toBe(
      false,
    );
    junk.dispose();
  });

  it("keeps abort events in resumed render history", async () => {
    const agent = await createAgent({});
    await writeTraceFile(tmpRoot, SID, [
      metaFor(SID, workspace),
      userText("long task"),
      requestBegin(),
      assistantText("partial answer", "aborted"),
      requestEnd("aborted"),
      abortEvent("aborted by user"),
    ]);

    const session = await agent.resumeSession({ sessionId: SID });
    expect(
      (session.resumedHistory ?? []).map((m) => (m.payload as { type?: string }).type),
    ).toEqual(["text", "text", "abort"]);
  });

  it("closes a compaction the user quit out of as failed, discarding its draft (issue #288)", async () => {
    // The process died while a compaction ran: the shard ends inside the span (begin +
    // prompt + an unfinished request that had started writing a summary). That compaction
    // simply failed — resume closes the span before appending anything else, so the
    // conversation that follows is not hidden as compaction-internal, and the half-written
    // draft is discarded rather than adopted as a summary.
    const agent = await createAgent({});
    const file = await writeTraceFile(tmpRoot, SID, [
      metaFor(SID, workspace),
      userText("q1"),
      requestBegin(),
      assistantText("a1"),
      tokenUsage(usage(150), usage(150)),
      requestEnd("completed"),
      compactionBegin({ reason: "context", mode: "summarize", context: 150, turns: 1 }),
      userText("COMPACT NOW"),
      requestBegin(),
      assistantText("[summary]half-writ"),
    ]);

    const session = await agent.resumeSession({ sessionId: SID });
    const closed = await readTrace(file);
    const last = closed[closed.length - 1]!;
    expect(last.payload).toMatchObject({
      type: "compaction_end",
      reason: "context",
      mode: "summarize",
      status: "failed",
    });
    // Nothing was reconstructed from the interrupted compaction: the original context is
    // resumed as it stood before it, with no `[context_summary]` injected.
    const injected = (session.resumedHistory ?? []).some((m) =>
      ((m.payload as { text?: string }).text ?? "").includes("[context_summary]"),
    );
    expect(injected).toBe(false);
    session.dispose();

    // Idempotent: a second resume sees the matched pair and appends nothing.
    const again = await agent.resumeSession({ sessionId: SID });
    again.dispose();
    expect((await readTrace(file)).length).toBe(closed.length);
  });

  it("closes a dangling compaction on its original Trace without swallowing a later root", async () => {
    const dir = tracesDir(tmpRoot, "default_project", "default_agent");
    const store = new TraceStore({ tracesDir: dir, sessionId: SID });
    await store.write(metaFor(SID, workspace));
    await store.write(traceBegin({ rootKind: "task", traceId: "trace-a", taskId: "task-a" }));
    const dangling = withTraceContext(
      compactionBegin({ reason: "manual", mode: "summarize", context: 1, turns: 1 }),
      { trace_id: "trace-a", task_id: "task-a", step_id: "step-a", span_id: "span-a" },
    );
    await store.write(dangling);
    await store.write(traceBegin({ rootKind: "task", traceId: "trace-b", taskId: "task-b" }));
    for (const message of [
      userText("later question"),
      requestBegin(),
      assistantText("later answer"),
      requestEnd("completed"),
    ]) {
      await store.write(
        withTraceContext(message, { trace_id: "trace-b", task_id: "task-b", step_id: "step-b" }),
      );
    }

    const agent = await createAgent({});
    const session = await agent.resumeSession({ sessionId: SID });
    expect(
      (session.resumedHistory ?? [])
        .map((message) => (message.payload as { text?: string }).text)
        .filter(Boolean),
    ).toEqual(["later question", "later answer"]);
    const traceA = await readTrace(store.tracePath("trace-a"));
    const closure = traceA.at(-1)!;
    expect(closure.payload).toMatchObject({ type: "compaction_end", status: "failed" });
    expect(closure.trace).toEqual(dangling.trace);
    expect(
      (await readTrace(store.tracePath("trace-b"))).some(
        (message) => (message.payload as { type?: string }).type === "compaction_end",
      ),
    ).toBe(false);
    session.dispose();
  });

  it("ignores a legacy trace's recorded thinking_level; the Agent config always wins", async () => {
    // session_meta no longer carries a thinking level (it became a per-turn run parameter);
    // a `thinking_level` still present in an OLD trace's meta JSON is deliberately ignored —
    // resume always reads this Agent's current config, so a resumed legacy subagent session
    // falls back to the config level instead of keeping the level it inherited at spawn
    // time. The seeded Agent config here pins "medium".
    const agent = await createAgent({});
    expect(agent.state.systemConfig.model?.thinking_level).toBe("medium");
    const levelOf = async (session: unknown): Promise<unknown> => {
      // The LLM only exists after the lazy first-run bootstrap — drive it before reading.
      const gen = (session as { ensureReady(): AsyncGenerator<unknown> }).ensureReady();
      for await (const _ of gen) {
        // drain
      }
      return (session as { engine: { deps: { llm: { defaultThinkingLevel?: unknown } } } }).engine
        .deps.llm.defaultThinkingLevel;
    };

    const recorded = metaFor(SID, workspace);
    // A legacy trace: inject the retired field loosely into the on-disk meta JSON.
    (recorded.payload as unknown as Record<string, unknown>).thinking_level = "xhigh";
    await writeTraceFile(tmpRoot, SID, [recorded, userText("hello")]);
    const ignored = await agent.resumeSession({ sessionId: SID });
    expect(await levelOf(ignored)).toBe("medium");
    // The rebuilt meta holds invariants only: the legacy field is never re-recorded either.
    expect(
      "thinking_level" in (ignored.metaMessage.payload as unknown as Record<string, unknown>),
    ).toBe(false);

    // A current trace (no field) — and the legacy literal "default" — read the Agent config too.
    const SID2 = "session-2026-07-06-11-00-00-abcdef02";
    await writeTraceFile(tmpRoot, SID2, [metaFor(SID2, workspace), userText("hi")]);
    const fallback = await agent.resumeSession({ sessionId: SID2 });
    expect(await levelOf(fallback)).toBe("medium");

    const SID3 = "session-2026-07-06-12-00-00-abcdef03";
    const legacyDefault = metaFor(SID3, workspace);
    (legacyDefault.payload as unknown as Record<string, unknown>).thinking_level = "default";
    await writeTraceFile(tmpRoot, SID3, [legacyDefault, userText("hi")]);
    const viaDefault = await agent.resumeSession({ sessionId: SID3 });
    expect(await levelOf(viaDefault)).toBe("medium");
  });

  it("does not write pairing placeholders to the trace file (resume is side-effect free)", async () => {
    const agent = await createAgent({});
    const file = await writeTraceFile(tmpRoot, SID, [
      metaFor(SID, workspace),
      userText("go"),
      requestBegin(),
      toolCall({ name: "exec_command", arguments: "{}", toolCallId: "tc1" }),
      requestEnd("completed"),
      tokenUsage(usage(10), usage(10)),
      // tc1's output was lost along with the process: the pairing placeholder is synthesized in memory and sent out with the next run, never persisted.
    ]);
    const before = await readTrace(file);

    await agent.resumeSession({ sessionId: SID });
    await agent.resumeSession({ sessionId: SID }); // resuming again has no side effects either
    const after = await readTrace(file);
    expect(after).toHaveLength(before.length);
    expect(
      after.filter((m) =>
        ((m.payload as { output?: string }).output ?? "").includes("interrupted"),
      ),
    ).toHaveLength(0);
    // session_meta lives only in the Session journal and is never copied into Trace events.
    expect(after.filter((m) => m.type === "session_meta")).toHaveLength(0);
    const journalPath = path.join(path.dirname(path.dirname(path.dirname(file))), "session.jsonl");
    const journal = (await fs.readFile(journalPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { record_type?: string; message?: OmniMessage });
    expect(
      journal.filter(
        (record) =>
          record.record_type === "session_fact" && record.message?.type === "session_meta",
      ),
    ).toHaveLength(1);
  });

  it("replays linked logical Traces in Session-journal order", async () => {
    const agent = await createAgent({});
    await writeTraceFile(tmpRoot, SID, [metaFor(SID, workspace), userText("old context")], {
      index: "001",
    });
    await writeTraceFile(
      tmpRoot,
      SID,
      [
        metaFor(SID, workspace),
        userText("[context_summary]gist[/context_summary]"),
        requestBegin(),
        assistantText("resumed context"),
        requestEnd("completed"),
        tokenUsage(usage(5), usage(5)),
      ],
      { index: "002" },
    );

    const session = await agent.resumeSession({ sessionId: SID });
    const texts = (session.resumedHistory ?? []).map(
      (m) => (m.payload as { text?: string }).text ?? "",
    );
    expect(texts).toEqual([
      "old context",
      "[context_summary]gist[/context_summary]",
      "resumed context",
    ]);
  });

  it("errors when the session does not exist", async () => {
    const agent = await createAgent({});
    await expect(agent.resumeSession({ sessionId: "session-none" })).rejects.toThrow(
      /Session does not exist/,
    );
  });

  it("does not read, migrate, or modify legacy date/index Trace files", async () => {
    const agent = await createAgent({});
    const legacyDir = path.join(
      tracesDir(tmpRoot, "default_project", "default_agent"),
      "2026-07-06",
    );
    await fs.mkdir(legacyDir, { recursive: true });
    const legacyPath = path.join(legacyDir, `${SID}_001.jsonl`);
    const legacy = `${JSON.stringify(metaFor(SID, workspace))}\n${JSON.stringify(userText("old"))}\n`;
    await fs.writeFile(legacyPath, legacy, "utf8");

    await expect(agent.resumeSession({ sessionId: SID })).rejects.toThrow(/protocol-v3/);
    expect(await fs.readFile(legacyPath, "utf8")).toBe(legacy);
  });

  it("errors when the recorded workspace no longer exists (PRN-004: no auto-create)", async () => {
    const agent = await createAgent({});
    const gone = path.join(workspace, "gone");
    await writeTraceFile(tmpRoot, SID, [metaFor(SID, gone), userText("x")]);
    await expect(agent.resumeSession({ sessionId: SID })).rejects.toThrow(
      /Workspace no longer exists/,
    );
  });

  it("errors when the recorded model is no longer in the project config", async () => {
    const agent = await createAgent({});
    await writeTraceFile(tmpRoot, SID, [
      metaFor(SID, workspace, { provider: "custom", model_id: "vanished-model" }),
      userText("x"),
    ]);
    await expect(agent.resumeSession({ sessionId: SID })).rejects.toThrow(
      /is not in the Project config/,
    );
  });

  it("errors clearly when session_meta lacks provider (old-format trace, no migration)", async () => {
    // An old-format trace's session_meta only has model_id (from the composite-id era): no backward compat, just a clear error.
    const agent = await createAgent({});
    const legacy = metaFor(SID, workspace);
    delete (legacy.payload as { provider?: string }).provider;
    await writeTraceFile(tmpRoot, SID, [legacy, userText("x")]);
    await expect(agent.resumeSession({ sessionId: SID })).rejects.toThrow(/missing provider/);
  });

  it("latestSessionId returns the newest session by embedded timestamp", async () => {
    const agent = await createAgent({});
    expect(await agent.latestSessionId()).toBeNull();
    const older = "session-2026-07-05-09-00-00-aaaaaaaa";
    const newer = "session-2026-07-06-11-00-00-bbbbbbbb";
    await writeTraceFile(tmpRoot, older, [metaFor(older, workspace), userText("older")], {
      dateDir: "2026-07-05",
    });
    await writeTraceFile(tmpRoot, newer, [metaFor(newer, workspace), userText("newer")], {
      dateDir: "2026-07-06",
    });
    expect(await agent.latestSessionId()).toBe(newer);
  });

  it("latestSessionId ignores empty traces that only contain session_meta", async () => {
    const agent = await createAgent({});
    const older = "session-2026-07-05-09-00-00-aaaaaaaa";
    const emptyNewer = "session-2026-07-06-11-00-00-bbbbbbbb";
    await writeTraceFile(tmpRoot, older, [metaFor(older, workspace), userText("older")], {
      dateDir: "2026-07-05",
    });
    await writeTraceFile(tmpRoot, emptyNewer, [metaFor(emptyNewer, workspace)], {
      dateDir: "2026-07-06",
    });
    expect(await agent.latestSessionId()).toBe(older);
  });

  it("manual compact on a new empty session does not create a resumable trace", async () => {
    const agent = await createAgent({});
    const session = await agent.createSession({ workspaceDir: workspace });
    const messages = [];
    for await (const msg of session.compact()) messages.push(msg);
    expect(messages).toHaveLength(0);
    expect(await agent.latestSessionId()).toBeNull();
  });
});

describe("setHistory injection", () => {
  it("groupHistoryToUniMessages groups adjacent same-role messages into UniMessages", () => {
    const uni = groupHistoryToUniMessages([
      userText("hello"),
      assistantText("hi"),
      toolCall({ name: "exec_command", arguments: '{"cmd":"ls"}', toolCallId: "tc1" }),
      {
        ...userText("ignored-shape"),
        payload: {
          type: "tool_call_output",
          role: "user",
          output: "out",
          tool_call_id: "tc1",
          stop_reason: "completed",
        },
      } as OmniMessage,
      userText("next"),
      assistantText("done"),
    ]);
    expect(uni.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(uni[1]!.content_items.map((c) => c.type)).toEqual(["text", "tool_call"]);
    expect(uni[2]!.content_items.map((c) => c.type)).toEqual(["tool_result", "text"]);
  });

  it("GenerativeModel.setHistory seeds the AgentHub client history", () => {
    // GenerativeModel takes the request id sent to AgentHub (the upstream id), not the storage id.
    const model = new GenerativeModel({ modelId: "claude-sonnet-4-6", tools: [] });
    model.setHistory([userText("hello"), assistantText("hi")]);
    const client = (model as unknown as { client: { getHistory(): unknown[] } }).client;
    expect(client.getHistory()).toHaveLength(2);
  });
});
