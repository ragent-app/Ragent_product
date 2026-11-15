#!/usr/bin/env node
// Proposal-admission coverage: a policy-refused host action must stop before
// the owner-click or passkey approval gates, so no client-visible approval
// card can later fail during capability issuance.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'approved-action-owner-click-'));
process.env.RAGENT_CONFIG_DIR = join(root, 'config');
process.env.RAGENT_MEMORY_DIR = join(root, 'memory');
process.env.RAGENT_AGENT_CREATE_APPROVED_ACTION_ENABLED = '1';
process.env.RAGENT_PERF_WRITE_DEBOUNCE = 'off';

const {
  createSession,
  getSessionEventsPage,
  proposeApprovedActions,
} = await import('../chat/session-manager.mjs');
const { createRun, getRun } = await import('../chat/runs.mjs');
const { mutateSessionMeta } = await import('../chat/session-meta-store.mjs');

function tokenHash(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

async function createBoundRun(session, suffix) {
  const token = `token-${suffix}`;
  const runId = `run_${suffix}`;
  const turnId = `turn_${suffix}`;
  await createRun({
    status: {
      id: runId,
      sessionId: session.id,
      requestId: turnId,
      state: 'running',
      tool: 'codex',
      runtimeFamily: 'codex-app-server-json',
    },
    manifest: {
      sessionId: session.id,
      requestId: turnId,
      folder: root,
      tool: 'codex',
      options: {
        approvedActionChannel: {
          tokenHash: tokenHash(token),
          turnId,
        },
      },
    },
  });
  await mutateSessionMeta(session.id, (draft) => {
    draft.activeRunId = runId;
    return true;
  });
  return { token, runId, turnId };
}

function hostProposal(binding, sessionId) {
  return {
    token: binding.token,
    tokenMatches: (provided, expectedHash) => tokenHash(provided) === expectedHash,
    requestKey: `request-${binding.runId}`,
    sessionId,
    runId: binding.runId,
    turnId: binding.turnId,
    actions: [{
      command: 'sudo systemctl restart nginx',
      cwd: root,
      description: 'Restart the proxy service',
      reason: 'Apply the approved configuration',
    }],
  };
}

async function proposeHostBatch(suffix) {
  const session = await createSession(root, 'codex', `Host ${suffix}`, {
    riskMode: 'recommended',
  });
  const binding = await createBoundRun(session, suffix);
  return { session, binding };
}

let failed = false;
try {
  // --- default owner-click policy ---
  delete process.env.RAGENT_OWNER_HOST_PASSKEY_REQUIRED;
  const clickApproval = await proposeHostBatch('click');
  const preflight = { ...hostProposal(clickApproval.binding, clickApproval.session.id), autoInstallPreflight: true,
    actions: [{ command: 'winget install Example.Package' }] };
  assert.deepEqual(await proposeApprovedActions(preflight), { kind: 'automatic_install_preflight', ready: false });
  await assert.rejects(proposeApprovedActions({ ...preflight, token: 'wrong-token' }), { code: 'APPROVED_ACTION_TOKEN_INVALID' });
  assert.equal((await getRun(clickApproval.binding.runId)).approvedActionPending, undefined);
  // A server DENY must never become a waiting_user card, even under the
  // owner-click policy. This leaves capability issuance and the executor out
  // of the request entirely.
  await assert.rejects(
    proposeApprovedActions(hostProposal(clickApproval.binding, clickApproval.session.id)),
    (error) => error?.code === 'APPROVED_ACTION_PROPOSAL_DENIED',
  );
  const clickEvents = await getSessionEventsPage(clickApproval.session.id, { includeBodies: true });
  assert.equal(clickEvents.events.some((event) => event.type === 'approved_action_batch_request'), false);
  assert.equal((await getRun(clickApproval.binding.runId)).approvedActionPending, undefined);

  // --- passkey policy opt-in does not resurrect a denied approval card ---
  process.env.RAGENT_OWNER_HOST_PASSKEY_REQUIRED = '1';
  const passkeyApproval = await proposeHostBatch('passkey');
  await assert.rejects(
    proposeApprovedActions(hostProposal(passkeyApproval.binding, passkeyApproval.session.id)),
    (error) => error?.code === 'APPROVED_ACTION_PROPOSAL_DENIED',
  );
  const passkeyEvents = await getSessionEventsPage(passkeyApproval.session.id, { includeBodies: true });
  assert.equal(passkeyEvents.events.some((event) => event.type === 'approved_action_batch_request'), false);

  console.log('approved-action-owner-click: ok');
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await import('../chat/session-manager.mjs').then((m) => m.killAll?.()).catch(() => {});
  delete process.env.RAGENT_OWNER_HOST_PASSKEY_REQUIRED;
}
if (failed) process.exit(1);
