// Parsed domain types, shared by the server and the frontend. Components only ever see
// these, never raw Dokku reports.

export type ProcessState = "running" | "starting" | "restarting" | "exited";

export type Process = {
  /** e.g. "web.1" */
  name: string;
  /** e.g. "web" */
  type: string;
  state: ProcessState;
  /** Docker container id, null when no container exists. */
  cid: string | null;
};

export type DeployStep = "fetch" | "build" | "release" | "swap";

export type Deploy = {
  id: string;
  /** Short git revision. */
  rev: string;
  message: string;
  author: string;
  /** ISO timestamp of when the deploy started. */
  at: string;
} & (
  | { status: "succeeded"; durationS: number }
  | { status: "failed"; durationS: number; reason: string }
  | { status: "in-progress"; step: DeployStep }
);

export type AppStatus =
  | { kind: "not-deployed" }
  | { kind: "running" }
  | { kind: "stopped" }
  | { kind: "deploying"; step: DeployStep }
  | { kind: "crashed"; failing: string[] };

/** Dokku reports which builder runs, not which language a buildpack detected. */
export type Build =
  | { type: "dockerfile"; dir: string | null }
  | { type: "buildpack"; language: string | null }
  /** Any other builder (lambda, null...), or none yet for an app that never deployed. */
  | { type: "other"; name: string | null };

export type PortMapping = {
  scheme: string;
  host: number;
  container: number;
};

export type AppNetwork = {
  name: string;
  alias: string | null;
};

/** The git revision Dokku last received for the app. */
export type Revision = {
  sha: string;
  /** ISO timestamp of when Dokku last updated the app's source. */
  updatedAt: string | null;
};

type AppCommon = {
  name: string;
  status: AppStatus;
  build: Build;
  proxyEnabled: boolean;
  /** vhosts set on the app (empty when the proxy is disabled or none are set). */
  domains: string[];
  /** Null until the app has received code. */
  revision: Revision | null;
};

/** One row of the apps overview; everything here comes straight from Dokku reports. */
export type AppSummary = AppCommon & {
  processCount: number;
};

/** Full app detail as Dokku reports it. */
export type AppDetail = AppCommon & {
  processes: Process[];
  restartPolicy: string;
  /** e.g. "nginx"; null when Dokku does not say. */
  proxyType: string | null;
  /** Host-wide default domain; apps get `<app>.<globalDomain>` unless overridden. */
  globalDomain: string;
  ports: PortMapping[];
  networks: AppNetwork[];
};

/**
 * What the mock-backed frontend renders today: Dokku detail plus fields Dokku cannot
 * supply (description, deploy history). Those are not on the real endpoints.
 */
export type App = AppDetail & {
  summary: string;
  lastDeploy: Deploy;
};

export type ConfigVar = {
  key: string;
  /** Mock values only. */
  value: string;
};

/** One log line as streamed by `GET /api/apps/:name/logs` (SSE event `log`). */
export type LogEvent = {
  /** ISO timestamp from Docker; the receive time for lines that carry none. */
  ts: string;
  /** e.g. "web.1"; empty for lines that carry no prefix. */
  process: string;
  /** The line itself, ANSI codes stripped. */
  line: string;
};

/** What ends a log stream (SSE events `end` and `failed`); the stream sends nothing after. */
export type LogEndEvent = { kind: "exited" } | { kind: "failed"; message: string };

/** A log event as the viewer holds it. */
export type LogLine = LogEvent & { id: string };

export type Metric = {
  used: number;
  total: number;
  unit: "%" | "GB";
  /** Recent samples, oldest first, as a percentage of total. */
  series: number[];
};

export type HostStats = {
  hostname: string;
  ip: string;
  dokkuVersion: string;
  os: string;
  docker: string;
  cores: number;
  memoryGb: number;
  diskGb: number;
  uptimeDays: number;
  cpu: Metric;
  memory: Metric;
  disk: Metric;
};

/** One reading of the host from Glances. Bytes are raw; percentages are derived by callers. */
export type HostMetrics = {
  cpuPercent: number;
  memory: { usedBytes: number; totalBytes: number };
  /** The root filesystem, or the largest mount when Glances does not list `/`. */
  disk: { mount: string; usedBytes: number; totalBytes: number };
  /** Load averages over 1, 5 and 15 minutes. */
  load: { min1: number; min5: number; min15: number };
  uptimeSeconds: number;
  os: string;
  /** Null when the host is not Linux (Glances only reports a kernel there). */
  kernel: string | null;
  hostname: string;
  cores: number;
};

/** Recent samples as parallel arrays, oldest first; percentages are of total. */
export type HostMetricsHistory = {
  /** Sample times, epoch ms. */
  at: number[];
  cpu: number[];
  memory: number[];
  disk: number[];
};

/**
 * What `GET /api/host/metrics` carries besides `ok: true`. `unreachable` keeps the last
 * good reading and the history (both empty/null if Glances never answered).
 */
export type HostMetricsBody =
  | { status: "not-configured"; metrics: null }
  | {
      status: "ok";
      metrics: HostMetrics;
      /** ISO time of `metrics`. */
      sampledAt: string;
      history: HostMetricsHistory;
    }
  | {
      status: "unreachable";
      metrics: HostMetrics | null;
      /** ISO time of the last good `metrics`, if any. */
      sampledAt: string | null;
      error: string;
      history: HostMetricsHistory;
    };

export type Network = {
  name: string;
  driver: string;
  subnet: string;
  members: { app: string; alias: string | null }[];
};

export type Activity = {
  id: string;
  /** ISO timestamp */
  at: string;
} & (
  | { kind: "deploy"; app: string; rev: string; ok: boolean }
  | { kind: "restart"; app: string; reason: string }
  | { kind: "stop"; app: string }
  | { kind: "backup"; ok: boolean; sizeMb: number; durationS: number }
);

export type BackupStatus = {
  schedule: string;
  tool: string;
  target: string;
  retention: { daily: number; weekly: number; monthly: number };
  lastRun: {
    at: string;
    ok: boolean;
    sizeMb: number;
    durationS: number;
    snapshot: string;
  };
  nextRunAt: string;
};
