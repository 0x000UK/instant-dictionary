/**
 * pdfjs-polyfills.js
 * Enterprise Polyfills, Worker Proxy, and Global Configuration for the UI Thread.
 */
(function () {
  "use strict";

  // ─── 1. Early Console Silencer ──────────────────────────────────────────────
  // Hoisted outside the event listener to catch boot-up warnings
  // before the webviewerloaded event even fires. Hardened against empty arguments.
  const _originalWarn = console.warn;
  console.warn = function (...args) {
    if (args.length > 0 && typeof args[0] === "string") {
      if (args[0].includes("[fluent] Missing translations") || args[0].includes("disablePreferences")) {
        return;
      }
    }
    _originalWarn.apply(console, args);
  };

  // ─── 2. Main Thread ES2024/ES2025 Polyfills ───────────────────────────────
  if (!Promise.try) {
    Promise.try = function (callback, ...args) {
      return new Promise((resolve, reject) => { 
        try { 
          resolve(callback(...args)); 
        } catch (err) { 
          reject(err); 
        } 
      });
    };
  }

  if (!Promise.withResolvers) {
    Promise.withResolvers = function () {
      let resolve, reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      return { promise, resolve, reject };
    };
  }

  if (!Map.prototype.getOrInsertComputed) {
    Map.prototype.getOrInsertComputed = function (key, callback) {
      if (this.has(key)) return this.get(key);
      const value = callback(key); 
      this.set(key, value); 
      return value;
    };
  }

  if (!Object.groupBy) {
    Object.groupBy = function (iterable, callbackFn) {
      const obj = Object.create(null);
      for (const element of iterable) {
        const key = String(callbackFn(element));
        if (!obj[key]) obj[key] = [];
        obj[key].push(element);
      }
      return obj;
    };
  }

  if (!Uint8Array.prototype.toHex) {
    Uint8Array.prototype.toHex = function () {
      return Array.from(this).map(b => b.toString(16).padStart(2, '0')).join('');
    };
  }
  
  if (!Uint8Array.fromHex) {
    Uint8Array.fromHex = function (hexString) {
      if (hexString.length % 2 !== 0) throw new SyntaxError('Even length required');
      const bytes = new Uint8Array(hexString.length / 2);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hexString.slice(i * 2, i * 2 + 2), 16);
      }
      return bytes;
    };
  }

  // ─── 3. Bulletproof Worker Proxy ──────────────────────────────────────────
  const NativeWorker = window.Worker;
  window.Worker = function(stringUrl, options) {
    let url = String(stringUrl);
    
    // Architecturally sound: `.includes()` guarantees interception even if PDF.js 
    // appends query parameters or UUID cache-busters to the worker path.
    if (url.includes('pdf.worker.mjs') && !url.includes('pdf.worker.wrapper.mjs')) {
      url = url.replace('pdf.worker.mjs', 'pdf.worker.wrapper.mjs');
    }
    
    return new NativeWorker(url, options);
  };
  window.Worker.prototype = NativeWorker.prototype;

  // ─── 4. PDF.js Viewer Options ─────────────────────────────────────────────
  document.addEventListener("webviewerloaded", () => {
    if (window.PDFViewerApplicationOptions) {
      window.PDFViewerApplicationOptions.set("locale", "en-US");
    }
  }, { once: true });
})();