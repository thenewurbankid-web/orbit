// Best-effort link previews. Most sites do not send CORS headers, so the fetch usually
// fails and the card falls back to domain + URL. There is deliberately no proxy.

import { safeUrl } from './sanitize.js';
import { clampText } from './util.js';

const cache = new Map();

/** Parse <head> metadata out of an HTML string (DOMParser does not run scripts). */
export function parseMeta(htmlText, pageUrl, DOMParserImpl = globalThis.DOMParser) {
  if (!DOMParserImpl) return {};
  const doc = new DOMParserImpl().parseFromString(htmlText, 'text/html');
  const pick = (...sels) => {
    for (const s of sels) {
      const el = doc.querySelector(s);
      const v = el && (el.getAttribute('content') || el.getAttribute('href') || el.textContent);
      if (v && v.trim()) return v.trim();
    }
    return '';
  };
  const abs = (u) => {
    if (!u) return '';
    try { return safeUrl(new URL(u, pageUrl).href, { allowMailto: false }) || ''; } catch { return ''; }
  };
  return {
    title: clampText(pick('meta[property="og:title"]', 'meta[name="twitter:title"]', 'title'), 300),
    description: clampText(pick('meta[property="og:description"]', 'meta[name="description"]', 'meta[name="twitter:description"]'), 500),
    image: abs(pick('meta[property="og:image"]', 'meta[name="twitter:image"]', 'meta[property="og:image:url"]')),
    siteName: clampText(pick('meta[property="og:site_name"]'), 100),
    favicon: abs(pick('link[rel="icon"]', 'link[rel="shortcut icon"]', 'link[rel="apple-touch-icon"]')),
  };
}

export async function fetchLinkMeta(url, { timeout = 5000, fetchImpl = globalThis.fetch } = {}) {
  if (cache.has(url)) return cache.get(url);
  const p = (async () => {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeout) : null;
    try {
      const res = await fetchImpl(url, {
        mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'follow', signal: ctrl?.signal,
        headers: { Accept: 'text/html' },
      });
      if (!res.ok || !/text\/html|application\/xhtml/i.test(res.headers.get('content-type') || '')) return { ok: false };
      const text = (await res.text()).slice(0, 512 * 1024);
      return { ok: true, ...parseMeta(text, res.url || url) };
    } catch {
      return { ok: false };
    } finally {
      if (timer) clearTimeout(timer);
    }
  })();
  cache.set(url, p);
  return p;
}

export function faviconFor(url) {
  try {
    const u = new URL(url);
    return `${u.origin}/favicon.ico`;
  } catch { return ''; }
}
