// STUB — Phase 3 (failing acceptance tests). Phase 4 will implement.
//
// Side panel glue layer. Mounts the two-region UI, wires the
// storage.onChanged subscription, manages the (idle | active) state
// machine, persists scroll position per window, and surfaces the
// first-run privacy notice.
//
// PRIVACY-CRITICAL: this module must NOT call chrome.tabs.captureVisibleTab,
// chrome.debugger, or chrome.scripting directly. All capture goes
// through the service worker via runtime messages. Pinned by
// tests/sidepanel-no-direct-capture.test.ts.

import type { Message, PiiCaptureMode } from "../types";

export interface SidePanelDeps {
  /** Root element to mount into (typically `document.body`). */
  root: HTMLElement;
  /** chrome.runtime.sendMessage shim for tests. */
  sendMessage: (msg: Message) => Promise<unknown>;
  /** chrome.storage.onChanged shim for tests. */
  onChanged: {
    addListener(
      l: (
        changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
        area: string,
      ) => void,
    ): void;
    removeListener(
      l: (
        changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
        area: string,
      ) => void,
    ): void;
  };
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
  initialEvents?: import("../types").TimelineEvent[];
  /** Initial screenshots map. */
  initialScreenshots?: Record<string, string>;
  /** Initial PII mode. */
  initialPiiMode?: PiiCaptureMode;
}

export interface SidePanelHandle {
  /** Read the current state for tests. */
  getState(): "idle" | "active";
  /** Tear down listeners and DOM (used between tests). */
  unmount(): void;
}

export async function mountSidePanel(_deps: SidePanelDeps): Promise<SidePanelHandle> {
  throw new Error("sidepanel.mountSidePanel not implemented");
}
