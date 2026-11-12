import { readFile } from 'node:fs/promises';
import { createKeyedTaskQueue } from './fs-utils.mjs';
import { withSessionApiScope, findSessionMeta, readSessionMessagePreparations } from './session-meta-store.mjs';
import { withMessageRequestIdentity } from './message-request-identity.mjs';
import { validatePreparedMessageAttachments } from './message-preparation-store.mjs';
import { authorizeMessageAttachmentSizes } from './message-attachment-account-policy.mjs';
import { parseSessionApiScope } from './session-api-scope-contract.mjs';
import { sessionApiError, sessionApiIdentifier } from './session-api-mutation-contract.mjs';
import { createMessageRunBinding, messageRunId, assertMessageRunBinding } from './message-run-contract.mjs';
import { createRun, getRun, getRunAcceptanceEvidence, updateRun, runManifestPath, isTerminalRunState, listRunIndexEntries, requestRunCancel } from './runs.mjs';
import { publishSessionRun } from './session-run-admission.mjs';
import { withMessageExecution, withoutMessageExecution } from './message-execution-context.mjs';
import { getApp } from './apps.mjs';
import { authorizeTemporaryMessage } from './temporary-message-authorization.mjs';
import { assertTemporaryMessageRequest, parseTemporaryOperationAuthority } from '../lib/temporary-operation-authority.mjs';
import { assertRunExecutionBoundary, RESTRICTED_EXECUTION_UNAVAILABLE } from './run-execution-boundary.mjs';

const continuations = createKeyedTaskQueue();
const sameScope = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function deadline(record) {
  if (Date.parse(record.request.expiresAt) <= Date.now())
    throw sessionApiError('REQUEST_EXPIRED', 410, 'Prepared message expired before execution admission');
}
export function parseMessageCommit(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 ||
      Object.keys(value).length !== 2 || typeof value.preparationId !== 'string' ||
      !/^mprep_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.preparationId))
    throw sessionApiError('INVALID_ARGUMENT', 400, 'Commit requires only version and original preparationId');
  return { version: 1, preparationId: value.preparationId };
}
async function originalRecord(sessionId, requestId, scope, preparationId) {
  const record = (await readSessionMessagePreparations(sessionId)).find(row => row.requestId === requestId);
  if (!record) throw sessionApiError('RESOURCE_NOT_FOUND', 404, 'Message preparation is unavailable');
  if (!sameScope(record.scope, scope) || (preparationId && preparationId !== record.preparationId))
    throw sessionApiError('MESSAGE_IDEMPOTENCY_CONFLICT', 409, 'Use the original prepared message identity and scope');
  return record;
}
/** Both files are read afresh; cached input cannot authorize a continuation. */
export async function readMessageRun(runId) {
  const run = await getRunAcceptanceEvidence(runId);
  if (!run) return null;
  let manifest;
  try { manifest = JSON.parse(await readFile(runManifestPath(runId), 'utf8')); }
  catch { throw sessionApiError('MESSAGE_RUN_BINDING_INVALID', 503, 'Message Run inputs are unavailable'); }
  const binding = assertMessageRunBinding(run, manifest);
  if (!binding) throw sessionApiError('MESSAGE_RUN_BINDING_INVALID', 503, 'Run is not a scoped message');
  const record = await originalRecord(run.sessionId, run.requestId, binding.scope, binding.preparationId);
  if (record.fingerprint !== binding.fingerprint)
    throw sessionApiError('MESSAGE_RUN_BINDING_INVALID', 503, 'Message Run prepared facts changed');
  if (binding.principalKind === 'temporary_device') assertTemporaryMessageRequest(record.request, binding.temporaryAuthority);
  return { run, manifest, binding, record };
}
function receipt(record, run, duplicate = false) {
  return { version: 1, sessionId: record.sessionId, requestId: record.requestId,
    preparationId: record.preparationId, runId: run?.id || null,
    state: run?.state || 'unconfirmed', accepted: Boolean(run),
    queued: run?.state === 'queued', duplicate, expiresAt: record.request.expiresAt,
    acceptedAt: run?.ackAt || null, updatedAt: run?.updatedAt || record.createdAt,
    launchAdmittedAt: run?.messageLaunchAdmittedAt || null,
    dispatched: Boolean(run?.runnerStartedAt || run?.runnerLifecycleAcceptedAt),
    failureCode: run?.messageFailureCode || null };
}
export async function commitSessionApiMessage(sessionId, scopeInput, requestId, payload, principalKind, { authorize, temporaryAuthority, ownerDevice, authSession } = {}) {
  sessionApiIdentifier(sessionId, 256); sessionApiIdentifier(requestId);
  const scope = parseSessionApiScope(scopeInput, sessionId);
  const input = parseMessageCommit(payload);
  const temporary = principalKind === 'temporary_device';
  if (temporary) temporaryAuthority = parseTemporaryOperationAuthority(temporaryAuthority);
  if ((!temporary && !['owner', 'trusted_device'].includes(principalKind)) || (temporary && typeof authorize !== 'function'))
    throw sessionApiError('PERMISSION_DENIED', 403, 'Authenticated PC principal is required');
  return withMessageRequestIdentity(sessionId, requestId, async () => {
    const record = await originalRecord(sessionId, requestId, scope, input.preparationId);
    if (temporary) assertTemporaryMessageRequest(record.request, temporaryAuthority);
    const runId = messageRunId(record);
    const replay = await readMessageRunIfPublished(runId);
    if (replay) return withSessionApiScope(sessionId, scope, async () => {
      await authorize?.(await findSessionMeta(sessionId));
      if (temporary && (replay.binding.principalKind !== principalKind
        || JSON.stringify(replay.binding.temporaryAuthority) !== JSON.stringify(temporaryAuthority)))
        throw sessionApiError('MESSAGE_IDEMPOTENCY_CONFLICT', 409, 'Message continuation belongs to another authority');
      return receipt(record, replay.run, true);
    });
    deadline(record);
    await authorizeMessageAttachmentSizes(record.request, temporary ? null : authSession);
    await validatePreparedMessageAttachments(sessionId, scope, record.request.attachments);
    const initialMeta = await findSessionMeta(sessionId);
    const templateId = record.request.runOptions.templateId || initialMeta?.templateId;
    const template = templateId ? await getApp(templateId) : null;
    if (templateId && !template)
      throw sessionApiError('RESOURCE_NOT_FOUND', 404, 'Selected Agent template is unavailable');
    return withSessionApiScope(sessionId, scope, async () => {
      deadline(record);
      const meta = await findSessionMeta(sessionId);
      if (!record.request.runOptions.templateId && (meta.templateId || null) !== (initialMeta?.templateId || null))
        throw sessionApiError('REVISION_CONFLICT', 409, 'Session template changed during message acceptance');
      const frozenMeta = { ...meta, templatePerMessageSystemPrompt: template?.perMessageSystemPrompt || null,
        ...(record.request.runOptions.templateId && template ? { templateId: template.id, templateName: template.name || '',
          systemPrompt: template.systemPrompt || '' } : {}) };
      if (temporary) Object.assign(frozenMeta, { riskMode: 'safe', riskModeExplicit: true, privilegedMode: false,
        canDelegate: false, privilegeRoutingEnabled: false, permissionMode: null, templateId: null,
        templateName: null, templatePerMessageSystemPrompt: null });
      const binding = createMessageRunBinding(record, frozenMeta, principalKind, { temporaryAuthority, ownerDevice });
      await authorize?.(meta);
      // The actual Run, with immutable preparation inputs, is the durable queue.
      const run = await createRun({ status: { id: runId, sessionId, requestId, responseId: requestId,
        state: 'queued', ackAt: new Date().toISOString(), appApiMessageVersion: 1, appApiMessageQueue: true,
        tool: record.request.runOptions.tool || binding.configuration.tool,
        model: record.request.runOptions.model || binding.configuration.model },
        manifest: { sessionId, requestId, responseId: requestId, appApiMessage: binding,
          options: record.request.runOptions,
          preparation: { version: 1, text: record.request.text, options: record.request.runOptions,
            images: record.request.attachments } } }, { authorizePublication: async () => {
          await authorize?.(meta); deadline(record);
        } });
      return receipt(record, run);
    });
  });
}
async function readMessageRunIfPublished(runId) {
  return await getRunAcceptanceEvidence(runId) ? readMessageRun(runId) : null;
}
export async function readSessionApiMessageCommit(sessionId, scopeInput, requestId, { authorize } = {}) {
  sessionApiIdentifier(sessionId, 256); sessionApiIdentifier(requestId);
  const scope = parseSessionApiScope(scopeInput, sessionId);
  const record = await originalRecord(sessionId, requestId, scope);
  const evidence = await readMessageRunIfPublished(messageRunId(record));
  return withSessionApiScope(sessionId, scope, async () => {
    await authorize?.(await findSessionMeta(sessionId));
    return receipt(record, evidence?.run);
  });
}

/** Called only inside the authenticated route's scope actor. No active-Run retarget. */
export async function cancelQueuedMessageRun(runId, { beforeWrite = null, authorizeWrite = null } = {}) {
  const evidence = await readMessageRun(runId);
  if (!evidence?.run.appApiMessageQueue) return null;
  const completedAt = new Date().toISOString();
  const changed = await updateRun(runId, run => {
    if (isTerminalRunState(run.state)) return run;
    if (run.state !== 'queued' || !run.appApiMessageQueue || run.runnerStartedAt || run.runnerLifecycleAcceptedAt) return run;
    return { ...run, state: 'cancelled', cancelRequested: true,
      cancelRequestedAt: run.cancelRequestedAt || completedAt, completedAt,
      result: { completedAt, exitCode: 1, signal: null, cancelled: true } };
  }, { beforeWrite, authorizeWrite });
  return isTerminalRunState(changed.state) ? changed : requestRunCancel(runId, { beforeWrite, authorizeWrite });
}

/** Real queue/claim phases; all expensive preparation is outside the scope actor. */
export function continueScopedMessageRun(runId, { execute, settleFailure, isSessionBusy = () => false,
  authorizeContinuation = authorizeTemporaryMessage, assertExecutionBoundary = assertRunExecutionBoundary }) {
  return continuations(runId, async () => {
    let evidence;
    try {
      evidence = await readMessageRun(runId);
      if (!evidence || isTerminalRunState(evidence.run.state) || evidence.run.runnerStartedAt ||
          evidence.run.runnerLifecycleAcceptedAt) return { waiting: false, run: evidence?.run };
      const { binding, record } = evidence;
      deadline(record);
      const queue = await listRunIndexEntries({ state: 'queued', sessionId: record.sessionId });
      const earlier = queue.filter(row => row.appApiMessageQueue &&
        (row.createdAt < evidence.run.createdAt || (row.createdAt === evidence.run.createdAt && row.id < runId)));
      const admission = await withSessionApiScope(record.sessionId, binding.scope, async () => {
        deadline(record);
        const current = await getRun(runId);
        if (current.cancelRequested || isTerminalRunState(current.state))
          throw sessionApiError('REQUEST_CANCELLED', 409, 'Message Run was cancelled before execution');
        const meta = await findSessionMeta(record.sessionId);
        await authorizeContinuation(binding, meta);
        // Reject before prompt/Provider preparation, history or Session claim.
        // Fixture callers may inject a diagnostic assertion; product callers
        // always use the default server-owned boundary, never a wire option.
        await assertExecutionBoundary(evidence.run, evidence.manifest);
        if (isSessionBusy(meta) || meta.pendingCompact || (meta.followUpQueue || []).length ||
            (meta.pendingPlanningQueue || []).length) return null;
        for (const row of earlier) {
          const queued = await getRun(row.id);
          if (queued?.appApiMessageQueue && queued.state === 'queued' && !queued.cancelRequested) return null;
        }
        try {
          return await publishSessionRun(record.sessionId, runId, () => updateRun(runId, row => ({
            ...row, state: 'preparing', appApiMessageQueue: false })));
        } catch (error) { if (error.code === 'SESSION_BUSY') return null; throw error; }
      });
      if (!admission) return { waiting: true, run: evidence.run };
      const result = await withMessageExecution({ runId, scope: binding.scope,
        configuration: binding.configuration, expiresAt: record.request.expiresAt,
        ...(binding.temporaryAuthority ? { temporaryAuthority: binding.temporaryAuthority } : {}) },
        () => execute({ ...evidence, run: admission.run }),
        { authorizeScope: meta => authorizeContinuation(binding, meta) });
      return { waiting: false, run: result?.run || result || await getRun(runId) };
    } catch (error) {
      if (!evidence) throw error; // Missing/corrupt evidence cannot supply dispatch authority.
      const current = await getRun(runId);
      if (current?.runnerStartedAt || current?.runnerLifecycleAcceptedAt)
        return { waiting: false, run: current };
      if (error.code === 'SESSION_BUSY') return { waiting: true, run: current };
      const failureCode = current?.messageFailureCode || (['REQUEST_EXPIRED', 'REQUEST_CANCELLED', 'REVISION_CONFLICT', 'RESOURCE_NOT_FOUND',
        'MESSAGE_IDEMPOTENCY_CONFLICT', 'MESSAGE_ATTACHMENT_CONFLICT', RESTRICTED_EXECUTION_UNAVAILABLE].includes(error.code) ? error.code : 'PREPARATION_FAILED');
      await updateRun(runId, { messageFailureCode: failureCode });
      await withoutMessageExecution(() => settleFailure(evidence, error));
      return { waiting: false, run: await getRun(runId) };
    }
  });
}

/** A logical launch-admission point; broker/provider waiting stays outside it. */
export async function admitScopedMessageLaunch(runId, { authorizeContinuation = authorizeTemporaryMessage,
  assertExecutionBoundary = assertRunExecutionBoundary } = {}) {
  const evidence = await readMessageRun(runId);
  if (!evidence) throw sessionApiError('RESOURCE_NOT_FOUND', 404, 'Message Run is unavailable');
  return withSessionApiScope(evidence.run.sessionId, evidence.binding.scope, async () => {
    deadline(evidence.record);
    const run = await getRun(runId);
    if (run.cancelRequested || isTerminalRunState(run.state))
      throw sessionApiError('REQUEST_CANCELLED', 409, 'Message Run was cancelled before launch admission');
    const meta = await findSessionMeta(run.sessionId);
    if (meta.activeRunId !== run.id || meta.pendingCompact)
      throw sessionApiError('REVISION_CONFLICT', 409, 'Message Run no longer owns Session execution');
    await authorizeContinuation(evidence.binding, meta);
    await assertExecutionBoundary(evidence.run, evidence.manifest);
    return updateRun(runId, { messageLaunchAdmittedAt: new Date().toISOString() }, { authorizeWrite: async () => {
      await authorizeContinuation(evidence.binding, meta); deadline(evidence.record);
    } });
  });
}
