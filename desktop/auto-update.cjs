"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const { createReadStream } = require("node:fs");
const { releaseAssetUrl } = require("./update-check.cjs");
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const HOSTS = new Set(["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com", "github-releases.githubusercontent.com"]);

function cacheName(digest, platform, arch) {
  if (!/^[a-f0-9]{64}$/.test(digest || "") || !/^(win32|darwin|linux)$/.test(platform) || !/^(x64|arm64)$/.test(arch)) throw Error("invalid-cache-identity");
  return `${platform}-${arch}-${digest}`;
}
async function clearCachedPackage(cacheRoot, digest, platform = process.platform, arch = process.arch) {
  const root = await fs.lstat(cacheRoot).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (!root) return;
  if (!root.isDirectory() || root.isSymbolicLink()) throw Error("invalid-cache-directory");
  await fs.rm(path.join(cacheRoot, cacheName(digest, platform, arch)), { recursive: true, force: true });
}
async function matchingPackage(file, info) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || stat.size > MAX_BYTES || (info.packageSize && stat.size !== info.packageSize)) return false;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest("hex") === info.packageSha256;
  } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
async function downloadPackage(info, { fetchImpl = fetch, tempRoot = os.tmpdir(), cacheRoot = path.join(tempRoot, "ragent-update-cache"), onProgress = () => {}, platform = process.platform, arch = process.arch } = {}) {
  if (!releaseAssetUrl(info.downloadUrl, platform, arch) || !/^[a-f0-9]{64}$/.test(info.packageSha256 || "")) throw Error("missing-verified-release-metadata");
  if (platform === "win32" && !new URL(info.downloadUrl).pathname.toLowerCase().endsWith("-setup.exe")) throw Error("unsupported-windows-installer");
  if (info.packageSize != null && (!Number.isSafeInteger(info.packageSize) || info.packageSize <= 0 || info.packageSize > MAX_BYTES)) throw Error("invalid-package-size");
  await fs.mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const rootStat = await fs.lstat(cacheRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw Error("invalid-cache-directory");
  const name = cacheName(info.packageSha256, platform, arch);
  const directory = path.join(cacheRoot, name);
  const packageName = platform === "win32" ? "Ragent-setup.exe" : platform === "darwin" ? "Ragent.dmg" : "Ragent.deb";
  const file = path.join(directory, packageName);
  const existing = await fs.lstat(directory).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw Error("invalid-cache-directory");
    if (await matchingPackage(file, info)) { onProgress(info.packageSize || (await fs.stat(file)).size, info.packageSize); return { directory, file, reused: true }; }
    await clearCachedPackage(cacheRoot, info.packageSha256, platform, arch);
  }
  const staging = await fs.mkdtemp(path.join(cacheRoot, ".download-"));
  const stagedFile = path.join(staging, packageName);
  let handle;
  try {
    let url = info.downloadUrl, response;
    for (let redirects = 0; redirects <= 5; redirects++) {
      const u = new URL(url);
      if (u.protocol !== "https:" || !HOSTS.has(u.hostname) || u.port || u.username || u.password || u.hash) throw Error("unsafe-download-redirect");
      response = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(15 * 60 * 1000) });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      if (redirects === 5 || !response.headers.get("location")) throw Error("too-many-redirects");
      url = new URL(response.headers.get("location"), url).href;
    }
    if (!response?.ok || !response.body) throw Error("download-failed");
    handle = await fs.open(stagedFile, "wx", 0o600);
    const hash = createHash("sha256"); let bytes = 0, last = 0;
    for await (const chunk of response.body) {
      const data = Buffer.from(chunk); bytes += data.length;
      if (bytes > MAX_BYTES || (info.packageSize && bytes > info.packageSize)) throw Error("package-too-large");
      hash.update(data); await handle.writeFile(data);
      if (Date.now() - last > 250) { onProgress(bytes, info.packageSize); last = Date.now(); }
    }
    await handle.close(); handle = null;
    if (!bytes || (info.packageSize && bytes !== info.packageSize) || hash.digest("hex") !== info.packageSha256) throw Error("package-checksum-mismatch");
    onProgress(bytes, info.packageSize);
    await fs.rename(staging, directory);
    return { directory, file, reused: false };
  } catch (error) { if (handle) await handle.close().catch(() => {}); await fs.rm(staging, { recursive: true, force: true }).catch(() => {}); throw error; }
}

async function startInstaller({ file, directory, appRoot, executable, resultFile, packageSha256, servicePort = 7690, onStatus = () => {}, onReadyToQuit = () => {}, platform = process.platform, spawnImpl = spawn }) {
  if (!/^[a-f0-9]{64}$/.test(packageSha256 || "")) throw Error("missing-verified-release-metadata");
  const script = platform === "win32" ? "update-windows.ps1" : platform === "darwin" ? "update-macos.sh" : "update-linux.sh";
  const copied = path.join(directory, script);
  await fs.copyFile(path.join(__dirname, script), copied);
  const common = [file, appRoot, executable, String(process.pid), resultFile, String(servicePort), packageSha256];
  let command, args;
  if (platform === "win32") { command = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"); args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", copied, ...common]; }
  else if (platform === "darwin") { command = "/bin/bash"; args = [copied, ...common]; }
  else if (platform === "linux") { command = "/usr/bin/pkexec"; args = ["/bin/bash", "/opt/agentoc/Desktop/resources/app/update-linux.sh", ...common]; }
  else throw Error("unsupported-platform");
  const child = spawnImpl(command, args, { detached: platform !== "linux", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.resume();
  let ready = false, buffer = "";
  child.stdout.setEncoding("utf8"); child.stdout.on("data", text => { buffer += text; const lines = buffer.split(/\r?\n/); buffer = lines.pop(); for (const line of lines) {
    if (line === "RAGENT_WAITING") onStatus("waiting");
    if (line === "RAGENT_INSTALLING") onStatus("installing");
    if (line === "RAGENT_READY") { ready = true; onStatus("installing"); onReadyToQuit(); }
  }});
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => { if (platform !== "linux" && ready) return resolve({ handedOff: true }); if (code === 0) resolve({ installed: true }); else reject(Error(code === 126 || code === 127 ? "authorization-cancelled" : "installation-failed")); });
  });
}
module.exports = { downloadPackage, startInstaller, clearCachedPackage, MAX_BYTES };
