// Where the player is, coarsely, and what that means for the sky above them. Location is only asked for when
// the player opts in; it is rounded to 0.5° (~50 km) before anything uses it and never leaves the page.
// Without it, the time zone gives a rough region, and without that, the game picks nothing local.

const R = 6371;
const rad = (d) => (d * Math.PI) / 180;
export function distanceKm(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
const coarse = (x) => Math.round(x * 2) / 2;

// Rough centres for common time zones (the fallback when location is declined).
const TZ = {
  "America/New_York": [40.7, -74], "America/Chicago": [41.9, -87.6], "America/Denver": [39.7, -105], "America/Los_Angeles": [34, -118.2],
  "America/Phoenix": [33.4, -112], "America/Anchorage": [61.2, -149.9], "Pacific/Honolulu": [21.3, -157.8], "America/Toronto": [43.7, -79.4],
  "America/Vancouver": [49.3, -123.1], "America/Mexico_City": [19.4, -99.1], "America/Sao_Paulo": [-23.5, -46.6], "America/Argentina/Buenos_Aires": [-34.6, -58.4],
  "America/Bogota": [4.7, -74.1], "America/Lima": [-12, -77], "America/Santiago": [-33.4, -70.6], "Europe/London": [51.5, -0.1], "Europe/Dublin": [53.3, -6.3],
  "Europe/Paris": [48.9, 2.4], "Europe/Berlin": [52.5, 13.4], "Europe/Madrid": [40.4, -3.7], "Europe/Rome": [41.9, 12.5], "Europe/Amsterdam": [52.4, 4.9],
  "Europe/Stockholm": [59.3, 18.1], "Europe/Oslo": [59.9, 10.8], "Europe/Helsinki": [60.2, 24.9], "Europe/Warsaw": [52.2, 21], "Europe/Athens": [38, 23.7],
  "Europe/Istanbul": [41, 29], "Europe/Moscow": [55.8, 37.6], "Africa/Cairo": [30, 31.2], "Africa/Lagos": [6.5, 3.4], "Africa/Nairobi": [-1.3, 36.8],
  "Africa/Johannesburg": [-26.2, 28], "Asia/Dubai": [25.2, 55.3], "Asia/Karachi": [24.9, 67], "Asia/Kolkata": [19.1, 72.9], "Asia/Calcutta": [19.1, 72.9],
  "Asia/Dhaka": [23.8, 90.4], "Asia/Bangkok": [13.8, 100.5], "Asia/Jakarta": [-6.2, 106.8], "Asia/Singapore": [1.35, 103.8], "Asia/Shanghai": [31.2, 121.5],
  "Asia/Hong_Kong": [22.3, 114.2], "Asia/Taipei": [25, 121.5], "Asia/Seoul": [37.6, 127], "Asia/Tokyo": [35.7, 139.7], "Australia/Perth": [-31.95, 115.9],
  "Australia/Sydney": [-33.9, 151.2], "Australia/Melbourne": [-37.8, 145], "Australia/Brisbane": [-27.5, 153], "Pacific/Auckland": [-36.85, 174.8],
};

// geolocation: navigator.geolocation (or null to skip asking). Resolves within ~8 s, never rejects.
export function locate({ geolocation = null, timeZone = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ""; } })() } = {}) {
  const fromTz = () => {
    const c = TZ[timeZone];
    return c ? { lat: c[0], lon: c[1], source: "timezone", label: timeZone.split("/").pop().replace(/_/g, " ") } : { lat: null, lon: null, source: "none", label: "deep space" };
  };
  if (!geolocation) return Promise.resolve(fromTz());
  return new Promise((res) => {
    const done = (v) => { clearTimeout(t); res(v); };
    const t = setTimeout(() => done(fromTz()), 8000);
    try {
      geolocation.getCurrentPosition(
        (p) => done({ lat: coarse(p.coords.latitude), lon: coarse(p.coords.longitude), source: "gps", label: `${Math.abs(coarse(p.coords.latitude))}°${p.coords.latitude >= 0 ? "N" : "S"} ${Math.abs(coarse(p.coords.longitude))}°${p.coords.longitude >= 0 ? "E" : "W"}` }),
        () => done(fromTz()),
        { enableHighAccuracy: false, maximumAge: 3600e3, timeout: 7000 },
      );
    } catch { done(fromTz()); }
  });
}

// Subsolar point (no equation of time; good to ~1°): where the Sun is straight overhead.
export function subsolar(now = Date.now()) {
  const d = new Date(now), start = Date.UTC(d.getUTCFullYear(), 0, 0), doy = (now - start) / 86400e3;
  const lat = -23.44 * Math.cos(((2 * Math.PI) / 365) * (doy + 10));
  const utcH = d.getUTCHours() + d.getUTCMinutes() / 60;
  let lon = (12 - utcH) * 15; if (lon > 180) lon -= 360; if (lon < -180) lon += 360;
  return { lat, lon };
}

// What the player's sky holds right now: night or day, how far the ISS is, whether it's within its footprint
// (above the horizon for them), and how far north/south they are (aurora odds).
export function localSky(player, { iss = null, now = Date.now() } = {}) {
  if (player?.lat == null) return { known: false, night: null, issKm: null, issOverhead: false, absLat: null };
  const sun = subsolar(now);
  const night = distanceKm(player, sun) > (Math.PI / 2) * R;
  const issKm = iss ? Math.round(distanceKm(player, iss)) : null;
  return { known: true, night, issKm, issOverhead: iss ? issKm < (iss.footprintKm ?? 4500) / 2 : false, absLat: Math.abs(player.lat) };
}
