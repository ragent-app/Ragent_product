#!/usr/bin/env node
import { copyFile } from 'node:fs/promises';
import { CHAT_PORT, CHAT_SESSIONS_FILE } from '../lib/config.mjs';
import { readEventBody, readEventsPage } from '../chat/history.mjs';
import {
  flushSessionsMetaNow,
  loadSessionsMeta,
  mutateSessionMeta,
} from '../chat/session-meta-store.mjs';
import {
  buildTemporarySessionName,
  isSessionAutoRenamePending,
} from '../chat/session-naming.mjs';

const APPLY = process.argv.includes('--apply');
const ACTIVE_ONLY = process.argv.includes('--active-only');
const VERBOSE = process.argv.includes('--verbose');

async function isChatPlaneRunning() {
  try {
    const response = await fetch(`http://127.0.0.1:${CHAT_PORT}/healthz`, {
      signal: AbortSignal.timeout(500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function readFirstUserText(sessionId) {
  let afterSeq = 0;
  while (true) {
    const page = await readEventsPage(sessionId, {
      direction: 'forward',
      afterSeq,
      limit: 128,
      includeMessageBodies: true,
    }).catch(() => null);
    const events = Array.isArray(page?.events) ? page.events : [];
    const userEvent = events.find((event) => event?.type === 'message' && event.role === 'user');
    if (userEvent) {
      if (typeof userEvent.content === 'string' && userEvent.content.trim()) {
        return userEvent.content.trim();
      }
      const body = await readEventBody(sessionId, userEvent.seq).catch(() => null);
      return typeof body?.value === 'string' ? body.value.trim() : '';
    }
    if (page?.pagination?.hasMoreAfter !== true) return '';
    const nextAfterSeq = Number(page?.pagination?.latestSeq || 0);
    if (!Number.isInteger(nextAfterSeq) || nextAfterSeq <= afterSeq) return '';
    afterSeq = nextAfterSeq;
  }
}

const sessions = await loadSessionsMeta();
const pending = sessions.filter((session) => (
  isSessionAutoRenamePending(session)
  && (!ACTIVE_ONLY || session.archived !== true)
));

let backupPath = '';
if (APPLY && pending.length > 0) {
  if (await isChatPlaneRunning()) {
    throw new Error(`Refusing live metadata backfill while the chat plane is reachable on port ${CHAT_PORT}; stop the matching Ragent instance, rerun --apply, then start it again.`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  backupPath = `${CHAT_SESSIONS_FILE}.titles-${stamp}.bak`;
  await copyFile(CHAT_SESSIONS_FILE, backupPath);
}

let changed = 0;
let missingInput = 0;
for (const session of pending) {
  const firstUserText = await readFirstUserText(session.id);
  const title = buildTemporarySessionName(firstUserText);
  if (!title) {
    missingInput += 1;
    continue;
  }
  if (VERBOSE) {
    console.log(`${session.id}: ${session.name || '(empty)'} -> ${title}`);
  }
  if (!APPLY || title === session.name) continue;
  const result = await mutateSessionMeta(session.id, (draft) => {
    if (!isSessionAutoRenamePending(draft)) return false;
    draft.name = title;
    draft.autoRenamePending = true;
    draft.titleSource = 'backfill-provisional';
    draft.titleUpdatedAt = new Date().toISOString();
    delete draft.titleAnchorRunId;
    draft.updatedAt = draft.titleUpdatedAt;
    return true;
  });
  if (result.changed) changed += 1;
}

if (APPLY) await flushSessionsMetaNow();

console.log(JSON.stringify({
  mode: APPLY ? 'apply' : 'dry-run',
  scanned: pending.length,
  changed,
  missingInput,
  ...(backupPath ? { backupPath } : {}),
}, null, 2));
