#!/usr/bin/env node
// Source-level guard (统一风险门控计划 phase 3): the sidecar's two gate call
// sites (Codex app-server + Claude bidi) must route through decideRunGate,
// which dispatches to decideRiskGate when the run carries a gated riskMode and
// falls back to the legacy privileged gate otherwise. If a call site is ever
// rewired directly to decidePrivilegedGate, risk-gated sessions silently lose
// their gate — this test catches that regression without importing the
// process-entry module (mirrors test-runner-sidecar-interaction-mode.mjs).
import assert from 'assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(join(repoRoot, 'chat', 'runner-sidecar.mjs'), 'utf8');

let passed = 0;
function check(label, condition) {
  assert.ok(condition, `failed: ${label}`);
  passed += 1;
}

const callSites = [...source.matchAll(/(?:(?:const|let) gateDecision = await decideRunGate\([^;]+,\s*state\);|:\s*await decideRunGate\([^;]+,\s*state\);)/g)];
check('all three gate call sites route via decideRunGate', callSites.length === 3);
check('decideRiskGate is imported', /decideRiskGate/.test(source));
check('state carries riskMode (Codex + Claude + ACP state creators)',
  (source.match(/riskMode: typeof options\.riskMode/g) || []).length === 3);
check('gate dispatch honors gated risk modes',
  /\['safe', 'recommended', 'full-auto', 'conservative-auto'\]\.includes\(riskMode\)/.test(source));
check('decideRunGate keeps user-facing kinds on the review path',
  /isUserFacingGateKind\(approval\?\.kind \|\| ''\)/.test(source));
check('decideRunGate routes gated permission modes through the classifier',
  /isGatedPermissionMode\(state\?\.permissionMode \|\| ''\)/.test(source));
check('gated-mode fallback uses recommended semantics for legacy sessions',
  /riskMode:\s*\['safe', 'recommended', 'full-auto', 'conservative-auto'\]\.includes\(riskMode\) \? riskMode : 'recommended'/.test(source));
check('Codex and Claude state creators carry permissionMode and ACP carries permissionMode',
  (source.match(/permissionMode: typeof options\.permissionMode === 'string' \? options\.permissionMode : ''/g) || []).length === 2
  && /createAcpRunState[\s\S]*?permissionMode:/.test(source));

console.log(`runner-sidecar risk-gate routing: ${passed} checks passed`);
