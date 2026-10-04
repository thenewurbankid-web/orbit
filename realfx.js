// Real-imagery effects: textures cut from real photos and footage (see assets/fx/CREDITS.md), drawn as
// camera-facing billboards. Light (flares, beams, fire) is additive; smoke darkens what is behind it; craft
// are NASA spacecraft renders shaded toward the scene's sun. Each texture loads in the background and is
// cached; until it arrives, callers keep their procedural effect (`ready(name)` is false).
import * as THREE from "three";

const cache = new Map();
const GRID = 6, FRAMES = 36; // explosion flipbook: 6×6 frames, row by row from the top left
// Craft atlas: 4×2 cells. nose = image angle (rad) the craft's front points to; wobble = idle drift.
const CRAFT = {
  drone:   { cell: 0, nose: 0, engine: 0 },              // MarCO CubeSat
  fighter: { cell: 1, nose: Math.PI, engine: 0.42 },     // Parker Solar Probe, heat shield forward
  pod:     { cell: 2, nose: -Math.PI / 2, engine: 0.4 }, // TESS, cameras up
  // New Horizons: its white dish faces us and the render is lit flat, so its highlights are rolled off hard
  // (knee) and the whole craft sits lower (gain) to read like the others under the scene's single sun.
  hostile: { cell: 3, nose: Math.PI / 2, engine: 0, face: true, gain: 0.72, knee: 0.3 }, // New Horizons, dish toward us
  ufo:     { cell: 4, nose: 0, engine: 0, face: true },  // Juno
};

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

export function createRealFx({ tier, reduced, camera, world, sun, particles }) {
  const small = tier.mobile || tier.name === "low";
  const tex = {};
  const loads = {};
  function load(name, ext = "jpg") {
    const url = `assets/fx/${name}${small ? "-sm" : ""}.${ext}`;
    if (!cache.has(url)) cache.set(url, new THREE.TextureLoader().loadAsync(url).then((t) => {
      t.colorSpace = THREE.SRGBColorSpace; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; return t;
    }).catch(() => null));
    loads[name] = cache.get(url).then((t) => { if (t) tex[name] = t; return t; });
  }
  load("explosion"); load("glint"); load("flare"); load("streak"); load("laser"); load("craft", "webp");
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

  // ---------- explosions: real fireball footage as a flipbook ----------
  const expMat = () => new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, toneMapped: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    uniforms: { map: { value: tex.explosion }, uFrame: { value: 0 }, uHeat: { value: 1 }, uSmoke: { value: 0 }, uFade: { value: 0 }, uGain: { value: 1 }, uTint: { value: new THREE.Color(1, 1, 1) }, uFlip: { value: 1 },
      uRot: { value: 0 }, uSize: { value: new THREE.Vector2(1, 1) }, uOff: { value: new THREE.Vector2() } },
    vertexShader: VERT,
    fragmentShader: `uniform sampler2D map; uniform float uFrame, uHeat, uSmoke, uFade, uGain, uFlip; uniform vec3 uTint; varying vec2 vUv;
      vec2 cell(float f, vec2 uv) { float r = floor(f / ${GRID}.0), c = f - r * ${GRID}.0; return (vec2(c, ${GRID - 1}.0 - r) + uv) / ${GRID}.0; }
      void main() {
        vec2 uv = vec2(uFlip > 0.0 ? vUv.x : 1.0 - vUv.x, vUv.y);
        uv = clamp(uv, 0.004, 0.996);
        float f0 = floor(uFrame), fr = uFrame - f0;
        vec3 c = mix(texture2D(map, cell(f0, uv)).rgb, texture2D(map, cell(min(f0 + 1.0, ${FRAMES - 1}.0), uv)).rgb, fr);
        float l = dot(c, vec3(0.3, 0.55, 0.15));
        // Cooling: the real footage's white-yellow core first, then orange, then a dull ember red that dies to smoke.
        vec3 ember = vec3(0.42, 0.08, 0.015) * l * l * l;
        // Per pixel: only the brightest parts keep the footage's hot colour; the rim and, over time, everything cools
        // to a dull red, so the ball keeps its real structure instead of reading as a flat bright disc.
        float h = clamp(uHeat * 1.5 - (1.0 - l) * 0.9, 0.0, 1.0);
        vec3 col = mix(ember, c, h) * uTint * uGain * (1.0 - uSmoke * 0.9); // embers die as the smoke takes over
        float smoke = smoothstep(0.02, 0.25, l) * uSmoke;
        col += vec3(0.045, 0.04, 0.038) * smoke; // smoke faintly lit, dark grey-brown
        gl_FragColor = vec4(col * uFade, smoke * uFade);
      }`,
  });
  const live = []; // running transient effects {update(dt) → keep}
  const HOT = new THREE.Color(1.0, 0.82, 0.55).multiplyScalar(2.4), EMBER = new THREE.Color(0.5, 0.1, 0.02).multiplyScalar(0.15);
  // A short space explosion: hot flash, real fireball that cools to dark smoke, fine sparks. Silent.
  function boom(pos, { size = 1, tint = null, sparks = true, dur = 1.5, delay = 0 } = {}) {
    if (reduced) return false;
    const at = pos.clone();
    const g = new THREE.Group(); g.position.copy(at);
    let ball = null;
    if (tex.explosion) {
      const mat = expMat(); if (tint) mat.uniforms.uTint.value.copy(tint);
      mat.uniforms.uRot.value = (Math.random() - 0.5) * 0.7; mat.uniforms.uFlip.value = Math.random() < 0.5 ? 1 : -1;
      ball = board(mat, size); g.add(ball);
      api.lastBall = ball;
    }
    const flash = tex.glint ? glint("glint", new THREE.Color(1, 0.93, 0.82), size * 2.2, 0) : null;
    if (flash) { flash.material.uniforms.uRot.value = Math.random() * Math.PI; g.add(flash); }
    let t = -delay, started = false;
    live.push((dt) => {
      t += dt; if (t < 0) return true;
      if (!started) {
        started = true; world.add(g);
        if (sparks && particles) {
          const n = small ? 10 : 22;
          for (let i = 0; i < n; i++) particles.emit(at.clone(), new THREE.Vector3().randomDirection().multiplyScalar(size * (2.5 + Math.random() * 3)), HOT, EMBER, 0.05 + Math.random() * 0.05, 0.3 + Math.random() * 0.45); // fine, fast, short-lived
        }
        if (!ball && !flash && particles) for (let i = 0; i < 30; i++) particles.emit(at.clone(), new THREE.Vector3().randomDirection().multiplyScalar(0.8 + Math.random() * 1.6), HOT, EMBER, 0.3, 0.9);
      }
      const k = Math.min(1, t / dur);
      if (ball) {
        const u = ball.material.uniforms;
        u.uFrame.value = Math.min(FRAMES - 1.001, Math.pow(k, 0.8) * FRAMES);
        u.uHeat.value = 1 - THREE.MathUtils.smoothstep(k, 0.03, 0.3);
        u.uSmoke.value = THREE.MathUtils.smoothstep(k, 0.18, 0.5) * 0.92;
        u.uFade.value = (k < 0.04 ? k / 0.04 : 1) * (1 - THREE.MathUtils.smoothstep(k, 0.55, 1));
        u.uGain.value = 0.42 + 0.75 * Math.max(0, 1 - k * 5); // bright only in the first instant: no blown-out blob
        ball.scale.setScalar(0.55 + 0.75 * (1 - Math.pow(1 - k, 3)));
      }
      if (flash) {
        const ft = t / 0.28;
        flash.material.uniforms.uOpacity.value = ft < 1 ? Math.pow(1 - ft, 2) * 1.6 : 0;
        flash.scale.setScalar(0.5 + Math.min(1, ft) * 0.8);
      }
      if (k >= 1) { world.remove(g); return false; }
      return true;
    });
    return true;
  }

  // A brief burst of real lens glare (a hatch opening, a delivery landing): no fire.
  function flash(pos, { size = 1, color = new THREE.Color(1, 1, 1), dur = 0.6, name = "glint", aspect = 1, rot = null } = {}) {
    if (reduced || !tex[name]) return false;
    const m = glint(name, color, size, 0); m.position.copy(pos); m.material.uniforms.uRot.value = rot ?? Math.random() * Math.PI;
    m.material.uniforms.uSize.value.set(size, size / aspect);
    world.add(m);
    let t = 0;
    live.push((dt) => {
      t += dt; const k = Math.min(1, t / dur);
      m.material.uniforms.uOpacity.value = (k < 0.12 ? k / 0.12 : Math.pow(1 - (k - 0.12) / 0.88, 2)) * 1.4;
      m.scale.setScalar(0.7 + 0.5 * k);
      if (k >= 1) { world.remove(m); return false; }
      return true;
    });
    return true;
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
  // A travelling bolt from a to b (a short segment, soft ends), with a muzzle glint and a hit glint.
  function bolt(from, to, { color = new THREE.Color(0.35, 1.0, 0.55), width = 0.035, dur = 0.42, hit = true } = {}) {
    if (reduced) return false;
    const a = from.clone(), b = to.clone();
    const m = beamMesh(color, width); world.add(m);
    const muzzle = tex.glint ? glint("glint", color.clone().lerp(new THREE.Color(1, 1, 1), 0.5), width * 9, 0) : null;
    if (muzzle) { muzzle.position.copy(a); world.add(muzzle); }
    const head = new THREE.Vector3(), tail = new THREE.Vector3();
    let t = 0, struck = false;
    live.push((dt) => {
      t += dt; const k = t / dur;
      const hk = Math.min(1, k * 1.5), tk = Math.max(0, k * 1.5 - 0.55);
      head.lerpVectors(a, b, hk); tail.lerpVectors(a, b, Math.min(hk - 0.001, tk));
      m.userData.set(tail, head);
      m.material.uniforms.uOpacity.value = Math.min(1, k * 8) * (1 - THREE.MathUtils.smoothstep(k, 0.75, 1)) * 1.3;
      if (muzzle) muzzle.material.uniforms.uOpacity.value = Math.max(0, 1 - k * 5) * 1.2;
      if (hit && !struck && hk >= 1) { struck = true; flash(b, { size: width * 14, color: color.clone().lerp(new THREE.Color(1, 1, 1), 0.4), dur: 0.35 }); }
      if (k >= 1) { world.remove(m); if (muzzle) world.remove(muzzle); m.geometry.dispose(); return false; }
      return true;
    });
    return true;
  }

  // ---------- craft: NASA spacecraft renders as billboards, shaded toward the sun ----------
  const craftMat = (cell) => new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, toneMapped: true,
    uniforms: { map: { value: tex.craft ?? null }, uCell: { value: new THREE.Vector2(cell % 4, 1 - Math.floor(cell / 4)) }, uSun: shared.uSun, uOpacity: { value: 1 }, uDim: { value: 1 }, uWarm: { value: 0 }, uKnee: { value: 10 },
      uRot: { value: 0 }, uSize: { value: new THREE.Vector2(1, 1) }, uOff: { value: new THREE.Vector2() } },
    vertexShader: VERT,
    fragmentShader: `uniform sampler2D map; uniform vec2 uCell; uniform vec3 uSun; uniform float uOpacity, uDim, uWarm, uKnee; varying vec2 vUv; varying vec2 vS;
      void main() {
        vec4 t = texture2D(map, (uCell + vUv) / vec2(4.0, 2.0));
        if (t.a < 0.02) discard;
        float g = dot(t.rgb, vec3(0.3, 0.55, 0.15));
        vec3 c = mix(vec3(g), t.rgb, 0.7) * vec3(0.92, 0.96, 1.0);          // grade the bright renders down a little
        float m = max(c.r, max(c.g, c.b));
        if (m > uKnee) c *= (uKnee + (m - uKnee) * 0.22) / m;                // roll off near-white (New Horizons' dish)
        float side = clamp(dot(normalize(vS + 1e-4) * min(1.0, length(vS)), normalize(uSun.xy + 1e-4)), -1.0, 1.0);
        float lit = 0.3 + 0.85 * smoothstep(-0.9, 0.9, side) * (0.55 + 0.45 * max(uSun.z, 0.0) + 0.45 * length(uSun.xy));
        c *= lit * uDim;
        c = mix(c, c * vec3(1.25, 0.8, 0.55), uWarm);                       // hostile craft: amber cast
        gl_FragColor = vec4(c, t.a * uOpacity);
      }`,
  });
  const crafts = new Set();
  // Puts the real craft on a procedural group (keeps its motion), hiding the drawn meshes once the image is in.
  function dress(g, kind, { size = 0.42, dim = 1, warm = 0, engineColor = null, hide = [] } = {}) {
    const spec = CRAFT[kind]; if (!spec) return g;
    const mat = craftMat(spec.cell); mat.uniforms.uDim.value = dim * (spec.gain ?? 1); mat.uniforms.uWarm.value = warm; mat.uniforms.uKnee.value = spec.knee ?? 10;
    const bb = board(mat, size); bb.renderOrder = 4; bb.visible = false;
    let eng = null;
    if (spec.engine && engineColor) { eng = glint("glint", engineColor, size * 0.55, 0.9); eng.renderOrder = 5; eng.visible = false; }
    g.add(bb); if (eng) g.add(eng);
    const real = { bb, eng, spec, size, ang: null, on: false, age: 0 };
    g.userData.real = real;
    const apply = () => {
      if (!tex.craft) return;
      mat.uniforms.map.value = tex.craft;
      g.traverse((o) => { if ((o.isMesh || o.isLine) && o !== bb && o !== eng && !o.userData.keep) { o.material = o.material.clone(); o.material.visible = false; } });
      for (const o of hide) { o.material = o.material.clone(); o.material.visible = false; }
      bb.visible = true; if (eng && tex.glint) eng.visible = true; real.on = true;
    };
    if (tex.craft) apply(); else loads.craft.then(apply);
    crafts.add(g);
    return g;
  }
  const pa = new THREE.Vector3(), pb = new THREE.Vector3(), fwd = new THREE.Vector3(), wp = new THREE.Vector3(), q = new THREE.Quaternion();
  function updateCrafts(dt) {
    for (const g of crafts) {
      if (!g.parent) { crafts.delete(g); continue; }
      const r = g.userData.real; if (!r.on) continue;
      r.age += dt; const fade = reduced ? 1 : Math.min(1, r.age / 0.4); // fade in, never pop
      r.bb.material.uniforms.uOpacity.value = fade * fade * (3 - 2 * fade);
      g.getWorldPosition(wp); g.getWorldQuaternion(q);
      fwd.set(0, 0, 1).applyQuaternion(q);
      pa.copy(wp).project(camera); pb.copy(wp).addScaledVector(fwd, 0.5).project(camera);
      const dx = (pb.x - pa.x) * camera.aspect, dy = pb.y - pa.y, len = Math.hypot(dx, dy);
      // Facing craft (hostiles, UFOs) stay upright with a little of the group's bank; the rest point along their path.
      const goal = r.spec.face ? (g.rotation.z || 0) * 0.6 : len > 0.002 ? Math.atan2(dy, dx) - r.spec.nose : (r.ang ?? 0);
      if (r.ang == null) r.ang = goal;
      let d = goal - r.ang; d = Math.atan2(Math.sin(d), Math.cos(d));
      r.ang += d * (1 - Math.exp(-dt * 7)); // heading turns smoothly, never snaps
      r.bb.material.uniforms.uRot.value = r.ang;
      if (r.eng) {
        const a = r.ang + r.spec.nose;
        r.eng.material.uniforms.uOff.value.set(-Math.cos(a) * r.size * r.spec.engine, -Math.sin(a) * r.size * r.spec.engine);
        r.eng.material.uniforms.uRot.value = a;
      }
    }
  }

  // Persistent soft beam (a UFO's light, a beacon): returns the mesh; call mesh.userData.set(a, b, w) and set opacity.
  function beam(color, width) { const m = beamMesh(color, width); m.material.uniforms.uOpacity.value = 0; return m; }

  function update(dt) {
    sunView.copy(sun).transformDirection(camera.matrixWorldInverse);
    shared.uSun.value.copy(sunView);
    for (let i = live.length - 1; i >= 0; i--) if (!live[i](dt)) live.splice(i, 1);
    updateCrafts(dt);
    return live.length > 0;
  }

  const api = { ready, loads, boom, flash, bolt, beam, glint, dress, update, meteorTrail, cometBody, ribbon, texture: (n) => tex[n] ?? null, get busy() { return live.length > 0; } };
  return api;
}
