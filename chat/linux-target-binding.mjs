/**
 * Canonical representation of the Linux native file-adapter snapshot.
 * This validates and binds data; it does not attest the source, authorize an
 * operation, or make the adapter reachable from a product request.
 */
import { createHash } from 'node:crypto';
import { posix as path } from 'node:path';

const FIELDS = Object.freeze([
  'mountId', 'parentDevice', 'parentInode', 'device', 'inode', 'size',
  'ctimeSeconds', 'ctimeNanoseconds', 'mtimeSeconds', 'mtimeNanoseconds',
]);
const UNSIGNED_MAX = (1n << 64n) - 1n;
const SIGNED_MIN = -(1n << 63n);
const SIGNED_MAX = (1n << 63n) - 1n;

function bad(message) {
  const error = new Error(message);
  error.code = 'LINUX_TARGET_BINDING_INVALID';
  throw error;
}

function decimal(value, { signed = false, min = 0n, max = UNSIGNED_MAX } = {}) {
  if (typeof value !== 'string' || value.length > 20 ||
      !(signed ? /^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/ : /^(?:0|[1-9][0-9]*)$/).test(value)) {
    bad('target identity must contain canonical decimal strings');
  }
  const number = BigInt(value);
  if (number < min || number > max) bad('target identity value is outside its supported range');
  return value;
}

/** Bind the exact absolute Linux path to all identity facts emitted by preflight. */
export function createLinuxTargetBinding(requestedPath, snapshot) {
  if (typeof requestedPath !== 'string' || requestedPath === '/' || !requestedPath.startsWith('/') || requestedPath.endsWith('/') ||
      path.normalize(requestedPath) !== requestedPath || /[\x00-\x1f\x7f]/.test(requestedPath) ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(requestedPath) ||
      Buffer.byteLength(requestedPath, 'utf8') >= 4096) {
    bad('target path must be an exact normalized absolute Linux path');
  }
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || !Object.hasOwn(snapshot, 'version') || snapshot.version !== 1 ||
      Object.keys(snapshot).length !== FIELDS.length + 1 ||
      FIELDS.some((field) => !Object.hasOwn(snapshot, field))) {
    bad('target snapshot fields do not match version 1');
  }
  const result = { version: 1, path: requestedPath };
  for (const field of FIELDS) {
    let limits = {};
    if (field === 'mountId' || field === 'parentInode' || field === 'inode') limits = { min: 1n };
    if (field === 'size') limits = { max: SIGNED_MAX };
    if (field.endsWith('Seconds')) limits = { signed: true, min: SIGNED_MIN, max: SIGNED_MAX };
    if (field.endsWith('Nanoseconds')) limits = { max: 999999999n };
    result[field] = decimal(snapshot[field], limits);
  }
  return result;
}

/** The digest must be included in a separately verified owner authorization. */
export function hashLinuxTargetBinding(requestedPath, snapshot) {
  return createHash('sha256').update(JSON.stringify(createLinuxTargetBinding(requestedPath, snapshot)), 'utf8').digest('hex');
}
