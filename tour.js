// Guided tour: one step per feature. Each step can move the camera (enter), points a spotlight at the real
// thing on screen (target: a circle {x, y, r} or a box {x, y, w, h} in CSS px, re-read every frame so it
// follows a moving camera) and places its card clear of the target and of anything in avoid().
// Keys: → / Enter next, ← back, Esc ends. The scene keeps running underneath.

const CSS = `
.orbit-tour-ring { position: fixed; z-index: 40; pointer-events: none; border: 1.5px solid rgba(160,225,255,.85); border-radius: 50%;
  box-shadow: 0 0 0 9999px rgba(2,4,8,.5), 0 0 18px rgba(120,210,255,.45); transition: opacity 250ms; opacity: 0; }
.orbit-tour-ring.box { border-radius: 10px; }
.orbit-tour-ring.on { opacity: 1; }
.orbit-tour-ring.pulse::after { content: ""; position: absolute; inset: -6px; border-radius: inherit; border: 1px solid rgba(160,225,255,.5); animation: tour-pulse 1.8s ease-out infinite; }
.orbit-tour-shade { position: fixed; inset: 0; z-index: 39; pointer-events: none; background: rgba(2,4,8,.35); opacity: 0; transition: opacity 250ms; }
.orbit-tour-shade.on { opacity: 1; }
.orbit-tour-card { position: fixed; z-index: 41; width: min(340px, calc(100vw - 32px)); box-sizing: border-box; padding: 16px 18px 14px;
  font: 13px/1.5 ui-monospace, Menlo, monospace; color: #c3ced5; background: rgba(10,12,16,.82); -webkit-backdrop-filter: blur(16px); backdrop-filter: blur(16px);
  border: 1px solid rgba(255,255,255,.1); border-top-color: rgba(235,242,248,.4); border-radius: 12px; box-shadow: 0 16px 40px rgba(0,0,0,.5);
  opacity: 0; transform: translateY(4px); transition: opacity 220ms, transform 220ms; }
.orbit-tour-card.on { opacity: 1; transform: none; }
.orbit-tour-card .n { font-size: 11px; letter-spacing: .16em; color: rgba(160,225,255,.8); margin-bottom: 6px; display: flex; justify-content: space-between; }
.orbit-tour-card h3 { margin: 0 0 6px; font: 500 14px/1.35 ui-monospace, Menlo, monospace; color: #e8f3f8; letter-spacing: .02em; }
.orbit-tour-card p { margin: 0 0 6px; }
.orbit-tour-card .dots { display: flex; gap: 4px; margin: 10px 0 0; }
.orbit-tour-card .dots i { width: 6px; height: 6px; border-radius: 50%; background: rgba(255,255,255,.15); }
.orbit-tour-card .dots i.on { background: #9fdcff; }
.orbit-tour-card .btns { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
.orbit-tour-card button { font: inherit; font-size: 12px; letter-spacing: .08em; padding: 6px 12px; border-radius: 6px; cursor: pointer;
  color: #dff3fb; background: rgba(120,200,240,.1); border: 1px solid rgba(160,225,255,.45); }
.orbit-tour-card button.dim { color: #aab4bc; background: transparent; border-color: rgba(255,255,255,.15); }
.orbit-tour-card button:disabled { opacity: .3; cursor: default; }
.orbit-tour-card button.skip { margin-right: auto; }
@keyframes tour-pulse { from { opacity: .9; transform: scale(1); } to { opacity: 0; transform: scale(1.25); } }
@media (prefers-reduced-motion: reduce) { .orbit-tour-ring.pulse::after { animation: none; } .orbit-tour-card { transition: none; } }`;

let active = null;

export function startTour({ doc = document, win = window, steps, onEnd }) {
  active?.end(false);
  if (!doc.getElementById("orbit-tour-css")) { const s = doc.createElement("style"); s.id = "orbit-tour-css"; s.textContent = CSS; doc.head.appendChild(s); }
  const shade = doc.createElement("div"); shade.className = "orbit-tour-shade";
  const ring = doc.createElement("div"); ring.className = "orbit-tour-ring";
  const card = doc.createElement("div"); card.className = "orbit-tour-card"; card.setAttribute("role", "dialog"); card.setAttribute("aria-live", "polite");
  doc.body.append(shade, ring, card);
  let i = -1, raf = 0, shown = null, ended = false;

  function show(k) {
    i = Math.max(0, Math.min(steps.length - 1, k));
    const s = steps[i];
    try { s.enter?.(); } catch (e) { console.error("[tour]", e); }
    card.classList.remove("on");
    card.setAttribute("aria-label", `Tour step ${i + 1} of ${steps.length}: ${s.title}`);
    card.innerHTML = `<div class="n"><span>TOUR</span><span>${i + 1} / ${steps.length}</span></div><h3>${s.title}</h3>${s.text.map((t) => `<p>${t}</p>`).join("")}
      <div class="dots">${steps.map((_, k) => `<i class="${k <= i ? "on" : ""}"></i>`).join("")}</div>
      <div class="btns"><button class="dim skip" type="button">${i === steps.length - 1 ? "Close" : "Skip tour"}</button><button class="dim back" type="button" ${i ? "" : "disabled"}>‹ Back</button><button class="next" type="button">${i === steps.length - 1 ? "Done" : "Next ›"}</button></div>`;
    card.querySelector(".skip").onclick = () => end(true);
    card.querySelector(".back").onclick = () => show(i - 1);
    card.querySelector(".next").onclick = () => (i === steps.length - 1 ? end(true) : show(i + 1));
    shown = null;
    // let the camera start moving before the card settles, so it lands next to where the target ends up
    win.setTimeout(() => { if (!ended && steps[i] === s) { card.classList.add("on"); card.querySelector(".next").focus({ preventScroll: true }); } }, s.delay ?? 450);
  }

  const lerp = (a, b, k) => a + (b - a) * k;
  function frame() {
    raf = win.requestAnimationFrame(frame);
    const s = steps[i]; if (!s) return;
    const W = win.innerWidth, H = win.innerHeight;
    let t = null; try { t = s.target?.() ?? null; } catch { t = null; }
    if (t && (t.x + (t.w ?? t.r) < 0 || t.x - (t.r ?? 0) > W || t.y + (t.h ?? t.r) < 0 || t.y - (t.r ?? 0) > H)) t = null; // off screen
    // box in screen px, padded
    let box = null;
    if (t) {
      if (t.r != null) { const r = Math.max(22, t.r + 10); box = { x: t.x - r, y: t.y - r, w: r * 2, h: r * 2, round: true }; }
      else { const p = 6; box = { x: t.x - p, y: t.y - p, w: t.w + p * 2, h: t.h + p * 2, round: false }; }
    }
    ring.classList.toggle("on", !!box); shade.classList.toggle("on", !box);
    if (box) {
      const k = shown ? 0.25 : 1;
      shown = shown ? { x: lerp(shown.x, box.x, k), y: lerp(shown.y, box.y, k), w: lerp(shown.w, box.w, k), h: lerp(shown.h, box.h, k) } : { ...box };
      ring.classList.toggle("box", !box.round); ring.classList.add("pulse");
      Object.assign(ring.style, { left: shown.x + "px", top: shown.y + "px", width: shown.w + "px", height: shown.h + "px" });
    } else shown = null;
    placeCard(box, W, H, (() => { try { return s.avoid?.() ?? []; } catch { return []; } })());
  }

  const hit = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  function placeCard(box, W, H, avoid) {
    const cw = card.offsetWidth, ch = card.offsetHeight, m = 16, gap = 18;
    const fits = (r) => r.x >= m && r.y >= m && r.x + r.w <= W - m && r.y + r.h <= H - m && !avoid.some((a) => a && a.w > 0 && hit(r, a)) && !(box && hit(r, box));
    const clampX = (x) => Math.max(m, Math.min(W - m - cw, x)), clampY = (y) => Math.max(m, Math.min(H - m - ch, y));
    let pos = null;
    if (box) {
      const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
      const tries = [
        { x: box.x + box.w + gap, y: clampY(cy - ch / 2) }, { x: box.x - gap - cw, y: clampY(cy - ch / 2) },
        { x: clampX(cx - cw / 2), y: box.y + box.h + gap }, { x: clampX(cx - cw / 2), y: box.y - gap - ch },
        { x: m, y: m + 60 }, { x: W - m - cw, y: m + 60 }, { x: m, y: H - m - ch - 50 }, { x: W - m - cw, y: H - m - ch - 50 },
      ];
      pos = tries.find((p) => fits({ ...p, w: cw, h: ch }));
    }
    if (!pos) { // centred, nudged off anything it would cover
      pos = { x: clampX((W - cw) / 2), y: clampY(H * 0.62 - ch / 2) };
      if (!fits({ ...pos, w: cw, h: ch })) pos = { x: clampX((W - cw) / 2), y: clampY(H * 0.18) };
    }
    card.style.left = Math.round(pos.x) + "px"; card.style.top = Math.round(pos.y) + "px";
  }

  const onKey = (e) => {
    if (e.target?.closest?.("input, textarea, [contenteditable]")) return;
    if (e.key === "Escape") { end(true); }
    else if (e.key === "ArrowRight" || (e.key === "Enter" && !e.target?.closest?.("button"))) { i === steps.length - 1 ? end(true) : show(i + 1); }
    else if (e.key === "ArrowLeft") { show(i - 1); }
    else return;
    e.preventDefault(); e.stopPropagation();
  };
  win.addEventListener("keydown", onKey, true);

  function end(finished) {
    if (ended) return; ended = true; active = null;
    win.cancelAnimationFrame(raf); win.removeEventListener("keydown", onKey, true);
    for (const el of [shade, ring, card]) { el.classList.remove("on"); win.setTimeout(() => el.remove(), 260); }
    onEnd?.(finished);
  }
  active = { end };
  show(0); frame();
  return active;
}
export const tourRunning = () => !!active;
