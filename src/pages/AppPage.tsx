import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Hammer, LoaderCircle, Play, RotateCw, Square } from "lucide-react";
import {
  type AppActionId,
  actionAvailability,
  appActionIds,
  appActions,
} from "../api/actions";
import { ApiError } from "../api/backend";
import { appQuery } from "../api/queries";
import { usePendingAction, useRequestAction, useWrites } from "../components/ActionHost";
import { AppStatusBadge } from "../components/Signal";
import { ErrorNote, Panel, Skeleton } from "../components/ui";
import { ConfigTab } from "./app/ConfigTab";
import { LogsTab } from "./app/LogsTab";
import { NetworkTab } from "./app/NetworkTab";
import { OverviewTab } from "./app/OverviewTab";

export const appTabs = ["overview", "logs", "config", "network"] as const;
export type AppTab = (typeof appTabs)[number];

const tabLabels = {
  overview: "Overview",
  logs: "Logs",
  config: "Config",
  network: "Domains & Network",
} as const satisfies Record<AppTab, string>;

const actionIcons = {
  start: Play,
  restart: RotateCw,
  rebuild: Hammer,
  stop: Square,
} as const satisfies Record<AppActionId, typeof RotateCw>;

function Loading() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-9 w-72" />
      <Skeleton className="h-9 w-96 max-w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

/** App detail shell: header with status and actions, tab bar, and the active tab body. */
export function AppPage({ appName, tab }: { appName: string; tab: AppTab }) {
  const {
    data: app,
    error,
    isPending,
    isFetching,
    refetch,
  } = useQuery(appQuery(appName));
  const requestAction = useRequestAction();
  const pending = usePendingAction();
  const writes = useWrites();

  if (isPending) return <Loading />;

  if (error || !app) {
    const notFound = error instanceof ApiError && error.status === 404;
    const invalid = error instanceof ApiError && error.status === 400;
    return (
      <Panel
        title={
          notFound ? "App not found" : invalid ? "Invalid app name" : "Could not load app"
        }
        className="max-w-xl"
      >
        {notFound ? (
          <p className="px-4 pt-4">
            This host has no app called <span className="font-mono">{appName}</span>.
          </p>
        ) : (
          <ErrorNote error={error} onRetry={() => void refetch()} retrying={isFetching} />
        )}
        <Link
          to="/"
          className={`block px-4 pb-4 font-medium text-accent hover:underline ${
            notFound ? "pt-3" : ""
          }`}
        >
          Back to apps
        </Link>
      </Panel>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-4">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-dim">
          <Link to="/" className="hover:text-fg hover:underline">
            Apps
          </Link>
          <ChevronRight className="size-3.5 text-faint" aria-hidden="true" />
          <span className="font-mono text-fg">{app.name}</span>
        </nav>

        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="font-mono text-2xl font-medium tracking-tight">
                {app.name}
              </h1>
              <AppStatusBadge status={app.status} />
            </div>
            {app.sample && <p className="max-w-[65ch] text-dim">{app.sample.summary}</p>}
          </div>
          <div className="flex flex-wrap gap-2">
            {appActionIds.map((id) => {
              const availability = actionAvailability(id, app);
              const running = pending?.app === app.name && pending.action === id;
              const disabledReason = !writes.enabled
                ? writes.reason
                : !availability.ok
                  ? availability.reason
                  : undefined;
              const Icon = running ? LoaderCircle : actionIcons[id];
              return (
                <button
                  key={id}
                  type="button"
                  disabled={disabledReason !== undefined || pending !== null}
                  title={disabledReason}
                  onClick={() => requestAction({ action: id, app: app.name })}
                  className={`flex h-9 items-center gap-2 rounded-sm border px-3 font-medium disabled:cursor-not-allowed disabled:opacity-45 ${
                    appActions[id].tone === "danger"
                      ? "border-crit/40 text-crit enabled:hover:bg-crit/10"
                      : "border-line-strong enabled:hover:bg-raised"
                  }`}
                >
                  <Icon
                    className={`size-3.5 ${running ? "animate-spin" : ""}`}
                    aria-hidden="true"
                  />
                  {running ? appActions[id].pending : appActions[id].label}
                </button>
              );
            })}
          </div>
        </div>

        <nav
          aria-label="App sections"
          className="-mx-4 overflow-x-auto border-b border-line px-4 md:mx-0 md:px-0"
        >
          <ul className="flex gap-1">
            {appTabs.map((t) => {
              const active = t === tab;
              return (
                <li key={t}>
                  <Link
                    to="/apps/$appName"
                    params={{ appName: app.name }}
                    search={{ tab: t }}
                    aria-current={active ? "page" : undefined}
                    className={`-mb-px block whitespace-nowrap border-b-2 px-3 py-2.5 font-medium ${
                      active
                        ? "border-accent text-fg"
                        : "border-transparent text-dim hover:text-fg"
                    }`}
                  >
                    {tabLabels[t]}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>

      {tab === "overview" && <OverviewTab app={app} />}
      {tab === "logs" && <LogsTab app={app} />}
      {tab === "config" && <ConfigTab app={app} />}
      {tab === "network" && <NetworkTab app={app} />}
    </>
  );
}
