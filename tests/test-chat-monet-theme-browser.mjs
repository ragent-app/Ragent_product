#!/usr/bin/env node
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const contractPath = join(repoRoot, "static/chat/monet-theme-contract.js");
const artifactRoot = join(repoRoot, "artifacts");

const variants = [
  {
    name: "light",
    viewport: { width: 390, height: 844 },
    payload: {
      version: 1,
      roles: {
        primary: "#6750A4",
        "on-primary": "#FFFFFF",
        surface: "#FFFBFE",
        "surface-container": "#F3EDF7",
        "on-surface": "#1C1B1F",
        "on-surface-variant": "#49454F",
        "outline-variant": "#CAC4D0",
      },
      themeColor: { light: "#FFFBFE", dark: "#141218" },
    },
  },
  {
    name: "dark",
    viewport: { width: 1440, height: 900 },
    payload: {
      version: 1,
      roles: {
        primary: "#D0BCFF",
        "on-primary": "#381E72",
        surface: "#141218",
        "surface-container": "#211F26",
        "on-surface": "#E6E0E9",
        "on-surface-variant": "#CAC4D0",
        "outline-variant": "#49454F",
      },
      themeColor: { light: "#FFFBFE", dark: "#141218" },
    },
  },
];

const browser = await chromium.launch({ headless: true });
try {
  for (const variant of variants) {
    const page = await browser.newPage({ viewport: variant.viewport, colorScheme: variant.name });
    await page.setContent(`<!doctype html>
      <html>
        <head>
          <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
          <meta name="theme-color" content="#161618" media="(prefers-color-scheme: dark)">
          <style>
            :root { font-family: system-ui, sans-serif; }
            * { box-sizing: border-box; }
            body { margin: 0; min-height: 100vh; padding: 24px; background: var(--sys-surface); color: var(--sys-on-surface); }
            .demo { max-width: 620px; margin: 0 auto; padding: 24px; border: 1px solid var(--sys-outline-variant); border-radius: 24px; background: var(--sys-surface-container); }
            .demo h1 { margin: 0 0 8px; font-size: 22px; }
            .demo p { margin: 0 0 20px; color: var(--sys-on-surface-variant); }
            .demo-action { min-height: 44px; padding: 0 18px; border: 0; border-radius: 999px; background: var(--sys-primary); color: var(--sys-on-primary); font-weight: 700; }
          </style>
        </head>
        <body>
          <main class="demo">
            <h1>Monet theme preview</h1>
            <p>Dynamic roles stay separate from workflow status colors.</p>
            <button class="demo-action" type="button">Continue</button>
          </main>
        </body>
      </html>`);
    await page.addScriptTag({ path: contractPath });

    const result = await page.evaluate((payload) => {
      const applied = window.RagentMonetThemeContract.apply(payload);
      document.querySelector('meta[name="theme-color"][media*="light"]')?.setAttribute("content", applied.themeColorOverrides.light);
      document.querySelector('meta[name="theme-color"][media*="dark"]')?.setAttribute("content", applied.themeColorOverrides.dark);
      const root = document.documentElement;
      const action = document.querySelector(".demo-action");
      const rootStyles = getComputedStyle(root);
      const actionStyles = getComputedStyle(action);
      return {
        applied,
        primary: root.style.getPropertyValue("--sys-primary").trim(),
        surface: root.style.getPropertyValue("--sys-surface").trim(),
        bodyBackground: getComputedStyle(document.body).backgroundColor,
        actionBackground: actionStyles.backgroundColor,
        actionColor: actionStyles.color,
        textColor: rootStyles.getPropertyValue("--sys-on-surface").trim(),
        lightMeta: document.querySelector('meta[name="theme-color"][media*="light"]')?.content,
        darkMeta: document.querySelector('meta[name="theme-color"][media*="dark"]')?.content,
      };
    }, variant.payload);

    assert.deepEqual([...result.applied.applied], [
      "primary",
      "on-primary",
      "surface",
      "surface-container",
      "on-surface",
      "on-surface-variant",
      "outline-variant",
    ]);
    assert.equal(result.primary, variant.payload.roles.primary);
    assert.equal(result.surface, variant.payload.roles.surface);
    assert.notEqual(result.bodyBackground, "rgba(0, 0, 0, 0)");
    assert.notEqual(result.actionBackground, result.bodyBackground);
    assert.notEqual(result.actionColor, result.actionBackground);
    assert.equal(result.lightMeta, variant.payload.themeColor.light);
    assert.equal(result.darkMeta, variant.payload.themeColor.dark);

    await page.screenshot({ path: join(artifactRoot, `monet-theme-browser-${variant.name}.png`), fullPage: true });
    await page.close();
  }
} finally {
  await browser.close();
}

console.log("test-chat-monet-theme-browser: ok");
