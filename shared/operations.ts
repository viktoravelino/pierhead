import { fields, parseBody, refuse } from "./fields";
import {
  builderNames,
  defaultProcessType,
  formatFormationEntry,
  formatPortMapping,
  isAppName,
  isContainerPath,
  isCpu,
  isDomain,
  isExistingStorageName,
  isMemory,
  isNetworkAlias,
  isNetworkName,
  isNewAppName,
  isNewProcessType,
  isProcessCount,
  isProcessType,
  isRepoPath,
  isSafeArg,
  isSafeContainerPath,
  isSafeDomain,
  isStorageName,
  maxProcessCount,
  networkAttachments,
  portMappingProblem,
  reusedPort,
  storageHostPath,
} from "./grammar";
import type {
  AppSummary,
  FormationEntry,
  NetworkAttachment,
  PortMapping,
  ResourceKind,
} from "./types";

// Every write the server runs for the UI is a row of the `operations` table below: the
// request it accepts, the Dokku commands it runs, whether it streams, and when it makes
// sense. The server executes the table and the confirm dialog prints it, so the command
// a user approves is the one that runs.

const maxDomains = 20;
const maxMappings = 20;
const maxFormation = 20;
const maxNetworks = 10;

export const builderProperties = ["build-dir", "selected", "dockerfile-path"] as const;
export type BuilderProperty = (typeof builderProperties)[number];

export const resourceKinds = [
  "limit",
  "reserve",
] as const satisfies readonly ResourceKind[];

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
  /** Redeploys a deployed app unless `skipDeploy`, which only records the formation. */
  "ps:scale": { app: string; formation: FormationEntry[]; skipDeploy: boolean };
  "network:create": { network: string };
  /** `confirm` is the network's name, typed by the user. */
  "network:destroy": { network: string; confirm: string };
  /** No `networks` clears the property. `rebuild` adds a `ps:rebuild`, since it applies on the next deploy. */
  "network:set": {
    app: string;
    property: NetworkAttachment;
    networks: string[];
    rebuild: boolean;
  };
  "network:alias-add": { app: string; alias: string; rebuild: boolean };
  "network:alias-remove": { app: string; alias: string; rebuild: boolean };
  /** An empty `value` clears the setting. */
  "builder:set": { app: string; property: BuilderProperty; value: string };
  /** `processType` null is the default for every type; an empty `memory` or `cpu` is left as it is. */
  "resource:set": {
    app: string;
    kind: ResourceKind;
    processType: string | null;
    memory: string;
    cpu: string;
  };
  "resource:clear": { app: string; kind: ResourceKind; processType: string | null };
  /** Creates the directory under the storage root when it is not there yet. */
  "storage:mount": { app: string; name: string; containerPath: string };
  /** `confirm` is the container path, typed by the user. */
  "storage:unmount": {
    app: string;
    name: string;
    containerPath: string;
    confirm: string;
  };
};

export type OperationId = keyof OperationArgs;

type Of<K extends OperationId> = { op: K } & OperationArgs[K];

/** What `POST /api/operations/:op` accepts; narrow on `op`. */
export type OperationRequest = { [K in OperationId]: Of<K> }[OperationId];

export type Availability = { ok: true } | { ok: false; reason: string };

/** The part of an app's state that decides whether an operation makes sense. */
export type AppState = Pick<AppSummary, "status" | "revision" | "proxyEnabled"> & {
  /** `ps:report`'s `can-scale`; unknown (omitted) counts as scalable. */
  canScale?: boolean;
};

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

const formationOf = (body: unknown) => {
  const formation = fields(body).list("formation", maxFormation, (value) => {
    const f = fields(value);
    const type = f.string("type");
    const count = f.number("count");
    if (!isNewProcessType(type)) {
      return refuse(
        `Invalid process type ${JSON.stringify(type)}: use lowercase letters, digits, hyphens and underscores.`,
      );
    }
    return isProcessCount(count)
      ? { type, count }
      : refuse(`${type}: the count is a whole number from 0 to ${maxProcessCount}.`);
  });
  return new Set(formation.map((e) => e.type)).size === formation.length
    ? formation
    : refuse("A process type is listed twice.");
};

/** A name that is safe to pass on, for things Dokku already holds (removals and detaching). */
const safeName = (value: unknown, what: string) =>
  typeof value === "string" && isSafeArg(value)
    ? value
    : refuse(`Invalid ${what}: ${JSON.stringify(value)}`);

const networkName = (body: unknown) => {
  const network = fields(body).string("network");
  return isNetworkName(network)
    ? network
    : refuse(
        "Use lowercase letters, digits, dots, underscores and hyphens, starting with a letter or digit, up to 63 characters.",
      );
};

/** `{ app, alias, rebuild }`: a new alias must be one DNS label, a stored one anything safe. */
const aliasBody = <K extends OperationId>(op: K, strict: boolean) =>
  parseBody((body) => {
    const alias = fields(body).string("alias");
    if (strict ? !isNetworkAlias(alias) : !isSafeArg(alias)) {
      return refuse(
        strict
          ? "An alias is one DNS label: lowercase letters, digits and inner hyphens, up to 63 characters."
          : `Invalid alias: ${JSON.stringify(alias)}`,
      );
    }
    return { op, app: appName(body), alias, rebuild: fields(body).flag("rebuild") };
  });

/** The `processType` of a resource request: a type Dokku may hold, or null for the default. */
const processTypeOf = (body: unknown) => {
  const processType = fields(body).optionalString("processType");
  if (processType === null || processType === defaultProcessType) return null;
  return isProcessType(processType)
    ? processType
    : refuse(`Invalid process type: ${JSON.stringify(processType)}`);
};

/** Setting without the flag already means every type; clearing without it would wipe every type's setting too. */
const processTypeFlag = (processType: string | null, always = false) =>
  processType !== null
    ? ["--process-type", processType]
    : always
      ? ["--process-type", defaultProcessType]
      : [];

/** Names the setting when a value is set, nothing when it is blank (a blank leaves the setting alone). */
const resourceValue = (
  body: unknown,
  key: "memory" | "cpu",
  valid: (value: string) => boolean,
  hint: string,
) => {
  const value = fields(body).optionalString(key) ?? "";
  return value === "" || valid(value) ? value : refuse(`Invalid ${key}: ${hint}`);
};

const step = (...argv: string[]) => argv;

/** `ps:rebuild` as a last step, for settings that only apply on the next deploy. */
const thenRebuild = (app: string, rebuild: boolean) =>
  rebuild ? [step("ps:rebuild", app)] : [];

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
  "ps:scale": {
    parse: parseBody((body) => ({
      op: "ps:scale",
      app: appName(body),
      formation: formationOf(body),
      skipDeploy: fields(body).flag("skipDeploy"),
    })),
    commands: ({ app, formation, skipDeploy }) => [
      step(
        "ps:scale",
        ...(skipDeploy ? ["--skip-deploy"] : []),
        app,
        ...formation.map(formatFormationEntry),
      ),
    ],
    // A redeploy (about 40 s for one more web container) unless only the formation is saved.
    streams: ({ skipDeploy }, app) => !skipDeploy && app?.status.kind !== "not-deployed",
    availability: unlessDeploying(({ status, canScale }) =>
      status.kind === "not-deployed"
        ? unavailable("Never deployed, so there is nothing to scale yet.")
        : canScale === false
          ? unavailable("Dokku does not scale this app.")
          : available,
    ),
  },
  "network:create": {
    parse: parseBody((body) => ({ op: "network:create", network: networkName(body) })),
    commands: ({ network }) => [step("network:create", network)],
    streams: false,
  },
  "network:destroy": {
    parse: parseBody((body) => ({
      op: "network:destroy",
      network: safeName(fields(body).string("network"), "network name"),
      confirm: fields(body).string("confirm"),
    })),
    // Without --force Dokku prompts for the name and fails without a tty.
    commands: ({ network }) => [step("network:destroy", "--force", network)],
    streams: false,
    destructive: ({ network, confirm }) => ({ typed: confirm, expected: network }),
  },
  "network:set": {
    parse: parseBody((body) => {
      const f = fields(body);
      const property = f.oneOf("property", networkAttachments);
      const networks = f.list(
        "networks",
        property === "initial-network" ? 1 : maxNetworks,
        (value) => safeName(value, "network name"),
        0,
      );
      return new Set(networks).size === networks.length
        ? {
            op: "network:set",
            app: appName(body),
            property,
            networks,
            rebuild: f.flag("rebuild"),
          }
        : refuse("A network is listed twice.");
    }),
    commands: ({ app, property, networks, rebuild }) => [
      step("network:set", app, property, ...networks),
      ...thenRebuild(app, rebuild),
    ],
    streams: ({ rebuild }) => rebuild,
    availability: unlessDeploying(),
  },
  "network:alias-add": {
    parse: aliasBody("network:alias-add", true),
    commands: ({ app, alias, rebuild }) => [
      step("docker-options:add", app, "deploy", `--network-alias ${alias}`),
      ...thenRebuild(app, rebuild),
    ],
    streams: ({ rebuild }) => rebuild,
    availability: unlessDeploying(),
  },
  "network:alias-remove": {
    parse: aliasBody("network:alias-remove", false),
    commands: ({ app, alias, rebuild }) => [
      step("docker-options:remove", app, "deploy", `--network-alias ${alias}`),
      ...thenRebuild(app, rebuild),
    ],
    streams: ({ rebuild }) => rebuild,
    availability: unlessDeploying(),
  },
  "builder:set": {
    parse: parseBody((body) => {
      const f = fields(body);
      const property = f.oneOf("property", builderProperties);
      const value = f.string("value");
      const valid =
        value === "" ||
        (property === "selected"
          ? builderNames.some((name) => name === value)
          : isRepoPath(value));
      if (valid) return { op: "builder:set", app: appName(body), property, value };
      return refuse(
        property === "selected"
          ? `The builder is one of ${builderNames.join(", ")}.`
          : "Use a path inside the repository: no leading /, no .. and only letters, digits, dots, underscores and hyphens.",
      );
    }),
    commands: ({ app, property, value }) => [
      step(
        property === "dockerfile-path" ? "builder-dockerfile:set" : "builder:set",
        app,
        property,
        ...(value === "" ? [] : [value]),
      ),
    ],
    streams: false,
    availability: unlessDeploying(),
  },
  "resource:set": {
    parse: parseBody((body) => {
      const memory = resourceValue(
        body,
        "memory",
        isMemory,
        "a number with an optional unit b, k, m or g, such as 256m, of at least 6m.",
      );
      const cpu = resourceValue(
        body,
        "cpu",
        isCpu,
        "a number with at most two decimals, such as 0.5.",
      );
      if (memory === "" && cpu === "") return refuse("Set a memory or a cpu value.");
      return {
        op: "resource:set",
        app: appName(body),
        kind: fields(body).oneOf("kind", resourceKinds),
        processType: processTypeOf(body),
        memory,
        cpu,
      };
    }),
    commands: ({ app, kind, processType, memory, cpu }) => [
      step(
        `resource:${kind}`,
        ...processTypeFlag(processType),
        ...(memory === "" ? [] : ["--memory", memory]),
        ...(cpu === "" ? [] : ["--cpu", cpu]),
        app,
      ),
    ],
    streams: false,
    availability: unlessDeploying(),
  },
  "resource:clear": {
    parse: parseBody((body) => ({
      op: "resource:clear",
      app: appName(body),
      kind: fields(body).oneOf("kind", resourceKinds),
      processType: processTypeOf(body),
    })),
    commands: ({ app, kind, processType }) => [
      step(`resource:${kind}-clear`, ...processTypeFlag(processType, true), app),
    ],
    streams: false,
    availability: unlessDeploying(),
  },
  "storage:mount": {
    parse: parseBody((body) => {
      const f = fields(body);
      const name = f.string("name");
      const containerPath = f.string("containerPath");
      if (!isStorageName(name)) {
        return refuse(
          "Use lowercase letters, digits, underscores and hyphens, starting with a letter or digit.",
        );
      }
      return isContainerPath(containerPath)
        ? { op: "storage:mount", app: appName(body), name, containerPath }
        : refuse(
            "The container path is absolute, with no .. and only letters, digits, dots, underscores and hyphens.",
          );
    }),
    // `storage:create` leaves an existing directory in place and exits 0.
    commands: ({ app, name, containerPath }) => [
      step("storage:create", name),
      step("storage:mount", app, `${storageHostPath(name)}:${containerPath}`),
    ],
    streams: false,
    availability: unlessDeploying(),
  },
  "storage:unmount": {
    parse: parseBody((body) => {
      const f = fields(body);
      const name = f.string("name");
      const containerPath = f.string("containerPath");
      if (!isExistingStorageName(name) || !isSafeContainerPath(containerPath)) {
        return refuse("That is not a mount under the storage root.");
      }
      return {
        op: "storage:unmount",
        app: appName(body),
        name,
        containerPath,
        confirm: f.string("confirm"),
      };
    }),
    // The host directory stays; only the mount goes.
    commands: ({ app, name, containerPath }) => [
      step("storage:unmount", app, `${storageHostPath(name)}:${containerPath}`),
    ],
    streams: false,
    destructive: ({ containerPath, confirm }) => ({
      typed: confirm,
      expected: containerPath,
    }),
    availability: unlessDeploying(),
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

/** What the confirm dialog shows: one `dokku ...` line per step, an argument with spaces in quotes. */
export const commandLine = (req: OperationRequest) =>
  commandSteps(req)
    .map((argv) =>
      ["dokku", ...argv.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg))].join(" "),
    )
    .join("\n");

/** The app a request acts on; null for the operations on a network, which belong to no app. */
export const appOf = (req: OperationRequest) => ("app" in req ? req.app : null);

/** What the request is about, for toasts and the log: its app, else its network. */
export const targetOf = (req: OperationRequest) => ("app" in req ? req.app : req.network);

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
