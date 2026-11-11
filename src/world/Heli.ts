import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { surface } from './style';

/**
 * Helikopter siaran: kamera udara yang terbang mengelilingi mobil yang sedang
 * disorot.
 *
 * Modelnya dibangun dari geometri sederhana tapi mengikuti siluet helikopter
 * sungguhan (kelas H125/Bell 206): badan *lathe* yang membulat, hidung kaca
 * besar, boom ekor meruncing, sirip ekor bersayap, rotor ekor di samping sirip,
 * dua skid dengan pipa silang, dek mesin + knalpot, dan kamera gimbal di dagu.
 *
 * Rotor utama dan rotor ekor berputar; masing-masing punya cakram kabur
 * transparan supaya terbaca "berputar cepat" dari jauh — lebih murah daripada
 * motion blur, dan materialnya PBR seperti sisa scene.
 *
 * Tidak menyentuh DOM, jadi bisa diuji di Node.
 */

const PAINT = 0xd8342a; // merah tim
const PAINT_DARK = 0xa3241c;
const METAL = 0x2b323b;
const GLASS = 0x74c8f0;
const TRIM = 0xf2f4f7;

/** Badan: profil (z, radius) dari ekor ke hidung, membulat seperti telur. */
const BODY_PROFILE: Array<[number, number]> = [
  [-1.88, 0],
  [-1.86, 0.3],
  [-1.3, 0.62],
  [-0.9, 0.86],
  [-0.6, 0.97],
  [-0.4, 1.0],
  [0.6, 1.0],
  [0.9, 0.97],
  [1.3, 0.86],
  [1.75, 0.62],
  [2.15, 0.3],
  [2.42, 0],
];

/** Hanya bagian hidung: dipakai untuk kaca depan yang "membungkus". */
const GLASS_FROM = 0.55;

/**
 * Gabungkan semua mesh anak sebuah grup per material (geometri di-*bake* ke
 * ruang lokal grup). Bagian yang dianimasikan tidak boleh lewat sini.
 */
function mergeByMaterial(group: THREE.Group) {
  group.updateMatrixWorld(true);
  const groups = new Map<THREE.Material, { geometries: THREE.BufferGeometry[]; meshes: THREE.Mesh[] }>();
  for (const child of [...group.children]) {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || Array.isArray(mesh.material)) continue;
    mesh.updateMatrix();
    // `toNonIndexed()` dulu: lathe itu ber-index, extrude tidak — campurannya
    // ditolak oleh `mergeGeometries`.
    const source = mesh.geometry;
    const geometry = (source.index ? source.toNonIndexed() : source.clone()) as THREE.BufferGeometry;
    geometry.applyMatrix4(mesh.matrix);
    const entry = groups.get(mesh.material) ?? { geometries: [], meshes: [] };
    entry.geometries.push(geometry);
    entry.meshes.push(mesh);
    groups.set(mesh.material, entry);
  }

  for (const [material, entry] of groups) {
    const merged = entry.meshes.length > 1 ? mergeGeometries(entry.geometries, false) : null;
    if (!merged) {
      // Gagal gabung: biarkan mesh aslinya (jangan sampai ada yang hilang).
      for (const geometry of entry.geometries) geometry.dispose();
      continue;
    }
    for (const geometry of entry.geometries) geometry.dispose();
    for (const mesh of entry.meshes) group.remove(mesh);
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = !material.transparent;
    group.add(mesh);
  }
}

export class Helicopter {
  readonly root = new THREE.Group();
  /** Posisi kamera (di bawah perut heli, jadi bodinya tidak masuk frame). */
  readonly cameraPosition = new THREE.Vector3();
  /** Jarak mengelilingi fokus, meter. */
  orbitRadius = 32;
  /** Ketinggian jelajah di atas mobil, meter. */
  altitude = 26;
  /** Kecepatan putar mengelilingi fokus, rad/detik. */
  orbitSpeed = 0.16;

  private readonly rotor = new THREE.Group();
  private readonly tailRotor = new THREE.Group();
  private readonly body = new THREE.Group();
  private readonly beacons: THREE.Mesh[] = [];
  /** Titik lensa di gimbal dagu (lokal ke badan), jadi kamera ikut mengangguk. */
  private readonly gimbalLocal = new THREE.Vector3(0, -0.72, 1.95);
  private readonly target = new THREE.Vector3();
  private readonly lastPos = new THREE.Vector3();
  private readonly velocity = new THREE.Vector3();
  private orbitAngle = 0;
  private spin = 0;
  private yaw = 0;

  constructor() {
    const paint = surface({ color: PAINT });
    const paintDark = surface({ color: PAINT_DARK });
    const metal = surface({ color: METAL });
    const trim = surface({ color: TRIM });
    const glass = surface({
      color: GLASS,
      emissive: 0x0d2b3a,
      emissiveIntensity: 0.45,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
    });
    const blur = surface({
      color: 0x1b2026,
      transparent: true,
      opacity: 0.12,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const rotorBlur = surface({
      color: 0x20262c,
      transparent: true,
      opacity: 0.12,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const beaconMat = surface({ color: 0x7a0f0a, emissive: 0xff2a15, emissiveIntensity: 2 });

    /* ---------- badan (lathe) ---------- */
    const latheOf = (profile: Array<[number, number]>, grow = 0) =>
      new THREE.LatheGeometry(
        profile.map(([z, r]) => new THREE.Vector2(Math.max(0.0001, r + grow), z)),
        20,
      );

    const shell = new THREE.Mesh(latheOf(BODY_PROFILE), paint);
    shell.rotation.x = Math.PI / 2;
    shell.scale.set(1.06, 0.94, 1);
    shell.castShadow = true;
    this.body.add(shell);

    // Kaca depan: bagian ATAS hidung saja (dagunya tetap bercat), dibungkus
    // setengah lingkaran — persis wind-screen heli beneran.
    const noseProfile = BODY_PROFILE.filter(([z]) => z >= GLASS_FROM).map(
      ([z, r]) => [z, Math.max(0.0001, r + 0.014)] as [number, number],
    );
    const windshield = new THREE.Mesh(
      new THREE.LatheGeometry(
        noseProfile.map(([z, r]) => new THREE.Vector2(r, z)),
        16,
        Math.PI / 2 - 0.34,
        Math.PI + 0.68,
      ),
      glass,
    );
    windshield.rotation.x = Math.PI / 2;
    windshield.scale.set(1.06, 0.94, 1);
    windshield.renderOrder = 3;
    this.body.add(windshield);

    // kaca samping (satu kiri, satu kanan) di kabin
    for (const theta of [Math.PI / 2, -Math.PI / 2]) {
      const side = new THREE.Mesh(
        new THREE.CylinderGeometry(1.014, 1.014, 0.92, 10, 1, true, theta - 0.52, 1.04),
        glass,
      );
      side.rotation.x = Math.PI / 2;
      side.scale.set(1.06, 1, 0.94);
      side.position.z = -0.1;
      side.renderOrder = 3;
      this.body.add(side);
    }

    // rangka gelap di sambungan kaca (bikin kanopi terbaca sebagai jendela)
    const frame = new THREE.Mesh(
      new THREE.CylinderGeometry(1.04, 1.04, 0.12, 20, 1, true),
      metal,
    );
    frame.rotation.x = Math.PI / 2;
    frame.scale.set(1.06, 1, 0.94);
    frame.position.z = GLASS_FROM - 0.02;
    this.body.add(frame);

    // perut putih (dua warna khas mobil/heli balap) — hanya bagian bawah badan
    const belly = new THREE.Mesh(
      new THREE.LatheGeometry(
        BODY_PROFILE.filter(([z]) => z > -1.75 && z < 1.9).map(
          ([z, r]) => new THREE.Vector2(Math.max(0.0001, r + 0.008), z),
        ),
        16,
        -Math.PI * 0.3,
        Math.PI * 0.6,
      ),
      trim,
    );
    belly.rotation.x = Math.PI / 2;
    belly.scale.set(1.06, 0.94, 1);
    this.body.add(belly);

    // garis livery putih mengelilingi badan (di bagian yang lurus)
    const stripe = new THREE.Mesh(
      new THREE.CylinderGeometry(1.012, 1.012, 0.34, 20, 1, true),
      trim,
    );
    stripe.rotation.x = Math.PI / 2;
    stripe.scale.set(1.06, 1, 0.94);
    stripe.position.z = -1.06;
    this.body.add(stripe);

    /* ---------- boom + ekor ---------- */
    const boomProfile: Array<[number, number]> = [
      [-1.0, 0.34],
      [-2.4, 0.26],
      [-3.6, 0.19],
      [-4.8, 0.13],
      [-5.15, 0.1],
    ];
    const boom = new THREE.Mesh(latheOf(boomProfile), paint);
    boom.rotation.x = Math.PI / 2;
    boom.position.y = 0.22;
    this.body.add(boom);

    // sirip ekor bersayap
    const finShape = new THREE.Shape();
    finShape.moveTo(0.5, 0);
    finShape.lineTo(-0.55, 0);
    finShape.lineTo(-0.5, 1.25);
    finShape.lineTo(0.02, 1.2);
    finShape.lineTo(0.5, 0);
    const fin = new THREE.Mesh(
      new THREE.ExtrudeGeometry(finShape, { depth: 0.12, bevelEnabled: false }),
      paint,
    );
    fin.rotation.y = Math.PI / 2;
    fin.position.set(0.06, 0.24, -4.6);
    this.body.add(fin);

    // sayap kecil penstabil
    const stab = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.07, 0.42), paint);
    stab.position.set(0, 0.28, -4.25);
    this.body.add(stab);

    // cincin putih di boom + garis panel pintu
    const boomRing = new THREE.Mesh(
      new THREE.CylinderGeometry(0.29, 0.29, 0.28, 14, 1, true),
      trim,
    );
    boomRing.rotation.x = Math.PI / 2;
    boomRing.position.set(0, 0.22, -2.35);
    this.body.add(boomRing);


    // rotor ekor di samping sirip + cakram kabur
    for (const angle of [0, Math.PI / 2]) {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.07, 1.5, 0.19), metal);
      blade.rotation.x = angle;
      this.tailRotor.add(blade);
    }
    const tailDisc = new THREE.Mesh(new THREE.CircleGeometry(0.66, 18), blur);
    tailDisc.rotation.y = Math.PI / 2;
    this.tailRotor.add(tailDisc);
    this.tailRotor.position.set(0.22, 0.75, -4.68);
    this.root.add(this.tailRotor);

    /* ---------- dek mesin, knalpot, intake ---------- */
    const deck = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.46, 1.5), paintDark);
    deck.position.set(0, 0.86, -0.7);
    deck.castShadow = true;
    this.body.add(deck);

    const deckTop = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.24, 1.1), paint);
    deckTop.position.set(0, 1.13, -0.55);
    this.body.add(deckTop);

    const exhaust = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.17, 0.62, 8), metal);
    exhaust.rotation.set(Math.PI / 2 - 0.35, 0, 0);
    exhaust.position.set(0.34, 0.96, -1.45);
    this.body.add(exhaust);

    const intake = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, 0.16), metal);
    intake.position.set(0, 0.98, 0.16);
    this.body.add(intake);

    /* ---------- skid ---------- */
    const skidMat = metal;
    for (const side of [-1, 1]) {
      const runner = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 2.5, 8), skidMat);
      runner.rotation.x = Math.PI / 2;
      runner.position.set(side * 0.9, -1.36, 0.35);
      this.body.add(runner);

      // ujung depan melengkung ke atas
      const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.55, 8), skidMat);
      tip.rotation.set(Math.PI / 2 - 0.5, 0, 0);
      tip.position.set(side * 0.9, -1.25, 1.5);
      this.body.add(tip);

      for (const z of [-0.5, 1.0]) {
        const cross = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.62, 6), skidMat);
        cross.rotation.z = Math.PI / 2;
        cross.position.set(side * 0.62, -1.18, z);
        this.body.add(cross);

        const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.62, 6), skidMat);
        strut.rotation.z = side * 0.42;
        strut.position.set(side * 0.72, -0.86, z);
        this.body.add(strut);
      }
    }

    /* ---------- detail kecil ---------- */
    // kamera gimbal di dagu (ini helikopter TV, jadi wajib ada)
    const gimbal = new THREE.Mesh(new THREE.SphereGeometry(0.21, 10, 8), metal);
    gimbal.position.set(0, -0.62, 1.55);
    this.body.add(gimbal);
    const lens = new THREE.Mesh(
      new THREE.CylinderGeometry(0.13, 0.15, 0.2, 10),
      surface({ color: 0x0d1218, emissive: 0x0a1a24, emissiveIntensity: 0.6 }),
    );
    lens.rotation.x = Math.PI / 2;
    lens.position.set(0, -0.66, 1.72);
    this.body.add(lens);

    // lampu anti-tabrakan (merah, berkedip) di sirip + perut
    for (const [x, y, z] of [
      [0, 1.36, -4.5],
      [0, -1.02, 0.1],
    ] as Array<[number, number, number]>) {
      const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), beaconMat);
      beacon.position.set(x, y, z);
      this.beacons.push(beacon);
      this.body.add(beacon);
    }

    // antena ramping di perut
    const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.5, 5), metal);
    antenna.position.set(0.35, -1.02, -0.7);
    antenna.rotation.x = 0.35;
    this.body.add(antenna);

    this.root.add(this.body);

    /* ---------- rotor utama ---------- */
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.17, 0.62, 10), metal);
    mast.position.y = 1.32;
    this.root.add(mast);

    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.29, 0.33, 0.2, 10), metal);
    hub.position.y = 1.66;
    this.root.add(hub);

    const bladeGeo = new THREE.BoxGeometry(7.6, 0.09, 0.42);
    for (const angle of [0, Math.PI / 2]) {
      const blade = new THREE.Mesh(bladeGeo, metal);
      blade.rotation.y = angle;
      blade.castShadow = true;
      this.rotor.add(blade);
    }
    const disc = new THREE.Mesh(new THREE.CircleGeometry(3.8, 28), rotorBlur);
    disc.rotation.x = -Math.PI / 2;
    this.rotor.add(disc);
    this.rotor.position.y = 1.66;
    this.root.add(this.rotor);

    // Bagian diam digabung per material: ~30 mesh jadi ~7 draw call, tanpa
    // mengorbankan rotor yang berputar.
    mergeByMaterial(this.body);

    this.root.name = 'helicopter';
    this.root.updateMatrixWorld(true);
    this.cameraPosition.copy(this.gimbalLocal);
    this.body.localToWorld(this.cameraPosition);
  }

  /** Titik fokus awal (supaya heli tidak terbang dari titik nol). */
  place(focus: THREE.Vector3): void {
    this.orbitAngle = Math.atan2(focus.z, focus.x);
    this.pos(focus, 1);
    this.lastPos.copy(this.root.position);
    this.lensPosition();
  }

  /**
   * Satu langkah. `focus` = mobil yang disorot; heli berputar pelan
   * mengelilinginya dan selalu menghadap arah terbangnya.
   */
  update(dt: number, focus: THREE.Vector3): void {
    this.orbitAngle += dt * this.orbitSpeed;
    this.pos(focus, 1 - Math.exp(-1.3 * dt));

    // Kecepatan mendatar → arah hidung + kemiringan.
    if (dt > 0) {
      this.velocity.subVectors(this.root.position, this.lastPos).divideScalar(dt);
    }
    this.lastPos.copy(this.root.position);
    const horizSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    if (horizSpeed > 0.4) {
      const want = Math.atan2(this.velocity.x, this.velocity.z);
      const delta = Math.atan2(Math.sin(want - this.yaw), Math.cos(want - this.yaw));
      this.yaw += delta * Math.min(1, dt * 3);
    }
    this.root.rotation.set(0, this.yaw, 0);
    this.spin += dt;
    // Miring ke depan saat melaju + sedikit roll ke dalam putaran.
    this.body.rotation.x = THREE.MathUtils.clamp(horizSpeed * 0.03, 0, 0.16);
    this.body.rotation.z = -0.1;
    this.body.position.y = Math.sin(this.spin * 1.6) * 0.09;

    this.rotor.rotation.y = this.spin * 26;
    this.tailRotor.rotation.x = this.spin * 41;

    // Lampu anti-tabrakan: kedip 1×/detik.
    const blink = Math.sin(this.spin * Math.PI * 2) > 0.55 ? 2.4 : 0.05;
    for (const beacon of this.beacons) {
      (beacon.material as THREE.MeshStandardMaterial).emissiveIntensity = blink;
    }

    this.lensPosition();
  }

  /** Lensa = gimbal di dagu, ikut rotasi badan. */
  private lensPosition(): void {
    this.root.updateMatrixWorld(true);
    this.cameraPosition.copy(this.gimbalLocal);
    this.body.localToWorld(this.cameraPosition);
  }

  private pos(focus: THREE.Vector3, k: number): void {
    this.target.set(
      focus.x + Math.cos(this.orbitAngle) * this.orbitRadius,
      Math.max(6, focus.y) + this.altitude,
      focus.z + Math.sin(this.orbitAngle) * this.orbitRadius,
    );
    if (k >= 1) this.root.position.copy(this.target);
    else this.root.position.lerp(this.target, k);
  }
}
