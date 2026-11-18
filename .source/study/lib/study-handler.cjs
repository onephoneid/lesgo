const {randomUUID,createHash,randomInt,createHmac,timingSafeEqual}=require('node:crypto');
const {redis:storedRedis,session,problem}=require('./profile-media').shared;
const previewOnly=process.env.VERCEL_ENV==='preview'&&!process.env.KV_REST_API_URL&&!process.env.UPSTASH_REDIS_REST_URL;
async function redis(op,...args){
 if(previewOnly){if(op==='HVALS'&&args[0]==='lg:study:v1:courses')return [];if(op==='HGET'&&args[0]==='lg:study:v1:courses')return null;problem(503,'Pratinjau tampilan: login dan pembayaran memerlukan konfigurasi layanan.');}
 return storedRedis(op,...args);
}
const P='lg:study:v1:',COURSES=P+'courses',ORDERS=P+'orders',ACCESS=P+'access',PRICE=5000,DAYS=30;
const parse=s=>s?JSON.parse(s):null;
const text=(v,n)=>typeof v==='string'?v.trim().slice(0,n+1):'';
const grades=[...Array.from({length:6},(_,i)=>({id:'sd'+(i+1),label:'SD Kelas '+(i+1),level:'SD'})),...Array.from({length:3},(_,i)=>({id:'smp'+(i+7),label:'SMP Kelas '+(i+7),level:'SMP'})),...['SMA','SMK'].flatMap(level=>Array.from({length:3},(_,i)=>({id:level.toLowerCase()+(i+10),label:level+' Kelas '+(i+10),level})))];
const subjects=[['matematika','Matematika'],['indonesia','Bahasa Indonesia'],['inggris','Bahasa Inggris'],['pancasila','Pendidikan Pancasila'],['agama','Pendidikan Agama'],['pjok','PJOK'],['seni','Seni Budaya']];
function catalog(){return grades.flatMap(g=>[...subjects,...(g.level==='SD'?[['ipas','IPAS']]:g.level==='SMP'?[['ipa','IPA'],['ips','IPS'],['informatika','Informatika']]:[['fisika','Fisika'],['kimia','Kimia'],['biologi','Biologi'],['sejarah','Sejarah'],['informatika','Informatika']]),...(g.level==='SMK'?[['rpl','Dasar RPL'],['tkj','Dasar TKJ'],['akuntansi','Dasar Akuntansi']]:[])].map(([subject,title])=>({id:g.id+'-'+subject,grade:g.id,gradeLabel:g.label,title,price:PRICE,days:DAYS,published:false,lessons:[]})))}
const curriculum=require('../lib/curriculum');
async function course(id){const base=catalog().find(c=>c.id===id);if(!base)problem(404,'Pelajaran tidak ditemukan.');return {...curriculum.build(base),...(parse(await redis('HGET',COURSES,id))||{})};}
function summary(c){const {lessons,quiz,...rest}=c;return {...rest,lessonCount:lessons.length,quizCount:quiz?.length||0,exerciseCount:lessons.length,questionCount:c.questionCount||quiz?.length||0};}
async function entitled(user,id){if(user?.r==='a')return true;if(!user)return false;return +(await redis('HGET',ACCESS,user.id+':'+id)||0)>Date.now();}
const checkoutLua=`
local previous=redis.call('GET',KEYS[1])
if previous then local raw=redis.call('HGET',KEYS[2],previous); if raw then local o=cjson.decode(raw); if o.status=='pending' or (o.status=='awaiting' and tonumber(o.expiresAt)>tonumber(ARGV[3])) then return raw end end end
redis.call('HSET',KEYS[2],ARGV[1],ARGV[2]);redis.call('SET',KEYS[1],ARGV[1]);redis.call('SADD',KEYS[3],ARGV[1]);return ARGV[2]`;
const submitLua=`
local raw=redis.call('HGET',KEYS[1],ARGV[1]);if not raw then return {'missing'} end
local o=cjson.decode(raw);if o.owner~=ARGV[2] then return {'owner'} end
if o.status=='pending' or o.status=='verified' then return {'ok',raw} end
if o.status~='awaiting' or tonumber(o.expiresAt)<tonumber(ARGV[3]) then return {'expired'} end
o.sender=ARGV[4];o.ref=ARGV[5];o.status='pending';o.submittedAt=tonumber(ARGV[3]);local saved=cjson.encode(o);redis.call('HSET',KEYS[1],ARGV[1],saved);redis.call('ZADD',KEYS[2],ARGV[3],ARGV[1]);return {'ok',saved}`;
const reviewLua=`
local raw=redis.call('HGET',KEYS[1],ARGV[1]);if not raw then return {'missing'} end
local o=cjson.decode(raw);if o.status~='pending' then return {'already',raw} end
if ARGV[2]=='verify' then
 if tonumber(ARGV[3])~=tonumber(o.amount) then return {'amount'} end
 if redis.call('HEXISTS',KEYS[3],ARGV[4])==1 then return {'duplicate'} end
 redis.call('HSET',KEYS[3],ARGV[4],o.id)
 local field=o.owner..':'..o.course;local expiry=math.max(tonumber(redis.call('HGET',KEYS[4],field) or '0'),tonumber(ARGV[5]))+2592000000
 redis.call('HSET',KEYS[4],field,expiry);o.accessUntil=expiry;o.status='verified'
else o.status='rejected' end
o.note=ARGV[6];o.reviewedAt=tonumber(ARGV[5]);o.reviewer=ARGV[7];local saved=cjson.encode(o);redis.call('HSET',KEYS[1],ARGV[1],saved);redis.call('ZREM',KEYS[2],ARGV[1]);return {'ok',saved}`;
// Bound to study.js storage and authorization helpers by the packaging step.
function learner(actor,requested){
 if(!actor)return {id:'guest',persistent:false};
 if(actor.user.r!=='o'&&actor.user.r!=='a')problem(403,'Gunakan akun murid atau orang tua untuk menyimpan hasil belajar.');
 if(requested){if(!(actor.data.murid||[]).some(m=>m.id===requested&&m.ortuId===actor.user.id))problem(403,'Profil murid bukan milik akun ini.');return {id:actor.user.id+':'+requested,persistent:true}}
 return {id:actor.user.id,persistent:true};
}
const practiceSecret=()=>process.env.KV_REST_API_TOKEN||process.env.UPSTASH_REDIS_REST_TOKEN||process.env.STUDY_PREVIEW_SIGNING_SECRET||'lesgo-public-preview-no-persistent-scores';
function sealPractice(payload){const encoded=Buffer.from(JSON.stringify(payload)).toString('base64url');return encoded+'.'+createHmac('sha256',practiceSecret()).update(encoded).digest('base64url')}
function openPractice(token){
 if(typeof token!=='string'||token.length>2000)problem(400,'Latihan tidak valid.');
 const parts=token.split('.');if(parts.length!==2)problem(400,'Latihan tidak valid.');
 const expected=createHmac('sha256',practiceSecret()).update(parts[0]).digest('base64url');
 if(parts[1].length!==expected.length||!timingSafeEqual(Buffer.from(parts[1]),Buffer.from(expected)))problem(403,'Latihan berubah. Mulai ulang latihan.');
 let p;try{p=JSON.parse(Buffer.from(parts[0],'base64url').toString())}catch{problem(400,'Latihan tidak valid.')}
 if(!Number.isFinite(p.exp)||p.exp<Date.now())problem(409,'Waktu latihan habis. Mulai paket baru.');return p;
}
const progressLua=`
local used=redis.call('GET',KEYS[1]);if used then return {'already',used} end
local raw=redis.call('HGET',KEYS[2],ARGV[1]);local old=raw and cjson.decode(raw) or {best=0,attempts=0}
local score=tonumber(ARGV[2]);local earned=math.max(0,score-tonumber(old.best or 0))
local row={best=math.max(score,tonumber(old.best or 0)),last=score,attempts=tonumber(old.attempts or 0)+1,updatedAt=tonumber(ARGV[3]),course=ARGV[4],lesson=tonumber(ARGV[5]),title=ARGV[6],version=ARGV[7]}
local saved=cjson.encode(row);redis.call('HSET',KEYS[2],ARGV[1],saved)
redis.call('HINCRBY',KEYS[3],'xp',earned);redis.call('HINCRBY',KEYS[3],'attempts',1)
redis.call('HSET',KEYS[3],'lastAt',ARGV[3]);redis.call('SADD',KEYS[4],ARGV[8])
local response=cjson.encode({record=row,earned=earned,result=cjson.decode(ARGV[9])});redis.call('SET',KEYS[1],response,'EX',2592000)
return {'ok',response}`;
async function learning(op,b,actor){
 const student=learner(actor,b.student),user=actor?.user;
 if(op==='progress'){
  if(!student.persistent)problem(401,'Masuk untuk melihat riwayat belajar.');
  const [rows,stats,days]=await Promise.all([redis('HVALS',P+'progress:'+student.id),redis('HGETALL',P+'stats:'+student.id),redis('SMEMBERS',P+'days:'+student.id)]);
  const values={};for(let i=0;i<stats.length;i+=2)values[stats[i]]=+stats[i+1];
  const records=rows.map(parse).filter(Boolean),mastered=records.filter(r=>r.best>=75).length;
  const today=new Date(Date.now()+25200000).toISOString().slice(0,10);let streak=0,d=new Date(today+'T00:00:00Z');const set=new Set(days);if(!set.has(today))d.setUTCDate(d.getUTCDate()-1);while(set.has(d.toISOString().slice(0,10))){streak++;d.setUTCDate(d.getUTCDate()-1)}
  return {records,stats:{...values,mastered,streak,studied:records.length},students:(actor.data.murid||[]).filter(m=>m.ortuId===user.id).map(m=>({id:m.id,name:m.nama}))};
 }
 let signed,seed,index,courseId;
 if(op==='finishExercise'){signed=openPractice(b.ticket);if(signed.owner!==student.id)problem(403,'Latihan ini milik profil murid lain.');({seed,index,course:courseId}=signed)}
 else {index=b.lesson;courseId=b.course;seed=randomInt(1,2147483647)}
 const c=await course(courseId),l=c.lessons[index];
 if(!c.published||!Number.isInteger(index)||index<0||!l)problem(404,'Materi tidak ditemukan.');
 const paid=await entitled(user,c.id);
 if(!l.free&&!paid)problem(403,'Aktifkan akses untuk latihan pada materi ini.');
 const version=(c.contentVersion||'custom')+':'+(c.updatedAt||0);
 if(signed&&signed.version!==version)problem(409,'Materi sudah diperbarui. Mulai latihan baru.');
 const questions=curriculum.exercise(c,index,seed);if(!questions?.length)problem(409,'Latihan materi ini belum tersedia.');
 if(op==='startExercise'){
  const ticket=sealPractice({id:randomUUID(),owner:student.id,course:c.id,index,seed,version,exp:Date.now()+1800000});
  return {ticket,questions:questions.map(({answer,explanation,...q})=>q),persistent:student.persistent,minutes:l.minutes||10,lessonTitle:l.title};
 }
 if(!Array.isArray(b.answers)||b.answers.length!==questions.length||b.answers.some((v,i)=>!Number.isInteger(v)||v<0||v>=questions[i].options.length))problem(400,'Jawab semua soal sebelum memeriksa hasil.');
 const review=questions.map((q,i)=>({question:q.question,selected:b.answers[i],answer:q.answer,options:q.options,correct:b.answers[i]===q.answer,explanation:q.explanation}));
 const correct=review.filter(q=>q.correct).length,score=Math.round(correct/questions.length*100);
 let progress=null,earned=0,already=false;
 if(student.persistent){
  const date=new Date(Date.now()+25200000).toISOString().slice(0,10);
  const evaluated={score,correct,total:questions.length,review};
  const [state,raw]=await redis('EVAL',progressLua,4,P+'attempt:'+signed.id,P+'progress:'+student.id,P+'stats:'+student.id,P+'days:'+student.id,c.id+':'+index,score,Date.now(),c.id,index,l.title,version,date,JSON.stringify(evaluated));
  const saved=parse(raw);progress=saved.record;earned=state==='already'?0:saved.earned;already=state==='already';
  if(already)return {...saved.result,progress,earned:0,already:true,persistent:true,recommendation:progress.last>=75?'Pemahamanmu sudah baik. Coba latihan baru untuk tantangan berikutnya.':'Baca kembali pembahasan, lalu mulai latihan baru.',nextLesson:progress.last>=75&&index+1<c.lessons.length&&(paid||c.lessons[index+1].free)?index+1:null};
 }
 return {score,correct,total:questions.length,review,progress,earned,already,persistent:student.persistent,recommendation:score>=75?'Pemahamanmu sudah baik. Lanjutkan ke materi berikutnya atau coba tantangan baru.':'Baca lagi bagian yang belum tepat, lalu coba latihan baru. Kesalahan adalah petunjuk untuk belajar.',nextLesson:score>=75&&index+1<c.lessons.length&&(paid||c.lessons[index+1].free)?index+1:null};
}

module.exports=async(req,res)=>{
 res.setHeader('Cache-Control','private, no-store');
 if(req.method!=='POST')return res.status(405).json({ok:false});
 try{
  const b=req.body||{},op=b.op;let actor=null;
  if(b.id!==undefined&&(typeof b.id!=='string'||b.id.length>100))problem(400,'ID tidak valid.');
  if(req.headers.authorization)actor=await session(req);
  const user=actor?.user;
  if(!['catalog','lesson','startExercise','finishExercise'].includes(op)&&!user)problem(401,'Masuk sebagai murid atau orang tua terlebih dahulu.');
  let result={};
  if(op==='catalog'){
   const saved=(await redis('HVALS',COURSES)).map(parse),changes=new Map(saved.map(c=>[c.id,c]));
   const courses=catalog().map(c=>({...curriculum.build(c),...(changes.get(c.id)||{})}));
   const rights=user?await redis('HGETALL',ACCESS):[];const own={};for(let i=0;i<rights.length;i+=2)if(rights[i].startsWith(user.id+':'))own[rights[i].slice(user.id.length+1)]=+rights[i+1];
   result={previewOnly,contentVersion:curriculum.VERSION,grades,courses:courses.map(summary),access:own,user:user?{r:user.r,id:user.id}:null};
  }else if(op==='lesson'||op==='quiz'){
   const c=await course(b.course),allowed=await entitled(user,c.id);
   if(!c.published&&user?.r!=='a')problem(404,'Materi sedang disiapkan.');
   if(op==='quiz'){
    if(!allowed)problem(403,'Aktifkan akses pelajaran untuk mengerjakan kuis.');
    if(!c.quiz?.length)problem(404,'Kuis belum tersedia.');
    if(!Array.isArray(b.answers))result={questions:c.quiz.map(({answer,...q})=>q)};
    else {if(b.answers.length!==c.quiz.length||b.answers.some((v,i)=>!Number.isInteger(v)||v<0||v>=c.quiz[i].options.length))problem(400,'Jawab semua soal.');const correct=c.quiz.filter((q,i)=>q.answer===b.answers[i]).length;result={correct,total:c.quiz.length,score:Math.round(correct/c.quiz.length*100)}}
   }else if(Number.isInteger(b.lesson)){
    const l=c.lessons[b.lesson];if(!l)problem(404,'Materi tidak ditemukan.');if(!l.free&&!allowed)problem(403,'Materi terkunci. Buka akses Rp5.000 / 30 hari.');
    result={lesson:l,course:summary(c)};
   }else result={course:summary(c),lessons:c.lessons.map((l,i)=>({id:l.id||'custom-'+i,title:l.title,free:!!l.free,locked:!l.free&&!allowed,minutes:l.minutes||10,visual:l.visual||'book'})),allowed};
  }else if(op==='startExercise'||op==='finishExercise'||op==='progress'){result=await learning(op,b,actor);
  }else if(op==='checkout'){
   if(user.r!=='o')problem(403,'Gunakan akun murid atau orang tua untuk membeli.');
   const c=await course(b.course);if(!c.published||!c.lessons.some(l=>!l.free))problem(409,'Materi belum tersedia untuk dibeli.');
   if(await entitled(user,c.id))problem(409,'Aksesmu masih aktif.');
   const bankId=await redis('GET','lg:lesgo-payment:v1:current-bank'),bank=bankId?parse(await redis('HGET','lg:lesgo-payment:v1:bank-versions',bankId)):null;
   if(!bank)problem(409,'Rekening pembayaran belum diatur. Silakan hubungi admin LesGo.');
   const count=await redis('EVAL',"local n=redis.call('INCR',KEYS[1]);if n==1 then redis.call('EXPIRE',KEYS[1],3600) end;return n",1,P+'rate:'+user.id);if(count>40)problem(429,'Terlalu banyak percobaan. Coba lagi nanti.');
   const now=Date.now(),order={id:randomUUID(),owner:user.id,course:c.id,title:c.title,gradeLabel:c.gradeLabel,amount:PRICE,days:DAYS,bank,status:'awaiting',createdAt:now,expiresAt:now+86400000};
   result={order:parse(await redis('EVAL',checkoutLua,3,P+'checkout:'+user.id+':'+c.id,ORDERS,P+'owned:'+user.id,order.id,JSON.stringify(order),now))};
  }else if(op==='orders'){
   const ids=await redis('SMEMBERS',P+'owned:'+user.id),rows=ids.length?await redis('HMGET',ORDERS,...ids):[];
   result={orders:rows.map(parse).filter(Boolean).sort((a,b)=>b.createdAt-a.createdAt).slice(0,100)};
  }else if(op==='submit'){
   const sender=text(b.sender,90),ref=text(b.ref,100);if(sender.length<2||sender.length>90||ref.length<3||ref.length>100)problem(400,'Isi nama pengirim dan referensi transfer.');
   const [state,raw]=await redis('EVAL',submitLua,2,ORDERS,P+'pending',b.id||'',user.id,Date.now(),sender,ref);if(state!=='ok')problem(state==='owner'?403:409,'Pesanan tidak tersedia atau kedaluwarsa.');result={order:parse(raw)};
  }else if(['admin','editor','saveCourse','review'].includes(op)){
   if(user.r!=='a')problem(403,'Hanya admin LesGo yang dapat membuka fitur ini.');
   if(op==='editor'){result={course:await course(b.course)};}else if(op==='admin'){
    const ids=await redis('ZREVRANGE',P+'pending',0,99);result={orders:ids.length?(await redis('HMGET',ORDERS,...ids)).map(parse).filter(Boolean):[]};
   }else if(op==='saveCourse'){
    const c=await course(b.course),lessons=b.lessons,quiz=b.quiz||[];
    if(!Array.isArray(lessons)||lessons.length>100||lessons.some(l=>!text(l.title,100)||l.title.length>100||!text(l.content,20000)||l.content.length>20000||typeof l.free!=='boolean'))problem(400,'Isi judul dan materi dengan benar (maksimal 100 materi).');
    if(!Array.isArray(quiz)||quiz.length>50||quiz.some(q=>!q.question||q.question.length>500||!Array.isArray(q.options)||q.options.length<2||q.options.length>6||q.options.some(x=>typeof x!=='string'||!x.trim()||x.length>300)||!Number.isInteger(q.answer)||q.answer<0||q.answer>=q.options.length))problem(400,'Format kuis tidak valid.');
    if(b.published===true&&(!lessons.some(l=>l.free)||!lessons.some(l=>!l.free)))problem(400,'Sediakan minimal satu materi gratis dan satu materi berbayar.');
    const record={id:c.id,description:text(b.description,500),published:b.published===true,lessons:lessons.map((l,i)=>({...(c.lessons[i]||{}),title:l.title.trim(),content:l.content.trim(),free:l.free})),quiz,updatedAt:Date.now()};
    if(JSON.stringify(record).length>800000)problem(413,'Materi terlalu besar.');await redis('HSET',COURSES,c.id,JSON.stringify(record));result={saved:true};
   }else{
    if(!['verify','reject'].includes(b.decision))problem(400,'Keputusan tidak valid.');
    const order=parse(await redis('HGET',ORDERS,b.id||''));if(!order)problem(404,'Pesanan tidak ditemukan.');
    const note=text(b.note,140);if(note.length<3||note.length>140)problem(400,'Isi referensi mutasi atau alasan penolakan.');
    let match='';if(b.decision==='verify'){
     if(b.confirmed!==true||b.amount!==PRICE)problem(400,'Periksa mutasi dan konfirmasi dana Rp5.000 sudah masuk.');
     const reference=note.toUpperCase().replace(/[^A-Z0-9]/g,'');if(reference.length<3)problem(400,'Referensi mutasi tidak valid.');
     match=createHash('sha256').update([order.bank.bank.toUpperCase().replace(/[^A-Z0-9]/g,''),order.bank.number,reference].join(':')).digest('hex');
    }
    const [state,raw]=await redis('EVAL',reviewLua,4,ORDERS,P+'pending','lg:lesgo-payment:v1:matched',ACCESS,order.id,b.decision,b.amount||0,match,Date.now(),note,user.id);
    if(!['ok','already'].includes(state))problem(409,state==='duplicate'?'Transaksi bank sudah dipakai untuk pembayaran lain.':'Pesanan berubah. Muat ulang.');result={order:parse(raw)};
   }
  }else problem(400,'Permintaan tidak dikenal.');
  return res.json({ok:true,...result});
 }catch(e){if(!e.status)console.error('Study API:',e.name);return res.status(e.status||503).json({ok:false,error:e.status?e.message:'Layanan belajar belum tersedia. Coba lagi.'})}
};
