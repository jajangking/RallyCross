# RallyCross — Vehicle Physics Prototype

Prototipe **mobil rally 3D di web** (three.js + Rapier) dengan gaya **kartun sinematik** (cel shading, bayangan matahari asli, langit berlapis, tribun penuh penonton): fisika chassis + suspensi raycast, model Honda Civic EG6, dan satu **arena rallycross lengkap** — sirkuit campuran aspal/gravel 478 m dengan dua lompatan, joker lap, grandstand, dan race control, plus **AI autopilot**, **grid 6 mobil** (kamu + 5 lawan AI) yang balapan 10 lap, **jejak ban + asap/debu** dari ban yang benar-benar selip, papan klasemen langsung, **9 kamera TV** di pinggir trek untuk menonton pertandingan AI vs AI, dan **helikopter siaran** yang gambar udaranya ikut masuk ke siaran TV. Belum ada multiplayer.

## Jalanin

```bash
npm install
npm run dev        # buka http://localhost:5173
```

Di Android/Termux: jalankan `npm run dev`, lalu buka `http://localhost:5173` di Chrome HP. Tambah `?quality=low` kalau GPU-nya lemah (pixel ratio 1x, tanpa anti-alias, pohon lebih sedikit); `?quality=high` memaksa detail. Di HP kecil, mode ringan dipilih otomatis.

```bash
npm run build      # type-check + bundle
npm run preview    # serve hasil build
npm run smoke      # test fisika headless (tanpa browser)
npm run shot       # render PNG scene ke shots/ tanpa browser/WebGL
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
| Reset mobil (**sekaligus perbaikan total**) | `R` | — |
| Ganti kamera (chase → kap → TV) | `C` | — |
| Tonton **AI vs AI** — 6 mobil, kamera TV | `V` | tombol **TV** (kiri atas) |
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
│  ├─ Damage.ts             # kerusakan: bodi, mesin, ban pecah/copot (tanpa DOM)
│  ├─ CarDamageVisual.ts    # penyok di bodi + roda yang copot
│  ├─ CarSuspension.ts      # per roda: wishbone, tie rod, coilover, rem
│  ├─ CarLights.ts          # lampu rem, sein, mundur, lampu utama
│  └─ carParts.ts           # material + helper geometri (link, pegas)
├─ world/
│  ├─ style.ts              # gaya kartun: cel shading, langit, bayangan blob
│  ├─ circuit.ts            # geometri sirkuit: node, sampling, ribbon (tanpa DOM)
│  └─ track.ts              # arena rallycross
│     ├─ buildTrackColliders() # permukaan + barrier + joker — tanpa DOM
│     └─ buildTrackVisuals()   # mesh, tekstur canvas, gantry, stand — hanya browser
├─ race/
│  ├─ LapCounter.ts         # odometer + lap (tanpa DOM)
│  ├─ Rival.ts              # mobil AI: pilot + fisika + rescue kalau macet
│  ├─ grid.ts               # lima rencana lawan + posisi grid
│  └─ Standings.ts          # klasemen + papan rekor lap (localStorage)
├─ ai/AutoPilot.ts          # pure pursuit + profil kecepatan + menyalip + pemulihan
├─ fx/
│  ├─ SkidMarks.ts          # jejak ban (satu mesh, ring buffer)
│  ├─ Smoke.ts              # asap & debu (satu Points, kolam tetap)
│  └─ CarEffects.ts         # pemicu efek dari state ban
├─ camera/                  # BroadcastDirector: sutradara kamera TV
├─ camera.ts                # chase / hood cam + FOV dinamis
├─ input.ts                 # slider setir/gas/rem analog + gigi D/R + sein/lampu
├─ hud.ts                   # speedo, gear D/R, beban per roda, kerusakan, klasemen
└─ style.css
public/models/
├─ honda-civic-eg6.glb      # model bodi mobil (CC BY 4.0, lihat CREDITS.md)
└─ CREDITS.md               # atribusi + daftar perubahan model
scripts/
├─ smoke.ts                 # test fisika headless (Node + Rapier, tanpa render)
├─ preview.ts               # rasterizer kecil: render scene ke PNG tanpa WebGL
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
- Rigid body dinamis, **rounded box** ±0,74 × ±0,16 × ±1,87 m (sudut radius 0,18 m), massa **1250 kg**. Bentuknya sengaja dibuat bulat dan licin (friction 0,12): bodi hanya dipakai untuk menabrak pagar dan kalau mobil terbalik — roda yang menopang mobil. Dengan kotak bersudut tajam, bibir lompatan dan crease pendaratan menyangkut di sudut bodi dan mobil langsung berhenti seperti "nabrak trek".
- Massa & inersia di-set eksplisit di collider (`setMassProperties`), center of mass **0.30 m di bawah** titik geometris → susah kebalik.
- CCD aktif (kecepatan tinggi), `canSleep = false`.

**Suspensi (per roda, raycast)**
- Ray dari titik **0,7 m di atas anchor** roda, ke bawah sepanjang `lift + rest + radius`.
  Ray sengaja dimulai lebih tinggi: kalau dimulai tepat di anchor, pendaratan
  keras yang menenggelamkan bodi membuat pangkal ray ada di *bawah* permukaan →
  tidak ada hit, tidak ada gaya pegas, dan mobil tertinggal menempel di perutnya.
- `F_spring = k · compression + c · v_down` — damper **menambah** gaya saat kompresi (tanda ini pernah jadi bug anti-damping, sudah diperbaiki dan dijaga oleh smoke test).
- Damper **digressive**: di atas `damperBlowoff` (1,4 m/s) gaya damper hanya naik
  sepertiga (`damperHighScale` 0,35), dan totalnya dibatasi `springForceMax`
  (16 kN per roda). Linear tanpa batas membuat pendaratan 7 m/s menghasilkan
  5–8× berat mobil → mobil terpental naik lagi.
- Gaya suspensi didorong searah **normal kontak**, bukan sumbu atas bodi, jadi ramp dan permukaan miring menopang mobil dengan benar.
- Anti-roll bar depan/belakang: transfer beban berdasarkan selisih kompresi kiri/kanan.
- Default: `k = 30 kN/m`, `c = 2.6 kN·s/m`, rest 0,40 m (langkah pegas lebih panjang
  = pendaratan lompatan ditelan suspensi, bukan diteruskan ke bodi).

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
  utama menyala di bentuk lampu aslinya. Lampu sorot 3D (`SpotLight`) sudah
  dihapus: enam mobil × dua lampu = 12 lampu yang harus dihitung setiap
  fragment, dan gaya kartun cukup dengan lampu yang menyala (emissive).
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
- Semua material — trek, props, bodi mobil, termasuk material bawaan model GLB —
  diganti `MeshToonMaterial` dengan satu gradasi 4 langkah bersama
  (`src/world/style.ts`). Cat bodi juga ikut warna livery per mobil.
- Model: 39 mesh / ±18 ribu triangle, 250 KB, satu tekstur JPEG (lampu + plat
  nomor); bodi prosedural fallback: 132 mesh / ±37 ribu triangle.

**Loop**
- Fisika fixed **1/60 s** + accumulator (maks 5 substep), render interpolasi pose setelah `world.step()`.
- Deterministik: input yang sama → hasil yang sama. Dijaga oleh test determinisme di `npm run smoke` (dua run identik harus menghasilkan state akhir yang sama persis) — dasar untuk replay/netcode nanti.

## Tuning cepat

| Parameter | Efek |
|---|---|
| `springK` / `damperC` | keras/lembut & redaman. Damper terlalu kecil → mobil memantul. |
| `damperBlowoff` / `damperHighScale` | damper digressive: di atas kecepatan ini gaya tidak naik linear lagi. Kecil = pendaratan lembut, tapi suspensi lebih mudah habis langkahnya. |
| `springForceMax` | batas gaya satu roda (N). Terlalu besar → mobil memantul setelah mendarat; terlalu kecil → bodi menyentuh tanah. |
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

### Seberapa cepat AI-nya, sebenarnya?

Ada angka pembandingnya, bukan cuma klaim. Semua diukur headless dengan fisika
yang sama (`scripts/` + `VehiclePhysics`):

| | waktu putaran |
|---|---|
| Batas fisik lintasan (profil kecepatan kuasi-statis, grip aspal 8,4 m/s², rem 9,36 m/s²) | **26,50 s** |
| AI sekarang (satu mobil, 4 lap) | **28,35 s** (+7 %) |
| Setelan lama sebelum dituning | 30,45 s (+15 %) |
| Lawan AI dari grid (5 mobil, saling menyalip) | 31,0–33,4 s |

Tuning-nya bukan tebak-tebakan: 60 kombinasi parameter disapu, lalu 6 kandidat
terbaik diuji 4 lap. Setelan lama bukan cuma lebih lambat — AI-nya juga
**keluar trek sampai 8,4 m** dan sesekali hampir terbalik (`up` = −0,05). Setelan
sekarang: **0 m keluar trek, `up` minimum 0,90**, dan lap terakhir sama cepat
dengan lap terbaik (konsisten, bukan sekali hoki).

Yang **belum** ada (kalau mau naik ke level "tercanggih"):

- **Optimasi garis balap** — sekarang garisnya garis tengah + potongan apex 3 %.
  Garis lengkung-minimum (atau hasil optimasi per tikungan) biasanya masih
  menyimpan 2–4 % waktu.
- **Model dinamika, bukan geometri** — perencana kecepatan memakai `√(grip/κ)`
  (kuasi-statis). Mobil sungguhan bisa lebih cepat karena slip angle & beban
  berpindah; MPC/horizon pendek dengan model ban akan memanfaatkan itu.
- **Prediksi lawan** — menyalip sekarang reaktif (geser lajur kalau ada mobil
  lambat < 12 m). Belum ada perencanaan "kalau saya masuk di sini, dia bakal
  nutup line".
- **Belajar** — tidak ada training/policy. Semua aturan tangan (rule-based).

## AI autopilot

Tekan `P` — **di HP: tombol `AI` di kiri atas layar** (di sebelah tombol sein) — atau centang **AI mengemudi** di folder *Autopilot* pada panel, dan mobil menyetir sendiri. Panel tuning juga bisa dibuka di HP lewat tombol `⚙` di baris yang sama, jadi pilihan *joker lap* dan *kecepatan lompatan* tetap bisa diubah tanpa keyboard. Di HP, menyentuh kontrol setir/gas/rem langsung mengambil alih dari AI (tombol **AI** menyala = AI yang nyetir). AI-nya bukan animasi: ia mengirim `VehicleInput` yang sama persis dengan keyboard ke `VehiclePhysics`, jadi fisika, ban, suspensi, dan lompatan tetap berjalan apa adanya — AI bisa melebar, bisa salah, dan bisa diambil alih kapan saja (`P` lagi = pemain yang setir).

Cara kerjanya (`src/ai/AutoPilot.ts`, murni matematika, tanpa DOM):

- **Garis balap** — AI memakai sample sirkuit yang sama dengan pembangun trek. `lapPath()` menyambung garis utama + joker jadi satu lintasan dengan jarak yang tetap menaik, jadi AI cukup punya satu "lap" untuk dua rute.
- **Setir** — *pure pursuit*: cari titik 6 + 0,8·v meter di depan, hitung lengkung yang dibutuhkan (`κ = 2·sin α / L`), lalu terjemahkan ke sudut roda memakai geometri setir mobil (basis roda 2,64 m, batas 34°, `steerFalloff`). Ini skala otomatis: sama stabilnya di 10 km/h dan 100 km/h, dan gain lengkung 1,5 dipakai untuk menutup *understeer* di gravel.
- **Jarak pandang menyesuaikan tikungan** — kalau 30-an meter ke depan ada tikungan tajam, titik tujuan didekatkan (sampai 45 %). Titik pandang yang jauh pada tikungan sempit membuat garis lurus memotong tikungan: mobil masuk terlalu lebar, lalu panik mengoreksi — inilah yang dulu terasa kaku.
- **Setir diputar bertahap** — perintah setir dibatasi `steerRate` (6 putaran penuh per detik), jadi roda tidak melompat dari lock kiri ke kanan.
- **Menangkap selip** — kalau hidung mobil sudah menyimpang > 30° dari arah jalannya, AI berhenti menjejalkan setir ke titik tujuan (itu justru mempercepat putaran) dan mengarahkan roda ke arah mobil benar-benar meluncur, sambil mengangkat gas. Tanpa ini AI berputar-donat lalu melesat keluar trek.
- **Kecepatan** — per sample di depan (horizon sampai 110 m) dihitung batas `√(grip / κ)` menurut permukaan (aspal 9,0 m/s², gravel 5,6 m/s²), lalu tiap batas dikonversi jadi "kecepatan sekarang yang masih bisa berhenti di sana" (`√(v² + 2·a·s)`, `a` = 8,4 aspal / 5,4 gravel). Nilai terkecil yang dipakai. Tanjakan > 9 % dianggap lompatan dan dibatasi `jumpSpeed` (19 m/s).
- **Gas & rem proporsional** — gas mengikuti selisih ke target (bukan on/off), pedalnya dilembutkan (`pedalRate`), dan rem tidak pernah dipijak penuh saat mobil sudah di luar trek.
- **Di udara** — roda tidak menyentuh tanah, jadi AI melepas gas: roda yang berputar di udara menyentak saat mendarat dan memelintir mobil.
- **Garis balap** — di tikungan, titik tujuan digeser sedikit ke sisi dalam (`lineCut`, 3 % lebar trek) supaya jalurnya terlihat seperti pembalap yang mencari apex. Mobil lawan tidak ikut memotong karena lajurnya sudah digeser `laneOffset`.
- **Melebar** — di luar > 60 % lebar trek target kecepatan dipotong; kalau sudah keluar trek, titik tujuan justru didekatkan dan tarikan garis dimatikan supaya mobil benar-benar berbelok kembali ke garis (titik jauh membuat sudutnya kecil dan mobil malah jalan lurus makin jauh).
- **Menyalip** — kalau ada mobil lebih lambat < 12 m di depan dan jalurnya sudah cukup cepat, AI menggeser **seluruh garisnya** ke sisi yang lapang (maks. selebar ruang yang tersisa), lalu kembali ke garis. Geseran itu dihitung ulang frame-nya: kalau hanya posisi yang digeser, kecepatan tikungan tetap dihitung dari radius garis lama dan mobil keluar trek.
- **Tidak menyalip di tikungan sempit** — kalau lengkung 45 m ke depan > 0,013 (radius < 77 m), AI batal menggeser lajur dan (kalau sedang bergeser) kembali ke garis 2,5× lebih cepat. Pindah lajur sambil berbelok berarti radius yang harus dilalui berubah; di uji 6 mobil inilah penyebab satu-satunya mobil yang keluar trek lalu perlu di-rescue. Setelah aturan ini: **0 rescue, 0 tabrakan, seluruh grid finis**.
- **Macet** — diam < 1,2 m/s selama 1,6 s → mundur sebentar lalu maju lagi.
- **Terbalik / menabrak: tidak ada reset.** Mobil dibiarkan apa adanya — sama sekali tidak ada teleportasi ke garis atau ke grid. AI cuma melepas semua pedal (gas, rem, setir) selama mobilnya miring lebih dari ~69°, lalu langsung lanjut balapan begitu rodanya kembali ke bawah. Satu-satunya pengecualian: mobil yang jatuh di bawah dunia (y < −20, artinya bug fisika, bukan kecelakaan) dikembalikan ke garis.
- **Joker** — pilihan joker dievaluasi ulang tiap putaran (checkbox *joker lap*), dan HUD menampilkan status AI + lap + waktu lap/best.

Hasil uji headless dengan fisika asli: **satu putaran 29,9 s**, tidak pernah keluar tepi trek, 0 reset, dan stabil di 6 putaran berturut-turut (aspal & gravel, dengan/tanpa joker). Diuji juga dari 30 titik start berbeda (offset ±3 m): semuanya menyelesaikan putaran.

## Kamera TV (broadcast)

Ada **9 kamera** tetap di pinggir trek: satu di **luar setiap tikungan** (T1–T8) dan satu menara di **garis start**. Kamera tikungan berdiri di ketinggian 6,5–9 m, di belakang pagar pengaman, jadi mobilnya terlihat datang menghadap kamera lalu lewat — sudut yang dipakai siaran sungguhan.

Kamera **garis start** sengaja dinaikkan ke **15 m** dan digeser 2 m lebih jauh ke luar: di ketinggian 9 m menara itu tertutup atap **tribun utama** (garis pandang ke garis start menembus bangku penonton), sedangkan di 15 m pandangannya bersih. Uji `smoke` memeriksa ini secara geometri — kotak pembatas (OBB, sudah diputar sesuai yaw) tiap tribun dan gedung race control diuji terhadap segmen kamera → titik bidik, jadi kalau ada kamera yang kembali tertutup, build langsung merah.

### Helikopter siaran (salah satu kamera TV)

Sebuah **helikopter** terbang **26 m di atas** mobil yang sedang disorot, mengelilinginya pelan (radius 32 m) sambil menghadap arah terbangnya. Modelnya bukan primitif asal jadi: badan *lathe* membulat dengan kaca depan + kaca samping, boom ekor meruncing, sirip bersayap, rotor ekor di samping sirip, dua skid dengan pipa silang, dek mesin + knalpot, kamera gimbal di dagu, dan dua lampu anti-tabrakan yang berkedip.

**Heli itu bukan mode kamera terpisah — dia bagian dari siaran.** Saat menonton (`V` / kamera TV), sutradara tetap memotong antar kamera darat, lalu **tiap 8–15 detik menyelipkan gambar udara** dari helikopter dan bertahan 4,5–7 detik sebelum kembali ke kamera darat. Overlay HUD menulis `● LIVE · HELI` untuk shot itu. Lensa heli duduk di gimbal dagu dan membidik mobil dengan sedikit "lead" ke arah geraknya, fov 32–58° (menyesuaikan jarak) supaya mobil tetap besar di frame tapi sirkuitnya masih terbaca. Modelnya disembunyikan hanya selama gambar udaranya dipakai; dari kamera chase/kap/darat, heli terlihat terbang di langit arena.

Tekan **`V`** (atau tombol **TV** di HP) untuk **AI vs AI**: mobilmu disetir AI, lawan disetir AI, kameranya pindah ke siaran TV. Tombol **`AI`** mematikan mode ini dan mengembalikan setir (juga kamera) ke pemain.

Cara sutradaranya bekerja (`src/camera/BroadcastDirector.ts`):

- Tiap kamera tahu **jarak tikungannya sepanjang trek**, jadi pemilihan kamera berbasis posisi mobil di lintasan — bukan jarak lurus. Hasilnya gambar berpindah **tikungan demi tikungan**, dan kamera yang sudah dilewati mobil tidak dipakai lagi walaupun dua tikungan kebetulan berdekatan secara geometris.
- Kamera idealnya membidik mobil **±22 m sebelum kamera itu**; plus penalti untuk sudut pandang yang melenceng dan untuk kamera yang mobilnya terlalu jauh (kelihatan kecil di seberang tikungan).
- Gambar dipotong paling cepat **1,6 s** sekali, dengan histeresis supaya tidak berkedip-kedip bolak-balik. Uji simulasi: **16 potongan dalam 2 putaran, memakai 7 kamera berbeda**.
- Saat potong (`cut`) posisi kamera langsung pindah, sementara arah bidiknya dilarutkan halus — persis kesan "ganti kamera" di TV. Lensa otomatis **tele saat mobil jauh** (fov 16°) dan **lebar saat lewat dekat** (62°).
- Overlay **`● LIVE · T3`** muncul saat kamera siaran aktif. Mau lihat semua sudutnya? Panel → *Camera* → **kamera berikutnya** (sutradara otomatis berhenti 6 detik, lalu jalan lagi).
- Di mode tontonan, kamera mengikuti **pemimpin balapan**; kalau kedua mobil berdekatan (< 30 m), titik bidiknya digeser ke tengah supaya duelnya tetap satu frame.

## Grid 6 mobil (5 lawan AI)

Di grid ada **enam mobil**: punyamu + **lima lawan AI** dengan nama dan warna sendiri (Krisna, Bagas, Sari, Damar, Nadia). Balapan **10 lap** (bisa diubah di panel → *Lawan*, 1–20), dan semuanya memakai `VehiclePhysics` yang sama — ban, suspensi, lompatan, dan tabrakan diperlakukan sama seperti mobilmu, jadi tidak ada hax. Yang berbeda cuma pengetahuan garis balap: lajur (`laneOffset` ±0,6/±1,2 m), jarak di grid (18–32 m), dan `pace` 0,97–1,0.

- **Garis sendiri.** `AutoPilot` menggeser *seluruh* garis balap ke samping (`laneOffset`), bukan cuma titik tujuannya, jadi enam mobil tidak berebut potongan aspal yang sama. Garis yang sudah digeser dihitung ulang penuh (tangent, side, dan kelengkungan 7-tap) — tanpa itu, kecepatan tikungan dihitung dari radius garis lama.
- **Saling melihat.** Semua mobil berbagi satu daftar `traffic` (referensi posisi, bukan salinan) yang diperbarui tiap frame. Mobil yang lebih lambat < 12 m di depan memotong target kecepatan (`kecepatan dia + (jarak − 6) × 1,6`), dan mobil sejajar di sisi tujuan menyalip membuat AI memilih sisi lain atau menunggu.
- **Tidak menabrak dari belakang.** Lawan yang mengejar mobil yang sedang berhenti berhenti sendiri, bukan menabrak.
- **Papan klasemen.** HUD kanan atas menampilkan 6 baris: posisi, nama, lap (atau selisih meter terhadap pemimpin), dan lap terbaik. Baris pemain disorot. Urutannya: yang finis dulu, lalu lap, lalu odometer.
- **Rekor lap.** Setiap kali ada mobil (termasuk kamu) mencatat lap tercepat baru, angka itu masuk papan rekor, disimpan di `localStorage` (`rallycross.recordLap.v1`), dan baris **REKOR BARU 30,92s · Bagas** menyala emas selama ~3 detik. Jadi AI memang saling menciptakan rekor, bukan cuma kamu.
- **Putaran dihitung di garis start**, bukan di ujung spline: `LapCounter` memakai odometer yang tidak pernah wrap.
- **Terbalik / terlempar** → dibiarkan, tidak di-reset (lihat bagian AI di atas).
- Selesai 10 lap → banner `FINISH · P1 KAMU` / `FINISH · P1 <nama>`; `R` mengulang dari grid.

Hasil uji headless 6 mobil di trek asli (`LAPS=3`, fisika penuh): **seluruh grid finis dalam 102 s**, jarak terdekat **1,84 m** (0 tabrakan, 0 rescue), lap terbaik 29,92–31,70 s — selisih pemimpin–pemburu cuma 1,8 s. Hasilnya deterministik (dua run identik).

## Efek ban

Untuk setiap mobil (`src/fx/`):

- **Jejak ban** (`SkidMarks.ts`) — satu mesh untuk seluruh arena, buffer quad dipakai bergiliran (6000 potong; 2600 di `?quality=low`). Tiap potong ditarik dari tepi tapak ban frame sebelumnya ke frame sekarang, jadi hasilnya strip kontinu yang mengikuti arah ban — bukan decal yang ditempel per titik. Alpha per titik: di aspal pekat, di gravel/rumput tipis dan berwarna debu. Kalau buffer penuh, potongan tertua yang ditimpa (jejak lama memudar sendiri, tanpa biaya per frame). Upload ke GPU dibatasi ke rentang yang berubah saja.
- **Asap & debu** (`Smoke.ts`) — satu `Points` dengan kolam partikel tetap (480; 220 di low). Partikel lahir dari titik kontak ban, membesar, naik, dan memudar; warna mengikuti jenis permukaan (aspal = asap kelabu, gravel = debu coklat, rumput = debu kehijauan).
- **Pemicunya fisika, bukan animasi** (`CarEffects.ts`) — semuanya dibaca dari `WheelState`: `vLat` (selip lateral), `slipAngle`, `traction` (ban berputar di tempat saat start), `handbrake`, `surfaceMu`, dan `contactPoint`. Jadi handbrake di aspal mengasapi ban belakang, mobil yang melebar ke gravel menyemburkan debu walau tidak selip, dan pendaratan setelah lompatan mengepulkan debu sesuai lama melayang.
- **Anggaran per mobil** (2 kepulan/frame) menjamin enam mobil drifting sekaligus tidak membanjiri kolam partikel. Panel → *Lawan* → **hapus jejak ban** membersihkan sisa goresan.

## Kerusakan mobil

Mobil bisa **penyok, ban pecah, roda copot, dan mesin mati sampai tidak bisa maju
sama sekali** — dan semuanya datang dari tabrakan yang benar-benar terjadi di
fisika, bukan skrip "kecepatan > X maka rusak".

**Sumber kerusakan cuma satu: benturan.** Tiap langkah fisika `VehiclePhysics`
membandingkan kecepatan sekarang dengan kecepatan langkah sebelumnya (Δv),
membuang komponen gravitasi (`+9,81/60` di sumbu Y, jadi jatuh bebas bukan
tabrakan), lalu memutar hasilnya ke kerangka mobil (x = kiri, z = depan).
Δv di atas **2,2 m/s** dikirim ke `VehicleDamage.impact()`.

| Δv | contoh | akibat |
|---|---|---|
| 2–5 m/s | menyenggol pagar, nyangkut di bibir ramp | penyok kecil |
| 8–15 m/s | mendarat keras dari lompatan, menabrak lawan | ban pecah, mesin lemah |
| > 16 m/s (≈ 58 km/h berhenti mendadak) | menabrak beton | bodi parah + **satu roda robek** |

**Yang rusak** (`src/vehicle/Damage.ts` — murni angka, tanpa DOM, jadi bisa diuji
headless dan hasilnya sama persis di browser):

| bagian | efek |
|---|---|
| bodi | 6 tingkat penyok (patch gelap muncul satu per satu), tenaga mesin ikut turun |
| mesin | `engineHealth` turun (benturan dari depan paling parah); **0 = mesin mati**: gas 0 % dan top speed 0 → mobil tidak bisa maju sama sekali |
| ban pecah (health ≤ 0,45) | grip 38 %, drag gulir 3,2×, ban depan yang pecah **menarik setir** ke sisinya dan sudut setir menyusut |
| ban copot (health ≤ 0) | grip 0 dan rodanya hilang dari visual; suspensi di sudut itu tidak menyangga apa pun, jadi mobil miring dan nyeret |

Efeknya masuk ke model gaya yang sudah ada (bukan jalur cheat terpisah):
`applyTireForces` mengalikan `μ` dengan `wheelGrip(i)`, melewati roda yang grip-nya
0 (rodanya tetap menggantung di suspensi, tapi tidak memberi gaya), mengalikan
gaya mesin dengan `throttleScale`, dan membatasi `limit` gigi D dengan
`topSpeedScale`. Setir memakai `steerScale` + `pullSteer`, dan roda yang copot
dilewati di `updateSuspension` (tidak ada raycast, tidak ada gaya pegas).

- **Tidak ada perbaikan otomatis.** Sesuai aturan "biarin aja": mobil yang rusak
  tetap rusak sepanjang balapan (lima detik setelah tabrakan angkanya tidak
  berubah sedikit pun — dijaga smoke test). Pulih hanya lewat `R` (reset ke grid
  = perbaikan total) atau panel → *Kerusakan* → **perbaiki semua mobil**.
- **Pemain dan lawan sama.** Kelima lawan memakai `VehicleDamage` yang sama,
  bukan mobil anti-penyok: kalau saling tabrak, dua-duanya rusak.
- **Visualnya murah.** Penyok = 6 patch gelap (warna cat digelapkan 42 %, jadi
  mobil merah penyoknya merah tua) yang baru muncul saat memang rusak; roda copot
  = mesh roda disembunyikan, kaliper + lengan suspensi tetap ada. Semuanya cuma
  menulis ulang saat `damage.revision` berubah, jadi biaya per frame nol selama
  mobil utuh — `?quality=low` tidak menambah apa pun.
- **HUD** (kiri bawah, hanya muncul kalau rusak): `PENYOK ▮▮▯▯ 41 %`,
  `BAN KANAN DEPAN COPOT`, `MESIN MATI · TIDAK BISA MAJU`, plus kilat teks saat
  kejadiannya (`BAN KIRI DEPAN PECAH!`).
- **Efek**: ban pecah mengeluarkan asap hitam tipis selama mobil jalan, mesin
  mati mengasapi kap mesin.

Setelan di panel → *Kerusakan*: **mobil bisa rusak** (on/off), **tingkat
kerusakan** 0,25–3× (0,5× = tahan banting, 2× = rapuh), dan tombol perbaiki.
Uji cepat dari konsol: `rc.car.damage.impact(0, 0, -22)` dua kali (bodi hancur +
roda copot) atau `rc.car.damage.reset()` untuk perbaiki. Untuk melihat hasilnya
tanpa browser: `npm run shot -- car` → `shots/car-damage.png`.

Yang belum ada: kaca pecah, panel bodi yang lepas, suara benturan, dan api dari
mesin yang mati.

## Gaya kartun & performa render

Seluruh arena sekarang bergaya kartun (`src/world/style.ts`), dan itu sekaligus
cara paling murah untuk merender:

- **Cel shading** — semua material trek, props, dan mobil memakai
  `MeshToonMaterial` dengan satu gradasi **5 langkah** (`NearestFilter`, jadi
  batas terang/gelapnya tegas tapi tidak "pita" kasar). Material bawaan model
  GLB ikut dikonversi saat dimuat (warna, peta, dan transparansinya
  dipertahankan).
- **Shadow map sungguhan, murah** — satu directional light dengan frustum orto
  **±48 m yang mengikuti mobil**, jadi bayangan mobil/tribun/gantry tajam dan
  pass bayangannya tidak pernah selebar arena: hanya **12 mesh / 9.1 ribu
  segitiga** yang dirender ke peta 2048² (2048² desktop, blob di HP lemah).
  `mergeStaticProps` meneruskan `castShadow`/`receiveShadow` mesh asalnya, kalau
  tidak hasil gabungan kehilangan bayangannya.
- **Langit berlapis** — kubah gradasi 4 titik + **sprite matahari**, **dua
  lapis bukit** di horizon (kehijauan berkabut & kebiruan), **awan kartun**
  (instanced, satu draw call), dan **1.100 rumpun rumput** di tepi trek supaya
  tanah tidak terlihat seperti karpet rata.
- **Detail trek** — jalur karet ban dipanggang ke tekstur aspal (bukan overlay
  transparan: nol z-fighting, nol draw call ekstra), tekstur rumput diulang tiap
  30 m (sebelumnya satu petak menutupi 840 m!), dan **±540 penonton 3D** di
  barisan tribun (instanced, 1 draw call per tribun, warna jersey acak).
- **Grade sinematik** — lapisan CSS vignette + hangat di tengah (`#grade`), dan
  tone mapping netral dengan exposure 1,06.
- **Tanpa environment map** — `PMREMGenerator` + `RoomEnvironment` dihapus:
  material toon tidak butuh pantulan, dan render kubah lingkungan saat boot
  termasuk biaya terbesar di HP.
- **Satu directional light** (plus satu hemisphere). Dua `SpotLight` per mobil
  (12 lampu untuk grid 6 mobil) dihapus — setiap fragment harus menghitung
  semuanya, padahal lampu emissive sudah cukup.
- **Draw call digabung** — ~190 mesh kecil (tiang, tribun, spanduk, tiang
  lampu) yang berbagi material digabung jadi satu per material saat trek
  dibangun: **±61 draw call / 68 ribu segitiga** untuk seluruh arena (termasuk
  penonton, rumput, bukit, dan awan yang instanced). Bendera tetap terpisah
  karena dianimasikan per mesh.
- **Kabut & far plane** dipendekkan (120–330 m, kamera 400 m) supaya props di
  kejauhan tidak ikut digambar; **pixel ratio** 2× di desktop, 1,5× di HP, dan
  anisotropi tekstur 4×.
- **Mode ringan otomatis** — di HP (pointer kasar, sisi terpendek < 620 px)
  game mulai tanpa anti-alias, pixel ratio 1×, dan 90 pohon saja.
  `?quality=low` / `?quality=high` memaksa pilihan itu.
- Warna: aspal biru-gelap, gravel pasir hangat, rumput hijau cerah dengan pola
  potong, langit gradasi dengan kubah yang mengikuti kamera.

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
- **AI menyelesaikan satu putaran sendiri** (28,9 s), tidak keluar tepi trek (0 m), tidak pernah terbalik
- mobil terbalik: AI mengirim gas/rem/setir nol (tidak ada reset), lalu menyetir lagi begitu rodanya kembali ke bawah
- material kartun: gradasi cel shading 5 langkah dipakai bersama, `toon()` mengabaikan kunci PBR lama, dan material model GLB jadi toon tanpa kehilangan warna/transparansi
- jejak ban: quad terkumpul, buffer berputar (tidak tumbuh selamanya), bisa dibersihkan, dan mobil yang diam tidak meninggalkan jejak sama sekali; mobil yang selip + handbrake menghasilkan >10 potong jejak dan asap
- asap: partikel lahir, hidup, dan habis sesuai umurnya, semuanya di satu buffer tetap
- papan klasemen: urut finis → lap → odometer, selisih diukur ke pemimpin; papan rekor: lap pertama jadi rekor, lap lebih lambat tidak mencuri rekor, rekor bertahan setelah reload, dan tetap jalan tanpa `localStorage`
- **grid 6 mobil**: lima lawan finis satu putaran, tidak ada yang melebar > 12 m, tidak ada yang berakhir terbalik, jarak terdekat > 1,2 m, dan papan klasemen memuat keenam mobil berurutan
- penghitung lap menambah tepat satu lap per putaran, odometer cocok dengan panjang trek
- **lawan AI menyelesaikan putaran** (31–33 s), tetap di dekat trek, dan dua mobil tidak saling menembus
- 9 kamera TV berdiri di luar trek, sutradara memakai ≥5 kamera berbeda, tidak ada shot < 1,6 s, dan mobil yang dibidik tidak pernah lebih dari 220 m
- **tidak ada kamera TV yang tertutup bangunan**: tiap segmen kamera → titik bidik diuji terhadap kotak pembatas (OBB) tribun utama, tribun kedua, dan race control; kamera garis start juga diperiksa berada di atas atap tribun (> 10 m)
- **kerusakan**: mengemudi normal tidak merusak apa pun; tabrak tembok di 92 km/h → bodi 41 %, mesin 22 %, 1 ban pecah, 1 roda copot; roda copot kehilangan seluruh grip sementara ban pecah masih 29 %; kerusakan **tidak** pulih sendiri selama balapan; mesin mati = bergeser 0,00 m dalam 4 s; reset memperbaiki semuanya; kerusakan bisa dimatikan lewat setelan; setelan 0,5× memangkas kerusakan (bodi 71 % vs 41 %); ban depan pecah menarik setir 2,1°; **dua lap AI tanpa satu pun kerusakan** (tidak ada false positive); dan lima lawan memakai model kerusakan yang sama
- **helikopter**: menjaga jarak 18–40 m dari mobil pada ketinggian > 20 m, ikut mengikuti mobil sepanjang putaran (< 60 m), posisi kameranya valid, dan dalam 90 detik siaran TV ia mendapat ≥ 5 shot udara yang masing-masing 4–7,5 detik (≈ 30 % dari waktu siaran), kameranya menempel di lensa heli, dan tanpa heli siaran tetap 100 % kamera darat

`npm run check:browser` (opsional, perlu Chromium) menambah cek UI: bukaan gas/rem 1:1 (50 %, 85 %, 70 %), gas dan rem saling independen, rem tidak menambah throttle, semuanya menutup saat dilepas, slider setir balik ke tengah, tombol D/R memindah gigi + HUD menampilkan `R` saat mundur, rem tidak membalikkan mobil, dan arah setir cocok dengan layar. Untuk detail visual: lampu rem menguat saat pedal ditekan, sein kiri berkedip sementara kanan tetap mati, repeater HUD menyala, lampu utama menyala, lampu mundur menyala di gigi R, empat hub suspensi berada di rentang travel, dan setir berputar.

Status terakhir: **semua lolos**.

## Batasan / langkah berikutnya

1. **Track sungguhan** — heightmap/trimesh + spline, bukan plane datar (layout-nya sekarang sudah berupa data, jadi tinggal ganti sumbernya).
2. **Suara** — mesin, ban, tabrakan (WebAudio), plus kamera shake.
3. **AI** — strategi joker per lap (sudah ada, belum dioptimalkan), dan menyalip di tikungan sempit (sekarang sengaja dihindari).
4. **Multiplayer** — Rapier headless di server (kode fisika sudah DOM-free).
5. **Optimasi mobile lanjutan** — LOD, KTX2, dan tekstur atlas (draw call sudah ditekan ke ~55 untuk seluruh arena).

## Catatan lingkungan

- `typescript` dipin ke **5.x** — TS 7 (native) belum punya binary Android ARM64.
- `npm run check:browser` butuh Chromium. Di Termux: `CHROME_BIN=$PREFIX/bin/headless_shell npm run check:browser` (setelah `npm run build` + `npm run preview` di port 4173). CI hanya menjalankan `check`, `smoke`, dan `build`.
- Headless SwiftShader di Android kehilangan konteks WebGL setelah ~1 detik. Itu batasan environment; script cek render lewat jumlah draw call/triangle, bukan pixel.
- Tanpa Chromium sama sekali? `npm run shot` merender scene ke PNG dengan rasterizer z-buffer di Node (tekstur diganti warna rata-rata, tanpa kabut/bayangan). Hasilnya di `shots/` — cukup untuk menilai siluet model baru dan komposisi kamera saat tidak bisa membuka game.
