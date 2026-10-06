import type { ReactNode } from "react";
import type {
  AppState,
  Availability,
  OperationId,
  OperationRequest,
} from "../../shared/operations";
import { operationAvailability } from "../api/operations";
import { usePendingOperation, useRequestOperation, useWrites } from "./OperationHost";

export const textButton =
  "h-8 rounded-sm border border-line-strong px-2.5 text-sm font-medium enabled:hover:bg-raised disabled:cursor-not-allowed disabled:opacity-45";

export const removeButton =
  "grid size-8 shrink-0 place-items-center rounded-sm text-dim enabled:hover:bg-crit/10 enabled:hover:text-crit disabled:cursor-not-allowed disabled:opacity-45";

/**
 * What a control for `op` says when it cannot be used, if anything. `app` is the target's
 * state for operations on an app; operations on a network have none.
 */
export function useDisabledReason(op: OperationId, app?: AppState) {
  const writes = useWrites();
  const pending = usePendingOperation();
  const availability: Availability = app ? operationAvailability(op, app) : { ok: true };
  if (!writes.enabled) return writes.reason;
  if (!availability.ok) return availability.reason;
  if (pending) return "Another operation is running.";
  return undefined;
}

/** Opens the dialog for `request`; disabled, with the reason as its tooltip, when it cannot run. */
export function OperationButton({
  app,
  request,
  note,
  className,
  label,
  disabledReason,
  children,
}: {
  app?: AppState;
  request: OperationRequest;
  /** Shown in the dialog under the effect. */
  note?: string;
  className: string;
  label: string;
  /** A reason of the caller's own, which wins over the operation's. */
  disabledReason?: string;
  children: ReactNode;
}) {
  const open = useRequestOperation();
  const reason = useDisabledReason(request.op, app);
  const why = disabledReason ?? reason;
  return (
    <button
      type="button"
      aria-label={label}
      disabled={why !== undefined}
      title={why ?? label}
      onClick={() => open(request, note)}
      className={className}
    >
      {children}
    </button>
  );
}
