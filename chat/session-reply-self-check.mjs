import { buildSessionDisplayEvents } from './session-display-events.mjs';
import { extractTaggedBlock, parseJsonObjectText } from './session-text-parsing.mjs';

function normalizeReplySelfCheckText(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim();
}

function clipReplySelfCheckText(value, maxChars = 5000) {
  const text = normalizeReplySelfCheckText(value);
  if (!text) return '';
  if (text.length <= maxChars) return text;
  const headChars = Math.max(1, Math.floor(maxChars * 0.6));
  const tailChars = Math.max(1, maxChars - headChars);
  return `${text.slice(0, headChars).trimEnd()}\n[... truncated by AgentoC ...]\n${text.slice(-tailChars).trimStart()}`;
}

function unwrapExactReplyText(value) {
  let text = normalizeReplySelfCheckText(value);
  const fenced = text.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  if (fenced) text = normalizeReplySelfCheckText(fenced[1]);
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if (
      (first === '`' && last === '`')
      || (first === '"' && last === '"')
      || (first === "'" && last === "'")
      || (first === '“' && last === '”')
      || (first === '‘' && last === '’')
    ) {
      text = normalizeReplySelfCheckText(text.slice(1, -1));
    }
  }
  return text;
}

function extractExactReplyText(userMessage) {
  const text = normalizeReplySelfCheckText(userMessage);
  if (!text) return '';
  const patterns = [
    /(?:reply|respond|return|output|write|say)\s+(?:with\s+)?exactly(?:\s+this)?(?:\s+single)?\s+line(?:\s+and\s+nothing\s+else)?\s*:\s*([\s\S]+)$/i,
    /(?:reply|respond|return|output)\s+with\s+exactly\s+the\s+following(?:\s+text)?\s*:\s*([\s\S]+)$/i,
    /(?:只|仅)(?:回复|回答|输出)(?:下面|以下|这一)?(?:这)?(?:一行|段文字|内容)?(?:，|,)?(?:不要添加任何其他内容|不要输出其他内容|且不要有其他内容)?\s*[：:]\s*([\s\S]+)$/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return unwrapExactReplyText(match[1]);
  }
  return '';
}

export function isReplySelfCheckClearlyComplete({ userMessage, assistantTurnText } = {}) {
  const expected = extractExactReplyText(userMessage?.content || userMessage || '');
  if (!expected) return false;
  return normalizeReplySelfCheckText(assistantTurnText) === expected;
}

const REQUIRED_USER_INPUT_PATTERNS = [
  /\b(?:please\s+)?(?:provide|send|share|enter|paste|supply|give)\b[^.!?\n]{0,80}?\b(?:api\s*key|access\s*token|auth\s*token|token|password|passphrase|secret|credentials?|private\s*key|ssh\s*key|username|user\s*name|login|account\s+(?:id|number)|email(?:\s+address)?|phone(?:\s+number)?|verification\s+code|otp|two[-\s]?factor)\b/i,
  /\bwhat(?:'s|\s+is|\s+are)\s+(?:your|the)\b[^.!?\n]{0,40}?\b(?:api\s*key|token|password|secret|credentials?|username|email|phone|account|url|endpoint|domain|project\s*id|workspace\s*id)\b/i,
  /\b(?:please\s+)?(?:sign\s+in|log\s+in|log\s+into|authenticate|authorize)\b/i,
  /\b(?:can(?:not|'t)|unable\s+to)\s+(?:proceed|continue|go\s+(?:on|further|ahead))\s+without\b/i,
  /\b(?:reply|respond|send)\s+(?:with|back|me)?\s*(?:the\s+)?(?:url|link|address|endpoint|value|number|code|output|result|log)\b[^.!?\n]{0,40}?\b(?:so\s+i|and\s+i'll|then\s+i|to\s+continue|to\s+proceed|to\s+verify)\b/i,
  /(?:需要|等|想要)(?:你|您)(?:提供|给|发(?:给)?|发送|输入|粘贴|贴(?:给|一下)?|告诉|说(?:一下)?|回复|确认|提供一下)(?:[^。？！\n]{0,30})?(?:api|密钥|令牌|token|密码|口令|凭证|账号|账户|邮箱|手机号|验证码|地址|链接|域名|端点|网址|结果|输出|原文|内容|实例|复现|日志)/,
  /(?:你的?|您(?:的)?)\s*(?:api|密钥|令牌|token|密码|口令|凭证|账号|账户|邮箱|手机号|验证码)\s*(?:是什么|是多少|是啥|请提供|发我|发给我|告诉我|提供一下)/,
  /请(?:[^。？！\n]{0,6})?(?:登录|登陆|授权|认证|完成验证|扫码)/,
  /(?:无法|不能)(?:[^。？！\n]{0,12})?(?:继续|推进|完成)(?:[^。？！\n]{0,12})?(?:除非|没有|缺少)/,
];

// --- Category 2: reply defers a real decision / preference fork to the user ---
const USER_DECISION_PATTERNS = [
  /\b(?:which|what)\s+(?:one|option|approach|direction|variant|format|style|database|library|method)\s+(?:do|would|should)\s+you\b/i,
  /\b(?:do|would|would\s+you|rather)\s+you\s+(?:prefer|want\s+to\s+(?:use|go|proceed))\b/i,
  /\b(?:please\s+)?(?:pick|choose|select)\s+(?:one|between|from|an?\s+(?:option|approach|variant))\b/i,
  /\b(?:please\s+)?(?:pick|choose|select)\s+[a-z0-9]+\s+(?:or|\/)\s+[a-z0-9]+\b/i,
  /\b(?:it's|it\s+is)\s+(?:your|up\s+to\s+you)\s+(?:choice|decision|preference|call)\b/i,
  /\bshould\s+(?:we|i)\s+(?:use|go\s+with|adopt|pick|choose)\b/i,
  /\b(?:do|would|should)\s+(?:you|i|we)\b[^.!?\n]{1,120}\b(?:or|instead)\b[^.!?\n]{1,120}\?/i,
  /\bapproach\s+[a-d]\s+(?:or|vs\.?|and)\s+/i,
  // Chinese decision deferral
  /(?:请|麻烦)?(?:你|您)(?:来)?(?:定|决定|选(?:择|一个|哪个)?|拿主意|拍板)/,
  /(?:你|您)(?:更)?(?:倾向|喜欢|想用|要)(?:哪个|哪一个|哪种|哪样)/,
  /(?:你|您)(?:希望|想让(?:我)?|要我)(?:[^。？！\n]{0,50})?(?:怎么|如何|先做什么|从哪(?:里|个)?开始)[?？]/,
  /(?:选哪一个|选一个|选其一|用哪个|要哪个|挑哪个|二选一)/,
  /(?:选|用|要)\s*[A-Za-z]\s*(?:还是|或|或者)\s*[A-Za-z]/,
  /[^。？！\n]{1,120}(?:还是|或是|或者)[^。？！\n]{1,120}[?？]/,
  /(?:这个|这项|这里|下一步)(?:取决于|需要|是真实分叉)/,
  /(?:你|您)(?:觉得|怎么看|有什么(?:意见|想法|建议)|是否认可|能接受)(?:[^。？！\n]{0,30})?[?？]?/,
  /(?:这个|这样|这个方案)(?:你|您)?(?:觉得)?(?:怎么样|如何|合适吗|可以接受吗)/,
  /\b(?:what\s+do\s+you\s+think|how\s+do\s+you\s+feel\s+about|what(?:'s|\s+is)\s+your\s+(?:opinion|view|preference))\b/i,
  /\bdoes\s+(?:this|that|it)\s+(?:look|sound|feel)\s+(?:right|good|okay|ok)(?:\s+to\s+you)?\b/i,
];

// --- Category 3: reply is waiting for the user to do something and report back ---
const WAITING_FOR_USER_ACTION_PATTERNS = [
  /\b(?:waiting|wait)\s+(?:for|on)\s+(?:you|your|the\s+user)\b/i,
  /\b(?:let\s+me|tell\s+me|send\s+me|paste|share|give\s+me)\b[^.!?\n]{0,40}?\b(?:once|when|after|and\s+i'll|so\s+i|to\s+continue|to\s+proceed|results?|output|result)\b/i,
  /\bi\s+(?:still\s+)?need\s+(?:you\s+to\s+|from\s+you)\b/i,
  /(?:等|需要|得)(?:你|您)(?:[^。？！\n]{0,16})?(?:结果|看看|看一下|看一眼|一眼|确认|回复|告诉|说|跑完|执行|试(?:着|一下|试)?|装(?:一下)?|贴|发|提供)/,
  /(?:贴|发|传|回)(?:[^。？！\n]{0,40})?给\s*我/,
  /(?:结果|输出|截图|日志|原文).{0,8}(?:一)?发我|发给我|贴给我|发出来/,
  /请(?:给我|提供)(?:[^。？！\n]{0,20})?(?:复现|实例|例子|原文|请求|触发|截图|日志|结果|输出)/,
  /(?:你|您)(?:先)?(?:回答|告诉我|说)(?:[^。？！\n]{0,20})?(?:哪个|哪个范围|哪一种|是不是|是否|用的是)/,
  // "你先回答/确认 … 我就/我再 开工" — assistant acts only after the user answers.
  /(?:你|您)(?:先)?(?:回答|确认|告诉我|说|定)(?:[^。？！\n]{0,30})?(?:我就|我再|我直接|我马上|我接着|我才|就开工|就开)/,
  // "你去 登录/试/装/看 …" — instructing the user to perform an action themselves.
  /(?:你|您)去(?:[^。？！\n]{0,20})?(?:登录|登陆|试(?:着|一下)?|装(?:一下)?|看|检查|跑|执行|打开|点击|点一下)/,
  // "装上/有问题 … 都告诉我" — waiting for the user to report back.
  /(?:装上|弄好|跑完|完成后?|有问题|还有问题|不行|没有(?:的话)?)(?:[^。？！\n]{0,16})?(?:都|再|就|的话)?(?:告诉|发|贴|回复)(?:我|一下)?/,
  // soft preference ask: "…有别的偏好,告诉我" / "你的想法告诉我".
  /(?:偏好|意见|想法|建议|倾向|喜欢)(?:[^。？！\n]{0,20})?(?:告诉|说|回复)(?:我|一下)?/,
];

// --- Category 4: confirmation gate before a restart / destructive / irreversible action ---
const DESTRUCTIVE_CONFIRMATION_PATTERNS = [
  /\b(?:need\s+your|awaiting\s+your|requires?\s+your)\s+(?:confirmation|approval|go-ahead|sign-?off)\b/i,
  /\bconfirm(?:\s+(?:before|prior))?\b[^.!?\n]{0,60}?\b(?:restart|reboot|delete|drop|destroy|overwrite|wipe|migrate|deploy|shutdown|irreversible|production|prod)\b/i,
  /\b(?:restart|reboot|delete|drop|wipe|overwrite|migrate|deploy)\b[^.!?\n]{0,60}?\b(?:confirm|approval|go\s+ahead|okay|ok\?)\b/i,
  /(?:需要|得|要)(?:你|您)(?:明确)?(?:确认|回复|点头|同意|授权)(?:[^。？！\n]{0,20})?(?:重启|重起|部署|上线|删除|覆盖|迁移|停机)/,
  /(?:确认|是否)(?:[^。？！\n]{0,12})?(?:现在)?(?:重启|重起|部署|上线|删除|覆盖)/,
  /(?:重启|部署|上线|删除|迁移)(?:[^。？！\n]{0,16})?(?:需要|要|得)(?:你|您)(?:确认|回复|同意|授权|点头)/,
];

// --- Option-list detection (bulleted (A)/(B), circled ①②, numbered + choice word) ---
function countOptionMarkers(text) {
  const lettered = new Set();
  const circled = new Set();
  const m1 = text.match(/[（(]\s*([A-Ca-c])\s*[）)]/g);
  if (m1) for (const m of m1) lettered.add(m);
  if (/\boption\s+[a-d]\b/i.test(text) && /\b[a-d]\s*(?:or|\/)\s*[a-d]\b/i.test(text)) lettered.add('opt');
  const m2 = text.match(/[①②③④⑤⑥⑦⑧⑨⑩]/g);
  if (m2) for (const m of m2) circled.add(m);
  return { lettered: lettered.size, circled: circled.size };
}

const CHOICE_WORD_PATTERN = /(?:\b(?:which|prefer|pick|choose|select)\b|请选|选一个|选哪个|选其一|你定|你选|你来定|哪个|倾向)/i;

const OPEN_OFFER_PATTERN = [
  /\bif\s+(?:you\s+)?(?:want|would\s+like|prefer)\b[^.!?\n]{0,120}?\b(?:i\s+can|i'll|i\s+will|let\s+me)\b/i,
  /\bi\s+can\b[^.!?\n]{0,80}?\b(?:next|if\s+you\s+want|if\s+you'd\s+like)\b/i,
  /\blet\s+me\s+know\b[^.!?\n]{0,80}?\b(?:if|and\s+i'll|and\s+i\s+can)\b/i,
  /如果(?:你|您)?(?:愿意|需要|想要|要的话)[^。？！\n]{0,80}?(?:我(?:可以|能|会|就|再|马上|现在)|帮你|继续)/,
];

function hasPromptedOptionList(tail) {
  const { lettered, circled } = countOptionMarkers(tail);
  // Covers line-lettered choice prompts like "A. Deploy..." / "B. Deploy..." followed by "Please choose A or B."
  const lineLettered = tail.match(/(?:^|\n)\s*(?:[-*•]\s*)?(?:\*\*)?[A-Ca-c](?:\*\*)?\s*[).:：]\s*\S/g) || [];
  // Lettered options (A)/(B)/(C) or circled ①② almost always denote a user choice.
  if (lettered >= 2 || circled >= 2 || lineLettered.length >= 2) return true;
  // Numbered list ("1."/"2."/"1)") accompanied by a choice word.
  if (CHOICE_WORD_PATTERN.test(tail)) {
    const numbered = tail.match(/(?:^|\n)\s*(?:[-*•]|\(?(\d{1,2})\)?)\s*\S/g) || [];
    if (numbered.length >= 2) return true;
  }
  return false;
}

function hasUserDelegatedDecision(userMessage) {
  const text = normalizeReplySelfCheckText(typeof userMessage === 'string' ? userMessage : userMessage?.content || '');
  if (!text) return false;
  return /\b(?:you\s+decide|your\s+call|use\s+your\s+(?:best\s+)?judg(?:e?ment)|pick\s+(?:whichever|whatever|the\s+best)|decide\s+(?:for\s+me|yourself)|go\s+ahead|just\s+(?:do|proceed|continue))\b/i.test(text)
    || /(?:你(?:来|自己)?(?:决定|定|选|拿主意|判断)|交给你|自行(?:决定|判断)|看着办|随便(?:你|选)|直接(?:做|继续|开始|弄))/ .test(text);
}

export function isReplySelfCheckWaitingForUser({ assistantTurnText, userMessage } = {}) {
  const reply = normalizeReplySelfCheckText(assistantTurnText);
  if (!reply || reply.length < 8) return false;
  if (hasUserDelegatedDecision(userMessage)) return false;

  const tail = reply.slice(-1500);

  if (REQUIRED_USER_INPUT_PATTERNS.some((p) => p.test(tail))) return true;
  if (DESTRUCTIVE_CONFIRMATION_PATTERNS.some((p) => p.test(tail))) return true;
  if (hasPromptedOptionList(tail)) return true;
  if (OPEN_OFFER_PATTERN.some((p) => p.test(tail))) return false;
  if (USER_DECISION_PATTERNS.some((p) => p.test(tail))) return true;
  if (WAITING_FOR_USER_ACTION_PATTERNS.some((p) => p.test(tail))) return true;

  return false;
}

function formatReplySelfCheckDisplayEvent(event) {
  if (!event || typeof event !== 'object') return '';
  if (event.type === 'message' && event.role === 'assistant') {
    return normalizeReplySelfCheckText(event.content || '');
  }
  if (event.type === 'plan') {
    const items = Array.isArray(event.items) ? event.items : [];
    const lines = items
      .map((item) => {
        const text = normalizeReplySelfCheckText(item?.text || item?.step || item?.title || '');
        if (!text) return '';
        const status = normalizeReplySelfCheckText(item?.status || item?.state || '').toLowerCase();
        const completed = status === 'completed' || item?.completed === true;
        return `${completed ? '[x]' : '[ ]'} ${text}`;
      })
      .filter(Boolean);
    if (lines.length === 0) return '[Displayed plan]';
    const title = normalizeReplySelfCheckText(event.title || '');
    return [title ? `[Displayed plan: ${title}]` : '[Displayed plan]', ...lines].join('\n');
  }
  if (event.type === 'attachment_delivery') {
    const attachments = Array.isArray(event.attachments) ? event.attachments : [];
    const names = attachments
      .map((attachment) => typeof attachment?.originalName === 'string' ? attachment.originalName.trim() : '')
      .filter(Boolean);
    if (names.length > 0) {
      return `[Displayed attachment delivery: ${names.join(', ')}]`;
    }
    return '[Displayed attachment delivery]';
  }
  if (event.type === 'thinking_block') {
    const label = normalizeReplySelfCheckText(event.label || 'Thought');
    return label ? `[Displayed thought block: ${label}]` : '[Displayed thought block]';
  }
  if (event.type === 'status') {
    const content = normalizeReplySelfCheckText(event.content || '');
    return content ? `[Displayed status: ${content}]` : '';
  }
  return '';
}

function buildReplySelfCheckDisplayedAssistantTurn(history = []) {
  const displayEvents = buildSessionDisplayEvents(history, { sessionRunning: false });
  const parts = [];
  for (const event of displayEvents) {
    if (event?.type === 'message' && event.role === 'user') continue;
    const text = formatReplySelfCheckDisplayEvent(event);
    if (text) {
      parts.push(text);
    }
  }
  return parts.join('\n\n').trim();
}

export async function loadReplySelfCheckTurnContext(sessionId, runId, { loadSessionHistory } = {}) {
  if (typeof loadSessionHistory !== 'function') {
    throw new TypeError('loadReplySelfCheckTurnContext requires loadSessionHistory');
  }

  const history = await loadSessionHistory(sessionId, {
    includeBodies: true,
    // Completion-time Runtime consumers parse hidden envelopes from this raw
    // channel. User-facing display projection still strips them centrally.
    includeAssistantControlBlocks: true,
  });
  const runHistory = [];
  let userMessage = null;
  let latestAssistantMessage = null;
  let inputTokensTotal = 0;
  let outputTokensTotal = 0;
  let hasUsage = false;

  for (const event of history) {
    if (runId && event?.runId !== runId) continue;
    runHistory.push(event);
    if (event?.type === 'message' && event.role === 'user') {
      userMessage = event;
      continue;
    }
    if (event?.type === 'message' && event.role === 'assistant') {
      latestAssistantMessage = event;
      continue;
    }
    if (event?.type === 'usage') {
      if (Number.isFinite(event.inputTokens)) {
        inputTokensTotal += event.inputTokens;
        hasUsage = true;
      }
      if (Number.isFinite(event.outputTokens)) {
        outputTokensTotal += event.outputTokens;
        hasUsage = true;
      }
    }
  }

  const turnHistory = Number.isInteger(userMessage?.seq)
    ? runHistory.filter((event) => !Number.isInteger(event?.seq) || event.seq >= userMessage.seq)
    : runHistory;
  // Display projections intentionally strip Runtime control envelopes. Keep a
  // separate raw channel for completion effects that must still parse those
  // envelopes after the projection boundary.
  const rawAssistantParts = turnHistory
    .filter((event) => event?.type === 'message' && event.role === 'assistant')
    .map((event) => typeof event.content === 'string' ? event.content.trim() : '')
    .filter(Boolean);
  const latestRawAssistantText = rawAssistantParts.at(-1) || '';
  const assistantControlText = /<agentoc-(?:organization-proposal|collaboration-plan|result-packet|session-labels)\b/i.test(latestRawAssistantText)
    ? latestRawAssistantText
    : rawAssistantParts.join('\n\n');
  const assistantTurnText = buildReplySelfCheckDisplayedAssistantTurn(turnHistory)
    || normalizeReplySelfCheckText(latestAssistantMessage?.content || '');

  return {
    userMessage,
    assistantTurnText,
    assistantControlText,
    usage: hasUsage
      ? {
          inputTokens: inputTokensTotal,
          outputTokens: outputTokensTotal,
          totalTokens: inputTokensTotal + outputTokensTotal,
        }
      : null,
  };
}

export function summarizeReplySelfCheckReason(value, fallback = 'the latest reply left avoidable unfinished work') {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return fallback;
  if (text.length <= 160) return text;
  return `${text.slice(0, 157).trimEnd()}…`;
}

export function buildReplySelfCheckPrompt({ userMessage, assistantTurnText }) {
  return [
    'You are Ragent\'s hidden end-of-turn completion reviewer.',
    'Judge only whether the latest assistant reply stopped too early for the current user turn.',
    'Unless the reply clearly completed the requested work or hit a real blocker, prefer "continue".',
    'Judge branch-first: the question is not "should the assistant continue?" but "does a real logical fork or forced human checkpoint require the user right now?"',
    'When uncertain between "accept" and "continue", choose "continue".',
    'If there is no explicit user-side blocker, assume the assistant should continue with the obvious next step.',
    'Single-track work with an obvious next step must be marked "continue" even if the reply asked for permission or framed the pause as a choice.',
    'Accept only when the reply already reaches a meaningful stopping point for this turn or it clearly states the exact blocker that truly requires the user.',
    'Real blockers are explicit user-side dependencies such as missing required input, genuine ambiguity that prevents safe progress, a real branch whose choice depends on user preference, missing access / credentials / files, or destructive / irreversible actions that need confirmation.',
    'You must choose "accept" when the reply is genuinely waiting for necessary user input, a real user-preference choice, access or credentials, or confirmation before a destructive / irreversible action.',
    'Do not invent a user-side dependency that the visible reply did not create.',
    'However, once the visible reply actually asks the user to choose, confirm, provide information, perform an action and report back, or give an opinion, choose "accept" and wait. The reviewer must not answer for the user or override that checkpoint merely because it thinks a default path exists.',
    'Do not treat optional extra polish or the assistant\'s own internal caution as blockers when the reply is not actually waiting for the user.',
    'A reply that ends with an open offer or permission request such as "if you want I can...", "I can do that next", or "let me know and I\'ll continue" is never a meaningful stopping point by itself and must be marked "continue" unless the same reply clearly states a real blocker.',
    'If the only remaining work is something the assistant could already do with the current context, you must choose "continue".',
    'Strong continue signals include: promising to do the next step later, asking permission to continue without a real blocker, offering to continue if the user wants, summarizing a plan while leaving the requested action undone, or stopping after analysis when execution was still possible.',
    'Do not require extra artifacts the user did not ask for. Conceptual discussion can already be complete when the user asked only for discussion.',
    'If the user explicitly requested exact text or exactly one line and the reply matches it, choose "accept".',
    'Return exactly one <hide> JSON object with keys "action", "reason", and "continuationPrompt".',
    'Valid actions: "accept" or "continue".',
    'If action is "accept", set continuationPrompt to an empty string.',
    'If action is "continue", continuationPrompt must tell the next assistant how to finish the missing work immediately without asking permission and without repeating the whole previous reply.',
    'Write reason and continuationPrompt in the user\'s language.',
    'Do not output any text outside the <hide> block.',
    '',
    'Current user message:',
    clipReplySelfCheckText(userMessage?.content || '', 3000) || '[none]',
    '',
    'Latest assistant turn content shown to the user:',
    clipReplySelfCheckText(assistantTurnText || '', 5000) || '[none]',
  ].join('\n');
}

export function parseReplySelfCheckDecision(content) {
  const hidden = extractTaggedBlock(content, 'hide');
  const parsed = parseJsonObjectText(hidden || content);
  const rawAction = String(parsed?.action || '').trim().toLowerCase();
  const action = rawAction === 'accept'
    ? 'accept'
    : 'continue';
  return {
    action,
    reason: summarizeReplySelfCheckReason(parsed?.reason || ''),
    continuationPrompt: action === 'continue' ? String(parsed?.continuationPrompt || '').trim() : '',
  };
}

export function buildReplySelfRepairPrompt({ userMessage, assistantTurnText, reviewDecision }) {
  const continuationPrompt = String(reviewDecision?.continuationPrompt || '').trim();
  const reason = summarizeReplySelfCheckReason(reviewDecision?.reason || 'finish the missing work now');
  return [
    'You are continuing the same user-facing reply after a hidden self-check found an avoidable early stop.',
    'The previous assistant reply is already visible to the user.',
    'Add only the missing completion now.',
    'Default to taking the obvious next step with the information already available.',
    'If there is no real logical fork or forced human checkpoint, continue on the default single-track path.',
    'Prefer doing the work over describing what you would do.',
    'Replace any prior open offer or permission request with the actual next action or result now.',
    'Do not turn a single-track task into a menu of options or ask the user to choose a direction when the next step is already clear.',
    'Do not ask for permission to continue.',
    'Do not mention the hidden self-check or internal review process.',
    'Do not end with another open offer such as "if you want I can continue" or "I can do that next".',
    'Only stop if a concrete user-side blocker truly prevents safe progress.',
    'If you still truly need user input, state exactly what is missing and why it is required.',
    '',
    'Original user message:',
    clipReplySelfCheckText(userMessage?.content || '', 3000) || '[none]',
    '',
    'Previous assistant turn content already shown to the user:',
    clipReplySelfCheckText(assistantTurnText || '', 5000) || '[none]',
    '',
    'Hidden reviewer guidance:',
    continuationPrompt || `Finish the missing work now. Reviewer reason: ${reason}`,
    '',
    'Return only the next user-visible assistant message.',
  ].join('\n');
}
