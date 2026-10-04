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
export function storm(center, radius, dir, reduced) {
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uTime: { value: 0 }, uFade: { value: 0 }, uFlash: { value: 0 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: `uniform float uTime, uFade, uFlash; varying vec2 vUv;
      void main(){ vec2 p = vUv*2.-1.; float r = length(p); if (r > 1.0) discard;
        float a = atan(p.y, p.x) + r*6.0 - uTime*0.8;
        float arms = 0.5 + 0.5*sin(a*3.0);
        float dark = smoothstep(1.0, 0.15, r) * (0.55 + 0.45*arms);
        vec3 col = vec3(0.02, 0.02, 0.03);
        float bolt = uFlash * smoothstep(0.06, 0.0, abs(p.x*0.6 + sin(p.y*9.0 + uTime*30.0)*0.08)) * step(r, 0.7);
        gl_FragColor = vec4(col + vec3(0.85, 0.9, 1.0)*bolt*1.4, (dark*0.85 + bolt) * uFade); }`,
  });
  const size = radius * 0.55;
  const m = new THREE.Mesh(new THREE.CircleGeometry(size, 48), mat);
  orientOutward(m, center, surfacePoint(center, radius, dir, 0.02));
  let stopping = null, flashT = 0;
  return {
    obj: m, label: true,
    update(dt, t) {
      mat.uniforms.uTime.value = reduced ? 0 : t;
      const goal = stopping ? 0 : 1;
      mat.uniforms.uFade.value += (goal - mat.uniforms.uFade.value) * Math.min(1, dt * (stopping ? 2.5 : 1.2));
      if (!reduced) { flashT -= dt; if (flashT <= 0) { flashT = 1.2 + Math.random() * 3; mat.uniforms.uFlash.value = 1; } mat.uniforms.uFlash.value *= 0.82; }
      if (stopping && mat.uniforms.uFade.value < 0.02) { stopping(); return false; }
      return true;
    },
    stop() { return new Promise((r) => { stopping = r; }); },
    anchor: () => m.position,
  };
}

export function attack(center, radius, getTarget, reduced) {
  const g = new THREE.Group();
  const craftGeo = new THREE.ConeGeometry(0.09, 0.32, 5); craftGeo.rotateX(Math.PI / 2);
  const craft = [0, 1, 2].map((k) => {
    const c = new THREE.Mesh(craftGeo, new THREE.MeshStandardMaterial({ color: 0x1a1a1a, metalness: 0.6, roughness: 0.4, emissive: AMBER, emissiveIntensity: 0.35 }));
    c.userData.phase = (k / 3) * Math.PI * 2; g.add(c); return c;
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
        if (fire <= 0 && target) { fire = 1.4 + Math.random() * 1.6; shot = { from: craft[Math.floor(Math.random() * 3)].position.clone(), to: target.clone(), k: 0 }; }
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
export function aurora(center, radius) {
  const g = new THREE.Group();
  const rings = [0, 1, 2].map((k) => {
    const m = add(new THREE.Mesh(new THREE.TorusGeometry(radius * (0.42 + k * 0.1), 0.02, 6, 96), new THREE.MeshBasicMaterial({ color: TEAL.clone().lerp(WHITE, k * 0.2).multiplyScalar(1.6) })));
    m.rotation.x = Math.PI / 2; m.position.set(0, radius * (0.93 - k * 0.04), 0); g.add(m); return m;
  });
  g.position.copy(center);
  return { obj: g, dur: 3.2, update(k, dt, t) { rings.forEach((r, i) => { r.material.opacity = Math.sin(Math.PI * k) * (0.9 - i * 0.2) * (0.75 + 0.25 * Math.sin(t * 6 + i)); r.scale.setScalar(1 + k * 0.08); }); } };
}

export function beacon(center, radius, dir, camera) {
  const g = new THREE.Group();
  const at = surfacePoint(center, radius, dir);
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

export function supply(getMoon, moonR) {
  const ship = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.06, 0.22), new THREE.MeshStandardMaterial({ color: 0x777b80, metalness: 0.8, roughness: 0.3, emissive: TEAL, emissiveIntensity: 0.3 }));
  const pulse = add(new THREE.Mesh(new THREE.SphereGeometry(1, 16, 8), new THREE.MeshBasicMaterial({ color: TEAL.clone().multiplyScalar(1.3), opacity: 0 })));
  const g = new THREE.Group(); g.add(ship, pulse);
  const from = new THREE.Vector3(6, 3, 4);
  return { obj: g, dur: 2.6, update(k) {
    const m = getMoon();
    const e = Math.min(1, k / 0.7), ee = 1 - Math.pow(1 - e, 3);
    ship.position.copy(m).add(from.clone().multiplyScalar(1 - ee)).add(new THREE.Vector3(0, moonR + 0.15, 0).multiplyScalar(ee));
    ship.lookAt(m);
    pulse.position.copy(m); const pk = Math.max(0, (k - 0.7) / 0.3);
    pulse.scale.setScalar(moonR * (1 + pk * 1.5)); pulse.material.opacity = pk > 0 ? (1 - pk) * 0.35 : 0;
    ship.visible = k < 0.95;
  } };
}

export function clearSky(center, radius, dir) {
  const at = surfacePoint(center, radius, dir, 0.05);
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

export function impacts(center, radius, sun) {
  const g = new THREE.Group();
  const hits = [0, 1, 2].map((i) => {
    const d = new THREE.Vector3().randomDirection().lerp(sun, 0.5).normalize();
    const at = surfacePoint(center, radius, d, 0.01);
    const flash = add(new THREE.Mesh(new THREE.CircleGeometry(radius * 0.08, 24), new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.55, 0.25).multiplyScalar(3) })));
    const crater = new THREE.Mesh(new THREE.CircleGeometry(radius * 0.06, 24), new THREE.MeshBasicMaterial({ color: 0x050505, transparent: true, opacity: 0, depthWrite: false }));
    orientOutward(flash, center, at); orientOutward(crater, center, surfacePoint(center, radius, d, 0.005));
    g.add(flash, crater);
    return { flash, crater, t0: i * 0.18 };
  });
  return { obj: g, dur: 6, update(k) {
    const s = k * 6;
    for (const h of hits) {
      const lt = s - h.t0;
      h.flash.material.opacity = lt > 0 && lt < 0.5 ? 1 - lt / 0.5 : 0;
      h.flash.scale.setScalar(1 + Math.max(0, lt) * 2);
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
