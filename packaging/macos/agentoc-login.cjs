"use strict";

// A per-user, opt-in LaunchAgent. Never overwrite an existing plist or unload
// a job unless both its on-disk definition and launchd's reported source match.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const LABEL = "cloud.agenton.agentoc";

function xml(value) {
  const text = String(value);
  if (/[\u0000-\u001f\u007f]/u.test(text)) throw new Error("Paths may not contain control characters");
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
}
function buildPlist({ home, resources, config, port = "7690", legacyPort = false }) {
  for (const value of [home, resources, config]) {
    if (!path.isAbsolute(value)) throw new Error("Home, application and configuration paths must be absolute");
  }
  const string = (value) => `<string>${xml(value)}</string>`;
  if (!/^[0-9]{1,5}$/.test(port) || +port < 1 || +port > 65535) throw new Error("Invalid service port");
  // Keep the original default-port definition byte-for-byte compatible with
  // existing installations. Non-default ports must survive a fresh login.
  const portEntry = !legacyPort && Number(port) !== 7690 ? `<key>CHAT_PORT</key>${string(port)}` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key>${string(LABEL)}
<key>ProgramArguments</key><array>${string(path.join(resources, "agentoc-service"))}</array>
<key>EnvironmentVariables</key><dict><key>HOME</key>${string(home)}<key>AGENTOC_CONFIG_DIR</key>${string(config)}${portEntry}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>Umask</key><integer>63</integer>
<key>WorkingDirectory</key>${string(home)}
<key>StandardOutPath</key>${string(path.join(config, "launch-agent.stdout.log"))}
<key>StandardErrorPath</key>${string(path.join(config, "launch-agent.stderr.log"))}
</dict></plist>
`;
}
function readOwnedFile(file, expected, uid, legacyExpected = expected) {
  let st;
  try { st = fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return false; throw error; }
  const content = st.isFile() && !st.isSymbolicLink() && st.uid === uid ? fs.readFileSync(file, "utf8") : "";
  if (content !== expected && content !== legacyExpected) {
    throw new Error(`Existing login item is not the expected Ragent definition: ${file}`);
  }
  return content === expected ? "current" : "legacy";
}
function ensurePrivateLog(file, uid) {
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o077) !== 0) {
    throw new Error(`Login service log must be a private regular file owned by this user: ${file}`);
  }
}
function runCommand(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  return { ok: result.status === 0, status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}
function reportedPlist(output) {
  const matches = [...output.matchAll(/^\s*path = (.*)$/gm)];
  return matches.length === 1 ? matches[0][1].trim() : "";
}
function manage(action, { home, resources, config, port, uid, run = runCommand }) {
  if (!["enable", "disable", "status"].includes(action)) throw new Error("Usage: agentoc-login enable|disable|status");
  if (!Number.isInteger(uid) || uid < 1) throw new Error("Run this as the desktop user, not root");
  if (!/^[0-9]{1,5}$/.test(port) || +port < 1 || +port > 65535) throw new Error("Invalid service port");
  const expected = buildPlist({ home, resources, config, port });
  const legacyExpected = buildPlist({ home, resources, config, port, legacyPort: true });
  const dir = path.join(home, "Library", "LaunchAgents");
  const file = path.join(dir, `${LABEL}.plist`);
  const domain = `gui/${uid}`;
  const target = `${domain}/${LABEL}`;
  let owned = readOwnedFile(file, expected, uid, legacyExpected);
  const probe = run("/bin/launchctl", ["print", target]);
  const loaded = probe.ok;
  if (!loaded) {
    if (probe.status !== 113 || !run("/bin/launchctl", ["print", domain]).ok) {
      throw new Error(`Could not inspect the login service: ${probe.stderr.trim()}`);
    }
  }
  if (loaded && (!owned || reportedPlist(probe.stdout) !== file)) {
    throw new Error("Another login item uses the Ragent service label; it was left unchanged");
  }
  if (action === "status") {
    if (owned === "legacy") return loaded
      ? "enabled; disable and re-enable to retain the configured port"
      : "installed but not loaded; disable and re-enable to retain the configured port";
    return loaded ? "enabled" : owned ? "installed but not loaded" : "disabled";
  }
  if (action === "disable") {
    if (loaded) {
      const result = run("/bin/launchctl", ["bootout", domain, file]);
      if (!result.ok) throw new Error(`Could not stop login service: ${result.stderr.trim()}`);
    }
    if (owned && readOwnedFile(file, expected, uid, legacyExpected)) fs.unlinkSync(file);
    return "disabled; configuration and logs retained";
  }
  if (owned === "legacy") throw new Error("Existing login item does not retain the configured port; disable it and enable it again");
  if (loaded) return "already enabled";
  if (!fs.existsSync(path.join(resources, "agentoc-service"))) throw new Error("Application service is missing");
  const listener = run("/usr/sbin/lsof", ["-nP", "-ti", `TCP:${port}`, "-sTCP:LISTEN"]);
  if (listener.ok && listener.stdout.trim()) throw new Error(`Port ${port} is in use; stop the running service before enabling login startup`);
  if (!listener.ok && (listener.status !== 1 || listener.stderr.trim())) throw new Error(`Could not check the service port: ${listener.stderr.trim()}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(config, { recursive: true, mode: 0o700 });
  for (const name of ["launch-agent.stdout.log", "launch-agent.stderr.log"]) ensurePrivateLog(path.join(config, name), uid);
  let created = false;
  if (!owned) {
    // Link a complete private file into place exclusively; never replace an
    // existing user-managed LaunchAgent, including one created concurrently.
    const tmp = path.join(dir, `.agentoc-login-${process.pid}-${require("node:crypto").randomBytes(12).toString("hex")}`);
    try {
      fs.writeFileSync(tmp, expected, { flag: "wx", mode: 0o600 });
      fs.linkSync(tmp, file);
      created = true;
      owned = "current";
    } finally { try { fs.unlinkSync(tmp); } catch (error) { if (error.code !== "ENOENT") throw error; } }
  }
  const result = run("/bin/launchctl", ["bootstrap", domain, file]);
  if (!result.ok) {
    if (created && readOwnedFile(file, expected, uid)) fs.unlinkSync(file);
    throw new Error(`Could not enable login service: ${result.stderr.trim()}`);
  }
  return "enabled";
}
if (require.main === module) {
  try {
    const [action, resources, config, port] = process.argv.slice(2);
    const result = manage(action, { home: process.env.HOME || "", resources, config, port, uid: process.getuid() });
    console.log(`Ragent login service: ${result}`);
  } catch (error) { console.error(`Ragent login service: ${error.message}`); process.exitCode = 1; }
}
module.exports = { buildPlist, manage, reportedPlist };
