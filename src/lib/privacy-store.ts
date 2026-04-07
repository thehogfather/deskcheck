import { STORAGE_PRIVACY_FIRST_RUN_SEEN } from "../constants";

// Tiny chrome.storage.local wrapper for the first-run privacy notice flag.
// Read failures bias toward "not seen" so the user always errs on the side of
// seeing the notice rather than silently skipping it. Write failures are
// logged but not thrown — re-showing the notice next session is graceful
// degradation, and the flag is monotonic so a duplicate write is harmless.

export async function getFirstRunSeen(): Promise<boolean> {
  try {
    const result = await chrome.storage.local.get(STORAGE_PRIVACY_FIRST_RUN_SEEN);
    return result[STORAGE_PRIVACY_FIRST_RUN_SEEN] === true;
  } catch (e) {
    console.warn("[DeskCheck] Failed to read privacy notice flag:", e);
    return false;
  }
}

export async function markFirstRunSeen(): Promise<void> {
  try {
    await chrome.storage.local.set({ [STORAGE_PRIVACY_FIRST_RUN_SEEN]: true });
  } catch (e) {
    console.warn("[DeskCheck] Failed to persist privacy notice flag:", e);
  }
}
