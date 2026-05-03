// @vitest-environment jsdom
//
// Feature-17 acceptance — DOM-presence/absence per state for the
// pause-first lifecycle surface. Each test mounts the side panel, drives
// it into the relevant state, and asserts that lifecycle buttons are
// either present (querySelector !== null) OR structurally absent
// (querySelector === null) — never display:none.
//
// DoD coverage:
//   DoD-1, DoD-2, DoD-3, DoD-4, DoD-8, DoD-14
//
// Ids tested:
//   #start-btn, #pause-btn, #download-btn, #clear-btn, #end-btn
// Legacy ids that MUST be absent:
//   #stop-btn, #discard-btn, #reset-btn

import { describe, it, expect, beforeEach } from "vitest";
import { mountSidePanel, type SidePanelDeps } from "../src/sidepanel/sidepanel";
import type { Message, TimelineEvent } from "../src/types";
import {
  setHandoffConfig,
  clearHandoffConfig,
} from "../src/lib/handoff-store";

type StorageListener = (
  changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
  area: string,
) => void;
type FocusListener = (windowId: number) => void;
type RuntimeListener = (msg: Message) => void;

interface Harness {
  deps: SidePanelDeps;
  sent: Message[];
  fireRuntimeMessage: (msg: Message) => void;
}

function clearBody() {
  while (document.body.firstChild) {
    document.body.removeChild(document.body.firstChild);
  }
}

function makeHarness(initialEvents: TimelineEvent[] = []): Harness {
  const root = document.createElement("div");
  root.id = "sidepanel-root";
  document.body.appendChild(root);

  const sent: Message[] = [];
  const storageListeners = new Set<StorageListener>();
  const focusListeners = new Set<FocusListener>();
  const runtimeListeners = new Set<RuntimeListener>();
  let recordingState = false;
  let pausedState = false;

  const deps: SidePanelDeps = {
    root,
    sendMessage: async (msg: Message) => {
      sent.push(msg);
      if (msg.type === "GET_SESSION_STATE") {
        return {
          recording: recordingState,
          paused: pausedState,
          status: recordingState ? (pausedState ? "paused" : "running") : "idle",
          piiMode: "full",
        };
      }
      if (msg.type === "GET_SESSION_METRICS") {
        return { startTime: "", eventCount: 0, screenshotCount: 0, eventsSizeBytes: 0, screenshotsSizeBytes: 0 };
      }
      if (msg.type === "GET_EVENTS_SNAPSHOT") {
        return { events: initialEvents, screenshots: {} };
      }
      if (msg.type === "START_SESSION") {
        recordingState = true;
        pausedState = false;
        return { recording: true, sessionId: "s1", warnings: [], status: "running" };
      }
      if (msg.type === "PAUSE_SESSION") {
        pausedState = true;
        return { paused: true, status: "paused" };
      }
      if (msg.type === "RESUME_SESSION") {
        pausedState = false;
        return { paused: false, status: "running" };
      }
      if (msg.type === "DISCARD_SESSION") {
        recordingState = false;
        pausedState = false;
        return { status: "idle", discarded: true };
      }
      return undefined;
    },
    onChanged: {
      addListener: (l) => storageListeners.add(l),
      removeListener: (l) => storageListeners.delete(l),
    },
    onWindowFocusChanged: {
      addListener: (l) => focusListeners.add(l),
      removeListener: (l) => focusListeners.delete(l),
    },
    onRuntimeMessage: {
      addListener: (l) => runtimeListeners.add(l),
      removeListener: (l) => runtimeListeners.delete(l),
    },
    getCurrentWindowId: async () => 7,
    getFirstRunSeen: async () => true,
    markFirstRunSeen: async () => {},
    initialEvents,
    initialScreenshots: {},
    initialPiiMode: "full",
  };

  return {
    deps,
    sent,
    fireRuntimeMessage: (msg) => {
      for (const l of runtimeListeners) l(msg);
    },
  };
}

beforeEach(async () => {
  clearBody();
  await clearHandoffConfig().catch(() => {});
});

async function startThenPause(deps: SidePanelDeps): Promise<void> {
  deps.root.querySelector<HTMLButtonElement>("#start-btn")!.click();
  await new Promise((r) => setTimeout(r, 0));
  deps.root.querySelector<HTMLButtonElement>("#pause-btn")!.click();
  await new Promise((r) => setTimeout(r, 0));
}

// ─────────────────────────────────────────────────────────────────────
// DoD-1 — Pre-session
// ─────────────────────────────────────────────────────────────────────

describe("feature-17 DoD-1 — pre-session control surface", () => {
  it("shows Start, PII picker, connection-status pill; hides every active-session lifecycle button", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);

    expect(h.deps.root.querySelector("#start-btn")).not.toBeNull();
    expect(h.deps.root.querySelector("#pii-mode-fieldset")).not.toBeNull();
    expect(h.deps.root.querySelector("#handoff-status")).not.toBeNull();
    // No active-session lifecycle buttons.
    expect(h.deps.root.querySelector("#pause-btn")).toBeNull();
    expect(h.deps.root.querySelector("#download-btn")).toBeNull();
    expect(h.deps.root.querySelector("#clear-btn")).toBeNull();
    expect(h.deps.root.querySelector("#end-btn")).toBeNull();
    // Legacy ids must be absent from the pre-session DOM.
    expect(h.deps.root.querySelector("#stop-btn")).toBeNull();
    expect(h.deps.root.querySelector("#discard-btn")).toBeNull();
    expect(h.deps.root.querySelector("#reset-btn")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// DoD-2 — Active (running) session shows ONLY Pause as lifecycle.
// ─────────────────────────────────────────────────────────────────────

describe("feature-17 DoD-2 — active (running) lifecycle surface", () => {
  it("shows Pause and hides Download / Clear / End mid-recording", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    h.deps.root.querySelector<HTMLButtonElement>("#start-btn")!.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(h.deps.root.querySelector("#pause-btn")).not.toBeNull();
    expect(h.deps.root.querySelector("#download-btn")).toBeNull();
    expect(h.deps.root.querySelector("#clear-btn")).toBeNull();
    expect(h.deps.root.querySelector("#end-btn")).toBeNull();
    // Legacy ids must be absent.
    expect(h.deps.root.querySelector("#stop-btn")).toBeNull();
    expect(h.deps.root.querySelector("#discard-btn")).toBeNull();
    expect(h.deps.root.querySelector("#reset-btn")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// DoD-3, DoD-4 — Paused state contextual matrix.
// ─────────────────────────────────────────────────────────────────────

describe("feature-17 DoD-3 — paused: Resume + Download/Clear (when events) + End (when listener)", () => {
  it("paused with events and listener attached: Pause/Download/Clear/End all present", async () => {
    await setHandoffConfig({
      listener_url: "http://127.0.0.1:54329",
      token: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      created_at: "2026-04-12T00:00:00.000Z",
    });
    const events: TimelineEvent[] = [
      {
        seq: 1,
        type: "console_error",
        level: "error",
        message: "boom",
        timestamp: "2026-04-12T00:00:00.000Z",
        page_url: "https://example.com/",
      } as unknown as TimelineEvent,
    ];
    const h = makeHarness(events);
    await mountSidePanel(h.deps);
    await startThenPause(h.deps);

    expect(h.deps.root.querySelector("#pause-btn")).not.toBeNull();
    expect(h.deps.root.querySelector("#download-btn")).not.toBeNull();
    expect(h.deps.root.querySelector("#clear-btn")).not.toBeNull();
    expect(h.deps.root.querySelector("#end-btn")).not.toBeNull();
  });
});

describe("feature-17 DoD-4 — empty paused (no events, no listener) shows ONLY Resume", () => {
  it("Download, Clear, End are absent when timeline is empty", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    await startThenPause(h.deps);

    // Pause button is the Resume affordance via label-swap.
    expect(h.deps.root.querySelector("#pause-btn")).not.toBeNull();
    expect(h.deps.root.querySelector("#download-btn")).toBeNull();
    expect(h.deps.root.querySelector("#clear-btn")).toBeNull();
    expect(h.deps.root.querySelector("#end-btn")).toBeNull();
  });
});

describe("feature-17 — paused with events but NO listener", () => {
  it("shows Pause + Download + Clear; End is absent without a handoff config (DoD-14)", async () => {
    const events: TimelineEvent[] = [
      {
        seq: 1,
        type: "console_error",
        level: "error",
        message: "boom",
        timestamp: "2026-04-12T00:00:00.000Z",
        page_url: "https://example.com/",
      } as unknown as TimelineEvent,
    ];
    const h = makeHarness(events);
    await mountSidePanel(h.deps);
    await startThenPause(h.deps);

    expect(h.deps.root.querySelector("#pause-btn")).not.toBeNull();
    expect(h.deps.root.querySelector("#download-btn")).not.toBeNull();
    expect(h.deps.root.querySelector("#clear-btn")).not.toBeNull();
    // End must be structurally absent without a handoff config.
    expect(h.deps.root.querySelector("#end-btn")).toBeNull();
  });
});

describe("feature-17 — paused with listener but NO events", () => {
  it("shows Pause + End; Download and Clear are absent (no material timeline)", async () => {
    await setHandoffConfig({
      listener_url: "http://127.0.0.1:54329",
      token: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      created_at: "2026-04-12T00:00:00.000Z",
    });
    const h = makeHarness();
    await mountSidePanel(h.deps);
    await startThenPause(h.deps);

    expect(h.deps.root.querySelector("#pause-btn")).not.toBeNull();
    expect(h.deps.root.querySelector("#end-btn")).not.toBeNull();
    expect(h.deps.root.querySelector("#download-btn")).toBeNull();
    expect(h.deps.root.querySelector("#clear-btn")).toBeNull();
  });
});
