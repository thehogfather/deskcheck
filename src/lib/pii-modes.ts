// Pure module for PII capture mode policy and metadata extraction.
//
// PRIVACY-CRITICAL: capturePayloadForMode is the ONLY place that reads
// `target.value` for input events. Do not add any other path that reads
// the raw value of an input field into a timeline event payload.

export const PII_MODES = ["full", "metadata", "none"] as const;
export type PiiCaptureMode = (typeof PII_MODES)[number];
export const DEFAULT_PII_MODE: PiiCaptureMode = "full";

export interface InputMetadata {
  length: number;
  word_count: number;
  letter_count: number;
  digit_count: number;
  emoji_count: number;
  whitespace_count: number;
  special_count: number;
}

// Counts visual emoji units (grapheme clusters containing an
// Extended_Pictographic code point). ZWJ sequences like 👨‍💻 and skin-tone
// modifiers collapse to one grapheme, matching what a user would perceive
// as a single emoji — important for letting an engineer reproduce the
// input shape from the metadata alone.
function countEmojiGraphemes(value: string): number {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let count = 0;
  for (const { segment } of segmenter.segment(value)) {
    if (/\p{Extended_Pictographic}/u.test(segment)) count++;
  }
  return count;
}

// Counts code points that carry the Extended_Pictographic property. Used
// to subtract emoji from `special_count` so a single emoji is not
// double-counted as both an emoji and a special character.
function countEmojiCodePoints(value: string): number {
  return (value.match(/\p{Extended_Pictographic}/gu) ?? []).length;
}

export function extractInputMetadata(value: string): InputMetadata {
  const trimmed = value.trim();
  const word_count = trimmed === "" ? 0 : trimmed.split(/\s+/).length;
  const letter_count = (value.match(/\p{L}/gu) ?? []).length;
  const digit_count = (value.match(/\p{N}/gu) ?? []).length;
  const whitespace_count = (value.match(/\s/gu) ?? []).length;
  const emoji_count = countEmojiGraphemes(value);
  // "special" = anything that isn't a letter, digit, whitespace, or part of
  // an emoji. We count non-basic code points, then subtract emoji code
  // points so a single emoji is not also counted as a special character.
  const non_basic_count = (value.match(/[^\p{L}\p{N}\s]/gu) ?? []).length;
  const special_count = Math.max(0, non_basic_count - countEmojiCodePoints(value));
  return {
    length: value.length,
    word_count,
    letter_count,
    digit_count,
    emoji_count,
    whitespace_count,
    special_count,
  };
}

/**
 * PRIVACY-CRITICAL: This is the only place that decides whether the
 * raw value of an input field reaches the timeline. Do not add any
 * other code path that reads target.value into an event payload.
 */
export function capturePayloadForMode(
  target: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  mode: PiiCaptureMode,
): { value?: string; value_metadata?: InputMetadata } {
  if (mode === "none") return {};

  const isPassword =
    target instanceof HTMLInputElement && target.type === "password";
  const rawValue = (target as HTMLInputElement).value ?? "";

  if (mode === "full") {
    return { value: isPassword ? "[password]" : rawValue.slice(0, 200) };
  }

  // metadata
  return { value_metadata: extractInputMetadata(rawValue) };
}

/** Coerce any value (storage, message) to a known mode. Unknown -> "full". */
export function parsePiiMode(value: unknown): PiiCaptureMode {
  return (PII_MODES as readonly string[]).includes(value as string)
    ? (value as PiiCaptureMode)
    : DEFAULT_PII_MODE;
}
