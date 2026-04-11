import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getHandoffConfig,
  setHandoffConfig,
  clearHandoffConfig,
} from "./handoff-store";
import { STORAGE_HANDOFF_CONFIG } from "../constants";

// Unit tests for the handoff-store wrapper. Pins matrix row S4 (read
// failure returns null — bias toward the download path when storage is
// unavailable) plus the trivial round-trip cases.

type Fn = ReturnType<typeof vi.fn>;

interface FakeStorage {
  get: Fn;
  set: Fn;
  remove: Fn;
}

function installFakeStorage(): FakeStorage {
  const store: Record<string, unknown> = {};
  const fake: FakeStorage = {
    get: vi.fn().mockImplementation(async (key: string) => {
      return key in store ? { [key]: store[key] } : {};
    }),
    set: vi.fn().mockImplementation(async (items: Record<string, unknown>) => {
      Object.assign(store, items);
    }),
    remove: vi.fn().mockImplementation(async (keys: string | string[]) => {
      const arr = Array.isArray(keys) ? keys : [keys];
      for (const k of arr) delete store[k];
    }),
  };
  // @ts-expect-error — install fake chrome global
  globalThis.chrome = { storage: { local: fake } };
  return fake;
}

describe("handoff-store", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    installFakeStorage();
  });

  afterEach(() => {
    warnSpy.mockRestore();
    // @ts-expect-error — clean up chrome global
    delete globalThis.chrome;
  });

  it("getHandoffConfig returns null when the key is absent", async () => {
    expect(await getHandoffConfig()).toBeNull();
  });

  it("setHandoffConfig round-trips through getHandoffConfig", async () => {
    const config = {
      listener_url: "http://127.0.0.1:8787",
      token: "0123456789abcdef0123456789abcdef",
      created_at: "2026-04-11T22:00:00.000Z",
    };
    await setHandoffConfig(config);
    const read = await getHandoffConfig();
    expect(read).toEqual(config);
  });

  it("getHandoffConfig rejects malformed stored values (type guard)", async () => {
    // @ts-expect-error — intentionally stashing a non-config value
    chrome.storage.local.set({
      [STORAGE_HANDOFF_CONFIG]: { listener_url: "http://127.0.0.1:8787" /* missing fields */ },
    });
    const read = await getHandoffConfig();
    expect(read).toBeNull();
  });

  it("S4 — getHandoffConfig returns null on storage read failure (bias toward download path)", async () => {
    // @ts-expect-error — replace .get with a throwing stub
    chrome.storage.local.get = vi.fn().mockRejectedValue(new Error("storage unavailable"));
    const read = await getHandoffConfig();
    expect(read).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("clearHandoffConfig removes the stored record", async () => {
    await setHandoffConfig({
      listener_url: "http://127.0.0.1:8787",
      token: "abc",
      created_at: "x",
    });
    await clearHandoffConfig();
    expect(await getHandoffConfig()).toBeNull();
  });

  it("clearHandoffConfig swallows storage errors silently", async () => {
    // @ts-expect-error — replace .remove with a throwing stub
    chrome.storage.local.remove = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(clearHandoffConfig()).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
  });
});
