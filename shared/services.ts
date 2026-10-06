// Datastore services (the postgres, redis... plugins built on Dokku's service template):
// which plugins are service plugins, and `<type>:info` as a `Service`. Nothing parsed here
// keeps a password: the connection string is masked as soon as it is read.

import { isServiceType } from "./grammar";
import { parseReport } from "./parse";
import type { Service, ServiceStatus } from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Hides the password of every `scheme://user:password@host` in `text`, wherever it appears. */
export const maskSecrets = (text: string) =>
  text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]*:)[^\s@/]+@/gi, "$1********@");

/** A connection string with its password hidden; null when it is empty or not a URL with a password. */
export function maskDsn(dsn: string) {
  const masked = maskSecrets(dsn);
  return masked !== dsn ? masked : null;
}

/** An installed plugin that follows the dokku-service template. */
export type ServiceType = { type: string; version: string };

/**
 * The service plugins in `plugin:list --format json`: enabled, not core, and describing
 * themselves as a service plugin (`dokku postgres service plugin`), so a mysql or mongo
 * plugin appears without a code change.
 */
export function parseServiceTypes(stdout: string): ServiceType[] {
  const plugins: unknown = JSON.parse(stdout);
  if (!Array.isArray(plugins)) throw new Error("Expected a JSON array from plugin:list");
  return plugins.flatMap((plugin: unknown): ServiceType[] => {
    if (!isRecord(plugin)) return [];
    const { name, version, enabled, core, description } = plugin;
    return typeof name === "string" &&
      typeof version === "string" &&
      enabled === true &&
      core === false &&
      typeof description === "string" &&
      description.includes("service plugin") &&
      isServiceType(name)
      ? [{ type: name, version }]
      : [];
  });
}

const statuses = {
  running: "running",
  missing: "stopped",
  exited: "stopped",
  created: "stopped",
  dead: "stopped",
} as const satisfies Record<string, ServiceStatus>;

const statusOf = (status: string | undefined): ServiceStatus =>
  Object.entries(statuses).find(([name]) => name === status)?.[1] ?? "unknown";

/** Dokku joins list values with commas, and prints `-` for none. */
const listOf = (value: string | undefined) =>
  (value ?? "").split(/[\s,]+/).filter((word) => word && word !== "-");

/** One `<type>:info --format json` object. */
export function parseServiceInfo(type: string, report: Record<string, string>): Service {
  const name = report.service;
  if (!name) throw new Error(`${type}:info: no service name`);
  return {
    type,
    name,
    status: statusOf(report.status),
    version: report.version ?? "",
    image: report.image ?? "",
    imageVersion: report["image-version"] ?? "",
    apps: listOf(report.links),
    exposedPorts: listOf(report["exposed-ports"]),
    dataDir: report["data-dir"] ?? "",
    configDir: report["config-dir"] ?? "",
    containerId: report.id || null,
    internalIp: report["internal-ip"] || null,
    maskedDsn: maskDsn(report.dsn ?? ""),
    maskedExposedDsn: maskDsn(report["exposed-dsn"] ?? ""),
    backupSchedule: report["backup-schedule"] || null,
  };
}

/**
 * `<type>:info --format json` without a service name: one JSON object per line, one per
 * service. With none, Dokku prints `{"message":"There are no <type> services"}` and exits 0.
 */
export function parseServices(type: string, stdout: string): Service[] {
  return stdout
    .split("\n")
    .filter((line) => line.trim())
    .map(parseReport)
    .filter((report) => report.service !== undefined)
    .map((report) => parseServiceInfo(type, report));
}
