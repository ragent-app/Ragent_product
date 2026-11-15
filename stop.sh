#!/bin/bash
set -e
echo "Stopping Ragent services..."

if [[ "$(uname)" == "Darwin" ]]; then
  launchctl unload ~/Library/LaunchAgents/com.chatserver.claude.plist 2>/dev/null || echo "chat-server not loaded"
  if [ -f ~/Library/LaunchAgents/com.cloudflared.tunnel.plist ]; then
    launchctl unload ~/Library/LaunchAgents/com.cloudflared.tunnel.plist 2>/dev/null || echo "cloudflared not loaded"
  fi
if [ -f ~/Library/LaunchAgents/com.ragent.natapp.dual-proxy.plist ]; then
  launchctl unload ~/Library/LaunchAgents/com.ragent.natapp.dual-proxy.plist 2>/dev/null || echo "natapp prefix bridge not loaded"
fi
else
  linux_system_unit_exists() {
    local unit="$1"
    systemctl list-unit-files "${unit}.service" &>/dev/null 2>&1 || systemctl status "${unit}.service" &>/dev/null 2>&1
  }

  owner_unit="ragent"
  if ! linux_system_unit_exists "$owner_unit" && linux_system_unit_exists "ragent-promoted"; then
    owner_unit="ragent-promoted"
  fi

  sudo systemctl stop ragent-quick-tunnel.service 2>/dev/null || true
  sudo systemctl stop "${owner_unit}.service" 2>/dev/null || echo "chat-server not running"
  sudo systemctl stop ragent-runner-supervisor.service 2>/dev/null || true
  systemctl --user stop ragent-tunnel.service 2>/dev/null || true
fi

echo "Services stopped!"
