/**
 * db.js — InstantDictionaryDB: IndexedDB persistence layer for local file storage.
 */
(function () {
  "use strict";

  const DB_NAME     = "InstantDictFiles";
  const DB_VERSION  = 1;
  const STORE_NAME  = "files";
  const MAX_ENTRIES = 5;

  const _MIME_TO_TYPE = Object.freeze({
    "application/pdf":                                                          "pdf",
    "application/epub+zip":                                                     "epub",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  });

  const _EXT_TO_TYPE = Object.freeze({
    pdf:  "pdf",
    epub: "epub",
    docx: "docx",
  });

  function _normalizeType(file) {
    if (file.type && _MIME_TO_TYPE[file.type]) return _MIME_TO_TYPE[file.type];
    if (file && typeof file.name === "string") {
      const ext = file.name.split(".").pop().toLowerCase();
      if (_EXT_TO_TYPE[ext]) return _EXT_TO_TYPE[ext];
    }
    return "unknown";
  }

  const _EXT_TO_MIME = Object.freeze({
    pdf:  "application/pdf",
    epub: "application/epub+zip",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    doc:  "application/msword",
    txt:  "text/plain",
    html: "text/html",
    htm:  "text/html",
  });

  function _inferMimeType(filename) {
    if (typeof filename !== "string" || !filename) return "application/octet-stream";
    const ext = filename.split(".").pop().toLowerCase();
    return _EXT_TO_MIME[ext] || "application/octet-stream";
  }

  let _db = null;
  let _openPromise = null;

  function closeConnection() {
    if (_db) {
      try { _db.close(); } catch (e) {}
      _db = null;
    }
    _openPromise = null;
  }

  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", closeConnection);
  }

  function _openDB() {
    if (_db)          return Promise.resolve(_db);
    if (_openPromise) return _openPromise;

    _openPromise = new Promise((resolve, reject) => {
      let req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (err) {
        _openPromise = null;
        reject(err);
        return;
      }

      req.onupgradeneeded = function (e) {
        const db = e.target.result;
        let store;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          store = db.createObjectStore(STORE_NAME, {
            keyPath:       "id",
            autoIncrement: true,
          });
          store.createIndex("lastOpened", "lastOpened", { unique: false });
        } else {
          store = e.target.transaction.objectStore(STORE_NAME);
        }
        
        if (!store.indexNames.contains("fileKey")) {
          store.createIndex("fileKey", "fileKey", { unique: true });
        }
      };

      req.onsuccess = function (e) {
        _db = e.target.result;
        _db.onversionchange = function () { closeConnection(); };
        _db.onclose = function () { _db = null; _openPromise = null; };
        _db.onerror = function (ev) { console.error("[InstantDictionaryDB] Unhandled DB error:", ev.target.error); };
        resolve(_db);
      };

      req.onerror = function () {
        _openPromise = null;
        reject(req.error || new Error("[InstantDictionaryDB] indexedDB.open() failed."));
      };

      req.onblocked = function () {
        _openPromise = null;
        reject(new Error("[InstantDictionaryDB] IndexedDB upgrade blocked. Close other extension tabs and retry."));
      };
    });

    return _openPromise;
  }

  function _deleteBatch(db, ids) {
    return new Promise((resolve, reject) => {
      if (!ids || ids.length === 0) return resolve();
      const tx    = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      try {
        for (const id of ids) store.delete(id);
      } catch (err) { return reject(err); }
      tx.oncomplete = function () { resolve(); };
      tx.onerror    = function () { reject(tx.error); };
      tx.onabort    = function () { reject(new Error("Batch deletion transaction aborted.")); };
    });
  }

  async function saveFile(file) {
    if (!file || typeof file.size !== "number") {
      throw new TypeError("[InstantDictionaryDB] saveFile: argument must be a valid File or Blob object.");
    }

    const filename    = (typeof file.name === "string" && file.name) ? file.name : "untitled";
    const fileType    = file.type || _inferMimeType(filename);
    const type        = _normalizeType(file);
    const size        = file.size || 0;
    const lastMod     = file.lastModified || 0;
    const fileKey     = `${filename}_${size}_${lastMod}`;
    const lastOpened  = new Date().toISOString();

    const db = await _openDB();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      let _savedId = null;

      // ATOMIC PHASE 1: Check existence via index
      const keyIndex = store.index("fileKey");
      const getReq = keyIndex.get(fileKey);

      getReq.onsuccess = () => {
        const existingRecord = getReq.result;

        if (existingRecord) {
          // ATOMIC PHASE 2A: Exists. Update and save natively. No eviction needed.
          existingRecord.lastOpened = lastOpened;
          existingRecord.blob       = file; 
          
          const putReq = store.put(existingRecord);
          putReq.onsuccess = () => { _savedId = existingRecord.id; };
        } else {
          // ATOMIC PHASE 2B: New file. Check capacity inside the active transaction.
          const timeIndex = store.index("lastOpened");
          const countReq = timeIndex.getAllKeys();

          countReq.onsuccess = () => {
            const keys = countReq.result || [];
            if (keys.length >= MAX_ENTRIES) {
              const evictCount = keys.length - MAX_ENTRIES + 1;
              for (let i = 0; i < evictCount; i++) {
                store.delete(keys[i]);
              }
            }
            
            // ATOMIC PHASE 3: Safely insert the new record
            const record = {
              fileKey, filename, fileType, type, size, lastOpened, blob: file,
              lastPage: 1, lastScrollY: 0
            };
            const addReq = store.add(record);
            addReq.onsuccess = () => { _savedId = addReq.result; };
          };
        }
      };

      tx.oncomplete = function () { resolve({ id: _savedId, filename, type, size, lastOpened }); };
      tx.onerror    = function () { reject(tx.error); };
      tx.onabort    = function () { reject(new Error("Transaction aborted during save.")); };
    });
  }

  async function getFileById(id) {
    const numericId = Number(id);
    if (isNaN(numericId)) return null;
    const db = await _openDB();
    return new Promise((resolve, reject) => {
      const tx    = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req   = store.get(numericId);
      req.onsuccess = function () { resolve(req.result || null); };
      req.onerror   = function () { reject(req.error); };
      tx.onerror    = function () { reject(tx.error); };
      tx.onabort    = function () { reject(new Error("Transaction aborted during read.")); };
    });
  }

  async function getRecentFiles() {
    const db = await _openDB();
    return new Promise((resolve, reject) => {
      const tx    = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req   = store.getAll();
      req.onsuccess = function () {
        const all = Array.isArray(req.result) ? req.result : [];
        all.sort((a, b) => new Date(b.lastOpened) - new Date(a.lastOpened));
        resolve(all.map(({ id, filename, type, size, lastOpened }) => ({ id, filename, type, size, lastOpened })));
      };
      req.onerror = function () { reject(req.error); };
      tx.onerror  = function () { reject(tx.error); };
      tx.onabort  = function () { reject(new Error("Transaction aborted during listing.")); };
    });
  }

  async function deleteEntry(id) {
    const numericId = Number(id);
    if (isNaN(numericId)) return;
    const db = await _openDB();
    return _deleteBatch(db, [numericId]);
  }

  window.InstantDictionaryDB = Object.freeze({
    saveFile,
    getFileById,
    getRecentFiles,
    deleteEntry,
    closeConnection,
  });
})();