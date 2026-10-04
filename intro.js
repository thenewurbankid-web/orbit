// Intro: a door you press to enter. The video plays while we check for projects (Mac: the board API;
// phone: the WebRTC pairing), then the video's window match-cuts onto the frame's opening.
import { frameMetrics } from "./frame.js";
import { frostPanel, renderSelection } from "./ui.js";

const VW = 848, VH = 478;
const BUTTON = { x: 0.254, y: 0.663 };                 // door button at frame 0 (measured)
// Cut frame: 12.0 s, the last frame where the whole window opening is in shot (the camera keeps
// pushing in after it). Opening measured in video pixels on that frame.
const CUT_T = 12.0;
const WIN_PX = { x0: 80, y0: -2, x1: 765, y1: 333 }; // inner edge of the steel lip (pixel profiles at 12.0 s)
const WINDOW_VISIBLE_AT = 9;                            // seconds
const ZOOM_RATE = 0.04;                                 // the video's forward push, ~4 %/s around the cut

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

// The intro plays on every load; ?nointro (or the skip gesture) jumps straight in.
export function shouldSkipIntro() {
  return new URLSearchParams(location.search).has("nointro");
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
      .intro .panel { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(460px, calc(100% - 32px)); background: rgba(3,5,7,.72); border: 1px solid rgba(255,255,255,.1); border-top-color: rgba(235,242,248,.45); padding: 16px 18px; font-size: 12px; line-height: 1.6; opacity: 0; transition: opacity .3s; }
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
  opts.emit?.("introHud", null);
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

  // Entry selection on frosted glass: pick projects (or the demo), then START.
  let sel = null;
  function selPanel() {
    if (sel) return sel;
    sel = frostPanel("", { width: 640, closeOnOutside: false });
    sel.el.style.zIndex = "31";
    return sel;
  }
  async function check() {
    if (opts.mode === "phone") return phoneStatus();
    const p = selPanel();
    p.el.innerHTML = `<h2>SCANNING FOR PROJECTS…</h2><p>Checking the board on this Mac.</p>`;
    const r = await opts.check();
    const projects = r.projects ?? [];
    if (!projects.length) {
      p.el.innerHTML = `<h2>CONNECT A PROJECT</h2><p>${esc(r.reason || "No projects are connected yet.")}</p>
        <p>Start Paperclip so it runs on <code>localhost:3100</code> (or set <code>"paperclipUrl"</code> in <code>config.json</code>), then connect one of its companies.</p><div class="btns"></div>`;
      const btns = p.el.querySelector(".btns");
      const mk = (label, fn, dim) => { const b = document.createElement("button"); b.textContent = label; if (dim) b.className = "dim"; b.onclick = fn; btns.appendChild(b); };
      mk("+ CONNECT A PROJECT", () => opts.connect?.(() => check()));
      mk("RETRY", async () => { await opts.onRetry?.(); check(); }, true);
      mk("DEMO", () => choose("demo"), true);
      mk("?", () => opts.help?.(), true);
      return;
    }
    renderSelection(p.el, {
      title: `${projects.length} PROJECT${projects.length === 1 ? "" : "S"} · CHOOSE WHAT TO WATCH`,
      projects, preselected: opts.lastSelection?.() ?? null, demoSelected: opts.lastSelection?.() === "demo", canConnect: true,
      onConnect: (done) => opts.connect?.(done), onHelp: () => opts.help?.(),
      onStart: (pick) => { opts.saveSelection?.(pick); if (pick.demo) choose("demo"); else { opts.select?.(pick.ids); choose("enter"); } },
    });
  }
  function phoneStatus() {
    const l = opts.linkView();
    const p = selPanel();
    const simple = (html, buttons) => {
      p.el.innerHTML = html + `<div class="btns"></div>`;
      for (const [label, fn, dim] of buttons) { const b = document.createElement("button"); b.textContent = label; if (dim) b.className = "dim"; b.onclick = fn; p.el.querySelector(".btns").appendChild(b); }
    };
    if (!l.offer) simple(`<h2>NO PROJECTS CONNECTED</h2><p>This page shows a board from your Mac. On the Mac, open the board, tap <b>pair phone</b> and scan the QR code with this phone.</p>`, [["DEMO", () => choose("demo")], ["?", () => opts.help?.(), true]]);
    else if (l.state === "connected") {
      const projects = opts.phoneProjects().projects;
      renderSelection(p.el, { title: `LINKED · ${projects.length} PROJECTS`, projects, preselected: opts.lastSelection?.(), demoSelected: false, canConnect: true,
        onConnect: (done) => opts.connect?.(done), onHelp: () => opts.help?.(),
        onStart: (pick) => { opts.saveSelection?.(pick); if (pick.demo) choose("demo"); else { opts.select?.(pick.ids); choose("enter"); } } });
    } else if (l.answer) simple(`<h2>PAIRING WITH YOUR MAC</h2><p>Copy this code and paste it into the board on your Mac.</p><div class="code" style="max-height:90px;overflow-y:auto;font-size:10.5px;border:1px solid rgba(255,255,255,.1);padding:6px;word-break:break-all">${esc(l.answer)}</div>${l.state === "connecting" ? "<p>Connecting…</p>" : ""}`, [["COPY CODE", async () => { await opts.copy(l.answer); }], ["DEMO", () => choose("demo"), true]]);
    else if (l.error) simple(`<h2>PAIRING FAILED</h2><p>${esc(l.error)}</p>`, [["DEMO", () => choose("demo")]]);
    else simple(`<h2>PREPARING THE LINK…</h2>`, []);
  }
  opts.onLink?.(() => { if (!chosen && started) phoneStatus(); });

  function press() {
    if (started) return;
    started = true;
    opts.sound?.("press");
    hot.style.display = hint.style.display = "none";
    // The door stays shut (video paused on its first frame) while the menu is up; it opens only
    // after a project or the demo is chosen.
    check();
  }
  hot.onclick = press;
  // Title menu before the door: START reveals the door button, HELP explains the app.
  let title = null, nameEl = null;
  function showTitle() {
    hot.style.display = hint.style.display = "none";
    nameEl = document.createElement("div");
    nameEl.textContent = "ORBIT";
    Object.assign(nameEl.style, { position: "fixed", left: "50%", top: "calc(50% - 116px)", transform: "translate(-50%, -100%)", zIndex: 31, pointerEvents: "none",
      font: '200 64px/1 "JetBrains Mono", ui-monospace, Menlo, monospace', letterSpacing: ".42em", paddingLeft: ".42em", color: "#fff", whiteSpace: "nowrap",
      textShadow: "0 0 6px rgba(255,255,255,.9), 0 0 18px rgba(200,235,255,.65), 0 0 42px rgba(150,210,255,.4)", opacity: 0, transition: "opacity 450ms ease-out" });
    document.body.appendChild(nameEl); requestAnimationFrame(() => { nameEl.style.opacity = 1; });
    title = frostPanel(`<div style="display:grid;gap:12px"><button class="primary" data-a="start" style="width:100%;font-size:16px;padding:16px 0;letter-spacing:.3em">START</button><button data-a="help" style="width:100%;font-size:16px;padding:16px 0;letter-spacing:.3em">HELP</button></div>`,
      { width: 340, closeOnOutside: false });
    title.el.querySelector('[data-a="start"]').addEventListener("click", startDoor);
    title.el.querySelector('[data-a="help"]').addEventListener("click", () => opts.help?.());
  }
  function startDoor() {
    if (!title) return;
    opts.sound?.("press"); // unlock audio on this gesture
    title.close();
    if (nameEl) { const n = nameEl; n.style.opacity = 0; setTimeout(() => n.remove(), 450); nameEl = null; }
    title = null;
    hot.style.display = hint.style.display = "";
  }
  showTitle();
  addEventListener("keydown", function onKey(e) { if (finished) return removeEventListener("keydown", onKey); if (e.key === "Enter" && !started) { if (title) startDoor(); else press(); } if (e.key === "Escape") choose(chosen ?? "skip", true); });
  skip.onclick = () => { if (!started) { started = true; check(); hot.style.display = hint.style.display = "none"; video.currentTime = WINDOW_VISIBLE_AT + 3; } else video.currentTime = Math.max(video.currentTime, WINDOW_VISIBLE_AT + 3); };

  function choose(kind, immediate = false) {
    if (chosen && !immediate) return;
    chosen = kind === "skip" ? (chosen ?? "enter") : kind;
    panel.classList.remove("on");
    sel?.close();
    if (chosen === "demo") opts.onDemo();
    goToCut();
  }
  // Reach the cut frame: fast-forward smoothly if it is ahead, then cut.
  function goToCut() {
    if (reduced) return transition();
    if (stalled) {
      // Playback blocked by the host: seek straight to the cut frame.
      video.addEventListener("seeked", () => transition(), { once: true });
      video.currentTime = CUT_T; setTimeout(transition, 900);
      return;
    }
    if (video.currentTime >= CUT_T) { video.currentTime = CUT_T; video.addEventListener("seeked", () => transition(), { once: true }); return; }
    video.playbackRate = 1; video.muted = false; video.volume = 0.9; // play the whole door sequence with its soundtrack
    const tick = () => {
      if (finished) return;
      if (video.currentTime >= CUT_T - 0.03) { video.pause(); video.playbackRate = 1; transition(); return; }
      requestAnimationFrame(tick);
    };
    if (video.paused) video.play().catch(() => { video.muted = true; video.play().catch(() => { stalled = true; goToCut(); }); });
    requestAnimationFrame(tick);
    setTimeout(() => { if (!finished && video.currentTime < 0.3) { stalled = true; goToCut(); } }, 2500);
  }
  video.addEventListener("ended", () => { if (!chosen) video.pause(); });
  // Without a choice the video stops on the cut frame and waits there.
  video.addEventListener("timeupdate", () => {
    // Chosen: cut on the video clock too, in case animation frames are throttled (hidden or background pages).
    if (chosen && !finished && !stalled && video.currentTime >= CUT_T - 0.03) { video.playbackRate = 1; transition(); return; }
    if (!chosen && !video.muted && video.currentTime >= CUT_T - 0.8) video.volume = Math.max(0, 0.9 * (CUT_T - video.currentTime) / 0.8);
    if (!chosen && video.currentTime >= CUT_T) { video.pause(); video.currentTime = CUT_T; }
  });

  // Sample the cut frame's colours: black level and star tint, to match our scene's grade.
  function sampleGrade() {
    try {
      const c = document.createElement("canvas"); c.width = 96; c.height = 54;
      const x = c.getContext("2d", { willReadFrequently: true }); x.drawImage(video, 0, 0, 96, 54);
      const d = x.getImageData(Math.round(WIN_PX.x0 / VW * 96), Math.round(WIN_PX.y0 / VH * 54), Math.round((WIN_PX.x1 - WIN_PX.x0) / VW * 96), Math.round((WIN_PX.y1 - WIN_PX.y0) / VH * 54)).data;
      const px = []; for (let i = 0; i < d.length; i += 4) px.push([d[i], d[i + 1], d[i + 2], d[i] * 0.2126 + d[i + 1] * 0.7152 + d[i + 2] * 0.0722]);
      px.sort((a, b) => a[3] - b[3]);
      const avg = (arr) => [0, 1, 2].map((k) => arr.reduce((s, p) => s + p[k], 0) / arr.length / 255);
      const lin = (v) => Math.pow(v, 2.2);
      const dark = avg(px.slice(0, Math.max(1, px.length * 0.3 | 0))).map(lin);
      const bright = avg(px.slice(-Math.max(1, px.length * 0.02 | 0)));
      const m = Math.max(...bright) || 1;
      const mean = px.reduce((s, p) => s + p[3], 0) / px.length / 255;
      return { bg: dark.map((v) => Math.min(0.06, v)), tint: bright.map((v) => 0.75 + 0.25 * (v / m)), exposure: Math.min(2.4, Math.max(1.5, 1.5 * (0.5 + mean * 4))) };
    } catch { return { bg: [0.004, 0.008, 0.02], tint: [0.85, 0.92, 1], exposure: 1.7 }; }
  }

  // Match-cut: the video's window glides onto our frame's opening while our SVG frame takes over
  // the metal and the live scene takes over the space inside. Constant brightness: the video sits
  // above the opaque scene and only its own opacity changes.
  const MOVE = 900, XF0 = 450, XF1 = 1050;
  let tr = null;
  function fadeOutVideo() {
    const v0 = video.volume, t0 = performance.now();
    const f = () => { const k = Math.min(1, (performance.now() - t0) / 700); video.volume = v0 * (1 - k); if (k < 1) setTimeout(f, 30); else video.pause(); };
    if (video.muted || video.paused) video.pause(); else f();
  }
  function transition() {
    if (finished) return;
    finished = true;
    fadeOutVideo();
    const W = innerWidth, H = innerHeight, m = frameMetrics(W, H);
    const from = { x0: rect.left + WIN_PX.x0 / VW * rect.w, y0: rect.top + WIN_PX.y0 / VH * rect.h, x1: rect.left + WIN_PX.x1 / VW * rect.w, y1: rect.top + WIN_PX.y1 / VH * rect.h };
    const to = { x0: m.x0, y0: m.y0, x1: m.x1, y1: m.y1 };
    const frame = opts.frame?.();
    opts.emit?.("introGrade", { ...sampleGrade(), hold: XF0 + 200, ease: 2000 });
    opts.emit?.("introDrift", { rate: ZOOM_RATE * 2.5, dur: 1500 });
    root.style.background = "transparent";
    canvas.style.transition = ""; canvas.style.opacity = "1";
    skip.style.display = "none";
    frame?.setZ(21); frame?.setOpacity(0); frame?.setOpening(from, W, H);
    tr = { from, to, frame, W, H };
    if (reduced) { applyAt(XF1 + 1); return finish(); }
    if (new URLSearchParams(location.search).has("introdebug")) { window.__introApplyAt = applyAt; window.__introFinish = finish; applyAt(0); return; }
    const t0 = performance.now();
    const step = () => {
      const t = performance.now() - t0;
      applyAt(t);
      if (t < XF1) (document.hidden ? setTimeout(step, 16) : requestAnimationFrame(step));
      else finish();
    };
    step();
  }
  const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
  function applyAt(t) {
    const { from, to, frame, W, H } = tr;
    const e = ease(Math.min(1, Math.max(0, t / MOVE)));
    const cur = { x0: from.x0 + (to.x0 - from.x0) * e, y0: from.y0 + (to.y0 - from.y0) * e, x1: from.x1 + (to.x1 - from.x1) * e, y1: from.y1 + (to.y1 - from.y1) * e };
    // Video transform: map its window (from) onto the current opening (cur).
    const sx = (cur.x1 - cur.x0) / (from.x1 - from.x0), sy = (cur.y1 - cur.y0) / (from.y1 - from.y0);
    const tx = cur.x0 - (from.x0 - rect.left) * sx - rect.left, ty = cur.y0 - (from.y0 - rect.top) * sy - rect.top;
    video.style.transform = `translate(${tx}px, ${ty}px) scale(${sx}, ${sy})`;
    frame?.setOpening(cur, W, H);
    frame?.setOpacity(Math.min(1, t / XF0));
    video.style.opacity = String(t < XF0 ? 1 : Math.max(0, 1 - (t - XF0) / (XF1 - XF0)));
  }
  function finish() {
    opts.sound?.("enter"); // our ship sound starts only once the video is over
    const { frame, W, H } = tr;
    root.remove(); removeEventListener("resize", place);
    frame?.setOpening(null, W, H); frame?.setOpacity(1); frame?.setZ(2);
    opts.emit?.("introHud", true);
    opts.onDone?.(chosen);
  }
  return { root };
}
