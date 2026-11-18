const { createHash, createHmac, randomInt, timingSafeEqual } = require('node:crypto');

const redisUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const apiKey = process.env.RESEND_API_KEY;
const from = process.env.LESGO_EMAIL_FROM;
const gmailAddress = process.env.LESGO_GMAIL_ADDRESS?.trim();
const gmailPassword = process.env.LESGO_GMAIL_APP_PASSWORD?.replace(/\s/g, '');
const gmailEnabled = /^[a-z0-9.]+@gmail\.com$/i.test(gmailAddress || '') && Boolean(gmailPassword);
const resendEnabled = Boolean(apiKey && from);
const enabled = Boolean(redisUrl && redisToken && (gmailEnabled || resendEnabled));
const sha = value => createHash('sha256').update(value).digest('hex');
const mac = value => createHmac('sha256', redisToken).update(value).digest('base64url');
const equal = (a, b) => timingSafeEqual(Buffer.from(sha(a)), Buffer.from(sha(b)));

async function redis(...command) {
  const response = await fetch(redisUrl, {
    method: 'POST', signal: AbortSignal.timeout(4000),
    headers: { Authorization: 'Bearer ' + redisToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  if (!response.ok) throw new Error('Redis request failed');
  const { result, error } = await response.json();
  if (error) throw new Error('Redis command failed');
  return result;
}

async function account(role, id) {
  if (!['o', 'g'].includes(role) || typeof id !== 'string' || !/^[\w:.@+~-]{1,120}$/.test(id)) return null;
  const raw = await redis('HGET', role === 'g' ? 'lg:guru' : 'lg:ortu', id);
  const doc = raw && JSON.parse(raw);
  return doc?.pinHash && !doc.nonaktif ? doc : null;
}

async function session(req) {
  const [body, signature, extra] = String(req.headers.authorization || '').replace(/^Bearer /, '').split('.');
  if (!body || !signature || extra || !equal(signature, mac(body))) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
  if (!Number.isFinite(payload.exp) || payload.exp < Date.now()) return null;
  const doc = await account(payload.r, payload.id);
  if (!doc || payload.pv !== sha(doc.pinHash)) return null;
  return payload;
}

function issueSession(role, doc) {
  const body = Buffer.from(JSON.stringify({
    r: role, id: doc.id, pv: sha(doc.pinHash), exp: Date.now() + 12 * 60 * 60 * 1000,
  })).toString('base64url');
  return body + '.' + mac(body);
}

async function sendCode(email, otp) {
  const subject = 'Kode verifikasi LesGo!';
  const text = 'Kode LesGo! Anda: ' + otp + '. Kode berlaku 10 menit dan hanya bisa dipakai sekali. Jika Anda tidak meminta kode ini, abaikan email ini.';
  if (gmailEnabled) {
    const transport = require('nodemailer').createTransport({
      host: 'smtp.gmail.com', port: 465, secure: true,
      auth: { user: gmailAddress, pass: gmailPassword },
      connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 7000,
      disableFileAccess: true, disableUrlAccess: true,
    });
    const result = await transport.sendMail({
      from: { name: 'LesGo!', address: gmailAddress }, to: { address: email },
      envelope: { from: gmailAddress, to: [email] }, subject, text,
      signal: AbortSignal.timeout(12000),
    });
    return result.accepted.includes(email);
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST', signal: AbortSignal.timeout(8000),
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [email], subject, text }),
  });
  return response.ok;
}

const limitScript = "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n";
const consumeScript = `
local expected=redis.call('GET',KEYS[1])
if not expected then return 0 end
if expected~=ARGV[1] then
  local n=redis.call('INCR',KEYS[2])
  if n==1 then redis.call('EXPIRE',KEYS[2],600) end
  if n>=5 then redis.call('DEL',KEYS[1]) end
  return 0
end
if ARGV[2]~='' then
  local owner=redis.call('GET',KEYS[3])
  local email=redis.call('GET',KEYS[4])
  if (owner and owner~=ARGV[2]) or (email and email~=KEYS[3]) then return -1 end
  redis.call('SET',KEYS[3],ARGV[2])
  redis.call('SET',KEYS[4],KEYS[3])
end
redis.call('DEL',KEYS[1],KEYS[2])
return 1
`;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const reply = (status, data) => res.status(status).json(data);
  const fail = (status, error) => reply(status, { ok: false, error });
  if (req.method === 'GET') return reply(200, { enabled });
  if (req.method !== 'POST') return fail(405, 'Metode tidak didukung.');
  if (!enabled) return fail(503, 'Pengiriman kode email belum aktif.');
  const { mode, action, role, code } = req.body || {};
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!['link', 'login'].includes(mode) || !['send', 'verify'].includes(action) ||
      !['g', 'o'].includes(role) || email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(email)) {
    return fail(400, 'Masukkan alamat email yang valid.');
  }
  try {
    const auth = mode === 'link' ? await session(req) : null;
    if (mode === 'link' && (!auth || auth.r !== role)) return fail(401, 'Masuk dengan No. HP dan PIN terlebih dahulu.');
    const emailKey = 'lg:email:' + role + ':' + mac(email);
    const owner = await redis('GET', emailKey);
    const accountId = auth?.id || owner;
    const ownerKey = 'lg:email-owner:' + role + ':' + accountId;
    const current = mode === 'link' && await redis('GET', ownerKey);
    if (mode === 'link' && ((current && current !== emailKey) || (owner && owner !== auth.id))) {
      return fail(409, 'Email tidak bisa ditautkan. Hubungi admin LesGo.');
    }
    const doc = accountId && await account(role, accountId);
    const key = 'lg:email-code:' + mode + ':' + emailKey + ':' + (accountId || 'unknown');
    const attempts = key + ':attempts';
    const invalidCode = () => fail(400, 'Kode salah atau kedaluwarsa. Minta kode baru.');
    if (action === 'verify') {
      if (!doc || typeof code !== 'string' || !/^\d{6}$/.test(code)) return invalidCode();
      const digest = mac(JSON.stringify([key, doc.pinHash, code]));
      const result = await redis('EVAL', consumeScript, 4, key, attempts, emailKey, ownerKey, digest, auth?.id || '');
      if (result === -1) return fail(409, 'Email tidak bisa ditautkan. Hubungi admin LesGo.');
      if (result !== 1) return invalidCode();
      return reply(200, { ok: true, ...(auth ? {} : { token: issueSession(role, doc) }) });
    }

    const accepted = () => reply(200, { ok: true });
    const ip = String(req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
    const ipCount = await redis('EVAL', limitScript, 1, 'lg:email-ip:' + mac(ip), 3600);
    if (ipCount > 12) return fail(429, 'Terlalu banyak permintaan kode. Coba lagi nanti.');
    if (!doc) return accepted();
    const cooldown = await redis('SET', 'lg:email-cooldown:' + mac(email), '1', 'NX', 'EX', 60);
    if (!cooldown) return accepted();
    const emailCount = await redis('EVAL', limitScript, 1, 'lg:email-limit:' + mac(email), 3600);
    const globalCount = await redis('EVAL', limitScript, 1, 'lg:email-day:' + new Date().toISOString().slice(0, 10), 86400);
    if (emailCount > 4 || globalCount > 80) return fail(429, 'Batas pengiriman kode tercapai. Coba lagi nanti.');
    const otp = String(randomInt(100000, 1000000));
    const digest = mac(JSON.stringify([key, doc.pinHash, otp]));
    await redis('SET', key, digest, 'EX', 600);
    await redis('DEL', attempts);
    let delivered;
    try { delivered = await sendCode(email, otp); } catch { delivered = false; }
    if (!delivered) {
      await redis('DEL', key);
      // Keep the login response uniform for registered and unregistered addresses.
      if (mode === 'link') return fail(503, 'Kode belum bisa dikirim. Coba lagi nanti.');
    }
    return accepted();
  } catch {
    return fail(503, 'Verifikasi email sedang tidak tersedia. Coba lagi nanti.');
  }
};
