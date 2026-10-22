import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import earcut from 'earcut';

export const R = 100;
const D2R = Math.PI / 180;

export interface CountryFeature { id: string; ko: string; en: string; p: number[][][][] }
interface CountryGeo { id: string; ko: string; idx: number; polys: { rings: number[][][]; bbox: [number, number, number, number] }[] }
export interface Spike { id: string; lat: number; lon: number; color: string; size: number }
export interface GlobeEvents { onHover(id: string | null, x: number, y: number): void; onClick(id: string | null): void }

const MORPH_GLSL = /* glsl */ `
uniform float uMorph; uniform float uR;
vec3 mDir(vec2 ll, out float Rt){
  float k = max(1.0 - uMorph, 0.0);
  Rt = uR / max(k, 0.002);
  float lo = radians(ll.x) * k, la = radians(ll.y) * k;
  return vec3(cos(la) * sin(lo), sin(la), cos(la) * cos(lo));
}
vec3 morphPos(vec2 ll, float h){
  if (uMorph > 0.998) return vec3(radians(ll.x) * uR, radians(ll.y) * uR, uR + h);
  float Rt; vec3 d = mDir(ll, Rt);
  return d * (Rt + h) - vec3(0.0, 0.0, Rt - uR);
}
vec3 morphNormal(vec2 ll){ float Rt; return uMorph > 0.998 ? vec3(0.0, 0.0, 1.0) : mDir(ll, Rt); }
`;

/** 셰이더와 같은 변환(JS). 막대·카메라 위치 계산용 */
export function morphPosJS(lon: number, lat: number, h: number, m: number, out = new THREE.Vector3()) {
  if (m > 0.998) return out.set(lon * D2R * R, lat * D2R * R, R + h);
  const k = Math.max(1 - m, 0);
  const Rt = R / Math.max(k, 0.002);
  const lo = lon * D2R * k, la = lat * D2R * k;
  out.set(Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo));
  return out.multiplyScalar(Rt + h).sub(new THREE.Vector3(0, 0, Rt - R));
}
export function morphNormalJS(lon: number, lat: number, m: number, out = new THREE.Vector3()) {
  if (m > 0.998) return out.set(0, 0, 1);
  const k = Math.max(1 - m, 0);
  const lo = lon * D2R * k, la = lat * D2R * k;
  return out.set(Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo));
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function subdivide(tri: number[][], max: number, out: number[], depth = 0) {
  const [a, b, c] = tri;
  const d = (p: number[], q: number[]) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  const ab = d(a, b), bc = d(b, c), ca = d(c, a);
  const m = Math.max(ab, bc, ca);
  if (m <= max || depth > 14) { out.push(a[0], a[1], b[0], b[1], c[0], c[1]); return; }
  if (m === ab) { const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; subdivide([a, mid, c], max, out, depth + 1); subdivide([mid, b, c], max, out, depth + 1); }
  else if (m === bc) { const mid = [(b[0] + c[0]) / 2, (b[1] + c[1]) / 2]; subdivide([a, b, mid], max, out, depth + 1); subdivide([a, mid, c], max, out, depth + 1); }
  else { const mid = [(c[0] + a[0]) / 2, (c[1] + a[1]) / 2]; subdivide([a, b, mid], max, out, depth + 1); subdivide([mid, b, c], max, out, depth + 1); }
}

function pip(pt: number[], ring: number[][]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (((yi > pt[1]) !== (yj > pt[1])) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export class Globe {
  renderer: THREE.WebGLRenderer; scene = new THREE.Scene(); camera: THREE.PerspectiveCamera; controls: OrbitControls;
  countries: CountryGeo[] = []; byId = new Map<string, CountryGeo>();
  private uniforms: Record<string, THREE.IUniform>;
  private prev: Uint8Array<ArrayBuffer>; private next: Uint8Array<ArrayBuffer>; private texPrev: THREE.DataTexture; private texNext: THREE.DataTexture;
  private colorAnim = 1;
  private morph = 0; private morphTarget = 0; private morphFrom = 0; private morphT = 1; private morphCenter = { lon: 0, lat: 0 }; private morphDist = 300;
  private camAnim: null | { t: number; dur: number; from: THREE.Vector3; to: THREE.Vector3; tFrom: THREE.Vector3; tTo: THREE.Vector3; globe: boolean } = null;
  private spikeMesh: THREE.InstancedMesh; private spikes: (Spike & { h: number; h0: number; h1: number; r: number })[] = []; private spikeT = 1;
  private hoverId: string | null = null; private selId: string | null = null;
  private pointer = { x: 0, y: 0, dirty: false, inside: false }; private down = { x: 0, y: 0, t: 0 };
  private raycaster = new THREE.Raycaster(); private atmo: THREE.Mesh; private stars: THREE.Points;
  private idle = true; private lastT = performance.now(); private lastCamKey = '';
  flat = false;

  constructor(private el: HTMLElement, features: CountryFeature[], private ev: GlobeEvents) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x05080f, 1);
    el.appendChild(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(45, 1, 1, 6000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true; this.controls.dampingFactor = 0.08;
    this.controls.rotateSpeed = 0.5; this.controls.zoomSpeed = 0.9;
    this.controls.addEventListener('start', () => { this.idle = false; this.camAnim = null; });

    const N = features.length;
    this.prev = new Uint8Array(N * 4); this.next = new Uint8Array(N * 4);
    this.texPrev = new THREE.DataTexture(this.prev, N, 1, THREE.RGBAFormat); this.texNext = new THREE.DataTexture(this.next, N, 1, THREE.RGBAFormat);
    this.uniforms = {
      uMorph: { value: 0 }, uR: { value: R }, uPrev: { value: this.texPrev }, uNext: { value: this.texNext }, uMix: { value: 1 },
      uN: { value: N }, uHover: { value: -1 }, uSel: { value: -1 }, uLight: { value: new THREE.Vector3(0, 0, 1) }, uPixelRatio: { value: this.renderer.getPixelRatio() },
    };
    this.buildCountries(features);
    this.buildOcean();
    this.atmo = this.buildAtmosphere();
    this.stars = this.buildStars();
    this.spikeMesh = this.buildSpikes();
    this.setBaseColors(null);
    this.flyToLL(42, 60, 330, false);
    this.applyControlMode();

    const c = this.renderer.domElement;
    c.addEventListener('pointermove', e => { this.pointer = { x: e.clientX, y: e.clientY, dirty: true, inside: true }; });
    c.addEventListener('pointerleave', () => { this.pointer.inside = false; this.setHover(null); this.ev.onHover(null, 0, 0); });
    c.addEventListener('pointerdown', e => { this.down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
    c.addEventListener('pointerup', e => {
      if (Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) < 6 && performance.now() - this.down.t < 500) {
        const id = this.pick(e.clientX, e.clientY); this.ev.onClick(id);
      }
    });
    new ResizeObserver(() => this.resize()).observe(el);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
    (window as any).__stats = () => this.renderer.info.render;
  }

  // ---------- 생성 ----------
  private buildCountries(features: CountryFeature[]) {
    const ll: number[] = [], ci: number[] = [], bl: number[] = [], bci: number[] = [];
    features.forEach((f, idx) => {
      const g: CountryGeo = { id: f.id, ko: f.ko, idx, polys: [] };
      for (const poly of f.p) {
        const flatc: number[] = [], holes: number[] = [];
        poly.forEach((ring, ri) => { if (ri) holes.push(flatc.length / 2); for (const p of ring) flatc.push(p[0], p[1]); });
        const tris = earcut(flatc, holes, 2);
        const out: number[] = [];
        for (let i = 0; i < tris.length; i += 3) {
          const p = (k: number) => [flatc[tris[k] * 2], flatc[tris[k] * 2 + 1]];
          subdivide([p(i), p(i + 1), p(i + 2)], 2.5, out);
        }
        for (let i = 0; i < out.length; i += 2) { ll.push(out[i], out[i + 1]); ci.push(idx); }
        let x0 = 999, y0 = 999, x1 = -999, y1 = -999;
        for (const ring of poly) {
          for (let i = 0; i < ring.length; i++) {
            const a = ring[i], b = ring[(i + 1) % ring.length];
            x0 = Math.min(x0, a[0]); x1 = Math.max(x1, a[0]); y0 = Math.min(y0, a[1]); y1 = Math.max(y1, a[1]);
            if (Math.abs(a[0]) === 180 && a[0] === b[0]) continue; // 날짜변경선 절단선은 그리지 않음
            const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2));
            for (let s = 0; s < n; s++) {
              const t0 = s / n, t1 = (s + 1) / n;
              bl.push(a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0, a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1);
              bci.push(idx, idx);
            }
          }
        }
        g.polys.push({ rings: poly, bbox: [x0, y0, x1, y1] });
      }
      this.countries.push(g); this.byId.set(f.id, g);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('lonlat', new THREE.Float32BufferAttribute(ll, 2));
    geo.setAttribute('cidx', new THREE.Float32BufferAttribute(ci, 1));
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array((ll.length / 2) * 3), 3));
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: MORPH_GLSL + /* glsl */ `
        attribute vec2 lonlat; attribute float cidx;
        uniform sampler2D uPrev; uniform sampler2D uNext; uniform float uMix; uniform float uN; uniform float uHover; uniform float uSel; uniform vec3 uLight;
        varying vec3 vCol; varying float vShade; varying float vHatch;
        void main(){
          vec2 uv = vec2((cidx + 0.5) / uN, 0.5);
          vec4 style = mix(texture2D(uPrev, uv), texture2D(uNext, uv), uMix);
          vec3 c = style.rgb;
          vHatch = style.a;
          if (abs(cidx - uSel) < 0.5) c = c * 1.25 + vec3(0.10, 0.12, 0.16);
          if (abs(cidx - uHover) < 0.5) c = c * 1.2 + vec3(0.07, 0.08, 0.10);
          vCol = c;
          vec3 n = morphNormal(lonlat);
          vShade = mix(0.5 + 0.6 * max(dot(n, uLight), 0.0), 1.0, uMorph);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(morphPos(lonlat, 0.25), 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uPixelRatio;
        varying vec3 vCol; varying float vShade; varying float vHatch;
        void main(){
          float d = mod((gl_FragCoord.x + gl_FragCoord.y) / uPixelRatio, 10.0);
          float stripe = smoothstep(0.5, 1.2, d) * (1.0 - smoothstep(3.0, 3.7, d));
          vec3 hatched = mix(vec3(0.22, 0.26, 0.31), vCol, 0.12 + 0.78 * stripe);
          gl_FragColor = vec4(mix(vCol, hatched, vHatch) * vShade, 1.0);
        }`,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false; mesh.renderOrder = 1; this.scene.add(mesh);

    const bgeo = new THREE.BufferGeometry();
    bgeo.setAttribute('lonlat', new THREE.Float32BufferAttribute(bl, 2));
    bgeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array((bl.length / 2) * 3), 3));
    const bmat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, transparent: true, depthWrite: false,
      vertexShader: MORPH_GLSL + `attribute vec2 lonlat; void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(morphPos(lonlat, 0.45), 1.0); }`,
      fragmentShader: `void main(){ gl_FragColor = vec4(0.55, 0.68, 0.82, 0.38); }`,
    });
    const lines = new THREE.LineSegments(bgeo, bmat); lines.frustumCulled = false; lines.renderOrder = 2; this.scene.add(lines);
  }

  private buildOcean() {
    const ll: number[] = []; const step = 3;
    for (let lat = -90; lat < 90; lat += step) for (let lon = -180; lon < 180; lon += step) {
      const a = [lon, lat], b = [lon + step, lat], c = [lon + step, lat + step], d = [lon, lat + step];
      ll.push(...a, ...b, ...c, ...a, ...c, ...d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('lonlat', new THREE.Float32BufferAttribute(ll, 2));
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array((ll.length / 2) * 3), 3));
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, side: THREE.DoubleSide,
      vertexShader: MORPH_GLSL + `attribute vec2 lonlat; uniform vec3 uLight; varying float vS; varying vec2 vLL;
        void main(){ vec3 n = morphNormal(lonlat); vS = mix(0.35 + 0.75 * max(dot(n, uLight), 0.0), 1.0, uMorph); vLL = lonlat;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(morphPos(lonlat, 0.0), 1.0); }`,
      fragmentShader: `varying float vS; varying vec2 vLL;
        void main(){
          vec3 c = mix(vec3(0.035, 0.07, 0.12), vec3(0.05, 0.10, 0.17), smoothstep(-60.0, 60.0, vLL.y));
          vec2 g = abs(fract(vLL / 30.0 + 0.5) - 0.5) * 30.0;
          float line = 1.0 - smoothstep(0.0, 0.35, min(g.x, g.y));
          c += vec3(0.05, 0.08, 0.12) * line * 0.6;
          gl_FragColor = vec4(c * vS, 1.0);
        }`,
    });
    const m = new THREE.Mesh(geo, mat); m.frustumCulled = false; this.scene.add(m);
  }

  private buildAtmosphere() {
    const geo = new THREE.SphereGeometry(R * 1.1, 64, 48);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uFade: { value: 1 } }, transparent: true, side: THREE.BackSide, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `varying vec3 vN; varying vec3 vV; void main(){ vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position,1.0); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform float uFade; varying vec3 vN; varying vec3 vV; void main(){ float d = clamp(-dot(vN, vV) / 0.42, 0.0, 1.0); float i = pow(d, 3.0) * 0.55; gl_FragColor = vec4(0.30, 0.58, 1.0, 1.0) * i * uFade; }`,
    });
    const m = new THREE.Mesh(geo, mat); this.scene.add(m); return m;
  }

  private buildStars() {
    const n = 1800, p = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { const v = new THREE.Vector3().randomDirection().multiplyScalar(2000 + Math.random() * 1500); p.set([v.x, v.y, v.z], i * 3); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    const s = new THREE.Points(g, new THREE.PointsMaterial({ color: 0x8fa6c8, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0.55, depthWrite: false }));
    this.scene.add(s); return s;
  }

  private buildSpikes() {
    const g = new THREE.CylinderGeometry(1, 1, 1, 14, 1, false); g.translate(0, 0.5, 0);
    const m = new THREE.InstancedMesh(g, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9, depthWrite: true }), 64);
    m.count = 0; m.frustumCulled = false; m.renderOrder = 3; this.scene.add(m); return m;
  }

  // ---------- 색·막대 ----------
  /** RGB는 채움색, 텍스처 alpha는 빗금 여부다. null이면 기본 지도. */
  setBaseColors(colors: Map<string, [number, number, number]> | null, dimOthers = false, hatched: ReadonlySet<string> = new Set()) {
    const N = this.countries.length;
    // 현재 보이는 색을 prev로
    const m = ease(Math.min(1, this.colorAnim));
    for (let i = 0; i < N * 4; i++) this.prev[i] = Math.round(this.prev[i] + (this.next[i] - this.prev[i]) * m);
    for (const c of this.countries) {
      const v = (c.idx * 37) % 7;
      let rgb: [number, number, number] = dimOthers ? [0.075, 0.105, 0.14] : [0.11 + v * 0.004, 0.16 + v * 0.005, 0.22 + v * 0.006];
      const got = colors?.get(c.id); if (got) rgb = got;
      this.next.set([rgb[0] * 255, rgb[1] * 255, rgb[2] * 255, hatched.has(c.id) ? 255 : 0].map(x => Math.max(0, Math.min(255, Math.round(x)))), c.idx * 4);
    }
    this.texPrev.needsUpdate = true; this.texNext.needsUpdate = true;
    this.colorAnim = 0;
  }

  setSpikes(list: Spike[]) {
    const old = new Map(this.spikes.map(s => [s.id, s.h]));
    const next = list.map(s => ({ ...s, h0: old.get(s.id) ?? 0, h1: 3 + 26 * s.size, h: old.get(s.id) ?? 0, r: 0.7 + 1.1 * s.size }));
    // 사라지는 막대는 줄어들며 퇴장
    for (const s of this.spikes) if (!list.find(x => x.id === s.id)) next.push({ ...s, h0: s.h, h1: 0 });
    this.spikes = next.slice(0, 64); this.spikeT = 0;
    const col = new THREE.Color();
    this.spikes.forEach((s, i) => this.spikeMesh.setColorAt(i, col.set(s.color)));
    if (this.spikeMesh.instanceColor) this.spikeMesh.instanceColor.needsUpdate = true;
    this.spikeMesh.count = this.spikes.length;
  }

  private updateSpikes(dt: number) {
    if (this.spikeT < 1) this.spikeT = Math.min(1, this.spikeT + dt / 0.6);
    const e = ease(this.spikeT);
    const pos = new THREE.Vector3(), nrm = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), mtx = new THREE.Matrix4(), up = new THREE.Vector3(0, 1, 0);
    this.spikes.forEach((s, i) => {
      s.h = s.h0 + (s.h1 - s.h0) * e;
      morphPosJS(s.lon, s.lat, 0.3, this.morph, pos); morphNormalJS(s.lon, s.lat, this.morph, nrm);
      q.setFromUnitVectors(up, nrm);
      const flatBoost = 1 + this.morph * 0.9;
      sc.set(s.r * flatBoost, Math.max(0.001, s.h * (1 - 0.92 * this.morph)), s.r * flatBoost);
      mtx.compose(pos, q, sc); this.spikeMesh.setMatrixAt(i, mtx);
    });
    if (this.spikeT >= 1) { this.spikes = this.spikes.filter(s => s.h1 > 0); this.spikeMesh.count = this.spikes.length; }
    this.spikeMesh.instanceMatrix.needsUpdate = true;
  }

  // ---------- 상호작용 ----------
  private llFromScreen(x: number, y: number): [number, number] | null {
    if (this.morph > 0.02 && this.morph < 0.98) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const ray = this.raycaster.ray;
    if (this.morph <= 0.02) {
      const hit = ray.intersectSphere(new THREE.Sphere(new THREE.Vector3(), R + 0.25), new THREE.Vector3());
      if (!hit) return null;
      return [Math.atan2(hit.x, hit.z) / D2R, Math.asin(Math.max(-1, Math.min(1, hit.y / hit.length()))) / D2R];
    }
    const hit = ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -(R + 0.25)), new THREE.Vector3());
    if (!hit) return null;
    const lon = hit.x / R / D2R, lat = hit.y / R / D2R;
    return Math.abs(lon) <= 180 && Math.abs(lat) <= 90 ? [lon, lat] : null;
  }
  countryAt(lon: number, lat: number): string | null {
    for (const c of this.countries) for (const p of c.polys) {
      const [x0, y0, x1, y1] = p.bbox;
      if (lon < x0 || lon > x1 || lat < y0 || lat > y1) continue;
      if (pip([lon, lat], p.rings[0]) && !p.rings.slice(1).some(h => pip([lon, lat], h))) return c.id;
    }
    return null;
  }
  pick(x: number, y: number) { const ll = this.llFromScreen(x, y); return ll ? this.countryAt(ll[0], ll[1]) : null; }
  private setHover(id: string | null) { this.hoverId = id; this.uniforms.uHover.value = id ? this.byId.get(id)?.idx ?? -1 : -1; this.renderer.domElement.style.cursor = id ? 'pointer' : ''; }
  setSelected(id: string | null) { this.selId = id; this.uniforms.uSel.value = id ? this.byId.get(id)?.idx ?? -1 : -1; }

  /** 경위도 → 화면 좌표(px) */
  project(lon: number, lat: number) {
    const v = morphPosJS(lon, lat, 0.3, this.morph).project(this.camera);
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
  }

  // ---------- 카메라 ----------
  private centerLL(): { lon: number; lat: number; dist: number } {
    if (!this.flat) {
      const p = this.camera.position; const d = p.length();
      return { lon: Math.atan2(p.x, p.z) / D2R, lat: Math.asin(p.y / d) / D2R, dist: d - R };
    }
    const t = this.controls.target;
    return { lon: THREE.MathUtils.clamp(t.x / R / D2R, -180, 180), lat: THREE.MathUtils.clamp(t.y / R / D2R, -85, 85), dist: this.camera.position.z - R };
  }
  private flyToLL(lat: number, lon: number, dist: number, animate = true) {
    const dir = morphNormalJS(lon, lat, 0);
    if (!this.flat) {
      const to = dir.clone().multiplyScalar(R + dist);
      this.startCam(to, new THREE.Vector3(), animate, true);
    } else {
      const p = morphPosJS(lon, lat, 0, 1);
      this.startCam(new THREE.Vector3(p.x, p.y, R + dist), new THREE.Vector3(p.x, p.y, R), animate, false);
    }
  }
  private startCam(to: THREE.Vector3, target: THREE.Vector3, animate: boolean, globe: boolean) {
    if (!animate) { this.camera.position.copy(to); this.controls.target.copy(target); this.camera.lookAt(target); return; }
    this.camAnim = { t: 0, dur: 0.9, from: this.camera.position.clone(), to, tFrom: this.controls.target.clone(), tTo: target, globe };
  }
  focus(id: string, lat?: number, lon?: number) {
    let la = lat, lo = lon;
    if (la == null || lo == null) {
      const c = this.byId.get(id); if (!c) return;
      let best = c.polys[0], area = -1;
      for (const p of c.polys) { const a = (p.bbox[2] - p.bbox[0]) * (p.bbox[3] - p.bbox[1]); if (a > area) { area = a; best = p; } }
      lo = (best.bbox[0] + best.bbox[2]) / 2; la = (best.bbox[1] + best.bbox[3]) / 2;
    }
    this.idle = false;
    const cur = this.centerLL();
    this.flyToLL(la, lo, Math.min(Math.max(cur.dist, 110), this.flat ? 170 : 230));
    this.setSelected(id);
  }
  private applyControlMode() {
    const c = this.controls;
    if (!this.flat) {
      c.enableRotate = true; c.enablePan = false; c.minDistance = R + 25; c.maxDistance = R + 650;
      c.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
      c.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_ROTATE };
    } else {
      c.enableRotate = false; c.enablePan = true; c.screenSpacePanning = true; c.minDistance = 30; c.maxDistance = 900;
      c.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
      c.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
    }
  }
  private flatFitDist() {
    const t = Math.tan((this.camera.fov / 2) * D2R);
    return Math.min(Math.PI * R / t * 0.5 / 0.92, (2 * Math.PI * R) / (2 * t * this.camera.aspect) * 0.98) ;
  }
  setFlat(flat: boolean) {
    if (flat === this.flat && this.morphT >= 1) return;
    const c = this.centerLL();
    this.morphCenter = { lon: c.lon, lat: flat ? THREE.MathUtils.clamp(c.lat, -60, 60) * 0.5 : c.lat };
    this.morphDist = c.dist;
    this.flat = flat; this.morphFrom = this.morph; this.morphTarget = flat ? 1 : 0; this.morphT = 0; this.camAnim = null;
    this.controls.enabled = false;
  }

  // ---------- 루프 ----------
  private resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    this.renderer.setSize(w, h, false); this.camera.aspect = w / Math.max(1, h); this.camera.updateProjectionMatrix();
  }
  private frame() {
    const now = performance.now(); const dt = Math.min(0.05, (now - this.lastT) / 1000); this.lastT = now;
    if (this.colorAnim < 1) { this.colorAnim = Math.min(1, this.colorAnim + dt / 0.5); this.uniforms.uMix.value = ease(this.colorAnim); }
    if (this.morphT < 1) {
      this.morphT = Math.min(1, this.morphT + dt / 1.3);
      const e = ease(this.morphT);
      this.morph = this.morphFrom + (this.morphTarget - this.morphFrom) * e;
      this.uniforms.uMorph.value = this.morph;
      const { lon, lat } = this.morphCenter;
      const toDist = this.flat ? this.flatFitDist() : 230;
      const dist = this.morphDist + (toDist - this.morphDist) * e;
      const P = morphPosJS(this.flat ? lon * (1 - e) : lon, this.flat ? lat * (1 - e) : lat, 0, this.morph);
      const Nn = morphNormalJS(this.flat ? lon * (1 - e) : lon, this.flat ? lat * (1 - e) : lat, this.morph);
      this.camera.position.copy(P).addScaledVector(Nn, dist);
      this.controls.target.copy(P).addScaledVector(Nn, -R * (1 - this.morph));
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(this.controls.target);
      if (this.morphT >= 1) { this.applyControlMode(); this.controls.enabled = true; }
    } else if (this.camAnim) {
      const a = this.camAnim; a.t = Math.min(1, a.t + dt / a.dur); const e = ease(a.t);
      if (a.globe) {
        const d0 = a.from.length(), d1 = a.to.length();
        const v = a.from.clone().normalize(); const q = new THREE.Quaternion().setFromUnitVectors(v, a.to.clone().normalize());
        const qq = new THREE.Quaternion().slerp(q, e);
        this.camera.position.copy(v.applyQuaternion(qq).multiplyScalar(d0 + (d1 - d0) * e));
      } else this.camera.position.lerpVectors(a.from, a.to, e);
      this.controls.target.lerpVectors(a.tFrom, a.tTo, e);
      if (a.t >= 1) this.camAnim = null;
    } else if (this.idle && !this.flat) {
      const p = this.camera.position; const ang = dt * 0.035; const x = p.x, z = p.z;
      p.x = x * Math.cos(ang) + z * Math.sin(ang); p.z = -x * Math.sin(ang) + z * Math.cos(ang);
    }
    if (this.flat && this.morphT >= 1) {
      const t = this.controls.target, lim = Math.PI * R;
      const cx = THREE.MathUtils.clamp(t.x, -lim, lim), cy = THREE.MathUtils.clamp(t.y, -lim / 2, lim / 2);
      if (cx !== t.x || cy !== t.y) { this.camera.position.x += cx - t.x; this.camera.position.y += cy - t.y; t.set(cx, cy, t.z); }
    }
    this.controls.update();
    // 빛은 카메라 쪽에서 살짝 위
    (this.uniforms.uLight.value as THREE.Vector3).copy(this.camera.position).normalize().add(new THREE.Vector3(0, 0.25, 0)).normalize();
    (this.atmo.material as THREE.ShaderMaterial).uniforms.uFade.value = Math.max(0, 1 - this.morph * 2.5);
    this.atmo.visible = this.morph < 0.4;
    (this.stars.material as THREE.PointsMaterial).opacity = 0.55 * (1 - this.morph * 0.7);
    this.updateSpikes(dt);
    const camKey = this.camera.position.x.toFixed(2) + ',' + this.camera.position.y.toFixed(2) + ',' + this.camera.position.z.toFixed(2) + ',' + this.morph.toFixed(3);
    const camMoved = camKey !== this.lastCamKey; this.lastCamKey = camKey;
    if (this.pointer.inside && (this.pointer.dirty || camMoved)) {
      this.pointer.dirty = false;
      const id = this.pick(this.pointer.x, this.pointer.y);
      if (id !== this.hoverId) this.setHover(id);
      this.ev.onHover(id, this.pointer.x, this.pointer.y);
    }
    this.renderer.render(this.scene, this.camera);
  }
}
