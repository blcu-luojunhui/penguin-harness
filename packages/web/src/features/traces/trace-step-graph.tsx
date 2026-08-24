/** Read-only Span/Event graph for one explicitly recorded Agent Step. */
import { useMemo } from "react";
import { S } from "../../lib/strings";
import { humanizeDuration } from "../../lib/format";
import { layoutTraceStepGraph, STEP_NODE_HEIGHT, STEP_NODE_WIDTH } from "./trace-step-model";
import type { TraceStepGraph, TraceStepNode } from "./trace-step-model";

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Localized display label; protocol identifiers remain the fallback for future kinds. */
export function traceStepNodeLabel(node: TraceStepNode): string {
  if (node.nodeType === "observation") {
    switch (node.observationKind) {
      case "thinking":
        return S.traces.traceStepThinking;
      case "planning":
        return S.traces.traceStepPlanning;
      case "verification":
        return S.traces.traceStepVerification;
      case "evaluation":
        return S.traces.traceStepEvaluation;
      case "output":
        return S.traces.traceStepOutput;
      case "result":
        return S.traces.traceStepResult;
      case "progress":
        return S.traces.traceStepProgress;
      case "memory":
        return S.traces.traceStepMemoryObservation;
      case "knowledge":
        return S.traces.traceStepKnowledgeObservation;
      case "tool.proposal": {
        const name = recordOf(node.output)?.["name"];
        return typeof name === "string" && name.length > 0
          ? `${S.traces.traceStepToolProposal} · ${name}`
          : S.traces.traceStepToolProposal;
      }
      case "tool.result":
        return S.traces.traceStepToolResult;
      default:
        return node.observationKind;
    }
  }

  switch (node.spanKind) {
    case "agent.step":
      return S.traces.traceStepRoot;
    case "llm.request":
      return S.traces.traceStepRequest;
    case "llm.attempt": {
      const attempt = recordOf(node.input)?.["attempt"];
      return attempt === undefined
        ? S.traces.traceStepAttempt
        : S.traces.traceStepAttemptN(String(attempt));
    }
    case "tool.execute": {
      const name = recordOf(node.input)?.["tool_name"];
      return typeof name === "string" && name.length > 0
        ? `${S.traces.traceStepToolExecution} · ${name}`
        : S.traces.traceStepToolExecution;
    }
    case "subagent.invoke":
      return S.traces.traceStepSubagent;
    case "memory.write":
      return S.traces.traceStepMemoryWrite;
    case "knowledge.write":
      return S.traces.traceStepKnowledgeWrite;
    default:
      return node.spanKind;
  }
}

function durationOf(node: TraceStepNode): number | null {
  if (node.endTs === undefined) return null;
  const start = Date.parse(node.startTs);
  const end = Date.parse(node.endTs);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}

function statusClass(status: string | undefined): string {
  if (status === "completed") return "text-emerald-600 dark:text-emerald-400";
  if (status === "running") return "text-amber-600 dark:text-amber-400";
  if (status !== undefined) return "text-red-600 dark:text-red-400";
  return "text-gray-400 dark:text-gray-500";
}

function previewOf(node: TraceStepNode): string | null {
  if (typeof node.output === "string") return node.output;
  const output = recordOf(node.output);
  if (typeof output?.["output"] === "string") return output["output"];
  if (typeof output?.["status"] === "string") return output["status"];
  return null;
}

export function TraceStepGraphView({
  graph,
  selectedId,
  onSelect,
}: {
  graph: TraceStepGraph;
  selectedId: string | null;
  onSelect: (node: TraceStepNode) => void;
}) {
  const layout = useMemo(() => layoutTraceStepGraph(graph), [graph]);

  if (layout.nodes.length === 0) {
    return <p className="px-3 py-6 text-center text-xs text-gray-400">{S.traces.traceStepEmpty}</p>;
  }

  return (
    <div
      role="group"
      aria-label={S.traces.traceStepGraph}
      className="max-h-[34rem] overflow-auto rounded-md border border-gray-200 bg-gray-50/60 dark:border-gray-800 dark:bg-gray-950/40"
    >
      <div className="relative" style={{ width: layout.width, height: layout.height }}>
        <svg
          width={layout.width}
          height={layout.height}
          className="pointer-events-none absolute inset-0"
          aria-hidden
        >
          <defs>
            <marker
              id="trace-step-arrow"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="5"
              markerHeight="5"
              orient="auto"
            >
              <path d="M 0 0 L 8 4 L 0 8 z" fill="currentColor" />
            </marker>
          </defs>
          {layout.edges.map((edge) => (
            <path
              key={edge.id}
              d={edge.path}
              fill="none"
              stroke="currentColor"
              strokeWidth={edge.kind === "causal" ? 1.75 : 1.25}
              strokeDasharray={edge.kind === "causal" ? "5 4" : undefined}
              markerEnd="url(#trace-step-arrow)"
              className={
                edge.kind === "causal"
                  ? "text-amber-400 dark:text-amber-600"
                  : "text-gray-300 dark:text-gray-700"
              }
            />
          ))}
        </svg>

        {layout.nodes.map(({ node, x, y }) => {
          const selected = selectedId === node.id;
          const duration = durationOf(node);
          const preview = previewOf(node);
          const label = traceStepNodeLabel(node);
          return (
            <button
              key={node.id}
              type="button"
              aria-pressed={selected}
              aria-label={`${label} · ${
                node.nodeType === "span"
                  ? S.traces.traceStepExecutionNode
                  : S.traces.traceStepObservationNode
              }`}
              title={label}
              onClick={() => onSelect(node)}
              style={{ left: x, top: y, width: STEP_NODE_WIDTH, height: STEP_NODE_HEIGHT }}
              className={`absolute flex flex-col justify-center rounded-md border bg-white px-3 py-2 text-left shadow-sm transition-colors duration-150 dark:bg-gray-900 ${
                node.nodeType === "span" ? "border-solid" : "border-dashed"
              } ${
                selected
                  ? "border-brand-500 ring-1 ring-brand-500"
                  : "border-gray-200 hover:border-gray-300 hover:bg-gray-50 dark:border-gray-700 dark:hover:border-gray-600 dark:hover:bg-gray-800"
              }`}
            >
              <span className="flex w-full min-w-0 items-center gap-2">
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${
                    node.nodeType === "span" ? "bg-brand-500" : "bg-violet-400"
                  }`}
                />
                <span className="min-w-0 flex-1 truncate text-xs font-semibold text-gray-700 dark:text-gray-200">
                  {label}
                </span>
                <span className={`shrink-0 font-mono text-[10px] ${statusClass(node.status)}`}>
                  {node.status ?? "—"}
                </span>
              </span>
              <span className="mt-1 flex min-w-0 items-center gap-2 pl-4 text-[10px] text-gray-400 dark:text-gray-500">
                <span className="truncate font-mono">
                  {node.nodeType === "span" ? node.spanKind : node.observationKind}
                </span>
                {duration !== null && (
                  <span className="ml-auto shrink-0 font-mono">{humanizeDuration(duration)}</span>
                )}
              </span>
              {preview !== null && (
                <span className="mt-0.5 truncate pl-4 text-[10px] text-gray-500 dark:text-gray-400">
                  {preview}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
