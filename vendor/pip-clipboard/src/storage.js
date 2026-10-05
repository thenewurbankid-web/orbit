// Local-only persistence. IndexedDB in the browser (blobs included), with an in-memory
// fallback when IndexedDB is missing or throws (private mode, blocked storage, Node tests).

import { itemBytes } from './normalize.js';

export const DEFAULT_LIMITS = { maxItems: 200, maxBytes: 200 * 1024 * 1024 };

/**
 * Decide which items to evict so the set fits the limits. Oldest first; pinned items are
 * never evicted (they still count towards the totals). Returns the ids to remove.
 */
export function planEviction(items, { maxItems = DEFAULT_LIMITS.maxItems, maxBytes = DEFAULT_LIMITS.maxBytes } = {}) {
  let count = items.length;
  let bytes = items.reduce((a, it) => a + itemBytes(it), 0);
  const candidates = items.filter((it) => !it.pinned).sort((a, b) => a.createdAt - b.createdAt);
  const evict = [];
  for (const it of candidates) {
    if (count <= maxItems && bytes <= maxBytes) break;
    evict.push(it.id);
    count -= 1;
    bytes -= itemBytes(it);
  }
  return evict;
}

export class MemoryBackend {
  constructor() { this.map = new Map(); this.kind = 'memory'; }
  async getAll() { return [...this.map.values()]; }
  async put(item) { this.map.set(item.id, item); }
  async delete(id) { this.map.delete(id); }
  async clear() { this.map.clear(); }
}

export class IDBBackend {
  constructor(dbName, idb = globalThis.indexedDB) {
    this.kind = 'indexeddb';
    this.dbName = dbName;
    this.idb = idb;
    this.dbp = null;
  }

  #open() {
    if (!this.dbp) {
      this.dbp = new Promise((resolve, reject) => {
        const req = this.idb.open(this.dbName, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('IndexedDB open blocked'));
      });
    }
    return this.dbp;
  }

  async #tx(mode, fn) {
    const db = await this.#open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('items', mode);
      const store = tx.objectStore('items');
      let result;
      const req = fn(store);
      if (req) req.onsuccess = () => { result = req.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
  }

  getAll() { return this.#tx('readonly', (s) => s.getAll()); }
  put(item) { return this.#tx('readwrite', (s) => s.put(item)); }
  delete(id) { return this.#tx('readwrite', (s) => s.delete(id)); }
  clear() { return this.#tx('readwrite', (s) => s.clear()); }
}

/**
 * Item store with an in-memory cache. Every backend call is wrapped: on failure the store
 * switches to memory so the widget keeps working for the session.
 */
export class Store {
  constructor({ backend, limits } = {}) {
    this.backend = backend || new MemoryBackend();
    this.limits = { ...DEFAULT_LIMITS, ...(limits || {}) };
    this.cache = new Map();
    this.ready = this.#load();
    this.onError = null;
  }

  async #safe(op, ...args) {
    try { return await this.backend[op](...args); } catch (err) {
      this.onError?.(err);
      if (this.backend.kind !== 'memory') {
        const mem = new MemoryBackend();
        for (const it of this.cache.values()) mem.map.set(it.id, it);
        this.backend = mem;
        return this.backend[op](...args);
      }
      throw err;
    }
  }

  async #load() {
    const all = (await this.#safe('getAll')) || [];
    for (const it of all) if (it && it.id) this.cache.set(it.id, it);
  }

  setLimits(limits) {
    this.limits = { ...this.limits, ...limits };
  }

  /** All items, pinned first, then newest first. */
  list() {
    return [...this.cache.values()].sort((a, b) => (b.pinned - a.pinned) || (b.createdAt - a.createdAt));
  }

  get(id) { return this.cache.get(id) || null; }

  /** Add items; returns { added, evicted, rejected }. */
  async add(items) {
    await this.ready;
    const added = [];
    const rejected = [];
    for (const it of items) {
      if (itemBytes(it) > this.limits.maxBytes) { rejected.push(it); continue; }
      this.cache.set(it.id, it);
      await this.#safe('put', it);
      added.push(it);
    }
    const evictIds = planEviction([...this.cache.values()], this.limits);
    const evicted = [];
    for (const id of evictIds) {
      evicted.push(this.cache.get(id));
      this.cache.delete(id);
      await this.#safe('delete', id);
    }
    return { added: added.filter((a) => this.cache.has(a.id)), evicted, rejected };
  }

  async update(id, patch) {
    await this.ready;
    const it = this.cache.get(id);
    if (!it) return null;
    Object.assign(it, patch);
    await this.#safe('put', it);
    return it;
  }

  async remove(id) {
    await this.ready;
    const it = this.cache.get(id);
    if (!it) return null;
    this.cache.delete(id);
    await this.#safe('delete', id);
    return it;
  }

  /** Remove everything except pinned items (unless includePinned). Returns removed items. */
  async clear({ includePinned = false } = {}) {
    await this.ready;
    const removed = [];
    for (const it of [...this.cache.values()]) {
      if (it.pinned && !includePinned) continue;
      removed.push(it);
      this.cache.delete(it.id);
    }
    if (includePinned || this.cache.size === 0) await this.#safe('clear');
    else for (const it of removed) await this.#safe('delete', it.id);
    return removed;
  }

  get backendKind() { return this.backend.kind; }
}

export function createBackend(name) {
  try {
    if (globalThis.indexedDB && typeof globalThis.indexedDB.open === 'function') return new IDBBackend(`pip-clipboard:${name}`);
  } catch { /* fall through */ }
  return new MemoryBackend();
}
