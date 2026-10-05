// Craft flight as a light rigid body. A path is baked once (centripetal Catmull-Rom through a few points) and
// travelled by arc length under a speed limit and a jerk-limited acceleration limit: it speeds up, cruises and
// brakes in time to stop. Heading follows the velocity through a limited, damped turn rate; the craft rolls
// into turns from its lateral acceleration and pitches a touch with longitudinal acceleration; engine glow
// follows thrust. Hover is station-keeping: a soft spring to the home point plus a slow random drift.
import * as THREE from "three";

const UP = new THREE.Vector3(0, 1, 0), ORIGIN = new THREE.Vector3();
const m4 = new THREE.Matrix4(), qd = new THREE.Quaternion(), qb = new THREE.Quaternion(), e3 = new THREE.Euler();
const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();

export function createPilot(g, { vmax = 2, amax = 1.2, turn = 1.4, bank = 0.4, reduced = false } = {}) {
  const p = {
    g, mode: "idle", vmax, amax, turn, bankMax: bank,
    pos: g.position.clone(), vel: new THREE.Vector3(), acc: new THREE.Vector3(), q: g.quaternion.clone(),
    s: 0, v: 0, a: 0, L: 0, curve: null, endFn: null, bakedEnd: new THREE.Vector3(), bank: 0, pitch: 0,
    home: null, off: new THREE.Vector3(), offV: new THREE.Vector3(), face: null, done: false, thrust: 0.3,
  };
  const prevVel = new THREE.Vector3();
  // Fly along points (the first is taken as the current position). endFn: a live end point (moving target).
  p.fly = (points, { endFn = null, vmax: vm, face = null } = {}) => {
    const pts = [p.pos.clone(), ...points.map((x) => x.clone())];
    p.curve = new THREE.CatmullRomCurve3(pts, false, "centripetal", 0.5);
    p.L = Math.max(1e-3, p.curve.getLength());
    p.s = 0; p.v = Math.min(p.v, p.vel.length()); p.a = 0;
    p.endFn = endFn; p.bakedEnd.copy(pts[pts.length - 1]);
    if (vm) p.vmax = vm;
    p.mode = "fly"; p.done = false; p.face = face;
    return p;
  };
  // Hold station at a (moving) home point; optional facing function for the nose.
  p.hold = (homeFn, { face = null } = {}) => { p.home = homeFn; p.mode = "hold"; p.face = face; p.done = false; return p; };
  // Chase a moving point (dogfight circling): a critically damped spring with an acceleration cap.
  p.chase = (fn, w = 2.2) => { p.home = fn; p.chaseW = w; p.mode = "chase"; p.face = null; p.done = false; return p; };

  p.update = (dt) => {
    if (dt <= 0) return p.done;
    const before = tmp2.copy(p.pos);
    if (p.mode === "fly") {
      const remain = p.L - p.s;
      const vBrake = Math.sqrt(Math.max(0, 2 * p.amax * 0.55 * remain));     // speed from which we can still stop
      const vGoal = Math.min(p.vmax, vBrake);
      const aCmd = THREE.MathUtils.clamp((vGoal - p.v) * 3, -p.amax, p.amax);
      p.a += (aCmd - p.a) * (1 - Math.exp(-dt * 5));                        // jerk limit: acceleration eases in and out
      p.v = Math.max(0, p.v + p.a * dt);
      p.s = Math.min(p.L, p.s + p.v * dt);
      const u = p.s / p.L;
      p.curve.getPointAt(u, p.pos);
      if (p.endFn) { const w = u * u * (3 - 2 * u); p.pos.add(tmp.copy(p.endFn()).sub(p.bakedEnd).multiplyScalar(w)); }
      if (remain < 1e-3 || (remain < 0.02 && p.v < 0.05)) { p.mode = "idle"; p.done = true; p.v = 0; }
    } else if (p.mode === "hold" || p.mode === "chase") {
      const h = p.home();
      if (p.mode === "hold" && !reduced) {
        // slow random drift (Ornstein-Uhlenbeck): tiny, low-frequency, never a sine bob
        const k = 0.35, c = 0.9, n = 0.012;
        p.offV.addScaledVector(p.off, -k * dt).multiplyScalar(Math.exp(-c * dt));
        p.offV.x += (Math.random() - 0.5) * n * Math.sqrt(dt); p.offV.y += (Math.random() - 0.5) * n * Math.sqrt(dt); p.offV.z += (Math.random() - 0.5) * n * 0.5 * Math.sqrt(dt);
        p.off.addScaledVector(p.offV, dt);
      }
      const goal = tmp.copy(h).add(p.off);
      const w = p.mode === "chase" ? p.chaseW : 1.6;                          // critically damped spring to the goal
      const ax = goal.sub(p.pos).multiplyScalar(w * w).addScaledVector(p.vel, -2 * w);
      if (ax.length() > p.amax * 1.5) ax.setLength(p.amax * 1.5);
      p.vel.addScaledVector(ax, dt); p.pos.addScaledVector(p.vel, dt);
    }
    // kinematics → orientation
    const v = tmp.subVectors(p.pos, before).divideScalar(dt);
    if (p.mode !== "hold" && p.mode !== "chase") p.vel.copy(v);
    const accNow = v.clone().sub(prevVel).divideScalar(dt); prevVel.copy(v);
    p.acc.lerp(accNow, 1 - Math.exp(-dt * 4));
    const speed = v.length();
    let fwd = null;
    if (p.face) fwd = p.face(p.pos).clone().sub(p.pos);
    else if (speed > 0.04) fwd = v.clone();
    if (fwd && fwd.lengthSq() > 1e-8) {
      m4.lookAt(fwd.normalize(), ORIGIN, UP); qd.setFromRotationMatrix(m4); // +Z (the nose) along fwd
      const ang = p.q.angleTo(qd);
      if (ang > 1e-4) p.q.rotateTowards(qd, Math.min(ang * (1 - Math.exp(-dt * 3.5)), p.turn * dt));
    }
    // bank into turns, pitch with thrust; both eased
    const right = tmp.set(1, 0, 0).applyQuaternion(p.q), f = new THREE.Vector3(0, 0, 1).applyQuaternion(p.q);
    const lat = p.acc.dot(right), lon = p.acc.dot(f);
    const bGoal = reduced ? 0 : THREE.MathUtils.clamp(-lat * 0.35, -p.bankMax, p.bankMax);
    const pGoal = reduced ? 0 : THREE.MathUtils.clamp(-lon * 0.05, -0.08, 0.08);
    p.bank += (bGoal - p.bank) * (1 - Math.exp(-dt * 3)); p.pitch += (pGoal - p.pitch) * (1 - Math.exp(-dt * 3));
    p.thrust += (THREE.MathUtils.clamp(0.25 + lon / Math.max(0.1, p.amax) * 0.75, 0.1, 1) - p.thrust) * (1 - Math.exp(-dt * 4));
    g.position.copy(p.pos);
    g.quaternion.copy(p.q).multiply(qb.setFromEuler(e3.set(p.pitch, 0, p.bank)));
    if (g.userData.real) g.userData.real.thrust = p.thrust;
    return p.done;
  };
  return p;
}
