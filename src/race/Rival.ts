import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { AutoPilot, type TrafficCar } from '../ai/AutoPilot';
import { defaultConfig, VehiclePhysics, type VehicleInput } from '../vehicle/VehiclePhysics';
import type { PathSample } from '../world/circuit';
import { LapCounter } from './LapCounter';

const RESPAWN_LIFT = 0.95;

export interface RivalSetup {
  /** Nama pembalap, dipakai papan klasemen + rekor lap. */
  name?: string;
  /** Kotak start di sebelah mobil pemain. */
  position: THREE.Vector3;
  yaw: number;
  /** Garis balap penuh (utama + joker) dan jarak garis start. */
  main: PathSample[];
  joker: PathSample[];
  startDistance: number;
  /** 0,8–1,0: seberapa ngebut lawan. */
  pace?: number;
  /** Geser garis lawan ke samping (meter) supaya tidak berebut garis. */
  laneOffset?: number;
  jokerEachLap?: boolean;
}

/**
 * Satu mobil lawan: `VehiclePhysics` + `AutoPilot` + penghitung putaran.
 *
 * Fisika, ban, dan lompatannya sama dengan mobil pemain — lawan tidak diberi
 * keuntungan apa pun selain garis balap yang sudah dihafal. Kalau terbalik atau
 * terlempar keluar trek, mobil ini dikembalikan **ke garis balap**, bukan ke
 * grid, supaya balapan tidak jadi kacau.
 */
export class Rival {
  readonly name: string;
  readonly car: VehiclePhysics;
  readonly pilot: AutoPilot;
  readonly counter: LapCounter;

  /** Lap tercepat yang pernah dicatat mobil ini, detik. */
  get bestLap(): number {
    return this.pilot.bestLap;
  }

  /** Sudah finis? Dipakai papan klasemen. */
  get odometer(): number {
    return this.counter.odometer;
  }

  private readonly grid: THREE.Vector3;
  private readonly gridYaw: number;
  private parked = false;

  constructor(world: RAPIER.World, setup: RivalSetup) {
    this.name = setup.name ?? 'Lawan';
    this.grid = setup.position.clone();
    this.gridYaw = setup.yaw;
    this.car = new VehiclePhysics(world, defaultConfig, setup.position, setup.yaw);
    this.pilot = new AutoPilot(setup.main, setup.joker, {
      pace: setup.pace ?? 0.94,
      laneOffset: setup.laneOffset ?? -2.0,
      useJoker: setup.jokerEachLap ?? true,
    });
    this.counter = new LapCounter(setup.main, setup.startDistance, setup.position);
    this.pilot.reset(this.car.position);
  }

  get lap(): number {
    return this.counter.lap;
  }

  /**
   * Satu langkah fisika. Panggil di dalam loop substep, sebelum `world.step()`.
   * `others` dipakai supaya lawan tidak menabrak mobil pemain dari belakang.
   */
  step(dt: number, others: ReadonlyArray<TrafficCar> = []): VehicleInput | null {
    if (this.parked) return null;
    // Mobil yang terbalik atau menabrak **tidak** diteleportasi: biar apa
    // adanya. Yang jatuh jauh di bawah dunia (keluar peta) tetap dikembalikan
    // ke garis, karena itu bukan kecelakaan melainkan bug fisika.
    if (this.car.position.y < -20) this.respawn();
    const command = this.pilot.update(dt, this.car, others);
    this.car.fixedStep(dt, command);
    return command;
  }

  /** Sinkronkan transform + hitung putaran. Panggil setelah `world.step()`. */
  sync() {
    if (this.parked) return;
    this.car.sync();
    this.counter.update(this.car.position);
  }

  /** Balapan diulang: kembali ke kotak start. */
  resetToGrid() {
    this.parked = false;
    this.car.placeAt(this.grid, this.gridYaw);
    this.pilot.reset(this.car.position);
    this.counter.reset(this.car.position);
  }

  /** Lawan dimatikan: sembunyikan di luar trek (bukan dihapus dari dunia). */
  park(far = new THREE.Vector3(330, 1, 330)) {
    this.parked = true;
    this.car.placeAt(far, this.gridYaw);
  }

  get isParked(): boolean {
    return this.parked;
  }

  /** Kembalikan mobil ke garis balap, tegak, menghadap arah putaran. */
  respawn() {
    const sample = this.pilot.sample;
    const pos = new THREE.Vector3(sample.pos.x, sample.pos.y + RESPAWN_LIFT, sample.pos.z);
    this.car.placeAt(pos, Math.atan2(sample.tangent.x, sample.tangent.z));
    this.pilot.reset(this.car.position);
  }
}
