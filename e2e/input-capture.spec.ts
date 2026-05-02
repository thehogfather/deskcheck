import { test, expect } from "./fixtures";
import type { BrowserContext, Worker } from "@playwright/test";

// E2E coverage for the input capture path. Closes a real coverage gap
// surfaced by a session zip dogfood test where zero `interaction.input`
// events were captured across a 160-second recording. Now anchors:
//
//   1. "full" mode: captures the typed value (with passwords masked).
//   2. "metadata" mode: captures structural metadata only — no raw value.
//   3. "none" mode: never registers an input listener at all.
//
// All three flows go through the real service worker + content script
// + OPFS event store. We assert against `GET_EVENTS_SNAPSHOT` rather
// than re-zipping the export so the test exercises the same read path
// the side panel uses.

const TEST_PAGE = "https://example.com/";
const SIDE_PANEL_PATH = "src/sidepanel/index.html";
const INPUT_DEBOUNCE_MS = 800;
const DEBOUNCE_BUFFER_MS = 400;

interface InputEvent {
  seq: number;
  type: "interaction";
  subtype: "input";
  element: { tag: string; class?: unknown; selector?: string };
  value?: string;
  value_metadata?: {
    length: number;
    word_count: number;
    letter_count: number;
    digit_count: number;
    emoji_count: number;
    whitespace_count: number;
    special_count: number;
  };
  page_url: string;
}

interface AnyEvent {
  seq: number;
  type: string;
  subtype?: string;
}

async function openSidePanelPage(context: BrowserContext, extensionId: string) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${SIDE_PANEL_PATH}`);
  return page;
}

async function startSessionWithMode(
  context: BrowserContext,
  extensionId: string,
  tabUrl: string,
  piiMode: "full" | "metadata" | "none",
) {
  const sw = context.serviceWorkers()[0];
  const tabId = await sw.evaluate(async (url: string) => {
    const [tab] = await chrome.tabs.query({ url });
    return tab?.id ?? null;
  }, tabUrl);
  if (!tabId) throw new Error(`No tab found for ${tabUrl}`);

  const helper = await openSidePanelPage(context, extensionId);
  const result = await helper.evaluate(
    async ([tid, url, mode]: [number, string, string]) => {
      return chrome.runtime.sendMessage({
        type: "START_SESSION",
        tabId: tid,
        url,
        viewport: { width: 1280, height: 720 },
        piiMode: mode,
      });
    },
    [tabId, tabUrl, piiMode] as [number, string, string],
  );
  await helper.close();
  return { sessionId: result.sessionId as string, tabId };
}

async function stopSession(context: BrowserContext, extensionId: string) {
  const helper = await openSidePanelPage(context, extensionId);
  await helper.evaluate(async () => {
    return chrome.runtime.sendMessage({ type: "STOP_SESSION" });
  });
  await helper.close();
}

async function readEvents(
  context: BrowserContext,
  extensionId: string,
): Promise<AnyEvent[]> {
  const helper = await openSidePanelPage(context, extensionId);
  try {
    const result = (await helper.evaluate(async () => {
      return chrome.runtime.sendMessage({ type: "GET_EVENTS_SNAPSHOT" });
    })) as { events: AnyEvent[]; screenshots: Record<string, string> };
    return result?.events ?? [];
  } finally {
    await helper.close();
  }
}

/**
 * Inject an input element into the test page so the recorder has a
 * real form control to listen on. Uses a stable id so we can target
 * it from Playwright and so the captured `element.selector` field is
 * predictable across runs.
 */
async function injectInputField(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    const existing = document.getElementById("dc-test-input");
    if (existing) existing.remove();
    const input = document.createElement("input");
    input.id = "dc-test-input";
    input.type = "text";
    input.style.position = "fixed";
    input.style.top = "10px";
    input.style.left = "10px";
    input.style.zIndex = "999999";
    document.body.appendChild(input);
  });
}

test.describe("Input event capture (feature #4 + bug fix)", () => {
  test("full mode captures the typed value", async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await page.goto(TEST_PAGE, { waitUntil: "domcontentloaded" });
    await page.bringToFront();
    await injectInputField(page);

    await startSessionWithMode(context, extensionId, TEST_PAGE, "full");
    // Give the content script a moment to attach its listeners after
    // the SESSION_STARTED message lands.
    await page.waitForTimeout(150);

    const target = page.locator("#dc-test-input");
    await target.click();
    await target.fill("hello world");
    // Wait past the input debounce so the recorder emits the event.
    await page.waitForTimeout(INPUT_DEBOUNCE_MS + DEBOUNCE_BUFFER_MS);

    const events = await readEvents(context, extensionId);
    const inputEvents = events.filter(
      (e): e is InputEvent =>
        e.type === "interaction" && e.subtype === "input",
    );

    expect(
      inputEvents.length,
      "full mode must emit at least one input event for a typed-into <input>",
    ).toBeGreaterThan(0);
    const last = inputEvents.at(-1)!;
    expect(last.element.tag).toBe("input");
    expect(last.value, "full mode must capture the typed value").toBe(
      "hello world",
    );
    // Full mode does not emit value_metadata — that field is metadata-mode-only.
    expect(last.value_metadata).toBeUndefined();

    await stopSession(context, extensionId);
  });

  test("metadata mode captures structural metadata but never the raw value", async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await page.goto(TEST_PAGE, { waitUntil: "domcontentloaded" });
    await page.bringToFront();
    await injectInputField(page);

    await startSessionWithMode(context, extensionId, TEST_PAGE, "metadata");
    await page.waitForTimeout(150);

    const target = page.locator("#dc-test-input");
    await target.click();
    // Mix of letters, digits, and a special char so we can assert the
    // metadata classification really fired.
    await target.fill("abc 123!");
    await page.waitForTimeout(INPUT_DEBOUNCE_MS + DEBOUNCE_BUFFER_MS);

    const events = await readEvents(context, extensionId);
    const inputEvents = events.filter(
      (e): e is InputEvent =>
        e.type === "interaction" && e.subtype === "input",
    );

    expect(
      inputEvents.length,
      "metadata mode must still emit input events (just without the value)",
    ).toBeGreaterThan(0);
    const last = inputEvents.at(-1)!;
    expect(last.value, "metadata mode must NOT include the raw value").toBeUndefined();
    expect(last.value_metadata).toBeDefined();
    expect(last.value_metadata!.length).toBe("abc 123!".length);
    expect(last.value_metadata!.word_count).toBe(2);
    expect(last.value_metadata!.digit_count).toBe(3);
    expect(last.value_metadata!.special_count).toBeGreaterThan(0);
    expect(last.value_metadata!.letter_count).toBe(3);

    await stopSession(context, extensionId);
  });

  test("none mode emits no input events at all", async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await page.goto(TEST_PAGE, { waitUntil: "domcontentloaded" });
    await page.bringToFront();
    await injectInputField(page);

    await startSessionWithMode(context, extensionId, TEST_PAGE, "none");
    await page.waitForTimeout(150);

    const target = page.locator("#dc-test-input");
    await target.click();
    await target.fill("should not be recorded");
    await page.waitForTimeout(INPUT_DEBOUNCE_MS + DEBOUNCE_BUFFER_MS);

    const events = await readEvents(context, extensionId);
    const inputEvents = events.filter(
      (e) => e.type === "interaction" && e.subtype === "input",
    );

    expect(
      inputEvents.length,
      "none mode must NOT register the input listener — zero input events",
    ).toBe(0);
    // Sanity: the click that focused the input still got captured, so
    // we know the recorder is alive — it is just gating input events.
    const clickEvents = events.filter(
      (e) => e.type === "interaction" && e.subtype === "click",
    );
    expect(
      clickEvents.length,
      "click events should still be captured even when input mode is none",
    ).toBeGreaterThan(0);

    await stopSession(context, extensionId);
  });
});
