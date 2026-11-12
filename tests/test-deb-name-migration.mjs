// Run only against a disposable, network-isolated Docker container. No host
// packages, services or configuration are mounted into this test.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const prerm = (await readFile(new URL('../packaging/deb/prerm', import.meta.url))).toString('base64');
const postrm = (await readFile(new URL('../packaging/deb/postrm', import.meta.url))).toString('base64');
const script = String.raw`set -eu
mkdir -p /tmp/old/DEBIAN /tmp/old/etc/ragent-qa /tmp/new/DEBIAN /tmp/new/etc/ragent-qa
printf 'Package: agentoc\nVersion: 1.0\nArchitecture: all\nMaintainer: QA\nDescription: isolated fixture\n' > /tmp/old/DEBIAN/control
printf 'Package: ragent\nVersion: 2.0\nArchitecture: all\nMaintainer: QA\nConflicts: agentoc\nReplaces: agentoc\nDescription: isolated fixture\n' > /tmp/new/DEBIAN/control
printf '/etc/ragent-qa/config\n' | tee /tmp/old/DEBIAN/conffiles /tmp/new/DEBIAN/conffiles >/dev/null
printf 'old-default\n' > /tmp/old/etc/ragent-qa/config; printf 'new-default\n' > /tmp/new/etc/ragent-qa/config
printf '%s' '${prerm}' | base64 -d > /tmp/old/DEBIAN/prerm
printf '%s' '${postrm}' | base64 -d > /tmp/old/DEBIAN/postrm
cat > /tmp/old/DEBIAN/preinst <<'EOF'
#!/bin/sh
if [ "$1" = upgrade ]; then
  echo checked >> /tmp/checks
  if [ -e /tmp/block-migration ]; then exit 1; fi
fi
exit 0
EOF
chmod +x /tmp/old/DEBIAN/preinst /tmp/old/DEBIAN/prerm /tmp/old/DEBIAN/postrm
mkdir -p /run/systemd/system /tmp/fake-systemctl
printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> /tmp/systemctl-events\nexit 0\n' > /tmp/fake-systemctl/systemctl
chmod +x /tmp/fake-systemctl/systemctl
PATH="/tmp/fake-systemctl:$PATH"; export PATH
for p in old new; do dpkg-deb --build /tmp/$p /tmp/$p.deb >/dev/null; done
dpkg -i /tmp/old.deb >/dev/null
mkdir -p /var/lib/agentoc/config
printf 'preserve-workspace\n' > /var/lib/agentoc/config/owner-test
printf 'user-custom\n' > /etc/ragent-qa/config
touch /tmp/block-migration
if dpkg --force-confold -i /tmp/new.deb >/tmp/blocked-output 2>&1; then echo 'guard was bypassed' >&2; exit 1; fi
[ "$(cat /etc/ragent-qa/config)" = user-custom ]
[ "$(dpkg-query -W -f='${'${db:Status-Abbrev}'}' agentoc)" = 'ii ' ]
[ ! -e /tmp/systemctl-events ]
rm /tmp/block-migration
dpkg --force-confold -i /tmp/new.deb >/dev/null
[ "$(cat /etc/ragent-qa/config)" = user-custom ]
[ "$(dpkg-query -W -f='${'${db:Status-Abbrev}'}' ragent)" = 'ii ' ]
[ "$(wc -l < /tmp/checks)" -eq 2 ]
grep -Fxq 'stop agentoc.service' /tmp/systemctl-events
if grep -Fxq 'stop agentoc-runners.slice' /tmp/systemctl-events; then echo 'migration stopped active detached runs' >&2; exit 1; fi
/tmp/old/DEBIAN/prerm remove
grep -Fxq 'stop agentoc-runners.slice' /tmp/systemctl-events
mkdir -p /tmp/fakebin
printf '#!/bin/sh\nprintf "%%s" "$REPLACEMENT_STATUS"\n' > /tmp/fakebin/dpkg-query
chmod +x /tmp/fakebin/dpkg-query
for REPLACEMENT_STATUS in unpacked half-installed half-configured triggers-awaited triggers-pending config-files; do
  export REPLACEMENT_STATUS
  PATH="/tmp/fakebin:$PATH" DPKG_MAINTSCRIPT_PACKAGE=agentoc /tmp/old/DEBIAN/postrm purge
  [ "$(cat /var/lib/agentoc/config/owner-test)" = preserve-workspace ]
done
dpkg --purge agentoc >/dev/null
[ "$(cat /var/lib/agentoc/config/owner-test)" = preserve-workspace ]
[ "$(cat /etc/ragent-qa/config)" = user-custom ]
`;
const result = spawnSync('docker', ['run', '--rm', '-i', '--pull=never', '--network=none', 'ubuntu:24.04', 'sh', '-s'],
  { input: script, encoding: 'utf8', timeout: 60_000 });
assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error || ''}`);
console.log('PASS isolated dpkg rename: removal guard and old-package purge preserve configuration and workspace');
