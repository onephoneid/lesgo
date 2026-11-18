const fs=require('fs'),vm=require('vm'),assert=require('assert/strict'),crypto=require('crypto');
const curriculum=require('../lib/curriculum');
const db=new Map();function h(k){if(!db.has(k))db.set(k,new Map());return db.get(k)}
let actor=null;const env={KV_REST_API_TOKEN:'private-test-secret',KV_REST_API_URL:'https://test.invalid'};
const problem=(status,message)=>{throw Object.assign(Error(message),{status})};
const shared={problem,session:async()=>{if(!actor)problem(401,'Unauthorized');return actor},redis:async(op,k,...args)=>{
 if(op==='HVALS')return [...h(k).values()];if(op==='HGETALL')return [...h(k)].flat();if(op==='HGET')return h(k).get(args[0])??null;if(op==='GET')return null;
 if(op==='SMEMBERS'||op==='ZREVRANGE')return [];
 if(op==='HSET'){h(k).set(args[0],args[1]);return 1}
 if(op==='EVAL'){
  const [n,...p]=[k,...args].slice(1); // test only progress EVAL; Lua behavior independently tested by actual Lua runtime.
  const script=k,count=args[0],keys=args.slice(1,1+count),values=args.slice(1+count);
  assert.equal(count,4);const [field,score,now,course,index,title,version,date,result]=values;
  const old=JSON.parse(h(keys[1]).get(field)||'{"best":0,"attempts":0}');const record={best:Math.max(old.best,+score),last:+score,attempts:old.attempts+1,course,lesson:+index,title,updatedAt:+now,version};
  h(keys[1]).set(field,JSON.stringify(record));return ['ok',JSON.stringify({record,earned:Math.max(0,+score-old.best),result:JSON.parse(result)})];
 }
 throw Error(op);
}};
function handler(environment=env){const mod={exports:{}};vm.runInNewContext(fs.readFileSync('lesgo-study/api/study.js','utf8'),{require:id=>id==='./profile-media'?{shared}:require(id),module:mod,console,Date,Buffer,process:{env:environment}});return mod.exports}
const run=handler();
async function call(body,fn=run){let status=200,data;await fn({method:'POST',headers:actor?{authorization:'test'}:{},body},{setHeader(){},status(s){status=s;return this},json(v){data=v}});return {status,...data}}
(async()=>{
 const catalog=await call({op:'catalog'});assert.equal(catalog.status,200);assert.equal(catalog.grades.length,15);assert.ok(catalog.courses.every(c=>c.published&&c.lessonCount>=4));
 let modules=0;for(const base of catalog.courses){const c=curriculum.build(base);modules+=c.lessons.length;for(let i=0;i<c.lessons.length;i++)for(const seed of [1,23,9999]){const qs=curriculum.exercise(c,i,seed);assert.equal(qs.length,3);for(const q of qs){assert.equal(q.options.length,4);assert.equal(new Set(q.options).size,4,c.id);assert.ok(q.answer>=0&&q.answer<4);assert.ok(q.explanation.length>10)}}}
 assert.ok(modules>750);assert.ok(!JSON.stringify(catalog).includes('PAHAMI KONSEPNYA'));
 let r=await call({op:'lesson',course:'sd1-matematika',lesson:0});assert.equal(r.status,200);assert.ok(r.lesson.content.includes('CONTOH'));
 assert.equal((await call({op:'lesson',course:'sd1-matematika',lesson:1})).status,403);
 const start=await call({op:'startExercise',course:'sd1-matematika',lesson:0});assert.equal(start.status,200);assert.ok(start.questions.every(q=>!('answer'in q)&&!('explanation'in q)));
 const p=JSON.parse(Buffer.from(start.ticket.split('.')[0],'base64url'));const c=curriculum.build(catalog.courses.find(c=>c.id==='sd1-matematika'));const answers=curriculum.exercise(c,0,p.seed).map(q=>q.answer);
 r=await call({op:'finishExercise',ticket:start.ticket,answers});assert.equal(r.score,100);assert.equal(r.persistent,false);assert.equal(r.total,3);
 assert.equal((await call({op:'finishExercise',ticket:start.ticket+'x',answers})).status,403);
 assert.equal((await call({op:'finishExercise',ticket:start.ticket,answers:[8,8,8]})).status,400);
 actor={user:{r:'o',id:'parent'},data:{murid:[{id:'child1',ortuId:'parent',nama:'A'},{id:'child2',ortuId:'parent',nama:'B'}]}};
 assert.equal((await call({op:'startExercise',course:'sd1-matematika',lesson:0,student:'foreign'})).status,403);
 const owned=await call({op:'startExercise',course:'sd1-matematika',lesson:0,student:'child1'});assert.equal(owned.persistent,true);
 assert.equal((await call({op:'finishExercise',ticket:owned.ticket,student:'child2',answers:[0,0,0]})).status,403);
 const payload=JSON.parse(Buffer.from(owned.ticket.split('.')[0],'base64url'));const correct=curriculum.exercise(c,0,payload.seed).map(q=>q.answer);
 r=await call({op:'finishExercise',ticket:owned.ticket,student:'child1',answers:correct,score:0});assert.equal(r.score,100);assert.equal(r.progress.best,100);assert.ok(h('lg:study:v1:progress:parent:child1').size===1);assert.equal(h('lg:study:v1:progress:parent:child2').size,0);
 assert.equal((await call({op:'lesson',course:'smk12-rpl',lesson:1})).status,403);
 h('lg:study:v1:access').set('parent:smk12-rpl',String(Date.now()+100000));assert.equal((await call({op:'lesson',course:'smk12-rpl',lesson:1})).status,200);
 actor={user:{r:'g',id:'teacher'},data:{}};assert.equal((await call({op:'startExercise',course:'sd1-matematika',lesson:0})).status,403);
 actor=null;const preview=handler({VERCEL_ENV:'preview'});assert.equal((await call({op:'catalog'},preview)).previewOnly,true);const ps=await call({op:'startExercise',course:'smp7-indonesia',lesson:0},preview);assert.equal(ps.status,200);assert.equal(ps.persistent,false);
 const ps2=await call({op:'startExercise',course:'smp7-indonesia',lesson:0},preview);assert.notEqual(ps.ticket,ps2.ticket);
 console.log(`PASS: ${catalog.courses.length} courses, ${modules} modules, answer uniqueness, protected content, signed exercises, server scoring, child isolation, rights, and read-only preview.`);
})();
