import { getResponsibility } from './responsibility-service.mjs';

// Speech and typed text share this proposal path. It never executes a command.
export async function proposeResponsibilityIntent({ text, responsibilityId }, actor) {
  const utterance = typeof text === 'string' ? text.trim() : '';
  if (!utterance || utterance.length > 4000) throw Object.assign(new Error('Text is required and must be at most 4000 characters'), { statusCode: 400 });
  const normalized = utterance.toLowerCase().replace(/[.!?。！？]+$/u, '').trim();
  const fixed = new Map([['status', 'query'], ['状态', 'query'], ['pause', 'pause'], ['暂停', 'pause'],
    ['resume', 'resume'], ['恢复', 'resume'], ['wake', 'wake'], ['唤醒', 'wake']]);
  const action = fixed.get(normalized);
  if (!action) return { schemaVersion: 1, action: 'review_text', text: utterance, requiresReview: true, executable: false };
  if (!responsibilityId) return { schemaVersion: 1, action, requiresSelection: true, requiresReview: true, executable: false };
  const { responsibility } = await getResponsibility(responsibilityId, actor);
  return { schemaVersion: 1, action, responsibilityId: responsibility.id, organizationId: responsibility.organizationId,
    objective: responsibility.objective, expectedVersion: responsibility.rowVersion, requiresReview: true, executable: false };
}
