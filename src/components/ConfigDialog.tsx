import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  configCommandLine,
  configValueProblem,
  isConfigKey,
  isManagedKey,
} from "../../shared/config";
import { describeError } from "../api/backend";
import { type AppView, setConfigVar, unsetConfigVar } from "../api/client";
import { appQuery, configQuery } from "../api/queries";
import { useToast } from "./Toast";

/** What the dialog is for; `null` keeps it closed. */
export type ConfigDialogState =
  | { kind: "add" }
  | { kind: "edit"; key: string; value: string }
  | { kind: "unset"; key: string };

const inputClass =
  "h-9 w-full rounded-sm border border-line-strong bg-sunken px-2.5 font-mono text-[13px] focus:outline-2 focus:outline-accent";

/** Add, edit and unset share one modal: a form, the exact command (value masked) and the restart toggle. */
export function ConfigDialog({
  app,
  state,
  existingKeys,
  onClose,
  onSaved,
}: {
  app: AppView;
  state: ConfigDialogState | null;
  existingKeys: readonly string[];
  onClose: () => void;
  /** Called after a successful write, so the list can drop any revealed values. */
  onSaved: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const open = state !== null;
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="config-title"
      onClose={onClose}
      className="m-auto w-[min(32rem,calc(100vw-1.5rem))] rounded-md border border-line-strong bg-raised p-0 shadow-2xl shadow-black/40"
    >
      {/* Remounted per open, so every field starts from the request. */}
      {state && (
        <ConfigForm
          key={state.kind === "add" ? "add" : `${state.kind}:${state.key}`}
          app={app}
          state={state}
          existingKeys={existingKeys}
          onClose={onClose}
          onSaved={onSaved}
        />
      )}
    </dialog>
  );
}

function ConfigForm({
  app,
  state,
  existingKeys,
  onClose,
  onSaved,
}: {
  app: AppView;
  state: ConfigDialogState;
  existingKeys: readonly string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [key, setKey] = useState(state.kind === "add" ? "" : state.key);
  const [value, setValue] = useState(state.kind === "edit" ? state.value : "");
  const [restart, setRestart] = useState(false);
  const notify = useToast();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () =>
      state.kind === "unset"
        ? unsetConfigVar(app, key, restart)
        : setConfigVar(app, key, value, restart),
    onSuccess: () => {
      const verb = state.kind === "unset" ? "Unset" : "Set";
      const running = app.status.kind === "running" || app.status.kind === "crashed";
      const outcome = !restart
        ? "The app was not restarted."
        : running
          ? "The app was restarted."
          : "The app is not running, so nothing restarted.";
      notify({ message: `${verb} ${key} on ${app.name}. ${outcome}` });
      onSaved();
      onClose();
    },
    // Failures stay in the dialog, next to the form that caused them.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: configQuery(app).queryKey });
      void queryClient.invalidateQueries({ queryKey: appQuery(app.name).queryKey });
    },
  });

  const keyProblem =
    state.kind !== "add" || key === ""
      ? null
      : !isConfigKey(key)
        ? "Use letters, digits and underscores, not starting with a digit."
        : isManagedKey(key)
          ? "Managed by Dokku; it cannot be changed here."
          : existingKeys.includes(key)
            ? "Already set. Reveal it in the list and edit it instead."
            : null;
  const valueProblem = state.kind === "unset" ? null : configValueProblem(value);
  const ready =
    !mutation.isPending && key !== "" && keyProblem === null && valueProblem === null;

  const title = { add: "Add variable", edit: "Edit", unset: "Unset" }[state.kind];
  const submit = { add: "Add", edit: "Save", unset: "Unset" }[state.kind];
  const pending = state.kind === "unset" ? "Unsetting..." : "Saving...";

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (ready) mutation.mutate();
  };

  return (
    <form method="dialog" onSubmit={onSubmit} className="flex flex-col gap-4 p-5">
      <div className="flex flex-col gap-1.5">
        <h2 id="config-title" className="text-lg font-semibold">
          {title}
          {state.kind !== "add" && <span className="font-mono"> {state.key}</span>}
          {state.kind === "unset" && "?"}
        </h2>
        {state.kind === "unset" && (
          <p className="text-pretty text-dim">
            Removes the variable from {app.name}. The app keeps running with its old
            environment until it next restarts.
          </p>
        )}
      </div>

      {state.kind === "add" && (
        <label className="flex flex-col gap-1.5">
          <span className="label">Name</span>
          <input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder="DATABASE_URL"
            aria-invalid={keyProblem !== null}
            className={inputClass}
          />
          {keyProblem && <span className="text-xs text-crit">{keyProblem}</span>}
        </label>
      )}

      {state.kind !== "unset" && (
        <label className="flex flex-col gap-1.5">
          <span className="label">Value</span>
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={valueProblem !== null}
            className={inputClass}
          />
          {valueProblem && <span className="text-xs text-crit">{valueProblem}</span>}
        </label>
      )}

      <label className="flex items-start gap-2.5">
        <input
          type="checkbox"
          checked={restart}
          onChange={(e) => setRestart(e.target.checked)}
          className="mt-1 size-4 accent-accent"
        />
        <span className="text-pretty">
          Restart the app now
          <span className="block text-xs text-dim">
            Off: the app restarts only on its next restart or deploy. On: Dokku redeploys
            it, which takes about 25 seconds.
          </span>
        </span>
      </label>

      <div>
        <p className="label mb-1.5">Runs on the host</p>
        <pre className="overflow-x-auto rounded-sm border border-line bg-sunken px-3 py-2.5 font-mono text-[13px]">
          <span className="select-none text-faint">$ </span>
          {configCommandLine({
            kind: state.kind === "unset" ? "unset" : "set",
            app: app.name,
            key: key || "KEY",
            restart,
          })}
        </pre>
      </div>

      {mutation.isError && (
        <p role="alert" className="text-pretty text-crit">
          {describeError(mutation.error).message}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="h-9 rounded-sm border border-line-strong px-3.5 font-medium hover:bg-sunken"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!ready}
          className={`h-9 min-w-24 rounded-sm px-3.5 font-semibold disabled:opacity-60 ${
            state.kind === "unset" ? "bg-crit text-bg" : "bg-accent text-accent-fg"
          }`}
        >
          {mutation.isPending ? pending : submit}
        </button>
      </div>
    </form>
  );
}
