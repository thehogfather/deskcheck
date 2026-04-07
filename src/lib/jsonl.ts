// Pure JSONL helpers for the OPFS-backed event log.
//
// These functions are I/O-free so their edge cases can be exhaustively
// unit-tested without mocking OPFS. The OPFS write path feeds bytes
// produced by `encodeRecord`; the read path reassembles records from a
// file body via `decodeAll`, tolerating a trailing partial line (which
// can happen if the service worker died mid-write).

const NYI = () => {
  throw new Error("jsonl: not yet implemented (Phase 4)");
};

/**
 * Encode a single record as one JSONL line.
 *
 * Returns the line including the trailing `\n`. No record containing a
 * literal newline inside a string field may split across lines — that
 * is guaranteed by `JSON.stringify` always escaping newlines as `\\n`.
 */
export function encodeRecord<T>(_record: T): string {
  NYI();
  return "";
}

/**
 * Decoding result for a JSONL file body, including diagnostic info.
 *
 * `records` are the well-formed parsed objects in the order they
 * appear. `partialTrailingLine` is true when the input did not end
 * with a newline and the decoder skipped a final partial line (the
 * most likely shape of a crash-truncated file). `malformedLines` is
 * the count of lines that could not be JSON-parsed and were skipped.
 */
export interface DecodeResult<T> {
  readonly records: T[];
  readonly partialTrailingLine: boolean;
  readonly malformedLines: number;
}

/**
 * Decode a JSONL body into an array of records.
 *
 * Tolerates an empty input, a missing trailing newline (the last
 * record is considered partial and dropped), embedded `\\n`-escaped
 * newlines inside JSON string fields (must not split), and malformed
 * intermediate lines (skipped with a count). Never throws.
 */
export function decodeAll<T>(_body: string): DecodeResult<T> {
  NYI();
  return { records: [], partialTrailingLine: false, malformedLines: 0 };
}
