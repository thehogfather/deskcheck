// OpfsSessionStore — SessionStore implementation backed by the Origin
// Private File System.
//
// This is the only module in the codebase that touches
// `navigator.storage.getDirectory()`. All append/read operations go through
// the async `FileSystemFileHandle.createWritable()` /
// `FileSystemFileHandle.getFile()` path — NOT `FileSystemSyncAccessHandle`,
// which is `[Exposed=DedicatedWorker]` per the WHATWG FS spec and is not
// available in an MV3 service worker.
//
// A module-private promise chain (`writeChain`) serialises writes against
// the events file so concurrent `appendEvent` callers cannot interleave
// bytes. Every public method awaits `ensureReady()` before doing anything
// else; after a service-worker wake, `ensureReady()` re-acquires the
// directory handle from the session id stored in `chrome.storage.local`.
//
// Storage layout:
//
//   /sessions/<session.id>/events.jsonl
//   /sessions/<session.id>/screenshots/<id>.png
//
// `chrome.storage.local[STORAGE_SESSION]` holds only the SessionMetadata
// blob — no events, no screenshots. See
// `docs/plans/feature-5/selected-plan.md` for the full design.

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
import { encodeRecord, decodeAll } from "./jsonl";
import { STORAGE_SESSION } from "../constants";
import { parsePiiMode } from "./pii-modes";

const SESSIONS_DIR = "sessions";
const EVENTS_FILE = "events.jsonl";
const SCREENSHOTS_DIR = "screenshots";
const SCREENSHOT_EXT = ".png";

/**
 * Structural view of the subset of `FileSystemDirectoryHandle` the store
 * actually uses. Declared here (rather than using the global DOM type)
 * so the test helper `FakeDirectoryHandle` can satisfy it without
 * implementing unused methods like `resolve` or `isSameEntry`.
 */
export interface OpfsDirectoryHandleLike {
  readonly kind: "directory";
  readonly name: string;
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

function defaultGetRoot(): Promise<OpfsDirectoryHandleLike> {
  // navigator.storage.getDirectory() exists in MV3 service workers per
  // the File System Access API. Cast is structural: the returned
  // handle has the shape we declared above plus the DOM-level extras
  // (`resolve`, `isSameEntry`) we do not use.
  return (navigator.storage.getDirectory() as unknown) as Promise<OpfsDirectoryHandleLike>;
}

const defaultStorage = {
  get: async (keys: string | string[] | null) => {
    return (await chrome.storage.local.get(keys)) as Record<string, unknown>;
  },
  set: async (items: Record<string, unknown>) => {
    await chrome.storage.local.set(items);
  },
  remove: async (keys: string | string[]) => {
    await chrome.storage.local.remove(keys);
  },
};

export class OpfsSessionStore implements SessionStore {
  private readonly getRoot: () => Promise<OpfsDirectoryHandleLike>;
  private readonly storage: NonNullable<OpfsSessionStoreDeps["storage"]>;

  private metadata: SessionMetadata | null = null;
  private sessionDir: OpfsDirectoryHandleLike | null = null;
  private eventsFile: OpfsFileHandleLike | null = null;
  private screenshotsDir: OpfsDirectoryHandleLike | null = null;
  private nextSeq = 1;
  private eventsFileSize = 0;

  // Serialises writes against the events file so concurrent
  // appendEvent callers cannot interleave bytes. Any write that
  // rejects is caught so a single failure does not poison the chain.
  private writeChain: Promise<void> = Promise.resolve();

  // Singleton readiness promise so concurrent callers share the same
  // ensureReady work on wake.
  private readyPromise: Promise<SessionMetadata | null> | null = null;

  constructor(deps: OpfsSessionStoreDeps = {}) {
    this.getRoot = deps.getRoot ?? defaultGetRoot;
    this.storage = deps.storage ?? defaultStorage;
  }

  async createSession(session: SessionMetadata): Promise<SessionMetadata> {
    // Clear any in-memory handles so we don't accidentally keep writing
    // to the previous session's directory.
    this.metadata = null;
    this.sessionDir = null;
    this.eventsFile = null;
    this.screenshotsDir = null;
    this.nextSeq = 1;
    this.eventsFileSize = 0;
    this.writeChain = Promise.resolve();
    this.readyPromise = null;

    const root = await this.getRoot();
    const sessionsRoot = await root.getDirectoryHandle(SESSIONS_DIR, {
      create: true,
    });

    // Wipe any stale session directories from prior recordings. This is
    // the simplest defence against "orphaned session from a crashed
    // previous run" — we do not migrate that data because the roadmap
    // brief lists cross-session migration as an explicit non-goal.
    await this.sweepSessionsDirectory(sessionsRoot);

    const sessionDir = await sessionsRoot.getDirectoryHandle(session.id, {
      create: true,
    });
    const eventsFile = await sessionDir.getFileHandle(EVENTS_FILE, {
      create: true,
    });
    const screenshotsDir = await sessionDir.getDirectoryHandle(
      SCREENSHOTS_DIR,
      { create: true },
    );

    // Truncate the events file in case the getFileHandle{create} path
    // returned a pre-existing file with stale bytes (it shouldn't after
    // the sweep, but be explicit — the cost is a single empty write).
    const writable = await eventsFile.createWritable({ keepExistingData: false });
    if (writable.truncate) {
      await writable.truncate(0);
    }
    await writable.close();

    this.metadata = { ...session };
    this.sessionDir = sessionDir;
    this.eventsFile = eventsFile;
    this.screenshotsDir = screenshotsDir;
    this.nextSeq = 1;
    this.eventsFileSize = 0;

    await this.storage.set({ [STORAGE_SESSION]: this.metadata });
    // Drop any legacy keys from before the OPFS migration so no
    // accidental reader pulls stale events from chrome.storage.
    await this.storage.remove(["deskcheck_events", "deskcheck_screenshots"]);

    return this.metadata;
  }

  async ensureReady(): Promise<SessionMetadata | null> {
    if (this.metadata && this.sessionDir) {
      return { ...this.metadata };
    }
    if (!this.readyPromise) {
      this.readyPromise = this.doEnsureReady().finally(() => {
        // Allow a subsequent ensureReady() after this one settles to
        // retry if it returned null (no session present yet).
        if (!this.metadata) this.readyPromise = null;
      });
    }
    return this.readyPromise;
  }

  private async doEnsureReady(): Promise<SessionMetadata | null> {
    const stored = await this.storage.get(STORAGE_SESSION);
    const raw = stored[STORAGE_SESSION] as SessionMetadata | undefined;
    if (!raw) {
      this.metadata = null;
      this.sessionDir = null;
      this.eventsFile = null;
      this.screenshotsDir = null;
      return null;
    }
    // Legacy compat: earlier sessions may have been written without
    // `pii_mode`. Default to the canonical value via parsePiiMode.
    const session: SessionMetadata = {
      ...raw,
      pii_mode: parsePiiMode(raw.pii_mode),
    };

    const root = await this.getRoot();
    const sessionsRoot = await root.getDirectoryHandle(SESSIONS_DIR, {
      create: true,
    });
    const sessionDir = await sessionsRoot.getDirectoryHandle(session.id, {
      create: true,
    });
    const eventsFile = await sessionDir.getFileHandle(EVENTS_FILE, {
      create: true,
    });
    const screenshotsDir = await sessionDir.getDirectoryHandle(
      SCREENSHOTS_DIR,
      { create: true },
    );

    // Reconstruct nextSeq + eventsFileSize from what is actually on disk.
    const file = await eventsFile.getFile();
    this.eventsFileSize = file.size;
    if (file.size > 0) {
      const body = await file.text();
      const decoded = decodeAll<TimelineEvent>(body);
      let maxSeq = 0;
      for (const ev of decoded.records) {
        if (typeof ev.seq === "number" && ev.seq > maxSeq) maxSeq = ev.seq;
      }
      this.nextSeq = maxSeq + 1;
      // If the last line was partially written, the next append must
      // overwrite the corrupt tail. Rewrite the file with just the
      // well-formed records.
      if (decoded.partialTrailingLine || decoded.malformedLines > 0) {
        const clean = decoded.records.map((r) => encodeRecord(r)).join("");
        const w = await eventsFile.createWritable({ keepExistingData: false });
        if (w.truncate) await w.truncate(0);
        if (clean.length > 0) await w.write(clean);
        await w.close();
        this.eventsFileSize = new TextEncoder().encode(clean).length;
      }
    } else {
      this.nextSeq = 1;
    }

    this.metadata = session;
    this.sessionDir = sessionDir;
    this.eventsFile = eventsFile;
    this.screenshotsDir = screenshotsDir;
    return { ...session };
  }

  async getSession(): Promise<SessionMetadata | null> {
    const ready = await this.ensureReady();
    return ready ? { ...ready } : null;
  }

  async updateSession(
    patch: Partial<SessionMetadata>,
  ): Promise<SessionMetadata | null> {
    const current = await this.ensureReady();
    if (!current || !this.metadata) return null;
    this.metadata = { ...this.metadata, ...patch };
    await this.storage.set({ [STORAGE_SESSION]: this.metadata });
    return { ...this.metadata };
  }

  appendEvent(event: TimelineEventInput): Promise<TimelineEvent> {
    // Serialise all appends through writeChain. Each append takes its
    // seq number atomically under the chain so even a pile of
    // concurrent callers produces a strictly monotonic sequence.
    const task = this.writeChain.then(async () => {
      await this.ensureReady();
      if (!this.eventsFile) {
        throw new Error(
          "OpfsSessionStore.appendEvent: no active session (call createSession or ensureReady first)",
        );
      }
      const seq = this.nextSeq++;
      // seq comes first to match the exporter's historical field
      // ordering (existing tests/fixtures pin it). Serialised output
      // must remain stable even though JSON itself is unordered.
      const enriched = { seq, ...(event as object) } as TimelineEvent;
      const line = encodeRecord(enriched);
      const bytes = new TextEncoder().encode(line);

      const writable = await this.eventsFile.createWritable({
        keepExistingData: true,
      });
      try {
        // Write at the current end of file — createWritable starts at
        // position 0, so use an explicit position-based write to append.
        await writable.write({
          type: "write",
          position: this.eventsFileSize,
          data: bytes,
        });
      } finally {
        await writable.close();
      }
      this.eventsFileSize += bytes.length;
      return enriched;
    });
    this.writeChain = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  async *readEvents(): AsyncIterable<TimelineEvent> {
    await this.ensureReady();
    if (!this.eventsFile) return;
    const file = await this.eventsFile.getFile();
    const body = await file.text();
    const decoded = decodeAll<TimelineEvent>(body);
    for (const ev of decoded.records) yield ev;
  }

  async readEventsArray(): Promise<TimelineEvent[]> {
    const out: TimelineEvent[] = [];
    for await (const ev of this.readEvents()) out.push(ev);
    return out;
  }

  async countEvents(): Promise<number> {
    // Reading the file and counting lines keeps the count consistent
    // with the on-disk truth. For the current test sizes this is O(n)
    // in the number of events, which is the same order the fake does.
    const arr = await this.readEventsArray();
    return arr.length;
  }

  async appendScreenshot(id: string, bytes: Uint8Array): Promise<void> {
    await this.ensureReady();
    if (!this.screenshotsDir) {
      throw new Error(
        "OpfsSessionStore.appendScreenshot: no active session",
      );
    }
    const handle = await this.screenshotsDir.getFileHandle(id + SCREENSHOT_EXT, {
      create: true,
    });
    const writable = await handle.createWritable({ keepExistingData: false });
    try {
      if (writable.truncate) await writable.truncate(0);
      await writable.write(bytes);
    } finally {
      await writable.close();
    }
  }

  async readScreenshot(id: string): Promise<Uint8Array | null> {
    await this.ensureReady();
    if (!this.screenshotsDir) return null;
    try {
      const handle = await this.screenshotsDir.getFileHandle(
        id + SCREENSHOT_EXT,
      );
      const file = await handle.getFile();
      const buf = await file.arrayBuffer();
      return new Uint8Array(buf);
    } catch (e) {
      if (isNotFoundError(e)) return null;
      throw e;
    }
  }

  async *readScreenshots(): AsyncIterable<ScreenshotRecord> {
    await this.ensureReady();
    if (!this.screenshotsDir) return;
    // Collect names first so we can iterate in a stable order without
    // relying on implementation-defined handle iteration semantics.
    const names: string[] = [];
    for await (const entry of this.screenshotsDir.values()) {
      if (entry.kind === "file" && entry.name.endsWith(SCREENSHOT_EXT)) {
        names.push(entry.name);
      }
    }
    names.sort();
    for (const name of names) {
      const id = name.slice(0, -SCREENSHOT_EXT.length);
      const bytes = await this.readScreenshot(id);
      if (bytes) yield { id, bytes };
    }
  }

  async countScreenshots(): Promise<number> {
    await this.ensureReady();
    if (!this.screenshotsDir) return 0;
    let count = 0;
    for await (const entry of this.screenshotsDir.values()) {
      if (entry.kind === "file" && entry.name.endsWith(SCREENSHOT_EXT)) {
        count += 1;
      }
    }
    return count;
  }

  async computeByteSizes(): Promise<StoreByteSizes> {
    await this.ensureReady();
    if (!this.eventsFile || !this.screenshotsDir) {
      return { events: 0, screenshots: 0 };
    }
    const eventsFileObj = await this.eventsFile.getFile();
    let screenshots = 0;
    for await (const entry of this.screenshotsDir.values()) {
      if (entry.kind === "file" && entry.name.endsWith(SCREENSHOT_EXT)) {
        const f = await (entry as OpfsFileHandleLike).getFile();
        screenshots += f.size;
      }
    }
    return { events: eventsFileObj.size, screenshots };
  }

  async deleteSession(): Promise<void> {
    // Nothing to delete? Still clear any stored metadata just in case.
    const stored = await this.storage.get(STORAGE_SESSION);
    const raw = stored[STORAGE_SESSION] as SessionMetadata | undefined;

    if (raw) {
      try {
        const root = await this.getRoot();
        const sessionsRoot = await root.getDirectoryHandle(SESSIONS_DIR, {
          create: true,
        });
        try {
          await sessionsRoot.removeEntry(raw.id, { recursive: true });
        } catch (e) {
          if (!isNotFoundError(e)) throw e;
        }
      } catch {
        // OPFS unavailable or already gone — proceed with metadata cleanup.
      }
    }

    await this.storage.remove([
      STORAGE_SESSION,
      "deskcheck_events",
      "deskcheck_screenshots",
    ]);

    this.metadata = null;
    this.sessionDir = null;
    this.eventsFile = null;
    this.screenshotsDir = null;
    this.nextSeq = 1;
    this.eventsFileSize = 0;
    this.writeChain = Promise.resolve();
    this.readyPromise = null;
  }

  /**
   * Remove every existing entry under `/sessions/` before creating a
   * new session directory. Called at session start so stale trees
   * from a prior crashed session do not linger on disk and so
   * computeByteSizes on startup is never inflated by orphans.
   */
  private async sweepSessionsDirectory(
    sessionsRoot: OpfsDirectoryHandleLike,
  ): Promise<void> {
    const names: string[] = [];
    for await (const entry of sessionsRoot.values()) {
      names.push(entry.name);
    }
    for (const name of names) {
      try {
        await sessionsRoot.removeEntry(name, { recursive: true });
      } catch (e) {
        if (!isNotFoundError(e)) throw e;
      }
    }
  }
}

function isNotFoundError(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "name" in e &&
    (e as { name: string }).name === "NotFoundError"
  );
}
