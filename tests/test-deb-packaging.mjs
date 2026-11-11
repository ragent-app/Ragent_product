#!/usr/bin/env node
import assert from 'assert/strict';
import { accessSync, chmodSync, constants, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { execFileSync, spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function read(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8');
}

function exists(relativePath) {
  try {
    accessSync(join(root, relativePath));
    return true;
  } catch {
    return false;
  }
}

const buildScript = read('scripts/build-deb.sh');
const restartScript = read('restart.sh');
const mainService = read('packaging/deb/agentoc.service');
const runnerLifecycleService = read('packaging/deb/agentoc-runner-lifecycle.service');
const runnerSupervisorService = read('packaging/deb/agentoc-runner-supervisor.service');
const privilegedExecutorService = read('packaging/deb/agentoc-privileged-executor.service');
const storageGcService = read('packaging/deb/agentoc-storage-gc.service');
const storageGcTimer = read('packaging/deb/agentoc-storage-gc.timer');
const environmentFile = read('packaging/deb/agentoc.env');
const preinst = read('packaging/deb/preinst');
const postinst = read('packaging/deb/postinst');
const prerm = read('packaging/deb/prerm');
const postrm = read('packaging/deb/postrm');
const legacyCcSwitchRetirement = read('packaging/deb/retire-legacy-cc-switch');
const repairStateAccess = read('packaging/deb/repair-state-access');
const packageJson = JSON.parse(read('package.json'));

assert.match(buildScript, /Debian packaging requires a clean committed source tree/);
assert.match(buildScript, /SOURCE_COMMIT.*agentoc-source-commit/s);
assert.match(buildScript, /Source changed during packaging; refusing to publish the candidate/);

const retiredPackagePaths = [
  'packaging/deb/agentoc-maintenance-admin',
  'packaging/deb/agentoc-maintenance-broker.service',
  'packaging/deb/agentoc-maintenance-control.service',
  'packaging/deb/deferred-maintenance-restart',
  'native/maintenance-peercred.c',
];

for (const path of retiredPackagePaths) {
  assert.equal(exists(path), false, `${path} must be removed from the source tree`);
  assert.doesNotMatch(
    buildScript,
    new RegExp(path.replaceAll('/', '\\/').replaceAll('.', '\\.'), 'i'),
    `${path} must not be staged by the Deb builder`,
  );
}

assert.match(buildScript, /native\/privileged-peercred\.c/);
assert.match(buildScript, /usr\/lib\/agentoc\/privileged-peercred/);
assert.match(buildScript, /agentoc-privileged-executor\.service/);
assert.doesNotMatch(buildScript, /agentoc-maintenance|deferred-maintenance|maintenance-peercred/i);

assert.match(environmentFile, /^AGENTOC_PRIVILEGED_EXECUTOR_SOCKET=\/run\/agentoc-privileged-executor\/sock$/m);
assert.match(environmentFile, /^AGENTOC_PRIVILEGED_EXECUTOR_AUDIT_FILE=\/var\/log\/agentoc-privileged\/audit\.jsonl$/m);
assert.match(environmentFile, /^AGENTOC_PRIVILEGED_EXECUTOR_GROUP=agentoc-privileged$/m);
assert.doesNotMatch(environmentFile, /maintenance|AGENTOC_CONTROL_SOCKET|AGENTOC_ENABLE_DEVELOPER/i);

assert.match(mainService, /^After=agentoc-privileged-executor\.service$/m);
assert.match(mainService, /^Wants=agentoc-privileged-executor\.service$/m);
assert.match(mainService, /^SupplementaryGroups=agentoc-privileged$/m);
assert.doesNotMatch(mainService, /agentoc-maintenance|maintenance-control/i);
assert.doesNotMatch(runnerSupervisorService, /agentoc-maintenance|maintenance-control/i);
assert.match(runnerSupervisorService, /^After=agentoc-runner-lifecycle\.service$/m);
assert.match(runnerSupervisorService, /^Requires=agentoc-runner-lifecycle\.service$/m);
assert.match(runnerSupervisorService, /^InaccessiblePaths=\/etc\/agentoc \/var\/log\/agentoc \/run\/agentoc -\/run\/agentoc-privileged-executor$/m);
assert.match(runnerLifecycleService, /runner-lifecycle-broker\.mjs/);
assert.match(runnerLifecycleService, /^RuntimeDirectory=agentoc$/m,
  'the lifecycle service must create the protected /run/agentoc directory before the supervisor starts');
assert.match(privilegedExecutorService, /privileged-executor\.mjs serve/);
assert.match(buildScript, /agentoc-storage-gc\.service/);
assert.match(buildScript, /agentoc-storage-gc\.timer/);
assert.match(storageGcService, /storage-inventory-gc\.mjs --apply --json --scheduled/);
assert.match(storageGcService, /Nice=19/);
assert.match(storageGcService, /IOSchedulingClass=idle/);
assert.match(storageGcService, /ReadWritePaths=\/var\/lib\/agentoc\/config \/var\/lib\/agentoc\/workspace/);
assert.match(storageGcTimer, /OnCalendar=\*-\*-\* 03:30:00/);
assert.match(storageGcTimer, /Persistent=true/);

// Upgrade migration must stop the retired units, remove their runtime-only
// control paths, and move historical state before ownership convergence.
assert.match(postinst, /retire_legacy_maintenance_runtime\(\)/);
assert.match(postinst, /systemctl disable --now "\$retired_unit"/);
assert.match(postinst, /retire_legacy_maintenance_data\(\)/);
assert.match(postinst, /retired_root=\/var\/lib\/agentoc\/retired/);
assert.match(postinst, /maintenance-audit-\$retired_stamp/);
assert.match(postinst, /find \. -type f ! -name SHA256SUMS -exec sha256sum/);
assert.match(postinst, /chown -R root:root "\$retired_destination"/);
assert.match(postinst, /find "\$retired_destination" -type d -exec chmod 0700/);
assert.match(postinst, /! -path \/var\/lib\/agentoc\/retired/);
assert.match(postinst, /agentoc-privileged/);
assert.doesNotMatch(postinst, /developer_maintenance_enabled|ensure_control_env|AGENTOC_MAINTENANCE_BROKER_INSTALL/);
assert.match(postinst, /grep -q 'agentoc-privileged-executor\.service' \/proc\/self\/cgroup/);
assert.match(postinst, /systemd-run --on-active=15/,
  'executor-owned package configuration must defer its own restart until dpkg exits');

assert.doesNotMatch(prerm, /agentoc-maintenance|maintenance-control/);
assert.match(prerm, /stop agentoc-privileged-executor\.service/);
assert.match(postrm, /\/var\/lib\/agentoc \/var\/log\/agentoc/);
assert.match(postrm, /delgroup --system agentoc-privileged/);
assert.match(postrm, /delgroup --system agentoc-maintenance/);
assert.doesNotMatch(restartScript, /agentoc-maintenance|maintenance-control/);

assert.match(preinst, /repair_provider_runtime_access\(\)/);
assert.match(repairStateAccess, /owner-account-binding\.json/);
assert.match(repairStateAccess, /chat-sessions\.json/);
assert.match(repairStateAccess, /repair_private_tree\(\)/);
assert.match(repairStateAccess, /repair_private_tree "\$CONFIG_ROOT\/chat-history"/);
assert.match(repairStateAccess, /--quick\|--full/);
assert.match(mainService, /repair-state-access --quick/);
assert.match(postinst, /repair-state-access --full/);
assert.match(postinst, /agentoc-storage-gc\.timer/);
assert.match(prerm, /agentoc-storage-gc\.timer/);
assert.doesNotMatch(mainService, /repair-state-access\s*$/m);
assert.match(repairStateAccess, /find "\$path" -type d -exec chmod 0700 \{\} \+/);
assert.match(repairStateAccess, /find "\$path" -type f -exec chmod 0600 \{\} \+/);
assert.match(legacyCcSwitchRetirement, /legacy-cc-switch-retired/);
assert.ok(packageJson.files.includes('restart.sh'));

assert.match(
  buildScript,
  /PACKAGE_PUBLIC_BASE_URL="\$\{AGENTOC_PACKAGE_PUBLIC_BASE_URL:-https:\/\/app\.agentoncloud\.com\}"/,
  'Deb packages must default the portal URL to app.agentoncloud.com',
);
assert.match(buildScript, /PACKAGE_ACCOUNTS_URL="\$\{AGENTOC_PACKAGE_ACCOUNTS_URL:-https:\/\/agentoc\.andyscodexagent\.cyou\/accounts\}"/);
assert.match(buildScript, /PACKAGE_TURN_BROKER_URL="\$\{AGENTOC_PACKAGE_TURN_BROKER_URL:-https:\/\/agentoc\.andyscodexagent\.cyou\/turn\}"/);
assert.match(buildScript, /GOOS=linux GOARCH="\$P2P_GOARCH" CGO_ENABLED=0 go build/);
assert.match(buildScript, /P2P_GOARCH=arm64/);
assert.match(buildScript, /P2P_GOARCH=amd64/);
assert.match(buildScript, /NPM_REGISTRY="\$\{AGENTOC_NPM_REGISTRY:-https:\/\/registry\.npmjs\.org\}"/);
assert.match(buildScript, /resolve_npm_version\(\)/);
assert.match(buildScript, /verify_npm_sri\(\)/);
assert.match(buildScript, /registry metadata does not include a sha512 SRI digest/);
assert.match(buildScript, /@openai\/codex@\$CODEX_VERSION/);
assert.match(buildScript, /@openai\/codex@\$CODEX_NATIVE_VERSION/);
assert.match(buildScript, /harness-version-catalog\.mjs/);
assert.match(buildScript, /CODEX_ADAPTER_TARGET_VERSION/);
assert.match(buildScript, /AGENTOC_CODEX_VERSION:-\$CODEX_ADAPTER_TARGET_VERSION/);
assert.match(buildScript, /AGENTOC_CLAUDE_VERSION:-\$CLAUDE_ADAPTER_TARGET_VERSION/);
assert.match(buildScript, /CLAUDE_ADAPTER_COMPATIBLE/);
assert.match(buildScript, /CODEX_ADAPTER_COMPATIBLE/);
assert.match(buildScript, /@anthropic-ai\/claude-code/);
assert.match(buildScript, /Fetch the Codex launcher and target-native engine/);
assert.match(buildScript, /provider-versions/);
assert.match(buildScript, /Package cache is not writable/);
assert.match(buildScript, /Package output directory is not writable/);
assert.match(buildScript, /CODEX_MAIN_CONTENTS=.*codex-launcher-contents\.txt/);
assert.match(buildScript, /CLAUDE_NATIVE_CONTENTS=.*claude-native-contents\.txt/);
assert.doesNotMatch(buildScript, /tar -tzf "\$CODEX_MAIN_CACHE_PATH" \| grep -qx/);
assert.doesNotMatch(buildScript, /tar -tzf "\$CLAUDE_NATIVE_CACHE_PATH" \| grep -qx/);
assert.doesNotMatch(buildScript, /CLAUDE_VERSION="\$\{AGENTOC_CLAUDE_VERSION:-2\.1\./);
assert.doesNotMatch(buildScript, /CODEX_NATIVE_VERSION="\$\{AGENTOC_CODEX_NATIVE_VERSION:-0\./);
assert.match(buildScript, /rm -f "\$APP_DIR\/bin\/agentoc-p2p-host-amd64" "\$APP_DIR\/bin\/agentoc-p2p-host-arm64"/);
assert.match(buildScript, /Built deb contains an architecture-specific P2P sidecar/);
assert.match(buildScript, /Built deb is missing the canonical P2P host sidecar/);
assert.match(postinst, /retire_legacy_p2p_host_variants\(\)/);
assert.match(postinst, /\/opt\/agentoc\/app\/bin\/agentoc-p2p-host-amd64/);
assert.match(postinst, /\/opt\/agentoc\/app\/bin\/agentoc-p2p-host-arm64/);

execFileSync('bash', ['-n', join(root, 'scripts/build-deb.sh')]);

const fakeNpmRoot = mkdtempSync(join(tmpdir(), 'agentoc-deb-version-gate-'));
try {
  const fakeNpm = join(fakeNpmRoot, 'npm');
  writeFileSync(fakeNpm, [
    '#!/bin/sh',
    'case "$*" in',
    '  *"@openai/codex version"*) printf "0.154.0\\n" ;;',
    '  *"@anthropic-ai/claude-code version"*) printf "2.1.263\\n" ;;',
    '  *) exit 2 ;;',
    'esac',
  ].join('\n'));
  chmodSync(fakeNpm, 0o700);
  const mismatch = spawnSync('bash', [join(root, 'scripts/build-deb.sh')], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeNpmRoot}:${process.env.PATH}`,
      AGENTOC_PACKAGE_VERSION: '0.0.0-version-gate-test',
      AGENTOC_CODEX_VERSION: '0.165.0',
      AGENTOC_CLAUDE_VERSION: '2.1.310',
    },
  });
  assert.notEqual(mismatch.status, 0, 'Deb packaging must refuse an explicit unvalidated runtime override');
  assert.match(mismatch.stderr, /Codex 0\.165\.0 is outside the validated AgentoC adapter range/);
} finally {
  rmSync(fakeNpmRoot, { recursive: true, force: true });
}

execFileSync('sh', ['-n', join(root, 'packaging/deb/repair-state-access')]);
execFileSync('sh', ['-n', join(root, 'packaging/deb/postinst')]);
execFileSync('sh', ['-n', join(root, 'packaging/deb/prerm')]);
execFileSync('sh', ['-n', join(root, 'packaging/deb/postrm')]);

console.log('test-deb-packaging: ok');
