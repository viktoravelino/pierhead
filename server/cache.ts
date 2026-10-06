/** Default lifetime of a cached read; keeps polling tabs from multiplying SSH calls. */
export const defaultCacheTtlMs = 5_000;

/** Lifetime of the host page's Dokku read: plugins, keys and global settings rarely change. */
export const hostCacheTtlMs = 60_000;

/** Reads `PIERHEAD_CACHE_TTL_MS`: milliseconds, `0` turns the cache off. Throws on garbage. */
export function loadCacheTtl(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.PIERHEAD_CACHE_TTL_MS?.trim();
  if (!raw) return defaultCacheTtlMs;
  const ttlMs = Number(raw);
  if (!Number.isInteger(ttlMs) || ttlMs < 0) {
    throw new Error(`PIERHEAD_CACHE_TTL_MS must be a non-negative integer, got "${raw}"`);
  }
  return ttlMs;
}

type Entry = { value: Promise<unknown>; expiresAt: number };

/**
 * In-memory read cache for one process. Concurrent `get`s of a key share one in-flight
 * load, and a loaded value lives `ttlMs` from when it settled. `now` is injectable for tests.
 */
export function createReadCache(ttlMs: number, now: () => number = Date.now) {
  const entries = new Map<string, Entry>();

  return {
    /**
     * The cached value for `key`, else `load()`. A value `keep` rejects (a failed Dokku
     * call, by default nothing) is shared with callers already waiting but not remembered.
     */
    get<T>(
      key: string,
      load: () => Promise<T>,
      keep: (value: T) => boolean = () => true,
    ) {
      if (ttlMs === 0) return load();
      const hit = entries.get(key);
      if (hit && hit.expiresAt > now()) return hit.value as Promise<T>;

      // In flight until settled, so the entry never expires under its waiters.
      const entry: Entry = { value: load(), expiresAt: Number.POSITIVE_INFINITY };
      entries.set(key, entry);
      const settle = (stored: boolean) => {
        // An `invalidate` during the load removed or replaced the entry; leave that alone.
        if (entries.get(key) !== entry) return;
        if (stored) entry.expiresAt = now() + ttlMs;
        else entries.delete(key);
      };
      entry.value.then(
        (value) => settle(keep(value as T)),
        () => settle(false),
      );
      return entry.value as Promise<T>;
    },

    /** Forgets these keys, finished or still loading. */
    invalidate(...keys: string[]) {
      for (const key of keys) entries.delete(key);
    },
  };
}

export type ReadCache = ReturnType<typeof createReadCache>;

/** Cache keys of the read endpoints. */
export const cacheKeys = {
  list: "apps",
  networks: "networks",
  host: "host",
  app: (name: string) => `app:${name}`,
  config: (name: string) => `config:${name}`,
};

/**
 * Drops what a change to `name` can alter: its detail, its config names, the list and the
 * networks (which are derived from every app's report).
 */
export function invalidateApp(cache: ReadCache, name: string) {
  cache.invalidate(
    cacheKeys.list,
    cacheKeys.networks,
    cacheKeys.app(name),
    cacheKeys.config(name),
  );
}

/** Drops the networks read, which an operation on a network (no app) changes. */
export const invalidateNetworks = (cache: ReadCache) =>
  cache.invalidate(cacheKeys.networks);
