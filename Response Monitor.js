// Response Monitor v1.3.3
// - 失败/空内容/成功生成 独立蜂鸣提示（含 iOS 振荡器兜底）、Android 振动
// - text/html/Cloudflare 错误页判失败
// - 成功提示支持“仅在后台生效”
// - 系统通知(需权限；iOS 仅 PWA 可用)
// - 标题闪烁提醒（可开关）
// - 扩展面板按钮/输入统一样式与分类排版（双栏设计，同行输入框）
// - 完整解析流式 SSE/JSON、隔离请求状态和可选诊断日志

(() => {
  const MODULE = 'fail_notification';

  // ---------- 内容有效性深度探测 ----------
  // Fetch chunks have arbitrary boundaries. Only examine complete responses.
  function hasVisibleText(value) {
    return typeof value === 'string' && value.trim().length > 0;
  }

  function hasTextParts(parts) {
    return Array.isArray(parts) && parts.some(part =>
      typeof part === 'string'
        ? hasVisibleText(part)
        : part && typeof part === 'object' &&
          (part.type === 'text' || part.type === 'output_text' || part.type === undefined) &&
          hasVisibleText(part.text)
    );
  }

  // Only generated output counts (not roles, usage, reasoning or tool calls).
  function hasGeneratedContent(data) {
    if (!data || typeof data !== 'object' || data.error) return false;

    if (Array.isArray(data.choices)) {
      return data.choices.some(choice => {
        if (!choice || (choice.index != null && choice.index !== 0)) return false;
        const delta = choice.delta;
        const message = choice.message;
        return hasVisibleText(choice.text) ||
          hasVisibleText(delta?.text) ||
          hasVisibleText(delta?.content) ||
          hasTextParts(delta?.content) ||
          hasVisibleText(message?.content) ||
          hasTextParts(message?.content);
      });
    }

    if (Array.isArray(data.candidates)) {
      return data.candidates.some((candidate, index) =>
        index === 0 && hasTextParts(candidate?.content?.parts)
      );
    }

    if (Array.isArray(data.output)) {
      return data.output.some(item =>
        item?.type === 'message' && hasTextParts(item.content)
      );
    }

    // Anthropic, Cohere, Ollama and other text-generation backends.
    return hasVisibleText(data.delta?.text) ||
      hasVisibleText(data.delta?.message?.content?.text) ||
      hasVisibleText(data.content_block?.type === 'text' ? data.content_block.text : null) ||
      hasVisibleText(data.message?.content) ||
      hasTextParts(data.message?.content) ||
      hasVisibleText(data.response) ||
      hasVisibleText(data.generated_text) ||
      hasVisibleText(data.text) ||
      hasVisibleText(data.reply) ||
      hasVisibleText(data.content) ||
      hasTextParts(data.content) ||
      hasVisibleText(data.results?.[0]?.text) ||
      hasVisibleText(data.token?.text);
  }

  // Return an error verdict as well as text presence. HTTP 200 is not proof
  // of a successful generation when the stream contains an error event.
  function analyzeResponseBody(body, contentType = '') {
    const raw = typeof body === 'string' ? body.replace(/^\uFEFF/, '') : '';
    if (!raw.trim()) return { hasContent: false, isError: false, reason: 'empty-body' };
    if (isBadCT(contentType) || looksLikeHtml(raw)) {
      return { hasContent: false, isError: true, reason: 'html-error-page' };
    }

    const isSse = /text\/event-stream/i.test(contentType) ||
      /(?:^|\r?\n)(?:data|event|id|retry):|(?:^|\r?\n):/m.test(raw);
    if (isSse) {
      const blocks = raw.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/);
      let sawContent = false;
      let sawError = false;
      let sawData = false;
      for (const block of blocks) {
        const lines = block.split('\n');
        let eventName = '';
        const dataLines = [];
        for (const line of lines) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim().toLowerCase();
          if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
          else if (line === 'data') dataLines.push('');
        }
        if (!dataLines.length) continue; // comments, pings and event-only frames
        sawData = true;
        const payload = dataLines.join('\n').trim();
        if (!payload || payload === '[DONE]') continue;
        if (eventName === 'error') { sawError = true; continue; }

        try {
          const value = JSON.parse(payload);
          if (value?.error || value?.type === 'error') sawError = true;
          else if (hasGeneratedContent(value)) sawContent = true;
        } catch {
          // Only explicitly labelled plain-text tokens count as output.
          if (eventName === 'token' && hasVisibleText(payload)) sawContent = true;
        }
      }
      return {
        hasContent: sawContent,
        isError: sawError,
        reason: sawError ? 'sse-error' : sawContent ? 'sse-text' : sawData ? 'sse-no-text' : 'sse-no-data',
      };
    }

    const trimmed = raw.trim();
    try {
      const value = JSON.parse(trimmed);
      const isError = Boolean(value?.error || value?.type === 'error');
      const hasContent = typeof value === 'string' ? hasVisibleText(value) : hasGeneratedContent(value);
      return { hasContent, isError, reason: isError ? 'json-error' : hasContent ? 'json-text' : 'json-no-text' };
    } catch {
      // Malformed JSON must never be mistaken for a plain-text reply.
      if (/^[\[{]/.test(trimmed)) {
        return { hasContent: false, isError: false, reason: 'invalid-json' };
      }
      return { hasContent: hasVisibleText(trimmed), isError: false, reason: 'plain-text' };
    }
  }

  // ---------- HTML 错误页识别 ----------
  function isBadCT(ct = '') {
    ct = String(ct).toLowerCase();
    return ct.includes('text/html');
  }
  function looksLikeHtml(s = '') {
    if (!s) return false;
    const head = s.slice(0, 256).toLowerCase().trim();
    return head.startsWith('<!doctype html') || head.startsWith('<html') || head.includes('cloudflare');
  }

  // ---------- 运行环境 ----------
  const IOS =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.userAgentData?.platform === 'iOS') ||
    (/Mac/.test(navigator.platform) && navigator.maxTouchPoints > 1);
  const VIB_SUPPORTED = typeof navigator.vibrate === 'function' && !IOS;

  const NOTIF_SUPPORTED = 'Notification' in window;
  const SW_SUPPORTED = 'serviceWorker' in navigator;
  const IS_STANDALONE =
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    (typeof navigator.standalone === 'boolean' && navigator.standalone);
  function iosNotifUsable() {
    if (!IOS) return true;
    return NOTIF_SUPPORTED && SW_SUPPORTED && IS_STANDALONE;
  }

  // ---------- ST 上下文 & 持久化 ----------
  const ctx = (globalThis.SillyTavern?.getContext?.() ?? globalThis);
  const extensionSettings =
    ctx.extension_settings ?? ctx.extensionSettings ?? (globalThis.extension_settings ||= {});
  const saveSettingsDebounced =
    ctx.saveSettingsDebounced ?? globalThis.saveSettingsDebounced ?? (() => {});

  const defaults = Object.freeze({
    enabled: true,
    alertOnError: true,
    alertOnEmpty: true,
    debug: false,
    
    alertOnSuccess: false,      
    successBackgroundOnly: false, 
    
    sound: true,                
    volume: 0.9,
    soundUrl: './fail.mp3',
    
    successVolume: 0.4,         
    successSoundUrl: './success.mp3', 

    vibrate: false,
    vibMs: 180,
    vibRepeat: 2,

    notify: false,
    notifyTitle: 'SillyTavern: 生成失败',
    notifyBody: '可能是网络/接口异常或空响应，请检查。',
    notifyRequireInteraction: false,

    titleBlink: true,
    titleBlinkTimes: 6,
    titleBlinkGap: 600
  });

  function getSettings() {
    if (!extensionSettings[MODULE]) extensionSettings[MODULE] = structuredClone(defaults);
    for (const k of Object.keys(defaults)) {
      if (!Object.hasOwn(extensionSettings[MODULE], k)) extensionSettings[MODULE][k] = defaults[k];
    }
    return extensionSettings[MODULE];
  }
  const S = getSettings();
  if (!VIB_SUPPORTED) S.vibrate = false;

  // ---------- 标题闪烁 ----------
  function blinkTitle(msg, times = 6, gap = 600) {
    try {
      const orig = document.title;
      let left = Math.max(1, Math.round(times)), on = false;
      const timer = setInterval(() => {
        document.title = on ? orig : (msg || '[异常]');
        on = !on;
        if (--left <= 0) { clearInterval(timer); document.title = orig; }
      }, Math.max(200, Math.round(gap)));
    } catch {}
  }

  // ---------- 音频 & 震动 ----------
  let audioCtx, failBuffer = null, successBuffer = null, lastBeep = 0, unlocked = false;

  function ensureAudio() {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  }

  async function preload() {
    try {
      ensureAudio();
      const fUrl = new URL(S.soundUrl || './fail.mp3', import.meta.url).href;
      const sUrl = new URL(S.successSoundUrl || './success.mp3', import.meta.url).href;

      const [fRes, sRes] = await Promise.all([
          fetch(fUrl, { cache: 'no-store' }).catch(() => null),
          fetch(sUrl, { cache: 'no-store' }).catch(() => null)
      ]);

      if (fRes) {
          const fArr = await fRes.arrayBuffer();
          audioCtx.decodeAudioData(fArr, b => failBuffer = b, () => failBuffer = null);
      }
      if (sRes) {
          const sArr = await sRes.arrayBuffer();
          audioCtx.decodeAudioData(sArr, b => successBuffer = b, () => successBuffer = null);
      }
    } catch {}
  }

  function unlockOnce() {
    try {
      ensureAudio();
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      g.gain.value = 0; o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + 0.01);
      unlocked = true;
      preload();
    } catch {}
    window.removeEventListener('pointerdown', unlockOnce);
    window.removeEventListener('click', unlockOnce, true);
    window.removeEventListener('touchstart', unlockOnce, { capture: true });
    window.removeEventListener('keydown', unlockOnce);
  }
  window.addEventListener('pointerdown', unlockOnce, { once: true });
  window.addEventListener('click', unlockOnce, { once: true, capture: true });
  window.addEventListener('touchstart', unlockOnce, { once: true, passive: true, capture: true });
  window.addEventListener('keydown', unlockOnce, { once: true });

  function oscBeep(durMs = 180, freq = 880, vol = 0.9) {
    try {
      ensureAudio();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      o.connect(g); g.connect(audioCtx.destination);
      const t0 = audioCtx.currentTime;
      g.gain.setValueAtTime(vol, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + durMs / 1000);
      o.start(); o.stop(t0 + durMs / 1000);
    } catch {}
  }

  function playSound(type = 'fail', forcePlay = false) {
    const now = Date.now();
    if (!S.enabled) return;
    if (now - lastBeep < 400 && !forcePlay) return;
    lastBeep = now;

    const isFail = type === 'fail';
    const isSuccess = type === 'success';
    
    if (isFail && !S.sound && !forcePlay) return;
    if (isSuccess && !S.alertOnSuccess && !forcePlay) return;

    if (isSuccess && S.successBackgroundOnly && !document.hidden && !forcePlay) {
        return; 
    }

    const volSetting = isFail ? S.volume : S.successVolume;
    const vol = Math.max(0, Math.min(1, Number(volSetting) || 0.9));
    const urlSetting = isFail ? S.soundUrl : S.successSoundUrl;
    const defaultUrl = isFail ? './fail.mp3' : './success.mp3';
    const url = new URL(urlSetting || defaultUrl, import.meta.url).href;
    const buffer = isFail ? failBuffer : successBuffer;
    const fallbackFreq = isFail ? 880 : 1320; 
    const fallbackDur = isFail ? Math.max(120, Math.min(1000, Math.round(S.vibMs || 180))) : 120;

    if (document.hidden && !unlocked) {
      oscBeep(fallbackDur, fallbackFreq, vol);
      return;
    }

    if (buffer) {
      try {
        ensureAudio();
        const src = audioCtx.createBufferSource();
        const gain = audioCtx.createGain();
        gain.gain.value = vol;
        src.buffer = buffer;
        src.connect(gain); gain.connect(audioCtx.destination);
        src.start();
        return;
      } catch {}
    }

    try {
      const a = new Audio(url);
      a.playsInline = true;
      a.preload = 'auto';
      a.volume = vol;
      const p = a.play();
      if (p && p.catch) p.catch(() => {
        oscBeep(fallbackDur, fallbackFreq, vol);
      });
      return;
    } catch {}

    oscBeep(fallbackDur, fallbackFreq, vol);
  }

  function vibrate() {
    if (!S.enabled || !S.vibrate || !VIB_SUPPORTED) return;
    const d  = Math.max(50, Math.min(2000, Math.round(Number(S.vibMs) || 180)));
    const n  = Math.max(1, Math.min(5, Math.round(Number(S.vibRepeat) || 1)));
    const gap = 100;
    const pattern = [];
    for (let i = 0; i < n; i++) { if (i) pattern.push(gap); pattern.push(d); }
    try { navigator.vibrate(pattern); } catch {}
  }

  // ---------- 系统通知 ----------
  async function ensureNotifPermission() {
    if (!NOTIF_SUPPORTED) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    try {
      const p = await Notification.requestPermission();
      return p === 'granted';
    } catch { return false; }
  }

  async function sendNotification(title, body) {
    if (!S.enabled || !S.notify) return;
    if (!NOTIF_SUPPORTED) return;
    if (IOS && !iosNotifUsable()) return;

    const ok = await ensureNotifPermission();
    if (!ok) return;

    const options = {
      body: body || '',
      tag: 'st-fail-' + Date.now(),
      renotify: true,
      requireInteraction: !!S.notifyRequireInteraction,
    };

    try {
      const reg = await navigator.serviceWorker?.getRegistration?.();
      if (reg?.showNotification) { await reg.showNotification(title || 'SillyTavern: 生成失败', options); return; }
    } catch {}
    try { new Notification(title || 'SillyTavern: 生成失败', options); } catch {}
  }

  if (!IOS) preload();

  // ---------- 核心警报触发器 ----------
  function triggerFailAlert(titlePrefix = '异常', customBody = null) {
      if (!S.enabled) return;
      playSound('fail');
      vibrate();
      sendNotification(S.notifyTitle, customBody || S.notifyBody);
      if (S.titleBlink) blinkTitle(`[${titlePrefix}] ` + document.title, S.titleBlinkTimes, S.titleBlinkGap);
  }

  function triggerSuccessAlert(isTest = false) {
      if (!S.enabled) return;
      playSound('success', isTest);
  }

  // ---------- 一轮生成侦测 ----------
  const CFG = { armMs: 20000 };
  let armedUntil = 0;
  let activeRound = null;
  let roundSerial = 0;

  function arm() { armedUntil = Date.now() + CFG.armMs; }
  const isArmed = () => Date.now() <= armedUntil;
  function startRound() {
    const round = { id: ++roundSerial, hasContent: false, aborted: false, finished: false, status: null };
    activeRound = round;
    return round;
  }
  function markContent(round) { if (round && !round.finished) round.hasContent = true; }
  function markAbort(round) { if (round && !round.finished) round.aborted = true; }

  function endRound(round, isRequestOk, reason = '') {
    if (!round || round.finished) return;
    round.finished = true;
    if (activeRound !== round) return; // stale requests cannot finish newer ones
    activeRound = null;

    const outcome = round.aborted ? 'aborted'
      : !isRequestOk ? 'request-error'
      : !round.hasContent ? 'empty'
      : 'success';
    if (S.debug) {
      // Never log the prompt, response text, headers or API key.
      console.info('[Response Monitor] generation #' + round.id, {
        status: round.status, outcome, reason, hasContent: round.hasContent,
      });
    }
    if (round.aborted) return;
    if (outcome === 'request-error' && S.alertOnError) triggerFailAlert('请求报错');
    else if (outcome === 'empty' && S.alertOnEmpty) triggerFailAlert('返回空内容');
    else if (outcome === 'success' && S.alertOnSuccess) triggerSuccessAlert();
  }

  globalThis.failNotificationIntercept = function (payload) {
    try { unlockOnce(); } catch {}
    arm();
    return payload;
  };

  // Suppress notifications when generation is manually stopped.
  const events = ctx.eventSource;
  const eventTypes = ctx.eventTypes;
  if (events?.on && eventTypes?.GENERATION_STOPPED) {
    events.on(eventTypes.GENERATION_STOPPED, () => markAbort(activeRound));
  }

  const GEN_ALLOW = [
    /\/api\/openai\/chat\/completions/i, /\/api\/openai\/completions/i,
    /\/api\/chat\/completions/i, /\/api\/extra\/generate/i,
    /\/api\/textgen.*generate/i, /\/api\/kobold.*generate/i,
    /\/api\/ollama.*generate/i,  /\/api\/vllm.*generate/i,
    /\/api\/claude.*(chat|complete)/i, /\/api\/gemini.*(chat|generate)/i,
    /\/api\/.*\/generate/i,
    /\/api\/.*(chat|completions|generate)/i
  ];
  const GEN_DENY = [/\/api\/(characters|chats|history|profile|settings|quick|preset|images?|assets?)\b/i];
  const isGen = (url, method) =>
    method === 'POST' && !GEN_DENY.some(r => r.test(url)) && GEN_ALLOW.some(r => r.test(url));

  // --- Fetch Hook ---
  if (typeof window.fetch === 'function' && !window.fetch.__fn120) {
    const orig = window.fetch;
    window.fetch = async (...args) => {
      const [input, init] = args;
      const url = typeof input === 'string' ? input : (input?.url || '');
      const method = String(init?.method || input?.method || 'GET').toUpperCase();
      const watch = isArmed() && isGen(url, method);
      const round = watch ? startRound() : null;

      try {
        const res = await orig(...args);
        if (!watch) return res;
        const ct = res.headers?.get?.('content-type') || '';
        const isRequestOk = !!res.ok && !isBadCT(ct);
        round.status = res.status;
        try {
          // Clone the response without consuming or altering SillyTavern's stream.
          // Await the complete body, never inspect incomplete transport chunks.
          res.clone().text().then(body => {
            const verdict = analyzeResponseBody(body, ct);
            if (verdict.hasContent) markContent(round);
            endRound(round, isRequestOk && !verdict.isError, verdict.reason);
          }).catch(err => {
            if (err?.name === 'AbortError' || init?.signal?.aborted || input?.signal?.aborted) {
              markAbort(round);
            }
            endRound(round, false, 'stream-read-error');
          });
        } catch {
          endRound(round, false, 'response-clone-error');
        }
        return res;
      } catch (err) {
        if (watch) {
          if (err?.name === 'AbortError' || err?.code === 20) markAbort(round);
          endRound(round, false, 'fetch-error');
        }
        throw err;
      }
    };
    window.fetch.__fn120 = true;
  }

  // --- XHR Hook ---
  const XHR = window.XMLHttpRequest;
  if (XHR && !XHR.prototype.__fn120) {
    const _open = XHR.prototype.open;
    const _send = XHR.prototype.send;
    XHR.prototype.open = function (method, url, ...rest) {
      this.__meta = { method: String(method || 'GET').toUpperCase(), url: String(url || '') };
      return _open.call(this, method, url, ...rest);
    };
    XHR.prototype.send = function (...args) {
      try {
        const { method, url } = this.__meta || {};
        if (isArmed() && isGen(url, method)) {
          const round = startRound();
          this.addEventListener('loadend', () => {
            let txt = '';
            try { txt = typeof this.responseText === 'string' ? this.responseText : ''; } catch {}
            const ct = (this.getResponseHeader && this.getResponseHeader('content-type')) || '';
            const verdict = analyzeResponseBody(txt, ct);
            round.status = this.status;
            if (verdict.hasContent) markContent(round);
            const ok = this.status >= 200 && this.status < 300 && !isBadCT(ct);
            endRound(round, ok && !verdict.isError, verdict.reason);
          });
          this.addEventListener('error', () => endRound(round, false, 'xhr-error'));
          this.addEventListener('timeout', () => endRound(round, false, 'xhr-timeout'));
          this.addEventListener('abort', () => { markAbort(round); endRound(round, false, 'xhr-abort'); });
        }
      } catch (err) {
        if (S.debug) console.warn('[Response Monitor] XHR hook error', err?.name);
      }
      return _send.apply(this, args);
    };
    XHR.prototype.__fn120 = true;
  }

  // --- 全局错误兜底 ---
  if (!window.__fnGlobalErrHook) {
    window.__fnGlobalErrHook = true;

    function errToString(e) {
      try {
        if (!e) return '';
        if (typeof e === 'string') return e;
        if (e.message) return String(e.message);
        if (e.reason && typeof e.reason === 'string') return e.reason;
        return JSON.stringify(e);
      } catch { return ''; }
    }

    function looksLikeRateLimit(s) {
      s = (s || '').toLowerCase();
      return s.includes('too many requests')
          || s.includes('"code":429') || s.includes(' 429')
          || s.includes('no capacity available')
          || s.includes('rate limit') || s.includes('overloaded')
          || s.includes('capacity');
    }

    let lastGlobalErrAt = 0;
    function triggerFailIfArmed(reasonStr) {
      if (typeof isArmed !== 'function' || !isArmed() || !S.alertOnError) return; 
      const now = Date.now();
      if (now - lastGlobalErrAt < 400) return;
      lastGlobalErrAt = now;

      if (activeRound) {
        try { endRound(activeRound, false, 'global-error'); } catch {}
      } else {
        triggerFailAlert('报错', reasonStr);
      }
    }

    window.addEventListener('unhandledrejection', (ev) => {
      try {
        const s = errToString(ev?.reason ?? ev);
        if (looksLikeRateLimit(s)) triggerFailIfArmed(s);
      } catch {}
    });

    window.addEventListener('error', (ev) => {
      try {
        const s = errToString(ev?.error ?? ev?.message ?? '');
        if (looksLikeRateLimit(s)) triggerFailIfArmed(s);
      } catch {}
    });
  }

  // ---------- 扩展管理页 UI ----------
  function makeCheckbox(label, key) {
    const wrap = document.createElement('label');
    wrap.className = 'checkbox_label';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!S[key];
    input.addEventListener('change', () => { S[key] = input.checked; saveSettingsDebounced(); });
    wrap.append(input, document.createTextNode(' ' + label));
    return wrap;
  }
  
  function makeRange(label, key, min, max, step) {
    const wrap = document.createElement('div');
    const span = document.createElement('span');
    span.textContent = `${label}:`;
    const input = document.createElement('input');
    input.type = 'range'; input.min = min; input.max = max; input.step = step;
    input.value = Number(S[key]);
    const val = document.createElement('span');
    val.style.marginLeft = '8px'; val.textContent = String(S[key]);
    input.addEventListener('input', () => {
      S[key] = Number(input.value);
      val.textContent = String(S[key]);
      saveSettingsDebounced();
    });
    wrap.append(span, input, val);
    return wrap;
  }
  
  function makeNumber(label, key, min, max, step = 1) {
    const wrap = document.createElement('div');
    const span = document.createElement('span');
    span.textContent = `${label}:`;
    span.style.marginRight = '8px';
    const input = document.createElement('input');
    input.type = 'number';
    input.min = String(min); input.max = String(max); input.step = String(step);
    input.value = String(S[key] ?? '');
    input.style.width = '120px';
    input.addEventListener('change', () => {
      let v = Number(input.value);
      if (Number.isNaN(v)) v = defaults[key];
      v = Math.max(min, Math.min(max, v));
      S[key] = v;
      input.value = String(v);
      saveSettingsDebounced();
    });
    wrap.append(span, input);
    return wrap;
  }
  
  // 【修改】：使用 Flex 布局，让文字和输入框在同一行
  function makeTextInline(label, key, placeholder = '') {
    const wrap = document.createElement('div');
    wrap.style.display = 'flex';
    wrap.style.alignItems = 'center';
    wrap.style.marginTop = '6px';
    
    const span = document.createElement('span');
    span.textContent = `${label}:`;
    span.style.marginRight = '8px';
    span.style.whiteSpace = 'nowrap';
    
    const input = document.createElement('input');
    input.type = 'text'; 
    input.style.flex = '1';
    input.placeholder = placeholder; input.value = S[key] || '';
    input.addEventListener('change', () => {
      S[key] = input.value || placeholder;
      saveSettingsDebounced();
      if (!IOS || unlocked) preload();
    });
    
    wrap.append(span, input);
    return wrap;
  }

  // 保留原来的 makeText 用于不适合同一行的场景（比如长通知正文）
  function makeText(label, key, placeholder = '') {
    const wrap = document.createElement('div');
    const span = document.createElement('span');
    span.textContent = `${label}:`;
    const input = document.createElement('input');
    input.type = 'text'; input.style.width = '90%';
    input.placeholder = placeholder; input.value = S[key] || '';
    input.addEventListener('change', () => {
      S[key] = input.value || placeholder;
      saveSettingsDebounced();
      if (!IOS || unlocked) preload();
    });
    wrap.append(span, input);
    return wrap;
  }

  function makeDivider(title) {
    const div = document.createElement('div');
    div.style.marginTop = '12px';
    div.style.marginBottom = '6px';
    div.style.fontWeight = 'bold';
    div.style.borderBottom = '1px solid var(--SmartThemeBorderColor, #ccc)';
    div.style.paddingBottom = '4px';
    div.textContent = title;
    return div;
  }

  function injectFnStyles() {
    if (document.getElementById('fn_styles')) return;
    const st = document.createElement('style');
    st.id = 'fn_styles';
    st.textContent = `
    #fn_inline_drawer .fn-row{
      display:flex; flex-wrap:wrap; align-items:center;
      gap:8px; margin:6px 0;
    }
    #fn_inline_drawer .fn-row > *{
      flex:0 0 auto; min-width:max-content;
    }
    #fn_inline_drawer .menu_button{
      height:28px; line-height:28px; padding:0 12px; margin:0 8px 0 0;
      white-space:nowrap; flex:0 0 auto; min-width:max-content;
      cursor:pointer;
    }
    #fn_inline_drawer label.checkbox_label{
      display:flex; align-items:center; gap:6px; margin:6px 0;
      white-space:nowrap; flex:0 0 auto; min-width:max-content;
      cursor:pointer;
    }
    #fn_inline_drawer input[type="text"],
    #fn_inline_drawer input[type="number"]{
      height:28px;
    }
    .fn-trigger-container {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      margin-top: 8px;
    }
    .fn-trigger-col {
      flex: 1 1 auto;
      padding-left: 10px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .fn-col-fail { border-left: 3px solid rgba(255, 77, 79, 0.6); }
    .fn-col-success { border-left: 3px solid rgba(82, 196, 26, 0.6); }
    `;
    document.head.appendChild(st);
  }

  function makeBtn(text, onclick) {
    const btn = document.createElement('button');
    btn.className = 'menu_button';
    btn.textContent = text;
    btn.addEventListener('click', onclick);
    return btn;
  }

  function makeTestRow() {
    const row = document.createElement('div');
    row.className = 'fn-row';
    const btnFail = makeBtn('测试失败报警', () => {
        triggerFailAlert('测试', '这是一个失败测试警报。');
    });
    const btnSuccess = makeBtn('测试成功提示音', () => {
        if (S.alertOnSuccess) triggerSuccessAlert(true);
        else alert('请先勾选上方的“生成成功时播放提示音”');
    });
    row.append(btnFail, btnSuccess);
    return row;
  }

  function makeNotifRow() {
    const row = document.createElement('div');
    row.className = 'fn-row';
    row.append(
      makeBtn('请求通知权限', async () => { await ensureNotifPermission(); }),
      makeBtn('测试通知', () => sendNotification(S.notifyTitle, '[测试] ' + S.notifyBody))
    );
    return row;
  }

  function mountSettingsUI() {
    const host = document.getElementById('extensions_settings');
    if (!host || document.getElementById('fn_inline_drawer')) return;

    injectFnStyles();

    const drawer = document.createElement('div');
    drawer.className = 'inline-drawer';
    drawer.id = 'fn_inline_drawer';

    const header = document.createElement('div');
    header.className = 'inline-drawer-toggle inline-drawer-header';
    const title = document.createElement('b');
    title.textContent = '响应监听助手';
    const icon = document.createElement('div');
    icon.classList.add('inline-drawer-icon','fa-solid','fa-circle-chevron-down','down');
    header.append(title, icon);

    const content = document.createElement('div');
    content.className = 'inline-drawer-content';

    // 1. 触发条件
    content.append(makeDivider('触发条件 (拦截侦测)'));
    const triggersWrap = document.createElement('div');
    triggersWrap.className = 'fn-trigger-container';

    const colFail = document.createElement('div');
    colFail.className = 'fn-trigger-col fn-col-fail';
    colFail.append(
        makeCheckbox('请求报错时提醒', 'alertOnError'),
        makeCheckbox('返回内容为空时提醒', 'alertOnEmpty')
    );

    const colSuccess = document.createElement('div');
    colSuccess.className = 'fn-trigger-col fn-col-success';
    colSuccess.append(
        makeCheckbox('生成成功时播放提示音', 'alertOnSuccess'),
        makeCheckbox('仅在后台时生效', 'successBackgroundOnly')
    );

    triggersWrap.append(colFail, colSuccess);
    content.append(triggersWrap);

    // 2. 声音设置
    content.append(makeDivider('声音设置'));
    content.append(makeCheckbox('开启失败提示音','sound'));
    content.append(makeRange('失败音量','volume',0,1,0.01));
    // 【修改】：使用新的同行函数
    content.append(makeTextInline('失败音频路径','soundUrl','./fail.mp3'));
    
    const rowSuccessSound = document.createElement('div');
    rowSuccessSound.style.marginTop = '12px';
    rowSuccessSound.append(
        makeRange('成功音量','successVolume',0,1,0.01),
        // 【修改】：使用新的同行函数
        makeTextInline('成功音频路径','successSoundUrl','./success.mp3')
    );
    content.append(rowSuccessSound);

    // 3. 失败时的振动提醒
    content.append(makeDivider('振动设置 (仅Android)'));
    const vibRow = makeCheckbox('开启失败振动','vibrate');
    if (!VIB_SUPPORTED) {
      const input = vibRow.querySelector('input');
      input.checked = false; input.disabled = true;
      vibRow.title = '当前平台/浏览器不支持网页振动';
    }
    content.append(vibRow);
    const vibMsRow = makeNumber('振动时长 (ms)','vibMs',50,2000,10);
    const vibCntRow = makeNumber('振动次数','vibRepeat',1,5,1);
    if (!VIB_SUPPORTED) {
      vibMsRow.querySelector('input').disabled = true;
      vibCntRow.querySelector('input').disabled = true;
      vibMsRow.style.opacity = '0.6';
      vibCntRow.style.opacity = '0.6';
    }
    content.append(vibMsRow, vibCntRow);

    // 4. 系统通知与闪烁
    content.append(makeDivider('系统通知与标题闪烁'));
    const notifChk = makeCheckbox('失败系统通知（需授权）','notify');
    if (IOS && !iosNotifUsable()) {
      const input = notifChk.querySelector('input');
      input.checked = false; input.disabled = true;
      notifChk.title = 'iOS 需：添加到主屏(PWA) + Service Worker + 授权通知';
    }
    content.append(notifChk);
    // 通知标题和正文也改为同行显示，看起来更清爽
    content.append(makeTextInline('通知标题','notifyTitle', defaults.notifyTitle));
    content.append(makeTextInline('通知正文','notifyBody', defaults.notifyBody));
    const requireRow = makeCheckbox('通知常驻直到点击','notifyRequireInteraction');
    content.append(requireRow);
    content.append(makeNotifRow());

    content.append(makeCheckbox('失败时标题栏闪烁提醒','titleBlink'));
    content.append(makeNumber('闪烁次数','titleBlinkTimes',2,20,1));
    content.append(makeNumber('闪烁间隔 (ms)','titleBlinkGap',200,3000,50));

    // 5. 测试区
    content.append(makeDivider('功能测试'));
    content.append(makeCheckbox('输出诊断日志（不记录回复内容）', 'debug'));
    content.append(makeTestRow());

    drawer.append(header, content);
    host.append(drawer);
  }

  if (document.getElementById('extensions_settings')) {
    mountSettingsUI();
  } else {
    const mo = new MutationObserver(() => {
      if (document.getElementById('extensions_settings')) { mountSettingsUI(); mo.disconnect(); }
    });
    mo.observe(document.documentElement, { childList:true, subtree:true });
  }

})();
