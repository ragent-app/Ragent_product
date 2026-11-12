import { readBody } from '../lib/utils.mjs';
import { isStrictLoopbackRequest } from './run-auth-recovery-capability.mjs';
import { authorizeTemporaryControlRun, TEMPORARY_CONTROL_RUN_CHECK_PATH } from './run-execution-boundary.mjs';
import { issueLinuxRunActiveProof, LINUX_RUN_ACTIVE_CHECK_PATH } from './linux-run-active-service.mjs';

// Runner identities cannot read the owner's registry. This endpoint returns no
// grant material and authorizes only the persisted publication named by the
// request. The carrier inventory never exposes this local-only route.
export async function handleTemporaryControlRunCheck({ req, res, pathname, writeJson, issueRunActiveProof = issueLinuxRunActiveProof,
  getRegistry = async () => (await import('./temporary-control-runtime.mjs')).getTemporaryControlRegistry() }) {
  if (![TEMPORARY_CONTROL_RUN_CHECK_PATH, LINUX_RUN_ACTIVE_CHECK_PATH].includes(pathname)) return false;
  if (req.method !== 'POST' || !isStrictLoopbackRequest(req)) {
    writeJson(res, 403, { code: 'RUN_EXECUTION_INPUT_UNAVAILABLE' });
    return true;
  }
  try {
    const body = JSON.parse(await readBody(req, 2048));
    if (pathname === LINUX_RUN_ACTIVE_CHECK_PATH) {
      writeJson(res, 200, { proof: await issueRunActiveProof(body) });
      return true;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).sort().join(',') !== 'publicationId,runId') throw new Error();
    await authorizeTemporaryControlRun(body.runId, body.publicationId, await getRegistry());
    writeJson(res, 200, { authorized: true });
  } catch {
    writeJson(res, 403, { code: 'RUN_EXECUTION_INPUT_UNAVAILABLE' });
  }
  return true;
}
