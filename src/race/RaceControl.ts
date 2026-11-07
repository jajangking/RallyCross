import * as THREE from 'three';
import type { VehicleDamage } from '../vehicle/Damage';

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
 *  3. Kalau insidennya berat, ambulans meluncur ke lokasi, menangani 5 detik,
 *     lalu mobil itu diperbaiki di tempat.
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
  parkNow(): void;
  readonly car: { position: THREE.Vector3 };
}

export interface RaceCar {
  name: string;
  car: {
    position: THREE.Vector3;
    speed: number;
    damage: VehicleDamage;
  };
  isPlayer?: boolean;
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
}

export type RaceControlEvent =
  | { kind: 'yellow'; text: string }
  | { kind: 'green'; text: string }
  | { kind: 'attending'; text: string }
  | { kind: 'repaired'; text: string };

export interface RaceControlOptions {
  /** Kecepatan di bawah ini dianggap berhenti (m/s). */
  stoppedSpeed: number;
  /** Berapa lama berhenti sebelum dianggap perlu bantuan (detik). */
  stuckTime: number;
  /** Lama safety car memimpin sebelum boleh masuk (detik). */
  minSafetyTime: number;
  /** Lama ambulans menangani di lokasi (detik). */
  attendTime: number;
  /** Pengali pace AI selama bendera kuning. */
  yellowPace: number;
}

export const defaultRaceControlOptions: RaceControlOptions = {
  stoppedSpeed: 1.2,
  stuckTime: 4,
  minSafetyTime: 12,
  attendTime: 5,
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
  ambPhase: 'off' | 'toScene' | 'attending' | 'returning' = 'off';
  incident: Incident | null = null;

  private readonly setup: RaceControlSetup;
  /** Lama tiap mobil berhenti (detik), untuk mendeteksi mobil nyangkut. */
  private readonly stopped = new Map<string, number>();
  private yellowTime = 0;
  private attendTimer = 0;
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
    this.incident = null;
    this.stopped.clear();
    this.yellowTime = 0;
    this.attendTimer = 0;
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

    /* ---------------- ambulans ---------------- */
    if (this.ambPhase === 'toScene') {
      const ambulance = this.setup.ambulance;
      if (!ambulance) {
        this.ambPhase = 'off';
      } else if (ambulance.reachedRoute) {
        this.ambPhase = 'attending';
        this.attendTimer = 0;
        this.events.push({ kind: 'attending', text: 'AMBULANS DI LOKASI' });
      }
    } else if (this.ambPhase === 'attending') {
      this.attendTimer += dt;
      if (this.attendTimer >= this.options.attendTime) {
        // Marshal + dokter memperbaiki mobil di tempat (bodi, mesin, ban).
        incident.target.damage.reset();
        incident.resolved = true;
        this.ambPhase = 'returning';
        this.setup.ambulance?.driveRoute([this.setup.ambPark], 'park', 0.8);
        this.events.push({ kind: 'repaired', text: 'MOBIL DIPERBAIKI DI TEMPAT' });
      }
    } else if (this.ambPhase === 'returning') {
      const ambulance = this.setup.ambulance;
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

    this.setup.safety?.driveRoute([this.setup.scJoin], 'line', 0.7);
    this.events.push({ kind: 'yellow', text: `KUNING · ${entry.name.toUpperCase()} KECELAKAAN` });

    if (medical && this.setup.ambulance) {
      this.ambPhase = 'toScene';
      const side = new THREE.Vector3(1, 0, 0);
      const scene = position.clone().addScaledVector(side, 5.5);
      scene.y = Math.max(0.95, position.y);
      this.setup.ambulance.driveRoute([scene], 'park', 0.9);
      this.events.push({ kind: 'yellow', text: 'AMBULANS DIBERANGKATKAN' });
    }
  }
}
