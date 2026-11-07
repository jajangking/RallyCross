import * as THREE from 'three';
import type { BroadcastSpot } from '../world/track';

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** Seberapa jauh di depan mobil sebuah kamera idealnya (meter). */
const IDEAL_LEAD = 22;
/** Jeda minimum sebelum gambar boleh dipotong lagi (detik). */
const MIN_DWELL = 1.6;

/**
 * "Sutradara" TV: memilih kamera tetap di pinggir trek yang paling pas membidik
 * mobil, lalu memotong antar kamera seperti siaran sungguhan.
 *
 * Pemilihannya berbasis **jarak sepanjang trek**, bukan jarak lurus: setiap
 * kamera tahu tikungan mana yang dia awasi, jadi gambar berpindah tikungan
 * demi tikungan (dan kamera yang sudah dilewati mobil tidak dipakai lagi)
 * walaupun dua tikungan kebetulan berdekatan secara geometris.
 */
export class BroadcastDirector {
  private index = -1;
  private dwellValue = 0;
  private cut = true;
  /** Detik sisa pilihan manual sebelum sutradara otomatis jalan lagi. */
  private manualFor = 0;

  constructor(private readonly spots: BroadcastSpot[]) {
    if (spots.length) this.index = 0;
  }

  get current(): BroadcastSpot | null {
    return this.index >= 0 ? this.spots[this.index] : null;
  }

  /** Sudah berapa lama kamera sekarang dipakai (detik). */
  get dwell(): number {
    return this.dwellValue;
  }

  /** Sekali pakai: true kalau kamera baru saja berganti (gambar harus "cut"). */
  takeCut(): boolean {
    const value = this.cut;
    this.cut = false;
    return value;
  }

  /**
   * Pilih kamera terbaik. `trackDistance` = posisi mobil dari garis start
   * (meter, 0..lapLength) di jalur yang sama dengan `BroadcastSpot.trackDistance`.
   */
  update(
    dt: number,
    focus: THREE.Vector3,
    trackDistance: number,
    lapLength: number,
  ): BroadcastSpot | null {
    if (!this.spots.length) return null;
    this.dwellValue += dt;
    if (this.manualFor > 0) {
      this.manualFor -= dt;
      return this.current;
    }

    let best = this.index;
    let bestScore = Infinity;
    for (let i = 0; i < this.spots.length; i++) {
      const spot = this.spots[i];
      const delta = (((spot.trackDistance - trackDistance) % lapLength) + lapLength) % lapLength;
      let score = Math.abs(delta - IDEAL_LEAD);
      if (delta > lapLength * 0.5) score += 260; // kameranya sudah di belakang mobil
      const angle = this.angle(spot, focus);
      score += angle * 14;
      // Kamera yang mobilnya kelihatan kecil (di seberang tikungan, jauh) jangan
      // dipakai: siaran selalu memilih sudut yang mobilnya masih "terbaca".
      tmpA.subVectors(focus, spot.position);
      score += Math.max(0, tmpA.length() - 80) * 1.5;
      if (i === this.index) score -= 10; // histeresis: jangan potong tanpa alasan
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }

    if (best !== this.index && (this.index < 0 || this.dwellValue > MIN_DWELL)) {
      this.index = best;
      this.dwellValue = 0;
      this.cut = true;
    }
    return this.current;
  }

  /**
   * Lompat ke kamera berikutnya. Sutradara otomatis berhenti sebentar (6 s)
   * supaya penonton sempat melihat sudut yang dia pilih.
   */
  next(): BroadcastSpot | null {
    if (!this.spots.length) return null;
    this.index = (this.index + 1) % this.spots.length;
    this.cut = true;
    this.manualFor = 6;
    this.dwellValue = 0;
    return this.current;
  }

  /** Lepas pilihan manual supaya sutradara otomatis langsung jalan lagi. */
  release() {
    this.manualFor = 0;
    this.dwellValue = 0;
  }

  private angle(spot: BroadcastSpot, focus: THREE.Vector3): number {
    tmpA.subVectors(focus, spot.position);
    const distance = tmpA.length();
    if (distance < 0.001) return 0;
    tmpA.divideScalar(distance);
    tmpB.subVectors(spot.aim, spot.position).normalize();
    return Math.acos(clamp(tmpA.dot(tmpB), -1, 1));
  }
}
