// Connect the Orbit website to Orbit on this computer (macOS, Windows, Linux): find the helper, guide
// the setup in plain steps (download, open, Allow), and the helper's controls for the control centre.
//
// window.orbitConnect, for the settings panel (settings.js):
//   status()            → {state: 'connected'|'not-found'|'needs-allow'|'safari', computer, mac, paperclip, os}
//                         (last known; `mac` is the same object as `computer`, kept for older callers)
//   refresh()           → Promise of a fresh status()
//   renderSettings(el)  → draws the "This computer" section (status lights, restart, auto-start,
//                         updates, forget this browser, uninstall, logs) into el
//   openConnect()       → opens the guided connect panel
// A window "orbit-connect" event fires when the status changes.
import { frostPanel } from "./ui.js";

const params = new URLSearchParams(location.search);
const PORT = Number(params.get("macport")) || 4320;          // ?macport= is for tests
const HELPER = `http://127.0.0.1:${PORT}/`;
const SITE = "https://thenewurbankid-web.github.io/orbit/";
const PAPERCLIP_URL = "https://paperclip.ing";               // from Paperclip's README ("Website")
const STORE = "orbitMac";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ua = navigator.userAgent;

// ---------------- this computer ----------------
export function detectOs() {
  const o = params.get("os"); if (o) return o;                // ?os= is for tests
  const p = String(navigator.userAgentData?.platform || "").toLowerCase();
  const s = p || ua.toLowerCase();
  if (/android/.test(s)) return "android";
  if (/iphone|ipad|ipod|ios/.test(s)) return "ios";
  if (/cros|chrome os/.test(s)) return "chromeos";
  if (/mac/.test(s)) return "mac";
  if (/win/.test(s)) return "windows";
  if (/linux|x11/.test(s)) return "linux";
  return "other";
}
const OS = detectOs();
const OS_NAME = { mac: "Mac", windows: "Windows", linux: "Linux" };
const DOWNLOADS = {
  mac: { file: "Orbit-mac.zip", label: "macOS" },
  windows: { file: "Orbit-windows.zip", label: "Windows" },
  linux: { file: "Orbit-linux.tar.gz", label: "Linux" },
};
const ONE_LINER = {
  mac: `curl -fsSL ${SITE}install.sh | sh`,
  linux: `curl -fsSL ${SITE}install.sh | sh`,
  windows: `irm ${SITE}install.ps1 | iex`,
};
const UNINSTALL_LINE = { mac: `curl -fsSL ${SITE}uninstall.sh | sh`, linux: `curl -fsSL ${SITE}uninstall.sh | sh`, windows: `irm ${SITE}uninstall.ps1 | iex` };
export const isSafari = () => params.has("safari") || (/Safari\//.test(ua) && !/Chrome\/|Chromium\/|CriOS|FxiOS|Edg\/|OPR\//.test(ua));
export const isPhone = () => OS === "android" || OS === "ios" || /iPhone|iPod|Android.+Mobile/.test(ua) || (matchMedia("(pointer: coarse)").matches && Math.min(screen.width, screen.height) < 600);

function saved() { try { const v = JSON.parse(localStorage.getItem(STORE) || "null"); return v && v.port === PORT && v.token ? v : null; } catch { return null; } }
function save(token) { try { localStorage.setItem(STORE, JSON.stringify({ port: PORT, token, at: new Date().toISOString() })); } catch {} }
function forget() { try { localStorage.removeItem(STORE); } catch {} }

let deps = { connectMac: async () => false, mode: () => "lost", sameOrigin: () => false, http: null };
let last = mkStatus("not-found", { helper: false, connected: false }, null);
function mkStatus(state, c, paperclip) {
  const computer = { url: HELPER, port: PORT, ...c };
  return { state, computer, mac: computer, paperclip, os: OS };
}
function setLast(next) {
  const changed = JSON.stringify(next) !== JSON.stringify(last);
  last = next;
  if (changed) dispatchEvent(new CustomEvent("orbit-connect", { detail: next }));
}

async function timed(url, init = {}, ms = 2500) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { cache: "no-store", ...init, signal: ac.signal }); } finally { clearTimeout(t); }
}
// Is Paperclip up? Only a yes/no: its API sends no CORS headers, so an opaque answer means "running".
async function paperclipDirect() {
  try { await timed("http://localhost:3100/api/health", { mode: "no-cors" }, 2000); return true; } catch { return false; }
}
// One look at this computer.
export async function probe() {
  if (deps.mode() === "host" && deps.sameOrigin()) {
    let pc = true; try { pc = (await (await timed("api/health")).json()).paperclip; } catch {}
    setLast({ ...mkStatus("connected", { helper: true, connected: true }, pc), computer: { url: location.origin + "/", port: Number(location.port) || PORT, helper: true, connected: true } });
    last.mac = last.computer;
    return last;
  }
  const tok = saved()?.token;
  let h = null;
  try { const r = await timed(HELPER + "api/health", tok ? { headers: { "x-orbit-token": tok } } : {}); h = r.ok ? await r.json() : null; } catch { h = null; }
  if (h?.app === "orbit") {
    if (tok && !h.connected) forget(); // the helper no longer knows this token
    const connected = Boolean(h.connected && tok);
    setLast(mkStatus(connected ? "connected" : "needs-allow", { helper: true, connected, version: h.version ?? null }, Boolean(h.paperclip)));
  } else {
    const paperclip = isSafari() ? null : await paperclipDirect();
    setLast(mkStatus(isSafari() ? "safari" : "not-found", { helper: false, connected: false }, paperclip));
  }
  return last;
}

// Try the saved token at startup (no prompt, no panel). Resolves true if the board is now live.
export async function resume() {
  const s = saved(); if (!s) return false;
  const st = await probe();
  if (st.state !== "connected") return false;
  return deps.connectMac({ base: HELPER, token: s.token });
}

// Pairing: ask the helper, then wait for Allow on this computer. The confirm window is opened by the
// click itself (a popup opened after an await would be blocked).
async function requestPairing(onUpdate) {
  const win = window.open(HELPER + "connect", "orbit-connect");
  let r;
  try { r = await timed(HELPER + "api/connect/request", { method: "POST" }, 4000); }
  catch { onUpdate({ phase: "error", error: "Orbit on this computer did not answer. Is it still running?" }); return; }
  if (!r.ok) { onUpdate({ phase: "error", error: (await r.json().catch(() => ({}))).error || "Orbit said no to the request." }); return; }
  const { id, code } = await r.json();
  onUpdate({ phase: "waiting", code, popupBlocked: !win });
  const until = Date.now() + 3 * 60 * 1000;
  while (Date.now() < until) {
    await new Promise((res) => setTimeout(res, 1200));
    let st;
    try { st = await (await timed(HELPER + `api/connect/status?id=${encodeURIComponent(id)}`)).json(); } catch { continue; }
    if (st.state === "allowed" && st.token) {
      save(st.token);
      await probe();
      const ok = await deps.connectMac({ base: HELPER, token: st.token });
      onUpdate(ok ? { phase: "connected" } : { phase: "error", error: "Allowed, but the board did not load. Press Connect again." });
      return;
    }
    if (st.state === "denied") { onUpdate({ phase: "denied" }); return; }
    if (st.state === "expired") break;
  }
  onUpdate({ phase: "error", error: "That request ran out of time. Press Connect again." });
}

// ---------------- styles ----------------
let styled = false;
function style() {
  if (styled) return; styled = true;
  const s = document.createElement("style");
  s.textContent = `
.oc h2 { margin-bottom: 6px; }
.oc .lead { color: #b8c4cc; margin: 0 0 16px; }
.oc ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 14px; }
.oc li { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 10px; align-items: start; }
.oc li > div { min-width: 0; }
.oc .tick { width: 18px; height: 18px; margin-top: 3px; border-radius: 50%; border: 1px solid rgba(200,230,245,.45); display: grid; place-items: center; font-size: 11px; color: #000; }
.oc .tick.done { background: #9fdcff; border-color: #9fdcff; box-shadow: 0 0 8px rgba(160,225,255,.5); }
.oc .tick.wait { border-color: rgba(160,225,255,.8); animation: oc-pulse 1.8s ease-in-out infinite; }
.oc .tick.off { opacity: .45; }
.oc .t { color: #eef7fb; letter-spacing: .06em; }
.oc .d { color: #aebbc3; font-size: 13.5px; margin-top: 2px; }
.oc .d p { margin: 4px 0; color: inherit; }
.oc .line { display: flex; gap: 8px; align-items: stretch; margin: 8px 0 4px; }
.oc .line code { flex: 1; min-width: 0; font-size: 12px; padding: 8px 10px; border: 1px solid rgba(255,255,255,.14); border-radius: 6px; background: rgba(0,0,0,.35); overflow-x: auto; white-space: nowrap; color: #eef7fb; user-select: all; }
.oc .line button { white-space: nowrap; }
.oc kbd { font: inherit; border: 1px solid rgba(255,255,255,.22); border-radius: 4px; padding: 0 5px; color: #eef7fb; }
.oc a { color: #bfe9ff; }
.oc a.btn { display: inline-block; text-decoration: none; font-size: 13px; letter-spacing: .1em; color: #dff3fb; background: rgba(120,200,240,.1); border: 1px solid rgba(160,225,255,.5); border-radius: 6px; padding: 9px 16px; margin: 6px 0 4px; }
.oc a.btn:hover { border-color: rgba(200,244,255,.8); background: rgba(255,255,255,.07); }
.oc .other { font-size: 12px; color: #7f8e97; }
.oc .first { margin-top: 6px; padding: 8px 10px; border-left: 2px solid rgba(160,225,255,.35); background: rgba(255,255,255,.025); font-size: 12.5px; color: #a6b4bc; }
.oc details { margin-top: 6px; font-size: 12.5px; } .oc summary { cursor: pointer; color: #8fa0aa; }
.oc .code { font-size: 22px; letter-spacing: .3em; color: #eef7fb; margin: 4px 0; }
.oc .small { font-size: 12px; color: #7f8e97; margin-top: 16px; }
.oc .small code { font-size: 11px; color: #aab4bc; user-select: all; word-break: break-all; }
.oc .err { color: #f0a080; }
.oc .act { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 8px; }
.oc-set { font-size: 13.5px; color: #c3ced5; }
.oc-set h3 { margin: 0 0 8px; font-size: 12px; font-weight: 400; letter-spacing: .14em; color: rgba(160,225,255,.9); }
.oc-set .lights { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 6px 14px; margin: 6px 0 10px; }
.oc-set .lt { display: flex; align-items: center; gap: 8px; } .oc-set .lt i { width: 8px; height: 8px; border-radius: 50%; background: #3a4248; flex: none; }
.oc-set .lt.on i { background: #9fdcff; box-shadow: 0 0 6px rgba(160,225,255,.7); } .oc-set .lt.warn i { background: #d9a860; box-shadow: 0 0 6px rgba(217,168,96,.6); } .oc-set .lt.bad i { background: #c0604a; }
.oc-set .muted { color: #8fa0aa; font-size: 12.5px; } .oc-set .mono { font-family: ui-monospace, Menlo, monospace; font-size: 12px; word-break: break-all; }
.oc-set .row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; align-items: center; }
.oc-set button { font: inherit; font-size: 12px; letter-spacing: .1em; color: #dff3fb; background: rgba(120,200,240,.08); border: 1px solid rgba(160,225,255,.4); border-radius: 6px; padding: 6px 12px; cursor: pointer; }
.oc-set button.dim { border-color: rgba(255,255,255,.15); color: #aab4bc; background: transparent; }
.oc-set button.danger { border-color: rgba(240,140,110,.55); color: #f3c3b5; background: rgba(192,96,74,.08); }
.oc-set button:disabled { opacity: .4; cursor: default; }
.oc-set .ask { margin-top: 10px; padding: 10px 12px; border: 1px solid rgba(255,255,255,.1); border-radius: 8px; background: rgba(255,255,255,.025); }
.oc-set input[type=text] { font: inherit; font-size: 13px; color: #eef7fb; background: rgba(0,0,0,.3); border: 1px solid rgba(255,255,255,.15); border-radius: 6px; padding: 5px 8px; width: 140px; }
.oc-set pre { max-height: 220px; overflow: auto; margin: 8px 0 0; padding: 8px 10px; font-size: 11px; line-height: 1.5; background: rgba(0,0,0,.35); border: 1px solid rgba(255,255,255,.08); border-radius: 6px; white-space: pre-wrap; word-break: break-all; color: #a9b6be; }
.oc-set .note { margin-top: 8px; font-size: 12.5px; } .oc-set .note.err { color: #f0a080; } .oc-set .note.ok { color: #bfe9ff; }
@keyframes oc-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(140,215,255,0); } 50% { box-shadow: 0 0 10px 2px rgba(140,215,255,.45); } }
@media (prefers-reduced-motion: reduce) { .oc .tick.wait { animation: none; } }`;
  document.head.appendChild(s);
}

async function copy(text, btn) {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch {
    const ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select(); try { ok = document.execCommand("copy"); } catch {} ta.remove();
  }
  if (btn) { const t = btn.textContent; btn.textContent = ok ? "COPIED" : "SELECT IT"; setTimeout(() => (btn.textContent = t), 1600); }
}

// ---------------- step 2: get Orbit on this computer ----------------
const FIRST_OPEN = {
  mac: `<p>Open <b>Orbit-mac.zip</b> in Downloads, then double-click <b>Start Orbit</b>.</p>
    <div class="first">The first time, your Mac may say it can't check the file. Right-click <b>Start Orbit</b>, choose <b>Open</b>, then <b>Open</b> again.
    No Open button? Go to <b>System Settings → Privacy &amp; Security</b>, scroll down and press <b>Open Anyway</b>.</div>`,
  windows: `<p>Open <b>Orbit-windows.zip</b> in Downloads, press <b>Extract all</b>, then double-click <b>Start Orbit</b>.</p>
    <div class="first">If Windows says it protected your PC, press <b>More info</b>, then <b>Run anyway</b>.</div>`,
  linux: `<p>Extract <b>Orbit-linux.tar.gz</b>, then run <b>start-orbit.sh</b> in the <b>orbit</b> folder.</p>
    <div class="first">If it won't run: right-click it, <b>Properties → Permissions</b>, tick <b>Allow executing file as program</b> (or choose <b>Run as a Program</b>).</div>`,
};
function advancedHtml(os) {
  const line = ONE_LINER[os]; if (!line) return "";
  const how = os === "windows"
    ? `Open PowerShell: press <kbd>Start</kbd>, type <b>PowerShell</b>, press <kbd>Enter</kbd>. Paste the line and press <kbd>Enter</kbd>.`
    : os === "mac" ? `Open Terminal: press <kbd>⌘</kbd> <kbd>Space</kbd>, type <b>Terminal</b>, press <kbd>Return</kbd>. Paste the line and press <kbd>Return</kbd>.`
      : `Open a terminal, paste the line and press <kbd>Enter</kbd>.`;
  return `<details><summary>Advanced: one line in ${os === "windows" ? "PowerShell" : "a terminal"} instead</summary>
    <div class="line"><code>${esc(line)}</code><button type="button" class="cp" data-line="${esc(line)}">COPY</button></div><p>${how}</p></details>`;
}
function getOrbitHtml(os, safari) {
  const d = DOWNLOADS[os];
  const others = Object.entries(DOWNLOADS).filter(([k]) => k !== os).map(([, v]) => `<a href="${SITE}download/${v.file}">${v.label}</a>`).join(" · ");
  if (!d) {
    return `<p>Download Orbit for your computer:</p><p>${Object.values(DOWNLOADS).map((v) => `<a class="btn" href="${SITE}download/${v.file}">${v.label.toUpperCase()}</a>`).join(" ")}</p>
      <p>Then open it and double-click <b>Start Orbit</b>.</p>`;
  }
  return `<a class="btn dl" href="${SITE}download/${d.file}" download>DOWNLOAD ORBIT FOR ${esc(OS_NAME[os].toUpperCase())}</a>
    <div class="other">Other systems: ${others}</div>
    ${FIRST_OPEN[os]}
    <p>It sets itself up and opens this page again. ${safari ? "" : "This page notices by itself."}</p>
    ${advancedHtml(os)}`;
}

// ---------------- the guided setup ----------------
// Draws into el and keeps checking quietly every 2 s while el is on the page.
// h: { onConnected(), onDemo?(), onHelp?(), onClose?() }
export function renderSetup(el, h = {}) {
  style();
  let st = last, pair = { phase: "idle" }, alive = true, timer = null, first = true;
  const tick = (cls, mark = "") => `<span class="tick ${cls}">${mark}</span>`;
  function draw() {
    if (!alive) return;
    const openDetails = el.querySelector("details")?.open;
    const helper = st.computer.helper, pc = st.paperclip, safari = st.state === "safari";
    const s1 = pc === true
      ? { t: tick("done", "✓"), d: "Paperclip is running." }
      : pc === false
        ? { t: tick("wait"), d: `<p>Paperclip isn't running on this computer. It's the free app that runs your AI agent companies.</p><p>Get it from <a href="${PAPERCLIP_URL}" target="_blank" rel="noopener">paperclip.ing</a>, or start it if you have it. This page notices by itself.</p>` }
        : { t: tick("off"), d: safari ? "Orbit checks this for you once it's on." : "We check this once Orbit is on." };
    const s2 = helper ? { t: tick("done", "✓"), d: "Orbit is running on this computer." } : { t: tick("wait"), d: getOrbitHtml(OS, safari) };
    let s3;
    if (st.computer.connected || pair.phase === "connected") s3 = { t: tick("done", "✓"), d: "Connected." };
    else if (safari) s3 = { t: tick("wait"), d: `<p>Safari doesn't let websites talk to apps on your computer. Once Orbit is on, open it here instead; it's the same board.</p><div class="act"><a class="btn" href="${HELPER}" target="_blank" rel="noopener">OPEN ORBIT ON THIS COMPUTER</a></div><p>Or use Chrome, Edge or Firefox for this page.</p>` };
    else if (!helper) s3 = { t: tick("off"), d: "Then connect this page to it." };
    else if (pair.phase === "waiting") s3 = { t: tick("wait"), d: `<p>An Orbit window opened. Check it shows this code, then press <b>Allow</b>:</p><div class="code">${esc(pair.code)}</div><p>${pair.popupBlocked ? "The window was blocked. " : "No window? "}<a href="${HELPER}connect" target="orbit-connect" rel="noopener">Open it here</a>.</p>` };
    else s3 = { t: tick("wait"), d: `<p>One button, then press <b>Allow</b> in the Orbit window.</p><div class="act"><button type="button" class="go">CONNECT TO THIS COMPUTER</button></div>
          ${pair.phase === "denied" ? `<p class="err">Not allowed. Nothing was connected. You can try again.</p>` : pair.phase === "error" ? `<p class="err">${esc(pair.error)}</p>` : ""}
          <p style="color:#7f8e97">If your browser asks to let this site use devices on your network, choose Allow.</p>` };
    const un = UNINSTALL_LINE[OS];
    el.innerHTML = `<div class="oc"><button class="q dim" title="Help" aria-label="Help">?</button>
      <h2>CONNECT THIS COMPUTER</h2>
      <p class="lead">Orbit shows the AI companies you run in Paperclip on this computer. Three short steps.</p>
      <ol>
        <li>${s1.t}<div><div class="t">1 · Paperclip</div><div class="d">${s1.d}</div></div></li>
        <li>${s2.t}<div><div class="t">2 · Get Orbit</div><div class="d">${s2.d}</div></div></li>
        <li>${s3.t}<div><div class="t">3 · Connect</div><div class="d">${s3.d}</div></div></li>
      </ol>
      <div class="btns">${h.onDemo ? `<button type="button" class="dim demo">SEE THE DEMO</button>` : ""}${h.onClose ? `<button type="button" class="dim close">CLOSE</button>` : ""}</div>
      ${un ? `<p class="small">To remove Orbit later: Uninstall in Orbit's control centre, or "Uninstall Orbit" in the downloaded folder.</p>` : ""}</div>`;
    if (openDetails) el.querySelector("details")?.setAttribute("open", "");
    el.querySelectorAll(".cp").forEach((b) => b.addEventListener("click", (e) => copy(b.dataset.line, e.currentTarget)));
    el.querySelector(".go")?.addEventListener("click", () => { pair = { phase: "waiting", code: "····" }; draw(); requestPairing((u) => { pair = u; if (u.phase === "connected") finish(); else draw(); }); });
    el.querySelector(".demo")?.addEventListener("click", () => { stop(); h.onDemo(); });
    el.querySelector(".close")?.addEventListener("click", () => { stop(); h.onClose(); });
    const q = el.querySelector(".q"); if (q) { if (h.onHelp) q.onclick = () => h.onHelp(); else q.remove(); }
  }
  function stop() { alive = false; clearTimeout(timer); }
  function finish() { stop(); h.onConnected?.(); }
  async function loop() {
    if (!alive) return;
    if (!el.isConnected && !first) return stop();
    first = false;
    const before = JSON.stringify([st.state, st.computer.helper, st.paperclip]);
    st = await probe();
    if (!alive) return;
    if (st.state === "connected" && pair.phase !== "waiting") {
      const s = saved();
      if (s && await deps.connectMac({ base: HELPER, token: s.token })) return finish();
    }
    if (JSON.stringify([st.state, st.computer.helper, st.paperclip]) !== before && pair.phase !== "waiting") draw();
    timer = setTimeout(loop, 2000);
  }
  draw(); loop();
  return { stop };
}

// The guided setup in its own panel (help sheet, settings).
export function openConnect() {
  let ctl = null;
  const p = frostPanel("", { width: 640, closeOnOutside: false, onClose: () => ctl?.stop() });
  ctl = renderSetup(p.el, { onConnected: () => setTimeout(() => p.close(), 900), onClose: () => p.close() });
  return p;
}

// ---------------- "This computer" in the control centre ----------------
async function helperApi(path, body) {
  const init = body === undefined ? {} : { method: "POST", body: JSON.stringify(body) };
  if (deps.http && deps.mode() === "host") return deps.http(path, init);
  const tok = saved()?.token;
  const r = await timed(HELPER + path, { ...init, headers: { "content-type": "application/json", ...(tok ? { "x-orbit-token": tok } : {}) } }, 20000);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || String(r.status));
  return j;
}
const ago = (sec) => sec < 90 ? `${sec} s` : sec < 5400 ? `${Math.round(sec / 60)} min` : sec < 172800 ? `${Math.round(sec / 3600)} h` : `${Math.round(sec / 86400)} days`;

export function renderSettings(el) {
  style();
  let info = null, err = null, ask = null, note = null, upd = null, logsOpen = false, busy = false;
  const viaSite = () => !deps.sameOrigin();
  async function load() {
    await probe();
    if (last.state === "connected") { try { info = await helperApi("api/helper/status"); err = null; } catch (e) { info = null; err = e.message; } }
    else info = null;
    draw();
  }
  function light(on, label, cls) { return `<div class="lt ${cls ?? (on ? "on" : "")}"><i></i>${esc(label)}</div>`; }
  function draw() {
    if (!el.isConnected && el.dataset.drawn) return;
    el.dataset.drawn = "1";
    const st = last;
    if (st.state !== "connected") {
      const word = { "needs-allow": "Orbit is on this computer but this browser isn't connected yet.", "not-found": "Orbit isn't running on this computer.", safari: "Safari can't connect from the website." }[st.state] ?? "";
      el.innerHTML = `<div class="oc-set"><h3>THIS COMPUTER</h3>
        <div class="lights">${light(st.computer.helper, "Orbit")}${light(false, "Connected")}${light(st.paperclip === true, "Paperclip", st.paperclip === false ? "bad" : "")}</div>
        <div class="muted">${esc(word)}${st.state === "safari" ? ` Open <a href="${HELPER}" target="_blank" rel="noopener" style="color:#bfe9ff">Orbit on this computer</a> instead.` : ""}</div>
        <div class="row"><button type="button" class="setup">${st.state === "needs-allow" ? "CONNECT" : "SET UP"}</button><button type="button" class="dim re">CHECK AGAIN</button></div></div>`;
      el.querySelector(".setup").onclick = () => openConnect();
      el.querySelector(".re").onclick = () => load();
      return;
    }
    const i = info;
    const auto = i?.autostart?.on;
    el.innerHTML = `<div class="oc-set"><h3>THIS COMPUTER</h3>
      <div class="lights">${light(true, "Orbit running")}${light(true, viaSite() ? "This browser connected" : "This computer's page")}${light(i?.paperclip !== false, i?.paperclip === false ? "Paperclip not running" : "Paperclip", i?.paperclip === false ? "bad" : null)}${light(auto === true, auto === true ? "Starts at login" : auto === false ? "Doesn't start at login" : "Login item: set up by hand", auto === false ? "warn" : null)}${upd?.available ? light(true, `Update ${upd.latest} available`, "warn") : ""}</div>
      ${i ? `<div class="muted">Orbit ${esc(i.version)} · port ${i.port} · up ${ago(i.uptimeSec)} · Node ${esc(i.node.version)}</div><div class="muted mono">${esc(i.dataDir)}</div>` : err ? `<div class="note err">${esc(err)}</div>` : `<div class="muted">Loading…</div>`}
      <div class="row">
        <button type="button" data-a="restart" ${busy ? "disabled" : ""}>RESTART</button>
        ${i?.installed ? `<button type="button" class="dim" data-a="autostart" ${busy ? "disabled" : ""}>${auto ? "DON'T START AT LOGIN" : "START AT LOGIN"}</button>` : ""}
        <button type="button" class="dim" data-a="check" ${busy ? "disabled" : ""}>${upd?.available ? `UPDATE TO ${esc(upd.latest)}` : "CHECK FOR UPDATES"}</button>
        <button type="button" class="dim" data-a="logs">${logsOpen ? "HIDE LOGS" : "LOGS"}</button>
        ${viaSite() ? `<button type="button" class="dim" data-a="forget">FORGET THIS BROWSER</button>` : ""}
        ${i?.installed ? `<button type="button" class="danger" data-a="uninstall" ${busy ? "disabled" : ""}>UNINSTALL</button>` : ""}
      </div>
      ${ask ? askHtml(ask) : ""}
      ${note ? `<div class="note ${note.err ? "err" : "ok"}">${esc(note.text)}</div>` : ""}
      ${logsOpen && i ? `<pre>${esc((i.log ?? []).join("\n") || "(no log lines yet)")}</pre>` : ""}
    </div>`;
    el.querySelectorAll("[data-a]").forEach((b) => (b.onclick = () => onAction(b.dataset.a)));
    el.querySelector(".ask .yes")?.addEventListener("click", () => confirmAsk());
    el.querySelector(".ask .no")?.addEventListener("click", () => { ask = null; draw(); });
    el.querySelector(".ask input[type=text]")?.addEventListener("input", (e) => { ask.typed = e.target.value; el.querySelector(".ask .yes").disabled = ask.word && ask.typed.trim().toLowerCase() !== ask.word; });
    el.querySelector(".ask input[type=checkbox]")?.addEventListener("change", (e) => { ask.deleteData = e.target.checked; });
  }
  function askHtml(a) {
    return `<div class="ask"><div>${a.text}</div>
      ${a.word ? `<div class="row"><span class="muted">Type <b>${a.word}</b> to confirm:</span><input type="text" autocomplete="off" spellcheck="false" value="${esc(a.typed ?? "")}"></div>` : ""}
      ${a.kind === "uninstall" ? `<div class="row"><label class="muted"><input type="checkbox" ${a.deleteData ? "checked" : ""}> Also delete Orbit's folder (settings and history)</label></div>` : ""}
      <div class="row"><button type="button" class="${a.kind === "uninstall" ? "danger" : ""} yes" ${a.word && (a.typed ?? "").trim().toLowerCase() !== a.word ? "disabled" : ""}>${esc(a.yes)}</button><button type="button" class="dim no">CANCEL</button></div></div>`;
  }
  async function onAction(a) {
    note = null;
    if (a === "logs") { logsOpen = !logsOpen; if (logsOpen) await load(); else draw(); return; }
    if (a === "restart") ask = { kind: "restart", text: "Restart Orbit on this computer? The board reconnects by itself in a few seconds.", yes: "RESTART" };
    if (a === "autostart") ask = { kind: "autostart", on: !info?.autostart?.on, text: info?.autostart?.on ? "Stop Orbit starting at login? It keeps running until you log out or restart." : "Start Orbit at every login?", yes: info?.autostart?.on ? "DON'T START AT LOGIN" : "START AT LOGIN" };
    if (a === "forget") ask = { kind: "forget", text: "Forget this browser? It stops showing this computer's board until you connect it again.", yes: "FORGET" };
    if (a === "uninstall") ask = { kind: "uninstall", word: "uninstall", text: "Uninstall Orbit from this computer? It stops now and won't start at login. You can install it again from this page.", yes: "UNINSTALL" };
    if (a === "check") {
      if (upd?.available) ask = { kind: "update", text: `Update Orbit from ${upd.current} to ${upd.latest}? It downloads the new version, checks it, and restarts.`, yes: "UPDATE" };
      else {
        busy = true; draw();
        try { upd = await helperApi("api/helper/update", {}); note = { text: upd.available ? `Orbit ${upd.latest} is available.` : `Orbit is up to date (${upd.current}).` }; }
        catch (e) { note = { err: true, text: e.message }; }
        busy = false;
      }
    }
    draw();
  }
  async function confirmAsk() {
    const a = ask; ask = null; busy = true; draw();
    try {
      if (a.kind === "restart") { await helperApi("api/helper/restart", {}); note = { text: "Restarting…" }; setTimeout(load, 4000); }
      if (a.kind === "autostart") { await helperApi("api/helper/autostart", { on: a.on }); note = { text: a.on ? "Orbit starts at login." : "Orbit won't start at login." }; await load(); }
      if (a.kind === "update") { const r = await helperApi("api/helper/update", { apply: true }); upd = null; note = { text: `Updating to ${r.updatedTo}… it restarts by itself.` }; setTimeout(load, 5000); }
      if (a.kind === "forget") {
        const s = saved();
        if (s) { try { await timed(HELPER + "api/connect/forget", { method: "POST", headers: { "x-orbit-token": s.token } }); } catch {} }
        forget(); note = { text: "This browser is no longer connected." }; await probe();
      }
      if (a.kind === "uninstall") {
        const r = await helperApi("api/helper/uninstall", { confirm: "uninstall", deleteData: Boolean(a.deleteData) });
        forget(); note = { text: r.deletedData ? "Orbit is uninstalled and its folder removed." : `Orbit is uninstalled. Its folder is still at ${r.dataDir}.` }; info = null;
        setTimeout(() => probe().then(draw), 1500);
      }
    } catch (e) { note = { err: true, text: e.message }; }
    busy = false; draw();
  }
  const on = () => { if (!el.isConnected) return removeEventListener("orbit-connect", on); if (!busy) load(); };
  addEventListener("orbit-connect", on);
  draw(); load();
  return { refresh: load };
}

// app.js wires this up with what it needs; then window.orbitConnect is ready for the settings panel.
export function initConnect(d) {
  deps = { ...deps, ...d };
  window.orbitConnect = { status: () => last, refresh: probe, renderSettings, openConnect, os: OS };
}
