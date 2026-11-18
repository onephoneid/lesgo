function error(message, status = 400) { const e = new Error(message); e.status = status; throw e; }
function enrollment(data, auth, op, body) {
  const get = (c, id) => (data[c] || []).find(x => x.id === id), today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
  const docs = [], notice = (id, to, text) => docs.push(['notif', { id, to, text, t: today, ts: Date.now(), read: false }]);
  let gid, mid, kid, reason;
  if (op === 'respondRequest') {
    const request = get('req', body.id);
    if (!request || auth.r !== 'g' || request.guruId !== auth.id) error('Pengajuan tidak ditemukan', 403);
    if (request.status !== 'Menunggu') return { docs: [], already: true };
    if (typeof body.accept !== 'boolean') error('Pilih terima atau tolak');
    if (!body.accept) {
      docs.push(['req', { ...request, status: 'Ditolak' }]); notice('reply_' + request.id, request.ortuId, 'Pengajuan les belum dapat diterima guru.');
      return { docs };
    }
    gid = auth.id; mid = request.muridId;
    const guru = get('guru', gid), murid = get('murid', mid);
    if (!guru || guru.nonaktif || !murid || murid.ortuId !== request.ortuId) error('Data pengajuan tidak lagi tersedia');
    if (request.tipe === 'Umum') {
      const klass = get('kelas', request.kelasId);
      if (!klass || klass.guruId !== gid || klass.tipe !== 'Umum') error('Kelas tidak ditemukan');
      if (!(klass.murid || []).includes(mid) && (klass.murid || []).length >= klass.kapasitas) error('Kelas sudah penuh');
      kid = klass.id; docs.push(['kelas', { ...klass, murid: [...new Set([...(klass.murid || []), mid])] }]);
    } else {
      kid = 'private_' + request.id;
      const tarif = Number(request.tarif ?? guru.tarif ?? 0);
      if (!Number.isFinite(tarif) || tarif < 0) error('Tarif tidak valid');
      docs.push(['kelas', { id: kid, nama: (request.mapel || 'Les') + ' Private — ' + murid.nama, tipe: 'Private', guruId: gid, mapel: request.mapel || guru.mapel?.[0] || '', hari: [], jam: '', lokasi: '', harga: tarif * 8, kapasitas: 1, murid: [mid] }]);
    }
    docs.push(['req', { ...request, status: 'Diterima', kelasId: kid }]);
    notice('reply_' + request.id, request.ortuId, 'Pengajuan les diterima. Jadwal dan kelas tersedia di aplikasi.'); reason = 'Pengajuan les diterima';
  } else {
    const job = get('lowongan', body.id);
    if (!job || auth.r !== 'o' || job.ortuId !== auth.id) error('Kebutuhan les tidak ditemukan', 403);
    if (job.selectedGuruId) return { docs: [], already: true };
    if (job.status !== 'Buka') error('Kebutuhan les sudah ditutup');
    gid = body.guruId; mid = job.muridId; kid = 'match_' + job.id;
    const guru = get('guru', gid), murid = get('murid', mid);
    if (!guru || guru.nonaktif || !murid || murid.ortuId !== auth.id || !(data.lamaran || []).some(l => l.lowonganId === job.id && l.guruId === gid)) error('Pilih guru yang melamar kebutuhan ini');
    const harga = Number(job.budget || Number(guru.tarif || 0) * 8);
    if (!Number.isFinite(harga) || harga < 0) error('Budget tidak valid');
    docs.push(['kelas', { id: kid, nama: job.mapel + ' Private — ' + murid.nama, tipe: 'Private', guruId: gid, mapel: job.mapel, hari: [], jam: '', lokasi: job.mode === 'Online' ? 'Online' : job.lokasi, harga, kapasitas: 1, murid: [mid] }]);
    docs.push(['lowongan', { ...job, status: 'Tutup', selectedGuruId: gid }]);
    notice('match_' + job.id, gid, 'Anda dipilih untuk mengajar ' + murid.nama + '. Silakan atur jadwal kelas.'); reason = 'Dipilih dari kebutuhan les';
  }
  const cfg = get('config', 'main') || {}, fee = cfg.feeNominal ?? 10000, feeId = gid + '_' + mid;
  if (fee > 0 && (cfg.feeMode || 'sekali') === 'sekali' && !get('potongan', feeId)) {
    docs.push(['potongan', { id: feeId, guruId: gid, muridId: mid, kelasId: kid, nominal: fee, jenis: 'Murid baru', ket: reason, tanggal: today, status: 'Belum' }]);
    notice('fee_' + feeId, gid, 'Biaya platform murid baru tercatat. Lihat menu Penghasilan.');
  }
  return { docs, kelasId: kid };
}
module.exports = { enrollment };
