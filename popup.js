"use strict";

// ─── Shared constants ─────────────────────────────────────────────────────────
const { MW_DEFAULT_LIMIT, S4_DEFAULT_LIMIT, STORAGE_TIMEOUT_MS } = window.SharedConstants;

// ─── Constants ────────────────────────────────────────────────────────────────
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

const STORAGE_KEYS       = Object.freeze([
  KEY_MW_KEY, KEY_MW_COLLEGIATE_KEY, KEY_MW_THESAURUS_KEY,
  KEY_S4_UID, KEY_S4_TOKEN, KEY_LOOKUP_PRIORITY,
]);
const QUOTA_STORAGE_KEYS = Object.freeze([KEY_API_USAGE, KEY_API_MW_LIMIT, KEY_API_S4_LIMIT]);

const DEFAULT_PRIORITY     = "auto";
const ALLOWED_PRIORITIES   = new Set(["auto", "premium_first"]);
const ALLOWED_STATUS_TYPES = new Set(["saved", "cleared", "error"]);
const STATUS_DISPLAY_MS    = 4000;
const MW_MAX_DAILY = MW_DEFAULT_LIMIT;
const S4_MAX_DAILY = S4_DEFAULT_LIMIT;

const MW_KEY_RE   = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const S4_UID_RE   = /^\d{5}$/;
const S4_TOKEN_RE = /^[A-Za-z0-9]{16,17}$/;

// ─── Extension context guard ──────────────────────────────────────────────────
function isRuntimeValid() {
  try { return !!(typeof chrome !== "undefined" && chrome?.runtime?.id); }
  catch { return false; }
}

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

let elMwCollegiateKey, elMwThesaurusKey, elS4Uid, elS4Token, btnSave, btnClearMw, btnClearS4, elStatus;
let elMwCollegiateKeyMsg, elMwThesaurusKeyMsg, elS4UidMsg, elS4TokenMsg;
let viewMain, viewSettings, btnOpenSettings, btnBack;
let btnSaveSettings, elSettingsStatus, btnClearLogs;

try {
  viewMain               = requireEl("view-main");
  viewSettings           = requireEl("view-settings");
  elMwCollegiateKey      = requireEl("mw-collegiate-key");
  elMwThesaurusKey       = requireEl("mw-thesaurus-key");
  elS4Uid                = requireEl("s4-uid");
  elS4Token              = requireEl("s4-token");
  btnSave                = requireEl("btn-save");
  btnClearMw             = requireEl("btn-clear-mw");
  btnClearS4             = requireEl("btn-clear-s4");
  elStatus               = requireEl("popup-status");
  elMwCollegiateKeyMsg   = requireEl("mw-collegiate-key-msg");
  elMwThesaurusKeyMsg    = requireEl("mw-thesaurus-key-msg");
  elS4UidMsg             = requireEl("s4-uid-msg");
  elS4TokenMsg           = requireEl("s4-token-msg");
  btnOpenSettings        = requireEl("btn-open-settings");
  btnBack                = requireEl("btn-back");
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
const settingsTabButtons = Array.from(document.querySelectorAll(".popup-tab[data-stab]"));

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

  if (stabId === "usage") loadUsagePanel();
  if (stabId === "logs")  loadLogsPanel();

  updateSettingsSaveButton(stabId);
}

settingsTabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.stab) activateSettingsTab(btn.dataset.stab);
  });
});

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

function updateSettingsSaveButton(stabId) {
  if (stabId === "logs" || stabId === "usage") {
    btnSaveSettings.style.display = "none";
  } else {
    btnSaveSettings.style.display = "";
    btnSaveSettings.textContent = "Save Priority";
  }
}

updateSettingsSaveButton("lookup");

// ─── Status bars ─────────────────────────────────────────────────────────────
function _showStatus(elSt, timers, msg, type) {
  const safeType = ALLOWED_STATUS_TYPES.has(type) ? type : "error";
  clearTimeout(timers.display);
  clearTimeout(timers.clear);

  if (!isRuntimeValid()) return;

  elSt.textContent = String(msg).slice(0, 200);
  elSt.className   = `popup-status ${safeType} visible`;

  timers.display = setTimeout(() => {
    timers.display = null;
    if (!isRuntimeValid()) return;
    elSt.className = "popup-status";
    timers.clear   = setTimeout(() => {
      timers.clear     = null;
      if (!isRuntimeValid()) return;
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
  if (!isRuntimeValid()) return;
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

function debounce(fn, ms) {
  let timer = null;
  function debounced(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, ms);
  }
  debounced.cancel = () => { clearTimeout(timer); timer = null; };
  return debounced;
}

const dirtyFields = new Set();
function markDirty(field) { dirtyFields.add(field); }

// CrossValidate flag breaks potential recursion loops on sibling validation bounce
function validateMwKey(inputEl, msgEl, interactive = false, crossValidate = true) {
  const val = inputEl.value.trim();
  if (!val) {
    setFieldState(inputEl, msgEl, "");
    if (interactive && crossValidate) {
      const otherInput = inputEl === elMwCollegiateKey ? elMwThesaurusKey    : elMwCollegiateKey;
      const otherMsg   = inputEl === elMwCollegiateKey ? elMwThesaurusKeyMsg : elMwCollegiateKeyMsg;
      if (otherInput.classList.contains("is-error")) {
        validateMwKey(otherInput, otherMsg, true, false); 
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

  const collegiateVal = elMwCollegiateKey.value.trim();
  const thesaurusVal  = elMwThesaurusKey.value.trim();
  if (
    interactive && crossValidate &&
    collegiateVal && thesaurusVal &&
    MW_KEY_RE.test(collegiateVal) && MW_KEY_RE.test(thesaurusVal) &&
    collegiateVal.toLowerCase() === thesaurusVal.toLowerCase()
  ) {
    const dupMsg = "This looks like the same key as the other MW field — MW issues separate UUIDs for each API";
    setFieldState(elMwCollegiateKey, elMwCollegiateKeyMsg, "error", dupMsg);
    setFieldState(elMwThesaurusKey,  elMwThesaurusKeyMsg,  "error", dupMsg);
    return false; 
  }

  if (interactive) {
    const msg = dirtyFields.has(inputEl) 
      ? "Format verified. Ensure the API key is active to prevent silent failures." 
      : "";
    setFieldState(inputEl, msgEl, "ok", msg);
  }
  return true;
}

function validateMwCollegiate(interactive = false) {
  return validateMwKey(elMwCollegiateKey, elMwCollegiateKeyMsg, interactive, true);
}

function validateMwThesaurus(interactive = false) {
  return validateMwKey(elMwThesaurusKey, elMwThesaurusKeyMsg, interactive, true);
}

function validateS4Pair(interactive = false) {
  const uid   = elS4Uid.value.trim();
  const token = elS4Token.value.trim();

if (uid && token) {
    let uidOk = true, tokenOk = true;
    
    if (!S4_UID_RE.test(uid)) {
      if (interactive) setFieldState(elS4Uid, elS4UidMsg, "error", "User ID must be exactly 5 digits");
      uidOk = false;
    } else if (interactive) {
      const msg = dirtyFields.has(elS4Uid) 
        ? "Format verified. Ensure the User ID is correct to prevent silent failures." 
        : "";
      setFieldState(elS4Uid, elS4UidMsg, "ok", msg);
    }
    
    if (!S4_TOKEN_RE.test(token)) {
      if (interactive) setFieldState(elS4Token, elS4TokenMsg, "error", "Token must be 16-17 alphanumeric characters");
      tokenOk = false;
    } else if (interactive) {
      const msg = dirtyFields.has(elS4Token) 
        ? "Format verified. Ensure the Token is active to prevent silent failures." 
        : "";
      setFieldState(elS4Token, elS4TokenMsg, "ok", msg);
    }
    
    return uidOk && tokenOk;
  }

  if (uid && !token) {
    if (interactive) {
      if (!S4_UID_RE.test(uid)) setFieldState(elS4Uid, elS4UidMsg, "error", "User ID must be exactly 5 digits");
      else setFieldState(elS4Uid, elS4UidMsg, "");
      if (dirtyFields.has(elS4Token)) setFieldState(elS4Token, elS4TokenMsg, "error", "Token is required when a User ID is entered");
      else setFieldState(elS4Token, elS4TokenMsg, "");
    }
    return false;
  }

  if (!uid && token) {
    if (interactive) {
      if (!S4_TOKEN_RE.test(token)) setFieldState(elS4Token, elS4TokenMsg, "error", "Token must be 16-17 alphanumeric characters");
      else setFieldState(elS4Token, elS4TokenMsg, "");
      if (dirtyFields.has(elS4Uid)) setFieldState(elS4Uid, elS4UidMsg, "error", "User ID is required when a Token is entered");
      else setFieldState(elS4Uid, elS4UidMsg, "");
    }
    return false;
  }

  setFieldState(elS4Uid,   elS4UidMsg,   "");
  setFieldState(elS4Token, elS4TokenMsg, "");
  return true;
}

const debouncedMwCollegiateValidate = debounce(() => {
  if (dirtyFields.has(elMwCollegiateKey)) validateMwCollegiate(true);
}, 350);

const debouncedMwThesaurusValidate = debounce(() => {
  if (dirtyFields.has(elMwThesaurusKey)) validateMwThesaurus(true);
}, 350);

const debouncedS4Validate = debounce(() => {
  if (dirtyFields.has(elS4Uid) || dirtyFields.has(elS4Token)) validateS4Pair(true);
}, 350);

elMwCollegiateKey.addEventListener("input", debouncedMwCollegiateValidate);
elMwCollegiateKey.addEventListener("blur", () => {
  debouncedMwCollegiateValidate.cancel();
  markDirty(elMwCollegiateKey);
  validateMwCollegiate(true);
});

elMwThesaurusKey.addEventListener("input", debouncedMwThesaurusValidate);
elMwThesaurusKey.addEventListener("blur", () => {
  debouncedMwThesaurusValidate.cancel();
  markDirty(elMwThesaurusKey);
  validateMwThesaurus(true);
});

elS4Uid.addEventListener("input", debouncedS4Validate);
elS4Uid.addEventListener("blur", () => {
  debouncedS4Validate.cancel();
  markDirty(elS4Uid);
  validateS4Pair(true);
});

elS4Token.addEventListener("input", debouncedS4Validate);
elS4Token.addEventListener("blur", () => {
  debouncedS4Validate.cancel();
  markDirty(elS4Token);
  validateS4Pair(true);
});

function makePasteTrimHandler(inputEl) {
  return (e) => {
    e.preventDefault();
    const raw     = e.clipboardData?.getData("text") ?? "";
    const trimmed = raw.trim();
    if (!trimmed) return;
    const { value } = inputEl;
    const s   = typeof inputEl.selectionStart === "number" ? inputEl.selectionStart : value.length;
    const end = typeof inputEl.selectionEnd   === "number" ? inputEl.selectionEnd   : value.length;
    inputEl.value = value.slice(0, s) + trimmed + value.slice(end);
    const cursor  = s + trimmed.length;
    try { inputEl.setSelectionRange(cursor, cursor); } catch { }
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
  };
}

elMwCollegiateKey.addEventListener("paste", makePasteTrimHandler(elMwCollegiateKey));
elMwThesaurusKey.addEventListener("paste",  makePasteTrimHandler(elMwThesaurusKey));
elS4Uid.addEventListener("paste",           makePasteTrimHandler(elS4Uid));
elS4Token.addEventListener("paste",         makePasteTrimHandler(elS4Token));

// ── Race / stale-callback prevention ─────────────────────────────────────────
let _currentOpGen  = 0;
let _opSafetyTimer = null;

function _cancelOpSafetyTimer() {
  clearTimeout(_opSafetyTimer);
  _opSafetyTimer = null;
}

function lockButtons() {
  _cancelOpSafetyTimer(); 
  const ticket = ++_currentOpGen;
  btnSave.disabled = true;
  btnClearMw.disabled = true;
  btnClearS4.disabled = true;
  _opSafetyTimer = setTimeout(() => {
    _opSafetyTimer = null;
    if (!isRuntimeValid() || _currentOpGen !== ticket) return; 
    ++_currentOpGen;                       
    unlockButtons();
    showStatus("Request timed out. Please reopen the popup.", "error");
  }, STORAGE_TIMEOUT_MS);
  return ticket;
}

function unlockButtons() {
  if (!isRuntimeValid()) return;
  btnSave.disabled = false;
  btnClearMw.disabled = false;
  btnClearS4.disabled = false;
}

let _settingsOpGen   = 0;
let _settingsOpTimer = null;

function _cancelSettingsOpTimer() {
  clearTimeout(_settingsOpTimer);
  _settingsOpTimer = null;
}

function _lockSettingsBtn() {
  _cancelSettingsOpTimer();
  const ticket = ++_settingsOpGen;
  btnSaveSettings.disabled = true;
  _settingsOpTimer = setTimeout(() => {
    _settingsOpTimer = null;
    if (!isRuntimeValid() || _settingsOpGen !== ticket) return;
    ++_settingsOpGen;
    btnSaveSettings.disabled = false;
    showSettingsStatus("Request timed out. Please reopen the popup.", "error");
  }, STORAGE_TIMEOUT_MS);
  return ticket;
}

function _unlockSettingsBtn() {
  if (!isRuntimeValid()) return;
  btnSaveSettings.disabled = false;
}

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
        if (_currentOpGen !== ticket) return;
        _cancelOpSafetyTimer();
        ++_currentOpGen;
        unlockButtons();
        
        if (!isRuntimeValid()) return;

        if (chrome.runtime.lastError) {
          showStatus("Error saving settings. Please try again.", "error");
          return;
        }

        const parts = [];
        if (mwCollegiateKey && mwThesaurusKey) parts.push("Merriam-Webster (Collegiate/Learner's + Thesaurus)");
        else if (mwCollegiateKey) parts.push("Merriam-Webster Collegiate/Learner's");
        else if (mwThesaurusKey) parts.push("Merriam-Webster Thesaurus");
        
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

function handleClearMw() {
  if (!isRuntimeValid()) { showStatus("Extension context lost. Please reopen the popup.", "error"); return; }

  const ticket = lockButtons();

  chrome.storage.local.remove([KEY_MW_KEY, KEY_MW_COLLEGIATE_KEY, KEY_MW_THESAURUS_KEY], () => {
    try {
      if (_currentOpGen !== ticket) return;
      _cancelOpSafetyTimer();
      ++_currentOpGen;
      unlockButtons();

      if (!isRuntimeValid()) return;

      if (chrome.runtime.lastError) {
        showStatus("Error clearing settings. Please try again.", "error");
        return;
      }

      elMwCollegiateKey.value = elMwThesaurusKey.value = "";
      setFieldState(elMwCollegiateKey, elMwCollegiateKeyMsg, "");
      setFieldState(elMwThesaurusKey, elMwThesaurusKeyMsg, "");
      dirtyFields.delete(elMwCollegiateKey);
      dirtyFields.delete(elMwThesaurusKey);

      [elMwCollegiateKey, elMwThesaurusKey].forEach(el => {
        const btn = document.querySelector(`.popup-eye-btn[data-target="${el.id}"]`);
        if (btn) {
          el.type = "password";
          setEyeIcon(btn, false);
          btn.setAttribute("aria-label", btn.dataset.labelShow || "Show");
        }
      });

      showStatus("Merriam-Webster keys cleared", "cleared");
    } catch (err) {
      if (_currentOpGen === ticket) { _cancelOpSafetyTimer(); ++_currentOpGen; unlockButtons(); }
      console.error("[Instant Dictionary] MW Clear callback error:", err);
      showStatus("Unexpected error while clearing. Please try again.", "error");
    }
  });
}

btnClearMw.addEventListener("click", handleClearMw);

function handleClearS4() {
  if (!isRuntimeValid()) { showStatus("Extension context lost. Please reopen the popup.", "error"); return; }

  const ticket = lockButtons();

  chrome.storage.local.remove([KEY_S4_UID, KEY_S4_TOKEN], () => {
    try {
      if (_currentOpGen !== ticket) return;
      _cancelOpSafetyTimer();
      ++_currentOpGen;
      unlockButtons();

      if (!isRuntimeValid()) return;

      if (chrome.runtime.lastError) {
        showStatus("Error clearing settings. Please try again.", "error");
        return;
      }

      elS4Uid.value = elS4Token.value = "";
      setFieldState(elS4Uid, elS4UidMsg, "");
      setFieldState(elS4Token, elS4TokenMsg, "");
      dirtyFields.delete(elS4Uid);
      dirtyFields.delete(elS4Token);

      [elS4Uid, elS4Token].forEach(el => {
        const btn = document.querySelector(`.popup-eye-btn[data-target="${el.id}"]`);
        if (btn) {
          el.type = "password";
          setEyeIcon(btn, false);
          btn.setAttribute("aria-label", btn.dataset.labelShow || "Show");
        }
      });

      showStatus("STANDS4 keys cleared", "cleared");
    } catch (err) {
      if (_currentOpGen === ticket) { _cancelOpSafetyTimer(); ++_currentOpGen; unlockButtons(); }
      console.error("[Instant Dictionary] S4 Clear callback error:", err);
      showStatus("Unexpected error while clearing. Please try again.", "error");
    }
  });
}

btnClearS4.addEventListener("click", handleClearS4);

function handleSaveSettings() {
  if (!isRuntimeValid()) {
    showSettingsStatus("Extension context lost. Please reopen the popup.", "error");
    return;
  }

  const activeStab = settingsTabButtons.find((btn) => btn.classList.contains("is-active"))?.dataset.stab ?? "lookup";

  if (activeStab === "lookup") {
    const selectedRadio = document.querySelector('input[name="priority"]:checked');
    let priority = selectedRadio?.value ?? DEFAULT_PRIORITY;
    if (!ALLOWED_PRIORITIES.has(priority)) priority = DEFAULT_PRIORITY;

    const ticket = _lockSettingsBtn();
    chrome.storage.local.set({ [KEY_LOOKUP_PRIORITY]: priority }, () => {
      try {
        if (_settingsOpGen !== ticket) return;
        _cancelSettingsOpTimer();
        ++_settingsOpGen;
        _unlockSettingsBtn();

        if (!isRuntimeValid()) return;

        if (chrome.runtime.lastError) {
          showSettingsStatus("Error saving priority. Please try again.", "error");
          return;
        }
        const LABELS = { auto: "Standard (Recommended)", premium_first: "Enhanced" };
        showSettingsStatus(`\u2713 Saved \u2014 ${LABELS[priority] ?? priority}`, "saved");
      } catch (err) {
        if (_settingsOpGen === ticket) { _cancelSettingsOpTimer(); ++_settingsOpGen; _unlockSettingsBtn(); }
        console.error("[Instant Dictionary] Save priority callback error:", err);
        showSettingsStatus("Unexpected error while saving. Please try again.", "error");
      }
    });

  }
}

btnSaveSettings.addEventListener("click", handleSaveSettings);

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
    if (!isRuntimeValid()) return;
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

      if (elMwLimitInput && document.activeElement !== elMwLimitInput) elMwLimitInput.value = String(mwLimit);
      if (elMwLimitDisplay) elMwLimitDisplay.textContent = String(mwLimit);
      if (elS4LimitInput && document.activeElement !== elS4LimitInput) elS4LimitInput.value = String(s4Limit);
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

  chrome.storage.local.set({ [KEY_API_MW_LIMIT]: mwLimit, [KEY_API_S4_LIMIT]: s4Limit }, () => {
    try {
      if (!isRuntimeValid()) return;

      if (chrome.runtime.lastError) {
        showSettingsStatus("Error saving limits. Please try again.", "error");
        return;
      }
      loadUsagePanel();
      showSettingsStatus("\u2713 Daily limits saved", "saved");
    } catch (err) {
      console.error("[Instant Dictionary] Save limits callback error:", err);
      showSettingsStatus("Unexpected error while saving. Please try again.", "error");
    }
  });
}

function wireLimitInput(rangeEl, displayEl, maxVal, capEl) {
  if (!rangeEl) return;
  rangeEl.min  = "1";
  rangeEl.max  = String(maxVal);
  rangeEl.step = "1";
  if (capEl) capEl.textContent = `(max\u00a0${maxVal})`;
  rangeEl.addEventListener("input", () => {
    const v = parseInt(rangeEl.value, 10);
    if (displayEl && Number.isFinite(v)) displayEl.textContent = String(v);
  });
  rangeEl.addEventListener("change", saveApiLimits);
}

wireLimitInput(elMwLimitInput, elMwLimitDisplay, MW_MAX_DAILY, elMwLimitCap);
wireLimitInput(elS4LimitInput, elS4LimitDisplay, S4_MAX_DAILY, elS4LimitCap);

let _resetUsageOpGen = 0;
let _clearLogsOpGen  = 0;

let _resetUsageSafetyTimer = null;
let _clearLogsSafetyTimer  = null;

if (btnResetUsage) {
  btnResetUsage.addEventListener("click", () => {
    if (!isRuntimeValid()) {
      showSettingsStatus("Extension context lost. Please reopen the popup.", "error");
      return;
    }
    btnResetUsage.disabled = true;
    const ticket = ++_resetUsageOpGen;

    clearTimeout(_resetUsageSafetyTimer);
    _resetUsageSafetyTimer = setTimeout(() => {
      _resetUsageSafetyTimer = null;
      if (!isRuntimeValid() || _resetUsageOpGen !== ticket) return;
      ++_resetUsageOpGen;
      btnResetUsage.disabled = false;
      showSettingsStatus("Request timed out. Please reopen the popup.", "error");
    }, STORAGE_TIMEOUT_MS);

    const today = new Date().toISOString().slice(0, 10);
    chrome.storage.local.set(
      { [KEY_API_USAGE]: { date: today, mw_count: 0, mw_thesaurus_count: 0, s4_count: 0 } },
      () => {
        if (_resetUsageOpGen !== ticket) return;
        clearTimeout(_resetUsageSafetyTimer);
        ++_resetUsageOpGen;
        try {
          if (!isRuntimeValid()) return;
          btnResetUsage.disabled = false;
          if (chrome.runtime.lastError) {
            showSettingsStatus("Error resetting counters.", "error");
            return;
          }
          loadUsagePanel();
          showSettingsStatus("Usage counters reset", "cleared");
        } catch (err) {
          if (isRuntimeValid()) btnResetUsage.disabled = false;
          console.error("[Instant Dictionary] Reset usage callback error:", err);
          showSettingsStatus("Unexpected error while resetting. Please try again.", "error");
        }
      }
    );
  });
}

function formatLogTs(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "??:??:??";
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch {
    return "??:??:??";
  }
}

function truncateForDisplay(str) {
  return String(str).slice(0, 500);
}

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

function loadLogsPanel() {
  if (!elLogsList) return;
  if (!isRuntimeValid()) return;

  chrome.storage.local.get([KEY_EXT_LOGS], (result) => {
    if (!isRuntimeValid()) return;
    if (chrome.runtime.lastError) return;

    try {
      const logs = Array.isArray(result[KEY_EXT_LOGS]) ? result[KEY_EXT_LOGS] : [];

      if (logs.length === 0) {
        elLogsList.removeAttribute("role");
        const empty = document.createElement("p");
        empty.className   = "logs-empty";
        empty.textContent = "No activity recorded yet.";
        elLogsList.replaceChildren(empty); 
        return;
      }

      elLogsList.setAttribute("role", "list");
      const fragment = document.createDocumentFragment();
      for (let i = logs.length - 1; i >= 0; i--) {
        fragment.appendChild(renderLogEntry(logs[i]));
      }
      elLogsList.replaceChildren(fragment); 
    } catch (err) {
      console.error("[Instant Dictionary] loadLogsPanel render error:", err);
    }
  });
}

function handleClearLogs() {
  if (!isRuntimeValid()) {
    showSettingsStatus("Extension context lost. Please reopen the popup.", "error");
    return;
  }
  btnClearLogs.disabled = true;
  const ticket = ++_clearLogsOpGen;

  clearTimeout(_clearLogsSafetyTimer);
  _clearLogsSafetyTimer = setTimeout(() => {
    _clearLogsSafetyTimer = null;
    if (!isRuntimeValid() || _clearLogsOpGen !== ticket) return;
    ++_clearLogsOpGen;
    btnClearLogs.disabled = false;
    showSettingsStatus("Request timed out. Please reopen the popup.", "error");
  }, STORAGE_TIMEOUT_MS);

  chrome.storage.local.set({ [KEY_EXT_LOGS]: [] }, () => {
    if (_clearLogsOpGen !== ticket) return;
    clearTimeout(_clearLogsSafetyTimer);
    ++_clearLogsOpGen;
    try {
      if (!isRuntimeValid()) return;
      btnClearLogs.disabled = false;
      if (chrome.runtime.lastError) {
        showSettingsStatus("Error clearing logs. Please try again.", "error");
        return;
      }
      loadLogsPanel();
      showSettingsStatus("Logs cleared", "cleared");
    } catch (err) {
      if (isRuntimeValid()) btnClearLogs.disabled = false;
      console.error("[Instant Dictionary] Clear logs callback error:", err);
      showSettingsStatus("Unexpected error while clearing logs. Please try again.", "error");
    }
  });
}

btnClearLogs.addEventListener("click", handleClearLogs);

let _loadTimedOut = false;
let loadSafetyTimer = null;

if (isRuntimeValid()) {
  let _loadComplete = false;

  loadSafetyTimer = setTimeout(() => {
    loadSafetyTimer = null;
    if (!isRuntimeValid() || _loadComplete) return;
    _loadTimedOut = true;
    showStatus("Settings could not be loaded. Try reopening.", "error");
  }, STORAGE_TIMEOUT_MS);

chrome.storage.local.get(STORAGE_KEYS, (result) => {
    _loadComplete = true;
    clearTimeout(loadSafetyTimer);

    if (!isRuntimeValid() || _loadTimedOut) return;

    try {
      if (chrome.runtime.lastError) {
        showStatus("Could not load saved settings.", "error");
        return;
      }

      const r = result ?? {};
      const legacyKey       = safeStr(r[KEY_MW_KEY]).trim();
      const newCollegiate   = safeStr(r[KEY_MW_COLLEGIATE_KEY]).trim();
      const newThesaurus    = safeStr(r[KEY_MW_THESAURUS_KEY]).trim();

      let resolvedCollegiate = newCollegiate;

      // 1. Resolve fallback if necessary
      if (legacyKey && !newCollegiate) {
        resolvedCollegiate = legacyKey;
        if (isRuntimeValid()) {
          chrome.storage.local.set({ [KEY_MW_COLLEGIATE_KEY]: legacyKey }, () => {
            if (isRuntimeValid()) void chrome.runtime.lastError;
          });
        }
      }

      // 2. Unconditionally destroy the legacy key to prevent zombie resurrections
      if (legacyKey && isRuntimeValid()) {
        chrome.storage.local.remove([KEY_MW_KEY], () => {
          if (isRuntimeValid()) void chrome.runtime.lastError;
        });
      }

      elMwCollegiateKey.value = resolvedCollegiate;
      elMwThesaurusKey.value  = newThesaurus;
      elS4Uid.value           = safeStr(r[KEY_S4_UID]).trim();
      elS4Token.value         = safeStr(r[KEY_S4_TOKEN]).trim();

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

document.querySelectorAll(".popup-eye-btn").forEach((btn) => {
  const showLabel = btn.getAttribute("aria-label") || "Show";
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

[elMwCollegiateKey, elMwThesaurusKey, elS4Uid, elS4Token].forEach((input) => {
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !btnSave.disabled) { e.preventDefault(); btnSave.click(); }
  });
});

// ─── Strict Teardown / GC Hook ───────
window.addEventListener("pagehide", () => {
  // 1. Generational Ticket Invalidation
  // Instantly sever all pending storage callbacks to prevent DOM writes during teardown.
  _currentOpGen++;
  _settingsOpGen++;
  _resetUsageOpGen++;
  _clearLogsOpGen++;
  _loadTimedOut = true; // Hijack flag to abort initial async load if pending

  // 2. Terminate all debounced validations
  debouncedMwCollegiateValidate.cancel();
  debouncedMwThesaurusValidate.cancel();
  debouncedS4Validate.cancel();

  // 3. Sever all active safety timers
  _cancelOpSafetyTimer();
  _cancelSettingsOpTimer();
  clearTimeout(_resetUsageSafetyTimer);
  clearTimeout(_clearLogsSafetyTimer);
  clearTimeout(loadSafetyTimer);

  // 4. Purge UI status display timers
  clearTimeout(_mainTimers.display);
  clearTimeout(_mainTimers.clear);
  clearTimeout(_settTimers.display);
  clearTimeout(_settTimers.clear);
});