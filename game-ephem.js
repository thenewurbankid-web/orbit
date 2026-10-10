// Where things really are, at any moment, computed in the page (no network). Units: km and seconds;
// frame: ecliptic J2000, Sun at the origin unless a function says otherwise.
//   Planets: JPL "Keplerian Elements for Approximate Positions of the Major Planets", Table 1 (E. M. Standish,
//            valid 1800–2050; errors from arcseconds (inner planets) to ~10 arcminutes (Saturn)).
//   Moon:    Paul Schlyter's low-precision lunar theory with its main perturbations (~0.1°, a few 100 km),
//            precessed from the ecliptic of date to J2000.
//   Small bodies: two-body Kepler from published osculating elements (NASA NeoWs orbital_data).
// test/game-ephem.test.mjs checks all of it against JPL Horizons vectors.

export const AU = 149597870.7;               // km
export const DAY = 86400;                    // s
export const J2000 = 2451545.0;              // JD of 2000-01-01 12:00 TT
export const GM = { sun: 1.32712440018e11, mercury: 2.2032e4, venus: 3.24859e5, earth: 3.986004418e5, moon: 4.9048695e3, mars: 4.282837e4, jupiter: 1.26686534e8, saturn: 3.7931187e7, uranus: 5.793939e6, neptune: 6.836529e6 }; // km³/s²
export const RADIUS = { sun: 695700, mercury: 2439.7, venus: 6051.8, earth: 6371.0, moon: 1737.4, mars: 3389.5, jupiter: 69911, saturn: 58232, uranus: 25362, neptune: 24622 }; // km (mean)
const EARTH_MOON_MASS_RATIO = 81.30056;
const D2R = Math.PI / 180;

export const jdOf = (ms) => ms / 86400000 + 2440587.5;          // Unix ms → Julian date (UTC; TT is ~69 s later, below our accuracy)
export const msOf = (jd) => (jd - 2440587.5) * 86400000;

// a (AU), e, I, L, long.peri, long.node (deg); then rates per Julian century.
const PLANETS = {
  mercury: [[0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593], [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081]],
  venus:   [[0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255], [0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418]],
  emb:     [[1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0], [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0]],
  mars:    [[1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891], [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343]],
  jupiter: [[5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909], [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106]],
  saturn:  [[9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448], [-0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794]],
  uranus:  [[19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630, 74.01692503], [-0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589]],
  neptune: [[30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574], [0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664]],
};
export const PLANET_NAMES = ["mercury", "venus", "earth", "mars", "jupiter", "saturn", "uranus", "neptune"];

export function solveKepler(M, e) { // elliptic, radians
  M = ((M % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
  let E = e < 0.8 ? M : Math.PI * Math.sign(M || 1);
  for (let i = 0; i < 50; i++) { const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E)); E -= d; if (Math.abs(d) < 1e-13) break; }
  return E;
}

// Position (and velocity) on an ellipse from classical elements. a in km; angles in radians; mu in km³/s².
export function ellipseState({ a, e, i, node, peri, M }, mu) {
  const E = solveKepler(M, e), cE = Math.cos(E), sE = Math.sin(E), b = Math.sqrt(1 - e * e);
  const xp = a * (cE - e), yp = a * b * sE;
  const n = Math.sqrt(mu / (a * a * a)), Edot = n / (1 - e * cE);
  const vxp = -a * sE * Edot, vyp = a * b * cE * Edot;
  const cO = Math.cos(node), sO = Math.sin(node), cw = Math.cos(peri), sw = Math.sin(peri), ci = Math.cos(i), si = Math.sin(i);
  const r = (x, y) => [(cO * cw - sO * sw * ci) * x + (-cO * sw - sO * cw * ci) * y, (sO * cw + cO * sw * ci) * x + (-sO * sw + cO * cw * ci) * y, sw * si * x + cw * si * y];
  return { r: r(xp, yp), v: r(vxp, vyp) };
}

function planetElements(name, jd) {
  const [e0, rate] = PLANETS[name], T = (jd - J2000) / 36525;
  const [a, e, I, L, wbar, node] = e0.map((x, k) => x + rate[k] * T);
  return { a: a * AU, e, i: I * D2R, node: node * D2R, peri: (wbar - node) * D2R, M: (L - wbar) * D2R };
}

// Moon relative to Earth (geocentric), km.
export function moonGeocentric(jd) {
  const d = jd - 2451543.5, deg = (x) => ((x % 360) + 360) % 360;
  const N = deg(125.1228 - 0.0529538083 * d) * D2R, i = 5.1454 * D2R, w = deg(318.0634 + 0.1643573223 * d) * D2R;
  const a = 60.2666, e = 0.0549, M = deg(115.3654 + 13.0649929509 * d) * D2R;
  const Ms = deg(356.047 + 0.9856002585 * d) * D2R, ws = deg(282.9404 + 4.70935e-5 * d) * D2R;
  const E = solveKepler(M, e), xv = a * (Math.cos(E) - e), yv = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const v = Math.atan2(yv, xv); let r = Math.hypot(xv, yv);
  const xh = r * (Math.cos(N) * Math.cos(v + w) - Math.sin(N) * Math.sin(v + w) * Math.cos(i));
  const yh = r * (Math.sin(N) * Math.cos(v + w) + Math.cos(N) * Math.sin(v + w) * Math.cos(i));
  const zh = r * Math.sin(v + w) * Math.sin(i);
  let lon = Math.atan2(yh, xh) / D2R, lat = Math.atan2(zh, Math.hypot(xh, yh)) / D2R;
  const Ls = Ms + ws, Lm = M + w + N, D = Lm - Ls, F = Lm - N, s = Math.sin, c = Math.cos;
  lon += -1.274 * s(M - 2 * D) + 0.658 * s(2 * D) - 0.186 * s(Ms) - 0.059 * s(2 * M - 2 * D) - 0.057 * s(M - 2 * D + Ms) + 0.053 * s(M + 2 * D)
    + 0.046 * s(2 * D - Ms) + 0.041 * s(M - Ms) - 0.035 * s(D) - 0.031 * s(M + Ms) - 0.015 * s(2 * F - 2 * D) + 0.011 * s(M - 4 * D);
  lat += -0.173 * s(F - 2 * D) - 0.055 * s(M - F - 2 * D) - 0.046 * s(M + F - 2 * D) + 0.033 * s(F + 2 * D) + 0.017 * s(2 * M + F);
  r += -0.58 * c(M - 2 * D) - 0.46 * c(2 * D);
  lon -= 3.82394e-5 * d; // ecliptic of date → J2000
  const R = r * 6378.14, la = lat * D2R, lo = lon * D2R;
  return [R * Math.cos(la) * Math.cos(lo), R * Math.cos(la) * Math.sin(lo), R * Math.sin(la)];
}

// Heliocentric position of a planet (or "moon"), km. Earth comes from the Earth–Moon barycentre minus its share of the Moon.
export function bodyPosition(name, jd) {
  if (name === "sun") return [0, 0, 0];
  if (name === "earth" || name === "moon") {
    const emb = ellipseState(planetElements("emb", jd), GM.sun).r, m = moonGeocentric(jd), k = 1 / (1 + EARTH_MOON_MASS_RATIO);
    const earth = [emb[0] - m[0] * k, emb[1] - m[1] * k, emb[2] - m[2] * k];
    return name === "earth" ? earth : [earth[0] + m[0], earth[1] + m[1], earth[2] + m[2]];
  }
  return ellipseState(planetElements(name, jd), GM.sun).r;
}

// Small body from NeoWs orbital_data (heliocentric, ecliptic J2000).
export function smallBodyElements(od) {
  return { epochJd: Number(od.epoch_osculation), a: Number(od.semi_major_axis) * AU, e: Number(od.eccentricity), i: Number(od.inclination) * D2R,
    node: Number(od.ascending_node_longitude) * D2R, peri: Number(od.perihelion_argument) * D2R, M0: Number(od.mean_anomaly) * D2R, n: Number(od.mean_motion) * D2R / DAY };
}
export function smallBodyPosition(el, jd) {
  if (el.e >= 1) return null; // hyperbolic visitors: not handled yet
  return ellipseState({ ...el, M: el.M0 + el.n * (jd - el.epochJd) * DAY }, GM.sun).r;
}

// Sphere of influence radius (km) for a planet around the Sun, and for the Moon around Earth.
export const SOI = Object.fromEntries([...PLANET_NAMES.map((p) => [p, (p === "earth" ? 1.00000261 : PLANETS[p][0][0]) * AU * Math.pow(GM[p] / GM.sun, 0.4)]), ["moon", 384400 * Math.pow(GM.moon / GM.earth, 0.4)]]);

export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
