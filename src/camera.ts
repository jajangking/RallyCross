import * as THREE from 'three';
import type { VehiclePhysics } from './vehicle/VehiclePhysics';

const up = new THREE.Vector3(0, 1, 0);

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;

  distance = 7.4;
  height = 2.9;
  fovBase = 62;

  private currentMode: 'chase' | 'hood' = 'chase';
  private readonly pos = new THREE.Vector3(0, 4, -10);
  private readonly look = new THREE.Vector3();
  private readonly desiredPos = new THREE.Vector3();
  private readonly desiredLook = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(this.fovBase, aspect, 0.1, 700);
    this.camera.position.set(0, 5, -12);
  }

  toggleMode() {
    this.currentMode = this.currentMode === 'chase' ? 'hood' : 'chase';
  }

  get modeName() {
    return this.currentMode;
  }

  snap(phys: VehiclePhysics) {
    this.computeDesired(phys);
    this.pos.copy(this.desiredPos);
    this.look.copy(this.desiredLook);
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
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

  update(dt: number, phys: VehiclePhysics) {
    this.computeDesired(phys);

    const posK = 1 - Math.exp(-9 * dt);
    const lookK = 1 - Math.exp(-13 * dt);
    this.pos.lerp(this.desiredPos, posK);
    this.look.lerp(this.desiredLook, lookK);

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
