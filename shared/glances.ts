// Parser from Glances' REST API (`/api/4/<plugin>`) to `HostMetrics`. Written against
// Glances 4.5.7 responses (see fixtures/glances.json).

import type { HostMetrics } from "./types";

/** Raw JSON of each plugin one reading needs, fetched from `/api/4/<plugin>`. */
export type GlancesResponses = {
  cpu: unknown;
  mem: unknown;
  fs: unknown;
  load: unknown;
  system: unknown;
  uptime: unknown;
  core: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function record(value: unknown, what: string) {
  if (!isRecord(value)) throw new Error(`Glances ${what} is not an object`);
  return value;
}

function num(source: Record<string, unknown>, key: string, what: string) {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Glances ${what}.${key} is not a number`);
  }
  return value;
}

const str = (source: Record<string, unknown>, key: string) => {
  const value = source[key];
  return typeof value === "string" ? value : "";
};

/** `"4 days, 20:57:41"`, `"1 day, 0:00:05"` or `"20:57:41"` to seconds. */
export function parseUptime(text: unknown) {
  const [, days, h, m, s] =
    (typeof text === "string" &&
      text.match(/^(?:(\d+) days?, )?(\d+):(\d{2}):(\d{2})$/)) ||
    [];
  if (h === undefined || m === undefined || s === undefined) {
    throw new Error(`Glances uptime is not understood: ${JSON.stringify(text)}`);
  }
  return Number(days ?? 0) * 86_400 + Number(h) * 3600 + Number(m) * 60 + Number(s);
}

/** The root mount, else the largest one: a container lists only its own bind mounts. */
function pickDisk(fs: unknown) {
  if (!Array.isArray(fs)) throw new Error("Glances fs is not a list");
  const mounts = fs.map((entry) => {
    const mount = record(entry, "fs entry");
    return {
      mount: str(mount, "mnt_point"),
      usedBytes: num(mount, "used", "fs"),
      totalBytes: num(mount, "size", "fs"),
    };
  });
  const disk =
    mounts.find((m) => m.mount === "/") ??
    mounts.reduce<(typeof mounts)[number] | undefined>(
      (largest, m) => (largest && largest.totalBytes >= m.totalBytes ? largest : m),
      undefined,
    );
  if (!disk) throw new Error("Glances fs lists no mounts");
  return disk;
}

/** Throws an `Error` naming the field when Glances' answer is not what we expect. */
export function parseGlances(raw: GlancesResponses): HostMetrics {
  const cpu = record(raw.cpu, "cpu");
  const mem = record(raw.mem, "mem");
  const load = record(raw.load, "load");
  const system = record(raw.system, "system");
  const core = record(raw.core, "core");

  const linux = str(system, "os_name") === "Linux";
  const osVersion = str(system, "os_version");
  return {
    cpuPercent: num(cpu, "total", "cpu"),
    memory: { usedBytes: num(mem, "used", "mem"), totalBytes: num(mem, "total", "mem") },
    disk: pickDisk(raw.fs),
    load: {
      min1: num(load, "min1", "load"),
      min5: num(load, "min5", "load"),
      min15: num(load, "min15", "load"),
    },
    uptimeSeconds: parseUptime(raw.uptime),
    os: linux
      ? str(system, "linux_distro") || "Linux"
      : `${str(system, "os_name")} ${osVersion}`.trim(),
    kernel: linux ? osVersion || null : null,
    hostname: str(system, "hostname"),
    cores: num(core, "log", "core"),
  };
}
