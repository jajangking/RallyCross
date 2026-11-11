import * as THREE from 'three';

/**
 * Geometry of the rallycross circuit. Everything here is pure math on
 * `THREE.Vector3`s, so the same description drives the Rapier colliders and the
 * three.js meshes (and it can be exercised from Node without a DOM).
 *
 * A circuit is a closed centreline (Catmull-Rom through the control nodes) plus
 * per-sample surface and width. From that we derive:
 *   - the driving ribbon, split into one mesh/collider per surface,
 *   - grass verges that blend the road back into the ground plane,
 *   - painted lines, kerbs and barrier walls as offset ribbons.
 */

export type Surface = 'tarmac' | 'gravel';

export interface PathNode {
  x: number;
  z: number;
  /** Elevation of the centreline, metres. Default 0. */
  y?: number;
  /** Full width of the road at this node, metres. Default 14. */
  width?: number;
  /** Surface from this node onwards. Default `tarmac`. */
  surface?: Surface;
}

export interface PathSample {
  pos: THREE.Vector3;
  /** Unit tangent, pointing in the racing direction. */
  tangent: THREE.Vector3;
  /** Unit horizontal vector pointing to the right of the direction of travel. */
  side: THREE.Vector3;
  halfWidth: number;
  surface: Surface;
  /** Distance along the lap, metres. */
  distance: number;
  /** Signed curvature (1/m); positive = turning left. */
  curvature: number;
}

export interface Ribbon {
  positions: number[];
  uvs: number[];
  /** Distance along the lap for every sample (for texturing). */
  distances: number[];
  indices: number[];
}

const UP = new THREE.Vector3(0, 1, 0);

function nodePoint(n: PathNode) {
  return new THREE.Vector3(n.x, n.y ?? 0, n.z);
}

/**
 * Samples the centreline at a fixed spacing and resolves the per-sample
 * surface/width from the control nodes. Node parameters are found by arc
 * length (not by index) so a long straight does not swallow its neighbours.
 */
export function samplePath(nodes: PathNode[], spacing = 1.5, closed = true): PathSample[] {
  const curve = new THREE.CatmullRomCurve3(nodes.map(nodePoint), closed, 'catmullrom', 0.5);
  curve.arcLengthDivisions = 4000;
  const total = curve.getLength();
  const count = Math.max(8, Math.round(total / spacing));

  const points = curve.getSpacedPoints(count); // count + 1 points, last == first
  const samples: PathSample[] = [];

  // arc length of every node, so surfaces/widths can be interpolated by distance
  const nodeDist: number[] = [];
  const fine = 400 * nodes.length;
  let best = { d: Infinity, u: 0 };
  for (let n = 0; n < nodes.length; n++) {
    const p = nodePoint(nodes[n]);
    best = { d: Infinity, u: 0 };
    for (let i = 0; i <= fine; i++) {
      const u = i / fine;
      const d = curve.getPointAt(u).distanceToSquared(p);
      if (d < best.d) best = { d, u };
    }
    nodeDist.push(best.u * total);
  }

  // surfaces are sticky: a node keeps the surface of the previous explicit one,
  // so `gravel` stays on until a node says `tarmac` again. For a closed lap the
  // first node inherits from the last explicit surface before the seam.
  const nodeSurface: Surface[] = [];
  {
    let last: Surface = 'tarmac';
    if (closed) {
      for (let n = nodes.length - 1; n >= 0; n--) {
        if (nodes[n].surface) {
          last = nodes[n].surface as Surface;
          break;
        }
      }
    }
    for (let n = 0; n < nodes.length; n++) {
      if (nodes[n].surface) last = nodes[n].surface as Surface;
      nodeSurface.push(last);
    }
  }

  const tangent = new THREE.Vector3();
  const prev = new THREE.Vector3();
  const next = new THREE.Vector3();

  for (let i = 0; i <= count; i++) {
    const u = i / count;
    const pos = points[i].clone();
    curve.getTangentAt(Math.min(u, 1), tangent);
    tangent.y = 0;
    tangent.normalize();
    const side = new THREE.Vector3().crossVectors(UP, tangent).normalize();

    const distance = u * total;
    // which node interval are we in?
    let seg = nodes.length - 1;
    for (let n = 0; n < nodes.length; n++) {
      const a = nodeDist[n];
      const b = n + 1 < nodes.length || closed ? (n + 1 < nodes.length ? nodeDist[n + 1] : total) : total;
      if (distance >= a && distance < b) {
        seg = n;
        break;
      }
    }
    const a = nodeDist[seg];
    const b = seg + 1 < nodes.length ? nodeDist[seg + 1] : total;
    const f = b > a ? THREE.MathUtils.clamp((distance - a) / (b - a), 0, 1) : 0;
    const cur = nodes[seg];
    const nxt = nodes[Math.min(seg + 1, nodes.length - 1)];
    const width = (cur.width ?? 14) * (1 - f) + (nxt.width ?? 14) * f;

    samples.push({
      pos,
      tangent: tangent.clone(),
      side,
      halfWidth: width / 2,
      surface: nodeSurface[seg],
      distance,
      curvature: 0,
    });
  }

  // curvature from the tangent turn rate
  for (let i = 0; i < samples.length; i++) {
    const a = samples[(i - 1 + samples.length) % samples.length];
    const b = samples[(i + 1) % samples.length];
    prev.copy(a.pos);
    next.copy(b.pos);
    const chord = prev.distanceTo(next);
    if (chord < 1e-4) continue;
    const turn = Math.atan2(
      a.tangent.x * b.tangent.z - a.tangent.z * b.tangent.x,
      a.tangent.x * b.tangent.x + a.tangent.z * b.tangent.z,
    );
    samples[i].curvature = -turn / chord;
  }
  // smooth the curvature so kerbs do not flicker on/off
  const smooth = samples.map((_s, i) => {
    let sum = 0;
    let n = 0;
    for (let k = -3; k <= 3; k++) {
      sum += samples[(i + k + samples.length) % samples.length].curvature;
      n++;
    }
    return sum / n;
  });
  samples.forEach((s, i) => (s.curvature = smooth[i]));

  return samples;
}

/** Flat ribbon between two offsets from the centreline. */
function ribbonBetween(
  samples: PathSample[],
  inner: (s: PathSample) => number,
  outer: (s: PathSample) => number,
  surfaceOf: (s: PathSample) => Surface,
  yOf: (s: PathSample) => number = (s) => s.pos.y,
): Record<Surface, Ribbon> {
  const out: Record<Surface, Ribbon> = {
    tarmac: { positions: [], uvs: [], distances: [], indices: [] },
    gravel: { positions: [], uvs: [], distances: [], indices: [] },
  };
  const cursor = { tarmac: 0, gravel: 0 };

  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();

  // group consecutive samples of the same surface into one strip
  let start = 0;
  for (let i = 1; i <= samples.length; i++) {
    const end = i === samples.length || surfaceOf(samples[i]) !== surfaceOf(samples[start]);
    if (!end) continue;

    const surface = surfaceOf(samples[start]);
    const ribbon = out[surface];
    const base = cursor[surface];

    for (let k = start; k < i; k++) {
      const s = samples[k];
      tmpA.copy(s.pos).addScaledVector(s.side, inner(s));
      tmpB.copy(s.pos).addScaledVector(s.side, outer(s));
      tmpA.y = yOf(s);
      tmpB.y = yOf(s);
      ribbon.positions.push(tmpA.x, tmpA.y, tmpA.z, tmpB.x, tmpB.y, tmpB.z);
      // U melintang 0..1 (satu tekstur selebar trek: di sinilah jalur ban
      // dipanggang), V memakai jarak **meter**: satu petak tekstur = 12 m
      // sepanjang jalan, jadi butiran aspal tidak tertarik jadi garis panjang
      // seperti dulu (dulu V = jarak, artinya satu petak tiap 1 m).
      const tile = s.surface === 'gravel' ? 9 : 12;
      ribbon.uvs.push(0, s.distance / tile, 1, s.distance / tile);
      ribbon.distances.push(s.distance);
    }
    const verts = (i - start) * 2;
    for (let k = 0; k < (i - start) - 1; k++) {
      const a = base + k * 2;
      ribbon.indices.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
    cursor[surface] += verts;
    start = i;
  }

  return out;
}

/** The driving surface. `inner`/`outer` are the two edges of the road. */
export function roadRibbon(samples: PathSample[]): Record<Surface, Ribbon> {
  return ribbonBetween(
    samples,
    (s) => s.halfWidth,
    (s) => -s.halfWidth,
    (s) => s.surface,
  );
}

/**
 * Grass verge that carries the road edge down to the ground plane, so an
 * elevated crest does not look like a floating carpet.
 */
export function vergeRibbon(
  samples: PathSample[],
  outward: number | ((s: PathSample) => number) = 16,
  edgeY = 0.015,
  shoulder = 2.6,
): Ribbon {
  const out = typeof outward === 'function' ? outward : () => outward;
  const ribbon: Ribbon = { positions: [], uvs: [], distances: [], indices: [] };
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();

  // Two rows per side: a flat shoulder at road height (so a wheel that runs
  // wide does not catch a lip), then the grass falling away to the ground.
  for (const sideSign of [1, -1]) {
    const base = ribbon.positions.length / 3;
    for (const s of samples) {
      const width = Math.max(out(s), shoulder + 0.5);
      a.copy(s.pos).addScaledVector(s.side, sideSign * (s.halfWidth - 0.02));
      b.copy(s.pos).addScaledVector(s.side, sideSign * (s.halfWidth + shoulder));
      c.copy(s.pos).addScaledVector(s.side, sideSign * (s.halfWidth + width));
      ribbon.positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, edgeY, c.z);
      ribbon.uvs.push(a.x * 0.1, a.z * 0.1, b.x * 0.1, b.z * 0.1, c.x * 0.1, c.z * 0.1);
      ribbon.distances.push(s.distance, s.distance, s.distance);
    }
    for (let k = 0; k < samples.length - 1; k++) {
      const i = base + k * 3;
      ribbon.indices.push(i, i + 1, i + 4, i, i + 4, i + 3);
      ribbon.indices.push(i + 1, i + 2, i + 5, i + 1, i + 5, i + 4);
    }
  }

  return ribbon;
}

/** Narrow painted strip (lane line, kerb, start band) at a fixed offset. */
export function stripRibbon(
  samples: PathSample[],
  offset: number | ((s: PathSample) => number),
  width: number,
  lift = 0.012,
): Ribbon {
  const ribbon: Ribbon = { positions: [], uvs: [], distances: [], indices: [] };
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const at = typeof offset === 'function' ? offset : () => offset;
  for (const s of samples) {
    const o = at(s);
    a.copy(s.pos).addScaledVector(s.side, o + width / 2);
    b.copy(s.pos).addScaledVector(s.side, o - width / 2);
    a.y = s.pos.y + lift;
    b.y = s.pos.y + lift;
    ribbon.positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
    ribbon.uvs.push(0, s.distance * 0.25, 1, s.distance * 0.25);
    ribbon.distances.push(s.distance);
  }
  for (let k = 0; k < samples.length - 1; k++) {
    const i = k * 2;
    ribbon.indices.push(i, i + 1, i + 3, i, i + 3, i + 2);
  }
  return ribbon;
}

/** Vertical wall standing `offset` metres to one side of the centreline. */
export function wallRibbon(
  samples: PathSample[],
  offset: number,
  height: number,
  base = 0,
): Ribbon {
  const ribbon: Ribbon = { positions: [], uvs: [], distances: [], indices: [] };
  const p = new THREE.Vector3();
  for (const s of samples) {
    p.copy(s.pos).addScaledVector(s.side, offset);
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

/** Builds a three.js geometry and fixes the winding so normals face up/out. */
export function ribbonGeometry(ribbon: Ribbon, faceUp = true): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(ribbon.positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(ribbon.uvs, 2));
  geometry.setIndex(ribbon.indices);
  geometry.computeVertexNormals();

  const normal = geometry.getAttribute('normal');
  let sum = 0;
  for (let i = 0; i < normal.count; i++) sum += normal.getY(i);
  if ((faceUp && sum < 0) || (!faceUp && sum > 0)) {
    const index = geometry.getIndex()!;
    const arr = index.array as Uint32Array | Uint16Array;
    for (let i = 0; i < arr.length; i += 3) {
      const t = arr[i + 1];
      arr[i + 1] = arr[i + 2];
      arr[i + 2] = t;
    }
    index.needsUpdate = true;
    geometry.computeVertexNormals();
  }
  return geometry;
}

/** Section of the lap between two distances, for props along the track. */
export function slicePath(
  samples: PathSample[],
  from: number,
  to: number,
): PathSample[] {
  if (to >= from) return samples.filter((s) => s.distance >= from && s.distance <= to);
  return samples.filter((s) => s.distance >= from || s.distance <= to);
}

/* ------------------------------------------------------------------ */
/* the circuit itself                                                  */
/* ------------------------------------------------------------------ */

/**
 * Tata letak sirkuit: poligon tertutup 12 sudut, masing-masing dengan radius
 * fillet. Sirkuitnya **bolak-balik arah** (tiga kombinasi esses) dan radiusnya
 * bervariasi dari 15 m sampai 80 m, jadi tidak ada kesan oval sama sekali.
 *
 *   jarak  tikungan  arah    radius  sudut
 *      80  T1        kanan     26 m   76°
 *     192  T2        kanan     30 m   88°
 *     295  T3        kiri      18 m   38°   ┐ esses sempit: mobil harus
 *     322  T4        kanan     32 m   72°   ┘ berganti arah dua kali cepat
 *     401  T5        kiri      72 m   42°   sweeper cepat, hampir flat
 *     479  T6        kanan     80 m   78°   tikungan terpanjang (gravel)
 *     591  T7        kanan     22 m   50°
 *     644  T8        kiri      15 m   45°   ┐ hairpin kiri lalu kanan
 *     657  T9        kanan     35 m   95°   ┘
 *     729  T10       kiri      30 m   40°
 *     759  T11       kanan     40 m   96°   ← joker memotong busur ini
 *     835  T12       kiri      40 m   30°   keluar ke lurus start (95 m)
 *
 * Total 940 m. Garis start/finish di (0, 0) menghadap +Z, jadi infield selalu
 * di sisi `side` (+1) — sama seperti sebelumnya, semua prop tetap searah.
 */
export interface LayoutPoint {
  x: number;
  z: number;
  /** Radius fillet sudut ini, meter. 0 = titik lewat (lurus). */
  radius: number;
}

export const LAYOUT: readonly LayoutPoint[] = [
  // Ring dimulai di titik masuk T13, ±105 m **sebelum** garis start/finish, jadi
  // jarak 0 putaran berada jauh di belakang grid (sama seperti versi lama).
  { x: 0, z: -95.0, radius: 40 },
  { x: 0, z: 0, radius: 0 }, // garis start/finish di tengah lurus 175 m
  { x: 0, z: 100.36, radius: 26 },
  { x: 123.25, z: 131.09, radius: 30 },
  { x: 148.45, z: 43.23, radius: 18 },
  { x: 185.14, z: 16.56, radius: 32 },
  { x: 157.46, z: -68.64, radius: 72 },
  { x: 205.3, z: -176.08, radius: 80 },
  { x: 142.66, z: -221.59, radius: 22 },
  { x: 93.68, z: -209.37, radius: 15 },
  { x: 54.16, z: -233.12, radius: 35 },
  { x: 26.52, z: -176.45, radius: 30 },
  { x: -31.98, z: -150.4, radius: 40 },
];

/**
 * Ganti tiap sudut poligon dengan busur radius-nya (fillet), lalu sampel
 * busur + lurus tiap `spacing` meter. Semua hitungan, tanpa gambar tangan —
 * jadi kemiringan tangen di sambungan busur/lurus selalu kontinu.
 */
function filletLayout(points: readonly LayoutPoint[], spacing = 2.4): Array<{ x: number; z: number }> {
  const n = points.length;
  const corners = points.map((_, i) => {
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const v1x = p1.x - p0.x;
    const v1z = p1.z - p0.z;
    const v2x = p2.x - p1.x;
    const v2z = p2.z - p1.z;
    const l1 = Math.hypot(v1x, v1z);
    const l2 = Math.hypot(v2x, v2z);
    const u1x = v1x / l1;
    const u1z = v1z / l1;
    const u2x = v2x / l2;
    const u2z = v2z / l2;
    const turn = Math.atan2(u1x * u2z - u1z * u2x, Math.max(-1, Math.min(1, u1x * u2x + u1z * u2z)));
    const r = p1.radius;
    if (Math.abs(turn) < 1e-6 || r <= 0) {
      return { turn: 0, r: 0, ax: p1.x, az: p1.z, bx: p1.x, bz: p1.z, cx: p1.x, cz: p1.z };
    }
    const t = r * Math.tan(Math.abs(turn) / 2);
    const ax = p1.x - u1x * t;
    const az = p1.z - u1z * t;
    const bx = p1.x + u2x * t;
    const bz = p1.z + u2z * t;
    const sgn = turn > 0 ? 1 : -1;
    // pusat busur: dari titik tangent, tegak lurus arah masuk, ke sisi belokan
    const cx = ax - u1z * sgn * r;
    const cz = az + u1x * sgn * r;
    return { turn, r, ax, az, bx, bz, cx, cz };
  });

  // cek tabrakan tangent: total panjang tangent dua sudut bersebelahan tidak
  // boleh melebihi panjang sisi di antaranya
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const edge = Math.hypot(points[j].x - points[i].x, points[j].z - points[i].z);
    const need =
      corners[i].r * Math.tan(Math.abs(corners[i].turn) / 2) +
      corners[j].r * Math.tan(Math.abs(corners[j].turn) / 2);
    if (need > edge - 0.5) {
      throw new Error(`tata letak: tangent ${need.toFixed(1)} m > sisi ${edge.toFixed(1)} m (sudut ${i}-${j})`);
    }
  }

  const pts: Array<{ x: number; z: number }> = [];
  for (let i = 0; i < n; i++) {
    const c = corners[i];
    if (c.r > 0) {
      const a = Math.atan2(c.az - c.cz, c.ax - c.cx);
      const b = Math.atan2(c.bz - c.cz, c.bx - c.cx);
      let d = b - a;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      const steps = Math.max(2, Math.round((Math.abs(d) * c.r) / spacing));
      for (let k = 0; k <= steps; k++) {
        const ang = a + (d * k) / steps;
        pts.push({ x: c.cx + c.r * Math.cos(ang), z: c.cz + c.r * Math.sin(ang) });
      }
    } else {
      pts.push({ x: c.ax, z: c.az });
    }
    const nxt = corners[(i + 1) % n];
    const last = pts[pts.length - 1];
    const L = Math.hypot(nxt.ax - last.x, nxt.az - last.z);
    if (L > 1e-6) {
      const steps = Math.max(1, Math.round(L / spacing));
      for (let k = 1; k <= steps; k++) {
        const t = k / steps;
        pts.push({ x: last.x + (nxt.ax - last.x) * t, z: last.z + (nxt.az - last.z) * t });
      }
    }
  }
  // buang titik kembar (sambungan busur ke busur) supaya tangen tidak bergetar
  const out: Array<{ x: number; z: number }> = [pts[0]];
  for (const p of pts.slice(1)) {
    const prev = out[out.length - 1];
    if (Math.hypot(p.x - prev.x, p.z - prev.z) > 0.05) out.push(p);
  }
  if (out.length > 2 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].z - out[out.length - 1].z) < 0.05) out.pop();
  return out;
}

/**
 * Lebar trek per jarak (diinterpolasi linear, melingkar). Trek melebar di lurus
 * start supaya grid 6 mobil leluasa, menyempit di esses dan hairpin.
 */
const WIDTHS: ReadonlyArray<{ at: number; width: number }> = [
  { at: 0, width: 18 },
  { at: 70, width: 18 },
  { at: 110, width: 16.5 },
  { at: 200, width: 16 },
  { at: 280, width: 15 },
  { at: 305, width: 14.5 },
  { at: 340, width: 16 },
  { at: 400, width: 17 },
  { at: 470, width: 17 },
  { at: 540, width: 16 },
  { at: 600, width: 15 },
  { at: 640, width: 14.5 },
  { at: 680, width: 14.5 },
  { at: 730, width: 15.5 },
  { at: 780, width: 16.5 },
  { at: 880, width: 16.5 },
  { at: 920, width: 17 },
];

/** Permukaan mulai jarak ini. Dua gravel: keluar esses atas dan sektor T5-T6. */
const SURFACES: ReadonlyArray<{ at: number; surface: Surface }> = [
  { at: 0, surface: 'tarmac' },
  { at: 215, surface: 'gravel' },
  { at: 330, surface: 'tarmac' },
  { at: 470, surface: 'gravel' },
  { at: 600, surface: 'tarmac' },
];

/**
 * Lompatan: puncak di `at`. Tanjakan `rise` lurus (bibir tajam, seperti kicker
 * sungguhan) lalu turun sebagai kurva; mobil harus terlempar, bukan sekadar
 * menggelinding melewati gundukan.
 */
const BUMPS: ReadonlyArray<{ at: number; height: number; rise: number; fall: number }> = [
  { at: 150, height: 1.05, rise: 8, fall: 5 }, // jump besar, sesudah T1
  { at: 268, height: 0.55, rise: 6, fall: 3.4 }, // yump kecil di gravel
];

export const MAIN_NODES: PathNode[] = (() => {
  const ring = filletLayout(LAYOUT);
  const n = ring.length;
  const dist: number[] = [0];
  for (let i = 1; i <= n; i++) {
    const a = ring[i - 1];
    const b = ring[i % n];
    dist.push(dist[i - 1] + Math.hypot(b.x - a.x, b.z - a.z));
  }
  const total = dist[n];

  /** Lebar trek (interpolasi melingkar) pada jarak d. */
  const widthAt = (d: number): number => {
    for (let i = 0; i < WIDTHS.length; i++) {
      const a = WIDTHS[i];
      const b = WIDTHS[(i + 1) % WIDTHS.length];
      const bAt = i + 1 === WIDTHS.length ? WIDTHS[0].at + total : b.at;
      if (d >= a.at && d <= bAt) {
        const f = bAt - a.at < 1e-6 ? 0 : (d - a.at) / (bAt - a.at);
        return a.width + (b.width - a.width) * f;
      }
    }
    return WIDTHS[0].width;
  };
  const surfaceAt = (d: number): Surface => {
    let s: Surface = SURFACES[0].surface;
    for (const seg of SURFACES) {
      if (d >= seg.at) s = seg.surface;
    }
    return s;
  };
  const heightAt = (d: number): number => {
    let y = 0;
    for (const b of BUMPS) {
      // jarak melingkar bertanda ke puncak (negatif = masih di tanjakan)
      let dd = d - b.at;
      if (dd > total / 2) dd -= total;
      if (dd < -total / 2) dd += total;
      if (dd <= 0) y += b.height * Math.max(0, 1 + dd / b.rise);
      else y += b.height * Math.exp(-(dd * dd) / (2 * b.fall * b.fall));
    }
    return y;
  };

  // jarak garis start/finish di sepanjang putaran (vertex (0, 0))
  let line = 0;
  let bestLine = Infinity;
  for (let i = 0; i < n; i++) {
    const d2 = ring[i].x * ring[i].x + ring[i].z * ring[i].z;
    if (d2 < bestLine) {
      bestLine = d2;
      line = dist[i];
    }
  }
  /** jarak relatif terhadap garis start/finish, 0..total */
  const rel = (d: number): number => (((d - line) % total) + total) % total;

  const nodeAt = (x: number, z: number, d: number): PathNode => {
    const r = rel(d);
    const node: PathNode = { x, z, width: widthAt(r), surface: surfaceAt(r) };
    const y = heightAt(r);
    if (y > 0.005) node.y = y;
    return node;
  };

  // Puncak lompatan harus tajam, tapi node di lurus berjarak ~2,4 m — spline
  // akan menghaluskan crestnya sampai mobil tidak terlempar lagi. Jadi di
  // sekitar tiap lompatan node dirapatkan jadi ~0,7 m.
  const nearBump = (d: number): boolean => {
    const r = rel(d);
    return BUMPS.some((b) => {
      let dd = Math.abs(r - b.at);
      dd = Math.min(dd, total - dd);
      return dd < 16;
    });
  };

  const nodes: PathNode[] = [];
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const d = dist[i];
    nodes.push(nodeAt(a.x, a.z, d));
    const b = ring[(i + 1) % n];
    const bd = i + 1 < n ? dist[i + 1] : total;
    const len = bd - d;
    const dense = nearBump(d) || nearBump(bd);
    const steps = Math.max(1, dense ? Math.ceil(len / 0.7) : 1);
    for (let k = 1; k < steps; k++) {
      const f = k / steps;
      nodes.push(nodeAt(a.x + (b.x - a.x) * f, a.z + (b.z - a.z) * f, d + len * f));
    }
  }
  return nodes;
})();

/**
 * Joker lap di T11 (busur r = 40 m, pusat (24.9, -131.9), 96°): joker memakai
 * pusat yang sama dengan radius menyusut 16 m ke dalam di bagian tengah, lalu
 * kembali mulus ke r = 40 di kedua ujungnya (smoothstep → selisih dan
 * kemiringan nol di titik belah/gabung, jadi menyambung tangensial).
 *
 * Efeknya: 4 m lebih pendek, tapi radius efektifnya 24 m (bukan 40 m) dan
 * separuhnya gravel — jadi lebih lambat. Keputusan joker jadi taktis: jalan
 * pintas untuk menghindari trafik, dibayar dengan kecepatan keluar.
 */
export const JOKER_NODES: PathNode[] = (() => {
  const centre = { x: 24.87, z: -131.93 };
  const radius = 40; // radius busur T11
  const inset = 16;
  const taper = (24 * Math.PI) / 180;
  const th0 = (-114 * Math.PI) / 180; // titik belah
  const sweep = (-96 * Math.PI) / 180; // searah busur utama (searah jarum jam)
  const steps = 72;
  const nodes: PathNode[] = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const th = th0 + sweep * f;
    // jarak busur dari ujung (meter) → bobot taper
    let w: number | null = null;
    const arcFromStart = Math.abs(sweep) * radius * f;
    const arcToEnd = Math.abs(sweep) * radius * (1 - f);
    if (arcFromStart < taper * radius) w = arcFromStart / (taper * radius);
    else if (arcToEnd < taper * radius) w = arcToEnd / (taper * radius);
    const d = w === null ? inset : inset * (3 * w * w - 2 * w * w * w);
    const r = radius - d;
    nodes.push({
      x: centre.x + r * Math.cos(th),
      z: centre.z + r * Math.sin(th),
      width: f < 0.2 ? 9.5 : 10,
      surface: f < 0.25 ? 'gravel' : 'tarmac',
    });
  }
  return nodes;
})();
export const JOKER_START = new THREE.Vector3(24.87 + 40 * Math.cos((-114 * Math.PI) / 180), 0, -131.93 + 40 * Math.sin((-114 * Math.PI) / 180));
export const JOKER_END = new THREE.Vector3(
  24.87 + 40 * Math.cos(((-114 - 96) * Math.PI) / 180),
  0,
  -131.93 + 40 * Math.sin(((-114 - 96) * Math.PI) / 180),
);

/** Start/finish line: centre of the main straight, cars heading +Z. */
export const START = new THREE.Vector3(0, 0, 0);

/**
 * One drivable lap for the AI: the racing line, or the racing line with the
 * joker section spliced in. Distances are re-stamped so the result is a single
 * monotonic lap that the speed planner can walk.
 */
export function lapPath(main: PathSample[], joker: PathSample[], useJoker: boolean): PathSample[] {
  const restamp = (samples: PathSample[]): PathSample[] => {
    let d = 0;
    return samples.map((s, i) => {
      if (i > 0) d += s.pos.distanceTo(samples[i - 1].pos);
      return { ...s, distance: d };
    });
  };
  if (!useJoker || joker.length < 4) return restamp(main);
  const from = nearestSample(main, JOKER_START);
  const to = nearestSample(main, JOKER_END);
  if (to <= from + 2) return restamp(main);
  return restamp([...main.slice(0, from + 1), ...joker, ...main.slice(to)]);
}

/** Index of the sample closest to a point (used to place props). */
export function nearestSample(samples: PathSample[], point: THREE.Vector3): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < samples.length; i++) {
    const dx = samples[i].pos.x - point.x;
    const dz = samples[i].pos.z - point.z;
    const d = dx * dx + dz * dz;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
