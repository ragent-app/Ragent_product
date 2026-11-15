#!/usr/bin/env node
// DS-16: cold-body compression in history.mjs.
//
// Bodies at or above COLD_BODY_COMPRESS_MIN_BYTES are stored gzip/zstd with a
// sidecar meta (codec, originalBytes, sha256); readBody decompresses
// transparently and verifies the hash. Covers: unified limit tables, small
// bodies stay plain, large bodies compress (CJK/emoji byte-exact), zstd codec
// via child process, mixed plain+compressed sessions, corruption detection
// (tampered payload, mismatched meta hash), binary misdetection (a plain
// body that starts with the gzip magic must read as text), legacy plain-only
// sessions, and the endpoint payload (readEventBody) preserving original byte
// length. Cold-file paths (decompression, corruption) run in child processes
// so the body cache is empty.
import assert from 'assert/strict';
import { spawn } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { readFile, readdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

const home = mkdtempSync(join(tmpdir(), 'ragent-body-compress-'));
process.env.HOME = home;
process.env.RAGENT_CONFIG_DIR = join(home, '.config', 'ragent');
process.env.RAGENT_MEMORY_DIR = join(home, 'memory');
process.env.RAGENT_WORK_ROOT_DIR = join(home, 'workspace');
process.env.RAGENT_INSTANCE_ROOT = home;

const history = await import('../chat/history.mjs');
const { createSession } = await import('../chat/session-manager.mjs');

const BIG = '大正文·测试🎯'.repeat(12000); // 72000 chars ≈ 180KB — well over the 4KB threshold
const SMALL = 'plain small body 消息';
const GZIP_MAGIC_TEXT = 'plain text that begins with gzip magic';

function bodiesDir(sessionId) {
  return join(process.env.RAGENT_CONFIG_DIR, 'chat-history', sessionId, 'bodies');
}

async function makeSession() {
  const session = await createSession('~', 'fake', 'body-compress-test', {});
  return session.id;
}

// Run a short child process that imports history.mjs fresh (empty caches)
// and prints JSON. Args: { sid, seq }.
function coldReadChild(sid, seq) {
  return new Promise((resolve, reject) => {
    const code = `
      import { readEventBody, loadHistory } from ${JSON.stringify(pathToFileURL(join(repoRoot, 'chat/history.mjs')).href)};
      const body = await readEventBody(process.argv[1], Number(process.argv[2]));
      const full = await loadHistory(process.argv[1], { includeBodies: true });
      const latest = [...full].pop();
      process.stdout.write(JSON.stringify({ body, latestContent: latest?.content ?? null }));
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, sid, String(seq)], {
      env: {
        ...process.env,
        HOME: home,
        RAGENT_CONFIG_DIR: process.env.RAGENT_CONFIG_DIR,
        RAGENT_MEMORY_DIR: process.env.RAGENT_MEMORY_DIR,
        RAGENT_WORK_ROOT_DIR: process.env.RAGENT_WORK_ROOT_DIR,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`child failed (${code}): ${err.slice(0, 400)}`));
      else resolve(JSON.parse(out));
    });
  });
}

try {
  // --- 1. unified limit tables are complete for every body-bearing type ---
  {
    const inline = history.__bodyInlineLimitsForTest();
    const preview = history.__bodyPreviewLimitsForTest();
    const alwaysExternal = history.__bodyAlwaysExternalForTest();
    for (const type of ['message', 'reasoning', 'template_context', 'tool_use', 'tool_result']) {
      assert.ok(Number.isInteger(inline[type]), `inline limit for ${type}`);
      assert.ok(Number.isInteger(preview[type]), `preview limit for ${type}`);
    }
    assert.ok(inline.status >= 0);
    assert.ok(preview.status >= 0);
    assert.deepEqual([...alwaysExternal], ['reasoning'], 'reasoning is always externalized');
    assert.ok(inline.reasoning === 0, 'reasoning inline limit is 0 (never inline)');
  }

  // --- 2. small bodies stay plain ---
  {
    // tool_use has a 2048-char inline limit, so a ~3KB toolInput is
    // externalized but stays under the 4KB compress threshold → plain .txt.
    const sid = await makeSession();
    const toolInput = SMALL + 'x'.repeat(3000);
    await history.appendEvent(sid, { id: 's1', type: 'tool_use', toolInput });
    const files = await readdir(bodiesDir(sid));
    assert.deepEqual(files, ['evt_000000001_toolInput.txt'], 'small body stored plain');
    const stored = await readFile(join(bodiesDir(sid), 'evt_000000001_toolInput.txt'), 'utf8');
    assert.equal(stored, toolInput);
    const full = await history.loadHistory(sid, { includeBodies: true });
    assert.equal(full[0].toolInput, toolInput);
  }

  // --- 3. large bodies compress (gzip) with meta + byte-exact hydration ---
  {
    const sid = await makeSession();
    await history.appendEvent(sid, { id: 'b1', type: 'message', role: 'user', content: BIG });
    const files = await readdir(bodiesDir(sid));
    assert.deepEqual(files.sort(), ['evt_000000001_content.txt.gz', 'evt_000000001_content.txt.meta.json']);

    const meta = JSON.parse(readFileSync(join(bodiesDir(sid), 'evt_000000001_content.txt.meta.json'), 'utf8'));
    assert.equal(meta.codec, 'gzip');
    assert.equal(meta.originalBytes, Buffer.byteLength(BIG, 'utf8'), 'original byte length preserved (CJK/emoji: bytes ≠ chars)');
    const compressedBytes = readFileSync(join(bodiesDir(sid), 'evt_000000001_content.txt.gz')).length;
    assert.equal(meta.compressedBytes, compressedBytes);
    assert.ok(meta.compressedBytes < meta.originalBytes, 'compression actually shrank the body');
    assert.match(meta.sha256, /^[0-9a-f]{64}$/);

    const idx = await history.loadHistory(sid, { includeBodies: false });
    assert.equal(idx[0].bodyRef, 'evt_000000001_content');
    assert.equal(idx[0].bodyBytes, Buffer.byteLength(BIG, 'utf8'), 'index bodyBytes = original byte length');
    assert.equal(idx[0].bodyAvailable, true);
    assert.equal(idx[0].bodyLoaded, false);

    const full = await history.loadHistory(sid, { includeBodies: true });
    assert.equal(full[0].content, BIG, 'hydrated content byte-exact');

    const viaEndpoint = await history.readEventBody(sid, 1);
    assert.equal(viaEndpoint.value, BIG);
    assert.equal(viaEndpoint.bytes, Buffer.byteLength(BIG, 'utf8'));
  }

  // --- 4. zstd codec via child process (env read at import) ---
  {
    const sid = await makeSession();
    const result = await new Promise((resolve, reject) => {
      const code = `
        import { appendEvent } from ${JSON.stringify(pathToFileURL(join(repoRoot, 'chat/history.mjs')).href)};
        const big = 'zstd 正文·🎯'.repeat(12000);
        await appendEvent(process.argv[1], { id: 'z1', type: 'message', role: 'user', content: big });
        process.stdout.write(JSON.stringify({ len: big.length }));
      `;
      const child = spawn(process.execPath, ['--input-type=module', '-e', code, sid], {
        env: { ...process.env, HOME: home, RAGENT_CONFIG_DIR: process.env.RAGENT_CONFIG_DIR, RAGENT_MEMORY_DIR: process.env.RAGENT_MEMORY_DIR, RAGENT_WORK_ROOT_DIR: process.env.RAGENT_WORK_ROOT_DIR, RAGENT_BODY_CODEC: 'zstd' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let err = '';
      child.stderr.on('data', (c) => { err += c; });
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`zstd child failed: ${err.slice(0, 300)}`)));
    });
    const files = await readdir(bodiesDir(sid));
    assert.ok(files.includes('evt_000000001_content.txt.zst'), `zstd file expected, got ${files.join(', ')}`);
    const meta = JSON.parse(readFileSync(join(bodiesDir(sid), 'evt_000000001_content.txt.meta.json'), 'utf8'));
    assert.equal(meta.codec, 'zstd');
    // Cold read back in a fresh child — transparent zstd decompression.
    const cold = await coldReadChild(sid, 1);
    assert.equal(cold.body.value.startsWith('zstd 正文'), true);
    assert.equal(cold.body.bytes, meta.originalBytes);
    assert.equal(cold.latestContent.startsWith('zstd 正文'), true);
  }

  // --- 5. mixed session: plain + compressed bodies coexist ---
  {
    const sid = await makeSession();
    await history.appendEvent(sid, { id: 'm1', type: 'status', content: 'small status' });
    await history.appendEvent(sid, { id: 'm2', type: 'message', role: 'user', content: BIG });
    const full = await history.loadHistory(sid, { includeBodies: true });
    assert.equal(full[0].content, 'small status', 'status event kept inline');
    assert.equal(full[1].content, BIG, 'message event hydrated from gz');
  }

  // --- 6. corruption: tampered payload and mismatched meta hash ---
  {
    const sid = await makeSession();
    await history.appendEvent(sid, { id: 'c1', type: 'message', role: 'user', content: BIG });
    const gzPath = join(bodiesDir(sid), 'evt_000000001_content.txt.gz');
    const bytes = readFileSync(gzPath);
    bytes[bytes.length - 1] = bytes[bytes.length - 1] ^ 0xff;
    await writeFile(gzPath, bytes);
    const cold = await coldReadChild(sid, 1);
    assert.equal(cold.body, null, 'corrupt gzip body reads as absent');
    assert.equal(cold.latestContent, '', 'hydrate yields empty for corrupt body');

    // Break the meta hash on a separate session: payload decompresses fine,
    // but the sha256 no longer matches.
    const sid2 = await makeSession();
    await history.appendEvent(sid2, { id: 'c2', type: 'message', role: 'user', content: BIG });
    const metaPath = join(bodiesDir(sid2), 'evt_000000001_content.txt.meta.json');
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    meta.sha256 = '0'.repeat(64);
    writeFileSync(metaPath, JSON.stringify(meta));
    const cold2 = await coldReadChild(sid2, 1);
    assert.equal(cold2.body, null, 'sha256 mismatch reads as absent');
  }

  // --- 7. binary misdetection: plain body starting with gzip magic ---
  {
    // A ~3KB tool_use toolInput whose bytes start with the gzip magic
    // (0x1f 0x8b). Resolution is extension-based — it must read as text.
    const magicPrefix = Buffer.from([0x1f, 0x8b]).toString('latin1');
    const magicText = magicPrefix + 'looks-like-gzip-but-is-text'.repeat(100);
    const sid = await makeSession();
    await history.appendEvent(sid, { id: 'g1', type: 'tool_use', toolInput: magicText });
    const files = await readdir(bodiesDir(sid));
    assert.deepEqual(files, ['evt_000000001_toolInput.txt'], 'magic-prefixed body stays plain (extension-based, never sniffed)');
    const full = await history.loadHistory(sid, { includeBodies: true });
    assert.equal(full[0].toolInput, magicText, 'magic-prefixed text reads as text');
  }

  // --- 8. legacy plain-only sessions read unchanged (pre-compression .txt,
  //        no meta — even when today's writer would have compressed) ---
  {
    const sid = await makeSession();
    const legacy = 'legacy plain body 老格式'.repeat(800); // > 4KB → would compress today
    await history.appendEvent(sid, { id: 'l1', type: 'tool_use', toolInput: legacy });
    // Overwrite with a plain file and no meta, simulating a pre-DS-16 body.
    writeFileSync(join(bodiesDir(sid), 'evt_000000001_toolInput.txt'), legacy);
    const cold = await coldReadChild(sid, 1);
    assert.equal(cold.body.value, legacy, 'legacy plain body reads unchanged');
  }

  console.log('history body compression: all sections passed');
} finally {
  rmSync(home, { recursive: true, force: true });
}
