import { randomBytes } from 'crypto';
import { openDatabase as openCollaborationDatabase } from './collaboration-store.mjs';
import { createSerialTaskQueue } from './fs-utils.mjs';

// Shared Swarm / Organization Board persistence layer (Phase 2 — Wave 2A).
// All six tables live in collaborations.sqlite alongside organizations and
// organization_nodes so posting a message, advancing the sender's cursor, and
// creating/coalescing @mention wakeups commit atomically in one SQLite
// transaction.

const MAX_BOARD_BODY_CHARS = 8000;
const MAX_CHANNEL_TOPIC_CHARS = 240;
const MAX_READ_LIMIT = 200;
const MAX_CHANNELS_PER_ORG = 128;
const MAX_ARTIFACT_REFS = 32;

const runBoardStoreMutation = createSerialTaskQueue();

function nowIso(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function encodeJson(value, fallback = null) {
  try {
    return JSON.stringify(value ?? fallback);
  } catch {
    return JSON.stringify(fallback);
  }
}

function parseJson(value, fallback = null) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function boardError(code, message, statusCode = 400, details = {}) {
  return Object.assign(new Error(message), { code, statusCode, ...details });
}

function isDbHandle(value) {
  return Boolean(value && typeof value.prepare === 'function' && typeof value.exec === 'function');
}

function splitDbAndOptions(firstArg, secondArg) {
  if (isDbHandle(firstArg)) {
    return { db: firstArg, options: secondArg && typeof secondArg === 'object' ? secondArg : {} };
  }
  const fallback = secondArg && typeof secondArg === 'object' ? secondArg : {};
  return { db: null, options: firstArg && typeof firstArg === 'object' ? firstArg : fallback };
}

function openStandaloneBoardDb() {
  const db = openCollaborationDatabase();
  ensureOrganizationBoardSchema(db);
  return db;
}

async function withBoardDb(explicitDb, fn, { mutate = false } = {}) {
  if (isDbHandle(explicitDb)) {
    ensureOrganizationBoardSchema(explicitDb);
    return fn(explicitDb);
  }
  const run = async () => {
    const db = openStandaloneBoardDb();
    try {
      return await fn(db);
    } finally {
      db.close();
    }
  };
  return mutate ? runBoardStoreMutation(run) : run();
}

function runBoardTx(conn, fn) {
  const nested = Boolean(conn?.isTransaction);
  const savepoint = nested ? `sp_board_${randomBytes(6).toString('hex')}` : '';
  conn.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
  try {
    const result = fn();
    conn.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT');
    return result;
  } catch (error) {
    try {
      conn.exec(nested ? `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}` : 'ROLLBACK');
    } catch {}
    throw error;
  }
}

export function normalizeBoardChannelName(value, { allowEmpty = false } = {}) {
  const raw = trimString(value).replace(/^#/, '').toLowerCase();
  if (!raw) return allowEmpty ? '' : 'main';
  const cleaned = raw.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  if (!cleaned) return allowEmpty ? '' : 'main';
  return cleaned;
}

function normalizeArtifactRefs(refs) {
  if (!Array.isArray(refs)) return [];
  const normalized = [];
  for (const entry of refs.slice(0, MAX_ARTIFACT_REFS)) {
    if (typeof entry === 'string') {
      const refId = trimString(entry).slice(0, 200);
      if (refId) normalized.push({ id: refId });
      continue;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const refId = trimString(entry.id || entry.packetId || entry.artifactId || entry.path).slice(0, 200);
    if (!refId) continue;
    normalized.push({
      id: refId,
      ...(trimString(entry.kind) ? { kind: trimString(entry.kind).slice(0, 64) } : {}),
      ...(trimString(entry.title) ? { title: trimString(entry.title).slice(0, 160) } : {}),
      ...(trimString(entry.packetId) ? { packetId: trimString(entry.packetId).slice(0, 160) } : {}),
      ...(trimString(entry.path) ? { path: trimString(entry.path).slice(0, 320) } : {}),
    });
  }
  return normalized;
}

function isUniqueConstraintError(error) {
  return Boolean(error && typeof error.message === 'string' && error.message.includes('UNIQUE constraint failed'));
}

export function ensureOrganizationBoardSchema(db) {
  if (!isDbHandle(db)) throw boardError('EINVAL', 'SQLite DatabaseSync handle is required');
  db.exec(`
    CREATE TABLE IF NOT EXISTS organization_board_channels (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      topic TEXT NOT NULL DEFAULT '',
      visibility TEXT NOT NULL DEFAULT 'org',
      state TEXT NOT NULL DEFAULT 'active',
      created_by_node_id TEXT,
      created_at TEXT NOT NULL,
      archived_at TEXT,
      UNIQUE(organization_id, name)
    );
    CREATE TABLE IF NOT EXISTS organization_board_channel_subscriptions (
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      channel_name TEXT NOT NULL,
      node_id TEXT NOT NULL REFERENCES organization_nodes(id) ON DELETE CASCADE,
      subscribed_at TEXT NOT NULL,
      PRIMARY KEY(organization_id, channel_name, node_id)
    );
    CREATE TABLE IF NOT EXISTS organization_board_messages (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      channel_name TEXT NOT NULL,
      sender_kind TEXT NOT NULL,
      sender_node_id TEXT,
      sender_name TEXT NOT NULL,
      body_markdown TEXT NOT NULL,
      mentions_json TEXT NOT NULL DEFAULT '[]',
      reply_to_seq INTEGER,
      artifact_refs_json TEXT NOT NULL DEFAULT '[]',
      kind TEXT NOT NULL DEFAULT 'message',
      is_done_signal INTEGER NOT NULL DEFAULT 0,
      is_stall_alert INTEGER NOT NULL DEFAULT 0,
      idempotency_key TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(organization_id, seq)
    );
    CREATE TABLE IF NOT EXISTS organization_board_cursors (
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      reader_id TEXT NOT NULL,
      channel_name TEXT NOT NULL,
      last_read_seq INTEGER NOT NULL DEFAULT 0,
      last_notified_seq INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(organization_id, reader_id, channel_name)
    );
    CREATE TABLE IF NOT EXISTS organization_board_wakeups (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      target_node_id TEXT NOT NULL REFERENCES organization_nodes(id) ON DELETE CASCADE,
      channel_name TEXT NOT NULL,
      trigger_seq INTEGER NOT NULL,
      latest_seq INTEGER NOT NULL,
      reason TEXT NOT NULL,
      mentions_json TEXT NOT NULL DEFAULT '[]',
      coalesced_count INTEGER NOT NULL DEFAULT 1,
      state TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      delivered_at TEXT
    );
    CREATE TABLE IF NOT EXISTS organization_swarm_stall_alerts (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      dedupe_key TEXT NOT NULL,
      condition_kind TEXT NOT NULL,
      target_role TEXT NOT NULL,
      target_node_id TEXT,
      board_seq INTEGER,
      details_json TEXT NOT NULL DEFAULT '{}',
      alert_count INTEGER NOT NULL DEFAULT 1,
      state TEXT NOT NULL DEFAULT 'active',
      last_alert_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      UNIQUE(organization_id, dedupe_key)
    );
    CREATE INDEX IF NOT EXISTS idx_board_channels_org ON organization_board_channels(organization_id, state, name);
    CREATE INDEX IF NOT EXISTS idx_board_msgs_org_seq ON organization_board_messages(organization_id, seq);
    CREATE INDEX IF NOT EXISTS idx_board_msgs_org_chan_seq ON organization_board_messages(organization_id, channel_name, seq);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_board_msgs_idem
      ON organization_board_messages(organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_board_wakeups_active
      ON organization_board_wakeups(organization_id, target_node_id) WHERE state IN ('pending', 'deferred');
    CREATE INDEX IF NOT EXISTS idx_board_wakeups_org_state
      ON organization_board_wakeups(organization_id, state, created_at);
    CREATE INDEX IF NOT EXISTS idx_swarm_stalls_org_state
      ON organization_swarm_stall_alerts(organization_id, state, last_alert_at);
  `);
}

export function parseBoardMentions(content, { extraMentions = [] } = {}) {
  const source = typeof content === 'string' ? content : '';
  const mentions = [];
  const seen = new Set();
  const memberTargets = [];
  const memberSeen = new Set();
  const channelTargets = [];
  const channelSeen = new Set();
  let mentionAll = false;

  const pushToken = (rawToken) => {
    const token = trimString(rawToken);
    if (!token) return;
    const normalized = token.startsWith('@') ? token : `@${token}`;
    const lowerToken = normalized.toLowerCase();
    if (!seen.has(lowerToken) && mentions.length < 32) {
      seen.add(lowerToken);
      mentions.push(normalized);
    }
    const target = lowerToken.slice(1);
    if (target === 'all') {
      mentionAll = true;
      return;
    }
    if (target.startsWith('#')) {
      const ch = normalizeBoardChannelName(target.slice(1), { allowEmpty: true });
      if (ch && !channelSeen.has(ch)) {
        channelSeen.add(ch);
        channelTargets.push(ch);
      }
      return;
    }
    if (target && !memberSeen.has(target)) {
      memberSeen.add(target);
      memberTargets.push(target);
    }
  };

  // Match @name, @#channel, or @all only when preceded by start-of-string or
  // whitespace/punctuation so email addresses like user@example.com are ignored.
  const mentionPattern = /(?:^|[\s([{"'])@(#?[A-Za-z0-9][A-Za-z0-9._-]{0,63}|all)(?=$|[\s.,:;!?)\]}"'])/g;
  let match;
  while ((match = mentionPattern.exec(source)) !== null) {
    pushToken(`@${match[1]}`);
  }
  for (const extra of Array.isArray(extraMentions) ? extraMentions : []) {
    pushToken(extra);
  }

  const replySeqs = [];
  const seqSeen = new Set();
  const seqPattern = /(?:^|[\s([{"'])#(\d{1,7})\b/g;
  while ((match = seqPattern.exec(source)) !== null) {
    const seq = Number(match[1]);
    if (Number.isInteger(seq) && seq > 0 && !seqSeen.has(seq)) {
      seqSeen.add(seq);
      replySeqs.push(seq);
    }
  }

  const hasDoneMarker = /\[\s*done\s*\]/i.test(source);
  return {
    mentions,
    memberTargets,
    channelTargets,
    mentionAll,
    replyToSeq: replySeqs[0] ?? null,
    replySeqs,
    isDoneSignal: hasDoneMarker,
    hasMentions: mentions.length > 0,
    isWholeSwarmDoneSignal: hasDoneMarker && mentions.length === 0,
    isStallAlert: /\[\s*stall\s*\]/i.test(source),
  };
}

function requireOrganizationRow(db, organizationId) {
  const orgId = trimString(organizationId);
  if (!orgId) throw boardError('BAD_REQUEST', 'organizationId is required', 400);
  const row = db.prepare('SELECT * FROM organizations WHERE id = ?').get(orgId);
  if (!row) throw boardError('ORGANIZATION_NOT_FOUND', `organization ${orgId} not found`, 404);
  return row;
}

function ensureChannelRow(db, organizationId, channelName = 'main', {
  topic = '',
  createdByNodeId = '',
} = {}) {
  const name = normalizeBoardChannelName(channelName);
  const existing = db.prepare(
    'SELECT * FROM organization_board_channels WHERE organization_id = ? AND name = ?',
  ).get(organizationId, name);
  if (existing) return existing;
  const timestamp = nowIso();
  const channelId = makeId('bchan');
  db.prepare(`INSERT INTO organization_board_channels
    (id, organization_id, name, topic, visibility, state, created_by_node_id, created_at)
    VALUES (?, ?, ?, ?, 'org', 'active', ?, ?)`)
    .run(channelId, organizationId, name, trimString(topic).slice(0, MAX_CHANNEL_TOPIC_CHARS), createdByNodeId || null, timestamp);
  return db.prepare('SELECT * FROM organization_board_channels WHERE id = ?').get(channelId);
}

function rowChannel(row, stats = null, subscribers = null) {
  if (!row) return null;
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    topic: row.topic || '',
    visibility: row.visibility || 'org',
    state: row.state || 'active',
    createdByNodeId: row.created_by_node_id || '',
    createdAt: row.created_at,
    archivedAt: row.archived_at || null,
    messageCount: Number(stats?.messageCount ?? 0),
    latestSeq: Number(stats?.latestSeq ?? 0),
    ...(stats && Object.hasOwn(stats, 'unreadCount') ? { unreadCount: Number(stats.unreadCount || 0) } : {}),
    ...(Array.isArray(subscribers) ? { subscribers } : {}),
  };
}

function rowMessage(row, nodeLookup = null) {
  if (!row) return null;
  const node = row.sender_node_id && nodeLookup ? nodeLookup.get(row.sender_node_id) : null;
  const mentions = parseJson(row.mentions_json, []);
  const artifactRefs = parseJson(row.artifact_refs_json, []);
  return {
    id: row.id,
    organizationId: row.organization_id,
    seq: Number(row.seq),
    channel: row.channel_name,
    senderKind: row.sender_kind,
    senderNodeId: row.sender_node_id || null,
    sender: row.sender_name,
    senderName: row.sender_name,
    ...(node ? { senderRole: node.nodeRole || '', senderHarness: node.harness || '' } : {}),
    kind: row.kind || 'message',
    text: row.body_markdown,
    bodyMarkdown: row.body_markdown,
    mentions: Array.isArray(mentions) ? mentions : [],
    replyToSeq: row.reply_to_seq ?? null,
    artifactRefs: Array.isArray(artifactRefs) ? artifactRefs : [],
    isDoneSignal: Boolean(row.is_done_signal),
    isStallAlert: Boolean(row.is_stall_alert),
    idempotencyKey: row.idempotency_key || '',
    createdAt: row.created_at,
  };
}

function rowWakeup(row) {
  if (!row) return null;
  return {
    id: row.id,
    organizationId: row.organization_id,
    targetNodeId: row.target_node_id,
    channel: row.channel_name,
    triggerSeq: Number(row.trigger_seq),
    latestSeq: Number(row.latest_seq),
    reason: row.reason,
    mentions: parseJson(row.mentions_json, []),
    coalescedCount: Number(row.coalesced_count || 1),
    state: row.state,
    attempts: Number(row.attempts || 0),
    lastError: row.last_error || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveredAt: row.delivered_at || null,
  };
}

function buildNodeAliasMap(db, organizationId) {
  const rows = db.prepare(`
    SELECT n.*, r.role AS role_name
    FROM organization_nodes n
    LEFT JOIN role_instances r ON r.id = n.role_instance_id
    WHERE n.organization_id = ?
  `).all(organizationId);
  const byId = new Map();
  const byAlias = new Map();
  const registerAlias = (alias, node) => {
    const key = trimString(alias).toLowerCase();
    if (!key) return;
    const list = byAlias.get(key) || [];
    if (!list.some((item) => item.id === node.id)) list.push(node);
    byAlias.set(key, list);
  };
  for (const row of rows) {
    const grant = parseJson(row.grant_json, {});
    const node = {
      id: row.id,
      stableKey: row.stable_key,
      nodeRole: row.node_role,
      lifecycleState: row.lifecycle_state,
      retiredRevision: row.retired_revision,
      swarmState: row.swarm_state || '',
      roleName: row.role_name || '',
      harness: trimString(grant?.runtimePolicy?.tool || grant?.runtime?.tool || grant?.harness),
      grant,
    };
    byId.set(node.id, node);
    const isAlive = node.lifecycleState === 'active'
      && node.retiredRevision === null
      && node.swarmState !== 'killed';
    if (!isAlive) continue;
    registerAlias(node.id, node);
    registerAlias(node.stableKey, node);
    if (grant?.swarmName) registerAlias(grant.swarmName, node);
    if (node.nodeRole === 'root_leadership') registerAlias('coordinator', node);
    if (node.roleName) registerAlias(node.roleName, node);
  }
  return { byId, byAlias };
}

function isNodeEligibleForWakeup(node) {
  if (!node) return false;
  return node.lifecycleState === 'active'
    && node.retiredRevision === null
    && node.swarmState !== 'killed';
}

function upsertBoardWakeup(db, {
  organizationId,
  targetNodeId,
  channelName,
  seq,
  reason,
  mentions = [],
  timestamp,
}) {
  const existing = db.prepare(
    "SELECT * FROM organization_board_wakeups WHERE organization_id = ? AND target_node_id = ? AND state IN ('pending', 'deferred')",
  ).get(organizationId, targetNodeId);
  if (existing) {
    const mergedMentions = [...new Set([...parseJson(existing.mentions_json, []), ...mentions])].slice(0, 32);
    db.prepare(`UPDATE organization_board_wakeups
      SET channel_name = ?, latest_seq = MAX(latest_seq, ?), reason = CASE WHEN reason = 'stall' THEN reason ELSE ? END,
          mentions_json = ?, coalesced_count = coalesced_count + 1, updated_at = ?
      WHERE id = ?`)
      .run(channelName, seq, reason, encodeJson(mergedMentions, []), timestamp, existing.id);
    return rowWakeup(db.prepare('SELECT * FROM organization_board_wakeups WHERE id = ?').get(existing.id));
  }
  const wakeupId = makeId('bwake');
  db.prepare(`INSERT INTO organization_board_wakeups
    (id, organization_id, target_node_id, channel_name, trigger_seq, latest_seq, reason, mentions_json, coalesced_count, state, attempts, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'pending', 0, ?, ?)`)
    .run(wakeupId, organizationId, targetNodeId, channelName, seq, seq, reason, encodeJson(mentions, []), timestamp, timestamp);
  return rowWakeup(db.prepare('SELECT * FROM organization_board_wakeups WHERE id = ?').get(wakeupId));
}

export async function createBoardChannel(firstArg, secondArg) {
  const { db, options } = splitDbAndOptions(firstArg, secondArg);
  const {
    organizationId,
    name,
    channelName,
    topic = '',
    visibility = 'org',
    createdByNodeId = '',
  } = options;
  const normalizedName = normalizeBoardChannelName(name ?? channelName, { allowEmpty: true });
  if (!normalizedName) throw boardError('BOARD_INVALID_CHANNEL', 'Channel name is required', 400);
  const normalizedVisibility = trimString(visibility).toLowerCase() || 'org';
  if (normalizedVisibility !== 'org') {
    throw boardError(
      'BOARD_CHANNEL_VISIBILITY_UNSUPPORTED',
      'Only visibility="org" channels are supported in Phase 2',
      400,
    );
  }
  const normalizedTopic = trimString(topic).slice(0, MAX_CHANNEL_TOPIC_CHARS);
  return withBoardDb(db, (conn) => {
    requireOrganizationRow(conn, organizationId);
    return runBoardTx(conn, () => {
      ensureChannelRow(conn, organizationId, 'main');
      const existing = conn.prepare(
        'SELECT * FROM organization_board_channels WHERE organization_id = ? AND name = ?',
      ).get(organizationId, normalizedName);
      if (existing) {
        if (existing.state === 'archived') {
          conn.prepare("UPDATE organization_board_channels SET state = 'active', archived_at = NULL, topic = CASE WHEN ? <> '' THEN ? ELSE topic END WHERE id = ?")
            .run(normalizedTopic, normalizedTopic, existing.id);
        } else if (normalizedTopic && normalizedTopic !== existing.topic) {
          conn.prepare('UPDATE organization_board_channels SET topic = ? WHERE id = ?').run(normalizedTopic, existing.id);
        }
        return rowChannel(conn.prepare('SELECT * FROM organization_board_channels WHERE id = ?').get(existing.id));
      }
      const total = Number(conn.prepare('SELECT COUNT(*) AS count FROM organization_board_channels WHERE organization_id = ?').get(organizationId)?.count || 0);
      if (total >= MAX_CHANNELS_PER_ORG) {
        throw boardError('BOARD_CHANNEL_LIMIT_EXCEEDED', `Maximum channel count (${MAX_CHANNELS_PER_ORG}) reached`, 409);
      }
      const channelId = makeId('bchan');
      const timestamp = nowIso();
      conn.prepare(`INSERT INTO organization_board_channels
        (id, organization_id, name, topic, visibility, state, created_by_node_id, created_at)
        VALUES (?, ?, ?, ?, 'org', 'active', ?, ?)`)
        .run(channelId, organizationId, normalizedName, normalizedTopic, createdByNodeId || null, timestamp);
      if (createdByNodeId) {
        conn.prepare(`INSERT OR IGNORE INTO organization_board_channel_subscriptions
          (organization_id, channel_name, node_id, subscribed_at) VALUES (?, ?, ?, ?)`)
          .run(organizationId, normalizedName, createdByNodeId, timestamp);
      }
      return rowChannel(conn.prepare('SELECT * FROM organization_board_channels WHERE id = ?').get(channelId));
    });
  }, { mutate: true });
}

export async function listBoardChannels(firstArg, secondArg) {
  const { db, options } = splitDbAndOptions(firstArg, secondArg);
  const { organizationId, includeArchived = false, readerId = '' } = options;
  return withBoardDb(db, (conn) => {
    requireOrganizationRow(conn, organizationId);
    ensureChannelRow(conn, organizationId, 'main');
    return listBoardChannelsSync(conn, { organizationId, includeArchived, readerId });
  });
}

export async function subscribeBoardChannel(firstArg, secondArg) {
  const { db, options } = splitDbAndOptions(firstArg, secondArg);
  const { organizationId, channel = 'main', channelName, nodeId } = options;
  const normalizedName = normalizeBoardChannelName(channelName ?? channel);
  const targetNodeId = trimString(nodeId);
  if (!targetNodeId) throw boardError('BAD_REQUEST', 'nodeId is required', 400);
  return withBoardDb(db, (conn) => {
    requireOrganizationRow(conn, organizationId);
    const node = conn.prepare('SELECT id FROM organization_nodes WHERE id = ? AND organization_id = ?').get(targetNodeId, organizationId);
    if (!node) throw boardError('ORGANIZATION_NODE_NOT_FOUND', `node ${targetNodeId} not found in organization`, 404);
    return runBoardTx(conn, () => {
      const chan = ensureChannelRow(conn, organizationId, normalizedName);
      if (chan.state === 'archived') {
        throw boardError('BOARD_CHANNEL_ARCHIVED', `Channel #${normalizedName} is archived`, 409);
      }
      const timestamp = nowIso();
      conn.prepare(`INSERT OR IGNORE INTO organization_board_channel_subscriptions
        (organization_id, channel_name, node_id, subscribed_at) VALUES (?, ?, ?, ?)`)
        .run(organizationId, normalizedName, targetNodeId, timestamp);
      return { organizationId, channel: normalizedName, nodeId: targetNodeId, subscribed: true };
    });
  }, { mutate: true });
}

export async function unsubscribeBoardChannel(firstArg, secondArg) {
  const { db, options } = splitDbAndOptions(firstArg, secondArg);
  const { organizationId, channel = 'main', channelName, nodeId } = options;
  const normalizedName = normalizeBoardChannelName(channelName ?? channel);
  const targetNodeId = trimString(nodeId);
  if (!targetNodeId) throw boardError('BAD_REQUEST', 'nodeId is required', 400);
  return withBoardDb(db, (conn) => {
    requireOrganizationRow(conn, organizationId);
    const res = conn.prepare(
      'DELETE FROM organization_board_channel_subscriptions WHERE organization_id = ? AND channel_name = ? AND node_id = ?',
    ).run(organizationId, normalizedName, targetNodeId);
    return { organizationId, channel: normalizedName, nodeId: targetNodeId, unsubscribed: res.changes > 0 };
  }, { mutate: true });
}

export async function archiveBoardChannel(firstArg, secondArg) {
  const { db, options } = splitDbAndOptions(firstArg, secondArg);
  const { organizationId, channel, channelName, name } = options;
  const normalizedName = normalizeBoardChannelName(name ?? channelName ?? channel, { allowEmpty: true });
  if (!normalizedName) throw boardError('BOARD_INVALID_CHANNEL', 'Channel name is required', 400);
  if (normalizedName === 'main') {
    throw boardError('BOARD_MAIN_CHANNEL_PROTECTED', 'The #main board channel cannot be archived', 409);
  }
  return withBoardDb(db, (conn) => {
    requireOrganizationRow(conn, organizationId);
    const existing = conn.prepare(
      'SELECT * FROM organization_board_channels WHERE organization_id = ? AND name = ?',
    ).get(organizationId, normalizedName);
    if (!existing) throw boardError('BOARD_CHANNEL_NOT_FOUND', `Channel #${normalizedName} not found`, 404);
    if (existing.state !== 'archived') {
      conn.prepare("UPDATE organization_board_channels SET state = 'archived', archived_at = ? WHERE id = ?")
        .run(nowIso(), existing.id);
    }
    return rowChannel(conn.prepare('SELECT * FROM organization_board_channels WHERE id = ?').get(existing.id));
  }, { mutate: true });
}

export async function postBoardMessage(firstArg, secondArg) {
  const { db, options } = splitDbAndOptions(firstArg, secondArg);
  const {
    organizationId,
    channel = 'main',
    channelName,
    senderKind = 'node',
    senderNodeId = '',
    senderName = '',
    bodyMarkdown,
    text,
    body,
    replyToSeq = null,
    artifactRefs = [],
    kind = 'message',
    isDoneSignal = undefined,
    isStallAlert = undefined,
    idempotencyKey = '',
    mentions = [],
    autoCreateChannel = false,
  } = options;
  const rawBody = trimString(bodyMarkdown ?? text ?? body);
  if (!rawBody) throw boardError('BOARD_MESSAGE_EMPTY', 'Board message body cannot be empty', 400);
  if (rawBody.length > MAX_BOARD_BODY_CHARS) {
    throw boardError('BOARD_MESSAGE_TOO_LONG', `Board message exceeds ${MAX_BOARD_BODY_CHARS} character limit`, 400);
  }
  const normalizedChannel = normalizeBoardChannelName(channelName ?? channel);
  const normalizedSenderKind = ['node', 'owner', 'system'].includes(senderKind) ? senderKind : 'node';
  const normalizedSenderNodeId = normalizedSenderKind === 'node' ? trimString(senderNodeId) : '';
  const cleanIdempotencyKey = trimString(idempotencyKey);
  const normalizedArtifacts = normalizeArtifactRefs(artifactRefs);
  const parsed = parseBoardMentions(rawBody, { extraMentions: mentions });
  const effectiveReplyToSeq = Number.isInteger(replyToSeq) && replyToSeq > 0 ? replyToSeq : parsed.replyToSeq;
  const rawKind = trimString(kind);
  const effectiveStall = isStallAlert === true || (isStallAlert !== false && (rawKind === 'stall' || parsed.isStallAlert));
  const effectiveDone = !effectiveStall && rawKind !== 'brief' && (
    isDoneSignal === true || (isDoneSignal !== false && (rawKind === 'done' || parsed.isDoneSignal))
  );
  const normalizedKind = (rawKind === 'stall' && isStallAlert === false)
    || (rawKind === 'done' && isDoneSignal === false)
    ? 'message'
    : rawKind;
  const effectiveKind = normalizedKind || (effectiveStall ? 'stall' : effectiveDone ? 'done' : 'message');

  return withBoardDb(db, (conn) => {
    requireOrganizationRow(conn, organizationId);
    const { byId, byAlias } = buildNodeAliasMap(conn, organizationId);
    let resolvedSenderName = trimString(senderName).slice(0, 80);
    if (normalizedSenderNodeId) {
      const senderNode = byId.get(normalizedSenderNodeId);
      if (!senderNode) {
        throw boardError('ORGANIZATION_NODE_NOT_FOUND', `Sender node ${normalizedSenderNodeId} does not belong to organization ${organizationId}`, 404);
      }
      if (!resolvedSenderName) resolvedSenderName = senderNode.stableKey || senderNode.id;
    } else if (!resolvedSenderName) {
      resolvedSenderName = normalizedSenderKind === 'owner' ? 'owner' : 'system';
    }

    try {
      return runBoardTx(conn, () => {
        if (cleanIdempotencyKey) {
          const existing = conn.prepare(
            'SELECT * FROM organization_board_messages WHERE organization_id = ? AND idempotency_key = ?',
          ).get(organizationId, cleanIdempotencyKey);
          if (existing) {
            const headSeq = Number(conn.prepare(
              'SELECT COALESCE(MAX(seq), 0) AS head_seq FROM organization_board_messages WHERE organization_id = ?',
            ).get(organizationId)?.head_seq || 0);
            return {
              message: rowMessage(existing, byId),
              wakeups: [],
              headSeq,
              replay: true,
            };
          }
        }

        ensureChannelRow(conn, organizationId, 'main');
        let channelRow = conn.prepare(
          'SELECT * FROM organization_board_channels WHERE organization_id = ? AND name = ?',
        ).get(organizationId, normalizedChannel);
        if (!channelRow && autoCreateChannel) {
          channelRow = ensureChannelRow(conn, organizationId, normalizedChannel, { createdByNodeId: normalizedSenderNodeId });
        }
        if (!channelRow) {
          throw boardError('BOARD_CHANNEL_NOT_FOUND', `Channel #${normalizedChannel} not found`, 404);
        }
        if (channelRow.state === 'archived') {
          throw boardError('BOARD_CHANNEL_ARCHIVED', `Channel #${normalizedChannel} is archived`, 409);
        }

        const nextSeq = Number(conn.prepare(
          'SELECT COALESCE(MAX(seq), 0) AS max_seq FROM organization_board_messages WHERE organization_id = ?',
        ).get(organizationId)?.max_seq || 0) + 1;
        const messageId = makeId('bmsg');
        const timestamp = nowIso();
        conn.prepare(`INSERT INTO organization_board_messages
          (id, organization_id, seq, channel_name, sender_kind, sender_node_id, sender_name, body_markdown,
           mentions_json, reply_to_seq, artifact_refs_json, kind, is_done_signal, is_stall_alert, idempotency_key, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            messageId,
            organizationId,
            nextSeq,
            normalizedChannel,
            normalizedSenderKind,
            normalizedSenderNodeId || null,
            resolvedSenderName,
            rawBody,
            encodeJson(parsed.mentions, []),
            effectiveReplyToSeq ?? null,
            encodeJson(normalizedArtifacts, []),
            effectiveKind,
            effectiveDone ? 1 : 0,
            effectiveStall ? 1 : 0,
            cleanIdempotencyKey || null,
            timestamp,
          );

        const senderCursorId = normalizedSenderNodeId || (normalizedSenderKind === 'owner' ? 'owner' : '');
        if (senderCursorId) {
          conn.prepare(`INSERT INTO organization_board_cursors
            (organization_id, reader_id, channel_name, last_read_seq, last_notified_seq, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(organization_id, reader_id, channel_name) DO UPDATE SET
              last_read_seq = MAX(last_read_seq, excluded.last_read_seq),
              updated_at = excluded.updated_at`)
            .run(organizationId, senderCursorId, normalizedChannel, nextSeq, nextSeq, timestamp);
        }

        // Doorbell wakeups are emitted ONLY when explicit @mentions exist.
        // Ordinary messages create 0 wakeups.
        const targets = new Map();
        const addTarget = (node, reason) => {
          if (!isNodeEligibleForWakeup(node)) return;
          if (normalizedSenderNodeId && node.id === normalizedSenderNodeId) return;
          if (!targets.has(node.id)) targets.set(node.id, reason);
        };

        if (parsed.mentionAll) {
          for (const node of byId.values()) addTarget(node, effectiveStall ? 'stall' : 'all');
        }
        for (const chTarget of parsed.channelTargets) {
          const subRows = conn.prepare(
            'SELECT node_id FROM organization_board_channel_subscriptions WHERE organization_id = ? AND channel_name = ?',
          ).all(organizationId, chTarget);
          for (const sub of subRows) {
            addTarget(byId.get(sub.node_id), effectiveStall ? 'stall' : 'channel_mention');
          }
        }
        for (const memberAlias of parsed.memberTargets) {
          const matches = byAlias.get(memberAlias) || [];
          for (const node of matches) addTarget(node, effectiveStall ? 'stall' : 'mention');
        }

        const wakeups = [];
        for (const [targetNodeId, reason] of targets.entries()) {
          wakeups.push(upsertBoardWakeup(conn, {
            organizationId,
            targetNodeId,
            channelName: normalizedChannel,
            seq: nextSeq,
            reason,
            mentions: parsed.mentions,
            timestamp,
          }));
        }

        const inserted = conn.prepare('SELECT * FROM organization_board_messages WHERE id = ?').get(messageId);
        return {
          message: rowMessage(inserted, byId),
          wakeups,
          headSeq: nextSeq,
          replay: false,
        };
      });
    } catch (error) {
      if (cleanIdempotencyKey && isUniqueConstraintError(error)) {
        const existing = conn.prepare(
          'SELECT * FROM organization_board_messages WHERE organization_id = ? AND idempotency_key = ?',
        ).get(organizationId, cleanIdempotencyKey);
        if (existing) {
          const headSeq = Number(conn.prepare(
            'SELECT COALESCE(MAX(seq), 0) AS head_seq FROM organization_board_messages WHERE organization_id = ?',
          ).get(organizationId)?.head_seq || 0);
          return {
            message: rowMessage(existing, byId),
            wakeups: [],
            headSeq,
            replay: true,
          };
        }
      }
      throw error;
    }
  }, { mutate: true });
}

export async function readBoardMessages(firstArg, secondArg) {
  const { db, options } = splitDbAndOptions(firstArg, secondArg);
  const hasExplicitSince = options.sinceSeq !== undefined && options.sinceSeq !== null && Number(options.sinceSeq) >= 0;
  const {
    organizationId,
    channel = '',
    channelName = '',
    sinceSeq = 0,
    beforeSeq = 0,
    limit = 50,
    readerNodeId = '',
    readerId = '',
    advanceCursor = true,
  } = options;
  const normalizedChannel = normalizeBoardChannelName(channelName || channel, { allowEmpty: true });
  const boundedLimit = Math.max(1, Math.min(MAX_READ_LIMIT, Number.isInteger(limit) && limit > 0 ? limit : 50));
  const after = Number.isInteger(sinceSeq) && sinceSeq > 0 ? sinceSeq : 0;
  const before = Number.isInteger(beforeSeq) && beforeSeq > 0 ? beforeSeq : 0;
  const normalizedReader = trimString(readerNodeId || readerId);

  return withBoardDb(db, (conn) => {
    requireOrganizationRow(conn, organizationId);
    ensureChannelRow(conn, organizationId, 'main');
    const { byId } = buildNodeAliasMap(conn, organizationId);
    const clauses = ['organization_id = ?'];
    const params = [organizationId];
    if (normalizedChannel) {
      clauses.push('channel_name = ?');
      params.push(normalizedChannel);
    }
    if (after > 0) {
      clauses.push('seq > ?');
      params.push(after);
    }
    if (before > 0) {
      clauses.push('seq < ?');
      params.push(before);
    }
    const whereSql = clauses.join(' AND ');
    const orderDirection = (after > 0 || (hasExplicitSince && before === 0)) ? 'ASC' : 'DESC';
    const rawRows = conn.prepare(`
      SELECT * FROM organization_board_messages
      WHERE ${whereSql}
      ORDER BY seq ${orderDirection}
      LIMIT ?
    `).all(...params, boundedLimit + 1);

    const hasMore = rawRows.length > boundedLimit;
    const sliced = hasMore ? rawRows.slice(0, boundedLimit) : rawRows;
    if (orderDirection === 'DESC') sliced.reverse();
    const messages = sliced.map((row) => rowMessage(row, byId));
    const headSeq = Number(conn.prepare(
      'SELECT COALESCE(MAX(seq), 0) AS head_seq FROM organization_board_messages WHERE organization_id = ?',
    ).get(organizationId)?.head_seq || 0);

    let cursorSeq = 0;
    if (normalizedReader && advanceCursor && messages.length > 0) {
      const timestamp = nowIso();
      const maxSeqByChannel = new Map();
      let overallMax = 0;
      for (const msg of messages) {
        overallMax = Math.max(overallMax, msg.seq);
        maxSeqByChannel.set(msg.channel, Math.max(maxSeqByChannel.get(msg.channel) || 0, msg.seq));
      }
      runBoardTx(conn, () => {
        for (const [chan, seq] of maxSeqByChannel.entries()) {
          conn.prepare(`INSERT INTO organization_board_cursors
            (organization_id, reader_id, channel_name, last_read_seq, last_notified_seq, updated_at)
            VALUES (?, ?, ?, ?, 0, ?)
            ON CONFLICT(organization_id, reader_id, channel_name) DO UPDATE SET
              last_read_seq = MAX(last_read_seq, excluded.last_read_seq),
              updated_at = excluded.updated_at`)
            .run(organizationId, normalizedReader, chan, seq, timestamp);
        }
        if (!normalizedChannel) {
          conn.prepare(`INSERT INTO organization_board_cursors
            (organization_id, reader_id, channel_name, last_read_seq, last_notified_seq, updated_at)
            VALUES (?, ?, '*', ?, 0, ?)
            ON CONFLICT(organization_id, reader_id, channel_name) DO UPDATE SET
              last_read_seq = MAX(last_read_seq, excluded.last_read_seq),
              updated_at = excluded.updated_at`)
            .run(organizationId, normalizedReader, overallMax, timestamp);
        }
      });
      cursorSeq = overallMax;
    } else if (normalizedReader) {
      const cursorRow = conn.prepare(
        'SELECT COALESCE(MAX(last_read_seq), 0) AS seq FROM organization_board_cursors WHERE organization_id = ? AND reader_id = ?',
      ).get(organizationId, normalizedReader);
      cursorSeq = Number(cursorRow?.seq || 0);
    }

    const lastSeq = messages.at(-1)?.seq ?? after;
    return {
      organizationId,
      channel: normalizedChannel || null,
      headSeq,
      messages,
      hasMore,
      nextSinceSeq: lastSeq,
      cursorSeq,
    };
  }, { mutate: Boolean(normalizedReader && advanceCursor) });
}

export async function listUnreadBoardSummary(firstArg, secondArg) {
  const { db, options } = splitDbAndOptions(firstArg, secondArg);
  const { organizationId, readerId = '', readerNodeId = '', limit = 10 } = options;
  const targetReader = trimString(readerNodeId || readerId);
  if (!targetReader) throw boardError('BAD_REQUEST', 'readerId or readerNodeId is required', 400);
  const boundedLimit = Math.max(1, Math.min(50, Number.isInteger(limit) && limit > 0 ? limit : 10));

  return withBoardDb(db, (conn) => {
    requireOrganizationRow(conn, organizationId);
    ensureChannelRow(conn, organizationId, 'main');
    const cursorRows = conn.prepare(
      'SELECT channel_name, last_read_seq FROM organization_board_cursors WHERE organization_id = ? AND reader_id = ?',
    ).all(organizationId, targetReader);
    const cursorByChannel = new Map(cursorRows.map((entry) => [entry.channel_name, Number(entry.last_read_seq || 0)]));
    const globalCursor = cursorByChannel.get('*') || 0;
    const channels = conn.prepare(
      "SELECT name, topic FROM organization_board_channels WHERE organization_id = ? AND state = 'active' ORDER BY CASE WHEN name = 'main' THEN 0 ELSE 1 END, name",
    ).all(organizationId);
    const perChannel = [];
    let totalUnread = 0;
    for (const ch of channels) {
      const lastRead = Math.max(globalCursor, cursorByChannel.get(ch.name) || 0);
      const stats = conn.prepare(
        'SELECT COUNT(*) AS unread, COALESCE(MAX(seq), 0) AS latest_seq FROM organization_board_messages WHERE organization_id = ? AND channel_name = ? AND seq > ?',
      ).get(organizationId, ch.name, lastRead);
      const unreadCount = Number(stats?.unread || 0);
      if (unreadCount > 0) {
        totalUnread += unreadCount;
        perChannel.push({
          channel: ch.name,
          topic: ch.topic || '',
          unreadCount,
          sinceSeq: lastRead,
          latestSeq: Number(stats?.latest_seq || 0),
        });
      }
    }
    const { byId } = buildNodeAliasMap(conn, organizationId);
    const wakeup = conn.prepare(
      "SELECT * FROM organization_board_wakeups WHERE organization_id = ? AND target_node_id = ? AND state IN ('pending', 'deferred')",
    ).get(organizationId, targetReader);
    const minUnreadSeq = globalCursor;
    const recentRows = conn.prepare(`
      SELECT * FROM organization_board_messages
      WHERE organization_id = ? AND seq > ?
      ORDER BY seq DESC LIMIT ?
    `).all(organizationId, minUnreadSeq, boundedLimit).filter((row) => {
      const chCursor = Math.max(globalCursor, cursorByChannel.get(row.channel_name) || 0);
      return Number(row.seq) > chCursor;
    }).reverse();
    const headSeq = Number(conn.prepare(
      'SELECT COALESCE(MAX(seq), 0) AS head_seq FROM organization_board_messages WHERE organization_id = ?',
    ).get(organizationId)?.head_seq || 0);

    return {
      organizationId,
      readerId: targetReader,
      headSeq,
      totalUnread,
      channels: perChannel,
      pendingWakeup: rowWakeup(wakeup),
      recentMessages: recentRows.map((row) => {
        const msg = rowMessage(row, byId);
        return {
          seq: msg.seq,
          channel: msg.channel,
          sender: msg.sender,
          senderKind: msg.senderKind,
          kind: msg.kind,
          mentions: msg.mentions,
          preview: msg.text.slice(0, 240),
          createdAt: msg.createdAt,
        };
      }),
    };
  });
}

export async function listPendingBoardWakeups(firstArg, secondArg) {
  const { db, options } = splitDbAndOptions(firstArg, secondArg);
  const { organizationId = '', states = ['pending', 'deferred'], limit = 200 } = options;
  const wantedStates = Array.isArray(states) && states.length > 0
    ? states.filter((s) => ['pending', 'deferred', 'delivered', 'cancelled'].includes(s))
    : ['pending', 'deferred'];
  const boundedLimit = Math.max(1, Math.min(1000, Number.isInteger(limit) && limit > 0 ? limit : 200));

  return withBoardDb(db, (conn) => {
    const placeholders = wantedStates.map(() => '?').join(',');
    const rows = trimString(organizationId)
      ? conn.prepare(`
          SELECT * FROM organization_board_wakeups
          WHERE organization_id = ? AND state IN (${placeholders})
          ORDER BY created_at ASC, trigger_seq ASC
          LIMIT ?
        `).all(trimString(organizationId), ...wantedStates, boundedLimit)
      : conn.prepare(`
          SELECT * FROM organization_board_wakeups
          WHERE state IN (${placeholders})
          ORDER BY created_at ASC, trigger_seq ASC
          LIMIT ?
        `).all(...wantedStates, boundedLimit);
    return rows.map(rowWakeup);
  });
}

export async function markBoardWakeupDelivered(firstArg, secondArg) {
  const { db, options } = splitDbAndOptions(firstArg, secondArg);
  const { wakeupId, id, deliveredAt = nowIso() } = options;
  const targetId = trimString(wakeupId ?? id);
  if (!targetId) throw boardError('BAD_REQUEST', 'wakeupId is required', 400);

  return withBoardDb(db, (conn) => {
    const row = conn.prepare('SELECT * FROM organization_board_wakeups WHERE id = ?').get(targetId);
    if (!row) return null;
    runBoardTx(conn, () => {
      conn.prepare(`UPDATE organization_board_wakeups
        SET state = 'delivered', attempts = attempts + 1, last_error = NULL,
            delivered_at = ?, updated_at = ?
        WHERE id = ? AND state IN ('pending', 'deferred')`)
        .run(deliveredAt, deliveredAt, targetId);
      conn.prepare(`INSERT INTO organization_board_cursors
        (organization_id, reader_id, channel_name, last_read_seq, last_notified_seq, updated_at)
        VALUES (?, ?, ?, 0, ?, ?)
        ON CONFLICT(organization_id, reader_id, channel_name) DO UPDATE SET
          last_notified_seq = MAX(last_notified_seq, excluded.last_notified_seq),
          updated_at = excluded.updated_at`)
        .run(row.organization_id, row.target_node_id, row.channel_name, Number(row.latest_seq || 0), deliveredAt);
    });
    return rowWakeup(conn.prepare('SELECT * FROM organization_board_wakeups WHERE id = ?').get(targetId));
  }, { mutate: true });
}

export async function markBoardWakeupDeferred(firstArg, secondArg) {
  const { db, options } = splitDbAndOptions(firstArg, secondArg);
  const { wakeupId, id, reason = '' } = options;
  const targetId = trimString(wakeupId ?? id);
  if (!targetId) throw boardError('BAD_REQUEST', 'wakeupId is required', 400);

  return withBoardDb(db, (conn) => {
    const existing = conn.prepare('SELECT * FROM organization_board_wakeups WHERE id = ?').get(targetId);
    if (!existing) return null;
    const timestamp = nowIso();
    conn.prepare(`UPDATE organization_board_wakeups
      SET state = 'deferred', attempts = attempts + 1,
          last_error = CASE WHEN ? <> '' THEN ? ELSE last_error END,
          updated_at = ?
      WHERE id = ? AND state IN ('pending', 'deferred')`)
      .run(trimString(reason), trimString(reason).slice(0, 500), timestamp, targetId);
    return rowWakeup(conn.prepare('SELECT * FROM organization_board_wakeups WHERE id = ?').get(targetId));
  }, { mutate: true });
}

export function isSwarmMarkedDoneSync(conn, organizationId, orgPolicy = {}) {
  if (orgPolicy?.swarmDone === true) return true;
  const candidateRows = conn.prepare(`
    SELECT m.seq, m.mentions_json, m.kind, m.body_markdown
    FROM organization_board_messages m
    LEFT JOIN organization_nodes n
      ON n.id = m.sender_node_id AND n.organization_id = m.organization_id
    WHERE m.organization_id = ?
      AND m.kind <> 'brief'
      AND m.is_done_signal = 1
      AND m.is_stall_alert = 0
      AND (
        m.sender_kind = 'owner'
        OR ((m.kind = 'done' OR m.channel_name = 'main') AND (n.node_role = 'root_leadership' OR UPPER(COALESCE(n.session_class, '')) = 'ROOT_LEADERSHIP'))
      )
    ORDER BY m.seq DESC
  `).all(organizationId);
  return candidateRows.some((row) => {
    // Explicit Coordinator/Owner kind='done' closes the Swarm even when the
    // summary includes @mentions; ordinary messages and kind='brief' still
    // ignore [done] markers paired with @mentions.
    if (row.kind === 'done') return true;
    const mentions = parseJson(row.mentions_json, []);
    if (Array.isArray(mentions) && mentions.length > 0) return false;
    return /\[\s*done\s*\]/i.test(String(row.body_markdown || ''));
  });
}

export async function buildAuthoritativeBoardProjection(firstArg, secondArg) {
  const { db, options } = splitDbAndOptions(firstArg, secondArg);
  const {
    organizationId,
    channel = '',
    sinceSeq = 0,
    limit = 100,
    readerId = 'owner',
    includeArchived = false,
  } = options;
  const normalizedChannel = normalizeBoardChannelName(channel, { allowEmpty: true });
  const boundedLimit = Math.max(1, Math.min(MAX_READ_LIMIT, Number.isInteger(limit) && limit > 0 ? limit : 100));
  const after = Number.isInteger(sinceSeq) && sinceSeq > 0 ? sinceSeq : 0;

  return withBoardDb(db, (conn) => {
    const orgRow = requireOrganizationRow(conn, organizationId);
    ensureChannelRow(conn, organizationId, 'main');
    const orgPolicy = parseJson(orgRow.policy_json, {});
    const { byId } = buildNodeAliasMap(conn, organizationId);

    const channels = listBoardChannelsSync(conn, { organizationId, includeArchived, readerId });
    const msgClauses = ['organization_id = ?'];
    const msgParams = [organizationId];
    if (normalizedChannel) {
      msgClauses.push('channel_name = ?');
      msgParams.push(normalizedChannel);
    }
    if (after > 0) {
      msgClauses.push('seq > ?');
      msgParams.push(after);
    }
    const orderDirection = after > 0 ? 'ASC' : 'DESC';
    const rawMsgs = conn.prepare(`
      SELECT * FROM organization_board_messages
      WHERE ${msgClauses.join(' AND ')}
      ORDER BY seq ${orderDirection}
      LIMIT ?
    `).all(...msgParams, boundedLimit + 1);
    const hasMore = rawMsgs.length > boundedLimit;
    const sliced = hasMore ? rawMsgs.slice(0, boundedLimit) : rawMsgs;
    if (orderDirection === 'DESC') sliced.reverse();
    const messages = sliced.map((row) => rowMessage(row, byId));

    const headSeq = Number(conn.prepare(
      'SELECT COALESCE(MAX(seq), 0) AS head_seq FROM organization_board_messages WHERE organization_id = ?',
    ).get(organizationId)?.head_seq || 0);
    const activeStalls = conn.prepare(
      "SELECT * FROM organization_swarm_stall_alerts WHERE organization_id = ? AND state = 'active' ORDER BY last_alert_at DESC",
    ).all(organizationId).map((row) => ({
      id: row.id,
      dedupeKey: row.dedupe_key,
      conditionKind: row.condition_kind,
      targetRole: row.target_role,
      targetNodeId: row.target_node_id || '',
      boardSeq: row.board_seq ?? null,
      details: parseJson(row.details_json, {}),
      alertCount: Number(row.alert_count || 1),
      lastAlertAt: row.last_alert_at,
    }));
    const isDone = isSwarmMarkedDoneSync(conn, organizationId, orgPolicy);

    return {
      mode: 'ragent_swarm',
      source: 'ragent_swarm',
      readOnly: false,
      schemaVersion: 1,
      organizationId,
      title: trimString(orgPolicy?.swarmTitle || orgPolicy?.title) || null,
      headSeq,
      isDone,
      channels,
      messages,
      hasMore,
      activeStalls,
    };
  });
}

function listBoardChannelsSync(conn, { organizationId, includeArchived = false, readerId = '' }) {
  const rows = conn.prepare(`
    SELECT * FROM organization_board_channels
    WHERE organization_id = ? ${includeArchived ? '' : "AND state = 'active'"}
    ORDER BY CASE WHEN name = 'main' THEN 0 ELSE 1 END, name ASC
  `).all(organizationId);
  const statsRows = conn.prepare(`
    SELECT channel_name, COUNT(*) AS message_count, COALESCE(MAX(seq), 0) AS latest_seq
    FROM organization_board_messages WHERE organization_id = ? GROUP BY channel_name
  `).all(organizationId);
  const statsByChannel = new Map(statsRows.map((entry) => [entry.channel_name, {
    messageCount: Number(entry.message_count || 0),
    latestSeq: Number(entry.latest_seq || 0),
  }]));
  const subsRows = conn.prepare(
    'SELECT channel_name, node_id FROM organization_board_channel_subscriptions WHERE organization_id = ? ORDER BY node_id ASC',
  ).all(organizationId);
  const subsByChannel = new Map();
  for (const sub of subsRows) {
    const list = subsByChannel.get(sub.channel_name) || [];
    list.push(sub.node_id);
    subsByChannel.set(sub.channel_name, list);
  }
  const normalizedReader = trimString(readerId);
  const cursorRows = normalizedReader
    ? conn.prepare('SELECT channel_name, last_read_seq FROM organization_board_cursors WHERE organization_id = ? AND reader_id = ?').all(organizationId, normalizedReader)
    : [];
  const cursorByChannel = new Map(cursorRows.map((entry) => [entry.channel_name, Number(entry.last_read_seq || 0)]));
  return rows.map((row) => {
    const stats = statsByChannel.get(row.name) || { messageCount: 0, latestSeq: 0 };
    if (normalizedReader) {
      const readSeq = cursorByChannel.get(row.name) ?? cursorByChannel.get('*') ?? 0;
      stats.unreadCount = Number(conn.prepare(
        'SELECT COUNT(*) AS count FROM organization_board_messages WHERE organization_id = ? AND channel_name = ? AND seq > ?',
      ).get(organizationId, row.name, readSeq)?.count || 0);
    }
    return rowChannel(row, stats, subsByChannel.get(row.name) || []);
  });
}
