// Screen-space lens flares as CSS overlays: real flare photos (assets/fx), pre-tinted once on a canvas, screen-
// blended over the canvas, positioned every frame from a projected 3D point, faded out when a planet or moon
// hides the source, and stretched along their on-screen motion like a 180° shutter. The envelope (fast attack,
// long exponential-looking decay) runs on the compositor through the Web Animations API.
import * as THREE from "three";

const ATTACK_EASE = "cubic-bezier(0.15, 0.6, 0.35, 1)";  // reaches its peak in a frame or two
const DECAY_EASE = "cubic-bezier(0.05, 0.7, 0.25, 1)";   // falls fast at first, then a long soft tail

export function createFlares({ canvas, camera, small, reduced, occluders }) {
  const doc = () => canvas.ownerDocument;
  let layer = null;
  function ensureLayer() {
    if (layer && layer.ownerDocument === doc() && layer.isConnected) return layer;
    layer?.remove();
    layer = doc().createElement("div");
    layer.setAttribute("aria-hidden", "true");
    Object.assign(layer.style, { position: "fixed", inset: "0", pointerEvents: "none", zIndex: "1", overflow: "hidden", contain: "strict" });
    (canvas.parentElement ?? doc().body).appendChild(layer);
    return layer;
  }
  // Source images, tinted per colour on a canvas (cached as data URLs).
  const imgs = new Map(), tinted = new Map();
  function image(name) {
    if (!imgs.has(name)) {
      const im = new Image(); im.decoding = "async"; im.src = `assets/fx/${name}${small ? "-sm" : ""}.jpg`;
      imgs.set(name, new Promise((res) => { im.onload = () => res(im); im.onerror = () => res(null); }));
    }
    return imgs.get(name);
  }
  ["glint", "flare", "streak"].forEach(image);
  function tint(name, rgb) {
    const key = name + rgb.map((v) => v.toFixed(2)).join(",");
    if (!tinted.has(key)) tinted.set(key, image(name).then((im) => {
      if (!im) return null;
      const c = document.createElement("canvas"); c.width = im.naturalWidth; c.height = im.naturalHeight;
      const x = c.getContext("2d"); x.drawImage(im, 0, 0);
      x.globalCompositeOperation = "multiply"; x.fillStyle = `rgb(${rgb.map((v) => Math.round(Math.min(1, v) * 255)).join(",")})`; x.fillRect(0, 0, c.width, c.height);
      return c.toDataURL("image/jpeg", 0.9);
    }));
    return tinted.get(key);
  }

  const live = new Set();
  const tmp = new THREE.Vector3(), ray = new THREE.Ray(), hit = new THREE.Vector3();
  // flash(pos, { name, size (fraction of the viewport's short side), color [r,g,b], peak, attack ms, decay ms, aspect, rot })
  function flash(pos, o = {}) {
    if (reduced) return false;
    const { name = "glint", size = 0.05, color = [1, 0.96, 0.9], peak = 0.6, attack = 40, decay = 600, aspect = 1, rot = Math.random() * 180 } = o;
    const f = { pos: pos.clone(), follow: o.follow ?? null, size, aspect, rot, vis: 1, el: null, prev: null, t0: performance.now(), dur: attack + decay };
    live.add(f);
    tint(name, color).then((url) => {
      if (!url || !live.has(f)) { live.delete(f); return; }
      const wrap = doc().createElement("div"), img = doc().createElement("img");
      Object.assign(wrap.style, { position: "absolute", left: "0", top: "0", willChange: "transform, opacity", mixBlendMode: "screen" });
      Object.assign(img.style, { display: "block", width: "100%", height: "100%", opacity: "0", mixBlendMode: "screen" });
      img.src = url; img.alt = ""; wrap.appendChild(img); ensureLayer().appendChild(wrap);
      f.el = wrap;
      const a = attack / (attack + decay);
      img.animate([
        { opacity: 0, transform: "scale(0.82)", easing: ATTACK_EASE },
        { opacity: peak, transform: "scale(1)", offset: a, easing: DECAY_EASE },
        { opacity: 0, transform: "scale(1.12)" },
      ], { duration: attack + decay, fill: "forwards" }).finished.then(() => { wrap.remove(); live.delete(f); }, () => { wrap.remove(); live.delete(f); });
      place(f, 0);
    });
    return true;
  }
  function occluded(p) {
    ray.origin.copy(camera.position); ray.direction.subVectors(p, camera.position);
    const d = ray.direction.length(); ray.direction.divideScalar(d || 1);
    for (const o of occluders()) { if (ray.intersectSphere(o, hit) && hit.distanceTo(camera.position) < d - o.radius * 0.05) return true; }
    return false;
  }
  function place(f, dt) {
    if (!f.el) return;
    const p = f.follow ? f.follow() : f.pos;
    tmp.copy(p).project(camera);
    const r = canvas.getBoundingClientRect();
    const x = r.left + (tmp.x * 0.5 + 0.5) * r.width, y = r.top + (-tmp.y * 0.5 + 0.5) * r.height;
    const behind = tmp.z > 1;
    const goal = behind || occluded(p) ? 0 : 1;
    f.vis += (goal - f.vis) * (dt ? 1 - Math.exp(-dt * 18) : 1);
    const s = Math.min(r.width, r.height) * f.size, w = s, h = s / f.aspect;
    // Motion stretch: 180° shutter = half of this frame's on-screen travel, clamped.
    let stretch = 1, ang = f.rot, blur = 0;
    if (f.prev && dt > 0) {
      const vx = x - f.prev.x, vy = y - f.prev.y, len = Math.hypot(vx, vy) * 0.5;
      if (len > 1.5) { stretch = 1 + Math.min(2, len / Math.max(8, w * 0.3)); ang = (Math.atan2(vy, vx) * 180) / Math.PI; blur = Math.min(3, len / 30); }
    }
    f.prev = { x, y };
    f.el.style.width = `${w.toFixed(1)}px`; f.el.style.height = `${h.toFixed(1)}px`;
    f.el.style.transform = `translate(${(x - w / 2).toFixed(1)}px, ${(y - h / 2).toFixed(1)}px) rotate(${ang.toFixed(1)}deg) scaleX(${stretch.toFixed(3)})${stretch > 1 ? ` rotate(${(f.rot - ang).toFixed(1)}deg)` : ""}`;
    f.el.style.opacity = f.vis.toFixed(3);
    f.el.style.filter = blur > 0.2 ? `blur(${blur.toFixed(1)}px)` : "";
  }
  function update(dt) { for (const f of live) place(f, dt); return live.size > 0; }
  return { flash, update, get busy() { return live.size > 0; } };
}
