// Observatory scene: the sky behind a frosted pane. Companies are constellations, agents are stars,
// issues are satellites. Text condenses on the glass (an orthographic overlay in the same WebGL
// context). All controls are in-scene; the plain list view is the only HTML UI.
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { BokehPass } from "three/addons/postprocessing/BokehPass.js";
import { companyProgress, store, act, OPEN, STATUS, ago, allQuestions, summary, messagesFor, toggleList, startPairing, applyAnswer, stopPairing, answerQuestion, copyText, helperBrief, helperAsk, helperLines, helperState } from "./app.js";
import * as fx from "./fx.js";
import { bakePlanet, bakeNebula, NEBULA_CENTRES, KIND } from "./planets.js";
import * as pfx from "./planetfx.js";

// Black board: soft grey text; only the active or important item is brighter.
const C = {
  ink: "#b8b8b8", ink2: "#8c8c8c", ink3: "#666666",
  ice: "#e2e6ea", amber: "rgba(222,170,96,0.95)", ember: "rgba(200,104,82,0.92)", frost: "#9c9c9c",
};
const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif';
const MONO = 'ui-monospace, Menlo, monospace';
const SUN = new THREE.Vector3(1.0, 0.28, 0.12).normalize(); // off-screen to the right: hard terminators
const hash = (s) => { let h = 2166136261; for (const ch of String(s)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return (h >>> 0) / 4294967296; };

export async function startScene({ canvas, kbd, reduced }) {
  const look = { x: 0, y: 0, tx: 0, ty: 0 }; // parallax input (mouse or tilt)
  const forceRender = new URLSearchParams(location.search).has("forcerender"); // testing only: keep rendering in a hidden tab
  const isHidden = () => document.hidden && !forceRender;
  const raf = (f) => (forceRender && document.hidden ? setTimeout(() => f(performance.now()), 33) : requestAnimationFrame(f));
  let dirty = true, paused = false, rafId = 0, last = performance.now(), clock = 0, activeUntil = performance.now() + 3000, lastRender = 0;
  // ---------------- renderer, tier, passes ----------------
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance", alpha: false });
  const tier = fx.detectTier(renderer);
  const dpr = Math.min(devicePixelRatio || 1, tier.dpr);
  renderer.setPixelRatio(dpr);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.5;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); toggleList(true); });

  const world = new THREE.Scene();
  world.background = new THREE.Color(0x000000);
  const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 2000);
  world.add(camera);

  const glass = new THREE.Scene();
  const ortho = new THREE.OrthographicCamera(0, 1, 0, -1, -10, 10);

  const starfield = fx.createStarfield(tier, dpr);
  const milky = fx.createMilkyWay();
  const nebula = fx.createNebula(tier);
  world.add(starfield.group); // pure black: no Milky Way haze or nebula fog in the view
  // Far-background storm nebula: baked texture on the farthest dome, lit from behind by
  // occasional lightning pulses that only show where there is cloud.
  const nebTex = bakeNebula(renderer, tier.mobile ? 1024 : 2048);
  const nebMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { map: { value: nebTex }, uPulse: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] } },
    vertexShader: `varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform sampler2D map; uniform vec4 uPulse[3]; varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        vec2 uv = vec2(atan(d.x, d.z) / 6.2831853 + 0.5, asin(clamp(d.y, -1.0, 1.0)) / 3.1415927 + 0.5);
        vec4 t = texture2D(map, uv);
        vec3 col = t.rgb;
        float edge = t.a * (1.0 - t.a) * 4.0;
        for (int i = 0; i < 3; i++) {
          if (uPulse[i].w <= 0.0) continue;
          float ang = acos(clamp(dot(d, normalize(uPulse[i].xyz)), -1.0, 1.0));
          float w = exp(-ang * ang * 30.0) * uPulse[i].w;
          col += vec3(0.62, 0.52, 1.0) * (edge * 1.2 + t.a * 0.35) * w;   // back-lit filament edges
        }
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const nebula2 = new THREE.Mesh(new THREE.SphereGeometry(470, 64, 32), nebMat);
  nebula2.frustumCulled = false; nebula2.renderOrder = -10;
  world.add(nebula2);
  const lightning = { next: 6 + Math.random() * 10, slots: [0, 0, 0].map(() => ({ t: -1, dur: 0.25, dir: new THREE.Vector3(), double: false })) };
  function updateLightning(dt) {
    if (reduced) return;
    lightning.next -= dt;
    if (lightning.next <= 0) {
      lightning.next = 8 + Math.random() * 17;
      const slot = lightning.slots.find((x) => x.t < 0) ?? lightning.slots[0];
      const c = NEBULA_CENTRES[Math.floor(Math.random() * 3)];
      slot.dir.copy(c).normalize().add(new THREE.Vector3().randomDirection().multiplyScalar(0.18)).normalize();
      slot.t = 0; slot.dur = 0.15 + Math.random() * 0.25; slot.double = Math.random() < 0.35;
    }
    lightning.slots.forEach((x, i) => {
      let w = 0;
      if (x.t >= 0) {
        x.t += dt;
        const f = (tt) => (tt < 0 ? 0 : tt < 0.03 ? tt / 0.03 : Math.max(0, 1 - (tt - 0.03) / x.dur) ** 2);
        w = Math.max(f(x.t), x.double ? f(x.t - x.dur - 0.08) * 0.8 : 0);
        if (x.t > x.dur * (x.double ? 2.4 : 1.2) + 0.1) x.t = -1;
        activeUntil = Math.max(activeUntil, performance.now() + 60);
      }
      nebMat.uniforms.uPulse.value[i].set(x.dir.x, x.dir.y, x.dir.z, w);
    });
  }
  const debris = fx.createDebris(tier, reduced);
  world.add(debris.group);
  void milky; void nebula;

  // Environment for the saucer: the same sky plus a dim sun, prefiltered once.
  const envScene = new THREE.Scene();
  envScene.add(fx.createMilkyWay());
  const sunBall = new THREE.Mesh(new THREE.SphereGeometry(30, 16, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 6.2, 6.6) }));
  sunBall.position.copy(SUN).multiplyScalar(300);
  const rimGlow = new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide, vertexShader: `varying vec3 d; void main(){ d = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: `varying vec3 d; void main(){ float h = max(0., d.y); gl_FragColor = vec4(vec3(0.05,0.055,0.065)*(0.3+h) + vec3(0.12)*pow(max(0.,1.-abs(d.y)*3.),4.), 1.); }`,
  }));
  envScene.add(rimGlow, sunBall);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envMap = pmrem.fromScene(envScene, 0, 0.1, 1000).texture;
  const sunLight = new THREE.DirectionalLight(0xfff4e6, 10); // bright sun; ACES keeps the lit side from washing out
  sunLight.position.copy(SUN).multiplyScalar(100);
  world.add(sunLight, new THREE.AmbientLight(0x202428, 0.06)); // night sides stay black
  const makeUfo = fx.createUfoFactory(envMap, tier);

  const particles = fx.createParticles(tier.particles, dpr);
  world.add(particles.points);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(world, camera));
  let bokeh = null;
  if (tier.name === "high" && !tier.mobile && !reduced) {
    bokeh = new BokehPass(world, camera, { focus: 40, aperture: 0.00012, maxblur: 0.006 });
    bokeh.enabled = false;
    composer.addPass(bokeh);
  }
  // Threshold above anything the sun can light: only emissive event effects (HDR > 3) bloom.
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.45, 0.12, 3.0);
  const bloomSetSize = bloom.setSize.bind(bloom);
  bloom.setSize = (w, h) => bloomSetSize(Math.max(64, Math.round(w * tier.bloomScale)), Math.max(64, Math.round(h * tier.bloomScale)));
  composer.addPass(bloom);
  const film = new ShaderPass(fx.GlassFilmShader);
  film.uniforms.tFrost.value = new THREE.DataTexture(new Uint8Array([128, 128, 0, 0]), 1, 1); film.uniforms.tFrost.value.needsUpdate = true;
  film.uniforms.uFrost.value = 0; // no frost: plain black glass
  film.uniforms.uGrain.value = 0; // clean: no grain
  composer.addPass(film);
  composer.addPass(new OutputPass());

  // ---------------- warp streaks (camera-attached) ----------------
  const warpGeo = new THREE.BufferGeometry();
  {
    const n = 140, p = new Float32Array(n * 6), c = new Float32Array(n * 6);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, r = 2 + Math.random() * 10, z = -6 - Math.random() * 50;
      p.set([Math.cos(a) * r, Math.sin(a) * r, z, Math.cos(a) * r, Math.sin(a) * r, z - 1], i * 6);
      c.set([0.7, 0.8, 0.9, 0, 0, 0], i * 6);
    }
    warpGeo.setAttribute("position", new THREE.BufferAttribute(p, 3));
    warpGeo.setAttribute("color", new THREE.BufferAttribute(c, 3));
  }
  const warpMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  const warp = new THREE.LineSegments(warpGeo, warpMat);
  warp.frustumCulled = false;
  camera.add(warp);

  // ---------------- textures and labels ----------------
  const psfSpiky = fx.psfTexture(128, true);
  const psfSoft = fx.psfTexture(64, false);

  // Labels are crisp screen-space text on the overlay (after bloom and tone mapping), placed each
  // frame by projecting a 3D anchor and rounding to whole pixels. The returned object is an empty
  // Object3D standing in for the label in the world, so callers can add/remove/move it.
  const labels = new Set();
  function textSprite(text, { px = 44, color = C.ink, weight = 600, font = SANS } = {}) {
    const size = Math.round(Math.max(10, Math.min(15, px / 3)));
    const anchor = new THREE.Object3D();
    anchor.material = { opacity: 0 };
    const plate = new Plate("label");
    const c = plate.ctx;
    c.font = `${weight} ${size}px ${font}`;
    const w = Math.ceil(c.measureText(text).width) + 8, h = Math.ceil(size * 1.5);
    plate.place(0, 0, w, h);
    const x = plate.begin();
    x.font = `${weight} ${size}px ${font}`; x.textBaseline = "middle"; x.textAlign = "left";
    x.fillStyle = color; x.fillText(text, 4, h / 2 + 0.5);
    plate.end();
    plate.mesh.visible = false;
    plate.mesh.renderOrder = -0.5; // under the panels, over the frame
    anchor.userData.label = { plate, w, h };
    labels.add(anchor);
    return anchor;
  }
  const _lp = new THREE.Vector3();
  function placeLabels() {
    for (const a of labels) {
      const { plate, w, h } = a.userData.label;
      if (!a.parent) { glass.remove(plate.mesh); plate.tex.dispose(); labels.delete(a); continue; }
      const op = a.material.opacity;
      a.getWorldPosition(_lp).project(camera);
      if (op < 0.02 || _lp.z > 1 || Math.abs(_lp.x) > 1.2 || Math.abs(_lp.y) > 1.2) { plate.mesh.visible = false; continue; }
      const sx = Math.round((_lp.x * 0.5 + 0.5) * W - w / 2), sy = Math.round((-_lp.y * 0.5 + 0.5) * H - h / 2);
      plate.mesh.position.set(sx + w / 2, -(sy + h / 2), 0);
      plate.mat.uniforms.uOpacity.value = op;
      plate.mesh.visible = true;
    }
  }

  // ---------------- planets: procedural dark surfaces ----------------
  const PLANET_LOOK = {
    BOX: { base: [58, 30, 22], band: [92, 46, 30], spot: [30, 16, 12], rim: 0xc08060 },   // rust / ochre desert
    CLA: { base: [40, 34, 52], band: [66, 56, 84], spot: [24, 20, 32], rim: 0x9088b0 },   // violet-grey rock, icy poles
    VIS: { base: [26, 44, 46], band: [44, 72, 74], spot: [14, 26, 28], rim: 0x70b8d8 },   // teal-grey ocean world
    moon: { base: [70, 70, 72], band: [96, 96, 98], spot: [40, 40, 42], rim: 0x666666 },
    default: { base: [50, 50, 52], band: [80, 80, 82], spot: [30, 30, 32], rim: 0x555555 },
  };
  function planetTexture(look, seed) {
    const w = 256, h = 128, c = document.createElement("canvas"); c.width = w; c.height = h;
    const x = c.getContext("2d"), img = x.createImageData(w, h);
    const s0 = hash(seed) * 100;
    const n = (u, v, f) => Math.sin(u * f + s0) * Math.cos(v * f * 1.3 + s0 * 0.7) * 0.5 + 0.5;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const u = (i / w) * Math.PI * 2, v = (j / h) * Math.PI;
      // Latitude bands with turbulence, plus darker patches.
      const turb = n(u, v, 3) * 0.5 + n(u, v, 7) * 0.3 + n(u, v, 15) * 0.2;
      const band = Math.sin(v * 7 + turb * 3.2 + s0) * 0.5 + 0.5;
      const spot = Math.max(0, n(u + 1.7, v + 0.4, 5) - 0.62) * 2.4;
      const k = (j * w + i) * 4;
      for (let ch = 0; ch < 3; ch++) img.data[k + ch] = look.base[ch] + (look.band[ch] - look.base[ch]) * band * 0.8 - (look.base[ch] - look.spot[ch]) * spot;
      img.data[k + 3] = 255;
    }
    x.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = THREE.RepeatWrapping;
    return t;
  }
  function placeMoon(ao, t) {
    const a = ao.phase + (reduced ? 0 : t * ao.speed);
    ao.pos.set(Math.cos(a) * ao.orbitR, 0, Math.sin(a) * ao.orbitR).applyEuler(ao.plane).add(ao.co.center);
    ao.moon.position.copy(ao.pos); ao.moon.scale.setScalar(ao.size);
    ao.glow.position.copy(ao.pos);
    ao.orbitLine.position.copy(ao.co.center); ao.orbitLine.rotation.copy(ao.plane); ao.orbitLine.scale.setScalar(ao.orbitR);
    ao.label.position.copy(ao.pos).add(new THREE.Vector3(0, -ao.size - 0.55, 0));
  }

  // ---------------- sky model: planets, moons, satellites ----------------
  const companyObjs = new Map(); // prefix → {group, center, label, lines}
  const agentObjs = new Map();   // agentId → {star, label, pos, company, live, flare}
  const issueObjs = new Map();   // issueId → {sprite, label, orbit, arc, ...}
  const ufos = new Map();        // agentId → {group, state, t}
  const pickables = [];
  let portrait = false;

  function companyCenter(i) {
    return portrait
      ? [new THREE.Vector3(-5, 22, -54), new THREE.Vector3(5, 0, -54), new THREE.Vector3(-4, -22, -54)][i]
      : [new THREE.Vector3(-30, 2, -52), new THREE.Vector3(0, 6, -58), new THREE.Vector3(30, -1, -52)][i];
  }

  function syncSky() {
    const b = store.board;
    if (!b) return;
    const companies = b.companies;
    companies.forEach((c, ci) => {
      let co = companyObjs.get(c.prefix);
      if (!co) {
        // A planet: dark, restrained surface lit by one distant sun, thin rim, slow spin.
        const look = PLANET_LOOK[c.prefix] ?? PLANET_LOOK.default;
        const kind = { BOX: KIND.desert, CLA: KIND.rocky, VIS: KIND.ocean }[c.prefix] ?? KIND.rocky;
        const maps = bakePlanet(renderer, kind, hash(c.prefix) * 50, tier.mobile ? 1024 : 2048);
        // Matte: no specular hotspot, relief from the normal map along the terminator.
        const planet = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 48), new THREE.MeshStandardMaterial({ map: maps.map, normalMap: maps.normalMap, normalScale: new THREE.Vector2(0.5, 0.5), roughness: 1, metalness: 0 }));
        if (maps.clouds) {
          const clouds = new THREE.Mesh(new THREE.SphereGeometry(1.012, 96, 48), new THREE.MeshStandardMaterial({ map: maps.clouds, transparent: true, roughness: 1, metalness: 0, depthWrite: false }));
          clouds.userData.clouds = true;
          planet.add(clouds);
        }
        const rim = new THREE.Mesh(new THREE.SphereGeometry(1.025, 64, 32), new THREE.ShaderMaterial({
          transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.FrontSide,
          uniforms: { uColor: { value: new THREE.Color(look.rim) }, uSun: { value: SUN } },
          vertexShader: `varying vec3 vN; varying vec3 vV; varying vec3 vW; void main(){ vN = normalize(normalMatrix*normal); vec4 mv = modelViewMatrix*vec4(position,1.); vV = normalize(-mv.xyz); vW = normalize((modelMatrix*vec4(normal,0.)).xyz); gl_Position = projectionMatrix*mv; }`,
          fragmentShader: `uniform vec3 uColor; uniform vec3 uSun; varying vec3 vN; varying vec3 vV; varying vec3 vW;
            void main(){ float f = pow(1.0 - max(0.0, dot(vN, vV)), 10.0); float lit = smoothstep(0.05, 0.5, dot(vW, uSun)); gl_FragColor = vec4(uColor * f * lit * 0.5, 1.0); }`,
        }));
        const track = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(new THREE.Path().absarc(0, 0, 1, 0, Math.PI * 2).getSpacedPoints(128).map((p) => new THREE.Vector3(p.x, p.y, 0))), new THREE.LineBasicMaterial({ color: 0x404040, transparent: true, opacity: 0.35, depthWrite: false }));
        const ring = new THREE.Line(new THREE.BufferGeometry().setFromPoints(new THREE.Path().absarc(0, 0, 1, 0, Math.PI * 2).getSpacedPoints(128).map((p) => new THREE.Vector3(p.x, p.y, 0))), new THREE.LineBasicMaterial({ color: 0xb8b8b8, transparent: true, opacity: 0.7, depthWrite: false }));
        ring.geometry.setDrawRange(0, 0);
        co = { group: new THREE.Group(), planet, rim, track, ring, ringShown: 0, spin: 0.02 + hash(c.prefix) * 0.02, label: textSprite(c.name, { px: 46, worldH: 1.3, color: C.ink, weight: 500 }), prefix: c.prefix, name: c.name };
        co.group.add(planet, rim, track, ring, co.label);
        world.add(co.group);
        companyObjs.set(c.prefix, co);
      }
      co.center = companyCenter(ci);
      const openCount = c.issues.filter((i) => OPEN.includes(i.status)).length;
      co.radius = Math.min(5, 2 + openCount * 0.3);
      co.planet.position.copy(co.center); co.planet.scale.setScalar(co.radius);
      co.rim.position.copy(co.center); co.rim.scale.setScalar(co.radius);
      // The company's overall % is a thin ring around the planet.
      for (const r of [co.track, co.ring]) { r.position.copy(co.center); r.scale.setScalar(co.radius * 1.32); r.rotation.set(-1.25, 0, 0.18); }
      co.ringPct = companyProgress(c) ?? 0;
      co.label.position.copy(co.center).add(new THREE.Vector3(0, -co.radius - 2.0, 0));
      const cp = companyProgress(c);
      const cpText = cp == null ? "" : `~${cp}% overall · rough local-model estimate`;
      if (cpText !== co.pctText) {
        if (co.pct) co.group.remove(co.pct);
        co.pctText = cpText;
        co.pct = cpText ? textSprite(cpText, { px: 34, worldH: 0.55, color: C.ink2, weight: 400 }) : null;
        if (co.pct) co.group.add(co.pct);
      }
      if (co.pct) co.pct.position.copy(co.center).add(new THREE.Vector3(0, -co.radius - 3.0, 0));
      // Agents are moons orbiting the planet.
      const agents = store.agents.filter((a) => a.company === c.prefix);
      agents.forEach((a, ai) => {
        let ao = agentObjs.get(a.id);
        if (!ao) {
          const h = hash(a.id);
          const mm = bakePlanet(renderer, KIND.moon, h * 80, tier.mobile ? 256 : 512);
          const moon = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), new THREE.MeshStandardMaterial({ map: mm.map, normalMap: mm.normalMap, normalScale: new THREE.Vector2(0.7, 0.7), roughness: 1, metalness: 0, emissive: new THREE.Color(0.75, 0.82, 0.9), emissiveIntensity: 0 }));
          const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: psfSoft, color: new THREE.Color(0.8, 0.86, 0.92), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 }));
          const orbitLine = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(new THREE.Path().absarc(0, 0, 1, 0, Math.PI * 2).getSpacedPoints(96).map((p) => new THREE.Vector3(p.x, 0, p.y))), new THREE.LineBasicMaterial({ color: 0x3a3a3a, transparent: true, opacity: 0.4, depthWrite: false }));
          const label = textSprite(a.name, { px: 40, worldH: 0.62, color: C.ink, weight: 500 });
          world.add(moon, glow, orbitLine, label);
          ao = { id: a.id, moon, glow, orbitLine, label, company: c.prefix, h, pos: new THREE.Vector3(), phase: h * Math.PI * 2, speed: 0.025 + hash(a.id + "v") * 0.02,
            plane: new THREE.Euler(0.32 + (h - 0.5) * 0.25, 0, (hash(a.id + "z") - 0.5) * 0.3),
            tilt: new THREE.Euler((h - 0.5) * 1.2, h * 6.28, (hash(a.id + "z") - 0.5) * 0.8) };
          agentObjs.set(a.id, ao);
        }
        ao.co = co;
        ao.orbitR = co.radius + 3.2 + ai * 2.1;
        ao.size = 0.42 + hash(a.id + "s") * 0.18;
        ao.data = a;
        placeMoon(ao, clock);
      });
    });
    for (const [id, ao] of agentObjs) if (!store.agents.some((a) => a.id === id)) { world.remove(ao.moon, ao.glow, ao.orbitLine, ao.label); agentObjs.delete(id); }


    // Satellites: one per open issue, orbiting its assignee (or the constellation centre).
    const qIssues = new Set(allQuestions().map((x) => x.issue.id));
    const seen = new Set();
    for (const c of companies) {
      const co = companyObjs.get(c.prefix);
      for (const i of c.issues) {
        if (!OPEN.includes(i.status)) continue;
        seen.add(i.id);
        let io = issueObjs.get(i.id);
        if (!io) {
          const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: psfSoft, color: new THREE.Color(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
          const label = textSprite(i.identifier, { px: 36, worldH: 0.42, color: C.ink2, font: MONO, weight: 500 });
          const orbit = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(new THREE.Path().absarc(0, 0, 1, 0, Math.PI * 2).getSpacedPoints(64).map((p) => new THREE.Vector3(p.x, p.y, 0))), new THREE.LineBasicMaterial({ color: 0x7a8794, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false }));
          const arc = new THREE.Line(new THREE.BufferGeometry().setFromPoints(new THREE.Path().absarc(0, 0, 1, 0, Math.PI * 2).getSpacedPoints(96).map((p) => new THREE.Vector3(p.x, p.y, 0))), new THREE.LineBasicMaterial({ color: new THREE.Color(0.9, 0.92, 0.95), transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false }));
          arc.geometry.setDrawRange(0, 0);
          world.add(sprite, label, orbit, arc);
          io = { id: i.id, sprite, label, orbit, arc, phase: hash(i.id) * Math.PI * 2, speed: 0.08 + hash(i.id + "s") * 0.07, hidden: false, arcPct: -1 };
          issueObjs.set(i.id, io);
        }
        io.data = { ...i, company: c.prefix };
        io.hostAgent = agentObjs.get(i.assigneeAgentId) ?? null;
        io.center = io.hostAgent ? io.hostAgent.pos : co.center;
        io.tilt = io.hostAgent ? io.hostAgent.tilt : new THREE.Euler(0.5, hash(c.prefix) * 6, 0);
        io.radius = { in_review: 1.0, in_progress: 1.35, todo: 1.8, blocked: 1.6 }[i.status] + (hash(i.id + "r") - 0.5) * 0.2 + (io.hostAgent ? 0 : co.radius + 1.2);
        const prio = { critical: 1.0, urgent: 1.0, high: 0.85, medium: 0.68, low: 0.52 }[i.priority] ?? 0.6;
        io.size = prio * 0.7;
        io.question = qIssues.has(i.id);
        io.status = i.status;
        const col = { in_progress: [0.82, 0.88, 0.95, 1.1], in_review: [0.8, 0.8, 0.82, 0.7], todo: [0.6, 0.6, 0.62, 0.4], blocked: [0.9, 0.3, 0.18, 0.6] }[i.status];
        io.baseColor = new THREE.Color(col[0], col[1], col[2]).multiplyScalar(col[3]);
        io.orbit.position.copy(io.center);
        io.orbit.rotation.copy(io.tilt);
        io.orbit.scale.setScalar(io.radius);
        io.orbit.visible = i.status !== "blocked";
        const e = store.board.eta?.[i.identifier];
        io.arcPct = e && e.pct != null ? e.pct : -1;
        if (io.arcShown == null) io.arcShown = reduced ? io.arcPct : 0;
        const estimating = store.board.etaRunning?.includes(i.identifier);
        const pText = estimating && io.arcPct < 0 ? `${i.identifier} · estimating…` : io.arcPct >= 0 ? `${i.identifier} · ${io.arcPct}% · ${e.eta}${estimating ? " · estimating…" : ""}` : i.identifier;
        if (pText !== io.labelText) {
          io.labelText = pText;
          world.remove(io.label);
          const op = io.label.material.opacity;
          io.label = textSprite(pText, { px: 36, worldH: 0.42, color: C.ink2, font: MONO, weight: 500 });
          io.label.material.opacity = op;
          world.add(io.label);
        }
        io.arc.position.copy(io.center); io.arc.rotation.copy(io.tilt); io.arc.scale.setScalar(io.radius);
      }
    }
    for (const [id, io] of issueObjs) if (!seen.has(id)) { world.remove(io.sprite, io.label, io.orbit, io.arc); issueObjs.delete(id); }
    rebuildPickables();
    dirty = true;
  }

  function rebuildPickables() {
    pickables.length = 0;
    for (const co of companyObjs.values()) pickables.push({ kind: "company", id: co.prefix, pos: () => co.center, r: 80 });
    for (const ao of agentObjs.values()) pickables.push({ kind: "agent", id: ao.id, pos: () => ao.pos, r: 36 });
    for (const io of issueObjs.values()) pickables.push({ kind: "issue", id: io.id, pos: () => io.sprite.position, r: 26 });
  }

  const tmpV = new THREE.Vector3();
  function satellitePos(io, t, out) {
    if (io.status === "blocked") {
      // Stuck: an ember parked on its orbit, not moving.
      out.set(Math.cos(io.phase) * io.radius, Math.sin(io.phase) * io.radius, 0);
    } else {
      const a = io.phase + (reduced ? 0 : t * io.speed * (io.status === "in_progress" ? 1.4 : 1));
      out.set(Math.cos(a) * io.radius, Math.sin(a) * io.radius, 0);
    }
    return out.applyEuler(io.tilt).add(io.center);
  }

  // ---------------- camera rig with inertia ----------------
  const rig = {
    target: new THREE.Vector3(0, 3, -52), dist: 50, yaw: 0, pitch: 0, vyaw: 0, vpitch: 0,
    goal: { target: new THREE.Vector3(0, 3, -52), dist: 50 },
    follow: null, // function returning a live target (orbiting satellite)
    speed: 0,
  };
  const levelDist = () => ({ sky: portrait ? 88 : 78, company: portrait ? 34 : 30, agent: 8, issue: 4.5 });
  let view = { level: "sky", company: null, agent: null, issue: null };

  function flyTo(target, dist, follow = null) {
    rig.goal.target.copy(target);
    rig.goal.dist = dist;
    rig.follow = follow;
    if (reduced) { rig.target.copy(target); rig.dist = dist; }
    rig.vyaw *= 0.3; rig.vpitch *= 0.3;
    dirty = true; activeUntil = performance.now() + 2500;
  }

  function goSky() {
    view = { level: "sky", company: null, agent: null, issue: null };
    flyTo(new THREE.Vector3(0, portrait ? 0 : 3, -52), levelDist().sky);
    closeSlate();
  }
  function goCompany(prefix) {
    const co = companyObjs.get(prefix); if (!co) return;
    view = { level: "company", company: prefix, agent: null, issue: null };
    flyTo(co.center, levelDist().company);
    closeSlate();
  }
  function goAgent(id) {
    const ao = agentObjs.get(id); if (!ao) return;
    view = { level: "agent", company: ao.company, agent: id, issue: null };
    flyTo(ao.pos.clone(), levelDist().agent, () => ao.pos);
    chat.agent = id; chat.scroll = 0; chat.issueId = null; chat.expanded.clear();
    openSlate("chat");
  }
  function goIssue(id) {
    const io = issueObjs.get(id); if (!io) return;
    view = { level: "issue", company: io.data.company, agent: io.hostAgent?.id ?? null, issue: id };
    flyTo(io.sprite.position.clone(), levelDist().issue, () => io.sprite.position);
    if (io.question) seenQuestions.add(id);
    openSlate("issue");
  }
  function backOut() {
    if (view.level === "issue" && view.agent) return goAgent(view.agent);
    if (view.level === "issue" || view.level === "agent") return view.company ? goCompany(view.company) : goSky();
    if (view.level === "company") return goSky();
    if (slate.kind && !slate.forced) closeSlate();
  }

  // ---------------- glass overlay: plates ----------------
  const plateVert = `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
  const plateFrag = `
    uniform sampler2D map; uniform float uReveal, uWipe, uOpacity, uAspect, uOffset, uRepeat; varying vec2 vUv;
    float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float n2(vec2 p) { vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f); return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
    float fbm(vec2 p) { return n2(p) * 0.55 + n2(p * 2.3) * 0.3 + n2(p * 5.1) * 0.15; }
    void main() {
      vec2 uv = vec2(fract(vUv.x * uRepeat + uOffset), vUv.y);
      vec4 t = texture2D(map, uv);
      float n = fbm(vUv * vec2(uAspect, 1.0) * 6.0);
      float front = uReveal * 1.08;                                          // boot: a scan line sweeps down
      float r = step(1.0 - vUv.y, front);
      float line = (1.0 - smoothstep(0.0, 0.012, abs((1.0 - vUv.y) - front))) * (1.0 - step(1.0, uReveal));
      float w = smoothstep(uWipe * 1.3 - 0.2, uWipe * 1.3, vUv.x + n * 0.2); // wiped away left to right
      gl_FragColor = vec4(t.rgb + line * 0.6, (t.a * r + line * 0.5) * w * uOpacity);
    }`;

  class Plate {
    constructor(name) {
      this.name = name;
      this.canvas = document.createElement("canvas");
      this.ctx = this.canvas.getContext("2d");
      this.tex = new THREE.CanvasTexture(this.canvas);
      this.tex.colorSpace = THREE.NoColorSpace;
      this.tex.minFilter = THREE.LinearFilter;
      this.mat = new THREE.ShaderMaterial({
        vertexShader: plateVert, fragmentShader: plateFrag, transparent: true, depthTest: false, depthWrite: false,
        uniforms: { map: { value: this.tex }, uReveal: { value: 1 }, uWipe: { value: 0 }, uOpacity: { value: 1 }, uAspect: { value: 1 }, uOffset: { value: 0 }, uRepeat: { value: 1 } },
      });
      this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.mat);
      glass.add(this.mesh);
      this.rect = { x: 0, y: 0, w: 1, h: 1 };
      this.hot = [];
      this.visible = true;
    }
    place(x, y, w, h) {
      w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
      const changed = w !== this.rect.w || h !== this.rect.h;
      this.rect = { x, y, w, h };
      this.mesh.position.set(x + w / 2, -(y + h / 2), 0);
      this.mesh.scale.set(w, h, 1);
      this.mat.uniforms.uAspect.value = w / h;
      if (changed) {
        const r = Math.min(2, devicePixelRatio || 1);
        this.canvas.width = Math.round(w * r); this.canvas.height = Math.round(h * r);
        this.scale = r;
        // GPU storage is fixed at first upload, so a resized canvas needs a new texture.
        this.tex.dispose();
        this.tex = new THREE.CanvasTexture(this.canvas);
        this.tex.colorSpace = THREE.NoColorSpace;
        this.tex.minFilter = THREE.LinearFilter;
        this.mat.uniforms.map.value = this.tex;
      }
      return changed;
    }
    begin() {
      const x = this.ctx;
      x.setTransform(this.scale, 0, 0, this.scale, 0, 0);
      x.clearRect(0, 0, this.rect.w, this.rect.h);
      this.hot = [];
      return x;
    }
    end() { this.tex.needsUpdate = true; dirty = true; }
    show(v) { this.visible = v; this.mesh.visible = v; dirty = true; }
    hit(px, py) {
      const r = this.rect;
      if (!this.visible || px < r.x || py < r.y || px > r.x + r.w || py > r.y + r.h) return null;
      const lx = px - r.x, ly = py - r.y;
      return { lx, ly, spot: this.hot.find((s) => lx >= s.x && lx <= s.x + s.w && ly >= s.y && ly <= s.y + s.h) ?? null };
    }
  }

  function frostPatch(x, w, h, r = 18) {
    // Near-black backing so the floating text stays readable over stars.
    x.save();
    x.fillStyle = "rgba(0,0,0,0.78)";
    rr(x, 0.5, 0.5, w - 1, h - 1, Math.min(r, 6)); x.fill();
    x.strokeStyle = "rgba(200,204,208,0.12)"; x.lineWidth = 1; x.stroke();
    x.restore();
  }
  function rr(x, a, b, w, h, r) { x.beginPath(); x.moveTo(a + r, b); x.arcTo(a + w, b, a + w, b + h, r); x.arcTo(a + w, b + h, a, b + h, r); x.arcTo(a, b + h, a, b, r); x.arcTo(a, b, a + w, b, r); x.closePath(); }

  const wrapCache = new Map();
  function wrap(x, text, maxW) {
    const k = x.font + "|" + maxW + "|" + text;
    const hit = wrapCache.get(k); if (hit) return hit;
    const out = [];
    for (const para of String(text).split("\n")) {
      if (!para.trim()) { out.push(""); continue; }
      let line = "";
      for (const word of para.split(/(\s+)/)) {
        const test = line + word;
        if (x.measureText(test).width <= maxW || !line.trim()) { line = test; }
        else { out.push(line.trimEnd()); line = word.trimStart(); }
        while (x.measureText(line).width > maxW && line.length > 1) {
          let k2 = Math.max(1, Math.floor(line.length * maxW / x.measureText(line).width));
          while (k2 > 1 && x.measureText(line.slice(0, k2)).width > maxW) k2--;
          out.push(line.slice(0, k2)); line = line.slice(k2);
        }
      }
      out.push(line.trimEnd());
    }
    if (wrapCache.size > 4000) wrapCache.clear();
    wrapCache.set(k, out);
    return out;
  }

  // Light markdown → styled lines.
  function mdLines(text) {
    const out = []; let fence = false;
    for (let raw of String(text).split("\n")) {
      if (/^\s*```/.test(raw)) { fence = !fence; continue; }
      if (fence) { out.push({ text: raw, mono: true }); continue; }
      const head = /^\s*#{1,6}\s+/.test(raw);
      raw = raw.replace(/^\s*#{1,6}\s+/, "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/^\s*[-*]\s+/, "• ").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
      out.push({ text: raw, bold: head });
    }
    return out;
  }

  // ---------------- document layout for the main slate ----------------
  // items: {t:'text', text, size, color, weight, mono, tap, born, max}, {t:'gap', h}, {t:'tiles', tiles:[{label, sel, tone, tap}]},
  //        {t:'field', key, text, placeholder, tap}, {t:'qr', m}, {t:'rule'}
  function measure(x, items, W) {
    let y = 0;
    for (const it of items) {
      it.y = y;
      if (it.t === "gap") it.h = it.h ?? 8;
      else if (it.t === "rule") it.h = 13;
      else if (it.t === "text") {
        const size = it.size ?? 15;
        x.font = `${it.weight ?? 400} ${size}px ${it.mono ? MONO : SANS}`;
        let lines = wrap(x, it.text, W - (it.indent ?? 0));
        if (it.max && lines.length > it.max) { lines = lines.slice(0, it.max); lines[it.max - 1] += " …"; }
        it.lines = lines; it.lh = Math.round(size * (it.mono ? 1.45 : 1.55)); it.h = lines.length * it.lh + 2;
      } else if (it.t === "tiles") {
        x.font = `500 15px ${SANS}`;
        let cx = 0, cy = 0; const rowH = 40;
        for (const tl of it.tiles) {
          const w = Math.min(W, Math.ceil(x.measureText(tl.label).width) + 30);
          if (cx + w > W && cx > 0) { cx = 0; cy += rowH + 8; }
          tl.x = cx; tl.y = cy; tl.w = w; tl.h = rowH; cx += w + 8;
        }
        it.h = cy + rowH + 4;
      } else if (it.t === "field") {
        x.font = it.mono ? `400 14px ${MONO}` : `400 16px ${SANS}`;
        const lines = wrap(x, (it.prompt ?? "") + (it.text || it.placeholder) + (it.editing ? "|" : ""), W - 24 - (it.tag ? 90 : 0));
        it.lines = lines.slice(-6); it.h = Math.max(48, it.lines.length * 22 + 26);
      } else if (it.t === "comms") it.h = 40;
      else if (it.t === "qr") it.h = Math.min(W, 320) + 8;
      else if (it.t === "meter") it.h = 10;
      y += it.h;
    }
    return y;
  }

  function drawItems(x, items, ox, oy, W, clipTop, clipBot, plate, now) {
    for (const it of items) {
      const top = oy + it.y;
      if (top + it.h < clipTop || top > clipBot) continue;
      let alpha = it.alpha ?? 1;
      if (it.born && !reduced) alpha *= Math.min(1, (now - it.born) / 700);
      x.globalAlpha = alpha;
      if (it.t === "text") {
        const size = it.size ?? 15;
        x.font = `${it.weight ?? 400} ${size}px ${it.mono ? MONO : SANS}`;
        x.fillStyle = it.color ?? C.ink; x.textBaseline = "top";
        it.lines.forEach((l, k) => {
          const ly = top + k * it.lh;
          if (ly + it.lh < clipTop || ly > clipBot) return;
          let slide = 0;
          if (it.born && !reduced) { const kk = Math.min(1, Math.max(0, (now - it.born - k * 60) / 260)); x.globalAlpha = alpha * kk; slide = (1 - kk) * 8; }
          x.fillText(l, ox + (it.indent ?? 0) + slide, ly + 1);
        });
        if (it.tap) plate.hot.push({ x: ox, y: Math.max(top, clipTop), w: W, h: Math.min(it.h, clipBot - top), fn: it.tap });
      } else if (it.t === "comms") {
        const pulse = reduced ? 1 : 0.5 + 0.5 * Math.sin(now / 260);
        x.font = `400 11.5px ${MONO}`; x.textBaseline = "top"; x.fillStyle = C.ink;
        x.fillText(it.name.toUpperCase(), ox, top + 2);
        const nw = x.measureText(it.name.toUpperCase()).width;
        if (it.live) {
          x.fillStyle = `rgba(226,230,234,${0.35 + 0.65 * pulse})`; x.beginPath(); x.arc(ox + nw + 14, top + 9, 3.2, 0, 6.28); x.fill();
          x.font = `500 10.5px ${MONO}`; x.fillStyle = C.ice; x.fillText("LIVE", ox + nw + 22, top + 4);
          slate.animUntil = Math.max(slate.animUntil, now + 120);
        } else { x.font = `500 10.5px ${MONO}`; x.fillStyle = C.ink3; x.fillText(it.queued ? "QUEUED" : "IDLE", ox + nw + 12, top + 4); }
        x.font = `400 10.5px ${MONO}`; x.fillStyle = C.ink3;
        const sub = wrap(x, it.sub, W)[0] ?? "";
        x.fillText(sub, ox, top + 22);
      } else if (it.t === "meter") {
        x.fillStyle = "rgba(255,255,255,0.08)"; rr(x, ox, top + 3, W, 4, 2); x.fill();
        x.fillStyle = it.pct > 85 ? C.amber : "#8c8c8c"; rr(x, ox, top + 3, Math.max(4, W * it.pct / 100), 4, 2); x.fill();
      } else if (it.t === "rule") {
        x.strokeStyle = "rgba(255,255,255,0.07)"; x.beginPath(); x.moveTo(ox, top + 6.5); x.lineTo(ox + W, top + 6.5); x.stroke();
      } else if (it.t === "tiles") {
        for (const tl of it.tiles) {
          const tx = ox + tl.x, ty = top + tl.y;
          x.save();
          const tone = tl.tone === "amber" ? "222,170,96" : tl.tone === "ember" ? "200,104,82" : "184,184,184";
          x.fillStyle = tl.sel ? `rgba(${tone},0.16)` : "rgba(20,20,20,0.9)";
          rr(x, tx + 0.5, ty + 0.5, tl.w - 1, tl.h - 1, 10); x.fill();
          x.strokeStyle = `rgba(${tone},${tl.sel ? 0.7 : 0.25})`; x.lineWidth = tl.sel ? 1.5 : 1; x.stroke();
          x.font = `${tl.sel ? 600 : 500} 15px ${SANS}`; x.fillStyle = tl.disabled ? C.ink3 : C.ink; x.textBaseline = "middle";
          x.fillText(tl.label, tx + 15, ty + tl.h / 2 + 1);
          x.restore();
          if (tl.tap && !tl.disabled) plate.hot.push({ x: tx, y: ty, w: tl.w, h: tl.h, fn: tl.tap });
        }
      } else if (it.t === "field") {
        x.save();
        x.fillStyle = it.editing ? "rgba(30,30,30,0.95)" : "rgba(16,16,16,0.9)";
        rr(x, ox + 0.5, top + 0.5, W - 1, it.h - 1, 10); x.fill();
        x.strokeStyle = it.editing ? "rgba(226,230,234,0.55)" : "rgba(184,184,184,0.18)"; x.stroke();
        x.font = it.mono ? `400 14px ${MONO}` : `400 16px ${SANS}`; x.textBaseline = "top";
        if (it.tag) { x.save(); x.font = `500 11px ${MONO}`; x.fillStyle = C.ink2; x.textAlign = "right"; x.fillText(it.tag, ox + W - 10, top + 15); x.restore(); if (it.tagTap) plate.hot.push({ x: ox + W - 90, y: top, w: 90, h: it.h, fn: it.tagTap }); }
        it.lines.forEach((l, k) => {
          const caret = it.editing && k === it.lines.length - 1 && l.endsWith("|");
          const txt = caret ? l.slice(0, -1) : l;
          x.fillStyle = it.text ? C.ink : C.ink3;
          x.fillText(txt, ox + 12, top + 13 + k * 22);
          if (caret && Math.floor(now / 530) % 2 === 0) { const cw = x.measureText(txt).width; x.fillStyle = "#e2e6ea"; x.fillRect(ox + 13 + cw, top + 12 + k * 22, 2, 19); }
        });
        x.restore();
        if (it.tap) plate.hot.push({ x: ox, y: top, w: W, h: it.h, fn: it.tap });
      } else if (it.t === "qr") {
        // Condensation patch with the code wiped out of it: dark modules on frost, quiet zone included.
        const n = it.m.length, size = Math.min(W, 320), cell = Math.floor(size / (n + 8)), full = cell * (n + 8);
        const qx = ox + Math.round((W - full) / 2), qy = top;
        x.fillStyle = "rgba(226,234,240,0.97)"; rr(x, qx, qy, full, full, 8); x.fill();
        x.fillStyle = "#040506";
        for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (it.m[r][c]) x.fillRect(qx + (c + 4) * cell, qy + (r + 4) * cell, cell, cell);
        // A few star glints on the finder corners (outside the modules, so it still scans).
        x.fillStyle = "rgba(255,255,255,0.9)";
        for (const [gx, gy] of [[2, 2], [n + 5, 2], [2, n + 5]]) { x.beginPath(); x.arc(qx + gx * cell + cell / 2, qy + gy * cell + cell / 2, cell * 0.35, 0, 6.28); x.fill(); }
      }
    }
    x.globalAlpha = 1;
  }

  // ---------------- main slate ----------------
  const slate = { plate: new Plate("slate"), kind: null, forced: false, scroll: 0, maxScroll: 0, openedAt: 0, wipeAt: 0, onWiped: null, editing: null, animUntil: 0, area: { x: 0, y: 0, w: 0, h: 0 } };
  slate.plate.show(false);
  const leader = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: 0x9a9ea2, transparent: true, opacity: 0.55 }));
  leader.visible = false; glass.add(leader);
  const chat = { agent: null, scroll: 0, issueId: null, expanded: new Set(), more: new Set(), born: new Map(), shown: new Map(), draft: "" };
  // Streaming: reveal new text at ~60-120 chars/s (faster for long messages).
  function advanceStreams(dt) {
    if (slate.kind !== "chat") return;
    for (const m of messagesFor(chat.agent).slice(-120)) {
      const full = m.role === "tool" ? (m.input || "").length + m.toolName.length + 3 : (m.text || "").length;
      const cur = chat.shown.get(m.id);
      if (cur == null || cur >= full) continue;
      const left = full - cur;
      const cps = Math.min(900, 70 + left * 0.9);
      chat.shown.set(m.id, reduced ? full : Math.min(full, cur + Math.max(1, cps * dt)));
    }
  }
  const drafts = {}; // question id → {sel, text}
  const sentQ = new Set();
  const seenQuestions = new Set();
  let notice = "";

  function openSlate(kind, forced = false) {
    slate.kind = kind; slate.forced = forced; slate.scroll = 0; slate.openedAt = performance.now();
    slate.plate.mat.uniforms.uWipe.value = 0;
    stopEditing();
    layout(); drawSlate();
    slate.plate.show(true);
  }
  function closeSlate() {
    if (slate.forced) return;
    stopEditing();
    slate.kind = null; slate.plate.show(false); layout();
  }
  function wipeSlate(then) { slate.wipeAt = performance.now(); slate.onWiped = then; activeUntil = performance.now() + 1200; }

  function startEditing(target, initial = "") {
    slate.editing = target;
    kbd.value = initial;
    kbd.enterKeyHint = target.kind === "pair" ? "done" : "send";
    kbd.focus({ preventScroll: true });
    try { kbd.setSelectionRange(initial.length, initial.length); } catch {}
    drawSlate();
  }
  function stopEditing() { if (slate.editing) { slate.editing = null; kbd.blur(); } }

  kbd.addEventListener("input", () => {
    const e = slate.editing; if (!e) return;
    if (e.kind === "chat") chat.draft = kbd.value;
    else if (e.kind === "answer") (drafts[e.key] ||= { sel: {}, text: "" }).text = kbd.value;
    else if (e.kind === "pair" && kbd.value.trim().length > 40) { submitPair(kbd.value); return; }
    else if (e.kind === "helper") { /* text lives in kbd.value until sent */ }
    drawSlate();
  });
  kbd.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") { stopEditing(); drawSlate(); return; }
    if (ev.key !== "Enter" || ev.shiftKey) return;
    ev.preventDefault();
    const e = slate.editing; if (!e) return;
    if (e.kind === "chat") sendChat();
    else if (e.kind === "answer") sendAnswer(e.key, "qcomment");
    else if (e.kind === "pair") submitPair(kbd.value);
    else if (e.kind === "helper") { const t = kbd.value.trim(); stopEditing(); if (t) helperAsk(e.key, t); drawSlate(); }
  });
  kbd.addEventListener("blur", () => { setTimeout(() => { if (document.activeElement !== kbd && slate.editing) { slate.editing = null; drawSlate(); } }, 50); });

  async function submitPair(text) {
    stopEditing();
    try { await applyAnswer(text); notice = ""; } catch (e) { notice = e.message; }
    drawSlate();
  }

  function agentIssues(a) {
    if (!a) return [];
    const list = [];
    if (a.issueId) list.push({ id: a.issueId, identifier: a.issue, title: a.issueTitle });
    for (const i of a.openIssues ?? []) if (!list.some((x) => x.id === i.id)) list.push(i);
    return list;
  }

  async function sendChat() {
    const a = store.agents.find((x) => x.id === chat.agent);
    const issues = agentIssues(a);
    const target = issues.find((i) => i.id === chat.issueId) ?? issues[0];
    const text = chat.draft.trim();
    if (!text || !target) return;
    stopEditing();
    try {
      await act("comment", { issueId: target.id, text });
      floatToStar(text, chat.agent);
      chat.draft = ""; notice = `Sent as a comment on ${target.identifier}.`;
    } catch (e) { notice = "Not sent: " + e.message; }
    drawSlate();
  }

  async function sendAnswer(qid, kind) {
    const found = allQuestions().find((x) => x.q.id === qid); if (!found) return;
    stopEditing();
    try {
      await answerQuestion(found, kind, drafts[qid] ||= { sel: {}, text: "" });
      feedAdd({ ts: new Date().toISOString(), company: found.company.prefix, text: `▲ ${found.issue.identifier} answer sent`, tone: "+", issueId: found.issue.id });
      wipeSlate(() => { sentQ.add(qid); notice = "Sent."; slate.openedAt = performance.now(); drawSlate(); });
    } catch (e) { notice = e.message; drawSlate(); }
  }

  async function estimate(identifier) {
    try { await act("eta", { issue: identifier }); notice = `Estimating ${identifier} with the local model…`; }
    catch (e) { notice = "Estimate failed: " + e.message; }
    drawSlate();
  }

  function etaLine(id) {
    const e = store.board?.eta?.[id];
    if (!e || e.pct == null) return null;
    return `~${e.pct}% · ETA ${e.eta} · rough local-model estimate, estimated ${ago(e.at)}`;
  }

  function buildDoc(W, now) {
    const head = [], body = [], foot = [];
    const b = store.board;
    const close = (label = "close") => ({ t: "tiles", tiles: [{ label, tap: () => backOut() }] });
    if (slate.kind === "link") {
      const l = store.link;
      head.push({ t: "text", text: "Pair with your Mac", size: 20, weight: 600 });
      if (l.state === "answer" || l.state === "connecting") {
        body.push({ t: "text", text: "Copy this code and paste it into the board on your Mac (tap the small square glyph next to the moon there).", color: C.ink2 }, { t: "gap", h: 10 });
        body.push({ t: "text", text: l.answer, mono: true, size: 11.5, color: C.frost, tap: async () => { await copyText(l.answer); notice = "Copied."; drawSlate(); } });
        body.push({ t: "gap", h: 12 }, { t: "tiles", tiles: [{ label: "Copy code", tone: "ice", sel: true, tap: async () => { await copyText(l.answer); notice = "Copied. Paste it on your Mac."; drawSlate(); } }] });
        if (l.state === "connecting") body.push({ t: "text", text: "Connecting…", color: C.ice });
      } else if (l.state === "making") body.push({ t: "text", text: "Preparing the link…", color: C.ink2 });
      else body.push({ t: "text", text: l.error || "Open this page from the QR code on your Mac's board.", color: l.error ? C.ember : C.ink2 });
      if (notice) body.push({ t: "gap", h: 8 }, { t: "text", text: notice, color: C.ice });
      return { head, body, foot };
    }
    if (slate.kind === "pair") {
      const p = store.pair;
      head.push({ t: "text", text: "Pair a phone", size: 20, weight: 600 });
      if (p.qr && p.state !== "connected") {
        body.push({ t: "text", text: "Scan this with your phone's camera. It opens the phone page, which shows a reply code.", color: C.ink2 }, { t: "gap", h: 10 }, { t: "qr", m: p.qr }, { t: "gap", h: 10 });
        const editing = slate.editing?.kind === "pair";
        body.push({ t: "field", text: editing ? kbd.value : "", placeholder: "Tap here and paste the code from your phone", editing, tap: () => startEditing({ kind: "pair" }) });
      }
      const st = { making: "Preparing…", waiting: "Waiting for the phone's code.", connecting: "Connecting…", connected: "Phone connected. It sees this board live.", closed: "Phone disconnected.", failed: "" }[p.state] ?? "";
      body.push({ t: "gap", h: 8 }, { t: "text", text: st, color: p.state === "connected" ? C.ice : C.ink2 });
      if (p.error) body.push({ t: "text", text: p.error, color: C.ember });
      if (notice) body.push({ t: "text", text: notice, color: C.ember });
      const tiles = [];
      if (p.state !== "idle") tiles.push({ label: "Disconnect", tone: "ember", tap: () => { stopPairing(); closeSlate(); } });
      if (p.state === "closed" || p.state === "failed") tiles.push({ label: "New code", tap: () => startPairing() });
      tiles.push({ label: "close", tap: () => closeSlate() });
      foot.push({ t: "tiles", tiles });
      return { head, body, foot };
    }
    if (slate.kind === "notice") {
      head.push({ t: "text", text: "Observatory", size: 20, weight: 600 });
      body.push({ t: "text", text: notice || "Waiting for data…", color: C.ink2 });
      return { head, body, foot };
    }
    if (slate.kind === "chat") {
      // Comms panel: mono header, streamed agent text, tool calls as command lines.
      const a = store.agents.find((x) => x.id === chat.agent);
      if (!a) { body.push({ t: "text", text: "This agent is no longer on the board." }); return { head, body, foot: [close()] }; }
      const issues = agentIssues(a);
      const target = issues.find((i) => i.id === chat.issueId) ?? issues[0];
      head.push({ t: "comms", name: a.name, live: a.live, queued: a.queued, sub: `${a.company}${a.issue ? " · " + a.issue : ""}${a.issueTitle ? " · " + a.issueTitle : ""}` });
      head.push({ t: "rule" });
      const msgs = messagesFor(a.id).slice(-120);
      const n = msgs.length;
      let streaming = false;
      msgs.forEach((m, k) => {
        if (!chat.born.has(m.id)) chat.born.set(m.id, now);
        const born = chat.born.get(m.id);
        const age = (n - 1 - k) / Math.max(1, n);
        const fade = Math.max(0.5, 1 - age * 1.2);
        const t = new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        const full = m.role === "tool" ? `> ${m.toolName} ${(m.input || "").replace(/\s+/g, " ")}` : (m.text || "");
        if (!chat.shown.has(m.id)) chat.shown.set(m.id, reduced || now - slate.openedAt < 400 ? full.length : 0);
        let shown = Math.min(full.length, chat.shown.get(m.id));
        if (shown < full.length) streaming = true;
        const part = full.slice(0, shown);
        const cursor = shown < full.length ? "▌" : "";
        if (m.role === "tool") {
          const open = chat.expanded.has(m.id);
          const mark = m.status === "failed" ? "✗" : m.status === "completed" ? "✓" : "·";
          body.push({ t: "text", text: `${mark} ${part.slice(0, 64)}${part.length > 64 ? "…" : ""}${cursor}`, mono: true, size: 11, color: m.status === "failed" ? C.ember : C.ink3, alpha: fade, born, max: 1, tap: () => { open ? chat.expanded.delete(m.id) : chat.expanded.add(m.id); drawSlate(); } });
          if (open) {
            if (m.input) body.push({ t: "text", text: m.input.slice(0, 1500), mono: true, size: 11.5, color: C.ink2, indent: 14, max: 24 });
            if (m.output) {
              const more = chat.more.has(m.id);
              body.push({ t: "text", text: m.output.slice(0, more ? 8000 : 2000), mono: true, size: 11.5, color: C.ink3, indent: 14, max: more ? 160 : 40 });
              if (m.output.length > 2000 && !more) body.push({ t: "text", text: "show more", size: 12, color: C.ice, indent: 14, tap: () => { chat.more.add(m.id); drawSlate(); } });
            }
          }
          return;
        }
        if (m.role === "system") { body.push({ t: "text", text: `${t}  ${part}${cursor}`, mono: true, size: 11, color: C.ink3, alpha: fade * 0.8, born, max: 2 }); return; }
        if (m.role === "result") { body.push({ t: "text", text: `${t}  ■ ${part}${cursor}`, mono: true, size: 11.5, color: C.ink2, alpha: fade, born }, { t: "gap", h: 6 }); return; }
        const who = m.role === "comment" ? (m.fromUser ? "YOU" : (m.agentName ?? "agent").toUpperCase()) + ` · COMMENT ${m.issue ?? ""}` : (m.agentName ?? "agent").toUpperCase();
        body.push({ t: "gap", h: 12 }, { t: "text", text: `${t}  ${who}`, mono: true, size: 10, color: m.fromUser ? C.amber : C.ink3, alpha: fade, born });
        const lines = mdLines(part.slice(-3000));
        lines.forEach((ln, li) => body.push({ t: "text", text: ln.text + (li === lines.length - 1 ? cursor : ""), mono: ln.mono, size: ln.mono ? 11.5 : 14, weight: ln.bold ? 600 : 400, color: m.fromUser ? C.ink : C.ink, alpha: fade, born }));
      });
      if (streaming) slate.animUntil = Math.max(slate.animUntil, now + 120);
      if (!n) body.push({ t: "text", text: "No transmissions yet in the runs and comments this board keeps.", color: C.ink2, mono: true, size: 12 });
      if (target) {
        const editing = slate.editing?.kind === "chat";
        foot.push({ t: "field", mono: true, text: chat.draft, prompt: "> ", tag: `[${target.identifier}${issues.length > 1 ? " ⇄" : ""}]`, tagTap: issues.length > 1 ? () => { const k2 = issues.indexOf(target); chat.issueId = issues[(k2 + 1) % issues.length].id; drawSlate(); } : null, placeholder: `message to ${a.name}…`, editing, tap: () => startEditing({ kind: "chat" }, chat.draft) });
        foot.push({ t: "text", text: `enter sends a comment on ${target.identifier}${issues.length > 1 ? " · tap the tag to switch issue" : ""} · double-tap the sky to go back`, mono: true, size: 10, color: C.ink3 });
      } else foot.push({ t: "text", text: "No open issue to comment on.", color: C.ink3, size: 13 }, close("back"));
      if (notice) foot.push({ t: "text", text: notice, size: 11.5, mono: true, color: C.ice });
      return { head, body, foot, anchor: "bottom" };
    }
    if (slate.kind === "issue") {
      const io = issueObjs.get(view.issue);
      const i = io?.data;
      if (!i) { body.push({ t: "text", text: "This issue is closed now." }); return { head, body, foot: [close("back")] }; }
      const stColor = { in_progress: C.ice, blocked: C.ember, in_review: C.frost, todo: C.ink2 }[i.status];
      head.push({ t: "text", text: `${i.identifier} · ${STATUS[i.status]} · ${i.priority} priority`, size: 13, color: stColor, mono: true });
      head.push({ t: "text", text: i.title, size: 19, weight: 600 });
      body.push({ t: "text", text: `${i.assignee ? "With " + i.assignee : "Unassigned"} · updated ${ago(i.updatedAt)}`, size: 13, color: C.ink2 }, { t: "gap", h: 8 });
      const running = b.etaRunning?.includes(i.identifier);
      const el = etaLine(i.identifier);
      if (el) body.push({ t: "text", text: el, color: C.ice, size: 14 });
      const e = b.eta?.[i.identifier];
      if (e?.note) body.push({ t: "text", text: e.note, color: C.ink2, size: 13 });
      if (e?.done?.length) body.push({ t: "text", text: "Done: " + e.done.join("; "), color: C.ink2, size: 13, max: 6 });
      if (e?.left?.length) body.push({ t: "text", text: "Left: " + e.left.join("; "), color: C.ink2, size: 13, max: 6 });
      if (e?.error && (!e.at || e.errorAt > e.at)) body.push({ t: "text", text: "Last estimate failed: " + e.error, color: C.ember, size: 13 });
      body.push({ t: "tiles", tiles: [{ label: running ? "⌖ estimating…" : el ? "⌖ estimate again" : "⌖ estimate (local model)", disabled: running, tap: () => estimate(i.identifier) }] });
      // Questions on this issue condense here.
      for (const { q } of allQuestions().filter((x) => x.issue.id === i.id)) {
        body.push({ t: "rule" });
        if (sentQ.has(q.id)) { body.push({ t: "text", text: "Sent.", color: C.ice, weight: 600 }); continue; }
        const d = (drafts[q.id] ||= { sel: {}, text: "" });
        body.push({ t: "text", text: "Waiting for you", size: 12, color: C.amber, weight: 600 });
        if (q.title) body.push({ t: "text", text: q.title, weight: 600 });
        if (q.kind === "ask_user_questions") {
          for (const qq of q.payload.questions || []) {
            body.push({ t: "gap", h: 6 }, { t: "text", text: qq.prompt + (qq.selectionMode === "multi" ? " (pick any)" : ""), weight: 500 });
            if (qq.helpText) body.push({ t: "text", text: qq.helpText, size: 13, color: C.ink2 });
            body.push({ t: "tiles", tiles: qq.options.map((o) => ({ label: o.label + (o.recommended ? " ★" : ""), tone: "amber", sel: (d.sel[qq.id] || []).includes(o.id), tap: () => {
              const cur = d.sel[qq.id] || [];
              d.sel[qq.id] = qq.selectionMode === "multi" ? (cur.includes(o.id) ? cur.filter((x) => x !== o.id) : [...cur, o.id]) : [o.id];
              const single = (q.payload.questions || []).length === 1 && qq.selectionMode === "single";
              if (single) sendAnswer(q.id, "respond"); else drawSlate();
            } })) });
          }
          if ((q.payload.questions || []).length > 1 || q.payload.questions?.some((qq) => qq.selectionMode === "multi")) body.push({ t: "tiles", tiles: [{ label: "Send answer", tone: "amber", sel: true, tap: () => sendAnswer(q.id, "respond") }] });
        } else {
          const p = q.payload || {};
          body.push({ t: "text", text: p.prompt || "", weight: 500 });
          if (p.detailsMarkdown) for (const ln of mdLines(p.detailsMarkdown).slice(0, 60)) body.push({ t: "text", text: ln.text, mono: ln.mono, size: ln.mono ? 12 : 13.5, color: C.ink2, weight: ln.bold ? 600 : 400 });
          body.push({ t: "gap", h: 6 }, { t: "tiles", tiles: [
            { label: p.acceptLabel || "Accept", tone: "amber", sel: true, tap: () => sendAnswer(q.id, "accept") },
            { label: p.rejectLabel || "Reject", tone: "ember", tap: () => sendAnswer(q.id, "reject") },
          ] });
          if (p.rejectRequiresReason) body.push({ t: "text", text: "Rejecting needs a reason: write it below first.", size: 12.5, color: C.ink2 });
        }
        // Local model briefing condenses under the question.
        if (!helperState.has(q.id)) helperBrief(q.id);
        body.push({ t: "gap", h: 8 });
        for (const l of helperLines(q.id)) {
          if (l.kind === "meter") body.push({ t: "meter", pct: l.pct }, { t: "text", text: l.text, size: 11.5, color: C.ink3 });
          else body.push({ t: "text", text: l.text, size: l.kind === "head" ? 12 : 13.5, weight: l.kind === "head" || l.kind === "q" ? 600 : 400, color: { head: C.ice, dim: C.ink3, amber: C.amber, q: C.ink, a: C.frost, body: C.ink2 }[l.kind] });
        }
        const asking = slate.editing?.kind === "helper" && slate.editing.key === q.id;
        body.push({ t: "field", text: asking ? kbd.value : "", placeholder: "Tap to ask the local model about this", editing: asking, tap: () => startEditing({ kind: "helper", key: q.id }) });
        body.push({ t: "gap", h: 6 }, { t: "text", text: "Your answer", size: 12, color: C.amber, weight: 600 });
        const editing = slate.editing?.kind === "answer" && slate.editing.key === q.id;
        body.push({ t: "gap", h: 6 }, { t: "field", text: d.text, placeholder: "Tap to write your own answer", editing, tap: () => startEditing({ kind: "answer", key: q.id }, d.text) });
        if (d.text.trim()) body.push({ t: "tiles", tiles: [{ label: "Send as comment", tone: "ice", tap: () => sendAnswer(q.id, "qcomment") }] });
      }
      if (i.lastComment) {
        body.push({ t: "rule" }, { t: "text", text: `${i.lastComment.author}, ${ago(i.lastComment.at)}`, size: 12, color: C.ink2 });
        const open = chat.expanded.has("c:" + i.id);
        for (const ln of mdLines(open ? i.lastComment.full : i.lastComment.text).slice(0, open ? 200 : 8)) body.push({ t: "text", text: ln.text, mono: ln.mono, size: ln.mono ? 12 : 14, color: C.ink, weight: ln.bold ? 600 : 400 });
        if (i.lastComment.full.length > i.lastComment.text.length) body.push({ t: "text", text: open ? "show less" : "show the whole comment", size: 12.5, color: C.ice, tap: () => { open ? chat.expanded.delete("c:" + i.id) : chat.expanded.add("c:" + i.id); drawSlate(); } });
      }
      if (notice) body.push({ t: "gap", h: 6 }, { t: "text", text: notice, size: 13, color: C.ice });
      foot.push({ t: "tiles", tiles: [{ label: "back", tap: () => backOut() }, ...(io.hostAgent ? [{ label: `talk to ${io.hostAgent.data?.name ?? "agent"}`, tap: () => goAgent(io.hostAgent.id) }] : [])] });
      return { head, body, foot };
    }
    return { head, body, foot };
  }

  function drawSlate() {
    if (!slate.kind) return;
    const p = slate.plate, now = performance.now();
    const x = p.begin();
    const { w, h } = p.rect;
    frostPatch(x, w, h);
    const pad = 18, W = w - pad * 2;
    const doc = buildDoc(W, now);
    const hh = measure(x, doc.head, W), fh = measure(x, doc.foot, W), bh = measure(x, doc.body, W);
    const top = pad + hh + (hh ? 6 : 0), bottom = h - pad - fh - (fh ? 8 : 0);
    const viewH = Math.max(10, bottom - top);
    slate.maxScroll = Math.max(0, bh - viewH);
    slate.scroll = Math.min(Math.max(0, slate.scroll), slate.maxScroll);
    const oy = doc.anchor === "bottom" ? bottom - bh + slate.scroll : top - slate.scroll;
    x.save(); x.beginPath(); x.rect(0, top - 2, w, viewH + 4); x.clip();
    drawItems(x, doc.body, pad, doc.anchor === "bottom" && bh < viewH ? top : oy, W, top - 2, bottom + 2, p, now);
    x.restore();
    // Soft fades where the body scrolls under the header and footer.
    x.globalCompositeOperation = "destination-out";
    for (const [y0, y1] of [[top - 2, top + 18], [bottom + 2, bottom - 18]]) {
      const g = x.createLinearGradient(0, y0, 0, y1); g.addColorStop(0, "rgba(0,0,0,0.9)"); g.addColorStop(1, "rgba(0,0,0,0)");
      x.fillStyle = g; x.fillRect(pad, Math.min(y0, y1), W, 20);
    }
    x.globalCompositeOperation = "source-over";
    drawItems(x, doc.head, pad, pad, W, 0, h, p, now);
    drawItems(x, doc.foot, pad, h - pad - fh, W, 0, h, p, now);
    p.end();
    slate.animUntil = Math.max(slate.animUntil, ...doc.body.filter((it) => it.born).map((it) => it.born + 700 + (it.lines?.length ?? 1) * 90));
  }

  // ---------------- HUD plates: summary, moon, pair glyph, ticker ----------------
  const sumPlate = new Plate("summary");
  const panelPlate = new Plate("panel");
  const bracketPlate = new Plate("brackets");
  bracketPlate.show(false);
  const tickPlate = new Plate("ticker");
  tickPlate.mat.uniforms.uRepeat.value = 1;
  let longPressMoon = null;

  // ---------------- HUD: KPI numbers on the window, minimal control strip ----------------
  const HUDF = '"JetBrains Mono", ui-monospace, Menlo, monospace';
  const kpiPrev = new Map(); const kpiFlash = new Map();
  const panel = { bright: 0, sound: false };
  function kpis() {
    const s = summary();
    const agentsWorking = store.agents.filter((a) => a.live).length;
    const today = new Date().toDateString();
    const doneToday = (store.board?.companies ?? []).flatMap((c) => c.issues).filter((i) => i.status === "done" && i.completedAt && new Date(i.completedAt).toDateString() === today).length;
    let sw = 0, sp = 0;
    for (const c of store.board?.companies ?? []) { const p = companyProgress(c); if (p != null) { const n = c.issues.filter((i) => OPEN.includes(i.status)).length; sw += n; sp += n * p; } }
    const overall = sw ? Math.round(sp / sw) + "%" : "–";
    const all = [
      { k: "work", v: agentsWorking, label: "agents working" },
      { k: "prog", v: s.inProgress, label: "in progress" },
      { k: "block", v: s.blocked, label: "blocked" },
      { k: "wait", v: s.waiting, label: "waiting on you", amber: s.waiting > 0, tap: () => { const q = allQuestions()[0]; if (q) goIssue(q.issue.id); } },
      { k: "done", v: doneToday, label: "done today" },
      { k: "pct", v: overall, label: "overall · rough estimate" },
    ];
    if (W >= 640) return all;
    const short = { work: "working", prog: "active", block: "blocked", wait: "for you" };
    return all.filter((x) => short[x.k]).map((x) => ({ ...x, label: short[x.k] }));
  }
  function drawSummary() {
    const x = sumPlate.begin();
    const { w, h } = sumPlate.rect;
    const now = performance.now();
    if (store.mode === "remote" && store.link.state !== "connected") {
      x.font = `300 14px ${HUDF}`; x.fillStyle = C.ink2; x.textAlign = "center"; x.textBaseline = "middle"; x.fillText("not connected to the Mac", w / 2, h / 2); sumPlate.end(); return;
    }
    const items = kpis();
    const cw = w / items.length, big = Math.min(46, Math.max(26, cw * 0.42));
    items.forEach((it, k) => {
      const v = String(it.v);
      if (kpiPrev.has(it.k) && kpiPrev.get(it.k) !== v) kpiFlash.set(it.k, now);
      kpiPrev.set(it.k, v);
      const fl = kpiFlash.has(it.k) ? Math.max(0, 1 - (now - kpiFlash.get(it.k)) / 1600) : 0;
      if (fl > 0) sumAnimUntil = Math.max(sumAnimUntil, now + 50);
      const cx = cw * k + cw / 2;
      const alpha = 0.3 + fl * 0.55;
      x.textAlign = "center"; x.textBaseline = "alphabetic";
      x.font = `200 ${big}px ${HUDF}`;
      x.fillStyle = it.amber ? `rgba(222,170,96,${Math.min(0.95, alpha + 0.35)})` : `rgba(200,204,208,${alpha})`;
      x.fillText(v, cx, big + 4);
      x.font = `300 10px ${HUDF}`;
      x.fillStyle = it.amber ? "rgba(222,170,96,0.7)" : "rgba(150,150,150,0.55)";
      x.fillText(it.label.toUpperCase(), cx, big + 20);
      if (it.tap) sumPlate.hot.push({ x: cw * k, y: 0, w: cw, h, fn: it.tap });
    });
    sumPlate.end();
  }
  let sumAnimUntil = 0;
  document.fonts?.load(`200 40px "JetBrains Mono"`).then(() => { drawSummary(); drawPanel(); drawSlate(); }).catch(() => {});

  // Bottom strip: refresh ring with countdown, interval, view, pair, sound. Nearly invisible until touched.
  const INTERVALS = [10, 15, 30, 60, 120, 300];
  function drawPanel() {
    const x = panelPlate.begin();
    const { w, h } = panelPlate.rect;
    const a = 0.22 + panel.bright * 0.68;
    const col = (k = 1) => `rgba(190,194,198,${a * k})`;
    const total = (store.board?.intervalSec ?? 15) * 1000;
    const left = Math.max(0, Math.min(1, (store.countdownAt - Date.now()) / total));
    const secs = Math.max(0, Math.round((store.countdownAt - Date.now()) / 1000));
    const pairState = store.mode === "remote" ? store.link.state : store.pair.state;
    const viewName = view.level === "sky" ? "system" : view.level === "company" ? "planet" : view.level === "agent" ? "moon" : "satellite";
    const narrow = W < 640;
    const items = [
      { id: "refresh", label: narrow ? `${secs}s` : `refresh ${secs}s`, ring: left },
      { id: "interval", label: narrow ? `/${store.board?.intervalSec ?? 15}s` : `every ${store.board?.intervalSec ?? 15}s` },
      { id: "view", label: narrow ? viewName : `view ${viewName}` },
      ...(store.mode === "host" || store.mode === "remote" ? [{ id: "pair", label: pairState === "connected" ? (narrow ? "linked" : "phone linked") : store.mode === "remote" ? "link" : narrow ? "pair" : "pair phone", on: pairState === "connected" }] : []),
      { id: "sound", label: panel.sound ? (narrow ? "snd on" : "sound on") : (narrow ? "snd off" : "sound off"), on: panel.sound },
    ];
    x.font = `300 11px ${HUDF}`; x.textBaseline = "middle"; x.textAlign = "left";
    const widths = items.map((it) => x.measureText(it.label).width + (it.ring != null ? 22 : 0) + 22);
    let cx = (w - widths.reduce((p, q) => p + q, 0)) / 2;
    items.forEach((it, k) => {
      const iw = widths[k];
      let tx = cx + 11;
      if (it.ring != null) {
        x.strokeStyle = col(0.35); x.lineWidth = 1.2; x.beginPath(); x.arc(tx + 6, h / 2, 6, 0, Math.PI * 2); x.stroke();
        x.strokeStyle = col(1); x.beginPath(); x.arc(tx + 6, h / 2, 6, -Math.PI / 2, -Math.PI / 2 + left * Math.PI * 2); x.stroke();
        tx += 20;
      }
      x.fillStyle = it.on ? `rgba(226,230,234,${Math.max(a, 0.5)})` : col(1);
      x.fillText(it.label, tx, h / 2 + 0.5);
      panelPlate.hot.push({ x: cx, y: 0, w: iw, h, fn: "panel:" + it.id });
      cx += iw;
    });
    panelPlate.end();
  }
  function wakePanel() { panel.bright = 1; panel.wokeAt = performance.now(); drawPanel(); }

  // ---------------- window frame and readout screens ----------------
  const framePlate = new Plate("frame");
  const readouts = []; // {plate, t0, issueId, agentId, slot}
  framePlate.mesh.renderOrder = -1;
  // Frame: graphite with a near-invisible weave, chamfered 45° corners, notched top/bottom segments,
  // 1 px hairlines, a metal hairline lit from the scene's sun direction, micro-labels, rangefinder ticks
  // and a segmented overall-% line. Drawn on the overlay (sharp, outside post-processing).
  function frameInset() { return W < 640 ? 9 : 16; }
  const weave = (() => {
    const c = document.createElement("canvas"); c.width = c.height = 6; const x = c.getContext("2d");
    x.fillStyle = "#0d0e10"; x.fillRect(0, 0, 6, 6);
    x.fillStyle = "#101114"; x.fillRect(0, 0, 3, 3); x.fillRect(3, 3, 3, 3); // ≤6% contrast twill
    return c;
  })();
  let frameLook = 0, frameSun = new THREE.Vector2(1, 0), sweepAt = performance.now() + 8000;
  function frameGeom(w, h) {
    const t = frameInset(), c = W < 640 ? 7 : 12, n = W < 640 ? 4 : 6;
    const tn0 = Math.round(w * 0.28), tn1 = Math.round(w * 0.72), bn0 = Math.round(w * 0.3), bn1 = Math.round(w * 0.7);
    const inner = [[t + c, t], [tn0, t], [tn0 + n, t + n], [tn1 - n, t + n], [tn1, t], [w - t - c, t], [w - t, t + c], [w - t, h - t - c], [w - t - c, h - t],
      [bn1, h - t], [bn1 - n, h - t - n], [bn0 + n, h - t - n], [bn0, h - t], [t + c, h - t], [t, h - t - c], [t, t + c]];
    const C = c + 4;
    const outer = [[C, 0], [w - C, 0], [w, C], [w, h - C], [w - C, h], [C, h], [0, h - C], [0, C]];
    return { t, c, n, inner, outer, tn0, tn1, bn0, bn1 };
  }
  function pathOf(x, pts) { x.moveTo(pts[0][0], pts[0][1]); for (const p of pts.slice(1)) x.lineTo(p[0], p[1]); x.closePath(); }
  function drawFrame(now = performance.now()) {
    const x = framePlate.begin();
    const { w, h } = framePlate.rect;
    const g = frameGeom(w, h);
    frameLook = look.x;
    // Sun direction on screen, so the hairline is lit from where the planets are lit.
    const sv = SUN.clone().transformDirection(camera.matrixWorldInverse);
    frameSun.set(sv.x, -sv.y).normalize();
    x.save();
    // Body.
    x.beginPath(); pathOf(x, g.outer); pathOf(x, g.inner);
    x.fillStyle = x.createPattern(weave, "repeat"); x.fill("evenodd");
    // Soft inner shadow into the view, then a 1 px dark gap: the view sits recessed behind glass.
    x.save(); x.beginPath(); pathOf(x, g.inner); x.clip();
    x.shadowColor = "rgba(0,0,0,0.85)"; x.shadowBlur = 18; x.lineWidth = 12; x.strokeStyle = "rgba(0,0,0,0.6)";
    x.beginPath(); pathOf(x, g.inner); x.stroke(); x.restore();
    x.lineWidth = 1; x.strokeStyle = "#000"; x.beginPath(); pathOf(x, g.inner); x.stroke();
    // Outer hairline.
    x.strokeStyle = "rgba(255,255,255,0.07)"; x.beginPath(); pathOf(x, g.outer.map(([a, b]) => [a + (a < w / 2 ? 0.5 : -0.5), b + (b < h / 2 ? 0.5 : -0.5)])); x.stroke();
    // Metal hairline on the inner edge, each segment lit by how much it faces the sun.
    const sweepK = (now - sweepAt) / 2200; // a slow light sweep along the hairline every ~30 s
    const per = []; let total = 0;
    for (let i = 0; i < g.inner.length; i++) { const a = g.inner[i], b = g.inner[(i + 1) % g.inner.length]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]); per.push([a, b, total, L]); total += L; }
    for (const [a, b, s0, L] of per) {
      const dx = (b[0] - a[0]) / L, dy = (b[1] - a[1]) / L;
      const nx = -dy, ny = dx; // outward normal for this winding (into the frame)
      const lit = Math.max(0, -(nx * frameSun.x + ny * frameSun.y));
      const base = 0.1 + lit * 0.35;
      if (sweepK >= 0 && sweepK <= 1 && !reduced) {
        const pos = sweepK * total;
        const gr = x.createLinearGradient(a[0], a[1], b[0], b[1]);
        for (const f of [0, 0.25, 0.5, 0.75, 1]) { const d = Math.abs(s0 + f * L - pos); gr.addColorStop(f, `rgba(205,212,220,${base + Math.max(0, 1 - d / 90) * 0.55})`); }
        x.strokeStyle = gr;
      } else x.strokeStyle = `rgba(190,198,206,${base})`;
      x.beginPath(); x.moveTo(a[0] + nx * 1.5, a[1] + ny * 1.5); x.lineTo(b[0] + nx * 1.5, b[1] + ny * 1.5); x.stroke();
    }
    if (sweepK > 1) sweepAt = now + 30000;
    // Rangefinder ticks along the sides.
    x.strokeStyle = "rgba(200,206,212,0.16)";
    for (let y = g.t + g.c + 20, k = 0; y < h - g.t - g.c - 20; y += 24, k++) {
      const len = k % 5 === 0 ? 6 : 3;
      x.beginPath(); x.moveTo(g.t - 4 - len + 0.5, y + 0.5); x.lineTo(g.t - 4 + 0.5, y + 0.5); x.stroke();
      x.beginPath(); x.moveTo(w - g.t + 4 - 0.5, y + 0.5); x.lineTo(w - g.t + 4 + len - 0.5, y + 0.5); x.stroke();
    }
    // Segmented overall-% line along the top notch.
    let sw = 0, sp = 0;
    for (const c0 of store.board?.companies ?? []) { const pr = companyProgress(c0); if (pr != null) { const nn = c0.issues.filter((i) => OPEN.includes(i.status)).length; sw += nn; sp += nn * pr; } }
    const overall = sw ? sp / sw : 0, segs = 40, sx0 = g.tn0 + g.n + 6, sx1 = g.tn1 - g.n - 6, sy = Math.max(3, g.t - 6);
    const sl = (sx1 - sx0) / segs;
    for (let k = 0; k < segs; k++) { x.fillStyle = k / segs < overall / 100 ? "rgba(200,206,212,0.5)" : "rgba(200,206,212,0.1)"; x.fillRect(Math.round(sx0 + k * sl), sy, Math.max(1, Math.round(sl) - 2), 2); }
    // Micro-labels.
    if (W >= 640) {
      x.font = `300 8.5px ${HUDF}`; x.fillStyle = "rgba(190,196,202,0.36)"; x.textBaseline = "middle";
      x.fillText("OBS-01 · SYS 3", g.t + g.c + 8, g.t / 2);
      x.textAlign = "right"; x.fillText(`OVERALL ${Math.round(overall)}% · ROUGH`, w - g.t - g.c - 8, g.t / 2);
      x.textAlign = "left"; x.fillText("UPLINK · PAPERCLIP 3100", g.t + g.c + 8, h - g.t / 2);
      x.textAlign = "right"; x.fillText(`AZ ${(rig.yaw * 57.3).toFixed(1)}° · EL ${(rig.pitch * 57.3).toFixed(1)}° · R ${rig.dist.toFixed(0)}`, w - g.t - g.c - 8, h - g.t / 2);
      x.textAlign = "left";
    }
    x.restore();
    framePlate.end();
  }
  function readoutSlots() {
    const m = frameInset() + 6;
    if (W < 640) return [{ x: m + 4, y: (W < 640 ? 74 : 90), w: W - 2 * m - 8 }, { x: m + 4, y: H - 34 - m - 50, w: W - 2 * m - 8 }];
    const rw = 250, chatOpen = slate.kind && W >= 860;
    const slots = [
      { x: m + 4, y: H * 0.28, w: rw }, { x: m + 4, y: H * 0.5, w: rw }, { x: m + 4, y: H - 34 - m - 58, w: rw },
    ];
    if (!chatOpen) slots.push({ x: W - m - rw - 4, y: H * 0.28, w: rw }, { x: W - m - rw - 4, y: H * 0.5, w: rw }, { x: W - m - rw - 4, y: H - 34 - m - 58, w: rw });
    return slots;
  }
  const readoutQueue = [];
  function readout(text, tone, issueId, agentId) {
    readoutQueue.push({ text, tone, issueId, agentId });
    if (readoutQueue.length > 12) readoutQueue.shift();
    activeUntil = Math.max(activeUntil, performance.now() + 500);
  }
  function pumpReadouts(now) {
    const slots = readoutSlots();
    while (readoutQueue.length) {
      const used = new Set(readouts.map((r) => r.slot));
      let slot = slots.findIndex((_, k) => !used.has(k));
      if (slot < 0) {
        // Newest replaces the oldest.
        const oldest = readouts.reduce((a, b) => (a.t0 < b.t0 ? a : b));
        glass.remove(oldest.plate.mesh); readouts.splice(readouts.indexOf(oldest), 1); slot = oldest.slot;
      }
      const r = readoutQueue.shift();
      const p = new Plate("readout");
      const sl = slots[slot];
      const c0 = p.ctx; c0.font = `300 11.5px ${HUDF}`;
      const lines = wrap(c0, r.text, sl.w - 22).slice(0, 2);
      const hh = lines.length * 16 + 16;
      p.place(sl.x, sl.y, sl.w, hh);
      const x = p.begin();
      x.fillStyle = "rgba(3,4,5,0.66)"; x.fillRect(0, 0, sl.w, hh);
      x.strokeStyle = "rgba(255,255,255,0.08)"; x.strokeRect(0.5, 0.5, sl.w - 1, hh - 1);
      x.strokeStyle = "rgba(235,240,245,0.42)"; x.beginPath(); x.moveTo(0, 0.5); x.lineTo(sl.w * 0.7, 0.5); x.stroke(); // one specular edge
      x.fillStyle = r.tone === "+" ? "rgba(140,220,190,0.9)" : r.tone === "-" ? "rgba(225,160,90,0.95)" : "rgba(170,174,178,0.8)";
      x.fillRect(0, 0, 2, hh);
      x.font = `300 11.5px ${HUDF}`; x.textBaseline = "top";
      lines.forEach((l, k) => { x.fillStyle = k === 0 ? (r.tone === "+" ? "rgba(170,230,205,0.95)" : r.tone === "-" ? "rgba(232,180,110,0.95)" : "rgba(200,204,208,0.9)") : "rgba(170,174,178,0.8)"; x.fillText(l, 11, 8 + k * 16); });
      if (r.issueId || r.agentId) p.hot.push({ x: 0, y: 0, w: sl.w, h: hh, fn: () => (r.issueId && issueObjs.has(r.issueId) ? goIssue(r.issueId) : r.agentId ? goAgent(r.agentId) : null) });
      p.end();
      readouts.push({ plate: p, t0: now, slot, ...r });
    }
    for (let i = readouts.length - 1; i >= 0; i--) {
      const r = readouts[i], age = (now - r.t0) / 1000;
      r.plate.mat.uniforms.uReveal.value = reduced ? 1 : Math.min(1, age / 0.25);   // scan-in
      r.plate.mat.uniforms.uOpacity.value = age < 5.5 ? 1 : Math.max(0, 1 - (age - 5.5) / 0.8);
      if (age > 6.3) { glass.remove(r.plate.mesh); r.plate.tex.dispose(); readouts.splice(i, 1); }
    }
    if (readouts.length) activeUntil = Math.max(activeUntil, now + 100);
  }

  // ---------------- slide-in activity feed (right edge) ----------------
  const feed = { open: false, k: 0, items: [], unread: 0, hidden: new Set(), scroll: 0 };
  const feedPlate = new Plate("feed");
  const handlePlate = new Plate("handle");
  const DOT = { BOX: "rgba(200,120,80,0.95)", CLA: "rgba(160,145,200,0.95)", VIS: "rgba(110,180,200,0.95)" };
  function feedAdd(item) {
    feed.items.unshift({ ...item, born: performance.now() });
    if (feed.items.length > 300) feed.items.pop();
    if (!feed.open) feed.unread++;
    drawHandle(); if (feed.open) drawFeed();
  }
  function seedFeed() {
    if (feed.items.length) return;
    for (const e of store.log.slice(0, 120)) {
      const m = /^([A-Z]+-\d+)/.exec(e.text);
      const iss = m ? (store.board?.companies ?? []).flatMap((c) => c.issues).find((i) => i.identifier === m[1]) : null;
      feed.items.push({ ts: e.ts, company: e.company, text: e.text, tone: /→ done|answered/.test(e.text) ? "+" : /→ blocked|question waiting/.test(e.text) ? "-" : "0", issueId: iss?.id ?? null, born: 0 });
    }
  }
  function feedWidth() { return Math.min(300, Math.round(W * 0.8)); }
  function drawHandle() {
    const x = handlePlate.begin();
    const { w, h } = handlePlate.rect;
    x.fillStyle = "rgba(0,0,0,0.6)"; x.fillRect(0, 0, w, h);
    x.strokeStyle = "rgba(190,194,198,0.3)"; x.strokeRect(0.5, 0.5, w - 1, h - 1);
    x.save(); x.translate(w / 2 + 4, h / 2); x.rotate(-Math.PI / 2);
    x.font = `300 10px ${HUDF}`; x.fillStyle = "rgba(190,194,198,0.75)"; x.textAlign = "center"; x.textBaseline = "middle";
    x.fillText("ACTIVITY", 0, 0); x.restore();
    if (feed.unread) { x.font = `400 10px ${HUDF}`; x.fillStyle = "rgba(225,175,100,0.95)"; x.textAlign = "center"; x.fillText(String(Math.min(99, feed.unread)), w / 2, 10); }
    handlePlate.hot.push({ x: 0, y: 0, w, h, fn: () => toggleFeed() });
    handlePlate.end();
  }
  function toggleFeed(force) {
    feed.open = force ?? !feed.open;
    if (feed.open) { feed.unread = 0; feed.scroll = 0; seedFeed(); drawFeed(); }
    drawHandle(); activeUntil = performance.now() + 600; kick();
  }
  function drawFeed() {
    const x = feedPlate.begin();
    const { w, h } = feedPlate.rect, pad = 16, now = performance.now();
    x.fillStyle = "rgba(0,0,0,0.78)"; x.fillRect(0, 0, w, h);
    x.strokeStyle = "rgba(190,194,198,0.2)"; x.beginPath(); x.moveTo(0.5, 0); x.lineTo(0.5, h); x.stroke();
    x.font = `300 10px ${HUDF}`; x.textBaseline = "middle";
    x.fillStyle = "rgba(170,174,178,0.7)"; x.fillText("ACTIVITY", pad, 22);
    let fx0 = pad + 70;
    for (const c of ["BOX", "CLA", "VIS"]) {
      const on = !feed.hidden.has(c);
      x.fillStyle = on ? DOT[c] : "rgba(90,90,90,0.8)"; x.beginPath(); x.arc(fx0 + 4, 22, 3.5, 0, 6.28); x.fill();
      x.fillStyle = on ? "rgba(200,204,208,0.85)" : "rgba(110,110,110,0.8)"; x.fillText(c, fx0 + 12, 22);
      feedPlate.hot.push({ x: fx0 - 4, y: 10, w: 46, h: 24, fn: () => { on ? feed.hidden.add(c) : feed.hidden.delete(c); drawFeed(); } });
      fx0 += 54;
    }
    x.strokeStyle = "rgba(190,194,198,0.1)"; x.beginPath(); x.moveTo(pad, 40.5); x.lineTo(w - pad, 40.5); x.stroke();
    const items = feed.items.filter((it) => !it.company || !feed.hidden.has(it.company));
    const rowH = 42;
    feed.maxScroll = Math.max(0, items.length * rowH - (h - 52));
    feed.scroll = Math.max(0, Math.min(feed.maxScroll, feed.scroll));
    x.save(); x.beginPath(); x.rect(0, 44, w, h - 44); x.clip();
    let anim = false;
    items.forEach((it, k) => {
      const y = 52 + k * rowH - feed.scroll;
      if (y < 30 || y > h) return;
      const a = it.born ? Math.min(1, (now - it.born) / 400) : 1; if (a < 1) anim = true;
      x.globalAlpha = a;
      x.fillStyle = DOT[it.company] ?? "rgba(150,150,150,0.8)"; x.beginPath(); x.arc(pad + 3, y + 7, 3, 0, 6.28); x.fill();
      x.font = `300 10px ${HUDF}`; x.fillStyle = "rgba(140,144,148,0.8)"; x.textBaseline = "top";
      x.fillText(new Date(it.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + (it.company ? "  " + it.company : ""), pad + 12, y + 1);
      x.font = `300 11.5px ${HUDF}`;
      x.fillStyle = it.tone === "+" ? "rgba(170,230,205,0.95)" : it.tone === "-" ? "rgba(232,180,110,0.95)" : "rgba(200,204,208,0.9)";
      const line = wrap(x, it.text, w - pad * 2 - 12)[0] ?? "";
      x.fillText(line + (wrap(x, it.text, w - pad * 2 - 12).length > 1 ? "…" : ""), pad + 12, y + 16);
      if (it.issueId || it.agentId) feedPlate.hot.push({ x: 0, y, w, h: rowH - 4, fn: () => { toggleFeed(false); if (it.issueId && issueObjs.has(it.issueId)) goIssue(it.issueId); else if (it.agentId) goAgent(it.agentId); } });
    });
    x.restore(); x.globalAlpha = 1;
    if (!items.length) { x.font = `300 11px ${HUDF}`; x.fillStyle = "rgba(140,144,148,0.8)"; x.fillText("Nothing yet.", pad, 60); }
    feedPlate.end();
    if (anim) slate.animUntil = Math.max(slate.animUntil, now + 50), feed.anim = now + 450;
  }
  function placeFeed(dt) {
    const goal = feed.open ? 1 : 0;
    if (Math.abs(goal - feed.k) > 0.001) { feed.k += (goal - feed.k) * (reduced ? 1 : Math.min(1, dt * 12)); activeUntil = Math.max(activeUntil, performance.now() + 50); }
    else feed.k = goal;
    const fw = feedWidth(), m = frameInset();
    const top = m + 1, hgt = H - 2 * m - 36;
    const xPos = Math.round(W - m - 1 - fw * feed.k);
    if (feedPlate.rect.w !== fw || feedPlate.rect.h !== hgt) { feedPlate.place(xPos, top, fw, hgt); drawFeed(); }
    feedPlate.mesh.position.set(xPos + fw / 2, -(top + hgt / 2), 0); feedPlate.rect.x = xPos;
    feedPlate.mesh.visible = feed.k > 0.01; feedPlate.visible = feed.k > 0.5;
    const hx = xPos - 18;
    handlePlate.mesh.position.set(hx + 9, -(H * 0.42 + 40), 0); handlePlate.rect.x = hx; handlePlate.rect.y = H * 0.42;
    if (feed.anim && performance.now() < feed.anim) drawFeed();
  }

  // Console blips (off by default).
  let audio = null;
  function blip(freq = 660, dur = 0.08) {
    if (!panel.sound) return;
    try {
      audio ||= new AudioContext();
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = "sine"; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, audio.currentTime); g.gain.exponentialRampToValueAtTime(0.05, audio.currentTime + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + dur);
      o.connect(g).connect(audio.destination); o.start(); o.stop(audio.currentTime + dur + 0.02);
    } catch { /* no audio */ }
  }

  // Selection brackets: corners locked onto the selected planet, moon or satellite, with a readout.
  let bracketKey = "";
  function selectionTarget() {
    if (view.level === "issue") { const io = issueObjs.get(view.issue); if (io) { const e = store.board?.eta?.[io.data.identifier]; return { key: "i" + io.id, pos: io.sprite.position, r: 0.35, name: `${io.data.identifier} · ${STATUS[io.status]}`, read: e?.pct != null ? `~${e.pct}% · ETA ${e.eta}` : store.board?.etaRunning?.includes(io.data.identifier) ? "estimating…" : "" }; } }
    if (view.level === "agent") { const ao = agentObjs.get(view.agent); if (ao) { const a = ao.data ?? {}; return { key: "a" + ao.id, pos: ao.pos, r: ao.size, name: a.name ?? "agent", read: a.live ? `working · ${a.issue ?? ""}` : a.queued ? "queued" : "idle" }; } }
    if (view.level === "company") { const co = companyObjs.get(view.company); if (co) return { key: "c" + co.prefix, pos: co.center, r: co.radius, name: co.name, read: co.pctText ? `~${Math.round(co.ringPct)}% overall` : "" }; }
    return null;
  }
  function updateBrackets() {
    const t = selectionTarget();
    if (!t) { if (bracketPlate.visible) bracketPlate.show(false); bracketKey = ""; return; }
    const c = t.pos.clone().project(camera);
    if (c.z > 1) { bracketPlate.show(false); return; }
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const e = t.pos.clone().addScaledVector(right, t.r).project(camera);
    const sx = (c.x * 0.5 + 0.5) * W, sy = (-c.y * 0.5 + 0.5) * H;
    const rpx = Math.max(14, Math.abs((e.x - c.x) * 0.5 * W)) * 1.35 + 6;
    const size = Math.round(rpx * 2), key = t.key + "|" + size + "|" + t.name + "|" + t.read;
    const pw = size + 230, ph = Math.max(size, 40);
    if (key !== bracketKey) {
      bracketKey = key;
      bracketPlate.place(0, 0, pw, ph);
      const x = bracketPlate.begin();
      const oy = (ph - size) / 2, L = Math.min(16, size / 3);
      x.strokeStyle = "rgba(200,204,208,0.55)"; x.lineWidth = 1;
      for (const [px, py, dx, dy] of [[0, 0, 1, 1], [size, 0, -1, 1], [0, size, 1, -1], [size, size, -1, -1]]) {
        x.beginPath(); x.moveTo(px + 0.5, oy + py + dy * L); x.lineTo(px + 0.5, oy + py + 0.5); x.lineTo(px + dx * L, oy + py + 0.5); x.stroke();
      }
      x.font = `300 12px ${HUDF}`; x.fillStyle = "rgba(210,214,218,0.8)"; x.textBaseline = "top";
      x.fillText(t.name, size + 12, ph / 2 - 15);
      x.font = `300 11px ${HUDF}`; x.fillStyle = "rgba(160,160,160,0.7)";
      x.fillText(t.read, size + 12, ph / 2 + 2);
      bracketPlate.end();
    }
    bracketPlate.mesh.position.set(sx - size / 2 + pw / 2, -(sy - ph / 2 + ph / 2), 0);
    bracketPlate.rect.x = sx - size / 2; bracketPlate.rect.y = sy - ph / 2;
    if (!bracketPlate.visible) bracketPlate.show(true);
  }

  let tickerText = "";
  function drawTicker() {
    const entries = store.log.slice(0, 14);
    const text = entries.length ? entries.map((e) => `${new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}  ${e.text}`).join("      ·      ") + "      ·      " : "No changes recorded yet      ·      ";
    if (text === tickerText && tickPlate.canvas.width > 1) return;
    tickerText = text;
    const x = tickPlate.ctx;
    x.font = `400 13px ${SANS}`;
    const tw = Math.min(8000, Math.ceil(x.measureText(text).width) + 20);
    const r = Math.min(2, devicePixelRatio || 1);
    tickPlate.canvas.width = Math.round(tw * r); tickPlate.canvas.height = Math.round(tickPlate.rect.h * r);
    tickPlate.tex.dispose(); tickPlate.tex = new THREE.CanvasTexture(tickPlate.canvas); tickPlate.tex.minFilter = THREE.LinearFilter; tickPlate.mat.uniforms.map.value = tickPlate.tex;
    x.setTransform(r, 0, 0, r, 0, 0);
    x.font = `400 13px ${SANS}`; x.textBaseline = "middle";
    // Etched: a dark groove under a pale line.
    x.fillStyle = "rgba(0,0,0,0.6)"; x.fillText(text, 1, tickPlate.rect.h / 2 + 1);
    x.fillStyle = "rgba(160,160,160,0.6)"; x.fillText(text, 0, tickPlate.rect.h / 2);
    tickPlate.textW = tw;
    tickPlate.mat.uniforms.uRepeat.value = tickPlate.rect.w / tw;
    tickPlate.tex.needsUpdate = true;
  }

  // ---------------- floating glass text (messages drifting near stars / into a star) ----------------
  const floaters = [];
  function floater(text, opts) {
    if (floaters.length >= 4) return;
    const p = new Plate("float");
    const x = p.ctx;
    x.font = `500 13px ${SANS}`;
    const lines = wrap(x, text, 230).slice(0, 3);
    const w = Math.min(250, Math.max(...lines.map((l) => x.measureText(l).width)) + 20), h = lines.length * 18 + 14;
    p.place(0, 0, w, h);
    const c = p.begin();
    c.font = `500 13px ${SANS}`; c.textBaseline = "top"; c.shadowColor = "rgba(0,0,0,0.95)"; c.shadowBlur = 5;
    lines.forEach((l, k) => { c.fillStyle = opts.color ?? C.frost; c.fillText(l, 10, 7 + k * 18); });
    p.end();
    floaters.push({ p, t0: performance.now(), dur: opts.dur ?? 5000, ...opts, w, h });
    activeUntil = performance.now() + 1000;
  }
  function floatToStar(text, agentId) {
    const r = slate.area;
    floater(text.length > 40 ? text.slice(0, 40) + "…" : text, { from: { x: r.x + 20, y: r.y + r.h - 80 }, toAgent: agentId, dur: 900, color: C.ice });
  }
  const lastFloatAt = new Map();

  // ---------------- effects ----------------
  const fxQueue = [];
  const running = [];
  const HOT = new THREE.Color(1.0, 0.72, 0.42).multiplyScalar(5);
  const FROST = new THREE.Color(0.85, 0.22, 0.06).multiplyScalar(0.55); // embers: meteors burn out dim red
  const GREY = new THREE.Color(0.5, 0.5, 0.5).multiplyScalar(0.4);
  const ICE = new THREE.Color(0.75, 0.88, 1.0);
  const v3 = () => new THREE.Vector3();
  let lastEventAt = performance.now();
  let pulseStart = -1;

  function queueFx(kind, fn, big = true) {
    lastEventAt = performance.now();
    if (reduced) return; // no streaks or flights with reduced motion
    if (fxQueue.length > 10) fxQueue.shift();
    fxQueue.push({ kind, fn, big });
  }
  function headSprite(color, scale) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: psfSoft, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    s.scale.setScalar(scale);
    world.add(s);
    return s;
  }
  const screenAngle = (a, b) => {
    const p = a.clone().project(camera), q = b.clone().project(camera);
    return Math.atan2((q.y - p.y) / camera.aspect, q.x - p.x) || 0;
  };
  const streakBudget = () => (tier.name === "low" ? 1 : tier.name === "medium" ? 2 : 4);

  function meteor(at) {
    const dir = new THREE.Vector3(1, -0.55, 0.15).normalize();
    const start = at.clone().addScaledVector(dir, -9).add(new THREE.Vector3(0, 2, 0)), end = at.clone().addScaledVector(dir, 7);
    const head = headSprite(HOT.clone(), 1.6);
    return { dur: 1.5, update(k, dt) {
      const e = fx.easeInOut(k);
      const prev = head.position.clone();
      head.position.lerpVectors(start, end, e);
      head.material.color.copy(HOT).lerp(FROST, Math.max(0, (k - 0.55) / 0.45));
      head.material.rotation = screenAngle(prev, head.position);
      head.scale.set(1.2 + 3.5 * Math.sin(Math.PI * k), 0.9, 1); // motion blur along the path
      for (let i = 0; i < streakBudget(); i++) particles.emit(head.position.clone().add(v3().randomDirection().multiplyScalar(0.08)), v3().randomDirection().multiplyScalar(0.25), HOT.clone().multiplyScalar(0.6), FROST, 0.5 + Math.random() * 0.4, 0.5 + Math.random() * 0.4);
    }, end() {
      for (let i = 0; i < 26 * streakBudget(); i++) particles.emit(end.clone(), v3().randomDirection().multiplyScalar(1 + Math.random() * 2.2), HOT.clone().multiplyScalar(0.5), FROST, 0.5 + Math.random() * 0.5, 0.7 + Math.random() * 0.7);
      world.remove(head);
    } };
  }
  function comet(to, onArrive) {
    const start = to.clone().add(new THREE.Vector3(16, 10, -14));
    const mid = to.clone().add(new THREE.Vector3(9, 1, 4));
    const curve = new THREE.QuadraticBezierCurve3(start, mid, to);
    const head = headSprite(ICE.clone().multiplyScalar(2.6), 1.3);
    const ion = new THREE.Line(new THREE.BufferGeometry().setFromPoints([v3(), v3()]), new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    ion.geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array([0.55, 0.75, 1.0, 0, 0, 0]), 3));
    world.add(ion);
    const anti = SUN.clone().negate();
    return { dur: 3.4, update(k) {
      const p = curve.getPoint(fx.easeOut(k));
      head.position.copy(p);
      const fade = k > 0.85 ? (1 - k) / 0.15 : 1;
      head.material.color.copy(ICE).multiplyScalar(2.6 * fade + 0.2);
      // Ion tail: straight, faint ice-blue, pointing away from the sun.
      const pos = ion.geometry.attributes.position;
      pos.setXYZ(0, p.x, p.y, p.z); const tail = p.clone().addScaledVector(anti, 5 * fade); pos.setXYZ(1, tail.x, tail.y, tail.z); pos.needsUpdate = true;
      // Dust tail: curved, drifting away from the sun with a sideways lag.
      const tangent = curve.getTangent(Math.min(0.999, k)).negate();
      for (let i = 0; i < streakBudget(); i++) particles.emit(p.clone(), anti.clone().multiplyScalar(0.8 + Math.random() * 0.6).addScaledVector(tangent, 0.9).add(v3().randomDirection().multiplyScalar(0.15)), new THREE.Color(0.6, 0.6, 0.62).multiplyScalar(0.6), GREY, 0.45 + Math.random() * 0.3, 1.0 + Math.random() * 0.8);
    }, end() {
      world.remove(head, ion);
      for (let i = 0; i < 14; i++) particles.emit(to.clone(), v3().randomDirection().multiplyScalar(0.8), ICE.clone().multiplyScalar(0.6), GREY, 0.4, 0.8);
      onArrive?.();
    } };
  }
  function shootingStar(from) {
    const dir = new THREE.Vector3((Math.random() - 0.5) * 2, 0.6 + Math.random() * 0.6, (Math.random() - 0.5)).normalize();
    const start = from.clone(), end = from.clone().addScaledVector(dir, 6);
    const head = headSprite(ICE.clone().multiplyScalar(2.2), 0.9);
    return { dur: 0.7, update(k) {
      const prev = head.position.clone();
      head.position.lerpVectors(start, end, fx.easeOut(k));
      head.material.rotation = screenAngle(prev, head.position);
      head.scale.set(0.8 + 2.4 * (1 - k), 0.5, 1);
      head.material.opacity = 1 - k;
      particles.emit(head.position.clone(), v3(), ICE.clone().multiplyScalar(0.4), GREY, 0.3, 0.35);
    }, end() { world.remove(head); } };
  }
  function pulse() { return { dur: 3.6, update(k) { film.uniforms.uPulse.value = k; }, end() { film.uniforms.uPulse.value = -1; } }; }

  // UFOs: tied to runs. Arrive when a run starts, hover with a faint beam while it is live, leave after.
  function ufoArrive(agentId, instant = false) {
    const ao = agentObjs.get(agentId); if (!ao || ufos.has(agentId) || ufos.size >= 4) return;
    const g = makeUfo();
    world.add(g);
    const hover = () => ao.pos.clone().add(new THREE.Vector3(0, 1.9, 0));
    const from = hover().add(new THREE.Vector3(-26, 14, -18));
    const u = { g, ao, state: instant || reduced ? "hover" : "arrive", t: 0, from, hover };
    if (u.state === "hover") g.position.copy(hover());
    else g.position.copy(from);
    ufos.set(agentId, u);
    activeUntil = performance.now() + 3500;
  }
  function ufoDepart(agentId) {
    const u = ufos.get(agentId); if (!u) return;
    if (reduced) { world.remove(u.g); ufos.delete(agentId); return; }
    u.state = "depart"; u.t = 0; u.from = u.g.position.clone();
    activeUntil = performance.now() + 3500;
  }
  function ufoSputter(agentId) {
    const u = ufos.get(agentId); if (!u) return;
    if (reduced) { world.remove(u.g); ufos.delete(agentId); return; }
    u.state = "sputter"; u.t = 0; u.from = u.g.position.clone();
    activeUntil = performance.now() + 4000;
  }
  let loneUfo = null;
  function updateUfos(dt, t) {
    for (const [id, u] of ufos) {
      const { lights, beam, beamMat } = u.g.userData;
      u.t += dt;
      lights.forEach((l, k) => l.material.color.setScalar(((Math.floor(t * 6) % 10) === k ? 2.6 : 0.9)).multiply(new THREE.Color(0.85, 0.92, 1.0)));
      beamMat.uniforms.uTime.value = t;
      if (u.state === "arrive") {
        const k = Math.min(1, u.t / 3), e = fx.easeInOut(k);
        const mid = u.from.clone().lerp(u.hover(), 0.6).add(new THREE.Vector3(0, 3, 0));
        u.g.position.copy(new THREE.QuadraticBezierCurve3(u.from, mid, u.hover()).getPoint(e));
        u.g.rotation.z = (1 - e) * 0.35; u.g.rotation.y += dt * 1.2;
        beamMat.uniforms.uOpacity.value = 0;
        if (k >= 1) { u.state = "hover"; u.t = 0; }
      } else if (u.state === "hover") {
        const hp = u.hover();
        u.g.position.set(hp.x, hp.y + (reduced ? 0 : Math.sin(t * 1.3 + u.ao.h * 6) * 0.12), hp.z);
        u.g.rotation.z *= 0.95; if (!reduced) u.g.rotation.y += dt * 0.6;
        beamMat.uniforms.uOpacity.value = Math.min(0.32, u.t * 0.3);
        beam.scale.set(1, 1.95, 1);
      } else if (u.state === "sputter") {
        // Lights stutter, the beam dies, and it drifts off tumbling.
        lights.forEach((l) => l.material.color.setScalar(Math.random() < 0.3 ? 1.8 : 0.1));
        beamMat.uniforms.uOpacity.value = Math.random() < 0.2 ? 0.2 : 0;
        const k = Math.min(1, u.t / 3.5);
        u.g.position.copy(u.from).add(new THREE.Vector3(-6 * k, -3 * k * k, 8 * k));
        u.g.rotation.z += dt * 2.2; u.g.rotation.x += dt * 1.1;
        if (k >= 1) { world.remove(u.g); ufos.delete(id); }
      } else if (u.state === "depart") {
        beamMat.uniforms.uOpacity.value = Math.max(0, 0.32 - u.t);
        const k = Math.min(1, Math.max(0, (u.t - 0.4) / 2.6)), e = k * k;
        u.g.position.copy(u.from).add(new THREE.Vector3(24, 16, -26).multiplyScalar(e));
        u.g.rotation.z = -e * 0.4; u.g.rotation.y += dt * 1.5;
        if (k >= 1) { world.remove(u.g); ufos.delete(id); }
      }
    }
    if (loneUfo) {
      loneUfo.t += dt;
      const k = loneUfo.t / 16;
      loneUfo.g.position.set(-90 + 180 * k, 22 + Math.sin(k * 6) * 2, -110);
      loneUfo.g.rotation.y += dt * 0.8;
      if (k >= 1) { world.remove(loneUfo.g); loneUfo = null; }
    }
  }

  // ---------------- events: one table maps every detected change to an effect ----------------
  // tone: + positive (cool white/teal), - negative (amber/red), 0 neutral.
  // fx: transient effect (big ones play one at a time, small ones two at a time).
  // persist: an effect that stays while the condition holds (see syncPersistent).
  const EVENTS = {
    done:         { tone: "+", fx: "aurora",   big: true,  text: (i) => `${i} done` },
    review:       { tone: "+", fx: "beacon",   big: false, text: (i) => `${i} ready for review` },
    commit:       { tone: "+", fx: "supply",   big: false, text: (i) => `${i} commit landed / tests pass` },
    unblocked:    { tone: "+", fx: "clear",    big: false, text: (i) => `${i} unblocked` },
    answered:     { tone: "+", fx: null,       big: false, text: (i) => `${i} question answered` },
    progressUp:   { tone: "+", fx: "city",     big: true,  text: (i, d) => `${i} estimate up to ${d}%` },
    comment:      { tone: "+", fx: "shooting", big: false, text: (i) => `${i} new agent comment` },
    question:     { tone: "-", persist: "attack", text: (i) => `${i} waiting on you` },
    blocked:      { tone: "-", persist: "storm",  text: (i) => `${i} blocked` },
    stale:        { tone: "-", persist: "ice",    text: (i) => `${i} no update for 2 h` },
    failed:       { tone: "-", fx: "impacts",  big: true,  text: (i) => `${i} run hit errors` },
    progressDown: { tone: "-", fx: "tremor",   big: true,  text: (i, d) => `${i} estimate down to ${d}%` },
    reopened:     { tone: "-", fx: "tremor",   big: true,  text: (i) => `${i} reopened` },
    crashed:      { tone: "-", fx: "sputter",  big: true,  text: (i) => `${i} run stopped early` },
    newIssue:     { tone: "0", fx: "comet",    big: true,  text: (i) => `${i} new issue` },
    runStart:     { tone: "0", fx: "ufo",      big: false, text: (i) => `${i} started a run` },
    estimate:     { tone: "0", fx: null,       big: false, text: (i, d) => `${i} estimate ${d}` },
  };
  const issueById = (id) => (store.board?.companies ?? []).flatMap((c) => c.issues.map((i) => ({ ...i, company: c.prefix }))).find((i) => i.id === id);
  function planetFor(prefix) { return companyObjs.get(prefix); }
  function dirOnPlanet(co, ao, seed) {
    const base = ao ? ao.pos.clone().sub(co.center).normalize() : new THREE.Vector3().randomDirection();
    return base.lerp(SUN, 0.35).add(new THREE.Vector3(hash(seed) - 0.5, hash(seed + "y") - 0.5, hash(seed + "z") - 0.5).multiplyScalar(0.5)).normalize();
  }
  function fire(type, ctx) {
    const ev = EVENTS[type]; if (!ev) return;
    lastEventAt = performance.now();
    const mark = ev.tone === "+" ? "▲" : ev.tone === "-" ? "▼" : "•";
    readout(`${mark} ${ev.text(ctx.label, ctx.detail)}`, ev.tone, ctx.issueId ?? null, ctx.agentId ?? null);
    feedAdd({ ts: new Date().toISOString(), company: ctx.company ?? null, text: `${mark} ${ev.text(ctx.label, ctx.detail)}`, tone: ev.tone, issueId: ctx.issueId ?? null, agentId: ctx.agentId ?? null });
    blip(ev.tone === "+" ? 880 : ev.tone === "-" ? 330 : 600, 0.09);
    if (!ev.fx || reduced) return;
    const co = planetFor(ctx.company); const ao = ctx.agentId ? agentObjs.get(ctx.agentId) : null;
    const build = {
      aurora: () => co && wrapT(pfx.aurora(co.center, co.radius)),
      beacon: () => co && wrapT(pfx.beacon(co.center, co.radius, dirOnPlanet(co, ao, ctx.label), camera)),
      supply: () => ao && wrapT(pfx.supply(() => ao.pos, ao.size)),
      clear: () => co && wrapT(pfx.clearSky(co.center, co.radius, dirOnPlanet(co, ao, ctx.label))),
      city: () => co && wrapT(pfx.cityLights(co.center, co.radius, SUN, tier.name === "low" ? 60 : 160)),
      impacts: () => co && wrapT(pfx.impacts(co.center, co.radius, SUN)),
      tremor: () => co && wrapT(pfx.tremor(co.planet, co.center, co.radius, SUN)),
      shooting: () => ao && shootingStar(ao.pos.clone()),
      comet: () => ctx.cometTo && comet(ctx.cometTo(), ctx.onArrive),
      sputter: () => { ufoSputter(ctx.agentId); return null; },
      ufo: () => { ufoArrive(ctx.agentId); return null; },
    }[ev.fx];
    if (build) queueFx(ev.fx, build, ev.big);
  }
  function wrapT(e) {
    world.add(e.obj);
    return { dur: e.dur, update: (k, dt) => e.update(k, dt, clock), end: () => { e.end?.(); world.remove(e.obj); } };
  }

  // Persistent negative events: attacks, storms, ice. They last while the condition holds.
  const persist = new Map(); // key → {fx, label, issueId, tone}
  function syncPersistent() {
    const want = new Map();
    const comps = store.board?.companies ?? [];
    for (const c of comps) {
      const co = companyObjs.get(c.prefix); if (!co) continue;
      const qs = c.issues.filter((i) => i.questions.length);
      if (qs.length) {
        const i = qs[0], ao = agentObjs.get(i.assigneeAgentId);
        want.set("attack:" + c.prefix, { label: `${i.identifier} · waiting on you`, issueId: i.id, make: () => pfx.attack(co.center, co.radius, () => (ao ? ao.pos : co.center), reduced) });
      }
      const blocked = c.issues.filter((i) => i.status === "blocked").slice(0, 3);
      for (const i of blocked) {
        const ao = agentObjs.get(i.assigneeAgentId);
        want.set("storm:" + i.id, { label: `${i.identifier} · blocked`, issueId: i.id, make: () => pfx.storm(co.center, co.radius, dirOnPlanet(co, ao, i.id), reduced) });
      }
      for (const i of c.issues) {
        if (i.status !== "in_progress" || Date.now() - new Date(i.updatedAt).getTime() < 2 * 3600e3) continue;
        const ao = agentObjs.get(i.assigneeAgentId); if (!ao || want.has("ice:" + ao.id)) continue;
        want.set("ice:" + ao.id, { label: `${i.identifier} · no update for 2 h`, issueId: i.id, make: () => pfx.ice(ao.moon, reduced) });
      }
    }
    for (const [k, p] of persist) if (!want.has(k)) {
      persist.delete(k);
      p.fx.stop().then(() => { if (p.fx.obj) world.remove(p.fx.obj); });
      stopping.push(p.fx);
      activeUntil = performance.now() + 2000;
    }
    for (const [k, w] of want) if (!persist.has(k)) {
      const f = w.make(); if (f.obj) world.add(f.obj);
      persist.set(k, { ...w, fx: f });
    } else Object.assign(persist.get(k), { label: w.label, issueId: w.issueId });
  }
  const stopping = [];
  function updatePersistent(dt) {
    for (const p of persist.values()) p.fx.update(dt, clock);
    for (let i = stopping.length - 1; i >= 0; i--) if (stopping[i].update(dt, clock) === false) stopping.splice(i, 1);
  }

  // ---------------- reacting to data ----------------
  let firstBoard = true;
  store.on("board", ({ prev, next }) => {
    const before = new Map();
    if (prev && !firstBoard) for (const c of prev.companies) for (const i of c.issues) before.set(i.id, { ...i, company: c.prefix });
    const prevQs = new Map((prev?.companies ?? []).flatMap((c) => c.issues.flatMap((i) => i.questions.map((q) => [q.id, { ...i, company: c.prefix }]))));
    const doneAt = new Map();
    for (const [id, io] of issueObjs) doneAt.set(id, io.sprite.position.clone());
    syncSky();
    if (!firstBoard && prev) {
      const nowQs = new Set();
      for (const c of next.companies) for (const i of c.issues) {
        const was = before.get(i.id);
        const ctx = { label: i.identifier, issueId: i.id, company: c.prefix, agentId: i.assigneeAgentId };
        for (const q of i.questions) { nowQs.add(q.id); if (!prevQs.has(q.id)) { fire("question", ctx); queueFx("pulse", pulse, false); } }
        if (!was) {
          if (OPEN.includes(i.status)) {
            const io = issueObjs.get(i.id);
            if (io) { io.hidden = !reduced; fire("newIssue", { ...ctx, cometTo: () => satellitePos(io, clock, v3()), onArrive: () => { io.hidden = false; } }); }
          }
          continue;
        }
        if (was.status !== i.status) {
          if ((i.status === "done" || i.status === "cancelled") && OPEN.includes(was.status)) {
            const p = doneAt.get(i.id); if (p && !reduced) queueFx("meteor", () => meteor(p), true);
            fire("done", ctx);
          } else if (i.status === "in_review") fire("review", ctx);
          else if (was.status === "blocked" && OPEN.includes(i.status)) fire("unblocked", ctx);
          else if (i.status === "blocked") fire("blocked", ctx);
          else if ((was.status === "done" || was.status === "cancelled") && OPEN.includes(i.status)) fire("reopened", ctx);
        }
        // Estimate changes (rough, local model).
        const e0 = prev.eta?.[i.identifier], e1 = next.eta?.[i.identifier];
        if (e1?.pct != null && e1.at !== e0?.at) {
          const d = e0?.pct != null ? e1.pct - e0.pct : 0;
          if (d >= 10) fire("progressUp", { ...ctx, detail: e1.pct });
          else if (d <= -10) fire("progressDown", { ...ctx, detail: e1.pct });
          else fire("estimate", { ...ctx, detail: `${e1.pct}% · ${e1.eta}` });
        }
      }
      for (const [qid, i] of prevQs) if (!nowQs.has(qid)) fire("answered", { label: i.identifier, issueId: i.id, company: i.company });
    }
    firstBoard = false;
    syncPersistent();
    drawSummary(); drawSlate();
    if (store.mode === "host" && !store.board) openNotice();
    dirty = true;
  });
  store.on("agents", ({ prev, next }) => {
    const was = new Map((prev ?? []).map((a) => [a.id, a]));
    syncSky();
    for (const a of next) {
      const p = was.get(a.id);
      if (a.live && !ufos.has(a.id)) {
        if (p && !p.live) fire("runStart", { label: a.name, agentId: a.id, company: a.company });
        else ufoArrive(a.id, true);
      }
      if (!a.live && p?.live) {
        // Did the run end cleanly? Look for its result line.
        const res = [...store.messages.values()].filter((m) => m.runId === p.runId && m.role === "result").pop();
        if (res && /completed/i.test(res.text)) ufoDepart(a.id);
        else fire("crashed", { label: a.name, agentId: a.id, company: a.company });
      } else if (!a.live && ufos.has(a.id) && !p) ufoDepart(a.id);
    }
    syncPersistent();
    if (slate.kind === "chat") drawSlate();
  });
  store.on("chat", () => { syncSky(); for (const a of store.agents) if (a.live) ufoArrive(a.id, true); syncPersistent(); if (slate.kind === "chat") drawSlate(); });
  let msgRedraw = null;
  const failedAt = new Map();
  store.on("msg", ({ msg, isNew }) => {
    if (slate.kind === "chat" && (msg.agentId === chat.agent || msg.role === "comment")) { clearTimeout(msgRedraw); msgRedraw = setTimeout(drawSlate, 150); }
    const fresh = Date.now() - new Date(msg.updatedTs ?? msg.ts).getTime() < 120000;
    if (!fresh) return;
    const ao = agentObjs.get(msg.agentId);
    const ctx = { label: msg.issue ?? ao?.data?.name ?? "agent", issueId: msg.issueId, company: msg.company ?? ao?.company, agentId: msg.agentId };
    if (isNew && msg.role === "comment" && !msg.fromUser && ao) fire(/\b[0-9a-f]{7,40}\b/.test(msg.text) || /\bpass(ed|es|ing)?\b/i.test(msg.text) ? "commit" : "comment", ctx);
    // Errors: a failing test run or an error in a tool result (at most once per agent per 3 min).
    const failing = (msg.role === "tool" && msg.status === "failed" && /\b\d+ (failed|failing)\b|FAIL\b|Error:/.test(msg.output ?? "")) || (msg.role === "result" && !/completed/i.test(msg.text ?? ""));
    if (failing && performance.now() - (failedAt.get(msg.agentId) ?? -1e9) > 180000) { failedAt.set(msg.agentId, performance.now()); fire("failed", ctx); }
    // Whole-sky view: what agents say appears briefly near their star.
    if ((view.level === "sky" || view.level === "company") && msg.role === "agent" && ao && msg.text?.length > 20) {
      const last = lastFloatAt.get(msg.agentId) ?? 0;
      if (performance.now() - last > 9000) { lastFloatAt.set(msg.agentId, performance.now()); floater(`${ao.data?.name ?? "Agent"}: ${msg.text.replace(/\s+/g, " ").slice(-110)}`, { atAgent: msg.agentId, dur: 6000 }); }
    }
    lastEventAt = performance.now();
  });
  store.on("log", () => { drawTicker(); dirty = true; });
  store.on("helper", () => { if (slate.kind === "issue") drawSlate(); });
  store.on("logEntry", () => { drawTicker(); dirty = true; });
  store.on("pair", () => { if (slate.kind === "pair") drawSlate(); drawPanel(); });
  store.on("link", () => {
    drawPanel(); drawSummary();
    if (store.mode === "remote") { if (store.link.state === "connected") { slate.forced = false; if (slate.kind === "link") closeSlate(); } else if (slate.kind !== "link") openSlate("link", true); else drawSlate(); }
    if (store.mode === "lost") { notice = store.link.error || "Open this page from the QR code on your Mac's board."; openSlate("notice", true); }
  });
  store.on("listview", (show) => { paused = show; if (!show) { dirty = true; kick(); } });
  function openNotice() { notice = "Waiting for the board…"; openSlate("notice"); }

  // ---------------- layout ----------------
  let W = 1, H = 1;
  const viewOffset = { x: 0, y: 0, tx: 0, ty: 0 };
  function layout() {
    W = canvas.clientWidth; H = canvas.clientHeight;
    const wasPortrait = portrait;
    portrait = W / H < 0.85;
    renderer.setSize(W, H, false);
    composer.setSize(W, H);
    camera.aspect = W / H;
    camera.fov = portrait ? 62 : 52;
    ortho.left = 0; ortho.right = W; ortho.top = 0; ortho.bottom = -H; ortho.updateProjectionMatrix();
    film.uniforms.uAspect.value = W / H;
    film.uniforms.uRes.value.set(W * dpr, H * dpr);
    const safeTop = 8, gut = 16;
    sumPlate.place(gut + 30, safeTop + 8, W - gut * 2 - 60, W < 640 ? 62 : 72); drawSummary();
    framePlate.place(0, 0, W, H); drawFrame();
    handlePlate.place(W - frameInset() - 19, H * 0.42, 18, 80); drawHandle();
    feedPlate.place(W, frameInset() + 1, feedWidth(), H - 2 * frameInset() - 36); drawFeed();
    { const g = frameGeom(W, H); panelPlate.place(Math.max(g.t + 4, g.bn0 - (W < 640 ? 60 : 90)), H - g.t - g.n - 28, Math.min(W - 2 * g.t - 8, (g.bn1 - g.bn0) + (W < 640 ? 120 : 180)), 26); }
    drawPanel();
    tickPlate.show(false); // the ticker is replaced by readout screens on the frame
    // Main slate: right column on wide screens, lower sheet on phones.
    const wide = W >= 860;
    let area;
    if (wide) { const w = slate.kind === "chat" ? 400 : Math.min(460, Math.round(W * 0.38)); area = { x: W - w - gut - 8, y: 104, w, h: H - 104 - 70 }; }
    else { const h = Math.round(H * (slate.kind === "pair" || slate.kind === "link" || slate.kind === "notice" ? 0.72 : 0.6)); area = { x: gut, y: H - h - 50, w: W - gut * 2, h }; }
    slate.area = area;
    slate.plate.place(area.x, area.y, area.w, area.h);
    viewOffset.tx = slate.kind ? (wide ? area.w / 2 + gut : 0) : 0;
    viewOffset.ty = slate.kind ? (wide ? 0 : (area.h + 34) / 2 - 40) : 0;
    if (reduced) { viewOffset.x = viewOffset.tx; viewOffset.y = viewOffset.ty; }
    drawSlate();
    if (wasPortrait !== portrait) { for (const co of companyObjs.values()) co.center = null; syncSky(); if (view.level === "sky") goSky(); }
    dirty = true;
  }
  addEventListener("resize", () => { layout(); kick(); });

  // ---------------- input: pointer, pinch, wheel, gestures ----------------
  const pointers = new Map();
  let gesture = null; // {kind:'rotate'|'scroll'|'dial'|'pinch', ...}
  let lastTap = { t: 0, x: 0, y: 0 };
  let cornerTimer = null;
  let twoTap = null;

  function glassHit(x, y) {
    for (const p of [handlePlate, feedPlate, panelPlate, slate.plate, sumPlate, ...readouts.map((r) => r.plate)]) { const h = p.hit(x, y); if (h) return { plate: p, ...h }; }
    return null;
  }
  function pickWorld(x, y, prefer) {
    let best = null, bestD = Infinity;
    for (const pk of pickables) {
      const io = pk.kind === "issue" ? issueObjs.get(pk.id) : null;
      if (io?.hidden) continue;
      const p = pk.pos().clone().project(camera);
      if (p.z > 1) continue;
      const sx = (p.x * 0.5 + 0.5) * W, sy = (-p.y * 0.5 + 0.5) * H;
      const d = Math.hypot(sx - x, sy - y);
      const bias = pk.kind === prefer ? 0.7 : 1;
      if (d < pk.r && d * bias < bestD) { best = pk; bestD = d * bias; }
    }
    return best;
  }

  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t0: performance.now() });
    kick();
    if (pointers.size === 1) {
      const hit = glassHit(e.clientX, e.clientY);
      gesture = hit?.plate === slate.plate ? { kind: "scroll", y: e.clientY, s0: slate.scroll }
        : hit?.plate === feedPlate ? { kind: "feed", y: e.clientY, x: e.clientX, s0: feed.scroll }
        : e.clientX > W - 22 && !feed.open ? { kind: "edge", x: e.clientX } : { kind: "rotate" };
      if (e.clientX < 56 && e.clientY < 56) cornerTimer = setTimeout(() => { gesture = null; toggleList(true); }, 650);
      if (hit?.plate === panelPlate) wakePanel();
    } else if (pointers.size === 2) {
      clearTimeout(cornerTimer); clearTimeout(longPressMoon);
      const [a, b] = [...pointers.values()];
      gesture = { kind: "pinch", d0: Math.hypot(a.x - b.x, a.y - b.y), dist0: rig.goal.dist };
      twoTap = { t0: performance.now(), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, moved: false };
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    const p = pointers.get(e.pointerId); if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (Math.hypot(p.x - p.sx, p.y - p.sy) > 8) { clearTimeout(cornerTimer); if (gesture?.kind !== "dial") clearTimeout(longPressMoon); if (twoTap) twoTap.moved = true; }
    if (!gesture) return;
    kick();
    if (gesture.kind === "feed") { feed.scroll = gesture.s0 - (e.clientY - gesture.y); if (e.clientX - gesture.x > 60) { toggleFeed(false); gesture = null; } else drawFeed(); return; }
    if (gesture.kind === "edge") { if (gesture.x - e.clientX > 40) { toggleFeed(true); gesture = null; } return; }
    if (gesture.kind === "rotate" && pointers.size === 1) { rig.vyaw -= dx * 0.0022; rig.vpitch += dy * 0.0018; }
    else if (gesture.kind === "scroll") { slate.scroll = gesture.s0 + (slateAnchorBottom() ? (e.clientY - gesture.y) : -(e.clientY - gesture.y)); drawSlate(); }
    else if (gesture.kind === "pinch" && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      rig.goal.dist = Math.max(3, Math.min(140, gesture.dist0 * gesture.d0 / Math.max(10, d)));
      zoomLevels();
    }
  });
  const slateAnchorBottom = () => slate.kind === "chat";
  const valueToAngle = (v) => (Math.log(v / 5) / Math.log(60)) * Math.PI * 2;
  const _unusedAngleToValue = (a) => Math.max(5, Math.min(300, Math.round(5 * Math.pow(60, a / (Math.PI * 2)))));

  async function endPointer(e) {
    const p = pointers.get(e.pointerId); if (!p) return;
    pointers.delete(e.pointerId);
    clearTimeout(cornerTimer); clearTimeout(longPressMoon);
    if (twoTap && pointers.size === 0) {
      const quick = performance.now() - twoTap.t0 < 350 && !twoTap.moved;
      const tt = twoTap; twoTap = null; gesture = null;
      if (quick) { const pk = pickWorld(tt.x, tt.y, "issue"); if (pk?.kind === "issue") { const io = issueObjs.get(pk.id); goIssue(pk.id); estimate(io.data.identifier); } }
      return;
    }
    if (pointers.size > 0) return;
    const moved = Math.hypot(e.clientX - p.sx, e.clientY - p.sy);
    const dt = performance.now() - p.t0;
    gesture = null;
    if (moved > 8 || dt > 500) return;
    // Double tap: back out one level.
    const now = performance.now();
    const dbl = now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30;
    lastTap = { t: now, x: e.clientX, y: e.clientY };
    const hit = glassHit(e.clientX, e.clientY);
    if (feed.open && hit?.plate !== feedPlate && hit?.plate !== handlePlate) { toggleFeed(false); return; }
    if (hit) {
      if (hit.plate === panelPlate) wakePanel();
      if (hit.spot?.fn === "panel:refresh") { blip(880); try { await act("refresh"); } catch (err) { notice = err.message; } return; }
      if (hit.spot?.fn === "panel:interval") { blip(520); const cur = store.board?.intervalSec ?? 15; const nx = INTERVALS.find((v) => v > cur) ?? INTERVALS[0]; try { await act("config", { intervalSec: nx }); } catch (err) { notice = err.message; } drawPanel(); return; }
      if (hit.spot?.fn === "panel:view") { blip(600); if (view.level === "sky") { const first = [...companyObjs.keys()][0]; if (first) goCompany(first); } else if (view.level === "company") toggleList(true); else goSky(); drawPanel(); return; }
      if (hit.spot?.fn === "panel:sound") { panel.sound = !panel.sound; blip(740); drawPanel(); return; }
      if (hit.spot?.fn === "panel:pair") { if (store.mode === "host") { if (store.pair.state === "idle") startPairing(); openSlate("pair"); } else if (store.mode === "remote") openSlate("link", store.link.state !== "connected"); return; }
      if (typeof hit.spot?.fn === "function") { hit.spot.fn(); return; }
      if (hit.plate === slate.plate) return; // tap on the glass with nothing there
    }
    if (dbl) { backOut(); return; }
    const prefer = { sky: "company", company: "agent", agent: "issue", issue: "issue" }[view.level];
    const pk = pickWorld(e.clientX, e.clientY, prefer);
    if (!pk) return;
    if (pk.kind === "company") goCompany(pk.id);
    else if (pk.kind === "agent") goAgent(pk.id);
    else if (pk.kind === "issue") goIssue(pk.id);
  }
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", (e) => { pointers.delete(e.pointerId); gesture = null; clearTimeout(cornerTimer); clearTimeout(longPressMoon); });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault(); kick();
    const hit = glassHit(e.clientX, e.clientY);
    if (hit?.plate === slate.plate) { slate.scroll += slateAnchorBottom() ? e.deltaY * -1 : e.deltaY; drawSlate(); return; }
    rig.goal.dist = Math.max(3, Math.min(140, rig.goal.dist * Math.exp(e.deltaY * 0.0012)));
    zoomLevels();
  }, { passive: false });
  addEventListener("keydown", (e) => {
    if (document.activeElement === kbd) return;
    if (e.key === "Escape") { if (feed.open) toggleFeed(false); else backOut(); }
    if (e.key === "l" || e.key === "L") toggleList(true);
  });

  // Subtle parallax: mouse position on desktop, device tilt on phones (iOS asks after a tap).
  if (!reduced) {
    canvas.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse" && e.clientY > H - 34) wakePanel(); if (e.pointerType === "mouse" && pointers.size === 0) { look.tx = (e.clientX / W) * 2 - 1; look.ty = (e.clientY / H) * 2 - 1; kick(); } });
    const onTilt = (e) => { if (e.gamma == null) return; look.tx = Math.max(-1, Math.min(1, e.gamma / 25)); look.ty = Math.max(-1, Math.min(1, ((e.beta ?? 45) - 45) / 25)); kick(); };
    const enableTilt = async () => {
      canvas.removeEventListener("pointerup", enableTilt);
      try {
        if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
          if ((await DeviceOrientationEvent.requestPermission()) !== "granted") return;
        }
        addEventListener("deviceorientation", onTilt);
      } catch { /* denied: no tilt */ }
    };
    if (tier.mobile) canvas.addEventListener("pointerup", enableTilt);
  }

  // Zooming in and out moves between sky, constellation and star.
  let zoomLock = 0;
  function zoomLevels() {
    if (performance.now() < zoomLock) return;
    const L = levelDist(), d = rig.goal.dist;
    const centerPick = (kind) => {
      let best = null, bd = Infinity;
      for (const pk of pickables) if (pk.kind === kind) { const p = pk.pos().clone().project(camera); const dd = Math.hypot(p.x, p.y); if (p.z < 1 && dd < bd) { bd = dd; best = pk; } }
      return best;
    };
    const lock = () => { zoomLock = performance.now() + 900; };
    if (view.level === "sky" && d < L.sky * 0.62) { const c = centerPick("company"); if (c) { lock(); goCompany(c.id); } }
    else if (view.level === "company" && d < L.company * 0.55) { const a = centerPick("agent"); if (a) { lock(); goAgent(a.id); } }
    else if (view.level === "company" && d > L.company * 1.7) { lock(); goSky(); }
    else if ((view.level === "agent" || view.level === "issue") && d > L.agent * 2.1) { lock(); view.company ? goCompany(view.company) : goSky(); }
  }

  // ---------------- render loop ----------------
  const perf = { frames: 0, ms: 0, avg: 0, tier: tier.name, gpu: tier.gpu };
  window.__observatory = perf;
  if (new URLSearchParams(location.search).has("debug")) window.__obsDebug = { glass, ortho, renderer, camera, sumPlate: () => sumPlate, panelPlate: () => panelPlate, bracketPlate: () => bracketPlate, slate, rig, view: () => view };
  function kick() { activeUntil = Math.max(activeUntil, performance.now() + 1500); if (!rafId && !paused && !isHidden()) rafId = raf(frame); }
  document.addEventListener("visibilitychange", () => { if (isHidden()) { cancelAnimationFrame(rafId); rafId = 0; } else { last = performance.now(); kick(); } });

  function frame(now) {
    rafId = 0;
    if (paused || isHidden()) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    clock += dt;

    // Start queued effects without crowding the sky.
    // At most one big and two small effects at once, so the sky never gets busy.
    for (let qi = 0; qi < fxQueue.length; qi++) {
      const job = fxQueue[qi];
      const bigs = running.filter((r) => r.big).length, smalls = running.length - bigs;
      if (job.big ? bigs >= 1 : smalls >= 2) continue;
      fxQueue.splice(qi--, 1);
      const r = job.fn(); if (r) running.push({ ...r, t: 0, big: job.big });
    }
    for (let i = running.length - 1; i >= 0; i--) {
      const r = running[i]; r.t += dt;
      const k = Math.min(1, r.t / r.dur);
      r.update(k, dt);
      if (k >= 1) { r.end?.(); running.splice(i, 1); }
    }
    if (!reduced && !loneUfo && now - lastEventAt > 60000 && fxQueue.length === 0 && running.length === 0) {
      lastEventAt = now; loneUfo = { g: makeUfo(), t: 0 }; loneUfo.g.scale.setScalar(1.4); world.add(loneUfo.g);
    }

    // Camera: inertial approach to the goal, plus drag inertia.
    if (rig.follow) rig.goal.target.copy(rig.follow());
    const k = reduced ? 1 : 1 - Math.exp(-dt * 3.0);
    const before = rig.target.clone();
    rig.target.lerp(rig.goal.target, k);
    rig.dist += (rig.goal.dist - rig.dist) * k;
    rig.yaw = Math.max(-0.9, Math.min(0.9, rig.yaw + rig.vyaw)); rig.pitch = Math.max(-0.6, Math.min(0.6, rig.pitch + rig.vpitch));
    rig.vyaw *= 0.9; rig.vpitch *= 0.9;
    if (pointers.size === 0) { rig.yaw *= 0.995; rig.pitch *= 0.995; }
    const speed = before.distanceTo(rig.target) / Math.max(dt, 1e-3);
    rig.speed += (speed - rig.speed) * 0.2;
    const warpAmt = reduced ? 0 : Math.min(1, Math.max(0, (rig.speed - 8) / 40));
    // Parallax from the mouse (desktop) or device tilt (phones), eased.
    look.x += (look.tx - look.x) * Math.min(1, dt * 3); look.y += (look.ty - look.y) * Math.min(1, dt * 3);
    if (Math.abs(look.tx - look.x) > 0.0005 || Math.abs(look.ty - look.y) > 0.0005) activeUntil = Math.max(activeUntil, now + 100);
    const yaw = rig.yaw + look.x * 0.06, pitch = rig.pitch + look.y * 0.045;
    camera.position.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).multiplyScalar(rig.dist).add(rig.target);
    camera.lookAt(rig.target);
    viewOffset.x += (viewOffset.tx - viewOffset.x) * (reduced ? 1 : 1 - Math.exp(-dt * 6));
    viewOffset.y += (viewOffset.ty - viewOffset.y) * (reduced ? 1 : 1 - Math.exp(-dt * 6));
    camera.setViewOffset(W, H, viewOffset.x, viewOffset.y, W, H);
    camera.updateProjectionMatrix();
    warpMat.opacity = warpAmt * 0.6; warp.scale.z = 1 + warpAmt * 12; warp.visible = warpAmt > 0.01;
    if (bokeh) {
      bokeh.enabled = warpAmt > 0.05 || rig.speed > 4;
      if (bokeh.enabled) { bokeh.uniforms.focus.value = rig.dist; bokeh.uniforms.aperture.value = 0.00008 * Math.min(1, rig.speed / 20); }
    }

    // Sky.
    starfield.update(clock, warpAmt, reduced ? 0 : 1, camera.position);
    debris.update(dt);
    nebula2.position.copy(camera.position); // farthest layer: no parallax
    if (!reduced) nebula2.rotation.y += dt * 0.0006; // churns over minutes
    updateLightning(dt);

    const lvl = view.level;
    for (const co of companyObjs.values()) {
      const target = lvl === "sky" ? 0.8 : co.prefix === view.company ? 0.5 : 0.3;
      co.label.material.opacity += (target - co.label.material.opacity) * 0.15;
    }
    for (const co of companyObjs.values()) {
      if (!reduced) { co.planet.rotation.y += dt * co.spin; const cl = co.planet.children[0]; if (cl?.userData.clouds) cl.rotation.y += dt * co.spin * 0.6; }
      if (Math.abs(co.ringPct - co.ringShown) > 0.05) { co.ringShown += (co.ringPct - co.ringShown) * (reduced ? 1 : Math.min(1, dt * 2)); activeUntil = Math.max(activeUntil, now + 200); }
      co.ring.geometry.setDrawRange(0, Math.round(co.ringShown / 100 * 128) + (co.ringShown > 0 ? 1 : 0));
    }
    for (const ao of agentObjs.values()) {
      const a = ao.data ?? {};
      placeMoon(ao, clock);
      const flare = a.live ? 1 + (reduced ? 0 : 0.15 * Math.sin(clock * 2.2 + ao.h * 9)) : 1;
      ao.moon.material.emissiveIntensity = a.live ? 0.12 * flare : a.queued ? 0.04 : 0;
      ao.glow.material.opacity = a.live ? 0.12 * flare : 0;
      ao.glow.scale.setScalar(ao.size * 2.4);
      const show = lvl === "sky" ? (W < 640 ? 0 : 0.5) : ao.company === view.company ? 0.95 : 0.25;
      ao.label.material.opacity += (show - ao.label.material.opacity) * 0.15;
      ao.orbitLine.material.opacity = ao.company === view.company ? 0.45 : 0.22;
    }
    for (const io of issueObjs.values()) {
      satellitePos(io, clock, io.sprite.position);
      io.orbit.position.copy(io.center); io.arc.position.copy(io.center);
      io.label.position.copy(io.sprite.position).add(new THREE.Vector3(0, -0.5, 0));
      let col = io.baseColor;
      if (io.question && !seenQuestions.has(io.id)) {
        const blink = reduced ? 1 : 0.55 + 0.45 * Math.sin(clock * 2.4);
        col = new THREE.Color(1.0, 0.66, 0.26).multiplyScalar(1.1 + 1.6 * blink);
      } else if (io.question) col = new THREE.Color(1.0, 0.7, 0.32).multiplyScalar(1.2);
      io.sprite.material.color.copy(col);
      io.sprite.material.opacity = io.hidden ? 0 : 1;
      io.sprite.scale.setScalar(io.size * (io.status === "blocked" ? 0.9 : 1.15));
      const near = (lvl === "agent" || lvl === "issue") && (io.hostAgent?.id === view.agent || io.id === view.issue) || (lvl === "company" && io.data.company === view.company);
      io.label.material.opacity += ((near ? 0.9 : 0) - io.label.material.opacity) * 0.15;
      io.orbit.material.opacity = near ? 0.12 : 0.05;
      io.arc.material.opacity = near ? 0.85 : 0.4;
      // Progress arc grows smoothly to the latest estimate.
      const goal = Math.max(0, io.arcPct);
      if (Math.abs(goal - io.arcShown) > 0.05) { io.arcShown += (goal - io.arcShown) * (reduced ? 1 : Math.min(1, dt * 2.5)); activeUntil = Math.max(activeUntil, now + 200); }
      io.arc.geometry.setDrawRange(0, Math.round((io.arcShown / 100) * 96) + (io.arcShown > 0 ? 1 : 0));
    }
    updateUfos(dt, clock);
    updatePersistent(dt);
    if (persist.size && !reduced) activeUntil = Math.max(activeUntil, now + 100);
    particles.update(dt);

    // Glass.
    const sinceOpen = (now - slate.openedAt) / 220;
    slate.plate.mat.uniforms.uReveal.value = reduced ? 1 : Math.min(1, sinceOpen);
    if (slate.wipeAt) {
      const w = reduced ? 1 : Math.min(1, (now - slate.wipeAt) / 700);
      slate.plate.mat.uniforms.uWipe.value = w;
      if (w >= 1) { slate.wipeAt = 0; slate.plate.mat.uniforms.uWipe.value = 0; const f = slate.onWiped; slate.onWiped = null; f?.(); }
    }
    const condenseTarget = slate.kind ? 1 : 0;
    film.uniforms.uCondense.value = 0; void condenseTarget;
    film.uniforms.uTime.value = clock;
    advanceStreams(dt);
    if (slate.editing || now < slate.animUntil) drawSlate();
    if (Math.floor(clock) !== Math.floor(clock - dt)) drawPanel();
    if (panel.bright > 0 && now - (panel.wokeAt ?? 0) > 3000) { panel.bright = Math.max(0, panel.bright - dt * 1.5); drawPanel(); }
    if (now < sumAnimUntil) drawSummary();
    updateBrackets();
    placeLabels();
    {
      const sv = SUN.clone().transformDirection(camera.matrixWorldInverse);
      const sweeping = now >= sweepAt && now <= sweepAt + 2400;
      if (sweeping || Math.abs(sv.x - frameSun.x) + Math.abs(-sv.y - frameSun.y) > 0.08 || Math.abs(look.x - frameLook) > 0.04 || Math.floor(now / 1000) !== frame._sec) { frame._sec = Math.floor(now / 1000); drawFrame(now); }
      if (sweeping) activeUntil = Math.max(activeUntil, now + 50);
    }
    pumpReadouts(now);
    placeFeed(dt);
    // Thin leader line from the selected moon to the comms panel.
    if (slate.kind === "chat" && slate.plate.visible && agentObjs.get(chat.agent)) {
      const p = agentObjs.get(chat.agent).pos.clone().project(camera);
      const sx = (p.x * 0.5 + 0.5) * W, sy = (-p.y * 0.5 + 0.5) * H;
      const r = slate.area, wideL = W >= 860;
      const ex = wideL ? r.x : Math.min(Math.max(sx, r.x + 20), r.x + r.w - 20), ey = wideL ? Math.min(Math.max(sy, r.y + 20), r.y + 60) : r.y;
      const pos = leader.geometry.attributes.position; pos.setXYZ(0, sx, -sy, 0); pos.setXYZ(1, ex, -ey, 0); pos.needsUpdate = true;
      leader.visible = p.z < 1;
    } else leader.visible = false;
    if (!reduced) tickPlate.mat.uniforms.uOffset.value = (tickPlate.mat.uniforms.uOffset.value + dt * 34 / (tickPlate.textW || 1000)) % 1;
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i]; let k = (now - f.t0) / f.dur;
      let sx, sy;
      if (f.atAgent) { const ao = agentObjs.get(f.atAgent); if (!ao) { k = 2; } else { const p = ao.pos.clone().project(camera); sx = (p.x * 0.5 + 0.5) * W + 18; sy = (-p.y * 0.5 + 0.5) * H - f.h - 6 - k * 14; } }
      else { const ao = agentObjs.get(f.toAgent); const p = ao ? ao.pos.clone().project(camera) : new THREE.Vector3(0, 1, 0); const tx = (p.x * 0.5 + 0.5) * W, ty = (-p.y * 0.5 + 0.5) * H; const e = fx.easeInOut(Math.min(1, k)); sx = f.from.x + (tx - f.from.x) * e; sy = f.from.y + (ty - f.from.y) * e; f.p.mesh.scale.set(f.w * (1 - e * 0.7), f.h * (1 - e * 0.7), 1); }
      if (sx != null) f.p.mesh.position.set(sx + f.w / 2, -(sy + f.h / 2), 0);
      f.p.mat.uniforms.uOpacity.value = k < 0.15 ? k / 0.15 : k > 0.75 ? Math.max(0, (1 - k) / 0.25) : 1;
      f.p.mat.uniforms.uReveal.value = Math.min(1, k * 4);
      if (k >= 1) { glass.remove(f.p.mesh); f.p.tex.dispose(); floaters.splice(i, 1); }
    }

    // Render: full rate while something moves; a low idle rate keeps the stars alive.
    const active = now < activeUntil || running.length > 0 || particles.alive > 0 || floaters.length > 0 || pointers.size > 0 || Math.abs(rig.goal.dist - rig.dist) > 0.05 || rig.target.distanceTo(rig.goal.target) > 0.02 || [...ufos.values()].some((u) => u.state !== "hover") || !!loneUfo || film.uniforms.uPulse.value >= 0 || slate.editing || now < slate.animUntil || (slate.plate.visible && sinceOpen < 1);
    const idleGap = reduced ? Infinity : 1000 / tier.fpsIdle;
    if (active || dirty || now - lastRender >= idleGap) {
      const t0 = performance.now();
      composer.render(dt);
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(glass, ortho);
      renderer.autoClear = true;
      dirty = false;
      if (active) {
        perf.frames++; const ft = now - lastRender; if (lastRender && ft < 200) { perf.ms += ft; perf.avg = perf.ms / perf.frames; }
        perf.cpuMs = performance.now() - t0;
      }
      lastRender = now;
    }
    if (active || !reduced) rafId = raf(frame);
    else if (dirty) rafId = raf(frame);
  }

  // Idle repaint for the countdown ring and live data even with reduced motion.
  setInterval(() => { drawPanel(); dirty = true; if (!rafId && !paused && !isHidden()) rafId = raf(frame); }, 1000);

  layout();
  syncSky();
  for (const a of store.agents) if (a.live) ufoArrive(a.id, true);
  drawTicker();
  if (store.mode === "remote" && store.link.state !== "connected") openSlate("link", true);
  if (store.mode === "lost") { notice = store.link.error || "Open this page from the QR code on your Mac's board."; openSlate("notice", true); }
  goSky();
  if (store.mode === "remote" && store.link.state !== "connected") openSlate("link", true);
  console.info(`[observatory] tier=${tier.name} dpr=${dpr} gpu=${tier.gpu}`);
  kick();
}
