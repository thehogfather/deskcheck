// FakeSessionStore — in-memory SessionStore implementation for tests.
//
// This is the executable spec for the SessionStore interface. The contract
// test suite runs against both this fake and the real OpfsSessionStore to
// prove the spec is consistent across implementations.
//
// Phase 3 scaffolding: all methods throw `NotYetImplementedError`. Phase 4
// fills them in.

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

class NotYetImplementedError extends Error {
  constructor(method: string) {
    super(`FakeSessionStore.${method}: not yet implemented (Phase 4)`);
    this.name = "NotYetImplementedError";
  }
}

export class FakeSessionStore implements SessionStore {
  /**
   * Peak in-memory bytes held by the fake since the last reset.
   *
   * The streaming exporter memory test uses this to assert that the
   * exporter never forces the store to hold the whole session in
   * memory at once. Each append updates a running "currently
   * resident" counter; each read releases it.
   */
  peakResidentBytes = 0;

  createSession(_session: SessionMetadata): Promise<SessionMetadata> {
    throw new NotYetImplementedError("createSession");
  }
  ensureReady(): Promise<SessionMetadata | null> {
    throw new NotYetImplementedError("ensureReady");
  }
  getSession(): Promise<SessionMetadata | null> {
    throw new NotYetImplementedError("getSession");
  }
  updateSession(_patch: Partial<SessionMetadata>): Promise<SessionMetadata | null> {
    throw new NotYetImplementedError("updateSession");
  }
  appendEvent(_event: TimelineEventInput): Promise<TimelineEvent> {
    throw new NotYetImplementedError("appendEvent");
  }
  readEvents(): AsyncIterable<TimelineEvent> {
    throw new NotYetImplementedError("readEvents");
  }
  readEventsArray(): Promise<TimelineEvent[]> {
    throw new NotYetImplementedError("readEventsArray");
  }
  countEvents(): Promise<number> {
    throw new NotYetImplementedError("countEvents");
  }
  appendScreenshot(_id: string, _bytes: Uint8Array): Promise<void> {
    throw new NotYetImplementedError("appendScreenshot");
  }
  readScreenshot(_id: string): Promise<Uint8Array | null> {
    throw new NotYetImplementedError("readScreenshot");
  }
  readScreenshots(): AsyncIterable<ScreenshotRecord> {
    throw new NotYetImplementedError("readScreenshots");
  }
  countScreenshots(): Promise<number> {
    throw new NotYetImplementedError("countScreenshots");
  }
  computeByteSizes(): Promise<StoreByteSizes> {
    throw new NotYetImplementedError("computeByteSizes");
  }
  deleteSession(): Promise<void> {
    throw new NotYetImplementedError("deleteSession");
  }
}
