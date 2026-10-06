import { fields, parseBody, refuse } from "./fields";
import {
  formatPortMapping,
  isAppName,
  isDomain,
  isNewAppName,
  isSafeDomain,
  portMappingProblem,
  reusedPort,
} from "./grammar";
import type { AppSummary, PortMapping } from "./types";

// Every write the server runs for the UI is a row of the `operations` table below: the
// request it accepts, the Dokku commands it runs, whether it streams, and when it makes
// sense. The server executes the table and the confirm dialog prints it, so the command
// a user approves is the one that runs.

const maxDomains = 20;
const maxMappings = 20;

/** The body of each operation, minus its `op`. */
type OperationArgs = {
  "ps:start": { app: string };
  "ps:stop": { app: string };
  "ps:restart": { app: string };
  "ps:rebuild": { app: string };
  "apps:create": { app: string };
  /** `confirm` is the app's name, typed by the user; the server checks it too. */
  "apps:destroy": { app: string; confirm: string };
  "domains:add": { app: string; domains: string[] };
  "domains:remove": { app: string; domains: string[] };
  "domains:set": { app: string; domains: string[] };
  "ports:add": { app: string; mappings: PortMapping[] };
  "ports:remove": { app: string; mappings: PortMapping[] };
  "ports:set": { app: string; mappings: PortMapping[] };
  /** With `ports` and `domains`, both are set again right after (Dokku clears them on disable). */
  "proxy:enable": { app: string; ports?: PortMapping[]; domains?: string[] };
  "proxy:disable": { app: string };
};

export type OperationId = keyof OperationArgs;

type Of<K extends OperationId> = { op: K } & OperationArgs[K];

/** What `POST /api/operations/:op` accepts; narrow on `op`. */
export type OperationRequest = { [K in OperationId]: Of<K> }[OperationId];

export type Availability = { ok: true } | { ok: false; reason: string };

/** The part of an app's state that decides whether an operation makes sense. */
export type AppState = Pick<AppSummary, "status" | "revision" | "proxyEnabled">;

type OperationDef<K extends OperationId> = {
  /** Narrows an unknown body to a request, or says why not (a 400). */
  parse: (body: unknown) => Of<K> | string;
  /** Argv after `dokku` for each step, in order; the server runs them and the dialog prints them. */
  commands: (req: Of<K>) => string[][];
  /** Whether the answer is a server-sent event stream; a function decides per app state (`null`: unknown). */
  streams: boolean | ((req: Of<K>, app: Pick<AppSummary, "status"> | null) => boolean);
  /** Present for irreversible operations: the typed text must equal `expected` (a 400 otherwise). */
  destructive?: (req: Of<K>) => { typed: string; expected: string };
  /** Dokku exits 0 for a no-op and says so on a ` !` line; this makes the server answer 409 then. */
  conflictOnNoOp?: true;
  /** Whether the operation fits the app's state; omitted when it always does. */
  availability?: (app: AppState) => Availability;
};

const available = { ok: true } as const;
const unavailable = (reason: string) => ({ ok: false, reason }) as const;

/** Every operation on an existing app is refused while a deploy runs. */
const unlessDeploying =
  (rule: (app: AppState) => Availability = () => available) =>
  (app: AppState) =>
    app.status.kind === "deploying" ? unavailable("A deploy is in progress.") : rule(app);

type PsOp = Extract<OperationId, `ps:${string}`>;

/** start, stop, restart and rebuild by what the app is doing right now. */
const psAvailability = (op: PsOp) =>
  unlessDeploying(({ status, revision }) => {
    switch (status.kind) {
      case "deploying":
        return unavailable("A deploy is in progress.");
      case "not-deployed":
        return op === "ps:rebuild"
          ? revision
            ? available
            : unavailable("No code has been pushed yet.")
          : unavailable("Never deployed, so there is nothing to run yet.");
      case "stopped":
        if (op === "ps:stop") return unavailable("Already stopped.");
        if (op === "ps:restart") return unavailable("Stopped. Start it instead.");
        return available;
      case "running":
      case "crashed":
        return op === "ps:start" ? unavailable("Already running.") : available;
    }
  });

/** Dokku saves nothing on a proxy-disabled app's domains (it answers 0 all the same). */
const needsProxy = unlessDeploying(({ proxyEnabled }) =>
  proxyEnabled ? available : unavailable("Enable the proxy first."),
);

const appName = (body: unknown) => {
  const app = fields(body).string("app");
  return isAppName(app) ? app : refuse(`Invalid app name: ${JSON.stringify(app)}`);
};

/** `{ app }` for the operation `op`. */
const appBody = <K extends OperationId>(op: K) =>
  parseBody((body) => ({ op, app: appName(body) }));

/**
 * A list of domains. Additions (`strict`) must be well-formed hostnames; removals and
 * restores take whatever Dokku holds, as long as it is safe to pass on.
 */
const domainList = (body: unknown, key: string, strict: boolean) => {
  const domains = fields(body).list(key, maxDomains, (value) =>
    typeof value === "string" && (strict ? isDomain(value) : isSafeDomain(value))
      ? value
      : refuse(`Invalid domain: ${JSON.stringify(value)}`),
  );
  return new Set(domains).size === domains.length
    ? domains
    : refuse("A domain is listed twice.");
};

const domainsBody = <K extends OperationId>(op: K, strict: boolean) =>
  parseBody((body) => ({
    op,
    app: appName(body),
    domains: domainList(body, "domains", strict),
  }));

const mappings = (body: unknown, key: string, strict: boolean) => {
  const list = fields(body).list(key, maxMappings, (value) => {
    const f = fields(value);
    const mapping = {
      scheme: f.string("scheme"),
      host: f.number("host"),
      container: f.number("container"),
    };
    const problem = portMappingProblem(mapping, strict);
    return problem ? refuse(problem) : mapping;
  });
  const reused = reusedPort(list);
  return reused ? refuse(`${reused} is mapped twice.`) : list;
};

const portsBody = <K extends OperationId>(op: K, strict: boolean) =>
  parseBody((body) => ({
    op,
    app: appName(body),
    mappings: mappings(body, "mappings", strict),
  }));

const step = (...argv: string[]) => argv;

export const operations: { [K in OperationId]: OperationDef<K> } = {
  "ps:start": {
    parse: appBody("ps:start"),
    commands: ({ app }) => [step("ps:start", app)],
    streams: false,
    conflictOnNoOp: true,
    availability: psAvailability("ps:start"),
  },
  "ps:stop": {
    parse: appBody("ps:stop"),
    commands: ({ app }) => [step("ps:stop", app)],
    streams: false,
    conflictOnNoOp: true,
    availability: psAvailability("ps:stop"),
  },
  "ps:restart": {
    parse: appBody("ps:restart"),
    commands: ({ app }) => [step("ps:restart", app)],
    streams: false,
    conflictOnNoOp: true,
    availability: psAvailability("ps:restart"),
  },
  "ps:rebuild": {
    parse: appBody("ps:rebuild"),
    commands: ({ app }) => [step("ps:rebuild", app)],
    streams: true,
    availability: psAvailability("ps:rebuild"),
  },
  "apps:create": {
    parse: parseBody((body) => {
      const app = fields(body).string("app");
      return isNewAppName(app)
        ? { op: "apps:create", app }
        : refuse(
            "Use lowercase letters, digits, dots and hyphens, starting with a letter or digit, up to 63 characters.",
          );
    }),
    commands: ({ app }) => [step("apps:create", app)],
    streams: false,
  },
  "apps:destroy": {
    parse: parseBody((body) => ({
      op: "apps:destroy",
      app: appName(body),
      confirm: fields(body).string("confirm"),
    })),
    // Without --force Dokku prompts for the name and fails without a tty; the typed name
    // is checked by `destructive` instead.
    commands: ({ app }) => [step("apps:destroy", "--force", app)],
    streams: false,
    destructive: ({ app, confirm }) => ({ typed: confirm, expected: app }),
    availability: unlessDeploying(),
  },
  "domains:add": {
    parse: domainsBody("domains:add", true),
    commands: ({ app, domains }) => [step("domains:add", app, ...domains)],
    streams: false,
    availability: needsProxy,
  },
  "domains:remove": {
    parse: domainsBody("domains:remove", false),
    commands: ({ app, domains }) => [step("domains:remove", app, ...domains)],
    streams: false,
    availability: needsProxy,
  },
  "domains:set": {
    parse: domainsBody("domains:set", true),
    commands: ({ app, domains }) => [step("domains:set", app, ...domains)],
    streams: false,
    availability: needsProxy,
  },
  "ports:add": {
    parse: portsBody("ports:add", true),
    commands: ({ app, mappings }) => [
      step("ports:add", app, ...mappings.map(formatPortMapping)),
    ],
    streams: false,
    availability: unlessDeploying(),
  },
  "ports:remove": {
    parse: portsBody("ports:remove", false),
    commands: ({ app, mappings }) => [
      step("ports:remove", app, ...mappings.map(formatPortMapping)),
    ],
    streams: false,
    availability: unlessDeploying(),
  },
  "ports:set": {
    parse: portsBody("ports:set", true),
    commands: ({ app, mappings }) => [
      step("ports:set", app, ...mappings.map(formatPortMapping)),
    ],
    streams: false,
    availability: unlessDeploying(),
  },
  "proxy:enable": {
    parse: parseBody((body) => {
      const f = fields(body);
      return {
        op: "proxy:enable",
        app: appName(body),
        ...(f.has("ports") ? { ports: mappings(body, "ports", false) } : {}),
        ...(f.has("domains") ? { domains: domainList(body, "domains", false) } : {}),
      };
    }),
    commands: ({ app, ports, domains }) => [
      step("proxy:enable", app),
      ...(ports && ports.length > 0
        ? [step("ports:set", app, ...ports.map(formatPortMapping))]
        : []),
      ...(domains && domains.length > 0 ? [step("domains:set", app, ...domains)] : []),
    ],
    // A redeploy (~25s) once there is something deployed.
    streams: (_req, app) => app?.status.kind !== "not-deployed",
    availability: unlessDeploying(({ proxyEnabled }) =>
      proxyEnabled ? unavailable("The proxy is already enabled.") : available,
    ),
  },
  "proxy:disable": {
    parse: appBody("proxy:disable"),
    commands: ({ app }) => [step("proxy:disable", app)],
    streams: (_req, app) => app?.status.kind !== "not-deployed",
    availability: unlessDeploying(({ proxyEnabled }) =>
      proxyEnabled ? available : unavailable("The proxy is already disabled."),
    ),
  },
};

export const isOperationId = (value: string): value is OperationId =>
  Object.hasOwn(operations, value);

// TS cannot correlate a request's `op` with its table entry, so the helpers below widen
// the entry once, here.
const defOf = (req: OperationRequest) => operations[req.op] as OperationDef<OperationId>;

/** Narrows a body for `op`: the request, or the reason it was refused. */
export const parseOperation = (
  op: OperationId,
  body: unknown,
): OperationRequest | string => operations[op].parse(body);

/** The Dokku commands (argv after `dokku`) the request runs, in order. */
export const commandSteps = (req: OperationRequest) => defOf(req).commands(req);

/** What the confirm dialog shows: one `dokku ...` line per step. */
export const commandLine = (req: OperationRequest) =>
  commandSteps(req)
    .map((argv) => ["dokku", ...argv].join(" "))
    .join("\n");

/** Whether the server answers with a stream; `app` is the target's state when known. */
export function streamsOutput(
  req: OperationRequest,
  app: Pick<AppSummary, "status"> | null,
) {
  const { streams } = defOf(req);
  return typeof streams === "function" ? streams(req, app) : streams;
}

/** Set for irreversible operations: what the user must type, and what they typed. */
export const destructiveConfirm = (req: OperationRequest) =>
  defOf(req).destructive?.(req);

/** Whether Dokku's "nothing to do" exit 0 is a 409 for this request. */
export const conflictsOnNoOp = (req: OperationRequest) =>
  defOf(req).conflictOnNoOp === true;

/** Whether the operation makes sense for the app's state; `reason` explains a no. */
export const operationAvailability = (op: OperationId, app: AppState): Availability =>
  operations[op].availability?.(app) ?? available;

/** A rebuild's (or any streamed operation's) SSE event: one line of Dokku output, ANSI stripped. */
export type OperationOutputEvent = { line: string };
