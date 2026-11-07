/**
 * Headless physics smoke test — runs the exact same VehiclePhysics code that
 * the browser uses, just without a renderer.  `npm run smoke`
 */
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { defaultConfig, VehiclePhysics, type VehicleInput } from '../src/vehicle/VehiclePhysics';
import { buildTrackColliders } from '../src/world/track';

const DT = 1 / 60;
let failures = 0;

function check(ok: boolean, label: string, detail = '') {
  const mark = ok ? 'PASS' : 'FAIL';
  if (!ok) failures++;
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ''}`);
}

function input(over: Partial<VehicleInput> = {}): VehicleInput {
  return { throttle: 0, brake: 0, steer: 0, handbrake: false, gear: 1, ...over };
}

function drive(car: VehiclePhysics, world: RAPIER.World, seconds: number, i: VehicleInput) {
  const steps = Math.round(seconds / DT);
  for (let s = 0; s < steps; s++) {
    car.fixedStep(DT, i);
    world.step();
  }
  car.sync();
}

/** Flat plane world (keeps the handling checks independent of the track). */
function flatWorld() {
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
  return world;
}

const gas = input({ throttle: 1 });
const coast = input();
const brake = input({ brake: 1 });

async function run() {
  await RAPIER.init();

  const world = flatWorld();
  const car = new VehiclePhysics(world, defaultConfig, new THREE.Vector3(0, 0.95, 0));

  console.log('\n— rig —');
  check(Math.abs(car.body.mass() - defaultConfig.mass) < 1, 'body mass', `${car.body.mass().toFixed(1)} kg`);
  check(car.gear === 1, 'starts in drive', car.gearName);

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

  const zStopped = car.position.z;
  drive(car, world, 1.5, brake);
  check(car.speed < 0.6, 'comes to a stop and stays there', `${car.speed.toFixed(2)} m/s`);
  check(
    car.position.z >= zStopped - 0.05,
    'brake never drives the car backwards',
    `Δz=${(car.position.z - zStopped).toFixed(3)} m`,
  );

  /* ---------------------------------------------------------------- */
  console.log('\n— brake at standstill —');
  car.reset();
  drive(car, world, 2, brake);
  check(Math.abs(car.position.z) < 0.3, 'brake alone does not reverse', `z=${car.position.z.toFixed(3)} m`);
  check(car.gear === 1, 'gear stays in drive', car.gearName);

  /* ---------------------------------------------------------------- */
  console.log('\n— parked car does not creep —');
  // Straddling the edge of a low-grip patch is the nasty case: two wheels see
  // a different friction collider and sit 1 cm higher, which used to excite a
  // 60 Hz limit cycle (the car drifted ~20 cm and the grip readout flickered
  // between 55 % and 100 % while standing still).
  const parkWorld = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  parkWorld.timestep = DT;
  buildTrackColliders(parkWorld);
  for (const [label, x, z] of [
    ['gravel edge', 46, 30],
    ['ice edge', -48, 40],
  ] as Array<[string, number, number]>) {
    const parked = new VehiclePhysics(parkWorld, defaultConfig, new THREE.Vector3(x, 1.2, z));
    for (let i = 0; i < Math.round(4 / DT); i++) {
      parked.fixedStep(DT, coast);
      parkWorld.step();
    }
    parked.sync();
    const p0 = parked.position.clone();
    let gripPeak = 0;
    let suspSpread = 0;
    for (let i = 0; i < Math.round(6 / DT); i++) {
      parked.fixedStep(DT, coast);
      parkWorld.step();
      const traction = parked.wheels.reduce((sum, w) => sum + w.traction, 0) / 4;
      gripPeak = Math.max(gripPeak, traction);
      const lengths = parked.wheels.map((w) => w.suspLength);
      suspSpread = Math.max(suspSpread, Math.max(...lengths) - Math.min(...lengths));
    }
    parked.sync();
    const creep = Math.hypot(parked.position.x - p0.x, parked.position.z - p0.z);
    check(creep < 0.02, `parked on the ${label} stays put`, `creep ${(creep * 100).toFixed(1)} cm / 6 s`);
    check(gripPeak < 0.1, `no grip flicker on the ${label}`, `peak traction ${(gripPeak * 100).toFixed(0)} %`);
    check(suspSpread < 0.003, `suspension settles on the ${label}`, `spread ${(suspSpread * 1000).toFixed(1)} mm`);
    parked.body.setTranslation({ x: 0, y: 50, z: 0 }, true);
    parked.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  }

  /* ---------------------------------------------------------------- */
  console.log('\n— steering direction (2.5s full lock) —');
  // Car forward is +Z, so its right-hand side is -X (right = forward x up).
  // yawOf = atan2(fwd.x, fwd.z) => turning right gives a NEGATIVE delta yaw.
  car.reset();
  drive(car, world, 0.5, coast);
  const yawR0 = yawOf(car);
  drive(car, world, 2.5, input({ throttle: 0.7, steer: 1 }));
  const dYawRight = shortestAngle(yawOf(car) - yawR0);
  check(dYawRight < -0.5, 'steer +1 (D) turns to the car right', `Δyaw=${dYawRight.toFixed(2)} rad`);
  check(car.quaternion.y < -0.1, 'body yaw follows the turn', `qy=${car.quaternion.y.toFixed(2)}`);
  check(car.quaternion.y > -0.98, 'stays upright while cornering');

  car.reset();
  drive(car, world, 0.5, coast);
  const yawL0 = yawOf(car);
  drive(car, world, 2.5, input({ throttle: 0.7, steer: -1 }));
  const dYawLeft = shortestAngle(yawOf(car) - yawL0);
  check(dYawLeft > 0.5, 'steer -1 (A) turns to the car left', `Δyaw=${dYawLeft.toFixed(2)} rad`);

  /* ---------------------------------------------------------------- */
  console.log('\n— handbrake drift —');
  car.reset();
  drive(car, world, 3, gas);
  let peakDrift = 0;
  for (let i = 0; i < 120; i++) {
    car.fixedStep(DT, input({ throttle: 0.6, steer: 1, handbrake: true }));
    world.step();
    peakDrift = Math.max(peakDrift, Math.abs(car.driftAngle));
  }
  car.sync();
  check(peakDrift > THREE.MathUtils.degToRad(8), 'rear steps out', `peak drift=${THREE.MathUtils.radToDeg(peakDrift).toFixed(1)}°`);

  /* ---------------------------------------------------------------- */
  console.log('\n— manual reverse gear —');
  car.reset();
  drive(car, world, 0.4, input({ gear: -1 }));
  check(car.gear === -1, 'shifts into R when stopped', car.gearName);
  const zStart = car.position.z;
  drive(car, world, 3, input({ throttle: 1, gear: -1 }));
  const reverseDistance = car.position.z - zStart;
  check(reverseDistance < -4, 'gas in R drives backwards', `Δz=${reverseDistance.toFixed(1)} m`);
  check(car.speed > 3, 'gets up to speed in reverse', `${car.speed.toFixed(1)} m/s`);
  check(
    car.speed <= defaultConfig.reverseMaxSpeed * 1.25,
    'reverse is speed limited',
    `${car.speed.toFixed(1)} ≤ ${defaultConfig.reverseMaxSpeed} m/s`,
  );

  const reverseSpeed = car.speed;
  drive(car, world, 1.5, input({ brake: 1, gear: -1 }));
  check(car.speed < reverseSpeed * 0.5, 'brake works in reverse too', `${reverseSpeed.toFixed(1)} → ${car.speed.toFixed(1)} m/s`);
  check(car.gear === -1, 'still in R after braking', car.gearName);

  /* ---------------------------------------------------------------- */
  console.log('\n— gear is manual (ignored at speed) —');
  car.reset();
  drive(car, world, 3, gas);
  const speedBeforeShift = car.speed;
  drive(car, world, 0.5, input({ gear: -1 }));
  check(
    car.gear === 1 && speedBeforeShift > 10,
    'R is refused while rolling forward',
    `${speedBeforeShift.toFixed(1)} m/s, gear=${car.gearName}`,
  );
  drive(car, world, 3, input({ brake: 1, gear: -1 }));
  check(car.gear === -1, 'R engages once stopped', `${car.speed.toFixed(1)} m/s, gear=${car.gearName}`);

  /* ---------------------------------------------------------------- */
  console.log('\n— landing from a jump —');
  car.reset();
  car.body.setTranslation({ x: 0, y: 6, z: 0 }, true);
  drive(car, world, 3, coast);
  check(car.position.y > 0.6, 'recovers on the ground', `y=${car.position.y.toFixed(2)}`);
  check(
    Math.abs(car.quaternion.x) < 0.25 && Math.abs(car.quaternion.z) < 0.25,
    'lands without flipping',
    `qx=${car.quaternion.x.toFixed(2)} qz=${car.quaternion.z.toFixed(2)}`,
  );

  /* ---------------------------------------------------------------- */
  console.log('\n— determinism (same input → same state) —');
  const a = finalState(0);
  const b = finalState(0);
  check(a === b, 'two identical runs end in the same state', a.slice(0, 40));
  const c = finalState(1);
  check(a !== c, 'different input produces a different state');

  /* ---------------------------------------------------------------- */
  console.log('\n— real track colliders (headless) —');
  const trackWorld = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  trackWorld.timestep = DT;
  let trackBuilt = true;
  try {
    buildTrackColliders(trackWorld);
  } catch (err) {
    trackBuilt = false;
    console.error(err);
  }
  check(trackBuilt, 'buildTrackColliders() runs without a DOM');

  const trackCar = new VehiclePhysics(trackWorld, defaultConfig, new THREE.Vector3(0, 0.95, 0));
  let maxY = 0;
  for (let i = 0; i < Math.round(9 / DT); i++) {
    trackCar.fixedStep(DT, gas);
    trackWorld.step();
    maxY = Math.max(maxY, trackCar.position.y);
  }
  trackCar.sync();
  check(maxY > 2.5, 'kick ramp launches the car', `peak y=${maxY.toFixed(2)} m`);
  check(trackCar.position.y > 0.6, 'lands back on the track', `y=${trackCar.position.y.toFixed(2)} m`);
  check(Math.abs(trackCar.quaternion.x) < 0.3, 'stays upright after the jump', `qx=${trackCar.quaternion.x.toFixed(2)}`);

  console.log(`\n${failures === 0 ? '✅ all checks passed' : `❌ ${failures} check(s) failed`}\n`);
  if (failures > 0) process.exitCode = 1;
}

/**
 * Runs a fixed scripted input sequence in a fresh world and returns the final
 * pose/velocity as a string. `variant` 0 is replayed twice to prove determinism.
 */
function finalState(variant: number) {
  const world = flatWorld();
  const car = new VehiclePhysics(world, defaultConfig, new THREE.Vector3(0, 0.95, 0));
  for (let i = 0; i < 240; i++) {
    const t = i * DT;
    car.fixedStep(
      DT,
      input({
        throttle: t < 2 ? 0.85 : 0,
        brake: t > 2.6 && t < 3.2 ? 0.7 : 0,
        steer: variant === 0 ? Math.sin(t * 2) : Math.cos(t * 2),
        handbrake: t > 2.2 && t < 2.5,
      }),
    );
    world.step();
  }
  car.sync();
  const p = car.position;
  const q = car.quaternion;
  const v = car.velocity;
  return [p.x, p.y, p.z, q.x, q.y, q.z, q.w, v.x, v.y, v.z].map((n) => n.toFixed(9)).join(',');
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
