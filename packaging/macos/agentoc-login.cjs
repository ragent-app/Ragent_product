"use strict";

// A per-user, opt-in LaunchAgent. Never overwrite an existing plist or unload
// a job unless both its on-disk definition and launchd's reported source match.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const LABEL = "cloud.agenton.ragent";
const LEGACY_LABEL = "cloud.agenton.agentoc";

function xml(value) {
  const text = String(value);
  if (/[\u0000-\u001f\u007f]/u.test(text)) throw new Error("Paths may not contain control characters");
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
}
function buildPlist({ home, resources, config, port = "7690", instanceRoot = "", legacyPort = false, legacyService = false, label = LABEL }) {
  if (![LABEL, LEGACY_LABEL].includes(label)) throw new Error("Invalid login service label");
  for (const value of [home, resources, config]) {
    if (!path.isAbsolute(value)) throw new Error("Home, application and configuration paths must be absolute");
  }
  const string = (value) => `<string>${xml(value)}</string>`;
  if (!/^[0-9]{1,5}$/.test(port) || +port < 1 || +port > 65535) throw new Error("Invalid service port");
  if (instanceRoot && !path.isAbsolute(instanceRoot)) throw new Error("Instance root must be an absolute path");
  // Keep the original default-port definition byte-for-byte compatible with
  // existing installations. Non-default ports must survive a fresh login.
  const portEntry = !legacyPort && Number(port) !== 7690 ? `<key>CHAT_PORT</key>${string(port)}` : "";
  const instanceEntry = instanceRoot ? `<key>AGENTOC_INSTANCE_ROOT</key>${string(instanceRoot)}` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key>${string(label)}
<key>ProgramArguments</key><array>${string(path.join(resources, legacyService ? "agentoc-service" : "ragent-service"))}</array>
<key>EnvironmentVariables</key><dict><key>HOME</key>${string(home)}<key>AGENTOC_CONFIG_DIR</key>${string(config)}${portEntry}${instanceEntry}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>Umask</key><integer>63</integer>
<key>WorkingDirectory</key>${string(home)}
<key>StandardOutPath</key>${string(path.join(config, "launch-agent.stdout.log"))}
<key>StandardErrorPath</key>${string(path.join(config, "launch-agent.stderr.log"))}
</dict></plist>
`;
}
function readOwnedFile(file, expected, uid, legacyExpected = []) {
  let st;
  try { st = fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return false; throw error; }
  const content = st.isFile() && !st.isSymbolicLink() && st.uid === uid ? fs.readFileSync(file, "utf8") : "";
  if (content !== expected && !legacyExpected.includes(content)) {
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
function manage(action, { home, resources, config, port, instanceRoot = "", uid, run = runCommand }) {
  if (!["enable", "disable", "status", "migrate"].includes(action)) throw new Error("Usage: ragent-login enable|disable|status");
  if (!Number.isInteger(uid) || uid < 1) throw new Error("Run this as the desktop user, not root");
  if (!/^[0-9]{1,5}$/.test(port) || +port < 1 || +port > 65535) throw new Error("Invalid service port");
  const expected = buildPlist({ home, resources, config, port, instanceRoot });
  const legacyExpected = [
    buildPlist({ home, resources, config, port, instanceRoot, legacyPort: true }),
    buildPlist({ home, resources, config, port }),
    buildPlist({ home, resources, config, port, legacyPort: true }),
    buildPlist({ home, resources, config, port, instanceRoot, legacyService: true }),
    buildPlist({ home, resources, config, port, instanceRoot, legacyService: true, legacyPort: true }),
    buildPlist({ home, resources, config, port, legacyService: true }),
    buildPlist({ home, resources, config, port, legacyService: true, legacyPort: true }),
  ];
  const dir = path.join(home, "Library", "LaunchAgents");
  const file = path.join(dir, `${LABEL}.plist`);
  const legacyFile = path.join(dir, `${LEGACY_LABEL}.plist`);
  const domain = `gui/${uid}`;
  const target = `${domain}/${LABEL}`;
  let owned = readOwnedFile(file, expected, uid, legacyExpected);
  // A renamed application may have replaced the old sibling in Applications.
  // Only accept exact definitions produced by our own earlier versions.
  const oldResources = resources.endsWith("/Ragent.app/Contents/Resources")
    ? resources.slice(0, -"Ragent.app/Contents/Resources".length) + "AgentoC.app/Contents/Resources"
    : resources;
  const oldDefinitions = [...new Set([resources, oldResources])].flatMap(old => [
    buildPlist({ home, resources: old, config, port, instanceRoot, legacyService: true, label: LEGACY_LABEL }),
    buildPlist({ home, resources: old, config, port, instanceRoot, legacyService: true, legacyPort: true, label: LEGACY_LABEL }),
    buildPlist({ home, resources: old, config, port, legacyService: true, label: LEGACY_LABEL }),
    buildPlist({ home, resources: old, config, port, legacyService: true, legacyPort: true, label: LEGACY_LABEL }),
  ]);
  const oldExact = [...new Set([resources, oldResources])].map(old =>
    buildPlist({ home, resources: old, config, port, instanceRoot, legacyService: true, label: LEGACY_LABEL }));
  const legacyOwned = readOwnedFile(legacyFile, oldExact[0], uid, oldDefinitions);
  const oldProbe = run("/bin/launchctl", ["print", `${domain}/${LEGACY_LABEL}`]);
  const oldLoaded = oldProbe.ok;
  if (!oldLoaded && oldProbe.status !== 113) throw new Error(`Could not inspect the previous login service: ${oldProbe.stderr.trim()}`);
  if (oldLoaded && (!legacyOwned || reportedPlist(oldProbe.stdout) !== legacyFile)) {
    throw new Error("Another login item uses the previous service label; it was left unchanged");
  }
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
  if (legacyOwned && owned) throw new Error("Both old and new login items exist; neither was changed");
  if (action === "migrate" && !legacyOwned) {
    if (owned === "legacy") {
      const previous = buildPlist({ home, resources, config, port, instanceRoot, legacyService: true });
      const before = fs.readFileSync(file, "utf8");
      if (before !== previous) throw new Error("Existing login item has different settings; disable it before upgrading");
      if (!fs.existsSync(path.join(resources, "ragent-service"))) throw new Error("Application service is missing");
      if (loaded && !fs.existsSync(path.join(resources, "agentoc-service"))) {
        throw new Error("The previous login service is running but its old helper is unavailable; stop it before upgrading");
      }
      fs.mkdirSync(config, { recursive: true, mode: 0o700 });
      for (const name of ["launch-agent.stdout.log", "launch-agent.stderr.log"]) ensurePrivateLog(path.join(config, name), uid);
      const suffix = require("node:crypto").randomBytes(12).toString("hex");
      const tmp = path.join(dir, `.ragent-login-${process.pid}-${suffix}`);
      const backup = `${tmp}.previous`;
      let stopped = false, replaced = false, started = false;
      try {
        fs.writeFileSync(tmp, expected, { flag: "wx", mode: 0o600 });
        fs.linkSync(file, backup);
        if (readOwnedFile(file, expected, uid, legacyExpected) !== "legacy" || fs.readFileSync(file, "utf8") !== before) {
          throw new Error("Existing login service changed during migration");
        }
        if (loaded) {
          if (!run("/bin/launchctl", ["bootout", domain, file]).ok) throw new Error("Could not stop previous login service");
          stopped = true;
        }
        fs.renameSync(tmp, file); replaced = true;
        if (loaded) {
          const result = run("/bin/launchctl", ["bootstrap", domain, file]);
          if (!result.ok) throw new Error(`Could not start migrated login service: ${result.stderr.trim()}`);
          started = true;
        }
        fs.unlinkSync(backup);
        return started ? "enabled; previous helper migrated" : "previous helper migrated; not loaded";
      } catch (error) {
        if (started && !run("/bin/launchctl", ["bootout", domain, file]).ok)
          throw new Error(`Migration failed and the new login service could not be stopped: ${error.message}`);
        if (replaced) {
          if (fs.readFileSync(backup, "utf8") !== before || readOwnedFile(file, expected, uid) !== "current")
            throw new Error(`Migration failed; retained the previous login item at ${backup}: ${error.message}`);
          fs.renameSync(backup, file);
        }
        if (stopped && !run("/bin/launchctl", ["bootstrap", domain, file]).ok)
          throw new Error(`Migration failed and the previous login service could not be restarted: ${error.message}`);
        throw error;
      } finally {
        try { fs.unlinkSync(tmp); } catch (error) { if (error.code !== "ENOENT") throw error; }
        if (!replaced) { try { fs.unlinkSync(backup); } catch (error) { if (error.code !== "ENOENT") throw error; } }
      }
    }
    return "no previous service to migrate";
  }
  if (legacyOwned) {
    if (action === "status") return oldLoaded ? "enabled (previous service name)" : "installed but not loaded (previous service name)";
    if (action === "disable") {
      if (oldLoaded && !run("/bin/launchctl", ["bootout", domain, legacyFile]).ok) throw new Error("Could not stop previous login service");
      if (readOwnedFile(legacyFile, oldExact[0], uid, oldDefinitions)) fs.unlinkSync(legacyFile);
      return "disabled; configuration and logs retained";
    }
    const oldContent = fs.readFileSync(legacyFile, "utf8");
    if (!oldExact.includes(oldContent)) throw new Error("Previous login item has different settings; disable it before enabling the new service");
    if (!fs.existsSync(path.join(resources, "ragent-service"))) throw new Error("Application service is missing");
    const previousResources = [...new Set([resources, oldResources])][oldExact.indexOf(oldContent)];
    if (oldLoaded && !fs.existsSync(path.join(previousResources, "agentoc-service"))) {
      throw new Error("The previous login service is running but its old helper is unavailable; stop it before upgrading");
    }
    fs.mkdirSync(config, { recursive: true, mode: 0o700 });
    for (const name of ["launch-agent.stdout.log", "launch-agent.stderr.log"]) ensurePrivateLog(path.join(config, name), uid);
    const tmp = path.join(dir, `.ragent-login-${process.pid}-${require("node:crypto").randomBytes(12).toString("hex")}`);
    let created = false, stopped = false, startedNew = false;
    try {
      fs.writeFileSync(tmp, expected, { flag: "wx", mode: 0o600 });
      fs.linkSync(tmp, file); created = true;
      if (oldLoaded) {
        if (!run("/bin/launchctl", ["bootout", domain, legacyFile]).ok) throw new Error("Could not stop previous login service");
        stopped = true;
      } else if (action !== "migrate") {
        const listener = run("/usr/sbin/lsof", ["-nP", "-ti", `TCP:${port}`, "-sTCP:LISTEN"]);
        if (listener.ok && listener.stdout.trim()) throw new Error(`Port ${port} is in use`);
        if (!listener.ok && (listener.status !== 1 || listener.stderr.trim())) throw new Error("Could not check the service port");
      }
      if (oldLoaded || action !== "migrate") {
        const started = run("/bin/launchctl", ["bootstrap", domain, file]);
        if (!started.ok) throw new Error(`Could not enable login service: ${started.stderr.trim()}`);
        startedNew = true;
      }
      if (readOwnedFile(legacyFile, oldExact[0], uid, oldDefinitions)) fs.unlinkSync(legacyFile);
      return startedNew ? "enabled; previous service migrated" : "previous service migrated; not loaded";
    } catch (error) {
      if (startedNew && !run("/bin/launchctl", ["bootout", domain, file]).ok) {
        throw new Error(`Migration failed and the new login service could not be stopped: ${error.message}`);
      }
      if (created && readOwnedFile(file, expected, uid)) fs.unlinkSync(file);
      if (stopped && !run("/bin/launchctl", ["bootstrap", domain, legacyFile]).ok) {
        throw new Error(`Migration failed and the previous login service could not be restarted: ${error.message}`);
      }
      throw error;
    } finally { try { fs.unlinkSync(tmp); } catch (error) { if (error.code !== "ENOENT") throw error; } }
  }
  if (action === "status") {
    if (owned === "legacy") return loaded
      ? "enabled; disable and re-enable to retain the configured port and instance root"
      : "installed but not loaded; disable and re-enable to retain the configured port and instance root";
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
  if (owned === "legacy") throw new Error("Existing login item does not retain the configured port or instance root; disable it and enable it again");
  if (loaded) return "already enabled";
  if (!fs.existsSync(path.join(resources, "ragent-service"))) throw new Error("Application service is missing");
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
    const tmp = path.join(dir, `.ragent-login-${process.pid}-${require("node:crypto").randomBytes(12).toString("hex")}`);
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
    const result = manage(action, { home: process.env.HOME || "", resources, config, port,
      instanceRoot: process.env.AGENTOC_INSTANCE_ROOT || "", uid: process.getuid() });
    console.log(`Ragent login service: ${result}`);
  } catch (error) { console.error(`Ragent login service: ${error.message}`); process.exitCode = 1; }
}
module.exports = { buildPlist, manage, reportedPlist };
