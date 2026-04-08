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
  ElementInfo,
  Message,
  PiiCaptureMode,
  SessionMetadata,
  TimelineEvent,
} from "../types";
import { STORAGE_SESSION } from "../constants";
import { cropScreenshot } from "../lib/image-utils";
import { PRIVACY_REMINDER_LINE } from "../lib/privacy";
import {
  eventToRow,
  formatEventTimestamp,
  shouldAutoScroll,
  type SidePanelEventRow,
} from "../lib/sidepanel-render";
import { subscribeToEvents } from "../lib/sidepanel-events-source";
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

// chrome.storage.onChanged shape — used by the side panel to react to
// session metadata changes. Events and screenshots no longer flow through
// chrome.storage.local; those come via runtime broadcasts (see
// sidepanel-events-source.ts).
export interface StorageOnChangedApi {
  addListener(
    listener: (
      changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
      areaName: string,
    ) => void,
  ): void;
  removeListener(
    listener: (
      changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
      areaName: string,
    ) => void,
  ): void;
}

export interface SidePanelDeps {
  /** Root element to mount into (typically `document.body`). */
  root: HTMLElement;
  /** chrome.runtime.sendMessage shim for tests. */
  sendMessage: (msg: Message) => Promise<unknown>;
  /** chrome.storage.onChanged shim for tests. Used to observe session
   *  metadata changes (start/stop) — events and screenshots come via
   *  runtime broadcasts now. */
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
  /**
   * chrome.runtime.onMessage shim. The side panel listens for:
   *  - `PICK_ELEMENT_RESULT` from the content script after a "Pick
   *    element" round-trip,
   *  - `EVENT_APPENDED` / `SCREENSHOT_APPENDED` / `SESSION_CLEARED`
   *    broadcasts from the service worker (the live event feed).
   * Injectable for tests.
   */
  onRuntimeMessage?: {
    addListener(l: (msg: Message, ...rest: unknown[]) => unknown): void;
    removeListener(l: (msg: Message, ...rest: unknown[]) => unknown): void;
  };
}

export interface SidePanelHandle {
  /** Read the current state for tests. */
  getState(): "idle" | "active";
  /** Read whether the active session is currently paused. */
  isPaused(): boolean;
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
  let paused = false;
  let events: TimelineEvent[] = deps.initialEvents ? [...deps.initialEvents] : [];
  let screenshots: Record<string, string> = { ...(deps.initialScreenshots ?? {}) };
  let selectedPiiMode: PiiCaptureMode = deps.initialPiiMode ?? DEFAULT_PII_MODE;
  let selectedElement: ElementInfo | null = null;
  let selectedElementDpr: number = 1;
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
  const pauseBtn = el("button", { id: "pause-btn", class: "sp-btn" }, ["Pause"]);
  const stopBtn = el("button", { id: "stop-btn", class: "sp-btn danger" }, ["Stop & download"]);
  const screenshotBtn = el("button", { id: "screenshot-btn", class: "sp-btn" }, ["Screenshot"]);
  const pickElementBtn = el("button", { id: "pick-element-btn", class: "sp-btn" }, ["Pick element"]);

  const annotationText = el("textarea", {
    id: "annotation-text",
    placeholder: "What did you expect? What happened instead?",
  }) as HTMLTextAreaElement;
  const addNoteBtn = el("button", { id: "add-note-btn", class: "sp-btn" }, ["Add note"]);

  const elementChip = el("div", { id: "selected-element", class: "selected-element-chip hidden" });

  const metricsRow = el("div", { id: "metrics-row", class: "metrics-row" });
  const metricsDuration = el("span", { class: "metrics-duration" }, ["< 1s"]);
  const metricsCounts = el("span", { class: "metrics-counts" }, ["0 events"]);
  const metricsSize = el("span", { class: "metrics-size" }, ["0 KB"]);
  const pausedBadge = el("span", { id: "paused-badge", class: "metrics-paused hidden" }, ["paused"]);
  metricsRow.appendChild(metricsDuration);
  metricsRow.appendChild(document.createTextNode(" · "));
  metricsRow.appendChild(metricsCounts);
  metricsRow.appendChild(document.createTextNode(" · "));
  metricsRow.appendChild(metricsSize);
  metricsRow.appendChild(document.createTextNode(" "));
  metricsRow.appendChild(pausedBadge);

  // Pre-export reminder panel — hidden until the user clicks Stop.
  const reminderPanel = el("div", { id: "pre-export-reminder", class: "pre-export-reminder hidden", role: "alertdialog" });
  const reminderText = el("p", { class: "reminder-text" }, [PRIVACY_REMINDER_LINE]);
  const reminderActions = el("div", { class: "sp-row" });
  const keepRecordingBtn = el("button", { id: "keep-recording-btn", class: "sp-btn" }, ["Keep recording"]);
  const downloadBtn = el("button", { id: "download-btn", class: "sp-btn danger" }, ["Download"]);
  reminderActions.appendChild(keepRecordingBtn);
  reminderActions.appendChild(downloadBtn);
  reminderPanel.appendChild(reminderText);
  reminderPanel.appendChild(reminderActions);

  controls.appendChild(piiFieldset);
  controls.appendChild(metricsRow);
  controls.appendChild(elementChip);
  controls.appendChild(annotationText);

  const noteRow = el("div", { class: "sp-row" });
  noteRow.appendChild(addNoteBtn);
  noteRow.appendChild(pickElementBtn);
  noteRow.appendChild(screenshotBtn);
  controls.appendChild(noteRow);

  const sessionRow = el("div", { class: "sp-row" });
  sessionRow.appendChild(startBtn);
  sessionRow.appendChild(pauseBtn);
  sessionRow.appendChild(stopBtn);
  controls.appendChild(sessionRow);

  controls.appendChild(reminderPanel);

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

  // Hydrate the events feed from the service worker. After feature #5
  // events live in OPFS, not chrome.storage.local, so the side panel
  // can no longer just read them off a storage key on mount.
  void (async () => {
    try {
      const snapshot = (await sendMessage({ type: "GET_EVENTS_SNAPSHOT" })) as
        | { events?: TimelineEvent[]; screenshots?: Record<string, string> }
        | undefined;
      if (snapshot?.screenshots) {
        screenshots = { ...screenshots, ...snapshot.screenshots };
      }
      if (snapshot?.events && snapshot.events.length > 0) {
        events = [...snapshot.events];
        renderAllEvents();
        updateMetrics();
      } else if (events.length > 0) {
        // initialEvents was provided by deps; re-render with any
        // screenshots that arrived alongside the snapshot.
        renderAllEvents();
        updateMetrics();
      }
    } catch {
      // SW may not be ready yet — fall back to whatever initialEvents/
      // initialScreenshots the deps provided.
    }
  })();

  // Listen for session metadata changes via chrome.storage.onChanged.
  // Events and screenshots no longer live in chrome.storage.local —
  // those updates come via runtime broadcasts (see below).
  const sessionListener = (
    changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
    areaName: string,
  ) => {
    if (areaName !== "local") return;
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

  // Subscribe to live event broadcasts from the service worker.
  // EVENT_APPENDED → onAppend, SESSION_CLEARED → onReset(empty).
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
        screenshots = {};
        renderAllEvents();
        updateMetrics();
      },
    },
    deps.onRuntimeMessage ? { onMessage: deps.onRuntimeMessage } : undefined,
  );

  // Cross-window focus refetch.
  const focusListener = (focusedWindowId: number) => {
    if (focusedWindowId < 0) return;
    void refreshSessionState();
  };
  onWindowFocusChanged.addListener(focusListener);

  // Runtime message listener — handles PICK_ELEMENT_RESULT (from the
  // content script after element picker) and SCREENSHOT_APPENDED (so
  // newly captured screenshot bytes can be rendered inline as
  // thumbnails on existing event rows). Both share the same
  // chrome.runtime.onMessage hook the events subscription uses.
  const runtimeListener = (msg: Message) => {
    if (msg.type === "PICK_ELEMENT_RESULT") {
      onPickResult(msg.element, msg.devicePixelRatio);
      return;
    }
    if (msg.type === "SCREENSHOT_APPENDED") {
      screenshots[msg.id] = msg.dataUrl;
      // Backfill any already-rendered annotation rows that referenced
      // this screenshot id before the bytes arrived.
      hydrateThumbsForScreenshot(msg.id, msg.dataUrl);
      return;
    }
  };
  if (deps.onRuntimeMessage) {
    deps.onRuntimeMessage.addListener(runtimeListener);
  } else if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener(runtimeListener);
  }

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

  // Stop & download is gated by an inline pre-export reminder. Clicking
  // Stop opens the reminder; the user must explicitly choose Download
  // (proceed) or Keep recording (cancel). Anti-muscle-memory for a
  // privacy control — initial focus goes to Keep recording.
  stopBtn.addEventListener("click", () => {
    if (state !== "active") return;
    showReminder();
  });

  keepRecordingBtn.addEventListener("click", () => {
    hideReminder();
  });

  downloadBtn.addEventListener("click", async () => {
    hideReminder();
    try {
      await sendMessage({ type: "STOP_SESSION" });
      transitionToIdle();
      await sendMessage({ type: "EXPORT_SESSION" });
    } catch {
      // Non-fatal.
    }
  });

  pauseBtn.addEventListener("click", async () => {
    try {
      if (paused) {
        await sendMessage({ type: "RESUME_SESSION" });
        paused = false;
      } else {
        await sendMessage({ type: "PAUSE_SESSION" });
        paused = true;
      }
      applyStateToControls();
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

  pickElementBtn.addEventListener("click", async () => {
    try {
      // The picker overlay lives in the recorded tab's content script.
      // We message it directly via the active tab so the overlay
      // appears on the right page even if the user has multiple tabs.
      const tab = await getActiveTab();
      if (!tab?.id) return;
      await chrome.tabs.sendMessage(tab.id, { type: "START_ELEMENT_PICKER" });
    } catch {
      // Non-fatal — content script may not be injected on chrome:// pages.
    }
  });

  addNoteBtn.addEventListener("click", async () => {
    const text = annotationText.value.trim();
    if (!text) return;
    try {
      // If the user picked an element, crop a fresh full-page screenshot
      // to its bounding box and ship the cropped data with the
      // annotation. The crop happens at submit time so the page reflects
      // its current state, matching the original widget semantic.
      let elementScreenshotData: string | undefined;
      if (selectedElement?.bounding_box) {
        try {
          const response = (await sendMessage({
            type: "TAKE_SCREENSHOT",
            trigger: "annotation",
          })) as { dataUrl?: string } | undefined;
          if (response?.dataUrl) {
            elementScreenshotData = await cropScreenshot(
              response.dataUrl,
              selectedElement.bounding_box,
              selectedElementDpr,
            );
          }
        } catch {
          // Fall back to annotation without element screenshot.
        }
      }

      await sendMessage({
        type: "ADD_ANNOTATION",
        text,
        element: selectedElement ?? undefined,
        elementScreenshotData,
      });
      annotationText.value = "";
      clearSelectedElement();
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
        | { recording?: boolean; paused?: boolean; piiMode?: PiiCaptureMode }
        | undefined;
      if (result?.recording) {
        transitionToActive();
      } else {
        transitionToIdle();
      }
      paused = !!result?.paused;
      applyStateToControls();
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
    paused = false;
    hideReminder();
    clearSelectedElement();
    applyStateToControls();
  }

  function applyStateToControls() {
    if (state === "active") {
      startBtn.style.display = "none";
      pauseBtn.style.display = "";
      stopBtn.style.display = "";
      pauseBtn.textContent = paused ? "Resume" : "Pause";
      pauseBtn.classList.toggle("primary", paused);
      pausedBadge.classList.toggle("hidden", !paused);
    } else {
      startBtn.style.display = "";
      pauseBtn.style.display = "none";
      stopBtn.style.display = "none";
      pausedBadge.classList.add("hidden");
    }
    // Annotation/screenshot remain enabled in both states. The SW gates
    // capture when no session is active (it's a no-op there).
  }

  function showReminder() {
    reminderPanel.classList.remove("hidden");
    keepRecordingBtn.focus();
  }

  function hideReminder() {
    reminderPanel.classList.add("hidden");
  }

  function onPickResult(element: ElementInfo | null, dpr: number) {
    if (!element) {
      clearSelectedElement();
      return;
    }
    selectedElement = element;
    selectedElementDpr = dpr || 1;
    elementChip.classList.remove("hidden");
    clearChildren(elementChip);
    const label = `${element.tag}${element.id ? "#" + element.id : ""} → ${element.selector}`;
    const labelSpan = el("span", { class: "chip-label" }, [label]);
    const clearBtn = el("button", { class: "chip-clear", title: "Clear element selection" }, ["×"]);
    clearBtn.addEventListener("click", () => clearSelectedElement());
    elementChip.appendChild(labelSpan);
    elementChip.appendChild(clearBtn);
  }

  function clearSelectedElement() {
    selectedElement = null;
    selectedElementDpr = 1;
    elementChip.classList.add("hidden");
    clearChildren(elementChip);
  }

  function renderAllEvents() {
    clearChildren(eventsList);
    for (const e of events) {
      appendRow(eventToRow(e, screenshots));
    }
  }

  // Backfill thumbnails for an already-rendered row when its
  // screenshot bytes arrive after the event row was created. This
  // happens when the SCREENSHOT_APPENDED broadcast lands AFTER the
  // EVENT_APPENDED for the annotation that references it. The order
  // is not guaranteed because the SW broadcasts independently for
  // each store mutation.
  function hydrateThumbsForScreenshot(id: string, dataUrl: string) {
    const placeholders = eventsList.querySelectorAll<HTMLImageElement>(
      `img.event-thumb[data-screenshot-id="${CSS.escape(id)}"]`,
    );
    for (const img of placeholders) {
      if (!img.src || img.src === "" || img.src === window.location.href) {
        img.src = dataUrl;
      }
    }
    // Also re-render any rows whose images list referenced this id
    // but had no <img> placeholder rendered (because dataUrl was
    // missing at row-creation time).
    let needsRerender = false;
    for (const e of events) {
      if (e.type === "screenshot" && e.id === id) {
        needsRerender = true;
        break;
      }
      if (e.type === "annotation" && (e.screenshot_id === id || e.element_screenshot_id === id)) {
        needsRerender = true;
        break;
      }
    }
    if (needsRerender) renderAllEvents();
  }

  function appendRow(row: SidePanelEventRow) {
    const li = el("div", {
      class: `event-row accent-${row.accent}${row.images.length > 0 ? " has-images" : ""}`,
      "data-seq": row.id,
    });
    const time = el("span", { class: "event-time" }, [formatEventTimestamp(row.iso)]);
    const label = el("span", { class: "event-label" }, [row.label]);
    const detail = el("span", { class: "event-detail" }, [row.detail]);
    li.appendChild(time);
    li.appendChild(label);
    if (row.detail) li.appendChild(detail);

    if (row.images.length > 0) {
      const gallery = el("div", { class: "event-thumbs" });
      for (const image of row.images) {
        if (!image.dataUrl) continue;
        const img = document.createElement("img");
        img.src = image.dataUrl;
        img.alt = "screenshot";
        img.className = "event-thumb";
        img.dataset.screenshotId = image.id;
        gallery.appendChild(img);
      }
      if (gallery.children.length > 0) {
        li.appendChild(gallery);
      }
    }
    eventsList.appendChild(li);
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
    isPaused: () => paused,
    unmount: () => {
      if (scrollDebounce) clearTimeout(scrollDebounce);
      eventsList.removeEventListener("scroll", scrollHandler);
      onChanged.removeListener(sessionListener);
      onWindowFocusChanged.removeListener(focusListener);
      if (deps.onRuntimeMessage) {
        deps.onRuntimeMessage.removeListener(runtimeListener);
      } else if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
        chrome.runtime.onMessage.removeListener(runtimeListener);
      }
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
