// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { startRecording } from "./recorder";
import type { TimelineEventInput } from "../types";

const INPUT_DEBOUNCE = 800;

function flushDebounce() {
  vi.advanceTimersByTime(INPUT_DEBOUNCE + 10);
}

function dispatchInput(el: HTMLElement) {
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function dispatchChange(el: HTMLElement) {
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function clearBody() {
  while (document.body.firstChild) {
    document.body.removeChild(document.body.firstChild);
  }
}

describe("recorder PII modes", () => {
  let events: TimelineEventInput[];
  let stop: (() => void) | null;

  beforeEach(() => {
    vi.useFakeTimers();
    clearBody();
    events = [];
    stop = null;
  });

  afterEach(() => {
    stop?.();
    stop = null;
    vi.useRealTimers();
  });

  function inputEvents() {
    return events.filter(
      (e) => e.type === "interaction" && (e as any).subtype === "input",
    );
  }

  describe("full mode (default)", () => {
    it("emits raw value for text input", () => {
      const el = document.createElement("input");
      el.type = "text";
      document.body.appendChild(el);
      stop = startRecording((e) => events.push(e), { piiMode: "full" });
      el.value = "hello";
      dispatchInput(el);
      flushDebounce();
      const ie = inputEvents();
      expect(ie).toHaveLength(1);
      expect((ie[0] as any).value).toBe("hello");
      expect((ie[0] as any).value_metadata).toBeUndefined();
    });

    it("masks password values", () => {
      const el = document.createElement("input");
      el.type = "password";
      document.body.appendChild(el);
      stop = startRecording((e) => events.push(e), { piiMode: "full" });
      el.value = "hunter2";
      dispatchInput(el);
      flushDebounce();
      const ie = inputEvents();
      expect((ie[0] as any).value).toBe("[password]");
      expect(JSON.stringify(ie[0])).not.toContain("hunter2");
    });

    it("truncates long values to 200 chars", () => {
      const el = document.createElement("input");
      el.type = "text";
      document.body.appendChild(el);
      stop = startRecording((e) => events.push(e), { piiMode: "full" });
      el.value = "a".repeat(300);
      dispatchInput(el);
      flushDebounce();
      expect((inputEvents()[0] as any).value).toBe("a".repeat(200));
    });

    it("default opts (no piiMode passed) behaves like full", () => {
      const el = document.createElement("input");
      el.type = "text";
      document.body.appendChild(el);
      stop = startRecording((e) => events.push(e));
      el.value = "hello";
      dispatchInput(el);
      flushDebounce();
      expect((inputEvents()[0] as any).value).toBe("hello");
    });
  });

  describe("metadata mode", () => {
    it("emits value_metadata, never raw value, for text input", () => {
      const el = document.createElement("input");
      el.type = "text";
      document.body.appendChild(el);
      stop = startRecording((e) => events.push(e), { piiMode: "metadata" });
      el.value = "leaked-secret-12345";
      dispatchInput(el);
      flushDebounce();
      const ie = inputEvents();
      expect(ie).toHaveLength(1);
      expect((ie[0] as any).value).toBeUndefined();
      expect((ie[0] as any).value_metadata).toMatchObject({
        length: 19,
        letter_count: 12,
        digit_count: 5,
        special_count: 2,
      });
    });

    it("element selector is still populated in metadata mode", () => {
      const el = document.createElement("input");
      el.type = "text";
      el.id = "username";
      document.body.appendChild(el);
      stop = startRecording((e) => events.push(e), { piiMode: "metadata" });
      el.value = "alice";
      dispatchInput(el);
      flushDebounce();
      const ie = inputEvents();
      expect((ie[0] as any).element).toBeDefined();
      expect((ie[0] as any).element.selector).toBeTruthy();
    });

    it("PRIVACY-CRITICAL: serialized event never contains raw value (text)", () => {
      const el = document.createElement("input");
      el.type = "text";
      document.body.appendChild(el);
      stop = startRecording((e) => events.push(e), { piiMode: "metadata" });
      const sensitive = "leaked-secret-12345";
      el.value = sensitive;
      dispatchInput(el);
      flushDebounce();
      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain(sensitive);
    });

    it("PRIVACY-CRITICAL: serialized event never contains raw value (unicode)", () => {
      const el = document.createElement("input");
      el.type = "text";
      document.body.appendChild(el);
      stop = startRecording((e) => events.push(e), { piiMode: "metadata" });
      const sensitive = "\u{1F600}-中文-secret-naïve";
      el.value = sensitive;
      dispatchInput(el);
      flushDebounce();
      expect(JSON.stringify(events)).not.toContain(sensitive);
    });

    it("PRIVACY-CRITICAL: serialized event never contains password value", () => {
      const el = document.createElement("input");
      el.type = "password";
      document.body.appendChild(el);
      stop = startRecording((e) => events.push(e), { piiMode: "metadata" });
      el.value = "hunter2";
      dispatchInput(el);
      flushDebounce();
      expect(JSON.stringify(events)).not.toContain("hunter2");
    });

    it("emits via change event for select", () => {
      const el = document.createElement("select");
      const opt = document.createElement("option");
      opt.value = "alpha";
      opt.selected = true;
      el.appendChild(opt);
      document.body.appendChild(el);
      stop = startRecording((e) => events.push(e), { piiMode: "metadata" });
      dispatchChange(el);
      const ie = inputEvents();
      expect(ie).toHaveLength(1);
      expect((ie[0] as any).value).toBeUndefined();
      expect((ie[0] as any).value_metadata).toBeDefined();
    });
  });

  describe("none mode", () => {
    it("never emits input events for text", () => {
      const el = document.createElement("input");
      el.type = "text";
      document.body.appendChild(el);
      stop = startRecording((e) => events.push(e), { piiMode: "none" });
      el.value = "anything";
      dispatchInput(el);
      flushDebounce();
      expect(inputEvents()).toHaveLength(0);
    });

    it("never emits input events for password", () => {
      const el = document.createElement("input");
      el.type = "password";
      document.body.appendChild(el);
      stop = startRecording((e) => events.push(e), { piiMode: "none" });
      el.value = "hunter2";
      dispatchInput(el);
      flushDebounce();
      expect(inputEvents()).toHaveLength(0);
      expect(JSON.stringify(events)).not.toContain("hunter2");
    });

    it("never emits input events for textarea", () => {
      const el = document.createElement("textarea");
      document.body.appendChild(el);
      stop = startRecording((e) => events.push(e), { piiMode: "none" });
      el.value = "anything";
      dispatchInput(el);
      flushDebounce();
      expect(inputEvents()).toHaveLength(0);
    });

    it("never emits input events for select", () => {
      const el = document.createElement("select");
      document.body.appendChild(el);
      stop = startRecording((e) => events.push(e), { piiMode: "none" });
      dispatchChange(el);
      expect(inputEvents()).toHaveLength(0);
    });

    it("change events on inputs do NOT emit input events in none mode", () => {
      const el = document.createElement("input");
      el.type = "text";
      document.body.appendChild(el);
      stop = startRecording((e) => events.push(e), { piiMode: "none" });
      el.value = "anything";
      dispatchChange(el);
      expect(inputEvents()).toHaveLength(0);
    });

    it("click events still fire in none mode (sanity check)", () => {
      const btn = document.createElement("button");
      document.body.appendChild(btn);
      stop = startRecording((e) => events.push(e), { piiMode: "none" });
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      const clicks = events.filter(
        (e) => e.type === "interaction" && (e as any).subtype === "click",
      );
      expect(clicks).toHaveLength(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Feature #16 — recorder freezes the PII mode at session start.
  //
  // The DoD requires gating "on a session-scoped frozen mode value, not
  // on a live read of storage". We test this by mutating the opts
  // object after startRecording — a deeply-frozen recorder must ignore
  // the mutation. This pins the contract so a future refactor that
  // reads opts.piiMode lazily inside the input handler (or subscribes
  // to chrome.storage to follow live updates) cannot quietly leak raw
  // values when the user picked metadata or none.
  // ───────────────────────────────────────────────────────────────────

  describe("feature-16: PII mode is frozen at start (closure freeze)", () => {
    it("mutating opts.piiMode after start does NOT change captured payload shape (metadata → full leak prevented)", () => {
      const el = document.createElement("input");
      el.type = "text";
      document.body.appendChild(el);
      const opts = { piiMode: "metadata" as const } as { piiMode: "full" | "metadata" | "none" };
      stop = startRecording((e) => events.push(e), opts);
      // Adversarial mid-session "switch" — simulate a future refactor
      // where the source of opts could mutate (e.g. live storage update).
      opts.piiMode = "full";
      el.value = "leaked-secret-12345";
      dispatchInput(el);
      flushDebounce();
      const ie = inputEvents();
      expect(ie).toHaveLength(1);
      // Recorder must keep using "metadata" — no raw value, only metadata.
      expect((ie[0] as any).value, "post-mutation event must NOT include raw value").toBeUndefined();
      expect((ie[0] as any).value_metadata).toBeDefined();
      expect(JSON.stringify(events)).not.toContain("leaked-secret-12345");
    });

    it("mutating opts.piiMode from full to none does NOT silence the recorder", () => {
      const el = document.createElement("input");
      el.type = "text";
      document.body.appendChild(el);
      const opts = { piiMode: "full" as const } as { piiMode: "full" | "metadata" | "none" };
      stop = startRecording((e) => events.push(e), opts);
      opts.piiMode = "none";
      el.value = "still-recorded";
      dispatchInput(el);
      flushDebounce();
      const ie = inputEvents();
      // The full-mode listener was registered at start; flipping opts to
      // "none" mid-session must NOT silently turn the recorder off.
      expect(ie).toHaveLength(1);
      expect((ie[0] as any).value).toBe("still-recorded");
    });
  });
});
