import { describe, it, expect } from "vitest";
import { bytesToBase64 } from "./encoding";

describe("bytesToBase64", () => {
  it("returns empty string for empty input", () => {
    expect(bytesToBase64(new Uint8Array([]))).toBe("");
  });

  it("encodes known bytes correctly", () => {
    // "Hello" in ASCII
    const bytes = new Uint8Array([72, 101, 108, 108, 111]);
    expect(bytesToBase64(bytes)).toBe("SGVsbG8=");
  });

  it("handles single byte", () => {
    const bytes = new Uint8Array([65]); // 'A'
    expect(bytesToBase64(bytes)).toBe("QQ==");
  });

  it("handles binary data (non-ASCII)", () => {
    const bytes = new Uint8Array([0, 128, 255]);
    const result = bytesToBase64(bytes);
    expect(result).toBe(btoa(String.fromCharCode(0, 128, 255)));
  });
});
