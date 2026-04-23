(function () {
  "use strict";

  // ─── Guard: Extension context ──────────────────────────────────────────────
  function isRuntimeValid() {
    try {
      return !!(typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  if (!isRuntimeValid()) return;

  // ─── Visual Flash Mitigation ──────────────────────────────────────────────
  // Synchronously mask the UI before the browser paints the first frame. 
  if (document.documentElement) {
    document.documentElement.style.visibility = "hidden";
  }

  // ─── Global Safety Constraints ────────────────────────────────────────────
  document.addEventListener("dragover", (e) => e.preventDefault(), false);
  document.addEventListener("drop", (e) => e.preventDefault(), false);

  // ─── Shared constants ─────────────────────────────────────────────────────
  // ─── Shared constants ─────────────────────────────────────────────────────
  const { MW_DEFAULT_LIMIT, S4_DEFAULT_LIMIT, STORAGE_TIMEOUT_MS, AUDIO_SAFETY_MS } = window.SharedConstants;

  // ─── Configuration & State ────────────────────────────────────────────────
  const CACHE_MAX_SIZE = 200;

  const KEY_MW_KEY              = "mw_key";
  const KEY_MW_COLLEGIATE_KEY   = "mw_collegiate_key";
  const KEY_MW_THESAURUS_KEY    = "mw_thesaurus_key";
  const KEY_S4_UID              = "s4_uid";
  const KEY_S4_TOKEN            = "s4_token";
  const KEY_LOOKUP_PRIORITY     = "lookup_priority";
  const KEY_API_USAGE           = "api_usage";
  const KEY_API_MW_LIMIT        = "api_mw_limit";
  const KEY_API_S4_LIMIT        = "api_s4_limit";
  const KEY_EXT_LOGS            = "ext_logs";
  const MAX_LOG_ENTRIES         = 200;

  const lookupCache = new Map();
  const mwAltCache  = new Map();

  let currentAbortController = null;
  let currentAudio           = null;
  let _switchSafetyTimer     = null;
  let _configuredApiWarnings = [];
  let _lookupSeq             = 0;
  let _mwState               = { activeApi: null, word: null, text: null };

  const _reducedMotionMql = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  let _autoCloseAnimation = null;
  let _isSidebarHovered   = false;

  // ─── DOM References ───────────────────────────────────────────────────────
  const elWord      = document.getElementById("dict-tooltip-word");
  const elPhonetic  = document.getElementById("dict-tooltip-phonetic");
  const elBody      = document.getElementById("dict-tooltip-body");
  const elSource    = document.getElementById("dict-tooltip-source");
  const mwSwitchBtn = document.getElementById("dict-mw-switch-btn");
  const countdownEl = document.getElementById("dict-tooltip-countdown");

  const searchInput  = document.getElementById("dict-search-input");
  const searchSubmit = document.getElementById("dict-search-submit");

  // ─── Search Implementation ────────────────────────────────────────────────
  if (searchInput && searchSubmit) {
    const handleSearch = () => {
      const query = searchInput.value.trim();
      if (query) {
        lookupWord(query);
        searchInput.blur();
      }
    };

    searchSubmit.addEventListener("click", handleSearch);
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleSearch();
      }
    });
  }

  // ─── Storage Listener (The Entry Point) ───────────────────────────────────
  chrome.storage.onChanged.addListener((changes, namespace) => {
	  // Guard: Prevent execution if context dies mid-session
	  if (!isRuntimeValid()) return;
    if (namespace === "local" && changes.sidebar_lookup) {
      const payload = changes.sidebar_lookup.newValue;
      if (payload && payload.word) {
        lookupWord(payload.word);
        chrome.storage.local.remove("sidebar_lookup");
      }
    }
  });

  chrome.storage.local.get(["sidebar_lookup"], (result) => {
	  // Guard: Protect lastError evaluation
    if (!isRuntimeValid()) return;
    if (chrome.runtime.lastError) return;
	
    const payload = result.sidebar_lookup;
    if (payload && payload.word) {
      const isFresh = (Date.now() - payload.ts) < 3000;
      if (isFresh) lookupWord(payload.word);
      chrome.storage.local.remove("sidebar_lookup");
    }
  });

  // ─── Sanitiser (Strict Content Port) ──────────────────────────────────────
  const _SANITIZE_UNSAFE_ATTR      = /^on/i;
  const _SANITIZE_URL_ATTRS = new Set(["href", "src", "srcset", "poster", "action", "formaction", "data"]);
  const _SANITIZE_SAFE_SCHEMES     = /^(https?|mailto|tel):/i;
  const _SANITIZE_BLOCKED_ELEMENTS = new Set([
    "SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "LINK", "BASE", "META",
    "FORM", "INPUT", "TEXTAREA", "SELECT", "BUTTON", "TEMPLATE", "SVG", "MATH",
  ]);

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#x27;").replace(/`/g, "&#x60;");
  }

  function _sanitiseNode(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (_SANITIZE_BLOCKED_ELEMENTS.has(node.nodeName)) {
      node.parentNode?.removeChild(node);
      return;
    }
    const toRemove = [];
    for (const attr of node.attributes) {
      if (_SANITIZE_UNSAFE_ATTR.test(attr.name)) { toRemove.push(attr.name); continue; }
      if (_SANITIZE_URL_ATTRS.has(attr.name.toLowerCase())) {
        const val = attr.value.trim();
        if (val && !val.startsWith("#") && !_SANITIZE_SAFE_SCHEMES.test(val)) toRemove.push(attr.name);
      }
    }
    toRemove.forEach((a) => node.removeAttribute(a));
    Array.from(node.childNodes).forEach(_sanitiseNode);
  }

  function safeSetHTML(el, html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (!doc || !doc.body) {
    el.replaceChildren();
    return;
  }

  const fragment = document.createDocumentFragment();
  // Move nodes directly to empty the parser doc faster
  while (doc.body.firstChild) {
    const node = doc.body.firstChild;
    if (node.nodeType === Node.ELEMENT_NODE && _SANITIZE_BLOCKED_ELEMENTS.has(node.nodeName)) {
      doc.body.removeChild(node);
      continue;
    }
    _sanitiseNode(node);
    fragment.appendChild(node);
  }

  el.replaceChildren(fragment);
}

  function stripHtml(html) {
    if (!html) return "";
    try {
      const doc = new DOMParser().parseFromString(html, "text/html");
      return (doc.body ? doc.body.textContent : "") || "";
    } catch { return ""; }
  }

  function isSafeHttpsUrl(url) {
    if (typeof url !== "string" || !url) return false;
    try { return new URL(url).protocol === "https:"; } catch { return false; }
  }

  function normaliseLookupKey(text) {
    return text.normalize("NFC").toLowerCase().replace(/ +/g, " ").trim();
  }

  // ─── Cache Helpers ────────────────────────────────────────────────────────
  function cacheSet(key, value) {
    if (lookupCache.size >= CACHE_MAX_SIZE) lookupCache.delete(lookupCache.keys().next().value);
    lookupCache.set(key, value);
  }
  function mwAltCacheSet(key, value) {
    if (mwAltCache.size >= CACHE_MAX_SIZE) mwAltCache.delete(mwAltCache.keys().next().value);
    mwAltCache.set(key, value);
  }

  // ─── Storage Readers ──────────────────────────────────────────────────────
  function getStoredKeys() {
    return new Promise((resolve) => {
      const defaults = {
        mwCollegiateKey: "", mwThesaurusKey: "", s4Uid: "", s4Token: "", priority: "auto",
        mwCount: 0, mwThesaurusCount: 0, s4Count: 0,
        mwLimit: MW_DEFAULT_LIMIT, s4Limit: S4_DEFAULT_LIMIT,
      };
      if (!isRuntimeValid()) { resolve(defaults); return; }

      let _resolved = false;
      const _timeoutId = setTimeout(() => {
        if (_resolved) return;
        _resolved = true;
        resolve(defaults);
      }, STORAGE_TIMEOUT_MS);

      try {
        chrome.storage.local.get(
          [KEY_MW_KEY, KEY_MW_COLLEGIATE_KEY, KEY_MW_THESAURUS_KEY,
           KEY_S4_UID, KEY_S4_TOKEN, KEY_LOOKUP_PRIORITY,
           KEY_API_USAGE, KEY_API_MW_LIMIT, KEY_API_S4_LIMIT],
          (result) => {
            clearTimeout(_timeoutId);
            if (_resolved) return;
            _resolved = true;
			if (!isRuntimeValid()) {
              resolve(defaults);
              return;
            }
            if (chrome.runtime.lastError) { resolve(defaults); return; }

            const safe  = (v) => (typeof v === "string" ? v.trim() : "");
            const today = new Date().toISOString().slice(0, 10);
            const usageRaw = result[KEY_API_USAGE];
            const usage = (usageRaw && typeof usageRaw === "object" && usageRaw.date === today)
              ? usageRaw
              : { date: today, mw_count: 0, mw_thesaurus_count: 0, s4_count: 0 };

            const legacyKey    = safe(result[KEY_MW_KEY]);
            const rawCollegiate = safe(result[KEY_MW_COLLEGIATE_KEY]);

            resolve({
              mwCollegiateKey: rawCollegiate || legacyKey,
              mwThesaurusKey:  safe(result[KEY_MW_THESAURUS_KEY]),
              s4Uid:           safe(result[KEY_S4_UID]),
              s4Token:         safe(result[KEY_S4_TOKEN]),
              priority:        safe(result[KEY_LOOKUP_PRIORITY]) || "auto",
              mwCount:         typeof usage.mw_count          === "number" ? usage.mw_count          : 0,
              mwThesaurusCount:typeof usage.mw_thesaurus_count === "number" ? usage.mw_thesaurus_count : 0,
              s4Count:         typeof usage.s4_count          === "number" ? usage.s4_count          : 0,
              mwLimit:         typeof result[KEY_API_MW_LIMIT] === "number" ? result[KEY_API_MW_LIMIT] : MW_DEFAULT_LIMIT,
              s4Limit:         typeof result[KEY_API_S4_LIMIT] === "number" ? result[KEY_API_S4_LIMIT] : S4_DEFAULT_LIMIT,
            });
          }
        );
      } catch (err) {
        clearTimeout(_timeoutId);
        if (_resolved) return;
        _resolved = true;
        resolve(defaults);
      }
    });
  }

  // ─── Queue Managers (Logs & Counters) ─────────────────────────────────────
  let _counterFlushPending = false;
  const _counterQueue = [];

  function _flushCounterQueue() {
    if (!isRuntimeValid() || _counterQueue.length === 0) { _counterFlushPending = false; return; }
    _counterFlushPending = true;
    const today = new Date().toISOString().slice(0, 10);
    try {
      chrome.storage.local.get([KEY_API_USAGE], (getResult) => {
        if (!isRuntimeValid() || chrome.runtime.lastError) { _counterFlushPending = false; return; }
        const existing = getResult[KEY_API_USAGE];
        const usage = (existing && typeof existing === "object" && existing.date === today)
          ? {
              date:               today,
              mw_count:           typeof existing.mw_count           === "number" ? existing.mw_count           : 0,
              mw_thesaurus_count: typeof existing.mw_thesaurus_count === "number" ? existing.mw_thesaurus_count : 0,
              s4_count:           typeof existing.s4_count           === "number" ? existing.s4_count           : 0,
            }
          : { date: today, mw_count: 0, mw_thesaurus_count: 0, s4_count: 0 };

        const _counterBatch = [];
        while (_counterQueue.length > 0) _counterBatch.push(_counterQueue.shift());
        _counterBatch.forEach((api) => {
          if (api === "mw")           usage.mw_count           += 1;
          if (api === "mw_thesaurus") usage.mw_thesaurus_count += 1;
          if (api === "s4")           usage.s4_count           += 1;
        });

        chrome.storage.local.set({ [KEY_API_USAGE]: usage }, () => {
          _counterFlushPending = false;
          if (!isRuntimeValid() || chrome.runtime.lastError) {
            for (let i = _counterBatch.length - 1; i >= 0; i--) _counterQueue.unshift(_counterBatch[i]);
            return;
          }
          if (_counterQueue.length > 0) _flushCounterQueue();
        });
      });
    } catch { _counterFlushPending = false; }
  }

  function incrementApiCounter(api) {
    if (!isRuntimeValid()) return;
    _counterQueue.push(api);
    if (!_counterFlushPending) _flushCounterQueue();
  }

  let _logFlushPending = false;
  const _logEntryQueue = [];

  function _flushLogQueue() {
    if (!isRuntimeValid() || _logEntryQueue.length === 0) { _logFlushPending = false; return; }
    _logFlushPending = true;
    try {
      chrome.storage.local.get([KEY_EXT_LOGS], (getResult) => {
        if (!isRuntimeValid() || chrome.runtime.lastError) { _logFlushPending = false; return; }
        const existing = Array.isArray(getResult[KEY_EXT_LOGS]) ? getResult[KEY_EXT_LOGS] : [];
        const _logBatch = [];
        while (_logEntryQueue.length > 0) _logBatch.push(_logEntryQueue.shift());
        const combined = [...existing, ..._logBatch];
        const trimmed  = combined.length > MAX_LOG_ENTRIES
          ? combined.slice(combined.length - MAX_LOG_ENTRIES)
          : combined;
        chrome.storage.local.set({ [KEY_EXT_LOGS]: trimmed }, () => {
          _logFlushPending = false;
          if (!isRuntimeValid() || chrome.runtime.lastError) {
            for (let i = _logBatch.length - 1; i >= 0; i--) _logEntryQueue.unshift(_logBatch[i]);
            return;
          }
          if (_logEntryQueue.length > 0) _flushLogQueue();
        });
      });
    } catch { _logFlushPending = false; }
  }

  function writeLog(level, msg) {
    if (!isRuntimeValid()) return;
    _logEntryQueue.push({ ts: new Date().toISOString(), level, msg });
    if (!_logFlushPending) _flushLogQueue();
  }

  // ─── Audio Helper ─────────────────────────────────────────────────────────
  function stopAudio() {
    if (currentAudio) {
      currentAudio.pause();
      currentAudio.removeAttribute('src');
      currentAudio.load();
	  currentAudio.currentTime = 0;
      if (currentAudio._safetyTimer != null) {
        clearTimeout(currentAudio._safetyTimer);
        currentAudio._safetyTimer = null;
      }
      currentAudio = null;
    }
  }

  function appendAudioButton(audioUrl) {
    if (!isSafeHttpsUrl(audioUrl)) return;
    const audioBtn = document.createElement("button");
    audioBtn.setAttribute("type", "button");
    audioBtn.className   = "dict-audio-btn";
    audioBtn.textContent = "\uD83D\uDD0A Listen";
	audioBtn.setAttribute("aria-label", "Listen to pronunciation");
    audioBtn.addEventListener("click", () => {
      stopAudio();
      pauseAutoClose(); 

      const audio = new Audio(audioUrl);
      currentAudio = audio;

      // 1. Mirror the strict fallback timer
      audio._safetyTimer = setTimeout(() => {
        audio._safetyTimer = null;
        if (currentAudio === audio) {
          stopAudio();
          resumeAutoClose();
        }
      }, AUDIO_SAFETY_MS);

      const onEnd = () => {
        // 2. Clear timer on organic completion
        clearTimeout(audio._safetyTimer);
        audio._safetyTimer = null;
        
        if (currentAudio === audio) {
          stopAudio();
          resumeAutoClose();
        }
      };
      
      audio.addEventListener("ended", onEnd, { once: true });
      audio.addEventListener("error", onEnd, { once: true });
      
      audio.play().catch((err) => {
        clearTimeout(audio._safetyTimer);
        audio._safetyTimer = null;
        if (currentAudio === audio) {
          stopAudio();
          resumeAutoClose();
        }
      });
    });
    elBody.appendChild(audioBtn);
  }

  // ─── Network & API Sequence Logic ─────────────────────────────────────────
  async function fetchWithBackoff(url, fetchOptions, maxRetries = 3) {
    const signal = fetchOptions.signal;
    let delay = 1000;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const response = await fetch(url, fetchOptions);
      if (signal?.aborted) return null;
      if (response.status !== 429 || attempt === maxRetries) return response;
      await new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
        const onAbort = () => { clearTimeout(t); reject(new DOMException("Aborted", "AbortError")); };
        const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, delay);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
      delay *= 2;
    }
	return null;
  }

  async function _runLookupSequence(steps, signal, word) {
    for (const { label, fn } of steps) {
      if (signal.aborted) return false;
      writeLog("info", `"${word}" — trying ${label}`);
      const ok = await fn();
      if (ok) { writeLog("info", `"${word}" — resolved via ${label}`); return true; }
      if (!signal.aborted) writeLog("info", `"${word}" — ${label}: no result`);
    }
    return false;
  }

  // ─── Source Fetchers ──────────────────────────────────────────────────────
  async function fetchFreeDictionary(text, signal, effectiveCacheKey) {
    try {
      const response = await fetchWithBackoff(
        `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(text)}`,
        { signal }
      );
      if (!response || !response.ok || signal.aborted) return false;
      const data = await response.json();
      if (signal.aborted || !Array.isArray(data) || data.length === 0) return false;

      const entry = data[0];
      if (!entry || !Array.isArray(entry.meanings) || entry.meanings.length === 0) return false;

      let phonetic = "";
      if (typeof entry.phonetic === "string" && entry.phonetic) phonetic = entry.phonetic;
      else if (Array.isArray(entry.phonetics)) {
        const ph = entry.phonetics.find((p) => p && typeof p.text === "string" && p.text);
        if (ph) phonetic = ph.text;
      }

      let html = "";
      let defsAdded = 0;
      entry.meanings.forEach((meaning) => {
        if (!meaning || !Array.isArray(meaning.definitions)) return;
        const pos = typeof meaning.partOfSpeech === "string" ? meaning.partOfSpeech : "";
        let meaningHtml = pos ? `<span class="dict-pos">${escapeHtml(pos)}</span>` : "";
        let defNum = 0;
        meaning.definitions.slice(0, 3).forEach((def) => {
          if (!def || typeof def.definition !== "string" || !def.definition) return;
          defNum++; defsAdded++;
          meaningHtml += `<p class="dict-def">${defNum}. ${escapeHtml(def.definition)}</p>`;
          if (typeof def.example === "string" && def.example)
            meaningHtml += `<p class="dict-example">\u201c${escapeHtml(def.example)}\u201d</p>`;
        });
        if (defNum > 0) html += `<div class="dict-meaning">${meaningHtml}</div>`;
      });

      if (!html || defsAdded === 0) return false;

      let audioUrl = null;
      if (Array.isArray(entry.phonetics)) {
        const audioEntry = entry.phonetics.find((p) => p && typeof p.audio === "string" && p.audio);
        if (audioEntry && isSafeHttpsUrl(audioEntry.audio)) audioUrl = audioEntry.audio;
      }

      elPhonetic.textContent = phonetic;
      safeSetHTML(elBody, html);
      elSource.textContent = "Source: Free Dictionary API";
      if (audioUrl) appendAudioButton(audioUrl);
      cacheSet(effectiveCacheKey, { html, phonetic, audioUrl, source: "Source: Free Dictionary API" });
      return true;
    } catch (err) {
      if (err.name === "AbortError") throw err;
      writeLog("warn", `Free Dictionary API failed — ${err.message ?? err}`);
      return false;
    }
  }

  async function fetchWiktionary(text, signal, effectiveCacheKey) {
    const term = text.replace(/ +/g, "_");
    try {
      const response = await fetchWithBackoff(
        `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(term)}`,
        { signal }
      );
      if (!response || !response.ok || signal.aborted) return false;
      const data = await response.json();
      if (signal.aborted || !data || !Array.isArray(data.en) || data.en.length === 0) return false;

      let html = "";
      let defsAdded = 0;
      data.en.forEach((entry) => {
        if (!entry || !Array.isArray(entry.definitions)) return;
        const pos = typeof entry.partOfSpeech === "string" ? entry.partOfSpeech : "Definition";
        let entryHtml = "";
        let defNum = 0;
        entry.definitions.slice(0, 3).forEach((def) => {
          const cleanDef = typeof def.definition === "string" ? stripHtml(def.definition) : "";
          if (!cleanDef) return;
          defNum++; defsAdded++;
          entryHtml += `<p class="dict-def">${defNum}. ${escapeHtml(cleanDef)}</p>`;
          if (Array.isArray(def.examples) && def.examples.length > 0) {
            const cleanEx = typeof def.examples[0] === "string" ? stripHtml(def.examples[0]) : "";
            if (cleanEx) entryHtml += `<p class="dict-example">\u201c${escapeHtml(cleanEx)}\u201d</p>`;
          }
        });
        if (defNum > 0)
          html += `<div class="dict-meaning"><span class="dict-pos">${escapeHtml(pos)}</span>${entryHtml}</div>`;
      });

      if (!html || defsAdded === 0) return false;

      elPhonetic.textContent = "";
      safeSetHTML(elBody, html);
      elSource.textContent = "Source: Wiktionary";
      cacheSet(effectiveCacheKey, { html, phonetic: "", audioUrl: null, source: "Source: Wiktionary" });
      return true;
    } catch (err) {
      if (err.name === "AbortError") throw err;
      writeLog("warn", `Wiktionary API failed — ${err.message ?? err}`);
      return false;
    }
  }

  async function fetchSTANDS4Vocab(text, signal, uid, token, effectiveCacheKey) {
    try {
      const url = new URL("https://www.stands4.com/services/v2/defs.php");
      url.searchParams.set("uid",     uid);
      url.searchParams.set("tokenid", token);
      url.searchParams.set("word",    text);
      url.searchParams.set("format",  "json");

    const response = await fetchWithBackoff(url.toString(), { signal });
      if (!response || signal.aborted) return false;
      if (!response.ok) {
        if (response.status === 429) {
          const msg = "STANDS4 Vocab: daily quota exceeded (HTTP 429)";
          _configuredApiWarnings.push(msg);
          writeLog("error", msg);
        } else if (response.status === 401 || response.status === 403) {
          const msg = `STANDS4 Vocab: credentials rejected (HTTP ${response.status}) — check your User ID and Token`;
          _configuredApiWarnings.push(msg);
          writeLog("error", msg);
        } else {
          writeLog("warn", `STANDS4 Vocab: unexpected HTTP ${response.status}`);
        }
        return false;
      }
      const data = await response.json();
      if (signal.aborted || !data?.result) return false;

      let results = Array.isArray(data.result) ? data.result : [data.result];
      const validResult = results.find((r) => r && typeof r.definition === "string" && r.definition.trim());
      if (!validResult) return false;

      const def = validResult.definition.trim();
      const pos = typeof validResult["part-of-speech"] === "string" ? validResult["part-of-speech"].trim() : "";
      const ex  = typeof validResult.example       === "string" ? validResult.example.trim()       : "";
      const ph  = typeof validResult.pronunciation === "string" ? validResult.pronunciation.trim() : "";

      let html = `<div class="dict-meaning">`;
      if (pos) html += `<span class="dict-pos">${escapeHtml(pos)}</span>`;
      html += `<p class="dict-def">1. ${escapeHtml(def)}</p>`;
      if (ex) html += `<p class="dict-example">\u201c${escapeHtml(ex)}\u201d</p>`;
      html += `</div>`;

      elPhonetic.textContent = ph;
      safeSetHTML(elBody, html);
      elSource.textContent = "Source: STANDS4";
      incrementApiCounter("s4");
      cacheSet(effectiveCacheKey, { html, phonetic: ph, audioUrl: null, source: "Source: STANDS4" });
      return true;
    } catch (err) {
      if (err.name === "AbortError") throw err;
      writeLog("error", `STANDS4 Vocab: request failed — ${err.message ?? err}`); // INJECT
      return false;
    }
  }

  async function fetchSTANDS4Idioms(text, signal, uid, token, effectiveCacheKey) {
    try {
      const url = new URL("https://www.stands4.com/services/v2/phrases.php");
      url.searchParams.set("uid",     uid);
      url.searchParams.set("tokenid", token);
      url.searchParams.set("phrase",  text);
      url.searchParams.set("format",  "json");

    const response = await fetchWithBackoff(url.toString(), { signal });
      if (!response || signal.aborted) return false;
      if (!response.ok) {
        if (response.status === 429) {
          const msg = "STANDS4 Idioms: daily quota exceeded (HTTP 429)";
          _configuredApiWarnings.push(msg);
          writeLog("error", msg);
        } else if (response.status === 401 || response.status === 403) {
          const msg = `STANDS4 Idioms: credentials rejected (HTTP ${response.status}) — check your User ID and Token`;
          _configuredApiWarnings.push(msg);
          writeLog("error", msg);
        } else {
          writeLog("warn", `STANDS4 Idioms: unexpected HTTP ${response.status}`);
        }
        return false;
      }
      const data = await response.json();
      if (signal.aborted || !data?.result) return false;

      let results = Array.isArray(data.result) ? data.result : [data.result];
      const valid = results.filter((r) => r && typeof r.definition === "string" && r.definition.trim());
      if (valid.length === 0) return false;

      let html = "";
      valid.slice(0, 3).forEach((r, i) => {
        html += `<div class="dict-meaning"><span class="dict-pos">idiom / phrase</span>`;
        html += `<p class="dict-def">${i + 1}. ${escapeHtml(r.definition.trim())}</p>`;
        if (typeof r.example === "string" && r.example.trim())
          html += `<p class="dict-example">\u201c${escapeHtml(r.example.trim())}\u201d</p>`;
        html += `</div>`;
      });

      elPhonetic.textContent = "";
      safeSetHTML(elBody, html);
      elSource.textContent = "Source: STANDS4 Phrases";
      incrementApiCounter("s4");
      cacheSet(effectiveCacheKey, { html, phonetic: "", audioUrl: null, source: "Source: STANDS4 Phrases" });
      return true;
    } catch (err) {
      if (err.name === "AbortError") throw err;
      writeLog("error", `STANDS4 Idioms: request failed — ${err.message ?? err}`); // INJECT
      return false;
    }
  }

  function _parseMwResponse(data) {
    if (!Array.isArray(data) || data.length === 0 || typeof data[0] === "string") return null;
    const entries = data.filter((e) => e && Array.isArray(e.shortdef) && e.shortdef.length > 0);
    if (entries.length === 0) return null;

    let phonetic = "";
    const firstPrs = Array.isArray(entries[0]?.hwi?.prs) ? entries[0].hwi.prs : [];
    if (firstPrs.length > 0 && typeof firstPrs[0].mw === "string") phonetic = firstPrs[0].mw;

    let audioUrl = null;
    if (firstPrs.length > 0) {
      const sound = firstPrs[0]?.sound;
      if (sound && typeof sound.audio === "string" && sound.audio) {
        const af = sound.audio;
        if (/^[\w-]+$/.test(af)) {
          const firstChar = af[0] ?? "";
          const subdir = af.startsWith("bix") ? "bix"
                       : af.startsWith("gg")  ? "gg"
                       : /^[0-9]/.test(af)    ? "number"
                       : firstChar            ? firstChar
                       : "a"; 
          audioUrl = `https://media.merriam-webster.com/audio/prons/en/us/mp3/${subdir}/${af}.mp3`;
        }
      }
    }

    let html = "";
    let defsAdded = 0;
    entries.slice(0, 3).forEach((entry) => {
      const fl = typeof entry.fl === "string" ? entry.fl.trim() : "";
      let entryHtml = fl ? `<span class="dict-pos">${escapeHtml(fl)}</span>` : "";
      let entryDefNum = 0;
      entry.shortdef.slice(0, 3).forEach((def) => {
        if (typeof def !== "string" || !def) return;
        entryDefNum++; defsAdded++;
        entryHtml += `<p class="dict-def">${entryDefNum}. ${escapeHtml(def)}</p>`;
      });
      if (entryDefNum > 0) html += `<div class="dict-meaning">${entryHtml}</div>`;
    });

    if (!html || defsAdded === 0) return null;
    return { html, phonetic, audioUrl };
  }

  async function fetchMwApi(type, text, signal, apiKey, baseKey, effectiveCacheKey, hasMWCollegiate = true, hasMWThesaurus = true) {
    const isCollegiate  = type === "collegiate";
    const endpointSeg   = isCollegiate ? "collegiate" : "thesaurus";
    const sourceLabel   = isCollegiate
      ? "Source: Merriam-Webster Collegiate Dictionary"
      : "Source: Merriam-Webster Thesaurus Dictionary";

    try {
    const response = await fetchWithBackoff(
        `https://www.dictionaryapi.com/api/v3/references/${endpointSeg}/json/${encodeURIComponent(text)}?key=${encodeURIComponent(apiKey)}`,
        { signal }
      );
      if (!response || signal.aborted) return false;
      if (!response.ok) {
        const apiLabel = isCollegiate ? "Merriam-Webster Collegiate" : "Merriam-Webster Thesaurus";
        const keyLabel = isCollegiate ? "Collegiate" : "Thesaurus";
        if (response.status === 429) {
          const msg = `${apiLabel}: daily quota exceeded (HTTP 429)`;
          _configuredApiWarnings.push(msg);
          writeLog("error", msg);
        } else if (response.status === 401 || response.status === 403) {
          const msg = `${apiLabel}: API key rejected (HTTP ${response.status}) — verify the ${keyLabel} key in API Keys`;
          _configuredApiWarnings.push(msg);
          writeLog("error", msg);
        } else {
          writeLog("warn", `${apiLabel}: unexpected HTTP ${response.status}`);
        }
        return false;
      }

      const data = await response.json();
      if (signal.aborted) return false;

      const parsed = _parseMwResponse(data);
      if (!parsed) return false;

      elPhonetic.textContent = parsed.phonetic;
      safeSetHTML(elBody, parsed.html);
      elSource.textContent = sourceLabel;
      incrementApiCounter(isCollegiate ? "mw" : "mw_thesaurus");
      if (parsed.audioUrl) appendAudioButton(parsed.audioUrl);

      const cacheEntry = { ...parsed, source: sourceLabel, mwApi: type };
      if (effectiveCacheKey) cacheSet(effectiveCacheKey, cacheEntry);
      mwAltCacheSet(`mwalt:${type}:${baseKey}`, cacheEntry);

      _updateMwSwitchButton(type, baseKey, text, hasMWCollegiate, hasMWThesaurus);
      return true;
    } catch (err) {
      if (err.name === "AbortError") throw err;
      const apiLabel = type === "collegiate" ? "Merriam-Webster Collegiate" : "Merriam-Webster Thesaurus"; // INJECT
      writeLog("error", `${apiLabel}: request failed — ${err.message ?? err}`); // INJECT
      return false;
    }
  }

  // ─── MW Switch UI ─────────────────────────────────────────────────────────
  function _updateMwSwitchButton(activeApi, baseKey, originalText, hasMWCollegiate, hasMWThesaurus) {
    if (!activeApi || !(hasMWCollegiate && hasMWThesaurus)) {
      mwSwitchBtn.style.display = "none";
      _mwState = { activeApi: null, word: null, text: null };
      return;
    }
    mwSwitchBtn.textContent  = activeApi === "collegiate" ? "\u21C4 Thesaurus" : "\u21C4 Collegiate";
    mwSwitchBtn.setAttribute("aria-label", activeApi === "collegiate" ? "Switch to Merriam-Webster Thesaurus" : "Switch to Merriam-Webster Collegiate"); // Add this line
    mwSwitchBtn.style.display = "inline-flex";
    _mwState = { activeApi, word: baseKey, text: originalText };
  }

  mwSwitchBtn.addEventListener("click", () => {
    const { activeApi, word, text: originalText } = _mwState;
    if (!activeApi || !word || !originalText) return;

    const targetApi           = activeApi === "collegiate" ? "thesaurus" : "collegiate";
    const altCacheKey         = `mwalt:${targetApi}:${word}`;
    const _currentSourceLabel = activeApi === "collegiate"
      ? "Source: Merriam-Webster Collegiate Dictionary"
      : "Source: Merriam-Webster Thesaurus Dictionary";

    if (mwAltCache.has(altCacheKey)) {
      const cached = mwAltCache.get(altCacheKey);
      elPhonetic.textContent = cached.phonetic || "";
      safeSetHTML(elBody, cached.html);
      elSource.textContent = cached.source;
      if (cached.audioUrl) appendAudioButton(cached.audioUrl);
      _mwState = { activeApi: targetApi, word, text: originalText };
      mwSwitchBtn.textContent = targetApi === "collegiate" ? "\u21C4 Thesaurus" : "\u21C4 Collegiate";
      mwSwitchBtn.setAttribute("aria-label", targetApi === "collegiate" ? "Switch to Merriam-Webster Thesaurus" : "Switch to Merriam-Webster Collegiate");
      startAutoClose(); 
      return;
    }

    if (currentAbortController) currentAbortController.abort();
    
    // ───  Capture the Generational Ticket ───
    const snapSeq = _lookupSeq;

    elSource.textContent  = "\u231B Switching\u2026";
    mwSwitchBtn.disabled  = true;

    _switchSafetyTimer = setTimeout(() => {
      mwSwitchBtn.disabled = false;
      elSource.textContent = _currentSourceLabel;
    }, STORAGE_TIMEOUT_MS);

    currentAbortController = new AbortController();
    const { signal } = currentAbortController;

    // ─── Twin Engine Parity ───
    if (!isRuntimeValid()) {
      clearTimeout(_switchSafetyTimer);
      mwSwitchBtn.disabled = false;
      elSource.textContent = _currentSourceLabel;
      currentAbortController = null;
      return;
    }

    try {
      // ───  Twin Engine Parity for Storage Keys ───
      chrome.storage.local.get(
        [KEY_MW_KEY, KEY_MW_COLLEGIATE_KEY, KEY_MW_THESAURUS_KEY,
         KEY_S4_UID, KEY_S4_TOKEN, KEY_LOOKUP_PRIORITY,
         KEY_API_USAGE, KEY_API_MW_LIMIT, KEY_API_S4_LIMIT], 
        (result) => {
          // 1. Instantly clear the IPC storage safety timer
          clearTimeout(_switchSafetyTimer);

          // ───  Validate ticket before processing storage ───
          if (snapSeq !== _lookupSeq) return;

          if (chrome.runtime.lastError || signal.aborted) {
            const errMsg = chrome.runtime.lastError ? chrome.runtime.lastError.message : "";
            if (errMsg.includes("context invalidated")) return; // Silent abort
            
            mwSwitchBtn.disabled = false;
            if (!signal.aborted) elSource.textContent = _currentSourceLabel;
            return;
          }

          // ───  Twin Engine Parity for Legacy Key Parsing ───
          const legacyKey       = typeof result[KEY_MW_KEY]            === "string" ? result[KEY_MW_KEY].trim()            : "";
          const rawCollegiate   = typeof result[KEY_MW_COLLEGIATE_KEY] === "string" ? result[KEY_MW_COLLEGIATE_KEY].trim() : "";
          const rawThesaurus    = typeof result[KEY_MW_THESAURUS_KEY]  === "string" ? result[KEY_MW_THESAURUS_KEY].trim()  : "";
          
          const collegiateKey   = rawCollegiate || legacyKey;
          const thesaurusKey    = rawThesaurus;
          const apiKey          = targetApi === "collegiate" ? collegiateKey : thesaurusKey;

          if (!apiKey) {
            mwSwitchBtn.disabled = false;
            elSource.textContent = `${_currentSourceLabel} (Key missing)`;
            return;
          }

          fetchMwApi(targetApi, originalText, signal, apiKey, word, null, !!collegiateKey, !!thesaurusKey)
            .then((found) => {
              // ───  Validate ticket before DOM mutation ───
              if (snapSeq !== _lookupSeq) return;

              mwSwitchBtn.disabled = false;
              if (!signal.aborted && !found) elSource.textContent = `${_currentSourceLabel} (No result)`;
              if (!signal.aborted) startAutoClose();
            })
            .catch((err) => {
              // ───  Validate ticket before DOM mutation ───
              if (snapSeq !== _lookupSeq) return;

              mwSwitchBtn.disabled = false;
              if (err.name !== "AbortError") writeLog("warn", `MW Switch error: ${err.message}`);
              if (!signal.aborted) startAutoClose();
            });
      });
    } catch (err) {
      clearTimeout(_switchSafetyTimer);
      mwSwitchBtn.disabled = false;
      elSource.textContent = _currentSourceLabel;
      if (currentAbortController?.signal === signal) currentAbortController = null;
    }
  });

// ─── Sidebar Quality of Life: Auto-Close & Seamless Replacement ───────────
  const AUTO_CLOSE_MS  = 6000;

  function closeSidebar() {
    if (!isRuntimeValid()) return; 

    // 1 & 2. Pre-Closure Cleanup & Abort In-Flight Networks
    // Immediately cancel any pending API calls and media to prevent Promises from 
    // rejecting against a dying Xray Wrapper context.
    if (currentAbortController) {
      currentAbortController.abort();
      currentAbortController = null;
    }
	
	clearTimeout(_switchSafetyTimer);
    _switchSafetyTimer = null;
	
    stopAudio();

    // 3. Generational Ticket Invalidation
    // Increment the lookup sequence so any hanging async callbacks or background state
    // dispatches are instantly invalidated.
    _lookupSeq++;

    // Clear WAAPI Timers and UI Trackers
    _isSidebarHovered = false;
    if (_autoCloseAnimation) {
      _autoCloseAnimation.cancel();
      _autoCloseAnimation = null;
    }

    // 4. Atomic DOM Flush
    // Purge the rendered tree so BFCache and the garbage collector have zero nodes 
    // to track during the window destruction phase.
    if (elWord) elWord.textContent = "";
    if (elPhonetic) elPhonetic.textContent = "";
    if (elSource) elSource.textContent = "";
    if (elBody) elBody.replaceChildren();

    if (window.InstantDictionaryDB && typeof window.InstantDictionaryDB.closeConnection === "function") {
      window.InstantDictionaryDB.closeConnection();
    }

    // 5. Guarded Closure Execution
    try {
      // Auto-close timers run outside of trusted UI events. We detect this and route to the safe fallback gracefully.
      const hasUserGesture = typeof navigator !== "undefined" && navigator.userActivation && navigator.userActivation.isActive;

      if (typeof browser !== "undefined" && browser.sidebarAction && typeof browser.sidebarAction.close === "function" && hasUserGesture) {
        browser.sidebarAction.close().catch((err) => {
          // If it still rejects, degrade to console.debug instead of writeLog to protect the UI state pipeline.
          console.debug("[Instant Dictionary] Privileged close rejected despite activation. Using fallback.", err);
          window.close();
        });
      } else {
        // Direct fallback for auto-close timers or environments lacking user gesture
        window.close();
      }
    } catch (err) {
      writeLog("warn", `Sidebar close failed: ${err.message || err}`);
    }
  }

  function startAutoClose() {
    if (AUTO_CLOSE_MS <= 0) return;
    
    const viewLf = document.getElementById("view-local-files");
    if (viewLf && !viewLf.hidden) return;

    if (_autoCloseAnimation) {
      _autoCloseAnimation.cancel();
    }
    
    const duration = _reducedMotionMql?.matches ? 1 : AUTO_CLOSE_MS + 2000;

    if (countdownEl) {
      _autoCloseAnimation = countdownEl.animate(
        [
          { transform: "scaleX(1)" },
          { transform: "scaleX(0)" }
        ],
        {
          duration: duration,
          fill: "forwards",
          easing: "linear"
        }
      );

      // GUARD: Prevent runaway timer if updated while hovered or audio is playing
      if (_isSidebarHovered || currentAudio) {
        _autoCloseAnimation.pause();
      }

      _autoCloseAnimation.onfinish = () => {
        closeSidebar();
      };
    }
  }

  function pauseAutoClose() {
    if (AUTO_CLOSE_MS <= 0 || !_autoCloseAnimation) return;
    if (_autoCloseAnimation.playState === "running") {
      _autoCloseAnimation.pause();
    }
  }

  function resumeAutoClose() {
    const viewLf = document.getElementById("view-local-files");
    if (viewLf && !viewLf.hidden) return;
    
    if (AUTO_CLOSE_MS <= 0 || !_autoCloseAnimation) return;

    // GUARD: Do not resume if the user is still hovering OR audio is actively playing
    if (_isSidebarHovered || currentAudio) return;
    
    if (_autoCloseAnimation.playState === "paused") {
      _autoCloseAnimation.play();
    }
  }

  document.body.addEventListener("mouseenter", () => {
    _isSidebarHovered = true;
    pauseAutoClose();
  });

  document.body.addEventListener("mousemove", () => {
    _isSidebarHovered = true;
    pauseAutoClose();
  });
  
  document.body.addEventListener("mouseleave", () => {
    _isSidebarHovered = false;
    resumeAutoClose();
  });

  window.addEventListener("pagehide", () => {
    closeSidebar();
  });

// ─── Main Lookup Orchestrator ─────────────────────────────────────────────
  async function lookupWord(text) {
    pauseAutoClose();

    const viewDict = document.getElementById("view-dictionary");
    const viewLf   = document.getElementById("view-local-files");
    if (viewDict) viewDict.hidden = false;
    if (viewLf)   viewLf.hidden   = true;

    const mySeq = ++_lookupSeq;
    if (currentAbortController) currentAbortController.abort();
    currentAbortController = new AbortController();
    const { signal } = currentAbortController;

    stopAudio();
    _configuredApiWarnings = [];
    _mwState = { activeApi: null, word: null, text: null };
    mwSwitchBtn.style.display = "none";

    elWord.textContent     = text;
    elPhonetic.textContent = "";
    elSource.textContent   = "";
    safeSetHTML(elBody, `<p class="dict-loading">\uD83D\uDCD6 Looking up \u201c<strong>${escapeHtml(text)}</strong>\u201d\u2026</p>`);

    try {
      const keys = await getStoredKeys();
      if (mySeq !== _lookupSeq) return;

      const baseKey           = normaliseLookupKey(text);
      const isPhrase          = text.includes(" ");
      const effectivePriority = (keys.priority === "free_first") ? "auto" : keys.priority;
      const isEnhanced        = effectivePriority === "premium_first";
      const effectiveCacheKey = `${effectivePriority}:${baseKey}`;

      if (lookupCache.has(effectiveCacheKey)) {
        const cached = lookupCache.get(effectiveCacheKey);
        elPhonetic.textContent = cached.phonetic || "";
        safeSetHTML(elBody, cached.html);
        elSource.textContent = cached.source;
        if (cached.audioUrl) appendAudioButton(cached.audioUrl);
        if (cached.mwApi) _updateMwSwitchButton(cached.mwApi, baseKey, text, !!keys.mwCollegiateKey, !!keys.mwThesaurusKey);
        startAutoClose();
        return;
      }

      const mwTotalCount = keys.mwCount + keys.mwThesaurusCount;
      const s4OverLimit  = keys.s4Count >= keys.s4Limit;
      const mwOverLimit  = mwTotalCount >= keys.mwLimit;
      
      if (s4OverLimit) {
        const msg = `STANDS4: daily limit reached (${keys.s4Count}/${keys.s4Limit}) — skipping`;
        _configuredApiWarnings.push(msg);
        writeLog("warn", msg);
      }
      if (mwOverLimit) {
        const msg = `Merriam-Webster: daily limit reached (${mwTotalCount}/${keys.mwLimit}) — skipping`;
        _configuredApiWarnings.push(msg);
        writeLog("warn", msg);
      }

      const hasS4           = !!(keys.s4Uid && keys.s4Token) && !s4OverLimit;
      const hasMWCollegiate = !!keys.mwCollegiateKey && !mwOverLimit;
      const hasMWThesaurus  = !!keys.mwThesaurusKey  && !mwOverLimit;

      const _freeDict  = { label: "Free Dictionary", fn: () => fetchFreeDictionary(text, signal, effectiveCacheKey) };
      const _wikt      = { label: "Wiktionary",       fn: () => fetchWiktionary(text, signal, effectiveCacheKey) };
      const _mwCol     = { label: "MW Collegiate",    fn: () => fetchMwApi("collegiate", text, signal, keys.mwCollegiateKey, baseKey, effectiveCacheKey, hasMWCollegiate, hasMWThesaurus) };
      const _mwThes    = { label: "MW Thesaurus",     fn: () => fetchMwApi("thesaurus",  text, signal, keys.mwThesaurusKey,  baseKey, effectiveCacheKey, hasMWCollegiate, hasMWThesaurus) };
      const _s4Vocab   = { label: "STANDS4 Vocabulary", fn: () => fetchSTANDS4Vocab(text, signal, keys.s4Uid, keys.s4Token, effectiveCacheKey) };
      const _s4Idioms  = { label: "STANDS4 Idioms",   fn: () => fetchSTANDS4Idioms(text, signal, keys.s4Uid, keys.s4Token, effectiveCacheKey) };

      let sequence = [];
      
      if (!isEnhanced) {
        if (!isPhrase) {
          sequence = [_wikt, _freeDict, ...(hasMWCollegiate ? [_mwCol] : []), ...(hasMWThesaurus ? [_mwThes] : []), ...(hasS4 ? [_s4Vocab] : [])];
        } else {
          sequence = [_wikt, _freeDict, ...(hasMWCollegiate ? [_mwCol] : []), ...(hasMWThesaurus ? [_mwThes] : []), ...(hasS4 ? [_s4Idioms] : [])];
        }
      } else {
        if (!isPhrase) {
          sequence = [...(hasMWCollegiate ? [_mwCol] : []), ...(hasMWThesaurus ? [_mwThes] : []), _wikt, _freeDict, ...(hasS4 ? [_s4Vocab] : [])];
        } else {
          sequence = [...(hasMWCollegiate ? [_mwCol] : []), ...(hasMWThesaurus ? [_mwThes] : []), _wikt, _freeDict, ...(hasS4 ? [_s4Idioms] : [])];
        }
      }

    const found = await _runLookupSequence(sequence, signal, text);

      if (!found && !signal.aborted) {
        const warningHtml = _configuredApiWarnings.length > 0
          ? `<p class="dict-suggestion">\u26A0\uFE0F ${escapeHtml(_configuredApiWarnings.join(" \u2022 "))}</p>`
          : "";
        safeSetHTML(
          elBody,
          `<p class="dict-error">
            \uD83D\uDE15 No definition found for \u201c<strong>${escapeHtml(text)}</strong>\u201d.
          </p>
          <p class="dict-suggestion">
            ${isPhrase
              ? "Try selecting fewer words or verify the phrase."
              : "Verify the spelling and try again."}
          </p>${warningHtml}`
        );
        writeLog("error", `No definition found for "${text}"${_configuredApiWarnings.length > 0 ? " | " + _configuredApiWarnings.join(" • ") : ""}`);
      }
    } catch (err) {
      if (err.name === "AbortError" || signal.aborted) return;
      writeLog("error", `Network error during lookup for "${text}": ${err.message ?? err}`);
      safeSetHTML(
        elBody,
        `<p class="dict-error">\u26A0\uFE0F Network error \u2014 check your connection and try again.</p>`
      );
    } finally {
      if (mySeq === _lookupSeq && !signal.aborted) {
        startAutoClose();
      }
    }
  }

  // ─── Local File Management ────────────────────────────────────────────────
  const idbDropzone       = document.getElementById("idb-dropzone");
  const idbFileInput      = document.getElementById("idb-file-input");
  const idbModalStatus    = document.getElementById("idb-modal-status");
  const idbRecentList     = document.getElementById("idb-recent-list");
  const idbOpenTriggerBtn = document.getElementById("idb-open-trigger-btn");

  if (
    !idbDropzone  || !idbFileInput || !idbModalStatus ||
    !idbRecentList || !idbOpenTriggerBtn
  ) {
    writeLog("warn", "IDB file manager: one or more DOM elements missing — feature disabled.");
  } else {
    _initLocalFileManager();
  }

function _initLocalFileManager() {
    if (!window.InstantDictionaryDB) {
      writeLog("error", "IDB file manager: window.InstantDictionaryDB not found. Ensure db.js loads before sidebar.js.");
      return;
    }

    let _openOpGen = 0;

    const viewDict     = document.getElementById("view-dictionary");
    const viewLf       = document.getElementById("view-local-files");
    const lfBackBtn    = document.getElementById("lf-back-btn");

    async function _toggleLocalFilesView(show) {
      viewDict.hidden = show;
      viewLf.hidden   = !show;
      
      if (show) {
        if (_autoCloseAnimation) {
          _autoCloseAnimation.cancel();
        }
        
        _clearModalStatus();
        await _renderRecentFiles(); 
      } else {
        if (window.InstantDictionaryDB && typeof window.InstantDictionaryDB.closeConnection === "function") {
          window.InstantDictionaryDB.closeConnection();
        }
        idbRecentList.replaceChildren(); 
        startAutoClose();
      }
    }

    idbOpenTriggerBtn.addEventListener("click", () => {
      _toggleLocalFilesView(true);
      idbDropzone.focus();
    });

    idbOpenTriggerBtn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        idbOpenTriggerBtn.click();
      }
    });

    lfBackBtn.addEventListener("click", () => _toggleLocalFilesView(false));

    function _formatFileSize(bytes) {
      if (typeof bytes !== "number" || bytes < 0) return "unknown size";
      if (bytes === 0)        return "0 B";
      if (bytes < 1024)       return `${bytes} B`;
      if (bytes < 1048576)    return `${(bytes / 1024).toFixed(1)} KB`;
      if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
      return `${(bytes / 1073741824).toFixed(2)} GB`;
    }

    function _formatDate(isoString) {
      if (!isoString) return "";
      try {
        const d = new Date(isoString);
        if (isNaN(d.getTime())) return "";
        const datePart = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
        const timePart = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
        return `${datePart} \u00B7 ${timePart}`;
      } catch { return ""; }
    }

    function _getFileIcon(fileType, filename) {
      const name = (filename || "").toLowerCase();
      const type = (fileType || "").toLowerCase();
      if (type === "pdf" || type === "application/pdf"        || name.endsWith(".pdf"))  return "\uD83D\uDCC4";
      if (type === "epub"|| type === "application/epub+zip"   || name.endsWith(".epub")) return "\uD83D\uDCDA";
      if (type === "docx"|| type.includes("wordprocessingml") || name.endsWith(".docx") || name.endsWith(".doc")) return "\uD83D\uDCDD";
      if (type === "text/plain"               || name.endsWith(".txt"))  return "\uD83D\uDDD2\uFE0F";
      if (type === "text/html"                || name.endsWith(".html") || name.endsWith(".htm")) return "\uD83C\uDF10";
      return "\uD83D\uDCCE";
    }

    function _categoriseFile(file) {
      const name = (file.name || "").toLowerCase();
      const type = (file.type || "").toLowerCase();
      if (type === "application/pdf"        || name.endsWith(".pdf"))  return "pdf";
      if (type === "application/epub+zip"   || name.endsWith(".epub")) return "epub";
      if (type.includes("wordprocessingml") || name.endsWith(".docx") || name.endsWith(".doc")) return "docx";
      return "unknown";
    }

    function _showModalStatus(level, text) {
      idbModalStatus.className   = `idb-status--${level}`;
      idbModalStatus.textContent = text;
    }

    function _clearModalStatus() {
      idbModalStatus.className   = "";
      idbModalStatus.textContent = "";
    }

    function _openPdfInViewer(id) {
      return new Promise((resolve, reject) => {
        if (!isRuntimeValid()) {
          reject(new Error("Extension context invalidated."));
          return;
        }

        let viewerBase;
        try { viewerBase = chrome.runtime.getURL("pdfjs/web/viewer.html"); } 
        catch (err) { reject(err); return; }

        const viewerUrl = `${viewerBase}?dbid=${encodeURIComponent(id)}`;

        try {
          chrome.tabs.query({}, (tabs) => {
            if (!isRuntimeValid()) { reject(new Error("Context invalidated")); return; }
            if (chrome.runtime.lastError || !Array.isArray(tabs)) {
              _createViewerTab(viewerUrl, resolve, reject);
              return;
            }

            const existingTab = tabs.find(t => t.url && t.url.startsWith(viewerBase));

            if (existingTab) {
              if (existingTab.url === viewerUrl) {
                chrome.tabs.update(existingTab.id, { active: true }, (updatedTab) => {
                  if (!isRuntimeValid()) { reject(new Error("Context invalidated")); return; }
                  if (chrome.runtime.lastError) {
                    _createViewerTab(viewerUrl, resolve, reject);
                    return;
                  }
                  chrome.windows.update(existingTab.windowId, { focused: true }, () => resolve(updatedTab || existingTab));
                });
              } else {
                chrome.tabs.update(existingTab.id, { url: viewerUrl, active: true }, (updatedTab) => {
                  if (!isRuntimeValid()) { reject(new Error("Context invalidated")); return; }
                  if (chrome.runtime.lastError) {
                    _createViewerTab(viewerUrl, resolve, reject);
                    return;
                  }
                  chrome.windows.update(existingTab.windowId, { focused: true }, () => resolve(updatedTab || existingTab));
                });
              }
            } else {
              _createViewerTab(viewerUrl, resolve, reject);
            }
          });
        } catch (err) {
          _createViewerTab(viewerUrl, resolve, reject);
        }
      });
    }

    function _createViewerTab(url, resolve, reject) {
      chrome.tabs.create({ url }, (tab) => {
        if (!isRuntimeValid()) { reject(new Error("Context invalidated")); return; }
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message || "Failed to create viewer tab."));
        } else {
          resolve(tab);
        }
      });
    }

    async function _handleFile(file) {
      if (!file || typeof file.name !== 'string') return;

      const category = _categoriseFile(file);
      if (category === "unknown") {
        _showModalStatus("error", `\u2717 \u201c${file.name}\u201d is not supported. Please use PDF, EPUB, or DOCX.`);
        return;
      }

      idbDropzone.classList.add("idb-dropzone--processing");
      _showModalStatus("loading", "\u231B Saving to library\u2026");

      let newId;
      try {
        const savedRecord = await window.InstantDictionaryDB.saveFile(file);
        newId = savedRecord.id;
        writeLog("info", `IDB: stored \u201c${file.name}\u201d \u2192 id ${newId}`);
      } catch (err) {
        idbDropzone.classList.remove("idb-dropzone--processing");
        _showModalStatus("error", `\u2717 Could not save file: ${String(err.message || err)}`);
        writeLog("error", `IDB storeFile failed for \u201c${file.name}\u201d: ${err.message || err}`);
        return;
      }

      await _renderRecentFiles();
      idbDropzone.classList.remove("idb-dropzone--processing");

      if (category === "pdf") {
        _showModalStatus("success", `\u2713 \u201c${file.name}\u201d loaded successfully.`);
        try {
          await _openPdfInViewer(newId);
        } catch (err) {
          _showModalStatus("error", `\u2717 Document could not be opened: ${String(err.message || err)}`);
          writeLog("error", `_openPdfInViewer(${newId}) failed: ${err.message || err}`);
        }
      } else if (category === "epub") {
        _showModalStatus("info", `\uD83D\uDCDA \u201c${file.name}\u201d saved to library. EPUB viewer coming soon.`);
      } else if (category === "docx") {
        _showModalStatus("info", `\uD83D\uDCDD \u201c${file.name}\u201d saved to library. DOCX viewer coming soon.`);
      }
    }

    async function _renderRecentFiles() {
      let files;
      try {
        files = await window.InstantDictionaryDB.getRecentFiles();
      } catch (err) {
        const errMsg = document.createElement("p");
        errMsg.className   = "idb-empty";
        errMsg.textContent = `\u26A0\uFE0F Could not load history: ${String(err.message || err)}`;
        
        // ATOMIC RENDER: Clear and append synchronously
        idbRecentList.replaceChildren(errMsg);
        writeLog("error", `IDB listFiles failed: ${err.message || err}`);
        return;
      }

      if (!files || files.length === 0) {
        const emptyMsg = document.createElement("p");
        emptyMsg.className   = "idb-empty";
        emptyMsg.textContent = "No files in library yet. Drop a file above to get started.";
        
        // ATOMIC RENDER: Clear and append synchronously
        idbRecentList.replaceChildren(emptyMsg);
        return;
      }

      const fragment = document.createDocumentFragment();

      files.forEach((record) => {
        const row = document.createElement("div");
        row.className = "idb-file-row";

        const iconSpan = document.createElement("span");
        iconSpan.className   = "idb-file-icon";
        iconSpan.textContent = _getFileIcon(record.type, record.filename);
        iconSpan.setAttribute("aria-hidden", "true");

        const metaDiv  = document.createElement("div");
        metaDiv.className = "idb-file-meta";

        const nameSpan = document.createElement("span");
        nameSpan.className   = "idb-file-name";
        nameSpan.textContent = record.filename;
        nameSpan.title       = record.filename;

        const infoSpan = document.createElement("span");
        infoSpan.className   = "idb-file-info";
        infoSpan.textContent = `${_formatFileSize(record.size)} \u00B7 ${_formatDate(record.lastOpened)}`;

        metaDiv.appendChild(nameSpan);
        metaDiv.appendChild(infoSpan);

        const actionsDiv = document.createElement("div");
        actionsDiv.className = "idb-file-actions";

        const openBtn = document.createElement("button");
        openBtn.type        = "button";
        openBtn.className   = "idb-btn-open";
        openBtn.textContent = "Open";
        openBtn.setAttribute("aria-label", `Open ${record.filename}`);
        openBtn.dataset.id  = String(record.id);

        const deleteBtn = document.createElement("button");
        deleteBtn.type        = "button";
        deleteBtn.className   = "idb-btn-delete";
        deleteBtn.textContent = "\u2715";
        deleteBtn.setAttribute("aria-label", `Remove ${record.filename} from library`);
        deleteBtn.dataset.id  = String(record.id);

        actionsDiv.appendChild(openBtn);
        actionsDiv.appendChild(deleteBtn);

        row.appendChild(iconSpan);
        row.appendChild(metaDiv);
        row.appendChild(actionsDiv);
        fragment.appendChild(row);

        openBtn.addEventListener("click", async () => {
          const currentGen = ++_openOpGen;
          openBtn.disabled = true;

          let rec;
          try {
            rec = await window.InstantDictionaryDB.getFileById(Number(openBtn.dataset.id));
          } catch (err) {
            if (currentGen === _openOpGen) {
              _showModalStatus("error", `\u2717 Could not retrieve file: ${String(err.message || err)}`);
              openBtn.disabled = false;
            }
            return;
          }

          if (!rec) {
            if (currentGen === _openOpGen) {
              _showModalStatus("error", "File not found in library. It may have been evicted.");
              await _renderRecentFiles();
            }
            return;
          }

          const fileObj = rec.blob instanceof File
            ? rec.blob
            : new File([rec.blob], rec.filename, { type: rec.fileType });
          const cat = _categoriseFile(fileObj);

          if (cat === "pdf") {
            if (currentGen === _openOpGen) _showModalStatus("loading", "\u231B Loading document\u2026");
            
            try {
              await _openPdfInViewer(Number(openBtn.dataset.id));
              if (currentGen === _openOpGen) {
                _clearModalStatus();
                openBtn.disabled = false;
              }
            } catch (err) {
              if (currentGen === _openOpGen) {
                _showModalStatus("error", `\u2717 Could not open document: ${String(err.message || err)}`);
                openBtn.disabled = false;
              }
            }

          } else if (cat === "epub") {
            if (currentGen === _openOpGen) {
              _showModalStatus("info", "\uD83D\uDCDA EPUB viewer coming soon.");
              openBtn.disabled = false;
            }
          } else if (cat === "docx") {
            if (currentGen === _openOpGen) {
              _showModalStatus("info", "\uD83D\uDCDD DOCX viewer coming soon.");
              openBtn.disabled = false;
            }
          } else {
            if (currentGen === _openOpGen) {
              _showModalStatus("error", "Unsupported file type.");
              openBtn.disabled = false;
            }
          }
        });

        deleteBtn.addEventListener("click", async () => {
          deleteBtn.disabled = true;
          try {
            await window.InstantDictionaryDB.deleteEntry(Number(deleteBtn.dataset.id));
            writeLog("info", `IDB: deleted record id ${deleteBtn.dataset.id}`);
            _clearModalStatus();
            await _renderRecentFiles();
          } catch (err) {
            _showModalStatus("error", `\u2717 Could not remove file: ${String(err.message || err)}`);
            writeLog("error", `IDB deleteFile(${deleteBtn.dataset.id}) failed: ${err.message || err}`);
            deleteBtn.disabled = false;
          }
        });
      });

      // ATOMIC RENDER: Clear the old list and append the fully constructed fragment instantly
      idbRecentList.replaceChildren(fragment);
    } 

    let _triggerDragDepth = 0;

    idbOpenTriggerBtn.addEventListener("dragenter", (e) => {
      e.preventDefault();
      e.stopPropagation();
      _triggerDragDepth++;
      idbOpenTriggerBtn.classList.add("idb-trigger--drag-active");
    });

    idbOpenTriggerBtn.addEventListener("dragleave", (e) => {
      e.stopPropagation();
      _triggerDragDepth--;
      if (_triggerDragDepth <= 0) {
        _triggerDragDepth = 0;
        idbOpenTriggerBtn.classList.remove("idb-trigger--drag-active");
      }
    });

    idbOpenTriggerBtn.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    idbOpenTriggerBtn.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      _triggerDragDepth = 0;
      idbOpenTriggerBtn.classList.remove("idb-trigger--drag-active");
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length > 0) {
        _toggleLocalFilesView(true);
        _handleFile(files[0]);
      }
    });

    let _dropzoneDragDepth = 0;

    idbDropzone.addEventListener("dragenter", (e) => {
      e.preventDefault();
      _dropzoneDragDepth++;
      idbDropzone.classList.add("idb-dropzone--active");
    });

    idbDropzone.addEventListener("dragleave", () => {
      _dropzoneDragDepth--;
      if (_dropzoneDragDepth <= 0) {
        _dropzoneDragDepth = 0;
        idbDropzone.classList.remove("idb-dropzone--active");
      }
    });

    idbDropzone.addEventListener("dragover", (e) => {
      e.preventDefault(); 
    });

    idbDropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      _dropzoneDragDepth = 0;
      idbDropzone.classList.remove("idb-dropzone--active");
      idbDropzone.classList.remove("idb-dropzone--processing");
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length > 0) _handleFile(files[0]);
    });

    idbDropzone.addEventListener("click", () => {
      if (!idbDropzone.classList.contains("idb-dropzone--processing")) {
        idbFileInput.click();
      }
    });

    idbDropzone.addEventListener("keydown", (e) => {
      if (
        (e.key === "Enter" || e.key === " ") &&
        !idbDropzone.classList.contains("idb-dropzone--processing")
      ) {
        e.preventDefault();
        idbFileInput.click();
      }
    });

    idbFileInput.addEventListener("change", () => {
      const files = idbFileInput.files;
      if (files && files.length > 0) _handleFile(files[0]);
      idbFileInput.value = "";
    });

  } 

// ─── Bootstrapper for Initialization ──────────────────────────────────────
  // 1. Fire the IPC request instantly upon script execution. 
  chrome.runtime.sendMessage({ action: "check_startup_state" }, (response) => {
    
    // Guard: Prevent unhandled exceptions if context dies mid-handshake
    if (!isRuntimeValid()) return;

    // 2. If a user managed to trigger a lookup during the microsecond IPC delay
    if (_lookupSeq > 0) {
      if (document.documentElement) document.documentElement.style.visibility = "";
      _safeStartAutoClose();
      return;
    }

    // 3. Evaluate the startup state
    if (!chrome.runtime.lastError && response && response.isStartup) {
      // Direct, synchronous self-termination. 
      try { 
        window.close(); 
      } catch(e) {
        writeLog("warn", "Instant startup termination failed.");
      }
    } else {
      // 4. We are staying open. Reveal the UI and initialize normal lifecycle.
      if (document.documentElement) document.documentElement.style.visibility = "";
      _safeStartAutoClose();
    }
  });

  // Helper to ensure DOM is ready before manipulating UI timers
  function _safeStartAutoClose() {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", startAutoClose, { once: true });
    } else {
      startAutoClose();
    }
  }

})();