import * as THREE from 'three';

export interface PuffStyle {
  /** Ukuran awal partikel (satuan dunia, meter). */
  size: number;
  /** Berapa meter partikel membesar selama hidupnya. */
  grow: number;
  /** Warna asap/debu. */
  color: THREE.ColorRepresentation;
  /** Umur, detik. */
  life: number;
  /** Kecepatan naik, m/s. */
  rise: number;
  /** Sebaran kecepatan awal, m/s. */
  spread: number;
  /** Alpha awal 0..1. */
  opacity: number;
}

/**
 * Asap & debu ban: satu `Points` dengan kolam partikel tetap.
 *
 * Semua data partikel hidup di buffer yang sama (posisi, ukuran, alpha, warna),
 * jadi mengepulkan asap tidak pernah mengalokasikan objek — penting karena
 * dengan enam mobil, asap bisa muncul puluhan kali per detik.
 */
export class SmokePuffs {
  readonly points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;

  private readonly capacity: number;
  private readonly position: Float32Array;
  private readonly size: Float32Array;
  private readonly alpha: Float32Array;
  private readonly color: Float32Array;

  private readonly vel: Float32Array;
  private readonly age: Float32Array;
  private readonly maxAge: Float32Array;
  private readonly baseAlpha: Float32Array;
  private readonly baseSize: Float32Array;
  private readonly grow: Float32Array;
  private cursor = 0;
  private live = 0;

  /** Warna sementara: `spawn` tidak boleh mengalokasikan apa pun per partikel. */
  private static readonly tintColor = new THREE.Color();

  constructor(capacity = 480) {
    this.capacity = capacity;
    this.position = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);
    this.color = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.age = new Float32Array(capacity);
    this.maxAge = new Float32Array(capacity);
    this.baseAlpha = new Float32Array(capacity);
    this.baseSize = new Float32Array(capacity);
    this.grow = new Float32Array(capacity);
    // Kolamnya kosong: umur maksimum 0 = tidak ada partikel yang hidup.
    this.maxAge.fill(0);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.position, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(this.color, 3));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 2000);

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uScale: { value: 320 },
      },
      vertexShader: /* glsl */ `
        attribute float aSize;
        attribute float aAlpha;
        attribute vec3 aColor;
        uniform float uScale;
        varying float vAlpha;
        varying vec3 vColor;
        void main() {
          vAlpha = aAlpha;
          vColor = aColor;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          // Perspektif: makin jauh makin kecil, tapi tidak pernah hilang total.
          gl_PointSize = aSize * uScale / max(1.0, -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vAlpha;
        varying vec3 vColor;
        void main() {
          if (vAlpha <= 0.002) discard;
          vec2 d = gl_PointCoord - vec2(0.5);
          float r2 = dot(d, d);
          if (r2 > 0.25) discard;
          // Lingkaran lembut: pusat pekat, tepi hilang tanpa garis batas.
          float a = smoothstep(0.25, 0.0, r2) * vAlpha;
          gl_FragColor = vec4(vColor, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
    });

    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
    this.points.name = 'smoke';
  }

  /** Skala ukuran titik mengikuti pixel ratio layar (retina = 2x). */
  setPixelRatio(ratio: number): void {
    this.points.material.uniforms.uScale.value = 320 * ratio;
  }

  /** Jumlah partikel yang masih hidup (dipakai uji & debug). */
  get alive(): number {
    return this.live;
  }

  get maxCount(): number {
    return this.capacity;
  }

  /**
   * Munculkan satu kepulan di `p`, dengan dorongan awal `push` (mis. ke arah
   * belakang ban yang selip).
   */
  spawn(p: THREE.Vector3, style: PuffStyle, push?: THREE.Vector3): void {
    const i = this.cursor;
    this.cursor = (i + 1) % this.capacity;

    const s = style.spread;
    this.position[i * 3 + 0] = p.x;
    this.position[i * 3 + 1] = p.y;
    this.position[i * 3 + 2] = p.z;

    this.vel[i * 3 + 0] = (push?.x ?? 0) + (Math.random() - 0.5) * s;
    this.vel[i * 3 + 1] = style.rise + Math.random() * s * 0.5;
    this.vel[i * 3 + 2] = (push?.z ?? 0) + (Math.random() - 0.5) * s;

    const c = SmokePuffs.tintColor.set(style.color);
    // Sedikit variasi warna supaya kepulan tidak terlihat seperti satu blob.
    const tint = 0.86 + Math.random() * 0.24;
    this.color[i * 3 + 0] = c.r * tint;
    this.color[i * 3 + 1] = c.g * tint;
    this.color[i * 3 + 2] = c.b * tint;

    this.age[i] = 0;
    this.maxAge[i] = style.life * (0.75 + Math.random() * 0.5);
    this.baseAlpha[i] = style.opacity;
    this.baseSize[i] = style.size * (0.75 + Math.random() * 0.5);
    this.grow[i] = style.grow;
    this.size[i] = this.baseSize[i];
    this.alpha[i] = style.opacity;
  }

  update(dt: number): void {
    let live = 0;
    for (let i = 0; i < this.capacity; i++) {
      const age = this.age[i];
      const life = this.maxAge[i];
      if (age >= life) {
        if (this.alpha[i] !== 0) this.alpha[i] = 0;
        continue;
      }
      const t = (age + dt) / life;
      this.age[i] = age + dt;
      if (t >= 1) {
        // Habis di frame ini: jangan dihitung hidup dan jangan digambar.
        this.alpha[i] = 0;
        continue;
      }
      const k = i * 3;
      this.position[k + 0] += this.vel[k + 0] * dt;
      this.position[k + 1] += this.vel[k + 1] * dt;
      this.position[k + 2] += this.vel[k + 2] * dt;

      // Mengambang lalu melambat: asap naik pelan, debu cepat berhenti.
      const drag = 1 - Math.min(0.9, dt * 1.7);
      this.vel[k + 0] *= drag;
      this.vel[k + 2] *= drag;
      this.vel[k + 1] = this.vel[k + 1] * drag + dt * 0.35;

      this.size[i] = this.baseSize[i] + this.grow[i] * t;
      // Naik cepat di awal, memudar di paruh kedua umur.
      this.alpha[i] = t < 0.15 ? this.baseAlpha[i] * (t / 0.15) : this.baseAlpha[i] * (1 - (t - 0.15) / 0.85);
      live++;
    }
    this.live = live;

    const geometry = this.points.geometry;
    (geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (geometry.getAttribute('aSize') as THREE.BufferAttribute).needsUpdate = true;
    (geometry.getAttribute('aAlpha') as THREE.BufferAttribute).needsUpdate = true;
    (geometry.getAttribute('aColor') as THREE.BufferAttribute).needsUpdate = true;
  }

  clear(): void {
    this.age.fill(0);
    this.maxAge.fill(0);
    this.alpha.fill(0);
    this.live = 0;
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.points.material.dispose();
  }
}
