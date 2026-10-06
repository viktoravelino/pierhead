import {
  needsGitRev,
  parseAppDetail,
  parseAppSummary,
  parseReport,
  type Report,
} from "../shared/parse";
import type { AppDetail, AppSummary } from "../shared/types";
import type { Dokku, DokkuError, DokkuResult } from "./dokku";

type Outcome<T> = { ok: true; value: T } | { ok: false; error: DokkuError };

/** Carries a failed Dokku call out of the parsing code below. */
class DokkuFailure extends Error {
  constructor(readonly error: DokkuError) {
    super(error.message);
  }
}

/** Unwraps a result's stdout, throwing `DokkuFailure` when the call failed. */
function stdoutOf(result: DokkuResult) {
  if (!result.ok) throw new DokkuFailure(result.error);
  return result.stdout;
}

/** Runs `read`, turning a thrown `DokkuFailure` or parse error into an `Outcome`. */
async function outcome<T>(read: () => Promise<T>): Promise<Outcome<T>> {
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
async function gitRevOf(dokku: Dokku, name: string, git: Report) {
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

/** Dokku exits 20 with "App <name> does not exist" for an unknown app. */
export const isNotFound = (error: DokkuError) =>
  error.kind === "command" && error.message.includes("does not exist");

/**
 * One app's full detail: seven reports in parallel over the shared connection, then
 * `GIT_REV` when the git report has no sha.
 */
export async function getApp(dokku: Dokku, name: string): Promise<Outcome<AppDetail>> {
  const result = await outcome<AppDetail>(async () => {
    const [ps, domains, ports, network, proxy, builder, git] = await Promise.all([
      dokku("ps:report", name),
      dokku("domains:report", name),
      dokku("ports:report", name),
      dokku("network:report", name),
      dokku("proxy:report", name),
      dokku("builder:report", name),
      dokku("git:report", name),
    ]);
    const gitReport = parseReport(stdoutOf(git));
    return parseAppDetail(name, {
      ps: parseReport(stdoutOf(ps)),
      domains: parseReport(stdoutOf(domains)),
      ports: parseReport(stdoutOf(ports)),
      network: parseReport(stdoutOf(network)),
      proxy: parseReport(stdoutOf(proxy)),
      builder: parseReport(stdoutOf(builder)),
      git: gitReport,
      gitRev: await gitRevOf(dokku, name, gitReport),
    });
  });
  return !result.ok && isNotFound(result.error)
    ? { ok: false, error: { ...result.error, kind: "not-found" } }
    : result;
}
