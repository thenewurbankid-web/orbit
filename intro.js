// Intro: a door you press to enter. The video plays while we check for projects (Mac: the board API;
// phone: the WebRTC pairing), then the video's window match-cuts onto the frame's opening.
import { frameMetrics } from "./frame.js";

const VW = 848, VH = 478;
const BUTTON = { x: 0.254, y: 0.663 };                 // door button at frame 0 (measured)
const WINDOW = { x: 0.073, y: 0.0, w: 0.859, h: 0.69 }; // window glass around 12-15 s (measured)
const WINDOW_VISIBLE_AT = 9;                            // seconds
const SEEN_KEY = "introSeenAt";

// Cover layout that also crops the "✦" watermark (bottom-right, ~91% x / ~84% y) off screen.
function videoRect(W, H, fx = 0.35, fy = 0.5) {
  // Smallest cover scale where the crop hides the watermark either horizontally or vertically.
  let s = Math.max(W / VW, H / VH) * 1.02;
  for (let i = 0; i < 40; i++, s *= 1.03) {
    const w = VW * s, h = VH * s;
    const left = Math.min(0, Math.max(W - w, W * fx - BUTTON.x * w));
    const top = Math.min(0, Math.max(H - h, H * fy - BUTTON.y * h));
    if (left + 0.88 * w >= W) return { left, top, w, h };
    // Shift up instead, if that hides it.
    const top2 = Math.min(0, Math.max(H - h, H - 0.8 * h + 1));
    if (top2 + 0.8 * h >= H && top2 + BUTTON.y * h > 40) return { left, top: top2, w, h };
  }
  const w = VW * s, h = VH * s; return { left: 0, top: 0, w, h };
}

export function shouldSkipIntro() {
  if (new URLSearchParams(location.search).has("nointro")) return true;
  try { return Date.now() - Number(localStorage.getItem(SEEN_KEY) || 0) < 3600e3; } catch { return false; }
}

// opts: { mode: "mac" | "phone", check(): Promise<{found, names, reason}>, linkView(): {state, answer, error},
//         onEnter(), onDemo(), onRetry(): Promise, copy(text), canvas, reduced, onLink(cb) }
export function runIntro(opts) {
  const { canvas, reduced } = opts;
  const root = document.createElement("div");
  root.className = "intro";
  root.innerHTML = `
    <style>
      .intro { position: fixed; inset: 0; z-index: 20; background: #000; overflow: hidden; font-family: "JetBrains Mono", ui-monospace, Menlo, monospace; color: #c9ecf8; }
      .intro video { position: absolute; transform-origin: 0 0; will-change: transform, opacity; }
      .intro .hot { position: absolute; width: 64px; height: 64px; margin: -32px 0 0 -32px; border-radius: 50%; border: 1px solid rgba(160,225,255,.75); background: transparent; cursor: pointer; animation: introPulse 2.2s ease-in-out infinite; }
      .intro .hot:focus-visible { outline: 2px solid #bfe9ff; outline-offset: 4px; }
      .intro .hint { position: absolute; font-size: 11px; letter-spacing: .12em; color: rgba(200,236,250,.8); white-space: nowrap; transform: translate(-50%, 60px); pointer-events: none; }
      .intro .skip { position: absolute; right: 18px; bottom: 16px; font: inherit; font-size: 11px; letter-spacing: .1em; color: rgba(200,210,220,.55); background: none; border: 0; padding: 8px; cursor: pointer; }
      .intro .panel { position: absolute; left: 50%; bottom: 9%; transform: translateX(-50%); width: min(460px, calc(100% - 32px)); background: rgba(3,5,7,.72); border: 1px solid rgba(255,255,255,.1); border-top-color: rgba(235,242,248,.45); padding: 16px 18px; font-size: 12px; line-height: 1.6; opacity: 0; transition: opacity .3s; }
      .intro .panel.on { opacity: 1; }
      .intro .panel h2 { font-size: 11px; font-weight: 400; letter-spacing: .14em; color: rgba(160,225,255,.85); margin: 0 0 6px; }
      .intro .panel p { margin: 0 0 8px; color: #b8c4cc; }
      .intro .panel code { color: #e6f4fa; word-break: break-all; }
      .intro .panel .code { max-height: 90px; overflow-y: auto; font-size: 10.5px; border: 1px solid rgba(255,255,255,.1); padding: 6px; margin: 6px 0; word-break: break-all; color: #dfeef5; }
      .intro .row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
      .intro .row button { font: inherit; font-size: 11px; letter-spacing: .08em; color: #dff3fb; background: rgba(120,200,240,.08); border: 1px solid rgba(160,225,255,.4); padding: 7px 12px; cursor: pointer; }
      .intro .row button.dim { border-color: rgba(255,255,255,.15); color: #aab4bc; background: transparent; }
      @keyframes introPulse { 0%,100% { box-shadow: 0 0 0 0 rgba(140,215,255,.0); opacity: .55; } 50% { box-shadow: 0 0 18px 4px rgba(140,215,255,.35); opacity: 1; } }
      @media (prefers-reduced-motion: reduce) { .intro .hot { animation: none; opacity: .9; } }
    </style>
    <video muted playsinline preload="metadata" poster="assets/intro-poster.jpg"></video>
    <button class="hot" aria-label="Press to enter"></button>
    <div class="hint">PRESS TO ENTER</div>
    <button class="skip">skip ›</button>
    <div class="panel" role="status" aria-live="polite"></div>`;
  document.body.appendChild(root);
  const video = root.querySelector("video"), hot = root.querySelector(".hot"), hint = root.querySelector(".hint"), panel = root.querySelector(".panel"), skip = root.querySelector(".skip");
  video.src = opts.videoSrc ?? "assets/intro.mp4";
  canvas.style.opacity = "0";
  let rect, chosen = null, finished = false, started = false, stalled = false;

  function place() {
    const W = innerWidth, H = innerHeight;
    rect = videoRect(W, H);
    Object.assign(video.style, { left: rect.left + "px", top: rect.top + "px", width: rect.w + "px", height: rect.h + "px", transform: "none" });
    hot.style.left = hint.style.left = rect.left + BUTTON.x * rect.w + "px";
    hot.style.top = hint.style.top = rect.top + BUTTON.y * rect.h + "px";
  }
  place();
  addEventListener("resize", place);

  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function show(html, actions) {
    panel.innerHTML = html + `<div class="row">${actions.map((a, i) => `<button data-i="${i}" class="${a.dim ? "dim" : ""}">${esc(a.label)}</button>`).join("")}</div>`;
    panel.querySelectorAll("button").forEach((b) => (b.onclick = () => actions[+b.dataset.i].fn()));
    panel.classList.add("on");
  }

  async function check() {
    if (opts.mode === "phone") return phoneStatus();
    show(`<h2>SCANNING FOR PROJECTS…</h2><p>Checking the board on this Mac.</p>`, []);
    const r = await opts.check();
    if (r.found) {
      show(`<h2>${r.names.length} PROJECT${r.names.length === 1 ? "" : "S"} FOUND</h2><p>${esc(r.names.join(", "))}</p>`, [
        { label: "ENTER", fn: () => choose("enter") }, { label: "EXPLORE THE DEMO", dim: true, fn: () => choose("demo") }]);
    } else {
      show(`<h2>NO PROJECTS CONNECTED</h2><p>${esc(r.reason || "Paperclip did not answer.")}</p>
        <p>To connect: start Paperclip so it runs on <code>localhost:3100</code>, or set <code>"paperclipUrl"</code> in <code>config.json</code> (or the <code>PAPERCLIP_URL</code> environment variable) and restart the board. Then retry.</p>`, [
        { label: "RETRY", fn: async () => { await opts.onRetry?.(); check(); } }, { label: "EXPLORE THE DEMO", fn: () => choose("demo") }]);
    }
  }
  function phoneStatus() {
    const l = opts.linkView();
    if (!l.offer) {
      show(`<h2>NO PROJECTS CONNECTED</h2><p>This page shows a board from your Mac. On the Mac, open the board, tap <b>pair phone</b> and scan the QR code with this phone.</p>`, [{ label: "EXPLORE THE DEMO", fn: () => choose("demo") }]);
    } else if (l.state === "connected") {
      const r = opts.phoneProjects();
      show(`<h2>LINKED · ${r.names.length} PROJECTS</h2><p>${esc(r.names.join(", "))}</p>`, [{ label: "ENTER", fn: () => choose("enter") }, { label: "EXPLORE THE DEMO", dim: true, fn: () => choose("demo") }]);
    } else if (l.answer) {
      show(`<h2>PAIRING WITH YOUR MAC</h2><p>Copy this code and paste it into the board on your Mac.</p><div class="code">${esc(l.answer)}</div>${l.state === "connecting" ? "<p>Connecting…</p>" : ""}`, [
        { label: "COPY CODE", fn: async () => { await opts.copy(l.answer); } }, { label: "EXPLORE THE DEMO", dim: true, fn: () => choose("demo") }]);
    } else if (l.error) show(`<h2>PAIRING FAILED</h2><p>${esc(l.error)}</p>`, [{ label: "EXPLORE THE DEMO", fn: () => choose("demo") }]);
    else show(`<h2>PREPARING THE LINK…</h2>`, []);
  }
  opts.onLink?.(() => { if (!chosen && started) phoneStatus(); });

  function press() {
    if (started) return;
    started = true;
    hot.style.display = hint.style.display = "none";
    video.play().catch(() => { stalled = true; });
    // Some hosts pause video in documents they report as hidden; then we skip the wait for the window shot.
    setTimeout(() => { if (video.currentTime < 0.3) stalled = true; }, 1500);
    check();
  }
  hot.onclick = press;
  addEventListener("keydown", function onKey(e) { if (finished) return removeEventListener("keydown", onKey); if (e.key === "Enter" && !started) press(); if (e.key === "Escape") choose(chosen ?? "skip", true); });
  skip.onclick = () => { if (!started) { started = true; check(); hot.style.display = hint.style.display = "none"; video.currentTime = WINDOW_VISIBLE_AT + 3; } else video.currentTime = Math.max(video.currentTime, WINDOW_VISIBLE_AT + 3); };

  function choose(kind, immediate = false) {
    if (chosen && !immediate) return;
    chosen = kind === "skip" ? (chosen ?? "enter") : kind;
    panel.classList.remove("on");
    if (chosen === "demo") opts.onDemo();
    if (stalled && video.currentTime < WINDOW_VISIBLE_AT) {
      // Jump to the window shot so the match-cut still lands on a window.
      video.addEventListener("seeked", () => transition(), { once: true });
      video.currentTime = 12; setTimeout(transition, 800);
      return;
    }
    if (immediate || reduced || video.currentTime >= WINDOW_VISIBLE_AT || video.ended) transition();
    else video.addEventListener("timeupdate", function wait() { if (video.currentTime >= WINDOW_VISIBLE_AT) { video.removeEventListener("timeupdate", wait); transition(); } });
    if (video.paused && !video.ended) video.play().catch(() => transition());
  }
  video.addEventListener("ended", () => { if (!chosen) video.pause(); });

  function transition() {
    if (finished) return;
    finished = true;
    try { localStorage.setItem(SEEN_KEY, String(Date.now())); } catch {}
    video.pause();
    const W = innerWidth, H = innerHeight, m = frameMetrics(W, H);
    // Map the video's window onto the frame's opening (non-uniform, precise fit), crossfading into the scene.
    const wx = rect.left + WINDOW.x * rect.w, wy = rect.top + WINDOW.y * rect.h, ww = WINDOW.w * rect.w, wh = WINDOW.h * rect.h;
    const tx = m.x0, ty = m.y0, tw = m.x1 - m.x0, th = m.y1 - m.y0;
    const sx = tw / ww, sy = th / wh;
    const dur = reduced ? 600 : 1200;
    canvas.style.transition = `opacity ${dur}ms ease`;
    root.style.background = "transparent";
    video.style.transition = `transform ${dur}ms cubic-bezier(.6,0,.2,1), opacity ${dur}ms ease ${reduced ? 0 : dur * 0.3}ms`;
    requestAnimationFrame(() => {
      if (!reduced) video.style.transform = `translate(${tx - wx * sx + rect.left * sx - rect.left}px, ${ty - wy * sy + rect.top * sy - rect.top}px) scale(${sx}, ${sy})`;
      video.style.opacity = "0";
      canvas.style.opacity = "1";
      skip.style.opacity = "0";
    });
    setTimeout(() => { root.remove(); removeEventListener("resize", place); canvas.style.transition = ""; opts.onDone?.(chosen); }, dur + (reduced ? 0 : dur * 0.3) + 50);
  }
  return { root };
}
