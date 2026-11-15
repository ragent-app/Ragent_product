#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

const repoRoot = process.cwd();
const css = await Promise.all([
  "static/chat/chat-base.css",
  "static/chat/chat-sidebar.css",
  "static/chat/chat-messages.css",
  "static/chat/chat-run-sheet.css",
  "static/chat/chat-workbench.css",
  "static/chat/chat-responsive.css",
  "static/chat/chat-glass.css",
  "static/chat/chat-m3-tokens.css",
  "static/chat/chat-m3-components.css",
].map((file) => readFile(`${repoRoot}/${file}`, "utf8"))).then((parts) => parts.join("\n"));

const fixture = `<!doctype html><html><head><style>${css}</style></head><body>
  <aside class="sidebar" data-sidebar-mode="sessions">
    <div class="sidebar-app-bar"><div class="sidebar-brand">Ragent</div><div class="sidebar-app-bar-actions">
      <button class="sidebar-icon-btn" aria-label="Search"></button><button class="sidebar-icon-btn" aria-label="Back"></button>
    </div></div>
    <nav class="sidebar-primary-nav"><div class="sidebar-workspace"><button class="sidebar-workspace-summary sidebar-primary-action">Workspace</button></div></nav>
    <div class="sidebar-bottom-actions"><button class="sidebar-new-chat-btn">New chat</button><button class="sidebar-agent-btn" aria-label="Agents">A</button><button class="sidebar-filter-btn" aria-label="Settings">S</button></div>
  </aside>
  <section id="agentsPanel"><div class="settings-app-header"><button id="createAgentBtn" class="settings-app-btn settings-app-btn-primary">Create Agent</button></div>
    <div class="settings-app-card"><div class="settings-app-card-header"><span class="settings-app-name">Reporting Agent</span><span class="settings-app-kind">Custom</span></div><div class="settings-app-actions"><button class="settings-app-btn settings-app-btn-primary">Open session</button><button class="settings-app-btn settings-app-btn-danger">Delete</button></div></div>
  </section>
  <section class="live-operation-row state-running"><button class="live-operation-row__summary"><span class="live-operation-row__mark"></span><span class="live-operation-row__label">Running command</span><code class="live-operation-row__detail">npm test -- --runInBand packages/a-very-long-workspace-name</code><span class="live-operation-row__meta">18s</span><span class="live-operation-row__chevron">›</span></button><div class="live-operation-row__body"><pre class="live-operation-row__output">test ok</pre></div></section>
  <section class="workbench-outcome-card"><div class="workbench-outcome-metric"><strong>2</strong><span>files</span></div><a class="workbench-artifact-item" href="#">summary.pdf</a></section>
</body></html>`;

const browser = await chromium.launch({ headless: true });
try {
  for (const colorScheme of ["light", "dark"]) {
    for (const width of [360, 390, 1024, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme });
      await page.setContent(fixture, { waitUntil: "load" });
      await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, colorScheme);
      const metrics = await page.evaluate(() => {
        const read = (selector) => {
          const node = document.querySelector(selector);
          const style = getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return {
            width: rect.width,
            height: rect.height,
            radius: style.borderTopLeftRadius,
            border: style.borderTopWidth,
            shadow: style.boxShadow,
            background: style.backgroundColor,
          };
        };
        return {
          bodyWidth: document.documentElement.scrollWidth,
          viewportWidth: innerWidth,
          sidebarIcon: read(".sidebar-icon-btn"),
          workspace: read(".sidebar-workspace-summary"),
          newChat: read(".sidebar-new-chat-btn"),
          agentCard: read("#agentsPanel .settings-app-card"),
          agentPrimary: read("#agentsPanel .settings-app-btn-primary"),
          activity: read(".live-operation-row"),
          activitySummary: read(".live-operation-row__summary"),
          activityOutput: read(".live-operation-row__output"),
          workbench: read(".workbench-outcome-card"),
          workbenchRow: read(".workbench-artifact-item"),
        };
      });
      assert.ok(metrics.bodyWidth <= metrics.viewportWidth + 1, `${colorScheme}-${width}: no horizontal overflow`);
      assert.equal(metrics.sidebarIcon.border, "0px", `${colorScheme}-${width}: icon controls remain borderless`);
      assert.equal(metrics.sidebarIcon.shadow, "none", `${colorScheme}-${width}: icon controls remain shadowless`);
      assert.ok(metrics.sidebarIcon.width >= 44 && metrics.sidebarIcon.height >= 44, `${colorScheme}-${width}: icon controls keep touch size`);
      assert.equal(metrics.workspace.background, "rgba(0, 0, 0, 0)", `${colorScheme}-${width}: L1 workspace row stays flat`);
      assert.ok(metrics.newChat.height >= 52, `${colorScheme}-${width}: primary action keeps L1/L2 height`);
      assert.equal(metrics.agentCard.border, "0px", `${colorScheme}-${width}: agent card has no border`);
      assert.equal(metrics.agentCard.shadow, "none", `${colorScheme}-${width}: agent row has no shadow`);
      assert.ok(metrics.agentPrimary.height >= 44, `${colorScheme}-${width}: agent action keeps touch size`);
      assert.equal(metrics.activity.border, "0px", `${colorScheme}-${width}: activity row has no border`);
      assert.equal(metrics.activity.shadow, "none", `${colorScheme}-${width}: activity row has no shadow`);
      assert.ok(metrics.activitySummary.height >= 44, `${colorScheme}-${width}: activity summary keeps touch size`);
      assert.equal(metrics.activityOutput.border, "0px", `${colorScheme}-${width}: output uses a surface, not an outline`);
      assert.equal(metrics.workbench.shadow, "none", `${colorScheme}-${width}: workbench surface has no shadow`);
      assert.equal(metrics.workbenchRow.shadow, "none", `${colorScheme}-${width}: workbench rows stay flat`);
      await page.close();
    }
  }
} finally {
  await browser.close();
}

console.log("test-chat-l1-l2-surface-contract: ok");
