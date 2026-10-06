import { useQuery } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { maxProcessCount } from "../../shared/grammar";
import { operationAvailability } from "../../shared/operations";
import type { FormationEntry } from "../../shared/types";
import { appsQuery, networksQuery } from "../api/queries";

// The inputs the operation dialog is built from.

export const inputClass =
  "h-9 w-full rounded-sm border border-line-strong bg-sunken px-2.5 font-mono text-[13px] focus:outline-2 focus:outline-accent";

export const rowButton =
  "grid size-9 shrink-0 place-items-center rounded-sm border border-line-strong text-dim hover:bg-sunken hover:text-fg disabled:opacity-45";

export function TextField({
  label,
  value,
  placeholder,
  hint,
  focus = true,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  hint?: string;
  /** Whether the field takes focus when the dialog opens; one per dialog. */
  focus?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="label">{label}</span>
      <input
        // biome-ignore lint/a11y/noAutofocus: the dialog exists to fill this field
        autoFocus={focus}
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

export function SelectField({
  label,
  value,
  options,
  hint,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  hint?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="label">{label}</span>
      <select
        // biome-ignore lint/a11y/noAutofocus: the dialog exists to fill this field
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={inputClass}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint && <span className="text-xs text-faint">{hint}</span>}
    </label>
  );
}

export function Checkbox({
  checked,
  disabled,
  onChange,
  children,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="flex items-start gap-2.5">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 size-4 accent-accent"
      />
      <span className="text-pretty">{children}</span>
    </label>
  );
}

/**
 * Process types with a count each. The rows the dialog opened with (`locked`) keep their
 * type; rows added here take any lowercase type, which Dokku starts whatever the image runs.
 */
export function FormationList({
  formation,
  locked,
  onChange,
}: {
  formation: FormationEntry[];
  locked: number;
  onChange: (formation: FormationEntry[]) => void;
}) {
  const edit = (i: number, patch: Partial<FormationEntry>) =>
    onChange(formation.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="label mb-1.5">Containers per process type</legend>
      {formation.map((entry, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity beyond their position
        <div key={i} className="grid grid-cols-[1fr_6rem_2.25rem] gap-2">
          <input
            aria-label={`Process type ${i + 1}`}
            readOnly={i < locked}
            value={entry.type}
            placeholder="worker"
            onChange={(e) => edit(i, { type: e.target.value })}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            className={`${inputClass} read-only:text-dim`}
          />
          <input
            type="number"
            min={0}
            max={maxProcessCount}
            aria-label={`Count for ${entry.type || `row ${i + 1}`}`}
            value={Number.isNaN(entry.count) ? "" : entry.count}
            onChange={(e) =>
              edit(i, {
                count: e.target.value === "" ? Number.NaN : Number(e.target.value),
              })
            }
            className={`${inputClass} tabular`}
          />
          <button
            type="button"
            aria-label={`Leave out row ${i + 1}`}
            title="Leave this type out of the command"
            disabled={formation.length === 1}
            onClick={() => onChange(formation.filter((_, j) => j !== i))}
            className={rowButton}
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...formation, { type: "", count: 1 }])}
        className="flex h-8 items-center gap-1.5 self-start text-sm font-medium text-accent hover:underline"
      >
        <Plus className="size-3.5" aria-hidden="true" />
        Add process type
      </button>
      {formation.length > locked && (
        <p className="text-pretty text-xs text-warn">
          Dokku accepts any type, even one the app does not define: it starts a container
          running the image's default command.
        </p>
      )}
    </fieldset>
  );
}

/**
 * The networks an attachment names: one select for `initial-network`, checkboxes for the
 * attach lists. Networks the app already names but Docker lacks stay listed, so they can be removed.
 */
export function NetworkPicker({
  property,
  selected,
  onChange,
}: {
  property: "initial-network" | "attach-post-create" | "attach-post-deploy";
  selected: string[];
  onChange: (networks: string[]) => void;
}) {
  const { data: networks } = useQuery(networksQuery);
  const names = [
    ...new Set([...(networks ?? []).map((n) => n.name), ...selected]),
  ].sort();
  if (property === "initial-network") {
    return (
      <SelectField
        label="Initial network"
        value={selected[0] ?? ""}
        hint="The network the container is created on, instead of Docker's default bridge."
        options={[
          { value: "", label: "None (Docker's default bridge)" },
          ...names.map((name) => ({ value: name, label: name })),
        ]}
        onChange={(value) => onChange(value === "" ? [] : [value])}
      />
    );
  }
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="label mb-1.5">
        {property === "attach-post-create"
          ? "Attach after the container is created"
          : "Attach after the deploy succeeds"}
      </legend>
      {names.length === 0 && <p className="text-dim">No networks yet.</p>}
      {names.map((name) => (
        <Checkbox
          key={name}
          checked={selected.includes(name)}
          onChange={(on) =>
            onChange(on ? [...selected, name] : selected.filter((n) => n !== name))
          }
        >
          <span className="font-mono text-[13px]">{name}</span>
        </Checkbox>
      ))}
    </fieldset>
  );
}

/** The "rebuild now" option of settings that only apply on the next deploy. */
export function RebuildToggle({
  app,
  checked,
  onChange,
}: {
  app: string;
  checked: boolean;
  onChange: (rebuild: boolean) => void;
}) {
  const { data: apps = [] } = useQuery(appsQuery);
  const summary = apps.find((a) => a.name === app);
  const availability = summary
    ? operationAvailability("ps:rebuild", summary)
    : ({ ok: false, reason: "Loading the app..." } as const);
  return (
    <div className="flex flex-col gap-1">
      <Checkbox
        checked={checked && availability.ok}
        disabled={!availability.ok}
        onChange={onChange}
      >
        Rebuild now to apply it
      </Checkbox>
      <p className="pl-6.5 text-xs text-faint">
        {availability.ok
          ? "Adds a rebuild (about 25 s, streamed). Without it the change waits for the next deploy."
          : `Not available: ${availability.reason}`}
      </p>
    </div>
  );
}
