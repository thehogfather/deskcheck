import { describe, it, expect } from "vitest";
import { isExtensionUrl, formatStackTrace } from "./debugger-client";

describe("isExtensionUrl", () => {
  it("returns true for chrome-extension:// URLs", () => {
    expect(
      isExtensionUrl("chrome-extension://abc123/content.js"),
    ).toBe(true);
  });

  it("returns false for https:// URLs", () => {
    expect(isExtensionUrl("https://example.com")).toBe(false);
  });

  it("returns false for http:// URLs", () => {
    expect(isExtensionUrl("http://localhost:3000")).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isExtensionUrl(undefined)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isExtensionUrl("")).toBe(false);
  });
});

describe("formatStackTrace", () => {
  it("formats call frames as indented stack trace", () => {
    const result = formatStackTrace({
      callFrames: [
        {
          functionName: "handleClick",
          url: "https://example.com/app.js",
          lineNumber: 42,
          columnNumber: 15,
        },
        {
          functionName: "",
          url: "https://example.com/main.js",
          lineNumber: 10,
          columnNumber: 5,
        },
      ],
    });
    expect(result).toBe(
      "  at handleClick (https://example.com/app.js:42:15)\n" +
      "  at (anonymous) (https://example.com/main.js:10:5)",
    );
  });

  it("handles empty call frames", () => {
    expect(formatStackTrace({ callFrames: [] })).toBe("");
  });

  it("uses (anonymous) for unnamed functions", () => {
    const result = formatStackTrace({
      callFrames: [
        { functionName: "", url: "test.js", lineNumber: 1, columnNumber: 0 },
      ],
    });
    expect(result).toContain("(anonymous)");
  });
});
