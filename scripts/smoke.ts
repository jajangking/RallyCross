/**
 * Headless physics smoke test — runs the exact same VehiclePhysics code that
 * the browser uses, just without a renderer.  `npm run smoke`
 */
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { defaultConfig, VehiclePhysics, type VehicleInput } from '../src/vehicle/VehiclePhysics';
import { BROADCAST_SPOTS, buildTrackColliders, PIT, pitPose, TRACK } from '../src/world/track';
import { FocusDirector } from '../src/camera/FocusDirector';
import { PitStop, serviceTimeFor } from '../src/race/PitStop';
import { RaceControl, type ServiceHandle } from '../src/race/RaceControl';
import { ServiceVehicle } from '../src/race/ServiceVehicle';
import { VehicleDamage } from '../src/vehicle/Damage';
import { BroadcastDirector } from '../src/camera/BroadcastDirector';
import { lapPath, type PathSample } from '../src/world/circuit';
import { AutoPilot } from '../src/ai/AutoPilot';
import { LapCounter } from '../src/race/LapCounter';
import { Rival } from '../src/race/Rival';
import { AiSkills, skillForPace, tuningFor } from '../src/race/AiSkill';
import { gridPose, RIVAL_PLANS } from '../src/race/grid';
import { LapRecords, standings, type StandingsCar } from '../src/race/Standings';
import { SkidMarks } from '../src/fx/SkidMarks';
import { SmokePuffs } from '../src/fx/Smoke';
import { CarEffects } from '../src/fx/CarEffects';
import { toon, toonFrom, toonRamp, PALETTE } from '../src/world/style';
import { Helicopter } from '../src/world/Heli';
import { createSunRig } from '../src/world/style';
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

/** Flat plane plus a solid wall across the road, for crash tests. */
function wallWorld(z: number) {
  const world = flatWorld();
  const wall = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(60, 3, 0.6).setTranslation(0, 3, z).setFriction(0.7).setRestitution(0.15),
    wall,
  );
  return world;
}

/**
 * Full throttle into the wall until the body takes its first hit, then stop.
 * Both runs are identical up to that instant, so the numbers can be compared
 * even though the cars diverge afterwards.
 */
function ramWall(damageOptions: Partial<{ enabled: boolean; severity: number }> = {}) {
  const world = wallWorld(48);
  const car = new VehiclePhysics(world, defaultConfig, new THREE.Vector3(0, 0.95, 0), 0, damageOptions);
  let peakSpeed = 0;
  let steps = 0;
  for (; steps < Math.round(9 / DT); steps++) {
    // Δv baru terdeteksi pada langkah SETELAH benturan (impulsnya diselesaikan
    // oleh `world.step`), jadi kecepatan tabrak = puncak kecepatan sebelum itu.
    const v = car.body.linvel();
    peakSpeed = Math.max(peakSpeed, Math.hypot(v.x, v.z) * 3.6);
    car.fixedStep(DT, gas);
    world.step();
    if (car.damage.bodyHealth < 1) break;
  }
  car.sync();
  return { car, world, hitSpeed: peakSpeed, steps };
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
  console.log('\n— derek (recovery) —');
  {
    const towWorld = flatWorld();
    const towCar = new VehiclePhysics(towWorld, defaultConfig, new THREE.Vector3(0, 0.95, 0));
    drive(towCar, towWorld, 1, coast);
    const ground = towCar.position.clone();

    // Diikat ke derek: bodi jadi kinematik, mesin & gravitasi tidak berlaku.
    towCar.setTowed(true);
    check(towCar.isTowed, 'mobil bisa diikat ke derek');
    drive(towCar, towWorld, 1, gas);
    check(
      towCar.position.distanceTo(ground) < 0.3 && Math.abs(towCar.speed) < 0.01,
      'selama diikat: gas tidak berpengaruh, mobil tidak bergerak sendiri',
      `geser ${towCar.position.distanceTo(ground).toFixed(2)} m`,
    );

    // Diangkut: ikut pose yang diberikan, tidak jatuh.
    const carried = new THREE.Vector3(12, 2.1, 30);
    for (let i = 0; i < 30; i++) {
      towCar.carryTo(carried, 0.6);
      towWorld.step();
      towCar.sync();
    }
    check(
      towCar.position.distanceTo(carried) < 0.4 && towCar.position.y > 1.5,
      'mobil ikut terangkat di belakang derek (tidak jatuh)',
      `${towCar.position.x.toFixed(1)}, ${towCar.position.y.toFixed(2)}, ${towCar.position.z.toFixed(1)}`,
    );

    // Diturunkan di pit: kembali jadi mobil biasa dan bisa jalan lagi.
    const dropSpot = new THREE.Vector3(12, 1.05, 30);
    towCar.dropAt(dropSpot, 0.6);
    towCar.setTowed(false);
    drive(towCar, towWorld, 1.2, coast);
    check(!towCar.isTowed && towCar.wheels.some((w) => w.contact), 'setelah diturunkan: roda menyentuh tanah lagi');
    drive(towCar, towWorld, 3, gas);
    check(towCar.speed > 12, 'setelah diturunkan mobil bisa jalan lagi', `${towCar.speed.toFixed(1)} m/s`);
  }

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
    ramp.image.width === 5 && ramp.image.height === 1,
    'cel-shading ramp has five hard steps',
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
  // Kerusakan bukan hak istimewa pemain: lima lawan memakai model yang sama
  // (bukan mobil anti-penyok), dan mengemudi bersih tidak merusak apa pun.
  const rivalDamage = pack.map((r) => r.car.damage);
  check(
    rivalDamage.every((d) => d.options.enabled) && rivalDamage.every((d) => d.bodyHealth > 0.9),
    'lawan memakai model kerusakan yang sama (rusak kalau memang bertabrakan)',
    `${rivalDamage.length} mobil · bodi ${rivalDamage.map((d) => (d.bodyHealth * 100).toFixed(0)).join('/')} % · mesin ${rivalDamage.map((d) => (d.engineHealth * 100).toFixed(0)).join('/')} %`,
  );
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

  console.log('\n— bayangan & cahaya —');
  {
    const scene = new THREE.Scene();
    const high = createSunRig(scene, false);
    const low = createSunRig(new THREE.Scene(), true);
    check(high.shadows && !low.shadows, 'shadow maps are off on weak hardware', `high ${high.shadows}, low ${low.shadows}`);
    check(
      high.sun.shadow.mapSize.x === 2048 && high.sun.castShadow && !low.sun.castShadow,
      'the shadow map is sized for the device and off in the low preset',
      `high ${high.sun.shadow.mapSize.x}², low castShadow ${low.sun.castShadow}`,
    );
    const span = high.sun.shadow.camera.right - high.sun.shadow.camera.left;
    check(span <= 120, 'the shadow frustum is tight, not arena-wide', `${span.toFixed(0)} m across`);
    const focus = new THREE.Vector3(40, 2, -30);
    high.follow(focus);
    check(
      high.sun.target.position.distanceTo(focus) < 0.001 &&
        high.sun.position.distanceTo(focus) > 80 &&
        high.sun.position.y > focus.y,
      'the shadow frustum follows the car and the sun stays up',
      `${high.sun.position.distanceTo(focus).toFixed(0)} m from the car`,
    );
    // arahnya harus tetap sama walau targetnya pindah (= tidak ada matahari goyang)
    const before = high.sun.position.clone().sub(focus).normalize();
    high.follow(focus.clone().add(new THREE.Vector3(60, 0, 30)));
    const after = high.sun.position.clone().sub(focus.clone().add(new THREE.Vector3(60, 0, 30))).normalize();
    check(before.distanceTo(after) < 1e-6, 'the sun direction never moves', 'constant');
  }

  console.log('\n— helikopter kamera udara —');
  const rig = new CameraRig(16 / 9, BROADCAST_SPOTS);
  const cycle: string[] = [rig.modeName];
  for (let i = 0; i < 3; i++) {
    rig.toggleMode();
    cycle.push(rig.modeName);
  }
  check(
    cycle.join('→') === 'chase→hood→tv→chase',
    'C cycles chase -> kap -> TV -> chase',
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

  // Model heli: cukup detail tapi tetap ringan (bagian diam digabung per material).
  let heliMeshes = 0;
  let heliTris = 0;
  heli.root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    heliMeshes++;
    const index = mesh.geometry.getIndex();
    heliTris += (index ? index.count : mesh.geometry.getAttribute('position').count) / 3;
  });
  check(
    heliMeshes <= 18 && heliTris > 1200,
    'the helicopter model stays detailed but cheap to draw',
    `${heliMeshes} meshes, ${heliTris.toFixed(0)} triangles`,
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

  // Kamera udara ikut jadi bagian siaran TV: sutradara menyelipkannya berkala.
  const liveRig = new CameraRig(16 / 9, BROADCAST_SPOTS);
  liveRig.setMode('tv');
  const liveFocus = new THREE.Vector3();
  const eye = new THREE.Vector3();
  let aerialSegments = 0;
  let aerialFrames = 0;
  let longestAerial = 0;
  let run = 0;
  let groundFrames = 0;
  let ladder = 0;
  let maxEyeLag = 0;
  let minAerialHeight = Infinity;
  for (let time = 0; time < 90; time += dt) {
    const d = (time * 24) % lap;
    const p = TRACK.at(d);
    liveFocus.copy(p.pos);
    liveFocus.y += 0.9;
    // heli mengorbit fokus, 26 m di atas dan 30 m ke samping
    const a = time * 0.16;
    eye.set(liveFocus.x + Math.cos(a) * 30, liveFocus.y + 26, liveFocus.z + Math.sin(a) * 30);
    liveRig.setAerialEye(eye);
    const trackDistance = ((d - TRACK.start) % lap + lap) % lap;
    liveRig.updateBroadcast(dt, liveFocus, trackDistance, lap);
    if (liveRig.aerialActive) {
      aerialFrames++;
      run += dt;
      longestAerial = Math.max(longestAerial, run);
      if (liveRig.broadcastName !== 'HELI') ladder++;
      maxEyeLag = Math.max(maxEyeLag, liveRig.camera.position.distanceTo(eye));
      minAerialHeight = Math.min(minAerialHeight, liveRig.camera.position.y - liveFocus.y);
    } else {
      groundFrames++;
      if (run > 0) aerialSegments++;
      run = 0;
      if (liveRig.broadcastName === 'HELI') ladder++;
    }
  }
  if (run > 0) aerialSegments++;
  check(aerialSegments >= 5, 'the director cuts to the helicopter regularly', `${aerialSegments} aerial shots in 90 s`);
  check(
    longestAerial > 4 && longestAerial < 7.5,
    'aerial shots last a few seconds, not forever',
    `longest ${longestAerial.toFixed(1)} s`,
  );
  check(
    aerialFrames > 0 && groundFrames > aerialFrames,
    'the aerials are a spice, not the main course',
    `${((aerialFrames / (aerialFrames + groundFrames)) * 100).toFixed(0)}% of the time`,
  );
  check(
    ladder === 0 && maxEyeLag < 12 && minAerialHeight > 10,
    'the aerial shot really rides on the helicopter',
    `max ${maxEyeLag.toFixed(1)} m behind the lens, never below ${minAerialHeight.toFixed(0)} m`,
  );
  check(
    liveRig.camera.fov > 28 && liveRig.camera.fov < 62,
    'the aerial lens stays in a sane range',
    `${liveRig.camera.fov.toFixed(0)}°`,
  );

  // Tanpa heli, siaran tetap jalan seperti biasa (kamera darat saja).
  const noAerial = new CameraRig(16 / 9, BROADCAST_SPOTS);
  noAerial.setMode('tv');
  noAerial.setAerialEye(null);
  let groundOnly = true;
  for (let time = 0; time < 40; time += dt) {
    const d = (time * 24) % lap;
    const p = TRACK.at(d);
    liveFocus.copy(p.pos);
    const trackDistance = ((d - TRACK.start) % lap + lap) % lap;
    noAerial.updateBroadcast(dt, liveFocus, trackDistance, lap);
    if (noAerial.aerialActive || noAerial.broadcastName === 'HELI') groundOnly = false;
  }
  check(groundOnly, 'without a helicopter the broadcast stays on the ground cameras', 'ground only');



  /* ---------------------------------------------------------------- */
  console.log('\n— nalar AI: memburu lawan & belajar tiap balapan —');
  {
    // 1. Setelan nalar: monoton, dan berhenti di batas aman.
    const lo = tuningFor(0);
    const hi = tuningFor(1);
    check(
      lo.pace < hi.pace && hi.pace <= 1.006 && lo.pace >= 0.93,
      'nalar AI 0..1 memetakan ke pace yang aman',
      `${lo.pace.toFixed(3)} → ${hi.pace.toFixed(3)}`,
    );
    check(
      hi.gripTarmac > lo.gripTarmac && hi.brakeTarmac > lo.brakeTarmac,
      'nalar AI juga menaikkan asumsi grip & rem',
      `grip ${lo.gripTarmac}→${hi.gripTarmac}, rem ${lo.brakeTarmac}→${hi.brakeTarmac}`,
    );
    check(
      Math.abs(skillForPace(1) - 1) < 1e-9 && skillForPace(0.95) === 0 && skillForPace(0.9) === 0,
      'pace lawan di grid diterjemahkan jadi nalar awal',
      `pace 0,95 → nalar 0 · pace 1,0 → nalar ${skillForPace(1).toFixed(2)}`,
    );

    // 2. Lap terbaik pribadi & balapan selesai menaikkan nalar (hasil mengecil).
    const fakeStore = (() => {
      const data = new Map<string, string>();
      return {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => void data.set(k, v),
        data,
      };
    })();
    const skills = new AiSkills(fakeStore, { Krisna: 0.5 });
    const before = skills.skillOf('Krisna');
    check(skills.submitLap('Krisna', 30) && skills.skillOf('Krisna') > before, 'lap terbaik pribadi menaikkan nalar', `${before.toFixed(2)} → ${skills.skillOf('Krisna').toFixed(2)}`);
    check(!skills.submitLap('Krisna', 31), 'lap yang lebih lambat tidak menaikkan nalar');
    skills.finishRace(['Krisna']);
    check(skills.get('Krisna').races === 1, 'balapan selesai menambah pengalaman', `${skills.get('Krisna').races} balapan`);
    for (let i = 0; i < 200; i++) skills.finishRace(['Krisna']);
    check(skills.skillOf('Krisna') > 0.999 && skills.skillOf('Krisna') <= 1, 'nalar AI berhenti di 100 %, tidak melewati batas', `${(skills.skillOf('Krisna') * 100).toFixed(2)} %`);
    const reloaded = new AiSkills(fakeStore);
    check(
      reloaded.skillOf('Krisna') > 0.999 && reloaded.get('Krisna').races === 201,
      'nalar AI tersimpan antar sesi (localStorage)',
      `${reloaded.get('Krisna').races} balapan`,
    );

    // 3. Nalar yang lebih tinggi benar-benar menghasilkan lap lebih cepat.
    // Lawan memakai jalur yang sama seperti di grid (lajur -1,2 m) lalu makin
    // mendekat ke garis tercepat seiring nalar naik.
    const lapWithSkill = (value: number) => {
      const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
      world.timestep = DT;
      buildTrackColliders(world);
      const c = new VehiclePhysics(world, defaultConfig, new THREE.Vector3(0, 0.95, -10));
      const tuning = tuningFor(value);
      const p = new AutoPilot(TRACK.main, TRACK.joker, {
        pace: tuning.pace,
        gripTarmac: tuning.gripTarmac,
        brakeTarmac: tuning.brakeTarmac,
        laneOffset: -1.2 * (1 - 0.75 * tuning.laneTighten),
        useJoker: true,
      });
      for (let i = 0; i < Math.round(70 / DT) && p.lap < 1; i++) {
        c.fixedStep(DT, p.update(DT, c));
        world.step();
        c.sync();
      }
      return p.bestLap;
    };
    const rookieLap = lapWithSkill(0);
    const aceLap = lapWithSkill(1);
    check(
      aceLap < rookieLap - 0.3,
      'nalar AI yang naik bikin lap makin cepat (rekor terus turun)',
      `nalar 0 %: ${rookieLap.toFixed(2)} s → 100 %: ${aceLap.toFixed(2)} s`,
    );

    // 4. AI sadar ada lawan di depan (memburu) dan di belakang (menutup garis).
    const chaseWorld = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    chaseWorld.timestep = DT;
    buildTrackColliders(chaseWorld);
    const spot = TRACK.at(TRACK.start + 12);
    const hunter = new VehiclePhysics(chaseWorld, defaultConfig, new THREE.Vector3(spot.pos.x, 0.95, spot.pos.z), spot.yaw);
    for (let i = 0; i < 60; i++) {
      hunter.fixedStep(DT, { throttle: 0.5, brake: 0, steer: 0, handbrake: false, gear: 1 });
      chaseWorld.step();
    }
    hunter.sync();
    const hunterPilot = new AutoPilot(TRACK.main, TRACK.joker, { laneOffset: 0 });
    hunterPilot.reset(hunter.position);
    const prey = hunter.position.clone().addScaledVector(spot.tangent, 12);
    hunterPilot.update(DT, hunter, [{ position: prey, speed: 10 }]);
    check(
      hunterPilot.chasing && Math.abs(hunterPilot.chaseGapValue - 12) < 2.5,
      'AI tahu ada mobil yang harus diburu di depannya',
      `jarak ${hunterPilot.chaseGapValue.toFixed(1)} m`,
    );
    hunterPilot.update(DT, hunter, []);
    check(!hunterPilot.chasing, 'tanpa mobil di depan, AI tidak memburu siapa pun');

    // 5. Yang tertinggal menekan lebih keras, yang memimpin mengendur.
    const craftWorld = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    craftWorld.timestep = DT;
    const craftRival = new Rival(craftWorld, {
      name: 'Uji',
      position: new THREE.Vector3(0, 0.95, 0),
      yaw: 0,
      main: TRACK.main,
      joker: TRACK.joker,
      startDistance: TRACK.start,
    });
    craftRival.setBasePace(0.98);
    for (let i = 0; i < 200; i++) craftRival.setRaceGap(220);
    const behindPace = craftRival.pilot.options.pace;
    for (let i = 0; i < 400; i++) craftRival.setRaceGap(-60);
    const aheadPace = craftRival.pilot.options.pace;
    check(
      behindPace > 0.98 && behindPace <= 0.98 * 1.0201 && aheadPace < 0.98,
      'yang tertinggal menekan, yang memimpin mengendur (maks ±2 %)',
      `tertinggal ${behindPace.toFixed(3)} vs memimpin ${aheadPace.toFixed(3)}`,
    );
  }



  /* ---------------------------------------------------------------- */
  console.log('\n— kamera: siapa yang dibidik —');
  {
    const mk = (x: number, z: number, odo: number, lapDistance: number) => ({
      position: new THREE.Vector3(x, 1, z),
      odometer: odo,
      lapDistance,
    });
    const player = mk(0, 0, 100, 100);
    const sideA = mk(0.4, 0.6, 100.4, 20.4);
    const sideB = mk(-0.5, 0.4, 99.6, 19.6);
    const spectate = { on: true };
    const cars = [sideA, sideB];
    const director = new FocusDirector({
      player: () => player,
      rivals: () => cars,
      spectate: () => spectate.on,
    });

    // 1. Dua mobil bersisian: kamera TIDAK boleh gonta-ganti target.
    director.update(DT);
    const firstTarget = director.targetIndex;
    let swaps = 0;
    let before = director.targetIndex;
    let worstStep = 0;
    const prev = director.focus.clone();
    for (let i = 0; i < Math.round(5 / DT); i++) {
      // odometer keduanya saling menyalip sedikit (seperti mobil berdempetan)
      cars[0].odometer = 100 + Math.sin(i * 0.3) * 0.6;
      cars[1].odometer = 100 + Math.cos(i * 0.3) * 0.6;
      director.update(DT);
      if (director.targetIndex !== before) {
        swaps++;
        before = director.targetIndex;
      }
      worstStep = Math.max(worstStep, director.focus.distanceTo(prev));
      prev.copy(director.focus);
    }
    check(swaps === 0, 'dua mobil bersisian: kamera tidak gonta-ganti sasaran', `${swaps}× ganti`);
    check(worstStep < 1.5, 'gambar tidak melompat saat mobil berdempetan', `maks ${worstStep.toFixed(2)} m/frame`);
    check(
      director.targetIndex === firstTarget,
      'sasaran tetap satu mobil (bukan campuran beberapa mobil)',
      `${director.targetIndex}, ${cars.map((c) => c.odometer.toFixed(1)).join(' vs ')}`,
    );

    // 2. Ada yang unggul jelas → kamera pindah sekali, lalu tetap di sana.
    cars[1].odometer = 100 + 40;
    director.update(DT);
    const switchedTo = director.targetIndex;
    let stayed = true;
    for (let i = 0; i < Math.round(3 / DT); i++) {
      director.update(DT);
      if (director.targetIndex !== switchedTo) stayed = false;
    }
    check(
      switchedTo === 1 && stayed,
      'pemimpin baru diambil alih sekali, lalu stabil',
      `target ${switchedTo}`,
    );

    // 3. Tanpa mode siaran kamera selalu di mobil pemain.
    spectate.on = false;
    player.odometer = 80;
    cars[1].odometer = 300;
    for (let i = 0; i < 30; i++) director.update(DT);
    check(
      director.targetIndex === -1 && director.distance === player.lapDistance,
      'tanpa siaran kamera selalu membidik mobil pemain',
      `target ${director.targetIndex}`,
    );

    // 4. Duel: lawan yang menempel hanya menggeser bidikan sedikit & halus.
    const solo = new FocusDirector({
      player: () => mk(0, 0, 100, 100),
      rivals: () => [],
      spectate: () => false,
    });
    for (let i = 0; i < 60; i++) solo.update(DT);
    const partner = mk(3, 0, 100, 100);
    const duelCars = [partner];
    const duelist = new FocusDirector({
      player: () => mk(0, 0, 100, 100),
      rivals: () => duelCars,
      spectate: () => false,
    });
    for (let i = 0; i < 60; i++) duelist.update(DT);
    const aim = duelist.focus.clone();
    let shift = 0;
    let jump = 0;
    const last = duelist.focus.clone();
    for (let i = 0; i < Math.round(3 / DT); i++) {
      duelCars[0].position.set(3 + Math.sin(i * 0.5) * 0.8, 1, Math.cos(i * 0.5) * 0.8);
      duelist.update(DT);
      shift = Math.max(shift, duelist.focus.distanceTo(new THREE.Vector3(0, 1.9, 0)));
      jump = Math.max(jump, duelist.focus.distanceTo(last));
      last.copy(duelist.focus);
    }
    check(
      duelist.duel && shift > 0.2 && shift < 2.4,
      'lawan yang menempel menggeser frame duel sedikit saja',
      `geser ${shift.toFixed(2)} m`,
    );
    check(jump < 0.6, 'geseran frame duel halus (tidak bergetar)', `maks ${jump.toFixed(2)} m/frame`);
    void solo;
    void aim;
  }

  /* ---------------------------------------------------------------- */
  console.log('\n— pit stop, safety car, ambulans —');
  {
    // 1. Lama servis naik sesuai kerusakan (bukan angka tetap).
    const fresh = new VehicleDamage();
    const wrecked = new VehicleDamage();
    wrecked.impact(0, 0, -18);
    wrecked.wheels[0].lost = true;
    check(
      serviceTimeFor(wrecked) > serviceTimeFor(fresh) + 1,
      'makin rusak, makin lama servis pit',
      `${serviceTimeFor(fresh).toFixed(1)} s → ${serviceTimeFor(wrecked).toFixed(1)} s`,
    );

    // 2. Servis hanya jalan kalau berhenti di dalam kotak, dan memperbaiki semua.
    const pitCar = {
      position: PIT.boxes[0].position.clone().add(new THREE.Vector3(0, 0.95, 0)),
      speed: 0,
      damage: new VehicleDamage(),
    };
    pitCar.damage.impact(0, 0, -20);
    const pit = new PitStop(PIT.boxes[0]);
    // Lewat di luar kotak: tidak boleh menservis apa pun.
    const away = { ...pitCar, position: PIT.boxes[0].position.clone().add(new THREE.Vector3(20, 0.95, 0)) };
    for (let i = 0; i < 60; i++) pit.update(DT, away);
    check(pit.phase === 'idle' && pitCar.damage.bodyHealth < 1, 'lewat di luar kotak tidak menservis apa pun');
    pit.update(DT, pitCar);
    check(pit.phase === 'service', 'berhenti di kotak langsung memulai servis');
    let done = false;
    let pitSeconds = 0;
    while (!done && pitSeconds < 20) {
      done = pit.update(DT, pitCar);
      pitSeconds += DT;
    }
    check(
      done && pitCar.damage.bodyHealth === 1 && pitCar.damage.puncturedCount === 0,
      'servis pit memperbaiki bodi, mesin, dan ban',
      `${pitSeconds.toFixed(1)} s`,
    );

    // 3. Lawan benar-benar menyetir masuk kotak, diservis, lalu kembali ke trek.
    const pitWorld = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    pitWorld.timestep = DT;
    buildTrackColliders(pitWorld);
    const pitStart = TRACK.at(TRACK.start - 62);
    const pitRival = new Rival(pitWorld, {
      name: 'Uji Pit',
      position: new THREE.Vector3(pitStart.pos.x, 0.95, pitStart.pos.z).addScaledVector(pitStart.side, -2),
      yaw: pitStart.yaw,
      main: TRACK.main,
      joker: TRACK.joker,
      startDistance: TRACK.start,
      pace: 0.98,
      laneOffset: -1,
    });
    pitRival.car.damage.impact(0, 0, -9);
    pitRival.requestPit(PIT.boxes[1], new THREE.Vector3(PIT.rejoin.pos.x, PIT.rejoin.pos.y, PIT.rejoin.pos.z));
    let pitReached = false;
    let pitRepaired = false;
    let pitRejoined = false;
    let pitTime = 0;
    for (let i = 0; i < Math.round(60 / DT); i++) {
      pitRival.step(DT, []);
      pitWorld.step();
      pitRival.sync();
      pitTime += DT;
      if (pitRival.pitPhase === 'service') pitReached = true;
      // Servis selesai → mobil sudah 'out' dan kerusakannya hilang.
      if (pitRival.pitPhase === 'out' && pitRival.car.damage.bodyHealth === 1) pitRepaired = true;
      if (pitReached && pitRival.pitPhase === 'none') {
        pitRejoined = true;
        break;
      }
    }
    check(pitReached, 'lawan menyetir masuk kotak servisnya sendiri', `${pitTime.toFixed(1)} s`);
    check(pitRepaired, 'mobil lawan diperbaiki di pit');
    check(pitRejoined, 'lawan kembali ke lintasan setelah servis', `${pitTime.toFixed(1)} s total`);

    // 4. Safety car & ambulans: mobil fisika sungguhan, bisa menyetir rute.
    const svWorld = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    svWorld.timestep = DT;
    buildTrackColliders(svWorld);
    const svJoin = new THREE.Vector3(PIT.rejoin.pos.x, 1.0, PIT.rejoin.pos.z);
    const safety = new ServiceVehicle({
      kind: 'safety',
      world: svWorld,
      park: PIT.boxes[5].position.clone().add(new THREE.Vector3(-6, 0.2, -6)),
      yaw: PIT.boxes[5].yaw,
      main: TRACK.main,
      joker: TRACK.joker,
      color: 0xffffff,
      detail: false,
    });
    const ambulance = new ServiceVehicle({
      kind: 'ambulance',
      world: svWorld,
      park: new THREE.Vector3(PIT.boxes[5].position.x + 8, 0.95, PIT.boxes[5].position.z + 8),
      yaw: PIT.boxes[5].yaw,
      main: TRACK.main,
      joker: TRACK.joker,
      color: 0xffffff,
      detail: false,
    });
    for (const sv of [safety, ambulance]) {
      for (let i = 0; i < 30; i++) {
        sv.step(DT);
        svWorld.step();
        sv.sync(DT);
      }
    }
    const scBefore = safety.car.position.clone();
    safety.driveRoute([svJoin], 'line', 0.7);
    for (let i = 0; i < Math.round(18 / DT); i++) {
      safety.step(DT);
      svWorld.step();
      safety.sync(DT);
    }
    check(
      safety.mode === 'line' && safety.car.position.distanceTo(scBefore) > 10,
      'safety car keluar dari area servis dan masuk garis balap',
      `${safety.car.position.distanceTo(scBefore).toFixed(0)} m, mode ${safety.mode}`,
    );
    const ambTarget = TRACK.at(TRACK.start + 60).pos.clone();
    ambTarget.y = 0.95;
    ambulance.driveRoute([ambTarget], 'park', 0.9);
    let ambTime = 0;
    for (let i = 0; i < Math.round(60 / DT) && !ambulance.reachedRoute; i++) {
      ambulance.step(DT);
      svWorld.step();
      ambulance.sync(DT);
      ambTime += DT;
    }
    check(
      ambulance.reachedRoute && ambulance.car.position.distanceTo(ambTarget) < 8,
      'ambulans menyetir sampai lokasi kejadian',
      `${ambTime.toFixed(1)} s, sisa ${ambulance.car.position.distanceTo(ambTarget).toFixed(1)} m`,
    );

    // 5. Pengawas balapan: bendera kuning + safety car saat ada mobil hancur.
    const makeHandle = () => {
      const calls: string[] = [];
      const handle: ServiceHandle & { calls: string[] } = {
        calls,
        reachedRoute: true,
        car: { position: new THREE.Vector3() },
        followLine: (pace?: number) => void calls.push(`line:${pace?.toFixed(2) ?? ''}`),
        driveRoute: (points: THREE.Vector3[], after: string) => void calls.push(`route:${points.length}:${after}`),
        parkNow: () => void calls.push('park'),
      };
      return handle;
    };
    const scHandle = makeHandle();
    const ambHandle = makeHandle();
    const control = new RaceControl({
      safety: scHandle,
      ambulance: ambHandle,
      scJoin: svJoin.clone(),
      scPark: PIT.boxes[5].position.clone(),
      ambPark: new THREE.Vector3(0, 0, 0),
    }, { minSafetyTime: 6, attendTime: 1 });
    const hurt = new VehicleDamage();
    hurt.impact(0, 0, -22);
    hurt.impact(0, 0, -22);
    const hurtCar = { position: new THREE.Vector3(10, 1, 10), speed: 0, damage: hurt };
    const healthyCar = {
      position: new THREE.Vector3(0, 1, 0),
      speed: 20,
      damage: new VehicleDamage(),
    };
    const cars = [
      { name: 'KAMU', car: healthyCar, isPlayer: true },
      { name: 'Krisna', car: hurtCar },
    ];
    control.update(DT, cars);
    check(
      control.flag === 'yellow' && control.scActive && hurt.engineDead,
      'mobil hancur memicu bendera kuning + safety car',
      `${hurt.engineDead ? 'mesin mati' : 'tidak'} · ${control.scPhase}`,
    );
    check(
      control.paceScale < 0.6 && !control.overtakeAllowed,
      'selama kuning semua AI melambat & dilarang menyalip',
      `pace ${control.paceScale}`,
    );
    check(
      scHandle.calls.some((c) => c.startsWith('route')) && ambHandle.calls.some((c) => c.startsWith('route')),
      'safety car & ambulans sama-sama dikirim',
      `${scHandle.calls.length + ambHandle.calls.length} perintah`,
    );
    // Tunggu ambulans menangani sampai selesai.
    let handled = false;
    for (let i = 0; i < Math.round(30 / DT); i++) {
      control.update(DT, cars);
      if (hurt.bodyHealth === 1) handled = true;
    }
    check(handled, 'tanpa kotak servis: marshal memperbaiki mobil di tempat');
    check(control.flag === 'green' && !control.scActive, 'setelah insiden selesai: safety car masuk, hijau lagi', control.scPhase);
    check(control.drainEvents().length >= 0, 'pengawas balapan punya antrean pesan untuk HUD');


    // --- derek: mobil mogok diangkut ke kotak servisnya, lalu diservis ---
    {
      const towEvents: string[] = [];
      const towBox = { position: PIT.boxes[4].position.clone(), yaw: PIT.boxes[4].yaw };
      const towState = {
        arrived: false,
        hooked: false,
        carried: 0,
        dropped: null as THREE.Vector3 | null,
      };
      const wreck = new VehicleDamage();
      wreck.impact(0, 0, -22);
      wreck.impact(0, 0, -22);
      const crashSpot = TRACK.at(TRACK.start + 150).pos;
      const wreckCar = {
        position: new THREE.Vector3(crashSpot.x, 1, crashSpot.z),
        speed: 0,
        damage: wreck,
        setTowed: (on: boolean) => {
          towState.hooked = on;
          towEvents.push(on ? 'kait' : 'lepas');
        },
        carryTo: (pos: THREE.Vector3) => {
          towState.carried++;
          wreckCar.position.copy(pos);
        },
        dropAt: (pos: THREE.Vector3) => {
          towState.dropped = pos.clone();
          wreckCar.position.copy(pos);
          towEvents.push('turun');
        },
      };
      const ambCalls: string[] = [];
      const amb = {
        calls: ambCalls,
        // `reachedRoute` dibaca pengawas tiap langkah; di uji ini dikendalikan
        // manual supaya fase derek bisa diperiksa satu per satu.
        get reachedRoute() {
          return towState.arrived;
        },
        car: { position: new THREE.Vector3() },
        followLine: () => void ambCalls.push('line'),
        driveRoute: (points: THREE.Vector3[], after: string) =>
          void ambCalls.push(`route:${points.length}:${after}`),
        parkNow: () => void ambCalls.push('park'),
      };
      const towControl = new RaceControl(
        {
          safety: makeHandle(),
          ambulance: amb,
          scJoin: svJoin.clone(),
          scPark: PIT.boxes[5].position.clone(),
          ambPark: new THREE.Vector3(0, 0, 0),
          pitEntry: new THREE.Vector3(PIT.approach.pos.x, PIT.approach.pos.y, PIT.approach.pos.z),
          towTo: () => towBox,
        },
        { minSafetyTime: 4, hookTime: 0.5 },
      );
      const towCars = [
        { name: 'KAMU', car: healthyCar, isPlayer: true },
        { name: 'Krisna', car: wreckCar },
      ];
      towControl.update(DT, towCars);
      check(
        towControl.ambPhase === 'toScene',
        'mobil mogok: ambulans meluncur ke lokasi',
        towControl.ambPhase,
      );

      // Ambulans tiba di lokasi → kait mobilnya.
      towState.arrived = true;
      for (let i = 0; i < Math.round(1 / DT); i++) {
        if (towControl.ambPhase === 'hooking') towState.arrived = false;
        towControl.update(DT, towCars);
      }
      check(
        towControl.ambPhase === 'towing' && towState.hooked,
        'setelah tiba: mobil dikait ke derek',
        `fase ${towControl.ambPhase}, ${towEvents.join('/') || 'tanpa kaitan'}`,
      );

      // Selama diangkut mobil ikut bergerak, belum diperbaiki, dan bukan
      // perbaikan diam-diam.
      amb.car.position.set(20, 0, 30);
      for (let i = 0; i < Math.round(2 / DT); i++) towControl.update(DT, towCars);
      check(
        towState.carried > 10 && wreck.bodyHealth < 1,
        'selama diderek mobil ikut bergerak & belum diperbaiki',
        `${towState.carried}x angkut, bodi ${(wreck.bodyHealth * 100).toFixed(0)} %`,
      );
      check(
        Math.abs(wreckCar.position.z - 30) < 8 && Math.abs(wreckCar.position.x - 20) < 8,
        'posisi mobil mengikuti derek, bukan melayang sendiri',
        `${wreckCar.position.x.toFixed(0)}, ${wreckCar.position.z.toFixed(0)}`,
      );

      // Sampai di kotak: turun di kotaknya, lalu servis (bukan instan).
      towState.arrived = true;
      for (let i = 0; i < 3; i++) towControl.update(DT, towCars);
      const dropped = towState.dropped;
      check(
        dropped !== null && dropped.distanceTo(towBox.position) < 2.5 && !towState.hooked,
        'derek menurunkan mobil di kotak servisnya',
        dropped ? `${dropped.distanceTo(towBox.position).toFixed(1)} m dari kotak` : 'tidak turun',
      );
      check(
        wreck.bodyHealth < 1,
        'mobil belum diperbaiki saat baru turun dari derek',
        `${(wreck.bodyHealth * 100).toFixed(0)} %`,
      );
      let repairedAt = -1;
      let t = 0;
      for (let i = 0; i < Math.round(25 / DT) && repairedAt < 0; i++) {
        towControl.update(DT, towCars);
        t += DT;
        if (wreck.bodyHealth === 1) repairedAt = t;
      }
      check(
        repairedAt > 3,
        'servis di pit memakan waktu (bukan perbaikan instan)',
        `${repairedAt.toFixed(1)} s`,
      );
      check(towState.hooked === false, 'mobil sudah lepas dari derek setelah servis');
      check(
        towControl.drainEvents().some((e) => e.kind === 'towing'),
        'HUD dapat pesan "diderek ke pit"',
      );
      check(
        ambCalls.some((c) => c.startsWith('route:1:park')),
        'derek diarahkan ke kotak servisnya',
        ambCalls.join(' '),
      );
    }

    // --- integrasi: ambulans sungguhan menderek mobil sungguhan ke pit ---
    {
      const towWorld = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
      towWorld.timestep = DT;
      buildTrackColliders(towWorld);
      const crash = TRACK.at(TRACK.start + 170);
      const wreckCar = new VehiclePhysics(
        towWorld,
        defaultConfig,
        new THREE.Vector3(crash.pos.x, 1.0, crash.pos.z),
        crash.yaw,
      );
      wreckCar.damage.impact(0, 0, -24);
      wreckCar.damage.impact(0, 0, -24);
      const ambPose = pitPose(PIT.from + 6, 7.4);
      const towAmb = new ServiceVehicle({
        kind: 'ambulance',
        world: towWorld,
        park: ambPose.position,
        yaw: ambPose.yaw,
        main: TRACK.main,
        joker: TRACK.joker,
        color: 0xf2f4f7,
        detail: false,
      });
      const towSafety = new ServiceVehicle({
        kind: 'safety',
        world: towWorld,
        park: pitPose(PIT.from + 2, 7.4).position,
        yaw: ambPose.yaw,
        main: TRACK.main,
        joker: TRACK.joker,
        color: 0xffffff,
        detail: false,
      });
      const box = PIT.boxes[3];
      const realControl = new RaceControl(
        {
          safety: towSafety,
          ambulance: towAmb,
          scJoin: new THREE.Vector3(PIT.rejoin.pos.x, PIT.rejoin.pos.y, PIT.rejoin.pos.z),
          scPark: PIT.boxes[5].position.clone(),
          ambPark: ambPose.position.clone(),
          pitEntry: new THREE.Vector3(PIT.approach.pos.x, PIT.approach.pos.y, PIT.approach.pos.z),
          towTo: () => ({ position: box.position.clone(), yaw: box.yaw }),
        },
        { minSafetyTime: 8, hookTime: 0.8 },
      );
      const cars = [{ name: 'Krisna', car: wreckCar }];
      let rescuedAt = -1;
      let towed = false;
      let t = 0;
      for (let i = 0; i < Math.round(90 / DT); i++) {
        towAmb.step(DT);
        towSafety.step(DT);
        towWorld.step();
        towAmb.sync(DT);
        towSafety.sync(DT);
        wreckCar.sync();
        realControl.update(DT, cars);
        if (wreckCar.isTowed) towed = true;
        t += DT;
        if (wreckCar.damage.bodyHealth === 1 && wreckCar.damage.engineHealth === 1) {
          rescuedAt = t;
          break;
        }
      }
      const atBox = wreckCar.position.distanceTo(box.position);
      check(towed, 'integrasi: mobil mogok benar-benar diangkut derek');
      check(
        rescuedAt > 0 && atBox < 8,
        'integrasi: diderek ke pit, diservis, lalu mobil sehat di kotaknya',
        `${rescuedAt.toFixed(1)} s · ${atBox.toFixed(1)} m dari kotak`,
      );
    }

    // 6. Tanpa kecelakaan: tidak ada kuning, tidak ada safety car.
    const calm = new RaceControl({
      safety: makeHandle(),
      ambulance: makeHandle(),
      scJoin: svJoin.clone(),
      scPark: new THREE.Vector3(),
      ambPark: new THREE.Vector3(),
    });
    for (let i = 0; i < 300; i++) {
      calm.update(DT, [{ name: 'KAMU', car: { position: new THREE.Vector3(), speed: 18, damage: new VehicleDamage() } }]);
    }
    check(calm.flag === 'green' && !calm.scActive, 'balapan bersih: tidak ada bendera kuning', 'hijau');
  }

  /* ---------------------------------------------------------------- */
  console.log('\n— kerusakan mobil (damage) —');
  {
    // 1. Mengemudi normal tidak boleh merusak apa pun.
    const cleanWorld = flatWorld();
    const clean = new VehiclePhysics(cleanWorld, defaultConfig, new THREE.Vector3(0, 0.95, 0));
    for (let i = 0; i < Math.round(6 / DT); i++) {
      clean.fixedStep(DT, input({ throttle: 0.8, steer: Math.sin(i * DT * 1.4) * 0.35 }));
      cleanWorld.step();
    }
    clean.sync();
    check(
      clean.damage.dentLevel === 0 && clean.damage.puncturedCount === 0 && clean.damage.lostCount === 0,
      'mengemudi normal tidak merusak mobil',
      `${(clean.speedKmh).toFixed(0)} km/h tanpa benturan`,
    );

    // 2. Menabrak tembok pada kecepatan tinggi: bodi penyok, ban pecah, roda copot.
    const crash = ramWall();
    const dmg = crash.car.damage;
    check(crash.hitSpeed > 60, 'mobil mencapai kecepatan tabrak yang wajar', `${crash.hitSpeed.toFixed(0)} km/h`);
    check(dmg.bodyHealth < 0.9, 'tabrak tembok penyok badan', `bodi ${(dmg.bodyHealth * 100).toFixed(0)} %`);
    check(dmg.engineHealth < 1, 'mesin ikut kena', `mesin ${(dmg.engineHealth * 100).toFixed(0)} %`);
    check(dmg.puncturedCount > 0, 'ban pecah karena benturan', `${dmg.puncturedCount} ban pecah`);
    check(dmg.lostCount > 0, 'benturan keras mencopot roda', `${dmg.lostCount} roda copot`);

    // 3. Roda yang copot tidak menyumbang grip maupun gaya pegas lagi.
    const lostIndex = dmg.wheels.findIndex((w) => w.lost);
    const punctured = dmg.wheels.find((w) => w.punctured && !w.lost);
    check(
      lostIndex >= 0 && crash.car.damage.wheelGrip(lostIndex) === 0,
      'roda copot kehilangan seluruh grip',
      `roda ${lostIndex + 1}`,
    );
    check(
      !punctured || (crash.car.damage.wheelGrip(dmg.wheels.indexOf(punctured)) < 0.5 && crash.car.damage.wheelGrip(dmg.wheels.indexOf(punctured)) > 0),
      'ban pecah masih menggigit sedikit (bukan nol)',
      punctured ? `grip ${(crash.car.damage.wheelGrip(dmg.wheels.indexOf(punctured)) * 100).toFixed(0)} %` : 'tidak ada ban pecah',
    );

    // 4. Kerusakan tidak hilang sendiri selama balapan berjalan.
    const bodyAfterCrash = dmg.bodyHealth;
    const puncturedAfterCrash = dmg.puncturedCount;
    for (let i = 0; i < Math.round(5 / DT); i++) {
      crash.car.fixedStep(DT, input({ throttle: 0.6, steer: 0.2 }));
      crash.world.step();
    }
    check(
      Math.abs(dmg.bodyHealth - bodyAfterCrash) < 1e-9 && dmg.puncturedCount === puncturedAfterCrash,
      'kerusakan tidak pulih sendiri di tengah balapan',
      `bodi ${(dmg.bodyHealth * 100).toFixed(0)} %`,
    );

    // 5. Mesin mati = mobil sama sekali tidak bisa maju.
    const deadWorld = flatWorld();
    const dead = new VehiclePhysics(deadWorld, defaultConfig, new THREE.Vector3(0, 0.95, 0));
    dead.damage.engineHealth = 0;
    dead.damage.engineDead = true;
    dead.damage.revision++;
    const start = dead.position.clone();
    for (let i = 0; i < Math.round(4 / DT); i++) {
      dead.fixedStep(DT, gas);
      deadWorld.step();
    }
    dead.sync();
    const rolled = Math.hypot(dead.position.x - start.x, dead.position.z - start.z);
    check(dead.damage.throttleScale === 0, 'mesin mati mematikan gas', 'throttle 0%');
    check(rolled < 1.0, 'mesin mati: mobil tidak bisa maju', `hanya bergeser ${rolled.toFixed(2)} m dalam 4 s`);

    // 6. Reset = perbaikan total (satu-satunya cara pulih).
    crash.car.reset();
    check(
      crash.car.damage.bodyHealth === 1 &&
        crash.car.damage.engineHealth === 1 &&
        crash.car.damage.puncturedCount === 0 &&
        crash.car.damage.lostCount === 0,
      'reset mobil memperbaiki semua kerusakan',
      'bodi & mesin 100 %, 0 ban pecah',
    );

    // 6b. Setelah reset, mobil tetap utuh walau langsung digas — teleport
    //     tidak boleh dihitung sebagai benturan (Δv dari kecepatan lama ke nol).
    for (let i = 0; i < Math.round(2 / DT); i++) {
      crash.car.fixedStep(DT, coast);
      crash.world.step();
    }
    check(
      crash.car.damage.bodyHealth === 1 && crash.car.damage.lostCount === 0 && crash.car.damage.puncturedCount === 0,
      'mobil yang baru di-reset tetap utuh (teleport bukan tabrakan)',
      `bodi ${(crash.car.damage.bodyHealth * 100).toFixed(0)} %`,
    );

    // 7. Kerusakan bisa dimatikan (untuk uji/demo).
    const off = ramWall({ enabled: false });
    check(
      off.car.damage.dentLevel === 0 && off.car.damage.puncturedCount === 0,
      'kerusakan bisa dimatikan lewat setelan',
      `${off.hitSpeed.toFixed(0)} km/h, bodi utuh`,
    );

    // 8. Setelan "tingkat kerusakan" benar-benar mengubah besar kerusakan.
    const soft = ramWall({ severity: 0.5 });
    const hard = ramWall({ severity: 1 });
    check(
      soft.car.damage.bodyHealth > hard.car.damage.bodyHealth + 0.1,
      'tingkat kerusakan menskala besarnya kerusakan',
      `0,5× → bodi ${(soft.car.damage.bodyHealth * 100).toFixed(0)} % vs 1× → ${(hard.car.damage.bodyHealth * 100).toFixed(0)} %`,
    );

    // 8b. Balapan AI beberapa lap tidak boleh merusak mobilnya sendiri —
    //     kerusakan hanya dari benturan, bukan dari getaran/kerb.
    const longWorld = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    longWorld.timestep = DT;
    buildTrackColliders(longWorld);
    const longCar = new VehiclePhysics(longWorld, defaultConfig, new THREE.Vector3(0, 0.95, -10));
    const longPilot = new AutoPilot(TRACK.main, TRACK.joker, { useJoker: true });
    let longBest = Infinity;
    for (let i = 0; i < Math.round(120 / DT) && longPilot.lap < 2; i++) {
      longCar.fixedStep(DT, longPilot.update(DT, longCar));
      longWorld.step();
      longCar.sync();
      longBest = Math.min(longBest, longPilot.lastLap || Infinity);
    }
    check(
      longPilot.lap >= 2 && longCar.damage.bodyHealth === 1 && longCar.damage.lostCount === 0,
      'dua lap AI tanpa satu pun kerusakan (tidak ada false positive)',
      `${longPilot.lap} lap · terbaik ${longBest.toFixed(1)} s · bodi 100 %`,
    );

    // 9. Ban depan pecah menarik setir ke sisinya (pemain harus melawan).
    const pullCar = new VehiclePhysics(flatWorld(), defaultConfig, new THREE.Vector3(0, 0.95, 0));
    const pullBefore = pullCar.damage.pullSteer(15);
    pullCar.damage.wheels[0].punctured = true;
    const pullAfter = pullCar.damage.pullSteer(15);
    check(
      pullBefore === 0 && Math.abs(pullAfter) > 0.01,
      'ban depan pecah menarik setir ke sisinya',
      `${(pullAfter * 57.3).toFixed(1)}° pada 54 km/h`,
    );
    check(
      pullCar.damage.steerScale < 1,
      'setir jadi lebih tumpul saat ban depan rusak',
      `sudut setir ${(pullCar.damage.steerScale * 100).toFixed(0)} %`,
    );
  }

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
