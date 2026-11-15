import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const executable = process.env.RAGENT_TEST_SAFE_DELETE_BINARY;
if (process.platform !== 'win32' || !executable) { console.log('windows-safe-delete-cli: skipped (opt-in Windows fixture)'); process.exit(0); }
assert.ok(path.isAbsolute(executable));
const root = await mkdtemp(path.join(os.tmpdir(), 'ragent-safe-delete-cli-'));
const build = path.join(root, 'build');
await mkdir(build);
await writeFile(path.join(build, 'fixture.txt'), 'fixture');
const base = { schemaVersion: 1, workspace: root, relative: 'build', contentsOnly: false, force: false, requestKey: `gate:${'a'.repeat(64)}` };
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const exec = promisify(execFile);
await assert.rejects(exec(executable, ['--request', encode({ ...base, relative: '..\\outside' })], { windowsHide: true }), error => error.code === 1);
assert.equal(await readFile(path.join(build, 'fixture.txt'), 'utf8'), 'fixture');
const { stdout } = await exec(executable, ['--request', encode(base)], { windowsHide: true });
assert.deepEqual(JSON.parse(stdout), { ok: true, deleted: 2 });
await assert.rejects(readFile(path.join(build, 'fixture.txt')), { code: 'ENOENT' });
await mkdir(build);
await writeFile(path.join(build, 'keep.txt'), 'keep');
const alternate = path.join(root, 'alternate');
await mkdir(path.join(alternate, 'build'), { recursive: true });
await writeFile(path.join(alternate, 'build', 'target.txt'), 'target');
const cwdRequest = { schemaVersion: 1, workspace: root, target: 'build', targetFromCwd: true, contentsOnly: false, force: false, requestKey: base.requestKey };
const result = await exec(executable, ['--request', encode(cwdRequest)], { cwd: alternate, windowsHide: true });
assert.deepEqual(JSON.parse(result.stdout), { ok: true, deleted: 2 });
assert.equal(await readFile(path.join(build, 'keep.txt'), 'utf8'), 'keep');
const outside = await mkdtemp(path.join(os.tmpdir(), 'ragent-delete-outside-'));
await mkdir(path.join(outside, 'build'));
await writeFile(path.join(outside, 'build', 'keep.txt'), 'outside');
await assert.rejects(exec(executable, ['--request', encode(cwdRequest)], { cwd: outside, windowsHide: true }), error => error.code === 1);
assert.equal(await readFile(path.join(outside, 'build', 'keep.txt'), 'utf8'), 'outside');
// Windows user and project directories commonly contain non-ASCII text and
// spaces. Exercise the real native helper with both in the workspace and the
// target, and verify that a sibling file survives the handle-bound deletion.
const unicodeWorkspace = path.join(root, '用户 workspace');
const unicodeTarget = path.join(unicodeWorkspace, '构建 输出');
await mkdir(path.join(unicodeTarget, '子目录'), { recursive: true });
await writeFile(path.join(unicodeTarget, '子目录', '结果 文档.txt'), 'fixture');
await writeFile(path.join(unicodeWorkspace, '保留.txt'), 'keep');
const unicodeRequest = { ...base, workspace: unicodeWorkspace, relative: '构建 输出' };
const unicodeResult = await exec(executable, ['--request', encode(unicodeRequest)], { windowsHide: true });
assert.deepEqual(JSON.parse(unicodeResult.stdout), { ok: true, deleted: 3 });
await assert.rejects(readFile(path.join(unicodeTarget, '子目录', '结果 文档.txt')), { code: 'ENOENT' });
assert.equal(await readFile(path.join(unicodeWorkspace, '保留.txt'), 'utf8'), 'keep');
await unlink(path.join(unicodeWorkspace, '保留.txt'));
await rmdir(unicodeWorkspace);
await unlink(path.join(outside, 'build', 'keep.txt'));
await rmdir(path.join(outside, 'build'));
await rmdir(outside);
await unlink(path.join(build, 'keep.txt'));
await rmdir(build);
await rmdir(alternate);
await rmdir(root);
console.log('windows-safe-delete-cli: native executable deleted only its pinned fixture');
