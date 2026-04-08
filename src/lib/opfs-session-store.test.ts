import { describe, it, expect } from "vitest";
import { OpfsSessionStore } from "./opfs-session-store";
import {
  createFakeOpfsRoot,
  createFakeChromeStorage,
} from "./__fixtures__/fake-opfs";
import type { TimelineEventInput } from "../types";
import { STORAGE_SESSION } from "../constants";

// OPFS-specific tests that are not expressible against the in-memory
// FakeSessionStore: recovery from a simulated SW wake, tolerance of a
// partially-written JSONL file, isolation of chrome.storage.local from
// event/screenshot data. Shared contract behaviour lives in
// session-store.test.ts. See docs/plans/feature-5/selected-plan.md.

function click(seqLabel: string): TimelineEventInput {
  return {
    timestamp: "2026-04-07T12:00:00.000Z",
    type: "interaction",
    subtype: "click",
    element: { tag: "button", selector: `#${seqLabel}` },
    coordinates: { x: 0, y: 0 },
    page_url: "https://example.com",
  };
}

function freshStore() {
  const opfs = createFakeOpfsRoot();
  const storage = createFakeChromeStorage();
  const store = new OpfsSessionStore({
    getRoot: opfs.get,
    storage: storage.facade,
  });
  return { store, opfs, storage };
}

describe("OpfsSessionStore.ensureReady — recovery after simulated SW wake", () => {
  it("re-opens the same OPFS directory on ensureReady and preserves seq", async () => {
    const opfs = createFakeOpfsRoot();
    const storage = createFakeChromeStorage();

    // First "instance" of the worker: create a session, append 5 events.
    const first = new OpfsSessionStore({
      getRoot: opfs.get,
      storage: storage.facade,
    });
    await first.createSession({
      id: "sess-recovery",
      tab_id: 1,
      start_time: "2026-04-07T12:00:00.000Z",
      end_time: null,
      duration_ms: null,
      initial_url: "https://example.com",
      user_agent: "TestAgent",
      viewport: { width: 1024, height: 768 },
      pii_mode: "full",
      status: "running",
    });
    for (let i = 0; i < 5; i++) await first.appendEvent(click(String(i)));
    expect(await first.countEvents()).toBe(5);

    // Simulate service-worker death: discard the `first` instance. The
    // OPFS root + chrome.storage state survive (they are the real SW
    // persistent resources in production). Instantiate a fresh store
    // pointing at the same fakes.
    const second = new OpfsSessionStore({
      getRoot: opfs.get,
      storage: storage.facade,
    });

    const recovered = await second.ensureReady();
    expect(recovered?.id).toBe("sess-recovery");

    // Next append should continue the same file with seq = 6.
    const next = await second.appendEvent(click("6"));
    expect(next.seq).toBe(6);

    // All 6 events readable in order.
    const arr = await second.readEventsArray();
    expect(arr.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("ensureReady returns null when no session is in chrome.storage.local", async () => {
    const { store } = freshStore();
    const out = await store.ensureReady();
    expect(out).toBeNull();
  });
});

describe("OpfsSessionStore — chrome.storage.local is metadata-only", () => {
  it("never writes events or screenshots to chrome.storage.local", async () => {
    const { store, storage } = freshStore();
    await store.createSession({
      id: "sess-storage",
      tab_id: 1,
      start_time: "2026-04-07T12:00:00.000Z",
      end_time: null,
      duration_ms: null,
      initial_url: "https://example.com",
      user_agent: "TestAgent",
      viewport: { width: 1024, height: 768 },
      pii_mode: "full",
      status: "running",
    });

    for (let i = 0; i < 3; i++) await store.appendEvent(click(String(i)));
    await store.appendScreenshot("ss_1", new Uint8Array([1, 2, 3]));
    await store.appendScreenshot("ss_2", new Uint8Array([4, 5, 6]));

    // Only the metadata key should be present.
    const keys = Array.from(storage.state.keys());
    expect(keys).toContain(STORAGE_SESSION);

    // Defensive: no key should contain "events" or "screenshots".
    for (const k of keys) {
      expect(k.toLowerCase()).not.toContain("event");
      expect(k.toLowerCase()).not.toContain("screenshot");
    }

    // The metadata value should be the SessionMetadata shape, not a
    // bag that accidentally embeds events or screenshot data.
    const meta = storage.state.get(STORAGE_SESSION) as Record<string, unknown>;
    expect(meta).toBeDefined();
    expect(meta).not.toHaveProperty("events");
    expect(meta).not.toHaveProperty("screenshots");
    expect(meta).toHaveProperty("id", "sess-storage");
    expect(meta).toHaveProperty("pii_mode", "full");
  });
});

describe("OpfsSessionStore — partial trailing line tolerance", () => {
  it("skips a crash-truncated last line on read without throwing", async () => {
    const opfs = createFakeOpfsRoot();
    const storage = createFakeChromeStorage();
    const store = new OpfsSessionStore({
      getRoot: opfs.get,
      storage: storage.facade,
    });

    await store.createSession({
      id: "sess-partial",
      tab_id: 1,
      start_time: "2026-04-07T12:00:00.000Z",
      end_time: null,
      duration_ms: null,
      initial_url: "https://example.com",
      user_agent: "TestAgent",
      viewport: { width: 1024, height: 768 },
      pii_mode: "full",
      status: "running",
    });
    await store.appendEvent(click("a"));
    await store.appendEvent(click("b"));

    // Locate the events file in the fake OPFS tree and corrupt its
    // trailing bytes to simulate a crash mid-write. The exact path is
    // implementation-defined (Phase 4 will pin it in selected-plan.md);
    // here we walk the tree to find `events.jsonl`.
    const file = await findEventsFile(opfs.root);
    expect(file).not.toBeNull();
    const partial = new TextEncoder().encode('{"partial":');
    const corrupted = new Uint8Array(file!.bytes.length + partial.length);
    corrupted.set(file!.bytes);
    corrupted.set(partial, file!.bytes.length);
    file!.bytes = corrupted;

    // Read must not throw and must return the two well-formed events.
    const arr = await store.readEventsArray();
    expect(arr.length).toBe(2);
    expect(arr[0].seq).toBe(1);
    expect(arr[1].seq).toBe(2);
  });
});

// ── helpers ─────────────────────────────────────────────────────────────

type FakeDir = Awaited<ReturnType<typeof createFakeOpfsRoot>>["root"];
type FakeEntry =
  | { kind: "file"; name: string; bytes: Uint8Array }
  | FakeDir;

async function findEventsFile(
  dir: FakeDir,
): Promise<{ bytes: Uint8Array } | null> {
  for await (const entry of (dir as unknown as {
    values: () => AsyncIterableIterator<FakeEntry>;
  }).values()) {
    if ((entry as { kind: string }).kind === "file") {
      if ((entry as { name: string }).name === "events.jsonl") {
        return entry as unknown as { bytes: Uint8Array };
      }
    } else {
      const sub = await findEventsFile(entry as FakeDir);
      if (sub) return sub;
    }
  }
  return null;
}
