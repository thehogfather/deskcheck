// FakeSessionStore — in-memory SessionStore implementation for tests.
//
// This is the executable spec for the SessionStore interface. The
// contract test suite runs against both this fake and the real
// OpfsSessionStore to prove the spec is consistent across
// implementations. The fake has no external dependencies (no OPFS, no
// chrome.storage), which is exactly what makes it useful: tests for
// downstream code (exporter, metrics) can use it without any mocking.

import type {
  SessionMetadata,
  TimelineEvent,
  TimelineEventInput,
} from "../types";
import type {
  ScreenshotRecord,
  SessionStore,
  StoreByteSizes,
} from "./session-store-types";
import { encodeRecord } from "./jsonl";

export class FakeSessionStore implements SessionStore {
  private metadata: SessionMetadata | null = null;
  private events: TimelineEvent[] = [];
  // Preserve insertion order; Map iteration follows insertion order in JS.
  private screenshots: Map<string, Uint8Array> = new Map();
  private nextSeq = 1;
  // Serialises concurrent appendEvent calls so seq is monotonic even when
  // callers issue them in parallel — mirrors the OPFS impl's writeChain.
  private writeChain: Promise<void> = Promise.resolve();

  async createSession(session: SessionMetadata): Promise<SessionMetadata> {
    // Wipe any prior state — callers get a fresh slate per session.
    this.events = [];
    this.screenshots = new Map();
    this.nextSeq = 1;
    this.writeChain = Promise.resolve();
    this.metadata = { ...session };
    return this.metadata;
  }

  async ensureReady(): Promise<SessionMetadata | null> {
    return this.metadata;
  }

  async getSession(): Promise<SessionMetadata | null> {
    return this.metadata ? { ...this.metadata } : null;
  }

  async updateSession(
    patch: Partial<SessionMetadata>,
  ): Promise<SessionMetadata | null> {
    if (!this.metadata) return null;
    this.metadata = { ...this.metadata, ...patch };
    return { ...this.metadata };
  }

  appendEvent(event: TimelineEventInput): Promise<TimelineEvent> {
    // Serialise through writeChain. Each append waits for the prior
    // append's seq assignment before taking its own — so even parallel
    // callers observe a strict monotonic sequence.
    const task = this.writeChain.then(async () => {
      const seq = this.nextSeq++;
      // seq comes first to match the exporter's historical field
      // ordering (existing tests/fixtures pin it). JSON itself is
      // unordered, but the serialised output must remain stable.
      const enriched = { seq, ...(event as object) } as TimelineEvent;
      this.events.push(enriched);
      return enriched;
    });
    // The outer chain must continue regardless of the inner result,
    // otherwise a failed append would poison all subsequent writes.
    this.writeChain = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  async *readEvents(): AsyncIterable<TimelineEvent> {
    // Snapshot the current events array so iteration is stable even if
    // new appends arrive during iteration (the same stability invariant
    // the OPFS impl provides by reading a File snapshot).
    const snapshot = this.events.slice();
    for (const ev of snapshot) yield ev;
  }

  async readEventsArray(): Promise<TimelineEvent[]> {
    return this.events.slice();
  }

  async countEvents(): Promise<number> {
    return this.events.length;
  }

  async appendScreenshot(id: string, bytes: Uint8Array): Promise<void> {
    // Copy defensively so the caller's buffer reuse cannot mutate our
    // stored bytes — mirrors the durability guarantee of persisting
    // bytes to OPFS.
    this.screenshots.set(id, bytes.slice());
  }

  async readScreenshot(id: string): Promise<Uint8Array | null> {
    const bytes = this.screenshots.get(id);
    return bytes ? bytes.slice() : null;
  }

  async *readScreenshots(): AsyncIterable<ScreenshotRecord> {
    for (const [id, bytes] of this.screenshots) {
      yield { id, bytes: bytes.slice() };
    }
  }

  async countScreenshots(): Promise<number> {
    return this.screenshots.size;
  }

  async computeByteSizes(): Promise<StoreByteSizes> {
    // Events size mirrors the JSONL byte length on disk: the sum of
    // encoded record bytes. `encodeRecord` always emits UTF-8-safe
    // ASCII JSON here (no non-ASCII in our test fixtures), so string
    // `.length` matches byte length; in production the OPFS impl uses
    // the file's byte length directly.
    let eventsSize = 0;
    for (const ev of this.events) eventsSize += encodeRecord(ev).length;

    let screenshotsSize = 0;
    for (const bytes of this.screenshots.values()) {
      screenshotsSize += bytes.length;
    }

    return { events: eventsSize, screenshots: screenshotsSize };
  }

  async deleteSession(): Promise<void> {
    this.metadata = null;
    this.events = [];
    this.screenshots = new Map();
    this.nextSeq = 1;
    this.writeChain = Promise.resolve();
  }
}
