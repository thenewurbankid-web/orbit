// The settings station: one original, procedurally modelled space station (a hub with a docking spine, a slowly
// turning habitat ring on four spokes, radiator and solar panels, tiny running lights). Gunmetal PBR under the
// scene's sun, like the rest of the fleet. It is a pickable, Tab-reachable object; a subtle glow on hover.
import * as THREE from "three";

export function createStation({ envMap, layer = 4 }) {
  const g = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: 0x3e434a, metalness: 0.35, roughness: 0.55, envMap, envMapIntensity: 0.12 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x15171a, metalness: 0.25, roughness: 0.7, envMap, envMapIntensity: 0.08 });
  const panel = new THREE.MeshStandardMaterial({ color: 0x0d1420, metalness: 0.6, roughness: 0.32, envMap, envMapIntensity: 0.35 });
  const add = (geo, mat, f) => { const m = new THREE.Mesh(geo, mat); f?.(m); m.layers.enable(layer); g.add(m); return m; };
  // hub and spine (along Y)
  add(new THREE.CylinderGeometry(0.32, 0.32, 1.1, 24), metal);
  add(new THREE.CylinderGeometry(0.12, 0.12, 2.6, 12), dark);
  for (const y of [-1.3, 1.3]) add(new THREE.CylinderGeometry(0.2, 0.2, 0.22, 16), metal, (m) => (m.position.y = y));
  // the habitat ring on four spokes, turning slowly
  const ring = new THREE.Group(); g.add(ring);
  const torus = new THREE.Mesh(new THREE.TorusGeometry(1.35, 0.11, 12, 72), metal); torus.rotation.x = Math.PI / 2; torus.layers.enable(layer); ring.add(torus);
  for (let i = 0; i < 4; i++) { const s = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.05, 8), dark); s.rotation.z = Math.PI / 2; s.rotation.y = (i / 4) * Math.PI * 2; s.position.set(Math.cos((i / 4) * Math.PI * 2) * 0.82, 0, -Math.sin((i / 4) * Math.PI * 2) * 0.82); s.layers.enable(layer); ring.add(s); }
  // solar wings and a radiator on the spine
  for (const sx of [-1, 1]) {
    const w = add(new THREE.BoxGeometry(1.4, 0.02, 0.42), panel, (m) => m.position.set(sx * 1.0, 1.05, 0));
    add(new THREE.BoxGeometry(0.3, 0.03, 0.05), dark, (m) => m.position.set(sx * 0.35, 1.05, 0)); void w;
  }
  add(new THREE.BoxGeometry(0.03, 0.7, 0.5), dark, (m) => m.position.set(0, -0.85, 0.25));
  // running lights: tiny, slow glow (no strobe)
  const dot = (() => { const c = document.createElement("canvas"); c.width = c.height = 32; const x = c.getContext("2d"); const gr = x.createRadialGradient(16, 16, 0, 16, 16, 16); gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(0.2, "rgba(255,255,255,.45)"); gr.addColorStop(1, "rgba(255,255,255,0)"); x.fillStyle = gr; x.fillRect(0, 0, 32, 32); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; })();
  const lights = [[0, 1.42, 0, 0xe8e2d8], [1.7, 1.05, 0, 0xffb0a0], [-1.7, 1.05, 0, 0xa8f0c0], [0, -1.42, 0, 0xe8e2d8]].map(([x, y, z, c]) => { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: dot, color: c, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })); s.position.set(x, y, z); s.scale.setScalar(0.12); g.add(s); return s; });
  // hover glow: a faint, wide halo
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: dot, color: 0xc8d4e0, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 }));
  halo.scale.setScalar(5); g.add(halo);
  g.rotation.set(0.35, 0.5, 0.15);
  let hot = 0, t = 0;
  return {
    group: g,
    update(dt, { hover = false, reduced = false, tempo = 1 } = {}) {
      t += dt;
      if (!reduced) { ring.rotation.y += dt * 0.05 * tempo; g.rotation.y += dt * 0.004 * tempo; }
      lights.forEach((s, i) => (s.material.opacity = reduced ? 0.6 : 0.45 + 0.3 * Math.sin(0.9 * t - 0.7 * i)));
      hot += ((hover ? 1 : 0) - hot) * (1 - Math.exp(-dt * 5));
      halo.material.opacity = 0.12 * hot;
    },
  };
}
