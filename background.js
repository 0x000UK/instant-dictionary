"use strict";

const CONTEXT_MENU_ID = "dict-sidebar-lookup";

// ─── 0. Context Safety Guard ────────────────────────────────────────────────
/**
 * Prevents "Extension context invalidated" crash loops when the extension 
 * updates or reloads while background async tasks are in flight.
 */
function isRuntimeValid() {
  // Must be try-catched; accessing dead props throws sync errors
  try {
    return !!(typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id);
  } catch {
    return false;
  }
}

// ─── 0.5. Browser Startup Guard (Session Restore Mitigation) ───────────────
// Default to false. Top-level execution occurs on extension reload, updates, 
// and MV3 Service Worker wake-ups. None of these are "Browser Startups".
let _isBrowserStartup = false;

chrome.runtime.onStartup.addListener(() => {
  if (!isRuntimeValid()) return;
  
  // Only set the guard to true when the browser itself is actually booting
  _isBrowserStartup = true;
  
  // Firefox restores the DOM very quickly. 
  // 1 seconds is ample time for the sidebar to boot and consume the flag, 
  // without heavily penalizing a fast user.
  setTimeout(() => { _isBrowserStartup = false; }, 1000); 
  
  // Ensure context menu survives browser restarts
  registerContextMenu();
});

// Provide startup state to the sidebar
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Guard: Prevent unhandled exceptions if context dies mid-handshake
  if (!isRuntimeValid()) return false; 

  if (request.action === "check_startup_state") {
    sendResponse({ isStartup: _isBrowserStartup });
    
    // ─── SINGLE-CONSUMPTION LOCK ───────────────────────────────────────────
    // The moment the sidebar reads a 'true' startup state, we revoke it.
    // This guarantees the sidebar is auto-closed exactly ONCE per session.
    // Any immediate manual toggles right after will receive 'false'.
    if (_isBrowserStartup) {
      _isBrowserStartup = false;
    }
    
    return true;
  }
});

// ─── 1. Context Menu & Onboarding Initialization ────────────────────────────
function registerContextMenu() {
  if (!isRuntimeValid()) return;
  chrome.contextMenus.removeAll(() => {
    if (!isRuntimeValid()) return;
    // Consume lastError to prevent log spam before recreation
    if (chrome.runtime.lastError) void chrome.runtime.lastError; 
    
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: "Define '%s'",
      contexts: ["selection"]
    });
  });
}

chrome.runtime.onInstalled.addListener((details) => {
  if (!isRuntimeValid()) return;
  
  if (details.reason === 'install') {
    chrome.tabs.create({ 
      url: chrome.runtime.getURL('onboarding.html'),
      active: true 
    }, () => {
      if (chrome.runtime.lastError) {
        console.warn('[Instant Dictionary] Initialization tab suppressed.', chrome.runtime.lastError.message);
      }
    });
  }

  // Register the menu cleanly on install/update
  registerContextMenu();
});

// MV2/MV3 Fallback: Soft-registration for Dev Mode hot-reloads
// When changing IDs, Firefox sometimes suppresses onInstalled, wiping the menu.
try {
  chrome.contextMenus.create({
    id: CONTEXT_MENU_ID,
    title: "Define '%s'",
    contexts: ["selection"]
  }, () => {
    if (chrome.runtime.lastError) void chrome.runtime.lastError; // Ignore "already exists"
  });
} catch (e) {}

// ─── 2. Robust PDF.js Interceptor (Web Only) ────────────────────────────────

function getViewerRedirect(targetUrl) {
  const viewerUrl = chrome.runtime.getURL("pdfjs/web/viewer.html");
  return { redirectUrl: `${viewerUrl}?file=${encodeURIComponent(targetUrl)}` };
}

// LAYER 1: Fast URL Matching (Catches explicit .pdf links instantly)
// We also added "sub_frame" to catch PDFs embedded inside webpage iframes.
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!isRuntimeValid()) return {};
    
    // Prevent intercepting our own viewer or other extension pages
    if (details.url.startsWith(chrome.runtime.getURL(""))) return {};

    return getViewerRedirect(details.url);
  },
  {
    urls: [
      "*://*/*.pdf*",
      "*://*/*.pdf?*",
      "*://*/*.PDF*",
      "*://*/*.PDF?*"
    ],
    types: ["main_frame", "sub_frame"] 
  },
  ["blocking"]
);

// LAYER 2: Deep MIME-Type Trap (Catches forced downloads & hidden extensions)
// Intercepts the response headers before the browser processes the payload.
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (!isRuntimeValid()) return {};
    
    // Ignore internal extension requests to prevent infinite routing loops
    if (details.url.startsWith(chrome.runtime.getURL(""))) return {};

    const isPdf = details.responseHeaders && details.responseHeaders.some(header => 
      header.name.toLowerCase() === "content-type" && 
      header.value.toLowerCase().includes("application/pdf")
    );

    if (isPdf) {
      return getViewerRedirect(details.url);
    }
    return {};
  },
  {
    urls: ["<all_urls>"],
    types: ["main_frame", "sub_frame"]
  },
  ["blocking", "responseHeaders"]
);

// ─── 3. Universal State Dispatcher ──────────────────────────────────────────
function dispatchToSidebar(word) {
  if (!word || !isRuntimeValid()) return;
  
  try {
    if (typeof browser !== "undefined" && browser.sidebarAction && browser.sidebarAction.open) {
      // Seal the async rejection leak 
      browser.sidebarAction.open().catch((e) => {
        console.debug("[Instant Dictionary] Sidebar action handled natively or skipped.", e);
      });
    }
  } catch (err) {
    console.warn("[Instant Dictionary] Sidebar API unavailable.", err);
  }

  chrome.storage.local.set({ 
    sidebar_lookup: { word: word, ts: Date.now() } 
  }, () => {
	  if (!isRuntimeValid()) return;
    // Consume storage write errors to prevent IPC locking
    if (chrome.runtime.lastError) {
       console.debug("[Instant Dictionary] State dispatch skipped.", chrome.runtime.lastError);
    }
  });
}

// ─── 4. Triggers ────────────────────────────────────────────────────────────
  chrome.contextMenus.onClicked.addListener((info) => {
  // Guard: Prevent execution in a destroyed context
  if (!isRuntimeValid()) return;

  if (info.menuItemId === CONTEXT_MENU_ID) {
    dispatchToSidebar(info.selectionText.trim());
  }
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-dictionary") {
    if (!isRuntimeValid()) return;

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError || !tabs || !tabs.length || !isRuntimeValid()) {
        console.warn("[Instant Dictionary] Tab query failed or context invalid.");
        return;
      }
      
      const activeTab = tabs[0];
      const isReaderMode = activeTab.url && activeTab.url.startsWith("about:reader");

      if (isReaderMode) {
        console.info("[Instant Dictionary] Hotkey lookup unsupported in Reader Mode. Use Context Menu.");
        return;
      }

      chrome.tabs.sendMessage(activeTab.id, { action: "hotkey_triggered" }, () => {
        // Architectural consumption of blocked content-script injections
        if (chrome.runtime.lastError) void chrome.runtime.lastError;
      });
    });
  }
 });