// POST /api/clipboard/send: things from Orbit's clipboard go to an agent, as a new task or as a
// comment on the agent's current task. Reached only through server.mjs's access rules (this computer's
// own page, or the connected Orbit website with its token; other websites are refused).
//
// multipart/form-data fields:
//   companyId   (required)  the project
//   agentId     (optional)  default: the project's point of contact
//   mode        "task" (default) | "comment"   comment = on the agent's current task
//   message     one line from the person (required for a new task)
//   link        repeated: URLs, listed in the body
//   text        repeated: short text snippets (≤ 8000 chars each), quoted in the body
//   file        repeated, at most 10: uploaded as attachments of the issue
//   meta        optional JSON [{name, kind, tags, sourceUrl}] describing the files (shown in the body)
//   dryRun      "true": validate and describe, create nothing, wake no one
//
// Files are held in memory (never written to disk) and sent on to Paperclip one by one.
import { Readable } from "node:stream";

// Mirrors Paperclip's MAX_ATTACHMENT_BYTES (server/dist/attachment-types.js): one ceiling per file.
export const MAX_FILE_BYTES = Number(process.env.PAPERCLIP_ATTACHMENT_MAX_BYTES) || 10 * 1024 * 1024;
export const MAX_FILES = 10;
const MAX_TEXT = 8000, MAX_TEXTS = 20, MAX_LINKS = 30;
const MAX_BODY = MAX_FILES * MAX_FILE_BYTES + 2 * 1024 * 1024;

// What may be sent: images, pdf, text and code, zip. SVG is refused (it can carry script).
const CODE_EXT = new Set(["js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php", "sh", "bash", "zsh", "ps1", "sql", "css", "scss", "html", "htm", "xml", "yaml", "yml", "toml", "ini", "json", "md", "markdown", "txt", "csv", "log", "diff", "patch", "vue", "svelte", "lua", "r", "dart", "scala", "ex", "exs", "erl", "hs", "ml", "clj", "gradle", "env.example"]);
const IMAGE = new Map([["png", "image/png"], ["jpg", "image/jpeg"], ["jpeg", "image/jpeg"], ["gif", "image/gif"], ["webp", "image/webp"], ["heic", "image/heic"], ["heif", "image/heif"]]);
const TEXTY = /^(text\/(plain|markdown|csv|html|css|javascript|x-[\w.+-]+|xml|yaml)|application\/(json|javascript|x-javascript|typescript|xml|x-yaml|yaml|x-sh|x-python|sql|toml|x-httpd-php))$/;
function classify(name, type) {
  const t = String(type || "").split(";")[0].trim().toLowerCase();
  const ext = (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? "").toLowerCase();
  if (t === "image/svg+xml" || ext === "svg") return null;
  if (/^image\/(png|jpeg|gif|webp|heic|heif)$/.test(t)) return t;
  if (t.startsWith("image/")) return null; // bmp, tiff, icons…: not shown by Paperclip
  if ((!t || t === "application/octet-stream") && IMAGE.has(ext)) return IMAGE.get(ext);
  if (t === "application/pdf" || (!t || t === "application/octet-stream") && ext === "pdf") return "application/pdf";
  if (/^application\/(zip|x-zip-compressed)$/.test(t) || (!t || t === "application/octet-stream") && ext === "zip") return "application/zip";
  if (t === "text/markdown" || ext === "md" || ext === "markdown") return "text/markdown";
  if (t === "text/csv" || ext === "csv") return "text/csv";
  if (t === "application/json" || ext === "json") return "application/json";
  if (t === "text/html" || ext === "html" || ext === "htm") return "text/html";
  // Code and other text go to Paperclip as plain text, so it shows inline there.
  if (TEXTY.test(t) || ((!t || t === "application/octet-stream") && CODE_EXT.has(ext))) return "text/plain";
  return null;
}
// A safe file name: no folders, no control or reserved characters, a sensible length.
export function cleanName(raw, i = 0) {
  let n = String(raw ?? "").split(/[\\/]/).pop().normalize("NFC").replace(/[\u0000-\u001f\u007f"*:<>?|]/g, "_").replace(/^[.\s]+/, "").trim();
  if (n.length > 120) { const ext = /\.[A-Za-z0-9]{1,8}$/.exec(n)?.[0] ?? ""; n = n.slice(0, 120 - ext.length) + ext; }
  return n || `clip-${i + 1}`;
}
const httpUrl = (s) => { try { const u = new URL(String(s).trim()); return /^https?:$/.test(u.protocol) ? u.href : null; } catch { return null; } };
const bad = (status, message) => Object.assign(new Error(message), { status });
const mb = (n) => `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;

// Read the request as FormData, refusing anything larger than the limit while it streams in.
async function readForm(req) {
  const type = String(req.headers["content-type"] ?? "");
  if (!/^multipart\/form-data;\s*boundary=/i.test(type)) throw bad(415, "Send this as multipart/form-data.");
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > MAX_BODY) throw bad(413, `Too much at once (limit ${MAX_FILES} files of ${mb(MAX_FILE_BYTES)} each).`);
  let seen = 0;
  const limited = Readable.toWeb(req).pipeThrough(new TransformStream({
    transform(chunk, ctl) { seen += chunk.byteLength; if (seen > MAX_BODY) ctl.error(bad(413, `Too much at once (limit ${MAX_FILES} files of ${mb(MAX_FILE_BYTES)} each).`)); else ctl.enqueue(chunk); },
  }));
  try { return await new Request("http://orbit.local/", { method: "POST", headers: { "content-type": type }, body: limited, duplex: "half" }).formData(); }
  catch (e) { if (e?.status) throw e; if (seen > MAX_BODY) throw bad(413, "Too much at once."); throw bad(400, "Couldn't read the upload."); }
}

export function createClipboardSend({ companies, board, api, baseOf, projectAgents, pickPoc, addLog, webBase, afterSend }) {
  // The agent's current task: in progress first, then blocked / in review / to do, newest first.
  function currentIssue(cfg, agentId) {
    const c = board().companies.find((x) => x.id === cfg.id);
    const order = { in_progress: 0, blocked: 1, in_review: 2, todo: 3 };
    return (c?.issues ?? []).filter((i) => i.assigneeAgentId === agentId && i.status in order)
      .sort((a, b) => order[a.status] - order[b.status] || String(b.updatedAt).localeCompare(String(a.updatedAt)))[0] ?? null;
  }
  const issueUrl = (cfg, identifier) => (identifier ? `${webBase(cfg)}/${encodeURIComponent(cfg.prefix)}/issues/${encodeURIComponent(identifier)}` : null);

  return async function send(req) {
    const form = await readForm(req);
    const field = (k) => String(form.get(k) ?? "").trim();
    const dryRun = field("dryRun") === "true" || field("dryRun") === "1";
    const cfg = companies.find((c) => c.id === field("companyId"));
    if (!cfg) throw bad(404, "Pick a project first.");
    const mode = field("mode") || "task";
    if (!["task", "comment"].includes(mode)) throw bad(400, 'mode must be "task" or "comment".');
    const message = field("message").replace(/\s+/g, " ").slice(0, 500);

    // Files: count, size, type, names.
    const files = form.getAll("file").filter((f) => typeof f === "object" && f);
    if (files.length > MAX_FILES) throw bad(413, `At most ${MAX_FILES} files at once.`);
    let meta = []; try { meta = JSON.parse(field("meta") || "[]"); if (!Array.isArray(meta)) meta = []; } catch { meta = []; }
    const used = new Set();
    const out = files.map((f, i) => {
      if (f.size <= 0) throw bad(422, `${cleanName(f.name, i)} is empty.`);
      if (f.size > MAX_FILE_BYTES) throw bad(413, `${cleanName(f.name, i)} is larger than Paperclip's ${mb(MAX_FILE_BYTES)} limit.`);
      let name = cleanName(f.name, i);
      const type = classify(name, f.type);
      if (!type) throw bad(415, `${name} can't be sent: only images, PDFs, text, code and zip files.`);
      if (used.has(name.toLowerCase())) { const dot = name.lastIndexOf("."), stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : ""; let k = 2; while (used.has(`${stem}-${k}${ext}`.toLowerCase())) k++; name = `${stem}-${k}${ext}`; }
      used.add(name.toLowerCase());
      const m = meta[i] && typeof meta[i] === "object" ? meta[i] : {};
      return { file: f, name, type, size: f.size, kind: String(m.kind ?? "").slice(0, 20), tags: (Array.isArray(m.tags) ? m.tags : []).map((t) => String(t).slice(0, 40)).slice(0, 8), sourceUrl: httpUrl(m.sourceUrl) };
    });
    const links = form.getAll("link").map(httpUrl).filter(Boolean).slice(0, MAX_LINKS);
    const texts = form.getAll("text").map((t) => String(t).replace(/\r\n?/g, "\n").trim()).filter(Boolean);
    if (texts.length > MAX_TEXTS) throw bad(413, `At most ${MAX_TEXTS} text snippets at once.`);
    if (texts.some((t) => t.length > MAX_TEXT)) throw bad(413, `A text snippet is over ${MAX_TEXT} characters; send it as a file.`);
    if (!out.length && !links.length && !texts.length && !message) throw bad(400, "Nothing to send.");
    if (mode === "task" && !message) throw bad(400, "Write a one-line message for the new task.");

    // Who and where.
    const agents = await projectAgents(cfg);
    const agent = field("agentId") ? agents.find((a) => a.id === field("agentId")) : pickPoc(cfg, agents);
    if (!agent) throw bad(field("agentId") ? 404 : 400, field("agentId") ? "That agent isn't in this project." : "This project has no agents.");
    const current = mode === "comment" ? currentIssue(cfg, agent.id) : null;
    if (mode === "comment" && !current) throw bad(409, `${agent.name} has no current task. Send it as a new task instead.`);

    // The text that goes with it.
    const lines = [];
    if (message) lines.push(message, "");
    if (links.length) lines.push("Links:", ...links.map((l) => `- ${l}`), "");
    for (const t of texts) lines.push(t.split("\n").map((l) => `> ${l}`).join("\n"), "");
    if (out.length) lines.push("Attached:", ...out.map((o) => `- ${o.name}${o.sourceUrl ? ` (from ${o.sourceUrl})` : ""}${o.tags.length ? ` · ${o.tags.join(", ")}` : ""}`), "");
    lines.push("_Sent from Orbit's clipboard._");
    const body = lines.join("\n").trim();
    const title = "From the clipboard: " + ((message || links[0] || out[0]?.name || texts[0] || "").split("\n")[0].slice(0, 70) + ((message || "").length > 70 ? "…" : ""));
    const summary = { to: agent.name, agentId: agent.id, mode, files: out.map((o) => ({ name: o.name, type: o.type, size: o.size })), links, texts: texts.length };
    if (dryRun) return { dryRun: true, ...summary, issue: current?.identifier ?? null, url: issueUrl(cfg, current?.identifier), title: mode === "task" ? title : null, body };

    // Create the task (or use the current one), then the comment, then the files, then wake the agent.
    const base = baseOf(cfg);
    let issue = current ? { id: current.id, identifier: current.identifier } : null;
    if (!issue) {
      const existing = await api(`/companies/${cfg.id}/issues`, { base }).catch(() => []);
      const counts = new Map(); for (const i of (Array.isArray(existing) ? existing : existing?.issues ?? [])) if (i.projectId) counts.set(i.projectId, (counts.get(i.projectId) ?? 0) + 1);
      const projectId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      issue = await api(`/companies/${cfg.id}/issues`, { base, method: "POST", body: JSON.stringify({ title, description: body, status: "todo", priority: "medium", assigneeAgentId: agent.id, ...(projectId ? { projectId } : {}) }) });
    } else await api(`/issues/${issue.id}/comments`, { base, method: "POST", body: JSON.stringify({ body }) });
    const uploaded = [], failed = [];
    for (const o of out) {
      const fd = new FormData();
      fd.append("file", new Blob([await o.file.arrayBuffer()], { type: o.type }), o.name);
      try {
        const r = await fetch(`${base}/companies/${cfg.id}/issues/${issue.id}/attachments`, { method: "POST", body: fd, signal: AbortSignal.timeout(60000) });
        if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 160)}`);
        uploaded.push(o.name);
      } catch (e) { failed.push(`${o.name}: ${e.message}`); }
    }
    try { await api(`/agents/${agent.id}/wakeup`, { base, method: "POST", body: "{}" }); } catch { /* it wakes on its own schedule */ }
    await addLog([{ ts: new Date().toISOString(), company: cfg.prefix, issue: issue.identifier ?? null, text: `clipboard → ${agent.name}${issue.identifier ? ` · ${issue.identifier}` : ""} (${uploaded.length} file${uploaded.length === 1 ? "" : "s"}${links.length ? `, ${links.length} link${links.length === 1 ? "" : "s"}` : ""})` }]);
    afterSend?.();
    return { ok: failed.length === 0, ...summary, issue: issue.identifier ?? null, url: issueUrl(cfg, issue.identifier), uploaded, failed };
  };
}
