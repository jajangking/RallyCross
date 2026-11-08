/**
 * Uji "bisa hidup": jalankan `src/main.ts` tanpa browser sama sekali.
 *
 * `tsc` tidak bisa menangkap semua kesalahan saat start (mis. variabel yang
 * dipakai sebelum dideklarasikan di dalam callback `.map()`), dan di sandbox
 * ini tidak ada Chromium. Jadi DOM/WebGL dipalsukan secukupnya, lalu loop
 * permainan benar-benar dijalankan beberapa ratus frame: fisika (Rapier),
 * AI, kamera, dan HUD ikut jalan.
 *
 *   npm run check:boot
 */
import * as THREE from 'three';
import { TRACK } from '../src/world/track';

const noop = () => {};

/* ---------------- palsu: WebGL + canvas 2D ---------------- */
function makeGl(): any {
  const consts: Record<string, number> = {};
  let next = 0x1000;
  const target: any = {};
  return new Proxy(target, {
    get(_t, prop: string) {
      if (prop in target) return target[prop];
      if (/^[A-Z0-9_]+$/.test(prop)) {
        if (!(prop in consts)) consts[prop] = next++;
        return consts[prop];
      }
      switch (prop) {
        case 'getParameter':
          return (p: number) => {
            if (p === consts['VERSION'] || p === consts['SHADING_LANGUAGE_VERSION']) return 'WebGL 2.0';
            if (p === consts['VENDOR'] || p === consts['RENDERER']) return 'stub';
            return 4096;
          };
        case 'getExtension':
          return () => null;
        case 'getShaderPrecisionFormat':
          return () => ({ rangeMin: 127, rangeMax: 127, precision: 23 });
        case 'getProgramParameter':
          // three membaca jumlah uniform/atribut dari sini; harus angka.
          return (_p: number, what: number) => {
            const name = Object.keys(consts).find((k) => consts[k] === what) ?? '';
            if (/ACTIVE_(UNIFORM|ATTRIB|UNIFORM_BLOCK)/.test(name)) return 0;
            return true;
          };
        case 'getShaderParameter':
          return () => true;
        case 'getActiveUniform':
        case 'getActiveAttrib':
        case 'getUniformLocation':
        case 'getAttribLocation':
          return () => null;
        case 'getProgramInfoLog':
        case 'getShaderInfoLog':
          return () => '';
        case 'getContextAttributes':
          return () => ({ alpha: false, antialias: true, depth: true, stencil: true });
        case 'getSupportedExtensions':
          return () => [];
        case 'createShader':
        case 'createProgram':
        case 'createBuffer':
        case 'createTexture':
        case 'createFramebuffer':
        case 'createRenderbuffer':
        case 'createVertexArray':
          return () => ({});
        case 'checkFramebufferStatus':
          return () => consts['FRAMEBUFFER_COMPLETE'] ?? 1;
        case 'isContextLost':
          return () => false;
        case 'canvas':
          return { width: 1280, height: 720, addEventListener: noop, removeEventListener: noop, style: makeStyle() };
        default:
          return () => undefined;
      }
    },
  });
}

/** Konteks canvas 2D secukupnya: gradien, teks, dan gambar. */
function make2d(): any {
  const gradient = { addColorStop: noop };
  const ctx: any = {
    canvas: { width: 1024, height: 512 },
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    font: '10px sans-serif',
    textAlign: 'left',
    textBaseline: 'top',
    globalAlpha: 1,
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    createPattern: () => null,
    measureText: () => ({ width: 10 }),
    getImageData: (_x: number, _y: number, w = 1, h = 1) => ({
      data: new Uint8ClampedArray(Math.max(1, w * h * 4)),
      width: w,
      height: h,
    }),
    createImageData: (w = 1, h = 1) => ({
      data: new Uint8ClampedArray(Math.max(1, w * h * 4)),
      width: w,
      height: h,
    }),
    putImageData: noop,
    drawImage: noop,
    getContextAttributes: () => ({ alpha: true }),
  };
  return new Proxy(ctx, {
    get(t: any, prop: string) {
      if (prop in t) return t[prop];
      if (typeof prop === 'symbol') return undefined;
      return () => undefined;
    },
    set(t: any, prop: string, value) {
      t[prop] = value;
      return true;
    },
  });
}

const numeric = new Set(['width', 'height', 'clientWidth', 'clientHeight', 'offsetWidth', 'offsetHeight']);

/** `element.style` yang bisa dipakai: properti apa pun + setProperty(). */
function makeStyle(): any {
  return new Proxy(
    { setProperty: noop, removeProperty: noop, getPropertyValue: () => '' } as any,
    {
      get(t: any, prop: string) {
        if (prop in t) return t[prop];
        if (typeof prop === 'symbol') return undefined;
        return '';
      },
      set(t: any, prop: string, value) {
        t[prop] = value;
        return true;
      },
    },
  );
}

function makeElement(tag = 'div'): any {
  const gl = makeGl();
  const ctx2d = make2d();
  const element: any = {
    tagName: tag.toUpperCase(),
    style: makeStyle(),
    dataset: {},
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false, replace: noop },
    children: [] as any[],
    appendChild(child: any) {
      element.children.push(child);
      return child;
    },
    removeChild: noop,
    insertBefore: noop,
    remove: noop,
    setAttribute: noop,
    removeAttribute: noop,
    getAttribute: () => null,
    hasAttribute: () => false,
    addEventListener: noop,
    removeEventListener: noop,
    dispatchEvent: () => true,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 1280, height: 720, top: 0, left: 0, right: 1280, bottom: 720 }),
    getContext: (type?: string) => (type && !type.startsWith('webgl') ? ctx2d : gl),
    toDataURL: () => 'data:image/png;base64,',
    querySelector: () => makeElement(),
    querySelectorAll: () => [],
    focus: noop,
    blur: noop,
    setPointerCapture: noop,
    releasePointerCapture: noop,
    textContent: '',
    innerHTML: '',
    value: '',
    width: 1280,
    height: 720,
    clientWidth: 1280,
    clientHeight: 720,
    offsetWidth: 1280,
    offsetHeight: 720,
  };
  return new Proxy(element, {
    get(t: any, prop: string) {
      if (prop in t) return t[prop];
      if (numeric.has(prop)) return 0;
      if (typeof prop === 'symbol') return undefined;
      return () => undefined;
    },
    set(t: any, prop: string, value) {
      t[prop] = value;
      return true;
    },
  });
}

const documentStub: any = {
  documentElement: makeElement('html'),
  body: makeElement('body'),
  head: makeElement('head'),
  baseURI: 'http://localhost/',
  createElement: (tag: string) => makeElement(tag),
  createElementNS: (_ns: string, tag: string) => makeElement(tag),
  getElementById: () => makeElement(),
  querySelector: () => makeElement(),
  querySelectorAll: () => [],
  addEventListener: noop,
  removeEventListener: noop,
  hidden: false,
  visibilityState: 'visible',
  pointerLockElement: null,
  fonts: { ready: Promise.resolve() },
};

const windowStub: any = {
  document: documentStub,
  innerWidth: 1280,
  innerHeight: 720,
  devicePixelRatio: 1,
  addEventListener: noop,
  removeEventListener: noop,
  matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop }),
  requestAnimationFrame: (cb: (t: number) => void) => {
    queue.push(() => cb(performance.now()));
    return queue.length;
  },
  cancelAnimationFrame: noop,
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  localStorage: {
    store: new Map<string, string>(),
    getItem(k: string) {
      return this.store.has(k) ? this.store.get(k)! : null;
    },
    setItem(k: string, v: string) {
      this.store.set(k, String(v));
    },
    removeItem(k: string) {
      this.store.delete(k);
    },
    clear() {
      this.store.clear();
    },
    key: () => null,
    length: 0,
  },
  location: { search: '', href: 'http://localhost/', protocol: 'http:', pathname: '/' },
  navigator: { userAgent: 'node', maxTouchPoints: 0, language: 'id' },
  performance,
  history: { replaceState: noop, pushState: noop },
  WebGL2RenderingContext: class {},
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  IntersectionObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  PointerEvent: class {},
  CustomEvent: class {
    constructor(public type: string) {}
  },
  KeyboardEvent: class {},
  Event: class {},
  Image: class {
    set src(_v: string) {}
  },
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  URL,
  screen: { width: 1280, height: 720 },
};

const define = (name: string, value: unknown) => {
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
};
define('window', windowStub);
define('document', documentStub);
define('navigator', windowStub.navigator);
define('location', windowStub.location);
define('localStorage', windowStub.localStorage);
define('requestAnimationFrame', windowStub.requestAnimationFrame);
define('cancelAnimationFrame', noop);
define('matchMedia', windowStub.matchMedia);
define('innerWidth', 1280);
define('innerHeight', 720);
define('devicePixelRatio', 1);
define('WebGL2RenderingContext', windowStub.WebGL2RenderingContext);
define('ResizeObserver', windowStub.ResizeObserver);
define('getComputedStyle', windowStub.getComputedStyle);
define('self', globalThis);
// Tidak ada server di Node: jangan biarkan GLB menunggu koneksi gagal.
define('fetch', () => Promise.reject(new Error('offline (boot check)')));

/* ---------------- jalankan permainannya ---------------- */
const failures: string[] = [];
const logs: string[] = [];
const queue: Array<() => void> = [];

// `requestAnimationFrame` yang dipalsukan hanya mengantre: jalankan antreannya
// supaya kalau `boot()` menunggu satu frame, permainannya tetap lanjut.
let framesRun = 0;
const drain = setInterval(() => {
  for (const cb of queue.splice(0)) {
    try {
      framesRun++;
      cb();
    } catch (err) {
      realError((err as Error)?.stack ?? err);
    }
  }
}, 16);

const realError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  const text = args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(' ');
  // Model GLB diambil lewat fetch; di Node tidak ada server — bukan bug.
  if (text.includes('could not load the car model')) return;
  logs.push(text);
  realError(...args);
};

const check = (ok: boolean, label: string, detail = '') => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

/** Tunggu sejumlah frame permainan (bukan wall clock: mesin bisa lambat). */
const waitFrames = async (count: number) => {
  const target = framesRun + count;
  const deadline = Date.now() + 60000;
  while (framesRun < target && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
};

/**
 * Tunggu sampai kondisi terpenuhi, diukur dalam **frame permainan** (bukan
 * wall clock): kalau mesin sedang lambat, waktu di dalam permainan berjalan
 * lebih pelan daripada jam dinding dan batas waktu jadi palsu.
 */
const waitUntil = async (predicate: () => boolean, maxFrames: number) => {
  const target = framesRun + maxFrames;
  while (framesRun < target && !predicate()) {
    await new Promise((r) => setTimeout(r, 20));
  }
  return predicate();
};

const waitFor = async (predicate: () => boolean, timeoutMs = 12000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
};

await import('../src/main.ts');

console.log('\n— permainan benar-benar bisa start (tanpa browser) —');
// `main.ts` menaruh handle debug di `window.rc` — di sini `window` adalah stub.
await waitFor(() => Boolean(windowStub.rc) || logs.length > 0);
const rc: any = windowStub.rc;
check(Boolean(rc), 'main() selesai booting', logs[0] ?? '');
check(logs.length === 0, 'tidak ada error saat booting', logs[0] ?? '');

if (rc) {
  // Biarkan loop permainan berjalan ~3 detik (rAF dipalsukan tapi tetap
  // ditepati): fisika, AI, kamera, dan HUD semuanya ikut dieksekusi.
  const playerOdoBefore = rc.playerLaps.odometer as number;
  await waitFrames(180);
  check(framesRun > 60, 'loop permainan benar-benar berjalan', `${framesRun} frame`);
  check(logs.length === 0, 'tidak ada error yang tercatat saat jalan', logs[0] ?? '');

  const rivals = rc.rivals as Array<{ odometer: number; car: { position: THREE.Vector3 } }>;
  const leader = Math.max(...rivals.map((r) => r.odometer));
  check(leader > 5, 'mobil AI benar-benar bergerak di lintasan', `odometer ${leader.toFixed(1)} m`);

  const player = rc.car.position as THREE.Vector3;
  check(
    Number.isFinite(player.x) && Number.isFinite(player.z) && player.y > -5 && player.y < 40,
    'mobil pemain ada di dunia (tidak jatuh menembus tanah)',
    `y ${player.y.toFixed(2)}`,
  );
  check(
    (rc.playerLaps.odometer as number) > playerOdoBefore,
    'penghitung lap pemain maju',
    `${playerOdoBefore.toFixed(1)} → ${(rc.playerLaps.odometer as number).toFixed(1)} m`,
  );

  const cam = rc.cameraRig.camera.position as THREE.Vector3;
  check(
    Number.isFinite(cam.x) && Number.isFinite(cam.y) && Number.isFinite(cam.z),
    'kamera punya posisi yang masuk akal',
    `${cam.x.toFixed(0)}, ${cam.y.toFixed(0)}, ${cam.z.toFixed(0)}`,
  );

  // Kamera TV harus benar-benar mengikuti mobil — pernah rusak: fokus kamera
  // tetap di titik nol sehingga siaran hanya membidik garis start.
  rc.cameraRig.setMode('tv');
  const tvCam = rc.cameraRig.camera;
  const view = new THREE.Vector3();
  const aim = new THREE.Vector3();
  let worst = 0;
  let worstGap = 0;
  const spots = new Set<string>();

  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 350));
    tvCam.getWorldDirection(view);
    aim.subVectors(rc.car.position as THREE.Vector3, tvCam.position);
    const distance = aim.length();
    aim.normalize();
    // Sudut bidik diabaikan saat mobil tepat di lensa (jarak < 6 m).
    if (distance > 6) {
      worst = Math.max(
        worst,
        (Math.acos(Math.min(1, Math.max(-1, view.dot(aim)))) * 180) / Math.PI,
      );
    }
    spots.add(rc.cameraRig.broadcastName ?? '-');
    // Kamera yang dipilih harus benar-benar dekat dengan mobilnya. (Jarak
    // lurus, bukan jarak di sepanjang trek: mobil bisa terdorong/berputar saat
    // dilewati rombongan, dan jalur lap-nya jadi tidak bisa dibandingkan.)
    const spot = rc.cameraRig.director?.current;
    if (spot && !rc.cameraRig.aerialActive) {
      worstGap = Math.max(worstGap, (spot.position as THREE.Vector3).distanceTo(rc.car.position as THREE.Vector3));
    }
  }
  check(worst < 25, 'kamera TV membidik mobil (bukan garis start)', `meleset maks ${worst.toFixed(0)}°`);
  check(worstGap < 220, 'sutradara memilih kamera di dekat mobil', `jarak maks ${worstGap.toFixed(0)} m`);
  console.log(`    (potongan kamera: ${[...spots].join(', ')})`);

  // Ambulans & derek harus benar-benar keluar saat ada mobil mogok. Pernah
  // rusak: mobil AI berhenti dengan mesin mati, tapi ambulans diam di parkirnya
  // karena tidak bisa keluar dari rumput.
  {
    rc.cameraRig.setMode('chase');
    // Uji ini tidak perlu menunggu safety car memimpin lama-lama.
    (rc.raceControl as any).options.minSafetyTime = 4;
    const amb = rc.ambulance as any;
    const ambStart = amb.car.position.clone() as THREE.Vector3;
    const victims = (rc.rivals as any[]).slice(0, 1);
    for (const rival of victims) {
      // Taruh di depan ambulans (ia parkir di km 120), lalu rusakkan —
      // urutannya penting: `placeAt` memperbaiki mobil (damage.reset).
      const spot = TRACK.at(TRACK.start + 180);
      // Di pinggir trek (bukan di garis balap) supaya rombongan tidak terus
      // menabraknya — kalau didorong, mobil itu belum benar-benar mogok.
      const side = spot.pos.clone().addScaledVector(spot.side, 9);
      rival.car.placeAt(new THREE.Vector3(side.x, spot.pos.y + 0.6, side.z), spot.yaw);
      rival.car.damage.engineHealth = 0;
      rival.car.damage.engineDead = true;
      rival.car.damage.bodyHealth = 0.4;
    }
    const t0 = Date.now();
    await waitFrames(540);
    // Beri beberapa frame: kamera kuning baru aktif setelah insiden dimulai.
    await waitFrames(30);
    const phase1 = (rc.raceControl as any).ambPhase as string;

    // Selama bendera kuning: siaran naik ke helikopter dan membidik mobilnya.
    const crashCar = (rc.raceControl as any).incident?.target.position as THREE.Vector3 | undefined;
    const camNow = rc.cameraRig.camera as THREE.PerspectiveCamera;
    camNow.updateMatrixWorld(true);
    const eye = camNow.position as THREE.Vector3;
    const view = new THREE.Vector3();
    camNow.getWorldDirection(view);
    console.log(
      `      heli: eye ${eye.toArray().map((v) => v.toFixed(0)).join(',')} ` +
        `crash ${crashCar ? crashCar.toArray().map((v) => v.toFixed(0)).join(',') : '-'} ` +
        `view ${view.toArray().map((v) => v.toFixed(2)).join(',')}`,
    );
    const toCrash = crashCar ? crashCar.clone().sub(eye) : new THREE.Vector3(0, 0, 1);
    const crashDist = toCrash.length();
    const crashAim = THREE.MathUtils.radToDeg(view.angleTo(toCrash.normalize()));
    check(
      rc.cameraRig.modeName === 'tv' && rc.cameraRig.aerialForced && rc.cameraRig.aerialActive,
      'bendera kuning: siaran naik ke kamera helikopter',
      rc.cameraRig.broadcastName ?? rc.cameraRig.modeName,
    );
    check(
      Boolean(crashCar) && eye.y > 12 && crashDist < 90 && crashAim < 25,
      'helikopter membidik mobil yang kecelakaan',
      `y ${eye.y.toFixed(0)} m · jarak ${crashDist.toFixed(0)} m · meleset ${crashAim.toFixed(0)}°`,
    );
    const moved1 = amb.car.position.distanceTo(ambStart) as number;
    console.log(`    derek: fase=${phase1} ambulans bergerak ${moved1.toFixed(1)} m (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    check(
      (rc.raceControl as any).flag === 'yellow',
      'mobil mogok memicu bendera kuning',
      (rc.raceControl as any).flag,
    );
    check(phase1 !== 'off', 'ambulans dikirim ke lokasi (tidak diam di parkir)', phase1);
    check(moved1 > 15, 'ambulans benar-benar bergerak keluar', `${moved1.toFixed(1)} m`);
    await waitFrames(840);
    const phase2 = (rc.raceControl as any).ambPhase as string;
    const towed = victims.some((v) => v.car.isTowed) || phase2 === 'towing' || phase2 === 'repairing';
    console.log(`    derek: fase=${phase2} jarak ke korban ${amb.car.position.distanceTo(victims[0].car.position).toFixed(1)} m`);
    check(towed, 'ambulans sampai, mengait, lalu menderek mobilnya', phase2);

    // Skenario pemain: mobil sendiri mogok → bendera kuning, ambulans datang,
    // dan mobil pemain benar-benar diangkut (bukan cuma lawan yang dilayani).
    const control = rc.raceControl as any;
    // Tunggu insiden sebelumnya selesai supaya ambulansnya sudah di parkir.
    // Tunggu sampai benar-benar tenang (hijau + ambulans sudah di parkir):
    // insiden baru tidak akan dimulai selama insiden lama belum selesai.
    await waitUntil(() => control.flag === 'green' && control.ambPhase === 'off', 90 * 60);
    await waitUntil(() => control.flag === 'green', 80 * 60);
    const scNow = rc.safetyCar as any;
    const greenWhy =
      control.flag === 'green'
        ? ''
        : ` · sc=${control.scPhase}/${scNow.mode} sampai=${scNow.reachedRoute} ` +
          `speed=${scNow.car.speed.toFixed(1)} amb=${control.ambPhase} ` +
          `kuning=${(control.yellowTime as number).toFixed(0)}s resolve=${control.incident?.resolved}`;
    // Beri satu-dua frame supaya blok kamera sempat memulihkan mode.
    await new Promise((r) => setTimeout(r, 600));
    check(
      rc.cameraRig.modeName === 'chase' && !rc.cameraRig.aerialForced,
      'hijau lagi: kamera kembali normal (bukan helikopter)',
      `${rc.cameraRig.modeName}${rc.cameraRig.aerialForced ? ' · heli dipaksa' : ''}${greenWhy ? ` · ${greenWhy}` : ''}`,
    );
    const playerCar = rc.car as any;
    const playerSpot = TRACK.at(TRACK.start + 90);
    // Di pinggir trek juga: kalau di garis balap, rombongan akan terus
    // mendorongnya dan mobil itu belum benar-benar mogok.
    const playerSide = playerSpot.pos.clone().addScaledVector(playerSpot.side, 8);
    playerCar.placeAt(new THREE.Vector3(playerSide.x, playerSpot.pos.y + 0.6, playerSide.z), playerSpot.yaw);
    playerCar.damage.engineHealth = 0;
    playerCar.damage.engineDead = true;
    playerCar.damage.bodyHealth = 0.5;
    let playerTowed = false;
    const t1 = Date.now();
    playerTowed = await waitUntil(() => Boolean(playerCar.isTowed), 110 * 60);
    check(control.incident?.name === 'KAMU' || playerTowed, 'mobil pemain yang mogok ditangani petugas', control.ambPhase);
    check(
      playerTowed,
      'mobil pemain diangkut derek (bukan hanya diderek lawan)',
      `${((Date.now() - t1) / 1000).toFixed(1)} s · ${control.ambPhase} · ` +
        `amb ${((amb as any).car as any).speed.toFixed(1)} m/s, ` +
        `${((amb as any).car.position as THREE.Vector3).distanceTo(playerCar.position).toFixed(0)} m dari mobil`,
    );
  }

  rc.cameraRig.setMode('chase');
}

clearInterval(drain);
if (logs.length) {
  console.error('\n❌ ada error saat start:');
  for (const log of logs) console.error('  ' + log);
}
console.log(
  failures.length
    ? `\n❌ ${failures.length} pemeriksaan boot gagal`
    : '\n✅ boot check lulus',
);
process.exit(failures.length || logs.length ? 1 : 0);
