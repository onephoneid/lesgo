// LesGo! — API data & login (Vercel Serverless + Upstash Redis REST)
const crypto = require('crypto');
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOK_ = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const COLS = ['dokumen','potongan','cabang','guru','ortu','murid','kelas','materi','pr','kumpul','absensi','laporan','spp','lowongan','lamaran','req','notif','ulasan','config','game'];
const ADMIN_ONLY = ['config','cabang'];
const P = 'lg:';

async function redis(cmds) { // pipeline
  const r = await fetch(URL_ + '/pipeline', { method: 'POST', headers: { Authorization: 'Bearer ' + TOK_, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds) });
  if (!r.ok) throw new Error('redis ' + r.status);
  const j = await r.json();
  return j.map(x => { if (x.error) throw new Error(x.error); return x.result; });
}
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const hashPin = (id, pin) => sha('lesgo:' + id + ':' + pin);
const b64 = s => Buffer.from(s).toString('base64url');
function sign(p) { const body = b64(JSON.stringify(p)); return body + '.' + crypto.createHmac('sha256', TOK_).update(body).digest('base64url'); }
function verify(t) {
  if (!t || !t.includes('.')) return null; const [body, sig] = t.split('.');
  const ok = crypto.createHmac('sha256', TOK_).update(body).digest('base64url');
  if (sig.length !== ok.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(ok))) return null;
  const p = JSON.parse(Buffer.from(body, 'base64url').toString()); if (p.exp < Date.now()) return null; return p;
}
const normHp = h => { let d = String(h || '').replace(/\D/g, ''); if (d.startsWith('62')) d = '0' + d.slice(2); return d; };
const okId = s => typeof s === 'string' && /^[A-Za-z0-9_\-:.@+~]{1,120}$/.test(s);
async function getDoc(col, id) { const [v] = await redis([['HGET', P + col, id]]); return v ? JSON.parse(v) : null; }
async function setDocs(list) { await redis([...list.map(([c, d]) => ['HSET', P + c, d.id, JSON.stringify(d)]), ['INCR', P + 'ver']]); }
const pub = d => { const { pinHash, ...r } = d; return r; };
const tokenFor = (r, id) => sign({ r, id, exp: Date.now() + 1000 * 60 * 60 * 24 * 60 });
// rate limit login: 8 percobaan / 10 menit per HP
async function limited(key) { const [n] = await redis([['INCR', P + 'rl:' + key], ['EXPIRE', P + 'rl:' + key, 600]]); return n > 8; }

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!URL_ || !TOK_) return res.status(503).json({ ok: false, error: 'Database belum dihubungkan (Upstash Redis).' });
  try {
    const auth = verify((req.headers.authorization || '').replace(/^Bearer /, ''));
    const op = (req.method === 'GET' ? req.query.op : (req.body || {}).op) || 'all';
    const b = req.body || {};
    if (op === 'ver') { const [v] = await redis([['GET', P + 'ver']]); return res.json({ ok: true, ver: +v || 0 }); }
    if (op === 'all') {
      const out = await redis([...COLS.map(c => ['HGETALL', P + c]), ['GET', P + 'ver'], ['EXISTS', P + 'adminpin']]);
      const data = {};
      COLS.forEach((c, i) => {
        const arr = out[i] || []; const docs = [];
        for (let k = 0; k < arr.length; k += 2) { try { docs.push(JSON.parse(arr[k + 1])); } catch (e) {} }
        if (c === 'dokumen') data[c] = auth?.r === 'a' ? docs : auth?.r === 'g' ? docs.filter(d => d.guruId === auth.id) : [];
        else data[c] = (c === 'guru' || c === 'ortu') ? docs.map(pub) : docs;
      });
      return res.json({ ok: true, data, ver: +out[COLS.length] || 0, adminSet: !!out[COLS.length + 1], me: auth ? { r: auth.r, id: auth.id } : null });
    }
    if (op === 'adminStatus') { const [e] = await redis([['EXISTS', P + 'adminpin']]); return res.json({ ok: true, adminSet: !!e }); }
    if (op === 'adminSetup') {
      if (!/^\d{6,}$/.test(b.pin || '')) return res.status(400).json({ ok: false, error: 'PIN admin minimal 6 angka' });
      const [set] = await redis([['SETNX', P + 'adminpin', sha('lesgo:admin:' + b.pin)]]);
      if (!set) return res.status(403).json({ ok: false, error: 'PIN admin sudah dibuat. Silakan masuk.' });
      return res.json({ ok: true, token: tokenFor('a', 'admin') });
    }
    if (op === 'adminLogin') {
      if (await limited('admin')) return res.status(429).json({ ok: false, error: 'Terlalu banyak percobaan, coba 10 menit lagi' });
      const [h] = await redis([['GET', P + 'adminpin']]);
      if (!h || h !== sha('lesgo:admin:' + (b.pin || ''))) return res.status(401).json({ ok: false, error: 'PIN admin salah' });
      return res.json({ ok: true, token: tokenFor('a', 'admin') });
    }
    if (op === 'login') {
      const col = b.role === 'g' ? 'guru' : 'ortu', hp = normHp(b.hp);
      if (!hp || !/^\d{6}$/.test(b.pin || '')) return res.status(400).json({ ok: false, error: 'No. HP & PIN 6 angka wajib' });
      if (await limited(hp)) return res.status(429).json({ ok: false, error: 'Terlalu banyak percobaan, coba 10 menit lagi' });
      const [arr] = await redis([['HVALS', P + col]]);
      const acc = (arr || []).map(x => JSON.parse(x)).filter(a => normHp(a.hp) === hp);
      if (!acc.length) return res.status(404).json({ ok: false, error: 'No. HP belum terdaftar sebagai ' + (col === 'guru' ? 'guru les' : 'murid / orang tua') });
      const ok = acc.find(a => a.pinHash && a.pinHash === hashPin(a.id, b.pin));
      if (!ok) return res.status(401).json({ ok: false, error: acc.some(a => a.pinHash) ? 'PIN salah' : 'Akun belum punya PIN — minta admin membuatkan PIN' });
      if (ok.nonaktif) return res.status(403).json({ ok: false, error: 'Akun ini sedang dinonaktifkan admin.' });
      return res.json({ ok: true, token: tokenFor(col === 'guru' ? 'g' : 'o', ok.id), id: ok.id });
    }
    if (op === 'register') {
      const col = b.col; if (!['guru', 'ortu'].includes(col)) return res.status(400).json({ ok: false });
      const d = b.doc || {}; if (!okId(d.id) || !/^\d{6}$/.test(b.pin || '') || !normHp(d.hp)) return res.status(400).json({ ok: false, error: 'Data belum lengkap' });
      const [arr] = await redis([['HVALS', P + col]]);
      if ((arr || []).some(x => normHp(JSON.parse(x).hp) === normHp(d.hp))) return res.status(409).json({ ok: false, error: 'No. HP ini sudah terdaftar — silakan Masuk' });
      if (await getDoc(col, d.id)) return res.status(409).json({ ok: false });
      const doc = { ...d, pinHash: hashPin(d.id, b.pin), verif: false, nonaktif: false, ...(col === 'guru' ? { verifStatus: 'Menunggu' } : {}) };
      const extras = (b.extras || []).filter(e => (e.col === 'murid' && e.doc?.ortuId === d.id) || (e.col === 'dokumen' && e.doc?.guruId === d.id)).filter(e => okId(e.doc.id));
      await setDocs([[col, doc], ...extras.map(e => [e.col, e.doc])]);
      return res.json({ ok: true, token: tokenFor(col === 'guru' ? 'g' : 'o', d.id) });
    }
    if (!auth) return res.status(401).json({ ok: false, error: 'Silakan masuk dulu' });
    const isA = auth.r === 'a';
    if (op === 'setpin') {
      const col = auth.r === 'g' ? 'guru' : 'ortu'; const a = await getDoc(col, auth.id); if (!a) return res.status(404).json({ ok: false });
      if (a.pinHash && a.pinHash !== hashPin(a.id, b.old || '')) return res.status(401).json({ ok: false, error: 'PIN lama salah' });
      if (!/^\d{6}$/.test(b.pin || '')) return res.status(400).json({ ok: false, error: 'PIN harus 6 angka' });
      await setDocs([[col, { ...a, pinHash: hashPin(a.id, b.pin) }]]); return res.json({ ok: true });
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
      const old = await getDoc(col, id);
      if ((col === 'guru' || col === 'ortu') && !isA) {
        const mine = (col === 'guru' && auth.r === 'g' && id === auth.id) || (col === 'ortu' && auth.r === 'o' && id === auth.id);
        if (!mine) return res.status(403).json({ ok: false, error: 'Tidak diizinkan' });
        if (op === 'del') return res.status(403).json({ ok: false });
      }
      if (col === 'dokumen' && !isA) {
        const gid = op === 'put' ? b.doc.guruId : old?.guruId;
        if (!(auth.r === 'g' && gid === auth.id) || (old && old.guruId !== auth.id)) return res.status(403).json({ ok: false });
      }
      if (col === 'game' && !isA) {
        const mid = op === 'put' ? b.doc.muridId : old?.muridId, mur = mid ? await getDoc('murid', mid) : null;
        if (auth.r !== 'o' || !mur || mur.ortuId !== auth.id || (old && old.ortuId !== auth.id) || (op === 'put' && (b.doc.ortuId !== auth.id || id !== 'gm_' + mid))) return res.status(403).json({ ok: false, error: 'Tidak diizinkan' });
      }
      if (col === 'murid' && auth.r === 'o') { const oid = op === 'put' ? b.doc.ortuId : old?.ortuId; if (oid !== auth.id && old) return res.status(403).json({ ok: false }); }
      if (op === 'del') { await redis([['HDEL', P + col, id], ['INCR', P + 'ver']]); return res.json({ ok: true }); }
      let doc = { ...b.doc };
      if (col === 'guru' || col === 'ortu') {
        doc.pinHash = old?.pinHash; // PIN hanya lewat setpin/resetpin
        if (!isA && old) for (const k of ['verif', 'verifStatus', 'verifAlasan', 'nonaktif']) { if (k === 'verif' || k === 'nonaktif') doc[k] = old[k]; }
        if (!isA && old && doc.verifStatus === 'Terverifikasi' && !old.verif) doc.verifStatus = old.verifStatus;
        if (!old && !isA) return res.status(403).json({ ok: false });
      }
      await setDocs([[col, doc]]); return res.json({ ok: true });
    }
    return res.status(400).json({ ok: false, error: 'op tidak dikenal' });
  } catch (e) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
};
