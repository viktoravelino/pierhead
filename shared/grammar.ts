// Grammars for the free-form arguments of operations, shared by the server (which enforces
// them before anything reaches argv) and the frontend (which validates forms). Dokku
// itself accepts far more than these allow (`-h` as a domain, a domain another app serves).
import type { FormationEntry, NetworkAttachment, PortMapping } from "./types";

/**
 * Dokku's app-name grammar: lowercase alphanumerics, dots and hyphens, starting with an
 * alphanumeric (what `apps:create` enforces on 0.38).
 */
export const isAppName = (name: string) => /^[a-z0-9][a-z0-9.-]*$/.test(name);

/** A name for a new app: also short enough that `<name>.<global domain>` stays a DNS label. */
export const isNewAppName = (name: string) => isAppName(name) && name.length <= 63;

const domainLabel = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * A lowercase hostname, optionally with a leading `*.`: dot-separated labels of letters,
 * digits and inner hyphens, 253 characters at most. No scheme, port, path, space or
 * leading `-`.
 */
export function isDomain(domain: string) {
  if (domain.length > 253) return false;
  const labels = domain.replace(/^\*\./, "").split(".");
  return labels.every((label) => label.length <= 63 && domainLabel.test(label));
}

export const portSchemes = ["http", "https"] as const;

const isPort = (n: number) => Number.isInteger(n) && n >= 1 && n <= 65535;

/**
 * One word that cannot become two or act on a shell: no leading `-` (a flag), no
 * whitespace, quotes, `$`, backslash, backticks or shell metacharacters. This is the
 * grammar for values Dokku already holds (removals, restores), which can be anything it
 * accepted; the strict grammars are for what pierhead lets a user add.
 */
export const isSafeArg = (arg: string) =>
  arg.length > 0 &&
  arg.length <= 253 &&
  !arg.startsWith("-") &&
  !/[\s'"`$\\;&|<>(){}[\]!#~?*]/.test(arg);

/** `isSafeArg` for a domain, which may start with the `*.` wildcard label. */
export const isSafeDomain = (domain: string) =>
  isSafeArg(domain.startsWith("*.") ? domain.slice(2) : domain);

/**
 * Why a port mapping is refused, or null when it is well formed. `strict` (additions)
 * allows http and https only; otherwise any scheme Dokku could have stored, as long as it
 * is safe to pass on.
 */
export function portMappingProblem(
  { scheme, host, container }: PortMapping,
  strict = true,
) {
  if (strict && !portSchemes.some((s) => s === scheme)) {
    return "The scheme must be http or https.";
  }
  if (!strict && (!isSafeArg(scheme) || scheme.includes(":"))) {
    return "The scheme contains characters that cannot be passed to Dokku.";
  }
  if (!isPort(host) || !isPort(container)) {
    return "Ports are whole numbers from 1 to 65535.";
  }
  return null;
}

/** Reads `scheme:host:container`; null for anything malformed or out of range. */
export function parsePortMapping(text: string, strict = true): PortMapping | null {
  const [scheme, host, container, ...extra] = text.split(":");
  if (scheme === undefined || extra.length > 0) return null;
  if (!/^\d+$/.test(host ?? "") || !/^\d+$/.test(container ?? "")) return null;
  const mapping = { scheme, host: Number(host), container: Number(container) };
  return portMappingProblem(mapping, strict) ? null : mapping;
}

/** The `scheme:host:container` form Dokku takes and prints. */
export const formatPortMapping = ({ scheme, host, container }: PortMapping) =>
  `${scheme}:${host}:${container}`;

/** The first `scheme:host` pair used twice, which Dokku refuses ("being reused"). */
export function reusedPort(mappings: readonly PortMapping[]) {
  const seen = new Set<string>();
  for (const { scheme, host } of mappings) {
    const key = `${scheme}:${host}`;
    if (seen.has(key)) return key;
    seen.add(key);
  }
  return null;
}

/** An existing process type (a Procfile entry): safe to pass on, never a flag. */
export const isProcessType = (type: string) => /^[a-z0-9][a-z0-9_-]*$/i.test(type);

/** A process type pierhead lets a user add to the formation: lowercase, as Procfiles write them. */
export const isNewProcessType = (type: string) =>
  /^[a-z0-9][a-z0-9_-]*$/.test(type) && type.length <= 63;

/** The most containers of one process type the UI scales to. */
export const maxProcessCount = 20;

export const isProcessCount = (count: number) =>
  Number.isInteger(count) && count >= 0 && count <= maxProcessCount;

/** A name for a new Docker network, as `network:create` receives it. */
export const isNetworkName = (name: string) => /^[a-z0-9][a-z0-9_.-]{0,62}$/.test(name);

/** A network alias: one DNS label, as Docker resolves it. */
export const isNetworkAlias = (alias: string) =>
  domainLabel.test(alias) && alias.length <= 63;

/** The builders the builder panel offers; `null` is Dokku's builder that does nothing. */
export const builderNames = ["dockerfile", "herokuish", "pack", "null"] as const;

/**
 * A directory or file inside the repository: `/`-separated segments of letters, digits,
 * dots, underscores and hyphens, none of them `.` or `..`; never absolute and never
 * starting with `-`. For `build-dir` and `dockerfile-path`.
 */
export const isRepoPath = (path: string) =>
  path.length <= 200 &&
  /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(path) &&
  !path.startsWith("-") &&
  path.split("/").every((segment) => segment !== "." && segment !== "..");

/** `256m`, `1g`, `512` (Dokku reads a bare number as megabytes). */
export const isMemory = (memory: string) => /^[0-9]{1,9}[bkmg]?$/.test(memory);

/** CPUs as Docker takes them: a number with at most two decimals. */
export const isCpu = (cpu: string) => /^[0-9]{1,3}(\.[0-9]{1,2})?$/.test(cpu);

/** Where Dokku keeps named storage directories; pierhead only mounts directories under it. */
export const storageRoot = "/var/lib/dokku/data/storage";

/** A name for a new storage directory. */
export const isStorageName = (name: string) => /^[a-z0-9][a-z0-9_-]{0,62}$/.test(name);

/** The name of a directory that already exists under the storage root (Dokku allows dots). */
export const isExistingStorageName = (name: string) =>
  /^[a-z0-9][a-z0-9._-]{0,62}$/.test(name);

export const storageHostPath = (name: string) => `${storageRoot}/${name}`;

/** The name of the storage directory a host path is, or null for anything outside the root. */
export function storageNameOf(hostPath: string) {
  const name = hostPath.startsWith(`${storageRoot}/`)
    ? hostPath.slice(storageRoot.length + 1)
    : "";
  return isExistingStorageName(name) ? name : null;
}

const hasDotDot = (path: string) => path.split("/").includes("..");

/**
 * A path inside the container for a new mount: absolute, `/`-separated segments of
 * letters, digits, dots, underscores and hyphens, no `..`, no empty segment.
 */
export const isContainerPath = (path: string) =>
  path.length <= 200 && /^(\/[A-Za-z0-9._-]+)+$/.test(path) && !hasDotDot(path);

/** The same for a mount Dokku already holds: anything safe to pass on (no `:`, no `..`). */
export const isSafeContainerPath = (path: string) =>
  path.startsWith("/") && isSafeArg(path) && !path.includes(":") && !hasDotDot(path);

/** The `network:set` properties through which an app joins a network. */
export const networkAttachments = [
  "initial-network",
  "attach-post-create",
  "attach-post-deploy",
] as const satisfies readonly NetworkAttachment[];

/** The `type=count` form `ps:scale` takes. */
export const formatFormationEntry = ({ type, count }: FormationEntry) =>
  `${type}=${count}`;
