#!/bin/bash
# Restart Ragent services.
# Usage:
#   restart.sh          — restart all services
#   restart.sh chat     — restart owner + all guest chat surfaces
#   restart.sh tunnel   — restart only cloudflared
#   restart.sh bridge   — restart only the natapp prefix bridge

set -e

SERVICE="${1:-all}"
FORCE="${2:-}"
RESTART_DRAIN_ACTIVE=0

end_restart_drain() {
  if [[ "$RESTART_DRAIN_ACTIVE" == "1" ]]; then
    node "$(dirname "$0")/cli.js" restart-check --end >/dev/null 2>&1 || true
  fi
}

begin_restart_drain() {
  local args=(restart-check)
  if [[ "$FORCE" == "--force" ]]; then
    args+=(--force)
  fi
  node "$(dirname "$0")/cli.js" "${args[@]}"
  RESTART_DRAIN_ACTIVE=1
  trap end_restart_drain EXIT
}

# Detect OS
if [[ "$(uname)" == "Darwin" ]]; then
    OS_TYPE="macos"
else
    OS_TYPE="linux"
fi

# ── macOS: launchctl ──────────────────────────────────────────────────────────
restart_launchd() {
  local label="$1"
  local plist="$HOME/Library/LaunchAgents/${label}.plist"
  local name="$2"
  local uid
  uid="$(id -u)"
  local launchctl_line
  local pid

  if [ ! -f "$plist" ]; then
    echo "  $name: plist not found, skipping"
    return
  fi

  if launchctl list | grep -q "$label"; then
    launchctl kickstart -k "gui/${uid}/${label}" 2>/dev/null || true
    sleep 1
    launchctl_line="$(launchctl list | awk -v target="$label" '$3 == target { print; exit }')"
    pid="$(printf '%s\n' "$launchctl_line" | awk 'NF { print $1 }')"
    if [ -n "$pid" ]; then
      echo "  $name: restarted (pid=$pid)"
    else
      echo "  $name: restarted"
    fi
  else
    launchctl load "$plist" 2>/dev/null
    echo "  $name: loaded"
  fi
}

restart_all_chat_launchd() {
  local launch_agents_dir="$HOME/Library/LaunchAgents"
  local labels=()
  local plist

  if [ -f "$launch_agents_dir/com.chatserver.claude.plist" ]; then
    labels+=("com.chatserver.claude")
  fi

  for plist in "$launch_agents_dir"/com.chatserver.*.plist; do
    [ -e "$plist" ] || continue
    if [ "$plist" = "$launch_agents_dir/com.chatserver.claude.plist" ]; then
      continue
    fi
    labels+=("$(basename "$plist" .plist)")
  done

  if [ "${#labels[@]}" -eq 0 ]; then
    echo "  chat surfaces: no launch agents found, skipping"
    return
  fi

  echo "  chat surfaces: restarting ${#labels[@]} services"
  for label in "${labels[@]}"; do
    restart_launchd "$label" "$label"
  done
}

# ── Linux: systemd ────────────────────────────────────────────────────────────
linux_system_unit_exists() {
  local unit="$1"
  systemctl list-unit-files "${unit}.service" &>/dev/null || systemctl status "${unit}.service" &>/dev/null
}

linux_user_unit_exists() {
  local unit="$1"
  systemctl --user list-unit-files "${unit}.service" &>/dev/null || systemctl --user status "${unit}.service" &>/dev/null
}

linux_resolve_owner_chat_unit() {
  if linux_system_unit_exists "ragent"; then
    echo "system:ragent"
    return 0
  fi
  if linux_system_unit_exists "ragent-promoted"; then
    echo "system:ragent-promoted"
    return 0
  fi
  if linux_user_unit_exists "ragent-chat"; then
    echo "user:ragent-chat"
    return 0
  fi
  return 1
}

restart_linux_unit() {
  local scope="$1"
  local unit="$2"
  local name="$3"
  local journal_hint

  if [[ "$scope" == "user" ]]; then
    systemctl --user restart "${unit}.service" 2>/dev/null && \
      echo "  $name: restarted" || \
      echo "  $name: failed to restart (check: journalctl --user -u ${unit})"
    return
  fi

  journal_hint="journalctl -u ${unit} -n 50"
  if restart_linux_systemctl restart "${unit}.service" 2>/dev/null; then
    echo "  $name: restarted"
    return 0
  fi
  echo "  $name: failed to restart (check: ${journal_hint})" >&2
  return 1
}

# Root-owned units may need elevation when restart.sh runs as the service
# user; -S reads the password from stdin only when sudo actually prompts.
restart_linux_systemctl() {
  if [[ "$(id -u)" -eq 0 ]]; then
    systemctl "$@"
    return
  fi
  sudo -S -p "" systemctl "$@"
}

# Inherit provider-mode hints from the running service so --stop/--verify
# see the same runtime the service was launched with.
load_linux_service_runtime_environment() {
  local service_pid service_environment entry
  service_pid="$(systemctl show ragent.service -p MainPID --value 2>/dev/null || true)"
  [[ "$service_pid" =~ ^[0-9]+$ ]] || return 0
  service_environment="/proc/${service_pid}/environ"
  [[ -r "$service_environment" ]] || return 0
  while IFS= read -r entry; do
    case "$entry" in
      RAGENT_CC_SWITCH_COMMAND=*|RAGENT_CODEX_PROXY_PORT=*)
        export "$entry"
        ;;
    esac
  done < <(tr '\0' '\n' < "$service_environment")
}

linux_packaged_unit_exists() {
  local unit="$1"
  systemctl list-unit-files "${unit}.service" --no-legend --plain 2>/dev/null \
    | grep -Fq "${unit}.service"
}

restart_linux_provider_runtime() {
  local provider_script="$(dirname "$0")/scripts/restart-provider-runtime.mjs"
  load_linux_service_runtime_environment
  if [[ -f "$provider_script" ]]; then
    node "$provider_script" --stop || \
      echo "  provider runtime: stale provider cleanup failed; continuing with service restart"
  fi

  local units=(
    ragent-privileged-executor
    ragent-runner-lifecycle
    ragent-runner-supervisor
  )
  local existing=()
  local unit
  for unit in "${units[@]}"; do
    if linux_packaged_unit_exists "$unit"; then
      existing+=("$unit")
    fi
  done
  if [[ "${#existing[@]}" -eq 0 ]]; then
    return
  fi

  echo "  provider/runtime services: restarting ${#existing[@]} services"
  for unit in "${existing[@]}"; do
    restart_linux_unit "system" "$unit" "$unit"
  done
}

verify_linux_provider_runtime() {
  local provider_script="$(dirname "$0")/scripts/restart-provider-runtime.mjs"
  load_linux_service_runtime_environment
  if [[ -f "$provider_script" ]]; then
    node "$provider_script" --verify || return 1
  fi
  local units=(
    ragent-privileged-executor
    ragent-runner-lifecycle
    ragent-runner-supervisor
  )
  local unit
  for unit in "${units[@]}"; do
    if linux_packaged_unit_exists "$unit" && ! restart_linux_systemctl is-active --quiet "${unit}.service"; then
      echo "  $unit: not active after restart" >&2
      return 1
    fi
  done
}

restart_linux_chat_surfaces() {
  local owner
  owner="$(linux_resolve_owner_chat_unit || true)"
  if [[ -z "$owner" ]]; then
    echo "  chat-server: service unit not found, skipping"
    return
  fi

  local owner_scope="${owner%%:*}"
  local owner_unit="${owner#*:}"
  if [[ "$owner_scope" == "system" ]]; then
    restart_linux_provider_runtime
  fi
  restart_linux_unit "$owner_scope" "$owner_unit" "chat-server"

  if [[ "$owner_scope" == "system" ]]; then
    local guest_units=()
    while IFS= read -r unit; do
      [[ -n "$unit" ]] && guest_units+=("$unit")
    done < <(systemctl list-unit-files 'ragent-guest@*.service' --no-legend --plain 2>/dev/null | awk '{print $1}' | sed 's/\.service$//')

    if [[ "${#guest_units[@]}" -gt 0 ]]; then
      echo "  guest chat surfaces: restarting ${#guest_units[@]} services"
      local guest_unit
      for guest_unit in "${guest_units[@]}"; do
        restart_linux_unit "system" "$guest_unit" "$guest_unit"
      done
    fi
  fi
}

# ── Dispatch ──────────────────────────────────────────────────────────────────
restart_service() {
  local name="$1"
  local launchd_label="$2"
  local systemd_unit="$3"

  if [[ "$OS_TYPE" == "macos" ]]; then
    restart_launchd "$launchd_label" "$name"
  else
    restart_linux_unit "user" "$systemd_unit" "$name"
  fi
}

restart_linux_tunnel() {
  if linux_system_unit_exists "ragent-quick-tunnel"; then
    restart_linux_unit "system" "ragent-quick-tunnel" "cloudflared quick tunnel"
    return
  fi
  if linux_system_unit_exists "ragent-tunnel-client"; then
    restart_linux_unit "system" "ragent-tunnel-client" "Ragent tunnel client"
    return
  fi
  restart_service "cloudflared" "com.cloudflared.tunnel" "ragent-tunnel"
}

print_quick_tunnel_url() {
  if [[ "$OS_TYPE" != "linux" ]] || ! linux_system_unit_exists "ragent-quick-tunnel"; then
    return
  fi
  sleep 5
  local tunnel_url
  local access_token
  tunnel_url="$(grep -E '^RAGENT_PUBLIC_BASE_URL=' /etc/ragent/ragent.env 2>/dev/null | tail -1 | cut -d= -f2-)"
  if [[ -z "$tunnel_url" ]]; then
    tunnel_url="$(grep -Eho 'https://[^[:space:]]+trycloudflare\.com' /var/log/ragent/cloudflared.log /var/log/ragent/cloudflared.error.log 2>/dev/null | tail -1 || true)"
  fi
  access_token="$(node -e 'try { process.stdout.write(JSON.parse(require("fs").readFileSync(process.env.HOME + "/.config/ragent/auth.json", "utf8")).token || "") } catch {}' 2>/dev/null)"
  if [[ -n "$tunnel_url" && -n "$access_token" ]]; then
    echo ""
    echo "Current access URL:"
    echo "  ${tunnel_url}/?token=${access_token}"
  fi
}

case "$SERVICE" in
  chat)
    begin_restart_drain
    echo "Restarting all chat surfaces..."
    if [[ "$OS_TYPE" == "macos" ]]; then
      restart_all_chat_launchd
    else
      restart_linux_chat_surfaces
    fi
    ;;
  tunnel)
    echo "Restarting cloudflared..."
    if [[ "$OS_TYPE" == "macos" ]]; then
      restart_service "cloudflared" "com.cloudflared.tunnel" "ragent-tunnel"
    else
      restart_linux_tunnel
      print_quick_tunnel_url
    fi
    ;;
  bridge)
    echo "Restarting prefix bridge..."
    restart_service "prefix bridge" "com.ragent.natapp.dual-proxy" "ragent-prefix-bridge"
    ;;
  all)
    begin_restart_drain
    echo "Restarting all services..."
    if [[ "$OS_TYPE" == "macos" ]]; then
      restart_all_chat_launchd
      restart_service "cloudflared" "com.cloudflared.tunnel" "ragent-tunnel"
    else
      restart_linux_chat_surfaces
      restart_linux_tunnel
      print_quick_tunnel_url
    fi
    ;;
  *)
    echo "Unknown service: $SERVICE"
    echo "Usage: restart.sh [chat|tunnel|bridge|all]"
    exit 1
    ;;
esac

echo "Done!"
