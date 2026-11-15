#!/usr/bin/env node
// 选定会话迁移验证：只导出 project 内指定 sessionIds，目标端导入后恢复历史、
// 项目关联和本地图片附件；未选会话不进入迁移包，重复导入拒绝覆盖。
import assert from 'assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const repoRoot = process.cwd();
const tempHome = await mkdtemp(join(tmpdir(), 'ragent-session-migration-'));
process.env.HOME = tempHome;
process.env.RAGENT_CONFIG_DIR = join(tempHome, 'config');
process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
delete process.env.RAGENT_INSTANCE_ROOT;

const work = join(tempHome, 'work');
const sourceRoot = join(work, 'source-project');
const targetRoot = join(work, 'target-project');
await mkdir(process.env.RAGENT_CONFIG_DIR, { recursive: true });
await writeFile(
  join(process.env.RAGENT_CONFIG_DIR, 'auth.json'),
  JSON.stringify({ username: 'testowner', passwordHash: 'not-a-real-hash' }),
  'utf8',
);
await mkdir(sourceRoot, { recursive: true });
await writeFile(join(sourceRoot, 'README.md'), 'project content\n', 'utf8');

const {
  CHAT_FILE_ASSETS_DIR,
  CHAT_HISTORY_DIR,
  CHAT_RUNS_DIR,
  CHAT_IMAGES_DIR,
} = await import(pathToFileURL(join(repoRoot, 'lib', 'config.mjs')).href);
const { createProject } = await import(pathToFileURL(join(repoRoot, 'chat', 'projects.mjs')).href);
const { appendEvents } = await import(pathToFileURL(join(repoRoot, 'chat', 'history.mjs')).href);
const {
  getFileAsset,
  publishLocalFileAssetFromPath,
} = await import(pathToFileURL(join(repoRoot, 'chat', 'file-assets.mjs')).href);
const {
  exportSelectedProjectSessions,
  importSessionMigrationBundle,
} = await import(pathToFileURL(join(repoRoot, 'chat', 'session-migration.mjs')).href);
const { handleControlRoutes } = await import(pathToFileURL(join(repoRoot, 'chat', 'router-control-routes.mjs')).href);
const {
  loadSessionsMeta,
  withSessionsMetaMutation,
} = await import(pathToFileURL(join(repoRoot, 'chat', 'session-meta-store.mjs')).href);

let passed = 0;
function check(name, condition, detail = '') {
  assert.ok(condition, `${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`ok - ${name}`);
}

async function exists(path) {
  return stat(path).then(() => true, () => false);
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = { ...headers };
    },
    end(body = '') {
      this.body = body;
    },
  };
}

function makeBodyReq(body) {
  const chunk = Buffer.from(JSON.stringify(body));
  return {
    method: 'POST',
    headers: { host: 'a.ragent.test' },
    on(event, handler) {
      if (event === 'data') queueMicrotask(() => handler(chunk));
      if (event === 'end') queueMicrotask(() => handler());
      return this;
    },
    destroy() {},
  };
}

function writeJson(res, statusCode, value) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

const project = await createProject({ name: '迁移项目', rootPath: sourceRoot });
await mkdir(CHAT_IMAGES_DIR, { recursive: true });
await writeFile(join(CHAT_IMAGES_DIR, 'selected.png'), 'image-bytes\n', 'utf8');
const localAssetSource = join(work, 'selected-asset.txt');
await writeFile(localAssetSource, 'asset-bytes\n', 'utf8');

const selectedIds = ['selected-one', 'selected-two'];
const unselectedId = 'not-selected';
await withSessionsMetaMutation(async (metas, saveSessionsMeta) => {
  metas.push(
    ...selectedIds.map((id, index) => ({
      id,
      projectId: project.id,
      folder: sourceRoot,
      name: `Selected ${index + 1}`,
      tool: 'codex',
      created: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...(index === 0 ? { codexThreadId: 'old-provider-thread' } : {}),
    })),
    {
      id: unselectedId,
      projectId: project.id,
      folder: sourceRoot,
      name: 'Do not copy',
      tool: 'codex',
      created: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  );
  await saveSessionsMeta(metas, { immediate: true });
});

await appendEvents(selectedIds[0], [{
  type: 'message',
  role: 'user',
  content: 'keep this session',
  attachments: [{
    filename: 'selected.png',
    savedPath: join(CHAT_IMAGES_DIR, 'selected.png'),
    mimeType: 'image/png',
  }],
}]);
await appendEvents(selectedIds[1], [{
  type: 'message',
  role: 'assistant',
  content: 'keep this one too',
  attachments: [{
    assetId: (await publishLocalFileAssetFromPath({
      sessionId: selectedIds[1],
      localPath: localAssetSource,
      originalName: 'selected-asset.txt',
      mimeType: 'text/plain',
    })).id,
    filename: 'selected-asset.txt',
  }],
}]);
await appendEvents(unselectedId, [{
  type: 'message',
  role: 'user',
  content: 'must not be copied',
}]);

const exported = await exportSelectedProjectSessions({
  projectId: project.id,
  sessionIds: selectedIds,
  targetPath: targetRoot,
});
check('导出返回迁移包和所选 sessionIds',
  exported.migrationId.startsWith('smig_')
  && exported.sessionIds.join(',') === selectedIds.join(',')
  && await exists(join(exported.bundlePath, 'manifest.json')));
check('迁移包包含项目文件和选中会话历史',
  await exists(join(exported.bundlePath, 'project', 'README.md'))
  && await exists(join(exported.bundlePath, 'sessions', selectedIds[0], 'history'))
  && await exists(join(exported.bundlePath, 'sessions', selectedIds[1], 'history'))
  && !(await exists(join(exported.bundlePath, 'sessions', unselectedId))));
check('迁移包包含选中会话引用的图片',
  await exists(join(exported.bundlePath, 'images', 'selected.png')));
const exportedManifest = JSON.parse(await readFile(join(exported.bundlePath, 'manifest.json'), 'utf8'));
const exportedAsset = exportedManifest.assets.find((entry) => entry.localObjectPath);
check('迁移包包含选中会话引用的本地 file asset',
  !!exportedAsset
  && await exists(join(exported.bundlePath, exportedAsset.recordPath))
  && await exists(join(exported.bundlePath, exportedAsset.localObjectPath)));

const routeTarget = join(work, 'route-target');
const routeRes = makeRes();
await handleControlRoutes({
  req: makeBodyReq({ sessionIds: [selectedIds[0]], targetPath: routeTarget }),
  res: routeRes,
  parsedUrl: { pathname: `/api/projects/${project.id}/session-migration/export`, query: {} },
  pathname: `/api/projects/${project.id}/session-migration/export`,
  authSession: { role: 'owner' },
  writeJson,
  writeJsonCached: writeJson,
});
check('导出 HTTP 接口返回 201 和迁移包',
  routeRes.statusCode === 201 && JSON.parse(routeRes.body).sessionIds[0] === selectedIds[0]);
const forbiddenRes = makeRes();
await handleControlRoutes({
  req: makeBodyReq({ sessionIds: selectedIds, targetPath: join(work, 'forbidden-target') }),
  res: forbiddenRes,
  parsedUrl: { pathname: `/api/projects/${project.id}/session-migration/export`, query: {} },
  pathname: `/api/projects/${project.id}/session-migration/export`,
  authSession: null,
  writeJson,
  writeJsonCached: writeJson,
});
check('导出 HTTP 接口非 owner 返回 403', forbiddenRes.statusCode === 403);

await withSessionsMetaMutation(async (metas, saveSessionsMeta) => {
  const meta = metas.find((entry) => entry.id === selectedIds[0]);
  meta.activeRunId = 'run_migration_active';
  await saveSessionsMeta(metas, { immediate: true });
});
await mkdir(join(CHAT_RUNS_DIR, 'run_migration_active'), { recursive: true });
await writeFile(
  join(CHAT_RUNS_DIR, 'run_migration_active', 'status.json'),
  JSON.stringify({ id: 'run_migration_active', state: 'running' }),
  'utf8',
);
await assert.rejects(
  exportSelectedProjectSessions({
    projectId: project.id,
    sessionIds: [selectedIds[0]],
    targetPath: join(work, 'active-target'),
  }),
  (error) => error?.code === 'PROJECT_MIGRATE_ACTIVE' && error?.statusCode === 409,
);
check('运行中会话不能导出', true);
await withSessionsMetaMutation(async (metas, saveSessionsMeta) => {
  const meta = metas.find((entry) => entry.id === selectedIds[0]);
  delete meta.activeRunId;
  await saveSessionsMeta(metas, { immediate: true });
});
await rm(join(CHAT_RUNS_DIR, 'run_migration_active'), { recursive: true, force: true });

// 模拟“另一台设备”：删除源端选中会话后再从包导入，未选会话始终保留。
await withSessionsMetaMutation(async (metas, saveSessionsMeta) => {
  const selectedSet = new Set(selectedIds);
  const kept = metas.filter((meta) => !selectedSet.has(meta.id));
  await saveSessionsMeta(kept, { immediate: true });
});
await Promise.all(selectedIds.map((id) => rm(join(CHAT_HISTORY_DIR, id), { recursive: true, force: true })));
if (exportedAsset) {
  const sourceAssetRecord = await getFileAsset(exportedAsset.id);
  await rm(join(CHAT_FILE_ASSETS_DIR, `${exportedAsset.id}.json`), { force: true });
  if (sourceAssetRecord?.storage?.localFilename) {
    await rm(join(CHAT_FILE_ASSETS_DIR, 'objects', sourceAssetRecord.storage.localFilename), { force: true });
  }
}

const imported = await importSessionMigrationBundle({
  bundlePath: exported.bundlePath,
  projectRootPath: targetRoot,
});
check('导入返回全部所选 sessionIds',
  imported.importedSessionIds.join(',') === selectedIds.join(','));
check('导入复制项目文件到目标目录',
  await readFile(join(targetRoot, 'README.md'), 'utf8') === 'project content\n');
check('导入只恢复所选会话，不恢复未选会话副本',
  (await loadSessionsMeta()).filter((meta) => selectedIds.includes(meta.id)).length === 2
  && (await loadSessionsMeta()).filter((meta) => meta.id === unselectedId).length === 1);
check('导入会话改为目标项目目录并清掉 provider resume 状态',
  (await loadSessionsMeta()).filter((meta) => selectedIds.includes(meta.id))
    .every((meta) => meta.folder === targetRoot && meta.projectId === imported.project.id && !meta.codexThreadId));
const importedEventPath = join(CHAT_HISTORY_DIR, selectedIds[0], 'events', '000000001.json');
const importedEvent = JSON.parse(await readFile(importedEventPath, 'utf8'));
check('导入历史中的图片路径指向目标实例资产目录',
  importedEvent.attachments?.[0]?.savedPath === join(CHAT_IMAGES_DIR, 'selected.png')
  && await exists(join(CHAT_IMAGES_DIR, 'selected.png')));
check('导入恢复本地 file asset 对象',
  !!exportedAsset
  && !!await getFileAsset(exportedAsset.id)
  && await exists(join(CHAT_FILE_ASSETS_DIR, 'objects', exportedAsset.localFilename)));

await assert.rejects(
  importSessionMigrationBundle({ bundlePath: exported.bundlePath, projectRootPath: targetRoot }),
  (error) => error?.code === 'SESSION_MIGRATION_CONFLICT' && error?.statusCode === 409,
);
check('重复导入拒绝覆盖已有会话', true);
const importRouteRes = makeRes();
await handleControlRoutes({
  req: makeBodyReq({ bundlePath: exported.bundlePath, projectRootPath: targetRoot }),
  res: importRouteRes,
  parsedUrl: { pathname: '/api/session-migrations/import', query: {} },
  pathname: '/api/session-migrations/import',
  authSession: { role: 'owner' },
  writeJson,
  writeJsonCached: writeJson,
});
check('导入 HTTP 接口透传冲突状态',
  importRouteRes.statusCode === 409 && JSON.parse(importRouteRes.body).code === 'SESSION_MIGRATION_CONFLICT');

await rm(tempHome, { recursive: true, force: true });
console.log(`test-session-migration: ok (${passed} assertions)`);
