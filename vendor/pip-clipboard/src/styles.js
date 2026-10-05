// Base stylesheet for the clipboard window (lives inside the Shadow DOM).
// Public tokens (--pipc-*) are read through private aliases with the dark defaults, so
// values can come from any ancestor, setTheme() or addStyles().

import { TOKENS } from './theme.js';

const aliases = Object.entries(TOKENS)
  .map(([k, [v]]) => `  ${k.replace('--pipc-', '--_')}: var(${k}, ${v});`)
  .join('\n');

export const BASE_CSS = `
:host {
${aliases}
  all: initial;
  display: block;
  box-sizing: border-box;
  color: var(--_fg);
  font-family: var(--_font);
  font-size: var(--_font-size);
  line-height: 1.4;
  -webkit-font-smoothing: antialiased;
  color-scheme: dark;
}
:host([data-scheme="light"]) { color-scheme: light; }
@media (prefers-reduced-motion: reduce) {
  :host { --_duration: 0ms; }
}
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
button, input { font: inherit; color: inherit; }
svg.i { width: 16px; height: 16px; flex: none; stroke: currentColor; fill: none; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }

.root {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--_bg);
  color: var(--_fg);
  outline: none;
  overflow: hidden;
}
:host([data-mode="panel"]) .root, :host([data-mode="inline"]) .root {
  border: 1px solid var(--_border);
  border-radius: var(--_radius);
}
:host([data-mode="panel"]) .root { box-shadow: var(--_shadow); }

/* toolbar */
.toolbar {
  display: flex;
  align-items: center;
  gap: calc(var(--_space) * 0.5);
  padding: calc(var(--_space) * 1) calc(var(--_space) * 1.25) calc(var(--_space) * 0.75);
  flex: none;
  user-select: none;
}
:host([data-mode="panel"]) .toolbar { cursor: grab; touch-action: none; }
:host([data-mode="panel"]) .toolbar.dragging { cursor: grabbing; }
.title { display: flex; align-items: baseline; gap: 6px; font-weight: 600; font-size: 1em; letter-spacing: 0.01em; flex: 1; min-width: 0; white-space: nowrap; }
.count { color: var(--_faint); font-weight: 500; font-variant-numeric: tabular-nums; font-size: 0.92em; }
.tools { display: flex; gap: 2px; flex: none; }
.tbtn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 28px; min-width: 28px; padding: 0 7px;
  border: 1px solid transparent; border-radius: var(--_radius-sm);
  background: transparent; color: var(--_muted); cursor: pointer;
  transition: background var(--_duration) ease, color var(--_duration) ease, border-color var(--_duration) ease;
}
.tbtn:hover { background: var(--_card-hover); color: var(--_fg); }
.tbtn .lbl { font-size: 0.92em; }
.tbtn.primary { border-color: var(--_border); color: var(--_fg); }
:focus-visible { outline: 2px solid var(--_focus); outline-offset: 2px; }
.root:focus-visible { outline-offset: -2px; }

/* search + filters */
.searchrow { padding: 0 calc(var(--_space) * 1.25); flex: none; }
.search {
  display: flex; align-items: center; gap: 6px;
  height: 30px; padding: 0 9px;
  background: var(--_surface); border: 1px solid var(--_border); border-radius: var(--_radius-sm);
  color: var(--_faint);
  transition: border-color var(--_duration) ease;
}
.search:focus-within { border-color: var(--_muted); }
.search input { flex: 1; min-width: 0; height: 100%; border: 0; background: transparent; outline: none; color: var(--_fg); }
.search input::placeholder { color: var(--_faint); }
.search input::-webkit-search-cancel-button { display: none; }
.filters {
  display: flex; gap: 5px; flex: none;
  padding: calc(var(--_space) * 0.75) calc(var(--_space) * 1.25);
  overflow-x: auto; scrollbar-width: none;
}
.filters::-webkit-scrollbar { display: none; }
.chip {
  flex: none; height: 24px; padding: 0 9px;
  border: 1px solid var(--_border); border-radius: 999px;
  background: transparent; color: var(--_muted); cursor: pointer; font-size: 0.88em; white-space: nowrap;
  transition: background var(--_duration) ease, color var(--_duration) ease, border-color var(--_duration) ease;
}
.chip:hover { color: var(--_fg); border-color: var(--_muted); }
.chip[aria-pressed="true"] { background: var(--_accent); color: var(--_accent-fg); border-color: var(--_accent); }
.chip .n { opacity: 0.55; margin-left: 4px; font-variant-numeric: tabular-nums; }

/* list */
.list {
  list-style: none; margin: 0;
  padding: calc(var(--_space) * 0.25) calc(var(--_space) * 1.25) calc(var(--_space) * 1.5);
  flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  display: flex; flex-direction: column; gap: var(--_gap);
  scrollbar-width: thin; scrollbar-color: var(--_border) transparent;
}
.list > li { display: block; min-width: 0; }
.root[data-layout="grid"] .list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, var(--_card-min)), 1fr));
  align-content: start;
}
.root[data-layout="compact"] .list { gap: 4px; }

/* cards */
.card {
  position: relative;
  display: flex; flex-direction: column; gap: calc(var(--_space) * 0.75);
  max-width: var(--_card-max);
  padding: var(--_card-pad);
  background: var(--_card-bg);
  border: 1px solid var(--_card-border);
  border-radius: var(--_radius);
  outline: none;
  transition: background var(--_duration) ease, border-color var(--_duration) ease;
  overflow: hidden;
}
.card:hover, .card:focus-visible, .card.menu-open { background: var(--_card-hover); }
.card:focus-visible { outline: 2px solid var(--_focus); outline-offset: 1px; }
.card.pinned { border-color: color-mix(in srgb, var(--_fg) 22%, var(--_card-border)); }
.card.entering { animation: pipc-in var(--_duration) ease-out; }
@keyframes pipc-in { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: none; } }

.head { display: flex; align-items: flex-start; gap: 9px; min-width: 0; padding-right: 26px; }
.lead {
  flex: none; width: 30px; height: 30px; border-radius: var(--_radius-sm);
  display: grid; place-items: center; overflow: hidden;
  background: var(--_tag-bg); color: var(--_muted); font-size: 0.72em; font-weight: 600; letter-spacing: 0.02em; text-transform: uppercase;
}
.lead img { width: 18px; height: 18px; object-fit: contain; }
.titles { min-width: 0; flex: 1; }
.ctitle {
  font-weight: 550; color: var(--_fg);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.cmeta {
  margin-top: 1px; color: var(--_muted); font-size: 0.86em;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums;
}
.cmeta .sep { color: var(--_faint); margin: 0 5px; }

.thumb {
  display: block; width: 100%; height: var(--_thumb-h);
  border-radius: calc(var(--_radius) - 4px);
  background: var(--_code-bg);
  object-fit: contain;
}
.thumb.cover { object-fit: cover; }
.preview {
  margin: 0; color: var(--_fg); opacity: 0.86;
  display: -webkit-box; -webkit-line-clamp: var(--_clamp, 4); -webkit-box-orient: vertical; overflow: hidden;
  white-space: pre-wrap; overflow-wrap: anywhere;
}
.desc { margin: 0; color: var(--_muted); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.url { color: var(--_faint); font-size: 0.86em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.code {
  margin: 0; padding: 8px 10px;
  max-height: calc(1.45em * var(--_code-lines, 7) + 16px); overflow: hidden;
  background: var(--_code-bg); border: 1px solid var(--_card-border); border-radius: var(--_radius-sm);
  font-family: var(--_mono); font-size: 0.86em; line-height: 1.45; color: var(--_fg);
  white-space: pre; tab-size: 2;
  mask-image: linear-gradient(to bottom, #000 75%, transparent);
  -webkit-mask-image: linear-gradient(to bottom, #000 75%, transparent);
}
.code .kw { color: var(--_code-kw); }
.code .str { color: var(--_code-str); }
.code .com { color: var(--_code-com); font-style: italic; }
.code .num { color: var(--_code-num); }
.htmlprev {
  max-height: 9.5em; overflow: hidden;
  padding: 8px 10px; border: 1px solid var(--_card-border); border-radius: var(--_radius-sm);
  background: var(--_code-bg); font-size: 0.92em; overflow-wrap: anywhere;
  mask-image: linear-gradient(to bottom, #000 70%, transparent);
  -webkit-mask-image: linear-gradient(to bottom, #000 70%, transparent);
}
.htmlprev :is(h1,h2,h3,h4,h5,h6) { font-size: 1.05em; margin: 0 0 4px; }
.htmlprev :is(p, ul, ol, blockquote, pre, table) { margin: 0 0 6px; }
.htmlprev a { color: inherit; }
.htmlprev img { max-width: 100%; height: auto; }
.htmlprev table { border-collapse: collapse; }
.htmlprev :is(td, th) { border: 1px solid var(--_card-border); padding: 2px 5px; }

.tags { display: flex; flex-wrap: wrap; gap: 4px; }
.tag {
  display: inline-flex; align-items: center; height: 20px; padding: 0 7px;
  border-radius: 999px; background: var(--_tag-bg); color: var(--_tag-fg);
  font-size: 0.8em; white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis;
}
.tag.time { background: transparent; color: var(--_faint); padding: 0 2px; margin-left: auto; }

.more {
  position: absolute; top: calc(var(--_card-pad) - 3px); right: calc(var(--_card-pad) - 5px);
  width: 28px; height: 28px; display: grid; place-items: center;
  border: 0; border-radius: var(--_radius-sm); background: transparent; color: var(--_faint); cursor: pointer;
  transition: background var(--_duration) ease, color var(--_duration) ease;
}
.more:hover, .card.menu-open .more { background: var(--_tag-bg); color: var(--_fg); }
.pin { position: absolute; top: 6px; right: 34px; color: var(--_muted); }
.pin svg.i { width: 12px; height: 12px; }

/* card sizes */
.root[data-size="s"] { --_thumb-h: 96px; --_clamp: 2; --_code-lines: 4; }
.root[data-size="l"] { --_thumb-h: 220px; --_clamp: 7; --_code-lines: 12; }

/* compact layout: one line per card */
.root[data-layout="compact"] .card { padding: 6px 8px; gap: 0; }
.root[data-layout="compact"] .card :is(.thumb, .preview, .code, .htmlprev, .desc, .url, .tags) { display: none; }
.root[data-layout="compact"] .head { align-items: center; }
.root[data-layout="compact"] .lead { width: 24px; height: 24px; }
.root[data-layout="compact"] .more { top: 4px; }

/* empty state */
.empty {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;
  padding: 24px; text-align: center; color: var(--_muted);
}
.empty .ring {
  width: 52px; height: 52px; border-radius: 16px; display: grid; place-items: center;
  border: 1px dashed var(--_border); color: var(--_faint);
}
.empty .ring svg.i { width: 22px; height: 22px; }
.empty strong { color: var(--_fg); font-weight: 600; }
.empty p { margin: 0; max-width: 240px; font-size: 0.92em; }
kbd {
  font-family: var(--_font); font-size: 0.85em; padding: 1px 5px; border-radius: 5px;
  border: 1px solid var(--_border); background: var(--_surface); color: var(--_fg);
}

/* drop overlay */
.drop {
  position: absolute; inset: 6px; z-index: 5;
  display: grid; place-items: center;
  border: 1.5px dashed var(--_muted); border-radius: var(--_radius);
  background: var(--_overlay); color: var(--_fg); font-weight: 600;
  pointer-events: none;
}

/* menu */
.menu {
  position: absolute; z-index: 10; min-width: 176px; max-width: calc(100% - 16px);
  padding: 4px; margin: 0;
  background: var(--_surface); border: 1px solid var(--_border); border-radius: calc(var(--_radius-sm) + 2px);
  box-shadow: var(--_shadow);
  animation: pipc-fade var(--_duration) ease-out;
}
@keyframes pipc-fade { from { opacity: 0; } to { opacity: 1; } }
.mi {
  display: flex; align-items: center; gap: 9px; width: 100%;
  height: 30px; padding: 0 9px; border: 0; border-radius: 6px;
  background: transparent; color: var(--_fg); text-align: left; cursor: pointer; white-space: nowrap;
}
.mi:hover, .mi:focus-visible { background: var(--_card-hover); outline: none; }
.mi svg.i { color: var(--_muted); }
.mi.danger, .mi.danger svg.i { color: var(--_danger); }
.msep { height: 1px; margin: 4px 6px; background: var(--_border); }

/* confirm + toast */
.confirm {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin: 0 calc(var(--_space) * 1.25) calc(var(--_space) * 0.75); padding: 8px 10px;
  border: 1px solid var(--_border); border-radius: var(--_radius-sm); background: var(--_surface);
}
.confirm span { flex: 1; min-width: 140px; color: var(--_fg); font-size: 0.92em; }
.btn {
  height: 26px; padding: 0 10px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--_border); background: transparent; color: var(--_fg);
}
.btn.danger { background: var(--_danger); border-color: var(--_danger); color: #000; font-weight: 600; }
.toast {
  position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%); z-index: 20;
  max-width: calc(100% - 24px); padding: 7px 12px; border-radius: 999px;
  background: var(--_accent); color: var(--_accent-fg); font-size: 0.88em; font-weight: 500;
  box-shadow: var(--_shadow); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  transition: opacity var(--_duration) ease;
}
.toast:empty { display: none; }

/* panel resize handle */
.resize {
  position: absolute; right: 0; bottom: 0; width: 16px; height: 16px; cursor: nwse-resize; z-index: 6;
  touch-action: none;
}
.resize::after {
  content: ''; position: absolute; right: 4px; bottom: 4px; width: 7px; height: 7px;
  border-right: 1.5px solid var(--_faint); border-bottom: 1.5px solid var(--_faint); border-bottom-right-radius: 2px;
}
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
`;

export const LAUNCHER_CSS = `
:host {
${aliases}
  display: inline-block;
  font-family: var(--_font);
}
button {
  display: inline-flex; align-items: center; gap: 7px;
  height: 32px; padding: 0 12px;
  border: 1px solid var(--_border); border-radius: var(--_radius-sm);
  background: var(--_bg); color: var(--_fg); font: inherit; font-size: 13px; cursor: pointer;
  transition: background var(--_duration) ease, border-color var(--_duration) ease;
}
button:hover { background: var(--_card-hover); border-color: var(--_muted); }
button:focus-visible { outline: 2px solid var(--_focus); outline-offset: 2px; }
svg { width: 15px; height: 15px; stroke: currentColor; fill: none; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
@media (prefers-reduced-motion: reduce) { :host { --_duration: 0ms; } }
`;
