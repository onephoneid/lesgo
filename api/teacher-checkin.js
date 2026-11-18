const { randomBytes } = require('node:crypto');
const QRCode = require('qrcode');
const { redis, session, validId, problem } = require('./profile-media').shared;

const PREFIX = 'lg:teacher-checkin:v1:';
const TOKEN_TTL = 300;
const dayNow = () => new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0,10);
const tokenKey = code => PREFIX + 'qr:' + code;
const receiptKey = (kelas,day) => PREFIX + 'receipt:' + kelas + ':' + day;
const activeKey = (kelas,day) => PREFIX + 'active:' + kelas + ':' + day;
const historyKey = kelas => PREFIX + 'history:' + kelas;
const parse = raw => raw ? JSON.parse(raw) : null;

const liveClass = `
local function row(key,id)
  local raw=redis.call('HGET',key,id)
  return raw and cjson.decode(raw) or nil
end
local function eligible(k,teacher)
  if not k or k.guruId~=teacher or k.tipe~='Private' or k.nonaktif or k.status=='Tutup' or k.status=='Nonaktif' then return false end
  if k.mode=='Online' or k.lokasi=='Online' or type(k.murid)~='table' or #k.murid==0 then return false end
  local g=row('lg:guru',teacher)
  return g and not g.nonaktif
end
`;

const issueScript = liveClass + `
local k=row('lg:kelas',ARGV[1])
if not eligible(k,ARGV[2]) then return {'denied'} end
local old=redis.call('GET',KEYS[1])
if old then return {'done',old} end
if not redis.call('SET',KEYS[3],ARGV[3],'EX',ARGV[4],'NX') then return {'collision'} end
redis.call('SET',KEYS[2],ARGV[5],'EX',ARGV[4])
return {'ok'}
`;

const consumeScript = liveClass + `
local family=row('lg:ortu',ARGV[1])
local k=row('lg:kelas',ARGV[2])
if not family or family.nonaktif or not eligible(k,ARGV[3]) then return {'denied'} end
local owns=false
for _,id in ipairs(k.murid) do
  local child=row('lg:murid',id)
  if child and child.ortuId==ARGV[1] then owns=true; break end
end
if not owns then return {'denied'} end
if redis.call('GET',KEYS[3])~=ARGV[4] then return {'expired'} end
local old=redis.call('GET',KEYS[1])
if old then return {'done',old} end
if redis.call('GET',KEYS[2])~=ARGV[5] then return {'expired'} end
redis.call('SET',KEYS[1],ARGV[6])
redis.call('ZADD',KEYS[4],ARGV[7],ARGV[6])
redis.call('DEL',KEYS[2])
return {'ok',ARGV[6]}
`;

function isEligible(k) {
  return k?.tipe==='Private' && !k.nonaktif && !['Tutup','Nonaktif'].includes(k.status)
      && k.mode!=='Online' && k.lokasi!=='Online' && Array.isArray(k.murid) && k.murid.length;
}

function classesFor({user,data}) {
  if(user.r==='g')return (data.kelas||[]).filter(k=>isEligible(k)&&k.guruId===user.id);
  if(user.r!=='o')return [];
  const family=(data.ortu||[]).find(p=>p.id===user.id);
  if(!family||family.nonaktif)return [];
  const children=new Set((data.murid||[]).filter(m=>m.ortuId===user.id).map(m=>m.id));
  return (data.kelas||[]).filter(k=>isEligible(k)&&k.murid.some(id=>children.has(id)));
}

function names(receipt,actor) {
  const k=(actor.data.kelas||[]).find(k=>k.id===receipt.classId);
  const g=(actor.data.guru||[]).find(g=>g.id===receipt.teacherId);
  return { day:receipt.day, arrivedAt:receipt.arrivedAt, className:k?.nama||'Kelas privat', teacherName:g?.nama||'Guru', classId:receipt.classId };
}

async function issue(classId,actor) {
  const day=dayNow();
  const teacher=actor.user.id;
  for(let attempt=0;attempt<3;attempt++){
    const code=randomBytes(6).toString('hex').toUpperCase();
    const now=Date.now();
    const midnight=Date.parse(day+'T17:00:00.000Z');
    const expiresAt=Math.min(now+TOKEN_TTL*1000,midnight);
    const ttl=Math.max(1,Math.ceil((expiresAt-now)/1000));
    const token=JSON.stringify({classId,teacher,day,expiresAt});
    const qr=await QRCode.toDataURL('LESGO-HADIR:'+code,{errorCorrectionLevel:'M',margin:3,width:290});
    const [status,receipt]=await redis('EVAL',issueScript,3,receiptKey(classId,day),activeKey(classId,day),tokenKey(code),classId,teacher,token,ttl,code);
    if(status==='done')return {receipt:names(parse(receipt),actor)};
    if(status==='denied')problem(403,'Kelas privat tatap muka ini belum aktif.');
    if(status==='ok')return {qr,code,expiresAt};
  }
  problem(503,'Kode belum terbentuk. Coba lagi.');
}

async function scan(value,actor,classes) {
  const code=String(value||'').trim().toUpperCase().replace(/^LESGO-HADIR:/,'').replace(/[\s-]/g,'');
  if(!/^[A-F0-9]{12}$/.test(code))problem(400,'Gunakan QR LesGo atau kode 12 karakter dari guru.');
  const raw=await redis('GET',tokenKey(code));
  const token=parse(raw);
  const now=Date.now();
  if(!token||token.expiresAt<=now||token.day!==dayNow())problem(409,'QR sudah kedaluwarsa atau tidak berlaku. Minta guru membuka QR baru.');
  const {classId,teacher,day}=token;
  if(!classes.some(k=>k.id===classId&&k.guruId===teacher))problem(403,'QR ini bukan untuk kelas privat keluargamu.');
  const receipt={classId,teacherId:teacher,day,arrivedAt:now,guardianId:actor.user.id};
  const [status,finished]=await redis('EVAL',consumeScript,4,receiptKey(classId,day),activeKey(classId,day),tokenKey(code),historyKey(classId),actor.user.id,classId,teacher,raw,code,JSON.stringify(receipt),now);
  if(status==='denied')problem(403,'QR ini bukan untuk kelas privat keluargamu.');
  if(status==='expired')problem(409,'QR sudah tidak berlaku. Minta guru membuka QR terbaru.');
  return {receipt:names(parse(finished),actor),already:status==='done'};
}

module.exports=async(req,res)=>{
  res.setHeader('Cache-Control','private, no-store');
  if(req.method!=='POST')return res.status(405).json({ok:false});
  try{
    if(!req.headers.authorization)problem(401,'Masuk dulu untuk menggunakan absensi guru.');
    const actor=await session(req);
    if(!['g','o'].includes(actor.user.r))problem(403,'Absensi QR tersedia untuk guru, murid, dan wali murid.');
    const classes=classesFor(actor);
    const {op,classId,code}=req.body||{};
    if(op==='history'){
      const receipts=[];
      for(let i=0;i<classes.length;i+=25){
        const batch=classes.slice(i,i+25);
        const rows=await Promise.all(batch.map(k=>redis('ZREVRANGE',historyKey(k.id),0,14)));
        for(const row of rows)for(const raw of row)receipts.push(names(parse(raw),actor));
      }
      return res.json({ok:true,receipts:receipts.sort((a,b)=>b.arrivedAt-a.arrivedAt).slice(0,30)});
    }
    if(op==='scan'&&actor.user.r==='o'){
      if(!classes.length)problem(403,'Absensi QR tersedia bagi murid dan wali murid yang terdaftar di kelas privat tatap muka aktif.');
      return res.json({ok:true,...await scan(code,actor,classes)});
    }
    if(actor.user.r!=='g'||!validId(classId)||!classes.some(k=>k.id===classId))problem(403,'Pilih kelas privat tatap muka yang aktif.');
    if(op==='issue')return res.json({ok:true,...await issue(classId,actor)});
    if(op==='status'){
      const receipt=parse(await redis('GET',receiptKey(classId,dayNow())));
      return res.json({ok:true,receipt:receipt?names(receipt,actor):null});
    }
    problem(400,'Permintaan absensi tidak dikenal.');
  }catch(error){
    if(!error.status)console.error('LesGo teacher check-in:',error.name);
    return res.status(error.status||503).json({ok:false,error:error.status?error.message:'Absensi guru belum bisa diproses. Coba lagi.'});
  }
};
