// ─── Shared constants ─────────────────────────────────────────────────────────
//
// Single source of truth for values that must stay in sync between the content
// script and the popup script.  Exposed as a frozen object on `window` so it
// is accessible from any script loaded in the same context without relying on
// ES-module `import` (which is not universally available in content scripts).
//
// Loading order requirements:
//   • manifest.json  — list this file FIRST in the `content_scripts[].js` array,
//                      before content.js, so window.SharedConstants is defined
//                      by the time content.js runs.
//   • popup.html     — add <script src="shared_constants.js"></script> as the
//                      first <script> tag, before popup.js.
//
// Any change to a value here is automatically reflected in both contexts the
// next time the extension reloads.

"use strict";

window.SharedConstants = Object.freeze({
  // Provider-imposed daily request ceilings.
  MW_DEFAULT_LIMIT:   1000,   // Merriam-Webster: up to 1,000 API calls/day.
  S4_DEFAULT_LIMIT:   100,    // STANDS4: up to 100 API calls/day.

  // Maximum milliseconds to wait for a chrome.storage operation to respond
  // before treating it as a timeout and recovering gracefully.
  STORAGE_TIMEOUT_MS: 2_000,
  // Maximum milliseconds to wait for the native audio element to emit the 
  // 'playing', 'error', or 'ended' event before forcefully aborting and 
  // unlocking the UI thread.
  AUDIO_SAFETY_MS: 5000,
});