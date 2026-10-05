// Theme tokens. Every visual value in the widget reads a --pipc-* custom property with the
// dark default as fallback, so tokens can come from any ancestor (inheritance crosses the
// shadow boundary), from setTheme() (inline on the window host), or from addStyles().

export const TOKENS = {
  '--pipc-bg': ['#000000', 'Window background'],
  '--pipc-surface': ['#0b0b0c', 'Toolbar, inputs and menus'],
  '--pipc-fg': ['#f4f4f5', 'Main text'],
  '--pipc-muted': ['#8d8d93', 'Secondary text (meta lines)'],
  '--pipc-faint': ['#5c5c62', 'Tertiary text and icons'],
  '--pipc-border': ['#1f1f23', 'Window and control borders'],
  '--pipc-card-bg': ['#0f0f11', 'Card background'],
  '--pipc-card-border': ['#1e1e22', 'Card border'],
  '--pipc-card-hover': ['#151518', 'Card background on hover / focus'],
  '--pipc-accent': ['#f4f4f5', 'Primary button and active chip background'],
  '--pipc-accent-fg': ['#000000', 'Text on accent'],
  '--pipc-danger': ['#f2766b', 'Destructive actions'],
  '--pipc-tag-bg': ['#18181b', 'Tag chip background'],
  '--pipc-tag-fg': ['#b0b0b6', 'Tag chip text'],
  '--pipc-focus': ['rgba(255,255,255,0.72)', 'Focus ring colour'],
  '--pipc-shadow': ['0 16px 48px rgba(0,0,0,0.55)', 'Floating panel / menu shadow'],
  '--pipc-overlay': ['rgba(0,0,0,0.78)', 'Drop overlay and confirm backdrop'],
  '--pipc-radius': ['12px', 'Card and window radius'],
  '--pipc-radius-sm': ['8px', 'Chips, buttons and inputs radius'],
  '--pipc-space': ['8px', 'Base spacing unit (paddings are multiples of it)'],
  '--pipc-gap': ['8px', 'Gap between cards'],
  '--pipc-card-pad': ['10px', 'Card inner padding'],
  '--pipc-card-min': ['200px', 'Minimum card width (grid column minimum)'],
  '--pipc-card-max': ['100%', 'Maximum card width'],
  '--pipc-thumb-h': ['148px', 'Image / og:image preview height'],
  '--pipc-font': ['ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif', 'UI font'],
  '--pipc-mono': ['ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace', 'Code font'],
  '--pipc-font-size': ['13px', 'Base font size'],
  '--pipc-code-bg': ['#0a0a0b', 'Code block background'],
  '--pipc-code-kw': ['#d6c7ff', 'Code keyword'],
  '--pipc-code-str': ['#b5cea8', 'Code string'],
  '--pipc-code-com': ['#6a6a72', 'Code comment'],
  '--pipc-code-num': ['#e5c07b', 'Code number'],
  '--pipc-duration': ['140ms', 'Transition duration (0ms under prefers-reduced-motion)'],
};

export const THEMES = {
  dark: {},
  light: {
    '--pipc-bg': '#f7f7f8',
    '--pipc-surface': '#ffffff',
    '--pipc-fg': '#141416',
    '--pipc-muted': '#66666d',
    '--pipc-faint': '#9a9aa1',
    '--pipc-border': '#e3e3e7',
    '--pipc-card-bg': '#ffffff',
    '--pipc-card-border': '#e6e6ea',
    '--pipc-card-hover': '#f3f3f5',
    '--pipc-accent': '#141416',
    '--pipc-accent-fg': '#ffffff',
    '--pipc-danger': '#c2392b',
    '--pipc-tag-bg': '#f0f0f2',
    '--pipc-tag-fg': '#45454c',
    '--pipc-focus': 'rgba(20,20,22,0.65)',
    '--pipc-shadow': '0 16px 48px rgba(0,0,0,0.12)',
    '--pipc-overlay': 'rgba(255,255,255,0.84)',
    '--pipc-code-bg': '#f6f6f8',
    '--pipc-code-kw': '#6f42c1',
    '--pipc-code-str': '#2f6f3e',
    '--pipc-code-com': '#8a8a92',
    '--pipc-code-num': '#9a6200',
  },
};

/** Normalise setTheme input to a map of '--pipc-*' -> value. */
export function resolveTheme(theme) {
  if (!theme) return {};
  if (typeof theme === 'string') {
    if (!(theme in THEMES)) throw new TypeError(`Unknown theme "${theme}". Built-in themes: ${Object.keys(THEMES).join(', ')}`);
    return { ...THEMES[theme] };
  }
  if (typeof theme !== 'object') throw new TypeError('setTheme: expected a theme name or a token object');
  const { base, ...tokens } = theme;
  const out = base ? resolveTheme(base) : {};
  for (const [k, v] of Object.entries(tokens)) {
    if (v == null) continue;
    const key = k.startsWith('--') ? k : `--pipc-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
    if (!/^--pipc-[a-z0-9-]+$/.test(key)) continue;
    const value = String(v);
    // Custom property values cannot break out of their declaration when set via setProperty,
    // but reject obvious garbage anyway.
    if (/[;{}<>]/.test(value) && !/^(\d|#|rgba?\(|hsla?\(|var\(|calc\()/.test(value)) continue;
    out[key] = value;
  }
  return out;
}

export function applyTokens(el, tokens, previous = {}) {
  for (const k of Object.keys(previous)) if (!(k in tokens)) el.style.removeProperty(k);
  for (const [k, v] of Object.entries(tokens)) el.style.setProperty(k, v);
}

/** Read the effective token values visible at `el` (used to carry page-level tokens into the PiP window). */
export function readTokens(el) {
  const out = {};
  try {
    const cs = el.ownerDocument.defaultView.getComputedStyle(el);
    for (const k of Object.keys(TOKENS)) {
      const v = cs.getPropertyValue(k).trim();
      if (v) out[k] = v;
    }
  } catch { /* ignore */ }
  return out;
}
