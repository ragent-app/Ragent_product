#!/bin/sh
set -eu

# The input is the already verified official Node distribution, extracted by
# the platform builder. Keep all tools private to this application's runtime.
distribution=$1
runtime=$(CDPATH= cd -- "$2" && pwd)
test -x "$runtime/node"
test -f "$distribution/lib/node_modules/npm/bin/npm-cli.js"
test -f "$distribution/lib/node_modules/corepack/dist/corepack.js"
mkdir -p "$runtime/node_modules"
test ! -e "$runtime/node_modules/npm" && test ! -e "$runtime/node_modules/corepack"
cp -R "$distribution/lib/node_modules/npm" "$runtime/node_modules/npm"
cp -R "$distribution/lib/node_modules/corepack" "$runtime/node_modules/corepack"
# Package builds may run with a restrictive umask. The resulting tools are
# installed as root but executed by the instance user, so their public code
# and directories must remain readable and searchable by that user.
chmod -R a+rX "$runtime/node_modules/npm" "$runtime/node_modules/corepack"
# npm's manuals include sample keys; they are not needed for managed installs.
rm -rf "$runtime/node_modules/npm/docs" "$runtime/node_modules/npm/man"
cat > "$runtime/npm" <<'EOF'
#!/bin/sh
set -eu
runtime=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PATH="$runtime:${PATH:-/usr/bin:/bin}"; export PATH
exec "$runtime/node" "$runtime/node_modules/npm/bin/npm-cli.js" "$@"
EOF
cat > "$runtime/corepack" <<'EOF'
#!/bin/sh
set -eu
runtime=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PATH="$runtime:${PATH:-/usr/bin:/bin}"; export PATH
exec "$runtime/node" "$runtime/node_modules/corepack/dist/corepack.js" "$@"
EOF
chmod 0755 "$runtime/npm" "$runtime/corepack"
# Empty PATH apart from base OS utilities catches accidental host Node/npm use.
(cd "$runtime" && env -i PATH=/usr/bin:/bin HOME="${TMPDIR:-/tmp}" "$runtime/npm" --version >/dev/null)
(cd "$runtime" && env -i PATH=/usr/bin:/bin HOME="${TMPDIR:-/tmp}" "$runtime/corepack" --version >/dev/null)
