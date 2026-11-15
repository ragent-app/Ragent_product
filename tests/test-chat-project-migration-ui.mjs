#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const repoRoot = new URL('../', import.meta.url);
const [pickerSource, migrationSource, baseStyles, sidebarStyles, responsiveStyles] = await Promise.all([
  readFile(new URL('static/chat/folder-tree-picker.js', repoRoot), 'utf8'),
  readFile(new URL('static/chat/project-migrate-ui.js', repoRoot), 'utf8'),
  readFile(new URL('static/chat/chat-base.css', repoRoot), 'utf8'),
  readFile(new URL('static/chat/chat-sidebar.css', repoRoot), 'utf8'),
  readFile(new URL('static/chat/chat-responsive.css', repoRoot), 'utf8'),
]);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const reviewDir = '/var/lib/ragent/workspace/visual-ui-reviews/project-migration/ui';
await mkdir(reviewDir, { recursive: true });
try {
  await page.setContent('<!doctype html><html><body><button id="settings">Settings</button></body></html>');
  await page.addStyleTag({ content: baseStyles });
  await page.addStyleTag({ content: sidebarStyles });
  await page.addStyleTag({ content: responsiveStyles });
  await page.addScriptTag({ content: `
    window.RagentIcons = { hydrate() {} };
    window.RagentFileTreeView = { escapeHtml(value) { return String(value || '').replace(/[&<>\"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' }[char])); } };
    window.RagentFocusScope = { activate(root, options) { options?.initialFocus?.focus?.(); return () => {}; } };
    window.ragentT = (key) => ({
      'sidebar.project.newFolder': 'New folder', 'sidebar.project.newFolderName': 'Folder name',
      'sidebar.project.newFolderPlaceholder': 'Reports', 'action.create': 'Create',
      'sidebar.project.folderNameInvalid': 'Invalid folder name', 'sidebar.project.folderCreateFailed': 'Create failed',
      'sidebar.project.migration': 'Project migration', 'sidebar.project.currentPath': 'Current path',
      'sidebar.project.migrateTarget': 'Target folder', 'sidebar.project.chooseFolder': 'Choose folder',
      'sidebar.project.saveMigration': 'Save migration', 'sidebar.project.clearMigration': 'Clear',
      'sidebar.project.advancedRenames': 'Advanced renames', 'sidebar.project.sourcePath': 'Source',
      'sidebar.project.targetPath': 'Target', 'sidebar.project.addMapping': 'Add mapping',
      'sidebar.project.noMappings': 'No mappings', 'sidebar.project.copyNotice': 'Copy only',
      'sidebar.project.samePath': 'Same path', 'sidebar.project.migrateAll': 'Migrate configured projects',
      'sidebar.project.migrateNow': 'Migrate now', 'sidebar.project.migrationSaved': 'Saved',
      'sidebar.project.migrationFailed': 'Migration failed', 'sidebar.project.migrationDone': 'Complete',
      'sidebar.project.invalidMapping': 'Invalid mapping', 'action.cancel': 'Cancel', 'action.close': 'Close',
    }[key] || key);
    window.ragentGetBrowsingProject = () => ({ id: 'prj_1', name: 'Demo', rootPath: '/work/demo', migrateTargetPath: '/work/target', migrateRenames: { 'a.txt': 'renamed.txt' } });
    window.ragentEnsureProjectsReady = async () => {};
    window.fetch = async (url, options = {}) => {
      const text = String(url);
      if (text.includes('/api/browse/mkdir')) return new Response(JSON.stringify({ path: '/work/new-folder', name: 'new-folder' }), { status: 201 });
      if (text.includes('/api/browse?')) return new Response(JSON.stringify({ path: '/work', parent: '/', children: [{ path: '/work/demo', name: 'demo' }] }));
      if (text.includes('/api/projects/prj_1')) return new Response(JSON.stringify({ id: 'prj_1', name: 'Demo', rootPath: '/work/demo', migrateTargetPath: '/work/target', migrateRenames: { 'a.txt': 'renamed.txt' } }));
      if (text.includes('/api/projects/migrate')) return new Response(JSON.stringify({ migrated: [{ id: 'prj_1', name: 'Demo', rootPath: '/work/target' }], failed: [] }));
      throw new Error('unexpected request ' + text);
    };
  ` });
  await page.addScriptTag({ content: pickerSource });
  await page.evaluate(() => {
    const mount = document.createElement('div');
    mount.id = 'picker';
    document.body.appendChild(mount);
    window.__picked = [];
    window.RagentFolderTreePicker.create({ container: mount, startPath: '/work', onChange: ({ path }) => window.__picked.push(path) });
  });
  await page.waitForSelector('.folder-tree-picker-new');
  await page.locator('.folder-tree-picker-new').click();
  await page.locator('#folderTreePickerCreateName').fill('new-folder');
  await page.locator('[data-create-form] button[type="submit"]').click();
  await page.waitForFunction(() => window.__picked.includes('/work/new-folder'));
  assert.equal(await page.locator('.folder-tree-picker-current-path').textContent(), '/work/new-folder');

  await page.addScriptTag({ content: migrationSource });
  const opened = await page.evaluate(() => window.RagentProjectMigration.open(window.ragentGetBrowsingProject()));
  assert.equal(opened, true);
  await page.screenshot({ path: `${reviewDir}/migration-settings-mobile.png`, fullPage: true });
  await page.locator('.project-migrate-renames summary').click();
  await page.screenshot({ path: `${reviewDir}/migration-renames-mobile.png`, fullPage: true });
  await page.locator('.project-migrate-save').click();
  await page.waitForSelector('.project-migrate-result.is-success');
  await page.locator('.project-migrate-run-all').click();
  await page.waitForFunction(() => document.querySelector('.project-migrate-result')?.textContent.includes('Demo'));
  assert.match(await page.locator('.project-migrate-result').textContent(), /Complete/);
  console.log('test-chat-project-migration-ui: ok');
} finally {
  await browser.close();
}
