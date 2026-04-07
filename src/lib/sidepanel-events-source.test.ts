// Acceptance tests for feature #8 — Test Level Matrix rows #11, #12.
// Pure unit tests for the storage.onChanged subscription helper.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  subscribeToEvents,
  type OnChangedListener,
  type StorageOnChangedApi,
  type EventsSourceCallbacks,
} from "./sidepanel-events-source";
import * as sessionStore from "./session-store";
import type { TimelineEvent } from "../types";
import { STORAGE_EVENTS } from "../constants";

function makeFakeOnChanged(): StorageOnChangedApi & { fire: (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area?: string) => void } {
  const listeners = new Set<OnChangedListener>();
  return {
    addListener(l) {
      listeners.add(l);
    },
    removeListener(l) {
      listeners.delete(l);
    },
    fire(changes, area = "local") {
      for (const l of listeners) l(changes, area);
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

describe("subscribeToEvents append delta (matrix #11, #12)", () => {
  let api: ReturnType<typeof makeFakeOnChanged>;
  let cb: EventsSourceCallbacks;
  let appended: TimelineEvent[][];
  let resets: TimelineEvent[][];

  beforeEach(() => {
    api = makeFakeOnChanged();
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

  it("fires onAppend with the delta when length grows", () => {
    subscribeToEvents(cb, {
      onChanged: api,
      initial: [ev(1), ev(2), ev(3)],
    });
    api.fire({
      [STORAGE_EVENTS]: {
        oldValue: [ev(1), ev(2), ev(3)],
        newValue: [ev(1), ev(2), ev(3), ev(4)],
      },
    });
    expect(appended).toHaveLength(1);
    expect(appended[0]).toHaveLength(1);
    expect(appended[0][0].seq).toBe(4);
    expect(resets).toHaveLength(0);
  });

  it("fires onAppend with multiple new events when several appended at once", () => {
    subscribeToEvents(cb, { onChanged: api, initial: [ev(1)] });
    api.fire({
      [STORAGE_EVENTS]: {
        oldValue: [ev(1)],
        newValue: [ev(1), ev(2), ev(3)],
      },
    });
    expect(appended[0].map((e) => e.seq)).toEqual([2, 3]);
  });

  it("fires onReset when newValue.length < lastSeenLength", () => {
    subscribeToEvents(cb, { onChanged: api, initial: [ev(1), ev(2), ev(3)] });
    api.fire({
      [STORAGE_EVENTS]: {
        oldValue: [ev(1), ev(2), ev(3)],
        newValue: [ev(1)],
      },
    });
    expect(resets).toHaveLength(1);
    expect(resets[0]).toHaveLength(1);
  });

  it("fires onReset when newValue is undefined (key removed)", () => {
    subscribeToEvents(cb, { onChanged: api, initial: [ev(1), ev(2)] });
    api.fire({
      [STORAGE_EVENTS]: { oldValue: [ev(1), ev(2)], newValue: undefined },
    });
    expect(resets).toHaveLength(1);
    expect(resets[0]).toEqual([]);
  });

  it("ignores changes to unrelated keys", () => {
    subscribeToEvents(cb, { onChanged: api, initial: [] });
    api.fire({
      some_other_key: { oldValue: 1, newValue: 2 },
    });
    expect(appended).toHaveLength(0);
    expect(resets).toHaveLength(0);
  });

  it("ignores changes from a non-local storage area", () => {
    subscribeToEvents(cb, { onChanged: api, initial: [] });
    api.fire(
      { [STORAGE_EVENTS]: { oldValue: [], newValue: [ev(1)] } },
      "sync",
    );
    expect(appended).toHaveLength(0);
  });

  it("unsubscribe stops further callbacks", () => {
    const sub = subscribeToEvents(cb, { onChanged: api, initial: [] });
    sub.unsubscribe();
    api.fire({
      [STORAGE_EVENTS]: { oldValue: [], newValue: [ev(1)] },
    });
    expect(appended).toHaveLength(0);
  });

  // PRIVACY / INVARIANT: the change handler must read change.newValue
  // DIRECTLY and never call session-store accessors. If a future
  // refactor pushes the read into session-store.getEvents(), the
  // append-delta optimization is silently broken.
  it("never calls session-store accessors from the change handler", () => {
    const getEventsSpy = vi.spyOn(sessionStore, "getEvents");
    const getSessionSpy = vi.spyOn(sessionStore, "getSession");
    const getScreenshotsSpy = vi.spyOn(sessionStore, "getScreenshots");
    subscribeToEvents(cb, { onChanged: api, initial: [] });
    api.fire({
      [STORAGE_EVENTS]: { oldValue: [], newValue: [ev(1), ev(2)] },
    });
    expect(getEventsSpy).not.toHaveBeenCalled();
    expect(getSessionSpy).not.toHaveBeenCalled();
    expect(getScreenshotsSpy).not.toHaveBeenCalled();
  });
});
