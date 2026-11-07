import * as THREE from 'three';
import type { VehiclePhysics } from './vehicle/VehiclePhysics';
import type { BroadcastSpot } from './world/track';
import { BroadcastDirector } from './camera/BroadcastDirector';

const up = new THREE.Vector3(0, 1, 0);
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export type CameraMode = 'chase' | 'hood' | 'tv';

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

  constructor(aspect: number, spots: BroadcastSpot[] = []) {
    this.camera = new THREE.PerspectiveCamera(this.fovBase, aspect, 0.1, 700);
    this.camera.position.set(0, 5, -12);
    this.director = spots.length ? new BroadcastDirector(spots) : null;
  }

  /** `C`: kamera chase -> kap -> TV -> chase. */
  toggleMode() {
    this.setMode(this.currentMode === 'chase' ? 'hood' : this.currentMode === 'hood' ? 'tv' : 'chase');
  }

  setMode(mode: CameraMode) {
    this.currentMode = mode;
    if (mode === 'tv') this.director?.takeCut();
  }

  get modeName(): CameraMode {
    return this.currentMode;
  }

  /** Pindah ke kamera TV berikutnya (manual) dan aktifkan mode TV. */
  nextCamera(): string | null {
    const spot = this.director?.next();
    if (!spot) return null;
    this.setMode('tv');
    return spot.name;
  }

  /** Nama kamera TV yang sedang dipakai, mis. "T3". */
  get broadcastName(): string | null {
    return this.currentMode === 'tv' ? (this.director?.current?.name ?? null) : null;
  }

  snap(phys: VehiclePhysics) {
    if (this.currentMode === 'tv') {
      const spot = this.director?.current;
      if (spot) {
        this.pos.copy(spot.position);
        this.look.copy(spot.aim);
        this.camera.position.copy(this.pos);
        this.camera.lookAt(this.look);
      }
      return;
    }
    this.computeDesired(phys);
    this.pos.copy(this.desiredPos);
    this.look.copy(this.desiredLook);
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
  }

  /**
   * Kamera TV: duduk diam di menara pinggir trek, mengikuti mobil dengan pan
   * halus, dan memotong ke kamera lain saat sutradara memilih sudut baru.
   */
  updateBroadcast(dt: number, focus: THREE.Vector3, trackDistance: number, lapLength: number) {
    const spot = this.director?.update(dt, focus, trackDistance, lapLength);
    if (!spot) return;

    const cut = this.director?.takeCut() ?? false;
    if (cut) {
      this.pos.copy(spot.position);
      this.look.copy(focus);
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

  /** Kamera chase/kap. Mode TV dijalankan lewat `updateBroadcast`. */
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
