// Live agent chat: tails Paperclip run logs and issue comments and turns them into chat messages.
// Read-only against Paperclip. Messages are kept in memory only.
//
// Run logs: GET /heartbeat-runs/:runId/log?offset=<bytes>&limitBytes=<n> returns
// {content, nextOffset}; nextOffset is missing once the read reached the end of the file.
// content is NDJSON {ts, stream, chunk, seq}; stdout chunks carry "acpx.*" JSON lines
// (text_delta, tool_call, result, status), which may be split across chunks.

const PER_RUN = 200;
const KEEP_FINISHED = 5;
const OUTPUT_CAP = 8000;
const COMMENTS_PER_ISSUE = 30;

export function createChat({ api, list, companies, emit, noteRun }) {
  const runs = new Map(); // runId → run state
  const messages = new Map(); // msgId → message
  const commentSeen = new Set();
  let agents = []; // [{id, name, company, live, runId, issueId}]
  let issueIndex = new Map(); // issueId → {identifier, title, company, status, assigneeAgentId}
  let agentNames = new Map();

  function upsert(msg) {
    messages.set(msg.id, msg);
    emit({ type: "msg", msg });
  }

  function runMeta(run) {
    const issue = issueIndex.get(run.issueId);
    return { runId: run.id, agentId: run.agentId, agentName: run.agentName, company: run.company, issueId: run.issueId ?? null, issue: issue?.identifier ?? null };
  }

  function addToRun(run, msg) {
    run.msgIds.push(msg.id);
    if (run.msgIds.length > PER_RUN) messages.delete(run.msgIds.shift());
    upsert(msg);
  }

  function handleLine(run, ts, line) {
    let j;
    try { j = JSON.parse(line); } catch {
      if (line.startsWith("[paperclip]")) addToRun(run, { id: `${run.id}:s${run.seq++}`, ts, role: "system", text: line.replace(/^\[paperclip\]\s*/, "").slice(0, 600), ...runMeta(run) });
      return;
    }
    if (j.type === "acpx.text_delta" && j.tag === "agent_message_chunk") {
      if (!run.text) {
        run.text = { id: `${run.id}:t${run.seq++}`, ts, role: "agent", text: "", ...runMeta(run) };
        run.msgIds.push(run.text.id);
      }
      run.text.text += j.text ?? "";
      run.text.updatedTs = ts;
      run.dirty.add(run.text);
      return;
    }
    if (j.type === "acpx.text_delta") return; // thoughts are left out
    if (j.type === "acpx.tool_call") {
      run.text = null;
      let tool = run.tools.get(j.toolCallId);
      if (!tool) {
        tool = { id: `${run.id}:${j.toolCallId}`, ts, role: "tool", toolName: j.name, input: "", output: "", status: j.status ?? "pending", ...runMeta(run) };
        run.tools.set(j.toolCallId, tool);
        run.msgIds.push(tool.id);
      }
      if (j.name && j.name !== tool.toolName && j.name !== "tool call") tool.input = String(j.name).slice(0, 2000);
      if (j.status) tool.status = j.status;
      const done = /^tool call \((completed|failed)\): ?/.exec(j.text ?? "");
      if (done) tool.output = j.text.slice(done[0].length).replace(/^```\w*\n?|```$/g, "").slice(0, OUTPUT_CAP);
      run.dirty.add(tool);
      return;
    }
    if (j.type === "acpx.result") {
      run.text = null;
      addToRun(run, { id: `${run.id}:result`, ts, role: "result", text: `Run ${j.summary ?? "finished"}${j.stopReason && j.stopReason !== "end_turn" ? ` (${j.stopReason})` : ""}`, ...runMeta(run) });
    }
  }

  async function tail(run) {
    if (run.reading) return;
    run.reading = true;
    try {
      for (let guard = 0; guard < 20; guard++) {
        const body = await api(`/heartbeat-runs/${run.id}/log?offset=${run.offset}&limitBytes=512000`, { timeoutMs: 15000 });
        const content = body?.content ?? "";
        run.offset = body?.nextOffset ?? run.offset + Buffer.byteLength(content);
        run.ndjson += content;
        const lines = run.ndjson.split("\n");
        run.ndjson = lines.pop();
        for (const l of lines) {
          if (!l) continue;
          let e; try { e = JSON.parse(l); } catch { continue; }
          if (e.stream !== "stdout") continue;
          run.stdout += e.chunk ?? "";
          const parts = run.stdout.split("\n");
          run.stdout = parts.pop();
          for (const p of parts) if (p.trim()) handleLine(run, e.ts, p);
        }
        if (body?.nextOffset == null) break;
      }
      // Trim the per-run message list and emit the messages that grew.
      while (run.msgIds.length > PER_RUN) messages.delete(run.msgIds.shift());
      for (const m of run.dirty) if (run.msgIds.includes(m.id)) upsert({ ...m, text: m.text?.slice(-6000) });
      run.dirty.clear();
    } catch { /* try again next tick */ } finally {
      run.reading = false;
    }
  }

  function track(r, company, finished = false) {
    noteRun?.(r.id, r.companyId);
    let run = runs.get(r.id);
    const issueId = r.issueId ?? r.contextSnapshot?.issueId ?? null;
    if (!run) {
      run = { id: r.id, agentId: r.agentId, agentName: r.agentName ?? agentNames.get(r.agentId) ?? "Agent", company, issueId, offset: 0, ndjson: "", stdout: "", msgIds: [], tools: new Map(), dirty: new Set(), text: null, seq: 0 };
      runs.set(r.id, run);
    }
    run.status = r.status;
    run.startedAt = r.startedAt ?? run.startedAt;
    run.finished = finished;
    return run;
  }

  function dropOldRuns() {
    const finished = [...runs.values()].filter((r) => r.finished).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    for (const r of finished.slice(KEEP_FINISHED)) {
      for (const id of r.msgIds) messages.delete(id);
      runs.delete(r.id);
    }
  }

  // Called by the board poll with fresh issues, agents and comments.
  function updateBoard(board, issueComments, agentList) {
    issueIndex = new Map();
    agentNames = new Map(agentList.map((a) => [a.id, a.name]));
    for (const c of board.companies) for (const i of c.issues) issueIndex.set(i.id, { identifier: i.identifier, title: i.title, company: c.prefix, status: i.status, assigneeAgentId: i.assigneeAgentId });
    for (const [issueId, comments] of issueComments) {
      const issue = issueIndex.get(issueId);
      for (const c of comments.slice(0, COMMENTS_PER_ISSUE)) {
        if (c.deletedAt || commentSeen.has(c.id)) continue;
        commentSeen.add(c.id);
        upsert({
          id: `c:${c.id}`, ts: c.createdAt, role: "comment", fromUser: Boolean(c.authorUserId),
          agentId: c.authorAgentId ?? issue?.assigneeAgentId ?? null,
          agentName: c.authorUserId ? "You" : agentNames.get(c.authorAgentId) ?? "Agent",
          company: issue?.company ?? null, issueId, issue: issue?.identifier ?? null,
          text: String(c.body ?? "").slice(0, 6000),
        });
      }
    }
    agents = agentList.map((a) => ({ ...a, ...agentState(a.id) }));
    emit({ type: "agents", agents });
  }

  function agentState(agentId) {
    const mine = [...runs.values()].filter((r) => r.agentId === agentId).sort((a, b) => String(b.startedAt ?? "9").localeCompare(String(a.startedAt ?? "9")));
    const live = mine.find((r) => !r.finished && r.status === "running");
    const queued = mine.find((r) => !r.finished && r.status === "queued");
    const current = live ?? queued ?? mine[0];
    const openIssues = [...issueIndex.entries()].filter(([, i]) => i.assigneeAgentId === agentId && ["in_progress", "blocked", "in_review", "todo"].includes(i.status)).map(([id, i]) => ({ id, identifier: i.identifier, title: i.title, status: i.status }));
    const issueId = current?.issueId ?? openIssues[0]?.id ?? null;
    return {
      live: Boolean(live), queued: Boolean(queued) && !live,
      runId: current?.id ?? null, issueId, issue: issueIndex.get(issueId)?.identifier ?? null,
      issueTitle: issueIndex.get(issueId)?.title ?? null, openIssues,
    };
  }

  // Poll live runs and tail their logs; finished runs get one last read.
  async function tick() {
    await Promise.all(companies.map(async (c) => {
      const live = list(await api(`/companies/${c.id}/live-runs`).catch(() => []), "runs");
      const liveIds = new Set(live.map((r) => r.id));
      for (const r of live) track(r, c.prefix);
      for (const run of runs.values()) {
        if (run.company === c.prefix && !run.finished && !liveIds.has(run.id)) { run.finished = true; run.status = "finished"; await tail(run); }
      }
    }));
    await Promise.all([...runs.values()].filter((r) => !r.finished && r.status === "running").map(tail));
    dropOldRuns();
    agents = agents.map((a) => ({ ...a, ...agentState(a.id) }));
    emit({ type: "agents", agents });
  }

  async function start() {
    // Load the most recent finished runs so the chat is not empty at startup.
    const recent = [];
    await Promise.all(companies.map(async (c) => {
      const rs = list(await api(`/companies/${c.id}/heartbeat-runs?limit=6`), "runs");
      for (const r of rs) if (r.finishedAt) recent.push({ r, c });
    }));
    recent.sort((a, b) => String(b.r.startedAt).localeCompare(String(a.r.startedAt)));
    for (const { r, c } of recent.slice(0, KEEP_FINISHED)) {
      const name = r.agentName ?? null;
      const run = track({ ...r, agentName: name }, c.prefix, true);
      await tail(run);
    }
    await tick();
  }

  function snapshot() {
    const all = [...messages.values()].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    return { agents, messages: all.slice(-600) };
  }

  return { start, tick, updateBoard, snapshot };
}
