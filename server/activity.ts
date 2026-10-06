import type { Activity, BuildRecord, OperationRecord } from "../shared/types";

// The activity feed: pierhead's own record of operations, merged with the build and
// deploy records Dokku keeps per app. Dokku logs the deploys of things pierhead did too,
// so the two sources overlap; a record that pierhead's operation caused is folded into
// that operation's row instead of listed again.

/**
 * Operations (and the config changes) that can start a Dokku build or deploy record.
 * Others (domains, ports, a stop...) never do, so a record that merely falls in their
 * time window, such as a `git push` at the same moment, is not theirs.
 */
const deploying: ReadonlySet<string> = new Set([
  "ps:start",
  "ps:restart",
  "ps:rebuild",
  "proxy:enable",
  "proxy:disable",
  "ps:scale",
  "network:set",
  "network:alias-add",
  "network:alias-remove",
  "git:from-image",
  "git:sync",
  "config:set",
  "config:unset",
]);

/** How far a record's start may precede the operation's start (clock and SSH latency) or follow its end. */
const slackMs = 10_000;

const startMs = (iso: string) => Date.parse(iso);

/** Whether `record` began while `op` ran, on the same app, and `op` is one that deploys. */
function caused(op: OperationRecord, app: string, record: BuildRecord) {
  if (op.app !== app || op.outcome === "refused" || !deploying.has(op.op)) return false;
  const started = startMs(record.startedAt);
  const opStart = startMs(op.at);
  return started >= opStart - slackMs && started <= opStart + op.durationMs + slackMs;
}

/**
 * Newest-first rows from `operations` and each app's `builds`. A build record goes to the
 * operation that caused it (the one nearest before it, when windows overlap) and is
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
      const owner = operations
        .filter((op) => caused(op, app, record))
        .reduce<OperationRecord | null>(
          (nearest, op) =>
            nearest && startMs(nearest.at) > startMs(op.at) ? nearest : op,
          null,
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
