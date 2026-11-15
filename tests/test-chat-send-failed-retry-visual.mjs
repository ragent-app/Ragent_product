#!/usr/bin/env node
// Failed-send recovery UI visual fixture: the ordinary sent bubble plus a
// separate failed status/action rail, rendered with real CSS tokens and the
// real markup classes. Screenshots every state and asserts numerically:
//   - three buttons, each >= 44px tall (touch-friendly recovery actions)
//   - actions sit outside the bubble and remain right-aligned
//   - retry uses the accent action color (clear contrast vs the bubble)
//   - the sent bubble does not become an orange error card
//   - nothing overflows the message column
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '@playwright/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const requestedOutputDir = String(process.env.RAGENT_VISUAL_OUTPUT_DIR || '').trim();
const outputDir = requestedOutputDir || mkdtempSync(join(tmpdir(), 'ragent-send-failed-visual-'));
if (requestedOutputDir) mkdirSync(outputDir, { recursive: true });

const styles = [
  'static/chat/chat-base.css',
  'static/chat/chat-input.css',
  'static/chat/chat-messages.css',
  'static/chat/chat-responsive.css',
  'static/chat/chat-glass.css',
].map((path) => readFileSync(join(repoRoot, path), 'utf8')).join('\n');

function fixtureHtml() {
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
    .visual-assistant strong { color: var(--text); }
    .input-stack { height: 64px; border-top: 1px solid var(--border); background: var(--bg-secondary); border-radius: 14px 14px 0 0; }
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
        </div>
      </div>
    </div>
    <div class="input-area" id="inputArea">
      <div class="input-stack"></div>
    </div>
  </div>
</body>
</html>`;
}

const scenarios = [
  { name: 'mobile-dark', width: 390, height: 844, colorScheme: 'dark' },
  { name: 'mobile-light', width: 390, height: 844, colorScheme: 'light' },
  { name: 'desktop-dark', width: 1440, height: 900, colorScheme: 'dark' },
  { name: 'desktop-light', width: 1440, height: 900, colorScheme: 'light' },
  // Narrowest supported column: labels once wrapped inside the buttons here
  // ("重试" -> "重/试") — the scrollHeight check misses it (no vertical
  // overflow), so a rendered-line probe is the guard.
  { name: 'narrow-320', width: 320, height: 700, colorScheme: 'light' },
];

const browser = await chromium.launch({ headless: true });
try {
  for (const scenario of scenarios) {
    const page = await browser.newPage({
      viewport: { width: scenario.width, height: scenario.height },
      colorScheme: scenario.colorScheme,
    });
    await page.setContent(fixtureHtml(), { waitUntil: 'load' });
    // .msg-user has an entrance fadeIn (0.2s) — capture after it settles,
    // otherwise the bubble is screenshotted at opacity ~0.
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(outputDir, `${scenario.name}.png`) });

    const metrics = await page.evaluate(() => {
      const bubble = document.querySelector('.msg-user-bubble.msg-failed');
      const wrap = document.querySelector('.msg-user--failed');
      const actions = wrap.querySelector('.msg-failed-actions');
      const status = wrap.querySelector('.msg-failed-status');
      const buttons = Array.from(actions.querySelectorAll('button'));
      const bubbleRect = bubble.getBoundingClientRect();
      const actionRects = buttons.map((button) => button.getBoundingClientRect());
      const scrollFits = buttons.map((button) => button.scrollHeight <= button.clientHeight + 1);
      const style = getComputedStyle(bubble);
      const retryStyle = getComputedStyle(buttons[0]);
      const editStyle = getComputedStyle(buttons[1]);
      const inner = document.getElementById('messagesInner');
      const innerRect = inner.getBoundingClientRect();
      return {
        bubbleWidth: bubbleRect.width,
        bubbleMax: innerRect.width * 0.8,
        bubbleRight: bubbleRect.right,
        innerRight: innerRect.right,
        bubbleHeight: bubbleRect.height,
        actionsOutsideBubble: !bubble.contains(actions),
        statusPresent: !!status,
        wrapClass: wrap.classList.contains('msg-user--failed'),
        actionsWidth: actions.getBoundingClientRect().width,
        actionsRight: actions.getBoundingClientRect().right,
        borderColor: style.borderColor,
        bubbleBg: style.backgroundColor,
        retryBg: retryStyle.backgroundColor,
        retryColor: retryStyle.color,
        editBorder: editStyle.borderColor,
        editBorderWidth: editStyle.borderTopWidth,
        heights: actionRects.map((rect) => rect.height),
        widths: actionRects.map((rect) => rect.width),
        gaps: actionRects.slice(1).map((rect, index) => rect.left - actionRects[index].right),
        rightAligned: actions.getBoundingClientRect().right - bubbleRect.right,
        scrollFits,
        actionTops: buttons.map((button) => Math.round(button.getBoundingClientRect().top)),
        labelLines: buttons.map((button) => {
          const range = document.createRange();
          range.selectNodeContents(button);
          const tops = new Set();
          for (const rect of range.getClientRects()) tops.add(Math.round(rect.top));
          return tops.size;
        }),
      };
    });
    assert.ok(
      metrics.scrollFits.every(Boolean),
      `${scenario.name}: button labels must not overflow (heights ${metrics.heights.join('/')})`,
    );
    for (const [index, lines] of metrics.labelLines.entries()) {
      assert.equal(
        lines,
        1,
        `${scenario.name}: action button ${index} label must stay on one line (got ${lines} — row must wrap, not the label)`,
      );
    }

    for (let index = 0; index < 3; index += 1) {
      assert.ok(
        metrics.heights[index] >= 44,
        `${scenario.name}: action button ${index} must be >= 44px tall (got ${metrics.heights[index]})`,
      );
      assert.ok(
        metrics.widths[index] >= 48,
        `${scenario.name}: action button ${index} must be wide enough to read (got ${metrics.widths[index]})`,
      );
    }
    // The actions strip wraps whole buttons onto a second right-aligned line
    // when the column cannot fit them (the 320px viewport; the grid-based
    // fixture also wraps at 390px where the real block layout would not), so
    // horizontal gaps only apply between same-line buttons.
    const actionTops = metrics.actionTops;
    for (let index = 1; index < actionTops.length; index += 1) {
      if (actionTops[index] !== actionTops[index - 1]) continue;
      const gap = metrics.gaps[index - 1];
      assert.ok(Math.abs(gap - 8) <= 1, `${scenario.name}: same-line actions must sit 8px apart (got ${gap})`);
    }
    assert.equal(metrics.wrapClass, true, `${scenario.name}: failed state must mark the message block`);
    assert.equal(metrics.statusPresent, true, `${scenario.name}: failed state must expose a separate status line`);
    assert.equal(metrics.actionsOutsideBubble, true, `${scenario.name}: actions must sit outside the sent bubble`);
    assert.ok(Math.abs(metrics.rightAligned) <= 1, `${scenario.name}: actions must be right-aligned with the message column (got ${metrics.rightAligned})`);
    assert.ok(
      metrics.bubbleWidth <= metrics.bubbleMax + 1,
      `${scenario.name}: bubble must respect the 80% column cap (${metrics.bubbleWidth} vs ${metrics.bubbleMax})`,
    );
    assert.ok(
      metrics.bubbleRight <= metrics.innerRight + 1,
      `${scenario.name}: nothing may overflow the message column`,
    );
    assert.equal(
      metrics.borderColor,
      'rgba(0, 0, 0, 0)',
      `${scenario.name}: the sent bubble must not carry a failed-state border`,
    );
    assert.notEqual(
      metrics.retryBg,
      metrics.retryColor,
      `${scenario.name}: the retry action must contrast against its own label`,
    );
    assert.equal(
      metrics.editBorderWidth,
      '1px',
      `${scenario.name}: the edit action must carry a rendered hairline border (got ${metrics.editBorderWidth})`,
    );
    assert.notEqual(
      metrics.editBorder,
      'rgba(0, 0, 0, 0)',
      `${scenario.name}: the edit action hairline must be a visible color`,
    );

    await page.close();
  }
} finally {
  if (!requestedOutputDir) rmSync(outputDir, { recursive: true, force: true });
  await browser.close();
}

console.log(`ok — failed-send retry/edit/discard visual fixtures (${scenarios.length} states)`);
if (requestedOutputDir) console.log(`output: ${outputDir}`);
