import { type AppActionId, actionAvailability, appActionIds } from "../../shared/actions";

// The action list, its Dokku commands and availability rules live in shared/actions.ts
// (the server runs them); this adds the wording the UI shows around them.

export type { AppActionId };
export { actionAvailability, appActionIds };

type ActionDef = {
  label: string;
  /** Shown on the button while the action runs. */
  pending: string;
  /** Past tense, for the success toast. */
  done: string;
  /** One sentence describing the effect, shown in the confirm dialog. */
  effect: string;
  tone: "neutral" | "danger";
};

export const appActions = {
  start: {
    label: "Start",
    pending: "Starting...",
    done: "Started",
    effect: "Starts the app's stopped containers with the current image.",
    tone: "neutral",
  },
  restart: {
    label: "Restart",
    pending: "Restarting...",
    done: "Restarted",
    effect:
      "Stops and starts the app's containers with the current image. Config and domains are untouched.",
    tone: "neutral",
  },
  rebuild: {
    label: "Rebuild",
    pending: "Rebuilding...",
    done: "Rebuilt",
    effect:
      "Rebuilds the image from the last pushed revision and swaps containers once it is healthy.",
    tone: "neutral",
  },
  stop: {
    label: "Stop",
    pending: "Stopping...",
    done: "Stopped",
    effect: "Stops all containers. The app serves nothing until it is started again.",
    tone: "danger",
  },
} as const satisfies Record<AppActionId, ActionDef>;
