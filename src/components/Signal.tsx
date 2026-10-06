import type {
  AppStatus,
  BuildStatus,
  Deploy,
  DeployStep,
  ProcessState,
} from "../../shared/types";

// Status is carried by shape and label as well as colour: circle = healthy, pennant =
// underway, diamond = fault, hollow square = idle, dashed hollow circle = not there yet.
type Tone = "ok" | "warn" | "crit" | "idle" | "none";

const toneClass = {
  ok: "text-ok border-ok/30 bg-ok/10",
  warn: "text-warn border-warn/35 bg-warn/10",
  crit: "text-crit border-crit/35 bg-crit/10",
  idle: "text-idle border-idle/30 bg-idle/10",
  none: "text-idle border-dashed border-idle/45",
} as const satisfies Record<Tone, string>;

function Mark({ tone, pulse }: { tone: Tone; pulse?: boolean }) {
  return (
    <svg
      viewBox="0 0 10 10"
      width="10"
      height="10"
      aria-hidden="true"
      className={`shrink-0 ${pulse ? "animate-signal" : ""}`}
    >
      {tone === "ok" && <circle cx="5" cy="5" r="4" fill="currentColor" />}
      {tone === "warn" && <path d="M1 1 L9.5 5 L1 9 Z" fill="currentColor" />}
      {tone === "crit" && <path d="M5 0.3 L9.7 5 L5 9.7 L0.3 5 Z" fill="currentColor" />}
      {tone === "none" && (
        <circle
          cx="5"
          cy="5"
          r="3.7"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeDasharray="2.2 1.6"
        />
      )}
      {tone === "idle" && (
        <rect
          x="1.4"
          y="1.4"
          width="7.2"
          height="7.2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
      )}
    </svg>
  );
}

export function Signal({
  tone,
  label,
  pulse,
}: {
  tone: Tone;
  label: string;
  pulse?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm border px-1.5 py-0.5 text-xs font-medium ${toneClass[tone]}`}
    >
      <Mark tone={tone} pulse={pulse} />
      {label}
    </span>
  );
}

const stepLabel = {
  fetch: "fetching",
  build: "building",
  release: "releasing",
  swap: "swapping",
} as const satisfies Record<DeployStep, string>;

export function appTone(status: AppStatus): Tone {
  switch (status.kind) {
    case "running":
      return "ok";
    case "deploying":
      return "warn";
    case "crashed":
      return "crit";
    case "stopped":
      return "idle";
    case "not-deployed":
      return "none";
  }
}

export function AppStatusBadge({ status }: { status: AppStatus }) {
  switch (status.kind) {
    case "running":
      return <Signal tone="ok" label="Running" />;
    case "stopped":
      return <Signal tone="idle" label="Stopped" />;
    case "not-deployed":
      return <Signal tone="none" label="Not deployed" />;
    case "deploying":
      return <Signal tone="warn" label={`Deploying, ${stepLabel[status.step]}`} pulse />;
    case "crashed":
      return <Signal tone="crit" label="Crash looping" pulse />;
  }
}

const processTone = {
  running: "ok",
  starting: "warn",
  restarting: "crit",
  exited: "idle",
} as const satisfies Record<ProcessState, Tone>;

export function ProcessBadge({ state }: { state: ProcessState }) {
  return (
    <Signal
      tone={processTone[state]}
      label={state}
      pulse={state === "starting" || state === "restarting"}
    />
  );
}

export function DeployBadge({ status }: { status: Deploy["status"] }) {
  switch (status) {
    case "succeeded":
      return <Signal tone="ok" label="Succeeded" />;
    case "failed":
      return <Signal tone="crit" label="Failed" />;
    case "in-progress":
      return <Signal tone="warn" label="In progress" pulse />;
  }
}

/** A Dokku build or deploy record's status. */
export function BuildBadge({ status }: { status: BuildStatus }) {
  switch (status) {
    case "succeeded":
      return <Signal tone="ok" label="Succeeded" />;
    case "failed":
      return <Signal tone="crit" label="Failed" />;
    case "running":
      return <Signal tone="warn" label="Running" pulse />;
    case "canceled":
      return <Signal tone="idle" label="Canceled" />;
    case "other":
      return <Signal tone="idle" label="Unknown" />;
  }
}
