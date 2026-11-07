import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

interface BoxOptions {
  pos: [number, number, number];
  half: [number, number, number];
  rot?: [number, number, number];
  color?: number;
  friction?: number;
  /** visual only -> no collider */
  ghost?: boolean;
}

const BOX_GEO = new THREE.BoxGeometry(1, 1, 1);

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

export function buildTrack(world: RAPIER.World, scene: THREE.Scene) {
  /* ---------------- ground ---------------- */
  const tex = makeGridTexture();
  tex.repeat.set(200, 200);

  const groundMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(800, 800),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.96, metalness: 0.0 }),
  );
  groundMesh.rotation.x = -Math.PI / 2;
  groundMesh.receiveShadow = true;
  scene.add(groundMesh);

  const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(400, 0.5, 400)
      .setTranslation(0, -0.5, 0)
      .setFriction(1.0)
      .setRestitution(0.0),
    groundBody,
  );

  /* ---------------- helpers ---------------- */
  const addBox = (o: BoxOptions) => {
    const [x, y, z] = o.pos;
    const [hx, hy, hz] = o.half;
    const rot = o.rot ?? [0, 0, 0];

    const mesh = new THREE.Mesh(
      BOX_GEO,
      new THREE.MeshStandardMaterial({ color: o.color ?? 0x8a8f98, roughness: 0.82 }),
    );
    mesh.scale.set(hx * 2, hy * 2, hz * 2);
    mesh.position.set(x, y, z);
    mesh.rotation.set(rot[0], rot[1], rot[2]);
    mesh.castShadow = !o.ghost;
    mesh.receiveShadow = true;
    scene.add(mesh);

    if (o.ghost) return mesh;

    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0], rot[1], rot[2]));
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed()
        .setTranslation(x, y, z)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }),
    );
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hy, hz)
        .setFriction(o.friction ?? 1.0)
        .setRestitution(0.05),
      body,
    );
    return mesh;
  };

  /* ---------------- start gantry ---------------- */
  addBox({ pos: [-6.2, 2.4, 4], half: [0.22, 2.4, 0.22], color: 0x2a2f36 });
  addBox({ pos: [6.2, 2.4, 4], half: [0.22, 2.4, 0.22], color: 0x2a2f36 });
  addBox({ pos: [0, 4.9, 4], half: [6.4, 0.35, 0.25], color: 0xffb02e });

  /* ---------------- kicker ramp (z = 70) ---------------- */
  addBox({
    pos: [0, 1.42, 70],
    half: [5, 0.22, 8],
    rot: [-0.1745, 0, 0], // ~ -10deg around X: low edge at the near side
    color: 0xd9b45b,
  });

  /* ---------------- washboard (z = 130 .. 186) ---------------- */
  for (let i = 0; i < 8; i++) {
    addBox({
      pos: [0, 0.1, 130 + i * 8],
      half: [6, 0.1, 0.85],
      color: 0x767c85,
    });
  }

  /* ---------------- slalom cones ---------------- */
  const coneMat = new THREE.MeshStandardMaterial({ color: 0xff6b35, roughness: 0.7 });
  const coneGeo = new THREE.ConeGeometry(0.3, 0.85, 10);
  for (let i = 0; i < 7; i++) {
    const x = i % 2 === 0 ? -13.5 : -17.5;
    const z = 24 + i * 9;
    const mesh = new THREE.Mesh(coneGeo, coneMat);
    mesh.position.set(x, 0.425, z);
    mesh.castShadow = true;
    scene.add(mesh);

    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, 0.425, z));
    world.createCollider(RAPIER.ColliderDesc.cone(0.425, 0.3).setFriction(0.9), body);
  }

  /* ---------------- concrete barriers ---------------- */
  for (let i = 0; i < 8; i++) {
    addBox({
      pos: [26, 0.55, -20 + i * 12],
      half: [0.45, 0.55, 2.2],
      color: 0xb9bcc2,
      friction: 1.0,
    });
  }

  /* ---------------- low grip patches ---------------- */
  // gravel (top surface ~1cm above the asphalt)
  addBox({
    pos: [72, -0.03, 30],
    half: [26, 0.04, 32],
    color: 0x6b5a44,
    friction: 0.62,
  });

  // ice
  addBox({
    pos: [-70, -0.03, 40],
    half: [22, 0.04, 22],
    color: 0x9fd3e0,
    friction: 0.28,
  });

  /* ---------------- distance markers ---------------- */
  for (let z = 50; z <= 300; z += 50) {
    addBox({ pos: [-7.5, 0.02, z], half: [0.12, 0.015, 1.1], color: 0xe8eef6, ghost: true });
    addBox({ pos: [7.5, 0.02, z], half: [0.12, 0.015, 1.1], color: 0xe8eef6, ghost: true });
  }

  /* ---------------- skidpad ring ---------------- */
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(11.6, 12.4, 72),
    new THREE.MeshBasicMaterial({ color: 0xe8eef6, side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(-70, 0.03, 40);
  scene.add(ring);

  return { groundMesh };
}
