#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_dir="$(mktemp -d "${TMPDIR:-/tmp}/ragent-mac-launcher.XXXXXX")"
server_pid=''
other_pid=''
cleanup() {
  [ -z "$server_pid" ] || kill "$server_pid" 2>/dev/null || true
  [ -z "$other_pid" ] || kill "$other_pid" 2>/dev/null || true
  rm -rf "$test_dir"
}
trap cleanup EXIT
contents="$test_dir/Ragent App.app/Contents"
mkdir -p "$contents/MacOS" "$contents/Resources/runtime" "$contents/Resources/app" "$test_dir/bin" "$test_dir/home"
cp "$root/packaging/macos/Info.plist" "$contents/Info.plist"
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$contents/Info.plist")" = cloud.agenton.ragent ]
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$contents/Info.plist")" = Ragent ]
cp "$root/packaging/macos/AgentoC" "$contents/MacOS/Ragent"
cp "$root/packaging/macos/agentoc-env.sh" "$contents/Resources/ragent-env.sh"
cp "$root/packaging/macos/agentoc-stop" "$contents/Resources/ragent-stop"
chmod 0755 "$contents/MacOS/Ragent" "$contents/Resources/ragent-stop"
xcrun clang -Wall -Wextra -Werror -mmacosx-version-min=13.0 "$root/native/macos-instance-check.c" -o "$contents/Resources/runtime/agentoc-macos-instance-check"
ln -s "$(command -v node)" "$contents/Resources/runtime/node"
printf '#!/bin/sh\nexit 0\n' > "$contents/Resources/runtime/codex"
cp "$contents/Resources/runtime/codex" "$contents/Resources/runtime/claude"
chmod 0755 "$contents/Resources/runtime/"{codex,claude}
cat > "$contents/Resources/app/chat-server.mjs" <<'EOF'
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const version = readFileSync(new URL('.agentoc-package-version', import.meta.url), 'utf8').trim();
const commit = readFileSync(new URL('.agentoc-source-commit', import.meta.url), 'utf8').trim();
createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200); res.end(); return; }
  if (req.url === '/api/build-info') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ servicePackageVersion: version, servicePackageSourceCommit: commit })); return; }
  res.writeHead(404); res.end();
}).listen(Number(process.env.CHAT_PORT), '127.0.0.1');
EOF
printf '%s\n' 0.0.1 > "$contents/Resources/app/.agentoc-package-version"
printf '%040d\n' 1 > "$contents/Resources/app/.agentoc-source-commit"
cat > "$test_dir/bin/open" <<'EOF'
#!/bin/sh
exit 0
EOF
cat > "$test_dir/bin/osascript" <<'EOF'
#!/bin/sh
printf '%s\n' "$@" > "$QA_ALERT_ARGS"
cat >/dev/null
EOF
chmod 0755 "$test_dir/bin/open"
chmod 0755 "$test_dir/bin/osascript"
export HOME="$test_dir/home" AGENTOC_CONFIG_DIR="$test_dir/config" PATH="$test_dir/bin:$PATH" QA_ALERT_ARGS="$test_dir/alert"
port="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
export CHAT_PORT="$port"
"$contents/MacOS/Ragent"
server_pid="$(cat "$AGENTOC_CONFIG_DIR/agentoc.pid")"
kill -0 "$server_pid"
curl -fsS -o /dev/null "http://127.0.0.1:$port/healthz"
# A second configuration using the same port must neither attach to nor stop
# the first instance, even though both use the same installed executable.
other_config="$test_dir/other-config"
mkdir -p "$other_config"
if AGENTOC_CONFIG_DIR="$other_config" "$contents/Resources/ragent-stop" >"$test_dir/other-stop" 2>&1; then
  echo 'stop accepted another instance on the configured port' >&2
  exit 1
fi
grep -Fq 'another instance or its identity could not be verified' "$test_dir/other-stop"
kill -0 "$server_pid"
if AGENTOC_INSTANCE_ROOT="$test_dir/other-instance" "$contents/Resources/ragent-stop" >"$test_dir/other-root-stop" 2>&1; then
  echo 'stop accepted another instance root' >&2
  exit 1
fi
grep -Fq 'another instance or its identity could not be verified' "$test_dir/other-root-stop"
kill -0 "$server_pid"
node -e 'const fs=require("fs");if((fs.statSync(process.argv[1]).mode & 0o777)!==0o600)process.exit(1)' "$AGENTOC_CONFIG_DIR/chat-server.log"
# A configuration load error must not make stop proceed with inherited or
# default settings, which could stop a different instance.
cp "$AGENTOC_CONFIG_DIR/instance.env" "$test_dir/instance.env.before-stop"
printf '\nfalse\n' >> "$AGENTOC_CONFIG_DIR/instance.env"
if "$contents/Resources/ragent-stop" >"$test_dir/stop-error" 2>&1; then
  echo 'stop accepted a failing instance configuration' >&2
  exit 1
fi
grep -Fq 'no service was stopped' "$test_dir/stop-error"
kill -0 "$server_pid"
cp "$test_dir/instance.env.before-stop" "$AGENTOC_CONFIG_DIR/instance.env"
# On upgrade, the launcher invokes migration before attaching to the service.
mkdir -p "$HOME/Library/LaunchAgents"
: > "$HOME/Library/LaunchAgents/cloud.agenton.agentoc.plist"
export QA_MIGRATION_ARGS="$test_dir/migration-args"
cat > "$contents/Resources/ragent-login.cjs" <<'EOF'
require('node:fs').writeFileSync(process.env.QA_MIGRATION_ARGS, JSON.stringify(process.argv.slice(2)));
EOF
"$contents/MacOS/Ragent"
node -e 'const a=JSON.parse(require("fs").readFileSync(process.argv[1]));if(a[0]!=="migrate" || a[3]!==process.env.CHAT_PORT)process.exit(1)' "$QA_MIGRATION_ARGS"
rm "$HOME/Library/LaunchAgents/cloud.agenton.agentoc.plist"
[ "$(cat "$AGENTOC_CONFIG_DIR/agentoc.pid")" = "$server_pid" ]
# Replacing the bundle while a service retains the same command path must not
# silently open the old service, even if only the source revision changed.
printf '%040d\n' 2 > "$contents/Resources/app/.agentoc-source-commit"
if "$contents/MacOS/Ragent" >/dev/null 2>&1; then
  echo 'launcher accepted a service from another source revision' >&2
  exit 1
fi
grep -Fq '当前应用版本不一致' "$QA_ALERT_ARGS"
kill -0 "$server_pid"
printf '%040d\n' 1 > "$contents/Resources/app/.agentoc-source-commit"
printf '%s\n' 0.0.2 > "$contents/Resources/app/.agentoc-package-version"
if "$contents/MacOS/Ragent" >/dev/null 2>&1; then
  echo 'launcher accepted a service from another package version' >&2
  exit 1
fi
kill -0 "$server_pid"
printf '%s\n' 0.0.1 > "$contents/Resources/app/.agentoc-package-version"
"$contents/Resources/ragent-stop"
server_pid=''

# LaunchAgent-style starts need not have a PID file. The stop command must
# wait for the actual listening service to exit before reporting success.
"$contents/MacOS/Ragent"
server_pid="$(cat "$AGENTOC_CONFIG_DIR/agentoc.pid")"
rm "$AGENTOC_CONFIG_DIR/agentoc.pid"
"$contents/Resources/ragent-stop"
if kill -0 "$server_pid" 2>/dev/null; then
  echo 'stop returned while the service was still running' >&2
  exit 1
fi
server_pid=''

# A foreign process on the port must neither be treated as our service nor
# be killed when launching or stopping Ragent.
node -e 'require("http").createServer((q,s)=>s.end("other")).listen(+process.env.CHAT_PORT,"127.0.0.1")' &
other_pid=$!
for _ in $(seq 1 50); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$port/" 2>/dev/null; then break; fi
  sleep 0.1
done
if "$contents/MacOS/Ragent"; then
  echo 'launcher accepted an unrelated service on its port' >&2
  exit 1
fi
grep -Fq "端口 $port" "$QA_ALERT_ARGS"
"$contents/Resources/ragent-stop"
kill -0 "$other_pid"

export AGENTOC_CONFIG_DIR="$test_dir/incomplete-config"
mkdir -p "$AGENTOC_CONFIG_DIR"
: > "$AGENTOC_CONFIG_DIR/instance.env"
if "$contents/MacOS/Ragent" >/dev/null 2>&1; then
  echo 'launcher accepted incomplete existing configuration' >&2
  exit 1
fi
grep -Fq '无法初始化本地配置或凭据' "$QA_ALERT_ARGS"
[ ! -s "$AGENTOC_CONFIG_DIR/instance.env" ]
printf '%s\n' 'macOS launcher lifecycle checks passed'
