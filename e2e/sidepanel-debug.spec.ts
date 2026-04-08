// Empirical e2e verification of the bind-on-open side panel model.
//
// Playwright cannot directly click the extension's toolbar icon
// (browser chrome is off-limits), so we synthesize the required
// user gesture for chrome.sidePanel.open() via CDP Runtime.evaluate
// with userGesture:true running in an extension-privileged page.
//
// The key signal for panel visibility is NOT chrome.runtime
// .getContexts (which reports the document as loaded even when Chrome
// is visually hiding it), but the side panel page's own
// document.visibilityState. The sidepanel-entry module posts every
// visibilitychange to the SW, which buffers the events on
// globalThis.__deskcheckVisibilityReports. The test reads that buffer
// and checks the "hidden" / "visible" sequence across tab switches.
//
// This spec is the canonical diagnostic for issue
// GoogleChrome/chrome-extensions-samples#987 — "Opening SidePanel
// with tabId Results in Global SidePanel". The fix is to avoid
// `side_panel.default_path` in manifest and configure the panel
// exclusively via per-tab setOptions, with setOptions + open fired
// synchronously from the click handler so both share the gesture
// window.

import { test, expect } from "./fixtures";

interface VisibilityReport {
  kind: string;
  visibilityState: string;
  hidden: boolean;
  timestamp: number;
}

async function clearReports(
  sw: import("@playwright/test").Worker,
): Promise<void> {
  await sw.evaluate(() => {
    const g = globalThis as unknown as {
      __deskcheckVisibilityReports?: unknown[];
    };
    if (Array.isArray(g.__deskcheckVisibilityReports)) {
      g.__deskcheckVisibilityReports.length = 0;
    }
  });
}

async function readReports(
  sw: import("@playwright/test").Worker,
): Promise<VisibilityReport[]> {
  return (await sw.evaluate(() => {
    const g = globalThis as unknown as {
      __deskcheckVisibilityReports?: VisibilityReport[];
    };
    return [...(g.__deskcheckVisibilityReports ?? [])];
  })) as VisibilityReport[];
}

async function openSidePanelOn(
  context: import("@playwright/test").BrowserContext,
  extensionId: string,
  tabId: number,
): Promise<void> {
  // Load an extension-privileged page so we can synthesize a user
  // gesture via CDP Runtime.evaluate (userGesture:true).
  const extPage = await context.newPage();
  await extPage.goto(
    `chrome-extension://${extensionId}/src/sidepanel/index.html`,
  );
  const cdp = await context.newCDPSession(extPage);
  const r = await cdp.send("Runtime.evaluate", {
    expression: `chrome.sidePanel.open({ tabId: ${tabId} }).then(() => "ok", (e) => "err: " + e.message)`,
    awaitPromise: true,
    userGesture: true,
    returnByValue: true,
  });
  expect(
    (r as { result?: { value?: string } }).result?.value,
  ).toBe("ok");
  await extPage.close();
}

test.describe("side panel bind-on-open verification", () => {
  test("manifest: no side_panel.default_path", async ({ serviceWorker }) => {
    const manifest = await serviceWorker.evaluate(() =>
      chrome.runtime.getManifest(),
    );
    // Per issue #987, having default_path causes Chrome to create a
    // global panel that ignores per-tab setOptions.
    expect(
      (manifest as unknown as { side_panel?: unknown }).side_panel,
    ).toBeUndefined();
  });

  test("setPanelBehavior is openPanelOnActionClick:false (we handle clicks)", async ({
    serviceWorker,
  }) => {
    const behavior = await serviceWorker.evaluate(() =>
      chrome.sidePanel.getPanelBehavior(),
    );
    expect(behavior).toEqual({ openPanelOnActionClick: false });
  });

  test("panel actually hides on tab switch and restores on return", async ({
    context,
    extensionId,
    serviceWorker,
  }) => {
    const tabA = await context.newPage();
    await tabA.goto("https://example.com", { waitUntil: "domcontentloaded" });
    await tabA.bringToFront();
    const tabB = await context.newPage();
    await tabB.goto("https://www.iana.org/", {
      waitUntil: "domcontentloaded",
    });
    await tabA.bringToFront();

    const { a, b } = await serviceWorker.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      return {
        a: tabs.find((t) => t.url?.includes("example.com"))?.id ?? null,
        b: tabs.find((t) => t.url?.includes("iana.org"))?.id ?? null,
      };
    });
    if (!a || !b) throw new Error("missing tab ids");

    await clearReports(serviceWorker);

    // Mimic what the SW does on action click: set per-tab, open,
    // then disable other tabs.
    await serviceWorker.evaluate(
      async ([aid, bid]: [number, number]) => {
        await chrome.sidePanel.setOptions({
          tabId: aid,
          path: "src/sidepanel/index.html",
          enabled: true,
        });
        await chrome.sidePanel.setOptions({ tabId: bid, enabled: false });
      },
      [a, b] as [number, number],
    );

    await openSidePanelOn(context, extensionId, a);
    await tabA.bringToFront();
    await tabA.waitForTimeout(1500); // let the panel mount

    // Switch to B — the panel should become hidden.
    await serviceWorker.evaluate(async (bid) => {
      await chrome.tabs.update(bid, { active: true });
    }, b);
    await tabB.waitForTimeout(1500);

    // Switch back to A — the panel should become visible again.
    await serviceWorker.evaluate(async (aid) => {
      await chrome.tabs.update(aid, { active: true });
    }, a);
    await tabA.waitForTimeout(1500);

    const reports = await readReports(serviceWorker);
    const sequence = reports.map((r) => r.visibilityState);

    // We expect the final two visibility transitions to be:
    // "visible" (panel on A) → "hidden" (switched to B) → "visible"
    // (switched back to A). There can be extra mount-time entries
    // before those from multiple side panel initializations, so we
    // check the tail of the sequence.
    expect(sequence.length).toBeGreaterThanOrEqual(3);
    expect(sequence).toContain("hidden");
    expect(sequence[sequence.length - 1]).toBe("visible");

    // More specifically: find the last "visible" (after switch back)
    // and assert there's a preceding "hidden" (from the switch to B).
    const lastVisibleIdx = sequence.lastIndexOf("visible");
    expect(lastVisibleIdx).toBeGreaterThan(0);
    expect(sequence.slice(0, lastVisibleIdx)).toContain("hidden");

    await tabA.close();
    await tabB.close();
  });
});
