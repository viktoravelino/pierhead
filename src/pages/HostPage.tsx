import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import type { DokkuHost, PierheadConfig } from "../../shared/types";
import { dataSource } from "../api/client";
import { hostDetailsQuery } from "../api/queries";
import { OperationButton, removeButton, textButton } from "../components/OperationButton";
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

/** The global domains, each removable, with Add and a Replace-all that starts from the current list. */
function GlobalDomains({ domains }: { domains: string[] }) {
  return (
    <div className="flex flex-col items-end gap-2">
      {domains.length === 0 ? (
        none
      ) : (
        <ul className="flex flex-col items-end">
          {domains.map((domain) => (
            <li key={domain} className="flex items-center gap-1">
              <Mono>{domain}</Mono>
              <OperationButton
                request={{ op: "domains:remove-global", domains: [domain] }}
                label={`Remove global domain ${domain}`}
                className={removeButton}
              >
                <X className="size-4" aria-hidden="true" />
              </OperationButton>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <OperationButton
          request={{ op: "domains:add-global", domains: [""] }}
          label="Add global domain"
          className={textButton}
        >
          Add
        </OperationButton>
        {domains.length > 0 && (
          <OperationButton
            request={{ op: "domains:set-global", domains }}
            label="Replace the global domains"
            className={textButton}
          >
            Replace all
          </OperationButton>
        )}
      </div>
    </div>
  );
}

/** The branch Dokku deploys from by default; Clear only while a global one is set. */
function DeployBranch({ host }: { host: DokkuHost }) {
  return (
    <div className="flex flex-col items-end gap-2">
      {host.deployBranch ? (
        <span>
          <Mono>{host.deployBranch}</Mono>
          {!host.globalDeployBranch && (
            <span className="text-dim"> (Dokku's default)</span>
          )}
        </span>
      ) : (
        none
      )}
      <div className="flex gap-2">
        <OperationButton
          request={{ op: "git:set-global", branch: host.globalDeployBranch ?? "" }}
          label="Set the global deploy branch"
          className={textButton}
        >
          Edit
        </OperationButton>
        {host.globalDeployBranch && (
          <OperationButton
            request={{ op: "git:set-global", branch: "" }}
            label="Clear the global deploy branch"
            className={textButton}
          >
            Clear
          </OperationButton>
        )}
      </div>
    </div>
  );
}

const dokkuRows = (d: DokkuHost): Row[] => [
  ["Dokku version", <Mono key="v">{d.version}</Mono>],
  ["Global domain", <GlobalDomains key="d" domains={d.globalDomains} />],
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
  ["Deploy branch", <DeployBranch key="g" host={d} />],
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
      <p className="border-t border-line px-4 py-3 text-pretty text-xs text-dim">
        Pierhead only lists keys. Adding or removing one needs root on the Dokku host:
        Dokku refuses <Mono>ssh-keys:add</Mono> and <Mono>ssh-keys:remove</Mono> for the{" "}
        <Mono>dokku</Mono> user pierhead connects as, and giving pierhead a sudo rule for
        them would widen what a leaked pierhead key can do. On the host, run{" "}
        <Mono>sudo dokku ssh-keys:add &lt;name&gt; &lt;public-key-file&gt;</Mono> or{" "}
        <Mono>sudo dokku ssh-keys:remove &lt;name&gt;</Mono>.
      </p>
    </Panel>
  );
}

export function HostPage() {
  const { data, error, isPending, isFetching, refetch } = useQuery(hostDetailsQuery);
  return (
    <>
      <PageHeader
        title="Host"
        subtitle="What Dokku reports about this host, and how pierhead is configured. The global domains and deploy branch can be edited."
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
