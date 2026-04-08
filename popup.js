"use strict";

// ─── Shared constants ─────────────────────────────────────────────────────────
// Destructured from window.SharedConstants (defined in shared_constants.js,
// loaded as the first <script> tag in popup.html).  Single source of truth
// shared with content.js — no manual sync required.
const { MW_DEFAULT_LIMIT, S4_DEFAULT_LIMIT, STORAGE_TIMEOUT_MS } = window.SharedConstants;

// ─── Constants ────────────────────────────────────────────────────────────────

// Merriam-Webster now has two separate API keys (one per product).
// KEY_MW_KEY is the legacy storage name kept here solely for backward-compat
// migration (read on load, removed on Clear All). New code always reads/writes
// KEY_MW_COLLEGIATE_KEY and KEY_MW_THESAURUS_KEY.
const KEY_MW_KEY              = "mw_key";            // legacy — migration read + cleanup only
const KEY_MW_COLLEGIATE_KEY   = "mw_collegiate_key"; // Collegiate Dictionary API key
const KEY_MW_THESAURUS_KEY    = "mw_thesaurus_key";  // Thesaurus Dictionary API key
const KEY_S4_UID              = "s4_uid";
const KEY_S4_TOKEN            = "s4_token";
const KEY_LOOKUP_PRIORITY     = "lookup_priority";
const KEY_API_USAGE           = "api_usage";
const KEY_API_MW_LIMIT        = "api_mw_limit";
const KEY_API_S4_LIMIT        = "api_s4_limit";
const KEY_EXT_LOGS            = "ext_logs";

// Keys touched by "Clear all" (API credentials + priority).
// All three MW key names are included so a user upgrading from the legacy
// single-key version gets a clean slate on Clear All.
// Usage counters and daily limits are intentionally excluded.
const STORAGE_KEYS       = Object.freeze([
  KEY_MW_KEY, KEY_MW_COLLEGIATE_KEY, KEY_MW_THESAURUS_KEY,
  KEY_S4_UID, KEY_S4_TOKEN, KEY_LOOKUP_PRIORITY,
]);
const QUOTA_STORAGE_KEYS = Object.freeze([KEY_API_USAGE, KEY_API_MW_LIMIT, KEY_API_S4_LIMIT]);

const DEFAULT_PRIORITY     = "auto";
// "free_first" removed — it was dead code once "auto" became purely public-sources-first.
// Legacy storage values of "free_first" are silently normalised to "auto" on load.
const ALLOWED_PRIORITIES   = new Set(["auto", "premium_first"]);
const ALLOWED_STATUS_TYPES = new Set(["saved", "cleared", "error"]);
const STATUS_DISPLAY_MS    = 4000;
// Provider-imposed daily request ceilings — same values as MW_DEFAULT_LIMIT /
// S4_DEFAULT_LIMIT from shared_constants.js.  Aliased here for readability at
// callsites (saveApiLimits, wireLimitInput) that treat them as hard slider maxima
// rather than user-configurable defaults.  Single source of truth: shared_constants.js.
const MW_MAX_DAILY = MW_DEFAULT_LIMIT;
const S4_MAX_DAILY = S4_DEFAULT_LIMIT;

const MW_KEY_RE   = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const S4_UID_RE   = /^\d{1,10}$/;
const S4_TOKEN_RE = /^[A-Za-z0-9]{8,100}$/;

// ─── Extension context guard ──────────────────────────────────────────────────
function isRuntimeValid() {
  try { return !!(typeof chrome !== "undefined" && chrome?.runtime?.id); }
  catch { return false; }
}

// ─── Safe string coercion ─────────────────────────────────────────────────────
function safeStr(v) {
  if (v == null) return "";
  return typeof v === "string" ? v : String(v);
}

// ─── SVG eye icon helpers ─────────────────────────────────────────────────────
function createEyeSvg(isOpen) {
  const NS  = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox",         "0 0 24 24");
  svg.setAttribute("width",           "15");
  svg.setAttribute("height",          "15");
  svg.setAttribute("fill",            "none");
  svg.setAttribute("stroke",          "currentColor");
  svg.setAttribute("stroke-width",    "2");
  svg.setAttribute("stroke-linecap",  "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden",     "true");

  if (isOpen) {
    const outline = document.createElementNS(NS, "path");
    outline.setAttribute("d", "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z");
    const pupil = document.createElementNS(NS, "circle");
    pupil.setAttribute("cx", "12");
    pupil.setAttribute("cy", "12");
    pupil.setAttribute("r",  "3");
    svg.append(outline, pupil);
  } else {
    const outline = document.createElementNS(NS, "path");
    outline.setAttribute("d",
      "M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8" +
      "a18.45 18.45 0 0 1 5.06-5.94" +
      "M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8" +
      "a18.5 18.5 0 0 1-2.16 3.19" +
      "m-6.72-1.07a3 3 0 1 1-4.24-4.24"
    );
    const slash = document.createElementNS(NS, "line");
    slash.setAttribute("x1", "1");  slash.setAttribute("y1", "1");
    slash.setAttribute("x2", "23"); slash.setAttribute("y2", "23");
    svg.append(outline, slash);
  }
  return svg;
}

function setEyeIcon(btn, isOpen) { btn.replaceChildren(createEyeSvg(isOpen)); }

// ─── DOM references ───────────────────────────────────────────────────────────
function requireEl(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`[Instant Dictionary] Missing required element: #${id}`);
  return el;
}

// ── Critical elements — throw if absent ──────────────────────────────────────
let elMwCollegiateKey, elMwThesaurusKey, elS4Uid, elS4Token, btnSave, btnClear, elStatus;
let elMwCollegiateKeyMsg, elMwThesaurusKeyMsg, elS4UidMsg, elS4TokenMsg;
// Settings view
let viewMain, viewSettings, btnOpenSettings, btnBack;
let btnSaveSettings, elSettingsStatus;
let btnClearLogs;

try {
  // Main view
  viewMain               = requireEl("view-main");
  viewSettings           = requireEl("view-settings");
  elMwCollegiateKey      = requireEl("mw-collegiate-key");
  elMwThesaurusKey       = requireEl("mw-thesaurus-key");
  elS4Uid                = requireEl("s4-uid");
  elS4Token              = requireEl("s4-token");
  btnSave                = requireEl("btn-save");
  btnClear               = requireEl("btn-clear");
  elStatus               = requireEl("popup-status");
  elMwCollegiateKeyMsg   = requireEl("mw-collegiate-key-msg");
  elMwThesaurusKeyMsg    = requireEl("mw-thesaurus-key-msg");
  elS4UidMsg             = requireEl("s4-uid-msg");
  elS4TokenMsg           = requireEl("s4-token-msg");
  btnOpenSettings        = requireEl("btn-open-settings");
  btnBack                = requireEl("btn-back");
  // Settings view
  btnSaveSettings        = requireEl("btn-save-settings");
  elSettingsStatus       = requireEl("settings-status");
  btnClearLogs           = requireEl("btn-clear-logs");
} catch (err) {
  console.error(err.message);
  const fallback = document.getElementById("popup-status");
  if (fallback) {
    fallback.textContent = "UI failed to initialise. Try reinstalling the extension.";
    fallback.className   = "popup-status error visible";
  }
  throw err;
}

// ── Non-fatal elements (usage panel, logs) ────────────────────────────────────
let elMwCount, elMwLimit, elMwBar, elMwLimitInput, elMwLimitDisplay, elMwLimitCap;
let elS4Count, elS4Limit, elS4Bar, elS4LimitInput, elS4LimitDisplay, elS4LimitCap;
let btnResetUsage, elLogsList;

elMwCount        = document.getElementById("usage-mw-count");
elMwLimit        = document.getElementById("usage-mw-limit");
elMwBar          = document.getElementById("usage-mw-bar");
elMwLimitInput   = document.getElementById("usage-mw-limit-input");
elMwLimitDisplay = document.getElementById("usage-mw-limit-display");
elMwLimitCap     = document.getElementById("usage-mw-limit-cap");
elS4Count        = document.getElementById("usage-s4-count");
elS4Limit        = document.getElementById("usage-s4-limit");
elS4Bar          = document.getElementById("usage-s4-bar");
elS4LimitInput   = document.getElementById("usage-s4-limit-input");
elS4LimitDisplay = document.getElementById("usage-s4-limit-display");
elS4LimitCap     = document.getElementById("usage-s4-limit-cap");
btnResetUsage    = document.getElementById("btn-reset-usage");
elLogsList       = document.getElementById("logs-list");
// ─── View navigation ──────────────────────────────────────────────────────────

function openSettingsView() {
  viewMain.hidden     = true;
  viewSettings.hidden = false;
  // Always reset to Lookup tab and scroll to top on entry
  activateSettingsTab("lookup");
  if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
  btnBack.focus();
}

function closeSettingsView() {
  viewSettings.hidden = true;
  viewMain.hidden     = false;
  if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
  btnOpenSettings.focus();
}

btnOpenSettings.addEventListener("click", openSettingsView);
btnBack.addEventListener("click", closeSettingsView);

// ─── Settings tab switching ───────────────────────────────────────────────────
const settingsTabButtons = Array.from(
  document.querySelectorAll(".popup-tab[data-stab]")
);

function activateSettingsTab(stabId) {
  settingsTabButtons.forEach((btn) => {
    const isTarget = btn.dataset.stab === stabId;
    btn.classList.toggle("is-active", isTarget);
    btn.setAttribute("aria-selected", String(isTarget));
    btn.setAttribute("tabindex", isTarget ? "0" : "-1");
  });

  document.querySelectorAll("[id^='spanel-']").forEach((panel) => {
    const isTarget = panel.id === `spanel-${stabId}`;
    if (isTarget) panel.removeAttribute("hidden");
    else          panel.setAttribute("hidden", "");
  });

  // Refresh on-demand panels
  if (stabId === "usage") loadUsagePanel();
  if (stabId === "logs")  loadLogsPanel();

  // Show or hide the Save button: logs tab has no saveable state
  updateSettingsSaveButton(stabId);
}

settingsTabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.stab) activateSettingsTab(btn.dataset.stab);
  });
});

// Arrow-key / Home / End keyboard navigation on settings tabs
const settingsTabBar = document.querySelector("#view-settings .popup-tabs");
if (settingsTabBar) {
  settingsTabBar.addEventListener("keydown", (e) => {
    const focused = document.activeElement;
    const idx     = settingsTabButtons.indexOf(focused);
    if (idx === -1) return;

    let next = -1;
    if      (e.key === "ArrowRight") next = (idx + 1) % settingsTabButtons.length;
    else if (e.key === "ArrowLeft")  next = (idx - 1 + settingsTabButtons.length) % settingsTabButtons.length;
    else if (e.key === "Home")       next = 0;
    else if (e.key === "End")        next = settingsTabButtons.length - 1;
    else return;

    e.preventDefault();
    const target = settingsTabButtons[next];
    if (target?.dataset.stab) {
      activateSettingsTab(target.dataset.stab);
      target.focus();
    }
  });
}

/** Show or hide the Save Settings button depending on active tab context.
 *  - Lookup tab: Save saves the priority → show button
 *  - Usage  tab: Save saves limits       → show button
 *  - Logs   tab: nothing to save         → hide button (panel has its own Clear Logs btn)
 */
function updateSettingsSaveButton(stabId) {
  if (stabId === "logs") {
    btnSaveSettings.style.display = "none";
  } else {
    btnSaveSettings.style.display = "";
    btnSaveSettings.textContent =
      stabId === "usage" ? "Save Limits" : "Save Priority";
  }
}

// Initialise on first open (Lookup tab is the default)
updateSettingsSaveButton("lookup");

// ─── Status bars ─────────────────────────────────────────────────────────────
// Two independent status bars: one per view. Each manages its own timers.

function _showStatus(elSt, timers, msg, type) {
  const safeType = ALLOWED_STATUS_TYPES.has(type) ? type : "error";
  clearTimeout(timers.display);
  clearTimeout(timers.clear);

  elSt.textContent = String(msg).slice(0, 200);
  elSt.className   = `popup-status ${safeType} visible`;

  timers.display = setTimeout(() => {
    timers.display = null;
    elSt.className = "popup-status";
    timers.clear   = setTimeout(() => {
      timers.clear     = null;
      elSt.textContent = "";
    }, 200);
  }, STATUS_DISPLAY_MS);
}

const _mainTimers = { display: null, clear: null };
const _settTimers = { display: null, clear: null };

function showStatus(msg, type)         { _showStatus(elStatus,         _mainTimers, msg, type); }
function showSettingsStatus(msg, type) { _showStatus(elSettingsStatus, _settTimers, msg, type); }

// ─── Inline field validation ──────────────────────────────────────────────────
function setFieldState(input, msgEl, state, text = "") {
  input.classList.remove("is-ok", "is-error");
  msgEl.className   = "popup-field-msg";
  msgEl.textContent = text;

  if (state === "ok") {
    input.classList.add("is-ok");
    msgEl.classList.add("ok");
    input.setAttribute("aria-invalid", "false");
  } else if (state === "error") {
    input.classList.add("is-error");
    msgEl.classList.add("error");
    input.setAttribute("aria-invalid", "true");
  } else {
    input.removeAttribute("aria-invalid");
  }
}

function clearAllFieldStates() {
  setFieldState(elMwCollegiateKey, elMwCollegiateKeyMsg, "");
  setFieldState(elMwThesaurusKey,  elMwThesaurusKeyMsg,  "");
  setFieldState(elS4Uid,           elS4UidMsg,           "");
  setFieldState(elS4Token,         elS4TokenMsg,         "");
}

// ─── Debounce ─────────────────────────────────────────────────────────────────
function debounce(fn, ms) {
  let timer = null;
  function debounced(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, ms);
  }
  debounced.cancel = () => { clearTimeout(timer); timer = null; };
  return debounced;
}

// ─── Dirty field tracking ─────────────────────────────────────────────────────
const dirtyFields = new Set();
function markDirty(field) { dirtyFields.add(field); }

// ─── MW key validator ─────────────────────────────────────────────────────────
//
// Each MW field is validated individually for UUID format.  When both fields
// contain a value and that value is identical, we also show a warning because
// submitting the same key in both fields is almost certainly a copy-paste
// mistake (MW issues two distinct UUIDs — one per API product).
//
// Returns true when the field is either empty or passes all checks, false when
// there is a hard format error.  A same-key error is blocking (returns false)
// because submitting identical UUIDs in both MW slots is almost certainly a
// mistake that would silently break one of the two API products.
function validateMwKey(inputEl, msgEl, interactive = false) {
  const val = inputEl.value.trim();
  if (!val) {
    setFieldState(inputEl, msgEl, "");
    // If the other MW field is currently showing a duplicate-UUID error, that
    // error is now stale (the duplicate condition no longer holds because this
    // field is empty). Re-validate it immediately so the user isn't left staring
    // at a red field they no longer need to fix.
    if (interactive) {
      const otherInput = inputEl === elMwCollegiateKey ? elMwThesaurusKey    : elMwCollegiateKey;
      const otherMsg   = inputEl === elMwCollegiateKey ? elMwThesaurusKeyMsg : elMwCollegiateKeyMsg;
      if (otherInput.classList.contains("is-error")) {
        validateMwKey(otherInput, otherMsg, true);
      }
    }
    return true;
  }

  if (!MW_KEY_RE.test(val)) {
    if (interactive) {
      setFieldState(inputEl, msgEl, "error", "Should be a UUID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx");
    }
    return false;
  }

  // Check for duplicate across both MW fields (blocking — identical keys in both slots is almost certainly a copy-paste mistake).
  const collegiateVal = elMwCollegiateKey.value.trim();
  const thesaurusVal  = elMwThesaurusKey.value.trim();
  if (
    interactive &&
    collegiateVal && thesaurusVal &&
    MW_KEY_RE.test(collegiateVal) && MW_KEY_RE.test(thesaurusVal) &&
    collegiateVal.toLowerCase() === thesaurusVal.toLowerCase()
  ) {
    // Both fields valid but identical — warn on both.
    const dupMsg = "This looks like the same key as the other MW field — MW issues separate UUIDs for each API";
    setFieldState(elMwCollegiateKey, elMwCollegiateKeyMsg, "error", dupMsg);
    setFieldState(elMwThesaurusKey,  elMwThesaurusKeyMsg,  "error", dupMsg);
    return false; // treat duplicate as a blocking error
  }

  if (interactive) {
    setFieldState(inputEl, msgEl, "ok", "Looks good");
  }
  return true;
}

function validateMwCollegiate(interactive = false) {
  return validateMwKey(elMwCollegiateKey, elMwCollegiateKeyMsg, interactive);
}

function validateMwThesaurus(interactive = false) {
  return validateMwKey(elMwThesaurusKey, elMwThesaurusKeyMsg, interactive);
}

function validateS4Pair(interactive = false) {
  const uid   = elS4Uid.value.trim();
  const token = elS4Token.value.trim();

  if (uid && token) {
    let uidOk = true, tokenOk = true;
    if (!S4_UID_RE.test(uid)) {
      if (interactive) setFieldState(elS4Uid, elS4UidMsg, "error", "User ID must be a numeric value");
      uidOk = false;
    } else if (interactive) {
      setFieldState(elS4Uid, elS4UidMsg, "ok", "Looks good");
    }
    if (!S4_TOKEN_RE.test(token)) {
      if (interactive) setFieldState(elS4Token, elS4TokenMsg, "error", "Token should be 8\u2013100 alphanumeric characters");
      tokenOk = false;
    } else if (interactive) {
      setFieldState(elS4Token, elS4TokenMsg, "ok", "Looks good");
    }
    return uidOk && tokenOk;
  }

  if (uid && !token) {
    if (interactive) {
      if (!S4_UID_RE.test(uid)) {
        setFieldState(elS4Uid, elS4UidMsg, "error", "User ID must be a numeric value");
      } else {
        setFieldState(elS4Uid, elS4UidMsg, "");
      }
      if (dirtyFields.has(elS4Token)) {
        setFieldState(elS4Token, elS4TokenMsg, "error", "Token is required when a User ID is entered");
      } else {
        setFieldState(elS4Token, elS4TokenMsg, "");
      }
    }
    return false;
  }

  if (!uid && token) {
    if (interactive) {
      if (!S4_TOKEN_RE.test(token)) {
        setFieldState(elS4Token, elS4TokenMsg, "error", "Token should be 8\u2013100 alphanumeric characters");
      } else {
        setFieldState(elS4Token, elS4TokenMsg, "");
      }
      if (dirtyFields.has(elS4Uid)) {
        setFieldState(elS4Uid, elS4UidMsg, "error", "User ID is required when a Token is entered");
      } else {
        setFieldState(elS4Uid, elS4UidMsg, "");
      }
    }
    return false;
  }

  setFieldState(elS4Uid,   elS4UidMsg,   "");
  setFieldState(elS4Token, elS4TokenMsg, "");
  return true;
}

// ─── Debounced validators ─────────────────────────────────────────────────────
const debouncedMwCollegiateValidate = debounce(() => {
  if (dirtyFields.has(elMwCollegiateKey)) validateMwCollegiate(true);
}, 350);

const debouncedMwThesaurusValidate = debounce(() => {
  if (dirtyFields.has(elMwThesaurusKey)) validateMwThesaurus(true);
}, 350);

const debouncedS4Validate = debounce(() => {
  if (dirtyFields.has(elS4Uid) || dirtyFields.has(elS4Token)) validateS4Pair(true);
}, 350);

// ── MW Collegiate key listeners ───────────────────────────────────────────────
elMwCollegiateKey.addEventListener("input", debouncedMwCollegiateValidate);
elMwCollegiateKey.addEventListener("blur", () => {
  debouncedMwCollegiateValidate.cancel();
  markDirty(elMwCollegiateKey);
  validateMwCollegiate(true);
});

// ── MW Thesaurus key listeners ────────────────────────────────────────────────
elMwThesaurusKey.addEventListener("input", debouncedMwThesaurusValidate);
elMwThesaurusKey.addEventListener("blur", () => {
  debouncedMwThesaurusValidate.cancel();
  markDirty(elMwThesaurusKey);
  validateMwThesaurus(true);
});

// ── S4 uid listeners ──────────────────────────────────────────────────────────
elS4Uid.addEventListener("input", debouncedS4Validate);
elS4Uid.addEventListener("blur", () => {
  debouncedS4Validate.cancel();
  markDirty(elS4Uid);
  validateS4Pair(true);
});

// ── S4 token listeners ────────────────────────────────────────────────────────
elS4Token.addEventListener("input", debouncedS4Validate);
elS4Token.addEventListener("blur", () => {
  debouncedS4Validate.cancel();
  markDirty(elS4Token);
  validateS4Pair(true);
});

// ─── Paste-trim handlers ──────────────────────────────────────────────────────
function makePasteTrimHandler(inputEl) {
  return (e) => {
    e.preventDefault();
    const raw     = e.clipboardData?.getData("text") ?? "";
    const trimmed = raw.trim();
    if (!trimmed) return;
    const { value } = inputEl;
    // selectionStart/End are null for non-text inputs and in some browsers
    // when the field is not focused.  Default to end-of-value in both cases
    // so the paste always inserts at the end rather than position 0.
    const s   = typeof inputEl.selectionStart === "number" ? inputEl.selectionStart : value.length;
    const end = typeof inputEl.selectionEnd   === "number" ? inputEl.selectionEnd   : value.length;
    inputEl.value = value.slice(0, s) + trimmed + value.slice(end);
    const cursor  = s + trimmed.length;
    try { inputEl.setSelectionRange(cursor, cursor); } catch { /* non-text type */ }
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
  };
}

elMwCollegiateKey.addEventListener("paste", makePasteTrimHandler(elMwCollegiateKey));
elMwThesaurusKey.addEventListener("paste",  makePasteTrimHandler(elMwThesaurusKey));
elS4Uid.addEventListener("paste",           makePasteTrimHandler(elS4Uid));
elS4Token.addEventListener("paste",         makePasteTrimHandler(elS4Token));

// ─── Button lock / unlock helpers ─────────────────────────────────────────────
//
// ── Race / stale-callback prevention ─────────────────────────────────────────
// The original shared safetyTimer + safetyFired pair was corrupted when two
// operations overlapped: a Save safety timer firing would set safetyFired=true,
// then a subsequent Clear's lockButtons() reset it to false, and the stale Save
// callback would see safetyFired===false and write its results over the in-
// progress Clear — silent data corruption.
//
// Fix: a monotonically-increasing generation counter.  lockButtons() stamps the
// current operation with a ticket (the generation value at call time).  Every
// callback — both the storage callback and the safety timer — compares its
// captured ticket against _currentOpGen before proceeding.  If a newer operation
// has started, the ticket is stale and the callback is silently discarded.
// Completing an operation (success or error) also bumps _currentOpGen so the
// safety timer can never fire spuriously after the callback already finished.
//
// _opSafetyTimer holds the ID of the currently active safety timer so it can
// be cancelled explicitly when an operation completes.  Without this, the timer
// fires on every completed operation, does the generation-counter comparison,
// and silently returns — harmless but wasteful, and the IDs accumulate across
// the popup lifetime.  lockButtons() cancels any prior timer before arming a
// new one so overlapping calls (e.g. rapid Save → Clear) never leave a stale
// timer running alongside a live one.
let _currentOpGen  = 0;
let _opSafetyTimer = null;

function _cancelOpSafetyTimer() {
  clearTimeout(_opSafetyTimer);
  _opSafetyTimer = null;
}

function lockButtons() {
  _cancelOpSafetyTimer(); // discard any timer from a superseded operation
  const ticket = ++_currentOpGen;
  btnSave.disabled  = true;
  btnClear.disabled = true;
  _opSafetyTimer = setTimeout(() => {
    _opSafetyTimer = null;
    if (_currentOpGen !== ticket) return; // op completed or was superseded
    ++_currentOpGen;                       // invalidate any stale late-arriving callback
    unlockButtons();
    showStatus("Request timed out. Please reopen the popup.", "error");
  }, STORAGE_TIMEOUT_MS);
  return ticket;
}

function unlockButtons() {
  btnSave.disabled  = false;
  btnClear.disabled = false;
}

// ─── Settings-view button lock / unlock helpers ───────────────────────────────
//
// Mirrors the _currentOpGen pattern used for the main-view buttons so that
// the safety timer and the storage callback can never both take effect when a
// storage operation completes near the STORAGE_TIMEOUT_MS boundary.
// Without this, a late-arriving callback would re-enable the button and show
// a success status on top of the already-visible timeout-error message.
let _settingsOpGen   = 0;
let _settingsOpTimer = null;

function _cancelSettingsOpTimer() {
  clearTimeout(_settingsOpTimer);
  _settingsOpTimer = null;
}

function _lockSettingsBtn() {
  _cancelSettingsOpTimer(); // discard any timer from a superseded operation
  const ticket = ++_settingsOpGen;
  btnSaveSettings.disabled = true;
  _settingsOpTimer = setTimeout(() => {
    _settingsOpTimer = null;
    if (_settingsOpGen !== ticket) return; // op completed or was superseded
    ++_settingsOpGen;                       // invalidate any stale late-arriving callback
    btnSaveSettings.disabled = false;
    showSettingsStatus("Request timed out. Please reopen the popup.", "error");
  }, STORAGE_TIMEOUT_MS);
  return ticket;
}

function _unlockSettingsBtn() {
  btnSaveSettings.disabled = false;
}

// ─── Full validation (for Save in main view) ──────────────────────────────────
function validateAll() {
  [elMwCollegiateKey, elMwThesaurusKey, elS4Uid, elS4Token].forEach((f) => dirtyFields.add(f));
  const mwCollegiateOk = validateMwCollegiate(true);
  const mwThesaurusOk  = validateMwThesaurus(true);
  const s4Ok           = validateS4Pair(true);

  const valid    = mwCollegiateOk && mwThesaurusOk && s4Ok;
  const errorMsg = !valid ? "Please fix the highlighted errors." : "";
  const firstErrorEl = [elMwCollegiateKey, elMwThesaurusKey, elS4Uid, elS4Token].find(
    (el) => el.classList.contains("is-error")
  ) ?? null;

  return { valid, errorMsg, firstErrorEl };
}

// ─── Save API Keys (main view) ────────────────────────────────────────────────
// Saves mwCollegiateKey, mwThesaurusKey, s4Uid, s4Token ONLY.
// Lookup priority is now saved independently via the Settings view.
function handleSave() {
  if (!isRuntimeValid()) { showStatus("Extension context lost. Please reopen the popup.", "error"); return; }

  const { valid, errorMsg, firstErrorEl } = validateAll();
  if (!valid) {
    if (firstErrorEl) firstErrorEl.focus();
    showStatus(errorMsg, "error");
    return;
  }

  const mwCollegiateKey = elMwCollegiateKey.value.trim();
  const mwThesaurusKey  = elMwThesaurusKey.value.trim();
  const s4Uid           = elS4Uid.value.trim();
  const s4Token         = elS4Token.value.trim();

  const ticket = lockButtons();

  chrome.storage.local.set(
    {
      [KEY_MW_COLLEGIATE_KEY]: mwCollegiateKey,
      [KEY_MW_THESAURUS_KEY]:  mwThesaurusKey,
      [KEY_S4_UID]:            s4Uid,
      [KEY_S4_TOKEN]:          s4Token,
    },
    () => {
      try {
        if (_currentOpGen !== ticket) return; // stale — superseded by a later op
        _cancelOpSafetyTimer();                // cancel the now-redundant safety timer
        ++_currentOpGen;                       // invalidate any stale late-arriving ref
        unlockButtons();
        if (chrome.runtime.lastError) {
          showStatus("Error saving settings. Please try again.", "error");
          return;
        }

        // Contextual feedback: describe which premium keys are now active.
        const parts = [];
        if (mwCollegiateKey && mwThesaurusKey) {
          parts.push("Merriam-Webster (Collegiate + Thesaurus)");
        } else if (mwCollegiateKey) {
          parts.push("Merriam-Webster Collegiate");
        } else if (mwThesaurusKey) {
          parts.push("Merriam-Webster Thesaurus");
        }
        if (s4Uid && s4Token) parts.push("STANDS4");

        showStatus(
          parts.length > 0
            ? `\u2713 Saved \u2014 ${parts.join(" & ")} enabled`
            : "\u2713 Saved \u2014 operating with public sources only",
          "saved"
        );
      } catch (err) {
        if (_currentOpGen === ticket) { _cancelOpSafetyTimer(); ++_currentOpGen; unlockButtons(); }
        console.error("[Instant Dictionary] Save callback error:", err);
        showStatus("Unexpected error while saving. Please try again.", "error");
      }
    }
  );
}

btnSave.addEventListener("click", handleSave);

// ─── Clear all ────────────────────────────────────────────────────────────────
function handleClear() {
  if (!isRuntimeValid()) { showStatus("Extension context lost. Please reopen the popup.", "error"); return; }

  const ticket = lockButtons();

  chrome.storage.local.remove(STORAGE_KEYS, () => {
    try {
      if (_currentOpGen !== ticket) return; // stale — superseded by a later op
      _cancelOpSafetyTimer();                // cancel the now-redundant safety timer
      ++_currentOpGen;                       // invalidate any stale late-arriving ref
      unlockButtons();
      if (chrome.runtime.lastError) {
        showStatus("Error clearing settings. Please try again.", "error");
        return;
      }

      elMwCollegiateKey.value = elMwThesaurusKey.value = elS4Uid.value = elS4Token.value = "";
      clearAllFieldStates();
      dirtyFields.clear();

      document.querySelectorAll(".popup-eye-btn").forEach((btn) => {
        const input = document.getElementById(btn.getAttribute("data-target"));
        if (input) input.type = "password";
        setEyeIcon(btn, false);
        btn.setAttribute("aria-label", btn.dataset.labelShow || "Show");
      });

      // Reset radio to default (Standard)
      const defaultRadio = document.querySelector(
        `input[name="priority"][value="${CSS.escape(DEFAULT_PRIORITY)}"]`
      );
      if (defaultRadio) defaultRadio.checked = true;

      showStatus("Cleared \u2014 Standard mode active", "cleared");
    } catch (err) {
      if (_currentOpGen === ticket) { _cancelOpSafetyTimer(); ++_currentOpGen; unlockButtons(); }
      console.error("[Instant Dictionary] Clear callback error:", err);
      showStatus("Unexpected error while clearing. Please try again.", "error");
    }
  });
}

btnClear.addEventListener("click", handleClear);

// ─── Save Settings (settings view) ───────────────────────────────────────────
// Context-aware: saves priority (Lookup tab) or limits (Usage tab).
function handleSaveSettings() {
  if (!isRuntimeValid()) {
    showSettingsStatus("Extension context lost. Please reopen the popup.", "error");
    return;
  }

  const activeStab = settingsTabButtons.find(
    (btn) => btn.classList.contains("is-active")
  )?.dataset.stab ?? "lookup";

  if (activeStab === "lookup") {
    // ── Save lookup priority ──────────────────────────────────────────────────
    const selectedRadio = document.querySelector('input[name="priority"]:checked');
    let priority = selectedRadio?.value ?? DEFAULT_PRIORITY;
    // Normalise any legacy value not in ALLOWED_PRIORITIES
    if (!ALLOWED_PRIORITIES.has(priority)) priority = DEFAULT_PRIORITY;

    const ticket = _lockSettingsBtn();
    chrome.storage.local.set({ [KEY_LOOKUP_PRIORITY]: priority }, () => {
      try {
        if (_settingsOpGen !== ticket) return; // stale — superseded by later op
        _cancelSettingsOpTimer();
        ++_settingsOpGen;
        _unlockSettingsBtn();
        if (chrome.runtime.lastError) {
          showSettingsStatus("Error saving priority. Please try again.", "error");
          return;
        }
        const LABELS = { auto: "Standard (Recommended)", premium_first: "Enhanced" };
        showSettingsStatus(
          `\u2713 Saved \u2014 ${LABELS[priority] ?? priority}`,
          "saved"
        );
      } catch (err) {
        if (_settingsOpGen === ticket) { _cancelSettingsOpTimer(); ++_settingsOpGen; _unlockSettingsBtn(); }
        console.error("[Instant Dictionary] Save priority callback error:", err);
        showSettingsStatus("Unexpected error while saving. Please try again.", "error");
      }
    });

  } else if (activeStab === "usage") {
    // ── Save daily limits ─────────────────────────────────────────────────────
    saveApiLimits();
  } else {
    // "logs" tab hides the button via updateSettingsSaveButton(); reaching here
    // would require a programmatic call with an unrecognised stab value.
    console.warn("[Instant Dictionary] handleSaveSettings: unrecognised tab:", activeStab);
  }
}

btnSaveSettings.addEventListener("click", handleSaveSettings);

// ─── Usage panel logic ────────────────────────────────────────────────────────
function updateUsageBar(bar, count, limit) {
  if (!bar) return;
  const pct = limit > 0 ? Math.min(100, (count / limit) * 100) : 0;
  bar.style.width = `${pct}%`;
  bar.classList.remove("usage-bar-ok", "usage-bar-warn", "usage-bar-full");
  if (pct >= 100)     bar.classList.add("usage-bar-full");
  else if (pct >= 75) bar.classList.add("usage-bar-warn");
  else                bar.classList.add("usage-bar-ok");
  bar.parentElement?.setAttribute("aria-valuenow", String(Math.round(pct)));
}

function loadUsagePanel() {
  if (!isRuntimeValid()) return;

  chrome.storage.local.get(QUOTA_STORAGE_KEYS, (result) => {
    if (chrome.runtime.lastError) return;

    try {
      const today    = new Date().toISOString().slice(0, 10);
      const usageRaw = result[KEY_API_USAGE];
      const usage    = (usageRaw && typeof usageRaw === "object" && usageRaw.date === today)
        ? usageRaw
        : { date: today, mw_count: 0, mw_thesaurus_count: 0, s4_count: 0 };

      const mwCollegiateCount = typeof usage.mw_count           === "number" ? usage.mw_count           : 0;
      const mwThesaurusCount  = typeof usage.mw_thesaurus_count === "number" ? usage.mw_thesaurus_count : 0;
      const mwCount = mwCollegiateCount + mwThesaurusCount;
      const s4Count = typeof usage.s4_count === "number" ? usage.s4_count : 0;
      const mwLimit = typeof result[KEY_API_MW_LIMIT] === "number" ? result[KEY_API_MW_LIMIT] : MW_DEFAULT_LIMIT;
      const s4Limit = typeof result[KEY_API_S4_LIMIT] === "number" ? result[KEY_API_S4_LIMIT] : S4_DEFAULT_LIMIT;

      if (elMwCount) elMwCount.textContent = String(mwCount);
      if (elMwLimit) elMwLimit.textContent = String(mwLimit);
      if (elS4Count) elS4Count.textContent = String(s4Count);
      if (elS4Limit) elS4Limit.textContent = String(s4Limit);

      updateUsageBar(elMwBar, mwCount, mwLimit);
      updateUsageBar(elS4Bar, s4Count, s4Limit);

      if (elMwLimitInput && document.activeElement !== elMwLimitInput) {
        elMwLimitInput.value = String(mwLimit);
      }
      if (elMwLimitDisplay) elMwLimitDisplay.textContent = String(mwLimit);
      if (elS4LimitInput && document.activeElement !== elS4LimitInput) {
        elS4LimitInput.value = String(s4Limit);
      }
      if (elS4LimitDisplay) elS4LimitDisplay.textContent = String(s4Limit);
    } catch (err) {
      console.error("[Instant Dictionary] loadUsagePanel render error:", err);
    }
  });
}

function saveApiLimits() {
  if (!isRuntimeValid()) {
    showSettingsStatus("Extension context lost. Please reopen the popup.", "error");
    return;
  }

  const rawMw = elMwLimitInput ? parseInt(elMwLimitInput.value, 10) : MW_DEFAULT_LIMIT;
  const rawS4 = elS4LimitInput ? parseInt(elS4LimitInput.value, 10) : S4_DEFAULT_LIMIT;

  const mwLimit = Number.isFinite(rawMw) ? Math.min(MW_MAX_DAILY, Math.max(1, rawMw)) : MW_DEFAULT_LIMIT;
  const s4Limit = Number.isFinite(rawS4) ? Math.min(S4_MAX_DAILY, Math.max(1, rawS4)) : S4_DEFAULT_LIMIT;

  if (elMwLimitInput)   elMwLimitInput.value  = String(mwLimit);
  if (elMwLimitDisplay) elMwLimitDisplay.textContent = String(mwLimit);
  if (elS4LimitInput)   elS4LimitInput.value  = String(s4Limit);
  if (elS4LimitDisplay) elS4LimitDisplay.textContent = String(s4Limit);

  const ticket = _lockSettingsBtn();
  chrome.storage.local.set({ [KEY_API_MW_LIMIT]: mwLimit, [KEY_API_S4_LIMIT]: s4Limit }, () => {
    try {
      if (_settingsOpGen !== ticket) return; // stale — superseded by later op
      _cancelSettingsOpTimer();
      ++_settingsOpGen;
      _unlockSettingsBtn();
      if (chrome.runtime.lastError) {
        showSettingsStatus("Error saving limits. Please try again.", "error");
        return;
      }
      loadUsagePanel();
      showSettingsStatus("\u2713 Daily limits saved", "saved");
    } catch (err) {
      if (_settingsOpGen === ticket) { _cancelSettingsOpTimer(); ++_settingsOpGen; _unlockSettingsBtn(); }
      console.error("[Instant Dictionary] Save limits callback error:", err);
      showSettingsStatus("Unexpected error while saving. Please try again.", "error");
    }
  });
}

// ─── Limit input wiring ────────────────────────────────────────────────────────
function wireLimitInput(rangeEl, displayEl, maxVal, capEl) {
  if (!rangeEl) return;
  rangeEl.min  = "1";
  rangeEl.max  = String(maxVal);
  rangeEl.step = "1";
  // Drive the "(max N)" label from the constant so it always matches the slider
  // ceiling even if SharedConstants is updated and the HTML attribute is not.
  if (capEl) capEl.textContent = `(max\u00a0${maxVal})`;
  rangeEl.addEventListener("input", () => {
    const v = parseInt(rangeEl.value, 10);
    if (displayEl && Number.isFinite(v)) displayEl.textContent = String(v);
  });
  // Auto-save on slider change (immediate UX feedback)
  rangeEl.addEventListener("change", saveApiLimits);
}

wireLimitInput(elMwLimitInput, elMwLimitDisplay, MW_MAX_DAILY, elMwLimitCap);
wireLimitInput(elS4LimitInput, elS4LimitDisplay, S4_MAX_DAILY, elS4LimitCap);

// ─── Auxiliary settings-view operation guards ─────────────────────────────────
//
// Mirrors the _currentOpGen / _settingsOpGen pattern used for the main-view and
// settings Save/Clear buttons.  Without a generation counter, if the storage
// callback and the safety timer fire at the same instant (possible when the
// extension context degrades near the STORAGE_TIMEOUT_MS boundary), both
// execute: the callback re-enables the button and shows success, then the timer
// fires and overwrites it with a timeout-error message (or vice versa).
//
// Each independent button gets its own counter so concurrent operations on
// different buttons never invalidate each other.
let _resetUsageOpGen = 0;
let _clearLogsOpGen  = 0;

// Reset usage counters
if (btnResetUsage) {
  btnResetUsage.addEventListener("click", () => {
    if (!isRuntimeValid()) {
      showSettingsStatus("Extension context lost. Please reopen the popup.", "error");
      return;
    }
    btnResetUsage.disabled = true;
    const ticket = ++_resetUsageOpGen;

    // Safety timer: re-enable button if the storage callback never fires.
    // Generation counter ensures the timer and the callback never both take
    // effect — whichever arrives first stamps the generation and the other
    // silently becomes a no-op.
    const _resetUsageSafetyTimer = setTimeout(() => {
      if (_resetUsageOpGen !== ticket) return; // op completed or was superseded
      ++_resetUsageOpGen;
      btnResetUsage.disabled = false;
      showSettingsStatus("Request timed out. Please reopen the popup.", "error");
    }, STORAGE_TIMEOUT_MS);

    const today = new Date().toISOString().slice(0, 10);
    chrome.storage.local.set(
      { [KEY_API_USAGE]: { date: today, mw_count: 0, mw_thesaurus_count: 0, s4_count: 0 } },
      () => {
        if (_resetUsageOpGen !== ticket) return; // stale — superseded
        clearTimeout(_resetUsageSafetyTimer);
        ++_resetUsageOpGen;
        try {
          btnResetUsage.disabled = false;
          if (chrome.runtime.lastError) {
            showSettingsStatus("Error resetting counters.", "error");
            return;
          }
          loadUsagePanel();
          showSettingsStatus("Usage counters reset", "cleared");
        } catch (err) {
          btnResetUsage.disabled = false;
          console.error("[Instant Dictionary] Reset usage callback error:", err);
          showSettingsStatus("Unexpected error while resetting. Please try again.", "error");
        }
      }
    );
  });
}

// ─── Logs panel ───────────────────────────────────────────────────────────────

/** Format an ISO timestamp string to a readable local HH:MM:SS. */
function formatLogTs(iso) {
  try {
    const d = new Date(iso);
    // new Date("invalid") does NOT throw — it silently returns an Invalid Date
    // whose time-part methods return NaN.  Check explicitly before formatting.
    if (isNaN(d.getTime())) return "??:??:??";
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch {
    return "??:??:??";
  }
}

/** Truncates a log message string to a safe display length.
 *  textContent is used at the callsite so no HTML escaping is required. */
function truncateForDisplay(str) {
  return String(str).slice(0, 500);
}

/** Render a single log entry object into a DOM node. */
function renderLogEntry(entry) {
  const level = (entry.level === "warn" || entry.level === "error") ? entry.level : "info";
  const row   = document.createElement("div");
  row.className = `log-entry log-entry-${level}`;
  row.setAttribute("role", "listitem");

  const ts = document.createElement("span");
  ts.className   = "log-ts";
  ts.textContent = formatLogTs(entry.ts);

  const lv = document.createElement("span");
  lv.className   = "log-level";
  lv.textContent = level.toUpperCase();

  const msg = document.createElement("span");
  msg.className   = "log-msg";
  msg.textContent = truncateForDisplay(entry.msg);

  row.append(ts, lv, msg);
  return row;
}

/** Load and render all stored logs into the Logs panel. */
function loadLogsPanel() {
  if (!elLogsList) return;
  if (!isRuntimeValid()) return;

  chrome.storage.local.get([KEY_EXT_LOGS], (result) => {
    if (chrome.runtime.lastError) return;

    try {
      const logs = Array.isArray(result[KEY_EXT_LOGS]) ? result[KEY_EXT_LOGS] : [];

      // Clear the list
      elLogsList.textContent = "";

      if (logs.length === 0) {
        // No log entries: use a neutral role so an empty "list" with no
        // listitem children does not trigger an ARIA accessibility violation.
        elLogsList.removeAttribute("role");
        const empty = document.createElement("p");
        empty.className   = "logs-empty";
        empty.textContent = "No activity recorded yet.";
        elLogsList.appendChild(empty);
        return;
      }

      // Entries present: promote to a proper list so screen readers announce
      // item count and allow list navigation.
      elLogsList.setAttribute("role", "list");

      // Render newest-first
      const fragment = document.createDocumentFragment();
      for (let i = logs.length - 1; i >= 0; i--) {
        fragment.appendChild(renderLogEntry(logs[i]));
      }
      elLogsList.appendChild(fragment);
    } catch (err) {
      console.error("[Instant Dictionary] loadLogsPanel render error:", err);
    }
  });
}

/** Clear all stored logs and refresh the panel. */
function handleClearLogs() {
  if (!isRuntimeValid()) {
    showSettingsStatus("Extension context lost. Please reopen the popup.", "error");
    return;
  }
  btnClearLogs.disabled = true;
  const ticket = ++_clearLogsOpGen;

  // Safety timer: if the storage callback never fires (e.g. the extension
  // context is invalidated between the isRuntimeValid() guard above and the
  // actual storage.set call), re-enable the button so the UI is not stuck.
  // Generation counter ensures the timer and the callback never both take
  // effect — whichever arrives first stamps the generation and the other
  // silently becomes a no-op.
  const _clearLogsSafetyTimer = setTimeout(() => {
    if (_clearLogsOpGen !== ticket) return; // op completed or was superseded
    ++_clearLogsOpGen;
    btnClearLogs.disabled = false;
    showSettingsStatus("Request timed out. Please reopen the popup.", "error");
  }, STORAGE_TIMEOUT_MS);

  chrome.storage.local.set({ [KEY_EXT_LOGS]: [] }, () => {
    if (_clearLogsOpGen !== ticket) return; // stale — superseded
    clearTimeout(_clearLogsSafetyTimer);
    ++_clearLogsOpGen;
    try {
      btnClearLogs.disabled = false;
      if (chrome.runtime.lastError) {
        showSettingsStatus("Error clearing logs. Please try again.", "error");
        return;
      }
      loadLogsPanel();
      showSettingsStatus("Logs cleared", "cleared");
    } catch (err) {
      btnClearLogs.disabled = false;
      console.error("[Instant Dictionary] Clear logs callback error:", err);
      showSettingsStatus("Unexpected error while clearing logs. Please try again.", "error");
    }
  });
}

btnClearLogs.addEventListener("click", handleClearLogs);

// ─── Load saved settings on popup open ───────────────────────────────────────
if (isRuntimeValid()) {
  // _loadComplete is set to true the moment the storage callback fires.
  // The safety timer checks it before showing the error message: if the
  // callback has already run (even with an error), the timer is a no-op so
  // the two code paths can never overwrite each other.
  // The inverse guard (_loadTimedOut) is checked inside the callback: if the
  // timer already fired and showed an error, the callback silently bails out
  // rather than restoring the settings UI on top of the error message.
  let _loadComplete = false;
  let _loadTimedOut = false;

  const loadSafetyTimer = setTimeout(() => {
    if (_loadComplete) return; // callback already ran; nothing to do
    _loadTimedOut = true;
    showStatus("Settings could not be loaded. Try reopening.", "error");
  }, STORAGE_TIMEOUT_MS);

  // Read both new MW keys AND the legacy key in one call so we can migrate.
  chrome.storage.local.get(STORAGE_KEYS, (result) => {
    _loadComplete = true;
    clearTimeout(loadSafetyTimer);

    // If the safety timer already fired and showed an error, do not overwrite
    // that message (or the error-state UI) with stale settings data.
    if (_loadTimedOut) return;

    try {
      if (chrome.runtime.lastError) {
        showStatus("Could not load saved settings.", "error");
        return;
      }

      const r = result ?? {};

      // ── Legacy migration ───────────────────────────────────────────────────
      // If the old single-key is present but neither new key exists yet, treat
      // it as the Collegiate key and write it to the new slot automatically.
      // This runs silently so the user doesn't have to re-enter anything.
      const legacyKey       = safeStr(r[KEY_MW_KEY]).trim();
      const newCollegiate   = safeStr(r[KEY_MW_COLLEGIATE_KEY]).trim();
      const newThesaurus    = safeStr(r[KEY_MW_THESAURUS_KEY]).trim();

      let resolvedCollegiate = newCollegiate;

      if (legacyKey && !newCollegiate) {
        // Silently migrate: write the legacy key into the new collegiate slot.
        resolvedCollegiate = legacyKey;
        if (isRuntimeValid()) {
          chrome.storage.local.set({ [KEY_MW_COLLEGIATE_KEY]: legacyKey }, () => {
            // Remove the legacy key now that migration is complete.
            // Read lastError in both callbacks so Chrome does not surface them
            // as unhandled errors in the Extensions console.
            if (chrome.runtime.lastError) return; // set failed; skip remove
            chrome.storage.local.remove([KEY_MW_KEY], () => {
              void chrome.runtime.lastError; // consume — fire-and-forget, failure is harmless
            });
          });
        }
      }

      elMwCollegiateKey.value = resolvedCollegiate;
      elMwThesaurusKey.value  = newThesaurus;
      elS4Uid.value           = safeStr(r[KEY_S4_UID]).trim();
      elS4Token.value         = safeStr(r[KEY_S4_TOKEN]).trim();

      // Normalise stored priority: treat "free_first" (legacy) as "auto"
      const rawPriority = safeStr(r[KEY_LOOKUP_PRIORITY]).trim();
      const priority    = ALLOWED_PRIORITIES.has(rawPriority) ? rawPriority : DEFAULT_PRIORITY;
      const radio       = document.querySelector(`input[name="priority"][value="${CSS.escape(priority)}"]`);
      if (radio) radio.checked = true;
    } catch (err) {
      console.error("[Instant Dictionary] Failed to restore settings:", err);
      showStatus("Could not restore saved settings.", "error");
    }
  });
} else {
  showStatus("Extension context unavailable. Try reopening.", "error");
}

// ─── Eye toggle ───────────────────────────────────────────────────────────────
document.querySelectorAll(".popup-eye-btn").forEach((btn) => {
  const showLabel = btn.getAttribute("aria-label") || "Show";
  // Build the hide-label by substituting the leading "Show" word.
  // If aria-label doesn't start with "Show " (e.g. custom label), fall back
  // to a generic "Hide" prefix so the toggle still announces something useful.
  const hideLabel = /^Show\b/i.test(showLabel)
    ? showLabel.replace(/^Show\b/i, "Hide")
    : `Hide ${showLabel}`;
  btn.dataset.labelShow = showLabel;
  btn.dataset.labelHide = hideLabel;

  btn.addEventListener("click", () => {
    const input = document.getElementById(btn.getAttribute("data-target"));
    if (!input) return;
    const isHidden = input.type === "password";
    input.type = isHidden ? "text" : "password";
    setEyeIcon(btn, isHidden);
    btn.setAttribute("aria-label", isHidden ? btn.dataset.labelHide : btn.dataset.labelShow);
  });
});

// ─── Enter-key submit on API key fields ───────────────────────────────────────
[elMwCollegiateKey, elMwThesaurusKey, elS4Uid, elS4Token].forEach((input) => {
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !btnSave.disabled) { e.preventDefault(); btnSave.click(); }
  });
});
