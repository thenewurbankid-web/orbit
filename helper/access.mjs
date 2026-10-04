// Who may use the Orbit service, and the one-time "connect this website" confirm.
//
// Four kinds of caller:
//   local  – a page served by this service on 127.0.0.1 / localhost (same origin). No key needed.
//   key    – any device with the access key from token.txt (phone on the same Wi-Fi).
//   origin – the Orbit website (exact origins in ALLOWED), from this computer only, with a token it got
//            when someone on this computer pressed Allow on the confirm page.
//   none   – everything else, including any other website's form or script (CSRF) and pages reached
//            through a hostname other than 127.0.0.1 / localhost (DNS rebinding).
//
// CORS and Private Network Access headers go only to the exact allowed origins.
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

export const DEFAULT_ORIGINS = ["https://thenewurbankid-web.github.io"];
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const LOOPBACK_ADDR = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const REQUEST_TTL = 3 * 60 * 1000;
const MAX_PENDING = 3;

const sha = (t) => createHash("sha256").update(String(t)).digest("hex");
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
const hostOf = (origin) => { try { return new URL(origin).host; } catch { return origin; } };

export function createAccess({ readJson, writeJson, port, config, keyOk, notify }) {
  let db = { sites: [] }; // [{origin, hash, createdAt, lastUsedAt}]
  const ready = readJson("origins.json", { sites: [] }).then((v) => { db = Array.isArray(v?.sites) ? v : { sites: [] }; });
  const pending = new Map(); // id → {id, origin, code, at, state: pending|allowed|denied, token}

  const allowed = () => new Set([
    ...DEFAULT_ORIGINS,
    ...(Array.isArray(config().allowedOrigins) ? config().allowedOrigins : []),
    ...String(process.env.ORBIT_ALLOWED_ORIGINS ?? "").split(","),
  ].map((s) => String(s).trim().replace(/\/$/, "")).filter(Boolean));

  const isLocal = (req) => LOOPBACK_ADDR.has(req.socket.remoteAddress);

  function siteFor(origin, given) {
    if (!origin || !given) return null;
    const h = sha(given);
    return db.sites.find((s) => s.origin === origin && same(s.hash, h)) ?? null;
  }

  // Classify a request. Never throws.
  function classify(req, url) {
    const origin = req.headers.origin ? String(req.headers.origin) : null;
    const host = String(req.headers.host ?? "");
    const sameOrigin = !origin || origin === `http://${host}`;
    const corsOk = Boolean(origin) && !sameOrigin && allowed().has(origin);
    let access = null;
    if (origin && !sameOrigin && !corsOk) access = null;                  // another website: never
    else if (corsOk) {
      const site = isLocal(req) ? siteFor(origin, req.headers["x-orbit-token"] ?? url.searchParams.get("ot")) : null;
      if (site) { access = "origin"; site.lastUsedAt = new Date().toISOString(); }
    } else if (keyOk(req, url)) access = "key";
    else if (isLocal(req) && LOOPBACK_HOST.test(host)) {
      // Writes also need the browser to say the request came from this same page (or typed by hand).
      const sfs = req.headers["sec-fetch-site"];
      const write = req.method !== "GET" && req.method !== "HEAD";
      if (!write || !sfs || sfs === "same-origin" || sfs === "none") access = "local";
    }
    return { origin, host, sameOrigin, corsOk, access, local: isLocal(req) };
  }

  function cors(res, info) {
    if (!info.corsOk) return;
    res.setHeader("access-control-allow-origin", info.origin);
    res.setHeader("vary", "Origin");
  }

  // OPTIONS preflight: only for the allowed origins, only from this computer.
  function preflight(req, res, info) {
    if (!info.corsOk || !info.local) { res.writeHead(403, { "content-type": "text/plain" }); return res.end("forbidden"); }
    const h = {
      "access-control-allow-origin": info.origin, vary: "Origin",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-orbit-token",
      "access-control-max-age": "600",
    };
    if (String(req.headers["access-control-request-private-network"] ?? "") === "true") h["access-control-allow-private-network"] = "true";
    res.writeHead(204, h); res.end();
  }

  function sweep() { const now = Date.now(); for (const [id, r] of pending) if (now - r.at > REQUEST_TTL) pending.delete(id); }
  async function save() { await writeJson("origins.json", db, { mode: 0o600 }); }

  // Routes for the connect flow. Returns true if it handled the request.
  async function route(req, res, url, info, { json, send, readBody }) {
    const p = url.pathname;
    await ready;
    sweep();
    // The website asks to connect. Shows up on the confirm page and as a Mac notification.
    if (p === "/api/connect/request" && req.method === "POST") {
      if (!info.corsOk || !info.local) return json(res, 403, { error: "forbidden" }), true;
      for (const [id, r] of pending) if (r.origin === info.origin && r.state === "pending") pending.delete(id);
      if (pending.size >= MAX_PENDING) return json(res, 429, { error: "Too many open requests. Try again in a few minutes." }), true;
      const id = randomBytes(12).toString("hex");
      const code = String(1000 + (randomBytes(2).readUInt16BE(0) % 9000));
      pending.set(id, { id, origin: info.origin, code, at: Date.now(), state: "pending", token: null });
      notify?.("Orbit", `${hostOf(info.origin)} wants to connect (code ${code}). Open the Orbit window to allow it.`);
      return json(res, 200, { id, code, confirmUrl: `http://127.0.0.1:${port}/connect` }), true;
    }
    // The website waits for the answer. The token is handed out once, to the origin that asked.
    if (p === "/api/connect/status" && req.method === "GET") {
      const r = pending.get(String(url.searchParams.get("id") ?? ""));
      if (!info.corsOk || !info.local || !r || r.origin !== info.origin) return json(res, 404, { state: "expired" }), true;
      if (r.state === "allowed") { pending.delete(r.id); return json(res, 200, { state: "allowed", token: r.token }), true; }
      if (r.state === "denied") { pending.delete(r.id); return json(res, 200, { state: "denied" }), true; }
      return json(res, 200, { state: "pending" }), true;
    }
    // The website forgets itself (its own token only).
    if (p === "/api/connect/forget" && req.method === "POST") {
      if (info.access !== "origin") return json(res, 401, { error: "not connected" }), true;
      const h = sha(req.headers["x-orbit-token"] ?? "");
      db.sites = db.sites.filter((s) => !(s.origin === info.origin && same(s.hash, h)));
      await save();
      return json(res, 200, { ok: true }), true;
    }
    // Everything below is for a person on this computer, on the page served by this service.
    const mine = info.access === "local";
    if (p === "/connect" && req.method === "GET") {
      if (!mine) return send(res, 403, "text/plain; charset=utf-8", "Open this page on the Mac itself: http://127.0.0.1:" + port + "/connect"), true;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'; default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'", "referrer-policy": "no-referrer" });
      res.end(CONFIRM_PAGE);
      return true;
    }
    if (p === "/api/connect/pending" && req.method === "GET") {
      if (!mine) return json(res, 403, { error: "forbidden" }), true;
      return json(res, 200, {
        pending: [...pending.values()].filter((r) => r.state === "pending").map((r) => ({ id: r.id, site: hostOf(r.origin), origin: r.origin, code: r.code, at: new Date(r.at).toISOString() })),
        sites: db.sites.map((s) => ({ origin: s.origin, site: hostOf(s.origin), createdAt: s.createdAt, lastUsedAt: s.lastUsedAt ?? null })),
      }), true;
    }
    if (p === "/api/connect/decide" && req.method === "POST") {
      // Must be a same-origin fetch from the confirm page: browsers always send Origin on POST.
      if (!mine || !info.origin) return json(res, 403, { error: "forbidden" }), true;
      const b = await readBody(req);
      const r = pending.get(String(b.id ?? ""));
      if (!r || r.state !== "pending") return json(res, 404, { error: "That request has expired. Start again on the Orbit page." }), true;
      if (b.allow === true) {
        const token = randomBytes(24).toString("hex");
        db.sites.push({ origin: r.origin, hash: sha(token), createdAt: new Date().toISOString(), lastUsedAt: null });
        await save();
        Object.assign(r, { state: "allowed", token });
      } else r.state = "denied";
      return json(res, 200, { ok: true, state: r.state }), true;
    }
    if (p === "/api/connect/revoke" && req.method === "POST") {
      if (!mine || !info.origin) return json(res, 403, { error: "forbidden" }), true;
      const b = await readBody(req);
      db.sites = db.sites.filter((s) => s.origin !== String(b.origin ?? ""));
      await save();
      return json(res, 200, { ok: true }), true;
    }
    return false;
  }

  // Forget every connected website (they pair again with a new Allow).
  async function resetSites() { await ready; db.sites = []; pending.clear(); await save(); }
  return { classify, cors, preflight, route, allowed, isLocal, resetSites, sites: () => db.sites.map((s) => s.origin) };
}

// The confirm page, served only to this computer at http://127.0.0.1:<port>/connect. Plain and calm.
const CONFIRM_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark"><title>Orbit · allow a connection</title>
<style>
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #000; color: #dfe9ef; font: 15px/1.6 ui-monospace, Menlo, monospace; }
main { width: min(460px, calc(100% - 32px)); background: rgba(10,12,16,.9); border: 1px solid rgba(255,255,255,.1); border-top-color: rgba(235,242,248,.45); border-radius: 14px; padding: 26px 30px; box-sizing: border-box; }
h1 { font-size: 13px; font-weight: 400; letter-spacing: .14em; color: rgba(160,225,255,.9); margin: 0 0 12px; }
p { margin: 0 0 10px; color: #b8c4cc; } b { color: #eef7fb; font-weight: 500; }
.code { font-size: 26px; letter-spacing: .3em; color: #eef7fb; margin: 6px 0 14px; }
.btns { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 16px; }
button { font: inherit; font-size: 13px; letter-spacing: .1em; color: #dff3fb; background: rgba(120,200,240,.08); border: 1px solid rgba(160,225,255,.45); border-radius: 6px; padding: 9px 18px; cursor: pointer; }
button.dim { border-color: rgba(255,255,255,.15); color: #aab4bc; background: transparent; }
.req + .req { border-top: 1px solid rgba(255,255,255,.08); margin-top: 18px; padding-top: 18px; }
.sites { margin-top: 22px; font-size: 13px; color: #8fa0aa; } .sites ul { margin: 6px 0 0; padding-left: 18px; } .sites li { margin: 4px 0; } .sites button { padding: 2px 8px; font-size: 11px; margin-left: 8px; }
</style></head><body><main id="m"><h1>ORBIT</h1><p>Looking for connection requests…</p></main>
<script>
const m = document.getElementById("m");
let done = null;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
async function post(path, body) { const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return r.json(); }
async function draw() {
  if (done) return;
  let d; try { d = await (await fetch("/api/connect/pending", { cache: "no-store" })).json(); } catch { return; }
  let h = "<h1>ORBIT · ALLOW A CONNECTION</h1>";
  if (!d.pending.length) h += "<p>No website is asking to connect right now. Go back to the Orbit page and press <b>Connect to this computer</b>.</p>";
  for (const r of d.pending) h += '<div class="req"><p>Allow <b>' + esc(r.site) + '</b> to see your Orbit board and answer questions from it?</p><p>It should show the same code:</p><div class="code">' + esc(r.code) + '</div><div class="btns"><button data-id="' + esc(r.id) + '" data-allow="1">ALLOW</button><button class="dim" data-id="' + esc(r.id) + '">DENY</button></div></div>';
  if (d.sites.length) h += '<div class="sites">Connected websites:<ul>' + d.sites.map((s) => '<li>' + esc(s.site) + '<button class="dim" data-revoke="' + esc(s.origin) + '">REMOVE</button></li>').join("") + "</ul></div>";
  m.innerHTML = h;
  m.querySelectorAll("button[data-id]").forEach((b) => b.onclick = async () => {
    const allow = Boolean(b.dataset.allow);
    const r = await post("/api/connect/decide", { id: b.dataset.id, allow });
    done = true;
    m.innerHTML = allow && r.ok ? "<h1>ORBIT</h1><p><b>Allowed.</b> Go back to the Orbit page; it connects by itself.</p><p>You can close this tab.</p>" : "<h1>ORBIT</h1><p>" + (r.ok ? "Denied. Nothing was connected." : esc(r.error || "That did not work.")) + "</p>";
    if (allow && r.ok) setTimeout(() => { try { window.close(); } catch {} }, 2500);
  });
  m.querySelectorAll("button[data-revoke]").forEach((b) => b.onclick = async () => { await post("/api/connect/revoke", { origin: b.dataset.revoke }); draw(); });
}
draw(); setInterval(draw, 1500);
</script></body></html>`;
