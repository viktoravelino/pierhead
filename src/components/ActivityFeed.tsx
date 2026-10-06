import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { DatabaseBackup, OctagonX, Rocket, RotateCw } from "lucide-react";
import type { ReactNode } from "react";
import type { Activity } from "../../shared/types";
import { activityQuery } from "../api/queries";
import { formatDuration, relativeTime } from "../lib/time";
import { Mono, Skeleton } from "./ui";

const appLink = (app: string) => (
  <Link
    to="/apps/$appName"
    params={{ appName: app }}
    className="font-mono font-medium hover:text-accent hover:underline"
  >
    {app}
  </Link>
);

function describe(a: Activity): { icon: ReactNode; text: ReactNode; failed: boolean } {
  const icon = "size-4";
  switch (a.kind) {
    case "deploy":
      return {
        icon: <Rocket className={icon} aria-hidden="true" />,
        text: (
          <>
            {a.ok ? "Deployed" : "Deploy failed for"} <Mono>{a.rev}</Mono>{" "}
            {a.ok ? "to" : "on"} {appLink(a.app)}
          </>
        ),
        failed: !a.ok,
      };
    case "restart":
      return {
        icon: <RotateCw className={icon} aria-hidden="true" />,
        text: (
          <>
            {appLink(a.app)} restarted <span className="text-dim">({a.reason})</span>
          </>
        ),
        failed: true,
      };
    case "stop":
      return {
        icon: <OctagonX className={icon} aria-hidden="true" />,
        text: <>Stopped {appLink(a.app)}</>,
        failed: false,
      };
    case "backup":
      return {
        icon: <DatabaseBackup className={icon} aria-hidden="true" />,
        text: a.ok ? (
          <>
            Nightly backup finished{" "}
            <span className="text-dim">
              ({a.sizeMb} MB in {formatDuration(a.durationS)})
            </span>
          </>
        ) : (
          <>
            Nightly backup failed <span className="text-dim">(R2 upload timed out)</span>
          </>
        ),
        failed: !a.ok,
      };
  }
}

/** Reverse-chronological event list. `limit` trims it for the overview sidebar. */
export function ActivityFeed({ limit }: { limit?: number }) {
  const { data, isPending } = useQuery(activityQuery);

  if (isPending || !data) {
    return (
      <div className="flex flex-col gap-3 p-4">
        {["a", "b", "c", "d"].map((k) => (
          <Skeleton key={k} className="h-8 w-full" />
        ))}
      </div>
    );
  }

  return (
    <ol className="divide-y divide-line">
      {data.slice(0, limit).map((a) => {
        const { icon, text, failed } = describe(a);
        return (
          <li key={a.id} className="flex items-start gap-3 px-4 py-2.5">
            <span className={`mt-0.5 ${failed ? "text-crit" : "text-faint"}`}>
              {icon}
            </span>
            <p className="min-w-0 flex-1 text-pretty">
              {text}
              {failed && <span className="sr-only"> (needs attention)</span>}
            </p>
            <time dateTime={a.at} className="tabular shrink-0 pt-0.5 text-xs text-faint">
              {relativeTime(a.at)}
            </time>
          </li>
        );
      })}
    </ol>
  );
}
