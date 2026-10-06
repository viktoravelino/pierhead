import { queryOptions } from "@tanstack/react-query";
import { hc } from "hono/client";
import type { AppType } from "../../server/index";
import type { ActionOutputEvent } from "../../shared/actions";
import type { LogEndEvent, LogEvent } from "../../shared/types";
import type { LogHandlers } from "./client";

/**
 * The Vite proxy answers with plain text when the API server is down. Turning that into
 * the backend's own `{ ok: false, error }` shape keeps every `.json()` below honest.
 */
const jsonOrUnreachable = async (input: RequestInfo | URL, init?: RequestInit) => {
  const res = await fetch(input, init);
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("application/json") || type.includes("text/event-stream")) return res;
  const message = `The backend answered HTTP ${res.status} without a JSON body.`;
  return Response.json(
    { ok: false, error: { kind: "unreachable", message } },
    { status: res.ok ? 502 : res.status },
  );
};

// Typed client for the real backend. The mock/real choice lives in ./client; this module
// only knows how to talk to the Hono server.
const backend = hc<AppType>("/", { fetch: jsonOrUnreachable });

export const backendHealthQuery = queryOptions({
  queryKey: ["backend", "health"],
  queryFn: async () => (await backend.api.health.$get()).json(),
  refetchInterval: 30_000,
  retry: false,
});

/** A non-2xx answer from the backend, carrying the `{ kind, message }` it sent. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly kind: string,
    message: string,
  ) {
    super(message);
  }
}

/** Reads the `{ kind, message }` to show for any failed query, whatever threw. */
export function describeError(error: unknown) {
  if (error instanceof ApiError) return { kind: error.kind, message: error.message };
  const message = error instanceof Error ? error.message : String(error);
  return { kind: "network", message };
}

/** Widens a typed route body by the error shape `jsonOrUnreachable` can substitute. */
const withUnreachable = <T>(res: { json(): Promise<T> }): Promise<T | ApiFailure> =>
  res.json();

/** Latest Glances reading and recent history; `status` says whether it is live. */
export async function fetchHostMetrics() {
  const res = await backend.api.host.metrics.$get();
  // The route only answers ok; the error shape comes from `jsonOrUnreachable`.
  const body = await withUnreachable(res);
  if (!body.ok) throw new ApiError(res.status, body.error.kind, body.error.message);
  return body;
}

export async function fetchApps() {
  const res = await backend.api.apps.$get();
  const body = await res.json();
  if (!body.ok) throw new ApiError(res.status, body.error.kind, body.error.message);
  return body.apps;
}

export async function fetchNetworks() {
  const res = await backend.api.networks.$get();
  const body = await res.json();
  if (!body.ok) throw new ApiError(res.status, body.error.kind, body.error.message);
  return body.networks;
}

export async function fetchHostDetails() {
  const res = await backend.api.host.$get();
  const body = await res.json();
  if (!body.ok) throw new ApiError(res.status, body.error.kind, body.error.message);
  const { dokku, pierhead } = body;
  return { dokku, pierhead };
}

export async function fetchApp(name: string) {
  const res = await backend.api.apps[":name"].$get({ param: { name } });
  const body = await res.json();
  if (!body.ok) throw new ApiError(res.status, body.error.kind, body.error.message);
  return body.app;
}

export async function fetchDokku() {
  const res = await backend.api.health.$get();
  const body = await res.json();
  if (!body.ok) throw new ApiError(res.status, body.error.kind, body.error.message);
  return body.dokku;
}

/** Recent lines the server replays before it follows the app's output. */
const logTail = 500;

/**
 * Follows an app's logs over SSE (`GET /api/apps/:name/logs`). Any end of the stream,
 * clean or not, calls `onEnd` once and closes the connection: an `EventSource` would
 * otherwise reconnect by itself and replay the history. Returns an unsubscribe, which
 * closes the connection; the server then kills its ssh child.
 */
export function streamLogs(name: string, { onLines, onEnd }: LogHandlers) {
  // Not `backend.….$url()`: that needs an absolute base, and ours is relative (proxied).
  const source = new EventSource(
    `/api/apps/${encodeURIComponent(name)}/logs?tail=${logTail}`,
  );
  const finish = (end: LogEndEvent) => {
    source.close();
    onEnd(end);
  };
  // Each event's `data` is JSON the server produced from the shared types.
  source.addEventListener("log", (e) => {
    const event: LogEvent = JSON.parse(e.data);
    onLines([event]);
  });
  for (const type of ["end", "failed"]) {
    source.addEventListener(type, (e) => {
      const end: LogEndEvent = JSON.parse(e.data);
      finish(end);
    });
  }
  // Also fires for a JSON error before the stream (404, 502): EventSource hides the body.
  source.onerror = () =>
    finish({ kind: "failed", message: "Lost the connection to the log stream." });
  return () => source.close();
}

/** What the action route answers with, bar the event stream. */
type ActionBody = { ok: true; output: string } | { ok: false; error: ApiErrorBody };
type ApiErrorBody = { kind: string; message: string };
type ApiFailure = { ok: false; error: ApiErrorBody };

// Not `backend.…$post()`: the route also answers with an event stream, which erases the
// JSON body types from the client.
const postAction = (name: string, action: string) =>
  jsonOrUnreachable(`/api/apps/${encodeURIComponent(name)}/actions/${action}`, {
    method: "POST",
  });

/** Runs start, stop or restart; resolves with Dokku's output once the command is done. */
export async function postQuickAction(name: string, action: string) {
  const res = await postAction(name, action);
  const body: ActionBody = await res.json();
  if (!body.ok) throw new ApiError(res.status, body.error.kind, body.error.message);
  return body.output;
}

export async function fetchConfigKeys(name: string) {
  const res = await backend.api.apps[":name"].config.$get({ param: { name } });
  const body = await res.json();
  if (!body.ok) throw new ApiError(res.status, body.error.kind, body.error.message);
  return body.keys;
}

/** One variable's value; only called when the user asks to reveal it. */
export async function fetchConfigValue(name: string, key: string) {
  const res = await backend.api.apps[":name"].config[":key"].$get({
    param: { name, key },
  });
  const body = await res.json();
  if (!body.ok) throw new ApiError(res.status, body.error.kind, body.error.message);
  return body.value;
}

/** What the config write routes answer with. */
type ConfigWriteBody = { ok: true } | { ok: false; error: ApiErrorBody };

// Not `backend.…$put()`: the route's body is checked by hand, so the client has no typed input.
const writeConfig = async (name: string, key: string, init: RequestInit, query = "") => {
  const url = `/api/apps/${encodeURIComponent(name)}/config/${encodeURIComponent(key)}${query}`;
  const res = await jsonOrUnreachable(url, init);
  const body: ConfigWriteBody = await res.json();
  if (!body.ok) throw new ApiError(res.status, body.error.kind, body.error.message);
};

/** Sets one variable; with `restart` Dokku redeploys the app, which takes ~25s. */
export const putConfigVar = (
  name: string,
  key: string,
  value: string,
  restart: boolean,
) =>
  writeConfig(name, key, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value, restart }),
  });

export const deleteConfigVar = (name: string, key: string, restart: boolean) =>
  writeConfig(name, key, { method: "DELETE" }, `?restart=${restart}`);

/** The `event` and `data` of each server-sent event in a byte stream; comments are skipped. */
async function* readEvents(source: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of source) {
    rest += decoder.decode(chunk, { stream: true });
    const blocks = rest.split("\n\n");
    rest = blocks.pop() ?? "";
    for (const block of blocks) {
      const fields = new Map(
        block
          .split("\n")
          .filter((line) => !line.startsWith(":"))
          .map((line): [string, string] => {
            const [field = "", ...value] = line.split(": ");
            return [field, value.join(": ")];
          }),
      );
      const event = fields.get("event");
      const data = fields.get("data");
      if (event && data) yield { event, data };
    }
  }
}

/**
 * Rebuilds an app, calling `onLine` for each line of Dokku's output. Resolves when the
 * rebuild succeeded and throws an `ApiError` when it failed or could not start. Not an
 * `EventSource` (those only GET), and nothing here aborts: the server finishes the
 * rebuild even if this tab goes away.
 */
export async function streamRebuild(name: string, onLine: (line: string) => void) {
  const res = await postAction(name, "rebuild");
  if (!res.headers.get("content-type")?.includes("text/event-stream")) {
    const body: ActionBody = await res.json();
    if (body.ok)
      throw new ApiError(res.status, "unexpected", "Expected an event stream.");
    throw new ApiError(res.status, body.error.kind, body.error.message);
  }
  if (!res.body) throw new ApiError(res.status, "unexpected", "Empty response.");
  for await (const { event, data } of readEvents(res.body)) {
    if (event === "output") {
      const output: ActionOutputEvent = JSON.parse(data);
      onLine(output.line);
    } else if (event === "end") {
      return;
    } else if (event === "failed") {
      const end: LogEndEvent = JSON.parse(data);
      if (end.kind === "failed") throw new ApiError(res.status, "failed", end.message);
    }
  }
  throw new ApiError(
    res.status,
    "network",
    "Lost the connection to the rebuild. It may still be running on the host.",
  );
}
