import assert from 'node:assert/strict';
import { approvalRequestEvent, approvalResponseEvent } from '../chat/normalizer.mjs';

const event = approvalRequestEvent({ approvalId: 'q', questions: [
  { question: 'Choose several', multiSelect: true, options: [{ label: 'One' }, { label: 'Two' }] },
  { question: 'Choose one', multiSelect: false, options: [{ label: 'Three' }] },
  { question: 'Alias', isMultiSelect: true },
] });
assert.deepEqual(event.questions.map(question => question.multiSelect), [true, false, true]);

const codexQuestionEvent = approvalRequestEvent({
  approvalId: 'codex-user-input-1',
  kind: 'question',
  isBlocking: false,
  questions: [
    { id: 'q_choice', question: 'Pick one', isOther: false, options: [{ label: 'Alpha' }, { label: 'Beta' }] },
    { id: 'q_secret', question: 'API Key', isSecret: true },
  ],
  elicitation: {
    mode: 'form',
    serverName: 'vault',
    requestedSchema: { type: 'object', properties: { key: { type: 'string', format: 'password' } } },
  },
});
assert.equal(codexQuestionEvent.isBlocking, false);
assert.equal(codexQuestionEvent.questions[0].isOther, false);
assert.equal(codexQuestionEvent.questions[1].isSecret, true);
assert.equal(codexQuestionEvent.elicitation?.mode, 'form');
assert.equal(codexQuestionEvent.elicitation?.serverName, 'vault');

const redactedResponse = approvalResponseEvent({
  approvalId: 'codex-user-input-1',
  decision: 'cancelled',
  status: 'cancelled',
  source: 'codex-server-request-resolved',
  redacted: true,
});
assert.equal(redactedResponse.source, 'codex-server-request-resolved');
assert.equal(redactedResponse.redacted, true);

console.log('test-approval-question-multiselect: ok');
