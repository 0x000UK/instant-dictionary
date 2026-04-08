(function () {
  "use strict";

  // ─── Guard: do not inject into pages without a body (XML viewers, etc.) ───
  if (!document.body) return;

  // ─── Guard: do not inject twice ───────────────────────────────────────────
  // SPAs and certain page frameworks can trigger document_idle more than once.
  // A second injection would attach a duplicate shadow host and duplicate all
  // event listeners — bail out immediately if our host already exists.
  if (document.getElementById("dict-extension-host")) return;

  // ─── Extension context guard ──────────────────────────────────────────────
  // After a Firefox extension update/reload, content scripts that are already
  // injected into open tabs lose their runtime context.  Any subsequent call
  // to chrome.* throws "Extension context invalidated".  We check once at
  // injection time and again before every storage access.
  function isRuntimeValid() {
    try {
      return !!(typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  if (!isRuntimeValid()) return;

  // ─── Shared constants ─────────────────────────────────────────────────────
  // Destructured from window.SharedConstants (defined in shared_constants.js,
  // loaded first in the content_scripts array in manifest.json).  These values
  // are the single source of truth shared with popup.js — no manual sync needed.
  const { MW_DEFAULT_LIMIT, S4_DEFAULT_LIMIT, STORAGE_TIMEOUT_MS } = window.SharedConstants;

  // ─── Configuration ────────────────────────────────────────────────────────
  const AUTO_CLOSE_MS  = 6000; // Auto-close delay in ms. Set to 0 to disable.
  const CACHE_MAX_SIZE = 200;  // Maximum number of entries kept in session cache.
  // TTL is intentionally omitted: dictionary definitions do not change between
  // API updates, so a definition cached at session start remains valid for the
  // entire session.  A session-scoped Map is cleared automatically when the tab
  // is closed.  If future requirements need TTL, add an expiry field to the
  // cached object and check it in lookupWord before treating the entry as live.

  // ─── Positioning constants ────────────────────────────────────────────────
  // Defined once at module scope so positionTooltip() and showPill() do not
  // re-allocate the same literals on every call.
  const TOOLTIP_MARGIN      = 10; // px gap between tooltip and cursor / viewport edge
  const PILL_MARGIN         = 8;  // px gap between pill and cursor / viewport edge
  const PILL_ESTIMATED_W    = 80; // estimated pill width before first render
  const PILL_ESTIMATED_H    = 32; // estimated pill height before first render

  // ─── Storage key constants ────────────────────────────────────────────────
  // Single source of truth for every chrome.storage key name used in this
  // script.  Mirrors the KEY_* constants in popup.js so a name change only
  // ever requires one edit per file, with no risk of a silent cross-file drift.
  const KEY_MW_KEY              = "mw_key";            // legacy — migration read only
  const KEY_MW_COLLEGIATE_KEY   = "mw_collegiate_key"; // Merriam-Webster Collegiate Dictionary
  const KEY_MW_THESAURUS_KEY    = "mw_thesaurus_key";  // Merriam-Webster Thesaurus Dictionary
  const KEY_S4_UID          = "s4_uid";
  const KEY_S4_TOKEN        = "s4_token";
  const KEY_LOOKUP_PRIORITY = "lookup_priority";
  const KEY_API_USAGE       = "api_usage";
  const KEY_API_MW_LIMIT    = "api_mw_limit";
  const KEY_API_S4_LIMIT    = "api_s4_limit";
  // Activity log — shared with popup.js which reads and renders these entries.
  const KEY_EXT_LOGS        = "ext_logs";
  const MAX_LOG_ENTRIES     = 200;

  // ─── Per-session lookup cache ─────────────────────────────────────────────
  // Keyed by normalised (NFC, lowercase, collapsed-space) text.
  // Avoids redundant network round-trips when the user looks up the same word
  // more than once in a session.
  // Capped at CACHE_MAX_SIZE: when full, the oldest (insertion-order) entry is
  // evicted so a long session cannot grow the cache without bound.
  const lookupCache = new Map();

  // ─── Shared state ─────────────────────────────────────────────────────────
  let currentAbortController = null;
  let mouseUpTimer            = null;
  let lookupDebounceTimer     = null;
  let autoCloseTimer          = null;
  // Coordinates at the time showTooltip() was last called.  Used by async
  // fetch handlers to detect whether a newer tooltip has replaced this one.
  let currentClientX = 0;
  let currentClientY = 0;
  // Page-absolute (document-coordinate) anchor captured at showTooltip() time
  // by adding the spawn-time viewport coordinates to window.scrollX / scrollY.
  // Read by _onPageScroll() to recompute the tooltip's fixed position as the
  // document scrolls, keeping the tooltip visually pinned to the spawn word.
  // Reset to 0 in hideTooltip() so stale values never bleed into a new session.
  let _anchorPageX = 0;
  let _anchorPageY = 0;
  // Currently playing Audio instance.
  let currentAudio = null;

  // ─── MW switch state ──────────────────────────────────────────────────────
  // Tracks which MW API produced the currently displayed result so the toggle
  // button label and behaviour are always consistent.
  //   activeApi: "collegiate" | "thesaurus" | null
  //   word:      the normalised lookup key that produced the cached result
  //
  // Both fields are reset to null whenever a new lookup begins (showTooltip)
  // or the tooltip is hidden, so stale state can never bleed into a new word.
  //   text: the original (pre-normalisation) user text, preserved so the switch
  //         button sends the correct casing to the MW endpoint rather than the
  //         lowercased baseKey.
  let _mwState = { activeApi: null, word: null, text: null };

  // Per-session cache for the alternate MW API result so toggling back and
  // forth is instant after the first fetch in each direction.
  // Key:   "mwalt:<api>:<normalisedWord>"  where api = "collegiate" | "thesaurus"
  // Value: same shape as the main lookupCache entries
  //        { html, phonetic, audioUrl, source, mwApi }
  // Capped at CACHE_MAX_SIZE (same ceiling as lookupCache) so a long session
  // with many toggled words cannot accumulate unbounded entries.
  const mwAltCache = new Map();

  function mwAltCacheSet(key, value) {
    if (mwAltCache.size >= CACHE_MAX_SIZE) {
      mwAltCache.delete(mwAltCache.keys().next().value);
    }
    mwAltCache.set(key, value);
  }

  // ─── Pill state ───────────────────────────────────────────────────────────
  let pillText      = "";   // text captured at pill-show time
  let pillTimer     = null; // auto-hide after 2 s
  let pillHideTimer = null; // exit-animation window before display:none

  // ─── Configured-API warning accumulator ──────────────────────────────────
  // Collects quota/authentication warning strings during a single lookupWord()
  // call so they can be surfaced to the user (in the source line or error
  // message) even when a public-source fallback ultimately succeeds.  Reset to
  // [] at the start of every lookupWord() call.
  let _configuredApiWarnings = [];

  // ─── Drag-tracking state ──────────────────────────────────────────────────
  // Declared at module scope so the blur / pointercancel / visibilitychange
  // handlers can reset it alongside the mouseup handler.
  let isDragging = false;

  // ─── safeSetHTML constants (module-scope — not rebuilt on every call) ────────
  const _SANITIZE_UNSAFE_ATTR  = /^on/i;
  const _SANITIZE_URL_ATTRS    = new Set(["href", "src", "action", "formaction", "data"]);
  const _SANITIZE_SAFE_SCHEMES = /^(https?|mailto|tel):/i;
  // Elements that must be removed entirely (including their subtrees) because
  // they can execute code or load external resources regardless of attribute
  // sanitisation.  nodeName is uppercase for HTML elements in all browsers.
  const _SANITIZE_BLOCKED_ELEMENTS = new Set([
    "SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED",
    "LINK", "BASE", "META", "FORM", "INPUT",
    "TEXTAREA", "SELECT", "BUTTON", "TEMPLATE",
    "SVG", "MATH",
  ]);

  // ─── Module-scope DOM sanitiser walker (used by safeSetHTML) ─────────────
  // Defined here — after its dependency constants — so it is allocated once
  // per content-script lifetime rather than once per safeSetHTML() call.
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
    // Snapshot childNodes before iterating — live NodeList changes when a
    // blocked child is removed by the recursive call.
    Array.from(node.childNodes).forEach(_sanitiseNode);
  }

  // ─── Reduced-motion preference ────────────────────────────────────────────
  // Queried once at module scope so showTooltip() and the animationend handler
  // can cheaply check whether to set/clear willChange without calling
  // matchMedia() on every lookup.
  const _reducedMotionMql = window.matchMedia?.("(prefers-reduced-motion: reduce)");

  // ─── Shadow DOM ───────────────────────────────────────────────────────────
  //
  // The tooltip lives in a closed shadow root attached to a fixed-position
  // host element.  This provides true style isolation — host-page CSS cannot
  // bleed in, and our CSS cannot bleed out — without the ID-collision risk of
  // injecting directly into document.body.
  //
  // The host itself is zero-size and fixed at 0,0 so it takes no space and
  // does not affect page layout.
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
    pointerEvents: "none",  // re-enabled on #dict-tooltip in CSS
  });
  const shadowRoot = shadowHost.attachShadow({ mode: "closed" });
  document.body.appendChild(shadowHost);

  // Load the extension's stylesheet into the shadow root.
  const styleLink = document.createElement("link");
  styleLink.rel  = "stylesheet";
  styleLink.href = chrome.runtime.getURL("content.css");
  shadowRoot.appendChild(styleLink);

  // ─── Build tooltip DOM via createElement (no innerHTML) ──────────────────
  const tooltip = document.createElement("div");
  tooltip.id = "dict-tooltip";
  tooltip.setAttribute("role", "tooltip");
  tooltip.setAttribute("aria-live", "polite");
  // Set display:none inline immediately so the tooltip is hidden even before
  // the stylesheet finishes loading (prevents a brief flash of an unstyled
  // empty block on page load).
  tooltip.style.display = "none";

  // Header
  const header = document.createElement("div");
  header.id = "dict-tooltip-header";

  const wordSpan = document.createElement("span");
  wordSpan.id = "dict-tooltip-word";
  header.appendChild(wordSpan);

  const phoneticSpan = document.createElement("span");
  phoneticSpan.id = "dict-tooltip-phonetic";
  header.appendChild(phoneticSpan);

  // Right-side group: MW switch button (conditionally visible) + close button.
  // Wrapping both in a flex container keeps them visually paired and ensures
  // the close button never jumps when the switch button appears or disappears.
  const headerRight = document.createElement("div");
  headerRight.id = "dict-tooltip-header-right";

  const mwSwitchBtn = document.createElement("button");
  mwSwitchBtn.id = "dict-mw-switch-btn";
  mwSwitchBtn.setAttribute("type", "button");
  mwSwitchBtn.setAttribute("aria-label", "Switch Merriam-Webster dictionary");
  mwSwitchBtn.style.display = "none"; // hidden until MW source is confirmed + both keys exist
  headerRight.appendChild(mwSwitchBtn);

  const closeBtn = document.createElement("button");
  closeBtn.id = "dict-tooltip-close";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "\u00d7";
  headerRight.appendChild(closeBtn);

  header.appendChild(headerRight);

  // Scroll area — wraps body + source so only this region scrolls, keeping
  // the countdown bar always visible at the very bottom of the tooltip.
  const scrollArea = document.createElement("div");
  scrollArea.id = "dict-tooltip-scroll-area";

  const bodyDiv = document.createElement("div");
  bodyDiv.id = "dict-tooltip-body";

  const sourceDiv = document.createElement("div");
  sourceDiv.id = "dict-tooltip-source";

  scrollArea.appendChild(bodyDiv);
  scrollArea.appendChild(sourceDiv);

  // Real DOM countdown bar.
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
  pillIcon.src = chrome.runtime.getURL("icons/icon.png");
  pillIcon.alt = "";

  const pillLabel = document.createElement("span");
  pillLabel.textContent = "Define";

  pill.appendChild(pillIcon);
  pill.appendChild(pillLabel);
  shadowRoot.appendChild(pill);

  // Query within the tooltip element itself to avoid ID collisions with the
  // host page.
  const elWord     = tooltip.querySelector("#dict-tooltip-word");
  const elPhonetic = tooltip.querySelector("#dict-tooltip-phonetic");
  const elBody     = tooltip.querySelector("#dict-tooltip-body");
  const elSource   = tooltip.querySelector("#dict-tooltip-source");

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Escapes all characters that can break HTML attribute or text contexts.
   * The backtick (`) is included because it can act as a delimiter in certain
   * HTML attribute contexts (e.g. on=`` syntax in some engines).
   */
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#x27;")
      .replace(/`/g, "&#x60;");
  }

  /**
   * Safely sets the innerHTML of `el` from a trusted HTML string that has
   * already had all dynamic values run through escapeHtml().
   *
   * Strategy:
   *   1. Parse in a detached document (no live-DOM side-effects during parse).
   *   2. Walk every imported node and strip any element-level event-handler
   *      attributes (on*) before it enters the live DOM — this ensures that
   *      even a malformed API response cannot trigger JS execution.
   *   3. Validate href / src / action attributes against an allowlist of safe
   *      URL schemes so a rogue API cannot inject javascript: or data: URIs.
   *
   * This function must only ever receive HTML that was assembled entirely from
   * escapeHtml()-escaped API values.  Never call it with raw, unescaped data.
   */
  function safeSetHTML(el, html) {
    const doc = new DOMParser().parseFromString(html, "text/html");

    // Guard: DOMParser can return a document with a null body in pathological
    // environments (e.g. deeply nested sandbox iframes).  Fall back to a
    // safe text-content-only representation rather than throwing.
    if (!doc || !doc.body) {
      el.textContent = "";
      return;
    }

    el.textContent = "";
    Array.from(doc.body.childNodes).forEach((node) => {
      // Skip blocked elements at the top level before import — importNode on a
      // blocked element would clone it into the live document before we could
      // remove it, which is the exact scenario we are trying to prevent.
      if (node.nodeType === Node.ELEMENT_NODE && _SANITIZE_BLOCKED_ELEMENTS.has(node.nodeName)) return;
      const imported = document.importNode(node, true);
      _sanitiseNode(imported);
      el.appendChild(imported);
    });
  }

  /**
   * Strips HTML tags from a string via DOMParser, returning plain text.
   * Returns "" on any failure or if the input is falsy.
   */
  function stripHtml(html) {
    if (!html) return "";
    try {
      const doc = new DOMParser().parseFromString(html, "text/html");
      return (doc.body ? doc.body.textContent : "") || "";
    } catch {
      return "";
    }
  }

  /**
   * Validates that `url` is a safe https:// URL.
   * Used to guard audio URLs before creating an Audio() object.
   */
  function isSafeHttpsUrl(url) {
    if (typeof url !== "string" || !url) return false;
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:";
    } catch {
      return false;
    }
  }

  // ─── Normalise lookup key ──────────────────────────────────────────────────
  // NFC normalisation ensures composed and decomposed Unicode representations
  // of the same character (e.g. é as U+00E9 vs e + U+0301) share one cache
  // entry and produce identical API queries.
  function normaliseLookupKey(text) {
    return text.normalize("NFC").toLowerCase().replace(/ +/g, " ").trim();
  }

  // ─── Cache helper ─────────────────────────────────────────────────────────
  // Evicts the oldest entry when the cache exceeds CACHE_MAX_SIZE.
  function cacheSet(key, value) {
    if (lookupCache.size >= CACHE_MAX_SIZE) {
      // Map preserves insertion order; first key is oldest.
      lookupCache.delete(lookupCache.keys().next().value);
    }
    lookupCache.set(key, value);
  }

  // ─── Read stored API keys ──────────────────────────────────────────────────
  // Reads keys from extension storage on every lookup so changes made in the
  // settings popup take effect without a page reload.
  //
  // Four defensive layers:
  //   1. isRuntimeValid() — prevents calling chrome.* after an extension
  //      update/reload invalidates the content-script context.
  //   2. STORAGE_TIMEOUT_MS safety timer — if the storage callback never fires
  //      (context invalidated in the gap between the isRuntimeValid() guard and
  //      the actual storage call), the promise resolves with safe defaults
  //      instead of hanging forever and leaving the tooltip stuck at "Looking up…".
  //   3. chrome.runtime.lastError check — turns storage errors into graceful
  //      degradation (free-sources-only mode) rather than a silent failure.
  //   4. Outer try/catch — if chrome.storage.local.get throws synchronously
  //      (rare but possible in sandboxed environments), the promise resolves
  //      with the safe default rather than hanging forever.
  function getStoredKeys() {
    return new Promise((resolve) => {
      const defaults = {
        mwCollegiateKey: "", mwThesaurusKey: "",
        s4Uid: "", s4Token: "", priority: "auto",
        // Quota defaults — read fresh on every lookup so popup changes apply
        // without a page reload.  Safe defaults let the extension work even
        // when these keys have never been written (first install).
        mwCount: 0, mwThesaurusCount: 0, s4Count: 0, mwLimit: MW_DEFAULT_LIMIT, s4Limit: S4_DEFAULT_LIMIT,
      };

      if (!isRuntimeValid()) {
        resolve(defaults);
        return;
      }

      // Guard against the storage callback never arriving.
      let _resolved = false;
      const _timeoutId = setTimeout(() => {
        if (_resolved) return;
        _resolved = true;
        console.warn("[Instant Dictionary] getStoredKeys: storage timed out — using defaults");
        resolve(defaults);
      }, STORAGE_TIMEOUT_MS);

      try {
        chrome.storage.local.get(
          [KEY_MW_KEY, KEY_MW_COLLEGIATE_KEY, KEY_MW_THESAURUS_KEY,
           KEY_S4_UID, KEY_S4_TOKEN, KEY_LOOKUP_PRIORITY,
           KEY_API_USAGE, KEY_API_MW_LIMIT, KEY_API_S4_LIMIT],
          (result) => {
            clearTimeout(_timeoutId);
            if (_resolved) return; // timeout already fired
            _resolved = true;

            if (chrome.runtime.lastError) {
              console.warn(
                "[Instant Dictionary] Storage read error:",
                chrome.runtime.lastError.message
              );
              resolve(defaults);
              return;
            }
            const safe = (v) => (typeof v === "string" ? v.trim() : "");

            const today    = new Date().toISOString().slice(0, 10);
            const usageRaw = result[KEY_API_USAGE];
            const usage    = (usageRaw && typeof usageRaw === "object" && usageRaw.date === today)
              ? usageRaw
              : { date: today, mw_count: 0, mw_thesaurus_count: 0, s4_count: 0 };

            // ── Legacy migration (read-only in content script) ─────────────
            // If the old mw_key is set but the new collegiate key is not, use
            // the legacy value as the collegiate key.  The popup handles the
            // actual write migration; here we just transparently use it so
            // lookups continue to work before the popup is next opened.
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
        console.warn("[Instant Dictionary] Storage access failed:", err);
        resolve(defaults);
      }
    });
  }

  // ─── Serialised API call counter ──────────────────────────────────────────
  //
  // Increments the daily call counter for a given configured API after a
  // successful (non-error) response.  Fire-and-forget; failures are logged
  // but do not affect the lookup flow.
  // api: "mw" | "mw_thesaurus" | "s4"
  //   "mw"           → Merriam-Webster Collegiate (increments mw_count)
  //   "mw_thesaurus" → Merriam-Webster Thesaurus  (increments mw_thesaurus_count)
  //   "s4"           → STANDS4                    (increments s4_count)
  //
  // ── Race-condition prevention ───────────────────────────────────────────────
  // Two near-simultaneous successful API calls (e.g. an MW switch fetch
  // finishing alongside a new lookup) used to both read a stale count before
  // either write landed — one increment was silently dropped.
  //
  // Fix: the same single-flight queue pattern as the log writer.  All pending
  // api tokens are drained atomically into one read→increment→write cycle.
  // If more arrive while the set is in flight, a second cycle is scheduled
  // immediately after, preserving every increment with no inter-write gaps.
  let _counterFlushPending = false;
  const _counterQueue = [];

  function _flushCounterQueue() {
    // Same two-layer guard as _flushLogQueue: covers both the initial call
    // (from incrementApiCounter) and every recursive re-entry from within the
    // set callback, where the extension context may have been invalidated.
    if (!isRuntimeValid()) { _counterFlushPending = false; return; }
    if (_counterQueue.length === 0) { _counterFlushPending = false; return; }
    _counterFlushPending = true;
    const today = new Date().toISOString().slice(0, 10);
    try {
      chrome.storage.local.get([KEY_API_USAGE], (getResult) => {
        if (chrome.runtime.lastError) { _counterFlushPending = false; return; }
        // The extension context can be invalidated between the get callback
        // firing and the set call below.  The outer try/catch does not cover
        // this async callback, so we must guard explicitly.
        if (!isRuntimeValid()) { _counterFlushPending = false; return; }
        const existing = getResult[KEY_API_USAGE];
        const usage    = (existing && typeof existing === "object" && existing.date === today)
          ? {
              date:               today,
              mw_count:           typeof existing.mw_count           === "number" ? existing.mw_count           : 0,
              mw_thesaurus_count: typeof existing.mw_thesaurus_count === "number" ? existing.mw_thesaurus_count : 0,
              s4_count:           typeof existing.s4_count           === "number" ? existing.s4_count           : 0,
            }
          : { date: today, mw_count: 0, mw_thesaurus_count: 0, s4_count: 0 };

        // Drain every pending increment into a local batch first so that,
        // if the storage set fails, we can re-prepend the batch and retry —
        // rather than losing the increments silently.
        const _counterBatch = [];
        while (_counterQueue.length > 0) _counterBatch.push(_counterQueue.shift());

        _counterBatch.forEach((api) => {
          if (api === "mw")           usage.mw_count           += 1;
          if (api === "mw_thesaurus") usage.mw_thesaurus_count += 1;
          if (api === "s4")           usage.s4_count           += 1;
        });

        chrome.storage.local.set({ [KEY_API_USAGE]: usage }, () => {
          _counterFlushPending = false;
          if (chrome.runtime.lastError) {
            console.warn("[Instant Dictionary] Failed to update API counter:",
                         chrome.runtime.lastError.message);
            // Re-prepend the batch so these increments survive a retry.
            // Use a loop instead of spread (...) to avoid a call-stack overflow
            // if _counterBatch is unusually large.
            for (let i = _counterBatch.length - 1; i >= 0; i--) {
              _counterQueue.unshift(_counterBatch[i]);
            }
            return;
          }
          // Process any increments that arrived while the set was in flight.
          if (_counterQueue.length > 0) _flushCounterQueue();
        });
      });
    } catch (err) {
      console.warn("[Instant Dictionary] incrementApiCounter error:", err);
      _counterFlushPending = false;
    }
  }

  function incrementApiCounter(api) {
    if (api !== "mw" && api !== "mw_thesaurus" && api !== "s4") return;
    if (!isRuntimeValid()) return;
    _counterQueue.push(api);
    if (!_counterFlushPending) _flushCounterQueue();
  }

  // ─── Activity log writer ──────────────────────────────────────────────────
  //
  // Appends a structured entry to the shared ext_logs array in storage so the
  // popup's Logs tab can display it.  Fire-and-forget: failures are silently
  // swallowed because logging must never block or break a lookup.
  //
  // level: "info" | "warn" | "error"
  //   info  — normal events (lookup started, definition found)
  //   warn  — degraded but recoverable (daily limit reached, falling back)
  //   error — something failed that the user should be aware of
  //           (API key rejected, quota exceeded, no definition found)
  //
  // Entries are rendered in the popup with error rows highlighted red and
  // warn rows highlighted orange so problems are immediately visible.
  //
  // ── Race-condition prevention ───────────────────────────────────────────────
  // Without serialisation, concurrent lookupWord() paths call writeLog() several
  // times each across async suspension points.  Each call fired its own
  // independent chrome.storage.local.get → push → set round-trip.  When two
  // callbacks read the same stale baseline array before either write had landed,
  // the later write silently overwrote all entries contributed by the earlier
  // write — entries were dropped.
  //
  // Fix: a single pending get→set flight serialises all writes.  New entries that
  // arrive while a flight is in progress are held in _logEntryQueue and drained
  // atomically into the same write once the get callback fires.  If more entries
  // arrive during the set, a second flight is scheduled immediately after the set
  // completes, preserving every entry with no inter-write gaps.
  let _logFlushPending = false;
  const _logEntryQueue = [];

  function _flushLogQueue() {
    // Guard: the recursive call from inside the set callback fires after an
    // async gap during which the extension context can be invalidated.
    // Checking here covers both the initial call (from writeLog) and every
    // recursive re-entry so no chrome.* call is ever made on a dead context.
    if (!isRuntimeValid()) { _logFlushPending = false; return; }
    if (_logEntryQueue.length === 0) { _logFlushPending = false; return; }
    _logFlushPending = true;
    try {
      chrome.storage.local.get([KEY_EXT_LOGS], (getResult) => {
        if (chrome.runtime.lastError) { _logFlushPending = false; return; }
        // Same guard as _flushCounterQueue: the extension context can be
        // invalidated between the get callback firing and the set call below.
        if (!isRuntimeValid()) { _logFlushPending = false; return; }
        const existing = Array.isArray(getResult[KEY_EXT_LOGS]) ? getResult[KEY_EXT_LOGS] : [];
        // Drain every entry that was queued while we waited for this get into
        // a local batch so we can re-prepend on set failure rather than losing
        // entries silently.
        const _logBatch = [];
        while (_logEntryQueue.length > 0) _logBatch.push(_logEntryQueue.shift());
        const combined = [...existing, ..._logBatch];
        const trimmed = combined.length > MAX_LOG_ENTRIES
          ? combined.slice(combined.length - MAX_LOG_ENTRIES)
          : combined;
        chrome.storage.local.set({ [KEY_EXT_LOGS]: trimmed }, () => {
          _logFlushPending = false;
          if (chrome.runtime.lastError) {
            // Re-prepend so these entries survive a retry.
            // Use a loop instead of spread (...) to avoid a call-stack overflow
            // if _logBatch is unusually large.
            for (let i = _logBatch.length - 1; i >= 0; i--) {
              _logEntryQueue.unshift(_logBatch[i]);
            }
            return; // set failed; will retry on next writeLog() call
          }
          // Process any entries that arrived while the set was in flight.
          if (_logEntryQueue.length > 0) _flushLogQueue();
        });
      });
    } catch {
      // Never let logging errors surface; reset gate so future calls can retry.
      _logFlushPending = false;
    }
  }

  function writeLog(level, msg) {
    if (!isRuntimeValid()) return;
    _logEntryQueue.push({ ts: new Date().toISOString(), level, msg });
    if (!_logFlushPending) _flushLogQueue();
  }

  // ─── applyPageTheme constants (module-scope — not rebuilt on every call) ────
  const _THEME_CONTAINER_SELECTORS = [
    "main", "#app", "#root", "#__next", ".app", "[data-theme]",
  ];
  const _THEME_CLAMP = (v) => Math.min(255, Math.max(0, v));

  // ─── Page-aware theme ─────────────────────────────────────────────────────
  //
  // Walks a set of candidate elements (body, documentElement, and common
  // SPA container selectors) to find the first one with a non-transparent
  // background.  Called on every showTooltip() so theme changes in SPAs are
  // picked up automatically without a page reload.
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
      } catch { /* getComputedStyle can throw in cross-origin frames */ }
    }
    bgColor = bgColor || "rgb(255, 255, 255)";

    // Guard: only extract R/G/B channels from rgb()/rgba() strings.
    // Modern CSS colour functions (oklch(), color-mix(), display-p3, etc.)
    // return digit matches that are semantically unrelated to R, G, B channel
    // values — using them would produce a silently wrong theme.  Fall back to
    // the white default whenever the value is not an rgb/rgba string.
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

  // ─── Hide tooltip ──────────────────────────────────────────────────────────
  function hideTooltip() {
    tooltip.style.display = "none";
    tooltip.classList.remove("dict-counting");

    clearTimeout(autoCloseTimer);
    autoCloseTimer = null;

    clearTimeout(mouseUpTimer);
    mouseUpTimer = null;

    clearTimeout(lookupDebounceTimer);
    lookupDebounceTimer = null;

    if (currentAbortController) {
      currentAbortController.abort();
      currentAbortController = null;
    }

    // Reset MW switch state so it doesn't linger across tooltip sessions.
    _mwState = { activeApi: null, word: null, text: null };
    mwSwitchBtn.style.display = "none";

    // Clear the page-absolute anchor so stale coordinates cannot affect a
    // subsequent tooltip session.
    _anchorPageX = 0;
    _anchorPageY = 0;

    // Stop any in-flight audio so a dismissed tooltip doesn't keep playing
    // pronunciation audio in the background with no way to stop it.
    stopAudio();
  }

  // ─── Audio state helpers ──────────────────────────────────────────────────

  function stopAudio() {
    if (currentAudio) {
      currentAudio.pause();
      currentAudio.currentTime = 0;
      // Clear the safety timer that was attached to this audio instance by
      // appendAudioButton so it cannot fire after the tooltip is dismissed.
      if (currentAudio._safetyTimer != null) {
        clearTimeout(currentAudio._safetyTimer);
        currentAudio._safetyTimer = null;
      }
      currentAudio = null;
    }
  }

  // Re-engages the auto-close countdown if it was paused for audio playback.
  function resumeAutoClose() {
    if (AUTO_CLOSE_MS > 0 && tooltip.style.display !== "none") {
      tooltip.classList.add("dict-counting");
      startAutoClose();
    }
  }

  // ─── Viewport helper ──────────────────────────────────────────────────────
  // Returns { width, height } using visualViewport when available (handles
  // mobile zoom and iOS Safari's variable-height browser chrome) with
  // window.innerWidth/Height as the fallback.
  // Defined once at module scope; called by positionTooltip, showPill, and
  // the Shift-key trigger — all of which previously had identical inline copies.
  function getViewport() {
    const vv = window.visualViewport;
    return {
      width:  (vv ? vv.width  : window.innerWidth)  || window.innerWidth,
      height: (vv ? vv.height : window.innerHeight) || window.innerHeight,
    };
  }

  // ─── Auto-close ───────────────────────────────────────────────────────────
  //
  // Primary: driven by `animationend` on the countdown bar so the JS close is
  // tied precisely to the CSS animation completing.
  //
  // Backup setTimeout: guards against `animationend` silently not firing —
  // e.g. when the extension stylesheet hasn't fully loaded yet.  The generous
  // buffer ensures the CSS animation always wins under normal conditions.
  function startAutoClose() {
    if (AUTO_CLOSE_MS <= 0) return;
    clearTimeout(autoCloseTimer);
    autoCloseTimer = setTimeout(hideTooltip, AUTO_CLOSE_MS + 2000);
  }

  tooltip.addEventListener("animationend", (e) => {
    if (e.animationName === "dict-fade-in") {
      tooltip.style.willChange = "";
    }
    if (e.animationName === "dict-countdown" && AUTO_CLOSE_MS > 0) {
      clearTimeout(autoCloseTimer);
      autoCloseTimer = null;
      hideTooltip();
    }
  });

  // ─── Hover: pause / resume auto-close ────────────────────────────────────
  //
  // The CSS animation is already paused on :hover via `animation-play-state`.
  // We must also cancel the backup setTimeout on mouseenter so it cannot fire
  // while the user is actively reading, then restart it on mouseleave so the
  // countdown resumes from a fresh full-duration window.
  tooltip.addEventListener("mouseenter", () => {
    if (AUTO_CLOSE_MS <= 0) return;
    // Cancel the backup setTimeout — the CSS :hover rule pauses the animation
    // via animation-play-state:paused, so the bar stays visible at its current
    // position. The dict-counting class must NOT be removed here: removing it
    // would tear down the animation entirely, hiding the bar and forcing a
    // full restart from 100% when the cursor leaves.
    clearTimeout(autoCloseTimer);
    autoCloseTimer = null;
  });

  tooltip.addEventListener("mouseleave", () => {
    if (AUTO_CLOSE_MS <= 0) return;
    if (tooltip.style.display === "none") return;
    // The CSS :hover rule is now gone, so animation-play-state returns to
    // "running" and the bar continues shrinking from where it paused.
    // Restart the backup setTimeout as a safety net in case animationend
    // does not fire (e.g. stylesheet not yet fully loaded).
    startAutoClose();
  });

  // ─── Close button ──────────────────────────────────────────────────────────
  closeBtn.addEventListener("click", hideTooltip);

  // ─── Hide when clicking outside ───────────────────────────────────────────
  //
  // For a CLOSED shadow root, e.composedPath() called from an outside listener
  // does NOT expose internal elements — it only goes up to the shadow host
  // boundary.  Checking `shadowHost` (which IS in composedPath()) is correct.
  //
  // { capture: true } prevents site-level stopPropagation() from blocking us.
  document.addEventListener("click", (e) => {
    if (e.composedPath().includes(shadowHost)) return;
    const sel = window.getSelection();
    if (sel && sel.toString().trim().length > 0) return;
    hideTooltip();
    hidePill(true);
  }, { capture: true });

  // ─── Validation ───────────────────────────────────────────────────────────
  //
  // Single-character lookups are restricted to "a" / "I" — the only
  // single-letter English words with dictionary entries.
  //
  // The multi-character regex uses a literal space rather than \s to reject
  // selections that span line breaks (tabs, newlines) which produce garbled
  // API queries.
  //
  // NFC normalisation is applied first so that composed and decomposed Unicode
  // representations of the same character produce consistent results.
  function isValidLookup(text) {
    if (typeof text !== "string") return false;
    const t = text.normalize("NFC").trim();
    if (t.length === 0 || t.length > 60) return false;
    if (t.length === 1) return /^[aAiI]$/u.test(t);
    return /^\p{L}([\p{L} \-']*\p{L})?$/u.test(t);
  }

  // ─── Position tooltip ─────────────────────────────────────────────────────
  //
  // Coordinates are viewport-relative (clientX/Y) because the tooltip uses
  // position:fixed inside a fixed shadow host anchored at 0,0.
  //
  // animate=false: suppresses `transition: top` via an inline override so the
  //   tooltip snaps instantly to a new position (used when first showing a new
  //   word, preventing the tooltip from sliding from its last position).
  // animate=true: clears the override so the CSS transition applies (used when
  //   content loads and the tooltip height grows/shrinks).
  function positionTooltip(x, y, animate) {
    if (!animate) {
      // Apply transition:none BEFORE reading layout so offsetWidth/Height
      // reflect the static element, not a mid-transition state.
      tooltip.style.transition = "none";
      void tooltip.offsetHeight; // flush
    }

    const tipWidth  = tooltip.offsetWidth  || 370;
    const tipHeight = tooltip.offsetHeight || 0;

    // Use visualViewport dimensions if available (handles mobile zoom, iOS
    // Safari's variable-height browser chrome, etc.).
    const { width: vpWidth, height: vpHeight } = getViewport();

    let left = x + TOOLTIP_MARGIN;
    let top  = y + TOOLTIP_MARGIN * 2;

    // Flip left if it overflows the right edge.
    if (left + tipWidth > vpWidth - TOOLTIP_MARGIN) {
      left = x - tipWidth - TOOLTIP_MARGIN;
    }
    left = Math.max(TOOLTIP_MARGIN, left);

    tooltip.style.left = `${left}px`;

    // Vertical clamp — done synchronously so the tooltip is never rendered
    // out of bounds.
    if (top + tipHeight > vpHeight - TOOLTIP_MARGIN) {
      top = Math.max(TOOLTIP_MARGIN, y - tipHeight - TOOLTIP_MARGIN);
    }
    tooltip.style.top = `${top}px`;

    if (!animate) {
      void tooltip.offsetHeight; // flush before re-enabling transition
      tooltip.style.transition = "";
    }
  }

  // ─── Pill: show / hide ────────────────────────────────────────────────────
  //
  // showPill() positions the pill near the end of the drag-selection and
  // starts a 2-second auto-hide timer.  The pill captures the selected text
  // at this moment so it is still available when the user clicks even if the
  // browser has cleared the selection by then.
  //
  // hidePill() plays a short fade-out animation before setting display:none.
  // Safe to call repeatedly (no-op if already hidden).

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
    // Dismiss any existing pill immediately before showing the new one.
    hidePill(true);
    pillText = text;

    // Mirror relevant theme vars from the tooltip onto the pill.
    applyPageTheme();
    const ts = tooltip.style;
    pill.style.setProperty("--dict-pill-bg",     ts.getPropertyValue("--dict-bg")     || "#fff");
    pill.style.setProperty("--dict-pill-border",  ts.getPropertyValue("--dict-border") || "rgba(0,0,0,0.13)");
    pill.style.setProperty("--dict-pill-text",    ts.getPropertyValue("--dict-text")   || "#333");

    // Position: slightly above-right of where the mouse was released.
    const { width: vpWidth, height: vpHeight } = getViewport();

    let left = x + PILL_MARGIN;
    let top  = y - PILL_ESTIMATED_H - PILL_MARGIN;

    if (left + PILL_ESTIMATED_W > vpWidth  - PILL_MARGIN) left = x - PILL_ESTIMATED_W - PILL_MARGIN;
    if (top < PILL_MARGIN)                                 top  = y + PILL_MARGIN;
    // Clamp bottom edge — if the fallback position (y + PILL_MARGIN) also overflows
    // the bottom of the viewport, pin the pill just above the bottom edge.
    if (top + PILL_ESTIMATED_H > vpHeight - PILL_MARGIN)  top  = vpHeight - PILL_ESTIMATED_H - PILL_MARGIN;
    left = Math.max(PILL_MARGIN, left);
    top  = Math.max(PILL_MARGIN, top);

    pill.style.left = `${left}px`;
    pill.style.top  = `${top}px`;

    // Reset animation reliably: remove both state classes first, flush layout
    // so the browser registers the removal, then re-add dict-pill-visible.
    // The previous approach (animation:"none" inline → clear) was fragile when
    // the browser batched the class-toggle and the offsetHeight flush, meaning
    // the animation occasionally failed to replay on rapid repeat selections.
    pill.classList.remove("dict-pill-hiding", "dict-pill-visible");
    void pill.offsetHeight; // force reflow — must precede re-adding the class
    pill.classList.add("dict-pill-visible");

    // Auto-hide after 2 seconds.
    pillTimer = setTimeout(() => {
      pillTimer = null;
      hidePill(false);
    }, 2000);
  }

  // ─── Pill interaction handlers ────────────────────────────────────────────

  // Click (or Enter/Space) on the pill → trigger the full lookup.
  function onPillActivate(e) {
    e.preventDefault();
    e.stopPropagation();
    const text = pillText;
    if (!text || !isValidLookup(text)) return;
    // Capture position BEFORE hidePill(true) — hiding sets display:none which
    // makes getBoundingClientRect() return all zeros.
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

  // ─── Show tooltip ──────────────────────────────────────────────────────────
  function showTooltip(clientX, clientY, text) {
    // Internal safety guard — all public callers already run isValidLookup(),
    // but a future code path might call showTooltip() directly.  Bail out
    // rather than rendering arbitrary text in the word heading.
    if (!isValidLookup(text)) return;

    // Abort any in-flight fetch from the previous lookup immediately.
    // Without this, a fetch that completes during the 300 ms debouncedLookup
    // window would write its phonetic / body / source into the DOM that
    // showTooltip just initialised for a *different* word — corrupting the
    // display silently.  lookupWord() also aborts at its start, but that
    // fires 300 ms later; this closes the gap entirely.
    if (currentAbortController) {
      currentAbortController.abort();
      currentAbortController = null;
    }

    currentClientX = clientX;
    currentClientY = clientY;
    // Capture the page-absolute anchor so _onPageScroll() can keep the
    // tooltip pinned to the spawn word as the document scrolls.
    // window.scrollX / scrollY give the current document scroll offset;
    // adding them to the viewport-relative clientX / clientY converts to
    // page (document) coordinates that remain stable across scroll events.
    // pageXOffset / pageYOffset are the legacy aliases — present in every
    // browser that supports content scripts, used as fallbacks for any
    // environment where scrollX / scrollY are undefined.
    _anchorPageX = clientX + (window.scrollX ?? window.pageXOffset ?? 0);
    _anchorPageY = clientY + (window.scrollY ?? window.pageYOffset ?? 0);

    // Reset MW switch state for every new word.
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

    // Reset the fade-in animation.  Suppress `top` transition during this
    // reset so the tooltip doesn't slide from its last position.
    tooltip.style.transition = "none";
    tooltip.style.animation  = "none";
    tooltip.classList.remove("dict-counting");
    void tooltip.offsetHeight; // force reflow
    // Promote to a compositor layer for the duration of the entry animation.
    // Skipped when the user prefers reduced motion — animation: none prevents
    // dict-fade-in from firing, so animationend would never clear willChange,
    // leaving the compositor hint permanently set after every lookup.
    if (!_reducedMotionMql?.matches) {
      tooltip.style.willChange = "transform, opacity";
    }
    tooltip.style.animation  = "";
    tooltip.style.transition = "";

    // Initial placement — no animation so the tooltip snaps to position.
    positionTooltip(clientX, clientY, false);

    if (AUTO_CLOSE_MS > 0) {
      tooltip.classList.add("dict-counting");
      startAutoClose();
    }
  }

  // ─── PRIMARY trigger: double-click ────────────────────────────────────────
  // Only fires on left-button double-clicks (button === 0); middle- and
  // right-click double-clicks are ignored.
  document.addEventListener("dblclick", (e) => {
    if (e.button !== 0) return;
    if (e.composedPath().includes(shadowHost)) return;
    clearTimeout(mouseUpTimer);
    mouseUpTimer = null;
    // Hide any pill — the user clearly wants a lookup, so skip the gate.
    hidePill(true);
    const sel  = window.getSelection();
    const text = sel ? sel.toString().trim() : "";
    if (isValidLookup(text)) {
      showTooltip(e.clientX, e.clientY, text);
      debouncedLookup(text);
    }
  }, { capture: true });

  // ─── GATE trigger: click-drag selection → pill ────────────────────────────
  //
  // Drag selections show the pill first so the user confirms intent before a
  // lookup fires, preventing the tooltip from appearing on every copy action.
  // Double-click bypasses this gate entirely (see PRIMARY trigger above).
  //
  // Only left-button (button === 0) drags are tracked; right-click drags and
  // middle-click drags do not involve text selection in standard browsers.

  document.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (!e.composedPath().includes(shadowHost)) {
      isDragging = true;
      // Dismiss any open tooltip and pill the moment a new selection begins.
      hideTooltip();
      hidePill(true);
    }
  }, { capture: true });

  document.addEventListener("mouseup", (e) => {
    if (e.button !== 0) return;
    if (!isDragging) return;
    isDragging = false;
    if (e.composedPath().includes(shadowHost)) return;

    // Capture the selection text synchronously here — before the `click`
    // event fires immediately after mouseup on most sites.  Many pages
    // collapse the selection inside their own mouseup / click handlers
    // (e.g. React roots calling selection.removeAllRanges()), so reading
    // getSelection() inside the setTimeout callback would return "" and the
    // pill would never appear.  This was the root cause of the reported
    // click-and-drag pill bug: the subsequent click event cleared the
    // selection before our 150 ms timer could read it.
    const sel  = window.getSelection();
    const text = sel ? sel.toString().trim() : "";

    if (!text || !isValidLookup(text)) return;

    clearTimeout(mouseUpTimer);
    mouseUpTimer = setTimeout(() => {
      mouseUpTimer = null;
      showPill(e.clientX, e.clientY, text);
    }, 150);
  }, { capture: true });

  // ─── isDragging safety resets ─────────────────────────────────────────────
  //
  // If the user holds the left button and releases it outside the browser
  // window (or on another tab, scrollbar, OS UI, etc.), no `mouseup` fires
  // on this document.  Without these guards, isDragging stays `true`
  // permanently, causing every subsequent mousedown to skip the pill-show path.

  // Window blur: fires when the browser window or tab loses focus.
  window.addEventListener("blur", () => {
    if (isDragging) {
      isDragging = false;
      clearTimeout(mouseUpTimer);
      mouseUpTimer = null;
    }
  }, { capture: true });

  // pointercancel: browser cancels a pointer sequence (scroll gesture,
  // touch hand-off, stylus lift, etc.).
  document.addEventListener("pointercancel", () => {
    if (isDragging) {
      isDragging = false;
      clearTimeout(mouseUpTimer);
      mouseUpTimer = null;
    }
  }, { capture: true });

  // ─── Tab-hide / visibility handling ──────────────────────────────────────
  //
  // When the user switches away from the tab, the tooltip and pill would
  // otherwise remain floating and visible on return (especially if auto-close
  // is disabled or was paused).  Hide both immediately on visibility change.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      hideTooltip();
      hidePill(true);
      isDragging = false;
      clearTimeout(mouseUpTimer);
      mouseUpTimer = null;
    }
  }, { capture: true });

  // ─── Page unload cleanup ──────────────────────────────────────────────────
  // Stop audio and cancel in-flight requests when the page is being unloaded
  // (navigation, refresh, tab close) to avoid spurious network activity.
  window.addEventListener("pagehide", () => {
    stopAudio();
    if (currentAbortController) {
      currentAbortController.abort();
      currentAbortController = null;
    }
  }, { capture: true });

  // ─── Scroll: pin tooltip to spawn-word position ───────────────────────────
  //
  // The tooltip is position:fixed inside a fixed shadow host, so its left/top
  // values are always viewport-relative.  Without scroll tracking, a page scroll
  // moves the viewport under the fixed tooltip — the tooltip stays at the same
  // screen coordinates while the word it was spawned from scrolls away.
  //
  // On every scroll tick, _onPageScroll() converts the page-absolute anchor
  // (_anchorPageX / _anchorPageY, captured in showTooltip()) back to the
  // current viewport-relative position and re-calls positionTooltip(), keeping
  // the tooltip visually attached to the spawn word in the document.
  //
  // { passive: true } — we never call preventDefault(); marking the listener
  //   passive lets the browser schedule the callback off the critical scroll
  //   path, eliminating any risk of janking scroll performance.
  // Window-level scroll covers standard document scroll.  Nested scrollable
  //   containers are intentionally out of scope — tracking per-container offsets
  //   is a separate, more complex feature with diminishing practical value.
  function _onPageScroll() {
    if (tooltip.style.display === "none") return;
    const scrollX = window.scrollX ?? window.pageXOffset ?? 0;
    const scrollY = window.scrollY ?? window.pageYOffset ?? 0;
    positionTooltip(
      _anchorPageX - scrollX,
      _anchorPageY - scrollY,
      false // snap without CSS transition — avoids lag during active scrolling
    );
  }

  window.addEventListener("scroll", _onPageScroll, { passive: true });

  // ─── Keyboard trigger ─────────────────────────────────────────────────────
  //
  // Escape closes.  Shift-release triggers a lookup on the current selection.
  //
  // In a closed shadow root, document.activeElement returns the shadow host
  // when focus is inside it — not null or the internal element.
  document.addEventListener("keydown", (e) => {
    // Ctrl+C / Cmd+C while the pill is visible means the user is copying —
    // dismiss the pill without triggering a lookup.
    if ((e.ctrlKey || e.metaKey) && e.key === "c") {
      hidePill(true);
    }
  }, { capture: true });

  // Right-click → dismiss pill so it doesn't overlap the native context menu.
  document.addEventListener("contextmenu", () => hidePill(true), { capture: true });

  document.addEventListener("keyup", (e) => {
    if (e.key === "Escape") {
      hideTooltip();
      hidePill(true);
      return;
    }
    if (e.key !== "Shift") return;
    if (document.activeElement === shadowHost) return;

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;

    const text = sel.toString().trim();
    if (!text || !isValidLookup(text)) return;

    // getBoundingClientRect() is already viewport-relative.
    // In some browsers, selections inside cross-origin iframes return an
    // all-zeros rect.  Detect that and fall back to a safe viewport position
    // rather than placing the tooltip at (0, 0) in the top-left corner.
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    const { width: vpW, height: vpH } = getViewport();
    const isZeroRect = rect.width === 0 && rect.height === 0 && rect.top === 0 && rect.left === 0;
    const anchorX = isZeroRect ? vpW / 2 : rect.right;
    const anchorY = isZeroRect ? vpH / 3 : rect.bottom;
    showTooltip(anchorX, anchorY, text);
    debouncedLookup(text);
  }, { capture: true });

  // ─── Debounced lookup ─────────────────────────────────────────────────────
  function debouncedLookup(text) {
    clearTimeout(lookupDebounceTimer);
    lookupDebounceTimer = setTimeout(() => {
      lookupDebounceTimer = null;
      lookupWord(text);
    }, 300);
  }

  // ─── Audio helper ─────────────────────────────────────────────────────────
  //
  // Creates and appends a Listen button.  Validates the URL to an https://
  // origin before creating an Audio() object, preventing javascript: / data:
  // URI injection from a malformed API response.
  //
  // While audio is playing the auto-close countdown is suspended so the tooltip
  // cannot vanish mid-pronunciation.  The countdown is restarted once playback
  // ends, errors, or the user dismisses the tooltip manually.
  //
  // Safety timer (15 s): if neither "ended" nor "error" fires and play() already
  // resolved (e.g. browser silently stalls a stuck MP3), the auto-close countdown
  // would stay suspended forever.  The timer guarantees it always resumes.
  const AUDIO_SAFETY_MS = 15000;

  function appendAudioButton(audioUrl) {
    if (!isSafeHttpsUrl(audioUrl)) return;

    const audioBtn = document.createElement("button");
    audioBtn.setAttribute("type", "button");
    audioBtn.className   = "dict-audio-btn";
    audioBtn.textContent = "\uD83D\uDD0A Listen";
    audioBtn.setAttribute("aria-label", "Listen to pronunciation");
    audioBtn.addEventListener("click", () => {
      // Stop any currently playing audio before starting a new one.
      stopAudio();

      const audio = new Audio(audioUrl);
      currentAudio = audio;

      // Suspend the auto-close countdown while audio plays so the tooltip
      // cannot dismiss itself mid-pronunciation.
      tooltip.classList.remove("dict-counting");
      clearTimeout(autoCloseTimer);
      autoCloseTimer = null;

      // Safety timer: resume auto-close if neither "ended" nor "error" fires
      // within AUDIO_SAFETY_MS (guards against a silently stalled browser audio
      // element whose play() Promise resolved but playback never completes).
      // Attached to the audio instance itself so stopAudio() can cancel it
      // when the tooltip is dismissed before playback finishes.
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
        console.warn("[Instant Dictionary] Audio playback failed:", err);
      });
    });
    elBody.appendChild(audioBtn);
  }

  // ─── Lookup sequence counter ──────────────────────────────────────────────
  // Monotonically-increasing integer that increments at the START of every
  // lookupWord() call.  Each invocation captures its own value (mySeq); after
  // every async suspension point it compares mySeq against the module-level
  // _lookupSeq.  If a newer lookupWord() call has already started, mySeq will
  // be stale (mySeq !== _lookupSeq) and the earlier invocation returns
  // immediately without touching the DOM.  This is necessary because storage
  // is now read BEFORE the cache check, introducing a brief async gap during
  // which a second lookupWord() may be triggered (e.g. rapid double-selection).
  let _lookupSeq = 0;

  // ─── Lookup orchestrator ──────────────────────────────────────────────────
  //
  // Source order is determined by the user's "lookup_priority" setting:
  //
  //  "auto"          (default / "Standard" in UI)
  //    → Public sources consulted first for every lookup.
  //    → Configured APIs used ONLY as a secondary fallback when public sources
  //      return no result.
  //    → Operates without any API credentials.
  //
  //  "premium_first" → Configured APIs consulted first; public sources serve
  //                    as fallback when no result is returned.
  //
  // Note: the legacy "free_first" value is treated identically to "auto".
  //
  async function lookupWord(text) {
    // Claim a sequence number BEFORE any async work so a later call can
    // detect and supersede this one during the storage-read await below.
    const mySeq = ++_lookupSeq;

    // Cancel any in-flight request before starting a new one.
    if (currentAbortController) {
      currentAbortController.abort();
      currentAbortController = null;
    }

    // Reset the warning accumulator for this fresh lookup attempt.
    _configuredApiWarnings = [];

    const baseKey  = normaliseLookupKey(text);
    const isPhrase = text.includes(" ");

    // ── Read storage first ────────────────────────────────────────────────
    // Storage must be read BEFORE the cache check so we know the active
    // priority.  The cache is namespaced by priority (see effectiveCacheKey
    // below), which means changing priority correctly produces a cache miss
    // and triggers a fresh network fetch honouring the new setting.
    let keys;
    try {
      keys = await getStoredKeys();
    } catch (err) {
      console.warn("[Instant Dictionary] Storage read failed:", err);
      keys = {
        mwCollegiateKey: "", mwThesaurusKey: "",
        s4Uid: "", s4Token: "", priority: "auto",
        mwCount: 0, mwThesaurusCount: 0, s4Count: 0,
        mwLimit: MW_DEFAULT_LIMIT, s4Limit: S4_DEFAULT_LIMIT,
      };
    }

    // If a newer lookupWord() call started while we awaited storage, bail out.
    if (mySeq !== _lookupSeq) return;

    const {
      mwCollegiateKey, mwThesaurusKey,
      s4Uid, s4Token, priority,
      mwCount, mwThesaurusCount, s4Count, mwLimit, s4Limit,
    } = keys;

    // Normalise legacy "free_first" value — treated identically to "auto".
    const effectivePriority = (priority === "free_first") ? "auto" : priority;

    // Combined MW call total used against the single shared daily limit.
    // The popup exposes one MW meter, so both collegiate and thesaurus calls
    // count toward the same cap.
    const mwTotalCount = mwCount + mwThesaurusCount;

    // Apply user-configured daily limits before dispatching any API requests.
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
    const hasMW               = hasMWCollegiate || hasMWThesaurus;
    const hasConfiguredApis   = hasS4 || hasMW;

    // ── Source sequence selection ─────────────────────────────────────────
    // Four fully-explicit ordered chains replace the old "configured first vs
    // public first" binary split.  The correct chain is selected by
    // (isEnhanced × isPhrase) and executed by _runLookupSequence(), which runs
    // zero-argument async thunks left-to-right, stopping at the first success.
    //
    // S4 endpoint is grammar-constrained:
    //   • Single token  → S4 Vocab only.  A single word cannot be an idiom,
    //     phrase, or expression by grammatical definition — calling S4 Idioms
    //     would always return nothing and waste quota.
    //   • Multi-token   → S4 Idioms only.  A multi-word selection is a phrase,
    //     idiom, or expression — not a standalone vocabulary entry.
    //
    // Quota & coverage drive MW vs S4 ordering:
    //   Standard mode   — free public sources lead; configured APIs are
    //     appended as fallbacks.  Unchanged from original behaviour.
    //   Enhanced + Single — MW leads (up to 1 000 calls/day per key, richer
    //     single-word entries with phonetics and audio).  S4's smaller quota
    //     is preserved for the phrases it is built for.
    //   Enhanced + Multi  — S4 Idioms leads (purpose-built for phrases and
    //     expressions); MW is extremely unlikely to match a multi-word query
    //     but is included as a secondary configured fallback.
    //
    // Free-source ordering:
    //   Single word — Free Dictionary first (stronger single-word coverage).
    //   Multi-word  — Wiktionary first (substantially broader idiom/expression
    //     coverage; Free Dictionary rarely matches multi-word queries).
    //
    // All hasXxx guards live inside each thunk — an unconfigured source
    // returns false instantly without issuing a network request.
    const isEnhanced = effectivePriority === "premium_first";

    writeLog("info",
      `Lookup: "${text}" | priority=${effectivePriority} | isEnhanced=${isEnhanced}` +
      ` | isPhrase=${isPhrase}` +
      ` | hasS4=${hasS4} | hasMWCollegiate=${hasMWCollegiate} | hasMWThesaurus=${hasMWThesaurus}`
    );

    // ── Priority-namespaced cache key ─────────────────────────────────────
    // Including `priority` in the cache key ensures each priority setting has
    // its own independent cache namespace.  Consequences:
    //   • Changing from "auto" to "premium_first" always produces a cache miss
    //     and triggers a fresh lookup that correctly consults configured sources first.
    //   • A term that configured APIs cannot resolve (falling back to public sources)
    //     is cached under "premium_first:<word>" so subsequent same-priority lookups
    //     hit the cache instantly without re-querying configured APIs every time.
    //   • Reverting to "auto" (or any other priority) causes a cache miss so the
    //     correct source order is always honoured after a priority change.
    const effectiveCacheKey = `${effectivePriority}:${baseKey}`;

    // ── Cache hit ─────────────────────────────────────────────────────────
    if (lookupCache.has(effectiveCacheKey)) {
      const cached = lookupCache.get(effectiveCacheKey);
      // Promote to most-recently-used by re-inserting at Map tail so that the
      // FIFO eviction order in cacheSet() becomes true LRU across access time,
      // not just insertion time.
      lookupCache.delete(effectiveCacheKey);
      lookupCache.set(effectiveCacheKey, cached);
      elPhonetic.textContent = cached.phonetic || "";
      safeSetHTML(elBody, cached.html);
      elSource.textContent = cached.source;
      if (cached.audioUrl) appendAudioButton(cached.audioUrl);
      // Restore MW switch button visibility for cache hits from MW sources.
      if (cached.mwApi) {
        _updateMwSwitchButton(cached.mwApi, baseKey, text, hasMWCollegiate, hasMWThesaurus);
      }
      positionTooltip(currentClientX, currentClientY, true);
      return;
    }

    // Only create the AbortController when we are actually going to fetch.
    currentAbortController = new AbortController();
    const { signal } = currentAbortController;

    try {
      // ── Source descriptors — { label, fn } pairs ─────────────────────────
      // Each fn is a pure async fetcher that calls the underlying network
      // function and returns its boolean result directly.  No availability
      // guards live inside the fns — instead, configured sources are
      // conditionally included when building the sequence below, so the
      // sequence list is the authoritative record of exactly what will be
      // attempted.  All per-step logging (trying / resolved / no result) is
      // centralised in _runLookupSequence so every source is recorded uniformly.
      const _freeDict = {
        label: "Free Dictionary",
        fn:    () => fetchFreeDictionary(text, signal, effectiveCacheKey),
      };
      const _wikt = {
        label: "Wiktionary",
        fn:    () => fetchWiktionary(text, signal, effectiveCacheKey),
      };
      // Merriam-Webster — Collegiate and Thesaurus share the same envelope;
      // Thesaurus is the natural fallback when Collegiate returns nothing.
      const _mwCol = {
        label: "MW Collegiate",
        fn:    () => fetchMwApi(
          "collegiate", text, signal, mwCollegiateKey, baseKey, effectiveCacheKey,
          hasMWCollegiate, hasMWThesaurus
        ),
      };
      const _mwThes = {
        label: "MW Thesaurus",
        fn:    () => fetchMwApi(
          "thesaurus", text, signal, mwThesaurusKey, baseKey, effectiveCacheKey,
          hasMWCollegiate, hasMWThesaurus
        ),
      };
      // STANDS4 — endpoint chosen by selection type (single word vs phrase).
      const _s4Vocab = {
        label: "STANDS4 Vocabulary",
        fn:    () => fetchSTANDS4Vocab(text, signal, s4Uid, s4Token, effectiveCacheKey),
      };
      const _s4Idioms = {
        label: "STANDS4 Idioms",
        fn:    () => fetchSTANDS4Idioms(text, signal, s4Uid, s4Token, effectiveCacheKey),
      };

      // ── Four explicit ordered chains ──────────────────────────────────────
      //
      // Priority × selection-type matrix (configured sources in [brackets]
      // are only included when the corresponding credential/quota gate passes):
      //
      //  Standard + Single : Free Dictionary → Wiktionary [→ MW Col → MW Thes → S4 Vocab]
      //  Standard + Multi  : Wiktionary → Free Dictionary [→ S4 Idioms → MW Col → MW Thes]
      //  Enhanced + Single : [MW Col → MW Thes → S4 Vocab →] Wiktionary → Free Dictionary
      //  Enhanced + Multi  : [S4 Idioms → MW Col → MW Thes →] Wiktionary → Free Dictionary
      //
      // Because unconfigured/over-limit sources are excluded at build time,
      // every entry that appears in the sequence will make a real network
      // request.  "no result" in the log always means "was tried and returned
      // nothing" — never "was skipped due to missing credentials".
      let sequence;
      if (!isEnhanced && !isPhrase) {
        sequence = [
          _freeDict, _wikt,
          ...(hasMWCollegiate ? [_mwCol]   : []),
          ...(hasMWThesaurus  ? [_mwThes]  : []),
          ...(hasS4           ? [_s4Vocab] : []),
        ];
      } else if (!isEnhanced && isPhrase) {
        sequence = [
          _wikt, _freeDict,
          ...(hasS4           ? [_s4Idioms] : []),
          ...(hasMWCollegiate ? [_mwCol]    : []),
          ...(hasMWThesaurus  ? [_mwThes]   : []),
        ];
      } else if (isEnhanced && !isPhrase) {
        sequence = [
          ...(hasMWCollegiate ? [_mwCol]   : []),
          ...(hasMWThesaurus  ? [_mwThes]  : []),
          ...(hasS4           ? [_s4Vocab] : []),
          _wikt, _freeDict,
        ];
      } else {
        // Enhanced + Multi
        sequence = [
          ...(hasS4           ? [_s4Idioms] : []),
          ...(hasMWCollegiate ? [_mwCol]    : []),
          ...(hasMWThesaurus  ? [_mwThes]   : []),
          _wikt, _freeDict,
        ];
      }

      // Log the exact sequence that will be attempted before any fetch fires.
      // This single line, combined with the per-step logs inside _runLookupSequence,
      // makes every lookup fully traceable from start to finish in the log panel.
      writeLog("info", `Sequence: ${sequence.map((s) => s.label).join(" \u2192 ")}`);
      const found = await _runLookupSequence(sequence, signal, text);

      if (!found && !signal.aborted) {
        if (tooltip.style.display !== "none") {
          // If configured APIs returned 429/401/403, surface that as an
          // actionable message rather than silently reporting no definition found.
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
      console.warn("[Instant Dictionary] Lookup failed:", err);
      writeLog("error", `Network error during lookup for "${text}": ${err.message ?? err}`);
      if (tooltip.style.display !== "none") {
        safeSetHTML(
          elBody,
          `<p class="dict-error">\u26A0\uFE0F Network error \u2014 check your connection and try again.</p>`
        );
      }
    } finally {
      // Release the controller reference so the completed AbortController can
      // be GC'd.  Without this, currentAbortController holds the last resolved
      // controller until the next lookup starts — at which point the first thing
      // the next lookup does is abort an already-completed controller spuriously.
      // hideTooltip() also nullifies it, but that path is not always taken.
      if (currentAbortController && currentAbortController.signal === signal) {
        currentAbortController = null;
      }
    }
  }

  // ─── API source sequencer ──────────────────────────────────────────────────
  //
  // Executes an ordered array of { label, fn } descriptors left-to-right,
  // stopping as soon as one resolves the query or the AbortSignal fires.
  //
  // Centralised logging contract:
  //   "trying X"       — emitted before every fn() call; confirms the source
  //                       entered the network stack.
  //   "resolved via X" — emitted on the first success; the sequence stops here.
  //   "X: no result"   — emitted when fn() returns false without being aborted;
  //                       always means the source was tried and returned nothing,
  //                       never that it was skipped (unconfigured sources are
  //                       filtered out of the sequence before this function runs).
  //
  // Source ordering is fully explicit: lookupWord assembles the correct chain for
  // each (priority × selection-type) combination and passes it here, making the
  // lookup strategy visible at a glance without any branching inside this function.
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

  // ─── Exponential-backoff fetch ─────────────────────────────────────────────
  //
  // Wraps fetch() with automatic retry on HTTP 429 (Too Many Requests):
  //   attempt 0 → if 429, wait 1 s
  //   attempt 1 → if 429, wait 2 s
  //   attempt 2 → if 429, wait 4 s
  //   attempt 3 → return the 429 Response so the caller can report it
  //
  // All other status codes (including 404, 401, 403) are returned immediately
  // without retrying.  AbortError propagates normally — the sleep itself is
  // also abort-aware so cancellation is prompt even mid-backoff.
  async function fetchWithBackoff(url, fetchOptions, maxRetries = 3) {
    const signal = fetchOptions.signal;
    let delay = 1000;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Guard: if the signal was already aborted before this iteration begins
      // (e.g. user dismissed the tooltip mid-backoff sleep), throw immediately
      // rather than firing a fetch that will be cancelled instantly anyway.
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      let response;
      // fetch() throws on network failure or abort; both propagate naturally
      // to the per-source catch blocks (AbortError is re-thrown there so
      // callers can distinguish cancellation from network failures).
      response = await fetch(url, fetchOptions);

      if (signal?.aborted) return null;
      // Return immediately for anything that is not a retryable 429, or once
      // we have exhausted all retry attempts.
      if (response.status !== 429 || attempt === maxRetries) return response;
      // Sleep before the next attempt, but wake immediately on abort.
      // Guard: if the signal was already aborted before we enter this Promise
      // (e.g. user dismissed the tooltip during the previous fetch), the
      // "abort" event has already fired and adding a listener won't re-fire it.
      // Reject immediately in that case rather than sleeping the full delay.
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
    return null; // unreachable; satisfies static analysis
  }

  // ─── SOURCE 1: Free Dictionary API ────────────────────────────────────────
  async function fetchFreeDictionary(text, signal, effectiveCacheKey) {
    // Snapshot coordinates at call time.  If the user opens a new tooltip
    // before this fetch completes, the snapshot won't match currentClientX/Y
    // and we skip the reposition to avoid mis-placing the newer tooltip.
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

      // Phonetic — resolved into a local variable first; DOM is not touched
      // until we have confirmed that at least one definition was found.
      // Writing elPhonetic before validation caused the stale phonetic from a
      // failed FreeDictionary attempt to persist when Wiktionary was the actual
      // source (Wiktionary does not write elPhonetic, so it would never clear it).
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
        // Build this meaning's markup into a local buffer first.  Only wrap it
        // in <div class="dict-meaning"> if at least one valid definition was
        // contributed — a meaning whose entire definitions array is invalid
        // (null entries, non-string values, empty strings) would otherwise
        // produce an orphaned POS-only div that renders as a floating badge.
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
        if (defNum === 0) return; // skip meanings with no usable definitions
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

      // Require at least one real definition paragraph — wrapper divs with only
      // a POS badge but no body text are not a useful result.
      if (!html || defsAdded === 0) return false;

      let audioUrl = null;
      if (Array.isArray(entry.phonetics)) {
        const audioEntry = entry.phonetics.find(
          (p) => p && typeof p.audio === "string" && p.audio
        );
        if (audioEntry) audioUrl = audioEntry.audio;
      }
      // Validate scheme before storing.
      if (!isSafeHttpsUrl(audioUrl)) audioUrl = null;

      // All validation passed — now commit to the live DOM.
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
      console.warn("[Instant Dictionary] Free Dictionary API error:", err);
      writeLog("warn", `Free Dictionary API: request failed — ${err.message ?? err}`);
      return false;
    }
  }

  // ─── SOURCE 2: Wiktionary API ─────────────────────────────────────────────
  async function fetchWiktionary(text, signal, effectiveCacheKey) {
    const snapX = currentClientX;
    const snapY = currentClientY;

    // Preserve original capitalisation (proper nouns, acronyms); replace
    // spaces with underscores as the Wiktionary REST API requires.
    // The / +/g replace collapses runs of spaces to a single underscore.
    // Underscores are not percent-encoded by encodeURIComponent, so the URL
    // path receives literal underscores as Wiktionary expects.
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
        // Build this entry's markup into a local buffer first.  Only wrap it
        // in <div class="dict-meaning"> if at least one definition survives
        // stripHtml — Wiktionary definitions often contain embedded HTML markup
        // that reduces to an empty string after stripping, so a full entry can
        // produce zero usable output and must not create an orphaned POS div.
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
        if (defNum === 0) return; // skip entries with no usable definitions
        html += `<div class="dict-meaning"><span class="dict-pos">${escapeHtml(pos)}</span>${entryHtml}</div>`;
      });

      if (!html || defsAdded === 0) return false;

      // Wiktionary does not supply phonetics.  Explicitly clear so a stale
      // phonetic from a preceding source that partially wrote to the DOM
      // (before failing at a later async step) does not bleed through.
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
      console.warn("[Instant Dictionary] Wiktionary API error:", err);
      writeLog("warn", `Wiktionary API: request failed — ${err.message ?? err}`);
      return false;
    }
  }

  // ─── SOURCE 3: STANDS4 Vocabulary API ─────────────────────────────────────
  //
  // Endpoint: https://www.stands4.com/services/v2/vocab.php
  // Best for: single words and short phrases with standard dictionary entries.
  // Returns a `result` object.  Returns `result: null` when not found.
  async function fetchSTANDS4Vocab(text, signal, uid, token, effectiveCacheKey) {
    const snapX = currentClientX;
    const snapY = currentClientY;

    try {
      const url = new URL("https://www.stands4.com/services/v2/vocab.php");
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

      const result = data?.result;
      // Require a plain object — null, arrays, and primitives are all invalid
      // response shapes.  (typeof [] === "object" in JS so the Array check is
      // necessary; without it an array response would pass and result.definition
      // would silently be undefined, relying on the downstream guard to catch it.)
      if (!result || typeof result !== "object" || Array.isArray(result)) return false;

      const definition = typeof result.definition === "string" ? result.definition.trim() : "";
      if (!definition) return false;

      const pos      = typeof result["part-of-speech"] === "string" ? result["part-of-speech"].trim() : "";
      const example  = typeof result.example           === "string" ? result.example.trim()           : "";
      const phonetic = typeof result.pronunciation     === "string" ? result.pronunciation.trim()     : "";

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
      console.warn("[Instant Dictionary] STANDS4 Vocab API error:", err);
      writeLog("error", `STANDS4 Vocab: request failed — ${err.message ?? err}`);
      return false;
    }
  }

  // ─── SOURCE 4: STANDS4 Idioms / Phrases API ───────────────────────────────
  //
  // Endpoint: https://www.stands4.com/services/v2/phrases.php
  // Best for: idioms and multi-word expressions not in standard dictionaries.
  // Returns a `result` array; each item has `phrase`, `definition`, `example`.
  // Returns `result: null` or empty array when not found.
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

      // `result` may be null, an object (single match), or an array (multiple).
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
      console.warn("[Instant Dictionary] STANDS4 Idioms API error:", err);
      writeLog("error", `STANDS4 Idioms: request failed — ${err.message ?? err}`);
      return false;
    }
  }

  // ─── MW switch button helpers ─────────────────────────────────────────────
  //
  // _updateMwSwitchButton() decides whether to show/hide the switch button
  // and what label it should carry, given:
  //   activeApi      — which MW API is currently displayed ("collegiate"|"thesaurus")
  //   baseKey        — normalised word used for mwAltCache lookups
  //   originalText   — original (pre-normalisation) user text, sent to the MW
  //                    API endpoint so the correct casing reaches the server
  //   hasMWCollegiate — whether the collegiate key is available and within quota
  //   hasMWThesaurus  — whether the thesaurus key is available and within quota
  //
  // The button is only shown when BOTH keys are present/within-quota — there is
  // nothing to switch to if the alternate API is not configured.
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

  // ─── MW switch button click handler ──────────────────────────────────────
  mwSwitchBtn.addEventListener("click", () => {
    const { activeApi, word, text: originalText } = _mwState;
    if (!activeApi || !word || !originalText) return;

    // Reset the warning accumulator so stale warnings from the prior
    // lookupWord() call cannot bleed into this independent switch operation.
    _configuredApiWarnings = [];

    const targetApi = activeApi === "collegiate" ? "thesaurus" : "collegiate";
    const altCacheKey = `mwalt:${targetApi}:${word}`;

    // Computed once here — used in every early-return path to restore the source
    // line without repeating the same ternary and string literals five times.
    const _currentSourceLabel = activeApi === "collegiate"
      ? "Source: Merriam-Webster Collegiate Dictionary"
      : "Source: Merriam-Webster Thesaurus Dictionary";

    // If we already fetched the alternate result this session, serve it instantly.
    if (mwAltCache.has(altCacheKey)) {
      const cached = mwAltCache.get(altCacheKey);
      // Promote to most-recently-used so the LRU eviction order in
      // mwAltCacheSet() reflects access time, not just insertion time —
      // matching the behaviour of the main lookupCache.
      mwAltCache.delete(altCacheKey);
      mwAltCache.set(altCacheKey, cached);
      elPhonetic.textContent = cached.phonetic || "";
      // Clear body first so the audio button from the previous result is removed.
      safeSetHTML(elBody, cached.html);
      elSource.textContent = cached.source;
      if (cached.audioUrl) appendAudioButton(cached.audioUrl);
      // Flip state — we'll need the has* flags when re-showing the button.
      // Re-read from _mwState (which now references the new activeApi).
      _mwState = { activeApi: targetApi, word, text: originalText };
      // Button label flips: now points back to the original.
      const newTargetLabel = targetApi === "collegiate" ? "\u21C4 Thesaurus" : "\u21C4 Collegiate";
      mwSwitchBtn.textContent = newTargetLabel;
      mwSwitchBtn.setAttribute(
        "aria-label",
        targetApi === "collegiate"
          ? "Switch to Merriam-Webster Thesaurus"
          : "Switch to Merriam-Webster Collegiate"
      );
      // Do NOT reposition — the tooltip is already where the user opened it
      // and must remain stationary when switching between MW dictionaries.
      return;
    }

    // No cached alternate result — fetch it now.
    // Abort any in-flight request first.
    if (currentAbortController) {
      currentAbortController.abort();
      currentAbortController = null;
    }

    // Show a subtle loading state without wiping the existing content.
    elSource.textContent = "\u231B Switching\u2026";
    mwSwitchBtn.disabled = true;

    // Safety timeout: covers the ENTIRE switch operation — storage read AND
    // the subsequent network fetch.  Previously this timer was cleared as soon
    // as storage responded, leaving the fetch phase completely unguarded (the
    // button stayed disabled for 30–60 s if the MW API hung).  Now the timer
    // is cleared only at each terminal path (success, no-result, abort, error)
    // so the button is always re-enabled within STORAGE_TIMEOUT_MS regardless
    // of where in the pipeline the hang occurs.
    const _switchSafetyTimer = setTimeout(() => {
      mwSwitchBtn.disabled = false;
      elSource.textContent = _currentSourceLabel;
    }, STORAGE_TIMEOUT_MS);

    currentAbortController = new AbortController();
    const { signal } = currentAbortController;

    // We need the actual key values — read from storage once.
    if (!isRuntimeValid()) {
      clearTimeout(_switchSafetyTimer);
      mwSwitchBtn.disabled = false;
      // Restore the source label — the "Switching…" placeholder must not persist.
      elSource.textContent = _currentSourceLabel;
      // Null out the controller we just created so the next lookupWord() does
      // not abort an already-orphaned (never-started) request.
      currentAbortController = null;
      return;
    }

    try {
      chrome.storage.local.get([KEY_MW_COLLEGIATE_KEY, KEY_MW_THESAURUS_KEY, KEY_MW_KEY], (result) => {
        // Do NOT clear the safety timer here — storage responded, but the
        // fetch phase hasn't started yet.  The timer must stay armed until
        // the fetch terminates (success, no-result, abort, or error).
        if (chrome.runtime.lastError || signal.aborted) {
          // Release the orphaned controller so it can be GC'd and won't be
          // spuriously aborted by the next lookupWord() or hideTooltip() call.
          clearTimeout(_switchSafetyTimer);
          if (currentAbortController?.signal === signal) currentAbortController = null;
          mwSwitchBtn.disabled = false;
          // Restore the source label — the "Switching…" placeholder must not persist.
          if (!signal.aborted) elSource.textContent = _currentSourceLabel;
          return;
        }

        // Re-apply legacy migration: fall back to mw_key if collegiate slot empty.
        const legacyKey       = typeof result[KEY_MW_KEY]              === "string" ? result[KEY_MW_KEY].trim()              : "";
        const rawCollegiate   = typeof result[KEY_MW_COLLEGIATE_KEY]   === "string" ? result[KEY_MW_COLLEGIATE_KEY].trim()   : "";
        const rawThesaurus    = typeof result[KEY_MW_THESAURUS_KEY]    === "string" ? result[KEY_MW_THESAURUS_KEY].trim()    : "";
        const collegiateKey   = rawCollegiate || legacyKey;
        const thesaurusKey    = rawThesaurus;

        const apiKey = targetApi === "collegiate" ? collegiateKey : thesaurusKey;
        if (!apiKey) {
          clearTimeout(_switchSafetyTimer);
          mwSwitchBtn.disabled = false;
          elSource.textContent = `${_currentSourceLabel} (${targetApi === "collegiate" ? "Collegiate" : "Thesaurus"}: API key not configured — verify credentials in Settings)`;
          return;
        }

        const hasMWCollegiate_live = !!collegiateKey;
        const hasMWThesaurus_live  = !!thesaurusKey;

        const fetchFn = (type) => fetchMwApi(
          type, originalText, signal, apiKey, word /* baseKey */, null /* no effectiveCacheKey */,
          hasMWCollegiate_live, hasMWThesaurus_live
        );
        fetchFn(targetApi)
          .then((found) => {
            // Clear the safety timer — the fetch completed normally.
            clearTimeout(_switchSafetyTimer);
            // Release the completed controller so it can be GC'd and isn't
            // aborted unnecessarily by the next lookupWord() or switch click.
            if (currentAbortController?.signal === signal) currentAbortController = null;
            mwSwitchBtn.disabled = false;
            if (signal.aborted) return;
            if (!found) {
              // Nothing found in the alternate API — restore source label and
              // leave the existing content untouched so the user can still read it.
              const targetLabel = targetApi === "collegiate" ? "Collegiate" : "Thesaurus";
              elSource.textContent = `${_currentSourceLabel} (${targetLabel}: no result)`;
            }
            // _updateMwSwitchButton already called inside fetchMw* — state is set.
          })
          .catch((err) => {
            // Clear the safety timer — the fetch terminated (via abort or error).
            clearTimeout(_switchSafetyTimer);
            if (currentAbortController?.signal === signal) currentAbortController = null;
            mwSwitchBtn.disabled = false;
            if (err.name !== "AbortError") {
              console.warn("[Instant Dictionary] MW switch fetch error:", err);
            }
          });
      });
    } catch (err) {
      // chrome.storage.local.get can throw synchronously if the extension context
      // was invalidated in the instant between the isRuntimeValid() guard above
      // and this call.  Recover gracefully: clear the safety timer, re-enable the
      // button, restore the source label, and release the orphaned controller.
      clearTimeout(_switchSafetyTimer);
      mwSwitchBtn.disabled = false;
      elSource.textContent = _currentSourceLabel;
      if (currentAbortController?.signal === signal) currentAbortController = null;
      console.warn("[Instant Dictionary] MW switch storage access failed:", err);
    }
  });

  // ─── Shared MW response parser ────────────────────────────────────────────
  //
  // Both Collegiate and Thesaurus responses share the same JSON shape:
  // an array of entry objects, each with .shortdef, .hwi.prs, .fl, etc.
  //
  // Returns { html, phonetic, audioUrl } on success, or null when the response
  // contains no usable definitions.  Does NOT touch the DOM — callers do that.
  //
  // Audio URL formula (official MW spec):
  //   base:   https://media.merriam-webster.com/audio/prons/en/us/mp3/
  //   subdir: first letter of audio filename, EXCEPT:
  //     - starts with "bix" → "bix"
  //     - starts with "gg"  → "gg"
  //     - starts with digit → "number"
  //   full:   {base}{subdir}/{filename}.mp3
  function _parseMwResponse(data) {
    if (!Array.isArray(data) || data.length === 0) return null;
    if (typeof data[0] === "string") return null; // "did you mean" suggestions

    const entries = data.filter(
      (e) => e && Array.isArray(e.shortdef) && e.shortdef.length > 0
    );
    if (entries.length === 0) return null;

    // Phonetic
    let phonetic = "";
    const firstPrs = Array.isArray(entries[0]?.hwi?.prs) ? entries[0].hwi.prs : [];
    if (firstPrs.length > 0 && typeof firstPrs[0].mw === "string") {
      phonetic = firstPrs[0].mw;
    }

    // Audio URL
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
                       : "a"; // fallback: should never reach — regex guards non-empty
          // URL is safe by construction: `https://` origin is hardcoded and
          // `af` is validated to word characters + hyphens only by the regex above.
          audioUrl = `https://media.merriam-webster.com/audio/prons/en/us/mp3/${subdir}/${af}.mp3`;
        }
      }
    }

    // Definition HTML
    let html = "";
    let defsAdded = 0;
    entries.slice(0, 3).forEach((entry) => {
      const fl = typeof entry.fl === "string" ? entry.fl.trim() : "";
      // Build this entry's markup in a local variable first.  Only wrap it
      // in <div class="dict-meaning"> if at least one definition paragraph
      // was contributed — an entry whose entire shortdef array consists of
      // invalid/empty strings would otherwise produce an orphaned POS-only
      // div with no definitions, which renders visually as a floating badge.
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

  // ─── SOURCE 5: Merriam-Webster Dictionary API ──────────────────────────────
  //
  // Handles both the Collegiate and Thesaurus endpoints, which share the same
  // JSON envelope and are parsed identically by _parseMwResponse.
  //
  // type:              "collegiate" | "thesaurus" — selects endpoint, labels,
  //                    and the usage-counter key.
  // baseKey:           normalised word used as the mwAltCache key.
  // effectiveCacheKey: priority-namespaced main cache key.
  //                    Pass null on the switch path — only mwAltCache is written.
  // hasMWCollegiate / hasMWThesaurus: used to decide whether the switch button
  //   should appear.  Both default to true for the switch path (caller already
  //   proved both keys are configured before showing the button).
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

      // Write to the appropriate cache slot.
      if (effectiveCacheKey) {
        // Normal lookup path: write to main session cache AND to the alt-cache
        // so that toggling and back serves the result from mwAltCache instantly
        // without a redundant network fetch.
        cacheSet(effectiveCacheKey, cacheEntry);
        mwAltCacheSet(`mwalt:${type}:${baseKey}`, cacheEntry);
      } else {
        // Switch path: write only to mwAltCache so the next toggle is instant.
        mwAltCacheSet(`mwalt:${type}:${baseKey}`, cacheEntry);
      }

      // Update the switch button.
      _updateMwSwitchButton(type, baseKey, text, hasMWCollegiate, hasMWThesaurus);

      // Reposition only on the normal lookup path.  On the switch path
      // (effectiveCacheKey === null) the tooltip is already visible and the
      // user expects it to stay exactly where it is — repositioning would move
      // it based on the new content height, which is jarring.
      if (effectiveCacheKey && currentClientX === snapX && currentClientY === snapY) {
        positionTooltip(snapX, snapY, true);
      }

      return true;
    } catch (err) {
      if (err.name === "AbortError") throw err;
      console.warn(`[Instant Dictionary] ${apiLabel} API error:`, err);
      writeLog("error", `${apiLabel}: request failed — ${err.message ?? err}`);
      return false;
    }
  }

})();
