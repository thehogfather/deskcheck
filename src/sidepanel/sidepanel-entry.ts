// Side panel entry point. Wires the production Chrome APIs into the
// `mountSidePanel` glue layer. Tests use the dependency-injection seam
// in `sidepanel.ts` directly and never load this file.

import { mountSidePanel, type SidePanelDeps } from "./sidepanel";
import { getFirstRunSeen, markFirstRunSeen } from "../lib/privacy-store";
import type { Message } from "../types";

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

  // Events and screenshots no longer live in chrome.storage.local
  // (feature #5 moved them to OPFS). The side panel hydrates its
  // initial events feed by sending GET_EVENTS_SNAPSHOT to the service
  // worker — see sidepanel.ts.

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
    // chrome.storage.session is exposed on MV3 builds but not in the
    // ambient @types/chrome we use; cast through unknown.
    sessionStorage: (chrome.storage as unknown as { session: SidePanelDeps["sessionStorage"] }).session,
    queryActiveTab: async () => {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      return tabs[0];
    },
    onRuntimeMessage: chrome.runtime.onMessage as unknown as SidePanelDeps["onRuntimeMessage"],
    readStorage: (keys: string[]) => chrome.storage.local.get(keys),
  };

  await mountSidePanel(deps);
}

void main();
