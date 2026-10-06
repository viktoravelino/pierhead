import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { DokkuHost, PierheadConfig } from "../../shared/types";
import { dataSource } from "../api/client";
import { hostDetailsQuery } from "../api/queries";
import { ErrorNote, Mono, PageHeader, Panel, Skeleton } from "../components/ui";

type Row = readonly [label: string, value: ReactNode];

const none = <span className="text-faint">none</span>;

function Rows({ rows }: { rows: Row[] }) {
  return (
    <dl className="divide-y divide-line">
      {rows.map(([k, v]) => (
        <div
          key={k}
          className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-0.5 px-4 py-2.5"
        >
          <dt className="text-dim">{k}</dt>
          <dd className="min-w-0 break-words text-right">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

const metricsLabel = {
  ok: "connected",
  unreachable: "unreachable",
  "not-configured": "not configured",
} as const satisfies Record<PierheadConfig["metrics"], string>;

const dokkuRows = (d: DokkuHost): Row[] => [
  ["Dokku version", <Mono key="v">{d.version}</Mono>],
  [
    "Global domain",
    d.globalDomains.length > 0 ? <Mono key="d">{d.globalDomains.join(", ")}</Mono> : none,
  ],
  ["Proxy", d.proxyType ? <Mono key="p">{d.proxyType}</Mono> : none],
  ["Scheduler", d.scheduler ? <Mono key="s">{d.scheduler}</Mono> : none],
  [
    "Builder",
    d.builder.selected ? (
      <Mono key="b">
        {d.builder.selected}
        {d.builder.buildDir && ` / ${d.builder.buildDir}`}
      </Mono>
    ) : (
      <span key="b" className="text-dim">
        detected per app
      </span>
    ),
  ],
  ["Deploy branch", d.deployBranch ? <Mono key="g">{d.deployBranch}</Mono> : none],
];

const pierheadRows = (p: PierheadConfig): Row[] => [
  ["Data source", <Mono key="ds">{dataSource}</Mono>],
  ["Writes", p.writesEnabled ? "enabled" : "disabled (read-only)"],
  [
    "Read cache",
    <Mono key="c">{p.cacheTtlMs === 0 ? "off" : `${p.cacheTtlMs / 1000}s`}</Mono>,
  ],
  ["Host metrics", metricsLabel[p.metrics]],
  [
    "SSH target",
    <Mono key="t">
      {p.ssh.user}@{p.ssh.host}:{p.ssh.port}
    </Mono>,
  ],
];

function Plugins({ plugins }: { plugins: DokkuHost["plugins"] }) {
  const extra = plugins.filter((p) => !p.core);
  const core = plugins.filter((p) => p.core);
  const items = [...extra, ...core];
  return (
    <Panel
      title="Plugins"
      action={
        <span className="text-xs text-faint">
          {core.length} core, {extra.length} added
        </span>
      }
    >
      <ul className="divide-y divide-line">
        {items.map((p) => (
          <li
            key={p.name}
            className="flex flex-wrap items-baseline justify-between gap-x-4 px-4 py-2"
          >
            <span className="flex items-baseline gap-2">
              <Mono>{p.name}</Mono>
              {!p.core && (
                <span className="rounded-sm border border-accent/40 px-1.5 text-[10px] font-medium uppercase tracking-wide text-accent">
                  added
                </span>
              )}
              {!p.enabled && <span className="text-xs text-warn">disabled</span>}
            </span>
            <Mono className="text-xs text-dim">{p.version}</Mono>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function SshKeys({ keys }: { keys: DokkuHost["sshKeys"] }) {
  return (
    <Panel
      title="SSH keys"
      action={<span className="text-xs text-faint">{keys.length}</span>}
    >
      {keys.length === 0 ? (
        <p className="px-4 py-3 text-dim">No keys registered.</p>
      ) : (
        <ul className="divide-y divide-line">
          {keys.map((k) => (
            <li key={k.fingerprint} className="flex flex-col gap-0.5 px-4 py-2.5">
              <Mono className="font-medium">{k.name}</Mono>
              <Mono className="break-all text-xs text-dim">{k.fingerprint}</Mono>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function HostPage() {
  const { data, error, isPending, isFetching, refetch } = useQuery(hostDetailsQuery);
  return (
    <>
      <PageHeader
        title="Host"
        subtitle="What Dokku reports about this host, and how pierhead is configured. Read-only."
      />
      {error ? (
        <Panel title="Host" className="max-w-3xl">
          <ErrorNote error={error} onRetry={() => void refetch()} retrying={isFetching} />
        </Panel>
      ) : isPending || !data ? (
        <Skeleton className="h-64 w-full max-w-3xl" />
      ) : (
        <div className="grid max-w-5xl items-start gap-6 lg:grid-cols-2">
          <div className="flex flex-col gap-6">
            <Panel title="Dokku">
              <Rows rows={dokkuRows(data.dokku)} />
            </Panel>
            <Panel title="Pierhead">
              <Rows rows={pierheadRows(data.pierhead)} />
            </Panel>
            <SshKeys keys={data.dokku.sshKeys} />
          </div>
          <Plugins plugins={data.dokku.plugins} />
        </div>
      )}
    </>
  );
}
