// Owned isolated PostgreSQL fixture only. No production URL or credential file.
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createAccountDeletionRepository } from '../../accounts/store/account-deletions.mjs';
import { createPublicKey, verify } from 'node:crypto';

const input = JSON.parse(process.env.RAGENT_DELETION_CHILD_INPUT || '{}');
const url = new URL(process.env.RAGENT_ACCOUNTS_ISOLATED_TEST_DATABASE_URL || 'invalid:');
assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.username, 'qa_deletion');
assert.equal(url.pathname, '/postgres');
assert(/^[a-f0-9]{32}$/.test(process.env.RAGENT_TEST_RUN_NONCE || ''));
assert(/^qa_deletion_[a-f0-9]{24}$/.test(input.schema || ''));
const pool = new Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 5000 });
const check = await pool.query("select current_setting('cluster_name') as name");
assert.equal(check.rows[0].name, 'ragent-deletion-' + process.env.RAGENT_TEST_RUN_NONCE);
const key = createPublicKey(input.publicKey);
const repo = createAccountDeletionRepository({ pool, schema: input.schema,
  verifyDeletionConfirmation: async ({ proof }) => {
    const [payload, signature] = proof.split('.');
    assert(verify(null, Buffer.from(payload), key, Buffer.from(signature, 'base64url')));
    return JSON.parse(Buffer.from(payload, 'base64url'));
  } });
const receipt = await repo.accept(input.request);
process.send({ committed: receipt.jobId });
// Deliberately do not deliver a result to an HTTP client. Parent kills this
// exact owned process and recovers using the already-frozen receipt secret.
setTimeout(() => process.exit(2), 30_000);
