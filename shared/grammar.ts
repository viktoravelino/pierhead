// Grammars for the free-form arguments of operations, shared by the server (which enforces
// them before anything reaches argv) and the frontend (which validates forms). Dokku
// itself accepts far more than these allow (`-h` as a domain, a domain another app serves).
import type { PortMapping } from "./types";

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
