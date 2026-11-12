const DEFAULT_MAX_CHARS = 4000;
const DEFAULT_MAX_BODY_CHARS = 2800;
const DEFAULT_MAX_ITEM_CHARS = 500;
const DEFAULT_MAX_ITEMS = 20;
const TRUNCATED_MARKER = '\n[... truncated by Ragent ...]\n';

function trimString(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim();
}

function singleLine(value, maxChars = 240) {
  const text = trimString(value).replace(/\s+/g, ' ');
  if (!text || text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
}

function clipText(value, maxChars = DEFAULT_MAX_CHARS) {
  const text = trimString(value);
  if (!text || text.length <= maxChars) return text;
  const headChars = Math.max(1, Math.floor(maxChars * 0.6));
  const tailChars = Math.max(1, maxChars - headChars);
  return `${text.slice(0, headChars).trimEnd()}${TRUNCATED_MARKER}${text.slice(-tailChars).trimStart()}`;
}

function normalizePlanItemStatus(item = {}) {
  const rawStatus = singleLine(item.status || item.state, 80);
  if (rawStatus) return rawStatus;
  return item.completed === true ? 'completed' : 'pending';
}

function normalizePlanItems(event, maxItems = DEFAULT_MAX_ITEMS) {
  const sourceItems = Array.isArray(event?.items)
    ? event.items
    : (Array.isArray(event?.plan) ? event.plan : []);
  const normalized = [];

  for (const sourceItem of sourceItems) {
    const item = sourceItem && typeof sourceItem === 'object'
      ? sourceItem
      : { text: sourceItem };
    const text = singleLine(item.text || item.step || item.title, DEFAULT_MAX_ITEM_CHARS);
    if (!text) continue;
    normalized.push({
      text,
      status: normalizePlanItemStatus(item),
    });
    if (normalized.length >= maxItems) break;
  }

  return {
    items: normalized,
    omitted: Math.max(0, sourceItems.length - normalized.length),
  };
}

export function formatPlanContextEvent(event, options = {}) {
  const maxChars = Number.isInteger(options.maxChars) && options.maxChars > 0
    ? options.maxChars
    : DEFAULT_MAX_CHARS;
  const maxBodyChars = Number.isInteger(options.maxBodyChars) && options.maxBodyChars > 0
    ? options.maxBodyChars
    : DEFAULT_MAX_BODY_CHARS;
  const maxItems = Number.isInteger(options.maxItems) && options.maxItems > 0
    ? options.maxItems
    : DEFAULT_MAX_ITEMS;

  const explicitTitle = singleLine(event?.title, 240);
  const title = explicitTitle || 'Codex plan';
  const planId = singleLine(event?.planId || event?.artifactId || event?.id, 160);
  const state = singleLine(event?.status || event?.state, 120);
  const source = singleLine(event?.source, 120);
  const previousPlanId = singleLine(event?.previousPlanId, 160);
  const lastPlanAction = singleLine(event?.lastPlanAction, 120);
  const revision = Number.isInteger(event?.revision) && event.revision > 0
    ? event.revision
    : null;
  const bodyMarkdown = clipText(
    event?.bodyMarkdown || event?.text || event?.content,
    maxBodyChars,
  );
  const { items, omitted } = normalizePlanItems(event, maxItems);

  if (!explicitTitle && !planId && !state && !source && !revision && !bodyMarkdown && items.length === 0) {
    return '';
  }

  const lines = [`[Plan artifact: ${title}]`];
  if (planId) lines.push(`Plan id: ${planId}`);
  if (state) lines.push(`State: ${state}`);
  if (revision) lines.push(`Revision: ${revision}`);
  if (source) lines.push(`Source: ${source}`);
  if (previousPlanId) lines.push(`Previous plan id: ${previousPlanId}`);
  if (lastPlanAction) lines.push(`Last plan action: ${lastPlanAction}`);

  if (bodyMarkdown) {
    lines.push('', 'Body:', bodyMarkdown);
  }

  if (items.length > 0) {
    lines.push('', 'Items:');
    for (const item of items) {
      lines.push(`- [${item.status}] ${item.text}`);
    }
    if (omitted > 0) {
      lines.push(`- [... ${omitted} more plan item${omitted === 1 ? '' : 's'} omitted by Ragent ...]`);
    }
  }

  return clipText(lines.join('\n'), maxChars);
}
