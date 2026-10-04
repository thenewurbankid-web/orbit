// Observatory visuals: quality tiers, starfield, Milky Way, nebula dust, frost glass,
// effects (meteor, comet, UFO, shooting star, warp) and the final glass/film pass.
// Everything is procedural; no assets are downloaded.
import * as THREE from "three";

// ---------------- quality tiers ----------------
export function detectTier(renderer) {
  const ua = navigator.userAgent;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (navigator.maxTouchPoints > 1 && Math.min(screen.width, screen.height) < 900);
  let gpu = "";
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  } catch { /* ignore */ }
  const weakGpu = /SwiftShader|llvmpipe|Software|Mali-4|Mali-T|Adreno \(TM\) [345]\d\d|PowerVR SGX|Intel\(R\) HD Graphics [2-5]/i.test(gpu);
  const mem = navigator.deviceMemory ?? 8;
  const cores = navigator.hardwareConcurrency ?? 8;
  let name = "high";
  // Phones: iOS reports cores and memory unreliably, so only a known-weak GPU drops to "low".
  if (mobile) name = weakGpu ? "low" : "medium";
  else if (weakGpu || mem <= 4) name = "medium";
  const forced = new URLSearchParams(location.search).get("tier");
  if (["low", "medium", "high"].includes(forced)) name = forced;
  const t = {
    high: { stars: 9000, particles: 1000, bloomScale: 1, dpr: 2, frostOctaves: 1, transmission: true, nebula: 8, fpsIdle: 12 },
    medium: { stars: 4500, particles: 600, bloomScale: 0.75, dpr: 2, frostOctaves: 1, transmission: false, nebula: 6, fpsIdle: 10 },
    low: { stars: 1500, particles: 220, bloomScale: 0.35, dpr: 1, frostOctaves: 0, transmission: false, nebula: 3, fpsIdle: 6 },
  }[name];
  return { name, mobile, gpu, ...t };
}

// ---------------- colour helpers ----------------
// Black-body colour (Tanner Helland's fit), then pulled toward white/ice so it stays restrained.
export function kelvinColor(k, desat = 0.6) {
  const t = k / 100;
  let r, g, b;
  if (t <= 66) { r = 255; g = 99.47 * Math.log(t) - 161.12; b = t <= 19 ? 0 : 138.52 * Math.log(t - 10) - 305.04; }
  else { r = 329.7 * Math.pow(t - 60, -0.1332); g = 288.12 * Math.pow(t - 60, -0.0755); b = 255; }
  const c = new THREE.Color(Math.min(255, Math.max(0, r)) / 255, Math.min(255, Math.max(0, g)) / 255, Math.min(255, Math.max(0, b)) / 255);
  return c.lerp(new THREE.Color(0.86, 0.92, 1.0), desat);
}

// Soft point-spread sprite: core + halo + optional diffraction spikes.
export function psfTexture(size = 128, spikes = true) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const x = c.getContext("2d");
  const h = size / 2;
  const g = x.createRadialGradient(h, h, 0, h, h, h);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.08, "rgba(255,255,255,0.85)");
  g.addColorStop(0.22, "rgba(255,255,255,0.22)");
  g.addColorStop(0.5, "rgba(255,255,255,0.05)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  x.fillStyle = g;
  x.fillRect(0, 0, size, size);
  if (spikes) {
    x.globalCompositeOperation = "lighter";
    for (const [dx, dy] of [[1, 0], [0, 1]]) {
      const lg = x.createLinearGradient(h - dx * h, h - dy * h, h + dx * h, h + dy * h);
      lg.addColorStop(0, "rgba(255,255,255,0)");
      lg.addColorStop(0.5, "rgba(255,255,255,0.55)");
      lg.addColorStop(1, "rgba(255,255,255,0)");
      x.fillStyle = lg;
      if (dx) x.fillRect(0, h - 0.8, size, 1.6); else x.fillRect(h - 0.8, 0, 1.6, size);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------- starfield (three parallax shells) ----------------
const starVert = `
attribute float aSize; attribute vec3 aColor; attribute float aPhase;
uniform float uTime; uniform float uPixelRatio; uniform float uTwinkle; uniform float uWarp; uniform float uBright; uniform vec3 uTint;
varying vec3 vColor; varying float vSpike;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  // Scintillation: two incommensurate sines, stronger for brighter stars.
  // Small flicker on about 12% of the stars.
  float tw = 1.0 + uTwinkle * 0.22 * step(0.88, aPhase) * sin(uTime * (1.6 + aPhase * 2.7) + aPhase * 40.0);
  vSpike = 0.0;
  gl_PointSize = clamp((0.9 + min(aSize, 2.0) * 0.55) * uPixelRatio * (1.0 + uWarp * 0.6), 1.0, 4.0 * uPixelRatio);
  // White, crisp, kept under the bloom threshold so stars never glow.
  vColor = aColor * tw * min(0.88, 0.32 + min(aSize, 2.0) * 0.26) * uBright * uTint;
}`;
const starFrag = `
varying vec3 vColor; varying float vSpike;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  float core = 1.0 - smoothstep(0.35, 0.8, sqrt(r2)); // sharp 1-2 px core
  float a = core * (1.0 - smoothstep(0.75, 1.0, sqrt(r2))); // crisp point, no halo or spikes
  gl_FragColor = vec4(vColor * a, 1.0);
}`;

export function createStarfield(tier, pixelRatio) {
  const group = new THREE.Group();
  // Far, mid and near star shells; each follows the camera at a different rate (parallax).
  // Four layers from near to far; nearer layers follow the camera less, so they slide past faster.
  // Two sparse foreground layers (tiny, dim) and three background layers; nearer layers follow
  // the camera less, so they slide past faster.
  // Brightness falls with depth: near stars crisp white, the farthest layer ~35%.
  const shells = [{ r: 45, f: 0.025, follow: 0.0, near: 0.8, b: 1.0 }, { r: 90, f: 0.05, follow: 0.1, near: 0.9, b: 0.9 }, { r: 170, f: 0.35, follow: 0.45, b: 0.62 }, { r: 280, f: 0.33, follow: 0.78, b: 0.48 }, { r: 430, f: 0.25, follow: 0.95, b: 0.35 }];
  const mats = [];
  for (const s of shells) {
    const n = Math.round(tier.stars * s.f);
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n), phase = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      // Slight concentration toward the Milky Way plane.
      const v = new THREE.Vector3().randomDirection();
      if (Math.random() < 0.35) v.y *= 0.25, v.normalize();
      v.applyAxisAngle(new THREE.Vector3(0, 0, 1), 0.5);
      pos.set([v.x * s.r, v.y * s.r, v.z * s.r], i * 3);
      const k = 2800 + Math.pow(Math.random(), 1.6) * 11000;
      const c = kelvinColor(k, 0.88); // near white, slightly cool
      col.set([c.r, c.g, c.b], i * 3);
      size[i] = (0.55 + Math.pow(Math.random(), 9) * 3.4) * (s.near ?? 1);
      phase[i] = Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
    g.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
    g.setAttribute("aPhase", new THREE.BufferAttribute(phase, 1));
    const m = new THREE.ShaderMaterial({
      vertexShader: starVert, fragmentShader: starFrag,
      uniforms: { uTime: { value: 0 }, uPixelRatio: { value: pixelRatio }, uTwinkle: { value: 1 }, uWarp: { value: 0 }, uBright: { value: s.b ?? 1 }, uTint: { value: new THREE.Vector3(1, 1, 1) } },
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    });
    mats.push(m);
    const pts = new THREE.Points(g, m);
    pts.frustumCulled = false;
    pts.userData.follow = s.follow;
    group.add(pts);
  }
  return {
    group,
    setTint(r, g, b) { for (const m of mats) m.uniforms.uTint.value.set(r, g, b); },
    update(t, warp, twinkle, camPos) {
      for (const m of mats) { m.uniforms.uTime.value = t; m.uniforms.uWarp.value = warp; m.uniforms.uTwinkle.value = twinkle; }
      // Parallax: nearer shells follow the camera a little less.
      group.children.forEach((p) => p.position.copy(camPos).multiplyScalar(p.userData.follow));
    },
  };
}

// ---------------- Milky Way band ----------------
const noiseGLSL = `
float hash3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise3(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash3(i), hash3(i + vec3(1,0,0)), f.x), mix(hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), f.x), mix(hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm3(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * noise3(p); p *= 2.03; a *= 0.5; } return s; }`;

export function createMilkyWay() {
  const m = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { uIntensity: { value: 0.045 } },
    vertexShader: `varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `${noiseGLSL}
      uniform float uIntensity; varying vec3 vDir;
      void main() {
        vec3 n = normalize(vec3(-0.48, 0.88, 0.0));
        float d = dot(vDir, n);
        float band = exp(-d * d * 22.0);
        float clouds = fbm3(vDir * 4.0);
        float lanes = smoothstep(0.45, 0.75, fbm3(vDir * 9.0 + 3.1));
        float core = exp(-pow(length(vDir - normalize(vec3(0.3, 0.17, -1.0))), 2.0) * 3.0);
        float v = band * (0.35 + clouds) * (1.0 - 0.55 * lanes) * (0.6 + core);
        vec3 col = mix(vec3(0.55, 0.6, 0.68), vec3(0.85, 0.82, 0.78), core);
        gl_FragColor = vec4(col * v * uIntensity, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(520, 48, 24), m);
  mesh.frustumCulled = false;
  return mesh;
}

// ---------------- nebula dust ----------------
export function createNebula(tier) {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const x = c.getContext("2d");
  const img = x.createImageData(256, 256);
  for (let j = 0; j < 256; j++) for (let i = 0; i < 256; i++) {
    const dx = (i - 128) / 128, dy = (j - 128) / 128;
    const r = Math.sqrt(dx * dx + dy * dy);
    let v = 0, a = 0.5, f = 3;
    for (let o = 0; o < 5; o++) { v += a * (Math.sin(i / 256 * f * 6.28 + o * 1.7) * Math.cos(j / 256 * f * 5.1 + o * 2.3) * 0.5 + 0.5); a *= 0.5; f *= 2.1; }
    const al = Math.max(0, 1 - r) ** 2 * v;
    const k = (j * 256 + i) * 4;
    img.data[k] = img.data[k + 1] = img.data[k + 2] = 200;
    img.data[k + 3] = al * 255;
  }
  x.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  const group = new THREE.Group();
  for (let i = 0; i < tier.nebula; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: new THREE.Color(0.5, 0.53, 0.58), transparent: true, opacity: 0.012 + Math.random() * 0.012, blending: THREE.AdditiveBlending, depthWrite: false, rotation: Math.random() * 6.28 }));
    const v = new THREE.Vector3().randomDirection(); v.y *= 0.4; v.z = -Math.abs(v.z) - 0.3; v.normalize().multiplyScalar(140);
    s.position.copy(v);
    s.scale.setScalar(70 + Math.random() * 80);
    s.userData.drift = (Math.random() - 0.5) * 0.004;
    group.add(s);
  }
  return { group, update(dt) { for (const s of group.children) s.material.rotation += s.userData.drift * dt * 10; } };
}

// ---------------- frost (procedural dendrites → height, normal) ----------------
export function createFrostTexture(size = 512) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const x = c.getContext("2d");
  x.fillStyle = "#000"; x.fillRect(0, 0, size, size);
  x.strokeStyle = "#fff"; x.lineCap = "round";
  const branch = (px, py, ang, len, w, depth) => {
    if (depth <= 0 || len < 2) return;
    const nx = px + Math.cos(ang) * len, ny = py + Math.sin(ang) * len;
    x.globalAlpha = 0.25 + depth * 0.12; x.lineWidth = w;
    x.beginPath(); x.moveTo(px, py); x.lineTo(nx, ny); x.stroke();
    const steps = 3 + (depth > 2 ? 2 : 0);
    for (let k = 1; k <= steps; k++) {
      const t = k / (steps + 1);
      const bx = px + (nx - px) * t, by = py + (ny - py) * t;
      const side = len * (0.42 - t * 0.25);
      branch(bx, by, ang + Math.PI / 3, side, w * 0.6, depth - 1);
      branch(bx, by, ang - Math.PI / 3, side, w * 0.6, depth - 1);
    }
    branch(nx, ny, ang + (Math.random() - 0.5) * 0.3, len * 0.55, w * 0.8, depth - 1);
  };
  // Crystals grow inward from all four edges (wraps when tiled).
  for (let i = 0; i < 46; i++) {
    const edge = i % 4, t = Math.random() * size;
    const [px, py, base] = edge === 0 ? [t, 0, Math.PI / 2] : edge === 1 ? [t, size, -Math.PI / 2] : edge === 2 ? [0, t, 0] : [size, t, Math.PI];
    branch(px, py, base + (Math.random() - 0.5) * 1.1, 30 + Math.random() * 70, 2.2, 4);
  }
  for (let i = 0; i < 70; i++) branch(Math.random() * size, Math.random() * size, Math.random() * 6.28, 6 + Math.random() * 18, 1.1, 2);
  x.filter = "blur(1.2px)"; x.globalAlpha = 0.6; x.drawImage(c, 0, 0); x.filter = "none";
  const src = x.getImageData(0, 0, size, size).data;
  const h = (i, j) => src[(((j + size) % size) * size + ((i + size) % size)) * 4] / 255;
  // RGBA: rg = normal xy, b = height, a = roughness.
  const data = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const dx = (h(i + 1, j) - h(i - 1, j)) * 2.5, dy = (h(i, j + 1) - h(i, j - 1)) * 2.5;
    const k = (j * size + i) * 4, hv = h(i, j);
    data[k] = Math.max(0, Math.min(255, 128 + dx * 127));
    data[k + 1] = Math.max(0, Math.min(255, 128 + dy * 127));
    data[k + 2] = hv * 255;
    data[k + 3] = (0.5 + hv * 0.5) * 255;
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

// Final pass: frost refraction + blur + chromatic aberration at the glass edges, amber alert wave,
// vignette and film grain. Runs in linear HDR before the output (tone mapping) pass.
export const GlassFilmShader = {
  uniforms: {
    tDiffuse: { value: null }, tFrost: { value: null },
    uTime: { value: 0 }, uAspect: { value: 1 }, uRes: { value: new THREE.Vector2(1, 1) },
    uFrost: { value: 1 }, uGrain: { value: 0.0 }, uPulse: { value: -1 }, uPulseColor: { value: new THREE.Color(1.0, 0.68, 0.3) },
    uCondense: { value: 0 },
  },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse, tFrost; uniform float uTime, uAspect, uFrost, uGrain, uPulse, uCondense; uniform vec2 uRes; uniform vec3 uPulseColor;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 uv = vUv;
      vec2 c = uv - 0.5; c.x *= uAspect;
      vec2 e = min(uv, 1.0 - uv); e.x *= uAspect;
      float edge = min(e.x, e.y);
      float mask = 1.0 - smoothstep(0.0, 0.17, edge);
      vec4 fr = texture2D(tFrost, uv * vec2(uAspect, 1.0) * 1.35);
      float frost = clamp(mask * (fr.b * 1.4 + mask * 0.35) + uCondense * fr.b * 0.35, 0.0, 1.0) * uFrost;
      vec2 nrm = (fr.rg - 0.5) * 2.0;
      vec2 off = nrm * frost * 0.012;
      float ca = 0.0035 * mask;
      vec2 px = 1.0 / uRes;
      vec3 col = vec3(0.0);
      // Four-tap blur under the frost, with the channels split at the edge.
      for (int i = 0; i < 4; i++) {
        vec2 o = off + vec2(i == 0 ? 1.0 : i == 1 ? -1.0 : 0.0, i == 2 ? 1.0 : i == 3 ? -1.0 : 0.0) * px * 3.0 * frost;
        col.r += texture2D(tDiffuse, uv + o + c * ca).r;
        col.g += texture2D(tDiffuse, uv + o).g;
        col.b += texture2D(tDiffuse, uv + o - c * ca).b;
      }
      col *= 0.25;
      // Light scattering in the ice: faint, cold, brighter on the crystal ridges.
      col += vec3(0.62, 0.68, 0.74) * frost * (0.035 + fr.b * 0.05);
      if (uPulse >= 0.0) {
        float r = length(c);
        float w = r - uPulse * 1.1;
        col += uPulseColor * exp(-w * w * 260.0) * (1.0 - uPulse) * 0.5;
      }
      float vig = smoothstep(1.15, 0.25, length(c * vec2(0.9, 1.1)));
      col *= mix(0.55, 1.0, vig);
      col += (hash(uv * uRes + fract(uTime) * 91.7) - 0.5) * uGrain;
      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }`,
};

// ---------------- particle pool (sparks, trails, dust) ----------------
export function createParticles(capacity, pixelRatio) {
  const pos = new Float32Array(capacity * 3), col = new Float32Array(capacity * 3), size = new Float32Array(capacity);
  const life = new Float32Array(capacity), maxLife = new Float32Array(capacity), vel = new Float32Array(capacity * 3);
  const c0 = new Float32Array(capacity * 3), c1 = new Float32Array(capacity * 3), s0 = new Float32Array(capacity);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute("aColor", new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute("aSize", new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
  const m = new THREE.ShaderMaterial({
    uniforms: { uPixelRatio: { value: pixelRatio } },
    vertexShader: `attribute float aSize; attribute vec3 aColor; uniform float uPixelRatio; varying vec3 vColor;
      void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; gl_PointSize = aSize * uPixelRatio * 60.0 / max(1.0, -mv.z); vColor = aColor; }`,
    fragmentShader: `varying vec3 vColor; void main() { vec2 p = gl_PointCoord * 2.0 - 1.0; float a = exp(-dot(p, p) * 5.0); gl_FragColor = vec4(vColor * a, 1.0); }`,
    blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
  });
  const points = new THREE.Points(g, m);
  points.frustumCulled = false;
  let cursor = 0, alive = 0;
  return {
    points,
    get alive() { return alive; },
    emit(p, v, from, to, sz, lifeS) {
      const i = cursor; cursor = (cursor + 1) % capacity;
      pos.set([p.x, p.y, p.z], i * 3); vel.set([v.x, v.y, v.z], i * 3);
      c0.set([from.r, from.g, from.b], i * 3); c1.set([to.r, to.g, to.b], i * 3);
      s0[i] = sz; life[i] = lifeS; maxLife[i] = lifeS;
    },
    update(dt) {
      alive = 0;
      for (let i = 0; i < capacity; i++) {
        if (life[i] <= 0) { if (size[i] !== 0) size[i] = 0; continue; }
        alive++;
        life[i] -= dt;
        const k = Math.max(0, life[i] / maxLife[i]);
        pos[i * 3] += vel[i * 3] * dt; pos[i * 3 + 1] += vel[i * 3 + 1] * dt; pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
        vel[i * 3] *= 0.985; vel[i * 3 + 1] *= 0.985; vel[i * 3 + 2] *= 0.985;
        const f = k * k;
        col[i * 3] = (c1[i * 3] + (c0[i * 3] - c1[i * 3]) * k) * f;
        col[i * 3 + 1] = (c1[i * 3 + 1] + (c0[i * 3 + 1] - c1[i * 3 + 1]) * k) * f;
        col[i * 3 + 2] = (c1[i * 3 + 2] + (c0[i * 3 + 2] - c1[i * 3 + 2]) * k) * f;
        size[i] = s0[i] * (0.4 + 0.6 * k);
      }
      g.attributes.position.needsUpdate = g.attributes.aColor.needsUpdate = g.attributes.aSize.needsUpdate = true;
    },
  };
}

// ---------------- UFO ----------------
export function createUfoFactory(envMap, tier) {
  const profile = [[0, -0.16], [0.42, -0.13], [0.86, -0.03], [1.0, 0.0], [0.86, 0.05], [0.5, 0.12], [0.3, 0.16], [0, 0.17]].map(([x, y]) => new THREE.Vector2(x, y));
  const hullGeo = new THREE.LatheGeometry(profile, 48);
  const hullMat = new THREE.MeshPhysicalMaterial({
    color: 0x8b9096, metalness: 1, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.12,
    anisotropy: 0.7, anisotropyRotation: Math.PI / 2, envMap, envMapIntensity: 1.6,
  });
  const domeGeo = new THREE.SphereGeometry(0.34, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2);
  const domeMat = tier.transmission
    ? new THREE.MeshPhysicalMaterial({ color: 0xc9d6e0, metalness: 0, roughness: 0.15, transmission: 0.9, thickness: 0.2, envMap, envMapIntensity: 1.2, transparent: true })
    : new THREE.MeshPhysicalMaterial({ color: 0x9fb0bd, metalness: 0.2, roughness: 0.15, envMap, envMapIntensity: 1.4, transparent: true, opacity: 0.55 });
  const lightGeo = new THREE.SphereGeometry(0.035, 8, 6);
  const beamMat = () => new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uTime: { value: 0 }, uOpacity: { value: 0 } },
    vertexShader: `varying vec2 vUv; varying vec3 vP; void main() { vUv = uv; vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `${noiseGLSL}
      uniform float uTime, uOpacity; varying vec2 vUv; varying vec3 vP;
      void main() {
        float along = vUv.y;               // 1 at the saucer, 0 at the star
        float edge = sin(vUv.x * 3.14159 * 2.0) * 0.5 + 0.5;
        float n = fbm3(vec3(vP.x * 3.0, vP.y * 2.0 - uTime * 0.8, vP.z * 3.0));
        float a = pow(along, 1.4) * (0.45 + 0.55 * n) * (0.6 + 0.4 * edge) * uOpacity;
        gl_FragColor = vec4(vec3(0.75, 0.86, 1.0) * a * 1.6, 1.0);
      }`,
  });
  return function makeUfo() {
    const g = new THREE.Group();
    const hull = new THREE.Mesh(hullGeo, hullMat);
    const dome = new THREE.Mesh(domeGeo, domeMat); dome.position.y = 0.12;
    g.add(hull, dome);
    const lights = [];
    for (let i = 0; i < 10; i++) {
      const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.7, 1.9), toneMapped: true });
      const l = new THREE.Mesh(lightGeo, m);
      const a = (i / 10) * Math.PI * 2;
      l.position.set(Math.cos(a) * 0.93, -0.01, Math.sin(a) * 0.93);
      g.add(l); lights.push(l);
    }
    const bm = beamMat();
    const beam = new THREE.Mesh(new THREE.ConeGeometry(0.75, 1, 28, 1, true), bm);
    beam.geometry.translate(0, -0.5, 0); // apex at the saucer, base 1 unit below; scale.y sets the length
    beam.position.y = -0.1;
    g.add(beam);
    g.scale.setScalar(0.7);
    g.userData = { lights, beam, beamMat: bm };
    return g;
  };
}

export function easeInOut(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
export function easeOut(t) { return 1 - Math.pow(1 - t, 3); }

// ---------------- near dust: small debris drifting past the camera ----------------
// Points live in a box that wraps around the camera, so moving the camera makes them stream past
// faster than the stars (the nearest parallax layer). Near ones are larger and fainter (out of focus).
export function createDust(tier, pixelRatio, reduced) {
  const n = tier.name === "high" ? 1400 : tier.name === "medium" ? 600 : 300;
  const box = new THREE.Vector3(60, 44, 60);
  const base = new Float32Array(n * 3), pos = new Float32Array(n * 3), size = new Float32Array(n), vel = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    base.set([(Math.random() - 0.5) * box.x, (Math.random() - 0.5) * box.y, (Math.random() - 0.5) * box.z], i * 3);
    vel.set([(Math.random() - 0.5) * 0.25, (Math.random() - 0.5) * 0.12, (Math.random() - 0.5) * 0.25], i * 3);
    size[i] = 0.5 + Math.pow(Math.random(), 3) * 2.5;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
  const m = new THREE.ShaderMaterial({
    uniforms: { uPixelRatio: { value: pixelRatio } },
    vertexShader: `attribute float aSize; uniform float uPixelRatio; varying float vA; varying float vBlur;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float d = max(0.5, -mv.z);
        vBlur = clamp(1.0 - d / 10.0, 0.0, 1.0);          // close = out of focus
        gl_PointSize = clamp(aSize * uPixelRatio * (2.0 + 26.0 * vBlur * vBlur) * 4.0 / d, 1.0, 40.0);
        vA = clamp(1.0 - d / 32.0, 0.0, 1.0) * (0.55 - 0.4 * vBlur) * step(0.4, -mv.z);
      }`,
    fragmentShader: `varying float vA; varying float vBlur;
      void main() { vec2 p = gl_PointCoord * 2.0 - 1.0; float r = length(p);
        float a = mix(exp(-r * r * 6.0), smoothstep(1.0, 0.7, r) * 0.5, vBlur);
        gl_FragColor = vec4(vec3(0.62) * a * vA, 1.0); }`,
    blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
  });
  const points = new THREE.Points(g, m);
  points.frustumCulled = false;
  let t = 0;
  return {
    points,
    update(dt, cam) {
      if (!reduced) t += dt;
      for (let i = 0; i < n; i++) {
        for (let a = 0; a < 3; a++) {
          const L = a === 0 ? box.x : a === 1 ? box.y : box.z;
          const c = a === 0 ? cam.x : a === 1 ? cam.y : cam.z;
          let v = base[i * 3 + a] + vel[i * 3 + a] * t - c;
          v = ((v % L) + L * 1.5) % L - L / 2; // wrap into the box around the camera
          pos[i * 3 + a] = v + c;
        }
      }
      g.attributes.position.needsUpdate = true;
    },
  };
}

// ---------------- rocks and objects at mid and near depths ----------------
// Instanced low-poly rocks (noise-displaced, flat-shaded, matte) in a few sparse fields, plus a
// derelict satellite, a small station, a cargo pod and some distant moons. Kept to the edges.
export function createDebris(tier, reduced) {
  const group = new THREE.Group();
  const total = tier.mobile ? 5 : 10;
  const mat = new THREE.MeshStandardMaterial({ color: 0x7a7166, roughness: 1, metalness: 0, flatShading: false });
  // Occasional single rocks, spread out at mid and near depths along the edges; never clustered.
  const spots = [[-34, 18, -30], [36, -20, -36], [-48, -26, -70], [52, 24, -80], [22, 30, -20], [-26, -30, -16], [64, -6, -110], [-70, 8, -120], [12, -34, -60], [-14, 34, -90]];
  const geo = (() => {
    const g = new THREE.IcosahedronGeometry(1, 3);
    const p = g.attributes.position, v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      const k = 1 + 0.12 * Math.sin(v.x * 2.1 + 1.3) * Math.cos(v.y * 1.7 + 0.4) + 0.05 * Math.sin(v.z * 4.3);
      v.multiplyScalar(k); v.y *= 0.78; v.x *= 1.12;
      p.setXYZ(i, v.x, v.y, v.z);
    }
    g.computeVertexNormals();
    return g;
  })();
  const rocks = spots.slice(0, total).map(([x, y, z]) => ({
    pos: new THREE.Vector3(x, y, z), drift: new THREE.Vector3((Math.random() - 0.5) * 0.08, (Math.random() - 0.5) * 0.05, 0),
    scale: 0.5 + Math.random() * 0.9, rot: new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6),
    spin: new THREE.Vector3((Math.random() - 0.5) * 0.12, (Math.random() - 0.5) * 0.12, (Math.random() - 0.5) * 0.12),
  }));
  const rockMesh = new THREE.InstancedMesh(geo, mat, rocks.length);
  rockMesh.frustumCulled = false;
  group.add(rockMesh);
  const dummy = new THREE.Object3D();
  function write() {
    rocks.forEach((r, i) => { dummy.position.copy(r.pos); dummy.rotation.copy(r.rot); dummy.scale.setScalar(r.scale); dummy.updateMatrix(); rockMesh.setMatrixAt(i, dummy.matrix); });
    rockMesh.instanceMatrix.needsUpdate = true;
  }
  write();

  // A few objects, low-poly and matte.
  const metal = new THREE.MeshStandardMaterial({ color: 0x8a8d90, roughness: 0.9, metalness: 0 });
  const panelM = new THREE.MeshStandardMaterial({ color: 0x1d2a38, roughness: 0.85, metalness: 0 });
  const sat = new THREE.Group();
  sat.add(new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.9), metal));
  for (const s of [-1, 1]) { const pnl = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.04, 0.7), panelM); pnl.position.x = s * 1.15; sat.add(pnl); }
  const dish = new THREE.Mesh(new THREE.ConeGeometry(0.35, 0.2, 10, 1, true), metal); dish.position.z = 0.55; dish.rotation.x = Math.PI / 2; sat.add(dish);
  sat.position.set(-38, 22, -46); sat.rotation.set(0.4, 0.8, 0.2);
  const station = new THREE.Group();
  station.add(new THREE.Mesh(new THREE.TorusGeometry(1.6, 0.18, 6, 24), metal));
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 1.6, 8), metal); hub.rotation.x = Math.PI / 2; station.add(hub);
  for (let i = 0; i < 4; i++) { const sp = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.6, 0.08), metal); sp.rotation.z = i * Math.PI / 4; station.add(sp); }
  station.position.set(48, 26, -110); station.rotation.set(1.1, 0.3, 0);
  const pod = new THREE.Mesh(new THREE.CapsuleGeometry(0.35, 0.9, 4, 8), metal);
  pod.position.set(26, -19, -24); pod.rotation.set(0.5, 0.2, 1.1);
  const moons = [[-90, -30, -170, 3], [110, 40, -220, 4.5]].map(([x, y, z, r]) => { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 12), new THREE.MeshStandardMaterial({ color: 0x77706a, roughness: 1, metalness: 0 })); m.position.set(x, y, z); return m; });
  group.add(sat, station, pod, ...moons);

  return {
    group,
    update(dt) {
      if (reduced) return;
      for (const r of rocks) { r.rot.x += r.spin.x * dt; r.rot.y += r.spin.y * dt; r.rot.z += r.spin.z * dt; r.pos.addScaledVector(r.drift, dt); }
      write();
      sat.rotation.y += dt * 0.05; station.rotation.z += dt * 0.04; pod.rotation.x += dt * 0.08;
      pod.position.x -= dt * 0.15;
    },
  };
}
