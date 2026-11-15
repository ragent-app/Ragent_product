#!/usr/bin/env node
// Visual + geometry fixture for the rebuilt One UI notification surface.
// It uses the real notification source and CSS with synthetic events only.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const outputDir = resolve(process.env.RAGENT_VISUAL_OUTPUT_DIR || '/var/lib/ragent/workspace/visual-ui-reviews/attention-popup');
mkdirSync(outputDir, { recursive: true });

const fs = await import('node:fs/promises');
const css = await fs.readFile(`${repoRoot}/static/chat/chat-attention-popup.css`, 'utf8');
const tokens = await fs.readFile(`${repoRoot}/static/chat/chat-m3-tokens.css`, 'utf8');
const materialFinish = await fs.readFile(`${repoRoot}/static/chat/chat-material-finish.css`, 'utf8');
const source = await fs.readFile(`${repoRoot}/static/chat/attention-popup.js`, 'utf8');
const icons = await fs.readFile(`${repoRoot}/static/chat/icons.js`, 'utf8');

function fixtureHtml() {
  return `<!doctype html>
    <html data-theme="light"><head><meta charset="utf-8"><style>
      * { box-sizing: border-box; }
      html, body { margin: 0; min-height: 100%; background: #e9e9e9; }
      body { min-height: 100dvh; font-family: system-ui, sans-serif; }
      ${tokens}
      ${css}
      ${materialFinish}
    </style></head><body>
      <button id="attention-trigger" type="button" style="position:fixed;left:-10000px;">Open notification</button>
      <script>
        window.currentSessionId = 'foreground';
        window.ragentT = (key) => ({
          'attention.session': '会话',
          'attention.permission.title': '权限需要审批',
          'attention.detail.proposed': '提议',
          'attention.detail.command': '命令',
          'attention.detail.cwd': '工作目录',
          'attention.detail.permissions': '权限范围',
          'attention.action.approve': '批准',
          'attention.action.deny': '拒绝',
          'attention.action.execute': '执行',
          'attention.action.submit': '提交',
          'attention.action.open': '打开会话',
          'attention.action.detail': '详情',
          'attention.action.dismiss': '关闭通知',
          'attention.approval.title': '需要你的确认',
          'attention.question.title': '需要你的回答',
          'attention.plan.title': '需要确认计划',
          'attention.completion.title': '运行已结束',
          'attention.danger.privileged': '受保护操作',
          'attention.danger.delete': '删除操作',
          'approval.customAnswer.placeholder': '输入其他回复…',
          'approval.customAnswer.label': '自定义回复',
          'attention.question.optrow.expand': '展开全部选项',
          'attention.question.optrow.collapse': '收起选项',
          'attention.question.answerWith': '以此选项回答：{label}',
        }[key] || key);
        window.getChatStoreSession = (id) => ({ id, name: '月度报告整理' });
      </script>
    </body></html>`;
}

let browser;
try {
  browser = await chromium.launch({ headless: true });
} catch {
  // Machines without the downloaded Playwright build still render the fixture
  // through the system Chrome channel.
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
}
try {
  const viewports = [
    { name: 'mobile-narrow', width: 360, height: 800 },
    { name: 'mobile', width: 390, height: 844 },
    { name: 'mobile-wide', width: 430, height: 932 },
    { name: 'desktop', width: 1024, height: 768 },
    { name: 'desktop-wide', width: 1440, height: 900 },
  ];
  for (const viewport of viewports) {
    for (const theme of ['light', 'dark']) {
    const label = `${viewport.name}/${theme}`;
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
    await page.emulateMedia({ colorScheme: theme });
    await page.setContent(fixtureHtml(), { waitUntil: 'load' });
    await page.addScriptTag({ content: icons });
    await page.addScriptTag({ content: source });
    await page.locator('#attention-trigger').focus();
    await page.evaluate((selectedTheme) => {
      document.documentElement.dataset.theme = selectedTheme;
      window.RagentAttentionPopup.onRealtimeEvents('background', [{
        type: 'approval_request',
        approvalId: `fixture-${selectedTheme}`,
        kind: 'permission',
        status: 'pending',
        reason: '整理本月报表并写入归档目录。',
        command: 'node scripts/very-long-report-cleanup-command-name.mjs --input /workspaces/finance/reports/2026-08 --output /workspaces/finance/archive/2026-08',
        cwd: '/workspaces/finance/reports/2026-08',
        permissions: { read: ['/workspaces/finance/reports'], write: ['/workspaces/finance/archive'] },
      }]);
    }, theme);

    const card = page.locator('.oneui-notification');
    await card.waitFor();
    await page.waitForTimeout(380);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'attention-trigger', `${label}: notification keeps the user's current keyboard focus`);
    const collapsedHeight = await card.evaluate((node) => Math.round(node.getBoundingClientRect().height));
    assert.ok(collapsedHeight >= 120 && collapsedHeight <= 180, `${label}: brief card stays near 15vh (${collapsedHeight}px)`);
    assert.equal(await card.locator('.oneui-notification__details').evaluate((node) => getComputedStyle(node).display), 'none', `${label}: details are hidden initially`);
    assert.equal(await card.locator('.oneui-notification__title').textContent(), '整理本月报表并写入归档目录。', `${label}: title is the human action`);
    assert.equal(await card.locator('.oneui-notification__session').isVisible(), true, `${label}: brief state keeps the source session visible`);
    const disclosure = card.locator('.oneui-notification__disclosure');
    assert.equal(await disclosure.count(), 1, `${label}: brief state has one right-edge disclosure chevron`);
    assert.equal(await disclosure.evaluate((node) => getComputedStyle(node).transform), 'matrix(1, 0, 0, 1, 0, 0)', `${label}: collapsed chevron faces right`);
    const close = card.locator('.oneui-notification__close');
    assert.equal(await close.count(), 1, `${label}: notification has one explicit close affordance`);
    assert.equal(await close.isVisible(), viewport.width >= 768, `${label}: close affordance is desktop-only`);
    assert.equal(await card.locator('.oneui-notification__action').count(), 3, `${label}: brief state has decision rail plus the details action`);
    const primaryAction = card.locator('.oneui-notification__action').first();
    assert.ok(await primaryAction.evaluate((node) => node.getBoundingClientRect().height >= 48), `${label}: notification actions keep the shared touch height`);
    assert.equal(await card.evaluate((node) => getComputedStyle(node).borderTopLeftRadius), '20px', `${label}: brief notification uses the shared chat control shape`);
    assert.equal(await primaryAction.evaluate((node) => getComputedStyle(node).borderTopLeftRadius), '999px', `${label}: decision action uses the M3 full button shape`);
    const initialBox = await card.boundingBox();
    const expectedWidth = Math.min(520, viewport.width - 24);
    assert.ok(initialBox && Math.abs(initialBox.width - expectedWidth) <= 1, `${label}: notification width respects the responsive M3 layout rail`);
    assert.equal(await card.locator('.attention-popup, .attention-popup__icon').count(), 0, `${label}: retired notification DOM is absent`);

    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.classList?.contains('oneui-notification')), true, `${label}: keyboard users first reach the disclosure surface through normal tab order`);
    assert.equal(await card.evaluate((node) => getComputedStyle(node).outlineStyle), 'solid', `${label}: disclosure surface has a visible focus indicator`);
    await page.keyboard.press('Tab');
    if (viewport.width >= 768) {
      assert.equal(await page.evaluate(() => document.activeElement?.classList?.contains('oneui-notification__close')), true, `${label}: desktop keyboard users can reach the close affordance`);
      await page.keyboard.press('Tab');
    }
    assert.equal(await page.evaluate(() => document.activeElement?.classList?.contains('oneui-notification__action')), true, `${label}: keyboard users then reach the first action through normal tab order`);
    assert.equal(await primaryAction.evaluate((node) => getComputedStyle(node).outlineStyle), 'solid', `${label}: keyboard focus has a visible focus indicator`);
    await page.locator('#attention-trigger').focus();

    const box = await card.boundingBox();
    assert.ok(box, `${label}: brief card has gesture geometry`);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 28, { steps: 3 });
    assert.notEqual(await card.evaluate((node) => getComputedStyle(node).transform), 'none', `${label}: card follows the pointer`);
    await page.mouse.up();
    await page.waitForTimeout(360);
    assert.equal(await card.getAttribute('aria-expanded'), 'false', `${label}: canceled swipe does not expand`);
    await page.screenshot({ path: `${outputDir}/oneui-${viewport.name}-${theme}-brief.png`, fullPage: false });

    await card.locator('.oneui-notification__summary').click();
    assert.equal(await card.getAttribute('aria-expanded'), 'true', `${label}: tap enters detailed state`);
    assert.notEqual(await card.locator('.oneui-notification__details').evaluate((node) => getComputedStyle(node).display), 'none', `${label}: details are disclosed on demand`);
    await page.waitForTimeout(260);
    assert.equal(await card.locator('.oneui-notification__title').isVisible(), true, `${label}: expanded state preserves its summary title`);
    assert.equal(await disclosure.evaluate((node) => getComputedStyle(node).transform), 'matrix(0, 1, -1, 0, 0, 0)', `${label}: expanded chevron turns down`);
    const expanded = await card.boundingBox();
    assert.ok(expanded && expanded.y >= 0 && expanded.y + expanded.height <= viewport.height, `${label}: detailed card stays in viewport`);
    await page.screenshot({ path: `${outputDir}/oneui-${viewport.name}-${theme}-detailed.png`, fullPage: false });

    await page.keyboard.press('Escape');
    await page.waitForTimeout(320);
    assert.equal(await page.locator('#attentionPopupHost').getAttribute('hidden'), '', `${label}: Escape dismisses the notification`);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'attention-trigger', `${label}: notification dismissal restores focus`);

    await page.evaluate(() => {
      window.RagentAttentionPopup._reset();
      window.RagentAttentionPopup.onSessionsApplied(
        new Map([['background', { id: 'background', activity: { run: { state: 'running' } } }]]),
        [{ id: 'background', activity: { run: { state: 'completed' } }, unreadAt: '2026-08-08T00:00:00Z', workflowState: 'done' }],
      );
    });
    const completion = page.locator('.oneui-notification--completion');
    await completion.waitFor();
    await page.waitForTimeout(380);
    const completionBox = await completion.boundingBox();
    const open = await completion.locator('.oneui-notification__action--secondary').boundingBox();
    assert.ok(completionBox && open && open.width < completionBox.width * 0.7, `${label}: completion action stays compact`);
    assert.equal(await completion.locator('.oneui-notification__brief, .oneui-notification__message').count(), 0, `${label}: completion has no duplicate generic result copy`);
    assert.equal(await completion.locator('.oneui-notification__title').innerText(), '运行已结束', `${label}: completion keeps the result state`);
    assert.equal(await completion.locator('.oneui-notification__session').count(), 1, `${label}: completion keeps one source-session row`);
    assert.equal(await completion.locator('.oneui-notification__session-value').innerText(), '月度报告整理', `${label}: completion identifies the source session`);
    assert.equal(await completion.getAttribute('role'), 'status', `${label}: completion remains a non-modal status notification`);
    assert.equal(await completion.getAttribute('tabindex'), '-1', `${label}: completion card is not an inert keyboard stop`);
    assert.equal(await completion.locator('.oneui-notification__disclosure').count(), 0, `${label}: completion has no disclosure affordance because it cannot expand`);
    assert.equal(await page.locator('#attentionPopupHost').getAttribute('aria-live'), 'polite', `${label}: completion announcement is polite`);
    await completion.screenshot({ path: `${outputDir}/oneui-${viewport.name}-${theme}-completion.png` });

    await page.evaluate(() => {
      window.RagentAttentionPopup._reset();
      window.RagentAttentionPopup.onRealtimeEvents('background', [{
        type: 'privileged_batch_request',
        batchId: `batch-${document.documentElement.dataset.theme}`,
        other: [{ opId: 'protected-1', description: '读取项目归档索引' }],
        delete: [{ opId: 'delete-1', description: '删除临时构建缓存' }],
      }]);
    });
    const batch = page.locator('.oneui-notification--danger');
    await batch.waitFor();
    assert.equal(await batch.locator('.oneui-notification__footer').count(), 1, `${label}: collapsed danger batch keeps the details action footer`);
    assert.equal(await batch.locator('.oneui-notification__batch-actions .oneui-notification__action:visible').count(), 4, `${label}: collapsed danger batch keeps both category decision pairs visible in the footer`);
    await batch.locator('.oneui-notification__summary').click();
    await page.waitForTimeout(220);
    assert.equal(await batch.locator('.oneui-notification__batch-actions').count(), 2, `${label}: expanded danger batch keeps each decision pair with its category`);
    assert.equal(await batch.locator('.oneui-notification__batch-actions .oneui-notification__action').count(), 4, `${label}: expanded danger batch exposes two category-specific decision pairs`);
    await batch.screenshot({ path: `${outputDir}/oneui-${viewport.name}-${theme}-batch-detailed.png` });
    await page.evaluate(() => {
      window.RagentDecisionSheet = {
        submitPrivilegedBatchCategory: async () => true,
      };
    });
    await batch.locator('.oneui-notification__batch-footer-group[data-category="other"] .oneui-notification__action--primary').click();
    await page.waitForTimeout(120);
    assert.equal(await batch.locator('.oneui-notification__batch[data-category="other"] .oneui-notification__batch-actions').count(), 0, `${label}: a resolved category no longer repeats its decision pair`);
    assert.equal(await batch.locator('.oneui-notification__batch-footer-group[data-category="delete"] .oneui-notification__batch-actions').count(), 1, `${label}: remaining category stays actionable after the first batch decision`);
    await page.evaluate(() => {
      window.RagentAttentionPopup._reset();
      window.RagentAttentionPopup.onRealtimeEvents('background', [{
        type: 'approval_request',
        approvalId: `question-${document.documentElement.dataset.theme}`,
        kind: 'question',
        status: 'pending',
        runId: 'run-question',
        questions: [{
          question: '迁移数据库需要停机 10 分钟，现在开始吗？',
          options: [{ label: '现在迁移' }, { label: '午夜窗口再迁移' }, { label: '先做一次备份演练' }],
        }],
      }]);
    });
    const question = page.locator('.oneui-notification--question');
    await question.waitFor();
    await page.waitForTimeout(380);
    assert.equal(await question.locator('.oneui-notification__title').innerText(), '迁移数据库需要停机 10 分钟，现在开始吗？', `${label}: ask-user title is the question itself`);
    assert.equal(await question.locator('.oneui-notification__optrow').isVisible(), true, `${label}: collapsed ask-user discloses the first option`);
    assert.equal(await question.locator('.oneui-notification__action--primary').count(), 0, `${label}: ask-user has no generic approve button`);
    assert.equal(await question.locator('.oneui-notification__answer-input').isVisible(), true, `${label}: the answer rail is visible while collapsed`);
    assert.ok(await question.locator('.oneui-notification__answer-deny').evaluate((node) => node.getBoundingClientRect().height >= 44), `${label}: the compact deny keeps the touch minimum`);
    await question.screenshot({ path: `${outputDir}/oneui-${viewport.name}-${theme}-question-brief.png` });
    await question.locator('.oneui-notification__optrow').click();
    await page.waitForTimeout(260);
    assert.equal(await question.locator('.oneui-notification__choice').count(), 3, `${label}: the expanded card discloses every option`);
    assert.equal(
      await question.locator('.oneui-notification__optrow .oneui-notification__disclosure').evaluate((node) => getComputedStyle(node).transform),
      'matrix(0, 1, -1, 0, 0, 0)',
      `${label}: the option-row chevron turns down when expanded`,
    );
    await question.screenshot({ path: `${outputDir}/oneui-${viewport.name}-${theme}-question-detailed.png` });
    await page.evaluate(() => {
      window.__answers = [];
      window.dispatchAction = async (action) => { window.__answers.push(action); return true; };
    });
    await question.locator('.oneui-notification__choice').nth(1).click();
    await page.waitForTimeout(420);
    const answers = await page.evaluate(() => window.__answers);
    assert.equal(answers.length, 1, `${label}: tapping an option submits exactly one decision`);
    assert.deepEqual(answers[0].choices, [1], `${label}: the tapped option is the submitted choice`);

    await page.close();
    }
  }
} finally {
  await browser.close();
}

console.log(`test-chat-attention-popup-visual: ok (${outputDir})`);
