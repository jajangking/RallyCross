import { defaultStorage, type RecordStorage } from './Standings';

/**
 * "Nalar" lawan AI yang **naik tiap balapan**.
 *
 * Setiap lawan punya satu angka kemampuan 0..1 yang disimpan di `localStorage`
 * (jadi bertahan antar sesi). Angka itu diterjemahkan jadi setelan `AutoPilot`:
 * tempo, asumsi grip, dan titik rem. Makin tinggi, makin cepat — dan karena
 * nilainya naik setiap kali mereka menyelesaikan balapan atau mencatat lap
 * terbaik pribadi, **rekor lap di papan rekor terus turun seiring waktu**,
 * tanpa pernah melewati batas aman (pace maksimum 1,005; di atas itu AI mulai
 * keluar trek, sudah diuji).
 *
 * Semua fungsi di sini murni angka + `Storage` opsional, jadi bisa diuji
 * headless (`scripts/smoke.ts`).
 */

const KEY = 'rallycross.aiSkill.v1';

export interface SkillTuning {
  /** Pengali target kecepatan untuk `AutoPilot`. */
  pace: number;
  /** Asumsi percepatan lateral, m/s². */
  gripTarmac: number;
  /** Asumsi perlambatan, m/s². */
  brakeTarmac: number;
  /**
   * 0..1: seberapa jauh dia sudah "belajar garis". 0 = lajur bawaan di grid,
   * 1 = hampir di garis tercepat (geseran tinggal 25 %).
   */
  laneTighten: number;
}

export interface RivalSkill {
  /** 0 (pemula) .. 1 (secepat yang AI boleh). */
  value: number;
  /** Balapan yang sudah diselesaikan. */
  races: number;
  /** Lap terbaik pribadi (detik), `Infinity` kalau belum ada. */
  best: number;
}

/**
 * Hasil uji putaran (headless, 1 lap dari start berdiri):
 *
 * | pace | grip | rem  | waktu  |
 * |------|------|------|--------|
 * | 0,95 | 8,60 | 8,00 | 29,78 s |
 * | 0,97 | 8,80 | 8,20 | 29,37 s |
 * | 0,99 | 8,90 | 8,30 | 29,30 s |
 * | 1,00 | 9,00 | 8,40 | 28,90 s |
 * | 1,00 | 9,15 | 8,55 | 29,25 s |
 * | 1,00 | 9,30 | 8,70 | 32,80 s |
 *
 * Jadi pace naik dan grip/rem **hanya sampai batas nyata mobil** (9,0 / 8,4):
 * di atas itu perencana menaksir grip terlalu tinggi, mobil melebar, dan
 * putarannya justru lebih lambat. Batas atas pace 1,0 (bukan 1,03) karena di
 * atas 1,0 AI mulai masuk tikungan terlalu cepat.
 */
const PACE_MIN = 0.95;
const PACE_SPAN = 0.05;

/** Kemampuan 0..1 → setelan pilot. Monoton: makin besar makin cepat. */
export function tuningFor(value: number): SkillTuning {
  const v = Math.min(1, Math.max(0, value));
  return {
    pace: PACE_MIN + PACE_SPAN * v,
    gripTarmac: 8.6 + 0.4 * v,
    brakeTarmac: 8.0 + 0.4 * v,
    laneTighten: v,
  };
}

/** Kebalikan `tuningFor`: pace lawan di `grid.ts` → kemampuan awal. */
export function skillForPace(pace: number): number {
  return Math.min(1, Math.max(0, (pace - PACE_MIN) / PACE_SPAN));
}

/** Sisa geseran lajur pada nalar tertentu (1 = belum belajar garis). */
export function laneScaleFor(value: number): number {
  const v = Math.min(1, Math.max(0, value));
  return 1 - 0.75 * v;
}

export class AiSkills {
  private readonly map = new Map<string, RivalSkill>();

  constructor(
    private readonly storage: RecordStorage = defaultStorage(),
    /** Kemampuan awal per nama (dipakai untuk lawan yang belum punya data). */
    seed: Readonly<Record<string, number>> = {},
  ) {
    this.load();
    for (const [name, value] of Object.entries(seed)) this.ensure(name, value);
  }

  /** Data satu lawan (dibuat kalau belum ada). */
  get(name: string): RivalSkill {
    return this.ensure(name, 0.5);
  }

  skillOf(name: string): number {
    return this.get(name).value;
  }

  tuning(name: string): SkillTuning {
    return tuningFor(this.get(name).value);
  }

  /** Rata-rata kemampuan semua lawan yang dikenal (0..1) — untuk HUD. */
  get average(): number {
    let sum = 0;
    let count = 0;
    for (const skill of this.map.values()) {
      sum += skill.value;
      count++;
    }
    return count ? sum / count : 0;
  }

  get count(): number {
    return this.map.size;
  }

  /** Total balapan yang sudah diselesaikan semua lawan. */
  get totalRaces(): number {
    let sum = 0;
    for (const skill of this.map.values()) sum += skill.races;
    return sum;
  }

  /**
   * Catat lap. Lap terbaik pribadi menaikkan kemampuan (belajar dari lap
   * sendiri). Mengembalikan true kalau itu rekor pribadi.
   */
  submitLap(name: string, seconds: number): boolean {
    if (!Number.isFinite(seconds) || seconds <= 0) return false;
    const skill = this.get(name);
    if (seconds >= skill.best - 0.0005) return false;
    skill.best = seconds;
    this.grow(skill, 0.05);
    this.save();
    return true;
  }

  /** Selesai balapan: pengalaman nambah, semua yang finis jadi sedikit lebih baik. */
  finishRace(names: readonly string[]): void {
    for (const name of names) {
      const skill = this.get(name);
      skill.races++;
      this.grow(skill, 0.06);
    }
    this.save();
  }

  /** Naik dengan hasil yang mengecil: 0,5 → 0,7 → 0,84 → ... maksimum 1. */
  private grow(skill: RivalSkill, rate: number): void {
    skill.value = Math.min(1, skill.value + (1 - skill.value) * rate);
  }

  private ensure(name: string, initial: number): RivalSkill {
    let skill = this.map.get(name);
    if (!skill) {
      skill = { value: Math.min(1, Math.max(0, initial)), races: 0, best: Infinity };
      this.map.set(name, skill);
    }
    return skill;
  }

  private load(): void {
    try {
      const raw = this.storage?.getItem(KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, { value?: number; races?: number; best?: number }>;
      for (const [name, entry] of Object.entries(parsed)) {
        if (!entry || typeof entry.value !== 'number') continue;
        this.map.set(name, {
          value: Math.min(1, Math.max(0, entry.value)),
          races: typeof entry.races === 'number' && entry.races >= 0 ? entry.races : 0,
          best: typeof entry.best === 'number' && entry.best > 0 ? entry.best : Infinity,
        });
      }
    } catch {
      // Data rusak / storage diblokir: mulai dari seed saja.
    }
  }

  save(): void {
    try {
      const out: Record<string, { value: number; races: number; best: number }> = {};
      for (const [name, skill] of this.map) {
        out[name] = {
          value: Number(skill.value.toFixed(4)),
          races: skill.races,
          best: Number.isFinite(skill.best) ? Number(skill.best.toFixed(3)) : 0,
        };
      }
      this.storage?.setItem(KEY, JSON.stringify(out));
    } catch {
      // Mode privat / kuota penuh: kemampuan tetap hidup di memori.
    }
  }
}
