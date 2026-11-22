import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import http from 'http';
import { dirname } from 'path';

import { resolveCalendarConnectorBinding, ensureCalendarConnectorBinding } from './connector-bindings.mjs';
import { createConnectorActionResult } from './connector-state.mjs';

const DEFAULT_TIMEZONE = 'Asia/Shanghai';
const DEFAULT_CALENDAR_ID = 'primary';
const AUTH_CALLBACK_PORT = 42814;
const AUTH_REDIRECT_URI = `http://127.0.0.1:${AUTH_CALLBACK_PORT}/oauth2callback`;
// The union of scopes across the instance's Google connectors (calendar,
// gmail, drive). One consent grants all three, and the token file written
// here feeds every connector — keep this list in sync with
// connector-google-common.mjs when adding Google services.
const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/drive.file',
];

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeReminderMinutes(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

async function readJson(pathname, fallback = null) {
  try {
    const raw = await fs.readFile(pathname, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJson(pathname, data) {
  await fs.mkdir(dirname(pathname), { recursive: true });
  await fs.writeFile(pathname, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export function buildCalendarEventResource({
  title,
  startTime,
  endTime,
  description,
  location,
  timezone,
  reminderMinutesBefore,
} = {}) {
  const tz = trimString(timezone) || DEFAULT_TIMEZONE;
  const normalizedReminder = normalizeReminderMinutes(reminderMinutesBefore);
  return {
    summary: trimString(title),
    description: trimString(description) || undefined,
    location: trimString(location) || undefined,
    start: { dateTime: new Date(startTime).toISOString(), timeZone: tz },
    end: { dateTime: new Date(endTime).toISOString(), timeZone: tz },
    reminders: normalizedReminder === null
      ? undefined
      : {
          useDefault: false,
          overrides: [{ method: 'popup', minutes: normalizedReminder }],
        },
    extendedProperties: {
      private: { managedBy: 'ragent-connector' },
    },
  };
}

async function loadGoogleApi() {
  const { google } = await import('googleapis');
  const { OAuth2Client } = await import('google-auth-library');
  return { google, OAuth2Client };
}

async function buildAuthenticatedClient(binding, credentialsPath) {
  const tokenPath = trimString(binding?.tokenPath);
  if (!tokenPath) {
    throw new Error('Calendar binding has no token path — authorization is required.');
  }

  const { google, OAuth2Client } = await loadGoogleApi();
  const credentials = await readJson(credentialsPath, null);
  if (!credentials) {
    throw new Error(`Missing Google OAuth credentials file: ${credentialsPath}`);
  }

  const config = credentials.installed || credentials.web || credentials;
  const client = new OAuth2Client(
    config.client_id,
    config.client_secret,
    Array.isArray(config.redirect_uris) ? config.redirect_uris[0] : config.redirect_uri,
  );

  const token = await readJson(tokenPath, null);
  if (!token) {
    throw new Error(`Missing token file: ${tokenPath}. Run the calendar authorization flow first.`);
  }
  client.setCredentials(token);

  return { calendar: google.calendar({ version: 'v3', auth: client }), client };
}

function resolveBindingError(binding) {
  if (!binding) {
    return createConnectorActionResult({
      connectorId: 'calendar',
      capabilityState: 'binding_required',
      deliveryState: 'drafted',
    });
  }
  if (binding.capabilityState === 'binding_required') {
    return createConnectorActionResult({
      connectorId: 'calendar',
      bindingId: binding.id,
      capabilityState: 'binding_required',
      deliveryState: 'drafted',
    });
  }
  if (binding.capabilityState === 'authorization_required') {
    return createConnectorActionResult({
      connectorId: 'calendar',
      bindingId: binding.id,
      capabilityState: 'authorization_required',
      deliveryState: 'drafted',
    });
  }
  return null;
}

export async function generateCalendarAuthUrl({ credentialsPath, redirectUri, state }) {
  const { OAuth2Client } = await loadGoogleApi();
  const credentials = await readJson(credentialsPath, null);
  if (!credentials) {
    throw new Error(`Missing OAuth credentials file: ${credentialsPath}`);
  }
  const config = credentials.installed || credentials.web || credentials;
  const effectiveRedirectUri = trimString(redirectUri) || AUTH_REDIRECT_URI;
  const client = new OAuth2Client(config.client_id, config.client_secret, effectiveRedirectUri);
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    ...(state ? { state } : {}),
  });
}

export async function handleCalendarAuthCallback({ credentialsPath, tokenPath, code, redirectUri }) {
  const { OAuth2Client } = await loadGoogleApi();
  const credentials = await readJson(credentialsPath, null);
  if (!credentials) {
    throw new Error(`Missing OAuth credentials file: ${credentialsPath}`);
  }
  const config = credentials.installed || credentials.web || credentials;
  const effectiveRedirectUri = trimString(redirectUri) || AUTH_REDIRECT_URI;
  const client = new OAuth2Client(config.client_id, config.client_secret, effectiveRedirectUri);
  const { tokens } = await client.getToken(code);
  await writeJson(tokenPath, tokens);
  return tokens;
}

export async function startCalendarAuthServer({ credentialsPath, tokenPath, onAuthUrl }) {
  const authUrl = await generateCalendarAuthUrl({ credentialsPath });
  if (onAuthUrl) onAuthUrl(authUrl);

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://127.0.0.1:${AUTH_CALLBACK_PORT}`);
      if (url.pathname !== '/oauth2callback') {
        res.statusCode = 404;
        res.end('Not found');
        return;
      }
      const authCode = url.searchParams.get('code');
      if (!authCode) {
        res.statusCode = 400;
        res.end('Missing code');
        return;
      }
      res.end('Calendar authorization received. You can close this tab.');
      server.close();
      resolve(authCode);
    });
    server.listen(AUTH_CALLBACK_PORT, '127.0.0.1');
    server.on('error', reject);
  });

  return await handleCalendarAuthCallback({ credentialsPath, tokenPath, code });
}

function buildCalendarError(message, { code = 'CONNECTOR_CALENDAR_ERROR', statusCode = 500, details = null } = {}) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  if (details) err.details = details;
  return err;
}

function assertSafeCalendarId(value, fieldName = 'eventId') {
  const trimmed = trimString(value);
  if (!trimmed || trimmed === '.' || trimmed === '..' || /[\/\\]|\.\.|\0/.test(trimmed)) {
    throw buildCalendarError(`Invalid calendar ${fieldName}.`, {
      code: 'CONNECTOR_INVALID_INPUT',
      statusCode: 400,
    });
  }
  return trimmed;
}

function parseCalendarDate(value, fieldName) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw buildCalendarError(`Invalid calendar ${fieldName}.`, {
      code: 'CONNECTOR_INVALID_INPUT',
      statusCode: 400,
    });
  }
  return parsed;
}

function mapCalendarEventRecord(event = {}) {
  return {
    id: trimString(event.id),
    summary: trimString(event.summary),
    description: trimString(event.description),
    location: trimString(event.location),
    start: event.start?.dateTime || event.start?.date || '',
    end: event.end?.dateTime || event.end?.date || '',
    status: trimString(event.status),
    etag: trimString(event.etag),
    sequence: Number.isInteger(Number(event.sequence)) ? Number(event.sequence) : 0,
    updated: trimString(event.updated),
    htmlLink: trimString(event.htmlLink),
    extendedProperties: event.extendedProperties || null,
  };
}

async function resolveCalendarClient({ bindingId, credentialsPath, calendarId, calendarClient } = {}) {
  const binding = bindingId || !calendarClient ? await resolveCalendarConnectorBinding({ bindingId }) : null;
  if (bindingId || !calendarClient) {
    const bindingError = resolveBindingError(binding);
    if (bindingError) return { error: bindingError, binding, calendar: null, targetCalendarId: '' };
  }
  const effectiveBinding = binding || { id: trimString(bindingId) || 'binding_calendar_mock', calendarId: '', capabilityState: 'ready' };
  const targetCalendarId = trimString(calendarId) || trimString(effectiveBinding.calendarId) || DEFAULT_CALENDAR_ID;
  if (calendarClient) {
    return { error: null, binding: effectiveBinding, calendar: calendarClient, targetCalendarId };
  }
  const { calendar } = await buildAuthenticatedClient(effectiveBinding, credentialsPath);
  return { error: null, binding: effectiveBinding, calendar, targetCalendarId };
}

async function verifyCalendarEventPrecondition(calendar, targetCalendarId, eventId, { expectedEtag, expectedSequence, expectedUpdatedAt, allowCancelled = false } = {}) {
  let response;
  try {
    response = await calendar.events.get({
      calendarId: targetCalendarId,
      eventId,
    });
  } catch (error) {
    if (error?.code === 404 || error?.status === 404 || error?.status === 410 || /not found/i.test(error?.message || '')) {
      throw buildCalendarError(`Calendar event ${eventId} was not found.`, {
        code: 'CONNECTOR_CONFLICT',
        statusCode: 409,
      });
    }
    throw error;
  }
  const current = response?.data;
  if (!current || trimString(current.id) !== eventId) {
    throw buildCalendarError(`Calendar event ${eventId} was not found.`, {
      code: 'CONNECTOR_CONFLICT',
      statusCode: 409,
    });
  }
  if (!allowCancelled && trimString(current.status) === 'cancelled') {
    throw buildCalendarError(`Calendar event ${eventId} is already cancelled.`, {
      code: 'CONNECTOR_CONFLICT',
      statusCode: 409,
    });
  }
  if (expectedEtag !== undefined && trimString(current.etag) !== trimString(expectedEtag)) {
    throw buildCalendarError(
      `Calendar event ${eventId} ETag conflict: expected "${trimString(expectedEtag)}", found "${trimString(current.etag)}".`,
      {
        code: 'CONNECTOR_CONFLICT',
        statusCode: 409,
        details: { expectedEtag: trimString(expectedEtag), actualEtag: trimString(current.etag) },
      },
    );
  }
  if (expectedSequence !== undefined && Number(current.sequence ?? 0) !== Number(expectedSequence)) {
    throw buildCalendarError(
      `Calendar event ${eventId} sequence conflict: expected ${expectedSequence}, found ${Number(current.sequence ?? 0)}.`,
      {
        code: 'CONNECTOR_CONFLICT',
        statusCode: 409,
        details: { expectedSequence: Number(expectedSequence), actualSequence: Number(current.sequence ?? 0) },
      },
    );
  }
  if (expectedUpdatedAt !== undefined && trimString(current.updated) !== trimString(expectedUpdatedAt)) {
    throw buildCalendarError(
      `Calendar event ${eventId} timestamp conflict: expected "${trimString(expectedUpdatedAt)}", found "${trimString(current.updated)}".`,
      {
        code: 'CONNECTOR_CONFLICT',
        statusCode: 409,
        details: { expectedUpdatedAt: trimString(expectedUpdatedAt), actualUpdatedAt: trimString(current.updated) },
      },
    );
  }
  return current;
}

export async function listCalendarEvents({ bindingId, credentialsPath, timeMin, timeMax, calendarId, maxResults = 100, calendarClient } = {}) {
  const { error, binding, calendar, targetCalendarId } = await resolveCalendarClient({ bindingId, credentialsPath, calendarId, calendarClient });
  if (error) return { events: [], error };

  const now = new Date();
  const effectiveTimeMin = timeMin ? parseCalendarDate(timeMin, 'timeMin') : now;
  const effectiveTimeMax = timeMax ? parseCalendarDate(timeMax, 'timeMax') : new Date(now.getTime() + 30 * 86400000);

  const events = [];
  let pageToken;
  do {
    const response = await calendar.events.list({
      calendarId: targetCalendarId,
      singleEvents: true,
      orderBy: 'startTime',
      showDeleted: false,
      maxResults: Math.min(maxResults - events.length, 250),
      pageToken,
      timeMin: effectiveTimeMin.toISOString(),
      timeMax: effectiveTimeMax.toISOString(),
    });
    events.push(...(response.data.items || []));
    pageToken = response.data.nextPageToken;
  } while (pageToken && events.length < maxResults);

  return {
    events: events.map((event) => ({
      id: event.id,
      summary: trimString(event.summary),
      description: trimString(event.description),
      location: trimString(event.location),
      start: event.start?.dateTime || event.start?.date || '',
      end: event.end?.dateTime || event.end?.date || '',
      status: trimString(event.status),
      htmlLink: trimString(event.htmlLink),
    })),
    calendarId: targetCalendarId,
    bindingId: binding.id,
  };
}

export async function getCalendarEvent({ bindingId, credentialsPath, calendarId, eventId, calendarClient } = {}) {
  const safeEventId = assertSafeCalendarId(eventId, 'eventId');
  const { error, binding, calendar, targetCalendarId } = await resolveCalendarClient({ bindingId, credentialsPath, calendarId, calendarClient });
  if (error) return { event: null, error };

  const response = await calendar.events.get({
    calendarId: targetCalendarId,
    eventId: safeEventId,
  });
  return {
    event: mapCalendarEventRecord(response?.data),
    calendarId: targetCalendarId,
    bindingId: binding.id,
  };
}

export async function createCalendarEvent({
  bindingId,
  credentialsPath,
  title,
  startTime,
  endTime,
  description,
  location,
  calendarId,
  timezone,
  reminderMinutesBefore,
  eventId,
  actionDigest,
  calendarClient,
  onBeforeWire,
} = {}) {
  const { error, binding, calendar, targetCalendarId } = await resolveCalendarClient({ bindingId, credentialsPath, calendarId, calendarClient });
  if (error) return error;

  const resource = buildCalendarEventResource({
    title,
    startTime,
    endTime,
    description,
    location,
    timezone,
    reminderMinutesBefore,
  });
  if (eventId && actionDigest) {
    resource.id = assertSafeCalendarId(eventId, 'eventId');
    resource.extendedProperties.private.actionDigest = actionDigest;
  }

  if (typeof onBeforeWire === 'function') await onBeforeWire();
  const result = await calendar.events.insert({
    calendarId: targetCalendarId,
    requestBody: resource,
  });
  const createdId = trimString(result?.data?.id);
  if (!createdId) {
    throw buildCalendarError('Calendar event insert did not return an authoritative event ID.', {
      code: 'CONNECTOR_RECEIPT_MISSING',
      statusCode: 502,
    });
  }

  return createConnectorActionResult({
    connectorId: 'calendar',
    bindingId: binding.id,
    targetId: `event:${createdId}`,
    capabilityState: 'ready',
    deliveryState: 'delivered',
    externalId: createdId,
    message: `Created event "${trimString(title)}" on ${targetCalendarId}`,
  });
}

// A matching provider record is positive evidence. Absence or a failed query is
// not proof that an earlier insert did not take effect.
export async function findCalendarEventReceipt({ bindingId, credentialsPath, calendarId, eventId, actionDigest, calendarClient } = {}) {
  if (!eventId || !actionDigest) return null;
  const { error, binding, calendar, targetCalendarId } = await resolveCalendarClient({ bindingId, credentialsPath, calendarId, calendarClient });
  if (error) return null;
  const result = await calendar.events.get({ calendarId: targetCalendarId, eventId }).catch(() => null);
  const event = result?.data;
  if (event?.id !== eventId || event?.extendedProperties?.private?.actionDigest !== actionDigest || event?.status === 'cancelled') return null;
  return createConnectorActionResult({ connectorId: 'calendar', bindingId: binding.id, targetId: `event:${eventId}`,
    capabilityState: 'ready', deliveryState: 'delivered', externalId: eventId, message: 'Calendar event confirmed by provider query.' });
}

export async function findCalendarMutationReceipt({
  bindingId,
  credentialsPath,
  calendarId,
  eventId,
  mutationDigest = '',
  expectedStatus = '',
  calendarClient,
} = {}) {
  if (!eventId) return null;
  const { error, binding, calendar, targetCalendarId } = await resolveCalendarClient({ bindingId, credentialsPath, calendarId, calendarClient });
  if (error) return null;
  let result;
  try {
    result = await calendar.events.get({ calendarId: targetCalendarId, eventId });
  } catch (err) {
    if (expectedStatus === 'deleted' && (err?.code === 404 || err?.status === 404 || err?.status === 410)) {
      return {
        verified: true,
        externalId: eventId,
        receipt: { id: eventId, status: 'deleted', calendarId: targetCalendarId, bindingId: binding.id },
      };
    }
    return null;
  }
  const event = result?.data;
  if (!event || trimString(event.id) !== eventId) return null;
  if (expectedStatus === 'cancelled') {
    if (trimString(event.status) !== 'cancelled') return null;
    if (mutationDigest && event?.extendedProperties?.private?.mutationDigest && event.extendedProperties.private.mutationDigest !== mutationDigest) {
      return null;
    }
    return { verified: true, externalId: eventId, receipt: mapCalendarEventRecord(event) };
  }
  if (mutationDigest) {
    if (event?.extendedProperties?.private?.mutationDigest !== mutationDigest) return null;
    return { verified: true, externalId: eventId, receipt: mapCalendarEventRecord(event) };
  }
  return null;
}

export async function updateCalendarEvent({
  bindingId,
  credentialsPath,
  eventId,
  title,
  startTime,
  endTime,
  description,
  location,
  calendarId,
  timezone,
  reminderMinutesBefore,
  expectedEtag,
  expectedSequence,
  expectedUpdatedAt,
  requireConflictCheck = false,
  mutationDigest = '',
  calendarClient,
  onBeforeWire,
} = {}) {
  const safeEventId = assertSafeCalendarId(eventId, 'eventId');
  const { error, binding, calendar, targetCalendarId } = await resolveCalendarClient({ bindingId, credentialsPath, calendarId, calendarClient });
  if (error) return error;

  const tz = trimString(timezone) || DEFAULT_TIMEZONE;
  const hasPrecondition = expectedEtag !== undefined || expectedSequence !== undefined || expectedUpdatedAt !== undefined;
  if (requireConflictCheck && !hasPrecondition) {
    throw buildCalendarError('Calendar event update requires expectedEtag, expectedSequence, or expectedUpdatedAt.', {
      code: 'CONNECTOR_CONFLICT_CHECK_REQUIRED',
      statusCode: 400,
    });
  }
  let current = null;
  if (hasPrecondition) {
    current = await verifyCalendarEventPrecondition(calendar, targetCalendarId, safeEventId, {
      expectedEtag,
      expectedSequence,
      expectedUpdatedAt,
    });
  }

  const resource = {};
  if (title !== undefined) resource.summary = trimString(title);
  if (description !== undefined) resource.description = trimString(description);
  if (location !== undefined) resource.location = trimString(location);
  const parsedStart = startTime !== undefined ? parseCalendarDate(startTime, 'startTime') : null;
  const parsedEnd = endTime !== undefined ? parseCalendarDate(endTime, 'endTime') : null;
  if (parsedStart && parsedEnd && parsedEnd.getTime() < parsedStart.getTime()) {
    throw buildCalendarError('Calendar event endTime must not precede startTime.', {
      code: 'CONNECTOR_INVALID_INPUT',
      statusCode: 400,
    });
  }
  if (parsedStart) resource.start = { dateTime: parsedStart.toISOString(), timeZone: tz };
  if (parsedEnd) resource.end = { dateTime: parsedEnd.toISOString(), timeZone: tz };
  if (reminderMinutesBefore !== undefined) {
    const normalizedReminder = normalizeReminderMinutes(reminderMinutesBefore);
    resource.reminders = normalizedReminder === null
      ? { useDefault: true }
      : {
          useDefault: false,
          overrides: [{ method: 'popup', minutes: normalizedReminder }],
        };
  }
  if (mutationDigest) {
    resource.extendedProperties = {
      private: {
        ...(current?.extendedProperties?.private || { managedBy: 'ragent-connector' }),
        mutationDigest,
      },
    };
  }
  if (expectedSequence !== undefined) {
    resource.sequence = Number(current?.sequence ?? expectedSequence) + 1;
  }

  if (typeof onBeforeWire === 'function') await onBeforeWire();
  const result = await calendar.events.patch({
    calendarId: targetCalendarId,
    eventId: safeEventId,
    requestBody: resource,
    ...(expectedEtag !== undefined ? { headers: { 'If-Match': trimString(expectedEtag) } } : {}),
  });
  const updatedId = trimString(result?.data?.id);
  if (!updatedId) {
    throw buildCalendarError('Calendar event update did not return an authoritative event ID.', {
      code: 'CONNECTOR_RECEIPT_MISSING',
      statusCode: 502,
    });
  }

  return createConnectorActionResult({
    connectorId: 'calendar',
    bindingId: binding.id,
    targetId: `event:${updatedId}`,
    capabilityState: 'ready',
    deliveryState: 'delivered',
    externalId: updatedId,
    message: `Updated event "${trimString(result.data.summary)}"`,
  });
}

export async function cancelCalendarEvent({
  bindingId,
  credentialsPath,
  eventId,
  calendarId,
  expectedEtag,
  expectedSequence,
  expectedUpdatedAt,
  requireConflictCheck = true,
  mutationDigest = '',
  calendarClient,
  onBeforeWire,
} = {}) {
  const safeEventId = assertSafeCalendarId(eventId, 'eventId');
  const { error, binding, calendar, targetCalendarId } = await resolveCalendarClient({ bindingId, credentialsPath, calendarId, calendarClient });
  if (error) return error;

  const hasPrecondition = expectedEtag !== undefined || expectedSequence !== undefined || expectedUpdatedAt !== undefined;
  if (requireConflictCheck && !hasPrecondition) {
    throw buildCalendarError('Calendar event cancel requires expectedEtag, expectedSequence, or expectedUpdatedAt.', {
      code: 'CONNECTOR_CONFLICT_CHECK_REQUIRED',
      statusCode: 400,
    });
  }
  let current = null;
  if (hasPrecondition) {
    current = await verifyCalendarEventPrecondition(calendar, targetCalendarId, safeEventId, {
      expectedEtag,
      expectedSequence,
      expectedUpdatedAt,
    });
  }

  const requestBody = {
    status: 'cancelled',
    ...(expectedSequence !== undefined ? { sequence: Number(current?.sequence ?? expectedSequence) + 1 } : {}),
    ...(mutationDigest
      ? {
          extendedProperties: {
            private: {
              ...(current?.extendedProperties?.private || { managedBy: 'ragent-connector' }),
              mutationDigest,
            },
          },
        }
      : {}),
  };

  if (typeof onBeforeWire === 'function') await onBeforeWire();
  const result = await calendar.events.patch({
    calendarId: targetCalendarId,
    eventId: safeEventId,
    requestBody,
    ...(expectedEtag !== undefined ? { headers: { 'If-Match': trimString(expectedEtag) } } : {}),
  });
  const cancelledId = trimString(result?.data?.id) || safeEventId;
  if (trimString(result?.data?.status) !== 'cancelled') {
    throw buildCalendarError('Calendar event cancel did not confirm cancelled status.', {
      code: 'CONNECTOR_RECEIPT_MISSING',
      statusCode: 502,
    });
  }
  return createConnectorActionResult({
    connectorId: 'calendar',
    bindingId: binding.id,
    targetId: `event:${cancelledId}`,
    capabilityState: 'ready',
    deliveryState: 'cancelled',
    externalId: cancelledId,
    message: `Cancelled event ${cancelledId}`,
  });
}

export async function deleteCalendarEvent({
  bindingId,
  credentialsPath,
  eventId,
  calendarId,
  expectedEtag,
  expectedSequence,
  expectedUpdatedAt,
  requireConflictCheck = false,
  calendarClient,
  onBeforeWire,
} = {}) {
  const safeEventId = assertSafeCalendarId(eventId, 'eventId');
  const { error, binding, calendar, targetCalendarId } = await resolveCalendarClient({ bindingId, credentialsPath, calendarId, calendarClient });
  if (error) return error;

  const hasPrecondition = expectedEtag !== undefined || expectedSequence !== undefined || expectedUpdatedAt !== undefined;
  if (requireConflictCheck && !hasPrecondition) {
    throw buildCalendarError('Calendar event delete requires expectedEtag, expectedSequence, or expectedUpdatedAt.', {
      code: 'CONNECTOR_CONFLICT_CHECK_REQUIRED',
      statusCode: 400,
    });
  }
  if (hasPrecondition) {
    await verifyCalendarEventPrecondition(calendar, targetCalendarId, safeEventId, {
      expectedEtag,
      expectedSequence,
      expectedUpdatedAt,
      allowCancelled: true,
    });
  }

  if (typeof onBeforeWire === 'function') await onBeforeWire();
  await calendar.events.delete({
    calendarId: targetCalendarId,
    eventId: safeEventId,
  });

  return createConnectorActionResult({
    connectorId: 'calendar',
    bindingId: binding.id,
    targetId: `event:${safeEventId}`,
    capabilityState: 'ready',
    deliveryState: 'delivered',
    externalId: safeEventId,
    message: `Deleted event ${safeEventId}`,
  });
}

export const CALENDAR_ACTION_CONTRACTS = Object.freeze({
  'calendar.event.list': Object.freeze({
    capability: 'calendar.event.list',
    connectorId: 'calendar',
    actionClass: 'read',
    riskLevel: 'read',
    confirmationPolicy: 'auto_within_policy',
    timeoutMs: 15_000,
    receiptVerifier: Object.freeze({
      kind: 'none_readonly',
      supported: false,
      description: 'Read-only calendar event list requires no mutation receipt.',
    }),
    compensation: Object.freeze({
      supported: false,
      mode: 'none_readonly',
      description: 'Read-only action has no side effects to compensate.',
    }),
  }),
  'calendar.event.get': Object.freeze({
    capability: 'calendar.event.get',
    connectorId: 'calendar',
    actionClass: 'read',
    riskLevel: 'read',
    confirmationPolicy: 'auto_within_policy',
    timeoutMs: 15_000,
    receiptVerifier: Object.freeze({
      kind: 'none_readonly',
      supported: false,
      description: 'Read-only calendar event fetch requires no mutation receipt.',
    }),
    compensation: Object.freeze({
      supported: false,
      mode: 'none_readonly',
      description: 'Read-only action has no side effects to compensate.',
    }),
  }),
  'calendar.event.create': Object.freeze({
    capability: 'calendar.event.create',
    connectorId: 'calendar',
    actionClass: 'write',
    riskLevel: 'reversible_write',
    confirmationPolicy: 'require_approval',
    timeoutMs: 20_000,
    receiptVerifier: Object.freeze({
      kind: 'provider_lookup',
      supported: true,
      description: 'Verify created calendar event by deterministic eventId and extendedProperties.private.actionDigest.',
    }),
    compensation: Object.freeze({
      supported: true,
      mode: 'compensating_action',
      compensatingCapability: 'calendar.event.cancel',
      description: 'Cancel the created calendar event using its eventId and latest etag/sequence.',
    }),
  }),
  'calendar.event.update': Object.freeze({
    capability: 'calendar.event.update',
    connectorId: 'calendar',
    actionClass: 'write',
    riskLevel: 'reversible_write',
    confirmationPolicy: 'require_approval',
    timeoutMs: 20_000,
    receiptVerifier: Object.freeze({
      kind: 'provider_lookup',
      supported: true,
      description: 'Verify updated calendar event via events.get matching extendedProperties.private.mutationDigest.',
    }),
    compensation: Object.freeze({
      supported: true,
      mode: 'compensating_action',
      compensatingCapability: 'calendar.event.update',
      description: 'Patch calendar event back to prior summary/time/location using latest etag/sequence.',
    }),
  }),
  'calendar.event.cancel': Object.freeze({
    capability: 'calendar.event.cancel',
    connectorId: 'calendar',
    actionClass: 'write',
    riskLevel: 'reversible_write',
    confirmationPolicy: 'require_approval',
    timeoutMs: 20_000,
    receiptVerifier: Object.freeze({
      kind: 'provider_lookup',
      supported: true,
      description: 'Verify calendar event status === "cancelled" via events.get.',
    }),
    compensation: Object.freeze({
      supported: true,
      mode: 'compensating_action',
      compensatingCapability: 'calendar.event.create',
      description: 'Recreate calendar event if cancellation needs reversal.',
    }),
  }),
  'calendar.event.delete': Object.freeze({
    capability: 'calendar.event.delete',
    connectorId: 'calendar',
    actionClass: 'broadcast',
    riskLevel: 'irreversible_write',
    confirmationPolicy: 'require_approval',
    timeoutMs: 20_000,
    receiptVerifier: Object.freeze({
      kind: 'provider_lookup',
      supported: true,
      description: 'Verify calendar event absence (404/410) via events.get.',
    }),
    compensation: Object.freeze({
      supported: false,
      mode: 'irreversible',
      description: 'Hard-deleted calendar events cannot be automatically restored with original sequence history.',
    }),
  }),
});

export function createCalendarConnectorAction(capability, params = {}, options = {}) {
  const template = CALENDAR_ACTION_CONTRACTS[capability];
  if (!template) {
    throw buildCalendarError(`Unknown Calendar connector capability: ${capability}`, {
      code: 'CONNECTOR_UNSUPPORTED_CAPABILITY',
      statusCode: 400,
    });
  }
  const idempotencyKey = trimString(options.idempotencyKey || params.idempotencyKey);
  const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : template.timeoutMs;
  const confirmationPolicy = trimString(options.confirmationPolicy) || template.confirmationPolicy;
  const bindingId = trimString(params.bindingId || options.bindingId);
  const credentialsPath = trimString(params.credentialsPath || options.credentialsPath);
  const calendarId = trimString(params.calendarId) || DEFAULT_CALENDAR_ID;
  const calendarClient = params.calendarClient || options.calendarClient;

  if (capability === 'calendar.event.list') {
    const scope = {
      connectorId: 'calendar',
      calendarId,
      resource: `calendar:${calendarId}`,
      ...(bindingId ? { bindingId } : {}),
    };
    return {
      contract: { ...template, idempotencyKey, confirmationPolicy, timeoutMs, scope },
      payload: { calendarId, timeMin: params.timeMin || null, timeMax: params.timeMax || null, maxResults: params.maxResults ?? 100 },
      execute: async (ctx = {}) => await listCalendarEvents({
        bindingId,
        credentialsPath,
        calendarId,
        timeMin: params.timeMin,
        timeMax: params.timeMax,
        maxResults: params.maxResults ?? 100,
        calendarClient: ctx.calendarClient || calendarClient,
      }),
    };
  }

  if (capability === 'calendar.event.get') {
    const eventId = assertSafeCalendarId(params.eventId, 'eventId');
    const scope = {
      connectorId: 'calendar',
      calendarId,
      eventId,
      resource: `calendar:${calendarId}/event:${eventId}`,
      ...(bindingId ? { bindingId } : {}),
    };
    return {
      contract: { ...template, idempotencyKey, confirmationPolicy, timeoutMs, scope },
      payload: { calendarId, eventId },
      execute: async (ctx = {}) => await getCalendarEvent({
        bindingId,
        credentialsPath,
        calendarId,
        eventId,
        calendarClient: ctx.calendarClient || calendarClient,
      }),
    };
  }

  if (capability === 'calendar.event.create') {
    const title = trimString(params.title);
    if (!title) {
      throw buildCalendarError('Calendar event title is required.', { code: 'CONNECTOR_INVALID_INPUT', statusCode: 400 });
    }
    const start = parseCalendarDate(params.startTime, 'startTime');
    const end = parseCalendarDate(params.endTime, 'endTime');
    if (end.getTime() < start.getTime()) {
      throw buildCalendarError('Calendar event endTime must not precede startTime.', { code: 'CONNECTOR_INVALID_INPUT', statusCode: 400 });
    }
    // Google Calendar base32hex-compatible deterministic ID (hex is a valid subset of [a-v0-9])
    const deterministicEventId = trimString(params.eventId)
      ? assertSafeCalendarId(params.eventId, 'eventId')
      : createHash('sha256').update(`ragent-cal:${idempotencyKey || `${calendarId}:${title}:${start.toISOString()}`}`).digest('hex');
    const actionDigest = createHash('sha256')
      .update(JSON.stringify({ calendarId, title, startTime: start.toISOString(), endTime: end.toISOString(), idempotencyKey }))
      .digest('hex');
    const scope = {
      connectorId: 'calendar',
      calendarId,
      eventId: deterministicEventId,
      resource: `calendar:${calendarId}/event:${deterministicEventId}`,
      ...(bindingId ? { bindingId } : {}),
    };
    const receiptVerifier = {
      ...template.receiptVerifier,
      verify: async (ctx = {}) => {
        const found = await findCalendarEventReceipt({
          bindingId,
          credentialsPath,
          calendarId,
          eventId: deterministicEventId,
          actionDigest,
          calendarClient: ctx.calendarClient || calendarClient,
        });
        return found ? { verified: true, externalId: deterministicEventId, receipt: found } : null;
      },
    };
    return {
      contract: { ...template, idempotencyKey, confirmationPolicy, timeoutMs, scope, receiptVerifier },
      payload: {
        calendarId,
        eventId: deterministicEventId,
        title,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        description: trimString(params.description),
        location: trimString(params.location),
        timezone: trimString(params.timezone) || DEFAULT_TIMEZONE,
        reminderMinutesBefore: params.reminderMinutesBefore ?? null,
      },
      execute: async (ctx = {}) => await createCalendarEvent({
        bindingId,
        credentialsPath,
        calendarId,
        title,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        description: params.description,
        location: params.location,
        timezone: params.timezone,
        reminderMinutesBefore: params.reminderMinutesBefore,
        eventId: deterministicEventId,
        actionDigest,
        calendarClient: ctx.calendarClient || calendarClient,
        onBeforeWire: ctx.onBeforeWire,
      }),
    };
  }

  const eventId = assertSafeCalendarId(params.eventId, 'eventId');
  const hasPrecondition = params.expectedEtag !== undefined || params.expectedSequence !== undefined || params.expectedUpdatedAt !== undefined;
  const mutationDigest = createHash('sha256')
    .update(JSON.stringify({ capability, calendarId, eventId, idempotencyKey }))
    .digest('hex');
  const scope = {
    connectorId: 'calendar',
    calendarId,
    eventId,
    resource: `calendar:${calendarId}/event:${eventId}`,
    ...(bindingId ? { bindingId } : {}),
  };

  if (capability === 'calendar.event.update') {
    const receiptVerifier = {
      ...template.receiptVerifier,
      verify: async (ctx = {}) => await findCalendarMutationReceipt({
        bindingId,
        credentialsPath,
        calendarId,
        eventId,
        mutationDigest,
        calendarClient: ctx.calendarClient || calendarClient,
      }),
    };
    return {
      contract: { ...template, idempotencyKey, confirmationPolicy, timeoutMs, scope, receiptVerifier },
      payload: {
        calendarId,
        eventId,
        ...(params.title !== undefined ? { title: params.title } : {}),
        ...(params.startTime !== undefined ? { startTime: params.startTime } : {}),
        ...(params.endTime !== undefined ? { endTime: params.endTime } : {}),
        ...(params.description !== undefined ? { description: params.description } : {}),
        ...(params.location !== undefined ? { location: params.location } : {}),
        ...(params.timezone !== undefined ? { timezone: params.timezone } : {}),
        ...(params.reminderMinutesBefore !== undefined ? { reminderMinutesBefore: params.reminderMinutesBefore } : {}),
        expectedEtag: params.expectedEtag ?? null,
        expectedSequence: params.expectedSequence ?? null,
        expectedUpdatedAt: params.expectedUpdatedAt ?? null,
      },
      precheck: async (ctx = {}) => {
        if (!hasPrecondition) {
          throw buildCalendarError('Calendar event update requires expectedEtag, expectedSequence, or expectedUpdatedAt.', {
            code: 'CONNECTOR_CONFLICT_CHECK_REQUIRED',
            statusCode: 400,
          });
        }
        const resolved = await resolveCalendarClient({
          bindingId,
          credentialsPath,
          calendarId,
          calendarClient: ctx.calendarClient || calendarClient,
        });
        if (resolved.error) {
          throw buildCalendarError(resolved.error.message || 'Calendar binding error', { code: 'CONNECTOR_BINDING_ERROR', statusCode: 409 });
        }
        const current = await verifyCalendarEventPrecondition(resolved.calendar, resolved.targetCalendarId, eventId, {
          expectedEtag: params.expectedEtag,
          expectedSequence: params.expectedSequence,
          expectedUpdatedAt: params.expectedUpdatedAt,
        });
        return { ok: true, current };
      },
      execute: async (ctx = {}) => await updateCalendarEvent({
        bindingId,
        credentialsPath,
        calendarId,
        eventId,
        title: params.title,
        startTime: params.startTime,
        endTime: params.endTime,
        description: params.description,
        location: params.location,
        timezone: params.timezone,
        reminderMinutesBefore: params.reminderMinutesBefore,
        expectedEtag: params.expectedEtag,
        expectedSequence: params.expectedSequence,
        expectedUpdatedAt: params.expectedUpdatedAt,
        requireConflictCheck: true,
        mutationDigest,
        calendarClient: ctx.calendarClient || calendarClient,
        onBeforeWire: ctx.onBeforeWire,
      }),
    };
  }

  if (capability === 'calendar.event.cancel' || capability === 'calendar.event.delete') {
    const isDelete = capability === 'calendar.event.delete';
    const receiptVerifier = {
      ...template.receiptVerifier,
      verify: async (ctx = {}) => await findCalendarMutationReceipt({
        bindingId,
        credentialsPath,
        calendarId,
        eventId,
        mutationDigest: isDelete ? '' : mutationDigest,
        expectedStatus: isDelete ? 'deleted' : 'cancelled',
        calendarClient: ctx.calendarClient || calendarClient,
      }),
    };
    return {
      contract: { ...template, idempotencyKey, confirmationPolicy, timeoutMs, scope, receiptVerifier },
      payload: {
        calendarId,
        eventId,
        expectedEtag: params.expectedEtag ?? null,
        expectedSequence: params.expectedSequence ?? null,
        expectedUpdatedAt: params.expectedUpdatedAt ?? null,
      },
      precheck: async (ctx = {}) => {
        if (!hasPrecondition) {
          throw buildCalendarError(`Calendar event ${isDelete ? 'delete' : 'cancel'} requires expectedEtag, expectedSequence, or expectedUpdatedAt.`, {
            code: 'CONNECTOR_CONFLICT_CHECK_REQUIRED',
            statusCode: 400,
          });
        }
        const resolved = await resolveCalendarClient({
          bindingId,
          credentialsPath,
          calendarId,
          calendarClient: ctx.calendarClient || calendarClient,
        });
        if (resolved.error) {
          throw buildCalendarError(resolved.error.message || 'Calendar binding error', { code: 'CONNECTOR_BINDING_ERROR', statusCode: 409 });
        }
        const current = await verifyCalendarEventPrecondition(resolved.calendar, resolved.targetCalendarId, eventId, {
          expectedEtag: params.expectedEtag,
          expectedSequence: params.expectedSequence,
          expectedUpdatedAt: params.expectedUpdatedAt,
          allowCancelled: isDelete,
        });
        return { ok: true, current };
      },
      execute: async (ctx = {}) => isDelete
        ? await deleteCalendarEvent({
            bindingId,
            credentialsPath,
            calendarId,
            eventId,
            expectedEtag: params.expectedEtag,
            expectedSequence: params.expectedSequence,
            expectedUpdatedAt: params.expectedUpdatedAt,
            requireConflictCheck: true,
            calendarClient: ctx.calendarClient || calendarClient,
            onBeforeWire: ctx.onBeforeWire,
          })
        : await cancelCalendarEvent({
            bindingId,
            credentialsPath,
            calendarId,
            eventId,
            expectedEtag: params.expectedEtag,
            expectedSequence: params.expectedSequence,
            expectedUpdatedAt: params.expectedUpdatedAt,
            requireConflictCheck: true,
            mutationDigest,
            calendarClient: ctx.calendarClient || calendarClient,
            onBeforeWire: ctx.onBeforeWire,
          }),
    };
  }

  throw buildCalendarError(`Unsupported Calendar connector capability: ${capability}`, {
    code: 'CONNECTOR_UNSUPPORTED_CAPABILITY',
    statusCode: 400,
  });
}

export async function executeCalendarConnectorAction(capability, params = {}, context = {}) {
  const { dispatchConnectorAction } = await import('./connector-action-dispatcher.mjs');
  const action = createCalendarConnectorAction(capability, params, {
    idempotencyKey: context.idempotencyKey || params.idempotencyKey,
    timeoutMs: context.timeoutMs,
    confirmationPolicy: context.confirmationPolicy,
    bindingId: context.bindingId,
    credentialsPath: context.credentialsPath,
    calendarClient: context.calendarClient,
  });
  return await dispatchConnectorAction(action, context);
}
