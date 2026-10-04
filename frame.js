// Cockpit window frame as a sharp SVG overlay, modelled on the intro video's window: a wide opening
// with 45° corner cuts (deeper at the top), a raised centre section on the top edge, a stepped
// gunmetal frame with a brushed-steel inner lip and a bright edge line, faint glass, corner HUD text
// and a thin console strip below. The scene uses `opening()` to place the KPIs, readouts and controls.

const NS = "http://www.w3.org/2000/svg";

export function frameMetrics(W, H) {
  const phone = W < 640;
  const side = phone ? 12 : Math.round(Math.min(46, Math.max(28, W * 0.028)));
  const top = phone ? 14 : Math.round(side * 1.05);
  const bottom = phone ? 42 : Math.round(side + 30); // console strip under the window
  const x0 = side, x1 = W - side, y0 = top, y1 = H - bottom;
  const ct = phone ? 16 : Math.round(Math.min(110, Math.max(46, (x1 - x0) * 0.055))); // top corner cut
  const cb = Math.round(ct * 0.55);                                                    // bottom corner cut
  const lift = phone ? 4 : 9;                                                          // raised centre of the top edge
  const nx0 = Math.round(x0 + (x1 - x0) * 0.31), nx1 = Math.round(x0 + (x1 - x0) * 0.69);
  // Console strip under the window: a hole in the frame where the control strip (drawn by the scene) shows.
  const t12 = phone ? 6 : 13;
  const sy = y1 + t12 + (phone ? 6 : 8), strip = { x: x0 + Math.round(ct * 0.55), y: sy, w: x1 - x0 - 2 * Math.round(ct * 0.55), h: H - sy - (phone ? 4 : 6) };
  return { phone, side, top, bottom, x0, x1, y0, y1, ct, cb, lift, nx0, nx1, W, H, strip };
}

// Opening polygon grown outward by d pixels (d < 0 shrinks it).
export function openingPts(m, d = 0) {
  const { x0, x1, y0, y1, ct, cb, lift, nx0, nx1 } = m;
  const k = d * 0.4142; // keeps 45° cuts parallel when offset
  const yT = y0 + lift - d, yN = y0 - d;
  return [
    [x0 - d, yT + ct - k], [x0 + ct - lift - k, yT],
    [nx0 - lift, yT], [nx0, yN], [nx1, yN], [nx1 + lift, yT],
    [x1 - ct + lift + k, yT], [x1 + d, yT + ct - k],
    [x1 + d, y1 + d - cb + k], [x1 - cb + k, y1 + d],
    [x0 + cb - k, y1 + d], [x0 - d, y1 + d - cb + k],
  ];
}
const P = (pts) => "M" + pts.map((p) => p[0].toFixed(1) + " " + p[1].toFixed(1)).join("L") + "Z";

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

export function createFrame(host) {
  const svg = el("svg", { "aria-hidden": "true" });
  Object.assign(svg.style, { position: "fixed", inset: "0", width: "100vw", height: "100%", pointerEvents: "none", zIndex: "2" });
  host.appendChild(svg);
  const style = document.createElement("style");
  style.textContent = `
    @keyframes obs-sweep { 0%, 92% { stroke-dashoffset: var(--len); } 100% { stroke-dashoffset: 0; } }
    .obs-sweep { animation: obs-sweep 30s linear infinite; }
    @media (prefers-reduced-motion: reduce) { .obs-sweep { animation: none; opacity: 0; } }
    .obs-hud { font: 300 9px "JetBrains Mono", ui-monospace, Menlo, monospace; fill: rgba(196,232,246,0.62); letter-spacing: .04em; }`;
  document.head.appendChild(style);
  let built = null;

  function build(W, H, light) {
    svg.innerHTML = "";
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const m = frameMetrics(W, H);
    const defs = el("defs", {}, svg);
    // Brushed streaks: fine horizontal lines at low contrast.
    const pat = el("pattern", { id: "obs-brush", width: 240, height: 3, patternUnits: "userSpaceOnUse" }, defs);
    el("rect", { width: 240, height: 3, fill: "transparent" }, pat);
    for (let i = 0; i < 9; i++) el("rect", { x: (i * 53) % 240, y: (i % 3), width: 18 + (i * 29) % 70, height: 0.6, fill: "rgba(255,255,255,0.035)" }, pat);
    const lx = 0.5 - light[0] * 0.5, ly = 0.5 - light[1] * 0.5; // gradient runs from the lit side
    const body = el("linearGradient", { id: "obs-body", x1: lx, y1: ly, x2: 1 - lx, y2: 1 - ly }, defs);
    el("stop", { offset: 0, "stop-color": "#3b4046" }, body); el("stop", { offset: 0.45, "stop-color": "#22262a" }, body); el("stop", { offset: 1, "stop-color": "#131517" }, body);
    const lip = el("linearGradient", { id: "obs-lip", x1: lx, y1: ly, x2: 1 - lx, y2: 1 - ly }, defs);
    el("stop", { offset: 0, "stop-color": "#9aa2aa" }, lip); el("stop", { offset: 0.5, "stop-color": "#5d646b" }, lip); el("stop", { offset: 1, "stop-color": "#3a3f44" }, lip);
    const glassG = el("linearGradient", { id: "obs-glass", x1: 0, y1: 0, x2: 1, y2: 1 }, defs);
    el("stop", { offset: 0.18, "stop-color": "rgba(255,255,255,0)" }, glassG); el("stop", { offset: 0.26, "stop-color": "rgba(210,230,245,0.035)" }, glassG); el("stop", { offset: 0.34, "stop-color": "rgba(255,255,255,0)" }, glassG);
    const blur = el("filter", { id: "obs-ao", x: "-10%", y: "-10%", width: "120%", height: "120%" }, defs);
    el("feGaussianBlur", { stdDeviation: m.phone ? 2 : 4 }, blur);
    const clipO = el("clipPath", { id: "obs-open" }, defs); el("path", { d: P(openingPts(m, 0)) }, clipO);

    const t1 = m.phone ? 4 : 9, t2 = m.phone ? 2 : 4; // bevel widths: body step, steel lip
    const st = m.strip;
    const outer = `M0 0H${W}V${H}H0Z` + `M${st.x} ${st.y}V${st.y + st.h}H${st.x + st.w}V${st.y}Z`;
    // 1. Outer gunmetal body (everything outside the opening + lip).
    el("path", { d: outer + P(openingPts(m, t1 + t2)), fill: "url(#obs-body)", "fill-rule": "evenodd" }, svg);
    el("path", { d: outer + P(openingPts(m, t1 + t2)), fill: "url(#obs-brush)", "fill-rule": "evenodd" }, svg);
    // Panel seams on the body.
    const seam = "rgba(0,0,0,0.55)", seamHi = "rgba(255,255,255,0.05)";
    for (const [ax, ay, bx, by] of [[m.x0 * 0.5, m.y0 + m.ct + 40, m.x0 * 0.5, m.y1 - 60], [W - m.x0 * 0.5, m.y0 + m.ct + 40, W - m.x0 * 0.5, m.y1 - 60], [m.nx0, 2, m.nx0, m.y0 - t1 - t2 - 3], [m.nx1, 2, m.nx1, m.y0 - t1 - t2 - 3]]) {
      el("line", { x1: ax, y1: ay, x2: bx, y2: by, stroke: seam, "stroke-width": 1 }, svg);
      el("line", { x1: ax + 1, y1: ay, x2: bx + 1, y2: by, stroke: seamHi, "stroke-width": 1 }, svg);
    }
    // 2. Step between body and lip, with ambient occlusion.
    el("path", { d: P(openingPts(m, t1 + t2)) + P(openingPts(m, t2)), fill: "#2b3035", "fill-rule": "evenodd" }, svg);
    el("path", { d: P(openingPts(m, t1 + t2 - 1)), fill: "none", stroke: "rgba(0,0,0,0.7)", "stroke-width": 3, filter: "url(#obs-ao)" }, svg);
    // 3. Brushed-steel inner lip.
    el("path", { d: P(openingPts(m, t2)) + P(openingPts(m, 0)), fill: "url(#obs-lip)", "fill-rule": "evenodd" }, svg);
    el("path", { d: P(openingPts(m, t2)) + P(openingPts(m, 0)), fill: "url(#obs-brush)", "fill-rule": "evenodd" }, svg);
    // 4. Bright edge line at the glass, lit per segment from the light direction; dark on the far side.
    const pts = openingPts(m, 0.5);
    const segs = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const nx = (b[1] - a[1]) / L, ny = -(b[0] - a[0]) / L; // normal pointing into the opening (clockwise)
      const f = -(nx * light[0] + ny * light[1]);              // faces the light → bright
      segs.push(el("line", { x1: a[0], y1: a[1], x2: b[0], y2: b[1], "stroke-width": 1, stroke: f > 0 ? `rgba(235,242,248,${0.25 + f * 0.6})` : `rgba(0,0,0,${0.4 - f * 0.4})` }, svg));
    }
    // Slow light sweep along the edge.
    const len = pts.reduce((acc, p, i) => acc + Math.hypot(pts[(i + 1) % pts.length][0] - p[0], pts[(i + 1) % pts.length][1] - p[1]), 0);
    const sweep = el("path", { d: P(pts), fill: "none", stroke: "rgba(240,246,252,0.65)", "stroke-width": 1.2, "stroke-dasharray": `90 ${len}`, class: "obs-sweep" }, svg);
    sweep.style.setProperty("--len", String(len + 90));
    // 5. Glass: a faint reflection band and darker edges.
    const g = el("g", { "clip-path": "url(#obs-open)" }, svg);
    el("rect", { width: W, height: H, fill: "url(#obs-glass)" }, g);
    el("path", { d: P(openingPts(m, 0)), fill: "none", stroke: "rgba(0,0,0,0.6)", "stroke-width": m.phone ? 10 : 26, filter: "url(#obs-ao)" }, g);
    // 6. Console strip below the window, with a few tiny indicator lights.
    el("rect", { x: st.x + 0.5, y: st.y + 0.5, width: st.w - 1, height: st.h - 1, rx: 2, fill: "none", stroke: "rgba(255,255,255,0.07)" }, svg);
    el("line", { x1: st.x, y1: st.y + 0.5, x2: st.x + st.w, y2: st.y + 0.5, stroke: "rgba(0,0,0,0.8)" }, svg);
    for (const [fx, col] of [[0.012, "#3fa36a"], [0.024, "#c8a046"], [0.976, "#5aa7c8"], [0.988, "#3fa36a"]]) el("circle", { cx: st.x + st.w * fx + (fx < 0.5 ? 6 : -6), cy: st.y + st.h / 2, r: m.phone ? 1.4 : 1.8, fill: col, opacity: 0.75 }, svg);
    // 7. HUD readouts in the four inner corners.
    const hud = el("g", { class: "obs-hud" }, svg);
    const pad = m.phone ? 8 : 14;
    const corner = (x, y, anchor, lines) => {
      const gg = el("g", {}, hud);
      lines.forEach((t, i) => { const tx = el("text", { x, y: y + i * 11, "text-anchor": anchor }, gg); tx.textContent = t; });
      const rx = anchor === "end" ? x - 90 : x;
      el("line", { x1: rx, y1: y + lines.length * 11 - 6, x2: rx + 90, y2: y + lines.length * 11 - 6, stroke: "rgba(196,232,246,0.3)", "stroke-width": 0.6 }, gg);
      return gg;
    };
    const hudEls = m.phone ? null : {
      tl: corner(m.x0 + m.ct + pad, m.y0 + m.lift + 14, "start", ["OBS-01 · SYS 3", ""]),
      tr: corner(m.x1 - m.ct - pad, m.y0 + m.lift + 14, "end", ["OVERALL —", ""]),
      bl: corner(m.x0 + m.cb + pad, m.y1 - 22, "start", ["UPLINK · PAPERCLIP 3100", ""]),
      br: corner(m.x1 - m.cb - pad, m.y1 - 22, "end", ["AZ 0.0° · EL 0.0°", ""]),
    };
    built = { W, H, m, light, segs, hudEls };
  }

  return {
    metrics: () => built?.m,
    update(W, H, light, hudText) {
      const changed = !built || built.W !== W || built.H !== H || Math.abs(built.light[0] - light[0]) + Math.abs(built.light[1] - light[1]) > 0.12;
      if (changed) build(W, H, light);
      if (built.hudEls && hudText) for (const [k, lines] of Object.entries(hudText)) {
        const texts = built.hudEls[k]?.querySelectorAll("text");
        if (texts) lines.forEach((t, i) => { if (texts[i] && texts[i].textContent !== t) texts[i].textContent = t; });
      }
    },
    setVisible(v) { svg.style.display = v ? "" : "none"; },
  };
}
