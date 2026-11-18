// LesGo! — API data & login (Vercel Serverless + Upstash Redis REST)
const crypto = require('crypto');
const { visible, authorize, validate } = require('../lib/access');
const { enrollment } = require('../lib/enrollment');
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOK_ = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const ADMIN_USER = process.env.LESGO_ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.LESGO_ADMIN_PASSWORD;
const COLS = ['dokumen','potongan','cabang','guru','ortu','murid','kelas','materi','pr','kumpul','absensi','laporan','spp','lowongan','lamaran','req','notif','ulasan','config'];
const ADMIN_ONLY = ['config','cabang'];
const P = 'lg:';

async function redis(cmds, atomic = false) {
  const r = await fetch(URL_ + (atomic ? '/multi-exec' : '/pipeline'), { method: 'POST', headers: { Authorization: 'Bearer ' + TOK_, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds), signal: AbortSignal.timeout(7000) });
  if (!r.ok) throw new Error('redis ' + r.status);
  const j = await r.json();
  return j.map(x => { if (x.error) throw new Error(x.error); return x.result; });
}
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && crypto.timingSafeEqual(Buffer.from(sha(a), 'hex'), Buffer.from(sha(b), 'hex'));
const adminReady = () => !!(ADMIN_USER && ADMIN_PASSWORD);
const adminVersion = () => crypto.createHmac('sha256', TOK_).update('admin-v2:' + ADMIN_USER + ':' + ADMIN_PASSWORD).digest('hex');
const hashPin = (id, pin) => sha('lesgo:' + id + ':' + pin);
const b64 = s => Buffer.from(s).toString('base64url');
function sign(p) { const body = b64(JSON.stringify(p)); return body + '.' + crypto.createHmac('sha256', TOK_).update(body).digest('base64url'); }
function verify(t) {
  try {
  if (!t || !t.includes('.')) return null; const [body, sig] = t.split('.');
  const ok = crypto.createHmac('sha256', TOK_).update(body).digest('base64url');
  if (sig.length !== ok.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(ok))) return null;
  const p = JSON.parse(Buffer.from(body, 'base64url').toString());
  if (!Number.isFinite(p.exp) || p.exp < Date.now()) return null;
  if (p.r === 'a' && (!adminReady() || p.id !== 'admin' || !same(p.av, adminVersion()))) return null;
  return p;
  } catch { return null; }
}
const normHp = h => { let d = String(h || '').replace(/\D/g, ''); if (d.startsWith('62')) d = '0' + d.slice(2); return d; };
const okId = s => typeof s === 'string' && /^[A-Za-z0-9_\-:.@+~]{1,120}$/.test(s);
async function getDoc(col, id) { const [v] = await redis([['HGET', P + col, id]]); return v ? JSON.parse(v) : null; }
async function snapshot() {
  const result = await redis(COLS.map(c => ['HVALS', P + c]));
  return Object.fromEntries(COLS.map((c, i) => [c, (result[i] || []).flatMap(v => { try { return [JSON.parse(v)]; } catch { return []; } })]));
}
async function setDocs(list) { await redis([...list.map(([c, d]) => ['HSET', P + c, d.id, JSON.stringify(d)]), ['INCR', P + 'ver']], true); }
const pub = d => { const { pinHash, ...r } = d; return r; };
const tokenFor = (r, id, pinHash) => sign({ r, id, ...(pinHash ? { pv: sha(pinHash) } : {}), ...(r === 'a' ? { av: adminVersion() } : {}), exp: Date.now() + 1000 * 60 * 60 * (r === 'a' ? 12 : 24 * 60) });
// rate limit login: 8 percobaan / 10 menit per HP
async function limited(key) { const [n] = await redis([['INCR', P + 'rl:' + key]]); if (n === 1) await redis([['EXPIRE', P + 'rl:' + key, 600]]); return n > 8; }

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!URL_ || !TOK_) return res.status(503).json({ ok: false, error: 'Database belum dihubungkan (Upstash Redis).' });
  try {
    let auth = verify((req.headers.authorization || '').replace(/^Bearer /, ''));
    const op = (req.method === 'GET' ? req.query.op : (req.body || {}).op) || 'all';
    const b = req.body || {};
    if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Metode tidak didukung' });
    if (req.method === 'GET' && !['all', 'ver', 'adminStatus'].includes(op)) return res.status(405).json({ ok: false, error: 'Gunakan POST' });
    if (auth && auth.r !== 'a') {
      const account = await getDoc(auth.r === 'g' ? 'guru' : 'ortu', auth.id);
      if (!['g','o'].includes(auth.r) || !account || account.nonaktif || !same(auth.pv, sha(account.pinHash || ''))) auth = null;
    }
    if (op === 'ver') { const [v] = await redis([['GET', P + 'ver']]); return res.json({ ok: true, ver: +v || 0 }); }
    if (op === 'all') {
      const rawData = await snapshot(), data = visible(rawData, auth);
      const stats = { guru: rawData.guru.filter(g => !g.nonaktif).length, murid: rawData.murid.length, kelas: rawData.kelas.length, laporan: rawData.laporan.length };
      const [ver] = await redis([['GET', P + 'ver']]);
      return res.json({ ok: true, data, stats, ver: +ver || 0, adminSet: adminReady(), me: auth ? { r: auth.r, id: auth.id } : null });
    }
    if (op === 'adminStatus') return res.json({ ok: true, adminSet: adminReady(), setupAllowed: false });
    if (op === 'adminSetup') {
      return res.status(403).json({ ok: false, error: 'Pendaftaran admin ditutup. Hubungi pemilik aplikasi.' });
    }
    if (op === 'adminLogin') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Gunakan POST' });
      if (!adminReady()) return res.status(503).json({ ok: false, error: 'Akun admin belum dikonfigurasi pemilik.' });
      if (await limited('admin')) return res.status(429).json({ ok: false, error: 'Terlalu banyak percobaan, coba 10 menit lagi' });
      const validUser = same(b.username, ADMIN_USER), validPassword = same(b.password, ADMIN_PASSWORD);
      if (!validUser || !validPassword) return res.status(401).json({ ok: false, error: 'Username atau password salah' });
      return res.json({ ok: true, token: tokenFor('a', 'admin') });
    }
    if (op === 'login') {
      const col = b.role === 'g' ? 'guru' : 'ortu', hp = normHp(b.hp);
      if (!/^08\d{8,12}$/.test(hp) || !/^\d{6}$/.test(b.pin || '')) return res.status(400).json({ ok: false, error: 'No. HP & PIN 6 angka wajib' });
      if (await limited(hp)) return res.status(429).json({ ok: false, error: 'Terlalu banyak percobaan, coba 10 menit lagi' });
      const [arr] = await redis([['HVALS', P + col]]);
      const acc = (arr || []).map(x => JSON.parse(x)).filter(a => normHp(a.hp) === hp);
      if (!acc.length) return res.status(404).json({ ok: false, error: 'No. HP belum terdaftar sebagai ' + (col === 'guru' ? 'guru les' : 'murid / orang tua') });
      const ok = acc.find(a => a.pinHash && a.pinHash === hashPin(a.id, b.pin));
      if (!ok) return res.status(401).json({ ok: false, error: acc.some(a => a.pinHash) ? 'PIN salah' : 'Akun belum punya PIN — minta admin membuatkan PIN' });
      if (ok.nonaktif) return res.status(403).json({ ok: false, error: 'Akun ini sedang dinonaktifkan admin.' });
      return res.json({ ok: true, token: tokenFor(col === 'guru' ? 'g' : 'o', ok.id, ok.pinHash), id: ok.id });
    }
    if (op === 'register') {
      const col = b.col; if (!['guru', 'ortu'].includes(col)) return res.status(400).json({ ok: false });
      const d = b.doc || {}; if (!okId(d.id) || !/^\d{6}$/.test(b.pin || '') || !/^08\d{8,12}$/.test(normHp(d.hp)) || typeof d.nama !== 'string' || !d.nama.trim()) return res.status(400).json({ ok: false, error: 'Data belum lengkap' });
      if (JSON.stringify(b).length > 250000) return res.status(413).json({ ok: false, error: 'Data terlalu besar. Kecilkan ukuran foto.' });
      const [arr] = await redis([['HVALS', P + col]]);
      if ((arr || []).some(x => normHp(JSON.parse(x).hp) === normHp(d.hp))) return res.status(409).json({ ok: false, error: 'No. HP ini sudah terdaftar — silakan Masuk' });
      if (await getDoc('guru', d.id) || await getDoc('ortu', d.id)) return res.status(409).json({ ok: false });
      const doc = { ...d, hp: normHp(d.hp), nama: d.nama.trim(), demo: false, pinHash: hashPin(d.id, b.pin), verif: false, nonaktif: false, ...(col === 'guru' ? { verifStatus: 'Menunggu' } : {}) };
      validate(col, doc);
      const extras = (b.extras || []).filter(e => (e.col === 'murid' && e.doc?.ortuId === d.id) || (e.col === 'dokumen' && e.doc?.guruId === d.id)).filter(e => okId(e.doc.id));
      for (const e of extras) { validate(e.col, e.doc); if (await getDoc(e.col, e.doc.id)) return res.status(409).json({ ok: false, error: 'Identitas data sudah digunakan' }); }
      const phoneKey = P + 'phone:' + col + ':' + sha(normHp(d.hp));
      const idKey = P + 'account-id:' + d.id;
      const [idReserved] = await redis([['SET', idKey, col, 'NX']]);
      if (!idReserved) return res.status(409).json({ ok: false, error: 'Identitas akun sudah digunakan' });
      const [reserved] = await redis([['SET', phoneKey, d.id, 'NX']]);
      if (!reserved) { await redis([['DEL', idKey]]); return res.status(409).json({ ok: false, error: 'No. HP ini sudah terdaftar — silakan Masuk' }); }
      try { await setDocs([[col, doc], ...extras.map(e => [e.col, e.doc])]); }
      catch (error) { await redis([['DEL', phoneKey], ['DEL', idKey]]); throw error; }
      return res.json({ ok: true, token: tokenFor(col === 'guru' ? 'g' : 'o', d.id, doc.pinHash) });
    }
    if (!auth) return res.status(401).json({ ok: false, error: 'Silakan masuk dulu' });
    const isA = auth.r === 'a';
    if (op === 'respondRequest' || op === 'selectApplicant') {
      if (!okId(b.id)) return res.status(400).json({ ok: false, error: 'Identitas tidak valid' });
      const lockKey = P + 'enrollment-lock', lockValue = crypto.randomUUID();
      const [lock] = await redis([['SET', lockKey, lockValue, 'NX', 'PX', 30000]]);
      if (!lock) return res.status(409).json({ ok: false, error: 'Pengajuan sedang diproses. Coba lagi sebentar.' });
      try {
        const result = enrollment(await snapshot(), auth, op, b);
        if (result.docs.length) await setDocs(result.docs);
        return res.json({ ok: true, kelasId: result.kelasId, already: !!result.already });
      } finally {
        await redis([['EVAL', "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, lockKey, lockValue]]);
      }
    }

    if (op === 'setpin') {
      const col = auth.r === 'g' ? 'guru' : 'ortu'; const a = await getDoc(col, auth.id); if (!a) return res.status(404).json({ ok: false });
      if (a.pinHash && a.pinHash !== hashPin(a.id, b.old || '')) return res.status(401).json({ ok: false, error: 'PIN lama salah' });
      if (!/^\d{6}$/.test(b.pin || '')) return res.status(400).json({ ok: false, error: 'PIN harus 6 angka' });
      const pinHash = hashPin(a.id, b.pin);
      await setDocs([[col, { ...a, pinHash }]]); return res.json({ ok: true, token: tokenFor(auth.r, auth.id, pinHash) });
    }
    if (op === 'resetpin') {
      if (!isA) return res.status(403).json({ ok: false }); const a = await getDoc(b.col, b.id); if (!a || !['guru', 'ortu'].includes(b.col)) return res.status(404).json({ ok: false });
      if (!/^\d{6}$/.test(b.pin || '')) return res.status(400).json({ ok: false, error: 'PIN harus 6 angka' });
      await setDocs([[b.col, { ...a, pinHash: hashPin(a.id, b.pin) }]]); return res.json({ ok: true });
    }
    if (op === 'put' || op === 'del') {
      const col = b.col, id = op === 'put' ? b.doc?.id : b.id;
      if (!COLS.includes(col) || !okId(id)) return res.status(400).json({ ok: false, error: 'Data tidak valid' });
      if (op === 'put' && JSON.stringify(b.doc).length > 250000) return res.status(413).json({ ok: false, error: 'Data terlalu besar' });
      if (ADMIN_ONLY.includes(col) && !isA) return res.status(403).json({ ok: false, error: 'Khusus admin' });
      const data = await snapshot(), old = data[col].find(d => d.id === id);
      let doc = authorize(data, auth, col, op === 'put' ? { ...b.doc } : old, old, op === 'del');
      if (op === 'del') {
        if (['guru','ortu'].includes(col) && old) {
          const related = data.kelas.some(k => col === 'guru' ? k.guruId === id : (k.murid || []).some(mid => data.murid.some(m => m.id === mid && m.ortuId === id)));
          if (related) return res.status(409).json({ ok: false, error: 'Akun masih memiliki kelas. Nonaktifkan akun atau hapus kelas terlebih dahulu.' });
          await redis([['DEL', P + 'phone:' + col + ':' + sha(normHp(old.hp))]]);
        }
        await redis([['HDEL', P + col, id], ['INCR', P + 'ver']]);
        return res.json({ ok: true });
      }
      if (col === 'guru' || col === 'ortu') {
        doc.pinHash = old?.pinHash;
        if (old && normHp(doc.hp) !== normHp(old.hp)) return res.status(400).json({ ok: false, error: 'Perubahan nomor masuk belum tersedia. Hubungi admin.' });
      }
      if (col === 'dokumen' && old && (old.noIjazah !== doc.noIjazah || old.foto !== doc.foto)) {
        const guru = data.guru.find(g => g.id === doc.guruId);
        if (guru) await setDocs([['guru', { ...guru, verif: false, verifStatus: 'Menunggu', verifAlasan: '' }]]);
      }
      await setDocs([[col, doc]]); const { pinHash, ...saved } = doc; return res.json({ ok: true, doc: saved });
    }
    return res.status(400).json({ ok: false, error: 'op tidak dikenal' });
  } catch (e) { return res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : 'Penyimpanan gagal. Coba lagi sebentar.' }); }
};
