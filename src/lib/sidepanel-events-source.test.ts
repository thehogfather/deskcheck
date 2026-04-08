// Acceptance tests for feature #8 — Test Level Matrix rows #11, #12.
// Pure unit tests for the runtime-message subscription helper.
//
// After feature #5, the side panel learns about new events via runtime
// broadcasts (`EVENT_APPENDED`, `SESSION_CLEARED`) instead of
// chrome.storage.onChanged. This test pins that contract.

import { describe, it, expect, beforeEach } from "vitest";
import {
  subscribeToEvents,
  type RuntimeMessageListener,
  type RuntimeOnMessageApi,
  type EventsSourceCallbacks,
} from "./sidepanel-events-source";
import type { Message, TimelineEvent } from "../types";

function makeFakeRuntime(): RuntimeOnMessageApi & {
  fire: (msg: Message) => void;
  listenerCount: () => number;
} {
  const listeners = new Set<RuntimeMessageListener>();
  return {
    addListener(l) {
      listeners.add(l);
    },
    removeListener(l) {
      listeners.delete(l);
    },
    fire(msg) {
      for (const l of listeners) {
        l(msg, {} as chrome.runtime.MessageSender, () => {});
      }
    },
    listenerCount() {
      return listeners.size;
    },
  };
}

function ev(seq: number, type: TimelineEvent["type"] = "console_error"): TimelineEvent {
  return {
    seq,
    timestamp: `2026-04-07T12:00:0${seq % 10}.000Z`,
    page_url: "https://example.com/",
    type,
    level: "error",
    message: `m${seq}`,
  } as TimelineEvent;
}

describe("subscribeToEvents runtime broadcasts (matrix #11, #12)", () => {
  let api: ReturnType<typeof makeFakeRuntime>;
  let cb: EventsSourceCallbacks;
  let appended: TimelineEvent[][];
  let resets: TimelineEvent[][];

  beforeEach(() => {
    api = makeFakeRuntime();
    appended = [];
    resets = [];
    cb = {
      onAppend: (e) => {
        appended.push(e);
      },
      onReset: (e) => {
        resets.push(e);
      },
    };
  });

  it("fires onAppend with the broadcast event", () => {
    subscribeToEvents(cb, { onMessage: api });
    api.fire({ type: "EVENT_APPENDED", event: ev(1) });
    expect(appended).toHaveLength(1);
    expect(appended[0]).toHaveLength(1);
    expect(appended[0][0].seq).toBe(1);
    expect(resets).toHaveLength(0);
  });

  it("fires onAppend repeatedly for sequential broadcasts", () => {
    subscribeToEvents(cb, { onMessage: api });
    api.fire({ type: "EVENT_APPENDED", event: ev(1) });
    api.fire({ type: "EVENT_APPENDED", event: ev(2) });
    api.fire({ type: "EVENT_APPENDED", event: ev(3) });
    expect(appended).toHaveLength(3);
    expect(appended.map((batch) => batch[0].seq)).toEqual([1, 2, 3]);
  });

  it("fires onReset on SESSION_CLEARED", () => {
    subscribeToEvents(cb, { onMessage: api });
    api.fire({ type: "SESSION_CLEARED" });
    expect(resets).toHaveLength(1);
    expect(resets[0]).toEqual([]);
  });

  it("ignores unrelated message types", () => {
    subscribeToEvents(cb, { onMessage: api });
    api.fire({ type: "GET_SESSION_STATE" });
    api.fire({ type: "PAUSE_SESSION" });
    api.fire({
      type: "PICK_ELEMENT_RESULT",
      element: null,
      devicePixelRatio: 1,
    });
    expect(appended).toHaveLength(0);
    expect(resets).toHaveLength(0);
  });

  it("unsubscribe removes the listener", () => {
    const sub = subscribeToEvents(cb, { onMessage: api });
    expect(api.listenerCount()).toBe(1);
    sub.unsubscribe();
    expect(api.listenerCount()).toBe(0);
    api.fire({ type: "EVENT_APPENDED", event: ev(1) });
    expect(appended).toHaveLength(0);
  });
});
