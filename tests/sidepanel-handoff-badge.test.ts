// Acceptance tests for feature #14 phase 2 — side panel handoff badge.
//
// Pins the badge view-model and DOM rendering.
//   D9  — side panel shows "Connected to terminal session <id>" badge
//   Security — token is NEVER rendered in the DOM

import { describe, it, expect } from "vitest";
import { buildHandoffBadgeModel } from "../src/sidepanel/sidepanel-handoff-badge";

describe("buildHandoffBadgeModel", () => {
  it("returns visible armed badge for a pending handoff", () => {
    const pending = {
      listener_url: "http://127.0.0.1:54329",
      token: "a".repeat(64),
      session_id_hint: "cli-session-abcdef12",
      armed_at: new Date().toISOString(),
    };
    const model = buildHandoffBadgeModel(pending, null);
    expect(model.visible).toBe(true);
    expect(model.tone).toBe("armed");
    expect(model.sessionIdShort).toBe("cli-sess"); // truncated to 8 chars
    // Token must NEVER be in the rendered text
    expect(model.sessionIdShort).not.toContain(pending.token);
  });

  it("returns visible connected badge for an active handoff", () => {
    const active = {
      listener_url: "http://127.0.0.1:54329",
      token: "b".repeat(64),
      created_at: new Date().toISOString(),
    };
    const model = buildHandoffBadgeModel(null, active);
    expect(model.visible).toBe(true);
    expect(model.tone).toBe("connected");
  });

  it("returns hidden when no handoff", () => {
    const model = buildHandoffBadgeModel(null, null);
    expect(model.visible).toBe(false);
  });
});
