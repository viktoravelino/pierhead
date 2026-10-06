#!/usr/bin/env bash
# Runs pierhead from this machine (outside Docker) against the real lab Dokku host, read-only.
# Usage: bun run lab   (see README, "Running against the lab host (read-only)")
# API on :3002 and Vite on :5174, so the Docker dev stack keeps :3001 and :5173.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env.lab ] || { echo "Missing .env.lab: cp .env.lab.example .env.lab" >&2; exit 1; }
set -a
# shellcheck disable=SC1091
source .env.lab
set +a
# Read-only is not configurable here, whatever .env.lab or the calling shell says.
unset PIERHEAD_ALLOW_WRITES

# Not the Docker stack's .dev/state: its activity log is about a different Dokku.
export PIERHEAD_STATE_DIR=.dev/lab-state
export PORT=3002
export API_URL=http://127.0.0.1:3002
export VITE_DATA_SOURCE=api

# Ctrl-C (or either process dying) stops both.
bun server/index.ts & api=$!
bun --bun run dev --port 5174 --strictPort & ui=$!
trap 'trap - INT TERM EXIT; kill "$api" "$ui" 2>/dev/null || true' INT TERM EXIT
# macOS ships bash 3.2, which has no `wait -n`.
while kill -0 "$api" 2>/dev/null && kill -0 "$ui" 2>/dev/null; do sleep 1; done
