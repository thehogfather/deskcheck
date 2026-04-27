// @vitest-environment jsdom
//
// Acceptance tests for feature #15 — Lucide icons across the UI.
//
// These tests pin the four real risks identified by the planners:
//   1. Every icon-bearing button renders an `<svg>` child inside `.btn-icon`
//      with `aria-hidden="true"` (icon presence + a11y contract).
//   2. The button's accessible name comes from `.btn-label` text only —
//      the icon must not contribute to the accessible name.
//   3. The pause→resume→pause dynamic swap (sidepanel.ts:966-976) preserves
//      the SVG node identity (the highest-risk surface in the change —
//      previously it used `textContent =` which would clobber any SVG).
//   4. `withLoadingState` round-trip preserves the SVG icon child
//      (locks the contract feature #12 set up via `.btn-label`-scoped
//      label restoration).

import { describe, it, expect, beforeEach } from "vitest";
import { mountSidePanel, type SidePanelDeps } from "../src/sidepanel/sidepanel";
import type { Message, TimelineEvent } from "../src/types";

type StorageListener = (
  changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
  area: string,
) => void;
type FocusListener = (windowId: number) => void;
type RuntimeListener = (msg: Message) => void;

interface Harness {
  deps: SidePanelDeps;
  sent: Message[];
  setSlow: (msgType: Message["type"], delayMs: number) => void;
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
  let recordingState = false;
  let pausedState = false;
  const slowMap = new Map<string, number>();

  const deps: SidePanelDeps = {
    root,
    sendMessage: async (msg: Message) => {
      sent.push(msg);
      const delay = slowMap.get(msg.type);
      if (delay !== undefined) {
        await new Promise((r) => setTimeout(r, delay));
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
        return {
          startTime: "",
          eventCount: 0,
          screenshotCount: 0,
          eventsSizeBytes: 0,
          screenshotsSizeBytes: 0,
        };
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
    getFirstRunSeen: async () => true,
    markFirstRunSeen: async () => {
      /* noop */
    },
    initialEvents: [] as TimelineEvent[],
    initialScreenshots: {},
    initialPiiMode: "full",
  };

  return {
    deps,
    sent,
    setSlow: (msgType, delayMs) => {
      slowMap.set(msgType, delayMs);
    },
  };
}

async function startSession(h: Harness): Promise<void> {
  h.deps.root.querySelector<HTMLButtonElement>("#start-btn")!.click();
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  clearBody();
});

// ─────────────────────────────────────────────────────────────────────
// 1. Icon presence + a11y — every icon-bearing button renders an
//    <svg> child inside .btn-icon with aria-hidden="true".
// ─────────────────────────────────────────────────────────────────────

describe("feature-15: every icon-bearing button has an SVG child with aria-hidden", () => {
  it("pre-session: #start-btn has an <svg> inside .btn-icon with aria-hidden=true", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    const startBtn = h.deps.root.querySelector<HTMLButtonElement>("#start-btn")!;
    const svg = startBtn.querySelector(".btn-icon svg");
    expect(svg, "#start-btn must have an <svg> child inside .btn-icon").not.toBeNull();
    expect(svg!.getAttribute("aria-hidden")).toBe("true");
  });

  it("active session: every lifecycle/annotation button has an <svg> inside .btn-icon with aria-hidden=true", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    await startSession(h);

    const buttonsWithIcons = [
      "pause-btn",
      "stop-btn",
      "discard-btn",
      "pick-element-btn",
      "add-note-btn",
    ];
    for (const id of buttonsWithIcons) {
      const btn = h.deps.root.querySelector<HTMLButtonElement>(`#${id}`);
      expect(btn, `#${id} must be in DOM after start`).not.toBeNull();
      const svg = btn!.querySelector(".btn-icon svg");
      expect(svg, `#${id} must have an <svg> child inside .btn-icon`).not.toBeNull();
      expect(
        svg!.getAttribute("aria-hidden"),
        `#${id} icon must carry aria-hidden=true`,
      ).toBe("true");
    }
  });

  it("handoff buttons (pre-session) have an <svg> inside .btn-icon with aria-hidden=true", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    const attachBtn = h.deps.root.querySelector<HTMLButtonElement>("#handoff-attach-btn");
    expect(attachBtn, "#handoff-attach-btn must be in DOM pre-session").not.toBeNull();
    const svg = attachBtn!.querySelector(".btn-icon svg");
    expect(svg, "#handoff-attach-btn must have an <svg> child").not.toBeNull();
    expect(svg!.getAttribute("aria-hidden")).toBe("true");
  });
});

// ─────────────────────────────────────────────────────────────────────
// 2. Accessible name comes from .btn-label only — the icon must not
//    contribute to the accessible name.
// ─────────────────────────────────────────────────────────────────────

describe("feature-15: button accessible name comes from .btn-label only", () => {
  it("pre-session: #start-btn label text is 'Start session'", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    const btn = h.deps.root.querySelector<HTMLButtonElement>("#start-btn")!;
    expect(btn.querySelector(".btn-label")!.textContent).toBe("Start session");
  });

  it("active session: every button's .btn-label text matches the expected label", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    await startSession(h);

    const expected: Record<string, string> = {
      "pause-btn": "Pause",
      "stop-btn": "Download",
      "discard-btn": "Discard",
      "pick-element-btn": "select",
      "add-note-btn": "Add",
    };
    for (const [id, label] of Object.entries(expected)) {
      const btn = h.deps.root.querySelector<HTMLButtonElement>(`#${id}`);
      expect(btn, `#${id} must be in DOM after start`).not.toBeNull();
      expect(
        btn!.querySelector(".btn-label")!.textContent,
        `#${id} label must equal ${label}`,
      ).toBe(label);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// 3. Pause→Resume→Pause dynamic swap preserves the SVG node — the
//    highest-risk surface in this change. Previously the swap used
//    `textContent =` which would obliterate any SVG child.
// ─────────────────────────────────────────────────────────────────────

describe("feature-15: pause/resume swap preserves SVG node integrity", () => {
  it("pause→resume→pause cycle leaves an <svg> child after every transition", async () => {
    const h = makeHarness();
    await mountSidePanel(h.deps);
    await startSession(h);

    const pauseBtn = h.deps.root.querySelector<HTMLButtonElement>("#pause-btn")!;
    expect(pauseBtn).not.toBeNull();

    // Initial state — running, button labelled "Pause", has <svg>.
    expect(pauseBtn.querySelector(".btn-icon svg"), "<svg> present in initial state").not.toBeNull();
    expect(pauseBtn.querySelector(".btn-label")!.textContent).toBe("Pause");

    // Click → paused. Button now labelled "Resume". <svg> must still exist.
    pauseBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(
      pauseBtn.querySelector(".btn-icon svg"),
      "<svg> present after pause (label is now Resume)",
    ).not.toBeNull();
    expect(pauseBtn.querySelector(".btn-label")!.textContent).toBe("Resume");

    // Click → running again. Button now labelled "Pause". <svg> must still exist.
    pauseBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(
      pauseBtn.querySelector(".btn-icon svg"),
      "<svg> present after resume (label is back to Pause)",
    ).not.toBeNull();
    expect(pauseBtn.querySelector(".btn-label")!.textContent).toBe("Pause");
  });
});

// ─────────────────────────────────────────────────────────────────────
// 4. withLoadingState round-trip preserves the SVG icon child — locks
//    the .btn-label-scoped behaviour feature #12 set up.
// ─────────────────────────────────────────────────────────────────────

describe("feature-15: withLoadingState preserves the SVG icon node", () => {
  it("add-note button keeps its <svg> icon across a loading cycle", async () => {
    const h = makeHarness();
    h.setSlow("ADD_ANNOTATION", 30);
    await mountSidePanel(h.deps);
    await startSession(h);

    const ta = h.deps.root.querySelector<HTMLTextAreaElement>("#annotation-text")!;
    ta.value = "test";
    const addBtn = h.deps.root.querySelector<HTMLButtonElement>("#add-note-btn")!;
    const svgBefore = addBtn.querySelector(".btn-icon svg");
    expect(svgBefore, "<svg> present pre-click").not.toBeNull();

    addBtn.click();
    // Mid-flight: icon must still be present.
    await new Promise((r) => setTimeout(r, 5));
    expect(
      addBtn.querySelector(".btn-icon svg"),
      "<svg> present mid-flight (during loading state)",
    ).not.toBeNull();
    // Label is the busy indicator while loading.
    expect(addBtn.querySelector(".btn-label")!.textContent).toBe("Saving…");

    // After completion: icon restored, label back to Add.
    await new Promise((r) => setTimeout(r, 60));
    const svgAfter = addBtn.querySelector(".btn-icon svg");
    expect(svgAfter, "<svg> present after loading completes").not.toBeNull();
    expect(addBtn.querySelector(".btn-label")!.textContent).toBe("Add");
  });
});
