import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import GUI from 'lil-gui';
import { defaultConfig, VehiclePhysics, type VehicleInput } from './vehicle/VehiclePhysics';
import { CarVisual } from './vehicle/CarVisual';
import { CarModelVisual } from './vehicle/CarModelVisual';
import { CarDamageVisual } from './vehicle/CarDamageVisual';
import { buildTrack, BROADCAST_SPOTS, PIT, pitPose, TRACK } from './world/track';
import { AutoPilot, type TrafficCar } from './ai/AutoPilot';
import { Rival } from './race/Rival';
import { LapCounter } from './race/LapCounter';
import { PitStop } from './race/PitStop';
import { RaceControl } from './race/RaceControl';
import { ServiceVehicle } from './race/ServiceVehicle';
import { gridPose, RIVAL_PLANS } from './race/grid';
import { standings, LapRecords } from './race/Standings';
import { AiSkills, skillForPace } from './race/AiSkill';
import { SkidMarks } from './fx/SkidMarks';
import { SmokePuffs } from './fx/Smoke';
import { CarEffects } from './fx/CarEffects';
import { Input } from './input';
import { Hud } from './hud';
import { CameraRig, type CameraMode } from './camera';
import { FocusDirector } from './camera/FocusDirector';
import type { CarLightState } from './vehicle/CarLights';
import { createBlobShadow, createSky, createSunRig, createSunSprite, PALETTE } from './world/style';
import { Helicopter } from './world/Heli';

const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 5;
/** Tinggi bodi di atas permukaan saat diam (untuk menaruh bayangan blob). */
const RIDE_HEIGHT = 0.92;

/**
 * Bayangan blob mengikuti mobil; disembunyikan saat roda tidak menyentuh tanah
 * (di udara bayangan yang menempel di mobil justru terlihat aneh).
 */
const followShadow = (shadow: THREE.Mesh, body: VehiclePhysics) => {
  const grounded = body.wheels.some((w) => w.contact);
  shadow.visible = grounded;
  if (!grounded) return;
  shadow.position.set(body.position.x, body.position.y - RIDE_HEIGHT, body.position.z);
};

/** Jam yang selalu ada, baik di browser maupun saat diuji headless. */
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

type PresetName = 'tarmac' | 'gravel' | 'ice';

async function boot() {
  await RAPIER.init();

  const bootEl = document.getElementById('boot')!;
  const app = document.getElementById('app')!;

  // `?quality=low` -> 1x pixel ratio, tanpa anti-alias, pohon lebih sedikit
  // (dipakai di HP lemah dan di uji headless). `?quality=high` memaksa detail.
  const qualityParam = new URLSearchParams(location.search).get('quality');
  // Kalau tidak disebut, HP kecil/kelas menengah otomatis dapat versi ringan.
  const weakDevice =
    window.matchMedia?.('(pointer: coarse)').matches === true &&
    Math.min(window.innerWidth, window.innerHeight) < 620;
  const lowQuality = qualityParam === 'low' || (qualityParam === null && weakDevice);
  document.body.classList.toggle('is-low', lowQuality);

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
  // Desktop: sampai 2x (tepi jauh lebih bersih dan itu sinyal "kualitas" paling
  // murah). HP: 1,5x, karena layarnya sudah rapat dan GPU-nya lebih terbatas.
  const isTouch = window.matchMedia?.('(pointer: coarse)').matches === true;
  const maxPixelRatio = lowQuality ? 1 : Math.min(window.devicePixelRatio, isTouch ? 1.5 : 2);
  renderer.setPixelRatio(maxPixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  // Shadow map: SATU directional light dengan frustum orto sempit yang mengikuti
  // mobil (±48 m), jadi bayangannya tajam dan pass-nya tidak pernah selebar
  // arena. Di HP lemah tetap pakai bayangan blob (lihat `createSunRig`).
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // Tone mapping "neutral": warna tetap pekat (tidak pudar seperti ACES),
  // tapi bagian yang sangat terang tidak langsung menjadi putih rata.
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.06;
  app.appendChild(renderer.domElement);

  /* ---------------- scene ---------------- */
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PALETTE.sky);
  // Kabut tipis: menyembunyikan batas dunia dan memotong kerja jauh.
  scene.fog = new THREE.Fog(PALETTE.fog, 120, 330);
  // Kubah langit ikut kamera, jadi tidak pernah terpotong far plane.
  // Kubah langit + sprite matahari: keduanya ikut kamera (lihat loop render),
  // jadi tidak pernah terpotong far plane dan matahari tidak pernah "tenggelam".
  const sky = createSky(PALETTE.skyTop, PALETTE.skyHorizon, 340);
  scene.add(sky);
  const sunSprite = createSunSprite(340);
  sky.add(sunSprite);

  const sunRig = createSunRig(scene, lowQuality);
  renderer.shadowMap.enabled = sunRig.shadows;

  // Tidak ada environment map (PMREM): material toon memang tidak butuh
  // pantulan, dan render kubah lingkungan saat boot termasuk biaya terbesar
  // di HP.


  /* ---------------- physics + world + car ---------------- */
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = FIXED_DT;

  const track = buildTrack(world, scene, !lowQuality);

  // first grid slot, ten metres behind the start/finish line
  const car = new VehiclePhysics(world, defaultConfig, new THREE.Vector3(0, 0.95, -10));

  // Jejak ban dan asap dipakai bersama semua mobil: satu mesh jejak + satu
  // kolam partikel, jadi enam mobil tetap murah.
  const skidMarks = new SkidMarks(lowQuality ? 2600 : 6000);
  skidMarks.mesh.visible = true;
  scene.add(skidMarks.mesh);
  const smoke = new SmokePuffs(lowQuality ? 220 : 480);
  smoke.setPixelRatio(renderer.getPixelRatio());
  scene.add(smoke.points);
  const playerEffects = new CarEffects(car, skidMarks, smoke);
  // Bayangan "blob": pengganti shadow map, satu bidang per mobil.
  // Bayangan blob cuma dipakai kalau shadow map tidak aktif (HP lemah); kalau
  // aktif, bayangan asli dari matahari yang dipakai — jangan dobel.
  const playerShadow = createBlobShadow(1.5, 0.34);
  playerShadow.visible = !sunRig.shadows;
  scene.add(playerShadow);

  /**
   * Mobil GLB menyalakan `castShadow` per bagian supaya bayangannya ikut jatuh
   * ke aspal. Di preset ringan (tanpa shadow map) ini dilewati.
   */
  const enableCarShadows = (root: THREE.Object3D) => {
    if (!sunRig.shadows) return;
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    });
  };

  // The hand-built body is only a stand-in: the detailed GLB in `public/models`
  // replaces it as soon as it is decoded (and stays if the download fails).
  const proceduralCar = new CarVisual(scene, car, { detail: !lowQuality });
  let carVisual: CarVisual | CarModelVisual = proceduralCar;
  const modelUrl = new URL('models/honda-civic-eg6.glb', document.baseURI).href;
  const paintParam = new URLSearchParams(location.search).get('paint');
  const paint = paintParam && /^[0-9a-f]{6}$/i.test(paintParam) ? parseInt(paintParam, 16) : undefined;
  // Penyok & roda yang copot (visual). Biayanya nol selama mobil masih utuh.
  const playerDamageView = new CarDamageVisual(car.cfg, paint ?? 0xd8402f);
  void CarModelVisual.load(scene, car, modelUrl, { detail: !lowQuality, paint }).then((model) => {
    if (!model) return;
    proceduralCar.dispose();
    enableCarShadows(model.root);
    carVisual = model;
  });

  /**
   * "Nalar" lawan: kemampuan tiap pembalap AI yang **naik tiap balapan**
   * (disimpan di localStorage). Karena setelan pilot diturunkan dari angka ini,
   * papan rekor ikut turun seiring waktu — tiap sesi AI-nya lebih cepat.
   */
  const skills = new AiSkills(
    undefined,
    Object.fromEntries(RIVAL_PLANS.map((plan) => [plan.name, skillForPace(plan.pace)])),
  );
  /* ---------------- lima lawan AI (grid 6 mobil) ---------------- */
  // Fisika, ban, dan lompatannya sama persis dengan mobil pemain; lawan hanya
  // tahu garis balap lebih baik. Tiap mobil punya lajur, kecepatan, dan warna
  // sendiri supaya balapannya tidak jadi barisan rapi.
  const rivals = RIVAL_PLANS.map((plan) => {
    const pose = gridPose(plan);
    const rival = new Rival(world, {
      name: plan.name,
      position: pose.position,
      yaw: pose.yaw,
      main: TRACK.main,
      joker: TRACK.joker,
      startDistance: TRACK.start,
      pace: skills.tuning(plan.name).pace,
      laneOffset: plan.laneOffset,
      jokerEachLap: plan.jokerEachLap,
    });
    const procedural = new CarVisual(scene, rival.car, { detail: !lowQuality, paint: plan.color });
    let visual: CarVisual | CarModelVisual = procedural;
    void CarModelVisual.load(scene, rival.car, new URL('models/honda-civic-eg6.glb', document.baseURI).href, {
      detail: !lowQuality,
      paint: plan.color,
    }).then((model) => {
      if (!model) return;
      procedural.dispose();
      enableCarShadows(model.root);
      visual = model;
      model.root.visible = race.rivals;
    });
    return {
      plan,
      rival,
      procedural,
      get visual() {
        return visual;
      },
      effects: new CarEffects(rival.car, skidMarks, smoke),
      damageView: new CarDamageVisual(rival.car.cfg, plan.color),
      shadow: createBlobShadow(1.5, 0.34),
      /** Lap terbaik yang sudah dikirim ke papan rekor. */
      lastBest: Infinity,
      /** Pengalaman balapan ini sudah dicatat ke nalar AI? */
      skillBanked: false,
      /** Perintah terakhir: efek ban butuh tahu gas/rem/handbrake. */
      lastCommand: undefined as VehicleInput | undefined,
      lights: {
        brake: 0,
        reverse: false,
        left: false,
        right: false,
        hazard: false,
        headlights: true,
      } as CarLightState,
    };
  });

  for (const r of rivals) {
    scene.add(r.shadow);
    r.shadow.visible = !sunRig.shadows;
  }

  /* ---------------- helikopter siaran (kamera udara) ---------------- */
  // Heli terbang mengelilingi mobil yang sedang disorot, selalu ada di langit
  // arena, dan jadi kamera udara di mode `C` -> HELI.
  // Tanpa bayangan: 34 m di atas lintasan, bayangan blob-nya cuma bikin bingung
  // (dan ikut tenggelam di bagian sirkuit yang menanjak).
  const heli = new Helicopter();
  scene.add(heli.root);
  heli.place(car.position);

  /* ---------------- pit stop, safety car, ambulans ---------------- */
  // Kotak servis: Kotak 0 untuk pemain, 1..5 untuk lawan (urutan `RIVAL_PLANS`).
  const pitBoxes = PIT.boxes;
  const rejoinPoint = new THREE.Vector3(PIT.rejoin.pos.x, PIT.rejoin.pos.y, PIT.rejoin.pos.z);
  const playerPit = new PitStop(pitBoxes[0]);

  // Mobil pendukung = mobil fisika sungguhan, jadi bisa ditabrak dan ikut
  // memakai suspensi/ban yang sama seperti pembalap.
  const scPose = pitPose(PIT.from + 6, 7.4);
  const safetyCar = new ServiceVehicle({
    kind: 'safety',
    world,
    scene,
    park: scPose.position,
    yaw: scPose.yaw,
    main: TRACK.main,
    joker: TRACK.joker,
    color: 0xf5f7fa,
    detail: !lowQuality,
  });
  const ambPose = (() => {
    const post = TRACK.at(TRACK.start + 120);
    const pos = post.pos.clone().addScaledVector(post.side, 26);
    return { position: new THREE.Vector3(pos.x, 0.95, pos.z), yaw: post.yaw };
  })();
  const ambulance = new ServiceVehicle({
    kind: 'ambulance',
    world,
    scene,
    park: ambPose.position,
    yaw: ambPose.yaw,
    main: TRACK.main,
    joker: TRACK.joker,
    color: 0xf2f4f7,
    detail: !lowQuality,
  });
  const raceControl = new RaceControl({
    safety: safetyCar,
    ambulance,
    scJoin: rejoinPoint,
    scPark: scPose.position,
    ambPark: ambPose.position,
  });

  const playerLaps = new LapCounter(TRACK.main, TRACK.start, car.position);
  const race = {
    laps: 3,
    rivals: true,
    // Pengali kecepatan semua lawan (1 = sesuai rencana di `grid.ts`).
    pace: 1,
    winner: null as null | 'player' | 'rival',
    winnerName: '',
  };
  /** Papan rekor lap (antarmobil, disimpan di localStorage kalau ada). */
  const records = new LapRecords();
  /** Terapkan nalar AI + pengali kecepatan dari panel ke semua lawan. */
  const applyRivalSkills = () => {
    for (const r of rivals) {
      r.rival.applySkill(skills.tuning(r.plan.name), race.pace);
    }
  };
  applyRivalSkills();
  /** Urutan finis, untuk banner hasil. */
  const finishOrder: Array<{ name: string; player: boolean }> = [];
  /** Sampai kapan spanduk "REKOR BARU" ditampilkan (ms). */
  let newRecordUntil = 0;
  /** Lap terbaik pemain yang sudah dikirim ke papan rekor. */
  let playerBestSubmitted = Infinity;

  // Daftar "siapa saja di sekitar" dipakai semua AI. Isinya referensi posisi
  // (bukan salinan), jadi cukup diperbarui sekali per frame; mobil itu sendiri
  // otomatis dilewati AutoPilot (jarak 0).
  const traffic: TrafficCar[] = [
    { position: car.position, speed: 0 },
    ...rivals.map((r) => ({ position: r.rival.car.position, speed: 0 })),
    // Mobil pendukung ikut terdaftar supaya pembalap menghindarinya.
    { position: safetyCar.car.position, speed: 0 },
    { position: ambulance.car.position, speed: 0 },
  ];

  /* ---------------- autopilot ---------------- */
  // The pilot drives the very same `VehicleInput` interface as the keyboard,
  // so it can be switched on and off mid-lap without touching the physics.
  const pilot = new AutoPilot(TRACK.main, TRACK.joker);
  const auto = {
    enabled: false,
    useJoker: true,
    jumpSpeed: pilot.options.jumpSpeed,
  };
  /** Mode tontonan: dua mobil AI + kamera TV. */
  const spectate = { on: false };
  let aiToggle: { updateDisplay(): void } | null = null;
  let rivalToggle: { updateDisplay(): void } | null = null;
  let spectateToggle: { updateDisplay(): void } | null = null;

  /* ---------------- camera / input / hud ---------------- */
  const cameraRig = new CameraRig(window.innerWidth / window.innerHeight, BROADCAST_SPOTS);
  cameraRig.snap(car);

  const hud = new Hud(car.cfg.mass);
  /** Pesan pengawas balapan (kuning, ambulans, hijau). */
  const announce = (event: { kind: string; text: string }) => {
    hud.announce(event.text, event.kind === 'green' ? 'green' : event.kind === 'repaired' ? 'info' : 'yellow');
  };
  const bannerPit = (text: string) => hud.announce(text, 'green');

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
    playerPit.reset();
    raceControl.reset();
    cameraRig.snap(car);
    input.setGear(1);
    pilot.reset(car.position);
    playerLaps.reset(car.position);
    playerEffects.reset();
    focusDirector.snap();
    if (race.rivals) for (const r of rivals) r.rival.resetToGrid();
    for (const r of rivals) {
      r.visual.root.visible = race.rivals;
      r.effects.reset();
    }
    finishOrder.length = 0;
    race.winner = null;
    race.winnerName = '';
  };

  const setRivals = (on: boolean) => {
    race.rivals = on;
    for (const r of rivals) {
      r.visual.root.visible = on;
      r.shadow.visible = on && !sunRig.shadows;
      r.effects.reset();
      if (on) r.rival.resetToGrid();
      else r.rival.park();
    }
    playerLaps.reset(car.position);
    finishOrder.length = 0;
    race.winner = null;
    race.winnerName = '';
    rivalToggle?.updateDisplay();
  };

  const setAutopilot = (on: boolean) => {
    auto.enabled = on;
    if (on) {
      pilot.reset(car.position);
      input.setGear(1);
    } else {
      spectate.on = false;
      if (cameraRig.modeName === 'tv') cameraRig.setMode('chase');
      input.setSpectate(false);
      spectateToggle?.updateDisplay();
    }
    input.setAi(on);
    aiToggle?.updateDisplay();
  };

  /** Ambil alih? Tidak: dua mobil disetir AI, kamera pindah ke siaran TV. */
  const setSpectate = (on: boolean) => {
    setAutopilot(on);
    spectate.on = on;
    if (on) cameraRig.setMode('tv');
    input.setSpectate(on);
    aiToggle?.updateDisplay();
    spectateToggle?.updateDisplay();
  };

  const input = new Input({
    reset: resetCar,
    camera: () => cameraRig.toggleMode(),
    gui: () => setGui(!guiOpen),
    ai: () => setAutopilot(!auto.enabled),
    spectate: () => setSpectate(!spectate.on),
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
  const camModes = {
    get mode() {
      return cameraRig.modeName;
    },
    set mode(v: string) {
      cameraRig.setMode(v as CameraMode);
    },
  };
  fCam
    .add(camModes, 'mode', ['chase', 'hood', 'tv'])
    .name('mode kamera')
    .onChange((v: string) => cameraRig.setMode(v as CameraMode));
  // Panel: lompat ke kamera TV berikutnya (berguna untuk mengecek semua sudut).
  fCam.add({ next: () => void cameraRig.nextCamera() }, 'next').name('kamera berikutnya');
  spectateToggle = fCam
    .add(spectate, 'on')
    .name('tonton AI vs AI (V)')
    .onChange((v: boolean) => setSpectate(v));

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
  rivalToggle = fRival.add(race, 'rivals').name('5 lawan AI').onChange((v: boolean) => setRivals(v));
  fRival
    .add(race, 'pace', 0.8, 1.05, 0.01)
    .name('kecepatan lawan')
    .onChange(() => {
      // Skala semua lawan, tapi urutannya tetap: yang paling cepat tetap di depan.
      applyRivalSkills();
    });
  fRival.add(race, 'laps', 1, 9, 1).name('jumlah lap');
  fRival.add({ clear: () => skidMarks.clear() }, 'clear').name('hapus jejak ban');

  // Kerusakan: setelan ini berlaku untuk semua mobil (pemain & lawan), jadi
  // tidak ada yang dapat keuntungan dari mobil yang lebih kuat.
  const allDamage = () => [car.damage, ...rivals.map((r) => r.rival.car.damage)];
  const damageSettings = {
    get enabled() {
      return car.damage.options.enabled;
    },
    set enabled(v: boolean) {
      for (const d of allDamage()) d.options.enabled = v;
    },
    get severity() {
      return car.damage.options.severity;
    },
    set severity(v: number) {
      for (const d of allDamage()) d.options.severity = v;
    },
  };
  const fDamage = gui.addFolder('Kerusakan');
  fDamage.add(damageSettings, 'enabled').name('mobil bisa rusak').onChange((v: boolean) => {
    for (const d of allDamage()) {
      d.options.enabled = v;
      if (!v) d.reset();
    }
  });
  fDamage.add(damageSettings, 'severity', 0.25, 3, 0.05).name('tingkat kerusakan');
  fDamage
    .add(
      {
        repair: () => {
          for (const d of allDamage()) d.reset();
        },
      },
      'repair',
    )
    .name('perbaiki semua mobil');

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

  /** Titik yang dibidik kamera TV: **satu** mobil (pemain, atau pemimpin kalau
   *  sedang menonton), plus sedikit geseran kalau ada lawan yang berdempetan. */
  const focusDirector = new FocusDirector({
    player: () => ({
      position: car.position,
      odometer: playerLaps.odometer,
      lapDistance: playerLaps.lapDistance,
    }),
    rivals: () =>
      race.rivals
        ? rivals
            .filter((r) => !r.rival.isParked)
            .map((r) => ({
              position: r.rival.car.position,
              odometer: r.rival.odometer,
              lapDistance: r.rival.counter.lapDistance,
            }))
        : [],
    spectate: () => spectate.on,
  });
  // Titik bidik yang dipakai bersama: kamera TV, heli, dan frustum bayangan.
  // (Referensi langsung ke fokus sutradara — dulu ini salinan yang tidak pernah
  // diperbarui, jadi kamera TV membidik titik nol = garis start.)
  const camFocus = focusDirector.focus;
  const updateCamFocus = (dt: number) => focusDirector.update(dt);

  const timer = new THREE.Timer();
  timer.connect(document);
  let accumulator = 0;

  renderer.setAnimationLoop((time) => {
    timer.update(time);
    const raw = Math.min(timer.getDelta(), 0.1);

    input.update(raw);
    accumulator += raw;

    let steps = 0;
    while (accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
      // Kecepatan semua mobil di daftar lalu lintas; posisinya sudah referensi.
      traffic[0].speed = car.speed;
      for (let i = 0; i < rivals.length; i++) traffic[i + 1].speed = rivals[i].rival.car.speed;
      if (auto.enabled) {
        // fresh transform each substep: the pilot is a closed loop
        car.sync();
        command = pilot.update(FIXED_DT, car, traffic);
      } else {
        command = input.state;
      }
      car.fixedStep(FIXED_DT, command);
      if (race.rivals) {
        for (const r of rivals) {
          const rivalCommand = r.rival.step(FIXED_DT, traffic);
          if (rivalCommand) {
            r.lights.brake = rivalCommand.brake;
            r.lastCommand = rivalCommand;
          }
        }
      }
      safetyCar.step(FIXED_DT, traffic);
      ambulance.step(FIXED_DT, traffic);
      world.step();
      accumulator -= FIXED_DT;
      steps++;
      // Catatan: mobil yang terbalik atau menabrak **tidak** di-reset otomatis.
      // Biar apa adanya — pemain bisa mengulang balapan dengan `R`.
    }
    if (steps === MAX_SUBSTEPS) accumulator = 0;

    car.sync();
    if (race.rivals) {
      for (const r of rivals) {
        r.rival.sync();
        r.lights.reverse = r.rival.car.gear === -1;
      }
    }
    playerLaps.update(car.position);
    safetyCar.sync(raw);
    ambulance.sync(raw);
    traffic[traffic.length - 2].speed = safetyCar.car.speed;
    traffic[traffic.length - 1].speed = ambulance.car.speed;

    // Situasi balapan: makin jauh tertinggal dari pemimpin, makin keras dia
    // menekan (maks +2 %). Ini yang membuat lawan saling mengejar.
    {
      let leader = playerLaps.odometer;
      for (const r of rivals) leader = Math.max(leader, r.rival.odometer);
      for (const r of rivals) r.rival.setRaceGap(leader - r.rival.odometer);
    }

    // --- pit: pemain servis kalau berhenti di kotaknya ---
    if (playerPit.update(raw, car)) bannerPit('SERVIS SELESAI · GAS!');
    hud.setPit(
      playerPit.busy
        ? { label: `PIT · ${Math.max(0, playerPit.remaining).toFixed(1)} s`, progress: playerPit.progress }
        : null,
    );

    // --- pit AI: masuk kalau mobilnya sudah terlalu rusak ---
    if (race.rivals) {
      let boxIndex = 1;
      for (const r of rivals) {
        const dmg = r.rival.car.damage;
        const needsService =
          dmg.lostCount > 0 || dmg.puncturedCount >= 2 || dmg.bodyHealth < 0.72 || dmg.engineHealth < 0.55;
        // Masuk pit hanya kalau kotaknya masih di depan: AI tidak perlu
        // berbalik arah (kalau sudah lewat, dia pit di putaran berikutnya).
        const ahead = pitBoxes[boxIndex].distance - r.rival.counter.lapDistance;
        // Hanya mobil yang masih bisa menyetir yang masuk pit sendiri; yang
        // bannya lepas / mesinnya mati ditangani ambulans di lokasi.
        const drivable = r.rival.car.damage.lostCount === 0 && !r.rival.car.damage.engineDead;
        if (!r.rival.inPit && drivable && needsService && r.rival.lap < race.laps && ahead > 30) {
          r.rival.requestPit(pitBoxes[boxIndex], rejoinPoint);
        }
        boxIndex++;
      }
    }

    // --- pengawas balapan: kuning, safety car, ambulans ---
    raceControl.update(raw, [
      { name: 'KAMU', car, isPlayer: true },
      ...rivals.filter((r) => !r.rival.isParked).map((r) => ({ name: r.plan.name, car: r.rival.car })),
    ]);
    for (const r of rivals) {
      r.rival.setControlScale(raceControl.paceScale);
      r.rival.pilot.options.overtake = raceControl.overtakeAllowed;
    }
    for (const event of raceControl.drainEvents()) announce(event);

    // Rekor lap: setiap kali ada mobil mencatat lap tercepat baru, angka itu
    // masuk papan rekor (dan disimpan untuk sesi berikutnya).
    if (auto.enabled && pilot.bestLap < playerBestSubmitted - 0.001) {
      playerBestSubmitted = pilot.bestLap;
      if (records.submit(pilot.bestLap, 'KAMU')) newRecordUntil = now() + 3200;
    }
    for (const r of rivals) {
      const best = r.rival.bestLap;
      if (best < r.lastBest - 0.001) {
        r.lastBest = best;
        if (records.submit(best, r.plan.name)) newRecordUntil = now() + 3200;
        // Lap terbaik pribadi = dia belajar: pace/gripnya naik saat itu juga.
        if (skills.submitLap(r.plan.name, best)) applyRivalSkills();
      }
    }

    // Posisi finis: mobil pertama yang menembus jumlah lap.
    if (playerLaps.lap >= race.laps && !finishOrder.some((f) => f.player)) {
      finishOrder.push({ name: 'KAMU', player: true });
    }
    for (const r of rivals) {
      if (r.rival.lap >= race.laps && !finishOrder.some((f) => f.name === r.plan.name)) {
        finishOrder.push({ name: r.plan.name, player: false });
      }
      // Balapan selesai untuk mobil ini: pengalamannya menambah nalar AI-nya.
      if (r.rival.lap >= race.laps && !r.skillBanked) {
        r.skillBanked = true;
        skills.finishRace([r.plan.name]);
        applyRivalSkills();
      }
    }
    if (!race.winner && finishOrder.length > 0) {
      race.winner = finishOrder[0].player ? 'player' : 'rival';
      race.winnerName = finishOrder[0].name;
    }

    lightState.brake = command.brake;
    lightState.reverse = car.gear === -1;
    lightState.left = input.lights.left;
    lightState.right = input.lights.right;
    lightState.hazard = input.lights.hazard;
    lightState.headlights = input.lights.headlights;

    track.update(raw);
    carVisual.update(car, raw, lightState);
    playerDamageView.sync(carVisual, car.damage);
    playerEffects.update(raw, command);
    if (race.rivals) {
      for (const r of rivals) {
        r.visual.update(r.rival.car, raw, r.lights);
        r.damageView.sync(r.visual, r.rival.car.damage);
        r.effects.update(raw, r.lastCommand);
      }
    }
    // Satu bidikan untuk semua pemakai: kamera TV, heli, frustum bayangan.
    updateCamFocus(raw);
    // Bayangan blob: ikut mobil, sembunyi saat roda tidak menyentuh tanah.
    if (sunRig.shadows) {
      // Frustum bayangan ikut mobil yang disorot (sama dengan kamera TV).
      sunRig.follow(camFocus);
    } else {
      followShadow(playerShadow, car);
      if (race.rivals) for (const r of rivals) followShadow(r.shadow, r.rival.car);
    }

    // Jejak ban + asap di-upload sekali per frame, setelah semua mobil menulis.
    skidMarks.flush();
    smoke.update(raw);

    // Heli selalu terbang mengelilingi mobil yang disorot; lensanya jadi salah
    // satu kamera siaran TV (sutradara menyelipkannya tiap 8–15 detik).
    // Satu kali per frame: bidikan kamera ditentukan di depan (sebelum bayangan).
    heli.update(raw, camFocus);
    cameraRig.setAerialEye(heli.cameraPosition);
    // Saat siaran sedang memakai gambar heli, kamera ada di dagunya: sembunyikan
    // bodi supaya tidak menutupi frame (dan tetap terlihat dari kamera lain).
    heli.root.visible = !cameraRig.aerialActive;

    if (cameraRig.modeName === 'tv') {
      cameraRig.updateBroadcast(
        raw,
        camFocus,
        focusDirector.distance,
        TRACK.length,
        focusDirector.cut,
      );
    } else {
      cameraRig.update(raw, car);
    }
    hud.update(car, raw);
    hud.setLamps(lightState);
    hud.setAutopilot(auto.enabled, pilot.lap, auto.enabled ? pilot.lapTime : 0, pilot.bestLap);
    hud.setStandings(
      standings([
        {
          name: 'KAMU',
          color: 0xd8402f,
          lap: playerLaps.lap,
          odometer: playerLaps.odometer,
          bestLap: pilot.bestLap,
          laps: race.laps,
          isPlayer: true,
        },
        ...rivals.map((r) => ({
          name: r.plan.name,
          color: r.plan.color,
          lap: r.rival.lap,
          odometer: r.rival.odometer,
          bestLap: r.rival.bestLap,
          laps: race.laps,
        })),
      ]),
      race.rivals,
      records,
      now() < newRecordUntil,
    );
    hud.setFlag(raceControl.flag, safetyCar.deployed);
    hud.setLeague(skills.average, skills.totalRaces);
    hud.setCamera(cameraRig.modeName === 'tv', cameraRig.broadcastName);
    hud.setFinish(
      race.winner === null
        ? null
        : race.winner === 'player'
          ? `finish · P1 KAMU · ${race.laps} lap`
          : `finish · P1 ${race.winnerName} · ${race.laps} lap`,
    );

    sky.position.copy(cameraRig.camera.position);

    renderer.render(scene, cameraRig.camera);
  });

  /* ---------------- resize ---------------- */
  window.addEventListener('resize', () => {
    renderer.setPixelRatio(maxPixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    smoke.setPixelRatio(maxPixelRatio);
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
    race,
    spectate,
    setSpectate,
    playerLaps,
    setRivals,
    rivals: rivals.map((r) => r.rival),
    records,
    skills,
    skidMarks,
    smoke,
    cameraRig,
    heli,
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
