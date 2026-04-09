import { test, expect } from "./fixtures";

const TEST_PAGE = "https://example.com/";
const SIDE_PANEL_PATH = "src/sidepanel/index.html";

/**
 * Helper: open the side panel HTML in a normal page.
 *
 * Playwright can't programmatically click the browser-chrome action
 * icon, so e2e coverage of the side panel UI loads the same HTML as a
 * regular extension-privileged page. This mounts the full sidepanel
 * DOM (start/pause/stop buttons, events list, reminder panel) and
 * gives it access to chrome.* APIs — identical to the real panel from
 * the script's perspective. The only thing it does NOT exercise is
 * Chrome's per-tab hide/show behavior; that is covered separately by
 * sidepanel-debug.spec.ts.
 */
async function openSidePanelPage(
  context: import("@playwright/test").BrowserContext,
  extensionId: string,
) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${SIDE_PANEL_PATH}`);
  return page;
}

/**
 * Helper: start a session targeting a specific tab URL by sending
 * START_SESSION to the service worker from an extension-privileged
 * page. Mirrors what the side panel's Start button does, but lets the
 * test pick the target tab explicitly so assertions don't depend on
 * which tab happens to be active.
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

  const helper = await openSidePanelPage(context, extensionId);
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
  const helper = await openSidePanelPage(context, extensionId);
  await helper.evaluate(async () => {
    return chrome.runtime.sendMessage({ type: "STOP_SESSION" });
  });
  await helper.close();
}

/**
 * Read the persisted session directly from chrome.storage.local. We
 * use storage as the source of truth rather than GET_SESSION_STATE
 * because chrome.runtime.sendMessage dispatched from inside the SW
 * itself does not fan in to the SW's own onMessage listener.
 */
async function getStoredSession(sw: import("@playwright/test").Worker) {
  return sw.evaluate(async () => {
    const result = await chrome.storage.local.get("deskcheck_session");
    return result.deskcheck_session as
      | { id: string; end_time: string | null }
      | undefined;
  });
}

/**
 * Read the live session metrics via the service worker's
 * GET_SESSION_METRICS message. After feature #5 moved events and
 * screenshots out of chrome.storage.local into OPFS, the only correct
 * way to read counts from a test is via the SW's message handler —
 * it exposes both via `store.countEvents()` / `store.countScreenshots()`.
 *
 * `chrome.runtime.sendMessage` dispatched from inside the SW itself
 * does NOT fan in to the SW's own onMessage listener, so we open a
 * short-lived extension page (the side panel HTML, which is already
 * extension-privileged) and send from there.
 */
async function getMetrics(
  context: import("@playwright/test").BrowserContext,
  extensionId: string,
) {
  const helper = await openSidePanelPage(context, extensionId);
  try {
    const result = (await helper.evaluate(async () => {
      return chrome.runtime.sendMessage({ type: "GET_SESSION_METRICS" });
    })) as
      | { eventCount?: number; screenshotCount?: number }
      | undefined;
    return {
      eventCount: result?.eventCount ?? 0,
      screenshotCount: result?.screenshotCount ?? 0,
    };
  } finally {
    await helper.close();
  }
}

test.describe("Side panel UI", () => {
  test("idle state shows Start + empty-state hint; interaction controls are absent from the DOM (feature #11 hide-not-disable)", async ({
    context,
    extensionId,
  }) => {
    const panel = await openSidePanelPage(context, extensionId);

    await expect(panel.locator("#start-btn")).toBeVisible();

    // Feature #11: the pre-export reminder is absent from the DOM in
    // idle state — it's only mounted when the stop button is present
    // (i.e., during an active session). This is consistent with the
    // hide-not-disable principle.
    await expect(panel.locator("#pre-export-reminder")).toHaveCount(0);

    // PII mode fieldset, metrics row, and empty-state hint are always
    // mounted pre-session.
    await expect(panel.locator("#pii-mode-fieldset")).toBeAttached();
    await expect(panel.locator("#metrics-row")).toBeAttached();
    await expect(panel.locator("#empty-state-hint")).toBeVisible();

    // Feature #11 — annotation, screenshot, picker, and lifecycle
    // controls are STRUCTURALLY ABSENT from the DOM pre-session, not
    // toggled via display:none. "Absent from the DOM" is what the DoD
    // requires, so assert not-attached rather than not-visible.
    for (const id of [
      "annotation-text",
      "add-note-btn",
      "screenshot-btn",
      "pick-element-btn",
      "pause-btn",
      "stop-btn",
      "discard-btn",
    ]) {
      await expect(panel.locator(`#${id}`)).toHaveCount(0);
    }
  });

  test("active state shows Pause/Stop/Discard, hides Start (feature #11)", async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await page.goto(TEST_PAGE, { waitUntil: "domcontentloaded" });

    await startSessionOnTab(context, extensionId, TEST_PAGE);

    const panel = await openSidePanelPage(context, extensionId);
    // Start is absent from the DOM during an active session.
    await expect(panel.locator("#start-btn")).toHaveCount(0);
    await expect(panel.locator("#pause-btn")).toBeVisible();
    await expect(panel.locator("#stop-btn")).toBeVisible();
    await expect(panel.locator("#discard-btn")).toBeVisible();
    await expect(panel.locator("#annotation-text")).toBeVisible();

    await panel.close();
    await stopSession(context, extensionId);
  });
});

test.describe("Session lifecycle", () => {
  test("starting a session persists an unterminated session record", async ({
    context,
    extensionId,
    serviceWorker,
  }) => {
    const page = await context.newPage();
    await page.goto(TEST_PAGE, { waitUntil: "domcontentloaded" });

    expect(await getStoredSession(serviceWorker)).toBeUndefined();

    const { sessionId } = await startSessionOnTab(
      context,
      extensionId,
      TEST_PAGE,
    );

    const stored = await getStoredSession(serviceWorker);
    expect(stored?.id).toBe(sessionId);
    expect(stored?.end_time).toBeNull();

    await stopSession(context, extensionId);
  });

  test("stopping a session stamps the stored session with end_time", async ({
    context,
    extensionId,
    serviceWorker,
  }) => {
    const page = await context.newPage();
    await page.goto(TEST_PAGE, { waitUntil: "domcontentloaded" });

    await startSessionOnTab(context, extensionId, TEST_PAGE);
    expect((await getStoredSession(serviceWorker))?.end_time).toBeNull();

    await stopSession(context, extensionId);

    const stopped = await getStoredSession(serviceWorker);
    expect(stopped?.end_time).toBeTruthy();
  });

  test("clicking on page generates recorded events", async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await page.goto(TEST_PAGE, { waitUntil: "domcontentloaded" });

    await startSessionOnTab(context, extensionId, TEST_PAGE);

    const before = await getMetrics(context, extensionId);
    expect(before.eventCount).toBe(0);

    // Generate click events
    await page.click("h1");
    await page.click("p");
    await page.waitForTimeout(1000);

    const after = await getMetrics(context, extensionId);
    expect(after.eventCount).toBeGreaterThan(0);

    await stopSession(context, extensionId);
  });

  test("screenshot capture stores image data", async ({
    context,
    extensionId,
    serviceWorker,
  }) => {
    const page = await context.newPage();
    await page.goto(TEST_PAGE, { waitUntil: "domcontentloaded" });
    await page.bringToFront();

    const { tabId } = await startSessionOnTab(
      context,
      extensionId,
      TEST_PAGE,
    );
    // startSessionOnTab opened/closed a helper page, so bring the
    // recorded tab back to the foreground before the capture gate.
    await page.bringToFront();

    // Dispatch TAKE_SCREENSHOT from the recorded tab's own
    // content-script context via chrome.scripting.executeScript. This
    // is the only way to send an onMessage-bound runtime message from
    // the test harness while keeping the recorded tab active — the
    // SW's screenshot gate (canCaptureRecordedTab) refuses capture
    // unless the bound tab is the foreground tab of its window, and
    // opening a helper extension page flips that bit.
    await serviceWorker.evaluate(async (tid: number) => {
      await chrome.scripting.executeScript({
        target: { tabId: tid },
        func: () => {
          void chrome.runtime.sendMessage({
            type: "TAKE_SCREENSHOT",
            trigger: "manual",
          });
        },
      });
    }, tabId);

    await page.waitForTimeout(1000);
    const metrics = await getMetrics(context, extensionId);
    expect(metrics.screenshotCount).toBeGreaterThanOrEqual(1);

    await stopSession(context, extensionId);
  });
});

test.describe("Pre-export reminder flow", () => {
  test("clicking Stop reveals the reminder; Keep recording dismisses it", async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await page.goto(TEST_PAGE, { waitUntil: "domcontentloaded" });

    await startSessionOnTab(context, extensionId, TEST_PAGE);

    const panel = await openSidePanelPage(context, extensionId);
    // Wait for the panel's GET_SESSION_STATE round-trip to land us in
    // the active state — Stop is hidden until then.
    await expect(panel.locator("#stop-btn")).toBeVisible();

    await panel.locator("#stop-btn").click();
    await expect(panel.locator("#pre-export-reminder")).not.toHaveClass(
      /\bhidden\b/,
    );
    await expect(panel.locator("#keep-recording-btn")).toBeVisible();
    await expect(panel.locator("#download-btn")).toBeVisible();

    await panel.locator("#keep-recording-btn").click();
    await expect(panel.locator("#pre-export-reminder")).toHaveClass(
      /\bhidden\b/,
    );
    // Session is still active after a cancelled stop.
    await expect(panel.locator("#stop-btn")).toBeVisible();

    await panel.close();
    await stopSession(context, extensionId);
  });
});

test.describe("Export", () => {
  test("EXPORT_SESSION clears the stored session", async ({
    context,
    extensionId,
    serviceWorker,
  }) => {
    const page = await context.newPage();
    await page.goto(TEST_PAGE, { waitUntil: "domcontentloaded" });
    await page.bringToFront();

    await startSessionOnTab(context, extensionId, TEST_PAGE);

    // Generate some data so the session has something to export.
    await page.click("h1");
    await page.waitForTimeout(500);

    await stopSession(context, extensionId);

    // Trigger export programmatically — the side panel's Download
    // button dispatches STOP_SESSION + EXPORT_SESSION behind
    // `chrome.downloads.download({ saveAs: true })`, which in headed
    // Chrome surfaces a native Save dialog that Playwright cannot
    // dismiss. We verify the data pipeline (zip creation + session
    // cleanup) directly; the UI trigger is covered by the
    // pre-export reminder flow test above.
    const helper = await openSidePanelPage(context, extensionId);
    const downloadResult = await helper.evaluate(async () => {
      return chrome.runtime.sendMessage({ type: "EXPORT_SESSION" });
    });
    expect(downloadResult).toBeDefined();

    // Session is cleared by EXPORT_SESSION after the download starts.
    const postExport = await serviceWorker.evaluate(async () => {
      const result = await chrome.storage.local.get("deskcheck_session");
      return result.deskcheck_session;
    });
    expect(postExport).toBeUndefined();

    await helper.close();
  });
});
