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
import {
  builderNames,
  formatPortMapping,
  isDomain,
  portSchemes,
} from "../../shared/grammar";
import {
  commandLine,
  destructiveConfirm,
  type OperationRequest,
  parseOperation,
  targetOf,
} from "../../shared/operations";
import type { PortMapping } from "../../shared/types";
import { backendHealthQuery, describeError } from "../api/backend";
import { dataSource, runOperation } from "../api/client";
import {
  conflictProblem,
  forTarget,
  operationUi,
  psOperationIds,
} from "../api/operations";
import { appsQuery, networksQuery, storageUsersQuery } from "../api/queries";
import {
  Checkbox,
  FormationList,
  inputClass,
  NetworkPicker,
  RebuildToggle,
  rowButton,
  SelectField,
  SharedStorageWarning,
  TextField,
} from "./FormControls";
import { useToast } from "./Toast";

/** Whether the server accepts operations; `reason` is what a disabled control says. */
export type Writes = { enabled: true } | { enabled: false; reason: string };

type OperationContextValue = {
  /** Opens the dialog for `request`, whose form fields start from its values; `note` is shown in it. */
  request: (request: OperationRequest, note?: string) => void;
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

const secondaryButton =
  "h-9 rounded-sm border border-line-strong px-3.5 font-medium hover:bg-sunken";

/** A wording with its `{target}` set in monospace. */
function WithTarget({ text, target }: { text: string; target: string }) {
  const [before = "", ...after] = text.split("{target}");
  return (
    <>
      {before}
      {after.length > 0 && (
        <>
          <span className="font-mono">{target}</span>
          {after.join("{target}")}
        </>
      )}
    </>
  );
}

/** A request that would change nothing, which only a form that opened with the current values can tell. */
function unchangedProblem(initial: OperationRequest, request: OperationRequest) {
  if (initial.op !== "ps:scale" || request.op !== "ps:scale") return null;
  const same =
    initial.formation.length === request.formation.length &&
    initial.formation.every(
      (e, i) =>
        e.type === request.formation[i]?.type && e.count === request.formation[i]?.count,
    );
  return same ? "The formation is unchanged." : null;
}

/** Whether any text field in the request is still blank (a form that has not been filled in). */
const hasEmptyField = (value: unknown): boolean =>
  value === ""
    ? true
    : Array.isArray(value)
      ? value.some(hasEmptyField)
      : typeof value === "object" && value !== null
        ? Object.values(value).some(hasEmptyField)
        : false;

type Opened = { id: number; request: OperationRequest; note?: string };
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
      runOperation(
        req,
        (line) => setLines((all) => [...all, line]),
        // The form stays open until the server says it streams, so a refusal shows there.
        () => {
          setOpened(null);
          setPanel(req);
        },
      ),
    onSuccess: ({ detail }, req) => {
      setOpened(null);
      notify(
        dataSource === "mock"
          ? { message: "mock: would run", detail }
          : { message: forTarget(operationUi[req.op].done, targetOf(req)), detail },
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
          message: `${operationUi[req.op].label} ${targetOf(req)} failed: ${message}`,
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
      void queryClient.invalidateQueries({ queryKey: storageUsersQuery.queryKey });
      void queryClient.invalidateQueries({ queryKey: backendHealthQuery.queryKey });
      void queryClient.invalidateQueries({ queryKey: ["activity"] });
    },
  });
  const pending = mutation.isPending ? mutation.variables : null;

  const confirm = (confirmed: OperationRequest) => {
    setLines([]);
    setFormError(null);
    mutation.mutate(confirmed);
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
        request: (request, note) => {
          setFormError(null);
          setOpened({ id: nextOpened++, request, note });
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
                {panelUi.label} <span className="font-mono">{targetOf(panel)}</span>
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
            note={opened.note}
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
  note,
  writes,
  running,
  error,
  onSubmit,
  onCancel,
}: {
  initial: OperationRequest;
  note?: string;
  writes: Writes;
  running: boolean;
  error: string | null;
  onSubmit: (request: OperationRequest) => void;
  onCancel: () => void;
}) {
  const [current, setCurrent] = useState(initial);
  // A form that opens blank does not complain until it is edited.
  const [touched, setTouched] = useState(false);
  const { data: apps = [] } = useQuery(appsQuery);
  const ui = operationUi[current.op];

  // The same parse the server runs, so the form and the route cannot disagree.
  const parsed = parseOperation(current.op, current);
  const valid = typeof parsed === "string" ? null : parsed;
  const conflict = valid ? conflictProblem(valid, apps) : null;
  const typedName = destructiveConfirm(current);
  const unconfirmed = typedName !== undefined && typedName.typed !== typedName.expected;
  const unchanged = valid ? unchangedProblem(initial, valid) : null;
  const problem = typeof parsed === "string" ? parsed : (conflict ?? unchanged);
  const ready = valid !== null && problem === null && !unconfirmed;

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
          <WithTarget text={ui.title} target={targetOf(current)} />
        </h2>
        <p className="text-pretty text-dim">{ui.effect}</p>
      </div>

      <Fields request={current} initial={initial} onChange={change} />

      {note && <p className="text-pretty text-sm text-dim">{note}</p>}

      {problem && (touched || !hasEmptyField(initial)) && (
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
      const saved = initial.op === "proxy:enable" ? initial : undefined;
      if (!saved?.ports && !saved?.domains) return null;
      const restoring = request.ports !== undefined || request.domains !== undefined;
      return (
        <label className="flex items-start gap-2.5">
          <input
            type="checkbox"
            checked={restoring}
            onChange={(e) =>
              onChange({
                ...request,
                ports: e.target.checked ? saved.ports : undefined,
                domains: e.target.checked ? saved.domains : undefined,
              })
            }
            className="mt-1 size-4 accent-accent"
          />
          <span className="text-pretty">
            Restore what the app had before the proxy was disabled:
            {saved.ports && (
              <>
                {" "}
                ports{" "}
                <span className="font-mono text-[13px]">
                  {saved.ports.map(formatPortMapping).join(" ")}
                </span>
              </>
            )}
            {saved.ports && saved.domains && ","}
            {saved.domains && (
              <>
                {" "}
                domains{" "}
                <span className="font-mono text-[13px]">{saved.domains.join(" ")}</span>
              </>
            )}
          </span>
        </label>
      );
    }
    case "ps:scale": {
      const locked = initial.op === "ps:scale" ? initial.formation.length : 0;
      return (
        <>
          <FormationList
            formation={request.formation}
            locked={locked}
            onChange={(formation) => onChange({ ...request, formation })}
          />
          <Checkbox
            checked={request.skipDeploy}
            onChange={(skipDeploy) => onChange({ ...request, skipDeploy })}
          >
            Skip the deploy. Only the formation is saved; containers keep running as they
            are until the next deploy, restart or rebuild, and scaling to the same numbers
            later does nothing.
          </Checkbox>
        </>
      );
    }
    case "network:create":
      return (
        <TextField
          label="Network name"
          value={request.network}
          placeholder="my-net"
          hint="Lowercase letters, digits, dots, underscores and hyphens."
          onChange={(network) => onChange({ ...request, network })}
        />
      );
    case "network:destroy":
      return (
        <TextField
          label={`Type ${request.network} to confirm`}
          value={request.confirm}
          placeholder={request.network}
          onChange={(confirm) => onChange({ ...request, confirm })}
        />
      );
    case "network:set":
      return (
        <>
          <NetworkPicker
            property={request.property}
            selected={request.networks}
            onChange={(networks) => onChange({ ...request, networks })}
          />
          <RebuildToggle
            app={request.app}
            checked={request.rebuild}
            onChange={(rebuild) => onChange({ ...request, rebuild })}
          />
        </>
      );
    case "network:alias-add":
      return (
        <>
          <TextField
            label="Alias"
            value={request.alias}
            placeholder="api"
            hint="One lowercase DNS label. It applies to every network the app joins."
            onChange={(alias) => onChange({ ...request, alias })}
          />
          <RebuildToggle
            app={request.app}
            checked={request.rebuild}
            onChange={(rebuild) => onChange({ ...request, rebuild })}
          />
        </>
      );
    case "network:alias-remove":
      return (
        <RebuildToggle
          app={request.app}
          checked={request.rebuild}
          onChange={(rebuild) => onChange({ ...request, rebuild })}
        />
      );
    case "git:from-image":
      return (
        <TextField
          label="Image"
          value={request.image}
          placeholder="nginx:alpine"
          hint="A public image: registry/path:tag or @sha256:digest, in lowercase."
          onChange={(image) => onChange({ ...request, image })}
        />
      );
    case "git:sync":
      return (
        <>
          <TextField
            label="Repository"
            value={request.url}
            placeholder="https://github.com/owner/repo"
            hint="An https:// URL or git@host:path, fetched by the Dokku host with its own network and keys. No credentials in the URL."
            onChange={(url) => onChange({ ...request, url })}
          />
          <TextField
            label="Branch, tag or commit (optional)"
            value={request.ref}
            placeholder="the repository's default branch"
            focus={false}
            onChange={(ref) => onChange({ ...request, ref })}
          />
          <Checkbox
            checked={request.build}
            onChange={(build) => onChange({ ...request, build })}
          >
            Build and deploy now. Without it the source is only fetched: the running
            containers stay as they are until the next build or rebuild.
          </Checkbox>
        </>
      );
    case "git:set":
      return (
        <TextField
          label="Deploy branch"
          value={request.branch}
          placeholder="main"
          hint="Empty goes back to Dokku's default."
          onChange={(branch) => onChange({ ...request, branch })}
        />
      );
    case "builder:set":
      return request.property === "selected" ? (
        <SelectField
          label="Builder"
          value={request.value}
          hint="Empty lets Dokku detect the builder from the repository."
          options={[
            { value: "", label: "Detect automatically" },
            // A stored value outside the list (set from the CLI) stays selectable.
            ...[...new Set([...builderNames, request.value])]
              .filter((name) => name !== "")
              .map((name) => ({ value: name, label: name })),
          ]}
          onChange={(value) => onChange({ ...request, value })}
        />
      ) : (
        <TextField
          label={request.property === "build-dir" ? "Build directory" : "Dockerfile path"}
          value={request.value}
          placeholder={request.property === "build-dir" ? "backend" : "docker/Dockerfile"}
          hint="Relative to the repository root. Empty clears it."
          onChange={(value) => onChange({ ...request, value })}
        />
      );
    case "resource:set":
      return (
        <>
          <p className="text-sm text-dim">
            {request.kind === "limit" ? "Limit" : "Reservation"} for{" "}
            <span className="font-mono">
              {request.processType ?? "all process types"}
            </span>
          </p>
          <TextField
            label="Memory"
            value={request.memory}
            placeholder="256m"
            hint="A number with an optional unit b, k, m or g; a bare number is megabytes."
            onChange={(memory) => onChange({ ...request, memory })}
          />
          <TextField
            label="CPUs"
            value={request.cpu}
            placeholder="0.5"
            focus={false}
            hint="Up to two decimals."
            onChange={(cpu) => onChange({ ...request, cpu })}
          />
        </>
      );
    case "resource:clear":
      return (
        <p className="text-pretty text-sm text-dim">
          {request.processType === null ? (
            <>
              Clears only the {request.kind === "limit" ? "limit" : "reservation"} that
              applies to all process types. Settings made for individual process types
              stay.
            </>
          ) : (
            <>
              Clears only the {request.kind === "limit" ? "limit" : "reservation"} of{" "}
              <span className="font-mono">{request.processType}</span>. Other process
              types and the all-types setting stay.
            </>
          )}
        </p>
      );
    case "storage:mount":
      return (
        <>
          <TextField
            label="Directory name"
            value={request.name}
            placeholder="my-data"
            hint="Lives at /var/lib/dokku/data/storage/<name> on the host; created if missing."
            onChange={(name) => onChange({ ...request, name })}
          />
          <TextField
            label="Path in the container"
            value={request.containerPath}
            placeholder="/data"
            focus={false}
            hint="Absolute, such as /data."
            onChange={(containerPath) => onChange({ ...request, containerPath })}
          />
          <SharedStorageWarning app={request.app} name={request.name} />
        </>
      );
    case "storage:unmount":
      return (
        <TextField
          label={`Type ${request.containerPath} to confirm`}
          value={request.confirm}
          placeholder={request.containerPath}
          onChange={(confirm) => onChange({ ...request, confirm })}
        />
      );
    case "ps:start":
    case "ps:stop":
    case "ps:restart":
    case "ps:rebuild":
    case "domains:remove":
    case "ports:remove":
    case "proxy:disable":
    case "apps:unlock":
      return null;
  }
}

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
