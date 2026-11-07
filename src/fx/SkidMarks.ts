import * as THREE from 'three';

/**
 * Jejak ban di permukaan trek.
 *
 * Semua jejak masuk ke **satu** mesh: buffer quad dipakai bergiliran (ring
 * buffer), jadi bisa ribuan potong jejak tanpa satu pun `Mesh` baru — tidak ada
 * GC di tengah balapan. Kalau buffer penuh, quad paling tua ditimpa; itu juga
 * cara jejak lama "hilang" pelan-pelan tanpa perlu redup per frame.
 *
 * Alpha per titik disimpan di atribut sendiri (bukan `vertexColors`) supaya
 * jejak bisa setengah transparan di atas aspal tanpa material tambahan.
 */
export class SkidMarks {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;

  private readonly position: Float32Array;
  private readonly alpha: Float32Array;
  private readonly capacity: number;
  private cursor = 0;
  private drawn = 0;
  /** Rentang elemen yang berubah sejak upload terakhir. */
  private dirtyFrom = -1;
  private dirtyTo = -1;

  constructor(capacity = 6000) {
    this.capacity = capacity;
    this.position = new Float32Array(capacity * 4 * 3);
    this.alpha = new Float32Array(capacity * 4);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.position, 3));
    geometry.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1));
    geometry.setIndex(SkidMarks.buildIndices(capacity));
    geometry.setDrawRange(0, 0);
    // Jejak tersebar sepanjang trek; tanpa bounding sphere besar, three akan
    // menganggapnya hilang saat kamera menjauh dari titik asal.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 2000);

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(0x0c0c0e) },
      },
      vertexShader: /* glsl */ `
        attribute float alpha;
        varying float vAlpha;
        void main() {
          vAlpha = alpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying float vAlpha;
        void main() {
          if (vAlpha < 0.004) discard;
          gl_FragColor = vec4(uColor, vAlpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.name = 'skid-marks';
    this.mesh.matrixAutoUpdate = false;
  }

  /** Jumlah potong jejak yang saat ini tergambar. */
  get count(): number {
    return this.drawn;
  }

  get length(): number {
    return this.capacity;
  }

  /**
   * Tambah satu potong jejak: dua pasang tepi ban (kiri/kanan) pada posisi
   * `a` (sebelumnya) dan `b` (sekarang). Semua titik sudah di ruang dunia dan
   * sudah diangkat sedikit dari permukaan oleh pemanggil.
   */
  add(
    aL: THREE.Vector3,
    aR: THREE.Vector3,
    bL: THREE.Vector3,
    bR: THREE.Vector3,
    strength: number,
  ): void {
    const a = Math.max(0, Math.min(1, strength));
    const i = this.cursor;
    const p = i * 12;
    const pos = this.position;
    pos[p + 0] = aL.x;
    pos[p + 1] = aL.y;
    pos[p + 2] = aL.z;
    pos[p + 3] = bL.x;
    pos[p + 4] = bL.y;
    pos[p + 5] = bL.z;
    pos[p + 6] = bR.x;
    pos[p + 7] = bR.y;
    pos[p + 8] = bR.z;
    pos[p + 9] = aR.x;
    pos[p + 10] = aR.y;
    pos[p + 11] = aR.z;

    // Tepi luar sedikit lebih tipis: jejak terlihat seperti tapak ban, bukan
    // garis kotak.
    const v = i * 4;
    this.alpha[v + 0] = a * 0.9;
    this.alpha[v + 1] = a * 0.9;
    this.alpha[v + 2] = a;
    this.alpha[v + 3] = a;

    if (this.dirtyFrom < 0 || i < this.dirtyFrom) this.dirtyFrom = i;
    if (i > this.dirtyTo) this.dirtyTo = i;

    this.cursor = (i + 1) % this.capacity;
    if (this.drawn < this.capacity) this.drawn++;
  }

  /** Upload perubahan ke GPU. Panggil sekali per frame, setelah semua tambahan. */
  flush(): void {
    const geometry = this.mesh.geometry;
    if (this.dirtyFrom < 0) {
      geometry.setDrawRange(0, this.drawn * 6);
      return;
    }
    const first = this.dirtyFrom;
    const last = this.dirtyTo;
    const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
    const alphaAttr = geometry.getAttribute('alpha') as THREE.BufferAttribute;
    // Range dihitung dalam *elemen array* (float), bukan vertex: posisi punya
    // 3 komponen per titik, alpha cuma 1.
    const verts = (last - first + 1) * 4;
    const firstVert = first * 4;
    SkidMarks.markRange(posAttr, firstVert * 3, verts * 3);
    SkidMarks.markRange(alphaAttr, firstVert, verts);
    posAttr.needsUpdate = true;
    alphaAttr.needsUpdate = true;
    geometry.setDrawRange(0, this.drawn * 6);
    this.dirtyFrom = -1;
    this.dirtyTo = -1;
  }

  clear(): void {
    this.position.fill(0);
    this.alpha.fill(0);
    this.cursor = 0;
    this.drawn = 0;
    this.dirtyFrom = -1;
    this.dirtyTo = -1;
    this.mesh.geometry.setDrawRange(0, 0);
    (this.mesh.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.mesh.geometry.getAttribute('alpha') as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }

  /** Kalau three mendukung upload sebagian, tandai hanya bagian yang berubah. */
  private static markRange(attr: THREE.BufferAttribute, start: number, count: number): void {
    const ranges = attr as unknown as {
      clearUpdateRanges?: () => void;
      addUpdateRange?: (start: number, count: number) => void;
    };
    if (typeof ranges.addUpdateRange !== 'function') return;
    ranges.clearUpdateRanges?.();
    ranges.addUpdateRange(start, count);
  }

  private static buildIndices(capacity: number): THREE.BufferAttribute {
    const index = new Uint32Array(capacity * 6);
    for (let i = 0; i < capacity; i++) {
      const v = i * 4;
      const k = i * 6;
      index[k + 0] = v;
      index[k + 1] = v + 1;
      index[k + 2] = v + 2;
      index[k + 3] = v;
      index[k + 4] = v + 2;
      index[k + 5] = v + 3;
    }
    return new THREE.BufferAttribute(index, 1);
  }
}
