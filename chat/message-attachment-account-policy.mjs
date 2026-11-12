import { parseMessagePreparation } from './message-preparation-contract.mjs';
import { accountFileUploadMaximumBytes } from './file-asset-account-policy.mjs';

// Parse durable facts independently of today's plan, then authorize an
// above-default request with a fresh, account-bound policy at admission time.
// Temporary callers do not provide an owner session and keep the default cap.
export async function authorizeMessageAttachmentSizes(payload, authSession, lookup = accountFileUploadMaximumBytes) {
  const request = parseMessagePreparation(payload, { maximumFileBytes: Number.MAX_SAFE_INTEGER,
    maximumTotalBytes: Number.MAX_SAFE_INTEGER });
  try {
    return parseMessagePreparation(request);
  } catch (error) {
    if (!authSession || await lookup(authSession) !== Number.MAX_SAFE_INTEGER) throw error;
    return request;
  }
}
