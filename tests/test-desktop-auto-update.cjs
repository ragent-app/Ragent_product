"use strict";
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { PassThrough } = require("node:stream");
const { EventEmitter } = require("node:events");
const { downloadPackage, startInstaller, clearCachedPackage } = require("../desktop/auto-update.cjs");

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ragent-auto-test-"));
  const data = Buffer.from("verified release bytes");
  const info = { downloadUrl: "https://github.com/ragent-app/Ragent_product/releases/download/v0.0.1/Ragent-0.0.1-ubuntu24.04-x86_64.deb", packageSha256: createHash("sha256").update(data).digest("hex"), packageSize: data.length };
  const options = { tempRoot: root, platform: "linux", arch: "x64" };
  const response = (body) => ({ ok: true, status: 200, body: Readable.from([body]), headers: new Headers() });
  try {
    const progress = [];
    const file = await downloadPackage(info, { ...options, onProgress: (...p) => progress.push(p), fetchImpl: async () => response(data) });
    assert.deepEqual(await fs.readFile(file.file), data);
    assert.deepEqual(progress.at(-1), [data.length, data.length]);
    const reused = await downloadPackage(info, { ...options, fetchImpl: async () => { throw Error("unexpected download"); } });
    assert.equal(reused.file, file.file);
    assert.equal(reused.reused, true);
    await fs.writeFile(file.file, Buffer.from("damaged"));
    let downloads = 0;
    const repaired = await downloadPackage(info, { ...options, fetchImpl: async () => { downloads++; return response(data); } });
    assert.equal(downloads, 1);
    assert.equal(repaired.reused, false);
    assert.deepEqual(await fs.readFile(repaired.file), data);
    const nextData = Buffer.from("newer release bytes");
    const nextInfo = { ...info, packageSha256: createHash("sha256").update(nextData).digest("hex"), packageSize: nextData.length };
    const next = await downloadPackage(nextInfo, { ...options, fetchImpl: async () => response(nextData) });
    assert.notEqual(next.file, repaired.file);
    assert.equal(next.reused, false);
    assert.deepEqual(await fs.readFile(next.file), nextData);
    await assert.rejects(downloadPackage({ ...info, packageSha256: "0".repeat(64) }, { ...options, fetchImpl: async () => response(data) }), /checksum/);
    await assert.rejects(downloadPackage({ ...info, packageSha256: "1".repeat(64) }, { ...options, fetchImpl: async () => ({ status: 302, headers: new Headers({ location: "https://evil.example/file" }) }) }), /unsafe-download/);
    await assert.rejects(downloadPackage({ ...info, packageSha256: "" }, options), /metadata/);
    for (const platform of ["win32", "darwin", "linux"]) {
      const statuses = []; let quit = false, command, args;
      const mockSpawn = (c, a) => {
        command = c; args = a;
        const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
        process.nextTick(() => { child.stdout.write(platform === "linux" ? "RAGENT_WAITING\nRAGENT_INSTALLING\n" : "RAGENT_READY\n"); child.emit("exit", 0); });
        return child;
      };
      const result = await startInstaller({ ...file, platform, appRoot: root, executable: "app", resultFile: path.join(root, "result"), packageSha256: info.packageSha256,
        onStatus: status => statuses.push(status), onReadyToQuit: () => { quit = true; }, spawnImpl: mockSpawn });
      if (platform === "linux") { assert.equal(command, "/usr/bin/pkexec"); assert.equal(args[1], "/opt/agentoc/Desktop/resources/app/update-linux.sh"); assert.equal(result.installed, true); assert.deepEqual(statuses, ["waiting", "installing"]); }
      else { assert.equal(quit, true); assert.equal(result.handedOff, true); assert.deepEqual(statuses, ["installing"]); }
    }
    await clearCachedPackage(path.join(root, "ragent-update-cache"), info.packageSha256, "linux", "x64");
    await assert.rejects(fs.access(file.file), { code: "ENOENT" });
    await clearCachedPackage(path.join(root, "ragent-update-cache"), nextInfo.packageSha256, "linux", "x64");
    console.log("Desktop updater checks the selected asset, redirects, size and digest");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
