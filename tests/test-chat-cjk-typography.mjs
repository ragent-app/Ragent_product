#!/usr/bin/env node
// CJK prose typography probe (P2) — numeric assertions for the pure-CSS
// Chinese reading polish applied in static/chat/chat-messages.css.
//
// Verifies, on the REAL css stack, at mobile widths 360/390/430:
//   1. line-height of message body text lands in the CJK range [1.6, 1.75];
//   2. no closing punctuation (，。！？；：、”』】）…) ever starts a wrapped
//      line (native CJK kinsoku line breaking) — counted per line start;
//   3. CJK <-> Latin/digit inter-script spacing is applied (text-autospace on
//      supporting engines, light letter-spacing fallback elsewhere) — measured
//      as total advance-width delta vs a no-autospace control;
//   4. the code path stays optically clean: pre/code opt out of spacing;
//   5. no horizontal overflow on any line (page must never pan horizontally);
//   6. hanging-punctuation: allow-end is declared for Safari (Chrome lacks it —
//      verified inert; asserted via stylesheet source, not computed style).
//
// Produces 360/390/430 PNGs for Gemini visual review.
//
// Run standalone:  node tests/test-chat-cjk-typography.mjs
// (PNGs + manifest land in /var/lib/ragent/workspace/cjk-typography-visual/<stamp>)
import assert from 'assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '@playwright/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const cssFiles = [
  'static/chat/chat-base.css',
  'static/chat/chat-messages.css',
];
const styles = cssFiles.map((p) => readFileSync(join(repoRoot, p), 'utf8')).join('\n');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outputDir = process.env.RAGENT_VISUAL_OUTPUT_DIR
  || join('/var/lib/ragent/workspace/cjk-typography-visual', stamp);
mkdirSync(outputDir, { recursive: true });

// Long mixed-script paragraph: Chinese + English + digits + punctuation.
// Must wrap into several lines at every mobile width we test.
const LONG_PARA = '这是一段用于验证中文排版的测试文本，包含English单词和数字12345以及各种标点符号，例如：句号。逗号，感叹号！问号？分号；以及引号“双引号”和『直角引号』。中文与拉丁混排需要合理的间距，避免中文English挤在一起，也要避免Node.js与中文粘连，数字20和30个文件也要留出间距。再补充一些句子让段落更长一些，覆盖更多换行机会，确保行首禁标点和行尾悬挂的规则真的生效。';

const LIST_ITEM_1 = '第一项：检查工作目录里的文件，例如package.json和README.md，确认没有遗漏。';
const LIST_ITEM_2 = '第二项：执行脚本并收集输出，例如node scripts/report.mjs --out ./reports/2026年08月。';

const CODE_BLOCK = [
  '# 检查任务状态（中文注释示例）',
  'curl -s http://127.0.0.1:7690/api/sessions | jq .[] | wc -l',
  'node scripts/run-task.mjs --env prod --retry 3',
].join('\n');

const USER_MSG = '请帮我整理这个文件夹里的文件，按类型分类，比如图片image、文档doc和压缩包archive，顺便给每个文件加一句说明，谢谢！';

const STREAM_TEXT = '正在生成结果……这一步会把上一轮生成的report.json和log文件合并，生成summary.md，然后列出改动的文件和新增的代码行数。';

const CLOSING_PUNCT = new Set('，。！？；：、”』】）…');

// Mirror of real DOM: assistant md message, user bubble, streaming message.
function fixture() {
  return `
    <div class="msg-assistant md-content">
      <div class="msg-assistant-body">
        <p>${LONG_PARA}</p>
        <ul><li>${LIST_ITEM_1}</li><li>${LIST_ITEM_2}</li></ul>
        <pre>${CODE_BLOCK}</pre>
        <p>${LONG_PARA}</p>
      </div>
    </div>
    <div class="msg-user">
      <div class="msg-user-bubble">
        <span>${USER_MSG}</span>
        <div class="msg-meta"><div class="msg-timestamp msg-user-time">10:30</div></div>
      </div>
    </div>
    <div class="msg-assistant md-content streaming">
      <div class="msg-assistant-body">${STREAM_TEXT}</div>
    </div>
    <div class="mobile-live-activity-line">
      <span class="mobile-live-activity-line__label">${STREAM_TEXT}</span>
    </div>
    <div class="msg-assistant md-content">
      <div class="msg-assistant-body"><p id="autospace-ctrl">${LONG_PARA}</p></div>
    </div>`;
}

const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});

const viewports = [
  { width: 360, height: 800 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
];

const manifests = [];
let allOk = true;

try {
  for (const vp of viewports) {
    const page = await browser.newPage({ viewport: vp });
    await page.setContent(`<style>${styles}</style>${fixture()}`);
    // Give any font fallback time to settle so widths are stable.
    await page.evaluate(() => new Promise((resolve) => document.fonts.ready.then(() => resolve())));
    await page.evaluate(() => window.scrollTo(0, 0));

    const result = await page.evaluate(({ closingPunct }) => {
      const CLOSING = new Set(closingPunct);

      // --- helper: for a block element, first char of every rendered line ---
      function lineStartChars(root) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const byLine = new Map();
        const node = walker.currentNode;
        for (let n = node; n; n = walker.nextNode()) {
          if (!n.data || !n.data.trim()) continue;
          if (n.parentElement && n.parentElement.closest('pre, code')) continue;
          for (let i = 0; i < n.data.length; i++) {
            const ch = n.data[i];
            if (ch === '\n' || ch === ' ') continue;
            const rg = document.createRange();
            rg.setStart(n, i);
            rg.setEnd(n, i + 1);
            const rc = rg.getBoundingClientRect();
            if (!rc.width && !rc.height) continue;
            const key = Math.round(rc.top * 4) / 4;
            if (!byLine.has(key)) byLine.set(key, []);
            byLine.get(key).push({ ch, left: rc.left, right: rc.right });
          }
        }
        return [...byLine.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, chars]) => chars.sort((a, b) => a.left - b.left));
      }

      const body = document.querySelector('.msg-assistant-body');
      const userSpan = document.querySelector('.msg-user-bubble > span');
      const streamBody = document.querySelector('.streaming .msg-assistant-body');
      const mobileLiveLabel = document.querySelector('.mobile-live-activity-line__label');
      const pre = document.querySelector('.md-content pre');
      const assistantEl = document.querySelector('.msg-assistant');
      const bubble = document.querySelector('.msg-user-bubble');

      // --- 1. line-height in CJK range ---
      const csBody = getComputedStyle(body);
      const csUser = getComputedStyle(userSpan);
      const csLive = getComputedStyle(mobileLiveLabel);
      const lineHeightBody = parseFloat(csBody.lineHeight) / parseFloat(csBody.fontSize);
      const lineHeightUser = parseFloat(csUser.lineHeight) / parseFloat(csUser.fontSize);

      // --- 2. line-start punctuation (wrapped lines only: skip first line of each block) ---
      const blocks = [
        ['assistant-p1', body.querySelector('p')],
        ['assistant-li1', body.querySelector('li:nth-child(1)')],
        ['assistant-li2', body.querySelector('li:nth-child(2)')],
        ['assistant-p2', body.querySelectorAll('p')[1]],
        ['user-span', userSpan],
        ['streaming', streamBody],
      ];
      const startViolations = [];
      const lineStats = [];
      for (const [name, el] of blocks) {
        if (!el) continue;
        const lines = lineStartChars(el);
        lines.forEach((chars, i) => {
          if (i === 0) return; // first line of the block starts with the source text
          const first = chars[0].ch;
          if (CLOSING.has(first)) startViolations.push({ block: name, line: i + 1, first });
        });
        lineStats.push({
          block: name,
          lines: lines.length,
          firstChars: lines.map((l) => l[0].ch),
          avgCharsPerLine: Math.round(lines.reduce((s, l) => s + l.length, 0) / Math.max(1, lines.length)),
        });
      }

      // --- 3. CJK-Latin spacing: advance-width delta vs no-autospace control ---
      const ctrl = document.getElementById('autospace-ctrl');
      ctrl.style.textAutospace = 'no-autospace';
      ctrl.style.letterSpacing = '0';
      const advanceSum = (el) => {
        const range = document.createRange();
        range.selectNode(el);
        return Array.from(range.getClientRects()).reduce((s, rc) => s + rc.width, 0);
      };
      const scopeAdvance = advanceSum(body.querySelector('p'));
      const ctrlAdvance = advanceSum(ctrl);
      const spacingDelta = scopeAdvance - ctrlAdvance;

      // --- 4. code path opted out of inter-script spacing ---
      const csPre = getComputedStyle(pre);

      // --- 5. no horizontal overflow ---
      const containerRight = assistantEl.getBoundingClientRect().right;
      const bubbleRight = bubble.getBoundingClientRect().right;
      let maxLineRight = 0;
      for (const el of [body, userSpan]) {
        for (const chars of lineStartChars(el)) {
          maxLineRight = Math.max(maxLineRight, ...chars.map((c) => c.right));
        }
      }
      const overflowPx = Math.max(0, maxLineRight - containerRight);
      const bubbleOverflowPx = Math.max(
        0,
        ...lineStartChars(userSpan).map((chars) => Math.max(...chars.map((c) => c.right)) - bubbleRight),
      );

      return {
        supportsAutospace: CSS.supports('text-autospace', 'normal'),
        supportsHanging: CSS.supports('hanging-punctuation', 'allow-end'),
        lineHeightBody,
        lineHeightUser,
        fontSizeBody: csBody.fontSize,
        fontSizeUser: getComputedStyle(userSpan.parentElement).fontSize,
        fontSizeLive: csLive.fontSize,
        spacingDelta,
        textAutospaceComputed: csBody.textAutospace,
        letterSpacingComputed: csBody.letterSpacing,
        preAutospaceComputed: csPre.textAutospace,
        preLetterSpacingComputed: csPre.letterSpacing,
        startViolations,
        lineStats,
        overflowPx,
        bubbleOverflowPx,
        viewport: window.innerWidth,
      };
    }, { closingPunct: [...CLOSING_PUNCT] });

    // ---- assertions ----
    const lineHeight = `${vp.width}px: assistant body line-height ${result.lineHeightBody.toFixed(3)}, user span ${result.lineHeightUser.toFixed(3)}`;
    assert.equal(result.fontSizeBody, '16px', `${vp.width}px: assistant body should use the readable body size`);
    assert.equal(result.fontSizeUser, '16px', `${vp.width}px: user bubble should match assistant body size`);
    assert.equal(result.fontSizeLive, '16px', `${vp.width}px: live activity label should match message body size`);
    assert.ok(
      result.lineHeightBody >= 1.6 && result.lineHeightBody <= 1.75,
      `${lineHeight} — assistant body must land in the CJK range [1.6, 1.75]`,
    );
    assert.ok(
      result.lineHeightUser >= 1.6 && result.lineHeightUser <= 1.75,
      `${lineHeight} — user bubble prose must land in the CJK range [1.6, 1.75]`,
    );
    assert.equal(result.lineHeightUser, 1.65, `${vp.width}px: user prose line-height tuned to 1.65`);

    assert.deepEqual(
      result.startViolations,
      [],
      `${vp.width}px: closing punctuation must never start a wrapped line: ${JSON.stringify(result.startViolations)}`,
    );

    assert.ok(
      result.spacingDelta > 1,
      `${vp.width}px: CJK-Latin spacing must measurably widen text (got ${result.spacingDelta.toFixed(2)}px delta)`,
    );
    if (result.supportsAutospace) {
      assert.equal(
        result.textAutospaceComputed,
        'normal',
        `${vp.width}px: text-autospace must be applied on engines that support it`,
      );
      assert.equal(
        result.preAutospaceComputed,
        'no-autospace',
        `${vp.width}px: pre/code must opt out of inter-script spacing`,
      );
    } else {
      assert.equal(
        result.letterSpacingComputed,
        '0.3px',
        `${vp.width}px: fallback engines must carry the light letter-spacing`,
      );
      assert.equal(result.preLetterSpacingComputed, '0px', `${vp.width}px: code resets the fallback letter-spacing`);
    }

    assert.ok(
      result.overflowPx <= 1,
      `${vp.width}px: assistant lines must not overflow the column (got ${result.overflowPx.toFixed(2)}px)`,
    );
    assert.ok(
      result.bubbleOverflowPx <= 1,
      `${vp.width}px: user bubble lines must not overflow the bubble (got ${result.bubbleOverflowPx.toFixed(2)}px)`,
    );

    // ---- screenshots for Gemini visual review ----
    // The no-autospace control is a deliberate "before" example — hide it so
    // reviewers judge the real message typography, not the control pair.
    await page.evaluate(() => {
      document.getElementById('autospace-ctrl').closest('.msg-assistant').style.display = 'none';
    });
    const pngPath = join(outputDir, `cjk-${vp.width}.png`);
    await page.screenshot({ path: pngPath, fullPage: true });
    manifests.push({
      viewport: `${vp.width}x${vp.height}`,
      png: pngPath,
      lineHeightBody: result.lineHeightBody,
      lineHeightUser: result.lineHeightUser,
      spacingDeltaPx: Math.round(result.spacingDelta * 100) / 100,
      startViolations: result.startViolations,
      lineStats: result.lineStats,
      supportsAutospace: result.supportsAutospace,
      supportsHanging: result.supportsHanging,
    });

    console.log(`[${vp.width}px] PASS line-height=${result.lineHeightBody.toFixed(3)}/${result.lineHeightUser.toFixed(3)} ` +
      `spacing-delta=+${result.spacingDelta.toFixed(2)}px overflow=${result.overflowPx.toFixed(2)}px ` +
      `lines=${result.lineStats.map((s) => `${s.block}:${s.lines}`).join(' ')}`);
    await page.close();
  }
} finally {
  await browser.close();
}

// ---- hanging-punctuation is Safari-only; assert the declaration ships, ----
// ---- and is correctly inert where unsupported (Chrome reports support=false). ----
assert.ok(
  /hanging-punctuation:\s*allow-end/.test(styles),
  'stylesheet must declare hanging-punctuation: allow-end (progressive enhancement for Safari)',
);

writeFileSync(
  join(outputDir, 'manifest.json'),
  JSON.stringify({ stamp, cssFiles, viewports: viewports.map((v) => `${v.width}x${v.height}`), results: manifests }, null, 2),
);
console.log(`\ncjk-typography probe: ok (PNGs + manifest in ${outputDir})`);
console.log(`hanging-punctuation supported in engine: ${manifests[0].supportsHanging} (Safari 10.1+ only; Chrome pending)`);
process.exit(allOk ? 0 : 1);
