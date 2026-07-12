import { test, expect } from "./fixtures";
import type { BrowserContext, Worker } from "@playwright/test";

// Feature #7 — opt-in tab switching. Exercises the REAL chrome.debugger
// move across two real tabs (the part the unit tests can only mock):
// SWITCH_RECORDING_TAB detaches the old tab, attaches the new one,
// rebinds the session, and logs a tab_switch event into the timeline.
//
// The offer UI itself is covered by sidepanel.test.ts — it cannot be
// driven here because the e2e harness mounts the panel as a standalone
// chrome-extension:// page (where the offer is intentionally suppressed,
// since a standalone page has no web tab to switch recording to).

const TAB_A = "https://example.com/";
const TAB_B = "https://example.org/";
const SIDE_PANEL_PATH = "src/sidepanel/index.html";

async function openSidePanelPage(context: BrowserContext, extensionId: string) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${SIDE_PANEL_PATH}`);
  return page;
}

async function getTabId(sw: Worker, url: string): Promise<number> {
  const id = await sw.evaluate(async (u: string) => {
    const [tab] = await chrome.tabs.query({ url: u });
    return tab?.id ?? null;
  }, url);
  if (!id) throw new Error(`No tab found for ${url}`);
  return id;
}

// chrome.runtime.sendMessage dispatched from inside the SW does not fan
// in to its own onMessage listener, so send from a short-lived
// extension-privileged page (the same trick the other e2e helpers use).
async function sendFromExtPage(
  context: BrowserContext,
  extensionId: string,
  msg: Record<string, unknown>,
): Promise<any> {
  const helper = await openSidePanelPage(context, extensionId);
  try {
    return await helper.evaluate(
      (m) => chrome.runtime.sendMessage(m),
      msg,
    );
  } finally {
    await helper.close();
  }
}

async function getStoredSession(sw: Worker) {
  return sw.evaluate(async () => {
    const result = await chrome.storage.local.get("deskcheck_session");
    return result.deskcheck_session as
      | { id: string; tab_id: number; end_time: string | null }
      | undefined;
  });
}

test.describe("feature #7 — opt-in tab switching (e2e)", () => {
  test("SWITCH_RECORDING_TAB moves the debugger, rebinds the session, and logs a tab_switch event", async ({
    context,
    extensionId,
    serviceWorker,
  }) => {
    const pageA = await context.newPage();
    await pageA.goto(TAB_A, { waitUntil: "domcontentloaded" });
    const pageB = await context.newPage();
    await pageB.goto(TAB_B, { waitUntil: "domcontentloaded" });

    const aId = await getTabId(serviceWorker, TAB_A);
    const bId = await getTabId(serviceWorker, TAB_B);

    // Start recording on tab A.
    await sendFromExtPage(context, extensionId, {
      type: "START_SESSION",
      tabId: aId,
      url: TAB_A,
      viewport: { width: 1280, height: 720 },
    });
    expect((await getStoredSession(serviceWorker))?.tab_id).toBe(aId);

    // Switch the recording to tab B.
    const res = await sendFromExtPage(context, extensionId, {
      type: "SWITCH_RECORDING_TAB",
      tabId: bId,
    });
    expect(res.switched).toBe(true);

    // The session is now bound to tab B.
    expect((await getStoredSession(serviceWorker))?.tab_id).toBe(bId);

    // A tab_switch event A→B is in the timeline.
    const snapshot = (await sendFromExtPage(context, extensionId, {
      type: "GET_EVENTS_SNAPSHOT",
    })) as { events: Array<Record<string, unknown>> };
    const tabSwitch = snapshot.events.find((e) => e.type === "tab_switch");
    expect(tabSwitch).toBeTruthy();
    expect(tabSwitch!.from_tab_id).toBe(aId);
    expect(tabSwitch!.to_tab_id).toBe(bId);

    await sendFromExtPage(context, extensionId, { type: "STOP_SESSION" });
  });
});
