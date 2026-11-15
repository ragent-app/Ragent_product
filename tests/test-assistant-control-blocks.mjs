#!/usr/bin/env node
import assert from 'assert/strict';
import {
  createAssistantControlBlockStream,
  stripAssistantControlBlocks,
} from '../chat/assistant-control-blocks.mjs';
import {
  buildEventBlockEvents,
  buildSessionDisplayEvents,
  filterSessionDisplayPushEvents,
} from '../chat/session-display-events.mjs';
import { loadReplySelfCheckTurnContext } from '../chat/session-reply-self-check.mjs';

const plan = '<ragent-collaboration-plan>{"schemaVersion":1,"plan":{}}</ragent-collaboration-plan>';
const labels = '<ragent-session-labels>{"schemaVersion":1,"title":"Stable title","group":"Project","description":"Durable scope."}</ragent-session-labels>';
assert.equal(
  stripAssistantControlBlocks(`Before\n${plan}\nAfter`),
  'Before\n\nAfter',
  'complete control blocks should be removed while surrounding assistant text remains',
);
assert.equal(
  stripAssistantControlBlocks('Before\n<ragent-result-packet>{"state":"completed"}'),
  'Before\n',
  'an unclosed control block should fail closed and hide the remainder',
);
assert.equal(
  stripAssistantControlBlocks('Before\n</ragent-result-packet>After'),
  'Before\nAfter',
  'orphaned closing markers should not reach the visible transcript',
);
assert.equal(
  stripAssistantControlBlocks(`Final answer\n${labels}`),
  'Final answer\n',
  'session label metadata must stay out of the completed transcript',
);

const stream = createAssistantControlBlockStream();
assert.equal(stream.push('Visible <ragent-collab'), 'Visible ', 'partial opening markers should stay buffered');
assert.equal(
  stream.push('oration-plan>{"schemaVersion":1}</ragent-collaboration-plan> Tail'),
  ' Tail',
  'a control block split across deltas should never be emitted',
);
assert.equal(stream.finish(), '', 'the stream should not retain hidden marker fragments');
const incompleteStream = createAssistantControlBlockStream();
assert.equal(incompleteStream.push('Visible <ragent-collab'), 'Visible ');
assert.equal(incompleteStream.finish(), '', 'an incomplete opening marker must stay hidden at stream end');
const labelStream = createAssistantControlBlockStream();
assert.equal(labelStream.push('Done.\n<ragent-session-la'), 'Done.\n');
assert.equal(
  labelStream.push('bels>{"title":"Stable"}</ragent-session-labels>'),
  '',
  'session label metadata must never flash at the stream boundary',
);
assert.equal(labelStream.finish(), '');

const rawAssistantText = `Visible reply\n${plan}\nFinal reply`;
const history = [
  { seq: 1, type: 'message', role: 'user', content: 'Plan the work', runId: 'run-control' },
  { seq: 2, type: 'message', role: 'assistant', content: rawAssistantText, runId: 'run-control' },
];
const display = buildSessionDisplayEvents(history, { sessionRunning: false });
assert.deepEqual(display.map((event) => event.type), ['message', 'message']);
assert.equal(display[1].content, 'Visible reply\n\nFinal reply', 'history projection must hide control payloads');
assert.equal(
  buildEventBlockEvents(history, 2, 2)[0].content,
  'Visible reply\n\nFinal reply',
  'lazy event blocks must use the same visible projection',
);

const pushed = [
  ...filterSessionDisplayPushEvents([
    { type: 'text_delta', role: 'assistant', runId: 'run-live-control', text: 'Live <ragent-collab' },
  ]),
  ...filterSessionDisplayPushEvents([
    { type: 'text_delta', role: 'assistant', runId: 'run-live-control', text: 'oration-plan>{"x":1}</ragent-collaboration-plan> output' },
  ]),
];
assert.deepEqual(
  pushed.map((event) => event.text),
  ['Live ', ' output'],
  'live push filtering must hide protocol blocks across delta boundaries',
);

const turnContext = await loadReplySelfCheckTurnContext('session-control', 'run-control', {
  loadSessionHistory: async () => history,
});
assert.match(turnContext.assistantControlText, /ragent-collaboration-plan/);
assert.doesNotMatch(turnContext.assistantTurnText, /ragent-collaboration-plan/);

console.log('test-assistant-control-blocks: ok');
