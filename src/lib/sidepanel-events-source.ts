// STUB — Phase 3 (failing acceptance tests). Phase 4 will implement.
//
// Wrapper around chrome.storage.onChanged that exposes a clean
// "subscribe to events" API. The handler:
//   - reads change.newValue DIRECTLY (never calls getEvents() or any
//     store accessor — pinned by spy test)
//   - computes a delta as newValue.slice(lastSeenLength) (append-only)
//   - if newValue.length < lastSeenLength OR newValue is undefined,
//     fires onReset(newValue ?? [])
//
// See selected-plan.md architectural decision #2.

import type { TimelineEvent } from "../types";

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

export function subscribeToEvents(
  _callbacks: EventsSourceCallbacks,
  _options?: SubscribeOptions,
): Subscription {
  throw new Error("sidepanel-events-source.subscribeToEvents not implemented");
}
