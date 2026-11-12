#!/bin/bash
# AgentoC macOS app shared environment bootstrap.
# Sourced by the main launcher and the helper scripts in Contents/Resources.
# shellcheck shell=bash

agentoc_app_self_dir() {
  cd "$(dirname "${BASH_SOURCE[0]}")" && pwd
}

AGENTOC_APP_SELF_DIR="$(agentoc_app_self_dir)"
if [ "$(basename "$AGENTOC_APP_SELF_DIR")" = Resources ]; then
  AGENTOC_RESOURCES_DIR="$AGENTOC_APP_SELF_DIR"
else
  AGENTOC_RESOURCES_DIR="$(cd "$AGENTOC_APP_SELF_DIR/.." && pwd)/Resources"
fi
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

agentoc_is_packaged_server_pid() {
  local pid="$1" command
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  command="$(ps -ww -p "$pid" -o command= 2>/dev/null || true)"
  [ "$command" = "$AGENTOC_NODE_BIN $AGENTOC_APP_DIR/chat-server.mjs" ]
}

# The same bundle can host multiple independent configurations. A matching
# executable path is not enough to identify the intended instance. The native
# check reads the process's original environment without printing it and
# refuses if identity cannot be determined; it is not a security boundary
# against other processes owned by the same user.
agentoc_is_server_pid() {
  agentoc_is_packaged_server_pid "$1" || return 1
  "$AGENTOC_RESOURCES_DIR/runtime/agentoc-macos-instance-check" "$1" "$HOME" \
    "$(agentoc_config_dir)" "${AGENTOC_INSTANCE_ROOT:-}" >/dev/null 2>&1
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

# Compare the service's startup snapshot with this installed bundle. A running
# process can retain the same pathname across an app replacement, so pathname
# and a generic health check alone do not prove that the new build is running.
agentoc_server_matches_installed_build() {
  local port="${CHAT_PORT:-7690}"
  [ -s "$AGENTOC_APP_DIR/.agentoc-package-version" ] && [ -s "$AGENTOC_APP_DIR/.agentoc-source-commit" ] || return 1
  curl -fsS --max-time 3 --max-filesize 65536 "http://127.0.0.1:${port}/api/build-info" 2>/dev/null |
    "$AGENTOC_NODE_BIN" -e '
      const fs = require("fs");
      let body = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", chunk => { body += chunk; if (body.length > 65536) process.exit(1); });
      process.stdin.on("end", () => {
        try {
          const value = JSON.parse(body);
          const version = fs.readFileSync(process.argv[1], "utf8").trim();
          const commit = fs.readFileSync(process.argv[2], "utf8").trim();
          if (!version || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit) ||
              value.servicePackageVersion !== version || value.servicePackageSourceCommit !== commit) process.exit(1);
        } catch { process.exit(1); }
      });
    ' "$AGENTOC_APP_DIR/.agentoc-package-version" "$AGENTOC_APP_DIR/.agentoc-source-commit"
}

# Provision first-run credentials exactly like the Debian postinst:
# auth.json (scrypt owner credentials) + instance.env (session secret,
# local-mode cookies, connectivity defaults). Both live in the instance
# config dir so upgrades never overwrite user edits.
agentoc_first_run_bootstrap() {
  local config_dir result
  config_dir="$(agentoc_config_dir)"
  # Publish complete files exclusively. Concurrent Finder and LaunchAgent
  # starts must converge on the same secret and the same owner password.
  result="$("$AGENTOC_NODE_BIN" - "$config_dir" <<'NODE'
const { mkdirSync, writeFileSync, readFileSync, linkSync, unlinkSync, statSync, chmodSync } = require('fs');
const { join } = require('path');
const { randomBytes, scryptSync } = require('crypto');
const dir = process.argv[2];
mkdirSync(dir, { recursive: true, mode: 0o700 });
const path = (name) => join(dir, name);
function existing(file) {
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size === 0) throw new Error(`Existing ${file} is empty or not a file`);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
function publish(file, content) {
  const tmp = path(`.bootstrap-${randomBytes(16).toString('hex')}`);
  try {
    writeFileSync(tmp, content, { flag: 'wx', mode: 0o600 });
    try { linkSync(tmp, file); return true; }
    catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  } finally { try { unlinkSync(tmp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
const envFile = path('instance.env');
if (!existing(envFile)) {
  const secret = randomBytes(32).toString('hex');
  const created = publish(envFile, [
    '# AgentoC macOS instance environment (sourced by the app launcher).',
    '# Edits survive app upgrades. Restart the app after changing values.',
    `AGENTOC_AUTH_SESSION_SECRET=${secret}`,
    'SECURE_COOKIES=0',
    'AGENTOC_ACCOUNTS_URL=https://agentoc.andyscodexagent.cyou/accounts',
    'AGENTOC_ACCOUNTS_JWKS_URL=https://agentoc.andyscodexagent.cyou/accounts/.well-known/jwks.json',
    'AGENTOC_ACCOUNTS_ISSUER=https://agentoc.andyscodexagent.cyou',
    'AGENTOC_TURN_BROKER_URL=https://agentoc.andyscodexagent.cyou/turn',
    'AGENTOC_P2P_SIGNALING_URL=https://agentoc.andyscodexagent.cyou/signal',
    '',
  ].join('\n'));
  if (!created && !existing(envFile)) throw new Error(`Cannot publish ${envFile}`);
}
const authFile = path('auth.json');
const credsFile = path('owner-credentials.txt');
if (!existing(authFile)) {
  const candidate = randomBytes(12).toString('hex');
  const creds = [
    '# AgentoC owner login (generated on first run)',
    `# Web: http://127.0.0.1:${process.env.CHAT_PORT || '7690'}/`,
    'username: owner', `password: ${candidate}`,
    '# Change it in Settings after first login, then delete this file.', '',
  ].join('\n');
  const createdCredentials = publish(credsFile, creds);
  // Recovery after interruption reuses the already-published credentials;
  // never silently overwrite an unrelated or incomplete existing file.
  const current = readFileSync(credsFile, 'utf8');
  const password = /^password: ([^\r\n]{1,1024})$/m.exec(current)?.[1];
  if (!/^username: owner$/m.test(current) || !password) throw new Error(`Cannot recover credentials from ${credsFile}`);
  chmodSync(credsFile, 0o600);
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex');
  const passwordHash = `scrypt$16384$8$1$${salt.toString('hex')}$${hash}`;
  const createdAuth = publish(authFile, JSON.stringify({ username: 'owner', passwordHash }, null, 2) + '\n');
  if (!createdAuth && !existing(authFile)) throw new Error(`Cannot publish ${authFile}`);
  if (createdCredentials || createdAuth) process.stdout.write('credentials\n');
}
NODE
)" || return 1
  if [ "$result" = credentials ]; then
    agentoc_log "generated owner credentials: $config_dir/owner-credentials.txt"
    open -t "$config_dir/owner-credentials.txt" 2>/dev/null || true
  fi
}

agentoc_source_instance_env() {
  local env_file
  env_file="$(agentoc_config_dir)/instance.env"
  if [ -s "$env_file" ]; then
    set -a
    # shellcheck disable=SC1090
    if ! source "$env_file"; then
      set +a
      return 1
    fi
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
  PATH="$bin_dir:$AGENTOC_RESOURCES_DIR:${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"
  export AGENTOC_PACKAGED_HARNESS_ROOT PATH
}
