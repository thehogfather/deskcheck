// In-memory implementation of the subset of the OPFS API that
// OpfsSessionStore uses. Enough to run the contract test suite and the
// OPFS-specific tests (concurrent append ordering, partial-line skip,
// recovery from simulated wake) without a real browser.
//
// This is test infrastructure only. It does not attempt to be a faithful
// double of the whole File System Access API — only the methods the
// store actually calls.

type Entry = FakeFileHandle | FakeDirectoryHandle;

export class FakeFileHandle {
  readonly kind = "file" as const;

  // Public so FakeDirectoryHandle can orchestrate bulk operations.
  bytes: Uint8Array = new Uint8Array(0);

  constructor(public readonly name: string) {}

  async getFile(): Promise<FakeFile> {
    // Return a snapshot — mutations via a writable stream in flight must
    // not retro-change prior getFile() reads.
    return new FakeFile(this.bytes.slice(), this.name);
  }

  async createWritable(
    opts: { keepExistingData?: boolean } = {},
  ): Promise<FakeWritableFileStream> {
    const initial = opts.keepExistingData ? this.bytes.slice() : new Uint8Array(0);
    return new FakeWritableFileStream(this, initial);
  }
}

export class FakeFile {
  constructor(private readonly data: Uint8Array, public readonly name: string) {}

  get size(): number {
    return this.data.length;
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(this.data);
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    const out = new ArrayBuffer(this.data.byteLength);
    new Uint8Array(out).set(this.data);
    return out;
  }

  async bytes(): Promise<Uint8Array> {
    return this.data.slice();
  }
}

export class FakeWritableFileStream {
  private cursor = 0;
  private buffer: Uint8Array;
  private closed = false;

  constructor(
    private readonly handle: FakeFileHandle,
    initial: Uint8Array,
  ) {
    this.buffer = initial;
    this.cursor = initial.length;
  }

  async write(
    data:
      | Uint8Array
      | ArrayBuffer
      | string
      | { type: "write"; position?: number; data: Uint8Array | string },
  ): Promise<void> {
    if (this.closed) throw new TypeError("writer is closed");

    let position = this.cursor;
    let payload: Uint8Array;

    if (typeof data === "string") {
      payload = new TextEncoder().encode(data);
    } else if (data instanceof Uint8Array) {
      payload = data;
    } else if (data instanceof ArrayBuffer) {
      payload = new Uint8Array(data);
    } else if (data && typeof data === "object" && "data" in data) {
      position = data.position ?? this.cursor;
      if (typeof data.data === "string") {
        payload = new TextEncoder().encode(data.data);
      } else {
        payload = data.data;
      }
    } else {
      throw new TypeError("Unsupported write payload");
    }

    const endPos = position + payload.length;
    if (endPos > this.buffer.length) {
      const next = new Uint8Array(endPos);
      next.set(this.buffer, 0);
      this.buffer = next;
    }
    this.buffer.set(payload, position);
    this.cursor = endPos;
  }

  async seek(position: number): Promise<void> {
    if (this.closed) throw new TypeError("writer is closed");
    this.cursor = position;
  }

  async truncate(size: number): Promise<void> {
    if (this.closed) throw new TypeError("writer is closed");
    if (size < this.buffer.length) {
      this.buffer = this.buffer.slice(0, size);
    } else if (size > this.buffer.length) {
      const next = new Uint8Array(size);
      next.set(this.buffer, 0);
      this.buffer = next;
    }
    if (this.cursor > size) this.cursor = size;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.handle.bytes = this.buffer;
  }

  async abort(): Promise<void> {
    this.closed = true;
  }
}

export class FakeDirectoryHandle {
  readonly kind = "directory" as const;
  private readonly entries: Map<string, Entry> = new Map();

  constructor(public readonly name: string = "") {}

  async getDirectoryHandle(
    name: string,
    opts: { create?: boolean } = {},
  ): Promise<FakeDirectoryHandle> {
    const existing = this.entries.get(name);
    if (existing) {
      if (existing.kind !== "directory") {
        throw new TypeError(`${name} exists as a file`);
      }
      return existing;
    }
    if (!opts.create) {
      const err = new Error(`directory ${name} not found`);
      err.name = "NotFoundError";
      throw err;
    }
    const dir = new FakeDirectoryHandle(name);
    this.entries.set(name, dir);
    return dir;
  }

  async getFileHandle(
    name: string,
    opts: { create?: boolean } = {},
  ): Promise<FakeFileHandle> {
    const existing = this.entries.get(name);
    if (existing) {
      if (existing.kind !== "file") {
        throw new TypeError(`${name} exists as a directory`);
      }
      return existing;
    }
    if (!opts.create) {
      const err = new Error(`file ${name} not found`);
      err.name = "NotFoundError";
      throw err;
    }
    const file = new FakeFileHandle(name);
    this.entries.set(name, file);
    return file;
  }

  async removeEntry(
    name: string,
    opts: { recursive?: boolean } = {},
  ): Promise<void> {
    const existing = this.entries.get(name);
    if (!existing) {
      const err = new Error(`entry ${name} not found`);
      err.name = "NotFoundError";
      throw err;
    }
    if (existing.kind === "directory" && !opts.recursive) {
      // Only fail if non-empty, matching the real API.
      const entryMap = (existing as FakeDirectoryHandle).entries;
      if (entryMap.size > 0) {
        throw new TypeError(
          `directory ${name} not empty (use {recursive: true})`,
        );
      }
    }
    this.entries.delete(name);
  }

  async *keys(): AsyncIterableIterator<string> {
    for (const name of this.entries.keys()) yield name;
  }

  async *values(): AsyncIterableIterator<Entry> {
    for (const entry of this.entries.values()) yield entry;
  }

  async *entriesAsync(): AsyncIterableIterator<[string, Entry]> {
    for (const [name, entry] of this.entries.entries()) yield [name, entry];
  }
}

/**
 * Create a fresh fake OPFS root for a test.
 *
 * Pass `root.get` as the `getRoot` dependency of `OpfsSessionStore` in a
 * test setup: `new OpfsSessionStore({ getRoot: root.get, storage: ... })`.
 */
export function createFakeOpfsRoot(): {
  root: FakeDirectoryHandle;
  get: () => Promise<FakeDirectoryHandle>;
} {
  const root = new FakeDirectoryHandle("");
  return {
    root,
    get: async () => root,
  };
}

/**
 * In-memory double of the subset of `chrome.storage.local` the store uses.
 */
export function createFakeChromeStorage(): {
  state: Map<string, unknown>;
  facade: {
    get: (keys: string | string[] | null) => Promise<Record<string, unknown>>;
    set: (items: Record<string, unknown>) => Promise<void>;
    remove: (keys: string | string[]) => Promise<void>;
  };
} {
  const state = new Map<string, unknown>();
  return {
    state,
    facade: {
      get: async (keys) => {
        if (keys === null) {
          return Object.fromEntries(state);
        }
        const ks = Array.isArray(keys) ? keys : [keys];
        const out: Record<string, unknown> = {};
        for (const k of ks) {
          if (state.has(k)) out[k] = state.get(k);
        }
        return out;
      },
      set: async (items) => {
        for (const [k, v] of Object.entries(items)) state.set(k, v);
      },
      remove: async (keys) => {
        const ks = Array.isArray(keys) ? keys : [keys];
        for (const k of ks) state.delete(k);
      },
    },
  };
}
