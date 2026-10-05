// Strict allowlist HTML sanitiser.
//
// Untrusted HTML is tokenised by a small parser and rebuilt as a tree that can only
// contain allowlisted tags and attributes. Text is always kept as text (escaped on
// serialisation, set through textContent when rendered), so a parsing mistake can at
// worst garble the preview; it can never produce markup we did not emit ourselves.
//
// No DOM is needed, which keeps it testable in Node and independent of the realm
// (main window or Document Picture-in-Picture window) that renders it.

const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'blockquote', 'br', 'caption', 'cite', 'code', 'dd', 'del', 'dfn',
  'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img',
  'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'u', 'ul', 'var', 'wbr',
]);

const VOID_TAGS = new Set(['br', 'hr', 'img', 'wbr', 'area', 'base', 'col', 'embed', 'input', 'link', 'meta', 'param', 'source', 'track', 'keygen']);

// Elements whose whole content is dropped.
const DROP_CONTENT = new Set([
  'script', 'style', 'template', 'iframe', 'object', 'embed', 'noscript', 'noembed', 'noframes', 'textarea',
  'select', 'option', 'svg', 'math', 'head', 'title', 'xmp', 'frameset', 'frame', 'applet', 'canvas',
  'audio', 'video', 'button', 'form', 'input', 'dialog', 'plaintext', 'meta', 'link', 'base',
]);

// Elements whose content is raw text up to the matching end tag.
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext']);

const GLOBAL_ATTRS = new Set(['title', 'lang', 'dir']);
const TAG_ATTRS = {
  a: new Set(['href']),
  img: new Set(['src', 'alt', 'width', 'height']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan', 'scope']),
  ol: new Set(['start', 'reversed']),
  time: new Set(['datetime']),
  abbr: new Set(['title']),
  q: new Set(['cite']),
  blockquote: new Set(['cite']),
};

const LIMITS = { maxInput: 256 * 1024, maxNodes: 4000, maxDepth: 48 };

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“',
  rdquo: '”', bull: '•', middot: '·', trade: '™', times: '×', euro: '€',
  tab: '\t', newline: '\n', colon: ':', lpar: '(', rpar: ')', sol: '/', semi: ';',
};

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);?/gi, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
      return String.fromCodePoint(code);
    }
    const v = NAMED_ENTITIES[body.toLowerCase()];
    return v === undefined ? m : v;
  });
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Returns a safe, absolute URL string or null.
export function safeUrl(value, { allowDataImage = false, allowMailto = true } = {}) {
  if (typeof value !== 'string') return null;
  // Remove whitespace and control characters browsers ignore inside schemes ("java\nscript:").
  const v = decodeEntities(value).replace(/[\u0000- \u007f-\u009f]+/g, '');
  if (!v) return null;
  if (allowDataImage && /^data:image\/(png|jpeg|jpg|gif|webp|avif);base64,[a-z0-9+/=]+$/i.test(v)) return v;
  let u;
  try { u = new URL(v); } catch { return null; } // relative URLs are dropped: there is no base to resolve against
  if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
  if (allowMailto && u.protocol === 'mailto:') return u.href;
  return null;
}

// ---- tokeniser ----------------------------------------------------------

function* tokenize(html) {
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) { yield { type: 'text', value: html.slice(i) }; return; }
    if (lt > i) yield { type: 'text', value: html.slice(i, lt) };
    i = lt;
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (html[i + 1] === '!' || html[i + 1] === '?') {
      const end = html.indexOf('>', i + 2);
      i = end === -1 ? n : end + 1;
      continue;
    }
    const isEnd = html[i + 1] === '/';
    const nameStart = i + (isEnd ? 2 : 1);
    const m = /^[a-zA-Z][a-zA-Z0-9:-]*/.exec(html.slice(nameStart, nameStart + 64));
    if (!m) { yield { type: 'text', value: '<' }; i += 1; continue; }
    const name = m[0].toLowerCase();
    let j = nameStart + m[0].length;
    const attrs = [];
    let selfClosing = false;
    // attributes
    while (j < n) {
      while (j < n && /[\s/]/.test(html[j])) { if (html[j] === '/' && html[j + 1] === '>') selfClosing = true; j++; }
      if (j >= n) break;
      if (html[j] === '>') { j++; break; }
      const an = /^[^\s/>="'<]+/.exec(html.slice(j, j + 256));
      if (!an) { j++; continue; }
      const attrName = an[0].toLowerCase();
      j += an[0].length;
      while (j < n && /\s/.test(html[j])) j++;
      let value = '';
      if (html[j] === '=') {
        j++;
        while (j < n && /\s/.test(html[j])) j++;
        const q = html[j];
        if (q === '"' || q === "'") {
          const end = html.indexOf(q, j + 1);
          value = html.slice(j + 1, end === -1 ? n : end);
          j = end === -1 ? n : end + 1;
        } else {
          const um = /^[^\s>]*/.exec(html.slice(j));
          value = um[0];
          j += value.length;
        }
      }
      attrs.push([attrName, value]);
    }
    i = j;
    if (isEnd) { yield { type: 'end', name }; continue; }
    yield { type: 'start', name, attrs, selfClosing };
    if (RAW_TEXT.has(name)) {
      if (name === 'plaintext') return;
      const re = new RegExp(`</${name}[\\s/>]`, 'i');
      const rest = html.slice(i);
      const mm = re.exec(rest);
      const end = mm ? i + mm.index : n;
      yield { type: 'raw', name, value: html.slice(i, end) };
      i = end;
    }
  }
}

// ---- tree builder -------------------------------------------------------

function cleanAttrs(tag, attrs) {
  const out = {};
  const allowed = TAG_ATTRS[tag];
  for (const [name, raw] of attrs) {
    if (!(GLOBAL_ATTRS.has(name) || allowed?.has(name))) continue;
    if (name in out) continue;
    let value = decodeEntities(raw);
    if (tag === 'a' && name === 'href') {
      value = safeUrl(raw);
      if (!value) continue;
    } else if (tag === 'img' && name === 'src') {
      // Remote images are not loaded in previews (they can track); only inline data images are kept.
      value = safeUrl(raw, { allowDataImage: true, allowMailto: false });
      if (!value || !value.startsWith('data:')) continue;
    } else if (name === 'cite') {
      value = safeUrl(raw, { allowMailto: false });
      if (!value) continue;
    } else if (['width', 'height', 'colspan', 'rowspan', 'start'].includes(name)) {
      if (!/^\d{1,4}$/.test(value.trim())) continue;
      value = value.trim();
    } else if (name === 'dir') {
      if (!/^(ltr|rtl|auto)$/i.test(value)) continue;
    } else if (name === 'reversed') {
      value = '';
    } else {
      value = value.slice(0, 500);
    }
    out[name] = value;
  }
  return out;
}

/**
 * Sanitise untrusted HTML into a tree of
 *   { type: 'el', tag, attrs, children } | { type: 'text', value }
 */
export function sanitizeToTree(html) {
  const root = { type: 'root', children: [] };
  if (typeof html !== 'string' || !html) return root;
  const input = html.length > LIMITS.maxInput ? html.slice(0, LIMITS.maxInput) : html;
  const stack = [root];
  let dropDepth = 0; // > 0 while inside a dropped element
  const dropStack = [];
  let nodes = 0;
  const top = () => stack[stack.length - 1];

  for (const tok of tokenize(input)) {
    if (nodes > LIMITS.maxNodes) break;
    if (tok.type === 'raw') continue; // raw text of script/style/... always dropped
    if (dropDepth > 0) {
      if (tok.type === 'start' && tok.name === dropStack[dropStack.length - 1] && !VOID_TAGS.has(tok.name) && !tok.selfClosing) {
        dropDepth++; dropStack.push(tok.name);
      } else if (tok.type === 'end' && tok.name === dropStack[dropStack.length - 1]) {
        dropDepth--; dropStack.pop();
      }
      continue;
    }
    if (tok.type === 'text') {
      const value = decodeEntities(tok.value);
      if (!value) continue;
      const parent = top();
      const last = parent.children[parent.children.length - 1];
      if (last && last.type === 'text') last.value += value;
      else { parent.children.push({ type: 'text', value }); nodes++; }
      continue;
    }
    if (tok.type === 'start') {
      const { name } = tok;
      if (DROP_CONTENT.has(name)) {
        if (!VOID_TAGS.has(name) && !tok.selfClosing && !RAW_TEXT.has(name)) { dropDepth = 1; dropStack.length = 0; dropStack.push(name); }
        continue;
      }
      if (!ALLOWED_TAGS.has(name)) continue; // unwrap: drop the tag, keep its children
      if (stack.length > LIMITS.maxDepth) continue;
      const el = { type: 'el', tag: name, attrs: cleanAttrs(name, tok.attrs), children: [] };
      top().children.push(el);
      nodes++;
      if (!VOID_TAGS.has(name) && !tok.selfClosing) stack.push(el);
      continue;
    }
    if (tok.type === 'end') {
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tag === tok.name) { stack.length = k; break; }
      }
    }
  }
  return root;
}

export function serializeTree(node) {
  if (node.type === 'text') return escapeHtml(node.value);
  const inner = node.children.map(serializeTree).join('');
  if (node.type === 'root') return inner;
  const attrs = Object.entries(node.attrs)
    .map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${escapeHtml(v)}"`))
    .join('');
  const extra = node.tag === 'a' ? ' rel="noopener noreferrer" target="_blank"' : '';
  if (VOID_TAGS.has(node.tag)) return `<${node.tag}${attrs}${extra}>`;
  return `<${node.tag}${attrs}${extra}>${inner}</${node.tag}>`;
}

const BLOCK = new Set(['p', 'div', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'figure', 'figcaption', 'dt', 'dd', 'table', 'ul', 'ol', 'hr', 'caption']);

export function treeToText(node) {
  let out = '';
  const walk = (n) => {
    if (n.type === 'text') { out += n.value; return; }
    if (n.type === 'el' && n.tag === 'br') { out += '\n'; return; }
    if (n.type === 'el' && (n.tag === 'td' || n.tag === 'th') && !/[\s]$/.test(out)) out += out ? '\t' : '';
    n.children?.forEach(walk);
    if (n.type === 'el' && BLOCK.has(n.tag) && !out.endsWith('\n')) out += '\n';
  };
  walk(node);
  return out.replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Sanitise HTML and return a safe HTML string (only allowlisted markup). */
export function sanitizeHtml(html) {
  return serializeTree(sanitizeToTree(html));
}

export function htmlToText(html) {
  return treeToText(sanitizeToTree(html));
}

/**
 * Build DOM nodes for a sanitised tree in the given document, using createElement and
 * textContent only (no innerHTML). Accepts a tree or an HTML string (sanitised first).
 */
export function renderSanitized(doc, input) {
  const tree = typeof input === 'string' ? sanitizeToTree(input) : input;
  const frag = doc.createDocumentFragment();
  const build = (n, parent) => {
    if (n.type === 'text') { parent.appendChild(doc.createTextNode(n.value)); return; }
    const el = doc.createElement(n.tag);
    for (const [k, v] of Object.entries(n.attrs)) el.setAttribute(k, v);
    if (n.tag === 'a') { el.setAttribute('rel', 'noopener noreferrer'); el.setAttribute('target', '_blank'); }
    if (n.tag === 'img') { el.setAttribute('referrerpolicy', 'no-referrer'); el.setAttribute('loading', 'lazy'); }
    n.children.forEach((c) => build(c, el));
    parent.appendChild(el);
  };
  tree.children.forEach((c) => build(c, frag));
  return frag;
}

export const SANITIZER_ALLOWLIST = { tags: [...ALLOWED_TAGS], globalAttrs: [...GLOBAL_ATTRS], tagAttrs: Object.fromEntries(Object.entries(TAG_ATTRS).map(([k, v]) => [k, [...v]])) };
