#!/usr/bin/env node
// A1 regenerate visual fixture: the version rail, the hover-revealed meta
// (desktop), the permanent copy + regenerate meta row (mobile), and the
// no-fade committed user bubble (send-time swap), rendered with real CSS
// tokens and the real markup classes. Screenshots every state and asserts
// numerically:
//   - the rail toggle is >= 44px tall (touch target)
//   - exactly the latest reply exposes regenerate; older replies never do
//   - desktop: regenerate is a 24px meta icon, revealed on hover
//   - mobile: regenerate is a permanent 44px meta-row button next to copy
//     (user decision 2026-08-05 — assistant long-press menu removed)
//   - the rail body is hidden when folded and a 2px hairline rule when expanded
//   - the committed user bubble carries no entrance animation
//   - nothing overflows the message column or the viewport
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '@playwright/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const requestedOutputDir = String(process.env.RAGENT_VISUAL_OUTPUT_DIR || '').trim();
const outputDir = requestedOutputDir || mkdtempSync(join(tmpdir(), 'ragent-regenerate-visual-'));
if (requestedOutputDir) mkdirSync(outputDir, { recursive: true });

const styles = [
  'static/chat/chat-base.css',
  'static/chat/chat-input.css',
  'static/chat/chat-messages.css',
  'static/chat/chat-responsive.css',
  'static/chat/chat-m3-tokens.css',
  'static/chat/chat-m3-components.css',
].map((path) => readFileSync(join(repoRoot, path), 'utf8')).join('\n');

const refreshIcon = '<svg class="rl-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>';
const copyIcon = '<svg class="rl-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';

function metaButton(action, label) {
  const icon = action === 'regenerate' ? refreshIcon : copyIcon;
  return `<button type="button" class="msg-action-btn msg-action-btn--${action}" title="${label}" aria-label="${label}" data-action="${action}">${icon}</button>`;
}

function assistantNode(text, { regenerable = false } = {}) {
  // Production DOM carries a regenerate button in every assistant meta; CSS
  // hides it unless the node is `.is-regenerable`. Mirror that so the
  // display assertions are meaningful.
  const wrapClass = `msg-assistant${regenerable ? ' is-regenerable' : ''}`;
  const actions = [metaButton('copy', '复制'), metaButton('regenerate', '重新生成')];
  return `
    <div class="${wrapClass}">
      <div class="msg-assistant-body">${text}</div>
      <div class="msg-meta"><div class="msg-actions">${actions.join('')}</div></div>
    </div>`;
}

function fixtureHtml({ railExpanded = false } = {}) {
  const foldedV1 = assistantNode('第一版回答：按旧方式处理了超时。');
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
        ${assistantNode('较早的一次回答：这个不参与重生成。')}
        <div class="msg-user msg-user--no-fade">
          <div class="msg-user-bubble"><span>重新生成这次回答。</span></div>
        </div>
        <div class="msg-version-rail${railExpanded ? ' is-expanded' : ''}">
          <button type="button" class="msg-version-rail__toggle" aria-expanded="${railExpanded ? 'true' : 'false'}"><svg class="rl-icon msg-version-rail__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg><span class="msg-version-rail__label">旧版本已折叠</span></button>
          <div class="msg-version-rail__body">${foldedV1}</div>
        </div>
        <div class="msg-assistant is-regenerable">
          <div class="msg-assistant-body">第二版回答：改用新的处理方式，超时已消除。</div>
          <div class="msg-meta"><div class="msg-actions">${metaButton('copy', '复制')}${metaButton('regenerate', '重新生成')}</div></div>
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

function collectMetrics() {
  const q = (selector) => document.querySelector(selector);
  const qa = (selector) => Array.from(document.querySelectorAll(selector));
  const style = (element, prop) => getComputedStyle(element)[prop];
  const rect = (element) => element.getBoundingClientRect();

  const latest = q('.msg-assistant.is-regenerable');
  const older = qa('.msg-assistant:not(.is-regenerable)')[0];
  const latestMeta = latest?.querySelector('.msg-meta');
  const latestRegBtn = latest?.querySelector('.msg-meta .msg-action-btn--regenerate');
  const olderRegBtn = older?.querySelector('.msg-action-btn--regenerate');
  const rail = q('.msg-version-rail');
  const toggle = q('.msg-version-rail__toggle');
  const body = q('.msg-version-rail__body');
  const noFade = q('.msg-user--no-fade');
  const inner = q('#messagesInner');
  const copyBtn = latest?.querySelector('.msg-meta .msg-action-btn--copy');
  const innerRect = inner ? rect(inner) : null;

  return {
    hOverflow: document.documentElement.scrollWidth > window.innerWidth,
    railToggleH: toggle ? rect(toggle).height : null,
    railLabel: toggle?.querySelector('.msg-version-rail__label')?.textContent || null,
    railExpandedAttr: toggle?.getAttribute('aria-expanded') ?? null,
    railBodyDisplay: body ? style(body, 'display') : null,
    railBodyBorderLeft: body ? style(body, 'borderLeftWidth') : null,
    railTextGap: (() => {
      const icon = toggle?.querySelector('.msg-version-rail__icon');
      const foldedText = body?.querySelector('.msg-assistant-body');
      if (!icon || !foldedText) return null;
      return foldedText.getBoundingClientRect().left - icon.getBoundingClientRect().left;
    })(),
    latestRegBtnDisplay: latestRegBtn ? style(latestRegBtn, 'display') : null,
    olderRegBtnDisplay: olderRegBtn ? style(olderRegBtn, 'display') : null,
    regBtnH: latestRegBtn ? rect(latestRegBtn).height : null,
    regBtnW: latestRegBtn ? rect(latestRegBtn).width : null,
    metaVisibility: latestMeta ? style(latestMeta, 'visibility') : null,
    noFadeAnim: noFade ? style(noFade, 'animationName') : null,
    latestRight: latest ? rect(latest).right : null,
    innerRight: innerRect ? innerRect.right : null,
    metaActionCount: latestMeta
      ? Array.from(latestMeta.querySelectorAll('.msg-actions .msg-action-btn')).length
      : null,
    copyRegGap: latestRegBtn && copyBtn
      ? rect(latestRegBtn).left - rect(copyBtn).right
      : null,
    viewport: window.innerWidth,
  };
}

const scenarios = [
  { name: 'desktop-light', width: 1440, height: 900, colorScheme: 'light', hoverLatest: true, mobile: false, railExpanded: false },
  { name: 'desktop-dark', width: 1440, height: 900, colorScheme: 'dark', hoverLatest: true, mobile: false, railExpanded: false },
  { name: 'desktop-rail-expanded', width: 1440, height: 900, colorScheme: 'light', hoverLatest: false, mobile: false, railExpanded: true },
  { name: 'mobile-light', width: 390, height: 844, colorScheme: 'light', hoverLatest: false, mobile: true, railExpanded: false },
  { name: 'mobile-dark', width: 390, height: 844, colorScheme: 'dark', hoverLatest: false, mobile: true, railExpanded: false },
  { name: 'mobile-430', width: 430, height: 932, colorScheme: 'light', hoverLatest: false, mobile: true, railExpanded: false },
];

const browser = await chromium.launch({ headless: true });
try {
  for (const scenario of scenarios) {
    const page = await browser.newPage({
      viewport: { width: scenario.width, height: scenario.height },
      colorScheme: scenario.colorScheme,
      hasTouch: scenario.mobile,
    });
    await page.setContent(fixtureHtml(scenario), { waitUntil: 'load' });
    // Entrance fades settle at 0.2s; meta reveal transition at 0.15s.
    await page.waitForTimeout(300);
    if (scenario.hoverLatest) {
      await page.hover('.msg-assistant.is-regenerable');
      await page.waitForTimeout(300);
    }
    await page.screenshot({ path: join(outputDir, `${scenario.name}.png`) });

    const m = await page.evaluate(collectMetrics);

    // Common: nothing overflows, rail is a real touch target, exactly the
    // latest reply exposes regenerate, the committed bubble is stationary.
    assert.ok(!m.hOverflow, `${scenario.name}: no horizontal overflow (scrollWidth > viewport)`);
    assert.ok(m.railToggleH >= 44, `${scenario.name}: rail toggle must be >= 44px tall (got ${m.railToggleH})`);
    assert.ok(m.railLabel, `${scenario.name}: rail toggle must carry a folded-count label`);
    assert.notEqual(m.latestRegBtnDisplay, 'none', `${scenario.name}: latest reply must expose regenerate in its meta row`);
    assert.equal(m.olderRegBtnDisplay, 'none', `${scenario.name}: older replies must not expose regenerate`);
    assert.equal(m.noFadeAnim, 'none', `${scenario.name}: committed bubble must skip the entrance animation (got ${m.noFadeAnim})`);
    assert.ok(m.latestRight <= m.innerRight + 1, `${scenario.name}: latest reply must stay inside the message column`);
    assert.equal(m.railBodyDisplay, scenario.railExpanded ? 'block' : 'none', `${scenario.name}: rail body folded/expanded state`);

    if (scenario.railExpanded) {
      assert.equal(m.railExpandedAttr, 'true', `${scenario.name}: expanded rail must set aria-expanded`);
      assert.equal(m.railBodyBorderLeft, '2px', `${scenario.name}: expanded rail body must use the 2px hairline rule (got ${m.railBodyBorderLeft})`);
      assert.ok(Math.abs(m.railTextGap) <= 1, `${scenario.name}: folded text must align with the toggle icon start (got ${m.railTextGap}px gap)`);
      assert.equal(m.metaVisibility, 'hidden', `${scenario.name}: meta stays hidden without hover on desktop`);
    }
    if (scenario.hoverLatest) {
      assert.equal(m.metaVisibility, 'visible', `${scenario.name}: hovering the latest reply reveals its meta`);
      assert.ok(m.regBtnH === 24 && m.regBtnW === 24, `${scenario.name}: desktop regenerate must be a 24px meta icon (got ${m.regBtnW}x${m.regBtnH})`);
    }
    if (scenario.mobile) {
      // Permanent meta row: regenerate sits next to copy, never behind a
      // long-press menu (2026-08-05 user decision).
      assert.notEqual(m.latestRegBtnDisplay, 'none', `${scenario.name}: mobile must keep regenerate visible in the meta row`);
      assert.ok(m.regBtnH === 44 && m.regBtnW === 44, `${scenario.name}: mobile regenerate must be a 44px touch-sized meta button (got ${m.regBtnW}x${m.regBtnH})`);
      assert.equal(m.metaActionCount, 2, `${scenario.name}: mobile meta row must show copy + regenerate side by side (got ${m.metaActionCount})`);
      assert.ok(m.copyRegGap >= 7 && m.copyRegGap <= 9, `${scenario.name}: copy and regenerate must sit adjacent at the 8px touch gap (got ${m.copyRegGap}px)`);
    }

    await page.close();
  }
} finally {
  if (!requestedOutputDir) rmSync(outputDir, { recursive: true, force: true });
  await browser.close();
}

console.log(`ok — A1 regenerate version-rail/meta-row/no-fade visual fixtures (${scenarios.length} states)`);
if (requestedOutputDir) console.log(`output: ${outputDir}`);
