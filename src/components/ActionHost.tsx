import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, CircleX, LoaderCircle } from "lucide-react";
import { createContext, type ReactNode, use, useEffect, useRef, useState } from "react";
import { appActions as actionTable, commandLine } from "../../shared/actions";
import { type AppActionId, appActions } from "../api/actions";
import { backendHealthQuery, describeError } from "../api/backend";
import { dataSource, runAction } from "../api/client";
import { appsQuery } from "../api/queries";
import { useToast } from "./Toast";

type Request = { action: AppActionId; app: string };

/** Whether the server accepts actions; `reason` is what a disabled control says. */
export type Writes = { enabled: true } | { enabled: false; reason: string };

type ActionContextValue = {
  request: (request: Request) => void;
  /** The action in flight (the server runs one at a time from this tab), if any. */
  pending: Request | null;
  writes: Writes;
};

const ActionContext = createContext<ActionContextValue | null>(null);

function useActionContext() {
  const context = use(ActionContext);
  if (!context) throw new Error("Action hooks must be used inside ActionHost");
  return context;
}

/** Opens the confirm dialog for any app action, from buttons or the command palette alike. */
export const useRequestAction = () => useActionContext().request;

/** The action currently running, for pending states on buttons. */
export const usePendingAction = () => useActionContext().pending;

/** Whether actions can run: the mock never refuses, the real server says in its health. */
export const useWrites = () => useActionContext().writes;

/** Owns the single dialog: confirm, then (for a rebuild) a progress panel with its output. */
export function ActionHost({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<Request | null>(null);
  // The rebuild whose panel is open. Closing the panel only hides it; the run goes on.
  const [panel, setPanel] = useState<Request | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const notify = useToast();
  const queryClient = useQueryClient();
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
    mutationFn: ({ action, app }: Request) =>
      runAction(action, app, (line) => setLines((all) => [...all, line])),
    onSuccess: ({ detail }, { action, app }) => {
      setRequest(null);
      notify(
        dataSource === "mock"
          ? { message: "mock: would run", detail }
          : { message: `${appActions[action].done} ${app}.`, detail },
      );
    },
    onError: (error, { action, app }) => {
      setRequest(null);
      notify({
        message: `${appActions[action].label} ${app} failed: ${describeError(error).message}`,
        tone: "error",
      });
    },
    // Show the new state now instead of at the next poll.
    onSettled: () => {
      if (dataSource === "mock") return;
      void queryClient.invalidateQueries({ queryKey: appsQuery.queryKey });
      void queryClient.invalidateQueries({ queryKey: backendHealthQuery.queryKey });
    },
  });
  const pending = mutation.isPending ? mutation.variables : null;

  const confirm = (confirmed: Request) => {
    setLines([]);
    mutation.mutate(confirmed);
    if (dataSource === "api" && actionTable[confirmed.action].streams) {
      setRequest(null);
      setPanel(confirmed);
    }
  };

  const dialogOpen = request !== null || panel !== null;
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

  const shown = panel ?? request;
  const def = shown ? appActions[shown.action] : null;
  const danger = def?.tone === "danger";
  // The panel belongs to the latest run; a newer run replaces what it shows.
  const running = pending !== null;
  const failed = mutation.isError ? describeError(mutation.error).message : null;

  return (
    <ActionContext value={{ request: setRequest, pending, writes }}>
      {children}
      <dialog
        ref={dialogRef}
        aria-labelledby="action-title"
        onClose={() => {
          setRequest(null);
          setPanel(null);
        }}
        className="m-auto w-[min(32rem,calc(100vw-1.5rem))] rounded-md border border-line-strong bg-raised p-0 shadow-2xl shadow-black/40"
      >
        {panel && def && (
          <div className="flex flex-col gap-4 p-5">
            <div className="flex items-center justify-between gap-3">
              <h2 id="action-title" className="text-lg font-semibold">
                {def.label} <span className="font-mono">{panel.app}</span>
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
                {running ? "Closing this does not stop the rebuild." : ""}
              </p>
              <button
                type="button"
                onClick={() => setPanel(null)}
                className="h-9 rounded-sm border border-line-strong px-3.5 font-medium hover:bg-sunken"
              >
                Close
              </button>
            </div>
          </div>
        )}
        {!panel && request && def && (
          <form
            method="dialog"
            onSubmit={(e) => {
              e.preventDefault();
              confirm(request);
            }}
            className="flex flex-col gap-4 p-5"
          >
            <div className="flex flex-col gap-1.5">
              <h2 id="action-title" className="text-lg font-semibold">
                {def.label} <span className="font-mono">{request.app}</span>?
              </h2>
              <p className="text-pretty text-dim">{def.effect}</p>
            </div>

            <div>
              <p className="label mb-1.5">Runs on the host</p>
              <pre className="overflow-x-auto rounded-sm border border-line bg-sunken px-3 py-2.5 font-mono text-[13px]">
                <span className="select-none text-faint">$ </span>
                {commandLine(request.action, request.app)}
              </pre>
            </div>

            {dataSource === "mock" && (
              <p className="text-xs text-faint">
                Mock only. Confirming shows a toast; no command is sent.
              </p>
            )}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRequest(null)}
                className="h-9 rounded-sm border border-line-strong px-3.5 font-medium hover:bg-sunken"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={running || !writes.enabled}
                title={writes.enabled ? undefined : writes.reason}
                className={`h-9 min-w-24 rounded-sm px-3.5 font-semibold disabled:opacity-60 ${
                  danger ? "bg-crit text-bg" : "bg-accent text-accent-fg"
                }`}
              >
                {running ? def.pending : def.label}
              </button>
            </div>
          </form>
        )}
      </dialog>
    </ActionContext>
  );
}
