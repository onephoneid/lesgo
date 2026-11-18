const { createHash, randomUUID } = require('node:crypto');
const { redis, session, validId, problem } = require('./profile-media').shared;
const prefix = 'lg:lesgo-payment:v1:';
const bankConfig = prefix+'current-bank';
const banks = prefix+'bank-versions';
const teacherBanks = prefix+'teacher-banks';
const transfers = prefix+'transfers';
const pending = prefix+'pending';
const matched = prefix+'matched';
const parse = value => value ? JSON.parse(value) : null;
const clean = (value,length) => typeof value==='string' ? value.trim().slice(0,length+1) : '';
const today = () => new Date(Date.now()+25200000).toISOString().slice(0,10);

function bankFields(body) {
  const bank=clean(body.bank,45), holder=clean(body.holder,90);
  const number=typeof body.number==='string'?body.number.trim().replace(/[ -]/g,''):'';
  if(!bank||bank.length>45||!holder||holder.length>90||!/^[0-9]{6,24}$/.test(number)){
    problem(400,'Isi nama bank, nama pemilik, dan nomor rekening 6–24 angka.');
  }
  return {bank,holder,number};
}

function ownedInvoice(actor,id) {
  if(actor.user.r!=='o'||!validId(id))problem(403,'Tagihan tidak tersedia.');
  const invoice=(actor.data.spp||[]).find(x=>x.id===id);
  if(!invoice||(actor.data.murid||[]).every(m=>m.id!==invoice.muridId||m.ortuId!==actor.user.id))problem(403,'Tagihan tidak tersedia.');
  return invoice;
}

const submitScript = `
local invoiceRaw=redis.call('HGET','lg:spp',ARGV[1])
if not invoiceRaw then return {'invoice'} end
local invoice=cjson.decode(invoiceRaw)
local childRaw=redis.call('HGET','lg:murid',invoice.muridId)
if not childRaw or cjson.decode(childRaw).ortuId~=ARGV[2] then return {'invoice'} end
local accRaw=redis.call('HGET',KEYS[3],ARGV[3])
if not accRaw then return {'bank'} end
local previous=redis.call('HGET',KEYS[1],ARGV[1])
if previous then
  local status=cjson.decode(previous).status
  if status=='pending' or status=='verified' then return {'already',previous} end
end
if invoice.status~='Belum' or tonumber(invoice.nominal)~=tonumber(ARGV[4]) then return {'invoice'} end
local record=cjson.decode(ARGV[5])
record.classId=invoice.kelasId
record.studentId=invoice.muridId
record.month=invoice.bulan
record.amount=invoice.nominal
local bank=cjson.decode(accRaw)
record.destination=bank.bank..' · '..bank.holder..' · ••••'..string.sub(bank.number,-4)
local saved=cjson.encode(record)
redis.call('HSET',KEYS[1],ARGV[1],saved)
redis.call('ZADD',KEYS[2],ARGV[6],ARGV[1])
return {'ok',saved}
`;

const reviewScript = `
local raw=redis.call('HGET',KEYS[1],ARGV[1])
if not raw then return {'missing'} end
local record=cjson.decode(raw)
if record.id~=ARGV[2] then return {'changed'} end
if record.status~='pending' then return {'already',raw} end
if ARGV[3]=='verify' then
  local invoiceRaw=redis.call('HGET','lg:spp',ARGV[1])
  if not invoiceRaw then return {'invoice'} end
  local invoice=cjson.decode(invoiceRaw)
  local childRaw=redis.call('HGET','lg:murid',invoice.muridId)
  if not childRaw or cjson.decode(childRaw).ortuId~=record.owner or invoice.muridId~=record.studentId or invoice.kelasId~=record.classId then return {'invoice'} end
  if invoice.status~='Belum' or tonumber(invoice.nominal)~=tonumber(record.amount) or tonumber(record.amount)~=tonumber(ARGV[4]) then return {'invoice'} end
  local used=redis.call('HGET',KEYS[3],ARGV[5])
  if used and used~=record.id then return {'duplicate'} end
  invoice.status='Lunas'
  invoice.bayar=ARGV[8]
  invoice.metode='Transfer ke LesGo'
  invoice.ref=''
  record.status='verified'
  record.bankMatch=ARGV[6]
  redis.call('HSET',KEYS[3],ARGV[5],record.id)
  redis.call('HSET','lg:spp',ARGV[1],cjson.encode(invoice))
  redis.call('INCR','lg:ver')
else
  record.status='rejected'
  record.reason=ARGV[6]
end
record.reviewedAt=tonumber(ARGV[7])
record.reviewer=ARGV[9]
local updated=cjson.encode(record)
redis.call('HSET',KEYS[1],ARGV[1],updated)
redis.call('ZREM',KEYS[2],ARGV[1])
return {'ok',updated}
`;

const publishBankScript = `
redis.call('HSET',KEYS[1],ARGV[1],ARGV[2])
redis.call('SET',KEYS[2],ARGV[1])
return 1
`;

function familyRecord(record,owner) {
  if(!record||record.owner!==owner)return null;
  const {status,amount,reason,ref,destination,createdAt}=record;
  return {status,amount,reason,ref,destination,createdAt};
}

async function familyPayment(actor,body) {
  const invoice=ownedInvoice(actor,body.invoiceId);
  if(body.op==='invoice') {
    const [id,raw]=await Promise.all([redis('GET',bankConfig),redis('HGET',transfers,invoice.id)]);
    const destination=id?parse(await redis('HGET',banks,id)):null;
    return {bank:invoice.status==='Belum'?destination:null,transfer:familyRecord(parse(raw),actor.user.id),amount:invoice.nominal,status:invoice.status};
  }
  const bankId=body.bankId;
  const sender=clean(body.sender,90),ref=clean(body.ref,100);
  if(!validId(bankId)||!sender||sender.length>90||!ref||ref.length>100||!Number.isSafeInteger(body.amount)||body.amount<=0){
    problem(400,'Isi nama pengirim dan nomor referensi transfer dengan benar.');
  }
  const now=Date.now();
  const record={id:randomUUID(),invoiceId:invoice.id,owner:actor.user.id,bankId,sender,ref,status:'pending',createdAt:now};
  const [result,data]=await redis('EVAL',submitScript,3,transfers,pending,banks,invoice.id,actor.user.id,bankId,body.amount,JSON.stringify(record),now);
  if(result==='bank')problem(409,'Rekening tujuan tidak ditemukan. Hubungi admin LesGo.');
  if(result==='invoice')problem(409,'Tagihan berubah atau sudah lunas. Muat ulang halaman.');
  return {transfer:familyRecord(parse(data),actor.user.id),already:result==='already'};
}

async function review(actor,body) {
  const {invoiceId,id,decision,matchedDate}=body;
  if(!validId(invoiceId)||!validId(id)||!['verify','reject'].includes(decision))problem(400,'Data verifikasi tidak valid.');
  const transfer=parse(await redis('HGET',transfers,invoiceId));
  if(!transfer||transfer.id!==id)problem(409,'Pengajuan berubah. Muat ulang antrean.');
  const note=clean(body.note,140);
  if(note.length<3||note.length>140)problem(400,decision==='verify'?'Isi ID transaksi yang terlihat di mutasi bank.':'Isi alasan penolakan.');
  let match='';
  if(decision==='verify'){
    if(body.confirmed!==true)problem(400,'Konfirmasi bahwa transaksi ditemukan di mutasi rekening LesGo.');
    if(typeof matchedDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(matchedDate)||matchedDate>today()||!Number.isFinite(Date.parse(matchedDate))||new Date(matchedDate).toISOString().slice(0,10)!==matchedDate){
      problem(400,'Isi tanggal masuk yang valid sesuai mutasi.');
    }
    if(!Number.isSafeInteger(body.amount)||body.amount!==transfer.amount)problem(400,'Nominal di mutasi harus sama dengan nominal tagihan.');
    const bank=parse(await redis('HGET',banks,transfer.bankId));
    if(!bank)problem(409,'Data rekening tujuan tidak ditemukan.');
    const reference=note.toUpperCase().replace(/[^A-Z0-9]/g,'');
    if(reference.length<3)problem(400,'Isi referensi mutasi yang valid.');
    match=createHash('sha256').update([bank.bank.toUpperCase().replace(/[^A-Z0-9]/g,''),bank.number,reference].join(':')).digest('hex');
  }
  const [result,raw]=await redis('EVAL',reviewScript,3,transfers,pending,matched,invoiceId,id,decision,body.amount||0,match,note,Date.now(),matchedDate||'',actor.user.id);
  const messages={missing:'Pengajuan tidak ditemukan.',changed:'Pengajuan berubah. Muat ulang antrean.',invoice:'Tagihan berubah atau sudah lunas. Periksa tagihan sebelum konfirmasi.',duplicate:'Transaksi bank ini sudah dicocokkan dengan tagihan lain.'};
  if(!['ok','already'].includes(result))problem(409,messages[result]||'Verifikasi belum tersimpan.');
  return {status:parse(raw).status,already:result==='already'};
}

async function queue(actor) {
  const ids=await redis('ZREVRANGE',pending,0,49);
  const records=ids.length?await redis('HMGET',transfers,...ids):[];
  return {items:records.map(parse).filter(x=>x?.status==='pending').map(x=>{
    const k=(actor.data.kelas||[]).find(k=>k.id===x.classId);
    const g=(actor.data.guru||[]).find(g=>g.id===k?.guruId);
    return {id:x.id,invoiceId:x.invoiceId,amount:x.amount,sender:x.sender,ref:x.ref,destination:x.destination,month:x.month,createdAt:x.createdAt,className:k?.nama||'Kelas',teacher:g?.nama||'Guru'};
  })};
}

module.exports=async(req,res)=>{
  res.setHeader('Cache-Control','private, no-store');
  if(req.method!=='POST')return res.status(405).json({ok:false});
  try{
    if(!req.headers.authorization)problem(401,'Masuk dulu untuk membuka pembayaran.');
    const actor=await session(req),{user}=actor,body=req.body||{};
    let data;
    switch(body.op){
      case 'teacherBank':
        if(user.r!=='g'&&user.r!=='a')problem(403,'Rekening guru tidak tersedia.');
        if(user.r==='a'&&(!validId(body.teacher)||!(actor.data.guru||[]).some(g=>g.id===body.teacher)))problem(404,'Guru tidak ditemukan.');
        data={bank:parse(await redis('HGET',teacherBanks,user.r==='g'?user.id:body.teacher))};break;
      case 'updateTeacherBank':
        if(user.r!=='g')problem(403,'Hanya guru pemilik akun yang dapat menyimpan rekeningnya.');
        data={bank:bankFields(body)};
        await redis('HSET',teacherBanks,user.id,JSON.stringify(data.bank));break;
      case 'invoiceStates': {
        if(user.r!=='o'||!Array.isArray(body.ids)||body.ids.length>50)problem(403,'Status transfer tidak tersedia.');
        const allowed=new Set((actor.data.murid||[]).filter(m=>m.ortuId===user.id).map(m=>m.id));
        const owned=new Set((actor.data.spp||[]).filter(s=>allowed.has(s.muridId)).map(s=>s.id));
        const invoiceIds=body.ids.filter(id=>validId(id)&&owned.has(id));
        const rows=invoiceIds.length?await redis('HMGET',transfers,...invoiceIds):[];
        const statuses=new Map(invoiceIds.map((id,i)=>[id,familyRecord(parse(rows[i]),user.id)?.status||'']));
        data={statuses:body.ids.map(id=>statuses.get(id)||'')};break;
      }
      case 'invoice': case 'submit': data=await familyPayment(actor,body);break;
      default:{
        if(user.r!=='a')problem(403,'Fitur ini hanya untuk admin LesGo.');
        if(body.op==='adminBank'){
          const id=await redis('GET',bankConfig);
          data={bank:id?parse(await redis('HGET',banks,id)):null};
        }else if(body.op==='updateBank'){
          const bank={...bankFields(body),id:randomUUID()};
          await redis('EVAL',publishBankScript,2,banks,bankConfig,bank.id,JSON.stringify(bank));
          data={bank};
        }else if(body.op==='queue')data=await queue(actor);
        else if(body.op==='review')data=await review(actor,body);
        else problem(400,'Permintaan pembayaran tidak dikenal.');
      }
    }
    return res.json({ok:true,...data});
  }catch(error){
    if(!error.status)console.error('LesGo payment:',error.name);
    return res.status(error.status||503).json({ok:false,error:error.status?error.message:'Pembayaran belum dapat diproses. Coba lagi.'});
  }
};
