<img src="assets/icon.svg" width="64" height="64" alt="">

# pierhead

A dashboard for a single self-hosted [Dokku](https://dokku.com) host. Apps are the vessels, pierhead is where you log them in and out: host health, app status, deploys, logs, config, domains and networks in one dense, calm console. Dark theme first, light theme through the same tokens.

## Architecture

One Bun process runs a Hono server (`server/index.ts`). It talks to Dokku by running `ssh dokku@<host> <command>` from a typed allowlist (`server/dokku.ts`; all calls share one SSH control connection) and reads host metrics from [Glances](https://nicolargo.github.io/glances/) over HTTP. The React UI (`src/`) calls `/api/*`: in development through Vite's proxy, in production from the same process that serves the built UI. Types and the parsers that turn Dokku and Glances output into them live in `shared/`, used by both sides.

```
browser ── /api/* ──> Hono (Bun) ── ssh ──> dokku on the host
                           └──── HTTP ────> Glances on the host
```

## Data sources

The UI reads either fixtures or the backend, chosen at build time by `VITE_DATA_SOURCE`:

- `mock` (the default; no backend or Docker needed): everything is fixtures, and actions only toast the command.
- `api` (set by `compose.yaml`, `scripts/lab.sh` and the production image): the UI reads the backend.

| In `api` mode | Source |
| --- | --- |
| Apps list and app overview (status, processes, build, restart policy, proxy, domains, ports, networks, revision); SSH host and Dokku version in the sidebar | Dokku reports over SSH |
| Logs tab: recent lines, then new lines as they happen | `dokku logs --tail` streamed as server-sent events (`GET /api/apps/:name/logs`) |
| Config tab: variable names, one value on Reveal, set and unset | `config:keys`, `config:get`, `config:set`, `config:unset` (see "Config vars") |
| Host strip: CPU, memory and disk meters and sparklines; OS, kernel, cores, memory, uptime | Glances, when `GLANCES_URL` is set; otherwise a "Metrics not connected" state |
| Networks page: Docker networks, the apps attached to each and how (`GET /api/networks`) | `network:list` plus the all-apps `network:report` |
| Host page: Dokku version, global domain, proxy, scheduler, builder, deploy branch, plugins, SSH key names and fingerprints, pierhead's own config (`GET /api/host`) | `version`, five `--global` reports, `plugin:list`, `ssh-keys:list` |
| Start, Stop, Restart, Rebuild, set/unset config vars | Dokku, when writes are enabled (see below); refused otherwise |
| Deploy history, activity, backups | Not shown (no source yet); the Activity page is hidden from the nav |

## Scripts

```sh
bun install
bun run dev        # Vite UI only; mock data unless VITE_DATA_SOURCE=api
bun run dev:server # API server with --watch (needs the DOKKU_SSH_* env, see "Configuration")
bun run dev:up     # local Docker stack, see "Local test environment"
bun run lab        # read-only run against the real host, see "Running against the lab host"
bun run typecheck  # tsc --noEmit
bun run lint       # biome check
bun run format     # biome check --write
bun run test       # bun test
bun run build      # typecheck, then production build of the UI
```

CI (`.github/workflows/ci.yml`) runs typecheck, lint, test and build on every pull request and on `main`.

## Local test environment

A throwaway Dokku (`dokku/dokku:0.38.31`), Glances and the pierhead dev stack, all in Docker. Nothing leaves your machine.

```sh
bun run dev:up     # generate dev key, start Dokku, register key, seed apps, start pierhead
bun run dev:down   # stop containers, keep data
bun run dev:reset  # destroy Dokku apps, remove containers, volumes and hello-net, forget host key
```

`dev:up` is idempotent. Ports (localhost only):

| URL | What |
| --- | --- |
| http://localhost:5173 | Vite dev UI (proxies `/api` to the API) |
| http://localhost:3001/api/health | API; returns the Dokku version fetched over SSH |
| http://localhost:61208/api/4/status | Glances (host metrics source) |
| http://localhost:8080 | Dokku nginx; sample app: `curl -H 'Host: hello.dokku.localhost' http://localhost:8080` |

Dokku's SSH port is not published; the `pierhead-dev` container reaches it as `dokku@dokku:22` over the compose network. Writes are enabled there (`PIERHEAD_ALLOW_WRITES=true`), since this Dokku is disposable.

Seeded apps: `hello` (running, a few fake config vars), `hello-stopped` (deployed, then stopped), `hello-multi` (two domains, port mapping `http:8081:80`), `hello-new` (never deployed), all from `nginx:alpine`. The network `hello-net` is attached to `hello` (`attach-post-deploy`) and `hello-multi` (`initial-network`).

What gets created: containers `pierhead-dokku`, `pierhead-glances`, `pierhead-dev` and the apps' sibling containers (`hello.web.1` and so on, labelled `pierhead.dev=1`); the Docker network `hello-net`; volumes `pierhead_dokku-data` and `pierhead_node-modules`; and the gitignored `.dev/` directory with the dev SSH keypair (`.dev/ssh`) and `known_hosts` (`.dev/state`). The first start takes a bit longer while `bun install` fills the `node_modules` volume.

Docker-in-Docker notes: Dokku talks to the host Docker socket, so apps are sibling containers. Dokku passes `DOKKU_HOST_ROOT` / `DOKKU_LIB_HOST_ROOT` to the daemon as bind-mount sources, so they must be paths on the daemon's filesystem. `compose.yaml` stores Dokku's data in a named volume and points both at that volume's `_data` directory (`/var/lib/docker/volumes/...`), which exists inside OrbStack's VM. On Docker Desktop or native Linux the same paths work; only a bind mount from a macOS path would break.

## Running against the lab host (read-only)

Runs pierhead from your machine, outside Docker, against a real Dokku host. It never writes: the script unsets `PIERHEAD_ALLOW_WRITES`, so actions and config changes answer `403 writes-disabled` (and the UI shows the read-only badge).

```sh
cp .env.lab.example .env.lab   # gitignored; host, port, user, key and known_hosts paths, no secrets
bun run lab                    # Ctrl-C stops both processes
```

| URL | What |
| --- | --- |
| http://localhost:5174 | Vite UI, `VITE_DATA_SOURCE=api` |
| http://localhost:3002/api/health | API |

The ports differ from the Docker stack's (5173, 3001), so both can run at once; the script points Vite's proxy (`API_URL`) at 3002. `GLANCES_URL` is commented out in the example; set it to the Glances container on the host (`http://192.168.2.13:61208`) for live host metrics.

## Configuration

Server environment:

| Variable | Default | Does |
| --- | --- | --- |
| `DOKKU_SSH_HOST`, `DOKKU_SSH_KEY`, `DOKKU_SSH_KNOWN_HOSTS` | required (the image sets `DOKKU_SSH_KNOWN_HOSTS=/var/lib/pierhead/known_hosts`) | SSH target, private key path, `known_hosts` path |
| `DOKKU_SSH_PORT`, `DOKKU_SSH_USER` | `22`, `dokku` | |
| `DOKKU_SSH_TIMEOUT_MS` | `10000` | Default per-command timeout (actions and config writes get 120 s) |
| `PIERHEAD_ALLOW_WRITES` | unset (read-only) | Only the literal `true` allows actions and config changes |
| `PIERHEAD_CACHE_TTL_MS` | `5000` | Read cache lifetime; `0` turns it off |
| `GLANCES_URL` | unset (metrics off) | Glances base URL, e.g. `http://glances:61208` |
| `PIERHEAD_STATIC_DIR`, `NODE_ENV` | unset | Serve the built UI from this directory, or from `dist/` when `NODE_ENV=production` |
| `PORT` | `3001` | API port |

The server checks these at startup and exits with a readable message when one is missing or malformed. For the UI, `VITE_DATA_SOURCE` picks the data source and `API_URL` (default `http://127.0.0.1:3001`) is the Vite proxy target.

## App actions and the write switch

`POST /api/apps/:name/actions/:action` runs `ps:start`, `ps:stop`, `ps:restart` or `ps:rebuild` (the table is `shared/actions.ts`). The server refuses with `403 writes-disabled` unless it was started with the literal `PIERHEAD_ALLOW_WRITES=true`; the default is read-only, and `GET /api/health` reports `writesEnabled`. Never set it for a real host without meaning to.

- start, stop, restart answer `{ ok: true, output }` once Dokku is done (about 25s for start and restart, 1s for stop). Dokku exits 0 when it did nothing (start on a running app, anything on a never-deployed one); the server turns that into `409` with Dokku's message.
- rebuild streams server-sent events: `output` (`{ line }`) per line, then `end` or `failed`. It keeps running if the client disconnects.
- Every attempt is logged to the server's stdout with app, action and outcome.

In the UI the confirm dialog shows the exact command; a read-only server shows a "read-only" badge in the sidebar, disables the buttons and hides the palette's actions.

## Config vars

| Route | Does |
| --- | --- |
| `GET /api/apps/:name/config` | `{ ok, keys: [{ key, managed }] }`: names only, from `config:keys` |
| `GET /api/apps/:name/config/:key` | `{ ok, key, value }` for exactly one key (`config:get`), `Cache-Control: no-store`; 404 for an unset key |
| `PUT /api/apps/:name/config/:key` | body `{ value, restart }`, runs `config:set`; write gate applies |
| `DELETE /api/apps/:name/config/:key?restart=true` | `config:unset`; write gate applies; unsetting an absent key succeeds, as in Dokku |

- Values are only fetched on Reveal (or a direct `GET .../config/:key`). They are never in the list, never logged and never echoed in an error (Dokku's own failure text is replaced for writes, since it can quote the value). There is no request logger; each write logs `config app= key= action= outcome=` and nothing else.
- Keys must match `[A-Za-z_][A-Za-z0-9_]*`, up to 255 characters (400 `invalid-key`). `GIT_REV` and `DOKKU_*` are flagged `managed`: listed and revealable, but PUT/DELETE answer 409 `managed-key`.
- Without `restart: true` Dokku gets `--no-restart`. With it Dokku redeploys a running app (about 22s locally; a stopped or never-deployed app is left alone), so the UI toggle defaults off.
- **Multi-line values are rejected** (400 `invalid-value`): Dokku keeps one variable per line of its ENV file. So are values over 32768 characters and values ending in a backslash or a double quote: Dokku 0.38.31 drops the former as unparseable and reads the latter back with an extra backslash. Spaces, `=`, `$`, backticks and quotes elsewhere in a value round-trip.
- The value travels as the single argument `KEY=value`. sshd runs the remote command through a shell (Dokku's `authorized_keys` expands `$SSH_ORIGINAL_COMMAND` unquoted), so the server POSIX-single-quotes that argument for the hop; without it a value with spaces or quotes is split or rejected.

## Read cache

`GET /api/apps`, `GET /api/apps/:name`, `GET /api/apps/:name/config` and `GET /api/networks` are cached in memory for 5 seconds, `GET /api/host` for 60 seconds. Concurrent identical requests share one in-flight load, so polling and several open tabs cost one batch of SSH calls per window instead of one per request. Failed reads are not cached. A successful action or config change drops that app's entries, the list and the networks immediately. `GET /api/health`, host metrics, logs and single config values are never cached. `PIERHEAD_CACHE_TTL_MS` changes the 5-second lifetime; `0` turns off both caches. Changes made outside pierhead (a `git push`, the Dokku CLI) show up within one TTL.

## Revision of apps deployed by `git push`

`git:report` only has a commit sha for image deploys; for a `git push` it says `HEAD`. The server then reads that app's `GIT_REV` config value (`config:get <app> GIT_REV`, the one value it reads for itself) and pairs it with `last-updated-at`. It costs one extra SSH call per such app on the list (in parallel, and covered by the read cache) and one on the detail; apps never deployed have no timestamp and are skipped.

## Host metrics (Glances)

The host strip reads Glances over plain HTTP. Set `GLANCES_URL` on the server; unset or empty means metrics are off, and a malformed URL stops the server at startup.

| Route | Does |
| --- | --- |
| `GET /api/host/metrics` | Always 200 `{ ok, status, metrics, ... }`. `status` is `ok` (latest reading plus `history`), `unreachable` (last good reading or null, `sampledAt`, `error`, and the retained `history`) or `not-configured` (`metrics: null`) |
| `GET /api/health` | includes `metrics: "ok" \| "unreachable" \| "not-configured"` |

- The server polls Glances every 5s (3s timeout per request) and keeps the last 120 samples (10 minutes) in memory; a restart empties them. `history` is parallel arrays (`at` epoch ms, `cpu`, `memory`, `disk` as percentages), oldest first. The UI polls the route every 5s while the tab is visible.
- Endpoints read, all under `/api/4/`: `cpu`, `mem`, `fs`, `load`, `system`, `uptime`, `core`. Parsing is covered by `shared/glances.test.ts` against real Glances 4.5.7 output (`shared/fixtures/glances.json`). Disk is the `/` mount, or the largest mount when Glances does not list `/`. Sizes are shown in GiB, labelled GB.
- Locally, `compose.yaml` runs `nicolargo/glances:4.5.7-full` (`-w`, `pid: host`, no docker socket) as `pierhead-glances`. It reports the Docker VM, not your Mac.
- On the real Dokku host, run Glances 4 in web server mode on port 61208 (the lab runs the same `nicolargo/glances:4.5.7-full` image as a container; its setup is in the homelab repo, `config/dokku/README.md`). The API is unauthenticated; keep the port on a private network or firewall it to pierhead's address.
- Docker's version is not available from Glances, so the live host facts leave it out.

## Deploying

The `Dockerfile` builds one image: the UI (`VITE_DATA_SOURCE=api`) and the API server bundled with `bun build --target bun`, on `oven/bun:1.4-slim` with only `openssh-client` added, running as the non-root `bun` user (uid 1000). The server serves `dist/` itself (the image sets `NODE_ENV=production` and `PIERHEAD_STATIC_DIR`): hashed `/assets/*` are immutable, `index.html` is `no-cache`, unknown `/api/*` paths are JSON 404s, and any other GET falls back to `index.html`. The image's `HEALTHCHECK` uses `/api/health`, so it reports unhealthy while Dokku is unreachable.

`.github/workflows/image.yml` builds it for `linux/amd64` and `linux/arm64` on every push to `main` and pushes it to GHCR as `ghcr.io/viktoravelino/pierhead` (tags `main`, `latest`, `sha-<short>`; `v*` tags add semver tags).

Production runs `ghcr.io/viktoravelino/pierhead:main` on the maintainer's media VM, on `127.0.0.1:3001` behind Caddy at `https://pierhead.lab.vkav.dev`. Update with `docker compose pull pierhead && docker compose up -d pierhead`; pin a `sha-<short>` tag to roll back. The Compose service, the Caddy route and the setup notes are in the homelab repo: `config/infra-stack/compose.yaml`, `config/infra-stack/caddy/Caddyfile`, `config/infra-stack/.env.example` and the "pierhead" section of `config/infra-stack/README.md`.

A minimal run:

```sh
docker run -d --init -p 127.0.0.1:3001:3001 \
  -e DOKKU_SSH_HOST=<host> -e DOKKU_SSH_KEY=/run/secrets/pierhead/id_ed25519 \
  -e GLANCES_URL=http://<host>:61208 \
  -v /path/to/key-dir:/run/secrets/pierhead:ro \
  -v pierhead-ssh:/var/lib/pierhead ghcr.io/viktoravelino/pierhead:main
```

- The key file must be readable by uid 1000 and not by others (mode 600; ssh refuses it otherwise). Mount it read-only.
- Host key: the server uses `StrictHostKeyChecking=accept-new`, which writes `known_hosts`. Mount a writable volume on `/var/lib/pierhead` (a fresh named volume inherits the image's ownership); a read-only mount makes the first connection fail. Forget a changed host key by deleting that file.
- Use `--init` (Compose: `init: true`): the ssh control master is reparented to PID 1. The control socket lives in `/tmp`.

Fallback for a build that is not published: `docker build --platform linux/amd64 -t pierhead:<tag> .` (the flag matters on an arm64 machine), then `docker save pierhead:<tag> | ssh <vm> docker load` and point the service's `image:` at that tag.

## Mock data seam

Components only talk to `src/api/queries.ts`, which calls `src/api/client.ts`. That module is the single place that picks mock or real (`VITE_DATA_SOURCE`, with `src/api/backend.ts` as the typed HTTP client); it returns the domain types in `shared/types.ts`. Fixtures (`src/api/mock-data.ts`) hold raw Dokku `--format json` report maps, and `shared/parse.ts` turns them into those types, the same parsers the server uses.

## Stack

- Bun, Vite, React 19, TypeScript (strict)
- Hono for the API server
- Tailwind CSS v4, design tokens as CSS variables in `src/styles.css`
- TanStack Router and TanStack Query
- Biome for lint and format
- lucide-react icons; hand-written SVG sparklines and meters
- Fonts bundled locally via Fontsource: Schibsted Grotesk and IBM Plex Mono
