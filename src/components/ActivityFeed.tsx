import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CircleAlert, CircleCheck, Hammer, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { isOperationId } from "../../shared/operations";
import type { Activity } from "../../shared/types";
import { exportUi, operationUi } from "../api/operations";
import { activityQuery, appsQuery } from "../api/queries";
import { formatDuration, relativeTime } from "../lib/time";
import { EmptyNote, ErrorNote, Mono, Skeleton } from "./ui";

/** How an app is named in a row: a link while the app exists, plain text once it is destroyed. */
type AppRef = (app: string) => ReactNode;

const appLink = (app: string) => (
  <Link
    to="/apps/$appName"
    params={{ appName: app }}
    className="font-mono font-medium hover:text-accent hover:underline"
  >
    {app}
  </Link>
);

/** What an operation did, as its toast says it: "Rebuilt hello." becomes "Rebuilt hello". */
function operationText(
  a: Extract<Activity, { kind: "operation" }>,
  appRef: AppRef,
): ReactNode {
  // Network operations have no app, so their target is not a link; a service operation's
  // target is the service, whatever app a link names.
  const target =
    a.app === null || a.op.startsWith("service:") ? (
      <Mono>{a.target}</Mono>
    ) : (
      appRef(a.app)
    );
  const known = isOperationId(a.op)
    ? operationUi[a.op]
    : a.op === "service:export"
      ? exportUi
      : null;
  const label = known?.label ?? a.op;
  const [before = "", ...after] = (known?.done ?? `${a.op} {target}.`).split("{target}");
  switch (a.outcome) {
    case "ok":
      return (
        <>
          {before}
          {target}
          {after.join("{target}").replace(/\.$/, "")}
          {(a.op === "service:link" || a.op === "service:unlink") && a.app && (
            <>
              {a.op === "service:link" ? " to " : " from "}
              {appRef(a.app)}
            </>
          )}
          {a.op.startsWith("config:") && a.message && (
            <span className="text-dim">
              {" "}
              (<Mono>{a.message}</Mono>)
            </span>
          )}
        </>
      );
    case "failed":
    case "refused":
      return (
        <>
          {label} {target} {a.outcome === "failed" ? "failed" : "was refused"}
          {a.message && <span className="text-dim"> ({a.message})</span>}
        </>
      );
  }
}

function describe(
  a: Activity,
  appRef: AppRef,
): { icon: ReactNode; text: ReactNode; tone: "ok" | "bad" } {
  const icon = "size-4";
  switch (a.kind) {
    case "operation":
      return {
        icon:
          a.outcome === "ok" ? (
            <CircleCheck className={icon} aria-hidden="true" />
          ) : a.outcome === "refused" ? (
            <TriangleAlert className={icon} aria-hidden="true" />
          ) : (
            <CircleAlert className={icon} aria-hidden="true" />
          ),
        text: (
          <>
            {operationText(a, appRef)}
            {a.durationMs >= 1000 && (
              <span className="text-faint">
                {" "}
                · {formatDuration(Math.round(a.durationMs / 1000))}
              </span>
            )}
            {a.actor && <span className="text-faint"> · {a.actor}</span>}
          </>
        ),
        tone: a.outcome === "ok" ? "ok" : "bad",
      };
    case "build": {
      const { build } = a;
      const ok = build.status === "succeeded";
      return {
        icon: <Hammer className={icon} aria-hidden="true" />,
        text: (
          <>
            {build.kind === "build" ? "Build" : "Deploy"} of {appRef(a.app)}{" "}
            {build.status === "other" ? "ended" : build.status}{" "}
            <span className="text-dim">
              (<Mono>{build.source}</Mono>)
            </span>
          </>
        ),
        tone: ok || build.status === "running" ? "ok" : "bad",
      };
    }
  }
}

/** Reverse-chronological event list. `limit` trims it for the overview sidebar; `app` narrows it. */
export function ActivityFeed({ limit, app }: { limit?: number; app?: string }) {
  const { data, error, isPending, isFetching, refetch } = useQuery(
    activityQuery(app, limit),
  );
  const { data: apps } = useQuery(appsQuery);
  // Until the list loads every app is treated as there; a destroyed one is plain text.
  const appRef: AppRef = (name) =>
    apps === undefined || apps.some((a) => a.name === name) ? (
      appLink(name)
    ) : (
      <Mono className="font-medium">{name}</Mono>
    );

  if (error && !data) {
    return (
      <ErrorNote error={error} onRetry={() => void refetch()} retrying={isFetching} />
    );
  }
  if (isPending || !data) {
    return (
      <div className="flex flex-col gap-3 p-4">
        {["a", "b", "c", "d"].map((k) => (
          <Skeleton key={k} className="h-8 w-full" />
        ))}
      </div>
    );
  }
  if (data.length === 0) {
    return <EmptyNote>Nothing has happened yet.</EmptyNote>;
  }

  return (
    <ol className="divide-y divide-line">
      {data.slice(0, limit).map((a) => {
        const { icon, text, tone } = describe(a, appRef);
        return (
          <li key={a.id} className="flex items-start gap-3 px-4 py-2.5">
            <span className={`mt-0.5 ${tone === "bad" ? "text-crit" : "text-faint"}`}>
              {icon}
            </span>
            <p className="min-w-0 flex-1 text-pretty">
              {text}
              {tone === "bad" && <span className="sr-only"> (needs attention)</span>}
            </p>
            <time
              dateTime={a.at}
              title={new Date(a.at).toLocaleString()}
              className="tabular shrink-0 pt-0.5 text-xs text-faint"
            >
              {relativeTime(a.at)}
            </time>
          </li>
        );
      })}
    </ol>
  );
}
