// Ship sound, synthesised with the Web Audio API (no audio files). Starts on the first user gesture
// (the door button). Ambience: engine hum, air recycler, occasional console chirps. Events and alarms
// are short and rate-limited. Mute and volume are remembered in localStorage.

let ctx = null, master = null, amb = null, sfx = null, klaxonTimer = null;
const last = new Map();
const state = { muted: false, volume: 0.6 };
try { state.muted = localStorage.getItem("soundMuted") === "1"; const v = Number(localStorage.getItem("soundVolume")); if (v > 0) state.volume = v; } catch {}

const db = (d) => Math.pow(10, d / 20);
const TRIM = 0.55; // overall level trim: everything ~5 dB quieter than the slider value

export function soundState() { return { ...state, started: Boolean(ctx) }; }

export function startAudio() {
  if (ctx) { ctx.resume?.(); return; }
  try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return; }
  master = ctx.createGain(); master.gain.value = state.muted ? 0 : state.volume * TRIM; master.connect(ctx.destination);
  amb = ctx.createGain(); amb.gain.value = 0; amb.connect(master);
  sfx = ctx.createGain(); sfx.gain.value = 0.5; sfx.connect(master);
  buildAmbience();
  document.addEventListener("visibilitychange", () => duck(document.hidden));
}

function noiseBuffer(kind = "brown", secs = 4) {
  const b = ctx.createBuffer(1, ctx.sampleRate * secs, ctx.sampleRate), d = b.getChannelData(0);
  let lastOut = 0;
  for (let i = 0; i < d.length; i++) {
    const w = Math.random() * 2 - 1;
    if (kind === "brown") { lastOut = (lastOut + 0.02 * w) / 1.02; d[i] = lastOut * 3.5; } else d[i] = w;
  }
  return b;
}

function buildAmbience() {
  // Engine hum: two detuned oscillators through a lowpass, slow LFO wobble.
  const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 160; lp.Q.value = 0.7;
  const hum = ctx.createGain(); hum.gain.value = db(-35);
  for (const [type, f] of [["sine", 46], ["sawtooth", 46.7], ["sine", 92.3]]) {
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = f;
    const g = ctx.createGain(); g.gain.value = type === "sawtooth" ? 0.25 : f > 80 ? 0.2 : 0.8;
    o.connect(g).connect(lp); o.start();
  }
  const lfo = ctx.createOscillator(); lfo.frequency.value = 0.13; const lfoG = ctx.createGain(); lfoG.gain.value = 25;
  lfo.connect(lfoG).connect(lp.frequency); lfo.start();
  lp.connect(hum).connect(amb);
  // Air recycler: filtered brown noise.
  const n = ctx.createBufferSource(); n.buffer = noiseBuffer("brown", 6); n.loop = true;
  const bp = ctx.createBiquadFilter(); bp.type = "lowpass"; bp.frequency.value = 700;
  const ng = ctx.createGain(); ng.gain.value = db(-34);
  n.connect(bp).connect(ng).connect(amb); n.start();
  // Console chirps every 10-30 s.
  const chirp = () => { if (ctx && !document.hidden) blip(1800 + Math.random() * 900, 0.04, db(-38), "sine", amb); setTimeout(chirp, 10000 + Math.random() * 20000); };
  setTimeout(chirp, 8000);
}

export function ambienceIn(seconds = 3) {
  if (!ctx) return;
  amb.gain.cancelScheduledValues(ctx.currentTime);
  amb.gain.setTargetAtTime(db(-24) / db(-30) * 0.9, ctx.currentTime, seconds / 3);
}
function duck(hidden) { if (ctx) amb.gain.setTargetAtTime(hidden ? 0.15 : 0.9, ctx.currentTime, 0.4); }

export function setMuted(m) { state.muted = m; try { localStorage.setItem("soundMuted", m ? "1" : "0"); } catch {} if (master) master.gain.setTargetAtTime(m ? 0 : state.volume * TRIM, ctx.currentTime, 0.05); }
export function setVolume(v) { state.volume = v; try { localStorage.setItem("soundVolume", String(v)); } catch {} if (master && !state.muted) master.gain.setTargetAtTime(v * TRIM, ctx.currentTime, 0.05); }

function blip(freq, dur, gain = 0.15, type = "sine", out = sfx, at = 0) {
  const t = ctx.currentTime + at;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(out); o.start(t); o.stop(t + dur + 0.05);
  return o;
}
function noiseHit(dur, from, to, gain = 0.2, at = 0, type = "bandpass") {
  const t = ctx.currentTime + at;
  const n = ctx.createBufferSource(); n.buffer = noiseBuffer("white", Math.max(0.5, dur + 0.1));
  const f = ctx.createBiquadFilter(); f.type = type; f.Q.value = 1.2;
  f.frequency.setValueAtTime(from, t); f.frequency.exponentialRampToValueAtTime(to, t + dur);
  const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.04); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  n.connect(f).connect(g).connect(sfx); n.start(t); n.stop(t + dur + 0.1);
}

// Named sounds. Rate-limited per name.
const LIMIT = { ping: 1500, alarm: 4000, laser: 90, explosion: 600, whirr: 1500, rumble: 1500, chime: 1200, press: 0, door: 0, enter: 0, warn: 3000, click: 60 };
// Beeps wait until the board itself is on screen ("enter" fires after the intro), and only
// "needs you" (alarm/warn) and emergencies (klaxon) beep at all.
let uiReady = false, pendingKlaxon = false;
const QUIET = new Set(["ping", "chime", "click", "press"]);
export function play(name) {
  if (name === "enter") { uiReady = true; if (pendingKlaxon) { pendingKlaxon = false; klaxon(true); } }
  if (!ctx || state.muted) return;
  if (!uiReady || QUIET.has(name)) return;
  const now = performance.now();
  if (now - (last.get(name) ?? -1e9) < (LIMIT[name] ?? 500)) return;
  last.set(name, now);
  switch (name) {
    case "press": blip(660, 0.12, 0.06, "sine"); blip(990, 0.16, 0.04, "sine", sfx, 0.05); break;
    case "door": // timed to the video: hiss as the door opens (~2 s), clunk, then the hum fades in
      noiseHit(2.6, 300, 2400, 0.16, 1.9, "bandpass");
      blip(70, 0.35, 0.35, "sine", sfx, 1.85); noiseHit(0.18, 200, 120, 0.3, 1.85, "lowpass");
      noiseHit(0.25, 150, 90, 0.25, 4.6, "lowpass");
      setTimeout(() => ambienceIn(4), 5000);
      break;
    case "enter": ambienceIn(2); break; // hum only, no beep
    case "ping": blip(1046, 0.7, 0.045, "triangle"); blip(1568, 0.6, 0.02, "sine", sfx, 0.02); blip(1046, 0.5, 0.015, "sine", sfx, 0.28); break; // warm two-partial ping with a faint echo
    case "alarm": // question arrival: a quiet sonar ping with a soft echo
      blip(1150, 0.9, 0.06, "sine"); blip(1150, 0.7, 0.025, "sine", sfx, 0.32); blip(1150, 0.5, 0.01, "sine", sfx, 0.64); break;
    case "laser": { const o = blip(1400, 0.12, 0.05, "sawtooth"); o.frequency.exponentialRampToValueAtTime(300, ctx.currentTime + 0.12); break; }
    case "explosion": break; // silent: explosions happen outside the ship, in vacuum
    case "whirr": { const o = blip(180, 1.2, 0.04, "sawtooth"); o.frequency.linearRampToValueAtTime(260, ctx.currentTime + 1.2); break; }
    case "rumble": break; // silent: meteor impacts are outside the ship
    case "chime": [1047, 1319, 1568].forEach((f, i) => blip(f, 0.9, 0.06, "sine", sfx, i * 0.09)); break;
    case "warn": blip(1319, 1.2, 0.05, "sine"); blip(988, 1.4, 0.045, "sine", sfx, 0.2); break; // soft two-note chime
    case "click": { const o = blip(1500, 0.07, 0.03, "sine"); o.frequency.exponentialRampToValueAtTime(950, ctx.currentTime + 0.07); break; } // soft, rounded tick
  }
}

// Critical alert: a soft, low "bridge alert" (rounded tone gliding 440 → 660 Hz, gentle envelope,
// a short feedback-delay reverb, lowpass at 2.5 kHz). Every ~8 s, ~3 dB quieter each time, 6 repeats.
export function klaxon(on) {
  if (!uiReady) { pendingKlaxon = on; return; }
  if (!ctx) return;
  if (on && !klaxonTimer) {
    let n = 0;
    const delay = ctx.createDelay(); delay.delayTime.value = 0.13;
    const fb = ctx.createGain(); fb.gain.value = 0.32;
    const wet = ctx.createGain(); wet.gain.value = 0.35;
    delay.connect(fb).connect(delay); delay.connect(wet).connect(master);
    const sound = () => {
      if (n >= 6) { clearInterval(klaxonTimer); return; }
      if (!state.muted) {
        const t = ctx.currentTime, peak = db(-18) * Math.max(db(-12), Math.pow(db(-3), n));
        const o = ctx.createOscillator(), g = ctx.createGain(), lp = ctx.createBiquadFilter();
        o.type = "triangle"; o.frequency.setValueAtTime(440, t); o.frequency.exponentialRampToValueAtTime(660, t + 0.3);
        lp.type = "lowpass"; lp.frequency.value = 2500;
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + 0.03); g.gain.setValueAtTime(peak, t + 0.3); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
        o.connect(lp).connect(g); g.connect(master); g.connect(delay); o.start(t); o.stop(t + 0.75);
      }
      n++;
    };
    sound(); klaxonTimer = setInterval(sound, 8000);
  } else if (!on && klaxonTimer) { clearInterval(klaxonTimer); klaxonTimer = null; }
}
