#!/bin/zsh
# LaunchAgent wrapper that keeps DeepSeek Harness alive on 127.0.0.1:3080.
# If a Harness is already listening (for example one started manually in a
# terminal), this supervisor leaves it alone.
set -euo pipefail

NODE_BIN="${DSH_REMOTE_NODE:-node}"
NPX_BIN="$(dirname "$NODE_BIN")/npx"
HARNESS_PORT="${DSH_REMOTE_HARNESS_PORT:-3080}"
TRUSTED_HOST="${DSH_REMOTE_TRUSTED_HOST:-}"
AUTH_URL_FILE="${DSH_REMOTE_HARNESS_AUTH_URL_FILE:-$HOME/.dsh-remote/harness-auth-url}"

echo "harness supervisor: node=$NODE_BIN port=$HARNESS_PORT trustedHost=${TRUSTED_HOST:-none}" >&2
mkdir -p "$(dirname "$AUTH_URL_FILE")"

run_harness() {
  if [[ -n "$TRUSTED_HOST" ]]; then
    "$NPX_BIN" @deepseek-ai/dsh web --trusted-host "$TRUSTED_HOST" 2>&1
  else
    "$NPX_BIN" @deepseek-ai/dsh web 2>&1
  fi
}

capture_harness_output() {
  while IFS= read -r line; do
    if [[ "$line" == dsh\ web:\ http* ]]; then
      auth_url="${line#dsh web: }"
      temp_file="${AUTH_URL_FILE}.tmp.$$"
      print -r -- "$auth_url" > "$temp_file"
      chmod 600 "$temp_file"
      mv -f "$temp_file" "$AUTH_URL_FILE"
      echo "harness supervisor: captured browser session URL" >&2
    else
      print -r -- "$line"
    fi
  done
}

while true; do
  if /usr/sbin/lsof -nP -iTCP:"$HARNESS_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    sleep 15
    continue
  fi

  echo "harness supervisor: port $HARNESS_PORT is down; starting Harness" >&2
  rm -f "$AUTH_URL_FILE"
  run_harness | capture_harness_output

  echo "harness supervisor: Harness exited; will restart after 5s" >&2
  sleep 5
done
