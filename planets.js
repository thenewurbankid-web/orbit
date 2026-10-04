// Procedural planet surfaces, rendered once on the GPU into equirectangular textures:
// colour map, normal map (from the same height field) and, for the ocean world, a cloud map.
// No downloads. Matte materials; the sun does the work.
import * as THREE from "three";

const common = `
float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 7; i++) { s += a * noise(p); p = p * 2.02 + 17.1; a *= 0.5; } return s; }
float ridged(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 6; i++) { float n = 1.0 - abs(noise(p) * 2.0 - 1.0); s += a * n * n; p = p * 2.03 + 9.7; a *= 0.5; } return s; }
// Craters: one per cell of a 3D grid, raised rim and a bowl.
float craters(vec3 p, float scale, float density) {
  vec3 q = p * scale; vec3 i = floor(q); float h = 0.0;
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec3 c = i + vec3(x, y, z);
    if (hash(c + 3.1) > density) continue;
    vec3 ctr = c + vec3(hash(c), hash(c + 1.7), hash(c + 4.3));
    float r = 0.18 + 0.32 * hash(c + 8.9);
    float d = length(q - ctr) / r;
    h += d < 1.0 ? (d * d - 1.0) * 0.6 : exp(-(d - 1.0) * (d - 1.0) * 18.0) * 0.25;
  }
  return h;
}
vec3 dirFromUv(vec2 uv) {
  float lon = (uv.x - 0.5) * 6.2831853, lat = (uv.y - 0.5) * 3.1415927;
  return vec3(cos(lat) * sin(lon), sin(lat), cos(lat) * cos(lon));
}
uniform float uSeed; uniform int uKind; uniform vec2 uTexel;
// Height in 0..1 for a direction.
float height(vec3 d) {
  vec3 p = d * 1.4 + uSeed; // low frequency: reads as terrain, not metal
  if (uKind == 0) { // desert world: ridged highlands, basins, many craters
    float h = fbm(p * 1.1) * 0.65 + ridged(p * 2.4) * 0.3;
    h += craters(d, 4.5, 0.35) * 0.06 + craters(d, 11.0, 0.3) * 0.02;
    return h;
  }
  if (uKind == 1) { // rocky world: rough terrain, heavy cratering
    float h = fbm(p * 1.6) * 0.55 + ridged(p * 3.1) * 0.25;
    h += craters(d, 4.0, 0.45) * 0.07 + craters(d, 10.0, 0.4) * 0.025;
    return h;
  }
  if (uKind == 2) { // ocean world: continents
    float h = fbm(p * 0.9) * 0.8 + ridged(p * 3.5) * 0.18;
    return h;
  }
  // moon
  return fbm(p * 1.4) * 0.35 + craters(d, 5.0, 0.6) * 0.12 + craters(d, 13.0, 0.55) * 0.05 + craters(d, 31.0, 0.5) * 0.02;
}
vec3 lin(vec3 c) { return pow(c, vec3(2.2)); }
`;

const colorFrag = `${common}
varying vec2 vUv;
void main() {
  vec3 d = dirFromUv(vUv);
  float h = height(d);
  float lat = abs(d.y);
  vec3 c;
  if (uKind == 0) {
    float t = smoothstep(0.35, 0.8, h);
    c = mix(vec3(0.71, 0.40, 0.23), vec3(0.85, 0.63, 0.40), t);                               // #b5653a → #d9a066
    c = mix(c, vec3(0.45, 0.24, 0.15), smoothstep(0.58, 0.78, fbm(d * 3.0 + uSeed)) * 0.45);  // darker basalt plains
    c = mix(c, vec3(0.95, 0.92, 0.88), smoothstep(0.9, 0.97, lat) * 0.9);                     // polar caps
  } else if (uKind == 1) {
    float t = smoothstep(0.3, 0.75, h);
    c = mix(vec3(0.42, 0.38, 0.50), vec3(0.68, 0.64, 0.74), t);
    c = mix(c, vec3(0.50, 0.42, 0.62), smoothstep(0.5, 0.7, fbm(d * 3.0 + uSeed * 2.0)) * 0.5);
    float ice = smoothstep(0.68, 0.8, lat + (fbm(d * 5.0) - 0.5) * 0.12);
    c = mix(c, vec3(0.96, 0.97, 1.0), ice);                                                     // bright ice caps
  } else if (uKind == 2) {
    float sea = 0.52;
    if (h < sea) {
      float depth = smoothstep(sea, 0.25, h);
      c = mix(vec3(0.12, 0.37, 0.42), vec3(0.06, 0.22, 0.28), depth);                           // teal ocean #1f5f6b
    } else {
      float t = smoothstep(sea, 0.8, h);
      c = mix(vec3(0.54, 0.48, 0.35), vec3(0.66, 0.62, 0.52), t);                               // land #8a7a5a
      c = mix(c, vec3(0.36, 0.42, 0.28), smoothstep(0.5, 0.7, fbm(d * 4.0)) * 0.5);
    }
    c = mix(c, vec3(0.95, 0.96, 0.97), smoothstep(0.86, 0.95, lat));
  } else {
    c = mix(vec3(0.36, 0.36, 0.37), vec3(0.7, 0.7, 0.7), smoothstep(0.2, 0.6, h));
  }
  c = min(c, vec3(0.8)); // ice and bright patches peak at 0.8, never white
  gl_FragColor = vec4(lin(c), 1.0);
}`;

const normalFrag = `${common}
varying vec2 vUv;
uniform float uStrength;
void main() {
  vec2 e = uTexel;
  float hL = height(dirFromUv(vUv - vec2(e.x, 0.0))), hR = height(dirFromUv(vUv + vec2(e.x, 0.0)));
  float hD = height(dirFromUv(vUv - vec2(0.0, e.y))), hU = height(dirFromUv(vUv + vec2(0.0, e.y)));
  vec3 d = dirFromUv(vUv);
  float hc = height(d);
  if (uKind == 2 && hc < 0.52) { gl_FragColor = vec4(0.5, 0.5, 1.0, 1.0); return; } // flat sea
  float lat = (vUv.y - 0.5) * 3.1415927;
  float sx = (hR - hL) * uStrength / max(0.05, cos(lat)), sy = (hU - hD) * uStrength;
  vec3 n = normalize(vec3(-sx, -sy, 1.0));
  gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);
}`;

const cloudFrag = `${common}
varying vec2 vUv;
void main() {
  vec3 d = dirFromUv(vUv);
  float lat = d.y;
  // Thin bands stretched along latitude.
  vec3 p = vec3(d.x * 1.0, d.y * 5.0, d.z * 1.0) * 2.0 + uSeed * 3.0;
  float n = fbm(p + fbm(p * 2.0) * 1.5);
  float band = 0.6 + 0.4 * sin(lat * 18.0 + n * 3.0);
  float a = smoothstep(0.55, 0.78, n * band);
  gl_FragColor = vec4(vec3(0.6), a * 0.7); // clouds: 0.8 in sRGB terms
}`;

const vert = `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

function bake(renderer, frag, uniforms, w, h, mip = true) {
  const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, generateMipmaps: mip, minFilter: mip ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
  rt.texture.wrapS = THREE.RepeatWrapping;
  rt.texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const mat = new THREE.ShaderMaterial({ vertexShader: vert, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  const scene = new THREE.Scene(); scene.add(quad);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const prev = renderer.getRenderTarget();
  const prevTM = renderer.toneMapping;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setRenderTarget(rt);
  renderer.render(scene, cam);
  renderer.setRenderTarget(prev);
  renderer.toneMapping = prevTM;
  mat.dispose(); quad.geometry.dispose();
  return rt.texture;
}

export const KIND = { desert: 0, rocky: 1, ocean: 2, moon: 3 };

// Returns {map, normalMap, clouds?}; size is the texture width (height = size/2).
export function bakePlanet(renderer, kind, seed, size) {
  const w = size, h = size / 2;
  const u = () => ({ uSeed: { value: seed }, uKind: { value: kind }, uTexel: { value: new THREE.Vector2(1 / w, 1 / h) }, uStrength: { value: kind === KIND.moon ? 9 : 6 } });
  const out = {
    map: bake(renderer, colorFrag, u(), w, h),
    normalMap: bake(renderer, normalFrag, u(), w, h),
  };
  if (kind === KIND.ocean) out.clouds = bake(renderer, cloudFrag, u(), w, h);
  return out;
}

// ---------------- far-background storm nebula ----------------
// Baked once: rgb = colour (low intensity, linear), a = cloud density. Patches only; most of the sky
// stays black. Ridged, domain-warped noise gives crisp filaments and dark gaps.
const nebulaFrag = `${common}
varying vec2 vUv;
uniform vec3 uC0, uC1, uC2;
void main() {
  vec3 d = dirFromUv(vUv);
  // Patch mask: three storm regions with ragged edges.
  float m = 0.0;
  m += exp(-pow(acos(clamp(dot(d, normalize(uC0)), -1.0, 1.0)), 2.0) * 9.0);
  m += exp(-pow(acos(clamp(dot(d, normalize(uC1)), -1.0, 1.0)), 2.0) * 12.0) * 0.8;
  m += exp(-pow(acos(clamp(dot(d, normalize(uC2)), -1.0, 1.0)), 2.0) * 16.0) * 0.6;
  m *= smoothstep(0.35, 0.65, fbm(d * 2.0 + 4.0));
  // Domain-warped ridged filaments.
  vec3 q = d * 3.0;
  vec3 w = vec3(fbm(q + 1.7), fbm(q + 9.2), fbm(q + 5.3));
  float r = ridged(q * 1.4 + w * 2.2);
  float dens = smoothstep(0.42, 0.78, r) * m;
  dens *= 1.0 - smoothstep(0.55, 0.8, fbm(d * 6.0 + w)) * 0.85;   // dark gaps
  dens = clamp(dens * 1.4, 0.0, 1.0);
  float hue = fbm(d * 2.5 + 11.0), tealN = fbm(d * 4.0 + 21.0);
  vec3 purple = vec3(0.16, 0.03, 0.26), magenta = vec3(0.32, 0.05, 0.30), teal = vec3(0.02, 0.18, 0.22), gold = vec3(0.30, 0.20, 0.06);
  vec3 c = mix(purple, magenta, smoothstep(0.4, 0.7, hue));
  c = mix(c, teal, smoothstep(0.62, 0.8, tealN) * 0.7);
  c += gold * smoothstep(0.75, 0.95, r) * 0.25;
  gl_FragColor = vec4(c * dens * 0.55, dens);
}`;
export const NEBULA_CENTRES = [new THREE.Vector3(-0.7, 0.35, -0.6), new THREE.Vector3(0.75, -0.2, -0.65), new THREE.Vector3(0.1, 0.65, -0.75)];
export function bakeNebula(renderer, size) {
  const u = { uSeed: { value: 3.3 }, uKind: { value: 0 }, uTexel: { value: new THREE.Vector2(1 / size, 2 / size) },
    uC0: { value: NEBULA_CENTRES[0] }, uC1: { value: NEBULA_CENTRES[1] }, uC2: { value: NEBULA_CENTRES[2] } };
  return bake(renderer, nebulaFrag, u, size, size / 2);
}
