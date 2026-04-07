// Wrapper around chrome.storage.onChanged that exposes a clean
// "subscribe to events" API for the side panel.
//
// PRIVACY / INVARIANT:
// - Reads change.newValue DIRECTLY (never calls getEvents() or any
//   store accessor — pinned by spy test in sidepanel-events-source.test.ts).
// - Computes a delta as `newValue.slice(lastSeenLength)` (append-only).
// - If newValue.length < lastSeenLength OR newValue is undefined,
//   fires `onReset(newValue ?? [])` instead of `onAppend`.
//
// The append-only contract is pinned on the write side by
// session-store.test.ts; this subscriber depends on it but tolerates
// shrinks gracefully via the reset path.

import type { TimelineEvent } from "../types";
import { STORAGE_EVENTS } from "../constants";

export interface OnChangedListener {
  (
    changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
    areaName: string,
  ): void;
}

export interface StorageOnChangedApi {
  addListener(listener: OnChangedListener): void;
  removeListener(listener: OnChangedListener): void;
}

export interface EventsSourceCallbacks {
  /** Fired with new events appended since the last delta. */
  onAppend(newEvents: TimelineEvent[]): void;
  /** Fired when the events array shrinks, is removed, or is replaced. */
  onReset(allEvents: TimelineEvent[]): void;
}

export interface SubscribeOptions {
  /** Override the chrome.storage.onChanged API for tests. */
  onChanged?: StorageOnChangedApi;
  /** Storage key holding the events array. Defaults to STORAGE_EVENTS. */
  storageKey?: string;
  /** Initial events list (so the helper knows lastSeenLength). */
  initial?: TimelineEvent[];
}

export interface Subscription {
  unsubscribe(): void;
}

function defaultOnChanged(): StorageOnChangedApi {
  return chrome.storage.onChanged as unknown as StorageOnChangedApi;
}

export function subscribeToEvents(
  callbacks: EventsSourceCallbacks,
  options: SubscribeOptions = {},
): Subscription {
  const api = options.onChanged ?? defaultOnChanged();
  const storageKey = options.storageKey ?? STORAGE_EVENTS;
  let lastSeenLength = options.initial?.length ?? 0;

  const listener: OnChangedListener = (changes, areaName) => {
    if (areaName !== "local") return;
    if (!(storageKey in changes)) return;

    const change = changes[storageKey];
    const newValue = change.newValue as TimelineEvent[] | undefined;

    if (newValue === undefined) {
      lastSeenLength = 0;
      callbacks.onReset([]);
      return;
    }

    if (!Array.isArray(newValue)) {
      // Defensive: if storage is corrupted into a non-array shape,
      // treat it as a reset to empty.
      lastSeenLength = 0;
      callbacks.onReset([]);
      return;
    }

    if (newValue.length < lastSeenLength) {
      lastSeenLength = newValue.length;
      callbacks.onReset(newValue);
      return;
    }

    if (newValue.length === lastSeenLength) {
      // No-op: same-length update (e.g. metadata-only rewrite). The
      // append-only contract means an in-place edit at the same length
      // is suspicious — surface as a full reset to keep the UI honest.
      callbacks.onReset(newValue);
      return;
    }

    const appended = newValue.slice(lastSeenLength);
    lastSeenLength = newValue.length;
    callbacks.onAppend(appended);
  };

  api.addListener(listener);

  return {
    unsubscribe() {
      api.removeListener(listener);
    },
  };
}
