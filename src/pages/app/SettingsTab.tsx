import type { AppView } from "../../api/client";
import { operationAvailability } from "../../api/operations";
import { useRequestOperation, useWrites } from "../../components/OperationHost";
import { Mono, Panel } from "../../components/ui";

/** App settings; for now only the Danger zone, which holds the irreversible operations. */
export function SettingsTab({ app }: { app: AppView }) {
  const requestOperation = useRequestOperation();
  const writes = useWrites();
  const availability = operationAvailability("apps:destroy", app);
  const disabledReason = !writes.enabled
    ? writes.reason
    : !availability.ok
      ? availability.reason
      : undefined;

  return (
    <Panel title="Danger zone" className="max-w-3xl border-crit/40">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="font-medium">Destroy this app</h3>
          <p className="max-w-[60ch] text-pretty text-dim">
            Removes <Mono>{app.name}</Mono> with its containers, image, config, domains
            and vhost. You will be asked to type its name. This cannot be undone.
          </p>
        </div>
        <button
          type="button"
          disabled={disabledReason !== undefined}
          title={disabledReason}
          onClick={() =>
            requestOperation({ op: "apps:destroy", app: app.name, confirm: "" })
          }
          className="h-9 rounded-sm border border-crit/40 px-3 font-medium text-crit enabled:hover:bg-crit/10 disabled:cursor-not-allowed disabled:opacity-45"
        >
          Destroy app
        </button>
      </div>
    </Panel>
  );
}
