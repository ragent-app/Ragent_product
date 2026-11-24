import { stripAssistantControlBlocks } from './assistant-control-blocks.mjs';

// The caller authorizes a single UUID from the current owner message. This
// reader never accepts a path and retains only bounded conversation text.
export async function readOwnerCodexConversation(client, sessionId, { signal } = {}) {
  const maxBytes = 4 * 1024 * 1024;
  const maxChars = 100_000;
  let cursor = '0';
  let offset = 0;
  let size = null;
  let pending = Buffer.alloc(0);
  let chars = 0;
  let omitted = false;
  let pageComplete = false;
  let rateRetryUsed = false;
  const messages = [];
  const consume = (line) => {
    if (!line.length) return;
    let item;
    try { item = JSON.parse(line.toString('utf8')); } catch { throw Object.assign(new Error('OWNER_HISTORY_INVALID'), { code: 'OWNER_HISTORY_INVALID' }); }
    const payload = item?.payload;
    if (item?.type !== 'response_item' || payload?.type !== 'message' || !['user', 'assistant'].includes(payload.role)) return;
    let text = Array.isArray(payload.content)
      ? payload.content.filter((part) => ['input_text', 'output_text', 'text'].includes(part?.type) && typeof part.text === 'string').map((part) => part.text).join('\n') : '';
    if (payload.role === 'assistant') text = stripAssistantControlBlocks(text);
    if (!text.trim()) return;
    if (chars + text.length > maxChars) { omitted = true; return; }
    messages.push({ role: payload.role, text });
    chars += text.length;
  };
  while (offset < maxBytes) {
    if (signal?.aborted) throw Object.assign(new Error('OWNER_HISTORY_UNAVAILABLE'), { code: 'OWNER_HISTORY_UNAVAILABLE' });
    let page;
    try { page = await client.readCodexHistory({ sessionId, cursor }); }
    catch (error) {
      if (error?.code !== 'RATE_LIMITED' || rateRetryUsed) throw error;
      rateRetryUsed = true;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 61_000);
        const abort = () => { clearTimeout(timer); reject(Object.assign(new Error('OWNER_HISTORY_UNAVAILABLE'), { code: 'OWNER_HISTORY_UNAVAILABLE' })); };
        if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
      });
      page = await client.readCodexHistory({ sessionId, cursor });
    }
    if (page.offset !== offset || (size !== null && page.size !== size)) throw Object.assign(new Error('OWNER_HISTORY_INVALID'), { code: 'OWNER_HISTORY_INVALID' });
    size = page.size;
    const bytes = Buffer.from(page.dataBase64, 'base64');
    const available = Math.min(bytes.length, maxBytes - offset);
    pending = Buffer.concat([pending, bytes.subarray(0, available)]);
    let newline;
    while ((newline = pending.indexOf(10)) >= 0) {
      consume(pending.subarray(0, newline));
      pending = pending.subarray(newline + 1);
    }
    offset += available;
    pageComplete = page.complete && available === bytes.length;
    if (pageComplete) { if (pending.length) consume(pending); break; }
    if (available !== bytes.length || offset >= maxBytes) break;
    cursor = page.nextCursor;
  }
  return { sessionId, messages, complete: pageComplete && !omitted, bytesRead: offset, size, textLimitReached: omitted };
}

// Only a uniquely matched, owner-visible Ragent session may use this path.
export async function readManagedCodexConversation(readEventsPage, session, codexId, { assertActive = async () => {} } = {}) {
  const messages = [];
  let afterSeq = 0;
  let snapshotSeq = null;
  let chars = 0;
  let complete = true;
  for (let pageCount = 0; pageCount < 20; pageCount += 1) {
    await assertActive();
    const page = await readEventsPage(session.id, { afterSeq, direction: 'forward', limit: 200, includeBodies: true, maxBodyBytes: 100_000, strict: true, priority: 'interactive' });
    if (snapshotSeq === null) snapshotSeq = page.pagination.totalLatestSeq;
    for (const event of page.events) {
      if (event.seq > snapshotSeq) break;
      if (event.type !== 'message' || !['user', 'assistant'].includes(event.role)) continue;
      if (event.bodyTruncated || event.bodyAvailable === false || event.bodyLoaded === false || typeof event.content !== 'string') { complete = false; continue; }
      if (event.messageState && event.messageState !== 'completed') complete = false;
      const text = event.role === 'assistant' ? stripAssistantControlBlocks(event.content) : event.content;
      if (chars + text.length > 100_000) { complete = false; continue; }
      if (!text.trim()) continue;
      messages.push({ role: event.role, text });
      chars += text.length;
    }
    const next = page.pagination.latestSeq;
    if (!page.events.length || !Number.isInteger(next)) {
      if (afterSeq < snapshotSeq) complete = false;
      break;
    }
    if (next >= snapshotSeq) break;
    if (next <= afterSeq) throw Object.assign(new Error('OWNER_HISTORY_UNAVAILABLE'), { code: 'OWNER_HISTORY_UNAVAILABLE' });
    afterSeq = next;
    if (pageCount === 19) complete = false;
  }
  return { sessionId: codexId, source: 'ragent-managed-session', messages, complete };
}
