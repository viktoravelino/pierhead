// THE SEAM. Every read and action the UI performs goes through this module, and it is the
// only place that knows which data source is active. In "api" mode apps, host, metrics,
// networks, logs, config, builds, activity and operations go through the backend (./backend);
// backups in "api" mode, like everything in "mock" mode, are served from fixtures
// after a small artificial delay. Nothing outside src/api should import mock-data.ts.

import { type ConfigKey, isManagedKey } from "../../shared/config";
import { commandLine, type OperationRequest } from "../../shared/operations";
import {
  deriveStatus,
  parseDomains,
  parseLogEvent,
  parseProcesses,
  parseProxyEnabled,
  parseProxyType,
  portsOf,
} from "../../shared/parse";
import type {
  Activity,
  App,
  AppDetail,
  AppSummary,
  BackupStatus,
  HostDetails,
  HostStats,
  LogEndEvent,
  LogEvent,
  Network,
  ServiceGroup,
  StorageMount,
} from "../../shared/types";
import {
  ApiError,
  deleteConfigVar,
  fetchActivity,
  fetchApp,
  fetchApps,
  fetchBuildOutput,
  fetchBuilds,
  fetchConfigKeys,
  fetchConfigValue,
  fetchDokku,
  fetchHostDetails,
  fetchHostMetrics,
  fetchNetworks,
  fetchServiceDsn,
  fetchServices,
  fetchStorageUsers,
  postOperation,
  putConfigVar,
  streamLogs,
  streamServiceLogs,
} from "./backend";
import {
  activity,
  backup,
  hostDetails,
  type LogProfile,
  mockDsn,
  mockServiceLog,
  networks,
  type RawApp,
  rawApps,
  rawLogLine,
  sampleConfig,
  serviceGroups,
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
    ports: portsOf(raw.ports, false),
    networks: raw.networks,
    // The mock has no settings to edit; these are what an app with none looks like.
    attachments: {
      "initial-network": [],
      "attach-post-create": [],
      "attach-post-deploy": raw.networks.map((n) => n.name),
    },
    aliases: raw.networks.flatMap((n) => (n.alias ? [n.alias] : [])),
    formation: [...new Set(processes.map((p) => p.type))].map((type) => ({
      type,
      count: processes.filter((p) => p.type === type).length,
    })),
    canScale: true,
    locked: false,
    builder: { selected: null, buildDir: null, dockerfilePath: null },
    git: { deployBranch: null, computedDeployBranch: null, sourceImage: null },
    resources: [],
    storage: [],
    services: serviceGroups.flatMap((g) =>
      g.services
        .filter((svc) => svc.apps.includes(raw.name))
        .map(({ type, name }) => ({ type, name })),
    ),
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

const mockNetworks = async () => {
  await latency();
  return networks;
};

const mockHostDetails = async () => {
  await latency();
  return hostDetails;
};

export const getNetworks: () => Promise<Network[]> =
  dataSource === "api" ? fetchNetworks : mockNetworks;
/** Mounts per app, to warn when a storage directory is shared; the mock has none. */
export const getStorageUsers: () => Promise<{ app: string; mounts: StorageMount[] }[]> =
  dataSource === "api" ? fetchStorageUsers : async () => [];
export const getHostDetails: () => Promise<HostDetails> =
  dataSource === "api" ? fetchHostDetails : mockHostDetails;

const mockServices = async () => {
  await latency();
  return serviceGroups;
};

/** Every installed service plugin with its services (the mock's operations change none of it). */
export const getServices: () => Promise<ServiceGroup[]> =
  dataSource === "api" ? fetchServices : mockServices;

/** A service's connection string. Fetched only when the user reveals it and never cached. */
export async function getServiceDsn(type: string, name: string) {
  if (dataSource === "api") return fetchServiceDsn(type, name);
  await latency();
  return mockDsn(type, name);
}

const mockActivity = async (app?: string) => {
  await latency();
  return app === undefined ? activity : activity.filter((a) => a.app === app);
};

/** Newest-first activity for the host, or for one app (the mock ignores `limit`: it has a dozen rows). */
export const getActivity: (app?: string, limit?: number) => Promise<Activity[]> =
  dataSource === "api" ? fetchActivity : mockActivity;

/** The app's Dokku build and deploy records; "api" mode only (the mock has its own `getDeploys`). */
export const getBuilds = fetchBuilds;

/** One record's log: its newest lines, and whether older ones were left out. */
export const getBuildOutput = fetchBuildOutput;

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

/** Streams a service's recent log, then new lines as they arrive; same contract as `subscribeToLogs`. */
export function subscribeToServiceLogs(
  type: string,
  name: string,
  { onLines, onEnd }: LogHandlers,
) {
  if (dataSource === "api") return streamServiceLogs(type, name, { onLines, onEnd });
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  latency().then(() => {
    if (stopped) return;
    const now = Date.now();
    onLines(
      Array.from({ length: 12 }, (_, i) =>
        parseLogEvent(mockServiceLog(type, name, new Date(now - (12 - i) * 60_000))),
      ),
    );
    timer = setInterval(
      () => onLines([parseLogEvent(mockServiceLog(type, name, new Date()))]),
      4000,
    );
  });
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * Runs an operation. In "api" mode it executes on the host and resolves once Dokku is
 * done (one that redeploys calls `onStream` once the server starts streaming, then reports
 * each output line to `onOutput` as it goes); it throws
 * an `ApiError` carrying Dokku's message when refused or failed. In "mock" mode it only
 * resolves with the command that would have run. `detail` is a one-line outcome.
 */
export async function runOperation(
  req: OperationRequest,
  onOutput: (line: string) => void,
  onStream: () => void,
): Promise<{ detail?: string }> {
  if (dataSource === "mock") {
    await latency();
    return { detail: commandLine(req) };
  }
  return { detail: await postOperation(req, onOutput, onStream) };
}
