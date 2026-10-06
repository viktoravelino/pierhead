import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  configValueProblem,
  isConfigKey,
  isManagedKey,
  parseConfigKeys,
  parseConfigSetBody,
  parseConfigValue,
} from "../shared/config";
import { isAppName } from "../shared/grammar";
import {
  commandSteps,
  conflictsOnNoOp,
  destructiveConfirm,
  isOperationId,
  type OperationOutputEvent,
  parseOperation,
  streamsOutput,
} from "../shared/operations";
import { parseDokkuVersion, parseLogEvent } from "../shared/parse";
import type { LogEndEvent, PierheadConfig } from "../shared/types";
import { getApp, isNotFound, listApps, listNetworks } from "./apps";
import {
  cacheKeys,
  createReadCache,
  hostCacheTtlMs,
  invalidateApp,
  loadCacheTtl,
} from "./cache";
import {
  createDokku,
  type DokkuError,
  isProcessType,
  loadDokkuConfig,
  logTail,
} from "./dokku";
import { readDokkuHost } from "./host";
import { createHostMetrics, loadGlancesUrl } from "./metrics";
import {
  afterSuccess,
  preflight,
  proxyRestore,
  restoreToSave,
  runSteps,
  streamSteps,
} from "./operations";
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
const hostMetrics = createHostMetrics(loadGlancesUrl());

// Comment-line pings keep idle log streams under Bun's idle timeout and expose dead clients.
const heartbeatMs = 15_000;

const invalid = (kind: string, message: string) =>
  ({ ok: false, error: { kind, message } }) as const;

/**
 * One stdout line per operation attempt, including the ones refused before Dokku ran:
 * `outcome` is `ok`, `refused` or `failed`, optionally followed by the reason in parens.
 */
const logOperation = (op: string, app: string, outcome: string, startedAt: number) =>
  console.log(
    `operation op=${op} app=${app} outcome=${outcome} in ${Date.now() - startedAt}ms`,
  );

/** The app of a body that was never parsed, for the log only: `-` unless it is a valid name. */
const loggedApp = (body: unknown) =>
  typeof body === "object" && body !== null && "app" in body
    ? typeof body.app === "string" && isAppName(body.app)
      ? body.app
      : "-"
    : "-";

/**
 * One stdout line per config change attempt: app, key and outcome, never the value.
 * (There is no request logger, and none may be added for the config routes.)
 */
const logConfig = (
  app: string,
  key: string,
  action: "set" | "unset",
  outcome: string,
  startedAt?: number,
) => {
  const took = startedAt === undefined ? "" : ` in ${Date.now() - startedAt}ms`;
  console.log(`config app=${app} key=${key} action=${action} outcome=${outcome}${took}`);
};

/**
 * Dokku exits 0 for actions that did nothing (start on a running app, any action on a
 * never-deployed one) and says so on a ` !     App <name> ...` line; that message, if
 * any. Other ` !` lines are warnings from actions that did run (a failed healthcheck
 * probe, a container found not running), not conflicts.
 */
const dokkuNoOp = (output: string) =>
  output.match(/^\s*!\s+(App \S+ (?:has not been deployed|already running))\s*$/m)?.[1];

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
      const app = { ...result.value, proxyRestore: proxyRestore.get(name) };
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
      logConfig(name, key, "set", "refused (writes-disabled)");
      return c.json({ ok: false, error: writeGate.error } as const, 403);
    }
    if (isManagedKey(key)) {
      logConfig(name, key, "set", "refused (managed-key)");
      return c.json(invalid("managed-key", `${key} is managed by Dokku`), 409);
    }
    const body = parseConfigSetBody(await c.req.json().catch(() => null));
    if (!body) {
      const message = "Body must be { value: string, restart: boolean }";
      return c.json(invalid("invalid-body", message), 400);
    }
    const problem = configValueProblem(body.value);
    if (problem) {
      logConfig(name, key, "set", "refused (invalid-value)");
      return c.json(invalid("invalid-value", problem), 400);
    }

    const startedAt = Date.now();
    const result = await dokku("config:set", name, key, body.value, body.restart);
    if (!result.ok) {
      logConfig(name, key, "set", `failed (${result.error.kind})`, startedAt);
      return c.json(configFailure(result.error), configStatus(result.error));
    }
    invalidateApp(readCache, name);
    logConfig(name, key, "set", "ok", startedAt);
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
      logConfig(name, key, "unset", "refused (writes-disabled)");
      return c.json({ ok: false, error: writeGate.error } as const, 403);
    }
    if (isManagedKey(key)) {
      logConfig(name, key, "unset", "refused (managed-key)");
      return c.json(invalid("managed-key", `${key} is managed by Dokku`), 409);
    }

    const startedAt = Date.now();
    const result = await dokku("config:unset", name, key, restart);
    if (!result.ok) {
      logConfig(name, key, "unset", `failed (${result.error.kind})`, startedAt);
      return c.json(configFailure(result.error), configStatus(result.error));
    }
    invalidateApp(readCache, name);
    logConfig(name, key, "unset", "ok", startedAt);
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
    if (!writeGate.enabled) {
      logOperation(op, loggedApp(body), "refused (writes-disabled)", startedAt);
      return c.json({ ok: false, error: writeGate.error } as const, 403);
    }
    const req = parseOperation(op, body);
    if (typeof req === "string") {
      logOperation(op, loggedApp(body), "refused (invalid-body)", startedAt);
      return c.json(invalid("invalid-body", req), 400);
    }

    // Before any read of the host: a typo in the name costs nothing.
    const confirm = destructiveConfirm(req);
    if (confirm && confirm.typed !== confirm.expected) {
      logOperation(op, req.app, "refused (confirm-mismatch)", startedAt);
      const message = `Type ${confirm.expected} to confirm.`;
      return c.json(invalid("confirm-mismatch", message), 400);
    }

    const checked = await preflight(dokku, req);
    if (!checked.ok) {
      const { status, kind, message } = checked.refusal;
      const outcome = status === 502 ? `failed (${kind})` : `refused (${kind})`;
      logOperation(op, req.app, outcome, startedAt);
      return c.json(invalid(kind, message), status);
    }

    const steps = commandSteps(req);
    const saved = restoreToSave(req, checked.app);

    if (!streamsOutput(req, checked.app)) {
      const result = await runSteps(dokku, steps);
      invalidateApp(readCache, req.app);
      if (!result.ok) {
        logOperation(op, req.app, `failed (${result.error.kind})`, startedAt);
        return c.json({ ok: false, error: result.error } as const, 502);
      }
      const noOp = conflictsOnNoOp(req) ? dokkuNoOp(result.output) : undefined;
      if (noOp) {
        logOperation(op, req.app, `refused (conflict: ${noOp})`, startedAt);
        return c.json(invalid("conflict", noOp), 409);
      }
      afterSuccess(req, saved);
      logOperation(op, req.app, "ok", startedAt);
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
        else afterSuccess(req, saved);
      } catch (e) {
        end = { kind: "failed", message: e instanceof Error ? e.message : String(e) };
      } finally {
        // A failed deploy can still have changed the app, so drop the cache either way.
        invalidateApp(readCache, req.app);
        clearInterval(heartbeat);
      }
      logOperation(
        op,
        req.app,
        end.kind === "failed" ? `failed (${end.message})` : "ok",
        startedAt,
      );
      await send(end.kind === "exited" ? "end" : "failed", end);
    });
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
