#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

const USAGE = `Central Accounts ASR reconciliation (database URL comes only from the protected environment)

Commands:
  list [--limit 100]
  preview --account-id ID --request-id ID --outcome provider_not_processed|provider_processed_result_lost
  resolve --account-id ID --request-id ID --outcome provider_not_processed|provider_processed_result_lost
          --operator-id ID --evidence-ref REF --reason TEXT [--apply]

resolve is a read-only preview unless --apply is explicitly supplied.
`;

const VALUE_FLAGS = new Set(['--limit', '--account-id', '--request-id', '--outcome',
  '--operator-id', '--evidence-ref', '--reason']);
const OUTCOMES = new Set(['provider_not_processed', 'provider_processed_result_lost']);

export function parseAsrReconcileArgs(argv = []) {
  const command = argv[0] || 'list';
  if (!['list', 'preview', 'resolve', 'help', '--help', '-h'].includes(command)) {
    throw Object.assign(new Error('Unknown reconciliation command'), { code: 'asr_reconcile_usage' });
  }
  const values = {};
  let apply = false;
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--apply') {
      if (apply) throw Object.assign(new Error('Duplicate flag'), { code: 'asr_reconcile_usage' });
      apply = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag) || values[flag]) {
      throw Object.assign(new Error('Unknown or duplicate flag'), { code: 'asr_reconcile_usage' });
    }
    const value = argv[index + 1];
    if (typeof value !== 'string' || !value || value.startsWith('--')) {
      throw Object.assign(new Error('Missing flag value'), { code: 'asr_reconcile_usage' });
    }
    values[flag] = value;
    index += 1;
  }
  if (apply && command !== 'resolve') {
    throw Object.assign(new Error('--apply is valid only with resolve'), { code: 'asr_reconcile_usage' });
  }
  const result = { command, apply };
  for (const [flag, name] of Object.entries({ '--limit': 'limit', '--account-id': 'accountId',
    '--request-id': 'requestId', '--outcome': 'outcome', '--operator-id': 'operatorId',
    '--evidence-ref': 'evidenceRef', '--reason': 'reason' })) {
    if (values[flag] !== undefined) result[name] = values[flag];
  }
  if (command === 'list') {
    result.limit = result.limit === undefined ? 100 : Number(result.limit);
    if (!Number.isSafeInteger(result.limit) || result.limit < 1 || result.limit > 500
      || Object.keys(values).some((flag) => flag !== '--limit')) {
      throw Object.assign(new Error('Invalid list options'), { code: 'asr_reconcile_usage' });
    }
  }
  if (['preview', 'resolve'].includes(command)) {
    if (!result.accountId || !result.requestId || !OUTCOMES.has(result.outcome)
      || (command === 'preview' && Object.keys(values).some((flag) =>
        !['--account-id', '--request-id', '--outcome'].includes(flag)))
      || (command === 'resolve' && (!result.operatorId || !result.evidenceRef || !result.reason))) {
      throw Object.assign(new Error('Missing or invalid reconciliation fields'), { code: 'asr_reconcile_usage' });
    }
  }
  return result;
}

export async function runAsrReconcileCommand({ argv = [], env = process.env, repository,
  createPool, stdout = (value) => process.stdout.write(`${value}\n`), stderr = (value) => process.stderr.write(`${value}\n`) } = {}) {
  let options;
  try { options = parseAsrReconcileArgs(argv); }
  catch {
    stderr(USAGE);
    return 2;
  }
  if (['help', '--help', '-h'].includes(options.command)) {
    stdout(USAGE);
    return 0;
  }
  let pool;
  try {
    if (!repository) {
      const databaseUrl = typeof env.AGENTOC_ACCOUNTS_DATABASE_URL === 'string'
        ? env.AGENTOC_ACCOUNTS_DATABASE_URL.trim() : '';
      if (!databaseUrl) {
        stderr('asr-reconcile: AGENTOC_ACCOUNTS_DATABASE_URL is missing from the protected environment.');
        return 2;
      }
      const [pg, storeModule] = await Promise.all([import('pg'), import('./asr-postgres-store.mjs')]);
      const Pool = pg.Pool || pg.default?.Pool;
      if (typeof Pool !== 'function') throw Object.assign(new Error('PostgreSQL client unavailable'), { code: 'dependency' });
      pool = createPool ? createPool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 5_000 })
        : new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 5_000 });
      repository = storeModule.createAccountAsrPostgresStore({ pool, schema: 'public' });
    }

    if (options.command === 'list') {
      stdout(JSON.stringify(await repository.listUnknownRequests({ limit: options.limit }), null, 2));
      return 0;
    }
    const request = { accountId: options.accountId, requestId: options.requestId, outcome: options.outcome };
    if (options.command === 'preview') {
      const result = await repository.previewUnknownReconciliation(request);
      stdout(JSON.stringify(result, null, 2));
      return result.kind === 'preview' ? 0 : 3;
    }
    const preview = await repository.previewUnknownReconciliation(request);
    if (preview.kind !== 'preview') {
      stdout(JSON.stringify(preview, null, 2));
      return 3;
    }
    if (!options.apply) {
      stdout(JSON.stringify({ ...preview, mode: 'dry_run', changesApplied: false,
        instruction: 'Verify unique provider evidence; rerun the same resolve command with --apply to commit.' }, null, 2));
      return 0;
    }
    const result = await repository.reconcileUnknown({ ...request,
      operatorId: options.operatorId, evidenceRef: options.evidenceRef, reason: options.reason });
    stdout(JSON.stringify(result, null, 2));
    return ['reconciled', 'already_reconciled'].includes(result.kind) ? 0 : 3;
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[a-z0-9_]{1,80}$/i.test(error.code) ? error.code : 'database_error';
    stderr(`asr-reconcile: operation failed (${code}); no connection details or request content were printed.`);
    return 1;
  } finally {
    await pool?.end?.().catch?.(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runAsrReconcileCommand({ argv: process.argv.slice(2) });
}
