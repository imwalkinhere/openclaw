import type { RuntimeEnv } from "../runtime.js";
import { writeRuntimeJson } from "../runtime.js";
import { parseAgentSessionKey } from "../sessions/session-key-utils.js";
import { listTaskRecords } from "../tasks/runtime-internal.js";
import {
  mapTaskFlowView,
  mapTaskRunAggregateSummary,
  mapTaskRunView,
} from "../tasks/task-domain-views.js";
import {
  listTaskFlowAuditFindings,
  summarizeTaskFlowAuditFindings,
  type TaskFlowAuditCode,
  type TaskFlowAuditSeverity,
} from "../tasks/task-flow-registry.audit.js";
import type { TaskFlowRecord } from "../tasks/task-flow-registry.types.js";
import { listTaskFlowRecords } from "../tasks/task-flow-runtime-internal.js";
import {
  listTaskAuditFindings,
  summarizeTaskAuditFindings,
  type TaskAuditCode,
  type TaskAuditSeverity,
} from "../tasks/task-registry.audit.js";
import { compareTaskAuditFindingSortKeys } from "../tasks/task-registry.audit.shared.js";
import { summarizeTaskRecords } from "../tasks/task-registry.summary.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";

type TaskSystemAuditCode = TaskAuditCode | TaskFlowAuditCode;
type TaskSystemAuditSeverity = TaskAuditSeverity | TaskFlowAuditSeverity;

type TaskSystemAuditFinding = {
  kind: "task" | "task_flow";
  severity: TaskSystemAuditSeverity;
  code: TaskSystemAuditCode;
  detail: string;
  ageMs?: number;
  status?: string;
  token?: string;
  task?: TaskRecord;
  flow?: TaskFlowRecord;
};

function listTaskJsonRecords(): TaskRecord[] {
  // Keep the routed JSON path a read-only store snapshot; maintenance reconciliation imports
  // broader task runtimes and can keep JSON-only CLI processes alive.
  return listTaskRecords();
}

export type TasksListJsonArgs = {
  json?: boolean;
  runtime?: string;
  status?: string;
};

export type TasksAuditJsonArgs = {
  json?: boolean;
  severity?: string;
  code?: string;
  limit?: number;
};

export type TasksLedgerJsonArgs = {
  json?: boolean;
  runtime?: string;
  status?: string;
  agent?: string;
  owner?: string;
  label?: string;
};

type TaskLedgerFilters = {
  runtime: string | undefined;
  status: string | undefined;
  agent: string | undefined;
  owner: string | undefined;
  label: string | undefined;
};

function compareSystemAuditFindings(left: TaskSystemAuditFinding, right: TaskSystemAuditFinding) {
  return compareTaskAuditFindingSortKeys(
    {
      severity: left.severity,
      ageMs: left.ageMs,
      createdAt: left.task?.createdAt ?? left.flow?.createdAt ?? 0,
    },
    {
      severity: right.severity,
      ageMs: right.ageMs,
      createdAt: right.task?.createdAt ?? right.flow?.createdAt ?? 0,
    },
  );
}

function toSystemAuditFindings(params: {
  severityFilter?: TaskSystemAuditSeverity;
  codeFilter?: TaskSystemAuditCode;
}) {
  const tasks = listTaskJsonRecords();
  const flows = listTaskFlowRecords();
  const taskFindings = listTaskAuditFindings({ tasks });
  const flowFindings = listTaskFlowAuditFindings({ flows });
  const allFindings: TaskSystemAuditFinding[] = [
    ...taskFindings.map((finding) => ({
      kind: "task" as const,
      severity: finding.severity,
      code: finding.code,
      detail: finding.detail,
      ageMs: finding.ageMs,
      status: finding.task.status,
      token: finding.task.taskId,
      task: finding.task,
    })),
    ...flowFindings.map((finding) => ({
      kind: "task_flow" as const,
      severity: finding.severity,
      code: finding.code,
      detail: finding.detail,
      ageMs: finding.ageMs,
      status: finding.flow?.status ?? "n/a",
      token: finding.flow?.flowId,
      ...(finding.flow ? { flow: finding.flow } : {}),
    })),
  ];
  const filteredFindings = allFindings
    .filter((finding) => {
      if (params.severityFilter && finding.severity !== params.severityFilter) {
        return false;
      }
      if (params.codeFilter && finding.code !== params.codeFilter) {
        return false;
      }
      return true;
    })
    .toSorted(compareSystemAuditFindings);
  const sortedAllFindings = [...allFindings].toSorted(compareSystemAuditFindings);
  return {
    allFindings: sortedAllFindings,
    filteredFindings,
    taskFindings,
    summary: {
      total: sortedAllFindings.length,
      errors: sortedAllFindings.filter((finding) => finding.severity === "error").length,
      warnings: sortedAllFindings.filter((finding) => finding.severity !== "error").length,
      taskFlows: summarizeTaskFlowAuditFindings(flowFindings),
    },
  };
}

function buildTasksListJsonPayload(opts: TasksListJsonArgs) {
  const runtimeFilter = opts.runtime?.trim();
  const statusFilter = opts.status?.trim();
  const tasks = listTaskJsonRecords().filter((task) => {
    if (runtimeFilter && task.runtime !== runtimeFilter) {
      return false;
    }
    if (statusFilter && task.status !== statusFilter) {
      return false;
    }
    return true;
  });
  return {
    count: tasks.length,
    runtime: runtimeFilter ?? null,
    status: statusFilter ?? null,
    tasks,
  };
}

function normalizeFilter(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function taskUpdatedAt(task: TaskRecord): number {
  return task.lastEventAt ?? task.endedAt ?? task.startedAt ?? task.createdAt;
}

function taskCanonicalRunKey(task: TaskRecord): string {
  return task.runId ?? task.sourceId ?? task.taskId;
}

function taskLedgerGroupKey(task: TaskRecord): string {
  return [
    task.runtime,
    task.scopeKind,
    taskCanonicalRunKey(task),
    task.ownerKey,
    task.childSessionKey ?? "",
    task.parentFlowId ?? "",
  ].join("\u001f");
}

function taskDeliveryStatusRank(status: TaskRecord["deliveryStatus"]): number {
  switch (status) {
    case "delivered":
      return 6;
    case "session_queued":
      return 5;
    case "pending":
      return 4;
    case "failed":
      return 3;
    case "parent_missing":
      return 2;
    case "not_applicable":
      return 1;
  }
}

function pickTaskLedgerRecord(left: TaskRecord, right: TaskRecord): TaskRecord {
  const deliveryRankDiff =
    taskDeliveryStatusRank(right.deliveryStatus) - taskDeliveryStatusRank(left.deliveryStatus);
  if (deliveryRankDiff > 0) {
    return right;
  }
  if (deliveryRankDiff < 0) {
    return left;
  }
  const updatedAtDiff = taskUpdatedAt(right) - taskUpdatedAt(left);
  if (updatedAtDiff > 0) {
    return right;
  }
  if (updatedAtDiff < 0) {
    return left;
  }
  if (right.createdAt > left.createdAt) {
    return right;
  }
  return left;
}

function dedupeTaskLedgerRecords(tasks: TaskRecord[]): TaskRecord[] {
  const byCanonicalRun = new Map<string, TaskRecord>();
  for (const task of tasks) {
    const key = taskLedgerGroupKey(task);
    const previous = byCanonicalRun.get(key);
    byCanonicalRun.set(key, previous ? pickTaskLedgerRecord(previous, task) : task);
  }
  return [...byCanonicalRun.values()];
}

function taskWorkerAgentId(task: TaskRecord): string | undefined {
  return parseAgentSessionKey(task.childSessionKey)?.agentId ?? task.agentId;
}

function taskMatchesLedgerFilters(task: TaskRecord, filters: TaskLedgerFilters): boolean {
  if (filters.runtime && task.runtime !== filters.runtime) {
    return false;
  }
  if (filters.status && task.status !== filters.status) {
    return false;
  }
  if (filters.agent && taskWorkerAgentId(task) !== filters.agent) {
    return false;
  }
  if (filters.owner && task.ownerKey !== filters.owner) {
    return false;
  }
  if (filters.label) {
    const haystacks = [task.label, task.task].filter((item): item is string => Boolean(item));
    const labelFilter = filters.label.toLowerCase();
    if (!haystacks.some((item) => item.toLowerCase().includes(labelFilter))) {
      return false;
    }
  }
  return true;
}

export function buildTasksLedgerJsonPayload(opts: TasksLedgerJsonArgs) {
  const filters: TaskLedgerFilters = {
    runtime: normalizeFilter(opts.runtime),
    status: normalizeFilter(opts.status),
    agent: normalizeFilter(opts.agent),
    owner: normalizeFilter(opts.owner),
    label: normalizeFilter(opts.label),
  };
  const tasks = dedupeTaskLedgerRecords(
    listTaskJsonRecords().filter((task) => taskMatchesLedgerFilters(task, filters)),
  );
  const linkedFlowIds = new Set(
    tasks.map((task) => task.parentFlowId).filter((flowId): flowId is string => Boolean(flowId)),
  );
  const flows =
    linkedFlowIds.size > 0
      ? listTaskFlowRecords().filter((flow) => {
          if (filters.owner && flow.ownerKey !== filters.owner) {
            return false;
          }
          return linkedFlowIds.has(flow.flowId);
        })
      : [];

  return {
    schemaVersion: 1,
    source: "task-registry",
    generatedAt: Date.now(),
    filters: {
      runtime: filters.runtime ?? null,
      status: filters.status ?? null,
      agent: filters.agent ?? null,
      owner: filters.owner ?? null,
      label: filters.label ?? null,
    },
    count: tasks.length,
    summary: mapTaskRunAggregateSummary(summarizeTaskRecords(tasks)),
    runs: tasks.map((task) => ({
      canonicalRunKey: taskCanonicalRunKey(task),
      updatedAt: taskUpdatedAt(task),
      workerAgentId: taskWorkerAgentId(task) ?? null,
      ...mapTaskRunView(task),
    })),
    flowCount: flows.length,
    flows: flows.map((flow) => mapTaskFlowView(flow)),
  };
}

function buildTasksAuditJsonPayload(opts: TasksAuditJsonArgs) {
  const severityFilter = opts.severity?.trim() as TaskSystemAuditSeverity | undefined;
  const codeFilter = opts.code?.trim() as TaskSystemAuditCode | undefined;
  const { allFindings, filteredFindings, taskFindings, summary } = toSystemAuditFindings({
    severityFilter,
    codeFilter,
  });
  const limit = typeof opts.limit === "number" && opts.limit > 0 ? opts.limit : undefined;
  const displayed = limit ? filteredFindings.slice(0, limit) : filteredFindings;
  const legacySummary = summarizeTaskAuditFindings(taskFindings);
  return {
    count: allFindings.length,
    filteredCount: filteredFindings.length,
    displayed: displayed.length,
    filters: {
      severity: severityFilter ?? null,
      code: codeFilter ?? null,
      limit: limit ?? null,
    },
    summary: {
      ...legacySummary,
      taskFlows: summary.taskFlows,
      combined: {
        total: summary.total,
        errors: summary.errors,
        warnings: summary.warnings,
      },
    },
    findings: displayed,
  };
}

export async function tasksListJsonCommand(
  opts: TasksListJsonArgs,
  runtime: RuntimeEnv,
): Promise<void> {
  writeRuntimeJson(runtime, buildTasksListJsonPayload(opts));
}

export async function tasksAuditJsonCommand(
  opts: TasksAuditJsonArgs,
  runtime: RuntimeEnv,
): Promise<void> {
  writeRuntimeJson(runtime, buildTasksAuditJsonPayload(opts));
}

export async function tasksLedgerJsonCommand(
  opts: TasksLedgerJsonArgs,
  runtime: RuntimeEnv,
): Promise<void> {
  writeRuntimeJson(runtime, buildTasksLedgerJsonPayload(opts));
}
