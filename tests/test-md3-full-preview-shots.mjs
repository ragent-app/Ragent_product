#!/usr/bin/env node
// Static render check for the md3-full-ui-preview gallery: serves the
// artifact directory over HTTP (file:// breaks @import with query strings),
// screenshots every page in light/dark at desktop + mobile widths, and
// asserts no page throws or ends up blank.
import { mkdir, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const previewRoot = join(repoRoot, "artifacts", "md3-full-ui-preview");
const outputDir = process.env.RAGENT_VISUAL_OUTPUT_DIR || join(repoRoot, "artifacts", "md3-full-ui-preview-shots");
await mkdir(outputDir, { recursive: true });

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".gif": "image/gif",
  ".md": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    let filePath = resolve(previewRoot, "." + urlPath);
    if (!filePath.startsWith(resolve(previewRoot))) {
      res.writeHead(403); res.end("forbidden"); return;
    }
    let stat;
    try { stat = await import("node:fs/promises").then((f) => f.stat(filePath)); }
    catch { res.writeHead(404); res.end("not found"); return; }
    if (stat.isDirectory()) {
      const names = (await readdir(filePath)).filter((n) => n.endsWith(".html")).sort();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<ul>${names.map((n) => `<li><a href="${n}">${n}</a></li>`).join("")}</ul>`);
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[extname(filePath)] || "application/octet-stream" });
    const { readFile } = await import("node:fs/promises");
    res.end(await readFile(filePath));
  } catch (error) {
    res.writeHead(500); res.end(String(error?.message || error));
  }
});

await new Promise((resolveReady) => server.listen(0, "127.0.0.1", resolveReady));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const pages = ["index.html", "chat.html", "overlays.html", "pages.html"];
const browser = await chromium.launch({ headless: true });
let failures = 0;
try {
  for (const pageName of pages) {
    for (const theme of ["light", "dark"]) {
      for (const width of [1440, 390]) {
        const page = await browser.newPage({ viewport: { width, height: 1000 }, deviceScaleFactor: 1 });
        try {
          await page.emulateMedia({ colorScheme: theme });
          const errors = [];
          page.on("pageerror", (error) => errors.push(String(error)));
          await page.goto(`${base}/${pageName}`, { waitUntil: "load" });
          await page.evaluate((selectedTheme) => { document.documentElement.dataset.theme = selectedTheme; }, theme);
          await page.waitForTimeout(260);
          const bodyInfo = await page.evaluate(() => {
            const body = document.body;
            const box = body.getBoundingClientRect();
            return {
              scrollWidth: document.documentElement.scrollWidth,
              clientWidth: document.documentElement.clientWidth,
              bodyHeight: Math.round(box.height),
              text: (body.innerText || "").trim().slice(0, 60),
            };
          });
          const overflow = bodyInfo.scrollWidth > bodyInfo.clientWidth + 2;
          if (overflow) { console.log(`OVERFLOW ${pageName} ${theme} ${width}px (scroll ${bodyInfo.scrollWidth} > client ${bodyInfo.clientWidth})`); failures++; }
          if (!bodyInfo.text && bodyInfo.bodyHeight < 100) { console.log(`BLANK ${pageName} ${theme} ${width}px`); failures++; }
          const shotName = `${pageName.replace(".html", "")}-${theme}-${width}px.png`;
          await page.screenshot({ path: join(outputDir, shotName), fullPage: true });
          console.log(`shot ${shotName} (h=${bodyInfo.bodyHeight}px, overflow=${overflow ? "YES" : "no"}, errors=${errors.length})`);
        } finally {
          await page.close();
        }
      }
    }
  }
} finally {
  await browser.close();
  server.close();
}
console.log(failures === 0 ? "md3-full-preview: all pages rendered without horizontal overflow" : `md3-full-preview: ${failures} issue(s)`);
process.exit(failures === 0 ? 0 : 1);
