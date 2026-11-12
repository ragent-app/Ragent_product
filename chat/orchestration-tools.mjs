// Narrow structured orchestration actions for model-facing adapters and HTTP.
// They intentionally expose plans and execution status, never raw Session,
// Runner or database primitives. A dispatch can only consume the exact
// short-lived payload that previously passed validation.
import {
  claimValidationForDispatch,
  createValidation,
  getExecution,
  getValidation,
} from './orchestration-store.mjs';

function text(value, max = 4000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function toolError(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}

export async function validateCollaborationPlanTool(input = {}, { orchestrator = null } = {}) {
  const runtime = orchestrator || (await import('./collaboration-orchestrator.mjs')).getDefaultCollaborationOrchestrator();
  const rootSessionId = text(input.rootSessionId || input.sessionId, 240);
  if (!rootSessionId) throw toolError('COLLABORATION_VALIDATION_ROOT_REQUIRED', 'rootSessionId is required');
  const validation = await runtime.validate({
    rootSessionId,
    title: text(input.title, 240),
    plan: input.plan,
    projectId: text(input.projectId, 240),
  });
  const persisted = await createValidation({
    rootSessionId,
    kind: 'collaboration_plan',
    payload: {
      rootSessionId,
      title: text(input.title, 240),
      projectId: text(input.projectId, 240),
      plan: validation.plan,
      policy: validation.policy,
    },
  });
  return {
    valid: true,
    validationId: persisted.validationId,
    payloadDigest: persisted.payloadDigest,
    expiresAt: persisted.expiresAt,
    rootSessionId,
    projectId: validation.projectId,
    plan: validation.plan,
    policy: validation.policy,
  };
}

export async function getValidatedCollaborationPlan(validationId) {
  const validation = await getValidation(validationId);
  if (!validation || validation.kind !== 'collaboration_plan') return null;
  return validation;
}

export async function dispatchValidatedCollaborationPlan({ validationId, idempotencyKey = '' } = {}, { orchestrator = null } = {}) {
  const validation = await getValidatedCollaborationPlan(validationId);
  if (!validation || validation.expired) {
    throw toolError('COLLABORATION_VALIDATION_EXPIRED', 'The validated collaboration plan is missing or expired; validate it again', 409);
  }
  const claimed = await claimValidationForDispatch(validation.validationId, {
    rootSessionId: validation.rootSessionId,
    kind: 'collaboration_plan',
  });
  if (!claimed) throw toolError('COLLABORATION_VALIDATION_EXPIRED', 'The validated collaboration plan is missing or expired; validate it again', 409);
  const payload = claimed.payload || {};
  const runtime = orchestrator || (await import('./collaboration-orchestrator.mjs')).getDefaultCollaborationOrchestrator();
  const collaboration = await runtime.dispatch({
    rootSessionId: payload.rootSessionId,
    title: text(payload.title, 240),
    projectId: text(payload.projectId, 240),
    plan: payload.plan,
    // Validation id is part of the durable key. A client retry with no custom
    // key therefore returns the exact same collaboration instead of fanning
    // out a second team.
    idempotencyKey: text(idempotencyKey, 240) || `validated:${claimed.validationId}`,
  });
  return {
    validationId: claimed.validationId,
    payloadDigest: claimed.payloadDigest,
    collaboration,
  };
}

export async function getOrchestrationStatusTool({ executionId } = {}) {
  const execution = await getExecution(text(executionId, 240), { includeDetails: true });
  if (!execution) throw toolError('ORCHESTRATION_NOT_FOUND', 'Execution not found', 404);
  return { execution };
}

export const ORCHESTRATION_TOOL_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: 'ragent_validate_collaboration_plan',
    description: 'Validate a durable collaboration plan without creating Sessions or Runs. Returns a short-lived validationId.',
  }),
  Object.freeze({
    name: 'ragent_dispatch_validated_collaboration_plan',
    description: 'Dispatch exactly the plan referenced by validationId. Does not accept an arbitrary plan payload.',
  }),
  Object.freeze({
    name: 'ragent_get_orchestration_status',
    description: 'Read a durable execution checkpoint, steps, commands and interrupts.',
  }),
]);
