const ASYNC_QUESTION_REPLY_TAG = 'send_user_message_question_reply';
const MAX_ASYNC_QUESTION_ITEM_ID_BYTES = 512;
const MAX_ASYNC_QUESTION_REPLIES = 24;
const ENVELOPE_REGEX = new RegExp(
  `<${ASYNC_QUESTION_REPLY_TAG}>\\s*([\\s\\S]*?)\\s*</${ASYNC_QUESTION_REPLY_TAG}>`,
  'gi',
);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeAsyncQuestionReplies(replies) {
  if (!Array.isArray(replies)) return [];
  const normalized = [];
  for (const item of replies.slice(0, MAX_ASYNC_QUESTION_REPLIES)) {
    if (!item || typeof item !== 'object') continue;
    const questionItemId = trimString(item.questionItemId || item.id).slice(0, 1024);
    const question = trimString(item.question || item.title).slice(0, 2000);
    const rawAnswer = item.answer ?? item.value ?? item.text ?? '';
    const answer = typeof rawAnswer === 'string' ? rawAnswer.trim().slice(0, 8000) : '';
    if (!answer) continue;
    normalized.push({
      questionItemId,
      question,
      answer,
    });
  }
  return normalized;
}

export function extractAnsweredQuestionItemIds(replies = []) {
  const ids = [];
  const seen = new Set();
  for (const item of Array.isArray(replies) ? replies : []) {
    const id = trimString(item?.questionItemId || item?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function parseAsyncQuestionItemId(questionItemId) {
  const raw = trimString(questionItemId);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      Array.isArray(parsed)
      && parsed[0] === 'request_user_input_async'
      && typeof parsed[1] === 'string'
      && parsed[1].trim()
      && Number.isInteger(parsed[2])
      && parsed[2] >= 0
    ) {
      return {
        messageId: parsed[1].trim(),
        index: parsed[2],
      };
    }
  } catch {}
  return null;
}

function formatMarkdownFallbackReply(reply) {
  const answer = trimString(reply?.answer);
  if (!answer) return '';
  const question = trimString(reply?.question);
  if (!question) return answer;
  const quotedQuestion = question
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join('\n');
  return `${quotedQuestion}\n\n${answer}`;
}

export function buildAsyncQuestionReplyText(replies, trailingText = '') {
  const normalized = normalizeAsyncQuestionReplies(replies);
  const trailing = typeof trailingText === 'string' ? trailingText.trim() : '';
  const structured = [];
  const markdownBlocks = [];

  for (const reply of normalized) {
    const idBytes = reply.questionItemId
      ? Buffer.byteLength(reply.questionItemId, 'utf8')
      : Number.POSITIVE_INFINITY;
    if (reply.questionItemId && idBytes <= MAX_ASYNC_QUESTION_ITEM_ID_BYTES) {
      structured.push({
        answer: reply.answer,
        question: reply.question,
        questionItemId: reply.questionItemId,
      });
    } else {
      const fallback = formatMarkdownFallbackReply(reply);
      if (fallback) markdownBlocks.push(fallback);
    }
  }

  const sections = [];
  if (structured.length > 0) {
    // Escape "</" inside JSON strings so a user answer cannot close the tag early.
    const serialized = JSON.stringify(structured).replace(/<\//g, '<\\/');
    sections.push(`<${ASYNC_QUESTION_REPLY_TAG}>\n${serialized}\n</${ASYNC_QUESTION_REPLY_TAG}>`);
  }
  sections.push(...markdownBlocks);
  if (trailing) sections.push(trailing);
  return sections.join('\n\n');
}

function extractRepliesFromParsedPayload(parsed) {
  const items = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? [parsed] : []);
  const extracted = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const answer = typeof item.answer === 'string' ? item.answer.trim() : '';
    if (!answer) continue;
    extracted.push({
      questionItemId: trimString(item.questionItemId || item.id),
      question: trimString(item.question || item.title),
      answer,
    });
  }
  return extracted;
}

export function parseAsyncQuestionReplyEnvelope(text) {
  if (typeof text !== 'string' || !text) {
    return { replies: [], trailingText: '' };
  }
  const replies = [];
  ENVELOPE_REGEX.lastIndex = 0;
  const trailingText = text
    .replace(ENVELOPE_REGEX, (_match, rawJson) => {
      try {
        const parsed = JSON.parse(rawJson);
        replies.push(...extractRepliesFromParsedPayload(parsed));
      } catch {}
      return '\n';
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { replies, trailingText };
}

export {
  ASYNC_QUESTION_REPLY_TAG,
  MAX_ASYNC_QUESTION_ITEM_ID_BYTES,
};
