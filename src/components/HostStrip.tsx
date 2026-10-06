import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { HostMetrics, HostMetricsHistory, Metric } from "../../shared/types";
import type { HostView } from "../api/client";
import { hostMetricsQuery, hostQuery } from "../api/queries";
import { clockTime, formatUptime } from "../lib/time";
import { Meter } from "./Meter";
import { Sparkline } from "./Sparkline";
import { ErrorNote, Mono, Skeleton } from "./ui";

/** One gauge tile, whichever source fed it. */
type Gauge = {
  label: string;
  value: string;
  unit: string;
  percent: number;
  detail: string;
  series: number[];
};

/** What the strip shows besides identity: facts, gauges and (live only) how fresh they are. */
type Machine = {
  uptime: string;
  facts: { label: string; value: string }[];
  gauges: Gauge[];
  /** ISO time the numbers date from when Glances stopped answering. */
  staleSince: string | null;
};

const mockMachine = (m: NonNullable<HostView["machine"]>): Machine => {
  const used = (metric: Metric) => ({
    value: metric.unit === "%" ? String(Math.round(metric.used)) : String(metric.used),
    unit: metric.unit === "%" ? "%" : `/ ${metric.total} GB`,
    percent: (metric.used / metric.total) * 100,
    series: metric.series,
  });
  return {
    uptime: `${m.uptimeDays}d`,
    facts: [
      { label: "OS", value: m.os },
      { label: "Docker", value: m.docker },
      { label: "Hardware", value: `${m.cores} cores, ${m.memoryGb} GB` },
    ],
    gauges: [
      { label: "CPU", ...used(m.cpu), detail: `${m.cores} cores` },
      { label: "Memory", ...used(m.memory), detail: `${m.memoryGb} GB` },
      { label: "Disk", ...used(m.disk), detail: `${m.diskGb} GB` },
    ],
    staleSince: null,
  };
};

const gb = (bytes: number) => bytes / 1024 ** 3;
const gbText = (bytes: number) => gb(bytes).toFixed(1);
const percentOf = (used: number, total: number) => (total > 0 ? (used / total) * 100 : 0);

const liveMachine = (
  m: HostMetrics,
  history: HostMetricsHistory,
  staleSince: string | null,
): Machine => {
  const { memory, disk } = m;
  return {
    uptime: formatUptime(m.uptimeSeconds),
    facts: [
      { label: "OS", value: m.os },
      ...(m.kernel ? [{ label: "Kernel", value: m.kernel }] : []),
      {
        label: "Hardware",
        value: `${m.cores} cores, ${gbText(memory.totalBytes)} GB`,
      },
    ],
    gauges: [
      {
        label: "CPU",
        value: String(Math.round(m.cpuPercent)),
        unit: "%",
        percent: m.cpuPercent,
        detail: `${m.cores} cores`,
        series: history.cpu,
      },
      {
        label: "Memory",
        value: gbText(memory.usedBytes),
        unit: `/ ${gbText(memory.totalBytes)} GB`,
        percent: percentOf(memory.usedBytes, memory.totalBytes),
        detail: `load ${m.load.min1.toFixed(2)}`,
        series: history.memory,
      },
      {
        label: "Disk",
        value: gbText(disk.usedBytes),
        unit: `/ ${gbText(disk.totalBytes)} GB`,
        percent: percentOf(disk.usedBytes, disk.totalBytes),
        detail: disk.mount,
        series: history.disk,
      },
    ],
    staleSince,
  };
};

function MetricTile({ label, value, unit, percent, detail, series }: Gauge) {
  return (
    <div className="flex min-w-0 flex-col gap-2.5 bg-panel p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="label">{label}</h3>
        <span className="truncate text-xs text-faint">{detail}</span>
      </div>
      <p className="tabular text-2xl font-semibold tracking-tight">
        {value}
        <span className="ml-1 text-sm font-medium text-dim">{unit}</span>
      </p>
      <Meter percent={percent} label={`${label} usage`} />
      <Sparkline values={series} />
    </div>
  );
}

function Fact({ label, children }: { label: string; children: string | number }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="label">{label}</dt>
      <dd className="break-words font-mono text-[13px]">{children}</dd>
    </div>
  );
}

/** Stand-in for the gauges while nothing reports them. */
function MetricsNotConnected({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="grid gap-4 md:grid-cols-3">
        {["CPU", "Memory", "Disk"].map((label) => (
          <div key={label} className="flex flex-col gap-2.5">
            <h3 className="label">{label}</h3>
            <p className="text-2xl font-semibold tracking-tight text-faint">--</p>
            <div
              aria-hidden="true"
              className="h-2 rounded-[2px] border border-dashed border-line-strong"
            />
          </div>
        ))}
      </div>
      <p className="text-pretty text-dim">{children}</p>
    </div>
  );
}

const notConnected = (
  <>
    <strong className="font-semibold text-fg">Metrics not connected yet.</strong> CPU,
    memory and disk usage, plus the host's OS and hardware facts, appear here once{" "}
    <Mono>GLANCES_URL</Mono> points at a Glances server.
  </>
);

/** The mock machine, or the live Glances reading; null while there is nothing to show. */
function useMachine(host: HostView) {
  const live = useQuery({ ...hostMetricsQuery, enabled: host.machine === null });
  if (host.machine) return { machine: mockMachine(host.machine), note: null };
  const body = live.data;
  if (!body) return { machine: null, note: null };
  switch (body.status) {
    case "ok":
      return { machine: liveMachine(body.metrics, body.history, null), note: null };
    case "unreachable":
      return {
        machine: body.metrics
          ? liveMachine(body.metrics, body.history, body.sampledAt)
          : null,
        note: `Glances is unreachable: ${body.error}`,
      };
    case "not-configured":
      return { machine: null, note: null };
  }
}

function Strip({ host }: { host: HostView }) {
  const { machine, note } = useMachine(host);
  return (
    <>
      <div className="chart-dots flex flex-col gap-4 border-b border-line p-4 md:flex-row md:items-center md:justify-between">
        <div className="flex items-baseline gap-3">
          <h2 className="font-mono text-xl font-medium">{host.name}</h2>
          {host.address && <Mono className="text-dim">{host.address}</Mono>}
          {machine && <span className="text-xs text-faint">up {machine.uptime}</span>}
        </div>
        <dl className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-4 md:flex md:gap-x-7">
          <Fact label="Dokku">{`v${host.dokkuVersion}`}</Fact>
          {machine?.facts.map(({ label, value }) => (
            <Fact key={label} label={label}>
              {value}
            </Fact>
          ))}
        </dl>
      </div>
      {machine ? (
        <>
          <div
            className={`grid gap-px bg-line md:grid-cols-3 ${machine.staleSince ? "opacity-50" : ""}`}
          >
            {machine.gauges.map((gauge) => (
              <MetricTile key={gauge.label} {...gauge} />
            ))}
          </div>
          {machine.staleSince && (
            <p className="border-t border-line p-4 text-pretty text-warn">
              Metrics stale since {clockTime(machine.staleSince)}. {note}
            </p>
          )}
        </>
      ) : (
        <MetricsNotConnected>{note ?? notConnected}</MetricsNotConnected>
      )}
    </>
  );
}

/** Host identity plus CPU / memory / disk gauges with recent trend, when the host reports them. */
export function HostStrip() {
  const { data, error, isPending, isFetching, refetch } = useQuery(hostQuery);
  return (
    <section
      aria-label="Host"
      className="overflow-hidden rounded-md border border-line bg-panel"
    >
      {error ? (
        <ErrorNote error={error} onRetry={() => void refetch()} retrying={isFetching} />
      ) : isPending || !data ? (
        <div className="flex flex-col gap-4 p-4">
          <Skeleton className="h-6 w-64" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : (
        <Strip host={data} />
      )}
    </section>
  );
}
