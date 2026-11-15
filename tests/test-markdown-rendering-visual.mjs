#!/usr/bin/env node
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDir = "/var/lib/ragent/workspace/visual-ui-reviews/markdown-final";
mkdirSync(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });

try {
  for (const theme of ["light", "dark"]) {
    for (const width of [360, 390, 430, 1024, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: width < 600 ? 900 : 820 } });
      await page.setContent(`<!doctype html><html data-theme="${theme}"><head><style>
        ${readFileSync(join(repoRoot, "static/chat/chat-base.css"), "utf8")}
        ${readFileSync(join(repoRoot, "static/chat/chat-messages.css"), "utf8")}
        ${readFileSync(join(repoRoot, "static/chat/chat-m3-tokens.css"), "utf8")}
        ${readFileSync(join(repoRoot, "static/chat/chat-m3-components.css"), "utf8")}
        ${readFileSync(join(repoRoot, "static/chat/chat-operational-surfaces.css"), "utf8")}
        body { margin: 0; padding: 18px; background: var(--chat-area-bg); font-family: var(--font-ui); }
        main { max-width: 920px; margin: 0 auto; }
        .fixture-title { margin: 0 0 14px; font-size: 20px; }
        .fixture-copy { color: var(--text-secondary); margin: 0 0 14px; }
      </style></head><body><main class="md-content">
        <h1 class="fixture-title">Automation handoff</h1>
        <p class="fixture-copy">The code block and diagrams stay readable while the message surface remains within the viewport.</p>
        <pre><code class="language-javascript">const workflow = async (input) => {\n  // Validate before execution\n  if (!input) return { ok: false, reason: "missing input" };\n  return { ok: true, items: input.length };\n};</code></pre>
        <pre><code class="language-mermaid">flowchart TD\n  A[Receive files] --> B{Valid?}\n  B -->|Yes| C[Run automation]\n  B -->|No| D[Ask for input]</code></pre>
        <pre><code class="language-mermaid">sequenceDiagram\n  participant U as Owner\n  participant A as Agent\n  U->>A: Send a recurring task\n  A-->>U: Return an auditable result</code></pre>
      </main></body></html>`);
      await page.addScriptTag({ path: join(repoRoot, "static/chat/markdown-enhancements.js") });
      await page.addScriptTag({ path: join(repoRoot, "static/chat/realtime-render.js") });
      await page.evaluate(() => {
        window.ragentT = (key) => key;
        window.renderRealtimeIcon = (name) => `<svg data-icon="${name}"></svg>`;
        enhanceCodeBlocks(document.querySelector("main"));
        window.RagentMarkdownEnhancements.enhanceCodeBlocks(document.querySelector("main"));
      });
      assert.equal(await page.locator(".code-token--keyword").count() > 0, true);
      assert.equal(await page.locator(".mermaid-diagram svg").count(), 2);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `page should not overflow horizontally at ${width}px`);
      if (width < 600) {
        assert.equal(await page.evaluate(() => Array.from(document.querySelectorAll("pre")).some((node) => node.scrollWidth > node.clientWidth)), true, "long code should scroll inside its own surface");
      }
      await page.screenshot({ path: join(outputDir, `${theme}-${width}.png`), fullPage: true });
      await page.close();
    }
  }
  console.log(`test-markdown-rendering-visual: ok (${outputDir})`);
} finally {
  await browser.close();
}
