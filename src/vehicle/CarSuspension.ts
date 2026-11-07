import * as THREE from 'three';
import type { VehicleConfig } from './VehiclePhysics';
import {
  UNIT_CYLINDER,
  helixGeometry,
  setLink,
  setSpring,
  type CarMaterials,
} from './carParts';

export interface WheelSpec {
  isFront: boolean;
  left: boolean;
  x: number;
  z: number;
}

/** Length the coilover is modelled at; the mesh is scaled from this. */
const SPRING_REST = 0.42;
let springGeometry: THREE.TubeGeometry | null = null;
function sharedSpringGeometry(detail: boolean) {
  springGeometry ??= helixGeometry(SPRING_REST, 0.077, 0.014, 7, detail);
  return springGeometry;
}

/**
 * Everything that hangs off one corner: double wishbone, tie rod, coilover,
 * upright, brake disc/caliper and the wheel itself. All positions are computed
 * in car space every frame from the wheel's raycast `suspLength`, so the
 * suspension visibly works over ramps / the washboard.
 */
export class WheelSuspension {
  readonly group = new THREE.Group();
  readonly hub = new THREE.Group();

  private readonly spin = new THREE.Group();
  private readonly lowerArm: THREE.Mesh;
  private readonly upperArm: THREE.Mesh;
  private readonly tieRod: THREE.Mesh;
  private readonly spring: THREE.Mesh;
  private readonly damperBody: THREE.Mesh;
  private readonly damperShaft: THREE.Mesh;
  private readonly discMat: THREE.MeshToonMaterial;

  private readonly lowerIn = new THREE.Vector3();
  private readonly lowerOut = new THREE.Vector3();
  private readonly upperIn = new THREE.Vector3();
  private readonly upperOut = new THREE.Vector3();
  private readonly tieIn = new THREE.Vector3();
  private readonly tieOut = new THREE.Vector3();
  private readonly coilTop = new THREE.Vector3();
  private readonly coilBottom = new THREE.Vector3();
  private readonly coilMid = new THREE.Vector3();

  constructor(
    parent: THREE.Object3D,
    private readonly cfg: VehicleConfig,
    private readonly spec: WheelSpec,
    mats: CarMaterials,
    detail: boolean,
  ) {
    const r = cfg.wheelRadius;
    const w = cfg.wheelWidth;
    const outer = Math.sign(spec.x) || 1;

    /* ---------------- wheel ---------------- */
    const tireGeo = new THREE.CylinderGeometry(r, r, w, detail ? 26 : 16, 1, false);
    tireGeo.rotateZ(Math.PI / 2);
    const tire = new THREE.Mesh(tireGeo, mats.rubber);
    tire.castShadow = true;
    tire.receiveShadow = true;
    this.spin.add(tire);

    const barrelGeo = new THREE.CylinderGeometry(r * 0.66, r * 0.66, w * 0.95, detail ? 18 : 12, 1, true);
    barrelGeo.rotateZ(Math.PI / 2);
    const barrel = new THREE.Mesh(barrelGeo, mats.rim);
    this.spin.add(barrel);

    const lipGeo = new THREE.TorusGeometry(r * 0.63, 0.019, 6, detail ? 20 : 14);
    lipGeo.rotateY(Math.PI / 2);
    const lip = new THREE.Mesh(lipGeo, mats.rim);
    lip.position.x = outer * w * 0.48;
    this.spin.add(lip);

    const spokeCount = detail ? 3 : 2;
    const spokeGeo = new THREE.BoxGeometry(0.05, r * 1.42, 0.06);
    for (let i = 0; i < spokeCount; i++) {
      const spoke = new THREE.Mesh(spokeGeo, mats.rim);
      spoke.position.x = outer * w * 0.42;
      spoke.rotation.x = (i * Math.PI) / spokeCount;
      spoke.castShadow = true;
      this.spin.add(spoke);
    }

    const capGeo = new THREE.CylinderGeometry(r * 0.17, r * 0.17, w * 1.02, detail ? 14 : 10);
    capGeo.rotateZ(Math.PI / 2);
    const cap = new THREE.Mesh(capGeo, mats.rim);
    cap.position.x = outer * w * 0.44;
    this.spin.add(cap);

    // brake disc spins with the wheel, the caliper stays on the upright
    const discGeo = new THREE.CylinderGeometry(r * 0.6, r * 0.6, 0.03, detail ? 22 : 14);
    discGeo.rotateZ(Math.PI / 2);
    const disc = new THREE.Mesh(discGeo, mats.disc);
    disc.position.x = -outer * w * 0.06;
    this.discMat = mats.disc;
    this.spin.add(disc);

    if (detail) {
      const caliper = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.1, 0.16), mats.caliper);
      caliper.position.set(-outer * w * 0.06, r * 0.36, 0);
      this.hub.add(caliper);
    }

    this.hub.add(this.spin);

    /* ---------------- suspension links ---------------- */
    this.lowerArm = new THREE.Mesh(UNIT_CYLINDER, mats.cage);
    this.upperArm = new THREE.Mesh(UNIT_CYLINDER, mats.cage);
    this.tieRod = new THREE.Mesh(UNIT_CYLINDER, mats.cage);
    this.damperBody = new THREE.Mesh(UNIT_CYLINDER, mats.paintDark);
    this.damperShaft = new THREE.Mesh(UNIT_CYLINDER, mats.trim);
    this.spring = new THREE.Mesh(sharedSpringGeometry(detail), mats.spring);

    for (const arm of [this.lowerArm, this.upperArm, this.tieRod]) {
      arm.castShadow = true;
    }
    this.damperBody.castShadow = true;

    this.group.add(
      this.lowerArm,
      this.upperArm,
      this.tieRod,
      this.spring,
      this.damperBody,
      this.damperShaft,
      this.hub,
    );
    parent.add(this.group);
  }

  /**
   * BAN COPOT: roda (tapak + velg) hilang, tapi kaliper, cakram dan lengan
   * suspensi tetap ada — persis seperti mobil nyata yang kehilangan roda.
   */
  setWheelLost(lost: boolean) {
    this.spin.visible = !lost;
  }

  update(steerAngle: number, suspLength: number, spinAngle: number, brake: number) {
    const cfg = this.cfg;
    const { x, z } = this.spec;
    const wheelY = cfg.anchorY - suspLength;
    const compression = THREE.MathUtils.clamp(
      1 - suspLength / Math.max(cfg.suspensionRest, 1e-3),
      0,
      1,
    );

    this.hub.position.set(x, wheelY, z);
    this.hub.rotation.y = this.spec.isFront ? steerAngle : 0;
    this.hub.rotation.z = Math.sign(x) * (0.012 + 0.055 * compression);
    this.spin.rotation.x = spinAngle;

    // lower / upper wishbone
    this.lowerIn.set(x * 0.45, cfg.anchorY - 0.1, z * 0.92);
    this.lowerOut.set(x * 0.93, wheelY - 0.03, z);
    this.upperIn.set(x * 0.42, cfg.anchorY + 0.17, z * 0.92);
    this.upperOut.set(x * 0.9, wheelY + 0.16, z);
    setLink(this.lowerArm, 0.035, this.lowerIn, this.lowerOut);
    setLink(this.upperArm, 0.027, this.upperIn, this.upperOut);

    // steering tie rod
    this.tieIn.set(x * 0.55, cfg.anchorY - 0.02, z - Math.sign(z) * 0.34);
    this.tieOut.set(x * 0.9, wheelY + 0.02, z - Math.sign(z) * 0.14);
    setLink(this.tieRod, 0.019, this.tieIn, this.tieOut);

    // coilover: spring coil + damper body + shaft
    this.coilTop.set(x * 0.62, cfg.anchorY + 0.26, z);
    this.coilBottom.set(x * 0.86, wheelY + 0.04, z);
    setSpring(this.spring, this.coilTop, this.coilBottom, SPRING_REST);
    this.coilMid.copy(this.coilTop).lerp(this.coilBottom, 0.45);
    setLink(this.damperBody, 0.042, this.coilTop, this.coilMid);
    setLink(this.damperShaft, 0.017, this.coilMid, this.coilBottom);

    // brake discs glow a little when the brakes are hot
    const glow = 0.05 + THREE.MathUtils.clamp(brake, 0, 1) * 0.85;
    this.discMat.emissiveIntensity = glow;
  }
}
