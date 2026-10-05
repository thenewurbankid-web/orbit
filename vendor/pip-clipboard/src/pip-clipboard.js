// PiP Clipboard: an embeddable floating clipboard.
//
//   <script type="module" src=".../pip-clipboard.js"></script>
//   <pip-clipboard></pip-clipboard>                 launcher button
//   <pip-clipboard inline></pip-clipboard>          clipboard rendered in place
//   PipClipboard.open() / .add() / .on() / .registerAction() ...
//
// The only global defined is `PipClipboard` (plus the custom element names
// <pip-clipboard> and <pip-clipboard-window>).

import { Emitter } from './emitter.js';
import { Store, createBackend, DEFAULT_LIMITS } from './storage.js';
import { ActionRegistry, RendererRegistry, TaggerRegistry } from './registry.js';
import { fromInput, computeTags, publicItem } from './normalize.js';
import { ClipboardView, PARTS, FIELDS } from './view.js';
import { LAUNCHER_CSS } from './styles.js';
import { resolveTheme, readTokens, THEMES, TOKENS } from './theme.js';
import { fetchLinkMeta } from './link-meta.js';
import { createHelpers, html } from './helpers.js';
import { sanitizeHtml } from './sanitize.js';
import { isBlob, extOf, formatBytes, timeAgo } from './util.js';
import { icon } from './icons.js';

const VERSION = '0.1.0';
const WINDOW_TAG = 'pip-clipboard-window';
const LAYOUTS = ['list', 'grid', 'compact'];
const SIZES = ['s', 'm', 'l'];

function lsGet(key, fallback) {
  try { const v = globalThis.localStorage?.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function lsSet(key, value) {
  try { globalThis.localStorage?.setItem(key, JSON.stringify(value)); } catch { /* storage blocked */ }
}

const CODE_EXT = { javascript: 'js', typescript: 'ts', python: 'py', json: 'json', html: 'html', css: 'css', go: 'go', rust: 'rs', java: 'java', c: 'c', ruby: 'rb', php: 'php', sql: 'sql', shell: 'sh', yaml: 'yaml', markdown: 'md' };

/** Convert any item into a File (for uploads from host actions, downloads, drags). */
export function toFile(item) {
  const base = (item.title || item.kind || 'clip').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'clip';
  const make = (parts, name, type) => new File(parts, name, { type });
  if (isBlob(item.blob)) return item.blob.name ? item.blob : make([item.blob], item.name || `${base}${item.ext ? `.${item.ext}` : ''}`, item.mime || item.blob.type);
  switch (item.kind) {
    case 'link': return make([`[InternetShortcut]\nURL=${item.url}\n`], `${base}.url`, 'text/plain');
    case 'html': return make([item.html], `${base}.html`, 'text/html');
    case 'code': return make([item.text], `${base}.${CODE_EXT[item.meta?.codeLanguage] || 'txt'}`, 'text/plain');
    case 'image': return make([item.url || ''], `${base}.url.txt`, 'text/plain');
    default: return make([item.text || ''], `${base}.txt`, 'text/plain');
  }
}

async function imageSize(blob) {
  try {
    if (typeof createImageBitmap === 'function') {
      const bmp = await createImageBitmap(blob);
      const r = { width: bmp.width, height: bmp.height };
      bmp.close?.();
      return r;
    }
  } catch { /* fall through (e.g. SVG) */ }
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => { resolve({ width: img.naturalWidth, height: img.naturalHeight }); URL.revokeObjectURL(url); };
    img.onerror = () => { resolve(null); URL.revokeObjectURL(url); };
    img.src = url;
  });
}

async function toPng(blob) {
  if (blob.type === 'image/png') return blob;
  const bmp = await createImageBitmap(blob);
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(bmp.width, bmp.height) : Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
  canvas.getContext('2d').drawImage(bmp, 0, 0);
  if (canvas.convertToBlob) return canvas.convertToBlob({ type: 'image/png' });
  return new Promise((r) => canvas.toBlob(r, 'image/png'));
}

const instances = new Map();

export class PipClipboardInstance {
  constructor({ name = 'default', maxItems, maxBytes, layout, size, fields, theme, fetchLinkMeta: fl, title, storage } = {}) {
    this.name = name;
    this.emitter = new Emitter();
    this.actions = new ActionRegistry();
    this.renderers = new RendererRegistry();
    this.taggers = new TaggerRegistry();
    this.styles = new Map(); // key -> { css } | { href }
    this.views = new Set();
    this.config = {
      layout: 'list', size: 'm', fields: [...FIELDS], fetchLinkMeta: true, title: 'Clipboard',
      ...DEFAULT_LIMITS,
    };
    this.themeTokens = {};
    this.scheme = 'dark';
    this.pip = null;
    this.panel = null;
    this.configure({ maxItems, maxBytes, layout, size, fields, fetchLinkMeta: fl, title });
    if (theme) this.setTheme(theme);
    this.store = new Store({ backend: storage === 'memory' ? undefined : createBackend(name), limits: { maxItems: this.config.maxItems, maxBytes: this.config.maxBytes } });
    this.store.onError = (err) => this.emitter.emit('error', { message: 'Storage failed; keeping items in memory for this session', error: err });
    this.ready = this.store.ready.then(() => this.#retag(false)).then(() => this);
    this.ready.catch((err) => this.emitter.emit('error', { message: 'Could not load stored items', error: err }));
  }

  get version() { return VERSION; }
  get supportsDocumentPiP() { return typeof window !== 'undefined' && 'documentPictureInPicture' in window; }
  get isOpen() { return Boolean(this.pip || this.panel); }
  get mode() { return this.pip ? 'pip' : this.panel ? 'panel' : null; }

  // ---------- events ----------
  on(event, fn) { return this.emitter.on(event, fn); }
  off(event, fn) { this.emitter.off(event, fn); }

  // ---------- configuration ----------
  configure(opts = {}) {
    const c = this.config;
    if (opts.maxItems != null) { if (!(Number.isInteger(+opts.maxItems) && +opts.maxItems > 0)) throw new TypeError('maxItems must be a positive integer'); c.maxItems = +opts.maxItems; }
    if (opts.maxBytes != null) { if (!(+opts.maxBytes > 0)) throw new TypeError('maxBytes must be positive'); c.maxBytes = +opts.maxBytes; }
    if (opts.layout != null) { if (!LAYOUTS.includes(opts.layout)) throw new TypeError(`layout must be one of ${LAYOUTS.join(', ')}`); c.layout = opts.layout; }
    if (opts.size != null) { if (!SIZES.includes(opts.size)) throw new TypeError(`size must be one of ${SIZES.join(', ')}`); c.size = opts.size; }
    if (opts.fields != null) c.fields = parseFields(opts.fields);
    if (opts.fetchLinkMeta != null) c.fetchLinkMeta = Boolean(opts.fetchLinkMeta);
    if (opts.title != null) c.title = String(opts.title).slice(0, 40);
    if (this.store) {
      this.store.setLimits({ maxItems: c.maxItems, maxBytes: c.maxBytes });
      if (opts.maxItems != null || opts.maxBytes != null) this.store.add([]).then(({ evicted }) => this.#afterEvict(evicted));
    }
    for (const v of this.views) { v.applyLayout(); v.render(); }
    return { ...c, fields: [...c.fields] };
  }

  /** setTheme('light' | 'dark' | { base?, scheme?, ...tokens }) */
  setTheme(theme) {
    this.themeTokens = resolveTheme(theme);
    this.scheme = schemeOf(theme);
    for (const v of this.views) v.applyTheme();
    return { ...this.themeTokens };
  }

  /** Inject CSS text or a stylesheet URL into every view (main page and PiP). Returns a remover. */
  addStyles(cssOrUrl) {
    if (typeof cssOrUrl !== 'string' || !cssOrUrl.trim()) throw new TypeError('addStyles: expected CSS text or a stylesheet URL');
    const s = cssOrUrl.trim();
    const isUrl = /^(https?:\/\/|\.{0,2}\/)[^\s{}]*$/.test(s) || (/^[^\s{}]+\.css(\?[^\s{}]*)?$/.test(s));
    let entry;
    if (isUrl) {
      const href = new URL(s, globalThis.document?.baseURI || globalThis.location?.href).href;
      if (!/^https?:/.test(href)) throw new TypeError('addStyles: stylesheet URL must be http(s)');
      entry = { href };
    } else entry = { css: s };
    const key = `s${this.styles.size}-${Math.random().toString(36).slice(2, 7)}`;
    this.styles.set(key, entry);
    for (const v of this.views) v.syncStyles();
    return () => { this.styles.delete(key); for (const v of this.views) v.syncStyles(); };
  }

  // ---------- extension points ----------
  registerAction(action) {
    const off = this.actions.register(action);
    return off;
  }
  unregisterAction(id) { return this.actions.unregister(id); }

  registerRenderer(match, render) {
    const off = this.renderers.register(match, render);
    this.#rerender();
    return () => { off(); this.#rerender(); };
  }

  registerTagger(fn) {
    const off = this.taggers.register(fn);
    this.#retag(true);
    return () => { off(); this.#retag(true); };
  }

  /** Helpers for code outside a renderer (e.g. building elements for the main document). */
  helpers(doc = globalThis.document) { return createHelpers(doc); }

  // ---------- items ----------
  async add(input) {
    await this.ready;
    const items = Array.isArray(input) ? input.flatMap((x) => fromInput(x)) : fromInput(input);
    const added = await this.addItems(items);
    return added.map(publicItem);
  }

  /** Internal: store already-normalised items, tag, enrich, emit. */
  async addItems(items) {
    await this.ready;
    const taggers = this.taggers.all();
    for (const it of items) it.tags = computeTags(it, taggers);
    const { added, evicted, rejected } = await this.store.add(items);
    for (const r of rejected) this.emitter.emit('error', { message: `Too large to keep (${formatBytes(r.size)})`, item: publicItem(r) });
    this.#afterEvict(evicted);
    for (const it of added) this.emitter.emit('add', publicItem(it));
    this.#rerender();
    for (const v of this.views) if (rejected.length) v.toast(`Too large to keep: ${rejected[0].name || rejected[0].title}`);
    added.forEach((it) => this.#enrich(it));
    return added;
  }

  #afterEvict(evicted) {
    for (const it of evicted) this.emitter.emit('remove', { ...publicItem(it), reason: 'evicted' });
    if (evicted.length) this.#rerender();
  }

  async #enrich(item) {
    const patch = {};
    try {
      if (item.kind === 'image' && item.blob) {
        const dims = await imageSize(item.blob);
        if (dims) patch.meta = { ...item.meta, ...dims };
      } else if (item.kind === 'file' && isBlob(item.blob) && /^text\/|json|xml|javascript/.test(item.mime || '') && item.size < 1024 * 1024) {
        patch.meta = { ...item.meta, excerpt: (await item.blob.slice(0, 2000).text()).split('\n').slice(0, 8).join('\n').slice(0, 600) };
      } else if (item.kind === 'link' && this.config.fetchLinkMeta) {
        const m = await fetchLinkMeta(item.url);
        if (m.ok) {
          patch.meta = { ...item.meta, title: m.title || '', description: m.description || '', image: m.image || '', siteName: m.siteName || '', favicon: m.favicon || item.meta.favicon || '' };
        }
      }
    } catch { /* enrichment is best effort */ }
    if (patch.meta && this.store.get(item.id)) {
      await this.store.update(item.id, patch);
      this.#rerender();
      this.emitter.emit('update', publicItem(this.store.get(item.id)));
    }
  }

  async #retag(persist) {
    const taggers = this.taggers.all();
    for (const it of this.store.list()) {
      const tags = computeTags(it, taggers);
      if (tags.join('|') !== (it.tags || []).join('|')) {
        if (persist) await this.store.update(it.id, { tags }); else it.tags = tags;
      }
    }
    this.#rerender();
  }

  async items() { await this.ready; return this.store.list().map(publicItem); }

  get(id) { const it = this.store.get(id); return it ? publicItem(it) : null; }

  async remove(id) {
    const it = await this.store.remove(id);
    if (it) { this.emitter.emit('remove', { ...publicItem(it), reason: 'removed' }); this.#rerender(); }
    return Boolean(it);
  }

  async clear({ includePinned = false } = {}) {
    const removed = await this.store.clear({ includePinned });
    for (const it of removed) this.emitter.emit('remove', { ...publicItem(it), reason: 'cleared' });
    this.emitter.emit('clear', { count: removed.length });
    this.#rerender();
    return removed.map(publicItem);
  }

  async pin(id, pinned = true) {
    const it = await this.store.update(id, { pinned: Boolean(pinned) });
    this.#rerender();
    return it ? publicItem(it) : null;
  }

  toFile(item) { return toFile(typeof item === 'string' ? this.store.get(item) : item); }

  // ---------- actions ----------
  builtinActions(item) {
    const out = [];
    const copyable = item.kind !== 'file' || /^text\//.test(item.mime || '');
    if (copyable && !(item.kind === 'image' && !item.blob && !item.url)) out.push({ id: 'copy', label: 'Copy', icon: 'copy' });
    if (item.kind === 'link' || item.kind === 'image') out.push({ id: 'open', label: item.kind === 'link' ? 'Open link' : 'Open image', icon: 'open' });
    if (item.blob || item.kind === 'image') out.push({ id: 'download', label: 'Download', icon: 'download' });
    else out.push({ id: 'download', label: 'Save as file', icon: 'download' });
    out.push({ id: 'pin', label: item.pinned ? 'Unpin' : 'Pin to top', icon: 'pin' });
    out.push({ id: 'delete', label: 'Delete', icon: 'trash', danger: true });
    return out;
  }

  /** Run a host-registered action by id against an item id. */
  async runAction(actionId, itemId) {
    const item = this.store.get(itemId);
    if (!item) return { ok: false, error: new Error('No such item') };
    const res = await this.actions.run(actionId, item);
    this.emitter.emit('action', { id: actionId, item: publicItem(item), builtin: false, ok: res.ok, result: res.result, error: res.error });
    return res;
  }

  async runBuiltin(actionId, itemId, view) {
    const item = this.store.get(itemId);
    if (!item) return null;
    const win = view?.win || globalThis.window;
    const doc = view?.doc || globalThis.document;
    let message = '';
    let ok = true;
    try {
      switch (actionId) {
        case 'copy': await copyItem(item, win, doc); message = 'Copied'; break;
        case 'open': {
          const url = item.blob ? view?.urlFor(item.blob) || URL.createObjectURL(item.blob) : item.url;
          const opener = (this.pip && win === this.pip ? window : win);
          opener.open(url, '_blank', 'noopener,noreferrer');
          break;
        }
        case 'download': {
          const file = toFile(item);
          const a = doc.createElement('a');
          const url = item.kind === 'image' && !item.blob ? item.url : URL.createObjectURL(file);
          a.href = url;
          a.download = file.name;
          a.rel = 'noopener noreferrer';
          a.style.display = 'none';
          (view?.root || doc.body).append(a);
          a.click();
          a.remove();
          if (url.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(url), 4000);
          message = `Downloading ${file.name}`;
          break;
        }
        case 'pin': await this.pin(item.id, !item.pinned); message = item.pinned ? 'Pinned' : 'Unpinned'; break;
        case 'delete': await this.remove(item.id); message = 'Deleted'; break;
        default: return null;
      }
    } catch (err) {
      ok = false;
      message = actionId === 'copy' ? 'Copy failed (clipboard permission?)' : `${actionId} failed`;
      this.emitter.emit('error', { message, error: err });
    }
    this.emitter.emit('action', { id: actionId, item: publicItem(item), builtin: true, ok });
    return { ok, message };
  }

  // ---------- windows ----------

  /**
   * Open the floating clipboard. Call from a user gesture (click / keypress).
   * opts: { mode: 'auto'|'pip'|'panel', width, height, x, y, anchor, theme, layout, size, fields }
   */
  async open(opts = {}) {
    const mode = opts.mode || 'auto';
    if (this.pip) { try { this.pip.focus(); } catch { /* ignore */ } return { mode: 'pip' }; }
    if (this.panel && mode !== 'pip') { this.panel.view.root.focus(); return { mode: 'panel' }; }
    const wantPip = mode === 'pip' || (mode === 'auto' && this.supportsDocumentPiP);
    if (wantPip && this.supportsDocumentPiP) {
      try {
        // requestWindow must run while the user gesture is still active: no awaits before it.
        const saved = lsGet(`pip-clipboard:${this.name}:pip`, null);
        const pip = await window.documentPictureInPicture.requestWindow({
          width: Math.round(opts.width || saved?.width || 360),
          height: Math.round(opts.height || saved?.height || 480),
        });
        this.#mountPip(pip, opts);
        return { mode: 'pip' };
      } catch (err) {
        if (mode === 'pip') throw err;
        this.emitter.emit('error', { message: 'Document Picture-in-Picture failed; using the in-page panel', error: err });
      }
    }
    this.#mountPanel(opts);
    return { mode: 'panel' };
  }

  async toggle(opts) { if (this.isOpen) { this.close(); return { mode: null }; } return this.open(opts); }

  close() {
    if (this.pip) { try { this.pip.close(); } catch { /* ignore */ } }
    if (this.panel) this.#unmountPanel();
  }

  closeView(view) {
    if (view.mode === 'pip') this.close();
    else if (view.mode === 'panel') this.#unmountPanel();
  }

  /** Render the clipboard inline in a container. Returns { view, unmount }. */
  mount(container, overrides = {}) {
    const doc = container.ownerDocument;
    const host = doc.createElement(WINDOW_TAG);
    host.style.cssText = 'display:block;height:100%;';
    container.append(host);
    const view = new ClipboardView(this, { doc, win: doc.defaultView, host, mode: 'inline', overrides: viewOverrides(overrides) });
    view.anchor = container;
    this.views.add(view);
    view.applyTheme();
    this.ready.then(() => view.render());
    return { view, unmount: () => { view.destroy(); this.views.delete(view); host.remove(); } };
  }

  #mountPip(pip, opts) {
    const doc = pip.document;
    doc.title = this.config.title;
    const meta = doc.createElement('meta');
    meta.name = 'color-scheme';
    meta.content = 'dark light';
    doc.head.append(meta);
    this.pipPageStyle = doc.createElement('style');
    doc.head.append(this.pipPageStyle);
    // Copy the host page's rules that target the widget (::part rules, token declarations),
    // so page-level customisation also applies in the PiP window.
    const copied = doc.createElement('style');
    copied.setAttribute('data-pipc', 'page-rules');
    copied.textContent = collectPageRules();
    doc.head.append(copied);
    const host = doc.createElement(WINDOW_TAG);
    host.style.cssText = 'display:block;height:100vh;';
    doc.body.append(host);
    const view = new ClipboardView(this, { doc, win: pip, host, mode: 'pip', overrides: viewOverrides(opts) });
    view.anchor = opts.anchor || null;
    this.views.add(view);
    this.pip = pip;
    view.applyTheme();
    this.ready.then(() => view.render());
    view.root.focus();
    let t;
    pip.addEventListener('resize', () => {
      clearTimeout(t);
      t = setTimeout(() => lsSet(`pip-clipboard:${this.name}:pip`, { width: pip.innerWidth, height: pip.innerHeight }), 250);
    });
    pip.addEventListener('pagehide', () => {
      lsSet(`pip-clipboard:${this.name}:pip`, { width: pip.innerWidth, height: pip.innerHeight });
      view.destroy();
      this.views.delete(view);
      this.pip = null;
      this.emitter.emit('close', { mode: 'pip' });
    }, { once: true });
    this.emitter.emit('open', { mode: 'pip' });
  }

  paintPipDocument(view) {
    if (!this.pipPageStyle) return;
    const cs = view.win.getComputedStyle(view.host);
    const bg = cs.getPropertyValue('--pipc-bg').trim() || TOKENS['--pipc-bg'][0];
    this.pipPageStyle.textContent = `html,body{margin:0;height:100%;overflow:hidden;background:${bg.replace(/[;{}<>]/g, '')};color-scheme:${view.host.dataset.scheme === 'light' ? 'light' : 'dark'};}`;
  }

  /** Tokens visible at the view's anchor in the main page (carried into the PiP window). */
  inheritedTokens(view) {
    if (view.mode !== 'pip') return {};
    const anchor = view.anchor && view.anchor.isConnected ? view.anchor : globalThis.document?.documentElement;
    return anchor ? readTokens(anchor) : {};
  }

  #mountPanel(opts) {
    const doc = globalThis.document;
    const saved = lsGet(`pip-clipboard:${this.name}:panel`, null) || {};
    const vw = doc.documentElement.clientWidth;
    const vh = doc.documentElement.clientHeight;
    const w = Math.min(opts.width || saved.width || 360, vw - 16);
    const h = Math.min(opts.height || saved.height || 480, vh - 16);
    const x = clamp(opts.x ?? saved.x ?? vw - w - 24, 8, vw - w - 8);
    const y = clamp(opts.y ?? saved.y ?? vh - h - 24, 8, vh - h - 8);
    const host = doc.createElement(WINDOW_TAG);
    host.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:${w}px;height:${h}px;z-index:2147483000;display:block;`;
    doc.body.append(host);
    const view = new ClipboardView(this, { doc, win: doc.defaultView, host, mode: 'panel', overrides: viewOverrides(opts) });
    view.anchor = opts.anchor || null;
    this.views.add(view);
    this.panel = { host, view };
    this.ready.then(() => view.render());
    const save = () => {
      const r = host.getBoundingClientRect();
      lsSet(`pip-clipboard:${this.name}:panel`, { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) });
    };
    // Drag by the toolbar.
    dragHandle(view.toolbar, (e) => !e.target.closest('button, input'), (dx, dy, start) => {
      const nx = clamp(start.left + dx, 0, doc.documentElement.clientWidth - start.width);
      const ny = clamp(start.top + dy, 0, doc.documentElement.clientHeight - 40);
      host.style.left = `${nx}px`;
      host.style.top = `${ny}px`;
    }, host, save, view);
    // Resize by the corner handle.
    dragHandle(view.resizeEl, () => true, (dx, dy, start) => {
      host.style.width = `${clamp(start.width + dx, 260, doc.documentElement.clientWidth - start.left - 4)}px`;
      host.style.height = `${clamp(start.height + dy, 280, doc.documentElement.clientHeight - start.top - 4)}px`;
    }, host, save, view);
    this.panelKeys = (e) => { if (e.key === 'Escape' && e.composedPath().includes(host) && !view.menu && view.confirmBar.hidden) this.#unmountPanel(); };
    doc.addEventListener('keydown', this.panelKeys);
    view.root.focus();
    this.emitter.emit('open', { mode: 'panel' });
  }

  #unmountPanel() {
    if (!this.panel) return;
    const { host, view } = this.panel;
    view.destroy();
    this.views.delete(view);
    host.remove();
    globalThis.document.removeEventListener('keydown', this.panelKeys);
    this.panel = null;
    this.emitter.emit('close', { mode: 'panel' });
  }

  #rerender() { for (const v of this.views) v.render(); }

  // ---------- multiple instances ----------
  create(options = {}) {
    const name = options.name || `instance-${instances.size}`;
    if (instances.has(name)) throw new Error(`PipClipboard instance "${name}" already exists`);
    const inst = new PipClipboardInstance({ ...options, name });
    instances.set(name, inst);
    return inst;
  }

  instance(name = 'default') { return instances.get(name) || null; }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function schemeOf(theme) {
  if (!theme) return 'dark';
  if (typeof theme === 'string') return theme === 'light' ? 'light' : 'dark';
  if (theme.scheme === 'light' || theme.scheme === 'dark') return theme.scheme;
  return theme.base === 'light' ? 'light' : 'dark';
}

function parseFields(f) {
  const list = Array.isArray(f) ? f : String(f).split(/[\s,]+/);
  const out = list.map((x) => String(x).trim()).filter((x) => FIELDS.includes(x));
  return out;
}

function viewOverrides(o = {}) {
  const out = {};
  if (o.theme) { out.tokens = resolveTheme(o.theme); out.scheme = schemeOf(o.theme); }
  if (o.layout && LAYOUTS.includes(o.layout)) out.layout = o.layout;
  if (o.size && SIZES.includes(o.size)) out.size = o.size;
  if (o.fields) out.fields = parseFields(o.fields);
  return out;
}

function collectPageRules() {
  const out = [];
  for (const sheet of Array.from(globalThis.document?.styleSheets || [])) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; } // cross-origin sheet
    const walk = (list) => {
      for (const r of Array.from(list || [])) {
        if (r.selectorText && /pip-clipboard/.test(r.selectorText)) out.push(r.cssText);
        else if (r.cssRules && /pip-clipboard/.test(r.cssText)) {
          // @media / @supports blocks: keep the whole block if it mentions the widget.
          out.push(r.cssText);
        }
      }
    };
    walk(rules);
  }
  return out.join('\n');
}

function dragHandle(handle, accept, move, host, done, view) {
  if (!handle) return;
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !accept(e)) return;
    e.preventDefault();
    const r = host.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, width: r.width, height: r.height };
    handle.setPointerCapture?.(e.pointerId);
    handle.classList.add('dragging');
    const onMove = (ev) => move(ev.clientX - start.x, ev.clientY - start.y, start);
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      handle.classList.remove('dragging');
      done();
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  });
  void view;
}

async function copyItem(item, win, doc) {
  const clip = win.navigator.clipboard;
  const CI = win.ClipboardItem;
  if (item.kind === 'image' && item.blob && clip?.write && CI) {
    const png = await toPng(item.blob);
    await clip.write([new CI({ 'image/png': png })]);
    return;
  }
  if (item.kind === 'html' && clip?.write && CI) {
    await clip.write([new CI({ 'text/html': new Blob([sanitizeHtml(item.html)], { type: 'text/html' }), 'text/plain': new Blob([item.text], { type: 'text/plain' }) })]);
    return;
  }
  let text = item.kind === 'link' || item.kind === 'image' ? item.url : item.text;
  if (item.kind === 'file' && item.blob) text = await item.blob.text();
  if (clip?.writeText) { await clip.writeText(text || ''); return; }
  // Last resort for engines without the async clipboard API.
  const ta = doc.createElement('textarea');
  ta.value = text || '';
  ta.style.cssText = 'position:fixed;opacity:0;';
  doc.body.append(ta);
  ta.select();
  const ok = doc.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('copy failed');
}

// ---------- custom elements ----------

function defineElements() {
  if (typeof customElements === 'undefined' || customElements.get('pip-clipboard')) return;
  class PipClipboardElement extends HTMLElement {
    static observedAttributes = ['theme', 'layout', 'size', 'fields', 'label', 'instance', 'inline', 'mode', 'max-items', 'max-bytes'];

    get clipboard() {
      const name = this.getAttribute('instance');
      if (!name || name === 'default') return PipClipboard;
      return PipClipboard.instance(name) || PipClipboard.create({ name });
    }

    connectedCallback() { this.#render(); }
    disconnectedCallback() { this.mounted?.unmount(); this.mounted = null; }
    attributeChangedCallback() { if (this.isConnected) this.#render(); }

    #overrides() {
      const o = {};
      const theme = this.getAttribute('theme');
      if (theme && theme in THEMES) o.theme = theme;
      for (const k of ['layout', 'size', 'fields']) if (this.getAttribute(k)) o[k] = this.getAttribute(k);
      return o;
    }

    #render() {
      const cb = this.clipboard;
      const lim = {};
      if (this.getAttribute('max-items')) lim.maxItems = +this.getAttribute('max-items');
      if (this.getAttribute('max-bytes')) lim.maxBytes = +this.getAttribute('max-bytes');
      if (Object.keys(lim).length) { try { cb.configure(lim); } catch (e) { console.error('[pip-clipboard]', e); } }
      const root = this.shadowRoot || this.attachShadow({ mode: 'open' });
      this.mounted?.unmount();
      this.mounted = null;
      root.replaceChildren();
      if (this.hasAttribute('inline')) {
        const style = document.createElement('style');
        style.textContent = ':host{display:block;height:480px;}';
        root.append(style);
        this.mounted = cb.mount(root, this.#overrides());
        this.mounted.view.anchor = this;
        return;
      }
      const style = document.createElement('style');
      style.textContent = LAUNCHER_CSS;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('part', 'launcher');
      btn.setAttribute('aria-label', 'Open clipboard window');
      btn.append(icon(document, 'paste'), document.createTextNode(this.getAttribute('label') || 'Clipboard'));
      btn.addEventListener('click', () => {
        const mode = this.getAttribute('mode') || 'auto';
        cb.toggle({ mode, anchor: this, ...this.#overrides() }).catch((err) => console.error('[pip-clipboard]', err));
      });
      root.append(style, btn);
    }
  }
  customElements.define('pip-clipboard', PipClipboardElement);
}

// ---------- default instance + global ----------

export const PipClipboard = new PipClipboardInstance({ name: 'default' });
instances.set('default', PipClipboard);
Object.assign(PipClipboard, {
  themes: Object.freeze(Object.fromEntries(Object.entries(THEMES).map(([k, v]) => [k, Object.freeze({ ...v })]))),
  tokens: Object.freeze(Object.fromEntries(Object.entries(TOKENS).map(([k, [v, d]]) => [k, Object.freeze({ default: v, description: d })]))),
  parts: Object.freeze([...PARTS, 'launcher']),
  fields: Object.freeze([...FIELDS]),
  html,
  sanitize: sanitizeHtml,
  utils: Object.freeze({ formatBytes, timeAgo, extOf, toFile }),
});

if (typeof window !== 'undefined') {
  if (!window.PipClipboard) {
    Object.defineProperty(window, 'PipClipboard', { value: PipClipboard, configurable: true, writable: false });
  }
  defineElements();
}

export default PipClipboard;
