import { describe, expect, it } from "vitest";
import { __testing } from "./index.js";

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
      __testing.classifySpawn({ task: "Run `koolaid-app-check /data/apps/demo` and report." }),
    ).toBe("check");
    expect(__testing.classifySpawn({ task: "Run `promote-to-koolaid demo`." })).toBe("promote");
    expect(__testing.classifySpawn({ task: "Repair the login form." })).toBe("worker");
  });

  it("blocks known local write and shell tool names", () => {
    expect(__testing.isCoordinatorWriteTool("Bash")).toBe(true);
    expect(__testing.isCoordinatorWriteTool("apply_patch")).toBe(true);
    expect(__testing.isCoordinatorWriteTool("mcp__filesystem__write_file")).toBe(true);
    expect(__testing.isCoordinatorWriteTool("sessions_spawn")).toBe(false);
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
});
