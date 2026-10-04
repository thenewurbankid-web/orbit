// Planet events: small, crisp effects tied to real changes. Each builder returns
// {obj, update(k, dt, t) → keep?, end()} for transient effects (k runs 0→1 over dur),
// or {obj, update(dt, t), stop(): Promise} for persistent ones (they last while the condition holds).
import * as THREE from "three";

const AMBER = new THREE.Color(1.0, 0.62, 0.22);
const TEAL = new THREE.Color(0.45, 0.95, 0.8);
const WHITE = new THREE.Color(1, 1, 1);

// A point on a sphere's surface facing a direction (world space).
export function surfacePoint(center, radius, dir, lift = 0) {
  return center.clone().addScaledVector(dir.clone().normalize(), radius + lift);
}
function orientOutward(mesh, center, at) { mesh.position.copy(at); mesh.lookAt(at.clone().add(at.clone().sub(center))); }
const add = (m) => { m.material.blending = THREE.AdditiveBlending; m.material.transparent = true; m.material.depthWrite = false; return m; };

// ---------- persistent ----------
export function storm(center, radius, dir, reduced, rfx = null) {
  const bolt = rfx?.texture?.("lightning") ?? null;
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uTime: { value: 0 }, uFade: { value: 0 }, uFlash: { value: 0 }, uBolt: { value: bolt }, uHas: { value: bolt ? 1 : 0 }, uStrike: { value: new THREE.Vector4(0, 0, 0, 0.6) } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: `uniform float uTime, uFade, uFlash, uHas; uniform sampler2D uBolt; uniform vec4 uStrike; varying vec2 vUv;
      void main(){ vec2 p = vUv*2.-1.; float r = length(p); if (r > 1.0) discard;
        float a = atan(p.y, p.x) + r*6.0 - uTime*0.8;
        float arms = 0.5 + 0.5*sin(a*3.0);
        float dark = smoothstep(1.0, 0.15, r) * (0.55 + 0.45*arms);
        vec3 col = vec3(0.02, 0.02, 0.03);
        vec3 lit = vec3(0.0);
        if (uHas > 0.5) {
          // A real branched bolt (NOAA photo) at the strike point: it shows only through gaps in the cloud,
          // while the flash lights the cloud from within, brightest where the cloud is thickest near the strike.
          vec2 q = p - uStrike.xy; float c = cos(uStrike.z), s = sin(uStrike.z);
          vec2 bu = vec2(c*q.x - s*q.y, s*q.x + c*q.y) / uStrike.w * vec2(0.5, 0.45) + 0.5;
          float b = (bu.x > 0.0 && bu.x < 1.0 && bu.y > 0.0 && bu.y < 1.0) ? texture2D(uBolt, bu).r : 0.0;
          float glow = exp(-dot(q, q) * 7.0);
          float through = 0.2 + 0.8 * (1.0 - smoothstep(0.45, 0.9, dark));     // mostly hidden by cloud, clearest in the gaps
          lit = vec3(0.82, 0.86, 1.0) * uFlash * (b * b * through * 2.2 + glow * (0.15 + 0.85 * dark) * 0.6);
        } else {
          float bolt = uFlash * smoothstep(0.06, 0.0, abs(p.x*0.6 + sin(p.y*9.0 + uTime*30.0)*0.08)) * step(r, 0.7);
          lit = vec3(0.85, 0.9, 1.0) * bolt * 1.4;
        }
        float l = max(lit.r, max(lit.g, lit.b));
        gl_FragColor = vec4(col + lit, clamp(dark*0.85 + l, 0.0, 1.0) * uFade); }`,
  });
  if (!bolt && rfx?.loads?.lightning) rfx.loads.lightning.then((t) => { if (t) { mat.uniforms.uBolt.value = t; mat.uniforms.uHas.value = 1; } });
  const size = radius * 0.55;
  const m = new THREE.Mesh(new THREE.CircleGeometry(size, 48), mat);
  orientOutward(m, center, surfacePoint(center, radius, dir, 0.02));
  // Real strikes: a stroke and one to three return strokes over ~0.3 s (the flicker of real lightning),
  // then quiet for a few seconds.
  let stopping = null, flashT = 1 + Math.random() * 2, pulses = [], st = 0;
  function strike() {
    const u = mat.uniforms.uStrike.value, ang = Math.random() * Math.PI * 2, rr = 0.15 + Math.random() * 0.4;
    u.set(Math.cos(ang) * rr, Math.sin(ang) * rr, (Math.random() - 0.5) * 1.2, 0.45 + Math.random() * 0.25);
    st = 0; pulses = [[0, 1]];
    let t0 = 0; for (let i = 0, n = 1 + Math.floor(Math.random() * 3); i < n; i++) { t0 += 0.05 + Math.random() * 0.08; pulses.push([t0, 0.45 + Math.random() * 0.45]); }
  }
  return {
    obj: m, label: true, strike,
    update(dt, t) {
      mat.uniforms.uTime.value = reduced ? 0 : t;
      const goal = stopping ? 0 : 1;
      mat.uniforms.uFade.value += (goal - mat.uniforms.uFade.value) * Math.min(1, dt * (stopping ? 2.5 : 1.2));
      if (!reduced) {
        flashT -= dt; if (flashT <= 0) { flashT = 2 + Math.random() * 4.5; strike(); }
        st += dt; let f = 0;
        for (const [p0, a] of pulses) { const x = st - p0; if (x >= 0) f = Math.max(f, a * Math.exp(-x / 0.045) * Math.min(1, x / 0.008 + 0.2)); }
        mat.uniforms.uFlash.value = f;
      }
      if (stopping && mat.uniforms.uFade.value < 0.02) { stopping(); return false; }
      return true;
    },
    stop() { return new Promise((r) => { stopping = r; }); },
    anchor: () => m.position,
  };
}

export function attack(center, radius, getTarget, reduced, rfx = null) {
  const g = new THREE.Group();
  const craftGeo = new THREE.ConeGeometry(0.09, 0.32, 5); craftGeo.rotateX(Math.PI / 2);
  const craft = [0, 1, 2].map((k) => {
    const c = new THREE.Mesh(craftGeo, new THREE.MeshStandardMaterial({ color: 0x1a1a1a, metalness: 0.6, roughness: 0.4, emissive: AMBER, emissiveIntensity: 0.35 }));
    c.userData.phase = (k / 3) * Math.PI * 2; g.add(c);
    // Real craft (New Horizons render, amber-graded) over the drawn cone once the image is in.
    if (rfx) { const w = new THREE.Group(); c.add(w); rfx.dress(w, "hostile", { size: 0.55, dim: 0.7, warm: 0.5, hide: [c] }); }
    return c;
  });
  const tracerMat = new THREE.LineBasicMaterial({ color: AMBER.clone().multiplyScalar(2.2), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  const tracer = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), tracerMat);
  g.add(tracer);
  let fire = 1, shot = null, retreat = null, rt = 0;
  const R = radius + 2.2;
  return {
    obj: g, label: true,
    update(dt, t) {
      const target = getTarget();
      craft.forEach((c, k) => {
        const a = c.userData.phase + (reduced ? 0 : t * 0.5);
        const p = new THREE.Vector3(Math.cos(a) * R, Math.sin(a * 2) * 0.6 + 0.8, Math.sin(a) * R).add(center);
        if (retreat) p.add(p.clone().sub(center).normalize().multiplyScalar(rt * rt * 30));
        c.lookAt(p.clone().add(new THREE.Vector3(-Math.sin(a), 0, Math.cos(a))));
        c.position.copy(p);
      });
      if (retreat) { rt += dt; craft.forEach((c) => (c.material.emissiveIntensity = 0.35 + Math.max(0, 1 - rt * 3) * 3)); if (rt > 1.2) { retreat(); return false; } return true; }
      if (!reduced) {
        fire -= dt;
        if (fire <= 0 && target) {
          fire = 1.4 + Math.random() * 1.6;
          const from = craft[Math.floor(Math.random() * 3)].position.clone();
          if (rfx?.bolt(from, target.clone(), { color: new THREE.Color(1.0, 0.55, 0.2), width: 0.04, dur: 0.55 })) shot = null;
          else shot = { from, to: target.clone(), k: 0 };
        }
        if (shot) {
          shot.k += dt / 0.35;
          const a = shot.from.clone().lerp(shot.to, Math.min(1, shot.k)), b = shot.from.clone().lerp(shot.to, Math.max(0, shot.k - 0.25));
          const pos = tracer.geometry.attributes.position; pos.setXYZ(0, a.x, a.y, a.z); pos.setXYZ(1, b.x, b.y, b.z); pos.needsUpdate = true;
          tracerMat.opacity = shot.k < 1.2 ? 0.9 : 0;
          if (shot.k > 1.3) shot = null;
        }
      }
      return true;
    },
    stop() { return new Promise((r) => { retreat = r; rt = 0; tracerMat.opacity = 0; if (reduced) r(); }); },
    anchor: () => craft[0].position,
  };
}

export function ice(moonMesh, reduced) {
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uCover: { value: reduced ? 0.6 : 0 } },
    vertexShader: `varying vec3 vP; varying vec3 vN; varying vec3 vV; void main(){ vP = position; vN = normalize(normalMatrix*normal); vec4 mv = modelViewMatrix*vec4(position,1.); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `uniform float uCover; varying vec3 vP; varying vec3 vN; varying vec3 vV;
      float h(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,45.164)))*43758.5453); }
      void main(){ float n = h(floor(vP*9.0)) * 0.5 + h(floor(vP*23.0)) * 0.5;
        float cover = step(1.0 - uCover, (vP.y*0.5 + 0.5) * 0.6 + n * 0.4);
        float rim = pow(1.0 - max(0.0, dot(vN, vV)), 2.0);
        gl_FragColor = vec4(vec3(0.75, 0.86, 0.95) * (0.35 + rim*0.4), cover * 0.55); }`,
  });
  const m = new THREE.Mesh(new THREE.SphereGeometry(1.03, 32, 16), mat);
  moonMesh.add(m);
  let stopping = null;
  return {
    obj: null, label: true,
    update(dt) {
      if (stopping) { mat.uniforms.uCover.value -= dt * 0.8; if (mat.uniforms.uCover.value <= 0) { moonMesh.remove(m); stopping(); return false; } }
      else if (mat.uniforms.uCover.value < 0.6) mat.uniforms.uCover.value += dt * 0.05;
      return true;
    },
    stop() { return new Promise((r) => { stopping = r; }); },
    anchor: () => moonMesh.getWorldPosition(new THREE.Vector3()),
  };
}

// ---------- transient (k: 0 → 1) ----------
export function aurora(center, radius, rfx = null, sun = null) {
  if (rfx?.ready("aurora")) return auroraCurtain(center, radius, rfx.texture("aurora"), sun);
  const g = new THREE.Group();
  const rings = [0, 1, 2].map((k) => {
    const m = add(new THREE.Mesh(new THREE.TorusGeometry(radius * (0.42 + k * 0.1), 0.02, 6, 96), new THREE.MeshBasicMaterial({ color: TEAL.clone().lerp(WHITE, k * 0.2).multiplyScalar(1.6) })));
    m.rotation.x = Math.PI / 2; m.position.set(0, radius * (0.93 - k * 0.04), 0); g.add(m); return m;
  });
  g.position.copy(center);
  return { obj: g, dur: 3.2, update(k, dt, t) { rings.forEach((r, i) => { r.material.opacity = Math.sin(Math.PI * k) * (0.9 - i * 0.2) * (0.75 + 0.25 * Math.sin(t * 6 + i)); r.scale.setScalar(1 + k * 0.08); }); } };
}

// Aurora from a real photo (ISS-46, aurora over Canada): the curtain strip (green base, red tops) wrapped on a
// thin vertical band around the planet's polar oval, rising from the surface. It is brightest edge-on at the
// limb (the longest path through the glow), faint where it lies over the dayside, and drifts and folds slowly.
function auroraCurtain(center, radius, map, sun) {
  if (map.wrapS !== THREE.RepeatWrapping) { map.wrapS = THREE.RepeatWrapping; map.needsUpdate = true; } // the strip wraps around the oval
  const N = 128, tilt = 0.18, colat = 0.55, h = 0.3; // oval ~31° from a slightly tilted pole; curtain 30 % of R tall
  // Two ovals (north bright, south fainter), each a ring of quads from the surface up.
  const V = (N + 1) * 2 * 2;
  const pos = new Float32Array(V * 3), nrm = new Float32Array(V * 3), uv = new Float32Array(V * 2), gain = new Float32Array(V), idx = [];
  const axisQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(tilt, 0, tilt * 0.6));
  const d = new THREE.Vector3();
  [1, -1].forEach((hemi, hk) => {
    const base = hk * (N + 1) * 2, uOff = hk * 0.37;
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      d.set(Math.sin(colat) * Math.cos(a), hemi * Math.cos(colat), Math.sin(colat) * Math.sin(a)).applyQuaternion(axisQ);
      for (let j = 0; j < 2; j++) {
        const r = radius * (1.005 + j * h), o = base + i * 2 + j;
        pos.set([d.x * r, d.y * r, d.z * r], o * 3); nrm.set([d.x, d.y, d.z], o * 3); uv.set([(i / N) * 2 + uOff, j], o * 2); gain[o] = hemi > 0 ? 1 : 0.55;
      }
      if (i < N) { const o = base + i * 2; idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2); }
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3)); geo.setAttribute("normal", new THREE.BufferAttribute(nrm, 3)); geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2)); geo.setAttribute("aG", new THREE.BufferAttribute(gain, 1)); geo.setIndex(idx);
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
    uniforms: { map: { value: map }, uOpacity: { value: 0 }, uTime: { value: 0 }, uSun: { value: (sun ?? new THREE.Vector3(1, 0, 0)).clone().normalize() } },
    vertexShader: `attribute float aG; varying vec2 vUv; varying vec3 vN; varying vec3 vV; varying float vDay; varying float vG;
      uniform vec3 uSun;
      void main() { vUv = uv; vG = aG; vec4 w = modelMatrix * vec4(position, 1.0); vec3 n = normalize(mat3(modelMatrix) * normal);
        vN = n; vV = normalize(cameraPosition - w.xyz); vDay = dot(n, uSun);
        gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `uniform sampler2D map; uniform float uOpacity, uTime; varying vec2 vUv; varying vec3 vN; varying vec3 vV; varying float vDay; varying float vG;
      void main() {
        // Slow drift along the oval and gentle folding of the curtain (the rays sway, they do not spin).
        float u = vUv.x + uTime * 0.006 + 0.012 * sin(vUv.x * 19.0 + uTime * 0.35) + 0.006 * sin(vUv.x * 53.0 - uTime * 0.6);
        vec3 c = texture2D(map, vec2(u, vUv.y)).rgb;
        float edge = 1.0 - abs(dot(vN, vV));                    // the curtain seen edge-on at the limb glows most
        float limb = 0.35 + 0.65 * pow(edge, 1.5);
        float night = 0.25 + 0.75 * smoothstep(0.3, -0.25, vDay); // washed out over the sunlit side
        gl_FragColor = vec4(c * limb * night * vG * uOpacity, 1.0);
      }`,
  });
  const m = new THREE.Mesh(geo, mat); m.frustumCulled = false; m.renderOrder = 3;
  m.position.copy(center);
  // Fades in over ~1 s, holds, and fades out slowly; a slow breathing of brightness while it lasts.
  return { obj: m, dur: 6, update(k, dt, t) {
    const env = THREE.MathUtils.smoothstep(k, 0, 0.18) * (1 - THREE.MathUtils.smoothstep(k, 0.6, 1));
    mat.uniforms.uTime.value = t;
    mat.uniforms.uOpacity.value = 2.6 * env * (0.85 + 0.15 * Math.sin(t * 0.9));
  }, end() { geo.dispose(); mat.dispose(); } };
}

export function beacon(center, radius, dir, camera, rfx = null) {
  const g = new THREE.Group();
  const at = surfacePoint(center, radius, dir);
  if (rfx?.ready("laser") && rfx.ready("glint")) {
    // Real light: a teal-white beam (laser-photo profile) rising from the surface and a lens glint at its foot.
    const b = rfx.beam(TEAL.clone().lerp(WHITE, 0.35), 0.06);
    const foot = rfx.glint("glint", TEAL.clone().lerp(WHITE, 0.5), radius * 0.35, 0); foot.position.copy(at);
    g.add(b, foot);
    return { obj: g, dur: 3.2, update(k, dt, t) {
      const rise = Math.min(1, k / 0.25), e = 1 - Math.pow(1 - rise, 3);
      b.userData.set(at, at.clone().addScaledVector(dir, 0.2 + e * radius * 1.6), 0.05);
      const fade = (k < 0.08 ? k / 0.08 : 1) * (1 - THREE.MathUtils.smoothstep(k, 0.7, 1));
      b.material.uniforms.uOpacity.value = fade * 0.9; b.material.uniforms.uTime.value = t * 0.1;
      foot.material.uniforms.uOpacity.value = fade * (0.6 + 0.4 * Math.max(0, 1 - k * 4)) * 1.1;
    } };
  }
  const tower = add(new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.04, 0.6, 6), new THREE.MeshBasicMaterial({ color: WHITE.clone().multiplyScalar(1.4) })));
  tower.position.copy(at.clone().addScaledVector(dir, 0.3)); tower.lookAt(at.clone().addScaledVector(dir, 2)); tower.rotateX(Math.PI / 2);
  const ring = add(new THREE.Mesh(new THREE.RingGeometry(0.2, 0.24, 48), new THREE.MeshBasicMaterial({ color: TEAL.clone().multiplyScalar(1.5), side: THREE.DoubleSide })));
  g.add(tower, ring);
  return { obj: g, dur: 2.4, update(k) {
    tower.material.opacity = k < 0.8 ? 1 : (1 - k) / 0.2;
    ring.position.copy(at.clone().lerp(camera.position, k * 0.5)); ring.lookAt(camera.position);
    ring.scale.setScalar(1 + k * 6); ring.material.opacity = (1 - k) * 0.8;
  } };
}

export function supply(getMoon, moonR, rfx = null) {
  const ship = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.06, 0.22), new THREE.MeshStandardMaterial({ color: 0x777b80, metalness: 0.8, roughness: 0.3, emissive: TEAL, emissiveIntensity: 0.3 }));
  if (rfx) { const w = new THREE.Group(); ship.add(w); rfx.dress(w, "pod", { size: 0.38, engineColor: TEAL.clone().lerp(WHITE, 0.5), hide: [ship] }); }
  const pulse = add(new THREE.Mesh(new THREE.SphereGeometry(1, 16, 8), new THREE.MeshBasicMaterial({ color: TEAL.clone().multiplyScalar(1.3), opacity: 0 })));
  const g = new THREE.Group(); g.add(ship, pulse);
  let docked = false;
  const from = new THREE.Vector3(6, 3, 4);
  return { obj: g, dur: 2.6, update(k) {
    const m = getMoon();
    const e = Math.min(1, k / 0.7), ee = 1 - Math.pow(1 - e, 3);
    ship.position.copy(m).add(from.clone().multiplyScalar(1 - ee)).add(new THREE.Vector3(0, moonR + 0.15, 0).multiplyScalar(ee));
    ship.lookAt(m);
    pulse.position.copy(m); const pk = Math.max(0, (k - 0.7) / 0.3);
    if (rfx?.ready("glint")) { // docking: a soft real glint at the moon instead of an expanding sphere
      pulse.visible = false;
      if (pk > 0 && !docked) { docked = true; rfx.flash(m.clone().add(new THREE.Vector3(0, moonR + 0.15, 0)), { size: moonR * 2.2, color: TEAL.clone().lerp(WHITE, 0.4), dur: 0.9 }); }
    } else { pulse.scale.setScalar(moonR * (1 + pk * 1.5)); pulse.material.opacity = pk > 0 ? (1 - pk) * 0.35 : 0; }
    ship.visible = k < 0.95;
  } };
}

export function clearSky(center, radius, dir, rfx = null) {
  const at = surfacePoint(center, radius, dir, 0.05);
  if (rfx?.ready("flare")) {
    // Sunlight breaking through: a real star-glare photo, warm white, swelling and fading (no flat disc).
    const m = rfx.glint("flare", new THREE.Color(1, 0.96, 0.88), radius * 0.9, 0); m.position.copy(at);
    return { obj: m, dur: 2.0, update(k) { m.material.uniforms.uOpacity.value = Math.sin(Math.PI * Math.min(1, k * 1.1)) * 0.75; m.scale.setScalar(0.6 + k * 0.5); } };
  }
  const m = add(new THREE.Mesh(new THREE.CircleGeometry(radius * 0.5, 48), new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.97, 0.9).multiplyScalar(1.5) })));
  orientOutward(m, center, at);
  return { obj: m, dur: 1.4, update(k) { m.material.opacity = Math.sin(Math.PI * k) * 0.45; m.scale.setScalar(0.4 + k * 0.8); } };
}

export function cityLights(center, radius, sun, count) {
  const pts = [], col = [];
  for (let i = 0; i < count; i++) {
    let d = new THREE.Vector3().randomDirection();
    if (d.dot(sun) > -0.1) d.addScaledVector(sun, -2 * d.dot(sun)).normalize(); // night side only
    pts.push(...surfacePoint(center, radius, d, 0.01).toArray()); col.push(1, 0.85, 0.55);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  const m = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.06, color: new THREE.Color(1, 0.86, 0.55).multiplyScalar(1.6), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
  return { obj: m, dur: 3.2, update(k, dt, t) { m.material.opacity = Math.sin(Math.PI * k) * (0.8 + 0.2 * Math.sin(t * 20)); } };
}

export function impacts(center, radius, sun, rfx = null) {
  const g = new THREE.Group();
  const real = !!rfx?.ready("explosion");
  const hits = [0].map((i) => {
    const d = new THREE.Vector3().randomDirection().lerp(sun, 0.5).normalize();
    const at = surfacePoint(center, radius, d, 0.01);
    const flash = add(new THREE.Mesh(new THREE.CircleGeometry(radius * 0.08, 24), new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.55, 0.25).multiplyScalar(3) })));
    const crater = new THREE.Mesh(new THREE.CircleGeometry(radius * 0.06, 24), new THREE.MeshBasicMaterial({ color: 0x050505, transparent: true, opacity: 0, depthWrite: false }));
    orientOutward(flash, center, at); orientOutward(crater, center, surfacePoint(center, radius, d, 0.005));
    g.add(flash, crater);
    if (real) flash.visible = false; // the real fireball replaces the flat flash disc
    return { flash, crater, at: surfacePoint(center, radius, d, radius * 0.04), t0: i * 0.35, hit: false };
  });
  return { obj: g, dur: 6, update(k) {
    const s = k * 6;
    for (const h of hits) {
      const lt = s - h.t0;
      if (real) { if (lt > 0 && !h.hit) { h.hit = true; rfx.boom(h.at, { size: radius * 0.07, dur: 1.4 }); } }
      else { h.flash.material.opacity = lt > 0 && lt < 0.4 ? (1 - lt / 0.4) * 0.6 : 0; h.flash.scale.setScalar(1 + Math.max(0, lt) * 0.6); }
      h.crater.material.opacity = lt > 0.1 ? Math.max(0, 0.85 - (lt - 0.1) / 6) : 0;
    }
  } };
}

export function tremor(planet, center, radius, sun) {
  const base = planet.position.clone();
  const d = new THREE.Vector3().randomDirection().lerp(sun, 0.4).normalize();
  const pts = [];
  let p = d.clone();
  for (let i = 0; i < 14; i++) { pts.push(surfacePoint(center, radius, p, 0.01)); p = p.clone().add(new THREE.Vector3().randomDirection().multiplyScalar(0.06)).normalize(); }
  const crack = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: new THREE.Color(1, 0.3, 0.12).multiplyScalar(2.4), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
  return { obj: crack, dur: 1.6, update(k) {
    const shake = k < 0.5 ? (1 - k / 0.5) * radius * 0.03 : 0;
    planet.position.copy(base).add(new THREE.Vector3((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake, 0));
    crack.material.opacity = Math.sin(Math.PI * k);
  }, end() { planet.position.copy(base); } };
}

export { AMBER, TEAL };
