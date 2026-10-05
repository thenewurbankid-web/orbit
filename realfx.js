// Real-imagery effects: textures cut from real photos and footage (see assets/fx/CREDITS.md), drawn as
// camera-facing billboards. Light (flares, beams, fire) is additive; smoke darkens what is behind it; craft
// are NASA spacecraft renders shaded toward the scene's sun. Each texture loads in the background and is
// cached; until it arrives, callers keep their procedural effect (`ready(name)` is false).
import * as THREE from "three";

const cache = new Map();
const ONE_SIZE = new Set(["hit", "bolt"]); // already tiny: one file for every tier
const VERT = `
  uniform float uRot; uniform vec2 uSize; uniform vec2 uOff;
  varying vec2 vUv; varying vec2 vS;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    float sx = length(modelMatrix[0].xyz), sy = length(modelMatrix[1].xyz);
    vec2 p = position.xy * uSize * vec2(sx, sy);
    float c = cos(uRot), s = sin(uRot);
    vS = vec2(c * position.x - s * position.y, s * position.x + c * position.y) * 2.0; // screen-aligned -1..1
    mv.xy += vec2(c * p.x - s * p.y, s * p.x + c * p.y) + uOff * vec2(sx, sy);
    gl_Position = projectionMatrix * mv;
  }`;

export function createRealFx({ tier, reduced, camera, world, sun, particles, envMap = null, flares = null }) {
  const small = tier.mobile || tier.name === "low";
  const tex = {};
  const loads = {};
  function load(name, ext = "jpg") {
    const url = `assets/fx/${name}${small && !ONE_SIZE.has(name) ? "-sm" : ""}.${ext}`;
    if (!cache.has(url)) cache.set(url, new THREE.TextureLoader().loadAsync(url).then((t) => {
      t.colorSpace = THREE.SRGBColorSpace; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; return t;
    }).catch(() => null));
    loads[name] = cache.get(url).then((t) => { if (t) tex[name] = t; return t; });
  }
  load("blast", "webp"); load("hit"); load("bolt", "png"); load("glint"); load("flare"); load("streak"); load("laser");
  load("aurora"); load("lightning"); load("comet"); load("meteor"); // aurora curtain, storm bolt, comet, meteor trail
  const ready = (n) => !!tex[n];

  // Procedural stand-in for the beam profile until the photo arrives (a soft Gaussian line).
  const softLine = (() => {
    const c = document.createElement("canvas"); c.width = 4; c.height = 32;
    const x = c.getContext("2d"), g = x.createLinearGradient(0, 0, 0, 32);
    g.addColorStop(0, "#000"); g.addColorStop(0.42, "#333"); g.addColorStop(0.5, "#fff"); g.addColorStop(0.58, "#333"); g.addColorStop(1, "#000");
    x.fillStyle = g; x.fillRect(0, 0, 4, 32);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();

  const quad = new THREE.PlaneGeometry(1, 1);
  const sunView = new THREE.Vector3();
  const shared = { uSun: { value: new THREE.Vector3(1, 0, 0) } };
  const additive = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false };

  function board(material, size = 1) {
    const m = new THREE.Mesh(quad, material);
    m.frustumCulled = false; m.renderOrder = 5;
    material.uniforms.uSize.value.set(size, size);
    return m;
  }

  // ---------- glints: real star-burst / lens-glare photos, additive ----------
  function glintMat(name, color, opacity = 1) {
    return new THREE.ShaderMaterial({
      ...additive,
      uniforms: { map: { value: tex[name] ?? null }, uColor: { value: new THREE.Color(color) }, uOpacity: { value: opacity }, uMono: { value: name === "streak" ? 1 : 0 }, uRot: { value: 0 }, uSize: { value: new THREE.Vector2(1, 1) }, uOff: { value: new THREE.Vector2() } },
      vertexShader: VERT,
      fragmentShader: `uniform sampler2D map; uniform vec3 uColor; uniform float uOpacity, uMono; varying vec2 vUv;
        void main() { vec3 c = texture2D(map, vUv).rgb; c = mix(c, vec3(max(c.r, max(c.g, c.b))), uMono); gl_FragColor = vec4(c * uColor * uOpacity, 1.0); }`,
    });
  }
  function glint(name, color, size, opacity = 1) {
    const mat = glintMat(name, color, opacity);
    const m = board(mat, size); m.visible = !!tex[name];
    if (!tex[name]) loads[name].then((t) => { if (t) { mat.uniforms.map.value = t; m.visible = true; } });
    return m;
  }

  // ---------- explosions: a pre-rendered flipbook (assets/fx/blast: the NASA Antares fireball for the fire, an
  // offline-rendered smoke puff and dragged, motion-blurred sparks, 48 frames at 16 fps). Runtime only places,
  // varies (size, rotation, mirror, rate ±10 %) and crossfades between frames; the timing lives in the render.
  const BLAST = { cols: 8, rows: 6, frames: 48, fps: 16 };
  const blastMat = () => new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, toneMapped: true,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    uniforms: { map: { value: tex.blast ?? null }, uFrame: { value: 0 }, uGain: { value: 1 }, uFlip: { value: 1 }, uGrid: { value: new THREE.Vector3(BLAST.cols, BLAST.rows, BLAST.frames) },
      uRot: { value: 0 }, uSize: { value: new THREE.Vector2(1, 1) }, uOff: { value: new THREE.Vector2() } },
    vertexShader: VERT,
    fragmentShader: `uniform sampler2D map; uniform float uFrame, uGain, uFlip; uniform vec3 uGrid; varying vec2 vUv;
      vec4 cell(float f, vec2 uv) { float r = floor(f / uGrid.x), c = f - r * uGrid.x; return texture2D(map, (vec2(c, uGrid.y - 1.0 - r) + uv) / uGrid.xy); }
      void main() {
        vec2 uv = clamp(vec2(uFlip > 0.0 ? vUv.x : 1.0 - vUv.x, vUv.y), 0.003, 0.997);
        float f0 = floor(uFrame), w = uFrame - f0;
        vec4 c = mix(cell(f0, uv), cell(min(f0 + 1.0, uGrid.z - 1.0), uv), w);   // crossfade: no frame stepping
        float edge = smoothstep(0.5, 0.36, length(vUv - 0.5));                      // feathered quad edge
        gl_FragColor = vec4(c.rgb * uGain, c.a) * edge;
      }`,
  });
  const live = []; // running transient effects {update(dt) → keep}
  // One shared point light lends each blast a brief glow on nearby surfaces (never more than one at a time).
  const lamp = new THREE.PointLight(0xffd9b0, 0, 4, 2); world.add(lamp);
  let lampT = -1, lampPeak = 0;
  function lightUp(pos, peak, range) { lamp.position.copy(pos); lamp.distance = range; lampPeak = peak; lampT = 0; }
  let lastBoom = -1e9;
  const MIN_GAP = 6000; // at most one blast in view, several seconds apart; extra ones become a faint glint
  // boom(pos, { size, scale }) → true if something was shown. `size` is the blast's world diameter.
  function boom(pos, { size = 0.3, rate = 1, light = 0.6, force = false } = {}) {
    if (reduced) return false;
    const now = performance.now();
    if (!tex.blast) return false;
    if (!force && (now - lastBoom < MIN_GAP || live.some((f) => f.blast))) { flash(pos, { size: 0.025, peak: 0.25, decay: 500 }); return true; }
    lastBoom = now;
    const mat = blastMat();
    const v = 0.85 + Math.random() * 0.3;
    mat.uniforms.uRot.value = Math.random() * Math.PI * 2; mat.uniforms.uFlip.value = Math.random() < 0.5 ? 1 : -1;
    mat.uniforms.uGain.value = 0.55;
    const m = board(mat, size * v); m.position.copy(pos); m.renderOrder = 7; world.add(m);
    const spd = rate * (0.9 + Math.random() * 0.2), drift = new THREE.Vector3().randomDirection().multiplyScalar(size * 0.04);
    flash(pos, { name: "glint", size: 0.02 + size * 0.03, peak: 0.35, attack: 30, decay: 420, color: [1, 0.95, 0.86] });
    lightUp(pos, light, Math.max(1.5, size * 12));
    let t = 0;
    const fx = (dt) => {
      t += dt * spd;
      const f = t * BLAST.fps;
      mat.uniforms.uFrame.value = Math.min(BLAST.frames - 1.001, f);
      m.position.addScaledVector(drift, dt);
      if (f >= BLAST.frames - 1) { world.remove(m); return false; }
      return true;
    };
    fx.blast = true; live.push(fx);
    return true;
  }

  // A brief burst of glare (a hatch opening, a delivery landing): a CSS flare, or a WebGL glint if none.
  function flash(pos, o = {}) {
    if (reduced) return false;
    if (flares) {
      const c = o.color ? (o.color.isColor ? [o.color.r, o.color.g, o.color.b] : o.color) : [1, 0.96, 0.9];
      const m = Math.max(...c, 1e-3), col = c.map((x) => x / m);           // colour only; intensity comes from `peak`
      return flares.flash(pos, { name: o.name ?? "glint", size: o.size ?? 0.04, color: col, peak: o.peak ?? 0.45, attack: o.attack ?? 35, decay: o.decay ?? (o.dur ? o.dur * 1000 : 600), aspect: o.aspect ?? 1, rot: o.rot != null ? (o.rot * 180) / Math.PI : undefined, follow: o.follow });
    }
    return false;
  }
  // ---------- beams: a real laser beam's measured profile, stretched between two points ----------
  // A camera-facing ribbon between two points (u along a→b, v across); set(a, b, w) moves it.
  function ribbon(mat, width, order = 6) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(12), 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 1, 0, 1, 1]), 2));
    geo.setIndex([0, 2, 1, 1, 2, 3]);
    const m = new THREE.Mesh(geo, mat); m.frustumCulled = false; m.renderOrder = order;
    const side = new THREE.Vector3(), dir = new THREE.Vector3(), toCam = new THREE.Vector3(), mid = new THREE.Vector3();
    m.userData.set = (a, b, w = width) => {
      dir.subVectors(b, a); mid.addVectors(a, b).multiplyScalar(0.5); toCam.subVectors(camera.position, mid);
      side.crossVectors(dir, toCam).normalize().multiplyScalar(w);
      const p = geo.attributes.position;
      p.setXYZ(0, a.x - side.x, a.y - side.y, a.z - side.z); p.setXYZ(1, a.x + side.x, a.y + side.y, a.z + side.z);
      p.setXYZ(2, b.x - side.x, b.y - side.y, b.z - side.z); p.setXYZ(3, b.x + side.x, b.y + side.y, b.z + side.z);
      p.needsUpdate = true;
    };
    return m;
  }
  function beamMesh(color, width) {
    const mat = new THREE.ShaderMaterial({
      ...additive, side: THREE.DoubleSide,
      uniforms: { map: { value: tex.laser ?? softLine }, uColor: { value: new THREE.Color(color) }, uOpacity: { value: 0 }, uHead: { value: 1 }, uTail: { value: 0 }, uTime: { value: 0 } },
      vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform sampler2D map; uniform vec3 uColor; uniform float uOpacity, uHead, uTail, uTime; varying vec2 vUv;
        void main() {
          float l = texture2D(map, vec2(fract(vUv.x * 0.6 + uTime), vUv.y)).r;
          float ends = smoothstep(0.0, 0.08, vUv.x) * smoothstep(1.0, 0.85, vUv.x);
          vec3 col = uColor * l + vec3(1.0) * pow(l, 4.0) * 0.6;  // white-hot core, coloured falloff
          gl_FragColor = vec4(col * ends * uOpacity, 1.0);
        }`,
    });
    if (!tex.laser) loads.laser.then((t) => { if (t) mat.uniforms.map.value = t; });
    return ribbon(mat, width);
  }

  // ---------- meteors and comets: a real meteor's streak (Perseid, NASA) and a real comet (Lovejoy from the ISS) ----------
  // Trail: the photographed streak's colour and width, tapered so it is brightest at the head and the train fades behind.
  function meteorTrail(width) {
    const mat = new THREE.ShaderMaterial({
      ...additive, side: THREE.DoubleSide,
      uniforms: { map: { value: tex.meteor ?? softLine }, uColor: { value: new THREE.Color(1, 1, 1) }, uOpacity: { value: 0 }, uU: { value: new THREE.Vector2(0, 1) }, uHead: { value: 0.75 } },
      vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform sampler2D map; uniform vec3 uColor; uniform float uOpacity, uHead; uniform vec2 uU; varying vec2 vUv;
        void main() {
          vec3 c = texture2D(map, vec2(mix(uU.x, uU.y, vUv.x), vUv.y)).rgb;
          float along = pow(vUv.x, 1.0 + uHead * 1.5) * smoothstep(1.0, 0.985, vUv.x); // train fades behind the head
          gl_FragColor = vec4(c * uColor * along * uOpacity, 1.0);
        }`,
    });
    if (!tex.meteor) loads.meteor.then((t) => { if (t) mat.uniforms.map.value = t; });
    return ribbon(mat, width, 5);
  }
  // Comet: the photographed head and tail as one ribbon from the head outward (u = 0 at the head end).
  const COMET_HEAD_U = 0.057, COMET_ASPECT = 5.4; // where the nucleus sits in comet.jpg; length / width of the crop
  function cometBody() {
    const mat = new THREE.ShaderMaterial({
      ...additive, side: THREE.DoubleSide,
      uniforms: { map: { value: tex.comet ?? null }, uColor: { value: new THREE.Color(1, 1, 1) }, uOpacity: { value: 0 } },
      vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform sampler2D map; uniform vec3 uColor; uniform float uOpacity; varying vec2 vUv;
        void main() { gl_FragColor = vec4(texture2D(map, vUv).rgb * uColor * uOpacity, 1.0); }`,
    });
    const m = ribbon(mat, 0.1, 5);
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    // Place: nucleus at `head`, tail of length `len` along `dir` (unit).
    m.userData.place = (head, dir, len) => {
      a.copy(head).addScaledVector(dir, -len * COMET_HEAD_U / (1 - COMET_HEAD_U));
      b.copy(head).addScaledVector(dir, len);
      m.userData.set(a, b, a.distanceTo(b) / (2 * COMET_ASPECT));
    };
    return m;
  }
  // ---------- blaster bolts: instanced, camera-facing capsules with a white-hot core and a tinted glow
  // (pre-rendered profile assets/fx/bolt.png). Short and fast; pooled; a tiny hit spark flipbook on impact.
  const BOLTS = 32;
  const bGeo = new THREE.InstancedBufferGeometry();
  bGeo.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0], 3));
  bGeo.setIndex([0, 1, 2, 2, 1, 3]);
  const aA = new THREE.InstancedBufferAttribute(new Float32Array(BOLTS * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const aB = new THREE.InstancedBufferAttribute(new Float32Array(BOLTS * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const aC = new THREE.InstancedBufferAttribute(new Float32Array(BOLTS * 4), 4).setUsage(THREE.DynamicDrawUsage); // rgb, opacity
  const aW = new THREE.InstancedBufferAttribute(new Float32Array(BOLTS), 1).setUsage(THREE.DynamicDrawUsage);
  bGeo.setAttribute("aA", aA); bGeo.setAttribute("aB", aB); bGeo.setAttribute("aC", aC); bGeo.setAttribute("aW", aW);
  bGeo.instanceCount = 0;
  const bMat = new THREE.ShaderMaterial({
    ...additive, side: THREE.DoubleSide, // the ribbon's winding depends on its direction on screen
    uniforms: { map: { value: null } },
    vertexShader: `attribute vec3 aA, aB; attribute vec4 aC; attribute float aW; varying vec2 vUv; varying vec4 vC;
      void main() {
        vec4 a = viewMatrix * vec4(aA, 1.0), b = viewMatrix * vec4(aB, 1.0);
        vec3 d = b.xyz - a.xyz; float L = length(d); d /= max(L, 1e-4);
        vec3 side = normalize(cross(d, normalize(-(a.xyz + b.xyz) * 0.5))) * aW;
        vec3 p = mix(a.xyz - d * aW, b.xyz + d * aW, position.x) + side * (position.y * 2.0 - 1.0) * 2.2;
        vUv = position.xy; vC = aC; gl_Position = projectionMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: `uniform sampler2D map; varying vec2 vUv; varying vec4 vC;
      void main() { vec2 t = texture2D(map, vUv).rg; vec3 col = vec3(1.0, 0.98, 0.95) * t.r * 1.6 + vC.rgb * t.g * 0.45; gl_FragColor = vec4(col * vC.a, 1.0); }`,
  });
  loads.bolt.then((t) => { bMat.uniforms.map.value = t; });
  const bMesh = new THREE.Mesh(bGeo, bMat); bMesh.frustumCulled = false; bMesh.renderOrder = 6; world.add(bMesh);
  const bolts = [];
  const hitMat = () => new THREE.ShaderMaterial({ ...additive, uniforms: { map: { value: tex.hit }, uFrame: { value: 0 }, uGain: { value: 0.6 }, uRot: { value: 0 }, uSize: { value: new THREE.Vector2(1, 1) }, uOff: { value: new THREE.Vector2() } },
    vertexShader: VERT, fragmentShader: `uniform sampler2D map; uniform float uFrame, uGain; varying vec2 vUv;
      vec3 cell(float f) { float r = floor(f / 4.0), c = f - r * 4.0; return texture2D(map, (vec2(c, 3.0 - r) + vUv) / 4.0).rgb; }
      void main() { float f0 = floor(uFrame); gl_FragColor = vec4(mix(cell(f0), cell(min(15.0, f0 + 1.0)), uFrame - f0) * uGain, 1.0); }` });
  function hitSpark(pos, size) {
    if (!tex.hit) return;
    const m = board(hitMat(), size); m.position.copy(pos); m.material.uniforms.uRot.value = Math.random() * 6.28; world.add(m);
    let t = 0; live.push((dt) => { t += dt; m.material.uniforms.uFrame.value = Math.min(14.999, t * 40); if (t > 0.4) { world.remove(m); return false; } return true; });
  }
  // One bolt from a toward b. speed in units/s; it either hits b (tiny spark, glint, a touch of light) or fades past it.
  function fireBolt(a, b, { color, width = 0.012, len = 0.3, speed = 30, hit = true, delay = 0 }) {
    const dir = b.clone().sub(a); const dist = dir.length(); dir.divideScalar(dist || 1);
    bolts.push({ a: a.clone(), dir, dist, color: new THREE.Color(color), w: width * (0.85 + Math.random() * 0.3), len: len * (0.8 + Math.random() * 0.4), speed, t: -delay, hit, struck: false, muzzle: false });
  }
  function bolt(from, to, { color = new THREE.Color(0.35, 1.0, 0.55), width = 0.012, burst = 2, gap = 0.08, hit = true, speed = 30 } = {}) {
    if (reduced || bolts.length > BOLTS - 4) return false;
    const n = Math.max(1, burst);
    for (let i = 0; i < n; i++) {
      const spread = new THREE.Vector3().randomDirection().multiplyScalar(from.distanceTo(to) * 0.012);
      fireBolt(from, to.clone().add(spread), { color, width, speed, delay: i * gap * (0.85 + Math.random() * 0.3), hit: hit && (i === 0 || Math.random() < 0.6) });
    }
    return true;
  }
  const hd = new THREE.Vector3(), tl = new THREE.Vector3();
  function updateBolts(dt) {
    let n = 0;
    for (let i = bolts.length - 1; i >= 0; i--) {
      const o = bolts[i]; o.t += dt; if (o.t < 0) continue;
      if (!o.muzzle) { o.muzzle = true; flash(o.a, { size: 0.012, peak: 0.3, attack: 16, decay: 140, color: o.color.clone().lerp(new THREE.Color(1, 1, 1), 0.6) }); }
      const head = o.t * o.speed, tail = Math.max(0, head - o.len);
      const stop = o.hit ? o.dist : o.dist * 1.6;
      let fade = 1;
      if (!o.hit && head > o.dist) fade = Math.max(0, 1 - (head - o.dist) / (o.dist * 0.6)); // a miss fades into the distance
      if (o.hit && head >= o.dist && !o.struck) {
        o.struck = true; const p = o.a.clone().addScaledVector(o.dir, o.dist);
        hitSpark(p, 0.09); flash(p, { size: 0.014, peak: 0.28, attack: 20, decay: 220, color: [1, 0.95, 0.88] }); lightUp(p, 0.15, 1.2);
      }
      if (tail >= stop || fade <= 0) { bolts.splice(i, 1); continue; }
      hd.copy(o.a).addScaledVector(o.dir, Math.min(head, stop)); tl.copy(o.a).addScaledVector(o.dir, tail);
      aA.setXYZ(n, tl.x, tl.y, tl.z); aB.setXYZ(n, hd.x, hd.y, hd.z);
      aC.setXYZW(n, o.color.r, o.color.g, o.color.b, fade * Math.min(1, o.t * 60)); aW.setX(n, o.w); n++;
    }
    bGeo.instanceCount = n;
    if (n) { aA.needsUpdate = aB.needsUpdate = aC.needsUpdate = aW.needsUpdate = true; }
    // the shared point light: instant attack, exponential decay (~120 ms)
    if (lampT >= 0) { lampT += dt; lamp.intensity = lampPeak * Math.exp(-lampT / 0.12); if (lampT > 1) { lampT = -1; lamp.intensity = 0; } }
    return n > 0 || lampT >= 0;
  }
  // ---------- craft: real 3D models (Kenney Space Kit, CC0) with a realistic material pass: gunmetal, dark
  // panels and carbon PBR lit by the scene's sun and environment, tiny running lights, and a tight engine glow
  // that follows thrust. The UFO-style run craft is a smooth lens disc modelled here. Until a model loads the
  // procedural carrier stays visible.
  const SHIP_FILE = { drone: "drone", fighter: "fighter", pod: "hauler", hostile: "hostile", "vessel-a": "vessel-a", "vessel-b": "vessel-b", "vessel-c": "vessel-c" };
  const models = {};
  const gltf = import("three/addons/loaders/GLTFLoader.js").then((m) => new m.GLTFLoader());
  function model(name) {
    if (!models[name]) models[name] = gltf.then((l) => l.loadAsync(`assets/fx/ships/${name}.glb`)).then((g) => g.scene).catch(() => null);
    return models[name];
  }
  const dot = (() => { // soft point for lights and engines (a tiny pre-rendered PSF)
    const c = document.createElement("canvas"); c.width = c.height = 32; const x = c.getContext("2d");
    const g = x.createRadialGradient(16, 16, 0, 16, 16, 16); g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(0.18, "rgba(255,255,255,0.55)"); g.addColorStop(0.5, "rgba(255,255,255,0.08)"); g.addColorStop(1, "rgba(255,255,255,0)");
    x.fillStyle = g; x.fillRect(0, 0, 32, 32); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const pbr = {
    ours: { metal: [0x40454c, 0.35, 0.58], metalDark: [0x272b30, 0.35, 0.6], dark: [0x0f1012, 0.2, 0.7], metalRed: [0x323840, 0.35, 0.58] },
    hostile: { metal: [0x2e2b29, 0.35, 0.6], metalDark: [0x1d1b19, 0.35, 0.62], dark: [0x0b0a09, 0.2, 0.7], metalRed: [0x33201c, 0.35, 0.6] },
  };
  function materialPass(root, scheme) {
    const cache = new Map();
const ONE_SIZE = new Set(["hit", "bolt"]); // already tiny: one file for every tier
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.material = [].concat(o.material).map((m) => {
        if (!cache.has(m.name)) {
          const [col, metal, rough] = (pbr[scheme][m.name] ?? pbr[scheme].metal);
          cache.set(m.name, new THREE.MeshStandardMaterial({ color: col, metalness: metal, roughness: rough, envMap, envMapIntensity: 0.12, transparent: true, opacity: 0, flatShading: false }));
        }
        return cache.get(m.name);
      });
      if (o.material.length === 1) o.material = o.material[0];
      o.castShadow = o.receiveShadow = false;
    });
    return [...cache.values()];
  }
  function lensDisc() {
    const prof = [[0, -0.1], [0.5, -0.085], [0.88, -0.03], [1.0, 0.0], [0.9, 0.035], [0.55, 0.08], [0.25, 0.12], [0, 0.125]].map(([x, y]) => new THREE.Vector2(x, y));
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.LatheGeometry(prof, 48), new THREE.MeshStandardMaterial({ name: "metal", color: 0x5c6168, metalness: 0.9, roughness: 0.3 })));
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.995, 0.012, 6, 64), new THREE.MeshStandardMaterial({ name: "dark", color: 0x111214 })); rim.rotation.x = Math.PI / 2; g.add(rim);
    return Promise.resolve(g);
  }
  const lightSprite = (color, s) => { const m = new THREE.Sprite(new THREE.SpriteMaterial({ map: dot, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: true })); m.scale.setScalar(s); return m; };
  const crafts = new Set();
  function dress(g, kind, { size = 0.4, dim = 1, warm = 0, engineColor = null, hide = [] } = {}) {
    const hostile = kind === "hostile";
    const real = { on: false, age: 0, thrust: 0.3, engines: [], lights: [], mats: [], kind, size };
    g.userData.real = real;
    const src = kind === "ufo" ? lensDisc() : model(SHIP_FILE[kind] ?? "drone");
    src.then((root) => {
      if (!root || !g.parent && !g.userData.keepAlive) { if (!root) return; }
      const m = root.clone(true);
      real.mats = materialPass(m, hostile ? "hostile" : "ours");
      if (dim !== 1) real.mats.forEach((x) => x.color.multiplyScalar(dim));
      const box = new THREE.Box3().setFromObject(m), sz = box.getSize(new THREE.Vector3()), ctr = box.getCenter(new THREE.Vector3());
      const k = size / Math.max(sz.x, sz.y, sz.z);
      const holder = new THREE.Group();
      m.position.sub(ctr); holder.add(m); holder.scale.setScalar(k);
      if (kind !== "ufo") holder.rotation.y = Math.PI; // the kit's noses point -Z; ours fly +Z
      // lights in the holder's (unscaled) frame, then mapped to the group
      const half = sz.clone().multiplyScalar(0.5);
      const run = hostile ? new THREE.Color(0.85, 0.42, 0.3) : new THREE.Color(0.95, 0.92, 0.86);
      if (kind === "ufo") {
        for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2, l = lightSprite(new THREE.Color(0.8, 0.86, 0.95), size * 0.05); l.position.set(Math.cos(a) * size * 0.5, 0, Math.sin(a) * size * 0.5); g.add(l); real.lights.push(l); }
      } else {
        for (const sx of [-1, 1]) { const l = lightSprite(hostile ? run : sx < 0 ? new THREE.Color(0.95, 0.75, 0.68) : new THREE.Color(0.75, 0.95, 0.82), size * 0.05); l.position.set(sx * half.x * k * 0.96, 0, 0); g.add(l); real.lights.push(l); }
        if (hostile) { const l = lightSprite(new THREE.Color(0.95, 0.4, 0.22), size * 0.06); l.position.set(0, half.y * k * 0.9, half.z * k * 0.6); g.add(l); real.lights.push(l); }
        const ec = engineColor ? new THREE.Color(engineColor) : new THREE.Color(0.9, 0.93, 1.0);
        ec.lerp(new THREE.Color(1, 0.97, 0.92), 0.6); // warm white with a hint of colour
        for (const sx of kind === "pod" ? [0] : [-0.3, 0.3]) { const e = lightSprite(ec, size * 0.09); e.position.set(sx * half.x * k, 0, -half.z * k * 0.98); g.add(e); real.engines.push(e); }
      }
      holder.traverse((o) => { if (o.isMesh) o.layers.enable(4); }); // VELOCITY_LAYER (post.js): per-object motion blur
      g.add(holder); real.holder = holder;
      g.traverse((o) => { if ((o.isMesh || o.isLine || o.isPoints) && !o.userData.keep && !isInside(o, holder) && !real.lights.includes(o) && !real.engines.includes(o)) { o.material = o.material.clone(); o.material.visible = false; } });
      for (const o of hide) { o.material = o.material.clone(); o.material.visible = false; }
      real.on = true;
    });
    crafts.add(g);
    return g;
  }
  const isInside = (o, root) => { for (let p = o; p; p = p.parent) if (p === root) return true; return false; };
  // Thrust drives the engine glow (brighter accelerating, dim cruising); running lights glow slowly, never strobe.
  function updateCrafts(dt, t) {
    for (const g of crafts) {
      if (!g.parent) { crafts.delete(g); continue; }
      const r = g.userData.real; if (!r.on) continue;
      r.age += dt;
      const fade = reduced ? 1 : Math.min(1, r.age / 0.6), e = fade * fade * (3 - 2 * fade);
      for (const m of r.mats) { m.opacity = e; m.transparent = e < 1; m.depthWrite = e >= 1; }
      const thr = Math.max(0, Math.min(1, r.thrust ?? 0.3));
      r.engines.forEach((s) => { s.material.opacity = e * (0.25 + 0.6 * thr); s.scale.setScalar(r.size * (0.06 + 0.05 * thr)); });
      r.lights.forEach((s, i) => { s.material.opacity = e * (reduced ? 0.6 : 0.45 + 0.3 * Math.sin(0.9 * t - 0.6 * i)); });
    }
  }
  // Persistent soft beam (a UFO's light, a beacon): returns the mesh; call mesh.userData.set(a, b, w) and set opacity.
  function beam(color, width) { const m = beamMesh(color, width); m.material.uniforms.uOpacity.value = 0; return m; }

  let clockT = 0;
  function update(dt) {
    clockT += dt;
    sunView.copy(sun).transformDirection(camera.matrixWorldInverse);
    shared.uSun.value.copy(sunView);
    for (let i = live.length - 1; i >= 0; i--) if (!live[i](dt)) live.splice(i, 1);
    const b = updateBolts(dt);
    updateCrafts(dt, clockT);
    busyB = b;
    return live.length > 0 || b;
  }
  let busyB = false;

  const api = { _bMesh: bMesh, _bolts: bolts, _bGeo: bGeo, _bMat: bMat, ready, loads, boom, flash, bolt, beam, glint, dress, update, meteorTrail, cometBody, ribbon, texture: (n) => tex[n] ?? null, get busy() { return live.length > 0 || busyB; } };
  return api;
}
