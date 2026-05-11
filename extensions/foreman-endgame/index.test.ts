import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it } from "vitest";
import plugin, { __testing } from "./index.js";

type HandlerMap = Map<string, Array<(event: any, ctx: any) => any>>;

const SESSION_KEY = "agent:foreman:discord:channel:chan-1";
const FOREMAN_CTX = {
  agentId: "foreman",
  sessionKey: SESSION_KEY,
  channelId: "chan-1",
  trigger: "user",
};

const tempDirs: string[] = [];

async function makeHarness() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "foreman-endgame-"));
  tempDirs.push(dir);
  const statePath = path.join(dir, "state.json");
  const handlers: HandlerMap = new Map();
  const api = {
    pluginConfig: {
      statePath,
      discordChannelId: "chan-1",
      memoryWriteRoot: path.join(dir, "memory"),
    },
    on(name: string, handler: (event: any, ctx: any) => any) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    logger: { info: () => undefined, error: () => undefined },
  } as unknown as OpenClawPluginApi;
  plugin.register(api);
  const run = async (name: string, event: any, ctx = FOREMAN_CTX) => {
    let result: any;
    for (const handler of handlers.get(name) ?? []) {
      result = await handler(event, ctx);
      if (result) {
        return result;
      }
    }
    return result;
  };
  const readState = async () => JSON.parse(await readFile(statePath, "utf8")) as any;
  return { run, readState, statePath, memoryRoot: path.join(dir, "memory") };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("foreman-endgame guard helpers", () => {
  it("treats conversational build phrases as build triggers", () => {
    expect(__testing.isBuildTrigger(__testing.normalizeCommand("<@123> let's go"))).toBe(true);
    expect(__testing.isBuildTrigger(__testing.normalizeCommand("ship it"))).toBe(true);
    expect(__testing.isBuildTrigger(__testing.normalizeCommand("build"))).toBe(true);
  });

  it("keeps explicit promotion separate from ambiguous ship-it language", () => {
    expect(__testing.isGoTrigger(__testing.normalizeCommand("ok ship it"))).toBe(true);
    expect(__testing.isPromoteTrigger(__testing.normalizeCommand("promote"))).toBe(true);
    expect(__testing.isPromoteTrigger(__testing.normalizeCommand("ship it"))).toBe(false);
  });

  it("classifies validation and promotion dispatches by command text", () => {
    expect(
      __testing.classifySpawn({
        task: "Run `koolaid-app-check /data/apps/demo` and report.",
      }),
    ).toBe("check");
    expect(__testing.classifySpawn({ task: "Run `promote-to-koolaid demo`." })).toBe("promote");
    expect(__testing.classifySpawn({ task: "Repair the login form." })).toBe("worker");
  });

  it("blocks known local write and shell tool names", () => {
    expect(__testing.isCoordinatorWriteTool("Bash")).toBe(true);
    expect(__testing.isCoordinatorWriteTool("apply_patch")).toBe(true);
    expect(__testing.isCoordinatorWriteTool("mcp__filesystem__write_file")).toBe(true);
    expect(__testing.isCoordinatorWriteTool("exec_command")).toBe(true);
    expect(__testing.isCoordinatorWriteTool("file_write")).toBe(true);
    expect(__testing.isCoordinatorWriteTool("sessions_spawn")).toBe(false);
  });

  it("allows memory-only file writes while blocking app writes and shell execution", () => {
    const memoryRoot = "/home/aiserver/.openclaw/workspace-foreman/memory";
    expect(
      __testing.coordinatorToolBlockReason(
        "file_write",
        { path: `${memoryRoot}/projects/demo.md` },
        memoryRoot,
      ),
    ).toBeUndefined();
    expect(
      __testing.coordinatorToolBlockReason(
        "file_write",
        { path: "/data/apps/demo/src/app.ts" },
        memoryRoot,
      ),
    ).toContain("coordinator-only");
    expect(__testing.coordinatorToolBlockReason("exec_command", {}, memoryRoot)).toContain(
      "coordinator-only",
    );
    expect(
      __testing.coordinatorToolBlockReason("message", { action: "delete" }, memoryRoot),
    ).toContain("audit trail");
  });

  it("recognizes terminal build status messages", () => {
    expect(__testing.classifyAssistantText("koolaid-app-check passed. Ready to promote.")).toBe(
      "awaiting-promote",
    );
    expect(__testing.classifyAssistantText("koolaid-app-check failed: missing Dockerfile")).toBe(
      "check-failed",
    );
    expect(__testing.classifyAssistantText("production is live after promote-to-koolaid.")).toBe(
      "promoted",
    );
  });

  it("updates build/go state during direct gateway turns", async () => {
    const { run, readState } = await makeHarness();

    await run(
      "agent_turn_prepare",
      { prompt: "build", messages: [], queuedInjections: [] },
      {
        sessionKey: SESSION_KEY,
        channelId: "chan-1",
        trigger: "manual",
      },
    );
    let state = await readState();
    expect(state.sessions[SESSION_KEY].phase).toBe("proposed");

    await run(
      "agent_turn_prepare",
      {
        prompt: "go\n\nContext: acceptance drill",
        messages: [],
        queuedInjections: [],
      },
      { ...FOREMAN_CTX, trigger: "manual" },
    );
    state = await readState();
    expect(state.sessions[SESSION_KEY].phase).toBe("approved");
    expect(state.sessions[SESSION_KEY].goApprovedAt).toBeTruthy();
  });

  it("blocks dispatch announcements until a spawn has been accepted", async () => {
    const { run, readState } = await makeHarness();

    await run("agent_turn_prepare", {
      prompt: "build",
      messages: [],
      queuedInjections: [],
    });
    await run("agent_turn_prepare", {
      prompt: "go",
      messages: [],
      queuedInjections: [],
    });

    await expect(
      run("before_tool_call", {
        toolName: "message",
        params: {
          action: "send",
          message: "🚀 Dispatched [1/1] Scaffolding → codex/gpt-5.4-mini",
        },
      }),
    ).resolves.toMatchObject({ block: true });

    await run("before_tool_call", {
      toolName: "sessions_spawn",
      params: {
        task: "Scaffold app",
        label: "scaffold",
        agentId: "codex",
        model: "gpt-5.4-mini",
      },
    });
    await run("after_tool_call", {
      toolName: "sessions_spawn",
      params: {
        task: "Scaffold app",
        label: "scaffold",
        agentId: "codex",
        model: "gpt-5.4-mini",
      },
      result: {
        content: [
          {
            type: "text",
            text: '{\n  "status": "accepted",\n  "runId": "run-1",\n  "childSessionKey": "agent:codex:acp:child-1"\n}',
          },
        ],
      },
    });

    await expect(
      run("before_tool_call", {
        toolName: "message",
        params: {
          action: "send",
          message: "🚀 Dispatched [1/1] Scaffolding → codex/gpt-5.4-mini",
        },
      }),
    ).resolves.toBeUndefined();
    await expect(
      run("before_tool_call", {
        toolName: "message",
        params: {
          action: "send",
          message: "🚀 Dispatched [2/2] Implement → codex/gpt-5.4",
        },
      }),
    ).resolves.toMatchObject({ block: true });

    const state = await readState();
    expect(state.sessions[SESSION_KEY].dispatches).toHaveLength(1);
    expect(state.sessions[SESSION_KEY].announcedDispatches).toBe(1);
  });
});
