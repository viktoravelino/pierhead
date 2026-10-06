// Raw mock fixtures. Dokku reports are kept as the flat string maps that
// `dokku <plugin>:report --format json` returns; parse.ts turns them into domain types.
// Everything here is replaced wholesale when a real backend exists.

import type {
  Activity,
  BackupStatus,
  Build,
  ConfigVar,
  Deploy,
  HostDetails,
  Network,
  Plugin,
} from "../../shared/types";

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

/** ISO timestamp `ms` milliseconds before now. */
export const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

type Report = Record<string, string>;

export type LogProfile = "nginx" | "api" | "node" | "crashing" | "idle";

export type RawApp = {
  name: string;
  summary: string;
  build: Build;
  ps: Report;
  domains: Report;
  ports: Report;
  proxy: Report;
  networks: { name: string; alias: string | null }[];
  deploys: Deploy[];
  config: ConfigVar[];
  logProfile: LogProfile;
};

const globalVhosts = "192.168.2.13.sslip.io";

export const rawApps: RawApp[] = [
  {
    name: "insta-down",
    summary: "Frontend for the Instagram downloader, served by nginx.",
    build: { type: "dockerfile", dir: "frontend" },
    ps: {
      deployed: "true",
      running: "true",
      processes: "1",
      "computed-restart-policy": "on-failure:10",
      "status-web.1": "running (CID: 69378ad2c9a)",
    },
    domains: {
      "app-enabled": "true",
      "app-vhosts": "insta-down.192.168.2.13.sslip.io insta-down.vkav.dev",
      "global-vhosts": globalVhosts,
    },
    ports: { "ports-map": "http:80:80" },
    proxy: { "proxy-enabled": "true" },
    networks: [{ name: "insta-down-net", alias: null }],
    deploys: [
      {
        id: "d-1041",
        rev: "e41b7c0",
        message: "Cache hashed assets for a year",
        author: "viktor",
        at: ago(2 * day + 3 * hour),
        status: "succeeded",
        durationS: 48,
      },
      {
        id: "d-1038",
        rev: "9a02f6d",
        message: "Add /healthz route",
        author: "viktor",
        at: ago(6 * day + 40 * minute),
        status: "succeeded",
        durationS: 52,
      },
      {
        id: "d-1036",
        rev: "3c5d1ab",
        message: "Proxy API calls to backend alias",
        author: "viktor",
        at: ago(6 * day + 2 * hour),
        status: "failed",
        durationS: 21,
        reason: 'nginx: [emerg] host not found in upstream "backend"',
      },
      {
        id: "d-1029",
        rev: "b87e204",
        message: "Initial frontend build",
        author: "viktor",
        at: ago(11 * day),
        status: "succeeded",
        durationS: 77,
      },
    ],
    config: [{ key: "GIT_REV", value: "e41b7c0f3a9d2b8c15e6a07d4f8b9c3e2a1d0f67" }],
    logProfile: "nginx",
  },
  {
    name: "insta-down-api",
    summary: "Extraction API behind the frontend. Reachable only on the private network.",
    build: { type: "dockerfile", dir: "backend" },
    ps: {
      deployed: "true",
      running: "true",
      processes: "1",
      "computed-restart-policy": "on-failure:10",
      "status-web.1": "running (CID: 4be1f9d07a2)",
    },
    domains: { "app-enabled": "false", "app-vhosts": "", "global-vhosts": globalVhosts },
    ports: { "ports-map": "http:8000:8000" },
    proxy: { "proxy-enabled": "false" },
    networks: [{ name: "insta-down-net", alias: "backend" }],
    deploys: [
      {
        id: "d-1040",
        rev: "5f8a31e",
        message: "Raise extract timeout to 120s",
        author: "viktor",
        at: ago(2 * day + 4 * hour),
        status: "succeeded",
        durationS: 94,
      },
      {
        id: "d-1037",
        rev: "c0d9e76",
        message: "Per-IP rate limiting",
        author: "viktor",
        at: ago(6 * day + 30 * minute),
        status: "succeeded",
        durationS: 101,
      },
      {
        id: "d-1030",
        rev: "17ab4f2",
        message: "Initial API build",
        author: "viktor",
        at: ago(11 * day + 5 * minute),
        status: "succeeded",
        durationS: 133,
      },
    ],
    config: [
      {
        key: "ALLOWED_ORIGINS",
        value: "https://insta-down.vkav.dev,http://insta-down.192.168.2.13.sslip.io",
      },
      { key: "EXTRACT_TIMEOUT", value: "120" },
      { key: "GIT_REV", value: "5f8a31e92c0d7b4a6e13f58d9c2b7a40e1d3f685" },
      { key: "NO_VHOST", value: "1" },
      { key: "RATE_LIMIT", value: "30/minute" },
    ],
    logProfile: "api",
  },
  {
    name: "signal-flags",
    summary: "Fictional. Feature-flag service, currently shipping a new revision.",
    build: { type: "buildpack", language: "Node.js" },
    ps: {
      deployed: "true",
      running: "true",
      processes: "1",
      "computed-restart-policy": "on-failure:10",
      "status-web.1": "running (CID: 1d70c4e8b35)",
    },
    domains: {
      "app-enabled": "true",
      "app-vhosts": "signal-flags.192.168.2.13.sslip.io",
      "global-vhosts": globalVhosts,
    },
    ports: { "ports-map": "http:80:5000" },
    proxy: { "proxy-enabled": "true" },
    networks: [{ name: "bridge", alias: null }],
    deploys: [
      {
        id: "d-1052",
        rev: "7d21c9f",
        message: "Percentage rollouts per environment",
        author: "viktor",
        at: ago(90_000),
        status: "in-progress",
        step: "build",
      },
      {
        id: "d-1047",
        rev: "0ee48b3",
        message: "Add flag audit trail",
        author: "viktor",
        at: ago(3 * day),
        status: "succeeded",
        durationS: 63,
      },
    ],
    config: [
      { key: "DATABASE_URL", value: "postgres://flags:mock@db.internal:5432/flags" },
      { key: "GIT_REV", value: "0ee48b3d57a1c9e2f60b8a43d7c15e92b0a6f3d8" },
      { key: "NODE_ENV", value: "production" },
    ],
    logProfile: "node",
  },
  {
    name: "ledger-lite",
    summary: "Fictional. Household ledger, stopped between billing cycles.",
    build: { type: "buildpack", language: "Python" },
    ps: {
      deployed: "true",
      running: "false",
      processes: "1",
      "computed-restart-policy": "on-failure:10",
      "status-web.1": "exited (CID: a9c3d2f1e07)",
    },
    domains: {
      "app-enabled": "true",
      "app-vhosts": "ledger-lite.192.168.2.13.sslip.io",
      "global-vhosts": globalVhosts,
    },
    ports: { "ports-map": "http:80:8080" },
    proxy: { "proxy-enabled": "true" },
    networks: [{ name: "bridge", alias: null }],
    deploys: [
      {
        id: "d-0988",
        rev: "2b6f0a8",
        message: "Export statements as CSV",
        author: "viktor",
        at: ago(19 * day),
        status: "succeeded",
        durationS: 71,
      },
    ],
    config: [
      { key: "DJANGO_SETTINGS_MODULE", value: "ledger.settings.prod" },
      { key: "GIT_REV", value: "2b6f0a8e41c7d95b3a0f268d1e7c4b59a3d02f6e" },
      { key: "SECRET_KEY", value: "mock-not-a-real-secret-0000" },
    ],
    logProfile: "idle",
  },
  {
    name: "lighthouse",
    summary: "Fictional. Uptime prober with a web UI and a background worker.",
    build: { type: "buildpack", language: "Go" },
    ps: {
      deployed: "true",
      running: "false",
      processes: "2",
      "computed-restart-policy": "on-failure:10",
      "status-web.1": "running (CID: f20a8b6c149)",
      "status-worker.1": "restarting (CID: 3e5d7a90b2c)",
    },
    domains: {
      "app-enabled": "true",
      "app-vhosts": "lighthouse.192.168.2.13.sslip.io",
      "global-vhosts": globalVhosts,
    },
    ports: { "ports-map": "http:80:3000" },
    proxy: { "proxy-enabled": "true" },
    networks: [{ name: "bridge", alias: null }],
    deploys: [
      {
        id: "d-1049",
        rev: "d4c18e5",
        message: "Probe over IPv6 as well",
        author: "viktor",
        at: ago(5 * hour),
        status: "succeeded",
        durationS: 58,
      },
      {
        id: "d-1044",
        rev: "81f3a9b",
        message: "Store probe history in postgres",
        author: "viktor",
        at: ago(4 * day),
        status: "succeeded",
        durationS: 66,
      },
    ],
    config: [
      { key: "DATABASE_URL", value: "postgres://lighthouse:mock@172.18.0.9:5432/probes" },
      { key: "GIT_REV", value: "d4c18e5a02f7b369c1e8d5a40b2f9e7c61d3a58b" },
      { key: "PROBE_INTERVAL", value: "30s" },
    ],
    logProfile: "crashing",
  },
];

/** Stand-in environment for apps that have no fixture (the real ones in api mode). */
export const sampleConfig: ConfigVar[] = [
  { key: "DATABASE_URL", value: "postgres://app:sample@db.internal:5432/app" },
  { key: "NODE_ENV", value: "production" },
  { key: "PORT", value: "5000" },
  { key: "SECRET_KEY", value: "sample-not-a-real-secret-0000" },
];

export const networks: Network[] = [
  {
    name: "insta-down-net",
    driver: "bridge",
    scope: "local",
    dokkuManaged: true,
    internal: false,
    members: [
      { app: "insta-down", via: ["attach-post-deploy"] },
      { app: "insta-down-api", via: ["initial-network", "attach-post-deploy"] },
    ],
  },
  {
    name: "bridge",
    driver: "bridge",
    scope: "local",
    dokkuManaged: false,
    internal: false,
    members: [
      { app: "signal-flags", via: ["attach-post-create"] },
      { app: "ledger-lite", via: ["attach-post-create"] },
      { app: "lighthouse", via: ["attach-post-create"] },
    ],
  },
  {
    name: "host",
    driver: "host",
    scope: "local",
    dokkuManaged: false,
    internal: false,
    members: [],
  },
];

const corePlugin = (name: string): Plugin => ({
  name,
  version: "0.38.31",
  enabled: true,
  core: true,
});

export const hostDetails: HostDetails = {
  dokku: {
    version: "0.38.31",
    globalDomains: ["192.168.2.13.sslip.io"],
    proxyType: "nginx",
    scheduler: "docker-local",
    builder: { selected: null, buildDir: null },
    deployBranch: "master",
    plugins: [
      ...["apps", "builder-dockerfile", "builder-herokuish", "domains", "network"].map(
        corePlugin,
      ),
      { name: "postgres", version: "1.41.0", enabled: true, core: false },
    ],
    sshKeys: [
      {
        name: "viktor-laptop",
        fingerprint: "SHA256:3q2+7wAfBqrN0Gm9a1lVn2v8mXr0pZQe5h1KJcT4dUo",
      },
      {
        name: "github-deploy",
        fingerprint: "SHA256:Zx0n4pLkYw8eVd1cQ7sRtB2mHfA9oUj6iNg3KyE5PaM",
      },
    ],
  },
  pierhead: {
    writesEnabled: false,
    cacheTtlMs: 5_000,
    metrics: "not-configured",
    ssh: { user: "dokku", host: "192.168.2.13", port: 22 },
  },
};

/** A recorded operation, as the API's activity feed carries it. */
const operation = (id: string, at: string, op: string, app: string): Activity => ({
  kind: "operation",
  id,
  at,
  op,
  app,
  target: app,
  actor: null,
  outcome: "ok",
  durationMs: 24_000,
  message: "",
  builds: [],
});

/** A Dokku build record nobody at pierhead started (a `git push`). */
const pushed = (id: string, at: string, app: string, ok: boolean): Activity => ({
  kind: "build",
  id,
  at,
  app,
  build: {
    id,
    kind: "build",
    source: "git push",
    status: ok ? "succeeded" : "failed",
    startedAt: at,
    finishedAt: at,
    exitCode: ok ? 0 : 1,
  },
});

export const activity: Activity[] = [
  pushed("a-1", ago(90_000), "signal-flags", true),
  operation("a-2", ago(25 * minute), "ps:restart", "lighthouse"),
  operation("a-3", ago(41 * minute), "ps:restart", "lighthouse"),
  pushed("a-4", ago(5 * hour), "lighthouse", true),
  pushed("a-6", ago(2 * day + 3 * hour), "insta-down", true),
  pushed("a-7", ago(2 * day + 4 * hour), "insta-down-api", true),
  pushed("a-9", ago(3 * day), "signal-flags", true),
  pushed("a-11", ago(6 * day + 2 * hour), "insta-down", false),
  operation("a-12", ago(19 * day), "ps:stop", "ledger-lite"),
];

/** Most recent time today or yesterday that the local clock read hh:mm. */
const lastOccurrence = (h: number, m: number) => {
  const t = new Date();
  t.setHours(h, m, 0, 0);
  if (t.getTime() > Date.now()) t.setDate(t.getDate() - 1);
  return t;
};

export const backup: BackupStatus = {
  schedule: "Nightly at 04:45",
  tool: "restic",
  target: "Cloudflare R2",
  retention: { daily: 7, weekly: 4, monthly: 6 },
  lastRun: {
    at: lastOccurrence(4, 45).toISOString(),
    ok: true,
    sizeMb: 212,
    durationS: 38,
    snapshot: "b61f09ac",
  },
  nextRunAt: new Date(lastOccurrence(4, 45).getTime() + day).toISOString(),
};

/** Deterministic wobbly series so the sparklines look alive but never change between renders. */
export const wave = (base: number, amp: number, phase: number, n = 32) =>
  Array.from({ length: n }, (_, i) => {
    const v =
      base + amp * Math.sin(i / 3.1 + phase) + (amp / 2) * Math.sin(i * 1.9 + phase * 2);
    return Math.max(2, Math.min(98, Math.round(v * 10) / 10));
  });

// ---- Log generation -------------------------------------------------------------------

const pick = <T>(items: readonly [T, ...T[]]): T =>
  items[Math.floor(Math.random() * items.length)] ?? items[0];

const clientIp = () =>
  pick(["172.18.0.1", "172.18.0.1", "172.18.0.1", "192.168.2.40", "192.168.2.51"]);

const nginxLine = () => {
  const path = pick([
    "/",
    "/",
    "/assets/index-4f1a9c.js",
    "/assets/index-91c2de.css",
    "/favicon.ico",
    "/healthz",
  ]);
  const status = pick([200, 200, 200, 200, 200, 304, 304, 404]);
  const bytes =
    status === 304 ? 0 : status === 404 ? 153 : pick([608, 1432, 48210, 12988]);
  return `${clientIp()} - - "GET ${path} HTTP/1.1" ${status} ${bytes}`;
};

const apiLine = () =>
  pick([
    `INFO:     172.19.0.2:${40000 + Math.floor(Math.random() * 20000)} - "POST /api/extract HTTP/1.1" 200 OK`,
    `INFO:     172.19.0.2:${40000 + Math.floor(Math.random() * 20000)} - "POST /api/extract HTTP/1.1" 200 OK`,
    `INFO:     172.19.0.2:${40000 + Math.floor(Math.random() * 20000)} - "GET /healthz HTTP/1.1" 200 OK`,
    `WARNING:  rate limit exceeded for 192.168.2.40 (30/minute)`,
    `INFO:     172.19.0.2:${40000 + Math.floor(Math.random() * 20000)} - "POST /api/extract HTTP/1.1" 422 Unprocessable Entity`,
  ]);

const nodeLine = () =>
  pick([
    `GET /api/flags 200 ${3 + Math.floor(Math.random() * 18)}ms`,
    `GET /api/flags 200 ${3 + Math.floor(Math.random() * 18)}ms`,
    `POST /api/evaluate 200 ${5 + Math.floor(Math.random() * 30)}ms`,
    "flag cache refreshed (42 flags)",
  ]);

const crashingLine = (process: string) =>
  process.startsWith("worker")
    ? pick([
        "panic: dial tcp 172.18.0.9:5432: connect: connection refused",
        "goroutine 1 [running]: main.connectStore(0x0)",
        "exit status 2",
        "probe worker starting, interval=30s",
      ])
    : `${clientIp()} - - "GET /status HTTP/1.1" 200 2144`;

/** Raw `<ts> app[<proc>]: <message>` line, in the format `dokku logs` prints. */
export const rawLogLine = (profile: LogProfile, process: string, at: Date) => {
  const message =
    profile === "nginx"
      ? nginxLine()
      : profile === "api"
        ? apiLine()
        : profile === "node"
          ? nodeLine()
          : profile === "crashing"
            ? crashingLine(process)
            : "Received SIGTERM, shutting down gracefully";
  return `${at.toISOString()} app[${process}]: ${message}`;
};
