#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTBOUND_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/ragent/agent-mailbox/outbound.json"
BRIDGE_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/ragent/agent-mailbox/bridge.json"

cd "$ROOT_DIR"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi

if ! command -v npx >/dev/null 2>&1; then
  echo "npx is required" >&2
  exit 1
fi

OUTBOUND_API_TOKEN="${OUTBOUND_API_TOKEN:-}"
if [ -z "$OUTBOUND_API_TOKEN" ] && [ -f "$OUTBOUND_FILE" ]; then
  OUTBOUND_API_TOKEN="$(jq -r '.workerToken // empty' "$OUTBOUND_FILE")"
fi

MAILBOX_BRIDGE_TOKEN="${MAILBOX_BRIDGE_TOKEN:-}"
if [ -z "$MAILBOX_BRIDGE_TOKEN" ] && [ -f "$BRIDGE_FILE" ]; then
  MAILBOX_BRIDGE_TOKEN="$(jq -r '.cloudflareWebhookToken // empty' "$BRIDGE_FILE")"
fi

if [ ! -d node_modules ]; then
  npm install
fi

npx wrangler whoami >/dev/null
if [ -n "$OUTBOUND_API_TOKEN" ]; then
  printf '%s' "$OUTBOUND_API_TOKEN" | npx wrangler secret put OUTBOUND_API_TOKEN
fi
if [ -n "$MAILBOX_BRIDGE_TOKEN" ]; then
  printf '%s' "$MAILBOX_BRIDGE_TOKEN" | npx wrangler secret put MAILBOX_BRIDGE_TOKEN
fi
npx wrangler deploy
