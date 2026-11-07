(function () {
  'use strict';
  const RATE = 16000, MAX_SECONDS = 20;
  function wavFromSamples(chunks, count, sampleRate) {
    if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000 || count < sampleRate / 2 || count > sampleRate * MAX_SECONDS) throw new Error('invalid recording');
    const input = new Float32Array(count);
    let offset = 0;
    for (const chunk of chunks) { input.set(chunk, offset); offset += chunk.length; }
    if (offset !== count) throw new Error('invalid recording');
    const samples = Math.floor(count * RATE / sampleRate);
    const buffer = new ArrayBuffer(44 + samples * 2), view = new DataView(buffer);
    const str = (at, value) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)); };
    str(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); str(8, 'WAVEfmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, RATE, true); view.setUint32(28, RATE * 2, true); view.setUint16(32, 2, true);
    view.setUint16(34, 16, true); str(36, 'data'); view.setUint32(40, samples * 2, true);
    for (let i = 0; i < samples; i++) {
      const position = i * sampleRate / RATE;
      let value;
      if (sampleRate > RATE) {
        // Average the source interval before decimation to reduce aliasing.
        const end = Math.min((i + 1) * sampleRate / RATE, count);
        let sum = 0;
        for (let j = Math.floor(position); j < end; j++) {
          const weight = Math.min(j + 1, end) - Math.max(j, position);
          sum += (Number.isFinite(input[j]) ? input[j] : 0) * weight;
        }
        value = sum / (end - position);
      } else {
        const left = Math.floor(position), right = Math.min(left + 1, count - 1);
        value = input[left] + (input[right] - input[left]) * (position - left);
      }
      const safe = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
      view.setInt16(44 + i * 2, safe < 0 ? Math.round(safe * 32768) : Math.round(safe * 32767), true);
    }
    return new Uint8Array(buffer);
  }
  function base64(bytes) {
    let result = '';
    for (let i = 0; i < bytes.length; i += 16384) result += String.fromCharCode(...bytes.subarray(i, i + 16384));
    return btoa(result);
  }
  function create({ input, getInput, startButton, status, message, stopButton, cancelButton, context, canStart, translate, closeMenu, flush, request }) {
    let active = null;
    const snapshot = () => JSON.stringify(context());
    const label = key => translate?.(key) || key;
    const show = (key, recording) => { status.hidden = false; message.textContent = label(key); stopButton.hidden = !recording; stopButton.disabled = false; cancelButton.hidden = false; };
    const current = state => active === state && canStart() && snapshot() === state.context;
    function release(state) {
      clearInterval(state.monitor); clearTimeout(state.limit); clearTimeout(state.deadline);
      if (state.processor) { state.processor.onaudioprocess = null; try { state.processor.disconnect(); } catch {} }
      try { state.source?.disconnect(); } catch {}
      try { state.silence?.disconnect(); } catch {}
      for (const track of state.stream?.getTracks?.() || []) try { track.stop(); } catch {}
      try { state.audio?.close()?.catch?.(() => {}); } catch {}
      state.chunks = [];
    }
    function cancel() {
      const state = active; active = null;
      if (state) { state.controller.abort(); release(state); }
      status.hidden = true;
    }
    function fail(state, key) {
      if (active !== state) return;
      active = null; state.controller.abort(); release(state); show(key, false);
    }
    async function finish() {
      const state = active;
      if (!state || state.phase !== 'recording') return;
      if (!current(state)) { cancel(); return; }
      state.phase = 'transcribing';
      let audio;
      try { audio = wavFromSamples(state.chunks, state.count, state.sampleRate); }
      catch { fail(state, 'compose.computerVoice.noSpeech'); return; }
      release(state);
      show('compose.computerVoice.processing', false);
      state.monitor = setInterval(() => { if (active === state && !current(state)) cancel(); }, 250);
      state.deadline = setTimeout(() => fail(state, 'compose.computerVoice.failed'), 120000);
      try {
        const response = await request(state.path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audio: base64(audio) }), signal: state.controller.signal, cache: 'no-store' });
        if (!response.ok) throw new Error('transcription failed');
        const result = await response.json();
        if (!current(state)) { if (active === state) cancel(); return; }
        const text = typeof result?.text === 'string' ? result.text.trim() : '';
        if (!text || text.length > 10000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new Error('invalid transcript');
        const target = getInput?.() || input; flush?.(target);
        const value = target.value, separator = value && !/\s$/.test(value) ? ' ' : '';
        target.value = value + separator + text;
        target.dispatchEvent(new Event('input', { bubbles: true }));
        active = null; release(state); status.hidden = true;
      } catch (error) { if (active === state) fail(state, error?.name === 'NotAllowedError' ? 'compose.voice.permission' : 'compose.computerVoice.failed'); }
    }
    async function start() {
      closeMenu?.();
      if (active || !canStart()) return;
      window.AgentoCComposerVoice?.cancel?.();
      const binding = context();
      if (!binding?.sessionId || !navigator.mediaDevices?.getUserMedia || !(window.AudioContext || window.webkitAudioContext)) {
        show('compose.computerVoice.unavailable', false); return;
      }
      const state = { context: JSON.stringify(binding), path: `/api/sessions/${encodeURIComponent(binding.sessionId)}/local-voice-recognition`,
        controller: new AbortController(), phase: 'checking', chunks: [], count: 0 };
      active = state;
      state.monitor = setInterval(() => { if (active === state && !current(state)) cancel(); }, 250);
      state.deadline = setTimeout(() => fail(state, 'compose.computerVoice.unavailable'), 15000);
      show('compose.computerVoice.checking', false);
      try {
        const response = await request(state.path, { signal: state.controller.signal, cache: 'no-store' });
        const available = response.ok && await response.json();
        if (!current(state)) { if (active === state) cancel(); return; }
        clearTimeout(state.deadline); state.deadline = null;
        if (!available || available.available !== true || available.destination !== 'connected_computer' || available.maxSeconds !== MAX_SECONDS) {
          fail(state, 'compose.computerVoice.unavailable'); return;
        }
        state.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 }, video: false });
        if (!current(state)) { if (active === state) cancel(); else release(state); return; }
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        state.audio = new AudioContext(); state.sampleRate = state.audio.sampleRate;
        if (!Number.isFinite(state.sampleRate) || state.sampleRate < 8000 || state.sampleRate > 192000) throw new Error('unsupported sample rate');
        state.source = state.audio.createMediaStreamSource(state.stream);
        state.processor = state.audio.createScriptProcessor(4096, 1, 1);
        state.silence = state.audio.createGain(); state.silence.gain.value = 0;
        state.processor.onaudioprocess = event => {
          if (!current(state) || state.phase !== 'recording') return;
          const data = event.inputBuffer.getChannelData(0);
          const length = Math.min(data.length, Math.floor(state.sampleRate * MAX_SECONDS) - state.count);
          if (length > 0) { state.chunks.push(new Float32Array(data.subarray(0, length))); state.count += length; }
          if (state.count >= state.sampleRate * MAX_SECONDS) void finish();
        };
        state.source.connect(state.processor); state.processor.connect(state.silence); state.silence.connect(state.audio.destination);
        await state.audio.resume();
        if (!current(state)) { if (active === state) cancel(); return; }
        state.phase = 'recording'; show('compose.computerVoice.recording', true);
        state.limit = setTimeout(() => { if (active === state) void finish(); }, MAX_SECONDS * 1000);
      } catch (error) { if (active === state) fail(state, error?.name === 'NotAllowedError' ? 'compose.voice.permission' : 'compose.computerVoice.failed'); }
    }
    startButton.addEventListener('click', () => { void start(); });
    stopButton.addEventListener('click', () => { void finish(); });
    cancelButton.addEventListener('click', cancel);
    window.addEventListener('pagehide', cancel);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') cancel(); });
    return { start, cancel };
  }
  window.AgentoCComputerVoiceInput = Object.freeze({ create, wavFromSamples });
  const input = document.getElementById('msgInput'), startButton = document.getElementById('composerComputerVoiceBtn');
  const status = document.getElementById('composerComputerVoiceStatus'), message = document.getElementById('composerComputerVoiceMessage');
  const stopButton = document.getElementById('composerComputerVoiceStop'), cancelButton = document.getElementById('composerComputerVoiceCancel');
  if (!input || !startButton || !status || !message || !stopButton || !cancelButton) return;
  window.AgentoCComputerVoice = create({ input, startButton, status, message, stopButton, cancelButton,
    getInput: () => window.AgentoCComposerFullscreen?.getInput?.() || input,
    context: () => ({ sessionId: currentSessionId, tool: selectedTool,
      provider: typeof getComposerRuntimeSelectedProvider === 'function' ? getComposerRuntimeSelectedProvider() : '',
      target: window.AgentoCTargetRuntime?.getActiveTarget?.()?.targetId || '',
      navigation: typeof window.getSessionNavigationGeneration === 'function' ? window.getSessionNavigationGeneration() : 0 }),
    canStart: () => Boolean(currentSessionId) && !input.disabled && !input.readOnly &&
      !(typeof hasPendingComposerSend === 'function' && hasPendingComposerSend()),
    translate: key => window.agentocT?.(key) || key,
    closeMenu: () => window.AgentoCComposerAddMenu?.close?.(),
    flush: target => window.AgentoCMarkdownComposer?.flush?.(target),
    request: (path, options) => (window.agentocFetch || window.fetch)(path, { credentials: 'same-origin', ...options }),
  });
})();
