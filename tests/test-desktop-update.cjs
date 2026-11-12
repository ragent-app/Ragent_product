"use strict";
const assert = require("node:assert/strict");
const { check: checkPlatform, version, compare, windowsAsset, windowsAssetUrl, releaseAsset, releaseAssetUrl } = require("../desktop/update-check.cjs");
const check = (version, fetcher, options = {}) => checkPlatform(version, fetcher, { platform: "win32", arch: "x64", ...options });
const url = "https://github.com/ragent-app/Ragent_product/releases/download/v1.2.3/Ragent-1.2.3-windows-x64-setup.exe";
const asset = { name: "Ragent-1.2.3-windows-x64-setup.exe", browser_download_url: url };
(async () => {
  assert.deepEqual(version("v1.2.3"), [1, 2, 3, 0]);
  assert.equal(compare(version("1.2.3.1"), version("v1.2.3")), 1);
  assert.equal(version("1.2.3-beta"), null);
  assert.equal(version("1.2.3.9007199254740992"), null);
  assert(windowsAsset(asset));
  assert(windowsAssetUrl(url));
  assert(!windowsAsset({ ...asset, name: "Ragent-1.2.3-windows-x64.msi" }));
  assert(!windowsAssetUrl(url + "?redirect=evil"));
  assert(!windowsAssetUrl(url.replace("ragent-app/Ragent_product", "ragent-app/other")));
  assert(!windowsAssetUrl(url.replace("setup.exe", "payload.exe")));
  assert(!windowsAsset({ ...asset, browser_download_url: "https://evil.example/releases/download/x" }));
  assert(!windowsAsset({ ...asset, name: "agentoc-arm64.msi" }));
  for (const [platform, arch, name] of [
    ["linux", "x64", "Ragent-1.2.3-linux-x64.deb"],
    ["linux", "x64", "ragent_1.2.3_amd64.deb"],
    ["linux", "x64", "agentoc_1.2.3_amd64.deb"],
    ["darwin", "arm64", "Ragent-1.2.3-macos-arm64.dmg"],
    ["darwin", "arm64", "ragent_1.2.3-darwin-arm64.dmg"],
    ["darwin", "arm64", "agentoc_1.2.3-darwin-arm64.dmg"],
  ]) {
    const platformUrl = `https://github.com/ragent-app/Ragent_product/releases/download/v1.2.3/${name}`;
    const platformAsset = { name, browser_download_url: platformUrl };
    assert(releaseAsset(platformAsset, platform, arch));
    assert(releaseAssetUrl(platformUrl, platform, arch));
    assert(!releaseAssetUrl(platformUrl + "?redirect=evil", platform, arch));
    assert(!releaseAsset(platformAsset, platform, "unsupported"));
    assert(!releaseAsset(asset, platform, arch));
    const platformFetch = async () => ({ ok: true, json: async () => [{ tag_name: "v1.2.3", assets: [asset, platformAsset] }] });
    const result = await checkPlatform("1.2.2", platformFetch, { platform, arch });
    assert.equal(result.downloadUrl, platformUrl);
    assert.equal(result.updateAvailable, true);
    const digest = "c".repeat(64), commit = "b".repeat(40), oldCommit = "a".repeat(40);
    const marker = `<!-- ragent-asset-build:${name}:1.2.3:${commit}:sha256:${digest} -->`;
    const labeled = async () => ({ ok: true, json: async () => [{ tag_name: "v1.2.3", body: marker,
      assets: [{ ...platformAsset, digest: `sha256:${digest}` }] }] });
    assert.equal((await checkPlatform("1.2.3", labeled, { platform, arch, currentCommit: oldCommit })).buildChanged, true);
    assert.equal((await checkPlatform("1.2.3", labeled, { platform, arch, currentCommit: commit })).updateAvailable, false);
    const wrongDigest = async () => ({ ok: true, json: async () => [{ tag_name: "v1.2.3", body: marker,
      assets: [{ ...platformAsset, digest: `sha256:${"d".repeat(64)}` }] }] });
    assert.equal((await checkPlatform("1.2.3", wrongDigest, { platform, arch, currentCommit: oldCommit })).buildIdentityUnavailable, true);
    const duplicate = async () => ({ ok: true, json: async () => [{ tag_name: "v1.2.3", body: marker + marker,
      assets: [{ ...platformAsset, digest: `sha256:${digest}` }] }] });
    assert.equal((await checkPlatform("1.2.3", duplicate, { platform, arch, currentCommit: oldCommit })).buildIdentityUnavailable, true);
    const mismatchedTag = async () => ({ ok: true, json: async () => [{ tag_name: "v1.2.4", assets: [platformAsset] }] });
    await assert.rejects(checkPlatform("1.2.2", mismatchedTag, { platform, arch }), /no-platform-release/);
  }
  const releases = [
    { tag_name: "v9.0.0", prerelease: true, assets: [asset] },
    { tag_name: "v1.2.3", assets: [asset] },
    { tag_name: "v1.2.4", assets: [] },
  ];
  const fetcher = async (request) => { assert.match(request, /^https:\/\/api\.github\.com\/repos\/ragent-app\/Ragent_product\/releases\?/); return { ok: true, json: async () => releases }; };
  assert.deepEqual(await check("1.2.2", fetcher), { currentVersion: "1.2.2", latestVersion: "v1.2.3", updateAvailable: true, downloadUrl: url });
  assert.equal((await check("1.2.3.1", fetcher)).updateAvailable, false);
  const olderCommit = "a".repeat(40), publishedCommit = "b".repeat(40);
  const digest = "c".repeat(64);
  const labeled = async () => ({ ok: true, json: async () => [{ tag_name: "v1.2.3", body: `<!-- agentoc-build:0.0.24:${publishedCommit}:sha256:${digest} -->`, assets: [{ ...asset, digest: `sha256:${digest}` }] }] });
  assert.equal((await check("1.2.3", labeled, { currentCommit: olderCommit })).buildChanged, true);
  assert.equal((await check("1.2.3", labeled, { currentCommit: olderCommit })).updateAvailable, true);
  assert.equal((await check("1.2.3", labeled, { currentCommit: publishedCommit })).updateAvailable, false);
  assert.equal((await check("1.2.3", labeled, { currentCommit: olderCommit, currentBuild: "0.0.23" })).updateAvailable, true);
  assert.equal((await check("1.2.3", labeled, { currentCommit: olderCommit, currentBuild: "0.0.25" })).updateAvailable, false);
  assert.equal((await check("1.2.3", labeled, { currentCommit: publishedCommit, currentBuild: "0.0.23" })).updateAvailable, true);
  assert.equal((await check("1.2.3", labeled, { currentBuild: "0.0.24" })).buildIdentityUnavailable, true);
  assert.equal((await check("1.2.3.1", labeled, { currentCommit: olderCommit })).updateAvailable, false);
  assert.equal((await check("1.2.3", labeled, { currentCommit: "unknown" })).updateAvailable, false);
  assert.equal((await check("1.2.3", labeled, { currentCommit: "unknown" })).buildIdentityUnavailable, true);
  const malformed = async () => ({ ok: true, json: async () => [{ tag_name: "v1.2.3", body: `<!-- agentoc-build:0.0.24:${publishedCommit}:sha256:${digest} -->`, assets: [{ ...asset, digest: `sha256:${"d".repeat(64)}` }] }] });
  assert.equal((await check("1.2.3", malformed, { currentCommit: olderCommit })).updateAvailable, false);
  assert.equal((await check("1.2.3", malformed, { currentCommit: olderCommit })).buildIdentityUnavailable, true);
  const duplicateMarker = async () => ({ ok: true, json: async () => [{ tag_name: "v1.2.3", body: (`<!-- agentoc-build:0.0.24:${publishedCommit}:sha256:${digest} -->`).repeat(2), assets: [{ ...asset, digest: `sha256:${digest}` }] }] });
  assert.equal((await check("1.2.3", duplicateMarker, { currentCommit: olderCommit })).buildIdentityUnavailable, true);
  await assert.rejects(check("unknown", fetcher));
  await assert.rejects(check("1.0.0", async () => ({ ok: false })));
  console.log("desktop update checks passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
