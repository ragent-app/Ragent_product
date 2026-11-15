#!/usr/bin/env node
// Horizontal-overflow sentinel for the mobile chat surface (DESIGN.md
// Responsive Contract: "Long prose, code, diffs, tool output, Chinese text,
// and long unbroken identifiers must not create horizontal page scrolling").
//
// The chat shell is an app-shell layout (html/body overflow hidden), so the
// failure mode is not a scrollbar but silently clipped content. This fixture
// feeds the full message CSS with the widest content classes the model can
// emit — unbroken links, inline-width divs, raw iframe/svg/video, wide tables,
// long code, CJK — and asserts the page never widens past the viewport at
// mobile widths (including 320px, below the standard 360 matrix), while
// verifying that wide blocks scroll inside their own surfaces instead.
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDir = String(process.env.RAGENT_VISUAL_OUTPUT_DIR || "").trim() || mkdtempSync(join(tmpdir(), "ragent-no-overflow-"));
const browser = await chromium.launch({ headless: true });

const css = [
  "static/chat/chat-base.css",
  "static/chat/chat-messages.css",
  "static/chat/chat-responsive.css",
].map((path) => readFileSync(join(repoRoot, path), "utf8")).join("\n");

// Long-unbroken content that historically blows out message columns.
const STRESS_MARKDOWN = `
<h1>Overflow stress fixture</h1>
<p>长中文段落没有任何问题：这个产品是为中文用户设计的工作台，重复性数字工作可以通过对话委托给 AI 自动完成，用户不需要写完美的需求说明。</p>
<p>Unbroken link: <a href="https://example.com/some/very/long/path/without/any/spaces/abcdefghijklmnopqrstuvwxyz0123456789/abcdefghijklmnopqrstuvwxyz0123456789/really/really/long/segment/here">https://example.com/some/very/long/path/without/any/spaces/abcdefghijklmnopqrstuvwxyz0123456789/abcdefghijklmnopqrstuvwxyz0123456789/really/really/long/segment/here</a></p>
<p>Supercalifragilisticexpialidocious_antidisestablishmentarianism_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</p>
<div style="width:800px;background:#eee;padding:8px">Inline-width div from raw HTML</div>
<iframe width="900" height="400" title="wide iframe"></iframe>
<svg width="1000" height="200" xmlns="http://www.w3.org/2000/svg"><rect width="1000" height="200" fill="#ddd"/></svg>
<video width="1200" height="400"></video>
<table>
  <thead><tr><th>Column A</th><th>Column B</th><th>Column C</th><th>Column D</th><th>Column E</th><th>Column F</th><th>Column G</th><th>Column H</th></tr></thead>
  <tbody><tr><td>alpha</td><td>beta</td><td>gamma</td><td>delta</td><td>epsilon</td><td>zeta</td><td>eta</td><td>theta</td></tr></tbody>
</table>
<pre><code class="language-javascript">const veryLongIdentifier = async (input) => { const result = await somethingVeryLong(input, { option: "with a long value that wraps across many many columns" }); return result; };</code></pre>
<div class="mermaid-diagram"><svg width="100%" min-width="360px" height="300" xmlns="http://www.w3.org/2000/svg"><rect width="800" height="300" fill="#eee"/></svg></div>
`;

try {
  for (const theme of ["light", "dark"]) {
    for (const width of [320, 360, 390, 430]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      await page.setContent(`<!doctype html><html data-theme="${theme}"><head><style>
        ${css}
        body { margin: 0; padding: 0; background: var(--chat-area-bg); font-family: var(--font-ui); }
        main { max-width: 920px; margin: 0 auto; }
      </style></head><body><main class="md-content"></main></body></html>`);
      await page.evaluate((md) => {
        // Wrap raw tables like the real renderer's enhanceTables() does.
        document.querySelector("main").innerHTML = md;
        for (const table of document.querySelectorAll("table")) {
          if (table.parentElement?.classList.contains("md-table-wrap")) continue;
          const wrapper = document.createElement("div");
          wrapper.className = "md-table-wrap";
          table.parentNode.insertBefore(wrapper, table);
          wrapper.appendChild(table);
        }
      }, STRESS_MARKDOWN);

      const result = await page.evaluate(() => {
        const docEl = document.documentElement;
        const viewport = window.innerWidth;
        const offenders = Array.from(document.querySelectorAll("body *"))
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return r.right > viewport + 0.5 || r.left < -0.5;
          })
          .slice(0, 8)
          .map((el) => `${el.tagName.toLowerCase()}${el.className ? "." + String(el.className).split(/\s+/).join(".") : ""}`);
        return {
          scrollWidth: docEl.scrollWidth,
          clientWidth: docEl.clientWidth,
          offenders,
          // Wide content is either capped by its wrap or scrolls inside its
          // own surface (readable, not clipped): the table wrap must never
          // exceed the viewport (cells wrap via overflow-wrap:anywhere, so a
          // fitted table is correct), while long code and wide diagrams are
          // hard-width content that must scroll locally.
          localScrollers: {
            tableCapped: document.querySelector(".md-table-wrap")?.scrollWidth <= viewport + 0.5,
            pre: document.querySelector("main > pre, .md-content pre")?.scrollWidth > document.querySelector("main > pre, .md-content pre")?.clientWidth,
            mermaid: document.querySelector(".mermaid-diagram")?.scrollWidth > document.querySelector(".mermaid-diagram")?.clientWidth,
          },
        };
      });

      assert.equal(
        result.scrollWidth <= result.clientWidth,
        true,
        `${theme} @${width}px: page widened to ${result.scrollWidth}px (viewport ${result.clientWidth}px); offenders: ${result.offenders.join(", ") || "none"}`
      );
      assert.equal(result.localScrollers.tableCapped, true, `table wrap must not exceed the viewport at ${width}px`);
      assert.equal(result.localScrollers.pre, true, `long code must scroll inside its block at ${width}px`);
      // Diagrams carry min-width:360px (readability floor); the container has
      // 12px side padding, so below 384px viewport the wrap scrolls locally,
      // at or above it the svg fills the container without overflow.
      if (width < 384) {
        assert.equal(result.localScrollers.mermaid, true, `wide diagram must scroll inside its container at ${width}px`);
      } else {
        assert.equal(result.localScrollers.mermaid, false, `diagram should fit its container at ${width}px`);
      }

      await page.screenshot({ path: join(outputDir, `no-overflow-${theme}-${width}.png`), fullPage: true });
      await page.close();
    }
  }
  console.log(`test-no-horizontal-overflow: ok (${outputDir})`);
} finally {
  await browser.close();
}
