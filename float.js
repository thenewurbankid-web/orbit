// Float: Orbit in a small always-on-top window (desktop only).
// Chrome/Edge: Document Picture-in-Picture. The live board (WebGL canvas, SVG frame, keyboard field, alert
// layers and any open frosted panel, all marked data-float) moves into the PiP window and stays interactive;
// closing it, or "bring back", moves everything home. Safari: a view-only video PiP of the canvas.
import { host, setHost, setVideoMode } from "./host.js";

export const FLOAT_TIP = "Float Orbit in a small window that stays on top";
export const FLOAT_TIP_VIDEO = FLOAT_TIP + " (view only in this browser)";
const SIZE_KEY = "orbitFloatSize";
const DEFAULT = { width: 420, height: 300 };

// "doc", "video" or null. Desktop only: phones and touch-only devices never get it.
export function floatSupport(win = window) {
  try {
    const fine = win.matchMedia("(hover: hover) and (pointer: fine)").matches;
    const phoneUA = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    if (!fine || phoneUA) return null;
    if ("documentPictureInPicture" in win) return "doc";
    const v = win.document.createElement("video");
    if (win.document.pictureInPictureEnabled && typeof v.requestPictureInPicture === "function" && typeof win.HTMLCanvasElement.prototype.captureStream === "function") return "video";
  } catch { /* no PiP */ }
  return null;
}

function savedSize() {
  try {
    const s = JSON.parse(localStorage.getItem(SIZE_KEY) || "null");
    if (s && s.width >= 200 && s.height >= 150 && s.width <= 4000 && s.height <= 3000) return { width: Math.round(s.width), height: Math.round(s.height) };
  } catch { /* storage blocked */ }
  return { ...DEFAULT };
}
function saveSize(w, h) { try { localStorage.setItem(SIZE_KEY, JSON.stringify({ width: w, height: h })); } catch { /* storage blocked */ } }

// Copy the page's stylesheets (inline styles, injected module styles, the web-font link) into the PiP document.
function copyStyles(from, to) {
  for (const n of from.head.querySelectorAll('style, link[rel="stylesheet"], link[rel="preconnect"], meta[name="color-scheme"]')) to.head.appendChild(n.cloneNode(true));
  const s = to.createElement("style");
  // PiP-only: the main-tab notice never shows here; the window is always a dark sky.
  s.textContent = "html, body { background: #000; }";
  to.head.appendChild(s);
}

let notice = null;
function showNotice(onBack) {
  if (notice) return;
  notice = document.createElement("div");
  notice.className = "float-notice";
  notice.setAttribute("role", "status");
  notice.innerHTML = `<span>Orbit is floating</span><span aria-hidden="true"> · </span><button type="button">bring back</button>`;
  const st = document.createElement("style");
  st.textContent = `.float-notice { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; gap: 6px; z-index: 40; background: #000;
    font: 300 12px/1.4 "JetBrains Mono", ui-monospace, Menlo, monospace; letter-spacing: .06em; color: rgba(190,194,198,.55); }
    .float-notice button { font: inherit; letter-spacing: inherit; color: rgba(226,230,234,.8); background: none; border: 0; padding: 4px 2px; cursor: pointer; text-decoration: underline; text-underline-offset: 3px; text-decoration-color: rgba(226,230,234,.25); }
    .float-notice button:hover, .float-notice button:focus-visible { color: #e2e6ea; text-decoration-color: rgba(226,230,234,.6); outline: none; }`;
  notice.appendChild(st);
  notice.querySelector("button").addEventListener("click", onBack);
  document.body.appendChild(notice);
}
function hideNotice() { notice?.remove(); notice = null; }

export function createFloat({ canvas, onChange = () => {} }) {
  let pip = null, moved = [], video = null, stream = null, busy = false;

  async function startDoc() {
    const size = savedSize();
    const win = await window.documentPictureInPicture.requestWindow(size);
    pip = win;
    win.document.title = "Orbit";
    copyStyles(document, win.document);
    // Move the live board. Remember each node's place so it goes back exactly where it was.
    moved = [...document.querySelectorAll("[data-float]")].map((n) => ({ n, parent: n.parentNode, next: n.nextSibling }));
    for (const { n } of moved) win.document.body.appendChild(n);
    // Seam for a later widget hosted in the floating window (e.g. a clipboard): an empty slot above the board.
    // A widget mounts into host.slot while host.mode === "doc" (see onHostChange); it goes away with the window.
    const slot = win.document.createElement("div");
    slot.id = "float-slot";
    Object.assign(slot.style, { position: "fixed", inset: "0", zIndex: "35", pointerEvents: "none" });
    win.document.body.appendChild(slot);
    host.slot = slot;
    showNotice(stop);
    let saveT = 0;
    win.addEventListener("resize", () => { clearTimeout(saveT); saveT = setTimeout(() => saveSize(win.innerWidth, win.innerHeight), 300); });
    win.addEventListener("pagehide", restoreDoc, { once: true });
    setHost(win, "doc");
    onChange(host.mode);
    try { canvas.focus({ preventScroll: true }); } catch { /* not focusable */ }
  }
  function restoreDoc() {
    if (!pip) return;
    const win = pip; pip = null;
    // Anything still in the PiP window that belongs to the board (frosted panels opened while floating too).
    const extra = [...win.document.querySelectorAll("[data-float]")].filter((n) => !moved.some((m) => m.n === n));
    for (const { n, parent, next } of moved) {
      if (parent && parent.isConnected && parent.ownerDocument === document) parent.insertBefore(n, next && next.parentNode === parent ? next : null);
      else document.body.appendChild(n);
    }
    for (const n of extra) document.body.appendChild(n);
    moved = [];
    host.slot = null;
    hideNotice();
    setHost(window, null);
    onChange(null);
  }

  async function startVideo() {
    video = document.createElement("video");
    video.muted = true; video.playsInline = true; video.autoplay = true;
    video.setAttribute("aria-hidden", "true");
    Object.assign(video.style, { position: "fixed", left: "-9999px", top: "0", width: "2px", height: "2px", opacity: "0", pointerEvents: "none" });
    document.body.appendChild(video);
    stream = canvas.captureStream(30);
    video.srcObject = stream;
    setVideoMode(true); onChange(host.mode); // keep the render clock at full rate before the first frame is needed
    try {
      // Safari needs the stream's first frame (metadata) before it allows PiP; wait briefly, inside the gesture window.
      if (video.readyState < 1) await new Promise((r) => { video.addEventListener("loadedmetadata", r, { once: true }); setTimeout(r, 600); });
      await video.play().catch(() => {});
      await video.requestPictureInPicture();
    } catch (e) { cleanupVideo(); throw e; }
    video.addEventListener("leavepictureinpicture", cleanupVideo, { once: true });
  }
  function cleanupVideo() {
    if (!video) return;
    try { stream?.getTracks().forEach((t) => t.stop()); } catch { /* already stopped */ }
    video.remove(); video = null; stream = null;
    setVideoMode(false); onChange(null);
  }

  async function start() {
    if (busy || host.mode) return;
    busy = true;
    try {
      const kind = floatSupport();
      if (kind === "doc") await startDoc();
      else if (kind === "video") await startVideo();
    } catch (e) { console.warn("[float]", e?.message ?? e); }
    finally { busy = false; }
  }
  function stop() {
    if (pip) { const w = pip; restoreDoc(); try { w.close(); } catch { /* closed */ } }
    else if (video && document.pictureInPictureElement === video) document.exitPictureInPicture().catch(() => cleanupVideo());
    else cleanupVideo();
  }
  // If the page goes away, put the board back first so nothing is left in a dangling window.
  window.addEventListener("pagehide", () => { if (pip) stop(); });
  return { start, stop, toggle: () => (host.mode ? stop() : start()), support: () => floatSupport(), get mode() { return host.mode; } };
}
