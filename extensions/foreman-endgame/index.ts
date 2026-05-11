import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

type ForemanEndgameConfig = {
  agentId?: string;
  statePath?: string;
  discordChannelId?: string;
};

type BuildPhase =
  | "collab"
  | "proposed"
  | "approved"
  | "building"
  | "checking"
  | "awaiting-promote"
  | "promote-approved"
  | "promoting"
  | "promoted"
  | "check-failed"
  | "aborted";

type DispatchRecord = {
  runId?: string;
  childSessionKey?: string;
  label?: string;
  agentId?: string;
  model?: string;
  kind: SpawnKind;
  acceptedAt: string;
};

type BuildSessionState = {
  sessionKey: string;
  phase: BuildPhase;
  updatedAt: string;
  buildRequestedAt?: string;
  goApprovedAt?: string;
  promoteApprovedAt?: string;
  dispatches: DispatchRecord[];
  lastError?: string;
};

type StateFile = {
  version: 1;
  sessions: Record<string, BuildSessionState>;
};

type SpawnKind = "worker" | "check" | "promote";

const DEFAULT_STATE_PATH = "/home/aiserver/.openclaw/foreman-endgame/state.json";
const WRITE_TOOLS = new Set([
  "Bash",
  "Edit",
  "MultiEdit",
  "Write",
  "apply_patch",
  "bash",
  "edit",
  "exec",
  "process",
  "multi_edit",
  "multiedit",
  "write",
  "mcp__openclaw__file_write",
]);

function isCoordinatorWriteTool(toolName: string): boolean {
  if (WRITE_TOOLS.has(toolName)) {
    return true;
  }
  const normalized = toolName.toLowerCase();
  return (
    normalized.endsWith("__file_write") ||
    normalized.endsWith("__write_file") ||
    normalized.endsWith("__edit_file") ||
    normalized.endsWith("__apply_patch") ||
    normalized.endsWith("__exec") ||
    normalized.endsWith("__shell") ||
    normalized.endsWith("__bash")
  );
}

function isConfig(value: unknown): value is ForemanEndgameConfig {
  return value !== null && typeof value === "object";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(getText).filter(Boolean).join("\n");
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return getText(record.text ?? record.content ?? record.value ?? "");
  }
  return "";
}

function normalizeCommand(text: string): string {
  return text
    .toLowerCase()
    .replace(/<@!?\d+>/gu, " ")
    .replace(/[`*_~]/gu, "")
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function includesDiscordChannel(sessionKey: string | undefined, discordChannelId: string): boolean {
  return Boolean(sessionKey?.includes(`discord:channel:${discordChannelId}`));
}

function isTargetForeman(
  ctx: { agentId?: string; sessionKey?: string; channelId?: string },
  agentId: string,
  discordChannelId: string | undefined,
): boolean {
  if (ctx.agentId !== agentId) {
    return false;
  }
  if (!discordChannelId) {
    return true;
  }
  return (
    ctx.channelId === discordChannelId || includesDiscordChannel(ctx.sessionKey, discordChannelId)
  );
}

function emptyState(): StateFile {
  return { version: 1, sessions: {} };
}

async function readStateFile(statePath: string): Promise<StateFile> {
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<StateFile>;
    if (parsed?.version === 1 && parsed.sessions && typeof parsed.sessions === "object") {
      return parsed as StateFile;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
  return emptyState();
}

async function writeStateFile(statePath: string, state: StateFile): Promise<void> {
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function sessionStateFor(state: StateFile, sessionKey: string): BuildSessionState {
  const existing = state.sessions[sessionKey];
  if (existing) {
    return existing;
  }
  const created: BuildSessionState = {
    sessionKey,
    phase: "collab",
    updatedAt: new Date().toISOString(),
    dispatches: [],
  };
  state.sessions[sessionKey] = created;
  return created;
}

function setPhase(session: BuildSessionState, phase: BuildPhase, now: string): void {
  session.phase = phase;
  session.updatedAt = now;
}

function isActivePhase(phase: BuildPhase): boolean {
  return !["collab", "promoted", "aborted", "check-failed"].includes(phase);
}

function isBuildTrigger(command: string): boolean {
  return [
    "build",
    "build it",
    "lets build",
    "let's build",
    "lets go",
    "let's go",
    "kick it off",
    "ship it",
    "start build",
    "start the build",
    "foreman go",
  ].includes(command);
}

function isGoTrigger(command: string): boolean {
  return [
    "go",
    "yes",
    "yep",
    "approved",
    "approve",
    "do it",
    "run it",
    "ok ship it",
    "ship it",
    "lets go",
    "let's go",
    "looks good",
    "green light",
    "foreman go",
  ].includes(command);
}

function isPromoteTrigger(command: string): boolean {
  return [
    "promote",
    "promote it",
    "ship to prod",
    "push to prod",
    "push production",
    "deploy to prod",
    "deploy production",
  ].includes(command);
}

function isAbortTrigger(command: string): boolean {
  return ["abort", "cancel", "stop", "pause", "hold", "hold on", "wait", "wait up"].includes(
    command,
  );
}

function classifySpawn(params: Record<string, unknown>): SpawnKind {
  const task = getText(params.task).toLowerCase();
  if (task.includes("promote-to-koolaid")) {
    return "promote";
  }
  if (task.includes("koolaid-app-check")) {
    return "check";
  }
  return "worker";
}

function isAcceptedSpawn(result: unknown): boolean {
  if (result !== null && typeof result === "object") {
    const record = result as Record<string, unknown>;
    if (record.status === "accepted") {
      return true;
    }
    if (Array.isArray(record.content)) {
      return record.content.some((entry) => getText(entry).includes('"status":"accepted"'));
    }
  }
  return getText(result).includes('"status":"accepted"');
}

function extractRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function extractAcceptedSpawn(result: unknown): Record<string, unknown> {
  const direct = extractRecord(result);
  if (direct.status === "accepted") {
    return direct;
  }
  const text = getText(result);
  try {
    const parsed = JSON.parse(text) as unknown;
    return extractRecord(parsed);
  } catch {
    return {};
  }
}

function classifyAssistantText(text: string): BuildPhase | undefined {
  const lower = text.toLowerCase();
  if (
    /koolaid-app-check[\s\S]{0,80}\b(pass|passed|success|succeeded)\b/u.test(lower) ||
    /\b(check|validation)[\s\S]{0,80}\b(pass|passed|success|succeeded)\b/u.test(lower) ||
    lower.includes("awaiting promote") ||
    lower.includes("ready to promote")
  ) {
    return "awaiting-promote";
  }
  if (
    /koolaid-app-check[\s\S]{0,80}\b(fail|failed|error)\b/u.test(lower) ||
    /\b(check|validation)[\s\S]{0,80}\b(fail|failed|error)\b/u.test(lower)
  ) {
    return "check-failed";
  }
  if (
    /promote-to-koolaid[\s\S]{0,120}\b(done|complete|completed|success|succeeded)\b/u.test(lower) ||
    /\bproduction[\s\S]{0,120}\b(live|deployed|promoted)\b/u.test(lower)
  ) {
    return "promoted";
  }
  return undefined;
}

function messageRole(message: unknown): string | undefined {
  if (message !== null && typeof message === "object") {
    const role = (message as Record<string, unknown>).role;
    return typeof role === "string" ? role : undefined;
  }
  return undefined;
}

function messageText(message: unknown): string {
  if (message !== null && typeof message === "object") {
    const record = message as Record<string, unknown>;
    return getText(record.content ?? record.text ?? record.message ?? "");
  }
  return getText(message);
}

export default definePluginEntry({
  id: "foreman-endgame",
  name: "Foreman Endgame Guard",
  description: "Hard gates Foreman build/go/promote workflow and coordinator-only actions.",
  register(api: OpenClawPluginApi) {
    const cfg = isConfig(api.pluginConfig) ? api.pluginConfig : {};
    const agentId = stringValue(cfg.agentId) ?? "foreman";
    const statePath = stringValue(cfg.statePath) ?? DEFAULT_STATE_PATH;
    const discordChannelId = stringValue(cfg.discordChannelId);

    let stateChain: Promise<unknown> = Promise.resolve();
    const updateState = async <T>(mutator: (state: StateFile) => T | Promise<T>): Promise<T> => {
      const run = stateChain.then(async () => {
        const state = await readStateFile(statePath);
        const result = await mutator(state);
        await writeStateFile(statePath, state);
        return result;
      });
      stateChain = run.catch(() => undefined);
      return await run;
    };

    api.on("before_agent_reply", async (event, ctx) => {
      if (ctx.trigger !== "user" || !isTargetForeman(ctx, agentId, discordChannelId)) {
        return undefined;
      }

      const sessionKey = ctx.sessionKey;
      if (!sessionKey) {
        return undefined;
      }

      const command = normalizeCommand(event.cleanedBody);
      if (!command) {
        return undefined;
      }

      if (isAbortTrigger(command)) {
        await updateState((state) => {
          const session = sessionStateFor(state, sessionKey);
          setPhase(session, "aborted", new Date().toISOString());
        });
        return undefined;
      }

      if (isGoTrigger(command) || isBuildTrigger(command)) {
        const reply = await updateState((state) => {
          const session = sessionStateFor(state, sessionKey);
          if (isGoTrigger(command) && session.phase === "proposed") {
            const now = new Date().toISOString();
            setPhase(session, "approved", now);
            session.goApprovedAt = now;
            return undefined;
          }
          if (!isBuildTrigger(command)) {
            return `There is no proposed build plan waiting for go (state: ${session.phase}). Say "build" first so Foreman can summarize the brief and task plan.`;
          }
          if (isActivePhase(session.phase)) {
            return `A build is already in progress for this channel (state: ${session.phase}). Finish it, abort it, or promote it before starting another one.`;
          }
          const now = new Date().toISOString();
          setPhase(session, "proposed", now);
          session.buildRequestedAt = now;
          session.dispatches = [];
          session.lastError = undefined;
          return undefined;
        });
        return reply
          ? { handled: true, reply: { text: reply }, reason: "foreman-build-active" }
          : undefined;
      }

      if (isPromoteTrigger(command)) {
        const reply = await updateState((state) => {
          const session = sessionStateFor(state, sessionKey);
          if (session.phase !== "awaiting-promote") {
            return `Nothing is ready to promote yet (state: ${session.phase}). Foreman must run and pass koolaid-app-check before promotion can be approved.`;
          }
          const now = new Date().toISOString();
          setPhase(session, "promote-approved", now);
          session.promoteApprovedAt = now;
          return undefined;
        });
        return reply
          ? { handled: true, reply: { text: reply }, reason: "foreman-promote-without-check" }
          : undefined;
      }

      return undefined;
    });

    api.on("before_tool_call", async (event, ctx) => {
      if (!isTargetForeman(ctx, agentId, discordChannelId)) {
        return undefined;
      }

      const toolName = event.toolName;
      if (isCoordinatorWriteTool(toolName)) {
        return {
          block: true,
          blockReason:
            "Foreman is coordinator-only. Dispatch coding or shell work to ACP workers instead of using local write/exec tools.",
        };
      }

      if (toolName !== "sessions_spawn") {
        return undefined;
      }

      const sessionKey = ctx.sessionKey;
      if (!sessionKey) {
        return undefined;
      }

      const kind = classifySpawn(event.params);
      const blockReason = await updateState((state) => {
        const session = sessionStateFor(state, sessionKey);
        if (kind === "worker") {
          if (session.phase !== "approved" && session.phase !== "building") {
            return `Worker dispatch blocked: current Foreman build state is ${session.phase}; dispatch requires explicit go after a proposed build plan.`;
          }
          setPhase(session, "building", new Date().toISOString());
          return undefined;
        }
        if (kind === "check") {
          if (
            session.phase !== "building" &&
            session.phase !== "approved" &&
            session.phase !== "checking"
          ) {
            return `Deploy-shape check blocked: current Foreman build state is ${session.phase}; checks are only allowed after build approval and worker dispatch.`;
          }
          setPhase(session, "checking", new Date().toISOString());
          return undefined;
        }
        if (session.phase !== "promote-approved" && session.phase !== "promoting") {
          return `Promotion blocked: current Foreman build state is ${session.phase}; a human must say "promote" after koolaid-app-check passes.`;
        }
        setPhase(session, "promoting", new Date().toISOString());
        return undefined;
      });

      return blockReason ? { block: true, blockReason } : undefined;
    });

    api.on("after_tool_call", async (event, ctx) => {
      if (
        event.toolName === "sessions_spawn" &&
        event.error &&
        isTargetForeman(ctx, agentId, discordChannelId) &&
        ctx.sessionKey
      ) {
        const kind = classifySpawn(event.params);
        await updateState((state) => {
          const session = sessionStateFor(state, ctx.sessionKey ?? "");
          const now = new Date().toISOString();
          session.lastError = event.error;
          if (kind === "worker") {
            setPhase(session, "approved", now);
          } else if (kind === "check") {
            setPhase(session, "building", now);
          } else {
            setPhase(session, "promote-approved", now);
          }
        });
        return;
      }

      if (
        event.toolName !== "sessions_spawn" ||
        event.error ||
        !isAcceptedSpawn(event.result) ||
        !isTargetForeman(ctx, agentId, discordChannelId) ||
        !ctx.sessionKey
      ) {
        return;
      }

      const params = event.params;
      const result = extractAcceptedSpawn(event.result);
      const kind = classifySpawn(params);
      await updateState((state) => {
        const session = sessionStateFor(state, ctx.sessionKey ?? "");
        const now = new Date().toISOString();
        session.dispatches.push({
          kind,
          acceptedAt: now,
          runId: stringValue(result.runId),
          childSessionKey: stringValue(result.childSessionKey),
          label: stringValue(params.label),
          agentId: stringValue(params.agentId),
          model: stringValue(params.model),
        });
        if (kind === "worker") {
          setPhase(session, "building", now);
        } else if (kind === "check") {
          setPhase(session, "checking", now);
        } else {
          setPhase(session, "promoting", now);
        }
      });
    });

    api.on("before_message_write", (event, ctx) => {
      if (!isTargetForeman(ctx, agentId, discordChannelId) || !ctx.sessionKey) {
        return undefined;
      }
      const role = messageRole(event.message);
      if (role && role !== "assistant") {
        return undefined;
      }
      const phase = classifyAssistantText(messageText(event.message));
      if (!phase) {
        return undefined;
      }
      void updateState((state) => {
        const session = sessionStateFor(state, ctx.sessionKey ?? "");
        setPhase(session, phase, new Date().toISOString());
      }).catch((err) => {
        api.logger.error?.(`foreman-endgame: failed to persist message state: ${String(err)}`);
      });
      return undefined;
    });

    api.logger.info?.(
      `foreman-endgame: guarding agent=${agentId} state=${statePath}${discordChannelId ? ` discordChannel=${discordChannelId}` : ""}`,
    );
  },
});

export const __testing = {
  classifyAssistantText,
  classifySpawn,
  isBuildTrigger,
  isCoordinatorWriteTool,
  isGoTrigger,
  isPromoteTrigger,
  normalizeCommand,
};
