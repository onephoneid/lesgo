const { randomUUID } = require('node:crypto');
const { issueSignedToken, presignUrl, parseStoreIdFromPresignedUrl, head, del, BlobNotFoundError } = require('@vercel/blob');
const db = require('./db');

const redisUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const KEY = 'lg:profile-media:v1:';
const MAX_VIDEO = 25 * 1024 * 1024;
const MAX_PHOTO = 256 * 1024;
const UPLOAD_TTL = 5 * 60 * 1000;
const validId = id => typeof id === 'string' && /^[\w-]{1,100}$/.test(id);
const parse = value => value ? JSON.parse(value) : null;

function problem(status, message) {
  throw Object.assign(new Error(message), { status });
}

async function redis(...command) {
  const result = await fetch(redisUrl, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + redisToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(6000)
  });
  const reply = await result.json();
  if (!result.ok || reply.error) throw new Error('Media storage failed');
  return reply.result;
}

async function session(req) {
  const authorization = req.headers.authorization;
  if (!authorization?.startsWith('Bearer ') || authorization.length > 2048) problem(401, 'Masuk dulu untuk membuka media profil.');
  let snapshot, status = 200;
  await db({ method: 'GET', query: { op: 'all' }, headers: { authorization }, body: {} }, {
    setHeader() {},
    status(code) { status = code; return this; },
    json(result) { snapshot = result; }
  });
  if (status >= 500) problem(503, 'Sesi belum bisa diperiksa. Coba lagi.');
  if (!snapshot?.ok || !snapshot.me?.id) problem(401, 'Sesi berakhir. Silakan masuk lagi.');
  return { user: snapshot.me, data: snapshot.data || {} };
}

function target(scope, id, { user, data }, editing) {
  if (!validId(id)) problem(400, 'Profil tidak valid.');
  if (scope === 'guru' || scope === 'portfolio') {
    const owned = user.r === 'g' && user.id === id;
    if (editing ? !owned : !owned && !(data.guru || []).some(g => g.id === id && !g.nonaktif)) problem(403, 'Profil guru tidak tersedia.');
  } else if (scope === 'keluarga') {
    if (user.r !== 'o' || user.id !== id) problem(403, 'Foto ini hanya untuk akun keluarga.');
  } else if (scope === 'murid') {
    if (user.r !== 'o' || !(data.murid || []).some(m => m.id === id && m.ortuId === user.id)) problem(403, 'Foto ini hanya untuk akun keluarga.');
  } else problem(400, 'Jenis profil tidak valid.');
  return KEY + scope + ':' + id;
}

function details(body) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  if (!title || title.length > 80 || description.length > 1000) problem(400, 'Isi judul maksimal 80 karakter dan deskripsi maksimal 1.000 karakter.');
  return { title, description };
}

async function signed(pathname, operation, constraints = {}, readTtl = 60 * 60 * 1000) {
  const validUntil = Date.now() + (operation === 'put' ? UPLOAD_TTL : readTtl);
  const token = await issueSignedToken({ pathname, operations: [operation], validUntil, ...constraints });
  const { presignedUrl } = await presignUrl(token, {
    access: 'private', operation, pathname, validUntil, ...constraints,
    ...(operation === 'put' ? { allowOverwrite: false, addRandomSuffix: false } : {})
  });
  return presignedUrl;
}

async function present(record) {
  if (!record) return null;
  const { path, title, description } = record;
  const url = path ? await signed(path, 'get') : '';
  return { url, title, description };
}

async function removeBlob(path) {
  if (path) try { await del(path); } catch { console.warn('Old LesGo profile media could not be removed'); }
}

async function prepare(key, scope, id, userId, body) {
  const videos = { 'video/mp4': 'mp4', 'video/webm': 'webm' };
  const types = scope === 'portfolio' ? videos : scope === 'publication' ? { ...videos, 'image/jpeg': 'jpg' } : { 'image/jpeg': 'jpg' };
  const maximumSizeInBytes = videos[body.mime] ? MAX_VIDEO : MAX_PHOTO;
  const mime = body.mime;
  if (typeof mime !== 'string' || !Object.hasOwn(types, mime) || !Number.isInteger(body.size) || body.size < 1 || body.size > maximumSizeInBytes) {
    problem(400, scope === 'publication' ? 'Pilih foto JPEG hingga 256 KB atau video MP4/WebM hingga 25 MB.' : scope === 'portfolio' ? 'Pilih video MP4/WebM hingga 25 MB.' : 'Pilih foto JPEG hingga 256 KB.');
  }
  const attempts = await redis('EVAL', "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],3600) end; return n", 1, KEY + 'rate:' + userId);
  if (attempts > 15) problem(429, 'Terlalu banyak percobaan unggah. Coba lagi nanti.');
  const path = 'profiles/' + scope + '/' + id + '/' + randomUUID() + '.' + types[mime];
  const pending = JSON.stringify({ path, mime, size: body.size, ...(scope === 'portfolio' ? details(body) : {}) });
  if (!await redis('SET', key + ':pending', pending, 'NX', 'EX', 360)) problem(409, 'Unggahan lain sedang diproses. Selesaikan atau batalkan dulu.');
  try {
    const uploadUrl = await signed(path, 'put', { allowedContentTypes: [mime], maximumSizeInBytes: body.size });
    const delegationToken = new URL(uploadUrl).searchParams.get('vercel-blob-delegation');
    return { path, uploadUrl, storeId: parseStoreIdFromPresignedUrl({ delegationToken }) };
  } catch (error) {
    await redis('DEL', key + ':pending');
    throw error;
  }
}

async function checkFile(imageUrl, mime) {
  const result = await fetch(imageUrl, { headers: { Range: 'bytes=0-31' }, signal: AbortSignal.timeout(6000) });
  if (!result.ok || !result.body) return false;
  const reader = result.body.getReader();
  let prefix = Buffer.alloc(0);
  try {
    while (prefix.length < 12) {
      const next = await reader.read();
      if (next.done) break;
      prefix = Buffer.concat([prefix, Buffer.from(next.value.subarray(0, 12 - prefix.length))]);
    }
  } finally { await reader.cancel().catch(() => {}); }
  if (mime === 'image/jpeg') return prefix.subarray(0, 3).toString('hex') === 'ffd8ff';
  if (mime === 'video/webm') return prefix.subarray(0, 4).toString('hex') === '1a45dfa3';
  return prefix.subarray(4, 8).toString() === 'ftyp';
}

async function validateUpload(key, pending) {
  const { path, mime, size } = pending;
  let file;
  try { file = await head(path); }
  catch (error) {
    if (error instanceof BlobNotFoundError) problem(400, 'Berkas belum berhasil diunggah.');
    throw error;
  }
  if (file.size !== size || file.contentType !== mime || !await checkFile(await signed(path, 'get'), mime)) {
    await cancel(key, path);
    problem(400, 'Isi atau format berkas tidak sesuai.');
  }
}

async function finish(key, path) {
  const raw = await redis('GET', key + ':pending');
  const pending = parse(raw);
  if (pending?.path !== path || !pending) {
    const current = parse(await redis('GET', key));
    if (current?.path === path && current?.path) return present(current);
    problem(409, 'Unggahan kedaluwarsa. Pilih kembali berkasnya.');
  }
  await validateUpload(key, pending);
  const record = { path, ...(pending.title ? { title: pending.title, description: pending.description } : {}) };
  const result = await redis('EVAL', "if redis.call('GET',KEYS[2])~=ARGV[1] then return {0} end; local old=redis.call('GET',KEYS[1]); redis.call('SET',KEYS[1],ARGV[2]); redis.call('DEL',KEYS[2]); return {1,old or ''}", 2, key, key + ':pending', raw, JSON.stringify(record));
  if (!result[0]) {
    const current = parse(await redis('GET', key));
    if (current?.path === path) return present(current);
    problem(409, 'Unggahan sudah berubah. Coba lagi.');
  }
  await removeBlob(parse(result[1])?.path);
  return present(record);
}

async function cancel(key, path) {
  const raw = await redis('GET', key + ':pending');
  if (!raw || parse(raw)?.path !== path) return;
  const removed = await redis('EVAL', "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0", 1, key + ':pending', raw);
  if (removed) await removeBlob(path);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  try {
    const actor = await session(req);
    if (!redisUrl || !redisToken || !process.env.BLOB_READ_WRITE_TOKEN) problem(503, 'Media profil sedang tidak tersedia.');
    const body = req.body || {};
    const { op, scope, id, path } = body;
    if (op === 'avatars') {
      if (!Array.isArray(body.items) || body.items.length > 30) problem(400, 'Daftar profil tidak valid.');
      const requested = body.items.map(({scope,id})=>{
        if (scope === 'portfolio') problem(400, 'Jenis foto tidak valid.');
        return target(scope,id,actor,false);
      });
      const values = requested.length ? await redis('MGET', ...requested) : [];
      const urls = await Promise.allSettled(values.map(async item => (await present(parse(item)))?.url || ''));
      return res.json({ ok: true, urls: urls.map(item => item.status === 'fulfilled' ? item.value : '') });
    }
    const key = target(scope,id,actor,op!=='get');
    if (op === 'get') return res.json({ ok:true, record:await present(parse(await redis('GET',key))) });
    if (op === 'prepare') return res.json({ ok:true, ...await prepare(key,scope,id,actor.user.id,body) });
    if (op === 'finish') return res.json({ ok:true, record:await finish(key,path) });
    if (op === 'cancel') { await cancel(key,path); return res.json({ ok:true }); }
    if (op === 'remove') {
      const old = await redis('GETDEL', key);
      await removeBlob(parse(old)?.path);
      return res.json({ ok:true });
    }
    if (op === 'save' && scope === 'portfolio') {
      const fields = details(body);
      const raw = await redis('EVAL', "local old=redis.call('GET',KEYS[1]); local value=cjson.decode(ARGV[1]); if old then value.path=cjson.decode(old).path end; local result=cjson.encode(value); redis.call('SET',KEYS[1],result); return result", 1, key, JSON.stringify(fields));
      return res.json({ ok:true, record:await present(parse(raw)) });
    }
    problem(400, 'Permintaan media tidak dikenal.');
  } catch (error) {
    if (!error.status) console.error('LesGo media operation:', error.name);
    return res.status(error.status || 503).json({ ok:false,error:error.status ? error.message : 'Media profil belum bisa diproses. Coba lagi.' });
  }
};

async function publicProfileMedia(id) {
  return (await redis('MGET', KEY+'guru:'+id, KEY+'portfolio:'+id)).map(parse);
}

module.exports.shared = { publicProfileMedia, redis, session, validId, signed, removeBlob, prepare, validateUpload, cancel, problem };
