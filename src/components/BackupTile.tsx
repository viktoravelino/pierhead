import { useQuery } from "@tanstack/react-query";
import { backupQuery } from "../api/queries";
import { formatDuration, relativeTime, untilTime } from "../lib/time";
import { Signal } from "./Signal";
import { Mono, Panel, Skeleton } from "./ui";

export function BackupTile() {
  const { data, isPending } = useQuery(backupQuery);
  return (
    <Panel
      title="Last backup"
      action={
        data && (
          <Signal
            tone={data.lastRun.ok ? "ok" : "crit"}
            label={data.lastRun.ok ? "Succeeded" : "Failed"}
          />
        )
      }
    >
      {isPending || !data ? (
        <div className="flex flex-col gap-3 p-4">
          <Skeleton className="h-7 w-24" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : (
        <div className="flex flex-col gap-4 p-4">
          <div>
            <p className="text-2xl font-semibold tracking-tight">
              {relativeTime(data.lastRun.at)}
            </p>
            <p className="text-dim">
              {data.lastRun.sizeMb} MB in {formatDuration(data.lastRun.durationS)},
              snapshot <Mono>{data.lastRun.snapshot}</Mono>
            </p>
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
            <div>
              <dt className="label">Schedule</dt>
              <dd>{data.schedule}</dd>
            </div>
            <div>
              <dt className="label">Next run</dt>
              <dd>{untilTime(data.nextRunAt)}</dd>
            </div>
            <div>
              <dt className="label">Target</dt>
              <dd>
                <Mono>{data.tool}</Mono> to {data.target}
              </dd>
            </div>
            <div>
              <dt className="label">Retention</dt>
              <dd className="tabular">
                {data.retention.daily}d / {data.retention.weekly}w /{" "}
                {data.retention.monthly}m
              </dd>
            </div>
          </dl>
        </div>
      )}
    </Panel>
  );
}
