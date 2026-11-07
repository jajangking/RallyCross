import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

interface BoxSpec {
  pos: [number, number, number];
  half: [number, number, number];
  rot?: [number, number, number];
  color?: number;
  friction?: number;
  /** visual only -> no collider */
  ghost?: boolean;
}

interface ConeSpec {
  x: number;
  z: number;
  radius: number;
  halfHeight: number;
}

const GROUND_HALF = 400;
const GROUND_FRICTION = 1.0;
const WALL_OFFSET = 390;

const BOX_GEO = new THREE.BoxGeometry(1, 1, 1);

/**
 * The track is pure data. `buildTrackColliders` only talks to Rapier and
 * `buildTrackVisuals` only talks to three.js + DOM, so the physics world can be
 * built headless (Node, server, AI training) exactly like in the browser.
 */
function boxLayout(): BoxSpec[] {
  const boxes: BoxSpec[] = [];

  /* ---------------- start gantry ---------------- */
  boxes.push(
    { pos: [-6.2, 2.4, 4], half: [0.22, 2.4, 0.22], color: 0x2a2f36 },
    { pos: [6.2, 2.4, 4], half: [0.22, 2.4, 0.22], color: 0x2a2f36 },
    { pos: [0, 4.9, 4], half: [6.4, 0.35, 0.25], color: 0xffb02e },
  );

  /* ---------------- kicker ramp (z = 70) ---------------- */
  boxes.push({
    pos: [0, 1.42, 70],
    half: [5, 0.22, 8],
    rot: [-0.1745, 0, 0], // ~ -10deg around X: low edge at the near side
    color: 0xd9b45b,
  });

  /* ---------------- washboard (z = 130 .. 186) ---------------- */
  for (let i = 0; i < 8; i++) {
    boxes.push({ pos: [0, 0.1, 130 + i * 8], half: [6, 0.1, 0.85], color: 0x767c85 });
  }

  /* ---------------- concrete barriers ---------------- */
  for (let i = 0; i < 8; i++) {
    boxes.push({
      pos: [26, 0.55, -20 + i * 12],
      half: [0.45, 0.55, 2.2],
      color: 0xb9bcc2,
      friction: 1.0,
    });
  }

  /* ---------------- low grip patches ---------------- */
  // gravel (top surface ~1cm above the asphalt)
  boxes.push({ pos: [72, -0.03, 30], half: [26, 0.04, 32], color: 0x6b5a44, friction: 0.62 });
  // ice
  boxes.push({ pos: [-70, -0.03, 40], half: [22, 0.04, 22], color: 0x9fd3e0, friction: 0.28 });

  /* ---------------- distance markers (visual only) ---------------- */
  for (let z = 50; z <= 300; z += 50) {
    boxes.push({ pos: [-7.5, 0.02, z], half: [0.12, 0.015, 1.1], color: 0xe8eef6, ghost: true });
    boxes.push({ pos: [7.5, 0.02, z], half: [0.12, 0.015, 1.1], color: 0xe8eef6, ghost: true });
  }

  /* ---------------- perimeter walls: no driving off the world ---------------- */
  const wallColor = 0x3a4048;
  boxes.push(
    { pos: [0, 0.5, WALL_OFFSET], half: [WALL_OFFSET, 0.5, 1], color: wallColor },
    { pos: [0, 0.5, -WALL_OFFSET], half: [WALL_OFFSET, 0.5, 1], color: wallColor },
    { pos: [WALL_OFFSET, 0.5, 0], half: [1, 0.5, WALL_OFFSET], color: wallColor },
    { pos: [-WALL_OFFSET, 0.5, 0], half: [1, 0.5, WALL_OFFSET], color: wallColor },
  );

  return boxes;
}

function coneLayout(): ConeSpec[] {
  const cones: ConeSpec[] = [];
  for (let i = 0; i < 7; i++) {
    cones.push({ x: i % 2 === 0 ? -13.5 : -17.5, z: 24 + i * 9, radius: 0.3, halfHeight: 0.425 });
  }
  return cones;
}

/** Ground + ramps + patches. No DOM, no meshes: usable in Node. */
export function buildTrackColliders(world: RAPIER.World) {
  const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(GROUND_HALF, 0.5, GROUND_HALF)
      .setTranslation(0, -0.5, 0)
      .setFriction(GROUND_FRICTION)
      .setRestitution(0.0),
    groundBody,
  );

  for (const box of boxLayout()) {
    if (box.ghost) continue;
    const [x, y, z] = box.pos;
    const [hx, hy, hz] = box.half;
    const rot = box.rot ?? [0, 0, 0];
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0], rot[1], rot[2]));
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed()
        .setTranslation(x, y, z)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }),
    );
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hy, hz)
        .setFriction(box.friction ?? GROUND_FRICTION)
        .setRestitution(0.05),
      body,
    );
  }

  for (const cone of coneLayout()) {
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(cone.x, cone.halfHeight, cone.z),
    );
    world.createCollider(
      RAPIER.ColliderDesc.cone(cone.halfHeight, cone.radius).setFriction(0.9),
      body,
    );
  }
}

function makeGridTexture(): THREE.Texture {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;

  ctx.fillStyle = '#33373d';
  ctx.fillRect(0, 0, size, size);

  // subtle grain so the ground is not a flat color
  for (let i = 0; i < 900; i++) {
    const v = 44 + Math.random() * 26;
    ctx.fillStyle = `rgba(${v},${v + 2},${v + 5},0.55)`;
    ctx.fillRect(Math.random() * size, Math.random() * size, 3, 3);
  }

  ctx.strokeStyle = '#4b525a';
  ctx.lineWidth = 3;
  ctx.strokeRect(0, 0, size, size);

  ctx.strokeStyle = 'rgba(90,100,112,0.45)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(size / 2, 0);
  ctx.lineTo(size / 2, size);
  ctx.moveTo(0, size / 2);
  ctx.lineTo(size, size / 2);
  ctx.stroke();

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** Meshes only — mirrors `boxLayout()` / `coneLayout()` so both stay in sync. */
export function buildTrackVisuals(scene: THREE.Scene) {
  /* ---------------- ground ---------------- */
  const tex = makeGridTexture();
  tex.repeat.set(200, 200);

  const groundMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(GROUND_HALF * 2, GROUND_HALF * 2),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.96, metalness: 0.0 }),
  );
  groundMesh.rotation.x = -Math.PI / 2;
  groundMesh.receiveShadow = true;
  scene.add(groundMesh);

  /* ---------------- boxes (one material per colour) ---------------- */
  const materials = new Map<number, THREE.MeshStandardMaterial>();
  const materialFor = (color: number) => {
    let mat = materials.get(color);
    if (!mat) {
      mat = new THREE.MeshStandardMaterial({ color, roughness: 0.82 });
      materials.set(color, mat);
    }
    return mat;
  };

  for (const box of boxLayout()) {
    const color = box.color ?? 0x8a8f98;
    const mesh = new THREE.Mesh(BOX_GEO, materialFor(color));
    mesh.scale.set(box.half[0] * 2, box.half[1] * 2, box.half[2] * 2);
    mesh.position.set(...box.pos);
    if (box.rot) mesh.rotation.set(box.rot[0], box.rot[1], box.rot[2]);
    mesh.castShadow = !box.ghost;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }

  /* ---------------- slalom cones ---------------- */
  const coneMat = new THREE.MeshStandardMaterial({ color: 0xff6b35, roughness: 0.7 });
  const coneGeo = new THREE.ConeGeometry(0.3, 0.85, 10);
  for (const cone of coneLayout()) {
    const mesh = new THREE.Mesh(coneGeo, coneMat);
    mesh.position.set(cone.x, cone.halfHeight, cone.z);
    mesh.castShadow = true;
    scene.add(mesh);
  }

  /* ---------------- skidpad ring ---------------- */
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(11.6, 12.4, 72),
    new THREE.MeshBasicMaterial({ color: 0xe8eef6, side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(-70, 0.03, 40);
  scene.add(ring);
}

/** Convenience for the browser: colliders + meshes in one call. */
export function buildTrack(world: RAPIER.World, scene: THREE.Scene) {
  buildTrackColliders(world);
  buildTrackVisuals(scene);
}
