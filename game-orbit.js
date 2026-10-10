// The player's ship on the real clock: two-body orbits around whichever body dominates (patched conics), so
// time away is skipped analytically (a months-long Real-mode transfer is computed, not simulated step by step),
// and the ship hands over between Sun, planets and Moon at their spheres of influence.
// State: { body, r: [km], v: [km/s], t: unix ms } with r, v relative to `body`, ecliptic J2000.

import { GM, SOI, RADIUS, bodyPosition, jdOf, sub, len } from "./game-ephem.js";

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Universal-variable Kepler propagation (works for ellipses, parabolas and hyperbolas). dt in seconds.
function stumpff(z) {
  if (z > 1e-6) { const s = Math.sqrt(z); return [(1 - Math.cos(s)) / z, (s - Math.sin(s)) / (s * s * s)]; }
  if (z < -1e-6) { const s = Math.sqrt(-z); return [(Math.cosh(s) - 1) / -z, (Math.sinh(s) - s) / (s * s * s)]; }
  return [1 / 2 - z / 24, 1 / 6 - z / 120];
}
export function kepler(r0, v0, dt, mu) {
  if (dt === 0) return { r: r0, v: v0 };
  const R0 = len(r0), V0 = len(v0), vr0 = dot(r0, v0) / R0, alpha = 2 / R0 - (V0 * V0) / mu, sq = Math.sqrt(mu);
  let x = Math.abs(alpha) > 1e-12 ? sq * Math.abs(alpha) * dt : sq * dt / R0;
  if (alpha > 1e-12) x = sq * alpha * dt; // ellipse: start at the mean-motion guess
  for (let i = 0; i < 100; i++) {
    const z = alpha * x * x, [C, S] = stumpff(z);
    const F = (R0 * vr0) / sq * x * x * C + (1 - alpha * R0) * x * x * x * S + R0 * x - sq * dt;
    const dF = (R0 * vr0) / sq * x * (1 - alpha * x * x * S) + (1 - alpha * R0) * x * x * C + R0;
    const step = F / dF; x -= step; if (Math.abs(step) < 1e-9) break;
  }
  const z = alpha * x * x, [C, S] = stumpff(z);
  const f = 1 - (x * x / R0) * C, g = dt - (x * x * x / sq) * S;
  const r = add(scale(r0, f), scale(v0, g)), Rn = len(r);
  const fd = (sq / (Rn * R0)) * (alpha * x * x * x * S - x), gd = 1 - (x * x / Rn) * C;
  return { r, v: add(scale(r0, fd), scale(v0, gd)) };
}

// Orbit summary for the HUD and tests: apoapsis/periapsis altitude, period, energy.
export function orbitInfo(state) {
  const mu = GM[state.body], R = len(state.r), V = len(state.v);
  const energy = (V * V) / 2 - mu / R, a = -mu / (2 * energy);
  const h = [state.r[1] * state.v[2] - state.r[2] * state.v[1], state.r[2] * state.v[0] - state.r[0] * state.v[2], state.r[0] * state.v[1] - state.r[1] * state.v[0]];
  const e = Math.sqrt(Math.max(0, 1 + (2 * energy * dot(h, h)) / (mu * mu)));
  const bound = energy < 0;
  return { a, e, bound, periapsis: a * (1 - e) - RADIUS[state.body], apoapsis: bound ? a * (1 + e) - RADIUS[state.body] : Infinity,
    period: bound ? 2 * Math.PI * Math.sqrt((a * a * a) / mu) : Infinity, altitude: R - RADIUS[state.body], speed: V };
}

// The ship's position and velocity relative to the Sun (for handing over between bodies).
const PARENT = { moon: "earth", mercury: "sun", venus: "sun", earth: "sun", mars: "sun", jupiter: "sun", saturn: "sun", uranus: "sun", neptune: "sun" };
function bodyState(name, t) { // heliocentric r, v (v by central difference over 60 s)
  if (name === "sun") return { r: [0, 0, 0], v: [0, 0, 0] };
  const j = jdOf(t), dj = 60 / 86400, a = bodyPosition(name, j - dj), b = bodyPosition(name, j + dj);
  return { r: bodyPosition(name, j), v: scale(sub(b, a), 1 / 120) };
}
function rebase(state, to) {
  const from = bodyState(state.body, state.t), dest = bodyState(to, state.t);
  return { ...state, body: to, r: sub(add(state.r, from.r), dest.r), v: sub(add(state.v, from.v), dest.v) };
}
// Which body should own the ship right now: the smallest sphere of influence it sits inside.
function dominant(state) {
  const helio = add(state.r, bodyState(state.body, state.t).r), j = jdOf(state.t);
  const moonP = bodyPosition("moon", j);
  if (len(sub(helio, moonP)) < SOI.moon) return "moon";
  for (const p of Object.keys(SOI)) if (p !== "moon" && len(sub(helio, bodyPosition(p, j))) < SOI[p]) return p;
  return "sun";
}

// Advance the ship to time `t` (unix ms). Long gaps are walked in chunks so a sphere-of-influence crossing on
// the way is caught; each chunk is exact two-body motion. Returns { state, events } where events lists
// handovers and impacts, with times, so the game can tell the player what happened while they were away.
export function advance(state, t, { maxChunkS = 3600 } = {}) {
  let s = { ...state }; const events = [];
  while (s.t < t) {
    const info = orbitInfo(s);
    const chunk = Math.min((t - s.t) / 1000, maxChunkS, info.bound ? info.period / 64 : maxChunkS, Math.max(30, info.altitude / Math.max(0.1, info.speed) / 4));
    const k = kepler(s.r, s.v, chunk, GM[s.body]);
    s = { ...s, r: k.r, v: k.v, t: s.t + chunk * 1000 };
    if (len(s.r) < RADIUS[s.body]) { events.push({ t: s.t, kind: "impact", body: s.body }); s.crashed = true; break; }
    const owner = s.body === "moon" ? (len(s.r) > SOI.moon ? "earth" : "moon") : dominant(s);
    if (owner !== s.body && !(PARENT[s.body] === owner && len(s.r) < SOI[s.body])) { events.push({ t: s.t, kind: "handover", from: s.body, to: owner }); s = rebase(s, owner); }
  }
  return { state: s, events };
}

// A burn: an instant change in velocity (km/s), in the ship's prograde/normal/radial frame.
export function burn(state, { prograde = 0, normal = 0, radial = 0 }) {
  const vhat = scale(state.v, 1 / len(state.v)), rhat = scale(state.r, 1 / len(state.r));
  const h = [state.r[1] * state.v[2] - state.r[2] * state.v[1], state.r[2] * state.v[0] - state.r[0] * state.v[2], state.r[0] * state.v[1] - state.r[1] * state.v[0]];
  const nhat = scale(h, 1 / len(h));
  return { ...state, v: add(add(add(state.v, scale(vhat, prograde)), scale(nhat, normal)), scale(rhat, radial)) };
}

// A circular orbit at `altitude` km around `body`, in the body's ecliptic plane (a simple start state).
export function circular(body, altitude, t) {
  const r = RADIUS[body] + altitude, v = Math.sqrt(GM[body] / r);
  return { body, r: [r, 0, 0], v: [0, v, 0], t };
}
