// Seeded randomness for the game: the same seed always builds the same missions (so a bug can be replayed),
// and a fresh seed comes from crypto, so nobody (player or author) knows the next one in advance.

export function hash(s) { // FNV-1a, 32 bit
  let h = 0x811c9dc5;
  for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

export function freshSeed() {
  try { return crypto.getRandomValues(new Uint32Array(1))[0]; } catch { return (Math.random() * 2 ** 32) >>> 0; }
}

// mulberry32 plus the helpers the generators need.
export function rng(seed) {
  const seed0 = (typeof seed === "number" ? seed : hash(seed)) >>> 0;
  let a = seed0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const r = {
    next,
    range: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    weighted(list) { // [[item, weight], ...]
      const total = list.reduce((s, [, w]) => s + Math.max(0, w), 0); if (total <= 0) return list[0]?.[0];
      let x = next() * total; for (const [it, w] of list) { x -= Math.max(0, w); if (x < 0) return it; } return list[list.length - 1][0];
    },
    shuffle(arr) { const a2 = [...arr]; for (let i = a2.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [a2[i], a2[j]] = [a2[j], a2[i]]; } return a2; },
    fork: (label) => rng(hash(`${seed0}:${label}`)), // an independent stream, so adding a roll in one place doesn't shift every other
  };
  return r;
}
