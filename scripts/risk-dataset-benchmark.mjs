#!/usr/bin/env node

// Offline risk benchmark. It imports JSONL records, classifies commands and
// asks the risk gate for a decision; it never invokes a shell executor,
// provider, package manager, sudo, or privileged service.

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decideRiskGate } from '../chat/privileged-gate.mjs';
import { classifyRisk } from '../chat/risk-classifier.mjs';
import { RISK_POLICY_VERSION } from '../chat/risk-policy.mjs';

const ROOT = resolve(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const FIXTURE_ROOT = join(ROOT, 'tests/fixtures/risk-datasets');
const MANIFEST_PATH = join(FIXTURE_ROOT, 'manifest.json');
const CONTEXT = Object.freeze({
  // The maintained boundary fixture predates this checkout path and uses
  // /srv/ragent-promoted as its synthetic project root. Keep the benchmark
  // path-independent while making that fixture's Edit case meaningful.
  cwd: '/srv/ragent-promoted',
  projectRoot: '/srv/ragent-promoted',
  home: '/home/example',
  riskContext: Object.freeze({
    schemaVersion: 1,
    platform: process.platform,
    trustedWorkspaceRoot: '/srv/ragent-promoted',
    protectedRoots: [],
  }),
});

function parseArgs(argv) {
  const result = { mode: 'smoke', variants: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--smoke' || token === '--full') {
      result.mode = token.slice(2);
      continue;
    }
    if (token === '--help' || token === '-h') {
      result.help = true;
      continue;
    }
    if (!token.startsWith('--')) throw new Error(`unknown argument: ${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for --${key}`);
    result[key] = value;
    index += 1;
  }
  return result;
}

function usage() {
  console.log(`Usage:
  node scripts/risk-dataset-benchmark.mjs --smoke [--report PATH]
  node scripts/risk-dataset-benchmark.mjs --full [--variants PATH] [--report PATH]`);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function readJsonLines(text, sourceName) {
  return text.split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${sourceName}: invalid JSONL at line ${index + 1}: ${error.message}`);
    }
  });
}

async function loadManifest() {
  return JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
}

async function loadDataset(manifest, dataset, { limit = Number.POSITIVE_INFINITY } = {}) {
  const path = join(FIXTURE_ROOT, dataset.path);
  const content = await readFile(path);
  const actualSha256 = sha256(content);
  if (actualSha256 !== dataset.sha256) {
    throw new Error(`${dataset.id}: sha256 mismatch; expected ${dataset.sha256}, got ${actualSha256}`);
  }
  const rows = readJsonLines(content.toString('utf8'), dataset.id).slice(0, limit);
  if (rows.length !== Math.min(dataset.records, limit)) {
    throw new Error(`${dataset.id}: record count mismatch`);
  }
  return rows.map((row, index) => ({
    ...row,
    caseId: row.caseId || `${dataset.id}:${String(index + 1).padStart(6, '0')}`,
    source: row.source || dataset.id,
    baseLabel: row.baseLabel || dataset.label,
    executable: row.executable !== false,
    ...(dataset.id.startsWith('taglio4-') ? { expectedTier: dataset.label } : {}),
  }));
}

function approvalFor(record) {
  const toolName = record.toolName || 'Bash';
  const toolInput = record.toolInput && typeof record.toolInput === 'object'
    ? record.toolInput
    : { command: record.command || '' };
  return {
    approvalId: `benchmark:${record.caseId}`,
    kind: toolName === 'Bash' ? 'command' : 'permissions',
    params: { tool_name: toolName, input: toolInput },
  };
}

function expectedRoute(gate) {
  if (gate.risk?.signals?.autoExecute === true) return 'install-auto';
  if (gate.decision === 'accumulate') return 'passkey';
  return 'none';
}

function histogram(map, key) {
  const normalized = String(key || 'unknown');
  map[normalized] = (map[normalized] || 0) + 1;
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const index = Math.min(values.length - 1, Math.floor(values.length * fraction));
  return values[index];
}

function classifyRecord(record) {
  const input = {
    command: record.command || '',
    toolName: record.toolName || '',
    toolInput: record.toolInput || {},
    ...CONTEXT,
  };
  const started = process.hrtime.bigint();
  let risk;
  let gate;
  try {
    risk = classifyRisk(input);
    gate = decideRiskGate(approvalFor(record), { riskMode: 'recommended', ...CONTEXT });
  } catch (error) {
    return { record, error: error.message, elapsedMs: Number(process.hrtime.bigint() - started) / 1e6 };
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const actualReasonCodes = (risk.reasons || []).map((reason) => reason.code);
  const boundary = record.source === 'ragent-boundaries';
  const failures = [];
  if (record.baseLabel === 'unsafe' && risk.tier === 'safe') failures.push('unsafe_as_safe');
  if (boundary && record.expectedTier && risk.tier !== record.expectedTier) failures.push('boundary_tier_mismatch');
  if (boundary && record.expectedGateDecision && gate.decision !== record.expectedGateDecision) {
    failures.push('boundary_gate_mismatch');
  }
  if (boundary && record.expectedRoute && expectedRoute(gate) !== record.expectedRoute) {
    failures.push('boundary_route_mismatch');
  }
  if (boundary && Array.isArray(record.expectedReasonCodes)
    && !record.expectedReasonCodes.some((code) => actualReasonCodes.includes(code))) {
    failures.push('boundary_reason_mismatch');
  }
  return {
    caseId: record.caseId,
    source: record.source,
    baseLabel: record.baseLabel,
    command: record.command || '',
    tier: risk.tier,
    gateDecision: gate.decision,
    route: expectedRoute(gate),
    reasonCodes: actualReasonCodes,
    policyVersion: risk.policyVersion,
    confidence: risk.confidence,
    elapsedMs,
    failures,
  };
}

function buildSummary(records, results, mode, batchElapsedMs) {
  const latencies = results.filter((result) => Number.isFinite(result.elapsedMs)).map((result) => result.elapsedMs).sort((a, b) => a - b);
  const tierByLabel = {};
  const gateDecisions = {};
  const routes = {};
  const reasons = {};
  const failures = [];
  let safeFalsePositives = 0;
  let unsafeAsSafe = 0;
  let errors = 0;
  let safeLabeled = 0;
  let unsafeLabeled = 0;
  for (const result of results) {
    if (result.error) {
      errors += 1;
      failures.push({ ...result, failure: 'exception' });
      continue;
    }
    histogram(tierByLabel, `${result.baseLabel}->${result.tier}`);
    histogram(gateDecisions, result.gateDecision);
    histogram(routes, result.route);
    for (const code of result.reasonCodes) histogram(reasons, code);
    if (result.baseLabel === 'safe') {
      safeLabeled += 1;
      if (result.tier !== 'safe') safeFalsePositives += 1;
    }
    if (result.baseLabel === 'unsafe') unsafeLabeled += 1;
    if (result.failures.includes('unsafe_as_safe')) unsafeAsSafe += 1;
    if (result.failures.length > 0) failures.push(result);
  }
  const stableSamples = records.slice(0, Math.min(100, records.length));
  let unstable = 0;
  for (const record of stableSamples) {
    const input = { command: record.command || '', toolName: record.toolName || '', toolInput: record.toolInput || {}, ...CONTEXT };
    const a = classifyRisk(input);
    const b = classifyRisk(input);
    if (JSON.stringify({ tier: a.tier, reasons: a.reasons, policyVersion: a.policyVersion })
      !== JSON.stringify({ tier: b.tier, reasons: b.reasons, policyVersion: b.policyVersion })) unstable += 1;
  }
  const hardFailures = failures.filter((failure) => (
    failure.failure === 'exception'
    || failure.failures?.includes('unsafe_as_safe')
    || failure.failures?.some((item) => item.startsWith('boundary_'))
  ));
  return {
    ok: hardFailures.length === 0 && unstable === 0,
    mode,
    policyVersion: RISK_POLICY_VERSION,
    records: records.length,
    errors,
    hardFailureCount: hardFailures.length,
    unsafeAsSafe,
    unsafeAsSafeRate: unsafeLabeled ? unsafeAsSafe / unsafeLabeled : 0,
    safeFalsePositives,
    safeFalsePositiveRate: safeLabeled ? safeFalsePositives / safeLabeled : 0,
    stability: { samples: stableSamples.length, unstable },
    latencyMs: {
      p50: percentile(latencies, 0.50),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
      max: latencies.at(-1) || 0,
      mean: latencies.length ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : 0,
    },
    performance: {
      batchElapsedMs,
      throughputPerSecond: batchElapsedMs > 0 ? (records.length * 1000) / batchElapsedMs : 0,
      rssMiB: process.memoryUsage().rss / (1024 * 1024),
      heapUsedMiB: process.memoryUsage().heapUsed / (1024 * 1024),
    },
    tierByLabel,
    gateDecisions,
    routes,
    reasonCodes: reasons,
    failures: failures.slice(0, 100),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  const manifest = await loadManifest();
  const limit = options.mode === 'smoke' ? 100 : Number.POSITIVE_INFINITY;
  const records = [];
  for (const dataset of manifest.datasets || []) {
    records.push(...await loadDataset(manifest, dataset, { limit: dataset.id === 'ragent-boundaries' ? Number.POSITIVE_INFINITY : limit }));
  }
  if (options.variants) {
    records.push(...readJsonLines(await readFile(resolve(options.variants), 'utf8'), options.variants));
  }
  // Warm up V8 before measuring the static corpus; this keeps cold module/JIT
  // startup out of p95/p99 and makes runs comparable across machines.
  for (let index = 0; index < 250; index += 1) {
    classifyRisk({ command: index % 2 ? 'ls -la' : 'rm -rf /tmp/probe-*', ...CONTEXT });
  }
  const batchStarted = process.hrtime.bigint();
  const results = records.map(classifyRecord);
  const batchElapsedMs = Number(process.hrtime.bigint() - batchStarted) / 1e6;
  const summary = buildSummary(records, results, options.mode, batchElapsedMs);
  if (options.report) await writeFile(resolve(options.report), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o644 });
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`risk-dataset-benchmark: ${error.message}`);
  process.exitCode = 1;
});
