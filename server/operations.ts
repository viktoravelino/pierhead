import type { OperationRequest } from "../shared/operations";
import {
  deriveStatus,
  parseDomains,
  parsePorts,
  parseProcesses,
  parseReport,
  stripAnsi,
} from "../shared/parse";
import type { AppSummary, PortMapping } from "../shared/types";
import { domainOwners, isNotFound } from "./apps";
import type { Dokku, DokkuError } from "./dokku";

// What `POST /api/operations/:op` does around the shared table: checks against the live
// host before anything runs, running the steps, and the one thing pierhead remembers.

/** A request the host's current state rules out: the status and error body to answer with. */
export type Refusal = { status: 404 | 409 | 502; kind: string; message: string };

const failure = (error: DokkuError): Refusal =>
  isNotFound(error)
    ? { status: 404, kind: "not-found", message: "No such app" }
    : { status: 502, kind: error.kind, message: error.message };

/** What the checks learned: the target's status, null when there is no target yet. */
export type Preflight =
  | { ok: true; app: Pick<AppSummary, "status"> | null }
  | { ok: false; refusal: Refusal };

const refused = (status: 409, kind: string, message: string): Preflight => ({
  ok: false,
  refusal: { status, kind, message },
});

/**
 * Dokku accepts a lot it should not (a domain another app serves, removing what is not
 * set, a name that exists) and exits 0; these are the checks that turn those into 409s,
 * run after the body parsed and before any write.
 */
export async function preflight(dokku: Dokku, req: OperationRequest): Promise<Preflight> {
  if (req.op === "apps:create") {
    const exists = await dokku("apps:exists", req.app);
    if (exists.ok)
      return refused(409, "exists", `An app named ${req.app} already exists.`);
    if (isNotFound(exists.error)) return { ok: true, app: null };
    return { ok: false, refusal: failure(exists.error) };
  }

  const ps = await dokku("ps:report", req.app);
  if (!ps.ok) return { ok: false, refusal: failure(ps.error) };
  const report = parseReport(ps.stdout);
  const app = { status: deriveStatus(report, parseProcesses(report)) };

  switch (req.op) {
    case "domains:add":
    case "domains:set": {
      const owners = await domainOwners(dokku);
      if (!owners.ok) return { ok: false, refusal: failure(owners.error) };
      for (const domain of req.domains) {
        const owner = owners.value.get(domain);
        if (owner !== undefined && owner !== req.app) {
          return refused(
            409,
            "domain-in-use",
            `${domain} is already served by ${owner}.`,
          );
        }
      }
      return { ok: true, app };
    }
    case "domains:remove": {
      const current = await dokku("domains:report", req.app);
      if (!current.ok) return { ok: false, refusal: failure(current.error) };
      const set = parseDomains(parseReport(current.stdout)).domains;
      const missing = req.domains.find((domain) => !set.includes(domain));
      return missing === undefined
        ? { ok: true, app }
        : refused(409, "conflict", `${req.app} does not have the domain ${missing}.`);
    }
    case "ports:remove": {
      const current = await configuredPorts(dokku, req.app);
      if (!current.ok) return { ok: false, refusal: failure(current.error) };
      const missing = req.mappings.find(
        (m) => !current.ports.some((p) => samePort(p, m)),
      );
      return missing === undefined
        ? { ok: true, app }
        : refused(
            409,
            "conflict",
            `${req.app} has no mapping ${missing.scheme}:${missing.host}:${missing.container}.`,
          );
    }
    case "ps:start":
    case "ps:stop":
    case "ps:restart":
    case "ps:rebuild":
    case "apps:destroy":
    case "ports:add":
    case "ports:set":
    case "proxy:enable":
    case "proxy:disable":
      return { ok: true, app };
  }
}

const samePort = (a: PortMapping, b: PortMapping) =>
  a.scheme === b.scheme && a.host === b.host && a.container === b.container;

/** The explicit port map (`ports:set`/`ports:add`), not the one Dokku detected at deploy. */
async function configuredPorts(dokku: Dokku, app: string) {
  const result = await dokku("ports:report", app);
  return result.ok
    ? ({ ok: true, ports: parsePorts(parseReport(result.stdout), false) } as const)
    : result;
}

/**
 * The port maps apps had when their proxy was disabled through pierhead, since Dokku clears
 * the map then and `proxy:enable` does not bring it back. In memory: a restart forgets
 * them, and the enable dialog then simply has nothing to pre-fill.
 */
export const previousPorts = new Map<string, PortMapping[]>();

/** Read before `proxy:disable` runs: the map it is about to clear, null for any other request. */
export async function portsToRemember(dokku: Dokku, req: OperationRequest) {
  if (req.op !== "proxy:disable") return null;
  const current = await configuredPorts(dokku, req.app);
  return current.ok ? current.ports : null;
}

/** Bookkeeping after a request succeeded; `remembered` is what `portsToRemember` read. */
export function afterSuccess(req: OperationRequest, remembered: PortMapping[] | null) {
  switch (req.op) {
    case "proxy:disable":
      if (remembered && remembered.length > 0) previousPorts.set(req.app, remembered);
      return;
    case "proxy:enable":
    case "apps:destroy":
      previousPorts.delete(req.app);
      return;
    default:
      return;
  }
}

/** Dokku's output with its ANSI colours stripped, blank lines dropped. */
const cleanOutput = (...parts: string[]) => stripAnsi(parts.filter(Boolean).join("\n"));

/** Runs the steps in order, stopping at the first failure; resolves with their combined output. */
export async function runSteps(dokku: Dokku, steps: readonly (readonly string[])[]) {
  const outputs: string[] = [];
  for (const argv of steps) {
    const result = await dokku.step(argv);
    if (!result.ok) return { ok: false, error: result.error } as const;
    outputs.push(cleanOutput(result.stderr, result.stdout));
  }
  return { ok: true, output: cleanOutput(...outputs) } as const;
}

/**
 * Streams the steps in order, stopping at the first failure, with every non-blank line
 * (ANSI stripped) passed to `onLine`. Resolves with the failure, or null once all ended well.
 */
export async function streamSteps(
  dokku: Dokku,
  steps: readonly (readonly string[])[],
  onLine: (line: string) => Promise<void>,
): Promise<DokkuError | null> {
  for (const argv of steps) {
    const running = dokku.streamStep(argv);
    if (!running.ok) return running.error;
    for await (const raw of running.lines) {
      const line = stripAnsi(raw);
      if (line.trim()) await onLine(line);
    }
    const error = await running.exit;
    if (error) return { ...error, message: stripAnsi(error.message) };
  }
  return null;
}
