#!/usr/bin/env node
// Full-screen composer tests (WeChat-style expanded input on mobile).
// Behavior (Playwright, real DOM fixture): expand affordance visibility at
// the auto-grow cap, open/close lifecycle, draft sync in both directions,
// send routing through the main composer, sendBtn-disabled collapse.
// Static: module wiring, i18n keys, mobile max-height cap, icon presence.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const [moduleSource, backHandlerSource, composeSource, inputCss, responsiveCss, chatTemplate, iconsSource, i18nSource, bootstrapSource, sidebarUiSource, toolingSource] =
  await Promise.all([
    readFile(join(repoRoot, 'static/chat/composer-fullscreen.js'), 'utf8'),
    readFile(join(repoRoot, 'static/chat/back-handler.js'), 'utf8'),
    readFile(join(repoRoot, 'static/chat/compose.js'), 'utf8'),
    readFile(join(repoRoot, 'static/chat/chat-input.css'), 'utf8'),
    readFile(join(repoRoot, 'static/chat/chat-responsive.css'), 'utf8'),
    readFile(join(repoRoot, 'templates/chat.html'), 'utf8'),
    readFile(join(repoRoot, 'static/chat/icons.js'), 'utf8'),
    readFile(join(repoRoot, 'static/chat/i18n.js'), 'utf8'),
    readFile(join(repoRoot, 'static/chat/bootstrap.js'), 'utf8'),
    readFile(join(repoRoot, 'static/chat/sidebar-ui.js'), 'utf8'),
    readFile(join(repoRoot, 'static/chat/tooling.js'), 'utf8'),
  ]);

// ---- Static wiring ----

assert.match(
  chatTemplate,
  /<script src="chat\/composer-fullscreen\.js\?v=\{\{ASSET_VERSION\}\}" nonce="\{\{NONCE\}\}"><\/script>/,
  'chat.html should include the full-screen composer module',
);
assert.match(
  chatTemplate,
  /id="composerExpandBtn"[\s\S]*?data-icon="maximize"/,
  'the expand affordance should use the maximize icon',
);
assert.match(
  chatTemplate,
  /id="composerFullscreen"[\s\S]*?role="dialog" aria-modal="true"/,
  'the full-screen layer should be a modal dialog',
);
assert.match(
  moduleSource,
  /window\.RagentBackHandler\?\.push\?\.\(\{[\s\S]*?id: "composer-fullscreen",[\s\S]*?onBack:/,
  'opening the composer should register with the shared back handler',
);
assert.match(
  moduleSource,
  /window\.RagentBackHandler\?\.pop\?\.\(backEntryId\);/,
  'a user-initiated close should unregister from the shared back handler',
);
assert.match(
  responsiveCss,
  /@media\s*\(max-width:\s*767px\)\s*\{[\s\S]*?\.input-row textarea \{\s*max-height:\s*calc\(1\.55em \* 5 \+ 8px\);[\s\S]*?\}/,
  'mobile should cap auto-grow at 5 lines with breathing room',
);
assert.match(
  inputCss,
  /\.composer-expand-btn\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?top:\s*8px;[\s\S]*?right:\s*8px;/,
  'the expand affordance should float over the textarea top-right corner (the text does not yield its edge)',
);
assert.match(
  composeSource,
  /INPUT_AUTO_MAX_LINES_MOBILE = 5;/,
  'compose should share the 5-line mobile cap',
);
assert.match(
  composeSource,
  /window\.RagentComposerFullscreen\?\.sync\?\.\(\);/,
  'auto-resize should re-evaluate the expand affordance',
);
assert.match(
  inputCss,
  /\.composer-expand-btn\s*\{[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px;[\s\S]*?border-radius:\s*50%;[\s\S]*?touch-action:\s*manipulation;/,
  'the expand affordance should be a 44px circular touch target with no double-tap zoom delay',
);
assert.match(
  inputCss,
  /\.composer-fullscreen\s*\{[\s\S]*?overscroll-behavior:\s*contain;/,
  'the full-screen layer should contain its own scroll',
);
assert.match(
  inputCss,
  /\.composer-fullscreen-topbar\s*\{[\s\S]*?padding:\s*calc\(4px \+ env\(safe-area-inset-top,\s*0px\)\) 8px 4px;/,
  'the full-screen topbar should clear the device notch',
);
assert.match(
  inputCss,
  /\.composer-expand-btn:focus-visible,[\s\S]*?\.composer-fullscreen-send:focus-visible\s*\{/,
  'the new controls should carry explicit focus-visible rings',
);
assert.match(
  inputCss,
  /\.composer-fullscreen\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?z-index:\s*300;[\s\S]*?transform-origin:\s*center bottom;/,
  'the full-screen layer should sit above every sheet and grow from the bottom',
);
assert.match(
  inputCss,
  /\.composer-fullscreen\.is-open\s*\{\s*animation:\s*composer-fullscreen-rise var\(--motion-enter\) var\(--motion-ease-emphasized\);/,
  'the expand animation should use the shared enter motion token',
);
assert.match(
  inputCss,
  /\.composer-fullscreen\.is-closing\s*\{\s*animation:\s*composer-fullscreen-out var\(--motion-exit\) var\(--motion-ease-standard\);/,
  'the collapse animation should use the shared exit motion token',
);
assert.match(
  iconsSource,
  /maximize: '/,
  'icons should provide the maximize glyph',
);
assert.match(
  i18nSource,
  /"compose\.expand\.label": "全屏输入"/,
  'i18n should carry the Chinese expand label',
);
assert.match(
  i18nSource,
  /"compose\.expand\.label": "Expand full-screen input"/,
  'i18n should carry the English expand label',
);

// ---- Re-parented controls + consistent send (user decision 2026-08-06) ----

assert.match(
  chatTemplate,
  /<div class="composer-fullscreen-actions-left" id="composerFullscreenActionsLeft"><\/div>/,
  'fullscreen actions should host a left group for the re-parented add/runtime controls',
);
assert.match(
  chatTemplate,
  /<button class="[^"]*composer-fullscreen-send[^"]*" id="composerFullscreenSendBtn"/,
  'the fullscreen send button should reuse the inline composer .send-btn look',
);
assert.match(
  moduleSource,
  /document\.body\.classList\.add\("composer-fullscreen-open"\);/,
  'opening should mark the body so portaled menus can clear the overlay z-index',
);
assert.match(
  moduleSource,
  /document\.body\.classList\.remove\("composer-fullscreen-open"\);/,
  'closing should clear the body marker',
);
assert.match(
  moduleSource,
  /adoptControls\(\);[\s\S]*?startSendDisabledSync\(\);/,
  'opening should adopt the add/runtime controls and mirror send disabled state',
);
assert.match(
  moduleSource,
  /closeOpenMenus\(\);\s*\n\s*restoreControls\(\);\s*\n\s*stopSendDisabledSync\(\);/,
  'closing should collapse leftover menus, restore the controls, and stop the disabled observer',
);
assert.match(
  bootstrapSource,
  /document\.body\.classList\.contains\("composer-fullscreen-open"\)[\s\S]*?320/,
  'portaled menus should clear the fullscreen overlay z-index (300) while it is open',
);
assert.match(
  sidebarUiSource,
  /window\.RagentComposerAddMenu = Object\.freeze\(\{ close: closeComposerAddMenu \}\);/,
  'the add menu should expose a closer for the fullscreen collapse path',
);
assert.match(
  toolingSource,
  /window\.RagentComposerRuntimeMenu = Object\.freeze\(\{[\s\S]*?close: \(\) => setComposerRuntimeMenuOpen\(false\),[\s\S]*?\}\);/,
  'the runtime menu should expose a closer for the fullscreen collapse path',
);

// ---- Behavior (Playwright, real DOM) ----

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.setContent(`<!doctype html><html><head><style>
    ${inputCss}
    ${responsiveCss}
    body { margin: 0; min-height: 844px; background: #f5f5f6; }
    .input-area { position: fixed; bottom: 0; left: 0; right: 0; }
    .input-row { max-width: 480px; margin: 0 auto; }
    .input-actions-row { display: none; }
    .send-btn { display: none; }
  </style></head><body>
    <div class="input-area" id="inputArea">
      <div class="input-wrapper">
        <div class="input-row">
          <textarea id="msgInput" style="min-height:calc(1.55em * 3)"></textarea>
          <button class="composer-expand-btn" id="composerExpandBtn" type="button" hidden>
            <span class="composer-expand-btn-icon" data-icon="maximize" aria-hidden="true"></span>
          </button>
        </div>
        <div class="input-actions-row" id="inputActionsRow">
          <button class="composer-action-btn composer-action-btn--upload" id="imgBtn" type="button" aria-controls="composerAddMenu" aria-expanded="false"><span class="img-btn-icon" data-icon="plus"></span></button>
          <button class="composer-runtime-btn" id="composerRuntimeBtn" type="button" aria-haspopup="menu" aria-expanded="false"><span id="composerRuntimeLabel">default</span></button>
        </div>
      </div>
      <button class="send-btn" id="sendBtn" type="button" data-icon="send" disabled>Send</button>
    </div>
    <div class="composer-fullscreen" id="composerFullscreen" hidden>
      <div class="composer-fullscreen-topbar">
        <button class="composer-fullscreen-close" id="composerFullscreenCloseBtn" type="button">
          <span data-icon="chevron-down" aria-hidden="true"></span>
        </button>
      </div>
      <textarea class="composer-fullscreen-textarea" id="composerFullscreenInput"></textarea>
      <div class="composer-fullscreen-actions">
        <div class="composer-fullscreen-actions-left" id="composerFullscreenActionsLeft"></div>
        <button class="send-btn composer-fullscreen-send" id="composerFullscreenSendBtn" type="button"></button>
      </div>
    </div>
    <script>
      window.RagentMotion = {
        setPresence: (el, open, opts) => {
          el.hidden = !open;
          el.classList.toggle('is-open', open);
          el.classList.toggle('is-closing', !open);
          if (open && opts?.onAfterOpen) opts.onAfterOpen();
          if (!open && opts?.onAfterClose) opts.onAfterClose();
        },
      };
      const msgInput = document.getElementById('msgInput');
      msgInput.addEventListener('input', () => {
        const maxH = parseFloat(getComputedStyle(msgInput).maxHeight) || Infinity;
        const newH = Math.min(msgInput.scrollHeight, maxH);
        msgInput.style.height = newH + 'px';
        window.RagentComposerFullscreen?.sync?.();
      });
      document.getElementById('sendBtn').addEventListener('click', () => {
        window.__sentText = document.getElementById('msgInput').value;
        document.getElementById('msgInput').value = '';
      });
      window.__menuCloses = { add: 0, runtime: 0 };
      window.RagentComposerAddMenu = { close: () => { window.__menuCloses.add++; } };
      window.RagentComposerRuntimeMenu = { close: () => { window.__menuCloses.runtime++; } };
    </script>
  </body></html>`);
  await page.addScriptTag({ content: backHandlerSource });
  await page.addScriptTag({ content: moduleSource });

  const nineLines = (Array.from({ length: 9 }, () => "long line of text")).join("\n");

  // 1. Below the cap: no affordance. At/over the cap: affordance appears.
  const capStates = await page.evaluate(({ nineLines }) => {
    const input = document.getElementById('msgInput');
    const btn = document.getElementById('composerExpandBtn');
    input.value = '';
    input.dispatchEvent(new Event('input'));
    const below = btn.hidden;
    input.value = nineLines;
    input.dispatchEvent(new Event('input'));
    const atCap = btn.hidden;
    return { below, atCap };
  }, { nineLines });
  assert.deepEqual(capStates, { below: true, atCap: false }, 'the affordance should appear only at the auto-grow cap');

  // 2. Open: value copied, layer visible, input focused.
  await page.evaluate(() => {
    document.getElementById('msgInput').value = 'draft from main composer';
    window.RagentComposerFullscreen.open();
  });
  const opened = await page.evaluate(() => ({
    visible: !document.getElementById('composerFullscreen').hidden,
    copied: document.getElementById('composerFullscreenInput').value,
    focused: document.activeElement === document.getElementById('composerFullscreenInput'),
    affordanceHidden: document.getElementById('composerExpandBtn').hidden,
  }));
  assert.deepEqual(opened, {
    visible: true,
    copied: 'draft from main composer',
    focused: true,
    affordanceHidden: true,
  }, 'open should copy the draft, show the layer, focus the input, hide the affordance');

  // 3. Typing full-screen live-syncs into the main composer (draft pipeline).
  const synced = await page.evaluate(async () => {
    const fsInput = document.getElementById('composerFullscreenInput');
    fsInput.value = 'typed in full screen';
    fsInput.dispatchEvent(new Event('input'));
    return document.getElementById('msgInput').value;
  });
  assert.equal(synced, 'typed in full screen', 'full-screen typing should feed the main composer draft');

  // 4. Collapse writes back without losing content.
  const collapsed = await page.evaluate(async () => {
    document.getElementById('composerFullscreenCloseBtn').click();
    await new Promise((r) => setTimeout(r, 260));
    return {
      hidden: document.getElementById('composerFullscreen').hidden,
      mainValue: document.getElementById('msgInput').value,
    };
  });
  assert.deepEqual(collapsed, { hidden: true, mainValue: 'typed in full screen' }, 'collapse should hand the draft back');

  // 5. Send routes through the main composer: text lands in sendBtn path
  //    and the layer collapses without write-back.
  await page.evaluate(() => {
    document.getElementById('sendBtn').disabled = false;
    document.getElementById('msgInput').value = 'second draft';
    window.RagentComposerFullscreen.open();
    document.getElementById('composerFullscreenInput').value = 'sent full-screen';
    document.getElementById('composerFullscreenSendBtn').click();
  });
  const sent = await page.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 260));
    return {
      sentText: window.__sentText,
      layerHidden: document.getElementById('composerFullscreen').hidden,
      mainValue: document.getElementById('msgInput').value,
    };
  });
  assert.deepEqual(sent, {
    sentText: 'sent full-screen',
    layerHidden: true,
    mainValue: '',
  }, 'send should route the full-screen text through the standard path and clear');

  // 6. Disabled sendBtn: collapse keeps the draft instead of sending.
  await page.evaluate(() => {
    document.getElementById('msgInput').value = 'keep me';
    window.RagentComposerFullscreen.open();
    document.getElementById('composerFullscreenInput').value = 'keep me';
    window.__sentText = undefined;
  });
  await page.evaluate(() => {
    document.getElementById('sendBtn').disabled = true;
    document.getElementById('composerFullscreenSendBtn').click();
  });
  const disabledSend = await page.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 260));
    return {
      sentText: window.__sentText,
      layerHidden: document.getElementById('composerFullscreen').hidden,
      mainValue: document.getElementById('msgInput').value,
    };
  });
  assert.deepEqual(disabledSend, {
    sentText: undefined,
    layerHidden: true,
    mainValue: 'keep me',
  }, 'a disabled send button should collapse without losing the draft');

  // 7. Escape collapses.
  await page.evaluate(() => {
    window.RagentComposerFullscreen.open();
  });
  const escCollapsed = await page.evaluate(async () => {
    document.getElementById('composerFullscreenInput').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await new Promise((r) => setTimeout(r, 260));
    return document.getElementById('composerFullscreen').hidden;
  });
  assert.equal(escCollapsed, true, 'Escape should collapse the layer');

  // 8. Android back button: history.back() fires popstate and collapses
  //    the layer, handing the draft back (WeChat-style first-back).
  await page.evaluate(() => {
    document.getElementById('msgInput').value = 'back draft';
    window.RagentComposerFullscreen.open();
    document.getElementById('composerFullscreenInput').value = 'typed before back';
  });
  await page.goBack();
  const backCollapsed = await page.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 260));
    return {
      hidden: document.getElementById('composerFullscreen').hidden,
      mainValue: document.getElementById('msgInput').value,
    };
  });
  assert.deepEqual(backCollapsed, {
    hidden: true,
    mainValue: 'typed before back',
  }, 'Android back should collapse the composer and keep the draft');

  // 9. User-initiated close unwinds the history entry: a subsequent back
  //    must not re-trigger anything (layer stays closed, no errors).
  await page.evaluate(() => {
    document.getElementById('msgInput').value = 'after unwind';
    window.RagentComposerFullscreen.open();
  });
  await page.evaluate(() => {
    document.getElementById('composerFullscreenCloseBtn').click();
  });
  await new Promise((r) => setTimeout(r, 260));
  await page.goBack();
  const afterUnwind = await page.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 120));
    return {
      hidden: document.getElementById('composerFullscreen').hidden,
      mainValue: document.getElementById('msgInput').value,
    };
  });
  assert.deepEqual(afterUnwind, {
    hidden: true,
    mainValue: 'after unwind',
  }, 'after a user close, back should not re-open or alter the composer');

  // 10. Opening re-parents the add/runtime controls into the fullscreen bar
  //     and mirrors the inline send button's disabled state.
  await page.evaluate(() => {
    document.getElementById('sendBtn').disabled = false;
    document.getElementById('msgInput').value = 'controls test';
    window.__menuCloses = { add: 0, runtime: 0 };
    window.RagentComposerFullscreen.open();
  });
  const adopted = await page.evaluate(() => {
    const left = document.getElementById('composerFullscreenActionsLeft');
    const row = document.getElementById('inputActionsRow');
    return {
      bodyMarked: document.body.classList.contains('composer-fullscreen-open'),
      imgInLeft: document.getElementById('imgBtn').parentNode === left,
      runtimeInLeft: document.getElementById('composerRuntimeBtn').parentNode === left,
      imgNotInRow: !row.contains(document.getElementById('imgBtn')),
      sendDisabledMirrored: document.getElementById('composerFullscreenSendBtn').disabled === false,
    };
  });
  assert.deepEqual(adopted, {
    bodyMarked: true,
    imgInLeft: true,
    runtimeInLeft: true,
    imgNotInRow: true,
    sendDisabledMirrored: true,
  }, 'opening should move the add/runtime controls into the fullscreen bar and mirror send disabled');

  // The disabled mirror tracks the inline button the other way too.
  const mirroredDisabled = await page.evaluate(async () => {
    document.getElementById('sendBtn').disabled = true;
    await new Promise((r) => setTimeout(r, 60));
    return document.getElementById('composerFullscreenSendBtn').disabled;
  });
  assert.equal(mirroredDisabled, true, 'disabling the inline send should disable the fullscreen send via the observer');

  // 11. Closing restores the controls to their original parent and collapses
  //     any menu left open from the re-parented triggers.
  await page.evaluate(() => {
    document.getElementById('sendBtn').disabled = false;
    window.__menuCloses = { add: 0, runtime: 0 };
    document.getElementById('composerFullscreenCloseBtn').click();
  });
  const restored = await page.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 260));
    const row = document.getElementById('inputActionsRow');
    return {
      hidden: document.getElementById('composerFullscreen').hidden,
      bodyMarked: document.body.classList.contains('composer-fullscreen-open'),
      imgInRow: row.contains(document.getElementById('imgBtn')),
      runtimeInRow: row.contains(document.getElementById('composerRuntimeBtn')),
      menuCloses: window.__menuCloses,
    };
  });
  assert.deepEqual(restored, {
    hidden: true,
    bodyMarked: false,
    imgInRow: true,
    runtimeInRow: true,
    menuCloses: { add: 1, runtime: 1 },
  }, 'close should restore the controls, clear the body marker, and collapse leftover menus');
} finally {
  await browser.close();
}

console.log('test-chat-composer-fullscreen: ok');
