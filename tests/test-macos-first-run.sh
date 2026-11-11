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
cp "$AGENTOC_CONFIG_DIR/auth.json" "$test_dir/auth-before"
cp "$AGENTOC_CONFIG_DIR/owner-credentials.txt" "$test_dir/credentials-before"
agentoc_first_run_bootstrap
cmp "$test_dir/auth-before" "$AGENTOC_CONFIG_DIR/auth.json"
cmp "$test_dir/credentials-before" "$AGENTOC_CONFIG_DIR/owner-credentials.txt"
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
printf '%s\n' 'macOS first-run credential checks passed'
