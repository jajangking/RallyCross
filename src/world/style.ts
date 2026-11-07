import * as THREE from 'three';

/**
 * Gaya visual: kartun.
 *
 * Dua tujuan sekaligus: (1) seluruh arena terlihat seperti game arcade —
 * warna pekat, bayangan bertingkat (cel shading), langit gradasi, dan bayangan
 * "blob" di bawah mobil; (2) render jadi jauh lebih ringan, karena
 * `MeshToonMaterial` tidak menghitung PBR, tidak butuh environment map, dan
 * tidak menghitung normal map.
 *
 * Modul ini **tidak menyentuh DOM** sampai `createSky()`/`createBlobShadow()`
 * dipanggil, jadi `buildTrackColliders()` tetap bisa jalan di Node.
 */

/** Palet arena: hijau rumput cerah, aspal gelap kebiruan, gravel pasir hangat. */
export const PALETTE = {
  sky: 0x8fd0f2,
  skyTop: 0x2f7fd0,
  skyHorizon: 0xcfe9f7,
  fog: 0xbfe0f2,
  grass: 0x74b446,
  verge: 0x5c9b36,
  tarmac: 0x4a5058,
  gravel: 0xc8a878,
  kerbRed: 0xe23b2c,
  kerbWhite: 0xf4f6f8,
  barrier: 0xc8d2dc,
  tyre: 0x22262b,
  steel: 0x3b4550,
  trunk: 0x7a5533,
  leaf: 0x3f8f3a,
  leafDark: 0x2f6f2c,
} as const;

/** Arah matahari (dipakai light rig, bayangan, dan sprite matahari). */
export const SUN_DIRECTION = new THREE.Vector3(45, 66, 26).normalize();

let ramp: THREE.DataTexture | null = null;

/**
 * Gradasi 4 langkah untuk cel shading. `NearestFilter` yang membuat batas
 * antar-langkah tajam — itulah yang membuat permukaan terlihat "digambar",
 * bukan di-blur.
 */
export function toonRamp(): THREE.DataTexture {
  if (ramp) return ramp;
  // Lima langkah: cukup posterisasi untuk gaya kartun, tapi tidak "pita" kasar
  // seperti 3–4 langkah.
  const steps = [92, 140, 186, 224, 252];
  const data = new Uint8Array(steps.length * 4);
  for (let i = 0; i < steps.length; i++) {
    data[i * 4 + 0] = steps[i];
    data[i * 4 + 1] = steps[i];
    data[i * 4 + 2] = steps[i];
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, steps.length, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  ramp = tex;
  return tex;
}

export interface ToonOptions {
  color?: THREE.ColorRepresentation;
  map?: THREE.Texture | null;
  side?: THREE.Side;
  transparent?: boolean;
  opacity?: number;
  alphaTest?: number;
  emissive?: THREE.ColorRepresentation;
  emissiveIntensity?: number;
  emissiveMap?: THREE.Texture | null;
  depthWrite?: boolean;
  fog?: boolean;
  name?: string;
  /** Kunci lain dari material lama (roughness, metalness, clearcoat, …) —
   *  sengaja ditelan supaya konversi material bisa dilakukan bertahap. */
  [key: string]: unknown;
}

/**
 * Material toon. Mengganti `MeshStandardMaterial` di mana-mana: hasilnya warna
 * rata dengan 4 tingkat terang/gelap, dan biaya shader-nya jauh lebih kecil.
 */
export function toon(options: ToonOptions = {}): THREE.MeshToonMaterial {
  const material = new THREE.MeshToonMaterial({
    color: options.color ?? 0xffffff,
    map: options.map ?? null,
    gradientMap: toonRamp(),
    side: options.side ?? THREE.FrontSide,
    transparent: options.transparent ?? false,
    opacity: options.opacity ?? 1,
    alphaTest: options.alphaTest ?? 0,
    depthWrite: options.depthWrite ?? true,
    fog: options.fog ?? true,
  });
  if (options.emissive !== undefined) material.emissive = new THREE.Color(options.emissive);
  if (options.emissiveIntensity !== undefined) material.emissiveIntensity = options.emissiveIntensity;
  if (options.emissiveMap) material.emissiveMap = options.emissiveMap;
  if (options.name) material.name = options.name;
  return material;
}

/**
 * Ubah material apa pun (termasuk material bawaan model GLB) jadi toon, dengan
 * warna/peta/emisi yang sama. Dipakai untuk bodi mobil impor supaya ikut
 * bergaya kartun tanpa mengubah modelnya.
 */
export function toonFrom(source: THREE.Material, paint?: THREE.Color): THREE.MeshToonMaterial {
  const src = source as THREE.MeshStandardMaterial;
  const out = toon({
    color: paint ?? src.color ?? 0xffffff,
    map: src.map ?? null,
    side: src.side,
    transparent: src.transparent,
    opacity: src.opacity,
    alphaTest: src.alphaTest,
    emissive: src.emissive ? src.emissive.getHex() : 0x000000,
    emissiveIntensity: src.emissiveIntensity ?? 0,
    emissiveMap: src.emissiveMap ?? null,
    depthWrite: src.depthWrite,
    name: src.name,
  });
  return out;
}

/**
 * Rig matahari: satu directional light + satu hemisphere, plus shadow map yang
 * **mengikuti mobil** (frustum orto sempit ±48 m) supaya bayangan tetap tajam
 * tanpa harus merender seluruh arena tiap frame.
 *
 * Tidak menyentuh DOM, jadi bisa diuji di Node. `follow()` dipanggil tiap frame.
 */
export interface SunRig {
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  /** Shadow map aktif? (di HP lemah sengaja dimatikan.) */
  readonly shadows: boolean;
  /** Geser frustum bayangan supaya selalu di sekitar titik fokus. */
  follow(focus: THREE.Vector3): void;
}

export function createSunRig(scene: THREE.Scene, lowQuality = false): SunRig {
  const hemi = new THREE.HemisphereLight(0xdaf0ff, 0x6f7f4a, 0.72);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff2d6, 1.55);
  const direction = SUN_DIRECTION;
  sun.position.copy(direction).multiplyScalar(120);
  scene.add(sun);
  scene.add(sun.target);

  // Sedikit cahaya pantul dari bawah: bagian gelap tidak menjadi hitam pekat.
  const bounce = new THREE.DirectionalLight(0x9fd0ff, 0.18);
  bounce.position.set(-40, 22, -55);
  scene.add(bounce);

  // Di HP lemah bayangan asli terlalu mahal (satu pass penuh per frame),
  // jadi di sana tetap pakai bayangan blob.
  const shadows = !lowQuality;
  if (shadows) {
    const size = lowQuality ? 1024 : 2048;
    sun.castShadow = true;
    sun.shadow.mapSize.set(size, size);
    const span = lowQuality ? 34 : 48;
    sun.shadow.camera.left = -span;
    sun.shadow.camera.right = span;
    sun.shadow.camera.top = span;
    sun.shadow.camera.bottom = -span;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 260;
    // Ukuran texel shadow = 2·span / mapSize ≈ 4,7 cm, jadi normalBias cukup
    // sebesar itu; lebih besar bikin bayangan "lepas" dari mobil.
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.06;
    sun.shadow.camera.updateProjectionMatrix();
  }

  const follow = (focus: THREE.Vector3) => {
    // Arah matahari konstan; hanya frustum-nya yang ikut mobil.
    sun.target.position.copy(focus);
    sun.target.updateMatrixWorld();
    sun.position.copy(focus).addScaledVector(direction, 120);
  };

  return { sun, hemi, shadows, follow };
}

/** Bayangan mobil versi kartun: lingkaran hitam lembut, bukan shadow map. */
export function createBlobShadow(radius = 1.45, opacity = 0.34): THREE.Mesh {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 31);
  g.addColorStop(0, 'rgba(8,12,16,0.95)');
  g.addColorStop(0.55, 'rgba(8,12,16,0.55)');
  g.addColorStop(1, 'rgba(8,12,16,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(radius * 2, radius * 2.4),
    new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      opacity,
      depthWrite: false,
      fog: false,
    }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 2;
  mesh.name = 'blob-shadow';
  return mesh;
}

/**
 * Matahari: satu sprite (selalu menghadap kamera) dengan gradasi radial.
 * Murah — tidak perlu bloom pass — tapi langsung memberi kesan "ada matahari".
 */
export function createSunSprite(radius = 340): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 2, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,250,1)');
  g.addColorStop(0.18, 'rgba(255,250,225,0.95)');
  g.addColorStop(0.42, 'rgba(255,238,190,0.35)');
  g.addColorStop(1, 'rgba(255,235,190,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false }),
  );
  sprite.scale.setScalar(radius * 0.16);
  sprite.position.copy(SUN_DIRECTION).multiplyScalar(radius * 0.82);
  sprite.name = 'sun';
  sprite.renderOrder = -1;
  return sprite;
}

/**
 * Langit kartun: kubah dengan gradasi dua warna. Satu draw call, tanpa
 * pencahayaan, dan tidak terkena kabut (kalau terkena, horizon jadi abu-abu).
 */
export function createSky(top: number, horizon: number, radius = 520): THREE.Mesh {
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, 128);
  const deep = new THREE.Color(top).multiplyScalar(0.82);
  g.addColorStop(0, deep.getStyle());
  g.addColorStop(0.28, new THREE.Color(top).getStyle());
  g.addColorStop(0.6, new THREE.Color(top).lerp(new THREE.Color(horizon), 0.5).getStyle());
  g.addColorStop(0.82, new THREE.Color(top).lerp(new THREE.Color(horizon), 0.85).getStyle());
  g.addColorStop(1, new THREE.Color(horizon).getStyle());
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 2, 128);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;

  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 16, 12),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false, depthWrite: false }),
  );
  dome.name = 'sky';
  dome.renderOrder = -1;
  dome.frustumCulled = false;
  return dome;
}
