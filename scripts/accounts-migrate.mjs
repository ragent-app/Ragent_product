#!/usr/bin/env node
// Accounts 数据库迁移执行器：按文件名顺序应用 accounts/migrations/*.up.sql，
// 把已应用版本记录到 schema_migrations；--down 回滚最后一个已应用版本。
// 用法：
//   node scripts/accounts-migrate.mjs [--url <DATABASE_URL>] [--down] [--dir <dir>]
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';

function argValue(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

const url = argValue('--url', process.env.RAGENT_ACCOUNTS_DATABASE_URL || '');
const dir = argValue('--dir', new URL('../accounts/migrations', import.meta.url).pathname);
const direction = process.argv.includes('--down') ? 'down' : 'up';

if (!url) {
  console.error('accounts-migrate: missing DATABASE URL (--url or RAGENT_ACCOUNTS_DATABASE_URL)');
  process.exit(2);
}

const pool = new Pool({ connectionString: url, max: 2 });

async function ensureMigrationsTable(client) {
  await client.query(
    `create table if not exists schema_migrations (
       version text primary key,
       applied_at timestamptz not null default now()
     )`,
  );
}

async function appliedVersions(client) {
  const result = await client.query('select version from schema_migrations order by version');
  return new Set(result.rows.map((row) => row.version));
}

async function migrateUp() {
  const files = (await readdir(dir)).filter((name) => name.endsWith('.up.sql')).sort();
  if (files.length === 0) {
    console.log(`accounts-migrate: no migrations found in ${dir}`);
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    await ensureMigrationsTable(client);
    const applied = await appliedVersions(client);
    let count = 0;
    for (const file of files) {
      const version = file.replace(/\.up\.sql$/, '');
      if (applied.has(version)) continue;
      const sql = await readFile(join(dir, file), 'utf8');
      await client.query(sql);
      await client.query('insert into schema_migrations (version) values ($1)', [version]);
      console.log(`accounts-migrate: applied ${version}`);
      count += 1;
    }
    await client.query('commit');
    if (count === 0) console.log('accounts-migrate: up to date');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function migrateDown() {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await ensureMigrationsTable(client);
    const result = await client.query('select version from schema_migrations order by version desc limit 1');
    const last = result.rows[0]?.version;
    if (!last) {
      await client.query('commit');
      console.log('accounts-migrate: nothing to roll back');
      return;
    }
    await client.query('delete from schema_migrations where version = $1', [last]);
    const downFile = `${last}.down.sql`;
    const sql = await readFile(join(dir, downFile), 'utf8');
    await client.query(sql);
    await client.query('commit');
    console.log(`accounts-migrate: rolled back ${last}`);
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

try {
  if (direction === 'down') await migrateDown();
  else await migrateUp();
} catch (error) {
  console.error(`accounts-migrate: failed: ${error?.message || error}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
