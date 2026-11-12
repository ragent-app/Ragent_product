// Generate the release-note marker from the finished artifact, not a staged
// input. This metadata is useful only after the release owner also verifies
// the uploaded asset digest and the candidate's release gates.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, unlink } from 'node:fs/promises';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function createReleaseBuildinfo(artifact, version, commit) {
  const name = basename(artifact);
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
      || !version.split('.').every((part) => Number.isSafeInteger(Number(part)))
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)
      || ![`ragent_${version}_amd64.deb`, `ragent_${version}-darwin-arm64.dmg`,
        `Ragent-${version}-ubuntu24.04-x86_64.deb`, `Ragent-${version}-macos13plus-arm64.dmg`].includes(name)) {
    throw new Error('Invalid release version, commit or supported artifact name');
  }
  const input = await open(artifact, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let digest;
  try {
    const before = await input.stat();
    if (!before.isFile() || before.size < 1) throw new Error('Artifact is not a nonempty regular file');
    const hash = createHash('sha256');
    for await (const chunk of input.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await input.stat();
    const pathAfter = await lstat(artifact);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
        || !pathAfter.isFile() || pathAfter.isSymbolicLink() || after.dev !== pathAfter.dev
        || after.ino !== pathAfter.ino || after.size !== pathAfter.size
        || after.mtimeMs !== pathAfter.mtimeMs || after.ctimeMs !== pathAfter.ctimeMs) {
      throw new Error('Artifact changed while calculating its digest');
    }
    digest = hash.digest('hex');
  } finally { await input.close(); }
  const marker = `<!-- ragent-asset-build:${name}:${version}:${commit}:sha256:${digest} -->\n`;
  const output = `${artifact}.BUILDINFO.txt`;
  let file;
  try {
    file = await open(output, 'wx', 0o644);
    await file.writeFile(marker, 'utf8');
    await file.close();
    file = null;
  } catch (error) {
    if (file) { await file.close().catch(() => {}); await unlink(output).catch(() => {}); }
    throw error;
  }
  return { output, digest, marker: marker.trim() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 5) throw new Error('Usage: create-release-buildinfo.mjs ARTIFACT VERSION COMMIT');
    const result = await createReleaseBuildinfo(...process.argv.slice(2));
    console.log(result.output);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
