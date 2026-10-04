// Title-page music: a slow, spacey lo-fi hip-hop loop synthesised with the Web Audio API (no audio
// files). 84 bpm, swung hats, soft kick and snare, Rhodes-like 7th chords, a round bass and a little
// vinyl crackle, all under a gentle lowpass. Browsers only allow audio after a user gesture, so
// start() is called from the first tap or key on the title screen. stop() fades it out.

let ctx = null, out = null, timer = null, nextT = 0, step = 0, crackle = null;
const BPM = 84, STEP = 60 / BPM / 4; // sixteenth notes
// Fmaj7 – Em7 – Dm7 – Cmaj9, one bar each (MIDI notes)
const CHORDS = [[53, 57, 60, 64], [52, 55, 59, 62], [50, 53, 57, 60], [48, 52, 55, 59, 62]];
const BASS = [41, 40, 38, 36];
const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);

function muted() { try { return localStorage.getItem("soundMuted") === "1"; } catch { return false; } }

function noise(secs) {
  const b = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * secs), ctx.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}
const NOISE = () => (NOISE.b ??= noise(1));

function env(g, t, a, peak, d) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
}

function kick(t) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.18);
  env(g, t, 0.004, 0.9, 0.42); o.connect(g).connect(out); o.start(t); o.stop(t + 0.5);
}
function snare(t) {
  const n = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
  n.buffer = NOISE(); f.type = "bandpass"; f.frequency.value = 1900; f.Q.value = 0.8;
  env(g, t, 0.003, 0.32, 0.2); n.connect(f).connect(g).connect(out); n.start(t); n.stop(t + 0.3);
  const o = ctx.createOscillator(), og = ctx.createGain(); o.frequency.value = 185;
  env(og, t, 0.003, 0.18, 0.12); o.connect(og).connect(out); o.start(t); o.stop(t + 0.2);
}
function hat(t, v) {
  const n = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
  n.buffer = NOISE(); f.type = "highpass"; f.frequency.value = 7000;
  env(g, t, 0.002, v, 0.05); n.connect(f).connect(g).connect(out); n.start(t); n.stop(t + 0.08);
}
function chord(t, notes, len) {
  for (const m of notes) {
    for (const [type, detune, lvl] of [["sine", 0, 0.05], ["triangle", 7, 0.018]]) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type; o.frequency.value = hz(m); o.detune.value = detune;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(lvl, t + 0.03);
      g.gain.exponentialRampToValueAtTime(lvl * 0.35, t + 0.6);
      g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      o.connect(g).connect(out); o.start(t); o.stop(t + len + 0.05);
    }
  }
}
function bass(t, m, len) {
  const o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter();
  o.type = "triangle"; o.frequency.value = hz(m); f.type = "lowpass"; f.frequency.value = 400;
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.32, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  o.connect(f).connect(g).connect(out); o.start(t); o.stop(t + len + 0.05);
}

function schedule() {
  while (nextT < ctx.currentTime + 0.25) {
    const s = step % 16, bar = Math.floor(step / 16) % 4;
    const swing = s % 2 ? STEP * 0.18 : 0, t = nextT + swing;
    if (s === 0 || s === 10 || (s === 7 && bar % 2)) kick(t);
    if (s === 4 || s === 12) snare(t);
    if (s % 2 === 0 || (s === 15 && bar === 3)) hat(t, s % 4 === 0 ? 0.06 : 0.035);
    if (s === 0) { chord(t, CHORDS[bar], STEP * 15); bass(t, BASS[bar], STEP * 6); }
    if (s === 8) bass(t, BASS[bar] + (bar === 3 ? 7 : 0), STEP * 5);
    nextT += STEP; step++;
  }
}

export function startMusic() {
  if (muted()) return;
  if (ctx) { ctx.resume?.(); return; }
  try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return; }
  const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 3200; lp.Q.value = 0.4;
  out = ctx.createGain(); out.gain.setValueAtTime(0.0001, ctx.currentTime); out.gain.exponentialRampToValueAtTime(0.22, ctx.currentTime + 2.5);
  out.connect(lp).connect(ctx.destination);
  // vinyl crackle
  crackle = ctx.createBufferSource(); crackle.buffer = (() => {
    const b = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() < 0.0009 ? (Math.random() * 2 - 1) * 0.6 : (Math.random() * 2 - 1) * 0.004;
    return b;
  })();
  crackle.loop = true; const cg = ctx.createGain(); cg.gain.value = 0.5; crackle.connect(cg).connect(out); crackle.start();
  nextT = ctx.currentTime + 0.1; step = 0;
  timer = setInterval(schedule, 60); schedule();
}

export function stopMusic(fade = 1.2) {
  if (!ctx) return;
  const c = ctx, o = out, t = c.currentTime;
  o.gain.cancelScheduledValues(t); o.gain.setValueAtTime(Math.max(0.0001, o.gain.value), t); o.gain.exponentialRampToValueAtTime(0.0001, t + fade);
  clearInterval(timer); timer = null; ctx = null; out = null;
  setTimeout(() => c.close?.(), fade * 1000 + 200);
}
