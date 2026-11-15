#!/usr/bin/env node
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcePath = join(repoRoot, "static", "chat", "markdown-enhancements.js");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

try {
  await page.setContent(`<!doctype html><html><body>
    <div id="code" class="md-content"><div class="code-block-wrap"><pre><code class="language-js">const answer = true;\nconsole.log("ready"); // stable</code></pre></div></div>
    <div id="flow" class="md-content"><div class="code-block-wrap"><pre><code class="language-mermaid">flowchart TD\n  A[Start] --> B{Ready?}\n  B -->|Yes| C[Done]</code></pre></div></div>
    <div id="sequence" class="md-content"><div class="code-block-wrap"><pre><code class="language-mermaid">sequenceDiagram\n  participant U as User\n  participant A as Agent\n  U->>A: Start work\n  A-->>U: Done</code></pre></div></div>
  </body></html>`);
  await page.addScriptTag({ path: sourcePath });
  await page.evaluate(() => window.RagentMarkdownEnhancements.enhanceCodeBlocks(document.body));

  assert.equal(await page.locator("#code .code-token--keyword").count(), 2, "JavaScript keywords and booleans should be highlighted");
  assert.equal(await page.locator("#code .code-token--builtin").count(), 1, "known builtins should be highlighted");
  assert.equal(await page.locator("#code .code-token--string").count(), 1, "strings should be highlighted");
  assert.equal(await page.locator("#code .code-token--comment").count(), 1, "comments should be highlighted");
  assert.equal(await page.evaluate(() => window.RagentMarkdownEnhancements.codeLanguageLabel("js")), "JavaScript", "JavaScript aliases should have a readable language label");
  assert.equal(await page.evaluate(() => window.RagentMarkdownEnhancements.codeLanguageLabel("ps1")), "PowerShell", "PowerShell aliases should have a readable language label");
  assert.equal(await page.evaluate(() => window.RagentMarkdownEnhancements.codeLanguageLabel("")), "Plain text", "untyped fences should have a plain-text label");
  assert.equal(await page.evaluate(() => window.RagentMarkdownEnhancements.highlightCode("New-Item -Path $target", "ps1").includes("code-token--builtin")), true, "PowerShell commands should receive syntax colors");
  assert.equal(await page.evaluate(() => window.RagentMarkdownEnhancements.highlightCode("true // plain", "text").includes("code-token")), false, "plain-text blocks should not receive syntax colors");
  assert.equal(await page.locator("#flow .mermaid-diagram svg").count(), 1, "flowcharts should render to SVG");
  assert.equal(await page.locator("#sequence .mermaid-diagram svg").count(), 1, "sequence diagrams should render to SVG");
  assert.equal(await page.locator("#flow .mermaid-node").count(), 3, "flowchart nodes should be preserved");
  assert.equal(await page.locator("#sequence .mermaid-message").count(), 2, "sequence messages should be preserved");
  assert.match(await page.locator("#flow .mermaid-node-label").allTextContents().then((values) => values.join(" ")), /Ready\?/i, "flowchart labels should be preserved");
  assert.deepEqual(await page.locator("#sequence .mermaid-sequence-label").allTextContents(), ["User", "Agent"], "sequence participant aliases should be preserved");
  assert.equal(await page.locator("#code code").getAttribute("translate"), "no", "code should not be auto-translated");
  assert.equal(await page.locator("#flow pre").getAttribute("aria-hidden"), "true", "diagram source should not be announced twice");
  assert.equal(await page.locator("#flow .code-block-wrap").evaluate((node) => node.classList.contains("code-block-wrap--diagram")), true, "rendered diagrams should mark the source wrapper for visual hiding");
  console.log("test-markdown-enhancements: ok");
} finally {
  await browser.close();
}
