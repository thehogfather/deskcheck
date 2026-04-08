// Side panel entry point. Wires the production Chrome APIs into the
// `mountSidePanel` glue layer. Tests use the dependency-injection seam
// in `sidepanel.ts` directly and never load this file.

import { mountSidePanel, type SidePanelDeps } from "./sidepanel";
import {
  STORAGE_EVENTS,
  STORAGE_SCREENSHOTS,
} from "../constants";
import {
  getFirstRunSeen,
  markFirstRunSeen,
} from "../lib/privacy-store";
import type { Message, TimelineEvent } from "../types";

async function main() {
  const root = document.getElementById("sidepanel-root");
  if (!root) {
    console.error("[DeskCheck] sidepanel root not found");
    return;
  }

  // DEBUG: report visibility changes to the SW so e2e tests can
  // verify whether Chrome is actually hiding the panel on tab
  // switch. This costs nothing at runtime (one listener, one
  // postMessage per visibilitychange) and is invaluable for
  // empirically verifying the tab-switch behavior from inside the
  // panel document itself.
  const reportVisibility = (kind: string) => {
    try {
      chrome.runtime
        .sendMessage({
          type: "SIDEPANEL_VISIBILITY",
          kind,
          visibilityState: document.visibilityState,
          hidden: document.hidden,
          timestamp: Date.now(),
        })
        .catch(() => {
          /* ignore — SW may be asleep */
        });
    } catch {
      /* ignore — chrome API may not be ready */
    }
  };
  reportVisibility("mount");
  document.addEventListener("visibilitychange", () => {
    reportVisibility("change");
  });

  // Fetch any pre-existing session state so the panel mounts directly
  // into the active view if a session is already running when the user
  // opens it.
  const stored = await chrome.storage.local.get([
    STORAGE_EVENTS,
    STORAGE_SCREENSHOTS,
  ]);
  const initialEvents = (stored[STORAGE_EVENTS] as TimelineEvent[] | undefined) ?? [];
  const initialScreenshots = (stored[STORAGE_SCREENSHOTS] as Record<string, string> | undefined) ?? {};

  const deps: SidePanelDeps = {
    root,
    sendMessage: (msg: Message) => chrome.runtime.sendMessage(msg),
    onChanged: chrome.storage.onChanged,
    onWindowFocusChanged: chrome.windows.onFocusChanged,
    getCurrentWindowId: async () => {
      const win = await chrome.windows.getCurrent();
      return win?.id ?? -1;
    },
    getFirstRunSeen,
    markFirstRunSeen,
    initialEvents,
    initialScreenshots,
    // chrome.storage.session is exposed on MV3 builds but not in the
    // ambient @types/chrome we use; cast through unknown.
    sessionStorage: (chrome.storage as unknown as { session: SidePanelDeps["sessionStorage"] }).session,
    queryActiveTab: async () => {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      return tabs[0];
    },
    onRuntimeMessage: chrome.runtime.onMessage,
  };

  await mountSidePanel(deps);
}

void main();
