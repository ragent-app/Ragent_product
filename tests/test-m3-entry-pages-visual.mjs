#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const repoRoot = process.cwd();
const outputDir = process.env.AGENTOC_VISUAL_OUTPUT_DIR || "/var/lib/agentoc/workspace/visual-ui-reviews/entry-pages-m3";
await mkdir(outputDir, { recursive: true });

const pageFiles = [
  ["login", "login.html", ".card"],
  ["admin-login", "admin-login.html", ".shell"],
  ["mobile-install", "mobile-install.html", ".card"],
];

function fixtureFromTemplate(template, css) {
  const styles = [...template.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((match) => match[1])
    .join("\n");
  const bodyMatch = template.match(/<body([^>]*)>([\s\S]*?)<\/body>/i);
  const attributes = bodyMatch?.[1] || "";
  const body = bodyMatch?.[2] || "";
  const normalizedAttributes = attributes.replaceAll("{{BODY_CLASS}}", "mobile-install-page");
  const normalizedBody = body
    .replaceAll("{{BOOTSTRAP_SCRIPT_TAGS}}", "")
    .replaceAll("{{BUILD_LABEL}}", "Build");
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${styles}</style></head><body${normalizedAttributes}>${normalizedBody}</body></html>`;
}

const m3Pages = await readFile(join(repoRoot, "static/m3-pages.css"), "utf8");
const templates = new Map(await Promise.all(pageFiles.map(async ([id, file]) => [
  id,
  await readFile(join(repoRoot, "templates", file), "utf8"),
])));

const browser = await chromium.launch({ headless: true });
try {
  for (const [id, , rootSelector] of pageFiles) {
    const template = templates.get(id);
    for (const theme of ["light", "dark"]) {
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
        colorScheme: theme,
        deviceScaleFactor: 1,
      });
      await page.setContent(fixtureFromTemplate(template, m3Pages), { waitUntil: "load" });
      const root = page.locator(rootSelector);
      await root.waitFor();
      const state = await page.evaluate((selector) => {
        const root = document.querySelector(selector);
        const body = getComputedStyle(document.body);
        const surface = getComputedStyle(root);
        return {
          bodyBackground: body.backgroundColor,
          backdropFilter: surface.backdropFilter,
          width: root.getBoundingClientRect().width,
          right: root.getBoundingClientRect().right,
          viewport: window.innerWidth,
        };
      }, rootSelector);
      assert.equal(state.backdropFilter, "none", `${id} ${theme} keeps a glass backdrop`);
      assert.ok(state.width > 0 && state.right <= state.viewport + 1, `${id} ${theme} overflows horizontally`);
      await page.screenshot({ path: join(outputDir, `${id}-${theme}-390.png`), fullPage: true });
      await page.close();
    }

    const desktop = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      colorScheme: "light",
      deviceScaleFactor: 1,
    });
    await desktop.setContent(fixtureFromTemplate(template, m3Pages), { waitUntil: "load" });
    await desktop.locator(rootSelector).waitFor();
    await desktop.screenshot({ path: join(outputDir, `${id}-light-1280.png`), fullPage: true });
    await desktop.close();
  }
} finally {
  await browser.close();
}

console.log(`test-m3-entry-pages-visual: ok (${outputDir})`);
