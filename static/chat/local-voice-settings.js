(function attachLocalVoiceSettings(root) {
  "use strict";

  const elements = {
    section: root.document?.getElementById("localVoiceSettingsSection"),
    title: root.document?.getElementById("localVoiceSettingsTitle"),
    optionTitle: root.document?.getElementById("localVoiceSettingsOptionTitle"),
    optionNote: root.document?.getElementById("localVoiceSettingsOptionNote"),
    enabled: root.document?.getElementById("localVoiceRecognitionEnabled"),
    status: root.document?.getElementById("localVoiceSettingsStatus"),
  };
  const state = { value: null, pending: false, pendingValue: null, error: "" };

  function isZh() {
    const language = String(root.agentocGetActiveUiLanguage?.() || "").toLowerCase();
    return language.startsWith("zh");
  }

  function copy() {
    return isZh() ? {
      title: "电脑语音识别",
      optionTitle: "在此电脑运行语音识别",
      note: "开启后，Ragent 会在本机启动 Whisper 并保持模型运行。只有你在语音输入时选择电脑识别，录音才会发送到此电脑。",
      loading: "正在读取语音识别设置…",
      notInstalled: "尚未安装 Whisper。重新运行 Ragent 安装程序并选择“安装本地语音识别”。",
      disabled: "已关闭。Whisper 不会运行。",
      starting: "正在加载本地模型…",
      ready: "本地模型已就绪；仅在你选择电脑识别时处理录音。",
      retrying: "设置已开启，Ragent 正在启动本地模型。",
      loadFailed: "无法读取本机语音识别设置。",
      saveFailed: "无法更改语音识别设置，请重试。",
      aria: "启用电脑语音识别",
    } : {
      title: "Computer voice recognition",
      optionTitle: "Run voice recognition on this computer",
      note: "When enabled, Ragent starts Whisper and keeps the model loaded. Audio is sent here only when you choose computer recognition for voice input.",
      loading: "Reading voice recognition settings…",
      notInstalled: "Whisper is not installed. Run Ragent Setup again and choose “Install local voice recognition.”",
      disabled: "Off. Whisper will not run.",
      starting: "Loading the local model…",
      ready: "The local model is ready. Audio is processed only when you choose computer recognition.",
      retrying: "Enabled. Ragent is starting the local model.",
      loadFailed: "Could not read this computer’s voice recognition settings.",
      saveFailed: "Could not change the voice recognition setting. Try again.",
      aria: "Enable computer voice recognition",
    };
  }

  function canManage() {
    return root.__AGENTOC_BOOTSTRAP__?.auth?.role === "owner";
  }

  function setStatus(message = "", tone = "") {
    if (!elements.status) return;
    elements.status.hidden = !message;
    elements.status.textContent = message;
    elements.status.dataset.tone = tone;
  }

  function render() {
    const text = copy();
    if (elements.section) elements.section.hidden = !canManage();
    if (elements.title) elements.title.textContent = text.title;
    if (elements.optionTitle) elements.optionTitle.textContent = text.optionTitle;
    if (elements.enabled) {
      const enabled = state.pending ? state.pendingValue : state.value?.enabled && state.value?.installed;
      elements.enabled.checked = Boolean(enabled);
      elements.enabled.disabled = !canManage() || state.pending || !state.value || !state.value.installed;
      elements.enabled.setAttribute("aria-label", text.aria);
    }
    if (!state.value) {
      if (elements.optionNote) elements.optionNote.textContent = text.note;
      if (!state.pending) setStatus(state.error || text.loading, state.error ? "error" : "");
      return;
    }
    if (!state.value.installed) {
      if (elements.optionNote) elements.optionNote.textContent = text.notInstalled;
      setStatus(state.error, state.error ? "error" : "");
      return;
    }
    if (elements.optionNote) elements.optionNote.textContent = text.note;
    if (state.error) setStatus(state.error, "error");
    else if (state.pending && state.pendingValue) setStatus(text.starting);
    else if (!state.value.enabled) setStatus(text.disabled);
    else if (state.value.ready) setStatus(text.ready);
    else setStatus(state.pending ? text.starting : text.retrying);
  }

  async function request(options = {}) {
    if (typeof root.fetchJsonOrRedirect === "function") return root.fetchJsonOrRedirect("/api/local-voice-settings", options);
    const response = await root.fetch("/api/local-voice-settings", options);
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(payload?.error || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  async function refresh() {
    if (!canManage()) { render(); return; }
    state.error = "";
    try { state.value = await request({ cache: "no-store", revalidate: false }); }
    catch { state.value = null; state.error = copy().loadFailed; }
    render();
  }

  async function save(enabled) {
    if (state.pending || !state.value?.installed || state.value.enabled === enabled) return;
    state.pending = true;
    state.pendingValue = enabled;
    state.error = "";
    render();
    try {
      state.value = await request({
        method: "PATCH",
        headers: { "Content-Type": "application/json", "Idempotency-Key": root.crypto?.randomUUID?.() || `voice-${Date.now()}` },
        body: JSON.stringify({ enabled }),
      });
    } catch {
      state.error = copy().saveFailed;
      try { state.value = await request({ cache: "no-store", revalidate: false }); } catch {}
    } finally {
      state.pending = false;
      state.pendingValue = null;
      render();
    }
  }

  if (!elements.section || !elements.enabled) return;
  elements.enabled.addEventListener("change", () => void save(elements.enabled.checked));
  root.addEventListener("agentoc:localechange", render);
  root.addEventListener("agentoc:authchange", () => void refresh());
  render();
  void refresh();
  root.AgentoCLocalVoiceSettings = Object.freeze({ refresh });
})(window);
