import {
  type OperationId,
  type OperationRequest,
  operationAvailability,
} from "../../shared/operations";
import type { AppSummary } from "../../shared/types";

// The operations table, its Dokku commands and availability rules live in
// shared/operations.ts (the server runs them); this adds the wording the UI shows around them.

export { operationAvailability };

/** `{target}` in a wording below stands for what the operation is about: see `targetOf`. */
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
  "apps:rename": {
    label: "Rename app",
    title: "Rename an app",
    pending: "Renaming...",
    done: "Renamed {target}.",
    effect:
      "Gives the app a new name: its default vhost becomes <new name>.<global domain>, its containers are renamed and its git remote becomes dokku@<host>:<new name>, so remotes and bookmarks to the old name stop working, as does anything outside Dokku that points at it (DNS, tunnels, other apps' config). Config, ports, networks, storage mounts, scaling and custom domains come along. Dokku creates the new app, destroys the old one and redeploys the source under the new name (about 30 s), which also starts an app that was stopped; skipping the deploy leaves a deployed app not running until it is started.",
    tone: "danger",
  },
  "apps:clone": {
    label: "Clone app",
    title: "Clone an app",
    pending: "Cloning...",
    done: "Cloned {target}.",
    effect:
      "Copies the app under a new name: config vars (secrets included), port map, network settings and aliases, proxy settings, storage mounts, resource limits, scaling and the git source or image. Storage mounts point at the same host directories, so both apps share that data, and a copied alias answers for both apps on a shared network. Custom domains are not copied: the clone gets only its own default vhost. Deploying the copy takes about 25 s; without it the clone shows as never deployed until it is deployed or synced.",
    tone: "neutral",
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
  "domains:add-global": {
    label: "Add global domain",
    title: "Add global domains",
    pending: "Adding...",
    done: "Added the global domain {target}.",
    effect:
      "Apps created from now on get <app>.<domain> as an extra vhost. Apps that already exist are not changed, not even by a rebuild; run dokku domains:reset <app> on the host to regenerate one app's vhosts.",
    tone: "neutral",
  },
  "domains:remove-global": {
    label: "Remove global domain",
    title: "Remove a global domain?",
    pending: "Removing...",
    done: "Removed the global domain {target}.",
    effect:
      "Apps created from now on no longer get it. Apps that already exist keep the vhosts they have, this domain included, until it is removed from each of them. Removing the last global domain leaves new apps without a default vhost.",
    tone: "danger",
  },
  "domains:set-global": {
    label: "Set global domains",
    title: "Set the global domains",
    pending: "Saving...",
    done: "Set the global domains to {target}.",
    effect:
      "Replaces the whole list. Apps created from now on get <app>.<domain> for each; apps that already exist keep their vhosts as they are, and the ones of a domain taken out stay until removed from each app.",
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
      "Sets how many containers run per process type. Dokku redeploys the app to apply it (about 40 s for one more web container) unless you only save the formation. Scaling a stopped app starts it, and web=0 removes every web container, which leaves the app serving nothing.",
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
  "apps:unlock": {
    label: "Release lock",
    title: "Release the deploy lock of {target}?",
    pending: "Releasing...",
    done: "Released the deploy lock of {target}.",
    effect:
      "Removes the lock a failed deploy left behind, so operations on the app work again. Pierhead refuses while Dokku has a build or deploy record still running for the app: releasing the lock under a deploy that is really under way lets a second one start on top of it.",
    tone: "danger",
  },
  "git:from-image": {
    label: "Deploy image",
    title: "Deploy an image to {target}",
    pending: "Deploying...",
    done: "Deployed an image to {target}.",
    effect:
      "Pulls the image and deploys it, replacing the running containers (about 25 s for a small, cached image). The image must be public. The app's source becomes this image until code is pushed or synced again.",
    tone: "neutral",
  },
  "git:sync": {
    label: "Sync",
    title: "Sync {target} from git",
    pending: "Syncing...",
    done: "Synced {target} from git.",
    effect:
      "Clones or fetches the repository into the app. Built and deployed, it replaces the running containers like a push does; without the build the source is only fetched and nothing changes until the next build. The Dokku host fetches the URL itself, with its own network access and keys, so a private repository works only if the host has credentials for it. A build that fails can leave Dokku's deploy lock held, which refuses every other operation until it is released from the Settings tab.",
    tone: "neutral",
  },
  "git:set": {
    label: "Save",
    title: "Set the deploy branch of {target}",
    pending: "Saving...",
    done: "Saved the deploy branch of {target}.",
    effect:
      "The branch a push or sync deploys from. Empty goes back to Dokku's default. Takes effect on the next deploy.",
    tone: "neutral",
  },
  "git:set-global": {
    label: "Save",
    title: "Set the global deploy branch",
    pending: "Saving...",
    done: "Set the global deploy branch to {target}.",
    effect:
      "The branch Dokku deploys from for apps that set none of their own; they follow it from their next push or sync. An app with its own deploy branch keeps it. Empty goes back to Dokku's default, master.",
    tone: "neutral",
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
      "Removes only the setting named below; Docker's default (no limit) applies to it from the next deploy.",
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
    case "apps:rename":
    case "apps:clone": {
      if (apps.some((a) => a.name === req.newName)) {
        return `An app named ${req.newName} already exists.`;
      }
      // A renamed app keeps its own domains, so one of them may become the new name.
      const owner = apps.find(
        (a) =>
          a.domains.includes(req.newName) &&
          !(req.op === "apps:rename" && a.name === req.app),
      );
      return owner ? `${req.newName} is already a domain of ${owner.name}.` : null;
    }
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
