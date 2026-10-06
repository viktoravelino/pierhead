import type { Activity, BuildRecord, OperationRecord } from "../shared/types";

// The activity feed: pierhead's own record of operations, merged with the build and
// deploy records Dokku keeps per app. Dokku logs the deploys of things pierhead did too,
// so the two sources overlap; a record that pierhead's operation caused is folded into
// that operation's row instead of listed again.

/**
 * Operations (and the config changes) that start a Dokku build or deploy record. Checked
 * against Dokku 0.38: start, restart, rebuild, the two git deploys and a config change
 * that restarts leave one; stop, scale and the proxy toggles leave none, and neither do
 * domains or ports. A record that merely falls in the window of one of those, such as a
 * `git push` at the same moment, is not theirs.
 */
const deploying: ReadonlySet<string> = new Set([
  "ps:start",
  "ps:restart",
  "ps:rebuild",
  "network:set",
  "network:alias-add",
  "network:alias-remove",
  "git:from-image",
  "git:sync",
]);

/** How far a record's start may precede the operation's start (clock and SSH latency) or follow its end. */
const slackMs = 10_000;

const startMs = (iso: string) => Date.parse(iso);

/** A config change leaves a record only when it restarted the app (`--no-restart` leaves none). */
const startsRecords = (op: OperationRecord) =>
  op.op === "config:set" || op.op === "config:unset"
    ? op.restart === true
    : deploying.has(op.op);

/** Whether `record` began while `op` ran, on the same app, and `op` is one that deploys. */
function caused(op: OperationRecord, app: string, record: BuildRecord) {
  if (op.app !== app || op.outcome === "refused" || !startsRecords(op)) return false;
  const started = startMs(record.startedAt);
  const opStart = startMs(op.at);
  return started >= opStart - slackMs && started <= opStart + op.durationMs + slackMs;
}

/**
 * The operation a record belongs to among those whose window holds it: the latest one
 * that had started by the time the record did (a record cannot be caused by something
 * that began after it), else the earliest that began just after, which clock skew allows.
 */
function ownerOf(candidates: readonly OperationRecord[], record: BuildRecord) {
  const started = startMs(record.startedAt);
  const before = candidates.filter((op) => startMs(op.at) <= started);
  const pick = before.length > 0 ? before : candidates;
  return (
    pick.reduce<OperationRecord | null>((best, op) => {
      if (!best) return op;
      const closer =
        before.length > 0
          ? startMs(op.at) > startMs(best.at)
          : startMs(op.at) < startMs(best.at);
      return closer ? op : best;
    }, null) ?? null
  );
}

/**
 * Newest-first rows from `operations` and each app's `builds`. A build record goes to the
 * operation that caused it (see `ownerOf`, when windows overlap) and is
 * otherwise a row of its own, such as a `git push` or a deploy from the CLI.
 */
export function mergeActivity(
  operations: readonly OperationRecord[],
  builds: readonly { app: string; records: readonly BuildRecord[] }[],
  limit: number,
): Activity[] {
  const claimed = new Map<OperationRecord, string[]>();
  const standalone: Activity[] = [];
  for (const { app, records } of builds) {
    for (const record of records) {
      const owner = ownerOf(
        operations.filter((op) => caused(op, app, record)),
        record,
      );
      if (owner) claimed.set(owner, [...(claimed.get(owner) ?? []), record.id]);
      else {
        standalone.push({
          kind: "build",
          id: `build:${app}:${record.id}`,
          at: record.startedAt,
          app,
          build: record,
        });
      }
    }
  }
  const rows = operations.map(
    (op): Activity => ({
      ...op,
      kind: "operation",
      id: `op:${op.at}:${op.op}:${op.target}`,
      builds: claimed.get(op) ?? [],
    }),
  );
  return [...rows, ...standalone]
    .sort((a, b) => startMs(b.at) - startMs(a.at))
    .slice(0, limit);
}
