#!/usr/bin/env node
// Send-state visual fixtures: the four message-transport states a user turn
// passes through, rendered with real CSS tokens and the real markup classes.
// Screenshots every state and asserts numerically:
//   sending      — the optimistic echo bubble carries .msg-user-local-echo +
//                  .msg-pending while keeping committed bubble contrast so a
//                  slow transport does not visually turn it into a progress meter
//   sent         — the committed bubble carries NO residue: no local-echo
//                  class, no .msg-pending, no composer-pending status row
//                  (this is the "already sent, still a bubble?" contract)
//   queued       — the follow-up queue block sits above the input stack:
//                  one compact summary row is visible by default, details
//                  expand on demand, and long text ellipsizes
//   failed-refill — the sent bubble stays ordinary while a small failed status
//                  rail owns retry/edit/discard actions below it
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '@playwright/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const requestedOutputDir = String(process.env.RAGENT_VISUAL_OUTPUT_DIR || '').trim();
const outputDir = requestedOutputDir || mkdtempSync(join(tmpdir(), 'ragent-send-states-visual-'));
if (requestedOutputDir) mkdirSync(outputDir, { recursive: true });

const styles = [
  'static/chat/chat-base.css',
  'static/chat/chat-input.css',
  'static/chat/chat-messages.css',
  'static/chat/chat-responsive.css',
].map((path) => readFileSync(join(repoRoot, path), 'utf8')).join('\n');

const copyIcon = '<svg class="rl-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
const editIcon = '<svg class="rl-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>';

function metaButton(action, label) {
  const icon = action === 'copy' ? copyIcon : editIcon;
  return `<button type="button" class="msg-action-btn msg-action-btn--${action}" title="${label}" aria-label="${label}" data-action="${action}">${icon}</button>`;
}

function userMetaHtml() {
  return `<div class="msg-meta"><div class="msg-actions">${metaButton('copy', '复制')}${metaButton('edit', '编辑并重发')}</div></div>`;
}

const LONG_QUEUED_TEXT = '继续处理这个任务，然后汇总结果；这是一条足够长以触发省略号截断的排队消息文本。';

function queuedPanelHtml() {
  const actions = `
        <div class="queued-steer-actions">
          <button type="button" class="queued-steer-action queued-steer-action--steer" title="转向" aria-label="转向" data-action="steer"><span class="queued-steer-action-label">转向</span></button>
          <button type="button" class="queued-steer-action queued-steer-action--delete" title="删除" aria-label="删除" data-action="delete"></button>
          <button type="button" class="queued-steer-action queued-steer-action--more" title="更多" aria-label="更多" data-action="more" aria-haspopup="menu" aria-expanded="false"></button>
        </div>`;
  const row = (active, text) => `
        <div class="queued-steer-row${active ? ' queued-steer-row--active' : ' queued-steer-row--waiting'}">
          <div class="queued-steer-content">
            <span class="queued-steer-leading-icon" aria-hidden="true"></span>
            <div class="queued-steer-text">${text}</div>
          </div>
          ${active ? actions : ''}
        </div>`;
  return `
        <div class="queued-panel visible" id="queuedPanel">
          <button type="button" class="queued-summary" aria-expanded="false">
            <span class="queued-summary__icon" aria-hidden="true"></span>
            <span class="queued-summary__label">已排队 2 条后续消息</span>
            <span class="queued-summary__chevron" aria-hidden="true"></span>
          </button>
          ${row(true, '先处理这条排队消息')}
          ${row(false, LONG_QUEUED_TEXT)}
        </div>`;
}

function messageBlockHtml(state) {
  if (state === 'sending') {
    return `
        <div class="msg-user msg-user-local-echo">
          <div class="msg-user-bubble msg-pending"><span>这条消息正在发送中。</span></div>
        </div>`;
  }
  if (state === 'sent') {
    return `
        <div class="msg-user">
          <div class="msg-user-bubble"><span>这条消息已经发送成功。</span>${userMetaHtml()}</div>
        </div>`;
  }
  if (state === 'failed-refill') {
    return `
        <div class="msg-user msg-user--failed">
          <div class="msg-user-bubble msg-failed visual-failed-bubble">
            <span>继续处理这个任务，然后汇总结果。</span>
          </div>
          <div class="msg-failed-status"><span class="msg-failed-status-dot" aria-hidden="true"></span><span class="msg-failed-status-text">发送失败</span></div>
          <div class="msg-failed-actions">
            <button type="button" class="msg-retry-btn">重试</button>
            <button type="button" class="msg-edit-btn">编辑并重发</button>
            <button type="button" class="msg-discard-btn">丢弃</button>
          </div>
        </div>`;
  }
  return '';
}

function fixtureHtml(state) {
  const queuedHtml = state === 'queued' ? queuedPanelHtml() : '<div class="queued-panel" id="queuedPanel"></div>';
  const refillValue = state === 'failed-refill' ? '继续处理这个任务，然后汇总结果。' : '';
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>${styles}</style>
  <style>
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body { margin: 0; display: flex; background: var(--bg); color: var(--text); font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    .visual-sidebar { width: 320px; flex-shrink: 0; border-right: 1px solid var(--border); background: var(--bg); }
    .visual-chat { display: grid; grid-template-rows: minmax(0, 1fr) auto; height: 100%; flex: 1; min-width: 0; }
    #messages { overflow-y: auto; }
    #messagesInner { padding: 16px 12px; display: grid; gap: 18px; }
    .visual-assistant { max-width: 80%; padding: 11px 16px; border-radius: 20px; border-bottom-left-radius: 6px; background: var(--surface-hover); color: var(--text); font-size: 15px; line-height: 1.55; }
    @media (max-width: 720px) {
      .visual-sidebar { display: none; }
    }
  </style>
</head>
<body>
  <aside class="visual-sidebar" aria-label="Sessions"></aside>
  <div class="visual-chat">
    <div class="messages" id="messages">
      <div class="messages-inner" id="messagesInner">
        <div class="visual-assistant">抱歉，刚才的命令执行报错了。<br>已回退相关修改，可以继续下一步。</div>
        ${messageBlockHtml(state)}
      </div>
    </div>
    <div class="input-area" id="inputArea">
      <div class="input-stack">
        ${queuedHtml}
        <div class="input-wrapper">
          <div class="input-row">
            <textarea id="msgInput" placeholder="发送消息" disabled>${refillValue}</textarea>
          </div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

// Parse an alpha channel out of any computed-color serialization the browser
// emits (rgba() for plain values, color(srgb r g b / 0.82) for color-mix).
function parseAlpha(color) {
  if (!color) return 1;
  const rgba = color.match(/rgba?\(([^)]+)\)/);
  if (rgba) {
    const parts = rgba[1].split(',').map((part) => parseFloat(part));
    return parts.length >= 4 ? parts[3] : 1;
  }
  const fn = color.match(/color\([^)]*\)/);
  if (fn) {
    const alpha = fn[0].match(/\/\s*([\d.]+)\)?$/);
    if (alpha) return parseFloat(alpha[1]);
  }
  return 1;
}

const scenarios = [
  { name: 'mobile-dark', width: 390, height: 844, colorScheme: 'dark' },
  { name: 'mobile-light', width: 390, height: 844, colorScheme: 'light' },
  { name: 'desktop-dark', width: 1440, height: 900, colorScheme: 'dark' },
  { name: 'desktop-light', width: 1440, height: 900, colorScheme: 'light' },
  // Narrowest supported column: failed-recovery action labels once wrapped
  // inside the buttons here ("重试" -> "重/试") — the regression guard.
  { name: 'narrow-320', width: 320, height: 700, colorScheme: 'light' },
];

const browser = await chromium.launch({ headless: true });
try {
  for (const state of ['sending', 'sent', 'queued', 'failed-refill']) {
    for (const scenario of scenarios) {
      const page = await browser.newPage({
        viewport: { width: scenario.width, height: scenario.height },
        colorScheme: scenario.colorScheme,
      });
      await page.setContent(fixtureHtml(state), { waitUntil: 'load' });
      // Echo fades in (0.2s) and queued rows slide up (--motion-base) —
      // capture after both settle.
      await page.waitForTimeout(350);
      await page.screenshot({ path: join(outputDir, `${state}-${scenario.name}.png`) });

      const metrics = await page.evaluate((currentState) => {
        // evaluate() runs in the page realm — module-scope helpers are not
        // visible here, so alpha parsing is inlined.
        const parseAlpha = (color) => {
          if (!color) return 1;
          const rgba = color.match(/rgba?\(([^)]+)\)/);
          if (rgba) {
            const parts = rgba[1].split(',').map((part) => parseFloat(part));
            return parts.length >= 4 ? parts[3] : 1;
          }
          const fn = color.match(/color\([^)]*\)/);
          if (fn) {
            const alpha = fn[0].match(/\/\s*([\d.]+)\)?$/);
            if (alpha) return parseFloat(alpha[1]);
          }
          return 1;
        };
        const q = (selector) => document.querySelector(selector);
        const qa = (selector) => Array.from(document.querySelectorAll(selector));
        const bubble = q('.msg-user .msg-user-bubble');
        const echo = q('.msg-user-local-echo');
        const pendingClass = qa('.msg-pending').length;
        const statusRows = qa('.msg-user-status').length;
        const panel = q('#queuedPanel');
        const rows = qa('.queued-steer-row');
        const summary = q('.queued-summary');
        const wrapper = q('.input-wrapper');
        const input = q('#msgInput');
        const failedWrap = q('.msg-user--failed');
        const failedActions = q('.msg-failed-actions');
        const failedStatus = q('.msg-failed-status');
        const style = (element, prop) => element ? getComputedStyle(element)[prop] : '';
        const rect = (element) => element ? element.getBoundingClientRect() : null;
        const visibleRows = rows.filter((row) => rect(row).height > 0);
        const stageBackgrounds = [];
        if (currentState === 'sending' && bubble) {
          const echoWrap = bubble.closest('.msg-user');
          for (const stage of ['sending', 'checking', 'processing']) {
            if (echoWrap) echoWrap.dataset.sendStage = stage;
            stageBackgrounds.push(getComputedStyle(bubble).backgroundColor);
          }
        }
        const restoreCollapsed = panel && !panel.classList.contains('is-expanded');
        if (restoreCollapsed) panel.classList.add('is-expanded');
        const ellipsized = rows.map((row) => {
          const text = row.querySelector('.queued-steer-text');
          if (!text) return null;
          const computed = getComputedStyle(text);
          return {
            overflow: computed.overflow,
            textOverflow: computed.textOverflow,
            whiteSpace: computed.whiteSpace,
            clipped: text.scrollWidth > text.clientWidth,
          };
        });
        if (restoreCollapsed) panel.classList.remove('is-expanded');
        return {
          echoPresent: !!echo,
          pendingCount: pendingClass,
          statusRowCount: statusRows,
          bubbleAlpha: bubble ? parseAlpha(style(bubble, 'backgroundColor')) : 1,
          stageBackgrounds,
          panelVisible: panel?.classList.contains('visible') || false,
          summaryPresent: !!summary,
          summaryExpanded: summary?.getAttribute('aria-expanded') || null,
          summaryHeight: summary ? rect(summary).height : 0,
          visibleRowCount: visibleRows.length,
          rowHeights: rows.map((row) => rect(row).height),
          rowClasses: rows.map((row) => row.className),
          panelBottom: rect(panel)?.bottom ?? null,
          wrapperTop: rect(wrapper)?.top ?? null,
          wrapperBottom: rect(wrapper)?.bottom ?? null,
          stackBottom: rect(q('.input-stack'))?.bottom ?? null,
          ellipsized,
          actionHeights: qa('.queued-steer-action').map((button) => rect(button).height),
          failedBorder: style(bubble, 'borderColor'),
          failedWrapClass: failedWrap?.classList.contains('msg-user--failed') || false,
          failedStatus: !!failedStatus,
          actionsOutsideBubble: !!failedActions && !!bubble && !bubble.contains(failedActions),
          retryButtons: qa('.msg-failed-actions button').length,
          refillValue: input ? input.value : null,
          actionLabelLines: qa('.msg-failed-actions button').map((button) => {
            const range = document.createRange();
            range.selectNodeContents(button);
            const tops = new Set();
            for (const rect of range.getClientRects()) tops.add(Math.round(rect.top));
            return tops.size;
          }),
          hOverflow: document.documentElement.scrollWidth > window.innerWidth,
        };
      }, state);

      const label = `${state}@${scenario.name}`;
      assert.equal(metrics.hOverflow, false, `${label}: nothing may overflow the viewport width`);

      if (state === 'sending') {
        assert.equal(metrics.echoPresent, true, `${label}: echo bubble must be present`);
        assert.equal(metrics.pendingCount, 1, `${label}: echo bubble carries .msg-pending`);
        assert.ok(metrics.bubbleAlpha >= 0.999, `${label}: echo bubble should keep committed contrast (got ${metrics.bubbleAlpha})`);
        assert.equal(new Set(metrics.stageBackgrounds).size, 1, `${label}: send stages should keep one stable bubble surface`);
        assert.equal(metrics.statusRowCount, 0, `${label}: transport latency should not add a layout-changing status row`);
      } else if (state === 'sent') {
        assert.equal(metrics.echoPresent, false, `${label}: committed bubble must have NO local-echo residue`);
        assert.equal(metrics.pendingCount, 0, `${label}: committed bubble must have NO .msg-pending residue`);
        assert.equal(metrics.statusRowCount, 0, `${label}: committed bubble must have NO composer status row`);
        assert.ok(metrics.bubbleAlpha >= 0.999, `${label}: committed bubble must be fully opaque (got ${metrics.bubbleAlpha})`);
      } else if (state === 'queued') {
        assert.equal(metrics.panelVisible, true, `${label}: queued panel must be visible`);
        assert.equal(metrics.summaryPresent, true, `${label}: queued panel must expose a compact summary row`);
        assert.equal(metrics.summaryExpanded, 'false', `${label}: queued details start collapsed`);
        assert.ok(metrics.summaryHeight >= 44, `${label}: summary row must be >= 44px tall (got ${metrics.summaryHeight})`);
        assert.equal(metrics.visibleRowCount, 1, `${label}: only the active queue row is visible before expansion`);
        for (const [index, height] of metrics.rowHeights.entries()) {
          if (height === 0) continue;
          assert.ok(height >= 44, `${label}: visible queued row ${index} must be >= 44px tall (got ${height})`);
        }
        assert.ok(metrics.rowClasses[0].includes('queued-steer-row--active'), `${label}: first row is the active steerable row`);
        assert.ok(metrics.rowClasses[1].includes('queued-steer-row--waiting'), `${label}: later rows are waiting rows`);
        for (const [index, ellipsis] of metrics.ellipsized.entries()) {
          assert.equal(ellipsis.overflow, 'hidden', `${label}: queued text row ${index} clips overflow`);
          assert.equal(ellipsis.textOverflow, 'ellipsis', `${label}: queued text row ${index} uses ellipsis`);
          assert.equal(ellipsis.whiteSpace, 'nowrap', `${label}: queued text row ${index} must never wrap`);
        }
        // Ellipsis is a fallback, not a mandate: on a wide desktop column the
        // long label legitimately fits inline. Only the narrowest viewports
        // must actually truncate it.
        if (scenario.width <= 430) {
          assert.equal(metrics.ellipsized[1].clipped, true, `${label}: the long queued label must truncate on ${scenario.width}px`);
        }
        // Steer actions are auxiliary inline controls: 28px desktop (CSS
        // base) and 26px under the <=720px responsive override — both
        // deliberate DESIGN.md "auxiliary scale", not primary touch targets.
        const minActionHeight = scenario.width <= 720 ? 26 : 28;
        for (const height of metrics.actionHeights) {
          assert.ok(
            height >= minActionHeight,
            `${label}: steer action buttons must be >= ${minActionHeight}px tall on ${scenario.width}px (got ${height})`,
          );
        }
        // The panel floats above the composer: its bottom edge must sit
        // above the input wrapper with the --chat-floating-status-gap (8px)
        // between them, and never overlap the composer.
        assert.ok(metrics.panelBottom !== null && metrics.wrapperTop !== null, `${label}: panel and wrapper must both render`);
        assert.ok(metrics.panelBottom <= metrics.wrapperTop - 4, `${label}: queued panel must float above the composer without overlap`);
        assert.ok(metrics.wrapperBottom <= (metrics.stackBottom || 0) + 1, `${label}: composer must stay inside the input stack`);
      } else if (state === 'failed-refill') {
        assert.equal(metrics.failedWrapClass, true, `${label}: failed recovery must mark the message block`);
        assert.equal(metrics.failedStatus, true, `${label}: failed recovery must show a separate status line`);
        assert.equal(metrics.actionsOutsideBubble, true, `${label}: recovery actions must sit outside the sent bubble`);
        assert.equal(metrics.failedBorder, 'rgba(0, 0, 0, 0)', `${label}: sent bubble must not become an orange error card`);
        assert.equal(metrics.retryButtons, 3, `${label}: retry/edit/discard actions must be present`);
        assert.ok(
          metrics.refillValue === '继续处理这个任务，然后汇总结果。',
          `${label}: composer must be refilled with the failed draft (got ${JSON.stringify(metrics.refillValue)})`,
        );
        // Recovery labels must never wrap inside a button (a 320px column
        // once split "重试" across two lines); the actions strip wraps whole
        // buttons instead.
        for (const [index, lines] of metrics.actionLabelLines.entries()) {
          assert.equal(lines, 1, `${label}: recovery action ${index} label must stay on one line (got ${lines})`);
        }
      }

      await page.close();
    }
  }
} finally {
  if (!requestedOutputDir) rmSync(outputDir, { recursive: true, force: true });
  await browser.close();
}

console.log(`ok — send-state visual fixtures (sending/sent/queued/failed-refill x ${scenarios.length} viewports)`);
if (requestedOutputDir) console.log(`output: ${outputDir}`);
