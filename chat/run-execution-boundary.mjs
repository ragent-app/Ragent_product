import { readFile } from 'node:fs/promises';
import { getRunAcceptanceEvidence, runManifestPath } from './runs.mjs';
import { assertMessageRunBinding, parseMessageRunBinding } from './message-run-contract.mjs';
import { assertRunPublication } from './run-publication-contract.mjs';
import { CHAT_PORT } from '../lib/config.mjs';

export const RESTRICTED_EXECUTION_UNAVAILABLE = 'RESTRICTED_EXECUTION_UNAVAILABLE';
export const TEMPORARY_CONTROL_RUN_CHECK_PATH = '/api/internal/temporary-control-run-check';

function validControlAuthority(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'deviceId,deviceKeyFingerprint,expiresAt,grantId,instanceId,version'
    && value.version === 1 && /^rtg_[A-Za-z0-9_-]{24,64}$/.test(value.grantId || '')
    && /^inst_[A-Za-z0-9_-]{24,64}$/.test(value.instanceId || '')
    && /^rdev_[A-Za-z0-9_-]{24,64}$/.test(value.deviceId || '')
    && /^[a-f0-9]{64}$/.test(value.deviceKeyFingerprint || '')
    && Number.isSafeInteger(value.expiresAt);
}

function unavailable() {
  const error = new Error('Run execution inputs are unavailable; execution was refused');
  error.code = 'RUN_EXECUTION_INPUT_UNAVAILABLE';
  return error;
}

/** The generic runner has no validated restricted-delegation backend yet.
 * A safe permission policy, manifest option, or offline probe cannot enable it.
 * Keep this gate independent of OS: ordinary identity is not a grant boundary.
 */
export function assertRunManifestExecutionBoundary(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw unavailable();
  if (process.env.AGENTOC_RUNTIME_MODE === 'proot'
      && !['safe', 'recommended', 'conservative-auto', 'full-auto'].includes(manifest.options?.riskMode)) {
    const error = new Error('PRoot execution requires an explicit supported risk mode');
    error.code = RESTRICTED_EXECUTION_UNAVAILABLE;
    throw error;
  }
  if (process.env.AGENTOC_RUNTIME_MODE === 'proot' && manifest.options?.privilegedMode === true) {
    const error = new Error('Privileged execution requires an OS isolation boundary unavailable in PRoot');
    error.code = RESTRICTED_EXECUTION_UNAVAILABLE;
    throw error;
  }
  const binding = Object.hasOwn(manifest, 'appApiMessage') ? parseMessageRunBinding(manifest.appApiMessage) : null;
  const control = manifest.options?.temporaryControlAuthority;
  if (control && (!validControlAuthority(control) || manifest.options?.authenticatedPrincipalKind !== 'temporary_device')) throw unavailable();
  if (binding?.principalKind === 'temporary_device'
      || (manifest.options?.authenticatedPrincipalKind === 'temporary_device' && !control)
      || manifest.temporaryAuthority || manifest.preparation?.temporaryAuthority) {
    const error = new Error('Temporary task execution requires an isolated runner that is not available yet');
    error.code = RESTRICTED_EXECUTION_UNAVAILABLE;
    throw error;
  }
}

export function assertRunExecutionBoundary(run, manifest) {
  if (!run || !manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw unavailable();
  assertMessageRunBinding(run, manifest);
  assertRunManifestExecutionBoundary(manifest);
  return { run, manifest };
}

/** Read durable inputs afresh at actual launch/recovery, not caller wire options
 * or the manifest cache. Publication and scoped-message identities must agree.
 */
export async function assertRunLaunchBoundary(runId, { checkControl = checkTemporaryControlRun } = {}) {
  let run, manifest;
  try {
    run = await getRunAcceptanceEvidence(runId);
    if (!run) throw unavailable();
    manifest = JSON.parse(await readFile(runManifestPath(runId), 'utf8'));
    assertRunPublication(run, manifest);
  } catch {
    throw unavailable();
  }
  const result = assertRunExecutionBoundary(run, manifest);
  if (manifest.options?.temporaryControlAuthority) {
    if (!manifest.runPublication?.publicationId) throw unavailable();
    await checkControl(run.id, manifest.runPublication.publicationId);
    // The control-plane response can arrive after the grant's deadline.
    if (manifest.options.temporaryControlAuthority.expiresAt <= Date.now()) throw unavailable();
  }
  return result;
}

/** Ask the control plane, because runner identities cannot read its registry. */
async function checkTemporaryControlRun(runId, publicationId) {
  const base = process.env.AGENTOC_CHAT_BASE_URL || `http://127.0.0.1:${CHAT_PORT}`;
  let url;
  try { url = new URL(base); } catch { throw unavailable(); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw unavailable();
  try {
    const response = await fetch(new URL(TEMPORARY_CONTROL_RUN_CHECK_PATH, url), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId, publicationId }), signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw unavailable();
  } catch { throw unavailable(); }
}

/** Called by the local control plane, with fresh durable Run and grant state. */
export async function authorizeTemporaryControlRun(runId, publicationId, registry) {
  if (typeof runId !== 'string' || !/^run_[A-Za-z0-9_-]{1,128}$/.test(runId)
    || typeof publicationId !== 'string' || !/^[a-f0-9-]{36}$/.test(publicationId)) throw unavailable();
  let run, manifest;
  try {
    run = await getRunAcceptanceEvidence(runId);
    manifest = JSON.parse(await readFile(runManifestPath(runId), 'utf8'));
    assertRunPublication(run, manifest);
    assertRunExecutionBoundary(run, manifest);
    const authority = manifest.options?.temporaryControlAuthority;
    if (!validControlAuthority(authority) || manifest.runPublication?.publicationId !== publicationId) throw unavailable();
    const material = await registry.accessMaterial(authority.grantId);
    if (material.envelope.invitation.instanceId !== authority.instanceId
      || material.grant.deviceId !== authority.deviceId
      || material.claim.deviceKeyFingerprint !== authority.deviceKeyFingerprint
      || material.accessExpiresAt !== authority.expiresAt) throw unavailable();
  } catch { throw unavailable(); }
}
