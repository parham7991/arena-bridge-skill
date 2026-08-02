#!/usr/bin/env bash
# install.sh — one-shot installer for the arena-bridge skill.
#   bash install.sh [--email e] [--password p] [--key hex] [--port N] [--proxy socks5://...] [--data-dir DIR]
#   (email/password can also come from ARENA_EMAIL / ARENA_PASSWORD)
set -euo pipefail

EMAIL="${ARENA_EMAIL:-}"
PASSWORD="${ARENA_PASSWORD:-}"
KEY=""
PORT="20140"
PROXY=""
DATA_DIR="${DATA_DIR:-$HOME/.arena-bridge}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --email) EMAIL="$2"; shift 2 ;;
    --password) PASSWORD="$2"; shift 2 ;;
    --key) KEY="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --proxy) PROXY="$2"; shift 2 ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> [1/6] Node.js check"
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node not found. Install Node.js >= 18 first." >&2; exit 1
fi
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
echo "    node $(node -v) (major $NODE_MAJOR)"
if (( NODE_MAJOR < 18 )); then echo "ERROR: need node >= 18" >&2; exit 1; fi

echo "==> [2/6] Install playwright + chromium"
if [[ ! -d "$SRC_DIR/node_modules/playwright" ]]; then
  (cd "$SRC_DIR" && npm install playwright --no-audit --no-fund)
fi
(cd "$SRC_DIR" && npx playwright install chromium || true)
if command -v sudo >/dev/null 2>&1; then
  (cd "$SRC_DIR" && sudo npx playwright install-deps chromium || true) || true
fi

echo "==> [3/6] Prepare data dir + env ($DATA_DIR)"
mkdir -p "$DATA_DIR"
chmod 700 "$DATA_DIR"
ENV_FILE="$DATA_DIR/.env"
touch "$ENV_FILE"; chmod 600 "$ENV_FILE"

# bridge API key
if [[ -z "$KEY" ]]; then
  KEY="$(openssl rand -hex 24 2>/dev/null || head -c 48 /dev/urandom | od -An -tx1 | tr -d ' \n')"
fi
# encryption key (only if not already set)
if ! grep -q '^STORAGE_ENCRYPTION_KEY=' "$ENV_FILE" 2>/dev/null; then
  echo "STORAGE_ENCRYPTION_KEY=$(openssl rand -hex 32 2>/dev/null || head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n')" >> "$ENV_FILE"
fi
# port / proxy
sed -i "/^PORT=/d;/^ARENA_AGENT_PROXY=/d;/^ARENA_AGENT_BRIDGE_KEY=/d" "$ENV_FILE" 2>/dev/null || true
echo "PORT=$PORT" >> "$ENV_FILE"
[[ -n "$PROXY" ]] && echo "ARENA_AGENT_PROXY=$PROXY" >> "$ENV_FILE"
echo "ARENA_AGENT_BRIDGE_KEY=$KEY" >> "$ENV_FILE"
echo "DATA_DIR=$DATA_DIR" >> "$ENV_FILE"

echo "==> [4/6] Login to arena.ai (email/password)"
if [[ -z "$EMAIL" ]]; then
  echo "ERROR: no email. Pass --email you@example.com or set ARENA_EMAIL." >&2
  echo "       (bridge key: $KEY)" >&2
  exit 1
fi
if [[ -z "$PASSWORD" ]]; then
  read -rsp "Password for $EMAIL: " PASSWORD; echo
fi
(cd "$SRC_DIR" && DATA_DIR="$DATA_DIR" ARENA_AGENT_BRIDGE_KEY="$KEY" \
  node bin/login.mjs --email "$EMAIL" --password "$PASSWORD")

echo "==> [5/6] Start bridge"
pkill -f "$SRC_DIR/src/index.mjs" 2>/dev/null || true
sleep 1
(cd "$SRC_DIR" && DATA_DIR="$DATA_DIR" ARENA_AGENT_BRIDGE_KEY="$KEY" \
  nohup node src/index.mjs > "$DATA_DIR/bridge.log" 2>&1 &)

echo "==> [6/6] Wait for health"
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$PORT/health" >/tmp/arena-bridge-health.json 2>/dev/null; then
    echo "---- health ----"
    head -c 700 /tmp/arena-bridge-health.json; echo
    echo
    echo "==> arena-bridge is UP on http://127.0.0.1:$PORT"
    echo "==> Bridge key: $KEY   (keep it safe; it is also in $ENV_FILE)"
    echo "==> Usage:"
    echo "    curl -X POST http://127.0.0.1:$PORT/v1/chat/completions \\"
    echo "      -H \"Authorization: Bearer $KEY\" -H 'Content-Type: application/json' \\"
    echo "      -d '{\"model\":\"agent\",\"messages\":[{\"role\":\"user\",\"content\":\"Salam\"}]}'"
    echo "==> Team leader: add -H 'x-codex-session-id: agent-<name>' per agent for parallel sessions."
    exit 0
  fi
  sleep 2
done
echo "ERROR: bridge did not become healthy within 60s — see $DATA_DIR/bridge.log" >&2
tail -30 "$DATA_DIR/bridge.log" >&2 || true
exit 1
