// chrome.storage.local wrapper for the feature-14 CLI handoff config key.
//
// Mirrors src/lib/privacy-store.ts line-for-line. Read failures return
// null (bias toward the download path — if we cannot confirm a handoff is
// configured, we must not POST). Write failures are logged and swallowed
// at the store level; the attach affordance in the side panel surfaces
// its own error to the user via the existing #async-error slot.

import { STORAGE_HANDOFF_CONFIG } from "../constants";
import { HandoffConfig, isHandoffConfig } from "./handoff";

export async function getHandoffConfig(): Promise<HandoffConfig | null> {
  try {
    const result = await chrome.storage.local.get(STORAGE_HANDOFF_CONFIG);
    const value = result[STORAGE_HANDOFF_CONFIG];
    if (!isHandoffConfig(value)) return null;
    return value;
  } catch (e) {
    console.warn("[DeskCheck] Failed to read handoff config:", e);
    return null;
  }
}

export async function setHandoffConfig(config: HandoffConfig): Promise<void> {
  try {
    await chrome.storage.local.set({ [STORAGE_HANDOFF_CONFIG]: config });
  } catch (e) {
    console.warn("[DeskCheck] Failed to persist handoff config:", e);
    throw e;
  }
}

export async function clearHandoffConfig(): Promise<void> {
  try {
    await chrome.storage.local.remove(STORAGE_HANDOFF_CONFIG);
  } catch (e) {
    console.warn("[DeskCheck] Failed to clear handoff config:", e);
  }
}
