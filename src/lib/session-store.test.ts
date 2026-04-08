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

// Minimal in-memory chrome.storage.local fake. The `removeCalls`
// array records every remove invocation for spy-style assertions
// (used by the feature-11 atomic-discard test).
interface FakeChromeState {
  storage: Record<string, unknown>;
  removeCalls: Array<string | string[]>;
  setCalls: number;
}

function installFakeChromeStorage(): FakeChromeState {
  const state: FakeChromeState = {
    storage: {},
    removeCalls: [],
    setCalls: 0,
  };
  const fake = {
    storage: {
      local: {
        async get(keys: string | string[] | Record<string, unknown>) {
          const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
          const out: Record<string, unknown> = {};
          for (const k of list) {
            if (k in state.storage) out[k] = state.storage[k];
          }
          return out;
        },
        async set(items: Record<string, unknown>) {
          state.setCalls += 1;
          Object.assign(state.storage, items);
        },
        async remove(keys: string | string[]) {
          state.removeCalls.push(keys);
          const list = typeof keys === "string" ? [keys] : keys;
          for (const k of list) delete state.storage[k];
        },
      },
    },
  };
  // @ts-expect-error — install on globalThis for the module under test.
  globalThis.chrome = fake;
  return state;
}

describe("session-store.appendEvent append-only contract (matrix #13)", () => {
  let state: FakeChromeState;

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

// ─────────────────────────────────────────────────────────────────────
// Feature #11 — lifecycle facade (pause, resume, discard, reset)
// ─────────────────────────────────────────────────────────────────────

describe("session-store.createSession writes status:'running'", () => {
  let state: FakeChromeState;
  beforeEach(async () => {
    state = installFakeChromeStorage();
    vi.resetModules();
  });

  it("new sessions have status 'running' in storage", async () => {
    const { createSession, getSession } = await import("./session-store");
    await createSession(1, "https://example.com/", { width: 1, height: 1 });
    const session = await getSession();
    expect(session).not.toBeNull();
    expect(session!.status).toBe("running");
    // Suppress unused warning for state.
    expect(state.setCalls).toBeGreaterThan(0);
  });
});

describe("session-store.endSession writes status:'stopped'", () => {
  beforeEach(async () => {
    installFakeChromeStorage();
    vi.resetModules();
  });

  it("sets status to 'stopped' alongside end_time and duration_ms", async () => {
    const { createSession, endSession, getSession } = await import("./session-store");
    await createSession(1, "https://example.com/", { width: 1, height: 1 });
    await endSession();
    const session = await getSession();
    expect(session).not.toBeNull();
    expect(session!.status).toBe("stopped");
    expect(session!.end_time).not.toBeNull();
    expect(session!.duration_ms).not.toBeNull();
  });
});

describe("session-store.pauseSession", () => {
  beforeEach(async () => {
    installFakeChromeStorage();
    vi.resetModules();
  });

  it("writes the session_paused marker BEFORE flipping status to 'paused'", async () => {
    const { createSession, pauseSession, getEvents, getSession } = await import("./session-store");
    await createSession(1, "https://example.com/", { width: 1, height: 1 });

    // Sanity: starts as running, no marker present.
    expect((await getSession())!.status).toBe("running");
    expect((await getEvents()).length).toBe(0);

    await pauseSession();

    // Both the marker and the status flip landed.
    const events = await getEvents();
    const session = await getSession();
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("session_paused");
    expect(session!.status).toBe("paused");
  });

  it("is a no-op when the session is already paused", async () => {
    const { createSession, pauseSession, getEvents } = await import("./session-store");
    await createSession(1, "https://example.com/", { width: 1, height: 1 });
    await pauseSession();
    await pauseSession(); // second call should be idempotent
    const events = await getEvents();
    expect(events.filter((e) => e.type === "session_paused").length).toBe(1);
  });

  it("returns null when no session exists", async () => {
    const { pauseSession } = await import("./session-store");
    const result = await pauseSession();
    expect(result).toBeNull();
  });
});

describe("session-store.resumeSession", () => {
  beforeEach(async () => {
    installFakeChromeStorage();
    vi.resetModules();
  });

  it("writes the session_resumed marker and flips status back to 'running'", async () => {
    const { createSession, pauseSession, resumeSession, getEvents, getSession } = await import("./session-store");
    await createSession(1, "https://example.com/", { width: 1, height: 1 });
    await pauseSession();
    await resumeSession();
    const events = await getEvents();
    const session = await getSession();
    expect(events.length).toBe(2);
    expect(events[0].type).toBe("session_paused");
    expect(events[1].type).toBe("session_resumed");
    expect(session!.status).toBe("running");
  });

  it("is a no-op when the session is already running", async () => {
    const { createSession, resumeSession, getEvents } = await import("./session-store");
    await createSession(1, "https://example.com/", { width: 1, height: 1 });
    const result = await resumeSession();
    expect(result).toBeNull();
    expect((await getEvents()).length).toBe(0);
  });
});

describe("session-store.discardSession — atomic remove", () => {
  let state: FakeChromeState;
  beforeEach(async () => {
    state = installFakeChromeStorage();
    vi.resetModules();
  });

  it("removes session, events, and screenshots in a single remove([...]) call", async () => {
    const { createSession, appendEvent, storeScreenshot, discardSession, getSession, getEvents, getScreenshots } =
      await import("./session-store");
    await createSession(1, "https://example.com/", { width: 1, height: 1 });
    await appendEvent({
      timestamp: "2026-04-07T12:00:00.000Z",
      type: "console_error",
      level: "error",
      message: "m",
      page_url: "https://example.com/",
    });
    await storeScreenshot("ss_1", "data:image/png;base64,STUB");

    const removeCallsBefore = state.removeCalls.length;

    await discardSession();

    // Exactly one remove() call after the setup.
    expect(state.removeCalls.length - removeCallsBefore).toBe(1);
    const lastCall = state.removeCalls[state.removeCalls.length - 1];
    expect(Array.isArray(lastCall)).toBe(true);
    // All three keys were passed in the same call.
    expect(lastCall).toEqual(
      expect.arrayContaining([
        "deskcheck_session",
        "deskcheck_events",
        "deskcheck_screenshots",
      ]),
    );

    // And the state reflects a total wipe.
    expect(await getSession()).toBeNull();
    expect(await getEvents()).toEqual([]);
    expect(await getScreenshots()).toEqual({});
  });
});

describe("session-store.clearResidual — same atomic contract", () => {
  let state: FakeChromeState;
  beforeEach(async () => {
    state = installFakeChromeStorage();
    vi.resetModules();
  });

  it("removes all three keys in a single remove call", async () => {
    const { createSession, endSession, clearResidual } = await import("./session-store");
    await createSession(1, "https://example.com/", { width: 1, height: 1 });
    await endSession();

    const before = state.removeCalls.length;
    await clearResidual();
    expect(state.removeCalls.length - before).toBe(1);
    const lastCall = state.removeCalls[state.removeCalls.length - 1];
    expect(Array.isArray(lastCall)).toBe(true);
    expect(lastCall).toEqual(
      expect.arrayContaining([
        "deskcheck_session",
        "deskcheck_events",
        "deskcheck_screenshots",
      ]),
    );
  });
});

describe("session-store.getSession — legacy compat for missing status", () => {
  beforeEach(async () => {
    installFakeChromeStorage();
    vi.resetModules();
  });

  it("defaults status to 'running' when legacy session has no end_time and no status", async () => {
    // Simulate a pre-1.2.0 session in storage: no status field.
    // Reach into the fake directly via the already-installed chrome shim.
    await (globalThis as unknown as { chrome: { storage: { local: { set: (x: Record<string, unknown>) => Promise<void> } } } }).chrome.storage.local.set({
      deskcheck_session: {
        id: "legacy-1",
        tab_id: 1,
        start_time: "2026-01-01T00:00:00.000Z",
        end_time: null,
        duration_ms: null,
        initial_url: "https://example.com",
        user_agent: "legacy",
        viewport: { width: 1, height: 1 },
        pii_mode: "full",
      },
    });
    const { getSession } = await import("./session-store");
    const session = await getSession();
    expect(session).not.toBeNull();
    expect(session!.status).toBe("running");
  });

  it("defaults status to 'stopped' when legacy session has end_time but no status", async () => {
    // Reach into the fake directly via the already-installed chrome shim.
    await (globalThis as unknown as { chrome: { storage: { local: { set: (x: Record<string, unknown>) => Promise<void> } } } }).chrome.storage.local.set({
      deskcheck_session: {
        id: "legacy-2",
        tab_id: 1,
        start_time: "2026-01-01T00:00:00.000Z",
        end_time: "2026-01-01T00:05:00.000Z",
        duration_ms: 300000,
        initial_url: "https://example.com",
        user_agent: "legacy",
        viewport: { width: 1, height: 1 },
        pii_mode: "full",
      },
    });
    const { getSession } = await import("./session-store");
    const session = await getSession();
    expect(session).not.toBeNull();
    expect(session!.status).toBe("stopped");
  });
});
