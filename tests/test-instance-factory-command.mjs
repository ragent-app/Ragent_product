#!/usr/bin/env node
import assert from 'assert/strict';
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import {
  deriveProfilePlan,
  parseEnvFileContent,
} from '../lib/instance-factory-command.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const tempDir = mkdtempSync(join(tmpdir(), 'ragent-instance-factory-'));

const manifestPath = join(tempDir, 'host.manifest.jsonc');
const envPath = join(tempDir, 'install.env');
const renderDir = join(tempDir, 'rendered');
const provisionRenderDir = join(tempDir, 'provision-rendered');
const bootstrapRenderDir = join(tempDir, 'bootstrap-rendered');
const installRenderDir = join(tempDir, 'install-rendered');

writeFileSync(manifestPath, `{
  "schemaVersion": 1,
  "host": {
    "provider": "digitalocean",
    "hostname": "ragent-sfo3-01",
    "region": "sfo3",
    "size": "s-2vcpu-4gb",
    "image": "ubuntu-24-04-x64",
    "tags": ["ragent", "owner"],
    "sshKeys": ["fp:test"],
    "repoCheckoutPath": "${repoRoot.replaceAll('\\', '\\\\')}"
  },
  "network": {
    "ownerDomain": "thelab.example.com",
    "ingress": {
      "provider": "cloudflare"
    }
  },
  "systemd": {
    "ownerUnit": "ragent"
  }
}`, 'utf8');

writeFileSync(envPath, `RAGENT_MODE=on
INGRESS_CLOUDFLARE_MODE=on
CONNECTOR_EMAIL_MODE=auto
WORKER_MAILBOX_MODE=auto
CONNECTOR_FEISHU_MODE=off
CONNECTOR_CALENDAR_MODE=auto
CLOUDFLARE_API_TOKEN=test-token
CLOUDFLARE_ACCOUNT_ID=test-account
CLOUDFLARE_TUNNEL_ID=tunnel-id
CLOUDFLARE_TUNNEL_NAME=thelab
`, 'utf8');

assert.deepEqual(parseEnvFileContent('A=1\n# x\nB="two"\n'), { A: '1', B: 'two' });

const manifest = JSON.parse(`{
  "schemaVersion": 1,
  "host": {
    "provider": "digitalocean",
    "hostname": "ragent-sfo3-01",
    "region": "sfo3",
    "repoCheckoutPath": "${repoRoot.replaceAll('\\', '\\\\')}"
  },
  "network": {
    "ownerDomain": "thelab.example.com",
    "ingress": {
      "provider": "cloudflare"
    }
  },
  "systemd": {
    "ownerUnit": "ragent"
  }
}`);

const installEnv = parseEnvFileContent(`RAGENT_MODE=on
INGRESS_CLOUDFLARE_MODE=on
CLOUDFLARE_API_TOKEN=token
CLOUDFLARE_ACCOUNT_ID=acct
CLOUDFLARE_TUNNEL_ID=tunnel
CLOUDFLARE_TUNNEL_NAME=thelab
CONNECTOR_EMAIL_MODE=auto
WORKER_MAILBOX_MODE=auto
CONNECTOR_FEISHU_MODE=off
CONNECTOR_CALENDAR_MODE=auto
`);

const readyHostFacts = {
  commands: { node: true, cloudflared: true, systemctl: true },
  files: { chatServer: true },
  services: { ragent: 'active', 'cloudflared-thelab': 'active' },
};
const plan = await deriveProfilePlan({ manifest, installEnv, hostFacts: readyHostFacts, commandName: 'install-profile' });
assert.equal(plan.summary.overallStatus, 'ready', JSON.stringify(plan.summary));
assert.equal(plan.modules.find((module) => module.id === 'ingress.cloudflare')?.states.runnable.value, true);
assert.equal(plan.modules.find((module) => module.id === 'ingress.cloudflare')?.runtime.systemdUnit, 'cloudflared-thelab');
assert.equal(plan.modules.find((module) => module.id === 'connector.email')?.states.enabled.value, false);
assert.match(plan.summary.warnings.join('\n'), /connector\.email: auto skipped/i);

const customIngressPlan = await deriveProfilePlan({
  manifest: {
    ...manifest,
    network: {
      ...manifest.network,
      ingress: {
        ...manifest.network.ingress,
        serviceName: 'cloudflared-example',
      },
    },
  },
  installEnv,
  hostFacts: readyHostFacts,
  commandName: 'install-profile',
});
assert.equal(customIngressPlan.modules.find((module) => module.id === 'ingress.cloudflare')?.runtime.systemdUnit, 'cloudflared-example');

const provisionResult = spawnSync(process.execPath, [
  'cli.js',
  'provision-host',
  '--manifest', manifestPath,
  '--render-dir', provisionRenderDir,
  '--json',
], {
  cwd: repoRoot,
  encoding: 'utf8',
});
assert.equal(provisionResult.status, 0);
const provisionJson = JSON.parse(provisionResult.stdout);
assert.equal(provisionJson.request.body.name, 'ragent-sfo3-01');
assert.deepEqual(provisionJson.request.body.tags, ['ragent', 'owner']);
assert.equal(readFileSync(join(provisionRenderDir, 'bootstrap-handoff.txt'), 'utf8').includes('scp bootstrap-host.sh'), true);

const cliResult = spawnSync(process.execPath, [
  'cli.js',
  'install-profile',
  '--manifest', manifestPath,
  '--env', envPath,
  '--render-dir', renderDir,
  '--json',
], {
  cwd: repoRoot,
  encoding: 'utf8',
});
assert.ok([0, 1].includes(cliResult.status), cliResult.stderr);
const renderedPlan = JSON.parse(readFileSync(join(renderDir, 'install-profile.plan.json'), 'utf8'));
assert.ok(['ready', 'degraded', 'blocked'].includes(renderedPlan.summary.overallStatus));
assert.equal(JSON.parse(cliResult.stdout).summary.overallStatus, renderedPlan.summary.overallStatus);
assert.equal(cliResult.status, renderedPlan.summary.overallStatus === 'blocked' ? 1 : 0);

const renderedInstallEnv = readFileSync(join(renderDir, 'derived-profile.env'), 'utf8');
assert.match(renderedInstallEnv, /RAGENT_OWNER_DOMAIN=thelab\.example\.com/);
assert.match(renderedInstallEnv, /RAGENT_PUBLIC_BASE_URL=https:\/\/thelab\.example\.com/);

const bootstrapResult = spawnSync(process.execPath, [
  'cli.js',
  'bootstrap-host',
  '--manifest', manifestPath,
  '--render-dir', bootstrapRenderDir,
  '--json',
], {
  cwd: repoRoot,
  encoding: 'utf8',
});
assert.ok([0, 1].includes(bootstrapResult.status), bootstrapResult.stderr);
assert.equal(bootstrapResult.status, JSON.parse(bootstrapResult.stdout).summary.overallStatus === 'blocked' ? 1 : 0);
const bootstrapScript = readFileSync(join(bootstrapRenderDir, 'bootstrap-host.sh'), 'utf8');
assert.match(bootstrapScript, /apt-get install -y curl git ca-certificates jq build-essential/);
assert.match(bootstrapScript, /systemctl enable --now 'ragent'/);

const bootstrapExecuteWithoutHost = spawnSync(process.execPath, [
  'cli.js',
  'bootstrap-host',
  '--manifest', manifestPath,
  '--execute',
], {
  cwd: repoRoot,
  encoding: 'utf8',
});
assert.equal(bootstrapExecuteWithoutHost.status, 1);
assert.match(bootstrapExecuteWithoutHost.stderr, /requires --ssh-host/);

const installResult = spawnSync(process.execPath, [
  'cli.js',
  'install-profile',
  '--manifest', manifestPath,
  '--env', envPath,
  '--render-dir', installRenderDir,
  '--json',
], {
  cwd: repoRoot,
  encoding: 'utf8',
});
const installJson = JSON.parse(installResult.stdout);
assert.equal(installResult.status, installJson.summary.overallStatus === 'blocked' ? 1 : 0);
assert.equal(typeof installJson.artifacts.installProfileEnv, 'string');
const applyInstallScript = readFileSync(join(installRenderDir, 'apply-install-profile.sh'), 'utf8');
assert.equal(applyInstallScript.includes('systemctl restart'), true);
assert.equal(applyInstallScript.includes('RAGENT_OWNER_ACCESS_URL='), false, '静态 access token 已下线，不应再注入 access URL');
assert.equal(applyInstallScript.includes('RAGENT_OWNER_INITIAL_PASSWORD='), true);
assert.equal(applyInstallScript.includes('auth.json'), true);
assert.equal(readFileSync(join(installRenderDir, 'cloudflared-config.yml'), 'utf8').includes('service: http://127.0.0.1:7690'), true);

const inspectResult = spawnSync(process.execPath, [
  'automation/instance-factory/scripts/inspect-ragent-host.mjs',
], {
  cwd: repoRoot,
  encoding: 'utf8',
});
assert.equal(inspectResult.status, 0);
const inspectJson = JSON.parse(inspectResult.stdout);
assert.equal(inspectJson.schemaVersion, 1);
assert.equal(typeof inspectJson.facts.commands.node, 'boolean');

rmSync(tempDir, { recursive: true, force: true });
console.log('test-instance-factory-command: ok');
