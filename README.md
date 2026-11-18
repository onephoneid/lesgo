# LesGo! — Belajar Seru, Prestasi Melaju!

Situs utama: https://lesgo-mu.vercel.app
Belajar mandiri: https://lesgo-mu.vercel.app/belajar.html

Aplikasi menghubungkan guru dengan murid dan orang tua, serta menyediakan paket fondasi belajar mandiri dengan animasi, latihan bervariasi, pembahasan, dan skor per profil murid.

## Sumber dan deployment

Branch `main` berisi sumber aplikasi yang dipakai Vercel pada direktori utama. Push ke `main` memicu deployment otomatis. Jangan mengganti sumber dengan versi lama atau hanya menyalin folder fitur.

- `index.html`: aplikasi les dan dashboard.
- `belajar.html`, `study-ui.js`, `learning-ui.js`, `learning.css`: ruang belajar mandiri.
- `api/`: autentikasi, data, publikasi, pembayaran, lokasi, absensi, dan penilaian belajar.
- `lib/access.js`, `lib/enrollment.js`: aturan akses dan pendaftaran kelas.
- `assets/`: gambar, peta, dan pemindai QR.
- `.source/study/`: sumber materi, handler, pembangun bundle, dan pemeriksaan belajar mandiri.

Konfigurasi database memakai `KV_REST_API_URL` dan `KV_REST_API_TOKEN`, atau variabel `UPSTASH_REDIS_REST_URL` dan `UPSTASH_REDIS_REST_TOKEN`. Akun admin diatur pemilik melalui `LESGO_ADMIN_USERNAME` dan `LESGO_ADMIN_PASSWORD`. Pendaftaran admin dari halaman publik ditutup. Jangan menyimpan nilai rahasia di Git.

## Memperbarui materi bawaan

Dari direktori proyek:

```sh
python .source/study/scripts/build-study.py
node .source/study/tests/learning.cjs
python .source/study/tests/progress-lua.py
python .source/study/tests/lua.py
```

Commit juga `api/study.js` yang dihasilkan. Materi dapat diedit dari admin. Bank soal bawaan dan contoh hitung diacak saat memulai paket latihan baru; penilaian dilakukan di server.

## Akses dan pembayaran

Akses berbayar Rp5.000 per pelajaran selama 30 hari dibuka setelah admin memverifikasi dana masuk pada mutasi bank. Rekening tujuan diatur admin dan dicatat pada pesanan. Murid tidak dapat membuka akses hanya dengan mengaku sudah transfer. Pembayaran otomatis melalui gateway belum terintegrasi.

Nilai terakhir, nilai terbaik, jumlah latihan, XP, dan hari belajar dipisahkan berdasarkan akun serta profil anak yang sah. Latihan gratis dapat dicoba tanpa akun; hasil tanpa akun tidak disimpan.

## Cakupan pembelajaran

Paket fondasi untuk kelas 1–6 SD, 7–9 SMP, serta 10–12 SMA/SMK. Kejuruan awal SMK mencakup RPL, TKJ, dan Akuntansi. Cakupan ini belum menggantikan seluruh kurikulum sekolah atau seluruh kompetensi semua jurusan. Modul Pendidikan Agama bawaan membahas budi pekerti bersama; tata ibadah perlu disesuaikan dengan agama murid oleh pengajar yang sesuai.
