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
cp "$root/packaging/macos/"{AgentoC,agentoc-env.sh,agentoc-stop} "$contents/MacOS/"
chmod 0755 "$contents/MacOS/AgentoC" "$contents/MacOS/agentoc-stop"
ln -s "$(command -v node)" "$contents/Resources/runtime/node"
printf '#!/bin/sh\nexit 0\n' > "$contents/Resources/runtime/codex"
cp "$contents/Resources/runtime/codex" "$contents/Resources/runtime/claude"
chmod 0755 "$contents/Resources/runtime/"{codex,claude}
cat > "$contents/Resources/app/chat-server.mjs" <<'EOF'
import { createServer } from 'node:http';
createServer((req, res) => { res.writeHead(req.url === '/healthz' ? 200 : 404); res.end(); })
  .listen(Number(process.env.CHAT_PORT), '127.0.0.1');
EOF
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
"$contents/MacOS/AgentoC"
server_pid="$(cat "$AGENTOC_CONFIG_DIR/agentoc.pid")"
kill -0 "$server_pid"
curl -fsS -o /dev/null "http://127.0.0.1:$port/healthz"
node -e 'const fs=require("fs");if((fs.statSync(process.argv[1]).mode & 0o777)!==0o600)process.exit(1)' "$AGENTOC_CONFIG_DIR/chat-server.log"
"$contents/MacOS/AgentoC"
[ "$(cat "$AGENTOC_CONFIG_DIR/agentoc.pid")" = "$server_pid" ]
"$contents/MacOS/agentoc-stop"
server_pid=''

# A foreign process on the port must neither be treated as our service nor
# be killed when launching or stopping Ragent.
node -e 'require("http").createServer((q,s)=>s.end("other")).listen(+process.env.CHAT_PORT,"127.0.0.1")' &
other_pid=$!
for _ in $(seq 1 50); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$port/" 2>/dev/null; then break; fi
  sleep 0.1
done
if "$contents/MacOS/AgentoC"; then
  echo 'launcher accepted an unrelated service on its port' >&2
  exit 1
fi
grep -Fq "端口 $port" "$QA_ALERT_ARGS"
"$contents/MacOS/agentoc-stop"
kill -0 "$other_pid"
printf '%s\n' 'macOS launcher lifecycle checks passed'
