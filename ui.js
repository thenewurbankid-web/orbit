// Frosted DOM panels: project selection (entry), connect a project, help sheet, and the alert banner.
// Frost is allowed here only; the scene itself stays clean black. Shared motion: 180/280/450 ms,
// expo-out to enter, quick ease-in to exit, scale 0.98→1 plus fade, list stagger 30 ms.

const css = `
:root { --ease-out: cubic-bezier(.16,1,.3,1); --ease-in: cubic-bezier(.4,0,1,1); }
.frost { position: fixed; z-index: 30; color: #dfe9ef; font: 13px/1.55 "JetBrains Mono", ui-monospace, Menlo, monospace;
  background: rgba(10,12,16,.45); -webkit-backdrop-filter: blur(20px) saturate(1.2); backdrop-filter: blur(20px) saturate(1.2);
  border: 1px solid rgba(255,255,255,.1); border-top-color: rgba(235,242,248,.45); border-radius: 14px;
  box-shadow: 0 20px 60px rgba(0,0,0,.45); overflow: hidden;
  opacity: 0; transform: scale(.98); transition: opacity 280ms var(--ease-out), transform 280ms var(--ease-out); }
.frost.on { opacity: 1; transform: none; }
.frost.off { opacity: 0; transform: scale(.985); transition: opacity 180ms var(--ease-in), transform 180ms var(--ease-in); }
.frost::before { content: ""; position: absolute; inset: 0; pointer-events: none; opacity: .07; mix-blend-mode: overlay;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2'/></filter><rect width='120' height='120' filter='url(%23n)'/></svg>"); }
.frost h2 { font-size: 11px; font-weight: 400; letter-spacing: .14em; color: rgba(160,225,255,.9); margin: 0 0 10px; }
.frost p { margin: 0 0 8px; color: #b8c4cc; }
.frost code { color: #eef7fb; }
.frost .rows { display: grid; gap: 6px; margin: 8px 0; max-height: 46vh; overflow-y: auto; }
.frost .rowi { display: grid; grid-template-columns: 18px 1fr auto; gap: 10px; align-items: center; padding: 9px 10px; border: 1px solid rgba(255,255,255,.08); border-radius: 8px; cursor: pointer; background: rgba(255,255,255,.02);
  opacity: 0; transform: translateY(4px); animation: ui-in 280ms var(--ease-out) forwards; }
.frost .rowi:hover { border-color: rgba(160,225,255,.35); }
.frost .rowi.sel { border-color: rgba(160,225,255,.7); background: rgba(120,200,240,.08); }
.frost .rowi .box { width: 12px; height: 12px; border: 1px solid rgba(200,230,245,.6); border-radius: 3px; }
.frost .rowi.sel .box { background: #9fdcff; border-color: #9fdcff; box-shadow: 0 0 8px rgba(160,225,255,.6); }
.frost .rowi .meta { color: #8fa0aa; font-size: 11px; }
.frost .btns { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; align-items: center; }
.frost button { font: inherit; font-size: 11px; letter-spacing: .1em; color: #dff3fb; background: rgba(120,200,240,.08); border: 1px solid rgba(160,225,255,.4); border-radius: 6px; padding: 8px 14px; cursor: pointer; transition: background 180ms, border-color 180ms, opacity 180ms; }
.frost button.dim { border-color: rgba(255,255,255,.15); color: #aab4bc; background: transparent; }
.frost button.start { font-weight: 600; }
.frost button.start:not(:disabled) { animation: ui-glow 2.4s ease-in-out infinite; }
.frost button:disabled { opacity: .35; cursor: default; }
.frost .q { position: absolute; top: 12px; right: 12px; width: 26px; height: 26px; padding: 0; border-radius: 50%; }
.frost input[type=text] { width: 100%; font: inherit; color: #eef7fb; background: rgba(0,0,0,.3); border: 1px solid rgba(255,255,255,.15); border-radius: 6px; padding: 7px 9px; }
.frost .tabs { display: flex; gap: 6px; margin-bottom: 12px; flex-wrap: wrap; }
.frost .tabs button.sel { border-color: rgba(160,225,255,.8); background: rgba(120,200,240,.16); }
.frost .scroll { max-height: min(62vh, 560px); overflow-y: auto; padding-right: 6px; }
.frost dl { display: grid; grid-template-columns: 44px 1fr; gap: 10px 12px; margin: 0; }
.frost dt { width: 36px; height: 36px; }
.frost dd { margin: 0; color: #c3ced5; }
.frost .err { color: #f0a080; }
@keyframes ui-in { to { opacity: 1; transform: none; } }
@keyframes ui-glow { 0%,100% { box-shadow: 0 0 0 0 rgba(140,215,255,0); } 50% { box-shadow: 0 0 16px 2px rgba(140,215,255,.45); } }
.alertbar { position: fixed; z-index: 25; left: 50%; top: 70px; transform: translate(-50%, -8px); opacity: 0; transition: opacity 280ms var(--ease-out), transform 280ms var(--ease-out);
  font: 12px/1.4 "JetBrains Mono", ui-monospace, Menlo, monospace; letter-spacing: .06em; padding: 9px 16px; border-radius: 6px; cursor: pointer; max-width: calc(100% - 40px); text-align: center;
  background: rgba(40,4,4,.72); color: #ffd9d2; border: 1px solid rgba(255,90,70,.7); }
.alertbar.warn { background: rgba(40,26,4,.72); color: #ffe9c2; border-color: rgba(255,190,90,.7); }
.alertbar.on { opacity: 1; transform: translate(-50%, 0); }
.redalert { position: fixed; inset: 0; z-index: 3; pointer-events: none; opacity: 0; transition: opacity 450ms; }
.redalert.on { opacity: 1; }
.redalert .vig { position: absolute; inset: 0; background: radial-gradient(ellipse at center, transparent 55%, rgba(255,30,20,.28) 100%); animation: ra-pulse 2.4s ease-in-out infinite; }
.redalert .sweep { position: absolute; left: 50%; top: 50%; width: 220vmax; height: 220vmax; margin: -110vmax 0 0 -110vmax; background: conic-gradient(from 0deg, rgba(255,40,30,.0) 0deg, rgba(255,40,30,.16) 18deg, rgba(255,40,30,0) 40deg, transparent 360deg); animation: ra-spin 4s linear infinite; mix-blend-mode: screen;
  -webkit-mask: radial-gradient(ellipse at center, transparent 60%, #000 100%); mask: radial-gradient(ellipse at center, transparent 60%, #000 100%); }
.redalert.warn .vig { background: radial-gradient(ellipse at center, transparent 60%, rgba(255,170,40,.18) 100%); }
.redalert.warn .sweep { display: none; }
@keyframes ra-pulse { 0%,100% { opacity: .55; } 50% { opacity: 1; } }
@keyframes ra-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .frost, .frost.on, .frost .rowi, .alertbar { transition: opacity 180ms; transform: none !important; animation: none; opacity: 1; } .redalert .vig, .redalert .sweep { animation: none; } }
`;
let styled = false;
function style() { if (styled) return; styled = true; const s = document.createElement("style"); s.textContent = css; document.head.appendChild(s); }
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// A frosted panel centred (or at a given box); returns {el, close}.
export function frostPanel(html, { width = 460, onClose, closeOnOutside = true, bottom = null } = {}) {
  style();
  const el = document.createElement("div");
  el.className = "frost";
  Object.assign(el.style, { left: "50%", width: `min(${width}px, calc(100% - 32px))`, padding: "18px 20px", marginLeft: `calc(min(${width}px, calc(100% - 32px)) / -2)` });
  if (bottom != null) el.style.bottom = bottom; else { el.style.top = "50%"; el.style.transform = "translateY(-50%) scale(.98)"; }
  el.innerHTML = html;
  document.body.appendChild(el);
  requestAnimationFrame(() => { el.classList.add("on"); if (bottom == null) el.style.transform = "translateY(-50%)"; });
  let closed = false;
  const close = () => {
    if (closed) return; closed = true;
    el.classList.remove("on"); el.classList.add("off");
    setTimeout(() => el.remove(), 200);
    removeEventListener("keydown", onKey, true); document.removeEventListener("pointerdown", onOut, true);
    onClose?.();
  };
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  const onOut = (e) => { if (closeOnOutside && !el.contains(e.target) && !e.target.closest?.(".frost")) close(); };
  addEventListener("keydown", onKey, true);
  setTimeout(() => document.addEventListener("pointerdown", onOut, true), 50);
  return { el, close };
}

// Project selection for the entry overlay. projects: [{id, name, prefix, open, total}].
export function renderSelection(el, { projects, preselected, demoSelected, canConnect, onConnect, onStart, onHelp, title }) {
  style();
  const sel = new Set(preselected ?? []);
  let demo = Boolean(demoSelected);
  el.innerHTML = `<button class="q dim" title="Help" aria-label="Help">?</button>
    <h2>${esc(title)}</h2>
    <div class="rows"></div>
    <div class="btns"><button class="start">START</button>${canConnect ? `<button class="dim conn">+ CONNECT A PROJECT</button>` : ""}</div>`;
  const rows = el.querySelector(".rows"), start = el.querySelector(".start");
  const draw = () => {
    rows.innerHTML = projects.map((p, i) => `<div class="rowi ${sel.has(p.id) && !demo ? "sel" : ""}" data-id="${esc(p.id)}" style="animation-delay:${i * 30}ms"><span class="box"></span><span>${esc(p.name)} <span class="meta">${esc(p.prefix)}</span></span><span class="meta">${p.open != null ? `${p.open} open` : ""}</span></div>`).join("")
      + `<div class="rowi ${demo ? "sel" : ""}" data-id="__demo" style="animation-delay:${projects.length * 30}ms"><span class="box"></span><span>Demo <span class="meta">fictional data, no Paperclip</span></span><span class="meta">DEMO</span></div>`;
    rows.querySelectorAll(".rowi").forEach((r) => (r.onclick = () => {
      const id = r.dataset.id;
      if (id === "__demo") { demo = !demo; if (demo) sel.clear(); }
      else { demo = false; sel.has(id) ? sel.delete(id) : sel.add(id); }
      draw();
    }));
    start.disabled = !demo && sel.size === 0;
  };
  draw();
  start.onclick = () => onStart(demo ? { demo: true } : { ids: [...sel] });
  el.querySelector(".conn")?.addEventListener("click", () => onConnect?.((added) => { if (added) { projects.push(added); sel.add(added.id); demo = false; draw(); } }));
  el.querySelector(".q").onclick = () => onHelp?.();
  return { add(p) { projects.push(p); sel.add(p.id); demo = false; draw(); } };
}

// Connect a project: lists untracked Paperclip companies; a URL field checks another instance.
export function openConnect({ http, onAdded }) {
  const p = frostPanel(`<h2>CONNECT A PROJECT</h2><p>Paperclip companies this board is not tracking yet. Tracking only reads; nothing changes in Paperclip.</p>
    <div class="rows"><p class="meta">Looking for companies…</p></div>
    <p class="meta" style="margin-top:10px">Another Paperclip instance:</p>
    <div class="btns" style="margin-top:4px"><input type="text" placeholder="http://localhost:3101" style="flex:1;min-width:0"><button class="dim look">LOOK</button></div>
    <div class="btns"><button class="dim close">CLOSE</button></div><p class="err"></p>`, { width: 480 });
  const rows = p.el.querySelector(".rows"), err = p.el.querySelector(".err"), input = p.el.querySelector("input");
  const load = async (url) => {
    rows.innerHTML = `<p class="meta">Looking for companies…</p>`;
    try {
      const list = (await http("api/available-companies" + (url ? `?url=${encodeURIComponent(url)}` : ""))).filter((c) => !c.tracked && c.id);
      rows.innerHTML = list.length ? list.map((c, i) => `<div class="rowi" data-id="${esc(c.id)}" data-url="${esc(c.paperclipUrl ?? "")}" style="animation-delay:${i * 30}ms"><span class="box"></span><span>${esc(c.name)} <span class="meta">${esc(c.prefix)}</span></span><span class="meta">${c.open ?? "?"} open · ${c.total ?? "?"} total</span></div>`).join("") : `<p class="meta">Every company on this Paperclip is already connected.</p>`;
      rows.querySelectorAll(".rowi").forEach((r) => (r.onclick = async () => {
        r.classList.add("sel"); err.textContent = "Connecting…";
        try {
          const res = await http("api/companies", { method: "POST", body: JSON.stringify({ action: "add", id: r.dataset.id, paperclipUrl: r.dataset.url || undefined }) });
          const added = res.companies.find((c) => c.id === r.dataset.id);
          p.close(); onAdded?.(added);
        } catch (e) { err.textContent = e.message; r.classList.remove("sel"); }
      }));
    } catch (e) { rows.innerHTML = ""; err.textContent = "Could not reach Paperclip: " + e.message; }
  };
  p.el.querySelector(".look").onclick = () => load(input.value.trim());
  p.el.querySelector(".close").onclick = () => p.close();
  load();
  return p;
}

// Help sheet: tabs, scrollable, closes with Esc or a tap outside.
const ICON = (body) => `<svg viewBox="0 0 36 36" width="36" height="36" fill="none" stroke="#9fdcff" stroke-width="1.2">${body}</svg>`;
const ICONS = {
  ufo: ICON(`<ellipse cx="18" cy="15" rx="11" ry="3.5"/><path d="M12 14a6 5 0 0 1 12 0"/><path d="M14 19l-3 10M22 19l3 10" stroke-opacity=".5"><animate attributeName="stroke-opacity" values=".2;.7;.2" dur="1.6s" repeatCount="indefinite"/></path>`),
  meteor: ICON(`<circle cx="24" cy="12" r="3" fill="#ffb070" stroke="none"/><path d="M22 14L6 30" stroke="#ffb070" stroke-opacity=".6"><animate attributeName="stroke-opacity" values=".2;.8;.2" dur="1.2s" repeatCount="indefinite"/></path>`),
  comet: ICON(`<circle cx="10" cy="24" r="2.5" fill="#bfe9ff" stroke="none"/><path d="M12 22L30 6M11 21L26 4" stroke-opacity=".5"/>`),
  hostile: ICON(`<path d="M6 18l12-6 12 6-12 4z" stroke="#ffa040"/><circle cx="18" cy="17" r="1.5" fill="#ffa040" stroke="none"><animate attributeName="opacity" values="1;.2;1" dur="1s" repeatCount="indefinite"/></circle>`),
  storm: ICON(`<circle cx="18" cy="18" r="11"/><path d="M18 18m-6 0a6 6 0 1 0 6-6" stroke-opacity=".6"><animateTransform attributeName="transform" type="rotate" from="0 18 18" to="360 18 18" dur="4s" repeatCount="indefinite"/></path>`),
  ice: ICON(`<circle cx="18" cy="18" r="10"/><path d="M18 8v20M9 13l18 10M9 23l18-10" stroke="#dff3ff" stroke-opacity=".6"/>`),
  aurora: ICON(`<circle cx="18" cy="22" r="10"/><path d="M10 12q8-6 16 0" stroke="#7affc8"><animate attributeName="stroke-opacity" values=".3;1;.3" dur="2s" repeatCount="indefinite"/></path>`),
  red: ICON(`<rect x="4" y="4" width="28" height="28" rx="3" stroke="#ff5040"><animate attributeName="stroke-opacity" values=".3;1;.3" dur="1.4s" repeatCount="indefinite"/></rect><path d="M18 11v9M18 24v1" stroke="#ff8070"/>`),
};
export function openHelp() {
  const sections = {
    "What": `<p>A live mission view of your Paperclip AI companies. Each project is a planet; the agents working on it are moons; their issues are small satellites.</p><p>It reads Paperclip on this Mac every few seconds. It only writes when you answer a question or send a message.</p>`,
    "Reading it": `<p>Satellites orbit closer the further along they are. The thin arc on each orbit is its rough % done (from a small local model, so treat it as a guess). The numbers at the top are agents working, issues in progress, blocked, and questions waiting on you.</p>
      <dl><dt>${ICONS.ufo}</dt><dd>UFO: an agent started a run. Its beam stays while it works.</dd>
      <dt>${ICONS.meteor}</dt><dd>Meteor: an issue is done.</dd>
      <dt>${ICONS.comet}</dt><dd>Comet: a new issue arrived.</dd>
      <dt>${ICONS.hostile}</dt><dd>Hostile ship: a question is waiting for you. Tap it to answer.</dd>
      <dt>${ICONS.storm}</dt><dd>Storm: an issue is blocked.</dd>
      <dt>${ICONS.ice}</dt><dd>Ice on a moon: no update for over 2 hours.</dd>
      <dt>${ICONS.aurora}</dt><dd>Aurora: good news (done, merged).</dd>
      <dt>${ICONS.red}</dt><dd>Red alert: something critical needs you (failed runs, long-blocked high-priority work, Paperclip down). Tap the banner to look and acknowledge.</dd></dl>`,
    "Using it": `<p>Tap a planet, moon or satellite to fly to it; double-tap or pinch out to go back; drag to look around.</p>
      <p><b>Questions:</b> open one and pick an answer. Your answer flies out as a fighter; if it lands, the hostile ship is beaten. If sending fails, the question stays open.</p>
      <p><b>Agents:</b> tap a moon to see what the agent is doing and write to it (your message becomes a comment on its issue).</p>
      <p><b>Estimates:</b> tap "estimate" on a satellite for a fresh rough guess.</p>
      <p><b>Sound and alerts:</b> the bottom strip has sound on/off and volume. Critical alerts sound a klaxon until you acknowledge them.</p>
      <p><b>Activity:</b> the tab on the right edge slides in a feed of everything that happened.</p>`,
    "Setup": `<p><b>Paperclip</b> must run on this Mac at <code>localhost:3100</code>.</p>
      <p><b>The board</b> runs as a Mac service at <code>127.0.0.1:4320</code> (install or remove it with <code>install.sh</code> / <code>uninstall.sh</code> in the status-board folder).</p>
      <p><b>Projects:</b> use "+ project" to connect another Paperclip company, or a second Paperclip by URL. Long-press a planet to disconnect it.</p>
      <p><b>Phone:</b> tap "pair phone" and scan the QR code, then paste the phone's reply code back here. On the same Wi-Fi you can also open the link with the access key printed by the service.</p>
      <p><b>Estimates</b> use Ollama on this Mac (<code>qwen2.5-coder:7b</code>).</p>
      <p><b>Settings</b> live in <code>config.json</code> in the status-board folder (poll interval, projects, alert thresholds, notifications).</p>`,
  };
  const keys = Object.keys(sections);
  const p = frostPanel(`<h2>HELP</h2><div class="tabs">${keys.map((k, i) => `<button class="dim ${i ? "" : "sel"}" data-k="${k}">${k.toUpperCase()}</button>`).join("")}</div><div class="scroll"></div><div class="btns"><button class="dim close">CLOSE</button></div>`, { width: 560 });
  const body = p.el.querySelector(".scroll");
  const show = (k) => { body.innerHTML = sections[k]; p.el.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("sel", b.dataset.k === k)); };
  p.el.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => show(b.dataset.k)));
  p.el.querySelector(".close").onclick = () => p.close();
  show(keys[0]);
  return p;
}

// Alert banner + red/amber alert layer.
export function createAlertUI({ onTap }) {
  style();
  const layer = document.createElement("div"); layer.className = "redalert"; layer.innerHTML = `<div class="sweep"></div><div class="vig"></div>`;
  const bar = document.createElement("button"); bar.className = "alertbar"; bar.type = "button";
  document.body.append(layer, bar);
  let current = null;
  bar.onclick = () => current && onTap(current);
  return {
    show(a) {
      current = a;
      if (!a) { layer.classList.remove("on"); bar.classList.remove("on"); return; }
      const warn = a.level === "warning";
      layer.classList.toggle("warn", warn); layer.classList.add("on");
      bar.classList.toggle("warn", warn);
      bar.textContent = `${a.level.toUpperCase()} · ${a.text} · tap to view`;
      bar.classList.add("on");
    },
  };
}
