import { formatPortMapping, storageHostPath } from "../shared/grammar";
import { type OperationRequest, operationAvailability } from "../shared/operations";
import { stripAnsi } from "../shared/parse";
import type { AppDetail, PortMapping, ProxyRestore } from "../shared/types";
import {
  domainOwners,
  getApp,
  getBuilds,
  isNotFound,
  listNetworks,
  noLock,
  readGlobalDeployBranch,
  readGlobalDomains,
} from "./apps";
import type { DokkuError, DokkuRun, DokkuSteps } from "./dokku";
import type { StateStore } from "./state";

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

  if (req.op === "apps:unlock") return unlockPreflight(dokku, req.app);

  // No deploy lock to look at: these touch only Dokku's global settings, not an app.
  if (
    req.op === "domains:add-global" ||
    req.op === "domains:remove-global" ||
    req.op === "domains:set-global"
  ) {
    return globalDomainsPreflight(dokku, req);
  }
  if (req.op === "git:set-global") {
    // Dokku exits 0 for setting what is already set.
    const current = await readGlobalDeployBranch(dokku);
    if (!current.ok) return { ok: false, refusal: failure(current.error) };
    return current.value === req.branch
      ? refused(
          409,
          "conflict",
          req.branch === ""
            ? "No global deploy branch is set."
            : `The global deploy branch is already ${req.branch}.`,
        )
      : { ok: true, app: null };
  }

  // Dokku's deploy lock is the only sign of a deploy in progress (no report shows one);
  // it also catches the rebuild or proxy toggle this server is streaming.
  const lock = await dokku("apps:locked", req.app);
  if (lock.ok) {
    return refused(
      409,
      "deploy-in-progress",
      `${req.app} holds a deploy lock: a deploy is running, or a failed one left it behind. Once no build is running, release it from the app's Settings tab (Release lock) or with \`dokku apps:unlock ${req.app}\`.`,
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
  // These compare against settings reads that may have failed; an empty list there is not "none".
  if (
    app.partial &&
    (req.op === "network:alias-add" ||
      req.op === "network:alias-remove" ||
      req.op === "storage:mount" ||
      req.op === "storage:unmount")
  ) {
    return {
      ok: false,
      refusal: {
        status: 502,
        kind: "partial-read",
        message: `Could not read ${app.partial.join(", ")} for ${req.app}; try again.`,
      },
    };
  }
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
    case "apps:rename":
    case "apps:clone":
      return checkNewName(dokku, req, app);
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
    case "git:from-image":
    case "git:sync":
    case "git:set":
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

/** The target of a rename or clone: a name no app has and no app serves as a domain. */
async function checkNewName(
  dokku: DokkuRun,
  req: Extract<OperationRequest, { op: "apps:rename" | "apps:clone" }>,
  app: AppDetail,
): Promise<Preflight> {
  const exists = await dokku("apps:exists", req.newName);
  if (exists.ok) {
    return refused(409, "exists", `An app named ${req.newName} already exists.`);
  }
  if (!isNotFound(exists.error)) return { ok: false, refusal: failure(exists.error) };
  // A dotted name becomes the app's vhost as it is. A renamed app keeps its own domains
  // (one may become the new name); a clone has none of them, so its owner counts.
  const owners = await domainOwners(dokku);
  if (!owners.ok) return { ok: false, refusal: failure(owners.error) };
  const owner = owners.value.get(req.newName);
  return owner === undefined || (req.op === "apps:rename" && owner === req.app)
    ? { ok: true, app }
    : refused(409, "domain-in-use", `${req.newName} is already a domain of ${owner}.`);
}

/**
 * The global domain operations against the live list: Dokku exits 0 for adding what is
 * there and removing what is not, so those become 409s like the per-app domain edits.
 */
async function globalDomainsPreflight(
  dokku: DokkuRun,
  req: Extract<
    OperationRequest,
    { op: "domains:add-global" | "domains:remove-global" | "domains:set-global" }
  >,
): Promise<Preflight> {
  const current = await readGlobalDomains(dokku);
  if (!current.ok) return { ok: false, refusal: failure(current.error) };
  const held = new Set(current.value);
  switch (req.op) {
    case "domains:add-global":
      return req.domains.every((d) => held.has(d))
        ? refused(409, "conflict", "Every one of these is already a global domain.")
        : { ok: true, app: null };
    case "domains:remove-global": {
      const missing = req.domains.find((d) => !held.has(d));
      return missing === undefined
        ? { ok: true, app: null }
        : refused(409, "conflict", `${missing} is not a global domain.`);
    }
    case "domains:set-global":
      return req.domains.length === held.size && req.domains.every((d) => held.has(d))
        ? refused(409, "conflict", "The global domains are already exactly this list.")
        : { ok: true, app: null };
  }
}

/**
 * `apps:unlock`: only while the lock exists and no build record of the app is still
 * running (a deploy that is really under way holds the lock legitimately). Records of a
 * build that died read as `abandoned`, not running, so they do not block it.
 */
async function unlockPreflight(dokku: DokkuRun, app: string): Promise<Preflight> {
  const lock = await dokku("apps:locked", app);
  if (!lock.ok) {
    if (lock.error.message.includes(noLock)) {
      return refused(409, "unavailable", `${app} holds no deploy lock.`);
    }
    return { ok: false, refusal: failure(lock.error) };
  }
  const builds = await getBuilds(dokku, app);
  if (!builds.ok) return { ok: false, refusal: failure(builds.error) };
  const running = builds.value.find((b) => b.status === "running");
  if (running) {
    return refused(
      409,
      "build-running",
      `${app} has a ${running.kind} still running (${running.source}, started ${running.startedAt}); releasing the lock now would let a second deploy start on top of it.`,
    );
  }
  return { ok: true, app: null };
}

/**
 * Dokku's own failure for a request, as a refusal when it means a state the checks could
 * not see: Docker keeps a network while a container is on it, and a detached app's
 * running container stays on the network until it is rebuilt. Null for any other failure.
 */
export function failureRefusal(req: OperationRequest, error: DokkuError): Refusal | null {
  if (req.op === "network:destroy" && error.message.includes("has active endpoints")) {
    return {
      status: 409,
      kind: "in-use",
      message: `${req.network} still has a running container connected. Containers stay on a network until their app is rebuilt, so rebuild every app that was attached to it, then try again.`,
    };
  }
  return null;
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

/**
 * Bookkeeping after a request succeeded; `saved` is what `restoreToSave` read. What a
 * disable cleared is kept in the state store, so a restart does not forget it.
 */
export function afterSuccess(
  store: Pick<StateStore, "saveRestore" | "clearRestore" | "restoreOf">,
  req: OperationRequest,
  saved: ProxyRestore | null,
) {
  switch (req.op) {
    case "proxy:disable":
      if (saved) store.saveRestore(req.app, saved);
      else store.clearRestore(req.app);
      return;
    // A rename is settled by `settleRename`, which also runs after a failed one.
    // A clone is a new app, so it starts without an entry.
    case "apps:clone":
      store.clearRestore(req.newName);
      return;
    // A new app must not inherit a destroyed one's entry, and an enable consumes it.
    case "proxy:enable":
    case "apps:create":
    case "apps:destroy":
      store.clearRestore(req.app);
      return;
    default:
      return;
  }
}

/**
 * After a rename's commands, whatever their outcome: Dokku creates the new app, destroys
 * the old one and only then redeploys, so a failed redeploy still leaves the old app gone.
 * Once it is, its saved proxy-restore entry goes to the new name, with the old default
 * vhost (`<old>.<g>` for each global domain) swapped for the new one. While the old app
 * still exists (it failed before anything happened) or the check fails, nothing moves.
 */
export async function settleRename(
  dokku: DokkuRun,
  store: Pick<StateStore, "saveRestore" | "clearRestore" | "restoreOf">,
  req: OperationRequest,
) {
  if (req.op !== "apps:rename") return;
  const old = await dokku("apps:exists", req.app);
  if (old.ok || !isNotFound(old.error)) return;
  const restore = store.restoreOf(req.app);
  store.clearRestore(req.app);
  store.clearRestore(req.newName);
  if (!restore) return;
  const globals = await readGlobalDomains(dokku);
  const swaps = new Map(
    (globals.ok ? globals.value : []).map((g) => [
      `${req.app}.${g}`,
      `${req.newName}.${g}`,
    ]),
  );
  store.saveRestore(req.newName, {
    ...restore,
    domains: restore.domains.map((d) => swaps.get(d) ?? d),
  });
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
