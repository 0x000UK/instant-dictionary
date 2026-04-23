(function () {
  "use strict";
  
  // ─── Guard: do not inject into pages without a body (XML viewers, etc.) ───
  if (!document.body) return;

  // ─── Guard: do not inject twice ───────────────────────────────────────────
  if (document.getElementById("dict-extension-host")) return;

  // ─── Extension context guard ──────────────────────────────────────────────
  function isRuntimeValid() {
    try {
      return !!(typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  if (!isRuntimeValid()) return;

  // ─── Shared constants ─────────────────────────────────────────────────────
  // ─── Shared constants ─────────────────────────────────────────────────────
  const { MW_DEFAULT_LIMIT, S4_DEFAULT_LIMIT, STORAGE_TIMEOUT_MS, AUDIO_SAFETY_MS } = window.SharedConstants;

  // ─── Configuration ────────────────────────────────────────────────────────
  const AUTO_CLOSE_MS  = 6000; 
  const CACHE_MAX_SIZE = 200;  

  // ─── Positioning constants ────────────────────────────────────────────────
  const TOOLTIP_MARGIN      = 10; 
  const PILL_MARGIN         = 8;  
  const PILL_ESTIMATED_W    = 80; 
  const PILL_ESTIMATED_H    = 32; 

  // ─── Storage key constants ────────────────────────────────────────────────
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

  // ─── Per-session lookup cache ─────────────────────────────────────────────
  const lookupCache = new Map();

  // ─── Shared state ─────────────────────────────────────────────────────────
  let currentAbortController = null;
  let _isTooltipHovered = false;
  let mouseUpTimer = null;
  let lookupDebounceTimer = null;
  let _autoCloseAnimation = null;
  let currentClientX = 0;
  let currentClientY = 0;
  let _anchorPageX = 0;
  let _anchorPageY = 0;
  let currentAudio = null;
  let _switchSafetyTimer = null;

  // ─── MW switch state ──────────────────────────────────────────────────────
  let _mwState = { activeApi: null, word: null, text: null };
  const mwAltCache = new Map();

  function mwAltCacheSet(key, value) {
    if (mwAltCache.size >= CACHE_MAX_SIZE) {
      mwAltCache.delete(mwAltCache.keys().next().value);
    }
    mwAltCache.set(key, value);
  }

  // ─── Pill state ───────────────────────────────────────────────────────────
  let pillText      = "";   
  let pillTimer     = null; 
  let pillHideTimer = null; 

  // ─── Configured-API warning accumulator ──────────────────────────────────
  let _configuredApiWarnings = [];

  // ─── Drag-tracking state ──────────────────────────────────────────────────
  let isDragging  = false;
  let _mousedownX = 0;
  let _mousedownY = 0;

  // ─── safeSetHTML constants ────────────────────────────────────────────────
  const _SANITIZE_UNSAFE_ATTR  = /^on/i;
  const _SANITIZE_URL_ATTRS = new Set(["href", "src", "srcset", "poster", "action", "formaction", "data"]);
  const _SANITIZE_SAFE_SCHEMES = /^(https?|mailto|tel):/i;
  const _SANITIZE_BLOCKED_ELEMENTS = new Set([
    "SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED",
    "LINK", "BASE", "META", "FORM", "INPUT",
    "TEXTAREA", "SELECT", "BUTTON", "TEMPLATE",
    "SVG", "MATH",
  ]);

  function _sanitiseNode(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    if (_SANITIZE_BLOCKED_ELEMENTS.has(node.nodeName)) {
      node.parentNode?.removeChild(node);
      return;
    }

    const toRemove = [];
    for (const attr of node.attributes) {
      if (_SANITIZE_UNSAFE_ATTR.test(attr.name)) {
        toRemove.push(attr.name);
        continue;
      }
      if (_SANITIZE_URL_ATTRS.has(attr.name.toLowerCase())) {
        const val = attr.value.trim();
        if (val && !val.startsWith("#") && !_SANITIZE_SAFE_SCHEMES.test(val)) {
          toRemove.push(attr.name);
        }
      }
    }
    toRemove.forEach((a) => node.removeAttribute(a));
    Array.from(node.childNodes).forEach(_sanitiseNode);
  }

  const _reducedMotionMql = window.matchMedia?.("(prefers-reduced-motion: reduce)");

  // ─── Shadow DOM ───────────────────────────────────────────────────────────
  const shadowHost = document.createElement("div");
  shadowHost.id = "dict-extension-host";
  Object.assign(shadowHost.style, {
    position:      "fixed",
    top:           "0",
    left:          "0",
    width:         "0",
    height:        "0",
    overflow:      "visible",
    zIndex:        "2147483647",
    pointerEvents: "none",  
  });
  const shadowRoot = shadowHost.attachShadow({ mode: "closed" });
  document.body.appendChild(shadowHost);

  const styleLink = document.createElement("link");
  styleLink.rel  = "stylesheet";
  styleLink.href = chrome.runtime.getURL("content.css");
  shadowRoot.appendChild(styleLink);

  // ─── Build tooltip DOM ────────────────────────────────────────────────────
  const tooltip = document.createElement("div");
  tooltip.id = "dict-tooltip";
  tooltip.setAttribute("role", "tooltip");
  tooltip.setAttribute("aria-live", "polite");
  tooltip.style.display = "none";

  const header = document.createElement("div");
  header.id = "dict-tooltip-header";

  const wordSpan = document.createElement("span");
  wordSpan.id = "dict-tooltip-word";
  header.appendChild(wordSpan);

  const phoneticSpan = document.createElement("span");
  phoneticSpan.id = "dict-tooltip-phonetic";
  header.appendChild(phoneticSpan);

  const headerRight = document.createElement("div");
  headerRight.id = "dict-tooltip-header-right";

  const mwSwitchBtn = document.createElement("button");
  mwSwitchBtn.id = "dict-mw-switch-btn";
  mwSwitchBtn.setAttribute("type", "button");
  mwSwitchBtn.setAttribute("aria-label", "Switch Merriam-Webster dictionary");
  mwSwitchBtn.style.display = "none"; 
  headerRight.appendChild(mwSwitchBtn);

  const closeBtn = document.createElement("button");
  closeBtn.id = "dict-tooltip-close";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "\u00d7";
  headerRight.appendChild(closeBtn);

  header.appendChild(headerRight);

  const scrollArea = document.createElement("div");
  scrollArea.id = "dict-tooltip-scroll-area";

  const bodyDiv = document.createElement("div");
  bodyDiv.id = "dict-tooltip-body";

  const sourceDiv = document.createElement("div");
  sourceDiv.id = "dict-tooltip-source";

  scrollArea.appendChild(bodyDiv);
  scrollArea.appendChild(sourceDiv);

  const countdownBar = document.createElement("div");
  countdownBar.id = "dict-tooltip-countdown";

  tooltip.appendChild(header);
  tooltip.appendChild(scrollArea);
  tooltip.appendChild(countdownBar);

  shadowRoot.appendChild(tooltip);

  // ─── Build pill DOM ───────────────────────────────────────────────────────
  const pill = document.createElement("div");
  pill.id = "dict-pill";
  pill.setAttribute("role", "button");
  pill.setAttribute("aria-label", "Look up in dictionary");
  pill.setAttribute("tabindex", "0");

  const pillIcon = document.createElement("img");
  pillIcon.id  = "dict-pill-icon";
  pillIcon.src = chrome.runtime.getURL("icons/icon48.png");
  pillIcon.alt = "";

  const pillLabel = document.createElement("span");
  pillLabel.textContent = "Define";

  pill.appendChild(pillIcon);
  pill.appendChild(pillLabel);
  shadowRoot.appendChild(pill);

  const elWord     = tooltip.querySelector("#dict-tooltip-word");
  const elPhonetic = tooltip.querySelector("#dict-tooltip-phonetic");
  const elBody     = tooltip.querySelector("#dict-tooltip-body");
  const elSource   = tooltip.querySelector("#dict-tooltip-source");

  // ─── Helpers ──────────────────────────────────────────────────────────────
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#x27;")
      .replace(/`/g, "&#x60;");
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
    } catch {
      return "";
    }
  }

  function isSafeHttpsUrl(url) {
    if (typeof url !== "string" || !url) return false;
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:";
    } catch {
      return false;
    }
  }

  function normaliseLookupKey(text) {
    return text.normalize("NFC").toLowerCase().replace(/ +/g, " ").trim();
  }

  function cacheSet(key, value) {
    if (lookupCache.size >= CACHE_MAX_SIZE) {
      lookupCache.delete(lookupCache.keys().next().value);
    }
    lookupCache.set(key, value);
  }

  function getStoredKeys() {
    return new Promise((resolve) => {
      const defaults = {
        mwCollegiateKey: "", mwThesaurusKey: "",
        s4Uid: "", s4Token: "", priority: "auto",
        mwCount: 0, mwThesaurusCount: 0, s4Count: 0, mwLimit: MW_DEFAULT_LIMIT, s4Limit: S4_DEFAULT_LIMIT,
      };

      if (!isRuntimeValid()) {
        resolve(defaults);
        return;
      }

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

            // ─── Prevent fatal throw if wrapper destroyed ───
            if (!isRuntimeValid()) {
              resolve(defaults);
              return;
            }

            if (chrome.runtime.lastError) {
              resolve(defaults);
              return;
            }
            const safe = (v) => (typeof v === "string" ? v.trim() : "");

            const today    = new Date().toISOString().slice(0, 10);
            const usageRaw = result[KEY_API_USAGE];
            const usage    = (usageRaw && typeof usageRaw === "object" && usageRaw.date === today)
              ? usageRaw
              : { date: today, mw_count: 0, mw_thesaurus_count: 0, s4_count: 0 };

            const legacyKey      = safe(result[KEY_MW_KEY]);
            const rawCollegiate  = safe(result[KEY_MW_COLLEGIATE_KEY]);
            const mwCollegiateKey = rawCollegiate || legacyKey;
            const mwThesaurusKey  = safe(result[KEY_MW_THESAURUS_KEY]);

            resolve({
              mwCollegiateKey,
              mwThesaurusKey,
              s4Uid:    safe(result[KEY_S4_UID]),
              s4Token:  safe(result[KEY_S4_TOKEN]),
              priority: safe(result[KEY_LOOKUP_PRIORITY]) || "auto",
              mwCount:  typeof usage.mw_count              === "number" ? usage.mw_count              : 0,
              mwThesaurusCount: typeof usage.mw_thesaurus_count === "number" ? usage.mw_thesaurus_count : 0,
              s4Count:  typeof usage.s4_count              === "number" ? usage.s4_count              : 0,
              mwLimit:  typeof result[KEY_API_MW_LIMIT]    === "number" ? result[KEY_API_MW_LIMIT]    : MW_DEFAULT_LIMIT,
              s4Limit:  typeof result[KEY_API_S4_LIMIT]    === "number" ? result[KEY_API_S4_LIMIT]    : S4_DEFAULT_LIMIT,
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

  let _counterFlushPending = false;
  const _counterQueue = [];

  function _flushCounterQueue() {
    if (!isRuntimeValid()) { _counterFlushPending = false; return; }
    if (_counterQueue.length === 0) { _counterFlushPending = false; return; }
    _counterFlushPending = true;
    const today = new Date().toISOString().slice(0, 10);
    try {
  chrome.storage.local.get([KEY_API_USAGE], (getResult) => {
  if (!isRuntimeValid()) { _counterFlushPending = false; return; }
  if (chrome.runtime.lastError) { _counterFlushPending = false; return; }
  const existing = getResult[KEY_API_USAGE];
        const usage    = (existing && typeof existing === "object" && existing.date === today)
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
          // ─── Guard against context death mid-flight ───
          if (!isRuntimeValid() || chrome.runtime.lastError) {
            for (let i = _counterBatch.length - 1; i >= 0; i--) {
              _counterQueue.unshift(_counterBatch[i]);
            }
            return;
          }
          if (_counterQueue.length > 0) _flushCounterQueue();
        });
      });
    } catch (err) {
      _counterFlushPending = false;
    }
  }

  function incrementApiCounter(api) {
    if (api !== "mw" && api !== "mw_thesaurus" && api !== "s4") return;
    if (!isRuntimeValid()) return;
    _counterQueue.push(api);
    if (!_counterFlushPending) _flushCounterQueue();
  }

  let _logFlushPending = false;
  const _logEntryQueue = [];

  function _flushLogQueue() {
    if (!isRuntimeValid()) { _logFlushPending = false; return; }
    if (_logEntryQueue.length === 0) { _logFlushPending = false; return; }
    _logFlushPending = true;
    try {
  chrome.storage.local.get([KEY_EXT_LOGS], (getResult) => {
  if (!isRuntimeValid()) { _logFlushPending = false; return; }
  if (chrome.runtime.lastError) { _logFlushPending = false; return; }
  const existing = Array.isArray(getResult[KEY_EXT_LOGS]) ? getResult[KEY_EXT_LOGS] : [];
        const _logBatch = [];
        while (_logEntryQueue.length > 0) _logBatch.push(_logEntryQueue.shift());
        const combined = [...existing, ..._logBatch];
        const trimmed = combined.length > MAX_LOG_ENTRIES
          ? combined.slice(combined.length - MAX_LOG_ENTRIES)
          : combined;
        chrome.storage.local.set({ [KEY_EXT_LOGS]: trimmed }, () => {
          _logFlushPending = false;
          // ─── Guard against context death mid-flight ───
          if (!isRuntimeValid() || chrome.runtime.lastError) {
            for (let i = _logBatch.length - 1; i >= 0; i--) {
              _logEntryQueue.unshift(_logBatch[i]);
            }
            return; 
          }
          if (_logEntryQueue.length > 0) _flushLogQueue();
        });
      });
    } catch {
      _logFlushPending = false;
    }
  }

  function writeLog(level, msg) {
    if (!isRuntimeValid()) return;
    _logEntryQueue.push({ ts: new Date().toISOString(), level, msg });
    if (!_logFlushPending) _flushLogQueue();
  }

  const _THEME_CONTAINER_SELECTORS = [
    "main", "#app", "#root", "#__next", ".app", "[data-theme]",
  ];
  const _THEME_CLAMP = (v) => Math.min(255, Math.max(0, v));

  function applyPageTheme() {
    let bgColor = null;

    const candidates = [
      document.body,
      document.documentElement,
      ..._THEME_CONTAINER_SELECTORS
          .map((s) => {
            try { return document.querySelector(s); } catch { return null; }
          })
          .filter(Boolean)
          .slice(0, 5),
    ];

    for (const el of candidates) {
      if (!el) continue;
      try {
        const computed = window.getComputedStyle(el).backgroundColor;
        if (computed && computed !== "rgba(0, 0, 0, 0)" && computed !== "transparent") {
          bgColor = computed;
          break;
        }
      } catch { }
    }
    bgColor = bgColor || "rgb(255, 255, 255)";

    const isRgbValue = /^rgba?\s*\(/i.test(bgColor);
    const match = isRgbValue ? bgColor.match(/[\d.]+/g) : null;
    const r = (match && match[0] != null) ? _THEME_CLAMP(parseInt(match[0], 10)) : 255;
    const g = (match && match[1] != null) ? _THEME_CLAMP(parseInt(match[1], 10)) : 255;
    const b = (match && match[2] != null) ? _THEME_CLAMP(parseInt(match[2], 10)) : 255;

    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    const isDark    = luminance < 0.5;

    const shift = isDark ? 25 : -18;

    const s = tooltip.style;
    s.setProperty("--dict-auto-close-ms",  `${AUTO_CLOSE_MS}ms`);
    s.setProperty("--dict-bg",             `rgb(${r}, ${g}, ${b})`);
    s.setProperty("--dict-header-bg",      `rgb(${_THEME_CLAMP(r + shift)}, ${_THEME_CLAMP(g + shift)}, ${_THEME_CLAMP(b + shift)})`);
    s.setProperty("--dict-text",           isDark ? "rgb(220, 220, 220)" : "rgb(28, 28, 28)");
    s.setProperty("--dict-subtext",        isDark ? "rgb(150, 150, 150)" : "rgb(110, 110, 110)");
    s.setProperty("--dict-border",         isDark ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.12)");
    s.setProperty("--dict-divider",        isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.07)");
    s.setProperty("--dict-close-bg",       isDark ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.07)");
    s.setProperty("--dict-close-hover-bg", isDark ? "rgba(255,255,255,0.20)" : "rgba(0,0,0,0.15)");
    s.setProperty("--dict-accent-bg",      isDark ? "rgba(255,255,255,0.09)" : "rgba(0,0,0,0.06)");
    s.setProperty("--dict-accent-text",    isDark ? "rgb(190, 190, 190)" : "rgb(70, 70, 70)");
  }

function hideTooltip() {
    // 1. Generational Ticket Invalidation
    // Instantly orphan any async lookups that were in-flight when the UI closed.
    _lookupSeq++;

    tooltip.style.display = "none";
    tooltip.classList.remove("dict-counting");

    // Reset logical pointer state the moment the UI disappears
    _isTooltipHovered = false;

    if (_autoCloseAnimation) {
      _autoCloseAnimation.cancel(); // Instantly halts animation and drops the onfinish callback
      _autoCloseAnimation = null;
	  countdownBar.style.transform = "";
    }

    clearTimeout(mouseUpTimer);
    mouseUpTimer = null;

    clearTimeout(lookupDebounceTimer);
    lookupDebounceTimer = null;

    if (currentAbortController) {
      currentAbortController.abort();
      currentAbortController = null;
    }

    _mwState = { activeApi: null, word: null, text: null };
    mwSwitchBtn.style.display = "none";

    _anchorPageX = 0;
    _anchorPageY = 0;
	
	clearTimeout(_switchSafetyTimer);
    _switchSafetyTimer = null;

    stopAudio();

    // 2. Atomic DOM Flush
    // Purge the rendered tree so BFCache and the garbage collector have zero dead 
    // dictionary nodes bloating the host page's memory while hidden.
    if (elWord) elWord.textContent = "";
    if (elPhonetic) elPhonetic.textContent = "";
    if (elSource) elSource.textContent = "";
    if (elBody) elBody.replaceChildren();
  }

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

  function resumeAutoClose() {
    if (AUTO_CLOSE_MS > 0 && tooltip.style.display !== "none") {
      tooltip.classList.add("dict-counting");
      startAutoClose();
    }
  }
  
  function pauseAutoClose() {
    if (AUTO_CLOSE_MS <= 0 || !_autoCloseAnimation) return;
    if (_autoCloseAnimation.playState === "running") {
      _autoCloseAnimation.pause();
    }
  }

  function getViewport() {
    const vv = window.visualViewport;
    return {
      width:  (vv ? vv.width  : window.innerWidth)  || window.innerWidth,
      height: (vv ? vv.height : window.innerHeight) || window.innerHeight,
    };
  }

  const cachedPdfContainer = document.getElementById("viewerContainer");

  function getScrollOffset() {
    if (cachedPdfContainer) {
      return { x: cachedPdfContainer.scrollLeft, y: cachedPdfContainer.scrollTop };
    }
    return {
      x: window.scrollX ?? window.pageXOffset ?? 0,
      y: window.scrollY ?? window.pageYOffset ?? 0,
    };
  }

function startAutoClose() {
  if (AUTO_CLOSE_MS <= 0) return;

  // 1. Teardown any existing animation instantly
  if (_autoCloseAnimation) {
    _autoCloseAnimation.cancel();
  }

  // 2. Respect Accessibility
  const duration = _reducedMotionMql?.matches ? 1 : AUTO_CLOSE_MS + 2000;

  // 3. Instantiate WAAPI
  _autoCloseAnimation = countdownBar.animate(
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

  // 4. GUARD: Prevent timer runaway if updated in-place while hovered
  if (_isTooltipHovered) {
    _autoCloseAnimation.pause();
  }

  // 5. Bind the BFCache-safe cleanup
  _autoCloseAnimation.onfinish = () => {
    hideTooltip();
  };
}

tooltip.addEventListener("mouseenter", () => {
  _isTooltipHovered = true; // Track physical state

  if (AUTO_CLOSE_MS <= 0 || !_autoCloseAnimation) return;
  
  if (_autoCloseAnimation.playState === "running") {
    _autoCloseAnimation.pause();
  }
});

tooltip.addEventListener("mouseleave", () => {
  _isTooltipHovered = false; // Track physical state

  if (AUTO_CLOSE_MS <= 0 || !_autoCloseAnimation) return;
  
  if (tooltip.style.display === "none") return;

  if (_autoCloseAnimation.playState === "paused") {
    _autoCloseAnimation.play();
  }
});

  closeBtn.addEventListener("click", hideTooltip);

  document.addEventListener("click", (e) => {
    if (e.composedPath().includes(shadowHost)) return;
    const sel = window.getSelection();
    if (sel && sel.toString().trim().length > 0) return;
    hideTooltip();
    hidePill(true);
  }, { capture: true });

  function getCleanSelection() {
    const sel = window.getSelection();
    if (!sel || sel.toString().trim() === "") return "";
    
    try {
      if (sel.anchorNode && shadowRoot.contains(sel.anchorNode)) return "";
    } catch (e) { }
    
    let text = sel.toString();
    text = text.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/g, "");
    text = text.replace(/^[^a-zA-Z\p{L}\d]+|[^a-zA-Z\p{L}\d]+$/gu, "");
    return text.replace(/\s+/g, " ").trim();
  }

  function isValidLookup(text) {
    if (typeof text !== "string") return false;
    const t = text.normalize("NFC").trim();
    if (t.length === 0 || t.length > 60) return false;
    if (t.length === 1) return /^[aAiI]$/u.test(t);
    return /^\p{L}([\p{L} \-']*\p{L})?$/u.test(t);
  }

  function positionTooltip(x, y, animate) {
    if (!animate) {
      tooltip.style.transition = "none";
      void tooltip.offsetHeight; 
    }

    const tipWidth  = tooltip.offsetWidth  || 370;
    const tipHeight = tooltip.offsetHeight || 0;

    const { width: vpWidth, height: vpHeight } = getViewport();

    let left = x + TOOLTIP_MARGIN;
    let top  = y + TOOLTIP_MARGIN * 2;

    if (left + tipWidth > vpWidth - TOOLTIP_MARGIN) {
      left = x - tipWidth - TOOLTIP_MARGIN;
    }
    left = Math.max(TOOLTIP_MARGIN, left);

    tooltip.style.left = `${left}px`;

    if (top + tipHeight > vpHeight - TOOLTIP_MARGIN) {
      top = Math.max(TOOLTIP_MARGIN, y - tipHeight - TOOLTIP_MARGIN);
    }
    tooltip.style.top = `${top}px`;

    if (!animate) {
      void tooltip.offsetHeight; 
      tooltip.style.transition = "";
    }
  }

  function hidePill(immediate) {
    clearTimeout(pillTimer);
    clearTimeout(pillHideTimer);
    pillTimer     = null;
    pillHideTimer = null;
    pillText      = "";

    if (!pill.classList.contains("dict-pill-visible")) return;

    if (immediate) {
      pill.classList.remove("dict-pill-visible", "dict-pill-hiding");
      return;
    }

    pill.classList.add("dict-pill-hiding");
    pillHideTimer = setTimeout(() => {
      pillHideTimer = null;
      pill.classList.remove("dict-pill-visible", "dict-pill-hiding");
    }, 150);
  }

  function showPill(x, y, text) {
    hidePill(true);
    pillText = text;

    applyPageTheme();
    const ts = tooltip.style;
    pill.style.setProperty("--dict-pill-bg",     ts.getPropertyValue("--dict-bg")     || "#fff");
    pill.style.setProperty("--dict-pill-border",  ts.getPropertyValue("--dict-border") || "rgba(0,0,0,0.13)");
    pill.style.setProperty("--dict-pill-text",    ts.getPropertyValue("--dict-text")   || "#333");

    const { width: vpWidth, height: vpHeight } = getViewport();

    let left = x + PILL_MARGIN;
    let top  = y - PILL_ESTIMATED_H - PILL_MARGIN;

    if (left + PILL_ESTIMATED_W > vpWidth  - PILL_MARGIN) left = x - PILL_ESTIMATED_W - PILL_MARGIN;
    if (top < PILL_MARGIN)                                 top  = y + PILL_MARGIN;
    if (top + PILL_ESTIMATED_H > vpHeight - PILL_MARGIN)  top  = vpHeight - PILL_ESTIMATED_H - PILL_MARGIN;
    left = Math.max(PILL_MARGIN, left);
    top  = Math.max(PILL_MARGIN, top);

    pill.style.left = `${left}px`;
    pill.style.top  = `${top}px`;

    pill.classList.remove("dict-pill-hiding", "dict-pill-visible");
    void pill.offsetHeight; 
    pill.classList.add("dict-pill-visible");

    pillTimer = setTimeout(() => {
      pillTimer = null;
      hidePill(false);
    }, 2000);
  }

  function onPillActivate(e) {
    e.preventDefault();
    e.stopPropagation();
    const text = pillText;
    if (!text || !isValidLookup(text)) return;
    const rect = pill.getBoundingClientRect();
    const cx   = rect.left + rect.width  / 2;
    const cy   = rect.bottom;
    hidePill(true);
    showTooltip(cx, cy, text);
    debouncedLookup(text);
  }

  pill.addEventListener("click", onPillActivate);
  pill.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") onPillActivate(e);
  });

function showTooltip(clientX, clientY, text) {
    if (!isValidLookup(text)) return;

    if (currentAbortController) {
      currentAbortController.abort();
      currentAbortController = null;
    }

    // Freeze and reset the countdown bar while loading
    if (_autoCloseAnimation) {
      _autoCloseAnimation.cancel();
      _autoCloseAnimation = null;
    }
    tooltip.classList.remove("dict-counting");

    currentClientX = clientX;
    currentClientY = clientY;

    const scrollPos = getScrollOffset();
    _anchorPageX = clientX + scrollPos.x;
    _anchorPageY = clientY + scrollPos.y;

    _mwState = { activeApi: null, word: null, text: null };
    mwSwitchBtn.style.display = "none";

    applyPageTheme();

    elWord.textContent     = text;
    elPhonetic.textContent = "";
    elSource.textContent   = "";

    safeSetHTML(
      elBody,
      `<p class="dict-loading">\uD83D\uDCD6 Looking up \u201c<strong>${escapeHtml(text)}</strong>\u201d\u2026</p>`
    );

    tooltip.style.display = "block";

    tooltip.style.transition = "none";
    tooltip.style.animation  = "none";
    void tooltip.offsetHeight; 
    if (!_reducedMotionMql?.matches) {
      tooltip.style.willChange = "transform, opacity";
    }
    tooltip.style.animation  = "";
    tooltip.style.transition = "";

    positionTooltip(clientX, clientY, false);
	
  }

  // ─── ROBUST EVENT PIPELINE ──────────────────────────────────────────────
  
  document.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (e.composedPath().includes(shadowHost)) return;

    _mousedownX = e.clientX;
    _mousedownY = e.clientY;
    isDragging = false; 

    hideTooltip();
    hidePill(true);
  }, { capture: true, passive: true });

  document.addEventListener("mousemove", (e) => {
    if (e.buttons === 1) {
      if (Math.abs(e.clientX - _mousedownX) > 5 || Math.abs(e.clientY - _mousedownY) > 5) {
        isDragging = true;
      }
    }
  }, { capture: true, passive: true });

  document.addEventListener("mouseup", (e) => {
    if (e.button !== 0) return;
    if (e.composedPath().includes(shadowHost)) return;

    clearTimeout(mouseUpTimer);

    const text = getCleanSelection();

    if (!text || !isValidLookup(text)) return;

    if (!isDragging) return;

    showPill(e.clientX, e.clientY, text);
    isDragging = false;
  }, { capture: true });

  document.addEventListener("dblclick", (e) => {
    if (e.button !== 0) return;
    if (e.composedPath().includes(shadowHost)) return;
    
    clearTimeout(mouseUpTimer);
    mouseUpTimer = null;
    hidePill(true);

    setTimeout(() => {
      const text = getCleanSelection();
      if (isValidLookup(text)) {
        showTooltip(e.clientX, e.clientY, text);
        debouncedLookup(text);
      }
    }, 10);
  }, { capture: true });

  // ────────────────────────────────────────────────────────────────────────

  window.addEventListener("blur", () => {
    if (isDragging) {
      isDragging = false;
      clearTimeout(mouseUpTimer);
      mouseUpTimer = null;
    }
  }, { capture: true });

  document.addEventListener("pointercancel", () => {
    if (isDragging) {
      isDragging = false;
      clearTimeout(mouseUpTimer);
      mouseUpTimer = null;
    }
  }, { capture: true });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      hideTooltip();
      hidePill(true);
      isDragging = false;
      clearTimeout(mouseUpTimer);
      mouseUpTimer = null;
    }
  }, { capture: true });

  window.addEventListener("pagehide", () => {
    // Rely on the robust teardowns to secure the BFCache state
    hideTooltip();
    hidePill(true);
  }, { capture: true });

  function _onPageScroll() {
    if (tooltip.style.display === "none") return;
    const scrollPos = getScrollOffset();
    positionTooltip(
      _anchorPageX - scrollPos.x,
      _anchorPageY - scrollPos.y,
      false 
    );
  }

  window.addEventListener("scroll", _onPageScroll, { passive: true });

  if (cachedPdfContainer) {
    cachedPdfContainer.addEventListener("scroll", _onPageScroll, { passive: true });
  }

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "c") {
      hidePill(true);
    }
  }, { capture: true });

  document.addEventListener("contextmenu", () => hidePill(true), { capture: true });

  document.addEventListener("keyup", (e) => {
    if (e.key === "Escape") {
      hideTooltip();
      hidePill(true);
    }
  }, { capture: true });

   chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // Guard: Prevent unhandled exceptions if context dies mid-session
    if (!isRuntimeValid()) return;

    if (request.action === "hotkey_triggered") {
      if (tooltip.style.display !== "none") {
        hideTooltip();
        hidePill(true);
        return;
      }

      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;

      const text = getCleanSelection();
      if (!text || !isValidLookup(text)) return;

      const rect = sel.getRangeAt(0).getBoundingClientRect();
      const { width: vpW, height: vpH } = getViewport();
      const isZeroRect = rect.width === 0 && rect.height === 0 && rect.top === 0 && rect.left === 0;
      
      const anchorX = isZeroRect ? vpW / 2 : rect.right;
      const anchorY = isZeroRect ? vpH / 3 : rect.bottom;
      
      showTooltip(anchorX, anchorY, text);
      debouncedLookup(text);
    }
  });

  function debouncedLookup(text) {
    clearTimeout(lookupDebounceTimer);
    lookupDebounceTimer = setTimeout(() => {
      lookupDebounceTimer = null;
      lookupWord(text);
    }, 300);
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
      
      // Use WAAPI-compliant pausing
      pauseAutoClose();

      const audio = new Audio(audioUrl);
      currentAudio = audio;

      audio._safetyTimer = setTimeout(() => {
        audio._safetyTimer = null;
        if (currentAudio === audio) {
          stopAudio();
          resumeAutoClose();
        }
      }, AUDIO_SAFETY_MS);

      const onEnd = () => {
        clearTimeout(audio._safetyTimer);
        audio._safetyTimer = null;
        if (currentAudio === audio) {
          stopAudio();
          resumeAutoClose();
        }
      };

      audio.addEventListener("ended",  onEnd, { once: true });
      audio.addEventListener("error",  onEnd, { once: true });

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

  let _lookupSeq = 0;

async function lookupWord(text) {
    const mySeq = ++_lookupSeq;

    if (currentAbortController) {
      currentAbortController.abort();
      currentAbortController = null;
    }

    _configuredApiWarnings = [];

    const baseKey  = normaliseLookupKey(text);
    const isPhrase = text.includes(" ");

    let keys;
    try {
      keys = await getStoredKeys();
    } catch (err) {
      keys = {
        mwCollegiateKey: "", mwThesaurusKey: "",
        s4Uid: "", s4Token: "", priority: "auto",
        mwCount: 0, mwThesaurusCount: 0, s4Count: 0,
        mwLimit: MW_DEFAULT_LIMIT, s4Limit: S4_DEFAULT_LIMIT,
      };
    }

    if (mySeq !== _lookupSeq) return;

    const {
      mwCollegiateKey, mwThesaurusKey,
      s4Uid, s4Token, priority,
      mwCount, mwThesaurusCount, s4Count, mwLimit, s4Limit,
    } = keys;

    const effectivePriority = (priority === "free_first") ? "auto" : priority;
    const mwTotalCount = mwCount + mwThesaurusCount;

    const s4OverLimit = s4Count >= s4Limit;
    const mwOverLimit = mwTotalCount >= mwLimit;
    
    if (s4OverLimit) {
      const msg = `STANDS4: daily limit reached (${s4Count}/${s4Limit}) — skipping`;
      _configuredApiWarnings.push(msg);
      writeLog("warn", msg);
    }
    if (mwOverLimit) {
      const msg = `Merriam-Webster: daily limit reached (${mwTotalCount}/${mwLimit}) — skipping`;
      _configuredApiWarnings.push(msg);
      writeLog("warn", msg);
    }

    const hasS4               = !!(s4Uid && s4Token) && !s4OverLimit;
    const hasMWCollegiate     = !!mwCollegiateKey && !mwOverLimit;
    const hasMWThesaurus      = !!mwThesaurusKey  && !mwOverLimit;

    const isEnhanced = effectivePriority === "premium_first";

    writeLog("info",
      `Lookup: "${text}" | priority=${effectivePriority} | isEnhanced=${isEnhanced}` +
      ` | isPhrase=${isPhrase}` +
      ` | hasS4=${hasS4} | hasMWCollegiate=${hasMWCollegiate} | hasMWThesaurus=${hasMWThesaurus}`
    );

    const effectiveCacheKey = `${effectivePriority}:${baseKey}`;

    if (lookupCache.has(effectiveCacheKey)) {
      const cached = lookupCache.get(effectiveCacheKey);
      lookupCache.delete(effectiveCacheKey);
      lookupCache.set(effectiveCacheKey, cached);
      elPhonetic.textContent = cached.phonetic || "";
      safeSetHTML(elBody, cached.html);
      elSource.textContent = cached.source;
      if (cached.audioUrl) appendAudioButton(cached.audioUrl);
      if (cached.mwApi) {
        _updateMwSwitchButton(cached.mwApi, baseKey, text, hasMWCollegiate, hasMWThesaurus);
      }
      positionTooltip(currentClientX, currentClientY, true);

      // Start timer on immediate cache resolution
      if (mySeq === _lookupSeq && AUTO_CLOSE_MS > 0 && tooltip.style.display !== "none") {
        tooltip.classList.add("dict-counting");
        startAutoClose();
      }
      return;
    }

    currentAbortController = new AbortController();
    const { signal } = currentAbortController;

    try {
      const _freeDict = { label: "Free Dictionary", fn: () => fetchFreeDictionary(text, signal, effectiveCacheKey) };
      const _wikt     = { label: "Wiktionary",      fn: () => fetchWiktionary(text, signal, effectiveCacheKey) };
      const _mwCol    = { label: "MW Collegiate",   fn: () => fetchMwApi("collegiate", text, signal, mwCollegiateKey, baseKey, effectiveCacheKey, hasMWCollegiate, hasMWThesaurus) };
      const _mwThes   = { label: "MW Thesaurus",    fn: () => fetchMwApi("thesaurus", text, signal, mwThesaurusKey, baseKey, effectiveCacheKey, hasMWCollegiate, hasMWThesaurus) };
      const _s4Vocab  = { label: "STANDS4 Vocabulary", fn: () => fetchSTANDS4Vocab(text, signal, s4Uid, s4Token, effectiveCacheKey) };
      const _s4Idioms = { label: "STANDS4 Idioms",     fn: () => fetchSTANDS4Idioms(text, signal, s4Uid, s4Token, effectiveCacheKey) };

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

      writeLog("info", `Sequence: ${sequence.map((s) => s.label).join(" \u2192 ")}`);
      const found = await _runLookupSequence(sequence, signal, text);

      if (!found && !signal.aborted) {
        if (tooltip.style.display !== "none") {
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
          positionTooltip(currentClientX, currentClientY, true);
        }
        writeLog("error", `No definition found for "${text}"${_configuredApiWarnings.length > 0 ? " | " + _configuredApiWarnings.join(" • ") : ""}`);
      }
    } catch (err) {
      if (err.name === "AbortError" || signal.aborted) return;
      writeLog("error", `Network error during lookup for "${text}": ${err.message ?? err}`);
      if (tooltip.style.display !== "none") {
        safeSetHTML(
          elBody,
          `<p class="dict-error">\u26A0\uFE0F Network error \u2014 check your connection and try again.</p>`
        );
      }
    } finally {
      // Start timer when all network/DOM operations are fully resolved
      if (mySeq === _lookupSeq && !signal.aborted) {
        if (AUTO_CLOSE_MS > 0 && tooltip.style.display !== "none") {
          tooltip.classList.add("dict-counting");
          startAutoClose();
        }
      }
      
      if (currentAbortController && currentAbortController.signal === signal) {
        currentAbortController = null;
      }
    }
  }

  async function _runLookupSequence(steps, signal, word) {
    for (const { label, fn } of steps) {
      if (signal.aborted) return false;
      writeLog("info", `"${word}" — trying ${label}`);
      const ok = await fn();
      if (ok) {
        writeLog("info", `"${word}" — resolved via ${label}`);
        return true;
      }
      if (!signal.aborted) writeLog("info", `"${word}" — ${label}: no result`);
    }
    return false;
  }

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
        const onAbort = () => {
          clearTimeout(t);
          reject(new DOMException("Aborted", "AbortError"));
        };
        const t = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, delay);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
      delay *= 2;
    }
    return null; 
  }

  async function fetchFreeDictionary(text, signal, effectiveCacheKey) {
    const snapX = currentClientX;
    const snapY = currentClientY;

    try {
      const response = await fetchWithBackoff(
        `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(text)}`,
        { signal }
      );
      if (!response || signal.aborted) return false;
      if (!response.ok) return false;

      const data = await response.json();
      if (signal.aborted) return false;

      if (!Array.isArray(data) || data.length === 0) return false;

      const entry = data[0];
      if (!entry || !Array.isArray(entry.meanings) || entry.meanings.length === 0) return false;

      let phonetic = "";
      if (typeof entry.phonetic === "string" && entry.phonetic) {
        phonetic = entry.phonetic;
      } else if (Array.isArray(entry.phonetics)) {
        const ph = entry.phonetics.find((p) => p && typeof p.text === "string" && p.text);
        if (ph) phonetic = ph.text;
      }

      let html = "";
      let defsAdded = 0;
      entry.meanings.forEach((meaning) => {
        if (!meaning || !Array.isArray(meaning.definitions)) return;
        const pos = typeof meaning.partOfSpeech === "string" ? meaning.partOfSpeech : "";
        let meaningHtml = "";
        if (pos) meaningHtml += `<span class="dict-pos">${escapeHtml(pos)}</span>`;
        let defNum = 0;
        meaning.definitions.slice(0, 3).forEach((def) => {
          if (!def || typeof def.definition !== "string" || !def.definition) return;
          defNum++;
          defsAdded++;
          meaningHtml += `<p class="dict-def">${defNum}. ${escapeHtml(def.definition)}</p>`;
          if (typeof def.example === "string" && def.example) {
            meaningHtml += `<p class="dict-example">\u201c${escapeHtml(def.example)}\u201d</p>`;
          }
        });
        if (defNum === 0) return; 
        if (Array.isArray(meaning.synonyms) && meaning.synonyms.length > 0) {
          const syns = meaning.synonyms
            .filter((s) => typeof s === "string" && s)
            .slice(0, 5)
            .map(escapeHtml)
            .join(", ");
          if (syns) meaningHtml += `<p class="dict-synonyms"><strong>Synonyms:</strong> ${syns}</p>`;
        }
        if (Array.isArray(meaning.antonyms) && meaning.antonyms.length > 0) {
          const ants = meaning.antonyms
            .filter((a) => typeof a === "string" && a)
            .slice(0, 5)
            .map(escapeHtml)
            .join(", ");
          if (ants) meaningHtml += `<p class="dict-antonyms"><strong>Antonyms:</strong> ${ants}</p>`;
        }
        html += `<div class="dict-meaning">${meaningHtml}</div>`;
      });

      if (!html || defsAdded === 0) return false;

      let audioUrl = null;
      if (Array.isArray(entry.phonetics)) {
        const audioEntry = entry.phonetics.find(
          (p) => p && typeof p.audio === "string" && p.audio
        );
        if (audioEntry) audioUrl = audioEntry.audio;
      }
      if (!isSafeHttpsUrl(audioUrl)) audioUrl = null;

      elPhonetic.textContent = phonetic;
      safeSetHTML(elBody, html);
      elSource.textContent = "Source: Free Dictionary API";
      if (audioUrl) appendAudioButton(audioUrl);

      cacheSet(effectiveCacheKey, {
        html, phonetic, audioUrl, source: "Source: Free Dictionary API",
      });

      if (currentClientX === snapX && currentClientY === snapY) {
        positionTooltip(snapX, snapY, true);
      }

      return true;
    } catch (err) {
      if (err.name === "AbortError") throw err;
      writeLog("warn", `Free Dictionary API: request failed — ${err.message ?? err}`);
      return false;
    }
  }

  async function fetchWiktionary(text, signal, effectiveCacheKey) {
    const snapX = currentClientX;
    const snapY = currentClientY;
    const term = text.replace(/ +/g, "_");

    try {
      const response = await fetchWithBackoff(
        `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(term)}`,
        { signal }
      );
      if (!response || signal.aborted) return false;
      if (!response.ok) return false;

      const data = await response.json();
      if (signal.aborted) return false;

      if (!data || !Array.isArray(data.en) || data.en.length === 0) return false;

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
          defNum++;
          defsAdded++;
          entryHtml += `<p class="dict-def">${defNum}. ${escapeHtml(cleanDef)}</p>`;
          if (Array.isArray(def.examples) && def.examples.length > 0) {
            const cleanExample = typeof def.examples[0] === "string"
              ? stripHtml(def.examples[0])
              : "";
            if (cleanExample) {
              entryHtml += `<p class="dict-example">\u201c${escapeHtml(cleanExample)}\u201d</p>`;
            }
          }
        });
        if (defNum === 0) return; 
        html += `<div class="dict-meaning"><span class="dict-pos">${escapeHtml(pos)}</span>${entryHtml}</div>`;
      });

      if (!html || defsAdded === 0) return false;

      elPhonetic.textContent = "";
      safeSetHTML(elBody, html);
      elSource.textContent = "Source: Wiktionary";

      cacheSet(effectiveCacheKey, {
        html, phonetic: "", audioUrl: null, source: "Source: Wiktionary",
      });

      if (currentClientX === snapX && currentClientY === snapY) {
        positionTooltip(snapX, snapY, true);
      }

      return true;
    } catch (err) {
      if (err.name === "AbortError") throw err;
      writeLog("warn", `Wiktionary API: request failed — ${err.message ?? err}`);
      return false;
    }
  }

  async function fetchSTANDS4Vocab(text, signal, uid, token, effectiveCacheKey) {
    const snapX = currentClientX;
    const snapY = currentClientY;

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
      if (signal.aborted) return false;

      let results = data?.result;
      if (!results) return false;
      if (!Array.isArray(results)) results = [results];

      const validResult = results.find((r) => r && typeof r.definition === "string" && r.definition.trim());
      if (!validResult) return false;

      const definition = validResult.definition.trim();
      const pos      = typeof validResult["part-of-speech"] === "string" ? validResult["part-of-speech"].trim() : "";
      const example  = typeof validResult.example           === "string" ? validResult.example.trim()           : "";
      const phonetic = typeof validResult.pronunciation     === "string" ? validResult.pronunciation.trim()     : "";

      let html = `<div class="dict-meaning">`;
      if (pos) html += `<span class="dict-pos">${escapeHtml(pos)}</span>`;
      html += `<p class="dict-def">1. ${escapeHtml(definition)}</p>`;
      if (example) {
        html += `<p class="dict-example">\u201c${escapeHtml(example)}\u201d</p>`;
      }
      html += `</div>`;

      elPhonetic.textContent = phonetic;
      safeSetHTML(elBody, html);
      elSource.textContent = "Source: STANDS4";
      incrementApiCounter("s4");

      cacheSet(effectiveCacheKey, {
        html, phonetic, audioUrl: null, source: "Source: STANDS4",
      });

      if (currentClientX === snapX && currentClientY === snapY) {
        positionTooltip(snapX, snapY, true);
      }

      return true;
    } catch (err) {
      if (err.name === "AbortError") throw err;
      writeLog("error", `STANDS4 Vocab: request failed — ${err.message ?? err}`);
      return false;
    }
  }

  async function fetchSTANDS4Idioms(text, signal, uid, token, effectiveCacheKey) {
    const snapX = currentClientX;
    const snapY = currentClientY;

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
      if (signal.aborted) return false;

      let results = data?.result;
      if (!results) return false;
      if (!Array.isArray(results)) results = [results];
      if (results.length === 0) return false;

      const valid = results.filter(
        (r) => r && typeof r.definition === "string" && r.definition.trim()
      );
      if (valid.length === 0) return false;

      let html = "";
      valid.slice(0, 3).forEach((r, i) => {
        const def     = r.definition.trim();
        const example = typeof r.example === "string" ? r.example.trim() : "";
        html += `<div class="dict-meaning">`;
        html += `<span class="dict-pos">idiom / phrase</span>`;
        html += `<p class="dict-def">${i + 1}. ${escapeHtml(def)}</p>`;
        if (example) {
          html += `<p class="dict-example">\u201c${escapeHtml(example)}\u201d</p>`;
        }
        html += `</div>`;
      });

      elPhonetic.textContent = "";
      safeSetHTML(elBody, html);
      elSource.textContent = "Source: STANDS4 Phrases";
      incrementApiCounter("s4");

      cacheSet(effectiveCacheKey, {
        html, phonetic: "", audioUrl: null, source: "Source: STANDS4 Phrases",
      });

      if (currentClientX === snapX && currentClientY === snapY) {
        positionTooltip(snapX, snapY, true);
      }

      return true;
    } catch (err) {
      if (err.name === "AbortError") throw err;
      writeLog("error", `STANDS4 Idioms: request failed — ${err.message ?? err}`);
      return false;
    }
  }

  function _updateMwSwitchButton(activeApi, baseKey, originalText, hasMWCollegiate, hasMWThesaurus) {
    if (!activeApi || !(hasMWCollegiate && hasMWThesaurus)) {
      mwSwitchBtn.style.display = "none";
      _mwState = { activeApi: null, word: null, text: null };
      return;
    }
    const targetLabel = activeApi === "collegiate" ? "\u21C4 Thesaurus" : "\u21C4 Collegiate";
    mwSwitchBtn.textContent = targetLabel;
    mwSwitchBtn.setAttribute(
      "aria-label",
      activeApi === "collegiate"
        ? "Switch to Merriam-Webster Thesaurus"
        : "Switch to Merriam-Webster Collegiate"
    );
    mwSwitchBtn.style.display = "inline-flex";
    _mwState = { activeApi, word: baseKey, text: originalText };
  }

mwSwitchBtn.addEventListener("click", () => {
    const { activeApi, word, text: originalText } = _mwState;
    if (!activeApi || !word || !originalText) return;

    _configuredApiWarnings = [];

    // Freeze animation while switching APIs
    if (_autoCloseAnimation) {
      _autoCloseAnimation.cancel();
      _autoCloseAnimation = null;
    }
    tooltip.classList.remove("dict-counting");

    const targetApi = activeApi === "collegiate" ? "thesaurus" : "collegiate";
    const altCacheKey = `mwalt:${targetApi}:${word}`;

    const _currentSourceLabel = activeApi === "collegiate"
      ? "Source: Merriam-Webster Collegiate Dictionary"
      : "Source: Merriam-Webster Thesaurus Dictionary";

    if (mwAltCache.has(altCacheKey)) {
      const cached = mwAltCache.get(altCacheKey);
      mwAltCache.delete(altCacheKey);
      mwAltCache.set(altCacheKey, cached);
      elPhonetic.textContent = cached.phonetic || "";
      safeSetHTML(elBody, cached.html);
      elSource.textContent = cached.source;
      if (cached.audioUrl) appendAudioButton(cached.audioUrl);
      _mwState = { activeApi: targetApi, word, text: originalText };
      const newTargetLabel = targetApi === "collegiate" ? "\u21C4 Thesaurus" : "\u21C4 Collegiate";
      mwSwitchBtn.textContent = newTargetLabel;
      mwSwitchBtn.setAttribute(
        "aria-label",
        targetApi === "collegiate"
          ? "Switch to Merriam-Webster Thesaurus"
          : "Switch to Merriam-Webster Collegiate"
      );
      
      // Resume timer on cache hit
      if (AUTO_CLOSE_MS > 0 && tooltip.style.display !== "none") {
        tooltip.classList.add("dict-counting");
        startAutoClose();
      }
      return;
    }

    if (currentAbortController) {
      currentAbortController.abort();
      currentAbortController = null;
    }

    // ─── Capture the Generational Ticket ───
    const snapSeq = _lookupSeq;

    elSource.textContent = "\u231B Switching\u2026";
    mwSwitchBtn.disabled = true;

    _switchSafetyTimer = setTimeout(() => {
      mwSwitchBtn.disabled = false;
      elSource.textContent = _currentSourceLabel;
    }, STORAGE_TIMEOUT_MS);

    currentAbortController = new AbortController();
    const { signal } = currentAbortController;

    if (!isRuntimeValid()) {
      clearTimeout(_switchSafetyTimer);
      mwSwitchBtn.disabled = false;
      elSource.textContent = _currentSourceLabel;
      currentAbortController = null;
      return;
    }

    try {
      chrome.storage.local.get(
          [KEY_MW_KEY, KEY_MW_COLLEGIATE_KEY, KEY_MW_THESAURUS_KEY,
           KEY_S4_UID, KEY_S4_TOKEN, KEY_LOOKUP_PRIORITY,
           KEY_API_USAGE, KEY_API_MW_LIMIT, KEY_API_S4_LIMIT],
          (result) => {
            // 1. Immediately clear the storage IPC safety timer
            clearTimeout(_switchSafetyTimer);

            // ─── Validate ticket before processing storage ───
            if (snapSeq !== _lookupSeq) return;

            if (chrome.runtime.lastError || signal.aborted) {
              const errMsg = chrome.runtime.lastError ? chrome.runtime.lastError.message : "";
              if (errMsg.includes("context invalidated")) return; 
              mwSwitchBtn.disabled = false;
              if (!signal.aborted) elSource.textContent = _currentSourceLabel;
              return;
            }

        const legacyKey       = typeof result[KEY_MW_KEY]              === "string" ? result[KEY_MW_KEY].trim()              : "";
        const rawCollegiate   = typeof result[KEY_MW_COLLEGIATE_KEY]   === "string" ? result[KEY_MW_COLLEGIATE_KEY].trim()   : "";
        const rawThesaurus    = typeof result[KEY_MW_THESAURUS_KEY]    === "string" ? result[KEY_MW_THESAURUS_KEY].trim()    : "";
        const collegiateKey   = rawCollegiate || legacyKey;
        const thesaurusKey    = rawThesaurus;

        const apiKey = targetApi === "collegiate" ? collegiateKey : thesaurusKey;
        if (!apiKey) {
          mwSwitchBtn.disabled = false;
          elSource.textContent = `${_currentSourceLabel} (${targetApi === "collegiate" ? "Collegiate" : "Thesaurus"}: API key not configured — verify credentials in Settings)`;
          return;
        }

        const hasMWCollegiate_live = !!collegiateKey;
        const hasMWThesaurus_live  = !!thesaurusKey;

        const fetchFn = (type) => fetchMwApi(
          type, originalText, signal, apiKey, word, null,
          hasMWCollegiate_live, hasMWThesaurus_live
        );
        
        fetchFn(targetApi)
          .then((found) => {
            // ─── Validate ticket before DOM mutation ───
            if (snapSeq !== _lookupSeq) return;

            if (currentAbortController?.signal === signal) currentAbortController = null;
            mwSwitchBtn.disabled = false;
            if (signal.aborted) return;
            if (!found) {
              const targetLabel = targetApi === "collegiate" ? "Collegiate" : "Thesaurus";
              elSource.textContent = `${_currentSourceLabel} (${targetLabel}: no result)`;
            }
            // Resume timer after API resolves
            if (AUTO_CLOSE_MS > 0 && tooltip.style.display !== "none") {
              tooltip.classList.add("dict-counting");
              startAutoClose();
            }
          })
          .catch((err) => {
            // ─── Validate ticket before DOM mutation ───
            if (snapSeq !== _lookupSeq) return;

            if (currentAbortController?.signal === signal) currentAbortController = null;
            mwSwitchBtn.disabled = false;
            if (signal.aborted) return;
            
            // Resume timer even if API errors out
            if (AUTO_CLOSE_MS > 0 && tooltip.style.display !== "none") {
              tooltip.classList.add("dict-counting");
              startAutoClose();
            }
          });
      });
    } catch (err) {
      clearTimeout(_switchSafetyTimer);
      mwSwitchBtn.disabled = false;
      elSource.textContent = _currentSourceLabel;
      if (currentAbortController?.signal === signal) currentAbortController = null;
    }
  });

  function _parseMwResponse(data) {
    if (!Array.isArray(data) || data.length === 0) return null;
    if (typeof data[0] === "string") return null; 

    const entries = data.filter(
      (e) => e && Array.isArray(e.shortdef) && e.shortdef.length > 0
    );
    if (entries.length === 0) return null;

    let phonetic = "";
    const firstPrs = Array.isArray(entries[0]?.hwi?.prs) ? entries[0].hwi.prs : [];
    if (firstPrs.length > 0 && typeof firstPrs[0].mw === "string") {
      phonetic = firstPrs[0].mw;
    }

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
      let entryHtml = "";
      let entryDefNum = 0;
      if (fl) entryHtml += `<span class="dict-pos">${escapeHtml(fl)}</span>`;
      entry.shortdef.slice(0, 3).forEach((def) => {
        if (typeof def !== "string" || !def) return;
        entryDefNum++;
        defsAdded++;
        entryHtml += `<p class="dict-def">${entryDefNum}. ${escapeHtml(def)}</p>`;
      });
      if (entryDefNum > 0) {
        html += `<div class="dict-meaning">${entryHtml}</div>`;
      }
    });

    if (!html || defsAdded === 0) return null;
    return { html, phonetic, audioUrl };
  }

  async function fetchMwApi(
    type, text, signal, apiKey, baseKey, effectiveCacheKey,
    hasMWCollegiate = true, hasMWThesaurus = true
  ) {
    const snapX = currentClientX;
    const snapY = currentClientY;

    const isCollegiate = type === "collegiate";
    const endpointSeg  = isCollegiate ? "collegiate" : "thesaurus";
    const sourceLabel  = isCollegiate
      ? "Source: Merriam-Webster Collegiate Dictionary"
      : "Source: Merriam-Webster Thesaurus Dictionary";
    const counterKey   = isCollegiate ? "mw" : "mw_thesaurus";
    const apiLabel     = isCollegiate ? "Merriam-Webster Collegiate" : "Merriam-Webster Thesaurus";
    const keyLabel     = isCollegiate ? "Collegiate" : "Thesaurus";

    try {
      const response = await fetchWithBackoff(
        `https://www.dictionaryapi.com/api/v3/references/${endpointSeg}/json/${encodeURIComponent(text)}?key=${encodeURIComponent(apiKey)}`,
        { signal }
      );
      if (!response || signal.aborted) return false;
      if (!response.ok) {
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

      const { html, phonetic, audioUrl } = parsed;

      elPhonetic.textContent = phonetic;
      safeSetHTML(elBody, html);
      elSource.textContent = sourceLabel;
      incrementApiCounter(counterKey);
      if (audioUrl) appendAudioButton(audioUrl);

      const cacheEntry = { html, phonetic, audioUrl, source: sourceLabel, mwApi: type };

      if (effectiveCacheKey) {
        cacheSet(effectiveCacheKey, cacheEntry);
        mwAltCacheSet(`mwalt:${type}:${baseKey}`, cacheEntry);
      } else {
        mwAltCacheSet(`mwalt:${type}:${baseKey}`, cacheEntry);
      }

      _updateMwSwitchButton(type, baseKey, text, hasMWCollegiate, hasMWThesaurus);

      if (effectiveCacheKey && currentClientX === snapX && currentClientY === snapY) {
        positionTooltip(snapX, snapY, true);
      }

      return true;
    } catch (err) {
      if (err.name === "AbortError") throw err;
      writeLog("error", `${apiLabel}: request failed — ${err.message ?? err}`);
      return false;
    }
  }
})();