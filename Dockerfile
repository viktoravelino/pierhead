# Production image: one Bun process serves the API and the built UI on :3001.
# Build:  docker build -t pierhead:local .
# Run:    see "Deploying" in README.md (SSH key and env vars are supplied at run time).

# Build output (dist/ and server.js) is platform-independent, so build on the host's
# architecture and only the runtime stage is per-target (linux/amd64, linux/arm64).
FROM --platform=$BUILDPLATFORM oven/bun:1.4-slim AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
# Typecheck + Vite build, with the UI reading the real backend.
RUN VITE_DATA_SOURCE=api bun run build
# The server's only runtime dependency is hono, so bundle it: no node_modules at runtime.
RUN bun build --target bun --outfile /out/server.js server/index.ts

FROM oven/bun:1.4-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-client \
    && rm -rf /var/lib/apt/lists/* \
    # known_hosts and the state (activity log, proxy restore) live here, so a named volume
    # mounted on it starts out writable by `bun`.
    && mkdir -p /var/lib/pierhead && chown bun:bun /var/lib/pierhead
WORKDIR /app
COPY --from=build /out/server.js ./server.js
COPY --from=build /app/dist ./dist

ENV NODE_ENV=production \
    PORT=3001 \
    PIERHEAD_STATIC_DIR=/app/dist \
    # Trust-on-first-use (accept-new) writes here, so mount a volume on /var/lib/pierhead.
    DOKKU_SSH_KNOWN_HOSTS=/var/lib/pierhead/known_hosts \
    # Activity log and saved proxy state; lost with the container unless /var/lib/pierhead is a volume.
    PIERHEAD_STATE_DIR=/var/lib/pierhead
# Not set here, supply at run time: DOKKU_SSH_HOST, DOKKU_SSH_KEY (a path, readable only by
# uid 1000), and optionally DOKKU_SSH_PORT, DOKKU_SSH_USER, GLANCES_URL,
# PIERHEAD_ALLOW_WRITES, PIERHEAD_CACHE_TTL_MS. The ssh control socket goes to /tmp.

# Non-root; the image's `bun` user (uid 1000) has a home directory for ssh.
USER bun
EXPOSE 3001
# Run with `--init` / `init: true`: the ssh ControlPersist master is reparented to PID 1.
HEALTHCHECK --interval=30s --timeout=15s --start-period=10s --retries=3 \
    CMD bun -e "fetch('http://127.0.0.1:3001/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["bun", "server.js"]
