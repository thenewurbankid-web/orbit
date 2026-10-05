// Small, dependency-free helpers shared by the widget modules.
// Everything here works in Node (for tests) and in any browser realm.

let counter = 0;
export function uid() {
  const rnd = globalThis.crypto?.randomUUID?.();
  if (rnd) return rnd;
  counter += 1;
  return `pc-${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Cross-realm safe Blob/File check (the PiP window is a different realm, so instanceof fails).
export function isBlob(v) {
  if (!v || typeof v !== 'object') return false;
  const tag = Object.prototype.toString.call(v);
  if (tag === '[object Blob]' || tag === '[object File]') return true;
  return typeof v.size === 'number' && typeof v.type === 'string' && typeof v.slice === 'function' && typeof v.arrayBuffer === 'function';
}

export function extOf(name = '') {
  const clean = String(name).split(/[?#]/)[0];
  const base = clean.split('/').pop() || '';
  const i = base.lastIndexOf('.');
  if (i <= 0 || i === base.length - 1) return '';
  const ext = base.slice(i + 1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : '';
}

export function formatBytes(n) {
  if (typeof n !== 'number' || !isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u += 1; }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

export function timeAgo(ts, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toISOString().slice(0, 10);
}

// Parse an absolute http(s) URL; returns a URL or null. Never resolves relative URLs.
export function parseHttpUrl(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (!/^https?:\/\//i.test(t) || /\s/.test(t)) return null;
  try {
    const u = new URL(t);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch { return null; }
}

export function domainOf(url) {
  const u = typeof url === 'string' ? parseHttpUrl(url) : url;
  return u ? u.hostname.replace(/^www\./, '') : '';
}

export function clampText(s, max) {
  if (typeof s !== 'string') return '';
  return s.length > max ? s.slice(0, max) : s;
}

export function slugTag(s) {
  return String(s).toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9._:+#-]/g, '').slice(0, 40);
}

export function uniq(arr) {
  return [...new Set(arr.filter(Boolean))];
}
