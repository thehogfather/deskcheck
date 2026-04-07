// SessionStore port — the persistence boundary for a recording session.
//
// Behind this interface, the production path writes events to OPFS as
// append-only JSONL and screenshots as individual PNG files, while
// chrome.storage.local is reserved for lightweight session metadata only
// (feature-5, docs/plans/feature-5/selected-plan.md).
//
// A FakeSessionStore (in-memory) implements the same interface for tests,
// so the exporter and service worker are testable without any OPFS or
// chrome.storage code paths.

import type { SessionMetadata, TimelineEvent, TimelineEventInput } from "../types";

/**
 * A lightweight view of a stored screenshot as it lives in the store.
 *
 * Screenshots are bytes, not base64 — the producer decodes the captured
 * data URL once and persists raw PNG bytes.
 */
export interface ScreenshotRecord {
  readonly id: string;
  readonly bytes: Uint8Array;
}

/**
 * Byte sizes used by the session size indicator (feature-1).
 *
 * `events` is the size of the JSONL log on disk; `screenshots` is the
 * sum of all screenshot PNG file sizes. They are separate because the
 * widget surfaces both as independent contributors.
 */
export interface StoreByteSizes {
  readonly events: number;
  readonly screenshots: number;
}

/**
 * The persistence boundary for a recording session.
 *
 * All callers (service worker, exporter, metrics) depend on this port,
 * never on OPFS or chrome.storage directly. The OPFS implementation is
 * opaque behind it; swapping in a different backing (IndexedDB, memory)
 * is a one-line constructor change.
 *
 * Method ordering rules:
 * - `createSession` or `ensureReady` must be called before any append.
 * - `appendEvent` calls are serialised by the implementation; callers
 *   may issue concurrent appends without corruption.
 * - `readEvents*` reflects all appends that have already resolved.
 * - `deleteSession` clears all persistent state for the session and
 *   is idempotent.
 */
export interface SessionStore {
  /**
   * Allocate storage for a new session and persist the metadata.
   *
   * Any existing state for a prior session is wiped — a new session
   * starts from an empty slate. Returns the same metadata the caller
   * passed in, unchanged, so the service worker can use the return
   * value directly.
   */
  createSession(session: SessionMetadata): Promise<SessionMetadata>;

  /**
   * Re-acquire storage handles after a service-worker wake.
   *
   * Reads the current session's id from chrome.storage.local and
   * re-opens the OPFS directory for it. Safe to call repeatedly; a
   * no-op if the store is already ready. Resolves to the current
   * metadata, or null if no session is active.
   */
  ensureReady(): Promise<SessionMetadata | null>;

  /**
   * Read the current session metadata from chrome.storage.local.
   *
   * Returns null if no session is active. Does not touch OPFS.
   */
  getSession(): Promise<SessionMetadata | null>;

  /**
   * Update the current session metadata in chrome.storage.local.
   *
   * The given patch is shallow-merged over the existing metadata and
   * persisted. No-op if no session is active.
   */
  updateSession(patch: Partial<SessionMetadata>): Promise<SessionMetadata | null>;

  /**
   * Append one event to the session's JSONL event log.
   *
   * Assigns a monotonically-increasing `seq` starting at 1 and returns
   * the enriched event. Serialised internally so concurrent callers
   * cannot interleave bytes.
   */
  appendEvent(event: TimelineEventInput): Promise<TimelineEvent>;

  /**
   * Iterate all events in append order.
   *
   * Streams from the backing JSONL file without loading the whole log
   * into memory. Must be an async iterable so the exporter can pipe
   * events into the zip writer one at a time.
   */
  readEvents(): AsyncIterable<TimelineEvent>;

  /**
   * Read all events as an array.
   *
   * Convenience for callers that truly need the whole log in memory
   * (e.g., the legacy popup preview, tests). The streaming exporter
   * MUST use `readEvents()` instead.
   */
  readEventsArray(): Promise<TimelineEvent[]>;

  /**
   * Count the number of events appended so far.
   *
   * Feeds the feature-1 live size indicator. Must be an O(1) cached
   * counter on the OPFS implementation, not a file scan.
   */
  countEvents(): Promise<number>;

  /**
   * Persist a screenshot as raw PNG bytes keyed by id.
   *
   * Overwrites any prior bytes at the same id (caller invariant: ids
   * are unique within a session).
   */
  appendScreenshot(id: string, bytes: Uint8Array): Promise<void>;

  /**
   * Read a single screenshot by id.
   *
   * Returns null if no screenshot exists at that id. The streaming
   * exporter fetches screenshots one at a time via this method.
   */
  readScreenshot(id: string): Promise<Uint8Array | null>;

  /**
   * Iterate all screenshots in id order.
   *
   * Streams one at a time so the exporter never holds two screenshots
   * in memory simultaneously.
   */
  readScreenshots(): AsyncIterable<ScreenshotRecord>;

  /**
   * Count the number of screenshots stored.
   *
   * Feeds the feature-1 live size indicator. O(1) on the OPFS impl.
   */
  countScreenshots(): Promise<number>;

  /**
   * Compute byte sizes for events and screenshots separately.
   *
   * Feeds the feature-1 live size indicator. The event size is the
   * on-disk JSONL byte length; the screenshot size is the sum of all
   * screenshot PNG file sizes. Must reflect what is actually in the
   * backing store, not in-memory strings.
   */
  computeByteSizes(): Promise<StoreByteSizes>;

  /**
   * Delete all persistent state for the current session.
   *
   * Removes the OPFS directory for the session, clears the session
   * metadata key from chrome.storage.local, and releases any cached
   * handles. Idempotent — safe to call when no session is active.
   */
  deleteSession(): Promise<void>;
}
