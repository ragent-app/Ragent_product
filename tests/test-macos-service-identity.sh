#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root/packaging/macos/ragent-env.sh"
RAGENT_NODE_BIN='/Applications/Ragent App.app/Contents/Resources/runtime/node'
RAGENT_APP_DIR='/Applications/Ragent App.app/Contents/Resources/app'
test_dir="$(mktemp -d "${TMPDIR:-/tmp}/ragent-mac-identity.XXXXXX")"
trap 'rm -rf "$test_dir"' EXIT
RAGENT_PID_FILE="$test_dir/pid"
ps() {
  case "$3" in
    123) printf '%s\n' "$RAGENT_NODE_BIN $RAGENT_APP_DIR/chat-server.mjs" ;;
    456) printf '%s\n' '/usr/bin/node /other/chat-server.mjs' ;;
  esac
}
lsof() { printf '%s\n' 456 123; }
mkdir -p "$test_dir/runtime"
RAGENT_RESOURCES_DIR="$test_dir"
cat > "$test_dir/runtime/ragent-macos-instance-check" <<'EOF'
#!/bin/sh
exit 0
EOF
chmod 0755 "$test_dir/runtime/ragent-macos-instance-check"
printf '123\n' > "$RAGENT_PID_FILE"
[ "$(ragent_server_pid)" = 123 ]
ragent_server_running
printf '456\n' > "$RAGENT_PID_FILE"
if ragent_server_pid >/dev/null; then exit 1; fi
printf '%s\n' '-1' > "$RAGENT_PID_FILE"
if ragent_server_pid >/dev/null; then exit 1; fi
lsof() { printf '%s\n' 456; }
if ragent_server_running; then exit 1; fi
printf '%s\n' 'macOS service identity checks passed'
