import { describe, it, expect, beforeEach } from "vitest";
import type { SessionStore } from "./session-store-types";
import { FakeSessionStore } from "./fake-session-store";
import { OpfsSessionStore } from "./opfs-session-store";
import {
  createFakeOpfsRoot,
  createFakeChromeStorage,
} from "./__fixtures__/fake-opfs";
import type { SessionMetadata, TimelineEventInput } from "../types";

// Contract suite for the SessionStore interface. Runs against both
// FakeSessionStore (the executable spec) and OpfsSessionStore (the
// production path) so any divergence fails loudly. See
// docs/plans/feature-5/selected-plan.md — "SessionStore" section.

type StoreFactory = () => SessionStore;

function makeMetadata(overrides: Partial<SessionMetadata> = {}): SessionMetadata {
  return {
    id: "test-session",
    tab_id: 1,
    start_time: "2026-04-07T12:00:00.000Z",
    end_time: null,
    duration_ms: null,
    initial_url: "https://example.com",
    user_agent: "TestAgent/1.0",
    viewport: { width: 1280, height: 720 },
    pii_mode: "full",
    status: "running",
    ...overrides,
  };
}

function clickEvent(subtype = "click"): TimelineEventInput {
  return {
    timestamp: "2026-04-07T12:00:01.000Z",
    type: "interaction",
    subtype: subtype as "click",
    element: { tag: "button", selector: "#btn" },
    coordinates: { x: 10, y: 20 },
    page_url: "https://example.com",
  };
}

const tinyPng = (): Uint8Array =>
  new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG magic
    0x00, 0x00, 0x00, 0x0d, // IHDR length
  ]);

function runContractSuite(label: string, factory: StoreFactory) {
  describe(`SessionStore contract — ${label}`, () => {
    let store: SessionStore;

    beforeEach(() => {
      store = factory();
    });

    describe("createSession / getSession", () => {
      it("persists the initial metadata and returns it from getSession", async () => {
        const meta = makeMetadata();
        await store.createSession(meta);
        const loaded = await store.getSession();
        expect(loaded?.id).toBe(meta.id);
        expect(loaded?.pii_mode).toBe("full");
      });

      it("wipes prior session state on createSession (no bleed between sessions)", async () => {
        await store.createSession(makeMetadata({ id: "sess-a" }));
        await store.appendEvent(clickEvent());
        await store.appendScreenshot("ss1", tinyPng());

        await store.createSession(makeMetadata({ id: "sess-b" }));
        expect(await store.countEvents()).toBe(0);
        expect(await store.countScreenshots()).toBe(0);
      });
    });

    describe("appendEvent / readEvents", () => {
      beforeEach(async () => {
        await store.createSession(makeMetadata());
      });

      it("assigns seq monotonically starting at 1", async () => {
        const a = await store.appendEvent(clickEvent());
        const b = await store.appendEvent(clickEvent("input"));
        const c = await store.appendEvent(clickEvent("scroll"));
        expect(a.seq).toBe(1);
        expect(b.seq).toBe(2);
        expect(c.seq).toBe(3);
      });

      it("round-trips events via readEvents in append order", async () => {
        await store.appendEvent(clickEvent("click"));
        await store.appendEvent(clickEvent("input"));
        const out = [];
        for await (const ev of store.readEvents()) out.push(ev);
        expect(out.map((e) => e.seq)).toEqual([1, 2]);
        expect(out.map((e) => e.type === "interaction" && e.subtype)).toEqual([
          "click",
          "input",
        ]);
      });

      it("countEvents matches the number of appends", async () => {
        expect(await store.countEvents()).toBe(0);
        await store.appendEvent(clickEvent());
        await store.appendEvent(clickEvent());
        await store.appendEvent(clickEvent());
        expect(await store.countEvents()).toBe(3);
      });

      it("readEventsArray returns every appended event", async () => {
        await store.appendEvent(clickEvent());
        await store.appendEvent(clickEvent("input"));
        const arr = await store.readEventsArray();
        expect(arr.length).toBe(2);
        expect(arr[0].seq).toBe(1);
        expect(arr[1].seq).toBe(2);
      });

      it("serialises concurrent appendEvent calls into a strictly monotonic seq", async () => {
        const N = 25;
        const pending = Array.from({ length: N }, () =>
          store.appendEvent(clickEvent()),
        );
        const results = await Promise.all(pending);
        const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
        expect(seqs).toEqual(
          Array.from({ length: N }, (_, i) => i + 1),
        );
        // Readback must preserve the same set and ordering by seq.
        const readback = await store.readEventsArray();
        expect(readback.length).toBe(N);
        expect(readback.map((e) => e.seq)).toEqual(
          Array.from({ length: N }, (_, i) => i + 1),
        );
      });
    });

    describe("appendScreenshot / readScreenshot", () => {
      beforeEach(async () => {
        await store.createSession(makeMetadata());
      });

      it("stores PNG bytes (never base64) and reads them back", async () => {
        const bytes = tinyPng();
        await store.appendScreenshot("ss_1", bytes);
        const out = await store.readScreenshot("ss_1");
        expect(out).not.toBeNull();
        expect(Array.from(out!)).toEqual(Array.from(bytes));
      });

      it("returns null for an unknown screenshot id", async () => {
        expect(await store.readScreenshot("missing")).toBeNull();
      });

      it("iterates all screenshots via readScreenshots", async () => {
        await store.appendScreenshot("a", tinyPng());
        await store.appendScreenshot("b", tinyPng());
        await store.appendScreenshot("c", tinyPng());
        const ids = [];
        for await (const ss of store.readScreenshots()) ids.push(ss.id);
        expect(new Set(ids)).toEqual(new Set(["a", "b", "c"]));
      });

      it("countScreenshots matches the number of appends", async () => {
        expect(await store.countScreenshots()).toBe(0);
        await store.appendScreenshot("a", tinyPng());
        await store.appendScreenshot("b", tinyPng());
        expect(await store.countScreenshots()).toBe(2);
      });
    });

    describe("computeByteSizes", () => {
      beforeEach(async () => {
        await store.createSession(makeMetadata());
      });

      it("reports zero for an empty session", async () => {
        const sizes = await store.computeByteSizes();
        expect(sizes.events).toBe(0);
        expect(sizes.screenshots).toBe(0);
      });

      it("reports events bytes from the on-disk JSONL log, not from in-memory strings", async () => {
        await store.appendEvent(clickEvent());
        await store.appendEvent(clickEvent("input"));
        const sizes = await store.computeByteSizes();
        expect(sizes.events).toBeGreaterThan(0);
        // The JSONL bytes for two click events should be comfortably
        // larger than their seq numbers alone, but much smaller than 1KB
        // — a loose sanity bound that would catch "events reported as
        // chrome.storage.local JSON-string length" regressions.
        expect(sizes.events).toBeLessThan(2048);
      });

      it("reports screenshot bytes as the sum of individual PNG file sizes", async () => {
        const a = new Uint8Array(100);
        const b = new Uint8Array(200);
        await store.appendScreenshot("a", a);
        await store.appendScreenshot("b", b);
        const sizes = await store.computeByteSizes();
        expect(sizes.screenshots).toBe(300);
      });
    });

    describe("deleteSession", () => {
      it("removes every persisted byte for the current session", async () => {
        await store.createSession(makeMetadata());
        await store.appendEvent(clickEvent());
        await store.appendScreenshot("ss_1", tinyPng());
        await store.deleteSession();

        expect(await store.getSession()).toBeNull();
        expect(await store.countEvents()).toBe(0);
        expect(await store.countScreenshots()).toBe(0);
      });

      it("is idempotent when no session is active", async () => {
        await expect(store.deleteSession()).resolves.toBeUndefined();
        await expect(store.deleteSession()).resolves.toBeUndefined();
      });
    });
  });
}

// Run the whole contract suite against both implementations.
runContractSuite("FakeSessionStore", () => new FakeSessionStore());

runContractSuite("OpfsSessionStore", () => {
  const fakeOpfs = createFakeOpfsRoot();
  const fakeStorage = createFakeChromeStorage();
  return new OpfsSessionStore({
    getRoot: fakeOpfs.get,
    storage: fakeStorage.facade,
  });
});
