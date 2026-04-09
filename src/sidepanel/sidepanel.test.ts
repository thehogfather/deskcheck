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

  const deps: SidePanelDeps = {
    root,
    sendMessage: async (msg: Message) => {
      sent.push(msg);
      if (msg.type === "GET_SESSION_STATE") {
        return {
          recording: recordingState,
          paused: pausedState,
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
        return { recording: true, sessionId: "s1", warnings: [] };
      }
      if (msg.type === "PAUSE_SESSION") {
        pausedState = true;
        return { paused: true };
      }
      if (msg.type === "RESUME_SESSION") {
        pausedState = false;
        return { paused: false };
      }
      if (msg.type === "TAKE_SCREENSHOT") {
        return { dataUrl: "data:image/png;base64,STUB" };
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
// Row #14 — controls present
// ─────────────────────────────────────────────────────────────────────

describe("controls region contents (matrix #14)", () => {
  it("contains all required interactive elements by id", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    const required = [
      "start-btn",
      "pause-btn",
      "stop-btn",
      "screenshot-btn",
      "pick-element-btn",
      "annotation-text",
      "pii-mode-fieldset",
      "metrics-row",
    ];
    for (const id of required) {
      expect(h.deps.root.querySelector(`#${id}`), `missing #${id}`).not.toBeNull();
    }
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
  it("pause-btn is hidden in idle state", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    const btn = h.deps.root.querySelector<HTMLButtonElement>("#pause-btn");
    expect(btn).not.toBeNull();
    expect(btn!.style.display).toBe("none");
  });

  it("clicking pause sends PAUSE_SESSION and flips the badge + label", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    // Start a session so we transition to active.
    h.deps.root.querySelector<HTMLButtonElement>("#start-btn")!.click();
    await new Promise((r) => setTimeout(r, 0));

    const pauseBtn = h.deps.root.querySelector<HTMLButtonElement>("#pause-btn")!;
    expect(pauseBtn.style.display).not.toBe("none");
    expect(pauseBtn.textContent).toBe("Pause");

    pauseBtn.click();
    await new Promise((r) => setTimeout(r, 0));

    const sentTypes = h.sent.map((m) => m.type);
    expect(sentTypes).toContain("PAUSE_SESSION");
    expect(pauseBtn.textContent).toBe("Resume");
    const badge = h.deps.root.querySelector("#paused-badge")!;
    expect(badge.classList.contains("hidden")).toBe(false);
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
    expect(pauseBtn.textContent).toBe("Pause");
    const badge = h.deps.root.querySelector("#paused-badge")!;
    expect(badge.classList.contains("hidden")).toBe(true);
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
    const reminder = h.deps.root.querySelector("#pre-export-reminder")!;
    expect(reminder.classList.contains("hidden")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Element picker
// ─────────────────────────────────────────────────────────────────────

describe("element picker round-trip", () => {
  it("PICK_ELEMENT_RESULT shows the selected-element chip with the selector", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);

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
    expect(chip.classList.contains("hidden")).toBe(false);
    expect(chip.textContent).toContain("button#submit");
  });

  it("clicking the chip's clear button removes the selection", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
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
    h.fireRuntimeMessage({
      type: "PICK_ELEMENT_RESULT",
      element: null,
      devicePixelRatio: 1,
    });
    const chip = h.deps.root.querySelector("#selected-element")!;
    expect(chip.classList.contains("hidden")).toBe(true);
  });
});
