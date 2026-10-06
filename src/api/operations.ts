import {
  type OperationId,
  type OperationRequest,
  operationAvailability,
} from "../../shared/operations";
import type { AppSummary } from "../../shared/types";

// The operations table, its Dokku commands and availability rules live in
// shared/operations.ts (the server runs them); this adds the wording the UI shows around them.

export { operationAvailability };

/** `{target}` in a wording below stands for what the operation is about: its app, or its network. */
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
    title: "Start {target}?",
    pending: "Starting...",
    done: "Started {target}.",
    effect: "Starts the app's stopped containers with the current image.",
    tone: "neutral",
  },
  "ps:restart": {
    label: "Restart",
    title: "Restart {target}?",
    pending: "Restarting...",
    done: "Restarted {target}.",
    effect:
      "Stops and starts the app's containers with the current image. Config and domains are untouched.",
    tone: "neutral",
  },
  "ps:rebuild": {
    label: "Rebuild",
    title: "Rebuild {target}?",
    pending: "Rebuilding...",
    done: "Rebuilt {target}.",
    effect:
      "Rebuilds the image from the last pushed revision and swaps containers once it is healthy.",
    tone: "neutral",
  },
  "ps:stop": {
    label: "Stop",
    title: "Stop {target}?",
    pending: "Stopping...",
    done: "Stopped {target}.",
    effect: "Stops all containers. The app serves nothing until it is started again.",
    tone: "danger",
  },
  "apps:create": {
    label: "Create app",
    title: "Create an app",
    pending: "Creating...",
    done: "Created {target}.",
    effect:
      "Creates an empty app with its default vhost. Nothing runs until you push code or deploy an image.",
    tone: "neutral",
  },
  "apps:destroy": {
    label: "Destroy app",
    title: "Destroy {target}?",
    pending: "Destroying...",
    done: "Destroyed {target}.",
    effect:
      "Removes the app's containers, image, config, domains and vhost. This cannot be undone. Storage directories stay on the host.",
    tone: "danger",
  },
  "domains:add": {
    label: "Add domain",
    title: "Add domains to {target}",
    pending: "Adding...",
    done: "Added domains to {target}.",
    effect:
      "nginx reloads; the app keeps running. The hostname only works once DNS (or the tunnel) routes it to this host.",
    tone: "neutral",
  },
  "domains:remove": {
    label: "Remove domain",
    title: "Remove a domain from {target}?",
    pending: "Removing...",
    done: "Removed the domain from {target}.",
    effect: "nginx reloads; the app keeps running but stops answering on this hostname.",
    tone: "danger",
  },
  "domains:set": {
    label: "Set domains",
    title: "Set the domains of {target}",
    pending: "Saving...",
    done: "Set the domains of {target}.",
    effect:
      "Replaces every domain with this list, the default vhost included. nginx reloads; the app keeps running.",
    tone: "neutral",
  },
  "ports:add": {
    label: "Add port",
    title: "Add port mappings to {target}",
    pending: "Adding...",
    done: "Added port mappings to {target}.",
    effect: "nginx reloads; the app keeps running.",
    tone: "neutral",
  },
  "ports:remove": {
    label: "Remove port",
    title: "Remove a port mapping from {target}?",
    pending: "Removing...",
    done: "Removed the port mapping from {target}.",
    effect: "nginx reloads; the app keeps running.",
    tone: "danger",
  },
  "ports:set": {
    label: "Set ports",
    title: "Set the port mappings of {target}",
    pending: "Saving...",
    done: "Set the port mappings of {target}.",
    effect:
      "Replaces every mapping with this list. nginx reloads; the app keeps running.",
    tone: "neutral",
  },
  "proxy:enable": {
    label: "Enable proxy",
    title: "Enable the proxy for {target}?",
    pending: "Enabling...",
    done: "Enabled the proxy for {target}.",
    effect:
      "Puts nginx in front of the app again. Dokku redeploys a deployed app (about 25 s) and brings back only the default domain, not the port map or custom domains it cleared when the proxy was disabled.",
    tone: "neutral",
  },
  "proxy:disable": {
    label: "Disable proxy",
    title: "Disable the proxy for {target}?",
    pending: "Disabling...",
    done: "Disabled the proxy for {target}.",
    effect:
      "Removes nginx from in front of the app. Dokku redeploys a deployed app (about 25 s) and clears its port map and every custom domain (only the default comes back on enable); afterwards only its attached networks reach it. Pierhead remembers both until it restarts, and enabling the proxy offers to restore them.",
    tone: "danger",
  },
  "ps:scale": {
    label: "Scale",
    title: "Scale {target}",
    pending: "Scaling...",
    done: "Scaled {target}.",
    effect:
      "Sets how many containers run per process type. Dokku redeploys the app to apply it (about 40 s for one more web container) unless you only save the formation.",
    tone: "neutral",
  },
  "network:create": {
    label: "Create network",
    title: "Create a network",
    pending: "Creating...",
    done: "Created the network {target}.",
    effect:
      "Creates a Docker network that apps can be attached to. Nothing joins it until an app is attached.",
    tone: "neutral",
  },
  "network:destroy": {
    label: "Destroy network",
    title: "Destroy {target}?",
    pending: "Destroying...",
    done: "Destroyed the network {target}.",
    effect:
      "Removes the Docker network. Pierhead refuses while any app's attach settings still name it, and Docker refuses while a running container is still connected: after detaching an app, rebuild it first.",
    tone: "danger",
  },
  "network:set": {
    label: "Save",
    title: "Set the networks of {target}",
    pending: "Saving...",
    done: "Saved the networks of {target}.",
    effect:
      "Takes effect on the next deploy: the running container stays on its current networks until the app is rebuilt or deployed again.",
    tone: "neutral",
  },
  "network:alias-add": {
    label: "Add alias",
    title: "Add a network alias to {target}",
    pending: "Adding...",
    done: "Added an alias to {target}.",
    effect:
      "Other containers on the app's networks can reach it by this name. Takes effect on the next deploy, not on the running container.",
    tone: "neutral",
  },
  "network:alias-remove": {
    label: "Remove alias",
    title: "Remove a network alias from {target}?",
    pending: "Removing...",
    done: "Removed an alias from {target}.",
    effect:
      "Stops the name resolving to the app's containers once it is redeployed; the running container keeps it until then.",
    tone: "danger",
  },
  "builder:set": {
    label: "Save",
    title: "Change a builder setting of {target}",
    pending: "Saving...",
    done: "Saved the builder settings of {target}.",
    effect:
      "Takes effect on the next build. Leave the value empty to go back to Dokku's default.",
    tone: "neutral",
  },
  "resource:set": {
    label: "Save",
    title: "Set resource limits of {target}",
    pending: "Saving...",
    done: "Saved the resources of {target}.",
    effect:
      "Takes effect on the next deploy: the running containers keep their current limits until then. A blank value is left as it is.",
    tone: "neutral",
  },
  "resource:clear": {
    label: "Clear",
    title: "Clear resource settings of {target}?",
    pending: "Clearing...",
    done: "Cleared the resources of {target}.",
    effect:
      "Removes the setting; Docker's default (no limit) applies from the next deploy.",
    tone: "danger",
  },
  "storage:mount": {
    label: "Mount",
    title: "Mount storage in {target}",
    pending: "Mounting...",
    done: "Mounted storage in {target}.",
    effect:
      "Binds a directory under /var/lib/dokku/data/storage (created if missing) into the app's containers. Applies on the next restart or deploy. The data lives on the host and is not part of Dokku's app state: add the directory to the lab backup.",
    tone: "neutral",
  },
  "storage:unmount": {
    label: "Unmount",
    title: "Unmount storage from {target}?",
    pending: "Unmounting...",
    done: "Unmounted storage from {target}.",
    effect:
      "Removes the mount from the app. The directory and its data stay on the host. Applies on the next restart or deploy.",
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

/** A wording with its `{target}` filled in. */
export const forTarget = (wording: string, target: string) =>
  wording.replaceAll("{target}", target);

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
