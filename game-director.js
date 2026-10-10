// The Mission Director: live signals + the player's sky + a seed → a board of missions. Nothing is authored:
// the hand-written parts are only the rules below (which kind of event becomes which kind of mission, and how
// strength turns into difficulty, enemies and rewards). A fresh seed every refresh means neither the player nor
// whoever wrote this knows what comes next; the seed is kept on each mission so any one can be replayed.
//
// Balance lives here, never in the story text: the language model (or the templates) only describes a mission,
// it cannot change its numbers.

import { rng, hash } from "./game-rng.js";
const new_rng = rng;

export const MISSION_VERSION = 1;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const H = 3600e3;

// ---------------- factions: the same for everyone in one region on one day ----------------
const SYL = ["ka", "vor", "zen", "rah", "tel", "mor", "ix", "sol", "dra", "kor", "vel", "nyx", "ath", "ul", "qua", "ser", "tor", "ven", "oro", "lux"];
const KINDS = ["Syndicate", "Collective", "Armada", "Covenant", "Remnant", "Cartel", "Swarm", "Directorate"];
const TEMPER = ["swarm", "sniper", "brute", "raider"];
export function factionsFor(dayKey, cell) {
  const r = rng(`factions:${dayKey}:${cell}`);
  const used = new Set();
  return [0, 1, 2].map((i) => {
    let name; do { name = r.pick(SYL) + r.pick(SYL) + (r.chance(0.4) ? r.pick(SYL) : ""); } while (used.has(name)); used.add(name);
    name = name[0].toUpperCase() + name.slice(1);
    return { id: `f${i}`, name: `${name} ${r.pick(KINDS)}`, temper: TEMPER[(i + r.int(0, 3)) % 4], hue: Math.round((r.next() * 360 + i * 120) % 360) };
  });
}

// ---------------- enemies ----------------
export const ENEMIES = {
  drone:   { hp: 20,  speed: 14, dmg: 4,  value: 1 },
  fighter: { hp: 45,  speed: 11, dmg: 7,  value: 2 },
  sniper:  { hp: 30,  speed: 8,  dmg: 14, value: 2 },
  rammer:  { hp: 60,  speed: 16, dmg: 20, value: 2 },
  gunship: { hp: 140, speed: 6,  dmg: 10, value: 4 },
};
const MIX = { swarm: [["drone", 6], ["fighter", 2], ["rammer", 1]], sniper: [["sniper", 4], ["fighter", 2], ["gunship", 1]], brute: [["gunship", 3], ["rammer", 3], ["fighter", 1]], raider: [["fighter", 5], ["drone", 2], ["rammer", 2]] };
function waves(r, difficulty, faction, budgetK = 1) {
  const budget = Math.round((4 + difficulty * 3) * budgetK), n = clamp(Math.round(1 + difficulty / 3.5), 1, 4);
  const out = []; let left = budget;
  for (let w = 0; w < n; w++) {
    let share = w === n - 1 ? left : Math.round(budget / n * r.range(0.8, 1.2)), enemies = {};
    while (share > 0) { const t = r.weighted(MIX[faction.temper]); enemies[t] = (enemies[t] ?? 0) + 1; share -= ENEMIES[t].value; }
    left = Math.max(0, left - Object.entries(enemies).reduce((s, [t, c]) => s + ENEMIES[t].value * c, 0));
    const scale = 1 + difficulty * 0.12;
    out.push({ at: Math.round(w * r.range(18, 30)), faction: faction.id, enemies: Object.entries(enemies).map(([type, count]) => ({ type, count, hp: Math.round(ENEMIES[type].hp * scale), speed: Math.round(ENEMIES[type].speed * (1 + difficulty * 0.03) * 10) / 10, dmg: Math.round(ENEMIES[type].dmg * scale) })) });
    if (left <= 0) break;
  }
  return out;
}

// ---------------- rewards ----------------
export const RARITY = { common: 1, rare: 1.6, epic: 2.6, legendary: 4.5 };
const SLOTS = { weapon: ["Lance", "Repeater", "Cutter", "Driver", "Arc"], shield: ["Aegis", "Veil", "Bulwark", "Mantle"], engine: ["Drive", "Thruster", "Wake", "Afterburner"], hull: ["Plating", "Frame", "Keel"], paint: ["Livery", "Decal", "Trail"] };
const STAT = { weapon: "damage", shield: "shield", engine: "speed", hull: "hull", paint: null };
function rollRarity(r, intensity) {
  return r.weighted([["common", 60], ["rare", 25 * (1 + intensity)], ["epic", 10 * (1 + 2 * intensity)], ["legendary", 2 * (1 + 6 * intensity * intensity)]]);
}
function loot(r, rarity, motif) {
  const n = { common: r.int(0, 1), rare: 1, epic: r.int(1, 2), legendary: 2 }[rarity];
  return Array.from({ length: n }, () => {
    const slot = r.pick(Object.keys(SLOTS)), stat = STAT[slot];
    const pct = stat ? Math.round(r.range(3, 7) * RARITY[rarity]) : 0;
    return { id: `it-${(r.next() * 2 ** 32) >>> 0}`, slot, rarity, name: `${motif} ${r.pick(SLOTS[slot])}`, stat, pct };
  });
}

// ---------------- signal → mission rules ----------------
// Each rule returns the parts that depend on the event; build() adds waves, difficulty and rewards.
const MOTIF = { crew: ["Homecoming", "Lifeline", "Tether", "Hatch"], moon: ["Farside", "Regolith", "Mare", "Selene"], mars: ["Ares", "Rust", "Tharsis", "Phobos"],
  launch: ["Ascent", "Max-Q", "Staging", "Fairing"], debris: ["Scatter", "Shrapnel", "Wake", "Drift"], telescope: ["Aperture", "Lens", "Parallax", "Exposure"],
  defense: ["Bastion", "Picket", "Sentinel", "Rampart"], satellite: ["Relay", "Lattice", "Uplink", "Mesh"], sun: ["Corona", "Flare", "Helio", "Prominence"],
  asteroid: ["Bolide", "Chondrite", "Impactor", "Tumbler"], none: ["Static", "Echo", "Signal", "Null"] };
const NEWS_ARCH = { crew: "rescue", debris: "salvage", telescope: "recon", defense: "skirmish", moon: "expedition", mars: "expedition", satellite: "relay", sun: "storm-run", asteroid: "intercept", launch: "escort" };
const RULES = {
  flare: (s) => ({ archetype: "storm-run", motif: `${s.cls}`, sector: `${s.cls} Front`, hazard: "radiation",
    objective: { kind: "collect", count: clamp(Math.round(3 + s.level), 3, 9), text: `Recover telemetry buoys between X-ray fronts` },
    hazards: [{ type: "radiation-front", everySec: clamp(Math.round(32 - s.level * 5), 8, 30), power: Math.round(s.level * 10) / 10 }],
    timeLimitSec: Math.round(100 + s.level * 15), fact: `GOES saw a ${s.cls} solar flare`, expires: Date.parse(s.at) + 6 * H, budgetK: 0.6 }),
  geomag: (s, now) => ({ archetype: "aurora-raid", motif: `Kp-${Math.round(s.kp)}`, sector: s.g ? `G${s.g} Storm Belt` : "Ion Shelf", hazard: s.g >= 2 ? "ion-storm" : null,
    objective: { kind: "destroy", text: "Break the raiders riding the geomagnetic storm" },
    hazards: s.g >= 2 ? [{ type: "ion-storm", everySec: clamp(30 - s.g * 4, 10, 30), power: s.g }] : [],
    timeLimitSec: 180, fact: `the planetary K index reached ${s.kp}${s.g ? ` (a G${s.g} storm)` : ""}`, expires: now + 3 * H, budgetK: 1.2 }),
  asteroid: (s) => ({ archetype: "intercept", motif: s.name.split(" ").pop(), sector: `${s.name} Approach`, hazard: "debris",
    objective: { kind: "destroy-target", target: { name: s.name, hp: Math.round(200 + 160 * Math.log10(Math.max(10, s.diameterM))), speed: Math.round(s.kmps * 10) / 10, fragments: s.diameterM > 300 ? 3 : s.diameterM > 100 ? 2 : 0 }, text: `Break up ${s.name} before it clears the sector` },
    hazards: [{ type: "debris-field", everySec: 0, power: Math.round(Math.log10(Math.max(10, s.diameterM)) * 10) / 10 }],
    timeLimitSec: clamp(Math.round(240 - s.kmps * 4), 90, 240), boss: s.hazardous, fact: `${s.name}, about ${s.diameterM} m across, passes ${s.lunar} lunar distances from Earth at ${s.kmps} km/s`, expires: Date.parse(s.at) + 24 * H, budgetK: 0.5 }),
  launch: (s) => s.phase === "aftermath"
    ? ({ archetype: "salvage", motif: s.rocket.split(" ")[0], sector: "Ascent Corridor", hazard: "debris",
      objective: { kind: "collect", count: 5, text: `Sweep the corridor after ${s.payload} went up` },
      hazards: [{ type: "debris-field", everySec: 0, power: 2 }], timeLimitSec: 150, fact: `${s.rocket} launched ${s.payload} ${Math.round(-s.inHours)} h ago`, expires: Date.parse(s.at) + 30 * H, budgetK: 0.7 })
    : ({ archetype: "escort", motif: s.rocket.split(" ")[0], sector: "Ascent Corridor", hazard: null,
      objective: { kind: "protect", target: { name: s.payload, hp: 600 }, durationSec: 150, text: `Keep ${s.payload} alive through ascent` },
      hazards: [], timeLimitSec: 150, countdownTo: s.at, fact: `${s.rocket} is due to launch ${s.payload} in ${s.inHours < 1 ? "under an hour" : `${Math.round(s.inHours)} h`}`, expires: Date.parse(s.at) + 2 * H, budgetK: 1 }),
  iss: (s, now) => ({ archetype: "rendezvous", motif: "Zarya", sector: `Low Orbit ${s.altKm}`, hazard: null,
    objective: { kind: "dock", count: 3, text: "Fly the docking gates and meet the station" },
    hazards: [], timeLimitSec: 120, fact: `the ISS is ${s.altKm} km up over ${s.lat.toFixed(1)}°, ${s.lon.toFixed(1)}°`, expires: now + 20 * 60e3, budgetK: 0.4 }),
  news: (s) => {
    const arch = NEWS_ARCH[s.tags[0]] ?? "patrol";
    // Names come from codes in the headline (Crew-12, SpX-35, Tranche-1…) or a word for the story type, never from a
    // person's name.
    const code = (s.headline.match(/\b[A-Za-z]{2,}-?\d+[A-Za-z]?\b/g) ?? []).find((w) => !/^(19|20)\d\d$/.test(w) && !/^\d/.test(w));
    const word = code ?? new_rng(`motif:${s.id}`).pick(MOTIF[s.tags[0]] ?? MOTIF.none);
    const base = { motif: word, sector: `${word} Reach`, fact: `${s.source} reported: “${s.headline}”`, expires: Date.parse(s.at) + 48 * H };
    return { ...base, ...{
      rescue: { archetype: "rescue", hazard: null, objective: { kind: "collect", count: 4, text: "Pull the escape pods out before they drift" }, hazards: [], timeLimitSec: 150, budgetK: 0.8 },
      salvage: { archetype: "salvage", hazard: "debris", objective: { kind: "collect", count: 6, text: "Recover what's left in the debris cloud" }, hazards: [{ type: "debris-field", everySec: 0, power: 2 }], timeLimitSec: 150, budgetK: 0.7 },
      recon: { archetype: "recon", hazard: null, objective: { kind: "scan", count: 4, text: "Scan the targets without being caught" }, hazards: [], timeLimitSec: 140, budgetK: 0.8 },
      skirmish: { archetype: "skirmish", hazard: null, objective: { kind: "destroy", text: "Take the fight to them" }, hazards: [], timeLimitSec: 180, budgetK: 1.3 },
      expedition: { archetype: "expedition", hazard: null, objective: { kind: "waypoints", count: 4, text: "Reach the far waypoints and hold each one" }, hazards: [], timeLimitSec: 210, budgetK: 1 },
      relay: { archetype: "relay", hazard: null, objective: { kind: "protect", target: { name: "relay array", hp: 400 }, durationSec: 120, text: "Hold the relay array" }, hazards: [], timeLimitSec: 120, budgetK: 1 },
      "storm-run": { archetype: "storm-run", hazard: "radiation", objective: { kind: "collect", count: 4, text: "Recover buoys between fronts" }, hazards: [{ type: "radiation-front", everySec: 20, power: 2 }], timeLimitSec: 130, budgetK: 0.6 },
      intercept: { archetype: "intercept", hazard: "debris", objective: { kind: "destroy-target", target: { name: `${word} rock`, hp: 420, speed: 9, fragments: 2 }, text: "Break it up before it clears the sector" }, hazards: [], timeLimitSec: 180, budgetK: 0.5 },
      escort: { archetype: "escort", hazard: null, objective: { kind: "protect", target: { name: `${word} payload`, hp: 600 }, durationSec: 150, text: "Keep the payload alive through ascent" }, hazards: [], timeLimitSec: 150, budgetK: 1 },
      patrol: { archetype: "patrol", hazard: null, objective: { kind: "destroy", text: "Patrol the lane and clear what you find" }, hazards: [], timeLimitSec: 180, budgetK: 1 },
    }[arch] };
  },
};

// Local bonuses: things that are true about the player's own sky right now.
function bonusesFor(s, rule, sky, now) {
  const b = [];
  if (s.kind === "iss" && sky.issOverhead) b.push({ reason: "The ISS is above your horizon right now", mult: 2 });
  if (s.kind === "geomag" && sky.known && s.kp >= 5 && sky.night && sky.absLat >= 45) b.push({ reason: "Aurora could be visible where you are", mult: 1.5 });
  if (s.kind === "launch" && s.phase === "upcoming" && s.inHours < 24) b.push({ reason: "Launch within 24 hours", mult: 1.3 });
  if (s.kind === "asteroid" && s.hazardous) b.push({ reason: "Potentially hazardous asteroid", mult: 1.5 });
  if (s.kind === "news" && now - Date.parse(s.at) < 3 * H) b.push({ reason: "Breaking news", mult: 1.2 });
  if (s.kind === "flare" && s.level >= 3) b.push({ reason: `${s.level >= 4 ? "X" : "M"}-class flare`, mult: 1.4 });
  return b;
}

function build(s, ctx, r) {
  const rule = RULES[s.kind](s, ctx.now);
  const faction = r.pick(ctx.factions);
  const difficulty = Math.round(clamp(1 + s.intensity * 6 + (ctx.rank - 1) * 0.6 + r.range(-0.7, 0.7), 1, 10) * 10) / 10;
  const rarity = rollRarity(r, s.intensity);
  const bonuses = bonusesFor(s, rule, ctx.sky, ctx.now), mult = bonuses.reduce((m, b) => m * b.mult, 1);
  const w = waves(r, difficulty, faction, rule.budgetK ?? 1);
  const objective = { ...rule.objective };
  if (objective.kind === "destroy") objective.count = w.reduce((n, wv) => n + wv.enemies.reduce((m, e) => m + e.count, 0), 0);
  const credits = Math.round((60 * difficulty ** 1.35 * RARITY[rarity] * mult) / 5) * 5;
  return {
    v: MISSION_VERSION, id: `m-${hash(`${ctx.seed}:${s.id}:${rule.archetype}`).toString(36)}`, seed: ctx.seed, archetype: rule.archetype,
    title: `${rule.archetype.replace("-", " ")} · ${rule.sector}`,
    hook: { kind: s.kind, source: s.source, url: s.url ?? null, at: s.at, headline: s.headline ?? null, fact: rule.fact },
    sector: { name: rule.sector, hazard: rule.hazard, hue: Math.round(r.next() * 360) },
    objective, timeLimitSec: rule.timeLimitSec, countdownTo: rule.countdownTo ?? null, boss: rule.boss ? { type: "gunship", hpK: 4, faction: faction.id } : null,
    hazards: rule.hazards, waves: w, faction: faction.id, difficulty, rarity,
    rewards: { credits, xp: Math.round(25 * difficulty * mult), loot: loot(r.fork("loot"), rarity, rule.motif) },
    bonuses, expiresAt: new Date(Math.max(ctx.now + 15 * 60e3, rule.expires)).toISOString(),
  };
}

// Dead air: no feed answered and nothing cached. Missions come from the seed alone.
function deadAir(ctx, r, n) {
  return Array.from({ length: n }, (_, i) => build({ kind: "news", id: `dead:${i}`, at: new Date(ctx.now).toISOString(), source: "No signal", headline: "The feeds are silent", tags: [r.pick(Object.keys(NEWS_ARCH))], intensity: r.range(0.2, 0.6) }, ctx, r.fork(`dead${i}`)));
}

// signals: from signals.js. player: from geo.locate. sky: from geo.localSky. rank: player rank (1+).
export function generateBoard({ signals = [], player = null, sky = { known: false }, seed, rank = 1, now = Date.now(), count = 4 } = {}) {
  const r = rng(seed);
  const cell = player?.lat == null ? "none" : `${Math.round(player.lat / 5) * 5},${Math.round(player.lon / 5) * 5}`;
  const factions = factionsFor(new Date(now).toISOString().slice(0, 10), cell);
  const ctx = { seed, factions, sky, rank, now };
  // Weight each usable signal by strength, with a little noise; then pick without repeating an archetype
  // (or a source kind) until there's no other choice.
  const usable = signals.filter((s) => RULES[s.kind] && !(s.kind === "geomag" && s.kp < 3));
  const pool = usable.map((s) => ({ s, w: (0.25 + s.intensity) * r.range(0.6, 1.4) * (s.kind === "news" ? 0.8 : 1.2) }));
  const chosen = [], seenArch = new Set(), seenKind = new Map();
  while (chosen.length < count && pool.length) {
    const s = r.weighted(pool.map((p) => [p, p.w / (1 + (seenKind.get(p.s.kind) ?? 0) * 2)])).s;
    pool.splice(pool.findIndex((p) => p.s === s), 1);
    const m = build(s, ctx, r.fork(s.id));
    if (seenArch.has(m.archetype) && pool.some((p) => !seenKind.has(p.s.kind))) continue;
    seenArch.add(m.archetype); seenKind.set(s.kind, (seenKind.get(s.kind) ?? 0) + 1); chosen.push(m);
  }
  if (chosen.length < Math.min(3, count)) chosen.push(...deadAir(ctx, r, Math.min(3, count) - chosen.length));
  return { v: MISSION_VERSION, seed, generatedAt: new Date(now).toISOString(), region: player?.label ?? null, factions, missions: chosen.sort((a, b) => a.difficulty - b.difficulty) };
}
