#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source = await readFile(join(repoRoot, "static/chat/monet-theme-contract.js"), "utf8");

const context = {
  window: {
    CSS: {
      supports(property, value) {
        return property === "color" && (
          /^#[\da-f]{3,8}$/i.test(value)
          || /^(rgb|hsl|oklch|color)\(/i.test(value)
        );
      },
    },
  },
};
vm.runInNewContext(source, context, { filename: "static/chat/monet-theme-contract.js" });

const contract = context.window.RagentMonetThemeContract;
assert.equal(contract.version, 1, "Monet contract version should be explicit");

function createRoot() {
  const values = new Map();
  const removed = [];
  return {
    values,
    removed,
    style: {
      setProperty(name, value) {
        values.set(name, value);
      },
      removeProperty(name) {
        values.delete(name);
        removed.push(name);
      },
    },
  };
}

const root = createRoot();
const nested = contract.apply({
  version: 1,
  roles: {
    primary: "#6750a4",
    "--sys-on-surface": "#1d1b20",
    surfaceContainer: "#f3edf7",
    unknown: "#123456",
  },
  themeColor: {
    light: "#fbf8ff",
    dark: "#141218",
  },
}, root);

assert.deepEqual([...nested.applied], ["primary", "on-surface", "surface-container"]);
assert.deepEqual([...nested.rejected], ["unknown"]);
assert.equal(root.values.get("--sys-primary"), "#6750a4");
assert.equal(root.values.get("--accent"), "#6750a4");
assert.equal(root.values.get("--sys-on-surface"), "#1d1b20");
assert.equal(nested.themeColorOverrides.light, "#fbf8ff");
assert.equal(nested.themeColorOverrides.dark, "#141218");

const flat = contract.apply({
  primary: "#123456",
  surface: "#f8f8fa",
  "surface-dark": "#161618",
  background: "#f8f8fa",
}, root);
assert.deepEqual([...flat.applied], ["primary", "surface"]);
assert.deepEqual([...flat.rejected], []);
assert.equal(flat.themeColorOverrides.light, "#f8f8fa");
assert.equal(flat.themeColorOverrides.dark, "#161618");

const invalid = contract.apply({
  roles: { primary: "#12; color: red", surface: "#ffffff" },
  themeColor: { light: "#ffffff", dark: "not-a-color" },
}, root);
assert.deepEqual([...invalid.applied], ["surface"]);
assert.deepEqual([...invalid.rejected], ["primary"]);
assert.equal(invalid.themeColorOverrides.light, "#ffffff");
assert.equal(invalid.themeColorOverrides.dark, "#ffffff");
assert.equal(root.values.get("--sys-primary"), "#123456", "invalid primary must not replace the previous CSS value");

const cleared = contract.apply(null, root);
assert.deepEqual([...cleared.applied], []);
assert.deepEqual([...cleared.rejected], []);
assert.equal(cleared.themeColorOverrides, null);
assert.equal(root.values.size, 0, "clearing Monet must remove all bound variables");
assert.ok(root.removed.includes("--sys-primary"));

console.log("test-chat-monet-theme-runtime: ok");
