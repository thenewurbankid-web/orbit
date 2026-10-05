// One rendered clipboard UI inside a shadow root. A controller (PipClipboard instance) can
// have several views at once: the Document PiP window, the fallback panel and inline mounts.
// All DOM is created with createElement/textContent; the only markup parsing goes through
// the allowlist sanitiser (renderSanitized) or the escaping html`` helper.

import { BASE_CSS } from './styles.js';
import { icon } from './icons.js';
import { renderSanitized } from './sanitize.js';
import { highlightTokens, LANGUAGE_NAMES } from './detect.js';
import { createHelpers, toNode } from './helpers.js';
import { formatBytes, timeAgo, isBlob } from './util.js';
import { publicItem } from './normalize.js';
import { fromDataTransfer, fromClipboardItems } from './normalize.js';
import { faviconFor } from './link-meta.js';
import { applyTokens } from './theme.js';

export const PARTS = [
  'root', 'toolbar', 'title', 'count', 'toolbar-button', 'confirm', 'confirm-button', 'search', 'search-input',
  'filters', 'filter-chip', 'list', 'card', 'card-kind-image', 'card-kind-link', 'card-kind-text', 'card-kind-code', 'card-kind-html', 'card-kind-file',
  'card-head', 'card-icon', 'card-title', 'card-meta', 'card-image', 'card-thumb', 'card-preview', 'card-code-block', 'card-html-preview',
  'card-og-image', 'card-description', 'card-url', 'card-custom', 'tags', 'tag', 'time', 'card-menu-button', 'pin', 'menu', 'menu-item',
  'action-button', 'menu-separator', 'empty', 'drop-overlay', 'toast', 'resize-handle',
];

export const FIELDS = ['meta', 'preview', 'tags', 'time', 'url', 'description'];

const CODE_NAMES = {
  javascript: 'JavaScript', typescript: 'TypeScript', python: 'Python', json: 'JSON', html: 'HTML', css: 'CSS', go: 'Go',
  rust: 'Rust', java: 'Java', c: 'C / C++', ruby: 'Ruby', php: 'PHP', sql: 'SQL', shell: 'Shell', yaml: 'YAML', markdown: 'Markdown',
};

const KIND_LABEL = { image: 'Image', link: 'Link', text: 'Text', code: 'Code', html: 'HTML', file: 'File' };

function el(doc, tag, attrs = {}, ...children) {
  const e = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c != null && c !== false) e.append(c);
  return e;
}

export class ClipboardView {
  constructor(ctrl, { doc, win, host, mode, overrides = {} }) {
    this.ctrl = ctrl;
    this.doc = doc;
    this.win = win;
    this.host = host;
    this.mode = mode; // 'pip' | 'panel' | 'inline'
    this.overrides = overrides; // per-view theme/layout/size/fields
    this.query = '';
    this.activeTag = '';
    this.focusId = null;
    this.urls = new Map(); // blob -> object URL
    this.fresh = new Set();
    this.cleanup = [];
    this.appliedTokens = {};
    this.styleNodes = new Map();

    host.setAttribute('data-mode', mode);
    host.setAttribute('exportparts', PARTS.join(', '));
    this.shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });
    this.shadow.replaceChildren();
    this.baseStyle = el(doc, 'style', { 'data-pipc': 'base' });
    this.baseStyle.textContent = BASE_CSS;
    this.shadow.append(this.baseStyle);
    this.syncStyles();
    this.build();
    this.applyTheme();
    this.render();
    this.timer = win.setInterval(() => this.refreshTimes(), 60000);
  }

  // ---------- styles and theme ----------

  /** Mirror the controller's addStyles() entries into this shadow root (cloned per document). */
  syncStyles() {
    const wanted = new Set(this.ctrl.styles.keys());
    for (const [key, node] of this.styleNodes) if (!wanted.has(key)) { node.remove(); this.styleNodes.delete(key); }
    for (const [key, entry] of this.ctrl.styles) {
      if (this.styleNodes.has(key)) continue;
      let node;
      if (entry.href) node = el(this.doc, 'link', { rel: 'stylesheet', href: entry.href, 'data-pipc': 'custom' });
      else { node = el(this.doc, 'style', { 'data-pipc': 'custom' }); node.textContent = entry.css; }
      this.styleNodes.set(key, node);
      this.shadow.insertBefore(node, this.root || null);
    }
  }

  applyTheme() {
    const tokens = { ...this.ctrl.inheritedTokens(this), ...this.ctrl.themeTokens, ...(this.overrides.tokens || {}) };
    applyTokens(this.host, tokens, this.appliedTokens);
    this.appliedTokens = tokens;
    const scheme = this.overrides.scheme || this.ctrl.scheme;
    this.host.setAttribute('data-scheme', scheme);
    if (this.mode === 'pip') this.ctrl.paintPipDocument?.(this);
    if (this.root) this.applyLayout();
  }

  applyLayout() {
    const cfg = this.config();
    this.root.dataset.layout = cfg.layout;
    this.root.dataset.size = cfg.size;
  }

  config() {
    const c = this.ctrl.config;
    return {
      layout: this.overrides.layout || c.layout,
      size: this.overrides.size || c.size,
      fields: new Set(this.overrides.fields || c.fields),
    };
  }

  // ---------- skeleton ----------

  build() {
    const d = this.doc;
    const t = (name, label, extra = {}) => {
      const b = el(d, 'button', { type: 'button', class: 'tbtn', part: 'toolbar-button', 'aria-label': label, title: label, ...extra }, icon(d, name));
      return b;
    };
    this.countEl = el(d, 'span', { class: 'count', part: 'count' });
    this.pasteBtn = t('paste', 'Paste from clipboard', { class: 'tbtn primary', 'data-act': 'paste' });
    this.pasteBtn.append(el(d, 'span', { class: 'lbl', text: 'Paste' }));
    this.layoutBtn = t('list', 'Change layout', { 'data-act': 'layout' });
    this.clearBtn = t('trash', 'Clear all', { 'data-act': 'clear' });
    this.closeBtn = t('close', 'Close clipboard', { 'data-act': 'close' });
    this.closeBtn.hidden = this.mode === 'inline';
    this.toolbar = el(d, 'header', { class: 'toolbar', part: 'toolbar' },
      el(d, 'div', { class: 'title', part: 'title' }, el(d, 'span', { text: this.ctrl.config.title }), this.countEl),
      el(d, 'div', { class: 'tools' }, this.pasteBtn, this.layoutBtn, this.clearBtn, this.closeBtn));

    this.confirmText = el(d, 'span');
    this.confirmBar = el(d, 'div', { class: 'confirm', part: 'confirm', role: 'alertdialog', 'aria-label': 'Confirm clear' },
      this.confirmText,
      el(d, 'button', { type: 'button', class: 'btn', part: 'confirm-button', 'data-act': 'clear-cancel', text: 'Cancel' }),
      el(d, 'button', { type: 'button', class: 'btn danger', part: 'confirm-button', 'data-act': 'clear-confirm', text: 'Delete' }));
    this.confirmBar.hidden = true;

    this.searchInput = el(d, 'input', { type: 'search', part: 'search-input', placeholder: 'Search', 'aria-label': 'Search clipboard', autocomplete: 'off', spellcheck: 'false' });
    const search = el(d, 'div', { class: 'searchrow' }, el(d, 'label', { class: 'search', part: 'search' }, icon(d, 'search'), this.searchInput));
    this.filters = el(d, 'div', { class: 'filters', part: 'filters', role: 'group', 'aria-label': 'Filter by tag' });
    this.list = el(d, 'ul', { class: 'list', part: 'list', role: 'list', 'aria-label': 'Clipboard items' });
    this.empty = el(d, 'div', { class: 'empty', part: 'empty' },
      el(d, 'div', { class: 'ring' }, icon(d, 'drop')),
      el(d, 'strong', { text: 'Nothing here yet' }),
      el(d, 'p', {}, 'Drop files, images, links or text here, or press ', el(d, 'kbd', { text: this.isMac() ? '⌘V' : 'Ctrl+V' }), '.'));
    this.dropEl = el(d, 'div', { class: 'drop', part: 'drop-overlay', text: 'Drop to add' });
    this.dropEl.hidden = true;
    this.toastEl = el(d, 'div', { class: 'toast', part: 'toast', role: 'status', 'aria-live': 'polite' });
    this.live = el(d, 'div', { class: 'sr', 'aria-live': 'polite' });

    this.root = el(d, 'div', { class: 'root', part: 'root', tabindex: '-1', role: 'region', 'aria-label': this.ctrl.config.title },
      this.toolbar, this.confirmBar, search, this.filters, this.list, this.empty, this.dropEl, this.toastEl, this.live);
    if (this.mode === 'panel') {
      this.resizeEl = el(d, 'div', { class: 'resize', part: 'resize-handle', 'aria-hidden': 'true' });
      this.root.append(this.resizeEl);
    }
    this.shadow.append(this.root);
    this.applyLayout();
    this.wire();
  }

  isMac() {
    return /Mac|iPhone|iPad/.test(this.win.navigator.platform || this.win.navigator.userAgent || '');
  }

  listen(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this.cleanup.push(() => target.removeEventListener(type, fn, opts));
  }

  wire() {
    this.listen(this.toolbar, 'click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'paste') this.pasteFromClipboard();
      else if (act === 'clear') this.askClear();
      else if (act === 'close') this.ctrl.closeView(this);
      else if (act === 'layout') this.cycleLayout();
    });
    this.listen(this.confirmBar, 'click', async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'clear-cancel') this.hideConfirm();
      if (act === 'clear-confirm') {
        this.hideConfirm();
        const n = (await this.ctrl.clear()).length;
        this.toast(n ? `Deleted ${n} item${n === 1 ? '' : 's'}` : 'Nothing to delete');
      }
    });
    this.listen(this.confirmBar, 'keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); this.hideConfirm(); } });
    this.listen(this.searchInput, 'input', () => { this.query = this.searchInput.value; this.render(); });
    this.listen(this.searchInput, 'keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); this.focusCard(0); }
      if (e.key === 'Escape' && this.searchInput.value) { e.stopPropagation(); this.searchInput.value = ''; this.query = ''; this.render(); }
    });
    this.listen(this.filters, 'click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      this.activeTag = chip.dataset.tag === this.activeTag ? '' : chip.dataset.tag;
      this.render();
      this.filters.querySelector(`.chip[data-tag="${CSS.escape(chip.dataset.tag)}"]`)?.focus();
    });
    this.listen(this.list, 'click', (e) => {
      const more = e.target.closest('.more');
      if (more) { this.openMenu(more.closest('.card')); return; }
      const card = e.target.closest('.card');
      if (card) this.setFocus(card.dataset.id, false);
    });
    this.listen(this.list, 'dblclick', (e) => {
      const card = e.target.closest('.card');
      if (card && !e.target.closest('a,button')) this.primary(card.dataset.id);
    });
    this.listen(this.list, 'contextmenu', (e) => {
      const card = e.target.closest('.card');
      if (card && !e.target.closest('a')) { e.preventDefault(); this.openMenu(card); }
    });
    this.listen(this.list, 'keydown', (e) => this.onCardKey(e));
    this.listen(this.list, 'focusin', (e) => {
      const card = e.target.closest?.('.card');
      if (card) this.setFocus(card.dataset.id, false);
    });

    // Input: paste anywhere in the view; drop onto the view.
    const dropTarget = this.mode === 'pip' ? this.doc : this.root;
    // Paste: when focus is on a non-editable element, Firefox fires paste at <body> and
    // WebKit at the shadow host, so listen on the document and check focus ourselves.
    this.listen(this.doc, 'paste', (e) => { if (this.mode === 'pip' || this.hasFocus(e)) this.onPaste(e); });
    let depth = 0;
    const isExternal = (e) => Array.from(e.dataTransfer?.types || []).some((t) => t !== 'application/x-pip-clipboard');
    this.listen(dropTarget, 'dragenter', (e) => {
      if (!isExternal(e)) return;
      e.preventDefault();
      depth++;
      this.dropEl.hidden = false;
    });
    this.listen(dropTarget, 'dragover', (e) => {
      if (!isExternal(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      this.dropEl.hidden = false;
    });
    this.listen(dropTarget, 'dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) this.dropEl.hidden = true;
    });
    this.listen(dropTarget, 'drop', (e) => {
      depth = 0;
      this.dropEl.hidden = true;
      if (!e.dataTransfer) return;
      e.preventDefault();
      const items = fromDataTransfer(e.dataTransfer, { via: 'dropped' });
      this.ingest(items);
    });
    // Global keys in the view.
    this.listen(this.root, 'keydown', (e) => {
      if (e.key === 'Escape' && this.menu) { this.closeMenu(true); e.stopPropagation(); }
      if ((e.key === 'f' || e.key === 'F') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this.searchInput.focus(); }
      if (e.key === '/' && !this.isTyping(e)) { e.preventDefault(); this.searchInput.focus(); }
    });
    this.listen(this.doc, 'pointerdown', (e) => {
      if (this.menu && !e.composedPath().includes(this.menu)) this.closeMenu(false);
    }, true);
  }

  /** True when keyboard focus is inside this view (walking through nested shadow roots). */
  hasFocus(e) {
    if (e && e.composedPath().includes(this.host)) return true;
    let a = this.doc.activeElement;
    while (a) {
      if (a === this.host) return true;
      a = a.shadowRoot ? a.shadowRoot.activeElement : null;
    }
    return false;
  }

  isTyping(e) {
    const t = e.composedPath()[0];
    return t && (t.localName === 'input' || t.localName === 'textarea' || t.isContentEditable);
  }

  // ---------- input ----------

  onPaste(e) {
    const path = e.composedPath();
    if (path.includes(this.searchInput)) return; // typing a search query
    if (!e.clipboardData) return;
    e.preventDefault();
    this.ingest(fromDataTransfer(e.clipboardData, { via: 'pasted' }));
  }

  async pasteFromClipboard() {
    const clip = this.win.navigator.clipboard;
    try {
      if (clip?.read) {
        const items = await fromClipboardItems(await clip.read(), { via: 'pasted' });
        return this.ingest(items);
      }
      if (clip?.readText) {
        const { fromText } = await import('./normalize.js');
        return this.ingest(fromText(await clip.readText(), { via: 'pasted' }));
      }
      this.toast(`Clipboard access is not available here. Press ${this.isMac() ? '⌘V' : 'Ctrl+V'} instead.`);
    } catch (err) {
      const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      this.toast(denied ? `Clipboard permission denied. Press ${this.isMac() ? '⌘V' : 'Ctrl+V'} instead.` : 'Could not read the clipboard');
    }
    return [];
  }

  async ingest(items) {
    if (!items.length) { this.toast('Nothing usable in that'); return []; }
    const added = await this.ctrl.addItems(items);
    for (const it of added) this.fresh.add(it.id);
    if (added.length) this.say(`Added ${added.length} item${added.length === 1 ? '' : 's'}`);
    return added;
  }

  // ---------- rendering ----------

  visibleItems() {
    const q = this.query.trim().toLowerCase();
    return this.ctrl.store.list().filter((it) => {
      if (this.activeTag && !(it.tags || []).includes(this.activeTag)) return false;
      if (!q) return true;
      const hay = [it.title, it.text, it.url, it.name, it.meta?.description, it.meta?.domain, ...(it.tags || [])].join('\n').toLowerCase();
      return q.split(/\s+/).every((w) => hay.includes(w));
    });
  }

  render() {
    if (!this.root) return;
    const all = this.ctrl.store.list();
    this.countEl.textContent = all.length ? String(all.length) : '';
    this.renderFilters(all);
    const items = this.visibleItems();
    const keepFocus = this.shadow.activeElement?.closest?.('.card') ? this.focusId : null;
    const scroll = this.list.scrollTop;
    this.closeMenu(false);
    const helpers = this.helpers();
    const frag = this.doc.createDocumentFragment();
    if (!items.some((i) => i.id === this.focusId)) this.focusId = items[0]?.id || null;
    for (const it of items) frag.append(el(this.doc, 'li', {}, this.renderCard(it, helpers)));
    this.list.replaceChildren(frag);
    this.list.scrollTop = scroll;
    this.empty.hidden = all.length > 0;
    this.list.hidden = all.length === 0;
    if (all.length && !items.length) {
      this.list.append(el(this.doc, 'li', { class: 'empty', part: 'empty' }, el(this.doc, 'p', { text: 'No matches' })));
    }
    this.fresh.clear();
    this.gcUrls(all);
    if (keepFocus) this.focusCardById(keepFocus);
  }

  renderFilters(all) {
    const counts = new Map();
    for (const it of all) for (const t of it.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
    if (this.activeTag && !counts.has(this.activeTag)) this.activeTag = '';
    const tags = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 40);
    const chip = (tag, label, n) => {
      const b = el(this.doc, 'button', { type: 'button', class: 'chip', part: 'filter-chip', 'data-tag': tag, 'aria-pressed': String(this.activeTag === tag) }, label);
      if (n != null) b.append(el(this.doc, 'span', { class: 'n', text: String(n) }));
      return b;
    };
    this.filters.replaceChildren(...(all.length ? [chip('', 'All'), ...tags.map(([t, n]) => chip(t, t, n))] : []));
    this.filters.hidden = all.length === 0;
  }

  helpers() {
    return createHelpers(this.doc, {
      urlFor: (b) => this.urlFor(b),
      tagChip: (t) => el(this.doc, 'span', { class: 'tag', part: 'tag', text: t }),
      defaultCard: (item) => this.defaultBody(this.ctrl.store.get(item.id) || item),
      icon: (name, opts) => icon(this.doc, name, opts),
    });
  }

  urlFor(blob) {
    if (!isBlob(blob)) return '';
    let u = this.urls.get(blob);
    if (!u) { u = URL.createObjectURL(blob); this.urls.set(blob, u); }
    return u;
  }

  gcUrls(items) {
    const live = new Set(items.map((i) => i.blob).filter(Boolean));
    for (const [b, u] of this.urls) if (!live.has(b)) { URL.revokeObjectURL(u); this.urls.delete(b); }
  }

  renderCard(item, helpers) {
    const d = this.doc;
    const card = el(d, 'article', {
      class: `card${item.pinned ? ' pinned' : ''}${this.fresh.has(item.id) ? ' entering' : ''}`,
      part: `card card-kind-${item.kind}`,
      'data-id': item.id,
      'data-kind': item.kind,
      tabindex: item.id === this.focusId ? '0' : '-1',
      'aria-label': `${KIND_LABEL[item.kind] || item.kind}: ${item.title || item.name || item.url || 'untitled'}${item.pinned ? ', pinned' : ''}`,
      'aria-keyshortcuts': 'Enter Delete',
    });
    let body = null;
    const renderer = this.ctrl.renderers.find(item);
    if (renderer) {
      try {
        body = toNode(d, renderer.render(publicItem(item), helpers));
        if (body) card.setAttribute('part', `card card-kind-${item.kind} card-custom`);
      } catch (err) {
        console.error('[pip-clipboard] renderer threw; using the default card', err);
        body = null;
      }
    }
    card.append(body || this.defaultBody(item));
    if (item.pinned) card.append(el(d, 'span', { class: 'pin', part: 'pin', title: 'Pinned' }, icon(d, 'pin')));
    card.append(el(d, 'button', { type: 'button', class: 'more', part: 'card-menu-button', 'aria-label': 'Actions', 'aria-haspopup': 'menu', title: 'Actions', tabindex: '-1' }, icon(d, 'more')));
    return card;
  }

  metaParts(item) {
    const m = item.meta || {};
    const src = item.source?.domain || item.source?.app || item.source?.via || '';
    switch (item.kind) {
      case 'image': return [m.width && m.height ? `${m.width}×${m.height}` : '', formatBytes(item.size) || '', src];
      case 'link': return [m.siteName && m.siteName !== m.domain ? m.siteName : '', m.domain];
      case 'text': return [`${m.words || 0} word${m.words === 1 ? '' : 's'}`, LANGUAGE_NAMES[m.language] || '', m.lines > 1 ? `${m.lines} lines` : ''];
      case 'code': return [`${m.lines || 1} line${m.lines === 1 ? '' : 's'}`, `${m.chars || 0} chars`];
      case 'html': return ['HTML', `${m.words || 0} words`, src !== 'pasted' && src !== 'dropped' ? src : ''];
      case 'file': return [(item.ext || 'file').toUpperCase(), formatBytes(item.size), item.mime || ''];
      default: return [];
    }
  }

  defaultBody(item) {
    const d = this.doc;
    const { fields } = this.config();
    const frag = d.createDocumentFragment();
    const head = el(d, 'div', { class: 'head', part: 'card-head' });
    const lead = el(d, 'div', { class: 'lead', part: 'card-icon', 'aria-hidden': 'true' });
    if (item.kind === 'link') {
      const fav = item.meta?.favicon || (this.ctrl.config.fetchLinkMeta ? faviconFor(item.url) : '');
      const letter = (item.meta?.domain || '?')[0];
      if (fav) {
        const img = el(d, 'img', { alt: '', referrerpolicy: 'no-referrer', loading: 'lazy', src: fav });
        img.addEventListener('error', () => { lead.replaceChildren(letter); }, { once: true });
        lead.append(img);
      } else lead.append(letter);
    } else if (item.kind === 'file') {
      lead.append(item.ext ? item.ext.slice(0, 4) : icon(d, 'file'));
    } else lead.append(icon(d, item.kind));
    const metaText = this.metaParts(item).filter(Boolean);
    const titles = el(d, 'div', { class: 'titles' }, el(d, 'div', { class: 'ctitle', part: 'card-title', text: this.titleOf(item) }));
    if (fields.has('meta') && metaText.length) {
      const meta = el(d, 'div', { class: 'cmeta', part: 'card-meta' });
      metaText.forEach((t, i) => { if (i) meta.append(el(d, 'span', { class: 'sep', text: '·' })); meta.append(t); });
      titles.append(meta);
    }
    head.append(lead, titles);
    frag.append(head);

    if (fields.has('preview')) {
      const prev = this.previewFor(item);
      if (prev) frag.append(prev);
    }
    if (item.kind === 'link') {
      if (fields.has('description') && item.meta?.description) frag.append(el(d, 'p', { class: 'desc', part: 'card-description', text: item.meta.description }));
      if (fields.has('url')) frag.append(el(d, 'div', { class: 'url', part: 'card-url', text: item.url }));
    }
    if (fields.has('tags') || fields.has('time')) {
      const tags = el(d, 'div', { class: 'tags', part: 'tags', 'aria-label': 'Tags' });
      if (fields.has('tags')) for (const t of item.tags || []) tags.append(el(d, 'span', { class: 'tag', part: 'tag', text: t }));
      if (fields.has('time')) {
        const time = el(d, 'time', { class: 'tag time', part: 'time', datetime: new Date(item.createdAt).toISOString(), title: new Date(item.createdAt).toLocaleString(), text: timeAgo(item.createdAt) });
        tags.append(time);
      }
      frag.append(tags);
    }
    return frag;
  }

  titleOf(item) {
    if (item.kind === 'link') return item.meta?.title || item.title || item.meta?.domain || item.url;
    if (item.kind === 'image' || item.kind === 'file') return item.name || item.title || 'Untitled';
    // Text and code show their content in the preview, so the title names what it is.
    if (item.kind === 'text') return item.meta?.userTitle || 'Text';
    if (item.kind === 'code') return item.meta?.userTitle || CODE_NAMES[item.meta?.codeLanguage] || 'Code';
    return item.title || 'Untitled';
  }

  previewFor(item) {
    const d = this.doc;
    switch (item.kind) {
      case 'image': {
        const src = item.blob ? this.urlFor(item.blob) : item.url;
        if (!src) return null;
        return el(d, 'img', { class: 'thumb', part: 'card-image card-thumb', src, alt: item.name || 'image', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
      }
      case 'link':
        if (item.meta?.image) return el(d, 'img', { class: 'thumb cover', part: 'card-image card-thumb card-og-image', src: item.meta.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
        return null;
      case 'text':
        return el(d, 'p', { class: 'preview', part: 'card-preview', text: item.text.slice(0, 1200) });
      case 'code': {
        const pre = el(d, 'pre', { class: 'code', part: 'card-code-block', 'aria-label': `${item.meta?.codeLanguage || 'code'} snippet` });
        const src = item.text.split('\n').slice(0, 40).join('\n').slice(0, 4000);
        for (const tok of highlightTokens(src, item.meta?.codeLanguage)) {
          if (tok.t === 'txt') pre.append(d.createTextNode(tok.v));
          else pre.append(el(d, 'span', { class: tok.t, text: tok.v }));
        }
        return pre;
      }
      case 'html': {
        const box = el(d, 'div', { class: 'htmlprev', part: 'card-html-preview' });
        box.append(renderSanitized(d, item.html)); // item.html was sanitised on ingest; re-sanitised here
        return box;
      }
      case 'file':
        if ((item.mime || '').startsWith('text/') && item.meta?.excerpt) return el(d, 'p', { class: 'preview', part: 'card-preview', text: item.meta.excerpt });
        return null;
      default: return null;
    }
  }

  refreshTimes() {
    for (const t of this.list.querySelectorAll('time[datetime]')) t.textContent = timeAgo(Date.parse(t.getAttribute('datetime')));
  }

  // ---------- focus + keyboard ----------

  cards() { return [...this.list.querySelectorAll('.card')]; }

  setFocus(id, move = true) {
    this.focusId = id;
    for (const c of this.cards()) c.tabIndex = c.dataset.id === id ? 0 : -1;
    if (move) this.focusCardById(id);
  }

  focusCardById(id) {
    const c = this.cards().find((x) => x.dataset.id === id);
    if (c) { c.tabIndex = 0; c.focus({ preventScroll: false }); c.scrollIntoView?.({ block: 'nearest' }); }
  }

  focusCard(index) {
    const cards = this.cards();
    if (!cards.length) return;
    const i = Math.max(0, Math.min(cards.length - 1, index));
    this.setFocus(cards[i].dataset.id);
  }

  onCardKey(e) {
    const card = e.target.closest?.('.card');
    if (!card || e.target !== card) return;
    const cards = this.cards();
    const i = cards.indexOf(card);
    const id = card.dataset.id;
    const grid = this.root.dataset.layout === 'grid';
    const cols = grid ? Math.max(1, Math.round(this.list.clientWidth / Math.max(1, card.offsetWidth))) : 1;
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); this.focusCard(i + cols); break;
      case 'ArrowUp': e.preventDefault(); if (i - cols < 0) this.searchInput.focus(); else this.focusCard(i - cols); break;
      case 'ArrowRight': e.preventDefault(); this.focusCard(i + 1); break;
      case 'ArrowLeft': e.preventDefault(); this.focusCard(i - 1); break;
      case 'Home': e.preventDefault(); this.focusCard(0); break;
      case 'End': e.preventDefault(); this.focusCard(cards.length - 1); break;
      case 'Enter': e.preventDefault(); this.primary(id); break;
      case 'Delete': case 'Backspace': e.preventDefault(); this.removeWithFocus(id, i); break;
      case ' ': case 'ContextMenu': e.preventDefault(); this.openMenu(card); break;
      case 'F10': if (e.shiftKey) { e.preventDefault(); this.openMenu(card); } break;
      case 'p': case 'P': if (!e.metaKey && !e.ctrlKey) { e.preventDefault(); this.runBuiltin('pin', id); } break;
      case 'c': case 'C': if (e.metaKey || e.ctrlKey) { e.preventDefault(); this.runBuiltin('copy', id); } break;
      default:
    }
  }

  async removeWithFocus(id, index) {
    await this.ctrl.remove(id);
    this.toast('Deleted');
    const cards = this.cards();
    if (cards.length) this.focusCard(Math.min(index, cards.length - 1));
    else this.root.focus();
  }

  /** Enter / double-click: open links and images, otherwise show the actions menu. */
  primary(id) {
    const item = this.ctrl.store.get(id);
    if (!item) return;
    if (item.kind === 'link' || (item.kind === 'image')) this.runBuiltin('open', id);
    else this.openMenu(this.cards().find((c) => c.dataset.id === id));
  }

  // ---------- menu ----------

  menuEntries(item) {
    const b = this.ctrl.builtinActions(item);
    const host = this.ctrl.actions.forItem(item);
    return { builtin: b, host };
  }

  openMenu(card) {
    if (!card) return;
    const item = this.ctrl.store.get(card.dataset.id);
    if (!item) return;
    this.closeMenu(false);
    const d = this.doc;
    const menu = el(d, 'div', { class: 'menu', part: 'menu', role: 'menu', 'aria-label': `Actions for ${this.titleOf(item)}` });
    const add = (a, kind) => {
      const btn = el(d, 'button', { type: 'button', class: `mi${a.danger ? ' danger' : ''}`, part: kind === 'host' ? 'menu-item action-button host-action' : 'menu-item action-button', role: 'menuitem', tabindex: '-1', 'data-action': a.id, 'data-host': kind === 'host' ? '1' : null }, icon(d, a.icon || (kind === 'host' ? 'action' : 'file')), el(d, 'span', { text: a.label }));
      menu.append(btn);
    };
    const { builtin, host } = this.menuEntries(item);
    builtin.filter((a) => !a.danger).forEach((a) => add(a, 'builtin'));
    if (host.length) { menu.append(el(d, 'div', { class: 'msep', part: 'menu-separator', role: 'separator' })); host.forEach((a) => add(a, 'host')); }
    const del = builtin.filter((a) => a.danger);
    if (del.length) { menu.append(el(d, 'div', { class: 'msep', part: 'menu-separator', role: 'separator' })); del.forEach((a) => add(a, 'builtin')); }

    this.root.append(menu);
    // Position under the card's menu button, kept inside the window.
    const rr = this.root.getBoundingClientRect();
    const br = card.querySelector('.more').getBoundingClientRect();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    let left = br.right - rr.left - mw;
    let top = br.bottom - rr.top + 4;
    if (top + mh > rr.height - 8) top = Math.max(8, br.top - rr.top - mh - 4);
    left = Math.max(8, Math.min(left, rr.width - mw - 8));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    card.classList.add('menu-open');
    card.querySelector('.more').setAttribute('aria-expanded', 'true');
    this.menu = menu;
    this.menuCard = card;
    const items = () => [...menu.querySelectorAll('.mi')];
    items()[0]?.focus();
    menu.addEventListener('keydown', (e) => {
      const list = items();
      const i = list.indexOf(this.shadow.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
      else if (e.key === 'Home') { e.preventDefault(); list[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); list[list.length - 1].focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.closeMenu(true); }
      else if (e.key === 'Tab') { e.preventDefault(); this.closeMenu(true); }
    });
    menu.addEventListener('click', (e) => {
      const btn = e.target.closest('.mi');
      if (!btn) return;
      const id = item.id;
      const actionId = btn.dataset.action;
      const isHost = btn.dataset.host === '1';
      this.closeMenu(!['delete'].includes(actionId));
      if (isHost) this.runHost(actionId, id);
      else this.runBuiltin(actionId, id);
    });
  }

  closeMenu(restoreFocus) {
    if (!this.menu) return;
    const card = this.menuCard;
    this.menu.remove();
    this.menu = null;
    this.menuCard = null;
    if (card) {
      card.classList.remove('menu-open');
      card.querySelector('.more')?.setAttribute('aria-expanded', 'false');
      if (restoreFocus && card.isConnected) card.focus();
    }
  }

  async runBuiltin(actionId, id) {
    const res = await this.ctrl.runBuiltin(actionId, id, this);
    if (res?.message) this.toast(res.message);
    if (actionId === 'delete') {
      const cards = this.cards();
      if (cards.length) this.focusCard(0); else this.root.focus();
    }
  }

  async runHost(actionId, id) {
    const action = this.ctrl.actions.get(actionId);
    if (!action) return;
    this.toast(`${action.label.replace(/…$/, '')}…`);
    const res = await this.ctrl.runAction(actionId, id);
    if (res.ok) this.toast(typeof res.result === 'string' && res.result ? res.result.slice(0, 120) : `${action.label.replace(/…$/, '')}: done`);
    else this.toast(`${action.label.replace(/…$/, '')} failed${res.error?.message ? `: ${String(res.error.message).slice(0, 80)}` : ''}`);
  }

  // ---------- misc ----------

  askClear() {
    const all = this.ctrl.store.list();
    const unpinned = all.filter((i) => !i.pinned).length;
    if (!unpinned) { this.toast(all.length ? 'Only pinned items left' : 'Nothing to clear'); return; }
    const pinned = all.length - unpinned;
    this.confirmText.textContent = `Delete ${unpinned} item${unpinned === 1 ? '' : 's'}?${pinned ? ` ${pinned} pinned kept.` : ''}`;
    this.confirmBar.hidden = false;
    this.confirmBar.querySelector('[data-act="clear-cancel"]').focus();
  }

  hideConfirm() {
    this.confirmBar.hidden = true;
    this.clearBtn.focus();
  }

  cycleLayout() {
    const order = ['list', 'grid', 'compact'];
    const cur = this.config().layout;
    const next = order[(order.indexOf(cur) + 1) % order.length];
    this.overrides.layout = next;
    this.layoutBtn.replaceChildren(icon(this.doc, next));
    this.applyLayout();
    this.toast(`Layout: ${next}`);
  }

  toast(msg) {
    this.toastEl.textContent = msg;
    this.win.clearTimeout(this.toastTimer);
    this.toastTimer = this.win.setTimeout(() => { this.toastEl.textContent = ''; }, 2600);
  }

  say(msg) { this.live.textContent = msg; }

  destroy() {
    this.win.clearInterval(this.timer);
    this.cleanup.forEach((f) => f());
    for (const u of this.urls.values()) URL.revokeObjectURL(u);
    this.urls.clear();
  }
}
