#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

function read(relativePath) {
  return readFileSync(join(repoRoot, relativePath), 'utf8');
}

function assertContains(source, snippet, message) {
  assert.equal(
    source.includes(snippet),
    true,
    message,
  );
}

function assertNotContains(source, snippet, message) {
  assert.equal(
    source.includes(snippet),
    false,
    message,
  );
}

const sessionHttpListStateSource = read('static/chat/session-http-list-state.js');
assertContains(
  sessionHttpListStateSource,
  'replaceActiveChatSessionsState',
  'session-http-list-state should route active session replacements through the shared shell boundary',
);
assertContains(
  sessionHttpListStateSource,
  'replaceArchivedChatSessionsState',
  'session-http-list-state should route archived session replacements through the shared shell boundary',
);
assertNotContains(
  sessionHttpListStateSource,
  'type: "replace-active-sessions"',
  'session-http-list-state should not dispatch replace-active-sessions directly anymore',
);
assertNotContains(
  sessionHttpListStateSource,
  'type: "replace-archived-sessions"',
  'session-http-list-state should not dispatch replace-archived-sessions directly anymore',
);

const sessionHttpSource = read('static/chat/session-http.js');
for (const helperName of [
  'replaceChatState',
  'upsertChatSessionState',
  'setChatCurrentSession',
  'setChatArchivedSessionsLoading',
  'removeChatSessionState',
]) {
  assertContains(
    sessionHttpSource,
    helperName,
    `session-http should use ${helperName} for shell-state writes`,
  );
}
for (const forbiddenDispatch of [
  'type: "set-current-session"',
  'type: "replace-state"',
  'type: "set-archived-sessions-loading"',
  'type: "upsert-session"',
  'type: "remove-session"',
]) {
  assertNotContains(
    sessionHttpSource,
    forbiddenDispatch,
    `session-http should not dispatch ${forbiddenDispatch} directly anymore`,
  );
}

const realtimeSource = read('static/chat/realtime.js');
assertContains(
  realtimeSource,
  'setChatCurrentSession',
  'realtime should use the shared shell boundary for current-session attachment',
);
assertContains(
  realtimeSource,
  'setChatSessionStatus',
  'realtime should use the shared shell boundary for shell session status',
);
assertContains(
  realtimeSource,
  'const liveEvents = msg.events.filter',
  'realtime should keep durable events out of the live overlay',
);
assertContains(
  realtimeSource,
  'renderIncremental',
  'realtime should route only live streaming events to the incremental projector',
);
assertNotContains(
  realtimeSource,
  'type: "set-current-session"',
  'realtime should not dispatch set-current-session directly anymore',
);
assertNotContains(
  realtimeSource,
  'type: "set-session-status"',
  'realtime should not dispatch set-session-status directly anymore',
);

const composeSource = read('static/chat/compose.js');
for (const helperName of [
  'setComposerPendingSendState',
  'patchComposerPendingSendState',
  'clearComposerPendingSendState',
  'clearComposerSessionState',
  'getComposerAttachmentsState',
  'setComposerDraftTextState',
]) {
  assertContains(
    composeSource,
    helperName,
    `compose should use ${helperName} for shared composer state writes`,
  );
}
assertNotContains(
  composeSource,
  'let pendingComposerSend =',
  'compose should not own a hidden pending-send singleton anymore',
);

const sidebarUiSource = read('static/chat/sidebar-ui.js');
assertContains(
  sidebarUiSource,
  'addComposerAttachmentsState',
  'sidebar-ui should add attachments through the shared composer state boundary',
);
assertContains(
  sidebarUiSource,
  'removeComposerAttachmentState',
  'sidebar-ui should remove attachments through the shared composer state boundary',
);
assertNotContains(
  sidebarUiSource,
  'pendingImages.push',
  'sidebar-ui should not mutate attachment arrays directly anymore',
);
assertNotContains(
  sidebarUiSource,
  'pendingImages.splice',
  'sidebar-ui should not splice attachment arrays directly anymore',
);

const composerStoreSource = read('static/chat/composer-store.js');
assertContains(
  composerStoreSource,
  'RagentComposerStore',
  'composer-store should define the dedicated composer state slice',
);

const frontendArchitectureSource = read('docs/frontend-chat-architecture.md');
assertContains(
  frontendArchitectureSource,
  'tests/test-chat-frontend-state-boundary.mjs',
  'frontend architecture doc should reference the guard test that protects the state boundary',
);
assertContains(
  frontendArchitectureSource,
  'replaceChatState(...)',
  'frontend architecture doc should document the shared shell-state helper boundary',
);
assertContains(
  frontendArchitectureSource,
  'static/chat/composer-store.js',
  'frontend architecture doc should document the dedicated composer state slice',
);
assertContains(
  frontendArchitectureSource,
  'tests/test-chat-composer-store.mjs',
  'frontend architecture doc should point to the composer store guard tests',
);

const projectArchitectureSource = read('docs/architecture.md');
assertContains(
  projectArchitectureSource,
  'docs/frontend-chat-architecture.md',
  'project architecture should point future readers to the chat frontend architecture contract',
);

console.log('test-chat-frontend-state-boundary: ok');
