// THE SEAM. Every read and action the UI performs goes through this module, and it is the
// only place that knows which data source is active. In "api" mode apps and host info come
// from the backend (./backend); everything else, and everything in "mock" mode, is served
// from fixtures after a small artificial delay. Nothing outside src/api should import
// mock-data.ts.

import { type AppActionId, appActions, commandLine } from "../../shared/actions";
import { type ConfigKey, isManagedKey } from "../../shared/config";
import {
  deriveStatus,
  parseDomains,
  parseLogEvent,
  parsePorts,
  parseProcesses,
  parseProxyEnabled,
  parseProxyType,
} from "../../shared/parse";
import type {
  App,
  AppDetail,
  AppSummary,
  BackupStatus,
  HostStats,
  LogEndEvent,
  LogEvent,
} from "../../shared/types";
import {
  ApiError,
  deleteConfigVar,
  fetchApp,
  fetchApps,
  fetchConfigKeys,
  fetchConfigValue,
  fetchDokku,
  fetchHostMetrics,
  postQuickAction,
  putConfigVar,
  streamLogs,
  streamRebuild,
} from "./backend";
import {
  activity,
  backup,
  type LogProfile,
  networks,
  type RawApp,
  rawApps,
  rawLogLine,
  sampleConfig,
  wave,
} from "./mock-data";

/**
 * "api" reads real Dokku data through the backend; the default, "mock", needs no backend.
 * Set `VITE_DATA_SOURCE=api` (compose does). Components only use this to label what is
 * sample data or to hide sections that have no real source yet.
 */
export const dataSource = import.meta.env.VITE_DATA_SOURCE === "api" ? "api" : "mock";

/** Fields only the mock fixtures can supply; real Dokku data never has them. */
type Sample = Pick<App, "summary" | "lastDeploy">;
export type AppRow = AppSummary & { sample?: Sample };
export type AppView = AppDetail & { sample?: Sample };

/** What the host strip shows. `machine` is null while no source reports it. */
export type HostView = {
  name: string;
  address: string | null;
  dokkuVersion: string;
  machine: Omit<HostStats, "hostname" | "ip" | "dokkuVersion"> | null;
};

const latency = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 280 + Math.random() * 380));

function findRaw(name: string): RawApp {
  const raw = rawApps.find((a) => a.name === name);
  if (!raw) throw new ApiError(404, "not-found", `No app named ${name}`);
  return raw;
}

function toApp(raw: RawApp): AppView {
  const processes = parseProcesses(raw.ps);
  const lastDeploy = raw.deploys[0];
  if (!lastDeploy) throw new Error(`App ${raw.name} has no deploys`);
  return {
    name: raw.name,
    // Dokku has no "deploying" state; only the mock deploy history knows.
    status:
      lastDeploy.status === "in-progress"
        ? { kind: "deploying", step: lastDeploy.step }
        : deriveStatus(raw.ps, processes),
    build: raw.build,
    processes,
    restartPolicy: raw.ps["computed-restart-policy"] ?? "no",
    proxyEnabled: parseProxyEnabled(raw.proxy),
    proxyType: parseProxyType(raw.proxy),
    revision: { sha: lastDeploy.rev, updatedAt: lastDeploy.at },
    ...parseDomains(raw.domains),
    ports: parsePorts(raw.ports, false),
    networks: raw.networks,
    sample: { summary: raw.summary, lastDeploy },
  };
}

const mockHost = async (): Promise<HostView> => {
  await latency();
  const stats: HostStats = {
    hostname: "dokku",
    ip: "192.168.2.13",
    dokkuVersion: "0.38.31",
    os: "Ubuntu 24.04",
    docker: "29.8.2",
    cores: 2,
    memoryGb: 4,
    diskGb: 32,
    uptimeDays: 47,
    cpu: { used: 23, total: 100, unit: "%", series: wave(24, 11, 0.4) },
    memory: { used: 2.6, total: 4, unit: "GB", series: wave(63, 6, 1.2) },
    disk: { used: 14.8, total: 32, unit: "GB", series: wave(46, 1.5, 2) },
  };
  const { hostname, ip, dokkuVersion, ...machine } = stats;
  return { name: hostname, address: ip, dokkuVersion, machine };
};

/** Mock mode shows its sample machine instead; this only keeps the query's type shared. */
const mockHostMetrics = async () =>
  ({ ok: true, status: "not-configured", metrics: null }) as const;

const apiHost = async (): Promise<HostView> => {
  const { host, version } = await fetchDokku();
  return { name: host, address: null, dokkuVersion: version, machine: null };
};

const mockApps = async (): Promise<AppRow[]> => {
  await latency();
  return rawApps.map((raw) => {
    const app = toApp(raw);
    return { ...app, processCount: app.processes.length };
  });
};

const mockApp = async (name: string): Promise<AppView> => {
  await latency();
  return toApp(findRaw(name));
};

export const getHost: () => Promise<HostView> = dataSource === "api" ? apiHost : mockHost;
export const getHostMetrics = dataSource === "api" ? fetchHostMetrics : mockHostMetrics;
export const getApps: () => Promise<AppRow[]> =
  dataSource === "api" ? fetchApps : mockApps;
export const getApp: (name: string) => Promise<AppView> =
  dataSource === "api" ? fetchApp : mockApp;

export async function getDeploys(name: string) {
  await latency();
  return findRaw(name).deploys;
}

/** The fixture's variables for a mock app; real apps have none, so they get a sample set. */
const mockConfig = (app: AppView) =>
  rawApps.find((r) => r.name === app.name)?.config ?? sampleConfig;

/** Variable names only, in "api" mode as read from Dokku; values come from `getConfigValue`. */
export async function getConfig(app: AppView): Promise<ConfigKey[]> {
  if (dataSource === "api") return fetchConfigKeys(app.name);
  await latency();
  return mockConfig(app).map(({ key }) => ({ key, managed: isManagedKey(key) }));
}

/** One variable's value. Fetched only when the user reveals it and never cached. */
export async function getConfigValue(app: AppView, key: string) {
  if (dataSource === "api") return fetchConfigValue(app.name, key);
  await latency();
  const found = mockConfig(app).find((v) => v.key === key);
  if (!found) throw new ApiError(404, "not-found", `No variable named ${key}`);
  return found.value;
}

/** Sets a variable in "api" mode; the mock UI has no write controls, so this just waits. */
export async function setConfigVar(
  app: AppView,
  key: string,
  value: string,
  restart: boolean,
) {
  if (dataSource === "api") return putConfigVar(app.name, key, value, restart);
  await latency();
}

export async function unsetConfigVar(app: AppView, key: string, restart: boolean) {
  if (dataSource === "api") return deleteConfigVar(app.name, key, restart);
  await latency();
}

export async function getNetworks() {
  await latency();
  return networks;
}

export async function getActivity() {
  await latency();
  return activity;
}

export async function getBackup(): Promise<BackupStatus> {
  await latency();
  return backup;
}

/** Real apps have no fixture: sample traffic while running, silence while stopped. */
const logProfile = (app: AppView): LogProfile =>
  rawApps.find((r) => r.name === app.name)?.logProfile ??
  (app.status.kind === "stopped" ? "idle" : "nginx");

/** How a log subscription reports back. `onEnd` is the last call, including for errors. */
export type LogHandlers = {
  /** Oldest first; the first call carries the recent history. */
  onLines: (events: LogEvent[]) => void;
  onEnd: (end: LogEndEvent) => void;
};

const mockLogs = (app: AppView, { onLines, onEnd }: LogHandlers) => {
  const profile = logProfile(app);
  const processName = (i: number) =>
    app.processes[i % app.processes.length]?.name ?? "web.1";
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  latency().then(() => {
    if (stopped) return;
    const now = Date.now();
    onLines(
      Array.from({ length: 60 }, (_, i) =>
        parseLogEvent(
          rawLogLine(profile, processName(i), new Date(now - (60 - i) * 2300)),
        ),
      ),
    );
    if (profile === "idle") return onEnd({ kind: "exited" });
    timer = setInterval(() => {
      const process = processName(Math.floor(Math.random() * 100));
      onLines([parseLogEvent(rawLogLine(profile, process, new Date()))]);
    }, 700);
  });
  return () => {
    stopped = true;
    clearInterval(timer);
  };
};

/**
 * Streams an app's recent log history, then new lines as they arrive (sample traffic in
 * "mock" mode, `dokku logs --tail` over SSE in "api" mode). Returns an unsubscribe; call
 * it to stop, which also ends the remote command.
 */
export const subscribeToLogs: (app: AppView, handlers: LogHandlers) => () => void =
  dataSource === "api" ? (app, handlers) => streamLogs(app.name, handlers) : mockLogs;

/** The last non-empty line of Dokku's output, which says how the command ended. */
const lastLine = (output: string) =>
  output
    .split("\n")
    .map((line) => line.trim())
    .findLast(Boolean);

/**
 * Runs an app action. In "api" mode it executes on the host and resolves once Dokku is
 * done (a rebuild reports each output line to `onOutput` as it goes); it throws an
 * `ApiError` carrying Dokku's message when refused or failed. In "mock" mode it only
 * resolves with the command that would have run. `detail` is a one-line outcome.
 */
export async function runAction(
  action: AppActionId,
  app: string,
  onOutput: (line: string) => void,
): Promise<{ detail?: string }> {
  if (dataSource === "mock") {
    await latency();
    return { detail: commandLine(action, app) };
  }
  if (appActions[action].streams) {
    let last: string | undefined;
    await streamRebuild(app, (line) => {
      last = line.trim() || last;
      onOutput(line);
    });
    return { detail: last };
  }
  return { detail: lastLine(await postQuickAction(app, action)) };
}
