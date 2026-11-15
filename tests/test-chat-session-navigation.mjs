#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { chromium } from '@playwright/test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(repoRoot, path), 'utf8');
const catalog = read('static/chat/bootstrap-session-catalog.js');
const backHandler = read('static/chat/back-handler.js');
const gestures = read('static/chat/gestures.js');
const sessionSurface = read('static/chat/session-surface-ui.js');
const realtime = read('static/chat/realtime.js');
const init = read('static/chat/init.js');
const template = read('templates/chat.html');

assert.match(catalog, /SESSION_NAVIGATION_STATE_KEY = "ragentSessionNavigation"/);
assert.match(catalog, /historyMode === "push"/);
assert.match(catalog, /function navigateHomeFromUi/);
assert.match(catalog, /function handleSessionNavigationPopState/);
assert.match(catalog, /delete navigationBaseHistoryState\.backEntryId/,
  'new session navigation entries must not inherit an overlay back marker');
assert.match(sessionSurface, /applyNavigationState\(\{ sessionId: session\.id, tab: "sessions" \}\)/);
assert.match(sessionSurface, /navigateToSession\(session\.id,/, 'sidebar session rows should use the navigation coordinator');
assert.match(catalog, /function beginSessionNavigation/);
assert.match(catalog, /isSessionNavigationCurrent\(sessionNavigationGeneration, next\.sessionId\)/);
assert.match(read('static/chat/session-http.js'), /navigationGeneration: navigation\.generation/);
assert.match(read('static/chat/ui.js'), /findCommittedUserMessageNode\(requestId\)/);
assert.match(read('static/chat/ui.js'), /container\.insertBefore\(wrap, localEcho\)/);

function extractFunctionSource(source, functionName) {
  const marker = `function ${functionName}`;
  const markerStart = source.indexOf(marker);
  assert.notEqual(markerStart, -1, `${functionName} should exist`);
  const start = source.slice(Math.max(0, markerStart - 6), markerStart) === "async "
    ? markerStart - 6
    : markerStart;
  const parameterStart = source.indexOf('(', start);
  let parameterDepth = 0;
  let parameterEnd = -1;
  for (let index = parameterStart; index < source.length; index += 1) {
    if (source[index] === '(') parameterDepth += 1;
    if (source[index] === ')') {
      parameterDepth -= 1;
      if (parameterDepth === 0) {
        parameterEnd = index;
        break;
      }
    }
  }
  const braceStart = source.indexOf('{', parameterEnd);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Unable to extract ${functionName}`);
}

{
  let navigationGeneration = 0;
  let navigationTargetId = '';
  let resolveOldSession;
  const oldSessionReady = new Promise((resolve) => { resolveOldSession = resolve; });
  const attached = [];
  const browserStates = [];
  const context = {
    Promise,
    String,
    Number,
    console,
    pendingNavigationState: null,
    beginSessionNavigation(sessionId = '') {
      navigationGeneration += 1;
      navigationTargetId = String(sessionId || '').trim();
      return { generation: navigationGeneration, sessionId: navigationTargetId };
    },
    isSessionNavigationCurrent(generation, sessionId = '') {
      return generation === navigationGeneration
        && (!sessionId || String(sessionId).trim() === navigationTargetId);
    },
    normalizeSessionReferenceId(sessionId) {
      return typeof sessionId === 'string' ? sessionId.trim() : '';
    },
    switchTab() {},
    attachSession(id, session, options) {
      attached.push({ id, generation: options.navigationGeneration, viewportIntent: options.viewportIntent });
      return Promise.resolve(true);
    },
    syncBrowserState(state) {
      browserStates.push(state);
    },
  };
  context.globalThis = context;
  vm.runInNewContext(
    `${extractFunctionSource(read('static/chat/session-http.js'), 'navigateToSession')}`,
    context,
    { filename: 'static/chat/session-http.js' },
  );

  const oldNavigation = context.navigateToSession('session-a', {
    loadSession: async () => {
      await oldSessionReady;
      return { id: 'session-a', name: 'A' };
    },
  });
  const newNavigation = context.navigateToSession('session-b', {
    loadSession: async () => ({ id: 'session-b', name: 'B' }),
  });
  await newNavigation;
  resolveOldSession();
  await oldNavigation;

  assert.deepEqual(attached.map((entry) => entry.id), ['session-b'],
    'a late response from an older navigation must not attach the old session');
  assert.equal(attached[0].viewportIntent, 'session_entry_bottom',
    'new session navigation should request the latest-message viewport');
  assert.deepEqual(browserStates.map((state) => state.sessionId), ['session-b'],
    'a stale navigation must not rewrite the URL after the newer click');

  const cancelled = await context.navigateToSession('session-cancelled', {
    loadSession: async () => null,
  });
  assert.equal(cancelled, null, 'a cancelled refresh should be a navigation no-op');
  assert.equal(context.pendingNavigationState, null,
    'a cancelled current navigation must not leave a stale pending target');
  assert.deepEqual(attached.map((entry) => entry.id), ['session-b'],
    'a cancelled navigation must not attach a placeholder session');
}

{
  // A stale attach completion must not clear the global loading state owned
  // by the newer session click. Before the guard in navigateToSession, the
  // old navigation's "cancelled" cleanup cleared session B's skeleton and
  // pending target, leaving the final click stuck until a full reload.
  let navigationGeneration = 0;
  let navigationTargetId = '';
  let resolveAttachA;
  let resolveAttachB;
  let cancelledSkeletons = 0;
  const context = {
    Promise,
    String,
    Number,
    console,
    pendingNavigationState: null,
    beginSessionNavigation(sessionId = '') {
      navigationGeneration += 1;
      navigationTargetId = String(sessionId || '').trim();
      return { generation: navigationGeneration, sessionId: navigationTargetId };
    },
    isSessionNavigationCurrent(generation, sessionId = '') {
      return generation === navigationGeneration
        && String(sessionId).trim() === navigationTargetId;
    },
    normalizeSessionReferenceId(sessionId) {
      return typeof sessionId === 'string' ? sessionId.trim() : '';
    },
    switchTab() {},
    scheduleSessionLoadingSkeleton() {},
    cancelSessionLoadingSkeleton() {
      cancelledSkeletons += 1;
    },
    clearSessionLoadError() {},
    attachSession(id) {
      if (id === 'session-a') {
        return new Promise((resolve) => { resolveAttachA = resolve; });
      }
      return new Promise((resolve) => { resolveAttachB = resolve; });
    },
    upsertSession(session) {
      return session;
    },
    syncBrowserState() {},
  };
  context.globalThis = context;
  vm.runInNewContext(
    `${extractFunctionSource(read('static/chat/session-http.js'), 'navigateToSession')}`,
    context,
    { filename: 'static/chat-session-navigation-stale-cancel-cleanup-runtime.js' },
  );

  const firstNavigation = context.navigateToSession('session-a', {
    session: { id: 'session-a', name: 'A' },
  });
  const secondNavigation = context.navigateToSession('session-b', {
    session: { id: 'session-b', name: 'B' },
  });
  assert.equal(context.pendingNavigationState.sessionId, 'session-b',
    'the newest click should own the pending navigation target');

  resolveAttachA('cancelled');
  await firstNavigation;
  assert.equal(cancelledSkeletons, 0,
    'a stale cancelled attach must not clear the newer session loading skeleton');
  assert.equal(context.pendingNavigationState.sessionId, 'session-b',
    'a stale cancelled attach must not clear the newer pending target');

  resolveAttachB(true);
  await secondNavigation;
  assert.equal(context.pendingNavigationState, null,
    'the current navigation should clear its own pending target after attach');
}

{
  const shownErrors = [];
  const browserStates = [];
  let navigationGeneration = 0;
  let navigationTargetId = '';
  const context = {
    Promise,
    String,
    Number,
    console,
    pendingNavigationState: null,
    currentSessionId: 'session-current',
    beginSessionNavigation(sessionId) {
      navigationGeneration += 1;
      navigationTargetId = String(sessionId || '').trim();
      return { generation: navigationGeneration, sessionId: navigationTargetId };
    },
    isSessionNavigationCurrent(generation, sessionId = '') {
      return generation === navigationGeneration
        && String(sessionId).trim() === navigationTargetId;
    },
    normalizeSessionReferenceId(sessionId) {
      return typeof sessionId === 'string' ? sessionId.trim() : '';
    },
    switchTab() {},
    scheduleSessionLoadingSkeleton() {},
    clearSessionLoadError() {},
    showSessionLoadError(sessionId, error, reason) {
      shownErrors.push({ sessionId, error, reason });
    },
    classifySessionLoadError(error) {
      return error.eventRefreshReason || 'request_failed';
    },
    syncBrowserState(state) {
      browserStates.push(state);
    },
    attachSession() {
      return Promise.resolve(false);
    },
    upsertSession(session) {
      return session;
    },
  };
  context.globalThis = context;
  vm.runInNewContext(
    `${extractFunctionSource(read('static/chat/session-http.js'), 'navigateToSession')}`,
    context,
    { filename: 'static/chat-session-navigation-failure-runtime.js' },
  );

  await assert.rejects(
    context.navigateToSession('session-failed', {
      session: { id: 'session-failed', name: 'Failed' },
    }),
    /Session attach failed/,
    'navigation must reject when attach reports a load failure',
  );
  assert.equal(shownErrors.length, 1, 'the current navigation should surface exactly one visible load error');
  assert.equal(shownErrors[0].sessionId, 'session-failed');
  assert.equal(shownErrors[0].reason, 'attach_failed');
  assert.equal(browserStates.length, 0, 'a failed navigation must not commit browser history');
  assert.equal(context.pendingNavigationState.sessionId, 'session-failed',
    'a failed navigation must retain its target for retry');
}

{
  const shownErrors = [];
  const browserStates = [];
  let cancelledSkeletons = 0;
  let navigationGeneration = 0;
  let navigationTargetId = '';
  const context = {
    Promise,
    String,
    Number,
    console,
    pendingNavigationState: null,
    currentSessionId: 'session-current',
    beginSessionNavigation(sessionId) {
      navigationGeneration += 1;
      navigationTargetId = String(sessionId || '').trim();
      return { generation: navigationGeneration, sessionId: navigationTargetId };
    },
    isSessionNavigationCurrent(generation, sessionId = '') {
      return generation === navigationGeneration
        && String(sessionId).trim() === navigationTargetId;
    },
    normalizeSessionReferenceId(sessionId) {
      return typeof sessionId === 'string' ? sessionId.trim() : '';
    },
    switchTab() {},
    scheduleSessionLoadingSkeleton() {},
    cancelSessionLoadingSkeleton() {
      cancelledSkeletons += 1;
    },
    clearSessionLoadError() {},
    showSessionLoadError(sessionId, error, reason) {
      shownErrors.push({ sessionId, error, reason });
    },
    classifySessionLoadError(error) {
      return error.eventRefreshReason || 'request_failed';
    },
    syncBrowserState(state) {
      browserStates.push(state);
    },
    attachSession() {
      return Promise.resolve('cancelled');
    },
    upsertSession(session) {
      return session;
    },
  };
  context.globalThis = context;
  vm.runInNewContext(
    `${extractFunctionSource(read('static/chat/session-http.js'), 'navigateToSession')}`,
    context,
    { filename: 'static/chat-session-navigation-cancelled-attach-runtime.js' },
  );

  const cancelled = await context.navigateToSession('session-cancelled', {
    session: { id: 'session-cancelled', name: 'Cancelled' },
  });
  assert.equal(cancelled, null, 'a cancelled attach must finish as a navigation no-op');
  assert.equal(shownErrors.length, 0, 'a cancelled attach must not show a session-load error');
  assert.equal(browserStates.length, 0, 'a cancelled attach must not commit browser history');
  assert.equal(cancelledSkeletons, 1, 'a cancelled attach must clear its own loading affordance');
  assert.equal(context.pendingNavigationState, null,
    'a cancelled attach must not leave a stale pending navigation target');
}

{
  const shownErrors = [];
  let navigationGeneration = 0;
  let navigationTargetId = '';
  const context = {
    Promise,
    String,
    Number,
    console,
    pendingNavigationState: null,
    currentSessionId: 'session-current',
    beginSessionNavigation(sessionId) {
      navigationGeneration += 1;
      navigationTargetId = String(sessionId || '').trim();
      return { generation: navigationGeneration, sessionId: navigationTargetId };
    },
    isSessionNavigationCurrent(generation, sessionId = '') {
      return generation === navigationGeneration
        && String(sessionId).trim() === navigationTargetId;
    },
    normalizeSessionReferenceId(sessionId) {
      return typeof sessionId === 'string' ? sessionId.trim() : '';
    },
    switchTab() {},
    scheduleSessionLoadingSkeleton() {},
    clearSessionLoadError() {},
    showSessionLoadError(sessionId, error, reason) {
      shownErrors.push({ sessionId, error, reason });
      return true;
    },
    classifySessionLoadError(error) {
      return error.eventRefreshReason || 'request_failed';
    },
    attachSession() {
      const error = new Error('events unavailable');
      error.status = 503;
      error.eventRefreshReason = 'http_failed';
      error.sessionLoadErrorShown = true;
      shownErrors.push({ sessionId: 'session-event-failed', error, reason: 'http_failed' });
      return Promise.reject(error);
    },
    upsertSession(session) {
      return session;
    },
  };
  context.globalThis = context;
  vm.runInNewContext(
    `${extractFunctionSource(read('static/chat/session-http.js'), 'navigateToSession')}`,
    context,
    { filename: 'static/chat-session-navigation-event-failure-runtime.js' },
  );

  await assert.rejects(
    context.navigateToSession('session-event-failed', {
      session: { id: 'session-event-failed', name: 'Event failure' },
    }),
    /events unavailable/,
  );
  assert.equal(
    shownErrors.length,
    1,
    'navigation must not show a second generic error after event loading already surfaced one',
  );
  assert.equal(shownErrors[0].reason, 'http_failed');
}

{
  const shownErrors = [];
  let navigationGeneration = 0;
  let navigationTargetId = '';
  let rejectOldLoad;
  const oldLoad = new Promise((_, reject) => { rejectOldLoad = reject; });
  const context = {
    Promise,
    String,
    Number,
    console,
    pendingNavigationState: null,
    currentSessionId: 'session-current',
    beginSessionNavigation(sessionId) {
      navigationGeneration += 1;
      navigationTargetId = String(sessionId || '').trim();
      return { generation: navigationGeneration, sessionId: navigationTargetId };
    },
    isSessionNavigationCurrent(generation, sessionId = '') {
      return generation === navigationGeneration
        && String(sessionId).trim() === navigationTargetId;
    },
    normalizeSessionReferenceId(sessionId) {
      return typeof sessionId === 'string' ? sessionId.trim() : '';
    },
    switchTab() {},
    scheduleSessionLoadingSkeleton() {},
    clearSessionLoadError() {},
    showSessionLoadError(sessionId, error, reason) {
      shownErrors.push({ sessionId, error, reason });
    },
    classifySessionLoadError(error) {
      return error.eventRefreshReason || 'request_failed';
    },
    attachSession() {
      return Promise.resolve(true);
    },
    upsertSession(session) {
      return session;
    },
    syncBrowserState() {},
  };
  context.globalThis = context;
  vm.runInNewContext(
    `${extractFunctionSource(read('static/chat/session-http.js'), 'navigateToSession')}`,
    context,
    { filename: 'static/chat-session-navigation-stale-failure-runtime.js' },
  );

  const oldNavigation = context.navigateToSession('session-old', {
    loadSession: () => oldLoad,
  });
  await context.navigateToSession('session-new', {
    loadSession: async () => ({ id: 'session-new', name: 'New' }),
  });
  rejectOldLoad(new Error('old session gateway failure'));
  await assert.rejects(oldNavigation, /old session gateway failure/);
  assert.equal(shownErrors.length, 0,
    'a stale navigation failure must not replace the newer target error state');
}

assert.match(realtime, /historyMode: "push"/);
assert.match(init, /function replaceUrlPreservingHistoryState/);
assert.doesNotMatch(init, /history\.replaceState\(null/);
assert.doesNotMatch(gestures, /ragentCanNavigateBack|ragentNavigateBack/);
assert.match(template, /id="homeBtn"[\s\S]*data-icon="home"/);

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: backHandler });
  const preserved = await page.evaluate(() => {
    history.replaceState({ ragentSessionNavigation: true, sessionId: 'session-a' }, '');
    window.RagentBackHandler.push({ id: 'test-overlay', onBack: () => true });
    return history.state;
  });
  assert.equal(preserved.ragentSessionNavigation, true, 'overlay history entries must preserve session navigation state');
  assert.equal(preserved.sessionId, 'session-a', 'overlay history entries must preserve the active session');

  const returned = await page.evaluate(() => new Promise((resolve) => {
    history.pushState({ ragentSessionNavigation: true, sessionId: 'session-b' }, '');
    window.addEventListener('popstate', (event) => resolve(event.state), { once: true });
    history.back();
  }));
  assert.equal(returned.sessionId, 'session-a', 'Android/browser back should arrive at the previous session history entry');
  await page.close();
} finally {
  await browser.close();
}

console.log('test-chat-session-navigation: ok');
