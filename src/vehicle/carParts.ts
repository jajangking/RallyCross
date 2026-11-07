import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { toon } from '../world/style';

export const UP_AXIS = new THREE.Vector3(0, 1, 0);
const tmpDir = new THREE.Vector3();

/** Unit cylinder (radius 1, height 1) reused by every link, arm and strut. */
export const UNIT_CYLINDER = new THREE.CylinderGeometry(1, 1, 1, 10, 1, false);

/**
 * Place a unit-cylinder mesh so it spans from `a` to `b` (car space).
 * Non-uniform scale is applied before the rotation, so the cylinder axis
 * always follows the link without rebuilding geometry.
 */
export function setLink(mesh: THREE.Mesh, radius: number, a: THREE.Vector3, b: THREE.Vector3) {
  tmpDir.subVectors(b, a);
  const len = tmpDir.length() || 1e-4;
  mesh.position.copy(a).addScaledVector(tmpDir, 0.5);
  mesh.quaternion.setFromUnitVectors(UP_AXIS, tmpDir.multiplyScalar(1 / len));
  mesh.scale.set(radius, len, radius);
}

/** Same idea for a spring: the geometry is built at `restLength`, then scaled. */
export function setSpring(
  mesh: THREE.Mesh,
  a: THREE.Vector3,
  b: THREE.Vector3,
  restLength: number,
) {
  tmpDir.subVectors(b, a);
  const len = tmpDir.length() || 1e-4;
  mesh.position.copy(a).addScaledVector(tmpDir, 0.5);
  mesh.quaternion.setFromUnitVectors(UP_AXIS, tmpDir.multiplyScalar(1 / len));
  mesh.scale.set(1, len / restLength, 1);
}

/** Helical coil spring along +Y, centred on the origin, total height `length`. */
export function helixGeometry(
  length: number,
  radius: number,
  wire: number,
  coils: number,
  detail: boolean,
) {
  const steps = Math.max(10, Math.round(coils * (detail ? 16 : 9)));
  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const angle = t * coils * Math.PI * 2;
    points.push(new THREE.Vector3(Math.cos(angle) * radius, (t - 0.5) * length, Math.sin(angle) * radius));
  }
  const curve = new THREE.CatmullRomCurve3(points);
  return new THREE.TubeGeometry(curve, steps, wire, detail ? 6 : 4, false);
}

/** Semua material bodi bergaya toon (kartun) — lihat `src/world/style.ts`. */
export interface CarMaterials {
  paint: THREE.MeshToonMaterial;
  paintDark: THREE.MeshToonMaterial;
  trim: THREE.MeshToonMaterial;
  carbon: THREE.MeshToonMaterial;
  glass: THREE.MeshToonMaterial;
  rubber: THREE.MeshToonMaterial;
  rim: THREE.MeshToonMaterial;
  disc: THREE.MeshToonMaterial;
  caliper: THREE.MeshToonMaterial;
  interior: THREE.MeshToonMaterial;
  cage: THREE.MeshToonMaterial;
  spring: THREE.MeshToonMaterial;
  plate: THREE.MeshToonMaterial;
}

export function createCarMaterials(detail: boolean, paint = 0xd8402f): CarMaterials {
  return {
    paint: toon({ color: paint }),
    paintDark: toon({ color: 0x1a1e24 }),
    trim: toon({ color: 0xe8eef6 }),
    carbon: toon({ color: 0x101317 }),
    glass: toon({
      color: 0x2a4a63,
      transparent: true,
      opacity: 0.62,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
    rubber: toon({ color: 0x0c0e10 }),
    rim: toon({ color: 0xc2c9d1 }),
    disc: toon({ color: 0x6d737b, emissive: 0xff3b12, emissiveIntensity: 0 }),
    caliper: toon({ color: 0xe0a12a }),
    interior: toon({ color: 0x15181c }),
    cage: toon({ color: detail ? 0xd7dce3 : 0x9aa2ac }),
    spring: toon({ color: 0xe3b325 }),
    plate: toon({ color: 0xf2f4f7 }),
  };
}

/** Small rounded box helper (chamfered body panels, seats, housings). */
export function roundedBox(
  w: number,
  h: number,
  d: number,
  radius: number,
  material: THREE.Material,
) {
  const geo = new RoundedBoxGeometry(w, h, d, 3, Math.min(radius, Math.min(w, h, d) * 0.45));
  return new THREE.Mesh(geo, material);
}

/**
 * Body panels are extruded side profiles: shape X is world +Z (forward) and the
 * extrusion depth becomes the car's width. Winding must stay counter-clockwise
 * so the caps face outwards; `extrudeProfile` assumes CCW input.
 */
export function extrudeProfile(
  points: ReadonlyArray<readonly [number, number]>,
  width: number,
  bevel: number,
) {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1]);
  shape.closePath();

  const depth = Math.max(0.02, width - bevel * 2);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel * 0.9,
    bevelSegments: 3,
    curveSegments: 6,
    steps: 1,
  });
  // shape X -> +Z, extrusion depth -> -X, so shift back to centre the panel.
  geo.rotateY(-Math.PI / 2);
  geo.translate(depth / 2, 0, 0);
  geo.computeVertexNormals();
  return geo;
}
