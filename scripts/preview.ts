/**
 * Preview tanpa browser.
 *
 * Merender scene three.js ke PNG dengan rasterizer z-buffer kecil di Node —
 * berguna untuk memeriksa siluet model, proporsi, dan komposisi kamera ketika
 * tidak ada Chromium di mesin ini (CI, Termux, sandbox).
 *
 *   npm run shot            # semua
 *   npm run shot -- heli    # hanya helikopter (3 sudut)
 *   npm run shot -- arena   # hanya arena (udara, darat, peta)
 *   npm run shot -- car     # mobil rusak (penyok + ban copot)
 *
 * Hasilnya di `shots/` (di-ignore git).
 *
 * Catatan: ini **bukan** renderer tiga.js yang asli. Tekstur diganti warna
 * rata-rata, tidak ada kabut/bayangan, dan pencahayaan toon disederhanakan jadi
 * 4 langkah. Cukup untuk menilai bentuk dan komposisi, bukan warna akhir.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as THREE from 'three';

/* ------------------------------------------------------------------ canvas */

type Rgba = [number, number, number, number];

const parseColor = (input: string): Rgba => {
  if (typeof input !== 'string') return [255, 0, 255, 1];
  const text = input.trim();
  if (text.startsWith('#')) {
    const h = text.slice(1);
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    return [
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16),
      1,
    ];
  }
  const m = text.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const parts = m[1].split(',').map((v) => parseFloat(v));
    return [parts[0], parts[1], parts[2], parts[3] ?? 1];
  }
  return [255, 0, 255, 1];
};

/**
 * Kanvas 2D mini: mencatat `fillRect`/gradien ke satu warna rata-rata, supaya
 * material ber-`map` masih punya warna yang masuk akal (aspal gelap, rumput
 * hijau, tribun ramai) walau tidak ada piksel sungguhan.
 */
class StubCanvas {
  width = 1;
  height = 1;
  private readonly sum = Object.assign([0, 0, 0, 0], { n: 0 });

  getContext(_kind: string) {
    const canvas = this;
    const gradient = {
      addColorStop(_offset: number, color: string) {
        canvas.paint(color, 1);
      },
    };
    return {
      canvas,
      fillStyle: '#ffffff',
      strokeStyle: '#000000',
      lineWidth: 1,
      font: '10px sans-serif',
      textAlign: 'center',
      textBaseline: 'middle',
      createLinearGradient: () => gradient,
      createRadialGradient: () => gradient,
      fillRect(_x: number, _y: number, w: number, h: number) {
        canvas.paint(this.fillStyle, Math.abs(w * h));
      },
      clearRect() {},
      strokeRect() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      arc() {},
      fill() {},
      stroke() {},
      fillText() {},
      save() {},
      restore() {},
      translate() {},
      rotate() {},
      scale() {},
      setTransform() {},
      measureText: (t: string) => ({ width: t.length * 6 }),
    };
  }

  paint(color: string, area: number) {
    const [r, g, b, a] = parseColor(color);
    const weight = Math.min(1, Math.max(0.05, area / 4096));
    this.sum[0] += r * weight;
    this.sum[1] += g * weight;
    this.sum[2] += b * weight;
    this.sum[3] += a * weight;
    this.sum.n += weight;
  }

  average(): Rgba {
    const n = this.sum.n || 1;
    return [this.sum[0] / n, this.sum[1] / n, this.sum[2] / n, this.sum[3] / n];
  }
}

(globalThis as unknown as { document: unknown }).document = {
  createElement: () => new StubCanvas(),
};

/* --------------------------------------------------------------------- png */

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (buf: Buffer) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type: string, data: Buffer) => {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
};

const writePng = (path: string, w: number, h: number, rgb: Uint8Array) => {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 3;
      const d = row + 1 + x * 3;
      raw[d] = rgb[s];
      raw[d + 1] = rgb[s + 1];
      raw[d + 2] = rgb[s + 2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
};

/* ---------------------------------------------------------------- renderer */

const W = 640;
const H = 400;
const LIGHT = new THREE.Vector3(0.45, 0.82, 0.36).normalize();
/** Pencahayaan halus (bukan lagi bertingkat): 0,55 di bayangan → 1,15 di terang. */
const shadeFor = (dot: number) => 0.55 + Math.max(0, dot) * 0.6 + 0.08;

const mapColor = new WeakMap<THREE.Texture, Rgba>();

const materialColor = (material: THREE.Material): { color: Rgba; alpha: number } => {
  const m = material as THREE.MeshStandardMaterial;
  const base: Rgba = m.color
    ? [m.color.r * 255, m.color.g * 255, m.color.b * 255, 1]
    : [200, 200, 200, 1];
  if (m.map) {
    let avg = mapColor.get(m.map);
    if (!avg) {
      const image = (m.map as unknown as { image?: StubCanvas & { data?: Uint8Array } }).image;
      // Tekstur trek sekarang `DataTexture` (buffer piksel, lihat
      // `src/world/surface-maps.ts`), bukan canvas: rata-ratanya dihitung
      // langsung dari buffer supaya warna aspal/gravel di shot tetap benar.
      if (image?.data) {
        const d = image.data;
        let r = 0;
        let g = 0;
        let b = 0;
        const n = d.length / 4;
        for (let i = 0; i < d.length; i += 4) {
          r += d[i];
          g += d[i + 1];
          b += d[i + 2];
        }
        avg = [r / n, g / n, b / n, 1];
      } else {
        avg = image?.average ? image.average() : [200, 200, 200, 1];
      }
      mapColor.set(m.map, avg);
    }
    base[0] = (base[0] * avg[0]) / 255;
    base[1] = (base[1] * avg[1]) / 255;
    base[2] = (base[2] * avg[2]) / 255;
  }
  return { color: base, alpha: m.transparent ? m.opacity : 1 };
};

interface Cam {
  eye: THREE.Vector3;
  target: THREE.Vector3;
  fov: number;
}

const render = (root: THREE.Object3D, cam: Cam, sky: [number, number, number], path: string) => {
  const depth = new Float32Array(W * H).fill(Infinity);
  const color = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H * 3; i += 3) {
    color[i] = sky[0];
    color[i + 1] = sky[1];
    color[i + 2] = sky[2];
  }

  const camera = new THREE.PerspectiveCamera(cam.fov, W / H, 0.05, 3000);
  camera.position.copy(cam.eye);
  camera.lookAt(cam.target);
  camera.updateMatrixWorld(true);
  const view = camera.matrixWorldInverse;
  const focal = H / Math.tan((cam.fov * Math.PI) / 360);

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const eye = new THREE.Vector3();
  const m4 = new THREE.Matrix4();
  const instanceMatrix = new THREE.Matrix4();

  let depthBias = 1;
  const triangle = (p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, col: Rgba, alpha: number) => {
    // Tidak ada clipper: buang saja segitiga yang menyentuh bidang dekat.
    if (p0.z > -0.02 || p1.z > -0.02 || p2.z > -0.02) return;
    const x0 = ((p0.x / -p0.z) * 0.5 * focal + W / 2) | 0;
    const y0 = (H / 2 - (p0.y / -p0.z) * 0.5 * focal) | 0;
    const x1 = ((p1.x / -p1.z) * 0.5 * focal + W / 2) | 0;
    const y1 = (H / 2 - (p1.y / -p1.z) * 0.5 * focal) | 0;
    const x2 = ((p2.x / -p2.z) * 0.5 * focal + W / 2) | 0;
    const y2 = (H / 2 - (p2.y / -p2.z) * 0.5 * focal) | 0;

    const minX = Math.max(0, Math.min(x0, x1, x2));
    const maxX = Math.min(W - 1, Math.max(x0, x1, x2));
    const minY = Math.max(0, Math.min(y0, y1, y2));
    const maxY = Math.min(H - 1, Math.max(y0, y1, y2));
    if (minX > maxX || minY > maxY) return;

    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (area === 0) return;
    const inv = 1 / area;
    const iz0 = 1 / -p0.z;
    const iz1 = 1 / -p1.z;
    const iz2 = 1 / -p2.z;

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const w0 = ((x1 - x) * (y2 - y) - (x2 - x) * (y1 - y)) * inv;
        const w1 = ((x2 - x) * (y0 - y) - (x0 - x) * (y2 - y)) * inv;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const iz = w0 * iz0 + w1 * iz1 + w2 * iz2;
        if (iz <= 0) continue;
        // `polygonOffset` (tanah & bahu trek, lihat `grassMaterial()`): rasterizer
        // ini memakai float32 dan tanpa depth bias bawaan GPU, jadi rumput yang
        // cuma 5 cm di bawah aspal menang tipis di kejauhan dan jalan terlihat
        // tertutup hijau. Paksa geser ke belakang seperti yang dilakukan WebGL.
        const z = (1 / iz) * depthBias;
        const idx = y * W + x;
        if (z >= depth[idx]) continue;
        depth[idx] = z;
        const o = idx * 3;
        if (alpha >= 0.999) {
          color[o] = col[0];
          color[o + 1] = col[1];
          color[o + 2] = col[2];
        } else {
          color[o] = color[o] * (1 - alpha) + col[0] * alpha;
          color[o + 1] = color[o + 1] * (1 - alpha) + col[1] * alpha;
          color[o + 2] = color[o + 2] * (1 - alpha) + col[2] * alpha;
        }
      }
    }
  };

  root.updateMatrixWorld(true);
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.visible) return;
    for (let p = mesh.parent; p; p = p.parent) if (!p.visible) return;
    const geometry = mesh.geometry;
    const position = geometry?.getAttribute('position');
    if (!position) return;
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    if (!material) return;
    const { color: base, alpha } = materialColor(material);
    depthBias = (material as unknown as { polygonOffset?: boolean }).polygonOffset ? 1.0002 : 1;
    const index = geometry.getIndex();
    const count = (mesh as THREE.InstancedMesh).isInstancedMesh
      ? (mesh as THREE.InstancedMesh).count
      : 1;

    // Urutkan dari jauh ke dekat supaya alpha blend (kaca, asap) tidak salah.
    for (let inst = 0; inst < count; inst++) {
      m4.copy(mesh.matrixWorld);
      if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
        (mesh as THREE.InstancedMesh).getMatrixAt(inst, instanceMatrix);
        m4.multiply(instanceMatrix);
      }
      const tris = index ? index.count : position.count;
      for (let i = 0; i < tris; i += 3) {
        const i0 = index ? index.getX(i) : i;
        const i1 = index ? index.getX(i + 1) : i + 1;
        const i2 = index ? index.getX(i + 2) : i + 2;
        a.fromBufferAttribute(position, i0).applyMatrix4(m4);
        b.fromBufferAttribute(position, i1).applyMatrix4(m4);
        c.fromBufferAttribute(position, i2).applyMatrix4(m4);
        e1.subVectors(b, a);
        e2.subVectors(c, a);
        normal.crossVectors(e2, e1).normalize();
        eye.subVectors(cam.eye, a);
        // Dua sisi: normal selalu dibalik menghadap kamera (z-buffer yang urus).
        if (normal.dot(eye) < 0) normal.negate();
        const band = shadeFor(normal.dot(LIGHT));
        const col: Rgba = [
          Math.min(255, base[0] * band),
          Math.min(255, base[1] * band),
          Math.min(255, base[2] * band),
          1,
        ];
        a.applyMatrix4(view);
        b.applyMatrix4(view);
        c.applyMatrix4(view);
        triangle(a, b, c, col, alpha);
      }
    }
  });

  writePng(path, W, H, color);
  console.log('wrote', path);
};

/* ------------------------------------------------------------------ scenes */

const SKY: [number, number, number] = [176, 214, 240];

const main = async () => {
  mkdirSync('shots', { recursive: true });
  const what = process.argv[2] ?? 'all';

  if (what === 'heli' || what === 'all') {
    const { Helicopter } = await import('../src/world/Heli');
    const heli = new Helicopter();
    heli.place(new THREE.Vector3(0, 0, 0));
    for (let i = 0; i < 4; i++) heli.update(1 / 60, new THREE.Vector3(0, 0, 0));
    // rotor diputar sedikit supaya bilahnya tidak berimpit di render statis
    const root = heli.root;
    root.position.set(0, 0, 0);
    root.rotation.set(0, 0, 0);
    root.visible = true;
    render(root, { eye: new THREE.Vector3(13, 3.4, 0.5), target: new THREE.Vector3(0, 0.5, -0.8), fov: 34 }, SKY, 'shots/heli-side.png');
    render(root, { eye: new THREE.Vector3(9, 4.6, 8), target: new THREE.Vector3(0, 0.4, -0.4), fov: 34 }, SKY, 'shots/heli-front.png');
    render(root, { eye: new THREE.Vector3(-8, -2, 9), target: new THREE.Vector3(0, 0.6, -0.6), fov: 38 }, SKY, 'shots/heli-low.png');
  }

  if (what === 'helipad' || what === 'all') {
    const { buildTrackVisuals } = await import('../src/world/track');
    const { createHelipad, Helicopter: HeliModel } = await import('../src/world/Heli');
    const { SKID_Y } = await import('../src/vehicle/HeliFlight');
    const scene = new THREE.Scene();
    buildTrackVisuals(scene, true);
    const pad = createHelipad();
    pad.position.set(40, 0, -30);
    scene.add(pad);
    // Heli pemain diparkir di tengah landasan, rotor diam.
    const parked = new HeliModel();
    parked.root.position.set(40, -SKID_Y, -30);
    parked.root.rotation.set(0, Math.PI * 0.12, 0);
    scene.add(parked.root);
    render(
      scene,
      { eye: new THREE.Vector3(58, 9, -14), target: new THREE.Vector3(40, 1.2, -30), fov: 46 },
      SKY,
      'shots/helipad.png',
    );
    render(
      scene,
      { eye: new THREE.Vector3(30, 6.5, -46), target: new THREE.Vector3(41, 2.0, -29), fov: 52 },
      SKY,
      'shots/helipad-ground.png',
    );
    // Dari atas: memastikan tanda H terbaca dan tidak ada pohon yang tumbuh
    // di atas landasan.
    render(
      scene,
      { eye: new THREE.Vector3(40, 26, -30.01), target: new THREE.Vector3(40, 0, -30), fov: 48 },
      SKY,
      'shots/helipad-top.png',
    );
  }

  if (what === 'car' || what === 'all') {
    const RAPIER = (await import('@dimforge/rapier3d-compat')).default;
    const { CarVisual } = await import('../src/vehicle/CarVisual');
    const { CarDamageVisual } = await import('../src/vehicle/CarDamageVisual');
    const { defaultConfig, VehiclePhysics } = await import('../src/vehicle/VehiclePhysics');
    await RAPIER.init();
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    world.timestep = 1 / 60;
    // lantai hanya collider (tanpa mesh) supaya gambar cuma berisi mobil
    const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    world.createCollider(RAPIER.ColliderDesc.cuboid(60, 0.5, 60).setTranslation(0, -0.5, 0), ground);
    const car = new VehiclePhysics(world, defaultConfig, new THREE.Vector3(0, 0.95, 0));
    for (let i = 0; i < 90; i++) {
      car.fixedStep(1 / 60, { throttle: 0, brake: 0, steer: 0, handbrake: false, gear: 1 });
      world.step();
    }
    car.sync();
    const scene = new THREE.Scene();
    const visual = new CarVisual(scene, car, { detail: true });
    const damageView = new CarDamageVisual(car.cfg);
    // tabrakan keras dari depan: bodi penyok, satu roda copot
    car.damage.impact(0, 0, -22);
    car.damage.impact(0, 0, -22);
    damageView.sync(visual, car.damage);
    const lights = { brake: 0, reverse: false, left: false, right: false, hazard: false, headlights: false };
    visual.update(car, 0, lights);
    render(
      scene,
      { eye: new THREE.Vector3(5.4, 2.2, 4.6), target: new THREE.Vector3(0, 0.7, 0), fov: 38 },
      SKY,
      'shots/car-damage.png',
    );
    render(
      scene,
      { eye: new THREE.Vector3(-5.6, 1.5, -3.4), target: new THREE.Vector3(0, 0.7, 0), fov: 40 },
      SKY,
      'shots/car-damage-rear.png',
    );
    console.log(
      'kerusakan: bodi',
      (car.damage.bodyHealth * 100).toFixed(0) + '%',
      '· ban copot',
      car.damage.lostCount,
      '· pecah',
      car.damage.puncturedCount,
    );
  }

  if (what === 'pit' || what === 'all') {
    const { buildTrackVisuals, PIT, pitPose } = await import('../src/world/track');
    const scene = new THREE.Scene();
    buildTrackVisuals(scene, true);
    const look = pitPose(PIT.from + 30, 5).position;
    // Dua sudut: dari udara (tata letak) dan dari pinggir trek (tampilan pemain).
    render(
      scene,
      { eye: new THREE.Vector3(look.x - 4, 42, look.z - 26), target: new THREE.Vector3(look.x, 0, look.z), fov: 50 },
      SKY,
      'shots/pit.png',
    );
    const eye2 = pitPose(PIT.from + 2, 22).position;
    const look2 = pitPose(PIT.from + 40, 3).position;
    render(
      scene,
      { eye: new THREE.Vector3(eye2.x, 7.5, eye2.z), target: new THREE.Vector3(look2.x, 1.4, look2.z), fov: 55 },
      SKY,
      'shots/pit-ground.png',
    );
  }

  if (what === 'arena' || what === 'all') {
    const { buildTrackVisuals, TRACK } = await import('../src/world/track');
    const scene = new THREE.Scene();
    buildTrackVisuals(scene, true);
    const p = TRACK.at(TRACK.start);
    // komposisi gambar udara heli
    render(
      scene,
      {
        eye: new THREE.Vector3(p.pos.x + 24, p.pos.y + 26, p.pos.z - 24),
        target: new THREE.Vector3(p.pos.x, p.pos.y, p.pos.z),
        fov: 46,
      },
      SKY,
      'shots/arena-aerial.png',
    );
    render(
      scene,
      { eye: new THREE.Vector3(p.pos.x - 18, 9, p.pos.z + 16), target: new THREE.Vector3(p.pos.x, 1.5, p.pos.z), fov: 55 },
      SKY,
      'shots/arena-ground.png',
    );
    render(
      scene,
      { eye: new THREE.Vector3(66, 190, 210), target: new THREE.Vector3(66, 0, 10), fov: 55 },
      SKY,
      'shots/arena-map.png',
    );
  }
};

void main();
