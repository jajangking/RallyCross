import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { AutoPilot, type TrafficCar } from '../ai/AutoPilot';
import { CarVisual } from '../vehicle/CarVisual';
import { defaultConfig, VehiclePhysics, type VehicleInput } from '../vehicle/VehiclePhysics';
import { toon } from '../world/style';
import type { PathSample } from '../world/circuit';
import type { CarLightState } from '../vehicle/CarLights';

export type ServiceKind = 'safety' | 'ambulance';

export interface ServiceSetup {
  kind: ServiceKind;
  world: RAPIER.World;
  /** Tanpa scene (uji headless), mobilnya tetap ada tapi tanpa mesh. */
  scene?: THREE.Scene;
  /** Kotak parkir (di area servis). */
  park: THREE.Vector3;
  yaw: number;
  main: PathSample[];
  joker: PathSample[];
  /** Warna bodi. */
  color: number;
  detail: boolean;
}

/**
 * Mobil pendukung: **safety car** dan **ambulans**.
 *
 * Keduanya mobil fisika sungguhan (bukan animasi): punya suspensi, ban, dan
 * bisa ditabrak. Bedanya cuma cara menyetir:
 *  - `line` — mengikuti garis balap pelan (safety car memimpin rombongan).
 *  - `route` — menyetir dari titik ke titik (jalur pendek, mis. di area
 *    servis). `intercept()` memakai mode ini dengan rute yang disusun
 *    menyusuri garis balap: ambulans tidak bisa menyetir lurus menembus
 *    tanggul, dan tidak perlu mengelilingi satu putaran penuh.
 *  - `parked` — diam di kotaknya.
 *
 * Lampu atap berkedip saat bertugas; karena hanya dua balok kecil yang
 * dibangun, biayanya praktis nol walau `?quality=low`.
 */
export class ServiceVehicle {
  readonly car: VehiclePhysics;
  readonly pilot: AutoPilot;
  /** Bodi mobil; `null` kalau dijalankan tanpa renderer (uji headless). */
  readonly visual: CarVisual | null;
  readonly kind: ServiceKind;

  mode: 'parked' | 'route' | 'line' = 'parked';
  /** Titik-titik yang dituju pada mode `route`. */
  private route: THREE.Vector3[] = [];
  private routeIndex = 0;
  private arrived = false;
  /** Setelah rute selesai: 'park' (diam) atau 'line' (ikut garis balap). */
  private afterRoute: 'park' | 'line' = 'park';

  private readonly park: THREE.Vector3;
  private readonly yaw: number;
  /** Titik yang dikejar `intercept()` — cukup dekat, tidak harus tepat. */
  private chase: THREE.Vector3 | null = null;
  private readonly barMat: THREE.MeshToonMaterial;
  private readonly lights: CarLightState = {
    brake: 0,
    reverse: false,
    left: false,
    right: false,
    hazard: false,
    headlights: true,
  };
  private blink = 0;

  constructor(setup: ServiceSetup) {
    this.kind = setup.kind;
    this.park = setup.park.clone();
    this.yaw = setup.yaw;
    this.car = new VehiclePhysics(setup.world, defaultConfig, this.park, this.yaw);
    this.pilot = new AutoPilot(setup.main, setup.joker, {
      useJoker: false,
      laneOffset: 0,
      pace: 0.55,
      overtake: false,
      chase: false,
    });
    this.pilot.reset(this.car.position);
    this.visual = setup.scene
      ? new CarVisual(setup.scene, this.car, { detail: setup.detail, paint: setup.color })
      : null;

    // Lampu atap: dua balok (merah / biru) yang bergantian menyala.
    this.barMat = toon({ color: 0xff2d2d });
    if (this.visual) {
      const bar = new THREE.Group();
      const base = new THREE.Mesh(new THREE.BoxGeometry(1.24, 0.09, 0.26), toon({ color: 0x20242a }));
      base.position.y = 0.75;
      bar.add(base);
      const red = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.13, 0.24), this.barMat);
      red.position.set(-0.3, 0.85, 0);
      bar.add(red);
      const blue = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.13, 0.24), toon({ color: 0x2f6dff }));
      blue.position.set(0.3, 0.85, 0);
      bar.add(blue);
      this.visual.root.add(bar);
    }
  }

  get deployed(): boolean {
    return this.mode !== 'parked';
  }

  /** Berhenti di kotaknya (dipakai saat balapan diulang). */
  parkNow() {
    this.mode = 'parked';
    this.route = [];
    this.chase = null;
    this.arrived = false;
    this.car.placeAt(this.park, this.yaw);
    this.pilot.reset(this.car.position);
  }

  /** Berhenti di tempat, tanpa teleport pulang ke kotak parkir. */
  hold() {
    this.mode = 'parked';
    this.route = [];
    this.chase = null;
    this.arrived = true;
  }

  /** Ikuti garis balap pelan (safety car memimpin). */
  followLine(pace = 0.55) {
    this.mode = 'line';
    this.route = [];
    this.chase = null;
    this.pilot.options.pace = pace;
    this.pilot.reset(this.car.position);
  }

  /**
   * Menyetir berurutan ke `points`, lalu `after`: parkir atau masuk garis.
   * `onArrive` dipanggil sekali ketika titik terakhir tercapai.
   */
  driveRoute(points: THREE.Vector3[], after: 'park' | 'line', pace = 0.8) {
    this.mode = 'route';
    this.chase = null;
    this.route = points.map((p) => p.clone());
    this.routeIndex = 0;
    this.arrived = false;
    this.afterRoute = after;
    this.pilot.options.pace = pace;
  }

  /** Jarak (m) yang dianggap "sudah sampai" untuk `intercept()`. */
  private readonly chaseRadius = 9;

  /** Sudah sampai di titik terakhir rute? */
  get reachedRoute(): boolean {
    return this.arrived;
  }

  /**
   * Kejar sebuah titik **menyusuri garis balap** (arah mana pun yang lebih
   * dekat), lalu belok ke titiknya di ujung rute.
   *
   * Dipakai ambulans: menyetir lurus ke lokasi kecelakaan berarti menerjang
   * kerb dan tanggul; mengikuti garis balap ke arah balap berarti mengelilingi
   * hampir satu putaran penuh kalau kecelakaannya ada di belakang.
   */
  intercept(target: THREE.Vector3, pace = 0.85) {
    // Selalu menyusuri garis balap **searah balap** (tidak pernah lawan arah):
    // kalau lokasinya di belakang pun, ambulans memutar satu putaran. Lalu
    // merapat ke titiknya saat sudah dekat.
    this.followLine(pace);
    // Cukup berhenti **di dekat** titiknya: kalau harus tepat, mobil darurat
    // akan mendorong mobil yang mogok.
    this.chase = target.clone();
  }

  /** Titik yang sedang dituju (null kalau tidak ada). */
  get currentTarget(): THREE.Vector3 | null {
    return this.route[this.routeIndex] ?? null;
  }

  /** Satu langkah: kembalikan perintah yang juga sudah dikirim ke mobil. */
  step(dt: number, others: ReadonlyArray<TrafficCar> = []): VehicleInput {
    let command: VehicleInput = { throttle: 0, brake: 1, steer: 0, handbrake: false, gear: 1 };
    if (this.mode === 'line') {
      this.arrived = false;
      if (this.chase) {
        const gap = this.chase.distanceTo(this.car.position);
        if (gap < this.chaseRadius) {
          // Sudah di sampingnya.
          this.hold();
          this.car.fixedStep(dt, command);
          return command;
        }
        if (gap < 30) {
          // Dekat tapi tidak persis di garis (mis. mobil terlempar ke rumput).
          command = this.pilot.driveTo(dt, this.car, this.chase, { maxSpeed: 10, stopDistance: 4 });
          this.car.fixedStep(dt, command);
          return command;
        }
      }
      command = this.pilot.update(dt, this.car, others);
    } else if (this.mode === 'route') {
      // Sudah cukup dekat dengan titik yang dikejar? Berhenti di sisinya.
      if (this.chase && this.chase.distanceTo(this.car.position) < this.chaseRadius) {
        this.chase = null;
        this.arrived = true;
        this.mode = 'parked';
        this.route = [];
        this.routeIndex = 0;
        this.car.fixedStep(dt, command);
        return command;
      }
      const target = this.route[this.routeIndex];
      if (!target) {
        this.finishRoute();
      } else {
        const last = this.routeIndex === this.route.length - 1;
        command = this.pilot.driveTo(dt, this.car, target, {
          // Titik terakhir: berhenti di sana. Titik antara: **dilewati** —
          // rem di tiap waypoint membuat rute susur garis jadi sangat lambat.
          maxSpeed: this.kind === 'ambulance' ? 16 : 14,
          stopDistance: last ? 3.5 : 0,
        });
        const dx = target.x - this.car.position.x;
        const dz = target.z - this.car.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist < (last ? 4.5 : 8)) {
          if (last) {
            this.arrived = true;
            command = { throttle: 0, brake: 1, steer: 0, handbrake: false, gear: 1 };
            // Rute selesai: parkir atau lanjut memimpin garis balap.
            this.finishRoute();
          } else {
            this.routeIndex++;
          }
        }
      }
    }
    this.car.fixedStep(dt, command);
    return command;
  }

  private finishRoute() {
    this.arrived = true;
    if (this.afterRoute === 'line') this.followLine();
    else this.mode = 'parked';
  }

  /** Sinkronkan bodi + kedip lampu. Panggil setelah `world.step()`. */
  sync(dt: number) {
    this.car.sync();
    this.lights.hazard = this.deployed;
    this.lights.brake = this.car.speed > 0.5 ? 0.4 : 1;
    this.visual?.update(this.car, dt, this.lights);
    this.blink += dt;
    const on = this.deployed && Math.sin(this.blink * 12) > 0;
    this.barMat.color.setHex(on ? 0xff2d2d : 0x4a1212);
    this.barMat.emissive.setHex(on ? 0xff2d2d : 0x000000);
  }

  dispose() {
    this.visual?.root.removeFromParent();
  }
}
