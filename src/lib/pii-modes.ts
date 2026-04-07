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
  has_digits: boolean;
  has_emoji: boolean;
  has_special: boolean;
}

export function extractInputMetadata(value: string): InputMetadata {
  const trimmed = value.trim();
  return {
    length: value.length,
    word_count: trimmed === "" ? 0 : trimmed.split(/\s+/).length,
    has_digits: /\d/.test(value),
    has_emoji: /\p{Extended_Pictographic}/u.test(value),
    has_special: /[^\p{L}\p{N}\s]/u.test(value),
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
