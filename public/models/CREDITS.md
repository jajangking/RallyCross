# Kredit aset 3D

## `honda-civic-eg6.glb` — "1991 Honda Civic EG6"

| | |
|---|---|
| **Pembuat** | rifdanzz — <https://sketchfab.com/rifdanzz> |
| **Sumber asli** | [1991 Honda Civic EG6](https://sketchfab.com/3d-models/1991-honda-civic-eg6-f81da34570b145deb463fa091604d251) (Sketchfab) |
| **Lisensi** | [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/) |
| **Diambil dari** | [`iManuel2K/capcar` → `public/models/cars/honda-civic.glb`](https://github.com/iManuel2K/capcar), yang mendistribusikan ulang model Sketchfab di atas sebagai GLB mandiri (Meshopt sudah di-decode, buffer di-repack) |
| **Berkas** | `public/models/honda-civic-eg6.glb`, 250.560 byte, `sha256 4536580acde5bff0f8a824271dcdac84fbd3f8383d7566fec801bf1fcb2d664f` |

Model ini **tidak** dibuat oleh proyek RallyCross. RallyCross hanya memakai dan
mengubahnya sesuai izin CC BY 4.0 (penggunaan komersial, adaptasi, dan
redistribusi diperbolehkan selama atribusi dipertahankan).

### Perubahan yang dilakukan RallyCross

Agar model bisa masuk ke simulasi, `src/vehicle/CarModelVisual.ts` melakukan
hal-hal berikut saat runtime (tidak ada geometri yang diubah di berkas GLB):

1. **Skala & posisi** — model diseragamkan skalanya dan digeser supaya jarak
   sumbu roda, lebar, serta tinggi ban cocok dengan mobil fisika; keempat ban
   diletakkan tepat menyentuh bidang tanah yang sama dengan suspensi.
2. **Roda** — empat node roda (`Circle*`) di-*re-parent* ke pivot kemudi dan
   pivot putaran supaya bisa ikut `steerAngle`, `spinAngle`, dan `suspLength`
   per roda. Geometri roda tidak diubah.
3. **Cat bodi** — material `Car_Paint` diwarnai ulang (default putih
   `#dfe4e8`, bisa diganti lewat `?paint=rrggbb`); `envMapIntensity` dinaikkan.
4. **Lampu** — mesh lampu bawaan model dibagi menjadi sisi kiri/kanan pada
   index buffer dan diberi material emissive sendiri, sehingga lampu rem,
   mundur, sein, dan lampu utama bisa dinyalakan oleh game.

Karena hasilnya adalah karya turunan, **berkas GLB ini tetap berlisensi
CC BY 4.0** — kalau kamu memakai ulang model ini, cantumkan juga atribusi di
atas.

### Catatan

"Honda" dan "Civic" adalah merek dagang Honda Motor Co., Ltd. Model ini adalah
karya penggemar yang tidak berafiliasi dengan, dan tidak didukung oleh, Honda.
