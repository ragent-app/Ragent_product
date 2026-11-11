#!/bin/bash
# AgentoC macOS app shared environment bootstrap.
# Sourced by Contents/MacOS/{AgentoC,agentoc-stop,agentoc}. Not executed directly.
# shellcheck shell=bash

agentoc_app_self_dir() {
  cd "$(dirname "${BASH_SOURCE[0]}")" && pwd
}

AGENTOC_APP_SELF_DIR="$(agentoc_app_self_dir)"
# Contents/MacOS → Contents/Resources
AGENTOC_RESOURCES_DIR="$(cd "$AGENTOC_APP_SELF_DIR/.." && pwd)/Resources"
AGENTOC_APP_DIR="$AGENTOC_RESOURCES_DIR/app"
AGENTOC_NODE_BIN="$AGENTOC_RESOURCES_DIR/runtime/node"
AGENTOC_CONFIG_DIR_DEFAULT="$HOME/.config/agentoc"

agentoc_log() { printf '[AgentoC] %s\n' "$*"; }

agentoc_config_dir() {
  if [ -n "${AGENTOC_CONFIG_DIR:-}" ]; then
    printf '%s' "$AGENTOC_CONFIG_DIR"
  else
    printf '%s' "$AGENTOC_CONFIG_DIR_DEFAULT"
  fi
}

AGENTOC_PID_FILE="$(agentoc_config_dir)/agentoc.pid"
AGENTOC_RUN_LOG="$(agentoc_config_dir)/chat-server.log"

agentoc_is_server_pid() {
  local pid="$1" command
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  command="$(ps -ww -p "$pid" -o command= 2>/dev/null || true)"
  [ "$command" = "$AGENTOC_NODE_BIN $AGENTOC_APP_DIR/chat-server.mjs" ]
}

agentoc_server_pid() {
  local pid
  pid="$(cat "$AGENTOC_PID_FILE" 2>/dev/null || true)"
  if agentoc_is_server_pid "$pid"; then
    printf '%s' "$pid"
    return 0
  fi
  return 1
}

agentoc_server_running() {
  local port="${CHAT_PORT:-7690}" pid
  # Verify the listening process, including LaunchAgent starts without a PID
  # file. Another service's health endpoint must not be mistaken for ours.
  for pid in $(lsof -ti ":${port}" -sTCP:LISTEN 2>/dev/null || true); do
    if agentoc_is_server_pid "$pid"; then return 0; fi
  done
  return 1
}

# Provision first-run credentials exactly like the Debian postinst:
# auth.json (scrypt owner credentials) + instance.env (session secret,
# local-mode cookies, connectivity defaults). Both live in the instance
# config dir so upgrades never overwrite user edits.
agentoc_first_run_bootstrap() {
  local config_dir auth_file env_file password salt hash secret
  # Protect credentials from the instant each file is created, not only after
  # a later chmod. The subshell contains the more restrictive umask.
  (
  umask 077
  config_dir="$(agentoc_config_dir)"
  auth_file="$config_dir/auth.json"
  env_file="$config_dir/instance.env"
  mkdir -p "$config_dir"

  if [ ! -s "$env_file" ]; then
    secret="$(openssl rand -hex 32 2>/dev/null || "$AGENTOC_NODE_BIN" -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex")+"\n")')"
    {
      printf '# AgentoC macOS instance environment (sourced by the app launcher).\n'
      printf '# Edits survive app upgrades. Restart the app after changing values.\n'
      printf 'AGENTOC_AUTH_SESSION_SECRET=%s\n' "$secret"
      printf '# Local browser access is plain HTTP on 127.0.0.1.\n'
      printf 'SECURE_COOKIES=0\n'
      printf '# Central connectivity services (phone pairing: TURN-first + P2P upgrade).\n'
      printf 'AGENTOC_ACCOUNTS_URL=https://agentoc.andyscodexagent.cyou/accounts\n'
      printf 'AGENTOC_ACCOUNTS_JWKS_URL=https://agentoc.andyscodexagent.cyou/accounts/.well-known/jwks.json\n'
      printf 'AGENTOC_ACCOUNTS_ISSUER=https://agentoc.andyscodexagent.cyou\n'
      printf 'AGENTOC_TURN_BROKER_URL=https://agentoc.andyscodexagent.cyou/turn\n'
      printf '# Central metadata-only P2P signaling (shared by all instances;\n'
      printf '# both the Mac and the phone connect outbound). Override only when\n'
      printf '# running a self-hosted central stack.\n'
      printf 'AGENTOC_P2P_SIGNALING_URL=https://agentoc.andyscodexagent.cyou/signal\n'
    } > "$env_file"
    chmod 600 "$env_file"
    agentoc_log "created $env_file"
  fi

  if [ ! -s "$auth_file" ]; then
    password="$(openssl rand -hex 12 2>/dev/null || "$AGENTOC_NODE_BIN" -e 'process.stdout.write(require("crypto").randomBytes(12).toString("hex")+"\n")')"
    salt="$(openssl rand -hex 16 2>/dev/null || "$AGENTOC_NODE_BIN" -e 'process.stdout.write(require("crypto").randomBytes(16).toString("hex")+"\n")')"
    hash="$(printf '%s' "$password" | "$AGENTOC_NODE_BIN" -e '
      const { scryptSync } = require("crypto");
      const { readFileSync } = require("fs");
      const password = readFileSync(0, "utf8");
      const [saltHex] = process.argv.slice(1);
      const salt = Buffer.from(saltHex, "hex");
      const hash = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
      process.stdout.write(hash.toString("hex"));
    ' "$salt")"
    "$AGENTOC_NODE_BIN" -e '
      const { writeFileSync, chmodSync } = require("fs");
      const [file, passwordHash] = process.argv.slice(1);
      writeFileSync(file, JSON.stringify({ username: "owner", passwordHash }, null, 2) + "\n");
      chmodSync(file, 0o600);
    ' "$auth_file" "scrypt\$16384\$8\$1\$${salt}\$${hash}"
    local creds_file
    creds_file="$config_dir/owner-credentials.txt"
    {
      printf '# AgentoC owner login (generated on first run)\n'
      printf '# Web: http://127.0.0.1:%s/\n' "${CHAT_PORT:-7690}"
      printf 'username: owner\n'
      printf 'password: %s\n' "$password"
      printf '# Change it in Settings after first login, then delete this file.\n'
    } > "$creds_file"
    chmod 600 "$creds_file"
    agentoc_log "generated owner credentials: $creds_file"
    open -t "$creds_file" 2>/dev/null || true
  fi
  )
}

agentoc_source_instance_env() {
  local env_file
  env_file="$(agentoc_config_dir)/instance.env"
  if [ -s "$env_file" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$env_file"
    set +a
  fi
}

agentoc_ensure_runtime_shims() {
  local bin_dir="$AGENTOC_RESOURCES_DIR/runtime"
  [ -x "$bin_dir/codex" ] && [ -x "$bin_dir/claude" ] || {
    agentoc_log "packaged provider launchers are missing: $bin_dir" >&2
    return 1
  }
  AGENTOC_PACKAGED_HARNESS_ROOT="${AGENTOC_PACKAGED_HARNESS_ROOT:-$bin_dir}"
  PATH="$bin_dir:${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"
  export AGENTOC_PACKAGED_HARNESS_ROOT PATH
}
