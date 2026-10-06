import { configValueProblem, isConfigKey } from "../shared/config";
import {
  builderNames,
  defaultProcessType,
  isAppName,
  isContainerPath,
  isCpu,
  isExistingStorageName,
  isGitRef,
  isGitUrl,
  isImageRef,
  isMemory,
  isNetworkAlias,
  isNetworkName,
  isNewProcessType,
  isProcessCount,
  isProcessType,
  isRepoPath,
  isSafeArg,
  isSafeContainerPath,
  isSafeDomain,
  isStorageName,
  networkAttachments,
  parsePortMapping,
  storageRoot,
} from "../shared/grammar";
import { createLimiter } from "./limit";

/** Throws on anything that is not a valid app name; sshd joins argv with spaces. */
function appArg(app: string) {
  if (!isAppName(app)) throw new Error(`Invalid app name: ${JSON.stringify(app)}`);
  return app;
}

/** Throws on anything that is not a valid env var name; it ends up in the remote command line. */
function keyArg(key: string) {
  if (!isConfigKey(key)) throw new Error("Invalid config key");
  return key;
}

/**
 * Quotes one argument for the shell sshd runs the command in: Dokku's authorized_keys
 * entry expands `$SSH_ORIGINAL_COMMAND` unquoted, so an unquoted value is word-split and
 * its quotes eaten. Single quotes keep everything literal except `'` itself.
 */
export const shellQuote = (arg: string) => `'${arg.replaceAll("'", `'\\''`)}'`;

/** Bounds for `logs` history; the route defaults and clamps its query to these. */
export const logTail = { default: 100, max: 1000 } as const;

/** Dokku's build ids are 14 base-36 characters; the check only has to keep a flag or a second word out. */
export const isBuildId = (id: string) => /^[a-z0-9]{6,32}$/.test(id);

/** `<plugin>:report` as JSON: for one app, or (no app) one object per line for every app. */
const report = (plugin: string) => (app?: string) => [
  `${plugin}:report`,
  ...(app === undefined ? [] : [appArg(app)]),
  "--format",
  "json",
];

/** `<plugin>:report --global` as JSON: the host-wide settings, one object. */
const globalReport = (plugin: string) => () => [
  `${plugin}:report`,
  "--global",
  "--format",
  "json",
];

/**
 * Dokku over SSH. Every command pierhead may run is listed in `commands` (reads, then the
 * writes the routes gate behind `PIERHEAD_ALLOW_WRITES`); each entry turns typed args into the argv sent after `dokku@host`. Adding one is one
 * line, e.g. `"ps:report": (app: string) => ["ps:report", appArg(app), "--format", "json"]`.
 * sshd joins the remote argv with spaces, so validate free-form args (app names) first.
 */
const commands = {
  version: () => ["version"],
  "apps:list": () => ["apps:list", "--format", "json"],
  "apps:exists": (app: string) => ["apps:exists", appArg(app)],
  // Exit 0 while a deploy lock is held, 1 ("Deploy lock does not exist") when it is not.
  "apps:locked": (app: string) => ["apps:locked", appArg(app)],
  "ps:report": report("ps"),
  "domains:report": report("domains"),
  "ports:report": report("ports"),
  "network:report": report("network"),
  "proxy:report": report("proxy"),
  "builder:report": report("builder"),
  "git:report": report("git"),
  "resource:report": report("resource"),
  "builder-dockerfile:report": report("builder-dockerfile"),
  "docker-options:report": report("docker-options"),
  "domains:report:global": globalReport("domains"),
  "proxy:report:global": globalReport("proxy"),
  "scheduler:report:global": globalReport("scheduler"),
  "builder:report:global": globalReport("builder"),
  "git:report:global": globalReport("git"),
  "ps:scale": (app: string) => ["ps:scale", appArg(app), "--format", "json"],
  "storage:list": (app: string) => ["storage:list", appArg(app), "--format", "json"],
  // The app's last 20 builds and deploys, newest first.
  "builds:list": (app: string) => ["builds:list", appArg(app), "--format", "json"],
  // The log of one record. Dokku prints `no such build` (exit 1) for an id it lacks.
  "builds:output": (app: string, id: string) => {
    if (!isBuildId(id)) throw new Error(`Invalid build id: ${JSON.stringify(id)}`);
    return ["builds:output", appArg(app), id];
  },
  // Docker networks on the host, and the registered SSH keys and plugins.
  "network:list": () => ["network:list", "--format", "json"],
  "plugin:list": () => ["plugin:list", "--format", "json"],
  "ssh-keys:list": () => ["ssh-keys:list", "--format", "json"],
  // Writes that take a body of free-form values are in `operationSteps`; these two keep
  // their own routes because their values are secrets.
  // Config. Values are only ever read one at a time (`config:get`); `config:set` carries
  // the value as the single argument `KEY=value`, shell-quoted for the SSH hop. Without
  // `--no-restart` Dokku redeploys the app (~22s locally), even when `unset` found nothing.
  "config:keys": (app: string) => ["config:keys", appArg(app)],
  "config:get": (app: string, key: string) => ["config:get", appArg(app), keyArg(key)],
  "config:set": (app: string, key: string, value: string, restart: boolean) => {
    // The message must not echo the value: it ends up in the route's error body.
    if (configValueProblem(value)) throw new Error("Invalid config value");
    return [
      "config:set",
      ...(restart ? [] : ["--no-restart"]),
      appArg(app),
      shellQuote(`${keyArg(key)}=${value}`),
    ];
  },
  "config:unset": (app: string, key: string, restart: boolean) => [
    "config:unset",
    ...(restart ? [] : ["--no-restart"]),
    appArg(app),
    keyArg(key),
  ],
  // Follows the app's output (`--tail`) after replaying the last `tail` lines. Streamed, not `run`.
  logs: (app: string, tail: number, processType?: string) => {
    if (!Number.isInteger(tail) || tail < 1 || tail > logTail.max) {
      throw new Error(`Invalid tail: ${tail}`);
    }
    if (processType !== undefined && !isProcessType(processType)) {
      throw new Error(`Invalid process type: ${JSON.stringify(processType)}`);
    }
    // Over SSH, Dokku ignores the short `-n 2` (replaying 100 lines) and, with flags
    // before the app, reads the `100` in `-t -n 100` as the app name. Long flags, app first.
    return [
      "logs",
      appArg(app),
      "--tail",
      ...["--num", String(tail)],
      ...(processType === undefined ? [] : ["--ps", processType]),
    ];
  },
} satisfies Record<string, (...args: never[]) => string[]>;

/** Checks one step's args (everything after the command name) and returns the argv to send. */
type StepBuilder = (args: string[]) => string[];

/** `<command> [flags] <app>`: exactly the fixed flags, then an app name. */
const appStep =
  (name: string, flags: string[] = []): StepBuilder =>
  (args) => {
    const [app, ...rest] = args.slice(flags.length);
    if (args.slice(0, flags.length).join(" ") !== flags.join(" ") || rest.length > 0) {
      throw new Error(`Unexpected arguments for ${name}`);
    }
    return [name, ...flags, appArg(app ?? "")];
  };

/** `<command> <app> <value>...` with at least one value, each checked and quoted by `value`. */
const listStep =
  (name: string, value: (arg: string) => string): StepBuilder =>
  ([app = "", ...values]) => {
    if (values.length === 0) throw new Error(`${name} needs at least one value`);
    return [name, appArg(app), ...values.map(value)];
  };

/**
 * Whether a domain may reach the shell at all (the table's `parse` holds additions to the
 * stricter hostname grammar). It can contain `*`, which the remote shell would expand, so
 * it is quoted.
 */
function domainArg(domain: string) {
  if (!isSafeDomain(domain)) throw new Error(`Invalid domain: ${JSON.stringify(domain)}`);
  return shellQuote(domain);
}

/** `http:80:5000` with a scheme that is safe to pass on; nothing here is left for a shell to act on. */
function portArg(mapping: string) {
  if (!parsePortMapping(mapping, false)) {
    throw new Error(`Invalid port mapping: ${JSON.stringify(mapping)}`);
  }
  return mapping;
}

/** `--network-alias <alias>` as `docker-options` takes it; one argument with a space, so it is quoted. */
function aliasOption(option: string, strict: boolean) {
  const alias = option.startsWith("--network-alias ") ? option.slice(16) : "";
  if (strict ? !isNetworkAlias(alias) : !isSafeArg(alias)) {
    throw new Error(`Invalid network alias option: ${JSON.stringify(option)}`);
  }
  return shellQuote(option);
}

/** `docker-options:<add|remove> <app> deploy "--network-alias <alias>"`: nothing else may be set through it. */
const aliasStep =
  (name: string, strict: boolean): StepBuilder =>
  ([app = "", phase, option = "", ...rest]) => {
    if (phase !== "deploy" || rest.length > 0) {
      throw new Error(`Unexpected arguments for ${name}`);
    }
    return [name, appArg(app), phase, aliasOption(option, strict)];
  };

/** `<command> [flags] <value>`: exactly the fixed flags, then one value checked by `valid`. */
const valueStep =
  (
    name: string,
    flags: string[],
    valid: (value: string) => boolean,
    what: string,
  ): StepBuilder =>
  (args) => {
    const [value = "", ...rest] = args.slice(flags.length);
    if (args.slice(0, flags.length).join(" ") !== flags.join(" ") || rest.length > 0) {
      throw new Error(`Unexpected arguments for ${name}`);
    }
    if (!valid(value)) throw new Error(`Invalid ${what}: ${JSON.stringify(value)}`);
    return [name, ...flags, value];
  };

/** `ps:scale [--skip-deploy] <app> <type>=<count>...`, each entry on the process-type and count grammar. */
const scaleStep: StepBuilder = (args) => {
  const skip = args[0] === "--skip-deploy";
  const [app = "", ...entries] = skip ? args.slice(1) : args;
  if (entries.length === 0) throw new Error("ps:scale needs at least one entry");
  return [
    "ps:scale",
    ...(skip ? ["--skip-deploy"] : []),
    appArg(app),
    ...entries.map((entry) => {
      const [type = "", count = "", ...extra] = entry.split("=");
      if (extra.length > 0 || !isNewProcessType(type) || !/^\d+$/.test(count)) {
        throw new Error(`Invalid process count: ${JSON.stringify(entry)}`);
      }
      if (!isProcessCount(Number(count))) throw new Error(`Invalid count in ${entry}`);
      return entry;
    }),
  ];
};

/** `network:set <app> <property> [<network>...]`: the three attach properties, networks safe to pass on. */
const networkSetStep: StepBuilder = ([app = "", property = "", ...networks]) => {
  if (!networkAttachments.some((p) => p === property)) {
    throw new Error(`Invalid network property: ${JSON.stringify(property)}`);
  }
  for (const network of networks) {
    if (!isSafeArg(network))
      throw new Error(`Invalid network: ${JSON.stringify(network)}`);
  }
  return ["network:set", appArg(app), property, ...networks];
};

/** `builder:set <app> build-dir|selected [<value>]`; no value clears. */
const builderStep =
  (name: string, properties: readonly string[]): StepBuilder =>
  ([app = "", property = "", ...values]) => {
    if (!properties.includes(property) || values.length > 1) {
      throw new Error(`Unexpected arguments for ${name}`);
    }
    const [value] = values;
    const valid =
      value === undefined ||
      (property === "selected"
        ? builderNames.some((n) => n === value)
        : isRepoPath(value));
    if (!valid) throw new Error(`Invalid ${property}: ${JSON.stringify(value)}`);
    return [name, appArg(app), property, ...values];
  };

/**
 * `resource:<limit|reserve>[-clear] [--process-type <t>] [--memory <m>] [--cpu <c>] <app>`:
 * the flags in that order, each at most once, the last argument the app.
 */
const resourceStep =
  (name: string, flags: Record<string, (value: string) => boolean>): StepBuilder =>
  (args) => {
    const rest = [...args];
    const argv = [name];
    for (const [flag, valid] of Object.entries(flags)) {
      if (rest[0] !== flag) continue;
      const [, value = ""] = rest.splice(0, 2);
      if (!valid(value)) throw new Error(`Invalid ${flag}: ${JSON.stringify(value)}`);
      argv.push(flag, value);
    }
    const [app, ...extra] = rest;
    if (extra.length > 0) throw new Error(`Unexpected arguments for ${name}`);
    return [...argv, appArg(app ?? "")];
  };

/** A process type, or `_default_` for the setting that applies to every type. */
const isResourceProcessType = (type: string) =>
  type === defaultProcessType || isProcessType(type);

const resourceFlags = {
  "--process-type": isResourceProcessType,
  "--memory": isMemory,
  "--cpu": isCpu,
};

/** `<host>:<container>` for a directory under the storage root, the only mounts pierhead makes. */
const mountStep =
  (
    name: string,
    validName: (name: string) => boolean,
    validPath: (path: string) => boolean,
  ): StepBuilder =>
  ([app = "", mount = "", ...rest]) => {
    const prefix = `${storageRoot}/`;
    const [dir = "", path = ""] = mount.startsWith(prefix)
      ? mount.slice(prefix.length).split(/:(.*)/s)
      : [];
    if (rest.length > 0 || !validName(dir) || !validPath(path)) {
      throw new Error(`Invalid mount: ${JSON.stringify(mount)}`);
    }
    return [name, appArg(app), mount];
  };

/** `git:from-image <app> <image>`: no committer name or email, so Dokku uses its defaults. */
const imageStep: StepBuilder = ([app = "", image = "", ...rest]) => {
  if (rest.length > 0) throw new Error("Unexpected arguments for git:from-image");
  if (!isImageRef(image)) throw new Error(`Invalid image: ${JSON.stringify(image)}`);
  return ["git:from-image", appArg(app), image];
};

/** `git:sync [--build] <app> <url> [<ref>]`; `--build-if-changes` and `--skip-deploy-branch` are not offered. */
const syncStep: StepBuilder = (args) => {
  const build = args[0] === "--build";
  const [app = "", url = "", ref, ...rest] = build ? args.slice(1) : args;
  if (rest.length > 0) throw new Error("Unexpected arguments for git:sync");
  if (!isGitUrl(url)) throw new Error(`Invalid git URL: ${JSON.stringify(url)}`);
  if (ref !== undefined && !isGitRef(ref)) {
    throw new Error(`Invalid git ref: ${JSON.stringify(ref)}`);
  }
  return [
    "git:sync",
    ...(build ? ["--build"] : []),
    appArg(app),
    url,
    ...(ref === undefined ? [] : [ref]),
  ];
};

/** `git:set <app> deploy-branch [<branch>]`; no branch clears. */
const gitSetStep: StepBuilder = ([app = "", property = "", ...values]) => {
  if (property !== "deploy-branch" || values.length > 1) {
    throw new Error("Unexpected arguments for git:set");
  }
  const [branch] = values;
  if (branch !== undefined && !isGitRef(branch)) {
    throw new Error(`Invalid branch: ${JSON.stringify(branch)}`);
  }
  return ["git:set", appArg(app), property, ...values];
};

/**
 * The writes behind `POST /api/operations/:op`, keyed by Dokku command. Each re-checks the
 * argv the shared operations table built (the server never trusts the client), so a
 * request that slipped past `parse` still cannot reach the shell.
 */
const operationSteps = {
  "ps:start": appStep("ps:start"),
  "ps:stop": appStep("ps:stop"),
  "ps:restart": appStep("ps:restart"),
  // Builds and redeploys (~25s locally, longer for real builds). Streamed.
  "ps:rebuild": appStep("ps:rebuild"),
  "apps:create": appStep("apps:create"),
  // `--force` skips Dokku's name prompt, which fails without a tty; the route checks the typed name.
  "apps:destroy": appStep("apps:destroy", ["--force"]),
  // Releases a deploy lock a failed deploy left behind; the route checks no build is running.
  "apps:unlock": appStep("apps:unlock"),
  "domains:add": listStep("domains:add", domainArg),
  "domains:remove": listStep("domains:remove", domainArg),
  "domains:set": listStep("domains:set", domainArg),
  "ports:add": listStep("ports:add", portArg),
  "ports:remove": listStep("ports:remove", portArg),
  "ports:set": listStep("ports:set", portArg),
  // Both redeploy a deployed app and `disable` clears its port map.
  "proxy:enable": appStep("proxy:enable"),
  "proxy:disable": appStep("proxy:disable"),
  // Redeploys unless `--skip-deploy`; the route streams it then.
  "ps:scale": scaleStep,
  "network:create": valueStep("network:create", [], isNetworkName, "network name"),
  "network:destroy": valueStep("network:destroy", ["--force"], isSafeArg, "network name"),
  "network:set": networkSetStep,
  "docker-options:add": aliasStep("docker-options:add", true),
  "docker-options:remove": aliasStep("docker-options:remove", false),
  // Both pull code and deploy it, so the route streams them; the git URL and ref are
  // grammar-checked (no characters a shell reads), so they need no quoting.
  "git:from-image": imageStep,
  "git:sync": syncStep,
  "git:set": gitSetStep,
  "builder:set": builderStep("builder:set", ["build-dir", "selected"]),
  "builder-dockerfile:set": builderStep("builder-dockerfile:set", ["dockerfile-path"]),
  "resource:limit": resourceStep("resource:limit", resourceFlags),
  "resource:reserve": resourceStep("resource:reserve", resourceFlags),
  "resource:limit-clear": resourceStep("resource:limit-clear", {
    "--process-type": isResourceProcessType,
  }),
  "resource:reserve-clear": resourceStep("resource:reserve-clear", {
    "--process-type": isResourceProcessType,
  }),
  "storage:create": valueStep("storage:create", [], isStorageName, "storage name"),
  "storage:mount": mountStep("storage:mount", isStorageName, isContainerPath),
  "storage:unmount": mountStep(
    "storage:unmount",
    isExistingStorageName,
    isSafeContainerPath,
  ),
} satisfies Record<string, StepBuilder>;

const isStep = (name: string): name is keyof typeof operationSteps =>
  Object.hasOwn(operationSteps, name);

/** Validates one operation step (argv after `dokku`); a failure is a `command` error. */
export function buildStep(argv: readonly string[]) {
  const [name = "", ...args] = argv;
  try {
    if (!isStep(name)) throw new Error(`Not allowed: ${name}`);
    return { ok: true, argv: operationSteps[name](args) } as const;
  } catch (e) {
    return { ok: false, error: { kind: "command", message: errorMessage(e) } } as const;
  }
}

export type DokkuCommand = keyof typeof commands;

/**
 * Per-command `run` timeouts for commands slower than the default. Measured against the
 * local Dokku: start 24s, restart 22s (both wait on healthchecks), stop 1s.
 */
const commandTimeoutMs: Partial<Record<string, number>> = {
  "ps:start": 120_000,
  "ps:stop": 120_000,
  "ps:restart": 120_000,
  // Both restart the app unless told not to.
  "config:set": 120_000,
  "config:unset": 120_000,
  // Stops and removes every container and the image.
  "apps:destroy": 120_000,
  // Redeploys a deployed app (~25s locally); the routes stream them, this is the quiet case.
  "proxy:enable": 120_000,
  "proxy:disable": 120_000,
};

/** Commands whose stdout is data, where surrounding whitespace is part of the value. */
const untrimmed: ReadonlySet<string> = new Set(["config:get"]);

export type DokkuError = {
  kind: "timeout" | "connection" | "command" | "spawn" | "parse" | "not-found";
  message: string;
};

/** `stderr` of a successful call carries Dokku's progress and warning lines (`-----> ...`, ` !     ...`). */
export type DokkuResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; error: DokkuError };

export type DokkuConfig = {
  host: string;
  port: number;
  user: string;
  keyPath: string;
  knownHostsPath: string;
  timeoutMs: number;
};

/** Reads and validates connection settings once; throws one error listing everything wrong. */
export function loadDokkuConfig(env: NodeJS.ProcessEnv = process.env): DokkuConfig {
  const required = ["DOKKU_SSH_HOST", "DOKKU_SSH_KEY", "DOKKU_SSH_KNOWN_HOSTS"] as const;
  const problems: string[] = required
    .filter((name) => !env[name])
    .map((name) => `${name} is required`);

  const port = Number(env.DOKKU_SSH_PORT ?? 22);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push(`DOKKU_SSH_PORT must be 1-65535, got "${env.DOKKU_SSH_PORT}"`);
  }
  const timeoutMs = Number(env.DOKKU_SSH_TIMEOUT_MS ?? 10_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    problems.push(`DOKKU_SSH_TIMEOUT_MS must be a positive integer`);
  }
  if (problems.length > 0) {
    throw new Error(`Invalid Dokku SSH configuration:\n  - ${problems.join("\n  - ")}`);
  }

  return {
    host: env.DOKKU_SSH_HOST ?? "",
    port,
    user: env.DOKKU_SSH_USER ?? "dokku",
    keyPath: env.DOKKU_SSH_KEY ?? "",
    knownHostsPath: env.DOKKU_SSH_KNOWN_HOSTS ?? "",
    timeoutMs,
  };
}

/**
 * Returns a runner bound to one host. All calls share an SSH control socket
 * (ControlMaster/ControlPersist), so only the first call pays the handshake.
 */
export function createDokku(config: DokkuConfig) {
  const options = {
    IdentitiesOnly: "yes",
    BatchMode: "yes",
    StrictHostKeyChecking: "accept-new",
    UserKnownHostsFile: config.knownHostsPath,
    ConnectTimeout: Math.max(1, Math.ceil(config.timeoutMs / 2000)),
    ControlMaster: "auto",
    // Not os.tmpdir(): on macOS that is ~50 chars, and ssh fails above ~104 for the socket path.
    // %C hashes host, port and user, so different hosts never share a socket.
    ControlPath: "/tmp/pierhead-ssh-%C",
    ControlPersist: 60,
  };
  const sshArgs = [
    ...["-p", String(config.port), "-i", config.keyPath],
    ...Object.entries(options).flatMap(([key, value]) => ["-o", `${key}=${value}`]),
    `${config.user}@${config.host}`,
  ];

  /** Runs one allowlisted command and resolves to a result; never throws. */
  async function run<C extends DokkuCommand>(
    name: C,
    ...args: Parameters<(typeof commands)[C]>
  ): Promise<DokkuResult> {
    const built = buildArgv(name, args);
    return built.ok ? exec(name, built.argv) : built;
  }

  /** Runs one operation step (argv after `dokku`, see `buildStep`); never throws. */
  async function step(argv: readonly string[]): Promise<DokkuResult> {
    const built = buildStep(argv);
    return built.ok ? exec(argv[0] ?? "", built.argv) : built;
  }

  // Every quick call shares one SSH connection, and sshd refuses more than MaxSessions (10)
  // sessions on it, so extra parallel calls queue here. The timeout starts when a call does.
  const limit = createLimiter(maxParallelCalls);

  const exec = (name: string, argv: string[]) => limit(() => execNow(name, argv));

  async function execNow(name: string, argv: string[]): Promise<DokkuResult> {
    const timeoutMs = commandTimeoutMs[name] ?? config.timeoutMs;
    let timedOut = false;
    try {
      const proc = Bun.spawn(["ssh", ...sshArgs, "--", ...argv], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, timeoutMs);

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      clearTimeout(timer);

      if (timedOut) {
        return {
          ok: false,
          error: { kind: "timeout", message: `Timed out after ${timeoutMs}ms` },
        };
      }
      if (exitCode === 0)
        return {
          ok: true,
          stdout: untrimmed.has(name) ? stdout : stdout.trim(),
          stderr: stderr.trim(),
        };
      // ssh itself exits 255 on connection/auth failure; anything else is the remote command.
      return {
        ok: false,
        error: {
          kind: exitCode === 255 ? "connection" : "command",
          message: stderr.trim() || `ssh exited with code ${exitCode}`,
        },
      };
    } catch (e) {
      return { ok: false, error: { kind: "spawn", message: errorMessage(e) } };
    }
  }

  /**
   * Starts one allowlisted command and streams its stdout line by line. Never throws;
   * call `kill()` when the consumer goes away.
   *
   * Two choices make `kill()` end the remote command, which otherwise keeps tailing
   * (sshd only notices a dead client when the command next writes, which may be never):
   * its own SSH connection (killing a multiplexed client leaves the session open) and a
   * forced pty (`-tt`), so sshd hangs up the command when the connection closes. The pty
   * merges the remote's stderr into stdout, so a failure's message is its last line.
   */
  function stream<C extends DokkuCommand>(
    name: C,
    ...args: Parameters<(typeof commands)[C]>
  ): DokkuStream {
    const built = buildArgv(name, args);
    return built.ok ? spawnStream(built.argv) : built;
  }

  /** `stream` for an operation step (see `buildStep`). */
  function streamStep(argv: readonly string[]): DokkuStream {
    const built = buildStep(argv);
    return built.ok ? spawnStream(built.argv) : built;
  }

  function spawnStream(argv: string[]): DokkuStream {
    try {
      const proc = Bun.spawn(
        [
          ...["ssh", "-tt", ...sshArgs],
          ...["-o", "ControlMaster=no", "-o", "ControlPath=none"],
          ...["--", ...argv],
        ],
        // ssh with a pty wants a live stdin; it is never written to.
        { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      );
      const stderr = new Response(proc.stderr).text();
      let lastLine = "";
      async function* lines() {
        for await (const line of readLines(proc.stdout)) {
          if (line.trim()) lastLine = line.trim();
          yield line;
        }
      }
      const exit = async (): Promise<DokkuError | null> => {
        const [code, message] = await Promise.all([proc.exited, stderr]);
        if (code === 0) return null;
        // ssh's own stderr only matters when it could not connect; otherwise it is just
        // "Connection to host closed." noise next to the command's last line.
        const connection = code === 255;
        const reason = connection ? message.trim() : lastLine;
        return {
          kind: connection ? "connection" : "command",
          message: reason || `ssh exited with code ${code}`,
        };
      };
      // Observed: a kill landing while sshd is still starting the command (about 100-300ms
      // in) loses the hangup, and the remote command tails forever. Let ssh settle first.
      const started = Date.now();
      const kill = () =>
        void setTimeout(
          () => proc.kill(),
          Math.max(0, settleMs - (Date.now() - started)),
        );
      return { ok: true, lines: lines(), exit: exit(), kill };
    } catch (e) {
      return { ok: false, error: { kind: "spawn", message: errorMessage(e) } };
    }
  }

  return Object.assign(run, { stream, step, streamStep });
}

/** Parallel quick calls on the shared connection; sshd's default MaxSessions is 10. */
const maxParallelCalls = 8;

/** Minimum time a streaming ssh lives before `kill` takes effect, see `stream`. */
const settleMs = 1000;

/** A started command: its stdout lines, then (once it exits) the error or null. */
export type DokkuStream =
  | { ok: false; error: DokkuError }
  | {
      ok: true;
      lines: AsyncGenerator<string, void>;
      exit: Promise<DokkuError | null>;
      kill: () => void;
    };

/** Looks up a command and builds its argv; a validation failure becomes a `command` error. */
function buildArgv<C extends DokkuCommand>(
  name: C,
  args: Parameters<(typeof commands)[C]>,
) {
  try {
    // TS can't correlate `name` with `args` inside the generic body, hence the cast.
    const argv = (commands[name] as (...a: typeof args) => string[])(...args);
    return { ok: true, argv } as const;
  } catch (e) {
    return { ok: false, error: { kind: "command", message: errorMessage(e) } } as const;
  }
}

/** Splits a byte stream into lines (without the `\n`); a final unterminated line counts. */
async function* readLines(source: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of source) {
    rest += decoder.decode(chunk, { stream: true });
    const parts = rest.split("\n");
    rest = parts.pop() ?? "";
    yield* parts;
  }
  rest += decoder.decode();
  if (rest) yield rest;
}

/** A runner as returned by `createDokku`. */
export type Dokku = ReturnType<typeof createDokku>;

/** The read-only part of `Dokku`: what the checks and reads need, so a test can supply a fake. */
export type DokkuRun = <C extends DokkuCommand>(
  name: C,
  ...args: Parameters<(typeof commands)[C]>
) => Promise<DokkuResult>;

/** The write part of `Dokku`: operation steps, quick and streamed. */
export type DokkuSteps = Pick<Dokku, "step" | "streamStep">;

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
