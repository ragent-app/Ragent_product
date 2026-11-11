import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { computeExecutionScopeDigest } from './execution-scope.mjs';

function refuse(message) {
  throw Object.assign(new Error(message), { code: 'READ_ONLY_RUNTIME_REFUSED' });
}
function isContained(root, target) {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel));
}

/** Return the verified workspace root when a run requires read-only execution. */
export function readOnlyWorkspaceForRun(manifest, actualCwd) {
  const scope = manifest?.executionScope;
  const required = scope?.accessMode === 'read' || manifest?.options?.readOnlyRequired === true;
  if (!required) return null;
  if (!scope || scope.accessMode !== 'read' || typeof manifest.executionScopeDigest !== 'string'
      || computeExecutionScopeDigest(scope) !== manifest.executionScopeDigest) {
    refuse('Read-only run has no valid immutable execution scope');
  }
  const workspace = scope.workspaceRoot?.realPath;
  const scopedCwd = scope.cwd?.realPath;
  if (typeof workspace !== 'string' || typeof scopedCwd !== 'string' || typeof actualCwd !== 'string'
      || workspace === '/' || !isAbsolute(workspace) || !isAbsolute(scopedCwd) || !isAbsolute(actualCwd)) {
    refuse('Read-only run has no absolute workspace or working directory');
  }
  try {
    if (realpathSync(workspace) !== workspace || realpathSync(scopedCwd) !== scopedCwd
        || realpathSync(actualCwd) !== actualCwd || !statSync(workspace).isDirectory()
        || !statSync(scopedCwd).isDirectory() || !statSync(actualCwd).isDirectory()
        || !isContained(workspace, scopedCwd) || !isContained(workspace, actualCwd)) {
      refuse('Read-only run workspace or working directory changed');
    }
  } catch (error) {
    if (error?.code === 'READ_ONLY_RUNTIME_REFUSED') throw error;
    refuse('Read-only run workspace or working directory is unavailable');
  }
  return workspace;
}
