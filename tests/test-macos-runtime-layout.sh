#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_dir="$(mktemp -d "${TMPDIR:-/tmp}/ragent-mac-runtime.XXXXXX")"
trap 'rm -rf "$test_dir"' EXIT
bundle="$test_dir/Ragent App.app/Contents/Resources"
mkdir -p "$bundle/runtime" "$bundle/app/bin" "$bundle/app/vendor/codex/bin"
cp "$root/packaging/macos/runtime-codex" "$bundle/runtime/codex"
cp "$root/packaging/macos/runtime-claude" "$bundle/runtime/claude"
cat > "$bundle/runtime/node" <<'EOF'
#!/bin/sh
printf '%s\n' "$@" > "$QA_RECORD"
EOF
cat > "$bundle/app/bin/claude" <<'EOF'
#!/bin/sh
printf '%s\n' "$@" > "$QA_RECORD"
EOF
chmod 0755 "$bundle/runtime/node" "$bundle/runtime/codex" "$bundle/runtime/claude" "$bundle/app/bin/claude"
export QA_RECORD="$test_dir/record"
source "$root/packaging/macos/agentoc-env.sh"
unset AGENTOC_PACKAGED_HARNESS_ROOT
AGENTOC_RESOURCES_DIR="$bundle"
agentoc_ensure_runtime_shims
[ "$AGENTOC_PACKAGED_HARNESS_ROOT" = "$bundle/runtime" ]
# Resolve both commands in a detached-process environment, not just in the
# launcher's shell. macOS has no /opt/agentoc/runtime fallback.
export QA_BUNDLE="$bundle" QA_ROOT="$root" QA_HOME="$test_dir/detached-home"
mkdir -p "$QA_HOME"
node --input-type=module <<'EOF'
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const root = process.env.QA_ROOT;
const { pickRunnerEnvAllowlist } = await import(pathToFileURL(`${root}/lib/runner-env.mjs`));
const env = pickRunnerEnvAllowlist({
  PATH: process.env.PATH, HOME: process.env.QA_HOME,
  AGENTOC_HARNESS_ROOT: `${process.env.QA_HOME}/managed`,
  AGENTOC_PACKAGED_HARNESS_ROOT: `${process.env.QA_BUNDLE}/runtime`,
});
const moduleUrl = pathToFileURL(`${root}/lib/harness-paths.mjs`).href;
const script = `const m = await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(await Promise.all(['codex','claude'].map(x=>m.resolveInternalHarnessCommandPath(x)))))`;
const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
assert.equal(child.status, 0, child.stderr);
assert.deepEqual(JSON.parse(child.stdout.trim()), [`${process.env.QA_BUNDLE}/runtime/codex`, `${process.env.QA_BUNDLE}/runtime/claude`]);
EOF
"$bundle/runtime/codex" 'argument with spaces'
printf '%s\n' "$bundle/runtime/../app/vendor/codex/bin/codex.js" 'argument with spaces' > "$test_dir/expected"
cmp "$test_dir/expected" "$QA_RECORD"
"$bundle/runtime/claude" 'argument with spaces'
printf '%s\n' 'argument with spaces' > "$test_dir/expected"
cmp "$test_dir/expected" "$QA_RECORD"
mv "$test_dir/Ragent App.app" "$test_dir/Moved App.app"
bundle="$test_dir/Moved App.app/Contents/Resources"
"$bundle/runtime/codex" moved
printf '%s\n' "$bundle/runtime/../app/vendor/codex/bin/codex.js" moved > "$test_dir/expected"
cmp "$test_dir/expected" "$QA_RECORD"
printf '%s\n' 'macOS packaged runtime layout checks passed'
