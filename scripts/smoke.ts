/**
 * Headless physics smoke test — runs the exact same VehiclePhysics code that
 * the browser uses, just without a renderer.  `npm run smoke`
 */
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { defaultConfig, VehiclePhysics, type VehicleInput } from '../src/vehicle/VehiclePhysics';
import { BROADCAST_SPOTS, buildTrackColliders, TRACK } from '../src/world/track';
import { BroadcastDirector } from '../src/camera/BroadcastDirector';
import { lapPath, type PathSample } from '../src/world/circuit';
import { AutoPilot } from '../src/ai/AutoPilot';
import { LapCounter } from '../src/race/LapCounter';
import { Rival } from '../src/race/Rival';
import { gridPose, RIVAL_PLANS } from '../src/race/grid';
import { LapRecords, standings, type StandingsCar } from '../src/race/Standings';
import { SkidMarks } from '../src/fx/SkidMarks';
import { SmokePuffs } from '../src/fx/Smoke';
import { CarEffects } from '../src/fx/CarEffects';
import { toon, toonFrom, toonRamp, PALETTE } from '../src/world/style';
import { Helicopter } from '../src/world/Heli';
import { CameraRig } from '../src/camera';
import { TRACK_BLOCKERS, type PropBox } from '../src/world/track';

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

  // Every place where the grip under the car changes hands: the tarmac/gravel
  // seams, plus one spot straddling the white line and the grass verge.
  const parkSpots: Array<{ label: string; x: number; y: number; z: number; yaw: number }> = [];
  {
    const main = TRACK.main;
    const seen: number[] = [];
    for (let i = 1; i < main.length; i++) {
      if (main[i].surface === main[i - 1].surface) continue;
      if (seen.some((d) => Math.abs(main[i].distance - d) < 25)) continue;
      seen.push(main[i].distance);
      const a = TRACK.at(main[i].distance);
      parkSpots.push({ label: `${main[i - 1].surface}→${main[i].surface} seam`, x: a.pos.x, y: 0.6, z: a.pos.z, yaw: a.yaw });
    }
    const a = TRACK.at(TRACK.start + 26);
    const side = new THREE.Vector3(a.tangent.z, 0, -a.tangent.x);
    const edge = a.pos.clone().addScaledVector(side, 7.8);
    parkSpots.push({ label: 'road edge / grass', x: edge.x, y: 0.6, z: edge.z, yaw: a.yaw });
  }

  for (const spot of parkSpots) {
    const parked = new VehiclePhysics(parkWorld, defaultConfig, new THREE.Vector3(spot.x, 1.2, spot.z), spot.yaw);
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
    check(creep < 0.02, `parked on the ${spot.label} stays put`, `creep ${(creep * 100).toFixed(1)} cm / 6 s`);
    check(gripPeak < 0.1, `no grip flicker on the ${spot.label}`, `peak traction ${(gripPeak * 100).toFixed(0)} %`);
    check(suspSpread < 0.003, `suspension settles on the ${spot.label}`, `spread ${(suspSpread * 1000).toFixed(1)} mm`);
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

  // Aim at the biggest jump on the lap and floor it from 30 m back: the car
  // must leave the ground, fly, and land rubber side down.
  const biggest = TRACK.jumps.reduce((best, j) => (j.height > best.height ? j : best), TRACK.jumps[0]);
  const approach = TRACK.at(biggest.distance - 30);
  const trackCar = new VehiclePhysics(
    trackWorld,
    defaultConfig,
    new THREE.Vector3(approach.pos.x, 1.0, approach.pos.z),
    approach.yaw,
  );
  let maxY = 0;
  let airborne = 0;
  for (let i = 0; i < Math.round(9 / DT); i++) {
    trackCar.fixedStep(DT, gas);
    trackWorld.step();
    maxY = Math.max(maxY, trackCar.position.y);
    if (trackCar.position.y > biggest.height + 1.2) airborne += DT;
  }
  trackCar.sync();
  check(
    maxY > biggest.height + 1.2,
    'take-off ramp launches the car',
    `crest ${biggest.height.toFixed(2)} m, peak y=${maxY.toFixed(2)} m, airborne ${airborne.toFixed(2)} s`,
  );
  check(trackCar.position.y > 0.6, 'lands back on the track', `y=${trackCar.position.y.toFixed(2)} m`);
  check(Math.abs(trackCar.quaternion.x) < 0.3, 'stays upright after the jump', `qx=${trackCar.quaternion.x.toFixed(2)}`);

  /* ---------------------------------------------------------------- */
  console.log('\n— autopilot (real physics, headless) —');
  const plainPath = lapPath(TRACK.main, TRACK.joker, false);
  const jokerPath = lapPath(TRACK.main, TRACK.joker, true);
  const pathLength = (p: PathSample[]) => p[p.length - 1].distance;
  const monotonic = (p: PathSample[]) => p.every((s, i) => i === 0 || s.distance > p[i - 1].distance);
  check(
    monotonic(plainPath) && monotonic(jokerPath),
    'lap path distance is monotonic (main + joker spliced)',
    `${pathLength(plainPath).toFixed(1)} m / ${pathLength(jokerPath).toFixed(1)} m`,
  );
  check(
    pathLength(jokerPath) < pathLength(plainPath),
    'the joker lap is the shorter way round',
    `${(pathLength(plainPath) - pathLength(jokerPath)).toFixed(1)} m shorter`,
  );

  const aiWorld = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  aiWorld.timestep = DT;
  buildTrackColliders(aiWorld);
  const aiCar = new VehiclePhysics(aiWorld, defaultConfig, new THREE.Vector3(0, 0.95, -10));
  const pilot = new AutoPilot(TRACK.main, TRACK.joker, { useJoker: true });
  let maxExcess = 0;
  let upright = 1;
  let aiTime = 0;
  const upProbe = new THREE.Vector3();
  for (let i = 0; i < Math.round(80 / DT) && pilot.lap < 1; i++) {
    const command = pilot.update(DT, aiCar);
    aiCar.fixedStep(DT, command);
    aiWorld.step();
    aiCar.sync();
    aiTime += DT;
    maxExcess = Math.max(maxExcess, Math.abs(pilot.lateral) - pilot.sample.halfWidth);
    upright = Math.min(upright, upProbe.set(0, 1, 0).applyQuaternion(aiCar.quaternion).y);
  }
  check(pilot.lap >= 1, 'the AI drives a full lap unaided', `${pilot.lastLap.toFixed(1)} s lap, ${aiTime.toFixed(1)} s total`);
  check(maxExcess < 3, 'the AI keeps the car on the road', `max ${maxExcess.toFixed(1)} m past the edge`);
  // Tidak ada reset otomatis lagi: mobil yang terbalik dibiarkan, dan AI hanya
  // melepas pedal sampai rodanya kembali ke bawah.
  check(upright > 0.5, 'the AI never ends up on its roof', `lowest tilt ${upright.toFixed(2)}`);
  check(pilot.bestLap < 45, 'AI lap time is sane', `best ${pilot.bestLap.toFixed(1)} s`);

  /* ---------------------------------------------------------------- */
  console.log('\n— lap counter & rival —');
  // Walk a virtual car around the path: the counter must tick exactly once
  // per loop, and not at all before the first crossing.
  const counter = new LapCounter(plainPath, TRACK.start);
  let ticks = 0;
  const startIdx = plainPath.reduce(
    (best, s, i) => (Math.abs(s.distance - TRACK.start) < Math.abs(plainPath[best].distance - TRACK.start) ? i : best),
    0,
  );
  for (let passes = 0; passes < 3; passes++) {
    for (let k = 0; k < plainPath.length; k++) {
      const before = counter.lap;
      counter.update(plainPath[(startIdx + k) % plainPath.length].pos);
      if (counter.lap !== before) ticks++;
    }
  }
  // one more step to actually cross the line after the third loop
  const beforeFinal = counter.lap;
  counter.update(plainPath[startIdx].pos);
  if (counter.lap !== beforeFinal) ticks++;
  check(ticks === 3, 'lap counter ticks once per lap', `${ticks} laps counted`);
  check(Math.abs(counter.odometer - pathLength(plainPath) * 3) < 60, 'odometer tracks the distance', `${counter.odometer.toFixed(1)} m`);

  // Two cars, one world: the rival must race cleanly around the player.
  const raceWorld = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  raceWorld.timestep = DT;
  buildTrackColliders(raceWorld);
  const raceCar = new VehiclePhysics(raceWorld, defaultConfig, new THREE.Vector3(0, 0.95, -10));
  const racePilot = new AutoPilot(TRACK.main, TRACK.joker);
  const gridRow = TRACK.at(TRACK.start - 20);
  const rival = new Rival(raceWorld, {
    position: new THREE.Vector3(gridRow.pos.x, 0.95, gridRow.pos.z).addScaledVector(gridRow.side, -3.8),
    yaw: gridRow.yaw,
    main: TRACK.main,
    joker: TRACK.joker,
    startDistance: TRACK.start,
  });
  let rivalExcess = 0;
  let closest = Infinity;
  let raceTime = 0;
  for (let i = 0; i < Math.round(80 / DT) && rival.lap < 1; i++) {
    raceCar.fixedStep(DT, racePilot.update(DT, raceCar, [{ position: rival.car.position, speed: rival.car.speed }]));
    rival.step(DT, [{ position: raceCar.position, speed: raceCar.speed }]);
    raceWorld.step();
    raceCar.sync();
    rival.sync();
    raceTime += DT;
    rivalExcess = Math.max(rivalExcess, Math.abs(rival.pilot.lateral) - rival.pilot.sample.halfWidth);
    closest = Math.min(closest, rival.car.position.distanceTo(raceCar.position));
  }
  check(rival.lap >= 1, 'the rival drives a full lap', `${raceTime.toFixed(1)} s`);
  // Rali: bahu gravel memang boleh dipakai. Yang tidak boleh adalah keluar
  // jauh atau berhenti di luar trek — itu diuji terpisah di bagian grid.
  check(
    rivalExcess < 4.5,
    'the rival stays near the road',
    `max ${rivalExcess.toFixed(1)} m past the edge`,
  );
  check(closest > 1.4, 'the two cars never clip each other', `closest ${closest.toFixed(1)} m`);

  /* ---------------------------------------------------------------- */
  console.log('\n— efek ban: jejak & asap —');
  const marks = new SkidMarks(64);
  const a0 = new THREE.Vector3(0, 0.02, 0);
  const b0 = new THREE.Vector3(0, 0.02, 1);
  const c0 = new THREE.Vector3(1, 0.02, 0);
  const d0 = new THREE.Vector3(1, 0.02, 1);
  marks.add(a0, c0, b0, d0, 0.8);
  marks.add(a0, c0, b0, d0, 0.8);
  marks.flush();
  check(marks.count === 2, 'skid marks collect quads', `${marks.count} quads`);
  check(
    (marks.mesh.geometry.drawRange.count as number) === 12,
    'skid mark geometry draws both quads',
    `${marks.mesh.geometry.drawRange.count} indices`,
  );
  for (let i = 0; i < marks.length + 4; i++) marks.add(a0, c0, b0, d0, 0.5);
  marks.flush();
  check(
    marks.count === marks.length,
    'skid marks wrap around instead of growing forever',
    `${marks.count} / ${marks.length} quads`,
  );
  marks.clear();
  check(marks.count === 0, 'skid marks can be cleared', `${marks.count} quads`);
  check(
    (marks.mesh.geometry.drawRange.count as number) === 0,
    'cleared skid marks draw nothing',
    `${marks.mesh.geometry.drawRange.count}`,
  );

  const puffs = new SmokePuffs(24);
  const puffStyle = {
    size: 0.5,
    grow: 2,
    color: 0xffffff,
    life: 1,
    rise: 0.6,
    spread: 0.5,
    opacity: 0.4,
  };
  for (let i = 0; i < 5; i++) puffs.spawn(new THREE.Vector3(0, 0.2, i), puffStyle);
  puffs.update(0.1);
  check(puffs.alive === 5, 'smoke puffs spawn and live', `${puffs.alive} alive`);
  puffs.update(2);
  check(puffs.alive === 0, 'smoke puffs fade out', `${puffs.alive} alive`);
  const puffPos = puffs.points.geometry.getAttribute('position') as THREE.BufferAttribute;
  check(
    Number.isFinite(puffPos.array[1]) && puffPos.count === 24,
    'smoke lives in one preallocated buffer',
    `${puffPos.count} points`,
  );

  // Efek harus benar-benar terpicu oleh selip ban, bukan oleh waktu.
  const fxWorld = flatWorld();
  const fxCar = new VehiclePhysics(fxWorld, defaultConfig, new THREE.Vector3(0, 0.95, 0));
  const fxMarks = new SkidMarks(512);
  const fxSmoke = new SmokePuffs(64);
  const fx = new CarEffects(fxCar, fxMarks, fxSmoke);
  let fxSteps = 0;
  for (; fxSteps < 60; fxSteps++) {
    // Diam: tidak boleh ada jejak sama sekali.
    fxCar.fixedStep(DT, input());
    fxWorld.step();
    fxCar.sync();
    fx.update(DT, input());
    fxSmoke.update(DT);
  }
  fxMarks.flush();
  check(fxMarks.count === 0 && fxSmoke.alive === 0, 'a parked car leaves no marks', `${fxMarks.count} quads`);
  for (let s = 0; s < 200; s++) {
    fxCar.fixedStep(DT, input({ throttle: 1 }));
    fxWorld.step();
    fxCar.sync();
    fx.update(DT, input({ throttle: 1 }));
    fxSmoke.update(DT);
  }
  for (let s = 0; s < 90; s++) {
    // Handbrake di kecepatan tinggi: roda belakang terkunci = asap + jejak.
    fxCar.fixedStep(DT, input({ brake: 1, steer: 0.6, handbrake: true }));
    fxWorld.step();
    fxCar.sync();
    fx.update(DT, input({ brake: 1, steer: 0.6, handbrake: true }));
    fxSmoke.update(DT);
  }
  fxMarks.flush();
  check(fxMarks.count > 10, 'a sliding car paints skid marks', `${fxMarks.count} quads`);
  check(fxSmoke.alive > 0, 'a sliding car raises smoke', `${fxSmoke.alive} puffs`);

  /* ---------------------------------------------------------------- */
  console.log('\n— gaya kartun (material) —');
  const ramp = toonRamp();
  check(
    ramp.image.width === 4 && ramp.image.height === 1,
    'cel-shading ramp has four hard steps',
    `${ramp.image.width}x${ramp.image.height} px, nearest filter`,
  );
  check(ramp.minFilter === THREE.NearestFilter, 'the ramp does not blur', 'NearestFilter');
  const toonMat = toon({ color: PALETTE.grass, map: null, roughness: 1, metalness: 0.4 });
  check(
    toonMat.isMeshToonMaterial && toonMat.gradientMap === ramp,
    'toon() builds a toon material that shares one ramp',
    `colour #${toonMat.color.getHexString()}`,
  );
  check(
    !('metalness' in toonMat) && !('roughness' in toonMat),
    'legacy PBR keys are ignored, not copied',
    'no metalness/roughness',
  );
  const standard = new THREE.MeshStandardMaterial({ color: 0x3366cc, transparent: true, opacity: 0.5 });
  const converted = toonFrom(standard);
  check(
    converted.isMeshToonMaterial &&
      converted.color.getHex() === 0x3366cc &&
      converted.transparent &&
      Math.abs(converted.opacity - 0.5) < 1e-6,
    'imported model materials convert to toon without losing colour/alpha',
    `#${converted.color.getHexString()} · opacity ${converted.opacity}`,
  );

  /* Mobil terbalik: tidak di-reset, AI hanya melepas pedal. */
  const flippedPilot = new AutoPilot(TRACK.main, TRACK.joker);
  const upsideDown = {
    position: new THREE.Vector3(0, 0.9, 0),
    velocity: new THREE.Vector3(),
    quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI),
    angularVelocity: new THREE.Vector3(),
    speed: 0,
    gear: 1 as const,
    wheels: [{ contact: true }, { contact: true }, { contact: true }, { contact: true }],
  };
  let flipCmd = flippedPilot.update(DT, upsideDown);
  // 0,15 s pertama masih "drive" (bisa saja cuma terangkat sesaat), setelah
  // itu AI harus diam total.
  for (let i = 0; i < 14; i++) flipCmd = flippedPilot.update(DT, upsideDown);
  check(
    flipCmd.throttle === 0 && flipCmd.brake === 0 && flipCmd.steer === 0,
    'a flipped car is left alone instead of being restarted',
    `throttle ${flipCmd.throttle} · brake ${flipCmd.brake} · steer ${flipCmd.steer}`,
  );
  const rolledBack = { ...upsideDown, quaternion: new THREE.Quaternion() };
  let recovered = flipCmd;
  for (let i = 0; i < 30; i++) recovered = flippedPilot.update(DT, rolledBack);
  check(
    recovered.throttle > 0.1 || recovered.brake > 0.1,
    'the AI drives again as soon as the car is back on its wheels',
    `throttle ${recovered.throttle.toFixed(2)}`,
  );

  /* ---------------------------------------------------------------- */
  console.log('\n— papan klasemen & rekor —');
  const fakeCars: StandingsCar[] = [
    { name: 'A', color: 0xff0000, lap: 1, odometer: 480, bestLap: 30, laps: 3 },
    { name: 'B', color: 0x00ff00, lap: 1, odometer: 500, bestLap: 29, laps: 3 },
    { name: 'C', color: 0x0000ff, lap: 0, odometer: 400, bestLap: 31, laps: 3 },
    { name: 'D', color: 0xffffff, lap: 3, odometer: 1440, bestLap: 28, laps: 3 },
  ];
  const table = standings(fakeCars);
  check(
    table.map((r) => r.name).join('') === 'DBAC',
    'standings sort by lap then distance (finishers first)',
    table.map((r) => `${r.position}${r.name}`).join(' '),
  );
  check(
    table[0].finished && !table[1].finished && table[0].gap === 0,
    'the finisher leads and the leader has no gap',
    `gap ${table[1].gap.toFixed(0)} m behind`,
  );
  check(
    Math.abs(table[1].gap - 940) < 0.001 && Math.abs(table[2].gap - 960) < 0.001,
    'gaps are measured against the leader',
    `${table[1].gap.toFixed(0)} m / ${table[2].gap.toFixed(0)} m`,
  );

  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  const records = new LapRecords(storage);
  check(!records.hasRecord, 'no record before the first lap', records.holder || '—');
  check(records.submit(31.5, 'Krisna'), 'the first fast lap sets the record', `${records.best.toFixed(2)} s`);
  check(!records.submit(32.0, 'Bagas'), 'a slower lap does not steal the record', `${records.best.toFixed(2)} s`);
  check(records.submit(30.2, 'Bagas'), 'a faster lap takes the record', `${records.best.toFixed(2)} s`);
  check(records.holder === 'Bagas', 'the record remembers who set it', records.holder);
  const reloaded = new LapRecords(storage);
  check(
    Math.abs(reloaded.best - 30.2) < 1e-9 && reloaded.holder === 'Bagas',
    'the record survives a reload',
    `${reloaded.best.toFixed(2)} s · ${reloaded.holder}`,
  );
  check(!new LapRecords(null).hasRecord, 'records work without localStorage', 'memory only');

  /* ---------------------------------------------------------------- */
  console.log('\n— grid 6 mobil —');
  const gridWorld = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  gridWorld.timestep = DT;
  buildTrackColliders(gridWorld);
  const gridPlayer = new VehiclePhysics(gridWorld, defaultConfig, new THREE.Vector3(0, 0.95, -10));
  const gridPilot = new AutoPilot(TRACK.main, TRACK.joker);
  const pack = RIVAL_PLANS.map(
    (plan) =>
      new Rival(gridWorld, {
        name: plan.name,
        ...gridPose(plan),
        main: TRACK.main,
        joker: TRACK.joker,
        startDistance: TRACK.start,
        pace: plan.pace,
        laneOffset: plan.laneOffset,
        jokerEachLap: plan.jokerEachLap,
      }),
  );
  check(pack.length === 5, 'five rivals join the player', `${pack.length + 1} cars on the grid`);
  const gridTraffic = [
    { position: gridPlayer.position, speed: 0 },
    ...pack.map((r) => ({ position: r.car.position, speed: 0 })),
  ];
  const packExcess = new Map<string, number>();
  let packClosest = Infinity;
  let packTime = 0;
  for (let i = 0; i < Math.round(90 / DT) && pack.some((r) => r.lap < 1); i++) {
    gridTraffic[0].speed = gridPlayer.speed;
    for (let k = 0; k < pack.length; k++) gridTraffic[k + 1].speed = pack[k].car.speed;
    gridPlayer.fixedStep(DT, gridPilot.update(DT, gridPlayer, gridTraffic));
    for (const r of pack) r.step(DT, gridTraffic);
    gridWorld.step();
    gridPlayer.sync();
    for (const r of pack) {
      r.sync();
      const ex = Math.abs(r.pilot.lateral) - r.pilot.sample.halfWidth;
      packExcess.set(r.name, Math.max(packExcess.get(r.name) ?? 0, ex));
    }
    for (let a = 0; a < pack.length; a++) {
      for (let b = a + 1; b < pack.length; b++) {
        packClosest = Math.min(packClosest, pack[a].car.position.distanceTo(pack[b].car.position));
      }
      packClosest = Math.min(packClosest, pack[a].car.position.distanceTo(gridPlayer.position));
    }
    packTime += DT;
  }
  check(
    pack.every((r) => r.lap >= 1),
    'all five rivals finish a lap',
    `${packTime.toFixed(1)} s · ${pack.map((r) => r.name).join(', ')}`,
  );
  const worstExcess = Math.max(...pack.map((r) => packExcess.get(r.name) ?? 0));
  check(worstExcess < 12, 'nobody in the pack wanders far off the track', `worst ${worstExcess.toFixed(1)} m past the edge`);
  const up = new THREE.Vector3();
  check(
    pack.every((r) => up.set(0, 1, 0).applyQuaternion(r.car.quaternion).y > 0.5),
    'nobody in the pack ends the lap upside down',
    pack.map((r) => r.name).join(' · '),
  );
  check(packClosest > 1.2, 'the pack never merges into one car', `closest ${packClosest.toFixed(2)} m`);
  const packLaps = pack.map((r) => r.bestLap).filter((b) => Number.isFinite(b));
  check(
    packLaps.length === 5 && Math.max(...packLaps) - Math.min(...packLaps) < 12,
    'the field is close enough to race each other',
    `${Math.min(...packLaps).toFixed(1)}–${Math.max(...packLaps).toFixed(1)} s`,
  );
  const packTable = standings([
    {
      name: 'KAMU',
      color: 0xffffff,
      lap: gridPilot.lap,
      odometer: 0,
      bestLap: gridPilot.bestLap,
      laps: 1,
      isPlayer: true,
    },
    ...pack.map((r) => ({
      name: r.name,
      color: 0,
      lap: r.lap,
      odometer: r.odometer,
      bestLap: r.bestLap,
      laps: 1,
    })),
  ]);
  check(
    packTable.length === 6 && packTable.every((row, i) => row.position === i + 1),
    'the standings hold all six cars in order',
    packTable.map((r) => `${r.position}.${r.name}`).join(' '),
  );

  /* ---------------------------------------------------------------- */
  console.log('\n— kamera TV —');
  check(BROADCAST_SPOTS.length >= 4, 'a broadcast camera per corner', `${BROADCAST_SPOTS.length} cameras`);
  let outside = Infinity;
  for (const spot of BROADCAST_SPOTS) {
    let nearest = Infinity;
    let halfWidth = 0;
    for (const s of TRACK.main) {
      const d = Math.hypot(spot.position.x - s.pos.x, spot.position.z - s.pos.z);
      if (d < nearest) {
        nearest = d;
        halfWidth = s.halfWidth;
      }
    }
    outside = Math.min(outside, nearest - halfWidth);
  }
  check(outside > 4, 'every camera stands outside the track', `closest wall ${outside.toFixed(1)} m from the edge`);

  /* Garis pandang: tidak boleh ada kamera yang tertutup tribun. */
  const segHitsBox = (box: PropBox, a: THREE.Vector3, b: THREE.Vector3) => {
    const c = Math.cos(-box.yaw);
    const s = Math.sin(-box.yaw);
    const local = (p: THREE.Vector3) => ({
      x: (p.x - box.center.x) * c + (p.z - box.center.z) * s,
      y: p.y - box.center.y,
      z: -(p.x - box.center.x) * s + (p.z - box.center.z) * c,
    });
    const p0 = local(a);
    const p1 = local(b);
    let tmin = 0;
    let tmax = 1;
    for (const axis of ['x', 'y', 'z'] as const) {
      const dir = p1[axis] - p0[axis];
      const half = box.half[axis];
      if (Math.abs(dir) < 1e-9) {
        if (Math.abs(p0[axis]) > half) return false;
        continue;
      }
      let t1 = (-half - p0[axis]) / dir;
      let t2 = (half - p0[axis]) / dir;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return false;
    }
    return true;
  };
  const insideBox = (box: PropBox, p: THREE.Vector3) => {
    const c = Math.cos(-box.yaw);
    const s = Math.sin(-box.yaw);
    const x = (p.x - box.center.x) * c + (p.z - box.center.z) * s;
    const z = -(p.x - box.center.x) * s + (p.z - box.center.z) * c;
    return (
      Math.abs(x) <= box.half.x &&
      Math.abs(z) <= box.half.z &&
      Math.abs(p.y - box.center.y) <= box.half.y
    );
  };
  const blockedBy: string[] = [];
  const insideBy: string[] = [];
  for (const spot of BROADCAST_SPOTS) {
    for (const box of TRACK_BLOCKERS) {
      if (segHitsBox(box, spot.position, spot.aim)) blockedBy.push(`${spot.name}→${box.name}`);
      if (insideBox(box, spot.position)) insideBy.push(`${spot.name} di ${box.name}`);
    }
  }
  check(
    blockedBy.length === 0,
    'no broadcast camera looks through a grandstand',
    blockedBy.length ? blockedBy.join(', ') : `${BROADCAST_SPOTS.length} cameras clear`,
  );
  check(
    insideBy.length === 0,
    'no broadcast camera sits inside a prop',
    insideBy.length ? insideBy.join(', ') : 'all outside',
  );
  const startSpot = BROADCAST_SPOTS.find((s) => s.name === 'GARIS START');
  check(
    !!startSpot && startSpot.position.y > 10,
    'the start-line camera sits above the grandstand roof',
    startSpot ? `${startSpot.position.y.toFixed(1)} m high` : 'missing',
  );

  const director = new BroadcastDirector(BROADCAST_SPOTS);
  const focus = new THREE.Vector3();
  const dt = 1 / 60;
  const lap = TRACK.main[TRACK.main.length - 1].distance;
  const used = new Set<string>();
  let cuts = 0;
  let sinceCut = 0;
  let minGap = Infinity;
  let worst = 0;
  // Drive a virtual car at 22 m/s for two laps and let the director cut.
  // `trackDistance` is measured from the start line, exactly like LapCounter.
  for (let time = 0; time < (lap * 2) / 22; time += dt) {
    const d = (time * 22) % lap;
    const p = TRACK.at(d);
    focus.copy(p.pos);
    focus.y += 0.9;
    const trackDistance = ((d - TRACK.start) % lap + lap) % lap;
    const spot = director.update(dt, focus, trackDistance, lap);
    sinceCut += dt;
    if (director.takeCut()) {
      used.add(spot?.name ?? '?');
      if (cuts > 0) minGap = Math.min(minGap, sinceCut);
      sinceCut = 0;
      cuts++;
    }
    if (spot) worst = Math.max(worst, spot.position.distanceTo(focus));
  }
  check(used.size >= 5, 'the director cuts between several cameras', `${used.size} cameras, ${cuts} cuts`);
  check(minGap > 1.4, 'cameras never flicker', `shortest shot ${minGap.toFixed(1)} s`);
  check(worst < 220, 'the framed car is never absurdly far away', `worst ${worst.toFixed(0)} m`);

  console.log('\n— helikopter kamera udara —');
  const rig = new CameraRig(16 / 9, BROADCAST_SPOTS);
  const cycle: string[] = [rig.modeName];
  for (let i = 0; i < 4; i++) {
    rig.toggleMode();
    cycle.push(rig.modeName);
  }
  check(
    cycle.includes('heli') && cycle[0] === cycle[4],
    'C cycles chase -> kap -> TV -> heli -> chase',
    cycle.join(' → '),
  );

  const heli = new Helicopter();
  const heliFocus = new THREE.Vector3(TRACK.main[10].pos.x, TRACK.main[10].pos.y, TRACK.main[10].pos.z);
  heli.place(heliFocus);
  for (let i = 0; i < 60; i++) heli.update(1 / 60, heliFocus);
  const cam0 = heli.cameraPosition.clone();
  const off = Math.hypot(cam0.x - heliFocus.x, cam0.z - heliFocus.z);
  check(
    off > 18 && off < 40,
    'the helicopter keeps station around the car',
    `${off.toFixed(1)} m out, ${(cam0.y - heliFocus.y).toFixed(0)} m up`,
  );
  check(
    cam0.y - heliFocus.y > 20,
    'the helicopter camera is a genuine aerial shot',
    `${(cam0.y - heliFocus.y).toFixed(0)} m above the car`,
  );
  check(
    [cam0.x, cam0.y, cam0.z].every(Number.isFinite) && cam0.y > 0,
    'the helicopter camera position is finite and above ground',
    `${cam0.x.toFixed(0)}, ${cam0.y.toFixed(0)}, ${cam0.z.toFixed(0)}`,
  );

  // Mobil bergerak: heli harus ikut, bukan tertinggal.
  let heliMaxLag = 0;
  for (let i = 0; i < 240; i++) {
    const p = TRACK.at((i * 22) / 60);
    heliFocus.set(p.pos.x, p.pos.y, p.pos.z);
    heli.update(1 / 60, heliFocus);
    heliMaxLag = Math.max(heliMaxLag, Math.hypot(heli.cameraPosition.x - heliFocus.x, heli.cameraPosition.z - heliFocus.z));
  }
  check(
    heliMaxLag < 60,
    'the helicopter follows the car around the lap',
    `worst ${heliMaxLag.toFixed(0)} m behind`,
  );

  // Kamera udara membidik mobil dari posisi heli.
  rig.setMode('heli');
  for (let i = 0; i < 40; i++) rig.updateAerial(1 / 60, heli.cameraPosition, heliFocus);
  check(
    rig.camera.position.distanceTo(heli.cameraPosition) < 8,
    'the aerial camera rides on the helicopter',
    `${rig.camera.position.distanceTo(heli.cameraPosition).toFixed(1)} m from the heli`,
  );
  check(
    rig.camera.fov >= 45,
    'the aerial lens is wide enough to read the circuit',
    `${rig.camera.fov.toFixed(0)}° fov`,
  );

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
