import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CircleCheck, CircleX, LoaderCircle, Plus, X } from "lucide-react";
import {
  createContext,
  Fragment,
  type ReactNode,
  use,
  useEffect,
  useRef,
  useState,
} from "react";
import { isDomain, portSchemes } from "../../shared/grammar";
import {
  commandLine,
  destructiveConfirm,
  type OperationRequest,
  parseOperation,
  streamsOutput,
} from "../../shared/operations";
import type { PortMapping } from "../../shared/types";
import { backendHealthQuery, describeError } from "../api/backend";
import { dataSource, runOperation } from "../api/client";
import { conflictProblem, forApp, operationUi, psOperationIds } from "../api/operations";
import { appsQuery, networksQuery } from "../api/queries";
import { useToast } from "./Toast";

/** Whether the server accepts operations; `reason` is what a disabled control says. */
export type Writes = { enabled: true } | { enabled: false; reason: string };

type OperationContextValue = {
  /** Opens the dialog for `request`, whose form fields start from its values. */
  request: (request: OperationRequest) => void;
  /** The operation in flight (the server runs one at a time from this tab), if any. */
  pending: OperationRequest | null;
  writes: Writes;
};

const OperationContext = createContext<OperationContextValue | null>(null);

function useOperationContext() {
  const context = use(OperationContext);
  if (!context) throw new Error("Operation hooks must be used inside OperationHost");
  return context;
}

/** Opens the dialog for any operation, from buttons or the command palette alike. */
export const useRequestOperation = () => useOperationContext().request;

/** The operation currently running, for pending states on buttons. */
export const usePendingOperation = () => useOperationContext().pending;

/** Whether operations can run: the mock never refuses, the real server says in its health. */
export const useWrites = () => useOperationContext().writes;

const inputClass =
  "h-9 w-full rounded-sm border border-line-strong bg-sunken px-2.5 font-mono text-[13px] focus:outline-2 focus:outline-accent";

const secondaryButton =
  "h-9 rounded-sm border border-line-strong px-3.5 font-medium hover:bg-sunken";

/** A wording with its `{app}` set in monospace. */
function WithApp({ text, app }: { text: string; app: string }) {
  const [before = "", ...after] = text.split("{app}");
  return (
    <>
      {before}
      {after.length > 0 && (
        <>
          <span className="font-mono">{app}</span>
          {after.join("{app}")}
        </>
      )}
    </>
  );
}

type Opened = { id: number; request: OperationRequest };
let nextOpened = 0;

/** Owns the single dialog: the form and confirm, then (for a deploy) a progress panel with its output. */
export function OperationHost({ children }: { children: ReactNode }) {
  const [opened, setOpened] = useState<Opened | null>(null);
  // The streamed operation whose panel is open. Closing the panel only hides it; the run goes on.
  const [panel, setPanel] = useState<OperationRequest | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  // A failure shown in the form, so what was typed survives it.
  const [formError, setFormError] = useState<string | null>(null);
  const notify = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const outputRef = useRef<HTMLPreElement>(null);
  const { data: health, isPending: healthPending } = useQuery({
    ...backendHealthQuery,
    enabled: dataSource === "api",
  });

  const writes: Writes =
    dataSource === "mock"
      ? { enabled: true }
      : healthPending
        ? { enabled: false, reason: "Checking the backend..." }
        : !health?.ok
          ? { enabled: false, reason: "The backend is offline." }
          : health.writesEnabled
            ? { enabled: true }
            : {
                enabled: false,
                reason:
                  "Read-only: the server was started without PIERHEAD_ALLOW_WRITES=true.",
              };

  const mutation = useMutation({
    mutationFn: (req: OperationRequest) =>
      runOperation(req, (line) => setLines((all) => [...all, line])),
    onSuccess: ({ detail }, req) => {
      setOpened(null);
      notify(
        dataSource === "mock"
          ? { message: "mock: would run", detail }
          : { message: forApp(operationUi[req.op].done, req.app), detail },
      );
      if (dataSource === "mock") return;
      if (req.op === "apps:create") {
        void navigate({ to: "/apps/$appName", params: { appName: req.app } });
      } else if (req.op === "apps:destroy") {
        void navigate({ to: "/" });
      }
    },
    onError: (error, req) => {
      const { message } = describeError(error);
      // The ps buttons have no form to keep open, so they report in a toast.
      if (psOperationIds.some((id) => id === req.op)) {
        setOpened(null);
        notify({
          message: `${operationUi[req.op].label} ${req.app} failed: ${message}`,
          tone: "error",
        });
      } else {
        setFormError(message);
      }
    },
    // Show the new state now instead of at the next poll.
    onSettled: () => {
      if (dataSource === "mock") return;
      void queryClient.invalidateQueries({ queryKey: appsQuery.queryKey });
      void queryClient.invalidateQueries({ queryKey: networksQuery.queryKey });
      void queryClient.invalidateQueries({ queryKey: backendHealthQuery.queryKey });
    },
  });
  const pending = mutation.isPending ? mutation.variables : null;

  const confirm = (confirmed: OperationRequest) => {
    setLines([]);
    setFormError(null);
    mutation.mutate(confirmed);
    const app = queryClient
      .getQueryData(appsQuery.queryKey)
      ?.find((a) => a.name === confirmed.app);
    if (dataSource === "api" && streamsOutput(confirmed, app ?? null)) {
      setOpened(null);
      setPanel(confirmed);
    }
  };

  const dialogOpen = opened !== null || panel !== null;
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (dialogOpen && !dialog.open) dialog.showModal();
    if (!dialogOpen && dialog.open) dialog.close();
  }, [dialogOpen]);

  // Follow the output as it grows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll whenever a line arrives
  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight });
  }, [lines]);

  const panelUi = panel ? operationUi[panel.op] : null;
  // The panel belongs to the latest run; a newer run replaces what it shows.
  const running = pending !== null;
  const failed = mutation.isError ? describeError(mutation.error).message : null;

  return (
    <OperationContext
      value={{
        request: (request) => {
          setFormError(null);
          setOpened({ id: nextOpened++, request });
        },
        pending,
        writes,
      }}
    >
      {children}
      <dialog
        ref={dialogRef}
        aria-labelledby="operation-title"
        onClose={() => {
          setOpened(null);
          setPanel(null);
        }}
        className="m-auto max-h-[calc(100dvh-1.5rem)] w-[min(32rem,calc(100vw-1.5rem))] overflow-y-auto rounded-md border border-line-strong bg-raised p-0 shadow-2xl shadow-black/40"
      >
        {panel && panelUi && (
          <div className="flex flex-col gap-4 p-5">
            <div className="flex items-center justify-between gap-3">
              <h2 id="operation-title" className="text-lg font-semibold">
                {panelUi.label} <span className="font-mono">{panel.app}</span>
              </h2>
              <span
                role="status"
                className={`flex items-center gap-1.5 text-sm font-medium ${
                  running ? "text-dim" : failed ? "text-crit" : "text-ok"
                }`}
              >
                {running ? (
                  <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                ) : failed ? (
                  <CircleX className="size-4" aria-hidden="true" />
                ) : (
                  <CircleCheck className="size-4" aria-hidden="true" />
                )}
                {running ? "Running" : failed ? "Failed" : "Done"}
              </span>
            </div>
            <pre
              ref={outputRef}
              className="h-72 overflow-auto rounded-sm border border-line bg-sunken px-3 py-2.5 font-mono text-xs leading-5 whitespace-pre-wrap break-words"
            >
              {lines.length > 0 ? lines.join("\n") : "Waiting for output..."}
            </pre>
            {failed && <p className="text-pretty text-crit">{failed}</p>}
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-faint">
                {running ? "Closing this does not stop the operation." : ""}
              </p>
              <button
                type="button"
                onClick={() => setPanel(null)}
                className={secondaryButton}
              >
                Close
              </button>
            </div>
          </div>
        )}
        {!panel && opened && (
          <OperationForm
            key={opened.id}
            initial={opened.request}
            writes={writes}
            running={running}
            error={formError}
            onSubmit={confirm}
            onCancel={() => setOpened(null)}
          />
        )}
      </dialog>
    </OperationContext>
  );
}

/** The confirm dialog's form: the operation's fields, the exact command, Cancel and the button. */
function OperationForm({
  initial,
  writes,
  running,
  error,
  onSubmit,
  onCancel,
}: {
  initial: OperationRequest;
  writes: Writes;
  running: boolean;
  error: string | null;
  onSubmit: (request: OperationRequest) => void;
  onCancel: () => void;
}) {
  const [current, setCurrent] = useState(initial);
  // Complaints about fields wait for the first edit.
  const [touched, setTouched] = useState(false);
  const { data: apps = [] } = useQuery(appsQuery);
  const ui = operationUi[current.op];

  // The same parse the server runs, so the form and the route cannot disagree.
  const parsed = parseOperation(current.op, current);
  const valid = typeof parsed === "string" ? null : parsed;
  const conflict = valid ? conflictProblem(valid, apps) : null;
  const typedName = destructiveConfirm(current);
  const unconfirmed = typedName !== undefined && typedName.typed !== typedName.expected;
  const problem = typeof parsed === "string" ? parsed : conflict;
  const ready = valid !== null && conflict === null && !unconfirmed;

  const change = (next: OperationRequest) => {
    setCurrent(next);
    setTouched(true);
  };

  return (
    <form
      method="dialog"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && ready) onSubmit(valid);
      }}
      className="flex flex-col gap-4 p-5"
    >
      <div className="flex flex-col gap-1.5">
        <h2 id="operation-title" className="text-lg font-semibold">
          <WithApp text={ui.title} app={current.app} />
        </h2>
        <p className="text-pretty text-dim">{ui.effect}</p>
      </div>

      <Fields request={current} initial={initial} onChange={change} />

      {touched && problem && (
        <p role="alert" className="text-pretty text-sm text-crit">
          {problem}
        </p>
      )}

      <div>
        <p className="label mb-1.5">Runs on the host</p>
        <pre className="overflow-x-auto rounded-sm border border-line bg-sunken px-3 py-2.5 font-mono text-[13px]">
          {valid ? (
            commandLine(valid)
              .split("\n")
              .map((line) => (
                <Fragment key={line}>
                  <span className="select-none text-faint">$ </span>
                  {line}
                  {"\n"}
                </Fragment>
              ))
          ) : (
            <span className="text-faint">Fill in the fields to see the command.</span>
          )}
        </pre>
      </div>

      {dataSource === "mock" && (
        <p className="text-xs text-faint">
          Mock only. Confirming shows a toast; no command is sent.
        </p>
      )}
      {error && (
        <p role="alert" className="text-pretty text-crit">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={secondaryButton}>
          Cancel
        </button>
        <button
          type="submit"
          disabled={running || !writes.enabled || !ready}
          title={writes.enabled ? undefined : writes.reason}
          className={`h-9 min-w-24 rounded-sm px-3.5 font-semibold disabled:opacity-60 ${
            ui.tone === "danger" ? "bg-crit text-bg" : "bg-accent text-accent-fg"
          }`}
        >
          {running ? ui.pending : ui.label}
        </button>
      </div>
    </form>
  );
}

/** The inputs an operation needs beyond the app it targets, if any. */
function Fields({
  request,
  initial,
  onChange,
}: {
  request: OperationRequest;
  initial: OperationRequest;
  onChange: (request: OperationRequest) => void;
}) {
  switch (request.op) {
    case "apps:create":
      return (
        <TextField
          label="App name"
          value={request.app}
          placeholder="my-app"
          hint="Lowercase letters, digits, dots and hyphens."
          onChange={(app) => onChange({ ...request, app })}
        />
      );
    case "apps:destroy":
      return (
        <TextField
          label={`Type ${request.app} to confirm`}
          value={request.confirm}
          placeholder={request.app}
          onChange={(confirm) => onChange({ ...request, confirm })}
        />
      );
    case "domains:add":
    case "domains:set":
      return (
        <StringList
          label="Domains"
          values={request.domains}
          placeholder="app.example.com"
          invalid={(value) => value !== "" && !isDomain(value)}
          onChange={(domains) => onChange({ ...request, domains })}
        />
      );
    case "ports:add":
    case "ports:set":
      return (
        <MappingList
          mappings={request.mappings}
          onChange={(mappings) => onChange({ ...request, mappings })}
        />
      );
    case "proxy:enable": {
      const previous = initial.op === "proxy:enable" ? initial.ports : undefined;
      if (!previous) return null;
      return (
        <label className="flex items-start gap-2.5">
          <input
            type="checkbox"
            checked={request.ports !== undefined}
            onChange={(e) =>
              onChange({ ...request, ports: e.target.checked ? previous : undefined })
            }
            className="mt-1 size-4 accent-accent"
          />
          <span className="text-pretty">
            Restore the port map the app had before the proxy was disabled:{" "}
            <span className="font-mono text-[13px]">
              {previous
                .map(({ scheme, host, container }) => `${scheme}:${host}:${container}`)
                .join(" ")}
            </span>
          </span>
        </label>
      );
    }
    case "ps:start":
    case "ps:stop":
    case "ps:restart":
    case "ps:rebuild":
    case "domains:remove":
    case "ports:remove":
    case "proxy:disable":
      return null;
  }
}

function TextField({
  label,
  value,
  placeholder,
  hint,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  hint?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="label">{label}</span>
      <input
        // biome-ignore lint/a11y/noAutofocus: the dialog exists to fill this field
        autoFocus
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        className={inputClass}
      />
      {hint && <span className="text-xs text-faint">{hint}</span>}
    </label>
  );
}

const rowButton =
  "grid size-9 shrink-0 place-items-center rounded-sm border border-line-strong text-dim hover:bg-sunken hover:text-fg disabled:opacity-45";

/** Rows of one text input each, with remove buttons and an "Add another". */
function StringList({
  label,
  values,
  placeholder,
  invalid,
  onChange,
}: {
  label: string;
  values: string[];
  placeholder: string;
  invalid: (value: string) => boolean;
  onChange: (values: string[]) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="label mb-1.5">{label}</legend>
      {values.map((value, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity beyond their position
        <div key={i} className="flex gap-2">
          <input
            // biome-ignore lint/a11y/noAutofocus: the dialog exists to fill the first row
            autoFocus={i === 0}
            aria-label={`${label} ${i + 1}`}
            aria-invalid={invalid(value)}
            value={value}
            placeholder={placeholder}
            onChange={(e) =>
              onChange(values.map((v, j) => (j === i ? e.target.value : v)))
            }
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            className={`${inputClass} aria-invalid:border-crit`}
          />
          <button
            type="button"
            aria-label={`Remove row ${i + 1}`}
            disabled={values.length === 1}
            onClick={() => onChange(values.filter((_, j) => j !== i))}
            className={rowButton}
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...values, ""])}
        className="flex h-8 items-center gap-1.5 self-start text-sm font-medium text-accent hover:underline"
      >
        <Plus className="size-3.5" aria-hidden="true" />
        Add another
      </button>
    </fieldset>
  );
}

const portInput = `${inputClass} tabular`;

/** The number in a port field; an empty field is NaN, which no port grammar accepts. */
const portValue = (text: string) => (text === "" ? Number.NaN : Number(text));

/** Rows of `scheme host container`, with remove buttons, an "Add another" and the https warning. */
function MappingList({
  mappings,
  onChange,
}: {
  mappings: PortMapping[];
  onChange: (mappings: PortMapping[]) => void;
}) {
  const edit = (i: number, patch: Partial<PortMapping>) =>
    onChange(mappings.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="label mb-1.5">Port mappings</legend>
      <div className="grid grid-cols-[5.5rem_1fr_1fr_2.25rem] gap-2 text-xs text-faint">
        <span>Scheme</span>
        <span>Host port</span>
        <span>Container port</span>
        <span />
      </div>
      {mappings.map((m, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity beyond their position
        <div key={i} className="grid grid-cols-[5.5rem_1fr_1fr_2.25rem] gap-2">
          <select
            aria-label={`Scheme ${i + 1}`}
            value={m.scheme}
            onChange={(e) => edit(i, { scheme: e.target.value })}
            className={inputClass}
          >
            {portSchemes.map((scheme) => (
              <option key={scheme}>{scheme}</option>
            ))}
          </select>
          <input
            type="number"
            min={1}
            max={65535}
            aria-label={`Host port ${i + 1}`}
            value={Number.isNaN(m.host) ? "" : m.host}
            onChange={(e) => edit(i, { host: portValue(e.target.value) })}
            className={portInput}
          />
          <input
            type="number"
            min={1}
            max={65535}
            aria-label={`Container port ${i + 1}`}
            value={Number.isNaN(m.container) ? "" : m.container}
            onChange={(e) => edit(i, { container: portValue(e.target.value) })}
            className={portInput}
          />
          <button
            type="button"
            aria-label={`Remove row ${i + 1}`}
            disabled={mappings.length === 1}
            onClick={() => onChange(mappings.filter((_, j) => j !== i))}
            className={rowButton}
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() =>
          onChange([...mappings, { scheme: "http", host: 80, container: 5000 }])
        }
        className="flex h-8 items-center gap-1.5 self-start text-sm font-medium text-accent hover:underline"
      >
        <Plus className="size-3.5" aria-hidden="true" />
        Add another
      </button>
      {mappings.some((m) => m.scheme === "https") && (
        <p className="text-pretty text-xs text-warn">
          No TLS on this host: Cloudflare terminates it, and Dokku ignores an https
          mapping without a certificate.
        </p>
      )}
    </fieldset>
  );
}
