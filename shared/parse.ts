// Parsers from Dokku's flat `--format json` report maps (and raw log lines) to domain types.
// The server runs them on what it gets from the host; the mock client runs them on fixtures.

import type {
  AppDetail,
  AppNetwork,
  AppStatus,
  AppSummary,
  Build,
  LogEvent,
  PortMapping,
  Process,
  ProcessState,
  Revision,
} from "./types";

export type Report = Record<string, string>;

/** Parses one `--format json` report object; throws if it is not a flat object. */
export function parseReport(json: string): Report {
  const value: unknown = JSON.parse(json);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected a JSON object report");
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => [key, typeof v === "string" ? v : String(v)]),
  );
}

const words = (value: string | undefined) => (value ?? "").split(" ").filter(Boolean);

const processStates = [
  "running",
  "starting",
  "restarting",
  "exited",
] as const satisfies readonly ProcessState[];

/** `status-web.1: "running (CID: 69378ad2c9a)"` entries become Process records. */
export function parseProcesses(ps: Report): Process[] {
  return Object.entries(ps).flatMap(([key, value]) => {
    if (!key.startsWith("status-")) return [];
    const name = key.slice("status-".length);
    const [, word, cid] = value.match(/^(\w+) \(CID: (\w+)\)$/) ?? [];
    // Anything Docker reports that we do not model (dead, paused...) reads as exited.
    const state = processStates.find((s) => s === word) ?? "exited";
    return [{ name, type: name.split(".")[0] ?? name, state, cid: cid ?? null }];
  });
}

/** `domains:report`: vhosts only count while the app-level switch is on. */
export function parseDomains(report: Report) {
  const enabled = report["app-enabled"] === "true";
  return {
    domains: enabled ? words(report["app-vhosts"]) : [],
    globalDomain: words(report["global-vhosts"])[0] ?? "",
  };
}

/**
 * `ports:report` map entries look like `http:80:5000`. Without an explicit map (`ports:set`)
 * Dokku uses the one it detected at deploy (the Dockerfile's EXPOSE), reported separately.
 * `detectedApplies` is false while nothing is deployed or no proxy publishes the ports.
 */
export function parsePorts(report: Report, detectedApplies: boolean): PortMapping[] {
  const map = words(report["ports-map"]);
  const entries =
    map.length > 0 || !detectedApplies ? map : words(report["ports-map-detected"]);
  return entries.flatMap((entry) => {
    const [scheme, host, container] = entry.split(":");
    const h = Number(host);
    const c = Number(container);
    return scheme && Number.isInteger(h) && Number.isInteger(c)
      ? [{ scheme, host: h, container: c }]
      : [];
  });
}

export const parseProxyEnabled = (report: Report) => report["proxy-enabled"] === "true";

/** `proxy:report` type, e.g. "nginx"; empty when Dokku does not say. */
export const parseProxyType = (report: Report) => report["computed-type"] || null;

/**
 * `builder:report`: the explicitly selected builder wins, else what Dokku detected on
 * the last deploy (empty before the first one).
 */
export function parseBuild(report: Report): Build {
  const name = report["computed-selected"] || report.detected || null;
  switch (name) {
    case "dockerfile":
      return { type: "dockerfile", dir: report["computed-build-dir"] || null };
    case "herokuish":
    case "pack":
      return { type: "buildpack", language: null };
    default:
      return { type: "other", name };
  }
}

/** `network:report`: every network the app attaches to, without duplicates. */
export function parseNetworks(report: Report): AppNetwork[] {
  const names = [
    ...words(report["computed-initial-network"]),
    ...words(report["computed-attach-post-create"]),
    ...words(report["computed-attach-post-deploy"]),
  ];
  return [...new Set(names)].map((name) => ({ name, alias: null }));
}

const isSha = (value: string | undefined): value is string =>
  value !== undefined && /^[0-9a-f]{7,64}$/.test(value);

/**
 * Whether `GIT_REV` is worth asking for: `git:report` has no sha but does have a
 * `last-updated-at`, which is what an app deployed by `git push` looks like (sha "HEAD").
 */
export const needsGitRev = (report: Report) =>
  !isSha(report.sha) && Boolean(report["last-updated-at"]);

/**
 * `git:report`: apps that never received code report sha "HEAD" and no timestamp. Apps
 * deployed by `git push` also report "HEAD" (no git dir is kept); their commit is the
 * `GIT_REV` config value, passed as `gitRev`, used only when the report has no sha.
 */
export function parseRevision(report: Report, gitRev?: string): Revision | null {
  const sha = isSha(report.sha) ? report.sha : gitRev?.trim();
  if (!isSha(sha)) return null;
  const seconds = Number(report["last-updated-at"]);
  return {
    sha,
    updatedAt:
      report["last-updated-at"] && Number.isFinite(seconds)
        ? new Date(seconds * 1000).toISOString()
        : null,
  };
}

/** Collapse process state into the single status shown in the UI. */
export function deriveStatus(ps: Report, processes: Process[]): AppStatus {
  if (ps.deployed !== "true") return { kind: "not-deployed" };
  const failing = processes.filter((p) => p.state === "restarting").map((p) => p.name);
  if (failing.length > 0) return { kind: "crashed", failing };
  return ps.running === "true" ? { kind: "running" } : { kind: "stopped" };
}

/** The reports behind an overview row; one `--format json` object each. */
export type SummaryReports = {
  ps: Report;
  domains: Report;
  proxy: Report;
  builder: Report;
  git: Report;
  /** The app's `GIT_REV` config value, when `needsGitRev(git)` and it could be read. */
  gitRev?: string;
};

export type DetailReports = SummaryReports & { ports: Report; network: Report };

export function parseAppSummary(name: string, r: SummaryReports): AppSummary {
  const processes = parseProcesses(r.ps);
  return {
    name,
    status: deriveStatus(r.ps, processes),
    build: parseBuild(r.builder),
    proxyEnabled: parseProxyEnabled(r.proxy),
    domains: parseDomains(r.domains).domains,
    revision: parseRevision(r.git, r.gitRev),
    processCount: processes.length,
  };
}

export function parseAppDetail(name: string, r: DetailReports): AppDetail {
  const processes = parseProcesses(r.ps);
  const status = deriveStatus(r.ps, processes);
  const proxyEnabled = parseProxyEnabled(r.proxy);
  return {
    name,
    status,
    build: parseBuild(r.builder),
    proxyEnabled,
    ...parseDomains(r.domains),
    revision: parseRevision(r.git, r.gitRev),
    processes,
    restartPolicy: r.ps["computed-restart-policy"] ?? "no",
    proxyType: parseProxyType(r.proxy),
    ports: parsePorts(r.ports, status.kind !== "not-deployed" && proxyEnabled),
    networks: parseNetworks(r.network),
  };
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC is the point
const ansi = /\u001b\[[0-9;]*[A-Za-z]/g;

/** Drops colour/cursor codes and the pty's trailing carriage return from one output line. */
export const stripAnsi = (raw: string) => raw.replace(ansi, "").replace(/\r$/, "");

/**
 * One raw `dokku logs` line: `<ESC>[36m2026-10-05T21:13:59.305Z app[web.1]:<ESC>[0m message`
 * (the colour codes wrap the prefix). A line without that prefix, such as a blank or
 * wrapped one, is kept whole with `now` as its time and no process.
 */
export function parseLogEvent(raw: string, now = new Date()): LogEvent {
  const text = stripAnsi(raw);
  const match = text.match(/^(\S+) app\[([^\]]+)\]: ?(.*)$/);
  const [, ts, process, line] = match ?? [];
  if (ts && process && line !== undefined && !Number.isNaN(Date.parse(ts))) {
    return { ts, process, line };
  }
  return { ts: now.toISOString(), process: "", line: text };
}
