#!/usr/bin/env node

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { chromium } from "@playwright/test";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source = (path) => readFileSync(join(repoRoot, path), "utf8");

function testUpdateStatusPreservesEditResendTitle() {
  const sendBtnClasses = new Set(["send-btn", "is-edit-resend"]);
  const sendBtn = {
    style: { display: "" },
    disabled: false,
    title: "更新修改后的消息",
    classList: {
      contains: (name) => sendBtnClasses.has(name),
      add: (name) => sendBtnClasses.add(name),
      remove: (name) => sendBtnClasses.delete(name),
    },
  };
  const context = {
    document: { body: { dataset: {} }, getElementById: () => null },
    window: {
      ragentT: (key) => key,
      RagentIcons: { render: () => "" },
    },
    WebSocket: { OPEN: 1 },
    ws: { readyState: 1 },
    cancelBtn: null,
    currentSessionId: "sess-edit",
    visitorMode: false,
    shareSnapshotMode: false,
    sessionStatus: "idle",
    msgInput: { disabled: false, readOnly: false, placeholder: "" },
    sendBtn,
    inputArea: { classList: { toggle: () => {} } },
    imgBtn: { disabled: false },
    inlineToolSelect: { disabled: false },
    inlineModelSelect: { disabled: false },
    thinkingToggle: { disabled: false },
    effortSelect: { disabled: false },
    getCurrentSession: () => ({ id: "sess-edit", archived: false }),
    getSessionActivity: (session) => ({ run: { state: session?.busy ? "running" : "idle" } }),
    isSessionBusy: (session) => session?.busy === true,
    syncConnectionRecoveryIndicator: () => {},
    syncComposerEditResendButton: () => {},
    syncComposerSendAvailability: () => {},
    syncComposerStopButton: () => {},
    syncForkButton: () => {},
    syncShareButton: () => {},
    Map,
    Set,
    Math,
    String,
    Number,
    Boolean,
    Array,
    Object,
    JSON,
    Date,
    console,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(source("static/chat/realtime.js"), context, { filename: "realtime.js" });

  context.updateStatus("connected", { id: "sess-edit", archived: false, busy: false });
  assert.equal(sendBtn.title, "更新修改后的消息", "connected idle updateStatus preserves edit-resend title");

  context.updateStatus("connected", { id: "sess-edit", archived: false, busy: true });
  assert.equal(sendBtn.title, "更新修改后的消息", "connected busy updateStatus preserves edit-resend title");

  context.updateStatus("disconnected", { id: "sess-edit", archived: false, busy: false });
  assert.equal(sendBtn.title, "更新修改后的消息", "disconnected updateStatus preserves edit-resend title");

  sendBtnClasses.delete("is-edit-resend");
  context.updateStatus("connected", { id: "sess-edit", archived: false, busy: true });
  assert.equal(sendBtn.title, "action.queueFollowUp", "normal busy status updates sendBtn title");

  context.updateStatus("connected", { id: "sess-edit", archived: false, busy: false });
  assert.equal(sendBtn.title, "action.send", "normal idle status updates sendBtn title");
}

async function createTimelinePage(browser) {
  const page = await browser.newPage({ viewport: { width: 1024, height: 720 } });
  const frontendErrors = [];
  page.on("pageerror", (error) => frontendErrors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") frontendErrors.push(`console.error: ${message.text()}`);
  });
  await page.setContent(`<!doctype html><html><head><style>${source("static/chat/chat-base.css")}${source("static/chat/chat-messages.css")}</style></head><body><main id="messages"><div class="messages-inner" id="messagesInner"><div class="empty-state" id="emptyState"><h2>Empty</h2></div><section class="home-workspace" id="homeWorkspace" hidden></section></div></main><div id="inputArea"></div></body></html>`);
  await page.evaluate(() => {
    window.marked = { parse: (value) => `<p>${String(value ?? "")}</p>` };
    window.ragentT = (key) => (key === "message.versionRail.folded" ? "Previous versions" : key);
    window.RagentIcons = { render: () => '<svg class="icon"></svg>' };
    window.RagentMotion = { subscribeReducedMotion: () => {} };
    window.RagentRunActivity = { applyEvent: () => {}, noteFormalOutput: () => {} };
    window.RagentDecisions = { reset: () => {} };
    window.visitorMode = false;
    window.shareSnapshotMode = false;
    window.currentSessionId = "edit-resend-sess";
    window.sessionStatus = "idle";
    window.inThinkingBlock = false;
    window.hasAttachedSession = true;
    window.messagesInner = document.getElementById("messagesInner");
    window.messagesEl = document.getElementById("messages");
    window.emptyState = document.getElementById("emptyState");
    window.inputArea = document.getElementById("inputArea");
    window.getCurrentSession = () => ({ id: window.currentSessionId, archived: false });
    window.syncForkButton = () => {};
    window.syncShareButton = () => {};
    window.syncSessionTemplateControls = () => {};
    window.renderQueuedMessagePanel = () => {};
    window.resetRenderedEventState = () => {};
    window.renderedEventState = {
      sessionId: "edit-resend-sess",
      latestSeq: 0,
      earliestSeq: 0,
      nextBeforeSeq: null,
      hasMoreBefore: false,
      loadingOlder: false,
      runState: "idle",
      timelineItemCount: 0,
      operationNodesById: new Map(),
      operationSnapshotsById: new Map(),
      expandedOperationIds: new Set(),
    };
    window.formatDecodedDisplayText = (value) => String(value ?? "");
    window.resolveUiProductPath = (value) => String(value ?? "");
    window.createMessageAttachmentNode = (img) => {
      const el = document.createElement("div");
      el.className = "msg-attachment";
      el.textContent = img?.originalName || img?.filename || "attachment";
      return el;
    };
    window.queueHydrateLazyNodes = () => {};
  });
  await page.addScriptTag({ content: source("static/chat/ui.js") });
  await page.addScriptTag({ content: source("static/chat/realtime-render.js") });
  await page.addScriptTag({ content: source("static/chat/core/timeline-projector.js") });
  await page.addScriptTag({ content: source("static/chat/timeline-runtime.js") });
  return { page, frontendErrors };
}

async function testTimelineEditResendAndColdReload(browser) {
  const { page, frontendErrors } = await createTimelinePage(browser);
  const { page: coldPage, frontendErrors: coldErrors } = await createTimelinePage(browser);

  const liveResult = await page.evaluate(async () => {
    const runtime = window.RagentTimelineRuntime;
    const container = document.getElementById("messagesInner");
    const inspectDom = () => ({
      topLevelClasses: Array.from(container.children).map((el) => el.className),
      userTexts: Array.from(container.querySelectorAll(".msg-user"))
        .map((el) => el.querySelector(".md-content")?.textContent?.trim() || ""),
      userEditable: Array.from(container.querySelectorAll(".msg-user"))
        .map((el) => el.classList.contains("is-editable")),
      userBodyPending: Array.from(container.querySelectorAll(".msg-user .md-content"))
        .map((el) => el.dataset.bodyPending || null),
      userImageCount: container.querySelectorAll(".msg-user .msg-images > *").length,
      railCount: container.querySelectorAll(".msg-version-rail").length,
      railExpanded: container.querySelector(".msg-version-rail")?.classList.contains("is-expanded") || false,
      railFoldedCount: container.querySelector(".msg-version-rail")?.dataset.foldedCount || null,
      railLabel: container.querySelector(".msg-version-rail__label")?.textContent || null,
      foldedTexts: Array.from(container.querySelectorAll(".msg-version-rail__body .msg-assistant"))
        .map((el) => (el.querySelector(".msg-assistant-body") || el).textContent?.trim() || ""),
      foldedRegenerable: Array.from(container.querySelectorAll(".msg-version-rail__body .msg-assistant"))
        .map((el) => el.classList.contains("is-regenerable")),
      visibleAssistantTexts: Array.from(container.children)
        .filter((el) => el.classList.contains("msg-assistant"))
        .map((el) => (el.querySelector(".msg-assistant-body") || el).textContent?.trim() || ""),
      visibleAssistantRegenerable: Array.from(container.children)
        .filter((el) => el.classList.contains("msg-assistant"))
        .map((el) => el.classList.contains("is-regenerable")),
    });

    const baseEvents = [
      {
        type: "user_message",
        seq: 1,
        requestId: "req-1",
        runId: "run-1",
        content: "Initial prompt v1",
        bodyAvailable: true,
        bodyPreview: "Initial prompt v1",
        images: [{ filename: "old-shot.png" }],
      },
      {
        type: "message",
        role: "assistant",
        seq: 2,
        requestId: "req-1",
        runId: "run-1",
        content: "Reply v1",
      },
    ];
    runtime.renderBatch(baseEvents, { sessionId: "edit-resend-sess", runState: "idle", reset: true });
    const afterBase = inspectDom();

    // Optimistic patch right when user submits edit-resend (clears image & updates text in place).
    const initialUserTimelineId = container.querySelector(".msg-user")?.dataset?.timelineId || null;
    const optimisticPatched = window.applyEditedUserMessageContent("req-1", "Edited prompt v2", []);
    const sameUserNodeAfterOptimistic = container.querySelector(".msg-user")?.dataset?.timelineId === initialUserTimelineId;
    const afterOptimistic = inspectDom();

    // Durable run_regenerate arrives (without images field when attachments were cleared).
    window.sessionStatus = "running";
    const regen1 = {
      type: "run_regenerate",
      seq: 3,
      parentRequestId: "req-1",
      requestId: "edit-1",
      runId: "run-2",
      parentRunId: "run-1",
      editResend: true,
      prompt: "Edited prompt v2",
    };
    runtime.renderDurableDelta([regen1], { sessionId: "edit-resend-sess", runState: "running" });
    const afterRegenDelta = inspectDom();

    // Stream live v2 token, then expand rail, then run subsequent commit() polling ticks.
    runtime.renderIncremental([
      {
        type: "text_delta",
        requestId: "edit-1",
        runId: "run-2",
        content: "Streaming v2 ",
      },
    ], { sessionId: "edit-resend-sess", runState: "running", source: "ws" });
    const afterLiveV2 = inspectDom();

    container.querySelector(".msg-version-rail__toggle")?.click();
    const reply2 = {
      type: "message",
      role: "assistant",
      seq: 4,
      requestId: "edit-1",
      runId: "run-2",
      content: "Streaming v2 Reply",
    };
    runtime.renderDurableDelta([reply2], { sessionId: "edit-resend-sess", runState: "idle" });
    window.sessionStatus = "idle";
    runtime.renderBatch([...baseEvents, regen1, reply2], {
      sessionId: "edit-resend-sess",
      runState: "idle",
      reset: false,
    });
    const afterPollingCommit = inspectDom();

    // Second edit-resend (v3) folds BOTH v1 and v2 into the same rail.
    const regen2 = {
      type: "run_regenerate",
      seq: 5,
      parentRequestId: "req-1",
      requestId: "edit-2",
      runId: "run-3",
      parentRunId: "run-2",
      editResend: true,
      prompt: "Edited prompt v3",
      images: [{ filename: "v3.png" }],
    };
    const reply3 = {
      type: "message",
      role: "assistant",
      seq: 6,
      requestId: "edit-2",
      runId: "run-3",
      content: "Reply v3",
    };
    runtime.renderDurableDelta([regen2, reply3], { sessionId: "edit-resend-sess", runState: "idle" });
    const afterSecondEdit = inspectDom();

    // Plain regenerate (v4) folds v1..v3 while preserving Edited prompt v3 on user bubble!
    const regen3 = {
      type: "run_regenerate",
      seq: 7,
      parentRequestId: "req-1",
      requestId: "regen-4",
      runId: "run-4",
      parentRunId: "run-3",
    };
    const reply4 = {
      type: "message",
      role: "assistant",
      seq: 8,
      requestId: "regen-4",
      runId: "run-4",
      content: "Reply v4",
    };
    runtime.renderDurableDelta([regen3, reply4], { sessionId: "edit-resend-sess", runState: "idle" });
    const afterPlainRegen = inspectDom();

    // Switch session and restore cached projector via restoreCachedSession.
    runtime.renderBatch([
      { type: "user_message", seq: 1, requestId: "other-1", runId: "other-run", content: "Other session" },
    ], { sessionId: "other-sess", runState: "idle", reset: true });
    runtime.restoreCachedSession("edit-resend-sess", { runState: "idle" });
    const afterRestore = inspectDom();

    // Also test seq-free ephemeral run_regenerate followed by durable retirement.
    runtime.renderBatch([
      { type: "user_message", seq: 1, requestId: "live-req-1", runId: "live-run-1", content: "Before live edit" },
      { type: "message", role: "assistant", seq: 2, requestId: "live-req-1", runId: "live-run-1", content: "Before live reply" },
    ], { sessionId: "live-regen-sess", runState: "idle", reset: true });
    runtime.renderIncremental([
      {
        type: "run_regenerate",
        parentRequestId: "live-req-1",
        requestId: "live-edit-1",
        runId: "live-run-2",
        parentRunId: "live-run-1",
        editResend: true,
        prompt: "Live edited text",
      },
    ], { sessionId: "live-regen-sess", runState: "running", source: "api" });
    const afterEphemeralRegen = inspectDom();

    return {
      afterBase,
      optimisticPatched,
      sameUserNodeAfterOptimistic,
      afterOptimistic,
      afterRegenDelta,
      afterLiveV2,
      afterPollingCommit,
      afterSecondEdit,
      afterPlainRegen,
      afterRestore,
      afterEphemeralRegen,
    };
  });

  assert.deepEqual(liveResult.afterBase.userTexts, ["Initial prompt v1"]);
  assert.deepEqual(liveResult.afterBase.userEditable, [true]);
  assert.equal(liveResult.afterBase.railCount, 0);
  assert.equal(liveResult.afterBase.userImageCount, 1);

  assert.equal(liveResult.optimisticPatched, true);
  assert.equal(liveResult.sameUserNodeAfterOptimistic, true, "optimistic patch updates user bubble in place without breaking timeline identity");
  assert.deepEqual(liveResult.afterOptimistic.userTexts, ["Edited prompt v2"]);
  assert.deepEqual(liveResult.afterOptimistic.userEditable, [true]);
  assert.equal(liveResult.afterOptimistic.userImageCount, 0);

  assert.deepEqual(liveResult.afterRegenDelta.userTexts, ["Edited prompt v2"]);
  assert.equal(liveResult.afterRegenDelta.railCount, 1);
  assert.equal(liveResult.afterRegenDelta.railFoldedCount, "1");
  assert.deepEqual(liveResult.afterRegenDelta.foldedTexts, ["Reply v1"]);
  assert.deepEqual(liveResult.afterRegenDelta.userBodyPending, [null]);

  assert.deepEqual(liveResult.afterLiveV2.foldedTexts, ["Reply v1"]);
  assert.deepEqual(liveResult.afterLiveV2.visibleAssistantTexts, ["Streaming v2"]);

  assert.equal(liveResult.afterPollingCommit.railCount, 1, "subsequent polling commit keeps rail intact");
  assert.equal(liveResult.afterPollingCommit.railExpanded, true, "subsequent commit preserves rail expanded state");
  assert.deepEqual(liveResult.afterPollingCommit.foldedTexts, ["Reply v1"]);
  assert.deepEqual(liveResult.afterPollingCommit.foldedRegenerable, [false]);
  assert.deepEqual(liveResult.afterPollingCommit.visibleAssistantTexts, ["Streaming v2 Reply"]);
  assert.deepEqual(liveResult.afterPollingCommit.visibleAssistantRegenerable, [true]);
  assert.deepEqual(liveResult.afterPollingCommit.userTexts, ["Edited prompt v2"]);

  assert.equal(liveResult.afterSecondEdit.railFoldedCount, "2");
  assert.equal(liveResult.afterSecondEdit.railLabel, "Previous versions · 2");
  assert.deepEqual(liveResult.afterSecondEdit.userTexts, ["Edited prompt v3"]);
  assert.equal(liveResult.afterSecondEdit.userImageCount, 1);
  assert.deepEqual(liveResult.afterSecondEdit.foldedTexts, ["Reply v1", "Streaming v2 Reply"]);
  assert.deepEqual(liveResult.afterSecondEdit.visibleAssistantTexts, ["Reply v3"]);

  assert.equal(liveResult.afterPlainRegen.railFoldedCount, "3");
  assert.deepEqual(liveResult.afterPlainRegen.userTexts, ["Edited prompt v3"], "plain regenerate after edit keeps edited user text");
  assert.deepEqual(liveResult.afterPlainRegen.userEditable, [true]);
  assert.deepEqual(liveResult.afterPlainRegen.foldedTexts, ["Reply v1", "Streaming v2 Reply", "Reply v3"]);
  assert.deepEqual(liveResult.afterPlainRegen.visibleAssistantTexts, ["Reply v4"]);
  assert.deepEqual(liveResult.afterPlainRegen.visibleAssistantRegenerable, [true]);

  assert.equal(liveResult.afterRestore.railFoldedCount, "3", "restoreCachedSession renders folded rail");
  assert.deepEqual(liveResult.afterRestore.userTexts, ["Edited prompt v3"]);
  assert.deepEqual(liveResult.afterRestore.foldedTexts, ["Reply v1", "Streaming v2 Reply", "Reply v3"]);
  assert.deepEqual(liveResult.afterRestore.visibleAssistantTexts, ["Reply v4"]);

  assert.equal(liveResult.afterEphemeralRegen.railFoldedCount, "1", "seq-free run_regenerate folds reply");
  assert.deepEqual(liveResult.afterEphemeralRegen.userTexts, ["Live edited text"]);

  // Verify cold reload from scratch (`renderBatch(..., { reset: true })`).
  const coldResult = await coldPage.evaluate(() => {
    const runtime = window.RagentTimelineRuntime;
    const container = document.getElementById("messagesInner");
    runtime.renderBatch([
      { type: "message", role: "user", seq: 1, requestId: "req-1", runId: "run-1", content: "Initial prompt v1", bodyAvailable: true },
      { type: "message", role: "assistant", seq: 2, requestId: "req-1", runId: "run-1", content: "Reply v1" },
      { type: "run_regenerate", seq: 3, parentRequestId: "req-1", requestId: "edit-1", runId: "run-2", parentRunId: "run-1", editResend: true, prompt: "Edited prompt v2" },
      { type: "message", role: "assistant", seq: 4, requestId: "edit-1", runId: "run-2", content: "Reply v2" },
      { type: "run_regenerate", seq: 5, parentRequestId: "req-1", requestId: "edit-2", runId: "run-3", parentRunId: "run-2", editResend: true, prompt: "Edited prompt v3" },
      { type: "message", role: "assistant", seq: 6, requestId: "edit-2", runId: "run-3", content: "Reply v3" },
      { type: "run_regenerate", seq: 7, parentRequestId: "req-1", requestId: "regen-4", runId: "run-4", parentRunId: "run-3" },
      { type: "message", role: "assistant", seq: 8, requestId: "regen-4", runId: "run-4", content: "Reply v4" },
    ], { sessionId: "edit-resend-sess", runState: "idle", reset: true });

    const topClasses = Array.from(container.children)
      .filter((el) => el.id !== "homeWorkspace" && el.id !== "emptyState")
      .map((el) => {
      if (el.classList.contains("msg-user")) return "msg-user";
      if (el.classList.contains("msg-version-rail")) return "msg-version-rail";
      if (el.classList.contains("msg-assistant")) return "msg-assistant";
      return el.className;
    });
    return {
      topClasses,
      userText: container.querySelector(".msg-user .md-content")?.textContent?.trim() || "",
      userEditable: container.querySelector(".msg-user")?.classList.contains("is-editable") || false,
      userBodyPending: container.querySelector(".msg-user .md-content")?.dataset?.bodyPending || null,
      railFoldedCount: container.querySelector(".msg-version-rail")?.dataset?.foldedCount || null,
      foldedTexts: Array.from(container.querySelectorAll(".msg-version-rail__body .msg-assistant"))
        .map((el) => (el.querySelector(".msg-assistant-body") || el).textContent?.trim() || ""),
      visibleAssistantText: (() => {
        const assistant = Array.from(container.children).find((el) => el.classList.contains("msg-assistant"));
        return assistant ? ((assistant.querySelector(".msg-assistant-body") || assistant).textContent?.trim() || "") : "";
      })(),
      visibleAssistantRegenerable: Array.from(container.children)
        .find((el) => el.classList.contains("msg-assistant"))
        ?.classList.contains("is-regenerable") || false,
    };
  });

  assert.deepEqual(coldResult.topClasses, ["msg-user", "msg-version-rail", "msg-assistant"]);
  assert.equal(coldResult.userText, "Edited prompt v3");
  assert.equal(coldResult.userEditable, true);
  assert.equal(coldResult.userBodyPending, null);
  assert.equal(coldResult.railFoldedCount, "3");
  assert.deepEqual(coldResult.foldedTexts, ["Reply v1", "Reply v2", "Reply v3"]);
  assert.equal(coldResult.visibleAssistantText, "Reply v4");
  assert.equal(coldResult.visibleAssistantRegenerable, true);
  assert.deepEqual(frontendErrors, []);
  assert.deepEqual(coldErrors, []);
  await page.close();
  await coldPage.close();
}

async function testVditorComposerFlush(browser) {
  const [
    baseCss,
    inputCss,
    vditorJs,
    vditorCss,
    luteJs,
    iconsJs,
    zhLocaleJs,
    lightThemeCss,
    adapterJs,
    workerJs,
  ] = await Promise.all([
    readFile(join(repoRoot, "static/chat/chat-base.css"), "utf8"),
    readFile(join(repoRoot, "static/chat/chat-input.css"), "utf8"),
    readFile(join(repoRoot, "static/chat/vendor/vditor/dist/index.min.js"), "utf8"),
    readFile(join(repoRoot, "static/chat/vendor/vditor/dist/index.css"), "utf8"),
    readFile(join(repoRoot, "static/chat/vendor/vditor/dist/js/lute/lute.min.js"), "utf8"),
    readFile(join(repoRoot, "static/chat/vendor/vditor/dist/js/icons/ant.js"), "utf8"),
    readFile(join(repoRoot, "static/chat/vendor/vditor/dist/js/i18n/zh_CN.js"), "utf8"),
    readFile(join(repoRoot, "static/chat/vendor/vditor/dist/css/content-theme/light.css"), "utf8"),
    readFile(join(repoRoot, "static/chat/markdown-composer-editor.js"), "utf8"),
    readFile(join(repoRoot, "static/chat/markdown-composer-worker.js"), "utf8"),
  ]);

  const html = `<!doctype html>
<html>
<head>
  <link rel="stylesheet" href="/chat/chat-base.css">
  <link rel="stylesheet" href="/chat/chat-input.css">
  <link rel="stylesheet" href="/chat/vendor/vditor/dist/index.css">
</head>
<body>
  <div id="composerEditor" class="composer-markdown-editor"></div>
  <textarea id="msgInput"></textarea>
  <script src="/chat/vendor/vditor/dist/index.min.js"></script>
  <script src="/chat/markdown-composer-editor.js"></script>
</body>
</html>`;

  const assets = new Map([
    ["/chat/chat-base.css", ["text/css", baseCss]],
    ["/chat/chat-input.css", ["text/css", inputCss]],
    ["/chat/vendor/vditor/dist/index.min.js", ["text/javascript", vditorJs]],
    ["/chat/vendor/vditor/dist/index.css", ["text/css", vditorCss]],
    ["/chat/vendor/vditor/dist/js/lute/lute.min.js", ["text/javascript", luteJs]],
    ["/chat/vendor/vditor/dist/js/icons/ant.js", ["text/javascript", iconsJs]],
    ["/chat/vendor/vditor/dist/js/i18n/zh_CN.js", ["text/javascript", zhLocaleJs]],
    ["/chat/vendor/vditor/dist/css/content-theme/light.css", ["text/css", lightThemeCss]],
    ["/chat/markdown-composer-editor.js", ["text/javascript", adapterJs]],
    ["/chat/markdown-composer-worker.js", ["text/javascript", workerJs]],
  ]);

  const server = createServer((req, res) => {
    const pathname = (req.url || "/").split("?")[0];
    if (pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    const asset = assets.get(pathname);
    if (!asset) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": `${asset[0]}; charset=utf-8` });
    res.end(asset[1]);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
    await page.evaluate(async () => {
      const msgInput = document.getElementById("msgInput");
      const composerEditor = document.getElementById("composerEditor");
      window.RagentMarkdownComposer.mount(msgInput, composerEditor);
      await new Promise((resolve, reject) => {
        const start = Date.now();
        const timer = setInterval(() => {
          const editable = composerEditor.querySelector(".vditor-wysiwyg > pre");
          if (editable && editable.getAttribute("contenteditable") === "true") {
            clearInterval(timer);
            setTimeout(resolve, 60);
          } else if (Date.now() - start > 5000) {
            clearInterval(timer);
            reject(new Error("Vditor did not mount"));
          }
        }, 25);
      });
    });

    const flushResult = await page.evaluate(() => {
      const msgInput = document.getElementById("msgInput");
      let inputCount = 0;
      msgInput.addEventListener("input", () => { inputCount += 1; });

      // Simulate restoreMessageIntoComposer setting Run 1 prompt (establishes externalValueBarrier).
      msgInput.value = "Run 1 prompt";
      const editable = document.querySelector("#composerEditor .vditor-wysiwyg > pre");
      const firstBlock = editable.querySelector("p") || editable;
      firstBlock.textContent = "Edited Run 2 prompt";
      const beforeFlush = msgInput.value;
      const inputCountBeforeFlush = inputCount;

      const didFlush = window.RagentMarkdownComposer.flush(msgInput);
      const afterFlush = msgInput.value;
      const inputCountAfterFlush = inputCount;

      // Second immediate flush without edits must be a silent no-op (no redundant input dispatch).
      const didSecondFlush = window.RagentMarkdownComposer.flush(msgInput);
      const inputCountAfterSecondFlush = inputCount;

      // Clearing textarea sets externalValueBarrier = ""; a subsequent un-emitted DOM edit must still flush.
      msgInput.value = "";
      const clearedBlock = editable.querySelector("p") || editable;
      clearedBlock.textContent = "Run 3 after clear";
      const didThirdFlush = window.RagentMarkdownComposer.flush(msgInput);
      const afterThirdFlush = msgInput.value;

      return {
        beforeFlush,
        inputCountBeforeFlush,
        didFlush,
        afterFlush,
        inputCountAfterFlush,
        didSecondFlush,
        inputCountAfterSecondFlush,
        didThirdFlush,
        afterThirdFlush,
      };
    });

    // Also test stale pendingMarkdownValue + immediate DOM edit before timer flushes:
    // typing schedules pendingMarkdownValue, then immediate DOM mutation before Send must read live DOM.
    await page.evaluate(() => {
      const editable = document.querySelector("#composerEditor .vditor-wysiwyg > pre");
      editable.focus();
    });
    await page.keyboard.type("stale");
    const raceFlush = await page.evaluate(() => {
      const msgInput = document.getElementById("msgInput");
      const editable = document.querySelector("#composerEditor .vditor-wysiwyg > pre");
      const block = editable.querySelector("p") || editable;
      block.textContent = "Live DOM overrides pending";
      const didFlush = window.RagentMarkdownComposer.flush(msgInput);
      return {
        didFlush,
        value: msgInput.value,
      };
    });

    assert.equal(flushResult.beforeFlush, "Run 1 prompt");
    assert.equal(flushResult.inputCountBeforeFlush, 0);
    assert.equal(flushResult.didFlush, true, "flush() must read Vditor synchronously even when pendingMarkdownValue is null");
    assert.equal(flushResult.afterFlush.trim(), "Edited Run 2 prompt");
    assert.equal(flushResult.inputCountAfterFlush, 1);
    assert.equal(flushResult.didSecondFlush, false, "unchanged repeat flush() returns false");
    assert.equal(flushResult.inputCountAfterSecondFlush, 1, "unchanged repeat flush() emits no redundant input event");
    assert.equal(flushResult.didThirdFlush, true);
    assert.equal(flushResult.afterThirdFlush.trim(), "Run 3 after clear");
    assert.equal(raceFlush.didFlush, true);
    assert.equal(raceFlush.value.trim(), "Live DOM overrides pending", "flush() reads live Vditor DOM even when pendingMarkdownValue was queued");
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
    server.close();
  }
}

testUpdateStatusPreservesEditResendTitle();

const browser = await chromium.launch({ headless: true });
try {
  await testTimelineEditResendAndColdReload(browser);
  await testVditorComposerFlush(browser);
  console.log("test-timeline-edit-resend: ok");
} finally {
  await browser.close();
}
