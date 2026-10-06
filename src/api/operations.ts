import {
  type OperationId,
  type OperationRequest,
  operationAvailability,
} from "../../shared/operations";
import type { AppSummary } from "../../shared/types";

// The operations table, its Dokku commands and availability rules live in
// shared/operations.ts (the server runs them); this adds the wording the UI shows around them.

export { operationAvailability };

/** `{app}` in a wording below stands for the target app's name. */
type OperationUi = {
  /** The confirm button and, with the app name, palette entries and toasts. */
  label: string;
  /** The dialog's heading. */
  title: string;
  /** Shown on the button while the operation runs. */
  pending: string;
  /** Past tense, for the success toast. */
  done: string;
  /** One sentence describing the effect, shown in the confirm dialog. */
  effect: string;
  tone: "neutral" | "danger";
};

export const operationUi = {
  "ps:start": {
    label: "Start",
    title: "Start {app}?",
    pending: "Starting...",
    done: "Started {app}.",
    effect: "Starts the app's stopped containers with the current image.",
    tone: "neutral",
  },
  "ps:restart": {
    label: "Restart",
    title: "Restart {app}?",
    pending: "Restarting...",
    done: "Restarted {app}.",
    effect:
      "Stops and starts the app's containers with the current image. Config and domains are untouched.",
    tone: "neutral",
  },
  "ps:rebuild": {
    label: "Rebuild",
    title: "Rebuild {app}?",
    pending: "Rebuilding...",
    done: "Rebuilt {app}.",
    effect:
      "Rebuilds the image from the last pushed revision and swaps containers once it is healthy.",
    tone: "neutral",
  },
  "ps:stop": {
    label: "Stop",
    title: "Stop {app}?",
    pending: "Stopping...",
    done: "Stopped {app}.",
    effect: "Stops all containers. The app serves nothing until it is started again.",
    tone: "danger",
  },
  "apps:create": {
    label: "Create app",
    title: "Create an app",
    pending: "Creating...",
    done: "Created {app}.",
    effect:
      "Creates an empty app with its default vhost. Nothing runs until you push code or deploy an image.",
    tone: "neutral",
  },
  "apps:destroy": {
    label: "Destroy app",
    title: "Destroy {app}?",
    pending: "Destroying...",
    done: "Destroyed {app}.",
    effect:
      "Removes the app's containers, image, config, domains and vhost. This cannot be undone. Storage directories stay on the host.",
    tone: "danger",
  },
  "domains:add": {
    label: "Add domain",
    title: "Add domains to {app}",
    pending: "Adding...",
    done: "Added domains to {app}.",
    effect:
      "nginx reloads; the app keeps running. The hostname only works once DNS (or the tunnel) routes it to this host.",
    tone: "neutral",
  },
  "domains:remove": {
    label: "Remove domain",
    title: "Remove a domain from {app}?",
    pending: "Removing...",
    done: "Removed the domain from {app}.",
    effect: "nginx reloads; the app keeps running but stops answering on this hostname.",
    tone: "danger",
  },
  "domains:set": {
    label: "Set domains",
    title: "Set the domains of {app}",
    pending: "Saving...",
    done: "Set the domains of {app}.",
    effect:
      "Replaces every domain with this list, the default vhost included. nginx reloads; the app keeps running.",
    tone: "neutral",
  },
  "ports:add": {
    label: "Add port",
    title: "Add port mappings to {app}",
    pending: "Adding...",
    done: "Added port mappings to {app}.",
    effect: "nginx reloads; the app keeps running.",
    tone: "neutral",
  },
  "ports:remove": {
    label: "Remove port",
    title: "Remove a port mapping from {app}?",
    pending: "Removing...",
    done: "Removed the port mapping from {app}.",
    effect: "nginx reloads; the app keeps running.",
    tone: "danger",
  },
  "ports:set": {
    label: "Set ports",
    title: "Set the port mappings of {app}",
    pending: "Saving...",
    done: "Set the port mappings of {app}.",
    effect:
      "Replaces every mapping with this list. nginx reloads; the app keeps running.",
    tone: "neutral",
  },
  "proxy:enable": {
    label: "Enable proxy",
    title: "Enable the proxy for {app}?",
    pending: "Enabling...",
    done: "Enabled the proxy for {app}.",
    effect:
      "Puts nginx in front of the app again. Dokku redeploys a deployed app (about 25 s) and does not bring back the port map it cleared when the proxy was disabled.",
    tone: "neutral",
  },
  "proxy:disable": {
    label: "Disable proxy",
    title: "Disable the proxy for {app}?",
    pending: "Disabling...",
    done: "Disabled the proxy for {app}.",
    effect:
      "Removes nginx from in front of the app. Dokku redeploys a deployed app (about 25 s) and clears its port map; afterwards only its attached networks reach it. Enabling the proxy again offers to restore the map.",
    tone: "danger",
  },
} as const satisfies Record<OperationId, OperationUi>;

/** The per-app buttons and palette entries, in the order the UI lists them. */
export const psOperationIds = [
  "ps:start",
  "ps:restart",
  "ps:rebuild",
  "ps:stop",
] as const satisfies readonly OperationId[];

/** A wording with its `{app}` filled in. */
export const forApp = (wording: string, app: string) => wording.replaceAll("{app}", app);

/**
 * Problems the host's other apps cause, which only the loaded list can tell (the server
 * checks them again). `null` when there is none.
 */
export function conflictProblem(req: OperationRequest, apps: readonly AppSummary[]) {
  switch (req.op) {
    case "apps:create":
      return apps.some((a) => a.name === req.app)
        ? `An app named ${req.app} already exists.`
        : null;
    case "domains:add":
    case "domains:set": {
      for (const domain of req.domains) {
        const owner = apps.find((a) => a.name !== req.app && a.domains.includes(domain));
        if (owner) return `${domain} is already served by ${owner.name}.`;
      }
      return null;
    }
    default:
      return null;
  }
}
