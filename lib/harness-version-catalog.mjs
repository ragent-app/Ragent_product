// Version metadata shared by packaging, the Harness registry, the adapter
// boundary, and the Accounts policy service. Keep each validated release in
// one place so a package cannot silently ship a Harness that its adapter then
// rejects at runtime.

export const HARNESS_VERSION_CATALOG_REVISION = '2026-11-12.1';

function contract(value) {
  return Object.freeze({ ...value, compatibleVersions: Object.freeze(value.compatibleVersions) });
}

// Latest release targets checked against publisher registries/release tags on
// 2026-10-26. A target is a protocol compatibility declaration, not evidence of
// an authenticated task on every OS. See docs/harness-compatibility.md.
// Keep established old lines, but do not admit unexamined intermediate/future
// lines merely because their version number is higher.
export const HARNESS_VERSION_CONTRACTS = Object.freeze({
  codex: contract({ adapterVersion: '1.3', minimumVersion: '0.150.1', targetVersion: '0.167.2',
    compatibleVersions: ['0.150.x', '0.151.x', '0.152.x', '0.153.x', '0.164.0', '0.167.2'] }),
  claude: contract({ adapterVersion: '1.3', minimumVersion: '2.1.247', targetVersion: '2.1.310',
    compatibleVersions: ['2.1.x'], maximumVersion: '2.1.310' }),
  // The official AgY installer has no version selector. Retain its channel,
  // record the observed version, and refuse a newer unreviewed runtime.
  agy: contract({ adapterVersion: '1.2', targetVersion: 'latest', observedVersion: '1.4.7',
    compatibleVersions: ['latest'], maximumVersion: '1.4.7' }),
  pi: contract({ adapterVersion: '1.2', minimumVersion: '0.84.3', targetVersion: '1.4.0',
    compatibleVersions: ['0.84.x', '1.4.0'] }),
  'deepseek-harness': contract({ adapterVersion: '1.2', minimumVersion: '0.1.1-rc.2', targetVersion: '0.2.1-rc.2',
    compatibleVersions: ['0.1.1-rc.2', '0.2.1-rc.2'] }),
  'qwen-code': contract({ adapterVersion: '1.2', minimumVersion: '0.22.2', targetVersion: '0.26.1',
    compatibleVersions: ['0.22.x', '0.26.1'] }),
  opencode: contract({ adapterVersion: '1.2', minimumVersion: '1.18.23', targetVersion: '1.19.4',
    compatibleVersions: ['1.18.x', '1.19.4'] }),
  // Kimi 2.x replaced the old openai_legacy provider discriminator with openai.
  // Upgrade old managed installations before writing the new scoped config.
  'kimi-code': contract({ adapterVersion: '1.2', minimumVersion: '2.3.2', targetVersion: '2.3.2',
    compatibleVersions: ['2.3.2'] }),
  goose: contract({ adapterVersion: '1.2', minimumVersion: '1.47.0', targetVersion: '1.56.0',
    compatibleVersions: ['1.47.x', '1.56.0'] }),
  openhands: contract({ adapterVersion: '1.2', minimumVersion: '1.15.0', targetVersion: '1.33.0',
    compatibleVersions: ['1.15.x', '1.33.0'], serviceRuntimeMinimumVersion: '1.42.0',
    serviceRuntimeVersion: '1.58.2', serviceRuntimeVersions: ['1.42.x', '1.58.2'] }),
  copilot: contract({ adapterVersion: '1.2', minimumVersion: '1.0.81', targetVersion: '1.0.103',
    compatibleVersions: ['1.0.x'], maximumVersion: '1.0.103' }),
  hermes: contract({ adapterVersion: '1.2', minimumVersion: '0.20.6', targetVersion: '0.22.5',
    compatibleVersions: ['0.20.x', '2026.8.x', '0.22.5'],
    sourceCommit: 'bf0203a794a07aac3ff764972ab9087baa4e4f4e' }),
  cline: contract({ adapterVersion: '1.2', minimumVersion: '3.0.60', targetVersion: '3.0.74',
    compatibleVersions: ['3.0.x'], maximumVersion: '3.0.74' }),
  kilo: contract({ adapterVersion: '1.2', minimumVersion: '7.5.5', targetVersion: '7.8.18',
    compatibleVersions: ['7.x'], maximumVersion: '7.8.18' }),
});

export const CODEX_HARNESS_VERSION_CONTRACT = HARNESS_VERSION_CONTRACTS.codex;
