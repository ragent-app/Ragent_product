import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const summarizer = readFileSync('chat/summarizer.mjs', 'utf8');
const sidecar = readFileSync('chat/runner-sidecar.mjs', 'utf8');
const realtime = readFileSync('static/chat/realtime.js', 'utf8');
const compose = readFileSync('static/chat/compose.js', 'utf8');

assert.match(summarizer, /RAGENT_SESSION_LABEL_SUGGESTIONS/);
assert.match(summarizer, /defaultValue:\s*false/);
assert.match(sidecar, /DEFAULT_IDLE_TIMEOUT_MS\s*=\s*2\s*\*\s*60\s*\*\s*1000/);
assert.match(sidecar, /recordStderrText = async \(text\) => \{\s*\/\/ stderr is diagnostic noise/s);
assert.match(sidecar, /async function updateRunFieldsIfChanged\(runId, fields = \{\}\)/);
assert.match(sidecar, /await updateRunFieldsIfChanged\(runId, runPatch\)/);
assert.match(realtime, /MESSAGE_SUBMIT_TIMEOUT_MS\s*=\s*20_000/);
assert.match(realtime, /submitController\?\.abort\(\)/);

const sendMessageStart = compose.indexOf('function sendMessage(existingRequestId)');
const editResendStart = compose.indexOf('// ---- Edit-resend', sendMessageStart);
assert.ok(sendMessageStart >= 0 && editResendStart > sendMessageStart, 'sendMessage section must remain identifiable');
const sendMessage = compose.slice(sendMessageStart, editResendStart);
assert.doesNotMatch(
  sendMessage,
  /await\s+waitForPending(?:RuntimeSelectionSync|SessionToolPreferencesPersist)\s*\(/,
  'a message POST must not wait for best-effort runtime preference persistence',
);
assert.match(sendMessage, /msg\.model\s*=\s*sendModel/);
assert.match(sendMessage, /msg\.effort\s*=\s*sendEffort/);

console.log('test-chat-interactive-send-guardrails: ok');
