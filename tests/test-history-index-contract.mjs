#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const home = mkdtempSync(join(tmpdir(), 'ragent-history-index-'));
process.env.HOME = home;
process.env.RAGENT_CONFIG_DIR = join(home, '.config', 'ragent');
process.env.RAGENT_MEMORY_DIR = join(home, 'memory');
process.env.RAGENT_WORK_ROOT_DIR = join(home, 'workspace');
process.env.RAGENT_INSTANCE_ROOT = home;

const { appendEvent, appendEvents, readEventBody, readEventsAfter, readEventsPage } = await import('../chat/history.mjs');
const { getSessionEventsAfter, getSessionTimelinePage } = await import('../chat/session-manager.mjs');

try {
  const sessionId = `history-index-contract-${process.pid}-${Date.now()}`;
  const longReasoning = 'thinking '.repeat(900);
  const shortToolInput = 'echo hello';
  const shortToolResult = 'hello';
  const events = [];

  for (let index = 0; index < 620; index += 1) {
    events.push({
      type: 'message',
      role: index % 2 === 0 ? 'assistant' : 'user',
      content: `message ${index}`,
    });
  }

  events.splice(10, 0, { type: 'reasoning', content: longReasoning });
  events.splice(11, 0, { type: 'tool_use', id: 'tool-1', toolName: 'shell', toolInput: shortToolInput });
  events.splice(12, 0, { type: 'tool_result', output: shortToolResult, exitCode: 0 });
  events.splice(13, 0, {
    type: 'file_change',
    filePath: '/tmp/history-index-contract.js',
    changeType: {
      type: 'update',
      move_path: null,
    },
  });

  await appendEvents(sessionId, events);

  const eventIndex = await readEventsAfter(sessionId, 0);
  assert.equal(eventIndex.length, events.length, 'history reads should return the full event index without a hard limit');
  assert.equal(eventIndex.at(-1)?.seq, events.length, 'full history reads should advance through the final sequence');

  const firstMessage = eventIndex.find((event) => event.type === 'message');
  assert.ok(firstMessage, 'message event should be present');
  assert.equal(firstMessage.content, '', 'chat messages should be deferred from the main event index');
  assert.equal(firstMessage.bodyAvailable, true, 'message event should expose a lazy body');
  assert.equal(firstMessage.bodyLoaded, false, 'message body should stay unloaded in the event index');

  const reasoning = eventIndex.find((event) => event.type === 'reasoning');
  assert.ok(reasoning, 'reasoning event should be present');
  assert.equal(reasoning.content, '', 'reasoning body should be deferred from the event index');
  assert.equal(reasoning.bodyAvailable, true, 'reasoning event should expose a lazy body');
  assert.equal(reasoning.bodyLoaded, false, 'reasoning body should stay unloaded in the event index');

  const toolUse = eventIndex.find((event) => event.type === 'tool_use');
  assert.ok(toolUse, 'tool use event should be present');
  assert.equal(toolUse.toolInput, '', 'tool input should be deferred from the event index');
  assert.equal(toolUse.bodyAvailable, true, 'tool use should expose a lazy body');
  assert.equal(toolUse.bodyLoaded, false, 'tool use body should stay unloaded in the event index');

  const toolResult = eventIndex.find((event) => event.type === 'tool_result');
  assert.ok(toolResult, 'tool result event should be present');
  assert.equal(toolResult.output, '', 'tool result should be deferred from the event index');
  assert.equal(toolResult.bodyAvailable, true, 'tool result should expose a lazy body');
  assert.equal(toolResult.bodyLoaded, false, 'tool result body should stay unloaded in the event index');

  const fileChange = eventIndex.find((event) => event.type === 'file_change');
  assert.ok(fileChange, 'file change event should be present');
  assert.equal(fileChange.changeType, 'update', 'history reads should normalize object-shaped file change kinds');

  const messageBody = await readEventBody(sessionId, firstMessage.seq);
  assert.equal(messageBody?.value, 'message 0', 'message body should load on demand');

  const controlMessage = await appendEvent(sessionId, {
    type: 'message',
    role: 'assistant',
    content: 'Visible <ragent-result-packet>{"state":"completed"}</ragent-result-packet> tail',
  });
  const controlMessageBody = await readEventBody(sessionId, controlMessage.seq);
  assert.equal(
    controlMessageBody?.value,
    'Visible  tail',
    'lazy assistant message bodies must not expose Runtime control envelopes',
  );

  const reasoningBody = await readEventBody(sessionId, reasoning.seq);
  assert.equal(reasoningBody?.value, longReasoning, 'reasoning body should load on demand');

  const toolUseBody = await readEventBody(sessionId, toolUse.seq);
  assert.equal(toolUseBody?.value, shortToolInput, 'inline tool input should still load on demand');

  const toolResultBody = await readEventBody(sessionId, toolResult.seq);
  assert.equal(toolResultBody?.value, shortToolResult, 'inline tool result should still load on demand');

  const safeAllEvents = await getSessionEventsAfter(sessionId, 0, {
    includeBodies: false,
    includeMessageBodies: true,
  });
  const safeFirstMessage = safeAllEvents.find((event) => event.type === 'message');
  assert.equal(
    safeFirstMessage?.content,
    'message 0',
    'session all-events safe index should keep ordinary message text for compatibility',
  );
  const safeToolUse = safeAllEvents.find((event) => event.type === 'tool_use');
  assert.equal(
    safeToolUse?.toolInput,
    '',
    'session all-events safe index should still defer tool input bodies',
  );

  // Regression: a long final assistant summary is externalized to a cold body
  // at append time (content: '' + bodyRef). The bounded visible-timeline reads
  // must inline message bodies again, or the run's final message renders as an
  // empty bubble the moment the client replaces its window with the
  // authoritative page/delta projection.
  const longSummary = `# 完成的总结\n\n${'结论段落。'.repeat(16000)}`;
  const summaryMessage = await appendEvent(sessionId, {
    type: 'message',
    role: 'assistant',
    content: longSummary,
  });
  assert.ok(summaryMessage.bodyRef, 'oversized assistant summary should externalize to a cold body');

  const deferredPage = await readEventsPage(sessionId, { limit: 5, direction: 'latest' });
  assert.equal(
    deferredPage.events.at(-1)?.content ?? '',
    '',
    'default page reads still defer oversized message bodies',
  );

  const timelinePage = await readEventsPage(sessionId, {
    limit: 700,
    direction: 'latest',
    includeBodies: false,
    includeMessageBodies: true,
  });
  assert.equal(
    timelinePage.events.at(-1)?.content,
    longSummary,
    'visible page reads must inline externalized message bodies when asked',
  );
  assert.equal(
    timelinePage.events.find((event) => event.type === 'tool_use')?.toolInput,
    '',
    'visible page reads still defer tool bodies',
  );

  const deltaPage = await readEventsAfter(sessionId, summaryMessage.seq - 1, {
    includeBodies: false,
    includeMessageBodies: true,
  });
  assert.equal(
    deltaPage.find((event) => event.seq === summaryMessage.seq)?.content,
    longSummary,
    'delta reads must inline externalized message bodies when asked',
  );

  // End-to-end: the authoritative visible window the client uses to reset its
  // transcript must carry the full final message, not an empty content field
  // with the lazy markers stripped away.
  const visibleWindow = await getSessionTimelinePage(sessionId, { limit: 10 });
  const visibleSummary = visibleWindow.events.filter(
    (event) => event.type === 'message' && event.role === 'assistant',
  ).at(-1);
  assert.equal(
    visibleSummary?.content,
    longSummary,
    'visible timeline projection must include the full externalized final message',
  );

  console.log('history-index-contract: ok');
} finally {
  rmSync(home, { recursive: true, force: true });
}
