/**
 * pdf.worker.wrapper.mjs
 * Enterprise Worker Wrapper: Guarantees polyfill injection before engine boot.
 */

// 0. Architectural Fallback: Catch silent boot failures in the Worker context
globalThis.addEventListener('unhandledrejection', (event) => {
  console.error("[Worker Wrapper] Unhandled promise rejection during boot:", event.reason);
});

// 1. Async Proposals (Argument-Safe)
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

// 2. Collection & Grouping Proposals
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

if (!Map.groupBy) {
  Map.groupBy = function (iterable, callbackFn) {
    const map = new Map();
    for (const element of iterable) {
      const key = callbackFn(element);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(element);
    }
    return map;
  };
}

// 3. Binary Data Proposals
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

if (!Uint8Array.prototype.toBase64) {
  Uint8Array.prototype.toBase64 = function () { 
    return btoa(Array.from(this).map(b => String.fromCharCode(b)).join('')); 
  };
}

if (!Uint8Array.fromBase64) {
  Uint8Array.fromBase64 = function (base64String) {
    const binString = atob(base64String);
    const bytes = new Uint8Array(binString.length);
    for (let i = 0; i < binString.length; i++) {
      bytes[i] = binString.charCodeAt(i);
    }
    return bytes;
  };
}

// 4. Engine Boot
// Dynamically import the native worker only AFTER the global scope is patched.
import('./pdf.worker.mjs').catch(err => {
  console.error("[Worker Wrapper] Fatal engine boot failure:", err);
});