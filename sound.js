// Ship sound, synthesised with the Web Audio API (no audio files), designed to be cinematic and restrained:
// sine and filtered-noise sources only (no square or saw waves, no pitch-slide "bloops", no arpeggios), soft
// attacks, exponential releases, a low-pass on everything and a short generated room reverb for alerts.
// A small mixer: master → ambience / UI / alerts / notifications, each with a level and a mute, remembered in
// localStorage. Lasers and explosions are silent (vacuum). Our sounds wait until the board is on screen.

import { host, onHostChange } from "./host.js";

let ctx = null, master = null, verb = null, klaxonTimer = null;
const bus = {};                       // channel gain nodes
const last = new Map();
const state = { muted: false, volume: 0.6, alerts: true };
const CHANNELS = ["ambience", "ui", "alerts", "notify", "intro"];
const mix = Object.fromEntries(CHANNELS.map((c) => [c, { vol: c === "ambience" ? 0.8 : 1, muted: false }]));
try {
  state.muted = localStorage.getItem("soundMuted") === "1"; const v = Number(localStorage.getItem("soundVolume")); if (v > 0) state.volume = v;
  const m = JSON.parse(localStorage.getItem("orbitMixer") || "null"); if (m) for (const c of CHANNELS) if (m[c]) Object.assign(mix[c], m[c]);
  if (localStorage.getItem("soundAlerts") === "0") state.alerts = false;
} catch {}

const db = (d) => Math.pow(10, d / 20);
const TRIM = 0.55; // overall level trim: everything ~5 dB quieter than the slider value

export function soundState() { return { ...state, started: Boolean(ctx), mix: JSON.parse(JSON.stringify(mix)) }; }
export const channels = CHANNELS;
// Effective gain of a channel (0..1), e.g. for the intro video's soundtrack.
export function channelGain(c) { return state.muted || !mix[c] || mix[c].muted ? 0 : state.volume * mix[c].vol; }

export function startAudio() {
  if (ctx) { ctx.resume?.(); return; }
  try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return; }
  master = ctx.createGain(); master.gain.value = state.muted ? 0 : state.volume * TRIM;
  const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 6000; lp.Q.value = 0.5; // nothing harsh gets out
  master.connect(lp).connect(ctx.destination);
  for (const c of CHANNELS) { bus[c] = ctx.createGain(); bus[c].gain.value = chanLevel(c); bus[c].connect(master); }
  bus.ambBed = ctx.createGain(); bus.ambBed.gain.value = 0; bus.ambBed.connect(bus.ambience);
  verb = makeReverb(2.6); verb.out.connect(bus.alerts);
  buildAmbience();
  // A hidden tab ducks the ambience, unless Orbit is floating (then it is still on screen).
  const reduck = () => duck(document.hidden && !host.mode);
  document.addEventListener("visibilitychange", reduck);
  onHostChange(reduck);
}
const chanLevel = (c) => (mix[c].muted ? 0 : mix[c].vol);
function saveMix() { try { localStorage.setItem("orbitMixer", JSON.stringify(mix)); } catch {} }
export function setChannel(c, { vol, muted } = {}) {
  if (!mix[c]) return;
  if (vol != null) mix[c].vol = Math.max(0, Math.min(1, vol));
  if (muted != null) mix[c].muted = !!muted;
  saveMix();
  if (ctx && bus[c]) bus[c].gain.setTargetAtTime(chanLevel(c), ctx.currentTime, 0.08);
}
export function setAlertsEnabled(on) { state.alerts = !!on; try { localStorage.setItem("soundAlerts", on ? "1" : "0"); } catch {} if (!on) klaxon(false); }

// A small generated room: decaying, low-passed stereo noise as the impulse response.
function makeReverb(secs) {
  const n = Math.floor(ctx.sampleRate * secs), ir = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); let lp = 0; for (let i = 0; i < n; i++) { lp += ((Math.random() * 2 - 1) - lp) * 0.22; d[i] = lp * Math.pow(1 - i / n, 3.2); } }
  const conv = ctx.createConvolver(); conv.buffer = ir;
  const inp = ctx.createGain(), out = ctx.createGain(); out.gain.value = 0.55;
  inp.connect(conv).connect(out);
  return { in: inp, out };
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

// Ship ambience: a deep, filtered noise bed with a slow random drift of its colour (no LFO wobble), and a very
// low, steady sine for weight. No chirps.
function buildAmbience() {
  const n = ctx.createBufferSource(); n.buffer = noiseBuffer("brown", 8); n.loop = true;
  const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 220; lp.Q.value = 0.4;
  const bed = ctx.createGain(); bed.gain.value = db(-26);
  n.connect(lp).connect(bed).connect(bus.ambBed); n.start();
  const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = 43;
  const og = ctx.createGain(); og.gain.value = db(-40);
  const olp = ctx.createBiquadFilter(); olp.type = "lowpass"; olp.frequency.value = 120;
  o.connect(olp).connect(og).connect(bus.ambBed); o.start();
  const drift = () => { if (!ctx) return; lp.frequency.setTargetAtTime(180 + Math.random() * 90, ctx.currentTime, 6); bed.gain.setTargetAtTime(db(-27 + Math.random() * 2), ctx.currentTime, 8); setTimeout(drift, 9000 + Math.random() * 9000); };
  drift();
}

export function ambienceIn(seconds = 3) {
  if (!ctx) return;
  bus.ambBed.gain.cancelScheduledValues(ctx.currentTime);
  bus.ambBed.gain.setTargetAtTime(0.9, ctx.currentTime, seconds / 3);
}
function duck(hidden) { if (ctx) bus.ambBed.gain.setTargetAtTime(hidden ? 0.15 : 0.9, ctx.currentTime, 0.4); }

export function setMuted(m) { state.muted = m; try { localStorage.setItem("soundMuted", m ? "1" : "0"); } catch {} if (master) master.gain.setTargetAtTime(m ? 0 : state.volume * TRIM, ctx.currentTime, 0.05); }
export function setVolume(v) { state.volume = v; try { localStorage.setItem("soundVolume", String(v)); } catch {} if (master && !state.muted) master.gain.setTargetAtTime(v * TRIM, ctx.currentTime, 0.05); }

// A soft sine note: attack, then exponential release; optional send to the reverb.
function tone(freq, { dur = 1.2, gain = 0.05, attack = 0.04, out = bus.ui, at = 0, wet = 0, cutoff = 1800 } = {}) {
  const t = ctx.currentTime + at;
  const o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter();
  o.type = "sine"; o.frequency.setValueAtTime(freq, t);
  f.type = "lowpass"; f.frequency.value = cutoff;
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(f).connect(g).connect(out);
  if (wet > 0) { const s = ctx.createGain(); s.gain.value = wet; g.connect(s).connect(verb.in); }
  o.start(t); o.stop(t + dur + 0.05);
}
// A felt-like transient: a short burst of low-passed noise with a low sine body ("thock").
function thock({ gain = 0.05, cutoff = 900, body = 170, out = bus.ui, at = 0 } = {}) {
  const t = ctx.currentTime + at;
  const n = ctx.createBufferSource(); n.buffer = noiseBuffer("white", 0.2);
  const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = cutoff; f.Q.value = 0.6;
  const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
  n.connect(f).connect(g).connect(out); n.start(t); n.stop(t + 0.1);
  tone(body, { dur: 0.09, gain: gain * 0.7, attack: 0.003, out, at, cutoff: 600 });
}
function noiseSwell(dur, cutoff, gain, out, at = 0) {
  const t = ctx.currentTime + at;
  const n = ctx.createBufferSource(); n.buffer = noiseBuffer("brown", Math.max(1, dur + 0.2));
  const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = cutoff;
  const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + dur * 0.4); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  n.connect(f).connect(g).connect(out); n.start(t); n.stop(t + dur + 0.1);
}
function noiseHit(dur, from, to, gain = 0.2, at = 0, type = "bandpass") {
  const t = ctx.currentTime + at;
  const n = ctx.createBufferSource(); n.buffer = noiseBuffer("white", Math.max(0.5, dur + 0.1));
  const f = ctx.createBiquadFilter(); f.type = type; f.Q.value = 1.2;
  f.frequency.setValueAtTime(from, t); f.frequency.exponentialRampToValueAtTime(to, t + dur);
  const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.04); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  n.connect(f).connect(g).connect(bus.ui); n.start(t); n.stop(t + dur + 0.1);
}
// Alerts: a calm, low two-tone sonar with a soft attack and a long reverb tail; `urgent` is the same family,
// a step higher and a touch firmer.
function sonar(urgent = false, level = 1) {
  const a = urgent ? 587 : 523, b = urgent ? 440 : 392;
  tone(a, { dur: 1.6, gain: 0.05 * level, attack: 0.05, out: bus.alerts, wet: 0.6, cutoff: 1400 });
  tone(b, { dur: 2.0, gain: 0.045 * level, attack: 0.06, out: bus.alerts, wet: 0.6, cutoff: 1200, at: urgent ? 0.28 : 0.36 });
}

// Named sounds. Rate-limited per name.
const LIMIT = { ping: 1500, alarm: 4000, laser: 90, explosion: 600, whirr: 1500, rumble: 1500, chime: 1200, press: 0, door: 0, enter: 0, warn: 3000, click: 60 };
// Sounds wait until the board itself is on screen ("enter" fires after the intro), and only "needs you"
// (alarm/warn) and emergencies (klaxon) sound at all; the quiet set stays silent.
let uiReady = false, pendingKlaxon = false;
const QUIET = new Set(["ping", "chime", "click", "press"]);
export function play(name) {
  if (name === "enter") { uiReady = true; if (pendingKlaxon) { pendingKlaxon = false; klaxon(true); } }
  if (!ctx || state.muted) return;
  if (!uiReady || QUIET.has(name)) return;
  if ((name === "alarm" || name === "warn") && !state.alerts) return;
  const now = performance.now();
  if (now - (last.get(name) ?? -1e9) < (LIMIT[name] ?? 500)) return;
  last.set(name, now);
  switch (name) {
    case "press": thock({ gain: 0.04 }); break;
    case "click": thock({ gain: 0.03, cutoff: 1100, body: 190 }); break;
    case "door": // timed to the video: a soft hiss as the door opens (~2 s), a low thud, then the bed fades in
      noiseHit(2.6, 300, 1800, 0.12, 1.9, "bandpass");
      tone(70, { dur: 0.4, gain: 0.3, attack: 0.01, at: 1.85, cutoff: 200 }); noiseHit(0.18, 200, 120, 0.25, 1.85, "lowpass");
      noiseHit(0.25, 150, 90, 0.2, 4.6, "lowpass");
      setTimeout(() => ambienceIn(4), 5000);
      break;
    case "enter": ambienceIn(2); break; // the bed only
    case "ping": tone(660, { dur: 0.9, gain: 0.03, out: bus.notify, wet: 0.3, cutoff: 1500 }); break;
    case "alarm": sonar(false); break;           // a question arrives: calm, low, two-tone
    case "warn": sonar(false, 0.8); break;
    case "laser": break;                          // silent (vacuum)
    case "explosion": break;                      // silent (vacuum)
    case "rumble": break;                         // silent
    case "whirr": noiseSwell(1.1, 420, 0.03, bus.ui); break; // a craft leaves: a faint, low air swell
    case "chime": tone(784, { dur: 1.4, gain: 0.03, out: bus.notify, wet: 0.4 }); tone(1047, { dur: 1.6, gain: 0.02, out: bus.notify, wet: 0.4, at: 0.12 }); break;
  }
}
// Preview a channel at its current level (settings panel).
export function preview(c) {
  startAudio(); if (!ctx) return;
  if (c === "ui") thock({ gain: 0.05 });
  else if (c === "alerts") sonar(false);
  else if (c === "notify") tone(660, { dur: 0.9, gain: 0.04, out: bus.notify, wet: 0.3 });
  else if (c === "ambience") { bus.ambBed.gain.setTargetAtTime(0.9, ctx.currentTime, 0.3); }
}

// Critical alert: the same sonar family, slightly more urgent, every ~8 s, ~3 dB quieter each time, 6 repeats.
export function klaxon(on) {
  if (!uiReady) { pendingKlaxon = on; return; }
  if (!ctx) return;
  if (on && !state.alerts) return;
  if (on && !klaxonTimer) {
    let n = 0;
    const sound = () => {
      if (n >= 6) { clearInterval(klaxonTimer); return; }
      if (!state.muted) sonar(true, Math.max(db(-12), Math.pow(db(-3), n)));
      n++;
    };
    sound(); klaxonTimer = setInterval(sound, 8000);
  } else if (!on && klaxonTimer) { clearInterval(klaxonTimer); klaxonTimer = null; }
}
