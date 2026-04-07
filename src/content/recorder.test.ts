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
        has_digits: true,
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
});
