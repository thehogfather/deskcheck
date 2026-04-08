// Wrapper around chrome.runtime.onMessage that exposes a clean
// "subscribe to events" API for the side panel.
//
// PRIVACY / CORRECTNESS NOTES:
// - After feature #5 moved events out of chrome.storage.local into OPFS,
//   the side panel can no longer use chrome.storage.onChanged to learn
//   about new events. Instead, the service worker fires runtime
//   `EVENT_APPENDED` broadcasts after each successful append.
// - This module never reads from any store; it only relays the
//   broadcast events into the caller-supplied callbacks. The append-only
//   contract is enforced on the write side by SessionStore (pinned by
//   src/lib/session-store.test.ts).
// - `SESSION_CLEARED` is mapped to a full reset.

import type { Message, TimelineEvent } from "../types";

// We keep the listener shape narrow on purpose: side panel callers
// only need the message itself. The real chrome.runtime.onMessage API
// passes (msg, sender, sendResponse), but ignoring the extra args is
// always safe — JavaScript drops them silently.
export interface RuntimeMessageListener {
  (msg: Message, ...rest: unknown[]): unknown;
}

export interface RuntimeOnMessageApi {
  addListener(listener: RuntimeMessageListener): void;
  removeListener(listener: RuntimeMessageListener): void;
}

export interface EventsSourceCallbacks {
  /** Fired with new events appended since the last delta. */
  onAppend(newEvents: TimelineEvent[]): void;
  /** Fired when the session is cleared (e.g. after export/delete). */
  onReset(allEvents: TimelineEvent[]): void;
}

export interface SubscribeOptions {
  /** Override the chrome.runtime.onMessage API for tests. */
  onMessage?: RuntimeOnMessageApi;
}

export interface Subscription {
  unsubscribe(): void;
}

function defaultOnMessage(): RuntimeOnMessageApi {
  return chrome.runtime.onMessage as unknown as RuntimeOnMessageApi;
}

export function subscribeToEvents(
  callbacks: EventsSourceCallbacks,
  options: SubscribeOptions = {},
): Subscription {
  const api = options.onMessage ?? defaultOnMessage();

  const listener: RuntimeMessageListener = (msg) => {
    if (!msg || typeof msg !== "object") return;
    const m = msg as Message;
    if (m.type === "EVENT_APPENDED") {
      callbacks.onAppend([m.event]);
      return;
    }
    if (m.type === "SESSION_CLEARED") {
      callbacks.onReset([]);
      return;
    }
  };

  api.addListener(listener);

  return {
    unsubscribe() {
      api.removeListener(listener);
    },
  };
}
