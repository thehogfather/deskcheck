// Acceptance tests for feature #14 phase 2 — pending-handoff store.
//
// Pins the chrome.storage.local wrapper for the per-tab pending-handoff
// map. Mirrors handoff-store.test.ts (Phase 1) for style.
//
// Matrix rows: A8 (stale GC on arm), A9 (tab close clears entry)

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  armPendingHandoff,
  getPendingHandoff,
  clearPendingHandoff,
  getAllPendingHandoffs,
  type PendingHandoffConfig,
} from "../src/lib/pending-handoff-store";

function installFakeStorage(initial: Record<string, unknown> = {}) {
  const storage: Record<string, unknown> = { ...initial };
  const fake = {
    local: {
      get: vi.fn(async (keys: string | string[]) => {
        if (typeof keys === "string") {
          return keys in storage ? { [keys]: storage[keys] } : {};
        }
        const out: Record<string, unknown> = {};
        for (const k of Array.isArray(keys) ? keys : []) {
          if (k in storage) out[k] = storage[k];
        }
        return out;
      }),
      set: vi.fn(async (items: Record<string, unknown>) => {
        Object.assign(storage, items);
      }),
      remove: vi.fn(async (keys: string | string[]) => {
        for (const k of Array.isArray(keys) ? keys : [keys]) delete storage[k];
      }),
    },
  };
  (globalThis as any).chrome = { storage: fake };
  return { storage, fake };
}

describe("pending-handoff-store", () => {
  beforeEach(() => {
    installFakeStorage();
  });

  const SAMPLE: PendingHandoffConfig = {
    listener_url: "http://127.0.0.1:54329",
    token: "a".repeat(64),
    session_id_hint: "test-session",
    armed_at: new Date().toISOString(),
  };

  it("armPendingHandoff stores entry keyed by tab id", async () => {
    await armPendingHandoff(42, SAMPLE);
    const result = await getPendingHandoff(42);
    expect(result).toEqual(SAMPLE);
  });

  it("getPendingHandoff returns null for unknown tab", async () => {
    const result = await getPendingHandoff(999);
    expect(result).toBeNull();
  });

  it("clearPendingHandoff removes the entry", async () => {
    await armPendingHandoff(42, SAMPLE);
    await clearPendingHandoff(42);
    const result = await getPendingHandoff(42);
    expect(result).toBeNull();
  });

  it("getAllPendingHandoffs returns all entries", async () => {
    await armPendingHandoff(42, SAMPLE);
    await armPendingHandoff(99, { ...SAMPLE, session_id_hint: "other" });
    const all = await getAllPendingHandoffs();
    expect(Object.keys(all)).toHaveLength(2);
  });

  // A8 — stale GC on arm
  it("garbage-collects entries older than 1 hour on arm", async () => {
    const stale: PendingHandoffConfig = {
      ...SAMPLE,
      session_id_hint: "stale-session",
      armed_at: new Date(Date.now() - 61 * 60 * 1000).toISOString(),
    };
    await armPendingHandoff(10, stale);
    // Arming a new entry should GC the stale one
    await armPendingHandoff(20, SAMPLE);
    const result = await getPendingHandoff(10);
    expect(result).toBeNull();
    const fresh = await getPendingHandoff(20);
    expect(fresh).toEqual(SAMPLE);
  });
});
