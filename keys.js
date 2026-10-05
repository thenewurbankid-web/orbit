// Keyboard map (shared with the settings panel and the shortcuts overlay). Kept consistent with the portfolio:
// arrows/WASD move the camera, +/- zoom, 0/Home reset, Tab cycles items, Enter opens, Escape backs out,
// [ and ] step between planets, ? shows the shortcuts.
export const KEYMAP = [
  ["← → / A D", "orbit the camera left and right (hold)"],
  ["↑ ↓ / W S", "orbit the camera up and down (hold)"],
  ["Alt + arrows", "pan the camera (hold)"],
  ["+ / −", "zoom in and out (hold; Shift is faster)"],
  ["0 / Home", "overview"],
  ["Tab / Shift+Tab", "next / previous item: planets, then moons, then tasks"],
  ["Enter", "open the selected item"],
  ["F", "fly to the selected item"],
  ["[ / ] or PgUp / PgDn", "previous / next planet"],
  ["N / Space", "next item that needs you"],
  ["Esc / Backspace", "back out one level (or close a panel)"],
  ["I", "activity panel"],
  [", / S", "settings (the station)"],
  ["L", "list view"],
  ["?", "these shortcuts"],
];

export function shortcutsOverlay(doc) {
  const el = doc.createElement("div");
  el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-label", "Keyboard shortcuts");
  el.tabIndex = -1;
  Object.assign(el.style, { position: "fixed", inset: "0", zIndex: "30", display: "grid", placeItems: "center", background: "rgba(0,0,0,0.55)", opacity: "0", transition: "opacity .25s ease" });
  el.innerHTML = `<div style="background:rgba(14,15,17,.94);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:18px 22px;max-width:min(520px,92vw);font:13px/1.5 ui-monospace,Menlo,monospace;color:#b8bcc0">
    <div style="font-size:11px;letter-spacing:.14em;color:#8c9094;margin-bottom:10px">KEYBOARD</div>
    <table style="border-collapse:collapse;width:100%">${KEYMAP.map(([k, d]) => `<tr><td style="padding:3px 16px 3px 0;color:#e2e6ea;white-space:nowrap">${k}</td><td style="padding:3px 0">${d}</td></tr>`).join("")}</table>
    <div style="margin-top:12px;color:#7c8084;font-size:11px">Esc closes</div></div>`;
  let prev = null;
  const close = () => { el.style.opacity = "0"; setTimeout(() => el.remove(), 260); prev?.focus?.({ preventScroll: true }); };
  el.addEventListener("keydown", (e) => { if (e.key === "Escape" || e.key === "?") { e.preventDefault(); e.stopPropagation(); close(); } });
  el.addEventListener("click", close);
  return { open() { prev = doc.activeElement; doc.body.appendChild(el); requestAnimationFrame(() => { el.style.opacity = "1"; el.focus({ preventScroll: true }); }); }, close, get isOpen() { return el.isConnected; } };
}
