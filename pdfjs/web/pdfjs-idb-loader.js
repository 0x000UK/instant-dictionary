/**
 * pdfjs-idb-loader.js
 * Enterprise Bridge: Secure IndexedDB Blob retrieval, BFCache rendering, & State Resumption
 */
(function () {
  "use strict";
  const DB_NAME = "InstantDictFiles", DB_VERSION = 1, STORE_NAME = "files";

  function _getParam(name) {
    try { return new URLSearchParams(window.location.search).get(name); } catch { return null; }
  }

  // Debouncer with a hard .cancel() method
  function _debounce(func, wait) {
    let timeout;
    const debounced = function (...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), wait);
    };
    debounced.cancel = function () {
      clearTimeout(timeout);
    };
    return debounced;
  }

  function _readRecord(id) {
    return new Promise((resolve, reject) => {
      let _settled = false;
      function _resolve(v) { if (!_settled) { _settled = true; resolve(v); } }
      function _reject(e)  { if (!_settled) { _settled = true; reject(e);  } }
      
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (err) { _reject(err); return; }
      
      req.onerror = () => _reject(req.error);
      req.onblocked = () => _reject(new Error("Blocked"));
      req.onupgradeneeded = (e) => { try { e.target.result.close(); } catch {} _resolve(null); };
      
      req.onsuccess = (e) => {
        if (_settled) { try { e.target.result.close(); } catch {} return; }
        const db = e.target.result;
        
        let tx;
        try { 
          tx = db.transaction(STORE_NAME, "readonly"); 
        } catch (err) { 
          db.close(); _reject(err); return; 
        }

        tx.oncomplete = () => db.close();
        tx.onerror    = () => db.close();
        tx.onabort    = () => db.close();

        const get = tx.objectStore(STORE_NAME).get(id);
        get.onsuccess = () => _resolve(get.result || null);
        get.onerror   = () => _reject(get.error);
      };
    });
  }

  function _saveRecordState(id, pageNum, scrollY) {
    return new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (err) { return reject(err); }
      
      req.onsuccess = (e) => {
        const db = e.target.result;
        let tx;
        try { 
          tx = db.transaction(STORE_NAME, "readwrite"); 
        } catch (err) { 
          db.close(); return reject(err); 
        }

        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror    = () => { db.close(); reject(tx.error); };
        tx.onabort    = () => { db.close(); reject(new Error("Transaction aborted")); };

        const store = tx.objectStore(STORE_NAME);
        const getReq = store.get(id);
        
        getReq.onsuccess = () => {
          const record = getReq.result;
          if (record) {
            record.lastPage = pageNum;
            record.lastScrollY = scrollY;
            store.put(record); 
          }
        };
      };
      req.onerror = () => reject(req.error);
    });
  }

  function _waitForViewer() {
    return new Promise((resolve, reject) => {
      if (window.PDFViewerApplication && window.PDFViewerApplication.initialized) return resolve();
      function onLoaded() { clearInterval(poll); setTimeout(resolve, 0); }
      document.addEventListener("webviewerloaded", onLoaded, { once: true });
      let elapsed = 0;
      const poll = setInterval(() => {
        elapsed += 100;
        if (window.PDFViewerApplication && window.PDFViewerApplication.initialized) {
          document.removeEventListener("webviewerloaded", onLoaded); clearInterval(poll); resolve();
        } else if (elapsed >= 15000) {
          document.removeEventListener("webviewerloaded", onLoaded); clearInterval(poll); reject(new Error("Timeout"));
        }
      }, 100);
    });
  }

async function _routeToViewer(record, id) {
    const { blob, filename, type, lastPage, lastScrollY } = record;
    if (type !== "pdf") return console.warn(`No viewer for ${type}`);
    
    let blobUrl;
    try { blobUrl = URL.createObjectURL(blob); } catch (err) { return console.error(err); }
    
    if (!window.PDFViewerApplication) { if (blobUrl) URL.revokeObjectURL(blobUrl); return; }
    
    const pdfApp = window.PDFViewerApplication;
    
    // ATTACHMENT PHASE: Bind the listener BEFORE opening the document
    function onPagesInit() {
      if (lastPage) pdfApp.pdfViewer.currentPageNumber = lastPage;
      if (lastScrollY) pdfApp.pdfViewer.container.scrollTop = lastScrollY;
      pdfApp.pdfViewer.eventBus.off('pagesinit', onPagesInit); 
    }
    
    if (pdfApp.pdfViewer && pdfApp.pdfViewer.eventBus) {
      pdfApp.pdfViewer.eventBus.on('pagesinit', onPagesInit);
    }

    // EXECUTION PHASE: Now safely open the document
    try { 
      await pdfApp.open({ url: blobUrl, originalUrl: filename || "local.pdf" }); 
    } catch { 
      try { 
        await pdfApp.open(blobUrl); 
      } catch (err) { 
        if (blobUrl) URL.revokeObjectURL(blobUrl); 
        console.error("[Instant Dictionary] PDF load aborted:", err);
        return; 
      } 
    }

    const saveState = _debounce(() => {
      if (!pdfApp.pdfViewer) return;
      const currentPage = pdfApp.pdfViewer.currentPageNumber;
      const currentScroll = pdfApp.pdfViewer.container.scrollTop;
      _saveRecordState(id, currentPage, currentScroll).catch(console.warn);
    }, 500);

    pdfApp.pdfViewer.eventBus.on('pagechanging', saveState);
    pdfApp.pdfViewer.container.addEventListener('scroll', saveState, { passive: true });

    // TEARDOWN: Clean up listeners and memory on BFCache freeze
    window.addEventListener('pagehide', (e) => {
      saveState.cancel(); 
      if (pdfApp && pdfApp.pdfViewer && pdfApp.pdfViewer.container) {
        pdfApp.pdfViewer.container.removeEventListener('scroll', saveState);
        pdfApp.pdfViewer.eventBus.off('pagechanging', saveState);
      }
      if (!e.persisted && blobUrl) {
        URL.revokeObjectURL(blobUrl);
      }
    });

    // REHYDRATION: Restore listeners if waking up from BFCache
    window.addEventListener('pageshow', (e) => {
      if (e.persisted && pdfApp && pdfApp.pdfViewer && pdfApp.pdfViewer.container) {
        pdfApp.pdfViewer.container.removeEventListener('scroll', saveState);
        pdfApp.pdfViewer.eventBus.off('pagechanging', saveState);
        
        pdfApp.pdfViewer.eventBus.on('pagechanging', saveState);
        pdfApp.pdfViewer.container.addEventListener('scroll', saveState, { passive: true });
      }
    });
  }

  async function _load() {
    const rawId = _getParam("dbid");
    if (!rawId) return;
    const id = Number(rawId);
    if (!Number.isFinite(id) || id <= 0) return;
    let record;
    try { [record] = await Promise.all([_readRecord(id), _waitForViewer()]); } catch (err) { return console.error(err); }
    if (!record || !record.blob || typeof record.blob.size !== "number") return;
    await _routeToViewer(record, id);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", _load, { once: true });
  else _load();
})();