// chrome.storage.local wrapper for the feature-14 CLI handoff config key.
//
// Mirrors src/lib/privacy-store.ts line-for-line. Read failures return
// null (bias toward the download path — if we cannot confirm a handoff is
// configured, we must not POST). Write failures are logged and swallowed;
// the attach affordance surfaces write errors to the user via the side
// panel's existing #async-error slot.

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

export async function setHandoffConfig(_config: HandoffConfig): Promise<void> {
  throw new Error("setHandoffConfig not implemented");
}

export async function clearHandoffConfig(): Promise<void> {
  throw new Error("clearHandoffConfig not implemented");
}
