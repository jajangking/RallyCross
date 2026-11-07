import * as THREE from 'three';
import { lapPath, type PathSample } from '../world/circuit';
import type { GearDirection, VehicleInput } from '../vehicle/VehiclePhysics';

/**
 * AI pengemudi: mengikuti garis balap dengan *pure pursuit*, memilih kecepatan
 * dari kelengkungan beberapa puluh meter ke depan, dan mundur sendiri kalau
 * tersangkut. Semuanya murni matematika di atas `PathSample` + state mobil, jadi
 * bisa diuji di Node tanpa DOM (lihat `scripts/smoke.ts`).
 */

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const wrapAngle = (a: number) => {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
};

/** Bagian mobil yang dibaca AI. `VehiclePhysics` memenuhi ini apa adanya. */
export interface PilotCar {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  quaternion: THREE.Quaternion;
  angularVelocity: THREE.Vector3;
  speed: number;
  gear: GearDirection;
  wheels: ReadonlyArray<{ contact: boolean }>;
}

export interface AutoPilotOptions {
  /** Percepatan lateral yang dipakai merencanakan kecepatan, m/s². */
  gripTarmac: number;
  gripGravel: number;
  /** Perlambatan yang diasumsikan saat menghitung titik rem, m/s². */
  brakeTarmac: number;
  brakeGravel: number;
  /** Seberapa jauh ke depan titik rem direncanakan, meter. */
  horizon: number;
  /** Penguat lengkung pure pursuit; >1 memotong tikungan, menutup understeer. */
  steerGain: number;
  /** Redaman yaw rate pada perintah setir. */
  steerDamping: number;
  /** Batas geometri setir mobil, untuk mengubah radius tikungan jadi input. */
  maxSteerDeg: number;
  steerFalloff: number;
  topSpeed: number;
  wheelbase: number;
  /** Kecepatan maksimum yang dianggap aman melewati lompatan, m/s. */
  jumpSpeed: number;
  /** Ambil joker lap? */
  useJoker: boolean;
}

export const defaultPilotOptions: AutoPilotOptions = {
  gripTarmac: 8.0,
  gripGravel: 5.2,
  brakeTarmac: 7.0,
  brakeGravel: 4.6,
  horizon: 110,
  steerGain: 1.5,
  steerDamping: 0.3,
  maxSteerDeg: 34,
  steerFalloff: 0.72,
  topSpeed: 55,
  wheelbase: 2.64,
  jumpSpeed: 19,
  useJoker: true,
};

export type PilotMode = 'drive' | 'reverse' | 'align';


export class AutoPilot {
  readonly options: AutoPilotOptions;

  /** Mode internal; `reverse`/`align` adalah manuver lepas dari sangkutan. */
  mode: PilotMode = 'drive';
  /** Posisi di lintasan, meter dari garis start lap yang sedang dipakai. */
  index = 0;
  /** Jumlah putaran yang sudah selesai. */
  lap = 0;
  lapTime = 0;
  bestLap = Infinity;
  lastLap = 0;
  /** Jarak lateral dari garis tengah, meter (positif = ke sisi `+side`). */
  lateral = 0;
  /** True kalau AI minta mobil di-reset (mobil terbalik, tidak bisa sendiri). */
  needsReset = false;

  private readonly plain: PathSample[];
  private readonly withJoker: PathSample[];
  private path: PathSample[];
  /** Jarak antar sample berurutan, sudah termasuk sambungan akhir→awal. */
  private readonly steps: number[] = [];
  /** Kemiringan tiap sample (dy/ds), dipakai mendeteksi tanjakan lompatan. */
  private readonly grade: number[] = [];
  private prevIndex = 0;
  private clock = 0;
  private stuckTime = 0;
  private flipTime = 0;
  private maneuverTime = 0;
  private lastSteer = 0;

  constructor(main: PathSample[], joker: PathSample[], options: Partial<AutoPilotOptions> = {}) {
    this.options = { ...defaultPilotOptions, ...options };
    this.plain = lapPath(main, joker, false);
    this.withJoker = lapPath(main, joker, true);
    this.path = this.options.useJoker ? this.withJoker : this.plain;
    this.index = this.nearest(this.path, new THREE.Vector3(0, 0, 0), 0);
    this.rebuildSteps();
  }

  /** Posisi sampel terdekat (untuk HUD/debug). */
  get sample(): PathSample {
    return this.path[this.index];
  }

  /** Panjang satu putaran pada jalur yang sedang dipakai. */
  get length(): number {
    return this.path[this.path.length - 1].distance;
  }

  /** 0..1, seberapa jauh di dalam putaran. */
  get progress(): number {
    return this.length > 0 ? this.sample.distance / this.length : 0;
  }

  /**
   * Satu langkah kontrol. `dt` hanya dipakai untuk timer pemulihan, keputusan
   * setir/gas memakai state mobil saat ini.
   */
  update(dt: number, car: PilotCar): VehicleInput {
    this.clock += dt;

    const idx = this.nearest(this.path, car.position, this.index);
    this.trackLap(idx);
    this.index = idx;
    this.prevIndex = idx;

    const s = this.path[idx];
    const fwd = tmpFwd.set(0, 0, 1).applyQuaternion(car.quaternion);
    const yaw = Math.atan2(fwd.x, fwd.z);
    const speed = Math.hypot(car.velocity.x, car.velocity.z);
    this.lateral =
      (car.position.x - s.pos.x) * s.side.x + (car.position.z - s.pos.z) * s.side.z;

    // Terbalik / nyangkut di dinding: minta reset setelah beberapa detik.
    const up = tmpUp.set(0, 1, 0).applyQuaternion(car.quaternion);
    this.flipTime = up.y < 0.35 ? this.flipTime + dt : 0;
    if (this.flipTime > 2.5) this.needsReset = true;

    if (this.mode !== 'drive') return this.maneuver(dt, car, speed);

    // Tersangkut (menempel dinding, keluar trek): mundur, lalu luruskan lagi.
    const throttling = speed < 1.2;
    this.stuckTime = throttling ? this.stuckTime + dt : 0;
    if (this.stuckTime > 1.6) {
      this.mode = 'reverse';
      this.maneuverTime = 0;
      this.stuckTime = 0;
    }

    return this.drive(car, s, yaw, speed);
  }

  /** Lupakan status balap (dipakai setelah mobil di-reset). */
  reset(at?: THREE.Vector3) {
    this.mode = 'drive';
    this.stuckTime = 0;
    this.flipTime = 0;
    this.maneuverTime = 0;
    this.needsReset = false;
    this.lapTime = 0;
    this.index = this.nearest(this.path, at ?? new THREE.Vector3(0, 0, 0), this.index);
    this.prevIndex = this.index;
    this.rebuildSteps();
  }

  /** Pindah antara jalur joker dan jalur utama tanpa salah posisi. */
  setUseJoker(on: boolean) {
    if (this.options.useJoker === on) return;
    this.options.useJoker = on;
    const at = this.sample.pos.clone();
    this.path = on ? this.withJoker : this.plain;
    this.rebuildSteps();
    this.index = this.nearest(this.path, at, 0);
    this.prevIndex = this.index;
  }

  /* ------------------------------------------------------------------ */

  private drive(car: PilotCar, s: PathSample, yaw: number, speed: number): VehicleInput {
    const o = this.options;
    let target = this.speedTarget(this.index, speed);
    // Sudah melebar? Batasi kecepatan supaya sempat kembali ke garis.
    const wide = Math.abs(this.lateral) / Math.max(s.halfWidth, 1);
    if (wide > 0.9) target = Math.min(target, 11);
    else if (wide > 0.55) target = Math.min(target, 18);

    // --- setir: pure pursuit murni (radius tikungan, bukan gain sudut) ---
    // Menghitung lengkung yang dibutuhkan lalu menerjemahkannya ke sudut roda
    // membuat perilakunya sama di kecepatan rendah dan tinggi; gain P biasa
    // membuat mobil mengayun di gravel.
    const look = clamp(6 + speed * 0.8, 7, 30);
    const aimIndex = this.indexAt(this.index, look);
    const aim = this.path[aimIndex];
    // Aim a bit toward where the car actually is, so a big correction stays
    // smooth instead of flicking the wheel the other way.
    const pull = clamp(this.lateral, -8, 8) * 0.15;
    const dx = aim.pos.x + aim.side.x * pull - car.position.x;
    const dz = aim.pos.z + aim.side.z * pull - car.position.z;
    const reach = Math.hypot(dx, dz);
    const alpha = wrapAngle(Math.atan2(dx, dz) - yaw);
    const curvature = reach > 0.8 ? (2 * Math.sin(alpha) * o.steerGain) / reach : 0;
    const maxSteerRad = THREE.MathUtils.degToRad(o.maxSteerDeg);
    const steerRoom = maxSteerRad * Math.max(0.3, 1 - o.steerFalloff * Math.min(1, speed / o.topSpeed));
    const yawRate = car.angularVelocity.y;
    const steer = clamp(
      -Math.atan(curvature * o.wheelbase) / steerRoom + yawRate * o.steerDamping,
      -1,
      1,
    );
    this.lastSteer = steer;

    // --- gas / rem ---
    let throttle = 0;
    let brake = 0;
    const onGravel = s.surface === 'gravel';
    const headroom = onGravel ? 0.6 : 0.9;
    if (speed < target - headroom) {
      throttle = clamp((target - speed) / 3 + 0.35, 0.3, 1);
    } else if (speed > target + headroom * 1.4) {
      brake = clamp((speed - target) / 4, 0.15, 1);
      throttle = 0;
    } else {
      throttle = clamp((target - speed) / 3 + 0.2, 0, 0.4);
    }

    // Jangan menyalakan handbrake; AI mengandalkan grip penuh.
    return { throttle, brake, steer, handbrake: false, gear: 1 };
  }

  /** Manuver mundur / luruskan setelah tersangkut. */
  private maneuver(dt: number, car: PilotCar, speed: number): VehicleInput {
    this.maneuverTime += dt;

    if (this.mode === 'reverse') {
      // Gigi R hanya diterima mobil saat hampir berhenti.
      if (this.maneuverTime > 1.5) {
        this.mode = 'align';
        this.maneuverTime = 0;
      }
      return { throttle: 1, brake: 0, steer: clamp(-this.lastSteer, -1, 1), handbrake: false, gear: -1 };
    }

    // 'align': rem sampai mobil benar-benar berhenti supaya gigi D bisa masuk.
    if (car.gear === 1 && speed < 0.6) {
      this.mode = 'drive';
      this.stuckTime = 0;
    } else if (this.maneuverTime > 3.5) {
      this.mode = 'drive';
      this.maneuverTime = 0;
      this.stuckTime = 0;
    }
    return { throttle: 0, brake: 1, steer: 0, handbrake: false, gear: 1 };
  }

  /** Kecepatan tertinggi yang masih bisa mengikuti tikungan di depan. */
  private speedTarget(from: number, speed: number): number {
    const o = this.options;
    const n = this.path.length;
    const horizon = Math.max(25, Math.min(o.horizon, 16 + speed * 2.4));
    let target = 1e3;
    let travelled = 0;
    for (let k = 1; k < 260; k++) {
      const i = (from + k) % n;
      travelled += this.steps[i];
      if (travelled > horizon) break;
      const sample = this.path[i];
      const curv = Math.max(Math.abs(sample.curvature), 1e-4);
      const gravel = sample.surface === 'gravel';
      const grip = gravel ? o.gripGravel : o.gripTarmac;
      const brake = gravel ? o.brakeGravel : o.brakeTarmac;
      // Lompatan: tanjakan curam butuh kecepatan yang wajar, bukan flat out.
      const ramp = sample.distance !== undefined && this.grade[i] > 0.09;
      const corner = ramp ? o.jumpSpeed : Math.sqrt(grip / curv);
      const allowed = Math.sqrt(corner * corner + 2 * brake * travelled);
      if (allowed < target) target = allowed;
    }
    return target;
  }

  private indexAt(from: number, metres: number): number {
    const n = this.path.length;
    let i = from;
    let travelled = 0;
    for (let k = 0; k < 200; k++) {
      travelled += this.steps[i];
      i = (i + 1) % n;
      if (travelled >= metres) break;
    }
    return i;
  }

  private trackLap(idx: number) {
    const n = this.path.length;
    const wrapped = this.prevIndex > n * 0.75 && idx < n * 0.25;
    if (wrapped) {
      if (this.clock > 20) {
        this.lastLap = this.clock;
        this.bestLap = Math.min(this.bestLap, this.clock);
        this.lap++;
      }
      this.clock = 0;
      this.lapTime = 0;
      // Putaran baru: pilih lagi mau lewat joker atau tidak.
      this.path = this.options.useJoker ? this.withJoker : this.plain;
      this.rebuildSteps();
    }
    this.lapTime = this.clock;
  }

  private nearest(path: PathSample[], p: THREE.Vector3, around: number): number {
    const n = path.length;
    let best = around;
    let bestD = Infinity;
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
    scan(around - 24, around + 60);
    if (bestD > 40 * 40) {
      bestD = Infinity;
      scan(0, n - 1);
    }
    return best;
  }

  private rebuildSteps() {
    const n = this.path.length;
    this.steps.length = n;
    this.grade.length = n;
    for (let i = 0; i < n; i++) {
      const a = this.path[i].pos;
      const b = this.path[(i + 1) % n].pos;
      const flat = Math.hypot(b.x - a.x, b.z - a.z);
      this.steps[i] = Math.max(flat, 0.05);
      this.grade[i] = (b.y - a.y) / this.steps[i];
    }
  }
}

const tmpFwd = new THREE.Vector3();
const tmpUp = new THREE.Vector3();
