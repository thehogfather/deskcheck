import { describe, it, expect } from "vitest";
import {
  isValidLoopbackUrl,
  constantTimeEqual,
  redactToken,
  isHandoffConfig,
} from "./handoff";

// Unit tests for feature-14 phase-1 handoff helpers.
//
// Pins matrix rows S1 (URL validator adversarial cases), S2 (redactToken
// scrubbing), S3 (constant-time compare length-mismatch) plus structural
// coverage of the type guard.

describe("isValidLoopbackUrl (S1 — URL validator)", () => {
  // Positive cases
  it.each([
    "http://127.0.0.1:8787",
    "http://127.0.0.1:8787/",
    "http://localhost:8787",
    "http://localhost:1",
    "http://localhost:65535",
    "http://[::1]:8787",
  ])("accepts %s", (url) => {
    expect(isValidLoopbackUrl(url)).toBe(true);
  });

  // Adversarial negative cases
  it.each([
    ["DNS suffix attack", "http://127.0.0.1.evil.com:8787"],
    ["non-loopback host", "http://evil.com:8787"],
    ["loopback IPv4-mapped guise", "http://127.1.1.1.evil:8787"],
    ["https scheme", "https://127.0.0.1:8787"],
    ["ws scheme", "ws://127.0.0.1:8787"],
    ["file scheme", "file:///etc/passwd"],
    ["no port", "http://127.0.0.1"],
    ["empty port", "http://127.0.0.1:"],
    ["path", "http://127.0.0.1:8787/upload"],
    ["path traversal (URL normalised)", "http://127.0.0.1:8787/../upload"],
    ["query string", "http://127.0.0.1:8787?x=1"],
    ["fragment", "http://127.0.0.1:8787#frag"],
    ["credentials", "http://user:pass@127.0.0.1:8787"],
    ["empty string", ""],
    ["garbage", "not a url at all"],
    ["port 0", "http://127.0.0.1:0"],
    ["port out of range", "http://127.0.0.1:99999"],
  ])("rejects (%s) %s", (_label, url) => {
    expect(isValidLoopbackUrl(url)).toBe(false);
  });

  it("rejects non-string input", () => {
    // @ts-expect-error — exercising defensive branch
    expect(isValidLoopbackUrl(null)).toBe(false);
    // @ts-expect-error — exercising defensive branch
    expect(isValidLoopbackUrl(undefined)).toBe(false);
    // @ts-expect-error — exercising defensive branch
    expect(isValidLoopbackUrl(42)).toBe(false);
  });
});

describe("constantTimeEqual (S3 — constant-time compare)", () => {
  it("returns true for equal strings", () => {
    expect(constantTimeEqual("abc123", "abc123")).toBe(true);
  });

  it("returns false for equal-length mismatched strings", () => {
    expect(constantTimeEqual("abc123", "abc124")).toBe(false);
  });

  it("returns false for length mismatch (shorter first)", () => {
    expect(constantTimeEqual("abc", "abc123")).toBe(false);
  });

  it("returns false for length mismatch (longer first)", () => {
    expect(constantTimeEqual("abc123", "abc")).toBe(false);
  });

  it("returns true for two empty strings", () => {
    expect(constantTimeEqual("", "")).toBe(true);
  });

  it("returns false when one side is empty", () => {
    expect(constantTimeEqual("", "abc")).toBe(false);
    expect(constantTimeEqual("abc", "")).toBe(false);
  });

  it("handles 64-hex-char tokens (the CLI default length)", () => {
    const a = "a".repeat(64);
    const b = "a".repeat(64);
    const c = "a".repeat(63) + "b";
    expect(constantTimeEqual(a, b)).toBe(true);
    expect(constantTimeEqual(a, c)).toBe(false);
  });
});

describe("redactToken (S2 — token scrubbing)", () => {
  it("redacts a 16-hex-char substring", () => {
    const result = redactToken("error from 0123456789abcdef");
    expect(result).toBe("error from [redacted]");
  });

  it("redacts a 64-hex-char token (CLI default)", () => {
    const token = "0123456789abcdef".repeat(4);
    const result = redactToken(`Bearer ${token} unauthorized`);
    expect(result).toContain("[redacted]");
    expect(result).not.toContain(token);
  });

  it("redacts multiple token-like substrings in one string", () => {
    const result = redactToken("old=0123456789abcdef new=fedcba9876543210");
    expect(result).toBe("old=[redacted] new=[redacted]");
  });

  it("leaves short hex runs alone (too short to be a token)", () => {
    expect(redactToken("rgb(ff0000)")).toBe("rgb(ff0000)");
    expect(redactToken("deadbeef")).toBe("deadbeef");
  });

  it("leaves non-hex content alone", () => {
    expect(redactToken("plain text error")).toBe("plain text error");
  });

  it("returns empty string for non-string input", () => {
    // @ts-expect-error — exercising defensive branch
    expect(redactToken(null)).toBe("");
    // @ts-expect-error — exercising defensive branch
    expect(redactToken(undefined)).toBe("");
  });
});

describe("isHandoffConfig (type guard)", () => {
  it("accepts a complete config object", () => {
    expect(
      isHandoffConfig({
        listener_url: "http://127.0.0.1:8787",
        token: "abc123",
        created_at: "2026-04-11T22:00:00.000Z",
      }),
    ).toBe(true);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["string", "not a config"],
    ["array", []],
    ["missing token", { listener_url: "http://127.0.0.1:8787", created_at: "x" }],
    ["non-string listener_url", { listener_url: 42, token: "t", created_at: "x" }],
    ["non-string created_at", { listener_url: "http://127.0.0.1:8787", token: "t", created_at: 42 }],
  ])("rejects %s", (_label, value) => {
    expect(isHandoffConfig(value)).toBe(false);
  });
});
