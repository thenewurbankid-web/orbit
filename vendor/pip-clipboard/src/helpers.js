// Safe building blocks handed to custom card renderers. Renderers never receive raw
// untrusted HTML: item.html is already sanitised, and these helpers only create markup
// through createElement/textContent, the allowlist sanitiser, or the escaping html`` tag.

import { renderSanitized, escapeHtml, safeUrl } from './sanitize.js';
import { formatBytes, timeAgo, isBlob } from './util.js';

const SAFE = Symbol('pip-clipboard.safe-html'); // module-private: SafeHTML cannot be forged from outside
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'poster', 'srcset', 'background', 'cite', 'data']);

export class SafeHTML {
  constructor(s) { this[SAFE] = String(s); }
  toString() { return this[SAFE]; }
}
export const isSafeHTML = (v) => Boolean(v && typeof v === 'object' && SAFE in v);

/**
 * Tagged template: static parts are trusted (your code), every ${value} is escaped.
 * Nest html`` results or arrays of them to compose.
 */
export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => {
    out += interp(v) + strings[i + 1];
  });
  return new SafeHTML(out);
}
function interp(v) {
  if (v == null || v === false) return '';
  if (Array.isArray(v)) return v.map(interp).join('');
  if (isSafeHTML(v)) return v[SAFE];
  return escapeHtml(String(v));
}

function safeAttrUrl(name, value) {
  const v = String(value);
  if (/^blob:/i.test(v.trim())) return v.trim();
  return safeUrl(v, { allowDataImage: true, allowMailto: name === 'href' });
}

/** Remove event handler attributes, scripts and unsafe URLs from a fragment built from author templates. */
export function scrub(root) {
  const walker = (root.ownerDocument || root).createTreeWalker(root, 1 /* SHOW_ELEMENT */);
  const kill = [];
  let n = walker.nextNode();
  while (n) {
    const tag = n.localName;
    if (tag === 'script' || tag === 'iframe' || tag === 'object' || tag === 'embed' || tag === 'base' || tag === 'meta' || tag === 'link') kill.push(n);
    for (const attr of [...n.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc' || name === 'formaction') n.removeAttribute(attr.name);
      else if (URL_ATTRS.has(name)) {
        const ok = safeAttrUrl(name, attr.value);
        if (!ok) n.removeAttribute(attr.name);
      }
    }
    if (tag === 'a') { n.setAttribute('rel', 'noopener noreferrer'); if (!n.getAttribute('target')) n.setAttribute('target', '_blank'); }
    n = walker.nextNode();
  }
  kill.forEach((k) => k.remove());
  return root;
}

/** Convert a renderer's return value into a Node in `doc`, enforcing the safety rules. */
export function toNode(doc, out) {
  if (out == null || out === false) return null;
  if (typeof out === 'string') return renderSanitized(doc, out); // plain strings are untrusted: sanitised
  if (isSafeHTML(out)) {
    const tpl = doc.createElement('template');
    tpl.innerHTML = out[SAFE]; // author markup with escaped interpolations only
    return scrub(doc.importNode(tpl.content, true));
  }
  if (typeof out === 'object' && typeof out.nodeType === 'number') {
    if (out.nodeName === 'TEMPLATE') return scrub(doc.importNode(out.content, true));
    return scrub(out);
  }
  return null;
}

/**
 * Build the helpers object for one document (main page or PiP window).
 *   urlFor(blob) returns a cached object URL that the view revokes when the item goes away.
 */
export function createHelpers(doc, { urlFor, tagChip, defaultCard, icon } = {}) {
  function h(tag, props, ...children) {
    if (typeof tag !== 'string' || !/^[a-z][a-z0-9-]*$/i.test(tag) || /^(script|iframe|object|embed|base|meta|link|style)$/i.test(tag)) {
      throw new TypeError(`h(): tag "${tag}" is not allowed`);
    }
    const el = doc.createElement(tag);
    if (props && (typeof props !== 'object' || typeof props.nodeType === 'number' || Array.isArray(props) || isSafeHTML(props))) {
      children.unshift(props);
      props = null;
    }
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      const name = k === 'className' ? 'class' : k;
      if (/^on/i.test(name) || name === 'innerHTML' || name === 'outerHTML' || name === 'srcdoc') {
        throw new TypeError(`h(): "${k}" is not allowed; add listeners with addEventListener`);
      }
      if (URL_ATTRS.has(name.toLowerCase())) {
        const ok = safeAttrUrl(name, v);
        if (ok) el.setAttribute(name, ok);
        continue;
      }
      if (name === 'style' && typeof v === 'object') { Object.assign(el.style, v); continue; }
      el.setAttribute(name, v === true ? '' : String(v));
    }
    if (tag === 'a') el.setAttribute('rel', 'noopener noreferrer');
    if (tag === 'a' && !el.getAttribute('target')) el.setAttribute('target', '_blank');
    append(el, children);
    return el;
  }

  function append(el, children) {
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      if (typeof c === 'object' && typeof c.nodeType === 'number') el.appendChild(c);
      else if (isSafeHTML(c)) el.appendChild(toNode(doc, c));
      else el.appendChild(doc.createTextNode(String(c)));
    }
  }

  function thumbnail(source, { alt = '', part = 'card-image' } = {}) {
    const img = doc.createElement('img');
    img.alt = alt;
    img.decoding = 'async';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.setAttribute('part', part);
    if (isBlob(source)) {
      img.src = urlFor ? urlFor(source) : URL.createObjectURL(source);
    } else if (typeof source === 'string') {
      const ok = safeAttrUrl('src', source);
      if (ok) img.src = ok;
    }
    return img;
  }

  return Object.freeze({
    h,
    html,
    sanitize: (untrustedHtml) => renderSanitized(doc, String(untrustedHtml ?? '')),
    text: (s) => doc.createTextNode(String(s ?? '')),
    thumbnail,
    formatBytes,
    timeAgo,
    tag: tagChip || ((t) => h('span', { part: 'tag', class: 'tag' }, t)),
    icon: icon || (() => h('span')),
    defaultCard: defaultCard || (() => null),
    safeUrl: (u) => safeUrl(String(u ?? '')),
    document: doc,
  });
}
