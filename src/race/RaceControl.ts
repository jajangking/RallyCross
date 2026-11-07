import * as THREE from 'three';
import type { VehicleDamage } from '../vehicle/Damage';
import { serviceTimeFor } from './PitStop';

/**
 * Pengawas balapan: **bendera kuning, safety car, dan ambulans**.
 *
 * Semua keputusan diambil dari keadaan mobil (kerusakan + kecepatan), jadi
 * kecelakaan yang memicu safety car adalah kecelakaan yang benar-benar terjadi
 * di fisika — bukan timer acak.
 *
 * Alurnya:
 *  1. Ada mobil hancur (mesin mati / dua roda copot / bodi < 25 %) atau
 *     berhenti lama setelah menabrak → **insiden**.
 *  2. Safety car keluar dari area servis, masuk garis balap, dan memimpin
 *     rombongan pelan (semua AI melambat, dilarang menyalip).
 *  3. Kalau mobilnya **tidak bisa jalan** (mesin mati / roda copot), ambulans
 *     meluncur ke lokasi, mengait mobil itu, lalu **mendereknya ke kotak
 *     servisnya**. Servis di pit tetap memakan waktu seperti pit stop biasa
 *     (tidak ada perbaikan instan di tempat). Kalau derek tidak tersedia
 *     (tidak ada kotak), marshal memperbaiki di tempat setelah 5 detik.
 *  4. Insiden selesai → safety car masuk pit → **bendera hijau**.
 *
 * Kelas ini tidak menyentuh DOM dan tidak membuat mesh: mobil pendukung masuk
 * lewat antarmuka `ServiceHandle`, jadi seluruh alurnya bisa diuji headless.
 */
export type RaceFlag = 'green' | 'yellow';

export interface ServiceHandle {
  readonly reachedRoute: boolean;
  followLine(pace?: number): void;
  driveRoute(points: THREE.Vector3[], after: 'park' | 'line', pace?: number): void;
  /** Susuri garis balap sampai dekat titik, lalu berhenti di sisinya. */
  intercept?(target: THREE.Vector3, pace?: number): void;
  parkNow(): void;
  readonly car: { position: THREE.Vector3; yaw?: number };
}

export interface RaceCar {
  name: string;
  car: {
    position: THREE.Vector3;
    speed: number;
    damage: VehicleDamage;
    /** Kaitkan / lepas mobil ke kendaraan derek (opsional). */
    setTowed?(on: boolean): void;
    /** Pindahkan mobil yang sedang diangkut (tiap langkah). */
    carryTo?(position: THREE.Vector3, yaw: number): void;
    /** Turunkan mobil di kotak servis **tanpa** memperbaikinya. */
    dropAt?(position: THREE.Vector3, yaw: number): void;
  };
  isPlayer?: boolean;
}

/** Kotak servis tujuan derek. */
export interface TowTarget {
  position: THREE.Vector3;
  yaw: number;
}

export interface RaceControlSetup {
  safety?: ServiceHandle | null;
  ambulance?: ServiceHandle | null;
  /** Titik di garis balap tempat safety car masuk dari area servis. */
  scJoin: THREE.Vector3;
  /** Tempat parkir safety car. */
  scPark: THREE.Vector3;
  /** Pos medis (tempat ambulans menunggu). */
  ambPark: THREE.Vector3;
  /**
   * Kotak servis tempat mobil yang mogok diderek (null = derek tidak tersedia,
   * marshal memperbaiki di tempat).
   */
  towTo?: (name: string) => TowTarget | null;
  /** Titik masuk jalur pit, supaya derek tidak memotong rumput. */
  pitEntry?: THREE.Vector3;
}

export type RaceControlEvent =
  | { kind: 'yellow'; text: string }
  | { kind: 'green'; text: string }
  | { kind: 'attending'; text: string }
  | { kind: 'towing'; text: string }
  | { kind: 'repaired'; text: string };

export interface RaceControlOptions {
  /** Kecepatan di bawah ini dianggap berhenti (m/s). */
  stoppedSpeed: number;
  /** Berapa lama berhenti sebelum dianggap perlu bantuan (detik). */
  stuckTime: number;
  /** Lama safety car memimpin sebelum boleh masuk (detik). */
  minSafetyTime: number;
  /** Lama ambulans menangani di lokasi kalau mobil tidak diderek (detik). */
  attendTime: number;
  /** Lama mengait mobil ke derek (detik). */
  hookTime: number;
  /** Pengali pace AI selama bendera kuning. */
  yellowPace: number;
}

export const defaultRaceControlOptions: RaceControlOptions = {
  stoppedSpeed: 1.2,
  stuckTime: 4,
  minSafetyTime: 12,
  attendTime: 5,
  hookTime: 1.2,
  yellowPace: 0.55,
};

interface Incident {
  name: string;
  position: THREE.Vector3;
  /** Butuh ambulans (mesin mati / tidak bisa jalan)? */
  medical: boolean;
  /** Mobil yang kena (referensi hidup, supaya bisa diperbaiki). */
  target: RaceCar['car'];
  time: number;
  resolved: boolean;
}

export class RaceControl {
  readonly options: RaceControlOptions;
  flag: RaceFlag = 'green';
  scPhase: 'off' | 'deploying' | 'leading' | 'returning' = 'off';
  ambPhase: 'off' | 'toScene' | 'hooking' | 'towing' | 'repairing' | 'attending' | 'returning' = 'off';
  incident: Incident | null = null;

  private readonly setup: RaceControlSetup;
  /** Lama tiap mobil berhenti (detik), untuk mendeteksi mobil nyangkut. */
  private readonly stopped = new Map<string, number>();
  private yellowTime = 0;
  private attendTimer = 0;
  /** Kotak servis tujuan derek, disimpan saat insiden dimulai. */
  private towTarget: TowTarget | null = null;
  /** Tahap derek: susuri trek dulu ke pintu pit, lalu belok ke kotaknya. */
  private towLeg: 'line' | 'box' = 'line';
  /** Lama servis di pit untuk mobil yang diderek (detik). */
  private repairTime = 0;
  private readonly tmpTow = new THREE.Vector3();
  private readonly tmpFwd = new THREE.Vector3();
  private readonly tmpDrop = new THREE.Vector3();
  private readonly events: RaceControlEvent[] = [];

  constructor(setup: RaceControlSetup, options: Partial<RaceControlOptions> = {}) {
    this.setup = setup;
    this.options = { ...defaultRaceControlOptions, ...options };
  }

  get scActive(): boolean {
    return this.scPhase !== 'off';
  }

  /** Semua AI melambat & dilarang menyalip selama bendera kuning. */
  get paceScale(): number {
    return this.flag === 'yellow' ? this.options.yellowPace : 1;
  }

  get overtakeAllowed(): boolean {
    return this.flag === 'green';
  }

  drainEvents(): RaceControlEvent[] {
    return this.events.length ? this.events.splice(0, this.events.length) : [];
  }

  reset() {
    this.flag = 'green';
    this.scPhase = 'off';
    this.ambPhase = 'off';
    this.incident?.target.setTowed?.(false);
    this.incident = null;
    this.stopped.clear();
    this.yellowTime = 0;
    this.attendTimer = 0;
    this.towTarget = null;
    this.events.length = 0;
    this.setup.safety?.parkNow();
    this.setup.ambulance?.parkNow();
  }

  /** Satu langkah pengawasan. Panggil sekali per frame (setelah `sync()`). */
  update(dt: number, cars: readonly RaceCar[]) {
    if (!this.incident) {
      this.watch(dt, cars);
      return;
    }

    this.yellowTime += dt;
    const incident = this.incident;

    /* ---------------- safety car ---------------- */
    if (this.scPhase === 'deploying') {
      const safety = this.setup.safety;
      if (!safety) {
        this.scPhase = 'leading';
      } else if (this.yellowTime > 2.5) {
        // Sudah keluar dari area servis: mulai memimpin dari garis balap.
        safety.followLine(this.options.yellowPace);
        this.scPhase = 'leading';
      }
    } else if (this.scPhase === 'leading') {
      if (this.canReturn(cars) && this.yellowTime > this.options.minSafetyTime) {
        this.scPhase = 'returning';
        this.setup.safety?.driveRoute([this.setup.scPark], 'park', 0.5);
      }
    } else if (this.scPhase === 'returning') {
      const safety = this.setup.safety;
      if (!safety || safety.reachedRoute) {
        safety?.parkNow();
        this.scPhase = 'off';
        this.flag = 'green';
        this.incident = null;
        this.events.push({ kind: 'green', text: 'HIJAU · BALAPAN LANJUT' });
      }
    }

    /* ---------------- ambulans / derek ---------------- */
    const ambulance = this.setup.ambulance;
    if (this.ambPhase === 'toScene') {
      if (!ambulance) {
        this.ambPhase = 'off';
      } else if (ambulance.reachedRoute) {
        this.attendTimer = 0;
        if (this.towTarget) {
          // Mobil tidak bisa jalan: kait dan derek ke kotak servisnya.
          this.ambPhase = 'hooking';
          this.events.push({ kind: 'attending', text: 'AMBULANS DI LOKASI · MENYIAPKAN DEREK' });
        } else {
          this.ambPhase = 'attending';
          this.events.push({ kind: 'attending', text: 'AMBULANS DI LOKASI' });
        }
      }
    } else if (this.ambPhase === 'hooking') {
      this.attendTimer += dt;
      if (this.attendTimer >= this.options.hookTime) {
        incident.target.setTowed?.(true);
        this.ambPhase = 'towing';
        this.towLeg = this.setup.pitEntry && ambulance?.intercept ? 'line' : 'box';
        if (this.setup.pitEntry && ambulance?.intercept) {
          // Menarik derek: susuri trek dulu sampai pintu masuk pit.
          ambulance.intercept(this.setup.pitEntry.clone(), 0.7);
        } else {
          const dest = this.towTarget!;
          ambulance?.driveRoute([dest.position.clone()], 'park', 0.6);
        }
        this.events.push({ kind: 'towing', text: 'MOBIL DIDEREK KE PIT' });
      }
    } else if (this.ambPhase === 'towing') {
      // Mobil diangkut di belakang derek: posisinya mengikuti tiap langkah.
      if (ambulance) {
        const yaw = ambulance.car.yaw ?? 0;
        const behind = this.tmpTow
          .copy(ambulance.car.position)
          .addScaledVector(this.tmpFwd.set(Math.sin(yaw), 0, Math.cos(yaw)), -5.4);
        behind.y += 0.15;
        incident.target.carryTo?.(behind, yaw);
        if (ambulance.reachedRoute && this.towLeg === 'line') {
          // Sudah sampai pintu masuk pit: belok ke kotak servisnya.
          this.towLeg = 'box';
          ambulance.driveRoute([this.towTarget!.position.clone()], 'park', 0.5);
        } else if (ambulance.reachedRoute) {
          const dest = this.towTarget!;
          // Turunkan di kotaknya — servis tetap makan waktu (tidak instan).
          const drop = this.tmpDrop.copy(dest.position);
          drop.y += 1.05;
          incident.target.dropAt?.(drop, dest.yaw);
          incident.target.setTowed?.(false);
          this.ambPhase = 'repairing';
          this.attendTimer = 0;
          this.repairTime = serviceTimeFor(incident.target.damage);
          ambulance.parkNow();
          this.events.push({ kind: 'towing', text: 'MOBIL TIBA DI PIT · DISERVIS' });
        }
      } else {
        this.ambPhase = 'repairing';
        this.attendTimer = 0;
      }
    } else if (this.ambPhase === 'repairing') {
      this.attendTimer += dt;
      if (this.attendTimer >= this.repairTime) {
        // Kru servis selesai: bodi, mesin, dan ban baru.
        incident.target.damage.reset();
        incident.resolved = true;
        this.ambPhase = 'returning';
        this.towTarget = null;
        this.setup.ambulance?.driveRoute([this.setup.ambPark], 'park', 0.8);
        this.events.push({ kind: 'repaired', text: 'SERVIS PIT SELESAI' });
      }
    } else if (this.ambPhase === 'attending') {
      this.attendTimer += dt;
      if (this.attendTimer >= this.options.attendTime) {
        // Tanpa derek: marshal + dokter memperbaiki di tempat.
        incident.target.damage.reset();
        incident.resolved = true;
        this.ambPhase = 'returning';
        this.setup.ambulance?.driveRoute([this.setup.ambPark], 'park', 0.8);
        this.events.push({ kind: 'repaired', text: 'MOBIL DIPERBAIKI DI TEMPAT' });
      }
    } else if (this.ambPhase === 'returning') {
      if (!ambulance || ambulance.reachedRoute) {
        ambulance?.parkNow();
        this.ambPhase = 'off';
      }
    }

    // Insiden ringan (tanpa ambulans): selesai kalau mobilnya jalan lagi.
    if (!incident.resolved && !incident.medical) {
      const speed = incident.target.speed;
      if (speed > 5) incident.resolved = true;
    }
  }

  /** Mobil yang sudah bisa kembali ke jalur / tidak lagi menghalangi. */
  private canReturn(cars: readonly RaceCar[]): boolean {
    const incident = this.incident;
    if (!incident) return true;
    if (incident.resolved) return true;
    // Selama mobil masih diangkut / diservis, insiden belum selesai.
    if (this.ambPhase === 'hooking' || this.ambPhase === 'towing' || this.ambPhase === 'repairing') {
      return false;
    }
    const car = cars.find((c) => c.name === incident.name);
    if (!car) return true;
    // Sudah jalan lagi (mis. diselamatkan marshal / mundur sendiri).
    if (car.car.speed > 6) {
      incident.resolved = true;
      return true;
    }
    // Menghilang dari lintasan (di-reset pemain dengan R).
    if (car.car.position.distanceTo(incident.position) > 40) {
      incident.resolved = true;
      return true;
    }
    return false;
  }

  /** Cari mobil yang butuh bantuan. */
  private watch(dt: number, cars: readonly RaceCar[]) {
    for (const entry of cars) {
      const car = entry.car;
      const damage = car.damage;
      const wrecked =
        damage.engineDead || damage.immobile || damage.lostCount >= 2 || damage.bodyHealth < 0.25;

      const slow = Math.abs(car.speed) < this.options.stoppedSpeed;
      const stuckFor = slow ? (this.stopped.get(entry.name) ?? 0) + dt : 0;
      this.stopped.set(entry.name, stuckFor);

      // Berhenti lama TANPA rusak berat = mungkin nyangkut; tetap dikirim
      // marshal supaya balapan tidak macet, tapi tanpa ambulans.
      const blocked = stuckFor > this.options.stuckTime && damage.bodyHealth < 0.95;

      if (wrecked || blocked) {
        this.startIncident(entry, wrecked && (damage.engineDead || damage.immobile));
        return;
      }
    }
  }

  private startIncident(entry: RaceCar, medical: boolean) {
    const position = entry.car.position.clone();
    this.incident = {
      name: entry.name,
      position,
      medical,
      target: entry.car,
      time: 0,
      resolved: false,
    };
    this.flag = 'yellow';
    this.scPhase = 'deploying';
    this.yellowTime = 0;
    this.stopped.set(entry.name, 0);
    // Mobil yang tidak bisa jalan diderek ke kotak servisnya (kalau ada).
    const stuck = entry.car.damage.engineDead || entry.car.damage.immobile || entry.car.damage.lostCount >= 2;
    this.towTarget = medical && stuck ? (this.setup.towTo?.(entry.name) ?? null) : null;
    this.repairTime = 0;

    this.setup.safety?.driveRoute([this.setup.scJoin], 'line', 0.7);
    this.events.push({ kind: 'yellow', text: `KUNING · ${entry.name.toUpperCase()} KECELAKAAN` });

    if (medical && this.setup.ambulance) {
      this.ambPhase = 'toScene';
      const scene = position.clone();
      scene.y = Math.max(0.95, position.y);
      // Susuri trek dulu, baru belok ke lokasi — ambulance tidak bisa
      // menyetir lurus menembus kerb dan tanggul.
      if (this.setup.ambulance.intercept) this.setup.ambulance.intercept(scene, 0.85);
      else this.setup.ambulance.driveRoute([scene], 'park', 0.9);
      this.events.push({ kind: 'yellow', text: 'AMBULANS DIBERANGKATKAN' });
    }
  }
}
