import { posix as path } from 'node:path';
import { computeExecutionScopeDigest } from './execution-scope.mjs';

function invalid() {
  throw Object.assign(new Error('Run execution scope is unavailable for approval'), {
    code: 'APPROVED_ACTION_EXECUTION_SCOPE_INVALID', statusCode: 409,
  });
}
function absolute(value) {
  return typeof value === 'string' && value.startsWith('/') && path.normalize(value) === value &&
    !/[\x00-\x1f\x7f]/.test(value);
}

/** Select the same frozen cwd used by Linux scoped Runs, never caller paths. */
export function resolveApprovedActionRunDirectories({ run, manifest, session, platform = process.platform } = {}) {
  const trim = (value) => typeof value === 'string' ? value.trim() : '';
  const legacyCwd = trim(manifest?.folder) || trim(session?.folder);
  if (platform !== 'linux' || !Object.hasOwn(manifest || {}, 'executionScope')) {
    return { cwd: legacyCwd, projectRoot: trim(session?.folder) || legacyCwd };
  }
  try {
    const scope = manifest.executionScope;
    if (!scope || typeof scope !== 'object' || Array.isArray(scope) ||
        !trim(run?.sessionId) || scope.sessionId !== run.sessionId || manifest.sessionId !== run.sessionId ||
        typeof manifest.executionScopeDigest !== 'string' ||
        computeExecutionScopeDigest(scope) !== manifest.executionScopeDigest) invalid();
    const cwd = scope.cwd?.realPath, projectRoot = scope.scopeRoot?.realPath;
    if (!absolute(cwd) || !absolute(projectRoot)) invalid();
    const relative = path.relative(projectRoot, cwd);
    if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) invalid();
    if (scope.riskContext && (scope.riskContext.platform !== 'linux' ||
        scope.riskContext.cwd !== cwd || scope.riskContext.trustedWorkspaceRoot !== projectRoot)) invalid();
    return { cwd, projectRoot };
  } catch { invalid(); }
}
