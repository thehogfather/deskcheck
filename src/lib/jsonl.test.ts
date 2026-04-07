import { describe, it, expect } from "vitest";
import { encodeRecord, decodeAll } from "./jsonl";

// JSONL is the append-only log format used for the OPFS events file. Its
// pure encode/decode helpers are the narrow contract the write/read paths
// rely on, so their edge cases are exhaustively covered here without any
// I/O. See docs/plans/feature-5/selected-plan.md for the rationale.

describe("encodeRecord", () => {
  it("serialises an object to a single line terminated by \\n", () => {
    const line = encodeRecord({ a: 1, b: "two" });
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).toBe(JSON.stringify({ a: 1, b: "two" }));
  });

  it("escapes embedded newlines so one record can never span two lines", () => {
    const line = encodeRecord({ msg: "line1\nline2" });
    // The encoded line should contain the literal \n escape sequence (two
    // characters: '\\' and 'n'), never a raw U+000A in the middle of the
    // record body.
    const body = line.slice(0, -1);
    expect(body.includes("\\n")).toBe(true);
    expect(body.indexOf("\n")).toBe(-1);
  });

  it("round-trips with decodeAll", () => {
    const records = [{ a: 1 }, { b: 2 }, { c: "three" }];
    const body = records.map((r) => encodeRecord(r)).join("");
    const out = decodeAll<Record<string, unknown>>(body);
    expect(out.records).toEqual(records);
    expect(out.partialTrailingLine).toBe(false);
    expect(out.malformedLines).toBe(0);
  });
});

describe("decodeAll", () => {
  it("returns an empty result for empty input", () => {
    const out = decodeAll<unknown>("");
    expect(out.records).toEqual([]);
    expect(out.partialTrailingLine).toBe(false);
    expect(out.malformedLines).toBe(0);
  });

  it("parses a single well-formed line", () => {
    const out = decodeAll<Record<string, unknown>>('{"a":1}\n');
    expect(out.records).toEqual([{ a: 1 }]);
    expect(out.partialTrailingLine).toBe(false);
  });

  it("tolerates a missing trailing newline (partial trailing line skipped)", () => {
    const out = decodeAll<Record<string, unknown>>('{"a":1}\n{"b":2}\n{"c":3');
    expect(out.records).toEqual([{ a: 1 }, { b: 2 }]);
    expect(out.partialTrailingLine).toBe(true);
  });

  it("treats a single line without a trailing newline as partial, not an error", () => {
    const out = decodeAll<Record<string, unknown>>('{"a":1}');
    expect(out.records).toEqual([]);
    expect(out.partialTrailingLine).toBe(true);
  });

  it("never splits records on newlines embedded inside JSON string fields", () => {
    // JSON.stringify always escapes \n inside strings as \\n, so a decoder
    // that splits on the raw character byte will still work because the
    // encoded line has no raw \n. This test pins that assumption.
    const encoded = JSON.stringify({ msg: "hello\nworld" }) + "\n";
    const out = decodeAll<{ msg: string }>(encoded);
    expect(out.records).toEqual([{ msg: "hello\nworld" }]);
  });

  it("skips malformed intermediate lines and continues", () => {
    const body = '{"a":1}\nnot-json\n{"b":2}\n';
    const out = decodeAll<Record<string, unknown>>(body);
    expect(out.records).toEqual([{ a: 1 }, { b: 2 }]);
    expect(out.malformedLines).toBe(1);
  });

  it("never throws on any input (safety invariant)", () => {
    // The reader runs at startup on whatever is on disk, including
    // crash-truncated files. It must never raise.
    for (const body of [
      "",
      "\n",
      "\n\n\n",
      "{",
      "{}{",
      "garbage",
      '{"valid":true}\n\0\0\0',
    ]) {
      expect(() => decodeAll<unknown>(body)).not.toThrow();
    }
  });
});
