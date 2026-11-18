// Server-side visibility, ownership and workflow checks for every collection.
const fail = (message = 'Tidak diizinkan') => { const error = new Error(message); error.status = 403; throw error; };
const owns = (auth, owner) => !!auth && auth.id === owner;
const only = (before, after, fields) => {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) if (!fields.includes(key) && JSON.stringify(before[key]) !== JSON.stringify(after[key])) fail('Kolom ini tidak boleh diubah: ' + key);
};
const positive = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function scope(data, auth) {
  const find = (c, id) => (data[c] || []).find(x => x.id === id);
  const child = id => find('murid', id);
  const klass = id => find('kelas', id);
  const mine = id => auth?.r === 'o' && child(id)?.ortuId === auth.id;
  const teaches = id => auth?.r === 'g' && klass(id)?.guruId === auth.id;
  const relatedClass = k => !!auth && (k.guruId === auth.id || (k.murid || []).some(mine));
  const shared = (gid, oid) => (data.kelas || []).some(k => k.guruId === gid && (k.murid || []).some(mid => child(mid)?.ortuId === oid)) || (data.req || []).some(r => r.guruId === gid && r.ortuId === oid) || (data.lamaran || []).some(l => l.guruId === gid && find('lowongan', l.lowonganId)?.ortuId === oid);
  return { find, child, klass, mine, teaches, relatedClass, shared };
}
function visible(data, auth) {
  if (auth?.r === 'a') return Object.fromEntries(Object.entries(data).map(([c, rows]) => [c, rows.map(d => { const { pinHash, ...doc } = d; return doc; })]));
  const { find, child, klass, mine, teaches, shared } = scope(data, auth), out = Object.fromEntries(Object.keys(data).map(c => [c, []]));
  out.config = (data.config || []).map(({ id, nama, infoBayar, feeNominal, feeMode, rekPlatform }) => ({ id, nama, infoBayar, feeNominal, feeMode, rekPlatform }));
  out.cabang = data.cabang || [];
  out.guru = (data.guru || []).filter(g => !g.nonaktif || owns(auth, g.id)).map(g => {
    const { pinHash, ...doc } = g;
    if (auth?.r === 'g' && g.id === auth.id) return doc;
    const { rekening, hp, uid, ...publicDoc } = doc;
    return auth?.r === 'o' && shared(g.id, auth.id) ? { ...publicDoc, hp, rekening } : publicDoc;
  });
  out.ulasan = data.ulasan || [];
  const reviewOwners = new Set(out.ulasan.map(u => u.ortuId));
  out.ortu = (data.ortu || []).filter(o => (auth?.r === 'o' && o.id === auth.id) || reviewOwners.has(o.id) || (auth?.r === 'g' && shared(auth.id, o.id))).map(o => {
    const { pinHash, ...doc } = o;
    return (auth?.r === 'o' && o.id === auth.id) || (auth?.r === 'g' && shared(auth.id, o.id)) ? doc : { id: o.id, nama: o.nama };
  });
  out.kelas = (data.kelas || []).filter(k => auth && (auth.r === 'g' ? k.guruId === auth.id : (k.murid || []).some(mine) || k.tipe === 'Umum')).map(k => auth?.r === 'o' && !(k.murid || []).some(mine) ? { ...k, murid: [], jumlahMurid: (k.murid || []).length } : k);
  if (!auth) return out;
  const requested = new Set((data.req || []).filter(r => r.guruId === auth.id).map(r => r.muridId));
  const openKids = new Set((data.lowongan || []).filter(w => w.status === 'Buka').map(w => w.muridId));
  out.murid = (data.murid || []).filter(m => mine(m.id) || (auth.r === 'g' && ((data.kelas || []).some(k => k.guruId === auth.id && (k.murid || []).includes(m.id)) || requested.has(m.id) || openKids.has(m.id)))).map(m => auth.r === 'g' && !requested.has(m.id) && !(data.kelas || []).some(k => k.guruId === auth.id && (k.murid || []).includes(m.id)) ? { id: m.id, nama: m.nama, kelas: m.kelas } : m);
  out.req = (data.req || []).filter(r => (auth.r === 'g' && r.guruId === auth.id) || (auth.r === 'o' && r.ortuId === auth.id));
  out.lowongan = (data.lowongan || []).filter(w => (auth.r === 'o' && w.ortuId === auth.id) || (auth.r === 'g' && (w.status === 'Buka' || (data.lamaran || []).some(l => l.lowonganId === w.id && l.guruId === auth.id))));
  out.lamaran = (data.lamaran || []).filter(l => (auth.r === 'g' && l.guruId === auth.id) || (auth.r === 'o' && find('lowongan', l.lowonganId)?.ortuId === auth.id));
  out.dokumen = (data.dokumen || []).filter(d => auth.r === 'g' && d.guruId === auth.id);
  for (const c of ['materi', 'pr', 'absensi', 'laporan', 'spp']) out[c] = (data[c] || []).filter(d => teaches(d.kelasId) || (c === 'laporan' || c === 'spp' ? mine(d.muridId) : (klass(d.kelasId)?.murid || []).some(mine))).map(d => c === 'absensi' && auth.r === 'o' ? { ...d, data: Object.fromEntries(Object.entries(d.data || {}).filter(([mid]) => mine(mid))) } : d);
  out.kumpul = (data.kumpul || []).filter(d => mine(d.muridId) || teaches(find('pr', d.prId)?.kelasId));
  out.potongan = (data.potongan || []).filter(d => auth.r === 'g' && d.guruId === auth.id);
  out.notif = (data.notif || []).filter(d => d.to === auth.id);
  return out;
}
function validate(col, doc) {
  const text = (key, required = false, max = 10000) => { if ((required || doc[key] != null) && (typeof doc[key] !== 'string' || (required && !doc[key].trim()) || doc[key].length > max)) fail('Data ' + key + ' tidak valid'); };
  if (['guru','ortu','murid','kelas'].includes(col)) text('nama', true, 150);
  if (col === 'guru' && (!Array.isArray(doc.mapel) || !doc.mapel.every(x => typeof x === 'string'))) fail('Mata pelajaran tidak valid');
  if (col === 'kelas') {
    if (!['Private','Umum'].includes(doc.tipe) || !Array.isArray(doc.hari) || !doc.hari.every(x=>Number.isInteger(x)&&x>=0&&x<=6)) fail('Jenis kelas atau jadwal tidak valid');
    text('mapel', true, 100); text('jam'); text('lokasi');
  }
  if (col === 'materi' || col === 'pr') text('judul', true, 200);
  if (['materi','laporan','absensi'].includes(col) && !/^\d{4}-\d{2}-\d{2}$/.test(doc.tanggal || '')) fail('Tanggal tidak valid');
  if (col === 'pr' && !/^\d{4}-\d{2}-\d{2}$/.test(doc.deadline || '')) fail('Deadline tidak valid');
  if (col === 'laporan') text('dikerjakan', true);
  if (col === 'notif') text('text', true, 3000);
  if (col === 'dokumen') {
    text('noIjazah', true, 150);
    if (doc.foto && (typeof doc.foto !== 'string' || doc.foto.length > 230000 || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(doc.foto))) fail('Foto ijazah harus berupa gambar yang valid');
  }
}
function authorize(data, auth, col, doc, old, deleting = false) {
  if (!deleting) validate(col, doc);
  if (!auth) fail('Silakan masuk dulu');
  if (auth.r === 'a') return doc;
  const { find, child, klass, mine, teaches, shared } = scope(data, auth), teacher = auth.r === 'g', parent = auth.r === 'o';
  if (!teacher && !parent) fail();
  if (['config', 'cabang'].includes(col)) fail('Khusus admin');
  const item = deleting ? old : doc;
  if (!item) fail('Data tidak ditemukan');
  if (old) for (const key of ['guruId', 'ortuId', 'muridId', 'kelasId', 'prId', 'lowonganId', 'to']) if (Object.hasOwn(old, key) && JSON.stringify(old[key]) !== JSON.stringify(doc[key])) fail('Pemilik atau relasi data tidak boleh diubah');
  switch (col) {
    case 'guru': case 'ortu': {
      if (deleting || !old || auth.id !== doc.id || (col === 'guru') !== teacher) fail();
      const { pinHash, ...result } = doc;
      for (const key of ['verif', 'verifStatus', 'verifAlasan', 'nonaktif', 'uid', 'daftar']) if (Object.hasOwn(old, key)) result[key] = old[key];
      result.pinHash = old.pinHash;
      if (teacher && (old.gelar !== doc.gelar || old.pendidikan !== doc.pendidikan || old.tahunLulus !== doc.tahunLulus)) Object.assign(result, { verif: false, verifStatus: 'Menunggu', verifAlasan: '' });
      return result;
    }
    case 'dokumen':
      if (!teacher || item.guruId !== auth.id) fail();
      break;
    case 'murid':
      if (!parent || item.ortuId !== auth.id) fail();
      break;
    case 'kelas': {
      if (teacher && item.guruId === auth.id) {
        for (const mid of item.murid || []) if (!(old?.murid || []).includes(mid) && !(data.req || []).some(r => r.guruId === auth.id && r.muridId === mid && ['Menunggu', 'Diterima'].includes(r.status))) fail('Murid harus mengajukan les terlebih dahulu');
      } else if (parent && !old && !deleting && (item.murid || []).length === 1 && mine(item.murid[0]) && (data.lowongan || []).some(w => w.ortuId === auth.id && w.muridId === item.murid[0] && (data.lamaran || []).some(l => l.lowonganId === w.id && l.guruId === item.guruId))) {
        if (item.tipe !== 'Private') fail();
      } else fail();
      if (!deleting && (!positive(item.harga) || !Array.isArray(item.murid) || new Set(item.murid).size !== item.murid.length || !Number.isInteger(item.kapasitas) || item.kapasitas < 1 || item.murid.length > item.kapasitas || (item.tipe === 'Private' && item.kapasitas !== 1))) fail('Tarif, kapasitas, atau daftar murid tidak valid');
      break;
    }
    case 'req':
      if (!old && !deleting && parent && doc.ortuId === auth.id && mine(doc.muridId) && find('guru', doc.guruId) && doc.status === 'Menunggu') {
        if (doc.tipe === 'Umum' && (klass(doc.kelasId)?.guruId !== doc.guruId || klass(doc.kelasId)?.tipe !== 'Umum')) fail('Kelas tidak sesuai guru');
      } else if (old && !deleting && teacher && old.guruId === auth.id && old.status === 'Menunggu' && ['Diterima', 'Ditolak'].includes(doc.status)) only(old, doc, ['status']);
      else fail();
      break;
    case 'lowongan':
      if (!parent || item.ortuId !== auth.id || !mine(item.muridId)) fail();
      if (!deleting && (!positive(item.budget) || !['Buka', 'Tutup'].includes(item.status))) fail('Budget atau status tidak valid');
      break;
    case 'lamaran':
      if (!teacher || item.guruId !== auth.id || (!old && find('lowongan', item.lowonganId)?.status !== 'Buka')) fail();
      break;
    case 'materi': case 'pr': case 'absensi': case 'laporan': {
      if (col === 'laporan' && parent && old && !deleting && mine(old.muridId)) { only(old, doc, ['dibaca']); if (doc.dibaca !== true) fail(); return doc; }
      if (!teaches(item.kelasId)) fail();
      const mids = klass(item.kelasId)?.murid || [];
      if (!deleting && col === 'pr' && (!Array.isArray(doc.murid) || !doc.murid.every(id => mids.includes(id)))) fail('Daftar murid tidak sesuai kelas');
      if (!deleting && col === 'laporan' && (!mids.includes(doc.muridId) || !positive(doc.nilai) || doc.nilai > 100)) fail('Murid atau nilai laporan tidak valid');
      if (!deleting && col === 'absensi' && (!doc.data || !Object.entries(doc.data).every(([id, value]) => mids.includes(id) && ['Hadir', 'Izin', 'Sakit', 'Alfa'].includes(value)))) fail('Absensi tidak sesuai kelas');
      break;
    }
    case 'kumpul': {
      const pr = find('pr', item.prId);
      if (deleting || !pr || !(pr.murid || []).includes(item.muridId)) fail();
      if (parent && mine(item.muridId) && (!old || old.status === 'Belum')) {
        if (old) only(old, doc, ['jawaban', 'tanggal', 'status', 'nilai', 'catatan']);
        if (doc.status !== 'Dikumpulkan' || doc.nilai != null || doc.catatan) fail();
      } else if (teacher && old && teaches(pr.kelasId)) {
        only(old, doc, ['nilai', 'catatan', 'status']); if (doc.status !== 'Dinilai' || !positive(doc.nilai) || doc.nilai > 100) fail('Nilai harus 0–100');
      } else fail();
      break;
    }
    case 'spp':
      if (deleting) fail();
      if (parent && old && mine(old.muridId)) {
        only(old, doc, ['status', 'bayar', 'metode', 'ref']); if (old.status !== 'Belum' || doc.status !== 'Menunggu Konfirmasi') fail();
      } else if (teacher && teaches(item.kelasId) && (klass(item.kelasId)?.murid || []).includes(item.muridId)) {
        if (!positive(item.nominal) || !/^\d{4}-\d{2}$/.test(item.bulan) || !['Belum', 'Menunggu Konfirmasi', 'Lunas'].includes(item.status)) fail('Tagihan tidak valid');
        if (!old && item.status !== 'Belum') fail();
        if (old && old.status === 'Lunas') fail('Tagihan sudah lunas. Hubungi admin untuk koreksi.');
        if (old && old.status === 'Belum' && doc.status !== 'Belum') fail('Tunggu konfirmasi pembayaran dari orang tua');
      } else fail();
      break;
    case 'potongan': {
      if (deleting) fail('Khusus admin');
      if (old) {
        if (!teacher || old.guruId !== auth.id) fail();
        only(old, doc, ['status', 'bayar', 'metode', 'ref']); if (old.status !== 'Belum' || doc.status !== 'Menunggu Konfirmasi') fail();
      } else {
        const cfg = find('config', 'main') || {}, fee = cfg.feeNominal ?? 10000;
        const classMatch = klass(item.kelasId)?.guruId === item.guruId && (klass(item.kelasId)?.murid || []).includes(item.muridId);
        const pending = (data.req || []).some(r => r.guruId === auth.id && r.muridId === item.muridId && r.status === 'Menunggu');
        if (!(teacher && item.guruId === auth.id && (classMatch || pending)) && !(parent && mine(item.muridId) && classMatch)) fail();
        if (item.nominal !== fee || item.status !== 'Belum' || !fee) fail('Biaya harus sesuai pengaturan platform');
        const monthly = cfg.feeMode === 'bulanan';
        if (monthly ? !new RegExp('^b_' + item.muridId + '_' + item.guruId + '_\\d{4}-\\d{2}$').test(item.id) : item.id !== item.guruId + '_' + item.muridId) fail('Identitas biaya tidak valid');
      }
      break;
    }
    case 'notif':
      if (old || deleting) { if (item.to !== auth.id) fail(); if (!deleting) { only(old, doc, ['read']); if (typeof doc.read !== 'boolean') fail(); } }
      else if (item.to !== auth.id && !(teacher ? shared(auth.id, item.to) : shared(item.to, auth.id))) fail('Penerima notifikasi tidak terkait dengan akun');
      break;
    case 'ulasan':
      if (!parent || item.ortuId !== auth.id || !(data.kelas || []).some(k => k.guruId === item.guruId && (k.murid || []).some(mine)) || (!deleting && (!Number.isInteger(item.bintang) || item.bintang < 1 || item.bintang > 5))) fail();
      break;
    default: fail();
  }
  return doc;
}
module.exports = { visible, authorize, scope, validate };
