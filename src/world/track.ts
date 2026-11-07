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
const JOKER = lift(samplePath(JOKER_NODES, 1.2, false), ROAD_LIFT);
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

/** Lane walls that separate the joker from the racing line. */
const JOKER_WALLS = (() => {
  const out: Ribbon[] = [];
  const length = JOKER[JOKER.length - 1].distance;
  // keep the walls clear of both junctions so neither line is blocked
  const mid = JOKER.filter((s) => s.distance > 14 && s.distance < length - 14);
  if (mid.length < 4) return out;
  out.push(offsetWall(mid, 1, 1.4, 0.85));
  out.push(offsetWall(mid, -1, 1.4, 0.85));
  return out;
})();

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
  addTrimesh(world, VERGE, GRASS_MU);
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
  tex.anisotropy = 8;
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
  return canvasTexture((ctx, size) => {
    ctx.fillStyle = '#31353b';
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 2600; i++) {
      const v = 40 + Math.random() * 46;
      ctx.fillStyle = `rgba(${v},${v + 2},${v + 6},0.7)`;
      ctx.fillRect(Math.random() * size, Math.random() * size, 2, 2);
    }
    ctx.strokeStyle = 'rgba(24,26,30,0.5)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 6; i++) {
      const y = Math.random() * size;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.bezierCurveTo(size * 0.3, y + 6, size * 0.6, y - 6, size, y + 2);
      ctx.stroke();
    }
  }, 256, 1);
}

function gravelTexture() {
  return canvasTexture((ctx, size) => {
    ctx.fillStyle = '#6f6353';
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 5200; i++) {
      const r = 110 + Math.random() * 60;
      const g = 100 + Math.random() * 55;
      const b = 82 + Math.random() * 45;
      ctx.fillStyle = `rgba(${r},${g},${b},0.85)`;
      const s = 1 + Math.random() * 3;
      ctx.fillRect(Math.random() * size, Math.random() * size, s, s);
    }
    ctx.fillStyle = 'rgba(45,38,30,0.35)';
    for (let i = 0; i < 40; i++) {
      ctx.beginPath();
      ctx.arc(Math.random() * size, Math.random() * size, 4 + Math.random() * 12, 0, Math.PI * 2);
      ctx.fill();
    }
  }, 256, 1);
}

function grassTexture() {
  return canvasTexture((ctx, size) => {
    ctx.fillStyle = '#3d5a2c';
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 4000; i++) {
      const g = 70 + Math.random() * 60;
      ctx.fillStyle = `rgba(${40 + Math.random() * 30},${g},${34 + Math.random() * 24},0.8)`;
      ctx.fillRect(Math.random() * size, Math.random() * size, 2, 3);
    }
  }, 256, 1);
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
export function buildTrackVisuals(scene: THREE.Scene): TrackHandle {
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
    new THREE.MeshStandardMaterial({ map: grass, roughness: 1, metalness: 0 }),
  );
  groundMesh.rotation.x = -Math.PI / 2;
  groundMesh.position.y = -0.005;
  groundMesh.receiveShadow = true;
  scene.add(groundMesh);

  const vergeMat = new THREE.MeshStandardMaterial({ color: 0x46602f, roughness: 1 });
  for (const ribbon of [VERGE, JOKER_VERGE]) {
    const mesh = new THREE.Mesh(ribbonGeometry(ribbon), vergeMat);
    mesh.receiveShadow = true;
    scene.add(mesh);
  }

  const roadMaterials: Record<Surface, THREE.MeshStandardMaterial> = {
    tarmac: new THREE.MeshStandardMaterial({ map: asphalt, roughness: 0.92, metalness: 0 }),
    gravel: new THREE.MeshStandardMaterial({ map: gravelTex, roughness: 1, metalness: 0 }),
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
  const white = new THREE.MeshStandardMaterial({ color: 0xe8eef6, roughness: 0.7 });
  for (const sign of [-1, 1]) {
    const line = stripRibbon(MAIN, (s) => sign * (s.halfWidth - 0.32), 0.16, 0.016);
    scene.add(new THREE.Mesh(ribbonGeometry(line, false), white));
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
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 }),
    );
    bandMesh.receiveShadow = true;
    scene.add(bandMesh);
  }

  /* starting grid, staggered boxes behind the line */
  const gridMat = new THREE.MeshStandardMaterial({ color: 0xdfe6ee, roughness: 0.8 });
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
  const kerbMat = new THREE.MeshStandardMaterial({ map: kerbTexture(), roughness: 0.75 });
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

  /* ---------------- crash barrier + catch fencing ---------------- */
  const wallMat = new THREE.MeshStandardMaterial({
    color: 0xb9c2cc,
    roughness: 0.55,
    metalness: 0.45,
    side: THREE.DoubleSide,
  });
  scene.add(new THREE.Mesh(ribbonGeometry(OUTER_FENCE, false), wallMat));

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
  const meshFenceMat = new THREE.MeshStandardMaterial({
    map: fenceTex,
    transparent: true,
    alphaTest: 0.05,
    opacity: 0.55,
    roughness: 0.8,
    metalness: 0.2,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  scene.add(new THREE.Mesh(ribbonGeometry(raiseBand(OUTER_FENCE, WALL_HEIGHT, FENCE_TOP), false), meshFenceMat));

  const jokerWallMat = new THREE.MeshStandardMaterial({
    color: 0xe6e9ee,
    roughness: 0.7,
    side: THREE.DoubleSide,
  });
  for (const wall of JOKER_WALLS) {
    scene.add(new THREE.Mesh(ribbonGeometry(wall, false), jokerWallMat));
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
      new THREE.MeshStandardMaterial({
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
  const tyreMat = new THREE.MeshStandardMaterial({
    color: 0x191b1e,
    roughness: 0.95,
    side: THREE.DoubleSide,
  });
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
  const steelMat = new THREE.MeshStandardMaterial({ color: 0x2b323b, roughness: 0.6, metalness: 0.45 });
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
    new THREE.MeshStandardMaterial({
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
    new THREE.MeshStandardMaterial({ color: 0x14171c, roughness: 0.7 }),
  );
  lightPanel.position.copy(start.pos);
  lightPanel.position.y = 5.4;
  lightPanel.rotation.y = startHeading;
  gantry.add(lightPanel);

  const startLampMat = new THREE.MeshStandardMaterial({
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
  const standMat = new THREE.MeshStandardMaterial({ color: 0x39414b, roughness: 0.85 });
  const crowdMat = new THREE.MeshStandardMaterial({ map: crowd, roughness: 0.9 });
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
    const roof = new THREE.Mesh(new THREE.BoxGeometry(length + 1.4, 0.25, rows * 1.5 + 3), standMat);
    roof.position.set(0, height + 2.1, -rows * 0.75 - 0.6);
    roof.castShadow = true;
    group.add(roof);
    for (const sign of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.3, height + 2.1, 0.3), standMat);
      leg.position.set(sign * (length / 2 - 0.4), (height + 2.1) / 2, -(rows * 1.5 + 0.2));
      group.add(leg);
      const legFront = new THREE.Mesh(new THREE.BoxGeometry(0.3, height + 2.1, 0.3), standMat);
      legFront.position.set(sign * (length / 2 - 0.4), (height + 2.1) / 2, 0.6);
      group.add(legFront);
    }
    return group;
  };

  place(makeStand(34, 7), pointAt(MAIN, START_DIST - 16), -1, 6.5);
  place(makeStand(20, 5), pointAt(MAIN, START_DIST + 74), -1, 7.5);

  /* ---------------- race control tower ---------------- */
  const tower = new THREE.Group();
  const towerMat = new THREE.MeshStandardMaterial({ color: 0x59636f, roughness: 0.7 });
  const shaft = new THREE.Mesh(new THREE.BoxGeometry(3.6, 11, 3.6), towerMat);
  shaft.position.y = 5.5;
  shaft.castShadow = true;
  tower.add(shaft);
  const cab = new THREE.Mesh(
    new THREE.CylinderGeometry(3.1, 3.1, 2.4, 8),
    new THREE.MeshStandardMaterial({
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
    new THREE.MeshStandardMaterial({
      map: bannerTexture('RACE CONTROL', '#0b1420', '#7fe3ff'),
      roughness: 0.7,
      side: THREE.DoubleSide,
    }),
  );
  towerSign.position.set(0, 8.2, 2.3);
  tower.add(towerSign);
  place(tower, pointAt(MAIN, START_DIST - 34), -1, 15);

  /* ---------------- marshal posts + flags ---------------- */
  const hutMat = new THREE.MeshStandardMaterial({ color: 0xd8dde4, roughness: 0.8 });
  const flagMats = [
    new THREE.MeshStandardMaterial({ color: 0xffcc22, roughness: 0.9, side: THREE.DoubleSide }),
    new THREE.MeshStandardMaterial({ color: 0x2f7fe0, roughness: 0.9, side: THREE.DoubleSide }),
    new THREE.MeshStandardMaterial({ color: 0xd8342a, roughness: 0.9, side: THREE.DoubleSide }),
    new THREE.MeshStandardMaterial({ color: 0xf2f4f7, roughness: 0.9, side: THREE.DoubleSide }),
  ];
  const poleMat = new THREE.MeshStandardMaterial({ color: 0xc7ccd3, metalness: 0.6, roughness: 0.4 });
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
    flag.position.set(2.2, 4.5, 0.6);
    post.add(flag);
    flags.push(flag);
    place(post, p, -1, 10.5);
    base.y = 0;
  }

  /* ---------------- floodlight masts ---------------- */
  const mastMat = new THREE.MeshStandardMaterial({ color: 0x39424c, roughness: 0.6, metalness: 0.5 });
  const lampHeadMat = new THREE.MeshStandardMaterial({
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
    new THREE.MeshStandardMaterial({ map: asphalt.clone(), roughness: 0.95 }),
  );
  apron.material.map!.repeat.set(10, 6);
  apron.rotation.x = -Math.PI / 2;
  apron.position.set(62, 0.008, 4);
  apron.receiveShadow = true;
  paddock.add(apron);

  const tentMat = new THREE.MeshStandardMaterial({ color: 0xeef1f4, roughness: 0.85 });
  const awningMat = new THREE.MeshStandardMaterial({
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
      new THREE.MeshStandardMaterial({
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
  const truckBodyMat = new THREE.MeshStandardMaterial({ color: 0xf0f2f5, roughness: 0.7 });
  const truckCabMat = new THREE.MeshStandardMaterial({ color: 0x1f4f8a, roughness: 0.5, metalness: 0.3 });
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
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3524, roughness: 1 });
  const crownMat = new THREE.MeshStandardMaterial({ color: 0x2f4a26, roughness: 1 });
  const treeCount = 190;
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

  /* ---------------- joker signs ---------------- */
  const jokerPoint = pointAt(MAIN, MAIN[nearestSample(MAIN, JOKER_START)].distance - 14);
  const jokerSign = new THREE.Mesh(
    new THREE.PlaneGeometry(5.2, 1.8),
    new THREE.MeshStandardMaterial({
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
export function buildTrack(world: RAPIER.World, scene: THREE.Scene): TrackHandle {
  buildTrackColliders(world);
  return buildTrackVisuals(scene);
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
  length: MAIN_LENGTH,
  start: START_DIST,
  jumps: JUMPS,
  /** Pose on the racing line `distance` metres into the lap. */
  at(distance: number): { pos: THREE.Vector3; tangent: THREE.Vector3; yaw: number } {
    const p = pointAt(MAIN, distance);
    return { pos: p.pos.clone(), tangent: p.tangent.clone(), yaw: Math.atan2(p.tangent.x, p.tangent.z) };
  },
};
