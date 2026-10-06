import { useMutation, useQuery } from "@tanstack/react-query";
import { Eye, EyeOff, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { ConfigKey } from "../../../shared/config";
import { describeError } from "../../api/backend";
import { type AppView, dataSource, getConfigValue } from "../../api/client";
import { configQuery } from "../../api/queries";
import { ConfigDialog, type ConfigDialogState } from "../../components/ConfigDialog";
import { CopyButton, iconButton } from "../../components/CopyButton";
import { useWrites, type Writes } from "../../components/OperationHost";
import { EmptyNote, ErrorNote, Panel, Skeleton } from "../../components/ui";

const stubTitle = "Stub: editing is not wired up in this preview";

/** Mock mode only: the write controls the preview never wired up. */
function StubButton({ icon, label }: { icon: "edit" | "add"; label: string }) {
  return (
    <button
      type="button"
      disabled
      title={stubTitle}
      className="flex h-8 items-center gap-1.5 rounded-sm border border-dashed border-line-strong px-2.5 text-xs font-medium text-faint disabled:cursor-not-allowed"
    >
      {icon === "edit" ? (
        <Pencil className="size-3" aria-hidden="true" />
      ) : (
        <Plus className="size-3" aria-hidden="true" />
      )}
      {label}
      <span className="rounded-sm bg-sunken px-1 text-[10px] uppercase tracking-wider">
        stub
      </span>
    </button>
  );
}

const textButton =
  "flex h-8 items-center gap-1.5 rounded-sm border border-line-strong px-2.5 text-xs font-medium hover:bg-raised disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent";

/**
 * One variable. Its value is fetched when Reveal is pressed and lives only in this row's
 * mutation state, so Hide (or leaving the tab) discards it; nothing is prefetched or cached.
 */
function ConfigRow({
  app,
  entry,
  writes,
  onEdit,
  onUnset,
}: {
  app: AppView;
  entry: ConfigKey;
  writes: Writes;
  onEdit: (key: string, value: string) => void;
  onUnset: (key: string) => void;
}) {
  const { key, managed } = entry;
  const reveal = useMutation({ mutationFn: () => getConfigValue(app, key) });
  const value = reveal.data;
  const revealed = value !== undefined;
  const writeReason = writes.enabled ? undefined : writes.reason;

  return (
    <li className="grid items-center gap-x-4 gap-y-1 px-4 py-2.5 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto]">
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate font-mono font-medium">{key}</span>
        {managed && (
          <span
            title="Written by Dokku; not editable here"
            className="shrink-0 rounded-sm bg-sunken px-1 text-[10px] uppercase tracking-wider text-dim"
          >
            managed
          </span>
        )}
      </span>
      <span
        className={`min-w-0 break-all font-mono text-[13px] ${revealed ? "" : "tracking-widest text-faint"}`}
      >
        {revealed ? value || <span className="text-faint">(empty)</span> : "••••••••••••"}
        {reveal.isError && (
          <span role="alert" className="ml-2 tracking-normal text-crit">
            {describeError(reveal.error).message}
          </span>
        )}
      </span>
      <div className="flex items-center gap-2">
        {revealed && <CopyButton name={key} value={value} />}
        <button
          type="button"
          onClick={() => (revealed ? reveal.reset() : reveal.mutate())}
          disabled={reveal.isPending}
          aria-pressed={revealed}
          aria-label={`${revealed ? "Hide" : "Reveal"} ${key}`}
          title={revealed ? "Hide value" : "Reveal value"}
          className={iconButton}
        >
          {revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
        </button>
        {dataSource === "mock" ? (
          <StubButton icon="edit" label="Edit" />
        ) : (
          !managed && (
            <>
              <button
                type="button"
                onClick={() => revealed && onEdit(key, value)}
                disabled={!revealed || !writes.enabled}
                title={
                  writeReason ?? (revealed ? undefined : "Reveal the value to edit it")
                }
                className={textButton}
              >
                <Pencil className="size-3" aria-hidden="true" />
                Edit
              </button>
              <button
                type="button"
                onClick={() => onUnset(key)}
                disabled={!writes.enabled}
                title={writeReason}
                aria-label={`Unset ${key}`}
                className={`${iconButton} hover:text-crit`}
              >
                <Trash2 className="size-3.5" />
              </button>
            </>
          )
        )}
      </div>
    </li>
  );
}

export function ConfigTab({ app }: { app: AppView }) {
  const { data, isPending, error, refetch, isFetching } = useQuery(configQuery(app));
  const writes = useWrites();
  const [dialog, setDialog] = useState<ConfigDialogState | null>(null);
  // Bumped after a write so every row remounts, which hides any revealed value.
  const [generation, setGeneration] = useState(0);

  const own = data?.filter((v) => !v.managed) ?? [];
  const managed = data?.filter((v) => v.managed) ?? [];
  const rows = (list: ConfigKey[]) =>
    list.map((entry) => (
      <ConfigRow
        key={`${generation}:${entry.key}`}
        app={app}
        entry={entry}
        writes={writes}
        onEdit={(key, value) => setDialog({ kind: "edit", key, value })}
        onUnset={(key) => setDialog({ kind: "unset", key })}
      />
    ));

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title={`Environment (${data?.length ?? "..."})`}
        action={
          dataSource === "mock" ? (
            <StubButton icon="add" label="Add variable" />
          ) : (
            <button
              type="button"
              onClick={() => setDialog({ kind: "add" })}
              disabled={!writes.enabled}
              title={writes.enabled ? undefined : writes.reason}
              className={textButton}
            >
              <Plus className="size-3" aria-hidden="true" />
              Add variable
            </button>
          )
        }
      >
        {dataSource === "api" && !writes.enabled && (
          <p className="border-b border-line px-4 py-2.5 text-xs text-dim">
            Changes are off. {writes.reason}
          </p>
        )}
        {error ? (
          <ErrorNote error={error} onRetry={() => void refetch()} retrying={isFetching} />
        ) : isPending || !data ? (
          <div className="flex flex-col gap-3 p-4">
            {["a", "b", "c"].map((k) => (
              <Skeleton key={k} className="h-8 w-full" />
            ))}
          </div>
        ) : (
          <>
            {own.length === 0 && managed.length === 0 && (
              <EmptyNote>No variables set.</EmptyNote>
            )}
            {own.length > 0 && <ul className="divide-y divide-line">{rows(own)}</ul>}
            {managed.length > 0 && (
              <>
                <p className="label border-y border-line bg-sunken px-4 py-1.5">
                  Managed by Dokku
                </p>
                <ul className="divide-y divide-line">{rows(managed)}</ul>
              </>
            )}
          </>
        )}
        <p className="border-t border-line px-4 py-2.5 font-mono text-xs text-faint">
          <span className="select-none">$ </span>dokku config:set --no-restart {app.name}{" "}
          KEY=value
        </p>
      </Panel>
      <ConfigDialog
        app={app}
        state={dialog}
        existingKeys={data?.map((v) => v.key) ?? []}
        onClose={() => setDialog(null)}
        onSaved={() => setGeneration((g) => g + 1)}
      />
    </div>
  );
}
