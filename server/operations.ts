import { formatPortMapping, storageHostPath } from "../shared/grammar";
import { type OperationRequest, operationAvailability } from "../shared/operations";
import { stripAnsi } from "../shared/parse";
import type { AppDetail, PortMapping, ProxyRestore } from "../shared/types";
import { domainOwners, getApp, isNotFound, listNetworks } from "./apps";
import type { DokkuError, DokkuRun, DokkuSteps } from "./dokku";

// What `POST /api/operations/:op` does around the shared table: checks against the live
// host before anything runs, running the steps, and the one thing pierhead remembers.

/** A request the host's current state rules out: the status and error body to answer with. */
export type Refusal = { status: 404 | 409 | 502; kind: string; message: string };

const failure = (error: DokkuError): Refusal =>
  isNotFound(error)
    ? { status: 404, kind: "not-found", message: "No such app" }
    : { status: 502, kind: error.kind, message: error.message };

/** What the checks learned: the app's live detail, null when there is no target yet. */
export type Preflight =
  | { ok: true; app: AppDetail | null }
  | { ok: false; refusal: Refusal };

const refused = (status: 409, kind: string, message: string): Preflight => ({
  ok: false,
  refusal: { status, kind, message },
});

/** Dokku's `apps:locked` text for an app with no deploy lock (it exits 1 then). */
const noLock = "Deploy lock does not exist";

/**
 * Whether the request makes sense on the host right now, run after the body parsed and
 * before any write. Dokku accepts a lot it should not (a domain another app serves,
 * removing what is not set, a name that exists, editing domains of a proxy-less app) and
 * exits 0; these checks turn those into 409s. They read live state, never the cache.
 */
export async function preflight(
  dokku: DokkuRun,
  req: OperationRequest,
): Promise<Preflight> {
  if (req.op === "apps:create") {
    const exists = await dokku("apps:exists", req.app);
    if (exists.ok)
      return refused(409, "exists", `An app named ${req.app} already exists.`);
    if (!isNotFound(exists.error)) return { ok: false, refusal: failure(exists.error) };
    // A dotted name becomes the app's vhost as it is, so it must not be someone's domain.
    const owners = await domainOwners(dokku);
    if (!owners.ok) return { ok: false, refusal: failure(owners.error) };
    const owner = owners.value.get(req.app);
    return owner === undefined
      ? { ok: true, app: null }
      : refused(409, "domain-in-use", `${req.app} is already a domain of ${owner}.`);
  }

  if (req.op === "network:create" || req.op === "network:destroy") {
    return networkPreflight(dokku, req);
  }

  // Dokku's deploy lock is the only sign of a deploy in progress (no report shows one);
  // it also catches the rebuild or proxy toggle this server is streaming.
  const lock = await dokku("apps:locked", req.app);
  if (lock.ok) {
    return refused(
      409,
      "deploy-in-progress",
      `${req.app} holds a deploy lock: a deploy is running, or one died and left it (clear it with \`dokku apps:unlock ${req.app}\`).`,
    );
  }
  if (!lock.error.message.includes(noLock)) {
    return { ok: false, refusal: failure(lock.error) };
  }

  const detail = await getApp(dokku, req.app);
  if (!detail.ok) return { ok: false, refusal: failure(detail.error) };
  const app = detail.value;

  const availability = operationAvailability(req.op, app);
  if (!availability.ok) return refused(409, "unavailable", availability.reason);
  // Settings that only apply on the next deploy offer to rebuild; refuse a rebuild that cannot run.
  if ("rebuild" in req && req.rebuild) {
    const rebuild = operationAvailability("ps:rebuild", app);
    if (!rebuild.ok)
      return refused(409, "unavailable", `Cannot rebuild: ${rebuild.reason}`);
  }

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
      const missing = req.domains.find((domain) => !app.domains.includes(domain));
      return missing === undefined
        ? { ok: true, app }
        : refused(409, "conflict", `${req.app} does not have the domain ${missing}.`);
    }
    case "ports:remove": {
      // Only a map that was set can be removed from; Dokku's detected one is not.
      const missing = req.mappings.find(
        (m) => !app.ports.some((p) => !p.detected && samePort(p, m)),
      );
      return missing === undefined
        ? { ok: true, app }
        : refused(
            409,
            "conflict",
            `${req.app} has no set mapping ${formatPortMapping(missing)}.`,
          );
    }
    case "network:set":
      return checkNetworkSet(dokku, req, app);
    case "network:alias-add":
      return app.aliases.includes(req.alias)
        ? refused(409, "conflict", `${req.app} already has the alias ${req.alias}.`)
        : { ok: true, app };
    case "network:alias-remove":
      return app.aliases.includes(req.alias)
        ? { ok: true, app }
        : refused(409, "conflict", `${req.app} has no alias ${req.alias}.`);
    case "storage:mount": {
      const taken = app.storage.find((m) => m.containerPath === req.containerPath);
      return taken === undefined
        ? { ok: true, app }
        : refused(
            409,
            "conflict",
            `${req.containerPath} is already a mount of ${req.app} (${taken.hostPath}).`,
          );
    }
    case "storage:unmount": {
      // Only what pierhead mounts: a directory under the storage root, at this exact path.
      const hostPath = storageHostPath(req.name);
      return app.storage.some(
        (m) => m.hostPath === hostPath && m.containerPath === req.containerPath,
      )
        ? { ok: true, app }
        : refused(
            409,
            "conflict",
            `${req.app} does not mount ${hostPath} at ${req.containerPath}.`,
          );
    }
    case "ps:start":
    case "ps:stop":
    case "ps:restart":
    case "ps:rebuild":
    case "ps:scale":
    case "builder:set":
    case "resource:set":
    case "resource:clear":
    case "apps:destroy":
    case "ports:add":
    case "ports:set":
    case "proxy:enable":
    case "proxy:disable":
      return { ok: true, app };
  }
}

/**
 * `network:create` and `network:destroy`, from the host's networks and the apps' reports
 * (Dokku destroys a network an app still names, and Docker only objects once a container is on it).
 */
async function networkPreflight(
  dokku: DokkuRun,
  req: Extract<OperationRequest, { op: "network:create" | "network:destroy" }>,
): Promise<Preflight> {
  const networks = await listNetworks(dokku);
  if (!networks.ok) return { ok: false, refusal: failure(networks.error) };
  const found = networks.value.find((n) => n.name === req.network);
  if (req.op === "network:create") {
    return found
      ? refused(409, "exists", `A network named ${req.network} already exists.`)
      : { ok: true, app: null };
  }
  if (!found) {
    return {
      ok: false,
      refusal: { status: 404, kind: "not-found", message: "No such network" },
    };
  }
  if (!found.dokkuManaged) {
    return refused(
      409,
      "unmanaged",
      `${req.network} was not created through Dokku, so pierhead leaves it alone.`,
    );
  }
  if (found.members.length > 0) {
    const apps = found.members.map((m) => m.app).join(", ");
    return refused(409, "in-use", `${req.network} is still used by ${apps}.`);
  }
  return { ok: true, app: null };
}

/** Every network must exist, and Dokku refuses one app attaching a network after both creating and deploying. */
async function checkNetworkSet(
  dokku: DokkuRun,
  req: Extract<OperationRequest, { op: "network:set" }>,
  app: AppDetail,
): Promise<Preflight> {
  if (req.networks.length > 0) {
    const networks = await listNetworks(dokku);
    if (!networks.ok) return { ok: false, refusal: failure(networks.error) };
    const missing = req.networks.find((n) => !networks.value.some((v) => v.name === n));
    if (missing !== undefined) {
      return refused(409, "unknown-network", `There is no network named ${missing}.`);
    }
  }
  const counterpart =
    req.property === "attach-post-create"
      ? "attach-post-deploy"
      : req.property === "attach-post-deploy"
        ? "attach-post-create"
        : null;
  const twice =
    counterpart && req.networks.find((n) => app.attachments[counterpart].includes(n));
  if (counterpart && twice) {
    return refused(
      409,
      "conflict",
      `${twice} is already attached through ${counterpart}; Dokku attaches a network once.`,
    );
  }
  return { ok: true, app };
}

const samePort = (a: PortMapping, b: PortMapping) =>
  a.scheme === b.scheme && a.host === b.host && a.container === b.container;

/**
 * What apps had when their proxy was disabled through pierhead: Dokku clears the port map
 * and the domains then, and `proxy:enable` brings back only the default domain. In
 * memory: a restart forgets them, and the enable dialog then has nothing to restore.
 */
export const proxyRestore = new Map<string, ProxyRestore>();

/**
 * Read from the live detail before `proxy:disable` runs: what it is about to clear (set
 * ports, custom domains), null when there is nothing to lose or for any other request.
 */
export function restoreToSave(req: OperationRequest, app: AppDetail | null) {
  if (req.op !== "proxy:disable" || !app) return null;
  const ports = app.ports
    .filter((p) => !p.detected)
    .map(({ scheme, host, container }) => ({ scheme, host, container }));
  const onlyDefault =
    app.domains.length === 1 && app.domains[0] === `${app.name}.${app.globalDomain}`;
  const domains = onlyDefault ? [] : app.domains;
  return ports.length > 0 || domains.length > 0 ? { ports, domains } : null;
}

/** Bookkeeping after a request succeeded; `saved` is what `restoreToSave` read. */
export function afterSuccess(req: OperationRequest, saved: ProxyRestore | null) {
  switch (req.op) {
    case "proxy:disable":
      if (saved) proxyRestore.set(req.app, saved);
      else proxyRestore.delete(req.app);
      return;
    // A new app must not inherit a destroyed one's entry, and an enable consumes it.
    case "proxy:enable":
    case "apps:create":
    case "apps:destroy":
      proxyRestore.delete(req.app);
      return;
    default:
      return;
  }
}

/** Dokku's output with its ANSI colours stripped, blank lines dropped. */
const cleanOutput = (...parts: string[]) => stripAnsi(parts.filter(Boolean).join("\n"));

/** Runs the steps in order, stopping at the first failure; resolves with their combined output. */
export async function runSteps(dokku: DokkuSteps, steps: readonly (readonly string[])[]) {
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
  dokku: DokkuSteps,
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
