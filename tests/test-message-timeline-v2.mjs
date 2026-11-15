import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { writeFile } from 'node:fs/promises';
import { withMessageTimelineIdentity, projectMessageTimelineIdentities } from '../chat/message-timeline.mjs';

const root = await mkdtemp(join(tmpdir(), 'ragent-message-v2-'));
process.env.RAGENT_CONFIG_DIR = join(root, 'config');
process.env.RAGENT_INSTANCE_ROOT = root;
process.env.RAGENT_MEMORY_DIR = join(root, 'memory');
process.env.RAGENT_WORK_ROOT_DIR = join(root, 'work');
const { buildSessionDisplayEvents } = await import('../chat/session-display-events.mjs');

const message = (seq, id, content, extra = {}) => ({ seq, type: 'message', role: 'assistant', runId: 'run', providerMessageId: id, content, ...extra });
const delta = withMessageTimelineIdentity({ type: 'text_delta', runId: 'run', providerItemId: 'a', text: 'First' });
const final = withMessageTimelineIdentity(message(3, 'a', 'Final'));
assert.equal(delta.canonicalMessageId, final.canonicalMessageId, 'Codex item/message aliases share their exact upstream identity');
assert.notEqual(final.canonicalMessageId, withMessageTimelineIdentity(message(4, 'b', 'Final')).canonicalMessageId);
const chronology = buildSessionDisplayEvents([
  message(1, 'a', 'Long incorrect answer'),
  { seq: 2, type: 'message', role: 'user', content: 'Follow-up', id: 'user-2' },
  message(3, 'a', 'Correct'),
]);
assert.equal(chronology.length, 2);
assert.equal(chronology[0].content, 'Correct', 'a newer shorter authoritative snapshot wins');
assert.equal(chronology[0].seq, 1);
assert.equal(chronology[0].lastEventSeq, 3);
assert.equal(buildSessionDisplayEvents([message(1, 'a', 'Same'), message(2, 'b', 'Same')]).length, 2);
assert.equal(projectMessageTimelineIdentities([message(1, 'a', 'A'), message(5, 'a', 'B')])[1].firstSeq, 1);

try {
  const { prepareLiveMessageTimeline, appendEvents, readEventsAfter, hydrateTimelineMessageSnapshots } = await import('../chat/history.mjs');
  const input = { type: 'text_delta', role: 'assistant', runId: 'run', providerItemId: 'item', text: 'Hello' };
  const first = await prepareLiveMessageTimeline('session', [input]);
  assert.equal(first.starts.length, 1);
  const again = await prepareLiveMessageTimeline('session', [{ ...input, text: ' world' }]);
  assert.equal(again.starts.length, 0, 'repeated observer ticks reserve only one durable start');
  const user = await appendEvents('session', [{ type: 'message', role: 'user', content: 'Next', id: 'next' }]);
  const completed = await appendEvents('session', [{ type: 'message', role: 'assistant', runId: 'run', providerMessageId: 'item', content: 'Hello world' }]);
  assert.equal(completed[0].canonicalMessageId, first.events[0].canonicalMessageId);
  assert.equal(completed[0].firstSeq, first.starts[0].seq);
  assert.ok(completed[0].firstSeq < user[0].seq);
  const history = await readEventsAfter('session', 0, { includeBodies: true });
  assert.equal(history.length, 3, 'tokens are ephemeral; only start, user and completion are durable');
  const display = buildSessionDisplayEvents(history);
  assert.deepEqual(display.map(e => e.content), ['Hello world', 'Next']);
  assert.equal(display[0].messageState, 'completed');
  const backwards = await hydrateTimelineMessageSnapshots('session', [history[0]], 3);
  assert.equal(backwards[0].content, 'Hello world', 'a backward page sees the completed body at its original start anchor');
  assert.equal(backwards[0].seq, 1);
  const anonymous1 = await prepareLiveMessageTimeline('anonymous', [{ type: 'text_delta', runId: 'r', id: 'delta-a', text: 'A' }]);
  const anonymous2 = await prepareLiveMessageTimeline('anonymous', [{ type: 'text_delta', runId: 'r', id: 'delta-b', text: 'B' }]);
  assert.equal(anonymous1.events[0].canonicalMessageId, anonymous2.events[0].canonicalMessageId);
  assert.equal(anonymous2.starts.length, 0, 'a runtime without native ids still has one explicit open-message lifecycle');
  const anonymousFinal = await prepareLiveMessageTimeline('anonymous', [{ type: 'message', runId: 'r', id: 'final-a', content: 'AB' }]);
  assert.equal(anonymousFinal.events[0].canonicalMessageId, anonymous1.events[0].canonicalMessageId);
  const nextAnonymous = await prepareLiveMessageTimeline('anonymous', [{ type: 'text_delta', runId: 'r', id: 'delta-c', text: 'New' }]);
  assert.notEqual(nextAnonymous.events[0].canonicalMessageId, anonymous1.events[0].canonicalMessageId);
  // Exercise the real HTTP router/read snapshot without launching a Provider
  // or weakening the Windows managed-runner requirement.
  const { createSession } = await import('../chat/session-manager.mjs');
  const session = await createSession(root, 'fake-codex', 'Timeline HTTP replay');
  const started = await prepareLiveMessageTimeline(session.id, [input]);
  await appendEvents(session.id, [{ type: 'message', role: 'user', content: 'HTTP follow-up', id: 'http-user' }]);
  await appendEvents(session.id, [{ type: 'message', role: 'assistant', runId: 'run', providerMessageId: 'item', content: 'HTTP final' }]);
  const net = createServer();
  await new Promise(resolve => net.listen(0, '127.0.0.1', resolve));
  const port = net.address().port;
  await new Promise(resolve => net.close(resolve));
  await writeFile(join(process.env.RAGENT_CONFIG_DIR, 'auth-sessions.json'), JSON.stringify({
    'timeline-test': { role: 'owner', expiry: Date.now() + 60_000 },
  }));
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, CHAT_PORT: String(port), SECURE_COOKIES: '0',
      RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES: '1', RAGENT_AUTH_SESSION_SECRET: 'isolated-timeline-v2',
      RAGENT_PROVIDER_HOMES_DIR: join(root, 'provider-homes'), RAGENT_RUN_SPOOL_DIR: join(root, 'data', 'chat-runs'),
      RAGENT_RUNNER_LIFECYCLE_SOCKET: '', RAGENT_RUNNER_SUPERVISOR_SOCKET: '' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let diagnostic = '';
  child.stderr.on('data', data => { diagnostic = (diagnostic + data).slice(-4000); });
  const headers = { Cookie: 'session_token=timeline-test' };
  try {
    let raw;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`HTTP fixture exited: ${diagnostic}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/sessions/${session.id}/events?filter=all`, { headers });
        if (response.ok) { raw = await response.json(); break; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(raw, `HTTP fixture did not become ready: ${diagnostic}`);
    const visibleResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/${session.id}/events?filter=visible`, { headers });
    assert.equal(visibleResponse.status, 200);
    const visible = await visibleResponse.json();
    const messages = visible.events.filter(e => e.type === 'message');
    assert.deepEqual(messages.map(e => e.content), ['HTTP final', 'HTTP follow-up']);
    assert.equal(messages[0].canonicalMessageId, started.starts[0].canonicalMessageId);
    assert.equal(raw.events.find(e => e.content === 'HTTP final').canonicalMessageId, messages[0].canonicalMessageId);
    const beforeResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/${session.id}/events?filter=visible&direction=before&beforeSeq=2`, { headers });
    assert.equal(beforeResponse.status, 200);
    const before = await beforeResponse.json();
    assert.equal(before.events.find(e => e.type === 'message').content, 'HTTP final');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timeout = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
      child.once('exit', () => { clearTimeout(timeout); resolve(); });
    });
  }
  console.log('message-timeline-v2: PASS (identity, chronology, shorter revision, real isolated history start/final publication)');
} finally {
  await rm(root, { recursive: true, force: true });
}
