import * as THREE from 'three';
import type { VehiclePhysics } from './vehicle/VehiclePhysics';
import type { BroadcastSpot } from './world/track';
import { BroadcastDirector } from './camera/BroadcastDirector';

const up = new THREE.Vector3(0, 1, 0);
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export type CameraMode = 'chase' | 'hood' | 'tv';

/** Jeda gambar darat sebelum siaran "naik" ke helikopter (detik). */
const AERIAL_EVERY: [number, number] = [8, 15];
/** Berapa lama gambar udara bertahan (detik). */
const AERIAL_HOLD: [number, number] = [4.5, 7];
/** Kamera darat harus sudah tampil selama ini sebelum boleh ditinggalkan. */
const AERIAL_MIN_GROUND = 2.4;

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  /** Sutradara kamera TV; null kalau tidak ada kamera yang dipasang. */
  readonly director: BroadcastDirector | null;

  distance = 7.4;
  height = 2.9;
  fovBase = 62;

  private currentMode: CameraMode = 'chase';
  private tvFov = 30;
  private readonly pos = new THREE.Vector3(0, 4, -10);
  private readonly look = new THREE.Vector3();
  private readonly desiredPos = new THREE.Vector3();
  private readonly desiredLook = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();

  /* --- kamera udara (helikopter), ikut disiarkan sebagai salah satu kamera --- */
  /** Posisi lensa helikopter, di-set tiap frame oleh main. */
  private readonly aerialEye = new THREE.Vector3();
  private hasAerial = false;
  private readonly aerialAim = new THREE.Vector3();
  private readonly prevFocus = new THREE.Vector3();
  private hasFocus = false;
  private readonly aerial = { active: false, wait: 11, held: 0, limit: 5, cut: false };

  constructor(aspect: number, spots: BroadcastSpot[] = []) {
    this.camera = new THREE.PerspectiveCamera(this.fovBase, aspect, 0.1, 400);
    this.camera.position.set(0, 5, -12);
    this.director = spots.length ? new BroadcastDirector(spots) : null;
  }

  /** `C`: kamera chase -> kap -> TV -> chase. */
  toggleMode() {
    this.setMode(
      this.currentMode === 'chase' ? 'hood' : this.currentMode === 'hood' ? 'tv' : 'chase',
    );
  }

  setMode(mode: CameraMode) {
    this.currentMode = mode;
    if (mode === 'tv') {
      this.director?.takeCut();
      // Siaran yang baru masuk TV mulai dari kamera darat dulu.
      this.aerial.active = false;
      this.aerial.held = 0;
      this.aerial.wait = AERIAL_EVERY[0];
    }
  }

  get modeName(): CameraMode {
    return this.currentMode;
  }

  /**
   * Daftarkan lensa helikopter. `null` = tidak ada kamera udara (mis. sebelum
   * heli dibuat), dan siaran kembali ke kamera darat saja.
   */
  setAerialEye(eye: THREE.Vector3 | null) {
    if (eye) {
      this.aerialEye.copy(eye);
      this.hasAerial = true;
    } else {
      this.hasAerial = false;
    }
  }

  /** Sedang memakai gambar helikopter? (dipakai untuk menyembunyikan modelnya) */
  get aerialActive(): boolean {
    return this.currentMode === 'tv' && this.aerial.active;
  }

  /** Pindah ke kamera TV berikutnya (manual) dan aktifkan mode TV. */
  nextCamera(): string | null {
    const spot = this.director?.next();
    if (!spot) return null;
    this.setMode('tv');
    return spot.name;
  }

  /** Nama kamera TV yang sedang dipakai, mis. "T3" — atau "HELI". */
  get broadcastName(): string | null {
    if (this.currentMode !== 'tv') return null;
    if (this.aerial.active) return 'HELI';
    return this.director?.current?.name ?? null;
  }

  snap(phys: VehiclePhysics) {
    if (this.currentMode === 'tv') {
      const spot = this.director?.current;
      if (this.aerial.active && this.hasAerial) {
        this.pos.copy(this.aerialEye);
        this.look.copy(phys.position);
      } else if (spot) {
        this.pos.copy(spot.position);
        this.look.copy(spot.aim);
      }
      this.camera.position.copy(this.pos);
      this.camera.lookAt(this.look);
      return;
    }
    this.computeDesired(phys);
    this.pos.copy(this.desiredPos);
    this.look.copy(this.desiredLook);
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
  }

  /**
   * Kamera TV: kamera tetap di pinggir trek, mengikuti mobil dengan pan halus,
   * dan memotong ke kamera lain saat sutradara memilih sudut baru. Sesekali
   * potongannya ke **helikopter** — gambar udara yang mengikuti mobil dari atas,
   * seperti siaran rallycross sungguhan.
   */
  updateBroadcast(
    dt: number,
    focus: THREE.Vector3,
    trackDistance: number,
    lapLength: number,
    /** true = sasaran berganti, jadi gambar harus dipotong (bukan ditarik). */
    focusCut = false,
  ) {
    // Arah gerak mobil (untuk menaruh mobil di bawah frame + melihat ke depan).
    if (!this.hasFocus) {
      this.prevFocus.copy(focus);
      this.hasFocus = true;
    }
    this.fwd.subVectors(focus, this.prevFocus).divideScalar(Math.max(dt, 1e-4));
    this.fwd.y = 0;
    if (this.fwd.lengthSq() > 60 * 60) this.fwd.setLength(60);
    this.prevFocus.copy(focus);
    this.aerialAim.copy(focus).addScaledVector(this.fwd, 0.22).addScaledVector(up, 0.6);

    const director = this.director;
    const spot = director?.update(dt, focus, trackDistance, lapLength) ?? null;
    const wasAerial = this.aerial.active;

    if (this.aerialStep(dt)) {
      // ---- gambar udara ----
      const cut = !wasAerial;
      if (cut) {
        this.pos.copy(this.aerialEye);
        this.look.copy(this.aerialAim);
        this.aerial.cut = true;
      } else {
        this.pos.lerp(this.aerialEye, 1 - Math.exp(-9 * dt));
        this.look.lerp(this.aerialAim, 1 - Math.exp(-5 * dt));
      }
      this.camera.position.copy(this.pos);
      this.camera.lookAt(this.look);
      const targetFov = clamp(52 - (this.pos.distanceTo(focus) - 24) * 0.5, 32, 58);
      this.tvFov += (targetFov - this.tvFov) * (1 - Math.exp(-5 * dt));
      this.camera.fov = this.tvFov;
      this.camera.updateProjectionMatrix();
      return;
    }

    if (!spot) return;

    // Kembali dari helikopter (atau sasaran baru): langsung potong ke kamera
    // darat terpilih — jangan menarik lensa melintasi trek.
    const cut = (director?.takeCut() ?? false) || wasAerial || focusCut;
    if (cut) {
      this.pos.copy(spot.position);
      this.look.copy(focus);
      // Kembali dari gambar udara, lensanya ikut "potong" (bukan zoom pelan).
      if (wasAerial) this.tvFov = 30;
    } else {
      this.pos.lerp(spot.position, 1 - Math.exp(-6 * dt));
      this.look.lerp(focus, 1 - Math.exp(-7 * dt));
    }
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);

    // Lensa tele saat mobilnya jauh, sudut lebar saat lewat dekat kamera.
    const distance = this.pos.distanceTo(focus);
    const targetFov = clamp(30 + (45 - distance) * 0.55, 16, 62);
    const k = cut ? 1 : 1 - Math.exp(-4 * dt);
    this.tvFov += (targetFov - this.tvFov) * k;
    this.camera.fov = this.tvFov;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Jadwal selipan kamera udara. `true` = frame ini pakai gambar helikopter.
   */
  private aerialStep(dt: number): boolean {
    const a = this.aerial;
    if (!this.hasAerial) {
      a.active = false;
      return false;
    }
    if (a.active) {
      a.held += dt;
      if (a.held < a.limit) return true;
      a.active = false;
      a.held = 0;
      a.wait = AERIAL_EVERY[0] + Math.random() * (AERIAL_EVERY[1] - AERIAL_EVERY[0]);
      return false;
    }
    a.wait -= dt;
    const groundSettled = (this.director?.dwell ?? 0) > AERIAL_MIN_GROUND;
    if (a.wait <= 0 && groundSettled) {
      a.active = true;
      a.held = 0;
      a.limit = AERIAL_HOLD[0] + Math.random() * (AERIAL_HOLD[1] - AERIAL_HOLD[0]);
      return true;
    }
    return false;
  }

  private computeDesired(phys: VehiclePhysics) {
    const p = phys.position;
    this.fwd.set(0, 0, 1).applyQuaternion(phys.quaternion);
    this.fwd.y = 0;
    if (this.fwd.lengthSq() < 1e-4) this.fwd.set(0, 0, 1);
    this.fwd.normalize();

    if (this.currentMode === 'hood') {
      this.desiredPos.copy(p).addScaledVector(up, 1.02).addScaledVector(this.fwd, 0.45);
      this.desiredLook.copy(p).addScaledVector(this.fwd, 14).addScaledVector(up, 1.0);
    } else {
      this.desiredPos.copy(p).addScaledVector(this.fwd, -this.distance).addScaledVector(up, this.height);
      this.desiredLook.copy(p).addScaledVector(this.fwd, 4.5).addScaledVector(up, 1.1);
    }
  }

  /** Kamera chase/kap. Mode TV punya jalur sendiri. */
  update(dt: number, phys: VehiclePhysics) {
    if (this.currentMode === 'tv') return;
    this.computeDesired(phys);

    const posK = 1 - Math.exp(-9 * dt);
    const lookK = 1 - Math.exp(-13 * dt);
    // Kembali dari kamera TV (atau dari reset) jangan melayang jauh: snap.
    if (this.pos.distanceToSquared(this.desiredPos) > 30 * 30) this.pos.copy(this.desiredPos);
    else this.pos.lerp(this.desiredPos, posK);
    if (this.look.distanceToSquared(this.desiredLook) > 60 * 60) this.look.copy(this.desiredLook);
    else this.look.lerp(this.desiredLook, lookK);

    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);

    const speedT = Math.min(phys.speedKmh / 170, 1);
    const targetFov = this.fovBase + speedT * 13;
    this.camera.fov += (targetFov - this.camera.fov) * (1 - Math.exp(-3 * dt));
    this.camera.updateProjectionMatrix();
  }

  resize(aspect: number) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}
