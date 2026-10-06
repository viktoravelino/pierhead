import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { formatFormationEntry } from "../../../shared/grammar";
import type { Build, BuildRecord } from "../../../shared/types";
import type { AppView } from "../../api/client";
import { buildOutputQuery, buildsQuery, deploysQuery } from "../../api/queries";
import { DomainLink } from "../../components/DomainLink";
import { OperationButton, textButton } from "../../components/OperationButton";
import { BuildBadge, DeployBadge, ProcessBadge } from "../../components/Signal";
import {
  EmptyNote,
  ErrorNote,
  Mono,
  Panel,
  RevisionStamp,
  Skeleton,
} from "../../components/ui";
import { formatDuration, relativeTime } from "../../lib/time";

const buildLabel = (build: Build) => {
  switch (build.type) {
    case "dockerfile":
      return build.dir ? `Dockerfile, build-dir ${build.dir}` : "Dockerfile";
    case "buildpack":
      return build.language ? `Buildpack, ${build.language}` : "Buildpack";
    case "other":
      return build.name ?? "No build yet";
  }
};

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 bg-panel p-4">
      <dt className="label">{label}</dt>
      <dd className="text-pretty">{children}</dd>
    </div>
  );
}

function DeployHistory({ name }: { name: string }) {
  const { data, isPending } = useQuery(deploysQuery(name));
  return (
    <Panel title="Deploy history">
      {isPending || !data ? (
        <div className="flex flex-col gap-3 p-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : (
        <ol className="divide-y divide-line">
          {data.map((d) => (
            <li
              key={d.id}
              className="grid items-center gap-x-4 gap-y-1 px-4 py-3 md:grid-cols-[5.5rem_minmax(0,1fr)_8.5rem_7rem]"
            >
              <Mono className="font-medium">{d.rev}</Mono>
              <div className="min-w-0">
                <p className="truncate">{d.message}</p>
                {d.status === "failed" && (
                  <p className="truncate font-mono text-xs text-crit">{d.reason}</p>
                )}
              </div>
              <div>
                <DeployBadge status={d.status} />
              </div>
              <p className="tabular text-xs text-faint md:text-right">
                {relativeTime(d.at)}
                {d.status !== "in-progress" && ` · ${formatDuration(d.durationS)}`}
              </p>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

/** Seconds a record took, null while it runs. */
const secondsOf = ({ startedAt, finishedAt }: BuildRecord) =>
  finishedAt === null
    ? null
    : Math.max(0, Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000));

/** One record's log in a modal: the newest lines Dokku kept, in a scrolling block. */
function BuildOutputDialog({
  name,
  build,
  onClose,
}: {
  name: string;
  build: BuildRecord;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const { data, error, isPending, isFetching, refetch } = useQuery(
    buildOutputQuery(name, build.id),
  );
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby="build-output-title"
      onClose={onClose}
      className="m-auto max-h-[calc(100dvh-1.5rem)] w-[min(52rem,calc(100vw-1.5rem))] overflow-y-auto rounded-md border border-line-strong bg-raised p-0 shadow-2xl shadow-black/40"
    >
      <div className="flex flex-col gap-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="build-output-title" className="text-lg font-semibold">
            <span className="capitalize">{build.kind}</span> output{" "}
            <Mono className="text-dim">{build.id}</Mono>
          </h2>
          <BuildBadge status={build.status} />
        </div>
        {error ? (
          <ErrorNote error={error} onRetry={() => void refetch()} retrying={isFetching} />
        ) : (
          <pre className="h-[28rem] overflow-auto rounded-sm border border-line bg-sunken px-3 py-2.5 font-mono text-xs leading-5 whitespace-pre-wrap break-words">
            {isPending
              ? "Loading..."
              : data.lines.join("\n").trim() || "Dokku kept no output for this record."}
          </pre>
        )}
        {data?.truncated && (
          <p className="text-xs text-faint">Only the newest {data.lines.length} lines.</p>
        )}
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => ref.current?.close()}
            className="h-9 rounded-sm border border-line-strong px-3.5 font-medium hover:bg-sunken"
          >
            Close
          </button>
        </div>
      </div>
    </dialog>
  );
}

/** Dokku's own build and deploy records (`builds:list`, the last 20), each with its log. */
function BuildHistory({ name }: { name: string }) {
  const { data, error, isPending, isFetching, refetch } = useQuery(buildsQuery(name));
  const [shown, setShown] = useState<BuildRecord | null>(null);
  return (
    <Panel title="Deploy history">
      {error && !data ? (
        <ErrorNote error={error} onRetry={() => void refetch()} retrying={isFetching} />
      ) : isPending || !data ? (
        <div className="flex flex-col gap-3 p-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : data.length === 0 ? (
        <EmptyNote>Dokku has no build or deploy records for this app.</EmptyNote>
      ) : (
        <ol className="divide-y divide-line">
          {data.map((b) => {
            const took = secondsOf(b);
            return (
              <li
                key={b.id}
                className="grid items-center gap-x-4 gap-y-1 px-4 py-3 md:grid-cols-[minmax(0,1fr)_7rem_9rem_4.5rem]"
              >
                <p className="min-w-0 truncate">
                  <span className="capitalize">{b.kind}</span>{" "}
                  <Mono className="text-dim">{b.source}</Mono>
                </p>
                <div>
                  <BuildBadge status={b.status} />
                </div>
                <p className="tabular text-xs text-faint md:text-right">
                  <time
                    dateTime={b.startedAt}
                    title={new Date(b.startedAt).toLocaleString()}
                  >
                    {relativeTime(b.startedAt)}
                  </time>
                  {took !== null && ` · ${formatDuration(took)}`}
                </p>
                <button
                  type="button"
                  onClick={() => setShown(b)}
                  aria-label={`Output of ${b.kind} ${b.id}`}
                  className="h-8 rounded-sm border border-line-strong px-2.5 text-sm font-medium hover:bg-raised md:justify-self-end"
                >
                  Output
                </button>
              </li>
            );
          })}
        </ol>
      )}
      {shown && (
        <BuildOutputDialog name={name} build={shown} onClose={() => setShown(null)} />
      )}
    </Panel>
  );
}

export function OverviewTab({ app }: { app: AppView }) {
  const { sample } = app;
  return (
    <div className="flex flex-col gap-6">
      <dl className="grid gap-px overflow-hidden rounded-md border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
        <Fact label="Build">{buildLabel(app.build)}</Fact>
        <Fact label="Restart policy">
          <Mono>{app.restartPolicy}</Mono>
        </Fact>
        {sample ? (
          <Fact label="Last deploy">
            <Mono>{sample.lastDeploy.rev}</Mono>{" "}
            <span className="text-dim">{relativeTime(sample.lastDeploy.at)}</span>
          </Fact>
        ) : (
          <Fact label="Revision">
            {app.revision ? (
              <span className="flex flex-wrap items-baseline gap-x-2">
                <RevisionStamp revision={app.revision} />
              </span>
            ) : (
              <span className="text-dim">
                {app.status.kind === "not-deployed"
                  ? "No code pushed yet"
                  : "Unknown: Dokku reports no commit"}
              </span>
            )}
          </Fact>
        )}
        <Fact label="Proxy">{app.proxyEnabled ? "Enabled" : "Disabled"}</Fact>
      </dl>

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Panel
          title="Processes"
          action={
            <OperationButton
              app={app}
              request={{
                op: "ps:scale",
                app: app.name,
                formation:
                  app.formation.length > 0 ? app.formation : [{ type: "web", count: 1 }],
                skipDeploy: false,
              }}
              label="Scale"
              className={textButton}
            >
              Scale
            </OperationButton>
          }
        >
          {app.processes.length === 0 && (
            <EmptyNote>
              {app.status.kind === "not-deployed" ? (
                <>
                  No processes. This app has never been deployed.{" "}
                  <Link
                    to="/apps/$appName"
                    params={{ appName: app.name }}
                    search={{ tab: "settings" }}
                    className="font-medium text-accent hover:underline"
                  >
                    Deploy an image or a repository
                  </Link>
                </>
              ) : (
                "No processes."
              )}
            </EmptyNote>
          )}
          <ul className="divide-y divide-line">
            {app.processes.map((p) => (
              <li
                key={p.name}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3"
              >
                <Mono className="font-medium">{p.name}</Mono>
                <div className="flex items-center gap-3">
                  <ProcessBadge state={p.state} />
                  <span className="text-xs text-faint">
                    CID <Mono className="text-dim">{p.cid ?? "none"}</Mono>
                  </span>
                </div>
              </li>
            ))}
          </ul>
          {app.formation.length > 0 && (
            <p className="border-t border-line px-4 py-2.5 text-xs text-faint">
              Formation{" "}
              <Mono className="text-dim">
                {app.formation.map(formatFormationEntry).join(" ")}
              </Mono>
            </p>
          )}
        </Panel>

        <Panel title="Reachability">
          <dl className="divide-y divide-line">
            <div className="flex flex-col gap-1.5 px-4 py-3">
              <dt className="label">Domains</dt>
              <dd className="flex flex-col gap-1">
                {app.domains.length > 0 ? (
                  app.domains.map((d) => <DomainLink key={d} host={d} />)
                ) : (
                  <span className="text-dim">
                    {app.proxyEnabled
                      ? "No custom domains"
                      : "Not exposed. Proxy is disabled."}
                  </span>
                )}
              </dd>
            </div>
            <div className="flex flex-col gap-1.5 px-4 py-3">
              <dt className="label">Ports</dt>
              <dd className="flex flex-wrap gap-2">
                {app.ports.length === 0 && (
                  <span className="text-dim">No port mappings</span>
                )}
                {app.ports.map((p) => (
                  <Mono
                    key={`${p.scheme}${p.host}${p.container}`}
                    className="rounded-sm border border-line px-1.5 py-0.5"
                  >
                    {p.scheme}:{p.host}:{p.container}
                  </Mono>
                ))}
              </dd>
            </div>
            <div className="flex flex-col gap-1.5 px-4 py-3">
              <dt className="label">Network</dt>
              <dd className="flex flex-wrap gap-x-4 gap-y-1">
                {app.networks.length === 0 && (
                  <span className="text-dim">No networks attached</span>
                )}
                {app.networks.map((n) => (
                  <span key={n.name}>
                    <Mono>{n.name}</Mono>
                    {n.alias && (
                      <span className="text-dim">
                        {" "}
                        as <Mono className="text-fg">{n.alias}</Mono>
                      </span>
                    )}
                  </span>
                ))}
              </dd>
            </div>
          </dl>
        </Panel>
      </div>

      {sample ? <DeployHistory name={app.name} /> : <BuildHistory name={app.name} />}
    </div>
  );
}
