# Actual Budget — task runner (sister-app convention). Run `just` to list.
#
# NO DOCKER. The repo ships a docker-compose.yml + Dockerfile for a dev container, and `yarn vrt:docker`
# for visual regression tests. Neither is used here: every recipe below runs natively on this Mac with
# the homebrew node + yarn 4. Docker is only ever needed to reproduce CI's Linux VRT screenshots.
#
# PORTS ARE PINNED. The web app is ALWAYS http://localhost:3001/ and the (optional) sync server is
# ALWAYS http://localhost:5006/. 3001 is already hardcoded by the repo in
# packages/desktop-client/bin/watch-browser (`export PORT=3001`), and 5006 is the sync server default in
# packages/sync-server/src/load-config.js. The catch: vite.config.mts does NOT set `strictPort`, so if
# something else already holds 3001 Vite silently slides to 3002 and the URL changes underneath you.
# `run` therefore frees OUR old instance first, refuses to start if a FOREIGN process holds the port, and
# prints back the port it actually bound — so "same port every time" is enforced, not assumed.
#
# All yarn commands run from the repo root (never a child workspace) — AGENTS.md rule.

set shell := ["bash", "-uc"]

root := justfile_directory()
state := env_var('HOME') / "T/_actual_budget"
web_port := "3001"
server_port := "5006"

default:
    @just --list

# Fail fast if node or yarn is missing / too old (package.json engines: node >=22, yarn ^4.9.1).
_check-tools:
    #!/usr/bin/env bash
    set -uo pipefail
    command -v node >/dev/null || { echo "node not found — brew install node"; exit 1; }
    command -v yarn >/dev/null || { echo "yarn not found — corepack enable"; exit 1; }
    major=$(node -p 'process.versions.node.split(".")[0]')
    if [ "$major" -lt 22 ]; then echo "node $(node -v) is too old — package.json requires >=22"; exit 1; fi

# Install workspace dependencies (yarn 4, from the root only) + husky hooks.
setup: _check-tools
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{root}}"
    if [ -f node_modules/.yarn-state.yml ]; then
      echo "deps present — skipping install (run \`just install\` to force)"
    else
      yarn install
    fi

# Force a dependency install even when node_modules looks complete.
install: _check-tools
    cd "{{root}}" && yarn install

# Build every workspace (lage build across the monorepo).
build: setup
    cd "{{root}}" && yarn build

# Production browser bundle -> packages/desktop-client/build (needs COOP/COEP headers to be served).
build-browser: setup
    cd "{{root}}" && yarn build:browser

# `run` stops OUR previous instance first so the port is ours again, then starts the dev tree detached
# (vite + the loot-core browser backend + the plugins-service worker) and waits until the port answers.
#
# Start the web app in the background on http://localhost:3001/ .
run: setup
    #!/usr/bin/env bash
    set -uo pipefail
    just stop >/dev/null 2>&1
    mkdir -p "{{state}}"
    holder=$(lsof -nP -iTCP:{{web_port}} -sTCP:LISTEN -t 2>/dev/null | head -1)
    if [ -n "$holder" ]; then
      echo "PORT {{web_port}} IS HELD by pid $holder ($(ps -p "$holder" -o comm= 2>/dev/null))."
      echo "Free it (kill $holder) and re-run — starting anyway would move the app to another port."
      exit 1
    fi
    cd "{{root}}"
    : > "{{state}}/dev.log"
    nohup yarn start >> "{{state}}/dev.log" 2>&1 &
    echo $! > "{{state}}/dev.pid"
    echo "starting (pid $(cat "{{state}}/dev.pid")) — log: {{state}}/dev.log"
    for _ in $(seq 1 240); do
      if lsof -nP -iTCP:{{web_port}} -sTCP:LISTEN -t >/dev/null 2>&1; then
        echo
        echo "  Actual Budget is up:  http://localhost:{{web_port}}/"
        echo
        echo "  just logs    follow the dev log"
        echo "  just stop    shut it down"
        exit 0
      fi
      if ! kill -0 "$(cat "{{state}}/dev.pid")" 2>/dev/null; then
        echo "dev server died on boot — last lines:"; tail -30 "{{state}}/dev.log"; exit 1
      fi
      sleep 1
    done
    echo "timed out waiting for :{{web_port}} — last lines:"; tail -30 "{{state}}/dev.log"; exit 1

# Foreground dev server (Ctrl-C stops it). Same pinned port as `run`.
dev: setup
    cd "{{root}}" && yarn start

# Sync server (optional — only needed for multi-device sync / server-backed budget files).
server: setup
    cd "{{root}}" && yarn start:server

# Web app + sync server together, foreground (yarn's own combined dev script).
run-with-server: setup
    cd "{{root}}" && yarn start:server-dev

# Kill OUR dev tree (recorded pid and its descendants), then anything still holding :3001.
stop:
    #!/usr/bin/env bash
    set -uo pipefail
    kill_tree() {
      local p=$1
      for c in $(pgrep -P "$p" 2>/dev/null); do kill_tree "$c"; done
      kill "$p" 2>/dev/null
    }
    if [ -f "{{state}}/dev.pid" ]; then
      pid=$(cat "{{state}}/dev.pid")
      kill_tree "$pid"
      rm -f "{{state}}/dev.pid"
    fi
    sleep 1
    for pid in $(lsof -nP -iTCP:{{web_port}} -sTCP:LISTEN -t 2>/dev/null); do
      case "$(ps -p "$pid" -o comm= 2>/dev/null)" in
        *node*) kill "$pid" 2>/dev/null ;;
        *) echo "left pid $pid on :{{web_port}} alone (not a node process)" ;;
      esac
    done
    sleep 1
    if lsof -nP -iTCP:{{web_port}} -sTCP:LISTEN -t >/dev/null 2>&1; then
      echo "warning: :{{web_port}} is still in use"
    else
      echo "stopped — :{{web_port}} is free"
    fi

# Report whether the web app (and the sync server, if running) are up.
status:
    #!/usr/bin/env bash
    set -uo pipefail
    for entry in "web {{web_port}}" "sync-server {{server_port}}"; do
      set -- $entry
      pid=$(lsof -nP -iTCP:$2 -sTCP:LISTEN -t 2>/dev/null | head -1)
      if [ -n "$pid" ]; then
        echo "$1: UP    http://localhost:$2/   (pid $pid)"
      else
        echo "$1: down  (:$2 free)"
      fi
    done

# Follow the background dev log written by `run`.
logs:
    tail -f "{{state}}/dev.log"

# Print the pinned URLs.
url:
    @echo "web:         http://localhost:{{web_port}}/"
    @echo "sync server: http://localhost:{{server_port}}/"

# Unit tests across all workspaces (lage, cached).
test: setup
    cd "{{root}}" && yarn test

# Same, ignoring the lage cache.
test-debug: setup
    cd "{{root}}" && yarn test:debug

typecheck: setup
    cd "{{root}}" && yarn typecheck

lint: setup
    cd "{{root}}" && yarn lint

fix: setup
    cd "{{root}}" && yarn lint:fix

# End-to-end tests (Playwright, native — no Docker).
e2e: setup
    cd "{{root}}" && yarn e2e

# Remove build output and the lage cache (keeps node_modules).
clean:
    cd "{{root}}" && rm -rf .lage packages/*/dist packages/*/lib-dist packages/*/build
