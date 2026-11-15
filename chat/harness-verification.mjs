// Harness capability verification is intentionally separate from runtime
// admission. It can prove the adapter contract with fixtures and probe a
// command's real version without starting an authenticated or mutating run.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  HARNESS_ADAPTER_CONTRACT_VERSION,
  acceptHarnessEvent,
  createHarnessEventLedger,
  validateHarnessAdapterDescriptor,
} from './harness-contract.mjs';
import { buildPlatformSpawnSpec, resolveExecutableCommandPathAsync } from '../lib/executable-resolution.mjs';
import { listHarnesses } from '../lib/harness-registry.mjs';
import { getHarnessAdapterCompatibility, isAdapterCompatible } from './harness-compatibility.mjs';

const execFileAsync = promisify(execFile);
const VERSION_TIMEOUT_MS = 5_000;

const BASE_EVENTS = Object.freeze([
  'run.started',
  'turn.started',
  'assistant.message',
  'run.completed',
  'run.failed',
  'run.cancelled',
]);

const BUILTIN_ONLY_TARGETS = Object.freeze([
  {
    id: 'claude-compatibility',
    baseId: 'claude',
    name: 'Claude Code (Compatibility)',
    command: 'claude',
    runtimeFamily: 'claude-stream-json',
    integration: 'native-compatibility',
  },
  {
    id: 'claude-bidi',
    baseId: 'claude',
    name: 'Claude Code (Bidi)',
    command: 'claude',
    runtimeFamily: 'claude-stream-json-bidi',
    integration: 'native',
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    command: 'copilot',
    runtimeFamily: 'copilot-json',
    integration: 'native',
  },
  {
    id: 'cline',
    name: 'Cline',
    command: 'cline',
    runtimeFamily: 'cline-json',
    integration: 'headless-adapter',
  },
  {
    id: 'kilo',
    name: 'Kilo Code',
    command: 'kilo',
    runtimeFamily: 'kilo-json',
    integration: 'headless-adapter',
  },
]);

const CAPABILITY_PROFILES = Object.freeze({
  'codex-app-server-json': {
    supportsResume: true,
    supportsSteer: true,
    supportsInterrupt: true,
    supportsApproval: true,
    supportsBidirectionalApproval: true,
    supportsCancelAck: true,
    supportsResumeAnchor: true,
    supportsArtifacts: true,
  },
  'claude-stream-json-bidi': {
    supportsResume: true,
    supportsSteer: true,
    supportsInterrupt: true,
    supportsApproval: true,
    supportsBidirectionalApproval: true,
    supportsCancelAck: true,
    supportsResumeAnchor: true,
    supportsArtifacts: true,
  },
  'claude-stream-json': {
    supportsResume: true,
    supportsSteer: false,
    supportsInterrupt: false,
    supportsApproval: false,
    supportsBidirectionalApproval: false,
    supportsCancelAck: false,
    supportsResumeAnchor: false,
    supportsArtifacts: true,
  },
  'openhands-agent-server': {
    supportsResume: true,
    supportsSteer: false,
    supportsInterrupt: true,
    supportsApproval: true,
    supportsBidirectionalApproval: true,
    supportsCancelAck: false,
    supportsResumeAnchor: false,
    supportsArtifacts: false,
  },
  'agy-stream-json': {
    supportsResume: true,
    supportsSteer: false,
    supportsInterrupt: false,
    supportsApproval: false,
    supportsBidirectionalApproval: false,
    supportsCancelAck: false,
    supportsResumeAnchor: false,
    supportsArtifacts: true,
  },
  'agy-json': {
    supportsResume: true,
    supportsSteer: false,
    supportsInterrupt: false,
    supportsApproval: false,
    supportsBidirectionalApproval: false,
    supportsCancelAck: false,
    supportsResumeAnchor: false,
    supportsArtifacts: true,
  },
  'pi-rpc-jsonl': {
    supportsResume: true,
    supportsSteer: false,
    supportsInterrupt: true,
    supportsApproval: false,
    supportsBidirectionalApproval: false,
    supportsCancelAck: false,
    supportsResumeAnchor: false,
    supportsArtifacts: false,
  },
  'deepseek-harness-acp': {
    supportsResume: false,
    supportsSteer: false,
    supportsInterrupt: false,
    supportsApproval: false,
    supportsBidirectionalApproval: false,
    supportsCancelAck: false,
    supportsResumeAnchor: false,
    supportsArtifacts: false,
  },
  'qwen-code-acp': {
    supportsResume: false,
    supportsSteer: false,
    supportsInterrupt: false,
    supportsApproval: false,
    supportsBidirectionalApproval: false,
    supportsCancelAck: false,
    supportsResumeAnchor: false,
    supportsArtifacts: false,
  },
  'opencode-json': {
    supportsResume: false,
    supportsSteer: false,
    supportsInterrupt: false,
    supportsApproval: false,
    supportsBidirectionalApproval: false,
    supportsCancelAck: false,
    supportsResumeAnchor: false,
    supportsArtifacts: false,
  },
  'kimi-code-acp': {
    supportsResume: false,
    supportsSteer: false,
    supportsInterrupt: false,
    supportsApproval: false,
    supportsBidirectionalApproval: false,
    supportsCancelAck: false,
    supportsResumeAnchor: false,
    supportsArtifacts: false,
  },
  'goose-headless': {
    supportsResume: false,
    supportsSteer: false,
    supportsInterrupt: false,
    supportsApproval: false,
    supportsBidirectionalApproval: false,
    supportsCancelAck: false,
    supportsResumeAnchor: false,
    supportsArtifacts: false,
  },
  'copilot-json': {
    supportsResume: true,
    supportsSteer: false,
    supportsInterrupt: false,
    supportsApproval: false,
    supportsBidirectionalApproval: false,
    supportsCancelAck: false,
    supportsResumeAnchor: false,
    supportsArtifacts: true,
  },
  'hermes-acp': {
    supportsResume: true,
    supportsSteer: false,
    supportsInterrupt: false,
    supportsApproval: false,
    supportsBidirectionalApproval: false,
    supportsCancelAck: false,
    supportsResumeAnchor: false,
    supportsArtifacts: false,
  },
  'cline-json': {
    supportsResume: true,
    supportsSteer: false,
    supportsInterrupt: false,
    supportsApproval: false,
    supportsBidirectionalApproval: false,
    supportsCancelAck: false,
    supportsResumeAnchor: false,
    supportsArtifacts: false,
  },
  'kilo-json': {
    supportsResume: true,
    supportsSteer: false,
    supportsInterrupt: false,
    supportsApproval: false,
    supportsBidirectionalApproval: false,
    supportsCancelAck: false,
    supportsResumeAnchor: false,
    supportsArtifacts: false,
  },
  'unavailable': {
    supportsResume: false,
    supportsSteer: false,
    supportsInterrupt: false,
    supportsApproval: false,
    supportsBidirectionalApproval: false,
    supportsCancelAck: false,
    supportsResumeAnchor: false,
    supportsArtifacts: false,
  },
});

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function capabilityProfile(runtimeFamily, integration = '') {
  if (CAPABILITY_PROFILES[runtimeFamily]) return CAPABILITY_PROFILES[runtimeFamily];
  if (integration === 'unavailable') return CAPABILITY_PROFILES.unavailable;
  return CAPABILITY_PROFILES.unavailable;
}

function operationsFor(capabilities) {
  const operations = ['start', 'sendTurn', 'cancel', 'terminate'];
  if (capabilities.supportsResume) operations.push('resume');
  if (capabilities.supportsResumeAnchor) operations.push('getResumeAnchor');
  if (capabilities.supportsSteer) operations.push('steer');
  if (capabilities.supportsApproval) operations.push('respondToApproval');
  if (capabilities.supportsCancelAck) operations.push('acknowledgeCancel');
  if (capabilities.supportsArtifacts) operations.push('listArtifacts');
  return operations;
}

function eventsFor(capabilities) {
  const events = [...BASE_EVENTS];
  if (capabilities.supportsResume) events.push('run.resumed');
  if (capabilities.supportsResumeAnchor) events.push('checkpoint.created');
  if (capabilities.supportsApproval) events.push('tool.approval_required');
  if (capabilities.supportsBidirectionalApproval) events.push('approval.responded');
  if (capabilities.supportsCancelAck) {
    events.push('run.cancel_requested', 'run.cancel_acknowledged');
  }
  if (capabilities.supportsArtifacts) events.push('artifact.created', 'artifact.published');
  return [...new Set(events)];
}

function descriptorFor(target) {
  const capabilities = { ...capabilityProfile(target.serviceRuntimeFamily || target.runtimeFamily, target.integration) };
  const transport = target.runtimeFamily === 'codex-app-server-json'
    ? 'json-rpc-stdio'
    : target.runtimeFamily === 'openhands-agent-server'
      ? 'http-sse'
      : target.runtimeFamily?.endsWith('-acp')
        ? 'acp'
        : target.runtimeFamily?.endsWith('-jsonl')
          ? 'process-jsonl-bidi'
          : 'process-jsonl';
  return {
    contractVersion: HARNESS_ADAPTER_CONTRACT_VERSION,
    id: target.id,
    provider: target.baseId || target.id,
    transport,
    operations: operationsFor(capabilities),
    capabilities,
    events: eventsFor(capabilities),
    versionPolicy: {
      harness: target.adapterCompatibility?.harness || '',
      adapter: target.adapterCompatibility?.adapterVersion || '',
      compatibleVersions: target.adapterCompatibility?.compatibleVersions || [],
    },
  };
}

function fixtureEvents(runId, turnId) {
  const event = (seq, eventId, type, data = {}) => ({
    schemaVersion: HARNESS_ADAPTER_CONTRACT_VERSION,
    seq,
    eventId,
    runId,
    turnId,
    type,
    data,
  });
  return [
    event(1, 'evt-start', 'run.started'),
    event(2, 'evt-turn', 'turn.started'),
    event(3, 'evt-approval', 'tool.approval_required', {
      approvalId: 'approval-fixture-1',
      providerRequestId: 'provider-fixture-1',
      toolName: 'browser.click',
    }),
    event(4, 'evt-approval-response', 'approval.responded', {
      approvalId: 'approval-fixture-1',
      providerRequestId: 'provider-fixture-1',
      decision: 'approved',
      status: 'approved',
    }),
    event(5, 'evt-checkpoint', 'checkpoint.created', {
      checkpoint: { providerResumeId: 'provider-resume-fixture-1' },
    }),
    event(6, 'evt-resumed', 'run.resumed', {
      resumeAnchor: { providerResumeId: 'provider-resume-fixture-1' },
    }),
    event(7, 'evt-artifact', 'artifact.created', {
      artifactId: 'artifact-fixture-1',
      filePath: '/tmp/ragent-harness-fixture.txt',
      sha256: 'a'.repeat(64),
      sizeBytes: 12,
    }),
    event(8, 'evt-artifact-published', 'artifact.published', {
      artifactId: 'artifact-fixture-1',
      filePath: '/tmp/ragent-harness-fixture.txt',
    }),
    event(9, 'evt-cancel-requested', 'run.cancel_requested'),
    event(10, 'evt-cancel-acknowledged', 'run.cancel_acknowledged'),
    event(11, 'evt-completed', 'run.completed', { content: 'done' }),
  ];
}

function verifyFixture(descriptor) {
  const runId = `verification-run-${descriptor.id}`;
  const turnId = `verification-turn-${descriptor.id}`;
  const declaredEvents = new Set(Array.isArray(descriptor?.events) ? descriptor.events : []);
  // Replay only the events this adapter declares. This keeps an adapter with
  // process cancellation, but no provider cancel acknowledgement, from being
  // reported as if it implemented the stronger lifecycle contract.
  const events = fixtureEvents(runId, turnId).filter((event) => declaredEvents.has(event.type));
  const ledger = createHarnessEventLedger({ runId, turnId });
  const accepted = [];
  const rejected = [];
  for (const event of events) {
    const result = acceptHarnessEvent(event, ledger);
    if (result.accepted) accepted.push(result.event);
    else rejected.push(result);
  }
  const duplicateSource = events[Math.min(3, Math.max(0, events.length - 1))];
  const duplicate = duplicateSource
    ? acceptHarnessEvent(duplicateSource, ledger)
    : { duplicate: false };
  const approvalRequest = accepted.find((event) => event.type === 'tool.approval_required');
  const approvalResponse = accepted.find((event) => event.type === 'approval.responded');
  const approvalCorrelated = approvalRequest?.data?.approvalId === approvalResponse?.data?.approvalId
    && approvalRequest?.data?.providerRequestId === approvalResponse?.data?.providerRequestId;
  const cancelRequested = accepted.some((event) => event.type === 'run.cancel_requested');
  const cancelAcknowledged = accepted.some((event) => event.type === 'run.cancel_acknowledged');
  const resumed = accepted.some((event) => event.type === 'run.resumed');
  const checkpointed = accepted.some((event) => event.type === 'checkpoint.created');
  const artifactCreated = accepted.some((event) => event.type === 'artifact.created');
  const artifactPublished = accepted.some((event) => event.type === 'artifact.published');
  const validation = validateHarnessAdapterDescriptor(descriptor);
  return {
    descriptorValid: validation.valid,
    descriptorErrors: validation.errors,
    stream: {
      status: validation.valid && rejected.length === 0 && duplicate.duplicate === true ? 'verified' : 'unsupported',
      acceptedEvents: accepted.length,
      duplicateSuppressed: duplicate.duplicate === true,
      lastSeq: ledger.lastSeq,
    },
    approvalFixture: {
      status: descriptor.capabilities?.supportsBidirectionalApproval
        ? (approvalCorrelated ? 'verified' : 'unsupported')
        : 'unsupported',
      correlated: approvalCorrelated,
    },
    cancelFixture: {
      status: descriptor.capabilities?.supportsCancelAck && cancelRequested && cancelAcknowledged
        ? 'verified'
        : 'unsupported',
      requested: cancelRequested,
      acknowledged: cancelAcknowledged,
    },
    resumeFixture: {
      status: descriptor.capabilities?.supportsResume && resumed ? 'verified' : 'unsupported',
      checkpointed,
      resumed,
    },
    artifactFixture: {
      status: descriptor.capabilities?.supportsArtifacts && artifactCreated && artifactPublished
        ? 'verified'
        : 'unsupported',
      created: artifactCreated,
      published: artifactPublished,
    },
    eventTypes: accepted.map((event) => event.type),
  };
}

function capabilityCheck(supported, available, name, reason) {
  if (!supported) return { status: 'unsupported', reason };
  if (!available) return { status: 'unavailable', reason: 'harness command is unavailable' };
  return { status: 'not-run', reason: `live ${name} verification requires an authenticated, user-scoped run` };
}

function parseVersion(output) {
  const value = String(output || '').trim();
  const match = value.match(/\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
  return { raw: value.slice(0, 500), version: match?.[1] || '' };
}

async function resolveTargetPath(target) {
  if (target.path) return target.path;
  return resolveExecutableCommandPathAsync(target.command).catch(() => null);
}

export async function probeHarnessVersion(target, { execFileImpl = execFileAsync } = {}) {
  const command = await resolveTargetPath(target);
  if (!command) {
    return { status: 'unavailable', command: target.command, version: '', reason: 'command is unavailable' };
  }
  try {
    const spawnSpec = buildPlatformSpawnSpec(command, ['--version']);
    const result = await execFileImpl(spawnSpec.file, spawnSpec.args, {
      timeout: VERSION_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
      windowsHide: true,
      shell: spawnSpec.shell,
      ...(spawnSpec.windowsVerbatimArguments === undefined
        ? {}
        : { windowsVerbatimArguments: spawnSpec.windowsVerbatimArguments }),
    });
    const parsed = parseVersion(`${result?.stdout || ''}\n${result?.stderr || ''}`);
    if (!parsed.version) {
      return { status: 'unsupported', command, version: '', raw: parsed.raw, reason: 'version output was not parseable' };
    }
    const compatibility = target.adapterCompatibility || getHarnessAdapterCompatibility(target.baseId || target.id);
    const compatible = compatibility?.compatibleVersions?.some((pattern) => (
      pattern === 'latest' || isAdapterCompatible(target.baseId || target.id, parsed.version)
    )) ?? false;
    return {
      status: compatible ? 'verified' : 'unsupported',
      command,
      version: parsed.version,
      raw: parsed.raw,
      expected: compatibility?.compatibleVersions || [],
      reason: compatible ? 'real --version output matches adapter policy' : 'real version is outside adapter policy',
    };
  } catch (error) {
    return {
      status: 'unavailable',
      command,
      version: '',
      reason: String(error?.stderr || error?.message || 'version probe failed').trim().slice(-500),
    };
  }
}

async function normalizeTargets(registryHarnesses, { includeBuiltins = true } = {}) {
  const registryById = new Map(registryHarnesses.map((harness) => [harness.id, harness]));
  const targets = registryHarnesses.map((harness) => ({
    ...harness,
    adapterCompatibility: harness.adapterCompatibility || getHarnessAdapterCompatibility(harness.id),
  }));
  if (!includeBuiltins) return targets;
  for (const builtin of BUILTIN_ONLY_TARGETS) {
    if (targets.some((target) => target.id === builtin.id)) continue;
    const base = registryById.get(builtin.baseId || builtin.id);
    targets.push({
      ...builtin,
      available: base?.available ?? Boolean(await resolveExecutableCommandPathAsync(builtin.command).catch(() => null)),
      commandAvailable: base?.commandAvailable ?? base?.available ?? false,
      path: base?.path || null,
      supportedOnPlatform: true,
      adapterCompatibility: getHarnessAdapterCompatibility(builtin.baseId || builtin.id),
    });
  }
  return targets;
}

export async function getHarnessVerificationTargets({ harnesses, includeBuiltins = true } = {}) {
  return normalizeTargets(harnesses || await listHarnesses(), { includeBuiltins });
}

export async function verifyHarnessLifecycleMatrix({ harnesses, includeBuiltins = true, execFileImpl = execFileAsync } = {}) {
  const targets = await getHarnessVerificationTargets({ harnesses, includeBuiltins });
  const results = [];
  for (const target of targets) {
    const descriptor = descriptorFor(target);
    const fixture = verifyFixture(descriptor);
    const capabilities = descriptor.capabilities;
    const available = target.available === true || target.commandAvailable === true;
    const version = await probeHarnessVersion(target, { execFileImpl });
    results.push({
      id: target.id,
      name: target.name,
      baseId: target.baseId || target.id,
      command: target.command,
      path: target.path || null,
      runtimeFamily: target.runtimeFamily || null,
      integration: target.integration || null,
      available,
      descriptor,
      contract: {
        status: fixture.descriptorValid ? 'verified' : 'unsupported',
        errors: fixture.descriptorErrors,
      },
      stream: fixture.stream,
      approval: capabilities.supportsBidirectionalApproval
        ? capabilityCheck(true, available, 'bidirectional approval', 'harness does not declare bidirectional approval')
        : { status: 'unsupported', reason: 'harness does not declare a bidirectional approval operation and response event' },
      cancel: capabilityCheck(
        capabilities.supportsCancelAck,
        available,
        'cancel acknowledgement',
        'harness exposes process cancellation only; no provider cancellation acknowledgement contract',
      ),
      resume: capabilityCheck(
        capabilities.supportsResume,
        available,
        'resume',
        'harness has no declared resume operation',
      ),
      artifacts: capabilityCheck(
        capabilities.supportsArtifacts,
        available,
        'artifact publication',
        'harness has no declared artifact event/publication contract',
      ),
      version,
      fixtureEvidence: {
        approval: fixture.approvalFixture,
        cancel: fixture.cancelFixture,
        resume: fixture.resumeFixture,
        artifacts: fixture.artifactFixture,
        eventTypes: fixture.eventTypes,
        replay: fixture.stream,
      },
    });
  }
  return {
    schemaVersion: 1,
    contractVersion: HARNESS_ADAPTER_CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    policy: {
      liveRunRequiredFor: ['approval', 'cancel', 'resume', 'artifacts'],
      versionProbe: '--version only; no install or upgrade is performed',
      statusMeaning: {
        verified: 'contract or read-only version evidence passed',
        unsupported: 'the adapter does not declare this capability or the version is outside policy',
        unavailable: 'the command or service is not available on this host',
        'not-run': 'capability is declared but a live authenticated run was intentionally not started',
      },
    },
    harnesses: results,
  };
}

export { BASE_EVENTS, BUILTIN_ONLY_TARGETS, CAPABILITY_PROFILES, descriptorFor, verifyFixture };
