const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/**
 * Kerusakan mobil: bodi penyok, ban pecah, ban copot, dan mesin mati.
 *
 * Semuanya murni angka — tidak menyentuh DOM, tidak butuh three.js — jadi bisa
 * diuji headless (`scripts/smoke.ts`) dan hasilnya sama persis di browser.
 *
 * Sumber kerusakan cuma satu: **benturan**. `VehiclePhysics` mengukur perubahan
 * kecepatan mendadak tiap langkah fisika (Δv) dan mengirimnya ke sini dalam
 * kerangka mobil (x = kiri, y = atas, z = depan). Δv 2,6 m/s (≈ 9 km/h) ke atas
 * mulai merusak; mendarat dari lompatan tinggi dan menabrak pagar beton adalah
 * dua sumber terbesarnya.
 *
 * Efek yang dihasilkan:
 *
 * | Bagian   | Efek                                                      |
 * |----------|-----------------------------------------------------------|
 * | bodi     | 6 tingkat penyok (visual), tenaga mesin ikut turun        |
 * | mesin    | tenaga berkurang; habis = **tidak bisa maju sama sekali** |
 * | ban      | pecah: grip 38 %, tarikan ke samping, drag besar          |
 * | ban copot| grip 0 dan rodanya hilang dari visual                    |
 */
export type DamageEventKind = 'dent' | 'puncture' | 'wheel-off' | 'engine';

export interface DamageEvent {
  kind: DamageEventKind;
  /** 0..3 = FL, FR, RL, RR; -1 untuk bodi/mesin. */
  wheel: number;
}

export interface DamageOptions {
  /** Matikan untuk mobil yang tidak boleh rusak (uji/keperluan demo). */
  enabled: boolean;
  /** Pengali semua kerusakan: 0,5 = tahan banting, 2 = rapuh. */
  severity: number;
  /** Δv minimum (m/s) sebelum dihitung sebagai benturan. */
  threshold: number;
}

export const defaultDamageOptions: DamageOptions = {
  enabled: true,
  severity: 1,
  threshold: 2.6,
};

/** Satu roda. `health` 1 = utuh, 0 = copot. */
export interface WheelDamage {
  health: number;
  punctured: boolean;
  lost: boolean;
}

/** Seberapa kuat ban pecah mencengkeram (0..1 dari ban normal). */
const PUNCTURED_GRIP = 0.38;
/** Ambang health untuk pecah & copot. */
const PUNCTURE_AT = 0.45;
const LOST_AT = 0;
/** Di atas ini (Δv ≈ 16 m/s) satu roda langsung robek. */
const WHEEL_RIP_SEVERITY = 0.95;

export class VehicleDamage {
  readonly options: DamageOptions;
  readonly wheels: WheelDamage[] = [
    { health: 1, punctured: false, lost: false },
    { health: 1, punctured: false, lost: false },
    { health: 1, punctured: false, lost: false },
    { health: 1, punctured: false, lost: false },
  ];
  bodyHealth = 1;
  engineHealth = 1;
  engineDead = false;
  /** Kejadian yang belum dibaca (dipakai HUD & efek suara/asap). */
  readonly events: DamageEvent[] = [];
  /** Naik setiap ada perubahan — visual cuma memperbarui kalau angka ini beda. */
  revision = 0;

  constructor(options: Partial<DamageOptions> = {}) {
    this.options = { ...defaultDamageOptions, ...options };
  }

  /* ------------------------------------------------------------- queries */

  /** 1 = tenaga penuh, 0 = mesin mati. */
  get throttleScale(): number {
    if (this.engineDead) return 0;
    return clamp(0.42 + 0.58 * this.engineHealth, 0, 1);
  }

  /** Pengali batas kecepatan (mesin rusak tidak bisa tarik sampai ujung). */
  get topSpeedScale(): number {
    if (this.engineDead) return 0;
    return clamp(0.55 + 0.45 * this.engineHealth, 0, 1);
  }

  /** 1 = setir normal; turun kalau roda depan rusak/copot. */
  get steerScale(): number {
    let scale = 1;
    for (let i = 0; i < 2; i++) {
      const w = this.wheels[i];
      if (w.lost) scale *= 0.42;
      else if (w.punctured) scale *= 0.88;
    }
    return clamp(scale, 0.2, 1);
  }

  /** Tarikan setir ke satu sisi karena ban depan kempes (radian, + = kiri). */
  pullSteer(speed: number): number {
    const pull = (i: number) => (this.wheels[i].punctured && !this.wheels[i].lost ? 1 : 0);
    const bias = pull(0) - pull(1); // FL (+) menarik ke kiri, FR (−) ke kanan
    const factor = clamp(speed / 18, 0, 1);
    return bias * 0.045 * factor;
  }

  /** Grip per roda (0 = tidak ada ban). */
  wheelGrip(index: number): number {
    const w = this.wheels[index];
    if (!w) return 1;
    if (w.lost) return 0;
    if (w.punctured) return PUNCTURED_GRIP * clamp(0.5 + 0.5 * Math.max(w.health, 0) / PUNCTURE_AT, 0, 1);
    return 1;
  }

  /** Tahanan gelinding tambahan per roda (ban kempes: 1 = normal). */
  wheelDrag(index: number): number {
    const w = this.wheels[index];
    if (!w) return 1;
    return w.punctured ? 3.2 : 1;
  }

  get puncturedCount(): number {
    return this.wheels.filter((w) => w.punctured).length;
  }

  get lostCount(): number {
    return this.wheels.filter((w) => w.lost).length;
  }

  /** 0..1 — seberapa penyok bodinya (untuk visual). */
  get dentLevel(): number {
    return clamp(1 - this.bodyHealth, 0, 1);
  }

  /** Bisa jalan sama sekali? (mesin mati total ATAU semua roda copot) */
  get immobile(): boolean {
    return this.engineDead || this.lostCount >= 4;
  }

  /** Ambil dan bersihkan antrean kejadian. */
  drainEvents(): DamageEvent[] {
    if (!this.events.length) return [];
    const out = this.events.slice();
    this.events.length = 0;
    return out;
  }

  /* -------------------------------------------------------------- damage */

  /**
   * Satu benturan. `dx` = dorongan ke kiri, `dy` = ke atas, `dz` = ke depan
   * (semuanya m/s, kerangka mobil). Mengembalikan kerusakan ternormalisasi 0..1
   * supaya pemanggil bisa memberi efek (percikan, suara).
   */
  impact(dx: number, dy: number, dz: number): number {
    const o = this.options;
    if (!o.enabled) return 0;
    const mag = Math.hypot(dx, dy, dz);
    if (mag < o.threshold) return 0;

    // 0 di ambang, 1 di ~17 m/s, maksimum 1,4 untuk tabrakan mengerikan.
    const severity = clamp((mag - o.threshold) / 14, 0, 1.4) * o.severity;
    if (severity <= 0.001) return 0;

    const before = this.revision;
    this.bodyHealth = clamp(this.bodyHealth - severity * 0.42, 0, 1);
    if (severity > 0.08) this.events.push({ kind: 'dent', wheel: -1 });

    // Mesin paling menderita kalau benturannya dari depan/belakang.
    const frontal = Math.abs(dz) / Math.max(mag, 1e-3);
    this.engineHealth = clamp(this.engineHealth - severity * (0.16 + 0.4 * frontal), 0, 1);
    if (!this.engineDead && this.engineHealth <= 0) {
      this.engineDead = true;
      this.events.push({ kind: 'engine', wheel: -1 });
    }

    /* roda: sisi yang kena paling parah */
    const side = Math.abs(dx) > Math.abs(dy) * 0.75 ? Math.sign(dx) : 0;
    const frontalWheels = Math.abs(dz) > Math.abs(dy) * 0.5 ? (dz < 0 ? 'front' : 'rear') : 'all';
    const victims: number[] = [];
    for (let i = 0; i < 4; i++) {
      const isFront = i < 2;
      const isLeft = i % 2 === 0;
      if (side !== 0 && isLeft !== side > 0) continue; // hanya sisi yang kena
      if (side === 0 && frontalWheels !== 'all' && (frontalWheels === 'front') !== isFront) continue;
      victims.push(i);
    }
    const share = victims.length ? (victims.length === 1 ? 0.9 : victims.length === 2 ? 0.55 : 0.3) : 0;
    for (const i of victims) {
      const w = this.wheels[i];
      if (w.lost) continue;
      w.health = clamp(w.health - severity * share, -0.5, 1);
      if (!w.punctured && w.health <= PUNCTURE_AT) {
        w.punctured = true;
        this.events.push({ kind: 'puncture', wheel: i });
      }
      if (!w.lost && w.health <= LOST_AT) {
        w.lost = true;
        w.punctured = false;
        this.events.push({ kind: 'wheel-off', wheel: i });
      }
    }

    // BENTURAN SANGAT KERAS (Δv ≈ 60 km/h ke atas) merobek roda yang paling
    // parah: satu tabrakan besar sudah cukup mencopot ban, tidak perlu dua.
    if (severity >= WHEEL_RIP_SEVERITY) {
      let worst = -1;
      for (const i of victims) {
        if (this.wheels[i].lost) continue;
        if (worst < 0 || this.wheels[i].health < this.wheels[worst].health) worst = i;
      }
      if (worst >= 0) {
        const w = this.wheels[worst];
        w.lost = true;
        w.punctured = false;
        w.health = 0;
        this.events.push({ kind: 'wheel-off', wheel: worst });
      }
    }

    if (this.revision === before) this.revision++;
    return clamp(severity, 0, 1);
  }

  /** Perbaiki semuanya (reset mobil / tombol *perbaiki* di panel). */
  reset() {
    this.bodyHealth = 1;
    this.engineHealth = 1;
    this.engineDead = false;
    this.events.length = 0;
    for (const w of this.wheels) {
      w.health = 1;
      w.punctured = false;
      w.lost = false;
    }
    this.revision++;
  }
}
