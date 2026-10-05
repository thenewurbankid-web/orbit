// Settings: one store (localStorage, try/catch), applied live through `onChange`, and a calm panel opened from
// the station in the scene (or "," / the strip). Sections: Board, Sound, Notifications, Display, Motion & visual,
// Camera, Data, Float, Phone, Connection, Privacy, Keyboard, Profiles, About. Search filters rows. Fully keyboard
// operable: Tab order inside, Escape closes and returns focus to where it came from.

const KEY = "orbitSettings";
export const DEFAULTS = {
  notify: { question: true, blocked: true, critical: true, done: false, quietFrom: "", quietTo: "", browser: false, mutedProjects: [] },
  display: { labels: "all", showPct: true, textSize: "M", highContrast: false, kpis: ["agents", "prog", "block", "wait", "done", "overall"], clock24: false },
  motion: { tempo: 1, blur: true, reduce: "os", fovKick: true },
  visual: { tier: "auto", bloom: 1, dof: false, grain: true, density: 1, battery: false },
  camera: { sensitivity: 1, invert: false, autoFocus: false, tour: false, tourSec: 45 },
  data: { pause: false, eta: true },
  float: { size: "medium" },
  privacy: { hideNames: false },
};
const clone = (o) => JSON.parse(JSON.stringify(o));
function merge(a, b) { for (const k of Object.keys(b ?? {})) { if (a[k] && typeof a[k] === "object" && !Array.isArray(a[k])) merge(a[k], b[k]); else if (k in a) a[k] = b[k]; } return a; }
export const settings = merge(clone(DEFAULTS), (() => { try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch { return null; } })());
const subs = new Set();
export function onChange(fn) { subs.add(fn); return () => subs.delete(fn); }
export function save() { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch {} for (const f of subs) { try { f(settings); } catch (e) { console.error("[settings]", e); } } }
export function set(path, v) { const ks = path.split("."); let o = settings; while (ks.length > 1) o = o[ks.shift()]; o[ks[0]] = v; save(); }
export function resetAll() { merge(settings, clone(DEFAULTS)); save(); }
export function quiet(now = new Date()) {
  const { quietFrom: f, quietTo: t } = settings.notify; if (!f || !t) return false;
  const m = now.getHours() * 60 + now.getMinutes(), p = (s) => { const [h, mi] = s.split(":").map(Number); return h * 60 + mi; };
  const a = p(f), b = p(t); return a <= b ? m >= a && m < b : m >= a || m < b;
}

// ---------------- panel ----------------
// ctx: { doc, snd, keymap, act, store, actions: { refreshNow, setInterval, view, addProject, pair, unpair, floatToggle, help, clearData },
//        intervals, version }
export function openSettingsPanel(ctx) {
  const { doc } = ctx;
  const prev = doc.activeElement;
  const root = doc.createElement("div");
  root.setAttribute("role", "dialog"); root.setAttribute("aria-modal", "true"); root.setAttribute("aria-label", "Settings");
  root.className = "orbit-settings";
  const style = doc.createElement("style");
  style.textContent = `
    .orbit-settings { position: fixed; inset: 0; z-index: 30; display: grid; justify-items: end; background: rgba(0,0,0,.35); opacity: 0; transition: opacity .3s ease; }
    .orbit-settings.on { opacity: 1; }
    .orbit-settings .sheet { width: min(440px, 100vw); height: 100%; overflow-y: auto; background: rgba(12,13,15,.94); border-left: 1px solid rgba(255,255,255,.07);
      font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; color: #b8bcc0; padding: max(14px, env(safe-area-inset-top)) 18px 40px; box-sizing: border-box;
      transform: translateX(16px); transition: transform .35s cubic-bezier(.2,.7,.2,1); }
    .orbit-settings.on .sheet { transform: none; }
    .orbit-settings h2 { font: 500 11px ui-monospace, Menlo, monospace; letter-spacing: .16em; color: #8c9094; margin: 18px 0 6px; text-transform: uppercase; }
    .orbit-settings .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,.04); }
    .orbit-settings .row[hidden] { display: none; }
    .orbit-settings label { flex: 1; }
    .orbit-settings input[type=range] { width: 130px; accent-color: #c8ccd0; }
    .orbit-settings select, .orbit-settings input[type=time], .orbit-settings input[type=search], .orbit-settings input[type=number] { background: #16181b; color: #d0d4d8; border: 1px solid #2a2d31; border-radius: 6px; padding: 4px 6px; font: inherit; }
    .orbit-settings input[type=search] { width: 100%; margin: 4px 0 6px; box-sizing: border-box; padding: 7px 9px; }
    .orbit-settings button { background: #16181b; color: #d0d4d8; border: 1px solid #2a2d31; border-radius: 6px; padding: 5px 10px; font: inherit; cursor: pointer; }
    .orbit-settings button:focus-visible, .orbit-settings input:focus-visible, .orbit-settings select:focus-visible { outline: 1px solid #e2e6ea; outline-offset: 2px; }
    .orbit-settings .top { display: flex; align-items: center; justify-content: space-between; }
    .orbit-settings .muted { color: #7c8084; font-size: 12px; }
    .orbit-settings table { border-collapse: collapse; width: 100%; font: 12px ui-monospace, Menlo, monospace; }
    .orbit-settings td { padding: 3px 10px 3px 0; vertical-align: top; }
    @media (prefers-reduced-motion: reduce) { .orbit-settings, .orbit-settings .sheet { transition: opacity .2s; transform: none; } }`;
  root.appendChild(style);
  const sheet = doc.createElement("div"); sheet.className = "sheet"; root.appendChild(sheet);
  const S = settings, snd = ctx.snd;
  const id = (() => { let n = 0; return () => `os-${++n}`; })();
  const sections = [];
  let cur = null;
  const sec = (title) => { const h = doc.createElement("h2"); h.textContent = title; sheet.appendChild(h); cur = { h, rows: [] }; sections.push(cur); };
  function row(label, control, keywords = "") {
    const r = doc.createElement("div"); r.className = "row"; r.dataset.k = (label + " " + keywords + " " + cur.h.textContent).toLowerCase();
    const l = doc.createElement("label"); l.textContent = label; const i = id(); l.htmlFor = i; control.id = control.id || i;
    r.append(l, control); sheet.appendChild(r); cur.rows.push(r); return control;
  }
  const el = (tag, props = {}) => Object.assign(doc.createElement(tag), props);
  const check = (path, label, kw) => { const ks = path.split("."); const c = el("input", { type: "checkbox", checked: !!S[ks[0]][ks[1]] }); c.onchange = () => set(path, c.checked); return row(label, c, kw); };
  const range = (path, label, min, max, step, kw) => { const ks = path.split("."); const c = el("input", { type: "range", min, max, step, value: S[ks[0]][ks[1]] }); c.setAttribute("aria-valuetext", String(c.value)); c.oninput = () => { set(path, Number(c.value)); c.setAttribute("aria-valuetext", c.value); }; return row(label, c, kw); };
  const select = (path, label, opts, kw) => { const ks = path.split("."); const c = el("select"); for (const [v, t] of opts) c.appendChild(el("option", { value: v, textContent: t, selected: String(S[ks[0]][ks[1]]) === String(v) })); c.onchange = () => set(path, c.value); return row(label, c, kw); };
  const button = (label, text, fn, kw) => { const b = el("button", { type: "button", textContent: text }); b.onclick = fn; return row(label, b, kw); };

  const top = el("div", { className: "top" });
  top.append(el("div", { textContent: "SETTINGS", style: "font:500 12px ui-monospace,Menlo,monospace;letter-spacing:.18em;color:#d0d4d8" }));
  const closeB = el("button", { type: "button", textContent: "Close", ariaLabel: "Close settings" }); closeB.onclick = () => close(); top.append(closeB);
  sheet.appendChild(top);
  const search = el("input", { type: "search", placeholder: "Search settings", ariaLabel: "Search settings" });
  sheet.appendChild(search);

  sec("Board");
  button("Refresh now", "Refresh", () => ctx.actions.refreshNow(), "update");
  { const c = el("select"); for (const v of ctx.intervals) c.appendChild(el("option", { value: v, textContent: `every ${v} s`, selected: v === (ctx.store.board?.intervalSec ?? 15) })); c.onchange = () => ctx.actions.setInterval(Number(c.value)); row("Refresh interval", c, "poll"); }
  button("View", "Sky / list", () => ctx.actions.view(), "list sky");
  button("Projects", "+ Connect a project", () => ctx.actions.addProject(), "add remove contact");

  sec("Sound");
  { const st = snd.soundState(); const m = el("input", { type: "checkbox", checked: !st.muted }); m.onchange = () => snd.setMuted(!m.checked); row("Sound on", m, "mute"); }
  { const v = el("input", { type: "range", min: 0, max: 1, step: 0.05, value: snd.soundState().volume }); v.oninput = () => snd.setVolume(Number(v.value)); row("Master volume", v, "level"); }
  for (const [c, name] of [["ambience", "Ambience (ship hum)"], ["ui", "Taps and confirms"], ["alerts", "Alerts (needs you, critical)"], ["notify", "Notifications"], ["intro", "Intro soundtrack"]]) {
    const m = snd.soundState().mix[c];
    const wrap = el("span", { style: "display:flex;gap:8px;align-items:center" });
    const v = el("input", { type: "range", min: 0, max: 1, step: 0.05, value: m.vol, ariaLabel: `${name} level` }); v.oninput = () => snd.setChannel(c, { vol: Number(v.value) });
    const mu = el("input", { type: "checkbox", checked: !m.muted, ariaLabel: `${name} on` }); mu.onchange = () => snd.setChannel(c, { muted: !mu.checked });
    wrap.append(v, mu);
    if (c !== "intro") { const p = el("button", { type: "button", textContent: "▶", ariaLabel: `Preview ${name}` }); p.onclick = () => snd.preview(c); wrap.append(p); }
    row(name, wrap, "volume mixer channel");
  }
  { const a = el("input", { type: "checkbox", checked: snd.soundState().alerts }); a.onchange = () => snd.setAlertsEnabled(a.checked); row("Alert sounds", a, "alarm"); }

  sec("Notifications");
  check("notify.question", "Alert when a task needs you", "question");
  check("notify.blocked", "Alert when a task is blocked");
  check("notify.critical", "Alert on critical");
  check("notify.done", "Alert when a task is done");
  { const w = el("span", { style: "display:flex;gap:6px" }); const f = el("input", { type: "time", value: S.notify.quietFrom, ariaLabel: "Quiet hours from" }), t = el("input", { type: "time", value: S.notify.quietTo, ariaLabel: "Quiet hours to" }); f.onchange = () => set("notify.quietFrom", f.value); t.onchange = () => set("notify.quietTo", t.value); w.append(f, t); row("Quiet hours", w, "do not disturb"); }
  { const c = el("input", { type: "checkbox", checked: S.notify.browser }); c.onchange = async () => { if (c.checked && "Notification" in window && Notification.permission !== "granted") { const p = await Notification.requestPermission().catch(() => "denied"); if (p !== "granted") c.checked = false; } set("notify.browser", c.checked); }; row("Browser notifications", c, "desktop"); }
  for (const c of ctx.store.board?.companies ?? []) { const m = el("input", { type: "checkbox", checked: !S.notify.mutedProjects.includes(c.prefix), ariaLabel: `Alerts for ${c.name}` }); m.onchange = () => { const s = new Set(S.notify.mutedProjects); if (m.checked) s.delete(c.prefix); else s.add(c.prefix); set("notify.mutedProjects", [...s]); }; row(`Alerts for ${c.name}`, m, "project mute"); }

  sec("Display");
  select("display.labels", "Labels", [["all", "all"], ["near", "selected and near"], ["none", "none"]], "density names");
  check("display.showPct", "Percentages and ETAs");
  select("display.textSize", "Text size", [["S", "small"], ["M", "medium"], ["L", "large"]], "font");
  check("display.highContrast", "High contrast");
  check("display.clock24", "24-hour clock", "time format");

  sec("Motion and visual");
  range("motion.tempo", "Motion tempo", 0.4, 1.6, 0.05, "speed slower faster");
  check("motion.blur", "Motion blur");
  select("motion.reduce", "Reduce motion", [["os", "follow the system"], ["on", "on"], ["off", "off"]], "accessibility");
  check("motion.fovKick", "Speed feel (field-of-view kick)");
  { // Quality is the same `orbit.tier` key that fx.detectTier and ?tier= use ("auto" removes it); it applies on the next load.
    let cur = "auto"; try { cur = localStorage.getItem("orbit.tier") || "auto"; } catch {}
    const c = el("select"); for (const [v, t] of [["auto", "auto"], ["low", "low"], ["medium", "medium"], ["high", "high"]]) c.appendChild(el("option", { value: v, textContent: t, selected: v === cur }));
    const note = el("span", { className: "muted", textContent: "" });
    c.onchange = () => { try { if (c.value === "auto") localStorage.removeItem("orbit.tier"); else localStorage.setItem("orbit.tier", c.value); } catch {} set("visual.tier", c.value); note.textContent = " applies on reload"; };
    const w = el("span", { style: "display:flex;gap:6px;align-items:center" }); w.append(c, note); row("Quality", w, "tier performance");
  }
  range("visual.bloom", "Bloom", 0, 2, 0.05, "glow");
  check("visual.dof", "Depth of field", "focus");
  check("visual.grain", "Film grain");
  range("visual.density", "Ambient effects", 0, 2, 0.1, "meteors lightning density");
  check("visual.battery", "Battery saver", "power fps");

  sec("Camera");
  range("camera.sensitivity", "Orbit sensitivity", 0.3, 2, 0.05, "drag");
  check("camera.invert", "Invert drag");
  check("camera.autoFocus", "Fly to the next item that needs you", "auto focus");
  check("camera.tour", "Idle tour", "auto");
  { const n = el("input", { type: "number", min: 15, max: 600, step: 5, value: S.camera.tourSec }); n.onchange = () => set("camera.tourSec", Number(n.value)); row("Idle tour every (s)", n, "interval"); }

  sec("Data");
  check("data.pause", "Pause updates", "freeze");
  check("data.eta", "Local-model ETA estimates", "estimate");

  sec("Float");
  button("Float window", "On / off", () => ctx.actions.floatToggle(), "picture in picture pip");
  select("float.size", "Default size", [["small", "small"], ["medium", "medium"], ["large", "large"]]);

  sec("Phone");
  button("Pair a phone", "Pair", () => ctx.actions.pair(), "link qr");
  button("Unpair", "Unpair", () => ctx.actions.unpair(), "disconnect");

  sec("Connection");
  { const box = el("div", { style: "padding:6px 0" }); sheet.appendChild(box); cur.rows.push(box); box.className = "row"; box.dataset.k = "connection mac connect this mac";
    const oc = window.orbitConnect;
    if (oc?.renderSettings) { try { oc.renderSettings(box); } catch { box.textContent = "This Mac: status unavailable"; } }
    else { box.append(el("span", { textContent: "This Mac: not connected", className: "muted" })); const b = el("button", { type: "button", textContent: "Connect your Mac" }); b.onclick = () => { close(); ctx.actions.addProject(); }; box.append(b); } }

  sec("Clipboard");
  { const box = el("div", { style: "padding:6px 0" }); sheet.appendChild(box); cur.rows.push(box); box.className = "row"; box.dataset.k = "clipboard pip drop paste cards send agent";
    const cb = window.orbitClipboard;
    if (cb?.renderSettings) { try { cb.renderSettings(box); } catch { box.textContent = "Clipboard: unavailable"; } }
    else box.append(el("span", { textContent: "Clipboard: loading", className: "muted" })); }

  sec("Privacy");
  check("privacy.hideNames", "Hide project names (screen-share mode)", "alias demo");
  { let arm = false; const b = el("button", { type: "button", textContent: "Clear" }); b.onclick = () => { if (arm) { ctx.actions.clearData(); b.textContent = "Cleared"; arm = false; } else { arm = true; b.textContent = "Press again to clear"; } }; row("Clear local data", b, "reset storage"); }

  sec("Keyboard");
  { const t = el("table"); t.innerHTML = ctx.keymap.map(([k, d]) => `<tr><td style="color:#e2e6ea;white-space:nowrap">${k}</td><td>${d}</td></tr>`).join(""); const r = el("div", { className: "row" }); r.dataset.k = "keyboard shortcuts keys " + ctx.keymap.flat().join(" ").toLowerCase(); r.append(t); sheet.appendChild(r); cur.rows.push(r); }

  sec("Profiles");
  button("Export settings", "Copy JSON", async () => { const j = JSON.stringify(settings, null, 2); try { await navigator.clipboard.writeText(j); } catch {} ctx.actions.notice?.("Settings copied as JSON"); }, "backup");
  { const ta = el("textarea", { rows: 2, placeholder: "Paste settings JSON", ariaLabel: "Settings JSON to import", style: "flex:1;background:#16181b;color:#d0d4d8;border:1px solid #2a2d31;border-radius:6px;font:12px ui-monospace,Menlo,monospace" }); const b = el("button", { type: "button", textContent: "Import" }); b.onclick = () => { try { merge(settings, JSON.parse(ta.value)); save(); ta.value = ""; b.textContent = "Imported"; } catch { b.textContent = "Not valid JSON"; } }; const w = el("span", { style: "display:flex;gap:6px;flex:1" }); w.append(ta, b); row("Import", w, "restore"); }
  { let arm = false; const b = el("button", { type: "button", textContent: "Reset all" }); b.onclick = () => { if (arm) { resetAll(); b.textContent = "Reset"; arm = false; } else { arm = true; b.textContent = "Press again to reset"; } }; row("Reset all settings", b, "defaults"); }

  sec("About");
  { const r = el("div", { className: "row muted" }); r.textContent = `Orbit ${ctx.version ?? ""} · status board for Paperclip agents · imagery credits in assets/fx/CREDITS.md`; r.dataset.k = "about version credits"; sheet.appendChild(r); cur.rows.push(r); }

  search.oninput = () => {
    const q = search.value.trim().toLowerCase();
    for (const s of sections) { let any = false; for (const r of s.rows) { const show = !q || r.dataset.k?.includes(q); r.hidden = !show; any ||= show; } s.h.hidden = !any; }
  };
  function close() {
    root.classList.remove("on"); setTimeout(() => root.remove(), 320);
    doc.removeEventListener("keydown", onKey, true);
    (ctx.returnFocus ?? prev)?.focus?.({ preventScroll: true });
    ctx.onClose?.();
  }
  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === "Tab") { // keep Tab inside the panel
      const f = [...sheet.querySelectorAll("button, input, select, textarea")].filter((x) => !x.closest("[hidden]"));
      if (!f.length) return; const i = f.indexOf(doc.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
    }
  }
  doc.addEventListener("keydown", onKey, true);
  root.addEventListener("pointerdown", (e) => { if (e.target === root) close(); });
  doc.body.appendChild(root);
  requestAnimationFrame(() => { root.classList.add("on"); search.focus({ preventScroll: true }); });
  return { close, root };
}
