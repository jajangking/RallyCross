import * as THREE from 'three';
import { toon } from './style';

/**
 * Helikopter siaran: kamera udara yang terbang mengelilingi mobil yang sedang
 * disorot.
 *
 * Modelnya sengaja rendah poligon (gaya kartun): badan pod, ekor, dua skid,
 * rotor utama dan rotor ekor. Tidak menyentuh DOM, jadi bisa diuji di Node.
 *
 * Gerak: helikopter berputar pelan mengelilingi titik fokus pada ketinggian
 * tetap, dengan posisi yang dilarutkan — persis seperti helikopter TV yang
 * menjaga jarak aman, bukan menempel di bumper mobil.
 */
export class Helicopter {
  readonly root = new THREE.Group();
  /** Posisi kamera (di bawah perut heli, jadi bodinya tidak masuk frame). */
  readonly cameraPosition = new THREE.Vector3();
  /** Jarak mengelilingi fokus, meter. */
  orbitRadius = 26;
  /** Ketinggian jelajah di atas mobil, meter. */
  altitude = 34;
  /** Kecepatan putar mengelilingi fokus, rad/detik. */
  orbitSpeed = 0.22;

  private readonly rotor = new THREE.Group();
  private readonly tailRotor = new THREE.Group();
  private readonly body = new THREE.Group();
  private readonly target = new THREE.Vector3();
  private readonly lastPos = new THREE.Vector3();
  private readonly velocity = new THREE.Vector3();
  private orbitAngle = 0;
  private spin = 0;
  private yaw = 0;

  constructor() {
    const paint = toon({ color: 0xe8452f });
    const dark = toon({ color: 0x22262b });
    const glass = toon({
      color: 0x9fd8f0,
      transparent: true,
      opacity: 0.72,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const trim = toon({ color: 0xf4f6f8 });

    /* ---------- badan ---------- */
    const pod = new THREE.Mesh(new THREE.SphereGeometry(1.25, 12, 9), paint);
    pod.scale.set(1, 0.92, 1.75);
    this.body.add(pod);

    const cockpit = new THREE.Mesh(new THREE.SphereGeometry(1.06, 12, 8), glass);
    cockpit.scale.set(0.92, 0.82, 1.05);
    cockpit.position.set(0, 0.18, 1.25);
    this.body.add(cockpit);

    const stripe = new THREE.Mesh(new THREE.BoxGeometry(2.34, 0.22, 3.1), trim);
    stripe.position.set(0, -0.35, 0.1);
    this.body.add(stripe);

    // ekor
    const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.42, 3.2, 8), paint);
    boom.rotation.x = Math.PI / 2;
    boom.position.set(0, 0.18, -3.1);
    this.body.add(boom);

    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.0, 0.8), paint);
    fin.position.set(0, 0.85, -4.5);
    this.body.add(fin);

    // skid (dua batang + penyangga)
    for (const side of [-1, 1]) {
      const skid = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.13, 2.9), dark);
      skid.position.set(side * 0.78, -1.15, 0.15);
      this.body.add(skid);
      for (const z of [-0.7, 1.0]) {
        const strut = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.72, 0.1), dark);
        strut.position.set(side * 0.62, -0.78, z);
        this.body.add(strut);
      }
    }

    /* ---------- rotor utama ---------- */
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.36, 8), dark);
    hub.position.y = 1.15;
    this.root.add(hub);

    const bladeGeo = new THREE.BoxGeometry(9.4, 0.07, 0.46);
    for (const angle of [0, Math.PI / 2]) {
      const blade = new THREE.Mesh(bladeGeo, dark);
      blade.rotation.y = angle;
      this.rotor.add(blade);
    }
    this.rotor.position.y = 1.15;
    this.root.add(this.rotor);

    // rotor ekor: dua bilah kecil, diputar
    for (const angle of [0, Math.PI / 2]) {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.07, 1.5, 0.2), dark);
      blade.rotation.z = angle;
      this.tailRotor.add(blade);
    }
    this.tailRotor.position.set(0.26, 0.85, -4.55);
    this.root.add(this.tailRotor);

    this.root.add(this.body);
    this.root.name = 'helicopter';
    this.cameraPosition.set(0, 40, 0);
  }

  /** Titik fokus awal (supaya heli tidak terbang dari titik nol). */
  place(focus: THREE.Vector3): void {
    this.orbitAngle = Math.atan2(focus.z, focus.x);
    this.pos(focus, 1);
    this.lastPos.copy(this.root.position);
  }

  /**
   * Satu langkah. `focus` = mobil yang disorot; heli berputar pelan
   * mengelilinginya dan selalu menghadap arah terbangnya.
   */
  update(dt: number, focus: THREE.Vector3): void {
    this.orbitAngle += dt * this.orbitSpeed;
    this.pos(focus, 1 - Math.exp(-1.4 * dt));

    // Kecepatan mendatar → arah hidung + kemiringan.
    if (dt > 0) {
      this.velocity.subVectors(this.root.position, this.lastPos).divideScalar(dt);
    }
    this.lastPos.copy(this.root.position);
    const horizSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    if (horizSpeed > 0.4) {
      const want = Math.atan2(this.velocity.x, this.velocity.z);
      // Hadapkan ke arah terbang; lerp pendek supaya tidak berkedip.
      const delta = Math.atan2(Math.sin(want - this.yaw), Math.cos(want - this.yaw));
      this.yaw += delta * Math.min(1, dt * 3);
    }
    this.root.rotation.set(0, this.yaw, 0);
    // Miring ke depan saat melaju + sedikit roll ke dalam putaran.
    this.body.rotation.x = THREE.MathUtils.clamp(horizSpeed * 0.03, 0, 0.16);
    this.body.rotation.z = -0.12;

    // Rotor berputar cepat; bilah dibuat "kabur" dengan kecepatan tinggi.
    this.spin += dt;
    this.rotor.rotation.y = this.spin * 34;
    this.tailRotor.rotation.x = this.spin * 46;

    // Kamera di bawah perut, sedikit ke depan.
    this.cameraPosition.copy(this.root.position);
    this.cameraPosition.y -= 1.6;
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
