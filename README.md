# RallyCross — Vehicle Physics Prototype

Prototipe **fisika mobil rally 3D di web** (three.js + Rapier). Fokus tahap ini: *feel* handling — chassis, suspensi raycast, model ban, drift, permukaan licin. Belum ada track/AI/multiplayer.

## Jalanin

```bash
npm install
npm run dev        # buka http://localhost:5173
```

Di Android/Termux: jalankan `npm run dev`, lalu buka `http://localhost:5173` di Chrome HP. Tambah `?quality=low` kalau GPU-nya lemah (shadow dimatikan, pixel ratio 1x).

```bash
npm run build      # type-check + bundle
npm run preview    # serve hasil build
npm run smoke      # test fisika headless (tanpa browser)
```

## Kontrol

Semua input **analog/proporsional** — bukan tombol on/off:

| Aksi | Keyboard | Sentuh |
|---|---|---|
| Gas (bukaan 0–100 %) | `W` / `↑` | slider vertikal GAS |
| Rem (bukaan 0–100 %) | `S` / `↓` | slider vertikal REM |
| Setir (1:1) | `A` `D` / `←` `→` (di-ramp) | slider horizontal SETIR |
| Gigi maju/mundur (D ⇄ R) | `Q` | tombol D/R |
| Sein kiri / kanan | `Z` / `X` | tombol ◀ ▶ |
| Hazard | `H` | tombol ! |
| Lampu utama | `L` | tombol ◐ |
| Handbrake | `Space` | HB |
| Reset mobil | `R` | — |
| Ganti kamera (chase/hood) | `C` | — |
| Panel tuning | `G` | — |

Cara kerjanya:

- **Slider setir** 1:1 dengan jari (geser sedikit = belok dikit). Lepas → kembali ke tengah dengan spring halus.
- **Slider gas & rem** vertikal: posisi jari = besar bukaan (0–100 %), bisa ditahan di 30 %, 60 %, berapa pun. Lepas → menutup sendiri. Isi track menunjukkan bukaan saat ini.
- **Keyboard** tetap di-ramp (`KEY_GAS_ATTACK` / `KEY_STEER_ATTACK` di `src/input.ts`), jadi tap `D`/`W` sebentar = input kecil; tahan = penuh.
- **Gas dan rem itu dua pedal terpisah** (`throttle: 0..1`, `brake: 0..1`). Rem hanya memperlambat, tidak pernah membuat mobil mundur, dan tidak bisa meniadakan gas — kalau dua-duanya ditekan, rem menang karena gaya rem > gaya mesin.
- **Gigi mundur manual.** Tekan `Q` (atau tombol D/R di layar) untuk pindah D ⇄ R. Gigi hanya mau masuk saat mobil hampir berhenti (`shiftSpeedLimit`, default 1,5 m/s), persis gearbox manual: menekan R di tengah lintasan tidak membalik arah mobil. Setelah masuk R, gas mendorong mundur dan dibatasi `reverseMaxSpeed` (12 m/s ≈ 43 km/h). HUD menampilkan `D`/`R` yang benar-benar aktif.
- Nilai yang dikirim ke fisika cuma `throttle`, `brake`, `steer`, `handbrake`, dan `gear`; tuning kontrol tidak menyentuh `VehiclePhysics`.

Panel lil-gui di kanan atas berisi semua parameter handling + preset **Tarmac / Gravel / Ice**. Semua perubahan langsung terasa (live), tanpa reload.

> Debug handle: `window.rc` → `{ car, world, cfg, input, cameraRig, renderer, scene, snap() }`.

## Struktur

```
src/
├─ main.ts                  # renderer, scene, loop tetap 60 Hz, GUI, presets
├─ vehicle/
│  ├─ VehiclePhysics.ts     # SEMUA fisika kendaraan (tidak butuh DOM)
│  ├─ CarVisual.ts          # bodi, kaca, spion, interior, perakitan
│  ├─ CarSuspension.ts      # per roda: wishbone, tie rod, coilover, rem
│  ├─ CarLights.ts          # lampu rem, sein, mundur, lampu utama
│  └─ carParts.ts           # material + helper geometri (link, pegas)
├─ world/track.ts
│  ├─ buildTrackColliders() # ground, ramp, cone, gravel, ice — tanpa DOM
│  └─ buildTrackVisuals()   # mesh + tekstur canvas — hanya browser
├─ camera.ts                # chase / hood cam + FOV dinamis
├─ input.ts                 # slider setir/gas/rem analog + gigi D/R + sein/lampu
├─ hud.ts                   # speedo, gear D/R, beban per roda, drift
└─ style.css
scripts/
├─ smoke.ts                 # test fisika headless (Node + Rapier, tanpa render)
└─ browser-check.mjs        # opsional: cek render/console di Chromium headless
.github/workflows/ci.yml    # check + smoke + build di setiap push
```

`VehiclePhysics.ts` dan `buildTrackColliders()` sengaja **tidak menyentuh DOM/renderer**, jadi bisa dijalankan di Node (lihat `scripts/smoke.ts`, termasuk uji ramp di track asli) — penting kalau nanti mau server-authoritative multiplayer atau training AI.

## Model fisika

**Chassis**
- Rigid body dinamis, box `1.84 × 0.68 × 4.1 m`, massa **1250 kg**.
- Massa & inersia di-set eksplisit di collider (`setMassProperties`), center of mass **0.30 m di bawah** titik geometris → susah kebalik.
- CCD aktif (kecepatan tinggi), `canSleep = false`.

**Suspensi (per roda, raycast)**
- Ray dari anchor roda ke bawah sepanjang `rest + radius`.
- `F_spring = k · compression + c · v_down` — damper **menambah** gaya saat kompresi (tanda ini pernah jadi bug anti-damping, sudah diperbaiki dan dijaga oleh smoke test).
- Gaya suspensi didorong searah **normal kontak**, bukan sumbu atas bodi, jadi ramp dan permukaan miring menopang mobil dengan benar.
- Anti-roll bar depan/belakang: transfer beban berdasarkan selisih kompresi kiri/kanan.
- Default: `k = 30 kN/m`, `c = 2.6 kN·s/m`, rest 0.34 m.

**Ban**
- Slip angle `α = atan2(v_lat, |v_long| + 0.9)`.
- Gaya lateral linear sampai `peakSlipDeg` (9°), lalu turun perlahan (`driftFalloff`) → drift terkontrol, bukan cengkeraman tak terbatas.
- Gaya longitudinal: engine (AWD split 42/58, arah sesuai gigi), rem, rolling resistance, handbrake.
- **Rem tidak pernah memberi tenaga.** Besarnya gaya rem mengikuti `clamp(|v_long| / 1.2, 0, 1)`, jadi saat mobil hampir berhenti gaya rem memudar dan tidak mendorong mundur / bergetar di sekitar nol. Mundur hanya lewat gigi R.
- Tenaga mesin turun sekali terhadap kecepatan relatif gigi (`powerScale`), bukan dua kali seperti versi sebelumnya.
- **Friction circle**: `√(Fx² + Fy²) ≤ μ·Fz`. Karena `Fz` datang dari kompresi suspensi, load transfer terjadi otomatis.
- `μ` dikali **friction collider** yang kena raycast → patch gravel (0.62) dan ice (0.28) di scene benar-benar mengubah grip.

**Aero**
- Drag `0.55·v²`, downforce `1.2·v²` di titik COM.

## Mobil & detail visual

Visual mobil sekarang dibangun prosedural (tanpa file model), semuanya mengikuti state fisika:

**Bodi & kabin**
- Dua `ExtrudeGeometry` dari profil samping (counter-clockwise, jadi normal menghadap keluar): bodi bawah dengan hidung/buntut membulat + greenhouse terpisah, keduanya ber-bevel.
- Kaca terpisah: windshield, rear glass (diposisikan keluar dari bevel bodi), dan dua jendela samping per sisi.
- Spion (rumah + kaca reflektif + tangkai), fender flare di 4 lubang roda, side skirt, splitter, diffuser, sayap belakang yang menempel di bagasi lewat dua stay, scoop atap, mud flap, knalpot, tow hook, plat nomor, grille, handle pintu.
- Interior: dashboard, dua jok, roll cage di dalam kabin, dan setir yang berputar mengikuti sudut setir (rasio 5:1).

**Suspensi per roda (kelihatan bekerja)**
- Tiap sudut punya lower & upper wishbone, tie rod kemudi, dan coilover: pegas helical (`TubeGeometry`) + body damper + shaft.
- Semua titik pangkal dihitung ulang tiap frame dari `wheel.suspLength` hasil raycast, jadi saat kompresi pegas memendek, lengan berayun, roda ikut bergerak; camber bertambah sedikit saat suspensi terkompresi.
- Roda: ban, rim barel + bibir + 5 spoke, center cap, disc brake (ikut berputar) + caliper (menempel di upright, berwarna kontras), dan cakram yang berpijar halus saat rem dipakai.

**Lampu (semua dinamis)**
- Lampu rem menyala terang mengikuti pedal rem (lerp 14/s), lampu posisi redup saat tidak ngerem.
- Lampu mundur putih menyala otomatis saat gigi R.
- Sein kiri/kanan + hazard: kedip 0.42 s nyala / 0.42 s mati, langsung restart saat pilihan berubah, plus repeater ◀ ▶ ◐ di HUD yang ikut berkedip.
- Lampu utama: lensa emissive + dua `SpotLight` (dimatikan di `?quality=low`).

**Material & performa**
- `PMREMGenerator` + `RoomEnvironment` memberi environment map untuk cat (clearcoat), kaca, dan spion; dilewati di `?quality=low`.
- Versi detail: **132 mesh / ±37 ribu triangle**; mode low memakai segmen lebih sedikit, tanpa roll cage dan tanpa spot light.

**Loop**
- Fisika fixed **1/60 s** + accumulator (maks 5 substep), render interpolasi pose setelah `world.step()`.
- Deterministik: input yang sama → hasil yang sama. Dijaga oleh test determinisme di `npm run smoke` (dua run identik harus menghasilkan state akhir yang sama persis) — dasar untuk replay/netcode nanti.

## Tuning cepat

| Parameter | Efek |
|---|---|
| `springK` / `damperC` | keras/lembut & redaman. Damper terlalu kecil → mobil memantul. |
| `antiRollFront/Rear` | kurangi body roll; belakang lebih kaku → cenderung oversteer. |
| `muFront` / `muRear` | `muRear < muFront` → oversteer/drift; sebaliknya understeer. |
| `peakSlipDeg` | titik puncak grip. Kecil = ban "licin", besar = forgif. |
| `driftFalloff` | seberapa cepat grip hilang setelah puncak. |
| `frontSplit` | 0 = RWD, 1 = FWD, 0.42 = AWD condong belakang. |
| `reverseMaxSpeed` | Batas kecepatan di gigi R (m/s). |
| `shiftSpeedLimit` | Seberapa pelan mobil harus jalan sebelum D ⇄ R diterima. |
| `comY` | makin negatif = makin anti-kebalik, tapi makin "aneh" saat roll. |
| `steerFalloff` | pengurangan sudut setir di kecepatan tinggi. |

Preset ada di panel GUI; `Copy config` menyalin JSON config ke clipboard untuk disimpan sebagai default baru.

## Verifikasi

`npm run smoke` menjalankan fisika yang sama di Node dan mengecek:

- massa body = 1250 kg, mulai di gigi D
- ride height stabil (~0.92 m), 4 roda kontak, beban statis ≈ berat
- akselerasi 0 → >20 m/s dalam 4 s, mobil maju di sumbu +Z
- pengereman dari ±30 m/s berhenti < 4,5 s, dan rem **tidak pernah** mendorong mobil mundur
- rem ditekan dari posisi diam: mobil tetap di tempat dan gigi tetap D
- setir `+1` (D) belok ke kanan mobil (Δyaw negatif) dan `-1` (A) ke kiri
- handbrake membuat rear step out (drift > 8°)
- gigi R: gas mendorong mundur, top speed ≤ `reverseMaxSpeed`, rem tetap berfungsi
- R ditolak saat mobil masih melaju, dan masuk sendiri setelah berhenti
- jatuh dari 6 m: mendarat dan tidak terbalik
- determinisme: dua run identik → state akhir identik
- `buildTrackColliders()` jalan tanpa DOM, ramp melontarkan mobil lalu mendarat tegak

`npm run check:browser` (opsional, perlu Chromium) menambah cek UI: bukaan gas/rem 1:1 (50 %, 85 %, 70 %), gas dan rem saling independen, rem tidak menambah throttle, semuanya menutup saat dilepas, slider setir balik ke tengah, tombol D/R memindah gigi + HUD menampilkan `R` saat mundur, rem tidak membalikkan mobil, dan arah setir cocok dengan layar. Untuk detail visual: lampu rem menguat saat pedal ditekan, sein kiri berkedip sementara kanan tetap mati, repeater HUD menyala, lampu utama menyala, lampu mundur menyala di gigi R, empat hub suspensi berada di rentang travel, dan setir berputar.

Status terakhir: **semua lolos**.

## Batasan / langkah berikutnya

1. **Track sungguhan** — heightmap/trimesh + spline, bukan plane datar (layout-nya sekarang sudah berupa data, jadi tinggal ganti sumbernya).
2. **Efek** — debu, skidmark, suara mesin (WebAudio), kamera shake.
3. **AI lawan** — racing line + Pure Pursuit + speed profile dari kurvatur (lihat diskusi awal).
4. **Multiplayer** — Rapier headless di server (kode fisika sudah DOM-free).
5. **Optimasi mobile** — instancing, LOD, KTX2, shadow hanya untuk mobil.

## Catatan lingkungan

- `typescript` dipin ke **5.x** — TS 7 (native) belum punya binary Android ARM64.
- `npm run check:browser` butuh Chromium. Di Termux: `CHROME_BIN=$PREFIX/bin/headless_shell npm run check:browser` (setelah `npm run build` + `npm run preview` di port 4173). CI hanya menjalankan `check`, `smoke`, dan `build`.
- Headless SwiftShader di Android kehilangan konteks WebGL setelah ~1 detik. Itu batasan environment; script cek render lewat jumlah draw call/triangle, bukan pixel.
