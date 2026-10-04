// Question helper: gathers a read-only context pack for a pending question and asks the local
// model for a briefing and follow-up answers. Never posts anything to Paperclip.
import { execFile } from "node:child_process";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const CTX_TOKENS = 8192;
const PACK_TOKENS = 6000;
const tok = (s) => Math.ceil(String(s).length / 3.6);
const SECRETISH = /(^|[/\\])(\.env[^/\\]*|.*secret.*|.*credential.*|.*token.*|id_rsa.*|.*\.pem|.*\.key|\.npmrc|\.netrc)$/i;

// Repos the helper may read (read-only) per company prefix, from config.json "repos":
//   { "ABC": ["/path/to/repo", "/path/to/repo/.claude/worktrees/abc-*"] }
// A trailing "name-*" segment expands to the matching folders. No repos: the helper still works,
// just without commits and HANDOFF notes.
let repoConfig = () => ({});
async function reposFor(prefix) {
  const roots = [];
  for (const entry of repoConfig()?.[prefix] ?? []) {
    const m = /^(.*)[/\\]([^/\\]*)\*$/.exec(String(entry));
    if (!m) { roots.push(String(entry)); continue; }
    try { for (const d of await readdir(m[1])) if (d.startsWith(m[2])) roots.push(join(m[1], d)); } catch { /* none */ }
  }
  return roots;
}
const ISSUE_ID = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/g;

async function git(repo, args) {
  const { stdout } = await run("git", ["-C", repo, ...args], { timeout: 6000, maxBuffer: 1 << 20 });
  return stdout;
}

export function createHelper({ api, list, board, ollamaJson, repos }) {
  if (repos) repoConfig = repos;
  const packs = new Map(); // interactionId → pack

  function findQuestion(interactionId) {
    for (const c of board().companies) for (const i of c.issues) for (const q of i.questions) if (q.id === interactionId) return { company: c, issue: i, q };
    return null;
  }
  function issueByIdentifier(id) {
    for (const c of board().companies) for (const i of c.issues) if (i.identifier === id) return i;
    return null;
  }

  function questionText(q) {
    const p = q.payload ?? {};
    const lines = [q.title ? `Title: ${q.title}` : ""];
    if (q.kind === "ask_user_questions") {
      for (const qq of p.questions ?? []) {
        lines.push(`Question: ${qq.prompt}${qq.helpText ? ` (${qq.helpText})` : ""}`);
        for (const o of qq.options) lines.push(`  Option: ${o.label}${o.description ? ` — ${o.description}` : ""}${o.recommended ? " (marked recommended)" : ""}`);
      }
    } else {
      lines.push(`Confirmation asked: ${p.prompt ?? ""}`, `  Option: ${p.acceptLabel ?? "Accept"}`, `  Option: ${p.rejectLabel ?? "Reject"}${p.rejectRequiresReason ? " (needs a reason)" : ""}`);
      if (p.detailsMarkdown) lines.push("Details:", String(p.detailsMarkdown).slice(0, 4000));
    }
    return lines.filter(Boolean).join("\n");
  }

  async function commitItem(repos, hash) {
    for (const r of repos) {
      try { return { label: `commit ${hash.slice(0, 10)}`, text: (await git(r, ["show", "--stat", "--format=%h %s%n%an, %ad", hash])).split("\n").slice(0, 40).join("\n") }; } catch { /* not in this repo */ }
    }
    return null;
  }

  async function handoffItem(repos, identifier) {
    for (const r of repos) {
      let files = [];
      try { files = (await readdir(r)).filter((f) => /^HANDOFF.*\.md$/i.test(f)); } catch { continue; }
      for (const f of files) {
        const text = await readFile(join(r, f), "utf8").catch(() => "");
        const lines = text.split("\n");
        const at = lines.findIndex((l) => l.includes(identifier));
        if (at < 0) continue;
        let start = at; while (start > 0 && !/^#{1,4}\s/.test(lines[start])) start--;
        const level = (/^(#+)/.exec(lines[start]) ?? ["", "#"])[1].length;
        let end = at + 1; while (end < lines.length && !(new RegExp(`^#{1,${level}}\\s`).test(lines[end]))) end++;
        return { label: `${f} (${identifier} section)`, text: lines.slice(start, Math.min(end, start + 80)).join("\n") };
      }
    }
    return null;
  }

  async function fileItem(repos, relPath) {
    if (SECRETISH.test(relPath)) return null;
    for (const r of repos) {
      try {
        const rootReal = await realpath(r);
        const full = await realpath(resolve(r, relPath.replace(/^\/+/, "")));
        if (!full.startsWith(rootReal + sep)) continue; // stay inside the mapped repo
        if (SECRETISH.test(full) || full.includes(`${sep}.git${sep}`)) continue;
        if (!(await stat(full)).isFile()) continue;
        const text = await readFile(full, "utf8");
        const lines = text.split("\n");
        return { label: `file ${relPath} (${Math.min(150, lines.length)} of ${lines.length} lines)`, text: lines.slice(0, 150).join("\n").slice(0, 9000) };
      } catch { /* try the next repo */ }
    }
    return null;
  }

  async function relatedItem(full) {
    const rel = [];
    const add = (tag, i) => { if (i?.identifier && !rel.some((r) => r.includes(i.identifier))) rel.push(`${tag}: ${i.identifier} "${i.title}" (${i.status})`); };
    for (const a of full.ancestors ?? []) add("parent", a);
    for (const b of full.blockedBy ?? []) add("blocked by", b.issue ?? b);
    for (const b of full.blocks ?? []) add("blocks", b.issue ?? b);
    for (const w of full.relatedWork?.inbound ?? []) add("mentioned by", w.issue);
    for (const w of full.relatedWork?.outbound ?? []) add("mentions", w.issue);
    return rel;
  }

  function packTokens(pack) { return pack.items.reduce((a, it) => a + tok(it.label) + tok(it.text), 0); }

  async function buildPack(interactionId) {
    const found = findQuestion(interactionId);
    if (!found) throw Object.assign(new Error("That question is no longer pending"), { status: 404 });
    const { company, issue, q } = found;
    const repos = await reposFor(company.prefix);
    const full = await api(`/issues/${issue.id}`);
    const comments = list(await api(`/issues/${issue.id}/comments`), "comments").filter((c) => !c.deletedAt).slice(0, 8).reverse();
    const items = [
      { label: "the question", text: questionText(q), core: true },
      { label: `${issue.identifier} description`, text: `${issue.identifier}: ${full.title} (status ${full.status}, priority ${full.priority})\n${String(full.description ?? "(no description)").slice(0, 3000)}`, core: true },
      { label: `last ${comments.length} comments`, text: comments.map((c) => `--- ${c.createdAt} by ${c.authorUserId ? "owner" : "agent"}\n${String(c.body ?? "").slice(0, 900)}`).join("\n") },
    ];
    const allText = items.map((i) => i.text).join("\n");
    const related = await relatedItem(full);
    const ids = new Set([...(full.referencedIssueIdentifiers ?? []), ...(allText.match(ISSUE_ID) ?? [])]);
    ids.delete(issue.identifier);
    for (const id of ids) { const i = issueByIdentifier(id); if (i && !related.some((r) => r.includes(id))) related.push(`mentioned: ${id} "${i.title}" (${i.status})`); }
    if (related.length) items.push({ label: "related issues", text: related.join("\n") });
    const hashes = [...new Set(allText.match(/\b[0-9a-f]{7,40}\b/g) ?? [])].filter((h) => /[a-f]/.test(h) && /\d/.test(h)).slice(0, 6);
    for (const h of hashes) { const it = await commitItem(repos, h); if (it) items.push(it); }
    const ho = await handoffItem(repos, issue.identifier);
    if (ho) items.push(ho);
    const pack = { interactionId, issueId: issue.id, identifier: issue.identifier, company: company.prefix, repos, items, added: [], history: [], brief: null, briefModel: null };
    // Keep within the budget: shorten the comments first, then drop the least central items.
    while (packTokens(pack) > PACK_TOKENS) {
      const c = items.find((i) => i.label.startsWith("last ") && i.text.length > 1200);
      if (c) { c.text = c.text.slice(c.text.length - Math.floor(c.text.length * 0.7)); continue; }
      const k = items.findLastIndex((i) => !i.core);
      if (k < 0) break;
      items.splice(k, 1);
    }
    packs.set(interactionId, pack);
    return pack;
  }

  function packPrompt(pack) {
    return pack.items.map((it) => `### ${it.label}\n${it.text}`).join("\n\n");
  }

  function view(pack) {
    const used = packTokens(pack) + pack.history.reduce((a, h) => a + tok(h.q) + tok(h.a), 0) + 400;
    return {
      interactionId: pack.interactionId, identifier: pack.identifier,
      items: pack.items.map((i) => i.label), added: pack.added,
      tokens: used, ctx: CTX_TOKENS,
      brief: pack.brief, model: pack.briefModel, history: pack.history.slice(-8),
    };
  }

  async function getPack(interactionId) {
    return packs.get(interactionId) ?? buildPack(interactionId);
  }

  async function brief(interactionId) {
    const pack = await getPack(interactionId);
    if (pack.brief) return view(pack);
    const schema = {
      type: "object",
      properties: {
        summary: { type: "string" },
        options: { type: "array", items: { type: "object", properties: { option: { type: "string" }, upside: { type: "string" }, risk: { type: "string" } }, required: ["option", "upside", "risk"] } },
        recommend: { type: "object", properties: { option: { type: "string" }, reason: { type: "string" } }, required: ["option", "reason"] },
        check: { type: "array", items: { type: "string" } },
      },
      required: ["summary", "options", "recommend", "check"],
    };
    const { out, model } = await ollamaJson([
      { role: "system", content: "You help a busy project owner answer a question from an AI coding agent. Use only the information given. Be plain and brief. Never make up commits, numbers or facts that are not in the information." },
      { role: "user", content: `${packPrompt(pack)}\n\nWrite: summary (2-3 sentences: what is being asked and why), options (each option with its upside and risk), recommend (one option and a one-line reason), check (things the owner may want to verify before answering). /no_think` },
    ], schema, { timeoutMs: 150000 });
    pack.brief = {
      summary: String(out.summary ?? "").slice(0, 900),
      options: (out.options ?? []).slice(0, 8).map((o) => ({ option: String(o.option ?? "").slice(0, 200), upside: String(o.upside ?? "").slice(0, 300), risk: String(o.risk ?? "").slice(0, 300) })),
      recommend: { option: String(out.recommend?.option ?? "").slice(0, 200), reason: String(out.recommend?.reason ?? "").slice(0, 300) },
      check: (out.check ?? []).slice(0, 6).map((c) => String(c).slice(0, 240)),
    };
    pack.briefModel = model;
    return view(pack);
  }

  async function ask(interactionId, text) {
    const question = String(text ?? "").trim().slice(0, 1000);
    if (!question) throw Object.assign(new Error("Empty question"), { status: 400 });
    const pack = await getPack(interactionId);
    // Fetch more (limited): a named file, commit or issue id is added to the pack, read-only.
    const added = [];
    const paths = question.match(/(?:[\w.-]+\/)+[\w.-]+\.[\w]+/g) ?? [];
    for (const p of paths.slice(0, 2)) { const it = await fileItem(pack.repos, p); if (it && !pack.items.some((i) => i.label === it.label)) { pack.items.push(it); added.push(it.label); } }
    for (const h of (question.match(/\b[0-9a-f]{7,40}\b/g) ?? []).slice(0, 2)) { const it = await commitItem(pack.repos, h); if (it && !pack.items.some((i) => i.label === it.label)) { pack.items.push(it); added.push(it.label); } }
    for (const id of (question.match(ISSUE_ID) ?? []).slice(0, 3)) {
      const i = issueByIdentifier(id);
      if (i && !pack.items.some((x) => x.label === `issue ${id}`)) {
        const full = await api(`/issues/${i.id}`).catch(() => null);
        pack.items.push({ label: `issue ${id}`, text: `${id}: ${i.title} (${i.status})\n${String(full?.description ?? "").slice(0, 1500)}${i.lastComment ? `\nLast comment: ${i.lastComment.text}` : ""}` });
        added.push(`issue ${id}`);
      }
    }
    // Stay inside the model's context: drop the oldest added items if needed.
    while (packTokens(pack) > CTX_TOKENS - 1600) {
      const k = pack.items.findIndex((i) => !i.core && !added.includes(i.label));
      if (k < 0) break;
      pack.items.splice(k, 1);
    }
    pack.added.push(...added);
    const turns = pack.history.slice(-4).flatMap((h) => [{ role: "user", content: h.q }, { role: "assistant", content: JSON.stringify({ answer: h.a }) }]);
    const { out } = await ollamaJson([
      { role: "system", content: "Answer briefly from the given information only. If the answer is not in it, say \"That isn't in what I gathered.\" Never make up commits, file contents or numbers.\n\n" + packPrompt(pack) },
      ...turns,
      { role: "user", content: question + " /no_think" },
    ], { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] }, { timeoutMs: 150000 });
    pack.history.push({ q: question, a: String(out.answer ?? "").slice(0, 2000), added });
    return view(pack);
  }

  async function get(interactionId) {
    const pack = packs.get(interactionId);
    return pack ? view(pack) : null;
  }

  return { brief, ask, get };
}
