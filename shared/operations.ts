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
  isGitRef,
  isGitUrl,
  isImageRef,
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
  /** `confirm` is the app's current name. Redeploys under the new name unless `skipDeploy`. */
  "apps:rename": { app: string; newName: string; skipDeploy: boolean; confirm: string };
  /** Copies the app under `newName`; deploys the copy unless `skipDeploy`. */
  "apps:clone": { app: string; newName: string; skipDeploy: boolean };
  "domains:add": { app: string; domains: string[] };
  "domains:remove": { app: string; domains: string[] };
  "domains:set": { app: string; domains: string[] };
  /** The domains every new app's default vhost is built from; apps that exist keep theirs. */
  "domains:add-global": { domains: string[] };
  "domains:remove-global": { domains: string[] };
  "domains:set-global": { domains: string[] };
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
  /** Releases Dokku's deploy lock, which a failed deploy can leave held; the server refuses while a build record is running. */
  "apps:unlock": { app: string };
  /** Replaces the app's code with a public image and deploys it. */
  "git:from-image": { app: string; image: string };
  /** Fetches a repository into the app; `build` also builds and deploys it. An empty `ref` is the remote's default branch. */
  "git:sync": { app: string; url: string; ref: string; build: boolean };
  /** The branch Dokku deploys; an empty `branch` clears the app's own setting. */
  "git:set": { app: string; branch: string };
  /** The deploy branch of apps that set none; an empty `branch` clears it. */
  "git:set-global": { branch: string };
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
  /** Whether the deploy lock is held; unknown (omitted) counts as free. */
  locked?: boolean;
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

/** The name of a rename or clone's result: a valid new name, and not the app itself. */
const newNameOf = (body: unknown, app: string) => {
  const newName = fields(body).string("newName");
  if (!isNewAppName(newName)) {
    return refuse(
      "Use lowercase letters, digits, dots and hyphens, starting with a letter or digit, up to 63 characters.",
    );
  }
  return newName === app ? refuse("Pick a different name.") : newName;
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

/** `{ domains }` without an app, for the global domains. */
const globalDomainsBody = <K extends OperationId>(op: K, strict: boolean) =>
  parseBody((body) => ({ op, domains: domainList(body, "domains", strict) }));

/** A rename or clone redeploys a deployed app (~28 s) unless it only copies the state. */
const redeploys = (
  { skipDeploy }: { skipDeploy: boolean },
  app: Pick<AppSummary, "status"> | null,
) => !skipDeploy && app?.status.kind !== "not-deployed";

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
  "apps:rename": {
    parse: parseBody((body) => {
      const app = appName(body);
      return {
        op: "apps:rename",
        app,
        newName: newNameOf(body, app),
        skipDeploy: fields(body).flag("skipDeploy"),
        confirm: fields(body).string("confirm"),
      };
    }),
    // Dokku destroys the old app and redeploys under the new name unless told not to.
    commands: ({ app, newName, skipDeploy }) => [
      step("apps:rename", ...(skipDeploy ? ["--skip-deploy"] : []), app, newName),
    ],
    streams: redeploys,
    destructive: ({ app, confirm }) => ({ typed: confirm, expected: app }),
    availability: unlessDeploying(),
  },
  "apps:clone": {
    parse: parseBody((body) => {
      const app = appName(body);
      return {
        op: "apps:clone",
        app,
        newName: newNameOf(body, app),
        skipDeploy: fields(body).flag("skipDeploy"),
      };
    }),
    // No --ignore-existing: the route 409s on a taken name, and the flag would turn a
    // lost race into a silent exit 0.
    commands: ({ app, newName, skipDeploy }) => [
      step("apps:clone", ...(skipDeploy ? ["--skip-deploy"] : []), app, newName),
    ],
    streams: redeploys,
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
  "domains:add-global": {
    parse: globalDomainsBody("domains:add-global", true),
    commands: ({ domains }) => [step("domains:add-global", ...domains)],
    streams: false,
  },
  "domains:remove-global": {
    parse: globalDomainsBody("domains:remove-global", false),
    commands: ({ domains }) => [step("domains:remove-global", ...domains)],
    streams: false,
  },
  "domains:set-global": {
    parse: globalDomainsBody("domains:set-global", true),
    commands: ({ domains }) => [step("domains:set-global", ...domains)],
    streams: false,
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
  "apps:unlock": {
    parse: appBody("apps:unlock"),
    commands: ({ app }) => [step("apps:unlock", app)],
    streams: false,
    // Not behind `unlessDeploying`: a held lock is exactly what this is for.
    availability: ({ locked }) =>
      locked ? available : unavailable("No deploy lock is held."),
  },
  "git:from-image": {
    parse: parseBody((body) => {
      const image = fields(body).string("image");
      return isImageRef(image)
        ? { op: "git:from-image", app: appName(body), image }
        : refuse(
            `Invalid image: ${JSON.stringify(image)}. Use registry/path:tag in lowercase, such as nginx:alpine.`,
          );
    }),
    commands: ({ app, image }) => [step("git:from-image", app, image)],
    streams: true,
    availability: unlessDeploying(),
  },
  "git:sync": {
    parse: parseBody((body) => {
      const f = fields(body);
      const url = f.string("url");
      const ref = f.optionalString("ref") ?? "";
      if (!isGitUrl(url)) {
        return refuse(
          "Use an https:// URL or git@host:path, with no credentials, query or local path.",
        );
      }
      if (ref !== "" && !isGitRef(ref)) {
        return refuse(
          "A branch, tag or commit: letters, digits, dots, underscores, hyphens and slashes, not starting with a hyphen.",
        );
      }
      return { op: "git:sync", app: appName(body), url, ref, build: f.flag("build") };
    }),
    commands: ({ app, url, ref, build }) => [
      step("git:sync", ...(build ? ["--build"] : []), app, url, ...(ref ? [ref] : [])),
    ],
    streams: true,
    availability: unlessDeploying(),
  },
  "git:set": {
    parse: parseBody((body) => {
      const branch = fields(body).string("branch");
      return branch === "" || isGitRef(branch)
        ? { op: "git:set", app: appName(body), branch }
        : refuse(
            "A branch name: letters, digits, dots, underscores, hyphens and slashes, not starting with a hyphen.",
          );
    }),
    commands: ({ app, branch }) => [
      step("git:set", app, "deploy-branch", ...(branch === "" ? [] : [branch])),
    ],
    streams: false,
    availability: unlessDeploying(),
  },
  "git:set-global": {
    parse: parseBody((body) => {
      const branch = fields(body).string("branch");
      return branch === "" || isGitRef(branch)
        ? { op: "git:set-global", branch }
        : refuse(
            "A branch name: letters, digits, dots, underscores, hyphens and slashes, not starting with a hyphen.",
          );
    }),
    commands: ({ branch }) => [
      step("git:set", "--global", "deploy-branch", ...(branch === "" ? [] : [branch])),
    ],
    streams: false,
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

/**
 * The app a request acts on and the activity feed links to; null for the operations that
 * belong to no single app: networks, the global settings, and rename and clone (their
 * target names both apps, and a renamed app's old name is gone).
 */
export const appOf = (req: OperationRequest) =>
  "app" in req && !("newName" in req) ? req.app : null;

/**
 * What the request is about, for toasts and the log: its app, a network, `old -> new` for
 * a rename or clone, or what a global setting is set to (`default` for a cleared branch).
 */
export function targetOf(req: OperationRequest) {
  if ("newName" in req) return `${req.app} -> ${req.newName}`;
  if ("app" in req) return req.app;
  if ("network" in req) return req.network;
  if ("domains" in req) return req.domains.join(" ");
  return req.branch || "default";
}

/** What a request changes in the server's read caches. */
export type Invalidation =
  | { kind: "apps"; apps: string[] }
  | { kind: "networks" }
  /** The host settings and every app, since defaults derive from them. */
  | { kind: "host" };

export function invalidationOf(req: OperationRequest): Invalidation {
  if ("newName" in req) return { kind: "apps", apps: [req.app, req.newName] };
  if ("app" in req) return { kind: "apps", apps: [req.app] };
  if ("network" in req) return { kind: "networks" };
  return { kind: "host" };
}

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
