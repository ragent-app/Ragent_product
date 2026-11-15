"use strict";

// Goal UI — header chip + edit modal for the per-session codex goal.
//
// Provider-agnostic: it only reads/writes `session.goal` (via PATCH
// /api/sessions/:id { goal }). On codex app-server sessions the backend applies
// that intent natively (threadGoal/*); on others it is injected as a reminder.
//
// Update channels:
//   - updateGoalChip(session): called from applyAttachedSessionState on attach
//     and after a PATCH save; repaints the chip from the authoritative
//     session.goal snapshot and clears any live overlay.
//   - paintGoalChipLive(events): called from the realtime session_events path;
//     picks the latest thread/goal/* event and paints status + token usage on
//     the chip without an HTTP round-trip. The next attach repaints from meta.
(function attachGoalUi(root) {
  if (root.__ragentGoalUiAttached === true) return;
  root.__ragentGoalUiAttached = true;

  const STATUS_LABEL = {
    '': 'not set',
    in_progress: 'working',
    completed: 'done',
    blocked: 'blocked',
    paused: 'paused',
    usageLimited: 'rate-limited',
    budgetLimited: 'budget hit',
  };
  const STATUS_I18N_KEY = {
    '': 'goal.status.notSet',
    in_progress: 'goal.status.inProgress',
    completed: 'goal.status.completed',
    blocked: 'goal.status.blocked',
    paused: 'goal.status.paused',
    usageLimited: 'goal.status.usageLimited',
    budgetLimited: 'goal.status.budgetLimited',
  };
  // Translate status labels when the i18n layer is present; fall back to the
  // hardcoded English map so the chip/sheet never render empty on load order
  // quirks or a missing i18n bundle.
  function statusLabel(status) {
    const key = STATUS_I18N_KEY[status] || '';
    if (key && typeof root.ragentT === 'function') {
      const translated = root.ragentT(key);
      if (typeof translated === 'string' && translated.length > 0 && translated !== key) return translated;
    }
    return STATUS_LABEL[status] || (status || STATUS_LABEL['']);
  }
  const STATUS_TONE = {
    '': 'idle',
    in_progress: 'working',
    completed: 'done',
    blocked: 'blocked',
    paused: 'idle',
    usageLimited: 'warn',
    budgetLimited: 'warn',
  };

  // Goal-chasing (cross-turn auto-continuation) copy. Hardcoded Chinese fallback
  // so the controls render regardless of i18n load order; ragentT overrides when
  // the keys exist. The toggle button label is context-dependent: when chasing it
  // offers to pause, when paused it offers to resume (重新开始).
  const CHASE_LABEL_FALLBACK = {
    chasing: '自动继续中',
    paused: '自动继续已暂停',
    pauseBtn: '暂停自动继续',
    resumeBtn: '重新开始',
  };
  const CHASE_LABEL_I18N_KEY = {
    chasing: 'goal.chase.chasing',
    paused: 'goal.chase.paused',
    pauseBtn: 'goal.chase.pause',
    resumeBtn: 'goal.chase.resume',
  };
  const PENDING_GOAL_LABEL_FALLBACK = '下一条消息将作为目标';
  const PENDING_GOAL_LABEL_I18N_KEY = 'goal.pendingLabel';
  const pendingGoalMemory = new Set();

  function translatedGoalCopy(key, fallback) {
    if (typeof root.ragentT === 'function') {
      const translated = root.ragentT(key);
      if (typeof translated === 'string' && translated.length > 0 && translated !== key) return translated;
    }
    return fallback;
  }

  function resolveSessionId(sessionId) {
    if (typeof sessionId === 'string' && sessionId.trim()) return sessionId.trim();
    return typeof currentSessionId === 'string' ? currentSessionId.trim() : '';
  }

  function pendingGoalStorageKey(sessionId) {
    const sid = resolveSessionId(sessionId);
    return sid ? `ragent.goal.pending.v1:${sid}` : '';
  }

  function isPendingGoalArmed(sessionId) {
    const key = pendingGoalStorageKey(sessionId);
    if (!key) return false;
    if (pendingGoalMemory.has(key)) return true;
    try {
      return window.sessionStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  }

  function setPendingGoalArmed(sessionId, armed) {
    const key = pendingGoalStorageKey(sessionId);
    if (!key) return false;
    if (armed) pendingGoalMemory.add(key);
    else pendingGoalMemory.delete(key);
    try {
      if (armed) window.sessionStorage.setItem(key, '1');
      else window.sessionStorage.removeItem(key);
      return true;
    } catch {
      return true;
    }
  }

  function pendingGoalLabel() {
    return translatedGoalCopy(PENDING_GOAL_LABEL_I18N_KEY, PENDING_GOAL_LABEL_FALLBACK);
  }

  function chaseLabel(key) {
    const i18nKey = CHASE_LABEL_I18N_KEY[key] || '';
    if (i18nKey && typeof root.ragentT === 'function') {
      const translated = root.ragentT(i18nKey);
      if (typeof translated === 'string' && translated.length > 0 && translated !== i18nKey) return translated;
    }
    return CHASE_LABEL_FALLBACK[key] || '';
  }

  const dom = {
    chip: null, chipText: null, chipDot: null, chipUsage: null, chaseBadge: null,
    composerGoalPill: null, composerGoalPillText: null, composerGoalMenuNote: null,
    playPauseBtn: null, playPauseIcon: null,
    modalStatusRow: null, modalStatusDot: null, modalStatusText: null,
    sheet: null, closeBtn: null, objective: null, tokenBudget: null,
    enabled: null, status: null, saveBtn: null, clearBtn: null,
    error: null,
    goalMenuItem: null, addMenu: null,
    chaseRow: null, chaseStatus: null, chaseToggleBtn: null,
  };

  let backEntryId = null;
  let lastFocusedElement = null;
  let focusScopeDeactivate = null;
  // Live overlay painted from session_events during a run; reset to null on
  // attach so the authoritative session.goal snapshot wins between turns.
  let liveOverlay = null;
  // Last session.goal seen via updateGoalChip; opened by the sheet editor.
  let lastGoal = null;

  function ready() {
    dom.chip = document.getElementById('goalChip');
    dom.chipText = document.getElementById('goalChipText');
    dom.chipDot = document.getElementById('goalChipDot');
    dom.chipUsage = document.getElementById('goalChipUsage');
    dom.composerGoalPill = document.getElementById('composerGoalPill');
    dom.composerGoalPillText = document.getElementById('composerGoalPillText');
    dom.composerGoalMenuNote = document.getElementById('composerGoalMenuNote');
    dom.playPauseBtn = document.getElementById('goalPlayPauseBtn');
    dom.playPauseIcon = document.getElementById('goalPlayPauseIcon');
    dom.modalStatusRow = document.getElementById('goalModalStatusRow');
    dom.modalStatusDot = document.getElementById('goalModalStatusDot');
    dom.modalStatusText = document.getElementById('goalModalStatusText');
    dom.sheet = document.getElementById('goalSheet');
    dom.closeBtn = document.getElementById('goalSheetClose');
    dom.objective = document.getElementById('goalObjectiveInput');
    dom.tokenBudget = document.getElementById('goalTokenBudgetInput');
    dom.enabled = document.getElementById('goalEnabledInput');
    dom.status = document.getElementById('goalStatusDisplay');
    dom.error = document.getElementById('goalFormError');
    dom.saveBtn = document.getElementById('goalSheetSave');
    dom.clearBtn = document.getElementById('goalSheetClear');
    dom.goalMenuItem = document.getElementById('composerGoalMenuItem');
    dom.addMenu = document.getElementById('composerAddMenu');
    dom.chaseBadge = document.getElementById('goalChaseBadge');
    dom.chaseRow = document.getElementById('goalChaseRow');
    dom.chaseStatus = document.getElementById('goalChaseStatus');
    dom.chaseToggleBtn = document.getElementById('goalChaseToggleBtn');

    syncGoalMenuVisibility();

    if (dom.chip) dom.chip.addEventListener('click', () => openSheet());
    if (dom.composerGoalPill) dom.composerGoalPill.addEventListener('click', () => openSheet());
    if (dom.playPauseBtn) dom.playPauseBtn.addEventListener('click', () => handlePlayPauseClick());
    if (dom.objective) dom.objective.addEventListener('input', () => syncModalStatusAndPlayButton());
    if (dom.goalMenuItem) dom.goalMenuItem.addEventListener('click', () => {
      closeAddMenu();
      const hasGoal = !!(lastGoal && lastGoal.objective);
      const pending = !hasGoal && isPendingGoalArmed();
      if (hasGoal || pending) openSheet();
      else armPendingGoal();
    });
    if (dom.closeBtn) dom.closeBtn.addEventListener('click', () => closeSheet());
    if (dom.sheet) dom.sheet.addEventListener('click', (event) => {
      if (event.target === dom.sheet) closeSheet();
    });
    if (dom.saveBtn) dom.saveBtn.addEventListener('click', () => save());
    if (dom.clearBtn) dom.clearBtn.addEventListener('click', () => clearGoal());
    if (dom.chaseToggleBtn) dom.chaseToggleBtn.addEventListener('click', () => toggleChase());
  }

  function isClaudeRuntimeSelected() {
    const tool = typeof root.ragentGetSelectedToolDefinition === 'function'
      ? root.ragentGetSelectedToolDefinition()
      : null;
    const runtimeFamily = String(tool?.runtimeFamily || '').trim().toLowerCase();
    const toolId = String(
      tool?.id || document.getElementById('inlineToolSelect')?.value || '',
    ).trim().toLowerCase();
    return runtimeFamily.startsWith('claude-stream-json')
      || toolId === 'claude'
      || toolId === 'claude-bidi'
      || toolId === 'claude-code';
  }

  function syncGoalMenuVisibility() {
    if (!dom.goalMenuItem) return;
    const hidden = isClaudeRuntimeSelected();
    dom.goalMenuItem.hidden = hidden;
    dom.goalMenuItem.setAttribute('aria-hidden', hidden ? 'true' : 'false');
  }

  function closeAddMenu() {
    if (typeof setComposerAddMenuOpen === 'function') {
      setComposerAddMenuOpen(false);
      return;
    }
    if (dom.addMenu) {
      dom.addMenu.hidden = true;
      dom.addMenu.classList.remove('is-open', 'is-closing');
    }
  }

  function effectiveStatus(goal) {
    if (liveOverlay && liveOverlay.status) return liveOverlay.status;
    return (goal && typeof goal.status === 'string') ? goal.status : '';
  }

  function formatTokens(n) {
    if (!Number.isFinite(n)) return '';
    if (n >= 10000) return `${Math.round(n / 1000)}k`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(Math.floor(n));
  }

  function formatUsage(goal) {
    const budget = (liveOverlay && Number.isFinite(liveOverlay.tokenBudget))
      ? liveOverlay.tokenBudget
      : (goal && Number.isFinite(goal.tokenBudget) ? goal.tokenBudget : null);
    const used = (liveOverlay && Number.isFinite(liveOverlay.tokensUsed))
      ? liveOverlay.tokensUsed
      : (goal && Number.isFinite(goal.tokensUsed) ? goal.tokensUsed : null);
    if (!Number.isFinite(used)) return '';
    if (Number.isFinite(budget) && budget > 0) {
      const pct = Math.min(100, Math.round((used / budget) * 100));
      return `${formatTokens(used)}/${formatTokens(budget)} · ${pct}%`;
    }
    return `${formatTokens(used)} used`;
  }

  function truncate(text, max) {
    const t = String(text || '');
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  }

  function paintChip(goal) {
    const hasGoal = !!(goal && goal.objective);
    const pending = !hasGoal && isPendingGoalArmed();

    // Update Composer Inline Goal Pill (Android alignment)
    if (dom.composerGoalPill) {
      dom.composerGoalPill.hidden = !hasGoal && !pending;
      if (hasGoal || pending) {
        dom.composerGoalPill.dataset.state = pending ? 'pending' : 'active';
        dom.composerGoalPill.dataset.empty = pending ? 'true' : 'false';
        dom.composerGoalPill.title = pending ? pendingGoalLabel() : (goal?.objective || 'Session goal');
        dom.composerGoalPill.setAttribute('aria-label', dom.composerGoalPill.title);
        if (dom.composerGoalPillText) {
          dom.composerGoalPillText.textContent = pending ? '' : truncate(goal.objective, 24);
          dom.composerGoalPillText.hidden = pending;
        }
      } else {
        dom.composerGoalPill.removeAttribute('data-state');
      }
    }

    // Update Composer Goal Menu Item in Add Menu (Android alignment)
    if (dom.goalMenuItem) {
      dom.goalMenuItem.classList.toggle('active', hasGoal || pending);
      dom.goalMenuItem.setAttribute('aria-checked', hasGoal || pending ? 'true' : 'false');
      if (dom.composerGoalMenuNote) {
        if (hasGoal) {
          dom.composerGoalMenuNote.textContent = `Objective: ${truncate(goal.objective, 24)} (tracking enabled)`;
        } else if (pending) {
          dom.composerGoalMenuNote.textContent = 'Goal mode armed (next message sets goal)';
        } else {
          dom.composerGoalMenuNote.textContent = translatedGoalCopy('compose.add.goalOn', 'Set a tracked objective + optional token budget');
        }
      }
    }

    if (dom.chip) {
      // Legacy header chip is retired in favor of Android-aligned composer-goal-pill.
      dom.chip.hidden = true;
    }
  }

  function renderChaseBadge(goal) {
    if (!dom.chaseBadge) return;
    const chasing = !!(goal && goal.objective && goal.chasing === true && goal.enabled !== false);
    dom.chaseBadge.textContent = chaseLabel('chasing');
    dom.chaseBadge.hidden = !chasing;
  }

  function renderChaseControls(goal) {
    if (!dom.chaseRow) return;
    const hasGoal = !!(goal && goal.objective && goal.enabled !== false);
    dom.chaseRow.hidden = !hasGoal;
    if (!hasGoal) return;
    const chasing = goal.chasing === true;
    if (dom.chaseStatus) {
      dom.chaseStatus.textContent = chaseLabel(chasing ? 'chasing' : 'paused');
      dom.chaseStatus.dataset.tone = chasing ? 'working' : 'idle';
    }
    if (dom.chaseToggleBtn) {
      dom.chaseToggleBtn.textContent = chaseLabel(chasing ? 'pauseBtn' : 'resumeBtn');
      dom.chaseToggleBtn.dataset.action = chasing ? 'pause' : 'resume';
      dom.chaseToggleBtn.setAttribute('aria-label', chaseLabel(chasing ? 'pauseBtn' : 'resumeBtn'));
    }
  }

  function setFormError(message = '') {
    if (!dom.error) return;
    dom.error.textContent = message;
    dom.error.hidden = !message;
  }

  function syncModalStatusAndPlayButton(goal = lastGoal) {
    const currentText = dom.objective ? String(dom.objective.value || '').trim() : '';
    const isChasing = !!(goal && goal.objective && goal.chasing === true && goal.enabled !== false);
    const hasText = currentText.length > 0 || !!(goal && goal.objective);

    if (dom.playPauseBtn) {
      dom.playPauseBtn.classList.toggle('is-pause', isChasing);
      dom.playPauseBtn.classList.toggle('is-play', !isChasing);
      const actionTitle = isChasing ? '暂停自动继续' : '开始自动继续';
      dom.playPauseBtn.title = actionTitle;
      dom.playPauseBtn.setAttribute('aria-label', actionTitle);
    }
    if (dom.playPauseIcon) {
      dom.playPauseIcon.setAttribute('data-icon', isChasing ? 'pause' : 'play');
      if (root.RagentIcons && typeof root.RagentIcons.hydrate === 'function' && dom.playPauseBtn) {
        root.RagentIcons.hydrate(dom.playPauseBtn);
      }
    }

    if (dom.modalStatusRow) {
      if (isChasing) {
        dom.modalStatusRow.dataset.tone = 'chasing';
        if (dom.modalStatusText) dom.modalStatusText.textContent = '自动继续中 (Auto-continuing)';
      } else if (hasText) {
        dom.modalStatusRow.dataset.tone = 'ready';
        if (dom.modalStatusText) dom.modalStatusText.textContent = '目标已就绪，将在任务执行时自动追踪';
      } else {
        dom.modalStatusRow.dataset.tone = 'idle';
        if (dom.modalStatusText) dom.modalStatusText.textContent = '未设定目标：发送下一条消息将自动作为目标并开启自动继续';
      }
    }
  }

  async function handlePlayPauseClick() {
    const sid = (typeof currentSessionId === 'string') ? currentSessionId : '';
    if (!sid) return;
    const isChasing = !!(lastGoal && lastGoal.chasing === true && lastGoal.objective);
    if (isChasing) {
      await toggleChase('pause');
      syncModalStatusAndPlayButton(lastGoal);
      return;
    }
    const objective = dom.objective ? String(dom.objective.value || '').trim() : '';
    if (!objective) {
      armPendingGoal();
      closeSheet();
      return;
    }
    if (typeof updateSessionRecord !== 'function') return;
    const rawBudget = dom.tokenBudget ? String(dom.tokenBudget.value || '').trim() : '';
    const parsedBudget = rawBudget ? Number(rawBudget) : NaN;
    const payload = {
      objective,
      enabled: true,
      chasing: true,
    };
    if (Number.isFinite(parsedBudget) && parsedBudget > 0) {
      payload.tokenBudget = Math.floor(parsedBudget);
    }
    closeSheet();
    try {
      await updateSessionRecord(sid, { goal: payload });
      setPendingGoalArmed(sid, false);
    } catch (err) {
      console.error('[goal-ui] start auto-continue failed', err);
      openSheet();
      setFormError(typeof root.ragentT === 'function'
        ? root.ragentT('goal.saveError')
        : 'Could not save the goal. Check your connection and try again.');
    }
  }

  function syncSheetForm(goal) {
    if (dom.objective) dom.objective.value = (goal && goal.objective) ? goal.objective : '';
    if (dom.tokenBudget) {
      dom.tokenBudget.value = (goal && Number.isFinite(goal.tokenBudget)) ? goal.tokenBudget : '';
    }
    if (dom.enabled) dom.enabled.checked = goal ? goal.enabled !== false : true;
    if (dom.status) {
      const status = effectiveStatus(goal);
      dom.status.textContent = statusLabel(status);
      dom.status.dataset.tone = STATUS_TONE[status] || 'idle';
    }
    if (dom.clearBtn) {
      dom.clearBtn.hidden = false;
      const hasSavedGoal = !!(goal && goal.objective);
      const key = hasSavedGoal ? 'goal.clear' : 'goal.turnOff';
      const label = typeof root.ragentT === 'function'
        ? root.ragentT(key)
        : (hasSavedGoal ? 'Clear goal' : 'Turn off goal mode');
      dom.clearBtn.textContent = label;
      dom.clearBtn.setAttribute('data-i18n', key);
      dom.clearBtn.setAttribute('aria-label', label);
      dom.clearBtn.title = label;
    }
    renderChaseControls(goal);
    syncModalStatusAndPlayButton(goal);
  }

  function armPendingGoal() {
    const sid = resolveSessionId();
    if (!sid) return false;
    setPendingGoalArmed(sid, true);
    liveOverlay = null;
    if (!lastGoal || !lastGoal.objective) {
      lastGoal = null;
      paintChip(null);
      renderChaseControls(null);
    }
    return true;
  }

  async function toggleChase(actionOverride) {
    const sid = (typeof currentSessionId === 'string') ? currentSessionId : '';
    if (!sid) return;
    const isCurrentlyChasing = !!(lastGoal && lastGoal.chasing === true && lastGoal.objective);
    const action = actionOverride
      || (dom.chaseToggleBtn ? (dom.chaseToggleBtn.dataset.action === 'pause' ? 'pause' : 'resume') : (isCurrentlyChasing ? 'pause' : 'resume'));
    if (typeof controlGoalChasing === 'function') {
      try {
        await controlGoalChasing(sid, action);
      } catch (err) {
        console.error('[goal-ui] chase control failed', err);
      }
    }
    // controlGoalChasing round-trips through applyAttachedSessionState →
    // updateGoalChip, which repaints from the authoritative goal. Re-render once
    // more so a failed/silent response still keeps the control visually honest.
    renderChaseControls(lastGoal);
  }

  function updateGoalChip(session) {
    liveOverlay = null;
    lastGoal = (session && session.goal) ? session.goal : null;
    if (lastGoal && lastGoal.objective) setPendingGoalArmed(session?.id, false);
    paintChip(lastGoal);
    renderChaseControls(lastGoal);
  }

  function resetGoalLiveState() {
    liveOverlay = null;
    paintChip(lastGoal);
  }

  function paintGoalChipLive(events) {
    if (!Array.isArray(events) || !dom.chip || dom.chip.hidden) return;
    let latest = null;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const evt = events[i];
      if (!evt || typeof evt !== 'object') continue;
      if (evt.codexGoalEvent === 'cleared') {
        latest = { cleared: true };
        break;
      }
      if (evt.codexGoalEvent === 'updated' || typeof evt.codexGoalStatus === 'string') {
        latest = evt;
        break;
      }
    }
    if (!latest) return;
    if (latest.cleared) {
      liveOverlay = { status: '', tokensUsed: null, tokenBudget: null };
    } else {
      liveOverlay = {
        status: typeof latest.codexGoalStatus === 'string' ? latest.codexGoalStatus : '',
        tokensUsed: Number.isFinite(latest.codexGoalTokensUsed) ? latest.codexGoalTokensUsed : null,
        tokenBudget: Number.isFinite(latest.codexGoalTokenBudget) ? latest.codexGoalTokenBudget : null,
      };
    }
    paintChip(lastGoal);
  }

  function openSheet() {
    if (!dom.sheet) return;
    if (dom.sheet.hidden) {
      const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      lastFocusedElement = activeElement && activeElement !== document.body ? activeElement : (dom.composerGoalPill || dom.chip);
    }
    setFormError();
    syncSheetForm(lastGoal || null);
    dom.sheet.setAttribute('aria-hidden', 'false');
    if (root.RagentMotion && typeof root.RagentMotion.setPresence === 'function') {
      root.RagentMotion.setPresence(dom.sheet, true, { duration: 180 });
    } else {
      dom.sheet.hidden = false;
      dom.sheet.classList.add('is-open');
    }
    focusScopeDeactivate = root.RagentFocusScope?.activate?.(dom.sheet, {
      containmentRoot: document.body,
      initialFocus: dom.objective,
      restoreFocus: () => lastFocusedElement || dom.composerGoalPill || dom.chip,
      modal: true,
      onEscape: () => closeSheet(),
    }) || null;
    backEntryId = (window.RagentBackHandler && typeof window.RagentBackHandler.push === 'function')
      ? window.RagentBackHandler.push({ id: 'goal-sheet', onBack: () => { closeSheet(); return true; } })
      : null;
    if (dom.objective && typeof dom.objective.focus === 'function') dom.objective.focus();
  }

  function closeSheet() {
    if (!dom.sheet) return;
    if (backEntryId && window.RagentBackHandler && typeof window.RagentBackHandler.pop === 'function') {
      window.RagentBackHandler.pop(backEntryId);
      backEntryId = null;
    }
    if (focusScopeDeactivate) {
      focusScopeDeactivate();
      focusScopeDeactivate = null;
      lastFocusedElement = null;
    }
    dom.sheet.setAttribute('aria-hidden', 'true');
    const restoreFocus = () => {
      if (lastFocusedElement && typeof lastFocusedElement.focus === 'function' && document.contains(lastFocusedElement)) {
        lastFocusedElement.focus();
      }
      lastFocusedElement = null;
    };
    if (root.RagentMotion && typeof root.RagentMotion.setPresence === 'function') {
      root.RagentMotion.setPresence(dom.sheet, false, { duration: 150, onAfterClose: restoreFocus });
    } else {
      dom.sheet.classList.remove('is-open', 'is-closing');
      dom.sheet.hidden = true;
      restoreFocus();
    }
  }

  async function save() {
    const sid = (typeof currentSessionId === 'string') ? currentSessionId : '';
    if (!sid || typeof updateSessionRecord !== 'function') return;
    const objective = dom.objective ? String(dom.objective.value || '').trim() : '';
    if (!objective) {
      if (lastGoal && lastGoal.objective) await clearGoal();
      else {
        armPendingGoal();
        closeSheet();
      }
      return;
    }
    const wasPending = isPendingGoalArmed(sid);
    const rawBudget = dom.tokenBudget ? String(dom.tokenBudget.value || '').trim() : '';
    const parsedBudget = rawBudget ? Number(rawBudget) : NaN;
    const payload = {
      objective,
      enabled: dom.enabled ? dom.enabled.checked : true,
      // Preserve the chase switch so editing the objective mid-chase does not
      // silently stop it; the backend resets the accounting on an intent edit.
      chasing: !!(lastGoal && lastGoal.chasing === true),
    };
    if (Number.isFinite(parsedBudget) && parsedBudget > 0) {
      payload.tokenBudget = Math.floor(parsedBudget);
    }
    closeSheet();
    try {
      await updateSessionRecord(sid, { goal: payload });
      if (wasPending) setPendingGoalArmed(sid, false);
    } catch (err) {
      console.error('[goal-ui] save failed', err);
      openSheet();
      setFormError(typeof root.ragentT === 'function'
        ? root.ragentT('goal.saveError')
        : 'Could not save the goal. Check your connection and try again.');
    }
  }

  async function adoptPendingGoalFromMessage(sessionId, objective) {
    const sid = resolveSessionId(sessionId);
    const text = typeof objective === 'string' ? objective.trim() : '';
    if (!sid || !text || !isPendingGoalArmed(sid)) return false;
    if (lastGoal && lastGoal.objective) {
      setPendingGoalArmed(sid, false);
      return false;
    }
    if (typeof updateSessionRecord !== 'function') {
      throw new Error('Goal setup is not ready');
    }
    const session = await updateSessionRecord(sid, {
      goal: {
        objective: text,
        enabled: true,
        chasing: true,
      },
    });
    setPendingGoalArmed(sid, false);
    lastGoal = (session && session.goal) ? session.goal : {
      objective: text,
      enabled: true,
      chasing: true,
    };
    paintChip(lastGoal);
    syncSheetForm(lastGoal);
    return true;
  }

  async function clearGoal({ confirm = true } = {}) {
    const sid = resolveSessionId();
    if (!sid) return;
    const hasSavedGoal = !!(lastGoal && lastGoal.objective);
    if (confirm && hasSavedGoal && typeof window.confirm === 'function') {
      const message = typeof root.ragentT === 'function'
        ? root.ragentT('goal.clearConfirm')
        : 'Clear this session goal?';
      if (!window.confirm(message && message !== 'goal.clearConfirm' ? message : 'Clear this session goal?')) return;
    }
    closeSheet();
    setPendingGoalArmed(sid, false);
    lastGoal = null;
    liveOverlay = null;
    if (dom.objective) dom.objective.value = '';
    paintChip(null);
    renderChaseControls(null);
    if (typeof updateSessionRecord === 'function') {
      try {
        await updateSessionRecord(sid, { goal: null });
      } catch (err) {
        console.error('[goal-ui] clear failed', err);
        openSheet();
        setFormError(typeof root.ragentT === 'function'
          ? root.ragentT('goal.saveError')
          : 'Could not save the goal. Check your connection and try again.');
      }
    }
  }

  root.updateGoalChip = updateGoalChip;
  root.paintGoalChipLive = paintGoalChipLive;
  root.resetGoalLiveState = resetGoalLiveState;
  root.openGoalSheet = openSheet;
  root.closeGoalSheet = closeSheet;
  root.syncGoalMenuVisibility = syncGoalMenuVisibility;
  root.armPendingGoal = armPendingGoal;
  root.isPendingGoalArmed = isPendingGoalArmed;
  root.adoptPendingGoalFromMessage = adoptPendingGoalFromMessage;

  function handleSheetKeydown(event) {
    if (!dom.sheet || dom.sheet.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeSheet();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...dom.sheet.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter((element) => element.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  if (!root.RagentFocusScope) document.addEventListener('keydown', handleSheetKeydown);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ready, { once: true });
  } else {
    ready();
  }
})(globalThis);
