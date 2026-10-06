import {
  buildNetworks,
  needsGitRev,
  parseAliases,
  parseAppDetail,
  parseAppSummary,
  parseBuilds,
  parseDomains,
  parseFormation,
  parseGlobalDomains,
  parseNetworkList,
  parseReport,
  parseStorage,
  type Report,
} from "../shared/parse";
import type {
  AppDetail,
  AppSummary,
  BuildRecord,
  Network,
  StorageMount,
} from "../shared/types";
import type { Dokku, DokkuError, DokkuResult, DokkuRun } from "./dokku";

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: DokkuError };

/** Carries a failed Dokku call out of the parsing code below. */
class DokkuFailure extends Error {
  constructor(readonly error: DokkuError) {
    super(error.message);
  }
}

/** Unwraps a result's stdout, throwing `DokkuFailure` when the call failed. */
export function stdoutOf(result: DokkuResult) {
  if (!result.ok) throw new DokkuFailure(result.error);
  return result.stdout;
}

/** Runs `read`, turning a thrown `DokkuFailure` or parse error into an `Outcome`. */
export async function outcome<T>(read: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (e) {
    if (e instanceof DokkuFailure) return { ok: false, error: e.error };
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: { kind: "parse", message } };
  }
}

/** `apps:list --format json` prints `["a","b"]`. */
function parseNames(stdout: string): string[] {
  const value: unknown = JSON.parse(stdout);
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new Error("Expected a JSON array of app names");
  }
  return value;
}

/** An all-apps report prints one JSON object per line, in `apps:list` order, unlabelled. */
const parseReportLines = (stdout: string): Report[] =>
  stdout ? stdout.split("\n").map(parseReport) : [];

/**
 * The deployed commit of an app whose `git:report` has no sha (deployed by `git push`):
 * its `GIT_REV` config value. This is the only config value the server reads for itself.
 * Undefined when not needed or when the lookup fails (an unset key exits 1); a missing
 * revision is not worth failing the read.
 */
async function gitRevOf(dokku: DokkuRun, name: string, git: Report) {
  if (!needsGitRev(git)) return undefined;
  const result = await dokku("config:get", name, "GIT_REV");
  return result.ok ? result.stdout : undefined;
}

/**
 * Every app's overview row: `apps:list` plus five all-apps reports, six SSH calls in
 * parallel regardless of app count, plus one `config:get GIT_REV` per app whose git
 * report has no sha (no all-apps command returns one key without exposing the rest).
 * All-apps reports carry no app name, so they are zipped with the name list by position;
 * a length mismatch (an app created or destroyed mid-call) is an error rather than a
 * mislabelled row.
 */
export const listApps = (dokku: Dokku) =>
  outcome<AppSummary[]>(async () => {
    const [names, ps, domains, proxy, builder, git] = await Promise.all([
      dokku("apps:list"),
      dokku("ps:report"),
      dokku("domains:report"),
      dokku("proxy:report"),
      dokku("builder:report"),
      dokku("git:report"),
    ]);
    const appNames = parseNames(stdoutOf(names));
    const reports = {
      ps: parseReportLines(stdoutOf(ps)),
      domains: parseReportLines(stdoutOf(domains)),
      proxy: parseReportLines(stdoutOf(proxy)),
      builder: parseReportLines(stdoutOf(builder)),
      git: parseReportLines(stdoutOf(git)),
    };
    if (Object.values(reports).some((r) => r.length !== appNames.length)) {
      throw new Error("App list changed while reading reports; retry");
    }
    return Promise.all(
      appNames.map(async (name, i) => {
        const git = reports.git[i] ?? {};
        return parseAppSummary(name, {
          ps: reports.ps[i] ?? {},
          domains: reports.domains[i] ?? {},
          proxy: reports.proxy[i] ?? {},
          builder: reports.builder[i] ?? {},
          git,
          gitRev: await gitRevOf(dokku, name, git),
        });
      }),
    );
  });

/**
 * Docker's networks and the apps attached to each: `network:list`, `apps:list` and the
 * all-apps `network:report`, three SSH calls in parallel however many apps there are.
 * Zipped by position like `listApps`, with the same retry on a length mismatch.
 */
export const listNetworks = (dokku: DokkuRun) =>
  outcome<Network[]>(async () => {
    const [networks, names, reports] = await Promise.all([
      dokku("network:list"),
      dokku("apps:list"),
      dokku("network:report"),
    ]);
    const appNames = parseNames(stdoutOf(names));
    const appReports = parseReportLines(stdoutOf(reports));
    if (appReports.length !== appNames.length) {
      throw new Error("App list changed while reading reports; retry");
    }
    return buildNetworks(
      parseNetworkList(stdoutOf(networks)),
      appNames.map((name, i) => ({ name, report: appReports[i] ?? {} })),
    );
  });

/**
 * Every app's storage mounts (`apps:list`, then one `storage:list` per app, queued under
 * the runner's session limit), to tell whether a directory is already used elsewhere.
 */
export const listStorageUsers = (dokku: DokkuRun) =>
  outcome<{ app: string; mounts: StorageMount[] }[]>(async () => {
    const names = parseNames(stdoutOf(await dokku("apps:list")));
    return Promise.all(
      names.map(async (app) => ({
        app,
        mounts: parseStorage(stdoutOf(await dokku("storage:list", app))),
      })),
    );
  });

/** One app's build and deploy records from Dokku's `builds` plugin (`builds:list`), newest first. */
export const getBuilds = (dokku: DokkuRun, name: string) =>
  outcome<BuildRecord[]>(async () =>
    parseBuilds(stdoutOf(await dokku("builds:list", name))),
  );

/**
 * Which app serves each domain: `apps:list` and the all-apps `domains:report`, two SSH
 * calls in parallel, zipped by position like `listApps`.
 */
export const domainOwners = (dokku: DokkuRun) =>
  outcome<Map<string, string>>(async () => {
    const [names, reports] = await Promise.all([
      dokku("apps:list"),
      dokku("domains:report"),
    ]);
    const appNames = parseNames(stdoutOf(names));
    const rows = parseReportLines(stdoutOf(reports));
    if (rows.length !== appNames.length) {
      throw new Error("App list changed while reading reports; retry");
    }
    return new Map(
      appNames.flatMap((name, i) =>
        parseDomains(rows[i] ?? {}).domains.map((domain) => [domain, name] as const),
      ),
    );
  });

/** The global vhost domains, read live. */
export const readGlobalDomains = (dokku: DokkuRun) =>
  outcome(async () =>
    parseGlobalDomains(parseReport(stdoutOf(await dokku("domains:report:global")))),
  );

/** Dokku exits 20 with "App <name> does not exist" for an unknown app. */
export const isNotFound = (error: DokkuError) =>
  error.kind === "command" && error.message.includes("does not exist");

/**
 * The text of one settings read when it succeeded and parses, else `fallback` (an empty
 * answer) with `name` noted in `failed`: a broken settings read must not take the app's
 * whole detail down with it.
 */
function softRead(
  name: string,
  result: DokkuResult,
  fallback: string,
  check: (stdout: string) => unknown,
  failed: string[],
) {
  if (result.ok) {
    try {
      check(result.stdout);
      return result.stdout;
    } catch {
      // falls through to the fallback
    }
  }
  failed.push(name);
  return fallback;
}

/** Dokku's `apps:locked` text for an app with no deploy lock (it exits 1 then). */
export const noLock = "Deploy lock does not exist";

/** Whether the deploy lock is held: `apps:locked` exits 0 then. Any other failure is noted in `failed`. */
function isLocked(result: DokkuResult, failed: string[]) {
  if (result.ok) return true;
  if (!result.error.message.includes(noLock)) failed.push("deploy lock");
  return false;
}

/**
 * One app's full detail: thirteen reads in parallel over the shared connection (the runner
 * queues them under sshd's session limit), then `GIT_REV` when the git report has no sha.
 * The first seven are required; the six settings reads (formation, storage, aliases,
 * resources, Dockerfile path, deploy lock) may fail alone, which the detail's `partial` names.
 */
export async function getApp(dokku: DokkuRun, name: string): Promise<Outcome<AppDetail>> {
  const result = await outcome<AppDetail>(async () => {
    const [
      ps,
      domains,
      ports,
      network,
      proxy,
      builder,
      git,
      resource,
      builderDockerfile,
      scale,
      storage,
      dockerOptions,
      lock,
    ] = await Promise.all([
      dokku("ps:report", name),
      dokku("domains:report", name),
      dokku("ports:report", name),
      dokku("network:report", name),
      dokku("proxy:report", name),
      dokku("builder:report", name),
      dokku("git:report", name),
      dokku("resource:report", name),
      dokku("builder-dockerfile:report", name),
      dokku("ps:scale", name),
      dokku("storage:list", name),
      dokku("docker-options:report", name),
      dokku("apps:locked", name),
    ]);
    const gitReport = parseReport(stdoutOf(git));
    const failed: string[] = [];
    const detail = parseAppDetail(name, {
      ps: parseReport(stdoutOf(ps)),
      domains: parseReport(stdoutOf(domains)),
      ports: parseReport(stdoutOf(ports)),
      network: parseReport(stdoutOf(network)),
      proxy: parseReport(stdoutOf(proxy)),
      builder: parseReport(stdoutOf(builder)),
      git: gitReport,
      resource: parseReport(softRead("resources", resource, "{}", parseReport, failed)),
      builderDockerfile: parseReport(
        softRead("dockerfile path", builderDockerfile, "{}", parseReport, failed),
      ),
      scale: softRead("formation", scale, "[]", parseFormation, failed),
      storage: softRead("storage", storage, "[]", parseStorage, failed),
      dockerOptions: softRead(
        "aliases",
        dockerOptions,
        '{"deploy-list":[]}',
        parseAliases,
        failed,
      ),
      locked: isLocked(lock, failed),
      gitRev: await gitRevOf(dokku, name, gitReport),
    });
    return failed.length > 0 ? { ...detail, partial: failed } : detail;
  });
  return !result.ok && isNotFound(result.error)
    ? { ok: false, error: { ...result.error, kind: "not-found" } }
    : result;
}
