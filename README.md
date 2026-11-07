# RallyCross — Vehicle Physics Prototype

Prototipe **mobil rally 3D di web** (three.js + Rapier): fisika chassis + suspensi raycast, model Honda Civic EG6, dan satu **arena rallycross lengkap** — sirkuit campuran aspal/gravel 478 m dengan dua lompatan, joker lap, grandstand, dan race control, plus **AI autopilot** yang bisa menyetir sendiri (termasuk joker lap) dan **satu lawan AI** yang balapan 3 lap melawan kamu (bisa dimatikan dari panel). Belum ada multiplayer.

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
| Panel tuning | `G` | tombol **⚙** (kiri atas) |
| **AI autopilot on/off** | `P` | tombol **AI** (kiri atas) |
| Ulangi balapan (grid + lap) | `R` | — |

Cara kerjanya:

- **Slider setir** 1:1 dengan jari (geser sedikit = belok dikit). Lepas → kembali ke tengah dengan spring halus.
- **Slider gas & rem** vertikal: posisi jari = besar bukaan (0–100 %), bisa ditahan di 30 %, 60 %, berapa pun. Lepas → menutup sendiri. Isi track menunjukkan bukaan saat ini.
- **Keyboard** tetap di-ramp (`KEY_GAS_ATTACK` / `KEY_STEER_ATTACK` di `src/input.ts`), jadi tap `D`/`W` sebentar = input kecil; tahan = penuh.
- **Gas dan rem itu dua pedal terpisah** (`throttle: 0..1`, `brake: 0..1`). Rem hanya memperlambat, tidak pernah membuat mobil mundur, dan tidak bisa meniadakan gas — kalau dua-duanya ditekan, rem menang karena gaya rem > gaya mesin.
- **Gigi mundur manual.** Tekan `Q` (atau tombol D/R di layar) untuk pindah D ⇄ R. Gigi hanya mau masuk saat mobil hampir berhenti (`shiftSpeedLimit`, default 1,5 m/s), persis gearbox manual: menekan R di tengah lintasan tidak membalik arah mobil. Setelah masuk R, gas mendorong mundur dan dibatasi `reverseMaxSpeed` (12 m/s ≈ 43 km/h). HUD menampilkan `D`/`R` yang benar-benar aktif.
- Nilai yang dikirim ke fisika cuma `throttle`, `brake`, `steer`, `handbrake`, dan `gear`; tuning kontrol tidak menyentuh `VehiclePhysics`.

Panel lil-gui di kanan atas berisi semua parameter handling + preset **Tarmac / Gravel / Ice**. Semua perubahan langsung terasa (live), tanpa reload.

> Debug handle: `window.rc` → `{ car, world, cfg, input, pilot, auto, setAutopilot, cameraRig, renderer, scene, snap() }`.

## Struktur

```
src/
├─ main.ts                  # renderer, scene, loop tetap 60 Hz, GUI, presets
├─ vehicle/
│  ├─ VehiclePhysics.ts     # SEMUA fisika kendaraan (tidak butuh DOM)
│  ├─ CarModelVisual.ts     # GLB Honda Civic: roda, lampu, skala ke fisika
│  ├─ CarVisual.ts          # bodi prosedural (fallback kalau GLB gagal)
│  ├─ CarSuspension.ts      # per roda: wishbone, tie rod, coilover, rem
│  ├─ CarLights.ts          # lampu rem, sein, mundur, lampu utama
│  └─ carParts.ts           # material + helper geometri (link, pegas)
├─ world/circuit.ts         # geometri sirkuit: node, sampling, ribbon (tanpa DOM)
├─ world/track.ts           # arena rallycross
│  ├─ buildTrackColliders() # permukaan + barrier + joker — tanpa DOM
│  └─ ...
│ src/race/                # LapCounter (odometer) + Rival (mobil AI kedua)
│ src/ai/AutoPilot.ts      # pure pursuit + speed profile + pemulihan
│  └─ buildTrackVisuals()   # mesh, tekstur canvas, gantry, stand — hanya browser
├─ camera.ts                # chase / hood cam + FOV dinamis
├─ input.ts                 # slider setir/gas/rem analog + gigi D/R + sein/lampu
├─ hud.ts                   # speedo, gear D/R, beban per roda, drift
└─ style.css
public/models/
├─ honda-civic-eg6.glb      # model bodi mobil (CC BY 4.0, lihat CREDITS.md)
└─ CREDITS.md               # atribusi + daftar perubahan model
scripts/
├─ smoke.ts                 # test fisika headless (Node + Rapier, tanpa render)
└─ browser-check.mjs        # opsional: cek render/console di Chromium headless
.github/workflows/ci.yml    # check + smoke + build di setiap push
```

`VehiclePhysics.ts` dan `buildTrackColliders()` sengaja **tidak menyentuh DOM/renderer**, jadi bisa dijalankan di Node (lihat `scripts/smoke.ts`, termasuk uji lompatan di trek asli) — penting kalau nanti mau server-authoritative multiplayer atau training AI.

## Arena rallycross

Satu putaran 478 m, searah jarum jam, garis start/finish di `(0, 0)` menghadap `+Z`:

| Bagian | Isi |
| --- | --- |
| Main straight | 92 m, grid 6 kotak, gantry + 5 lampu start, grandstand + race control di sisi luar |
| T1 | kanan sedang, keluar ke straight gravel atas |
| Gravel-out | ±55 m gravel, ada *bump* (yump) 0,55 m |
| T2 | kanan cepat; **joker lap** memotong di dalamnya (gravel, ±2,5 m lebih pendek tapi lebih lambat) |
| JUMP 1 | lompatan aspal di straight timur, crest 1,35 m, lip pendek — mobil terbang ±1 s |
| T3 + gravel-in | kanan, lalu 60 m gravel dengan JUMP 2 (crest 1,30 m) |
| Flick + final corner | dua belokan lambat menuju garis start |

Permukaan: aspal μ = 1,00, gravel μ = 0,62, rumput μ = 0,55. Barrier keliling solid setinggi pagar pengaman (3,4 m) supaya mobil tidak bisa terlempar keluar arena; ban bekas, kerb merah-putih, banner sponsor, 6 tiang lampu, paddock (tenda + truk servis) ada di infield, dan 190 pohon mengelilingi venue.

Fisika dapat berhenti di tanjakan: rem parkir (`applyParkingHold`) menahan mobil yang sudah diam di landai sampai ±30 % (selama gas dan rem dilepas), tanpa mengganggu pedal gas/rem.

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
- **Static friction / anti-creep**: impuls gesek satu step dibatasi oleh kecepatan slip di titik kontak (`|F|·dt ≤ |v_slip|·m_contact`). Ban boleh menghentikan tapak, tapi tidak boleh mendorongnya balik. Tanpa batas ini, integrasi eksplisit 60 Hz bisa overshoot dan masuk limit cycle: mobil diam di batas patch gravel/ice bergeser ±0.23 m dalam 6 detik sambil angka *grip* di HUD berkedip 55–100 %. Sekarang 0.0 cm dan 0 %.

**Aero**
- Drag `0.55·v²`, downforce `1.2·v²` di titik COM.

## Mobil & detail visual

Bodi mobilnya sekarang **model 3D sungguhan**: Honda Civic EG6 (CC BY 4.0) di
`public/models/honda-civic-eg6.glb`, dimuat dengan `GLTFLoader` dan
dipasang ke mobil fisika oleh `CarModelVisual.ts`. Atribusi lengkap + daftar
perubahan ada di [`public/models/CREDITS.md`](public/models/CREDITS.md).

- **Skala otomatis** — model diskalakan dari jarak sumbu rodanya supaya pas
  dengan `wheelBaseHalf` di fisika; tinggi ban diukur dari bounding box roda,
  jadi keempat ban menyentuh bidang tanah yang sama dengan suspensi (tidak
  melayang, tidak amblas).
- **Ride height ikut suspensi, bukan pose kosong** — model dipasang untuk posisi
  mobil *setelah* pegas tertekan berat sendiri (`suspensionRest − m·g/4k`), dan
  tiap frame posisi ban dihitung dari `suspLength` hasil raycast. Jadi ban
  selalu menempel di tanah berapa pun setelan `suspensionRest`/`springK` di
  panel tuning, dan ban tidak naik ke dalam rumah roda saat shock bekerja
  (sisa ruang ke fender ±154 mm saat diam).
- **Roda tetap hidup** — empat node roda model di-*re-parent* ke pivot kemudi
  dan pivot putaran, lalu tiap frame mengikuti `steerAngle`, `spinAngle`, dan
  `suspLength` per roda, termasuk gerak naik/turun saat suspensi terkompresi.
- **Lampu dari model itu sendiri** — mesh lampu bawaan model dibelah kiri/kanan
  di index buffer, jadi lampu rem, lampu posisi, sein, lampu mundur, dan lampu
  utama menyala di bentuk lampu aslinya (plus dua `SpotLight` untuk sorot
  lampu utama, dimatikan di `?quality=low`).
- **Cat bisa diganti** — default putih `#dfe4e8`; coba `?paint=e23b2e`,
  `?paint=1f3fbf`, dan seterusnya.
- **Fallback** — kalau GLB gagal dimuat, `CarVisual.ts` (bodi prosedural lama)
  tetap dipakai, jadi game tidak pernah kehilangan mobil.

Logika lampu yang sama dipakai kedua jalur: `LampController` di
`CarLights.ts` mengubah input pengemudi (pedal rem, gigi, sein, saklar lampu)
jadi intensitas lampu — rem menguat dengan lerp 14/s, sein berkedip 0.42 s
nyala / 0.42 s mati dan restart saat pilihan berubah, lampu mundur mengikuti
gigi R, dan repeater ◀ ▶ ◐ di HUD ikut berkedip.

**Material & performa**
- `PMREMGenerator` + `RoomEnvironment` memberi environment map supaya cat
  metalik, kaca, dan krom model terbaca (dilewati di `?quality=low`).
- Model: 39 mesh / ±18 ribu triangle, 250 KB, satu tekstur JPEG (lampu + plat
  nomor); bodi prosedural fallback: 132 mesh / ±37 ribu triangle.

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

## AI autopilot

Tekan `P` — **di HP: tombol `AI` di kiri atas layar** (di sebelah tombol sein) — atau centang **AI mengemudi** di folder *Autopilot* pada panel, dan mobil menyetir sendiri. Panel tuning juga bisa dibuka di HP lewat tombol `⚙` di baris yang sama, jadi pilihan *joker lap* dan *kecepatan lompatan* tetap bisa diubah tanpa keyboard. Di HP, menyentuh kontrol setir/gas/rem langsung mengambil alih dari AI (tombol **AI** menyala = AI yang nyetir). AI-nya bukan animasi: ia mengirim `VehicleInput` yang sama persis dengan keyboard ke `VehiclePhysics`, jadi fisika, ban, suspensi, dan lompatan tetap berjalan apa adanya — AI bisa melebar, bisa salah, dan bisa diambil alih kapan saja (`P` lagi = pemain yang setir).

Cara kerjanya (`src/ai/AutoPilot.ts`, murni matematika, tanpa DOM):

- **Garis balap** — AI memakai sample sirkuit yang sama dengan pembangun trek. `lapPath()` menyambung garis utama + joker jadi satu lintasan dengan jarak yang tetap menaik, jadi AI cukup punya satu "lap" untuk dua rute.
- **Setir** — *pure pursuit*: cari titik 6 + 0,8·v meter di depan, hitung lengkung yang dibutuhkan (`κ = 2·sin α / L`), lalu terjemahkan ke sudut roda memakai geometri setir mobil (basis roda 2,64 m, batas 34°, `steerFalloff`). Ini skala otomatis: sama stabilnya di 10 km/h dan 100 km/h, dan gain lengkung 1,5 dipakai untuk menutup *understeer* di gravel.
- **Kecepatan** — per sample di depan (horizon sampai 110 m) dihitung batas `√(grip / κ)` menurut permukaan (aspal 8,0 m/s², gravel 5,2 m/s²), lalu tiap batas dikonversi jadi "kecepatan sekarang yang masih bisa berhenti di sana" (`√(v² + 2·a·s)`). Nilai terkecil yang dipakai. Tanjakan > 9 % dianggap lompatan dan dibatasi `jumpSpeed` (19 m/s).
- **Melebar** — kalau mobil keluar > 55 % lebar trek, target kecepatan dipotong supaya sempat kembali ke garis.
- **Macet / terbalik** — diam < 1,2 m/s selama 1,6 s → mundur sebentar lalu maju lagi; terbalik (up < 0,35) selama 2,5 s → minta reset.
- **Joker** — pilihan joker dievaluasi ulang tiap putaran (checkbox *joker lap*), dan HUD menampilkan status AI + lap + waktu lap/best.

Hasil uji headless dengan fisika asli: **satu putaran 29,2 s**, tidak pernah keluar tepi trek, 0 reset, dan stabil di 6 putaran berturut-turut (aspal & gravel, dengan/tanpa joker).

## Lawan AI (1 mobil)

Di grid selalu ada **mobil kedua berwarna merah** yang kamu lawan balapan **3 lap** (jumlahnya bisa diubah di panel → *Lawan*). Lawan memakai `VehiclePhysics` yang sama — ban, suspensi, lompatan, dan tabrakan diperlakukan sama seperti mobilmu, jadi tidak ada hax:

- **Garis sendiri.** `AutoPilot` bisa menggeser seluruh garis balapnya ke samping (`laneOffset`), bukan cuma titik tujuannya. Lawan mengambil lajur kiri 2 m, jadi dua mobil tidak berebut potongan aspal yang sama.
- **Tidak menabrak dari belakang.** Kalau ada mobil < 18 m di depan dalam kerucut pandang, target kecepatannya dipotong mengikuti kecepatan mobil itu (`kecepatan lawan + (jarak − 6) × 1,6`). Lawan yang mengejar mobil yang sedang berhenti berhenti sendiri, bukan menabrak.
- **Putaran dihitung di garis start**, bukan di ujung data spline: `LapCounter` memakai odometer yang tidak pernah wrap, jadi mobil yang mundur melewati garis tidak menambah/mengurangi lap secara salah.
- **Terbalik / terlempar** → kembali ke garis balap (bukan ke grid) menghadap arah putaran.
- Badge **LAWAN** di HUD menunjukkan lap dan selisih jarak (hijau = kamu di depan, merah = lawan di depan). Selesai 3 lap → banner `FINISH · KAMU MENANG` / `LAWAN MENANG`; `R` mengulang dari grid.

Hasil uji headless: lawan menyelesaikan putaran **33,2 s** (kamu 31,1 s), tidak pernah keluar trek, dan jarak terdekat dua mobil sepanjang balapan **8,7 m** (tidak pernah saling tembus).

Agar AI bisa secepat itu, tepi trek juga diperbaiki: bahu jalan sekarang punya **bahu datar 2,6 m** di ketinggian aspal sebelum turun ke rumput, jadi roda yang melebar di bibir lompatan tidak lagi menghantam "tebing" dan berhenti mendadak. Joker juga keluar-masuk secara tangensial (bukan kink 40°) supaya mobil tidak terlempar ke pagar saat menyatu kembali.

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
- jalur lap (utama + joker) punya jarak yang monoton dan joker memang lebih pendek
- **AI menyelesaikan satu putaran sendiri** (29 s), tidak keluar tepi trek, tanpa reset
- penghitung lap menambah tepat satu lap per putaran, odometer cocok dengan panjang trek
- **lawan AI menyelesaikan putaran** (33 s), tetap di trek, dan dua mobil tidak saling menembus

`npm run check:browser` (opsional, perlu Chromium) menambah cek UI: bukaan gas/rem 1:1 (50 %, 85 %, 70 %), gas dan rem saling independen, rem tidak menambah throttle, semuanya menutup saat dilepas, slider setir balik ke tengah, tombol D/R memindah gigi + HUD menampilkan `R` saat mundur, rem tidak membalikkan mobil, dan arah setir cocok dengan layar. Untuk detail visual: lampu rem menguat saat pedal ditekan, sein kiri berkedip sementara kanan tetap mati, repeater HUD menyala, lampu utama menyala, lampu mundur menyala di gigi R, empat hub suspensi berada di rentang travel, dan setir berputar.

Status terakhir: **semua lolos**.

## Batasan / langkah berikutnya

1. **Track sungguhan** — heightmap/trimesh + spline, bukan plane datar (layout-nya sekarang sudah berupa data, jadi tinggal ganti sumbernya).
2. **Efek** — debu, skidmark, suara mesin (WebAudio), kamera shake.
3. **AI lawan** — beberapa mobil sekaligus (autopilot-nya sudah ada; tinggal `AutoPilot` + `VehiclePhysics` per mobil, plus logika menyalip).
4. **Multiplayer** — Rapier headless di server (kode fisika sudah DOM-free).
5. **Optimasi mobile** — instancing, LOD, KTX2, shadow hanya untuk mobil.

## Catatan lingkungan

- `typescript` dipin ke **5.x** — TS 7 (native) belum punya binary Android ARM64.
- `npm run check:browser` butuh Chromium. Di Termux: `CHROME_BIN=$PREFIX/bin/headless_shell npm run check:browser` (setelah `npm run build` + `npm run preview` di port 4173). CI hanya menjalankan `check`, `smoke`, dan `build`.
- Headless SwiftShader di Android kehilangan konteks WebGL setelah ~1 detik. Itu batasan environment; script cek render lewat jumlah draw call/triangle, bukan pixel.
