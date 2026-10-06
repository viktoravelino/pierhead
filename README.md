<img src="assets/icon.svg" width="64" height="64" alt="">

# pierhead

A dashboard for a single self-hosted [Dokku](https://dokku.com) host. Apps are the vessels, pierhead is where you log them in and out: host health, app status, deploys, logs, config, domains and networks in one dense, calm console. Dark theme first, light theme through the same tokens.

This is a design POC with a growing live backend (Hono on Bun, talking to Dokku over SSH). Which data is live depends on `VITE_DATA_SOURCE`:

- `mock` (the default; no backend or Docker needed): everything is fixtures.
- `api` (set by `compose.yaml`): the UI reads the backend.

| In `api` mode | Source |
| --- | --- |
| Host name and Dokku version, apps list, app overview (status, processes, build, domains, ports, networks, revision) | Live: Dokku reports over SSH |
| Logs tab: recent lines, then new lines as they happen | Live: `dokku logs --tail` streamed as server-sent events (`GET /api/apps/:name/logs`) |
| Config tab: variable names, one value on Reveal, set and unset | Live: `config:keys`, `config:get`, `config:set`, `config:unset` (see below) |
| Host CPU, memory and disk meters and sparklines; OS, kernel, cores, memory, uptime | Live: Glances REST API, when `GLANCES_URL` is set (see below); otherwise a "Metrics not connected" state |
| Deploy history, networks page, activity, backup | Sample data |
| Start, Stop, Restart, Rebuild, set/unset config vars | Live when writes are enabled (see below); refused otherwise |

## App actions and the write switch

`POST /api/apps/:name/actions/:action` runs `ps:start`, `ps:stop`, `ps:restart` or `ps:rebuild` (the table is `shared/actions.ts`). The server refuses with `403 writes-disabled` unless it was started with the literal `PIERHEAD_ALLOW_WRITES=true`; the default is read-only, and `GET /api/health` reports `writesEnabled`. `compose.yaml` turns it on because its Dokku is the throwaway local one; never set it for a real host without meaning to.

- start, stop, restart answer `{ ok: true, output }` once Dokku is done (about 25s for start and restart, 1s for stop). Dokku exits 0 when it did nothing (start on a running or never-deployed app); the server turns that into `409` with Dokku's message.
- rebuild streams server-sent events: `output` (`{ line }`) per line, then `end` or `failed`. It keeps running if the client disconnects.
- Every attempt is logged to the server's stdout with app, action and outcome.

In the UI the confirm dialog shows the exact command; a read-only server shows a "read-only" badge in the sidebar, disables the buttons and hides the palette's actions. In `mock` mode actions only toast the command.

## Revision of apps deployed by `git push`

`git:report` only has a commit sha for image deploys; for a `git push` it says `HEAD`. The server then reads that app's `GIT_REV` config value (`config:get <app> GIT_REV`, the one value it reads for itself) and pairs it with `last-updated-at`. It costs one extra SSH call per such app on the list (in parallel, and covered by the read cache) and one on the detail; apps never deployed have no timestamp and are skipped.

## Read cache

`GET /api/apps`, `GET /api/apps/:name` and `GET /api/apps/:name/config` are cached in memory for 5 seconds, and concurrent identical requests share one in-flight load, so polling and several open tabs cost one batch of SSH calls per window instead of one per request. Failed reads are not cached. A successful action or config change drops that app's entries and the list immediately. `GET /api/health`, host metrics, logs and single config values are never cached. Set `PIERHEAD_CACHE_TTL_MS` to change the lifetime in milliseconds; `0` turns the cache off. Changes made outside pierhead (a `git push`, the Dokku CLI) show up within one TTL.

## Config vars

| Route | Does |
| --- | --- |
| `GET /api/apps/:name/config` | `{ ok, keys: [{ key, managed }] }`: names only, from `config:keys` |
| `GET /api/apps/:name/config/:key` | `{ ok, key, value }` for exactly one key (`config:get`), `Cache-Control: no-store`; 404 for an unset key |
| `PUT /api/apps/:name/config/:key` | body `{ value, restart }`, runs `config:set`; write gate applies |
| `DELETE /api/apps/:name/config/:key?restart=true` | `config:unset`; write gate applies; unsetting an absent key succeeds, as in Dokku |

- Values are never in the list, never logged and never echoed in an error (Dokku's own failure text is replaced for writes, since it can quote the value). There is no request logger; each write logs `config app= key= action= outcome=` and nothing else.
- Keys must match `[A-Za-z_][A-Za-z0-9_]*` (400 `invalid-key`). `GIT_REV` and `DOKKU_*` are flagged `managed`: listed and revealable, but PUT/DELETE answer 409 `managed-key`.
- Without `restart: true` Dokku gets `--no-restart`. With it Dokku redeploys a running app (about 22s locally; a stopped or never-deployed app is left alone), so the UI toggle defaults off.
- **Multi-line values are rejected** (400 `invalid-value`): Dokku keeps one variable per line of its ENV file. So are values over 32768 characters and values ending in a backslash or a double quote: Dokku 0.38.31 drops the former as unparseable and reads the latter back with an extra backslash. Spaces, `=`, `$`, backticks and quotes elsewhere in a value round-trip.
- The value travels as the single argument `KEY=value`. sshd runs the remote command through a shell (Dokku's `authorized_keys` expands `$SSH_ORIGINAL_COMMAND` unquoted), so the server POSIX-single-quotes that argument for the hop; without it a value with spaces or quotes is split or rejected.

## Host metrics (Glances)

The host strip reads [Glances](https://nicolargo.github.io/glances/) over plain HTTP. Set `GLANCES_URL` (for example `http://glances:61208`) on the server; unset or empty means metrics are off. A malformed URL stops the server at startup.

| Route | Does |
| --- | --- |
| `GET /api/host/metrics` | Always 200 `{ ok, status, metrics, ... }`. `status` is `ok` (latest reading plus `history`), `unreachable` (last good reading or null, `sampledAt`, `error`, and the retained `history`) or `not-configured` (`metrics: null`) |
| `GET /api/health` | gains `metrics: "ok" \| "unreachable" \| "not-configured"` |

- The server polls Glances every 5s (3s timeout per request) and keeps the last 120 samples (10 minutes) in memory; a restart empties them. `history` is parallel arrays (`at` epoch ms, `cpu`, `memory`, `disk` as percentages), oldest first. The UI polls the route every 5s while the tab is visible.
- Endpoints read, all under `/api/4/`: `cpu`, `mem`, `fs`, `load`, `system`, `uptime`, `core`. Parsing is covered by `shared/glances.test.ts` against real Glances 4.5.7 output (`shared/fixtures/glances.json`). Disk is the `/` mount, or the largest mount when Glances does not list `/`. Sizes are shown in GiB, labelled GB.
- Locally, `compose.yaml` runs `nicolargo/glances:4.5.7-full` (`-w`, `pid: host`, no docker socket) as `pierhead-glances` and points `pierhead-dev` at it. It reports the Docker VM, not your Mac, and its port 61208 is published on `127.0.0.1` for poking at `/api/4/...`.
- On the real Dokku host, run Glances 4 in web server mode (`glances -w`, listening on port 61208) and make it reachable from wherever pierhead runs. Use the Glances 4 API: Ubuntu 24.04's apt package may be 3.x, so install 4.x with `pipx install 'glances[web]'`. The API is unauthenticated; keep the port on a private network or firewall it to pierhead's address.
- Docker's version is not available from Glances, so the live host facts leave it out.

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

The ports differ from the Docker stack's (5173, 3001), so both can run at once. Vite's proxy target comes from `API_URL` (default `http://127.0.0.1:3001`); `scripts/lab.sh` sets it to the lab API. `GLANCES_URL` is commented out in the example; set it to the Glances container on the host (`http://192.168.2.13:61208`) for live host metrics, otherwise the host strip shows "Metrics not connected".

Config values are only fetched when you press Reveal in the Config tab (or call `GET /api/apps/:name/config/:key`); the list shows names only.

## Stack

- Bun, Vite, React 19, TypeScript (strict)
- Tailwind CSS v4, design tokens as CSS variables in `src/styles.css`
- TanStack Router and TanStack Query
- Biome for lint and format
- lucide-react icons; hand-written SVG sparklines and meters
- Fonts bundled locally via Fontsource: Schibsted Grotesk and IBM Plex Mono

## Scripts

```sh
bun install
bun run dev        # frontend only; mock data unless VITE_DATA_SOURCE=api, no Docker
bun run dev:server # API server (needs the DOKKU_SSH_* env, see server/dokku.ts)
bun run build      # typecheck, then production build
bun run typecheck  # tsc --noEmit
bun run lint       # biome check
bun run format     # biome check --write
```

## Mock data seam

Components only talk to `src/api/queries.ts`, which calls `src/api/client.ts`. That module is the single place that picks mock or real (`VITE_DATA_SOURCE`, with `src/api/backend.ts` as the HTTP client); it returns the domain types in `shared/types.ts`. Fixtures (`mock-data.ts`) hold raw Dokku `--format json` report maps, and `parse.ts` turns them into those types.

## Local test environment

A throwaway Dokku (`dokku/dokku:0.38.31`) plus the pierhead dev stack, all in Docker. Nothing leaves your machine.

```sh
bun run dev:up     # generate dev key, start Dokku, register key, seed app, start pierhead
bun run dev:down   # stop containers, keep data
bun run dev:reset  # destroy Dokku apps, remove containers and pierhead volumes, forget host key
```

`dev:up` is idempotent. Ports (localhost only):

| URL | What |
| --- | --- |
| http://localhost:5173 | Vite dev UI (proxies `/api` to the API) |
| http://localhost:3001/api/health | API; returns the Dokku version fetched over SSH |
| http://localhost:61208/api/4/status | Glances (host metrics source) |
| http://localhost:8080 | Dokku nginx; sample app: `curl -H 'Host: hello.dokku.localhost' http://localhost:8080` |

Dokku's SSH port is not published; the `pierhead-dev` container reaches it as `dokku@dokku:22` over the compose network.

What gets created: containers `pierhead-dokku`, `pierhead-glances`, `pierhead-dev`, and the app container `hello.web.1` (nginx:alpine, labelled `pierhead.dev=1`); volumes `pierhead_dokku-data`, `pierhead_node-modules`; and the gitignored `.dev/` directory with the dev SSH keypair (`.dev/ssh`) and `known_hosts` (`.dev/state`). The first start takes a bit longer while `bun install` fills the `node_modules` volume.

Docker-in-Docker notes: Dokku talks to the host Docker socket, so apps are sibling containers. Dokku passes `DOKKU_HOST_ROOT` / `DOKKU_LIB_HOST_ROOT` to the daemon as bind-mount sources, so they must be paths on the daemon's filesystem. `compose.yaml` stores Dokku's data in a named volume and points both at that volume's `_data` directory (`/var/lib/docker/volumes/...`), which exists inside OrbStack's VM. On Docker Desktop or native Linux the same paths work; only a bind mount from a macOS path would break.
