import * as THREE from 'three';
import { TRACK } from '../world/track';

/**
 * Susunan peserta. Grid dibuat **2 mobil per baris** di belakang mobil pemain,
 * jadi enam mobil (pemain + 5 lawan) tetap muat di trek 16 m dan startnya
 * terlihat seperti barisan rallycross sungguhan.
 *
 * Tiap lawan punya `pace` dan `laneOffset` sendiri supaya mereka saling
 * mengejar (bukan berbaris rapi), dan sebagian memilih joker lap tiap putaran
 * sehingga jalurnya bercabang — bagus untuk kamera TV dan untuk memecahkan
 * rekor lap.
 */
export interface RivalPlan {
  name: string;
  /** Warna cat mobil. */
  color: number;
  /** Pengali target kecepatan AI (1 = secepat mungkin). */
  pace: number;
  /** Geseran garis balap, meter. */
  laneOffset: number;
  /** Meter di belakang garis start (baris grid). */
  behind: number;
  /** Geseran ke samping dari garis tengah pada barisnya, meter. */
  side: number;
  /** Selalu lewat joker? Kalau tidak, ikut garis utama tiap lap. */
  jokerEachLap: boolean;
}

/** Lima lawan, sengaja beda karakter: pebalap cepat, pemburu joker, pemula. */
export const RIVAL_PLANS: readonly RivalPlan[] = [
  { name: 'Krisna', color: 0xc22a1c, pace: 1.0, laneOffset: -1.2, behind: 18, side: -3.6, jokerEachLap: true },
  { name: 'Bagas', color: 0x2d7ce0, pace: 0.985, laneOffset: 1.2, behind: 18, side: 3.6, jokerEachLap: false },
  { name: 'Sari', color: 0xf2c53d, pace: 0.97, laneOffset: -0.6, behind: 25, side: -3.6, jokerEachLap: true },
  { name: 'Damar', color: 0x3fbf7f, pace: 0.955, laneOffset: 0.6, behind: 25, side: 3.6, jokerEachLap: false },
  { name: 'Nadia', color: 0xb56cff, pace: 0.94, laneOffset: 0, behind: 32, side: 0, jokerEachLap: true },
];

/** Pose grid untuk satu peserta. Pemain memakai baris paling depan. */
export function gridPose(plan: Pick<RivalPlan, 'behind' | 'side'>): {
  position: THREE.Vector3;
  yaw: number;
} {
  const pose = TRACK.at(TRACK.start - plan.behind);
  return {
    position: new THREE.Vector3(pose.pos.x, 0.95, pose.pos.z).addScaledVector(pose.side, plan.side),
    yaw: pose.yaw,
  };
}
