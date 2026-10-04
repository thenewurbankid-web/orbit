// The window that currently hosts the live board. Normally the page's own window; while Orbit floats in a
// Document Picture-in-Picture window, the PiP window. Size, events and the render clock follow `host.win`.
// `host.mode` is null, "doc" (the board lives in the PiP window) or "video" (a view-only video PiP of the canvas).

export const host = { win: window, doc: document, mode: null };

// Window-level listeners that must also hear the PiP window (resize, keys, pointer wake-ups). They stay on
// the main window and are added to each PiP window as it opens; a closed PiP window drops its own.
const subs = [];
export function hostOn(type, fn, opts) {
  subs.push([type, fn, opts]);
  window.addEventListener(type, fn, opts);
  if (host.win !== window) host.win.addEventListener(type, fn, opts);
}

const changeFns = new Set();
export function onHostChange(fn) { changeFns.add(fn); return () => changeFns.delete(fn); }

export function setHost(win, mode = win === window ? null : "doc") {
  const prev = host.win;
  host.win = win; host.doc = win.document; host.mode = mode;
  if (win !== window && win !== prev) for (const [t, f, o] of subs) win.addEventListener(t, f, o);
  for (const fn of changeFns) { try { fn(host); } catch (e) { console.error("[host]", e); } }
}

// Video PiP keeps the board in this window; only the mode changes (the render clock must not throttle).
export function setVideoMode(on) {
  host.mode = on ? "video" : null;
  for (const fn of changeFns) { try { fn(host); } catch (e) { console.error("[host]", e); } }
}

// Size of the window hosting the board.
export const hostSize = () => ({ w: host.win.innerWidth, h: host.win.innerHeight });
