import * as THREE from 'three';

/**
 * Percikan gravel: butir tanah/kerikil yang **terlempar** dari roda di
 * permukaan gravel — bukan debu halus (itu tugas `SmokePuffs`), tapi bongkahan
 * yang terbang, melengkung karena gravitasi, lalu mati saat menyentuh tanah.
 *
 * Satu `Points` dengan kolam tetap: tidak ada alokasi saat bermain, dan enam
 * mobil tetap murah. Ukurannya sengaja sedikit dilebihkan (0,15–0,45 m) supaya
 * percikannya terbaca dari kamera chase — kerikil asli 2 cm tidak akan terlihat
 * di layar 6 inci.
 */
export interface ClodStyle {
  /** Diameter partikel, meter. */
  size: number;
  /** Warna dasar butir. */
  color: THREE.ColorRepresentation;
  /** Umur, detik. */
  life: number;
  /** Kecepatan awal ke atas, m/s. */
  up: number;
  /** Sebaran acak ke samping, m/s. */
  spread: number;
  /** Dorongan ke belakang relatif terhadap kecepatan mobil (0..1). */
  back: number;
}

const GRAVITY = 15;

export class GravelSpray {
  readonly points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;

  private readonly capacity: number;
  private readonly position: Float32Array;
  private readonly size: Float32Array;
  private readonly alpha: Float32Array;
  private readonly color: Float32Array;

  private readonly vel: Float32Array;
  private readonly age: Float32Array;
  private readonly maxAge: Float32Array;
  private readonly baseSize: Float32Array;
  private readonly floor: Float32Array;
  private cursor = 0;
  private live = 0;
  private budget = 0;

  private static readonly tint = new THREE.Color();

  constructor(capacity = 420) {
    this.capacity = capacity;
    this.position = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);
    this.color = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.age = new Float32Array(capacity);
    this.maxAge = new Float32Array(capacity);
    this.baseSize = new Float32Array(capacity);
    this.floor = new Float32Array(capacity);
    this.maxAge.fill(0);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.position, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(this.color, 3));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 2000);

    const material = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 320 } },
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
          gl_PointSize = aSize * uScale / max(1.0, -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vAlpha;
        varying vec3 vColor;
        void main() {
          if (vAlpha <= 0.004) discard;
          vec2 d = gl_PointCoord - vec2(0.5);
          float r = length(d);
          if (r > 0.5) discard;
          // Tepi keras: kerikil punya batas, bukan kabut. Sedikit lebih terang
          // di tengah supaya terlihat seperti butir yang kena matahari.
          float a = vAlpha * smoothstep(0.5, 0.36, r);
          vec3 c = vColor * (0.78 + 0.55 * (0.5 - r));
          gl_FragColor = vec4(c, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
    });

    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    this.points.name = 'gravel-spray';
  }

  setPixelRatio(ratio: number): void {
    this.points.material.uniforms.uScale.value = 320 * ratio;
  }

  get alive(): number {
    return this.live;
  }

  get maxCount(): number {
    return this.capacity;
  }

  /**
   * Sisa jatah percikan untuk frame ini; dipanggil `CarEffects` di awal update
   * supaya enam mobil tidak membanjiri kolam saat semuanya di gravel.
   */
  beginFrame(budget = 6): void {
    this.budget = budget;
  }

  /** Sisa jatah frame ini (0 = jangan memanggil `spawn` lagi). */
  get remaining(): number {
    return this.budget;
  }

  /**
   * Lempar satu butir dari `p` ke arah belakang mobil (`back` harus vektor
   * satuan horizontal), dengan `speed` kecepatan mobil.
   */
  spawn(p: THREE.Vector3, back: THREE.Vector3, speed: number, style: ClodStyle): boolean {
    if (this.budget <= 0) return false;
    this.budget--;
    const i = this.cursor;
    this.cursor = (i + 1) % this.capacity;
    const k = i * 3;

    this.position[k] = p.x;
    this.position[k + 1] = p.y;
    this.position[k + 2] = p.z;
    this.floor[i] = p.y;

    const push = speed * style.back;
    this.vel[k] = back.x * push + (Math.random() - 0.5) * style.spread;
    this.vel[k + 1] = style.up * (0.72 + Math.random() * 0.6);
    this.vel[k + 2] = back.z * push + (Math.random() - 0.5) * style.spread;

    const c = GravelSpray.tint.set(style.color);
    const tint = 0.84 + Math.random() * 0.32;
    this.color[k] = c.r * tint;
    this.color[k + 1] = c.g * tint;
    this.color[k + 2] = c.b * tint;

    this.age[i] = 0;
    this.maxAge[i] = style.life * (0.8 + Math.random() * 0.5);
    this.baseSize[i] = style.size * (0.6 + Math.random() * 0.8);
    this.size[i] = this.baseSize[i];
    this.alpha[i] = 0.95;
    return true;
  }

  update(dt: number): void {
    let live = 0;
    for (let i = 0; i < this.capacity; i++) {
      const life = this.maxAge[i];
      if (life <= 0) continue;
      const age = this.age[i] + dt;
      if (age >= life) {
        this.maxAge[i] = 0;
        this.alpha[i] = 0;
        continue;
      }
      this.age[i] = age;
      const k = i * 3;
      this.vel[k + 1] -= GRAVITY * dt;
      const drag = 1 - Math.min(0.8, dt * 1.1);
      this.vel[k] *= drag;
      this.vel[k + 2] *= drag;
      this.position[k] += this.vel[k] * dt;
      this.position[k + 1] += this.vel[k + 1] * dt;
      this.position[k + 2] += this.vel[k + 2] * dt;

      // Menyentuh tanah: butirnya berhenti (jatuh ke rumput/aspal berikutnya)
      // lalu memudar cepat — bukan tembus tanah dan menghilang di bawahnya.
      if (this.position[k + 1] <= this.floor[i] + 0.02) {
        this.position[k + 1] = this.floor[i] + 0.02;
        this.maxAge[i] = Math.min(this.maxAge[i], age + 0.08);
        this.vel[k] *= 0.2;
        this.vel[k + 2] *= 0.2;
        this.vel[k + 1] = 0;
      }

      const t = age / life;
      this.size[i] = this.baseSize[i] * (1 - t * 0.35);
      this.alpha[i] = 0.95 * (1 - t * t * 0.85);
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
