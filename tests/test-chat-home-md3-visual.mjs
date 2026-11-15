#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDir = process.env.RAGENT_VISUAL_OUTPUT_DIR || join(repoRoot, "artifacts", "home-md3");
await mkdir(outputDir, { recursive: true });

const [baseCss, homeCss, iconsSource, homeSource] = await Promise.all([
  readFile(join(repoRoot, "static/chat/chat-base.css"), "utf8"),
  readFile(join(repoRoot, "static/chat/chat-home.css"), "utf8"),
  readFile(join(repoRoot, "static/chat/icons.js"), "utf8"),
  readFile(join(repoRoot, "static/chat/home-workspace.js"), "utf8"),
]);

const now = Date.now();
const homeData = {
  focusItems: [
    {
      id: "session:approval",
      kind: "session",
      sessionId: "approval",
      title: "Review the monthly report before it is sent",
      summary: "A decision is waiting for you.",
      reason: "Waiting for your decision",
      severity: "urgent",
      workflowState: "waiting_user",
      updatedAt: new Date(now - 5 * 60 * 1000).toISOString(),
    },
    {
      id: "session:cleanup",
      kind: "session",
      sessionId: "cleanup",
      title: "Clean up the shared project exports",
      summary: "The high-priority task has a new result.",
      reason: "High-priority agent work needs attention",
      severity: "high",
      workflowPriority: "high",
      updatedAt: new Date(now - 42 * 60 * 1000).toISOString(),
    },
  ],
  inProgress: [
    {
      id: "run:one",
      kind: "run",
      sessionId: "one",
      title: "Prepare the weekly operations summary",
      summary: "Collecting source files",
      reason: "Collecting source files",
      running: true,
      updatedAt: new Date(now - 2 * 60 * 1000).toISOString(),
    },
    {
      id: "run:two",
      kind: "run",
      sessionId: "two",
      title: "Reconcile incoming invoices",
      summary: "Checking the latest export",
      reason: "Checking the latest export",
      running: true,
      updatedAt: new Date(now - 18 * 60 * 1000).toISOString(),
    },
  ],
  upcomingAutomation: [
    {
      id: "trigger:one",
      kind: "trigger",
      sessionId: "one",
      title: "Send the weekly operations summary",
      summary: "The next run is scheduled for tomorrow.",
      reason: "Scheduled work is coming up",
      scheduledAt: new Date(now + 8 * 60 * 60 * 1000).toISOString(),
      updatedAt: new Date(now - 10 * 60 * 1000).toISOString(),
      status: "pending",
    },
  ],
  recentResults: [
    {
      id: "result:one",
      kind: "result",
      sessionId: "one",
      title: "Quarterly folders are ready to review",
      summary: "Agent marked this work complete",
      reason: "Agent marked this work complete",
      updatedAt: new Date(now - 3 * 60 * 60 * 1000).toISOString(),
    },
  ],
  counts: { focus: 2, running: 2, upcoming: 1, recent: 1 },
};

async function makePage({ theme, viewport }) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setContent(`<!doctype html><html data-theme="${theme}"><head><style>
    ${baseCss}
    ${homeCss}
    body { margin: 0; min-height: 100vh; background: var(--chat-area-bg); }
    .messages-inner { width: min(100% - 32px, 1080px); margin: 0 auto; }
    .composer-placeholder { height: 96px; }
  </style></head><body>
    <main class="messages-inner">
      <button id="newSessionBtn" type="button" hidden aria-hidden="true" tabindex="-1">New session</button>
      <section class="home-workspace" id="homeWorkspace" aria-labelledby="homeWorkspaceTitle" hidden></section>
      <div class="composer-placeholder" aria-hidden="true"></div>
    </main>
  </body></html>`);
  await page.addScriptTag({ content: iconsSource });
  await page.evaluate((data) => {
    window.__homeData = data;
    window.__openedSession = "";
    window.__markedSession = "";
    window.__newSessionClicks = 0;
    window.__crossDeviceOpen = null;
    window.ragentGetActiveUiLanguage = () => "en-US";
    window.applyNavigationState = ({ sessionId }) => { window.__openedSession = sessionId; };
    window.RagentCrossDevicePanel = {
      open(options) {
        window.__crossDeviceOpen = options;
        return true;
      },
    };
    window.fetch = async (url, options = {}) => {
      if (options.method === "PATCH") {
        window.__markedSession = String(url).split("?")[0].split("/").pop();
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => window.__homeData };
    };
    document.getElementById("newSessionBtn").addEventListener("click", () => { window.__newSessionClicks += 1; });
  }, homeData);
  await page.addScriptTag({ content: homeSource });
  await page.evaluate(() => window.showHomeWorkspace());
  await page.locator(".home-item").first().waitFor();
  return { browser, page };
}

const scenarios = [
  { name: "desktop-light", theme: "light", viewport: { width: 1440, height: 900 } },
  { name: "desktop-dark", theme: "dark", viewport: { width: 1440, height: 900 } },
  { name: "mobile-light", theme: "light", viewport: { width: 390, height: 844 } },
  { name: "mobile-dark", theme: "dark", viewport: { width: 360, height: 800 } },
];

for (const scenario of scenarios) {
  const { browser, page } = await makePage(scenario);
  try {
    const metrics = await page.evaluate(() => {
      const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect?.() || null;
      return {
        bodyScrollWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        rows: document.querySelectorAll(".home-item").length,
        sectionIcons: document.querySelectorAll(".home-section-icon").length,
        primaryButton: rect(".home-new-work"),
        deviceWorkspaceButton: rect(".home-device-workspace"),
        refreshButton: rect(".home-refresh"),
        actionButton: rect(".home-action--primary"),
        focusRow: rect(".home-section--focus .home-item"),
        homeTitle: rect("#homeWorkspaceTitle"),
        hasLegacyMarker: !!document.querySelector(".home-item-marker"),
        hasLegacyNote: !!document.querySelector(".home-focus-note"),
      };
    });
    assert.ok(metrics.deviceWorkspaceButton.width >= 44 && metrics.deviceWorkspaceButton.height >= 44, scenario.name + ": device workspace should meet touch target");
    assert.equal(metrics.bodyScrollWidth, metrics.viewportWidth, `${scenario.name}: homepage must not overflow horizontally`);
    assert.equal(metrics.rows, 6, `${scenario.name}: all projected rows should render`);
    assert.equal(metrics.sectionIcons, 4, `${scenario.name}: each work section needs a state icon`);
    assert.ok(metrics.primaryButton.height >= 48, `${scenario.name}: primary action should meet MD3 touch height`);
    assert.ok(metrics.refreshButton.width >= 44 && metrics.refreshButton.height >= 44, `${scenario.name}: refresh should meet touch target`);
    assert.ok(metrics.actionButton.width >= 44 && metrics.actionButton.height >= 44, `${scenario.name}: row action should meet touch target`);
    assert.ok(metrics.focusRow.height >= 80, `${scenario.name}: focus rows should remain scanable`);
    assert.ok(metrics.homeTitle.height > 0, `${scenario.name}: heading should render`);
    assert.equal(metrics.hasLegacyMarker, false, `${scenario.name}: colored marker rail should be removed`);
    assert.equal(metrics.hasLegacyNote, false, `${scenario.name}: explanatory side note should be removed`);

    await page.locator(".home-new-work").click();
    await page.locator(".home-device-workspace").click();
    assert.deepEqual(await page.evaluate(() => window.__crossDeviceOpen), { view: "devices" }, scenario.name + ": device workspace should open its devices view");
    assert.equal(await page.evaluate(() => window.__newSessionClicks), 1, `${scenario.name}: start action should reuse new session behavior`);
    await page.locator(".home-section--focus .home-action--primary").first().click();
    assert.equal(await page.evaluate(() => window.__openedSession), "approval", `${scenario.name}: open should navigate to the source session`);
    const markReadButton = page.locator('.home-section--focus .home-action[data-home-action="read"]').first();
    assert.equal(await markReadButton.count(), 1, `${scenario.name}: focus row should expose a mark-read action`);
    await markReadButton.click();
    await page.waitForFunction(() => window.__markedSession === "approval");
    assert.equal(await page.evaluate(() => window.__markedSession), "approval", `${scenario.name}: mark-read should patch the source session`);

    await page.screenshot({ path: join(outputDir, `${scenario.name}.png`), fullPage: true });
  } finally {
    await browser.close();
  }
}

console.log(`test-chat-home-md3-visual: ok (${outputDir})`);
