#!/usr/bin/env node
// Visual + geometry fixture for the mobile Decision Sheet.
// Renders the sheet with the REAL css stack and a hand-built DOM that mirrors
// decision-sheet.js renderSheet() output, anchored above the Live Bar inside
// #liveBarSlot. Produces PNGs (for Gemini review — the author has no multimodal
// vision) AND asserts geometry the author CAN read as text.
//
// Run standalone:  node tests/test-chat-decision-sheet-visual.mjs
// (PNGs + manifest land in /var/lib/ragent/workspace/decision-sheet-visual/<stamp>)
import assert from 'assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '@playwright/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const cssFiles = [
  'static/chat/chat-base.css',
  'static/chat/chat-glass.css',
  'static/chat/chat-input.css',
  'static/chat/chat-messages.css',
  'static/chat/chat-live-status.css',
  'static/chat/chat-responsive.css',
  'static/chat/chat-decision-sheet.css',
  'static/chat/chat-attention-popup.css',
  'static/chat/chat-m3-tokens.css',
];
const styles = cssFiles.map((p) => readFileSync(join(repoRoot, p), 'utf8')).join('\n');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outputDir = process.env.RAGENT_VISUAL_OUTPUT_DIR
  || join('/var/lib/ragent/workspace/decision-sheet-visual', stamp);
mkdirSync(outputDir, { recursive: true });

// --- DOM fragments that mirror decision-sheet.js renderSheet() output --------
// Mirrors decision-sheet.js bindSheetCodeCopies(): the knob is inside the code row.
function codeBlock(value) {
  return `<code class="oneui-notification__code decision-sheet__code">${value}<button class="decision-sheet__code-copy" type="button" aria-label="Copy"><svg class="decision-sheet__code-copy-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0 2 2h2"/></svg></button></code>`;
}

function scopeRow(label, value, code = false) {
  return `<div class="oneui-notification__detail">
    <div class="oneui-notification__detail-label">${label}</div>
    ${code ? codeBlock(value) : `<div class="oneui-notification__detail-value">${value}</div>`}
  </div>`;
}

// Mirrors makeAction(): the exact notification action class is reused.
function actionBtn(label, decision, { primary = false, neutral = false } = {}) {
  const cls = ['oneui-notification__action', primary ? 'oneui-notification__action--primary' : '', neutral ? 'oneui-notification__action--quiet' : ''].filter(Boolean).join(' ');
  return `<button class="${cls}" type="button" data-approval-decision="${decision}"><span class="oneui-notification__action-label">${label}</span></button>`;
}

function sheetHtml({ kind, title, risk, scopeRows, question, actions, notify }) {
  const riskBadge = risk
    ? `<span class="decision-sheet__risk" data-tier="${risk.tier}">${risk.label}</span>`
    : '';
  const scope = scopeRows && scopeRows.length
    ? `<div class="decision-sheet__scope">${scopeRows.map((r) => scopeRow(r[0], r[1], r[2])).join('')}</div>`
    : '';
  // Notification opt-in is intentionally omitted from the decision surface;
  // it is unrelated to the decision the user must make.
  const notifyPill = false && notify
    ? `<button class="decision-sheet__notify" type="button" aria-label="Turn on notifications"><svg class="decision-sheet__notify-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg><span class="decision-sheet__notify-text">Turn on notifications</span></button>`
    : '';
  const prompt = question
    ? `<div class="oneui-notification__choices">
        <div class="runtime-approval-card__prompt" data-question-index="0">
          <div class="runtime-approval-card__prompt-header oneui-notification__choice-question">${question.header}</div>
          <div class="runtime-approval-card__question oneui-notification__message">${question.question}</div>
          <div class="runtime-approval-card__option-list" role="list">
            ${question.options.map((o, i) => `<div class="runtime-approval-card__option oneui-notification__choice ${i === 0 ? 'is-selected' : ''}" role="option" tabindex="0" data-option-index="${i}"><div class="runtime-approval-card__option-text"><div class="runtime-approval-card__option-label">${o}</div></div></div>`).join('')}
          </div>
        </div>
      </div>
      <div class="decision-sheet__custom-answer-wrap">
        <div class="decision-sheet__custom-answer-label">Other response</div>
        <textarea class="oneui-notification__custom-answer decision-sheet__custom-answer" rows="1" placeholder="Write your own response…"></textarea>
      </div>`
    : '';
  return `<section id="decisionSheet" class="decision-sheet oneui-notification" role="dialog" aria-label="Approval needed" aria-expanded="false" data-state="brief">
    <header class="oneui-notification__header">
      <button class="oneui-notification__summary decision-sheet__summary" type="button" aria-controls="decisionSheetContent" aria-expanded="false">
        <span class="oneui-notification__title">${title}</span>
        <span class="oneui-notification__disclosure" aria-hidden="true"><svg class="oneui-notification__disclosure-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg></span>
      </button>
      ${riskBadge ? `<div class="decision-sheet__meta">${riskBadge}</div>` : ''}
    </header>
    <div class="oneui-notification__content" id="decisionSheetContent">
      <div class="oneui-notification__details decision-sheet__details">${scope}${prompt}</div>
    </div>
    <footer class="oneui-notification__footer">
    ${notifyPill}
    <div class="oneui-notification__actions">${actions}</div>
    </footer>
  </section>`;
}

function agentCreateSheetHtml() {
  const definitionRows = [
    ['name', 'Weekly Report Agent'],
    ['tool', 'codex'],
    ['skills', 'spreadsheets\nweekly-reporting'],
    ['welcomeMessage', 'Send me the source export.'],
    ['systemPrompt', 'Prepare the weekly report from the supplied export. Preserve source totals, flag unresolved discrepancies, and deliver the final report as a downloadable artifact.'],
    ['perMessageSystemPrompt', '{\n  "auto": "Check the reporting standard first."\n}'],
  ].map(([label, value]) => `<div class="decision-sheet__agent-definition-row">
    <div class="decision-sheet__agent-definition-label">${label}</div>
    <pre class="decision-sheet__agent-definition-value">${value}</pre>
  </div>`).join('');
  return `<section id="decisionSheet" class="decision-sheet oneui-notification oneui-notification--danger" role="dialog" aria-label="Approval needed" aria-expanded="false" data-state="brief">
    <header class="oneui-notification__header">
      <button class="oneui-notification__summary decision-sheet__summary" type="button" aria-controls="decisionSheetContent" aria-expanded="false">
        <span class="oneui-notification__title">Create persistent Agent</span>
        <span class="oneui-notification__disclosure" aria-hidden="true"><svg class="oneui-notification__disclosure-icon" viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg></span>
      </button>
      <div class="oneui-notification__meta"><span class="decision-sheet__risk" data-tier="high">Owner approval</span></div>
    </header>
    <div class="oneui-notification__content" id="decisionSheetContent">
      <div class="oneui-notification__details decision-sheet__details">
        <p class="oneui-notification__message">Review the exact persistent definition before approving.</p>
        <div class="decision-sheet__batch">
          <label class="decision-sheet__batch-op">
            <input class="decision-sheet__batch-op-check" type="checkbox" checked value="agent-create">
            <span class="decision-sheet__batch-op-text"><strong class="decision-sheet__batch-op-description">Create Weekly Report Agent</strong><code class="oneui-notification__code decision-sheet__code">tool=codex; skills=spreadsheets, weekly-reporting</code></span>
          </label>
          <details class="decision-sheet__agent-definition">
            <summary class="decision-sheet__agent-definition-summary">Full Agent definition</summary>
            <div class="decision-sheet__agent-definition-body">${definitionRows}</div>
          </details>
        </div>
      </div>
    </div>
    <footer class="oneui-notification__footer"><div class="oneui-notification__actions">
      ${actionBtn('Approve selected', 'approve', { primary: true })}
      ${actionBtn('Deny', 'deny', { neutral: true })}
    </div></footer>
  </section>`;
}

const variants = {
  command: {
    label: 'command',
    sheet: () => sheetHtml({
      kind: 'Command',
      title: 'Clean the temporary build output and rebuild the project',
      scopeRows: [
        ['Command', 'rm -rf /tmp/build-cache && npm run build', true],
        ['Directory', '/srv/ragent-promoted', false],
      ],
      actions: `${actionBtn('Approve', 'approve', { primary: true })}
        ${actionBtn('Deny', 'deny')}`,
    }),
  },
  commandNotify: {
    label: 'command-notify',
    sheet: () => sheetHtml({
      kind: 'Command',
      title: 'Clean the temporary build output and rebuild the project',
      notify: true,
      scopeRows: [
        ['Command', 'rm -rf /tmp/build-cache && npm run build', true],
        ['Directory', '/srv/ragent-promoted', false],
      ],
      actions: `${actionBtn('Approve', 'approve', { primary: true })}
        ${actionBtn('Deny', 'deny')}`,
    }),
  },
  permissionsHighRisk: {
    label: 'permissions-highrisk',
    sheet: () => sheetHtml({
      kind: 'Permissions',
      title: 'Grant filesystem write + network access',
      risk: { tier: 'high', label: 'High risk' },
      scopeRows: [
        ['Permissions', 'Network · 3 writes · 12 reads', false],
        ['Grant root', '/srv/ragent-promoted', false],
      ],
      actions: `${actionBtn('Approve', 'approve', { primary: true })}
        ${actionBtn('Deny', 'deny')}`,
    }),
  },
  question: {
    label: 'question',
    sheet: () => sheetHtml({
      kind: 'Question',
      title: 'How should I proceed?',
      question: {
        header: 'Deployment target',
        question: 'Which environment should this change ship to?',
        options: ['Staging', 'Production', 'Hold for review'],
      },
      actions: `${actionBtn('Answer', 'approve', { primary: true })}
        ${actionBtn('Cancel', 'deny', { neutral: true })}`,
    }),
  },
  agentCreate: {
    label: 'agent-create',
    sheet: agentCreateSheetHtml,
  },
};

// The Live Bar in its RUNNING state (orb + label + elapsed) — the "base" form the
// Decision Sheet is meant to read as expanding upward from. Used for the
// relationship screenshot so a reviewer can compare Live Bar ↔ Sheet continuity.
function liveBarRunningHtml() {
  return `<div id="liveBar" class="live-bar" data-state="running" role="status" aria-live="polite">
    <span class="live-bar__orb" aria-hidden="true">
      <svg class="live-bar__orb-svg" viewBox="0 0 44 44" focusable="false">
        <defs><radialGradient id="dsFixOrb" cx="50%" cy="50%" r="58%">
          <stop class="live-bar__orb-sphere-stop-main" offset="56%"/>
          <stop class="live-bar__orb-sphere-stop-edge" offset="100%"/>
        </radialGradient></defs>
        <circle class="live-bar__ring live-bar__ring--back" cx="22" cy="22" r="18.8" fill="none"/>
        <circle class="live-bar__orb-sphere" cx="22" cy="22" r="13" fill="url(#dsFixOrb)"/>
        <circle class="live-bar__ring live-bar__ring--front" cx="22" cy="22" r="18.8" fill="none"/>
      </svg>
    </span>
    <span class="live-bar__label">Running command</span>
    <span class="live-bar__elapsed">18s</span>
  </div>`;
}

function fixtureHtml(scenario) {
  const isLiveBar = scenario.mode === 'livebar';
  // In sheet mode the bare Live Bar sits in the slot but fades out while the
  // sheet is open (decision-sheet.js toggles the decision-sheet-open class on
  // render — mirrored here; the sheet head carries the status). In livebar
  // mode the running Live Bar is the subject — no sheet, so it stays visible.
  const slotInner = isLiveBar
    ? liveBarRunningHtml()
    : `<div id="liveBar" class="live-bar decision-sheet-open" data-state="waiting_user" role="status" aria-live="polite"><span class="live-bar__label">Waiting for approval</span></div>`;
  const sheet = isLiveBar ? '' : variants[scenario.variant].sheet();
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>${styles}</style>
  <style>
    * { box-sizing: border-box; }
    html, body { margin: 0; height: 100%; }
    body { background: var(--bg); color: var(--text); font-family: Inter, ui-sans-serif, system-ui, sans-serif; display: flex; flex-direction: column; }
    /* chat-input.css sets align-self:end on .input-area (bottom-alignment in the
       real row/grid layout). In this synthetic column layout that would shrink it
       to content width, so stretch it to full width like the real composer bar. */
    .input-area { align-self: stretch; }
    .messages { flex: 1 1 auto; overflow-y: auto; padding: 16px 14px 120px; display: flex; flex-direction: column; gap: 12px; }
    .msg { max-width: 80%; padding: 10px 14px; border-radius: 18px; background: var(--bg-secondary); font-size: 14px; line-height: 1.45; }
    .msg--user { align-self: flex-end; background: var(--user-bubble, var(--bg-secondary)); }
  </style>
</head>
<body>
  <main class="messages" aria-label="Conversation">
    <div class="msg">I'll clean the build cache and rebuild. This needs your OK before I run it.</div>
    <div class="msg msg--user">Go ahead, but show me the command first.</div>
    <div class="msg">Sure — here's the exact command. Review it and approve when ready.</div>
    <div class="msg msg--user">Looks fine, one sec while I check the directory.</div>
  </main>
  <div class="input-area" id="inputArea">
    <div class="input-stack">
      <div id="liveBarSlot" class="live-bar-slot">${slotInner}</div>
      <div class="input-wrapper" style="min-height:56px;border-radius:24px;background:var(--bg-secondary);margin:0 12px 12px;"></div>
    </div>
    ${sheet}
  </div>
  <script>
    document.querySelector('.decision-sheet__summary')?.addEventListener('click', () => {
      const sheet = document.querySelector('#decisionSheet');
      const expanded = !sheet.classList.contains('oneui-notification--detailed');
      sheet.classList.toggle('oneui-notification--detailed', expanded);
      sheet.dataset.state = expanded ? 'detailed' : 'brief';
      sheet.setAttribute('aria-expanded', String(expanded));
      document.querySelector('.decision-sheet__summary')?.setAttribute('aria-expanded', String(expanded));
    });
  </script>
</body>
</html>`;
}

const scenarios = [
  { name: 'livebar-running-390-light', width: 390, height: 844, colorScheme: 'light', mode: 'livebar' },
  { name: 'livebar-running-390-dark', width: 390, height: 844, colorScheme: 'dark', mode: 'livebar' },
  { name: 'command-390-light', width: 390, height: 844, colorScheme: 'light', variant: 'command' },
  { name: 'command-390-dark', width: 390, height: 844, colorScheme: 'dark', variant: 'command' },
  // "Enable notifications" pill — shown while Notification permission is still
  // "default". Verified on mobile in both themes (the primary surface for it).
  { name: 'command-notify-390-light', width: 390, height: 844, colorScheme: 'light', variant: 'commandNotify' },
  { name: 'command-notify-390-dark', width: 390, height: 844, colorScheme: 'dark', variant: 'commandNotify' },
  { name: 'permissions-highrisk-390-light', width: 390, height: 844, colorScheme: 'light', variant: 'permissionsHighRisk' },
  { name: 'question-390-light', width: 390, height: 844, colorScheme: 'light', variant: 'question' },
  { name: 'agent-create-390-light', width: 390, height: 844, colorScheme: 'light', variant: 'agentCreate' },
  { name: 'command-360-dark', width: 360, height: 740, colorScheme: 'dark', variant: 'command' },
  // Desktop: the sheet is no longer mobile-only (2026-08-04) — it aligns to the
  // centered message column above the composer.
  { name: 'command-1024-light', width: 1024, height: 768, colorScheme: 'light', variant: 'command' },
  { name: 'agent-create-1024-dark', width: 1024, height: 768, colorScheme: 'dark', variant: 'agentCreate' },
  { name: 'command-1440-dark', width: 1440, height: 900, colorScheme: 'dark', variant: 'command' },
];

const browser = await chromium.launch({ headless: true });
const metricsByName = {};
try {
  for (const scenario of scenarios) {
    const page = await browser.newPage({
      viewport: { width: scenario.width, height: scenario.height },
      colorScheme: scenario.colorScheme,
      reducedMotion: 'no-preference',
    });
    await page.setContent(fixtureHtml(scenario), { waitUntil: 'load' });
    // Let the rise animation settle before screenshotting.
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(outputDir, `${scenario.name}.png`), fullPage: false });

    const m = await page.evaluate(() => {
      const rect = (sel) => {
        const v = document.querySelector(sel)?.getBoundingClientRect();
        return v ? { top: v.top, right: v.right, bottom: v.bottom, left: v.left, width: v.width, height: v.height } : null;
      };
      const cs = (sel, prop) => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el).getPropertyValue(prop) : '';
      };
      const sheet = document.querySelector('#decisionSheet');
      const primary = document.querySelector('.oneui-notification__action--primary');
      const deny = document.querySelector('.oneui-notification__action[data-approval-decision="deny"]');
      return {
        viewportWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        sheetHidden: sheet ? sheet.hidden : null,
        sheet: rect('#decisionSheet'),
        liveBar: rect('#liveBar'),
        slot: rect('#liveBarSlot'),
        inputArea: rect('#inputArea'),
        composer: rect('#inputArea .input-wrapper'),
        primary: rect('.oneui-notification__action--primary'),
        deny: rect('.oneui-notification__action[data-approval-decision="deny"]'),
        summary: rect('.decision-sheet__summary'),
        disclosure: rect('.oneui-notification__disclosure'),
        notify: rect('.decision-sheet__notify'),
        riskTier: document.querySelector('.decision-sheet__risk')?.getAttribute('data-tier') || null,
        sheetBackdrop: cs('#decisionSheet', 'backdrop-filter'),
        sheetRadius: cs('#decisionSheet', 'border-top-left-radius'),
        sheetBackground: cs('#decisionSheet', 'background-color'),
        sheetShadow: cs('#decisionSheet', 'box-shadow'),
        composerOpacity: cs('#inputArea .input-wrapper', 'opacity'),
        liveBarDisplay: cs('#liveBar', 'display'),
        liveBarOpacity: cs('#liveBar', 'opacity'),
        liveBarPointerEvents: cs('#liveBar', 'pointer-events'),
        decorativeIconCount: document.querySelectorAll('.decision-sheet__orb, .decision-sheet__action-icon').length,
        commandTitleCount: Array.from(document.querySelectorAll('.oneui-notification__title')).filter((node) => /run a shell command/i.test(node.textContent || '')).length,
      };
    });
    metricsByName[scenario.name] = m;
    const isLiveBar = scenario.mode === 'livebar';
    const isDesktop = scenario.width >= 768;

    // Geometry the author can verify directly (text).
    assert.ok(m.scrollWidth <= m.viewportWidth + 1, `${scenario.name}: no horizontal scroll`);
    if (isLiveBar) {
      // Running Live Bar base form: visible, sized, floating just above the composer.
      assert.ok(m.liveBar && m.liveBar.height > 0 && m.liveBar.width > 0, `${scenario.name}: live bar must render`);
      assert.notEqual(m.liveBarDisplay, 'none', `${scenario.name}: live bar must be visible when no sheet is open`);
      assert.ok(m.liveBar.bottom <= m.inputArea.top + 2, `${scenario.name}: live bar must float above the composer`);
    } else {
      assert.equal(m.sheetHidden, false, `${scenario.name}: sheet must be visible`);
      assert.ok(m.sheet && m.sheet.height > 0, `${scenario.name}: sheet must render with height`);
      assert.ok(m.sheet.left >= 0 && m.sheet.right <= m.viewportWidth + 1, `${scenario.name}: sheet within viewport horizontally`);
      // The decision surface occupies the composer slot and covers it without
      // changing page flow; its bottom follows the input area bottom edge.
      assert.ok(Math.abs(m.sheet.bottom - m.inputArea.bottom) <= 2, `${scenario.name}: sheet must cover the composer slot (got sheet.bottom=${m.sheet.bottom} inputArea.bottom=${m.inputArea.bottom})`);
      assert.ok(m.sheet.top <= m.inputArea.top + 1, `${scenario.name}: sheet must expand upward from the composer`);
      assert.ok(m.sheet.right <= m.viewportWidth + 1 && m.sheet.left >= -1, `${scenario.name}: actions must stay within the viewport`);
      assert.ok(m.composer && m.sheet.left <= m.composer.left + 1 && m.sheet.right >= m.composer.right - 1, `${scenario.name}: notification surface must cover the composer width`);
      assert.ok(m.primary && m.primary.height >= 52, `${scenario.name}: primary action must be >=52px (got ${m.primary?.height})`);
      assert.ok(m.deny && m.deny.height >= 52, `${scenario.name}: deny action must be >=52px`);
      assert.ok(m.summary && m.summary.height >= 44, `${scenario.name}: shared summary disclosure must keep a 44px touch target`);
      assert.ok(m.primary.right <= m.viewportWidth + 1, `${scenario.name}: primary action must not overflow the viewport (got right=${m.primary.right})`);
      assert.notEqual(m.sheetRadius, '0px', `${scenario.name}: approval host must keep the notification radius`);
      assert.doesNotMatch(m.sheetBackground, /rgba?\(\s*0,\s*0,\s*0,\s*0\s*\)/, `${scenario.name}: approval host must use an opaque notification surface`);
      assert.notEqual(m.sheetShadow, 'none', `${scenario.name}: approval host must keep the notification elevation`);
      assert.equal(m.composerOpacity, '1', `${scenario.name}: composer must remain ready underneath the leaving notification surface`);
      assert.equal(m.decorativeIconCount, 0, `${scenario.name}: decision surface has no decorative icon layer`);
      assert.equal(m.commandTitleCount, 0, `${scenario.name}: decision surface has no generic command title`);
      if (scenario.variant === 'commandNotify') {
        assert.equal(m.notify, null, `${scenario.name}: unrelated notification opt-in must not appear on the decision card`);
      }
      // Live Bar fades out while the sheet is open (class-driven transition;
      // it keeps its layout slot so nothing jumps when the sheet collapses).
      assert.notEqual(m.liveBarDisplay, 'none', `${scenario.name}: #liveBar should fade, not be display:none'd`);
      assert.equal(m.liveBarOpacity, '0', `${scenario.name}: #liveBar must be faded out while sheet is open`);
      assert.equal(m.liveBarPointerEvents, 'none', `${scenario.name}: #liveBar must not intercept taps while sheet is open`);
      if (isDesktop) {
        // Desktop: the sheet aligns to the centered message column (--chat-column-width),
        // NOT the full canvas — it must be narrower than the viewport and centered.
        assert.ok(m.sheet.width > 500 && m.sheet.width <= 920, `${scenario.name}: desktop sheet width ≈ message column (got ${m.sheet.width})`);
        assert.ok(m.sheet.left > 30, `${scenario.name}: desktop sheet must be centered, not edge-to-edge (got left=${m.sheet.left})`);
        assert.ok(m.sheet.right < m.viewportWidth - 30, `${scenario.name}: desktop sheet right margin (got right=${m.sheet.right})`);
      } else {
        // Mobile: sheet is near-full-width (not stuck at the narrow Live Bar width).
        assert.ok(m.sheet.width > m.viewportWidth * 0.5, `${scenario.name}: sheet must be near-full-width (got ${m.sheet.width} of ${m.viewportWidth})`);
      }
      const sheet = page.locator('#decisionSheet');
      const summary = page.locator('.decision-sheet__summary');
      await summary.click();
      await page.waitForTimeout(220);
      assert.equal(await sheet.getAttribute('aria-expanded'), 'true', `${scenario.name}: summary enters the shared detailed state`);
      assert.equal(await summary.getAttribute('aria-expanded'), 'true', `${scenario.name}: summary exposes its detailed state to assistive tech`);
      assert.notEqual(await page.locator('.oneui-notification__details').evaluate((node) => getComputedStyle(node).display), 'none', `${scenario.name}: technical detail appears only after disclosure`);
      assert.equal(await page.locator('.oneui-notification__disclosure').evaluate((node) => getComputedStyle(node).transform), 'matrix(0, 1, -1, 0, 0, 0)', `${scenario.name}: right chevron turns down when details open`);
      const detailedGeometry = await page.evaluate(() => {
        const rect = (sel) => {
          const node = document.querySelector(sel);
          const box = node?.getBoundingClientRect();
          return box ? { top: box.top, bottom: box.bottom, height: box.height } : null;
        };
        return {
          sheet: rect('#decisionSheet'),
          content: rect('.oneui-notification__content'),
          footer: rect('.oneui-notification__footer'),
          primary: rect('.oneui-notification__action--primary'),
          viewportHeight: document.documentElement.clientHeight,
        };
      });
      assert.ok(detailedGeometry.footer && detailedGeometry.footer.bottom <= detailedGeometry.viewportHeight + 1, `${scenario.name}: detailed footer remains visible inside the viewport`);
      assert.ok(detailedGeometry.primary && detailedGeometry.primary.bottom <= detailedGeometry.footer.bottom + 1, `${scenario.name}: detailed decision action stays in the stable footer`);
      assert.ok(detailedGeometry.content && detailedGeometry.content.bottom <= detailedGeometry.footer.top + 1, `${scenario.name}: only the detailed content region may scroll`);
      if (scenario.variant === 'agentCreate') {
        const definition = page.locator('.decision-sheet__agent-definition');
        await definition.locator('summary').click();
        assert.equal(await definition.getAttribute('open'), '', `${scenario.name}: exact Agent definition expands on demand`);
        const definitionGeometry = await page.evaluate(() => {
          const node = document.querySelector('.decision-sheet__agent-definition');
          const value = document.querySelector('.decision-sheet__agent-definition-value');
          const footer = document.querySelector('.oneui-notification__footer');
          const nodeRect = node?.getBoundingClientRect();
          const valueRect = value?.getBoundingClientRect();
          const footerRect = footer?.getBoundingClientRect();
          return {
            nodeRight: nodeRect?.right || 0,
            valueRight: valueRect?.right || 0,
            footerBottom: footerRect?.bottom || 0,
            viewportWidth: document.documentElement.clientWidth,
            viewportHeight: document.documentElement.clientHeight,
          };
        });
        assert.ok(definitionGeometry.nodeRight <= definitionGeometry.viewportWidth + 1, `${scenario.name}: Agent definition stays inside viewport`);
        assert.ok(definitionGeometry.valueRight <= definitionGeometry.viewportWidth + 1, `${scenario.name}: long prompt text does not overflow horizontally`);
        assert.ok(definitionGeometry.footerBottom <= definitionGeometry.viewportHeight + 1, `${scenario.name}: footer stays reachable after Agent definition expansion`);
      }
      await page.screenshot({ path: join(outputDir, `${scenario.name}-detailed.png`), fullPage: false });
    }
    await page.close();
  }
  console.log(`test-chat-decision-sheet-visual: ok (${outputDir})`);
} finally {
  await browser.close();
}

writeFileSync(join(outputDir, 'geometry-metrics.json'), `${JSON.stringify(metricsByName, null, 2)}\n`);
console.log(`screenshots: ${scenarios.length}`);
