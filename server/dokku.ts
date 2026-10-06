import { configValueProblem, isConfigKey } from "../shared/config";

/**
 * Dokku's app-name grammar: lowercase alphanumerics, dots and hyphens, starting with an
 * alphanumeric (what `apps:create` enforces on 0.38).
 */
export const isAppName = (name: string) => /^[a-z0-9][a-z0-9.-]*$/.test(name);

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

/** Procfile process types (`web`, `worker`); must not start with `-` so it can't pass as a flag. */
export const isProcessType = (type: string) => /^[a-z0-9][a-z0-9_-]*$/i.test(type);

/** Bounds for `logs` history; the route defaults and clamps its query to these. */
export const logTail = { default: 100, max: 1000 } as const;

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
 * Dokku over SSH. Every command pierhead may run is listed in `commands` (read-only);
 * each entry turns typed args into the argv sent after `dokku@host`. Adding one is one
 * line, e.g. `"ps:report": (app: string) => ["ps:report", appArg(app), "--format", "json"]`.
 * sshd joins the remote argv with spaces, so validate free-form args (app names) first.
 */
const commands = {
  version: () => ["version"],
  "apps:list": () => ["apps:list", "--format", "json"],
  "ps:report": report("ps"),
  "domains:report": report("domains"),
  "ports:report": report("ports"),
  "network:report": report("network"),
  "proxy:report": report("proxy"),
  "builder:report": report("builder"),
  "git:report": report("git"),
  "domains:report:global": globalReport("domains"),
  "proxy:report:global": globalReport("proxy"),
  "scheduler:report:global": globalReport("scheduler"),
  "builder:report:global": globalReport("builder"),
  "git:report:global": globalReport("git"),
  // Docker networks on the host, and the registered SSH keys and plugins.
  "network:list": () => ["network:list", "--format", "json"],
  "plugin:list": () => ["plugin:list", "--format", "json"],
  "ssh-keys:list": () => ["ssh-keys:list", "--format", "json"],
  // Writes. Dokku exits 0 for no-ops (start on a running app, anything on a never-deployed
  // one), only warning on a `!` line; the route turns those into conflicts.
  "ps:start": (app: string) => ["ps:start", appArg(app)],
  "ps:stop": (app: string) => ["ps:stop", appArg(app)],
  "ps:restart": (app: string) => ["ps:restart", appArg(app)],
  // Builds and redeploys (~25s locally, longer for real builds). Streamed, not `run`.
  "ps:rebuild": (app: string) => ["ps:rebuild", appArg(app)],
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

export type DokkuCommand = keyof typeof commands;

/**
 * Per-command `run` timeouts for commands slower than the default. Measured against the
 * local Dokku: start 24s, restart 22s (both wait on healthchecks), stop 1s.
 */
const commandTimeoutMs: Partial<Record<DokkuCommand, number>> = {
  "ps:start": 120_000,
  "ps:stop": 120_000,
  "ps:restart": 120_000,
  // Both restart the app unless told not to.
  "config:set": 120_000,
  "config:unset": 120_000,
};

/** Commands whose stdout is data, where surrounding whitespace is part of the value. */
const untrimmed: ReadonlySet<DokkuCommand> = new Set(["config:get"]);

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
    if (!built.ok) return built;
    const argv = built.argv;

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
    if (!built.ok) return built;
    try {
      const proc = Bun.spawn(
        [
          ...["ssh", "-tt", ...sshArgs],
          ...["-o", "ControlMaster=no", "-o", "ControlPath=none"],
          ...["--", ...built.argv],
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

  return Object.assign(run, { stream });
}

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

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
