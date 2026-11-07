/**
 * Papan klasemen + rekor lap.
 *
 * Semua angka datang dari `LapCounter` tiap mobil (`lap` + `odometer`), jadi
 * urutannya tidak bergantung pada renderer dan bisa diuji headless.
 */
export interface StandingsCar {
  name: string;
  /** Warna cat, dipakai HUD. */
  color: number;
  /** Putaran yang sudah selesai. */
  lap: number;
  /** Meter sejak garis start/finish (bisa negatif sebelum garis). */
  odometer: number;
  bestLap: number;
  isPlayer?: boolean;
  /** Total putaran balapan; mobil yang sudah menempuhnya dianggap finis. */
  laps: number;
}

export interface StandingsRow extends StandingsCar {
  /** 1..n */
  position: number;
  /** Selisih jarak ke mobil di depan, meter (0 untuk pemimpin). */
  gap: number;
  finished: boolean;
}

/**
 * Urutkan mobil: yang sudah finis dulu, lalu putaran terbanyak, lalu odometer.
 * Odometernya sendiri tidak pernah wrap (bisa negatif di belakang garis), jadi
 * perbandingan sederhana ini sudah benar untuk semua fase balapan.
 */
export function standings(cars: readonly StandingsCar[]): StandingsRow[] {
  const sorted = cars
    .map((car, index) => ({ car, index, finished: car.laps > 0 && car.lap >= car.laps }))
    .sort((a, b) => {
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.car.lap !== b.car.lap) return b.car.lap - a.car.lap;
      if (a.car.odometer !== b.car.odometer) return b.car.odometer - a.car.odometer;
      return a.index - b.index;
    });

  const rows: StandingsRow[] = [];
  // Odometer tidak pernah wrap, jadi selisihnya langsung "meter di belakang
  // pemimpin" — termasuk selisih satu putaran lebih.
  const leader = sorted[0]?.car.odometer ?? 0;
  for (let i = 0; i < sorted.length; i++) {
    const entry = sorted[i];
    rows.push({
      ...entry.car,
      position: i + 1,
      gap: i === 0 ? 0 : Math.max(0, leader - entry.car.odometer),
      finished: entry.finished,
    });
  }
  return rows;
}

/** Penyimpanan opsional (localStorage di browser, null saat headless). */
export type RecordStorage = Pick<Storage, 'getItem' | 'setItem'> | null;

const KEY = 'rallycross.recordLap.v1';

/**
 * Rekor lap tercepat lintas mobil (dan lintas sesi, kalau ada localStorage).
 * `submit()` mengembalikan true saat ada yang memecahkan rekor — HUD memakainya
 * untuk memunculkan spanduk "REKOR BARU".
 */
export class LapRecords {
  /** Detik; `Infinity` sebelum ada lap yang selesai. */
  best = Infinity;
  /** Nama pemegang rekor. */
  holder = '';

  constructor(private readonly storage: RecordStorage = defaultStorage()) {
    this.load();
  }

  /** Catat waktu lap; true kalau rekor sebelumnya dipecahkan. */
  submit(seconds: number, by: string): boolean {
    if (!Number.isFinite(seconds) || seconds <= 0) return false;
    if (seconds >= this.best - 0.001) return false;
    this.best = seconds;
    this.holder = by;
    this.save();
    return true;
  }

  get hasRecord(): boolean {
    return Number.isFinite(this.best);
  }

  private load() {
    try {
      const raw = this.storage?.getItem(KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { best?: number; holder?: string };
      if (typeof parsed.best === 'number' && parsed.best > 0) {
        this.best = parsed.best;
        this.holder = typeof parsed.holder === 'string' ? parsed.holder : '';
      }
    } catch {
      // Data rusak / storage diblokir: mulai dari nol lagi, jangan sampai crash.
    }
  }

  private save() {
    try {
      this.storage?.setItem(KEY, JSON.stringify({ best: this.best, holder: this.holder }));
    } catch {
      // Mode privat / kuota penuh: rekor tetap hidup di memori.
    }
  }
}

/** Storage yang aman dipakai (null kalau tidak ada / diblokir). */
export function defaultStorage(): RecordStorage {
  try {
    if (typeof localStorage === 'undefined') return null;
    // Sentuh sekali: Safari mode privat melempar error saat ditulis.
    localStorage.getItem(KEY);
    return localStorage;
  } catch {
    return null;
  }
}
