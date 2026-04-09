/**
 * Playwright script that captures screenshots and a video of the DeskCheck
 * desktop demo — showing both the web app being tested and the side panel.
 *
 * Run with:
 *   npx playwright test demo/capture-demo.ts --config demo/playwright-demo.config.ts
 *
 * Outputs:
 *   demo/assets/sidepanel-screenshot.png  — active session with events (side panel only)
 *   demo/assets/sidepanel-idle.png        — idle state (side panel only)
 *   demo/assets/desktop-screenshot.png    — full desktop view
 *   demo/assets/demo-video.webm           — full demo walkthrough video (from Playwright)
 *   demo/assets/demo.gif                  — convert with ffmpeg afterwards
 */

import { test } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_HTML = path.resolve(__dirname, "desktop-demo.html");
const PANEL_HTML = path.resolve(__dirname, "sidepanel-demo.html");
const ASSETS_DIR = path.resolve(__dirname, "assets");

const STEP_DELAY = 700;
const EVENT_DELAY = 450;
const TYPING_DELAY = 35;

test("capture DeskCheck desktop demo", async ({ page }) => {
  // Full desktop-like viewport
  await page.setViewportSize({ width: 1280, height: 720 });

  await page.goto(`file://${DESKTOP_HTML}`);
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(500);

  // ── Scene 1: idle state — hold for 1.5s ──────────────────────
  await page.waitForTimeout(1500);

  // ── Scene 2: start session ────────────────────────────────────
  await page.evaluate(() => (window as any).demoAPI.startSession());
  await page.waitForTimeout(STEP_DELAY);

  // ── Scene 3: user clicks Submit on the web app ────────────────
  // Simulate a click ripple on the Submit button
  const submitBtn = page.locator("#submit-order-btn");
  const box = await submitBtn.boundingBox();
  if (box) {
    await page.evaluate(
      ([x, y]: [number, number]) => (window as any).demoAPI.clickRipple(x, y),
      [box.x + box.width / 2, box.y + box.height / 2] as [number, number],
    );
  }
  await page.waitForTimeout(300);

  // First events: Navigate + Click
  await page.evaluate(() => (window as any).demoAPI.addNextEvent());
  await page.waitForTimeout(EVENT_DELAY);
  await page.evaluate(() => (window as any).demoAPI.addNextEvent());
  await page.waitForTimeout(EVENT_DELAY);

  // ── Scene 4: errors appear ────────────────────────────────────
  // Network error + Console error
  await page.evaluate(() => (window as any).demoAPI.addNextEvent());
  await page.waitForTimeout(200);
  await page.evaluate(() => (window as any).demoAPI.addNextEvent());
  // Show error toast on the web app
  await page.evaluate(() => (window as any).demoAPI.showErrorToast());
  await page.waitForTimeout(STEP_DELAY);

  // Click retry
  await page.evaluate(() => (window as any).demoAPI.addNextEvent());
  await page.waitForTimeout(EVENT_DELAY);

  // Second network error
  await page.evaluate(() => (window as any).demoAPI.addNextEvent());
  await page.waitForTimeout(EVENT_DELAY);

  // Console warning
  await page.evaluate(() => (window as any).demoAPI.addNextEvent());
  await page.waitForTimeout(STEP_DELAY);

  // Hide toast
  await page.evaluate(() => (window as any).demoAPI.hideErrorToast());
  await page.waitForTimeout(300);

  // ── Scene 5: screenshot event ─────────────────────────────────
  await page.evaluate(() => (window as any).demoAPI.addNextEvent());
  await page.waitForTimeout(STEP_DELAY);

  // ── Take the desktop screenshot here (good state: events + web app visible)
  await page.screenshot({
    path: path.join(ASSETS_DIR, "desktop-screenshot.png"),
    fullPage: false,
  });

  // ── Scene 6: annotation event ─────────────────────────────────
  await page.evaluate(() => (window as any).demoAPI.addNextEvent());
  await page.waitForTimeout(STEP_DELAY);

  // ── Scene 7: navigate to Settings ─────────────────────────────
  // Click on Settings link (with ripple)
  const settingsLink = page.locator("#settings-link");
  const sBox = await settingsLink.boundingBox();
  if (sBox) {
    await page.evaluate(
      ([x, y]: [number, number]) => (window as any).demoAPI.clickRipple(x, y),
      [sBox.x + sBox.width / 2, sBox.y + sBox.height / 2] as [number, number],
    );
  }
  await page.waitForTimeout(300);

  // Navigate event + Click events
  await page.evaluate(() => (window as any).demoAPI.addNextEvent());
  await page.waitForTimeout(EVENT_DELAY);
  await page.evaluate(() => (window as any).demoAPI.addNextEvent());
  await page.evaluate(() => (window as any).demoAPI.navigateToSettings());
  await page.waitForTimeout(EVENT_DELAY);

  // Remaining events
  let hasMore = true;
  while (hasMore) {
    hasMore = await page.evaluate(() => (window as any).demoAPI.addNextEvent());
    if (hasMore) await page.waitForTimeout(EVENT_DELAY);
  }
  await page.waitForTimeout(STEP_DELAY);

  // ── Scene 8: type an annotation ───────────────────────────────
  const textarea = page.locator("#sp-annotation-text");
  await textarea.click();
  await textarea.type(
    "Order form 500s after 3+ items. Regression from last deploy.",
    { delay: TYPING_DELAY },
  );
  await page.waitForTimeout(STEP_DELAY);

  // Click Add note
  await page.locator("#sp-add-note-btn").click();
  await page.waitForTimeout(STEP_DELAY);

  // ── Scene 9: export reminder ──────────────────────────────────
  await page.evaluate(() => (window as any).demoAPI.showExportReminder());
  await page.waitForTimeout(STEP_DELAY * 2);

  // Final screenshot
  await page.screenshot({
    path: path.join(ASSETS_DIR, "desktop-export.png"),
    fullPage: false,
  });

  // Hold the final frame
  await page.waitForTimeout(2000);
});

test("capture side-panel-only screenshots", async ({ page }) => {
  // Narrow viewport for side-panel-only shots
  await page.setViewportSize({ width: 360, height: 640 });

  await page.goto(`file://${PANEL_HTML}`);
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(300);

  // Idle
  await page.screenshot({
    path: path.join(ASSETS_DIR, "sidepanel-idle.png"),
    fullPage: false,
  });

  // Start + add 9 events
  await page.evaluate(() => (window as any).demoAPI.startSession());
  await page.waitForTimeout(400);
  for (let i = 0; i < 9; i++) {
    await page.evaluate(() => (window as any).demoAPI.addNextEvent());
    await page.waitForTimeout(200);
  }
  await page.waitForTimeout(300);

  // Active
  await page.screenshot({
    path: path.join(ASSETS_DIR, "sidepanel-screenshot.png"),
    fullPage: false,
  });
});
