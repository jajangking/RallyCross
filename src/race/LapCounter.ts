import * as THREE from 'three';
import type { PathSample } from '../world/circuit';

/**
 * Menghitung putaran satu mobil murni dari posisinya — tanpa menyentuh fisika,
 * jadi bisa dipakai untuk mobil pemain maupun lawan.
 *
 * Patokannya garis start/finish yang digambar di trek (`startDistance`), bukan
 * ujung array spline: posisi itu dihitung dengan "odometer" yang tidak pernah
 * wrap, sehingga mobil yang mundur melewati garis juga terhitung benar.
 */
export class LapCounter {
  /** Putaran yang sudah selesai (0 sebelum melewati garis untuk pertama kali). */
  lap = 0;
  /** Meter sejak garis start/finish; negatif kalau masih di belakang garis. */
  odometer: number;

  private readonly length: number;
  private index = 0;
  private prevDistance: number;
  /** Posisi frame sebelumnya: dipakai saat mobil melewati sambungan lingkaran. */
  private readonly prevPos = new THREE.Vector3();

  /** `at` = posisi awal mobil (default: garis start) supaya sample awalnya pas. */
  constructor(
    private readonly path: PathSample[],
    private readonly startDistance: number,
    at?: THREE.Vector3,
  ) {
    // Panjang putaran = jarak antar-sample + celah penutup dari sample terakhir
    // kembali ke sample pertama; kalau celah itu tidak dihitung, odometer
    // kehilangan beberapa sentimeter tiap putaran.
    const last = path[path.length - 1];
    this.length = last.distance + last.pos.distanceTo(path[0].pos);
    this.index = this.nearest(path, at ?? this.startPoint(), 0);
    this.odometer = path[this.index].distance - startDistance;
    this.prevDistance = path[this.index].distance;
    this.prevPos.copy(path[this.index].pos);
  }

  /** Meter dari garis start/finish pada putaran yang sedang berjalan (0..length). */
  get lapDistance(): number {
    return ((this.odometer % this.length) + this.length) % this.length;
  }

  /** Kembali ke garis start (dipakai saat balapan diulang dari grid). */
  reset(at?: THREE.Vector3) {
    this.lap = 0;
    this.index = this.nearest(this.path, at ?? this.startPoint(), 0);
    this.odometer = this.path[this.index].distance - this.startDistance;
    this.prevDistance = this.path[this.index].distance;
    this.prevPos.copy(this.path[this.index].pos);
  }

  /**
   * Pindahkan patokan ke posisi sekarang **tanpa** mengubah odometer.
   * Dipakai kalau mobil dipindah bukan karena balapan (mis. diderek ke pit):
   * jarak derek tidak boleh dihitung sebagai kemajuan.
   */
  rebase(pos: THREE.Vector3) {
    this.index = this.nearest(this.path, pos, this.index);
    this.prevDistance = this.path[this.index].distance;
  }

  /** Panggil sekali per frame setelah posisi mobil diperbarui. */
  update(pos: THREE.Vector3) {
    const n = this.path.length;
    const prevIndex = this.index;
    const index = this.nearest(this.path, pos, this.index);
    this.index = index;
    const distance = this.path[index].distance;

    let delta = distance - this.prevDistance;
    // Lewat sambungan lingkaran: jarak antar-sample melompat satu putaran
    // penuh. Dulu kasus ini dibulatkan jadi 0, jadi tiap putaran kehilangan
    // satu langkah sampel dan penghitung lap bisa ketinggalan satu lap.
    const forwardWrap = prevIndex > n * 0.75 && index < n * 0.25;
    const backwardWrap = prevIndex < n * 0.25 && index > n * 0.75;
    if (forwardWrap) delta = this.length - this.prevDistance + distance;
    else if (backwardWrap) delta = -(this.length + this.prevDistance - distance);
    else if (delta > this.length / 2) delta -= this.length;
    else if (delta < -this.length / 2) delta += this.length;
    this.prevDistance = distance;
    this.prevPos.copy(pos);
    this.odometer += delta;
    // `+ 1e-6`: odometer bisa mendarat persis di batas putaran, dan sisa
    // pembulatan float bisa membuat satu putaran tidak terhitung.
    this.lap = Math.max(0, Math.floor((this.odometer + 1e-6) / this.length));
  }

  private startPoint(): THREE.Vector3 {
    // Titik pada garis start/finish, dipakai untuk menentukan sample awal.
    let best = this.path[0];
    let bestGap = Infinity;
    for (const s of this.path) {
      const gap = Math.abs(s.distance - this.startDistance);
      if (gap < bestGap) {
        bestGap = gap;
        best = s;
      }
    }
    return best.pos;
  }

  private nearest(path: PathSample[], p: THREE.Vector3, around: number): number {
    const n = path.length;
    let best = around;
    let bestD = Infinity;
    const dx0 = path[best]?.pos.x ?? 0;
    const dz0 = path[best]?.pos.z ?? 0;
    bestD = (dx0 - p.x) ** 2 + (dz0 - p.z) ** 2;
    const scan = (from: number, to: number) => {
      for (let k = from; k <= to; k++) {
        const i = ((k % n) + n) % n;
        const dx = path[i].pos.x - p.x;
        const dz = path[i].pos.z - p.z;
        const d = dx * dx + dz * dz;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    };
    scan(around - 25, around + 65);
    if (bestD > 40 * 40) {
      bestD = Infinity;
      scan(0, n - 1);
    }
    return best;
  }
}
