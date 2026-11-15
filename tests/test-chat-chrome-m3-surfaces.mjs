#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const repoRoot = process.cwd();
const outputDir = process.env.RAGENT_VISUAL_OUTPUT_DIR || "/var/lib/ragent/workspace/visual-ui-reviews/chat-chrome-m3";
await mkdir(outputDir, { recursive: true });
const css = await Promise.all(["chat-base.css", "chat-glass.css", "chat-input.css", "chat-responsive.css", "chat-goal-ui.css", "chat-sheet-actions.css", "chat-decision-sheet.css", "chat-m3-tokens.css", "chat-m3-components.css"].map((f) => readFile(join(repoRoot, "static/chat", f), "utf8")));
const markup = `<div class="app-shell"><header class="header"><button class="header-btn header-btn--sessions" aria-label="Sessions">☰</button><button class="header-btn header-btn--home" aria-label="Home">⌂</button><h1>Ragent Chat</h1><button class="header-more-btn" aria-label="More">⋯</button><div class="header-overflow-menu"><button class="header-overflow-menu-item">Run Sheet</button><button class="header-overflow-menu-item">Sidebar</button></div></header></div><div class="modal-backdrop is-open" id="goalSheet"><section class="modal"><div class="goal-status-display" data-tone="working">Working</div><p>Keep the session focused on the current task.</p></section></div>`;
const browser = await chromium.launch({ headless: true });
try {
  for (const theme of ["light", "dark"]) {
    for (const [width, height, label] of [[390, 844, "mobile"], [1440, 900, "desktop"]]) {
      const page = await browser.newPage({ viewport: { width, height }, colorScheme: theme });
      await page.setContent(`<!doctype html><html><head><style>${css.join("\n")}</style><style>html,body{margin:0;min-height:100%;}</style></head><body>${markup}</body></html>`);
      const state = await page.evaluate(() => ({
        headerFilter: getComputedStyle(document.querySelector(".header")).backdropFilter,
        goalFilter: getComputedStyle(document.querySelector("#goalSheet .modal")).backdropFilter,
        bodyWidth: document.documentElement.scrollWidth,
        viewport: innerWidth,
      }));
      assert.equal(state.headerFilter, "none", `${theme} ${label}: header retains blur`);
      assert.equal(state.goalFilter, "none", `${theme} ${label}: goal sheet retains blur`);
      assert.ok(state.bodyWidth <= state.viewport + 1, `${theme} ${label}: chrome overflows`);
      await page.screenshot({ path: join(outputDir, `chat-chrome-${theme}-${label}.png`), fullPage: true });
      await page.close();
    }
  }
} finally {
  await browser.close();
}
console.log(`test-chat-chrome-m3-surfaces: ok (${outputDir})`);
