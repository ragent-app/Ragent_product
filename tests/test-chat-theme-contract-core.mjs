#!/usr/bin/env node
// tests/test-chat-theme-contract-core.mjs
//
// Stage 2: monet-theme-contract core (static/chat/transport/monet-theme-contract.js)
// is a DOM-free port of monet-theme-contract.js's pure helpers (role-name
// normalization, color validity with the CSS.supports probe injected via the
// environment contract, payload slicing, role→variable bindings). The DOM
// half (apply/clear) stays in the legacy module. Parity strategy: the shared
// helpers run the same battery against BOTH implementations and compare at
// the primitive level; the legacy-only apply loop is driven against a fake
// root and its full style-call trace is re-derived from the core helpers
// (plus the legacy-internal reserved-key list, which legacy does not export
// and is therefore locked behaviorally), so every piece the port owns is
// cross-checked against the original.

import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

// Mirrors the reserved-key list internal to the legacy module (not exported
// there either; locked behaviorally via the apply battery below).
const RESERVED = new Set([
  'version', 'roles', 'themeColor', 'theme-color',
  'surface-dark', 'surfaceDark', 'background', 'darkBackground',
]);

function loadLegacy({ cssSupports }) {
  const context = {
    window: cssSupports ? { CSS: { supports: cssSupports } } : {},
  };
  vm.runInNewContext(
    readFileSync(join(repoRoot, 'static/chat/monet-theme-contract.js'), 'utf8'),
    context,
    { filename: 'monet-theme-contract.js' },
  );
  const legacy = context.window.RagentMonetThemeContract;
  return {
    api: {
      roleBindings: legacy.roleBindings,
      normalizeRoleName: (v) => legacy.normalizeRoleName(v),
      isValidColor: (v) => legacy.isValidColor(v),
      apply: (theme, root) => legacy.apply(theme, root),
    },
    label: 'legacy',
  };
}

function loadCore({ cssSupports }) {
  const context = {
    RagentMonetThemeContractEnvironment: {
      cssSupports: cssSupports || null,
    },
  };
  vm.runInNewContext(
    readFileSync(join(repoRoot, 'static/chat/transport/monet-theme-contract.js'), 'utf8'),
    context,
    { filename: 'transport/monet-theme-contract.js' },
  );
  const core = context.RagentMonetThemeContractCore;
  return {
    api: {
      roleBindings: core.roleBindings,
      isRecord: (v) => core.isRecord(v),
      normalizeRoleName: (v) => core.normalizeRoleName(v),
      isValidColor: (v) => core.isValidColor(v),
      getPayloadParts: (v) => core.getPayloadParts(v),
    },
    label: 'transport',
  };
}

// JSON round-trip normalizes cross-realm plain objects before comparison.
function normalize(value) {
  return JSON.parse(JSON.stringify(value));
}

function runSharedScenario(api) {
  const out = {};
  out.normalizeRoleName = [
    'Primary', 'on-primary', '--sys-primary', 'surfaceContainer',
    'surface_container', '  error  ', '', null, 42, '--on-primary',
    'primary--', '--sys-on-primary-container', 'on-ERROR',
  ].map((v) => api.normalizeRoleName(v));
  out.isValidColor = [
    '#fff', '#FFFFFF', '#12345678', '#123456789', '#ggg', '#12ab',
    'rgb(1,2,3)', 'rgba(1, 2, 3, 0.5)', 'hsl(0, 0%, 0%)', 'oklch(50% 0.1 200)',
    'color(display-p3 1 0 0)', 'red', 'var(--x)', 'url(x)', 'x;y', '{x}', '}x{',
    '', '   ', 42, null, 'f'.repeat(128), 'f'.repeat(129), 'RGB(1,2,3)',
  ].map((v) => api.isValidColor(v));
  return normalize(out);
}

// Re-derive what legacy apply MUST do (result + full style-call trace) from
// the core helpers plus the reserved-key list.
function expectedApply(coreApi, theme) {
  if (!coreApi.isRecord(theme)) {
    const cleared = [];
    for (const variables of Object.values(coreApi.roleBindings)) {
      variables.forEach((variable) => cleared.push(['del', variable]));
    }
    return { applied: [], rejected: [], themeColorOverrides: null, calls: cleared };
  }
  const { roles, lightSurface, darkSurface } = coreApi.getPayloadParts(theme);
  const themeColorOverrides = coreApi.isValidColor(lightSurface)
    ? {
        light: lightSurface.trim(),
        dark: coreApi.isValidColor(darkSurface) ? darkSurface.trim() : lightSurface.trim(),
      }
    : null;
  const applied = [];
  const rejected = [];
  const calls = [];
  for (const [rawRole, rawValue] of Object.entries(roles || {})) {
    if (RESERVED.has(rawRole)) continue;
    const role = coreApi.normalizeRoleName(rawRole);
    const variables = coreApi.roleBindings[role];
    if (!variables || !coreApi.isValidColor(rawValue)) {
      rejected.push(rawRole);
      continue;
    }
    variables.forEach((variable) => calls.push(['set', variable, rawValue.trim()]));
    applied.push(role);
  }
  return { applied, rejected, themeColorOverrides, calls };
}

function runApplyBattery(legacyApi, coreApi) {
  const themes = [
    ['null', null],
    ['number', 42],
    ['string', 'x'],
    ['array', []],
    ['empty-object', {}],
    ['basic', {
      version: 1,
      themeColor: { light: '#ffffff', dark: '#000000' },
      roles: {
        primary: '#ff0000',
        primaryContainer: '#f0f0f0',
        'on-surface': '#123456',
        bogus: '#fff',          // unknown role → rejected
        'on-error': 'red',      // known role, invalid value → rejected
        version: '#111111',     // reserved → skipped silently
      },
    }],
    ['roles-as-payload', { primary: '#aa0000' }],
    ['surface-dark-precedence', { 'surface-dark': '#111111', surface: '#ffffff', background: '#eeeeee' }],
    ['dark-fallback-to-light', { themeColor: { light: '#abcdef' } }],
    ['themeColor-surface-wins', { themeColor: { surface: '#aaaaaa' }, surface: '#bbbbbb' }],
    ['roles-surface-fallback', { roles: { surface: '#cccccc' } }],
    ['invalid-light', { themeColor: { light: 'garbage' } }],
    ['empty-roles', { roles: {} }],
    ['non-record-roles', { roles: 'x', themeColor: { light: '#fff' } }],
  ];
  const results = [];
  for (const [name, theme] of themes) {
    const calls = [];
    const root = {
      style: {
        setProperty: (k, v) => calls.push(['set', k, v]),
        removeProperty: (k) => calls.push(['del', k]),
      },
    };
    const actual = legacyApi.apply(theme, root);
    const expected = expectedApply(coreApi, theme);
    results.push({
      name,
      actual: normalize({ result: actual, calls }),
      expected: normalize({
        result: {
          applied: expected.applied,
          rejected: expected.rejected,
          themeColorOverrides: expected.themeColorOverrides,
        },
        calls: expected.calls,
      }),
    });
  }
  return results;
}

async function main() {
  // 1. Static surface parity: version + bindings table.
  const [staticLegacy, staticCore] = [loadLegacy({ cssSupports: null }), loadCore({ cssSupports: null })];
  assert.deepEqual(
    normalize(staticCore.api.roleBindings),
    normalize(staticLegacy.api.roleBindings),
    'role bindings drifted',
  );

  // 2. Helper parity on the regex fallback path (no CSS.supports anywhere).
  const [regexLegacy, regexCore] = [loadLegacy({ cssSupports: null }), loadCore({ cssSupports: null })];
  assert.deepEqual(
    runSharedScenario(regexCore.api),
    runSharedScenario(regexLegacy.api),
    `helper drift on regex path: ${regexLegacy.label} vs ${regexCore.label}`,
  );

  // 3. Helper parity through the CSS.supports probe (injected into both).
  //    The probe rejects plain hex that the regex path accepts, proving the
  //    supports branch is live on both sides rather than silently unused.
  const probe = (prop, value) => prop === 'color' && /^oklch\(/.test(value);
  const [supportsLegacy, supportsCore] = [loadLegacy({ cssSupports: probe }), loadCore({ cssSupports: probe })];
  assert.deepEqual(
    runSharedScenario(supportsCore.api),
    runSharedScenario(supportsLegacy.api),
    `helper drift on CSS.supports path: ${supportsLegacy.label} vs ${supportsCore.label}`,
  );
  assert.equal(supportsLegacy.api.isValidColor('#fff'), false, 'probe must reject hex on legacy side');
  assert.equal(supportsCore.api.isValidColor('#fff'), false, 'probe must reject hex on core side');
  assert.equal(regexLegacy.api.isValidColor('#fff'), true, 'regex path accepts hex on legacy side');

  // 4. Legacy apply battery: full result + style-call trace vs the
  //    core-helper-derived expectation (covers isRecord / getPayloadParts,
  //    which legacy does not export, plus reserved-key and clear behavior).
  const [applyLegacy, applyCore] = [loadLegacy({ cssSupports: null }), loadCore({ cssSupports: null })];
  const applyResults = runApplyBattery(applyLegacy.api, applyCore.api);
  for (const { name, actual, expected } of applyResults) {
    assert.deepEqual(actual, expected, `apply battery scenario '${name}' drifted`);
  }

  // 5. Legacy-only contract: apply without a root throws TypeError
  //    (message-matched: the throw comes from the legacy vm realm, so its
  //    TypeError constructor is not the host one).
  assert.throws(
    () => applyLegacy.api.apply({}, null),
    /document root/,
    'apply must require a document root',
  );

  console.log('test-chat-theme-contract-core: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
