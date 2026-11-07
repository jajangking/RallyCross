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
  /** Pengali target kecepatan: <1 membuat pembalap lebih mudah dikalahkan. */
  pace: number;
  /** Geser garis balap ke samping, meter (dipakai supaya dua mobil tidak
   *  berebut ruang yang sama). Positif = ke sisi `+side`. */
  laneOffset: number;
  /** Seberapa cepat setir bisa diputar penuh ke penuh, 1/detik. Tanpa batas ini
   *  roda langsung lompat dari lock kiri ke kanan dan mobil terlihat kaku. */
  steerRate: number;
  /** Konstanta pelemas pedal gas/rem, 1/detik. */
  pedalRate: number;
  /** Seberapa banyak AI memotong apex, 0..1 dari lebar trek. */
  lineCut: number;
  /** Mau menyalip? Kalau tidak, AI hanya mengikuti mobil di depan. */
  overtake: boolean;
  /** Ngejar mobil di depan: berani sedikit lebih cepat saat lurus. */
  chase: boolean;
  /** Tambahan target kecepatan saat mengejar, fraksi (0,05 = +5 %). */
  chaseBoost: number;
  /** Seberapa dekat menempel saat mengejar (0 = tidak berubah, 1 = paling dekat). */
  chaseTighten: number;
  /** Seberapa cepat celah ditutup saat mengejar (0 = seperti biasa). */
  chaseRate: number;
  /** Tambahan asumsi grip/rem (fraksi) saat memburu, mis. 0,02 = +2 %. */
  chaseGrip: number;
  /** Kelengkungan maksimum di depan yang masih boleh dipakai untuk memburu. */
  chaseCornerLimit: number;
  /** Menutup sisi dalam tikungan kalau ada mobil menempel di belakang. */
  defend: boolean;
  /** Kelengkungan maksimum di depan yang masih boleh dipakai untuk menyalip. */
  overtakeCornerLimit: number;
  /** Ambil joker lap? */
  useJoker: boolean;
}

/**
 * Setelan hasil uji headless (`scripts/preview.ts` bukan, tapi bench sementara
 * di CI lokal): 60 kombinasi disapu, lalu yang terbaik diverifikasi 4 lap.
 *
 *  - `gripTarmac/brakeTarmac` ≈ batas nyata mobil (akselerasi 7,83 m/s²,
 *    deselerasi 9,36 m/s²), bukan angka konservatif. Perencana yang terlalu
 *    penakut membuang lebih dari satu detik per putaran.
 *  - `gripGravel/brakeGravel` dinaikkan sedikit: gravel μ 0,62 memang licin,
 *    tapi 5,0/4,6 membuat AI mengangkat gas terlalu awal.
 *  - `steerGain` 1,75 + `steerRate` 6: setir lebih cepat sampai di sudut yang
 *    dibutuhkan, tanpa mengayun.
 *  - `lineCut` 0,03: potong apex hampir tidak ada — garis tengah ternyata lebih
 *    cepat di trek ini. 0,1 (setelan lama) justru memelintir radius tikungan.
 *
 * Hasil: putaran terbaik 30,45 s → **28,35 s** (7 % di atas batas fisik 26,5 s),
 * dan yang lebih penting: keluar trek 8,4 m → **0 m**, mobil tidak pernah
 * hampir terbalik lagi (up 0,90 vs −0,05).
 */
export const defaultPilotOptions: AutoPilotOptions = {
  gripTarmac: 9.0,
  gripGravel: 5.6,
  brakeTarmac: 8.4,
  brakeGravel: 5.4,
  horizon: 110,
  steerGain: 1.75,
  steerDamping: 0.3,
  maxSteerDeg: 34,
  steerFalloff: 0.72,
  topSpeed: 55,
  wheelbase: 2.64,
  jumpSpeed: 19,
  pace: 1,
  laneOffset: 0,
  steerRate: 6,
  pedalRate: 11,
  lineCut: 0.03,
  overtake: true,
  chase: true,
  chaseBoost: 0,
  chaseTighten: 0,
  chaseRate: 0,
  chaseGrip: 0.03,
  chaseCornerLimit: 0.03,
  defend: false,
  overtakeCornerLimit: 0.013,
  useJoker: true,
};

/** Apa yang perlu diketahui AI tentang mobil lain di lintasan. */
export interface TrafficCar {
  position: THREE.Vector3;
  speed: number;
}

export type PilotMode = 'drive' | 'reverse' | 'align' | 'flip';

/**
 * Garis balap yang digeser ke samping. Menggeser *jalurnya* (bukan cuma titik
 * tujuan) membuat semua perhitungan lain — kelengkungan, lebar trek, deteksi
 * melebar — tetap konsisten, jadi dua mobil bisa punya lajur masing-masing.
 */
const UP = new THREE.Vector3(0, 1, 0);

function shiftPath(path: PathSample[], metres: number): PathSample[] {
  if (!metres) return path;
  const out = path.map((s) => ({ ...s, pos: s.pos.clone().addScaledVector(s.side, metres) }));
  // Tangen, sisi, dan kelengkungan WAJIB dihitung ulang. Lajur yang digeser ke
  // dalam tikungan radiusnya lebih kecil; kalau angka lama dipakai, AI
  // merencanakan kecepatan terlalu tinggi dan melebar keluar tikungan.
  const n = out.length;
  const closed = n > 1 && out[0].pos.distanceTo(out[n - 1].pos) < 0.01;
  const count = closed ? n - 1 : n;
  const dir = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    const a = out[(i - 1 + count) % count];
    const b = out[(i + 1) % count];
    dir.subVectors(b.pos, a.pos);
    dir.y = 0;
    if (dir.lengthSq() < 1e-8) continue;
    dir.normalize();
    out[i].tangent = dir.clone();
    out[i].side = new THREE.Vector3().crossVectors(UP, dir).normalize();
  }
  for (let i = 0; i < count; i++) {
    const a = out[(i - 1 + count) % count];
    const b = out[(i + 1) % count];
    const chord = a.pos.distanceTo(b.pos);
    if (chord < 1e-4) continue;
    const turn = Math.atan2(
      a.tangent.x * b.tangent.z - a.tangent.z * b.tangent.x,
      a.tangent.x * b.tangent.x + a.tangent.z * b.tangent.z,
    );
    out[i].curvature = -turn / chord;
  }
  const rawCurv = out.slice(0, count).map((s) => s.curvature);
  for (let i = 0; i < count; i++) {
    let sum = 0;
    for (let k = -3; k <= 3; k++) sum += rawCurv[(i + k + count) % count];
    out[i].curvature = sum / 7;
  }
  if (closed) {
    out[n - 1] = {
      ...out[n - 1],
      tangent: out[0].tangent.clone(),
      side: out[0].side.clone(),
      curvature: out[0].curvature,
    };
  }
  return out;
}


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

  /** Garis asli sebelum digeser; disimpan supaya lajur bisa diubah saat balapan. */
  private readonly rawMain: PathSample[];
  private readonly rawJoker: PathSample[];
  private plain: PathSample[];
  private withJoker: PathSample[];
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
  /** Setir yang benar-benar dikirim, sudah melewati batas kecepatan putar. */
  private steerCmd = 0;
  /** Pedal yang benar-benar dikirim, sudah dilembutkan. */
  private throttleCmd = 0;
  private brakeCmd = 0;
  /** `lateral` yang sudah difilter; mencegah tarikan garis jitter antar-sample. */
  private lateralSmooth = 0;
  /** Potongan apex yang sudah dilembutkan, meter. */
  private cutSmooth = 0;
  /** Geseran lajur untuk menyalip mobil di depan, meter. */
  private laneShift = 0;
  /** Ke sisi mana sedang menyalip: -1 kiri, +1 kanan, 0 tidak menyalip. */
  overtakeSide = 0;
  /** Geseran lajur yang sedang dipakai (negatif = sisi `-side`). */
  laneShiftValue = 0;
  /** Sedang mengejar mobil di depan? (HUD/debug) */
  chasing = false;
  /** Sedang menutup garis karena dikejar? (HUD/debug) */
  defendingLine = false;
  /** Jarak ke mobil yang sedang diburu, meter (`Infinity` kalau sendirian). */
  chaseGapValue = Infinity;
  /** Kecepatan mobil yang diburu, m/s. */
  chaseSpeedValue = 0;
  /** 0..1: seberapa keras sedang memburu (dipakai perencana kecepatan). */
  private chasePush = 0;

  constructor(main: PathSample[], joker: PathSample[], options: Partial<AutoPilotOptions> = {}) {
    this.options = { ...defaultPilotOptions, ...options };
    this.rawMain = main;
    this.rawJoker = joker;
    this.plain = shiftPath(lapPath(main, joker, false), this.options.laneOffset);
    this.withJoker = shiftPath(lapPath(main, joker, true), this.options.laneOffset);
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
  /** Mobil lain di sekitarnya — supaya AI tidak menabrak bagian belakang. */
  update(dt: number, car: PilotCar, others: ReadonlyArray<TrafficCar> = []): VehicleInput {
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

    // Terbalik / tertidur: **tidak** minta reset — mobil dibiarkan apa adanya.
    // AI cuma melepas semua pedal dan menunggu gravitasi menurunkannya lagi.
    const up = tmpUp.set(0, 1, 0).applyQuaternion(car.quaternion);
    this.flipTime = up.y < 0.35 ? this.flipTime + dt : 0;
    if (this.flipTime > 0.15 && this.mode !== 'flip') {
      this.mode = 'flip';
      this.maneuverTime = 0;
    }

    if (this.mode !== 'drive') return this.maneuver(dt, car, speed);

    // Tersangkut (menempel dinding, keluar trek): mundur, lalu luruskan lagi.
    const throttling = speed < 1.2;
    this.stuckTime = throttling ? this.stuckTime + dt : 0;
    if (this.stuckTime > 1.6) {
      this.mode = 'reverse';
      this.maneuverTime = 0;
      this.stuckTime = 0;
    }

    return this.drive(dt, car, s, yaw, speed, others);
  }

  /**
   * Setir ke **satu titik** (bukan mengikuti jalur balap). Dipakai mobil masuk
   * pit, safety car keluar-masuk, dan ambulans menuju lokasi kecelakaan.
   * Tidak menyentuh index/lap jalur, jadi begitu selesai cukup panggil
   * `reset(pos)` untuk kembali balapan.
   */
  driveTo(
    dt: number,
    car: PilotCar,
    target: THREE.Vector3,
    opts: { maxSpeed?: number; stopDistance?: number } = {},
  ): VehicleInput {
    const o = this.options;
    const fwd = tmpFwd.set(0, 0, 1).applyQuaternion(car.quaternion);
    const yaw = Math.atan2(fwd.x, fwd.z);
    const speed = Math.hypot(car.velocity.x, car.velocity.z);
    const dx = target.x - car.position.x;
    const dz = target.z - car.position.z;
    const dist = Math.hypot(dx, dz);
    const alpha = wrapAngle(Math.atan2(dx, dz) - yaw);
    const stop = opts.stopDistance ?? 1;
    const maxSpeed = opts.maxSpeed ?? 20;

    // Merapat (di bawah 14 m) pakai kemudi langsung ke arah titik: pure pursuit
    // dengan titik sedekat itu membuat mobil berputar-putar di sekitar target.
    const docking = dist < 14;
    let want: number;
    let wanted: number;
    if (docking) {
      // Pelan, makin dekat makin pelan, dan **makin menyudut makin pelan**:
      // kalau targetnya 90° di samping, menambah gas hanya membuat mobil
      // berputar mengelilingi kotak (understeer) — yang dibutuhkan justru
      // pelan supaya bisa memutar.
      const absA = Math.abs(alpha);
      if (absA > 1.1) {
        // Target jauh di samping/belakang: mobil tidak bisa memutar di tempat,
        // jadi maju pelan dengan setir penuh (busur) sampai target di depan.
        want = Math.min(2.8, Math.max(1.6, dist * 0.3));
      } else {
        const turnFactor = Math.max(0.3, Math.cos(absA));
        want = Math.min(maxSpeed, Math.max(0, (dist - stop) * 1.3)) * turnFactor;
        if (dist < stop + 0.4) want = 0;
      }
      wanted = clamp(-alpha * 1.9 + car.angularVelocity.y * o.steerDamping, -1, 1);
    } else {
      // Rencanakan berhenti tepat di titik: v = √(2·a·s), a = 6 m/s².
      const allowed = Math.sqrt(Math.max(0, 2 * 6 * Math.max(0, dist - stop)));
      want = Math.min(maxSpeed, allowed);
      let curvature = 0;
      if (dist > 0.6) {
        const reach = Math.min(Math.max(dist, 4), 16);
        curvature = (2 * Math.sin(alpha) * o.steerGain) / reach;
        if (Math.abs(alpha) > Math.PI * 0.5) {
          curvature = Math.sign(alpha) * Math.max(Math.abs(curvature), 1.2);
        }
      }
      const maxSteerRad = THREE.MathUtils.degToRad(o.maxSteerDeg);
      const steerRoom =
        maxSteerRad * Math.max(0.3, 1 - o.steerFalloff * Math.min(1, speed / o.topSpeed));
      wanted = clamp(
        -Math.atan(curvature * o.wheelbase) / steerRoom + car.angularVelocity.y * o.steerDamping,
        -1,
        1,
      );
    }
    // Titik sudah di belakang mobil: jangan sampai berputar balik di tempat.
    if (!docking && Math.abs(alpha) > Math.PI * 0.62) want = Math.min(want, 2.5);
    const step = Math.max(o.steerRate, 0.5) * dt;
    this.steerCmd = clamp(wanted, this.steerCmd - step, this.steerCmd + step);
    const steer = this.steerCmd;

    let throttle = 0;
    let brake = 0;
    if (speed < want - 0.6) throttle = clamp((want - speed) / 5 + 0.35, 0.2, 1);
    else if (speed > want + 0.8) brake = clamp((speed - want) / 3, 0.15, 1);
    const blend = clamp(dt * Math.max(o.pedalRate, 1), 0, 1);
    this.throttleCmd += (throttle - this.throttleCmd) * blend;
    this.brakeCmd += (brake - this.brakeCmd) * blend;
    throttle = this.throttleCmd < 0.04 ? 0 : this.throttleCmd;
    brake = this.brakeCmd < 0.04 ? 0 : this.brakeCmd;
    if (brake > 0.05) throttle = 0;
    return { throttle, brake, steer, handbrake: false, gear: 1 };
  }

  /** Lupakan status balap (dipakai setelah mobil di-reset). */
  reset(at?: THREE.Vector3) {
    this.mode = 'drive';
    this.stuckTime = 0;
    this.flipTime = 0;
    this.maneuverTime = 0;
    this.lapTime = 0;
    this.steerCmd = 0;
    this.throttleCmd = 0;
    this.brakeCmd = 0;
    this.lateralSmooth = 0;
    this.index = this.nearest(this.path, at ?? new THREE.Vector3(0, 0, 0), this.index);
    this.prevIndex = this.index;
    this.rebuildSteps();
  }

  /**
   * Pindahkan lajur balap (meter). Dipakai "nalar AI": makin berpengalaman,
   * makin kecil geserannya — dia balik ke garis tercepat dan hanya bergeser
   * kalau sedang menyalip. Jalur dihitung ulang penuh (tangent, side,
   * kelengkungan), jadi kecepatan tikungannya tetap benar.
   */
  setLaneOffset(metres: number) {
    if (Math.abs(this.options.laneOffset - metres) < 0.005) return;
    this.options.laneOffset = metres;
    const at = this.sample.pos.clone();
    this.plain = shiftPath(lapPath(this.rawMain, this.rawJoker, false), metres);
    this.withJoker = shiftPath(lapPath(this.rawMain, this.rawJoker, true), metres);
    this.path = this.options.useJoker ? this.withJoker : this.plain;
    this.rebuildSteps();
    this.index = this.nearest(this.path, at, 0);
    this.prevIndex = this.index;
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

  private drive(
    dt: number,
    car: PilotCar,
    s: PathSample,
    yaw: number,
    speed: number,
    others: ReadonlyArray<TrafficCar>,
  ): VehicleInput {
    const o = this.options;
    let target = this.speedTarget(this.index, speed);
    // Sudah melebar? Angkat gas sedikit supaya setir sempat menarik kembali —
    // tapi jangan mengerem keras: rem di tengah tikungan justru melewatkan
    // mobil makin jauh ke luar dan bikin gerakannya patah-patah.
    const wide = Math.abs(this.lateral) / Math.max(s.halfWidth, 1);
    const off = wide > 1.02;
    // Tepi trek dijaga pagar beton: melebar 1 m saja sudah berarti menabrak.
    // Jadi mobil mulai "ditarik" ke garis sebelum benar-benar keluar, bukan
    // sesudahnya.
    const recover = wide > 0.88;
    if (off) target = Math.min(target, 9);
    else if (recover) target = Math.min(target, 15);
    else if (wide > 0.62) target = Math.min(target, 20);
    // --- lalu lintas: cari celah, jangan cuma menempel di bemper ---
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    let blockerGap = Infinity;
    let blockerSpeed = 0;
    let blockerSide = 0;
    /** Mobil terdekat di depan (lajur dilihat lebih lebar): yang kita kejar. */
    let chaseGap = Infinity;
    let chaseSpeed = 0;
    /** Jarak mobil terdekat yang menempel DI BELAKANG kita. */
    let chaserGap = Infinity;
    /** Mobil yang sedang tepat di samping kita (tidak boleh digeser ke sana). */
    let besideSide = 0;
    for (const other of others) {
      const ox = other.position.x - car.position.x;
      const oz = other.position.z - car.position.z;
      const dist = Math.hypot(ox, oz);
      if (dist < 0.01 || dist > 22) continue;
      const ahead = ox * fx + oz * fz;
      // Posisi mobil lain di kiri/kanan garis kita: hanya mobil yang benar-benar
      // di jalur kita yang dianggap menghalangi.
      const lateral = ox * s.side.x + oz * s.side.z;
      // "Mobil yang kita kejar" dilihat dengan lajur lebih lebar (4,5 m):
      // lawan di lajur sebelah tetap dianggap lawan yang harus dikejar, bukan
      // mobil di trek lain. Ini yang membuat mereka saling memburu.
      if (ahead / dist > 0.55 && Math.abs(lateral) < 4.5 && dist < chaseGap) {
        chaseGap = dist;
        chaseSpeed = other.speed;
      }
      if (Math.abs(ahead) < 5.5 && Math.abs(lateral) < 3.0) {
        besideSide = lateral >= 0 ? 1 : -1;
      }
      // Ada yang menempel di belakang: dipakai untuk menutup garis (defend).
      if (ahead / dist < -0.7 && Math.abs(lateral) < 2.6 && dist < 20) {
        chaserGap = Math.min(chaserGap, dist);
      }
      if (ahead / dist < 0.8) continue;
      if (Math.abs(lateral) > 2.4) continue;
      if (dist < blockerGap) {
        blockerGap = dist;
        blockerSpeed = other.speed;
        blockerSide = lateral;
      }
    }

    // Tikungan di depan (~45 m). Menyalip di tikungan sempit adalah cara
    // tercepat keluar trek: mobil yang sudah bergeser lajur harus mengubah
    // arah dengan radius yang sama sekali berbeda. Jadi geseran lajur hanya
    // dipakai di lurus dan tikungan landai.
    let cornerAhead = 0;
    let cornerCurv = 0;
    {
      const n = this.path.length;
      let k = this.index;
      let travelled = 0;
      for (let c = 0; c < 120 && travelled < 45; c++) {
        travelled += this.steps[k];
        k = (k + 1) % n;
        const curv = Math.abs(this.path[k].curvature);
        if (curv > cornerAhead) {
          cornerAhead = curv;
          cornerCurv = this.path[k].curvature;
        }
      }
    }
    const cornerSoon = cornerAhead > o.overtakeCornerLimit;
    // Seberapa keras sedang memburu mobil di depan (0..1).
    const chaseWeight =
      o.chase &&
      chaseGap < 24 &&
      chaseGap > 7 &&
      cornerAhead < o.chaseCornerLimit &&
      wide < 0.6 &&
      besideSide === 0
        ? clamp((24 - chaseGap) / 17, 0, 1)
        : 0;
    this.chasing = chaseWeight > 0;
    this.chaseGapValue = chaseGap;
    this.chaseSpeedValue = chaseSpeed;
    // Dipakai `speedTarget()` di frame berikutnya: pemburu berani memakai
    // batas grip yang sedikit lebih tinggi (diperhitungkan di tikungan, bukan
    // sekadar menambah gas), jadi dia konsisten lebih cepat — bukan melebar.
    this.chasePush = chaseWeight;
    // Kembali ke garis lebih cepat kalau tikungan sudah dekat.
    const recentre = cornerSoon ? dt * 6 : dt * 2.4;

    if (blockerGap < Infinity) {
      const slower = blockerSpeed < speed + 1.5;
      // Saat memburu, penyusulan disiapkan lebih awal (16 m, bukan 12 m):
      // pemburu keluar dari slipstream dan memilih sisi sebelum terlalu dekat.
      const close = blockerGap < 12;
      // Mau menyalip kalau yang di depan lebih lambat, kita sudah dekat, dan
      // kecepatannya sudah cukup untuk pindah lajur dengan aman. Kalau tidak,
      // cukup jaga jarak (jangan menabrak bagian belakangnya). Di tikungan
      // sempit kami tidak pindah lajur: radius yang harus dilalui berubah dan
      // mobil hampir selalu keluar trek. Menyalip terjadi di lurus.
      const wantOvertake =
        o.overtake && !cornerSoon && slower && close && speed > 7 && blockerGap > 3.2;
      if (wantOvertake) {
        // Pilih sisi yang lapang: kalau dia di sisi + kita, lewat sisi −.
        const prefer = blockerSide >= 0 ? -1 : 1;
        // Ruang dihitung dari tepi trek yang sebenarnya: lajur yang sudah
        // digeser `laneOffset` juga memakan tempat, ditambah setengah lebar
        // mobil sebagai margin.
        const fromCentre = o.laneOffset + this.lateral;
        const roomPos = s.halfWidth - fromCentre - 1.6;
        const roomNeg = s.halfWidth + fromCentre - 1.6;
        let side = prefer > 0 ? (roomPos > 1.6 ? 1 : -1) : roomNeg > 1.6 ? -1 : 1;
        // Jangan menyalip ke sisi tempat sudah ada mobil sejajar.
        if (besideSide !== 0 && side === besideSide) side = -side;
        const room = Math.max(0, side > 0 ? roomPos : roomNeg);
        if (Math.min(roomPos, roomNeg) < 1.6 && besideSide !== 0) {
          // Sempit dan ada mobil di samping: lebih baik mengikuti dulu.
          this.overtakeSide = 0;
          this.laneShift += clamp(-this.laneShift, -recentre, recentre);
        } else {
          this.overtakeSide = side;
          // Di tikungan geserannya dipersempit: pindah lajur sambil berbelok
          // berarti mengubah radius, dan itu cara tercepat keluar trek.
          const shift =
            Math.min(2.4, Math.max(1.4, Math.abs(blockerSide) + 1.5), room) *
            (cornerSoon ? 1 : 1);
          this.laneShift += clamp(side * shift - this.laneShift, -dt * 3.2, dt * 3.2);
        }
        // Kecepatan tidak dinaikkan: batas tikungan tetap yang berlaku. Yang
        // dihilangkan hanya "rem karena ada mobil di depan", supaya kita
        // benar-benar lewat, bukan menempel di belakangnya sepanjang lurus.
      } else {
        this.overtakeSide = 0;
        this.laneShift += clamp(-this.laneShift, -recentre, recentre);
        // Jarak ~6 m dipakai sebagai "ikuti dia", makin jauh batasnya longgar.
        // Catatan: menempel lebih dekat dari ini terbukti membuat yang belakang
        // mengerem di tengah tikungan dan melebar keluar — jadi jaraknya tetap,
        // dan "mengejar" dilakukan lewat batas grip di perencana kecepatan.
        const followGap = 6 - 1.5 * chaseWeight * o.chaseTighten;
        const followRate = 1.6 + 0.4 * chaseWeight * o.chaseRate;
        target = Math.min(target, Math.max(0, blockerSpeed + (blockerGap - followGap) * followRate));
      }
    } else {
      this.overtakeSide = 0;
      // DEFEND: ada mobil menempel di belakang dan tikungan sudah dekat →
      // ambil sisi dalam tikungan supaya tidak bisa disalip di dalam.
      const danger = o.defend && chaserGap < 14 && cornerAhead > 0.007 && besideSide === 0;
      this.defendingLine = danger;
      const hold = danger ? -Math.sign(cornerCurv) * 0.6 : 0;
      this.laneShift += clamp(hold - this.laneShift, -recentre, recentre);
    }
    target *= o.pace;

    // NGEJAR: mobil di depan masih 8–22 m dan jalannya lurus → berani sedikit
    // lebih cepat (maks +5 %) supaya benar-benar menempel dan mencoba menyalip,
    // bukan berhenti di belakang bemper sepanjang lurus. Di tikungan tetap
    // batas grip yang berlaku: mengejar bukan alasan keluar trek.
    if (chaseWeight > 0) target *= 1 + o.chaseBoost * chaseWeight;

    // --- setir: pure pursuit murni (radius tikungan, bukan gain sudut) ---
    // Menghitung lengkung yang dibutuhkan lalu menerjemahkannya ke sudut roda
    // membuat perilakunya sama di kecepatan rendah dan tinggi; gain P biasa
    // membuat mobil mengayun di gravel.
    this.lateralSmooth += (this.lateral - this.lateralSmooth) * clamp(dt * 7, 0, 1);
    const look0 = clamp(6 + speed * 0.8, 7, 30);
    // Depan mata dipendekkan kalau di depan ada tikungan tajam. Dengan titik
    // pandang jauh, garis lurus ke titik itu memotong tikungan: mobil masuk
    // terlalu lebar lalu panik mengoreksi. Ini yang membuat gerakannya kaku.
    let maxCurv = 0;
    {
      const n = this.path.length;
      let k = this.index;
      let dist = 0;
      for (let c = 0; c < 60 && dist < look0 + 8; c++) {
        dist += this.steps[k];
        k = (k + 1) % n;
        const curv = Math.abs(this.path[k].curvature);
        if (curv > maxCurv) maxCurv = curv;
      }
    }
    const tight = clamp(1 - maxCurv / 0.05, 0, 1);
    // Di luar trek: jangan mengejar titik jauh ke depan. Titik jauh membuat
    // sudutnya kecil, jadi mobil justru jalan lurus makin jauh. Tuju titik
    // dekat di garis supaya sudutnya besar dan mobil benar-benar kembali.
    const look = recover ? clamp(4 + speed * 0.3, 5, 11) : look0 * (0.45 + 0.55 * tight);
    const aimIndex = this.indexAt(this.index, look);
    const aim = this.path[aimIndex];
    // Garis balap: potong sedikit ke sisi dalam tikungan supaya jalurnya
    // terlihat seperti pembalap yang mencari apex, bukan garis tengah. Hanya
    // di tikungan yang benar-benar tikungan (di lintasan lurus angkanya nol,
    // kalau tidak titik tujuan melompat kiri-kanan dan mobil mengayun).
    const cutAmt = clamp((Math.abs(aim.curvature) - 0.005) / 0.02, 0, 1);
    const cutWanted = -Math.sign(aim.curvature) * cutAmt * s.halfWidth * o.lineCut;
    this.cutSmooth += (cutWanted - this.cutSmooth) * clamp(dt * 3, 0, 1);
    // Lajur yang sudah digeser (mobil rival) tidak ikut memotong apex: dua
    // geseran sekaligus mendorong garisnya keluar trek di tikungan sempit.
    const cut = recover || Math.abs(o.laneOffset) > 0.01 ? 0 : this.cutSmooth;
    // Geseran menyalip: hanya dipakai kalau mobil masih di dalam trek, dan
    // tidak pernah lebih lebar dari ruang yang tersisa di sisi itu.
    const passRoom = Math.max(0.8, s.halfWidth - Math.abs(o.laneOffset) - 1.8);
    this.laneShiftValue = this.laneShift;
    const pass = recover ? 0 : clamp(this.laneShift, -passRoom, passRoom);
    // Tarik titik tujuan sedikit ke arah posisi mobil sekarang (filter dulu
    // supaya tidak bergetar saat sample terdekat berpindah) agar koreksi besar
    // tetap mulus, tidak menyentak setir ke arah sebaliknya. Saat di luar trek
    // tarikan ini dimatikan: yang dibutuhkan justru belok penuh ke garis.
    const pull = recover ? 0 : clamp(this.lateralSmooth, -8, 8) * 0.15;
    const off2 = pull + cut + pass;
    const dx = aim.pos.x + aim.side.x * off2 - car.position.x;
    const dz = aim.pos.z + aim.side.z * off2 - car.position.z;
    const reach = Math.hypot(dx, dz);
    const alpha = wrapAngle(Math.atan2(dx, dz) - yaw);
    let curvature = reach > 0.8 ? (2 * Math.sin(alpha) * o.steerGain) / reach : 0;
    // Titik tujuan di belakang mobil (mobil menghadap menjauh dari garis):
    // sin(alpha) mendekati nol, jadi rumus pure pursuit justru menyuruh lurus
    // dan mobil melesat makin jauh dari trek. Belok penuh ke arah titik itu.
    if (Math.abs(alpha) > Math.PI * 0.5) {
      curvature = Math.sign(alpha) * Math.max(Math.abs(curvature), 1.2);
    }
    const maxSteerRad = THREE.MathUtils.degToRad(o.maxSteerDeg);
    const steerRoom = maxSteerRad * Math.max(0.3, 1 - o.steerFalloff * Math.min(1, speed / o.topSpeed));
    const yawRate = car.angularVelocity.y;
    const wanted = clamp(
      -Math.atan(curvature * o.wheelbase) / steerRoom + yawRate * o.steerDamping,
      -1,
      1,
    );
    // Setir diputar bertahap, seperti tangan pengemudi: tidak ada lompatan
    // lock-ke-lock, dan goyangan setir di gravel ikut mereda.
    const step = Math.max(o.steerRate, 0.5) * dt;
    this.steerCmd = clamp(wanted, this.steerCmd - step, this.steerCmd + step);
    let steer = this.steerCmd;
    // Mobil mulai melintir (hidung tidak searah jalan). Menjejalkan setir ke
    // titik tujuan justru mempercepat putaran; yang benar adalah menangkap
    // selip: arahkan roda ke arah mobil benar-benar meluncur, dan angkat gas.
    let catchWeight = 0;
    if (speed > 2.5) {
      const velYaw = Math.atan2(car.velocity.x, car.velocity.z);
      const slip = wrapAngle(yaw - velYaw);
      catchWeight = clamp((Math.abs(slip) - 0.3) / 0.45, 0, 1);
      if (catchWeight > 0) {
        const catchSteer = clamp(slip * 1.7, -1, 1);
        steer = steer * (1 - catchWeight) + catchSteer * catchWeight;
      }
    }
    this.lastSteer = steer;

    // --- gas / rem ---
    let throttle = 0;
    let brake = 0;
    // Di udara roda tidak menyentuh tanah: gas hanya memutar roda tanpa traksi,
    // lalu begitu mendarat tenaganya menyentak dan mobil terpelintir. Lepas
    // pedal selama melayang supaya mendarat lurus.
    const airborne = car.wheels.length > 0 && car.wheels.every((w) => !w.contact);
    if (airborne) {
      this.throttleCmd = 0;
      this.brakeCmd = 0;
      return { throttle: 0, brake: 0, steer, handbrake: false, gear: 1 };
    }
    const onGravel = s.surface === 'gravel';
    const headroom = onGravel ? 0.6 : 0.9;
    if (speed < target - headroom) {
      // Gas proporsional: makin jauh dari target makin dalam, jadi AI tidak
      // hanya tahu "gas penuh" dan "nganggur".
      throttle = clamp((target - speed) / 6 + 0.4, 0.25, 1);
    } else if (speed > target + headroom * 1.4) {
      brake = clamp((speed - target) / 4, 0.15, 1);
      // Di luar trek: rem secukupnya saja, sisanya biar setir yang bekerja.
      if (off) brake = Math.min(brake, 0.45);
      throttle = 0;
    } else {
      throttle = clamp((target - speed) / 3 + 0.25, 0.05, 0.5);
    }
    // Sedang menangkap selip: kurangi tenaga supaya ban belakang tidak
    // berputar dan mobil berhenti berputar.
    throttle *= 1 - catchWeight * 0.85;
    // Pedal dilembutkan supaya tidak berkedip gas-rem tiap frame.
    const blend = clamp(dt * Math.max(o.pedalRate, 1), 0, 1);
    this.throttleCmd += (throttle - this.throttleCmd) * blend;
    this.brakeCmd += (brake - this.brakeCmd) * blend;
    throttle = this.throttleCmd < 0.04 ? 0 : this.throttleCmd;
    brake = this.brakeCmd < 0.04 ? 0 : this.brakeCmd;
    if (brake > 0.05) throttle = 0;

    // Jangan menyalakan handbrake; AI mengandalkan grip penuh.
    return { throttle, brake, steer, handbrake: false, gear: 1 };
  }

  /** Manuver mundur / luruskan / tunggu setelah mobil terbalik. */
  private maneuver(dt: number, car: PilotCar, speed: number): VehicleInput {
    this.maneuverTime += dt;

    if (this.mode === 'flip') {
      // Diam total: tidak ada gas, rem, atau setir. Begitu rodanya kembali ke
      // bawah, AI langsung lanjut balapan dari posisi terakhirnya.
      const up = tmpUp.set(0, 1, 0).applyQuaternion(car.quaternion);
      if (up.y > 0.6) {
        this.mode = 'drive';
        this.maneuverTime = 0;
        this.stuckTime = 0;
      }
      return { throttle: 0, brake: 0, steer: 0, handbrake: false, gear: 1 };
    }

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
    // Sedang memburu: rencanakan dengan grip & rem sedikit lebih tinggi. Ini
    // sama seperti "menaikkan nyali": titik rem ikut bergeser, jadi mobil
    // tidak menabrak batas grip-nya sendiri.
    const push = 1 + (o.chaseGrip > 0 ? o.chaseGrip : 0) * this.chasePush;
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
      const grip = (gravel ? o.gripGravel : o.gripTarmac) * push;
      const brake = (gravel ? o.brakeGravel : o.brakeTarmac) * push;
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
