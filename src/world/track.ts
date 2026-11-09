import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  JOKER_NODES,
  JOKER_START,
  MAIN_NODES,
  START,
  nearestSample,
  ribbonGeometry,
  roadRibbon,
  samplePath,
  stripRibbon,
  vergeRibbon,
  type PathSample,
  type Ribbon,
  type Surface,
} from './circuit';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PALETTE, toon } from './style';

/**
 * A full rallycross arena: ~950 m mixed-surface circuit with two jumps, a
 * gravel-out/gravel-in section, a hairpin, a joker lap, kerbs, tyre walls,
 * catch fencing, a start gantry with lights, grandstand and marshal posts.
 *
 * `buildTrackColliders` only talks to Rapier and `buildTrackVisuals` only
 * talks to three.js + canvas, so the physics side still runs headless in Node.
 */

const ROAD_LIFT = 0.02; // road surface slightly proud of the grass plane
const GROUND_HALF = 420;
const GROUND_FRICTION = 1.0;
const WALL_GAP = 8; // metres of run-off between the white line and the wall
const WALL_HEIGHT = 1.05;
const FENCE_TOP = 3.4; // catch fencing reaches above the wall

const SURFACE_MU: Record<Surface, number> = { tarmac: 1.0, gravel: 0.62 };
const GRASS_MU = 0.55;

function lift(samples: PathSample[], dy: number): PathSample[] {
  return samples.map((s) => ({ ...s, pos: s.pos.clone().setY(s.pos.y + dy) }));
}

const MAIN = lift(samplePath(MAIN_NODES, 1.5, true), ROAD_LIFT);
// the joker rides 8 mm proud of the racing line where the two overlap
const JOKER = lift(samplePath(JOKER_NODES, 1.2, false), ROAD_LIFT + 0.008);
const MAIN_LENGTH = MAIN[MAIN.length - 1].distance;
/** Lap distance of the start/finish line. */
const START_DIST = MAIN[nearestSample(MAIN, START)].distance;

const MAIN_ROAD = roadRibbon(MAIN);
const JOKER_ROAD = roadRibbon(JOKER);
/**
 * Grass banks: wide where the road is at ground level, but they pull in where
 * the road is raised, so a jump does not bury its own joker lane in turf.
 */
const vergeWidth = (s: PathSample) =>
  18 - 13 * Math.min(1, Math.max(0, (s.pos.y - ROAD_LIFT) / 0.45));
const VERGE = vergeRibbon(MAIN, vergeWidth, 0.01);
const JOKER_VERGE = vergeRibbon(JOKER, 6, 0.01);

/** The catch fence runs the whole way round; nothing outside it is drivable. */
function isWalled(_s: PathSample) {
  return true;
}

/** Offset wall: `sideSign` +1 puts it inside the loop, -1 outside. */
function offsetWall(samples: PathSample[], sideSign: number, gap: number, height: number) {
  const ribbon: Ribbon = { positions: [], uvs: [], distances: [], indices: [] };
  const p = new THREE.Vector3();
  for (const s of samples) {
    p.copy(s.pos).addScaledVector(s.side, sideSign * (s.halfWidth + gap));
    const base = 0.01;
    ribbon.positions.push(p.x, base, p.z, p.x, base + height, p.z);
    ribbon.uvs.push(s.distance * 0.12, 0, s.distance * 0.12, 1);
    ribbon.distances.push(s.distance);
  }
  for (let k = 0; k < samples.length - 1; k++) {
    const i = k * 2;
    ribbon.indices.push(i, i + 1, i + 3, i, i + 3, i + 2);
  }
  return ribbon;
}

const OUTER_FENCE = offsetWall(MAIN.filter(isWalled), -1, WALL_GAP, WALL_HEIGHT);

/** Jarak minimum dinding ke tepi jalan di kedua sisinya, meter. */
const EDGE_CLEARANCE = 1.6;

/** Jarak horizontal ke pusat jalur terdekat, meter. */
function distanceToPath(path: PathSample[], x: number, z: number): { d: number; halfWidth: number } {
  let best = Infinity;
  let halfWidth = 7;
  for (const s of path) {
    const dx = s.pos.x - x;
    const dz = s.pos.z - z;
    const d = dx * dx + dz * dz;
    if (d < best) {
      best = d;
      halfWidth = s.halfWidth;
    }
  }
  return { d: Math.sqrt(best), halfWidth };
}

/**
 * Dinding pemisah antara jalur joker dan garis balap utama.
 *
 * Dulu geserannya tetap (½lebar + 1,4 m) — dan itu **salah**: di bagian tengah
 * kedua jalur hanya berjarak ~8,7 m pusat-ke-pusat, jadi dindingnya berdiri
 * 4,5 m di dalam aspal garis balap. Mobil yang lewat jalur utama menabrak
 * dinding yang tidak seharusnya ada di sana.
 *
 * Sekarang geserannya dihitung dari ruang kosong yang benar-benar tersedia
 * antara tepi kedua jalan, lalu ditaruh di tengah-tengahnya. Kalau kedua jalur
 * sudah menyatu (ruang < 1,4 m), dindingnya berhenti dan menyambung lagi
 * setelah jalurnya berpisah — hasilnya bisa beberapa potong.
 */
const JOKER_DIVIDERS: Ribbon[] = (() => {
  const length = JOKER[JOKER.length - 1].distance;
  // Beri ruang di kedua persimpangan: di sana garis balap dan joker memang
  // menyatu, kalau diberi dinding justru memblokir jalur masuk/keluar.
  const mid = JOKER.filter((s) => s.distance > 26 && s.distance < length - 26);
  if (mid.length < 4) return [];

  // Ke sisi mana garis balap utama berada? Diukur, bukan ditebak: geser titik
  // sampel ke kedua arah lalu lihat mana yang lebih dekat ke trek utama.
  const probe = mid[Math.floor(mid.length / 2)];
  const toMain = (sign: number) => {
    const p = probe.pos.clone().addScaledVector(probe.side, sign * 3);
    return distanceToPath(MAIN, p.x, p.z).d;
  };
  const sideSign = toMain(1) < toMain(-1) ? 1 : -1;

  const runs: Ribbon[] = [];
  let run: PathSample[] = [];
  let runOffsets: number[] = [];
  const flush = () => {
    if (run.length >= 4) {
      const ribbon: Ribbon = { positions: [], uvs: [], distances: [], indices: [] };
      for (let i = 0; i < run.length; i++) {
        const s = run[i];
        const p = s.pos.clone().addScaledVector(s.side, sideSign * runOffsets[i]);
        ribbon.positions.push(p.x, 0.01, p.z, p.x, 0.01 + 0.85, p.z);
        ribbon.uvs.push(s.distance * 0.12, 0, s.distance * 0.12, 1);
        ribbon.distances.push(s.distance);
      }
      for (let k = 0; k < run.length - 1; k++) {
        const i = k * 2;
        ribbon.indices.push(i, i + 1, i + 3, i, i + 3, i + 2);
      }
      runs.push(ribbon);
    }
    run = [];
    runOffsets = [];
  };
  for (const s of mid) {
    const other = distanceToPath(MAIN, s.pos.x, s.pos.z);
    // Ruang bebas antara tepi joker dan tepi garis balap.
    const gap = other.d - other.halfWidth - s.halfWidth;
    // Dinding harus punya jarak **untuk mobil**, bukan cuma untuk titik:
    // 1,6 m tiap sisi (setengah lebar mobil + margin). Kalau ruangnya tidak
    // cukup, dindingnya berhenti — dan di situ kedua jalur memang sudah
    // menyatu, jadi tidak ada gunanya memisahkan.
    if (gap < EDGE_CLEARANCE * 2) {
      flush();
      continue;
    }
    run.push(s);
    runOffsets.push(s.halfWidth + Math.max(EDGE_CLEARANCE, gap / 2));
  }
  flush();
  return runs;
})();

/** Dinding di sisi dalam joker: memisahkannya dari rumput infield. */
const JOKER_LANE_WALLS: Ribbon[] = (() => {
  const length = JOKER[JOKER.length - 1].distance;
  const mid = JOKER.filter((s) => s.distance > 26 && s.distance < length - 26);
  if (mid.length < 4) return [];
  const probe = mid[Math.floor(mid.length / 2)];
  const toMain = (sign: number) => {
    const p = probe.pos.clone().addScaledVector(probe.side, sign * 3);
    return distanceToPath(MAIN, p.x, p.z).d;
  };
  // Sisi yang justru menjauh dari garis balap = sisi infield.
  const away = toMain(1) < toMain(-1) ? -1 : 1;
  return [offsetWall(mid, away, 1.4, 0.85)];
})();

/** Semua dinding jalur cabang (joker), dipakai mesh dan collider. */
const JOKER_WALLS: Ribbon[] = [...JOKER_DIVIDERS, ...JOKER_LANE_WALLS];


/**
 * Semua dinding yang bisa ditabrak, dengan nama — dipakai skrip audit
 * (`npm run audit:track`) dan cek smoke untuk memastikan tidak ada dinding
 * yang berdiri di atas aspal dan tidak ada celah di pagar pengaman.
 */
export interface TrackWall {
  name: string;
  /** Sisi relatif terhadap garis: +1 sisi dalam, -1 sisi luar. */
  side: number;
  height: number;
  ribbon: Ribbon;
}

export const TRACK_WALLS: TrackWall[] = [
  { name: 'catch-fence', side: -1, height: FENCE_TOP, ribbon: OUTER_FENCE },
  ...JOKER_DIVIDERS.map((ribbon, i) => ({
    name: `joker-divider-${i + 1}`,
    side: -1,
    height: 0.85,
    ribbon,
  })),
  ...JOKER_LANE_WALLS.map((ribbon, i) => ({
    name: `joker-infield-${i + 1}`,
    side: 1,
    height: 0.85,
    ribbon,
  })),
];

/* ------------------------------------------------------------------ */
/* colliders                                                           */
/* ------------------------------------------------------------------ */

function addTrimesh(
  world: RAPIER.World,
  ribbon: Ribbon,
  friction: number,
  restitution = 0.02,
) {
  if (ribbon.indices.length === 0) return;
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(
    RAPIER.ColliderDesc.trimesh(
      new Float32Array(ribbon.positions),
      new Uint32Array(ribbon.indices),
    )
      .setFriction(friction)
      .setRestitution(restitution),
    body,
  );
}

/** Ground + circuit surfaces + barriers. No DOM, no meshes: usable in Node. */
export function buildTrackColliders(world: RAPIER.World) {
  const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(GROUND_HALF, 0.5, GROUND_HALF)
      .setTranslation(0, -0.5, 0)
      .setFriction(GROUND_FRICTION)
      .setRestitution(0.0),
    groundBody,
  );

  addTrimesh(world, MAIN_ROAD.tarmac, SURFACE_MU.tarmac);
  addTrimesh(world, MAIN_ROAD.gravel, SURFACE_MU.gravel);
  addTrimesh(world, JOKER_ROAD.gravel, SURFACE_MU.gravel);
  // Catatan (audit): bagian aspal di ekor joker sengaja **tidak** diberi
  // collider sendiri. Potongan itu menumpang 8 mm di atas aspal trek utama dan
  // seluruhnya berada di dalam lebarnya, jadi collider trek utama sudah menahan
  // mobil di sana. Menambah collider kedua (dua permukaan berjarak 8 mm) membuat
  // solver Rapier memantul di sambungan: mobil terlempar dan terbalik di T3.
  addTrimesh(world, VERGE, GRASS_MU);
  // Apron pit = aspal sungguhan, bukan rumput: ban mencengkeram saat servis.
  addTrimesh(world, PIT.apron, SURFACE_MU.tarmac);
  addTrimesh(world, JOKER_VERGE, GRASS_MU);

  // The barrier is solid all the way up to the top of the catch fencing, so a
  // car that takes off badly cannot be launched out of the arena.
  addTrimesh(world, raiseBand(OUTER_FENCE, 0.05, FENCE_TOP), 0.4, 0.15);
  for (const wall of JOKER_WALLS) addTrimesh(world, wall, 0.4, 0.15);
}

/* ------------------------------------------------------------------ */
/* textures (browser only)                                             */
/* ------------------------------------------------------------------ */

function canvasTexture(
  draw: (ctx: CanvasRenderingContext2D, size: number) => void,
  size = 256,
  repeat = 1,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  draw(ctx, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  // Anisotropi 4 sudah cukup untuk jalan yang dilihat dari kamera mobil;
  // 8+ hanya membebani sampling tekstur di HP.
  tex.anisotropy = 4;
  tex.repeat.set(repeat, repeat);
  return tex;
}

const noise = (ctx: CanvasRenderingContext2D, size: number, count: number, alpha: number) => {
  for (let i = 0; i < count; i++) {
    const v = Math.floor(Math.random() * 60);
    ctx.fillStyle = `rgba(${v},${v},${v},${alpha})`;
    ctx.fillRect(Math.random() * size, Math.random() * size, 2, 2);
  }
};

function asphaltTexture() {
  // Aspal kartun: satu warna dasar + bintik halus, bukan bising foto.
  return canvasTexture((ctx, size) => {
    ctx.fillStyle = '#565d66';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = 'rgba(38,43,50,0.35)';
    for (let i = 0; i < 900; i++) {
      ctx.fillRect(Math.random() * size, Math.random() * size, 3, 3);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    for (let i = 0; i < 400; i++) {
      ctx.fillRect(Math.random() * size, Math.random() * size, 2, 2);
    }
    // Dua jalur karet ban (kiri/kanan) — dipanggang ke tekstur, jadi tidak ada
    // mesh tambahan, tidak ada z-fighting, dan ikut menyempit di tikungan.
    for (const centre of [0.29, 0.71]) {
      const half = 0.15;
      const grad = ctx.createLinearGradient((centre - half) * size, 0, (centre + half) * size, 0);
      grad.addColorStop(0, 'rgba(22,26,31,0)');
      grad.addColorStop(0.5, 'rgba(22,26,31,0.4)');
      grad.addColorStop(1, 'rgba(22,26,31,0)');
      ctx.fillStyle = grad;
      ctx.fillRect((centre - half) * size, 0, half * 2 * size, size);
    }
  }, 256, 1);
}

function gravelTexture() {
  // Gravel: pasir hangat dengan kerikil besar-besar (gaya kartun).
  return canvasTexture((ctx, size) => {
    ctx.fillStyle = '#c9a878';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = 'rgba(233,207,164,0.85)';
    for (let i = 0; i < 700; i++) {
      const r = 1.5 + Math.random() * 3;
      ctx.beginPath();
      ctx.arc(Math.random() * size, Math.random() * size, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(160,131,94,0.8)';
    for (let i = 0; i < 500; i++) {
      const r = 1 + Math.random() * 2.4;
      ctx.beginPath();
      ctx.arc(Math.random() * size, Math.random() * size, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }, 256, 1);
}

function grassTexture() {
  // Rumput: dua garis potong bergantian — pola khas lapangan di game arcade.
  // `repeat` 28 = satu petak ±30 m di tanah 840 m; tanpa ini garis potongnya
  // melebar sampai 200 m dan tanahnya terlihat seperti karpet rata.
  return canvasTexture((ctx, size) => {
    ctx.fillStyle = '#74b446';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = 'rgba(94,158,54,0.55)';
    const band = size / 4;
    for (let i = 0; i < 4; i += 2) ctx.fillRect(0, i * band, size, band);
    ctx.fillStyle = 'rgba(255,255,255,0.045)';
    for (let i = 0; i < 350; i++) {
      ctx.fillRect(Math.random() * size, Math.random() * size, 2, 2);
    }
  }, 256, 28);
}

function kerbTexture() {
  return canvasTexture((ctx, size) => {
    ctx.fillStyle = '#e6e6e6';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#cf2a1f';
    ctx.fillRect(0, 0, size, size / 2);
    noise(ctx, size, 400, 0.06);
  }, 64, 1);
}

function checkerTexture() {
  return canvasTexture((ctx, size) => {
    const cells = 8;
    const s = size / cells;
    for (let y = 0; y < cells; y++) {
      for (let x = 0; x < cells; x++) {
        ctx.fillStyle = (x + y) % 2 === 0 ? '#f2f4f7' : '#15181c';
        ctx.fillRect(x * s, y * s, s, s);
      }
    }
  }, 256, 1);
}

function crowdTexture() {
  return canvasTexture((ctx, size) => {
    ctx.fillStyle = '#20262e';
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 1400; i++) {
      const c = ['#d94f4f', '#e8c04a', '#4a7fd9', '#e0e4ea', '#4fae7a', '#c76fa8'][
        Math.floor(Math.random() * 6)
      ];
      ctx.fillStyle = c;
      ctx.fillRect(Math.random() * size, Math.random() * size, 4, istHead() ? 4 : 6);
    }
    function istHead() {
      return Math.random() < 0.45;
    }
  }, 256, 1);
}

function bannerTexture(text: string, bg: string, fg: string) {
  return canvasTexture((ctx, size) => {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = fg;
    ctx.font = `bold ${size * 0.19}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, size / 2, size / 2);
    ctx.strokeStyle = fg;
    ctx.lineWidth = size * 0.02;
    ctx.strokeRect(size * 0.04, size * 0.04, size * 0.92, size * 0.92);
  }, 256, 1);
}

/* ------------------------------------------------------------------ */
/* scenery helpers                                                     */
/* ------------------------------------------------------------------ */

/** Every sample of the lap with a surface change (for kerbs / markings). */
function cornerSections(samples: PathSample[], threshold = 1 / 70) {
  const zones: Array<{ from: number; to: number; side: number }> = [];
  let open: { from: number; side: number } | null = null;
  for (const s of samples) {
    const tight = Math.abs(s.curvature) > threshold;
    if (tight && !open) open = { from: s.distance, side: Math.sign(s.curvature) || 1 };
    if (!tight && open) {
      zones.push({ from: open.from, to: s.distance, side: open.side });
      open = null;
    }
  }
  if (open) zones.push({ from: open.from, to: MAIN_LENGTH, side: open.side });
  return zones;
}

interface PointOnTrack {
  pos: THREE.Vector3;
  tangent: THREE.Vector3;
  side: THREE.Vector3;
  curvature: number;
  halfWidth: number;
}

function pointAt(samples: PathSample[], distance: number): PointOnTrack {
  const length = samples[samples.length - 1].distance;
  let d = distance % length;
  if (d < 0) d += length;
  let best = samples[0];
  let bestDelta = Infinity;
  for (const s of samples) {
    const delta = Math.abs(s.distance - d);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = s;
    }
  }
  return {
    pos: best.pos.clone(),
    tangent: best.tangent.clone(),
    side: best.side.clone(),
    curvature: best.curvature,
    halfWidth: best.halfWidth,
  };
}

/* ------------------------------------------------------------------ */
/* visuals                                                             */
/* ------------------------------------------------------------------ */

export interface TrackHandle {
  /** Animates the start lights. */
  update(dt: number): void;
}

/** Re-skins a wall ribbon as a band between two heights (catch fencing). */
function raiseBand(ribbon: Ribbon, y0: number, y1: number): Ribbon {
  const positions = ribbon.positions.slice();
  for (let i = 0; i < positions.length; i += 6) {
    positions[i + 1] = y0;
    positions[i + 4] = y1;
  }
  return { ...ribbon, positions };
}

/** Rotation.y that makes a prop's local +Z point along `dir` (horizontal). */
const facing = (dir: THREE.Vector3) => Math.atan2(dir.x, dir.z);

/** Meshes only — mirrors `buildTrackColliders()` so both stay in sync. */
/* ------------------------------------------------------------------ */
/* kamera TV                                                           */
/* ------------------------------------------------------------------ */

const wrapDistance = (d: number) => ((d % MAIN_LENGTH) + MAIN_LENGTH) % MAIN_LENGTH;

export interface BroadcastSpot {
  /** Nama pendek untuk overlay, mis. "T2". */
  name: string;
  /** Posisi kamera (di menara, di luar tikungan). */
  position: THREE.Vector3;
  /** Titik yang dibidik kalau mobilnya jauh (apex tikungan). */
  aim: THREE.Vector3;
  /** Jarak tikungan ini dari garis start, meter — dipakai sutradara TV supaya
   *  kamera berganti tikungan demi tikungan, bukan berdasarkan jarak lurus. */
  trackDistance: number;
}

/**
 * Tribun & menara race control: data murni (tanpa DOM), dipakai pembangun
 * visual **dan** uji kamera TV (supaya tidak ada kamera yang tertutup tribun).
 *
 * `distance` = posisi di lintasan, `side` = -1 kiri / +1 kanan, `extra` = jarak
 * dari tepi trek, `length` = panjang tribun, `rows` = jumlah baris.
 */
export interface TrackProp {
  name: string;
  distance: number;
  side: number;
  extra: number;
  /** Ukuran kotak pembatas di ruang lokal prop, meter (lebar, tinggi, dalam). */
  size: { x: number; y: number; z: number };
  /** Geseran kotak dari titik taruh prop. */
  offset: { x: number; y: number; z: number };
}

export const TRACK_PROPS: TrackProp[] = (() => {
  const stands = [
    { name: 'tribun utama', distance: START_DIST - 16, side: -1, extra: 6.5, length: 34, rows: 7 },
    { name: 'tribun kedua', distance: START_DIST + 74, side: -1, extra: 7.5, length: 20, rows: 5 },
  ];
  const props: TrackProp[] = stands.map((st) => {
    // Sama persis dengan `makeStand()`: baris 1,5 m ke belakang, atap di
    // `height + 2,1`, kaki di kedua ujungnya.
    const height = 0.28 + st.rows * 0.55;
    const depth = st.rows * 1.5 + 1.5;
    return {
      name: st.name,
      distance: st.distance,
      side: st.side,
      extra: st.extra,
      size: { x: st.length + 1.6, y: height + 2.4, z: depth },
      offset: { x: 0, y: (height + 2.4) / 2, z: -((st.rows * 1.5) / 2 - 0.4) },
    };
  });
  // race control: poros 3,6 x 11 x 3,6 + kabin 6,2 m
  props.push({
    name: 'race control',
    distance: START_DIST - 34,
    side: -1,
    extra: 15,
    size: { x: 6.4, y: 13.6, z: 6.4 },
    offset: { x: 0, y: 6.8, z: 0 },
  });
  return props;
})();

/** Kotak pembatas prop di ruang dunia (sumbu lokal diputar `yaw`). */
export interface PropBox {
  name: string;
  center: THREE.Vector3;
  half: THREE.Vector3;
  yaw: number;
}

/** Posisi + rotasi taruh sebuah prop di sisi trek (sama dengan `place()`). */
export function propBox(prop: TrackProp): PropBox {
  const p = pointAt(MAIN, prop.distance);
  const center = p.pos
    .clone()
    .addScaledVector(p.side, prop.side * (p.halfWidth + prop.extra));
  center.y = prop.offset.y;
  // Prop diputar supaya sisi depannya menghadap garis balap.
  const yaw = Math.atan2(p.side.x * -prop.side, p.side.z * -prop.side);
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  center.x += prop.offset.x * cos + prop.offset.z * sin;
  center.z += -prop.offset.x * sin + prop.offset.z * cos;
  return {
    name: prop.name,
    center,
    half: new THREE.Vector3(prop.size.x / 2, prop.size.y / 2, prop.size.z / 2),
    yaw,
  };
}

export const TRACK_BLOCKERS: PropBox[] = TRACK_PROPS.map(propBox);

/**
 * Satu kamera TV di luar setiap tikungan + satu di garis start. Diletakkan di
 * sisi luar tikungan pada ketinggian menara ~6,5 m, jadi mobil terlihat
 * datang menghadap kamera lalu lewat — sudut yang dipakai siaran sungguhan.
 */
export const BROADCAST_SPOTS: BroadcastSpot[] = (() => {
  const spots: BroadcastSpot[] = [];
  const zones = cornerSections(MAIN, 1 / 45);
  zones.forEach((zone, i) => {
    const mid = pointAt(MAIN, (zone.from + zone.to) / 2);
    const entry = pointAt(MAIN, zone.from - 14);
    const outside = -Math.sign(zone.side) || 1;
    const position = entry.pos
      .clone()
      .addScaledVector(entry.side, outside * (entry.halfWidth + 11));
    position.y = entry.pos.y + 6.5;
    const aim = mid.pos.clone();
    aim.y += 1.2;
    spots.push({
      name: `T${i + 1}`,
      position,
      aim,
      trackDistance: wrapDistance((zone.from + zone.to) / 2 - START_DIST),
    });
  });

  const start = pointAt(MAIN, START_DIST);
  // Kamera garis start duduk di **atas** tribun utama (tribun itu menutupi
  // sisi kiri sepanjang ±33 m dari garis, jadi kamera 9 m di belakang tribun
  // hanya melihat atapnya). 15 m masih di bawah tiang lampu, dan garis
  // pandangnya lewat di atas atap tribun (6,3 m).
  const tower = start.pos.clone().addScaledVector(start.side, -(start.halfWidth + 15));
  tower.y = start.pos.y + 15;
  const aim = start.pos.clone();
  aim.y += 1.2;
  spots.push({ name: 'GARIS START', position: tower, aim, trackDistance: 0 });
  return spots;
})();

/**
 * Gabungkan mesh statis yang memakai material sama jadi satu mesh.
 *
 * Arena ini punya ~190 potong mesh kecil (tiang, tribun, spanduk, tiang
 * lampu). Semuanya berbagi belasan material, jadi ribuan draw call itu bisa
 * ditekan jadi puluhan tanpa mengubah satu pixel pun. Yang dilewati: mesh
 * beranimasi (`userData.noMerge`), `InstancedMesh`, dan material transparan
 * (urutan gambar transparan harus tetap per objek).
 */
function mergeStaticProps(scene: THREE.Scene) {
  const groups = new Map<THREE.Material, THREE.Mesh[]>();
  scene.updateMatrixWorld(true);
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || (o as THREE.InstancedMesh).isInstancedMesh) return;
    if (mesh.userData.noMerge) return;
    if (Array.isArray(mesh.material) || !mesh.material) return;
    if (mesh.material.transparent) return;
    const list = groups.get(mesh.material) ?? [];
    list.push(mesh);
    groups.set(mesh.material, list);
  });

  for (const [material, meshes] of groups) {
    if (meshes.length < 2) continue;
    const baked: THREE.BufferGeometry[] = [];
    for (const mesh of meshes) {
      const geo = mesh.geometry.clone();
      geo.applyMatrix4(mesh.matrixWorld);
      baked.push(geo);
    }
    const merged = mergeGeometries(baked, false);
    for (const geo of baked) geo.dispose();
    if (!merged) continue;
    for (const mesh of meshes) mesh.removeFromParent();
    merged.computeBoundingSphere();
    const single = new THREE.Mesh(merged, material);
    single.name = `merged:${material.name || material.type}`;
    single.matrixAutoUpdate = false;
    // Penting untuk shadow map: hasil gabungan harus tetap membuang/menerima
    // bayangan seperti mesh asalnya, kalau tidak tribun & gantry kehilangan
    // bayangannya.
    single.castShadow = meshes.some((m) => m.castShadow);
    single.receiveShadow = meshes.some((m) => m.receiveShadow);
    scene.add(single);
  }
}

/** Geometri penonton (badan + kepala) dipakai bersama oleh semua tribun. */
let spectatorGeo: THREE.BufferGeometry | null = null;
const spectatorColors = [0xd94f4f, 0x3f77c9, 0xe8c04a, 0xe8eef5, 0x4fae7a, 0xc76fa8, 0xf08a3c, 0x8f7fd6];

function spectatorGeometry(): THREE.BufferGeometry {
  if (spectatorGeo) return spectatorGeo;
  const body = new THREE.BoxGeometry(0.34, 0.46, 0.28);
  body.translate(0, 0.23, 0);
  const head = new THREE.SphereGeometry(0.125, 6, 5);
  head.translate(0, 0.58, 0);
  const merged = mergeGeometries([body.toNonIndexed(), head.toNonIndexed()], false);
  body.dispose();
  head.dispose();
  spectatorGeo = merged ?? new THREE.BufferGeometry();
  return spectatorGeo;
}

export function buildTrackVisuals(scene: THREE.Scene, detail = true): TrackHandle {
  const asphalt = asphaltTexture();
  const gravelTex = gravelTexture();
  const grass = grassTexture();
  const crowd = crowdTexture();

  const start = pointAt(MAIN, START_DIST);
  const startHeading = facing(start.tangent);
  const flags: THREE.Mesh[] = [];

  /** Point `extra` metres away from the racing line on the given hand. */
  const offsetPoint = (p: PointOnTrack, sideSign: number, extra: number) =>
    p.pos.clone().addScaledVector(p.side, sideSign * (p.halfWidth + extra)).setY(0);

  /** Drops a prop beside the track, turned to look at it. */
  const place = (obj: THREE.Object3D, p: PointOnTrack, sideSign: number, extra: number) => {
    const pos = offsetPoint(p, sideSign, extra);
    obj.position.set(pos.x, 0, pos.z);
    obj.rotation.y = facing(p.side.clone().multiplyScalar(-sideSign));
    scene.add(obj);
    return obj;
  };

  /* ---------------- ground + verges + road ---------------- */
  const groundMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(GROUND_HALF * 2, GROUND_HALF * 2),
    toon({ map: grass, roughness: 1, metalness: 0 }),
  );
  groundMesh.rotation.x = -Math.PI / 2;
  groundMesh.position.y = -0.005;
  groundMesh.receiveShadow = true;
  scene.add(groundMesh);

  const vergeMat = toon({ color: PALETTE.verge });
  for (const ribbon of [VERGE, JOKER_VERGE]) {
    const mesh = new THREE.Mesh(ribbonGeometry(ribbon), vergeMat);
    mesh.receiveShadow = true;
    scene.add(mesh);
  }

  const roadMaterials: Record<Surface, THREE.MeshToonMaterial> = {
    tarmac: toon({ map: asphalt, roughness: 0.92, metalness: 0 }),
    gravel: toon({ map: gravelTex, roughness: 1, metalness: 0 }),
  };
  for (const surface of ['tarmac', 'gravel'] as Surface[]) {
    for (const ribbon of [MAIN_ROAD[surface], JOKER_ROAD[surface]]) {
      if (!ribbon.positions.length) continue;
      const mesh = new THREE.Mesh(ribbonGeometry(ribbon), roadMaterials[surface]);
      mesh.receiveShadow = true;
      scene.add(mesh);
    }
  }

  /* white edge lines, following the width of each section */
  const white = toon({ color: PALETTE.kerbWhite });
  for (const sign of [-1, 1]) {
    const line = stripRibbon(MAIN, (s) => sign * (s.halfWidth - 0.32), 0.16, 0.016);
    scene.add(new THREE.Mesh(ribbonGeometry(line), white));
  }

  /* ---------------- start / finish ---------------- */
  {
    const band: Ribbon = { positions: [], uvs: [], distances: [], indices: [] };
    const a = pointAt(MAIN, START_DIST - 0.9);
    const b = pointAt(MAIN, START_DIST + 0.9);
    for (const [p, v] of [[a, 0], [b, 1]] as Array<[PointOnTrack, number]>) {
      for (const sign of [-1, 1]) {
        const q = p.pos.clone().addScaledVector(p.side, sign * p.halfWidth);
        band.positions.push(q.x, q.y + 0.02, q.z);
        band.uvs.push(sign < 0 ? 0 : 1, v);
      }
    }
    band.indices.push(0, 1, 3, 0, 3, 2);
    const tex = checkerTexture();
    tex.repeat.set(8, 1);
    const bandMesh = new THREE.Mesh(
      ribbonGeometry(band),
      toon({ map: tex, roughness: 0.8 }),
    );
    bandMesh.receiveShadow = true;
    scene.add(bandMesh);
  }

  /* starting grid, staggered boxes behind the line */
  const gridMat = toon({ color: 0xdfe6ee, roughness: 0.8 });
  for (let i = 0; i < 6; i++) {
    const p = pointAt(MAIN, START_DIST - 13 - i * 7);
    const box = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 4.4), gridMat);
    box.rotation.x = -Math.PI / 2;
    box.rotation.z = facing(p.tangent);
    box.position.copy(p.pos).addScaledVector(p.side, i % 2 === 0 ? -3.8 : 3.8);
    box.position.y += 0.02;
    scene.add(box);
  }

  /* ---------------- kerbs on the tight corners ---------------- */
  const kerbMat = toon({ map: kerbTexture(), roughness: 0.75 });
  for (const zone of cornerSections(MAIN, 1 / 45)) {
    const section = MAIN.filter((s) => s.distance >= zone.from && s.distance <= zone.to);
    if (section.length < 5) continue;
    const ribbon: Ribbon = { positions: [], uvs: [], distances: [], indices: [] };
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    for (const s of section) {
      const o = zone.side * (s.halfWidth - 0.6);
      a.copy(s.pos).addScaledVector(s.side, o + 0.6);
      b.copy(s.pos).addScaledVector(s.side, o - 0.6);
      a.y = s.pos.y + 0.045;
      b.y = s.pos.y + 0.045;
      ribbon.positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
      ribbon.uvs.push(0, s.distance * 0.5, 1, s.distance * 0.5);
    }
    for (let k = 0; k < section.length - 1; k++) {
      const i = k * 2;
      ribbon.indices.push(i, i + 1, i + 3, i, i + 3, i + 2);
    }
    const mesh = new THREE.Mesh(ribbonGeometry(ribbon), kerbMat);
    mesh.receiveShadow = true;
    scene.add(mesh);
  }

  /* ---------------- pit / service area ---------------- */
  {
    const apronMat = toon({ color: 0x626b76, side: THREE.DoubleSide });
    // Lewat `ribbonGeometry` supaya winding-nya dibetulkan: tanpa itu normalnya
    // menghadap ke bawah dan apron tampak hitam (terbaca seperti rumput).
    const apron = new THREE.Mesh(ribbonGeometry(PIT.apron), apronMat);
    apron.receiveShadow = detail;
    scene.add(apron);

    // Marka: garis tepi apron + pita masuk/keluar, biar jalur pit kebaca dari
    // jauh (dan pemain tahu di mana harus berhenti tanpa lihat HUD).
    const paintMat = toon({ color: PALETTE.kerbWhite, side: THREE.DoubleSide });
    const markings: Array<{ positions: number[]; uvs: number[]; distances: number[]; indices: number[] }> = [
      paintStrip(PIT.from + 1, PIT.to - 1, PIT_INNER, PIT_INNER + 0.16, PIT.y + 0.004),
      paintStrip(PIT.from + 1.6, PIT.from + 2.2, PIT_INNER, PIT_OUTER, PIT.y + 0.004, 1),
      paintStrip(PIT.to - 2.2, PIT.to - 1.6, PIT_INNER, PIT_OUTER, PIT.y + 0.004, 1),
    ];
    for (const marking of markings) {
      scene.add(new THREE.Mesh(ribbonGeometry(marking), paintMat));
    }

    // Garis kotak servis: satu LineSegments untuk keenam kotak (murah).
    const linePoints: number[] = [];
    const push = (x: number, z: number) => linePoints.push(x, PIT.y + 0.004, z);
    for (const box of PIT.boxes) {
      const fwd = new THREE.Vector3(Math.sin(box.yaw), 0, Math.cos(box.yaw));
      const right = new THREE.Vector3(fwd.z, 0, -fwd.x);
      const corners = [
        [-1.6, -2.4],
        [1.6, -2.4],
        [1.6, 2.4],
        [-1.6, 2.4],
      ].map(([r, f]) => box.position.clone().addScaledVector(right, r).addScaledVector(fwd, f));
      for (let i = 0; i < corners.length; i++) {
        const a = corners[i];
        const b = corners[(i + 1) % corners.length];
        push(a.x, a.z);
        push(b.x, b.z);
      }
    }
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(linePoints, 3));
    scene.add(new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ color: PALETTE.kerbWhite })));

    // Kanopi servis + papan tim di belakang tiap kotak.
    const postMat = toon({ color: 0x8f99a3 });
    const roofMat = toon({ color: 0x545f6b });
    const boardMats = [0xd8402f, 0x2d7ce0, 0xf2c53d, 0x3fbf7f, 0xb56cff, 0xe8eef6].map((color) =>
      toon({ color }),
    );
    for (const box of PIT.boxes) {
      const fwd = new THREE.Vector3(Math.sin(box.yaw), 0, Math.cos(box.yaw));
      const right = new THREE.Vector3(fwd.z, 0, -fwd.x);
      // Kanopi digeser sedikit ke luar dari kotak (bukan 3.4 m): kalau terlalu
      // jauh, atapnya menggantung di atas rumput, bukan di atas apron.
      const back = box.position.clone().addScaledVector(right, 2.2);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(4.8, 0.16, 5.4), roofMat);
      roof.position.copy(back).setY(2.55);
      roof.castShadow = detail;
      scene.add(roof);
      for (const side of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.5, 0.12), postMat);
        post.position.copy(back).addScaledVector(fwd, side * 2.3).setY(1.25);
        scene.add(post);
      }
      // Dinding belakang bernuansa warna tim, jadi tiap kotak bisa dikenali.
      const board = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.5, 4.4), boardMats[box.index % boardMats.length]);
      board.position.copy(back).addScaledVector(right, 0.9).setY(0.95);
      scene.add(board);
    }
  }

  /* ---------------- crash barrier + catch fencing ---------------- */
  const wallMat = toon({ color: PALETTE.barrier, side: THREE.DoubleSide });
  scene.add(new THREE.Mesh(ribbonGeometry(OUTER_FENCE), wallMat));

  const fenceTex = canvasTexture((ctx, size) => {
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = 'rgba(150,160,172,0.0)';
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = 'rgba(176,186,198,0.55)';
    ctx.lineWidth = 2;
    for (let i = 0; i < 8; i++) {
      const y = (i / 8) * size;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(size, y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(y, 0);
      ctx.lineTo(y, size);
      ctx.stroke();
    }
  }, 128, 1);
  const meshFenceMat = toon({
    map: fenceTex,
    transparent: true,
    alphaTest: 0.05,
    opacity: 0.55,
    roughness: 0.8,
    metalness: 0.2,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  scene.add(new THREE.Mesh(ribbonGeometry(raiseBand(OUTER_FENCE, WALL_HEIGHT, FENCE_TOP)), meshFenceMat));

  const jokerWallMat = toon({
    color: 0xe6e9ee,
    roughness: 0.7,
    side: THREE.DoubleSide,
  });
  for (const wall of JOKER_WALLS) {
    scene.add(new THREE.Mesh(ribbonGeometry(wall), jokerWallMat));
  }

  /* ---------------- sponsor banners on the barriers ---------------- */
  const sponsors: Array<[string, string, string]> = [
    ['RALLYCROSS', '#132033', '#ffcf3f'],
    ['GRAVEL KING', '#8c1f14', '#f6e7c9'],
    ['NITRO OIL', '#0f3f2c', '#d8f0c8'],
    ['JOKER', '#1b1f2a', '#ff7a0a'],
    ['SS10', '#2b1d5a', '#e9e2ff'],
    ['TURBO', '#b3202c', '#fff1f1'],
  ];
  const bannerMats = sponsors.map(
    ([text, bg, fg]) =>
      toon({
        map: bannerTexture(text, bg, fg),
        roughness: 0.85,
        side: THREE.DoubleSide,
      }),
  );
  for (let i = 0; i < 30; i++) {
    const p = pointAt(MAIN, 16 + (i / 30) * MAIN_LENGTH);
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(9, 0.95), bannerMats[i % bannerMats.length]);
    const pos = offsetPoint(p, -1, WALL_GAP - 0.15);
    plane.position.set(pos.x, WALL_HEIGHT * 0.55, pos.z);
    plane.rotation.y = facing(p.side); // normal points back at the racing line
    scene.add(plane);
  }

  /* ---------------- tyre walls at the corner exits ---------------- */
  const tyreGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.34, 12, 1, true);
  const tyreMat = toon({ color: PALETTE.tyre, side: THREE.DoubleSide });
  const tyreSpots: Array<{ pos: THREE.Vector3; angle: number }> = [];
  for (const zone of cornerSections(MAIN, 1 / 55)) {
    const steps = Math.max(4, Math.round((zone.to - zone.from) / 4));
    for (let i = 0; i <= steps; i++) {
      const d = zone.from + ((zone.to - zone.from) * i) / steps;
      const p = pointAt(MAIN, d);
      const base = offsetPoint(p, -Math.sign(zone.side), 4.2);
      tyreSpots.push({ pos: base, angle: facing(p.tangent) });
    }
  }
  const tyresPerStack = 3;
  const tyreMesh = new THREE.InstancedMesh(tyreGeo, tyreMat, tyreSpots.length * tyresPerStack);
  tyreMesh.castShadow = true;
  tyreMesh.receiveShadow = true;
  const m4 = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const unit = new THREE.Vector3(1, 1, 1);
  let instance = 0;
  for (const spot of tyreSpots) {
    for (let level = 0; level < tyresPerStack; level++) {
      quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), spot.angle);
      m4.compose(new THREE.Vector3(spot.pos.x, 0.17 + level * 0.33, spot.pos.z), quat, unit);
      tyreMesh.setMatrixAt(instance++, m4);
    }
  }
  tyreMesh.instanceMatrix.needsUpdate = true;
  scene.add(tyreMesh);

  /* ---------------- start gantry + lights ---------------- */
  const gantry = new THREE.Group();
  const steelMat = toon({ color: 0x2b323b, roughness: 0.6, metalness: 0.45 });
  const postGeo = new THREE.BoxGeometry(0.5, 7, 0.5);
  for (const sign of [-1, 1]) {
    const post = new THREE.Mesh(postGeo, steelMat);
    post.position.copy(start.pos).addScaledVector(start.side, sign * (start.halfWidth + 1.4));
    post.position.y = 3.5;
    post.castShadow = true;
    gantry.add(post);
  }
  const beamLen = (start.halfWidth + 1.4) * 2 + 0.5;
  const beam = new THREE.Mesh(new THREE.BoxGeometry(beamLen, 0.8, 0.7), steelMat);
  beam.position.copy(start.pos);
  beam.position.y = 6.6;
  beam.rotation.y = startHeading;
  beam.castShadow = true;
  gantry.add(beam);

  const board = new THREE.Mesh(
    new THREE.PlaneGeometry(Math.min(14, beamLen - 2), 1.7),
    toon({
      map: bannerTexture('RALLYCROSS ARENA', '#101720', '#ffd24a'),
      roughness: 0.8,
      side: THREE.DoubleSide,
    }),
  );
  board.position.copy(start.pos);
  board.position.y = 6.6;
  board.rotation.y = startHeading + Math.PI;
  board.translateZ(0.42);
  gantry.add(board);

  const lightPanel = new THREE.Mesh(
    new THREE.BoxGeometry(3.4, 0.9, 0.3),
    toon({ color: 0x14171c, roughness: 0.7 }),
  );
  lightPanel.position.copy(start.pos);
  lightPanel.position.y = 5.4;
  lightPanel.rotation.y = startHeading;
  gantry.add(lightPanel);

  const startLampMat = toon({
    color: 0x2a0a08,
    emissive: 0xff2200,
    emissiveIntensity: 0,
    roughness: 0.4,
  });
  const lampGeo = new THREE.SphereGeometry(0.22, 10, 8);
  for (let i = 0; i < 5; i++) {
    const lamp = new THREE.Mesh(lampGeo, startLampMat);
    lamp.position.copy(start.pos);
    lamp.position.y = 5.4;
    lamp.rotation.y = startHeading;
    lamp.translateX((i - 2) * 0.62);
    lamp.translateZ(-0.22);
    gantry.add(lamp);
  }
  scene.add(gantry);

  /* ---------------- grandstands ---------------- */
  const standMat = toon({ color: 0x39414b, roughness: 0.85 });
  // Atap seng terang + fasia merah: dari kamera heli, tribun jadi bentuk yang
  // terbaca (bukan kotak hitam).
  const roofMat = toon({ color: 0x9aa5b2, roughness: 0.7 });
  const fasciaMat = toon({ color: 0xc9382c, roughness: 0.8 });
  const crowdMat = toon({ map: crowd, roughness: 0.9 });
  // Warna penonton diambil dari `instanceColor`, jadi materialnya putih.
  const fanMat = toon({ color: 0xffffff });
  const makeStand = (length: number, rows: number) => {
    const group = new THREE.Group();
    for (let io = 0; io < rows; io++) {
      const row = new THREE.Mesh(new THREE.BoxGeometry(length, 0.55, 1.5), standMat);
      row.position.set(0, 0.28 + io * 0.55, -io * 1.5);
      row.castShadow = true;
      row.receiveShadow = true;
      group.add(row);
    }
    const height = 0.28 + rows * 0.55;
    const people = new THREE.Mesh(new THREE.PlaneGeometry(length * 0.97, height * 1.05), crowdMat);
    people.rotation.x = -Math.PI / 2.55;
    people.position.set(0, height * 0.62, -rows * 0.75 - 1.0);
    group.add(people);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(length + 1.4, 0.25, rows * 1.5 + 3), roofMat);
    roof.position.set(0, height + 2.1, -rows * 0.75 - 0.6);
    roof.castShadow = true;
    roof.receiveShadow = true;
    group.add(roof);

    // fasia merah di tepi atap (menghadap lintasan)
    const fascia = new THREE.Mesh(new THREE.BoxGeometry(length + 1.4, 0.5, 0.18), fasciaMat);
    fascia.position.set(0, height + 1.85, rows * 0.75 + 0.92);
    group.add(fascia);
    for (const sign of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.3, height + 2.1, 0.3), standMat);
      leg.position.set(sign * (length / 2 - 0.4), (height + 2.1) / 2, -(rows * 1.5 + 0.2));
      group.add(leg);
      const legFront = new THREE.Mesh(new THREE.BoxGeometry(0.3, height + 2.1, 0.3), standMat);
      legFront.position.set(sign * (length / 2 - 0.4), (height + 2.1) / 2, 0.6);
      group.add(legFront);
    }

    // Penonton 3D sungguhan di tiap baris (instanced: 1 draw call per tribun).
    // Tekstur kerumunan tetap dipasang di belakang sebagai latar.
    const spacing = 0.62;
    const perRow = Math.max(4, Math.floor((length - 1) / spacing));
    const fans = new THREE.InstancedMesh(spectatorGeometry(), fanMat, perRow * rows);
    fans.castShadow = false;
    fans.receiveShadow = true;
    let index = 0;
    const matrix = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3(1, 1, 1);
    const pos = new THREE.Vector3();
    const color = new THREE.Color();
    for (let io = 0; io < rows; io++) {
      for (let i = 0; i < perRow; i++) {
        pos.set(
          -(length - 1) / 2 + 0.3 + i * spacing + (Math.random() - 0.5) * 0.16,
          0.55 + io * 0.55,
          -io * 1.5 + 0.05 + (Math.random() - 0.5) * 0.2,
        );
        quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (Math.random() - 0.5) * 0.6);
        const s2 = 0.92 + Math.random() * 0.22;
        scale.set(s2, 0.9 + Math.random() * 0.2, s2);
        fans.setMatrixAt(index, matrix.compose(pos, quat, scale));
        color.setHex(spectatorColors[Math.floor(Math.random() * spectatorColors.length)]);
        fans.setColorAt(index, color);
        index++;
      }
    }
    fans.instanceMatrix.needsUpdate = true;
    if (fans.instanceColor) fans.instanceColor.needsUpdate = true;
    group.add(fans);
    return group;
  };

  for (const stand of [
    { length: 34, rows: 7, distance: START_DIST - 16, extra: 6.5 },
    { length: 20, rows: 5, distance: START_DIST + 74, extra: 7.5 },
  ]) {
    place(makeStand(stand.length, stand.rows), pointAt(MAIN, stand.distance), -1, stand.extra);
  }

  /* ---------------- race control tower ---------------- */
  const tower = new THREE.Group();
  const towerMat = toon({ color: 0x59636f, roughness: 0.7 });
  const shaft = new THREE.Mesh(new THREE.BoxGeometry(3.6, 11, 3.6), towerMat);
  shaft.position.y = 5.5;
  shaft.castShadow = true;
  tower.add(shaft);
  const cab = new THREE.Mesh(
    new THREE.CylinderGeometry(3.1, 3.1, 2.4, 8),
    toon({
      color: 0x16212c,
      roughness: 0.18,
      metalness: 0.5,
      envMapIntensity: 1.8,
    }),
  );
  cab.position.y = 12.1;
  cab.castShadow = true;
  tower.add(cab);
  const towerSign = new THREE.Mesh(
    new THREE.PlaneGeometry(5.2, 1.1),
    toon({
      map: bannerTexture('RACE CONTROL', '#0b1420', '#7fe3ff'),
      roughness: 0.7,
      side: THREE.DoubleSide,
    }),
  );
  towerSign.position.set(0, 8.2, 2.3);
  tower.add(towerSign);
  place(tower, pointAt(MAIN, START_DIST - 34), -1, 15);

  /* ---------------- marshal posts + flags ---------------- */
  const hutMat = toon({ color: 0xd8dde4, roughness: 0.8 });
  const flagMats = [
    toon({ color: 0xffcc22, roughness: 0.9, side: THREE.DoubleSide }),
    toon({ color: 0x2f7fe0, roughness: 0.9, side: THREE.DoubleSide }),
    toon({ color: 0xd8342a, roughness: 0.9, side: THREE.DoubleSide }),
    toon({ color: 0xf2f4f7, roughness: 0.9, side: THREE.DoubleSide }),
  ];
  const poleMat = toon({ color: 0xc7ccd3, metalness: 0.6, roughness: 0.4 });
  for (const zone of cornerSections(MAIN, 1 / 80)) {
    const p = pointAt(MAIN, (zone.from + zone.to) / 2);
    const base = offsetPoint(p, -1, 10.5);
    const post = new THREE.Group();
    const hut = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.2, 2.2), hutMat);
    hut.position.y = 1.1;
    hut.castShadow = true;
    post.add(hut);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 5, 6), poleMat);
    pole.position.set(1.4, 2.5, 0.6);
    post.add(pole);
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.0), flagMats[flags.length % flagMats.length]);
    // Bendera dianimasikan per mesh, jadi tidak boleh ikut digabung.
    flag.userData.noMerge = true;
    flag.position.set(2.2, 4.5, 0.6);
    post.add(flag);
    flags.push(flag);
    place(post, p, -1, 10.5);
    base.y = 0;
  }

  /* ---------------- floodlight masts ---------------- */
  const mastMat = toon({ color: 0x39424c, roughness: 0.6, metalness: 0.5 });
  const lampHeadMat = toon({
    color: 0xf4f6f8,
    emissive: 0xfff3d6,
    emissiveIntensity: 0.55,
    roughness: 0.4,
  });
  for (let i = 0; i < 6; i++) {
    const d = (i / 6) * MAIN_LENGTH + 40;
    const p = pointAt(MAIN, d);
    const sideSign = i % 2 === 0 ? -1 : 1;
    const mast = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.3, 15, 8), mastMat);
    trunk.position.y = 7.5;
    trunk.castShadow = true;
    mast.add(trunk);
    const head = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.5, 1.2), mastMat);
    head.position.y = 15.1;
    mast.add(head);
    for (let k = -1; k <= 1; k++) {
      const bulb = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.22, 0.9), lampHeadMat);
      bulb.position.set(k * 0.85, 14.78, 0.1);
      mast.add(bulb);
    }
    const placed = place(mast, p, sideSign, 17);
    placed.rotation.x = 0;
  }

  /* ---------------- paddock in the infield ---------------- */
  const paddock = new THREE.Group();
  const apron = new THREE.Mesh(
    new THREE.PlaneGeometry(64, 38),
    toon({ map: asphalt.clone(), roughness: 0.95 }),
  );
  apron.material.map!.repeat.set(10, 6);
  apron.rotation.x = -Math.PI / 2;
  apron.position.set(62, 0.008, 4);
  apron.receiveShadow = true;
  paddock.add(apron);

  const tentMat = toon({ color: 0xeef1f4, roughness: 0.85 });
  const awningMat = toon({
    color: 0xd8342a,
    roughness: 0.85,
    side: THREE.DoubleSide,
  });
  const makeTent = (w: number, d: number, name: string) => {
    const g = new THREE.Group();
    const box = new THREE.Mesh(new THREE.BoxGeometry(w, 3, d), tentMat);
    box.position.y = 1.5;
    box.castShadow = true;
    box.receiveShadow = true;
    g.add(box);
    for (const sign of [-1, 1]) {
      const slope = new THREE.Mesh(new THREE.PlaneGeometry(w + 0.6, d * 0.62), awningMat);
      slope.position.set(0, 3 + 0.3, (sign * d) / 4);
      slope.rotation.x = sign > 0 ? Math.PI / 2 - 0.32 : -Math.PI / 2 + 0.32;
      slope.castShadow = true;
      g.add(slope);
    }
    const signBoard = new THREE.Mesh(
      new THREE.PlaneGeometry(Math.min(6, w - 1), 1),
      toon({
        map: bannerTexture(name, '#132033', '#ffd24a'),
        roughness: 0.8,
        side: THREE.DoubleSide,
      }),
    );
    signBoard.position.set(0, 2.4, d / 2 + 0.02);
    g.add(signBoard);
    return g;
  };
  const tents: Array<[number, number, number, string]> = [
    [50, -6, 0.2, 'TEAM NORD'],
    [72, -8, -0.15, 'GRAVEL KING'],
    [56, 18, Math.PI / 2, 'SERVICE'],
    [80, 14, 0.1, 'NITRO OIL'],
  ];
  for (const [x, z, rot, name] of tents) {
    const tent = makeTent(13, 9, name);
    tent.position.set(x, 0, z);
    tent.rotation.y = rot;
    paddock.add(tent);
  }

  /* a couple of service trucks */
  const truckBodyMat = toon({ color: 0xf0f2f5, roughness: 0.7 });
  const truckCabMat = toon({ color: 0x1f4f8a, roughness: 0.5, metalness: 0.3 });
  for (const [x, z, rot] of [
    [66, 12, 0.3],
    [88, 2, -0.2],
  ] as Array<[number, number, number]>) {
    const truck = new THREE.Group();
    const trailer = new THREE.Mesh(new THREE.BoxGeometry(9, 3, 2.6), truckBodyMat);
    trailer.position.set(-1.5, 2.2, 0);
    trailer.castShadow = true;
    truck.add(trailer);
    const cabUnit = new THREE.Mesh(new THREE.BoxGeometry(2.6, 2.4, 2.5), truckCabMat);
    cabUnit.position.set(4.4, 1.7, 0);
    cabUnit.castShadow = true;
    truck.add(cabUnit);
    for (const wx of [-4.2, -1.2, 4.4]) {
      for (const wz of [-1.15, 1.15]) {
        const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.42, 12), tyreMat);
        wheel.rotation.x = Math.PI / 2;
        wheel.position.set(wx, 0.62, wz);
        truck.add(wheel);
      }
    }
    truck.position.set(x, 0, z);
    truck.rotation.y = rot;
    paddock.add(truck);
  }
  scene.add(paddock);

  /* ---------------- trees around the venue ---------------- */
  const trunkGeo = new THREE.CylinderGeometry(0.18, 0.26, 2.2, 6);
  const crownGeo = new THREE.ConeGeometry(1.9, 5.2, 7);
  const trunkMat = toon({ color: PALETTE.trunk });
  const crownMat = toon({ color: PALETTE.leaf });
  const treeCount = detail ? 190 : 90;
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, treeCount);
  const crowns = new THREE.InstancedMesh(crownGeo, crownMat, treeCount);
  crowns.castShadow = true;

  const trackCentre = new THREE.Vector3(66, 0, 10);
  const farFromTrack = (x: number, z: number, min: number) => {
    const probe = new THREE.Vector3(x, 0, z);
    for (const s of MAIN) if (s.pos.distanceToSquared(probe) < min * min) return false;
    for (const s of JOKER) if (s.pos.distanceToSquared(probe) < min * min) return false;
    return true;
  };
  let planted = 0;
  let guard = 0;
  while (planted < treeCount && guard++ < 6000) {
    const angle = Math.random() * Math.PI * 2;
    const radius = 120 + Math.random() * 190;
    const x = trackCentre.x + Math.cos(angle) * radius;
    const z = trackCentre.z + Math.sin(angle) * radius * 0.85;
    if (!farFromTrack(x, z, 24)) continue;
    const h = 0.8 + Math.random() * 0.7;
    quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * Math.PI * 2);
    m4.compose(new THREE.Vector3(x, 1.1 * h, z), quat, new THREE.Vector3(h, h, h));
    trunks.setMatrixAt(planted, m4);
    m4.compose(new THREE.Vector3(x, 3.4 * h, z), quat, new THREE.Vector3(h, h, h));
    crowns.setMatrixAt(planted, m4);
    planted++;
  }
  trunks.count = planted;
  crowns.count = planted;
  trunks.instanceMatrix.needsUpdate = true;
  crowns.instanceMatrix.needsUpdate = true;
  scene.add(trunks, crowns);

  /* ---------------- rumput liar + bukit + awan (kedalaman) ---------------- */
  {
    // Rumpun rumput di tepi: menjaga permukaan rumput tidak terlihat seperti
    // karpet rata kalau dilihat dari kamera heli.
    const tuftGeo = new THREE.ConeGeometry(0.24, 0.55, 4);
    const tuftMat = toon({ color: 0x53953a });
    const tuftCount = detail ? 1100 : 300;
    const tufts = new THREE.InstancedMesh(tuftGeo, tuftMat, tuftCount);
    tufts.castShadow = false;
    let placedTufts = 0;
    let guardTuft = 0;
    while (placedTufts < tuftCount && guardTuft++ < 12000) {
      const angle = Math.random() * Math.PI * 2;
      const radius = 26 + Math.random() * 190;
      const x = trackCentre.x + Math.cos(angle) * radius;
      const z = trackCentre.z + Math.sin(angle) * radius * 0.9;
      if (!farFromTrack(x, z, 9)) continue;
      const h = 0.7 + Math.random() * 0.9;
      quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * Math.PI * 2);
      m4.compose(
        new THREE.Vector3(x, 0.24 * h, z),
        quat,
        new THREE.Vector3(h, h, h),
      );
      tufts.setMatrixAt(placedTufts, m4);
      placedTufts++;
    }
    tufts.count = placedTufts;
    tufts.instanceMatrix.needsUpdate = true;
    scene.add(tufts);

    // Dua lapis bukit di horizon: dalam (kehijauan berkabut) dan luar (kebiruan).
    // Tanpa ini, dunia terlihat seperti piringan rumput dengan tepi.
    const hillRings: Array<{ radius: number; color: number; count: number; tall: number }> = [
      { radius: 286, color: 0x7fa586, count: 26, tall: 34 },
      { radius: 330, color: 0xa8c6d0, count: 22, tall: 52 },
    ];
    for (const ring of hillRings) {
      const hillMat = toon({ color: ring.color, fog: false });
      const hills = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 1, 7), hillMat, ring.count);
      hills.castShadow = false;
      hills.receiveShadow = false;
      for (let i = 0; i < ring.count; i++) {
        const angle = (i / ring.count) * Math.PI * 2 + Math.random() * 0.12;
        const radius = ring.radius * (0.9 + Math.random() * 0.22);
        const wide = 38 + Math.random() * 52;
        const tall = ring.tall * (0.55 + Math.random() * 0.8);
        quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * Math.PI * 2);
        m4.compose(
          new THREE.Vector3(
            trackCentre.x + Math.cos(angle) * radius,
            -8,
            trackCentre.z + Math.sin(angle) * radius * 0.9,
          ),
          quat,
          new THREE.Vector3(wide, tall, wide * (0.7 + Math.random() * 0.6)),
        );
        hills.setMatrixAt(i, m4);
      }
      hills.instanceMatrix.needsUpdate = true;
      scene.add(hills);
    }

    // Awan kartun: gumpalan bola pipih (bukan billboard, jadi tidak perlu
    // di-orientasi tiap frame) di ketinggian 85–125 m.
    const cloudMat = toon({ color: 0xffffff, fog: false });
    const puffGeo = new THREE.SphereGeometry(1, 9, 7);
    const clusters = detail ? 7 : 3;
    const puffs = new THREE.InstancedMesh(puffGeo, cloudMat, clusters * 6);
    let puffIndex = 0;
    for (let c = 0; c < clusters; c++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = 165 + Math.random() * 155;
      const cx = trackCentre.x + Math.cos(angle) * radius;
      const cz = trackCentre.z + Math.sin(angle) * radius * 0.9;
      const cy = 118 + Math.random() * 42;
      const spread = 9 + Math.random() * 7;
      for (let p = 0; p < 6; p++) {
        const scale = (4.5 + Math.random() * 5) * (p === 0 ? 1.5 : 1);
        quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * Math.PI * 2);
        m4.compose(
          new THREE.Vector3(
            cx + (Math.random() - 0.5) * spread * 2,
            cy + (Math.random() - 0.5) * spread * 0.5,
            cz + (Math.random() - 0.5) * spread * 2,
          ),
          quat,
          new THREE.Vector3(scale, scale * 0.5, scale * 0.9),
        );
        puffs.setMatrixAt(puffIndex++, m4);
      }
    }
    puffs.count = puffIndex;
    puffs.instanceMatrix.needsUpdate = true;
    puffs.frustumCulled = false;
    scene.add(puffs);
  }

  /* ---------------- gapura sponsor di atas lintasan ---------------- */
  {
    // Tiga gapura (rallycross selalu punya ini): dua kaki di luar pagar, balok
    // melintang, dan spanduk menggantung di atas trek. Titiknya dicari di
    // bagian trek yang datar & lurus, bukan di puncak lompatan.
    const archMat = toon({ color: 0x2f3742 });
    const lapLength = MAIN[MAIN.length - 1].distance;
    const arches: Array<[number, string, string, string]> = [
      [0.18, 'NITRO OIL', '#0f3f2c', '#d8f0c8'],
      [0.47, 'GRAVEL KING', '#8c1f14', '#f6e7c9'],
      [0.76, 'TURBO', '#b3202c', '#fff1f1'],
    ];
    for (const [fraction, name, bg, fg] of arches) {
      const target = fraction * lapLength;
      let bestSample = MAIN[0];
      let bestScore = Infinity;
      for (const sample of MAIN) {
        const gap = Math.abs(sample.distance - target);
        if (gap > 26) continue;
        const score = Math.abs(sample.pos.y) * 2 + Math.abs(sample.curvature) * 120 + gap * 0.05;
        if (score < bestScore) {
          bestScore = score;
          bestSample = sample;
        }
      }
      const point = bestSample;
      const span = point.halfWidth + 1.7;
      for (const sign of [-1, 1]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.34, 7.6, 0.34), archMat);
        leg.position.copy(point.pos).addScaledVector(point.side, sign * span);
        leg.position.y = point.pos.y + 3.8;
        leg.castShadow = true;
        scene.add(leg);
      }
      const beam = new THREE.Mesh(new THREE.BoxGeometry(span * 2 + 0.5, 0.55, 0.46), archMat);
      beam.position.copy(point.pos);
      beam.position.y = point.pos.y + 7.35;
      beam.rotation.y = Math.atan2(-point.side.z, point.side.x);
      beam.castShadow = true;
      scene.add(beam);

      const banner = new THREE.Mesh(
        new THREE.PlaneGeometry(span * 1.5, 1.5),
        toon({
          map: bannerTexture(name, bg, fg),
          side: THREE.DoubleSide,
          roughness: 0.85,
        }),
      );
      banner.position.copy(point.pos);
      banner.position.y = point.pos.y + 6.4;
      banner.rotation.y = facing(point.tangent.clone().negate());
      scene.add(banner);
    }
  }

  /* ---------------- joker signs ---------------- */
  const jokerPoint = pointAt(MAIN, MAIN[nearestSample(MAIN, JOKER_START)].distance - 14);
  const jokerSign = new THREE.Mesh(
    new THREE.PlaneGeometry(5.2, 1.8),
    toon({
      map: bannerTexture('JOKER', '#101720', '#ffb02e'),
      roughness: 0.8,
      side: THREE.DoubleSide,
    }),
  );
  const signPos = offsetPoint(jokerPoint, 1, 3.2);
  jokerSign.position.set(signPos.x, 3.2, signPos.z);
  jokerSign.rotation.y = facing(jokerPoint.tangent.clone().negate());
  scene.add(jokerSign);
  for (const sign of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.18, 2.6, 0.18), steelMat);
    leg.position.copy(jokerSign.position).addScaledVector(jokerPoint.side, sign * 2.2);
    leg.position.y = 1.3;
    scene.add(leg);
  }

  // Semua prop statis sudah dibuat: satukan per material.
  mergeStaticProps(scene);

  /* ---------------- animation ---------------- */
  let clock = 0;
  return {
    update(dt: number) {
      clock += dt;
      const cycle = clock % 9;
      startLampMat.emissiveIntensity = cycle < 3 ? 4.2 : 0;
      for (let i = 0; i < flags.length; i++) {
        flags[i].rotation.y = Math.sin(clock * 2.2 + i) * 0.35;
      }
    },
  };
}

/** Convenience for the browser: colliders + meshes in one call. */
export function buildTrack(
  world: RAPIER.World,
  scene: THREE.Scene,
  detail = true,
): TrackHandle {
  buildTrackColliders(world);
  return buildTrackVisuals(scene, detail);
}

/** Take-off crest of every jump on the lap, in lap order. */
export const JUMPS = (() => {
  const out: Array<{ distance: number; pos: THREE.Vector3; tangent: THREE.Vector3; height: number }> = [];
  for (let i = 1; i < MAIN.length - 1; i++) {
    const y = MAIN[i].pos.y;
    const height = y - ROAD_LIFT;
    if (height < 0.5) continue;
    if (y < MAIN[i - 1].pos.y || y < MAIN[i + 1].pos.y) continue; // local peak only
    const last = out[out.length - 1];
    if (last && MAIN[i].distance - last.distance < 25) continue;
    out.push({
      distance: MAIN[i].distance,
      pos: MAIN[i].pos.clone(),
      tangent: MAIN[i].tangent.clone(),
      height,
    });
  }
  return out;
})();

/** Exposed for the headless smoke tests. */
export const TRACK = {
  main: MAIN,
  joker: JOKER,
  cameras: BROADCAST_SPOTS,
  length: MAIN_LENGTH,
  start: START_DIST,
  jumps: JUMPS,
  /** Pose on the racing line `distance` metres into the lap. */
  at(distance: number): {
    pos: THREE.Vector3;
    tangent: THREE.Vector3;
    side: THREE.Vector3;
    yaw: number;
  } {
    const p = pointAt(MAIN, distance);
    return {
      pos: p.pos.clone(),
      tangent: p.tangent.clone(),
      side: p.side.clone(),
      yaw: Math.atan2(p.tangent.x, p.tangent.z),
    };
  },
};

/* ------------------------------------------------------------------ */
/* pit / service area                                                  */
/* ------------------------------------------------------------------ */

/** Pit lane: aspal servis di sisi dalam trek, sejajar garis start. */
const PIT_FROM = START_DIST - 40;
const PIT_TO = START_DIST + 24;
/** Jarak dari tepi aspal balap ke bibir dalam apron, meter. */
const PIT_INNER = 0.4;
/** Lebar apron, meter. */
const PIT_OUTER = 10.6;
/** Berapa kotak servis yang tersedia (pemain + lima lawan). */
export const PIT_BOX_COUNT = 6;

export interface PitBoxPose {
  index: number;
  /** Titik tengah kotak servis. */
  position: THREE.Vector3;
  yaw: number;
  /** Jarak lap tempat kotak ini berada (untuk masuk/keluar jalur). */
  distance: number;
}

/** Pita aspal datar: dua tepi (dalam/luar) mengikuti garis trek. */
function apronRibbon(from: number, to: number, inner: number, outer: number, y: number) {
  const positions: number[] = [];
  const uvs: number[] = [];
  const distances: number[] = [];
  const indices: number[] = [];
  const samples = MAIN.filter((s) => s.distance >= from && s.distance <= to);
  for (const s of samples) {
    for (const off of [inner, outer]) {
      const p = s.pos.clone().addScaledVector(s.side, s.halfWidth + off);
      positions.push(p.x, y, p.z);
      uvs.push(s.distance * 0.12, off * 0.15);
      distances.push(s.distance);
    }
  }
  for (let k = 0; k < samples.length - 1; k++) {
    const i = k * 2;
    indices.push(i, i + 1, i + 3, i, i + 3, i + 2);
  }
  return { positions, uvs, distances, indices };
}

/**
 * Pita aspal kecil antara dua jarak (bukan deretan sampel): dipakai untuk
 * marka tipis — garis tepi, pita masuk/keluar — yang kalau diambil dari
 * `MAIN` bisa jatuh di antara dua sampel dan jadi tak terlihat.
 */
function paintBand(from: number, to: number, inner: number, outer: number, y: number) {
  const positions: number[] = [];
  const uvs: number[] = [];
  const distances: number[] = [];
  const indices: number[] = [];
  for (const distance of [from, to]) {
    const s = pointAt(MAIN, distance);
    for (const off of [inner, outer]) {
      const p = s.pos.clone().addScaledVector(s.side, s.halfWidth + off);
      positions.push(p.x, y, p.z);
      uvs.push(distance * 0.12, off * 0.15);
      distances.push(distance);
    }
  }
  indices.push(0, 1, 3, 0, 3, 2);
  return { positions, uvs, distances, indices };
}

/** Pita marka yang dipecah jadi beberapa potong supaya mengikuti tikungan. */
function paintStrip(from: number, to: number, inner: number, outer: number, y: number, pieces = 6) {
  const ribbon: { positions: number[]; uvs: number[]; distances: number[]; indices: number[] } = {
    positions: [],
    uvs: [],
    distances: [],
    indices: [],
  };
  for (let i = 0; i < pieces; i++) {
    const a = from + ((to - from) * i) / pieces;
    const b = from + ((to - from) * (i + 1)) / pieces;
    const band = paintBand(a, b, inner, outer, y);
    const base = ribbon.positions.length / 3;
    for (let k = 0; k < band.positions.length; k += 3) {
      ribbon.positions.push(band.positions[k], band.positions[k + 1], band.positions[k + 2]);
      ribbon.uvs.push(band.uvs[(k / 3) * 2], band.uvs[(k / 3) * 2 + 1]);
      ribbon.distances.push(band.distances[k / 3]);
    }
    for (const index of band.indices) ribbon.indices.push(base + index);
  }
  return ribbon;
}

/**
 * Area servis (pit) — satu kotak per mobil. Bentuknya apron aspal yang
 * menempel di sisi dalam lintasan lurus start, jadi mobil bisa masuk dan keluar
 * tanpa gerbang: persis seperti service park rallycross.
 */
/** Pose di area servis: `distance` pada jalur balap, `lateral` meter dari tepi aspal. */
export function pitPose(distance: number, lateral: number): { position: THREE.Vector3; yaw: number } {
  const s = pointAt(MAIN, distance);
  const pos = s.pos.clone().addScaledVector(s.side, s.halfWidth + lateral);
  return {
    position: new THREE.Vector3(pos.x, ROAD_LIFT + 0.012, pos.z),
    yaw: Math.atan2(s.tangent.x, s.tangent.z),
  };
}

export const PIT = (() => {
  const y = ROAD_LIFT + 0.012;
  const apron = apronRibbon(PIT_FROM, PIT_TO, PIT_INNER, PIT_OUTER, y);
  const boxes: PitBoxPose[] = [];
  for (let i = 0; i < PIT_BOX_COUNT; i++) {
    const distance = PIT_FROM + 15 + i * 7.4;
    const s = pointAt(MAIN, distance);
    const pos = s.pos.clone().addScaledVector(s.side, s.halfWidth + 5.8);
    boxes.push({
      index: i,
      position: new THREE.Vector3(pos.x, y, pos.z),
      yaw: Math.atan2(s.tangent.x, s.tangent.z),
      distance,
    });
  }
  return {
    from: PIT_FROM,
    to: PIT_TO,
    y,
    apron,
    boxes,
    /** Titik di garis balap tempat mobil kembali setelah servis. */
    rejoin: pointAt(MAIN, PIT_TO - 8),
    /** Titik di garis balap sebelum apron: awal jalur masuk. */
    approach: pointAt(MAIN, PIT_FROM - 14),
  };
})();
