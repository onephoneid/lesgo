# LesGo! — Belajar Seru, Prestasi Melaju!

Aplikasi web les privat: menghubungkan **guru les** dengan **murid / orang tua**, dengan cabang per kota dan Pusat Kontrol admin.

## Fitur
- **Masuk & daftar** dengan No. HP + PIN 6 angka — pilih *Saya Mau Les* (murid / orang tua) atau *Saya Guru Les*.
- **Cari guru terdekat**: lokasi Kota → Kecamatan (atau koordinat Google Maps), peta radar jarak, rekomendasi terdekat, filter kota/jenjang/mode.
- **Tarif per mata pelajaran & kelas** (TK, SD 1–6, SMP, SMA, UTBK) — orang tua melihat tarif yang cocok untuk kelas anaknya.
- **Verifikasi guru**: gelar, pendidikan, No. Ijazah & foto ijazah (hanya admin yang bisa melihat), cek via PDDikti/PISN.
- **Private Class & Kelas Umum**, jadwal mingguan, materi pelajaran.
- **PR**, **absensi**, **laporan harian** (+ kirim WhatsApp), **rapor bulanan** dengan grafik.
- **SPP** bulanan, konfirmasi bayar, kuitansi digital. **Ulasan & rating** guru.
- **Biaya platform** untuk mensejahterakan guru: Rp10.000 sekali per murid baru (bisa diatur admin) — tidak ada potongan persentase SPP.
- **Pusat Kontrol admin**: peringatan "Perlu perhatian", status proses, riwayat aktivitas, data & kinerja guru, cabang, pendapatan platform.

## Struktur
| File | Isi |
|---|---|
| `index.html` | Seluruh aplikasi (HTML + CSS + JavaScript, satu file) |
| `logo.png`, `icon.png` | Logo & ikon LesGo! |

## Menjalankan
**Di Vercel (mode server, data bersama):**
1. Import repo ini ke Vercel (preset *Other*).
2. Vercel → proyek → **Storage** → buat **Upstash for Redis** (gratis) dan hubungkan ke proyek. Variabel `KV_REST_API_URL` & `KV_REST_API_TOKEN` (atau `UPSTASH_REDIS_REST_URL` & `UPSTASH_REDIS_REST_TOKEN`) otomatis terisi.
3. Redeploy. Buka situs → **Masuk → 🛡️ Admin** → buat **PIN Admin** (hanya bisa sekali, oleh orang pertama — lakukan segera setelah deploy).

`api/db.js` menangani login guru / murid / orang tua / admin (No. HP + PIN, token bertanda tangan), penyimpanan data, dan aturan akses: penulisan wajib login, data ijazah hanya untuk admin & guru pemiliknya, PIN tidak pernah dikirim ke browser, guru tidak bisa memverifikasi dirinya sendiri.

**Tanpa server** (buka `index.html` langsung / GitHub Pages): berjalan dalam mode demo, data hanya di browser.
