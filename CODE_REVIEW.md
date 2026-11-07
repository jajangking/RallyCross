# Code review — RallyCross (vehicle physics prototype)

Tanggal: 2026-11-07 · Branch: `arena/e5a5e26f-rallycross` · Commit dasar: `3038c86`

## Ringkasan

Prototipe fisika mobil rally di web: **three.js 0.187** untuk render, **Rapier 0.21 (compat)** untuk rigid body,
**lil-gui** untuk tuning live, **Vite 8 + TypeScript 5.9 (strict)**. Total ~1.840 baris di 7 file sumber
+ 2 skrip uji. Arsitektur intinya sehat: `VehiclePhysics` murni fisika (tanpa DOM), `main.ts` merangkai
renderer/loop/GUI, `scripts/smoke.ts` menguji fisika yang sama secara headless.

Kesan umum: **kualitas di atas rata-rata untuk sebuah prototipe**. Model suspensi raycast + friction circle
+ load transfer sudah benar secara konsep, ada scratch vector (hampir tanpa alokasi di hot loop), loop
fixed-step dengan accumulator, dan test yang menjaga bug yang pernah terjadi (tanda damper, arah setir).

Masalah yang ditemukan tidak ada yang fatal. Yang paling perlu diperbaiki: satu slider GUI yang mati,
satu bug pixel-ratio saat resize, ukuran bundle mobile, dan pemisahan collider vs visual di `track.ts`.

## Status perbaikan (2026-11-07)

Semua temuan sudah dikerjakan di branch ini, kecuali dua yang dijelaskan di bawah.

| # | Temuan | Status |
|---|---|---|
| 1 | Slider `angularDamping` mati | ✅ `VehiclePhysics.applyDamping()` + `onChange` di GUI |
| 2 | `?quality=low` hilang setelah resize | ✅ `maxPixelRatio` dipakai saat init **dan** resize |
| 3 | Bundle 4,92 MB (WASM base64) | ⏳ belum — lihat catatan di bawah |
| 4 | `track.ts` mencampur collider & visual | ✅ `buildTrackColliders()` (tanpa DOM) + `buildTrackVisuals()`, layout berupa data |
| 5 | Suspensi mendorong ke `up` body | ✅ dorong searah `w.normal` (normal kontak) |
| 6 | Batas kecepatan diterapkan dua kali | ✅ `dragScale` dihapus, tinggal `powerScale` (relatif gigi) |
| 7 | `driftAngle` memutasi scratch `fixedStep` | ✅ pakai scratch sendiri (`sDrift`) |
| 8 | `fixedStep` monolit 200 baris | ✅ dipecah: `updateGear`, `updateSteering`, `updateSuspension`, `applyAntiRoll`, `applyTireForces`, `applyAero`, `applyImpulse` |
| 9 | `TouchSlider` tidak melacak `pointerId` | ✅ `activePid` per slider; jari kedua tidak membajak kontrol |
| 10 | Tidak ada CI / test determinisme / linter | ✅ CI (`check` + `smoke` + `build`) + test determinisme; ⏳ linter sengaja belum |
| 11 | Detail kecil | ✅ format `fixedStep`, README dobel, favicon + meta description, `surfaceMu` di-reset, gear HUD nyata, barrier keliling dunia, material track di-cache, alloc objek impulse dihapus |

### Perubahan perilaku: rem murni + gigi mundur manual

Ini permintaan terpisah dan mengubah kontrak input fisika:

- `VehicleInput` sekarang `{ throttle: 0..1, brake: 0..1, steer, handbrake, gear: 1 |-1 }`.
  Dulu `throttle: -1..1` dengan arti "negatif = rem/mundur".
- **Rem hanya memperlambat.** Besarnya gaya rem dikali `clamp(|v_long|/1.2, 0, 1)`, jadi saat mobil
  hampir berhenti gayanya memudar: rem tidak bisa mendorong mundur dan tidak bergetar di sekitar nol.
- **Gigi mundur manual.** `Q` (keyboard) atau tombol D/R (sentuh) meminta gigi R; `VehiclePhysics.updateGear()`
  hanya menerimanya kalau `|v_forward| ≤ shiftSpeedLimit` (1,5 m/s). Gas di gigi R mendorong mundur dengan
  batas `reverseMaxSpeed` (12 m/s). HUD menampilkan `D`/`R` yang benar-benar aktif, bukan tebakan dari kecepatan.
- Gas dan rem kini **independen** (dulu `throttle = gas - rem`), jadi menekan keduanya tidak saling meniadakan.
- `scripts/smoke.ts` dan `scripts/browser-check.mjs` diperbarui untuk semantik baru, ditambah check:
  rem tidak pernah membalikkan mobil, R ditolak saat melaju lalu masuk setelah berhenti, top speed R terbatas,
  rem tetap bekerja di gigi R, dan tombol D/R + HUD `R`.

### Catatan untuk #3 (bundle) dan linter

- **#3 sengaja belum diubah.** `@dimforge/rapier3d-compat` meng-*inline* WASM sebagai base64 (4,1 MB dari
  4,93 MB bundle) supaya tidak perlu request `.wasm` terpisah — nyaman di Termux/Android. Menggantinya ke
  `@dimforge/rapier3d` (WASM terpisah, ±1,9 MB, gzip jauh lebih kecil) mengubah pipeline build & cara init,
  dan `scripts/smoke.ts` di Node ikut terdampak. Perubahan sebesar itu harus diverifikasi di browser sungguhan,
  sedangkan sandbox ini tidak punya Chromium. Rencananya: pakai `rapier3d` untuk web + tetap `-compat` untuk
  smoke Node, lalu ukur LCP di HP.
- **Linter** (biome/eslint + prettier) belum ditambahkan karena butuh dependency baru dan reformat seluruh repo;
  lebih baik diputuskan terpisah supaya diff review tetap terbaca. `tsc` strict + `noUnusedLocals` sudah menangkap
  sebagian besar masalah mekanis.

## Verifikasi yang dijalankan

| Perintah | Hasil |
|---|---|
| `npm install` | 56 paket, tanpa error |
| `tsc --noEmit` | ✅ bersih (strict + `noUnusedLocals` + `noUnusedParameters`) |
| `npm run build` | ✅ 19 modul, `dist` 4,93 MB JS (gzip 1,82 MB) + 5,1 kB CSS |
| `npm run smoke` | ✅ **35/35 check lolos** (massa 1250 kg, ride height 0,923 m, 0→30,3 m/s, rem 30,3→10,1 m/s lalu berhenti, drift 146,6°, gigi R 11,6 m/s, determinisme, ramp di track asli) |
| `npm run check:browser` | ⚠️ tidak bisa dijalankan di sandbox ini (tidak ada Chromium); skripnya sudah diperbarui tapi belum diverifikasi di browser |
| Shim DOM (jsdom, sementara) | ✅ input keyboard/sentuh & tombol D/R: 15/15 check lolos — jsdom tidak dipakai lagi setelah itu |

## Yang sudah bagus

- **Fisika bebas DOM.** `VehiclePhysics` hanya butuh `RAPIER.World` → siap dipakai untuk server-authoritative
  atau training AI.
- **Suspensi raycast benar.** Damper menambah gaya saat kompresi (`vDown > 0`), anti-roll bar transfer beban
  dua arah, `Fz` berasal dari kompresi → load transfer muncul otomatis, bukan diakali.
- **Friction circle** membatasi `√(Fx²+Fy²) ≤ μ·Fz`, dan `μ` dikali friction collider yang kena raycast →
  gravel/ice benar-benar mengubah grip tanpa kode khusus.
- **Loop deterministik** 1/60 s + accumulator, maks 5 substep, sisa accumulator dibuang (tidak spiral).
- **Input analog** (slider gas/rem 1:1, setir 1:1, keyboard di-ramp) dan test yang mengunci perilaku itu.
- **Disiplin memori** di hot loop: `tForce`, `tV`, `tR`, `tN` dipakai ulang; tidak ada `new Vector3()` per step.
- `?quality=low`, safe-area inset CSS, `touch-action: none`, `env()` untuk notch — detail mobile diperhatikan.
- Smoke test mengunci bug historis (tanda damper, arah setir, body tidak terbalik) — ini yang bikin refactor aman.

## Temuan

### 1. Bug: slider `angularDamping` tidak berefek (sedang)

`src/main.ts:169` menambahkan controller `cfg.angularDamping`, tapi angular damping rigid body hanya di-set
sekali di constructor (`src/vehicle/VehiclePhysics.ts:160`). Memutar slider → nilai `cfg` berubah, perilaku
mobil tidak. Pengguna akan mengira tuning-nya rusak.

**Saran:** `.onChange(() => car.body.setAngularDamping(cfg.angularDamping))`, atau bungkus dalam method
`VehiclePhysics.applyDamping()`.

### 2. Bug: `?quality=low` hilang setelah resize (sedang)

`src/main.ts:238` memanggil `renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))` tanpa melihat
`lowQuality`. Di HP, begitu address bar muncul/hilang atau layar diputar, pixel ratio naik lagi ke 2x —
justru di perangkat yang paling butuh mode low. Shadow tetap mati, tapi biaya fill-rate kembali penuh.

**Saran:** simpan `const maxDpr = lowQuality ? 1 : Math.min(devicePixelRatio, 2)` di scope `boot()` dan pakai
di kedua tempat.

### 3. Bundle 4,92 MB, 4,1 MB di antaranya WASM base64 (sedang)

Hampir seluruh JS adalah `@dimforge/rapier3d-compat` yang meng-*inline* WASM sebagai base64 (±3,3 MB teks).
Untuk koneksi mobile Indonesia ini berat: gzip 1,8 MB, dan parse base64 + compile WASM terjadi sebelum
frame pertama. `build.assetsInlineLimit: 0` tidak menolong karena ini string JS.

**Saran:** pakai `@dimforge/rapier3d` (WASM sebagai file terpisah, di-fetch paralel & di-cache browser),
dan/atau `await import('...')` untuk fisika setelah HUD tampil, sehingga yang pertama terlihat bukan layar
"Menyiapkan fisika…" selama beberapa detik.

### 4. `track.ts` mencampur collider dan visual (sedang, arsitektural)

`buildTrack(world, scene)` membuat mesh **dan** collider sekaligus, dan `makeGridTexture()`
(`src/world/track.ts:16`) memanggil `document.createElement('canvas')`. Akibatnya track tidak bisa dibangun
headless — saya harus menduplikasi collider ground + ramp manual saat probe. Ini bertabrakan dengan tujuan
"fisika DOM-free → server/AI": `VehiclePhysics` bersih, tapi dunia-nya tidak.

**Saran:** pecah jadi `buildTrackColliders(world)` (murni Rapier) dan `buildTrackVisuals(scene)`, lalu
`main.ts` memanggil keduanya. Smoke test bisa langsung memakai track asli.

### 5. Suspensi selalu mendorong ke `up` body, bukan ke normal kontak (sedang, fisika)

`src/vehicle/VehiclePhysics.ts:440` menerapkan impuls `springForce * dt` searah `up` body. Di permukaan
miring (ramp 10°, washboard, bank) reaksi normal seharusnya searah `w.normal`; selisihnya membuat mobil
kehilangan sebagian gaya penopang dan mendapat dorongan menyamping/turun yang tidak fisik, sehingga grip di
permukaan miring lebih rendah dari seharusnya. `Fz` untuk ban juga memakai `springForce` mentah, bukan
proyeksi ke normal.

**Saran:** `this.tForce.copy(w.normal).multiplyScalar(w.springForce * dt)` dan `Fz = springForce * normal·up`.
Uji ulang smoke (ride height bisa bergeser sedikit).

### 6. Batas kecepatan diterapkan dua kali (rendah, tuning)

`src/vehicle/VehiclePhysics.ts:375-376`: `powerScale = 1 - (v/vmax)²` **dan** `dragScale = 1 - 0.55·v/vmax`,
lalu keduanya dikalikan ke gaya mesin (`:414`), sementara drag aero asli juga sudah ada di `:458`. Efeknya
tenaga turun kuadratik-ganda sehingga tuning `engineForce` / `maxSpeed` sulit ditebak.

**Saran:** sisakan satu mekanisme pembatas (kurva torsi vs kecepatan), biarkan drag menangani hambatan udara.

### 7. Getter `driftAngle` memutasi scratch milik `fixedStep` (rendah)

`src/vehicle/VehiclePhysics.ts:240-249` memakai `this.tFwd` (scratch yang juga dipakai `fixedStep`).
Saat ini aman karena HUD memanggilnya setelah step, tapi ini jebakan untuk pemanggil berikutnya
(mis. AI yang membaca drift di tengah perhitungan).

**Saran:** vektor scratch khusus, atau hitung lokal.

### 8. `fixedStep` adalah monolit ±200 baris (rendah, maintainability)

Satu method menangani steering, raycast, ARB, ban, drivetrain, friction circle, aero, dan safety net.
Belum masalah untuk 476 baris, tapi akan menyulitkan saat menambah gearbox, turbo, atau handbrake model baru.

**Saran:** pecah ke `stepSteering`, `stepSuspension`, `stepTires`, `stepAero` — tetap tanpa DOM.

### 9. Kontrol sentuh tidak melacak `pointerId` (rendah)

`TouchSlider` menyimpan `held: boolean`. Dua jari di slider yang sama (atau `pointerup` dari jari lain)
membuat nilai "melompat" dan langsung lepas. Kasus tepi, tapi terasa saat main di HP.

**Saran:** simpan `activePointerId` dan abaikan event dari pointer lain.

### 10. Belum ada CI, linter, atau test determinisme (rendah)

`npm run check:browser` dan `npm run smoke` sangat bagus tapi harus dijalankan manual; tidak ada
`.github/workflows`. README juga mengklaim "input yang sama → hasil yang sama" padahal belum ada test
determinisme (menjalankan 2 simulasi identik dan membandingkan state akhir).

**Saran:** workflow `check` + `smoke` (±3 detik, murah), tambah `biome`/`eslint` + `prettier`, dan satu test
determinisme berbasis hash posisi/kecepatan setelah N step.

### 11. Detail kecil (info)

- `src/vehicle/VehiclePhysics.ts:273` — format rusak: `fixedStep(dt: number, input: VehicleInput) {    const cfg = this.cfg;`.
- `README.md` diakhiri dua baris `# RallyCross` berulang (sisa merge).
- `index.html` tidak punya favicon → request `/favicon.ico` 404 (tidak muncul sebagai console error, tapi mengotori network log).
- `reset()` tidak mengembalikan `w.surfaceMu` (kosmetik, langsung tertimpa step berikutnya).
- Indikator gigi di HUD hanya pemetaan `1 + kmh/26` — belum ada gearbox/rasio, jadi angka 1–6 itu kosmetik.
- Ground 800×800 m tanpa dinding: di z≈±400 mobil terjun lalu auto-reset (`y < -25`). Untuk sesi panjang,
  sebaiknya ada barrier atau track tertutup.
- Setiap kotak di `track.ts` membuat `MeshStandardMaterial` baru (±25 material) → tidak bisa di-batch.
  Pakai beberapa material bersama kalau jumlah objek bertambah.
- `applyImpulseAtPoint` dipanggil dengan objek literal setiap roda setiap step (4–6 alokasi/step); kecil,
  tapi bisa dipakai objek yang dipakai ulang seperti scratch vector lainnya.

## Prioritas

1. **Sekarang:** #1 (slider mati), #2 (pixel ratio resize), #10 (CI `check` + `smoke`).
2. **Berikutnya:** #4 (pisahkan collider/visual track → membuka test dunia secara headless), #3 (bundle/WASM).
3. **Saat menyentuh fisika lagi:** #5 (dorong searah normal), lalu #6 dan #8.

## Perubahan yang sudah dilakukan di branch ini

- `vite.config.ts`: `server.allowedHosts` + `preview.allowedHosts` = `true`. Sebelumnya dev server menolak
  Host proxy (`403 Blocked request`), jadi preview di environment ini tidak bisa dibuka.
- `src/vehicle/VehiclePhysics.ts`: dipecah per sistem, input baru (rem murni + gigi manual), suspensi searah
  normal kontak, satu kurva tenaga, scratch vector terpisah, `applyDamping()`.
- `src/input.ts`: pedal gas/rem independen, gigi D/R (`Q`, tombol sentuh), `pointerId` per slider.
- `src/main.ts`: pixel ratio tetap, slider `angularDamping`/`reverseMaxSpeed`/`shiftSpeedLimit`, reset ikut
  mengembalikan gigi ke D.
- `src/hud.ts`, `src/style.css`, `index.html`: gear D/R nyata, tombol D/R, favicon, teks bantuan.
- `src/world/track.ts`: collider & visual dipisah, layout data, barrier keliling, material di-cache.
- `scripts/smoke.ts` (+35 check), `scripts/browser-check.mjs`, `.github/workflows/ci.yml`.
- `README.md` diperbarui (kontrol, gigi manual, model fisika, verifikasi), `CODE_REVIEW.md` ini.

## Iterasi 2 — detail visual mobil (2026-11-07)

Permintaan: mobil yang jauh lebih detail — suspensi per roda, lampu rem, lampu sein, kaca, spion, dll.
Fisika tidak diubah; semua tambahan ada di lapisan visual.

**Yang dibangun**

| Bagian | Isi |
|---|---|
| Bodi | Dua `ExtrudeGeometry` dari profil samping (bodi bawah + greenhouse) dengan bevel, fender flare, skirt, splitter, diffuser, sayap belakang bertumpu di bagasi, scoop atap, mud flap, knalpot, tow hook, plat, grille, handle |
| Kaca | Windshield, rear glass, dua jendela samping per sisi — semua di-offset melewati bevel bodi supaya tidak tenggelam |
| Spion | Rumah + kaca reflektif (`metalness 1`, `roughness 0.05`) + tangkai, di luar lebar bodi |
| Interior | Dashboard, jok, roll cage di dalam kabin, setir yang berputar 5× sudut setir |
| Suspensi | Per roda: lower + upper wishbone, tie rod, coilover (pegas helical + body damper + shaft), knuckle, disc brake + caliper; semua titik dihitung ulang dari `suspLength` tiap frame, camber bertambah saat kompresi, cakram berpijar saat rem |
| Lampu | Rem (lerp 14/s), posisi redup, mundur putih di gigi R, sein kiri/kanan + hazard dengan blink 0.42 s, lampu utama (lensa emissive + 2 `SpotLight`), repeater di HUD |
| Material | `PMREMGenerator` + `RoomEnvironment` untuk cat clearcoat, kaca, spion (dimatikan di `?quality=low`) |

**Verifikasi**

- `tsc --noEmit` bersih, `npm run smoke` **35/35** tetap hijau (fisika tidak tersentuh), `npm run build` sukses.
- Model diuji headless tanpa GPU: dibuat dengan `THREE.Scene` nyata lalu dirender dengan software rasterizer sementara (painter's algorithm + PNG encoder) dari 4 sudut, sehingga bentuk bodi, kaca, spion, sayap, dan lampu bisa diperiksa visual. Dari situ ditemukan & diperbaiki: sayap melayang (stay tidak menyentuh bagasi), kaca tenggelam di dalam bevel bodi, spion berada di dalam bodi, roll cage menembus atap, dan center cap roda berwarna oranye mencolok.
- Uji gerak: saat pengereman + belok, tinggi hub keempat roda berbeda (`-0.551 / -0.488 / -0.651 / -0.588`), membuktikan suspensi visual benar-benar mengikuti raycast.
- Ukuran: **132 mesh / ±37 ribu triangle** (high), lebih sedikit di `?quality=low`.
- `scripts/browser-check.mjs` ditambah 8 check: lampu rem menguat, sein kiri berkedip (kanan tetap mati), repeater HUD, lampu utama, lampu mundur di R, 4 hub di rentang travel, dan setir berputar.

**Catatan**

- Karena badan mobil kini turun sampai `y ≈ -0.62` (visual) sementara collider tetap 0.68 m, bagian bawah bodi bisa terlihat sedikit menembus tanjakan/obstacle. Collider sengaja tidak diubah supaya handling tetap sama.
- Renderer software itu hanya alat bantu verifikasi sementara dan tidak ikut di-commit (repo tetap bersih dari artefak).

## Iterasi 3 — bodi diganti model GLB (2026-11-07)

Umpan balik: bodi prosedural jelek. Solusi: **berhenti membangun bodi sendiri** dan
memakai model 3D yang sudah ada, di-porting ke dalam fisika yang sama.

**Model**

| | |
|---|---|
| Model | "1991 Honda Civic EG6" oleh [rifdanzz](https://sketchfab.com/rifdanzz) |
| Sumber | Sketchfab, redistribusi via [`iManuel2K/capcar`](https://github.com/iManuel2K/capcar) |
| Lisensi | CC BY 4.0 (boleh dipakai komersial + diubah + didistribusikan, wajib atribusi) |
| Berkas | `public/models/honda-civic-eg6.glb`, 250.560 B, 39 mesh / 18.197 triangle |
| Atribusi | [`public/models/CREDITS.md`](public/models/CREDITS.md) (wajib ikut kalau model dipakai ulang) |

**Cara porting (`src/vehicle/CarModelVisual.ts`)**

- Skala dihitung dari jarak sumbu roda model (`516,3 unit` → `2,64 m`), bukan ditebak: hasilnya lebar 1,844 m / panjang 4,192 m / tinggi 1,359 m — cocok dengan `halfWidth 0.92`, `halfLength 2.05`.
- Tinggi ban diukur dari bounding box roda, lalu model digeser vertikal supaya keempat ban menyentuh bidang tanah yang sama dengan suspensi (`hub rest = -0.725 m`, alas ban `= -1.02 m`).
- Empat node roda (`Circle*`) di-*attach* ke pivot `steer` (yaw) + `spin` (poros) tanpa mengubah geometri; tiap frame pivot mengikuti `steerAngle`, `spinAngle`, dan `suspLength`. Sudut setir visual dibatasi 0,5 rad supaya bahu ban tidak menembus fender di lock penuh.
- Lampu: mesh lampu bawaan model dibelah kiri/kanan di index buffer (atribut vertex dipakai bersama, hanya index yang dipisah), lalu material emissive-nya digerakkan `LampController` yang sama dengan bodi prosedural. Hasilnya lampu rem, sein, mundur, dan lampu utama menyala persis di bentuk lampu model.
- `CarLights` tetap ada sebagai fallback (kalau model tidak punya mesh lampu) dan `CarVisual` tetap ada sebagai fallback kalau GLB gagal dimuat — game tidak pernah kehilangan mobil.

**Verifikasi**

- `tsc --noEmit` bersih, `npm run smoke` **35/35** (fisika tidak tersentuh), `npm run build` sukses; `dist/models/honda-civic-eg6.glb` ikut ter-copy (250.560 B).
- Model + perakitan diuji headless: GLB di-parse `GLTFLoader` di Node dengan tekstur di-strip, lalu dirakit dengan `assembleCarModel()` dan dirender 4 sudut memakai software rasterizer **dengan z-buffer** (versi painter's algorithm sempat memberi kesan ban menembus fender — itu artefak sorting, bukan bug).
- Angka hasil rakitan: roda di `x ±0,753 / z ±1,320`, pivot roda berputar tepat di pusat ban (geser 0,000 m saat spin, 0,003 m saat steer), bodi `y -1,020 … +0,339`.
- `dev` server: `/models/honda-civic-eg6.glb` disajikan `200 model/gltf-binary`, modul baru ter-load lewat Vite.

**Catatan**

- Track ban visual (±1,51 m) lebih sempit dari anchor fisika (±1,72 m) karena model memakai proporsi pabrikan; yang penting sumbu roda dan alas ban cocok, sehingga tidak ada ban melayang/amblas.
- Cat bodi bisa diganti tanpa rebuild: `?paint=e23b2e`.

## Iterasi 4 — mobil diam tapi bergeser & ban naik ke bodi (2026-11-07)

Dua laporan: (1) mobil berhenti tapi *grip* naik-turun, mobil bergeser sedikit
ke kiri/kanan, suspensi naik-turun sendiri; (2) saat shock bekerja (atau saat
tuning), ban naik sampai kena bodi.

**1. Limit cycle 60 Hz di titik kontak (`VehiclePhysics.applyTireForces`)**

Direproduksi headless: mobil didiamkan di **batas patch gravel/ice** (dua roda
kena collider berbeda, jadi mobil miring 1 cm). Hasil pengukuran sebelum
diperbaiki:

| | sebelum | sesudah |
|---|---|---|
| geseran 6 s | **23,1 cm** (gravel), **12,5 cm** (ice) | 0,0 cm |
| kecepatan lateral | berganti tanda tiap frame: +0,095 / −0,057 m/s | ~0 |
| angka *grip* di HUD | 55–100 % berkedip | 0 % |
| spread `suspLength` | 7,5 mm | 0,6 mm |

Penyebabnya: gaya lateral ban diterapkan sebagai impuls satu step dengan gain
`μFz/(0,9·peak)` ≈ 27 kN per m/s. Dengan massa kontak efektif yang lebih kecil
dari `m/4` (chassis bisa berputar di titik kontak), satu step sudah membalik
tanda kecepatan → osilasi tak pernah mereda. Perbaikannya: impuls gesek satu
step dibatasi oleh kecepatan slip (`|F·dt| ≤ |v_slip| · mContact`, `mContact =
massa/8`), berlaku juga untuk gaya longitudinal yang melawan gerak (rem, rolling
resistance, handbrake). Di atas ~0,4 m/s slip batas ini tidak pernah aktif, jadi
grip, drift, dan pengereman tidak berubah — dibuktikan 35 check lama tetap
hijau.

**2. Ban naik ke rumah roda**

Penyebabnya bukan suspensi, tapi referensi tinggi model: `CarModelVisual`
dulu memakai `suspensionRest` (pegas *belum* tertekan) sebagai titik nol,
padahal mobil diam di `suspensionRest − m·g/4k` (sekitar **9,7 cm** lebih
rendah). Akibatnya ban sudah tergeser 9,7 cm ke dalam fender bahkan sebelum
shock bergerak, dan setiap kompresi kecil langsung menembus bodi.

Perbaikan: posisi ban sekarang dihitung langsung dari hasil raycast tiap frame,
`centreY = anchorY − suspLength − wheelRadius + radiusBanModel`. Konsekuensinya:
ban selalu tepat di bidang tanah, model dipasang untuk pose *settled*, dan
setelan `suspensionRest`/`springK` di GUI tidak lagi membuat ban naik ke bodi.
Diukur dengan vertex-scan mesh bodi: ruang ban ke fender **154 mm** saat diam,
masih 94 mm saat kompresi 6 cm, dan 54 mm saat kompresi 10 cm.

**Test baru (`npm run smoke`, sekarang 41 check)**

- `parked on the gravel edge stays put` (< 2 cm / 6 s)
- `no grip flicker on the gravel edge` (peak traction < 10 %)
- `suspension settles on the gravel edge` (spread < 3 mm)
- versi yang sama untuk **ice edge**
- Semua sudah diverifikasi *gagal* kalau batas impuls dimatikan, jadi test ini
  benar-benar menjaga bug-nya.
