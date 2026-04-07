// Pure JSONL helpers for the OPFS-backed event log.
//
// These functions are I/O-free so their edge cases can be exhaustively
// unit-tested without mocking OPFS. The OPFS write path feeds bytes
// produced by `encodeRecord`; the read path reassembles records from a
// file body via `decodeAll`, tolerating a trailing partial line (which
// can happen if the service worker died mid-write).

/**
 * Encode a single record as one JSONL line.
 *
 * Returns the line including the trailing `\n`. No record containing a
 * literal newline inside a string field may split across lines — that
 * is guaranteed by `JSON.stringify` always escaping newlines as `\\n`.
 */
export function encodeRecord<T>(record: T): string {
  return JSON.stringify(record) + "\n";
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
export function decodeAll<T>(body: string): DecodeResult<T> {
  const records: T[] = [];
  let malformedLines = 0;
  let partialTrailingLine = false;

  if (body.length === 0) {
    return { records, partialTrailingLine: false, malformedLines: 0 };
  }

  // Split on raw '\n'. Because JSON.stringify always escapes newlines
  // inside string fields as '\\n', a raw '\n' always terminates a
  // record — there is no need for a character-by-character parser.
  const lines = body.split("\n");

  // If the body ends with '\n', the final element of `lines` is an
  // empty string and there is no partial. Otherwise the final element
  // is the partial fragment, which we drop.
  const lastIsPartial = !body.endsWith("\n");
  const iterEnd = lastIsPartial ? lines.length - 1 : lines.length - 1;

  for (let i = 0; i < iterEnd; i++) {
    const line = lines[i];
    if (line.length === 0) continue;
    try {
      records.push(JSON.parse(line) as T);
    } catch {
      malformedLines += 1;
    }
  }

  if (lastIsPartial) {
    // There is a trailing fragment. If it is empty, it is not really
    // partial (just a stray terminator); otherwise count it.
    if (lines[lines.length - 1].length > 0) {
      partialTrailingLine = true;
    }
  }

  return { records, partialTrailingLine, malformedLines };
}
