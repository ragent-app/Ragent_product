"use strict";

const fs = require("node:fs");
function linuxTarget(arch = process.arch) {
  try {
    const values = {};
    for (const line of fs.readFileSync("/etc/os-release", "utf8").split(/\r?\n/)) {
      const match = /^(ID|VERSION_ID)=(?:"([^"]*)"|([^\s]*))$/.exec(line);
      if (match) values[match[1]] = match[2] ?? match[3];
    }
    if (((values.ID === "ubuntu" && ["22.04", "24.04", "26.04"].includes(values.VERSION_ID)) ||
        (values.ID === "debian" && ["12", "13"].includes(values.VERSION_ID))) && ["x64", "arm64"].includes(arch)) return `${values.ID}:${values.VERSION_ID}`;
    if (values.ID === "rhel" && /^9(?:\.\d+)?$/.test(values.VERSION_ID || "") && arch === "x64") return `${values.ID}:9`;
  } catch {}
  return null;
}

const API = "https://api.github.com/repos/ragent-app/Ragent_product/releases?per_page=100";
const DOWNLOAD_PREFIX = "/ragent-app/Ragent_product/releases/download/";
function version(value) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/.exec(String(value).trim());
  if (!match) return null;
  const parts = match.slice(1).map((part) => Number(part || 0));
  return parts.every(Number.isSafeInteger) ? parts : null;
}
function compare(a, b) {
  for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}
function sourceCommit(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(normalized) ? normalized : "";
}
function releaseBuildInfo(release, asset, { allowLegacy = true } = {}) {
  const body = String(release?.body || "");
  const named = [...body.matchAll(/<!--\s*ragent-asset-build:([A-Za-z0-9._-]+):(\d+\.\d+\.\d+):([a-f0-9]{40}|[a-f0-9]{64}):sha256:([a-f0-9]{64})\s*-->/g)]
    .filter((match) => match[1] === asset?.name);
  if (named.length) {
    if (named.length !== 1 || asset?.digest !== `sha256:${named[0][4]}`) return null;
    const build = version(named[0][2]);
    return build ? { build, commit: named[0][3] } : null;
  }
  if (!allowLegacy) return null;
  const matches = [...body.matchAll(/<!--\s*ragent-build:(\d+\.\d+\.\d+):([a-f0-9]{40}|[a-f0-9]{64}):sha256:([a-f0-9]{64})\s*-->/g)];
  if (matches.length !== 1 || asset?.digest !== `sha256:${matches[0][3]}`) return null;
  const match = matches[0];
  const build = match && version(match[1]);
  return build ? { build, commit: match[2] } : null;
}
function assetVersion(asset) {
  const match = /^(?:Ragent-|Ragent-|ragent_|ragent_)([0-9]+(?:\.[0-9]+){2,3})(?=[-_])/i.exec(String(asset?.name || ""));
  return match ? version(match[1]) : null;
}
function releaseAsset(asset, platform = process.platform, arch = process.arch, target = platform === "linux" ? linuxTarget(arch) : null) {
  if (!asset || typeof asset.name !== "string") return false;
  const patterns = {
    "win32-x64": /^(?:Ragent-[0-9]+(?:\.[0-9]+){2,3}-(?:windows-x64|windows11-x86_64)-setup\.exe|(?:Ragent|Ragent)-[0-9]+(?:\.[0-9]+){2,3}-windows-x64\.msi)$/i,
    "linux-x64-debian-family": /^Ragent-[0-9]+(?:\.[0-9]+){2,3}-linux-x86_64\.deb$/i,
    "linux-arm64-debian-family": /^Ragent-[0-9]+(?:\.[0-9]+){2,3}-linux-arm64\.deb$/i,
    "linux-x64-rhel9": /^Ragent-[0-9]+(?:\.[0-9]+){2,3}-rhel9-x86_64\.rpm$/i,
    "darwin-arm64": /^(?:Ragent-[0-9]+(?:\.[0-9]+){2,3}-(?:macos-arm64|macos13plus-arm64)|(?:ragent|ragent)_[0-9]+(?:\.[0-9]+){2,3}-darwin-arm64)\.dmg$/i,
  };
  const family = /^(?:ubuntu:(?:22\.04|24\.04|26\.04)|debian:(?:12|13))$/.test(target || "") ? "debian-family" : target === "rhel:9" ? "rhel9" : "";
  const pattern = patterns[`${platform}-${arch}${platform === "linux" ? `-${family}` : ""}`];
  if (!pattern || !pattern.test(asset.name)) return false;
  try {
    const url = new URL(asset.browser_download_url);
    const suffix = url.pathname.slice(DOWNLOAD_PREFIX.length).split("/");
    return url.protocol === "https:" && url.hostname === "github.com" && !url.port && !url.username && !url.password && !url.search && !url.hash && url.pathname.startsWith(DOWNLOAD_PREFIX) && suffix.length === 2 && !!suffix[0] && suffix[1] === encodeURIComponent(asset.name);
  } catch { return false; }
}
function releaseAssetUrl(value, platform = process.platform, arch = process.arch, target = platform === "linux" ? linuxTarget(arch) : null) {
  try {
    const url = new URL(value);
    return releaseAsset({ name: decodeURIComponent(url.pathname.split("/").pop()), browser_download_url: value }, platform, arch, target);
  } catch { return false; }
}
const windowsAsset = (asset) => releaseAsset(asset, "win32", "x64");
const windowsAssetUrl = (value) => releaseAssetUrl(value, "win32", "x64");

async function check(currentVersion, fetchImpl = fetch, { currentCommit = "", currentBuild = "", platform = process.platform, arch = process.arch, target = platform === "linux" ? linuxTarget(arch) : null } = {}) {
  const installed = version(currentVersion);
  if (!installed) throw new Error("invalid-current-version");
  let newest = null;
  for (let page = 1; page <= 10; page++) {
    const response = await fetchImpl(`${API}&page=${page}`, { headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error("release-fetch-failed");
    const releases = await response.json();
    if (!Array.isArray(releases)) throw new Error("invalid-release-response");
    for (const release of releases) {
      if (!release || release.draft || release.prerelease) continue;
      const parsed = version(release.tag_name);
      const asset = parsed && Array.isArray(release.assets) && release.assets.find((candidate) => {
        const candidateVersion = assetVersion(candidate);
        return candidateVersion && compare(parsed, candidateVersion) === 0 && releaseAsset(candidate, platform, arch, target)
          && (platform !== "linux" || (/^sha256:[a-f0-9]{64}$/.test(candidate.digest || "") && String(release.body || "").includes(`<!-- ragent-linux-validated:${candidate.name}:${target}:${arch}:${candidate.digest} -->`)));
      });
      if (parsed && asset && (!newest || compare(parsed, newest.parsed) > 0)) newest = { parsed, tag: release.tag_name, url: asset.browser_download_url, asset, buildInfo: releaseBuildInfo(release, asset, { allowLegacy: platform === "win32" }) };
    }
    if (releases.length < 100) break;
    if (page === 10) throw new Error("release-list-too-long");
  }
  if (!newest) throw new Error(platform === "win32" ? "no-windows-release" : "no-platform-release");
  const versionOrder = compare(newest.parsed, installed);
  const installedCommit = sourceCommit(currentCommit);
  const installedBuild = version(currentBuild);
  const buildOrder = installedBuild && newest.buildInfo ? compare(newest.buildInfo.build, installedBuild) : null;
  // Release assets can be replaced while the public version stays 0.0.1.
  // Prefer the internal MSI version for ordering; legacy installs can still
  // report a different source identity without claiming which one is newer.
  const buildChanged = versionOrder === 0 && (buildOrder !== null
    ? buildOrder > 0 || (buildOrder === 0 && Boolean(installedCommit && installedCommit !== newest.buildInfo.commit))
    : Boolean(installedCommit && newest.buildInfo && installedCommit !== newest.buildInfo.commit));
  const buildIdentityUnavailable = versionOrder === 0 && (!newest.buildInfo ||
    ((buildOrder === null || buildOrder === 0) && !installedCommit));
  return { currentVersion, latestVersion: newest.tag, updateAvailable: versionOrder > 0 || buildChanged,
    downloadUrl: newest.url, ...(newest.buildInfo ? { packageSha256: newest.asset.digest.slice(7), packageSize: newest.asset.size || null } : {}), ...(buildChanged ? { buildChanged: true } : {}),
    ...(buildIdentityUnavailable ? { buildIdentityUnavailable: true } : {}) };
}
module.exports = { check, version, compare, windowsAsset, windowsAssetUrl, releaseAsset, releaseAssetUrl, sourceCommit, releaseBuildInfo, linuxTarget };
