import * as THREE from 'three';
import type { VehiclePhysics } from './VehiclePhysics';
import { CarLights, type CarLightState } from './CarLights';
import { WheelSuspension, type WheelSpec } from './CarSuspension';
import {
  UNIT_CYLINDER,
  createCarMaterials,
  extrudeProfile,
  roundedBox,
  setLink,
} from './carParts';

export interface CarVisualOptions {
  /** False on `?quality=low`: fewer springs/spokes, no roll cage or spot lights. */
  detail?: boolean;
  /** Warna cat bodi; tiap mobil di grid boleh beda. */
  paint?: number;
}

/**
 * Side profile of the lower body. X is +Z (forward), Y is up. Counter-clockwise,
 * because `extrudeProfile` builds outward-facing caps from a CCW contour.
 */
const LOWER_BODY: ReadonlyArray<readonly [number, number]> = [
  [2.02, -0.3],
  [2.07, -0.08],
  [2.04, 0.06],
  [1.72, 0.17],
  [1.28, 0.23],
  [0.45, 0.26],
  [-0.55, 0.26],
  [-1.3, 0.25],
  [-1.86, 0.16],
  [-2.06, 0.02],
  [-2.06, -0.22],
  [-1.72, -0.34],
  [1.74, -0.34],
];

/** Greenhouse: windshield rake, roof, fastback rear glass. */
const CABIN: ReadonlyArray<readonly [number, number]> = [
  [0.62, 0.24],
  [0.55, 0.3],
  [-0.05, 0.62],
  [-0.8, 0.58],
  [-1.38, 0.24],
];

const CABIN_WIDTH_RATIO = 0.8;
/** Glass sits just outside the bevel of the extruded cabin. */
const GLASS_OFFSET = 0.045;

export class CarVisual {
  readonly root = new THREE.Group();
  readonly lights: CarLights;

  private readonly suspension: WheelSuspension[] = [];
  private readonly steeringWheel = new THREE.Group();

  constructor(scene: THREE.Scene, phys: VehiclePhysics, opts: CarVisualOptions = {}) {
    const cfg = phys.cfg;
    const detail = opts.detail !== false;
    const mats = createCarMaterials(detail, opts.paint);

    const bw = cfg.halfWidth * 2;
    const bl = cfg.halfLength * 2;
    const cabinWidth = bw * CABIN_WIDTH_RATIO;
    const bodyHalf = bw / 2;

    const add = (mesh: THREE.Object3D, cast = true) => {
      mesh.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.castShadow = cast;
          m.receiveShadow = true;
        }
      });
      this.root.add(mesh);
      return mesh;
    };

    /* ---------------- body panels ---------------- */
    add(new THREE.Mesh(extrudeProfile(LOWER_BODY, bw, 0.05), mats.paint));
    add(new THREE.Mesh(extrudeProfile(CABIN, cabinWidth, 0.032), mats.paint));

    // floor pan + rocker panels: visually lowers the car over the wheels
    const floor = roundedBox(1.42, 0.26, bl * 0.86, 0.03, mats.carbon);
    floor.position.set(0, -0.46, 0);
    add(floor);

    for (const side of [-1, 1]) {
      const skirt = roundedBox(0.1, 0.3, cfg.wheelBaseHalf * 1.15, 0.03, mats.paintDark);
      skirt.position.set(side * (bodyHalf - 0.055), -0.4, 0);
      add(skirt);

      const airDam = roundedBox(0.09, 0.24, 0.7, 0.02, mats.carbon);
      airDam.position.set(side * (bodyHalf - 0.06), -0.42, bl / 2 - 0.42);
      add(airDam, false);
    }

    /* ---------------- glass ---------------- */
    const glassAt = (
      height: number,
      width: number,
      y: number,
      z: number,
      tilt: number,
      ny: number,
      nz: number,
    ) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, 0.02), mats.glass);
      mesh.position.set(0, y + ny * GLASS_OFFSET, z + nz * GLASS_OFFSET);
      mesh.rotation.x = tilt;
      return add(mesh, false);
    };
    // windshield: from (0.55, 0.30) to (-0.05, 0.62) in the cabin profile
    glassAt(0.66, cabinWidth * 0.84, 0.46, 0.25, -1.08, 0.47, 0.88);
    // rear glass: from (-0.80, 0.58) to (-1.38, 0.24)
    glassAt(0.64, cabinWidth * 0.84, 0.41, -1.09, -2.1, 0.87, -0.5);

    // side windows (front door + rear quarter) as flat panels on the cabin
    const sideWindow = (points: ReadonlyArray<readonly [number, number]>) => {
      const shape = new THREE.Shape();
      shape.moveTo(points[0][0], points[0][1]);
      for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1]);
      shape.closePath();
      const geo = new THREE.ShapeGeometry(shape);
      geo.rotateY(-Math.PI / 2); // shape X -> world Z
      for (const side of [-1, 1]) {
        const mesh = new THREE.Mesh(geo, mats.glass);
        mesh.position.x = side * (cabinWidth / 2 + GLASS_OFFSET);
        this.root.add(mesh);
      }
    };
    sideWindow([
      [0.44, 0.31],
      [0.15, 0.54],
      [-0.26, 0.54],
      [-0.26, 0.31],
    ]);
    sideWindow([
      [-0.34, 0.31],
      [-0.34, 0.52],
      [-0.72, 0.49],
      [-1.02, 0.31],
    ]);

    /* ---------------- fender flares + aero ---------------- */
    const staticCompression = (cfg.mass * 9.81) / (4 * cfg.springK);
    const archY = cfg.anchorY - (cfg.suspensionRest - staticCompression);
    const archGeo = new THREE.TorusGeometry(cfg.wheelRadius + 0.1, 0.034, 6, detail ? 26 : 16, Math.PI);
    archGeo.rotateY(Math.PI / 2);
    for (const [x, z] of [
      [-1, 1],
      [1, 1],
      [-1, -1],
      [1, -1],
    ]) {
      const arch = new THREE.Mesh(archGeo, mats.paintDark);
      arch.position.set(x * (bodyHalf + 0.005), archY, z * cfg.wheelBaseHalf);
      add(arch);
    }

    const splitter = roundedBox(bw * 1.03, 0.05, 0.44, 0.02, mats.carbon);
    splitter.position.set(0, -0.36, bl / 2 - 0.22);
    add(splitter);

    const diffuser = roundedBox(bw * 0.95, 0.12, 0.42, 0.02, mats.carbon);
    diffuser.position.set(0, -0.32, -bl / 2 + 0.18);
    add(diffuser);

    /* ---------------- rear wing, mounted on the boot ---------------- */
    const wingY = 0.66;
    const wingZ = -bl / 2 + 0.28;
    const wing = roundedBox(bw * 0.94, 0.05, 0.32, 0.02, mats.carbon);
    wing.position.set(0, wingY, wingZ);
    wing.rotation.x = -0.12;
    add(wing);

    for (const side of [-1, 1]) {
      const endplate = roundedBox(0.028, 0.19, 0.34, 0.01, mats.paintDark);
      endplate.position.set(side * bw * 0.47, wingY - 0.01, wingZ);
      add(endplate);

      const stay = roundedBox(0.05, 0.42, 0.07, 0.015, mats.paintDark);
      stay.position.set(side * bw * 0.3, wingY - 0.24, wingZ + 0.02);
      stay.rotation.x = 0.16;
      add(stay);
    }

    /* ---------------- details ---------------- */
    const scoop = roundedBox(0.46, 0.09, 0.28, 0.03, mats.paintDark);
    scoop.position.set(0, 0.645, -0.2);
    add(scoop);

    for (const side of [-1, 1]) {
      const vent = roundedBox(0.3, 0.025, 0.16, 0.01, mats.carbon);
      vent.position.set(side * 0.38, 0.245, 1.2);
      vent.rotation.x = -0.08;
      add(vent, false);

      const handle = roundedBox(0.02, 0.035, 0.16, 0.01, mats.trim);
      handle.position.set(side * (bodyHalf + 0.045), 0.15, -0.1);
      add(handle, false);

      // head lamp housing behind the lens
      const housing = roundedBox(0.48, 0.19, 0.08, 0.02, mats.paintDark);
      housing.position.set(side * 0.52, 0.1, bl / 2 + 0.02);
      add(housing, false);
    }

    const grille = roundedBox(1.0, 0.16, 0.06, 0.02, mats.carbon);
    grille.position.set(0, -0.12, bl / 2 + 0.055);
    add(grille, false);

    const plateRear = roundedBox(0.42, 0.13, 0.03, 0.01, mats.plate);
    plateRear.position.set(0, -0.04, -bl / 2 - 0.085);
    add(plateRear, false);

    const exhaustGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.2, detail ? 12 : 8, 1, true);
    exhaustGeo.rotateX(Math.PI / 2);
    const exhaust = new THREE.Mesh(exhaustGeo, mats.trim);
    exhaust.position.set(-0.52, -0.3, -bl / 2 - 0.06);
    add(exhaust, false);

    const towHook = roundedBox(0.12, 0.05, 0.16, 0.02, mats.caliper);
    towHook.position.set(-0.42, -0.29, bl / 2 + 0.08);
    add(towHook, false);

    // mud flaps behind each wheel (rally spec)
    for (const side of [-1, 1]) {
      for (const zSign of [-1, 1]) {
        const flap = roundedBox(0.34, 0.26, 0.02, 0.01, mats.rubber);
        flap.position.set(side * 0.72, -0.44, zSign * cfg.wheelBaseHalf - zSign * 0.44);
        add(flap, false);
      }
    }

    /* ---------------- mirrors ---------------- */
    const mirrorMat = new THREE.MeshPhysicalMaterial({
      color: 0xa8bccd,
      metalness: 1,
      roughness: 0.05,
      envMapIntensity: 2,
    });
    for (const side of [-1, 1]) {
      const housing = roundedBox(0.19, 0.11, 0.22, 0.035, mats.paint);
      housing.position.set(side * (bodyHalf + 0.13), 0.34, 0.48);
      add(housing);

      const glass = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.095, 0.19), mirrorMat);
      glass.position.set(side * (bodyHalf + 0.13), 0.34, 0.37);
      add(glass, false);

      const stalk = roundedBox(0.14, 0.028, 0.05, 0.01, mats.paintDark);
      stalk.position.set(side * (bodyHalf + 0.02), 0.32, 0.5);
      add(stalk, false);
    }

    /* ---------------- interior ---------------- */
    const dash = roundedBox(cabinWidth * 0.9, 0.17, 0.34, 0.03, mats.interior);
    dash.position.set(0, 0.27, 0.5);
    add(dash, false);

    for (const side of [-1, 1]) {
      const back = roundedBox(0.4, 0.5, 0.15, 0.05, mats.interior);
      back.position.set(side * 0.31, 0.4, -0.36);
      back.rotation.x = -0.16;
      add(back, false);

      const cushion = roundedBox(0.4, 0.1, 0.4, 0.04, mats.interior);
      cushion.position.set(side * 0.31, 0.2, -0.24);
      add(cushion, false);
    }

    const rimGeo = new THREE.TorusGeometry(0.13, 0.021, detail ? 10 : 6, detail ? 24 : 16);
    const rimMesh = new THREE.Mesh(rimGeo, mats.interior);
    this.steeringWheel.add(rimMesh);
    for (const angle of [0, Math.PI * 0.5, Math.PI]) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.02, 0.02), mats.trim);
      spoke.rotation.z = angle;
      this.steeringWheel.add(spoke);
    }
    this.steeringWheel.position.set(0.31, 0.36, 0.38);
    this.steeringWheel.rotation.x = -0.35;
    add(this.steeringWheel, false);

    if (detail) {
      // roll cage: bolted inside the greenhouse, never through the roof
      const cagePoints: Array<[THREE.Vector3, THREE.Vector3]> = [];
      const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
      for (const side of [-1, 1]) {
        cagePoints.push([v(side * 0.55, 0.16, -0.72), v(side * 0.55, 0.5, -0.72)]);
        cagePoints.push([v(side * 0.55, 0.5, -0.72), v(side * 0.46, 0.28, -1.14)]);
        cagePoints.push([v(side * 0.55, 0.46, -0.7), v(side * 0.48, 0.29, 0.34)]);
      }
      cagePoints.push([v(0.55, 0.5, -0.72), v(-0.55, 0.5, -0.72)]);
      cagePoints.push([v(0.48, 0.29, 0.34), v(-0.48, 0.29, 0.34)]);

      for (const [a, b] of cagePoints) {
        const tube = new THREE.Mesh(UNIT_CYLINDER, mats.cage);
        setLink(tube, 0.021, a, b);
        this.root.add(tube);
      }
    }

    /* ---------------- lights ---------------- */
    this.lights = new CarLights(this.root, cfg, detail);

    /* ---------------- wheels + suspension ---------------- */
    const wheelSpecs: WheelSpec[] = [
      { isFront: true, left: true, x: -cfg.trackHalf, z: cfg.wheelBaseHalf },
      { isFront: true, left: false, x: cfg.trackHalf, z: cfg.wheelBaseHalf },
      { isFront: false, left: true, x: -cfg.trackHalf, z: -cfg.wheelBaseHalf },
      { isFront: false, left: false, x: cfg.trackHalf, z: -cfg.wheelBaseHalf },
    ];
    for (const spec of wheelSpecs) {
      this.suspension.push(new WheelSuspension(this.root, cfg, spec, mats, detail));
    }

    scene.add(this.root);
  }

  update(phys: VehiclePhysics, dt: number, lights: CarLightState) {
    this.root.position.copy(phys.position);
    this.root.quaternion.copy(phys.quaternion);

    for (let i = 0; i < this.suspension.length; i++) {
      const w = phys.wheels[i];
      this.suspension[i].update(
        w.isFront ? phys.steerAngle : 0,
        w.suspLength,
        w.spinAngle,
        lights.brake,
      );
    }

    // steering wheel turns with the rack, about its own (tilted) axis
    this.steeringWheel.rotation.z = -phys.steerAngle * 5;

    this.lights.update(dt, lights);
  }

  /** Exposed for the browser regression check. */
  get steeringWheelAngle() {
    return this.steeringWheel.rotation.z;
  }

  /** Vertical position of each wheel hub in car space (suspension travel). */
  get hubHeights() {
    return this.suspension.map((s) => s.hub.position.y);
  }

  /** Drops the procedural body once the imported model has taken over. */
  dispose() {
    this.root.removeFromParent();
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.geometry?.dispose();
    });
  }
}
