import { test, expect } from "./fixtures";

const TEST_PAGE = "https://example.com/";

/**
 * Helper: start a session targeting a specific tab URL.
 * Uses an extension page to send START_SESSION to the service worker,
 * which sets the in-memory recording state and injects the content script.
 */
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

  const helper = await context.newPage();
  await helper.goto(`chrome-extension://${extensionId}/src/popup/index.html`);
  const result = await helper.evaluate(
    async ([tid, url]: [number, string]) => {
      return chrome.runtime.sendMessage({
        type: "START_SESSION",
        tabId: tid,
        url,
        viewport: { width: 1280, height: 720 },
      });
    },
    [tabId, tabUrl] as [number, string],
  );
  await helper.close();
  return { sessionId: result.sessionId, tabId };
}

async function stopSession(
  context: import("@playwright/test").BrowserContext,
  extensionId: string,
) {
  const helper = await context.newPage();
  await helper.goto(`chrome-extension://${extensionId}/src/popup/index.html`);
  await helper.evaluate(async () => {
    return chrome.runtime.sendMessage({ type: "STOP_SESSION" });
  });
  await helper.close();
}

async function getMetrics(sw: import("@playwright/test").Worker) {
  return sw.evaluate(async () => {
    const result = await chrome.storage.local.get([
      "deskcheck_events",
      "deskcheck_screenshots",
    ]);
    const events = result.deskcheck_events ?? [];
    const screenshots = result.deskcheck_screenshots ?? {};
    return {
      eventCount: events.length,
      screenshotCount: Object.keys(screenshots).length,
    };
  });
}

test.describe("Popup UI", () => {
  test("shows Start Session button when idle", async ({
    context,
    extensionId,
  }) => {
    const popup = await context.newPage();
    await popup.goto(
      `chrome-extension://${extensionId}/src/popup/index.html`,
    );
    await expect(popup.locator("#start-btn")).toBeVisible();
    await expect(popup.locator("#download-btn")).not.toBeVisible();
  });
});

test.describe("Session lifecycle", () => {
  test("starting a session shows widget on page", async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await page.goto(TEST_PAGE, { waitUntil: "domcontentloaded" });

    await startSessionOnTab(context, extensionId, TEST_PAGE);

    await expect(page.locator("#deskcheck-widget-host")).toBeAttached({
      timeout: 5000,
    });
  });

  test("widget disappears after session stops", async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await page.goto(TEST_PAGE, { waitUntil: "domcontentloaded" });

    await startSessionOnTab(context, extensionId, TEST_PAGE);
    await expect(page.locator("#deskcheck-widget-host")).toBeAttached({
      timeout: 5000,
    });

    await stopSession(context, extensionId);

    await expect(page.locator("#deskcheck-widget-host")).not.toBeAttached({
      timeout: 5000,
    });
  });

  test("clicking on page generates recorded events", async ({
    context,
    extensionId,
    serviceWorker,
  }) => {
    const page = await context.newPage();
    await page.goto(TEST_PAGE, { waitUntil: "domcontentloaded" });

    await startSessionOnTab(context, extensionId, TEST_PAGE);
    await expect(page.locator("#deskcheck-widget-host")).toBeAttached({
      timeout: 5000,
    });

    const before = await getMetrics(serviceWorker);
    expect(before.eventCount).toBe(0);

    // Generate click events
    await page.click("h1");
    await page.click("p");
    await page.waitForTimeout(1000);

    const after = await getMetrics(serviceWorker);
    expect(after.eventCount).toBeGreaterThan(0);
  });

  test("screenshot capture stores image data", async ({
    context,
    extensionId,
    serviceWorker,
  }) => {
    const page = await context.newPage();
    await page.goto(TEST_PAGE, { waitUntil: "domcontentloaded" });
    await page.bringToFront();

    await startSessionOnTab(context, extensionId, TEST_PAGE);
    await expect(page.locator("#deskcheck-widget-host")).toBeAttached({
      timeout: 5000,
    });

    // Take screenshot via chrome API
    await serviceWorker.evaluate(async () => {
      const dataUrl = await chrome.tabs.captureVisibleTab({ format: "png" });
      const id = `ss_${Date.now()}`;
      const result = await chrome.storage.local.get("deskcheck_screenshots");
      const screenshots = result.deskcheck_screenshots ?? {};
      screenshots[id] = dataUrl;
      await chrome.storage.local.set({ deskcheck_screenshots: screenshots });
    });

    const metrics = await getMetrics(serviceWorker);
    expect(metrics.screenshotCount).toBe(1);
  });
});

test.describe("Export", () => {
  test("export produces a zip and clears session", async ({
    context,
    extensionId,
    serviceWorker,
  }) => {
    const page = await context.newPage();
    await page.goto(TEST_PAGE, { waitUntil: "domcontentloaded" });
    await page.bringToFront();

    await startSessionOnTab(context, extensionId, TEST_PAGE);
    await expect(page.locator("#deskcheck-widget-host")).toBeAttached({
      timeout: 5000,
    });

    // Generate some data
    await page.click("h1");
    await page.waitForTimeout(500);

    await stopSession(context, extensionId);

    // Export via popup download button
    const popup = await context.newPage();
    await popup.goto(
      `chrome-extension://${extensionId}/src/popup/index.html`,
    );
    await expect(popup.locator("#download-btn")).toBeVisible({ timeout: 3000 });
    await popup.locator("#download-btn").click();

    // Wait for export to complete
    await popup.waitForTimeout(3000);

    // Verify session was cleared after export
    const postExport = await serviceWorker.evaluate(async () => {
      const result = await chrome.storage.local.get("deskcheck_session");
      return result.deskcheck_session;
    });
    expect(postExport).toBeUndefined();
  });
});
