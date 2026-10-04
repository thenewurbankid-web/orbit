// Observatory: data, transport, pairing and the hidden list view.
// Two modes, one page:
//   host   – served by the status-board server on the Mac; talks HTTP + SSE to it and can pair a phone.
//   remote – opened on a phone from the QR link (#o=<offer>); everything arrives over a WebRTC
//            data channel from the host page. Nothing secret is stored here; no server calls.

const STUN = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];
const CHUNK = 15000;
export const OPEN = ["in_progress", "blocked", "in_review", "todo"];
export const STATUS = { in_progress: "in progress", blocked: "blocked", in_review: "in review", todo: "to do", done: "done", cancelled: "cancelled", backlog: "backlog" };

// ---------------- store ----------------
const listeners = {};
export const store = {
  mode: "unknown", // host | remote | lost
  board: null,
  log: [],
  agents: [],
  messages: new Map(),
  countdownAt: 0,
  pair: { state: "idle", code: "", link: "", error: "", qr: null },
  link: { state: "idle", answer: "", error: "" }, // remote side
  on(ev, fn) { (listeners[ev] ||= []).push(fn); },
  emit(ev, data) { for (const fn of listeners[ev] || []) try { fn(data); } catch (e) { console.error(e); } },
};

// Which projects to show (chosen at entry). null = all tracked projects.
store.selection = null;
function applySelection(b) {
  if (!b || !store.selection || store.mode === "demo") return b;
  const keep = new Set(store.selection);
  const companies = b.companies.filter((c) => keep.has(c.id));
  const prefixes = new Set(companies.map((c) => c.prefix));
  return { ...b, companies, agents: (b.agents ?? []).filter((a) => prefixes.has(a.company)), alerts: (b.alerts ?? []).filter((a) => !a.company || prefixes.has(a.company)) };
}
function setBoard(b0) {
  store.rawBoard = b0;
  const b = applySelection(b0);
  const prev = store.board;
  store.board = b;
  store.countdownAt = Date.now() + (b.nextPollInSec ?? b.intervalSec ?? 15) * 1000;
  if (b.agents) store.agents = b.agents;
  store.emit("board", { prev, next: b });
  relay({ type: "board", data: b0 });
}
function setLog(entries) { store.log = entries; store.emit("log"); }
function addLog(entry) { store.log = [entry, ...store.log].slice(0, 500); store.emit("logEntry", entry); }
function upsertMsg(m) {
  const isNew = !store.messages.has(m.id);
  store.messages.set(m.id, m);
  if (store.messages.size > 1500) store.messages.delete(store.messages.keys().next().value);
  store.emit("msg", { msg: m, isNew });
}
function setChat(snap) {
  const pre = store.selection && store.mode !== "demo" && store.board ? new Set(store.board.companies.map((c) => c.prefix)) : null;
  store.agents = (snap.agents ?? store.agents).filter((x) => !pre || pre.has(x.company));
  store.messages = new Map((snap.messages ?? []).map((m) => [m.id, m]));
  store.emit("chat");
}
function setAgents(a0) { const pre = store.selection && store.mode !== "demo" ? new Set((store.board?.companies ?? []).map((c) => c.prefix)) : null; const a = pre ? a0.filter((x) => pre.has(x.company)) : a0; const prev = store.agents; store.agents = a; store.emit("agents", { prev, next: a }); }

// ---------------- host transport ----------------
let key = "";
try {
  const k = new URLSearchParams(location.search).get("key");
  if (k) localStorage.setItem("boardKey", k);
  key = localStorage.getItem("boardKey") || "";
} catch { key = new URLSearchParams(location.search).get("key") || ""; }

async function http(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { "content-type": "application/json", "x-board-key": key, ...(opts.headers || {}) } });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) throw new Error(typeof body === "string" ? body : body.error || String(res.status));
  return body;
}

async function hostLoad() {
  try {
    setBoard(await http("api/board"));
    setLog(await http("api/log?limit=500"));
    relay({ type: "log", data: store.log.slice(0, 200) });
  } catch (e) { store.emit("error", e.message); }
}

let hostEs = null;
function hostStream() {
  // EventSource cannot send headers, so the key rides in the query string here (LAN only).
  const es = hostEs = new EventSource("api/chat/stream" + (key ? `?key=${encodeURIComponent(key)}` : ""));
  es.onmessage = (ev) => {
    let e; try { e = JSON.parse(ev.data); } catch { return; }
    if (e.type === "msg") upsertMsg(e.msg);
    else if (e.type === "agents") setAgents(e.agents);
    else if (e.type === "log") addLog(e.entry);
    else if (e.type === "board") hostLoad();
    if (e.type !== "board") relay({ type: "ev", data: e });
  };
}

const hostActions = {
  async answer(p) { return http("api/answer", { method: "POST", body: JSON.stringify(p) }); },
  async comment(p) { return http("api/answer", { method: "POST", body: JSON.stringify({ issueId: p.issueId, action: "comment", text: p.text }) }); },
  async eta(p) { const q = p.issue ? `issue=${encodeURIComponent(p.issue)}` : `company=${encodeURIComponent(p.company)}`; const r = await http(`api/eta?${q}`, { method: "POST" }); watchEta(); return r; },
  async refresh() { const b = await http("api/refresh", { method: "POST" }); setBoard(b); return { ok: true }; },
  async available(p) { return http("api/available-companies" + (p.url ? `?url=${encodeURIComponent(p.url)}` : "")); },
  async companies(p) { const r = await http("api/companies", { method: "POST", body: JSON.stringify(p) }); await hostLoad(); return r; },
  async ack(p) { const r = await http("api/alerts/ack", { method: "POST", body: JSON.stringify({ id: p.id }) }); await hostLoad(); return r; },
  async helper(p) { return http("api/helper/brief", { method: "POST", body: JSON.stringify({ interaction: p.interaction }) }); },
  async helperAsk(p) { return http("api/helper/ask", { method: "POST", body: JSON.stringify({ interaction: p.interaction, text: p.text }) }); },
  async projectWork(p) { const r = await http("api/project-work", { method: "POST", body: JSON.stringify(p) }); await hostLoad(); return r; },
  async config(p) { const r = await http("api/config", { method: "POST", body: JSON.stringify({ intervalSec: p.intervalSec }) }); await hostLoad(); return r; },
};
let etaWatch = null;
function watchEta() {
  clearInterval(etaWatch);
  etaWatch = setInterval(async () => { await hostLoad(); if (!store.board?.etaRunning?.length) clearInterval(etaWatch); }, 4000);
}

// One entry point for every write: the scene and the list view both call this.
export async function act(action, payload = {}) {
  if (store.mode === "demo") return demo.act(action, payload);
  if (store.mode === "host") {
    if (!hostActions[action]) throw new Error("unknown action");
    return hostActions[action](payload);
  }
  if (store.mode === "remote") return remoteRequest(action, payload);
  throw new Error("Not connected");
}

// ---------------- data channel framing ----------------
function sendFramed(dc, obj) {
  if (!dc || dc.readyState !== "open") return;
  const s = JSON.stringify(obj);
  if (s.length <= CHUNK) return dc.send(s);
  const id = Math.random().toString(36).slice(2);
  const n = Math.ceil(s.length / CHUNK);
  for (let i = 0; i < n; i++) dc.send(JSON.stringify({ type: "part", id, i, n, s: s.slice(i * CHUNK, (i + 1) * CHUNK) }));
}
const partsBuf = new Map();
function unframe(raw, handle) {
  let m; try { m = JSON.parse(raw); } catch { return; }
  if (m.type !== "part") return handle(m);
  const p = partsBuf.get(m.id) ?? { got: 0, s: new Array(m.n) };
  p.s[m.i] = m.s; p.got++;
  partsBuf.set(m.id, p);
  if (p.got === m.n) { partsBuf.delete(m.id); try { handle(JSON.parse(p.s.join(""))); } catch {} }
}

// ---------------- compression for pairing codes ----------------
async function pack(desc) {
  const bytes = new TextEncoder().encode(JSON.stringify({ t: desc.type, s: desc.sdp }));
  const cs = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  const buf = new Uint8Array(await new Response(cs).arrayBuffer());
  let bin = ""; for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function unpack(code) {
  const clean = code.trim().replace(/^.*#o=/, "").replace(/\s+/g, "");
  const bin = atob(clean.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const ds = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const o = JSON.parse(await new Response(ds).text());
  return { type: o.t, sdp: o.s };
}
function iceDone(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    const t = setTimeout(resolve, 6000);
    pc.addEventListener("icegatheringstatechange", () => { if (pc.iceGatheringState === "complete") { clearTimeout(t); resolve(); } });
  });
}

// ---------------- host side pairing ----------------
let hostPc = null, hostDc = null;
function relay(obj) { if (hostDc?.readyState === "open") sendFramed(hostDc, obj); }

function setPair(patch) { Object.assign(store.pair, patch); store.emit("pair"); }

export async function startPairing() {
  stopPairing();
  setPair({ state: "making", code: "", link: "", error: "", qr: null });
  const pc = new RTCPeerConnection({ iceServers: STUN });
  const dc = pc.createDataChannel("board", { ordered: true });
  hostPc = pc; hostDc = dc;
  dc.onopen = () => {
    setPair({ state: "connected" });
    sendFramed(dc, { type: "board", data: store.board });
    sendFramed(dc, { type: "log", data: store.log.slice(0, 200) });
    sendFramed(dc, { type: "chat", data: { agents: store.agents, messages: [...store.messages.values()].slice(-400) } });
  };
  dc.onclose = () => { if (hostPc === pc) setPair({ state: "closed" }); };
  dc.onmessage = (ev) => unframe(ev.data, async (m) => {
    if (m.type !== "req") return;
    // The phone may only ask for these; the server checks the details again.
    const allowed = { answer: 1, comment: 1, eta: 1, refresh: 1, config: 1, helper: 1, helperAsk: 1, available: 1, companies: 1, ack: 1 };
    try {
      if (!allowed[m.action]) throw new Error("not allowed");
      const result = await hostActions[m.action](m.payload ?? {});
      sendFramed(dc, { type: "res", id: m.id, ok: true, result: m.action === "refresh" ? null : result });
    } catch (e) { sendFramed(dc, { type: "res", id: m.id, ok: false, error: e.message }); }
  });
  pc.onconnectionstatechange = () => {
    if (hostPc !== pc) return;
    if (pc.connectionState === "connecting") setPair({ state: "connecting" });
    if (pc.connectionState === "failed") setPair({ state: "failed", error: "This network blocks direct links. Try both devices on Wi-Fi." });
    if (pc.connectionState === "disconnected") setPair({ state: "connecting" });
  };
  await pc.setLocalDescription(await pc.createOffer());
  await iceDone(pc);
  const code = await pack(pc.localDescription);
  const base = store.board?.phoneUrl || "./";
  const link = new URL(base, location.href).href.replace(/#.*$/, "") + "#o=" + code;
  setPair({ state: "waiting", code, link, qr: await qrMatrix(link) });
}

export async function applyAnswer(text) {
  if (!hostPc) throw new Error("Start pairing first");
  try {
    const desc = await unpack(text);
    if (desc.type !== "answer") throw new Error("That is not a reply code");
    await hostPc.setRemoteDescription(desc);
    setPair({ state: "connecting", error: "" });
  } catch (e) { setPair({ error: "That code did not work: " + e.message }); throw e; }
}

export function stopPairing() {
  try { hostDc?.close(); hostPc?.close(); } catch {}
  hostPc = null; hostDc = null;
  setPair({ state: "idle", code: "", link: "", error: "", qr: null });
}

// qrcodejs (cdnjs, pinned, SRI) gives us the module matrix; the scene draws it.
let qrLib = null;
function loadQrLib() {
  if (qrLib) return qrLib;
  qrLib = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js";
    s.integrity = "sha512-CNgIRecGo7nphbeZ04Sc13ka07paqdeTu0WR1IM4kNcpmBAUSHSQX0FslNhTDadL4O5SAGapGt4FodqL8My0mA==";
    s.crossOrigin = "anonymous";
    s.onload = () => resolve(window.QRCode);
    s.onerror = () => reject(new Error("QR library failed to load"));
    document.head.appendChild(s);
  });
  return qrLib;
}
async function qrMatrix(text) {
  const QRCode = await loadQrLib();
  const el = document.createElement("div");
  const q = new QRCode(el, { text, width: 256, height: 256, correctLevel: QRCode.CorrectLevel.L });
  const m = q._oQRCode;
  const n = m.getModuleCount();
  const rows = [];
  for (let r = 0; r < n; r++) { const row = []; for (let c = 0; c < n; c++) row.push(m.isDark(r, c)); rows.push(row); }
  return rows;
}

// ---------------- remote (phone) side ----------------
let remoteDc = null;
const pending = new Map();
function setLink(patch) { Object.assign(store.link, patch); store.emit("link"); }

async function startRemote(offerCode) {
  store.mode = "remote";
  setLink({ state: "making" });
  try {
    const pc = new RTCPeerConnection({ iceServers: STUN });
    pc.ondatachannel = (ev) => {
      remoteDc = ev.channel;
      remoteDc.onopen = () => setLink({ state: "connected" });
      remoteDc.onclose = () => setLink({ state: "closed", error: "The Mac closed the link. Pair again from the board on your Mac." });
      remoteDc.onmessage = (e) => unframe(e.data, onHostMessage);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connecting") setLink({ state: "connecting" });
      if (pc.connectionState === "failed") setLink({ state: "failed", error: "This network blocks direct links. Try both devices on Wi-Fi." });
    };
    await pc.setRemoteDescription(await unpack(offerCode));
    await pc.setLocalDescription(await pc.createAnswer());
    await iceDone(pc);
    setLink({ state: "answer", answer: await pack(pc.localDescription) });
  } catch (e) {
    setLink({ state: "failed", error: "This pairing link did not work (" + e.message + "). Make a new one on your Mac." });
  }
}

function onHostMessage(m) {
  if (m.type === "board") { if (m.data) setBoard(m.data); }
  else if (m.type === "log") setLog(m.data ?? []);
  else if (m.type === "chat") setChat(m.data ?? {});
  else if (m.type === "ev") {
    const e = m.data;
    if (e.type === "msg") upsertMsg(e.msg);
    else if (e.type === "agents") setAgents(e.agents);
    else if (e.type === "log") addLog(e.entry);
  } else if (m.type === "res") {
    const p = pending.get(m.id); if (!p) return;
    pending.delete(m.id);
    m.ok ? p.resolve(m.result) : p.reject(new Error(m.error || "failed"));
  }
}

function remoteRequest(action, payload) {
  if (remoteDc?.readyState !== "open") return Promise.reject(new Error("Not connected to the Mac"));
  const id = Math.random().toString(36).slice(2);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    sendFramed(remoteDc, { type: "req", id, action, payload });
    setTimeout(() => { if (pending.delete(id)) reject(new Error("No reply from the Mac")); }, action.startsWith("helper") ? 180000 : 30000);
  });
}

// ---------------- question helper (local model briefing) ----------------
// Cache per question: {state: 'loading'|'ready'|'error', view, error, asking}
export const helperState = new Map();
export async function helperBrief(interaction) {
  const cur = helperState.get(interaction);
  if (cur && (cur.state === "loading" || cur.state === "ready")) return;
  helperState.set(interaction, { state: "loading" });
  store.emit("helper", interaction);
  try { helperState.set(interaction, { state: "ready", view: await act("helper", { interaction }) }); }
  catch (e) { helperState.set(interaction, { state: "error", error: e.message }); }
  store.emit("helper", interaction);
}
export async function helperAsk(interaction, text) {
  const cur = helperState.get(interaction) ?? { state: "ready" };
  helperState.set(interaction, { ...cur, asking: text });
  store.emit("helper", interaction);
  try { helperState.set(interaction, { state: "ready", view: await act("helperAsk", { interaction, text }) }); }
  catch (e) { helperState.set(interaction, { ...cur, asking: null, error: e.message }); }
  store.emit("helper", interaction);
}
export function helperLines(interaction) {
  // Plain lines for both views: [{text, kind}] kind: head|body|dim|amber|meter|q|a
  const h = helperState.get(interaction);
  const out = [{ text: "Local model briefing · may be wrong", kind: "head" }];
  if (!h || h.state === "loading") return [...out, { text: "Gathering context and asking the local model…", kind: "dim" }];
  if (h.state === "error") return [...out, { text: "The briefing failed: " + h.error, kind: "dim" }];
  const v = h.view, b = v.brief;
  if (b) {
    out.push({ text: b.summary, kind: "body" });
    for (const o of b.options) out.push({ text: `${o.option}: + ${o.upside}  − ${o.risk}`, kind: "body" });
    if (b.recommend?.option) out.push({ text: `Leans toward: ${b.recommend.option}. ${b.recommend.reason}`, kind: "amber" });
    if (b.check?.length) out.push({ text: "Worth checking: " + b.check.join("; "), kind: "dim" });
  }
  const pct = Math.min(100, Math.round((v.tokens / v.ctx) * 100));
  out.push({ text: `Context ${pct}% full (${(v.tokens / 1000).toFixed(1)}k of ${v.ctx / 1000}k tokens): ${v.items.join(", ")}`, kind: "meter", pct });
  for (const t of v.history) {
    out.push({ text: "You: " + t.q, kind: "q" });
    if (t.added?.length) out.push({ text: "added: " + t.added.join(", "), kind: "dim" });
    out.push({ text: t.a, kind: "a" });
  }
  if (h.asking) out.push({ text: "You: " + h.asking, kind: "q" }, { text: "Thinking…", kind: "dim" });
  if (h.error) out.push({ text: h.error, kind: "dim" });
  return out;
}

// ---------------- helpers shared with the scene ----------------
export function ago(iso) {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return Math.round(s) + " s ago";
  if (s < 3600) return Math.round(s / 60) + " min ago";
  if (s < 86400) return Math.round(s / 3600) + " h ago";
  return Math.round(s / 86400) + " d ago";
}
const PRIO_W = { critical: 4, urgent: 4, high: 3, medium: 2, low: 1 };
// Priority-weighted mean of the open issues' estimates (rough, local model).
export function companyProgress(c) {
  let sw = 0, sp = 0;
  for (const i of c.issues) {
    if (!OPEN.includes(i.status)) continue;
    const e = store.board?.eta?.[i.identifier];
    if (!e || e.pct == null) continue;
    const w = PRIO_W[i.priority] ?? 2; sw += w; sp += w * e.pct;
  }
  return sw ? Math.round(sp / sw) : null;
}
export function allIssues() { return (store.board?.companies ?? []).flatMap((c) => c.issues.map((i) => ({ ...i, company: c.prefix }))); }
export function allQuestions() { return (store.board?.companies ?? []).flatMap((c) => c.issues.flatMap((i) => i.questions.map((q) => ({ company: c, issue: i, q })))); }
export function summary() {
  const all = allIssues();
  const n = (s) => all.filter((i) => i.status === s).length;
  return { inProgress: n("in_progress"), blocked: n("blocked"), review: n("in_review"), todo: n("todo"), waiting: allQuestions().length };
}
export function messagesFor(agentId) {
  const a = store.agents.find((x) => x.id === agentId);
  const issueIds = new Set([a?.issueId, ...(a?.openIssues ?? []).map((i) => i.id)].filter(Boolean));
  return [...store.messages.values()]
    .filter((m) => m.agentId === agentId || (m.role === "comment" && issueIds.has(m.issueId)))
    .sort((x, y) => String(x.ts).localeCompare(String(y.ts)));
}

// ---------------- hidden list view ----------------
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ui = { drafts: {}, sent: {}, chatAgent: "", chatText: "", chatIssue: "", msg: "" };

export function toggleList(force) {
  const el = $("list");
  const show = force ?? el.hidden;
  el.hidden = !show;
  if (show) { renderList(); $("listMain").querySelector("button")?.focus(); }
  store.emit("listview", show);
}

const bar = (pct) => `<span style="display:inline-block;width:120px;height:6px;border-radius:3px;background:#222;vertical-align:middle;overflow:hidden"><span style="display:block;height:100%;width:${pct}%;background:#9a9a9a"></span></span>`;
function etaText(id) {
  const e = store.board?.eta?.[id];
  if (store.board?.etaRunning?.includes(id) && (!e || e.pct == null)) return `<span class="muted">estimating…</span>`;
  if (!e || e.pct == null) return "";
  return bar(e.pct) + " " + etaTextInner(e) + (store.board?.etaRunning?.includes(id) ? ` <span class="muted">· estimating…</span>` : "");
}
function etaTextInner(e) {
  return `~${e.pct}% · ETA ${esc(e.eta)} <span class="muted">(rough local-model estimate, estimated ${ago(e.at)})</span>${e.done?.length ? `<br><span class="muted">Done: ${esc(e.done.join("; "))}</span>` : ""}${e.left?.length ? `<br><span class="muted">Left: ${esc(e.left.join("; "))}</span>` : ""}`;
}

function renderList() {
  const el = $("list");
  if (el.hidden) return;
  if (el.contains(document.activeElement) && /TEXTAREA|INPUT|SELECT/.test(document.activeElement.tagName)) return;
  const b = store.board;
  const s = summary();
  const left = Math.max(0, Math.round((store.countdownAt - Date.now()) / 1000));
  let h = `<header><h1>Orbit</h1><span class="spacer"></span><button data-l="close">Back to the sky</button></header>`;
  if (store.mode === "remote" && store.link.state !== "connected") h += remoteLinkHtml();
  if (!b) { $("listMain").innerHTML = h + `<p class="muted">Waiting for data…</p>`; return; }
  h += `<p><strong>${s.inProgress}</strong> in progress · <strong>${s.blocked}</strong> blocked · <strong>${s.waiting}</strong> waiting on you · ${s.review} in review · ${s.todo} to do</p>`;
  h += `<div class="row"><span class="muted small" id="lcount">Next refresh in ${left}s</span><button data-l="refresh">Refresh now</button>`;
  h += `<label class="small muted">Every <input type="number" min="5" id="linterval" value="${b.intervalSec}"> s</label>`;
  if (store.mode === "host") h += `<button data-l="pair">${store.pair.state === "idle" ? "Pair phone" : "Pairing…"}</button>`;
  h += `</div>${ui.msg ? `<p class="small">${esc(ui.msg)}</p>` : ""}`;
  if (store.mode === "host" && store.pair.state !== "idle") h += pairHtml();

  const qs = allQuestions();
  if (qs.length) {
    h += `<section><h2>Needs you (${qs.length})</h2>`;
    for (const { company, issue, q } of qs) h += questionHtml(company, issue, q);
    h += `</section>`;
  }
  for (const c of b.companies) {
    const open = c.issues.filter((i) => OPEN.includes(i.status));
    const done = c.issues.filter((i) => !OPEN.includes(i.status));
    h += `<section><div class="row" style="margin:0"><h2>${esc(c.name)}</h2><span class="mono muted">${c.prefix}</span><span class="small muted">${open.length} open</span>${companyProgress(c) != null ? `<span class="small">${bar(companyProgress(c))} ~${companyProgress(c)}% overall <span class="muted">(rough local-model estimate)</span></span>` : ""}${open.length ? `<button data-l="etaAll" data-c="${c.prefix}">Estimate all</button>` : ""}</div>`;
    for (const i of open) {
      const running = b.etaRunning?.includes(i.identifier);
      h += `<div class="issue"><div class="row" style="margin:0"><span class="pill s-${i.status}">${STATUS[i.status]}</span><span class="mono">${esc(i.identifier)}</span><span class="small muted">${esc(i.priority)} · ${esc(i.assignee || "unassigned")} · updated ${ago(i.updatedAt)}</span></div>
        <div><strong>${esc(i.title)}</strong></div>
        ${i.lastComment ? `<details><summary class="small"><span class="muted">${esc(i.lastComment.author)}, ${ago(i.lastComment.at)}:</span> ${esc(i.lastComment.text)}</summary><div class="full">${esc(i.lastComment.full)}</div></details>` : ""}
        <div class="row small">${etaText(i.identifier)} <button data-l="eta" data-i="${esc(i.identifier)}" ${running ? "disabled" : ""}>${running ? "Estimating…" : "Estimate"}</button></div></div>`;
    }
    if (done.length) h += `<details><summary class="small muted">Done and closed (${done.length})</summary>${done.map((i) => `<div class="issue small"><span class="mono">${esc(i.identifier)}</span> ${esc(i.title)}</div>`).join("")}</details>`;
    const lg = store.log.filter((e) => e.company === c.prefix).slice(0, 20);
    h += `<h3>Recent changes</h3><ul class="log">${lg.map((e) => `<li><span class="muted small">${new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span> ${esc(e.text)}</li>`).join("") || `<li class="muted">None yet.</li>`}</ul></section>`;
  }
  h += chatHtml();
  h += `<section><h2>Full change log</h2><ul class="log">${store.log.map((e) => `<li><span class="muted small">${new Date(e.ts).toLocaleString()}</span> ${esc(e.text)}</li>`).join("")}</ul></section>`;
  $("listMain").innerHTML = h;
}

function remoteLinkHtml() {
  const l = store.link;
  if (l.state === "answer" || l.state === "connecting") return `<section><h2>Pair with your Mac</h2><p>Paste this into the board on your Mac.</p><div class="code" id="ans">${esc(l.answer)}</div><div class="row"><button data-l="copy">Copy</button><span class="muted small">${l.state === "connecting" ? "Connecting…" : ""}</span></div></section>`;
  if (l.error) return `<section><p class="err">${esc(l.error)}</p></section>`;
  return `<section><p class="muted">${l.state === "making" ? "Preparing the link…" : "Open this page from the QR code on your Mac's board."}</p></section>`;
}

function pairHtml() {
  const p = store.pair;
  let h = `<section><h2>Pair phone</h2>`;
  if (p.qr) {
    const n = p.qr.length, cell = 4, size = (n + 8) * cell;
    let rects = "";
    p.qr.forEach((row, r) => row.forEach((d, c) => { if (d) rects += `<rect x="${(c + 4) * cell}" y="${(r + 4) * cell}" width="${cell}" height="${cell}"/>`; }));
    h += `<div class="qr"><svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="QR code for the phone link"><rect width="${size}" height="${size}" fill="#fff"/><g fill="#000">${rects}</g></svg></div>`;
    h += `<p class="small">Scan with your phone, then paste the code it shows here.</p><textarea id="lanswer" placeholder="Paste the code from your phone"></textarea><div class="row"><button class="primary" data-l="apply">Connect</button><button data-l="unpair">Disconnect</button></div>`;
  }
  h += `<p class="small">${{ making: "Preparing…", waiting: "Waiting for the phone's code.", connecting: "Connecting…", connected: '<span class="ok">Phone connected.</span>', failed: "", closed: "Phone disconnected." }[p.state] ?? ""} ${p.error ? `<span class="err">${esc(p.error)}</span>` : ""}</p>`;
  if (p.state === "connected" || p.state === "closed" || p.state === "failed") h += `<button data-l="unpair">Disconnect</button>`;
  return h + `</section>`;
}

function questionHtml(company, issue, q) {
  const k = q.id;
  if (ui.sent[k]) return `<div class="q ok">Sent.</div>`;
  const d = (ui.drafts[k] ||= { sel: {}, text: "" });
  let h = `<div class="q"><div><strong>${esc(issue.identifier)}</strong> <span class="muted small">${esc(issue.title)}</span></div>${q.title ? `<div>${esc(q.title)}</div>` : ""}`;
  if (q.kind === "ask_user_questions") {
    for (const qq of q.payload.questions || []) {
      h += `<p><strong>${esc(qq.prompt)}</strong>${qq.selectionMode === "multi" ? ' <span class="muted small">(pick any)</span>' : ""}</p><div class="row">`;
      h += qq.options.map((o) => `<button class="${(d.sel[qq.id] || []).includes(o.id) ? "sel" : ""}" data-l="opt" data-q="${esc(k)}" data-qq="${esc(qq.id)}" data-o="${esc(o.id)}" data-m="${qq.selectionMode}">${esc(o.label)}</button>`).join("") + `</div>`;
    }
    h += `<div class="row"><button class="primary" data-l="respond" data-q="${esc(k)}">Send answer</button></div>`;
  } else {
    const p = q.payload || {};
    h += `<p><strong>${esc(p.prompt || q.title)}</strong></p>${p.detailsMarkdown ? `<div class="details">${esc(p.detailsMarkdown)}</div>` : ""}`;
    h += `<div class="row"><button class="primary" data-l="accept" data-q="${esc(k)}">${esc(p.acceptLabel || "Accept")}</button><button data-l="reject" data-q="${esc(k)}">${esc(p.rejectLabel || "Reject")}</button></div>`;
  }
  if (!helperState.has(k)) helperBrief(k);
  h += `<div class="details" style="margin-top:8px">${helperLines(k).map((l) => `<div class="${l.kind === "head" || l.kind === "dim" || l.kind === "meter" ? "muted small" : ""}">${esc(l.text)}</div>`).join("")}</div>`;
  h += `<div class="row"><input type="text" style="flex:1;min-width:0;padding:6px 8px;border:1px solid var(--rule);border-radius:6px;background:var(--sheet)" data-hask="${esc(k)}" placeholder="Ask the local model about this (only what it gathered)"><button data-l="hask" data-q="${esc(k)}">Ask</button></div>`;
  h += `<textarea data-draft="${esc(k)}" placeholder="Or write your own answer (also the reason if you reject)">${esc(d.text)}</textarea><div class="row"><button data-l="qcomment" data-q="${esc(k)}">Send as comment</button></div><div class="err small" id="lerr-${esc(k)}"></div></div>`;
  return h;
}

function chatHtml() {
  const agents = store.agents;
  const sel = ui.chatAgent;
  let h = `<section><h2>Live agent chat</h2><div class="row"><select id="lagent"><option value="">All agents</option>${agents.map((a) => `<option value="${esc(a.id)}" ${a.id === sel ? "selected" : ""}>${a.live ? "● " : ""}${esc(a.name)} (${a.company}${a.issue ? ", " + esc(a.issue) : ""})</option>`).join("")}</select></div>`;
  const msgs = sel ? messagesFor(sel) : [...store.messages.values()].filter((m) => m.role !== "comment").sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  h += `<div class="msgs" id="lmsgs">${msgs.slice(-150).map((m) => {
    const who = m.role === "comment" ? (m.fromUser ? "You" : m.agentName) : m.agentName;
    const t = new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (m.role === "tool") return `<div class="msg tool">${t} ${esc(who)} · ${esc(m.toolName)} ${esc((m.input || "").slice(0, 120))}</div>`;
    return `<div class="msg"><span class="muted small">${t} ${esc(who)}${m.issue ? " · " + esc(m.issue) : ""}</span>\n${esc((m.text || "").slice(0, 2000))}</div>`;
  }).join("") || `<p class="muted">No messages yet.</p>`}</div>`;
  const a = agents.find((x) => x.id === sel);
  const issues = a ? [...new Map([[a.issueId, { id: a.issueId, identifier: a.issue }], ...(a.openIssues || []).map((i) => [i.id, i])]).values()].filter((i) => i.id) : allIssues().filter((i) => OPEN.includes(i.status));
  const target = issues.find((i) => i.id === ui.chatIssue) ?? issues[0];
  if (target) {
    h += `<div class="row"><label class="small muted">Comment on <select id="lissue" style="width:auto">${issues.map((i) => `<option value="${esc(i.id)}" ${i.id === target.id ? "selected" : ""}>${esc(i.identifier)}</option>`).join("")}</select></label></div>`;
    h += `<textarea id="lchat" placeholder="Write to ${esc(a?.name ?? "the agent")}">${esc(ui.chatText)}</textarea><div class="row"><button class="primary" data-l="chatSend">Comment on ${esc(target.identifier)}</button></div>`;
  }
  return h + `</section>`;
}

document.addEventListener("click", async (ev) => {
  const b = ev.target.closest("#list button, #skip");
  if (!b) return;
  ev.preventDefault();
  if (b.id === "skip") return toggleList(true);
  const l = b.dataset.l;
  const note = (t) => { ui.msg = t; renderList(); };
  try {
    if (l === "close") return toggleList(false);
    if (l === "refresh") { await act("refresh"); return note(""); }
    if (l === "pair") { await startPairing(); return renderList(); }
    if (l === "unpair") { stopPairing(); return renderList(); }
    if (l === "apply") { await applyAnswer($("lanswer").value); return renderList(); }
    if (l === "copy") { await copyText(store.link.answer); return note("Copied. Paste it into the board on your Mac."); }
    if (l === "eta") { await act("eta", { issue: b.dataset.i }); return note(`Estimating ${b.dataset.i}…`); }
    if (l === "etaAll") { await act("eta", { company: b.dataset.c }); return note(`Estimating ${b.dataset.c}…`); }
    if (l === "chatSend") {
      const text = ui.chatText.trim(); if (!text) return;
      const issueId = $("lissue").value;
      await act("comment", { issueId, text });
      ui.chatText = ""; return note("Sent.");
    }
    if (l === "hask") { const inp = document.querySelector(`[data-hask="${b.dataset.q}"]`); const t = inp?.value.trim(); if (t) { inp.value = ""; await helperAsk(b.dataset.q, t); } return; }
    if (l === "opt") {
      const d = ui.drafts[b.dataset.q]; const cur = d.sel[b.dataset.qq] || [];
      d.sel[b.dataset.qq] = b.dataset.m === "multi" ? (cur.includes(b.dataset.o) ? cur.filter((x) => x !== b.dataset.o) : [...cur, b.dataset.o]) : [b.dataset.o];
      return renderList();
    }
    if (["respond", "accept", "reject", "qcomment"].includes(l)) {
      const found = allQuestions().find((x) => x.q.id === b.dataset.q); if (!found) return;
      const errEl = $("lerr-" + found.q.id);
      try { await answerQuestion(found, l, ui.drafts[found.q.id]); ui.sent[found.q.id] = true; renderList(); }
      catch (e) { errEl.textContent = e.message; }
    }
  } catch (e) { note("Not done: " + e.message); }
});
document.addEventListener("input", (ev) => {
  const t = ev.target;
  if (t.dataset?.draft) ui.drafts[t.dataset.draft].text = t.value;
  if (t.id === "lchat") ui.chatText = t.value;
});
document.addEventListener("change", async (ev) => {
  const t = ev.target;
  if (t.id === "lagent") { ui.chatAgent = t.value; ui.chatIssue = ""; renderList(); }
  if (t.id === "lissue") ui.chatIssue = t.value;
  if (t.id === "linterval") { try { await act("config", { intervalSec: Math.max(5, Math.round(+t.value || 15)) }); } catch (e) { ui.msg = e.message; } renderList(); }
});

// Shared by the list view and the scene. kind: respond | accept | reject | qcomment
export async function answerQuestion({ issue, q }, kind, draft) {
  const text = (draft?.text ?? "").trim();
  const payload = { issueId: issue.id, interactionId: q.id };
  if (kind === "respond") {
    payload.action = "respond";
    payload.answers = (q.payload.questions || []).filter((qq) => (draft.sel[qq.id] || []).length).map((qq) => ({ questionId: qq.id, optionIds: draft.sel[qq.id] }));
    if (!payload.answers.length) throw new Error("Pick an option first.");
  } else if (kind === "accept") payload.action = "accept";
  else if (kind === "reject") {
    payload.action = "reject"; payload.reason = text;
    if (q.payload.rejectRequiresReason && !text) throw new Error("Write a reason first.");
  } else {
    if (!text) throw new Error("Write something first.");
    payload.action = "comment"; payload.text = text;
  }
  return act("answer", payload);
}

export async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch {
    const ta = document.createElement("textarea"); ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select(); const ok = document.execCommand("copy"); ta.remove(); return ok;
  }
}

for (const ev of ["board", "log", "logEntry", "chat", "agents", "pair", "link", "helper"]) store.on(ev, () => renderList());
let listMsgTimer = null;
store.on("msg", () => { clearTimeout(listMsgTimer); listMsgTimer = setTimeout(renderList, 400); });
setInterval(() => { const c = document.getElementById("lcount"); if (c) c.textContent = `Next refresh in ${Math.max(0, Math.round((store.countdownAt - Date.now()) / 1000))}s`; }, 1000);

// Host: reload the board when the server's countdown runs out.
setInterval(() => { if (store.mode === "host" && Date.now() > store.countdownAt + 1500) { store.countdownAt = Date.now() + 5000; hostLoad(); } }, 1000);

// ---------------- boot ----------------
// ---------------- demo mode ----------------
let demo = null;
export async function startDemo() {
  if (store.mode === "demo") return;
  try { hostEs?.close(); } catch {}
  const { createDemo } = await import("./demo.js");
  store.mode = "demo";
  demo = createDemo({ setBoard, setLog, addLog, upsertMsg, setChat, setAgents, emit: (ev, d) => store.emit(ev, d) });
  store.emit("mode", "demo");
  demo.start();
}

// Mac: ask the server to poll again, then reload the board.
async function retryConnect() {
  try { await http("api/refresh", { method: "POST" }); } catch {}
  try { const b = await http("api/board"); store.mode = "host"; setBoard(b); } catch {}
}
function projectCheck() {
  const b = store.board;
  if (store.mode !== "host" || !b) return { found: false, names: [], reason: store.link.error || "The board server did not answer." };
  if (!b.companies?.length) return { found: false, names: [], reason: b.error ? `Paperclip did not answer (${b.error}).` : "Paperclip has none of the watched companies." };
  return { found: true, names: b.companies.map((c) => c.name), projects: b.companies.map((c) => ({ id: c.id, name: c.name, prefix: c.prefix, open: c.issues.filter((i) => OPEN.includes(i.status)).length })) };
}
// The connect panel talks to the server directly on the Mac and through the Mac on the phone.
export async function boardHttp(path, opts = {}) {
  if (store.mode === "remote") {
    if (path.startsWith("api/available-companies")) return act("available", { url: new URLSearchParams(path.split("?")[1] ?? "").get("url") });
    if (path === "api/companies") return act("companies", JSON.parse(opts.body));
  }
  return http(path, opts);
}
export async function openConnectPanel(done) {
  const ui = await import("./ui.js");
  ui.openConnect({ http: boardHttp, onAdded: (c) => {
    if (c && store.selection) store.selection = [...store.selection, c.id];
    store.emit("projectAdded", c);
    if (store.mode === "host") hostLoad();
    done?.(c ? { id: c.id, name: c.name, prefix: c.prefix, open: null } : null);
  } });
}
export async function openHelpPanel() { (await import("./ui.js")).openHelp(); }
function lastSelection() { try { const v = localStorage.getItem("lastSelection"); return v === "demo" ? "demo" : v ? JSON.parse(v) : null; } catch { return null; } }
function saveSelection(pick) { try { localStorage.setItem("lastSelection", pick.demo ? "demo" : JSON.stringify(pick.ids)); } catch {} }

async function boot() {
  const offer = new URLSearchParams(location.hash.slice(1)).get("o");
  if (offer) startRemote(offer);
  else {
    try {
      const b = await http("api/board");
      store.mode = "host";
      setBoard(b);
      setChat(await http("api/chat"));
      setLog(await http("api/log?limit=500"));
      hostStream();
    } catch (e) {
      store.mode = "lost";
      setLink({ state: "idle", error: /Access key/.test(e.message) ? e.message : "" });
    }
  }
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Intro (door → cockpit → window). Skipped if it played in the last hour.
  try {
    const intro = await import("./intro.js");
    if (!intro.shouldSkipIntro()) {
      intro.runIntro({
        mode: store.mode === "host" ? "mac" : "phone", canvas: $("sky"), reduced,
        videoSrc: "assets/intro.mp4" + (key && store.mode === "host" ? `?key=${encodeURIComponent(key)}` : ""),
        check: async () => { await new Promise((r) => setTimeout(r, 700)); return projectCheck(); },
        onRetry: retryConnect,
        linkView: () => ({ ...store.link, offer: Boolean(offer) }),
        onLink: (cb) => store.on("link", cb),
        phoneProjects: () => ({ projects: (store.board?.companies ?? []).map((c) => ({ id: c.id, name: c.name, prefix: c.prefix, open: c.issues.filter((i) => OPEN.includes(i.status)).length })) }),
        connect: (done) => openConnectPanel(done),
        help: () => openHelpPanel(),
        lastSelection: () => { const l = lastSelection(); return l === "demo" ? null : l; },
        saveSelection,
        select: (ids) => { store.selection = ids; if (store.board) { const raw = store.rawBoard ?? store.board; setBoard(raw); } },
        copy: copyText,
        onDemo: () => startDemo(),
        frame: () => store.frameApi,
        emit: (ev, d) => store.emit(ev, d),
        sound: async (name) => { const snd = await import("./sound.js"); if (name === "press") snd.startAudio(); /* unlock only: the intro video plays its own soundtrack */ else snd.play(name); },
      });
      store.introPending = true;
    }
  } catch (e) { console.error("intro", e); $("sky").style.opacity = "1"; }
  try {
    const { startScene } = await import("./scene.js");
    await startScene({ canvas: $("sky"), kbd: $("kbd"), reduced });
  } catch (e) {
    console.error("Scene failed, showing the list view", e);
    toggleList(true);
  }
}
boot();
