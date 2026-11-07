import * as THREE from 'three';
import type { VehiclePhysics } from './VehiclePhysics';

interface WheelVisual {
  pivot: THREE.Group;
  spin: THREE.Group;
}

export class CarVisual {
  readonly root = new THREE.Group();
  private readonly wheels: WheelVisual[] = [];

  constructor(scene: THREE.Scene, phys: VehiclePhysics) {
    const cfg = phys.cfg;

    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0xd8402f,
      roughness: 0.42,
      metalness: 0.25,
    });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x14171b, roughness: 0.85 });
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x1b2633,
      roughness: 0.18,
      metalness: 0.55,
    });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0xf2f4f7, roughness: 0.5 });

    const addBox = (
      w: number,
      h: number,
      d: number,
      x: number,
      y: number,
      z: number,
      mat: THREE.Material,
    ) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.root.add(mesh);
      return mesh;
    };

    const bw = cfg.halfWidth * 2;
    const bh = cfg.halfHeight * 2;
    const bl = cfg.halfLength * 2;

    // main body
    addBox(bw, bh, bl, 0, 0, 0, bodyMat);

    // cabin / greenhouse
    addBox(bw * 0.82, 0.5, bl * 0.44, 0, bh * 0.5 + 0.24, -0.18, bodyMat);
    // windscreen + side glass block (slightly inset)
    addBox(bw * 0.76, 0.34, bl * 0.4, 0, bh * 0.5 + 0.28, -0.18, glassMat);

    // roof strip
    addBox(bw * 0.84, 0.06, bl * 0.45, 0, bh * 0.5 + 0.5, -0.18, trimMat);

    // front splitter + rear diffuser
    addBox(bw * 1.02, 0.09, 0.42, 0, -bh * 0.5 + 0.02, bl * 0.5 - 0.16, darkMat);
    addBox(bw * 1.0, 0.09, 0.4, 0, -bh * 0.5 + 0.02, -bl * 0.5 + 0.16, darkMat);

    // rear wing
    addBox(bw * 0.96, 0.07, 0.34, 0, bh * 0.5 + 0.52, -bl * 0.5 + 0.28, trimMat);
    addBox(0.08, 0.42, 0.08, -cfg.halfWidth * 0.7, bh * 0.5 + 0.32, -bl * 0.5 + 0.28, darkMat);
    addBox(0.08, 0.42, 0.08, cfg.halfWidth * 0.7, bh * 0.5 + 0.32, -bl * 0.5 + 0.28, darkMat);

    // lights
    const lampMat = new THREE.MeshStandardMaterial({
      color: 0xffe9b0,
      emissive: 0xffd270,
      emissiveIntensity: 1.4,
      roughness: 0.3,
    });
    const tailMat = new THREE.MeshStandardMaterial({
      color: 0x8f1410,
      emissive: 0xff2a12,
      emissiveIntensity: 0.9,
      roughness: 0.4,
    });
    addBox(0.34, 0.15, 0.05, -cfg.halfWidth * 0.62, 0.02, bl * 0.5 + 0.01, lampMat);
    addBox(0.34, 0.15, 0.05, cfg.halfWidth * 0.62, 0.02, bl * 0.5 + 0.01, lampMat);
    addBox(0.34, 0.14, 0.05, -cfg.halfWidth * 0.62, 0.05, -bl * 0.5 - 0.01, tailMat);
    addBox(0.34, 0.14, 0.05, cfg.halfWidth * 0.62, 0.05, -bl * 0.5 - 0.01, tailMat);

    // ---- wheels ----
    const tireGeo = new THREE.CylinderGeometry(cfg.wheelRadius, cfg.wheelRadius, cfg.wheelWidth, 20);
    tireGeo.rotateZ(Math.PI / 2);
    const rimGeo = new THREE.CylinderGeometry(cfg.wheelRadius * 0.62, cfg.wheelRadius * 0.62, cfg.wheelWidth + 0.01, 12);
    rimGeo.rotateZ(Math.PI / 2);

    const tireMat = new THREE.MeshStandardMaterial({ color: 0x101215, roughness: 0.95 });
    const rimMat = new THREE.MeshStandardMaterial({ color: 0xb9c0c8, roughness: 0.35, metalness: 0.7 });

    for (let i = 0; i < 4; i++) {
      const pivot = new THREE.Group();
      const spin = new THREE.Group();

      const tire = new THREE.Mesh(tireGeo, tireMat);
      tire.castShadow = true;
      spin.add(tire);

      const rim = new THREE.Mesh(rimGeo, rimMat);
      spin.add(rim);

      // spokes make the spin readable
      for (let s = 0; s < 3; s++) {
        const spoke = new THREE.Mesh(
          new THREE.BoxGeometry(cfg.wheelWidth * 0.9, cfg.wheelRadius * 1.55, 0.05),
          rimMat,
        );
        spoke.rotation.x = (s * Math.PI) / 3;
        spin.add(spoke);
      }

      pivot.add(spin);
      this.root.add(pivot);
      this.wheels.push({ pivot, spin });
    }

    scene.add(this.root);
  }

  update(phys: VehiclePhysics) {
    this.root.position.copy(phys.position);
    this.root.quaternion.copy(phys.quaternion);

    for (let i = 0; i < 4; i++) {
      const w = phys.wheels[i];
      const v = this.wheels[i];
      v.pivot.position.set(
        w.localAnchor.x,
        w.localAnchor.y - w.suspLength,
        w.localAnchor.z,
      );
      v.pivot.rotation.y = w.isFront ? phys.steerAngle : 0;
      v.spin.rotation.x = w.spinAngle;
    }
  }
}
