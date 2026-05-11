import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import {
  createManagedTaskFlow,
  resetTaskFlowRegistryForTests,
} from "../tasks/task-flow-registry.js";
import {
  createTaskRecord,
  linkTaskToFlowById,
  resetTaskRegistryDeliveryRuntimeForTests,
  resetTaskRegistryForTests,
} from "../tasks/task-registry.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  tasksAuditJsonCommand,
  tasksLedgerJsonCommand,
  tasksListJsonCommand,
} from "./tasks-json.js";

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

function readJsonLog(runtime: RuntimeEnv): unknown {
  return JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0]));
}

async function withTaskJsonStateDir(run: () => Promise<void>): Promise<void> {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-tasks-json-command-" },
    async () => {
      resetTaskRegistryDeliveryRuntimeForTests();
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      try {
        await run();
      } finally {
        resetTaskRegistryDeliveryRuntimeForTests();
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });
      }
    },
  );
}

describe("tasks JSON commands", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetTaskRegistryDeliveryRuntimeForTests();
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
  });

  it("lists task records with runtime and status filters", async () => {
    await withTaskJsonStateDir(async () => {
      createTaskRecord({
        runtime: "cli",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        runId: "run-cli",
        status: "running",
        task: "Inspect issue backlog",
      });
      createTaskRecord({
        runtime: "cron",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        runId: "run-cron",
        status: "queued",
        task: "Refresh schedule",
      });

      const runtime = createRuntime();
      await tasksListJsonCommand({ json: true, runtime: "cli", status: "running" }, runtime);

      const payload = readJsonLog(runtime) as {
        count: number;
        runtime: string | null;
        status: string | null;
        tasks: Array<{ runtime: string; status: string; runId: string }>;
      };
      expect(payload).toMatchObject({
        count: 1,
        runtime: "cli",
        status: "running",
      });
      expect(payload.tasks).toEqual([
        expect.objectContaining({
          runtime: "cli",
          status: "running",
          runId: "run-cli",
        }),
      ]);
    });
  });

  it("emits a backend-neutral canonical run ledger for shopfloor consumers", async () => {
    await withTaskJsonStateDir(async () => {
      const ownerKey = "agent:foreman:discord:channel:123";
      const flow = createManagedTaskFlow({
        ownerKey,
        controllerId: "foreman-endgame",
        goal: "Build stockbot smoke app",
        status: "running",
      });
      const run = createTaskRecord({
        runtime: "acp",
        ownerKey,
        requesterSessionKey: ownerKey,
        scopeKind: "session",
        childSessionKey: "agent:claude:acp:child",
        agentId: "foreman",
        runId: "run-acp-1",
        label: "stockbot-smoke",
        status: "running",
        task: "Build the stockbot smoke app",
        progressSummary: "Editing files",
      });
      linkTaskToFlowById({
        taskId: run.taskId,
        flowId: flow.flowId,
      });
      createTaskRecord({
        runtime: "cli",
        ownerKey,
        requesterSessionKey: ownerKey,
        scopeKind: "session",
        agentId: "codex",
        runId: "run-cli-1",
        label: "other",
        status: "succeeded",
        task: "Unrelated task",
      });

      const runtime = createRuntime();
      await tasksLedgerJsonCommand(
        {
          json: true,
          runtime: "acp",
          status: "running",
          agent: "claude",
          owner: ownerKey,
          label: "stockbot",
        },
        runtime,
      );

      const payload = readJsonLog(runtime) as {
        schemaVersion: number;
        source: string;
        count: number;
        filters: Record<string, string | null>;
        summary: { active: number; byRuntime: Record<string, number> };
        runs: Array<{
          canonicalRunKey: string;
          updatedAt: number;
          workerAgentId: string;
          runtime: string;
          agentId: string;
          runId: string;
          childSessionKey: string;
          progressSummary: string;
          active_path?: string;
        }>;
        flowCount: number;
        flows: Array<{ id: string; goal: string }>;
      };
      expect(payload).toMatchObject({
        schemaVersion: 1,
        source: "task-registry",
        count: 1,
        filters: {
          runtime: "acp",
          status: "running",
          agent: "claude",
          owner: ownerKey,
          label: "stockbot",
        },
      });
      expect(payload.summary.active).toBe(1);
      expect(payload.summary.byRuntime.acp).toBe(1);
      expect(payload.runs).toEqual([
        expect.objectContaining({
          canonicalRunKey: "run-acp-1",
          workerAgentId: "claude",
          runtime: "acp",
          agentId: "foreman",
          runId: "run-acp-1",
          childSessionKey: "agent:claude:acp:child",
          progressSummary: "Editing files",
        }),
      ]);
      expect(payload.runs[0]?.updatedAt).toEqual(expect.any(Number));
      expect(payload.runs[0]).not.toHaveProperty("active_path");
      expect(payload.flowCount).toBe(1);
      expect(payload.flows).toEqual([expect.objectContaining({ id: flow.flowId })]);
    });
  });

  it("keeps audit JSON shape and combined task-flow sorting", async () => {
    await withTaskJsonStateDir(async () => {
      const now = Date.now();
      vi.useFakeTimers();
      vi.setSystemTime(now - 40 * 60_000);
      createTaskRecord({
        runtime: "cli",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        runId: "task-stale-running",
        status: "running",
        task: "Inspect issue backlog",
      });
      vi.setSystemTime(now);
      const runningFlow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/tasks-json-command",
        goal: "Running flow",
        status: "running",
        createdAt: now - 45 * 60_000,
        updatedAt: now - 45 * 60_000,
      });
      createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/tasks-json-command",
        goal: "Waiting flow",
        status: "waiting",
        createdAt: now - 40 * 60_000,
        updatedAt: now - 40 * 60_000,
      });

      const runtime = createRuntime();
      await tasksAuditJsonCommand({ json: true, limit: 1 }, runtime);

      const payload = readJsonLog(runtime) as {
        count: number;
        filteredCount: number;
        displayed: number;
        filters: { limit: number | null };
        summary: {
          byCode: Record<string, number>;
          taskFlows: { byCode: Record<string, number> };
          combined: { total: number; errors: number; warnings: number };
        };
        findings: Array<{ kind: string; code: string; token?: string }>;
      };
      expect(payload.count).toBe(5);
      expect(payload.filteredCount).toBe(5);
      expect(payload.displayed).toBe(1);
      expect(payload.filters.limit).toBe(1);
      expect(payload.summary.byCode.stale_running).toBe(1);
      expect(payload.summary.taskFlows.byCode.stale_running).toBe(1);
      expect(payload.summary.taskFlows.byCode.stale_waiting).toBe(1);
      expect(payload.summary.taskFlows.byCode.missing_linked_tasks).toBe(2);
      expect(payload.summary.combined).toEqual({
        total: 5,
        errors: 3,
        warnings: 2,
      });
      expect(payload.findings).toEqual([
        expect.objectContaining({
          kind: "task_flow",
          code: "stale_running",
          token: runningFlow.flowId,
        }),
      ]);
    });
  });
});
