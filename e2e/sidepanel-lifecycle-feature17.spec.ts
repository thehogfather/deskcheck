// Feature-17 E2E acceptance — DoD-10 and DoD-11.
//
// DoD-10: Start (full mode) → generate an event on the page → Pause →
//         Download visible → clicking Download opens the pre-export
//         reminder; #confirm-export-btn is the proceed affordance.
//         Legacy #stop-btn / #discard-btn / #reset-btn absent.
// DoD-11: Start → immediately Pause (no captured events) → only
//         Pause/Resume visible; Download/Clear/End absent → Resume →
//         generate an event → Pause again → Download/Clear now appear.
//
// We don't click #confirm-export-btn in the e2e: in headed Chrome that
// triggers `chrome.downloads.download({ saveAs: true })` which surfaces
// a native Save dialog Playwright cannot dismiss. The data pipeline
// (zip creation + cleanup) is covered by the EXPORT_SESSION test in
// session.spec.ts.

import { test, expect } from "./fixtures";

const TEST_PAGE = "https://example.com/";
const SIDE_PANEL_PATH = "src/sidepanel/index.html";

async function openSidePanelPage(
  context: import("@playwright/test").BrowserContext,
  extensionId: string,
) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${SIDE_PANEL_PATH}`);
  return page;
}

async function startSessionOnTab(
  context: import("@playwright/test").BrowserContext,
  extensionId: string,
  tabUrl: string,
) {
  const sw = context.serviceWorkers()[0];
  const tabId = await sw.evaluate(async (url: string) => {
    const [tab] = await chrome.tabs.query({ url });
    return tab?.id ?? null;
  }, tabUrl);
  if (!tabId) throw new Error(`No tab found for ${tabUrl}`);
  const helper = await openSidePanelPage(context, extensionId);
  const result = await helper.evaluate(
    async ([tid, url]: [number, string]) => {
      return chrome.runtime.sendMessage({
        type: "START_SESSION",
        tabId: tid,
        url,
        viewport: { width: 1280, height: 720 },
        piiMode: "full",
      });
    },
    [tabId, tabUrl] as [number, string],
  );
  await helper.close();
  return { sessionId: result.sessionId, tabId };
}

async function pauseSession(
  context: import("@playwright/test").BrowserContext,
  extensionId: string,
) {
  const helper = await openSidePanelPage(context, extensionId);
  await helper.evaluate(async () => {
    await chrome.runtime.sendMessage({ type: "PAUSE_SESSION" });
  });
  await helper.close();
}

async function resumeSession(
  context: import("@playwright/test").BrowserContext,
  extensionId: string,
) {
  const helper = await openSidePanelPage(context, extensionId);
  await helper.evaluate(async () => {
    await chrome.runtime.sendMessage({ type: "RESUME_SESSION" });
  });
  await helper.close();
}

async function discardSession(
  context: import("@playwright/test").BrowserContext,
  extensionId: string,
) {
  const helper = await openSidePanelPage(context, extensionId);
  await helper.evaluate(async () => {
    await chrome.runtime.sendMessage({ type: "DISCARD_SESSION" });
  });
  await helper.close();
}

async function getEventCount(
  context: import("@playwright/test").BrowserContext,
  extensionId: string,
): Promise<number> {
  const helper = await openSidePanelPage(context, extensionId);
  try {
    const result = (await helper.evaluate(async () => {
      return chrome.runtime.sendMessage({ type: "GET_SESSION_METRICS" });
    })) as { eventCount?: number } | undefined;
    return result?.eventCount ?? 0;
  } finally {
    await helper.close();
  }
}

test.describe("feature-17 — pause-first lifecycle (DoD-10, DoD-11)", () => {
  test("DoD-10 — Start → click → Pause → Download visible; clicking Download opens pre-export reminder", async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await page.goto(TEST_PAGE, { waitUntil: "domcontentloaded" });
    await page.bringToFront();

    await startSessionOnTab(context, extensionId, TEST_PAGE);

    // Generate at least one material event so Download/Clear surface
    // in paused state.
    await page.click("h1");
    // Give the SW time to record the click via the debugger client.
    await expect
      .poll(() => getEventCount(context, extensionId), { timeout: 5000 })
      .toBeGreaterThan(0);

    await pauseSession(context, extensionId);

    const panel = await openSidePanelPage(context, extensionId);

    // Pause-first surface: paused with events shows Pause + Download +
    // Clear. The pause button's label swaps to "Resume". Legacy verbs
    // are absent.
    await expect(panel.locator("#pause-btn .btn-label")).toHaveText("Resume");
    await expect(panel.locator("#download-btn")).toBeVisible();
    await expect(panel.locator("#clear-btn")).toBeVisible();
    await expect(panel.locator("#stop-btn")).toHaveCount(0);
    await expect(panel.locator("#discard-btn")).toHaveCount(0);
    await expect(panel.locator("#reset-btn")).toHaveCount(0);

    // Clicking Download opens the pre-export reminder; the proceed
    // affordance is #confirm-export-btn (renamed from #download-btn to
    // free that id for the toolbar — fixes the latent collision).
    await panel.locator("#download-btn").click();
    await expect(panel.locator("#pre-export-reminder")).not.toHaveClass(
      /\bhidden\b/,
    );
    await expect(panel.locator("#keep-recording-btn")).toBeVisible();
    await expect(panel.locator("#confirm-export-btn")).toBeVisible();

    // Cancel via Keep recording — session stays paused, Download still
    // shown.
    await panel.locator("#keep-recording-btn").click();
    await expect(panel.locator("#pre-export-reminder")).toHaveClass(
      /\bhidden\b/,
    );
    await expect(panel.locator("#download-btn")).toBeVisible();

    await panel.close();
    await discardSession(context, extensionId);
  });

  test("DoD-11 — Start → immediate Pause (no events): only Pause visible; Download/Clear appear after generating an event", async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await page.goto(TEST_PAGE, { waitUntil: "domcontentloaded" });
    await page.bringToFront();

    // Phase A: Start → Pause immediately, no clicks. The session_paused
    // marker is appended but does NOT count towards the material event
    // count, so Download / Clear / End must all be absent.
    await startSessionOnTab(context, extensionId, TEST_PAGE);
    await pauseSession(context, extensionId);

    let panel = await openSidePanelPage(context, extensionId);

    await expect(panel.locator("#pause-btn .btn-label")).toHaveText("Resume");
    await expect(panel.locator("#download-btn")).toHaveCount(0);
    await expect(panel.locator("#clear-btn")).toHaveCount(0);
    await expect(panel.locator("#end-btn")).toHaveCount(0);
    // Legacy verbs are also absent.
    await expect(panel.locator("#stop-btn")).toHaveCount(0);
    await expect(panel.locator("#discard-btn")).toHaveCount(0);
    await expect(panel.locator("#reset-btn")).toHaveCount(0);

    await panel.close();

    // Phase B: Resume → click on page → Pause again. Now the timeline
    // has a material event; Download and Clear must surface.
    await resumeSession(context, extensionId);
    await page.bringToFront();
    await page.click("h1");
    await expect
      .poll(() => getEventCount(context, extensionId), { timeout: 5000 })
      .toBeGreaterThan(0);
    await pauseSession(context, extensionId);

    panel = await openSidePanelPage(context, extensionId);

    await expect(panel.locator("#pause-btn .btn-label")).toHaveText("Resume");
    await expect(panel.locator("#download-btn")).toBeVisible();
    await expect(panel.locator("#clear-btn")).toBeVisible();

    await panel.close();
    await discardSession(context, extensionId);
  });

  test("running state shows only Pause; Download/Clear/End all absent mid-recording", async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await page.goto(TEST_PAGE, { waitUntil: "domcontentloaded" });
    await page.bringToFront();

    await startSessionOnTab(context, extensionId, TEST_PAGE);
    // Generate an event so even with hasEvents=true, the running state
    // still hides the paused-only exits.
    await page.click("h1");
    await expect
      .poll(() => getEventCount(context, extensionId), { timeout: 5000 })
      .toBeGreaterThan(0);

    const panel = await openSidePanelPage(context, extensionId);

    await expect(panel.locator("#pause-btn .btn-label")).toHaveText("Pause");
    await expect(panel.locator("#download-btn")).toHaveCount(0);
    await expect(panel.locator("#clear-btn")).toHaveCount(0);
    await expect(panel.locator("#end-btn")).toHaveCount(0);

    await panel.close();
    await discardSession(context, extensionId);
  });
});
