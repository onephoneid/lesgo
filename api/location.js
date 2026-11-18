// Explicit place search only; shared cache and throttle protect the public geocoder.
const crypto = require('crypto');
const redisUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const googleHosts = new Set(['maps.app.goo.gl', 'goo.gl', 'maps.google.com', 'www.google.com', 'google.com', 'www.google.co.id', 'google.co.id', 'maps.google.co.id']);
function mapsUrl(raw) {
  try { const u = new URL(raw); return u.protocol === 'https:' && !u.port && !u.username && !u.password && googleHosts.has(u.hostname) ? u : null; } catch { return null; }
}
function coords(raw) {
  let s = String(raw || ''); try { s = decodeURIComponent(s); } catch {}
  // Place coordinates take precedence over the map camera's @ coordinates.
  for (const pattern of [/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/, /[?&](?:q|ll|query|destination|center)=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/i, /@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/, /^\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\s*$/]) {
    const m = s.match(pattern); if (!m) continue; const lat = Number(m[1]), lng = Number(m[2]);
    if (lat > -11.5 && lat < 6.5 && lng > 94 && lng < 142) return { lat, lng };
  }
  return null;
}
async function redis(command) {
  if (!redisUrl || !redisToken) throw new Error('Pencarian lokasi belum dikonfigurasi.');
  const response = await fetch(redisUrl, { method: 'POST', headers: { Authorization: 'Bearer ' + redisToken, 'Content-Type': 'application/json' }, body: JSON.stringify(command), signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new Error('Pencarian lokasi sedang tidak tersedia.');
  const data = await response.json(); if (data.error) throw new Error('Pencarian lokasi sedang tidak tersedia.'); return data.result;
}
async function resolveMap(url) {
  for (let i = 0; i < 5; i++) {
    const point = coords(url.href); if (point) return [{ ...point, name: 'Titik dari Google Maps' }];
    const hasMapPath = url.pathname === '/maps' || url.pathname.startsWith('/maps/');
    if (hasMapPath || /^maps\.google\./.test(url.hostname)) {
      const namedQuery = url.searchParams.get('query') || url.searchParams.get('q');
      const namedPath = url.pathname.match(/\/maps\/(?:place|search)\/([^/]+)/)?.[1];
      const name = namedQuery || (namedPath && decodeURIComponent(namedPath).replace(/\+/g, ' '));
      if (name && !/^https?:/i.test(name)) return { search: name };
    }
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'LesGo/1.0 (+https://lesgo-mu.vercel.app)' } });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location'); await response.body?.cancel();
      if (!location) break; const next = mapsUrl(new URL(location, url).href);
      if (!next) throw new Error('Tautan mengarah ke layanan yang tidak didukung.'); url = next; continue;
    }
    await response.body?.cancel();
    break;
  }
  throw new Error('Titik pada tautan belum terbaca. Salin koordinat dari Google Maps atau cari nama tempatnya.');
}
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Gunakan POST' });
  const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
  if (query.length < 3 || query.length > 500) return res.status(400).json({ ok: false, error: 'Isi nama tempat atau tautan Google Maps yang valid.' });
  try {
    const isUrl = /^https?:\/\//i.test(query), url = isUrl ? mapsUrl(query) : null;
    if (isUrl && !url) return res.status(400).json({ ok: false, error: 'Gunakan tautan Google Maps HTTPS.' });
    const rawPoint = /^-?\d+(?:\.\d+)?,\s*-?\d+(?:\.\d+)?$/.test(query);
    const direct = (url || rawPoint) && coords(query);
    if (direct) return res.json({ ok: true, results: [{ ...direct, name: url ? 'Titik dari Google Maps' : 'Titik dari koordinat' }] });
    if (rawPoint) return res.status(400).json({ ok: false, error: 'Pilih titik di Indonesia.' });
    const key = 'lg:location:' + crypto.createHash('sha256').update(query.toLowerCase()).digest('hex');
    const cached = await redis(['GET', key]); if (cached) return res.json({ ok: true, results: JSON.parse(cached) });
    // Fixed windows limit abuse without retaining raw IP addresses.
    const ip = String(req.headers['x-forwarded-for'] || 'unknown').split(',')[0];
    const bucket = crypto.createHash('sha256').update(ip + ':' + Math.floor(Date.now() / 600000)).digest('hex');
    const count = await redis(['INCR', 'lg:location-limit:' + bucket]);
    if (count === 1) await redis(['EXPIRE', 'lg:location-limit:' + bucket, 660]);
    if (count > 20) return res.status(429).json({ ok: false, error: 'Terlalu banyak pencarian. Coba lagi beberapa menit lagi.' });
    let result = url ? await resolveMap(url) : { search: query };
    if (result.search) {
      if (!await redis(['SET', 'lg:nominatim-throttle', '1', 'NX', 'PX', 1100])) return res.status(429).json({ ok: false, error: 'Pencarian sedang sibuk. Coba lagi sebentar.' });
      const endpoint = new URL('https://nominatim.openstreetmap.org/search');
      endpoint.search = new URLSearchParams({ q: result.search, format: 'jsonv2', countrycodes: 'id', limit: '5', 'accept-language': 'id' }).toString();
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(6000), headers: { 'User-Agent': 'LesGo/1.0 (+https://lesgo-mu.vercel.app)', Accept: 'application/json' } });
      if (!response.ok) throw new Error('Pencarian nama tempat sedang tidak tersedia. Pilih titik langsung di peta.');
      result = (await response.json()).map(x => ({ name: String(x.display_name), lat: Number(x.lat), lng: Number(x.lon) })).filter(x => coords(x.lat + ',' + x.lng));
    }
    await redis(['SET', key, JSON.stringify(result), 'EX', 86400]);
    return res.json({ ok: true, results: result });
  } catch (e) { return res.status(502).json({ ok: false, error: e.name === 'TimeoutError' ? 'Pencarian terlalu lama. Coba lagi atau pilih titik di peta.' : e.message }); }
};
module.exports.coords = coords;
module.exports.mapsUrl = mapsUrl;
