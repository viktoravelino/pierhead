import { describe, expect, test } from "bun:test";
import glances from "./fixtures/glances.json";
import { parseGlances, parseUptime } from "./glances";

// The fixture is `GET /api/4/<plugin>` from nicolargo/glances:4.5.7-full, trimmed.

describe("parseGlances", () => {
  test("a real Glances 4 reading", () => {
    expect(parseGlances(glances)).toEqual({
      cpuPercent: glances.cpu.total,
      memory: { usedBytes: glances.mem.used, totalBytes: glances.mem.total },
      // A container lists only bind mounts, so the largest one stands in for `/`.
      disk: {
        mount: "/etc/resolv.conf",
        usedBytes: 19837329408,
        totalBytes: 705448378368,
      },
      load: { min1: 1.55859375, min5: 0.80029296875, min15: 0.66796875 },
      uptimeSeconds: 4 * 86_400 + 20 * 3600 + 58 * 60 + 22,
      os: "Alpine Linux 3.24.2",
      kernel: "7.0.14-orbstack-00380-ga7e0a2dc9535",
      hostname: "fdc5b07d617a",
      cores: 14,
    });
  });

  test("prefers the root mount over a larger one", () => {
    const [first] = glances.fs;
    if (!first) throw new Error("fixture has no mounts");
    const fs = [first, { ...first, mnt_point: "/", size: 100, used: 40 }];
    expect(parseGlances({ ...glances, fs }).disk).toEqual({
      mount: "/",
      usedBytes: 40,
      totalBytes: 100,
    });
  });

  test("names the field when the shape is wrong", () => {
    expect(() => parseGlances({ ...glances, cpu: { total: "n/a" } })).toThrow(
      "Glances cpu.total is not a number",
    );
    expect(() => parseGlances({ ...glances, fs: [] })).toThrow("no mounts");
    expect(() => parseGlances({ ...glances, uptime: "soon" })).toThrow("uptime");
  });
});

describe("parseUptime", () => {
  test("with and without days", () => {
    expect(parseUptime("1 day, 0:00:05")).toBe(86_405);
    expect(parseUptime("12 days, 3:04:05")).toBe(12 * 86_400 + 3 * 3600 + 4 * 60 + 5);
    expect(parseUptime("0:59:59")).toBe(3599);
  });
});
