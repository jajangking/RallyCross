import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import GUI from 'lil-gui';
import { defaultConfig, VehiclePhysics, type VehicleInput } from './vehicle/VehiclePhysics';
import { CarVisual } from './vehicle/CarVisual';
import { CarModelVisual } from './vehicle/CarModelVisual';
import { buildTrack, TRACK } from './world/track';
import { AutoPilot, type TrafficCar } from './ai/AutoPilot';
import { Rival } from './race/Rival';
import { LapCounter } from './race/LapCounter';
import { Input } from './input';
import { Hud } from './hud';
import { CameraRig } from './camera';
import type { CarLightState } from './vehicle/CarLights';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 5;

type PresetName = 'tarmac' | 'gravel' | 'ice';

async function boot() {
  await RAPIER.init();

  const bootEl = document.getElementById('boot')!;
  const app = document.getElementById('app')!;

  // `?quality=low` -> no shadow maps, 1x pixel ratio (weak phones / headless test)
  const lowQuality = new URLSearchParams(location.search).get('quality') === 'low';

  /* ---------------- renderer ---------------- */
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: !lowQuality, powerPreference: 'high-performance' });
  } catch (err) {
    bootEl.textContent = 'WebGL tidak tersedia di browser ini.';
    throw err;
  }

  // Low quality pins the pixel ratio at 1x; keep that decision for resizes too
  // (phones re-fire `resize` whenever the address bar appears/disappears).
  const maxPixelRatio = lowQuality ? 1 : Math.min(window.devicePixelRatio, 2);
  renderer.setPixelRatio(maxPixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = !lowQuality;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.06;
  app.appendChild(renderer.domElement);

  /* ---------------- scene ---------------- */
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x121820);
  scene.fog = new THREE.Fog(0x121820, 90, 420);

  // A tiny procedural environment map is what makes the paint, glass and
  // mirrors read as real materials instead of flat colours.
  if (!lowQuality) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    scene.environment = pmrem.fromScene(room, 0.04).texture;
    room.dispose();
    pmrem.dispose();
  }

  const hemi = new THREE.HemisphereLight(0xb7d2ef, 0x2b2419, 1.15);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff0da, 2.3);
  sun.position.set(45, 65, 25);
  sun.castShadow = !lowQuality;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -45;
  sun.shadow.camera.right = 45;
  sun.shadow.camera.top = 45;
  sun.shadow.camera.bottom = -45;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 220;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.035;
  scene.add(sun);
  scene.add(sun.target);

  /* ---------------- physics + world + car ---------------- */
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = FIXED_DT;

  const track = buildTrack(world, scene);

  // first grid slot, ten metres behind the start/finish line
  const car = new VehiclePhysics(world, defaultConfig, new THREE.Vector3(0, 0.95, -10));

  // The hand-built body is only a stand-in: the detailed GLB in `public/models`
  // replaces it as soon as it is decoded (and stays if the download fails).
  const proceduralCar = new CarVisual(scene, car, { detail: !lowQuality });
  let carVisual: CarVisual | CarModelVisual = proceduralCar;
  const modelUrl = new URL('models/honda-civic-eg6.glb', document.baseURI).href;
  const paintParam = new URLSearchParams(location.search).get('paint');
  const paint = paintParam && /^[0-9a-f]{6}$/i.test(paintParam) ? parseInt(paintParam, 16) : undefined;
  void CarModelVisual.load(scene, car, modelUrl, { detail: !lowQuality, paint }).then((model) => {
    if (!model) return;
    proceduralCar.dispose();
    carVisual = model;
  });

  /* ---------------- lawan (mobil kedua, disetir AI) ---------------- */
  // Same physics, same tyres: the rival only knows the racing line better and
  // starts one grid row back, with its own lane so the two cars do not fight
  // for the same piece of tarmac.
  const gridRow = TRACK.at(TRACK.start - 20);
  const rival = new Rival(world, {
    position: new THREE.Vector3(gridRow.pos.x, 0.95, gridRow.pos.z).addScaledVector(gridRow.side, -3.8),
    yaw: gridRow.yaw,
    main: TRACK.main,
    joker: TRACK.joker,
    startDistance: TRACK.start,
    pace: 0.94,
    laneOffset: -2,
  });
  const rivalProcedural = new CarVisual(scene, rival.car, { detail: !lowQuality });
  let rivalVisual: CarVisual | CarModelVisual = rivalProcedural;
  void CarModelVisual.load(scene, rival.car, new URL('models/honda-civic-eg6.glb', document.baseURI).href, {
    detail: !lowQuality,
    paint: 0xc22a1c,
  }).then((model) => {
    if (!model) return;
    rivalProcedural.dispose();
    rivalVisual = model;
    // keep it hidden if the player already switched the rival off
    model.root.visible = race.rival;
  });

  const playerLaps = new LapCounter(TRACK.main, TRACK.start, car.position);
  const race = {
    laps: 3,
    rival: true,
    pace: rival.pilot.options.pace,
    winner: null as null | 'player' | 'rival',
  };
  // Preallocated "what is around me" lists for the two pilots.
  const rivalAround: TrafficCar[] = [{ position: rival.car.position, speed: 0 }];
  const playerAround: TrafficCar[] = [{ position: car.position, speed: 0 }];

  /* ---------------- autopilot ---------------- */
  // The pilot drives the very same `VehicleInput` interface as the keyboard,
  // so it can be switched on and off mid-lap without touching the physics.
  const pilot = new AutoPilot(TRACK.main, TRACK.joker);
  const auto = {
    enabled: false,
    useJoker: true,
    jumpSpeed: pilot.options.jumpSpeed,
  };
  let aiToggle: { updateDisplay(): void } | null = null;
  let rivalToggle: { updateDisplay(): void } | null = null;

  /* ---------------- camera / input / hud ---------------- */
  const cameraRig = new CameraRig(window.innerWidth / window.innerHeight);
  cameraRig.snap(car);

  const hud = new Hud(car.cfg.mass);

  let gui!: GUI;
  let guiOpen = false;

  const setGui = (open: boolean) => {
    if (!gui) return;
    guiOpen = open;
    if (open) gui.open();
    else gui.close();
  };

  // A reset puts the car back on the grid, so the gear lever follows it.
  const resetCar = () => {
    car.reset();
    cameraRig.snap(car);
    input.setGear(1);
    pilot.reset(car.position);
    playerLaps.reset(car.position);
    if (race.rival) rival.resetToGrid();
    rivalVisual.root.visible = race.rival;
    race.winner = null;
  };

  const setRival = (on: boolean) => {
    race.rival = on;
    rivalVisual.root.visible = on;
    if (on) rival.resetToGrid();
    else rival.park();
    playerLaps.reset(car.position);
    race.winner = null;
    rivalToggle?.updateDisplay();
  };

  const setAutopilot = (on: boolean) => {
    auto.enabled = on;
    if (on) {
      pilot.reset(car.position);
      input.setGear(1);
    }
    input.setAi(on);
    aiToggle?.updateDisplay();
  };

  const input = new Input({
    reset: resetCar,
    camera: () => cameraRig.toggleMode(),
    gui: () => setGui(!guiOpen),
    ai: () => setAutopilot(!auto.enabled),
  });

  /** Perintah yang dipakai frame ini: AI kalau aktif, kalau tidak pemain. */
  let command: VehicleInput = input.state;

  // On a phone there is no keyboard to grab the wheel back with, so touching
  // any driving control takes over from the AI.
  document.getElementById('touch')?.addEventListener('pointerdown', () => {
    if (auto.enabled) setAutopilot(false);
  });

  /* ---------------- live tuning ---------------- */
  const cfg = car.cfg;
  gui = new GUI({ title: 'Vehicle tuning' });

  const refresh = () => gui.controllersRecursive().forEach((c) => c.updateDisplay());

  const applyPreset = (name: PresetName) => {
    if (name === 'tarmac') {
      Object.assign(cfg, {
        muFront: 1.35,
        muRear: 1.3,
        springK: 34000,
        damperC: 2900,
        peakSlipDeg: 8,
        driftFalloff: 0.2,
        suspensionRest: 0.3,
      });
    } else if (name === 'gravel') {
      Object.assign(cfg, {
        muFront: 0.98,
        muRear: 0.95,
        springK: 26000,
        damperC: 2200,
        peakSlipDeg: 11,
        driftFalloff: 0.12,
        suspensionRest: 0.36,
      });
    } else {
      Object.assign(cfg, {
        muFront: 0.32,
        muRear: 0.3,
        springK: 26000,
        damperC: 2200,
        peakSlipDeg: 6,
        driftFalloff: 0.05,
        suspensionRest: 0.36,
      });
    }
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
  };

  const fDrive = gui.addFolder('Drivetrain');
  fDrive.add(cfg, 'engineForce', 2000, 30000, 200);
  fDrive.add(cfg, 'brakeForce', 2000, 30000, 200);
  fDrive.add(cfg, 'frontSplit', 0, 1, 0.01).name('front split (AWD)');
  fDrive.add(cfg, 'maxSpeed', 20, 90, 1);
  fDrive.add(cfg, 'reverseMaxSpeed', 4, 30, 0.5).name('reverse top speed');
  fDrive.add(cfg, 'shiftSpeedLimit', 0.2, 5, 0.1).name('shift below (m/s)');

  const fGrip = gui.addFolder('Grip / tires');
  fGrip.add(cfg, 'muFront', 0.2, 2, 0.01);
  fGrip.add(cfg, 'muRear', 0.2, 2, 0.01);
  fGrip.add(cfg, 'peakSlipDeg', 3, 20, 0.5);
  fGrip.add(cfg, 'driftFalloff', 0, 0.6, 0.01);
  fGrip.add(cfg, 'handbrakeRearGrip', 0.05, 1, 0.01);

  const fSusp = gui.addFolder('Suspension');
  fSusp.add(cfg, 'springK', 10000, 60000, 500);
  fSusp.add(cfg, 'damperC', 500, 7000, 50);
  fSusp.add(cfg, 'suspensionRest', 0.2, 0.5, 0.005);
  fSusp.add(cfg, 'antiRollFront', 0, 20000, 250);
  fSusp.add(cfg, 'antiRollRear', 0, 20000, 250);

  const fSteer = gui.addFolder('Steering');
  fSteer.add(cfg, 'maxSteerDeg', 10, 50, 1);
  fSteer.add(cfg, 'steerFalloff', 0, 0.95, 0.01);
  fSteer.add(cfg, 'steerRate', 1, 20, 0.5);

  const fAero = gui.addFolder('Aero / mass');
  fAero.add(cfg, 'drag', 0, 2, 0.01);
  fAero.add(cfg, 'downforce', 0, 6, 0.05);
  fAero.add(cfg, 'comY', -0.6, 0, 0.01).name('COM Y').onChange(() => car.applyMassProperties());
  fAero.add(cfg, 'angularDamping', 0, 1, 0.01).onChange(() => car.applyDamping());

  const fCam = gui.addFolder('Camera');
  fCam.add(cameraRig, 'distance', 4, 16, 0.1);
  fCam.add(cameraRig, 'height', 1, 8, 0.1);
  fCam.add(cameraRig, 'fovBase', 45, 85, 1).name('fov');

  const actions = {
    Tarmac: () => applyPreset('tarmac'),
    Gravel: () => applyPreset('gravel'),
    Ice: () => applyPreset('ice'),
    'Reset car': resetCar,
    'Copy config': () => {
      console.log(JSON.stringify(cfg, null, 2));
      void navigator.clipboard?.writeText(JSON.stringify(cfg, null, 2)).catch(() => {});
    },
  };
  const fAi = gui.addFolder('Autopilot');
  aiToggle = fAi.add(auto, 'enabled').name('AI mengemudi (P)').onChange((v: boolean) => setAutopilot(v));
  fAi
    .add(auto, 'useJoker')
    .name('joker lap')
    .onChange((v: boolean) => pilot.setUseJoker(v));
  fAi
    .add(auto, 'jumpSpeed', 8, 30, 1)
    .name('kecepatan lompatan')
    .onChange((v: number) => {
      pilot.options.jumpSpeed = v;
    });

  const fRival = gui.addFolder('Lawan');
  rivalToggle = fRival.add(race, 'rival').name('lawan AI').onChange((v: boolean) => setRival(v));
  fRival
    .add(race, 'pace', 0.8, 1.05, 0.01)
    .name('kecepatan lawan')
    .onChange((v: number) => {
      rival.pilot.options.pace = v;
    });
  fRival.add(race, 'laps', 1, 9, 1).name('jumlah lap');

  const fPreset = gui.addFolder('Presets');
  fPreset.add(actions, 'Tarmac');
  fPreset.add(actions, 'Gravel');
  fPreset.add(actions, 'Ice');
  fPreset.add(actions, 'Reset car');
  fPreset.add(actions, 'Copy config');

  setGui(!input.isTouch);
  if (input.isTouch) gui.close();
  refresh();

  /* ---------------- loop ---------------- */
  const lightState: CarLightState = {
    brake: 0,
    reverse: false,
    left: false,
    right: false,
    hazard: false,
    headlights: false,
  };

  const rivalLights: CarLightState = {
    brake: 0,
    reverse: false,
    left: false,
    right: false,
    hazard: false,
    headlights: true,
  };

  const timer = new THREE.Timer();
  timer.connect(document);
  let accumulator = 0;

  const followSun = () => {
    sun.position.set(car.position.x + 45, 65, car.position.z + 25);
    sun.target.position.set(car.position.x, 0, car.position.z);
    sun.target.updateMatrixWorld();
  };

  renderer.setAnimationLoop((time) => {
    timer.update(time);
    const raw = Math.min(timer.getDelta(), 0.1);

    input.update(raw);
    accumulator += raw;

    let steps = 0;
    while (accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
      rivalAround[0].speed = rival.car.speed;
      playerAround[0].speed = car.speed;
      if (auto.enabled) {
        // fresh transform each substep: the pilot is a closed loop
        car.sync();
        command = pilot.update(FIXED_DT, car, rivalAround);
      } else {
        command = input.state;
      }
      car.fixedStep(FIXED_DT, command);
      if (race.rival) {
        const rivalCommand = rival.step(FIXED_DT, playerAround);
        if (rivalCommand) rivalLights.brake = rivalCommand.brake;
      }
      world.step();
      accumulator -= FIXED_DT;
      steps++;
      if (auto.enabled && pilot.needsReset) {
        resetCar();
        break;
      }
    }
    if (steps === MAX_SUBSTEPS) accumulator = 0;

    car.sync();
    if (race.rival) {
      rival.sync();
      rivalLights.reverse = rival.car.gear === -1;
    }
    playerLaps.update(car.position);
    if (!race.winner) {
      if (playerLaps.lap >= race.laps) race.winner = 'player';
      else if (race.rival && rival.lap >= race.laps) race.winner = 'rival';
    }

    lightState.brake = command.brake;
    lightState.reverse = car.gear === -1;
    lightState.left = input.lights.left;
    lightState.right = input.lights.right;
    lightState.hazard = input.lights.hazard;
    lightState.headlights = input.lights.headlights;

    track.update(raw);
    carVisual.update(car, raw, lightState);
    if (race.rival) rivalVisual.update(rival.car, raw, rivalLights);
    cameraRig.update(raw, car);
    hud.update(car, raw);
    hud.setLamps(lightState);
    hud.setAutopilot(auto.enabled, pilot.lap, auto.enabled ? pilot.lapTime : 0, pilot.bestLap);
    hud.setRival(
      race.rival,
      rival.lap,
      race.laps,
      race.rival ? rival.odometer - playerLaps.odometer : 0,
    );
    hud.setFinish(
      race.winner === null
        ? null
        : race.winner === 'player'
          ? `finish · kamu menang · ${race.laps} lap`
          : `finish · lawan menang · ${race.laps} lap`,
    );
    followSun();

    renderer.render(scene, cameraRig.camera);
  });

  /* ---------------- resize ---------------- */
  window.addEventListener('resize', () => {
    renderer.setPixelRatio(maxPixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    cameraRig.resize(window.innerWidth / window.innerHeight);
  });

  /* ---------------- debug handle ---------------- */
  (window as unknown as Record<string, unknown>).rc = {
    car,
    // getter: the visual is swapped to the imported model once it decodes
    get carVisual() {
      return carVisual;
    },
    world,
    cfg,
    input,
    pilot,
    auto,
    setAutopilot,
    rival,
    race,
    playerLaps,
    setRival,
    cameraRig,
    renderer,
    scene,
    snap: () => {
      renderer.render(scene, cameraRig.camera);
      return renderer.domElement.toDataURL('image/png');
    },
  };

  bootEl.classList.add('done');
  setTimeout(() => bootEl.remove(), 400);
}

boot().catch((err) => {
  console.error(err);
  const bootEl = document.getElementById('boot');
  if (bootEl) bootEl.textContent = `Error: ${(err as Error).message ?? err}`;
});
