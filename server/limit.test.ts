import { describe, expect, test } from "bun:test";
import { createLimiter } from "./limit";

describe("createLimiter", () => {
  test("never runs more than max tasks at once, and runs them all", async () => {
    const limit = createLimiter(3);
    let active = 0;
    let peak = 0;
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        limit(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
          return i;
        }),
      ),
    );
    expect(peak).toBe(3);
    expect(results).toEqual(Array.from({ length: 12 }, (_, i) => i));
  });

  test("a failing task frees its slot and rejects only its own caller", async () => {
    const limit = createLimiter(1);
    const failing = limit(async () => {
      throw new Error("boom");
    });
    const after = limit(async () => "ok");
    await expect(failing).rejects.toThrow("boom");
    expect(await after).toBe("ok");
  });

  test("waiting tasks start in the order they were queued", async () => {
    const limit = createLimiter(1);
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3].map((n) =>
        limit(async () => {
          order.push(n);
        }),
      ),
    );
    expect(order).toEqual([1, 2, 3]);
  });
});
