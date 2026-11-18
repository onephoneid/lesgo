const { redis, session, validId, signed, removeBlob, prepare, validateUpload, cancel, problem, publicProfileMedia } = require('./profile-media').shared;

const KEY = 'lg:publications:v1:';
const categories = new Set(['blog', 'materi', 'info']);
const MAX_POSTS = 40;
const PUBLIC = '@public';
const PUBLIC_POSTS = KEY + 'public';
const PUBLIC_TEACHERS = KEY + 'public-teachers';
const PUBLIC_TTL = 5 * 60 * 1000;
const parse = value => value ? JSON.parse(value) : null;
const keyFor = teacher => KEY + teacher;
const pendingFor = (teacher, id) => KEY + 'upload:' + teacher + ':' + id;

// One Redis operation compares and updates the publication list and its upload reservation.
const commitScript = `
local entries=cjson.decode(redis.call('GET',KEYS[1]) or '[]')
local index
for i,item in ipairs(entries) do if item.id==ARGV[1] then index=i; break end end
local previous=index and entries[index] or nil
local incoming=ARGV[3]~='' and cjson.decode(ARGV[3]) or nil
if not incoming and not previous then return {'missing'} end
if previous and tostring(previous.version)~=ARGV[2] then return {'conflict'} end
if not previous and ARGV[2]~='0' then return {'conflict'} end
if not previous and #entries>=tonumber(ARGV[5]) then return {'limit'} end
if ARGV[4]~='' and redis.call('GET',KEYS[2])~=ARGV[4] then return {'upload'} end
local old=previous and previous.media and previous.media.path or ''
if incoming then
  if previous then
    incoming.createdAt=previous.createdAt
    incoming.version=previous.version+1
    if not incoming.media and not incoming.clearMedia then incoming.media=previous.media end
  else incoming.version=1 end
  incoming.clearMedia=nil
  if index then entries[index]=incoming else table.insert(entries,incoming) end
else table.remove(entries,index) end
if #entries==0 then redis.call('DEL',KEYS[1])
else redis.call('SET',KEYS[1],cjson.encode(entries)) end
if ARGV[4]~='' then redis.call('DEL',KEYS[2]) end
if incoming and incoming.audience=='@public' then
  redis.call('ZADD',KEYS[3],incoming.createdAt,ARGV[6])
else redis.call('ZREM',KEYS[3],ARGV[6]) end
local current=incoming and incoming.media and incoming.media.path or ''
return {'ok',old~=current and old or ''}
`;

function visibility(actor) {
  const { user, data } = actor;
  const ownChildren = new Set((data.murid || []).filter(m => m.ortuId === user.id).map(m => m.id));
  const classes = (data.kelas || []).filter(k => user.r === 'g'
    ? k.guruId === user.id
    : Array.isArray(k.murid) && k.murid.some(id => ownChildren.has(id)));
  const teacherIds = new Set(classes.map(k => k.guruId));
  const active = new Map((data.guru || []).filter(g => !g.nonaktif).map(g => [g.id,g.nama]));
  return { classes, teacherIds, active };
}

function allowed(post, actor, access) {
  if (actor.user.r === 'g') return post.teacher === actor.user.id;
  if (post.audience === PUBLIC) return access.active.has(post.teacher);
  return access.active.has(post.teacher) && access.classes.some(k =>
    k.guruId === post.teacher && (!post.audience || k.id === post.audience));
}

function safePost(post,access) {
  const { media, ...data } = post;
  return { ...data, hasMedia: !!media, mediaType: media?.mime || '',
    teacherName: access.active.get(post.teacher) || 'Guru',
    audienceName: post.audience === PUBLIC ? 'Publik' : post.audience ? access.classes.find(k => k.id === post.audience)?.nama || 'Kelas sebelumnya' : 'Semua murid guru ini' };
}

function readFields(body, access) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
  const { category, audience } = body;
  if (!categories.has(category) || !title || title.length > 100 || !text || text.length > 3500 || subject.length > 75) {
    problem(400, 'Pilih jenis publikasi. Isi judul dan isi tulisan sesuai batas karakter.');
  }
  if (audience === PUBLIC) {
    if (body.publicConfirmed !== true) problem(400,'Konfirmasi bahwa publikasi boleh dilihat semua orang.');
    return { title, text, subject, category, audience };
  }
  if (!access.classes.length || typeof audience !== 'string' || (audience && !access.classes.some(k => k.id === audience))) {
    problem(403, 'Pilih kelas yang kamu ajar.');
  }
  return { title, text, subject, category, audience };
}

async function listPosts(actor, access) {
  const teacherIds = actor.user.r === 'g' ? [actor.user.id] : [...access.teacherIds].filter(id => validId(id) && access.active.has(id));
  const posts = [];
  for (let i = 0; i < teacherIds.length; i += 40) {
    const values = await redis('MGET', ...teacherIds.slice(i,i+40).map(keyFor));
    values.forEach(value => {
      for (const post of parse(value) || []) if (allowed(post,actor,access)) posts.push(post);
    });
  }
  return posts.sort((a,b) => b.createdAt - a.createdAt).slice(0,100).map(post => safePost(post,access));
}

async function commit(teacher, id, version, post, uploadRaw='') {
  const key = pendingFor(teacher,id) + ':pending';
  const [status,old] = await redis('EVAL',commitScript,3,keyFor(teacher),key,PUBLIC_POSTS,id,String(version),post ? JSON.stringify(post) : '',uploadRaw,MAX_POSTS,teacher+':'+id);
  const messages = { missing:'Publikasi sudah dihapus.', conflict:'Publikasi berubah. Muat ulang dan coba lagi.', limit:'Batas 40 publikasi tercapai. Hapus publikasi lama untuk menambah yang baru.', upload:'Unggahan kedaluwarsa. Pilih kembali berkasnya.' };
  if (status!=='ok') problem(409,messages[status] || 'Perubahan belum tersimpan.');
  if (old) await removeBlob(old);
}

function readPage(value) {
  const page = value === undefined ? 0 : Number(value);
  if (!Number.isInteger(page) || page<0 || page>1000) problem(400,'Halaman tidak valid.');
  return page;
}
function visibleTeacher(id, raw) {
  const g=parse(raw);
  if (!g || g.id!==id || g.nonaktif) return null;
  return { id, name:g.nama, subjects:Array.isArray(g.mapel)?g.mapel:[], levels:Array.isArray(g.jenjang)?g.jenjang:[],
    city:g.kota || '', mode:g.mode || '', bio:g.bio || '', verified:g.verif === true };
}
async function getPublicTeacher(id) {
  if (!validId(id) || (await redis('ZSCORE',PUBLIC_TEACHERS,id))==null) return null;
  return visibleTeacher(id,await redis('HGET','lg:guru',id));
}
function publicPost(post,teacher) {
  // Build an explicit response rather than passing the class or internal metadata through.
  return { id:post.id, teacher:post.teacher, teacherName:teacher.name, title:post.title, text:post.text,
    category:post.category, subject:post.subject, createdAt:post.createdAt, mediaType:post.media?.mime || '' };
}
async function publicFeed(query) {
  const page=readPage(query.page);
  const size=16;
  const ids=await redis('ZREVRANGE',PUBLIC_POSTS,page*size,(page+1)*size);
  const pairs=ids.slice(0,size).map(item=>item.split(':')).filter(([teacher,id])=>validId(teacher)&&validId(id));
  const teachers=[...new Set(pairs.map(([teacher])=>teacher))];
  if (!teachers.length) return {posts:[],more:ids.length>size};
  const [people,entries]=await Promise.all([
    redis('HMGET','lg:guru',...teachers),redis('MGET',...teachers.map(keyFor))
  ]);
  const data=new Map(teachers.map((teacher,i)=>[teacher,{teacher:visibleTeacher(teacher,people[i]),posts:parse(entries[i]) || []}]));
  const posts=[];
  for (const [id,postId] of pairs) {
    const entry=data.get(id);
    const post=entry.posts.find(x=>x.id===postId && x.audience===PUBLIC);
    if (entry.teacher && post) posts.push(publicPost(post,entry.teacher));
  }
  return {posts,more:ids.length>size};
}
async function openPublic(query,res) {
  const id=query.guru;
  if (query.view==='feed') return res.json({ok:true,...await publicFeed(query)});
  if (query.view==='post' || query.view==='attachment') {
    if (!validId(id) || !validId(query.post)) problem(404,'Publikasi tidak tersedia.');
    const [raw,rawPosts]=await Promise.all([redis('HGET','lg:guru',id),redis('GET',keyFor(id))]);
    const teacher=visibleTeacher(id,raw);
    const post=(parse(rawPosts)||[]).find(p=>p.id===query.post && p.audience===PUBLIC);
    if (!teacher || !post) problem(404,'Publikasi tidak tersedia.');
    if (query.view==='attachment') {
      if (!post.media) problem(404,'Lampiran tidak tersedia.');
      return res.json({ok:true,url:await signed(post.media.path,'get',{},PUBLIC_TTL),mime:post.media.mime});
    }
    return res.json({ok:true,post:publicPost(post,teacher),profile:(await redis('ZSCORE',PUBLIC_TEACHERS,id))!=null});
  }
  if (query.view==='teachers') {
    const page=readPage(query.page),size=24;
    const ids=await redis('ZREVRANGE',PUBLIC_TEACHERS,page*size,(page+1)*size);
    const visible=ids.slice(0,size).filter(validId);
    const values=visible.length?await redis('HMGET','lg:guru',...visible):[];
    const teachers=values.map((raw,i)=>visibleTeacher(visible[i],raw)).filter(Boolean);
    return res.json({ok:true,teachers,more:ids.length>size});
  }
  if (query.view==='teacher') {
    const teacher=await getPublicTeacher(id);
    if (!teacher) problem(404,'Profil guru belum tersedia untuk publik.');
    const [picture,portfolio]=await publicProfileMedia(id);
    const media = await Promise.all([
      picture?.path ? signed(picture.path,'get',{},PUBLIC_TTL) : '',
      portfolio?.path ? signed(portfolio.path,'get',{},PUBLIC_TTL) : ''
    ]);
    return res.json({ok:true,teacher,photoUrl:media[0],portfolio:portfolio?{title:portfolio.title,description:portfolio.description,url:media[1]}:null});
  }
  problem(404,'Halaman publik tidak tersedia.');
}

module.exports = async (req,res) => {
  res.setHeader('Cache-Control','private, no-store');
  if (req.method==='GET') {
    try { return await openPublic(req.query || {},res); }
    catch(error) { return res.status(error.status || 503).json({ok:false,error:error.status ? error.message : 'Halaman publik belum bisa dimuat.'}); }
  }
  if (req.method!=='POST') return res.status(405).json({ok:false});
  try {
    const actor=await session(req);
    const { user }=actor;
    if (!['g','o'].includes(user.r)) problem(403,'Publikasi tersedia untuk guru, murid, dan orang tua.');
    const access=visibility(actor);
    const body=req.body || {};
    const { op, id, path, version }=body;
    if (op==='publicProfile') {
      if (user.r!=='g' || !access.active.has(user.id)) problem(403,'Profil publik hanya dapat diatur oleh guru.');
      if (typeof body.enabled==='boolean') {
        if (body.enabled) await redis('ZADD',PUBLIC_TEACHERS,Date.now(),user.id);
        else await redis('ZREM',PUBLIC_TEACHERS,user.id);
      }
      return res.json({ok:true,enabled:(await redis('ZSCORE',PUBLIC_TEACHERS,user.id))!=null});
    }
    if (op==='list') return res.json({ok:true,posts:await listPosts(actor,access)});
    if (!validId(id)) problem(400,'Publikasi tidak valid.');
    if (op==='media') {
      const teacher=body.teacher;
      if (!validId(teacher) || (user.r==='g' ? teacher!==user.id : !access.teacherIds.has(teacher))) problem(403,'Publikasi tidak tersedia.');
      const post=(parse(await redis('GET',keyFor(teacher))) || []).find(p=>p.id===id);
      if (!post || !allowed(post,actor,access) || !post.media) problem(404,'Lampiran tidak tersedia.');
      return res.json({ok:true,url:await signed(post.media.path,'get'),mime:post.media.mime});
    }
    if (user.r!=='g' || !access.active.has(user.id)) problem(403,'Publikasi hanya dapat dikelola oleh guru penulis.');
    const pendingKey=pendingFor(user.id,id);
    if (op==='prepare') {
      readFields(body,access);
      return res.json({ok:true,...await prepare(pendingKey,'publication',user.id,user.id,body)});
    }
    if (op==='cancel') {await cancel(pendingKey,path);return res.json({ok:true});}
    if (!Number.isSafeInteger(version) || version<0) problem(400,'Versi publikasi tidak valid.');
    if (op==='remove') {await commit(user.id,id,version,null);return res.json({ok:true});}
    if (op!=='save') problem(400,'Permintaan publikasi tidak dikenal.');
    const fields=readFields(body,access);
    const post={...fields,id,teacher:user.id,createdAt:Date.now(),clearMedia:body.clearMedia===true};
    let raw='';
    if (path) {
      raw=await redis('GET',pendingKey+':pending');
      const pending=parse(raw);
      if (!pending || pending.path!==path) problem(409,'Unggahan kedaluwarsa. Pilih kembali berkasnya.');
      await validateUpload(pendingKey,pending);
      post.media={path,mime:pending.mime};
    }
    await commit(user.id,id,version,post,raw);
    return res.json({ok:true});
  } catch(error) {
    if (!error.status) console.error('LesGo publications:',error.name);
    return res.status(error.status || 503).json({ok:false,error:error.status ? error.message : 'Publikasi belum bisa diproses. Coba lagi.'});
  }
};
