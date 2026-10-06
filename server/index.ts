import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { type ActionOutputEvent, appActions, isAppActionId } from "../shared/actions";
import {
  configValueProblem,
  isConfigKey,
  isManagedKey,
  parseConfigKeys,
  parseConfigSetBody,
  parseConfigValue,
} from "../shared/config";
import { parseLogEvent, stripAnsi } from "../shared/parse";
import type { LogEndEvent } from "../shared/types";
import { getApp, isNotFound, listApps } from "./apps";
import { cacheKeys, createReadCache, invalidateApp, loadCacheTtl } from "./cache";
import {
  createDokku,
  type DokkuError,
  isAppName,
  isProcessType,
  loadDokkuConfig,
  logTail,
} from "./dokku";
import { createHostMetrics, loadGlancesUrl } from "./metrics";
import { loadStaticDir, serveUi } from "./static";
import { loadWriteGate } from "./writes";

// Fails fast with a readable message when the SSH env is missing or malformed.
const config = loadDokkuConfig();
const dokku = createDokku(config);
const writeGate = loadWriteGate();
// Shared by list, detail and config-name reads; every change below invalidates its app.
const readCache = createReadCache(loadCacheTtl());
const hostMetrics = createHostMetrics(loadGlancesUrl());

// Comment-line pings keep idle log streams under Bun's idle timeout and expose dead clients.
const heartbeatMs = 15_000;

const invalid = (kind: string, message: string) =>
  ({ ok: false, error: { kind, message } }) as const;

/** One stdout line per action attempt, including the ones refused before Dokku ran. */
const logAction = (app: string, action: string, outcome: string, startedAt?: number) => {
  const took = startedAt === undefined ? "" : ` in ${Date.now() - startedAt}ms`;
  console.log(`action app=${app} action=${action} outcome=${outcome}${took}`);
};

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
    // `dokku version` prints "dokku version 0.38.31".
    const version = result.stdout.replace(/^dokku version\s+/, "");
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
    if (result.ok) return c.json({ ok: true, app: result.value } as const);
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
  // start, stop and restart answer `{ ok, output }` once Dokku is done. rebuild is
  // server-sent events like the logs route: `output` ({line}) per line, then one `end` or
  // `failed` (LogEndEvent). A rebuild keeps running if the client goes away, since
  // killing a deploy half way is worse than letting it finish.
  .post("/api/apps/:name/actions/:action", async (c) => {
    const name = c.req.param("name");
    if (!isAppName(name))
      return c.json(invalid("invalid-name", `Invalid app name: ${name}`), 400);
    const action = c.req.param("action");
    if (!isAppActionId(action)) {
      return c.json(invalid("invalid-action", `Unknown action: ${action}`), 400);
    }
    if (!writeGate.enabled) {
      logAction(name, action, "refused (writes-disabled)");
      return c.json({ ok: false, error: writeGate.error } as const, 403);
    }
    const exists = await dokku("ps:report", name);
    if (!exists.ok) return c.json(exists, isNotFound(exists.error) ? 404 : 502);

    const startedAt = Date.now();
    const def = appActions[action];
    if (!def.streams) {
      const result = await dokku(def.command, name);
      if (!result.ok) {
        logAction(name, action, `failed (${result.error.kind})`, startedAt);
        return c.json(result, 502);
      }
      invalidateApp(readCache, name);
      const output = stripAnsi([result.stderr, result.stdout].filter(Boolean).join("\n"));
      const noOp = dokkuNoOp(output);
      if (noOp) {
        logAction(name, action, `conflict (${noOp})`, startedAt);
        return c.json(invalid("conflict", noOp), 409);
      }
      logAction(name, action, "ok", startedAt);
      return c.json({ ok: true, output } as const);
    }

    const rebuild = dokku.stream(def.command, name);
    if (!rebuild.ok) {
      logAction(name, action, `failed (${rebuild.error.kind})`, startedAt);
      return c.json(rebuild, 502);
    }
    return streamSSE(c, async (stream) => {
      // Past an abort the lines are still read (an unread pipe would stall the build).
      const send = (event: string, data: ActionOutputEvent | LogEndEvent) =>
        stream.aborted
          ? Promise.resolve()
          : stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => {});
      const heartbeat = setInterval(() => {
        if (!stream.aborted) stream.write(": ping\n\n").catch(() => {});
      }, heartbeatMs);
      try {
        for await (const raw of rebuild.lines) {
          const line = stripAnsi(raw);
          if (line.trim()) await send("output", { line });
        }
        const error = await rebuild.exit;
        // A failed rebuild can still have stopped the app, so drop the cache either way.
        invalidateApp(readCache, name);
        const end: LogEndEvent = error
          ? { kind: "failed", message: stripAnsi(error.message) }
          : { kind: "exited" };
        logAction(
          name,
          action,
          end.kind === "failed" ? `failed (${end.message})` : "ok",
          startedAt,
        );
        await send(end.kind === "exited" ? "end" : "failed", end);
      } finally {
        clearInterval(heartbeat);
      }
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
