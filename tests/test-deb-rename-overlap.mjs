// Isolated dpkg exercise using the real new-package preinst. The container has
// no host mounts or network and cannot change an installed Ragent instance.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const preinst = (await readFile(new URL('../packaging/deb/preinst', import.meta.url))).toString('base64');
const postrm = (await readFile(new URL('../packaging/deb/postrm', import.meta.url))).toString('base64');
const script = String.raw`set -eu
mkdir -p /tmp/old/DEBIAN /tmp/old/etc/ragent-qa /tmp/old/opt/agentoc/runtime /tmp/old/opt/agentoc/app /tmp/old/lib/systemd/system
printf 'Package: agentoc\nVersion: 1.0\nArchitecture: all\nMaintainer: QA\nDescription: isolated fixture\n' > /tmp/old/DEBIAN/control
printf '/etc/ragent-qa/config\n' > /tmp/old/DEBIAN/conffiles
printf 'old-default\n' > /tmp/old/etc/ragent-qa/config
printf 'fixture\n' > /tmp/old/opt/agentoc/app/cli.js
printf 'legacy\n' > /tmp/old/opt/agentoc/legacy-only
printf '[Service]\nExecStart=/bin/true\n' > /tmp/old/lib/systemd/system/agentoc.service
cat > /tmp/old/opt/agentoc/runtime/node <<'EOF'
#!/bin/sh
if [ -e /tmp/deny-upgrade ]; then echo 'blocked run'; exit 1; fi
exit 0
EOF
chmod +x /tmp/old/opt/agentoc/runtime/node
printf '%s' '${postrm}' | base64 -d > /tmp/old/DEBIAN/postrm
chmod +x /tmp/old/DEBIAN/postrm
dpkg-deb --build /tmp/old /tmp/old.deb >/dev/null
dpkg -i /tmp/old.deb >/dev/null
mkdir -p /var/lib/agentoc/config
printf 'workspace-kept\n' > /var/lib/agentoc/config/owner-test
printf 'user-custom\n' > /etc/ragent-qa/config
export AGENTOC_SERVICE_USER=nobody

build_new() {
  rm -rf /tmp/new
  mkdir -p /tmp/new/DEBIAN /tmp/new/etc/ragent-qa /tmp/new/opt/agentoc/runtime /tmp/new/opt/agentoc/app /tmp/new/lib/systemd/system
  printf 'Package: ragent\nVersion: 2.0\nArchitecture: all\nMaintainer: QA\nReplaces: agentoc\nDescription: isolated fixture\n' > /tmp/new/DEBIAN/control
  printf '/etc/ragent-qa/config\n' > /tmp/new/DEBIAN/conffiles
  printf 'new-default\n' > /tmp/new/etc/ragent-qa/config
  printf 'fixture-new\n' > /tmp/new/opt/agentoc/app/cli.js
  cp /tmp/old/opt/agentoc/runtime/node /tmp/new/opt/agentoc/runtime/node
  printf '[Service]\nExecStart=/bin/true\n' > /tmp/new/lib/systemd/system/ragent.service
  ln -s ragent.service /tmp/new/lib/systemd/system/agentoc.service
  if [ "$1" = complete ]; then printf 'new\n' > /tmp/new/opt/agentoc/legacy-only; fi
  if [ "$1" = directory ]; then mkdir /tmp/new/opt/agentoc/legacy-only; fi
  printf '%s' '${preinst}' | base64 -d > /tmp/new/DEBIAN/preinst
  cat >> /tmp/new/DEBIAN/preinst <<'EOF'

: <<'RAGENT_PAYLOAD_MANIFEST'
# RAGENT_PAYLOAD_MANIFEST_BEGIN
EOF
  (cd /tmp/new && find . -mindepth 1 -not -path './DEBIAN*' -not -type d -print | sed 's|^\./|/|' | LC_ALL=C sort) >> /tmp/new/DEBIAN/preinst
  cat >> /tmp/new/DEBIAN/preinst <<'EOF'
# RAGENT_PAYLOAD_MANIFEST_END
RAGENT_PAYLOAD_MANIFEST
EOF
  chmod +x /tmp/new/DEBIAN/preinst
  dpkg-deb --build /tmp/new /tmp/new.deb >/dev/null
}
build_new incomplete
if dpkg --force-confold -i /tmp/new.deb >/tmp/incomplete.log 2>&1; then echo 'missing legacy file was accepted' >&2; exit 1; fi
grep -q 'absent from the Ragent package' /tmp/incomplete.log
[ "$(dpkg-query -W -f='${'${db:Status-Abbrev}'}' agentoc)" = 'ii ' ]
[ "$(cat /etc/ragent-qa/config)" = user-custom ]
build_new directory
if dpkg --force-confold -i /tmp/new.deb >/tmp/directory.log 2>&1; then echo 'file-to-directory replacement was accepted' >&2; exit 1; fi
grep -q 'absent from the Ragent package' /tmp/directory.log
build_new complete
touch /tmp/deny-upgrade
if dpkg --force-confold -i /tmp/new.deb >/tmp/blocked.log 2>&1; then echo 'unsafe running task was accepted' >&2; exit 1; fi
grep -q 'active Runs are not proven restart-safe' /tmp/blocked.log
[ "$(dpkg-query -W -f='${'${db:Status-Abbrev}'}' agentoc)" = 'ii ' ]
rm /tmp/deny-upgrade
dpkg --force-confold -i /tmp/new.deb >/dev/null
[ "$(dpkg-query -W -f='${'${db:Status-Abbrev}'}' ragent)" = 'ii ' ]
if [ "$(dpkg-query -W -f='${'${db:Status-Status}'}' agentoc 2>/dev/null || true)" = installed ]; then echo 'legacy package still installed' >&2; exit 1; fi
[ "$(cat /etc/ragent-qa/config)" = user-custom ]
[ "$(cat /var/lib/agentoc/config/owner-test)" = workspace-kept ]
[ "$(readlink /lib/systemd/system/agentoc.service)" = ragent.service ]
`;
const result = spawnSync('docker', ['run', '--rm', '-i', '--pull=never', '--network=none', 'ubuntu:24.04', 'sh', '-s'],
  { input: script, encoding: 'utf8', timeout: 60_000 });
assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error || ''}`);
console.log('PASS dpkg rename takeover: missing files and unsafe runs block; full replacement preserves state');
