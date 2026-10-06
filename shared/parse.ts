// Parsers from Dokku's flat `--format json` report maps (and raw log lines) to domain types.
// The server runs them on what it gets from the host; the mock client runs them on fixtures.

import { networkAttachments, storageNameOf } from "./grammar";
import type {
  AppDetail,
  AppNetwork,
  AppPort,
  AppStatus,
  AppSummary,
  Build,
  BuilderSettings,
  BuildRecord,
  BuildStatus,
  DokkuHost,
  FormationEntry,
  GitSettings,
  LogEvent,
  Network,
  NetworkAttachment,
  Plugin,
  PortMapping,
  Process,
  ProcessState,
  ResourceEntry,
  ResourceKind,
  ResourceValues,
  Revision,
  SshKey,
  StorageMount,
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

/** Network lists: Dokku joins several names with commas, `network:set` takes them space separated. */
const networkNames = (value: string | undefined) =>
  (value ?? "").split(/[\s,]+/).filter(Boolean);

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

/**
 * The ports an app shows: its explicit map, else (when `detectedApplies`) the one Dokku
 * detected at deploy, flagged so the UI does not offer to remove what is not set.
 */
export function portsOf(report: Report, detectedApplies: boolean): AppPort[] {
  const explicit = parsePorts(report, false);
  if (explicit.length > 0 || !detectedApplies) {
    return explicit.map((port) => ({ ...port, detected: false }));
  }
  return parsePorts(report, true).map((port) => ({ ...port, detected: true }));
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
    ...networkNames(report["computed-initial-network"]),
    ...networkNames(report["computed-attach-post-create"]),
    ...networkNames(report["computed-attach-post-deploy"]),
  ];
  return [...new Set(names)].map((name) => ({ name, alias: null }));
}

/** The networks the app itself sets (the report's `computed-*` keys include global defaults). */
export const parseAttachments = (
  report: Report,
): Record<NetworkAttachment, string[]> => ({
  "initial-network": networkNames(report["initial-network"]),
  "attach-post-create": networkNames(report["attach-post-create"]),
  "attach-post-deploy": networkNames(report["attach-post-deploy"]),
});

/** A network as `network:list --format json` describes it, before apps are attached. */
export type NetworkInfo = Omit<Network, "members">;

/** An app's name with its `network:report`, as the all-apps report is zipped with `apps:list`. */
export type AppNetworkReport = { name: string; report: Report };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Parses a `--format json` list command's stdout (empty means no entries) into objects. */
function parseObjectList(stdout: string, command: string) {
  if (!stdout) return [];
  const value: unknown = JSON.parse(stdout);
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new Error(`Expected a JSON array of objects from ${command}`);
  }
  return value;
}

function str(entry: Record<string, unknown>, key: string, command: string) {
  const value = entry[key];
  if (typeof value !== "string")
    throw new Error(`${command}: "${key}" should be a string`);
  return value;
}

function bool(entry: Record<string, unknown>, key: string, command: string) {
  const value = entry[key];
  if (typeof value !== "boolean") {
    throw new Error(`${command}: "${key}" should be a boolean`);
  }
  return value;
}

const buildStatuses = [
  "running",
  "succeeded",
  "failed",
  "canceled",
] as const satisfies readonly BuildStatus[];

/**
 * `builds:list <app> --format json`: `[{ id, kind, source, status, started_at,
 * finished_at, exit_code, ... }]`, newest first, at most the app's retention (20). A
 * record that is still running has no `finished_at` or `exit_code`. Records of a kind
 * this does not know are left out.
 */
export const parseBuilds = (stdout: string): BuildRecord[] =>
  parseObjectList(stdout, "builds:list").flatMap((b) => {
    const kind = b.kind === "build" || b.kind === "deploy" ? b.kind : null;
    if (kind === null) return [];
    const finished = typeof b.finished_at === "string" ? Date.parse(b.finished_at) : NaN;
    const status = str(b, "status", "builds:list");
    return [
      {
        id: str(b, "id", "builds:list"),
        kind,
        source: str(b, "source", "builds:list"),
        status: buildStatuses.find((known) => known === status) ?? "other",
        startedAt: str(b, "started_at", "builds:list"),
        finishedAt: Number.isNaN(finished) ? null : new Date(finished).toISOString(),
        exitCode: typeof b.exit_code === "number" ? b.exit_code : null,
      },
    ];
  });

/** `ps:scale <app> --format json`: `[{ process_type, quantity }]`. */
export const parseFormation = (stdout: string): FormationEntry[] =>
  parseObjectList(stdout, "ps:scale").map((p) => {
    const count = p.quantity;
    if (typeof count !== "number")
      throw new Error('ps:scale: "quantity" should be a number');
    return { type: str(p, "process_type", "ps:scale"), count };
  });

/**
 * `storage:list <app> --format json`: `[{ entry_name, host_path, container_path }]`. Only
 * directories under the storage root get a `name`; Dokku accepts any host path.
 */
export const parseStorage = (stdout: string): StorageMount[] =>
  parseObjectList(stdout, "storage:list").map((m) => {
    const hostPath = str(m, "host_path", "storage:list");
    return {
      hostPath,
      containerPath: str(m, "container_path", "storage:list"),
      name: storageNameOf(hostPath),
    };
  });

const aliasOption = "--network-alias ";

/**
 * `docker-options:report <app> --format json` carries each phase's options as an array
 * (`deploy-list`); the aliases are its `--network-alias <name>` entries, in order.
 */
export function parseAliases(stdout: string): string[] {
  const value: unknown = JSON.parse(stdout);
  const list = isRecord(value) ? value["deploy-list"] : undefined;
  if (!Array.isArray(list) || !list.every((o) => typeof o === "string")) {
    throw new Error('docker-options:report: "deploy-list" should be an array of strings');
  }
  return list.flatMap((option: string) =>
    option.startsWith(aliasOption) ? [option.slice(aliasOption.length).trim()] : [],
  );
}

/** `builder:report` and `builder-dockerfile:report`: what the app itself sets (never the computed values). */
export const parseBuilderSettings = (
  builder: Report,
  dockerfile: Report,
): BuilderSettings => ({
  selected: builder.selected || null,
  buildDir: builder["build-dir"] || null,
  dockerfilePath: dockerfile["dockerfile-path"] || null,
});

/** `git:report`: what the app itself sets, the computed branch and the source image (empty means none). */
export const parseGitSettings = (git: Report): GitSettings => ({
  deployBranch: git["deploy-branch"] || null,
  computedDeployBranch: git["computed-deploy-branch"] || null,
  sourceImage: git["source-image"] || null,
});

const resourceKey = /^([^.]+)\.(limit|reserve)\.(memory|cpu)$/;

/**
 * `resource:report <app> --format json`: keys like `web.limit.memory` and
 * `_default_.reserve.cpu` (the `resource-` prefixed duplicates are ignored). One entry per
 * process type that sets anything, the default first.
 */
export function parseResources(report: Report): ResourceEntry[] {
  const unset: ResourceValues = { memory: null, cpu: null };
  const byType = new Map<string, Record<ResourceKind, ResourceValues>>();
  for (const [key, value] of Object.entries(report)) {
    if (key.startsWith("resource-")) continue;
    const [, type, kind, field] = key.match(resourceKey) ?? [];
    if (!type || !value || (kind !== "limit" && kind !== "reserve")) continue;
    if (field !== "memory" && field !== "cpu") continue;
    const entry = byType.get(type) ?? { limit: unset, reserve: unset };
    byType.set(type, { ...entry, [kind]: { ...entry[kind], [field]: value } });
  }
  return [...byType]
    .map(([type, { limit, reserve }]) => ({
      processType: type === "_default_" ? null : type,
      limit,
      reserve,
    }))
    .sort((a, b) => (a.processType ?? "").localeCompare(b.processType ?? ""));
}

/** `network:list --format json`: `[{ Name, Driver, Scope, DokkuManaged, Internal, ... }]`. */
export const parseNetworkList = (stdout: string): NetworkInfo[] =>
  parseObjectList(stdout, "network:list").map((n) => ({
    name: str(n, "Name", "network:list"),
    driver: str(n, "Driver", "network:list"),
    scope: str(n, "Scope", "network:list"),
    dokkuManaged: bool(n, "DokkuManaged", "network:list"),
    internal: bool(n, "Internal", "network:list"),
  }));

/**
 * Each network with the apps whose `network:report` names it, and through which setting.
 * Apps that set nothing are not listed anywhere: they get Docker's default bridge, which
 * Dokku does not report. A report naming a network `network:list` lacks is dropped.
 */
export const buildNetworks = (
  networks: NetworkInfo[],
  apps: AppNetworkReport[],
): Network[] =>
  networks
    .map((network) => ({
      ...network,
      members: apps.flatMap(({ name, report }) => {
        const via = networkAttachments.filter((setting) =>
          networkNames(report[`computed-${setting}`]).includes(network.name),
        );
        return via.length > 0 ? [{ app: name, via }] : [];
      }),
    }))
    // Networks in use first, then by name; `network:list` order is Docker's.
    .sort((a, b) => b.members.length - a.members.length || a.name.localeCompare(b.name));

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

/** What the detail reads besides the summary's reports: JSON reports, and the raw stdout of the list commands. */
export type DetailReports = SummaryReports & {
  ports: Report;
  network: Report;
  resource: Report;
  builderDockerfile: Report;
  /** `ps:scale --format json` */
  scale: string;
  /** `storage:list --format json` */
  storage: string;
  /** `docker-options:report --format json` */
  dockerOptions: string;
};

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
    ports: portsOf(r.ports, status.kind !== "not-deployed" && proxyEnabled),
    networks: parseNetworks(r.network),
    attachments: parseAttachments(r.network),
    aliases: parseAliases(r.dockerOptions),
    formation: parseFormation(r.scale),
    canScale: r.ps["can-scale"] !== "false",
    builder: parseBuilderSettings(r.builder, r.builderDockerfile),
    git: parseGitSettings(r.git),
    resources: parseResources(r.resource),
    storage: parseStorage(r.storage),
  };
}

/** `dokku version` prints "dokku version 0.38.31". */
export const parseDokkuVersion = (stdout: string) =>
  stdout.replace(/^dokku version\s+/, "");

/** `plugin:list --format json`: `[{ name, version, enabled, core, description, ... }]`. */
export const parsePlugins = (stdout: string): Plugin[] =>
  parseObjectList(stdout, "plugin:list").map((p) => ({
    name: str(p, "name", "plugin:list"),
    version: str(p, "version", "plugin:list"),
    enabled: bool(p, "enabled", "plugin:list"),
    core: bool(p, "core", "plugin:list"),
  }));

/** `ssh-keys:list --format json`; only the name and fingerprint are kept, never the key. */
export const parseSshKeys = (stdout: string): SshKey[] =>
  parseObjectList(stdout, "ssh-keys:list").map((k) => ({
    name: str(k, "name", "ssh-keys:list"),
    fingerprint: str(k, "fingerprint", "ssh-keys:list"),
  }));

/** The raw output of the commands behind the host page; reports are `--global` ones. */
export type HostReads = {
  version: string;
  domains: Report;
  proxy: Report;
  scheduler: Report;
  builder: Report;
  git: Report;
  plugins: string;
  sshKeys: string;
};

export function parseDokkuHost(r: HostReads): DokkuHost {
  return {
    version: parseDokkuVersion(r.version),
    globalDomains:
      r.domains["global-enabled"] === "true" ? words(r.domains["global-vhosts"]) : [],
    proxyType: parseProxyType(r.proxy),
    scheduler: r.scheduler["computed-selected"] || null,
    // Only the global setting: empty means each app's builder is detected at deploy.
    builder: {
      selected: r.builder["global-selected"] || null,
      buildDir: r.builder["global-build-dir"] || null,
    },
    deployBranch: r.git["computed-deploy-branch"] || null,
    plugins: parsePlugins(r.plugins),
    sshKeys: parseSshKeys(r.sshKeys),
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
