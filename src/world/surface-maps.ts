/**
 * Peta permukaan trek — aspal, gravel, kerban, dan bahu rumput — dihitung
 * langsung ke buffer piksel, bukan digambar dengan canvas.
 *
 * Kenapa tidak pakai canvas seperti tekstur lain di `track.ts`:
 *
 * 1. **Bisa diuji tanpa DOM.** Semua fungsi di sini murni matematika, jadi
 *    `scripts/smoke.ts` bisa mengecek hasilnya di Node (lebar, sebaran warna,
 *    jumlah batu, normal map yang wajar) — bukan cuma "tidak crash".
 * 2. **Hasilnya deterministik.** Semua keacakan lewat `mulberry32` dengan benih
 *    tetap, jadi trek terlihat sama di setiap muat halaman dan screenshot bisa
 *    dibandingkan antar commit.
 * 3. **Bisa bikin normal map & peta kekasaran.** Canvas 2D hanya bisa memberi
 *    warna; di sini tinggi permukaan dihitung sekalian, lalu diturunkan jadi
 *    normal map (tonjolan kerikil, butiran aspal) dan peta kekasaran (jalur
 *    ban yang terpoles lebih mengkilap daripada sisa aspal).
 *
 * Semua peta **tileable**: noise memakai lattice yang membungkus (modulo), dan
 * batu digambar dengan koordinat yang juga membungkus, jadi tidak ada jahitan
 * saat teksturnya diulang 40 kali sepanjang putaran.
 */
import * as THREE from 'three';

export interface SurfaceMaps {
  /** Peta warna (sRGB), RGBA8. */
  map: Uint8Array;
  /** Normal map ruang tangen, RGBA8 (boleh kosong kalau permukaannya rata). */
  normal?: Uint8Array;
  /** Peta kekasaran; three membaca kanal G, tapi RGB diisi sama rata. */
  rough?: Uint8Array;
  size: number;
  normalSize: number;
  roughSize: number;
}

/* ------------------------------------------------------------------ */
/* utilitas angka                                                      */
/* ------------------------------------------------------------------ */

/** PRNG kecil & cepat: hasil selalu sama untuk benih yang sama. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (t: number) => t * t * (3 - 2 * t);

/**
 * Value noise yang membungkus: `freq` titik acak pada lattice, diinterpolasi
 * halus. Hasil 0..1, dan tepi kiri menyambung ke tepi kanan.
 */
function wrapNoise(size: number, freq: number, rng: () => number): Float32Array {
  const grid = new Float32Array(freq * freq);
  for (let i = 0; i < grid.length; i++) grid[i] = rng();
  const out = new Float32Array(size * size);
  const scale = freq / size;
  for (let y = 0; y < size; y++) {
    const gy = y * scale;
    const y0 = Math.floor(gy);
    const fy = smooth(gy - y0);
    const y0i = y0 % freq;
    const y1i = (y0 + 1) % freq;
    for (let x = 0; x < size; x++) {
      const gx = x * scale;
      const x0 = Math.floor(gx);
      const fx = smooth(gx - x0);
      const x0i = x0 % freq;
      const x1i = (x0 + 1) % freq;
      const a = grid[y0i * freq + x0i];
      const b = grid[y0i * freq + x1i];
      const c = grid[y1i * freq + x0i];
      const d = grid[y1i * freq + x1i];
      const top = a + (b - a) * fx;
      const bottom = c + (d - c) * fx;
      out[y * size + x] = top + (bottom - top) * fy;
    }
  }
  return out;
}

/** Hash 2D (0..1) untuk butiran per piksel — tidak butuh tabel. */
function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Dua jalur ban: kembalikan bobot 0..1 untuk posisi melintang `u` (0..1). */
function wornBands(u: number): number {
  const band = (centre: number, half: number) => {
    const d = (u - centre) / half;
    return Math.exp(-d * d);
  };
  return clamp01(band(0.29, 0.065) + band(0.71, 0.065));
}

/** Normal map ruang tangen dari medan tinggi, memakai beda pusat yang membungkus. */
function normalsFromHeight(height: Float32Array, size: number, strength: number): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const yUp = ((y - 1 + size) % size) * size;
    const yDn = ((y + 1) % size) * size;
    const yc = y * size;
    for (let x = 0; x < size; x++) {
      const xL = (x - 1 + size) % size;
      const xR = (x + 1) % size;
      const dx = (height[yc + xR] - height[yc + xL]) * strength;
      const dy = (height[yDn + x] - height[yUp + x]) * strength;
      // Normal = normalize(-dx, -dy, 1) lalu dipetakan ke 0..255.
      const nx = -dx;
      const ny = -dy;
      const len = Math.hypot(nx, ny, 1);
      const i = (yc + x) * 4;
      out[i] = Math.round((nx / len * 0.5 + 0.5) * 255);
      out[i + 1] = Math.round((ny / len * 0.5 + 0.5) * 255);
      out[i + 2] = Math.round((1 / len * 0.5 + 0.5) * 255);
      out[i + 3] = 255;
    }
  }
  return out;
}

/** Turunkan peta tinggi resolusi penuh jadi peta yang lebih kecil (box filter). */
function downsample(src: Float32Array, from: number, to: number): Float32Array {
  const out = new Float32Array(to * to);
  const step = from / to;
  for (let y = 0; y < to; y++) {
    for (let x = 0; x < to; x++) {
      let sum = 0;
      let n = 0;
      for (let sy = 0; sy < step; sy++) {
        const row = Math.floor(y * step + sy) * from;
        for (let sx = 0; sx < step; sx++) {
          sum += src[row + Math.floor(x * step + sx)];
          n++;
        }
      }
      out[y * to + x] = sum / n;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* aspal                                                               */
/* ------------------------------------------------------------------ */

/**
 * Aspal: abu-abu gelap dengan butiran batu, tambalan, retak rambut, dan dua
 * jalur ban yang lebih gelap + lebih mengkilap (karet dipoles roda). Jalur itu
 * dipanggang ke tekstur, jadi tidak ada mesh tambahan dan ikut menyempit di
 * tikungan.
 */
export function makeAsphaltMaps(size = 512): SurfaceMaps {
  const rng = mulberry32(0x51ce1a3);
  const coarse = wrapNoise(size, 4, rng);
  const patchy = wrapNoise(size, 8, rng);
  const grain = wrapNoise(size, 32, rng);
  const micro = wrapNoise(size, 96, rng);

  const map = new Uint8Array(size * size * 4);
  const rough = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);

  // Retak rambut: beberapa jalan acak yang membungkus, lebar 1 piksel.
  const cracks = new Uint8Array(size * size);
  for (let c = 0; c < 3; c++) {
    let x = Math.floor(rng() * size);
    let y = Math.floor(rng() * size);
    let dir = rng() * Math.PI * 2;
    const steps = 60 + Math.floor(rng() * 120);
    for (let s = 0; s < steps; s++) {
      const ix = ((Math.round(x) % size) + size) % size;
      const iy = ((Math.round(y) % size) + size) % size;
      cracks[iy * size + ix] = 1;
      dir += (rng() - 0.5) * 0.22;
      x += Math.cos(dir);
      y += Math.sin(dir);
    }
  }

  for (let y = 0; y < size; y++) {
    const u = y / size; // sepanjang trek: hanya untuk variasi bintik besar
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const v = x / size; // melintang: di sinilah jalur ban berada
      const band = wornBands(v);

      // Abu-abu dasar + tiga skala bintik.
      let g =
        0.325 +
        (coarse[i] - 0.5) * 0.075 +
        (patchy[i] - 0.5) * 0.06 +
        (grain[i] - 0.5) * 0.055 +
        (micro[i] - 0.5) * 0.04;

      // Butiran batu yang menonjol: sebagian kecil piksel jauh lebih terang.
      const speck = hash2(x, y, 7);
      if (speck > 0.93) g += 0.09 + (speck - 0.93) * 1.5;
      else if (speck < 0.07) g -= 0.09;

      // Karet yang menempel di jalur ban: lebih gelap, sedikit kebiruan.
      g -= band * 0.07;

      // Retak: garis gelap tipis dengan tepi yang tetap terang (aspal terkelupas).
      if (cracks[i]) {
        g -= 0.085;
      } else {
        const up = y > 0 && cracks[i - size];
        const dn = y < size - 1 && cracks[i + size];
        const lf = cracks[i - 1];
        const rt = cracks[i + 1];
        if (up || dn || lf || rt) g -= 0.025;
      }

      // Tambalan besar: beda umur aspal, terlihat sebagai bidang lebih gelap.
      const patchMask = patchy[i];
      if (patchMask > 0.7) g -= (patchMask - 0.7) * 0.13;

      const r = clamp01(g * 0.985 + (u - 0.5) * 0.006);
      const gr = clamp01(g);
      const b = clamp01(g * 1.06);
      const px = i * 4;
      map[px] = Math.round(r * 255);
      map[px + 1] = Math.round(gr * 255);
      map[px + 2] = Math.round(b * 255);
      map[px + 3] = 255;

      // Kekasaran: jalur ban terpoles (0,62) vs sisa aspal (0,92).
      const roughV = clamp01(0.92 - band * 0.34 - (speck > 0.955 ? 0.05 : 0) + (cracks[i] ? 0.06 : 0));
      rough[px] = Math.round(roughV * 255);
      rough[px + 1] = rough[px];
      rough[px + 2] = rough[px];
      rough[px + 3] = 255;

      // Tinggi untuk normal map: butiran halus + gelombang tipis.
      height[i] = grain[i] * 0.45 + micro[i] * 0.4 + (speck > 0.955 ? 0.35 : 0) - band * 0.05;
    }
  }

  const nSize = 256;
  const normal = normalsFromHeight(downsample(height, size, nSize), nSize, 2.2);
  return { map, normal, rough, size, normalSize: nSize, roughSize: size };
}

/* ------------------------------------------------------------------ */
/* gravel                                                              */
/* ------------------------------------------------------------------ */

/**
 * Gravel: kerikil tiga ukuran di atas pasir hangat, dengan jalur ban yang
 * sudah **terpadatkan** (lebih gelap, batu besar tersapu, permukaan lebih
 * rata). Batu digambar dengan gradasi terang di kiri atas dan gelap di kanan
 * bawah, meniru sinar matahari, lalu normal map dibuat dari medan tingginya.
 */
export function makeGravelMaps(size = 512): SurfaceMaps {
  const rng = mulberry32(0x6be7a51);
  const sandy = wrapNoise(size, 6, rng);
  const drift = wrapNoise(size, 12, rng);
  const fine = wrapNoise(size, 64, rng);

  const map = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);

  // Pasir dasar: coklat keabu-abuan dengan butiran per piksel, bukan bidang
  // rata — kalau rata, batu-batu di atasnya terlihat seperti tempelan.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const t = sandy[i] * 0.5 + drift[i] * 0.32 + fine[i] * 0.18;
      const grit = hash2(x, y, 55);
      let r = 0.57 + t * 0.18 + (grit - 0.5) * 0.1;
      let g = 0.53 + t * 0.17 + (grit - 0.5) * 0.095;
      let b = 0.45 + t * 0.14 + (grit - 0.5) * 0.085;
      const band = wornBands(x / size);
      // Jalur ban: pasir terpadatkan, lebih gelap & lebih coklat.
      r *= 1 - band * 0.14;
      g *= 1 - band * 0.16;
      b *= 1 - band * 0.18;
      const px = i * 4;
      map[px] = Math.round(clamp01(r) * 255);
      map[px + 1] = Math.round(clamp01(g) * 255);
      map[px + 2] = Math.round(clamp01(b) * 255);
      map[px + 3] = 255;
      height[i] = drift[i] * 0.3 + fine[i] * 0.22 + (grit - 0.5) * 0.12;
    }
  }

  /**
   * Satu butir kerikil: bentuknya **tidak** bulat sempurna (diberi variasi
   * radius per sudut supaya terlihat pecahan batu), dengan puncak terang,
   * tepi bawah gelap, dan bayangan kontak tipis di luar batunya.
   */
  const stone = (cx: number, cy: number, radius: number, tone: number, damp: number) => {
    const wobble = 0.72 + rng() * 0.5;
    const phase = rng() * Math.PI * 2;
    const reach = radius * 1.25 + 1;
    const x0 = Math.floor(cx - reach);
    const x1 = Math.ceil(cx + reach);
    const y0 = Math.floor(cy - reach);
    const y1 = Math.ceil(cy + reach);
    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        const dx = xx + 0.5 - cx;
        const dy = yy + 0.5 - cy;
        const dist = Math.hypot(dx, dy);
        const ang = Math.atan2(dy, dx);
        // Radius efektif: lingkaran yang "digigit" tiga kali.
        const rEff = radius * (1 - 0.2 + wobble * 0.2 + Math.sin(ang * 3 + phase) * 0.13);
        const ix = ((xx % size) + size) % size;
        const iy = ((yy % size) + size) % size;
        const i = iy * size + ix;
        const px = i * 4;
        if (dist > rEff) {
          // Bayangan kontak: hanya di sisi kanan-bawah butir.
          if (dist < rEff + 1.1 && dx + dy > 0) {
            map[px] = Math.round(map[px] * 0.88);
            map[px + 1] = Math.round(map[px + 1] * 0.88);
            map[px + 2] = Math.round(map[px + 2] * 0.88);
          }
          continue;
        }
        const t = dist / rEff; // 0 pusat, 1 tepi
        const dome = Math.sqrt(1 - t * t);
        // Sinar dari kiri atas: sisi itu terang, sisi seberang gelap.
        const light = clamp01(0.5 - (dx + dy) / (radius * 2.6));
        const shade = (0.62 + dome * 0.3 + (light - 0.5) * 0.5) * damp;
        const cr = (map[px] / 255) * tone * shade;
        const cg = (map[px + 1] / 255) * tone * shade;
        const cb = (map[px + 2] / 255) * tone * shade;
        map[px] = Math.round(clamp01(cr) * 255);
        map[px + 1] = Math.round(clamp01(cg) * 255);
        map[px + 2] = Math.round(clamp01(cb) * 255);
        height[i] = Math.max(height[i], dome * radius * 0.1);
      }
    }
  };

  // Abu-abu, coklat muda, dan kerikil gelap bercampur — gravel balapan bukan
  // pasir satu warna.
  const tones = [1.5, 1.32, 1.18, 1.05, 0.92, 0.78, 1.24, 1.1];
  for (let i = 0; i < 70; i++) {
    const cx = rng() * size;
    const cy = rng() * size;
    const band = wornBands(cx / size);
    if (band > 0.55 && rng() < 0.72) continue; // jalur ban: batu besar tersapu
    stone(cx, cy, 5 + rng() * 8, tones[Math.floor(rng() * tones.length)], 1 - band * 0.12);
  }
  for (let i = 0; i < 1500; i++) {
    const cx = rng() * size;
    const cy = rng() * size;
    const band = wornBands(cx / size);
    stone(cx, cy, 1.9 + rng() * 3.4, tones[Math.floor(rng() * tones.length)], 1 - band * 0.18);
  }
  // Kerikil lepas yang terang: batu yang baru terlempar roda dan belum
  // terpadatkan, jadi paling menonjol di permukaan.
  for (let i = 0; i < 420; i++) {
    const cx = rng() * size;
    const cy = rng() * size;
    stone(cx, cy, 1.1 + rng() * 2.2, 1.32 + rng() * 0.22, 1.02);
  }
  for (let i = 0; i < 15000; i++) {
    const cx = rng() * size;
    const cy = rng() * size;
    const band = wornBands(cx / size);
    if (band > 0.35 && rng() < 0.55) continue; // jalur ban lebih halus
    stone(cx, cy, 0.7 + rng() * 1.3, tones[Math.floor(rng() * tones.length)], 1 - band * 0.22);
  }

  const nSize = 512;
  const normal = normalsFromHeight(height, nSize, 1.35);

  // Gravel hampir matte seluruhnya; yang sedikit lebih halus hanya butir batu.
  const rough = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const h = height[i];
    const v = clamp01(0.97 - Math.min(0.14, h * 0.18));
    rough[i * 4] = Math.round(v * 255);
    rough[i * 4 + 1] = rough[i * 4];
    rough[i * 4 + 2] = rough[i * 4];
    rough[i * 4 + 3] = 255;
  }

  return { map, normal, rough, size, normalSize: nSize, roughSize: size };
}

/* ------------------------------------------------------------------ */
/* kerban & bahu                                                       */
/* ------------------------------------------------------------------ */

/**
 * Kerban merah-putih yang sudah kotor: cat pudar, garis gum/tumit, dan debu
 * gravel yang menempel. Tata letaknya sama dengan versi canvas lama (separuh
 * atas merah, separuh bawah putih), jadi uv kerban tidak perlu diubah.
 */
export function makeKerbMaps(size = 128): SurfaceMaps {
  const rng = mulberry32(0x2f8b17d);
  const grime = wrapNoise(size, 8, rng);
  const wear = wrapNoise(size, 32, rng);
  const map = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const red = y < size / 2;
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const g = grime[i];
      const w = wear[i];
      let r: number;
      let gg: number;
      let b: number;
      if (red) {
        r = 0.8;
        gg = 0.17;
        b = 0.13;
      } else {
        r = 0.9;
        gg = 0.9;
        b = 0.88;
      }
      // Cat pudar + debu: makin ke tepi kerban makin kotor.
      const dirt = clamp01(g * 0.55 + (1 - Math.abs(x / size - 0.5) * 2) * 0.0);
      const fade = 1 - w * 0.22;
      r = r * fade * (1 - dirt * 0.28) + 0.34 * dirt * 0.28;
      gg = gg * fade * (1 - dirt * 0.28) + 0.29 * dirt * 0.28;
      b = b * fade * (1 - dirt * 0.28) + 0.24 * dirt * 0.28;
      const speck = hash2(x, y, 33);
      if (speck > 0.97) r *= 0.82;
      const px = i * 4;
      map[px] = Math.round(clamp01(r) * 255);
      map[px + 1] = Math.round(clamp01(gg) * 255);
      map[px + 2] = Math.round(clamp01(b) * 255);
      map[px + 3] = 255;
    }
  }
  return { map, size, normalSize: size, roughSize: size };
}

/**
 * Bahu trek (tepi aspal tempat mobil sering melebar): rumput yang terkelupas
 * jadi tanah, dengan garis roda dan bercak debu. Lebih gelap dan kotor
 * daripada rumput lapangan di luar arena.
 */
/**
 * Padang rumput di luar trek: rumput potong dengan gradasi alami, bukan satu
 * warna hijau rata. Versi lama cuma dua pita potong bergaris keras di atas
 * `#74b446` — dari kamera mobil hasilnya seperti karpet plastik, dan petaknya
 * (30 m) terlihat berulang di seluruh arena.
 *
 * Yang dibangun di sini, berlapis:
 *   - noise besar (3 oktaf) → bercak terang-gelap selebar beberapa meter,
 *   - bercak kering kekuningan (tidak merata, seperti lapangan yang jarang
 *     disiram), 
 *   - rumpun & helai per piksel sebagai butiran halus yang menahan pandangan
 *     saat kamera menempel ke tanah,
 *   - pita potong (mower) tipis ±5 %, cukup untuk memberi arah pada lapangan
 *     tanpa terlihat seperti zebra.
 * Peta normalnya bikin permukaan tidak terlihat seperti kertas.
 */
export function makeTurfMaps(size = 512): SurfaceMaps {
  const rng = mulberry32(0x2f10a7);
  const broad = wrapNoise(size, 3, rng);
  const clumps = wrapNoise(size, 8, rng);
  const tufts = wrapNoise(size, 26, rng);
  const blades = wrapNoise(size, 96, rng);
  const dry = wrapNoise(size, 5, rng);

  const map = new Uint8Array(size * size * 4);
  const rough = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);
  // Pita potong: 8 pita per petak, disambung halus supaya tidak ada garis lompat.
  const stripes = 8;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const n = 0.42 * broad[i] + 0.33 * clumps[i] + 0.25 * tufts[i];
      // Bercak kering: hanya puncak noise yang menguning, sisanya tetap hijau.
      const dryMix = clamp01((dry[i] - 0.56) * 2.6) * clamp01((clumps[i] - 0.35) * 1.8);
      const fine = blades[i] - 0.5;

      let r = 0.185 + n * 0.115 + dryMix * 0.105 + fine * 0.045;
      let g = 0.285 + n * 0.185 + dryMix * 0.055 + fine * 0.06;
      let b = 0.105 + n * 0.07 + dryMix * 0.02 + fine * 0.025;

      // Butir rumput: sesekali helai terang (ujung kena matahari) dan helai
      // gelap (bayangan di antara rumpun). Ini yang bikin teksturnya "hidup"
      // waktu dilihat dekat, bukan cuma gradasi warna.
      const sp = hash2(x, y, 17);
      if (sp > 0.972) {
        r += 0.075;
        g += 0.085;
        b += 0.03;
      } else if (sp < 0.03) {
        r *= 0.82;
        g *= 0.8;
        b *= 0.86;
      }

      // Pita potong: gelombang lembut 8 kali per petak (amplitudo ±5 %).
      const stripe = 1 + 0.05 * Math.sin((x / size) * Math.PI * 2 * stripes);
      r *= stripe;
      g *= stripe;
      b *= stripe;

      const px = i * 4;
      map[px] = Math.round(clamp01(r) * 255);
      map[px + 1] = Math.round(clamp01(g) * 255);
      map[px + 2] = Math.round(clamp01(b) * 255);
      map[px + 3] = 255;

      // Rumput tidak pernah mengkilap: 0,88–0,97, sedikit lebih kering = lebih kasar.
      const roughV = 0.88 + 0.09 * (1 - clamp01(dryMix + 0.35 * n));
      rough[px] = rough[px + 1] = rough[px + 2] = Math.round(clamp01(roughV) * 255);
      rough[px + 3] = 255;

      // Tinggi untuk normal map: rumpun + helai, tanpa pita potong (pita itu
      // warna, bukan relief).
      height[i] = tufts[i] * 0.55 + clumps[i] * 0.3 + blades[i] * 0.35;
    }
  }

  const normalSize = 256;
  const normal = normalsFromHeight(
    size === normalSize ? height : downsample(height, size, normalSize),
    normalSize,
    2.6,
  );
  return { map, normal, rough, size, normalSize, roughSize: size };
}

export function makeVergeMaps(size = 256): SurfaceMaps {
  const rng = mulberry32(0x77a31c9);
  const grass = wrapNoise(size, 8, rng);
  const dirt = wrapNoise(size, 24, rng);
  const patches = wrapNoise(size, 6, rng);
  const grit = wrapNoise(size, 64, rng);
  const map = new Uint8Array(size * size * 4);
  const rough = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      // Peralihan rumput ↔ tanah: bercak besar menentukan di mana tanah
      // muncul, lalu butiran halus menggerus tepinya. Dulu kurvanya tajam
      // (×3) sehingga hasilnya bercak kamuflase hijau-cokelat yang keras —
      // sekarang tanah hanya muncul di puncak bercak, dan sisanya rumput
      // dengan nada yang sama seperti lapangan di sekelilingnya.
      const bare = clamp01((patches[i] - 0.62) * 2.6) * clamp01(0.35 + dirt[i] * 0.9);
      const grassTone = grass[i];
      const soil = grit[i];
      // Rumput bahu: palet tanah lapangan (hijau gelap, sedikit kusam).
      let r = 0.175 + grassTone * 0.1;
      let g = 0.275 + grassTone * 0.165;
      let b = 0.105 + grassTone * 0.065;
      // Tanah: cokelat kusam, bukan pasir terang.
      const sr = 0.33 + soil * 0.12;
      const sg = 0.275 + soil * 0.1;
      const sb = 0.2 + soil * 0.075;
      r = r * (1 - bare) + sr * bare;
      g = g * (1 - bare) + sg * bare;
      b = b * (1 - bare) + sb * bare;
      const speck = hash2(x, y, 91);
      if (speck > 0.955) {
        r += 0.045;
        g += 0.055;
        b += 0.03;
      } else if (speck < 0.045) {
        r *= 0.84;
        g *= 0.86;
        b *= 0.86;
      }
      const px = i * 4;
      map[px] = Math.round(clamp01(r) * 255);
      map[px + 1] = Math.round(clamp01(g) * 255);
      map[px + 2] = Math.round(clamp01(b) * 255);
      map[px + 3] = 255;
      // Bahu trek ikut punya kekasaran & relief: rumput yang sama dengan tanah,
      // jadi keduanya menyatu dan tidak terlihat seperti dua bahan berbeda.
      const roughV = 0.86 + 0.12 * clamp01(1 - bare);
      rough[px] = rough[px + 1] = rough[px + 2] = Math.round(roughV * 255);
      rough[px + 3] = 255;
      height[i] = grass[i] * 0.6 + dirt[i] * 0.4;
    }
  }
  return {
    map,
    normal: normalsFromHeight(height, size, 2.2),
    rough,
    size,
    normalSize: size,
    roughSize: size,
  };
}

/* ------------------------------------------------------------------ */
/* ke three.js                                                         */
/* ------------------------------------------------------------------ */

/** Bungkus buffer RGBA jadi `DataTexture` yang bisa diulang di sepanjang trek. */
export function dataTexture(
  data: Uint8Array,
  size: number,
  color: boolean,
  repeat = 1,
): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  // 4× sudah cukup untuk jalan yang dilihat dari kamera mobil; 8+ hanya
  // membebani sampling tekstur di HP.
  tex.anisotropy = 4;
  tex.repeat.set(repeat, repeat);
  tex.needsUpdate = true;
  return tex;
}

/** Rata-rata warna sebuah peta — dipakai uji headless & preview tanpa GPU. */
export function averageColor(data: Uint8Array): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  const n = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
  }
  return [r / n, g / n, b / n];
}
