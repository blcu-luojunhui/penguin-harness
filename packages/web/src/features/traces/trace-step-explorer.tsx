/** Protocol-v3 logical Trace roots, Task-local Step navigation, and a read-only node inspector. */
import { useEffect, useMemo, useState } from "react";
import type { OmniMessage } from "@prismshadow/penguin-core/omnimessage";
import type {
  TraceRootResponse,
  TraceRootSubagent,
  TraceRootSummary,
  TraceStepSummary,
  TraceTaskSummary,
} from "@prismshadow/penguin-server/api";
import * as api from "../../api/endpoints";
import { apiErrorText } from "../../lib/api-error";
import { formatTime, humanizeDuration } from "../../lib/format";
import { S } from "../../lib/strings";
import { Skeleton } from "../../components/ui/skeleton";
import {
  childTraceHref,
  filterTraceSteps,
  initialRoot,
  initialStep,
  initialTask,
  recordsForTraceStep,
  showsTaskList,
  subagentForSpan,
} from "./logical-trace-model";
import { TraceStepGraphView, traceStepNodeLabel } from "./trace-step-graph";
import { projectTraceStep } from "./trace-step-model";
import type { TraceStepNode } from "./trace-step-model";

function durationOf(value: { startTs?: string; endTs?: string }): string | null {
  if (value.startTs === undefined || value.endTs === undefined) return null;
  const start = Date.parse(value.startTs);
  const end = Date.parse(value.endTs);
  return Number.isFinite(start) && Number.isFinite(end)
    ? humanizeDuration(Math.max(0, end - start))
    : null;
}

function statusTone(status: string | undefined): string {
  if (status === "completed") return "text-emerald-600 dark:text-emerald-400";
  if (status === undefined || status === "running") return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

function AuditValue({ value }: { value: unknown }) {
  if (value === undefined) return <p className="text-xs text-gray-400">—</p>;
  return (
    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-gray-100 px-2.5 py-2 text-xs text-gray-700 dark:bg-gray-800/70 dark:text-gray-300">
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}

function NodeInspector({
  node,
  subagent,
}: {
  node: TraceStepNode | null;
  subagent?: TraceRootSubagent;
}) {
  if (node === null) {
    return (
      <div className="flex min-h-40 items-center justify-center rounded-md border border-gray-200 px-4 text-center text-xs text-gray-400 dark:border-gray-800">
        {S.traces.traceStepSelectNode}
      </div>
    );
  }

  const kind = node.nodeType === "span" ? node.spanKind : node.observationKind;
  const stableId = node.nodeType === "span" ? node.spanId : node.eventId;
  const childHref = subagent === undefined ? null : childTraceHref(subagent);
  return (
    <div className="min-w-0 space-y-3 rounded-md border border-gray-200 p-3 dark:border-gray-800">
      <div>
        <p className="text-[10px] font-medium uppercase tracking-wide text-gray-400">
          {node.nodeType === "span"
            ? S.traces.traceStepExecutionNode
            : S.traces.traceStepObservationNode}
        </p>
        <h4 className="mt-0.5 truncate text-sm font-semibold" title={traceStepNodeLabel(node)}>
          {traceStepNodeLabel(node)}
        </h4>
      </div>

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt className="text-gray-400">{S.traces.traceStepKind}</dt>
        <dd className="truncate font-mono text-gray-700 dark:text-gray-300" title={kind}>
          {kind}
        </dd>
        <dt className="text-gray-400">ID</dt>
        <dd className="truncate font-mono text-gray-700 dark:text-gray-300" title={stableId}>
          {stableId}
        </dd>
        <dt className="text-gray-400">{S.traces.traceStepStatus}</dt>
        <dd className={`truncate font-mono ${statusTone(node.status)}`}>{node.status ?? "—"}</dd>
        <dt className="text-gray-400">{S.traces.traceStepStarted}</dt>
        <dd className="truncate font-mono text-gray-700 dark:text-gray-300">
          {formatTime(node.startTs)}
        </dd>
        {node.parentSpanId !== undefined && (
          <>
            <dt className="text-gray-400">parent_span_id</dt>
            <dd
              className="truncate font-mono text-gray-700 dark:text-gray-300"
              title={node.parentSpanId}
            >
              {node.parentSpanId}
            </dd>
          </>
        )}
        {node.causedByEventId !== undefined && (
          <>
            <dt className="text-gray-400">caused_by_event_id</dt>
            <dd
              className="truncate font-mono text-gray-700 dark:text-gray-300"
              title={node.causedByEventId}
            >
              {node.causedByEventId}
            </dd>
          </>
        )}
        {node.nodeType === "span" && node.childSessionId !== undefined && (
          <>
            <dt className="text-gray-400">{S.traces.traceStepChildSession}</dt>
            <dd className="min-w-0">
              {childHref === null ? (
                <span
                  className="block truncate font-mono text-gray-700 dark:text-gray-300"
                  title={node.childSessionId}
                >
                  {node.childSessionId}
                </span>
              ) : (
                <a
                  href={childHref}
                  className="block truncate font-mono text-brand-600 hover:underline dark:text-brand-400"
                  title={`${S.traces.traceStepOpenChildTrace}: ${node.childSessionId}`}
                >
                  {node.childSessionId}
                </a>
              )}
            </dd>
          </>
        )}
      </dl>

      <div>
        <p className="mb-1 text-[11px] font-medium text-gray-500">{S.traces.traceStepInput}</p>
        <AuditValue value={node.input} />
      </div>
      <div>
        <p className="mb-1 text-[11px] font-medium text-gray-500">{S.traces.traceStepOutput}</p>
        <AuditValue value={node.output} />
      </div>
      {node.nodeType === "span" && (
        <div>
          <p className="mb-1 text-[11px] font-medium text-gray-500">
            {S.traces.traceStepCapabilities}
          </p>
          <AuditValue value={node.capabilities} />
        </div>
      )}
      <details>
        <summary className="cursor-pointer text-[11px] font-medium text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
          {S.traces.traceStepRawPayload}
        </summary>
        <div className="mt-1">
          <AuditValue value={node.rawPayloads} />
        </div>
      </details>
    </div>
  );
}

/** Large root histories stay lazy: payloads are not stringified until this audit section opens. */
function RawRecords({ records }: { records: OmniMessage[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-gray-200 dark:border-gray-800">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs font-medium text-gray-500 transition-colors duration-150 hover:bg-gray-50 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800/50 dark:hover:text-gray-200"
      >
        <span>{S.traces.logicalTraceRawRecords(records.length)}</span>
        <span aria-hidden className="font-mono text-[11px]">
          {open ? "−" : "+"}
        </span>
      </button>
      {open && (
        <div className="border-t border-gray-200 p-3 dark:border-gray-800">
          <AuditValue value={records} />
        </div>
      )}
    </div>
  );
}

function RootList({
  roots,
  selectedId,
  onSelect,
}: {
  roots: TraceRootSummary[];
  selectedId: string | null;
  onSelect: (root: TraceRootSummary) => void;
}) {
  return (
    <div>
      <p className="mb-1.5 text-[11px] font-medium text-gray-500">{S.traces.logicalTraceRoots}</p>
      <div
        aria-label={S.traces.logicalTraceRoots}
        className="grid max-h-44 gap-1.5 overflow-y-auto sm:grid-cols-2 xl:grid-cols-3"
      >
        {roots.map((root, index) => {
          const selected = selectedId === root.traceId;
          const duration = durationOf(root);
          const label =
            root.rootKind === "goal_run"
              ? S.traces.logicalTraceGoalRun(index + 1)
              : root.rootKind === "task"
                ? S.traces.logicalTraceStandaloneTask(index + 1)
                : S.traces.logicalTraceUnknownRoot(index + 1);
          return (
            <button
              key={root.traceId}
              type="button"
              aria-current={selected ? "true" : undefined}
              title={root.traceId}
              onClick={() => onSelect(root)}
              className={`min-w-0 rounded-md border px-2.5 py-2 text-left transition-colors duration-150 ${
                selected
                  ? "border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-950/40 dark:text-brand-300"
                  : "border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-gray-800 dark:text-gray-400 dark:hover:bg-gray-800/60"
              }`}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-xs font-semibold">{label}</span>
                <span className={`shrink-0 font-mono text-[10px] ${statusTone(root.status)}`}>
                  {root.status ?? S.traces.inProgress}
                </span>
              </span>
              <span className="mt-1 flex min-w-0 items-center gap-2 font-mono text-[10px] opacity-70">
                <span>{S.traces.logicalTraceTaskCount(root.taskCount)}</span>
                <span>{S.traces.logicalTraceRecordCount(root.recordCount)}</span>
                {duration !== null && <span className="ml-auto">{duration}</span>}
                {root.partial && <span>{S.traces.logicalTracePartial}</span>}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function TaskList({
  tasks,
  selectedId,
  onSelect,
}: {
  tasks: TraceTaskSummary[];
  selectedId: string | null;
  onSelect: (task: TraceTaskSummary) => void;
}) {
  return (
    <div>
      <p className="mb-1.5 text-[11px] font-medium text-gray-500">{S.traces.logicalTraceTasks}</p>
      <div className="grid max-h-36 gap-1.5 overflow-y-auto sm:grid-cols-2 xl:grid-cols-3">
        {tasks.map((task, index) => {
          const selected = selectedId === task.taskId;
          const duration = durationOf(task);
          return (
            <button
              key={task.taskId}
              type="button"
              aria-pressed={selected}
              title={task.taskId}
              onClick={() => onSelect(task)}
              className={`min-w-0 rounded-md border px-2.5 py-2 text-left transition-colors duration-150 ${
                selected
                  ? "border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-950/40 dark:text-brand-300"
                  : "border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-gray-800 dark:text-gray-400 dark:hover:bg-gray-800/60"
              }`}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-xs font-semibold">
                  {S.traces.logicalTraceTask(index + 1)}
                </span>
                <span className={`shrink-0 font-mono text-[10px] ${statusTone(task.status)}`}>
                  {task.status ?? S.traces.inProgress}
                </span>
              </span>
              <span className="mt-1 flex items-center gap-2 font-mono text-[10px] opacity-70">
                <span>{S.traces.logicalTraceStepCount(task.steps.length)}</span>
                {duration !== null && <span className="ml-auto">{duration}</span>}
                {task.partial && <span>{S.traces.logicalTracePartial}</span>}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function StepList({
  task,
  selectedId,
  query,
  onQuery,
  onSelect,
}: {
  task: TraceTaskSummary;
  selectedId: string | null;
  query: string;
  onQuery: (query: string) => void;
  onSelect: (step: TraceStepSummary) => void;
}) {
  const filtered = useMemo(() => filterTraceSteps(task.steps, query), [task.steps, query]);
  return (
    <aside className="min-w-0 rounded-md border border-gray-200 p-2 dark:border-gray-800">
      <label className="block text-[11px] font-medium text-gray-500">
        {S.traces.logicalTraceSteps}
        <input
          type="search"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder={S.traces.logicalTraceSearchSteps}
          className="mt-1.5 w-full rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-xs text-gray-700 outline-none placeholder:text-gray-400 focus:border-brand-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
        />
      </label>
      <div
        aria-label={S.traces.logicalTraceSteps}
        className="mt-2 max-h-[30rem] space-y-1 overflow-y-auto"
      >
        {filtered.length === 0 ? (
          <p className="px-2 py-5 text-center text-xs text-gray-400">
            {S.traces.logicalTraceNoMatchingSteps}
          </p>
        ) : (
          filtered.map((step) => {
            const originalIndex = task.steps.findIndex((item) => item.stepId === step.stepId);
            const selected = selectedId === step.stepId;
            const duration = durationOf(step);
            return (
              <button
                key={step.stepId}
                type="button"
                aria-current={selected ? "step" : undefined}
                title={step.stepId}
                onClick={() => onSelect(step)}
                className={`w-full min-w-0 rounded px-2 py-1.5 text-left transition-colors duration-150 ${
                  selected
                    ? "bg-brand-50 text-brand-700 dark:bg-brand-950/40 dark:text-brand-300"
                    : "text-gray-600 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-800/60"
                }`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">
                    {S.traces.logicalTraceStep(originalIndex + 1)}
                  </span>
                  <span className={`shrink-0 font-mono text-[10px] ${statusTone(step.status)}`}>
                    {step.status ?? S.traces.inProgress}
                  </span>
                </span>
                <span className="mt-0.5 flex min-w-0 items-center gap-2 font-mono text-[10px] opacity-65">
                  <span>{S.traces.logicalTraceRecordCount(step.recordCount)}</span>
                  {duration !== null && <span className="ml-auto">{duration}</span>}
                  {step.partial && <span>{S.traces.logicalTracePartial}</span>}
                </span>
              </button>
            );
          })
        )}
      </div>
    </aside>
  );
}

export function LogicalTraceExplorer({
  projectId,
  agentId,
  sessionId,
  initialTraceId = null,
  initialTaskId = null,
}: {
  projectId: string;
  agentId: string;
  sessionId: string;
  initialTraceId?: string | null;
  initialTaskId?: string | null;
}) {
  const [inventory, setInventory] = useState<Awaited<
    ReturnType<typeof api.getAgentTraceRoots>
  > | null>(null);
  const [inventoryError, setInventoryError] = useState<string | null>(null);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TraceRootResponse | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [stepQuery, setStepQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    setInventory(null);
    setInventoryError(null);
    setSelectedTraceId(null);
    setDetail(null);
    setDetailError(null);
    setSelectedTaskId(null);
    setSelectedStepId(null);
    setSelectedNodeId(null);
    setStepQuery("");
    api
      .getAgentTraceRoots(projectId, agentId, sessionId)
      .then((response) => {
        if (cancelled) return;
        setInventory(response);
        if (response.supported && response.roots.length > 0) {
          setSelectedTraceId(initialRoot(response.roots, initialTraceId)?.traceId ?? null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setInventoryError(apiErrorText(error));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, agentId, sessionId, initialTraceId]);

  useEffect(() => {
    if (selectedTraceId === null) return;
    let cancelled = false;
    setDetail(null);
    setDetailError(null);
    setSelectedTaskId(null);
    setSelectedStepId(null);
    setSelectedNodeId(null);
    setStepQuery("");
    api
      .getAgentTraceRoot(projectId, agentId, sessionId, selectedTraceId)
      .then((response) => {
        if (cancelled) return;
        const preferredTaskId =
          initialTraceId === null || selectedTraceId === initialTraceId ? initialTaskId : null;
        const task = initialTask(response.root, response.tasks, preferredTaskId);
        const step = initialStep(task);
        setDetail(response);
        setSelectedTaskId(task?.taskId ?? null);
        setSelectedStepId(step?.stepId ?? null);
      })
      .catch((error: unknown) => {
        if (!cancelled) setDetailError(apiErrorText(error));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, agentId, sessionId, selectedTraceId, initialTraceId, initialTaskId]);

  const selectedTask = detail?.tasks.find((task) => task.taskId === selectedTaskId) ?? null;
  const selectedStep = selectedTask?.steps.find((step) => step.stepId === selectedStepId) ?? null;
  const stepRecords = useMemo(
    () =>
      detail === null || selectedStep === null
        ? []
        : recordsForTraceStep(detail.records, selectedStep.stepId),
    [detail, selectedStep],
  );
  const graph = useMemo(
    () =>
      selectedStep === null
        ? { nodes: [], edges: [] }
        : projectTraceStep(stepRecords, selectedStep.stepId),
    [selectedStep, stepRecords],
  );

  useEffect(() => {
    if (selectedStep === null) {
      setSelectedNodeId(null);
      return;
    }
    const rootId = `span:${selectedStep.spanId ?? selectedStep.stepId}`;
    setSelectedNodeId(
      graph.nodes.some((node) => node.id === rootId) ? rootId : (graph.nodes[0]?.id ?? null),
    );
  }, [selectedStep, graph]);

  const selectedNode = graph.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedSubagent =
    detail !== null &&
    selectedNode?.nodeType === "span" &&
    selectedNode.childSessionId !== undefined
      ? subagentForSpan(detail.subagents, selectedNode.childSessionId, selectedNode.spanId)
      : undefined;

  const selectRoot = (root: TraceRootSummary) => {
    if (root.traceId !== selectedTraceId) setSelectedTraceId(root.traceId);
  };
  const selectTask = (task: TraceTaskSummary) => {
    setSelectedTaskId(task.taskId);
    setSelectedStepId(initialStep(task)?.stepId ?? null);
    setSelectedNodeId(null);
    setStepQuery("");
  };
  const selectStep = (step: TraceStepSummary) => {
    setSelectedStepId(step.stepId);
    setSelectedNodeId(null);
  };

  return (
    <section className="rounded-md border border-gray-200 p-3 dark:border-gray-800">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-semibold text-gray-600 dark:text-gray-300">
          {S.traces.logicalTraceExplorer}
        </h3>
        {inventory?.supported === true && (
          <span className="rounded bg-brand-50 px-1.5 py-0.5 font-mono text-[10px] text-brand-600 dark:bg-brand-950/40 dark:text-brand-300">
            v{inventory.protocolVersion}
          </span>
        )}
      </div>

      {inventoryError !== null ? (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400">{inventoryError}</p>
      ) : inventory === null ? (
        <Skeleton className="mt-3 h-36" />
      ) : !inventory.supported ? (
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          {S.traces.logicalTraceLegacyUnavailable}
        </p>
      ) : inventory.roots.length === 0 ? (
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          {S.traces.logicalTraceNoneRecorded}
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          <RootList roots={inventory.roots} selectedId={selectedTraceId} onSelect={selectRoot} />

          {selectedTraceId === null ? (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {S.traces.logicalTraceRootUnavailable}
            </p>
          ) : detailError !== null ? (
            <p className="text-xs text-red-600 dark:text-red-400">{detailError}</p>
          ) : detail === null ? (
            <Skeleton className="h-72" />
          ) : detail.tasks.length === 0 ? (
            <p className="rounded-md border border-gray-200 px-3 py-6 text-center text-xs text-gray-400 dark:border-gray-800">
              {S.traces.logicalTraceNoTasks}
            </p>
          ) : (
            <div className="space-y-3">
              {showsTaskList(detail.root, detail.tasks) && (
                <TaskList tasks={detail.tasks} selectedId={selectedTaskId} onSelect={selectTask} />
              )}

              {selectedTask !== null && selectedTask.steps.length === 0 ? (
                <p className="rounded-md border border-gray-200 px-3 py-6 text-center text-xs text-gray-400 dark:border-gray-800">
                  {S.traces.logicalTraceNoSteps}
                </p>
              ) : selectedTask !== null ? (
                <div className="grid min-w-0 gap-3 lg:grid-cols-[15rem_minmax(0,1fr)]">
                  <StepList
                    task={selectedTask}
                    selectedId={selectedStepId}
                    query={stepQuery}
                    onQuery={setStepQuery}
                    onSelect={selectStep}
                  />
                  <div className="min-w-0 space-y-3">
                    {selectedStep !== null && (
                      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
                        <span className="font-semibold text-gray-700 dark:text-gray-200">
                          {S.traces.logicalTraceStep(
                            selectedTask.steps.findIndex(
                              (step) => step.stepId === selectedStep.stepId,
                            ) + 1,
                          )}
                        </span>
                        <span className={statusTone(selectedStep.status)}>
                          {selectedStep.status ?? S.traces.inProgress}
                        </span>
                        {selectedStep.startTs !== undefined && (
                          <span className="font-mono">{formatTime(selectedStep.startTs)}</span>
                        )}
                        {selectedStep.partial && <span>{S.traces.logicalTracePartial}</span>}
                      </div>
                    )}
                    <div className="grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1fr)_20rem]">
                      <TraceStepGraphView
                        graph={graph}
                        selectedId={selectedNodeId}
                        onSelect={(node) => setSelectedNodeId(node.id)}
                      />
                      <NodeInspector node={selectedNode} subagent={selectedSubagent} />
                    </div>
                  </div>
                </div>
              ) : null}

              <RawRecords key={detail.root.traceId} records={detail.records} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
