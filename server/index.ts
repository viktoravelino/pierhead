import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  configValueProblem,
  isConfigKey,
  isManagedKey,
  parseConfigKeys,
  parseConfigSetBody,
  parseConfigValue,
} from "../shared/config";
import { isAppName, isProcessType } from "../shared/grammar";
import {
  appOf,
  commandSteps,
  conflictsOnNoOp,
  destructiveConfirm,
  invalidationOf,
  isOperationId,
  type OperationOutputEvent,
  type OperationRequest,
  parseOperation,
  streamsOutput,
  targetOf,
} from "../shared/operations";
import { parseDokkuVersion, parseLogEvent, stripAnsi } from "../shared/parse";
import type { LogEndEvent, OperationRecord, PierheadConfig } from "../shared/types";
import { mergeActivity } from "./activity";
import {
  getApp,
  getBuilds,
  isNotFound,
  listApps,
  listNetworks,
  listStorageUsers,
} from "./apps";
import {
  buildsCacheTtlMs,
  cacheKeys,
  createReadCache,
  hostCacheTtlMs,
  invalidateApp,
  invalidateNetworks,
  loadCacheTtl,
} from "./cache";
import {
  createDokku,
  type DokkuError,
  isBuildId,
  loadDokkuConfig,
  logTail,
} from "./dokku";
import { readDokkuHost } from "./host";
import { createHostMetrics, loadGlancesUrl } from "./metrics";
import {
  afterSuccess,
  failureRefusal,
  preflight,
  restoreToSave,
  runSteps,
  settleRename,
  streamSteps,
} from "./operations";
import { createStateStore, loadStateDir } from "./state";
import { loadStaticDir, serveUi } from "./static";
import { loadWriteGate } from "./writes";

// Fails fast with a readable message when the SSH env is missing or malformed.
const config = loadDokkuConfig();
const dokku = createDokku(config);
const writeGate = loadWriteGate();
// Shared by list, detail and config-name reads; every change below invalidates its app.
const cacheTtlMs = loadCacheTtl();
const readCache = createReadCache(cacheTtlMs);
// The host page's Dokku read lives longer than the app reads; PIERHEAD_CACHE_TTL_MS=0 still turns it off.
const hostCache = createReadCache(cacheTtlMs === 0 ? 0 : hostCacheTtlMs);
// Build records change only when something deploys, which every pierhead operation
// invalidates; the long lifetime keeps the activity feed's poll from asking every app each time.
const buildsCache = createReadCache(cacheTtlMs === 0 ? 0 : buildsCacheTtlMs);
const hostMetrics = createHostMetrics(loadGlancesUrl());
// The activity log and what a proxy-disabled app had; in memory when the directory is unusable.
const stateDir = loadStateDir();
const state = createStateStore(stateDir);
console.log(
  state.persistent
    ? `state dir=${stateDir}`
    : `state dir=${stateDir} unusable, activity and proxy restore state are kept in memory`,
);

// Comment-line pings keep idle log streams under Bun's idle timeout and expose dead clients.
const heartbeatMs = 15_000;

const invalid = (kind: string, message: string) =>
  ({ ok: false, error: { kind, message } }) as const;

/** Longest reason the activity log keeps; Dokku's own messages can run long. */
const maxMessage = 200;

/**
 * Who sent a request: the `X-Pierhead-User` a proxy in front sets once it has
 * authenticated someone. Null when absent; trimmed, with control and format characters
 * (newlines, bidi overrides, zero-width) dropped.
 */
const actorOf = (c: Context) =>
  c.req
    .header("x-pierhead-user")
    ?.replace(/[\p{Cc}\p{Cf}]/gu, "")
    .trim()
    .slice(0, 100) || null;

/** One attempt at an operation, for the log line and the activity record. */
type Attempt = {
  op: string;
  app: string | null;
  /** The app, else the network; `-` when the body never parsed. */
  target: string;
  actor: string | null;
  startedAt: number;
  /** Rename and clone: the name they make. */
  newName?: string;
};

/**
 * One stdout line per operation attempt, including the ones refused before Dokku ran,
 * and the same attempt appended to the activity log. `reason` follows the outcome in
 * parens on the line; `message` (default: the reason) is what the log keeps. Neither may
 * carry a config value.
 */
function logOperation(
  { op, app, target, actor, startedAt, newName }: Attempt,
  outcome: OperationRecord["outcome"],
  reason = "",
  message = reason,
) {
  const durationMs = Date.now() - startedAt;
  const shown = reason ? `${outcome} (${reason})` : outcome;
  console.log(`operation op=${op} app=${target} outcome=${shown} in ${durationMs}ms`);
  state.record({
    at: new Date(startedAt).toISOString(),
    op,
    app,
    target,
    actor,
    outcome,
    durationMs,
    message: message.slice(0, maxMessage),
    ...(newName === undefined ? {} : { newName }),
  });
}

/** The app of a body that was never parsed, for the log only: null unless it is a valid name. */
const loggedApp = (body: unknown) =>
  typeof body === "object" &&
  body !== null &&
  "app" in body &&
  typeof body.app === "string" &&
  isAppName(body.app)
    ? body.app
    : null;

/** Drops what a change to `app` can alter: its reads, and its build records, which a deploy adds to. */
const invalidateAppReads = (app: string) => {
  invalidateApp(readCache, app);
  buildsCache.invalidate(cacheKeys.builds(app));
};

/**
 * Drops what a request changed from the read cache: its apps (a rename touches two), the
 * networks for a network operation, or for the global settings the host read and every
 * app's, since their defaults derive from it.
 */
const invalidateFor = (req: OperationRequest) => {
  const change = invalidationOf(req);
  switch (change.kind) {
    case "apps":
      for (const name of change.apps) invalidateAppReads(name);
      return;
    case "networks":
      invalidateNetworks(readCache);
      return;
    case "host":
      hostCache.invalidate(cacheKeys.host);
      readCache.clear();
      return;
  }
};

/**
 * One stdout line per config change attempt: app, key and outcome, never the value, and
 * the same in the activity log. (There is no request logger, and none may be added for
 * the config routes.)
 */
const logConfig = (
  c: Context,
  app: string,
  key: string,
  action: "set" | "unset",
  outcome: string,
  startedAt?: number,
  /** Whether the change restarted the app (a Dokku build record follows); only known once it ran. */
  restart?: boolean,
) => {
  const took = startedAt === undefined ? "" : ` in ${Date.now() - startedAt}ms`;
  console.log(`config app=${app} key=${key} action=${action} outcome=${outcome}${took}`);
  const [kind = "", ...rest] = outcome.split(" ");
  const reason = rest.join(" ");
  state.record({
    at: new Date(startedAt ?? Date.now()).toISOString(),
    op: `config:${action}`,
    app,
    target: app,
    actor: actorOf(c),
    outcome: kind === "ok" ? "ok" : kind === "refused" ? "refused" : "failed",
    durationMs: startedAt === undefined ? 0 : Date.now() - startedAt,
    message: `${key}${reason ? ` ${reason}` : ""}`.slice(0, maxMessage),
    ...(restart === undefined ? {} : { restart }),
  });
};

/**
 * Dokku exits 0 for actions that did nothing (start on a running app, any action on a
 * never-deployed one) and says so on a ` !     App <name> ...` line; that message, if
 * any. Other ` !` lines are warnings from actions that did run (a failed healthcheck
 * probe, a container found not running), not conflicts.
 */
const dokkuNoOp = (output: string) =>
  output.match(/^\s*!\s+(App \S+ (?:has not been deployed|already running))\s*$/m)?.[1];

/** Newest lines of one build log the route returns; a log can run to thousands. */
const buildOutputLines = 2000;

const activityLimit = { default: 50, max: 500 } as const;

const configStatus = (error: DokkuError) => (isNotFound(error) ? 404 : 502);

/** A failed config call as an error body, with Dokku's stderr left out (a write's can quote the value). */
const configFailure = (error: DokkuError) =>
  ({
    ok: false,
    error: {
      kind: isNotFound(error) ? "not-found" : error.kind,
      message: isNotFound(error)
        ? "No such app"
        : error.kind === "command"
          ? "Dokku refused the change"
          : error.message,
    },
  }) as const;

const app = new Hono()
  .get("/api/health", async (c) => {
    const result = await dokku("version");
    if (!result.ok) return c.json(result, 502);
    const version = parseDokkuVersion(result.stdout);
    const { status: metrics } = await hostMetrics.snapshot();
    return c.json({
      ok: true,
      dokku: { version, host: config.host },
      writesEnabled: writeGate.enabled,
      // Glances state: "ok", "unreachable" or "not-configured".
      metrics,
    } as const);
  })
  // Latest Glances reading plus the last ~10 minutes; always 200, the status says how fresh.
  .get("/api/host/metrics", async (c) =>
    c.json({ ok: true, ...(await hostMetrics.snapshot()) } as const),
  )
  // Dokku's host settings (cached 60s) beside pierhead's own configuration (read live).
  .get("/api/host", async (c) => {
    const dokkuHost = await hostCache.get(
      cacheKeys.host,
      () => readDokkuHost(dokku),
      (r) => r.ok,
    );
    if (!dokkuHost.ok) return c.json(dokkuHost, 502);
    const { status: metrics } = await hostMetrics.snapshot();
    const pierhead: PierheadConfig = {
      writesEnabled: writeGate.enabled,
      cacheTtlMs,
      metrics,
      ssh: { user: config.user, host: config.host, port: config.port },
    };
    return c.json({ ok: true, dokku: dokkuHost.value, pierhead } as const);
  })
  // Docker networks with the apps Dokku attaches to each; invalidated with the app list.
  .get("/api/networks", async (c) => {
    const result = await readCache.get(
      cacheKeys.networks,
      () => listNetworks(dokku),
      (r) => r.ok,
    );
    if (!result.ok) return c.json(result, 502);
    return c.json({ ok: true, networks: result.value } as const);
  })
  // Every app's storage mounts, for the mount dialog's "already used by" warning.
  .get("/api/storage", async (c) => {
    const result = await readCache.get(
      cacheKeys.storage,
      () => listStorageUsers(dokku),
      (r) => r.ok,
    );
    if (!result.ok) return c.json(result, 502);
    return c.json({ ok: true, apps: result.value } as const);
  })
  .get("/api/apps", async (c) => {
    const result = await readCache.get(
      cacheKeys.list,
      () => listApps(dokku),
      (r) => r.ok,
    );
    if (!result.ok) return c.json(result, 502);
    return c.json({ ok: true, apps: result.value } as const);
  })
  .get("/api/apps/:name", async (c) => {
    const name = c.req.param("name");
    if (!isAppName(name)) {
      const error = {
        kind: "invalid-name",
        message: `Invalid app name: ${name}`,
      } as const;
      return c.json({ ok: false, error } as const, 400);
    }
    const result = await readCache.get(
      cacheKeys.app(name),
      () => getApp(dokku, name),
      (r) => r.ok,
    );
    if (result.ok) {
      // What the app's port map and domains were before pierhead disabled its proxy, if it did.
      const app = { ...result.value, proxyRestore: state.restoreOf(name) };
      return c.json({ ok: true, app } as const);
    }
    return c.json(result, result.error.kind === "not-found" ? 404 : 502);
  })
  // Config var names only (`config:keys`), each flagged when Dokku manages it. Values are
  // read one at a time by the route below.
  .get("/api/apps/:name/config", async (c) => {
    const name = c.req.param("name");
    if (!isAppName(name))
      return c.json(invalid("invalid-name", `Invalid app name: ${name}`), 400);
    const result = await readCache.get(
      cacheKeys.config(name),
      () => dokku("config:keys", name),
      (r) => r.ok,
    );
    if (!result.ok)
      return c.json(configFailure(result.error), configStatus(result.error));
    return c.json({ ok: true, keys: parseConfigKeys(result.stdout) } as const);
  })
  // One value, on explicit request. Never cached and never logged.
  .get("/api/apps/:name/config/:key", async (c) => {
    const name = c.req.param("name");
    if (!isAppName(name))
      return c.json(invalid("invalid-name", `Invalid app name: ${name}`), 400);
    const key = c.req.param("key");
    if (!isConfigKey(key)) {
      return c.json(invalid("invalid-key", `Invalid config key: ${key}`), 400);
    }
    // `config:get` exits 1 with no message for an unset key, so ask for the names first.
    const keys = await dokku("config:keys", name);
    if (!keys.ok) return c.json(configFailure(keys.error), configStatus(keys.error));
    if (!parseConfigKeys(keys.stdout).some((k) => k.key === key)) {
      return c.json(invalid("not-found", `${name} has no variable ${key}`), 404);
    }
    const result = await dokku("config:get", name, key);
    if (!result.ok)
      return c.json(configFailure(result.error), configStatus(result.error));
    c.header("Cache-Control", "no-store");
    return c.json({ ok: true, key, value: parseConfigValue(result.stdout) } as const);
  })
  // Body `{ value, restart }`. Without `restart`, Dokku is told `--no-restart`. Dokku's own
  // failure text is not passed on: its messages can quote the value.
  .put("/api/apps/:name/config/:key", async (c) => {
    const name = c.req.param("name");
    if (!isAppName(name))
      return c.json(invalid("invalid-name", `Invalid app name: ${name}`), 400);
    const key = c.req.param("key");
    if (!isConfigKey(key)) {
      return c.json(invalid("invalid-key", `Invalid config key: ${key}`), 400);
    }
    if (!writeGate.enabled) {
      logConfig(c, name, key, "set", "refused (writes-disabled)");
      return c.json({ ok: false, error: writeGate.error } as const, 403);
    }
    if (isManagedKey(key)) {
      logConfig(c, name, key, "set", "refused (managed-key)");
      return c.json(invalid("managed-key", `${key} is managed by Dokku`), 409);
    }
    const body = parseConfigSetBody(await c.req.json().catch(() => null));
    if (!body) {
      const message = "Body must be { value: string, restart: boolean }";
      return c.json(invalid("invalid-body", message), 400);
    }
    const problem = configValueProblem(body.value);
    if (problem) {
      logConfig(c, name, key, "set", "refused (invalid-value)");
      return c.json(invalid("invalid-value", problem), 400);
    }

    const startedAt = Date.now();
    const result = await dokku("config:set", name, key, body.value, body.restart);
    if (!result.ok) {
      logConfig(c, name, key, "set", `failed (${result.error.kind})`, startedAt);
      return c.json(configFailure(result.error), configStatus(result.error));
    }
    invalidateAppReads(name);
    logConfig(c, name, key, "set", "ok", startedAt, body.restart);
    return c.json({ ok: true, restart: body.restart } as const);
  })
  // `?restart=true` redeploys; anything else passes `--no-restart`. Unsetting a key that
  // is not set succeeds, as it does in Dokku.
  .delete("/api/apps/:name/config/:key", async (c) => {
    const name = c.req.param("name");
    if (!isAppName(name))
      return c.json(invalid("invalid-name", `Invalid app name: ${name}`), 400);
    const key = c.req.param("key");
    if (!isConfigKey(key)) {
      return c.json(invalid("invalid-key", `Invalid config key: ${key}`), 400);
    }
    const restart = c.req.query("restart") === "true";
    if (!writeGate.enabled) {
      logConfig(c, name, key, "unset", "refused (writes-disabled)");
      return c.json({ ok: false, error: writeGate.error } as const, 403);
    }
    if (isManagedKey(key)) {
      logConfig(c, name, key, "unset", "refused (managed-key)");
      return c.json(invalid("managed-key", `${key} is managed by Dokku`), 409);
    }

    const startedAt = Date.now();
    const result = await dokku("config:unset", name, key, restart);
    if (!result.ok) {
      logConfig(c, name, key, "unset", `failed (${result.error.kind})`, startedAt);
      return c.json(configFailure(result.error), configStatus(result.error));
    }
    invalidateAppReads(name);
    logConfig(c, name, key, "unset", "ok", startedAt, restart);
    return c.json({ ok: true, restart } as const);
  })
  // Server-sent events: `log` ({ts, process, line}), then one `end` or `failed`
  // (LogEndEvent). Not named `error`: EventSource uses that for connection failures.
  .get("/api/apps/:name/logs", async (c) => {
    const name = c.req.param("name");
    if (!isAppName(name))
      return c.json(invalid("invalid-name", `Invalid app name: ${name}`), 400);

    const tailParam = c.req.query("tail");
    const tail = tailParam === undefined ? logTail.default : Number(tailParam);
    if (!Number.isInteger(tail) || tail < 1 || tail > logTail.max) {
      const message = `tail must be an integer from 1 to ${logTail.max}`;
      return c.json(invalid("invalid-tail", message), 400);
    }
    const processType = c.req.query("process");
    if (processType !== undefined && !isProcessType(processType)) {
      return c.json(
        invalid("invalid-process", `Invalid process type: ${processType}`),
        400,
      );
    }

    // Unknown apps and an unreachable host are plain JSON errors, before any stream starts.
    const exists = await dokku("ps:report", name);
    if (!exists.ok) {
      return c.json(exists, isNotFound(exists.error) ? 404 : 502);
    }
    const logs = dokku.stream("logs", name, tail, processType);
    if (!logs.ok) return c.json(logs, 502);

    // Closing the tab must end the ssh child, or it tails forever. The client may already
    // be gone (the ps:report above is async, and React remounts effects in dev), in which
    // case Hono's `stream.onAbort` would never fire, so watch the request signal itself.
    const { signal } = c.req.raw;
    if (signal.aborted) logs.kill();
    else signal.addEventListener("abort", logs.kill, { once: true });

    return streamSSE(c, async (stream) => {
      const heartbeat = setInterval(() => void stream.write(": ping\n\n"), heartbeatMs);
      try {
        for await (const raw of logs.lines) {
          await stream.writeSSE({
            event: "log",
            data: JSON.stringify(parseLogEvent(raw)),
          });
        }
        const error = await logs.exit;
        const end: LogEndEvent = error
          ? { kind: "failed", message: error.message }
          : { kind: "exited" };
        await stream.writeSSE({
          event: end.kind === "exited" ? "end" : "failed",
          data: JSON.stringify(end),
        });
      } finally {
        clearInterval(heartbeat);
        logs.kill();
      }
    });
  })
  // Every write the UI makes but config vars (see `shared/operations.ts`). Quick operations
  // answer `{ ok, output }` once Dokku is done. Operations that redeploy (rebuild, a proxy
  // toggle on a deployed app) are server-sent events like the logs route: `output`
  // ({line}) per line, then one `end` or `failed` (LogEndEvent). They keep running if the
  // client goes away, since killing a deploy half way is worse than letting it finish.
  .post("/api/operations/:op", async (c) => {
    const startedAt = Date.now();
    const op = c.req.param("op");
    if (!isOperationId(op)) {
      return c.json(invalid("invalid-operation", `Unknown operation: ${op}`), 400);
    }
    const body: unknown = await c.req.json().catch(() => null);
    const actor = actorOf(c);
    if (!writeGate.enabled) {
      const app = loggedApp(body);
      logOperation(
        { op, app, target: app ?? "-", actor, startedAt },
        "refused",
        "writes-disabled",
      );
      return c.json({ ok: false, error: writeGate.error } as const, 403);
    }
    const req = parseOperation(op, body);
    if (typeof req === "string") {
      const app = loggedApp(body);
      const attempt = { op, app, target: app ?? "-", actor, startedAt };
      logOperation(attempt, "refused", "invalid-body", req);
      return c.json(invalid("invalid-body", req), 400);
    }

    const target = targetOf(req);
    const attempt: Attempt = {
      op,
      app: appOf(req),
      target,
      actor,
      startedAt,
      ...("newName" in req ? { newName: req.newName } : {}),
    };
    // Before any read of the host: a typo in the name costs nothing.
    const confirm = destructiveConfirm(req);
    if (confirm && confirm.typed !== confirm.expected) {
      logOperation(attempt, "refused", "confirm-mismatch");
      const message = `Type ${confirm.expected} to confirm.`;
      return c.json(invalid("confirm-mismatch", message), 400);
    }

    const checked = await preflight(dokku, req);
    if (!checked.ok) {
      const { status, kind, message } = checked.refusal;
      logOperation(
        attempt,
        status === 502 ? "failed" : "refused",
        kind,
        `${kind}: ${message}`,
      );
      return c.json(invalid(kind, message), status);
    }

    const steps = commandSteps(req);
    const saved = restoreToSave(req, checked.app);

    if (!streamsOutput(req, checked.app)) {
      const result = await runSteps(dokku, steps);
      invalidateFor(req);
      await settleRename(dokku, state, req);
      if (!result.ok) {
        const known = failureRefusal(req, result.error);
        if (known) {
          logOperation(attempt, "refused", known.kind, `${known.kind}: ${known.message}`);
          return c.json(invalid(known.kind, known.message), known.status);
        }
        logOperation(attempt, "failed", result.error.kind, result.error.message);
        return c.json({ ok: false, error: result.error } as const, 502);
      }
      const noOp = conflictsOnNoOp(req) ? dokkuNoOp(result.output) : undefined;
      if (noOp) {
        logOperation(attempt, "refused", `conflict: ${noOp}`);
        return c.json(invalid("conflict", noOp), 409);
      }
      afterSuccess(state, req, saved);
      logOperation(attempt, "ok");
      return c.json({ ok: true, output: result.output } as const);
    }

    return streamSSE(c, async (stream) => {
      // Past an abort the lines are still read (an unread pipe would stall the build).
      const send = (event: string, data: OperationOutputEvent | LogEndEvent) =>
        stream.aborted
          ? Promise.resolve()
          : stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => {});
      const heartbeat = setInterval(() => {
        if (!stream.aborted) stream.write(": ping\n\n").catch(() => {});
      }, heartbeatMs);
      let end: LogEndEvent = { kind: "exited" };
      try {
        const error = await streamSteps(dokku, steps, (line) => send("output", { line }));
        if (error) end = { kind: "failed", message: error.message };
        else afterSuccess(state, req, saved);
      } catch (e) {
        end = { kind: "failed", message: e instanceof Error ? e.message : String(e) };
      } finally {
        // A failed deploy can still have changed the app, so drop the cache either way.
        invalidateFor(req);
        await settleRename(dokku, state, req).catch(() => {});
        clearInterval(heartbeat);
      }
      if (end.kind === "failed") logOperation(attempt, "failed", end.message);
      else logOperation(attempt, "ok");
      await send(end.kind === "exited" ? "end" : "failed", end);
    });
  })
  // The app's Dokku build and deploy records, newest first (cached with the app).
  .get("/api/apps/:name/builds", async (c) => {
    const name = c.req.param("name");
    if (!isAppName(name))
      return c.json(invalid("invalid-name", `Invalid app name: ${name}`), 400);
    const result = await buildsCache.get(
      cacheKeys.builds(name),
      () => getBuilds(dokku, name),
      (r) => r.ok,
    );
    if (!result.ok) {
      return c.json(result, isNotFound(result.error) ? 404 : 502);
    }
    return c.json({ ok: true, builds: result.value } as const);
  })
  // One record's log, newest `buildOutputLines` lines, ANSI stripped. Not cached.
  .get("/api/apps/:name/builds/:id/output", async (c) => {
    const name = c.req.param("name");
    if (!isAppName(name))
      return c.json(invalid("invalid-name", `Invalid app name: ${name}`), 400);
    const id = c.req.param("id");
    if (!isBuildId(id))
      return c.json(invalid("invalid-id", `Invalid build id: ${id}`), 400);
    const result = await dokku("builds:output", name, id);
    if (!result.ok) {
      if (isNotFound(result.error)) return c.json(result, 404);
      // `no such build <id> for app <name>` exits 1.
      if (result.error.message.includes("no such build")) {
        return c.json(invalid("not-found", `${name} has no build ${id}`), 404);
      }
      return c.json(result, 502);
    }
    const all = stripAnsi(result.stdout).split("\n");
    const lines = all.slice(-buildOutputLines);
    return c.json({ ok: true, lines, truncated: all.length > lines.length } as const);
  })
  // Pierhead's recorded operations merged with every app's Dokku build records, newest
  // first. `?app=` narrows both; `?limit=` is 1 to `activityLimit.max` (default 50).
  .get("/api/activity", async (c) => {
    const limitParam = c.req.query("limit");
    const limit = limitParam === undefined ? activityLimit.default : Number(limitParam);
    if (!Number.isInteger(limit) || limit < 1 || limit > activityLimit.max) {
      const message = `limit must be an integer from 1 to ${activityLimit.max}`;
      return c.json(invalid("invalid-limit", message), 400);
    }
    const filter = c.req.query("app");
    if (filter !== undefined && !isAppName(filter)) {
      return c.json(invalid("invalid-name", `Invalid app name: ${filter}`), 400);
    }
    let names = filter === undefined ? [] : [filter];
    if (filter === undefined) {
      const list = await readCache.get(
        cacheKeys.list,
        () => listApps(dokku),
        (r) => r.ok,
      );
      if (!list.ok) return c.json(list, 502);
      names = list.value.map((a) => a.name);
    }
    // One `builds:list` per app, each cached with the app; an app whose read fails is left out.
    const builds = await Promise.all(
      names.map(async (app) => {
        const result = await buildsCache.get(
          cacheKeys.builds(app),
          () => getBuilds(dokku, app),
          (r) => r.ok,
        );
        return { app, records: result.ok ? result.value : [] };
      }),
    );
    const operations = state.recent({ app: filter });
    return c.json({
      ok: true,
      activity: mergeActivity(operations, builds, limit),
    } as const);
  });

// Production serves the built UI from this same process; dev uses Vite's proxy instead.
const staticDir = loadStaticDir();
if (staticDir) serveUi(app, staticDir);

/** Route types for the frontend's typed `hc` client. */
export type AppType = typeof app;

export default {
  port: Number(process.env.PORT ?? 3001),
  fetch: app.fetch,
  // Above the heartbeat, so a quiet log stream is not cut off (Bun's default is 10s), and
  // above the slowest quiet action: start/restart answer only once Dokku is done (~25s).
  idleTimeout: 120,
};
