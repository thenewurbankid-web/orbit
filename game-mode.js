// Game mode: fly the real solar system at true scale on the real clock. Two modes that never share a save:
//   Real: orbital physics (game-orbit.js), finite fuel, no time acceleration; time away is flown for you.
//   Warp: the same world, with a warp drive whose top speed grows with distance from the nearest body.
// Its own full-screen canvas and renderer (a logarithmic depth buffer, so a 30 m ship and the Sun 150 million km
// away share one view); the board is paused underneath and comes back untouched.
// Scene units are km. Floating origin: the ship sits at (0, 0, 0) and the universe is placed around it from
// double-precision positions every frame. Ecliptic (x, y, z) → scene (x, z, −y).

import * as THREE from "three";
import { AU, GM, RADIUS, SOI, PLANET_NAMES, bodyPosition, jdOf, len, sub } from "./game-ephem.js";
import { advance, orbitInfo, circular, kepler } from "./game-orbit.js";

const V = (a) => new THREE.Vector3(a[0], a[2], -a[1]);           // ecliptic → scene
const E = (v) => [v.x, -v.z, v.y];                                // scene → ecliptic
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const BODIES = ["sun", ...PLANET_NAMES.slice(0, 3), "moon", ...PLANET_NAMES.slice(3)];
const TEX = { earth: "earth", moon: "moon", mars: "mars", mercury: "mercury", jupiter: "jupiter", venus: "space/venus", saturn: "space/saturn", uranus: "space/uranus", neptune: "space/neptune", sun: "space/sun" };
const TINT = { sun: 0xfff1d6, venus: 0xe8d3a6, saturn: 0xd9c38f, uranus: 0x9fd8e0, neptune: 0x4f73d9 };
const LABEL = { sun: "Sun", mercury: "Mercury", venus: "Venus", earth: "Earth", moon: "Moon", mars: "Mars", jupiter: "Jupiter", saturn: "Saturn", uranus: "Uranus", neptune: "Neptune" };
const OBLIQUITY = 23.4393 * Math.PI / 180;
const SAVE = { real: "orbit.game.real", warp: "orbit.game.warp" };
const SHIP = { massT: 20, thrustKN: 400, fuelDv: 6.0 };          // 2 g at full throttle, 6 km/s of Δv in Real mode

const fmtKm = (km) => (km >= 0.1 * AU ? `${(km / AU).toFixed(km >= 10 * AU ? 1 : 3)} AU` : km >= 1e6 ? `${(km / 1e6).toFixed(2)} M km` : km >= 1000 ? `${Math.round(km).toLocaleString()} km` : km >= 1 ? `${km.toFixed(1)} km` : `${Math.round(km * 1000)} m`);
const fmtSpd = (kms) => (kms >= 1 ? `${kms.toFixed(kms >= 100 ? 0 : 2)} km/s` : `${Math.round(kms * 1000)} m/s`);
const fmtDur = (s) => (!Number.isFinite(s) ? "—" : s < 120 ? `${Math.round(s)} s` : s < 7200 ? `${Math.round(s / 60)} min` : s < 172800 ? `${(s / 3600).toFixed(1)} h` : s < 86400 * 400 ? `${(s / 86400).toFixed(1)} days` : `${(s / 86400 / 365.25).toFixed(1)} years`);
const load = (mode) => { try { return JSON.parse(localStorage.getItem(SAVE[mode]) ?? "null"); } catch { return null; } };
const store = (mode, v) => { try { localStorage.setItem(SAVE[mode], JSON.stringify(v)); } catch {} };
// One window flies a mode's save at a time: the owner refreshes a lock every 2 s; a second window on the same
// mode can fly but doesn't save (and says so), so two windows never overwrite each other.
const LOCK_MS = 6000, windowId = Math.random().toString(36).slice(2);
const lockKey = (mode) => `orbit.game.lock.${mode}`;
const readLock = (mode) => { try { return JSON.parse(localStorage.getItem(lockKey(mode)) ?? "null"); } catch { return null; } };
const heldElsewhere = (mode, now = Date.now()) => { const l = readLock(mode); return !!l && l.id !== windowId && now - l.at < LOCK_MS; };
const claim = (mode, now = Date.now()) => { if (heldElsewhere(mode, now)) return false; try { localStorage.setItem(lockKey(mode), JSON.stringify({ id: windowId, at: now })); } catch {} return true; };
const release = (mode) => { try { if (readLock(mode)?.id === windowId) localStorage.removeItem(lockKey(mode)); } catch {} };

const CSS = `
.og-root { position: fixed; inset: 0; z-index: 60; background: #000; font: 12px/1.45 ui-monospace, Menlo, monospace; color: #cfe3ee; user-select: none; -webkit-user-select: none; touch-action: none; }
.og-root canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; outline: none; }
.og-hud { position: absolute; pointer-events: none; text-shadow: 0 1px 2px #000; }
.og-hud b { color: #fff; font-weight: 500; }
.og-tl { left: 16px; top: 14px; } .og-tr { right: 16px; top: 14px; text-align: right; } .og-bl { left: 16px; bottom: 14px; max-width: calc(55% - 24px); } .og-br { right: 16px; bottom: 14px; text-align: right; max-width: 45%; }
@media (pointer: coarse) { .og-bl, .og-br { bottom: 72px; } }
.og-hud .k { color: #7f97a4; } .og-hud .warn { color: #ffb070; } .og-mode { letter-spacing: .2em; color: #9fdcff; }
.og-bar { width: 140px; height: 4px; background: rgba(255,255,255,.12); border-radius: 2px; margin: 3px 0 6px auto; overflow: hidden; } .og-bar i { display: block; height: 100%; background: #9fdcff; }
.og-label { position: absolute; transform: translate(8px, -50%); white-space: nowrap; pointer-events: none; font-size: 11px; color: #bcd4df; text-shadow: 0 1px 2px #000; }
.og-label::before { content: ""; position: absolute; left: -8px; top: 50%; width: 5px; height: 5px; margin-top: -3px; border: 1px solid currentColor; border-radius: 50%; }
.og-label.target { color: #ffd38a; }
.og-mark { position: absolute; transform: translate(-50%, -50%); pointer-events: none; font-size: 18px; color: rgba(220,240,255,.7); text-shadow: 0 0 4px #000; display: none; }
.og-mark.pro { color: #9fe8a8; font-size: 20px; } .og-mark.retro { color: #ffb070; font-size: 20px; } .og-label .d { color: #7f97a4; margin-left: 6px; }
.og-panel { position: absolute; inset: 0; display: grid; place-items: center; background: rgba(0,0,0,.55); }
.og-card { width: min(720px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow: auto; box-sizing: border-box; padding: 22px 24px; background: rgba(10,12,16,.88); border: 1px solid rgba(255,255,255,.1); border-top-color: rgba(235,242,248,.4); border-radius: 14px; }
.og-card h2 { margin: 0 0 6px; font: 400 13px ui-monospace, Menlo, monospace; letter-spacing: .2em; color: #9fdcff; }
.og-card p { margin: 0 0 10px; color: #aab8c0; }
.og-modes { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 12px; } @media (max-width: 560px) { .og-modes { grid-template-columns: 1fr; } }
.og-modes section { border: 1px solid rgba(255,255,255,.1); border-radius: 10px; padding: 14px; }
.og-modes h3 { margin: 0 0 6px; font: 500 14px ui-monospace, Menlo, monospace; color: #e8f3f8; }
.og-card button { font: inherit; letter-spacing: .08em; padding: 7px 12px; margin: 8px 8px 0 0; border-radius: 6px; cursor: pointer; color: #dff3fb; background: rgba(120,200,240,.1); border: 1px solid rgba(160,225,255,.45); }
.og-card button.dim { color: #aab4bc; background: transparent; border-color: rgba(255,255,255,.15); }
.og-keys { display: grid; grid-template-columns: auto 1fr; gap: 2px 14px; margin: 8px 0 0; color: #aab8c0; } .og-keys b { color: #e8f3f8; font-weight: 500; }
.og-touch { position: absolute; bottom: 16px; left: 50%; transform: translateX(-50%); display: none; gap: 8px; }
.og-touch button { font: inherit; font-size: 13px; min-width: 52px; height: 44px; border-radius: 10px; color: #dff3fb; background: rgba(20,30,40,.6); border: 1px solid rgba(160,225,255,.35); }
@media (pointer: coarse) { .og-touch { display: flex; } .og-help-keys { display: none; } }`;

export function openGame({ doc = document, win = window, onExit, small = false } = {}) {
  if (!doc.getElementById("og-css")) { const s = doc.createElement("style"); s.id = "og-css"; s.textContent = CSS; doc.head.appendChild(s); }
  const root = doc.createElement("div"); root.className = "og-root"; root.setAttribute("role", "application"); root.setAttribute("aria-label", "Orbit game mode");
  const canvas = doc.createElement("canvas"); canvas.tabIndex = 0; root.appendChild(canvas);
  const hud = { tl: el("og-hud og-tl"), tr: el("og-hud og-tr"), bl: el("og-hud og-bl"), br: el("og-hud og-br") };
  const labels = el("", "div"); root.append(...Object.values(hud), labels);
  const touch = el("og-touch"); root.appendChild(touch);
  doc.body.appendChild(root);
  function el(cls, tag = "div") { const e = doc.createElement(tag); if (cls) e.className = cls; return e; }

  // ---------------- renderer and scene ----------------
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !small, logarithmicDepthBuffer: true, powerPreference: "default" });
  renderer.setPixelRatio(Math.min(win.devicePixelRatio || 1, small ? 1.5 : 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.001, 1e12);
  const sky = new THREE.Scene(), skyCam = new THREE.PerspectiveCamera(60, 1, 0.1, 10);
  const sunLight = new THREE.PointLight(0xffffff, 3.2, 0, 0); scene.add(sunLight);
  scene.add(new THREE.AmbientLight(0xffffff, 0.06));

  // Stars: the Yale Bright Star Catalogue (9,096 real stars, J2000), placed on the sky by right ascension and
  // declination, sized and brightened by magnitude, coloured by temperature.
  fetch("assets/space/stars.json").then((r) => r.json()).then((cat) => {
    const n = cat.stars.length, pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n);
    const ce = Math.cos(OBLIQUITY), se = Math.sin(OBLIQUITY), d2r = Math.PI / 180;
    const tempRgb = (T) => { const t = T / 100; let r, g, b; // Tanner Helland's black-body fit
      if (t <= 66) { r = 255; g = 99.47 * Math.log(t) - 161.12; b = t <= 19 ? 0 : 138.52 * Math.log(t - 10) - 305.04; }
      else { r = 329.7 * Math.pow(t - 60, -0.1332); g = 288.12 * Math.pow(t - 60, -0.0755); b = 255; }
      return [r, g, b].map((x) => Math.max(0, Math.min(255, x)) / 255); };
    cat.stars.forEach(([ra, dec, vmag, temp], i) => {
      const x = Math.cos(dec * d2r) * Math.cos(ra * d2r), y = Math.cos(dec * d2r) * Math.sin(ra * d2r), z = Math.sin(dec * d2r);
      const p = V([x, y * ce + z * se, -y * se + z * ce]).multiplyScalar(5); pos.set([p.x, p.y, p.z], i * 3);
      const flux = Math.pow(10, -0.4 * (vmag - 1)), [r, g, b] = tempRgb(temp || 6000), k = Math.min(1.6, 0.25 + Math.sqrt(flux) * 0.9);
      col.set([r * k, g * k, b * k], i * 3); size[i] = Math.max(1.2, Math.min(6, 3.4 - vmag * 0.55)) * Math.min(2, win.devicePixelRatio || 1);
    });
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(pos, 3)); g.setAttribute("color", new THREE.BufferAttribute(col, 3)); g.setAttribute("size", new THREE.BufferAttribute(size, 1));
    sky.add(new THREE.Points(g, new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: "attribute float size; attribute vec3 color; varying vec3 vC; void main() { vC = color; gl_PointSize = size; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader: "varying vec3 vC; void main() { float d = length(gl_PointCoord - 0.5) * 2.0; float a = smoothstep(1.0, 0.0, d); gl_FragColor = vec4(vC * a * a, 1.0); }" })));
  }).catch(() => {});

  const loader = new THREE.TextureLoader();
  const tex = (name) => { const t = loader.load(name.startsWith("space/") ? `assets/${name}${small ? "-1k" : ""}.jpg` : `assets/planets/${name}${small ? "-1k" : ""}.jpg`); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t; };
  const bodies = {}; let bodiesAtmo = null;
  for (const b of BODIES) {
    const group = new THREE.Group(), spin = new THREE.Group(); group.add(spin);
    const geo = new THREE.SphereGeometry(RADIUS[b], b === "sun" ? 48 : 96, b === "sun" ? 24 : 48);
    const mat = b === "sun" ? new THREE.MeshBasicMaterial({ map: tex(TEX.sun), color: new THREE.Color(1, 1, 1).multiplyScalar(2.2), toneMapped: false })
      : new THREE.MeshStandardMaterial({ map: TEX[b] ? tex(TEX[b]) : null, color: TEX[b] ? 0xffffff : TINT[b], roughness: 1, metalness: 0 });
    const mesh = new THREE.Mesh(geo, mat); spin.add(mesh);
    if (b === "earth") {
      group.rotation.x = OBLIQUITY; // equatorial frame inside the group
      const clouds = new THREE.Mesh(new THREE.SphereGeometry(RADIUS.earth + 12, 96, 48), new THREE.MeshStandardMaterial({ color: 0xffffff, alphaMap: tex("earth-clouds"), transparent: true, opacity: 0.9, depthWrite: false, roughness: 1 }));
      spin.add(clouds);
      // Atmosphere: a thin rim glow, brightest at the limb and only on the sunlit side.
      const atmo = new THREE.Mesh(new THREE.SphereGeometry(RADIUS.earth + 100, 96, 48), new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.FrontSide,
        uniforms: { uSun: { value: new THREE.Vector3(1, 0, 0) } },
        vertexShader: `varying vec3 vN; varying vec3 vV; varying vec3 vW; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = normalize(mat3(modelMatrix) * normal); vN = normalize(normalMatrix * normal); vV = normalize(-(viewMatrix * w).xyz); gl_Position = projectionMatrix * viewMatrix * w;
          #include <logdepthbuf_vertex>
        }`,
        fragmentShader: `uniform vec3 uSun; varying vec3 vN; varying vec3 vV; varying vec3 vW;
          #include <logdepthbuf_pars_fragment>
          void main() {
          #include <logdepthbuf_fragment>
          float rim = pow(1.0 - max(dot(vN, vV), 0.0), 3.0); float lit = smoothstep(-0.25, 0.35, dot(vW, uSun));
          gl_FragColor = vec4(vec3(0.35, 0.6, 1.0) * rim * lit * 1.6, 1.0); }`,
      }));
      atmo.userData.atmo = true;
      group.add(atmo); bodiesAtmo = atmo;
    }
    if (b === "moon") mesh.rotation.y = -Math.PI / 2; // texture longitude 0 toward the group's +z, which looks at Earth
    if (b === "saturn") {
      const rt = loader.load("assets/space/saturn-ring.png"); rt.colorSpace = THREE.SRGBColorSpace;
      const rg = new THREE.RingGeometry(74500, 140220, 128, 1), uv = rg.attributes.uv, p = rg.attributes.position;
      for (let i = 0; i < uv.count; i++) { const r = Math.hypot(p.getX(i), p.getY(i)); uv.setXY(i, (r - 74500) / (140220 - 74500), 0.5); }
      const ring = new THREE.Mesh(rg, new THREE.MeshStandardMaterial({ map: rt, transparent: true, side: THREE.DoubleSide, depthWrite: false, roughness: 1 }));
      ring.rotation.x = -Math.PI / 2; group.add(ring);
      // Saturn's pole: ecliptic longitude ≈ 79.5°, latitude ≈ 61.9°.
      const lo = 79.5 * Math.PI / 180, la = 61.9 * Math.PI / 180;
      group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), V([Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)]).normalize());
    }
    if (b === "sun") {
      const c = doc.createElement("canvas"); c.width = c.height = 128; const x = c.getContext("2d"), g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
      g.addColorStop(0, "rgba(255,240,210,1)"); g.addColorStop(0.15, "rgba(255,220,170,.55)"); g.addColorStop(1, "rgba(255,200,140,0)"); x.fillStyle = g; x.fillRect(0, 0, 128, 128);
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
      glow.scale.setScalar(RADIUS.sun * 9); group.add(glow);
    }
    scene.add(group);
    const label = el("og-label"); label.innerHTML = `${LABEL[b]}<span class="d"></span>`; labels.appendChild(label);
    bodies[b] = { group, spin, mesh, label, helio: [0, 0, 0] };
  }

  // First person: no ship model. A map view (M) pulls the camera out, with a marker where you are.
  const you = el("og-label target"); you.innerHTML = `You<span class="d"></span>`; labels.appendChild(you);
  const marks = { nose: el("og-mark"), pro: el("og-mark pro"), retro: el("og-mark retro") };
  marks.nose.textContent = "+"; marks.pro.textContent = "⊕"; marks.retro.textContent = "⊗";
  marks.pro.title = "prograde: where you are heading"; marks.retro.title = "retrograde";
  root.append(...Object.values(marks));

  // ---------------- state ----------------
  let mode = null, save = null, attitude = new THREE.Quaternion(), throttle = 0, warp = 0, targetIdx = BODIES.indexOf("moon"), autopilot = false, sas = null;
  let camYaw = 0, camPitch = 0.35, camDist = 30000, lookYaw = 0, lookPitch = -0.3, fov = 60, map = false, running = true, last = performance.now(), saveAt = 0, menuOpen = false, note = "";
  const keys = new Set();

  function shipHelio(now) {
    if (mode === "real") return add(save.ship.r, bodyHelio(save.ship.body, now));
    return add(save.ship.offset, bodyHelio(save.ship.anchor, now));
  }
  const bodyHelio = (b, now) => (b === "sun" ? [0, 0, 0] : bodyPosition(b, jdOf(now)));
  function nearest(helio, now) {
    let best = "sun", bd = Infinity;
    for (const b of BODIES) { const d = len(sub(helio, bodyHelio(b, now))) - RADIUS[b]; if (d < bd) { bd = d; best = b; } }
    return { body: best, alt: bd };
  }
  function fresh(m, now) {
    // Start at ISS height over the sunlit side of Earth, nose prograde.
    const toSun = scale(bodyPosition("earth", jdOf(now)), -1 / len(bodyPosition("earth", jdOf(now))));
    const r0 = RADIUS.earth + 420, v0 = Math.sqrt(GM.earth / r0), side = [-toSun[1], toSun[0], 0];
    const s = { body: "earth", r: scale(toSun, r0), v: scale(side, v0 / len(side)), t: now };
    return { v: 1, mode: m, created: now, lastSeen: now, fuelDv: SHIP.fuelDv, credits: 0, xp: 0,
      stats: { distanceKm: 0, burns: 0, visited: ["earth"] },
      ship: m === "real" ? s : { anchor: "earth", offset: s.r, heading: s.v }, attitude: null };
  }

  let owner = true;
  // Timers keep running in background tabs (animation frames don't), so the lock holds while you look elsewhere.
  const lockTimer = win.setInterval(() => {
    if (!mode) return;
    const now = Date.now();
    if (owner) { if (!claim(mode, now)) { owner = false; note = "Another window took over this mode. This window has stopped saving."; } }
    else if (!heldElsewhere(mode, now) && claim(mode, now)) { owner = true; save = load(mode) ?? save; if (save?.attitude) attitude.fromArray(save.attitude); note = "The other window closed: this one saves again (picked up its latest save)."; }
  }, 2000);
  function start(m) {
    const now = Date.now(); mode = m; owner = claim(m, now); save = load(m);
    const lines = [];
    if (!save || save.v !== 1) save = fresh(m, now);
    else if (m === "real") {
      // Real mode: the time you were away is flown for you.
      const away = now - save.ship.t;
      const { state, events } = advance(save.ship, now, { maxChunkS: 3600 });
      save.ship = state;
      if (away > 60e3) lines.push(`While you were away (${fmtDur(away / 1000)}):`);
      for (const e of events) lines.push(e.kind === "impact" ? `${new Date(e.t).toUTCString()}: your ship hit ${LABEL[e.body]}.` : `${new Date(e.t).toUTCString()}: left ${LABEL[e.from]}'s pull for ${LABEL[e.to]}'s.`);
      if (save.ship.crashed) { lines.push("A new ship is waiting in low Earth orbit."); const f = fresh(m, now); save = { ...save, ship: f.ship, fuelDv: SHIP.fuelDv }; }
    }
    if (save.attitude) attitude.fromArray(save.attitude);
    else levelAttitude(mode === "real" ? save.ship.r : save.ship.offset, mode === "real" ? save.ship.v : save.ship.heading ?? [0, 0, 1]);
    if (!owner) lines.unshift("This mode is open in another window. You can fly here, but this window won't save.");
    note = lines.join("\n");
    panelEl?.remove(); panelEl = null; canvas.focus();
    buildTouch();
  }

  // Level flight: nose along the path, top of the ship away from the body below.
  function levelAttitude(r, v) {
    const up = V(r).normalize(), z = V(v).normalize(); z.sub(up.clone().multiplyScalar(z.dot(up))).normalize();
    const x = new THREE.Vector3().crossVectors(up, z);
    attitude.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, up, z));
  }
  function persist(now) { if (!save || !owner) return; save.lastSeen = now; save.attitude = attitude.toArray(); store(mode, save); }

  // ---------------- input ----------------
  const onKey = (e) => {
    if (!root.isConnected) return;
    e.stopPropagation(); // the board underneath gets no keys while the game is open
    if (e.target?.closest?.("input, textarea")) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (e.type === "keyup") { keys.delete(k); return; }
    if (k === "Escape") { e.preventDefault(); return menuOpen ? closeMenu() : mode ? openMenu() : exit(); }
    if (!mode || menuOpen) return;
    keys.add(k);
    if (k === "z") throttle = 1; if (k === "x" || k === "Control") throttle = 0;
    if (k === "1") sas = sas === "pro" ? null : "pro"; if (k === "2") sas = sas === "retro" ? null : "retro";
    if (k === "Tab" || k === "f") { e.preventDefault(); targetIdx = (targetIdx + (e.shiftKey ? BODIES.length - 1 : 1)) % BODIES.length; if (BODIES[targetIdx] === nearestNow) targetIdx = (targetIdx + 1) % BODIES.length; }
    if (k === "m") { map = !map; return; }
    if (k === "c") { lookYaw = 0; lookPitch = -0.3; fov = 60; return; }
    if (k === "t") { if (mode === "warp") autopilot = !autopilot; else sas = sas === "target" ? null : "target"; }
    if (["w", "s", "a", "d", "q", "e", " ", "Tab"].includes(k)) e.preventDefault();
  };
  win.addEventListener("keydown", onKey, true); win.addEventListener("keyup", onKey, true);
  const onHide = () => { if (mode) { persist(Date.now()); release(mode); } };
  win.addEventListener("pagehide", onHide);
  let drag = null;
  canvas.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, id: e.pointerId }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    const dx = (e.clientX - drag.x) * 0.004 * fov / 60, dy = (e.clientY - drag.y) * 0.004 * fov / 60;
    if (map) { camYaw -= dx; camPitch = Math.max(-1.45, Math.min(1.45, camPitch + dy)); }
    else { lookYaw += dx; lookPitch = Math.max(-1.5, Math.min(1.5, lookPitch + dy)); } // drag the view: look around from the cockpit
    drag.x = e.clientX; drag.y = e.clientY;
  });
  canvas.addEventListener("pointerup", () => { drag = null; });
  const zoom = (k) => { if (map) camDist = Math.max(50, Math.min(5e10, camDist * k)); else fov = Math.max(5, Math.min(100, fov * k)); };
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); zoom(Math.exp(e.deltaY * (map ? 0.0015 : 0.0008))); }, { passive: false });
  let pinch = null;
  canvas.addEventListener("touchmove", (e) => { if (e.touches.length !== 2) { pinch = null; return; } const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); if (pinch) zoom(pinch / d); pinch = d; }, { passive: true });

  const held = new Set();
  function buildTouch() {
    touch.innerHTML = "";
    const b = (label, down, up, title) => { const x = el("", "button"); x.type = "button"; x.textContent = label; x.title = title; x.addEventListener("pointerdown", (e) => { e.preventDefault(); down(); }); x.addEventListener("pointerup", () => up?.()); x.addEventListener("pointerleave", () => up?.()); touch.appendChild(x); };
    const hold = (k) => [() => held.add(k), () => held.delete(k)];
    b("◀", ...hold("a"), "Turn left"); b("▲", ...hold("s"), "Nose up"); b("▼", ...hold("w"), "Nose down"); b("▶", ...hold("d"), "Turn right");
    if (mode === "real") { b("+", ...hold("Shift"), "Throttle up"); b("0", () => { throttle = 0; }, null, "Cut throttle"); b("⟲", () => { sas = sas === "retro" ? null : "retro"; }, null, "Point backwards along your path"); }
    else { b("+", ...hold("w+"), "More warp"); b("−", ...hold("w-"), "Less warp"); b("→●", () => { autopilot = !autopilot; }, null, "Fly to target"); b("◎", () => { targetIdx = (targetIdx + 1) % BODIES.length; }, null, "Next target"); }
    b("☰", () => openMenu(), null, "Menu");
  }
  const down = (k) => keys.has(k) || held.has(k);

  // ---------------- panels ----------------
  let panelEl = null;
  function picker() {
    const sum = (m) => { const s = load(m); if (heldElsewhere(m)) return "Open in another window right now (this window would fly without saving)."; if (!s) return "No ship yet."; const w = s.mode === "real" ? `${LABEL[s.ship.body]} · ${s.fuelDv.toFixed(2)} km/s fuel left` : `near ${LABEL[s.ship.anchor]}`; return `Last flown ${new Date(s.lastSeen).toLocaleString()} · ${w} · ${fmtKm(s.stats.distanceKm)} travelled`; };
    panelEl = el("og-panel"); panelEl.innerHTML = `<div class="og-card" role="dialog" aria-label="Choose a mode"><h2>FLY THE REAL SOLAR SYSTEM</h2>
      <p>True sizes, true distances, and every planet and moon where it is right now (JPL orbital elements, checked against NASA Horizons). Your ship starts in low Earth orbit at the height of the ISS.</p>
      <div class="og-modes">
        <section><h3>Real</h3><p>Real orbital physics and the real clock. No time skipping: the Moon is days away, Mars is months. Your orbit keeps going while you're away. Limited fuel.</p><p class="k">${sum("real")}</p><button data-m="real">${load("real") ? "Continue" : "Start"} Real</button></section>
        <section><h3>Warp</h3><p>The same real universe on the real clock, with a warp drive: faster the further you are from anything. The Moon in seconds, Neptune in minutes.</p><p class="k">${sum("warp")}</p><button data-m="warp">${load("warp") ? "Continue" : "Start"} Warp</button></section>
      </div>
      <p class="k" style="margin-top:12px">The two modes never share a save, money or progress.</p>
      <button class="dim" data-a="back">Back to the board</button></div>`;
    panelEl.querySelectorAll("[data-m]").forEach((x) => (x.onclick = () => start(x.dataset.m)));
    panelEl.querySelector("[data-a=back]").onclick = () => exit();
    root.appendChild(panelEl);
  }
  function openMenu() {
    if (menuOpen) return; menuOpen = true; persist(Date.now());
    const keysHelp = mode === "real"
      ? [["W / S", "nose down / up"], ["A / D", "turn left / right"], ["Q / E", "roll"], ["Shift (hold)", "throttle up"], ["Z / X or Ctrl", "full / cut throttle"], ["1 / 2", "hold prograde / retrograde (2 = point back along your path to slow down)"], ["Tab or F", "next target"], ["T", "point at target"], ["drag", "look around from the cockpit (C to recentre)"], ["wheel", "zoom the view"], ["M", "map: pull out to see your orbit and the whole solar system"], ["Esc", "this menu"]]
      : [["W / S", "more / less warp (S down to a stop)"], ["mouse drag", "look around"], ["arrows or A / D, Q / E", "turn and roll the ship"], ["Tab or F", "next target"], ["T", "fly to the target automatically"], ["wheel", "zoom the view"], ["C", "recentre the view"], ["M", "map view"], ["Esc", "this menu"]];
    panelEl = el("og-panel"); panelEl.innerHTML = `<div class="og-card" role="dialog" aria-label="Game menu"><h2>${mode.toUpperCase()} MODE</h2>
      <div class="og-keys og-help-keys">${keysHelp.map(([a, b]) => `<b>${a}</b><span>${b}</span>`).join("")}</div>
      <button data-a="resume">Resume</button><button class="dim" data-a="switch">Switch mode</button><button class="dim" data-a="leave">Save and go back to the board</button></div>`;
    panelEl.querySelector("[data-a=resume]").onclick = closeMenu;
    panelEl.querySelector("[data-a=switch]").onclick = () => { closeMenu(); persist(Date.now()); release(mode); mode = null; save = null; picker(); };
    panelEl.querySelector("[data-a=leave]").onclick = () => exit();
    root.appendChild(panelEl);
  }
  function closeMenu() { menuOpen = false; panelEl?.remove(); panelEl = null; last = performance.now(); canvas.focus(); }

  // ---------------- per frame ----------------
  let nearestNow = "earth", lastT = { body: null, d: 0, at: 0 }, closing = 0;
  const tmpQ = new THREE.Quaternion(), fwd = new THREE.Vector3();
  function steer(dt) {
    const rate = 0.9 * dt, roll = 1.2 * dt;
    const pitch = (down("s") && mode === "real" ? 1 : 0) - (down("w") && mode === "real" ? 1 : 0) + (down("ArrowUp") ? -1 : 0) + (down("ArrowDown") ? 1 : 0);
    const yaw = (down("a") || down("ArrowLeft") ? 1 : 0) - (down("d") || down("ArrowRight") ? 1 : 0);
    const rl = (down("q") ? -1 : 0) + (down("e") ? 1 : 0);
    if (pitch || yaw || rl) { sas = sas === "target" && mode === "warp" ? sas : null; autopilot = autopilot && !(pitch || yaw); }
    attitude.multiply(tmpQ.setFromEuler(new THREE.Euler(pitch * rate, yaw * rate, rl * roll, "YXZ"))).normalize();
  }
  function pointAt(dirScene, dt, k = 3) {
    const want = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dirScene.clone().normalize());
    attitude.slerp(want, Math.min(1, k * dt));
  }

  function frame(t) {
    if (!running) return;
    win.requestAnimationFrame(frame);
    const dt = Math.min(0.1, (t - last) / 1000); last = t;
    const now = Date.now();
    const W = canvas.clientWidth, H = canvas.clientHeight;
    if (canvas.width !== Math.round(W * renderer.getPixelRatio()) || canvas.height !== Math.round(H * renderer.getPixelRatio())) { renderer.setSize(W, H, false); camera.aspect = skyCam.aspect = W / H; camera.updateProjectionMatrix(); skyCam.updateProjectionMatrix(); }
    labels.style.display = mode && !menuOpen ? "" : "none";
    if (!mode) { renderer.render(sky, skyCam); return; }

    const before = shipHelio(now);
    if (!menuOpen) {
      steer(dt);
      const target = BODIES[targetIdx];
      fwd.set(0, 0, 1).applyQuaternion(attitude);
      if (mode === "real") {
        if (sas === "pro" || sas === "retro") pointAt(V(save.ship.v).multiplyScalar(sas === "pro" ? 1 : -1), dt);
        if (sas === "target") pointAt(V(sub(bodyHelio(target, now), before)), dt);
        if (down("Shift")) throttle = Math.min(1, throttle + dt * 0.8);
        const acc = (SHIP.thrustKN / SHIP.massT / 1000) * throttle; // km/s²
        const dv = acc * dt;
        if (dv > 0 && save.fuelDv > 0) { const use = Math.min(dv, save.fuelDv); save.ship = { ...save.ship, v: add(save.ship.v, scale(E(fwd), use)) }; save.fuelDv -= use; if (save.fuelDv <= 0) { throttle = 0; note = "Out of fuel. Your orbit is your orbit now."; } }
        const r = advance(save.ship, now, { maxChunkS: 60 });
        for (const e of r.events) note = e.kind === "impact" ? `You hit ${LABEL[e.body]}. Press Esc → Switch mode or wait: a new ship is ready next time you open Real mode.` : `Now in ${LABEL[e.to]}'s sphere of influence.`;
        save.ship = r.state;
      } else {
        // Warp: anchored to the nearest body so idling keeps you with it; speed scales with distance to it.
        if (autopilot) {
          // Steer for the target, but climb away first if the way there runs through the body you're next to.
          const n0 = nearest(before, now), up = sub(before, bodyHelio(n0.body, now)), upN = scale(up, 1 / len(up));
          const to = sub(bodyHelio(target, now), before), toN = scale(to, 1 / len(to));
          const blocked = n0.body !== target && n0.alt < RADIUS[n0.body] * 4 && toN[0] * upN[0] + toN[1] * upN[1] + toN[2] * upN[2] < 0.35;
          pointAt(V(blocked ? add(toN, scale(upN, 1.6)) : toN), dt, 2);
        }
        if (down("w") || down("w+")) warp = Math.min(1, warp + dt * 0.6);
        if (down("s") || down("w-")) warp = Math.max(0, warp - dt * 1.2);
        const n = nearest(before, now), cap = Math.max(0.01, Math.min(0.08 * AU, n.alt * 0.6)); // km/s
        let speed = warp * cap;
        if (autopilot) {
          const dist = len(sub(bodyHelio(target, now), before)) - RADIUS[target] * 3;
          if (dist < 1) { autopilot = false; warp = 0; note = `Arrived at ${LABEL[target]}.`; speed = 0; }
          else { speed = Math.min(cap, dist * 0.8); warp = speed / cap; } // full drive, easing off on the way in
        }
        const moved = scale(E(fwd), speed * dt);
        save.ship.offset = add(save.ship.offset, moved);
        // Re-anchor to whichever body is now closest.
        const helio = shipHelio(now), nn = nearest(helio, now);
        if (nn.body !== save.ship.anchor) { save.ship = { anchor: nn.body, offset: sub(helio, bodyHelio(nn.body, now)) }; if (!save.stats.visited.includes(nn.body) && nn.alt < (SOI[nn.body] ?? Infinity)) save.stats.visited.push(nn.body); }
        if (nn.alt < 0.2) { save.ship.offset = scale(save.ship.offset, (RADIUS[nn.body] + 0.2) / len(save.ship.offset)); warp = 0; }
      }
      save.stats.distanceKm += len(sub(shipHelio(now), before));
    }
    if (now > saveAt) { persist(now); saveAt = now + 10000; }

    // Place the universe around the ship (floating origin).
    const me = shipHelio(now);
    const gmst = ((280.46061837 + 360.98564736629 * (jdOf(now) - 2451545)) % 360) * Math.PI / 180;
    for (const b of BODIES) {
      const o = bodies[b]; o.helio = bodyHelio(b, now);
      o.group.position.copy(V(sub(o.helio, me)));
      if (b === "earth") o.spin.rotation.y = gmst;
      if (b === "moon") o.group.lookAt(bodies.earth.group.position);
    }
    sunLight.position.copy(bodies.sun.group.position);
    if (bodiesAtmo) bodiesAtmo.material.uniforms.uSun.value.copy(bodies.sun.group.position).sub(bodies.earth.group.position).normalize();
    if (camera.fov !== fov) { camera.fov = skyCam.fov = fov; skyCam.updateProjectionMatrix(); }
    if (map) {
      // Map: the camera pulls out behind you, oriented to your ship; zoom out to the whole solar system.
      const cq = new THREE.Quaternion().setFromEuler(new THREE.Euler(camPitch, camYaw, 0, "YXZ"));
      camera.position.copy(new THREE.Vector3(0, 0, -camDist).applyQuaternion(attitude.clone().multiply(cq)));
      camera.up.set(0, 1, 0).applyQuaternion(attitude); camera.lookAt(0, 0, 0);
      camera.near = Math.max(0.01, camDist * 0.001);
    } else {
      // Cockpit: the camera is the ship; +z is the nose, the camera looks down its own −z, so turn it around.
      camera.position.set(0, 0, 0);
      camera.quaternion.copy(attitude).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI)).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(lookPitch, -lookYaw, 0, "YXZ")));
      camera.near = 0.001;
    }
    camera.updateProjectionMatrix();
    skyCam.quaternion.copy(camera.quaternion);

    renderer.autoClear = true; renderer.render(sky, skyCam);
    renderer.autoClear = false; renderer.clearDepth(); renderer.render(scene, camera); renderer.autoClear = true;

    // Labels and HUD.
    const near = nearest(me, now); nearestNow = near.body;
    const target = BODIES[targetIdx];
    for (const b of BODIES) {
      const o = bodies[b], p = o.group.position.clone(), d = p.length() - RADIUS[b];
      const pr = p.clone().project(camera), on = pr.z < 1 && Math.abs(pr.x) < 1.05 && Math.abs(pr.y) < 1.05;
      const pxR = RADIUS[b] / Math.max(1, camera.position.distanceTo(p)) * H / (2 * Math.tan(camera.fov * Math.PI / 360));
      const dir = p.clone().sub(camera.position), dist = dir.length(); dir.normalize();
      const hidden = BODIES.some((q) => { if (q === b) return false; const c = bodies[q].group.position.clone().sub(camera.position), cd = c.length(); return cd < dist && dir.angleTo(c) < Math.asin(Math.min(1, RADIUS[q] / cd)); });
      o.label.style.display = on && !hidden && pxR < 120 ? "" : "none";
      o.label.classList.toggle("target", b === target);
      if (on) { o.label.style.left = `${(pr.x * 0.5 + 0.5) * W}px`; o.label.style.top = `${(-pr.y * 0.5 + 0.5) * H}px`; o.label.lastChild.textContent = fmtKm(Math.max(0, d)); }
    }
    const place = (elm, dir) => { // a direction marker on screen (nose, prograde, retrograde)
      const pr = camera.position.clone().add(dir.clone().normalize().multiplyScalar(1000)).project(camera), on = pr.z < 1 && Math.abs(pr.x) < 1 && Math.abs(pr.y) < 1;
      elm.style.display = on ? "block" : "none";
      if (on) { elm.style.left = `${(pr.x * 0.5 + 0.5) * W}px`; elm.style.top = `${(-pr.y * 0.5 + 0.5) * H}px`; }
    };
    if (!map) {
      place(marks.nose, new THREE.Vector3(0, 0, 1).applyQuaternion(attitude));
      const vel = mode === "real" ? V(save.ship.v) : new THREE.Vector3(0, 0, 1).applyQuaternion(attitude).multiplyScalar(warp > 0 ? 1 : 0);
      if (vel.lengthSq() > 0) { place(marks.pro, vel); place(marks.retro, vel.clone().negate()); } else marks.pro.style.display = marks.retro.style.display = "none";
      you.style.display = "none";
    } else {
      for (const k of Object.keys(marks)) marks[k].style.display = "none";
      const pr = new THREE.Vector3(0, 0, 0).project(camera); you.style.display = pr.z < 1 ? "" : "none"; you.style.left = `${(pr.x * 0.5 + 0.5) * W}px`; you.style.top = `${(-pr.y * 0.5 + 0.5) * H}px`; you.lastChild.textContent = "";
    }
    const utc = new Date(now).toISOString().replace("T", " ").slice(0, 19) + " UTC";
    const tDist = len(sub(bodyHelio(target, now), me)) - RADIUS[target];
    // Closing speed toward the target, measured from how fast the real distance shrinks (smoothed).
    if (lastT.body === target && now > lastT.at) closing += ((lastT.d - tDist) / ((now - lastT.at) / 1000) - closing) * Math.min(1, dt * 2); else closing = 0;
    lastT = { body: target, d: tDist, at: now };
    if (mode === "real") {
      const o = orbitInfo(save.ship), vRel = len(save.ship.v);
      hud.tl.innerHTML = `<div class="og-mode">REAL</div><b>${LABEL[save.ship.body]}</b> <span class="k">orbit</span><br>altitude <b>${fmtKm(o.altitude)}</b><br>speed <b>${fmtSpd(vRel)}</b><br>${o.bound ? `apoapsis <b>${fmtKm(o.apoapsis)}</b><br>periapsis <b class="${o.periapsis < 100 ? "warn" : ""}">${fmtKm(o.periapsis)}</b><br>period <b>${fmtDur(o.period)}</b>` : `<span class="warn">escape trajectory</span>`}`;
      hud.tr.innerHTML = `${utc}<br>throttle <b>${Math.round(throttle * 100)}%</b><div class="og-bar"><i style="width:${throttle * 100}%"></i></div>fuel <b>${save.fuelDv.toFixed(2)} km/s Δv</b><div class="og-bar"><i style="width:${save.fuelDv / SHIP.fuelDv * 100}%"></i></div>${sas ? `holding <b>${sas === "pro" ? "prograde" : sas === "retro" ? "retrograde" : "target"}</b>` : ""}`;
      hud.br.innerHTML = `target <b>${LABEL[target]}</b><br>${fmtKm(Math.max(0, tDist))}${closing > 0.001 ? `<br>closing ${fmtSpd(closing)} · ~${fmtDur(tDist / closing)}` : ""}`;
    } else {
      const n = nearest(me, now), cap = Math.max(0.01, Math.min(0.08 * AU, n.alt * 0.6)), spd = warp * cap;
      hud.tl.innerHTML = `<div class="og-mode">WARP</div>near <b>${LABEL[n.body]}</b><br>altitude <b>${fmtKm(n.alt)}</b><br>warp <b>${fmtSpd(spd)}</b> <span class="k">(${(spd / 299792.458).toPrecision(2)} c)</span>`;
      hud.tr.innerHTML = `${utc}<br>warp <b>${Math.round(warp * 100)}%</b><div class="og-bar"><i style="width:${warp * 100}%"></i></div>${autopilot ? `<b>autopilot</b> to ${LABEL[target]}` : ""}`;
      hud.br.innerHTML = `target <b>${LABEL[target]}</b><br>${fmtKm(Math.max(0, tDist))}${spd > 0 ? `<br>~${fmtDur(tDist / spd)} at this speed` : ""}`;
    }
    hud.bl.innerHTML = `${note ? note.replace(/\n/g, "<br>") + "<br>" : ""}<span class="k og-help-keys">Esc: keys and menu<br>drag to look · M: map${mode === "real" ? " · ⊕ prograde ⊗ retrograde" : ""}</span>`;
  }

  function exit() {
    if (!running) return;
    running = false; persist(Date.now()); if (mode) release(mode);
    win.removeEventListener("keydown", onKey, true); win.removeEventListener("keyup", onKey, true); win.removeEventListener("pagehide", onHide); win.clearInterval(lockTimer);
    renderer.dispose(); root.remove();
    onExit?.();
  }

  picker();
  win.requestAnimationFrame(frame);
  return { exit, debug: { camera, bodies, scene, renderer, get save() { return save; }, get sas() { return sas; }, attitude } };
}
