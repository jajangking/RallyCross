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

let ramp: THREE.DataTexture | null = null;

/**
 * Gradasi 4 langkah untuk cel shading. `NearestFilter` yang membuat batas
 * antar-langkah tajam — itulah yang membuat permukaan terlihat "digambar",
 * bukan di-blur.
 */
export function toonRamp(): THREE.DataTexture {
  if (ramp) return ramp;
  const steps = [96, 168, 224, 255];
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
 * Langit kartun: kubah dengan gradasi dua warna. Satu draw call, tanpa
 * pencahayaan, dan tidak terkena kabut (kalau terkena, horizon jadi abu-abu).
 */
export function createSky(top: number, horizon: number, radius = 520): THREE.Mesh {
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, 128);
  g.addColorStop(0, new THREE.Color(top).getStyle());
  g.addColorStop(0.62, new THREE.Color(top).lerp(new THREE.Color(horizon), 0.55).getStyle());
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
