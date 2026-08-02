interface CacheEntry {
  expiresAtMs: number;
  size: number;
  value: Promise<unknown>;
}

export class ReadThroughCache {
  private readonly entries = new Map<string, CacheEntry>();
  private totalSize = 0;

  constructor(
    private readonly options: {
      ttlMs: number;
      maxEntries: number;
      maxSize?: number;
      sizeOf?: (value: unknown) => number;
      now?: () => number;
    }
  ) {}

  private now() {
    return this.options.now?.() ?? Date.now();
  }

  private pruneExpired(nowMs: number) {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAtMs <= nowMs) this.delete(key);
    }
  }

  private delete(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.totalSize = Math.max(0, this.totalSize - entry.size);
    this.entries.delete(key);
  }

  private makeRoom() {
    while (this.entries.size >= this.options.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) return;
      this.delete(oldestKey);
    }
  }

  private pruneToSize() {
    if (this.options.maxSize === undefined) return;
    while (this.totalSize > this.options.maxSize) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) return;
      this.delete(oldestKey);
    }
  }

  async get<T>({
    key,
    load
  }: {
    key: string;
    load: () => Promise<T>;
  }): Promise<T> {
    const nowMs = this.now();
    this.pruneExpired(nowMs);
    const cached = this.entries.get(key);
    if (cached) return cached.value as Promise<T>;

    this.makeRoom();
    const entry: CacheEntry = {
      expiresAtMs: Number.POSITIVE_INFINITY,
      size: 0,
      value: Promise.resolve().then(load)
    };
    this.entries.set(key, entry);

    try {
      const value = await entry.value as T;
      if (this.entries.get(key) === entry) {
        entry.size = Math.max(0, this.options.sizeOf?.(value) ?? 0);
        this.totalSize += entry.size;
        entry.expiresAtMs = this.now() + this.options.ttlMs;
        this.pruneToSize();
      }
      return value;
    } catch (error) {
      if (this.entries.get(key) === entry) this.delete(key);
      throw error;
    }
  }
}
