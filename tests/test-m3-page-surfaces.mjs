#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const [pages, ...templates] = await Promise.all([
  readFile(join(repoRoot, "static/m3-pages.css"), "utf8"),
  ...[
    "login.html",
    "admin-login.html",
    "instance-admin.html",
    "mobile-install.html",
  ].map((file) => readFile(join(repoRoot, "templates", file), "utf8")),
]);

for (const source of [pages]) {
  assert.match(source, /--m3-primary\s*:/, "page surface defines a primary role");
  assert.match(source, /--m3-surface-container\s*:/, "page surface defines a surface container role");
  assert.match(source, /focus-visible/, "page surface keeps a visible keyboard focus state");
  assert.match(source, /prefers-reduced-motion/, "page surface honors reduced motion");
}

for (const template of templates) {
  assert.match(template, /m3-pages\.css/, "template loads its M3 surface layer");
}

assert.doesNotMatch(pages, /background:\s*#(?:111|1c1c1e|202123)/i, "standalone page actions do not reintroduce black primary buttons");

console.log("test-m3-page-surfaces: ok");
