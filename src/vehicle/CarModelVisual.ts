import * as THREE from 'three';
import { toonFrom } from '../world/style';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { VehicleConfig, VehiclePhysics } from './VehiclePhysics';
import {
  CarLights,
  LampController,
  type CarLightReadings,
  type CarLightState,
} from './CarLights';

/**
 * Turns an imported glTF car into the game's car:
 *
 *  - every mesh keeps its authored materials (paint, glass, trim, textures),
 *  - the four wheel nodes are re-parented into steering/spin pivots so they
 *    still follow `steerAngle`, `spinAngle` and the per-wheel `suspLength`
 *    that the raycast suspension produces,
 *  - the lamp meshes in the model are split left/right and driven by the same
 *    `LampController` as the procedural car (brake, reverse, indicators,
 *    head lights).
 *
 * Nothing here feeds back into the physics: the model is a read-only
 * consumer of `VehiclePhysics`, exactly like `CarVisual`.
 */

export interface CarLampRig {
  update(dt: number, state: CarLightState): void;
  readonly readings: CarLightReadings;
}

export interface ModelWheel {
  /** Yaw pivot: sits at the tyre centre, turns with the steering rack. */
  steer: THREE.Group;
  /** Axle pivot: spins with the rolling wheel. */
  spin: THREE.Group;
  isFront: boolean;
  left: boolean;
  /** Wheel centre height in model units, at rest. */
  centerY: number;
  /** Tyre radius in model units. */
  radius: number;
  /** +1 when the model already faces +Z, -1 when it had to be turned around. */
  spinSign: number;
}

export interface AssembledCarModel {
  root: THREE.Group;
  /** Indexed like `VehiclePhysics.wheels`: front left, front right, rear left, rear right. */
  wheels: Array<ModelWheel | null>;
  lights: CarLampRig;
  /** Model units -> metres. */
  scale: number;
  /** Vertical offset of the model group in car space (metres). */
  yOffset: number;
  /** Tyre radius of the imported wheels (metres). */
  radius: number;
  /** Visual bounding box in car space (metres). */
  size: THREE.Vector3;
  /** Height of a hub in car space at rest (metres). */
  restHubY: number;
}

const WHEEL_NODE = /^(circle|wheel|wheel_|tyre|tire)[\s._-]*\d*$/i;

/**
 * Suspension length a parked car settles at: the free length minus the static
 * sag of one corner (`m*g/4` over `springK`). The model must be placed for
 * THIS pose, not for the uncompressed one, otherwise the body sits a full sag
 * too low on its wheels and every bump pushes the tyres into the arches.
 */
export function suspEquilibrium(cfg: VehicleConfig): number {
  const sag = (cfg.mass * 9.81) / (4 * Math.max(cfg.springK, 1));
  return Math.max(cfg.suspensionRest - sag, 0);
}

/** Championship white; override with `?paint=rrggbb`. */
const DEFAULT_PAINT = 0xdfe4e8;

/**
 * The imported arches are cut for a 30 cm tyre, so the visual steering is
 * capped a little below the physics lock (34 deg): at full lock the tyre
 * shoulder would otherwise cut through the front fender.
 */
const MAX_VISUAL_STEER = 0.5;

const isMeshLike = (o: THREE.Object3D) => (o as THREE.Mesh).isMesh === true;

function collectWheelNodes(source: THREE.Object3D): THREE.Object3D[] {
  const found: THREE.Object3D[] = [];
  source.traverse((o) => {
    if (isMeshLike(o) || !o.name || !WHEEL_NODE.test(o.name.trim())) return;
    let hasMesh = false;
    o.traverse((c) => {
      if (isMeshLike(c)) hasMesh = true;
    });
    if (hasMesh) found.push(o);
  });
  return found;
}

/** First object whose name matches, preferring nodes that carry geometry. */
function findByPattern(source: THREE.Object3D, pattern: RegExp): THREE.Object3D | null {
  let hit: THREE.Object3D | null = null;
  source.traverse((o) => {
    if (hit || !o.name || !pattern.test(o.name)) return;
    hit = o;
  });
  return hit;
}

/**
 * The model space of the shipped car (Honda Civic EG6) has +Z at the nose and
 * +Y up. A model authored the other way round is detected from its "front…"
 * nodes and turned 180 degrees, so the physics can stay untouched.
 */
function detectYaw(source: THREE.Object3D, center: THREE.Vector3): number {
  const front = findByPattern(source, /front|depan|head ?lamp|head ?light/i);
  if (!front) return 0;
  const frontCenter = new THREE.Box3().setFromObject(front).getCenter(new THREE.Vector3());
  const spread = Math.abs(frontCenter.z - center.z);
  if (spread < 1e-3) return 0;
  return frontCenter.z < center.z ? Math.PI : 0;
}

interface RawWheel {
  node: THREE.Object3D;
  center: THREE.Vector3;
  radius: number;
}

function measureWheel(node: THREE.Object3D, yaw: number): RawWheel {
  const box = new THREE.Box3().setFromObject(node);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.y, size.z) / 2;
  if (yaw === Math.PI) {
    center.x = -center.x;
    center.z = -center.z;
  }
  return { node, center, radius };
}

/* ------------------------------------------------------------------ */
/* lamps                                                              */
/* ------------------------------------------------------------------ */

interface LampSlot {
  mat: THREE.MeshToonMaterial;
  /** Colour the lamp takes while it is lit. */
  lit: THREE.Color;
}

function lampMaterial(source: THREE.Mesh): THREE.MeshToonMaterial {
  const src = source.material as THREE.MeshToonMaterial;
  const mat = src.clone();
  // emissive straight from the material colour reads better than an emissive
  // map here: the lamp silhouettes come from the model, the glow from us.
  mat.emissiveMap = null;
  mat.emissive = new THREE.Color(0x000000);
  mat.emissiveIntensity = 0;
  return mat;
}

interface SplitLamp {
  left: THREE.Mesh | null;
  right: THREE.Mesh | null;
}

/**
 * Splits a lamp mesh into its left and right halves so they can blink apart.
 * The split is done on the index buffer, so both halves share the vertex data
 * and keep their authored shape exactly.
 */
function splitBySide(mesh: THREE.Mesh): SplitLamp {
  const geo = mesh.geometry as THREE.BufferGeometry;
  const pos = geo.getAttribute('position');
  if (!pos) return { left: null, right: null };

  const index = geo.getIndex();
  const triangleCount = (index ? index.count : pos.count) / 3;
  const left: number[] = [];
  const right: number[] = [];
  const v = new THREE.Vector3();

  for (let t = 0; t < triangleCount; t++) {
    let cx = 0;
    for (let k = 0; k < 3; k++) {
      const i = index ? index.getX(t * 3 + k) : t * 3 + k;
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      cx += v.x;
    }
    const bucket = cx >= 0 ? right : left;
    for (let k = 0; k < 3; k++) {
      bucket.push(index ? index.getX(t * 3 + k) : t * 3 + k);
    }
  }

  const make = (idx: number[]): THREE.Mesh | null => {
    if (idx.length === 0) return null;
    const g = new THREE.BufferGeometry();
    for (const name of Object.keys(geo.attributes)) {
      g.setAttribute(name, geo.getAttribute(name));
    }
    g.setIndex(idx);
    const part = new THREE.Mesh(g, lampMaterial(mesh));
    part.position.copy(mesh.position);
    part.quaternion.copy(mesh.quaternion);
    part.scale.copy(mesh.scale);
    part.castShadow = false;
    part.receiveShadow = false;
    return part;
  };

  const leftPart = make(left);
  const rightPart = make(right);
  if (!leftPart || !rightPart) return { left: null, right: null };

  mesh.parent?.add(leftPart, rightPart);
  mesh.visible = false;
  return { left: leftPart, right: rightPart };
}

/** Material a split lamp part is drawn with (already an emissive clone). */
const lampMaterialOf = (part: THREE.Mesh) => part.material as THREE.MeshToonMaterial;

const slot = (mat: THREE.MeshToonMaterial, lit: number): LampSlot => ({
  mat,
  lit: new THREE.Color(lit),
});

/**
 * Drives the model's own lamp meshes: tail/brake, reverse, indicators and head
 * lights. Falls back to extra geometry via `CarLights` when a model has no
 * recognisable lamp meshes at all.
 */
class ModelLampRig implements CarLampRig {
  private readonly lamp = new LampController();
  private frame: CarLightReadings = {
    tail: 0.6,
    reverse: 0,
    head: 0.2,
    amberLeft: 0,
    amberRight: 0,
    blinkOn: true,
  };

  private readonly tailLeft: LampSlot[] = [];
  private readonly tailRight: LampSlot[] = [];
  private readonly frontAmberLeft: LampSlot[] = [];
  private readonly frontAmberRight: LampSlot[] = [];
  private readonly head: LampSlot[] = [];

  private constructor() {}

  static build(source: THREE.Object3D): CarLampRig | null {
    const rig = new ModelLampRig();
    const headMeshes: THREE.Mesh[] = [];
    const amberMeshes: THREE.Mesh[] = [];
    const tailMeshes: THREE.Mesh[] = [];

    source.updateMatrixWorld(true);
    source.traverse((o) => {
      if (!isMeshLike(o)) return;
      const mesh = o as THREE.Mesh;
      const name = mesh.name.toLowerCase();
      if (!name.includes('lampu') && !name.includes('lamp')) return;
      if (name.includes('lampuseindepan') || name.includes('indicator')) amberMeshes.push(mesh);
      else if (name.includes('depan') || name.includes('head')) headMeshes.push(mesh);
      else tailMeshes.push(mesh);
    });

    if (headMeshes.length + amberMeshes.length + tailMeshes.length === 0) return null;

    for (const mesh of headMeshes) {
      const mat = lampMaterial(mesh);
      mesh.material = mat;
      rig.head.push(slot(mat, 0xfff4d6));
    }

    for (const mesh of amberMeshes) {
      const halves = splitBySide(mesh);
      for (const part of [halves.left, halves.right]) {
        if (!part) continue;
        const amber = slot(lampMaterialOf(part), 0xff7a0a);
        if (part === halves.left) rig.frontAmberLeft.push(amber);
        else rig.frontAmberRight.push(amber);
      }
    }

    for (const mesh of tailMeshes) {
      const halves = splitBySide(mesh);
      for (const part of [halves.left, halves.right]) {
        if (!part) continue;
        const tail = slot(lampMaterialOf(part), 0xff1508);
        if (part === halves.left) rig.tailLeft.push(tail);
        else rig.tailRight.push(tail);
      }
    }

    // Lampu sorot 3D sengaja tidak dipakai: dua SpotLight per mobil berarti
    // 12 lampu di grid, dan setiap material harus menghitung semuanya tiap
    // fragment. Untuk gaya kartun, lampu yang menyala (emissive) sudah cukup.

    return rig;
  }

  update(dt: number, state: CarLightState) {
    this.frame = this.lamp.update(dt, state);

    /* head lamps */
    for (const s of this.head) {
      s.mat.emissive.copy(s.lit);
      s.mat.emissiveIntensity = this.frame.head > 1 ? 3.2 : 0.25;
    }

    /* front indicators, one side at a time */
    for (const s of this.frontAmberLeft) {
      s.mat.emissive.copy(s.lit);
      s.mat.emissiveIntensity = this.frame.amberLeft;
    }
    for (const s of this.frontAmberRight) {
      s.mat.emissive.copy(s.lit);
      s.mat.emissiveIntensity = this.frame.amberRight;
    }

    /* rear clusters: tail -> brake -> indicator -> reverse, brightest wins */
    const rear = (slots: LampSlot[], amber: number) => {
      for (const s of slots) {
        if (amber > 0) {
          s.mat.emissive.copy(s.lit);
          s.mat.emissiveIntensity = amber;
        } else if (this.frame.reverse > 0) {
          s.mat.emissive.setHex(0xeef4ff);
          s.mat.emissiveIntensity = this.frame.reverse;
        } else {
          s.mat.emissive.setHex(0xff1508);
          s.mat.emissiveIntensity = this.frame.tail;
        }
      }
    };
    rear(this.tailLeft, this.frame.amberLeft);
    rear(this.tailRight, this.frame.amberRight);

  }

  get readings() {
    return this.frame;
  }
}

/* ------------------------------------------------------------------ */
/* assembly                                                           */
/* ------------------------------------------------------------------ */

export function assembleCarModel(
  source: THREE.Object3D,
  cfg: VehicleConfig,
  opts: { detail?: boolean; paint?: number } = {},
): AssembledCarModel {
  const detail = opts.detail !== false;
  source.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(source);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  const yaw = detectYaw(source, center);

  const rawWheels = collectWheelNodes(source).map((n) => measureWheel(n, yaw));
  if (rawWheels.length !== 4) {
    console.warn(
      `[CarModelVisual] expected 4 wheel nodes, found ${rawWheels.length}; wheels will not animate`,
    );
  }

  /* wheelbase of the model decides the scale: the visual wheels must sit on
     the physics axes, so the car is neither stretched nor squashed. */
  const zs = rawWheels.map((w) => w.center.z);
  const modelWheelbase = zs.length >= 2 ? Math.max(...zs) - Math.min(...zs) : size.z * 0.62;
  const scale = (cfg.wheelBaseHalf * 2) / Math.max(modelWheelbase, 1e-6);

  const midZ = zs.length ? (Math.max(...zs) + Math.min(...zs)) / 2 : center.z;
  const xs = rawWheels.map((w) => w.center.x);
  const midX = xs.length ? (Math.max(...xs) + Math.min(...xs)) / 2 : center.x;

  const tyreRadius = rawWheels.length
    ? rawWheels.reduce((sum, w) => sum + w.radius, 0) / rawWheels.length
    : cfg.wheelRadius / scale;
  const radiusM = tyreRadius * scale;
  const centerYModel = rawWheels.length
    ? rawWheels.reduce((sum, w) => sum + w.center.y, 0) / rawWheels.length
    : box.min.y;

  /* Height of the body origin above the ground once the car has settled on
     its springs, so the imported tyres touch the same plane the raycast
     suspension rests on instead of hovering or sinking into it. */
  const groundY = cfg.anchorY - suspEquilibrium(cfg) - cfg.wheelRadius;
  const restHubY = groundY + radiusM;
  const yOffset = restHubY - centerYModel * scale;

  const root = new THREE.Group();
  const container = new THREE.Group();
  container.scale.setScalar(scale);
  const turn = yaw === Math.PI ? -1 : 1;
  container.position.set(-midX * scale * turn, yOffset, -midZ * scale * turn);
  if (yaw !== 0) container.rotation.y = yaw;
  container.add(source);
  root.add(container);

  root.updateMatrixWorld(true);

  const wheels: Array<ModelWheel | null> = [null, null, null, null];
  for (const raw of rawWheels) {
    const steer = new THREE.Group();
    steer.position.copy(raw.center);
    container.add(steer);
    const spin = new THREE.Group();
    steer.add(spin);
    root.updateMatrixWorld(true);
    spin.attach(raw.node);

    const isFront = raw.center.z > midZ;
    const left = raw.center.x < midX;
    const slotIndex = (isFront ? 0 : 2) + (left ? 0 : 1);
    wheels[slotIndex] = {
      steer,
      spin,
      isFront,
      left,
      centerY: raw.center.y,
      radius: raw.radius,
      spinSign: turn,
    };
  }

  root.updateMatrixWorld(true);

  // Seluruh material model (yang aslinya PBR/MeshStandardMaterial) diganti
  // versi toon: warna & peta dipertahankan, tapi warnanya jadi rata dan
  // shadernya jauh lebih murah. Bodinya tetap di-respray ke warna livery.
  const paint = new THREE.Color(opts.paint ?? DEFAULT_PAINT);
  const convert = (m: THREE.Material): THREE.Material => {
    if ((m as THREE.MeshToonMaterial).isMeshToonMaterial) return m;
    const isPaint = /paint/i.test(m.name);
    const out = toonFrom(m, isPaint ? paint : undefined);
    if (isPaint) {
      out.side = THREE.FrontSide;
      out.name = m.name;
    }
    m.dispose();
    return out;
  };
  source.traverse((o) => {
    if (!isMeshLike(o)) return;
    const mesh = o as THREE.Mesh;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map(convert)
      : convert(mesh.material);
  });

  const lights = ModelLampRig.build(source) ?? new CarLights(root, cfg, detail);

  root.updateMatrixWorld(true);
  const visualBox = new THREE.Box3().setFromObject(root);

  return {
    root,
    wheels,
    lights,
    scale,
    yOffset,
    radius: radiusM,
    size: visualBox.getSize(new THREE.Vector3()),
    restHubY: restHubY,
  };
}

/* ------------------------------------------------------------------ */
/* runtime wrapper                                                    */
/* ------------------------------------------------------------------ */

export class CarModelVisual {
  readonly root: THREE.Group;
  readonly lights: CarLampRig;

  private readonly wheels: Array<ModelWheel | null>;
  private readonly scale: number;
  private readonly yOffset: number;
  private readonly radius: number;
  private readonly restHubY: number;
  private readonly cfg: VehicleConfig;
  private readonly hubY: number[];
  private steerWheel: THREE.Object3D | null = null;
  private steerValue = 0;

  constructor(scene: THREE.Scene, phys: VehiclePhysics, assembled: AssembledCarModel) {
    this.root = assembled.root;
    this.wheels = assembled.wheels;
    this.scale = assembled.scale;
    this.yOffset = assembled.yOffset;
    this.radius = assembled.radius;
    this.cfg = phys.cfg;
    this.restHubY = assembled.restHubY;
    this.hubY = [-0.72, -0.72, -0.72, -0.72].map(() => this.restHubY);
    this.lights = assembled.lights;
    this.steerWheel = findByPattern(this.root, /steer(ing)?[ _-]?wheel/i);

    scene.add(this.root);
  }

  /** Loads and assembles a model; `null` means "keep the procedural car". */
  static async load(
    scene: THREE.Scene,
    phys: VehiclePhysics,
    url: string,
    opts: { detail?: boolean; paint?: number } = {},
  ): Promise<CarModelVisual | null> {
    try {
      const gltf = await new GLTFLoader().loadAsync(url);
      const assembled = assembleCarModel(gltf.scene, phys.cfg, opts);
      return new CarModelVisual(scene, phys, assembled);
    } catch (err) {
      console.warn('[CarModelVisual] could not load the car model:', err);
      return null;
    }
  }

  update(phys: VehiclePhysics, dt: number, lights: CarLightState) {
    this.root.position.copy(phys.position);
    this.root.quaternion.copy(phys.quaternion);

    // The tyre is placed from the raycast suspension itself: its centre sits
    // `suspLength` under the anchor, so the contact patch stays exactly on the
    // ground plane for any ride height / spring rate the GUI is tuned to, and
    // the shock can never pull the tyre up into the arch on its own.
    const cfg = this.cfg;
    for (let i = 0; i < phys.wheels.length; i++) {
      const state = phys.wheels[i];
      const centreY = cfg.anchorY - state.suspLength - cfg.wheelRadius + this.radius;
      this.hubY[i] = centreY;

      const wheel = this.wheels[i];
      if (!wheel) continue;
      wheel.steer.position.y = (centreY - this.yOffset) / this.scale;
      wheel.steer.rotation.y = state.isFront
        ? THREE.MathUtils.clamp(phys.steerAngle, -MAX_VISUAL_STEER, MAX_VISUAL_STEER)
        : 0;
      wheel.spin.rotation.x = state.spinAngle * wheel.spinSign;
    }

    this.steerValue = -phys.steerAngle * 5;
    if (this.steerWheel) this.steerWheel.rotation.z = this.steerValue;

    this.lights.update(dt, lights);
  }

  /** Sembunyikan roda yang copot (velg + ban ikut hilang). */
  setWheelLost(index: number, lost: boolean) {
    const wheel = this.wheels[index];
    if (wheel) wheel.steer.visible = !lost;
  }

  get steeringWheelAngle() {
    return this.steerValue;
  }

  get hubHeights() {
    return this.hubY;
  }

  dispose() {
    this.root.removeFromParent();
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.geometry?.dispose();
    });
  }
}
