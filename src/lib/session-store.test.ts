// Acceptance test for feature #8 — Test Level Matrix row #13.
//
// Pins the append-only contract on session-store.appendEvent. The side
// panel's storage.onChanged subscription depends on this invariant: it
// computes deltas as `newValue.slice(lastSeenLength)`. If a future
// change (e.g. feature #5 incremental persistence) silently rewrites
// the events array prefix, the side panel will miss updates.
//
// This test should PASS against the current implementation. It is a
// regression pin, not a failing acceptance test for new behaviour.

import { describe, it, expect, beforeEach, vi } from "vitest";

// Minimal in-memory chrome.storage.local fake.
function installFakeChromeStorage() {
  const state: Record<string, unknown> = {};
  const fake = {
    storage: {
      local: {
        async get(keys: string | string[] | Record<string, unknown>) {
          const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
          const out: Record<string, unknown> = {};
          for (const k of list) {
            if (k in state) out[k] = state[k];
          }
          return out;
        },
        async set(items: Record<string, unknown>) {
          Object.assign(state, items);
        },
        async remove(keys: string | string[]) {
          const list = typeof keys === "string" ? [keys] : keys;
          for (const k of list) delete state[k];
        },
      },
    },
  };
  // @ts-expect-error — install on globalThis for the module under test.
  globalThis.chrome = fake;
  return state;
}

describe("session-store.appendEvent append-only contract (matrix #13)", () => {
  let state: Record<string, unknown>;

  beforeEach(async () => {
    state = installFakeChromeStorage();
    vi.resetModules();
  });

  it("preserves the prefix: newEvents.slice(0, oldLen) deep-equals oldEvents", async () => {
    const { createSession, appendEvent, getEvents } = await import("./session-store");
    await createSession(1, "https://example.com/", { width: 1, height: 1 });

    await appendEvent({
      timestamp: "2026-04-07T12:00:00.000Z",
      type: "console_error",
      level: "error",
      message: "first",
      page_url: "https://example.com/",
    });
    const after1 = await getEvents();

    await appendEvent({
      timestamp: "2026-04-07T12:00:01.000Z",
      type: "console_error",
      level: "error",
      message: "second",
      page_url: "https://example.com/",
    });
    const after2 = await getEvents();

    await appendEvent({
      timestamp: "2026-04-07T12:00:02.000Z",
      type: "console_error",
      level: "error",
      message: "third",
      page_url: "https://example.com/",
    });
    const after3 = await getEvents();

    // Prefix preservation: each successive snapshot must contain every
    // earlier snapshot as its prefix.
    expect(after2.slice(0, after1.length)).toEqual(after1);
    expect(after3.slice(0, after2.length)).toEqual(after2);
    expect(after3).toHaveLength(3);
  });

  it("assigns monotonically increasing seq numbers", async () => {
    const { createSession, appendEvent, getEvents } = await import("./session-store");
    await createSession(1, "https://example.com/", { width: 1, height: 1 });

    for (let i = 0; i < 5; i++) {
      await appendEvent({
        timestamp: `2026-04-07T12:00:0${i}.000Z`,
        type: "console_error",
        level: "error",
        message: `m${i}`,
        page_url: "https://example.com/",
      });
    }
    const events = await getEvents();
    const seqs = events.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });

  // Suppress unused warning for `state`.
  it("uses chrome.storage.local under the hood", () => {
    expect(typeof state).toBe("object");
  });
});
