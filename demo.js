// Demo mode: a self-contained dataset (three fictional companies) and a scripted timeline that
// walks through every event the sky can show. No network calls.

const now = () => new Date().toISOString();
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
const clone = (o) => JSON.parse(JSON.stringify(o));

function makeData() {
  const agents = [
    { id: "a-nav", name: "Nova Dev", company: "ORB" }, { id: "a-nav2", name: "Nova Tester", company: "ORB" },
    { id: "a-hel", name: "Helix Lead", company: "HLX" }, { id: "a-hel2", name: "Helix Builder", company: "HLX" },
    { id: "a-tid", name: "Tide Writer", company: "TDE" }, { id: "a-tid2", name: "Tide Engineer", company: "TDE" },
  ];
  const I = (company, n, title, status, priority, agentId, min, text) => ({
    id: `${company}-${n}`, identifier: `${company}-${n}`, title, status, priority, assigneeAgentId: agentId,
    assignee: agents.find((a) => a.id === agentId)?.name ?? null, updatedAt: ago(min), completedAt: status === "done" ? ago(min) : null,
    lastComment: text ? { text, full: text, at: ago(min), author: agents.find((a) => a.id === agentId)?.name ?? "Agent" } : null, questions: [],
  });
  const companies = [
    { id: "c-orb", name: "Orbital Kitchen", prefix: "ORB", issues: [
      I("ORB", 1, "Recipe parser handles fractions", "in_progress", "high", "a-nav", 12, "Parser now reads 1/2 and ¾; mixed numbers next."),
      I("ORB", 2, "Shopping list groups by aisle", "todo", "medium", "a-nav", 50, null),
      I("ORB", 3, "Timer survives app restarts", "in_review", "medium", "a-nav2", 30, "Ready for review; tests pass."),
      I("ORB", 4, "Dark mode for the cooking view", "done", "low", "a-nav2", 300, "Shipped."),
      I("ORB", 5, "Import recipes from photos", "blocked", "high", "a-nav", 90, "Blocked: needs an OCR model choice."),
    ] },
    { id: "c-hlx", name: "Helix Garden", prefix: "HLX", issues: [
      I("HLX", 1, "Watering schedule from weather data", "in_progress", "high", "a-hel2", 8, "Forecast fetch works; schedule rules next."),
      I("HLX", 2, "Plant photo diagnosis", "todo", "medium", "a-hel", 70, null),
      I("HLX", 3, "Sensor battery alerts", "in_progress", "medium", "a-hel2", 20, "Alerts fire; thresholds being tuned."),
      I("HLX", 4, "Seed catalogue import", "done", "low", "a-hel", 400, "Imported 1,240 seeds."),
      I("HLX", 5, "Garden map editor", "todo", "low", null, 200, null),
    ] },
    { id: "c-tde", name: "Tidewater Notes", prefix: "TDE", issues: [
      I("TDE", 1, "Offline sync conflict merge", "in_progress", "critical", "a-tid2", 5, "Three-way merge in place; edge cases left."),
      I("TDE", 2, "Weekly digest email", "in_review", "medium", "a-tid", 25, "Draft template ready."),
      I("TDE", 3, "Markdown tables in notes", "todo", "medium", "a-tid2", 60, null),
      I("TDE", 4, "Search across attachments", "blocked", "high", "a-tid2", 150, "Blocked: indexing service quota."),
      I("TDE", 5, "Onboarding tour", "done", "low", "a-tid", 500, "Done."),
    ] },
  ];
  const eta = {};
  const pcts = { in_progress: 45, in_review: 88, todo: 3, blocked: 30 };
  for (const c of companies) for (const i of c.issues) if (pcts[i.status] != null) eta[i.identifier] = { pct: pcts[i.status] + (i.identifier.length % 7), eta: i.status === "blocked" ? "blocked" : `~${1 + (i.identifier.charCodeAt(4) % 3)} h`, done: ["Plan written"], left: ["Finish", "Test"], note: "Demo estimate.", model: "demo", at: ago(3) };
  return { companies, agents, eta };
}

export function createDemo(hooks) {
  const { setBoard, setLog, addLog, upsertMsg, setChat, setAgents, emit } = hooks;
  const d = makeData();
  let board = { companies: d.companies, eta: d.eta, etaRunning: [], intervalSec: 15, nextPollInSec: 15, polledAt: now(), error: null, phoneUrl: "./", demo: true };
  let agents = d.agents.map((a) => ({ ...a, live: false, queued: false, runId: null, issueId: null, issue: null, issueTitle: null, openIssues: [] }));
  let seq = 0;
  const log = [];
  const issue = (id) => board.companies.flatMap((c) => c.issues).find((i) => i.identifier === id);
  const companyOf = (id) => board.companies.find((c) => c.issues.some((i) => i.identifier === id))?.prefix ?? null;
  function refreshAgents() {
    agents = agents.map((a) => {
      const open = board.companies.flatMap((c) => c.issues).filter((i) => i.assigneeAgentId === a.id && ["in_progress", "blocked", "in_review", "todo"].includes(i.status));
      const cur = open.find((i) => i.status === "in_progress") ?? open[0];
      return { ...a, issueId: cur?.id ?? null, issue: cur?.identifier ?? null, issueTitle: cur?.title ?? null, openIssues: open.map((i) => ({ id: i.id, identifier: i.identifier, title: i.title, status: i.status })) };
    });
  }
  function push(next) {
    board = { ...next, polledAt: now(), nextPollInSec: board.intervalSec, agents };
    setBoard(clone(board));
  }
  function logLine(text, id) { const e = { ts: now(), company: companyOf(id), issue: id, text }; log.unshift(e); addLog(e); }
  function setStatus(id, status) {
    const b = clone(board); const i = b.companies.flatMap((c) => c.issues).find((x) => x.identifier === id);
    const was = i.status; i.status = status; i.updatedAt = now(); if (status === "done") { i.completedAt = now(); delete b.eta[id]; }
    board = b; refreshAgents(); push(b); logLine(`${id}: ${was.replace("_", " ")} → ${status.replace("_", " ")}`, id);
  }
  function msg(m) { upsertMsg({ id: `demo-${seq++}`, ts: now(), ...m }); }
  function startRun(agentId) {
    const a = agents.find((x) => x.id === agentId);
    agents = agents.map((x) => (x.id === agentId ? { ...x, live: true, runId: `run-${seq++}` } : x));
    setAgents(clone(agents));
    msg({ role: "agent", agentId, agentName: a.name, company: a.company, issueId: a.issueId, issue: a.issue, runId: agents.find((x) => x.id === agentId).runId, text: `Picking up ${a.issue ?? "my next task"}. Reading the latest comments first.` });
    msg({ role: "tool", agentId, agentName: a.name, company: a.company, toolName: "Read", input: "src/main.ts", status: "completed", output: "220 lines", runId: agents.find((x) => x.id === agentId).runId });
  }
  function endRun(agentId, ok = true) {
    const a = agents.find((x) => x.id === agentId);
    msg({ role: "result", agentId, agentName: a.name, company: a.company, runId: a.runId, text: ok ? "Run completed" : "Run failed (tests)" });
    if (!ok) msg({ role: "tool", agentId, agentName: a.name, company: a.company, toolName: "Bash", input: "npm test", status: "failed", output: "FAIL src/sync.test.ts\n2 failed, 41 passed", runId: a.runId });
    agents = agents.map((x) => (x.id === agentId ? { ...x, live: false } : x));
    setAgents(clone(agents));
  }
  function comment(agentId, text) {
    const a = agents.find((x) => x.id === agentId);
    msg({ role: "comment", fromUser: false, agentId, agentName: a.name, company: a.company, issueId: a.issueId, issue: a.issue, text });
  }
  function estimate(id, pct) {
    const b = clone(board); b.eta[id] = { ...(b.eta[id] ?? {}), pct, eta: `~${Math.max(0.5, (100 - pct) / 30).toFixed(1)} h`, done: ["Core logic", "Tests"], left: pct < 90 ? ["Edge cases", "Docs"] : ["Review"], note: "Demo estimate.", model: "demo", at: now() };
    board = b; push(b);
  }
  function addQuestion() {
    const b = clone(board); const i = b.companies[2].issues.find((x) => x.identifier === "TDE-1");
    if (i.questions.length) return;
    i.questions.push({ id: "demo-q1", kind: "ask_user_questions", title: "How should sync conflicts resolve?", createdAt: now(), payload: { questions: [{ id: "q", prompt: "When both devices edit the same note offline, what should win?", selectionMode: "single", options: [{ id: "merge", label: "Merge both", recommended: true }, { id: "latest", label: "Latest edit wins" }, { id: "ask", label: "Ask me each time" }] }] } });
    board = b; push(b); logLine("TDE-1: new question waiting for you", "TDE-1");
  }
  function newIssue() {
    const b = clone(board); const n = 6 + b.companies[0].issues.length;
    if (b.companies[0].issues.length > 9) return;
    b.companies[0].issues.push({ id: `ORB-${n}`, identifier: `ORB-${n}`, title: "Share recipes as cards", status: "todo", priority: "medium", assigneeAgentId: "a-nav2", assignee: "Nova Tester", updatedAt: now(), completedAt: null, lastComment: null, questions: [] });
    board = b; refreshAgents(); push(b); logLine(`ORB-${n}: new issue "Share recipes as cards" (to do)`, `ORB-${n}`);
  }
  function reset() { const f = makeData(); board = { ...board, companies: f.companies, eta: f.eta }; refreshAgents(); push(board); }

  // The script: one beat every ~6 s, then it loops.
  const beats = [
    () => startRun("a-nav"),
    () => comment("a-nav", "Fraction parsing done; commit 3f9c2a1 pushed, tests pass."),
    () => setStatus("ORB-1", "in_review"),
    () => { emit?.("demoOut", { agentId: "a-hel2", company: "HLX", label: "Helix Builder · HLX-1" }); msg({ role: "comment", fromUser: true, agentId: "a-hel2", agentName: "You", company: "HLX", issueId: "HLX-1", issue: "HLX-1", text: "Please use the hourly forecast." }); },
    () => addQuestion(),
    () => setStatus("HLX-3", "blocked"),
    () => estimate("HLX-1", 72),
    () => endRun("a-nav", true),
    () => setStatus("ORB-3", "done"),
    () => newIssue(),
    () => startRun("a-tid2"),
    () => endRun("a-tid2", false),
    () => setStatus("HLX-3", "in_progress"),
    () => estimate("HLX-1", 55),
    () => setStatus("TDE-2", "done"),
    () => { const b = clone(board); b.alerts = [{ id: "demo-red", level: "critical", text: "ORB-5 run failed twice in a row", issueId: "ORB-5", identifier: "ORB-5", company: "ORB", since: now(), acked: false }]; board = b; push(b); logLine("▼▼ CRITICAL · ORB-5 run failed twice in a row", "ORB-5"); },
    () => {},
    () => { const b = clone(board); b.alerts = []; board = b; push(b); },
    () => reset(),
  ];
  let k = 0, timer = null;
  function start() {
    refreshAgents();
    setLog([]);
    setChat({ agents: clone(agents), messages: [] });
    push(board);
    for (const c of board.companies) for (const i of c.issues) if (i.lastComment) msg({ role: "comment", fromUser: false, agentId: i.assigneeAgentId, agentName: i.assignee, company: c.prefix, issueId: i.id, issue: i.identifier, text: i.lastComment.full, ts: i.lastComment.at });
    timer = setInterval(() => { try { beats[k++ % beats.length](); } catch (e) { console.error("[demo]", e); } }, 6000);
  }

  async function act(action, p = {}) {
    if (action === "ack") { board = { ...board, alerts: (board.alerts ?? []).map((a) => (a.id === p.id ? { ...a, acked: true } : a)) }; push(clone(board)); return { ok: true }; }
    if (action === "available") return [{ id: "c-new", name: "Nebula Labs", prefix: "NEB", open: 3, total: 5, tracked: false }];
    if (action === "companies") throw new Error("Connecting projects is not available in the demo");
    if (action === "refresh") { push(clone(board)); return { ok: true }; }
    if (action === "config") { board = { ...board, intervalSec: p.intervalSec }; push(clone(board)); return { intervalSec: p.intervalSec }; }
    if (action === "comment") { const i = board.companies.flatMap((c) => c.issues).find((x) => x.id === p.issueId); msg({ role: "comment", fromUser: true, agentId: i?.assigneeAgentId, agentName: "You", company: companyOf(i?.identifier), issueId: p.issueId, issue: i?.identifier, text: p.text }); return { ok: true }; }
    if (action === "answer") {
      const b = clone(board); const i = b.companies.flatMap((c) => c.issues).find((x) => x.id === p.issueId);
      if (p.action === "comment") return act("comment", { issueId: p.issueId, text: p.text });
      if (i) i.questions = i.questions.filter((q) => q.id !== p.interactionId);
      board = b; push(b); logLine(`${i?.identifier}: question answered`, i?.identifier);
      return { ok: true };
    }
    if (action === "eta") {
      const ids = p.issue ? [p.issue] : board.companies.find((c) => c.prefix === p.company)?.issues.filter((i) => i.status !== "done").map((i) => i.identifier) ?? [];
      board = { ...board, etaRunning: ids }; push(clone(board));
      setTimeout(() => { board = { ...board, etaRunning: [] }; for (const id of ids) estimate(id, Math.min(95, (board.eta[id]?.pct ?? 20) + 12)); }, 1800);
      return { started: ids };
    }
    if (action === "helper" || action === "helperAsk") {
      const history = action === "helperAsk" ? [{ q: p.text, a: "This is demo data, so there is nothing more to look up. In a real board I would answer from the gathered issue context.", added: [] }] : [];
      return { interactionId: p.interaction, identifier: "TDE-1", items: ["the question", "TDE-1 description", "last 3 comments"], added: [], tokens: 1400, ctx: 8192, model: "demo",
        brief: { summary: "The agent needs a rule for offline edits that collide. Merging keeps both changes; latest-wins is simpler but can lose work.", options: [{ option: "Merge both", upside: "No lost edits", risk: "Merged text can need tidying" }, { option: "Latest edit wins", upside: "Simple and predictable", risk: "Silently drops the other edit" }, { option: "Ask me each time", upside: "Full control", risk: "Interrupts you often" }], recommend: { option: "Merge both", reason: "It never loses work." }, check: ["How often conflicts happen in practice"] }, history };
    }
    throw new Error("Not available in the demo");
  }

  return { start, act, stop: () => clearInterval(timer) };
}
