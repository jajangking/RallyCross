import * as THREE from 'three';
import { toon } from '../world/style';
import type { VehicleConfig } from './VehiclePhysics';
import type { VehicleDamage } from './Damage';

/**
 * Kerusakan yang kelihatan: bodi yang penyok.
 *
 * Mobil balap tidak bisa di-*deform* mesh-nya secara real-time dengan murah,
 * jadi penyok digambar sebagai **patch gelap** yang muncul satu per satu di
 * posisi yang wajar (spakbor depan, pintu, buritan, bemper). Dari jarak kamera
 * mobil, hasilnya terbaca sebagai bodi penyok — dan biayanya nol sampai mobil
 * benar-benar rusak.
 */
interface DentSpec {
  readonly p: [number, number, number];
  readonly s: [number, number, number];
}

/** Posisi penyok dalam kerangka mobil (meter), sudah termasuk sisi kiri/kanan. */
const DENTS = (cfg: VehicleConfig): DentSpec[] => {
  const hw = cfg.halfWidth;
  const hl = cfg.halfLength;
  return [
    { p: [-hw * 0.92, 0.0, hl * 0.58], s: [0.7, 0.4, 1.15] }, // spakbor kiri depan
    { p: [hw * 0.94, -0.04, hl * 0.1], s: [0.65, 0.45, 1.3] }, // pintu kanan
    { p: [-hw * 0.88, 0.02, -hl * 0.62], s: [0.7, 0.4, 1.0] }, // buritan kiri
    { p: [0.22, -0.06, hl * 0.94], s: [1.15, 0.5, 0.6] }, // bemper depan
    { p: [hw * 0.9, 0.06, -hl * 0.5], s: [0.65, 0.4, 0.9] }, // buritan kanan
    { p: [-0.18, 0.19, hl * 0.5], s: [1.0, 0.4, 0.85] }, // kap mesin
  ];
};

/** Bagian visual mobil yang bisa kehilangan roda. */
export interface DamageVisualTarget {
  readonly root: THREE.Object3D;
  setWheelLost(index: number, lost: boolean): void;
}

export class CarDamageVisual {
  private readonly group = new THREE.Group();
  private readonly dents: THREE.Mesh[] = [];
  private root: THREE.Object3D | null = null;
  private wheelsGone = [false, false, false, false];
  private lastRevision = -1;

  constructor(cfg: VehicleConfig, paint = 0xd8402f) {
    // Penyok = cat yang sama, tapi jauh lebih gelap: di mobil merah kelihatan
    // merah tua, di mobil putih kelihatan abu tua. Bukan tempelan hitam.
    const dentColor = new THREE.Color(paint).multiplyScalar(0.42);
    const material = toon({ color: dentColor.getHex() });
    const geometry = new THREE.SphereGeometry(0.24, 8, 6);
    for (const spec of DENTS(cfg)) {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(spec.p[0], spec.p[1], spec.p[2]);
      mesh.scale.set(spec.s[0], spec.s[1], spec.s[2]);
      mesh.visible = false;
      mesh.name = 'dent';
      this.group.add(mesh);
      this.dents.push(mesh);
    }
    this.group.name = 'car-damage';
  }

  /**
   * Pasang ke root visual mobil. Wajib dipanggil ulang saat model GLB selesai
   * dimuat (root-nya diganti).
   */
  private attach(root: THREE.Object3D) {
    if (this.root === root) return;
    this.group.removeFromParent();
    this.root = root;
    root.add(this.group);
    this.lastRevision = -1;
    this.wheelsGone = [false, false, false, false];
  }

  /**
   * Samakan tampilan mobil dengan kerusakannya. Dipanggil tiap frame, tapi
   * langsung keluar kalau tidak ada yang berubah — jadi biayanya nol.
   */
  sync(visual: DamageVisualTarget, damage: VehicleDamage) {
    this.attach(visual.root);
    if (damage.revision === this.lastRevision) return;
    this.lastRevision = damage.revision;

    // Roda yang copot: mesh roda disembunyikan dari visual yang aktif sekarang.
    for (let i = 0; i < 4; i++) {
      const lost = damage.wheels[i].lost;
      if (lost === this.wheelsGone[i]) continue;
      this.wheelsGone[i] = lost;
      visual.setWheelLost(i, lost);
    }
    const level = damage.dentLevel;
    // 0 penyok saat utuh, 6 saat bodi habis.
    const visible = Math.round(level * this.dents.length);
    for (let i = 0; i < this.dents.length; i++) this.dents[i].visible = i < visible;
    // Bodi yang sudah parah sedikit "miring" — seperti sasis yang bengkok.
    this.group.rotation.z = -level * 0.05;
    this.group.position.y = -level * 0.03;
  }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.geometry.dispose();
    });
  }
}
