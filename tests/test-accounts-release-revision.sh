#!/bin/bash
# Verify that release metadata cannot misstate the staged Git revision.
set -Eeuo pipefail
builder=${1:?path to build-accounts-release.sh required}
work=$(mktemp -d "${TMPDIR:-/tmp}/ragent-accounts-revision-test.XXXXXXXX")
trap 'rm -rf -- "$work"' EXIT
mkdir -p "$work/bin" "$work/out" "$work/cache" "$work/tree/scripts" "$work/tree/deploy/accounts"
cp -- "$builder" "$work/tree/scripts/build-accounts-release.sh"
printf '[Service]\nExecStart=/usr/bin/true\n' > "$work/tree/deploy/accounts/ragent-accounts.service"
builder="$work/tree/scripts/build-accounts-release.sh"
cat > "$work/bin/node" <<'EOF'
#!/bin/bash
set -eu
destination=
while [[ $# -gt 0 ]]; do
  if [[ $1 == --destination ]]; then destination=$2; shift 2; else shift; fi
done
[[ -n $destination ]]
printf '%s\n' "$QA_STAGED_REVISION" > "$destination/.agentoc-source-commit"
EOF
cat > "$work/bin/npm" <<'EOF'
#!/bin/sh
: > "$QA_NPM_MARKER"
exit 73
EOF
chmod 0755 "$work/bin/node" "$work/bin/npm"
export PATH="$work/bin:$PATH"
export QA_NPM_MARKER="$work/npm-reached"
export RAGENT_ACCOUNTS_RELEASE_VERSION=qa RAGENT_ACCOUNTS_RELEASE_ARCH=amd64
export RAGENT_ACCOUNTS_RELEASE_OUTPUT_DIR="$work/out" RAGENT_ACCOUNTS_NODE_CACHE_DIR="$work/cache"
export RAGENT_ACCOUNTS_SOURCE_REVISION=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
export QA_STAGED_REVISION=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
if bash "$builder" >"$work/output" 2>&1; then echo 'revision mismatch unexpectedly accepted' >&2; exit 1; fi
grep -q 'staged source revision differs' "$work/output"
[[ ! -e $QA_NPM_MARKER ]]
[[ -z $(find "$work/out" -mindepth 1 -print -quit) ]]
export QA_STAGED_REVISION=$RAGENT_ACCOUNTS_SOURCE_REVISION
if bash "$builder" >"$work/output" 2>&1; then echo 'fixture npm unexpectedly succeeded' >&2; exit 1; fi
[[ -f $QA_NPM_MARKER ]]
[[ -z $(find "$work/out" -mindepth 1 -print -quit) ]]
echo 'PASS accounts release rejects incorrect source identity and cleans staging'
