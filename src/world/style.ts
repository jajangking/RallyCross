import * as THREE from 'three';

/**
 * Gaya visual: **PBR sinematik** (bukan kartun).
 *
 * Seluruh arena memakai `MeshStandardMaterial`/`MeshPhysicalMaterial`: ada
 * environment map yang dipanggang dari langitnya sendiri, peta normal (jalan,
 * gravel, bodi mobil), peta kekasaran, dan post-processing (AO kontak +
 * bloom + tone mapping). Tidak ada lagi cel shading, gradasi bertingkat, atau
 * `MeshStandardMaterial` di mana pun — itulah yang membuat tampilannya terbaca
 * sebagai game balap, bukan mainan.
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

export interface SurfaceOptions {
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
 * Material permukaan: **selalu PBR**. Aspal sedikit kasar, logam/pagar
 * memantul, dan semua peta dari model GLB (normal, roughness, metalness, AO)
 * tetap dipakai — inilah yang membuat bodi mobil terlihat "berbentuk" dan
 * bukan sekadar bidang berwarna.
 *
 * (Dulu fungsi ini punya kembaran `MeshStandardMaterial` untuk gaya kartun; jalur
 * itu sudah dihapus — satu gaya, satu jalur kode.)
 */
export function surface(options: SurfaceOptions = {}): THREE.MeshStandardMaterial {
  const clearcoat = options.clearcoat as number | undefined;
  const base = {
    color: options.color ?? 0xffffff,
    map: options.map ?? null,
    roughness: (options.roughness as number) ?? 0.78,
    metalness: (options.metalness as number) ?? 0.06,
    side: options.side ?? THREE.FrontSide,
    transparent: options.transparent ?? false,
    opacity: options.opacity ?? 1,
    alphaTest: options.alphaTest ?? 0,
    depthWrite: options.depthWrite ?? true,
    fog: options.fog ?? true,
    envMapIntensity: (options.envMapIntensity as number) ?? 0.6,
  };
  // Clearcoat hanya ada di MeshPhysicalMaterial; dipakai khusus cat bodi.
  const material =
    clearcoat === undefined
      ? new THREE.MeshStandardMaterial(base)
      : new THREE.MeshPhysicalMaterial({
          ...base,
          clearcoat,
          clearcoatRoughness: (options.clearcoatRoughness as number) ?? 0.12,
        });
  if (options.normalMap) {
    material.normalMap = options.normalMap as THREE.Texture;
    if (options.normalScale) material.normalScale = options.normalScale as THREE.Vector2;
  }
  if (options.roughnessMap) material.roughnessMap = options.roughnessMap as THREE.Texture;
  if (options.metalnessMap) material.metalnessMap = options.metalnessMap as THREE.Texture;
  if (options.aoMap) {
    material.aoMap = options.aoMap as THREE.Texture;
    material.aoMapIntensity = (options.aoMapIntensity as number) ?? 1;
  }
  if (options.emissive !== undefined) material.emissive = new THREE.Color(options.emissive);
  if (options.emissiveIntensity !== undefined) material.emissiveIntensity = options.emissiveIntensity;
  if (options.emissiveMap) material.emissiveMap = options.emissiveMap;
  if (options.name) material.name = options.name;
  return material;
}

/**
 * Ubah material apa pun (termasuk material bawaan model GLB) jadi gaya arena:
 * material PBR yang **mempertahankan** peta normal/roughness/metalness/AO
 * bawaan model, jadi bodi mobil impor terlihat seperti di game balap, bukan
 * seperti plastik.
 *
 * Cat bodi (`paint` diisi) dapat lapisan clearcoat tipis: pantulan tajam di
 * atas warna livery — detail kecil yang paling terasa "mahal".
 */
export function surfaceFrom(source: THREE.Material, paint?: THREE.Color): THREE.MeshStandardMaterial {
  const src = source as THREE.MeshStandardMaterial;
  const shared: SurfaceOptions = {
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
  };
  {
    const standard = surface({
      ...shared,
      roughness: paint ? 0.34 : (src.roughness ?? 0.8),
      metalness: paint ? 0.22 : (src.metalness ?? 0.04),
      envMapIntensity: paint ? 1.15 : 0.75,
      clearcoat: paint ? 0.55 : undefined,
      normalMap: src.normalMap ?? null,
      normalScale: src.normalScale,
      roughnessMap: src.roughnessMap ?? null,
      metalnessMap: src.metalnessMap ?? null,
      aoMap: src.aoMap ?? null,
    });
    return standard;
  }
}

/**
 * Peta lingkungan untuk mode PBR: langit gradasi + matahari terang, di-bake
 * sekali jadi PMREM. Tanpa ini material PBR terlihat matte dan kusam; dengan
 * ini logam/kaca memantulkan langit seperti di game balap sungguhan.
 *
 * Biayanya satu kali saat boot (render 6 sisi ke kubus kecil), bukan per frame.
 */
export function createEnvironment(
  renderer: THREE.WebGLRenderer,
  top: number,
  horizon: number,
  sun: number,
): THREE.Texture | null {
  try {
    const skyScene = new THREE.Scene();
    const domeMat = new THREE.MeshBasicMaterial({ color: horizon, side: THREE.BackSide, fog: false });
    const dome = new THREE.Mesh(new THREE.SphereGeometry(50, 16, 12), domeMat);
    skyScene.add(dome);

    // Piringan matahari: sumber utama kilau di bodi mobil dan kaca.
    const sunMat = new THREE.MeshBasicMaterial({ color: sun, fog: false });
    sunMat.color.multiplyScalar(6);
    const disc = new THREE.Mesh(new THREE.SphereGeometry(6, 12, 8), sunMat);
    disc.position.copy(SUN_DIRECTION).multiplyScalar(44);
    skyScene.add(disc);

    // Gradasi langit: dari biru tua di atas ke pucat di horizon.
    const canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const g = ctx.createLinearGradient(0, 0, 0, 64);
      g.addColorStop(0, new THREE.Color(top).getStyle());
      g.addColorStop(0.55, new THREE.Color(top).lerp(new THREE.Color(horizon), 0.6).getStyle());
      g.addColorStop(1, new THREE.Color(horizon).getStyle());
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 4, 64);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      dome.material = new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false });
    }

    const pmrem = new THREE.PMREMGenerator(renderer);
    const target = pmrem.fromScene(skyScene, 0, 0.5, 120);
    pmrem.dispose();
    dome.geometry.dispose();
    disc.geometry.dispose();
    return target.texture;
  } catch {
    // Tanpa PMREM pun materialnya tetap jalan (cuma kurang memantul).
    return null;
  }
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
  // Langit dipakai sebagai environment map, jadi cahaya langsungnya diturunkan
  // sedikit — kalau tidak, aspal dan bodi mobil jadi "gebyar".
  const hemi = new THREE.HemisphereLight(0xdaf0ff, 0x6f7f4a, 0.42);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff2d6, 1.35);
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

/** Bayangan mobil murah (blob) untuk perangkat lemah, bukan shadow map. */
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
 * Langit: kubah dengan gradasi dua warna. Satu draw call, tanpa
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
