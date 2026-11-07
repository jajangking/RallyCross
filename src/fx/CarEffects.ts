import * as THREE from 'three';
import type { VehiclePhysics, VehicleInput } from '../vehicle/VehiclePhysics';
import type { SkidMarks } from './SkidMarks';
import type { SmokePuffs } from './Smoke';

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** Warna debu/asap per jenis permukaan (friction dari collider trek). */
const TARMAC_SMOKE = 0xd8d8dc;
const GRAVEL_DUST = 0xa08a68;
const GRASS_DUST = 0x7f8a5c;

interface WheelTrail {
  /** Tepi kiri/kanan tapak pada frame sebelumnya. */
  left: THREE.Vector3;
  right: THREE.Vector3;
  active: boolean;
}

/**
 * Efek visual satu mobil: jejak ban saat ban selip, asap saat ban terbakar,
 * debu di gravel, dan kepulan debu saat mendarat dari lompatan.
 *
 * Semua angka diambil dari `WheelState` yang sudah dihitung fisika
 * (`vLat`, `slipAngle`, `traction`, `surfaceMu`, `contactPoint`) — jadi efeknya
 * benar-benar mengikuti apa yang dilakukan ban, bukan animasi yang dipicu
 * kecepatan mobil saja.
 */
export class CarEffects {
  private readonly trails: WheelTrail[] = [];
  private readonly tmpL = new THREE.Vector3();
  private readonly tmpR = new THREE.Vector3();
  private readonly side = new THREE.Vector3();
  private readonly tmpP = new THREE.Vector3();
  private readonly tmpPush = new THREE.Vector3();
  /** Berapa lama mobil melayang (detik), untuk mengukur kerasnya pendaratan. */
  private airTime = 0;
  private wasAirborne = false;
  private smokeBudget = 2;

  constructor(
    private readonly car: VehiclePhysics,
    private readonly marks: SkidMarks,
    private readonly smoke: SmokePuffs,
  ) {
    for (let i = 0; i < 4; i++) {
      this.trails.push({
        left: new THREE.Vector3(),
        right: new THREE.Vector3(),
        active: false,
      });
    }
  }

  /** Lepas jejak yang sedang berjalan (mis. mobil di-reset ke grid). */
  reset(): void {
    for (const t of this.trails) t.active = false;
    this.airTime = 0;
    this.wasAirborne = false;
  }

  update(dt: number, command?: VehicleInput): void {
    const car = this.car;
    const speed = Math.hypot(car.velocity.x, car.velocity.z);
    let contacts = 0;

    for (let i = 0; i < 4; i++) {
      const w = car.wheels[i];
      const trail = this.trails[i];
      if (!w.contact) {
        trail.active = false;
        continue;
      }
      contacts++;

      // Seberapa parah ban ini selip: lateral (drift) + lonjakan putaran
      // (traksi mentok sementara roda masih menggali).
      const lat = Math.abs(w.vLat);
      const slip = Math.max(lat, Math.abs(w.slipAngle) * 6);
      const wheelspin =
        command && !w.isFront && command.throttle > 0.45 && speed < 7 ? w.traction * 3 : 0;
      const spinning =
        command && !w.isFront && command.handbrake && speed > 6 ? 3 : 0;
      const amount = Math.max(slip, wheelspin, spinning);

      const onTarmac = w.surfaceMu > 0.85;
      // Di gravel/rumput jejak tetap boleh muncul, tapi lebih tipis dan
      // berwarna debu — bukan garis hitam.
      const threshold = onTarmac ? 1.1 : 2.6;
      const marking = amount > threshold && speed > 0.8;

      // Tepi tapak ban di permukaan, sedikit di atasnya supaya tidak z-fight.
      this.side.crossVectors(w.forward, w.normal);
      const sideLen = this.side.length();
      if (!Number.isFinite(sideLen) || sideLen < 1e-4) {
        // Rangka ban rusak/tegak lurus: jangan menulis NaN ke buffer jejak.
        trail.active = false;
        continue;
      }
      this.side.divideScalar(sideLen);
      const halfWidth = 0.14;
      this.tmpL
        .copy(w.contactPoint)
        .addScaledVector(w.normal, 0.025)
        .addScaledVector(this.side, -halfWidth);
      this.tmpR
        .copy(w.contactPoint)
        .addScaledVector(w.normal, 0.025)
        .addScaledVector(this.side, halfWidth);

      if (marking) {
        const strength = clamp((amount - threshold) / 4.5, 0.12, 1) * (onTarmac ? 0.95 : 0.42);
        if (trail.active) {
          // Quad antara posisi tapak sebelumnya dan sekarang = strip kontinu.
          this.marks.add(trail.left, trail.right, this.tmpL, this.tmpR, strength);
        }
        trail.left.copy(this.tmpL);
        trail.right.copy(this.tmpR);
        trail.active = true;
      } else {
        trail.active = false;
      }

      /* ---------- asap / debu ---------- */
      if (amount > 2.2 && speed > 3 && this.smokeBudget > 0) {
        const rate = clamp((amount - 2.2) / 5, 0, 1) * (onTarmac ? 0.55 : 0.35);
        if (Math.random() < rate) {
          this.smokeBudget--;
          this.tmpP.copy(w.contactPoint).addScaledVector(w.normal, 0.18);
          // Dorongan ke belakang, searah jejak ban yang selip.
          this.tmpPush.set(-w.forward.x, 0, -w.forward.z).multiplyScalar(Math.min(3.5, amount * 0.4));
          this.smoke.spawn(
            this.tmpP,
            onTarmac
              ? {
                  size: 0.55,
                  grow: 2.6,
                  color: TARMAC_SMOKE,
                  life: 1.25,
                  rise: 0.7,
                  spread: 0.9,
                  opacity: 0.42,
                }
              : {
                  size: 0.7,
                  grow: 3.4,
                  color: w.surfaceMu > 0.58 ? GRAVEL_DUST : GRASS_DUST,
                  life: 1.5,
                  rise: 0.5,
                  spread: 1.4,
                  opacity: 0.34,
                },
            this.tmpPush,
          );
        }
      } else if (!onTarmac && speed > 7 && this.smokeBudget > 0) {
        // Debu yang terlempar roda di gravel/rumput, walau ban tidak selip.
        if (Math.random() < 0.09) {
          this.smokeBudget--;
          this.tmpP.copy(w.contactPoint).addScaledVector(w.normal, 0.12);
          this.tmpPush.set(-w.forward.x, 0, -w.forward.z).multiplyScalar(speed * 0.06);
          this.smoke.spawn(
            this.tmpP,
            {
              size: 0.45,
              grow: 2.2,
              color: w.surfaceMu > 0.58 ? GRAVEL_DUST : GRASS_DUST,
              life: 1.1,
              rise: 0.45,
              spread: 0.8,
              opacity: 0.2,
            },
            this.tmpPush,
          );
        }
      }
    }

    /* ---------- pendaratan ---------- */
    const airborne = contacts === 0;
    if (airborne) {
      this.airTime += dt;
    } else {
      if (this.wasAirborne && this.airTime > 0.12) {
        // Makin lama melayang, makin tebal debu yang naik saat menyentuh tanah.
        const burst = Math.round(clamp(4 + this.airTime * 9, 4, 18));
        for (let i = 0; i < burst; i++) {
          const w = car.wheels[i % 4];
          this.tmpP
            .copy(w.contact ? w.contactPoint : car.position)
            .addScaledVector(w.normal, 0.1);
          this.smoke.spawn(this.tmpP, {
            size: 0.6,
            grow: 3.2,
            color: w.surfaceMu > 0.85 ? 0xb9bcc2 : w.surfaceMu > 0.58 ? GRAVEL_DUST : GRASS_DUST,
            life: 1.35,
            rise: 0.55,
            spread: 2.2,
            opacity: 0.34,
          });
        }
      }
      this.airTime = 0;
    }
    this.wasAirborne = airborne;

    // Anggaran asap per mobil per frame: menjamin enam mobil tidak membanjiri
    // kolam partikel saat semuanya drifting di gravel.
    this.smokeBudget = 2;
  }
}
