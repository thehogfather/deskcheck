// OpfsSessionStore — SessionStore implementation backed by the Origin
// Private File System.
//
// This is the only module in the codebase that touches
// `navigator.storage.getDirectory()`. All append/read operations go through
// async `FileSystemFileHandle.createWritable()` /
// `FileSystemFileHandle.getFile()` — NOT `FileSystemSyncAccessHandle`,
// which is `[Exposed=DedicatedWorker]` per the WHATWG FS spec and is not
// available in an MV3 service worker.
//
// A module-private promise chain serialises writes to the events file so
// concurrent `appendEvent` callers cannot interleave bytes. Every public
// method awaits `ensureReady()` before doing anything else; after a
// service-worker wake, `ensureReady()` re-acquires the directory handle
// from the session id stored in `chrome.storage.local`.
//
// Phase 3 scaffolding: all methods throw `NotYetImplementedError`. Phase
// 4 fills them in.

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
    super(`OpfsSessionStore.${method}: not yet implemented (Phase 4)`);
    this.name = "NotYetImplementedError";
  }
}

/**
 * Structural view of the subset of `FileSystemDirectoryHandle` the store
 * actually uses. Declared here (rather than using the global DOM type)
 * so the test helper `FakeDirectoryHandle` can satisfy it without
 * implementing unused methods like `resolve` or `isSameEntry`.
 */
export interface OpfsDirectoryHandleLike {
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<OpfsDirectoryHandleLike>;
  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<OpfsFileHandleLike>;
  removeEntry(
    name: string,
    options?: { recursive?: boolean },
  ): Promise<void>;
  values(): AsyncIterableIterator<OpfsFileHandleLike | OpfsDirectoryHandleLike>;
}

export interface OpfsFileHandleLike {
  readonly kind: "file";
  readonly name: string;
  getFile(): Promise<OpfsFileLike>;
  createWritable(options?: {
    keepExistingData?: boolean;
  }): Promise<OpfsWritableLike>;
}

export interface OpfsFileLike {
  readonly size: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface OpfsWritableLike {
  write(
    data:
      | Uint8Array
      | ArrayBuffer
      | string
      | { type: "write"; position?: number; data: Uint8Array | string },
  ): Promise<void>;
  seek?(position: number): Promise<void>;
  truncate?(size: number): Promise<void>;
  close(): Promise<void>;
}

export interface OpfsSessionStoreDeps {
  /**
   * Root OPFS directory accessor. Defaulted to
   * `navigator.storage.getDirectory()` in production; overridden with a
   * `FakeOpfsRoot` in tests.
   */
  getRoot?: () => Promise<OpfsDirectoryHandleLike>;
  /**
   * chrome.storage.local facade. Defaulted to the real chrome API;
   * overridden with an in-memory double in tests.
   */
  storage?: {
    get: (keys: string | string[] | null) => Promise<Record<string, unknown>>;
    set: (items: Record<string, unknown>) => Promise<void>;
    remove: (keys: string | string[]) => Promise<void>;
  };
}

export class OpfsSessionStore implements SessionStore {
  constructor(_deps: OpfsSessionStoreDeps = {}) {
    // Dependencies captured for Phase 4 implementation.
  }

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
