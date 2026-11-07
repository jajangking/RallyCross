import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { VehicleDamage, type DamageOptions } from './Damage';

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const moveTowards = (current: number, target: number, maxDelta: number) =>
  current + clamp(target - current, -maxDelta, maxDelta);

/** 1 = gigi maju (D), -1 = gigi mundur (R). */
export type GearDirection = 1 | -1;

export interface VehicleConfig {
  /* chassis */
  mass: number;
  halfWidth: number;
  halfHeight: number;
  halfLength: number;
  comY: number; // center of mass, local Y (below origin = lower COM)
  /* wheels */
  wheelRadius: number;
  wheelWidth: number;
  wheelBaseHalf: number; // +-Z
  trackHalf: number; // +-X
  anchorY: number;
  /* suspension */
  suspensionRest: number;
  springK: number;
  damperC: number;
  /** Kecepatan piston (m/s) tempat damper mulai "blow-off" (digressive). */
  damperBlowoff: number;
  /** Sisa kekuatan damper di atas blow-off, 0..1. 1 = damper linear. */
  damperHighScale: number;
  /** Batas gaya per roda (N), supaya pendaratan tidak memantulkan mobil. */
  springForceMax: number;
  antiRollFront: number;
  antiRollRear: number;
  /* steering */
  maxSteerDeg: number;
  steerFalloff: number;
  steerRate: number;
  /* drivetrain */
  engineForce: number;
  brakeForce: number;
  handbrakeForce: number;
  frontSplit: number;
  maxSpeed: number;
  reverseMaxSpeed: number;
  /** Kecepatan maksimum (m/s) saat gigi D/R boleh ditukar. */
  shiftSpeedLimit: number;
  rollingResistance: number;
  /* tires */
  muFront: number;
  muRear: number;
  peakSlipDeg: number;
  driftFalloff: number;
  handbrakeRearGrip: number;
  /* aero */
  drag: number;
  downforce: number;
  /* misc */
  angularDamping: number;
  inertiaScaleYaw: number;
}

export const defaultConfig: VehicleConfig = {
  mass: 1250,
  halfWidth: 0.92,
  halfHeight: 0.34,
  halfLength: 2.05,
  comY: -0.3,

  wheelRadius: 0.36,
  wheelWidth: 0.28,
  wheelBaseHalf: 1.32,
  trackHalf: 0.86,
  anchorY: -0.32,

  suspensionRest: 0.4,
  springK: 30000,
  damperC: 2600,
  damperBlowoff: 1.4,
  damperHighScale: 0.35,
  springForceMax: 16000,
  antiRollFront: 9000,
  antiRollRear: 6000,

  maxSteerDeg: 34,
  steerFalloff: 0.72,
  steerRate: 9,

  engineForce: 12000,
  brakeForce: 14000,
  handbrakeForce: 9000,
  frontSplit: 0.42,
  maxSpeed: 55,
  reverseMaxSpeed: 12,
  shiftSpeedLimit: 1.5,
  rollingResistance: 40,

  muFront: 1.25,
  muRear: 1.2,
  peakSlipDeg: 9,
  driftFalloff: 0.16,
  handbrakeRearGrip: 0.45,

  drag: 0.55,
  downforce: 1.2,

  angularDamping: 0.22,
  inertiaScaleYaw: 1.15,
};

export interface VehicleInput {
  /** Bukaan gas 0..1. Selalu mendorong ke arah gigi yang aktif. */
  throttle: number;
  /** Bukaan rem 0..1. Hanya memperlambat — tidak pernah membuat mobil mundur. */
  brake: number;
  /** -1 (kiri) .. 1 (kanan). */
  steer: number;
  handbrake: boolean;
  /** Gigi yang diminta pengemudi; mobil hanya menerimanya saat hampir berhenti. */
  gear: GearDirection;
}

export const neutralInput: VehicleInput = {
  throttle: 0,
  brake: 0,
  steer: 0,
  handbrake: false,
  gear: 1,
};

export interface WheelState {
  isFront: boolean;
  left: boolean;
  localAnchor: THREE.Vector3;
  anchor: THREE.Vector3;
  center: THREE.Vector3;
  contactPoint: THREE.Vector3;
  normal: THREE.Vector3;
  forward: THREE.Vector3;
  right: THREE.Vector3;
  contact: boolean;
  suspLength: number;
  compression: number;
  springForce: number;
  slipAngle: number;
  vLong: number;
  vLat: number;
  traction: number;
  surfaceMu: number;
  spinAngle: number;
}

export class VehiclePhysics {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  readonly position = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();
  readonly velocity = new THREE.Vector3();
  readonly angularVelocity = new THREE.Vector3();
  readonly wheels: WheelState[] = [];
  readonly cfg: VehicleConfig;
  /** Kerusakan mobil (bodi, mesin, ban). Selalu ada; `enabled` bisa dimatikan. */
  readonly damage: VehicleDamage;

  steerAngle = 0;
  speed = 0;
  /** Gigi yang benar-benar aktif (bisa berbeda dari yang diminta input). */
  gear: GearDirection = 1;

  private readonly world: RAPIER.World;
  private readonly spawn: THREE.Vector3;
  private readonly spawnYaw: number;
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  private readonly comPos = new THREE.Vector3();

  /* scratch — satu set, dipakai ulang tiap step (tanpa alokasi di hot loop) */
  private readonly sUp = new THREE.Vector3();
  private readonly sDown = new THREE.Vector3();
  private readonly sFwd = new THREE.Vector3();
  private readonly sRel = new THREE.Vector3();
  private readonly sPointVel = new THREE.Vector3();
  private readonly sForce = new THREE.Vector3();
  private readonly sDrift = new THREE.Vector3();
  private readonly sImpact = new THREE.Vector3();
  private readonly sInvQuat = new THREE.Quaternion();
  private readonly impulse = { x: 0, y: 0, z: 0 };
  private readonly impulseAt = { x: 0, y: 0, z: 0 };
  /** Kecepatan sebelum langkah terakhir, untuk mengukur Δv benturan. */
  private readonly prevVelocity = new THREE.Vector3();
  private hasPrevVelocity = false;

  constructor(
    world: RAPIER.World,
    cfg: VehicleConfig = defaultConfig,
    spawn = new THREE.Vector3(0, 0.95, 0),
    /** Heading in radians; 0 points the nose along +Z. */
    yaw = 0,
    /** Setelan kerusakan (mis. `{ enabled: false }` untuk mobil demo). */
    damageOptions: Partial<DamageOptions> = {},
  ) {
    this.world = world;
    this.damage = new VehicleDamage(damageOptions);
    this.cfg = { ...cfg };
    this.spawn = spawn.clone();
    this.spawnYaw = yaw;

    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawn.x, spawn.y, spawn.z)
      .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
      .setLinearDamping(0.02)
      .setAngularDamping(cfg.angularDamping)
      .setCcdEnabled(true)
      .setCanSleep(false);

    this.body = world.createRigidBody(desc);

    // Mass / inertia live on the collider (set below) so the center of mass can
    // sit well below the geometric center -> much harder to roll over.
    this.collider = world.createCollider(
      // Rounded box: the wheels carry the car, this shape is only here for
      // walls and rollovers. Square corners caught the crease of every jump
      // lip and landing and stopped the car dead ("kena track"), so the edges
      // are rounded and the box sits a little higher and slides (low friction).
      RAPIER.ColliderDesc.roundCuboid(
        cfg.halfWidth - 0.18,
        cfg.halfHeight - 0.18,
        cfg.halfLength - 0.18,
        0.18,
      )
        .setTranslation(0, 0.05, 0)
        .setFriction(0.12)
        .setRestitution(0),
      this.body,
    );

    this.applyMassProperties();

    const anchors: Array<[boolean, boolean, number, number]> = [
      [true, true, -cfg.trackHalf, cfg.wheelBaseHalf], // FL
      [true, false, cfg.trackHalf, cfg.wheelBaseHalf], // FR
      [false, true, -cfg.trackHalf, -cfg.wheelBaseHalf], // RL
      [false, false, cfg.trackHalf, -cfg.wheelBaseHalf], // RR
    ];

    for (const [isFront, left, x, z] of anchors) {
      this.wheels.push({
        isFront,
        left,
        localAnchor: new THREE.Vector3(x, cfg.anchorY, z),
        anchor: new THREE.Vector3(),
        center: new THREE.Vector3(),
        contactPoint: new THREE.Vector3(),
        normal: new THREE.Vector3(0, 1, 0),
        forward: new THREE.Vector3(0, 0, 1),
        right: new THREE.Vector3(1, 0, 0),
        contact: false,
        suspLength: cfg.suspensionRest,
        compression: 0,
        springForce: 0,
        slipAngle: 0,
        vLong: 0,
        vLat: 0,
        traction: 0,
        surfaceMu: 1,
        spinAngle: 0,
      });
    }

    this.syncTransform();
  }

  get speedKmh() {
    return Math.abs(this.speed) * 3.6;
  }

  /** 'D' atau 'R' — untuk HUD. */
  get gearName(): 'D' | 'R' {
    return this.gear === -1 ? 'R' : 'D';
  }

  /** Recompute mass / inertia from the current config (used by live tuning). */
  applyMassProperties() {
    const cfg = this.cfg;
    const m = cfg.mass;
    const w = cfg.halfWidth * 2;
    const h = cfg.halfHeight * 2;
    const d = cfg.halfLength * 2;
    const ixx = (m / 12) * (h * h + d * d);
    const iyy = (m / 12) * (w * w + d * d) * cfg.inertiaScaleYaw;
    const izz = (m / 12) * (w * w + h * h);
    this.collider.setMassProperties(
      m,
      { x: 0, y: cfg.comY, z: 0 },
      { x: ixx, y: iyy, z: izz },
      { x: 0, y: 0, z: 0, w: 1 },
    );
    this.body.recomputeMassPropertiesFromColliders();
  }

  /** Angular damping hanya bisa diubah lewat body, jadi slider GUI memanggil ini. */
  applyDamping() {
    this.body.setAngularDamping(this.cfg.angularDamping);
  }

  /** Public transform refresh so the renderer can draw the post-step pose. */
  sync() {
    this.syncTransform();
  }

  /** Arah hadap mobil dalam radian (0 = +Z), sama seperti `yaw` di trek. */
  get yaw(): number {
    const f = this.sFwd.set(0, 0, 1).applyQuaternion(this.quaternion);
    return Math.atan2(f.x, f.z);
  }

  /** Angle between the chassis heading and the travel direction (radians). */
  get driftAngle() {
    if (this.speed < 3) return 0;
    const h = this.sDrift.set(0, 0, 1).applyQuaternion(this.quaternion);
    return Math.atan2(h.x * this.velocity.z - h.z * this.velocity.x, h.x * this.velocity.x + h.z * this.velocity.z);
  }

  /** Teleport ke pose bebas: dipakai reset grid dan menghidupkan lagi lawan. */
  placeAt(pos: THREE.Vector3, yaw = this.spawnYaw) {
    this.body.setTranslation({ x: pos.x, y: pos.y, z: pos.z }, true);
    this.body.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.steerAngle = 0;
    this.speed = 0;
    this.gear = 1;
    // Teleport = bukan tabrakan: buang riwayat kecepatan, kalau tidak Δv dari
    // kecepatan lama ke nol langsung dihitung sebagai benturan dan mobil yang
    // baru saja diperbaiki malah rusak lagi di langkah berikutnya.
    this.velocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
    this.hasPrevVelocity = false;
    // Mobil yang di-reset otomatis diperbaiki: itu satu-satunya jalan keluar
    // dari kerusakan (tidak ada perbaikan otomatis di tengah balapan).
    this.damage.reset();
    for (const w of this.wheels) {
      w.spinAngle = 0;
      w.contact = false;
      w.suspLength = this.cfg.suspensionRest;
      w.compression = 0;
      w.springForce = 0;
      w.surfaceMu = 1;
    }
    this.syncTransform();
  }

  reset() {
    this.placeAt(this.spawn, this.spawnYaw);
  }

  /**
   * Seberapa tegak mobilnya: 1 = roda di bawah, 0 = miring 90°, negatif =
   * terbalik. Dipakai pengawas balapan untuk mengenali mobil terbalik (tidak
   * bisa jalan sendiri → ambulans datang dan mendereknya).
   */
  get upright(): number {
    const q = this.quaternion;
    return 1 - 2 * (q.x * q.x + q.z * q.z);
  }

  /* ------------------------------------------------------------------ */
  /* derek (recovery): mobil diangkut, fisika dimatikan sementara        */
  /* ------------------------------------------------------------------ */

  private towed = false;

  /** Sedang diangkut kendaraan derek? */
  get isTowed(): boolean {
    return this.towed;
  }

  /**
   * Naikkan/turunkan mobil dari kendaraan derek.
   *
   * Selama diangkut, bodinya jadi **kinematik**: tidak jatuh, tidak menabrak,
   * dan tidak bisa disetir — persis mobil yang diikat di belakang truk derek.
   */
  setTowed(on: boolean) {
    if (this.towed === on) return;
    this.towed = on;
    this.body.setBodyType(
      on ? RAPIER.RigidBodyType.KinematicPositionBased : RAPIER.RigidBodyType.Dynamic,
      true,
    );
    if (!on) {
      this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      this.speed = 0;
      this.velocity.set(0, 0, 0);
      this.angularVelocity.set(0, 0, 0);
      // Jangan anggap perpindahan ini sebagai tabrakan.
      this.hasPrevVelocity = false;
      for (const w of this.wheels) w.contact = false;
    }
  }

  /** Pindahkan mobil yang sedang diangkut ke pose tertentu (tiap langkah). */
  carryTo(pos: THREE.Vector3, yaw: number) {
    if (!this.towed) return;
    this.body.setNextKinematicTranslation({ x: pos.x, y: pos.y, z: pos.z });
    this.body.setNextKinematicRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) });
  }

  /**
   * Lepas mobil derek di titik tertentu **tanpa** memperbaikinya (servis di pit
   * tetap memakan waktu — tidak ada perbaikan diam-diam).
   */
  dropAt(pos: THREE.Vector3, yaw: number) {
    this.body.setTranslation({ x: pos.x, y: pos.y, z: pos.z }, true);
    this.body.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.steerAngle = 0;
    this.speed = 0;
    this.gear = 1;
    this.velocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
    this.hasPrevVelocity = false;
    this.syncTransform();
  }

  /**
   * Benturan dideteksi dari **lonjakan Δv** antar langkah fisika — tanpa perlu
   * event queue Rapier, jadi jalan identik di browser dan di uji headless.
   * Gravitasi hanya menambah 0,16 m/s per langkah, jauh di bawah ambang.
   */
  private detectImpact() {
    const v = this.velocity;
    if (!this.hasPrevVelocity) {
      this.prevVelocity.copy(v);
      this.hasPrevVelocity = true;
      return;
    }
    this.sImpact.subVectors(v, this.prevVelocity);
    // Buang komponen gravitasi supaya jatuh bebas tidak dihitung sebagai tabrakan.
    this.sImpact.y += 9.81 / 60;
    const mag = this.sImpact.length();
    if (mag > 2.2) {
      // ke kerangka mobil: x = kiri, z = depan
      this.sImpact.applyQuaternion(this.sInvQuat.copy(this.quaternion).invert());
      this.damage.impact(this.sImpact.x, this.sImpact.y, this.sImpact.z);
    }
    this.prevVelocity.copy(v);
  }

  /** Roda ini sudah copot? (dipakai visual untuk menyembunyikan rodanya) */
  wheelLost(index: number): boolean {
    return this.damage.wheels[index]?.lost === true;
  }

  private syncTransform() {
    const t = this.body.translation();
    const q = this.body.rotation();
    this.position.set(t.x, t.y, t.z);
    this.quaternion.set(q.x, q.y, q.z, q.w);
  }

  /** Advance the vehicle by a fixed physics step. Call BEFORE world.step(). */
  fixedStep(dt: number, input: VehicleInput) {
    this.syncTransform();
    // Di atas truk derek: tidak ada mesin, ban, atau tabrakan.
    if (this.towed) {
      this.speed = 0;
      this.velocity.set(0, 0, 0);
      this.angularVelocity.set(0, 0, 0);
      return;
    }
    this.detectImpact();

    const lin = this.body.linvel();
    this.velocity.set(lin.x, lin.y, lin.z);
    const ang = this.body.angvel();
    this.angularVelocity.set(ang.x, ang.y, ang.z);
    this.speed = this.velocity.length();

    const up = this.sUp.set(0, 1, 0).applyQuaternion(this.quaternion);
    const fwd = this.sFwd.set(0, 0, 1).applyQuaternion(this.quaternion);
    const forwardSpeed = this.velocity.dot(fwd);

    this.comPos.set(0, this.cfg.comY, 0).applyQuaternion(this.quaternion).add(this.position);

    this.updateGear(input.gear, forwardSpeed);
    this.updateSteering(dt, input.steer, this.speed);
    this.updateSuspension(up);
    this.applyAntiRoll();
    this.applyTireForces(dt, input, up, fwd, forwardSpeed);
    this.applyAero(dt, up);
    this.applyParkingHold(dt, input);

    if (this.position.y < -25) this.reset();
  }

  /**
   * Rem parkir: dengan gas dan rem dilepas, mobil yang sudah berhenti menancap
   * di tanah, tidak menggelinding pelan di turunan landai. Ban asli punya
   * gesekan statis; bodi rigid tidak, jadi tanpa ini mobil yang diparkir di
   * tanjakan 0,5 % merayap turun (~0,3 m/s di trek baru yang bertanjakan).
   */
  private applyParkingHold(dt: number, input: VehicleInput) {
    if (input.throttle > 0.01 || input.brake > 0.01 || input.handbrake) return;
    let grounded = 0;
    for (const w of this.wheels) if (w.contact) grounded++;
    if (grounded < 3) return;

    const lin = this.body.linvel();
    const horizontal = Math.hypot(lin.x, lin.z);
    if (horizontal > 0.8) return;
    // static friction beats gravity up to about half a g of creep per step
    const maxDelta = 0.5 * 9.81 * dt;
    const scale = horizontal > 1e-6 ? Math.max(0, 1 - Math.min(1, maxDelta / horizontal)) : 0;
    this.body.setLinvel({ x: lin.x * scale, y: lin.y, z: lin.z * scale }, true);

    const ang = this.body.angvel();
    if (ang.x !== 0 || ang.z !== 0) {
      // kill the pitch/roll wobble, leave yaw alone so steering still works
      this.body.setAngvel({ x: ang.x * 0.4, y: ang.y, z: ang.z * 0.4 }, true);
    }
  }

  /**
   * Gigi hanya boleh ditukar saat mobil hampir berhenti, seperti gearbox manual:
   * menekan R di tengah lintasan tidak langsung membalik arah mobil.
   */
  private updateGear(requested: GearDirection, forwardSpeed: number) {
    if (requested === this.gear) return;
    if (Math.abs(forwardSpeed) > this.cfg.shiftSpeedLimit) return;
    this.gear = requested;
  }

  private updateSteering(dt: number, steerInput: number, speed: number) {
    const cfg = this.cfg;
    const damage = this.damage;
    // Roda depan rusak/copot: sudut roda yang bisa dicapai mengecil.
    const maxSteer =
      THREE.MathUtils.degToRad(cfg.maxSteerDeg) *
      (1 - cfg.steerFalloff * clamp(speed / cfg.maxSpeed, 0, 1)) *
      damage.steerScale;
    // Ban depan kempes menarik setir ke sisinya, jadi mobil harus dilawan.
    const bias = damage.pullSteer(speed);
    // three.js is right-handed: with the car facing +Z, a positive rotation
    // about +Y swings the nose toward +X, which is the car's LEFT (right-hand
    // side of a +Z-facing car is -X). Input +1 means "right", so negate here.
    // Convention: steerAngle > 0 == counter-clockwise (left) in world space.
    this.steerAngle = moveTowards(
      this.steerAngle,
      -clamp(steerInput, -1, 1) * maxSteer + bias,
      cfg.steerRate * dt,
    );
  }

  /* ---------------- suspension ---------------- */

  private updateSuspension(up: THREE.Vector3) {
    const cfg = this.cfg;
    const down = this.sDown.copy(up).negate();
    // The ray starts a bit ABOVE the suspension anchor. If it started at the
    // anchor, a hard landing that sinks the body below the track would put the
    // ray origin under the surface: no hit, no spring force, and the car stays
    // stuck on its floor pan forever.
    const rayLift = 0.7;
    const maxToi = rayLift + cfg.suspensionRest + cfg.wheelRadius;

    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];
      w.anchor.copy(w.localAnchor).applyQuaternion(this.quaternion).add(this.position);
      w.contact = false;
      w.springForce = 0;
      w.traction = 0;
      w.slipAngle = 0;
      w.vLong = 0;
      w.vLat = 0;

      // BAN COPOT: tidak ada roda, tidak ada gaya pegas di sudut itu. Mobil
      // langsung miring ke sudut tersebut dan hanya disangga tiga roda.
      if (this.damage.wheels[i]?.lost) {
        w.center.copy(w.anchor).addScaledVector(down, cfg.suspensionRest);
        w.suspLength = cfg.suspensionRest;
        w.compression = 0;
        continue;
      }

      this.ray.origin.x = w.anchor.x + up.x * rayLift;
      this.ray.origin.y = w.anchor.y + up.y * rayLift;
      this.ray.origin.z = w.anchor.z + up.z * rayLift;
      this.ray.dir.x = down.x;
      this.ray.dir.y = down.y;
      this.ray.dir.z = down.z;

      const hit = this.world.castRayAndGetNormal(
        this.ray,
        maxToi,
        true,
        undefined,
        undefined,
        undefined,
        this.body,
      );

      w.suspLength = cfg.suspensionRest;
      w.compression = 0;

      if (!hit) {
        w.center.copy(w.anchor).addScaledVector(down, cfg.suspensionRest);
        continue;
      }

      w.normal.set(hit.normal.x, hit.normal.y, hit.normal.z);
      if (w.normal.dot(up) < 0.25) {
        // nearly vertical surface: treat as a wall, not ground
        w.center.copy(w.anchor).addScaledVector(down, cfg.suspensionRest);
        continue;
      }

      const toi = hit.timeOfImpact - rayLift;
      if (toi > cfg.suspensionRest + cfg.wheelRadius) {
        // Only the lifted part of the ray hit: the wheel is in the air.
        w.center.copy(w.anchor).addScaledVector(down, cfg.suspensionRest);
        continue;
      }
      w.contact = true;
      w.suspLength = clamp(toi - cfg.wheelRadius, 0, cfg.suspensionRest);
      w.compression = cfg.suspensionRest - w.suspLength;
      w.contactPoint.copy(w.anchor).addScaledVector(down, toi);
      w.surfaceMu = clamp(hit.collider.friction(), 0.15, 1.5);

      this.sRel.copy(w.anchor).sub(this.comPos);
      const vAnchor = this.sPointVel.copy(this.angularVelocity).cross(this.sRel).add(this.velocity);
      // vDown > 0 while the suspension compresses. A damper opposes the
      // suspension velocity, so it ADDS to the spring force in compression.
      const vDown = vAnchor.dot(down);
      // Damper digressive: di atas kecepatan blow-off gayanya tidak lagi naik
      // linear. Tanpa ini, mendarat dari lompatan menghasilkan gaya 5-8x berat
      // mobil, dan mobil terpental naik lagi (kelihatan seperti "nabrak track").
      const blow = Math.max(cfg.damperBlowoff, 0.05);
      const scaledDown = vDown <= blow
        ? vDown
        : blow + (vDown - blow) * clamp(cfg.damperHighScale, 0, 1);
      const raw = cfg.springK * w.compression + cfg.damperC * scaledDown;
      w.springForce = clamp(raw, 0, cfg.springForceMax);
      w.center.copy(w.anchor).addScaledVector(down, w.suspLength);
    }
  }

  private applyAntiRoll() {
    const arb = (a: number, b: number, stiffness: number) => {
      const wa = this.wheels[a];
      const wb = this.wheels[b];
      if (!wa.contact || !wb.contact) return;
      const f = stiffness * (wa.compression - wb.compression);
      wa.springForce = Math.max(wa.springForce + f, 0);
      wb.springForce = Math.max(wb.springForce - f, 0);
    };
    arb(0, 1, this.cfg.antiRollFront);
    arb(2, 3, this.cfg.antiRollRear);
  }

  /* ---------------- tires ---------------- */

  private applyTireForces(
    dt: number,
    input: VehicleInput,
    up: THREE.Vector3,
    bodyFwd: THREE.Vector3,
    forwardSpeed: number,
  ) {
    const cfg = this.cfg;
    const peak = THREE.MathUtils.degToRad(cfg.peakSlipDeg);
    const damage = this.damage;
    const throttleScale = damage.throttleScale;
    const topSpeedScale = damage.topSpeedScale;
    // Power falls off with speed *in the direction of the engaged gear*; the
    // brake pedal never feeds power, so top speed is capped here only once.
    const limit = (this.gear === 1 ? cfg.maxSpeed : cfg.reverseMaxSpeed) * (this.gear === 1 ? topSpeedScale : 1);
    const speedInGear = Math.max(forwardSpeed * this.gear, 0);
    // `limit` bisa 0 kalau mesin mati: jangan sampai 0/0 = NaN masuk ke gaya ban.
    const powerScale = limit > 0.05 ? clamp(1 - Math.pow(speedInGear / limit, 2), 0, 1) : 0;

    const throttle = clamp(input.throttle, 0, 1);
    const brake = clamp(input.brake, 0, 1);

    for (let wheelIndex = 0; wheelIndex < this.wheels.length; wheelIndex++) {
      const w = this.wheels[wheelIndex];
      if (!w.contact) continue;
      const Fz = w.springForce;
      if (Fz < 1) continue;
      const grip = damage.wheelGrip(wheelIndex);
      if (grip <= 0) continue;

      const steer = w.isFront ? this.steerAngle : 0;
      w.forward.copy(bodyFwd);
      if (steer !== 0) w.forward.applyAxisAngle(up, steer);
      // right = forward x up  (three.js right-handed -> -X when forward is +Z)
      w.right.crossVectors(w.forward, up).normalize();

      this.sRel.copy(w.contactPoint).sub(this.comPos);
      const vC = this.sPointVel.copy(this.angularVelocity).cross(this.sRel).add(this.velocity);
      const vLong = vC.dot(w.forward);
      const vLat = vC.dot(w.right);
      w.vLong = vLong;
      w.vLat = vLat;

      const alpha = Math.atan2(vLat, Math.abs(vLong) + 0.9);
      w.slipAngle = alpha;

      let mu = (w.isFront ? cfg.muFront : cfg.muRear) * w.surfaceMu * grip;
      if (!w.isFront && input.handbrake) mu *= cfg.handbrakeRearGrip;

      /* lateral: linear up to the peak slip angle, then a controlled falloff */
      const slide = Math.abs(alpha) / peak;
      let latScale = Math.min(slide, 1);
      if (slide > 1) latScale = Math.max(1 - (slide - 1) * cfg.driftFalloff, 0.5);
      let Fy = -Math.sign(alpha) * latScale * mu * Fz;

      /* longitudinal */
      const share = w.isFront ? cfg.frontSplit * 0.5 : (1 - cfg.frontSplit) * 0.5;
      let Fx = 0;

      if (throttle > 0.01 && throttleScale > 0) {
        Fx += cfg.engineForce * throttle * share * this.gear * powerScale * throttleScale;
      }

      // The brake only ever opposes the current motion. The `vLong`-based
      // authority fades out near standstill so it cannot push the car backwards
      // (that is the reverse gear's job) and cannot jitter around zero.
      const stoppingAuthority = clamp(Math.abs(vLong) / 1.2, 0, 1);
      let FxOppose = 0;
      if (brake > 0.01) {
        const brakeShare = w.isFront ? 0.28 : 0.22;
        FxOppose += cfg.brakeForce * brake * brakeShare * stoppingAuthority;
      }
      if (input.handbrake && !w.isFront) {
        FxOppose += cfg.handbrakeForce * 0.25 * stoppingAuthority;
      }
      FxOppose += cfg.rollingResistance * share * damage.wheelDrag(wheelIndex);

      // A tyre can slow the contact patch down but never push it back: the
      // friction impulse of one step may not exceed the slip velocity. Without
      // this the explicit integration overshoots at walking pace (the force
      // reverses the velocity, the next step reverses it again, ...), which
      // showed up as a parked car creeping sideways with the grip readout
      // flickering at ~60 Hz. `mContact` is the mass that actually answers an
      // impulse at one contact patch: a quarter of the car, halved again
      // because the chassis can rotate around that point instead of
      // translating. Above ~0.4 m/s of slip the real friction force is smaller
      // than this cap, so the clamp only ever acts as static friction.
      const mContact = cfg.mass * 0.125;
      const maxLatImpulse = (Math.abs(vLat) * mContact) / dt;
      if (Math.abs(Fy) > maxLatImpulse) Fy = Math.sign(Fy) * maxLatImpulse;
      Fx -= Math.sign(vLong) * Math.min(FxOppose, (Math.abs(vLong) * mContact) / dt);

      /* friction circle */
      const maxF = mu * Fz;
      const mag = Math.hypot(Fx, Fy);
      if (mag > maxF && mag > 1e-3) {
        const s = maxF / mag;
        Fx *= s;
        Fy *= s;
      }
      w.traction = maxF > 0 ? clamp(Math.hypot(Fx, Fy) / maxF, 0, 1) : 0;

      // Spring pushes along the contact normal (not the chassis up axis) so
      // slopes and ramps support the car correctly.
      this.sForce
        .copy(w.normal)
        .multiplyScalar(w.springForce * dt)
        .addScaledVector(w.forward, Fx * dt)
        .addScaledVector(w.right, Fy * dt);

      this.applyImpulse(this.sForce, w.contactPoint);

      w.spinAngle += (vLong / cfg.wheelRadius) * dt;
    }
  }

  /* ---------------- aero ---------------- */

  private applyAero(dt: number, up: THREE.Vector3) {
    const cfg = this.cfg;
    const v2 = this.speed * this.speed;
    if (v2 <= 0.01) return;

    this.sForce.copy(this.velocity).normalize().multiplyScalar(-cfg.drag * v2 * dt);
    this.applyImpulse(this.sForce, this.comPos);

    this.sForce.copy(up).multiplyScalar(-cfg.downforce * v2 * dt);
    this.applyImpulse(this.sForce, this.comPos);
  }

  private applyImpulse(force: THREE.Vector3, at: THREE.Vector3) {
    this.impulse.x = force.x;
    this.impulse.y = force.y;
    this.impulse.z = force.z;
    this.impulseAt.x = at.x;
    this.impulseAt.y = at.y;
    this.impulseAt.z = at.z;
    this.body.applyImpulseAtPoint(this.impulse, this.impulseAt, true);
  }
}
