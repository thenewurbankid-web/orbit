// Cockpit window frame as a sharp SVG overlay, modelled on the intro video's window: a wide opening
// with 45° corner cuts (deeper at the top), a raised centre step on the top and bottom edges, a slim
// gunmetal frame with a brushed-steel lip and one bright edge line, faint glass, corner HUD text and a
// slim console strip below. The intro can draw it at the video window's exact position (`setOpening`).

const NS = "http://www.w3.org/2000/svg";

// Safe-area insets (notch, home indicator) from CSS env(), read through a hidden probe element.
let safeProbe = null;
export function safeInsets() {
  if (typeof document === "undefined" || !document.body) return { t: 0, r: 0, b: 0, l: 0 };
  if (!safeProbe) {
    safeProbe = document.createElement("div");
    safeProbe.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)";
    document.body.appendChild(safeProbe);
  }
  const cs = getComputedStyle(safeProbe), n = (v) => parseFloat(v) || 0;
  return { t: n(cs.paddingTop), r: n(cs.paddingRight), b: n(cs.paddingBottom), l: n(cs.paddingLeft) };
}

// Final layout for a viewport, or the same shape fitted to a given opening {x0, y0, x1, y1}.
// compact: the small floating (picture-in-picture) window: a slimmer frame and a minimal strip, no corner HUD.
export function frameMetrics(W, H, open = null, compact = false) {
  const phone = W < 640 && !compact;
  const sa = open || compact ? { t: 0, r: 0, b: 0, l: 0 } : safeInsets();
  const metal = compact ? 4 : phone ? 4 : 8, lip = compact || phone ? 1.5 : 2;    // a slim machined bezel (≈35 % thinner than before)
  const strip = compact ? 18 : phone ? 26 : 22;                          // console strip height (phones: still a comfortable touch target)
  const x0 = open ? open.x0 : metal + lip + sa.l, x1 = open ? open.x1 : W - metal - lip - sa.r;
  const y0 = open ? open.y0 : metal + lip + sa.t, y1 = open ? open.y1 : H - strip - metal - lip - (phone || compact ? 3 : 4) - sa.b;
  const scale = (x1 - x0) / Math.max(1, W - 2 * (metal + lip));
  const ct = Math.round((phone ? 8 : compact ? Math.min(14, Math.max(8, W * 0.02)) : Math.min(38, Math.max(20, (W - 2 * (metal + lip)) * 0.022))) * scale); // top corner cut
  const cb = Math.round(ct * 0.6);                                                                            // bottom corner cut
  const lift = Math.max(1.5, Math.round((phone || compact ? 2 : 3) * scale));                                              // centre steps
  const nx0 = Math.round(x0 + (x1 - x0) * 0.36), nx1 = Math.round(x0 + (x1 - x0) * 0.64);
  const sy = y1 + Math.round((metal + lip) * scale) + 3;
  const st = { x: x0 + cb, y: sy, w: x1 - x0 - 2 * cb, h: Math.max(10, Math.round(strip * Math.min(1, scale))) };
  return { phone, compact, metal: metal * Math.min(1.6, scale), lip, side: metal + lip, x0, x1, y0, y1, ct, cb, lift, nx0, nx1, W, H, strip: st };
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
const P = (pts, r = 7) => {
  // Every vertex is filleted (a quadratic through the corner, radius capped by the adjacent edges), so the
  // outline is one smooth, continuous curve: no hard corners, crisp at any pixel ratio.
  const n = pts.length, f = (v) => v.toFixed(2);
  const cut = pts.map((p, i) => {
    const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    const la = Math.hypot(p[0] - a[0], p[1] - a[1]) || 1, lb = Math.hypot(b[0] - p[0], b[1] - p[1]) || 1;
    const k = Math.min(r, la * 0.45, lb * 0.45);
    return [[p[0] + (a[0] - p[0]) * k / la, p[1] + (a[1] - p[1]) * k / la], p, [p[0] + (b[0] - p[0]) * k / lb, p[1] + (b[1] - p[1]) * k / lb]];
  });
  let d = `M${f(cut[0][2][0])} ${f(cut[0][2][1])}`;
  for (let i = 1; i <= n; i++) { const c = cut[i % n]; d += `L${f(c[0][0])} ${f(c[0][1])}Q${f(c[1][0])} ${f(c[1][1])} ${f(c[2][0])} ${f(c[2][1])}`; }
  return d + "Z";
};

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

export function createFrame(host) {
  let glassGrad = null, specGrad = null, glare = { x: 0, y: 0 };
  // Slide the glass gloss with device tilt or pointer (-1..1 each), so it reads as a real reflection.
  function applyGlare() {
    if (glassGrad) glassGrad.setAttribute("gradientTransform", `translate(${(glare.x * 0.04).toFixed(3)} ${(glare.y * 0.03).toFixed(3)})`);
    if (specGrad) specGrad.setAttribute("gradientTransform", `translate(${(glare.x * 0.06).toFixed(3)} ${(glare.y * 0.05).toFixed(3)})`);
  }
  const svg = el("svg", { "aria-hidden": "true", "shape-rendering": "geometricPrecision", "data-float": "" });
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
  let built = null, override = null, hudAlpha = 1, compact = false;

  function build(W, H, light) {
    svg.innerHTML = "";
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const m = frameMetrics(W, H, override, compact);
    const defs = el("defs", {}, svg);
    const lx = 0.5 - light[0] * 0.5, ly = 0.5 - light[1] * 0.5;
    // Dark gunmetal body: one lit side, one shadow side.
    const body = el("linearGradient", { id: "obs-body", x1: lx, y1: ly, x2: 1 - lx, y2: 1 - ly }, defs);
    el("stop", { offset: 0, "stop-color": "#23262a" }, body); el("stop", { offset: 0.5, "stop-color": "#1b1e21" }, body); el("stop", { offset: 1, "stop-color": "#131517" }, body);
    // Soft bevel: one continuous gradient across the whole ring (no per-edge facets), lit toward the light,
    // falling into shadow on the far side; it reads as a rounded, machined surface.
    const bev = el("linearGradient", { id: "obs-bevel", x1: lx, y1: ly, x2: 1 - lx, y2: 1 - ly }, defs);
    el("stop", { offset: 0, "stop-color": "rgba(200,210,220,0.10)" }, bev); el("stop", { offset: 0.45, "stop-color": "rgba(120,128,136,0.03)" }, bev); el("stop", { offset: 1, "stop-color": "rgba(0,0,0,0.38)" }, bev);
    // Chamfered inner edge (the lip): brighter, finer steel.
    const lipG = el("linearGradient", { id: "obs-lip", x1: lx, y1: ly, x2: 1 - lx, y2: 1 - ly }, defs);
    el("stop", { offset: 0, "stop-color": "#646a72" }, lipG); el("stop", { offset: 0.5, "stop-color": "#41464c" }, lipG); el("stop", { offset: 1, "stop-color": "#2a2e33" }, lipG);
    // A very fine specular line along the inner edge; its hot spot slides with the glare (tilt / pointer).
    const spec = el("linearGradient", { id: "obs-spec", x1: 0, y1: 0, x2: 1, y2: 1 }, defs);
    el("stop", { offset: 0, "stop-color": "rgba(235,242,250,0.55)" }, spec); el("stop", { offset: 0.3, "stop-color": "rgba(235,242,250,0.12)" }, spec); el("stop", { offset: 0.7, "stop-color": "rgba(0,0,0,0.45)" }, spec); el("stop", { offset: 1, "stop-color": "rgba(0,0,0,0.6)" }, spec);
    specGrad = spec;
    // Glass gloss: one soft highlight in the top-left corner only, very subtle; it drifts a little with tilt.
    const glassG = el("radialGradient", { id: "obs-glass", cx: 0.06, cy: 0.02, r: 0.42, gradientUnits: "objectBoundingBox" }, defs);
    el("stop", { offset: 0, "stop-color": "rgba(225,240,252,0.045)" }, glassG); el("stop", { offset: 0.45, "stop-color": "rgba(225,240,252,0.015)" }, glassG); el("stop", { offset: 1, "stop-color": "rgba(255,255,255,0)" }, glassG);
    glassGrad = glassG; applyGlare();
    const edgeG = el("radialGradient", { id: "obs-edge", cx: 0.5, cy: 0.5, r: 0.75 }, defs);
    el("stop", { offset: 0.75, "stop-color": "rgba(0,0,0,0)" }, edgeG); el("stop", { offset: 1, "stop-color": "rgba(0,0,0,0.35)" }, edgeG);
    const clipO = el("clipPath", { id: "obs-open" }, defs); el("path", { d: P(openingPts(m, 0)) }, clipO);
    // Real brushed steel (ambientCG Metal011, CC0), finer and fainter than before; it also dithers the gradients.
    const T = m.phone || m.compact ? 128 : 192;
    const pat = el("pattern", { id: "obs-steel", width: T, height: T, patternUnits: "userSpaceOnUse" }, defs);
    el("image", { href: `assets/fx/steel${m.phone || m.compact ? "-sm" : ""}.jpg`, width: T, height: T, preserveAspectRatio: "none" }, pat);

    const lip = m.lip, metal = m.metal, st = m.strip;
    const outer = `M-2 -2H${W + 2}V${H + 2}H-2Z` + P([[st.x, st.y], [st.x + st.w, st.y], [st.x + st.w, st.y + st.h], [st.x, st.y + st.h]], 5);
    // 1. Gunmetal body, finely brushed.
    el("path", { d: outer + P(openingPts(m, lip)), fill: "url(#obs-body)", "fill-rule": "evenodd" }, svg);
    el("path", { d: outer + P(openingPts(m, lip)), fill: "url(#obs-steel)", "fill-rule": "evenodd", opacity: 0.2, style: "mix-blend-mode:soft-light" }, svg);
    // 2. Soft bevel from the body down to the lip (continuous, smooth curvature).
    for (const [d, o] of [[0.75, 0.35], [0.5, 0.6], [0.25, 1]]) el("path", { d: P(openingPts(m, lip + metal * d)) + P(openingPts(m, lip)), fill: "url(#obs-bevel)", "fill-rule": "evenodd", opacity: o }, svg);
    // 3. The chamfered lip and its fine specular edge.
    el("path", { d: P(openingPts(m, lip)) + P(openingPts(m, 0)), fill: "url(#obs-lip)", "fill-rule": "evenodd" }, svg);
    el("path", { d: P(openingPts(m, lip)) + P(openingPts(m, 0)), fill: "url(#obs-steel)", "fill-rule": "evenodd", opacity: 0.3, style: "mix-blend-mode:soft-light" }, svg);
    el("path", { d: P(openingPts(m, 0.5)), fill: "none", stroke: "url(#obs-spec)", "stroke-width": 0.75 }, svg);
    el("path", { d: P(openingPts(m, lip + 0.4)), fill: "none", stroke: "rgba(0,0,0,0.45)", "stroke-width": 0.6 }, svg);
    const pts = openingPts(m, 0.5);
    const len = pts.reduce((acc, p, i) => acc + Math.hypot(pts[(i + 1) % pts.length][0] - p[0], pts[(i + 1) % pts.length][1] - p[1]), 0);
    const sweep = el("path", { d: P(pts), fill: "none", stroke: "rgba(245,250,255,0.18)", "stroke-width": 0.75, "stroke-dasharray": `80 ${len}`, class: "obs-sweep" }, svg);
    sweep.style.setProperty("--len", String(len + 80));
    el("path", { d: P(openingPts(m, 0.5)), fill: "none", "stroke-width": 1.5, class: "obs-alert" }, svg);
    el("path", { d: P(openingPts(m, lip + 0.5)), fill: "none", "stroke-width": 1, class: "obs-alert" }, svg);
    // Outer edge of the frame against the screen edge: one thin highlight line on top.
    el("line", { x1: 0, y1: 0.5, x2: W, y2: 0.5, stroke: "rgba(255,255,255,0.03)", "stroke-width": 1 }, svg);
    // 4. Glass: faint reflection band and slightly darker edges (no blur).
    const g = el("g", { "clip-path": "url(#obs-open)" }, svg);
    el("rect", { width: W, height: H, fill: "url(#obs-glass)" }, g);
    el("rect", { x: m.x0, y: m.y0, width: m.x1 - m.x0, height: m.y1 - m.y0, fill: "url(#obs-edge)" }, g);
    // 5. Console strip.
    el("path", { d: P([[st.x + 0.5, st.y + 0.5], [st.x + st.w - 0.5, st.y + 0.5], [st.x + st.w - 0.5, st.y + st.h - 0.5], [st.x + 0.5, st.y + st.h - 0.5]], 5), fill: "none", stroke: "rgba(255,255,255,0.07)", "stroke-width": 0.75 }, svg);
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
    const hudEls = m.phone || m.compact ? null : {
      tl: corner(m.x0 + m.ct + pad, m.y0 + m.lift + 14, "start", ["", ""]),
      tr: corner(m.x1 - m.ct - pad, m.y0 + m.lift + 14, "end", ["", ""]),
      bl: corner(m.x0 + m.cb + pad, m.y1 - 22, "start", ["", ""]),
      br: corner(m.x1 - m.cb - pad, m.y1 - 22, "end", ["", ""]),
    };
    built = { W, H, m, light, hudEls, hud, open: override, compact };
  }
  let lastHud = null;
  function fillHud(hudText) {
    if (built?.hudEls && hudText) for (const [k, lines] of Object.entries(hudText)) {
      const texts = built.hudEls[k]?.querySelectorAll("text");
      if (texts) lines.forEach((t, i) => { if (texts[i] && texts[i].textContent !== t) texts[i].textContent = t; });
    }
  }

  return {
    setGlare(x, y) { if (Math.abs(x - glare.x) + Math.abs(y - glare.y) < 0.004) return; glare = { x, y }; applyGlare(); },
    metrics: () => built?.m,
    update(W, H, light, hudText) {
      if (hudText) lastHud = hudText;
      const changed = !built || built.W !== W || built.H !== H || built.open !== override || built.compact !== compact || Math.abs(built.light[0] - light[0]) + Math.abs(built.light[1] - light[1]) > 0.12;
      if (changed) build(W, H, light);
      fillHud(lastHud);
    },
    // Intro: draw the frame around a given opening (screen px), or null for the normal layout.
    setOpening(open, W, H) {
      override = open;
      build(W, H, built?.light ?? [0.7, 0.7]);
      fillHud(lastHud);
    },
    setCompact(c) { compact = !!c; },
    element: svg,
    setHudAlpha(a) { hudAlpha = a; built?.hud?.setAttribute("opacity", a); },
    setOpacity(a) { svg.style.opacity = String(a); },
    setZ(z) { svg.style.zIndex = String(z); },
    setAlert(level) { svg.classList.toggle("alert-critical", level === "critical"); svg.classList.toggle("alert-warning", level === "warning"); },
    setVisible(v) { svg.style.display = v ? "" : "none"; },
  };
}
