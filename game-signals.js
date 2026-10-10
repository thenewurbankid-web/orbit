// Live space data → signals: small, plain facts the Director turns into missions. Every source is fetched
// straight from the page (all of them allow cross-origin reads), cached with its own lifetime, and falls back
// to the last good copy of any age when offline or rate-limited. NASA's DEMO_KEY allows about 10 calls an
// hour per address, so the asteroid feed is cached for 3 hours.
//
// Signal: { kind, id, at, intensity 0..1, source, url?, ...facts }

const day = (t) => new Date(t).toISOString().slice(0, 10);
export const SOURCES = {
  news:     { ttlMin: 30,  name: "Spaceflight News",      url: () => "https://api.spaceflightnewsapi.net/v4/articles/?limit=12" },
  launches: { ttlMin: 60,  name: "Launch Library 2",      url: () => "https://ll.thespacedevs.com/2.3.0/launches/upcoming/?limit=8&mode=list" },
  neo:      { ttlMin: 180, name: "NASA NeoWs",            url: (now) => `https://api.nasa.gov/neo/rest/v1/feed?start_date=${day(now)}&end_date=${day(now)}&api_key=DEMO_KEY` },
  iss:      { ttlMin: 1,   name: "Where the ISS at?",     url: () => "https://api.wheretheiss.at/v1/satellites/25544" },
  flares:   { ttlMin: 10,  name: "NOAA SWPC (GOES X-ray)", url: () => "https://services.swpc.noaa.gov/json/goes/primary/xray-flares-latest.json" },
  kp:       { ttlMin: 30,  name: "NOAA SWPC (planetary K)", url: () => "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json" },
};

// ---------------- normalising ----------------
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const TAGS = [
  ["crew", /astronaut|cosmonaut|crew|space station|\biss\b|spacewalk/i],
  ["moon", /\bmoon\b|lunar|artemis/i],
  ["mars", /\bmars\b|martian/i],
  ["launch", /launch|liftoff|lift-off|falcon|rocket|booster|starship/i],
  ["debris", /debris|space junk|reentry|re-entry|breakup/i],
  ["telescope", /telescope|webb|hubble|\bapod\b|image|galaxy|nebula/i],
  ["sun", /\bsun\b|solar|flare|coronal/i],
  ["asteroid", /asteroid|comet|meteor/i],
  ["defense", /defen[cs]e|warfighter|military|space force|missile/i],
  ["satellite", /satellite|constellation|starlink|kuiper/i],
];
export const tagsOf = (text) => TAGS.filter(([, re]) => re.test(text)).map(([t]) => t);

export function normNews(j, now = Date.now()) {
  return (j?.results ?? []).map((a) => {
    const ageH = (now - Date.parse(a.published_at)) / 3600e3;
    return { kind: "news", id: `news:${a.id}`, at: a.published_at, source: a.news_site, url: a.url,
      headline: a.title, summary: a.summary ?? "", tags: tagsOf(`${a.title} ${a.summary ?? ""}`),
      intensity: clamp01(0.35 + 0.65 * Math.exp(-Math.max(0, ageH) / 24)) }; // fresher news hits harder
  });
}

// Upcoming launches within a week (closer = stronger); one that flew in the last day becomes an aftermath.
export function normLaunches(j, now = Date.now()) {
  const out = [];
  for (const l of j?.results ?? []) {
    const inH = (Date.parse(l.net) - now) / 3600e3, status = l.status?.abbrev ?? "";
    const [rocket, payload] = String(l.name).split(" | ");
    if (inH >= -24 && inH < 0 && /success/i.test(status)) out.push({ kind: "launch", id: `launch:${l.id}`, at: l.net, source: SOURCES.launches.name, url: l.url, rocket, payload: payload ?? rocket, inHours: inH, phase: "aftermath", intensity: 0.45 });
    else if (inH >= 0 && inH <= 168 && !/fail|success/i.test(status)) out.push({ kind: "launch", id: `launch:${l.id}`, at: l.net, source: SOURCES.launches.name, url: l.url, rocket, payload: payload ?? rocket, inHours: inH, phase: "upcoming", status, intensity: clamp01(1 - inH / 168) * 0.7 + 0.3 });
  }
  return out;
}

export function normNeo(j) {
  const out = [];
  for (const list of Object.values(j?.near_earth_objects ?? {})) for (const n of list) {
    const ca = n.close_approach_data?.[0]; if (!ca) continue;
    const d = n.estimated_diameter?.meters ?? {}, diameterM = ((d.estimated_diameter_min ?? 0) + (d.estimated_diameter_max ?? 0)) / 2;
    const lunar = Number(ca.miss_distance?.lunar), kmps = Number(ca.relative_velocity?.kilometers_per_second);
    const hazardous = !!n.is_potentially_hazardous_asteroid;
    // big, close, fast and hazardous all push it up
    const intensity = clamp01(0.15 * Math.log10(Math.max(10, diameterM)) + 0.25 * clamp01(1 - lunar / 150) + 0.15 * clamp01(kmps / 30) + (hazardous ? 0.3 : 0));
    out.push({ kind: "asteroid", id: `neo:${n.id}`, at: new Date(ca.epoch_date_close_approach).toISOString(), source: SOURCES.neo.name, url: n.nasa_jpl_url,
      name: String(n.name).replace(/[()]/g, ""), diameterM: Math.round(diameterM), lunar: Math.round(lunar * 10) / 10, kmps: Math.round(kmps * 10) / 10, hazardous, intensity });
  }
  return out;
}

export function normIss(j) {
  if (j?.latitude == null) return [];
  return [{ kind: "iss", id: "iss", at: new Date((j.timestamp ?? Date.now() / 1000) * 1000).toISOString(), source: SOURCES.iss.name, url: "https://wheretheiss.at",
    lat: j.latitude, lon: j.longitude, altKm: Math.round(j.altitude), footprintKm: Math.round(j.footprint ?? 4500), sunlit: j.visibility === "daylight", intensity: 0.4 }];
}

// GOES X-ray class: A1 = 1e-8 W/m², each letter ×10. Level 0 (A) … 4 (X); X10+ goes past 4.
export function flareLevel(cls) {
  const m = /^([ABCMX])(\d+(?:\.\d+)?)/.exec(String(cls ?? "")); if (!m) return null;
  return "ABCMX".indexOf(m[1]) + Math.log10(Math.max(1, Number(m[2])));
}
export function normFlares(j) {
  const f = Array.isArray(j) ? j[0] : null; if (!f) return [];
  const cls = f.max_class ?? f.current_class, lvl = flareLevel(cls); if (lvl == null) return [];
  return [{ kind: "flare", id: `flare:${f.max_time ?? f.time_tag}`, at: f.max_time ?? f.time_tag, source: SOURCES.flares.name, url: "https://www.swpc.noaa.gov/products/goes-x-ray-flux",
    cls, level: Math.round(lvl * 100) / 100, intensity: clamp01((lvl - 1.5) / 3) }]; // C-class ≈ 0.2, M ≈ 0.5, X ≈ 0.85+
}

// Planetary K index: the latest reading and the peak of the last 24 h. Kp 5 = G1 storm … Kp 9 = G5.
export function normKp(j, now = Date.now()) {
  const rows = (Array.isArray(j) ? j : []).map((r) => (Array.isArray(r) ? { time_tag: r[0], Kp: Number(r[1]) } : r)).filter((r) => Number.isFinite(Number(r.Kp)));
  if (!rows.length) return [];
  const recent = rows.filter((r) => now - Date.parse(r.time_tag + (/Z$/.test(r.time_tag) ? "" : "Z")) < 24 * 3600e3);
  const last = rows[rows.length - 1], peak = (recent.length ? recent : [last]).reduce((a, r) => (Number(r.Kp) > Number(a.Kp) ? r : a));
  const kp = Number(peak.Kp);
  return [{ kind: "geomag", id: `kp:${peak.time_tag}`, at: new Date(Date.parse(peak.time_tag + (/Z$/.test(peak.time_tag) ? "" : "Z"))).toISOString(), source: SOURCES.kp.name, url: "https://www.swpc.noaa.gov/products/planetary-k-index",
    kp: Math.round(kp * 100) / 100, now: Number(last.Kp), g: Math.max(0, Math.min(5, Math.floor(kp) - 4)), intensity: clamp01((kp - 2) / 7) }];
}

const NORM = { news: normNews, launches: normLaunches, neo: normNeo, iss: normIss, flares: normFlares, kp: normKp };
export function signalsFrom(raw, now = Date.now()) {
  const out = [];
  for (const [k, f] of Object.entries(NORM)) if (raw[k] != null) { try { out.push(...f(raw[k], now)); } catch (e) { console.warn("[game] bad", k, e); } }
  return out;
}

// ---------------- fetching with a cache ----------------
// store: anything with getItem/setItem (localStorage). Never throws; reports what was live, cached or missing.
export async function gatherSignals({ fetchFn = globalThis.fetch, store = globalThis.localStorage, now = Date.now(), timeoutMs = 8000 } = {}) {
  const raw = {}, report = { live: [], cached: [], missing: [] };
  const read = (k) => { try { return JSON.parse(store?.getItem("orbit.game.feed." + k) ?? "null"); } catch { return null; } };
  const write = (k, v) => { try { store?.setItem("orbit.game.feed." + k, JSON.stringify({ at: now, data: v })); } catch {} };
  await Promise.all(Object.entries(SOURCES).map(async ([k, s]) => {
    const c = read(k);
    if (c && now - c.at < s.ttlMin * 60e3) { raw[k] = c.data; report.cached.push(k); return; }
    try {
      const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const t = ctl && setTimeout(() => ctl.abort(), timeoutMs);
      const r = await fetchFn(s.url(now), { signal: ctl?.signal, headers: { Accept: "application/json" } }).finally(() => clearTimeout(t));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      raw[k] = await r.json(); write(k, raw[k]); report.live.push(k);
    } catch {
      if (c) { raw[k] = c.data; report.cached.push(k); } else report.missing.push(k);
    }
  }));
  return { signals: signalsFrom(raw, now), report };
}
