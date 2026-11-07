import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { AutoPilot, type TrafficCar } from '../ai/AutoPilot';
import { defaultConfig, VehiclePhysics, type VehicleInput } from '../vehicle/VehiclePhysics';
import type { PathSample } from '../world/circuit';
import { LapCounter } from './LapCounter';
import { PitStop } from './PitStop';
import { pitPose, type PitBoxPose } from '../world/track';

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
  /** Pace dasar dari nalar AI + panel (tanpa agresivitas balapan). */
  private basePace: number;
  /** Geseran lajur bawaan dari `grid.ts`, meter. */
  private readonly laneOffset: number;
  /**
   * Pengali agresivitas dari situasi balapan (0,99..1,02). Yang tertinggal
   * menekan lebih keras, yang memimpin jauh mengendur sedikit — inilah yang
   * membuat mereka saling memburu sepanjang balapan, bukan berbaris sendiri.
   */
  craft = 1;
  /** Pengali dari pengawas balapan (bendera kuning = pelan). */
  private controlScale = 1;
  /** Kunjungan pit yang sedang berjalan. */
  pit: PitStop | null = null;
  /** Fase pit AI: tidak di pit, menuju kotak, servis, atau keluar lagi. */
  pitPhase: 'none' | 'toPit' | 'service' | 'out' = 'none';
  private rejoin: THREE.Vector3 | null = null;
  /** Detik sejak mulai menuju kotak pit (untuk batas waktu). */
  private pitTime = 0;
  /** Rute masuk pit: titik masuk apron, lalu kotaknya sendiri. */
  private pitRoute: THREE.Vector3[] = [];
  private pitRouteIndex = 0;

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
    this.basePace = this.pilot.options.pace;
    this.laneOffset = setup.laneOffset ?? -2.0;
  }

  get lap(): number {
    return this.counter.lap;
  }

  /** Terapkan hasil belajar: pace, asumsi grip/rem, dan garis yang makin rapi. */
  applySkill(tuning: { pace: number; gripTarmac: number; brakeTarmac: number; laneTighten: number }, paceScale = 1) {
    this.pilot.options.gripTarmac = tuning.gripTarmac;
    this.pilot.options.brakeTarmac = tuning.brakeTarmac;
    // Makin berpengalaman, makin kecil geseran lajurnya: dia mendekati garis
    // tercepat dan hanya bergeser saat benar-benar menyalip.
    this.pilot.setLaneOffset(this.laneOffset * (1 - 0.75 * tuning.laneTighten));
    this.setBasePace(tuning.pace * paceScale);
  }

  /** Pace dasar (nalar AI × panel). Agresivitas balapan dikalikan di atasnya. */
  setBasePace(pace: number) {
    this.basePace = pace;
    this.applyPace();
  }

  /** Pengawas balapan memperlambat semua mobil (bendera kuning). */
  setControlScale(scale: number) {
    this.controlScale = scale;
    this.applyPace();
  }

  private applyPace() {
    this.pilot.options.pace = this.basePace * this.craft * this.controlScale;
  }

  /** Sedang di area servis? (main memakainya untuk tidak memanggil dua kali) */
  get inPit(): boolean {
    return this.pitPhase !== 'none';
  }

  /**
   * Minta masuk pit: menuju kotaknya, servis, lalu kembali ke garis balap.
   * `rejoin` = titik di garis balap tempat dia kembali.
   */
  requestPit(box: PitBoxPose, rejoin: THREE.Vector3) {
    if (this.inPit) return;
    this.pit = new PitStop(box);
    this.rejoin = rejoin.clone();
    this.pitPhase = 'toPit';
    this.pitTime = 0;
    // Belok langsung dari garis balap ke kotak = sudut terlalu tajam (mobil
    // melebar dan lewat). Jadi masuk bertahap: 26 m sebelum kotak mulai geser
    // ke apron, 10 m lagi lurus di apron, baru berhenti di kotak.
    const lapDistance = this.counter.lapDistance;
    const route: THREE.Vector3[] = [];
    if (box.distance - 30 > lapDistance + 8) route.push(pitPose(box.distance - 30, 5.8).position);
    if (box.distance - 12 > lapDistance + 4) route.push(pitPose(box.distance - 12, 5.8).position);
    route.push(box.position.clone());
    this.pitRoute = route;
    this.pitRouteIndex = 0;
  }

  /**
   * Beri tahu berapa meter dia tertinggal dari pemimpin. Tertinggal jauh =
   * menekan (maks +2 %), memimpin jauh = mengendur (maks −1 %). Perubahannya
   * dilembutkan supaya tidak terlihat seperti saklar.
   */
  setRaceGap(metres: number) {
    const want = Math.min(1.02, Math.max(0.99, 1 + (metres - 25) * 0.0004));
    // `dt` tidak dikirim: pemanggilnya sekali per frame (~60 Hz).
    this.craft += (want - this.craft) * 0.05;
    this.applyPace();
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
    if (this.pitPhase !== 'none' && this.pit) return this.pitStep(dt);
    const command = this.pilot.update(dt, this.car, others);
    this.car.fixedStep(dt, command);
    return command;
  }

  /** Satu langkah saat sedang masuk/keluar pit. */
  private pitStep(dt: number): VehicleInput {
    const pit = this.pit!;
    const car = this.car;
    const idle: VehicleInput = { throttle: 0, brake: 1, steer: 0, handbrake: false, gear: 1 };

    if (this.pitPhase === 'toPit') {
      // Batas waktu: kalau mobil terlalu rusak untuk sampai ke kotaknya,
      // batalkan saja (daripada merangkak sepanjang balapan).
      this.pitTime += dt;
      if (this.pitTime > 30) {
        this.pitPhase = 'none';
        this.pit = null;
        this.pilot.reset(car.position);
        return idle;
      }
      const target = this.pitRoute[this.pitRouteIndex] ?? pit.box.position;
      const lastLeg = this.pitRouteIndex >= this.pitRoute.length - 1;
      const command = this.pilot.driveTo(dt, car, target, {
        maxSpeed: lastLeg ? 5 : 8,
        stopDistance: lastLeg ? 0.4 : 3,
      });
      car.fixedStep(dt, command);
      if (!lastLeg) {
        const dist = Math.hypot(target.x - car.position.x, target.z - car.position.z);
        if (dist < 9) this.pitRouteIndex++;
      }
      if (pit.inBox(car)) {
        this.pitPhase = 'service';
        pit.begin();
      }
      return command;
    }

    if (this.pitPhase === 'service') {
      const done = pit.update(dt, car);
      car.fixedStep(dt, idle);
      if (done) this.pitPhase = 'out';
      return idle;
    }

    // Keluar: menyetir ke titik kembali, lalu serahkan lagi ke pilot balap.
    const target = this.rejoin ?? car.position;
    const command = this.pilot.driveTo(dt, car, target, { maxSpeed: 16, stopDistance: 3 });
    car.fixedStep(dt, command);
    const dist = Math.hypot(target.x - car.position.x, target.z - car.position.z);
    if (dist < 6) {
      this.pitPhase = 'none';
      this.pit = null;
      this.pilot.reset(car.position);
    }
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
    this.pitPhase = 'none';
    this.pit = null;
    this.craft = 1;
    this.controlScale = 1;
    this.applyPace();
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
