import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Download, Eye, EyeOff, Link2, Plus, ScrollText, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type ServiceRequest, serviceAvailability } from "../../shared/operations";
import type {
  AppSummary,
  Service,
  ServiceGroup,
  ServiceStatus,
} from "../../shared/types";
import { describeError, downloadServiceExport } from "../api/backend";
import { dataSource, getServiceDsn, subscribeToServiceLogs } from "../api/client";
import { appsQuery, servicesQuery } from "../api/queries";
import { CopyButton, iconButton } from "../components/CopyButton";
import { OperationButton, removeButton, textButton } from "../components/OperationButton";
import { useWrites } from "../components/OperationHost";
import { Signal } from "../components/Signal";
import { useToast } from "../components/Toast";
import {
  EmptyNote,
  ErrorNote,
  Mono,
  PageHeader,
  Panel,
  Skeleton,
} from "../components/ui";

const statusSignal = {
  running: { tone: "ok", label: "Running" },
  stopped: { tone: "idle", label: "Stopped" },
  unknown: { tone: "warn", label: "Unknown" },
} as const satisfies Record<
  ServiceStatus,
  { tone: "ok" | "idle" | "warn"; label: string }
>;

/** Why a control for `req` is off: the server's write switch first, then the service's state. */
function useServiceReason(req: ServiceRequest, service: Service) {
  const writes = useWrites();
  if (!writes.enabled) return writes.reason;
  const availability = serviceAvailability(req, service);
  return availability.ok ? undefined : availability.reason;
}

/**
 * A service button for one operation on `service`, disabled with the reason as its tooltip.
 * `OperationButton` adds the "another operation is running" case.
 */
function ServiceButton({
  service,
  request,
  label,
  className = textButton,
  children,
}: {
  service: Service;
  request: ServiceRequest;
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  const reason = useServiceReason(request, service);
  return (
    <OperationButton
      request={request}
      label={label}
      disabledReason={reason}
      className={className}
    >
      {children}
    </OperationButton>
  );
}

/**
 * The connection string, masked. Its real value is fetched when Reveal is pressed and
 * lives only in this mutation's state, so Hide (or leaving the page) discards it.
 */
function ConnectionString({ service }: { service: Service }) {
  const { type, name, maskedDsn } = service;
  const reveal = useMutation({
    mutationFn: () => getServiceDsn(type, name),
    // Not kept once hidden: the revealed string must not outlive the view.
    gcTime: 0,
  });
  const dsn = reveal.data;
  const revealed = dsn !== undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <p className="label">Connection string</p>
      <div className="flex items-center gap-2">
        <span
          className={`min-w-0 flex-1 break-all font-mono text-[13px] ${
            revealed || maskedDsn ? "" : "text-faint"
          }`}
        >
          {revealed ? dsn : (maskedDsn ?? "none")}
        </span>
        {revealed && <CopyButton name={`${name} connection string`} value={dsn} />}
        <button
          type="button"
          onClick={() => (revealed ? reveal.reset() : reveal.mutate())}
          disabled={reveal.isPending}
          aria-pressed={revealed}
          aria-label={`${revealed ? "Hide" : "Reveal"} connection string of ${name}`}
          title={revealed ? "Hide connection string" : "Reveal connection string"}
          className={iconButton}
        >
          {revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
        </button>
      </div>
      {reveal.isError && (
        <p role="alert" className="text-sm text-crit">
          {describeError(reveal.error).message}
        </p>
      )}
    </div>
  );
}

const maxLogLines = 500;

/** The service's recent log, then new lines as they arrive; closes the stream when it unmounts. */
function ServiceLogs({ service }: { service: Service }) {
  const { type, name } = service;
  const [lines, setLines] = useState<string[]>([]);
  const [ended, setEnded] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` restarts the stream
  useEffect(() => {
    setLines([]);
    setEnded(null);
    return subscribeToServiceLogs(type, name, {
      onLines: (events) =>
        setLines((all) => [...all, ...events.map((e) => e.line)].slice(-maxLogLines)),
      onEnd: (end) => setEnded(end.kind === "exited" ? "Ended" : end.message),
    });
  }, [type, name, attempt]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: follow the output whenever a line arrives
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [lines]);

  return (
    <div className="flex flex-col gap-1.5">
      <div
        ref={scroller}
        role="log"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region must be keyboard reachable
        tabIndex={0}
        aria-label={`Logs of ${name}`}
        className="h-56 overflow-auto rounded-sm border border-line bg-sunken px-3 py-2 font-mono text-xs leading-5 whitespace-pre-wrap break-words"
      >
        {lines.length > 0 ? lines.join("\n") : "No output yet."}
      </div>
      <p className="flex items-center gap-2 text-xs text-dim">
        {ended ? ended : "Live"}
        {ended && (
          <button
            type="button"
            onClick={() => setAttempt((n) => n + 1)}
            className="rounded-sm border border-line-strong px-2 py-0.5 font-medium text-fg hover:bg-raised"
          >
            Reconnect
          </button>
        )}
      </p>
    </div>
  );
}

/** Downloads a dump: a privileged action, so it needs the write switch, and a running service. */
function ExportButton({ service }: { service: Service }) {
  const writes = useWrites();
  const notify = useToast();
  const download = useMutation({
    mutationFn: () => downloadServiceExport(service.type, service.name),
    onSuccess: () => notify({ message: `Exported ${service.name}.` }),
    onError: (error) =>
      notify({
        message: `Export of ${service.name} failed`,
        detail: describeError(error).message,
        tone: "error",
      }),
  });
  const reason =
    dataSource === "mock"
      ? "The preview has no dump to download."
      : !writes.enabled
        ? `Exporting needs writes: ${writes.reason}`
        : service.status !== "running"
          ? "Start the service first."
          : download.isPending
            ? "Exporting..."
            : undefined;
  return (
    <button
      type="button"
      disabled={reason !== undefined}
      title={reason ?? "Download a dump of the data"}
      aria-label={`Export ${service.name}`}
      onClick={() => download.mutate()}
      className={`${textButton} flex items-center gap-1.5`}
    >
      <Download className="size-3.5" aria-hidden="true" />
      {download.isPending ? "Exporting..." : "Export"}
    </button>
  );
}

function ServiceCard({ service, apps }: { service: Service; apps: AppSummary[] }) {
  const [showLogs, setShowLogs] = useState(false);
  const { type, name } = service;
  const signal = statusSignal[service.status];
  const link: ServiceRequest = {
    op: "service:link",
    type,
    name,
    app: "",
    restart: true,
  };
  const unlinkedApps = apps.filter((a) => !service.apps.includes(a.name));
  const linkReason = useServiceReason(link, service);
  const rows = [
    ["Exposed ports", service.exposedPorts.join(", ") || "not exposed"],
    ["Storage", service.dataDir],
    ["Container", service.containerId ? service.containerId.slice(0, 12) : "none"],
  ] as const;
  return (
    <article className="flex flex-col gap-4 rounded-md border border-line bg-panel p-4">
      <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="break-all font-mono text-lg font-medium">{name}</h3>
          <p className="break-all font-mono text-xs text-faint">{service.version}</p>
        </div>
        <Signal tone={signal.tone} label={signal.label} />
      </header>

      <ConnectionString service={service} />

      <div className="flex flex-col gap-1.5">
        <p className="label">Linked apps</p>
        {service.apps.length === 0 ? (
          <p className="text-dim">Not linked to any app.</p>
        ) : (
          <ul className="divide-y divide-line rounded-sm border border-line">
            {service.apps.map((app) => (
              <li
                key={app}
                className="flex items-center justify-between gap-3 py-1 pr-1 pl-3"
              >
                <Link
                  to="/apps/$appName"
                  params={{ appName: app }}
                  search={{ tab: "network" }}
                  className="font-mono hover:text-accent hover:underline"
                >
                  {app}
                </Link>
                <OperationButton
                  app={apps.find((a) => a.name === app)}
                  request={{ op: "service:unlink", type, name, app, restart: true }}
                  label={`Unlink ${name} from ${app}`}
                  className={removeButton}
                >
                  <X className="size-4" aria-hidden="true" />
                </OperationButton>
              </li>
            ))}
          </ul>
        )}
      </div>

      <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-dim">{label}</dt>
            <dd className="break-all font-mono text-[13px]">{value}</dd>
          </div>
        ))}
      </dl>

      <div className="flex flex-wrap gap-2">
        <ServiceButton
          service={service}
          request={{ op: "service:start", type, name }}
          label={`Start ${name}`}
        >
          Start
        </ServiceButton>
        <ServiceButton
          service={service}
          request={{ op: "service:stop", type, name }}
          label={`Stop ${name}`}
        >
          Stop
        </ServiceButton>
        <ServiceButton
          service={service}
          request={{ op: "service:restart", type, name }}
          label={`Restart ${name}`}
        >
          Restart
        </ServiceButton>
        <OperationButton
          request={link}
          label={`Link ${name} to an app`}
          disabledReason={
            linkReason ??
            (unlinkedApps.length === 0 ? "It is linked to every app." : undefined)
          }
          className={`${textButton} flex items-center gap-1.5`}
        >
          <Link2 className="size-3.5" aria-hidden="true" />
          Link
        </OperationButton>
        <button
          type="button"
          aria-pressed={showLogs}
          onClick={() => setShowLogs((open) => !open)}
          className={`${textButton} flex items-center gap-1.5 ${showLogs ? "bg-raised" : ""}`}
        >
          <ScrollText className="size-3.5" aria-hidden="true" />
          Logs
        </button>
        <ExportButton service={service} />
        <ServiceButton
          service={service}
          request={{ op: "service:destroy", type, name, confirm: "" }}
          label={`Destroy ${name}`}
          className={`${textButton} ml-auto text-crit`}
        >
          Destroy
        </ServiceButton>
      </div>

      {showLogs && <ServiceLogs service={service} />}
    </article>
  );
}

function GroupPanel({ group, apps }: { group: ServiceGroup; apps: AppSummary[] }) {
  return (
    <Panel
      title={`${group.type} · plugin ${group.pluginVersion}`}
      action={
        <OperationButton
          request={{ op: "service:create", type: group.type, name: "", version: "" }}
          label={`Create a ${group.type} service`}
          className={`${textButton} flex items-center gap-1.5`}
        >
          <Plus className="size-3.5" aria-hidden="true" />
          Create
        </OperationButton>
      }
    >
      {group.error ? (
        <p role="alert" className="p-4 text-crit">
          Could not read the {group.type} services: {group.error}
        </p>
      ) : group.services.length === 0 ? (
        <EmptyNote>No {group.type} service yet.</EmptyNote>
      ) : (
        <div className="grid gap-4 p-4 xl:grid-cols-2">
          {group.services.map((service) => (
            <ServiceCard key={service.name} service={service} apps={apps} />
          ))}
        </div>
      )}
    </Panel>
  );
}

export function ServicesPage() {
  const { data, error, isPending, isFetching, refetch } = useQuery(servicesQuery);
  const { data: apps = [] } = useQuery(appsQuery);
  return (
    <>
      <PageHeader
        title="Services"
        subtitle={
          <>
            Datastores Dokku runs for apps, one group per installed service plugin.
            Services created here are <strong className="font-medium text-fg">not</strong>{" "}
            covered by the lab's nightly backup.
          </>
        }
        actions={
          <OperationButton
            request={{
              op: "service:create",
              type: data?.[0]?.type ?? "",
              name: "",
              version: "",
            }}
            disabledReason={
              data?.length === 0
                ? "No service plugin is installed on the host."
                : undefined
            }
            label="Create service"
            className={`${textButton} flex items-center gap-1.5`}
          >
            <Plus className="size-3.5" aria-hidden="true" />
            Create service
          </OperationButton>
        }
      />
      {error ? (
        <Panel title="Services" className="max-w-3xl">
          <ErrorNote error={error} onRetry={() => void refetch()} retrying={isFetching} />
        </Panel>
      ) : isPending || !data ? (
        <Skeleton className="h-40 w-full max-w-3xl" />
      ) : data.length === 0 ? (
        <Panel title="Services" className="max-w-3xl">
          <EmptyNote>
            No service plugin is installed. Install one on the host (for example{" "}
            <Mono>dokku plugin:install https://github.com/dokku/dokku-postgres.git</Mono>)
            and it appears here.
          </EmptyNote>
        </Panel>
      ) : (
        <div className="flex max-w-6xl flex-col gap-6">
          {data.map((group) => (
            <GroupPanel key={group.type} group={group} apps={apps} />
          ))}
        </div>
      )}
    </>
  );
}
