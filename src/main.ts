import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import GUI from 'lil-gui';
import { defaultConfig, VehiclePhysics } from './vehicle/VehiclePhysics';
import { CarVisual } from './vehicle/CarVisual';
import { buildTrack } from './world/track';
import { Input } from './input';
import { Hud } from './hud';
import { CameraRig } from './camera';

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

  buildTrack(world, scene);

  const car = new VehiclePhysics(world, defaultConfig, new THREE.Vector3(0, 0.95, 0));
  const carVisual = new CarVisual(scene, car);

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
  };

  const input = new Input({
    reset: resetCar,
    camera: () => cameraRig.toggleMode(),
    gui: () => setGui(!guiOpen),
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
      car.fixedStep(FIXED_DT, input.state);
      world.step();
      accumulator -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_SUBSTEPS) accumulator = 0;

    car.sync();
    carVisual.update(car);
    cameraRig.update(raw, car);
    hud.update(car, raw);
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
    world,
    cfg,
    input,
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
