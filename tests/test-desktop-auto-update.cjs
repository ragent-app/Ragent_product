"use strict";
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { PassThrough } = require("node:stream");
const { EventEmitter } = require("node:events");
const { downloadPackage, startInstaller } = require("../desktop/auto-update.cjs");

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
    await assert.rejects(downloadPackage({ ...info, packageSha256: "0".repeat(64) }, { ...options, fetchImpl: async () => response(data) }), /checksum/);
    await assert.rejects(downloadPackage(info, { ...options, fetchImpl: async () => ({ status: 302, headers: new Headers({ location: "https://evil.example/file" }) }) }), /unsafe-download/);
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
    console.log("Desktop updater checks the selected asset, redirects, size and digest");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
