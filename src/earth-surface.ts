import * as THREE from 'three';

const EARTH_UV_GLSL = /* glsl */ `
vec2 earthUv(vec2 ll) { return vec2((ll.x + 180.0) / 360.0, (ll.y + 90.0) / 180.0); }
`;

/** 같은 고도와 경위도를 사용해 바탕, 국가 채움, 국경이 함께 움직인다. */
export const EARTH_VERTEX_GLSL = /* glsl */ `
uniform sampler2D uEarthHeight;
uniform float uEarthReady;
${EARTH_UV_GLSL}
float earthHeight(vec2 ll) {
  // 최대 변위는 레이어 간격보다 작게 유지해 서로 다른 삼각망의 교차를 막는다.
  return texture2D(uEarthHeight, earthUv(ll)).r * 0.16 * uEarthReady;
}
`;

export const EARTH_FRAGMENT_GLSL = /* glsl */ `
uniform sampler2D uEarthColor;
uniform sampler2D uEarthHeight;
uniform sampler2D uEarthDepth;
uniform vec2 uEarthTexel;
uniform float uEarthReady;
${EARTH_UV_GLSL}
float earthRelief(vec2 ll, bool water) {
  vec2 uv = earthUv(ll), dx = vec2(uEarthTexel.x, 0.0), dy = vec2(0.0, uEarthTexel.y);
  float west, east, south, north;
  if (water) {
    west = texture2D(uEarthDepth, uv - dx).r; east = texture2D(uEarthDepth, uv + dx).r;
    south = texture2D(uEarthDepth, uv - dy).r; north = texture2D(uEarthDepth, uv + dy).r;
  } else {
    west = texture2D(uEarthHeight, uv - dx).r; east = texture2D(uEarthHeight, uv + dx).r;
    south = texture2D(uEarthHeight, uv - dy).r; north = texture2D(uEarthHeight, uv + dy).r;
  }
  vec3 normal = normalize(vec3((west - east) * 5.0, (south - north) * 5.0, 1.0));
  return mix(1.0, 0.72 + 0.4 * max(dot(normal, normalize(vec3(-0.6, 0.8, 1.0))), 0.0), uEarthReady);
}
vec3 earthLand(vec2 ll) {
  vec3 color = texture2D(uEarthColor, earthUv(ll)).rgb;
  return mix(vec3(0.16, 0.22, 0.18), color * 0.88 + vec3(0.025, 0.035, 0.025), uEarthReady) * earthRelief(ll, false);
}
vec3 earthSurface(vec2 ll) {
  float depth = texture2D(uEarthDepth, earthUv(ll)).r;
  float water = (1.0 - smoothstep(0.97, 0.995, depth)) * uEarthReady;
  vec3 ocean = mix(vec3(0.018, 0.055, 0.11), vec3(0.075, 0.25, 0.32), pow(depth, 3.0));
  ocean *= earthRelief(ll, true);
  return mix(earthLand(ll), ocean, water);
}
`;

function placeholder(rgb: number[]) {
  const texture = new THREE.DataTexture(new Uint8Array([...rgb, 255]), 1, 1, THREE.RGBAFormat);
  texture.needsUpdate = true;
  return texture;
}

export function earthUniforms(): Record<string, THREE.IUniform> {
  return {
    uEarthColor: { value: placeholder([41, 56, 46]) },
    uEarthHeight: { value: placeholder([0, 0, 0]) },
    uEarthDepth: { value: placeholder([128, 128, 128]) },
    uEarthTexel: { value: new THREE.Vector2(1 / 2048, 1 / 1024) },
    uEarthReady: { value: 0 },
    uOverlayOpacity: { value: 0.85 },
  };
}

/** NASA 원본에서 받은 로컬 파일만 읽는다. 런타임에 외부 지도 서비스는 호출하지 않는다. */
export async function loadEarthSurface(renderer: THREE.WebGLRenderer, uniforms: Record<string, THREE.IUniform>) {
  const loader = new THREE.TextureLoader();
  const entries = [['uEarthColor', 'surface'], ['uEarthHeight', 'height'], ['uEarthDepth', 'depth']] as const;
  const textures = await Promise.allSettled(entries.map(async ([, file]) => {
    const texture = await loader.loadAsync(`/earth/${file}.jpg`);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    // 사용자 정의 셰이더는 기존 국가 색과 같은 표시 RGB 공간에서 합성한다.
    texture.colorSpace = THREE.NoColorSpace;
    return texture;
  }));
  if (textures.some(result => result.status === 'rejected')) {
    for (const result of textures) if (result.status === 'fulfilled') result.value.dispose();
    return;
  }
  textures.forEach((result, i) => {
    if (result.status !== 'fulfilled') return;
    (uniforms[entries[i][0]].value as THREE.Texture).dispose();
    uniforms[entries[i][0]].value = result.value;
  });
  const image = (uniforms.uEarthHeight.value as THREE.Texture).image as HTMLImageElement;
  (uniforms.uEarthTexel.value as THREE.Vector2).set(1 / image.width, 1 / image.height);
  uniforms.uEarthReady.value = 1;
}
