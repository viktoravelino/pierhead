import type { AppSummary } from "./types";

// The app actions and the Dokku command each one runs: one table for the server (which
// executes it) and the frontend (which shows it in the confirm dialog).

export const appActions = {
  start: { command: "ps:start", streams: false },
  restart: { command: "ps:restart", streams: false },
  rebuild: { command: "ps:rebuild", streams: true },
  stop: { command: "ps:stop", streams: false },
} as const satisfies Record<string, { command: `ps:${string}`; streams: boolean }>;

export type AppActionId = keyof typeof appActions;

/** In the order the UI lists them. */
export const appActionIds = [
  "start",
  "restart",
  "rebuild",
  "stop",
] as const satisfies readonly AppActionId[];

export const isAppActionId = (value: string): value is AppActionId =>
  Object.hasOwn(appActions, value);

/** The shell command the confirm dialog shows for an action. */
export const commandLine = (action: AppActionId, app: string) =>
  `dokku ${appActions[action].command} ${app}`;

/** A rebuild's SSE event: one line of Dokku output (ANSI codes stripped). */
export type ActionOutputEvent = { line: string };

type Availability = { ok: true } | { ok: false; reason: string };

const available = { ok: true } as const;
const unavailable = (reason: string) => ({ ok: false, reason }) as const;

/** Whether an action makes sense for the app's current state; `reason` explains a no. */
export function actionAvailability(
  action: AppActionId,
  { status, revision }: Pick<AppSummary, "status" | "revision">,
): Availability {
  switch (status.kind) {
    case "deploying":
      return unavailable("A deploy is in progress.");
    case "not-deployed":
      return action === "rebuild"
        ? revision
          ? available
          : unavailable("No code has been pushed yet.")
        : unavailable("Never deployed, so there is nothing to run yet.");
    case "stopped":
      if (action === "stop") return unavailable("Already stopped.");
      if (action === "restart") return unavailable("Stopped. Start it instead.");
      return available;
    case "running":
    case "crashed":
      return action === "start" ? unavailable("Already running.") : available;
  }
}
