import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, X } from "lucide-react";
import type { OperationRequest } from "../../../shared/operations";
import type { NetworkAttachment, PortMapping } from "../../../shared/types";
import type { AppView } from "../../api/client";
import { servicesQuery } from "../../api/queries";
import { DomainLink } from "../../components/DomainLink";
import {
  OperationButton,
  removeButton,
  textButton,
} from "../../components/OperationButton";
import { Signal } from "../../components/Signal";
import { EmptyNote, ErrorNote, Mono, Panel, Skeleton } from "../../components/ui";

function Command({ children }: { children: string }) {
  return (
    <p className="border-t border-line px-4 py-2.5 font-mono text-xs text-faint">
      <span className="select-none">$ </span>
      {children}
    </p>
  );
}

const attachmentRows = [
  { property: "initial-network", label: "Initial network" },
  { property: "attach-post-create", label: "Attach after create" },
  { property: "attach-post-deploy", label: "Attach after deploy" },
] as const satisfies readonly { property: NetworkAttachment; label: string }[];

const defaultMapping: PortMapping = { scheme: "http", host: 80, container: 5000 };

const setMapping = ({ scheme, host, container }: PortMapping): PortMapping => ({
  scheme,
  host,
  container,
});

/** The datastore services linked to the app, with unlink, and the picker to link another. */
function ServicesPanel({ app }: { app: AppView }) {
  const {
    data: groups = [],
    isPending,
    error,
    isFetching,
    refetch,
  } = useQuery(servicesQuery);
  const all = groups.flatMap((g) => g.services);
  const unlinked = all.filter((s) => !s.apps.includes(app.name));
  const noneInstalled = groups.length === 0;
  return (
    <Panel
      title="Services"
      action={
        <OperationButton
          app={app}
          request={{
            op: "service:link",
            type: "",
            name: "",
            app: app.name,
            restart: true,
          }}
          disabledReason={
            isPending
              ? "Loading the services..."
              : error
                ? "The services could not be read."
                : noneInstalled
                  ? "No service plugin is installed on the host."
                  : unlinked.length === 0
                    ? "Every service is already linked."
                    : undefined
          }
          label="Link a service"
          className={textButton}
        >
          Link a service
        </OperationButton>
      }
    >
      {error ? (
        <ErrorNote error={error} onRetry={() => void refetch()} retrying={isFetching} />
      ) : isPending ? (
        <Skeleton className="m-4 h-10" />
      ) : app.services.length > 0 ? (
        <ul className="divide-y divide-line">
          {app.services.map(({ type, name }) => (
            <li
              key={`${type}:${name}`}
              className="flex items-center justify-between gap-3 px-4 py-2.5"
            >
              <span className="flex min-w-0 items-baseline gap-2">
                <Link
                  to="/services"
                  className="truncate font-mono hover:text-accent hover:underline"
                >
                  {name}
                </Link>
                <span className="text-xs text-faint">{type}</span>
              </span>
              <OperationButton
                app={app}
                request={{
                  op: "service:unlink",
                  type,
                  name,
                  app: app.name,
                  restart: true,
                }}
                label={`Unlink ${name}`}
                className={removeButton}
              >
                <X className="size-4" aria-hidden="true" />
              </OperationButton>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyNote>
          {noneInstalled
            ? "No service plugin is installed on the host."
            : "No service is linked to this app."}
        </EmptyNote>
      )}
      {app.partial?.includes("services") && (
        <p className="border-t border-line px-4 py-2.5 text-xs text-warn">
          Could not read every service plugin, so this list may be incomplete.
        </p>
      )}
      <p className="border-t border-line px-4 py-2.5 text-xs text-faint">
        Linking sets the service's URL as a config var (DATABASE_URL, REDIS_URL...) and
        restarts a running app unless you opt out.
      </p>
      {groups.map((g) => (
        <Command key={g.type}>{`dokku ${g.type}:app-links ${app.name}`}</Command>
      ))}
    </Panel>
  );
}

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

      <Panel
        title="Attached networks"
        action={
          <OperationButton
            app={app}
            request={{
              op: "network:alias-add",
              app: app.name,
              alias: "",
              rebuild: false,
            }}
            label="Add alias"
            className={textButton}
          >
            Add alias
          </OperationButton>
        }
      >
        <dl className="divide-y divide-line">
          {attachmentRows.map(({ property, label }) => {
            const networks = app.attachments[property];
            return (
              <div
                key={property}
                className="flex items-center justify-between gap-3 px-4 py-2.5"
              >
                <div className="min-w-0">
                  <dt className="label">{label}</dt>
                  <dd className="flex flex-wrap gap-x-3">
                    {networks.length > 0 ? (
                      networks.map((n) => <Mono key={n}>{n}</Mono>)
                    ) : (
                      <span className="text-faint">none</span>
                    )}
                  </dd>
                </div>
                <OperationButton
                  app={app}
                  request={{
                    op: "network:set",
                    app: app.name,
                    property,
                    networks,
                    rebuild: false,
                  }}
                  label={`Edit ${label}`}
                  className={textButton}
                >
                  Edit
                </OperationButton>
              </div>
            );
          })}
          <div className="flex flex-col gap-1.5 px-4 py-2.5">
            <dt className="label">Aliases</dt>
            <dd>
              {app.aliases.length > 0 ? (
                <ul className="flex flex-col">
                  {app.aliases.map((alias) => (
                    <li key={alias} className="flex items-center justify-between gap-3">
                      <Mono>{alias}</Mono>
                      <OperationButton
                        app={app}
                        request={{
                          op: "network:alias-remove",
                          app: app.name,
                          alias,
                          rebuild: false,
                        }}
                        label={`Remove alias ${alias}`}
                        className={removeButton}
                      >
                        <X className="size-4" aria-hidden="true" />
                      </OperationButton>
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="text-faint">none</span>
              )}
            </dd>
          </div>
        </dl>
        <p className="border-t border-line px-4 py-2.5 text-xs text-faint">
          Attach settings and aliases apply on the next deploy or rebuild; the running
          container keeps the networks it has until then.
        </p>
        <Command>{`dokku network:report ${app.name}`}</Command>
      </Panel>

      <ServicesPanel app={app} />
    </div>
  );
}
