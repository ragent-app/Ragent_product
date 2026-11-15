#!/usr/bin/env node
// Composer expand affordance + focus semantics + running-state send button.
// Static fixture with the real composer markup and CSS tokens; asserts the
// user-facing contracts numerically and keeps before/after screenshots for
// the visual review matrix.
//   - single-line drafts keep breathing room inside the glass box (no flush
//     bottom against the actions-row divider)
//   - the fullscreen affordance floats over the text's top-right corner and
//     does NOT push the text sideways (no padding-right yield)
//   - composer focus must not change the outer wrapper surface or add a ring
//   - running sessions swap Stop and Send in one corner slot: Stop at rest,
//     a staged follow-up (draft or attachments) swaps Send in — textarea
//     focus alone never reveals Send, and the two never coexist
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';
import { chromium } from '@playwright/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const requestedOutputDir = String(process.env.RAGENT_VISUAL_OUTPUT_DIR || '').trim();
const outputDir = requestedOutputDir || mkdtempSync(join(tmpdir(), 'ragent-composer-focus-visual-'));
if (requestedOutputDir) mkdirSync(outputDir, { recursive: true });

// ---- Source contract: the CSS/JS hooks must match what the fixture asserts ----
const inputCss = readFileSync(join(repoRoot, 'static/chat/chat-input.css'), 'utf8');
const glassCss = readFileSync(join(repoRoot, 'static/chat/chat-glass.css'), 'utf8');
const responsiveCss = readFileSync(join(repoRoot, 'static/chat/chat-responsive.css'), 'utf8');
const composeSource = readFileSync(join(repoRoot, 'static/chat/compose.js'), 'utf8');
const iconsSource = readFileSync(join(repoRoot, 'static/chat/icons.js'), 'utf8');
const materialFinishCss = readFileSync(join(repoRoot, 'static/chat/chat-material-finish.css'), 'utf8');
const m3TokensCss = readFileSync(join(repoRoot, 'static/chat/chat-m3-tokens.css'), 'utf8');

assert.doesNotMatch(inputCss, /\.input-wrapper:focus-within/, 'composer ring must not use :focus-within (sibling controls would match)');
assert.doesNotMatch(glassCss, /\.input-wrapper:focus-within/, 'glass composer ring must not use :focus-within');
assert.doesNotMatch(inputCss, /body\.composer-input-focused[^}]*\.input-wrapper/, 'composer focus must not add an outer input-wrapper style');
assert.doesNotMatch(glassCss, /body\.composer-input-focused[^}]*\.input-wrapper/, 'glass composer focus must not add an outer input-wrapper style');
assert.match(composeSource, /msgInput\.addEventListener\("focus", syncComposerInputFocus\)/, 'compose should track textarea focus');
assert.match(composeSource, /msgInput\.addEventListener\("blur", syncComposerInputFocus\)/, 'compose should track textarea blur');
assert.match(composeSource, /composerInputArea\.addEventListener\("pointerdown", focusComposerFromShell\)/, 'the compact composer shell should focus the editor when tapped');
assert.match(composeSource, /target\.closest\([\s\S]*?\[role=\\"button\\"\]/, 'shell focus should leave explicit controls to their own handlers');
assert.match(composeSource, /function collapseComposerFromOutside\([\s\S]*?composerExpandedByInteraction = false;/, 'the expanded composer should have an explicit outside-click collapse path');
assert.match(composeSource, /document\.addEventListener\("click", collapseComposerFromOutside\)/, 'outside clicks should be the collapse trigger');
assert.match(inputCss, /\.input-area\.composer-collapsed \.input-row\s*\{[\s\S]*?pointer-events:\s*auto;/, 'the compact input row must receive shell taps');
assert.match(inputCss, /\.input-area\.composer-collapsed \.input-wrapper\s*\{[\s\S]*?margin-inline:\s*12px;/, 'the compact capsule should be slightly narrower than the expanded composer');
assert.match(inputCss, /\.input-area\.composer-expanded \.input-wrapper\s*\{[\s\S]*?margin-inline:\s*0;/, 'the expanded composer should restore the full conversation width');
assert.doesNotMatch(inputCss, /\.input-wrapper\s*\{[\s\S]*?height var\(--composer-motion-duration\) var\(--composer-motion-ease\)/, 'composer height must not compete with the native spring clock');
assert.match(inputCss, /\.input-wrapper\.composer-size-animating[\s\S]*?overflow:\s*hidden !important;/, 'composer shell should clip transient reflow while its size settles');
assert.match(inputCss, /--composer-actions-height:\s*43px;/, 'desktop composer action rail should keep the 45px outer compact shell');
assert.match(inputCss, /--composer-collapsed-height:\s*43px;/, 'collapsed composer should use a 45px outer compact height');
assert.match(inputCss, /@media \(max-width: 767px\)[\s\S]*?--composer-actions-height:\s*45px;[\s\S]*?--composer-collapsed-height:\s*45px;/, 'mobile composer should retain the same 45px rail and compact height');
assert.match(composeSource, /wrapper\.classList\.add\("composer-size-animating"\)/, 'composer resize should mark the shell while the layout is settling');
assert.match(composeSource, /wrapper\.classList\.remove\("composer-size-animating"\)/, 'composer resize should clear its transient clipping state');
assert.match(composeSource, /function createComposerSpringKeyframes[\s\S]*?const stiffness = 380;[\s\S]*?const dampingRatio = 0\.88;/, 'composer resize should use the Android-aligned spring curve');
assert.match(composeSource, /wrapper\.animate\([\s\S]*?createComposerSpringKeyframes[\s\S]*?duration: settleDuration/, 'one native animation timeline should own the shell geometry');
assert.match(composeSource, /height:[\s\S]*?marginLeft:[\s\S]*?marginRight:[\s\S]*?borderRadius:/, 'the native timeline should move height, horizontal inset, and corner radius together');
assert.doesNotMatch(composeSource, /actionRow\.style\.|inputRow\.style\.padding|markdownEditor\.style\.maxHeight|requestAnimationFrame\(tick\)/, 'composer resize must not hand-write child layout on every frame');
assert.doesNotMatch(composeSource, /void wrapper\.offsetHeight|transitionend/, 'composer resize must not pause on forced reflow or a competing transition event');
assert.match(inputCss, /\.input-actions-row\s*\{[^}]*height:\s*var\(--composer-actions-height\);[^}]*padding:\s*2px 0 2px 10px;/, 'the bottom action rail should keep one fixed height and vertical padding in both states');
assert.doesNotMatch(inputCss, /\.input-area\.composer-collapsed \.input-actions-row\s*\{[^}]*\n\s*height\s*:/, 'collapse must not retime a second action-rail height animation');
assert.match(composeSource, /function preserveComposerExpansionForPanel\([\s\S]*?composerExpandedByInteraction = true;[\s\S]*?syncComposerPresentation\(\);/, 'panel interactions should preserve the expanded composer before editor blur');
assert.match(composeSource, /function armComposerCollapseLock\([\s\S]*?composerCollapseLockSessionId/, 'send should have a session-scoped composer collapse lock');
assert.match(composeSource, /const collapseLocked = isComposerCollapseLockedForCurrentSession\(\)[\s\S]*?const expanded = !pendingForCurrentSession\s*\n\s*&& !collapseLocked/, 'post-send refreshes must not reopen a locked composer');
assert.match(composeSource, /armComposerCollapseLock\(sessionId, requestId\)/, 'normal sends should arm the collapse lock before the pending UI sync');
assert.match(composeSource, /releaseComposerCollapseLock\(\)[\s\S]*?composerExpandedByInteraction = true;/, 'explicit composer interactions should release the post-send collapse lock');
assert.match(composeSource, /if \(pendingForCurrentSession\) \{[\s\S]*?composerExpandedByInteraction = false;[\s\S]*?blurComposerEditorForPendingSend\(\)/, 'transport-pending sends should force the composer closed and release editor focus');
assert.match(composeSource, /inputArea\.classList\.toggle\("composer-send-pending", pendingForCurrentSession\);[\s\S]*?const wasExpanded = inputArea\.classList\.contains\("composer-expanded"\);[\s\S]*?animateComposerSize/, 'pending material must be applied before composer geometry is measured');
assert.match(composeSource, /function focusComposerFromShell\([\s\S]*?isComposerTransportPendingForCurrentSession\(\)\) return;/, 'transport-pending sends should reject compact-shell expansion taps');
assert.match(composeSource, /function syncComposerExpandedOnlyControls\([\s\S]*?getElementById\("composerRuntimeControls"\)[\s\S]*?getElementById\("composerExpandedLeftControls"\)/, 'expanded-only composer controls should share one presence animation path');
assert.match(composeSource, /control\.classList\.add\(expanded \? "composer-control-entering" : "composer-control-exiting"\)/, 'expanded-only controls should animate in both directions');
assert.match(composeSource, /function finishComposerControlPresence\([\s\S]*?control\.hidden = !expanded;/, 'expanded-only controls should become hidden only after the exit animation');
assert.match(composeSource, /control\.inert = true;[\s\S]*?control\.setAttribute\("aria-hidden", "true"\)/, 'expanded-only controls should remain non-interactive during their presence animation');
assert.match(composeSource, /const panelControl = target\.closest\(composerPanelInteractionSelector\);[\s\S]*?if \(!isVisibleComposerControl\(panelControl\)\) return;/, 'hidden runtime controls must not preserve expansion or open a panel');
assert.match(composeSource, /document\.addEventListener\("pointerdown", preserveComposerExpansionForPanel, true\)/, 'panel expansion guard should run in capture phase for portaled menus');
assert.match(composeSource, /const composerPanelOpen = typeof document !== "undefined"[\s\S]*?document\.querySelector\?\.\(composerPanelSelector\)/, 'an already-open portaled panel should keep the composer expanded');
assert.match(composeSource, /function isVisibleComposerControl\([\s\S]*?style\?\.display === "none"[\s\S]*?isVisibleComposerControl\(explicitControl\)/, 'compact shell taps should ignore hidden runtime controls');
assert.match(inputCss, /\.input-area\.composer-collapsed \.composer-runtime-speed-anchor,[\s\S]*?pointer-events:\s*none\s*!important;/, 'hidden runtime controls must not steal compact shell taps');
assert.match(inputCss, /\.input-area\.composer-collapsed \.composer-runtime-controls,[\s\S]*?visibility:\s*hidden\s*!important;[\s\S]*?pointer-events:\s*none\s*!important;/, 'collapsed runtime controls must be absent from the browser hit tree');
assert.match(inputCss, /\.composer-runtime-controls\.composer-control-entering[\s\S]*?animation:\s*composer-expanded-controls-enter-right/, 'runtime controls should enter from the right with an Android-aligned transition');
assert.match(inputCss, /\.composer-expanded-left-controls\.composer-control-entering[\s\S]*?animation:\s*composer-expanded-controls-enter-left/, 'Goal and Plan controls should enter from the left with an Android-aligned transition');
assert.match(inputCss, /@keyframes composer-expanded-controls-enter-right[\s\S]*?clip-path:\s*inset\(0 0 0 100%\);[\s\S]*?clip-path:\s*inset\(0 0 0 0\);/, 'runtime controls should clip reveal smoothly');
assert.match(inputCss, /@keyframes composer-expanded-controls-exit-right[\s\S]*?opacity:\s*0[\s\S]*?clip-path:\s*inset\(0 0 0 100%\);/, 'runtime controls should clip shrink smoothly when collapsing');
assert.match(materialFinishCss, /\.composer-action-btn--upload,[\s\S]*?\.composer-runtime-btn:not\(\.composer-runtime-speed-btn\),[\s\S]*?background:\s*var\(--composer-flat-fill/, 'plus and model controls should share the composer material');
assert.match(materialFinishCss, /\.input-wrapper\s*\{[\s\S]*?box-shadow:\s*var\(--ui-top-control-shadow\)\s*!important;/, 'composer should share the top-control ambient shadow');
assert.match(materialFinishCss, /\.scroll-to-bottom-fab\s*\{[\s\S]*?background:\s*var\(--ui-top-control-surface[\s\S]*?box-shadow:\s*var\(--ui-top-control-shadow\)\s*!important;/, 'return-to-latest should share the top-control material');
assert.match(materialFinishCss, /\.composer-action-btn--upload\s*\{[\s\S]*?margin-left:\s*-4px;[\s\S]*?background:\s*transparent\s*!important;/, 'plus button should be borderless and shifted left');
assert.match(m3TokensCss, /--chat-area-bg:\s*#fafafa;/, 'the light chat canvas should be near-white rather than pure white');

assert.match(inputCss, /\.input-area\.run-active \.send-btn\s*\{[\s\S]*?visibility:\s*hidden;[\s\S]*?opacity:\s*0;[\s\S]*?pointer-events:\s*none;/, 'running sessions must hide the send button without collapsing its slot');
assert.match(inputCss, /\.input-area\.run-active\.has-attachments \.send-btn,[\s\S]*?\.input-area\.run-active\.has-draft \.send-btn\s*\{[\s\S]*?visibility:\s*visible;[\s\S]*?pointer-events:\s*auto;/, 'queued attachments and non-empty drafts should swap Send into the running corner slot');
assert.doesNotMatch(inputCss, /body\.composer-input-focused[^{]*\.input-area\.run-active \.send-btn/, 'textarea focus alone must never reveal Send while a session runs (user decision 2026-08-06)');
assert.match(inputCss, /\.send-stop-slot\s*\{[\s\S]*?position:\s*relative;[\s\S]*?width:\s*36px;[\s\S]*?height:\s*36px;/, 'send and stop should share one reserved corner slot (desktop 36px)');
assert.match(inputCss, /\.input-area\.run-active\.has-draft \.cancel-btn,[\s\S]*?\.input-area\.run-active\.has-attachments \.cancel-btn\s*\{[\s\S]*?visibility:\s*hidden;[\s\S]*?pointer-events:\s*none;/, 'Stop should yield the corner slot to a staged follow-up');
assert.match(responsiveCss, /\.send-stop-slot\s*\{[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px;/, 'the shared corner slot should grow to the 44px mobile touch target');
assert.match(composeSource, /classList\.toggle\("has-attachments"/, 'compose should mark the input area when attachments are queued');
assert.match(composeSource, /classList\.toggle\("has-draft"/, 'compose should mark the input area when the draft is non-empty');
assert.match(composeSource, /typeof syncComposerStopButton === "function"[\s\S]*?syncComposerStopButton\(\);/, 'compose should re-sync the stop button whenever content state flips mid-run');
assert.doesNotMatch(inputCss, /run-active:focus-within \.send-btn/, 'running sessions must not reveal the send button on any composer focus');
assert.doesNotMatch(responsiveCss, /composer-expand-active[^{]*\.input-row textarea \{ padding-right: 56px; \}/, 'expand affordance must not push the text sideways');

assert.match(
  iconsSource,
  /maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3"\/><path d="M21 8V5a2 2 0 0 0-2-2h-3"\/>/,
  'expand icon should be the classic four-corner fullscreen glyph',
);

// ---- Unit contract: the shipped focus toggle toggles only on the textarea ----
const focusFnSource = composeSource.match(/function syncComposerInputFocus\(\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(focusFnSource, 'compose should define syncComposerInputFocus');

function makeClassList() {
  const values = new Set();
  return {
    toggle(token, force) {
      if (typeof force === 'boolean') {
        if (force) values.add(token);
        else values.delete(token);
        return force;
      }
      if (values.has(token)) {
        values.delete(token);
        return false;
      }
      values.add(token);
      return true;
    },
    contains(token) {
      return values.has(token);
    },
  };
}

const focusContext = (() => {
  const fakeMsgInput = { id: 'msgInput' };
  return {
    msgInput: fakeMsgInput,
    document: {
      body: { classList: makeClassList() },
      activeElement: fakeMsgInput,
    },
  };
})();
vm.createContext(focusContext);
vm.runInContext(`${focusFnSource}\nthis.fn = syncComposerInputFocus;`, focusContext, { filename: 'static/chat/compose.js' });
focusContext.fn();
assert.equal(focusContext.document.body.classList.contains('composer-input-focused'), true, 'focusing the textarea should mark the composer focused');
focusContext.document.activeElement = { id: 'imgBtn' };
focusContext.fn();
assert.equal(focusContext.document.body.classList.contains('composer-input-focused'), false, 'focusing the + button should NOT mark the composer focused');
focusContext.document.activeElement = { id: 'sendBtn' };
focusContext.fn();
assert.equal(focusContext.document.body.classList.contains('composer-input-focused'), false, 'focusing the send button should NOT mark the composer focused');

// ---- Browser fixture ----
const styles = [
  'static/chat/chat-base.css',
  'static/chat/chat-input.css',
  'static/chat/chat.css',
  'static/chat/chat-responsive.css',
  'static/chat/chat-glass.css',
  'static/chat/chat-m3-tokens.css',
  'static/chat/chat-m3-components.css',
  'static/chat/chat-material-finish.css',
].map((p) => readFileSync(join(repoRoot, p), 'utf8')).join('\n');

function icon(name, size = '20') {
  const paths = {
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    send: '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>',
    maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
  }[name];
  return `<svg class="rl-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" style="width:${size}px;height:${size}px">${paths}</svg>`;
}

function fixtureHtml({ expandVisible = false, expandBodyClass = false, value = '', runActive = false, focused = false, hasAttachments = false, hasDraft = false, height = '23px' } = {}) {
  // Real JS state: realtime.js toggles run-active on the input area while a
  // run is in progress and syncs the stop button (is-visible = run-active
  // and no staged follow-up); compose.js toggles composer-input-focused on
  // document.body only while the textarea itself is focused, and
  // has-attachments / has-draft on the input area when files are queued or
  // the draft is non-empty — a staged follow-up swaps Send into the corner
  // slot that Stop would otherwise own (user decision 2026-08-06).
  const bodyClasses = [expandBodyClass ? 'composer-expand-active' : '', focused ? 'composer-input-focused' : ''].filter(Boolean).join(' ');
  const running = [runActive ? 'run-active' : '', hasAttachments ? 'has-attachments' : '', hasDraft ? 'has-draft' : ''].filter(Boolean).join(' ');
  const composerExpanded = expandVisible || focused || hasDraft || hasAttachments;
  const composerState = composerExpanded ? 'composer-expanded' : 'composer-collapsed';
  const sendVisible = hasDraft || hasAttachments;
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>${styles}</style>
<style>
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; display: flex; background: var(--bg); color: var(--text); font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  .visual-chat { display: grid; grid-template-rows: minmax(0, 1fr) auto; height: 100%; flex: 1; min-width: 0; }
  #messages { overflow-y: auto; }
  #messagesInner { padding: 16px 12px; display: grid; gap: 18px; }
  .visual-assistant { max-width: 80%; padding: 11px 16px; border-radius: 20px; border-bottom-left-radius: 6px; background: var(--surface-hover); color: var(--text); font-size: 15px; line-height: 1.55; }
  .input-area { margin-right: 0; }
  .queued-chip { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 999px; background: var(--surface-hover); color: var(--text-secondary); font-size: 13px; }
</style></head>
<body class="${bodyClasses}">
  <div class="visual-chat">
    <div class="messages" id="messages">
      <div class="messages-inner" id="messagesInner">
        <div class="visual-assistant">好的，任务已开始执行。完成后我会汇总结果给你。</div>
        <div class="visual-assistant">已处理 3 个文件，继续处理剩余部分。</div>
      </div>
    </div>
    <div class="input-area ${running} ${composerState}" id="inputArea">
      <div class="input-stack">
        ${hasAttachments ? '<div class="queued-panel visible"><div class="queued-chip">1 个附件</div></div>' : ''}
        <div class="input-wrapper">
          <div class="input-row">
            <textarea class="composer-markdown-editor" id="msgInput" placeholder="发消息…" style="height:${height}">${value}</textarea>
            <button class="composer-expand-btn" id="composerExpandBtn" type="button" ${expandVisible ? '' : 'hidden'} title="Expand full-screen input" aria-label="Expand full-screen input">
              <span class="composer-expand-btn-icon" aria-hidden="true">${icon('maximize')}</span>
            </button>
          </div>
          <div class="input-actions-row">
            <div class="input-actions-group input-actions-group--add">
              <button class="composer-action-btn composer-action-btn--upload" id="imgBtn" type="button" title="Add" aria-label="Add">
                <span class="img-btn-icon" aria-hidden="true">${icon('plus', '16')}</span>
                <span class="img-btn-label sr-only">Add</span>
              </button>
            </div>
            <div class="input-actions-group right">
              <div class="composer-runtime-controls" id="composerRuntimeControls" aria-label="Runtime controls">
                <button class="composer-runtime-btn" id="composerRuntimeBtn" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="composerRuntimeMenu">
                  <span id="composerRuntimeLabel">default</span>
                  <span class="composer-runtime-caret" aria-hidden="true"></span>
                </button>
              </div>
              <div class="send-stop-slot">
                <button class="send-btn${sendVisible ? ' is-visible' : ''}" id="sendBtn" title="Send" aria-label="Send">${icon('send')}</button>
                <button class="cancel-btn ${runActive ? 'is-visible' : ''}" id="cancelBtn" title="Stop" aria-label="Stop" style="${runActive ? '' : 'display:none'}"></button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</body></html>`;
}

const scenarios = [
  { name: '390-idle-light', width: 390, height: 844, colorScheme: 'light', opts: {} },
  { name: '390-idle-dark', width: 390, height: 844, colorScheme: 'dark', opts: {} },
  { name: '430-idle-light', width: 430, height: 932, colorScheme: 'light', opts: {} },
  { name: '1024-idle-light', width: 1024, height: 768, colorScheme: 'light', opts: {} },
  {
    name: '390-cap-expand-light', width: 390, height: 844, colorScheme: 'light',
    opts: { expandVisible: true, expandBodyClass: true, height: '124px', value: '第一行\n第二行\n第三行\n第四行\n第五行\n第六行内容比较长用来验证换行' },
  },
  {
    name: '390-cap-expand-dark', width: 390, height: 844, colorScheme: 'dark',
    opts: { expandVisible: true, expandBodyClass: true, height: '124px', value: '第一行\n第二行\n第三行\n第四行\n第五行\n第六行内容比较长用来验证换行' },
  },
  // Running: Stop owns the corner slot; a staged follow-up swaps Send in.
  { name: '390-running-empty-light', width: 390, height: 844, colorScheme: 'light', opts: { runActive: true, height: '23px', value: '' } },
  { name: '390-running-empty-dark', width: 390, height: 844, colorScheme: 'dark', opts: { runActive: true, height: '23px', value: '' } },
  { name: '390-running-focused-empty-light', width: 390, height: 844, colorScheme: 'light', opts: { runActive: true, focused: true, height: '23px', value: '' } },
  { name: '390-running-draft-light', width: 390, height: 844, colorScheme: 'light', opts: { runActive: true, hasDraft: true, height: '47px', value: '运行中暂存的下一条消息' } },
  { name: '430-running-draft-dark', width: 430, height: 932, colorScheme: 'dark', opts: { runActive: true, hasDraft: true, height: '47px', value: '运行中暂存的下一条消息' } },
  { name: '390-running-attachments-light', width: 390, height: 844, colorScheme: 'light', opts: { runActive: true, hasAttachments: true, height: '23px', value: '' } },
];

const browser = await chromium.launch({ headless: true });
try {
  const allMetrics = {};
  for (const s of scenarios) {
    const page = await browser.newPage({ viewport: { width: s.width, height: s.height }, colorScheme: s.colorScheme });
    await page.setContent(fixtureHtml(s.opts), { waitUntil: 'load' });
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(outputDir, `${s.name}.png`) });

    const m = await page.evaluate(() => {
      const ta = document.getElementById('msgInput');
      const wrap = document.querySelector('.input-wrapper');
      const row = document.querySelector('.input-row');
      const actions = document.querySelector('.input-actions-row');
      const btn = document.getElementById('composerExpandBtn');
      const send = document.getElementById('sendBtn');
      const cancel = document.getElementById('cancelBtn');
      const taRect = ta.getBoundingClientRect();
      const wrapRect = wrap.getBoundingClientRect();
      const actionsRect = actions.getBoundingClientRect();
      const btnRect = btn.getBoundingClientRect();
      const taStyle = getComputedStyle(ta);
      const shadowIdle = getComputedStyle(wrap).boxShadow;
      // Send/stop visibility must be read in the scenario's own state: the
      // ring probe below mutates body.composer-input-focused, so snapshot
      // these before it runs.
      const sendStyle = getComputedStyle(send);
      const cancelStyle = getComputedStyle(cancel);
      const sendDisplay = sendStyle.display;
      const sendVisibility = sendStyle.visibility;
      const sendOpacity = sendStyle.opacity;
      const sendPointerEvents = sendStyle.pointerEvents;
      const cancelDisplay = cancelStyle.display;
      const cancelVisibility = cancelStyle.visibility;
      // Send and Stop share one corner slot: both must be centered on it.
      // Send fills the slot; collapsed Stop keeps the same center while
      // breathing inside the mobile touch target.
      const slot = document.querySelector('.send-stop-slot');
      const slotRect = slot.getBoundingClientRect();
      const sendRect = send.getBoundingClientRect();
      const cancelRect = cancel.getBoundingClientRect();
      const near = (a, b) => Math.abs(a - b) < 1.5;
      const sendCentered = near(sendRect.left + sendRect.width / 2, slotRect.left + slotRect.width / 2)
        && near(sendRect.top + sendRect.height / 2, slotRect.top + slotRect.height / 2);
      const cancelCentered = near(cancelRect.left + cancelRect.width / 2, slotRect.left + slotRect.width / 2)
        && near(cancelRect.top + cancelRect.height / 2, slotRect.top + slotRect.height / 2);
      const cancelFillsSlot = near(cancelRect.width, slotRect.width) && near(cancelRect.height, slotRect.height);
      const cancelCompact = near(cancelRect.width, 32) && near(cancelRect.height, 32);
      const sendFillsSlot = near(sendRect.width, slotRect.width) && near(sendRect.height, slotRect.height);

      // The wrapper surface must stay identical whether the textarea or a
      // sibling composer control is focused.
      document.getElementById('imgBtn').focus();
      const shadowAfterPlus = getComputedStyle(wrap).boxShadow;
      const plusIsFocusable = document.activeElement.id;

      document.body.classList.remove('composer-input-focused');
      const shadowWithoutClass = getComputedStyle(wrap).boxShadow;
      document.body.classList.add('composer-input-focused');
      const shadowWithFocusClass = getComputedStyle(wrap).boxShadow;

      return {
        taHeight: Math.round(taRect.height),
        wrapperHeight: Math.round(wrapRect.height),
        wrapperWidth: Math.round(wrapRect.width),
        taTopInset: Math.round(taRect.top - wrapRect.top),
        taLeftInset: Math.round(taRect.left - wrapRect.left),
        taRightInset: Math.round(wrapRect.right - taRect.right),
        bottomGap: Math.round(actionsRect.top - taRect.bottom),
        taPaddingRight: taStyle.paddingRight,
        expandHidden: btn.hidden,
        expandWidth: Math.round(btnRect.width),
        expandHeight: Math.round(btnRect.height),
        expandOverlapsText: btnRect.left < taRect.right && btnRect.top < taRect.bottom,
        sendDisplay,
        sendVisibility,
        sendOpacity,
        sendPointerEvents,
        cancelDisplay,
        cancelVisibility,
        slotWidth: Math.round(slotRect.width),
        slotHeight: Math.round(slotRect.height),
        sendCentered,
        cancelCentered,
        cancelFillsSlot,
        cancelCompact,
        sendFillsSlot,
        plusIsFocusable,
        shadowIdle,
        shadowAfterPlus,
        shadowWithoutClass,
        shadowWithFocusClass,
      };
    });
    allMetrics[s.name] = m;

    if (s.name.includes('idle')) {
      assert.ok(m.wrapperWidth < s.width - 32, `${s.name}: collapsed capsule should be narrower than the expanded work area, got ${m.wrapperWidth}px at ${s.width}px viewport`);
      const compactHeight = 45;
      assert.ok(
        m.wrapperHeight >= compactHeight - 1 && m.wrapperHeight <= compactHeight + 1,
        `${s.name}: collapsed composer should use the compact ${compactHeight}px height, got ${m.wrapperHeight}px`,
      );
      assert.ok(m.taHeight <= 26, `${s.name}: empty composer should stay at a single line, got ${m.taHeight}px`);
      assert.ok(m.taTopInset >= 10 && m.taTopInset <= 24, `${s.name}: collapsed editor should be centered in the bottom action row, got top inset ${m.taTopInset}px`);
      assert.ok(m.taLeftInset >= 48, `${s.name}: collapsed editor should reserve the pinned add control`);
      assert.ok(
        s.opts.runActive ? m.taRightInset >= 48 : m.taRightInset >= 12,
        `${s.name}: collapsed editor should reserve the visible right-side action when one exists`,
      );
      assert.equal(m.slotWidth, s.width >= 1024 ? 36 : 44, `${s.name}: the shared corner slot should match the desktop/mobile touch target, got ${m.slotWidth}px`);
      assert.equal(m.shadowAfterPlus, m.shadowIdle, `${s.name}: focusing the + button must not light up the composer ring`);
      assert.equal(m.shadowWithoutClass, m.shadowIdle, `${s.name}: without the focus class there should be no composer ring`);
      assert.equal(m.shadowWithFocusClass, m.shadowIdle, `${s.name}: textarea focus must keep the composer wrapper identical to idle`);
    }
    if (s.name.includes('cap-expand')) {
      assert.ok(m.wrapperWidth >= s.width - 34, `${s.name}: expanded composer should reclaim the horizontal inset, got ${m.wrapperWidth}px at ${s.width}px viewport`);
      assert.equal(m.taPaddingRight, '0px', `${s.name}: the expand affordance must not push the text sideways`);
      assert.equal(m.expandHidden, false, `${s.name}: expand button should be visible at the auto-grow cap`);
      assert.ok(m.expandWidth >= 44 && m.expandHeight >= 44, `${s.name}: expand button must stay a 44px touch target`);
      assert.equal(m.expandOverlapsText, true, `${s.name}: expand button should float over the textarea's top-right corner`);
    }
    if (s.name.includes('running')) {
      assert.equal(m.slotWidth, 44, `${s.name}: the shared corner slot must stay the 44px mobile touch target, got ${m.slotWidth}px`);
      if (s.opts.focused) {
        assert.equal(m.sendDisplay, 'flex', `${s.name}: the send button should stay mounted while a run is active`);
        assert.equal(m.sendVisibility, 'hidden', `${s.name}: focusing an empty composer during a run must NOT reveal the send button (user decision 2026-08-06)`);
        assert.equal(m.sendOpacity, '0', `${s.name}: the unrevealed send button must stay transparent`);
        assert.equal(m.sendPointerEvents, 'none', `${s.name}: the unrevealed send button must not intercept taps`);
        assert.equal(m.cancelVisibility, 'visible', `${s.name}: Stop should own the corner slot while the focused composer is empty`);
        assert.equal(m.cancelCentered, true, `${s.name}: Stop should sit in the shared corner slot`);
        assert.equal(m.cancelFillsSlot, true, `${s.name}: expanded Stop should fill the shared corner slot`);
      } else if (s.opts.hasDraft) {
        assert.equal(m.sendDisplay, 'flex', `${s.name}: a non-empty draft during a run should swap Send into the corner slot`);
        assert.equal(m.sendVisibility, 'visible', `${s.name}: a non-empty draft should reveal the send slot`);
        assert.equal(m.sendOpacity, '1', `${s.name}: a non-empty draft should restore send opacity`);
        assert.equal(m.sendFillsSlot, true, `${s.name}: Send should occupy the shared corner slot`);
        assert.equal(m.cancelVisibility, 'hidden', `${s.name}: Stop must yield the corner slot to a staged draft`);
      } else if (s.opts.hasAttachments) {
        assert.equal(m.sendDisplay, 'flex', `${s.name}: queued attachments during a run should swap Send into the corner slot`);
        assert.equal(m.sendVisibility, 'visible', `${s.name}: queued attachments should reveal the send slot`);
        assert.equal(m.sendFillsSlot, true, `${s.name}: Send should occupy the shared corner slot`);
        assert.equal(m.cancelVisibility, 'hidden', `${s.name}: Stop must yield the corner slot to queued attachments`);
      } else {
        assert.equal(m.sendDisplay, 'flex', `${s.name}: the send slot must stay mounted while a run is active`);
        assert.equal(m.sendVisibility, 'hidden', `${s.name}: the send button must stay hidden while a run is active with an empty draft and no focus`);
        assert.equal(m.sendOpacity, '0', `${s.name}: the hidden send button must be transparent at rest`);
        assert.equal(m.sendPointerEvents, 'none', `${s.name}: the hidden send button must not intercept taps at rest`);
        assert.equal(m.cancelVisibility, 'visible', `${s.name}: Stop should own the corner slot at rest`);
        assert.equal(m.cancelCentered, true, `${s.name}: Stop should sit in the shared corner slot`);
        assert.equal(m.cancelCompact, true, `${s.name}: collapsed Stop should breathe inside the shared corner slot`);
      }
      assert.equal(m.cancelDisplay, 'flex', `${s.name}: the stop button should stay mounted while a run is active`);
    }
    await page.close();
  }
  writeFileSync(join(outputDir, 'metrics.json'), JSON.stringify(allMetrics, null, 2));
  console.log(`composer focus/expand visual: ok (${scenarios.length} scenarios)`);
  console.log(`screenshots: ${outputDir}`);
} finally {
  await browser.close();
}
if (!requestedOutputDir) rmSync(outputDir, { recursive: true, force: true });
