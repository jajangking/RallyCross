/**
 * Headless physics smoke test — runs the exact same VehiclePhysics code that
 * the browser uses, just without a renderer.  `npm run smoke`
 */
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { defaultConfig, VehiclePhysics, type VehicleInput } from '../src/vehicle/VehiclePhysics';

const DT = 1 / 60;
let failures = 0;

function check(ok: boolean, label: string, detail = '') {
  const mark = ok ? 'PASS' : 'FAIL';
  if (!ok) failures++;
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ''}`);
}

function drive(car: VehiclePhysics, world: RAPIER.World, seconds: number, input: VehicleInput) {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    car.fixedStep(DT, input);
    world.step();
  }
  car.sync();
}

const gas: VehicleInput = { throttle: 1, steer: 0, handbrake: false };
const coast: VehicleInput = { throttle: 0, steer: 0, handbrake: false };
const brake: VehicleInput = { throttle: -1, steer: 0, handbrake: false };

async function run() {
  await RAPIER.init();

  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = DT;

  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(300, 0.5, 300)
      .setTranslation(0, -0.5, 0)
      .setFriction(1)
      .setRestitution(0),
    ground,
  );

  const car = new VehiclePhysics(world, defaultConfig, new THREE.Vector3(0, 0.95, 0));

  console.log('\n— rig —');
  check(Math.abs(car.body.mass() - defaultConfig.mass) < 1, 'body mass', `${car.body.mass().toFixed(1)} kg`);

  /* ---------------------------------------------------------------- */
  console.log('\n— settle (1s) —');
  drive(car, world, 1, coast);
  check(car.position.y > 0.7 && car.position.y < 1.2, 'ride height', `y=${car.position.y.toFixed(3)} m`);
  check(
    Math.abs(car.quaternion.x) < 0.02 && Math.abs(car.quaternion.z) < 0.02,
    'stays flat at rest',
    `qx=${car.quaternion.x.toFixed(4)} qz=${car.quaternion.z.toFixed(4)}`,
  );
  check(car.wheels.every((w) => w.contact), 'all 4 wheels grounded');
  const load = car.wheels.reduce((s, w) => s + w.springForce, 0);
  check(Math.abs(load - defaultConfig.mass * 9.81) < 400, 'static load ≈ weight', `${load.toFixed(0)} N`);

  /* ---------------------------------------------------------------- */
  console.log('\n— acceleration (4s) —');
  const z0 = car.position.z;
  drive(car, world, 4, gas);
  const accel = car.position.z - z0;
  check(car.speed > 20, 'reaches > 20 m/s', `${car.speed.toFixed(1)} m/s (${car.speedKmh.toFixed(0)} km/h)`);
  check(accel > 40, 'travels forward on +Z', `${accel.toFixed(1)} m`);
  check(car.position.y > 0.6, 'does not sink through the ground', `y=${car.position.y.toFixed(2)}`);

  /* ---------------------------------------------------------------- */
  console.log('\n— braking (2s) —');
  const before = car.speed;
  drive(car, world, 2, brake);
  check(car.speed < before * 0.4, 'brakes hard', `${before.toFixed(1)} → ${car.speed.toFixed(1)} m/s`);

  /* ---------------------------------------------------------------- */
  console.log('\n— steering direction (2.5s full lock) —');
  // Car forward is +Z, so its right-hand side is -X (right = forward x up).
  // yawOf = atan2(fwd.x, fwd.z) => turning right gives a NEGATIVE delta yaw.
  car.reset();
  drive(car, world, 0.5, coast);
  const yawR0 = yawOf(car);
  drive(car, world, 2.5, { throttle: 0.7, steer: 1, handbrake: false });
  const dYawRight = shortestAngle(yawOf(car) - yawR0);
  check(dYawRight < -0.5, 'steer +1 (D) turns to the car right', `Δyaw=${dYawRight.toFixed(2)} rad`);
  check(car.quaternion.y < -0.1, 'body yaw follows the turn', `qy=${car.quaternion.y.toFixed(2)}`);
  check(car.quaternion.y > -0.98, 'stays upright while cornering');

  car.reset();
  drive(car, world, 0.5, coast);
  const yawL0 = yawOf(car);
  drive(car, world, 2.5, { throttle: 0.7, steer: -1, handbrake: false });
  const dYawLeft = shortestAngle(yawOf(car) - yawL0);
  check(dYawLeft > 0.5, 'steer -1 (A) turns to the car left', `Δyaw=${dYawLeft.toFixed(2)} rad`);

  /* ---------------------------------------------------------------- */
  console.log('\n— handbrake drift —');
  car.reset();
  drive(car, world, 3, gas);
  let peakDrift = 0;
  for (let i = 0; i < 120; i++) {
    car.fixedStep(DT, { throttle: 0.6, steer: 1, handbrake: true });
    world.step();
    peakDrift = Math.max(peakDrift, Math.abs(car.driftAngle));
  }
  car.sync();
  check(peakDrift > THREE.MathUtils.degToRad(8), 'rear steps out', `peak drift=${THREE.MathUtils.radToDeg(peakDrift).toFixed(1)}°`);

  /* ---------------------------------------------------------------- */
  console.log('\n— landing from a jump —');
  car.reset();
  car.body.setTranslation({ x: 0, y: 6, z: 0 }, true);
  drive(car, world, 3, coast);
  check(car.position.y > 0.6, 'recovers on the ground', `y=${car.position.y.toFixed(2)}`);
  check(Math.abs(car.quaternion.x) < 0.25 && Math.abs(car.quaternion.z) < 0.25, 'lands without flipping', `qx=${car.quaternion.x.toFixed(2)} qz=${car.quaternion.z.toFixed(2)}`);

  console.log(`\n${failures === 0 ? '✅ all checks passed' : `❌ ${failures} check(s) failed`}\n`);
  if (failures > 0) process.exitCode = 1;
}

function yawOf(car: VehiclePhysics) {
  const f = new THREE.Vector3(0, 0, 1).applyQuaternion(car.quaternion);
  return Math.atan2(f.x, f.z);
}

function shortestAngle(a: number) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
