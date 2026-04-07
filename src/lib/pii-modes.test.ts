// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  PII_MODES,
  DEFAULT_PII_MODE,
  type PiiCaptureMode,
  extractInputMetadata,
  capturePayloadForMode,
  parsePiiMode,
} from "./pii-modes";

describe("PII_MODES constant", () => {
  it("contains exactly full, metadata, none in that order", () => {
    expect(PII_MODES).toEqual(["full", "metadata", "none"]);
  });

  it("default mode is full", () => {
    expect(DEFAULT_PII_MODE).toBe("full");
  });
});

describe("extractInputMetadata", () => {
  it("empty string", () => {
    expect(extractInputMetadata("")).toEqual({
      length: 0,
      word_count: 0,
      letter_count: 0,
      digit_count: 0,
      emoji_count: 0,
      whitespace_count: 0,
      special_count: 0,
    });
  });

  it("single word", () => {
    expect(extractInputMetadata("hello")).toEqual({
      length: 5,
      word_count: 1,
      letter_count: 5,
      digit_count: 0,
      emoji_count: 0,
      whitespace_count: 0,
      special_count: 0,
    });
  });

  it("multiple words", () => {
    const m = extractInputMetadata("hello world");
    expect(m.length).toBe(11);
    expect(m.word_count).toBe(2);
    expect(m.letter_count).toBe(10);
    expect(m.whitespace_count).toBe(1);
  });

  it("only whitespace counts as zero words", () => {
    const m = extractInputMetadata("   ");
    expect(m.length).toBe(3);
    expect(m.word_count).toBe(0);
    expect(m.whitespace_count).toBe(3);
    expect(m.letter_count).toBe(0);
  });

  it("collapses repeated spaces in word count but counts each whitespace char", () => {
    const m = extractInputMetadata("one  two   three");
    expect(m.word_count).toBe(3);
    expect(m.whitespace_count).toBe(5);
  });

  it("digit count is exact, not a flag", () => {
    expect(extractInputMetadata("abc123").digit_count).toBe(3);
    expect(extractInputMetadata("abc").digit_count).toBe(0);
    expect(extractInputMetadata("4111-1111-1111-1111").digit_count).toBe(16);
  });

  it("special count is exact, not a flag", () => {
    expect(extractInputMetadata("hello!").special_count).toBe(1);
    expect(extractInputMetadata("hello").special_count).toBe(0);
    expect(extractInputMetadata("$100").special_count).toBe(1);
    expect(extractInputMetadata("a!b@c#").special_count).toBe(3);
  });

  it("special and digit counts are independent", () => {
    const m = extractInputMetadata("a1!b2@c3#");
    expect(m.letter_count).toBe(3);
    expect(m.digit_count).toBe(3);
    expect(m.special_count).toBe(3);
  });

  it("plain emoji is counted", () => {
    const m = extractInputMetadata("hello \u{1F600}");
    expect(m.emoji_count).toBe(1);
    expect(m.letter_count).toBe(5);
    expect(m.whitespace_count).toBe(1);
  });

  it("multiple emojis are counted", () => {
    const m = extractInputMetadata("\u{1F600}\u{1F601}\u{1F602}");
    expect(m.emoji_count).toBe(3);
  });

  it("ZWJ emoji sequence counts as one visual emoji", () => {
    // Man + ZWJ + Laptop = single grapheme 👨‍💻
    const zwj = "\u{1F468}\u200D\u{1F4BB}";
    expect(extractInputMetadata(zwj).emoji_count).toBe(1);
  });

  it("emoji does not inflate special_count", () => {
    const m = extractInputMetadata("hi \u{1F600}");
    expect(m.emoji_count).toBe(1);
    expect(m.special_count).toBe(0);
  });

  it("accented latin characters are letters, not special", () => {
    const m = extractInputMetadata("naïve café");
    expect(m.special_count).toBe(0);
    expect(m.word_count).toBe(2);
    expect(m.letter_count).toBe(9);
  });

  it("CJK characters are letters, not special", () => {
    const m = extractInputMetadata("中文");
    expect(m.special_count).toBe(0);
    expect(m.letter_count).toBe(2);
    expect(m.length).toBe(2);
  });

  it("tab and newline split words and count as whitespace", () => {
    const m = extractInputMetadata("a\nb\tc");
    expect(m.word_count).toBe(3);
    expect(m.whitespace_count).toBe(2);
    expect(m.letter_count).toBe(3);
  });

  it("very long string length is exact", () => {
    const long = "a".repeat(10000);
    const m = extractInputMetadata(long);
    expect(m.length).toBe(10000);
    expect(m.letter_count).toBe(10000);
  });

  it("mixed realistic input for repro fidelity", () => {
    // "Order #42 $9.99" — no emoji to keep length/word math simple
    const m = extractInputMetadata("Order #42 $9.99");
    expect(m.length).toBe(15);
    // words: ["Order", "#42", "$9.99"]
    expect(m.word_count).toBe(3);
    // letters: "Order" = 5
    expect(m.letter_count).toBe(5);
    // digits: "42" + "999" = 5
    expect(m.digit_count).toBe(5);
    expect(m.emoji_count).toBe(0);
    expect(m.whitespace_count).toBe(2);
    // specials: #, $, .
    expect(m.special_count).toBe(3);
  });
});

describe("capturePayloadForMode", () => {
  function makeText(value: string): HTMLInputElement {
    const el = document.createElement("input");
    el.type = "text";
    el.value = value;
    return el;
  }

  function makePassword(value: string): HTMLInputElement {
    const el = document.createElement("input");
    el.type = "password";
    el.value = value;
    return el;
  }

  function makeTextarea(value: string): HTMLTextAreaElement {
    const el = document.createElement("textarea");
    el.value = value;
    return el;
  }

  function makeSelect(value: string): HTMLSelectElement {
    const el = document.createElement("select");
    const opt = document.createElement("option");
    opt.value = value;
    opt.selected = true;
    el.appendChild(opt);
    return el;
  }

  describe("full mode", () => {
    it("returns the raw value for text inputs", () => {
      const el = makeText("hello");
      expect(capturePayloadForMode(el, "full")).toEqual({ value: "hello" });
    });

    it("masks password fields", () => {
      const el = makePassword("hunter2");
      expect(capturePayloadForMode(el, "full")).toEqual({ value: "[password]" });
    });

    it("truncates long values to 200 chars", () => {
      const el = makeText("a".repeat(300));
      const out = capturePayloadForMode(el, "full");
      expect(out.value).toBe("a".repeat(200));
    });

    it("works on textareas", () => {
      const el = makeTextarea("multi\nline");
      expect(capturePayloadForMode(el, "full")).toEqual({ value: "multi\nline" });
    });

    it("works on selects", () => {
      const el = makeSelect("option-a");
      expect(capturePayloadForMode(el, "full")).toEqual({ value: "option-a" });
    });

    it("never sets value_metadata in full mode", () => {
      const el = makeText("hello");
      const out = capturePayloadForMode(el, "full");
      expect(out.value_metadata).toBeUndefined();
    });
  });

  describe("metadata mode", () => {
    it("emits value_metadata, never the raw value, for text", () => {
      const el = makeText("leaked-secret-12345");
      const out = capturePayloadForMode(el, "metadata");
      expect(out.value).toBeUndefined();
      expect(out.value_metadata).toBeDefined();
      expect(out.value_metadata!.length).toBe(19);
      expect(out.value_metadata!.digit_count).toBe(5);
      expect(out.value_metadata!.letter_count).toBe(12);
      expect(out.value_metadata!.special_count).toBe(2); // two hyphens
    });

    it("emits value_metadata for password fields (length leaks but value never does)", () => {
      const el = makePassword("hunter2");
      const out = capturePayloadForMode(el, "metadata");
      expect(out.value).toBeUndefined();
      expect(out.value_metadata).toBeDefined();
      expect(out.value_metadata!.length).toBe(7);
      expect(JSON.stringify(out)).not.toContain("hunter2");
    });

    it("emits value_metadata for textareas", () => {
      const el = makeTextarea("hello world");
      const out = capturePayloadForMode(el, "metadata");
      expect(out.value).toBeUndefined();
      expect(out.value_metadata!.word_count).toBe(2);
    });

    it("emits value_metadata for selects", () => {
      const el = makeSelect("option-a");
      const out = capturePayloadForMode(el, "metadata");
      expect(out.value).toBeUndefined();
      expect(out.value_metadata).toBeDefined();
    });
  });

  describe("none mode", () => {
    it("returns an empty object", () => {
      const el = makeText("hello");
      expect(capturePayloadForMode(el, "none")).toEqual({});
    });

    it("returns empty for password", () => {
      const el = makePassword("hunter2");
      const out = capturePayloadForMode(el, "none");
      expect(out).toEqual({});
      expect(JSON.stringify(out)).not.toContain("hunter2");
    });
  });

  describe("negative property test (PRIVACY-CRITICAL)", () => {
    // Fixed sensitive strings — not random — so failures are reproducible
    const sensitiveStrings: ReadonlyArray<string> = [
      "hunter2",
      "p@ssw0rd!",
      "4111-1111-1111-1111",
      "123-45-6789",
      "secret-token-abc-xyz",
      "user@example.com",
      "Bearer abc123tokenvalue",
      "\u{1F600}smile-secret",
      "naïve-café-secret",
      "中文密码123",
    ];

    for (const mode of ["metadata", "none"] as const) {
      it(`raw value never appears in serialized payload for mode=${mode}`, () => {
        for (const raw of sensitiveStrings) {
          const text = document.createElement("input");
          text.type = "text";
          text.value = raw;
          const out = capturePayloadForMode(text, mode);
          const serialized = JSON.stringify(out);
          expect(
            serialized,
            `mode=${mode} raw=${raw} serialized=${serialized}`,
          ).not.toContain(raw);
        }
      });

      it(`raw password value never appears in serialized payload for mode=${mode}`, () => {
        for (const raw of sensitiveStrings) {
          const pw = document.createElement("input");
          pw.type = "password";
          pw.value = raw;
          const out = capturePayloadForMode(pw, mode);
          const serialized = JSON.stringify(out);
          expect(
            serialized,
            `mode=${mode} raw=${raw} serialized=${serialized}`,
          ).not.toContain(raw);
        }
      });
    }
  });
});

describe("parsePiiMode", () => {
  it("accepts every known mode", () => {
    for (const mode of PII_MODES) {
      const parsed: PiiCaptureMode = parsePiiMode(mode);
      expect(parsed).toBe(mode);
    }
  });

  it("undefined coerces to full", () => {
    expect(parsePiiMode(undefined)).toBe("full");
  });

  it("null coerces to full", () => {
    expect(parsePiiMode(null)).toBe("full");
  });

  it("empty string coerces to full", () => {
    expect(parsePiiMode("")).toBe("full");
  });

  it("unknown string coerces to full", () => {
    expect(parsePiiMode("partial")).toBe("full");
  });

  it("number coerces to full", () => {
    expect(parsePiiMode(42)).toBe("full");
  });

  it("object coerces to full", () => {
    expect(parsePiiMode({ mode: "metadata" })).toBe("full");
  });
});
