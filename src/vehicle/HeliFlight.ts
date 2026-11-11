import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

/**
 * Helikopter yang bisa diterbangkan pemain.
 *
 * Fisikanya **bukan animasi**: badan heli adalah rigid body dinamis di dunia
 * Rapier yang sama dengan mobil, jadi ia kena gravitasi, menabrak pagar, dan
 * mendarat di tanah — bukan melayang di jalur yang sudah direkam.
 *
 * Pembagian tugasnya disengaja:
 *
 * - **Terjemahan (x, y, z) = fisika penuh.** Gaya dorong rotor, gravitasi,
 *   hambatan badan, dan tumbukan semuanya dari Rapier. Karena dorongan rotor
 *   diarahkan ke sumbu-atas badan, mencondongkan hidung otomatis membuat heli
 *   melaju — tidak ada "kecepatan maju" yang di-set langsung.
 * - **Sikap (pitch/roll/yaw) = kemudi pemain** yang diintegrasikan dengan laju
 *   terbatas (ada inersia: heli butuh ±0,3 s untuk mencapai kemiringan penuh).
 *   Ini disengaja: simulasi torsi penuh untuk rotor akan lebih realistis tapi
 *   praktis tidak bisa diterbangkan tanpa fly-by-wire, dan justru membuat
 *   helinya jatuh sendiri.
 *
 * Tidak menyentuh DOM, jadi bisa diuji di Node (lihat `scripts/smoke.ts`).
 */

export interface HeliInput {
  /** Tuas kolektif 0..1. 0 = rotor idle, ~0,62 = hover, 1 = panjat penuh. */
  collective: number;
  /** −1 putar kiri, +1 putar kanan (pedal anti-torsi). */
  yaw: number;
  /** −1 hidung naik (mengerem/mundur), +1 hidung turun (maju). */
  pitch: number;
  /** −1 miring kiri, +1 miring kanan. */
  roll: number;
}

export const NEUTRAL_HELI_INPUT: HeliInput = { collective: 0.62, yaw: 0, pitch: 0, roll: 0 };

/* ---------------------------------------------------------------- konfigurasi */

/** Massa kosong + bahan bakar, kg. */
export const HELI_MASS = 950;
/** Dorongan rotor maksimum, N. 1,6× berat → hover di kolektif ±0,62. */
export const HELI_MAX_THRUST = HELI_MASS * 9.81 * 1.6;
/** Kolektif yang menahan heli di udara (dorongan = berat). */
export const HELI_HOVER = 1 / 1.6;
/** Kemiringan maksimum, rad (±31°). */
const MAX_TILT = 0.54;
/** Laju putar maksimum, rad/s. */
const MAX_YAW_RATE = 1.25;
/** Seberapa cepat sikap mengejar target (1/s). */
const ATTITUDE_RATE = 3.4;
/** Ketinggian maksimum, meter — di atas ini rotor kehilangan tenaga. */
export const HELI_CEILING = 150;
/** Batas horizontal (setengah arena), meter. */
const ARENA_LIMIT = 380;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Tinggi skid di bawah titik asal model (sama dengan `Heli.ts`). */
export const SKID_Y = -1.36;

export interface HeliSnapshot {
  position: THREE.Vector3;
  yaw: number;
  pitch: number;
  roll: number;
  /** Kecepatan horizontal, m/s. */
  speed: number;
  /** Kecepatan vertikal, m/s (positif = naik). */
  climb: number;
  /** Ketinggian titik asal di atas tanah, meter. */
  altitude: number;
  /** 0..1 — putaran rotor (ikut tertinggal dari tuas, seperti mesin sungguhan). */
  rotor: number;
  /** Menyentuh tanah (skid kontak)? */
  landed: boolean;
}

export class HeliFlight {
  readonly body: RAPIER.RigidBody;
  /** Posisi asal model (bukan pusat massa) — dipakai visual & kamera. */
  position = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  roll = 0;
  rotor = 0;
  landed = false;
  /** Kolektif yang sedang dipegang (0..1). Mesin mati = rotor diam. */
  collective = 0;
  /** Berapa kali heli ini menabrak sesuatu dengan keras. */
  crashes = 0;

  private readonly colliders: RAPIER.Collider[] = [];
  private readonly contact = { count: 0 };
  private readonly pad: THREE.Vector3;
  private readonly padYaw: number;
  private readonly velocity = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly thrust = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly euler = new THREE.Euler();
  private lastSpeed = 0;

  constructor(world: RAPIER.World, position: THREE.Vector3, yaw = 0) {
    this.pad = position.clone();
    this.padYaw = yaw;
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(position.x, position.y, position.z)
        .setRotation(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)))
        .setLinearDamping(0.05)
        .setAngularDamping(4)
        .setCcdEnabled(true)
        // Sikap diatur kemudi, bukan torsi: rotasi dari solver dimatikan supaya
        // heli tidak terpelintir sendiri saat roda skid menyentuh tanah.
        .enabledRotations(false, false, false),
    );
    this.yaw = yaw;

    // Badan: satu kotak untuk tabrakan dengan pagar/truk, dua skid untuk mendarat.
    const bodyDesc = RAPIER.ColliderDesc.cuboid(1.05, 0.95, 2.15)
      .setTranslation(0, 0.1, 0)
      .setFriction(0.35)
      .setRestitution(0.15)
      .setDensity(0);
    this.colliders.push(world.createCollider(bodyDesc, this.body));
    for (const side of [-1, 1]) {
      const skid = RAPIER.ColliderDesc.cuboid(0.1, 0.08, 1.3)
        .setTranslation(side * 0.9, SKID_Y + 0.08, 0.3)
        .setFriction(0.85)
        .setRestitution(0.02)
        .setDensity(0);
      this.colliders.push(world.createCollider(skid, this.body));
      this.colliders[this.colliders.length - 1].setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    }
    // Massa total dipasang manual supaya angka di kode = angka di HUD.
    this.body.setAdditionalMass(HELI_MASS, true);
    this.readPose();
  }

  /** Kembalikan ke helipad (dipakai tombol reset dan saat mendarat darurat). */
  reset(): void {
    this.body.setTranslation({ x: this.pad.x, y: this.pad.y, z: this.pad.z }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setRotation(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, this.padYaw, 0)), true);
    this.yaw = this.padYaw;
    this.pitch = 0;
    this.roll = 0;
    this.rotor = 0;
    this.collective = 0;
    this.landed = true;
    this.readPose();
  }

  get padPosition(): THREE.Vector3 {
    return this.pad.clone();
  }

  /**
   * Satu langkah fisika. `dt` = langkah tetap (1/60).
   *
   * `autoHover` dipakai saat heli tidak diterbangkan pemain: rotor menahan
   * ketinggian yang sekarang supaya heli tidak jatuh menimpa mobil yang sedang
   * balapan.
   */
  step(dt: number, input: HeliInput, autoHover = false): void {
    // Gaya di Rapier bersifat **persisten** sampai di-reset: tanpa baris ini
    // dorongan rotor menumpuk tiap langkah dan helinya melesat ke langit.
    this.body.resetForces(false);
    const v = this.body.linvel();
    this.velocity.set(v.x, v.y, v.z);

    // --- tuas kolektif + putaran rotor (ada tenggang, seperti mesin) ---
    // Auto-hover hanya bekerja saat sudah di udara: heli yang terparkir di
    // landasan tidak boleh lepas landas sendiri.
    const wantedCollective = autoHover
      ? this.altitude > 1.2
        ? this.hoverCollective()
        : 0
      : clamp(input.collective, 0, 1);
    this.collective += (wantedCollective - this.collective) * Math.min(1, dt * 4);
    const rotorTarget = this.collective < 0.02 ? 0 : 0.35 + 0.65 * clamp(this.collective / HELI_HOVER, 0, 1);
    const spool = this.collective > this.rotor ? 0.9 : 0.45;
    this.rotor = clamp(this.rotor + (rotorTarget - this.rotor) * Math.min(1, dt * spool * 2.4), 0, 1);

    // --- sikap: kemudi mengejar sudut target dengan inersia ---
    const targetPitch = autoHover ? 0 : clamp(input.pitch, -1, 1) * MAX_TILT;
    const targetRoll = autoHover ? 0 : -clamp(input.roll, -1, 1) * MAX_TILT;
    const k = Math.min(1, dt * ATTITUDE_RATE);
    this.pitch += (targetPitch - this.pitch) * k;
    this.roll += (targetRoll - this.roll) * k;

    // Pedal anti-torsi: laju putar ikut input, dengan sedikit inersia.
    const yawRate = autoHover ? 0 : clamp(input.yaw, -1, 1) * MAX_YAW_RATE;
    this.yaw += yawRate * dt;

    const grounded = this.grounded();
    // Di tanah dengan rotor rendah, skid menahan badan: sikap dipaksa rata.
    if (grounded && this.collective < HELI_HOVER * 0.9) {
      this.pitch *= 1 - Math.min(1, dt * 6);
      this.roll *= 1 - Math.min(1, dt * 6);
    }

    this.quat.setFromEuler(this.euler.set(this.pitch, this.yaw, this.roll, 'YXZ'));
    this.body.setRotation(this.quat, true);

    // --- dorongan rotor ---
    // Gubernur rotor: mencondongkan badan mengurangi komponen angkat, dan pada
    // heli sungguhan pilot menarik tuas untuk menutupinya. Di sini 55 % dari
    // kehilangan itu ditutup otomatis supaya pemain tidak perlu mengejar tuas
    // setiap kali mau maju — sisanya tetap terasa sebagai "hidungnya berat".
    const tiltLoss = 1 - Math.cos(this.pitch) * Math.cos(this.roll);
    const effectiveCollective = clamp(this.collective + tiltLoss * 0.55, 0, 1);
    // Efek tanah: di bawah ±3 m dorongan sedikit menguat (bantalan udara).
    const altitude = this.altitude;
    const groundEffect = altitude < 3 ? 1 + 0.09 * (1 - clamp(altitude / 3, 0, 1)) : 1;
    // Di atas langit-langit rotor kehilangan tenaga (udara menipis).
    const ceiling = this.body.translation().y > HELI_CEILING ? 0.55 : 1;
    // "Translational lift": begitu heli punya laju maju, rotor menerima udara
    // segar dan gaya angkatnya naik — ini sebabnya heli sungguhan justru lebih
    // ringan di penerbangan jelajah daripada saat hover.
    const lift = 0.18 * HELI_MASS * 9.81 * clamp(Math.hypot(this.velocity.x, this.velocity.z) / 30, 0, 1);
    const thrustMag =
      HELI_MAX_THRUST * effectiveCollective * this.rotor * groundEffect * ceiling + lift;

    this.up.set(0, 1, 0).applyQuaternion(this.quat);
    this.thrust.copy(this.up).multiplyScalar(thrustMag);
    this.body.addForce({ x: this.thrust.x, y: this.thrust.y, z: this.thrust.z }, true);

    // --- hambatan badan: rotor juga menahan laju mendatar & vertikal ---
    // Hambatan rotor: makin cepat terbang makin besar gayanya. Angka ini yang
    // menentukan kecepatan puncak (±112 km/j) dan laju panjat (±8 m/s), jadi
    // heli terasa berat — bukan pesawat kertas.
    const horiz = Math.hypot(this.velocity.x, this.velocity.z);
    const drag = 0.12 * (1 + horiz * 0.012);
    this.body.addForce(
      {
        x: -this.velocity.x * drag * HELI_MASS,
        y: -this.velocity.y * (0.3 + this.rotor * 0.4) * HELI_MASS,
        z: -this.velocity.z * drag * HELI_MASS,
      },
      true,
    );
    // Gaya samping saat miring: badan yang mencondong "mendorong" udara,
    // ini yang membuat heli melambat saat berbelok tajam.
    const sideSlip = this.velocity.x * Math.cos(this.yaw) - this.velocity.z * Math.sin(this.yaw);
    this.body.addForce(
      {
        x: -sideSlip * Math.sin(this.yaw) * HELI_MASS * 0.05,
        y: 0,
        z: -sideSlip * Math.cos(this.yaw) * HELI_MASS * 0.05,
      },
      true,
    );

    // --- pagar tak terlihat: arena bukan dunia tanpa batas ---
    // Pegas keras yang menahan laju keluar: cukup kuat untuk melawan dorongan
    // rotor penuh (0,8 berat), jadi pemain berhenti ±2–3 m di luar batas dan
    // tidak pernah terbang ke luar peta.
    const pos = this.body.translation();
    for (const axis of ['x', 'z'] as const) {
      const d = pos[axis];
      const over = Math.abs(d) - ARENA_LIMIT;
      if (over <= 0) continue;
      const sign = Math.sign(d);
      const outward = this.velocity[axis] * sign;
      const accel = Math.min(48, over * 4) + Math.max(0, outward) * 3;
      this.body.addForce({ x: 0, y: 0, z: 0, ...{ [axis]: -sign * accel * HELI_MASS } }, true);
    }

    // Tabrakan keras: hitung untuk efek visual (asap/percikan) & HUD.
    const speed = this.body.linvel();
    const now = Math.hypot(speed.x, speed.y, speed.z);
    if (this.lastSpeed - now > 6) this.crashes++;
    this.lastSpeed = now;

    this.contact.count = 0;
    this.readPose();
  }

  /** Ketinggian skid di atas tanah (0 = duduk di landasan). */
  get altitude(): number {
    return this.body.translation().y + SKID_Y;
  }

  /** Kolektif yang menahan berat saat ini (dipakai auto-hover). */
  hoverCollective(): number {
    const effective = this.altitude < 3 ? 1.05 : 1;
    return clamp(HELI_HOVER / (Math.max(0.25, this.rotor) * effective), 0.05, 1);
  }

  /** Skid menyentuh sesuatu (tanah/pad)? */
  grounded(): boolean {
    return this.landed || this.altitude <= 0.35;
  }

  private readPose(): void {
    const t = this.body.translation();
    const v = this.body.linvel();
    this.position.set(t.x, t.y, t.z);
    this.velocity.set(v.x, v.y, v.z);
    const onGround = t.y + SKID_Y < 0.45 && Math.abs(v.y) < 1.2;
    this.landed = onGround;
  }

  snapshot(): HeliSnapshot {
    const v = this.body.linvel();
    return {
      position: this.position.clone(),
      yaw: this.yaw,
      pitch: this.pitch,
      roll: this.roll,
      speed: Math.hypot(v.x, v.z),
      climb: v.y,
      altitude: this.position.y + SKID_Y,
      rotor: this.rotor,
      landed: this.landed,
    };
  }

  /** Buang badan dari dunia fisika (dipanggil saat halaman ditutup). */
  dispose(world: RAPIER.World): void {
    for (const c of this.colliders) world.removeCollider(c, false);
    world.removeRigidBody(this.body);
  }
}
