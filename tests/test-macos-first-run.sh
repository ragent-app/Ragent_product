#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_dir="$(mktemp -d "${TMPDIR:-/tmp}/ragent-mac-bootstrap.XXXXXX")"
trap 'rm -rf "$test_dir"' EXIT
export HOME="$test_dir/home" AGENTOC_CONFIG_DIR="$test_dir/config"
export QA_REAL_NODE="$(command -v node)" QA_ARGS="$test_dir/node-args"
mkdir -p "$HOME"
cat > "$test_dir/node" <<'EOF'
#!/bin/bash
printf '%s\n' "$@" >> "$QA_ARGS"
exec "$QA_REAL_NODE" "$@"
EOF
chmod 0755 "$test_dir/node"
open() { :; }
source "$root/packaging/macos/agentoc-env.sh"
AGENTOC_NODE_BIN="$test_dir/node"
umask 022
agentoc_first_run_bootstrap
[ "$(umask)" = 0022 ]
grep -Fxq 'AGENTOC_ACCOUNTS_URL=https://ragent.agentoncloud.com/accounts' "$AGENTOC_CONFIG_DIR/instance.env"
grep -Fxq 'AGENTOC_ACCOUNTS_JWKS_URL=https://ragent.agentoncloud.com/accounts/.well-known/jwks.json' "$AGENTOC_CONFIG_DIR/instance.env"
grep -Fxq 'AGENTOC_TURN_BROKER_URL=https://ragent.agentoncloud.com/turn' "$AGENTOC_CONFIG_DIR/instance.env"
grep -Fxq 'AGENTOC_P2P_SIGNALING_URL=https://ragent.agentoncloud.com/signal' "$AGENTOC_CONFIG_DIR/instance.env"
grep -Fxq 'AGENTOC_ACCOUNTS_ISSUER=https://agentoc.andyscodexagent.cyou' "$AGENTOC_CONFIG_DIR/instance.env"
cp "$AGENTOC_CONFIG_DIR/instance.env" "$test_dir/env-before"
cp "$AGENTOC_CONFIG_DIR/auth.json" "$test_dir/auth-before"
cp "$AGENTOC_CONFIG_DIR/owner-credentials.txt" "$test_dir/credentials-before"
agentoc_first_run_bootstrap
cmp "$test_dir/env-before" "$AGENTOC_CONFIG_DIR/instance.env"
cmp "$test_dir/auth-before" "$AGENTOC_CONFIG_DIR/auth.json"
cmp "$test_dir/credentials-before" "$AGENTOC_CONFIG_DIR/owner-credentials.txt"
validate_credentials() {
"$QA_REAL_NODE" - "$AGENTOC_CONFIG_DIR" "$QA_ARGS" <<'EOF'
const assert = require('assert/strict');
const { readFileSync, statSync } = require('fs');
const { join } = require('path');
const { scryptSync } = require('crypto');
const [dir, args] = process.argv.slice(2);
for (const name of ['auth.json', 'instance.env', 'owner-credentials.txt']) {
  assert.equal(statSync(join(dir, name)).mode & 0o777, 0o600, `${name} permissions`);
}
const credentials = readFileSync(join(dir, 'owner-credentials.txt'), 'utf8');
const password = /^password: (.+)$/m.exec(credentials)?.[1];
assert.ok(password);
assert.ok(!readFileSync(args, 'utf8').includes(password), 'password must not appear in process arguments');
const auth = JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'));
const [kind, n, r, p, salt, hash] = auth.passwordHash.split('$');
assert.equal(auth.username, 'owner');
assert.equal(kind, 'scrypt');
assert.equal(scryptSync(password, Buffer.from(salt, 'hex'), 32, { N: +n, r: +r, p: +p }).toString('hex'), hash);
EOF
}
validate_credentials

# Finder and LaunchAgent may bootstrap the same new profile simultaneously.
export AGENTOC_CONFIG_DIR="$test_dir/concurrent-config"
pids=()
for _ in $(seq 1 12); do
  agentoc_first_run_bootstrap >/dev/null &
  pids+=("$!")
done
for pid in "${pids[@]}"; do wait "$pid"; done
validate_credentials
cp "$AGENTOC_CONFIG_DIR/instance.env" "$test_dir/concurrent-env"
cp "$AGENTOC_CONFIG_DIR/owner-credentials.txt" "$test_dir/concurrent-creds"

# An interruption after the credentials were published must be recoverable
# without changing the password or the already-established session secret.
rm "$AGENTOC_CONFIG_DIR/auth.json"
agentoc_first_run_bootstrap >/dev/null
cmp "$test_dir/concurrent-env" "$AGENTOC_CONFIG_DIR/instance.env"
cmp "$test_dir/concurrent-creds" "$AGENTOC_CONFIG_DIR/owner-credentials.txt"
validate_credentials

# Existing but empty configuration is not silently replaced.
export AGENTOC_CONFIG_DIR="$test_dir/incomplete-config"
mkdir -p "$AGENTOC_CONFIG_DIR"
: > "$AGENTOC_CONFIG_DIR/instance.env"
if agentoc_first_run_bootstrap >/dev/null 2>&1; then
  echo 'empty existing configuration unexpectedly accepted' >&2
  exit 1
fi
[ ! -s "$AGENTOC_CONFIG_DIR/instance.env" ]
printf '%s\n' 'macOS first-run credential checks passed'
