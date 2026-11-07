import * as THREE from 'three';
import type { VehicleDamage } from '../vehicle/Damage';
import type { PitBoxPose } from '../world/track';

/**
 * Satu kunjungan pit (service park).
 *
 * Aturannya sama untuk pemain dan lawan: berhenti di kotakmu → kru bekerja
 * beberapa detik → semua kerusakan hilang (bodi, mesin, ban pecah/copot) dan
 * ban baru. Makin rusak mobilnya, makin lama servisnya — jadi pit bukan jalan
 * pintas gratis, tapi pilihan antara kehilangan waktu atau balapan dengan mobil
 * yang sudah hancur.
 *
 * Kelas ini cuma angka + posisi; tidak menyentuh DOM, jadi bisa diuji headless.
 */
export type PitPhase = 'idle' | 'approach' | 'service' | 'done';

/** Lama servis minimum, detik (angkat mobil + empat ban). */
const BASE_SERVICE = 4.2;
/** Tambahan karena bodi penyok, detik. */
const BODY_PENALTY = 2.6;
/** Tambahan per roda yang harus diganti, detik. */
const WHEEL_PENALTY = 0.9;
/** Jarak maksimum dari titik tengah kotak supaya servis dianggap sah. */
const BOX_RADIUS = 3.6;
/** Kecepatan maksimum saat masuk kotak, m/s. */
const MAX_ENTRY_SPEED = 2.5;

export interface PitCar {
  position: THREE.Vector3;
  speed: number;
  damage: VehicleDamage;
}

/** Perkiraan lama servis untuk kerusakan sekarang (detik). */
export function serviceTimeFor(damage: VehicleDamage): number {
  const body = Math.max(0, Math.min(1, damage.bodyHealth));
  const wheels = damage.wheels.filter((w) => w.lost || w.punctured).length;
  return BASE_SERVICE + BODY_PENALTY * (1 - body) + WHEEL_PENALTY * wheels;
}

export class PitStop {
  phase: PitPhase = 'idle';
  readonly box: PitBoxPose;
  /** Sisa waktu servis, detik (0 saat tidak servis). */
  remaining = 0;
  /** Total waktu servis kunjungan ini, detik. */
  total = 0;
  /** Berapa kali mobil ini sudah masuk pit (untuk HUD/statistik). */
  visits = 0;

  constructor(box: PitBoxPose) {
    this.box = box;
  }

  get busy(): boolean {
    return this.phase === 'approach' || this.phase === 'service';
  }

  /** 0..1 — kemajuan servis, dipakai HUD. */
  get progress(): number {
    return this.total > 0 ? 1 - this.remaining / this.total : 0;
  }

  /** Sudah di dalam kotak dan berhenti? Dipakai pemain untuk mulai servis. */
  inBox(car: PitCar): boolean {
    const dx = car.position.x - this.box.position.x;
    const dz = car.position.z - this.box.position.z;
    return Math.hypot(dx, dz) < BOX_RADIUS && Math.abs(car.speed) < MAX_ENTRY_SPEED;
  }

  begin(): void {
    if (this.phase === 'service') return;
    this.phase = 'service';
    this.visits++;
  }

  /**
   * Satu langkah. Mengembalikan true **tepat sekali** saat servis selesai —
   * di situ mobilnya sudah diperbaiki.
   */
  update(dt: number, car: PitCar): boolean {
    if (this.phase === 'done') {
      // Mobil harus keluar dulu sebelum kotak ini bisa dipakai lagi.
      if (!this.inBox(car)) this.phase = 'idle';
      return false;
    }
    if (this.phase !== 'service') {
      // Pemain: servis mulai sendiri begitu berhenti di dalam kotak.
      if (this.phase === 'idle' && this.inBox(car)) this.begin();
      else return false;
    }
    if (this.total <= 0) {
      this.total = serviceTimeFor(car.damage);
      this.remaining = this.total;
    }
    this.remaining -= dt;
    if (this.remaining > 0) return false;

    // Selesai: semua kerusakan hilang (bodi, mesin, ban) = mobil segar lagi.
    car.damage.reset();
    this.remaining = 0;
    this.phase = 'done';
    return true;
  }

  /** Batalkan tanpa memperbaiki apa pun (dipakai saat balapan diulang). */
  reset(): void {
    this.phase = 'idle';
    this.remaining = 0;
    this.total = 0;
  }
}
