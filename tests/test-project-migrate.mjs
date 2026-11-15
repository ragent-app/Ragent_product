#!/usr/bin/env node
// 项目复制迁移验证：
//  - migrateTargetPath 每项目配置（PATCH 设置/清除）；未配置 = 默认路径不变（跳过）
//  - POST /api/projects/migrate 批量执行：复制 rootPath 内容到目标路径（源保留）、
//    rootPath 更新到目标（id 保留）、清除配置、记 lastMigratedAt
//  - 任一失败（权限不足/同路径/运行中会话）不中断其余，全部执行完后 failed 汇总
import assert from 'assert/strict';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const repoRoot = process.cwd();
const isDirectoryPath = async (path) => stat(path).then((entry) => entry.isDirectory()).catch(() => false);
const tempHome = await mkdtemp(join(tmpdir(), 'ragent-project-migrate-'));
process.env.HOME = tempHome;
process.env.RAGENT_CONFIG_DIR = join(tempHome, 'config');
process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
delete process.env.RAGENT_INSTANCE_ROOT;

const configDir = process.env.RAGENT_CONFIG_DIR;
await mkdir(configDir, { recursive: true });
await writeFile(join(configDir, 'auth.json'), JSON.stringify({
  username: 'testowner',
  passwordHash: 'not-a-real-hash',
}), 'utf8');

const work = join(tempHome, 'work');
await mkdir(join(work, 'srcA', 'sub'), { recursive: true });
await mkdir(join(work, 'srcB'), { recursive: true });
await mkdir(join(work, 'srcC'), { recursive: true });
await writeFile(join(work, 'srcA', 'a.txt'), 'hello');
await writeFile(join(work, 'srcA', 'sub', 'b.txt'), 'nested');
await writeFile(join(work, 'srcB', 'x.txt'), 'b-content');

const tgtA = join(work, 'tgtA');
const tgtB = join(work, 'tgtB');
const tgtB2 = join(work, 'tgtB2');
const tgtC = join(work, 'tgtC');

const {
  createProject,
  getProject,
  listProjects,
  migrateProjectsToTargets,
  updateProject,
} = await import(pathToFileURL(join(repoRoot, 'chat', 'projects.mjs')).href);
const { handleControlRoutes } = await import(pathToFileURL(join(repoRoot, 'chat', 'router-control-routes.mjs')).href);
const { withSessionsMetaMutation } = await import(pathToFileURL(join(repoRoot, 'chat', 'session-meta-store.mjs')).href);
const { CHAT_RUNS_DIR } = await import(pathToFileURL(join(repoRoot, 'lib', 'config.mjs')).href);

let passed = 0;
function check(name, condition, detail = '') {
  assert.ok(condition, `${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`ok - ${name}`);
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    writeHead(statusCode, headers = {}) { this.statusCode = statusCode; this.headers = { ...headers }; },
    end(body = '') { this.body = body; },
  };
}

function writeJson(res, statusCode, value) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

async function exists(p) {
  return import('fs/promises').then((f) => f.access(p).then(() => true, () => false));
}

function makeBodyReq(body, options = {}) {
  const chunk = Buffer.from(JSON.stringify(body));
  const { method = 'POST', extraHeaders = {} } = options;
  return {
    method,
    headers: { host: 'a.ragent.test', ...extraHeaders },
    on(event, handler) {
      if (event === 'data') queueMicrotask(() => handler(chunk));
      if (event === 'end') queueMicrotask(() => handler());
      return this;
    },
    destroy() {},
  };
}

// ---------- 准备：三个项目 ----------

const pA = await createProject({ name: '项目A', rootPath: join(work, 'srcA') });
const pB = await createProject({ name: '项目B', rootPath: join(work, 'srcB') });
const pC = await createProject({ name: '项目C', rootPath: join(work, 'srcC') });

{
  const result = await migrateProjectsToTargets();
  check('未配置 migrateTargetPath → 全部跳过（默认路径不变）',
    result.migrated.length === 0 && result.failed.length === 0);
}

// ---------- 正常迁移（批量两个项目） ----------

const updatedA = await updateProject(pA.id, { migrateTargetPath: tgtA });
const updatedB = await updateProject(pB.id, { migrateTargetPath: tgtB });
check('PATCH 配置 migrateTargetPath（lib 层）',
  updatedA.migrateTargetPath === tgtA && updatedB.migrateTargetPath === tgtB);

{
  const result = await migrateProjectsToTargets();
  check('批量迁移成功 → migrated 2 / failed 0',
    result.migrated.length === 2 && result.failed.length === 0
    && result.migrated.some((m) => m.id === pA.id && m.rootPath === tgtA)
    && result.migrated.some((m) => m.id === pB.id && m.rootPath === tgtB));
}

{
  // 目标路径内容 = 源内容；源目录保留（复制语义）
  const aFile = await import('fs/promises').then((f) => f.readFile(join(tgtA, 'a.txt'), 'utf8'));
  const bFile = await import('fs/promises').then((f) => f.readFile(join(tgtA, 'sub', 'b.txt'), 'utf8'));
  const xFile = await import('fs/promises').then((f) => f.readFile(join(tgtB, 'x.txt'), 'utf8'));
  const srcKept = await import('fs/promises').then((f) => f.readFile(join(work, 'srcA', 'a.txt'), 'utf8'));
  check('目标目录内容完整 + 源目录保留',
    aFile === 'hello' && bFile === 'nested' && xFile === 'b-content' && srcKept === 'hello');
}

{
  const projects = await listProjects();
  const movedA = projects.find((p) => p.id === pA.id);
  const movedB = projects.find((p) => p.id === pB.id);
  const untouchedC = projects.find((p) => p.id === pC.id);
  check('rootPath 更新到目标 + id 保留 + 配置清除 + lastMigratedAt 记录',
    movedA.rootPath === tgtA && movedA.id === pA.id
    && !('migrateTargetPath' in movedA)
    && typeof movedA.lastMigratedAt === 'string'
    && movedB.rootPath === tgtB
    && untouchedC.rootPath === join(work, 'srcC')
    && !('lastMigratedAt' in untouchedC));
}

{
  const result = await migrateProjectsToTargets();
  check('重复执行幂等 → 已迁项目不再出现', result.migrated.length === 0 && result.failed.length === 0);
}

// ---------- 同路径 → failed 汇总 ----------

{
  await updateProject(pA.id, { migrateTargetPath: tgtA });
  const result = await migrateProjectsToTargets();
  check('目标=当前路径 → failed MIGRATE_SAME_PATH',
    result.migrated.length === 0
    && result.failed.length === 1
    && result.failed[0].id === pA.id
    && result.failed[0].code === 'MIGRATE_SAME_PATH');
  // 配置保留，清除后恢复干净状态
  await updateProject(pA.id, { migrateTargetPath: '' });
}

// ---------- 运行中会话 → 拒绝迁移 ----------

{
  await updateProject(pB.id, { migrateTargetPath: tgtB2 });
  await withSessionsMetaMutation(async (metas, saveSessionsMeta) => {
    metas.push({ id: 'sess_running', projectId: pB.id, activeRunId: 'run_running', createdAt: new Date().toISOString() });
    await saveSessionsMeta(metas, { immediate: true });
  });
  await import('fs/promises').then((f) => f.mkdir(join(CHAT_RUNS_DIR, 'run_running'), { recursive: true }));
  await import('fs/promises').then((f) => f.writeFile(
    join(CHAT_RUNS_DIR, 'run_running', 'status.json'),
    JSON.stringify({ id: 'run_running', state: 'running' }),
    'utf8',
  ));
  const result = await migrateProjectsToTargets();
  check('运行中会话 → failed PROJECT_MIGRATE_ACTIVE（不中断其余）',
    result.migrated.length === 0
    && result.failed.length === 1
    && result.failed[0].id === pB.id
    && result.failed[0].code === 'PROJECT_MIGRATE_ACTIVE');
  // 清理运行中会话 meta，避免影响后续用例
  await withSessionsMetaMutation(async (metas, saveSessionsMeta) => {
    const idx = metas.findIndex((m) => m.id === 'sess_running');
    if (idx >= 0) metas.splice(idx, 1);
    await saveSessionsMeta(metas, { immediate: true });
  });
  await updateProject(pB.id, { migrateTargetPath: '' });
}

// ---------- 权限不足 → failed EACCES 汇总；恢复后重跑成功 ----------

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
if (!isRoot) {
  const lockedDir = join(work, 'locked');
  await mkdir(lockedDir, { recursive: true });
  await updateProject(pB.id, { migrateTargetPath: join(lockedDir, 'tgtB') });
  await chmod(lockedDir, 0o000);
  try {
    const result = await migrateProjectsToTargets();
    check('权限不足 → failed 带 EACCES（不中断）',
      result.migrated.length === 0
      && result.failed.length === 1
      && result.failed[0].id === pB.id
      && result.failed[0].code === 'EACCES'
      && typeof result.failed[0].error === 'string');
  } finally {
    await chmod(lockedDir, 0o755);
  }
  const retry = await migrateProjectsToTargets();
  check('权限恢复后重跑 → 迁移成功', retry.migrated.length === 1 && retry.migrated[0].id === pB.id);
} else {
  console.log('skip - 权限不足用例（root 运行无法触发 EACCES）');
}

// ---------- 自定义重命名 ----------

const srcR = join(work, 'srcR');
await mkdir(join(srcR, 'sub', 'deep'), { recursive: true });
await mkdir(join(srcR, 'plain'), { recursive: true });
await writeFile(join(srcR, 'a.txt'), 'top');
await writeFile(join(srcR, 'sub', 'b.txt'), 'nested');
await writeFile(join(srcR, 'sub', 'deep', 'c.txt'), 'deepest');
await writeFile(join(srcR, 'plain', 'keep.txt'), 'keep');
const pR = await createProject({ name: '项目R', rootPath: srcR });
const tgtR = join(work, 'tgtR');

{
  const updated = await updateProject(pR.id, {
    migrateTargetPath: tgtR,
    migrateRenames: {
      'a.txt': 'renamed.txt',
      'sub/b.txt': 'moved/deep.txt',
      sub: 'renamedSub',   // 父目录改名 → 子条目应跟随
      '../evil': 'x',      // 穿越 → 丢弃
      '/abs': 'y',         // 绝对路径 → 丢弃
      'a\\b': 'z',         // 反斜杠 → 丢弃
      '': 'empty',         // 空串 → 丢弃
    },
  });
  check('PATCH 配置 migrateRenames（lib 层）',
    updated.migrateTargetPath === tgtR && !!updated.migrateRenames);
  check('穿越/绝对/反斜杠/空条目被丢弃，合法条目保留',
    updated.migrateRenames['a.txt'] === 'renamed.txt'
    && updated.migrateRenames['sub/b.txt'] === 'moved/deep.txt'
    && updated.migrateRenames.sub === 'renamedSub'
    && Object.keys(updated.migrateRenames).length === 3);
}

{
  const result = await migrateProjectsToTargets();
  check('带重命名映射迁移成功',
    result.migrated.length === 1 && result.migrated[0].id === pR.id && result.failed.length === 0);
  const read = async (p) => import('fs/promises').then((f) => f.readFile(p, 'utf8'));
  check('顶层条目改名生效（旧名消失）',
    (await read(join(tgtR, 'renamed.txt'))) === 'top'
    && !(await exists(join(tgtR, 'a.txt'))));
  check('深层条目改名生效（移动到新目录）',
    (await read(join(tgtR, 'moved', 'deep.txt'))) === 'nested'
    && !(await exists(join(tgtR, 'sub', 'b.txt'))));
  check('父目录改名 → 子条目跟随父目标位置',
    (await read(join(tgtR, 'renamedSub', 'deep', 'c.txt'))) === 'deepest'
    && !(await exists(join(tgtR, 'sub', 'deep', 'c.txt'))));
  check('无映射条目原样复制',
    (await read(join(tgtR, 'plain', 'keep.txt'))) === 'keep');
}

{
  const set1 = await updateProject(pR.id, { migrateRenames: { 'x.txt': 'y.txt' } });
  check('再次配置映射（迁移后项目）', set1.migrateRenames['x.txt'] === 'y.txt');
  const bad = await updateProject(pR.id, { migrateRenames: 42 });
  check('非法类型（非对象）保留已配置映射',
    bad.migrateRenames && bad.migrateRenames['x.txt'] === 'y.txt');
  const cleared = await updateProject(pR.id, { migrateRenames: '' });
  check('显式空串清除 migrateRenames', !('migrateRenames' in cleared));
}

// ---------- HTTP 层 ----------

{
  const res = makeRes();
  await handleControlRoutes({
    req: makeBodyReq({}, { method: 'GET' }), res,
    parsedUrl: { pathname: '/api/browse', query: { roots: '1' } }, pathname: '/api/browse',
    authSession: { role: 'owner' }, writeJson, writeJsonCached: writeJson, isDirectoryPath,
  });
  const payload = JSON.parse(res.body);
  check('GET /api/browse?roots=1 → 返回当前机器可访问的磁盘根目录',
    res.statusCode === 200 && Array.isArray(payload.roots) && payload.roots.length > 0
      && payload.roots.every((root) => typeof root.name === 'string' && typeof root.path === 'string'));
}

{
  const res = makeRes();
  await handleControlRoutes({
    req: makeBodyReq({}), res, parsedUrl: { pathname: '/api/projects/migrate', query: {} },
    pathname: '/api/projects/migrate', authSession: null,
    writeJson, writeJsonCached: writeJson,
  });
  check('migrate 非 owner → 403', res.statusCode === 403);
}

{
  // PATCH 设置迁移目标（HTTP 层）+ migrate 全链路（C 项目）
  const res = makeRes();
  await handleControlRoutes({
    req: makeBodyReq({ migrateTargetPath: tgtC, migrateRenames: { 'x.txt': 'y.txt' } }, { method: 'PATCH' }),
    res, parsedUrl: { pathname: `/api/projects/${pC.id}`, query: {} },
    pathname: `/api/projects/${pC.id}`, authSession: { role: 'owner' },
    writeJson, writeJsonCached: writeJson,
  });
  const patchedProject = JSON.parse(res.body).project;
  check('PATCH 设置 migrateTargetPath + migrateRenames → 200 投影带字段',
    res.statusCode === 200
    && patchedProject.migrateTargetPath === tgtC
    && patchedProject.migrateRenames['x.txt'] === 'y.txt');
  const res2 = makeRes();
  await handleControlRoutes({
    req: makeBodyReq({}), res: res2, parsedUrl: { pathname: '/api/projects/migrate', query: {} },
    pathname: '/api/projects/migrate', authSession: { role: 'owner' },
    writeJson, writeJsonCached: writeJson,
  });
  const result = JSON.parse(res2.body);
  check('POST migrate → 200 {migrated, failed}',
    res2.statusCode === 200 && Array.isArray(result.migrated) && Array.isArray(result.failed)
    && result.migrated.length === 1 && result.migrated[0].id === pC.id);
  const res3 = makeRes();
  await handleControlRoutes({
    req: makeBodyReq({ migrateTargetPath: '' }, { method: 'PATCH' }),
    res: res3, parsedUrl: { pathname: `/api/projects/${pC.id}`, query: {} },
    pathname: `/api/projects/${pC.id}`, authSession: { role: 'owner' },
    writeJson, writeJsonCached: writeJson,
  });
  const cleared = JSON.parse(res3.body).project;
  check('PATCH 空串清除 migrateTargetPath',
    res3.statusCode === 200 && !('migrateTargetPath' in cleared));

  const mkdirTarget = join(work, 'created-by-picker');
  const res4 = makeRes();
  await handleControlRoutes({
    req: makeBodyReq({ path: work, name: 'created-by-picker' }), res: res4,
    parsedUrl: { pathname: '/api/browse/mkdir', query: {} }, pathname: '/api/browse/mkdir',
    authSession: { role: 'owner' }, writeJson, writeJsonCached: writeJson, isDirectoryPath,
  });
  const created = JSON.parse(res4.body);
  check('POST /api/browse/mkdir → 创建并返回新路径',
    res4.statusCode === 201 && created.path === mkdirTarget,
    `status=${res4.statusCode} body=${res4.body}`);

  const res5 = makeRes();
  await handleControlRoutes({
    req: makeBodyReq({ path: work, name: 'created-by-picker' }), res: res5,
    parsedUrl: { pathname: '/api/browse/mkdir', query: {} }, pathname: '/api/browse/mkdir',
    authSession: { role: 'owner' }, writeJson, writeJsonCached: writeJson, isDirectoryPath,
  });
  check('POST /api/browse/mkdir → 重名返回 409', res5.statusCode === 409);

  const res6 = makeRes();
  await handleControlRoutes({
    req: makeBodyReq({ path: work, name: '../escape' }), res: res6,
    parsedUrl: { pathname: '/api/browse/mkdir', query: {} }, pathname: '/api/browse/mkdir',
    authSession: { role: 'owner' }, writeJson, writeJsonCached: writeJson, isDirectoryPath,
  });
  check('POST /api/browse/mkdir → 路径穿越名称返回 400', res6.statusCode === 400);
}

console.log(`test-project-migrate: ok (${passed} assertions)`);
await rm(tempHome, { recursive: true, force: true });
