import { describe, expect, test } from "bun:test";
import { cacheKeys, createReadCache, invalidateApp, loadCacheTtl } from "./cache";

/** A clock the test moves by hand. */
function fakeClock() {
  let time = 1_000;
  return {
    now: () => time,
    advance(ms: number) {
      time += ms;
    },
  };
}

/** A loader that counts its calls and resolves with the call number. */
function countingLoader() {
  let calls = 0;
  return { load: async () => ++calls, calls: () => calls };
}

describe("createReadCache", () => {
  test("serves a value until its TTL has passed", async () => {
    const clock = fakeClock();
    const cache = createReadCache(5_000, clock.now);
    const loader = countingLoader();

    expect(await cache.get("k", loader.load)).toBe(1);
    clock.advance(4_999);
    expect(await cache.get("k", loader.load)).toBe(1);
    clock.advance(1);
    expect(await cache.get("k", loader.load)).toBe(2);
  });

  test("concurrent gets share one load, however slow, and the TTL starts when it settles", async () => {
    const clock = fakeClock();
    const cache = createReadCache(5_000, clock.now);
    let calls = 0;
    let finish: (value: string) => void = () => {};
    const load = () => {
      calls++;
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    };

    const first = cache.get("k", load);
    clock.advance(20_000);
    const second = cache.get("k", load);
    finish("done");
    expect(await Promise.all([first, second])).toEqual(["done", "done"]);
    expect(calls).toBe(1);

    clock.advance(4_999);
    await cache.get("k", load);
    expect(calls).toBe(1);
  });

  test("keys are independent", async () => {
    const cache = createReadCache(5_000);
    const loader = countingLoader();
    await cache.get("a", loader.load);
    await cache.get("b", loader.load);
    expect(loader.calls()).toBe(2);
  });

  test("invalidate drops exactly the named keys", async () => {
    const cache = createReadCache(5_000);
    const loader = countingLoader();
    await cache.get("app:hello", loader.load);
    await cache.get("app:hello-multi", loader.load);

    cache.invalidate("app:hello");
    expect(await cache.get("app:hello", loader.load)).toBe(3);
    expect(await cache.get("app:hello-multi", loader.load)).toBe(2);
  });

  test("a load finishing after an invalidate does not come back as a fresh entry", async () => {
    const cache = createReadCache(5_000);
    let finish: (value: string) => void = () => {};
    const stale = cache.get(
      "k",
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    cache.invalidate("k");
    const fresh = cache.get("k", async () => "fresh");
    finish("stale");

    expect(await stale).toBe("stale");
    expect(await fresh).toBe("fresh");
    expect(await cache.get("k", async () => "reloaded")).toBe("fresh");
  });

  test("values `keep` rejects and thrown loads are not remembered", async () => {
    const cache = createReadCache(5_000);
    let calls = 0;
    const load = async () => ({ ok: ++calls > 1 });
    const keep = (r: { ok: boolean }) => r.ok;

    expect(await cache.get("k", load, keep)).toEqual({ ok: false });
    expect(await cache.get("k", load, keep)).toEqual({ ok: true });
    expect(await cache.get("k", load, keep)).toEqual({ ok: true });
    expect(calls).toBe(2);

    const failing = () => Promise.reject(new Error("boom"));
    await expect(cache.get("x", failing)).rejects.toThrow("boom");
    expect(await cache.get("x", async () => "ok")).toBe("ok");
  });

  test("a TTL of 0 disables caching and coalescing", async () => {
    const cache = createReadCache(0);
    const loader = countingLoader();
    await Promise.all([cache.get("k", loader.load), cache.get("k", loader.load)]);
    expect(loader.calls()).toBe(2);
  });
});

describe("loadCacheTtl", () => {
  test("defaults to 5s, accepts 0 and whole milliseconds", () => {
    expect(loadCacheTtl({})).toBe(5_000);
    expect(loadCacheTtl({ PIERHEAD_CACHE_TTL_MS: "" })).toBe(5_000);
    expect(loadCacheTtl({ PIERHEAD_CACHE_TTL_MS: "0" })).toBe(0);
    expect(loadCacheTtl({ PIERHEAD_CACHE_TTL_MS: "1500" })).toBe(1_500);
  });

  test("rejects anything else", () => {
    for (const value of ["-1", "1.5", "abc"]) {
      expect(() => loadCacheTtl({ PIERHEAD_CACHE_TTL_MS: value })).toThrow(
        "PIERHEAD_CACHE_TTL_MS",
      );
    }
  });
});

describe("invalidateApp", () => {
  test("drops the app's entries, the list and the networks derived from it", async () => {
    const cache = createReadCache(5_000);
    const keys = [
      cacheKeys.list,
      cacheKeys.networks,
      cacheKeys.app("hello"),
      cacheKeys.config("hello"),
      cacheKeys.app("other"),
    ];
    const loaders = keys.map(() => countingLoader());
    for (const [i, key] of keys.entries())
      await cache.get(key, loaders[i]?.load ?? (async () => 0));
    invalidateApp(cache, "hello");
    for (const [i, key] of keys.entries())
      await cache.get(key, loaders[i]?.load ?? (async () => 0));
    expect(loaders.map((l) => l.calls())).toEqual([2, 2, 2, 2, 1]);
  });
});
