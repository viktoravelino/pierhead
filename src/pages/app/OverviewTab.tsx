import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { Build } from "../../../shared/types";
import type { AppView } from "../../api/client";
import { deploysQuery } from "../../api/queries";
import { DomainLink } from "../../components/DomainLink";
import { DeployBadge, ProcessBadge } from "../../components/Signal";
import { EmptyNote, Mono, Panel, RevisionStamp, Skeleton } from "../../components/ui";
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
        <Panel title="Processes">
          {app.processes.length === 0 && (
            <EmptyNote>
              {app.status.kind === "not-deployed"
                ? "No processes. This app has never been deployed."
                : "No processes."}
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

      {sample && <DeployHistory name={app.name} />}
    </div>
  );
}
