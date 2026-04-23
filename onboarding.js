// Strict IIFE to prevent global scope pollution
(() => {
    'use strict';

    // 1. DOM References
    const closeBtn = document.getElementById('btn-close');

    // 1.5 Context Safety Guard
    const isRuntimeValid = () => {
        // Must be try-catched; accessing dead properties on chrome throws sync errors
        try { return !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id); }
        catch { return false; }
    };

    // 2. Action Handlers
    const closeOnboardingTab = () => {
        // Guard check for context validity using the enterprise standard
        if (isRuntimeValid() && chrome.tabs && chrome.tabs.getCurrent) {
            try {
                chrome.tabs.getCurrent((tab) => {
                    // Consume lastError first if the context died during the async callback
                    if (chrome.runtime.lastError) {
                        window.close();
                        return;
                    }
                    if (tab && tab.id) {
                        // Consume lastError to prevent sync rejections 
                        // if the user closes the tab manually right as the API fires.
                        chrome.tabs.remove(tab.id, () => {
                            if (chrome.runtime.lastError) {
                                console.debug("[Instant Dictionary] Tab removal handled natively.", chrome.runtime.lastError);
                                window.close(); 
                            }
                        });
                    } else {
                        window.close(); // Fallback if tab context is weirdly detached
                    }
                });
            } catch (err) {
                // Failsafe: Context was invalidated exactly during execution
                window.close();
            }
        } else {
            window.close(); // Standard web fallback
        }
    };

    // 3. Memory Management / BFCache Compliance
    const cleanup = () => {
        if (closeBtn) {
            closeBtn.removeEventListener('click', closeOnboardingTab);
        }
        // If you ever add fetch calls for dynamic announcements here, 
        // this is where you call abortController.abort()
    };

    const init = () => {
        if (!closeBtn) return;
        
        // Attach interactive listeners
        closeBtn.addEventListener('click', closeOnboardingTab, { passive: true });
        
        // Ensure listeners are destroyed if page goes into BFCache or unloads
        window.addEventListener('pagehide', cleanup, { once: true });
    };

    // 4. Boot Sequence
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();