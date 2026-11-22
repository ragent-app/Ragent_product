// Gmail connector — read and send mail through the authorized Google
// account. Shares the instance's Google OAuth credentials and token file
// with the calendar connector (see connector-google-common.mjs): the scopes
// are granted by the calendar authorization flow's single consent.

import { createHash } from 'node:crypto';
import { resolveGmailConnectorBinding } from './connector-bindings.mjs';
import {
  buildAuthenticatedClient,
  GOOGLE_GMAIL_SCOPES,
  pathExists,
  readJson,
  tokenScopeCompliance,
} from './connector-google-common.mjs';
import { createConnectorActionResult } from './connector-state.mjs';

const DEFAULT_MAX_MESSAGES = 25;

export const GMAIL_READ_CAPABILITIES = Object.freeze(['gmail.message.list', 'gmail.message.read']);
export const GMAIL_DRAFT_CAPABILITIES = Object.freeze(['gmail.draft.create']);
export const GMAIL_SEND_CAPABILITIES = Object.freeze(['gmail.message.send']);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function buildGmailError(message, { code = 'CONNECTOR_GMAIL_ERROR', statusCode = 500 } = {}) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  return err;
}

function assertNoHeaderInjection(value, fieldName) {
  const raw = typeof value === 'string' ? value : '';
  if (/[\r\n\0]/.test(raw)) {
    throw buildGmailError(`Invalid ${fieldName}: control characters are forbidden.`, {
      code: 'CONNECTOR_INVALID_INPUT',
      statusCode: 400,
    });
  }
  return trimString(raw);
}

function buildDeterministicRfcMessageId(idempotencyKey = '', explicitRfcMessageId = '') {
  const explicit = assertNoHeaderInjection(explicitRfcMessageId, 'rfcMessageId');
  if (explicit) {
    return explicit.startsWith('<') && explicit.endsWith('>') ? explicit : `<${explicit}>`;
  }
  const key = assertNoHeaderInjection(idempotencyKey, 'idempotencyKey');
  if (!key) return '';
  const digestHex = createHash('sha256').update(key).digest('hex').slice(0, 32);
  return `<ragent-${digestHex}@ragent.local>`;
}

function buildRawMimeMessage({ to, subject, body, cc = '', bcc = '', rfcMessageId = '', idempotencyKey = '' } = {}) {
  const safeTo = assertNoHeaderInjection(to, 'recipient');
  if (!safeTo || !/^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(safeTo.replace(/^.*<([^>]+)>$/, '$1').trim())) {
    throw buildGmailError('Valid Gmail recipient is required.', {
      code: 'CONNECTOR_INVALID_INPUT',
      statusCode: 400,
    });
  }
  const safeSubject = assertNoHeaderInjection(subject, 'subject') || '(no subject)';
  const safeCc = assertNoHeaderInjection(cc, 'cc');
  const safeBcc = assertNoHeaderInjection(bcc, 'bcc');
  const headers = [
    `To: ${safeTo}`,
    `Subject: ${safeSubject}`,
  ];
  if (safeCc) headers.push(`Cc: ${safeCc}`);
  if (safeBcc) headers.push(`Bcc: ${safeBcc}`);
  if (rfcMessageId) headers.push(`Message-ID: ${rfcMessageId}`);
  const safeIdempotencyKey = assertNoHeaderInjection(idempotencyKey, 'idempotencyKey');
  if (safeIdempotencyKey) headers.push(`X-Ragent-Idempotency-Key: ${safeIdempotencyKey}`);
  return Buffer.from([...headers, '', typeof body === 'string' ? body : String(body ?? '')].join('\r\n')).toString('base64url');
}

async function resolveGmailClient({ bindingId, credentialsPath, gmailClient } = {}) {
  if (gmailClient) {
    const binding = bindingId ? await resolveGmailConnectorBinding({ bindingId }) : null;
    if (bindingId) {
      const bindingError = resolveBindingError(binding);
      if (bindingError) return { error: bindingError, binding, gmail: null };
    }
    return {
      error: null,
      binding: binding || { id: trimString(bindingId) || 'binding_gmail_mock', capabilityState: 'ready' },
      gmail: gmailClient,
    };
  }
  const binding = await resolveGmailConnectorBinding({ bindingId });
  const bindingError = resolveBindingError(binding);
  if (bindingError) return { error: bindingError, binding, gmail: null };
  const { google, client } = await buildAuthenticatedClient(binding, credentialsPath);
  return {
    error: null,
    binding,
    gmail: google.gmail({ version: 'v1', auth: client }),
  };
}

function resolveBindingError(binding) {
  if (!binding) {
    return createConnectorActionResult({
      connectorId: 'gmail',
      capabilityState: 'binding_required',
      deliveryState: 'drafted',
    });
  }
  if (binding.capabilityState === 'binding_required') {
    return createConnectorActionResult({
      connectorId: 'gmail',
      bindingId: binding.id,
      capabilityState: 'binding_required',
      deliveryState: 'drafted',
    });
  }
  if (binding.capabilityState === 'authorization_required') {
    return createConnectorActionResult({
      connectorId: 'gmail',
      bindingId: binding.id,
      capabilityState: 'authorization_required',
      deliveryState: 'drafted',
    });
  }
  return null;
}

export async function getGmailStatus({ binding, credentialsPath, tokenPath } = {}) {
  const credentialsPresent = await pathExists(credentialsPath);
  const token = tokenPath ? await readJson(tokenPath, null) : null;
  const tokenPresent = !!token;
  const scopeCompliant = !token || tokenScopeCompliance(token, GOOGLE_GMAIL_SCOPES);

  let capabilityState = 'authorization_required';
  if (binding?.capabilityState === 'binding_required') {
    capabilityState = 'binding_required';
  } else if (tokenPresent && scopeCompliant) {
    capabilityState = 'ready';
  }

  return {
    provider: 'google',
    service: 'gmail',
    credentialsPresent,
    tokenPresent,
    scopeCompliant,
    capabilityState,
    accountHint: trimString(binding?.accountHint),
    binding: binding
      ? {
          id: trimString(binding.id),
          title: trimString(binding.title),
          provider: trimString(binding.provider),
          accountHint: trimString(binding.accountHint),
          capabilityState: trimString(binding.capabilityState),
        }
      : null,
  };
}

export async function listGmailMessages({ bindingId, credentialsPath, maxResults = DEFAULT_MAX_MESSAGES, query = '', gmailClient } = {}) {
  const { error, binding, gmail } = await resolveGmailClient({ bindingId, credentialsPath, gmailClient });
  if (error) return { messages: [], error };

  const response = await gmail.users.messages.list({
    userId: 'me',
    maxResults: Math.min(Math.max(1, Number(maxResults) || DEFAULT_MAX_MESSAGES), 100),
    ...(trimString(query) ? { q: trimString(query) } : {}),
  });

  return {
    messages: (response.data.messages || []).map((message) => ({
      id: message.id,
      threadId: trimString(message.threadId),
    })),
    bindingId: binding.id,
  };
}

export async function getGmailMessage({ bindingId, credentialsPath, messageId, gmailClient } = {}) {
  const { error, binding, gmail } = await resolveGmailClient({ bindingId, credentialsPath, gmailClient });
  if (error) return { message: null, error };

  const normalizedMessageId = trimString(messageId);
  if (!normalizedMessageId) {
    return { message: null, error: 'Gmail message id is required.' };
  }

  const response = await gmail.users.messages.get({
    userId: 'me',
    id: normalizedMessageId,
    format: 'metadata',
    metadataHeaders: ['From', 'To', 'Subject', 'Date'],
  });

  const headers = {};
  for (const header of response.data.payload?.headers || []) {
    headers[trimString(header.name)] = trimString(header.value);
  }

  return {
    message: {
      id: trimString(response.data.id),
      threadId: trimString(response.data.threadId),
      from: headers.From || '',
      to: headers.To || '',
      subject: headers.Subject || '',
      date: headers.Date || '',
      snippet: trimString(response.data.snippet),
    },
    bindingId: binding.id,
  };
}

export async function createGmailDraft({
  bindingId,
  credentialsPath,
  to,
  subject,
  body,
  cc = '',
  bcc = '',
  threadId = '',
  idempotencyKey = '',
  gmailClient,
  onBeforeWire,
} = {}) {
  const { error, binding, gmail } = await resolveGmailClient({ bindingId, credentialsPath, gmailClient });
  if (error) return error;

  const raw = buildRawMimeMessage({
    to,
    subject,
    body,
    cc,
    bcc,
    idempotencyKey,
  });
  if (typeof onBeforeWire === 'function') await onBeforeWire();
  const response = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: {
      message: {
        raw,
        ...(trimString(threadId) ? { threadId: trimString(threadId) } : {}),
      },
    },
  });
  const draftId = trimString(response?.data?.id);
  const messageId = trimString(response?.data?.message?.id);
  if (!draftId) {
    throw buildGmailError('Gmail draft creation did not return an authoritative draft ID.', {
      code: 'CONNECTOR_RECEIPT_MISSING',
      statusCode: 502,
    });
  }
  return {
    ...createConnectorActionResult({
      connectorId: 'gmail',
      bindingId: binding.id,
      targetId: `draft:${draftId}`,
      capabilityState: 'ready',
      deliveryState: 'drafted',
      externalId: draftId,
      message: `Created Gmail draft for ${trimString(to)}`,
    }),
    draftId,
    messageId,
  };
}

export async function findGmailDraftReceipt({
  bindingId,
  credentialsPath,
  draftId = '',
  idempotencyKey = '',
  gmailClient,
} = {}) {
  const { error, gmail } = await resolveGmailClient({ bindingId, credentialsPath, gmailClient });
  if (error || !gmail?.users?.drafts) return null;

  const normalizedDraftId = trimString(draftId);
  if (normalizedDraftId && typeof gmail.users.drafts.get === 'function') {
    const response = await gmail.users.drafts.get({
      userId: 'me',
      id: normalizedDraftId,
      format: 'metadata',
    }).catch(() => null);
    if (response?.data?.id === normalizedDraftId) {
      return {
        verified: true,
        externalId: normalizedDraftId,
        draftId: normalizedDraftId,
        receipt: response.data,
      };
    }
  }

  const normalizedKey = trimString(idempotencyKey);
  if (normalizedKey && typeof gmail.users.drafts.list === 'function' && typeof gmail.users.drafts.get === 'function') {
    const listed = await gmail.users.drafts.list({ userId: 'me', maxResults: 50 }).catch(() => null);
    for (const entry of listed?.data?.drafts || []) {
      const detail = await gmail.users.drafts.get({ userId: 'me', id: entry.id, format: 'metadata' }).catch(() => null);
      const headers = detail?.data?.message?.payload?.headers || [];
      const match = headers.some(
        (h) => trimString(h.name).toLowerCase() === 'x-ragent-idempotency-key' && trimString(h.value) === normalizedKey,
      );
      if (match) {
        return {
          verified: true,
          externalId: trimString(detail.data.id),
          draftId: trimString(detail.data.id),
          receipt: detail.data,
        };
      }
    }
  }
  return null;
}

export async function sendGmailMessage({
  bindingId,
  credentialsPath,
  to,
  subject,
  body,
  cc = '',
  bcc = '',
  threadId = '',
  rfcMessageId = '',
  idempotencyKey = '',
  gmailClient,
  onBeforeWire,
} = {}) {
  const { error, binding, gmail } = await resolveGmailClient({ bindingId, credentialsPath, gmailClient });
  if (error) return error;

  const target = trimString(to);
  if (!target) {
    return createConnectorActionResult({
      connectorId: 'gmail',
      bindingId: binding.id,
      capabilityState: 'ready',
      deliveryState: 'drafted',
      message: 'Gmail recipient is required.',
    });
  }

  const effectiveRfcMessageId = buildDeterministicRfcMessageId(idempotencyKey, rfcMessageId);
  const raw = buildRawMimeMessage({
    to: target,
    subject,
    body,
    cc,
    bcc,
    rfcMessageId: effectiveRfcMessageId,
    idempotencyKey,
  });

  if (typeof onBeforeWire === 'function') await onBeforeWire();
  const response = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw,
      ...(trimString(threadId) ? { threadId: trimString(threadId) } : {}),
    },
  });

  const messageId = trimString(response?.data?.id);
  if (!messageId) {
    throw buildGmailError('Gmail send did not return an authoritative message ID.', {
      code: 'CONNECTOR_RECEIPT_MISSING',
      statusCode: 502,
    });
  }

  return createConnectorActionResult({
    connectorId: 'gmail',
    bindingId: binding.id,
    targetId: `message:${messageId}`,
    capabilityState: 'ready',
    deliveryState: 'delivered',
    externalId: messageId,
    message: `Sent Gmail message to ${target}`,
  });
}

export async function findGmailMessageReceipt({
  bindingId,
  credentialsPath,
  messageId = '',
  rfcMessageId = '',
  idempotencyKey = '',
  gmailClient,
} = {}) {
  const { error, gmail } = await resolveGmailClient({ bindingId, credentialsPath, gmailClient });
  if (error || !gmail?.users?.messages) return null;

  const expectedRfcId = buildDeterministicRfcMessageId(idempotencyKey, rfcMessageId);
  const normalizedMessageId = trimString(messageId);
  const normalizedKey = trimString(idempotencyKey);

  const inspectMessage = (msg) => {
    if (!msg?.id) return null;
    if (Array.isArray(msg.labelIds) && msg.labelIds.includes('DRAFT')) return null;
    const headers = new Map();
    for (const header of msg.payload?.headers || []) {
      headers.set(trimString(header.name).toLowerCase(), trimString(header.value));
    }
    if (normalizedKey && headers.has('x-ragent-idempotency-key') && headers.get('x-ragent-idempotency-key') !== normalizedKey) {
      return null;
    }
    if (expectedRfcId && headers.has('message-id') && headers.get('message-id') !== expectedRfcId) {
      return null;
    }
    return {
      verified: true,
      externalId: trimString(msg.id),
      messageId: trimString(msg.id),
      threadId: trimString(msg.threadId),
      rfcMessageId: headers.get('message-id') || expectedRfcId || '',
      receipt: msg,
    };
  };

  if (normalizedMessageId && typeof gmail.users.messages.get === 'function') {
    const response = await gmail.users.messages.get({
      userId: 'me',
      id: normalizedMessageId,
      format: 'metadata',
      metadataHeaders: ['Message-ID', 'X-Ragent-Idempotency-Key', 'To', 'Subject', 'Date'],
    }).catch(() => null);
    const verified = inspectMessage(response?.data);
    if (verified) return verified;
  }

  if (expectedRfcId && typeof gmail.users.messages.list === 'function') {
    const cleanMsgId = expectedRfcId.replace(/^<|>$/g, '');
    const listResp = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 10,
      q: `rfc822msgid:${cleanMsgId}`,
    }).catch(() => null);
    const candidates = listResp?.data?.messages || [];
    for (const candidate of candidates) {
      if (typeof gmail.users.messages.get === 'function') {
        const detail = await gmail.users.messages.get({
          userId: 'me',
          id: candidate.id,
          format: 'metadata',
          metadataHeaders: ['Message-ID', 'X-Ragent-Idempotency-Key', 'To', 'Subject', 'Date'],
        }).catch(() => null);
        const verified = inspectMessage(detail?.data);
        if (verified) return verified;
      }
    }
  }

  return null;
}

export const GMAIL_ACTION_CONTRACTS = Object.freeze({
  'gmail.message.list': Object.freeze({
    capability: 'gmail.message.list',
    connectorId: 'gmail',
    actionClass: 'read',
    privilegeGroup: 'read',
    riskLevel: 'read',
    confirmationPolicy: 'auto_within_policy',
    timeoutMs: 15_000,
    receiptVerifier: Object.freeze({
      kind: 'none_readonly',
      supported: false,
      description: 'Read-only Gmail message list requires no mutation receipt.',
    }),
    compensation: Object.freeze({
      supported: false,
      mode: 'none_readonly',
      description: 'Read-only action has no side effects to compensate.',
    }),
  }),
  'gmail.message.read': Object.freeze({
    capability: 'gmail.message.read',
    connectorId: 'gmail',
    actionClass: 'read',
    privilegeGroup: 'read',
    riskLevel: 'read',
    confirmationPolicy: 'auto_within_policy',
    timeoutMs: 15_000,
    receiptVerifier: Object.freeze({
      kind: 'none_readonly',
      supported: false,
      description: 'Read-only Gmail message read requires no mutation receipt.',
    }),
    compensation: Object.freeze({
      supported: false,
      mode: 'none_readonly',
      description: 'Read-only action has no side effects to compensate.',
    }),
  }),
  'gmail.draft.create': Object.freeze({
    capability: 'gmail.draft.create',
    connectorId: 'gmail',
    actionClass: 'write',
    privilegeGroup: 'draft',
    riskLevel: 'reversible_write',
    confirmationPolicy: 'auto_within_policy',
    timeoutMs: 20_000,
    receiptVerifier: Object.freeze({
      kind: 'provider_lookup',
      supported: true,
      description: 'Verify created Gmail draft via users.drafts.get/list with X-Ragent-Idempotency-Key.',
    }),
    compensation: Object.freeze({
      supported: true,
      mode: 'compensating_action',
      compensatingCapability: 'gmail.draft.delete',
      description: 'Delete the created Gmail draft before sending.',
    }),
  }),
  'gmail.message.send': Object.freeze({
    capability: 'gmail.message.send',
    connectorId: 'gmail',
    actionClass: 'broadcast',
    privilegeGroup: 'send',
    riskLevel: 'external_broadcast',
    confirmationPolicy: 'require_approval',
    timeoutMs: 20_000,
    receiptVerifier: Object.freeze({
      kind: 'provider_lookup',
      supported: true,
      description: 'Verify sent Gmail message ID and rfc822msgid receipt via users.messages.get/list; unverified sends stay unknown_outcome.',
    }),
    compensation: Object.freeze({
      supported: false,
      mode: 'irreversible',
      description: 'Sent emails leave the boundary immediately and cannot be unsent or recalled.',
    }),
  }),
});

export function createGmailConnectorAction(capability, params = {}, options = {}) {
  const template = GMAIL_ACTION_CONTRACTS[capability];
  if (!template) {
    throw buildGmailError(`Unknown Gmail connector capability: ${capability}`, {
      code: 'CONNECTOR_UNSUPPORTED_CAPABILITY',
      statusCode: 400,
    });
  }
  const idempotencyKey = trimString(options.idempotencyKey || params.idempotencyKey);
  const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : template.timeoutMs;
  const confirmationPolicy = trimString(options.confirmationPolicy) || template.confirmationPolicy;
  const bindingId = trimString(params.bindingId || options.bindingId);
  const credentialsPath = trimString(params.credentialsPath || options.credentialsPath);
  const gmailClient = params.gmailClient || options.gmailClient;

  if (capability === 'gmail.message.list') {
    const query = trimString(params.query);
    const maxResults = params.maxResults ?? DEFAULT_MAX_MESSAGES;
    const scope = {
      connectorId: 'gmail',
      privilegeGroup: 'read',
      resource: 'mailbox:messages',
      ...(bindingId ? { bindingId } : {}),
    };
    return {
      contract: { ...template, idempotencyKey, confirmationPolicy, timeoutMs, scope },
      payload: { query, maxResults },
      execute: async (ctx = {}) => await listGmailMessages({
        bindingId,
        credentialsPath,
        maxResults,
        query,
        gmailClient: ctx.gmailClient || gmailClient,
      }),
    };
  }

  if (capability === 'gmail.message.read') {
    const messageId = trimString(params.messageId);
    if (!messageId) {
      throw buildGmailError('Gmail message id is required.', { code: 'CONNECTOR_INVALID_INPUT', statusCode: 400 });
    }
    const scope = {
      connectorId: 'gmail',
      privilegeGroup: 'read',
      resource: `message:${messageId}`,
      messageId,
      ...(bindingId ? { bindingId } : {}),
    };
    return {
      contract: { ...template, idempotencyKey, confirmationPolicy, timeoutMs, scope },
      payload: { messageId },
      execute: async (ctx = {}) => await getGmailMessage({
        bindingId,
        credentialsPath,
        messageId,
        gmailClient: ctx.gmailClient || gmailClient,
      }),
    };
  }

  const to = assertNoHeaderInjection(params.to, 'recipient');
  const subject = assertNoHeaderInjection(params.subject, 'subject');
  const cc = assertNoHeaderInjection(params.cc, 'cc');
  const bcc = assertNoHeaderInjection(params.bcc, 'bcc');
  const threadId = trimString(params.threadId);
  const body = typeof params.body === 'string' ? params.body : String(params.body ?? '');
  if (!to) {
    throw buildGmailError('Gmail recipient is required.', { code: 'CONNECTOR_INVALID_INPUT', statusCode: 400 });
  }
  const recipients = [to, ...cc.split(',').map((s) => s.trim()).filter(Boolean), ...bcc.split(',').map((s) => s.trim()).filter(Boolean)];

  if (capability === 'gmail.draft.create') {
    const scope = {
      connectorId: 'gmail',
      privilegeGroup: 'draft',
      resource: `draft:${to}`,
      recipients,
      ...(bindingId ? { bindingId } : {}),
    };
    const receiptVerifier = {
      ...template.receiptVerifier,
      verify: async (ctx = {}) => await findGmailDraftReceipt({
        bindingId,
        credentialsPath,
        draftId: ctx.result?.draftId || ctx.externalId,
        idempotencyKey,
        gmailClient: ctx.gmailClient || gmailClient,
      }),
    };
    return {
      contract: { ...template, idempotencyKey, confirmationPolicy, timeoutMs, scope, receiptVerifier },
      payload: { to, subject, body, cc, bcc, threadId },
      execute: async (ctx = {}) => await createGmailDraft({
        bindingId,
        credentialsPath,
        to,
        subject,
        body,
        cc,
        bcc,
        threadId,
        idempotencyKey,
        gmailClient: ctx.gmailClient || gmailClient,
        onBeforeWire: ctx.onBeforeWire,
      }),
    };
  }

  if (capability === 'gmail.message.send') {
    const rfcMessageId = buildDeterministicRfcMessageId(idempotencyKey, params.rfcMessageId);
    const scope = {
      connectorId: 'gmail',
      privilegeGroup: 'send',
      resource: `send:${to}`,
      recipients,
      ...(bindingId ? { bindingId } : {}),
    };
    const receiptVerifier = {
      ...template.receiptVerifier,
      verify: async (ctx = {}) => await findGmailMessageReceipt({
        bindingId,
        credentialsPath,
        messageId: ctx.result?.externalId || ctx.externalId,
        rfcMessageId,
        idempotencyKey,
        gmailClient: ctx.gmailClient || gmailClient,
      }),
    };
    return {
      contract: { ...template, idempotencyKey, confirmationPolicy, timeoutMs, scope, receiptVerifier },
      payload: { to, subject, body, cc, bcc, threadId, rfcMessageId },
      execute: async (ctx = {}) => await sendGmailMessage({
        bindingId,
        credentialsPath,
        to,
        subject,
        body,
        cc,
        bcc,
        threadId,
        rfcMessageId,
        idempotencyKey,
        gmailClient: ctx.gmailClient || gmailClient,
        onBeforeWire: ctx.onBeforeWire,
      }),
    };
  }

  throw buildGmailError(`Unsupported Gmail connector capability: ${capability}`, {
    code: 'CONNECTOR_UNSUPPORTED_CAPABILITY',
    statusCode: 400,
  });
}

export async function executeGmailConnectorAction(capability, params = {}, context = {}) {
  const { dispatchConnectorAction } = await import('./connector-action-dispatcher.mjs');
  const action = createGmailConnectorAction(capability, params, {
    idempotencyKey: context.idempotencyKey || params.idempotencyKey,
    timeoutMs: context.timeoutMs,
    confirmationPolicy: context.confirmationPolicy,
    bindingId: context.bindingId,
    credentialsPath: context.credentialsPath,
    gmailClient: context.gmailClient,
  });
  return await dispatchConnectorAction(action, context);
}
