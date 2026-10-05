// Task vessels: each open issue is a small ship (three hull variants from the Kenney Space Kit, CC0, picked by a
// stable hash of the issue id) with a reactor core: the pre-rendered plasma loop (assets/fx/plasma) inside a
// glass housing (fresnel rim, a sky reflection and the sun's specular glint), tinted by status, and a soft
// corona built exactly like the v1 portfolio's sun (same gradient stops and additive sprite, scaled down).
// Hulls are merged to one draw each and share one material; the plasma atlas is shared by every core.
import * as THREE from "three";

const VARIANTS = ["vessel-a", "vessel-b", "vessel-c"];
export const STATUS_TINT = {
  in_progress: [0.72, 0.84, 1.0, 1.0],   // working: cool blue-white
  question: [1.0, 0.74, 0.42, 1.05],     // needs you: amber
  blocked: [0.85, 0.2, 0.13, 0.8],       // deep red
  done: [0.55, 0.95, 0.66, 1.0],         // soft green
  in_review: [0.86, 0.88, 0.92, 0.8],    // soft white
  todo: [0.5, 0.53, 0.58, 0.45],         // paused / not started: dim
};
const PLASMA = { cols: 8, rows: 4, frames: 32, fps: 12 };

export function createFleet({ world, envMap, small, reduced, low = false, layer = 4 }) {
  const gltf = import("three/addons/loaders/GLTFLoader.js").then((m) => new m.GLTFLoader());
  const merged = import("three/addons/utils/BufferGeometryUtils.js");
  const hullMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.3, roughness: 0.62, envMap, envMapIntensity: 0.1 });
  const COLORS = { metal: 0x3b4047, metalDark: 0x24282c, dark: 0x0e0f11, metalRed: 0x2e343b }; // dark gunmetal, carbon
  const hulls = VARIANTS.map((v) => Promise.all([gltf, merged]).then(([l, U]) => l.loadAsync(`assets/fx/ships/${v}.glb`).then((g) => {
    const parts = [];
    g.scene.updateMatrixWorld(true);
    g.scene.traverse((o) => {
      if (!o.isMesh) return;
      const mats = [].concat(o.material);
      const geo = o.geometry.clone().applyMatrix4(o.matrixWorld).toNonIndexed();
      const n = geo.attributes.position.count, col = new Float32Array(n * 3);
      const groups = geo.groups.length ? geo.groups : [{ start: 0, count: n, materialIndex: 0 }];
      for (const gr of groups) { const c = new THREE.Color(COLORS[mats[gr.materialIndex ?? 0]?.name] ?? COLORS.metal); for (let i = gr.start; i < gr.start + gr.count; i++) col.set([c.r, c.g, c.b], i * 3); }
      geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
      for (const k of Object.keys(geo.attributes)) if (!["position", "normal", "color"].includes(k)) geo.deleteAttribute(k);
      geo.clearGroups(); parts.push(geo);
    });
    const geo = U.mergeGeometries(parts);
    geo.computeBoundingBox();
    const b = geo.boundingBox, size = b.getSize(new THREE.Vector3()), c = b.getCenter(new THREE.Vector3());
    geo.translate(-c.x, -c.y, -c.z); geo.scale(1 / Math.max(size.x, size.z), 1 / Math.max(size.x, size.z), 1 / Math.max(size.x, size.z));
    geo.rotateY(Math.PI); // the kit's noses point -Z; ours fly +Z
    geo.computeBoundingBox();
    return geo;
  })).catch(() => null));

  // the shared plasma atlas and the v1 corona texture
  const plasma = new THREE.TextureLoader().load(`assets/fx/plasma${small ? "-sm" : ""}.jpg`); plasma.colorSpace = THREE.SRGBColorSpace;
  const corona = (() => { // v1's sun corona: the same stops, a tight halo rather than a cloud
    const c = document.createElement("canvas"); c.width = c.height = 128; const x = c.getContext("2d");
    const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, "rgba(255,240,220,1)"); g.addColorStop(0.28, "rgba(255,230,200,0.35)"); g.addColorStop(0.36, "rgba(255,215,170,0.05)"); g.addColorStop(0.6, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,0)");
    x.fillStyle = g; x.fillRect(0, 0, 128, 128); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const coreGeo = new THREE.SphereGeometry(1, 20, 14);
  const coreMat = (tint) => new THREE.ShaderMaterial({
    uniforms: { map: { value: plasma }, uTint: { value: tint }, uGain: { value: 1 }, uFrame: { value: 0 }, uSun: { value: new THREE.Vector3(1, 0.3, 0.1) } },
    vertexShader: `varying vec3 vN; varying vec3 vV; varying vec3 vW; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); vW = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform sampler2D map; uniform vec3 uTint, uSun; uniform float uGain, uFrame; varying vec3 vN; varying vec3 vV; varying vec3 vW;
      vec3 cell(float f, vec2 uv){ float r = floor(f / ${PLASMA.cols}.0), c = f - r * ${PLASMA.cols}.0; return texture2D(map, (vec2(c, ${PLASMA.rows - 1}.0 - r) + uv) / vec2(${PLASMA.cols}.0, ${PLASMA.rows}.0)).rgb; }
      void main(){
        float mu = max(dot(vN, vV), 0.0);
        // the plasma seen through the glass: sampled by view-space normal, shifted a little by the glass (refraction)
        vec2 uv = clamp(vN.xy * 0.42 * (0.85 + 0.15 * mu) + 0.5, 0.02, 0.98);
        float f0 = floor(uFrame); vec3 p = mix(cell(f0, uv), cell(mod(f0 + 1.0, ${PLASMA.frames}.0), uv), uFrame - f0);
        float limb = 0.55 + 0.45 * pow(mu, 0.5);                                // v1 sun: limb darkening
        vec3 col = p * uTint * limb * 2.2 * uGain;                                // HDR core: only it reaches bloom
        float fres = pow(1.0 - mu, 4.0);                                           // glass housing
        col += vec3(0.55, 0.62, 0.72) * fres * 0.35;                               // sky reflection on the rim
        vec3 H = normalize(normalize(uSun) + normalize(vV)); col += vec3(1.0, 0.97, 0.92) * pow(max(dot(normalize(vW), normalize(uSun)), 0.0), 60.0) * 0.6;
        col *= 1.0 - smoothstep(0.9, 1.0, 1.0 - mu) * 0.6;                         // thin dark edge for definition
        gl_FragColor = vec4(col, 1.0);
      }`,
  });

  const ships = new Map();
  let t = 0;
  function add(id, hash) {
    const g = new THREE.Group();
    const tint = new THREE.Color(0.6, 0.6, 0.6), goal = new THREE.Color(0.6, 0.6, 0.6);
    const core = new THREE.Mesh(coreGeo, coreMat(tint)); core.layers.enable(layer);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: corona, color: tint.clone(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.28, toneMapped: true }));
    g.add(core, halo);
    const s = { g, core, halo, tint, goal, gain: 1, gainGoal: 1, bloom: 0, phase: hash * PLASMA.frames, rate: 0.85 + hash * 0.3, hull: null, size: 0.4, q: new THREE.Quaternion(), prev: null, ready: false, age: 0 };
    hulls[Math.floor(hash * 3) % 3].then((geo) => {
      if (!geo) return;
      const m = new THREE.Mesh(geo, hullMat); m.layers.enable(layer); g.add(m); s.hull = m;
      // the reactor sits in a dome on the dorsal spine, a little aft of centre
      s.ready = true; place(s);
    });
    world.add(g); ships.set(id, s);
    return s;
  }
  function place(s) {
    const L = s.size;
    if (s.hull) s.hull.scale.setScalar(L);
    s.core.scale.setScalar(L * 0.17);
    s.core.position.set(0, 0, -0.06 * L); // the reactor sits in a glass housing through the hull: visible from above and below
    s.halo.position.copy(s.core.position);
    s.halo.scale.setScalar(L * 0.17 * 3.2 * 2.2); // v1: corona = sun radius × 3.2 (× 2 for the sprite's diameter)
  }
  // set(id, { pos, size, status, hot (hover/selection), sun }) each frame
  function set(id, o, dt) {
    const s = ships.get(id); if (!s) return;
    if (s.size !== o.size) { s.size = o.size; place(s); }
    const st = STATUS_TINT[o.status] ?? STATUS_TINT.todo;
    s.goal.setRGB(st[0], st[1], st[2]); s.gainGoal = st[3] * (o.hot ? 1.25 : 1);
    s.tint.lerp(s.goal, 1 - Math.exp(-dt * 3));                 // ~1 s crossfade, never a snap
    s.gain += (s.gainGoal - s.gain) * (1 - Math.exp(-dt * 3));
    s.bloom *= Math.exp(-dt * 1.4);                              // completion: a gentle bloom from the core, settling
    t += 0;
    const rate = reduced || low ? 0 : s.rate * (o.hot ? 1.25 : 1); // low tier and reduced motion: a still frame of the plasma
    s.phase = (s.phase + dt * PLASMA.fps * rate) % PLASMA.frames;
    const u = s.core.material.uniforms; u.uFrame.value = s.phase; u.uGain.value = s.gain * (1 + s.bloom * 1.5); u.uSun.value.copy(o.sun);
    s.halo.material.color.copy(s.tint); s.halo.material.opacity = 0.28 * s.gain * (1 + s.bloom * 2);
    // From afar the vessel is a few pixels: the corona keeps a minimum on-screen size so status reads at a glance.
    if (o.camPos && o.pxWorld) {
      const d = o.camPos.distanceTo(o.pos), base = s.size * 0.17 * 3.2 * 2.2, min = d * o.pxWorld * 11;
      s.halo.scale.setScalar(Math.max(base, min));
      s.halo.material.opacity *= base >= min ? 1 : 0.8 + 0.6 * Math.min(1, (min - base) / min);
    }
    // motion: face the direction of travel along the orbit, banked gently toward its centre; eased rotation
    if (s.prev && dt > 0) {
      const v = o.pos.clone().sub(s.prev);
      if (v.lengthSq() > 1e-10) {
        const up = o.normal ?? new THREE.Vector3(0, 1, 0);
        const m = new THREE.Matrix4().lookAt(v.normalize(), new THREE.Vector3(), up);
        const q = new THREE.Quaternion().setFromRotationMatrix(m).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -0.14));
        s.q.slerp(q, 1 - Math.exp(-dt * 4));
      }
    }
    s.prev = (s.prev ?? new THREE.Vector3()).copy(o.pos);
    s.g.position.copy(o.pos); s.g.quaternion.copy(s.q);
    s.g.visible = !o.hidden;
  }
  function complete(id) { const s = ships.get(id); if (s) { s.bloom = 1; s.goal.setRGB(...STATUS_TINT.done.slice(0, 3)); } }
  function remove(id) { const s = ships.get(id); if (!s) return; world.remove(s.g); s.core.material.dispose(); s.halo.material.dispose(); ships.delete(id); }
  return { add, set, remove, complete, has: (id) => ships.has(id), get: (id) => ships.get(id) };
}
