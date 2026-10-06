# Management features: design

Pierhead reads a Dokku host well and changes little: start, stop, restart, rebuild and config vars. This document designs the next step, the management operations a Dokku dashboard needs, on the patterns the code already has. Every command below was run against the local Dokku 0.38.31 (`bun run dev:up`) through the same restricted `dokku@host` SSH path the server uses, on a throwaway app that was destroyed afterwards. Timings are from that stack (images cached) and will be longer on the lab host. Anything not tried is marked *unverified*.

## 1. Scope and principles

Same shape as today, for every new write:

- One entry in a typed table (`shared/operations.ts`, section 4) is the only place that knows the Dokku command, its argument grammar, whether it streams and what it invalidates. The allowlist in `server/dokku.ts` gains the commands; free-form arguments are checked against a grammar before they reach argv and anything that is not a fixed token goes through `shellQuote` for the SSH hop (sshd word-splits the remote command: `domains:add app 'bad domain'` added two domains, `network:create 'bad net'` created `bad`).
- Validation lives in `shared/` and runs in the form and in the route; the server never trusts the client.
- `PIERHEAD_ALLOW_WRITES=true` stays the second switch. A read-only server answers `403 writes-disabled`; the UI disables the control and says why.
- The confirm dialog shows the exact `dokku ...` line, assembled by the same builder the server runs.
- On success (and after a streamed command ends, whatever its outcome) the read cache is invalidated, one `operation ...` line goes to stdout, and the attempt is recorded in the activity log (3.13).
- Destructive operations (destroy app, destroy network, clear domains or mounts) require typing the name of the thing, and the server checks the typed name too, exactly as Dokku's own prompt does.
- Nothing the `dokku` user cannot do. `ssh-keys:add`, `ssh-keys:remove` and `plugin:install` answer "This command must be run as root" (exit 1) and stay out.
- Dokku validates less than one would hope: it accepted `-h` as a domain, `../etc` as a build-dir, `lots` as a memory limit, `caddy` as a proxy type, a domain another app already serves, and it destroyed a network an app still referenced. Pierhead's validation is the real guard, not a nicety.

## 2. Prerequisite: authentication

Destroying apps and editing routing must not ship on a dashboard anyone on the network can open. Today pierhead has no login; it listens on `127.0.0.1:3001` behind Caddy at `https://pierhead.lab.vkav.dev`, with TLS at Cloudflare.

Minimal option, in the homelab repo, before the first PR below reaches `main`'s image: Caddy `basic_auth` on the pierhead route (`caddy hash-password` for the bcrypt hash, one user). It is one Caddyfile block, works with the Cloudflare tunnel, and costs nothing in pierhead. The stronger option later is `forward_auth` to an identity provider (Pocket ID, Authelia) on the same route; pierhead does not change either way.

What pierhead needs: nothing for the gate itself. Two small things make the log useful: Caddy forwards the authenticated user as a header (`header_up X-Pierhead-User {http.auth.user.id}`) and the server records it as the actor of each operation (3.13); and `GET /api/health` could report `auth: "proxy" | "none"` so the sidebar can show a warning badge when writes are enabled without it. Per-user read-only roles are not needed for one operator and are left out.

Keep the two switches independent: a server with writes on and no auth in front should be treated as misconfigured. The README's deploy section gets the Caddyfile block and this rule.

## 3. Features

Order is the recommended shipping order. Each feature is a set of operations (section 4); "API" below gives the request union members and the 4xx cases beyond the common ones (`400 invalid-body` for a body that fails the grammar, `403 writes-disabled`, `404 not-found` for an unknown app, `502` for a failed SSH call). Quick operations answer `{ ok: true, output }`; operations that can redeploy stream SSE (`output` lines, then `end` or `failed`) exactly like rebuild.

### 3.1 Create app

Story: from the apps list, create an empty app to push to or deploy an image into.

| Command | Verified behaviour |
| --- | --- |
| `apps:create <name>` | 1.3 s. Creates the nginx vhost `<name>.<global domain>` and reloads nginx even though nothing is deployed. Exit 1 "Name is already taken" for a duplicate; exit 1 with the grammar message for `Bad_Name`. `1abc` is valid. |
| `apps:exists <name>` | Exit 0 or exit 20 "App ... does not exist" (already what `isNotFound` matches). |

API: `{ op: "apps:create"; app }`. 409 `exists` when `apps:exists` says so (checked first so the user gets a clear message rather than Dokku's). Name grammar is the existing `isAppName`, plus a 63-character cap so the default vhost stays a valid DNS label.

UI: "New app" button on the apps list (hidden when read-only). Dialog: name field with live grammar and "already exists" checks against the loaded list, the command line, Create. On success navigate to the new app, which shows as never deployed with a hint pointing at Deploy (3.8).

Invalidation: list, networks. Risks: none beyond a stray vhost; the app is empty. Effort: S. Depends on the operation framework (section 4).

### 3.2 Destroy app

Story: remove an app, its containers, image, config and vhost.

| Command | Verified behaviour |
| --- | --- |
| `apps:destroy --force <name>` | 1.5 s never deployed, 1.9 s deployed with three containers. Without `--force` Dokku prompts for the name and exits 1 under SSH with no tty, so the server always passes `--force` and does the prompt itself. |

API: `{ op: "apps:destroy"; app; confirm }`. 400 `confirm-mismatch` unless `confirm === app`. Streams: no.

UI: "Danger zone" at the bottom of the new Settings tab (3.7). Dialog in the danger tone: what goes away (containers, image, config, domains; storage directories stay on disk, see 3.9), the type-the-name field, the command line. The command palette never offers it.

Invalidation: list, networks, the app's entries, its builds (3.13). Risks: this is the one irreversible operation; the typed name, the server-side check and the activity record are the safeguards. An optional `PIERHEAD_PROTECTED_APPS` list is cheap to add later if a mistake ever gets close; not now. Effort: S.

### 3.3 Domains: add, remove, set

Story: point a hostname at an app, or take one away, without the CLI.

| Command | Verified behaviour |
| --- | --- |
| `domains:add <app> <d>...` | 1.3-1.7 s; rewrites nginx.conf and reloads nginx; containers untouched. Exit 0 for a duplicate ("Skipping: ... already added"). Accepts almost anything: `-h`, `bad`, a domain another app already serves (nginx then logs `conflicting server name ... ignored` and the first app keeps it). Only `http://x.y` is refused (exit 1). |
| `domains:remove <app> <d>...` | Same cost; exit 0 even when the domain was not set. |
| `domains:set <app> <d>...` | Replaces the list. `domains:clear` empties it (the app then answers on no hostname); `domains:reset` puts the default `<app>.<global>` back (2.4 s, two reloads). |
| `domains:report <app> --format json` | Already parsed. |

API: `{ op: "domains:add" | "domains:remove" | "domains:set"; app; domains: string[] }` (1 to 20 entries) and `{ op: "domains:reset"; app }`. Grammar (`shared/grammar.ts`): lowercase hostname, labels `[a-z0-9]([a-z0-9-]*[a-z0-9])?`, 1 to 253 characters, optional leading `*.`; no scheme, port, path, space or leading `-`. 409 `domain-in-use` when another app's `domains:report` already lists it (the all-apps report is one call and already cached for the list). `domains:remove` of a domain the app does not have is a 409 `conflict`, since Dokku would silently succeed.

UI: the Domains panel on the Domains & Network tab gets "Add domain" and a remove control per row (the default vhost is removable too, with a note). Reset appears only when the list is not the default. Each dialog shows the command and says "nginx reloads; the app keeps running".

Invalidation: app, list (domains are in the summary). Risks: on the lab host a hostname only works once Cloudflare routes it to the tunnel, which pierhead cannot do; the dialog says so. Effort: M (the grammar, the cross-app check, the panel rework).

### 3.4 Ports and proxy

Story: map a host port to a container port, and turn the proxy off for internal apps (several on the lab host are proxy-disabled and reached over their network alias).

| Command | Verified behaviour |
| --- | --- |
| `ports:add <app> <scheme:host:container>...` | 1.0 s, nginx rewrite and reload only; container CID unchanged. Exit 1 for a reused `scheme:host` ("The same scheme:host-port is being reused") and for malformed entries. `https:443:80` is accepted but ignored with a warning when no certificate exists; `tcp` and `udp` are stored but not served by the nginx template. |
| `ports:remove <app> <host-port \| full mapping>...` | Exit 0 even for a mapping that is not set. |
| `ports:set`, `ports:clear` | Replace or empty the map. With an empty map Dokku uses `ports-map-detected`. |
| `proxy:disable <app>` | Deployed: 20 s. Deletes nginx.conf, reloads, **redeploys the app** (new containers) and **clears the app's port map**; `ports-map-detected` reverts to `http:80:5000`. Never deployed: 0.9 s, exit 0, prints "App ... has not been deployed". |
| `proxy:enable <app>` | Deployed: 25 s, redeploys. The port map is not restored: nginx then upstreamed to 5000 and answered 502 until `ports:set <app> http:80:80`. |
| `proxy:build-config <app>` | 1.3-1.9 s. Regenerates nginx.conf and reloads; harmless, useful as "Rebuild proxy config". |
| `proxy:set <app> <type>` | Accepts any string (`caddy`). Not offered. |

Interplay, as Dokku 0.38 does it: `ports:*` only rewrites the nginx config; every `domains:*`, `ports:*`, `proxy:enable` and `proxy:build-config` ends in "Reloading nginx", so there is never a separate reload step to offer (`nginx:reload` works for the `dokku` user but is redundant). `proxy:disable` and `proxy:enable` are deploys, not config edits.

API: `{ op: "ports:add" | "ports:remove" | "ports:set"; app; mappings: PortMapping[] }` (scheme `http` or `https`, ports 1-65535, no duplicate `scheme:host`), `{ op: "ports:clear"; app }`, `{ op: "proxy:enable"; app; ports?: PortMapping[] }`, `{ op: "proxy:disable"; app }`, `{ op: "proxy:build-config"; app }`. The proxy operations stream when the app is deployed. `proxy:enable` with `ports` runs `ports:set` after a successful enable in the same operation, so the UI can offer "restore the previous mapping" in one step; the server reads `ports-map` before `proxy:disable` and stores it in the activity record, which is where the pre-fill comes from. `ports:remove` of a mapping not in `ports-map` is 409 `conflict`.

UI: Port mappings panel gets add and remove, with scheme select, two number fields, the warning for `https` ("no TLS on this host; Cloudflare terminates it; Dokku will ignore this mapping"). The Proxy panel's Enable/Disable becomes a button; its dialog says plainly that Dokku redeploys the app (about 25 s) and, for disable, that the port map is cleared and only domains or the network alias reach the app afterwards. A "Rebuild config" link sits under the panel.

*Implementation note (PR 1):* `proxy:disable` also empties the app's domains (Dokku 0.38 disables the domains plugin for it and `proxy:enable` brings back only the default vhost), so the server reads the live ports and domains before disabling, keeps both in memory (`AppDetail.proxyRestore`) and `proxy:enable` with `ports` and `domains` follows up with `ports:set` and `domains:set`. The disable dialog says so. Domain operations are unavailable while the proxy is off (Dokku answers 0 and saves nothing). Ports Dokku merely detected cannot be removed; the first change to such an app saves them as the explicit map with `ports:set`.

Invalidation: app, list (`proxyEnabled` is in the summary). Risks: a proxy toggle restarts a production app; an `https` mapping is a no-op here. Effort: M.

### 3.5 Scale processes

Story: run two web containers, or add a worker, from the Processes panel.

| Command | Verified behaviour |
| --- | --- |
| `ps:scale <app> --format json` | `[{"process_type":"web","quantity":1}]`. |
| `ps:scale <app> web=2` | Deployed: 39 s for 1 to 2 web (health checks per container), 14 s for a new type; streams deploy output. Never deployed: 0.3 s, formation only. Exit 1 with a message for `web=-1`, `web=abc`, missing count. Any process type is accepted: `worker=1` on an image app started a container running the image's default command. |
| `ps:scale --skip-deploy <app> web=1` | 0.3 s, formation only. A later `ps:scale web=1` is then a no-op, so the extra container keeps running until a restart or rebuild. |
| `ps:scale --clear <app>` | Back to the default (`web=1`). |

API: `{ op: "ps:scale"; app; formation: { type: string; count: number }[]; skipDeploy: boolean }`. Grammar: `isProcessType`, count 0-20, at least one entry. Streams when the app is deployed and `skipDeploy` is false. The current formation becomes part of `AppDetail` (`formation`), read with one more call in `getApp`.

UI: a count stepper per process type in the Processes panel plus "Add process type"; one Apply dialog listing the changes and the command, with a "skip deploy" toggle whose help text names the out-of-sync consequence. Disabled while `deploying` or when `ps:report` says `can-scale: false`.

Invalidation: app, list (`processCount`). Risks: scaling redeploys; unknown types start junk containers, so the UI only offers types from the current formation plus a free-text add that warns. Effort: M.

### 3.6 Networks

Story: create a network, attach an app to it (and name its alias), destroy an unused one.

| Command | Verified behaviour |
| --- | --- |
| `network:create <name>` | 0.3 s. Exit 1 when it exists ("network with name ... already exists"). |
| `network:destroy --force <name>` | 0.4 s. **No in-use check**: it destroyed a network an app named in `initial-network`; only Docker refuses when a container is connected (*unverified*). Exit 1 "network ... not found" for a missing one. |
| `network:set <app> <prop> [<net>...]` | Props `attach-post-create`, `attach-post-deploy`, `initial-network` (also `bind-all-interfaces`, `static-web-listener`, `tld`, not offered). 0.3 s; accepts non-existent networks; several values for `attach-*`; no value clears. **Takes effect on the next deploy**: the running container stayed on `bridge` after `network:set` and after `network:rebuild`. |
| `docker-options:add <app> deploy "--network-alias <alias>"` | 0.3 s. No validation, duplicates allowed (the seeded `hello` carries nine identical `--label` options). `docker-options:report --format json` has `deploy-list` as an array; `docker-options:remove` takes the same string. Applies on the next deploy. |

API: `{ op: "network:create"; network }`, `{ op: "network:destroy"; network; confirm }` (409 `in-use` when the cached networks list has members), `{ op: "network:set"; app; property: NetworkAttachment; networks: string[] }` (every name must exist in `network:list`), `{ op: "network:alias"; app; alias: string | null }` (DNS label; implemented as remove-old then add on `deploy`). Network grammar: `[a-z0-9][a-z0-9_.-]{0,62}`.

UI: Networks page gets "Create network" and a Destroy per panel, disabled with the reason while members exist. The app's Attached networks panel becomes editable: a select per attachment kind, an alias field, and a banner "applies on the next deploy or restart" after a change. Reading the alias back is a parser change: `parseNetworks` gets `docker-options:report` and fills `alias` from `--network-alias` entries (today always null).

Invalidation: networks, app, list. Risks: an app whose `initial-network` points at a destroyed network fails to deploy; the member check prevents the common case. Effort: M.

### 3.7 Builder settings

Story: tell Dokku which directory of a monorepo to build (several lab apps use `build-dir`) and which builder to use.

| Command | Verified behaviour |
| --- | --- |
| `builder:set <app> build-dir <dir>` | 0.3 s; accepts `../etc`. No value clears. Applies on the next build. |
| `builder:set <app> selected <builder>` | Accepts `nope`. Installed builders (from `plugin:list`): `dockerfile`, `herokuish`, `pack`, `nixpacks`, `railpack`, `lambda`, `null`. Invalid property names are refused (exit 1) with the valid list. |
| `builder-dockerfile:set <app> dockerfile-path <path>` | Works the same; worth offering next to build-dir. |

API: `{ op: "builder:set"; app; property: "build-dir" | "selected" | "dockerfile-path"; value: string | null }`. Grammar: relative path of `[A-Za-z0-9._/-]` segments, no `..`, no leading `/`; builder from the fixed list. Not streamed.

UI: Settings tab (new; this is its first panel), "Build" with the current values from `builder:report` and `builder-dockerfile:report`, Edit per row, a "takes effect on the next build" note and a Rebuild link.

Invalidation: app, list (`build` is in the summary). Risks: none at write time; a wrong dir fails the next build visibly. Effort: S.

### 3.8 Deploy from an image or a git URL

Story: deploy a public image, or clone a repository and build it, for apps that are not pushed from CI.

| Command | Verified behaviour |
| --- | --- |
| `git:from-image <app> <image>` | 25 s for a cached `nginx:alpine`, streaming build and deploy output. A bad image fails in under 1 s: exit 1 "Failed to pull image". `git:report` afterwards has `source-image` and a synthetic sha. |
| `git:sync [--build] <app> <url> [<ref>]` | Clone without build: 1.5 s, sets `deploy-branch` from the detected branch, `git:report` then has the real sha. Bad host: exit 128 in 0.7 s with git's message. `file:///etc` and `/etc` are passed to git untouched (git refused them only because they are not repositories). `--build` then builds like a push (*unverified* locally: a buildpack build pulls a large builder image). |
| `git:set <app> deploy-branch <b>` | 0.3 s. |

API: `{ op: "git:from-image"; app; image }` and `{ op: "git:sync"; app; url; ref?: string; build: boolean }`, both streamed. Image grammar: `[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]{1,128})?(@sha256:[a-f0-9]{64})?`. URL grammar: `https://` or `ssh://` or `git@host:path`, no userinfo (`user:token@` would land in the log and in Dokku's output), no `file:`, no local path; ref `[A-Za-z0-9._/-]+` not starting with `-`. Private repositories are out of scope (Dokku's `git:auth` is the tool for that).

UI: Settings tab, "Deploy source" panel showing `git:report` (source image or sha, branch). Two buttons: "Deploy image" and "Sync from git" (with a "build now" toggle, default on). Both open the streaming panel ActionHost already has. For an app that has never been deployed, the Overview also links here.

Invalidation: app, list, builds (3.13), after the stream ends. Risks: a deploy replaces the running containers; it is the point. Effort: M.

### 3.9 Storage

Story: give an app a persistent directory.

| Command | Verified behaviour |
| --- | --- |
| `storage:create <name> [--chown heroku\|herokuish\|packeto\|root\|false] [--mode 0755]` | 0.3 s, creates `/var/lib/dokku/data/storage/<name>`; `--chown heroku` sets 1000:1000. `storage:ensure-directory` still works but prints a deprecation. |
| `storage:mount <app> <host-dir>:<container-dir>` | 0.3 s. No validation (a relative host dir was accepted). Registers a hidden `legacy-<hash>` entry per host path that survives `storage:unmount` and must be removed with `storage:destroy`. Exit 1 "Mount path already exists." for a duplicate. Applies on the next deploy or restart (the running container's mounts were unchanged). Flags: `--phase`, `--process-type`, `--volume-readonly`, `--volume-subpath`; the readonly flag did not register in the legacy form (*unverified* in the named-entry form). |
| `storage:unmount <app> <host-dir>:<container-dir>`, `--all` | Exit 1 "Mount path does not exist." for a mount that is not set. |
| `storage:list <app> --format json` | `[{entry_name, host_path, container_path}]`; `storage:report` adds `attachment.N.*` keys (phases, process type, readonly). |
| `storage:destroy <name> --force [--destroy-host-dir]` | 0.3 s; destroyed an entry whose path was still mounted (legacy form), contrary to the help text. |

API: `{ op: "storage:mount"; app; name; containerPath }` runs `storage:create <name>` when the entry does not exist, then `storage:mount <app> /var/lib/dokku/data/storage/<name>:<containerPath>`. Host paths are never free text: pierhead only mounts directories under Dokku's storage root, named `[a-z0-9][a-z0-9._-]{0,62}`; container path absolute, `[A-Za-z0-9._/-]`, no `..`. `{ op: "storage:unmount"; app; name; containerPath; confirm }` (confirm is the container path). The host directory is never deleted from the UI.

UI: Settings tab, "Storage" panel listing mounts from `storage:list`, Add and Remove, and a fixed note: "Persistent data lives in `/var/lib/dokku/data/storage/<name>` on the host and is not in Dokku's app state. Add new directories to the lab backup (homelab repo) before relying on them." The dialog repeats that mounts apply on the next restart and offers a Restart link afterwards.

Invalidation: app. Risks: data on disk outliving the app (by design; the destroy dialog says so). Effort: M.

### 3.10 Resource limits

| Command | Verified behaviour |
| --- | --- |
| `resource:limit [--process-type t] --memory 256m --cpu 0.5 <app>`; `resource:reserve ...` | 0.3 s. No validation: `--memory lots`, `--cpu -1` were stored (the next `docker run` would fail). Applies on the next deploy (the running container's `HostConfig.Memory` stayed 0). |
| `resource:limit-clear [--process-type t] <app>`, `resource:reserve-clear` | Clear per type. |
| `resource:report <app> --format json` | Keys `_default_.limit.memory`, `web.limit.memory`, `_default_.reserve.memory`, ...; `{}` when nothing is set. |

API: `{ op: "resource:set"; app; kind: "limit" | "reserve"; processType: string | null; memory?: string; cpu?: string }` and `{ op: "resource:clear"; app; kind; processType }`. Grammar: memory `[0-9]+[bkmg]`, cpu `[0-9]+(\.[0-9]+)?` at most two decimals; `memory-swap`, `network-*` and `nvidia-gpu` are not offered.

UI: Settings tab, "Resources" panel; a table per process type with limit and reservation, Edit per row, and "applies on the next deploy". Effort: S.

### 3.11 SSH keys (list only)

`ssh-keys:list --format json` works and is already shown on the Host page (name and fingerprint; the JSON also carries `public-key`, which the parser drops and must keep dropping). `ssh-keys:add` and `ssh-keys:remove` exit 1 "This command must be run as root" over SSH, as does `plugin:install`.

Offering add and remove would need a second path to the host: a dedicated unix user with a `NOPASSWD` sudoers rule limited to `/usr/bin/dokku ssh-keys:add *` and `ssh-keys:remove *`, a second key in pierhead and a second runner in `server/dokku.ts` for exactly those two commands. That widens pierhead's blast radius from "the dokku user" to "a sudo rule", so it should wait for a real need. The Host page keeps the list and says why there is no Add button. Effort: S for the note; the sudo route is M plus homelab changes.

### 3.12 Rename and clone

| Command | Verified behaviour |
| --- | --- |
| `apps:rename [--skip-deploy] <old> <new>` | Deployed: 29 s. Creates the new app, destroys the old one, rebuilds from the stored source and redeploys; streams. Config, port map, formation and build records came along; custom domains are *unverified* (the throwaway only had the default, which was re-derived as `<new>.<global>`). Exit 1 "Name is already taken" when the target exists. |
| `apps:clone [--skip-deploy] [--ignore-existing] <src> <new>` | With `--skip-deploy`: 1.8 s. Copies config (including `GIT_REV`), ports, formation, git source and sha; domains reset to the default; `deployed: false` until the first deploy. Without the flag it deploys (*unverified*, same path as rename). |

API: `{ op: "apps:rename"; app; newName; skipDeploy: boolean }` and `{ op: "apps:clone"; app; newName; skipDeploy: boolean }`. 409 `exists` when `newName` is taken. Streamed unless `skipDeploy`.

UI: Settings tab, Danger zone, above Destroy. The rename dialog says the app is redeployed, that the default domain changes and that custom domains must be checked afterwards; the clone dialog defaults to "skip deploy" and navigates to the new app. Rename is the one operation that invalidates two apps.

Invalidation: list, networks, both apps, both builds. Effort: S once the framework exists.

### 3.13 Activity log

The brief assumed Dokku keeps no deploy history. Dokku 0.38 ships a core `builds` plugin that does: `builds:list <app> --format json` returns the last 20 builds and deploys per app (`id, kind: build|deploy, source` such as `git:from-image`, `ps:rebuild`, `config-redeploy`, `ps:restart`, `started_at, finished_at, status, exit_code, duration, log_path`); `builds:info <app> <id>` and `builds:output <app> <id>` give details and the log. Quirks: `builds:list` without an app lists running builds only, so history is one call per app; failed records are finalised by the next build and can carry odd durations; a record is created before the app name is validated.

Two sources, one feed:

1. Dokku builds, read on demand: `GET /api/apps/:name/builds` (cached 5 s under `cacheKeys.builds(name)`) fills the Overview's "Deploy history" panel, which exists for the mock and is hidden for the API today.
2. Pierhead's own record of every operation attempt, since Dokku does not log domains, ports, config or destroys: an append-only JSONL file in `PIERHEAD_STATE_DIR` (default `/var/lib/pierhead`, the volume production already mounts for `known_hosts`), one line per attempt `{ at, op, app?, args (never a config value), actor, outcome, tookMs }`, rotated at 10 000 lines. Unset or unwritable dir: an in-memory ring of 500 and a startup log line. `GET /api/activity?limit=50` returns the newest entries merged with the builds of every app (one `builds:list` per app, in parallel, cached). The `Activity` union in `shared/types.ts` gains `{ kind: "operation"; ... }` and `{ kind: "build"; ... }` and loses the mock-only `backup` member once the fixtures move.

UI: the Overview's right column in API mode (today only the apps list renders), the Activity page and its nav entry, and the app Overview's Deploy history. Effort: M. Depends on the framework (every operation records through one function).

### 3.14 Global settings

Last, because they change every app's defaults: `domains:add-global`, `domains:remove-global`, `domains:set-global` (0.3 s each, verified add and remove) and `git:set --global deploy-branch <b>` (verified set and unset; `builder:set --global` also exists). Changing the global domain does not rewrite existing apps' vhosts until their next deploy or `domains:reset` (*unverified*).

API: `{ op: "domains:global"; domains: string[] }`, `{ op: "git:deploy-branch"; branch: string | null }`. Invalidation: everything (the host cache and every app). UI: Edit on the Host page rows, with a confirm that lists the apps using the default domain. Effort: S.

### 3.15 Services

Story: see and manage the datastores Dokku runs for apps (postgres, redis, any plugin built on the dokku-service template), and link them to apps, without the CLI.

| Command | Verified behaviour (Dokku 0.38.31, postgres and redis plugins 2.2.0) |
| --- | --- |
| `<type>:info [<name>] --format json` | Without a name: one JSON object per service, one line each; with none, `{"message":"There are no <type> services"}` and exit 0. Keys include `service`, `status` (`running`, or `missing` when stopped), `version` (`image:tag`), `links` (comma-joined apps), `exposed-ports` (`-` or `5432->46761`), `data-dir`, `id`, `dsn` and `exposed-dsn`, **both with the password**. 0.4 s. `--dsn` prints just the connection string. |
| `<type>:list`, `<type>:links`, `<type>:app-links`, `<type>:exists` | Work, but `info` carries all of it in one call per plugin, so pierhead uses only `info`. `list --format json` is `["a","b"]`. |
| `<type>:create <name> [--image-version <tag>]` | 1 s with the image cached, 24 s for the first postgres (the default image is `timescale/timescaledb`, about 1 GB). Prints the info, password included. An unknown tag fails after the pull attempt and leaves nothing behind. Dokku accepts `Bad_Name` and one-letter names. |
| `<type>:destroy <name> --force` | 1 s. Without `--force` it prompts for the name and fails without a tty. Refuses while an app is linked, naming it. |
| `<type>:link <name> <app> [--no-restart]` | Sets `DATABASE_URL`, `REDIS_URL` or `DOKKU_<TYPE>_<COLOR>_URL` (when taken, also for an existing variable of the app) and a `--link` docker option; prints the URL. Restarts a running app (23 s, a `config-redeploy` build record), leaves a stopped one alone, `--no-restart` skips it. Exit 1 "Already linked". |
| `<type>:unlink <name> <app> [--no-restart]` | Same cost; unsets the variable. |
| `<type>:start`, `stop`, `restart` | 1 s; `stop` makes `info` say `missing`. |
| `<type>:logs <name> [--tail=N]` | Without the flag the last 100 lines and exit; `--tail=N` replays N and follows (`--tail N` is refused, `-t` replays 100). |
| `<type>:export <name>` | The dump on stdout (`PGDMP`, 10 KB for an empty database; `REDIS0015`), warnings on stderr. |
| `<type>:expose` | Fails for the `dokku` user (Docker socket permission). Not offered. `plugin:install` needs root, so the plugins are installed by `scripts/dev.sh` through `docker exec`. |

Discovery: `plugin:list` entries that are enabled, not core and describe themselves as a `service plugin`; the type is a validated argv element (`^[a-z][a-z0-9-]{1,20}$`) and the allowlist builds `<type>:<verb>` only for the installed ones, so core namespaces such as `nginx` or `apps` never reach it. The namespace is the plugin's name in `plugin:list`, which is the `--name` it was installed with, so a plugin installed under a different name than its repository's own still works, but only if that name fits the grammar and its description says "service plugin"; anything else is simply not listed.

API: reads `GET /api/services`, `GET /api/services/:type/:name`, `.../dsn` (the only place the connection string is returned; `no-store`, never logged), `.../logs` (SSE) and `POST .../export` (download; a privileged action behind the write switch and a custom header, one at a time per service, 409 `unavailable` for a stopped one). Operations `service:create|destroy|link|unlink|start|stop|restart`; 400 `unknown-type`, 404 for a service or app, 409 `exists`, `in-use` (destroy while linked), `conflict` (link twice, unlink what is not linked), `unavailable` (start a running service...). `AppDetail.services` lists `{ type, name }`, filled from the same batched read. Every line of Dokku output is masked for `scheme://user:password@`, since create and link print the connection string.

UI: a Services page grouped by plugin (status, masked connection string with Reveal and copy, linked apps with unlink, Start, Stop, Restart, Link, Logs, Export, Destroy with the typed name), a Services panel on the app's Domains & Network tab, palette entries. Every create dialog says the service is not in the lab backup.

Invalidation: the services read, plus the app's reads for a link or unlink. Risks: link restarts a production app; destroy deletes data (typed name, refused while linked). Effort: M.

## 4. Cross-cutting design

### Operations table

`shared/actions.ts` is a table keyed by action id with the command and a `streams` flag; `shared/operations.ts` generalises it and start, stop, restart and rebuild move in as the first four rows (the `/actions/:action` route goes; the UI is its only client). Sketch:

```ts
// shared/operations.ts
export type OperationRequest =
  | { op: "ps:start" | "ps:stop" | "ps:restart" | "ps:rebuild"; app: string }
  | { op: "apps:create"; app: string }
  | { op: "apps:destroy"; app: string; confirm: string }
  | { op: "domains:add" | "domains:remove" | "domains:set"; app: string; domains: string[] }
  | { op: "ports:add" | "ports:remove" | "ports:set"; app: string; mappings: PortMapping[] }
  | { op: "proxy:enable"; app: string; ports?: PortMapping[] }
  | { op: "ps:scale"; app: string; formation: Formation; skipDeploy: boolean }
  | { op: "network:destroy"; network: string; confirm: string }
  // ...one member per operation in section 3
  ;

export type OperationId = OperationRequest["op"];
type Of<K extends OperationId> = Extract<OperationRequest, { op: K }>;

type OperationDef<K extends OperationId> = {
  /** Narrows an unknown body; a string is the reason it was refused (400). */
  parse: (body: unknown) => Of<K> | string;
  /** argv after `dokku`, from validated args; the server runs it, the dialog prints it. */
  command: (req: Of<K>) => string[];
  /** Streams SSE when true (or when the function says so for this app's state). */
  streams: boolean | ((req: Of<K>, app: AppSummary | null) => boolean);
  /** Which `confirm` field must equal which value, if any. */
  destructive?: (req: Of<K>) => string;
  /** What to drop from the read cache afterwards. */
  invalidates: (req: Of<K>) => { apps: string[]; host?: boolean } | "all";
  availability?: (app: AppSummary) => Availability;
};

export const operations: { [K in OperationId]: OperationDef<K> } = { /* ... */ };
export const commandLine = (req: OperationRequest) =>
  ["dokku", ...operations[req.op].command(req as never)].join(" ");
```

Body narrowing stays hand-written like `parseConfigSetBody`, with a 40-line `shared/fields.ts` (`str`, `int`, `bool`, `list`, `oneOf`) so each `parse` is a few lines; zod would be the first runtime dependency in `shared/` and is not worth it for thirty entries. Grammars (`isDomain`, `isPortMapping`, `isNetworkName`, `isBuildDir`, `isImageRef`, `isGitUrl`, `isStorageName`, `isMemory`, `isCpu`) live in `shared/grammar.ts` next to the config grammar in `shared/config.ts`.

### Server

`server/dokku.ts`: new entries in `commands`, each validating its free-form args and quoting them, as `config:set` does. Two helpers keep the entries short: `appArg` exists; add `netArg`, `domainArg` and the like, each a one-liner that throws on a grammar miss.

`server/index.ts`: one route, `POST /api/operations/:op`. In order: `isOperationId`; write gate; `operations[op].parse(body)` (400); existence checks (`apps:exists` for the target, `network:list` for networks, cross-app checks for domains); `destructive` confirm (400 `confirm-mismatch`); run or stream through the existing paths (`dokku(...)` with a per-command timeout, `dokku.stream(...)` with the SSE loop rebuild uses); invalidate; `logOperation`; `recordActivity`. Multi-step operations (`storage:mount` creating the entry first, `proxy:enable` restoring ports) are the only ones where the route runs two commands, each still from the allowlist; the dialog shows both lines. A failure in step two is reported as such and recorded.

Reads that the UI needs for the new panels, each one allowlisted report added to `getApp` and parsed in `shared/parse.ts`: `ps:scale --format json`, `storage:list --format json`, `resource:report`, `docker-options:report` (aliases), `builder-dockerfile:report`, plus `builds:list <app> --format json` behind its own route and cache key.

### Frontend

`ActionHost` already owns one `<dialog>`, a confirm form, a streaming panel and the writes context. It becomes `OperationHost`: `request(draft)` takes a partial `OperationRequest`; the dialog renders the fields a per-operation UI definition in `src/api/operations.ts` declares (label, effect, tone, pending and done wording, and a `fields` list from a small set: text, number, select, toggle, string list, port-mapping rows, confirm-name). The command line re-renders from `commandLine(current)` as the user types, as `ConfigDialog` does with the masked value. `ConfigDialog` stays as it is; its masking rule is a reason not to force it through the generic form.

New surfaces: a "New app" button (AppsList), editable panels on the Domains & Network tab, a stepper in Processes, a Settings tab (`src/pages/app/SettingsTab.tsx`: Build, Deploy source, Resources, Storage, Danger zone), Create and Destroy on the Networks page, Edit rows on the Host page, the Activity page and the Overview's activity column in API mode. The command palette offers the non-destructive operations only.

Reused as is: the writes context and read-only badge, the SSE reader in `src/api/backend.ts`, the toast, `Panel`/`EmptyNote`/`Mono`, the TanStack invalidation on settle. New: the field renderer, the Settings tab, the activity recorder and reader, the grammars and parsers.

### Tests

- Parsers with fixtures in `shared/fixtures/`: `ps-scale.json`, `builds-list.json`, `storage-list.json`, `resource-report.json`, `docker-options-report.json` (captured from the local Dokku).
- `shared/operations.test.ts`, table-driven like `actions.test.ts`: every id has a UI definition (`satisfies Record<OperationId, ...>` makes a missing one a type error); for each operation one valid request builds the expected argv and `commandLine` equals that argv joined (the dialog cannot lie); a list of invalid requests is refused with a reason (`bad domain`, `-h`, `../etc`, `lots`, `file:///etc`, `user:pw@host`); destructive operations name their confirm value.
- Grammar tests for each `is*`, with the cases Dokku accepted and should not have.
- `server/activity.test.ts`: append, read newest-first, rotation, fallback to memory, never a config value.
- No endpoint tests, as today; the route is thin and its parts are covered.

## 5. Phasing

*Implementation note (PR 1):* the activity recorder is not part of it, so the map `proxy:disable` clears is kept in server memory (returned as `AppDetail.previousPorts`) instead of in the activity record, and the Settings tab exists with only the Danger zone until PR 2. (PR 3 moved it into the state directory, `proxy-restore.json`, so it survives a restart.) The Caddy `basic_auth` README note is also still open.

*Implementation note (PR 2):* aliases are two operations, `network:alias-add` and `network:alias-remove` (not `network:alias`), so each builds its command without reading state; `AppDetail.aliases` lists them and `AppNetwork.alias` stays null since an alias applies to every network. `builder:set` also covers `dockerfile-path` (it runs `builder-dockerfile:set`), resources use `resource:set`/`resource:clear` with a blank memory or cpu left alone, `storage:mount` runs `storage:create` then `storage:mount`, and `ps:scale` is refused for a never-deployed app. `network:destroy` also refuses networks Dokku did not create, and Docker still refuses (502) while a running container is connected.

*Implementation note (PR 3):* `git:from-image` takes no flags (0.38 has none for it) and `git:sync` offers only `--build`. The URL grammar is `https://host/path` or `git@host:path` only (no `ssh://`, `git://`, `http://`, `file:` or local path, no userinfo, query or fragment). The Dokku host fetches the URL itself, with its own network access and keys: pierhead sends no credentials and filters no hosts, so a URL only the host can reach works, and a private repository works only if the host already holds credentials for it; the dialog says so. Refs also refuse git's own forbidden forms (a segment starting with `.` or ending in `.` or `.lock`). A `git:sync --build` whose build fails leaves Dokku's deploy lock held (verified), after which every operation is refused `deploy-in-progress`; `apps:unlock` (Settings, "Release lock", named in the refusal) clears it, only while the lock exists and `builds:list` has no running record. Records of builds that died keep `status: running` with `display_status: abandoned`, which the parser reads. The deploy branch is a `git:set` operation (`{ app, branch }`, empty clears) on the Build panel, and the Deploy source panel on Settings holds the two deploy buttons (the Overview of a never-deployed app links there). `builds:list` has no sha or image (they stay on the Settings tab, from `git:report`), so the history shows `kind`, `source`, status and times. Verified: proxy toggles, `ps:scale` and `ps:stop` leave no build record, `ps:start` and `ps:restart` leave a `deploy` one, a `git:sync` with `--build` a `build`; a running record has no `finished_at` or `exit_code`. State: `PIERHEAD_STATE_DIR` defaults to `.dev/state` and the image sets `/var/lib/pierhead` (the existing volume mount, not a new `state/` dir); alongside `activity.jsonl` (cap 2000, not 10 000) sits `proxy-restore.json` instead of a field on the activity record, since rotation would drop it; config changes are recorded too (op `config:set` or `config:unset`, the message is the key). `GET /api/activity` folds a Dokku record into the latest pierhead operation that had started when the record did (else the earliest within 10 s after it), only for operations that leave records, and for a config change only when it restarted (`restart` in the log); build records are cached 60 s; the `Activity` union is `operation` (with `builds: id[]`) or `build`, and `backup` left it (the mock's backup tile reads `BackupStatus`).

*Implementation note (PR 4):* custom domains survive a rename (verified: the old default vhost becomes `<new>.<global>` and the others are kept verbatim, so nothing is restored), and stay off a clone, which gets only its default vhost; a clone copies config, ports, network settings, proxy settings, storage mounts, docker options (aliases too), resource limits and scaling. A rename without `--skip-deploy` starts a stopped app and with it leaves a deployed one not running until `ps:start`; a never-deployed app is renamed or cloned with no deploy either way. `apps:clone` does not offer `--ignore-existing`, since the route already answers a taken name with 409 and the flag would hide a lost race behind exit 0. Rename also needs the old name typed. The rename and clone log rows have `app: null` and `target: "old -> new"` (the old name no longer exists to link to), and a rename moves the saved proxy-restore entry (also after a failed redeploy, swapping the old default vhost of every global domain), may take one of its own custom domains as the new name, and a failed rename or clone sends the UI to the app that exists. The log record carries `newName`, so the Activity filter by the new app finds it and the redeploy record is folded into it. A global domain add, remove or set changes nothing on existing apps (not on a rebuild either; `domains:reset <app>` regenerates one), removing the last one is allowed and leaves new apps without a vhost, and an app that sets no deploy branch follows `git:set --global deploy-branch` at once. The global ops are `domains:add-global|remove-global|set-global` and `git:set-global`; they take no deploy lock (no app is touched), 409 the no-ops Dokku answers with exit 0 (every one of them, the branch included), and invalidate the host read and every app's. `GET /api/host` gains `globalDeployBranch` (the set value; `deployBranch` stays the computed one, `master` by default). The Host page's SSH keys panel carries the root-only note.

| PR | Delivers | Size |
| --- | --- | --- |
| 1. Framework and routing | `shared/operations.ts` with the four existing actions moved in, `POST /api/operations/:op`, `OperationHost` and the field renderer, the activity recorder (file plus memory, no UI yet), create app, destroy app, domains, ports, proxy enable/disable/build-config, README section and the Caddy `basic_auth` note. Ships only after the Caddyfile change is live. | L |
| 2. App settings | Settings tab: builder, resources, storage; scale in Processes; networks create/destroy/attach/alias with the alias parser. | M |
| 3. Deploys and activity | `git:from-image`, `git:sync`, `builds` reads, `GET /api/activity`, Activity page and Overview column in API mode, app Deploy history. | M |
| 4. Rename, clone, global | Danger zone rename and clone, Host page edits for global domain and deploy branch, the SSH keys note, palette entries, docs. | S |

Each PR keeps mock mode working (fixtures gain the new shapes) and leaves the local stack usable for the next one: everything above was exercised there with `apps:create pierhead-doc-tmp ... apps:destroy --force pierhead-doc-tmp`, and the seeded state (`hello`, `hello-multi`, `hello-stopped`, `hello-new`, `hello-net`) is what the tests of the next PR assume.
