#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { chromium } from "@playwright/test";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source = [
  "static/chat/session-http-helpers.js",
  "static/chat/session-http-list-state.js",
  "static/chat/session-http.js",
].map((path) => readFileSync(join(repoRoot, path), "utf8")).join("\n");

function makeElement(tagName = "div") {
  const listeners = new Map();
  const node = {
    tagName: String(tagName).toUpperCase(),
    dataset: {},
    style: { setProperty() {} },
    attributes: {},
    disabled: false,
    hidden: false,
    textContent: "",
    innerHTML: "",
    className: "",
    type: "",
    children: [],
    parentNode: null,
    appendChild(child) {
      if (!child) return child;
      if (child.parentNode) child.parentNode.removeChild?.(child);
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    append(...children) {
      children.forEach((child) => this.appendChild(child));
    },
    insertBefore(child, reference) {
      if (!child) return child;
      if (child.parentNode) child.parentNode.removeChild?.(child);
      const index = reference ? this.children.indexOf(reference) : -1;
      if (index < 0) this.children.push(child);
      else this.children.splice(index, 0, child);
      child.parentNode = this;
      return child;
    },
    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index >= 0) this.children.splice(index, 1);
      if (child) child.parentNode = null;
      return child;
    },
    remove() {
      this.parentNode?.removeChild?.(this);
      this.parentNode = null;
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    click() {
      listeners.get("click")?.({ currentTarget: this, preventDefault() {} });
    },
    focus() {},
    scrollIntoView() {},
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name)
        ? this.attributes[name]
        : null;
    },
    classList: {
      add(...names) {
        const values = new Set(String(node.className || "").split(/\s+/).filter(Boolean));
        names.forEach((name) => values.add(name));
        node.className = [...values].join(" ");
      },
      remove(...names) {
        const values = new Set(String(node.className || "").split(/\s+/).filter(Boolean));
        names.forEach((name) => values.delete(name));
        node.className = [...values].join(" ");
      },
      contains(name) {
        return String(node.className || "").split(/\s+/).includes(name);
      },
    },
    querySelector(selector) {
      const className = selector.startsWith(".") ? selector.slice(1) : "";
      for (const child of this.children) {
        if (className && child.classList?.contains(className)) return child;
        const nested = child.querySelector?.(selector);
        if (nested) return nested;
      }
      return null;
    },
    querySelectorAll(selector) {
      const matches = [];
      const className = selector.startsWith(".") ? selector.slice(1) : "";
      const visit = (child) => {
        if (className && child.classList?.contains(className)) matches.push(child);
        child.children?.forEach(visit);
      };
      this.children.forEach(visit);
      return matches;
    },
  };
  return node;
}

function createHarness() {
  const messagesEl = makeElement("main");
  const messagesInner = makeElement("div");
  const emptyState = makeElement("div");
  messagesEl.appendChild(messagesInner);
  messagesInner.appendChild(emptyState);
  const renderedEventState = {
    sessionId: "session-error",
    earliestSeq: 0,
    nextBeforeSeq: null,
    latestSeq: 0,
    timelineItemCount: 0,
    runState: "idle",
    runActivity: null,
    operationNodesById: new Map(),
    operationSnapshotsById: new Map(),
    expandedOperationIds: new Set(),
    runningBlockExpanded: false,
    hasMoreBefore: false,
    loadingOlder: false,
  };
  const context = {
    console,
    URL,
    URLSearchParams,
    Headers,
    Map,
    Set,
    Math,
    Date,
    JSON,
    TextEncoder,
    AbortController,
    Promise,
    performance: { now: () => 0 },
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (callback) => setTimeout(callback, 0),
    cancelAnimationFrame: clearTimeout,
    navigator: {},
    Notification: function Notification() {},
    window: {
      location: { origin: "http://127.0.0.1", href: "http://127.0.0.1/", pathname: "/" },
      setTimeout,
      clearTimeout,
      addEventListener() {},
      focus() {},
      ragentT: (key) => key,
      RagentRunActivity: { setActivity() {} },
      RagentTimelineRuntime: {
        getSnapshot: () => ({
          sessionId: "session-error",
          items: [],
          latestSeq: 0,
          earliestSeq: 0,
          nextBeforeSeq: null,
          hasMoreBefore: false,
          gapExpectedSeq: null,
        }),
        renderBatch() {
          return {
            sessionId: "session-error",
            items: [],
            latestSeq: 0,
            earliestSeq: 0,
            nextBeforeSeq: null,
            hasMoreBefore: false,
            gapExpectedSeq: null,
          };
        },
        renderIncremental() {},
      },
    },
    document: {
      visibilityState: "visible",
      getElementById() { return null; },
      createElement: makeElement,
      addEventListener() {},
    },
    pendingNavigationState: null,
    activeTab: "sessions",
    visitorMode: false,
    visitorSessionId: null,
    shareSnapshotMode: false,
    currentSessionId: "session-error",
    hasAttachedSession: true,
    hasLoadedSessions: true,
    archivedSessionCount: 0,
    sessions: [{ id: "session-error", name: "Broken session" }],
    renderedEventState,
    emptyState,
    messagesInner,
    messagesEl,
    contextTokens: makeElement(),
    compactBtn: makeElement(),
    dropToolsBtn: makeElement(),
    resumeBtn: makeElement(),
    headerTitle: makeElement(),
    inlineToolSelect: makeElement(),
    toolsList: [],
    selectedTool: "",
    sessionStatus: "idle",
    finishedUnread: new Set(),
    getSessionDisplayName(session) { return session?.name || ""; },
    getEffectiveSessionSourceId(session) { return session?.sourceId || "chat"; },
    normalizeSessionStatus(status) { return status || "idle"; },
    sortSessionsInPlace() {},
    refreshAppCatalog() {},
    renderSessionList() {},
    restoreDraft() {},
    updateStatus() {},
    renderQueuedMessagePanel() {},
    updateResumeButton() {},
    syncBrowserState() {},
    syncForkButton() {},
    syncShareButton() {},
    clearMessages() {},
    showEmpty() {},
    scrollToBottom() {},
    applyFinishedTurnCollapseState() {},
    shouldFocusLatestTurnStart() { return false; },
    scrollNodeToTop() {},
    checkPendingMessage() {},
    getPendingMessage() { return null; },
    clearPendingMessage() {},
    attachSession() {},
    persistActiveSessionId() {},
    resolveRestoreTargetSession() { return null; },
    switchTab() {},
    applyNavigationState() {},
  };
  context.globalThis = context;
  context.self = context;
  vm.runInNewContext(source, context, { filename: "static/chat/session-http.js" });
  return { context, messagesEl, messagesInner, emptyState };
}

const failed = createHarness();
failed.context.fetchJsonOrRedirect = async () => {
  const error = new Error("gateway unavailable");
  error.status = 503;
  throw error;
};
await assert.rejects(
  failed.context.fetchSessionEvents("session-error", { forceFresh: true }),
  /gateway unavailable/,
);
const errorPanel = failed.messagesEl.children.find((child) => child.className.includes("messages-session-error"));
assert.ok(errorPanel, "a failed session attach must mount a visible error panel");
assert.equal(errorPanel.hidden, false);
assert.equal(errorPanel.dataset.reason, "http_failed");
assert.equal(failed.messagesInner.children.includes(failed.emptyState), true,
  "the failed attach must not destroy the reusable empty-state node");

let retryOptions = null;
failed.context.refreshCurrentSession = async (options) => {
  retryOptions = options;
  return true;
};
errorPanel.querySelector(".messages-session-error__retry").click();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(retryOptions.forceFresh, true);
assert.equal(retryOptions.viewportIntent, "session_entry_bottom");
assert.equal(retryOptions.essential, true);
assert.equal(errorPanel.hidden, true, "retry should dismiss the stale error while loading");

const pendingNavigation = createHarness();
pendingNavigation.context.currentSessionId = "session-old";
pendingNavigation.context.pendingNavigationState = {
  sessionId: "session-target",
  tab: "sessions",
  historyMode: "push",
};
let retryNavigationArgs = null;
pendingNavigation.context.navigateToSession = async (...args) => {
  retryNavigationArgs = args;
  return { id: "session-target" };
};
assert.equal(
  pendingNavigation.context.showSessionLoadError(
    "session-target",
    new Error("target unavailable"),
    "http_failed",
  ),
  true,
  "a pending navigation target should be allowed to own the load error surface",
);
const pendingErrorPanel = pendingNavigation.messagesEl.children.find(
  (child) => child.className.includes("messages-session-error"),
);
pendingErrorPanel.querySelector(".messages-session-error__retry").click();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(retryNavigationArgs?.[0], "session-target");
assert.equal(retryNavigationArgs?.[1]?.forceFresh, true);
assert.equal(retryNavigationArgs?.[1]?.historyMode, "replace");
assert.equal(retryNavigationArgs?.[1]?.viewportIntent, "session_entry_bottom");

// Retry when pendingNavigationState was cleared and currentSessionId is null:
// previously the guard `if (!isCurrentSessionLoadTarget(sessionId)) return;`
// silently swallowed the click, and refreshCurrentSession did nothing because
// currentSessionId was null.
const detachedRetry = createHarness();
detachedRetry.context.currentSessionId = null;
detachedRetry.context.hasAttachedSession = false;
detachedRetry.context.pendingNavigationState = { sessionId: "session-detached" };
let abortedRefreshSessionId = null;
detachedRetry.context.abortSessionRefreshRequests = (id) => {
  abortedRefreshSessionId = id;
};
let detachedRetryArgs = null;
detachedRetry.context.navigateToSession = async (...args) => {
  detachedRetryArgs = args;
  return { id: "session-detached" };
};
detachedRetry.context.showSessionLoadError(
  "session-detached",
  new Error("attach failed"),
  "attach_failed",
);
// Simulate state reset / failure teardown clearing pendingNavigationState:
detachedRetry.context.pendingNavigationState = null;
const detachedErrorPanel = detachedRetry.messagesEl.children.find(
  (child) => child.className.includes("messages-session-error"),
);
detachedErrorPanel.querySelector(".messages-session-error__retry").click();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(abortedRefreshSessionId, "session-detached",
  "retry should abort in-flight requests for the retried session to prevent scheduler coalescing");
assert.equal(detachedRetryArgs?.[0], "session-detached",
  "retry must route to navigateToSession even if pendingNavigationState and currentSessionId were cleared");
assert.equal(detachedRetryArgs?.[1]?.forceFresh, true);
assert.equal(detachedRetryArgs?.[1]?.historyMode, "replace");
assert.equal(detachedRetryArgs?.[1]?.viewportIntent, "session_entry_bottom");

const empty = createHarness();
empty.context.fetchJsonOrRedirect = async () => ({
  events: [],
  latestSeq: 0,
  pagination: { hasMoreBefore: false },
});
await empty.context.fetchSessionEvents("session-error", { forceFresh: true });
const emptyMetrics = empty.context.window.ragentGetEventRefreshMetrics();
assert.equal(emptyMetrics.last.outcome, "empty");
assert.equal(emptyMetrics.last.renderMode, "empty");
assert.equal(empty.messagesEl.children.some((child) => child.className.includes("messages-session-error")), false);

const malformed = createHarness();
malformed.context.fetchJsonOrRedirect = async () => ({ latestSeq: 2 });
await assert.rejects(
  malformed.context.fetchSessionEvents("session-error", { forceFresh: true }),
  /Invalid session events latest-page response/,
);
const malformedPanel = malformed.messagesEl.children.find((child) => child.className.includes("messages-session-error"));
assert.equal(malformedPanel.dataset.reason, "response_invalid");
assert.equal(malformed.context.window.ragentGetEventRefreshMetrics().last.errorCode, "EVENTS_RESPONSE_INVALID");

const filtered = createHarness();
filtered.context.fetchJsonOrRedirect = async () => ({
  events: [{ id: "control", seq: 1, type: "run_started" }],
  latestSeq: 1,
  pagination: { hasMoreBefore: false },
});
await filtered.context.fetchSessionEvents("session-error", { forceFresh: true });
const filteredMetrics = filtered.context.window.ragentGetEventRefreshMetrics();
assert.equal(filteredMetrics.last.outcome, "empty");
assert.equal(filteredMetrics.last.renderMode, "empty_projection");

// A late response from a request that was aborted during a rapid session
// switch must not remove the next session's global loading skeleton. This is
// the browser-side half of the stale-navigation regression: some transports
// can still resolve after AbortController fires.
const staleRefresh = createHarness();
let resolveStaleResponse;
const staleController = new AbortController();
staleRefresh.context.fetchJsonOrRedirect = async (_url, options = {}) => {
  return new Promise((resolve) => { resolveStaleResponse = resolve; });
};
const nextSkeleton = makeElement("div");
nextSkeleton.className = "messages-loading-skeleton";
staleRefresh.messagesInner.appendChild(nextSkeleton);
const staleRequest = staleRefresh.context.fetchSessionEvents("session-error", {
  forceFresh: true,
  signal: staleController.signal,
});
staleController.abort();
resolveStaleResponse({ events: [], latestSeq: 0, pagination: { hasMoreBefore: false } });
await assert.rejects(staleRequest, { name: "AbortError" });
assert.equal(nextSkeleton.parentNode, staleRefresh.messagesInner,
  "an aborted late response must not clear the newer session loading skeleton");

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 720 } });
  await page.setContent(`<!doctype html><html><head><style>${readFileSync(join(repoRoot, "static/chat/chat-base.css"), "utf8")}${readFileSync(join(repoRoot, "static/chat/chat-messages.css"), "utf8")}</style></head><body><main class="messages" id="messages"><div class="messages-inner" id="messagesInner"><div class="empty-state" id="emptyState"></div></div></main></body></html>`);
  await page.evaluate(() => {
    window.currentSessionId = "browser-error";
    window.hasAttachedSession = true;
    window.visitorMode = false;
    window.shareSnapshotMode = false;
    window.messagesEl = document.getElementById("messages");
    window.messagesInner = document.getElementById("messagesInner");
    window.emptyState = document.getElementById("emptyState");
    window.renderedEventState = {
      sessionId: "browser-error",
      latestSeq: 0,
      earliestSeq: 0,
      nextBeforeSeq: null,
      hasMoreBefore: false,
      loadingOlder: false,
      runState: "idle",
      timelineItemCount: 0,
    };
    window.RagentTimelineRuntime = {
      getSnapshot: () => ({
        sessionId: "browser-error",
        items: [],
        latestSeq: 0,
        earliestSeq: 0,
        nextBeforeSeq: null,
        hasMoreBefore: false,
        gapExpectedSeq: null,
      }),
      renderBatch: () => null,
      renderIncremental: () => null,
    };
    window.showEmpty = () => {};
    window.scrollToBottom = () => {};
    window.applyFinishedTurnCollapseState = () => null;
    window.syncLiveMessageMetadataForRunState = () => {};
    window.syncEditableMessageActions = () => {};
    window.RagentRunActivity = { setActivity() {} };
    window.ragentT = (key) => key;
  });
  for (const path of [
    "static/chat/session-http-helpers.js",
    "static/chat/session-http-list-state.js",
    "static/chat/session-http.js",
  ]) {
    await page.addScriptTag({ content: readFileSync(join(repoRoot, path), "utf8") });
  }
  const browserResult = await page.evaluate(async () => {
    window.fetchJsonOrRedirect = async () => {
      const error = new Error("gateway unavailable");
      error.status = 503;
      throw error;
    };
    try {
      await window.fetchSessionEvents("browser-error", { forceFresh: true });
    } catch {}
    const panel = document.querySelector(".messages-session-error");
    return {
      panelMountedInMessages: panel?.parentNode === messagesEl,
      visible: panel?.hidden === false && getComputedStyle(panel).display !== "none",
      role: panel?.getAttribute("role"),
      buttonText: panel?.querySelector(".messages-session-error__retry")?.textContent,
      messageChildren: messagesInner.children.length,
    };
  });
  assert.deepEqual(browserResult, {
    panelMountedInMessages: true,
    visible: true,
    role: "alert",
    buttonText: "status.retrySessionLoad",
    messageChildren: 1,
  });
  await page.close();
} finally {
  await browser.close();
}

console.log("test-chat-session-load-error: ok");
