import { describe, expect, test } from "bun:test";
import glances from "../shared/fixtures/glances.json";
import { parseGlances } from "../shared/glances";
import { createRing, loadGlancesUrl, toHistory } from "./metrics";

describe("createRing", () => {
  test("keeps the newest items, oldest first", () => {
    const ring = createRing<number>(3);
    for (const n of [1, 2, 3, 4, 5]) ring.push(n);
    expect(ring.values()).toEqual([3, 4, 5]);
  });
});

describe("toHistory", () => {
  test("splits samples into parallel percentage arrays", () => {
    const metrics = parseGlances(glances);
    const half = {
      ...metrics,
      cpuPercent: 50,
      memory: { usedBytes: 1, totalBytes: 2 },
      disk: { mount: "/", usedBytes: 3, totalBytes: 4 },
    };
    expect(toHistory([{ at: 10, metrics: half }])).toEqual({
      at: [10],
      cpu: [50],
      memory: [50],
      disk: [75],
    });
  });
});

describe("loadGlancesUrl", () => {
  test("unset or empty means not configured", () => {
    expect(loadGlancesUrl({})).toBeUndefined();
    expect(loadGlancesUrl({ GLANCES_URL: " " })).toBeUndefined();
  });

  test("normalises a valid URL and rejects the rest", () => {
    expect(loadGlancesUrl({ GLANCES_URL: "http://glances:61208/" })).toBe(
      "http://glances:61208",
    );
    expect(() => loadGlancesUrl({ GLANCES_URL: "glances:61208" })).toThrow("GLANCES_URL");
  });
});
