(function () {
  "use strict";

  // ─── Guard: do not inject into pages without a body (XML viewers, etc.) ───
  if (!document.body) return;

  // ─── Configuration ───
  const AUTO_CLOSE_MS = 8000; // Auto-close delay in ms. Change to 0 to disable.

  // Sync CSS countdown bar duration with the JS constant.
  // Written onto the tooltip element directly (alongside theme vars in applyPageTheme).

  // ─── Abort controller for in-flight fetches ───
  let currentAbortController = null;

  // Track the mouseup drag-selection timer so hideTooltip() can cancel it.
  // Without this, clicking to dismiss would re-show the popup ~150 ms later.
  let mouseUpTimer = null;

  // Store the original mouse coordinates used when the tooltip was last shown.
  // Used when repositioning after content loads so positionTooltip() doesn't
  // apply the MARGIN offset a second time.
  let currentMouseX = 0;
  let currentMouseY = 0;

  // Debounce timer handle — declared here so hideTooltip() can cancel it
  // even though debouncedLookup() is defined later.
  let lookupDebounceTimer = null;

  // ─── Cache DOM references after creation ───
  const tooltip   = document.createElement("div");
  tooltip.id      = "dict-tooltip";
  tooltip.setAttribute("role", "tooltip");
  tooltip.setAttribute("aria-live", "polite");
  tooltip.innerHTML = `
    <div id="dict-tooltip-header">
      <span id="dict-tooltip-word"></span>
      <span id="dict-tooltip-phonetic"></span>
      <button id="dict-tooltip-close" aria-label="Close">&times;</button>
    </div>
    <div id="dict-tooltip-body"></div>
    <div id="dict-tooltip-source"></div>
  `;
  document.body.appendChild(tooltip);

  // Use tooltip.querySelector() rather than document.getElementById() to avoid
  // ID collisions with the host page. getElementById() searches the entire DOM,
  // so a host-page element sharing one of our IDs would silently receive updates
  // instead of our tooltip elements.
  const elWord     = tooltip.querySelector("#dict-tooltip-word");
  const elPhonetic = tooltip.querySelector("#dict-tooltip-phonetic");
  const elBody     = tooltip.querySelector("#dict-tooltip-body");
  const elSource   = tooltip.querySelector("#dict-tooltip-source");

  // ─── Helpers ───
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#x27;");
  }

  // Use DOMParser instead of innerHTML on a live DOM node — parses into a
  // detached document so no scripts execute and there are no side-effects
  // on the host page.
  function stripHtml(html) {
    if (!html) return "";
    try {
      const doc = new DOMParser().parseFromString(html, "text/html");
      return (doc.body.textContent || "").trim();
    } catch {
      return "";
    }
  }

  // ─── Page-aware theme ─────────────────────────────────────────────────────
  //
  // Reads the effective background colour of the host page, then derives a
  // harmonious colour palette and writes it as CSS custom properties on the
  // tooltip element. Every colour in content.css references one of these
  // variables so the tooltip blends with any page — light, dark, or tinted.
  //
  // Called on every showTooltip() so the palette is refreshed each open,
  // handling SPAs that switch themes without a full reload.
  // ─────────────────────────────────────────────────────────────────────────
  function applyPageTheme() {
    // Walk up the DOM to find the first element with a non-transparent bg.
    let bgColor = null;
    const candidates = [document.body, document.documentElement];
    for (const el of candidates) {
      const computed = window.getComputedStyle(el).backgroundColor;
      if (computed && computed !== "rgba(0, 0, 0, 0)" && computed !== "transparent") {
        bgColor = computed;
        break;
      }
    }
    // Default to white when the page has no declared background.
    bgColor = bgColor || "rgb(255, 255, 255)";

    // Parse r/g/b channels out of "rgb(...)" or "rgba(...)".
    const match = bgColor.match(/[\d.]+/g);
    const r = match ? parseInt(match[0], 10) : 255;
    const g = match ? parseInt(match[1], 10) : 255;
    const b = match ? parseInt(match[2], 10) : 255;

    // Perceived luminance (0 = black, 1 = white).
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    const isDark    = luminance < 0.5;

    // ── Derived palette ──

    // Tooltip body background — exactly the page background.
    const dictBg = `rgb(${r}, ${g}, ${b})`;

    // Header — a subtle tint: lighter on dark pages, darker on light pages.
    const shift = isDark ? 25 : -18;
    const hr    = Math.min(255, Math.max(0, r + shift));
    const hg    = Math.min(255, Math.max(0, g + shift));
    const hb    = Math.min(255, Math.max(0, b + shift));
    const headerBg = `rgb(${hr}, ${hg}, ${hb})`;

    // Primary text — high contrast against the background.
    const textColor    = isDark ? "rgb(220, 220, 220)" : "rgb(28,  28,  28)";
    // Secondary / muted text.
    const subtextColor = isDark ? "rgb(150, 150, 150)" : "rgb(110, 110, 110)";

    // Border — very low-opacity line.
    const borderColor  = isDark ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.12)";
    // Slightly stronger divider between meaning blocks.
    const dividerColor = isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.07)";

    // Close button resting state.
    const closeBg      = isDark ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.07)";
    const closeHoverBg = isDark ? "rgba(255,255,255,0.20)" : "rgba(0,0,0,0.15)";

    // Part-of-speech chip and example-quote left-border: a readable tonal
    // accent derived from the bg channel with the most "room" to shift,
    // keeping it neutral rather than imposing an arbitrary brand colour.
    const accentBg   = isDark ? "rgba(255,255,255,0.09)" : "rgba(0,0,0,0.06)";
    const accentText = isDark ? "rgb(190, 190, 190)" : "rgb(70,  70,  70)";

    // ── Write to CSS custom properties on the tooltip element ──
    const s = tooltip.style;
    s.setProperty("--dict-auto-close-ms",  `${AUTO_CLOSE_MS}ms`);
    s.setProperty("--dict-bg",             dictBg);
    s.setProperty("--dict-header-bg",      headerBg);
    s.setProperty("--dict-text",           textColor);
    s.setProperty("--dict-subtext",        subtextColor);
    s.setProperty("--dict-border",         borderColor);
    s.setProperty("--dict-divider",        dividerColor);
    s.setProperty("--dict-close-bg",       closeBg);
    s.setProperty("--dict-close-hover-bg", closeHoverBg);
    s.setProperty("--dict-accent-bg",      accentBg);
    s.setProperty("--dict-accent-text",    accentText);
  }

  function hideTooltip() {
    tooltip.style.display = "none";

    // Remove the countdown class to stop the ::after animation.
    tooltip.classList.remove("dict-counting");

    // Cancel any pending drag-selection timer so that dismissing the tooltip
    // doesn't cause it to reappear ~150 ms later.
    if (mouseUpTimer !== null) {
      clearTimeout(mouseUpTimer);
      mouseUpTimer = null;
    }

    // Cancel any pending debounced lookup so a dismissed tooltip doesn't
    // fire a fetch after it's already been closed.
    if (lookupDebounceTimer !== null) {
      clearTimeout(lookupDebounceTimer);
      lookupDebounceTimer = null;
    }

    if (currentAbortController) {
      currentAbortController.abort();
      currentAbortController = null;
    }
  }

  // Drive auto-close via animationend so the close is tied precisely to
  // the CSS countdown bar completing, rather than a parallel setTimeout.
  tooltip.addEventListener("animationend", (e) => {
    if (e.animationName === "dict-countdown" && AUTO_CLOSE_MS > 0) {
      hideTooltip();
    }
  });

  // ─── Close button ───
  tooltip.querySelector("#dict-tooltip-close").addEventListener("click", hideTooltip);

  // ─── Hide when clicking outside ───
  //
  // { capture: true } ensures site-level stopPropagation() can't block us.
  //
  // Browsers fire a `click` event after a drag-select (mousedown → drag →
  // mouseup → click). If the user has an active selection, skip hideTooltip
  // and let the mouseup timer handle showing the tooltip instead. A plain
  // dismiss-click always has an empty selection, so that path is unaffected.
  document.addEventListener("click", (e) => {
    if (tooltip.contains(e.target)) return;
    const sel = window.getSelection();
    if (sel && sel.toString().trim().length > 0) return;
    hideTooltip();
  }, { capture: true });

  // ─── Validation ───
  //
  // Single-character lookups are limited to "a" and "I" — the only meaningful
  // single-letter English dictionary words — to avoid unnecessary network requests.
  function isValidLookup(text) {
    if (!text) return false;
    const t = text.trim();
    if (t.length < 1 || t.length > 60) return false;
    // Single letter: only "a" / "I" are meaningful English dictionary words.
    if (t.length === 1) return /^[aAiI]$/u.test(t);
    // Multi-char: start with a Unicode letter, optional body of letters/spaces/
    // hyphens/apostrophes, end with a Unicode letter. The `u` flag enables \p{L}
    // so accented loanwords (café, naïve, résumé) are accepted.
    return /^\p{L}([\p{L}\s\-']*\p{L})?$/u.test(t);
  }

  // ─── Position & show ───
  function showTooltip(x, y, text) {
    // Store original mouse coordinates for repositioning after content loads,
    // avoiding double-application of the MARGIN offset.
    currentMouseX = x;
    currentMouseY = y;

    // Refresh the colour palette on every open so theme changes in SPAs
    // are picked up automatically.
    applyPageTheme();

    elWord.textContent     = text;
    elPhonetic.textContent = "";
    elSource.textContent   = "";
    elBody.innerHTML       = `<p class="dict-loading">📖 Looking up "<strong>${escapeHtml(text)}</strong>"...</p>`;

    tooltip.style.display = "block";

    // Restart both the fade-in and countdown bar animations reliably.
    // A single forced reflow (offsetHeight read) covers both.
    tooltip.style.animation = "none";
    tooltip.classList.remove("dict-counting");
    void tooltip.offsetHeight;
    tooltip.style.animation = "";
    if (AUTO_CLOSE_MS > 0) {
      tooltip.classList.add("dict-counting");
    }

    positionTooltip(x, y);
  }

  function positionTooltip(x, y) {
    const TOOLTIP_WIDTH  = 370;
    const MARGIN         = 10;
    const scrollX        = window.scrollX || window.pageXOffset;
    const scrollY        = window.scrollY || window.pageYOffset;
    const viewportRight  = scrollX + window.innerWidth;
    const viewportBottom = scrollY + window.innerHeight;

    let left = x + MARGIN;
    let top  = y + MARGIN * 2;

    if (left + TOOLTIP_WIDTH > viewportRight) {
      left = x - TOOLTIP_WIDTH - MARGIN;
    }

    left = Math.max(scrollX + MARGIN, left);

    tooltip.style.left = `${left}px`;
    tooltip.style.top  = `${top}px`;

    requestAnimationFrame(() => {
      const actualHeight = tooltip.offsetHeight;
      if (top + actualHeight > viewportBottom) {
        top = Math.max(scrollY + MARGIN, y - actualHeight - MARGIN);
        tooltip.style.top = `${top}px`;
      }
    });
  }

  // ─── PRIMARY: Double-click (single words) ───
  //
  // A double-click fires: mousedown→mouseup→click→mousedown→mouseup→dblclick.
  // The second mouseup always leaves a 150 ms pending timer. Cancel it here
  // before handling the lookup so showTooltip isn't called a second time.
  document.addEventListener("dblclick", (e) => {
    if (tooltip.contains(e.target)) return;
    if (mouseUpTimer !== null) {
      clearTimeout(mouseUpTimer);
      mouseUpTimer = null;
    }
    const text = window.getSelection().toString().trim();
    if (isValidLookup(text)) {
      showTooltip(e.pageX, e.pageY, text);
      debouncedLookup(text);
    }
  });

  // ─── BACKUP: Click-drag ───
  //
  // Any valid selection (single word or phrase) triggers a lookup, matching
  // the same behaviour as double-click.
  let mouseDownTarget = null;

  document.addEventListener("mousedown", (e) => {
    if (!tooltip.contains(e.target)) mouseDownTarget = e.target;
  });

  document.addEventListener("mouseup", (e) => {
    if (!mouseDownTarget) return;
    mouseDownTarget = null;
    if (tooltip.contains(e.target)) return;

    // Store the timer ID so hideTooltip() can cancel it if needed.
    mouseUpTimer = setTimeout(() => {
      mouseUpTimer = null;
      const text = window.getSelection().toString().trim();
      if (text && isValidLookup(text)) {
        showTooltip(e.pageX, e.pageY, text);
        debouncedLookup(text);
      }
    }, 150);
  });

  // ─── Keyboard trigger ─────────────────────────────────────────────────────
  //
  // Escape always closes the tooltip.
  // When Shift is released, check for a non-empty keyboard selection and,
  // if valid, show the tooltip at the selection's bottom-right corner.
  // Using the Shift-release moment ensures the selection is complete.
  // ─────────────────────────────────────────────────────────────────────────
  document.addEventListener("keyup", (e) => {
    if (e.key === "Escape") {
      hideTooltip();
      return;
    }

    // Only react when Shift itself is released (end of keyboard selection).
    if (e.key !== "Shift") return;
    if (tooltip.contains(document.activeElement)) return;

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;

    const text = sel.toString().trim();
    if (!text || !isValidLookup(text)) return;

    // Position the tooltip at the bottom-right corner of the selection.
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    const x    = rect.right  + window.scrollX;
    const y    = rect.bottom + window.scrollY;

    showTooltip(x, y, text);
    debouncedLookup(text);
  });

  // ─── Debounced lookup ─────────────────────────────────────────────────────
  //
  // Debounce the trigger so rapid re-selections don't queue up redundant
  // fetch chains. 300 ms absorbs accidental double-triggers while staying
  // imperceptible to the user.
  // ─────────────────────────────────────────────────────────────────────────
  function debouncedLookup(text) {
    if (lookupDebounceTimer !== null) clearTimeout(lookupDebounceTimer);
    lookupDebounceTimer = setTimeout(() => {
      lookupDebounceTimer = null;
      lookupWord(text);
    }, 300);
  }

  async function lookupWord(text) {
    if (currentAbortController) currentAbortController.abort();
    currentAbortController = new AbortController();
    const { signal } = currentAbortController;

    const isPhrase = text.includes(" ");

    try {
      const found = await fetchFreeDictionary(text, signal) ||
                    await fetchWiktionary(text, signal);

      if (!found && !signal.aborted) {
        elBody.innerHTML = `
          <p class="dict-error">
            😕 No definition found for "<strong>${escapeHtml(text)}</strong>".
          </p>
          <p class="dict-suggestion">
            ${isPhrase
              ? "Try selecting fewer words or check the phrase."
              : "Check the spelling and try again."}
          </p>
        `;
      }
    } catch (err) {
      if (err.name !== "AbortError") {
        console.warn("[Instant Dictionary] Lookup failed:", err);
      }
    }
  }

  // ─── SOURCE 1: Free Dictionary API ───
  async function fetchFreeDictionary(text, signal) {
    try {
      const response = await fetch(
        `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(text)}`,
        { signal }
      );

      if (!response.ok) return false;

      const data = await response.json();

      if (!Array.isArray(data) || data.length === 0) return false;

      const entry = data[0];
      if (!entry || !Array.isArray(entry.meanings)) return false;

      // Phonetic
      if (entry.phonetic) {
        elPhonetic.textContent = entry.phonetic;
      } else if (entry.phonetics?.length > 0) {
        const ph = entry.phonetics.find((p) => p.text);
        if (ph) elPhonetic.textContent = ph.text;
      }

      // Build HTML using escapeHtml on all API-sourced strings.
      let html = "";

      entry.meanings.forEach((meaning) => {
        html += `<div class="dict-meaning">`;
        html += `<span class="dict-pos">${escapeHtml(meaning.partOfSpeech)}</span>`;

        meaning.definitions.slice(0, 3).forEach((def, i) => {
          if (!def.definition) return;
          html += `<p class="dict-def">${i + 1}. ${escapeHtml(def.definition)}</p>`;
          if (def.example) {
            html += `<p class="dict-example">"${escapeHtml(def.example)}"</p>`;
          }
        });

        if (meaning.synonyms?.length > 0) {
          html += `<p class="dict-synonyms"><strong>Synonyms:</strong> ${meaning.synonyms.slice(0, 5).map(escapeHtml).join(", ")}</p>`;
        }

        if (meaning.antonyms?.length > 0) {
          html += `<p class="dict-antonyms"><strong>Antonyms:</strong> ${meaning.antonyms.slice(0, 5).map(escapeHtml).join(", ")}</p>`;
        }

        html += `</div>`;
      });

      const audioEntry = entry.phonetics?.find((p) => p.audio && p.audio !== "");

      elBody.innerHTML = html;
      elSource.textContent = "Source: Free Dictionary";

      if (audioEntry?.audio) {
        const audioBtn = document.createElement("button");
        audioBtn.className = "dict-audio-btn";
        audioBtn.textContent = "🔊 Listen";
        audioBtn.addEventListener("click", () => {
          const audio = new Audio(audioEntry.audio);
          audio.play().catch((err) => console.warn("[Instant Dictionary] Audio failed:", err));
        });
        elBody.appendChild(audioBtn);
      }

      // Reposition using the stored original coordinates so the MARGIN
      // offset isn't applied a second time.
      positionTooltip(currentMouseX, currentMouseY);

      return true;
    } catch (err) {
      if (err.name === "AbortError") throw err;
      console.warn("[Instant Dictionary] Free Dictionary API error:", err);
      return false;
    }
  }

  // ─── SOURCE 2: Wiktionary API ───
  async function fetchWiktionary(text, signal) {
    const term = text.toLowerCase().replace(/\s+/g, "_");

    try {
      const response = await fetch(
        `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(term)}`,
        { signal }
      );

      if (!response.ok) return false;

      const data = await response.json();

      const english = data.en;
      if (!Array.isArray(english) || english.length === 0) return false;

      let html = "";

      english.forEach((entry) => {
        if (!Array.isArray(entry.definitions)) return;

        html += `<div class="dict-meaning">`;
        html += `<span class="dict-pos">${escapeHtml(entry.partOfSpeech || "Definition")}</span>`;

        entry.definitions.slice(0, 3).forEach((def, i) => {
          const cleanDef = stripHtml(def.definition);
          if (!cleanDef) return;

          html += `<p class="dict-def">${i + 1}. ${escapeHtml(cleanDef)}</p>`;

          if (def.examples?.length > 0) {
            const cleanExample = stripHtml(def.examples[0]);
            if (cleanExample) {
              html += `<p class="dict-example">"${escapeHtml(cleanExample)}"</p>`;
            }
          }
        });

        html += `</div>`;
      });

      if (!html) return false;

      elBody.innerHTML = html;
      elSource.textContent = "Source: Wiktionary";

      // Reposition using the stored original coordinates so the MARGIN
      // offset isn't applied a second time (mirrors fetchFreeDictionary).
      positionTooltip(currentMouseX, currentMouseY);

      return true;
    } catch (err) {
      if (err.name === "AbortError") throw err;
      console.warn("[Instant Dictionary] Wiktionary API error:", err);
      return false;
    }
  }

})();
