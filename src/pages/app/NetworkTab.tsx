import { ArrowRight, X } from "lucide-react";
import type { OperationRequest } from "../../../shared/operations";
import type { PortMapping } from "../../../shared/types";
import type { AppView } from "../../api/client";
import { DomainLink } from "../../components/DomainLink";
import {
  OperationButton,
  removeButton,
  textButton,
} from "../../components/OperationButton";
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

const defaultMapping: PortMapping = { scheme: "http", host: 80, container: 5000 };

const setMapping = ({ scheme, host, container }: PortMapping): PortMapping => ({
  scheme,
  host,
  container,
});

export function NetworkTab({ app }: { app: AppView }) {
  const { proxyRestore } = app;
  const proxyRequest: OperationRequest = app.proxyEnabled
    ? { op: "proxy:disable", app: app.name }
    : {
        op: "proxy:enable",
        app: app.name,
        ...(proxyRestore && proxyRestore.ports.length > 0
          ? { ports: proxyRestore.ports }
          : {}),
        ...(proxyRestore && proxyRestore.domains.length > 0
          ? { domains: proxyRestore.domains }
          : {}),
      };
  // Dokku shows the map it detected at deploy when none is set; it cannot be edited in
  // place, so the first change saves the whole list as the explicit map.
  const detectedPorts = app.ports.filter((p) => p.detected);
  const detectedOnly = app.ports.length > 0 && detectedPorts.length === app.ports.length;
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
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 px-4 py-3">
          <p className="min-w-0 max-w-[40ch] text-pretty text-dim">
            {app.proxyEnabled
              ? "nginx routes the domains below to this app's containers."
              : "No proxy in front of this app. It is only reachable through its published ports and attached networks."}
          </p>
          <OperationButton
            app={app}
            request={proxyRequest}
            label={app.proxyEnabled ? "Disable proxy" : "Enable proxy"}
            className={textButton}
          >
            {app.proxyEnabled ? "Disable proxy" : "Enable proxy"}
          </OperationButton>
        </div>
        {!app.proxyEnabled && proxyRestore && (
          <p className="px-4 pb-3 text-xs text-faint">
            The port map and domains from before the proxy was disabled can be restored
            when enabling it.
          </p>
        )}
        <Command>{`dokku proxy:${app.proxyEnabled ? "disable" : "enable"} ${app.name}`}</Command>
      </Panel>

      <Panel
        title="Domains (vhosts)"
        action={
          <div className="flex gap-2">
            <OperationButton
              app={app}
              request={{
                op: "domains:set",
                app: app.name,
                domains: app.domains.length > 0 ? app.domains : [""],
              }}
              label="Set domains"
              className={textButton}
            >
              Set all
            </OperationButton>
            <OperationButton
              app={app}
              request={{ op: "domains:add", app: app.name, domains: [""] }}
              label="Add domain"
              className={textButton}
            >
              Add
            </OperationButton>
          </div>
        }
      >
        {app.domains.length > 0 ? (
          <ul className="divide-y divide-line">
            {app.domains.map((d) => (
              <li key={d} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <DomainLink host={d} />
                <span className="flex shrink-0 items-center gap-2">
                  {d === `${app.name}.${app.globalDomain}` && (
                    <span className="text-xs text-faint">default</span>
                  )}
                  <OperationButton
                    app={app}
                    request={{ op: "domains:remove", app: app.name, domains: [d] }}
                    label={`Remove ${d}`}
                    className={removeButton}
                  >
                    <X className="size-4" aria-hidden="true" />
                  </OperationButton>
                </span>
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

      <Panel
        title="Port mappings"
        action={
          <div className="flex gap-2">
            <OperationButton
              app={app}
              request={{
                op: "ports:set",
                app: app.name,
                mappings:
                  app.ports.length > 0 ? app.ports.map(setMapping) : [defaultMapping],
              }}
              label="Set port mappings"
              className={textButton}
            >
              Set all
            </OperationButton>
            <OperationButton
              app={app}
              request={
                detectedOnly
                  ? {
                      op: "ports:set",
                      app: app.name,
                      mappings: [
                        ...app.ports.map(setMapping),
                        { ...defaultMapping, host: 8080 },
                      ],
                    }
                  : { op: "ports:add", app: app.name, mappings: [defaultMapping] }
              }
              note={
                detectedOnly
                  ? "No port map is set: these mappings are what Dokku detected at the last deploy. Adding one saves the whole list below as the app's explicit map."
                  : undefined
              }
              label="Add port mapping"
              className={textButton}
            >
              Add
            </OperationButton>
          </div>
        }
      >
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
                {p.detected ? (
                  <span
                    className="ml-auto text-xs text-faint"
                    title="Detected at the last deploy, not set; there is nothing to remove."
                  >
                    detected
                  </span>
                ) : (
                  <OperationButton
                    app={app}
                    request={{
                      op: "ports:remove",
                      app: app.name,
                      mappings: [setMapping(p)],
                    }}
                    label={`Remove ${p.scheme}:${p.host}:${p.container}`}
                    className={`${removeButton} ml-auto`}
                  >
                    <X className="size-4" aria-hidden="true" />
                  </OperationButton>
                )}
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
