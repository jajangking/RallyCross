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
| Rem / mundur (bukaan 0–100 %) | `S` / `↓` | slider vertikal REM |
| Setir (1:1) | `A` `D` / `←` `→` (di-ramp) | slider horizontal SETIR |
| Handbrake | `Space` | HB |
| Reset mobil | `R` | — |
| Ganti kamera (chase/hood) | `C` | — |
| Panel tuning | `G` | — |

Cara kerjanya:

- **Slider setir** 1:1 dengan jari (geser sedikit = belok dikit). Lepas → kembali ke tengah dengan spring halus.
- **Slider gas & rem** vertikal: posisi jari = besar bukaan (0–100 %), bisa ditahan di 30 %, 60 %, berapa pun. Lepas → menutup sendiri. Isi track menunjukkan bukaan saat ini.
- **Keyboard** tetap di-ramp (`KEY_GAS_ATTACK` / `KEY_STEER_ATTACK` di `src/input.ts`), jadi tap `D`/`W` sebentar = input kecil; tahan = penuh.
- Gas dan rem bisa ditekan bersamaan; hasilnya `throttle = gas - rem` (saling meniadakan).
- Nilai yang dikirim ke fisika cuma `throttle: -1..1` dan `steer: -1..1`; tuning kontrol tidak menyentuh `VehiclePhysics`.

Panel lil-gui di kanan atas berisi semua parameter handling + preset **Tarmac / Gravel / Ice**. Semua perubahan langsung terasa (live), tanpa reload.

> Debug handle: `window.rc` → `{ car, world, cfg, input, cameraRig, renderer, scene, snap() }`.

## Struktur

```
src/
├─ main.ts                  # renderer, scene, loop tetap 60 Hz, GUI, presets
├─ vehicle/
│  ├─ VehiclePhysics.ts     # SEMUA fisika kendaraan (tidak butuh DOM)
│  └─ CarVisual.ts          # mesh chassis + 4 roda (visual saja)
├─ world/track.ts           # ground, ramp, washboard, cone, gravel, ice
├─ camera.ts                # chase / hood cam + FOV dinamis
├─ input.ts                 # slider setir/gas/rem analog + keyboard
├─ hud.ts                   # speedo, gear, beban per roda, drift
└─ style.css
scripts/
├─ smoke.ts                 # test fisika headless (Node + Rapier, tanpa render)
└─ browser-check.mjs        # opsional: cek render/console di Chromium headless
```

`VehiclePhysics.ts` sengaja **tidak menyentuh DOM/renderer**, jadi bisa dijalankan di Node (lihat `scripts/smoke.ts`) — penting kalau nanti mau server-authoritative multiplayer atau training AI.

## Model fisika

**Chassis**
- Rigid body dinamis, box `1.84 × 0.68 × 4.1 m`, massa **1250 kg**.
- Massa & inersia di-set eksplisit di collider (`setMassProperties`), center of mass **0.30 m di bawah** titik geometris → susah kebalik.
- CCD aktif (kecepatan tinggi), `canSleep = false`.

**Suspensi (per roda, raycast)**
- Ray dari anchor roda ke bawah sepanjang `rest + radius`.
- `F_spring = k · compression + c · v_down` — damper **menambah** gaya saat kompresi (tanda ini pernah jadi bug anti-damping, sudah diperbaiki dan dijaga oleh smoke test).
- Anti-roll bar depan/belakang: transfer beban berdasarkan selisih kompresi kiri/kanan.
- Default: `k = 30 kN/m`, `c = 2.6 kN·s/m`, rest 0.34 m.

**Ban**
- Slip angle `α = atan2(v_lat, |v_long| + 0.9)`.
- Gaya lateral linear sampai `peakSlipDeg` (9°), lalu turun perlahan (`driftFalloff`) → drift terkontrol, bukan cengkeraman tak terbatas.
- Gaya longitudinal: engine (AWD split 42/58), rem, rolling resistance, handbrake.
- **Friction circle**: `√(Fx² + Fy²) ≤ μ·Fz`. Karena `Fz` datang dari kompresi suspensi, load transfer terjadi otomatis.
- `μ` dikali **friction collider** yang kena raycast → patch gravel (0.62) dan ice (0.28) di scene benar-benar mengubah grip.

**Aero**
- Drag `0.55·v²`, downforce `1.2·v²` di titik COM.

**Loop**
- Fisika fixed **1/60 s** + accumulator (maks 5 substep), render interpolasi pose setelah `world.step()`.
- Stabil & deterministik: input yang sama → hasil yang sama (dasar untuk replay/netcode nanti).

## Tuning cepat

| Parameter | Efek |
|---|---|
| `springK` / `damperC` | keras/lembut & redaman. Damper terlalu kecil → mobil memantul. |
| `antiRollFront/Rear` | kurangi body roll; belakang lebih kaku → cenderung oversteer. |
| `muFront` / `muRear` | `muRear < muFront` → oversteer/drift; sebaliknya understeer. |
| `peakSlipDeg` | titik puncak grip. Kecil = ban "licin", besar = forgif. |
| `driftFalloff` | seberapa cepat grip hilang setelah puncak. |
| `frontSplit` | 0 = RWD, 1 = FWD, 0.42 = AWD condong belakang. |
| `comY` | makin negatif = makin anti-kebalik, tapi makin "aneh" saat roll. |
| `steerFalloff` | pengurangan sudut setir di kecepatan tinggi. |

Preset ada di panel GUI; `Copy config` menyalin JSON config ke clipboard untuk disimpan sebagai default baru.

## Verifikasi

`npm run smoke` menjalankan fisika yang sama di Node dan mengecek:

- massa body = 1250 kg
- ride height stabil (~0.92 m), 4 roda kontak, beban statis ≈ berat
- akselerasi 0 → >20 m/s dalam 4 s, mobil maju di sumbu +Z
- pengereman 26 → 7 m/s dalam 2 s
- setir `+1` (D) belok ke kanan mobil (Δyaw negatif) dan `-1` (A) ke kiri
- handbrake membuat rear step out (drift > 8°)
- jatuh dari 6 m: mendarat dan tidak terbalik

`npm run check:browser` (opsional, perlu Chromium) menambah cek UI: bukaan gas/rem 1:1 (50 %, 85 %, 70 %), gas+rem saling meniadakan, semuanya menutup saat dilepas, slider setir balik ke tengah, dan arah setir cocok dengan layar.

Status terakhir: **semua lolos**.

## Batasan / langkah berikutnya

1. **Track sungguhan** — heightmap/trimesh + spline, bukan plane datar.
2. **Efek** — debu, skidmark, suara mesin (WebAudio), kamera shake.
3. **AI lawan** — racing line + Pure Pursuit + speed profile dari kurvatur (lihat diskusi awal).
4. **Multiplayer** — Rapier headless di server (kode fisika sudah DOM-free).
5. **Optimasi mobile** — instancing, LOD, KTX2, shadow hanya untuk mobil.

## Catatan lingkungan

- `typescript` dipin ke **5.x** — TS 7 (native) belum punya binary Android ARM64.
- `npm run check:browser` butuh Chromium. Di Termux: `CHROME_BIN=$PREFIX/bin/headless_shell npm run check:browser` (setelah `npm run build` + `npm run preview` di port 4173).
- Headless SwiftShader di Android kehilangan konteks WebGL setelah ~1 detik. Itu batasan environment; script cek render lewat jumlah draw call/triangle, bukan pixel.
# RallyCross
# RallyCross
