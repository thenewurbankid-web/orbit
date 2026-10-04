// Message carriers: small, matte, sunlit low-poly craft. Each faces +Z (use lookAt along the path).
import * as THREE from "three";

const hull = () => new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.85, metalness: 0 });
const dark = () => new THREE.MeshStandardMaterial({ color: 0x2c3035, roughness: 0.9, metalness: 0 });
const glow = (c, k = 3.2) => new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(k) });

// Quadcopter drone carrying a small data cube.
export function makeDrone() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.05, 0.16), hull()); g.add(body);
  const rotors = [];
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.015, 0.02), dark()); arm.position.set(x * 0.07, 0, z * 0.07); arm.rotation.y = Math.atan2(z, x) * -1; g.add(arm);
    const r = new THREE.Mesh(new THREE.CircleGeometry(0.055, 16), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.6, 0.85, 1).multiplyScalar(1.6), transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }));
    r.rotation.x = -Math.PI / 2; r.position.set(x * 0.12, 0.03, z * 0.12); g.add(r); rotors.push(r);
  }
  const nav = new THREE.Mesh(new THREE.SphereGeometry(0.015, 8, 6), glow(0x66ddff, 4)); nav.position.set(0, 0.02, 0.09); g.add(nav);
  const cube = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.06), glow(0x9fe8ff, 2.2)); cube.position.y = -0.07; g.add(cube);
  g.userData = { rotors, nav, cube, kind: "drone" };
  return g;
}

// Angular fighter with twin engines.
export function makeFighter() {
  const g = new THREE.Group();
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.32, 4), hull()); nose.rotation.x = Math.PI / 2; nose.position.z = 0.1; g.add(nose);
  const wing = new THREE.Mesh(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.2, 0, -0.1), new THREE.Vector3(0.2, 0, -0.1), new THREE.Vector3(0, 0, 0.14)]), dark());
  wing.geometry.setIndex([0, 2, 1]); wing.geometry.computeVertexNormals(); wing.material.side = THREE.DoubleSide; g.add(wing);
  const engines = [-0.05, 0.05].map((x) => { const e = new THREE.Mesh(new THREE.SphereGeometry(0.02, 8, 6), glow(0xbfe6ff, 4)); e.position.set(x, 0, -0.08); g.add(e); return e; });
  g.userData = { engines, kind: "fighter" };
  return g;
}

// Capsule pod with retro-thrusters (amber beacon for questions).
export function makePod(amber = false) {
  const g = new THREE.Group();
  const cap = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.1, 4, 10), hull()); cap.rotation.x = Math.PI / 2; g.add(cap);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.053, 0.053, 0.02, 12), dark()); band.rotation.x = Math.PI / 2; g.add(band);
  const thr = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 6), glow(amber ? 0xffb860 : 0xe8eef4, 3.5)); thr.position.z = -0.11; g.add(thr);
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.014, 8, 6), glow(amber ? 0xffa040 : 0xd0e0ff, amber ? 4 : 2)); beacon.position.set(0, 0.055, 0); g.add(beacon);
  g.userData = { thr, beacon, amber, kind: "pod" };
  return g;
}

// Hostile craft for an incoming question: dark, angular, amber running lights, engine glow.
export function makeHostile() {
  const g = new THREE.Group();
  const darkHull = new THREE.MeshStandardMaterial({ color: 0x23262a, roughness: 0.8, metalness: 0 });
  const body = new THREE.Mesh(new THREE.OctahedronGeometry(0.18, 0), darkHull); body.scale.set(1.3, 0.35, 1.6); g.add(body);
  for (const s of [-1, 1]) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.02, 0.12), darkHull); fin.position.set(s * 0.22, 0, -0.05); fin.rotation.y = s * 0.5; g.add(fin);
  }
  const lights = [[-0.34, 0, -0.08], [0.34, 0, -0.08], [0, 0.06, 0.2]].map(([x, y, z]) => { const l = new THREE.Mesh(new THREE.SphereGeometry(0.016, 8, 6), glow(0xffa040, 3.6)); l.position.set(x, y, z); g.add(l); return l; });
  const engine = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), glow(0xff8a3a, 3.2)); engine.position.z = -0.27; g.add(engine);
  g.userData = { lights, engine, kind: "hostile" };
  return g;
}
