import { ArrowRight } from "lucide-react";
import type { AppView } from "../../api/client";
import { DomainLink } from "../../components/DomainLink";
import { Signal } from "../../components/Signal";
import { EmptyNote, Mono, Panel } from "../../components/ui";

function Command({ children }: { children: string }) {
  return (
    <p className="border-t border-line px-4 py-2.5 font-mono text-xs text-faint">
      <span className="select-none">$ </span>
      {children}
    </p>
  );
}

export function NetworkTab({ app }: { app: AppView }) {
  return (
    <div className="grid items-start gap-6 lg:grid-cols-2">
      <Panel
        title="Proxy"
        action={
          app.proxyEnabled ? (
            <Signal tone="ok" label="Enabled" />
          ) : (
            <Signal tone="idle" label="Disabled" />
          )
        }
      >
        <p className="px-4 py-3 text-pretty text-dim">
          {app.proxyEnabled
            ? "nginx routes the domains below to this app's containers."
            : "No proxy in front of this app. It is only reachable through its published ports and attached networks."}
        </p>
        <Command>{`dokku proxy:${app.proxyEnabled ? "disable" : "enable"} ${app.name}`}</Command>
      </Panel>

      <Panel title="Domains (vhosts)">
        {app.domains.length > 0 ? (
          <ul className="divide-y divide-line">
            {app.domains.map((d) => (
              <li key={d} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <DomainLink host={d} />
                {d === `${app.name}.${app.globalDomain}` && (
                  <span className="shrink-0 text-xs text-faint">default</span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyNote>
            {app.proxyEnabled
              ? `No vhosts set. Falls back to ${app.name}.${app.globalDomain}.`
              : "No vhosts. This app is not served by the proxy."}
          </EmptyNote>
        )}
        <Command>{`dokku domains:report ${app.name}`}</Command>
      </Panel>

      <Panel title="Port mappings">
        {app.ports.length > 0 ? (
          <ul className="divide-y divide-line">
            {app.ports.map((p) => (
              <li
                key={`${p.scheme}${p.host}${p.container}`}
                className="flex items-center gap-3 px-4 py-2.5"
              >
                <Mono className="w-14 text-dim">{p.scheme}</Mono>
                <Mono className="tabular">host {p.host}</Mono>
                <ArrowRight className="size-3.5 text-faint" aria-label="maps to" />
                <Mono className="tabular">container {p.container}</Mono>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyNote>No port mappings.</EmptyNote>
        )}
        <Command>{`dokku ports:report ${app.name}`}</Command>
      </Panel>

      <Panel title="Attached networks">
        {app.networks.length === 0 && <EmptyNote>No networks attached.</EmptyNote>}
        <ul className="divide-y divide-line">
          {app.networks.map((n) => (
            <li
              key={n.name}
              className="flex items-center justify-between gap-3 px-4 py-2.5"
            >
              <Mono>{n.name}</Mono>
              {n.alias ? (
                <span className="text-xs text-dim">
                  alias <Mono className="text-fg">{n.alias}</Mono>
                </span>
              ) : (
                <span className="text-xs text-faint">no alias</span>
              )}
            </li>
          ))}
        </ul>
        <Command>{`dokku network:report ${app.name}`}</Command>
      </Panel>
    </div>
  );
}
