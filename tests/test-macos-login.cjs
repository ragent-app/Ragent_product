"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { manage, buildPlist } = require("../packaging/macos/agentoc-login.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentoc-login-test-"));
const home = path.join(root, "home & user");
const resources = path.join(root, "app & test", "Contents", "Resources");
const config = path.join(home, ".config", "agentoc");
const uid = process.getuid();
const args = { home, resources, config, port: "47681", uid };
const plist = path.join(home, "Library", "LaunchAgents", "cloud.agenton.ragent.plist");
const oldPlist = path.join(home, "Library", "LaunchAgents", "cloud.agenton.agentoc.plist");
let loaded = false;
let oldLoaded = false;
let occupied = false;
let foreign = false;
let failBootstrap = false;
const ok = (stdout = "") => ({ ok: true, status: 0, stdout, stderr: "" });
const fail = (status, stderr = "") => ({ ok: false, status, stdout: "", stderr });
const run = (command, argv) => {
  if (command.endsWith("lsof")) return occupied ? ok("123\n") : fail(1);
  if (argv[0] === "print" && argv[1] === `gui/${uid}`) return ok();
  if (argv[0] === "print" && argv[1].endsWith("/cloud.agenton.agentoc")) return oldLoaded ? ok(`path = ${foreign ? "/somebody/else.plist" : oldPlist}\n`) : fail(113);
  if (argv[0] === "print") return loaded ? ok(`path = ${foreign ? "/somebody/else.plist" : plist}\n`) : fail(113);
  if (argv[0] === "bootstrap" && argv[2] === oldPlist) { oldLoaded = true; return ok(); }
  if (argv[0] === "bootstrap") { if (failBootstrap) return fail(5, "fixture failure"); loaded = true; return ok(); }
  if (argv[0] === "bootout" && argv[2] === oldPlist) { oldLoaded = false; return ok(); }
  if (argv[0] === "bootout") { loaded = false; return ok(); }
  throw new Error(`unexpected command ${command} ${argv}`);
};
const invoke = (action) => manage(action, { ...args, run });
try {
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(resources, "agentoc-service"), "fixture");
  assert.match(buildPlist(args), /app &amp; test/);
  assert.match(buildPlist(args), /<key>CHAT_PORT<\/key><string>47681<\/string>/);
  assert.doesNotMatch(buildPlist({ ...args, port: "7690" }), /<key>CHAT_PORT<\/key>/);
  const instanceRoot = path.join(root, "instance & data");
  const instanceArgs = { ...args, instanceRoot };
  assert.match(buildPlist(instanceArgs), /<key>AGENTOC_INSTANCE_ROOT<\/key><string>.*instance &amp; data<\/string>/);
  assert.throws(() => buildPlist({ ...args, instanceRoot: "relative/path" }), /absolute path/);
  assert.equal(invoke("status"), "disabled");
  assert.equal(invoke("migrate"), "no previous service to migrate");
  assert.equal(fs.existsSync(plist), false, "fresh installation must not enable login startup");
  occupied = true;
  assert.throws(() => invoke("enable"), /Port 47681 is in use/);
  occupied = false;
  failBootstrap = true;
  assert.throws(() => invoke("enable"), /fixture failure/);
  assert.equal(fs.existsSync(plist), false);
  failBootstrap = false;
  assert.equal(invoke("enable"), "enabled");
  assert.equal(invoke("status"), "enabled");
  assert.equal(invoke("enable"), "already enabled");
  for (const name of ["launch-agent.stdout.log", "launch-agent.stderr.log"]) {
    assert.equal(fs.statSync(path.join(config, name)).mode & 0o777, 0o600);
  }
  foreign = true;
  assert.throws(() => invoke("disable"), /Another login item/);
  assert.equal(loaded, true);
  foreign = false;
  assert.equal(invoke("disable"), "disabled; configuration and logs retained");
  assert.equal(fs.existsSync(plist), false);
  assert.equal(fs.existsSync(path.join(config, "launch-agent.stdout.log")), true);
  // A definition written by the old version remains removable, but cannot be
  // silently accepted as correctly configured for a non-default port.
  fs.writeFileSync(plist, buildPlist({ ...args, legacyPort: true }));
  loaded = true;
  assert.match(invoke("status"), /re-enable to retain the configured port/);
  assert.throws(() => invoke("enable"), /disable it and enable it again/);
  assert.equal(invoke("disable"), "disabled; configuration and logs retained");
  assert.equal(invoke("enable"), "enabled");
  assert.match(fs.readFileSync(plist, "utf8"), /<key>CHAT_PORT<\/key><string>47681<\/string>/);
  assert.equal(invoke("disable"), "disabled; configuration and logs retained");
  // Older definitions that omitted a now-explicit instance root are still
  // removable, but must not silently start with a different data directory.
  fs.writeFileSync(plist, buildPlist(args));
  loaded = true;
  const invokeInstance = (action) => manage(action, { ...instanceArgs, run });
  assert.match(invokeInstance("status"), /disable and re-enable/);
  assert.throws(() => invokeInstance("enable"), /instance root/);
  assert.equal(invokeInstance("disable"), "disabled; configuration and logs retained");
  fs.writeFileSync(oldPlist, buildPlist({ ...args, label: "cloud.agenton.agentoc" }));
  oldLoaded = true;
  assert.match(invoke("status"), /previous service name/);
  foreign = true;
  assert.throws(() => invoke("migrate"), /Another login item/);
  assert.equal(oldLoaded, true);
  foreign = false;
  failBootstrap = true;
  assert.throws(() => invoke("enable"), /fixture failure/);
  assert.equal(oldLoaded, true, "failed migration restores the previous running service");
  assert.equal(fs.existsSync(oldPlist), true);
  assert.equal(fs.existsSync(plist), false);
  failBootstrap = false;
  assert.equal(invoke("enable"), "enabled; previous service migrated");
  assert.equal(oldLoaded, false);
  assert.equal(loaded, true);
  assert.equal(fs.existsSync(oldPlist), false);
  assert.match(fs.readFileSync(plist, "utf8"), /cloud\.agenton\.ragent/);
  assert.equal(invoke("disable"), "disabled; configuration and logs retained");
  fs.writeFileSync(oldPlist, buildPlist({ ...args, label: "cloud.agenton.agentoc" }));
  assert.equal(invoke("migrate"), "previous service migrated; not loaded");
  assert.equal(loaded, false, "unloaded legacy login item remains unloaded");
  assert.equal(fs.existsSync(oldPlist), false);
  assert.equal(invoke("disable"), "disabled; configuration and logs retained");
  fs.writeFileSync(oldPlist, "foreign definition");
  assert.throws(() => invoke("enable"), /not the expected Ragent definition/);
  assert.equal(fs.readFileSync(oldPlist, "utf8"), "foreign definition");
  fs.unlinkSync(oldPlist);
  assert.equal(invokeInstance("enable"), "enabled");
  assert.match(fs.readFileSync(plist, "utf8"), /<key>AGENTOC_INSTANCE_ROOT<\/key>/);
  assert.equal(invokeInstance("disable"), "disabled; configuration and logs retained");
  fs.writeFileSync(plist, "user-owned definition");
  assert.throws(() => invoke("enable"), /not the expected Ragent definition/);
  assert.throws(() => invoke("disable"), /not the expected Ragent definition/);
  assert.equal(fs.readFileSync(plist, "utf8"), "user-owned definition");
  console.log("macOS login service management checks passed");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
