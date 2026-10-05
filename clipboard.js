// Orbit's clipboard: the vendored pip-clipboard widget (vendor/pip-clipboard, MIT) as a side panel in the
// main tab and a drawer in the floating window, with a "Send to agent…" card action that posts to the
// helper's POST /api/clipboard/send (same access rules as everything else: this computer's page, or the
// connected Orbit website with its token).
//
// window.orbitClipboard, for the settings panel and the scene's strip:
//   toggle(), open(), close(), isOpen()
//   renderSettings(el)   → a compact "Clipboard" section (status, open, clear)
//   hideToggle(on=true)  → hide Orbit's own small "clipboard" button (if the strip draws its own item)
// Sending is always an explicit click in the send panel; dropping or pasting only adds cards.
import { host, onHostChange } from "./host.js";
import { frostPanel } from "./ui.js";

const DRY = new URLSearchParams(location.search).has("clipdry"); // tests: every send is a dry run
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const MAX_FILES = 10, MAX_TEXT = 8000;

let deps = null, clip = null, loading = null;
let panel = null, mounted = null, open_ = false, toggles = [], toggleHidden = false;

// Orbit's look: black, calm, JetBrains Mono, ice-blue accents.
const THEME = {
  base: "dark", scheme: "dark",
  bg: "rgba(4,6,9,.94)", surface: "#0b0e12", fg: "#dfe9ef", muted: "#8fa0aa", faint: "#5d6a72",
  border: "rgba(255,255,255,.09)", cardBg: "rgba(255,255,255,.025)", cardBorder: "rgba(255,255,255,.07)", cardHover: "rgba(120,200,240,.06)",
  accent: "#9fdcff", accentFg: "#02070a", danger: "#f0a080", tagBg: "rgba(120,200,240,.07)", tagFg: "#a9c3cf",
  focus: "rgba(160,225,255,.8)", overlay: "rgba(0,0,0,.82)", shadow: "0 20px 60px rgba(0,0,0,.5)",
  radius: "10px", radiusSm: "6px", gap: "8px", cardPad: "10px", cardMin: "180px", thumbH: "120px",
  font: '"JetBrains Mono", ui-monospace, Menlo, monospace', mono: '"JetBrains Mono", ui-monospace, Menlo, monospace', fontSize: "12.5px",
};
const EXTRA_CSS = `
  [part~="title"] { letter-spacing: .14em; text-transform: uppercase; font-weight: 400; color: rgba(160,225,255,.9); font-size: 11px; }
  [part~="toolbar"] { border-bottom-color: rgba(235,242,248,.12); }
  [part~="card"] { transition: border-color 180ms; }
  [part~="card"]:hover { border-color: rgba(160,225,255,.28); }
  [part~="tag"] { letter-spacing: .04em; }
  [part~="host-action"] { color: #bfe9ff; }
  [part~="empty"] { color: #8fa0aa; letter-spacing: .04em; }
`;

async function load() {
  if (clip) return clip;
  if (!loading) loading = (async () => {
    const mod = await import("./vendor/pip-clipboard/src/pip-clipboard.js");
    const c = mod.PipClipboard.instance("orbit") || mod.PipClipboard.create({ name: "orbit", title: "Clipboard", fetchLinkMeta: false });
    c.setTheme(THEME);
    c.addStyles(EXTRA_CSS);
    c.registerAction({
      id: "orbit.send-to-agent",
      label: "Send to agent…",
      accepts: (item) => item.kind !== "image" || Boolean(item.blob) || Boolean(item.url),
      run: (item) => openSend(item),
    });
    clip = c;
    return c;
  })();
  return loading;
}

// ---------------- where the panel lives ----------------
const STYLE_ID = "orbit-clip-style";
const PAGE_CSS = `
.orbit-clip { position: fixed; z-index: 28; pointer-events: auto; box-sizing: border-box; display: flex; flex-direction: column;
  border: 1px solid rgba(255,255,255,.1); border-top-color: rgba(235,242,248,.4); border-radius: 12px; overflow: hidden;
  background: rgba(4,6,9,.9); box-shadow: 0 20px 60px rgba(0,0,0,.5); opacity: 0; transform: translateY(6px); transition: opacity 220ms cubic-bezier(.16,1,.3,1), transform 220ms cubic-bezier(.16,1,.3,1); }
.orbit-clip.on { opacity: 1; transform: none; }
.orbit-clip .bar { display: flex; align-items: center; gap: 8px; padding: 4px 6px 4px 12px; min-height: 26px; font: 11px/1.4 "JetBrains Mono", ui-monospace, Menlo, monospace; letter-spacing: .1em; color: #8fa0aa; border-bottom: 1px solid rgba(255,255,255,.06); }
.orbit-clip .bar .sp { flex: 1; }
.orbit-clip .bar .mode { color: #d9a860; }
.orbit-clip .bar button { font: inherit; letter-spacing: .1em; color: #aab4bc; background: none; border: 1px solid rgba(255,255,255,.12); border-radius: 6px; padding: 2px 8px; cursor: pointer; }
.orbit-clip .bar button:hover { color: #dff3fb; border-color: rgba(160,225,255,.4); }
.orbit-clip .body { flex: 1; min-height: 0; }
.orbit-clip-toggle { position: fixed; z-index: 27; bottom: calc(env(safe-area-inset-bottom, 0px) + 5px); left: 84px; font: 11px/1 "JetBrains Mono", ui-monospace, Menlo, monospace; letter-spacing: .08em;
  color: rgba(170,185,195,.7); background: none; border: 0; padding: 6px 8px; cursor: pointer; }
.orbit-clip-toggle:hover, .orbit-clip-toggle:focus-visible { color: #dff3fb; }
.orbit-clip-toggle.on { color: #bfe9ff; }
.orbit-clip-toggle .n { color: rgba(160,225,255,.75); margin-left: 4px; }
@media (prefers-reduced-motion: reduce) { .orbit-clip { transition: opacity 120ms; transform: none; } }`;
function ensureStyle(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const s = doc.createElement("style"); s.id = STYLE_ID; s.textContent = PAGE_CSS; doc.head.appendChild(s);
}
const floating = () => host.mode === "doc" && host.slot;
function layout() {
  if (!panel) return;
  const win = floating() ? host.win : window;
  const W = win.innerWidth, H = win.innerHeight;
  let box;
  if (floating()) {
    // Compact floating window: a side panel when there is room, else a bottom drawer above the strip.
    box = W >= 560 ? { top: "8px", right: "8px", bottom: "34px", width: `${Math.max(250, Math.round(W * 0.42))}px`, left: "auto", height: "auto" }
      : { left: "6px", right: "6px", bottom: "32px", height: `${Math.round(H * 0.6)}px`, top: "auto", width: "auto" };
  } else {
    box = W >= 700 ? { top: "96px", right: "40px", bottom: "44px", width: "min(400px, calc(100vw - 32px))", left: "auto", height: "auto" }
      : { left: "10px", right: "10px", bottom: "40px", height: "62vh", top: "auto", width: "auto" };
  }
  Object.assign(panel.style, box);
}

async function mountPanel() {
  const c = await load();
  const doc = floating() ? host.doc : document;
  const parent = floating() ? host.slot : document.body;
  ensureStyle(doc);
  panel?.remove(); mounted?.unmount();
  panel = doc.createElement("div");
  panel.className = "orbit-clip";
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-label", "Clipboard");
  panel.innerHTML = `<div class="bar"><span class="mode"></span><span class="sp"></span><button type="button" class="x" aria-label="Close the clipboard">CLOSE</button></div><div class="body"></div>`;
  panel.querySelector(".x").onclick = () => close();
  panel.querySelector(".mode").textContent = sendState().short;
  parent.appendChild(panel);
  mounted = c.mount(panel.querySelector(".body"), {});
  layout();
  (doc.defaultView ?? window).requestAnimationFrame(() => panel?.classList.add("on"));
}
function unmountPanel() { mounted?.unmount(); mounted = null; panel?.remove(); panel = null; }

export async function open() { open_ = true; await mountPanel(); syncToggles(); }
export function close() { open_ = false; unmountPanel(); syncToggles(); }
export function toggle() { return open_ ? close() : open(); }

// ---------------- the small "clipboard" toggle ----------------
function makeToggle(doc) {
  ensureStyle(doc);
  const b = doc.createElement("button");
  b.type = "button"; b.className = "orbit-clip-toggle"; b.setAttribute("aria-label", "Open the clipboard");
  b.innerHTML = `clipboard<span class="n"></span>`;
  b.onclick = () => toggle();
  doc.body.appendChild(b);
  return b;
}
async function syncToggles() {
  for (const t of toggles) t.remove();
  toggles = [];
  if (toggleHidden || document.querySelector(".intro")) return;
  const docs = floating() ? [host.doc] : [document];
  const n = clip ? (await clip.items()).length : 0;
  for (const d of docs) {
    const t = makeToggle(d);
    t.classList.toggle("on", open_);
    t.setAttribute("aria-pressed", String(open_));
    t.querySelector(".n").textContent = n ? String(n) : "";
    if (floating()) t.style.left = "64px";
    else if (innerWidth < 700) Object.assign(t.style, { left: "12px", bottom: "calc(env(safe-area-inset-bottom, 0px) + 34px)" }); // phones: the strip is full, sit just above it
    toggles.push(t);
  }
}

// ---------------- can we send? ----------------
function sendState() {
  const m = deps?.store.mode;
  if (m === "demo") return { ok: false, short: "demo", why: "This is the demo, so nothing is sent. Connect your computer to send things to your agents." };
  if (m === "remote") return { ok: false, short: "phone", why: "Sending works from the computer running Orbit (or the website connected to it), not from a paired phone." };
  if (m !== "host") return { ok: false, short: "offline", why: "Orbit isn't connected to your computer yet, so there is no agent to send to." };
  return { ok: true, short: DRY ? "dry run" : "" };
}

// ---------------- "Send to agent…" ----------------
function currentIssue(company, agentId) {
  const order = { in_progress: 0, blocked: 1, in_review: 2, todo: 3 };
  return (company?.issues ?? []).filter((i) => i.assigneeAgentId === agentId && i.status in order)
    .sort((a, b) => order[a.status] - order[b.status] || String(b.updatedAt).localeCompare(String(a.updatedAt)))[0] ?? null;
}
const label = (it) => `${it.kind} · ${String(it.title || it.name || it.url || it.text || "").replace(/\s+/g, " ").slice(0, 60)}`;

// Items → form fields: links and short text go in the message body, everything else is a file.
function addItems(fd, items) {
  const meta = [];
  for (const it of items) {
    if (it.kind === "link" || (it.kind === "image" && !it.blob && it.url)) { fd.append("link", it.url); continue; }
    if (it.kind === "text" && !it.blob && String(it.text ?? "").length <= MAX_TEXT) { fd.append("text", it.text); continue; }
    const f = clip.toFile(it);
    fd.append("file", f, f.name);
    meta.push({ name: f.name, kind: it.kind, tags: it.tags ?? [], sourceUrl: it.source?.url || it.url || null });
  }
  fd.append("meta", JSON.stringify(meta));
}

function openSend(item) {
  return new Promise((resolve) => {
    const st = sendState();
    if (!st.ok) {
      const p = frostPanel(`<h2>SEND TO AGENT</h2><p>${esc(st.why)}</p><div class="btns"><button class="dim close">CLOSE</button></div>`, { width: 420 });
      p.el.style.zIndex = "40";
      p.el.querySelector(".close").onclick = () => p.close();
      return resolve("Not sent");
    }
    const companies = deps.store.board?.companies ?? [];
    if (!companies.length) { resolve("No projects to send to"); return; }
    let done = false;
    const finish = (msg) => { if (!done) { done = true; resolve(msg); } };
    const p = frostPanel("", { width: 520, closeOnOutside: false, onClose: () => finish(sentMsg || "Not sent") });
    p.el.style.zIndex = "40";
    let sentMsg = null, sending = false, lastSend = 0;
    const armedAt = performance.now() + 600;
    let others = [];
    const pick = new Set([item.id]);
    clip.items().then((all) => { others = all.filter((x) => x.id !== item.id).slice(0, 20); draw(); });
    let cId = companies.find((c) => c.agents?.length)?.id ?? companies[0].id, aId = null, mode = "task";
    function draw(result) {
      const c = companies.find((x) => x.id === cId) ?? companies[0];
      const agents = c.agents ?? [];
      if (!aId || !agents.some((a) => a.id === aId)) aId = c.poc?.id ?? agents[0]?.id ?? null;
      const cur = aId ? currentIssue(c, aId) : null;
      if (mode === "comment" && !cur) mode = "task";
      const msg = p.el.querySelector(".msg")?.value ?? "";
      const sel = "width:100%;background:rgba(255,255,255,.05);color:#e6f7fc;border:1px solid rgba(160,235,255,.3);border-radius:8px;padding:8px;font:inherit";
      p.el.innerHTML = `<h2>SEND TO AGENT${DRY ? ' · <span style="color:#d9a860">DRY RUN</span>' : ""}</h2>
        <div class="items" style="display:grid;gap:4px;max-height:150px;overflow-y:auto;margin-bottom:12px;font-size:13px">
          ${[item, ...others].map((it, i) => `<label style="display:flex;gap:8px;align-items:center;cursor:pointer;color:${pick.has(it.id) ? "#e6f7fc" : "#8fa0aa"}"><input type="checkbox" data-id="${esc(it.id)}" ${pick.has(it.id) ? "checked" : ""} ${i === 0 ? "" : ""}> ${esc(label(it))}</label>`).join("")}
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <select class="co" aria-label="Project" style="${sel}">${companies.map((x) => `<option value="${esc(x.id)}" ${x.id === c.id ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select>
          <select class="ag" aria-label="Agent" style="${sel}">${agents.map((a) => `<option value="${esc(a.id)}" ${a.id === aId ? "selected" : ""}>${esc(a.name)}${a.id === c.poc?.id ? " · point of contact" : ""}</option>`).join("") || "<option>No agents</option>"}</select>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:14px;margin:12px 0 4px;font-size:13px">
          <label style="cursor:pointer"><input type="radio" name="m" value="task" ${mode === "task" ? "checked" : ""}> New task</label>
          <label style="cursor:${cur ? "pointer" : "default"};color:${cur ? "inherit" : "#5d6a72"}"><input type="radio" name="m" value="comment" ${mode === "comment" ? "checked" : ""} ${cur ? "" : "disabled"}> Comment on ${cur ? esc(cur.identifier) : "current task (none)"}</label>
        </div>
        <input type="text" class="msg" maxlength="300" placeholder="${mode === "task" ? "One line: what should they do with it?" : "One line (optional)"}" value="${esc(msg)}" style="${sel};margin-top:6px">
        <div class="btns" style="justify-content:flex-start"><button class="send" ${sending || !aId ? "disabled" : ""}>${sending ? "SENDING…" : `SEND TO ${esc((agents.find((a) => a.id === aId)?.name ?? "AGENT").toUpperCase())}`}</button><button class="dim close">${sentMsg ? "CLOSE" : "CANCEL"}</button></div>
        <p class="note" style="color:#9fb4be;font-size:13px;margin-top:10px">${result ?? `${pick.size} item${pick.size === 1 ? "" : "s"} · at most ${MAX_FILES} files. Nothing is sent until you press Send.`}</p>`;
      p.el.querySelectorAll(".items input").forEach((b) => (b.onchange = () => { b.checked ? pick.add(b.dataset.id) : pick.delete(b.dataset.id); draw(); }));
      p.el.querySelector(".co").onchange = (e) => { cId = e.target.value; aId = null; draw(); };
      p.el.querySelector(".ag").onchange = (e) => { aId = e.target.value; draw(); };
      p.el.querySelectorAll('input[name="m"]').forEach((r) => (r.onchange = () => { mode = r.value; draw(); }));
      p.el.querySelector(".close").onclick = () => p.close();
      p.el.querySelector(".send").onclick = (ev) => send(ev, c);
      p.el.querySelector(".msg").onkeydown = (e) => { if (e.key === "Enter") e.preventDefault(); }; // Enter never sends
    }
    async function send(ev, c) {
      // Only a deliberate, real click; no double sends (same guard as the project panel).
      if (!ev.isTrusted || performance.now() < armedAt || sending || performance.now() - lastSend < 1500) return;
      const message = p.el.querySelector(".msg").value.trim();
      if (mode === "task" && !message) { p.el.querySelector(".note").textContent = "Write one line for the new task first."; return; }
      if (!pick.size) { p.el.querySelector(".note").textContent = "Pick at least one item."; return; }
      lastSend = performance.now(); sending = true; draw();
      try {
        const all = [item, ...others].filter((it) => pick.has(it.id));
        const fd = new FormData();
        fd.append("companyId", c.id); fd.append("agentId", aId); fd.append("mode", mode);
        if (message) fd.append("message", message);
        if (DRY) fd.append("dryRun", "true");
        addItems(fd, all);
        if (fd.getAll("file").length > MAX_FILES) throw new Error(`At most ${MAX_FILES} files at once; untick a few.`);
        const r = await deps.postForm("api/clipboard/send", fd);
        sending = false;
        const where = r.issue ? ` · ${r.issue}` : "";
        sentMsg = `${r.dryRun ? "Dry run: would send" : "Sent"} to ${r.to}${where}`;
        const link = r.url ? ` <a href="${esc(r.url)}" target="_blank" rel="noopener" style="color:#bfe9ff">open ${esc(r.issue)}</a>` : "";
        const failed = r.failed?.length ? `<br><span style="color:#f0a080">Not attached: ${esc(r.failed.join("; "))}</span>` : "";
        draw(`<span class="receipt" style="color:#bfe9ff">${r.dryRun ? "Dry run · nothing was sent. Would send" : "Sent"} to ${esc(r.to)}${esc(where)}</span>${link}${failed}`);
        p.el.querySelector(".send").disabled = true;
        finish(sentMsg);
      } catch (e) { sending = false; draw(`<span style="color:#f0a080">${esc(e.message)}</span>`); }
    }
    draw();
  });
}

// ---------------- settings section ----------------
export function renderSettings(el) {
  const draw = async () => {
    const st = sendState();
    const n = clip ? (await clip.items()).length : 0;
    el.innerHTML = `<div style="font-size:13.5px;color:#c3ced5"><div style="letter-spacing:.14em;font-size:12px;color:rgba(160,225,255,.9);margin-bottom:6px">CLIPBOARD</div>
      <div style="color:#8fa0aa;font-size:12.5px">${n} item${n === 1 ? "" : "s"} kept in this browser. Drop or paste files, images, links and text; send any of them to an agent from its ⋯ menu.${st.ok ? "" : ` ${esc(st.why)}`}</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px"><button type="button" class="o">${open_ ? "CLOSE CLIPBOARD" : "OPEN CLIPBOARD"}</button><button type="button" class="c dim" ${n ? "" : "disabled"}>CLEAR ALL</button></div></div>`;
    el.querySelectorAll("button").forEach((b) => Object.assign(b.style, { font: "inherit", fontSize: "12px", letterSpacing: ".1em", color: "#dff3fb", background: "rgba(120,200,240,.08)", border: "1px solid rgba(160,225,255,.4)", borderRadius: "6px", padding: "6px 12px", cursor: "pointer" }));
    el.querySelector(".o").onclick = async () => { await toggle(); draw(); };
    let arm = false;
    el.querySelector(".c").onclick = async (e) => { if (!arm) { arm = true; e.target.textContent = "PRESS AGAIN TO CLEAR"; return; } await (await load()).clear(); draw(); };
  };
  load().then(draw);
  return { refresh: draw };
}

export function initClipboard(d) {
  deps = d;
  window.orbitClipboard = { toggle, open, close, isOpen: () => open_, renderSettings, hideToggle: (on = true) => { toggleHidden = on; syncToggles(); } };
  // Move between the main tab and the floating window with the board.
  onHostChange(() => { if (open_) mountPanel(); syncToggles(); });
  addEventListener("resize", layout);
  load().then((c) => { c.on("add", syncToggles); c.on("remove", syncToggles); c.on("clear", syncToggles); }).catch((e) => console.error("[clipboard]", e));
  // The toggle appears once the intro is gone; the mode label follows the connection.
  const iv = setInterval(() => { if (!document.querySelector(".intro")) { clearInterval(iv); syncToggles(); } }, 800);
  d.store.on("mode", () => { const m = panel?.querySelector(".mode"); if (m) m.textContent = sendState().short; });
  if (host.win !== window) host.win.addEventListener("resize", layout);
  onHostChange(() => { if (host.win !== window) host.win.addEventListener("resize", layout); });
}
