/**
 * Audit geometri trek — murni matematika, tanpa DOM/WebGL:
 *
 *   npx tsx scripts/track-audit.ts
 *
 * Yang diperiksa:
 *  1. Tidak ada dinding yang berdiri **di atas aspal** (baik garis balap utama
 *     maupun jalur joker). Dinding di tengah jalan = mobil menabrak udara.
 *  2. Tidak ada **celah** di pagar pengaman (termasuk sambungan putaran).
 *  3. Sisi dalam trek: seberapa jauh mobil bisa menyetir ke dalam sebelum
 *     ditahan — celah besar = jalan pintas memotong lapangan.
 *  4. Persimpangan jalan cabang (joker): sudut masuk dan keluar, apakah
 *     tangensial atau menusuk dinding.
 */
import * as THREE from 'three';
import { TRACK, TRACK_WALLS, PIT, JUMPS } from '../src/world/track';
import { JOKER_START, JOKER_END } from '../src/world/circuit';

type Sample = { pos: THREE.Vector3; halfWidth: number; distance: number; surface: string };

const MAIN = TRACK.main as unknown as Sample[];
const JOKER = TRACK.joker as unknown as Sample[];
const ISSUE = '  ✗';
const OK = '  ✓';

function nearestOn(path: Sample[], p: THREE.Vector3) {
  let best = path[0];
  let bestD = Infinity;
  for (const s of path) {
    const dx = s.pos.x - p.x;
    const dz = s.pos.z - p.z;
    const d = dx * dx + dz * dz;
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return { sample: best, dist: Math.sqrt(bestD) };
}

let problems = 0;
const fail = (msg: string) => {
  problems++;
  console.log(`${ISSUE} ${msg}`);
};

console.log(`trek utama ${TRACK.length.toFixed(1)} m · ${MAIN.length} sampel · joker ${JOKER.length} sampel · ${JUMPS.length} lompatan\n`);

/* 1. dinding di atas aspal ------------------------------------------------ */
console.log('— dinding vs aspal —');
for (const wall of TRACK_WALLS) {
  let onMain = 0;
  let onJoker = 0;
  let minMain = Infinity;
  let minJoker = Infinity;
  const pos = wall.ribbon.positions;
  for (let i = 0; i < pos.length; i += 3) {
    const p = new THREE.Vector3(pos[i], pos[i + 1], pos[i + 2]);
    const m = nearestOn(MAIN, p);
    const j = nearestOn(JOKER, p);
    minMain = Math.min(minMain, m.dist - m.sample.halfWidth);
    minJoker = Math.min(minJoker, j.dist - j.sample.halfWidth);
    if (m.dist < m.sample.halfWidth - 0.05) onMain++;
    if (j.dist < j.sample.halfWidth - 0.05) onJoker++;
  }
  const desc = `(paling dekat: ${minMain.toFixed(1)} m ke tepi trek utama, ${minJoker.toFixed(1)} m ke tepi joker)`;
  if (onMain > 0) fail(`${wall.name}: ${onMain} titik dinding ada DI ATAS garis balap utama ${desc}`);
  else if (onJoker > 0) fail(`${wall.name}: ${onJoker} titik dinding ada DI ATAS jalur joker ${desc}`);
  else console.log(`${OK} ${wall.name}: di luar aspal ${desc}`);
}

/* 2. celah pagar ---------------------------------------------------------- */
console.log('\n— kesinambungan pagar —');
for (const wall of TRACK_WALLS) {
  const pos = wall.ribbon.positions;
  let maxGap = 0;
  for (let i = 0; i < pos.length - 6; i += 6) {
    const d = Math.hypot(pos[i + 3] - pos[i], pos[i + 5] - pos[i + 2]);
    if (d > maxGap) maxGap = d;
  }
  if (maxGap > 3) fail(`${wall.name}: celah ${maxGap.toFixed(1)} m`);
  else console.log(`${OK} ${wall.name}: ${(pos.length / 6).toFixed(0)} titik, celah terbesar ${maxGap.toFixed(1)} m`);
}

/* 3. sisi dalam: berapa jauh bisa menyetir ke dalam ----------------------- */
console.log('\n— sisi dalam (jalan pintas) —');
{
  // Berapa meter dari tepi aspal ke dinding terdekat di sisi +1 (dalam).
  const inner = TRACK_WALLS.filter((w) => w.side > 0);
  let worst = { at: 0, gap: Infinity };
  let total = 0;
  let n = 0;
  for (const s of MAIN) {
    let best = Infinity;
    for (const wall of inner) {
      const pos = wall.ribbon.positions;
      for (let i = 0; i < pos.length; i += 3) {
        const d = Math.hypot(pos[i] - s.pos.x, pos[i + 2] - s.pos.z);
        if (d < best) best = d;
      }
    }
    const gap = best - s.halfWidth;
    total += Math.min(gap, 60);
    n++;
    if (gap < worst.gap) worst = { at: s.distance, gap };
  }
  const avg = total / n;
  console.log(`  rata-rata jarak tepi-ke-dinding dalam: ${avg.toFixed(1)} m`);
  console.log(`  titik paling terbuka: ${worst.gap.toFixed(1)} m di jarak ${worst.at.toFixed(0)} m`);
  if (worst.gap > 25) fail('sisi dalam praktis tanpa dinding: mobil bisa memotong lapangan');
}

/* 4. persimpangan joker --------------------------------------------------- */
console.log('\n— persimpangan cabang (joker) —');
{
  const ang = (a: THREE.Vector3, b: THREE.Vector3) =>
    (Math.acos(Math.min(1, Math.max(-1, a.clone().setY(0).normalize().dot(b.clone().setY(0).normalize())))) * 180) /
    Math.PI;
  const dirOf = (path: Sample[], i: number) =>
    path[Math.min(path.length - 1, i + 1)].pos.clone().sub(path[Math.max(0, i - 1)].pos);
  const split = nearestOn(MAIN, JOKER_START);
  const merge = nearestOn(MAIN, JOKER_END);
  // Sudut masuk: arah garis balap di titik belah vs arah dua sampel pertama joker.
  const inAngle = ang(dirOf(MAIN, MAIN.indexOf(split.sample)), dirOf(JOKER, 1));
  // Sudut keluar: arah joker di ujungnya vs arah garis balap di titik gabung.
  const outAngle = ang(dirOf(JOKER, JOKER.length - 2), dirOf(MAIN, MAIN.indexOf(merge.sample)));
  console.log(`  belah: jarak ${split.sample.distance.toFixed(0)} m · sudut masuk ${inAngle.toFixed(1)}°`);
  console.log(`  gabung: jarak ${merge.sample.distance.toFixed(0)} m · sudut keluar ${outAngle.toFixed(1)}°`);
  if (inAngle > 25) fail(`sudut masuk joker ${inAngle.toFixed(0)}° — terlalu menusuk`);
  if (outAngle > 25) fail(`sudut keluar joker ${outAngle.toFixed(0)}° — mobil terlempar ke pagar`);
}

/* 5. jalur pit ------------------------------------------------------------ */
console.log('\n— jalur pit —');
console.log(`  apron ${PIT.from.toFixed(0)}–${PIT.to.toFixed(0)} m · ${PIT.boxes.length} kotak · lebar 0,4–10,6 m dari tepi aspal`);

console.log(problems === 0 ? '\n✅ audit trek bersih' : `\n⚠️  ${problems} temuan`);
process.exit(problems === 0 ? 0 : 1);
