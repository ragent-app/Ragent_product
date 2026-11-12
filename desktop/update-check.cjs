"use strict";

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
  const matches = [...body.matchAll(/<!--\s*agentoc-build:(\d+\.\d+\.\d+):([a-f0-9]{40}|[a-f0-9]{64}):sha256:([a-f0-9]{64})\s*-->/g)];
  if (matches.length !== 1 || asset?.digest !== `sha256:${matches[0][3]}`) return null;
  const match = matches[0];
  const build = match && version(match[1]);
  return build ? { build, commit: match[2] } : null;
}
function assetVersion(asset) {
  const match = /^(?:Ragent-|AgentoC-|ragent_|agentoc_)([0-9]+(?:\.[0-9]+){2,3})(?=[-_])/i.exec(String(asset?.name || ""));
  return match ? version(match[1]) : null;
}
function releaseAsset(asset, platform = process.platform, arch = process.arch) {
  if (!asset || typeof asset.name !== "string") return false;
  const patterns = {
    "win32-x64": /^(?:Ragent-[0-9]+(?:\.[0-9]+){2,3}-windows-x64-setup\.exe|(?:Ragent|AgentoC)-[0-9]+(?:\.[0-9]+){2,3}-windows-x64\.msi)$/i,
    "linux-x64": /^(?:Ragent-[0-9]+(?:\.[0-9]+){2,3}-linux-x64|(?:ragent|agentoc)_[0-9]+(?:\.[0-9]+){2,3}_amd64)\.deb$/i,
    "darwin-arm64": /^(?:Ragent-[0-9]+(?:\.[0-9]+){2,3}-macos-arm64|(?:ragent|agentoc)_[0-9]+(?:\.[0-9]+){2,3}-darwin-arm64)\.dmg$/i,
  };
  const pattern = patterns[`${platform}-${arch}`];
  if (!pattern || !pattern.test(asset.name)) return false;
  try {
    const url = new URL(asset.browser_download_url);
    const suffix = url.pathname.slice(DOWNLOAD_PREFIX.length).split("/");
    return url.protocol === "https:" && url.hostname === "github.com" && !url.port && !url.username && !url.password && !url.search && !url.hash && url.pathname.startsWith(DOWNLOAD_PREFIX) && suffix.length === 2 && !!suffix[0] && suffix[1] === encodeURIComponent(asset.name);
  } catch { return false; }
}
function releaseAssetUrl(value, platform = process.platform, arch = process.arch) {
  try {
    const url = new URL(value);
    return releaseAsset({ name: decodeURIComponent(url.pathname.split("/").pop()), browser_download_url: value }, platform, arch);
  } catch { return false; }
}
const windowsAsset = (asset) => releaseAsset(asset, "win32", "x64");
const windowsAssetUrl = (value) => releaseAssetUrl(value, "win32", "x64");

async function check(currentVersion, fetchImpl = fetch, { currentCommit = "", currentBuild = "", platform = process.platform, arch = process.arch } = {}) {
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
        return candidateVersion && compare(parsed, candidateVersion) === 0 && releaseAsset(candidate, platform, arch);
      });
      if (parsed && asset && (!newest || compare(parsed, newest.parsed) > 0)) newest = { parsed, tag: release.tag_name, url: asset.browser_download_url, buildInfo: releaseBuildInfo(release, asset, { allowLegacy: platform === "win32" }) };
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
    downloadUrl: newest.url, ...(buildChanged ? { buildChanged: true } : {}),
    ...(buildIdentityUnavailable ? { buildIdentityUnavailable: true } : {}) };
}
module.exports = { check, version, compare, windowsAsset, windowsAssetUrl, releaseAsset, releaseAssetUrl, sourceCommit, releaseBuildInfo };
