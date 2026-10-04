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
      /* Help inside the title card: the name shrinks and rises to the top, the buttons fade, cards slide up. */
      .orbit-title { transition: transform 900ms cubic-bezier(.22,1,.36,1); transform-origin: 50% 0; }
      .orbit-stage .orbit-btns { transition: opacity 400ms, transform 500ms cubic-bezier(.22,1,.36,1); }
      .orbit-stage.helping .orbit-title { transform: translateY(var(--orbit-lift, -30vh)) scale(.36); }
      .orbit-stage.helping .orbit-btns { opacity: 0 !important; transform: translateY(20px) !important; pointer-events: none; }
      .orbit-help { position: absolute; inset: 120px 0 0 0; overflow-y: auto; opacity: 0; pointer-events: none; transition: opacity 500ms 250ms; padding: 0 8px 28px; }
      .orbit-stage.helping .orbit-help { opacity: 1; pointer-events: auto; }
      .orbit-back { position: fixed; top: 22px; left: 22px; background: none !important; border: 0 !important; color: #b9d6e0 !important; letter-spacing: .2em; font-size: 12px !important; cursor: pointer; }
      .orbit-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); gap: 22px; max-width: 1100px; margin: 0 auto; }
      .orbit-cards article { display: grid; gap: 12px; padding: 14px; border-radius: 14px; background: rgba(255,255,255,.035); box-shadow: inset 0 0 0 1px rgba(160,235,255,.14);
        opacity: 0; transform: translateY(24px); transition: opacity 600ms, transform 700ms cubic-bezier(.22,1,.36,1); }
      .orbit-cards article img { width: 100%; border-radius: 9px; display: block; box-shadow: 0 10px 30px rgba(0,0,0,.45); }
      .orbit-cards article h3 { margin: 2px 0 6px; font-size: 14px; font-weight: 500; letter-spacing: .12em; color: #e8f7ff; text-transform: uppercase; }
      .orbit-cards article p { margin: 0; color: #b9cdd6; font-size: 14px; line-height: 1.65; }
      .orbit-stage.helping .orbit-cards article { opacity: 1; transform: none; }
      .orbit-stage.helping .orbit-cards article:nth-child(1) { transition-delay: 350ms; } .orbit-stage.helping .orbit-cards article:nth-child(2) { transition-delay: 450ms; }
      .orbit-stage.helping .orbit-cards article:nth-child(3) { transition-delay: 550ms; } .orbit-stage.helping .orbit-cards article:nth-child(4) { transition-delay: 650ms; }
      .orbit-stage.helping .orbit-cards article:nth-child(5) { transition-delay: 750ms; }
      .orbit-help-start { display: flex; justify-content: center; margin-top: 26px; }
      .orbit-help-start button { width: min(320px, 80vw); height: 52px; border-radius: 12px; border: 1px solid rgba(160,235,255,.55); background: rgba(255,255,255,.035); color: #e6f7fc; letter-spacing: .36em; font-size: 15px; cursor: pointer; box-shadow: 0 0 10px rgba(120,220,255,.22); }
      .orbit-help-start button:hover { border-color: rgba(190,242,255,.8); box-shadow: 0 0 16px rgba(120,220,255,.35); }
      /* Calm buttons: no moving border, no hover theatrics. Hover only brightens the edge and fill a little. */
      .orbit-btns button::before, .orbit-btns button::after { content: none !important; display: none !important; }
      .orbit-btns button, .orbit-btns.settled button.primary { animation: none !important; }
      .orbit-btns button { transition: border-color .25s, background-color .25s, color .25s !important; }
      .orbit-btns button:hover, .orbit-btns button:focus-visible { transform: none !important; letter-spacing: .36em !important;
        border-color: rgba(200,244,255,.75) !important; background: rgba(255,255,255,.07) !important; box-shadow: 0 0 10px rgba(120,220,255,.22), inset 0 0 10px rgba(120,220,255,.08) !important; }
      .orbit-btns button:active { transform: none !important; background: rgba(255,255,255,.1) !important; }
      .orbit-btns .ripple { display: none !important; }
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
  if (!document.getElementById("orbit-title-css")) {
    const st = document.createElement("style"); st.id = "orbit-title-css";
    st.textContent = `
      .orbit-title { font: 200 clamp(88px, 15vw, 190px)/1 "JetBrains Mono", ui-monospace, Menlo, monospace; letter-spacing: .38em; padding-left: .38em; color: #fff; white-space: nowrap;
        text-shadow: 0 0 8px rgba(255,255,255,.9), 0 0 26px rgba(200,235,255,.6), 0 0 60px rgba(150,210,255,.35); animation: orbit-glow 7s cubic-bezier(.45,0,.55,1) 2.2s infinite alternate; }
      .orbit-title span { display: inline-block; opacity: 0; filter: blur(14px); transform: translateY(18px) scale(1.15);
        animation: orbit-in 1.1s cubic-bezier(.22,1,.36,1) forwards; animation-delay: calc(.25s + var(--i) * .14s); }
      .orbit-btns { opacity: 0; transform: translateY(10px); animation: orbit-up .7s cubic-bezier(.22,1,.36,1) 1.35s forwards; }
      @keyframes orbit-in { 60% { opacity: 1; } to { opacity: 1; filter: blur(0); transform: none; } }
      @keyframes orbit-up { to { opacity: 1; transform: none; } }
      @keyframes orbit-glow { 100% { text-shadow: 0 0 10px rgba(255,255,255,1), 0 0 34px rgba(210,240,255,.75), 0 0 80px rgba(150,210,255,.45); } }
      /* After settling: a slow light sweep through the letters on top of the glow pulse. */
      .orbit-title span { background: linear-gradient(100deg, #fff 40%, #dff6ff 48%, #fff 56%) 0 0 / 300% 100% no-repeat; -webkit-background-clip: text; background-clip: text; }
      .orbit-title.settled span { animation: orbit-sheen 6s ease-in-out infinite; animation-delay: calc(var(--i) * .12s); opacity: 1; filter: none; transform: none; }
      @keyframes orbit-sheen { 0%, 70% { background-position: 100% 0; } 85% { background-position: 0 0; } 100% { background-position: 0 0; } }
      /* Electric neon buttons: a glowing neon tube outline, a spark of current racing around the edge,
         a quick flicker as they power on, a hum-like glow pulse, and a surge on hover/press. START is lit
         brighter; HELP runs at lower power. */
      @property --orbit-a { syntax: "<angle>"; inherits: false; initial-value: 0deg; }
      .orbit-btns button { position: relative; overflow: visible; isolation: isolate; border-radius: 12px !important; height: 56px; padding: 0 !important;
        font-size: 15px !important; letter-spacing: .36em !important; color: #e6f7fc !important; background: rgba(255,255,255,.035) !important; -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
        border: 1px solid rgba(160,235,255,.55) !important;
        text-shadow: 0 0 6px rgba(150,230,255,.55);
        box-shadow: 0 0 10px rgba(120,220,255,.22), inset 0 0 10px rgba(120,220,255,.08);
        animation: orbit-poweron 1.1s steps(1, end) 1.35s both; transition: box-shadow .25s, letter-spacing .3s, transform .25s; }
      .orbit-btns button::before { content: ""; position: absolute; inset: -2px; border-radius: 13px; padding: 2px; pointer-events: none; filter: blur(.5px) drop-shadow(0 0 3px rgba(185,246,255,.6)); opacity: .55;
        background: conic-gradient(from var(--orbit-a), transparent 0 84%, rgba(200,250,255,.0) 86%, #ffffff 90%, rgba(140,240,255,.9) 92%, transparent 95%);
        -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor; mask-composite: exclude;
        animation: orbit-current 2.6s linear infinite; }
      .orbit-btns button::after { content: ""; position: absolute; inset: 0; border-radius: inherit; pointer-events: none; opacity: 0;
        background: repeating-linear-gradient(180deg, rgba(160,240,255,.08) 0 1px, transparent 1px 3px); transition: opacity .25s; }
      .orbit-btns button .liq { display: none; }
      .orbit-btns button:not(.primary) { border-color: rgba(160,235,255,.28) !important; color: #b9d6e0 !important; text-shadow: none; box-shadow: none; }
      .orbit-btns button:not(.primary)::before { animation-duration: 6s; opacity: .25; }
      .orbit-btns button:hover, .orbit-btns button:focus-visible { outline: none; letter-spacing: .44em !important; transform: translateY(-1px);
        border-color: rgba(190,242,255,.8) !important; box-shadow: 0 0 14px rgba(120,220,255,.35), 0 0 30px rgba(80,200,255,.15), inset 0 0 14px rgba(120,220,255,.14); }
      .orbit-btns button:hover::after, .orbit-btns button:focus-visible::after { opacity: 1; }
      .orbit-btns button:hover::before, .orbit-btns button:focus-visible::before { animation-duration: .9s; }
      .orbit-btns button:active { transform: scale(.985); box-shadow: 0 0 18px rgba(170,240,255,.5), inset 0 0 18px rgba(160,240,255,.25); }
      .orbit-btns .ripple { position: absolute; z-index: -1; border-radius: 50%; width: 10px; height: 10px; margin: -5px 0 0 -5px; pointer-events: none;
        background: radial-gradient(circle, rgba(220,250,255,.8), rgba(120,235,255,0) 70%); animation: orbit-ripple .6s cubic-bezier(.22,1,.36,1) forwards; }
      @keyframes orbit-current { to { --orbit-a: 360deg; } }
      @keyframes orbit-poweron { 0% { opacity: .15; } 8% { opacity: 1; } 14% { opacity: .3; } 22% { opacity: 1; } 30% { opacity: .55; } 40%, 100% { opacity: 1; } }
      @keyframes orbit-ripple { to { transform: scale(36); opacity: 0; } }
      .orbit-btns.settled button.primary { animation: orbit-hum 2.8s ease-in-out infinite; }
      @keyframes orbit-hum { 50% { box-shadow: 0 0 16px rgba(120,220,255,.32), inset 0 0 12px rgba(120,220,255,.12); } }
      @media (prefers-reduced-motion: reduce) { .orbit-title, .orbit-title span, .orbit-btns, .orbit-btns button, .orbit-btns button::before, .orbit-btns button::after, .orbit-btns .liq, .orbit-title, .orbit-cards article, .orbit-help { animation: none !important; transition: none !important; opacity: 1 !important; filter: none !important; transform: none !important; } }`;
    document.head.appendChild(st);
  }
    hot.style.display = hint.style.display = "none";
    const btn = 'style="width:100%"';
    title = frostPanel(`<div class="orbit-stage" style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:40px;position:relative">
      <div class="orbit-title"><span style="--i:0">O</span><span style="--i:1">R</span><span style="--i:2">B</span><span style="--i:3">I</span><span style="--i:4">T</span></div>
      <div class="orbit-help" aria-hidden="true">
        <button class="orbit-back" data-a="back">← BACK</button>
        <div class="orbit-cards">
          <article><img src="assets/help/overview.jpg" alt="The Orbit view: three project planets with KPIs at the top"><div><h3>Projects are planets</h3><p>Each Paperclip project you pick is a planet. The numbers across the top show agents working, issues in progress, blocked, and questions waiting on you.</p></div></article>
          <article><img src="assets/help/planet.jpg" alt="A planet with its agent moons and issue satellites"><div><h3>Agents are moons, issues are satellites</h3><p>Tap a planet to fly in. Its agents orbit as moons, and each issue is a satellite with a thin arc showing its rough % done.</p></div></article>
          <article><img src="assets/help/chat.jpg" alt="The chat panel next to an agent"><div><h3>Talk to an agent</h3><p>Tap a moon to see what that agent is doing and send it a message. It arrives as a comment on its issue.</p></div></article>
          <article class="text"><div><h3>Events</h3><p>UFO: an agent starts work · Meteor: an issue is done · Comet: a new issue · Hostile ship: a question waits for you (your answer flies out as a fighter) · Storm: blocked · Ice: no update for 2 h · Red alert: something critical.</p></div></article>
          <article class="text"><div><h3>Setup</h3><p>Paperclip runs on this Mac at localhost:3100. Orbit runs as a Mac service at 127.0.0.1:4320. Use “+ project” to add projects, “pair phone” to follow on your phone, and Ollama on this Mac gives the rough estimates.</p></div></article>
        </div>
        <div class="orbit-help-start"><button class="primary" data-a="start2">START</button></div>
      </div>
      <div class="orbit-btns" style="display:grid;gap:12px;width:min(320px,80vw)"><button class="primary" data-a="start" ${btn}><span class="liq"></span>START</button><button data-a="help" ${btn}><span class="liq"></span>HELP</button></div></div>`,
      { width: 10000, closeOnOutside: false });
    // Full-screen frosted card over the door.
    Object.assign(title.el.style, { left: "0", top: "0", width: "100%", height: "100%", maxHeight: "none", transform: "none", borderRadius: "0", border: "0", padding: "24px", boxSizing: "border-box" });
    requestAnimationFrame(() => { if (title) title.el.style.transform = "none"; }); // frostPanel re-centres on its first frame
    setTimeout(() => { title?.el.querySelector(".orbit-title")?.classList.add("settled"); title?.el.querySelector(".orbit-btns")?.classList.add("settled"); }, 2300);
    title.el.querySelectorAll(".orbit-btns button").forEach((b) => b.addEventListener("pointerdown", (e) => {
      const r = b.getBoundingClientRect(), d = document.createElement("span"); d.className = "ripple";
      d.style.left = e.clientX - r.left + "px"; d.style.top = e.clientY - r.top + "px"; b.appendChild(d); setTimeout(() => d.remove(), 850);
    }));
    title.el.querySelector('[data-a="start"]').addEventListener("click", startDoor);
    const stage = title.el.querySelector(".orbit-stage"), helpEl = title.el.querySelector(".orbit-help");
    const tEl = title.el.querySelector(".orbit-title");
    const measureLift = () => { const r = tEl.getBoundingClientRect(); stage.style.setProperty("--orbit-lift", `${26 - r.top}px`); };
    const setHelp = (on) => { if (on && !stage.classList.contains("helping")) measureLift(); stage.classList.toggle("helping", on); helpEl.setAttribute("aria-hidden", on ? "false" : "true"); if (on) helpEl.scrollTop = 0; };
    title.el.querySelector('[data-a="help"]').addEventListener("click", () => setHelp(true));
    title.el.querySelector('[data-a="back"]').addEventListener("click", () => setHelp(false));
    title.el.querySelector('[data-a="start2"]').addEventListener("click", startDoor);

  }
  // Dissolve a frosted panel slowly (blur and opacity together) instead of the quick close.
  function dissolve(panel, ms = 700) {
    if (!panel) return;
    const el = panel.el;
    el.style.transition = `opacity ${ms}ms cubic-bezier(.22,1,.36,1), backdrop-filter ${ms}ms cubic-bezier(.22,1,.36,1), -webkit-backdrop-filter ${ms}ms cubic-bezier(.22,1,.36,1)`;
    el.style.pointerEvents = "none";
    requestAnimationFrame(() => { el.style.opacity = "0"; el.style.backdropFilter = el.style.webkitBackdropFilter = "blur(0px)"; });
    setTimeout(() => panel.close(), ms);
  }
  function startDoor() {
    if (!title) return;
    opts.sound?.("press"); // unlock audio on this gesture
    dissolve(title);
    title = null;
    hot.style.display = hint.style.display = "";
  }
  showTitle();
  addEventListener("keydown", function onKey(e) { if (finished) return removeEventListener("keydown", onKey); if (e.key === "Enter" && !started) { if (title) startDoor(); else press(); } if (e.key === "Escape") choose(chosen ?? "skip", true); });
  skip.onclick = () => { if (title) { dissolve(title); title = null; } if (!started) { started = true; check(); hot.style.display = hint.style.display = "none"; video.currentTime = WINDOW_VISIBLE_AT + 3; } else video.currentTime = Math.max(video.currentTime, WINDOW_VISIBLE_AT + 3); };

  function choose(kind, immediate = false) {
    if (chosen && !immediate) return;
    chosen = kind === "skip" ? (chosen ?? "enter") : kind;
    panel.classList.remove("on");
    dissolve(sel);
    if (title) { dissolve(title); title = null; }
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
    video.playbackRate = 1; video.muted = false; video.volume = 0; // play the whole door sequence with its soundtrack
    { const t0 = performance.now(); const up = () => { const k = Math.min(1, (performance.now() - t0) / 900); if (!video.muted && !finished) video.volume = 0.9 * k; if (k < 1) setTimeout(up, 30); }; up(); }
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
