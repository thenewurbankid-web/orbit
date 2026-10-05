// Turn DataTransfer (drop / paste), ClipboardItem[] (navigator.clipboard.read) and host
// input (PipClipboard.add) into normalised clipboard items. Everything that arrives here
// is untrusted data: HTML is sanitised immediately and only the sanitised form is kept.

import { sanitizeToTree, serializeTree, treeToText } from './sanitize.js';
import { detectCode, detectLanguage } from './detect.js';
import { uid, isBlob, extOf, parseHttpUrl, domainOf, clampText, slugTag, uniq } from './util.js';

export const KINDS = ['image', 'link', 'text', 'code', 'html', 'file'];
const MAX_TEXT = 1024 * 1024; // keep at most 1 MB of text per item
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico)(\?|#|$)/i;

const MIME_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg',
  'image/avif': 'avif', 'image/bmp': 'bmp', 'application/pdf': 'pdf', 'text/plain': 'txt', 'text/html': 'html',
  'application/json': 'json', 'text/csv': 'csv', 'text/markdown': 'md', 'application/zip': 'zip',
};

// Clipboard / drag formats that reveal the source application.
const APP_FORMATS = [
  [/^vscode-editor-data$/, 'vscode'],
  [/google-docs/, 'google-docs'],
  [/^application\/x-vnd\.google-sheets|google-sheets/, 'google-sheets'],
  [/^text\/x-moz-url/, 'firefox'],
  [/^chromium\/x-web-custom-data$/, ''],
  [/^application\/x-slack|slack/i, 'slack'],
  [/^application\/vnd\.code-|jetbrains/i, 'ide'],
  [/^com\.apple\.notes|apple-notes/i, 'notes'],
  [/^web text\/x-figma|figma/i, 'figma'],
];

function utf8Length(s) {
  if (!s) return 0;
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
  return s.length;
}

export function baseItem(kind, via, extra = {}) {
  return {
    id: uid(),
    kind,
    createdAt: Date.now(),
    pinned: false,
    source: { via, domain: '', url: '', app: '' },
    title: '',
    text: '',
    html: '',
    url: '',
    blob: null,
    name: '',
    mime: '',
    size: 0,
    ext: '',
    meta: {},
    tags: [],
    ...extra,
  };
}

// ---- builders -----------------------------------------------------------

export function linkItem(url, { via = 'pasted', title = '' } = {}) {
  const u = parseHttpUrl(url);
  const item = baseItem('link', via);
  item.url = u ? u.href : String(url).trim();
  item.title = clampText((title || '').trim(), 300);
  item.meta.domain = domainOf(item.url);
  item.source.domain = item.meta.domain;
  item.source.url = item.url;
  item.size = utf8Length(item.url) + utf8Length(item.title);
  return item;
}

export function textItem(text, { via = 'pasted', forceKind } = {}) {
  const body = clampText(String(text ?? ''), MAX_TEXT);
  const trimmed = body.trim();
  const code = forceKind === 'text' ? { isCode: false } : detectCode(trimmed);
  const kind = forceKind || (code.isCode ? 'code' : 'text');
  const item = baseItem(kind, via);
  item.text = kind === 'code' ? body.replace(/^\s*\n|\s+$/g, '') : trimmed;
  const lines = item.text.split(/\r?\n/);
  item.meta.lines = lines.length;
  item.meta.chars = item.text.length;
  item.meta.words = (item.text.match(/\S+/g) || []).length;
  if (kind === 'code') item.meta.codeLanguage = code.language || 'code';
  else item.meta.language = detectLanguage(item.text);
  item.title = clampText((lines.find((l) => l.trim()) || '').trim(), 120);
  item.size = utf8Length(item.text);
  return item;
}

export function htmlItem(html, { via = 'pasted', plain = '' } = {}) {
  const tree = sanitizeToTree(html);
  const item = baseItem('html', via);
  item.html = serializeTree(tree);
  item.text = clampText((plain && plain.trim()) || treeToText(tree), MAX_TEXT);
  item.meta.words = (item.text.match(/\S+/g) || []).length;
  item.meta.language = detectLanguage(item.text);
  item.title = clampText((item.text.split('\n').find((l) => l.trim()) || 'HTML snippet').trim(), 120);
  item.size = utf8Length(item.html) + utf8Length(item.text);
  return item;
}

export function fileItem(file, { via = 'dropped', sourceUrl = '' } = {}) {
  const mime = (file.type || '').toLowerCase();
  const name = file.name || '';
  const ext = extOf(name) || MIME_EXT[mime] || '';
  const kind = mime.startsWith('image/') ? 'image' : 'file';
  const item = baseItem(kind, via);
  item.blob = file;
  item.name = name || (kind === 'image' ? `${via === 'pasted' ? 'pasted' : 'dropped'}-image${ext ? `.${ext}` : ''}` : 'file');
  item.mime = mime;
  item.size = typeof file.size === 'number' ? file.size : 0;
  item.ext = ext;
  item.title = item.name;
  if (typeof file.lastModified === 'number') item.meta.lastModified = file.lastModified;
  const src = parseHttpUrl(sourceUrl);
  if (src) { item.source.url = src.href; item.source.domain = domainOf(src); }
  return item;
}

export function remoteImageItem(url, { via = 'dropped', alt = '' } = {}) {
  const item = baseItem('image', via);
  const u = parseHttpUrl(url);
  item.url = u ? u.href : '';
  item.name = (u && decodeURIComponent(u.pathname.split('/').pop() || '')) || 'image';
  item.ext = extOf(item.name);
  item.title = alt || item.name;
  item.source.url = item.url;
  item.source.domain = domainOf(item.url);
  item.size = 0;
  return item;
}

// ---- helpers ------------------------------------------------------------

export function parseUriList(s) {
  if (!s) return [];
  return s.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).filter((l) => parseHttpUrl(l));
}

function appFromTypes(types) {
  for (const t of types) for (const [re, app] of APP_FORMATS) if (app && re.test(t)) return app;
  return '';
}

const RICH_TAGS = new Set(['a', 'b', 'strong', 'i', 'em', 'u', 's', 'ul', 'ol', 'li', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'img', 'blockquote', 'pre', 'code', 'mark', 'del', 'ins', 'sub', 'sup', 'dl']);

function treeStats(tree) {
  const stats = { rich: 0, anchors: [], imgs: 0, blocks: 0, textLen: 0 };
  const walk = (n) => {
    if (n.type === 'text') { stats.textLen += n.value.trim().length; return; }
    if (n.type === 'el') {
      if (RICH_TAGS.has(n.tag)) stats.rich++;
      if (n.tag === 'a') stats.anchors.push(n);
      if (n.tag === 'img') stats.imgs++;
      if (n.tag === 'p' || n.tag === 'div') stats.blocks++;
    }
    n.children?.forEach(walk);
  };
  walk(tree);
  return stats;
}

function rawImgSrc(html) {
  const m = /<img\b[^>]*\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(html || '');
  if (!m) return '';
  const src = m[2] ?? m[3] ?? m[4] ?? '';
  return parseHttpUrl(src) ? src : '';
}

function rawImgAlt(html) {
  const m = /<img\b[^>]*\balt\s*=\s*("([^"]*)"|'([^']*)')/i.exec(html || '');
  return m ? (m[2] ?? m[3] ?? '') : '';
}

function onlyUrls(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length || lines.length > 20) return null;
  return lines.every((l) => parseHttpUrl(l)) ? lines : null;
}

/** Classify a plain string into link(s), code or text items. */
export function fromText(text, { via = 'pasted', title = '' } = {}) {
  const s = String(text ?? '');
  if (!s.trim()) return [];
  const urls = onlyUrls(s);
  if (urls) return urls.map((u) => (IMAGE_EXT.test(u) ? remoteImageItem(u, { via }) : linkItem(u, { via, title: urls.length === 1 ? title : '' })));
  return [textItem(s, { via })];
}

function getData(dt, type) {
  try { return dt.getData(type) || ''; } catch { return ''; }
}

/**
 * Normalise a DataTransfer (from a drop or paste event) synchronously. Must be called
 * inside the event handler: the browser empties the DataTransfer afterwards.
 * Accepts anything shaped like a DataTransfer ({ types, files, getData }).
 */
export function fromDataTransfer(dt, { via = 'dropped' } = {}) {
  if (!dt) return [];
  const types = Array.from(dt.types || []);
  const files = Array.from(dt.files || []).filter(isBlob);
  const app = appFromTypes(types);
  const html = types.includes('text/html') ? getData(dt, 'text/html') : '';
  const plain = getData(dt, 'text/plain') || getData(dt, 'Text');
  let uris = parseUriList(getData(dt, 'text/uri-list') || getData(dt, 'URL'));
  let mozTitle = '';
  const moz = getData(dt, 'text/x-moz-url');
  if (moz) {
    const [u, t] = moz.split(/\r?\n/);
    if (!uris.length && parseHttpUrl(u)) uris = [u.trim()];
    mozTitle = (t || '').trim();
  }

  const finish = (items) => items.map((it) => {
    if (app && !it.source.app) it.source.app = app;
    return it;
  });

  // 1. Files (any type). A dragged web image arrives as a file plus its URL.
  if (files.length) {
    const sourceUrl = files.length === 1 ? (rawImgSrc(html) || uris[0] || '') : '';
    return finish(files.map((f) => fileItem(f, { via, sourceUrl })));
  }

  const tree = html ? sanitizeToTree(html) : null;
  const stats = tree ? treeStats(tree) : null;

  // 2. Links / remote images.
  if (uris.length) {
    const imgSrc = rawImgSrc(html);
    if (uris.length === 1 && (IMAGE_EXT.test(uris[0]) || (imgSrc && stats.imgs === 1 && stats.textLen === 0))) {
      return finish([remoteImageItem(imgSrc || uris[0], { via, alt: rawImgAlt(html) })]);
    }
    const anchorText = stats?.anchors.length === 1 ? treeToText({ type: 'root', children: stats.anchors[0].children }) : '';
    const title = mozTitle || (anchorText && !parseHttpUrl(anchorText) ? anchorText : '') || (plain && !parseHttpUrl(plain.trim()) && uris.length === 1 && plain.length < 300 ? plain.trim() : '');
    return finish(uris.map((u) => linkItem(u, { via, title: uris.length === 1 ? title : '' })));
  }

  // 3. HTML selections.
  if (tree) {
    const text = (plain || treeToText(tree)).trim();
    if (!text && stats.imgs === 0) return [];
    // A lone anchor is a link.
    if (stats.anchors.length === 1 && stats.rich === 1 && stats.blocks <= 1) {
      const href = stats.anchors[0].attrs.href;
      const anchorText = treeToText({ type: 'root', children: stats.anchors[0].children });
      if (href && parseHttpUrl(href) && (!anchorText || text === anchorText.trim() || text === href)) {
        return finish([linkItem(href, { via, title: anchorText !== href ? anchorText : '' })]);
      }
    }
    // Code copied from an editor arrives as styled <div>/<span> soup: prefer the code card.
    const code = detectCode(text);
    if (code.isCode && (app === 'vscode' || app === 'ide' || stats.rich === 0 || (stats.rich <= 2 && /<(pre|code)\b/i.test(html)))) {
      const it = textItem(text, { via });
      it.kind = 'code';
      it.meta.codeLanguage = code.language || it.meta.codeLanguage || 'code';
      delete it.meta.language;
      return finish([it]);
    }
    if (stats.rich > 0 || stats.blocks > 1) return finish([htmlItem(html, { via, plain })]);
    return finish(fromText(text, { via }));
  }

  // 4. Plain text.
  return finish(fromText(plain, { via }));
}

/**
 * Normalise the result of navigator.clipboard.read(). Accepts ClipboardItem-like objects
 * ({ types, getType(type) => Promise<Blob> }).
 */
export async function fromClipboardItems(clipItems, { via = 'pasted' } = {}) {
  const out = [];
  for (const ci of clipItems || []) {
    const types = Array.from(ci.types || []);
    const imageType = types.find((t) => t.startsWith('image/'));
    if (imageType) {
      const blob = await ci.getType(imageType);
      const ext = MIME_EXT[imageType] || 'png';
      const file = withName(blob, `pasted-image.${ext}`, imageType);
      out.push(fileItem(file, { via }));
      continue;
    }
    const data = {};
    for (const t of types) {
      if (t.startsWith('text/') || t === 'web text/uri-list') {
        try { data[t.replace(/^web /, '')] = await (await ci.getType(t)).text(); } catch { /* skip */ }
      }
    }
    const fake = { types: Object.keys(data), files: [], getData: (t) => data[t] || '' };
    out.push(...fromDataTransfer(fake, { via }));
  }
  return out;
}

function withName(blob, name, type) {
  if (blob && blob.name) return blob;
  try { return new File([blob], name, { type: type || blob.type }); } catch {
    // Older engines without the File constructor: annotate the Blob.
    return Object.assign(blob, { name });
  }
}

/**
 * Normalise host input for PipClipboard.add(). Accepts a string, a Blob/File, or an
 * object { text | url | html | blob | file, title?, name?, kind?, tags?, source? }.
 */
export function fromInput(input, { via = 'added' } = {}) {
  if (input == null) return [];
  if (typeof input === 'string') return fromText(input, { via });
  if (isBlob(input)) return [fileItem(input, { via })];
  if (typeof input !== 'object') return fromText(String(input), { via });
  let items = [];
  const blob = input.blob || input.file;
  if (blob && isBlob(blob)) {
    const f = input.name && !blob.name ? withName(blob, input.name, input.mime) : blob;
    items = [fileItem(f, { via, sourceUrl: input.sourceUrl || input.url || '' })];
  } else if (input.url && (input.kind === 'image' || (!input.kind && IMAGE_EXT.test(input.url)))) {
    items = [remoteImageItem(input.url, { via, alt: input.title || '' })];
  } else if (input.url) {
    items = [linkItem(input.url, { via, title: input.title || '' })];
  } else if (input.html) {
    items = [htmlItem(input.html, { via, plain: input.text || '' })];
  } else if (typeof input.text === 'string') {
    items = input.kind === 'code' || input.kind === 'text' ? [textItem(input.text, { via, forceKind: input.kind })] : fromText(input.text, { via });
    if (input.kind === 'code' && input.language) items[0].meta.codeLanguage = String(input.language);
  }
  for (const it of items) {
    if (input.title && it.kind !== 'link') {
      it.title = clampText(String(input.title), 300);
      it.meta.userTitle = it.title;
    }
    if (Array.isArray(input.tags)) it.extraTags = input.tags.map(slugTag).filter(Boolean);
    if (input.source && typeof input.source === 'object') {
      for (const k of ['domain', 'url', 'app']) if (typeof input.source[k] === 'string') it.source[k] = input.source[k];
    }
    if (input.pinned) it.pinned = true;
  }
  return items;
}

// ---- tagging ------------------------------------------------------------

export function sourceTag(item) {
  return item.source.domain || item.source.app || item.source.via || 'pasted';
}

/** Automatic tags: type (+ extension / code language) and source. */
export function autoTags(item) {
  const tags = [item.kind];
  if (item.kind === 'code') tags.push(item.meta.codeLanguage);
  if ((item.kind === 'file' || item.kind === 'image') && item.ext) tags.push(item.ext);
  tags.push(sourceTag(item));
  if (item.extraTags) tags.push(...item.extraTags);
  return uniq(tags.map(slugTag));
}

/** Run autoTags plus host taggers. A throwing tagger is skipped. */
export function computeTags(item, taggers = []) {
  const tags = autoTags(item);
  for (const tagger of taggers) {
    try {
      const extra = tagger(publicItem(item));
      if (Array.isArray(extra)) tags.push(...extra.filter((t) => typeof t === 'string').map(slugTag));
    } catch (err) {
      console.error('[pip-clipboard] tagger threw', err);
    }
  }
  return uniq(tags);
}

/** A defensive copy handed to host code (actions, renderers, taggers, events). */
export function publicItem(item) {
  return {
    ...item,
    source: { ...item.source },
    meta: { ...item.meta },
    tags: [...(item.tags || [])],
  };
}

export function itemBytes(item) {
  let n = 0;
  if (item.blob && typeof item.blob.size === 'number') n += item.blob.size;
  n += utf8Length(item.text) + utf8Length(item.html) + utf8Length(item.url) + utf8Length(item.title);
  return n;
}
