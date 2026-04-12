// chrome.storage.local wrapper for per-tab pending-handoff entries.
// Feature #14 phase 2: the marker-detector content script arms an entry
// when it detects #_deskcheck=... on page load; the service worker
// promotes it to the active deskcheck_handoff slot on toolbar click.

import { STORAGE_PENDING_HANDOFFS } from "../constants";

export interface PendingHandoffConfig {
  listener_url: string;
  token: string;
  session_id_hint: string;
  armed_at: string;
}

type PendingHandoffMap = Record<string, PendingHandoffConfig>;

const STALE_MS = 60 * 60 * 1000; // 1 hour

async function readMap(): Promise<PendingHandoffMap> {
  try {
    const result = await chrome.storage.local.get(STORAGE_PENDING_HANDOFFS);
    const raw = result[STORAGE_PENDING_HANDOFFS];
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return raw as PendingHandoffMap;
    }
  } catch {
    // storage unavailable
  }
  return {};
}

async function writeMap(map: PendingHandoffMap): Promise<void> {
  if (Object.keys(map).length === 0) {
    await chrome.storage.local.remove(STORAGE_PENDING_HANDOFFS);
  } else {
    await chrome.storage.local.set({ [STORAGE_PENDING_HANDOFFS]: map });
  }
}

function gcStale(map: PendingHandoffMap): PendingHandoffMap {
  const now = Date.now();
  const clean: PendingHandoffMap = {};
  for (const [key, entry] of Object.entries(map)) {
    const age = now - new Date(entry.armed_at).getTime();
    if (age < STALE_MS) {
      clean[key] = entry;
    }
  }
  return clean;
}

export async function armPendingHandoff(
  tabId: number,
  config: PendingHandoffConfig,
): Promise<void> {
  let map = await readMap();
  map = gcStale(map);
  map[String(tabId)] = config;
  await writeMap(map);
}

export async function getPendingHandoff(
  tabId: number,
): Promise<PendingHandoffConfig | null> {
  const map = await readMap();
  return map[String(tabId)] ?? null;
}

export async function clearPendingHandoff(tabId: number): Promise<void> {
  const map = await readMap();
  delete map[String(tabId)];
  await writeMap(map);
}

export async function getAllPendingHandoffs(): Promise<PendingHandoffMap> {
  return readMap();
}
