// Cockpit window frame as a sharp SVG overlay, modelled on the intro video's window: a wide opening
// with 45° corner cuts (deeper at the top), a raised centre step on the top and bottom edges, a slim
// gunmetal frame with a brushed-steel lip and one bright edge line, faint glass, corner HUD text and a
// slim console strip below. The intro can draw it at the video window's exact position (`setOpening`).

const NS = "http://www.w3.org/2000/svg";

// Final layout for a viewport, or the same shape fitted to a given opening {x0, y0, x1, y1}.
export function frameMetrics(W, H, open = null) {
  const phone = W < 640;
  const metal = phone ? 6 : 13, lip = phone ? 2 : 3;     // frame metal + bright lip
  const strip = phone ? 24 : 28;                          // console strip height
  const x0 = open ? open.x0 : metal + lip, x1 = open ? open.x1 : W - metal - lip;
  const y0 = open ? open.y0 : metal + lip, y1 = open ? open.y1 : H - strip - metal - lip - (phone ? 4 : 6);
  const scale = (x1 - x0) / Math.max(1, W - 2 * (metal + lip));
  const ct = Math.round((phone ? 10 : Math.min(56, Math.max(28, (W - 2 * (metal + lip)) * 0.032))) * scale); // top corner cut
  const cb = Math.round(ct * 0.6);                                                                            // bottom corner cut
  const lift = Math.max(2, Math.round((phone ? 3 : 5) * scale));                                              // centre steps
  const nx0 = Math.round(x0 + (x1 - x0) * 0.36), nx1 = Math.round(x0 + (x1 - x0) * 0.64);
  const sy = y1 + Math.round((metal + lip) * scale) + 4;
  const st = { x: x0 + cb, y: sy, w: x1 - x0 - 2 * cb, h: Math.max(10, Math.round(strip * Math.min(1, scale))) };
  return { phone, metal: metal * Math.min(1.6, scale), lip, side: metal + lip, x0, x1, y0, y1, ct, cb, lift, nx0, nx1, W, H, strip: st };
}

// Opening polygon grown outward by d pixels (d < 0 shrinks it).
export function openingPts(m, d = 0) {
  const { x0, x1, y0, y1, ct, cb, lift, nx0, nx1 } = m;
  const k = d * 0.4142; // keeps 45° cuts parallel when offset
  const yT = y0 + lift - d, yN = y0 - d, yB = y1 + d, yBN = y1 - lift + d;
  return [
    [x0 - d, yT + ct - k], [x0 + ct - lift - k, yT],
    [nx0 - lift, yT], [nx0, yN], [nx1, yN], [nx1 + lift, yT],
    [x1 - ct + lift + k, yT], [x1 + d, yT + ct - k],
    [x1 + d, yB - cb + k], [x1 - cb + k, yB],
    [nx1 + lift, yB], [nx1, yBN], [nx0, yBN], [nx0 - lift, yB],
    [x0 + cb - k, yB], [x0 - d, yB - cb + k],
  ];
}
const P = (pts) => "M" + pts.map((p) => p[0].toFixed(2) + " " + p[1].toFixed(2)).join("L") + "Z";

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

export function createFrame(host) {
  const svg = el("svg", { "aria-hidden": "true", "shape-rendering": "geometricPrecision" });
  Object.assign(svg.style, { position: "fixed", inset: "0", width: "100vw", height: "100%", pointerEvents: "none", zIndex: "2" });
  host.appendChild(svg);
  const style = document.createElement("style");
  style.textContent = `
    @keyframes obs-sweep { 0%, 92% { stroke-dashoffset: var(--len); } 100% { stroke-dashoffset: 0; } }
    .obs-sweep { animation: obs-sweep 30s linear infinite; }
    @media (prefers-reduced-motion: reduce) { .obs-sweep { animation: none; opacity: 0; } }
    .obs-alert { opacity: 0; transition: opacity .45s; }
    svg.alert-critical .obs-alert { stroke: #ff3a2a; opacity: .9; animation: obs-ap 1.6s ease-in-out infinite; }
    svg.alert-warning .obs-alert { stroke: #ffae3a; opacity: .75; }
    @keyframes obs-ap { 50% { opacity: .35; } }
    .obs-hud { font: 300 9px "JetBrains Mono", ui-monospace, Menlo, monospace; fill: rgba(196,232,246,0.62); letter-spacing: .04em; transition: opacity .3s; }`;
  document.head.appendChild(style);
  let built = null, override = null, hudAlpha = 1;

  function build(W, H, light) {
    svg.innerHTML = "";
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const m = frameMetrics(W, H, override);
    const defs = el("defs", {}, svg);
    // Fine brushed streaks at very low contrast.
    const pat = el("pattern", { id: "obs-brush", width: 200, height: 2, patternUnits: "userSpaceOnUse" }, defs);
    for (let i = 0; i < 7; i++) el("rect", { x: (i * 47) % 200, y: i % 2, width: 20 + (i * 31) % 60, height: 0.5, fill: "rgba(255,255,255,0.03)" }, pat);
    const lx = 0.5 - light[0] * 0.5, ly = 0.5 - light[1] * 0.5;
    // Clean metal: one lit side, one shadow side, few mid greys.
    const body = el("linearGradient", { id: "obs-body", x1: lx, y1: ly, x2: 1 - lx, y2: 1 - ly }, defs);
    el("stop", { offset: 0, "stop-color": "#4a5057" }, body); el("stop", { offset: 0.5, "stop-color": "#2a2e33" }, body); el("stop", { offset: 1, "stop-color": "#17191c" }, body);
    const lipG = el("linearGradient", { id: "obs-lip", x1: lx, y1: ly, x2: 1 - lx, y2: 1 - ly }, defs);
    el("stop", { offset: 0, "stop-color": "#c3cad1" }, lipG); el("stop", { offset: 1, "stop-color": "#5f666d" }, lipG);
    const glassG = el("linearGradient", { id: "obs-glass", x1: 0, y1: 0, x2: 1, y2: 1 }, defs);
    el("stop", { offset: 0.2, "stop-color": "rgba(255,255,255,0)" }, glassG); el("stop", { offset: 0.27, "stop-color": "rgba(210,230,245,0.03)" }, glassG); el("stop", { offset: 0.34, "stop-color": "rgba(255,255,255,0)" }, glassG);
    const edgeG = el("radialGradient", { id: "obs-edge", cx: 0.5, cy: 0.5, r: 0.75 }, defs);
    el("stop", { offset: 0.75, "stop-color": "rgba(0,0,0,0)" }, edgeG); el("stop", { offset: 1, "stop-color": "rgba(0,0,0,0.35)" }, edgeG);
    const clipO = el("clipPath", { id: "obs-open" }, defs); el("path", { d: P(openingPts(m, 0)) }, clipO);

    const lip = m.lip, metal = m.metal, st = m.strip;
    const outer = `M-2 -2H${W + 2}V${H + 2}H-2Z` + `M${st.x} ${st.y}V${st.y + st.h}H${st.x + st.w}V${st.y}Z`;
    // 1. Gunmetal body.
    el("path", { d: outer + P(openingPts(m, lip)), fill: "url(#obs-body)", "fill-rule": "evenodd" }, svg);
    el("path", { d: outer + P(openingPts(m, lip)), fill: "url(#obs-brush)", "fill-rule": "evenodd" }, svg);
    // Bevel step: a crisp 1 px dark groove where the body meets the lip, one step out.
    el("path", { d: P(openingPts(m, lip + metal * 0.45)), fill: "none", stroke: "rgba(0,0,0,0.55)", "stroke-width": 1 }, svg);
    el("path", { d: P(openingPts(m, lip + metal * 0.45 + 1)), fill: "none", stroke: "rgba(255,255,255,0.06)", "stroke-width": 1 }, svg);
    // 2. Brushed-steel lip.
    el("path", { d: P(openingPts(m, lip)) + P(openingPts(m, 0)), fill: "url(#obs-lip)", "fill-rule": "evenodd" }, svg);
    // 3. Edge line at the glass: bright on the lit side, dark on the far side, same 1 px weight everywhere.
    const pts = openingPts(m, 0.5);
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const nx = (b[1] - a[1]) / L, ny = -(b[0] - a[0]) / L;
      const f = -(nx * light[0] + ny * light[1]);
      el("line", { x1: a[0], y1: a[1], x2: b[0], y2: b[1], "stroke-width": 1, "stroke-linecap": "square", stroke: f > 0.05 ? `rgba(240,246,250,${0.35 + f * 0.6})` : `rgba(0,0,0,${0.55 + Math.max(0, -f) * 0.35})` }, svg);
    }
    const len = pts.reduce((acc, p, i) => acc + Math.hypot(pts[(i + 1) % pts.length][0] - p[0], pts[(i + 1) % pts.length][1] - p[1]), 0);
    const sweep = el("path", { d: P(pts), fill: "none", stroke: "rgba(245,250,255,0.6)", "stroke-width": 1, "stroke-dasharray": `80 ${len}`, class: "obs-sweep" }, svg);
    sweep.style.setProperty("--len", String(len + 80));
    el("path", { d: P(openingPts(m, 0.5)), fill: "none", "stroke-width": 1.5, class: "obs-alert" }, svg);
    el("path", { d: P(openingPts(m, lip + 0.5)), fill: "none", "stroke-width": 1, class: "obs-alert" }, svg);
    // Outer edge of the frame against the screen edge: one thin highlight line on top.
    el("line", { x1: 0, y1: 0.5, x2: W, y2: 0.5, stroke: "rgba(255,255,255,0.08)", "stroke-width": 1 }, svg);
    // 4. Glass: faint reflection band and slightly darker edges (no blur).
    const g = el("g", { "clip-path": "url(#obs-open)" }, svg);
    el("rect", { width: W, height: H, fill: "url(#obs-glass)" }, g);
    el("rect", { x: m.x0, y: m.y0, width: m.x1 - m.x0, height: m.y1 - m.y0, fill: "url(#obs-edge)" }, g);
    // 5. Console strip.
    el("rect", { x: st.x + 0.5, y: st.y + 0.5, width: st.w - 1, height: st.h - 1, fill: "none", stroke: "rgba(255,255,255,0.08)" }, svg);
    for (const [fx, col] of [[0.012, "#3fa36a"], [0.024, "#c8a046"], [0.976, "#5aa7c8"], [0.988, "#3fa36a"]]) el("circle", { cx: st.x + st.w * fx + (fx < 0.5 ? 5 : -5), cy: st.y + st.h / 2, r: m.phone ? 1.3 : 1.6, fill: col, opacity: 0.75 }, svg);
    // 6. HUD readouts in the four inner corners.
    const hud = el("g", { class: "obs-hud", opacity: hudAlpha }, svg);
    const pad = m.phone ? 8 : 12;
    const corner = (x, y, anchor, lines) => {
      const gg = el("g", {}, hud);
      lines.forEach((t, i) => { const tx = el("text", { x, y: y + i * 11, "text-anchor": anchor }, gg); tx.textContent = t; });
      const rx = anchor === "end" ? x - 90 : x;
      el("line", { x1: rx, y1: y + lines.length * 11 - 6, x2: rx + 90, y2: y + lines.length * 11 - 6, stroke: "rgba(196,232,246,0.3)", "stroke-width": 0.6 }, gg);
      return gg;
    };
    const hudEls = m.phone ? null : {
      tl: corner(m.x0 + m.ct + pad, m.y0 + m.lift + 14, "start", ["", ""]),
      tr: corner(m.x1 - m.ct - pad, m.y0 + m.lift + 14, "end", ["", ""]),
      bl: corner(m.x0 + m.cb + pad, m.y1 - 22, "start", ["", ""]),
      br: corner(m.x1 - m.cb - pad, m.y1 - 22, "end", ["", ""]),
    };
    built = { W, H, m, light, hudEls, hud, open: override };
  }
  let lastHud = null;
  function fillHud(hudText) {
    if (built?.hudEls && hudText) for (const [k, lines] of Object.entries(hudText)) {
      const texts = built.hudEls[k]?.querySelectorAll("text");
      if (texts) lines.forEach((t, i) => { if (texts[i] && texts[i].textContent !== t) texts[i].textContent = t; });
    }
  }

  return {
    metrics: () => built?.m,
    update(W, H, light, hudText) {
      if (hudText) lastHud = hudText;
      const changed = !built || built.W !== W || built.H !== H || built.open !== override || Math.abs(built.light[0] - light[0]) + Math.abs(built.light[1] - light[1]) > 0.12;
      if (changed) build(W, H, light);
      fillHud(lastHud);
    },
    // Intro: draw the frame around a given opening (screen px), or null for the normal layout.
    setOpening(open, W, H) {
      override = open;
      build(W, H, built?.light ?? [0.7, 0.7]);
      fillHud(lastHud);
    },
    setHudAlpha(a) { hudAlpha = a; built?.hud?.setAttribute("opacity", a); },
    setOpacity(a) { svg.style.opacity = String(a); },
    setZ(z) { svg.style.zIndex = String(z); },
    setAlert(level) { svg.classList.toggle("alert-critical", level === "critical"); svg.classList.toggle("alert-warning", level === "warning"); },
    setVisible(v) { svg.style.display = v ? "" : "none"; },
  };
}
