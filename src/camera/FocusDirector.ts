import * as THREE from 'three';

/** Satu mobil yang bisa jadi sasaran kamera. */
export interface FocusSubject {
  position: THREE.Vector3;
  /** Odometer balapan (meter, tidak pernah turun) — dasar penentuan pemimpin. */
  odometer: number;
  /** Jarak di dalam lap (meter) — dipakai sutradara kamera TV. */
  lapDistance: number;
}

export interface FocusSetup {
  /** Mobil pemain. */
  player: () => FocusSubject;
  /** Semua lawan yang masih balapan (yang parkir jangan dimasukkan). */
  rivals: () => FocusSubject[];
  /** true = kamera mengikuti pemimpin balapan; false = selalu pemain. */
  spectate: () => boolean;
}

/** Keunggulan minimum (meter) sebelum kamera boleh pindah mobil. */
const LEAD_MARGIN = 12;
/** Lawan dalam radius ini ikut masuk frame (duel), meter. */
const DUEL_RADIUS = 16;
/** Pergeseran bidikan maksimum ke arah lawan saat duel, meter. */
const DUEL_SHIFT = 1.6;
/** Pelunakan posisi bidik (1/detik). */
const FOLLOW_RATE = 15;
/** Pelunakan pergeseran duel (1/detik) — jauh lebih lambat, biar tidak goyang. */
const DUEL_RATE = 2.5;
/** Lompatan sebesar ini berarti target berganti: bidikan dipotong, bukan ditarik. */
const SNAP_JUMP = 40;

const tmp = new THREE.Vector3();

/**
 * Menentukan **satu** mobil yang dibidik kamera (TV, heli, bayangan).
 *
 * Dulu bidikannya adalah campuran posisi semua mobil yang berdekatan, jadi
 * begitu ada dua mobil di trek kamera tidak tahu harus membidik yang mana:
 * titik bidiknya melompat antar mobil tiap frame dan gambar jadi bergetar.
 * Sekarang targetnya satu mobil, dipilih dengan histeresis, lalu dilunakkan —
 * lawan yang berdekatan hanya menggeser bidikan sedikit (maks. 1,6 m) supaya
 * duelnya tetap masuk frame.
 */
export class FocusDirector {
  /** Titik yang dibidik kamera (sudah dilunakkan). */
  readonly focus = new THREE.Vector3();
  /** Jarak lap mobil yang dibidik (untuk memilih kamera TV). */
  distance = 0;
  /** Indeks lawan yang dibidik, atau -1 kalau pemain. */
  targetIndex = -1;
  /** Sedang ada lawan sangat dekat yang ikut diframe? */
  duel = false;
  /** True kalau bidikan baru saja dipotong (target berganti). */
  cut = false;

  private readonly desired = new THREE.Vector3();
  private readonly shift = new THREE.Vector3();
  private ready = false;

  constructor(private readonly setup: FocusSetup) {}

  /** Lompatkan bidikan ke target sekarang tanpa pelunakan (mis. setelah reset). */
  snap() {
    this.ready = false;
  }

  update(dt: number) {
    const player = this.setup.player();
    const rivals = this.setup.rivals();
    const spectate = this.setup.spectate();

    // 1. Pilih satu mobil. Tanpa mode siaran selalu pemain; dengan mode siaran
    //    pemimpin, tapi harus unggul jelas supaya dua mobil bersisian tidak
    //    membuat kamera gonta-ganti.
    let index = -1;
    let bestOdo = player.odometer;
    if (spectate) {
      const currentIndex = this.ready ? this.targetIndex : -1;
      const currentOdo =
        currentIndex >= 0 && rivals[currentIndex] ? rivals[currentIndex].odometer : player.odometer;
      index = currentIndex;
      bestOdo = currentOdo;
      for (let i = 0; i < rivals.length; i++) {
        if (i === index) continue;
        if (rivals[i].odometer > bestOdo + LEAD_MARGIN) {
          bestOdo = rivals[i].odometer;
          index = i;
        }
      }
      if (index !== -1 && player.odometer > bestOdo + LEAD_MARGIN) {
        index = -1;
        bestOdo = player.odometer;
      }
    }
    this.targetIndex = index;
    const target = index >= 0 && rivals[index] ? rivals[index] : player;
    this.distance = target.lapDistance;

    // 2. Titik bidik: mobil yang diikuti, sedikit di atas atap.
    this.desired.copy(target.position);
    this.desired.y += 0.9;

    // 3. Duel: lawan yang sangat dekat hanya menggeser bidikan sedikit ke arah
    //    tengah keduanya — dibatasi dan dilunakkan, jadi tidak pernah melompat.
    let partner: FocusSubject | null = null;
    let partnerDist = DUEL_RADIUS;
    for (let i = 0; i < rivals.length; i++) {
      if (i === index) continue;
      const other = rivals[i];
      const d = Math.hypot(
        other.position.x - target.position.x,
        other.position.z - target.position.z,
      );
      if (d < partnerDist) {
        partnerDist = d;
        partner = other;
      }
    }
    if (partner) {
      tmp.subVectors(partner.position, target.position);
      tmp.y = 0;
      const len = tmp.length();
      const strength = 1 - partnerDist / DUEL_RADIUS;
      if (len > 0.01) tmp.multiplyScalar((DUEL_SHIFT * strength) / len);
      else tmp.set(0, 0, 0);
    } else {
      tmp.set(0, 0, 0);
    }
    this.shift.lerp(tmp, 1 - Math.exp(-DUEL_RATE * dt));
    this.desired.add(this.shift);
    this.duel = this.shift.lengthSq() > 0.04;

    // 4. Pelunakan. Target berganti jauh = potong gambar, bukan ditarik.
    this.cut = false;
    if (!this.ready || this.focus.distanceToSquared(this.desired) > SNAP_JUMP * SNAP_JUMP) {
      this.focus.copy(this.desired);
      this.shift.set(0, 0, 0);
      this.cut = this.ready;
      this.ready = true;
    } else {
      this.focus.lerp(this.desired, 1 - Math.exp(-FOLLOW_RATE * dt));
    }
  }
}
