#!/usr/bin/env node
// Regression coverage for approval replay rendering. Session invalidations can
// replay an approval with a new transport timestamp/sequence; the visible
// notification must stay the same DOM node instead of restarting its animation.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source = await readFile(join(repoRoot, "static/chat/attention-popup.js"), "utf8");
const css = await readFile(join(repoRoot, "static/chat/chat-attention-popup.css"), "utf8");
const decisionsSource = await readFile(join(repoRoot, "static/chat/decisions-store.js"), "utf8");
const decisionSheetSource = await readFile(join(repoRoot, "static/chat/decision-sheet.js"), "utf8");
const decisionCss = await readFile(join(repoRoot, "static/chat/chat-decision-sheet.css"), "utf8");

let browser;
try {
  browser = await chromium.launch({ headless: true });
} catch {
  browser = await chromium.launch({ headless: true, channel: "chrome" });
}

try {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body>
    <script>
      window.getChatStoreStateSnapshot = () => ({ currentSessionId: "foreground" });
      window.getChatStoreSession = (id) => ({ id, name: "background session" });
      window.agentocT = (key) => key;
    </script>
  </body></html>`);
  await page.addScriptTag({ content: source });
  await page.evaluate(() => {
    window.AgentoCAttentionPopup.onRealtimeEvents("background", [{
      type: "approval_request",
      approvalId: "approval-replay",
      kind: "permission",
      status: "pending",
      reason: "Allow the pending operation",
      timestamp: "2026-09-01T00:00:00.000Z",
      seq: 10,
    }]);
  });
  const first = await page.locator(".oneui-notification").elementHandle();
  assert.ok(first, "approval notification should be visible");
  await page.evaluate(() => {
    window.AgentoCAttentionPopup.onRealtimeEvents("background", [{
      type: "approval_request",
      approvalId: "approval-replay",
      kind: "permission",
      status: "pending",
      reason: "Allow the pending operation",
      timestamp: "2026-09-01T00:00:02.000Z",
      seq: 11,
    }]);
  });
  const second = await page.locator(".oneui-notification").elementHandle();
  assert.equal(await first.evaluate((node) => node === document.querySelector(".oneui-notification")), true);
  assert.equal(await second.evaluate((node) => node === document.querySelector(".oneui-notification")), true);
  await page.evaluate(() => {
    window.AgentoCAttentionPopup.onRealtimeEvents("background", [{
      type: "approval_response",
      approvalId: "approval-replay",
      runId: "run-replay",
      status: "approved",
    }]);
    // The provider may replay the request on the next invalidation. It must
    // stay resolved instead of re-entering after the exit animation.
    window.AgentoCAttentionPopup.onRealtimeEvents("background", [{
      type: "approval_request",
      approvalId: "approval-replay",
      runId: "run-replay",
      kind: "permission",
      reason: "Allow the pending operation",
    }]);
  });
  await page.waitForTimeout(320);
  assert.equal(await page.locator("#attentionPopupHost").getAttribute("hidden"), "", "resolved replay must not resurrect the notification");
  await page.evaluate(() => {
    window.AgentoCAttentionPopup._reset();
    window.AgentoCAttentionPopup.onRealtimeEvents("background", [{
      type: "approval_request",
      kind: "permission",
      status: "pending",
      reason: "Legacy harness approval without a provider id",
      timestamp: "2026-09-01T00:00:00.000Z",
    }]);
  });
  const noIdFirst = await page.locator(".oneui-notification").elementHandle();
  assert.ok(noIdFirst, "id-less approval notification should be visible");
  await page.evaluate(() => {
    window.AgentoCAttentionPopup.onRealtimeEvents("background", [{
      type: "approval_request",
      kind: "permission",
      status: "pending",
      reason: "Legacy harness approval without a provider id",
      timestamp: "2026-09-01T00:00:02.000Z",
    }]);
  });
  assert.equal(
    await noIdFirst.evaluate((node) => node === document.querySelector(".oneui-notification")),
    true,
    "id-less replay must keep the same notification node",
  );
  await page.evaluate(() => {
    window.AgentoCAttentionPopup._reset();
    window.AgentoCAttentionPopup.onRealtimeEvents("background", [
      {
        type: "approval_request",
        approvalId: "provider-approval",
        runId: "run-danger",
        kind: "command",
        reason: "The generic provider record is represented by the batch",
      },
      {
        type: "privileged_batch_request",
        batchId: "batch-danger",
        runId: "run-danger",
        other: [{ approvalId: "provider-approval", opId: "op-1", command: "echo protected" }],
        delete: [],
      },
    ]);
  });
  assert.match(
    await page.locator(".oneui-notification").getAttribute("class"),
    /oneui-notification--danger/,
    "a batch projection must be the only visible surface for a paired provider approval",
  );
  await page.evaluate(() => {
    window.AgentoCAttentionPopup._reset();
    window.AgentoCAttentionPopup.onRealtimeEvents("background", [{
      type: "approval_request",
      approvalId: "provider-approval-separated",
      runId: "run-danger-separated",
      kind: "command",
      reason: "The generic provider record arrived first",
    }]);
  });
  assert.doesNotMatch(
    await page.locator(".oneui-notification").getAttribute("class"),
    /oneui-notification--danger/,
    "the separated generic request starts as a regular card",
  );
  await page.evaluate(() => {
    window.AgentoCAttentionPopup.onRealtimeEvents("background", [{
      type: "privileged_batch_request",
      batchId: "batch-danger-separated",
      runId: "run-danger-separated",
      other: [{ approvalId: "provider-approval-separated", opId: "op-2", command: "echo protected" }],
      delete: [],
    }]);
  });
  assert.match(
    await page.locator(".oneui-notification").getAttribute("class"),
    /oneui-notification--danger/,
    "a later batch projection must take over the earlier generic card",
  );
  const sheetPage = await browser.newPage();
  await sheetPage.setContent(`<!doctype html><html><head><style>${css}\n${decisionCss}</style></head><body>
    <div id="inputArea"><div id="liveBar"></div></div>
    <script>window.agentocT = (key) => key;</script>
  </body></html>`);
  await sheetPage.addScriptTag({ content: decisionsSource });
  await sheetPage.addScriptTag({ content: decisionSheetSource });
  await sheetPage.evaluate(() => {
    window.AgentoCDecisions.noteRequest({
      type: "approval_request",
      approvalId: "sheet-replay",
      kind: "permission",
      reason: "Allow the pending operation",
      timestamp: "2026-09-01T00:00:00.000Z",
      seq: 10,
    });
  });
  const firstSheet = await sheetPage.locator("#decisionSheet").elementHandle();
  assert.ok(firstSheet && await firstSheet.isVisible(), "decision sheet should be visible");
  await sheetPage.evaluate(() => {
    window.AgentoCDecisions.noteRequest({
      type: "approval_request",
      approvalId: "sheet-replay",
      kind: "permission",
      reason: "Allow the pending operation",
      timestamp: "2026-09-01T00:00:02.000Z",
      seq: 11,
    });
  });
  assert.equal(await firstSheet.evaluate((node) => node === document.querySelector("#decisionSheet")), true);
  await sheetPage.evaluate(() => {
    window.AgentoCDecisions.noteResponse({ approvalId: "sheet-replay", runId: "run-replay" });
  });
  await sheetPage.waitForTimeout(220);
  await sheetPage.evaluate(() => {
    window.AgentoCDecisions.noteRequest({
      type: "approval_request",
      approvalId: "sheet-replay",
      runId: "run-replay",
      kind: "permission",
      reason: "Allow the pending operation",
    });
  });
  assert.equal(await sheetPage.locator("#decisionSheet").getAttribute("hidden"), "", "resolved replay must not resurrect the decision sheet");

  await sheetPage.evaluate(() => {
    window.AgentoCDecisions.notePrivilegedBatch({
      type: "privileged_batch_request",
      batchId: "batch-replay",
      runId: "run-1",
      other: [{ opId: "op-1", command: "echo protected" }],
      delete: [],
      timestamp: "2026-09-01T00:00:00.000Z",
      seq: 20,
    });
  });
  const firstBatch = await sheetPage.locator("#decisionSheet .decision-sheet__batch").elementHandle();
  assert.ok(firstBatch, "batch decision sheet should be visible");
  assert.equal(await sheetPage.locator('#decisionSheet [data-batch-decision="approve"]').count(), 1,
    'ordinary batches retain their approval action');
  assert.equal(await firstSheet.isVisible(), true, "batch takeover must not close the decision sheet");
  assert.equal(await firstSheet.evaluate((node) => node.classList.contains("is-closing")), false);
  await sheetPage.evaluate(() => {
    window.AgentoCDecisions.notePrivilegedBatch({
      type: "privileged_batch_request",
      batchId: "batch-replay",
      runId: "run-1",
      other: [{ opId: "op-1", command: "echo protected" }],
      delete: [],
      timestamp: "2026-09-01T00:00:02.000Z",
      seq: 21,
    });
  });
  assert.equal(await firstBatch.evaluate((node) => node === document.querySelector("#decisionSheet .decision-sheet__batch")), true);
  await sheetPage.evaluate(() => {
    window.AgentoCDecisions.reset();
    window.agentocGetActiveUiLanguage = () => 'zh-CN';
    window.AgentoCDecisions.notePrivilegedBatch({
      type: 'privileged_batch_request', batchId: 'mac-unavailable', runId: 'run-mac',
      executorUnavailableReasonCode: 'macos_administrator_unavailable',
      other: [{ opId: 'mac-op', command: 'launchctl kickstart system/example' }], delete: [],
    });
  });
  await sheetPage.locator('#decisionSheet .decision-sheet__summary').click();
  assert.match(await sheetPage.locator('#decisionSheet').innerText(), /此 Mac 暂不支持托管管理员执行/);
  assert.equal(await sheetPage.locator('#decisionSheet [data-batch-decision="approve"]').count(), 0);
  assert.equal(await sheetPage.locator('#decisionSheet [data-batch-decision="deny"]').count(), 1);
  assert.equal(await sheetPage.locator('#decisionSheet input[type="checkbox"]').isDisabled(), true);
  if (process.env.AGENTOC_QA_SCREENSHOT) await sheetPage.screenshot({ path: process.env.AGENTOC_QA_SCREENSHOT });
  await page.evaluate(() => {
    window.AgentoCAttentionPopup._reset();
    window.agentocGetActiveUiLanguage = () => 'zh-CN';
    window.AgentoCAttentionPopup.onRealtimeEvents('background', [{
      type: 'privileged_batch_request', batchId: 'mac-notification', runId: 'run-mac',
      executorUnavailableReasonCode: 'macos_administrator_unavailable',
      other: [{ opId: 'mac-op', command: 'launchctl kickstart system/example' }], delete: [],
    }]);
  });
  await page.locator('.oneui-notification').press('Enter');
  assert.match(await page.locator('.oneui-notification').innerText(), /此 Mac 暂不支持托管管理员执行/);
  assert.equal(await page.locator('.oneui-notification [data-action="batch-approve"]').count(), 0);
  assert.equal(await page.locator('.oneui-notification [data-action="batch-deny"]').count(), 1);
  await sheetPage.close();
} finally {
  if (browser) await browser.close().catch(() => {});
}

console.log("test-approval-surface-dedupe: ok");
