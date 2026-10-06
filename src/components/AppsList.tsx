import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { AppRow } from "../api/client";
import { appsQuery } from "../api/queries";
import { AppStatusBadge, appTone, Signal } from "./Signal";
import { EmptyNote, ErrorNote, Mono, Panel, RevisionStamp, Skeleton } from "./ui";

const columns = "md:grid-cols-[minmax(0,1.1fr)_10.5rem_minmax(0,1.7fr)_13rem]";

const buildLabel = ({ build }: AppRow) => {
  switch (build.type) {
    case "dockerfile":
      return `Dockerfile${build.dir ? ` / ${build.dir}` : ""}`;
    case "buildpack":
      return `Buildpack${build.language ? ` / ${build.language}` : ""}`;
    case "other":
      return build.name ?? "No build yet";
  }
};

const rollup = [
  { kind: "running", tone: "ok", label: "running" },
  { kind: "deploying", tone: "warn", label: "deploying" },
  { kind: "crashed", tone: "crit", label: "crashing" },
  { kind: "stopped", tone: "idle", label: "stopped" },
  { kind: "not-deployed", tone: "none", label: "not deployed" },
] as const;

/** Counts per status, shown in the panel header so trouble is visible before reading rows. */
function Rollup({ apps }: { apps: AppRow[] }) {
  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {rollup.map(({ kind, tone, label }) => {
        const count = apps.filter((a) => a.status.kind === kind).length;
        return count > 0 ? (
          <Signal key={kind} tone={tone} label={`${count} ${label}`} />
        ) : null;
      })}
    </div>
  );
}

function AppRowItem({ app }: { app: AppRow }) {
  const tone = appTone(app.status);
  const stripe =
    tone === "crit"
      ? "border-l-crit"
      : tone === "warn"
        ? "border-l-warn"
        : "border-l-transparent";
  const [firstDomain] = app.domains;
  return (
    <li>
      <Link
        to="/apps/$appName"
        params={{ appName: app.name }}
        className={`grid items-center gap-x-4 gap-y-2 border-l-2 px-4 py-3 hover:bg-raised ${stripe} ${columns}`}
      >
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-mono font-medium">{app.name}</span>
          <span className="truncate text-xs text-faint">
            {buildLabel(app)} · {app.processCount}{" "}
            {app.processCount === 1 ? "process" : "processes"}
          </span>
        </div>
        <div>
          <AppStatusBadge status={app.status} />
        </div>
        <div className="min-w-0 truncate text-dim">
          {firstDomain ? (
            <Mono>
              {firstDomain}
              {app.domains.length > 1 && (
                <span className="text-faint"> +{app.domains.length - 1}</span>
              )}
            </Mono>
          ) : (
            <span className="text-faint">
              {app.proxyEnabled ? "default domain" : "proxy off, no domains"}
            </span>
          )}
        </div>
        <div className="flex items-baseline gap-2 text-xs md:justify-end">
          {app.revision ? (
            <RevisionStamp revision={app.revision} />
          ) : (
            <span className="text-faint">
              {app.status.kind === "not-deployed" ? "no code pushed" : "revision unknown"}
            </span>
          )}
        </div>
      </Link>
    </li>
  );
}

export function AppsList() {
  const { data: apps, error, isPending, isFetching, refetch } = useQuery(appsQuery);
  return (
    <Panel title="Apps" action={apps && !error && <Rollup apps={apps} />}>
      <div
        className={`label hidden gap-x-4 border-b border-line px-4 py-2 pl-[calc(1rem+2px)] md:grid ${columns}`}
      >
        <span>Name</span>
        <span>Status</span>
        <span>Domains</span>
        <span className="text-right">Revision</span>
      </div>
      {error ? (
        <ErrorNote error={error} onRetry={() => void refetch()} retrying={isFetching} />
      ) : isPending || !apps ? (
        <div className="flex flex-col gap-3 p-4">
          {["a", "b", "c", "d", "e"].map((k) => (
            <Skeleton key={k} className="h-10 w-full" />
          ))}
        </div>
      ) : apps.length === 0 ? (
        <EmptyNote>No apps on this host yet.</EmptyNote>
      ) : (
        <ul className="divide-y divide-line">
          {apps.map((app) => (
            <AppRowItem key={app.name} app={app} />
          ))}
        </ul>
      )}
    </Panel>
  );
}
