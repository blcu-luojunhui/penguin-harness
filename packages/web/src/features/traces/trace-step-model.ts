/**
 * Pure projection and layout for one protocol-v3 Agent Step. The projector only
 * renders explicit Span lifecycle records and explicitly supported observation
 * messages. Lifecycle/control records never become standalone graph nodes.
 */
import type { OmniMessage, SpanCapabilities } from "@prismshadow/penguin-core/omnimessage";

export type TraceStepNodeType = "span" | "observation";
export type TraceStepEdgeKind = "hierarchy" | "causal";

interface TraceStepNodeBase {
  id: string;
  /** Ordinal of this node's first record in the server-provided append sequence. */
  recordOrdinal: number;
  nodeType: TraceStepNodeType;
  label: string;
  startTs: string;
  endTs?: string;
  status?: string;
  parentSpanId?: string;
  causedByEventId?: string;
  input?: unknown;
  output?: unknown;
  rawPayloads: unknown[];
}

export interface TraceStepSpanNode extends TraceStepNodeBase {
  nodeType: "span";
  spanId: string;
  spanKind: string;
  capabilities?: SpanCapabilities;
  childSessionId?: string;
}

export interface TraceStepObservationNode extends TraceStepNodeBase {
  nodeType: "observation";
  eventId: string;
  observationKind: string;
  ownerSpanId?: string;
}

export type TraceStepNode = TraceStepSpanNode | TraceStepObservationNode;

export interface TraceStepEdge {
  id: string;
  source: string;
  target: string;
  kind: TraceStepEdgeKind;
}

export interface TraceStepGraph {
  nodes: TraceStepNode[];
  edges: TraceStepEdge[];
}

export interface PlacedTraceStepNode {
  node: TraceStepNode;
  x: number;
  y: number;
}

export interface PlacedTraceStepEdge extends TraceStepEdge {
  path: string;
}

export interface TraceStepLayout {
  width: number;
  height: number;
  nodes: PlacedTraceStepNode[];
  edges: PlacedTraceStepEdge[];
}

export const STEP_NODE_WIDTH = 220;
export const STEP_NODE_HEIGHT = 76;
export const STEP_GAP_X = 52;
export const STEP_GAP_Y = 16;
export const STEP_PADDING = 12;

type LoosePayload = Record<string, unknown> & { type?: string };

interface RecordView {
  message: OmniMessage;
  payload: LoosePayload;
  eventId: string;
  ordinal: number;
}

interface SpanRecords {
  spanId: string;
  begin?: RecordView;
  end?: RecordView;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function recordView(message: OmniMessage, ordinal: number): RecordView {
  const payload = message.payload as LoosePayload;
  const fallback = [
    message.timestamp,
    message.trace?.step_id ?? "",
    message.trace?.span_id ?? "",
    stableJson(payload),
  ].join("|");
  const eventId = message.event_id ?? `anonymous:${fallback}`;
  return {
    message,
    payload,
    eventId,
    ordinal,
  };
}

function spanLabel(kind: string, attributes: Record<string, unknown> | undefined): string {
  switch (kind) {
    case "agent.step":
      return "Agent Step";
    case "llm.request":
      return "LLM Request";
    case "llm.attempt": {
      const attempt = attributes?.["attempt"];
      return typeof attempt === "number" || typeof attempt === "string"
        ? `LLM Attempt #${String(attempt)}`
        : "LLM Attempt";
    }
    case "tool.execute": {
      const name = attributes?.["tool_name"];
      return typeof name === "string" && name.length > 0 ? `Tool · ${name}` : "Tool Execution";
    }
    case "subagent.invoke":
      return "Subagent";
    case "memory.write":
      return "Memory Write";
    case "knowledge.write":
      return "Knowledge Write";
    default:
      return kind;
  }
}

function observationLabel(kind: string, payload: LoosePayload): string {
  if (kind === "tool.proposal") {
    const name = payload["name"];
    return typeof name === "string" && name.length > 0
      ? `Tool Proposal · ${name}`
      : "Tool Proposal";
  }
  if (kind === "tool.result") return "Tool Result";
  if (kind === "thinking") return "Thinking";
  if (kind === "output") return "Output";
  return kind;
}

function observationOf(view: RecordView): TraceStepObservationNode | null {
  const { message, payload, eventId } = view;
  const type = payload.type;
  let kind: string | null = null;
  let input: unknown;
  let output: unknown;

  if (type === "thinking" && payload["role"] === "assistant") {
    kind = "thinking";
    output = payload["thinking"];
  } else if (type === "text" && payload["role"] === "assistant") {
    kind = "output";
    output = payload["text"];
  } else if (type === "tool_call" && payload["role"] === "assistant") {
    kind = "tool.proposal";
    input = payload["arguments"];
    output = {
      name: payload["name"],
      tool_call_id: payload["tool_call_id"],
    };
  } else if (type === "tool_call_output") {
    kind = "tool.result";
    input = { tool_call_id: payload["tool_call_id"] };
    output = {
      output: payload["output"],
      ...(payload["images"] !== undefined ? { images: payload["images"] } : {}),
    };
  } else if (type === "observation") {
    kind = typeof payload["kind"] === "string" ? payload["kind"] : "observation";
    input = payload["input"];
    output = payload["output"] ?? payload["value"] ?? payload["content"] ?? payload["data"];
  }

  if (kind === null) return null;
  const ownerSpanId = message.trace?.span_id;
  const causedByEventId = message.trace?.caused_by_event_id;
  const status = typeof payload["stop_reason"] === "string" ? payload["stop_reason"] : undefined;
  return {
    id: `event:${eventId}`,
    recordOrdinal: view.ordinal,
    nodeType: "observation",
    eventId,
    observationKind: kind,
    label: observationLabel(kind, payload),
    startTs: message.timestamp,
    ...(status !== undefined ? { status } : {}),
    ...(ownerSpanId !== undefined ? { ownerSpanId } : {}),
    ...(causedByEventId !== undefined ? { causedByEventId } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    rawPayloads: [payload],
  };
}

function compareNodes(a: TraceStepNode, b: TraceStepNode): number {
  return a.recordOrdinal - b.recordOrdinal || a.id.localeCompare(b.id);
}

/** Project the explicit records of exactly one Agent Step into visible nodes and edges. */
export function projectTraceStep(records: readonly OmniMessage[], stepId: string): TraceStepGraph {
  const views = records
    .filter((message) => message.protocol_version === 3 && message.trace?.step_id === stepId)
    .map(recordView);

  const spans = new Map<string, SpanRecords>();
  const subagentPointersBySpan = new Map<string, RecordView[]>();
  for (const view of views) {
    const type = view.payload.type;
    if (type === "subagent") {
      const spanId = view.message.trace?.span_id;
      const sessionId = view.payload["session_id"];
      if (spanId !== undefined && typeof sessionId === "string" && sessionId.length > 0) {
        const pointers = subagentPointersBySpan.get(spanId);
        if (pointers === undefined) subagentPointersBySpan.set(spanId, [view]);
        else pointers.push(view);
      }
    }
    if (type !== "span_begin" && type !== "span_end") continue;
    const spanId = view.message.trace?.span_id;
    if (spanId === undefined) continue;
    const entry: SpanRecords = spans.get(spanId) ?? { spanId };
    if (type === "span_begin" && entry.begin === undefined) entry.begin = view;
    if (type === "span_end" && entry.end === undefined) entry.end = view;
    spans.set(spanId, entry);
  }

  const nodes: TraceStepNode[] = [];
  for (const span of spans.values()) {
    const beginPayload = span.begin?.payload;
    const endPayload = span.end?.payload;
    const kindValue = beginPayload?.["span_kind"] ?? endPayload?.["span_kind"];
    const spanKind = typeof kindValue === "string" ? kindValue : "unknown";
    const attributesValue = beginPayload?.["attributes"];
    const attributes =
      attributesValue !== null &&
      typeof attributesValue === "object" &&
      !Array.isArray(attributesValue)
        ? (attributesValue as Record<string, unknown>)
        : undefined;
    const capabilitiesValue = beginPayload?.["capabilities"];
    const capabilities =
      capabilitiesValue !== null &&
      typeof capabilitiesValue === "object" &&
      !Array.isArray(capabilitiesValue)
        ? (capabilitiesValue as SpanCapabilities)
        : undefined;
    const statusValue = endPayload?.["status"];
    const status = typeof statusValue === "string" ? statusValue : "running";
    const parentSpanId =
      span.begin?.message.trace?.parent_span_id ?? span.end?.message.trace?.parent_span_id;
    const causedByEventId =
      span.begin?.message.trace?.caused_by_event_id ?? span.end?.message.trace?.caused_by_event_id;
    const errorMessage = endPayload?.["error_message"];
    const usagePayload = views.find(
      (view) => view.message.trace?.span_id === span.spanId && view.payload.type === "token_usage",
    )?.payload;
    const requestUsage = plainRecord(usagePayload?.["request"]);
    const sessionUsage = plainRecord(usagePayload?.["session"]);
    const output =
      span.end || requestUsage !== undefined || sessionUsage !== undefined
        ? {
            status,
            ...(typeof errorMessage === "string" ? { error_message: errorMessage } : {}),
            ...(requestUsage !== undefined || sessionUsage !== undefined
              ? {
                  token_usage: {
                    ...(requestUsage !== undefined ? { request: requestUsage } : {}),
                    ...(sessionUsage !== undefined ? { session: sessionUsage } : {}),
                  },
                }
              : {}),
          }
        : undefined;
    const subagentPointers =
      spanKind === "subagent.invoke" ? (subagentPointersBySpan.get(span.spanId) ?? []) : [];
    const childSessionIdValue = subagentPointers[0]?.payload["session_id"];
    const childSessionId =
      typeof childSessionIdValue === "string" ? childSessionIdValue : undefined;
    const rawPayloads = [
      span.begin?.payload,
      ...(usagePayload !== undefined ? [usagePayload] : []),
      ...subagentPointers.map((pointer) => pointer.payload),
      span.end?.payload,
    ].filter((payload): payload is LoosePayload => payload !== undefined);
    nodes.push({
      id: `span:${span.spanId}`,
      recordOrdinal: Math.min(
        span.begin?.ordinal ?? Number.POSITIVE_INFINITY,
        span.end?.ordinal ?? Number.POSITIVE_INFINITY,
      ),
      nodeType: "span",
      spanId: span.spanId,
      spanKind,
      label: spanLabel(spanKind, attributes),
      startTs: span.begin?.message.timestamp ?? span.end?.message.timestamp ?? "",
      ...(span.end !== undefined ? { endTs: span.end.message.timestamp } : {}),
      status,
      ...(parentSpanId !== undefined ? { parentSpanId } : {}),
      ...(causedByEventId !== undefined ? { causedByEventId } : {}),
      ...(attributes !== undefined ? { input: attributes } : {}),
      ...(output !== undefined ? { output } : {}),
      rawPayloads,
      ...(capabilities !== undefined ? { capabilities } : {}),
      ...(childSessionId !== undefined ? { childSessionId } : {}),
    });
  }

  const observationIds = new Set<string>();
  for (const view of views) {
    if (view.payload.type === "span_begin" || view.payload.type === "span_end") continue;
    const observation = observationOf(view);
    if (observation !== null && !observationIds.has(observation.eventId)) {
      observationIds.add(observation.eventId);
      nodes.push(observation);
    }
  }
  nodes.sort(compareNodes);

  const spanNodeById = new Map(
    nodes
      .filter((node): node is TraceStepSpanNode => node.nodeType === "span")
      .map((node) => [node.spanId, node.id]),
  );
  const eventNodeById = new Map(
    nodes
      .filter((node): node is TraceStepObservationNode => node.nodeType === "observation")
      .map((node) => [node.eventId, node.id]),
  );
  const edges: TraceStepEdge[] = [];
  const seenEdges = new Set<string>();
  const addEdge = (source: string | undefined, target: string, kind: TraceStepEdgeKind) => {
    if (source === undefined || source === target) return;
    const id = `${kind}:${source}>${target}`;
    if (seenEdges.has(id)) return;
    seenEdges.add(id);
    edges.push({ id, source, target, kind });
  };

  for (const node of nodes) {
    if (node.nodeType === "span") {
      addEdge(
        node.parentSpanId === undefined ? undefined : spanNodeById.get(node.parentSpanId),
        node.id,
        "hierarchy",
      );
    } else {
      addEdge(
        node.ownerSpanId === undefined ? undefined : spanNodeById.get(node.ownerSpanId),
        node.id,
        "hierarchy",
      );
    }
    addEdge(
      node.causedByEventId === undefined ? undefined : eventNodeById.get(node.causedByEventId),
      node.id,
      "causal",
    );
  }
  edges.sort((a, b) => a.id.localeCompare(b.id));
  return { nodes, edges };
}

/**
 * Deterministic left-to-right layered layout. Protocol edges define every layer;
 * malformed cycles are left in their deterministic fallback layer instead of
 * inventing or deleting relationships.
 */
export function layoutTraceStepGraph(graph: TraceStepGraph): TraceStepLayout {
  const nodes = [...graph.nodes].sort(compareNodes);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const compareNodeIds = (a: string, b: string): number =>
    compareNodes(nodeById.get(a)!, nodeById.get(b)!);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const outgoing = new Map<string, TraceStepEdge[]>();
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
    const list = outgoing.get(edge.source);
    if (list) list.push(edge);
    else outgoing.set(edge.source, [edge]);
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  }
  for (const list of outgoing.values()) {
    list.sort((a, b) => compareNodeIds(a.target, b.target) || a.id.localeCompare(b.id));
  }

  const layer = new Map(nodes.map((node) => [node.id, 0]));
  const queue = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  queue.sort(compareNodeIds);
  while (queue.length > 0) {
    const source = queue.shift()!;
    for (const edge of outgoing.get(source) ?? []) {
      layer.set(edge.target, Math.max(layer.get(edge.target) ?? 0, (layer.get(source) ?? 0) + 1));
      const remaining = (indegree.get(edge.target) ?? 1) - 1;
      indegree.set(edge.target, remaining);
      if (remaining === 0) {
        queue.push(edge.target);
        queue.sort(compareNodeIds);
      }
    }
  }

  const byLayer = new Map<number, TraceStepNode[]>();
  for (const node of nodes) {
    const index = layer.get(node.id) ?? 0;
    const list = byLayer.get(index);
    if (list) list.push(node);
    else byLayer.set(index, [node]);
  }
  for (const list of byLayer.values()) list.sort(compareNodes);

  const maxLayer = Math.max(0, ...byLayer.keys());
  const maxRows = Math.max(1, ...[...byLayer.values()].map((items) => items.length));
  const placed: PlacedTraceStepNode[] = [];
  for (const [layerIndex, items] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
    items.forEach((node, row) => {
      placed.push({
        node,
        x: STEP_PADDING + layerIndex * (STEP_NODE_WIDTH + STEP_GAP_X),
        y: STEP_PADDING + row * (STEP_NODE_HEIGHT + STEP_GAP_Y),
      });
    });
  }
  const byId = new Map(placed.map((item) => [item.node.id, item]));
  const placedEdges: PlacedTraceStepEdge[] = graph.edges.flatMap((edge) => {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) return [];
    const x1 = source.x + STEP_NODE_WIDTH;
    const y1 = source.y + STEP_NODE_HEIGHT / 2;
    const x2 = target.x;
    const y2 = target.y + STEP_NODE_HEIGHT / 2;
    const midX = x1 + Math.max(16, (x2 - x1) / 2);
    const path = y1 === y2 ? `M ${x1} ${y1} H ${x2}` : `M ${x1} ${y1} H ${midX} V ${y2} H ${x2}`;
    return [{ ...edge, path }];
  });

  return {
    width: STEP_PADDING * 2 + (maxLayer + 1) * STEP_NODE_WIDTH + maxLayer * STEP_GAP_X,
    height: STEP_PADDING * 2 + maxRows * STEP_NODE_HEIGHT + (maxRows - 1) * STEP_GAP_Y,
    nodes: placed,
    edges: placedEdges,
  };
}
