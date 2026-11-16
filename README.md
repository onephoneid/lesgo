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
Buka `index.html` di browser, atau aktifkan **GitHub Pages** (Settings → Pages → Deploy from branch `main` / root).

> **Catatan penyimpanan data:** versi utama berjalan sebagai artifact di claude.ai dengan database bersama (semua guru & orang tua melihat data yang sama).
> Saat dibuka di luar claude.ai (mis. GitHub Pages), aplikasi berjalan dalam **mode demo**: data hanya tersimpan di browser masing-masing.
> Untuk dipakai banyak orang di luar claude.ai, lapisan data (`put`, `del`, dan `init` di `index.html`) perlu dihubungkan ke backend sendiri (mis. Firebase/Supabase) + login OTP.

## Akses admin
Di claude.ai, pemilik artifact otomatis menjadi admin. Di mode demo, gunakan pilihan peran di pojok kanan atas.
