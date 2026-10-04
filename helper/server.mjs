// Orbit service (Paperclip status board): a live board for the companies in a local Paperclip.
// No dependencies. Polls the Paperclip API on an interval, records status changes and new
// questions in log.jsonl, and serves index.html plus a small JSON API.
//   node server.mjs   → http://127.0.0.1:4320
// Writes to Paperclip only when the page POSTs an answer. ETA estimates use the local
// Ollama model and run only when the page asks for one.
import { createServer } from "node:http";
import { readFile, writeFile, appendFile, rename, chmod, stat as fstat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir } from "node:fs/promises";
const IS_WIN = process.platform === "win32";
import { networkInterfaces } from "node:os";
import { createChat } from "./chat.mjs";
import { createHelper } from "./helper.mjs";
import { createAccess } from "./access.mjs";
import { createControls } from "./controls.mjs";
import { VERSION, SITE } from "./version.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// Data files (config, token, log, state, estimates, connected websites) live next to the code unless
// ORBIT_DATA_DIR points elsewhere.
const DATA = process.env.ORBIT_DATA_DIR ? resolve(process.env.ORBIT_DATA_DIR) : here;
await mkdir(DATA, { recursive: true });
let PAPERCLIP = (process.env.PAPERCLIP_URL ?? "http://localhost:3100").replace(/\/$/, "") + "/api";
const OLLAMA = (process.env.OLLAMA_URL ?? "http://localhost:11434").replace(/\/$/, "");
const PORT = Number(process.env.BOARD_PORT ?? 4320);
const MODELS = ["qwen2.5-coder:7b", "qwen3:4b"];
const LOG_KEEP = 500;

// Tracked companies: config.json "companies" pins a list; without it, every active company in
// Paperclip is shown and new ones appear on the next poll (per-company choices go in "companyPrefs").
const COMPANIES = []; // mutated in place so the chat module sees changes
const OPEN = new Set(["in_progress", "blocked", "in_review", "todo"]);
const STATUS_WORDS = {
  backlog: "backlog", todo: "to do", in_progress: "in progress", in_review: "in review",
  blocked: "blocked", done: "done", cancelled: "cancelled",
};

const file = (name) => join(DATA, name);

async function readJson(name, fallback) {
  try { return JSON.parse(await readFile(file(name), "utf8")); } catch { return fallback; }
}
async function writeJson(name, value, opts = {}) {
  const tmp = file(name + ".tmp");
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", opts.mode ? { mode: opts.mode } : undefined);
  await rename(tmp, file(name));
}

let config = { intervalSec: 15, host: "127.0.0.1", phoneUrl: "https://thenewurbankid-web.github.io/orbit/", ...(await readJson("config.json", {})) };
// config.json "paperclipUrl" (or the PAPERCLIP_URL env var) points the board at another Paperclip.
if (config.paperclipUrl && !process.env.PAPERCLIP_URL) PAPERCLIP = String(config.paperclipUrl).replace(/\/$/, "") + "/api";
const ALERT_DEFAULTS = { unreachableMin: 2, blockedHighMin: 30, questionWarnMin: 30, questionCritMin: 120, blockedPerCompany: 3, notify: true, notifyLevel: "critical" };
config.alerts = { ...ALERT_DEFAULTS, ...(config.alerts ?? {}) };
const autoCompanies = () => !Array.isArray(config.companies);
if (!autoCompanies()) COMPANIES.push(...config.companies);
// Re-read config.json when it changes on disk (thresholds, companies), so edits apply without a restart.
let configMtime = 0;
async function reloadConfig() {
  try {
    const st = await fstat(file("config.json"));
    if (st.mtimeMs === configMtime) return;
    configMtime = st.mtimeMs;
    const c = await readJson("config.json", null);
    if (!c) return;
    config = { ...config, ...c, alerts: { ...ALERT_DEFAULTS, ...(c.alerts ?? {}) } };
    if (Array.isArray(c.companies)) setCompanies(c.companies);
  } catch { /* keep the current config */ }
}
function setCompanies(list0) {
  const before = new Set(COMPANIES.map((c) => c.id));
  COMPANIES.length = 0; COMPANIES.push(...list0);
  for (const c of COMPANIES) if (!before.has(c.id)) freshCompanies.add(c.prefix);
}
// Auto mode: follow Paperclip's own company list (archived companies are left out).
async function discoverCompanies() {
  if (!autoCompanies()) return;
  const prefs = config.companyPrefs ?? {};
  const cos = list(await api("/companies", { base: PAPERCLIP }), "companies").filter((c) => c?.id && (!c.status || c.status === "active"));
  setCompanies(cos.map((c) => {
    const prev = COMPANIES.find((x) => x.id === c.id);
    return { id: c.id, name: c.name, prefix: c.issuePrefix ?? c.prefix ?? "", planet: prefs[c.id]?.planet ?? prev?.planet ?? planetFor(c.id), ...(prefs[c.id]?.poc ? { poc: prefs[c.id].poc } : {}) };
  }));
}
const freshCompanies = new Set(); // added since the last poll: their issues are not logged as "new"
// Paperclip base URL per request: a company may live on another Paperclip instance.
const issueBase = new Map(), runBase = new Map();
const baseOf = (c) => (c?.paperclipUrl ? String(c.paperclipUrl).replace(/\/$/, "") + "/api" : PAPERCLIP);
function baseFor(path) {
  let m = /^\/companies\/([^/?]+)/.exec(path);
  if (m) return baseOf(COMPANIES.find((c) => c.id === m[1]));
  m = /^\/issues\/([^/?]+)/.exec(path);
  if (m && issueBase.has(m[1])) return issueBase.get(m[1]);
  m = /^\/heartbeat-runs\/([^/?]+)/.exec(path);
  if (m && runBase.has(m[1])) return runBase.get(m[1]);
  return PAPERCLIP;
}

// Access token: every request needs it unless it comes from this computer (127.0.0.1).
let token;
try { token = (await readFile(file("token.txt"), "utf8")).trim(); } catch { /* first run */ }
if (!/^[0-9a-f]{32}$/.test(token ?? "")) {
  token = randomBytes(16).toString("hex");
  await writeFile(file("token.txt"), token + "\n", { mode: 0o600 });
}
// Owner-only file mode where the OS has one (on Windows the per-user app-data folder protects it).
if (!IS_WIN) await chmod(file("token.txt"), 0o600).catch(() => {});
function keyOk(req, url) {
  const given = String(req.headers["x-board-key"] ?? url.searchParams.get("key") ?? "");
  const a = Buffer.from(given), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
function lanAddress() {
  const nets = networkInterfaces();
  const pick = (list) => list?.find((n) => n.family === "IPv4" && !n.internal)?.address;
  return pick(nets.en0) ?? Object.values(nets).map(pick).find(Boolean) ?? null;
}
let eta = await readJson("eta.json", {});
const etaRunning = new Set();
let board = { companies: [], polledAt: null, error: null };
let nextPollAt = Date.now();
let timer = null;
let polling = null;

// At most 6 Paperclip requests in flight; it slows down under bursts.
let inFlight = 0;
const waiting = [];
// Start / stop work on one project: stop pauses every agent and cancels its in-progress runs;
// start resumes every agent and wakes it. dryRun reports what would change without touching anything.
async function projectWork({ companyId, action, dryRun }) {
  const cfg = COMPANIES.find((c) => c.id === companyId);
  if (!cfg) throw Object.assign(new Error("Unknown project"), { status: 404 });
  if (!["stop", "pause", "start"].includes(action)) throw Object.assign(new Error("action must be stop, pause or start"), { status: 400 });
  const base = baseOf(cfg);
  const agentsRaw = await api(`/companies/${companyId}/agents`, { base });
  const agents = (Array.isArray(agentsRaw) ? agentsRaw : agentsRaw?.agents ?? []).map((a) => ({ id: a.id, name: a.name, status: a.status, paused: Boolean(a.pausedAt) || a.status === "paused" }));
  const runsRaw = action !== "start" ? await api(`/companies/${companyId}/live-runs`, { base }) : [];
  const runs = (Array.isArray(runsRaw) ? runsRaw : runsRaw?.runs ?? []).filter((r) => ["queued", "running"].includes(r.status)).map((r) => ({ id: r.id, agent: r.agentName, status: r.status }));
  const plan = action !== "start"
    ? { pause: agents.filter((a) => !a.paused).map((a) => a.name), cancel: action === "stop" ? runs.map((r) => `${r.agent} (${r.status})`) : [] }
    : { resume: agents.filter((a) => a.paused).map((a) => a.name), wake: agents.map((a) => a.name) };
  if (dryRun) return { dryRun: true, project: cfg.name, action, plan };
  const errors = [];
  const run = async (label, fn) => { try { await fn(); } catch (e) { errors.push(`${label}: ${e.message}`); } };
  if (action !== "start") {
    for (const a of agents) if (!a.paused) await run(`pause ${a.name}`, () => api(`/agents/${a.id}/pause`, { base, method: "POST", body: JSON.stringify({ reason: action === "stop" ? "Stopped from Orbit" : "Paused from Orbit" }) }));
    if (action === "stop") for (const r of runs) await run(`cancel ${r.agent}`, () => api(`/heartbeat-runs/${r.id}/cancel`, { base, method: "POST", body: "{}" }));
  } else {
    for (const a of agents) if (a.paused) await run(`resume ${a.name}`, () => api(`/agents/${a.id}/resume`, { base, method: "POST", body: "{}" }));
    for (const a of agents) await run(`wake ${a.name}`, () => api(`/agents/${a.id}/wakeup`, { base, method: "POST", body: "{}" }));
  }
  await addLog([{ ts: new Date().toISOString(), company: cfg.name, text: action !== "start" ? `work ${action === "stop" ? "stopped" : "paused"} from Orbit (${plan.pause.length} agents paused, ${plan.cancel.length} runs cancelled)` : `work started from Orbit (${agents.length} agents woken)` }]);
  return { ok: errors.length === 0, project: cfg.name, action, plan, errors };
}

// Point of contact per project: config "poc" (agent id) if set, else the agent whose name or role
// says lead/cto/ceo/manager, else the first agent.
function pickPoc(cfg, agents) {
  if (cfg.poc) { const a = agents.find((x) => x.id === cfg.poc); if (a) return a; }
  return agents.find((a) => /lead|cto|ceo|manager|director/i.test(`${a.name} ${a.role ?? ""}`)) ?? agents[0] ?? null;
}
async function projectAgents(cfg) {
  const raw = await api(`/companies/${cfg.id}/agents`, { base: baseOf(cfg) });
  return (Array.isArray(raw) ? raw : raw?.agents ?? []).map((a) => ({ id: a.id, name: a.name, role: a.role ?? a.title ?? null }));
}
async function setPoc({ companyId, agentId }) {
  const cfg = COMPANIES.find((c) => c.id === companyId);
  if (!cfg) throw Object.assign(new Error("Unknown project"), { status: 404 });
  if (autoCompanies()) config.companyPrefs = { ...(config.companyPrefs ?? {}), [companyId]: { ...(config.companyPrefs?.[companyId] ?? {}), poc: agentId || undefined } };
  else { const cc = config.companies.find((c) => c.id === companyId); if (cc) cc.poc = agentId || undefined; }
  cfg.poc = agentId || undefined;
  await writeJson("config.json", config);
  return { ok: true };
}
// "Message the lead": a new task assigned to the point of contact, then a wake-up so it starts.
async function projectMessage({ companyId, text, dryRun }) {
  const cfg = COMPANIES.find((c) => c.id === companyId);
  if (!cfg) throw Object.assign(new Error("Unknown project"), { status: 404 });
  const body = String(text ?? "").trim();
  if (!body) throw Object.assign(new Error("Write a message first"), { status: 400 });
  const poc = pickPoc(cfg, await projectAgents(cfg));
  if (!poc) throw Object.assign(new Error("This project has no agents"), { status: 400 });
  const title = "From the board: " + (body.split("\n")[0].slice(0, 70) + (body.length > 70 ? "…" : ""));
  if (dryRun) return { dryRun: true, to: poc.name, title };
  const base = baseOf(cfg);
  // Attach the task to the project most of this company's issues use, so the agent runs in its repo
  // (a task without a project ran outside any git checkout and failed).
  const existing = await api(`/companies/${companyId}/issues`, { base }).catch(() => []);
  const counts = new Map(); for (const i of (Array.isArray(existing) ? existing : existing?.issues ?? [])) if (i.projectId) counts.set(i.projectId, (counts.get(i.projectId) ?? 0) + 1);
  const projectId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const issue = await api(`/companies/${companyId}/issues`, { base, method: "POST", body: JSON.stringify({ title, description: body, status: "todo", priority: "high", assigneeAgentId: poc.id, ...(projectId ? { projectId } : {}) }) });
  try { await api(`/agents/${poc.id}/wakeup`, { base, method: "POST", body: "{}" }); } catch {}
  await addLog([{ ts: new Date().toISOString(), company: cfg.name, issue: issue?.identifier ?? null, text: `message to ${poc.name}: ${title.slice(16)}` }]);
  return { ok: true, to: poc.name, issue: issue?.identifier ?? null };
}

async function api(path, init = {}) {
  if (inFlight >= 6) await new Promise((r) => waiting.push(r));
  inFlight++;
  try { return await apiRaw(path, init); } finally { inFlight--; waiting.shift()?.(); }
}
async function apiRaw(path, init = {}) {
  const res = await fetch((init.base ?? baseFor(path)) + path, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(init.timeoutMs ?? 20000),
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const msg = typeof body === "object" && body ? (body.error ?? body.message ?? JSON.stringify(body)) : String(body);
    throw Object.assign(new Error(`Paperclip ${res.status}: ${msg}`), { status: res.status });
  }
  return body;
}
const list = (body, key) => (Array.isArray(body) ? body : body?.[key] ?? []);

// ---------- log ----------
async function readLog() {
  try {
    const text = await readFile(file("log.jsonl"), "utf8");
    return text.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
async function addLog(entries) {
  if (!entries.length) return;
  for (const e of entries) emitSse({ type: "log", entry: e });
  await appendFile(file("log.jsonl"), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const all = await readLog();
  if (all.length > LOG_KEEP) {
    const tmp = file("log.jsonl.tmp");
    await writeFile(tmp, all.slice(-LOG_KEEP).map((e) => JSON.stringify(e)).join("\n") + "\n");
    await rename(tmp, file("log.jsonl"));
  }
}

// ---------- server-sent events ----------
const sseClients = new Set();
function emitSse(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) res.write(data);
}
let chatStarted = false;
const chat = createChat({ api, list: (b, k) => list(b, k), companies: COMPANIES, emit: emitSse, noteRun: (runId, companyId) => runBase.set(runId, baseOf(COMPANIES.find((c) => c.id === companyId))) });
// Tail live runs every 3 s while someone is watching; otherwise only with the board poll.
setInterval(() => { if (sseClients.size) chat.tick().catch(() => {}); }, 3000);
setInterval(() => { for (const res of sseClients) res.write(": ping\n\n"); }, 25000);

// ---------- polling ----------
function snippet(md, n = 300) {
  const text = String(md ?? "").replace(/\s+/g, " ").trim();
  return text.length > n ? text.slice(0, n) + "…" : text;
}

const issueComments = new Map(); // issueId → comments, newest first (open issues only)

async function loadCompany(company, agentNames) {
  const issues = list(await api(`/companies/${company.id}/issues`), "issues");
  for (const i of issues) issueBase.set(i.id, baseOf(company));
  const out = [];
  await Promise.all(issues.map(async (issue) => {
    const open = OPEN.has(issue.status);
    let comments = [];
    let questions = [];
    if (open) {
      [comments, questions] = await Promise.all([
        api(`/issues/${issue.id}/comments`).then((b) => list(b, "comments")).catch(() => []),
        api(`/issues/${issue.id}/interactions`).then((b) => list(b, "interactions")).catch(() => []),
      ]);
    }
    if (open) issueComments.set(issue.id, comments.slice(0, 30));
    const last = comments.find((c) => !c.deletedAt);
    out.push({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      status: issue.status,
      priority: issue.priority,
      assigneeAgentId: issue.assigneeAgentId ?? null,
      completedAt: issue.completedAt ?? null,
      blockedTransitionAt: issue.blockedTransitionAt ?? null,
      assignee: agentNames.get(issue.assigneeAgentId) ?? null,
      updatedAt: issue.updatedAt,
      lastComment: last ? {
        text: snippet(last.body),
        full: String(last.body ?? "").slice(0, 4000),
        at: last.createdAt,
        author: last.authorUserId ? "You (board)" : agentNames.get(last.authorAgentId) ?? "Agent",
      } : null,
      questions: questions.filter((q) => q.status === "pending" && (q.kind === "ask_user_questions" || q.kind === "request_confirmation")).map((q) => ({
        id: q.id, kind: q.kind, title: q.title, createdAt: q.createdAt, payload: q.payload,
      })),
    });
  }));
  const order = { in_progress: 0, blocked: 1, in_review: 2, todo: 3 };
  const prio = { critical: 0, urgent: 0, high: 1, medium: 2, low: 3 };
  out.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || (prio[a.priority] ?? 5) - (prio[b.priority] ?? 5) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return { ...company, issues: out };
}

async function poll() {
  if (polling) return polling;
  polling = (async () => {
    await reloadConfig();
    try {
      await discoverCompanies();
      const agentNames = new Map();
      const agentList = [];
      await Promise.all(COMPANIES.map(async (c) => {
        const agents = list(await api(`/companies/${c.id}/agents`).catch(() => []), "agents");
        for (const a of agents) {
          agentNames.set(a.id, a.name);
          agentList.push({ id: a.id, name: a.name, company: c.prefix, role: a.role ?? a.title ?? null, agentStatus: a.status ?? null, paused: Boolean(a.pausedAt) || a.status === "paused" });
        }
      }));
      issueComments.clear();
      const companies = await Promise.all(COMPANIES.map((c) => loadCompany(c, agentNames)));
      await recordChanges(companies);
      for (const c of companies) { const ags = agentList.filter((a) => a.company === c.prefix); c.paused = ags.length > 0 && ags.every((a) => a.paused); const cfg0 = COMPANIES.find((x) => x.id === c.id) ?? {}; const pc = pickPoc(cfg0, ags); c.poc = pc ? { id: pc.id, name: pc.name } : null; c.agents = ags.map((a) => ({ id: a.id, name: a.name, paused: a.paused })); }
      for (const c of companies) { const cfg = COMPANIES.find((x) => x.id === c.id); c.planet = cfg?.planet ?? null; c.paperclipUrl = cfg?.paperclipUrl ?? null; }
      board = { companies, polledAt: new Date().toISOString(), error: null };
      lastOkAt = Date.now();
      await pollRuns();
      agentList.sort((a, b) => a.company.localeCompare(b.company) || a.name.localeCompare(b.name));
      chat.updateBoard(board, issueComments, agentList);
      if (!chatStarted) chatStarted = await chat.start().then(() => true, () => false);
      autoEstimate(companies);
      emitSse({ type: "board" });
    } catch (error) {
      board = { ...board, error: String(error?.message ?? error) };
    } finally {
      await evaluateAlerts().catch((e) => console.error("alerts:", e.message));
      polling = null;
    }
  })();
  return polling;
}

async function recordChanges(companies) {
  const state = await readJson("state.json", null);
  const first = !state;
  const prev = state ?? { issues: {}, questions: {} };
  const next = { issues: {}, questions: {} };
  const entries = [];
  const ts = new Date().toISOString();
  for (const c of companies) {
    for (const i of c.issues) {
      next.issues[i.id] = { identifier: i.identifier, status: i.status };
      const was = prev.issues[i.id];
      if (!first && !was && !freshCompanies.has(c.prefix)) entries.push({ ts, company: c.prefix, issue: i.identifier, text: `${i.identifier}: new issue "${snippet(i.title, 80)}" (${STATUS_WORDS[i.status] ?? i.status})` });
      else if (was && was.status !== i.status) entries.push({ ts, company: c.prefix, issue: i.identifier, text: `${i.identifier}: ${STATUS_WORDS[was.status] ?? was.status} → ${STATUS_WORDS[i.status] ?? i.status}` });
      for (const q of i.questions) {
        next.questions[q.id] = { identifier: i.identifier, company: c.prefix };
        if (!first && !prev.questions[q.id]) entries.push({ ts, company: c.prefix, issue: i.identifier, text: `${i.identifier}: new question waiting for you` });
      }
    }
  }
  if (!first) {
    for (const [qid, q] of Object.entries(prev.questions)) {
      if (!next.questions[qid]) entries.push({ ts, company: q.company, issue: q.identifier, text: `${q.identifier}: question answered or closed` });
    }
  } else {
    entries.push({ ts, company: null, issue: null, text: `Started watching ${Object.keys(next.issues).length} issues` });
  }
  freshCompanies.clear();
  await writeJson("state.json", next);
  await addLog(entries);
}

function schedule() {
  clearTimeout(timer);
  const ms = Math.max(5, Number(config.intervalSec) || 15) * 1000;
  nextPollAt = Date.now() + ms;
  timer = setTimeout(async () => { await poll(); schedule(); }, ms);
}

// ---------- ETA (local Ollama) ----------
function findIssue(identifier) {
  for (const c of board.companies) {
    const i = c.issues.find((x) => x.identifier === identifier);
    if (i) return { company: c, issue: i };
  }
  return null;
}

// Runs estimates one at a time; identifiers waiting or running are in etaRunning.
let etaQueue = Promise.resolve();
function queueEstimates(ids) {
  const fresh = ids.filter((id) => !etaRunning.has(id));
  for (const id of fresh) {
    etaRunning.add(id);
    etaQueue = etaQueue.then(() => estimate(id)).catch((e) => {
      eta[id] = { ...(eta[id] ?? {}), error: String(e?.message ?? e), errorAt: new Date().toISOString() };
    }).finally(() => etaRunning.delete(id));
  }
  return fresh;
}

// One structured call to the local Ollama model, falling back to the next model on failure.
export async function ollamaJson(messages, schema, { timeoutMs = 90000 } = {}) {
  let lastErr;
  for (const model of MODELS) {
    try {
      const res = await fetch(OLLAMA + "/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          model, stream: false, keep_alive: "15s", ...(model.startsWith("qwen3") ? { think: false } : {}),
          options: { temperature: 0.2, num_ctx: 8192 },
          format: schema,
          messages,
        }),
      });
      if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return { out: JSON.parse((await res.json()).message.content), model };
    } catch (error) { lastErr = error; }
  }
  throw lastErr ?? new Error("no model answered");
}

async function estimate(identifier) {
  const found = findIssue(identifier);
  if (!found) throw new Error(`Unknown issue ${identifier}`);
  const full = await api(`/issues/${found.issue.id}`);
  const comments = list(await api(`/issues/${found.issue.id}/comments`), "comments").filter((c) => !c.deletedAt).slice(0, 8).reverse();
  const prompt = [
    "You estimate progress on one software task done by an AI coding agent. Read the description (the goal) and the comments (what the agent reports).",
    `Task ${identifier}: ${full.title}`,
    `Status: ${STATUS_WORDS[full.status] ?? full.status}. Created: ${full.createdAt}. Now: ${new Date().toISOString()}.`,
    "Guide for pct by status: todo 0-5; in_progress 10-90 depending on how many parts of the goal the comments say are finished; in_review 85-95; blocked = progress before it got stuck; done 100.",
    "Guide for eta: agents wake about every 30 minutes and finish one step per wake; count the steps left.",
    "",
    "Goal (description):",
    String(full.description ?? "(none)").slice(0, 3000),
    "",
    `Comments (last ${comments.length}, oldest first):`,
    ...comments.map((c) => `--- ${c.createdAt} by ${c.authorUserId ? "owner" : "agent"}\n${String(c.body ?? "").slice(0, 1200)}`),
    "",
    "First list what is done and what is left, then give pct, eta and a one-sentence note.",
    "/no_think",
  ].join("\n");
  const schema = {
    type: "object",
    properties: {
      done: { type: "array", items: { type: "string" } },
      left: { type: "array", items: { type: "string" } },
      pct: { type: "integer", minimum: 0, maximum: 100 },
      eta: { type: "string" },
      note: { type: "string" },
    },
    required: ["done", "left", "pct", "eta", "note"],
  };
  try {
    const { out, model } = await ollamaJson([{ role: "user", content: prompt }], schema);
    const status = full.status;
    let pct = Math.max(0, Math.min(100, Math.round(Number(out.pct) || 0)));
    if (status === "todo") pct = Math.min(pct, 5);
    if (status === "in_review") pct = Math.max(pct, 85);
    if (status === "done") pct = 100;
    const left = (Array.isArray(out.left) ? out.left : []).map((x) => String(x).slice(0, 200)).slice(0, 12);
    const done = (Array.isArray(out.done) ? out.done : []).map((x) => String(x).slice(0, 200)).slice(0, 12);
    const waiting = found.issue.questions?.length > 0;
    // The ETA is computed from the steps left, not taken from the model.
    const etaText = status === "done" ? "done" : waiting ? "waiting on you" : status === "blocked" ? "blocked" : `~${Math.max(0.5, left.length * 0.5)} h`;
    eta[identifier] = {
      pct, eta: etaText, etaModel: String(out.eta ?? "").slice(0, 80), done, left,
      note: String(out.note ?? "").slice(0, 400), model, at: new Date().toISOString(),
    };
  } catch (error) {
    eta[identifier] = { ...(eta[identifier] ?? {}), error: String(error?.message ?? error), errorAt: new Date().toISOString() };
  }
  await writeJson("eta.json", eta);
}

const helper = createHelper({ api, list, board: () => board, ollamaJson, repos: () => config.repos ?? {} });

// Auto-estimates, paced by the poll: re-estimate issues whose status changed or that got a new
// comment; otherwise refresh the single oldest estimate when nothing is queued.
const seenForEta = new Map(); // issueId → {status, commentId}
let etaPrimed = false;
function autoEstimate(companies) {
  const open = companies.flatMap((c) => c.issues).filter((i) => OPEN.has(i.status));
  const changed = [];
  for (const i of open) {
    const commentId = issueComments.get(i.id)?.find((c) => !c.deletedAt)?.id ?? null;
    const prev = seenForEta.get(i.id);
    if (prev && (prev.status !== i.status || prev.commentId !== commentId)) changed.push(i.identifier);
    seenForEta.set(i.id, { status: i.status, commentId });
  }
  if (!etaPrimed) { etaPrimed = true; queueEstimates(open.map((i) => i.identifier)); return; }
  queueEstimates(changed);
  // No round-robin refresh: it kept the 7B model loaded (~5 GB) and starved other local work
  // (ComfyUI). Estimates now run only when an issue changes, or on request.
}

// ---------- alerts ----------
// Evaluated after every poll. Levels: warning (amber, a chime) and critical (red alert, klaxon,
// macOS notification once). An acknowledged alert stays quiet unless it gets worse.
let lastOkAt = Date.now();
let recentRuns = []; // [{id, status, issueId, company, finishedAt}]
let alerts = await readJson("alerts.json", {}); // id → {level, text, issueId, identifier, company, since, ackLevel, notifiedAt}
const RANK = { warning: 1, critical: 2 };
async function pollRuns() {
  const out = [];
  await Promise.all(COMPANIES.map(async (c) => {
    const rs = list(await api(`/companies/${c.id}/heartbeat-runs?limit=12`).catch(() => []), "runs");
    for (const r of rs) out.push({ id: r.id, status: r.status, issueId: r.contextSnapshot?.issueId ?? r.issueId ?? null, company: c.prefix, finishedAt: r.finishedAt, error: r.error ?? null });
  }));
  recentRuns = out;
}
const FAILED = new Set(["failed", "error", "timed_out", "crashed", "lost"]);
async function evaluateAlerts() {
  const A = config.alerts, now = Date.now(), found = {};
  const add = (id, level, text, extra = {}) => { if (!found[id] || RANK[level] > RANK[found[id].level]) found[id] = { level, text, ...extra }; };
  if (board.error && now - lastOkAt > A.unreachableMin * 60000) add("paperclip-down", "critical", `Paperclip unreachable for ${Math.round((now - lastOkAt) / 60000)} min`);
  const issues = board.companies.flatMap((c) => c.issues.map((i) => ({ ...i, company: c.prefix })));
  const byId = new Map(issues.map((i) => [i.id, i]));
  // Runs: two failures in a row on one issue, or any recent failure on a high-priority issue.
  const perIssue = new Map();
  for (const r of recentRuns.filter((r) => r.finishedAt).sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt)))) {
    if (!r.issueId) continue; (perIssue.get(r.issueId) ?? perIssue.set(r.issueId, []).get(r.issueId)).push(r);
  }
  for (const [issueId, runs] of perIssue) {
    const i = byId.get(issueId); if (!i || !OPEN.has(i.status)) continue;
    const ctx = { issueId, identifier: i.identifier, company: i.company };
    if (runs.length >= 2 && FAILED.has(runs[0].status) && FAILED.has(runs[1].status)) add(`runs2:${issueId}`, "critical", `${i.identifier} run failed twice in a row`, ctx);
    else if (FAILED.has(runs[0].status) && ["high", "critical", "urgent"].includes(i.priority) && now - new Date(runs[0].finishedAt) < 3600e3) add(`runhigh:${issueId}`, "critical", `${i.identifier} run failed (high priority)`, ctx);
  }
  const blockedBy = {};
  for (const i of issues) {
    const ctx = { issueId: i.id, identifier: i.identifier, company: i.company };
    if (i.status === "blocked") {
      blockedBy[i.company] = (blockedBy[i.company] ?? 0) + 1;
      const since = new Date(i.blockedTransitionAt ?? i.updatedAt).getTime();
      if (["high", "critical", "urgent"].includes(i.priority) && now - since > A.blockedHighMin * 60000) add(`blockedhigh:${i.id}`, "critical", `${i.identifier} blocked for ${Math.round((now - since) / 60000)} min (high priority)`, ctx);
    }
    for (const q of i.questions) {
      const age = (now - new Date(q.createdAt).getTime()) / 60000;
      if (age > A.questionCritMin) add(`q:${q.id}`, "critical", `${i.identifier} question waiting ${Math.round(age / 60)} h`, ctx);
      else if (age > A.questionWarnMin) add(`q:${q.id}`, "warning", `${i.identifier} question waiting ${Math.round(age)} min`, ctx);
    }
    if (i.status === "in_review" && /\b(tests? (are )?fail|failing tests?|\d+ failed)\b/i.test(i.lastComment?.full ?? "")) add(`testsfail:${i.id}`, "critical", `${i.identifier} is in review but tests are failing`, ctx);
  }
  for (const [co, n] of Object.entries(blockedBy)) if (n >= A.blockedPerCompany) add(`blocked3:${co}`, "critical", `${n} blocked issues in ${co}`, { company: co });

  const entries = [], ts = new Date().toISOString();
  for (const [id, a] of Object.entries(found)) {
    const prev = alerts[id];
    if (!prev || RANK[a.level] > RANK[prev.level]) {
      entries.push({ ts, company: a.company ?? null, issue: a.identifier ?? null, text: `▼▼ ${a.level.toUpperCase()} · ${a.text}` });
      if (config.alerts.notify && RANK[a.level] >= RANK[config.alerts.notifyLevel] && !prev?.notifiedAt) notify(a);
    }
    alerts[id] = { ...prev, ...a, since: prev?.since ?? ts, notifiedAt: prev?.notifiedAt ?? (config.alerts.notify && RANK[a.level] >= RANK[config.alerts.notifyLevel] ? ts : null) };
  }
  for (const id of Object.keys(alerts)) if (!found[id]) delete alerts[id]; // cleared
  await writeJson("alerts.json", alerts);
  await addLog(entries);
}
// Desktop notification so it is seen even with the board closed: macOS (osascript), Linux
// (notify-send, if present). Windows: none (the board shows it). Text is passed as data.
function notifyText(title, text) {
  if (process.env.ORBIT_NO_NOTIFY) return;
  const esc = (t) => String(t).replace(/[\\"]/g, "\\$&").slice(0, 200);
  if (process.platform === "darwin") execFile("osascript", ["-e", `display notification "${esc(text)}" with title "${esc(title)}" sound name "Glass"`], () => {});
  else if (process.platform === "linux") execFile("notify-send", [String(title).slice(0, 80), String(text).slice(0, 200)], () => {});
}
function notify(a) { notifyText(`Paperclip · ${a.level.toUpperCase()}`, a.text); }
function alertView() {
  return Object.entries(alerts).map(([id, a]) => ({ id, level: a.level, text: a.text, issueId: a.issueId ?? null, identifier: a.identifier ?? null, company: a.company ?? null, since: a.since, acked: Boolean(a.ackLevel && RANK[a.ackLevel] >= RANK[a.level]) }))
    .sort((x, y) => RANK[y.level] - RANK[x.level] || String(x.since).localeCompare(String(y.since)));
}

// ---------- tracked companies ----------
async function availableCompanies(extraUrl) {
  const bases = new Set([PAPERCLIP, ...COMPANIES.map(baseOf)]);
  if (extraUrl) bases.add(String(extraUrl).replace(/\/$/, "") + "/api");
  const out = [];
  for (const base of bases) {
    let cos;
    try { cos = list(await api("/companies", { base }), "companies"); } catch (e) { out.push({ base, error: String(e.message) }); continue; }
    await Promise.all(cos.map(async (c) => {
      let open = null, total = null;
      try { const is = list(await api(`/companies/${c.id}/issues`, { base }), "issues"); total = is.length; open = is.filter((i) => OPEN.has(i.status)).length; } catch { /* counts unknown */ }
      out.push({ id: c.id, name: c.name, prefix: c.issuePrefix ?? c.prefix ?? "", open, total, tracked: COMPANIES.some((t) => t.id === c.id), paperclipUrl: base === PAPERCLIP ? null : base.replace(/\/api$/, "") });
    }));
  }
  return out;
}
const PLANET_KINDS = ["rocky", "desert", "ocean", "ice", "gas"];
function planetFor(id, roll = 0) {
  let h = 2166136261; for (const ch of id + ":" + roll) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return { kind: PLANET_KINDS[(h >>> 0) % PLANET_KINDS.length], seed: ((h >>> 8) % 10000) / 100, roll };
}
async function changeCompanies(body) {
  const id = String(body.id ?? "");
  let next = [...COMPANIES];
  if (body.action === "add") {
    if (next.some((c) => c.id === id)) throw Object.assign(new Error("Already tracked"), { status: 400 });
    const avail = (await availableCompanies(body.paperclipUrl)).find((c) => c.id === id);
    if (!avail) throw Object.assign(new Error("Paperclip has no company with that id"), { status: 400 });
    next.push({ id, name: avail.name, prefix: avail.prefix, planet: planetFor(id), ...(avail.paperclipUrl ? { paperclipUrl: avail.paperclipUrl } : {}) });
  } else if (body.action === "remove") {
    next = next.filter((c) => c.id !== id);
  } else if (body.action === "reroll") {
    next = next.map((c) => (c.id === id ? { ...c, planet: planetFor(id, (c.planet?.roll ?? 0) + 1) } : c));
    if (autoCompanies()) {
      const planet = next.find((c) => c.id === id)?.planet;
      config = { ...config, companyPrefs: { ...(config.companyPrefs ?? {}), [id]: { ...(config.companyPrefs?.[id] ?? {}), planet } } };
      setCompanies(next);
      await writeJson("config.json", config);
      await poll();
      return { companies: next };
    }
  } else throw Object.assign(new Error("Unknown action"), { status: 400 });
  setCompanies(next);
  config = { ...config, companies: next };
  await writeJson("config.json", config);
  await poll();
  return { companies: next };
}

// ---------- answers ----------
async function answer(body) {
  const { issueId, interactionId, action } = body ?? {};
  if (!issueId) throw Object.assign(new Error("issueId is required"), { status: 400 });
  const known = board.companies.some((c) => c.issues.some((i) => i.id === issueId));
  if (!known) throw Object.assign(new Error("Issue is not on this board"), { status: 400 });
  const base = `/issues/${issueId}/interactions/${interactionId}`;
  if (action === "comment") {
    const text = String(body.text ?? "").trim();
    if (!text) throw Object.assign(new Error("Empty comment"), { status: 400 });
    return api(`/issues/${issueId}/comments`, { method: "POST", body: JSON.stringify({ body: text }) });
  }
  if (!interactionId) throw Object.assign(new Error("interactionId is required"), { status: 400 });
  if (action === "respond") {
    return api(`${base}/respond`, { method: "POST", body: JSON.stringify({ answers: body.answers ?? [] }) });
  }
  if (action === "accept") return api(`${base}/accept`, { method: "POST", body: "{}" });
  if (action === "reject") {
    const reason = String(body.reason ?? "").trim();
    return api(`${base}/reject`, { method: "POST", body: JSON.stringify(reason ? { reason } : {}) });
  }
  throw Object.assign(new Error("Unknown action"), { status: 400 });
}

// ---------- http ----------
function send(res, status, type, body) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}
const json = (res, status, value) => send(res, status, "application/json", JSON.stringify(value));
async function readBody(req) {
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 1e6) throw new Error("body too large"); }
  return raw ? JSON.parse(raw) : {};
}

function boardView() {
  return {
    ...board,
    intervalSec: config.intervalSec,
    nextPollInSec: Math.max(0, Math.round((nextPollAt - Date.now()) / 1000)),
    eta,
    etaRunning: [...etaRunning],
    phoneUrl: config.phoneUrl,
    alerts: alertView(),
    tracked: COMPANIES.map((c) => ({ id: c.id, name: c.name, prefix: c.prefix, planet: c.planet ?? null })),
    agents: chat.snapshot().agents,
  };
}

// Paperclip reachable? Cached for a few seconds; used by /api/health for the setup steps.
let pcHealth = { at: 0, ok: false };
async function paperclipUp() {
  if (Date.now() - pcHealth.at < 5000) return pcHealth.ok;
  let ok = false;
  try { ok = (await fetch(PAPERCLIP + "/health", { signal: AbortSignal.timeout(2500) })).ok; } catch { ok = false; }
  pcHealth = { at: Date.now(), ok };
  return ok;
}
const access = createAccess({ readJson, writeJson, port: PORT, config: () => config, keyOk, notify: notifyText });

// The board page itself: from phone/ next to the code (a developer copy), else the published site,
// cached in the data folder so it also opens offline. Only the allow-listed paths above reach here.
const WEB_DIR = join(here, "phone");
const webFetching = new Map();
async function webFile(rel) {
  const local = join(WEB_DIR, ...rel.split("/"));
  if (await fstat(local).then(() => true, () => false)) return local;
  const cached = join(DATA, "web", ...rel.split("/"));
  const st = await fstat(cached).catch(() => null);
  const fresh = st && (rel.startsWith("assets/") || Date.now() - st.mtimeMs < 3600e3);
  if (fresh) return cached;
  if (!webFetching.has(rel)) webFetching.set(rel, (async () => {
    try {
      const r = await fetch(new URL(rel, config.siteUrl || SITE), { signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(String(r.status));
      await mkdir(dirname(cached), { recursive: true });
      await writeFile(cached + ".tmp", Buffer.from(await r.arrayBuffer()));
      await rename(cached + ".tmp", cached);
    } finally { webFetching.delete(rel); }
  })());
  try { await webFetching.get(rel); } catch (e) { if (!st) throw e; } // offline: keep the old copy
  return cached;
}
const controls = createControls({ port: PORT, here, dataDir: DATA, version: VERSION, site: () => config.siteUrl || SITE, paperclipUp, access: () => access, onExit: () => server.close() });

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const p = url.pathname;
  const info = access.classify(req, url);
  access.cors(res, info);
  try {
    if (req.method === "OPTIONS") return access.preflight(req, res, info);
    // Health: safe to read for the Orbit website (no data beyond "is it there, is Paperclip up").
    if (p === "/api/health" && req.method === "GET") {
      if (!info.access && !(info.corsOk && info.local)) return json(res, 401, { error: "forbidden" });
      return json(res, 200, { app: "orbit", api: 1, version: VERSION, paperclip: await paperclipUp(), connected: Boolean(info.access), companies: board.companies.length });
    }
    if (await access.route(req, res, url, info, { json, send, readBody })) return;
    if (!info.access) {
      if (info.corsOk) return json(res, 401, { error: "not-connected" }); // the Orbit site, no or old token: pair again
      if (info.origin && !info.sameOrigin) return json(res, 403, { error: "This website is not connected to Orbit on this computer." });
      return send(res, 401, "text/plain; charset=utf-8", "Access key missing or wrong. Open the board with the link that includes ?key=… (printed when the server starts, and in token.txt on the Mac).");
    }
    if (req.method === "GET") {
      const page = p === "/" ? "index.html" : p.slice(1);
      if (/^[a-z0-9-]+\.(html|js|css|svg|png|webmanifest)$/.test(page)) {
        const types = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css", svg: "image/svg+xml", png: "image/png", webmanifest: "application/manifest+json" };
        try { return send(res, 200, types[page.split(".").pop()], await readFile(await webFile(page))); } catch { return send(res, 404, "text/plain", "not found"); }
      }
      const asset = /^\/assets\/(intro\.mp4|intro-poster\.jpg|help\/(?:overview|planet|chat)\.jpg|planets\/(?:mars|mercury|moon|earth|earth-clouds|jupiter|ice)(?:-1k)?\.jpg|fx\/(?:explosion|flare|glint|streak|laser|steel|aurora|lightning|comet|meteor)(?:-sm)?\.jpg|fx\/craft(?:-sm)?\.webp)$/.exec(p);
      if (asset) {
        // Byte ranges, so Safari and iOS can play the intro video.
        const f = await webFile("assets/" + asset[1]);
        const size = (await fstat(f)).size;
        const type = asset[1].endsWith(".mp4") ? "video/mp4" : asset[1].endsWith(".webp") ? "image/webp" : asset[1].endsWith(".png") ? "image/png" : "image/jpeg";
        const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
        if (m) {
          const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
          const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
          res.writeHead(206, { "content-type": type, "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes", "content-length": end - start + 1, "cache-control": "max-age=3600" });
          return createReadStream(f, { start, end }).pipe(res);
        }
        res.writeHead(200, { "content-type": type, "content-length": size, "accept-ranges": "bytes", "cache-control": "max-age=3600" });
        return createReadStream(f).pipe(res);
      }
      if (p === "/api/chat") return json(res, 200, chat.snapshot());
      if (p === "/api/chat/stream") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write("retry: 3000\n\n");
        sseClients.add(res);
        req.on("close", () => sseClients.delete(res));
        return;
      }
      if (p === "/api/board") return json(res, 200, boardView());
      if (p === "/api/log") {
        let log = await readLog();
        const company = url.searchParams.get("company");
        if (company) log = log.filter((e) => e.company === company);
        const limit = Number(url.searchParams.get("limit") ?? LOG_KEEP);
        return json(res, 200, log.slice(-limit).reverse());
      }
      if (p === "/api/config") return json(res, 200, config);
      if (p === "/api/helper/status") return json(res, 200, await controls.status());
      if (p === "/api/available-companies") return json(res, 200, await availableCompanies(url.searchParams.get("url")));
      if (p === "/api/helper") return json(res, 200, await helper.get(url.searchParams.get("interaction") ?? ""));
      return send(res, 404, "text/plain", "not found");
    }
    if (req.method === "POST") {
      // Cross-site POSTs (CSRF) never get here: access.classify gives them no access unless they come
      // from a connected Orbit website with its token.
      if (p === "/api/config") {
        const body = await readBody(req);
        const sec = Math.round(Number(body.intervalSec ?? config.intervalSec));
        if (!Number.isFinite(sec) || sec < 5 || sec > 3600) return json(res, 400, { error: "intervalSec must be 5–3600" });
        config = { ...config, intervalSec: sec };
        if (typeof body.phoneUrl === "string" && /^https?:\/\//.test(body.phoneUrl)) config.phoneUrl = body.phoneUrl;
        await writeJson("config.json", config);
        schedule();
        return json(res, 200, config);
      }
      if (p === "/api/refresh") {
        await poll();
        schedule();
        return json(res, 200, boardView());
      }
      if (p === "/api/project-message") { const b = await readBody(req); const r = await projectMessage({ companyId: String(b.companyId ?? ""), text: b.text, dryRun: Boolean(b.dryRun) }); if (!r.dryRun) poll().then(schedule); return json(res, 200, r); }
      if (p === "/api/project-poc") { const b = await readBody(req); const r = await setPoc({ companyId: String(b.companyId ?? ""), agentId: String(b.agentId ?? "") }); poll().then(schedule); return json(res, 200, r); }
      if (p === "/api/project-work") {
        const body = await readBody(req);
        const result = await projectWork({ companyId: String(body.companyId ?? ""), action: String(body.action ?? ""), dryRun: Boolean(body.dryRun) });
        if (!result.dryRun) poll().then(schedule);
        return json(res, 200, result);
      }
      if (p === "/api/answer") {
        const result = await answer(await readBody(req));
        poll().then(schedule);
        return json(res, 200, { ok: true, result: result ?? null });
      }
      if (p === "/api/companies") return json(res, 200, await changeCompanies(await readBody(req)));
      if (p === "/api/alerts/ack") {
        const body = await readBody(req);
        const a = alerts[String(body.id ?? "")];
        if (a) { a.ackLevel = a.level; await writeJson("alerts.json", alerts); }
        return json(res, 200, { alerts: alertView() });
      }
      if (p.startsWith("/api/helper/") && controls.handles(p)) return json(res, 200, await controls.act(p, await readBody(req), res));
      if (p === "/api/helper/brief") {
        const body = await readBody(req);
        return json(res, 200, await helper.brief(String(body.interaction ?? "")));
      }
      if (p === "/api/helper/ask") {
        const body = await readBody(req);
        return json(res, 200, await helper.ask(String(body.interaction ?? ""), body.text));
      }
      if (p === "/api/eta") {
        const issue = url.searchParams.get("issue");
        const company = url.searchParams.get("company");
        let targets = [];
        if (issue) targets = [issue];
        else if (company) targets = (board.companies.find((c) => c.prefix === company)?.issues ?? []).filter((i) => OPEN.has(i.status)).map((i) => i.identifier);
        if (!targets.length) return json(res, 400, { error: "nothing to estimate" });
        if (issue && !findIssue(issue)) return json(res, 400, { error: `Unknown issue ${issue}` });
        queueEstimates(targets);
        return json(res, 202, { started: targets });
      }
      return send(res, 404, "text/plain", "not found");
    }
    send(res, 405, "text/plain", "method not allowed");
  } catch (error) {
    json(res, error?.status && error.status < 500 ? error.status : 502, { error: String(error?.message ?? error) });
  }
});
// Port taken: wait for it after a restart (the old process is on its way out); otherwise say so and
// stop cleanly, so a login item doesn't keep retrying.
let listenTries = 0;
server.on("error", (e) => {
  if (e.code === "EADDRINUSE" && process.env.ORBIT_WAIT_PORT && listenTries++ < 40) return setTimeout(() => server.listen(PORT, config.host), 250);
  if (e.code === "EADDRINUSE") { console.error(`Port ${PORT} is already in use; Orbit is not starting a second copy.`); process.exit(0); }
  throw e;
});
server.listen(PORT, config.host, async () => {
  console.log(`Orbit ${VERSION} (Paperclip ${PAPERCLIP})`);
  console.log(`  On this computer: http://127.0.0.1:${PORT}`);
  const lan = lanAddress();
  if (lan && config.host !== "127.0.0.1") console.log(`  Phone (same Wi-Fi): http://${lan}:${PORT}/?key=${token}`);
  await poll();
  schedule();
});
