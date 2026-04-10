// @vitest-environment jsdom
//
// Acceptance tests for feature #8 (Side panel UX) — Test Level Matrix
// rows #4, #5, #8, #9, #10, #14, #15, #18, #19, #20, #22, #23.
//
// jsdom-environment integration test. Mounts the side panel with mocked
// Chrome APIs, exercises the storage subscription, asserts DOM state.

import { describe, it, expect, beforeEach } from "vitest";
import { mountSidePanel, type SidePanelDeps } from "./sidepanel";
import type { Message, TimelineEvent } from "../types";

type StorageListener = (
  changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
  area: string,
) => void;
type FocusListener = (windowId: number) => void;
type RuntimeListener = (msg: Message) => void;

interface Harness {
  deps: SidePanelDeps;
  sent: Message[];
  fireStorage: (
    changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
    area?: string,
  ) => void;
  fireFocus: (windowId: number) => void;
  fireRuntimeMessage: (msg: Message) => void;
  setFirstRunSeen: (seen: boolean) => void;
  markedFirstRunSeen: () => boolean;
  /** Inject a slow response for a given message type (ms before resolve). */
  setSlow: (msgType: Message["type"], delayMs: number) => void;
  /** Force the next matching message to reject. */
  setReject: (msgType: Message["type"], error: Error) => void;
  /** Override the readStorage shim used by the discard dialog. */
  setStorageSnapshot: (snapshot: Record<string, unknown>) => void;
}

function clearBody() {
  while (document.body.firstChild) {
    document.body.removeChild(document.body.firstChild);
  }
}

function makeHarness(): Harness {
  const root = document.createElement("div");
  root.id = "sidepanel-root";
  document.body.appendChild(root);

  const sent: Message[] = [];
  const storageListeners = new Set<StorageListener>();
  const focusListeners = new Set<FocusListener>();
  const runtimeListeners = new Set<RuntimeListener>();
  let firstRunSeen = false;
  let markedSeen = false;
  let recordingState = false;
  let pausedState = false;
  const slowMap = new Map<string, number>();
  const rejectMap = new Map<string, Error>();
  let storageSnapshot: Record<string, unknown> = {};

  const deps: SidePanelDeps = {
    root,
    sendMessage: async (msg: Message) => {
      sent.push(msg);
      const delay = slowMap.get(msg.type);
      if (delay !== undefined) {
        await new Promise((r) => setTimeout(r, delay));
      }
      const rejection = rejectMap.get(msg.type);
      if (rejection) {
        rejectMap.delete(msg.type);
        throw rejection;
      }
      if (msg.type === "GET_SESSION_STATE") {
        return {
          recording: recordingState,
          paused: pausedState,
          status: recordingState ? (pausedState ? "paused" : "running") : "idle",
          sessionId: recordingState ? "s1" : null,
          activeTabId: null,
          hasExportableSession: false,
          piiMode: "full",
        };
      }
      if (msg.type === "GET_SESSION_METRICS") {
        return { startTime: "", eventCount: 0, screenshotCount: 0, eventsSizeBytes: 0, screenshotsSizeBytes: 0 };
      }
      if (msg.type === "START_SESSION") {
        recordingState = true;
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
      if (msg.type === "RESET_SESSION") {
        recordingState = false;
        pausedState = false;
        return { status: "idle", reset: true };
      }
      if (msg.type === "TAKE_SCREENSHOT") {
        return { dataUrl: "data:image/png;base64,STUB" };
      }
      return undefined;
    },
    readStorage: async (_keys: string[]) => storageSnapshot,
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
    getFirstRunSeen: async () => firstRunSeen,
    markFirstRunSeen: async () => {
      markedSeen = true;
    },
    initialEvents: [],
    initialScreenshots: {},
    initialPiiMode: "full",
  };

  return {
    deps,
    sent,
    fireStorage: (changes, area = "local") => {
      for (const l of storageListeners) l(changes, area);
    },
    fireFocus: (windowId) => {
      for (const l of focusListeners) l(windowId);
    },
    fireRuntimeMessage: (msg) => {
      for (const l of runtimeListeners) l(msg);
    },
    setFirstRunSeen: (seen) => {
      firstRunSeen = seen;
    },
    markedFirstRunSeen: () => markedSeen,
    setSlow: (msgType, delayMs) => {
      slowMap.set(msgType, delayMs);
    },
    setReject: (msgType, error) => {
      rejectMap.set(msgType, error);
    },
    setStorageSnapshot: (snapshot) => {
      storageSnapshot = snapshot;
    },
  };
}

function ev(seq: number, type: TimelineEvent["type"] = "console_error", extra: Partial<TimelineEvent> = {}): TimelineEvent {
  const base = {
    seq,
    timestamp: `2026-04-07T12:00:0${seq % 10}.000Z`,
    page_url: "https://example.com/",
  };
  if (type === "screenshot") {
    return {
      ...base,
      type: "screenshot",
      id: `ss_${seq}`,
      file: `screenshots/ss_${seq}.png`,
      viewport: { width: 1024, height: 768 },
      trigger: "manual",
      ...extra,
    } as TimelineEvent;
  }
  if (type === "annotation") {
    return {
      ...base,
      type: "annotation",
      text: "note",
      screenshot_id: `ss_${seq}`,
      ...extra,
    } as TimelineEvent;
  }
  return {
    ...base,
    type: "console_error",
    level: "error",
    message: `m${seq}`,
    ...extra,
  } as TimelineEvent;
}

beforeEach(() => {
  clearBody();
});

// ─────────────────────────────────────────────────────────────────────
// Row #5 — two-region layout
// ─────────────────────────────────────────────────────────────────────

describe("two-region layout (matrix #5)", () => {
  it("mounts #events-list above #controls inside the root", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    const events = h.deps.root.querySelector("#events-list");
    const controls = h.deps.root.querySelector("#controls");
    expect(events).not.toBeNull();
    expect(controls).not.toBeNull();
    // Events region must come before controls in DOM order.
    const order = Array.from(h.deps.root.children).map((c) => (c as HTMLElement).id);
    expect(order.indexOf("events-list")).toBeLessThan(order.indexOf("controls"));
  });
});

// ─────────────────────────────────────────────────────────────────────
// Row #14 — controls present once a session is active
// ─────────────────────────────────────────────────────────────────────
//
// Updated for feature #11 — pre-session, only Start + PII + metrics +
// empty-state hint are rendered. The other controls are structurally
// absent from the DOM, not merely disabled. They appear after the
// user starts a session.

describe("controls region contents (matrix #14)", () => {
  it("pre-session shows only Start, PII fieldset, metrics, and empty-state hint", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    // Expected to be present pre-session:
    expect(h.deps.root.querySelector("#start-btn")).not.toBeNull();
    expect(h.deps.root.querySelector("#pii-mode-fieldset")).not.toBeNull();
    expect(h.deps.root.querySelector("#metrics-row")).not.toBeNull();
    expect(h.deps.root.querySelector("#empty-state-hint")).not.toBeNull();
    // And absent (hide-not-disable — no display:none):
    const hiddenPreSession = [
      "pause-btn",
      "stop-btn",
      "discard-btn",
      "pick-element-btn",
      "annotation-text",
      "add-note-btn",
    ];
    for (const id of hiddenPreSession) {
      expect(
        h.deps.root.querySelector(`#${id}`),
        `#${id} should be absent from the DOM pre-session`,
      ).toBeNull();
    }
  });

  it("active session contains all required interactive elements by id", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    // Start a session to reveal the active controls.
    h.deps.root.querySelector<HTMLButtonElement>("#start-btn")!.click();
    await new Promise((r) => setTimeout(r, 0));

    const required = [
      "pause-btn",
      "stop-btn",
      "discard-btn",
      "pick-element-btn",
      "annotation-text",
      "add-note-btn",
      "pii-mode-fieldset",
      "metrics-row",
    ];
    for (const id of required) {
      expect(h.deps.root.querySelector(`#${id}`), `missing #${id}`).not.toBeNull();
    }
    // Start is hidden once a session is active.
    expect(h.deps.root.querySelector("#start-btn")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Row #4 — Start Session sends START_SESSION with selected PII mode
// ─────────────────────────────────────────────────────────────────────

describe("start session (matrix #4)", () => {
  it("clicking #start-btn with pii mode 'metadata' sends START_SESSION with piiMode:'metadata'", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    const metaRadio = h.deps.root.querySelector<HTMLInputElement>('input[name="pii-mode"][value="metadata"]');
    expect(metaRadio).not.toBeNull();
    metaRadio!.checked = true;
    metaRadio!.dispatchEvent(new Event("change", { bubbles: true }));
    const startBtn = h.deps.root.querySelector<HTMLButtonElement>("#start-btn");
    startBtn!.click();
    // Allow microtasks to settle.
    await new Promise((r) => setTimeout(r, 0));
    const startMsg = h.sent.find((m) => m.type === "START_SESSION") as Extract<Message, { type: "START_SESSION" }> | undefined;
    expect(startMsg).toBeDefined();
    expect(startMsg!.piiMode).toBe("metadata");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Row #15 — annotation submit sends ADD_ANNOTATION
// ─────────────────────────────────────────────────────────────────────

describe("annotation submit (matrix #15)", () => {
  it("typing annotation + clicking add-note sends ADD_ANNOTATION with text", async () => {
    const h = makeHarness();
    h.deps.initialEvents = [];
    await mountSidePanel(h.deps);
    // The annotation textarea is gated on an active session.
    h.deps.root.querySelector<HTMLButtonElement>("#start-btn")!.click();
    await new Promise((r) => setTimeout(r, 0));

    const ta = h.deps.root.querySelector<HTMLTextAreaElement>("#annotation-text");
    expect(ta).not.toBeNull();
    ta!.value = "looks broken";
    ta!.dispatchEvent(new Event("input", { bubbles: true }));
    const addBtn = h.deps.root.querySelector<HTMLButtonElement>("#add-note-btn");
    expect(addBtn).not.toBeNull();
    addBtn!.click();
    await new Promise((r) => setTimeout(r, 0));
    const annMsg = h.sent.find((m) => m.type === "ADD_ANNOTATION") as Extract<Message, { type: "ADD_ANNOTATION" }> | undefined;
    expect(annMsg).toBeDefined();
    expect(annMsg!.text).toBe("looks broken");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Row #10 — live append preserves existing rows
// ─────────────────────────────────────────────────────────────────────

describe("live append (matrix #10)", () => {
  it("EVENT_APPENDED runtime broadcast appends one row; existing rows preserved", async () => {
    const h = makeHarness();
    h.deps.initialEvents = [ev(1), ev(2), ev(3)];
    await mountSidePanel(h.deps);
    // Allow the GET_EVENTS_SNAPSHOT round-trip to settle (the harness
    // returns undefined for it so the side panel falls back to
    // initialEvents).
    await new Promise((r) => setTimeout(r, 0));

    const existing = Array.from(h.deps.root.querySelectorAll("#events-list .event-row"));
    expect(existing.length).toBe(3);
    const firstId = (existing[0] as HTMLElement).getAttribute("data-seq");

    h.fireRuntimeMessage({ type: "EVENT_APPENDED", event: ev(4) });
    await new Promise((r) => setTimeout(r, 0));

    const after = Array.from(h.deps.root.querySelectorAll("#events-list .event-row"));
    expect(after.length).toBe(4);
    // The first row's DOM node identity should be preserved.
    expect(after[0]).toBe(existing[0]);
    expect((after[0] as HTMLElement).getAttribute("data-seq")).toBe(firstId);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Row #8 — thumbnails visible by default (no placeholder gate)
// ─────────────────────────────────────────────────────────────────────

describe("screenshot thumbnails visible by default (matrix #8)", () => {
  it("screenshot event row renders an <img> with the data url", async () => {
    const h = makeHarness();
    h.deps.initialEvents = [ev(1, "screenshot")];
    h.deps.initialScreenshots = { ss_1: "data:image/png;base64,ZZZZ" };
    await mountSidePanel(h.deps);

    const img = h.deps.root.querySelector<HTMLImageElement>("#events-list .event-row.has-images .event-thumb");
    expect(img).not.toBeNull();
    expect(img!.src).toContain("data:image/png;base64,ZZZZ");
  });

  it("does not render a click-to-reveal placeholder", async () => {
    const h = makeHarness();
    h.deps.initialEvents = [ev(1, "screenshot")];
    h.deps.initialScreenshots = { ss_1: "data:image/png;base64,ZZZZ" };
    await mountSidePanel(h.deps);

    expect(h.deps.root.querySelector(".screenshot-placeholder")).toBeNull();
  });

  it("annotation with both full and element screenshots renders TWO thumbnails inline", async () => {
    const h = makeHarness();
    h.deps.initialEvents = [
      {
        seq: 1,
        timestamp: "2026-04-07T12:00:01.000Z",
        page_url: "https://example.com/",
        type: "annotation",
        text: "broken",
        screenshot_id: "ss_1",
        element_screenshot_id: "el_1",
      } as TimelineEvent,
    ];
    h.deps.initialScreenshots = {
      ss_1: "data:image/png;base64,FULL",
      el_1: "data:image/png;base64,EL",
    };
    await mountSidePanel(h.deps);

    const imgs = h.deps.root.querySelectorAll<HTMLImageElement>("#events-list .event-thumb");
    expect(imgs.length).toBe(2);
    expect(imgs[0].src).toContain("data:image/png;base64,FULL");
    expect(imgs[1].src).toContain("data:image/png;base64,EL");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Row #9 — thumbnails persist across session stop (no unmount)
// ─────────────────────────────────────────────────────────────────────

describe("thumbnails persist across session end (matrix #9)", () => {
  it("session.end_time flipping does NOT unmount visible thumbnails", async () => {
    const h = makeHarness();
    h.deps.initialEvents = [ev(1, "screenshot")];
    h.deps.initialScreenshots = { ss_1: "data:image/png;base64,ZZZZ" };
    await mountSidePanel(h.deps);

    expect(h.deps.root.querySelectorAll("#events-list img").length).toBe(1);

    h.fireStorage({
      deskcheck_session: {
        oldValue: { id: "s1", end_time: null },
        newValue: { id: "s1", end_time: "2026-04-07T12:00:30.000Z" },
      },
    });
    await new Promise((r) => setTimeout(r, 0));

    // Thumbnails remain visible — they're part of the timeline view,
    // not transient state. The session has ended but the user may
    // still want to inspect the captured events before exporting.
    expect(h.deps.root.querySelectorAll("#events-list img").length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Row #20 — first-run notice
// ─────────────────────────────────────────────────────────────────────

describe("first-run privacy notice (matrix #20)", () => {
  it("renders inline at the top when getFirstRunSeen() === false", async () => {
    const h = makeHarness();
    h.setFirstRunSeen(false);
    await mountSidePanel(h.deps);
    const notice = h.deps.root.querySelector("#first-run-notice");
    expect(notice).not.toBeNull();
  });

  it("does not render the notice when seen", async () => {
    const h = makeHarness();
    h.setFirstRunSeen(true);
    await mountSidePanel(h.deps);
    const notice = h.deps.root.querySelector("#first-run-notice");
    expect(notice).toBeNull();
  });

  it("dismiss button calls markFirstRunSeen and removes the notice", async () => {
    const h = makeHarness();
    h.setFirstRunSeen(false);
    await mountSidePanel(h.deps);
    const dismiss = h.deps.root.querySelector<HTMLButtonElement>("#first-run-notice .dismiss-btn");
    expect(dismiss).not.toBeNull();
    dismiss!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.markedFirstRunSeen()).toBe(true);
    expect(h.deps.root.querySelector("#first-run-notice")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Row #22 — cross-window focus refetch
// ─────────────────────────────────────────────────────────────────────

describe("cross-window focus change refetches session state (matrix #22)", () => {
  it("firing chrome.windows.onFocusChanged triggers GET_SESSION_STATE resend", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    const baseline = h.sent.filter((m) => m.type === "GET_SESSION_STATE").length;
    h.fireFocus(7);
    await new Promise((r) => setTimeout(r, 0));
    const after = h.sent.filter((m) => m.type === "GET_SESSION_STATE").length;
    expect(after).toBeGreaterThan(baseline);
  });

  it("ignores WINDOW_ID_NONE focus events", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    const baseline = h.sent.filter((m) => m.type === "GET_SESSION_STATE").length;
    h.fireFocus(-1);
    await new Promise((r) => setTimeout(r, 0));
    const after = h.sent.filter((m) => m.type === "GET_SESSION_STATE").length;
    expect(after).toBe(baseline);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Row #23 — session end transition swaps active controls for idle
// ─────────────────────────────────────────────────────────────────────

describe("session end transition (matrix #23)", () => {
  it("storage change setting session.end_time transitions side panel to idle view", async () => {
    const h = makeHarness();
    h.deps.initialEvents = [ev(1)];
    const handle = await mountSidePanel(h.deps);
    h.fireStorage({
      deskcheck_session: {
        oldValue: { id: "s1", end_time: null },
        newValue: { id: "s1", end_time: "2026-04-07T12:00:30.000Z" },
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(handle.getState()).toBe("idle");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Row #18 — scroll persistence (mount + scroll path executes)
// ─────────────────────────────────────────────────────────────────────

describe("scroll persistence (matrix #18)", () => {
  it("scrolling #events-list does not throw and the panel remains mounted", async () => {
    // The detailed round-trip is pinned in sidepanel-storage.test.ts.
    // Here we only verify the side panel wires up scroll handling.
    const h = makeHarness();
    h.deps.initialEvents = [ev(1), ev(2), ev(3)];
    await mountSidePanel(h.deps);
    const list = h.deps.root.querySelector<HTMLElement>("#events-list")!;
    Object.defineProperty(list, "scrollTop", { value: 200, writable: true, configurable: true });
    list.dispatchEvent(new Event("scroll"));
    await new Promise((r) => setTimeout(r, 250));
    expect(h.deps.root.querySelector("#events-list")).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Row #19 — independent scroll regions
// ─────────────────────────────────────────────────────────────────────

describe("independent scroll regions (matrix #19)", () => {
  it("controls is a sibling of events-list, not a child", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    const events = h.deps.root.querySelector("#events-list")!;
    const controls = h.deps.root.querySelector("#controls")!;
    expect(events.parentElement).toBe(h.deps.root);
    expect(controls.parentElement).toBe(h.deps.root);
    expect(events.contains(controls)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Pause / Resume
// ─────────────────────────────────────────────────────────────────────

describe("pause and resume", () => {
  it("pause-btn is absent from the DOM in idle state (hide-not-disable)", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    const btn = h.deps.root.querySelector<HTMLButtonElement>("#pause-btn");
    expect(btn).toBeNull();
  });

  it("clicking pause sends PAUSE_SESSION and flips the badge + label", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    // Start a session so we transition to active.
    h.deps.root.querySelector<HTMLButtonElement>("#start-btn")!.click();
    await new Promise((r) => setTimeout(r, 0));

    const pauseBtn = h.deps.root.querySelector<HTMLButtonElement>("#pause-btn")!;
    expect(pauseBtn).not.toBeNull();
    expect(pauseBtn.querySelector(".btn-label")!.textContent).toBe("Pause");
    // No paused badge before pause.
    expect(h.deps.root.querySelector("#paused-badge")).toBeNull();

    pauseBtn.click();
    await new Promise((r) => setTimeout(r, 0));

    const sentTypes = h.sent.map((m) => m.type);
    expect(sentTypes).toContain("PAUSE_SESSION");
    expect(pauseBtn.querySelector(".btn-label")!.textContent).toBe("Resume");
    // Paused badge is now mounted.
    expect(h.deps.root.querySelector("#paused-badge")).not.toBeNull();
  });

  it("clicking resume sends RESUME_SESSION and clears the badge", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    h.deps.root.querySelector<HTMLButtonElement>("#start-btn")!.click();
    await new Promise((r) => setTimeout(r, 0));
    const pauseBtn = h.deps.root.querySelector<HTMLButtonElement>("#pause-btn")!;
    pauseBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    pauseBtn.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(h.sent.map((m) => m.type)).toContain("RESUME_SESSION");
    expect(pauseBtn.querySelector(".btn-label")!.textContent).toBe("Pause");
    expect(h.deps.root.querySelector("#paused-badge")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Pre-export reminder
// ─────────────────────────────────────────────────────────────────────

describe("pre-export reminder", () => {
  it("clicking stop in active session opens the reminder, NOT STOP_SESSION", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    h.deps.root.querySelector<HTMLButtonElement>("#start-btn")!.click();
    await new Promise((r) => setTimeout(r, 0));

    h.deps.root.querySelector<HTMLButtonElement>("#stop-btn")!.click();
    await new Promise((r) => setTimeout(r, 0));

    const reminder = h.deps.root.querySelector("#pre-export-reminder")!;
    expect(reminder.classList.contains("hidden")).toBe(false);
    expect(h.sent.map((m) => m.type)).not.toContain("STOP_SESSION");
  });

  it("'Keep recording' dismisses the reminder without stopping", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    h.deps.root.querySelector<HTMLButtonElement>("#start-btn")!.click();
    await new Promise((r) => setTimeout(r, 0));
    h.deps.root.querySelector<HTMLButtonElement>("#stop-btn")!.click();
    await new Promise((r) => setTimeout(r, 0));

    h.deps.root.querySelector<HTMLButtonElement>("#keep-recording-btn")!.click();
    await new Promise((r) => setTimeout(r, 0));

    const reminder = h.deps.root.querySelector("#pre-export-reminder")!;
    expect(reminder.classList.contains("hidden")).toBe(true);
    expect(h.sent.map((m) => m.type)).not.toContain("STOP_SESSION");
  });

  it("'Download' triggers STOP_SESSION + EXPORT_SESSION and hides the reminder", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    h.deps.root.querySelector<HTMLButtonElement>("#start-btn")!.click();
    await new Promise((r) => setTimeout(r, 0));
    h.deps.root.querySelector<HTMLButtonElement>("#stop-btn")!.click();
    await new Promise((r) => setTimeout(r, 0));

    h.deps.root.querySelector<HTMLButtonElement>("#download-btn")!.click();
    await new Promise((r) => setTimeout(r, 0));

    const types = h.sent.map((m) => m.type);
    expect(types).toContain("STOP_SESSION");
    expect(types).toContain("EXPORT_SESSION");
    // After download + idle transition, the reminder is removed from
    // the DOM entirely (hide-not-disable).
    const reminder = h.deps.root.querySelector("#pre-export-reminder");
    expect(reminder).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Element picker
// ─────────────────────────────────────────────────────────────────────

async function startSession(h: Harness) {
  h.deps.root.querySelector<HTMLButtonElement>("#start-btn")!.click();
  await new Promise((r) => setTimeout(r, 0));
}

describe("element picker round-trip", () => {
  it("PICK_ELEMENT_RESULT shows the selected-element chip with the selector", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    await startSession(h);

    h.fireRuntimeMessage({
      type: "PICK_ELEMENT_RESULT",
      element: {
        tag: "button",
        id: "submit",
        selector: "button#submit",
        bounding_box: { x: 10, y: 20, width: 100, height: 30 },
      },
      devicePixelRatio: 2,
    });
    await new Promise((r) => setTimeout(r, 0));

    const chip = h.deps.root.querySelector("#selected-element")!;
    expect(chip).not.toBeNull();
    expect(chip.classList.contains("hidden")).toBe(false);
    expect(chip.textContent).toContain("button#submit");
  });

  it("clicking the chip's clear button removes the selection", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    await startSession(h);
    h.fireRuntimeMessage({
      type: "PICK_ELEMENT_RESULT",
      element: {
        tag: "div",
        selector: "div.foo",
        bounding_box: { x: 0, y: 0, width: 1, height: 1 },
      },
      devicePixelRatio: 1,
    });
    await new Promise((r) => setTimeout(r, 0));

    const chip = h.deps.root.querySelector("#selected-element")!;
    chip.querySelector<HTMLButtonElement>(".chip-clear")!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(chip.classList.contains("hidden")).toBe(true);
  });

  it("PICK_ELEMENT_RESULT with element=null is a no-op", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    await startSession(h);
    h.fireRuntimeMessage({
      type: "PICK_ELEMENT_RESULT",
      element: null,
      devicePixelRatio: 1,
    });
    const chip = h.deps.root.querySelector("#selected-element")!;
    expect(chip.classList.contains("hidden")).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Feature #11 — Side panel session controls acceptance suites
// ═════════════════════════════════════════════════════════════════════

describe("feature-11 gated controls: pre-session state", () => {
  it("shows the empty-state hint when idle with no residual events", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    const hint = h.deps.root.querySelector("#empty-state-hint");
    expect(hint).not.toBeNull();
    expect(hint!.textContent).toContain("Start a session");
  });

  it("hides annotation, picker, and lifecycle controls pre-session", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    const absent = [
      "annotation-text",
      "add-note-btn",
      "pick-element-btn",
      "pause-btn",
      "stop-btn",
      "discard-btn",
    ];
    for (const id of absent) {
      expect(h.deps.root.querySelector(`#${id}`)).toBeNull();
    }
  });

  it("renders Start + PII + metrics even when there are no events", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    expect(h.deps.root.querySelector("#start-btn")).not.toBeNull();
    expect(h.deps.root.querySelector("#pii-mode-fieldset")).not.toBeNull();
    expect(h.deps.root.querySelector("#metrics-row")).not.toBeNull();
  });
});

describe("feature-11 gated controls: on start, controls appear", () => {
  it("clicking Start reveals annotation + lifecycle controls", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    await startSession(h);
    const revealed = [
      "annotation-text",
      "add-note-btn",
      "pick-element-btn",
      "pause-btn",
      "stop-btn",
      "discard-btn",
    ];
    for (const id of revealed) {
      expect(h.deps.root.querySelector(`#${id}`)).not.toBeNull();
    }
    // Empty-state hint disappears once controls are live.
    expect(h.deps.root.querySelector("#empty-state-hint")).toBeNull();
    // And Start is gone.
    expect(h.deps.root.querySelector("#start-btn")).toBeNull();
  });
});

describe("feature-11 gated controls: on session-end, form returns to pre-session", () => {
  it("discard fires a storage change that flips the panel back to idle", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    await startSession(h);
    // Simulate the SW clearing storage after discard.
    h.fireStorage({
      deskcheck_session: {
        oldValue: { id: "s1", end_time: null, status: "running" },
        newValue: undefined,
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    // Interaction controls are absent again.
    expect(h.deps.root.querySelector("#annotation-text")).toBeNull();
    expect(h.deps.root.querySelector("#pause-btn")).toBeNull();
    expect(h.deps.root.querySelector("#discard-btn")).toBeNull();
    expect(h.deps.root.querySelector("#start-btn")).not.toBeNull();
    expect(h.deps.root.querySelector("#empty-state-hint")).not.toBeNull();
  });
});

describe("feature-11 loading feedback", () => {
  it("Save annotation shows a loading state while the save is in flight", async () => {
    const h = makeHarness();
    h.setSlow("ADD_ANNOTATION", 30);
    await mountSidePanel(h.deps);
    await startSession(h);

    const ta = h.deps.root.querySelector<HTMLTextAreaElement>("#annotation-text")!;
    ta.value = "looks broken";
    const addBtn = h.deps.root.querySelector<HTMLButtonElement>("#add-note-btn")!;
    const click = addBtn.click();
    // Poll the button for a moment to catch the busy state before it resolves.
    // Use microtask to allow the handler to start.
    await new Promise((r) => setTimeout(r, 5));
    expect(addBtn.disabled).toBe(true);
    expect(addBtn.getAttribute("aria-busy")).toBe("true");
    expect(addBtn.querySelector(".btn-label")!.textContent).toBe("Saving…");
    // Wait for the click promise to settle.
    await click;
    await new Promise((r) => setTimeout(r, 40));
    expect(addBtn.disabled).toBe(false);
    expect(addBtn.getAttribute("aria-busy")).toBeNull();
    expect(addBtn.querySelector(".btn-label")!.textContent).toBe("Add");
  });

  it("Download shows a loading state while export is in flight", async () => {
    const h = makeHarness();
    h.setSlow("EXPORT_SESSION", 30);
    await mountSidePanel(h.deps);
    await startSession(h);
    h.deps.root.querySelector<HTMLButtonElement>("#stop-btn")!.click();
    await new Promise((r) => setTimeout(r, 0));
    const dl = h.deps.root.querySelector<HTMLButtonElement>("#download-btn")!;
    dl.click();
    await new Promise((r) => setTimeout(r, 5));
    expect(dl.disabled).toBe(true);
    expect(dl.textContent).toBe("Exporting…");
    await new Promise((r) => setTimeout(r, 40));
    expect(dl.disabled).toBe(false);
    expect(dl.textContent).toBe("Download");
  });

  it("errors land in #async-error and persist until the next success", async () => {
    const h = makeHarness();
    h.setReject("ADD_ANNOTATION", new Error("boom"));
    await mountSidePanel(h.deps);
    await startSession(h);

    const ta = h.deps.root.querySelector<HTMLTextAreaElement>("#annotation-text")!;
    ta.value = "oops";
    h.deps.root.querySelector<HTMLButtonElement>("#add-note-btn")!.click();
    await new Promise((r) => setTimeout(r, 10));

    const errLine = h.deps.root.querySelector("#async-error")!;
    expect(errLine.textContent).toContain("boom");

    // Subsequent successful action clears the error line.
    ta.value = "second";
    h.deps.root.querySelector<HTMLButtonElement>("#add-note-btn")!.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(errLine.textContent).toBe("");
  });
});

describe("feature-11 lifecycle controls: pause/resume/stop/discard", () => {
  it("active session exposes all four lifecycle controls", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    await startSession(h);
    expect(h.deps.root.querySelector("#pause-btn")).not.toBeNull();
    expect(h.deps.root.querySelector("#stop-btn")).not.toBeNull();
    expect(h.deps.root.querySelector("#discard-btn")).not.toBeNull();
    // Reset is NOT a mid-session control.
    expect(h.deps.root.querySelector("#reset-btn")).toBeNull();
  });

  it("discard shows a confirmation dialog with counts from a fresh storage read", async () => {
    const h = makeHarness();
    // Panel-local in-memory mirror says 0 events, but storage has 7
    // events and 3 screenshots — the dialog must reflect STORAGE.
    h.setStorageSnapshot({
      deskcheck_events: [
        ev(1), ev(2), ev(3), ev(4), ev(5), ev(6), ev(7),
      ],
      deskcheck_screenshots: { a: "data:,", b: "data:,", c: "data:," },
    });
    await mountSidePanel(h.deps);
    await startSession(h);
    h.deps.root.querySelector<HTMLButtonElement>("#discard-btn")!.click();
    await new Promise((r) => setTimeout(r, 0));
    const dialog = h.deps.root.querySelector("#discard-confirm-dialog")!;
    expect(dialog.classList.contains("hidden")).toBe(false);
    const detail = dialog.querySelector("#discard-detail")!;
    expect(detail.textContent).toContain("7 events");
    expect(detail.textContent).toContain("3 screenshots");
  });

  it("cancel makes ZERO storage writes (spy on sendMessage for DISCARD_SESSION)", async () => {
    const h = makeHarness();
    h.setStorageSnapshot({
      deskcheck_events: [ev(1)],
      deskcheck_screenshots: {},
    });
    await mountSidePanel(h.deps);
    await startSession(h);
    h.deps.root.querySelector<HTMLButtonElement>("#discard-btn")!.click();
    await new Promise((r) => setTimeout(r, 0));
    const sentBefore = h.sent.length;
    h.deps.root.querySelector<HTMLButtonElement>("#cancel-discard-btn")!.click();
    await new Promise((r) => setTimeout(r, 10));
    const sentAfter = h.sent.length;
    // No DISCARD_SESSION (or any new message) sent.
    expect(sentAfter).toBe(sentBefore);
    expect(h.sent.map((m) => m.type)).not.toContain("DISCARD_SESSION");
    // And the dialog is hidden.
    const dialog = h.deps.root.querySelector("#discard-confirm-dialog")!;
    expect(dialog.classList.contains("hidden")).toBe(true);
  });

  it("default focus on the discard dialog goes to Cancel", async () => {
    const h = makeHarness();
    h.setStorageSnapshot({ deskcheck_events: [], deskcheck_screenshots: {} });
    await mountSidePanel(h.deps);
    await startSession(h);
    h.deps.root.querySelector<HTMLButtonElement>("#discard-btn")!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement?.id).toBe("cancel-discard-btn");
  });

  it("Escape key cancels the discard dialog without sending DISCARD_SESSION", async () => {
    const h = makeHarness();
    h.setStorageSnapshot({ deskcheck_events: [], deskcheck_screenshots: {} });
    await mountSidePanel(h.deps);
    await startSession(h);
    h.deps.root.querySelector<HTMLButtonElement>("#discard-btn")!.click();
    await new Promise((r) => setTimeout(r, 0));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await new Promise((r) => setTimeout(r, 0));
    const dialog = h.deps.root.querySelector("#discard-confirm-dialog")!;
    expect(dialog.classList.contains("hidden")).toBe(true);
    expect(h.sent.map((m) => m.type)).not.toContain("DISCARD_SESSION");
  });

  it("confirm sends DISCARD_SESSION and returns the panel to idle", async () => {
    const h = makeHarness();
    h.setStorageSnapshot({ deskcheck_events: [ev(1)], deskcheck_screenshots: {} });
    await mountSidePanel(h.deps);
    await startSession(h);
    h.deps.root.querySelector<HTMLButtonElement>("#discard-btn")!.click();
    await new Promise((r) => setTimeout(r, 0));
    h.deps.root.querySelector<HTMLButtonElement>("#confirm-discard-btn")!.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(h.sent.map((m) => m.type)).toContain("DISCARD_SESSION");
    // Panel returns to idle.
    expect(h.deps.root.querySelector("#start-btn")).not.toBeNull();
    expect(h.deps.root.querySelector("#discard-btn")).toBeNull();
  });
});

describe("feature-11 reset", () => {
  it("reset button is not rendered when idle with no residual state", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    expect(h.deps.root.querySelector("#reset-btn")).toBeNull();
  });

  it("reset button is rendered when stopped with residual state", async () => {
    const h = makeHarness();
    h.deps.initialEvents = [ev(1), ev(2)];
    await mountSidePanel(h.deps);
    // Simulate session ending: end_time set.
    h.fireStorage({
      deskcheck_session: {
        oldValue: { id: "s1", end_time: null, status: "running" },
        newValue: { id: "s1", end_time: "2026-04-07T12:00:30.000Z", status: "stopped" },
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.deps.root.querySelector("#reset-btn")).not.toBeNull();
  });

  it("reset is hidden during an active session (Discard is the mid-session action)", async () => {
    const h = makeHarness();
    h.deps.initialEvents = [ev(1)];
    await mountSidePanel(h.deps);
    await startSession(h);
    expect(h.deps.root.querySelector("#reset-btn")).toBeNull();
  });

  it("clicking reset sends RESET_SESSION and returns the panel to idle", async () => {
    const h = makeHarness();
    h.deps.initialEvents = [ev(1)];
    await mountSidePanel(h.deps);
    h.fireStorage({
      deskcheck_session: {
        oldValue: { id: "s1", end_time: null, status: "running" },
        newValue: { id: "s1", end_time: "2026-04-07T12:00:30.000Z", status: "stopped" },
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    const resetBtn = h.deps.root.querySelector<HTMLButtonElement>("#reset-btn")!;
    resetBtn.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(h.sent.map((m) => m.type)).toContain("RESET_SESSION");
    expect(h.deps.root.querySelector("#reset-btn")).toBeNull();
    expect(h.deps.root.querySelector("#empty-state-hint")).not.toBeNull();
  });
});

describe("feature-11 auto-scroll + new-events chip", () => {
  it("renders a new-events chip that is hidden by default", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    const chip = h.deps.root.querySelector("#new-events-chip")!;
    expect(chip).not.toBeNull();
    expect(chip.classList.contains("hidden")).toBe(true);
  });

  it("does not render the chip when appending while pinned to bottom", async () => {
    const h = makeHarness();
    h.deps.initialEvents = [ev(1), ev(2)];
    await mountSidePanel(h.deps);
    // Use runtime broadcast (feature #5 OPFS: events no longer flow via
    // chrome.storage.onChanged).
    h.fireRuntimeMessage({ type: "EVENT_APPENDED", event: ev(3) });
    await new Promise((r) => setTimeout(r, 0));
    const chip = h.deps.root.querySelector("#new-events-chip")!;
    expect(chip.classList.contains("hidden")).toBe(true);
  });

  it("shows the chip when the user has scrolled up and a new event arrives", async () => {
    const h = makeHarness();
    h.deps.initialEvents = [ev(1), ev(2), ev(3), ev(4)];
    await mountSidePanel(h.deps);
    const list = h.deps.root.querySelector<HTMLElement>("#events-list")!;
    // Force "scrolled up" geometry.
    Object.defineProperty(list, "scrollTop", { value: 0, writable: true, configurable: true });
    Object.defineProperty(list, "scrollHeight", { value: 1000, writable: true, configurable: true });
    Object.defineProperty(list, "clientHeight", { value: 100, writable: true, configurable: true });
    list.dispatchEvent(new Event("scroll"));
    await new Promise((r) => setTimeout(r, 0));

    // Use runtime broadcast (feature #5 OPFS: events no longer flow via
    // chrome.storage.onChanged).
    h.fireRuntimeMessage({ type: "EVENT_APPENDED", event: ev(5) });
    await new Promise((r) => setTimeout(r, 0));

    const chip = h.deps.root.querySelector("#new-events-chip")!;
    expect(chip.classList.contains("hidden")).toBe(false);
    expect(chip.textContent).toContain("1 new event");
  });
});

describe("feature-11 reset click defensively re-checks state", () => {
  it("does not send RESET_SESSION when the panel transitions back to running under a stale DOM", async () => {
    const h = makeHarness();
    h.deps.initialEvents = [ev(1)];
    await mountSidePanel(h.deps);
    // End the session so Reset is rendered.
    h.fireStorage({
      deskcheck_session: {
        oldValue: { id: "s1", end_time: null, status: "running" },
        newValue: { id: "s1", end_time: "2026-04-07T12:00:30.000Z", status: "stopped" },
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    const resetBtn = h.deps.root.querySelector<HTMLButtonElement>("#reset-btn")!;
    expect(resetBtn).not.toBeNull();

    // Now flip status back to running through a storage event — this
    // should remove the reset button. But grab a handle before that.
    h.fireStorage({
      deskcheck_session: {
        oldValue: { id: "s1", end_time: "2026-04-07T12:00:30.000Z", status: "stopped" },
        newValue: { id: "s2", end_time: null, status: "running" },
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    // The button is gone from the DOM — can't click it. Defensive
    // re-check is necessary if a race lets a click land; the click
    // handler refuses when status is not idle/stopped. We verify
    // the guard by dispatching the click on the detached node.
    resetBtn.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(h.sent.map((m) => m.type)).not.toContain("RESET_SESSION");
  });
});

// ═════════════════════════════════════════════════════════════════════
// Feature #12 acceptance tests — Side panel control layout refinement
// ═════════════════════════════════════════════════════════════════════

describe("feature-12: three-region layout (toolbar, events, controls)", () => {
  it("mounts #toolbar above #events-list above #controls in root", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    const order = Array.from(h.deps.root.children).map((c) => (c as HTMLElement).id);
    expect(order).toContain("toolbar");
    expect(order).toContain("events-list");
    expect(order).toContain("controls");
    expect(order.indexOf("toolbar")).toBeLessThan(order.indexOf("events-list"));
    expect(order.indexOf("events-list")).toBeLessThan(order.indexOf("controls"));
  });
});

describe("feature-12: screenshot button removed", () => {
  it("#screenshot-btn is absent from DOM in idle state", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    expect(h.deps.root.querySelector("#screenshot-btn")).toBeNull();
  });

  it("#screenshot-btn is absent from DOM in active session", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    h.deps.root.querySelector<HTMLButtonElement>("#start-btn")!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.deps.root.querySelector("#screenshot-btn")).toBeNull();
  });
});

describe("feature-12: lifecycle controls in toolbar", () => {
  it("pre-session: #start-btn is inside #toolbar", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    const toolbar = h.deps.root.querySelector("#toolbar");
    expect(toolbar).not.toBeNull();
    expect(toolbar!.querySelector("#start-btn")).not.toBeNull();
  });

  it("active session: pause, stop, discard are inside #toolbar", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    h.deps.root.querySelector<HTMLButtonElement>("#start-btn")!.click();
    await new Promise((r) => setTimeout(r, 0));
    const toolbar = h.deps.root.querySelector("#toolbar")!;
    expect(toolbar.querySelector("#pause-btn")).not.toBeNull();
    expect(toolbar.querySelector("#stop-btn")).not.toBeNull();
    expect(toolbar.querySelector("#discard-btn")).not.toBeNull();
  });

  it("active session: lifecycle buttons NOT in #controls", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    h.deps.root.querySelector<HTMLButtonElement>("#start-btn")!.click();
    await new Promise((r) => setTimeout(r, 0));
    const controls = h.deps.root.querySelector("#controls")!;
    expect(controls.querySelector("#pause-btn")).toBeNull();
    expect(controls.querySelector("#stop-btn")).toBeNull();
    expect(controls.querySelector("#discard-btn")).toBeNull();
    expect(controls.querySelector("#start-btn")).toBeNull();
  });

  it("metrics row is inside #toolbar", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    const toolbar = h.deps.root.querySelector("#toolbar")!;
    expect(toolbar.querySelector("#metrics-row")).not.toBeNull();
  });
});

describe("feature-12: annotation area in controls", () => {
  it("active session: #controls contains annotation-text, add-note-btn, pii-mode-fieldset", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    h.deps.root.querySelector<HTMLButtonElement>("#start-btn")!.click();
    await new Promise((r) => setTimeout(r, 0));
    const controls = h.deps.root.querySelector("#controls")!;
    expect(controls.querySelector("#annotation-text")).not.toBeNull();
    expect(controls.querySelector("#add-note-btn")).not.toBeNull();
    expect(controls.querySelector("#pii-mode-fieldset")).not.toBeNull();
  });
});

describe("feature-12: element picker embedded in annotation wrapper", () => {
  it("#pick-element-btn is inside .annotation-wrapper during active session", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    h.deps.root.querySelector<HTMLButtonElement>("#start-btn")!.click();
    await new Promise((r) => setTimeout(r, 0));
    const wrapper = h.deps.root.querySelector(".annotation-wrapper");
    expect(wrapper).not.toBeNull();
    expect(wrapper!.querySelector("#pick-element-btn")).not.toBeNull();
  });

  it("#annotation-text is inside .annotation-wrapper", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    h.deps.root.querySelector<HTMLButtonElement>("#start-btn")!.click();
    await new Promise((r) => setTimeout(r, 0));
    const wrapper = h.deps.root.querySelector(".annotation-wrapper")!;
    expect(wrapper.querySelector("#annotation-text")).not.toBeNull();
  });
});

describe("feature-12: button icons", () => {
  it("all buttons have a .btn-icon span during active session", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    h.deps.root.querySelector<HTMLButtonElement>("#start-btn")!.click();
    await new Promise((r) => setTimeout(r, 0));
    const buttonsWithIcons = [
      "pause-btn",
      "stop-btn",
      "discard-btn",
      "pick-element-btn",
      "add-note-btn",
    ];
    for (const id of buttonsWithIcons) {
      const btn = h.deps.root.querySelector(`#${id}`);
      expect(btn, `#${id} should be in DOM`).not.toBeNull();
      expect(
        btn!.querySelector(".btn-icon"),
        `#${id} should have a .btn-icon span`,
      ).not.toBeNull();
    }
  });

  it("#start-btn has a .btn-icon span pre-session", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    const startBtn = h.deps.root.querySelector("#start-btn");
    expect(startBtn).not.toBeNull();
    expect(startBtn!.querySelector(".btn-icon")).not.toBeNull();
  });
});

describe("feature-12: withLoadingState preserves icons", () => {
  it("icon span survives a loading cycle on add-note button", async () => {
    const h = makeHarness();
    h.setSlow("ADD_ANNOTATION", 50);
    await mountSidePanel(h.deps);
    h.deps.root.querySelector<HTMLButtonElement>("#start-btn")!.click();
    await new Promise((r) => setTimeout(r, 0));

    const ta = h.deps.root.querySelector<HTMLTextAreaElement>("#annotation-text")!;
    ta.value = "test";
    const addBtn = h.deps.root.querySelector<HTMLButtonElement>("#add-note-btn")!;
    const iconBefore = addBtn.querySelector(".btn-icon");
    expect(iconBefore).not.toBeNull();
    const iconText = iconBefore!.textContent;

    addBtn.click();
    // Mid-flight: icon should still be present.
    await new Promise((r) => setTimeout(r, 10));
    expect(addBtn.querySelector(".btn-icon")).not.toBeNull();

    // After completion: icon restored.
    await new Promise((r) => setTimeout(r, 100));
    const iconAfter = addBtn.querySelector(".btn-icon");
    expect(iconAfter).not.toBeNull();
    expect(iconAfter!.textContent).toBe(iconText);
  });
});

describe("feature-12: newEventsChip in events-list", () => {
  it("#new-events-chip is inside #events-list, not #controls", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    const eventsList = h.deps.root.querySelector("#events-list")!;
    const controls = h.deps.root.querySelector("#controls")!;
    expect(eventsList.querySelector("#new-events-chip")).not.toBeNull();
    expect(controls.querySelector("#new-events-chip")).toBeNull();
  });
});

describe("feature-12: dialogs remain in #controls", () => {
  it("#pre-export-reminder is inside #controls during active session", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    h.deps.root.querySelector<HTMLButtonElement>("#start-btn")!.click();
    await new Promise((r) => setTimeout(r, 0));
    // Click stop to show the reminder.
    h.deps.root.querySelector<HTMLButtonElement>("#stop-btn")!.click();
    await new Promise((r) => setTimeout(r, 0));
    const controls = h.deps.root.querySelector("#controls")!;
    expect(controls.querySelector("#pre-export-reminder")).not.toBeNull();
  });

  it("#discard-confirm-dialog is inside #controls during active session", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    h.deps.root.querySelector<HTMLButtonElement>("#start-btn")!.click();
    await new Promise((r) => setTimeout(r, 0));
    // Click discard to show the dialog.
    h.deps.root.querySelector<HTMLButtonElement>("#discard-btn")!.click();
    await new Promise((r) => setTimeout(r, 0));
    const controls = h.deps.root.querySelector("#controls")!;
    expect(controls.querySelector("#discard-confirm-dialog")).not.toBeNull();
  });
});
