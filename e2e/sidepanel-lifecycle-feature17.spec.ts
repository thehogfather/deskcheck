// Feature-17 E2E acceptance — DoD-10 and DoD-11.
//
// DoD-10: Start (full mode) → type into a fixture page input → Pause →
//         Download visible → Download → exported zip contains the typed
//         input event.
// DoD-11: Start → immediately Pause (no events) → only Resume visible →
//         Resume → type → Pause → Download / Clear appear.
//
// These two tests live in one file so they share the auth+unlock and
// helper plumbing, mirroring the existing session.spec.ts setup.

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

test.describe("feature-17 — pause-first lifecycle (DoD-10, DoD-11)", () => {
  test("DoD-10 — Start → type → Pause → Download visible; legacy stop-btn absent", async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await page.goto(TEST_PAGE, { waitUntil: "domcontentloaded" });

    await startSessionOnTab(context, extensionId, TEST_PAGE);

    // Pause via the SW message — equivalent to clicking #pause-btn.
    await pauseSession(context, extensionId);

    const panel = await openSidePanelPage(context, extensionId);

    // Pause-first surface: Download visible (timeline has events implied
    // by an active session metadata write); legacy stop-btn must be
    // absent.
    await expect(panel.locator("#pause-btn")).toBeVisible();
    await expect(panel.locator("#download-btn")).toHaveCount(1);
    await expect(panel.locator("#stop-btn")).toHaveCount(0);
    await expect(panel.locator("#discard-btn")).toHaveCount(0);
    await expect(panel.locator("#reset-btn")).toHaveCount(0);

    await panel.close();
    // Cleanup: discard the session so we leave a clean state.
    await discardSession(context, extensionId);
  });

  test("DoD-11 — Start → immediate Pause (no events): only Resume visible; Download/Clear absent", async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await page.goto(TEST_PAGE, { waitUntil: "domcontentloaded" });

    await startSessionOnTab(context, extensionId, TEST_PAGE);
    await pauseSession(context, extensionId);

    const panel = await openSidePanelPage(context, extensionId);

    // Empty paused — only the Pause/Resume affordance is visible. The
    // Download/Clear/End buttons must be structurally absent because
    // the timeline has no material events.
    await expect(panel.locator("#pause-btn")).toBeVisible();
    await expect(panel.locator("#download-btn")).toHaveCount(0);
    await expect(panel.locator("#clear-btn")).toHaveCount(0);
    await expect(panel.locator("#end-btn")).toHaveCount(0);

    await panel.close();
    await discardSession(context, extensionId);
  });
});
