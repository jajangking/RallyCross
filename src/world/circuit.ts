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
 * Lydden-Hill-flavoured layout: ~900 m, two jumps, a gravel-out and a gravel-in
 * section, a hairpin and a joker lap through the top-right complex.
 *
 * The start/finish line is at (0, 0) facing +Z, which is where the car spawns.
 */
/**
 * A compact World-RX style arena: ~500 m lap, mixed surface, two jumps, a
 * gravel-out and a gravel-in section, a tight hairpin onto the main straight
 * and a joker lane that dives inside the fast top-right complex.
 *
 * `START` is where the cars line up. The lap is driven clockwise (north up the
 * main straight, east across the top, south down the far side, west along the
 * bottom), so the infield is always on the `side` (+1) hand.
 */
export const MAIN_NODES: PathNode[] = [
  { x: 0, z: -38, width: 16, surface: 'tarmac' }, // out of the final corner
  { x: 0, z: 0, width: 16 }, // START / FINISH
  { x: 0, z: 30, width: 15 },
  { x: 2, z: 54, width: 15 }, // brake marker into T1
  { x: 14, z: 72, width: 14.5 }, // T1: medium right onto the gravel straight
  { x: 34, z: 82, width: 14 },
  { x: 56, z: 84, width: 13.5, surface: 'gravel' }, // gravel-out begins
  { x: 76, z: 84, y: 0.55, width: 13.5 }, // gravel bump
  { x: 92, z: 80, y: 0.15, width: 13.5 },
  { x: 110, z: 70, width: 13 }, // T2: fast right, the joker cuts inside it
  { x: 122, z: 56, width: 13 },
  { x: 130, z: 38, width: 13 },
  { x: 132, z: 20, width: 13, surface: 'tarmac' }, // back onto tarmac
  { x: 132, z: 14, width: 13 },
  { x: 132, z: 10, y: 0.25, width: 13 }, // JUMP 1: take-off ramp
  { x: 132, z: 7.5, y: 0.9, width: 13 }, // steep face
  { x: 132, z: 6, y: 1.35, width: 13 }, // lip
  { x: 132, z: 3, y: 0.85, width: 13 }, // landing face
  { x: 132, z: -3, y: 0.15, width: 13 },
  { x: 132, z: -10, width: 13 },
  { x: 131, z: -20, width: 13 },
  { x: 126, z: -36, width: 13 }, // T3
  { x: 112, z: -50, width: 13.5 },
  { x: 94, z: -60, width: 14, surface: 'gravel' }, // gravel-in begins
  { x: 86, z: -61, width: 14 },
  { x: 80, z: -62, y: 0.25, width: 14 }, // JUMP 2: take-off ramp
  { x: 77, z: -62, y: 0.9, width: 14 }, // steep face
  { x: 75, z: -62, y: 1.3, width: 14 }, // lip
  { x: 72, z: -62, y: 0.8, width: 14 }, // landing face
  { x: 67, z: -61, y: 0.1, width: 14 },
  { x: 60, z: -60, width: 14 },
  { x: 50, z: -60, width: 14 },
  { x: 32, z: -55, width: 14, surface: 'tarmac' }, // onto tarmac for the run home
  { x: 16, z: -59, width: 14.5 }, // last flick
  { x: 4, z: -50, width: 15 }, // final corner onto the main straight
];

/**
 * Joker lap: leaves the gravel straight just before the yump, runs flat inside
 * the top-right complex and rejoins on the tarmac before T3. It is the same
 * length as the racing line it replaces, so choosing it is a tactical call
 * (clean air vs. the jump) rather than a shortcut.
 */
export const JOKER_NODES: PathNode[] = [
  { x: 56, z: 84, width: 9, surface: 'gravel' }, // splits off the racing line
  // The first nodes only ease away from the main line: a hard 40° kink at
  // the split sends the car off the outside of the joker at speed.
  { x: 66, z: 82, width: 9 },
  { x: 74, z: 76, width: 9 },
  { x: 82, z: 70, width: 9 },
  { x: 90, z: 65, width: 9 },
  { x: 99, z: 60, width: 9 },
  { x: 108, z: 53, width: 9 },
  { x: 117, z: 43, width: 10 },
  { x: 124, z: 37, width: 10 },
  { x: 129, z: 32, width: 10 },
  // The tail sits on the main straight so the merge is tangential instead of
  // a 45° kink that throws the car into the catch fence.
  { x: 132, z: 24, width: 10, surface: 'tarmac' },
  { x: 132, z: 16, width: 10 },
];
export const JOKER_START = new THREE.Vector3(56, 0, 84);
export const JOKER_END = new THREE.Vector3(132, 0, 20);

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
