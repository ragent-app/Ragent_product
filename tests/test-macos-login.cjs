"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { manage, buildPlist, reportedPlist } = require("../packaging/macos/ragent-login.cjs");

function withPosixStatShim(root, uid, fn) {
  if (process.platform !== "win32") return fn();
  const originalLstatSync = fs.lstatSync;
  const resolvedRoot = path.resolve(root).toLowerCase();
  fs.lstatSync = (targetPath, options) => {
    const stat = originalLstatSync(targetPath, options);
    const resolvedTarget = path.resolve(String(targetPath)).toLowerCase();
    if (resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + path.sep)) {
      stat.uid = uid;
      stat.mode = stat.mode & ~0o077;
    }
    return stat;
  };
  try {
    return fn();
  } finally {
    fs.lstatSync = originalLstatSync;
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragent-login-test-"));
const home = path.join(root, "home & user");
const resources = path.join(root, "app & test", "Contents", "Resources");
const config = path.join(home, ".config", "ragent");
const uid = typeof process.getuid === "function" ? process.getuid() : 501;
const args = { home, resources, config, port: "47681", uid };
const plist = path.join(home, "Library", "LaunchAgents", "cloud.agenton.ragent.plist");

let loaded = false;
let occupied = false;
let foreign = false;
let failBootstrap = false;
let failBootout = false;

const ok = (stdout = "") => ({ ok: true, status: 0, stdout, stderr: "" });
const fail = (status, stderr = "") => ({ ok: false, status, stdout: "", stderr });

const run = (command, argv) => {
  if (command.endsWith("lsof")) return occupied ? ok("123\n") : fail(1);
  if (argv[0] === "print" && argv[1] === `gui/${uid}`) return ok();
  if (argv[0] === "print" && argv[1] === `gui/${uid}/cloud.agenton.ragent`) {
    return loaded ? ok(`path = ${foreign ? "/somebody/else.plist" : plist}\n`) : fail(113);
  }
  if (argv[0] === "bootstrap" && argv[2] === plist) {
    if (failBootstrap) return fail(5, "fixture failure");
    loaded = true;
    return ok();
  }
  if (argv[0] === "bootout" && argv[2] === plist) {
    if (failBootout) return fail(5, "fixture stop failure");
    loaded = false;
    return ok();
  }
  throw new Error(`unexpected command ${command} ${argv}`);
};

const invoke = (action) => manage(action, { ...args, run });

try {
  withPosixStatShim(root, uid, () => {
    fs.mkdirSync(resources, { recursive: true });
    fs.writeFileSync(path.join(resources, "ragent-service"), "fixture");

    // Sole valid LaunchAgent label enforcement and plist XML formatting.
    const defaultPlist = buildPlist(args);
    assert.match(defaultPlist, /<key>Label<\/key><string>cloud\.agenton\.ragent<\/string>/);
    assert.match(defaultPlist, /ragent-service/);
    assert.match(defaultPlist, /app &amp; test/);
    assert.match(defaultPlist, /<key>CHAT_PORT<\/key><string>47681<\/string>/);
    assert.doesNotMatch(buildPlist({ ...args, port: "7690" }), /<key>CHAT_PORT<\/key>/);
    assert.throws(() => buildPlist({ ...args, label: "cloud.agenton.agentoc" }), /Invalid login service label/);
    assert.throws(() => buildPlist({ ...args, label: "com.example.other" }), /Invalid login service label/);
    assert.throws(() => buildPlist({ ...args, home: `${home}\n` }), /control characters/);

    const instanceRoot = path.join(root, "instance & data");
    const instanceArgs = { ...args, instanceRoot };
    assert.match(buildPlist(instanceArgs), /<key>RAGENT_INSTANCE_ROOT<\/key><string>.*instance &amp; data<\/string>/);
    assert.throws(() => buildPlist({ ...args, instanceRoot: "relative/path" }), /absolute path/);

    assert.equal(reportedPlist(`\tpath = ${plist}\n`), plist);
    assert.equal(reportedPlist(`path = ${plist}\npath = /other.plist\n`), "");
    assert.equal(reportedPlist("state = running\n"), "");

    assert.throws(() => invoke("bogus"), /Usage: ragent-login enable\|disable\|status/);
    assert.throws(() => manage("status", { ...args, uid: 0, run }), /not root/);

    // Fresh installation: disabled, migrate is a no-op, no plist written.
    assert.equal(invoke("status"), "disabled");
    assert.equal(invoke("migrate"), "no previous service to migrate");
    assert.equal(invoke("disable"), "disabled; configuration and logs retained");
    assert.equal(fs.existsSync(plist), false, "fresh installation must not enable login startup");

    // Pre-flight port occupancy and bootstrap rollback.
    occupied = true;
    assert.throws(() => invoke("enable"), /Port 47681 is in use/);
    occupied = false;
    failBootstrap = true;
    assert.throws(() => invoke("enable"), /fixture failure/);
    assert.equal(fs.existsSync(plist), false);
    failBootstrap = false;

    // Enable -> status/enable/migrate with cloud.agenton.ragent.plist present -> disable.
    assert.equal(invoke("enable"), "enabled");
    assert.equal(fs.existsSync(plist), true);
    assert.match(fs.readFileSync(plist, "utf8"), /cloud\.agenton\.ragent/);
    assert.equal(invoke("status"), "enabled");
    assert.equal(invoke("enable"), "already enabled");
    assert.equal(invoke("migrate"), "no previous service to migrate");
    if (process.platform !== "win32") {
      for (const name of ["launch-agent.stdout.log", "launch-agent.stderr.log"]) {
        assert.equal(fs.statSync(path.join(config, name)).mode & 0o777, 0o600);
      }
    }

    // Valid plist present on disk but not currently loaded in launchd.
    loaded = false;
    assert.equal(invoke("status"), "installed but not loaded");
    assert.equal(invoke("migrate"), "no previous service to migrate");
    assert.equal(invoke("enable"), "enabled");
    assert.equal(loaded, true);
    assert.equal(invoke("status"), "enabled");

    // Foreign launchd job claiming the Ragent label must never be altered.
    foreign = true;
    for (const action of ["status", "enable", "disable", "migrate"]) {
      assert.throws(() => invoke(action), /Another login item uses the Ragent service label/);
    }
    assert.equal(loaded, true);
    assert.equal(fs.existsSync(plist), true);
    foreign = false;

    // Clean disable when plist is present and loaded.
    assert.equal(invoke("disable"), "disabled; configuration and logs retained");
    assert.equal(loaded, false);
    assert.equal(fs.existsSync(plist), false);
    assert.equal(fs.existsSync(path.join(config, "launch-agent.stdout.log")), true);
    assert.equal(fs.existsSync(path.join(config, "launch-agent.stderr.log")), true);

    // Non-default port plist written without CHAT_PORT remains removable,
    // warns on status, and refuses enable/migrate until re-enabled.
    fs.writeFileSync(plist, buildPlist({ ...args, legacyPort: true }));
    loaded = true;
    assert.match(invoke("status"), /re-enable to retain the configured port/);
    assert.throws(() => invoke("enable"), /disable it and enable it again/);
    assert.throws(() => invoke("migrate"), /Existing login item has different settings/);
    assert.equal(invoke("disable"), "disabled; configuration and logs retained");
    assert.equal(invoke("enable"), "enabled");
    assert.match(fs.readFileSync(plist, "utf8"), /<key>CHAT_PORT<\/key><string>47681<\/string>/);
    assert.equal(invoke("disable"), "disabled; configuration and logs retained");

    // Existing plist omitting a now-explicit instance root behaves the same way.
    fs.writeFileSync(plist, buildPlist(args));
    loaded = true;
    const invokeInstance = (action) => manage(action, { ...instanceArgs, run });
    assert.match(invokeInstance("status"), /disable and re-enable/);
    assert.throws(() => invokeInstance("enable"), /instance root/);
    assert.throws(() => invokeInstance("migrate"), /Existing login item has different settings/);
    assert.equal(invokeInstance("disable"), "disabled; configuration and logs retained");
    assert.equal(invokeInstance("enable"), "enabled");
    assert.equal(invokeInstance("status"), "enabled");
    assert.match(fs.readFileSync(plist, "utf8"), /<key>RAGENT_INSTANCE_ROOT<\/key>/);
    assert.equal(invokeInstance("disable"), "disabled; configuration and logs retained");

    // Bootout failure leaves plist intact so user state is not silently lost.
    assert.equal(invoke("enable"), "enabled");
    failBootout = true;
    assert.throws(() => invoke("disable"), /Could not stop login service: fixture stop failure/);
    assert.equal(loaded, true);
    assert.equal(fs.existsSync(plist), true);
    failBootout = false;
    assert.equal(invoke("disable"), "disabled; configuration and logs retained");

    // User-owned / unknown plist content at cloud.agenton.ragent.plist must never be touched.
    fs.writeFileSync(plist, "user-owned definition");
    for (const action of ["status", "enable", "disable", "migrate"]) {
      assert.throws(() => invoke(action), /not the expected Ragent definition/);
    }
    assert.equal(fs.readFileSync(plist, "utf8"), "user-owned definition");

    console.log("macOS login service management checks passed");
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
