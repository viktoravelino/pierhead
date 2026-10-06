#!/usr/bin/env bash
# Local test environment: throwaway Dokku plus the pierhead dev stack.
# Usage: scripts/dev.sh up|down|reset   (see README, "Local test environment")
set -euo pipefail
cd "$(dirname "$0")/.."

KEY=.dev/ssh/id_ed25519
APP=hello
dokku() { docker compose exec -T dokku dokku "$@"; }

# seed_app NAME [deploy [PORT_MAP]]: idempotently create an app, label it, and optionally
# deploy a tiny public image. Ports and the deploy only happen while the app has none,
# so reruns leave existing state (and running containers) alone.
seed_app() {
  local app=$1
  if dokku apps:exists "$app" >/dev/null 2>&1; then
    echo "app $app already exists"
  else
    dokku apps:create "$app"
  fi
  # The label lets `reset` find the sibling containers Dokku starts on the host daemon.
  dokku docker-options:add "$app" deploy,run "--label pierhead.dev=1" >/dev/null
  [ "${2:-}" = deploy ] || return 0
  if [ "$(dokku ps:report "$app" --deployed 2>/dev/null)" = "true" ]; then
    echo "app $app already deployed"
  else
    dokku ports:set "$app" "${3:-http:80:80}" >/dev/null
    dokku git:from-image "$app" nginx:alpine
  fi
}

# attach_network APP PROPERTY: attach APP to hello-net through PROPERTY and rebuild it (~25s),
# unless the property is already set.
attach_network() {
  [ "$(dokku network:report "$1" "--network-$2" 2>/dev/null)" = "hello-net" ] && return 0
  dokku network:set "$1" "$2" hello-net >/dev/null
  dokku ps:rebuild "$1" >/dev/null
}

# install_plugin NAME URL: idempotently install a Dokku plugin at the version the lab host
# runs (2.2.0 for the datastore plugins). `dokku` here is `docker exec` as root, which
# `plugin:install` needs; the restricted `dokku` ssh user cannot run it.
install_plugin() {
  if dokku plugin:list | awk '{print $1}' | grep -qx "$1"; then
    echo "plugin $1 already installed"
  else
    dokku plugin:install "$2" --committish "${3:-2.2.0}" --name "$1"
  fi
}

# seed_service TYPE NAME: idempotently create a datastore service. The first postgres or
# redis service pulls its image (timescale/timescaledb is about 1 GB), which is why a first
# run takes minutes.
seed_service() {
  if dokku "$1:exists" "$2" >/dev/null 2>&1; then
    echo "service $2 already exists"
  else
    dokku "$1:create" "$2" >/dev/null
  fi
}

# link_service TYPE NAME APP: link unless already linked. --no-restart: the app keeps its
# running container, as with the seeded config vars.
link_service() {
  dokku "$1:linked" "$2" "$3" >/dev/null 2>&1 || dokku "$1:link" "$2" "$3" --no-restart >/dev/null
}

up() {
  mkdir -p .dev/ssh .dev/state
  [ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N "" -C pierhead-dev -f "$KEY"

  docker compose up -d --build dokku

  echo "Waiting for Dokku..."
  for _ in $(seq 1 90); do
    dokku version >/dev/null 2>&1 && docker compose exec -T dokku pgrep -x sshd >/dev/null 2>&1 && break
    sleep 2
  done
  dokku version >/dev/null 2>&1 || { echo "Dokku did not become ready" >&2; exit 1; }

  if dokku ssh-keys:list 2>/dev/null | grep -q 'NAME="pierhead-dev"'; then
    echo "ssh key already registered"
  else
    dokku ssh-keys:add pierhead-dev < "$KEY.pub"
  fi

  seed_app hello deploy
  # A few obviously fake vars. --no-restart: the app keeps its running container.
  dokku config:set --no-restart hello APP_ENV=development GREETING="hello from pierhead" \
    API_TOKEN=fake-token-not-a-secret >/dev/null
  # Deployed, then stopped.
  seed_app hello-stopped deploy
  dokku ps:stop hello-stopped >/dev/null
  # Two domains and a custom port mapping.
  seed_app hello-multi deploy http:8081:80
  dokku domains:set hello-multi hello-multi.dokku.localhost multi.dokku.localhost >/dev/null
  dokku config:set --no-restart hello-multi SITE_NAME=hello-multi \
    DATABASE_URL=postgres://user:fake-password@db.invalid:5432/app >/dev/null
  # Created, never deployed.
  seed_app hello-new

  # One named network, attached to two apps in two different ways, so the Networks page has
  # something to show. network:set only takes effect on the next deploy, so the apps are
  # rebuilt, but only while they are not attached yet (reruns leave running apps alone).
  if dokku network:exists hello-net >/dev/null 2>&1; then
    echo "network hello-net already exists"
  else
    dokku network:create hello-net
  fi
  attach_network hello attach-post-deploy
  attach_network hello-multi initial-network

  # Datastore plugins and two services for the Services page: hello-db (postgres) linked to
  # hello-multi, hello-cache (redis) linked to nothing.
  install_plugin postgres https://github.com/dokku/dokku-postgres.git
  install_plugin redis https://github.com/dokku/dokku-redis.git
  seed_service postgres hello-db
  seed_service redis hello-cache
  link_service postgres hello-db hello-multi

  docker compose up -d --build pierhead
  cat <<MSG

pierhead dev stack is up
  UI (Vite)  http://localhost:5173
  API        http://localhost:3001/api/health
  Dokku app  curl -H 'Host: $APP.dokku.localhost' http://localhost:8080
MSG
}

down() { docker compose down; }

reset() {
  # Destroy Dokku apps first so their sibling containers and images go too.
  if docker compose ps --status running --services 2>/dev/null | grep -qx dokku; then
    for app in $(dokku apps:list 2>/dev/null | tail -n +2); do
      dokku apps:destroy "$app" --force || true
    done
    # Services are sibling containers too (and restart: always). Destroying an app unlinks
    # its services, which `<type>:destroy` needs.
    for type in postgres redis; do
      for service in $(dokku "$type:list" --format json 2>/dev/null | tr -d '[]"' | tr ',' ' '); do
        dokku "$type:destroy" "$service" --force || true
      done
    done
  fi
  docker compose down -v --remove-orphans
  # hello-net lives on the host daemon, outside Dokku's volume.
  docker network rm hello-net 2>/dev/null || true
  # Anything labelled at deploy time that survived (e.g. Dokku was already stopped).
  docker ps -aq --filter label=pierhead.dev=1 | xargs docker rm -f 2>/dev/null || true
  # A fresh Dokku gets fresh host keys, and no history.
  rm -f .dev/state/known_hosts .dev/state/activity.jsonl .dev/state/proxy-restore.json
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  reset) reset ;;
  *) echo "usage: $0 up|down|reset" >&2; exit 2 ;;
esac
