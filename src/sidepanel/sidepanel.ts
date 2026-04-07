// Side panel glue layer. Mounts the two-region UI, wires the
// storage.onChanged subscription, manages the (idle | active) state
// machine, persists scroll position per window, and surfaces the
// first-run privacy notice.
//
// PRIVACY-CRITICAL: this module must NOT touch any privileged Chrome
// capture APIs directly (the visible-tab capture, the CDP debugger
// surface, or the scripting injector). All capture goes through the
// service worker via runtime messages. The service worker enforces the
// canCaptureRecordedTab() gate from feature #2. Pinned by
// tests/sidepanel-no-direct-capture.test.ts.
//
// State machine: { "idle" | "active" } + a transient `inFlight` flag
// for in-progress message round-trips. The state is driven by:
//   - START_SESSION ack → active
//   - storage change setting session.end_time → idle
//   - GET_SESSION_STATE response on mount or focus change

import type {
  Message,
  PiiCaptureMode,
  SessionMetadata,
  TimelineEvent,
} from "../types";
import {
  STORAGE_EVENTS,
  STORAGE_SESSION,
  STORAGE_SCREENSHOTS,
} from "../constants";
import {
  eventToRow,
  formatEventTimestamp,
  shouldAutoScroll,
  type SidePanelEventRow,
} from "../lib/sidepanel-render";
import {
  subscribeToEvents,
  type StorageOnChangedApi,
} from "../lib/sidepanel-events-source";
import {
  getScrollPosition,
  setScrollPosition,
  type SessionStorageApi,
} from "../lib/sidepanel-storage";
import { buildFirstRunNoticeModel } from "../lib/privacy-notice";
import { parsePiiMode, DEFAULT_PII_MODE } from "../lib/pii-modes";
import {
  formatDuration,
  formatBytes,
  isOverSizeThreshold,
} from "../lib/session-metrics";
import { SIZE_WARNING_BYTES } from "../constants";

// ─────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────

export interface SidePanelDeps {
  /** Root element to mount into (typically `document.body`). */
  root: HTMLElement;
  /** chrome.runtime.sendMessage shim for tests. */
  sendMessage: (msg: Message) => Promise<unknown>;
  /** chrome.storage.onChanged shim for tests. */
  onChanged: StorageOnChangedApi;
  /** chrome.windows.onFocusChanged shim for cross-window refetch. */
  onWindowFocusChanged: {
    addListener(l: (windowId: number) => void): void;
    removeListener(l: (windowId: number) => void): void;
  };
  /** chrome.windows.getCurrent shim — used to scope per-window scroll state. */
  getCurrentWindowId: () => Promise<number>;
  /** First-run notice flag accessor. */
  getFirstRunSeen: () => Promise<boolean>;
  /** First-run notice flag setter. */
  markFirstRunSeen: () => Promise<void>;
  /** Initial events snapshot (if a session is already running). */
  initialEvents?: TimelineEvent[];
  /** Initial screenshots map. */
  initialScreenshots?: Record<string, string>;
  /** Initial PII mode. */
  initialPiiMode?: PiiCaptureMode;
  /**
   * chrome.storage.session shim used by the scroll-position helper.
   * Defaults to chrome.storage.session in production. Injectable for
   * tests so the helper does not require a global `chrome`.
   */
  sessionStorage?: SessionStorageApi;
  /**
   * chrome.tabs.query shim — used to fetch the active tab when the
   * user clicks Start. Defaults to chrome.tabs.query in production.
   */
  queryActiveTab?: () => Promise<chrome.tabs.Tab | undefined>;
}

export interface SidePanelHandle {
  /** Read the current state for tests. */
  getState(): "idle" | "active";
  /** Tear down listeners and DOM (used between tests). */
  unmount(): void;
}

// ─────────────────────────────────────────────────────────────────────
// DOM helpers (no innerHTML)
// ─────────────────────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string>,
  children?: (Node | string)[],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else node.setAttribute(k, v);
    }
  }
  if (children) {
    for (const child of children) {
      node.appendChild(
        typeof child === "string" ? document.createTextNode(child) : child,
      );
    }
  }
  return node;
}

function clearChildren(node: Element) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

// ─────────────────────────────────────────────────────────────────────
// Mount
// ─────────────────────────────────────────────────────────────────────

export async function mountSidePanel(
  deps: SidePanelDeps,
): Promise<SidePanelHandle> {
  const {
    root,
    sendMessage,
    onChanged,
    onWindowFocusChanged,
    getCurrentWindowId,
    getFirstRunSeen,
    markFirstRunSeen,
  } = deps;

  // ─── Local state ──────────────────────────────────────────────────
  let state: "idle" | "active" = "idle";
  let events: TimelineEvent[] = deps.initialEvents ? [...deps.initialEvents] : [];
  let screenshots: Record<string, string> = { ...(deps.initialScreenshots ?? {}) };
  let selectedPiiMode: PiiCaptureMode = deps.initialPiiMode ?? DEFAULT_PII_MODE;
  let revealed: Set<string> = new Set();
  let windowId: number = -1;
  let scrollDebounce: ReturnType<typeof setTimeout> | null = null;

  // ─── DOM skeleton ─────────────────────────────────────────────────
  clearChildren(root);

  const noticeContainer = el("section", { id: "first-run-notice-container" });

  const eventsList = el("section", { id: "events-list" });
  // Inline flex styles so the integration test can confirm a sticky-bottom layout.
  eventsList.style.flex = "1 1 auto";
  eventsList.style.overflowY = "auto";

  const controls = el("section", { id: "controls" });
  controls.style.flex = "0 0 auto";

  // Apply column flex on the root so events scrolls and controls is pinned.
  root.style.display = "flex";
  root.style.flexDirection = "column";
  root.style.height = "100vh";

  root.appendChild(noticeContainer);
  root.appendChild(eventsList);
  root.appendChild(controls);

  // ─── Controls form ────────────────────────────────────────────────
  const piiFieldset = buildPiiFieldset(selectedPiiMode);
  piiFieldset.addEventListener("change", () => {
    const checked = piiFieldset.querySelector<HTMLInputElement>(
      'input[name="pii-mode"]:checked',
    );
    selectedPiiMode = parsePiiMode(checked?.value);
  });

  const startBtn = el("button", { id: "start-btn", class: "sp-btn primary" }, ["Start session"]);
  const stopBtn = el("button", { id: "stop-btn", class: "sp-btn danger" }, ["Stop & download"]);
  const screenshotBtn = el("button", { id: "screenshot-btn", class: "sp-btn" }, ["Screenshot"]);

  const annotationText = el("textarea", {
    id: "annotation-text",
    placeholder: "What did you expect? What happened instead?",
  }) as HTMLTextAreaElement;
  const addNoteBtn = el("button", { id: "add-note-btn", class: "sp-btn" }, ["Add note"]);

  const metricsRow = el("div", { id: "metrics-row", class: "metrics-row" });
  const metricsDuration = el("span", { class: "metrics-duration" }, ["< 1s"]);
  const metricsCounts = el("span", { class: "metrics-counts" }, ["0 events"]);
  const metricsSize = el("span", { class: "metrics-size" }, ["0 KB"]);
  metricsRow.appendChild(metricsDuration);
  metricsRow.appendChild(document.createTextNode(" · "));
  metricsRow.appendChild(metricsCounts);
  metricsRow.appendChild(document.createTextNode(" · "));
  metricsRow.appendChild(metricsSize);

  controls.appendChild(piiFieldset);
  controls.appendChild(metricsRow);
  controls.appendChild(annotationText);

  const noteRow = el("div", { class: "sp-row" });
  noteRow.appendChild(addNoteBtn);
  noteRow.appendChild(screenshotBtn);
  controls.appendChild(noteRow);

  const sessionRow = el("div", { class: "sp-row" });
  sessionRow.appendChild(startBtn);
  sessionRow.appendChild(stopBtn);
  controls.appendChild(sessionRow);

  // ─── First-run notice ─────────────────────────────────────────────
  let noticeNode: HTMLElement | null = null;
  const firstRunSeen = await getFirstRunSeen();
  if (!firstRunSeen) {
    noticeNode = renderFirstRunNotice(async () => {
      await markFirstRunSeen();
      noticeNode?.remove();
      noticeNode = null;
    });
    noticeContainer.appendChild(noticeNode);
  }

  // ─── Window id + scroll restore ───────────────────────────────────
  try {
    windowId = await getCurrentWindowId();
  } catch {
    windowId = -1;
  }

  // Initial render of any pre-existing events.
  renderAllEvents();

  // Restore scroll after the initial paint settles.
  if (deps.sessionStorage) {
    void (async () => {
      try {
        const pos = await getScrollPosition(windowId, deps.sessionStorage);
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(() => {
            eventsList.scrollTop = pos;
          });
        } else {
          eventsList.scrollTop = pos;
        }
      } catch {
        // Storage may be unavailable in tests; non-fatal.
      }
    })();
  }

  // ─── Wire listeners ───────────────────────────────────────────────

  // Initial state fetch — drives idle/active.
  void refreshSessionState();

  // Subscribe to event appends.
  const eventsSubscription = subscribeToEvents(
    {
      onAppend(newEvents) {
        for (const e of newEvents) {
          events.push(e);
          appendRow(eventToRow(e, screenshots));
        }
        autoScrollIfNeeded();
        updateMetrics();
      },
      onReset(allEvents) {
        events = [...allEvents];
        renderAllEvents();
        updateMetrics();
      },
    },
    { onChanged, initial: events },
  );

  // Listen for session/screenshots changes via the same onChanged hook.
  const sessionListener = (
    changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
    areaName: string,
  ) => {
    if (areaName !== "local") return;
    if (STORAGE_SCREENSHOTS in changes) {
      const next = changes[STORAGE_SCREENSHOTS].newValue as
        | Record<string, string>
        | undefined;
      screenshots = { ...(next ?? {}) };
    }
    if (STORAGE_SESSION in changes) {
      const next = changes[STORAGE_SESSION].newValue as
        | (SessionMetadata & { end_time: string | null })
        | undefined;
      if (!next || next.end_time != null) {
        transitionToIdle();
      } else {
        transitionToActive();
      }
    }
  };
  onChanged.addListener(sessionListener);

  // Cross-window focus refetch.
  const focusListener = (focusedWindowId: number) => {
    if (focusedWindowId < 0) return;
    void refreshSessionState();
  };
  onWindowFocusChanged.addListener(focusListener);

  // Scroll persistence (debounced). Skipped if no sessionStorage shim
  // is provided — the helper would otherwise reach for the global
  // `chrome` which is absent in jsdom tests.
  const scrollHandler = () => {
    if (!deps.sessionStorage) return;
    if (scrollDebounce) clearTimeout(scrollDebounce);
    scrollDebounce = setTimeout(() => {
      void setScrollPosition(windowId, eventsList.scrollTop, deps.sessionStorage);
    }, 200);
  };
  eventsList.addEventListener("scroll", scrollHandler);

  // ─── Button wiring ────────────────────────────────────────────────
  startBtn.addEventListener("click", async () => {
    try {
      const tab = await getActiveTab();
      const response = (await sendMessage({
        type: "START_SESSION",
        tabId: tab?.id ?? 0,
        url: tab?.url ?? "",
        viewport: { width: tab?.width ?? 0, height: tab?.height ?? 0 },
        piiMode: selectedPiiMode,
      })) as { recording: boolean; warnings?: string[] } | undefined;
      if (response?.recording) {
        transitionToActive();
      }
    } catch {
      // Surface to a status line in a future iteration.
    }
  });

  stopBtn.addEventListener("click", async () => {
    try {
      await sendMessage({ type: "STOP_SESSION" });
      transitionToIdle();
      // Trigger export immediately, mirroring the popup's behaviour.
      await sendMessage({ type: "EXPORT_SESSION" });
    } catch {
      // Non-fatal.
    }
  });

  screenshotBtn.addEventListener("click", async () => {
    try {
      await sendMessage({ type: "TAKE_SCREENSHOT", trigger: "manual" });
    } catch {
      // Non-fatal.
    }
  });

  addNoteBtn.addEventListener("click", async () => {
    const text = annotationText.value.trim();
    if (!text) return;
    try {
      await sendMessage({ type: "ADD_ANNOTATION", text });
      annotationText.value = "";
    } catch {
      // Non-fatal.
    }
  });

  // Initial controls visibility.
  applyStateToControls();

  // ─── Helpers ──────────────────────────────────────────────────────

  async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
    if (deps.queryActiveTab) {
      try {
        return await deps.queryActiveTab();
      } catch {
        return undefined;
      }
    }
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      return tabs[0];
    } catch {
      return undefined;
    }
  }

  async function refreshSessionState() {
    try {
      const result = (await sendMessage({ type: "GET_SESSION_STATE" })) as
        | { recording?: boolean; piiMode?: PiiCaptureMode }
        | undefined;
      if (result?.recording) {
        transitionToActive();
      } else {
        transitionToIdle();
      }
      if (result?.piiMode) {
        selectedPiiMode = parsePiiMode(result.piiMode);
        const radio = piiFieldset.querySelector<HTMLInputElement>(
          `input[name="pii-mode"][value="${selectedPiiMode}"]`,
        );
        if (radio) radio.checked = true;
      }
    } catch {
      // SW may be waking up; non-fatal.
    }
  }

  function transitionToActive() {
    state = "active";
    applyStateToControls();
  }

  function transitionToIdle() {
    state = "idle";
    // PRIVACY: clear any revealed thumbnails so prior screen-shared
    // sessions cannot leak after the user stops recording.
    revealed.clear();
    unmountAllRevealedImages();
    applyStateToControls();
  }

  function applyStateToControls() {
    if (state === "active") {
      startBtn.style.display = "none";
      stopBtn.style.display = "";
    } else {
      startBtn.style.display = "";
      stopBtn.style.display = "none";
    }
    // Annotation/screenshot remain enabled in both states. The SW gates
    // capture when no session is active (it's a no-op there). Disabling
    // them in the UI would require a second source of truth.
  }

  function renderAllEvents() {
    clearChildren(eventsList);
    for (const e of events) {
      appendRow(eventToRow(e, screenshots));
    }
  }

  function appendRow(row: SidePanelEventRow) {
    const li = el("div", {
      class: `event-row accent-${row.accent}${row.screenshotPlaceholderId ? " screenshot" : ""}`,
      "data-seq": row.id,
    });
    const time = el("span", { class: "event-time" }, [formatEventTimestamp(row.iso)]);
    const label = el("span", { class: "event-label" }, [row.label]);
    const detail = el("span", { class: "event-detail" }, [row.detail]);
    li.appendChild(time);
    li.appendChild(label);
    if (row.detail) li.appendChild(detail);

    if (row.screenshotPlaceholderId) {
      const placeholder = el("button", {
        class: "screenshot-placeholder",
        "data-screenshot-id": row.screenshotPlaceholderId,
        title: "Click to reveal screenshot",
      }, ["[ click to reveal screenshot ]"]);
      placeholder.addEventListener("click", () => {
        if (!row.screenshotDataUrl) return;
        revealed.add(row.screenshotPlaceholderId!);
        const img = document.createElement("img");
        img.src = row.screenshotDataUrl;
        img.alt = "screenshot";
        img.className = "screenshot-thumb";
        placeholder.replaceWith(img);
      });
      li.appendChild(placeholder);
    }
    eventsList.appendChild(li);
  }

  function unmountAllRevealedImages() {
    const imgs = eventsList.querySelectorAll("img");
    imgs.forEach((img) => img.remove());
  }

  function autoScrollIfNeeded() {
    if (
      shouldAutoScroll(
        eventsList.scrollTop,
        eventsList.scrollHeight,
        eventsList.clientHeight,
      )
    ) {
      eventsList.scrollTop = eventsList.scrollHeight;
    }
  }

  function updateMetrics() {
    const startTime = events[0]?.timestamp ?? new Date().toISOString();
    const start = new Date(startTime).getTime();
    const now = Date.now();
    const elapsed = Number.isFinite(start) ? Math.max(0, now - start) : 0;
    metricsDuration.textContent = formatDuration(elapsed);
    const screenshotCount = events.filter((e) => e.type === "screenshot").length;
    metricsCounts.textContent = `${events.length} events, ${screenshotCount} screenshots`;
    const eventsBytes = JSON.stringify(events).length;
    const screenshotsBytes = Object.values(screenshots).reduce(
      (sum, dataUrl) => sum + dataUrl.length,
      0,
    );
    const total = eventsBytes + screenshotsBytes;
    metricsSize.textContent = formatBytes(total);
    if (isOverSizeThreshold(total, SIZE_WARNING_BYTES)) {
      metricsSize.classList.add("over-threshold");
    } else {
      metricsSize.classList.remove("over-threshold");
    }
  }

  // ─── Handle ───────────────────────────────────────────────────────
  return {
    getState: () => state,
    unmount: () => {
      if (scrollDebounce) clearTimeout(scrollDebounce);
      eventsList.removeEventListener("scroll", scrollHandler);
      onChanged.removeListener(sessionListener);
      onWindowFocusChanged.removeListener(focusListener);
      eventsSubscription.unsubscribe();
      clearChildren(root);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Internal builders
// ─────────────────────────────────────────────────────────────────────

function buildPiiFieldset(initial: PiiCaptureMode): HTMLFieldSetElement {
  const fs = el("fieldset", { id: "pii-mode-fieldset" }) as HTMLFieldSetElement;
  const legend = el("legend", {}, ["Capture inputs"]);
  fs.appendChild(legend);
  const modes: { value: PiiCaptureMode; label: string; hint: string }[] = [
    { value: "full", label: "Full", hint: "values" },
    { value: "metadata", label: "Metadata", hint: "length only" },
    { value: "none", label: "None", hint: "skip inputs" },
  ];
  for (const m of modes) {
    const lbl = el("label", { class: "pii-mode-option" });
    const input = el("input", {
      type: "radio",
      name: "pii-mode",
      value: m.value,
    }) as HTMLInputElement;
    if (m.value === initial) input.checked = true;
    const text = el("span", {}, [` ${m.label} `]);
    const hint = el("span", { class: "hint" }, [m.hint]);
    lbl.appendChild(input);
    lbl.appendChild(text);
    lbl.appendChild(hint);
    fs.appendChild(lbl);
  }
  return fs;
}

function renderFirstRunNotice(onDismiss: () => Promise<void>): HTMLElement {
  const model = buildFirstRunNoticeModel();
  const container = el("div", { id: "first-run-notice", class: "first-run-notice" });
  const title = el("h3", { class: "title" }, [model.title]);
  container.appendChild(title);
  const ul = el("ul");
  for (const bullet of model.bullets) {
    ul.appendChild(el("li", {}, [bullet]));
  }
  container.appendChild(ul);
  const dismiss = el("button", { class: "dismiss-btn" }, [model.dismissLabel]);
  dismiss.addEventListener("click", () => {
    void onDismiss();
  });
  container.appendChild(dismiss);
  return container;
}
