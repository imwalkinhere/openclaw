import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

type ForemanEndgameConfig = {
  agentId?: string;
  statePath?: string;
  discordChannelId?: string;
  memoryWriteRoot?: string;
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
  announcedDispatches?: number;
  lastError?: string;
};

type StateFile = {
  version: 1;
  sessions: Record<string, BuildSessionState>;
};

type SpawnKind = "worker" | "check" | "promote";

const DEFAULT_STATE_PATH = "/home/aiserver/.openclaw/foreman-endgame/state.json";
const DEFAULT_MEMORY_WRITE_ROOT = "/home/aiserver/.openclaw/workspace-foreman/memory";
const WRITE_TOOLS = new Set([
  "Bash",
  "Edit",
  "MultiEdit",
  "Write",
  "apply_patch",
  "bash",
  "edit",
  "exec",
  "exec_command",
  "process",
  "shell",
  "multi_edit",
  "multiedit",
  "write",
  "file_write",
  "mcp__openclaw__file_write",
]);
const MESSAGE_MUTATION_ACTIONS = new Set(["delete", "edit", "unsend"]);

function baseToolName(toolName: string): string {
  return toolName.split("__").pop()?.toLowerCase() ?? toolName.toLowerCase();
}

function isCoordinatorWriteTool(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  const base = baseToolName(toolName);
  if (WRITE_TOOLS.has(toolName) || WRITE_TOOLS.has(normalized) || WRITE_TOOLS.has(base)) {
    return true;
  }
  return (
    normalized.endsWith("__file_write") ||
    normalized.endsWith("__write_file") ||
    normalized.endsWith("__edit_file") ||
    normalized.endsWith("__apply_patch") ||
    normalized.endsWith("__exec") ||
    normalized.endsWith("__exec_command") ||
    normalized.endsWith("__shell") ||
    normalized.endsWith("__bash")
  );
}

function resolveToolPath(params: Record<string, unknown>): string | undefined {
  return stringValue(params.path) ?? stringValue(params.file_path) ?? stringValue(params.filePath);
}

function isPathInside(candidate: string | undefined, root: string): boolean {
  if (!candidate) {
    return false;
  }
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  return (
    resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
  );
}

function isMemoryWriteToolAllowed(
  toolName: string,
  params: Record<string, unknown>,
  memoryWriteRoot: string,
): boolean {
  return (
    baseToolName(toolName) === "file_write" &&
    isPathInside(resolveToolPath(params), memoryWriteRoot)
  );
}

function coordinatorToolBlockReason(
  toolName: string,
  params: Record<string, unknown>,
  memoryWriteRoot: string,
): string | undefined {
  if (baseToolName(toolName) === "message") {
    const action = stringValue(params.action)?.toLowerCase();
    if (action && MESSAGE_MUTATION_ACTIONS.has(action)) {
      return "Foreman cannot delete or edit channel messages; the Discord build audit trail must stay append-only.";
    }
  }
  if (!isCoordinatorWriteTool(toolName)) {
    return undefined;
  }
  if (isMemoryWriteToolAllowed(toolName, params, memoryWriteRoot)) {
    return undefined;
  }
  return "Foreman is coordinator-only. Dispatch coding or shell work to ACP workers instead of using local write/exec tools.";
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
    .replace(/^\[[^\]]+\]\s*/u, "")
    .toLowerCase()
    .replace(/<@!?\d+>/gu, " ")
    .replace(/[`*_~]/gu, "")
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function commandCandidates(text: string): string[] {
  const candidates = [normalizeCommand(text)];
  const firstLine = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  if (firstLine) {
    candidates.push(normalizeCommand(firstLine));
  }
  return [...new Set(candidates.filter(Boolean))];
}

function commandMatches(text: string, predicate: (command: string) => boolean): boolean {
  return commandCandidates(text).some(predicate);
}

function includesDiscordChannel(sessionKey: string | undefined, discordChannelId: string): boolean {
  return Boolean(sessionKey?.includes(`discord:channel:${discordChannelId}`));
}

function isTargetForeman(
  ctx: { agentId?: string; sessionKey?: string; channelId?: string },
  agentId: string,
  discordChannelId: string | undefined,
): boolean {
  const sessionMatchesAgent = ctx.sessionKey?.startsWith(`agent:${agentId}:`) ?? false;
  if (ctx.agentId !== agentId && !sessionMatchesAgent) {
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

function readStateFileSync(statePath: string): StateFile {
  try {
    const raw = readFileSync(statePath, "utf8");
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

function writeStateFileSync(statePath: string, state: StateFile): void {
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
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

function resetForProposedBuild(session: BuildSessionState, now: string): void {
  setPhase(session, "proposed", now);
  session.buildRequestedAt = now;
  session.goApprovedAt = undefined;
  session.promoteApprovedAt = undefined;
  session.dispatches = [];
  session.announcedDispatches = 0;
  session.lastError = undefined;
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
  return (
    ["abort", "cancel", "stop", "pause", "hold", "hold on", "wait", "wait up"].includes(command) ||
    command.startsWith("abort ") ||
    command.startsWith("cancel ") ||
    command.startsWith("stop ") ||
    command.startsWith("pause ")
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

function isHumanInitiatedBuildTrigger(trigger: string | undefined): boolean {
  return !trigger || trigger === "user" || trigger === "manual";
}

function applyHumanCommandTransition(
  session: BuildSessionState,
  text: string,
  now: string,
): string | undefined {
  if (commandMatches(text, isAbortTrigger)) {
    setPhase(session, "aborted", now);
    return undefined;
  }

  if (commandMatches(text, isGoTrigger) || commandMatches(text, isBuildTrigger)) {
    if (commandMatches(text, isGoTrigger) && session.phase === "proposed") {
      setPhase(session, "approved", now);
      session.goApprovedAt = now;
      return undefined;
    }
    if (!commandMatches(text, isBuildTrigger)) {
      return `There is no proposed build plan waiting for go (state: ${session.phase}). Say "build" first so Foreman can summarize the brief and task plan.`;
    }
    if (isActivePhase(session.phase)) {
      return `A build is already in progress for this channel (state: ${session.phase}). Finish it, abort it, or promote it before starting another one.`;
    }
    resetForProposedBuild(session, now);
    return undefined;
  }

  if (commandMatches(text, isPromoteTrigger)) {
    if (session.phase !== "awaiting-promote") {
      return `Nothing is ready to promote yet (state: ${session.phase}). Foreman must run and pass koolaid-app-check before promotion can be approved.`;
    }
    setPhase(session, "promote-approved", now);
    session.promoteApprovedAt = now;
    return undefined;
  }

  return undefined;
}

function isDispatchAnnouncementText(text: string): boolean {
  return /^\s*(?:🚀\s*)?dispatched\b/iu.test(text);
}

function messageToolText(params: Record<string, unknown>): string {
  return getText(params.message ?? params.text ?? params.content ?? "");
}

function isOutboundMessageSend(toolName: string, params: Record<string, unknown>): boolean {
  return (
    baseToolName(toolName) === "message" && stringValue(params.action)?.toLowerCase() === "send"
  );
}

function isAcceptedSpawn(result: unknown): boolean {
  const acceptedPattern = /"status"\s*:\s*"accepted"/u;
  if (result !== null && typeof result === "object") {
    const record = result as Record<string, unknown>;
    if (record.status === "accepted") {
      return true;
    }
    if (Array.isArray(record.content)) {
      return record.content.some((entry) => acceptedPattern.test(getText(entry)));
    }
  }
  return acceptedPattern.test(getText(result));
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
    /\baborted\b/u.test(lower) ||
    /\bbuild\s+(?:was\s+)?cancelled\b/u.test(lower) ||
    /\bnot\s+dispatch(?:ing)?\b[\s\S]{0,120}\babort/u.test(lower)
  ) {
    return "aborted";
  }
  if (
    lower.includes("brief:") &&
    lower.includes("task plan") &&
    (lower.includes("waiting for explicit") ||
      lower.includes("say **go**") ||
      lower.includes("say go"))
  ) {
    return "proposed";
  }
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

function isFailedSubagentOutcome(outcome: unknown): boolean {
  return (
    outcome === "error" || outcome === "timeout" || outcome === "killed" || outcome === "reset"
  );
}

function findDispatchForEndedSubagent(
  session: BuildSessionState,
  params: { runId?: string; childSessionKey?: string },
): DispatchRecord | undefined {
  const runId = stringValue(params.runId);
  const childSessionKey = stringValue(params.childSessionKey);
  if (!runId && !childSessionKey) {
    return undefined;
  }
  return session.dispatches
    .slice()
    .reverse()
    .find(
      (dispatch) =>
        (runId && dispatch.runId === runId) ||
        (childSessionKey && dispatch.childSessionKey === childSessionKey),
    );
}

function applyFailedDispatchTransition(
  session: BuildSessionState,
  dispatch: DispatchRecord | undefined,
  error: string,
  now: string,
): void {
  session.lastError = error;
  if (!isActivePhase(session.phase)) {
    session.updatedAt = now;
    return;
  }
  if (dispatch?.kind === "promote" || session.phase === "promoting") {
    setPhase(session, "awaiting-promote", now);
    return;
  }
  setPhase(session, "check-failed", now);
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
    const memoryWriteRoot = stringValue(cfg.memoryWriteRoot) ?? DEFAULT_MEMORY_WRITE_ROOT;
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
    const updateStateSync = <T>(mutator: (state: StateFile) => T): T => {
      const state = readStateFileSync(statePath);
      const result = mutator(state);
      writeStateFileSync(statePath, state);
      return result;
    };

    api.on("agent_turn_prepare", async (event, ctx) => {
      if (
        !isHumanInitiatedBuildTrigger(ctx.trigger) ||
        !isTargetForeman(ctx, agentId, discordChannelId)
      ) {
        return undefined;
      }
      const sessionKey = ctx.sessionKey;
      if (!sessionKey) {
        return undefined;
      }
      await updateState((state) => {
        const session = sessionStateFor(state, sessionKey);
        applyHumanCommandTransition(session, event.prompt, new Date().toISOString());
      });
      return undefined;
    });

    api.on("before_agent_reply", async (event, ctx) => {
      if (
        !isHumanInitiatedBuildTrigger(ctx.trigger) ||
        !isTargetForeman(ctx, agentId, discordChannelId)
      ) {
        return undefined;
      }

      const sessionKey = ctx.sessionKey;
      if (!sessionKey) {
        return undefined;
      }

      if (commandCandidates(event.cleanedBody).length === 0) {
        return undefined;
      }

      if (
        commandMatches(event.cleanedBody, isAbortTrigger) ||
        commandMatches(event.cleanedBody, isBuildTrigger) ||
        commandMatches(event.cleanedBody, isGoTrigger) ||
        commandMatches(event.cleanedBody, isPromoteTrigger)
      ) {
        const reply = await updateState((state) =>
          applyHumanCommandTransition(
            sessionStateFor(state, sessionKey),
            event.cleanedBody,
            new Date().toISOString(),
          ),
        );
        return reply
          ? {
              handled: true,
              reply: { text: reply },
              reason: "foreman-build-state-gate",
            }
          : undefined;
      }

      return undefined;
    });

    api.on("before_tool_call", async (event, ctx) => {
      if (!isTargetForeman(ctx, agentId, discordChannelId)) {
        return undefined;
      }

      const toolName = event.toolName;
      const sessionKey = ctx.sessionKey;
      const coordinatorBlockReason = coordinatorToolBlockReason(
        toolName,
        event.params,
        memoryWriteRoot,
      );
      if (coordinatorBlockReason) {
        return {
          block: true,
          blockReason: coordinatorBlockReason,
        };
      }

      if (
        isOutboundMessageSend(toolName, event.params) &&
        isDispatchAnnouncementText(messageToolText(event.params))
      ) {
        if (!sessionKey) {
          return {
            block: true,
            blockReason:
              "Dispatch announcement blocked: Foreman session context is missing, so no accepted worker can be verified.",
          };
        }
        const blockReason = await updateState((state) => {
          const session = sessionStateFor(state, sessionKey);
          const announcedDispatches = session.announcedDispatches ?? 0;
          if (session.dispatches.length <= announcedDispatches) {
            return "Dispatch announcement blocked: Foreman may only announce a worker after sessions_spawn returns accepted.";
          }
          session.announcedDispatches = announcedDispatches + 1;
          session.updatedAt = new Date().toISOString();
          return undefined;
        });
        return blockReason ? { block: true, blockReason } : undefined;
      }

      if (baseToolName(toolName) !== "sessions_spawn") {
        return undefined;
      }

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
        baseToolName(event.toolName) === "sessions_spawn" &&
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
        baseToolName(event.toolName) !== "sessions_spawn" ||
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
        session.announcedDispatches ??= 0;
        if (kind === "worker") {
          setPhase(session, "building", now);
        } else if (kind === "check") {
          setPhase(session, "checking", now);
        } else {
          setPhase(session, "promoting", now);
        }
      });
    });

    api.on("subagent_ended", async (event, ctx) => {
      const requesterSessionKey = ctx.requesterSessionKey;
      if (
        !requesterSessionKey ||
        !isTargetForeman({ sessionKey: requesterSessionKey }, agentId, discordChannelId) ||
        !isFailedSubagentOutcome(event.outcome)
      ) {
        return;
      }
      await updateState((state) => {
        const session = sessionStateFor(state, requesterSessionKey);
        const dispatch = findDispatchForEndedSubagent(session, {
          runId: event.runId ?? ctx.runId,
          childSessionKey: event.targetSessionKey ?? ctx.childSessionKey,
        });
        if (!dispatch && !isActivePhase(session.phase)) {
          return;
        }
        const label = dispatch?.label ? ` ${dispatch.label}` : "";
        const error = event.error || event.reason || `worker${label} ended with ${event.outcome}`;
        applyFailedDispatchTransition(session, dispatch, error, new Date().toISOString());
      });
    });

    api.on("before_message_write", (event, ctx) => {
      if (!isTargetForeman(ctx, agentId, discordChannelId) || !ctx.sessionKey) {
        return undefined;
      }
      const role = messageRole(event.message);
      const text = messageText(event.message);
      if (role === "user") {
        try {
          updateStateSync((state) => {
            applyHumanCommandTransition(
              sessionStateFor(state, ctx.sessionKey ?? ""),
              text,
              new Date().toISOString(),
            );
          });
        } catch (err) {
          api.logger.error?.(`foreman-endgame: failed to persist user state: ${String(err)}`);
        }
        return undefined;
      }
      if (role && role !== "assistant") {
        return undefined;
      }
      const phase = classifyAssistantText(text);
      if (!phase) {
        return undefined;
      }
      try {
        updateStateSync((state) => {
          const session = sessionStateFor(state, ctx.sessionKey ?? "");
          const now = new Date().toISOString();
          if (phase === "proposed") {
            resetForProposedBuild(session, now);
            return;
          }
          setPhase(session, phase, now);
        });
      } catch (err) {
        api.logger.error?.(`foreman-endgame: failed to persist message state: ${String(err)}`);
      }
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
  commandCandidates,
  commandMatches,
  coordinatorToolBlockReason,
  isFailedSubagentOutcome,
  isDispatchAnnouncementText,
  isAbortTrigger,
  isBuildTrigger,
  isCoordinatorWriteTool,
  isGoTrigger,
  isPromoteTrigger,
  normalizeCommand,
};
