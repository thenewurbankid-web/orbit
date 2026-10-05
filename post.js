// Final image: per-object + camera motion blur from one velocity buffer, and the v1 portfolio's finishing pass
// (luminance-weighted grain and a soft vignette), plus a touch of edge chromatic aberration and a speed vignette
// that only appear while the camera travels fast.
import * as THREE from "three";
import { Pass, FullScreenQuad } from "three/addons/postprocessing/Pass.js";

export const VELOCITY_LAYER = 4; // meshes that write per-object velocity (planets, moons, craft, vessels)

// ---------------- motion blur ----------------
// 1. Velocity: tagged meshes are drawn again (half resolution on mid tier) with their current and previous
//    model-view-projection, writing screen-space velocity. 2. Untagged pixels (stars, nebula, sky) get the
//    camera's own motion by reprojecting a far point with last frame's view-projection. 3. One gather pass
//    samples along the velocity with a 180° shutter (half the frame's motion), clamped so nothing smears.
export class MotionBlurPass extends Pass {
  constructor(scene, camera, { half = false, objects = true } = {}) {
    super();
    this.scene = scene; this.camera = camera; this.half = half; this.objects = objects;
    this.needsSwap = true;
    this.strength = 1; this.zoom = 0; this.focus = new THREE.Vector2(0.5, 0.5);
    this.velRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.velMat = new THREE.ShaderMaterial({
      uniforms: { uPrevModel: { value: new THREE.Matrix4() }, uPrevVP: { value: new THREE.Matrix4() } },
      vertexShader: `uniform mat4 uPrevModel, uPrevVP; varying vec4 vCur; varying vec4 vPrev;
        void main(){ vec4 wp = modelMatrix * vec4(position, 1.0); vCur = projectionMatrix * viewMatrix * wp; vPrev = uPrevVP * uPrevModel * vec4(position, 1.0); gl_Position = vCur; }`,
      fragmentShader: `varying vec4 vCur; varying vec4 vPrev;
        void main(){ vec2 v = (vCur.xy / vCur.w - vPrev.xy / vPrev.w) * 0.5; gl_FragColor = vec4(v, 1.0, 1.0); }`,
    });
    this.prevVP = new THREE.Matrix4(); this.curVP = new THREE.Matrix4(); this.invVP = new THREE.Matrix4();
    this.prevCam = new THREE.Vector3(); this.hasPrev = false;
    this.blur = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, tVel: { value: null }, uInvVP: { value: this.invVP }, uPrevVP: { value: this.prevVP }, uCam: { value: new THREE.Vector3() },
        uShutter: { value: 0.5 }, uMax: { value: 0.03 }, uZoom: { value: 0 }, uFocus: { value: this.focus }, uObjects: { value: 1 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: `precision highp float;
        uniform sampler2D tDiffuse, tVel; uniform mat4 uInvVP, uPrevVP; uniform vec3 uCam; uniform float uShutter, uMax, uZoom, uObjects; uniform vec2 uFocus; varying vec2 vUv;
        vec2 camVel(vec2 uv){
          vec4 w = uInvVP * vec4(uv * 2.0 - 1.0, 1.0, 1.0); vec3 dir = normalize(w.xyz / w.w - uCam);
          vec4 pc = uPrevVP * vec4(uCam + dir * 450.0, 1.0);
          return ((uv * 2.0 - 1.0) - pc.xy / pc.w) * 0.5;
        }
        void main(){
          vec4 vt = uObjects > 0.5 ? texture2D(tVel, vUv) : vec4(0.0);
          vec2 v = vt.b > 0.5 ? vt.rg : camVel(vUv);
          v = v * uShutter + (vUv - uFocus) * uZoom;
          float L = length(v); if (L > uMax) v *= uMax / L;
          if (length(v) < 0.0006) { gl_FragColor = texture2D(tDiffuse, vUv); return; }
          vec4 acc = vec4(0.0);
          for (int i = 0; i < 9; i++) { float t = float(i) / 8.0 - 0.5; acc += texture2D(tDiffuse, vUv - v * t); }
          gl_FragColor = acc / 9.0;
        }`,
    }));
  }
  setSize(w, h) { const k = this.half ? 0.5 : 1; this.velRT.setSize(Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))); }
  // Call after the frame has been rendered: remembers this frame's matrices for the next one.
  remember() {
    this.prevVP.copy(this.curVP); this.prevCam.copy(this.camera.position); this.hasPrev = true;
    this.scene.traverse((o) => { if (o.isMesh && o.layers.isEnabled(VELOCITY_LAYER)) (o.userData.prevMW ??= new THREE.Matrix4()).copy(o.matrixWorld); });
  }
  render(renderer, writeBuffer, readBuffer) {
    const cam = this.camera;
    this.curVP.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    if (!this.hasPrev) this.prevVP.copy(this.curVP);
    this.invVP.copy(this.curVP).invert();
    const u = this.blur.material.uniforms;
    u.tDiffuse.value = readBuffer.texture; u.uCam.value.copy(cam.position); u.uZoom.value = this.zoom; u.uShutter.value = 0.5 * this.strength;
    u.uObjects.value = this.objects ? 1 : 0;
    if (this.objects) {
      const prevLayers = cam.layers.mask; cam.layers.set(VELOCITY_LAYER);
      const saved = [];
      this.velMat.uniforms.uPrevVP.value.copy(this.prevVP);
      this.scene.traverse((o) => {
        if (!o.isMesh || !o.layers.isEnabled(VELOCITY_LAYER)) return;
        saved.push([o, o.onBeforeRender]);
        const pm = o.userData.prevMW ?? o.matrixWorld;
        o.onBeforeRender = () => { this.velMat.uniforms.uPrevModel.value.copy(pm); this.velMat.uniformsNeedUpdate = true; };
      });
      const bg = this.scene.background, ov = this.scene.overrideMaterial;
      this.scene.background = null; this.scene.overrideMaterial = this.velMat;
      renderer.setRenderTarget(this.velRT); renderer.setClearColor(0x000000, 0); renderer.clear();
      renderer.render(this.scene, cam);
      this.scene.background = bg; this.scene.overrideMaterial = ov; cam.layers.mask = prevLayers;
      for (const [o, f] of saved) o.onBeforeRender = f;
      u.tVel.value = this.velRT.texture;
    }
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.blur.render(renderer);
  }
}

// ---------------- finishing: v1's grain and vignette (+ speed-only CA and vignette) ----------------
export const FinishShader = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) }, uGrain: { value: 0.09 }, uVig: { value: 1 }, uSpeed: { value: 0 }, uCA: { value: 0.0002 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `precision highp float; uniform sampler2D tDiffuse; uniform float uTime, uGrain, uVig, uSpeed, uCA; uniform vec2 uRes; varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main(){
      vec2 d = vUv - 0.5; float r2 = dot(d, d);
      float ca = uCA * r2 * 4.0 * (1.0 + uSpeed * 5.0);                       // only toward the edges, a little more at speed
      vec3 c = vec3(texture2D(tDiffuse, vUv + d * ca).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - d * ca).b);
      float lum = dot(c, vec3(0.299, 0.587, 0.114));
      float g = hash(floor(vUv * uRes) + fract(uTime * 7.31) * 91.0) - 0.5;    // v1 grain: luminance-weighted
      c += g * uGrain * (0.008 + min(lum, 1.0) * 0.12);
      vec2 q = d * vec2(uRes.x / uRes.y, 1.0); float v = smoothstep(1.15, 0.25, length(q));
      c *= mix(mix(0.55, 1.0, 1.0 - uVig) - uSpeed * 0.12, 1.0, v);           // v1 vignette, deeper only at speed
      gl_FragColor = vec4(max(c, 0.0), 1.0);
    }`,
};
