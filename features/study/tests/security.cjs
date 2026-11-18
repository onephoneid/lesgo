const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const records=new Map(),get=k=>records.get(k)||new Map();
let actor=null;
const shared={problem:(status,message)=>{throw Object.assign(Error(message),{status})},session:async()=>{if(!actor)shared.problem(401,'Masuk dulu');return {user:actor}},redis:async(op,key,...args)=>{
 if(op==='HGET')return get(key).get(args[0])||null;
 if(op==='HVALS')return [...get(key).values()];
 if(op==='HGETALL')return [...get(key)].flat();
 if(op==='SMEMBERS'||op==='ZREVRANGE')return [];
 if(op==='GET')return null;
 if(op==='HSET'){const m=get(key);m.set(args[0],args[1]);records.set(key,m);return 1}
 throw Error('Unexpected '+op);
}};
const mod={exports:{}};vm.runInNewContext(fs.readFileSync('lesgo-study/api/study.js','utf8'),{require:id=>id==='./profile-media'?{shared}:require(id),module:mod,console,Date,process:{env:{}}});
async function call(body){let status=200,result;await mod.exports({method:'POST',headers:actor?{authorization:'test'}:{},body},{setHeader(){},status(s){status=s;return this},json(v){result=v}});return {status,...result}}
(async()=>{
 let r=await call({op:'catalog'});assert.equal(r.status,200);assert.ok(r.courses.length>100);assert.equal(r.grades.length,15);assert.ok(!JSON.stringify(r).includes('Ada 2 apel'));
 assert.equal((await call({op:'lesson',course:'sd1-matematika',lesson:0})).status,200);
 assert.equal((await call({op:'lesson',course:'sd1-matematika',lesson:1})).status,403);
 assert.equal((await call({op:'checkout',course:'sd1-matematika'})).status,401);
 actor={r:'o',id:'buyer'};
 assert.equal((await call({op:'editor',course:'sd1-matematika'})).status,403);
 assert.equal((await call({op:'review',id:'bad'})).status,403);
 assert.equal((await call({op:'lesson',course:'sd2-matematika'})).status,404);
 assert.equal((await call({op:'checkout',course:'sd1-matematika'})).status,409);
 const rights=new Map([['other:sd1-matematika',String(Date.now()+100000)]]);records.set('lg:study:v1:access',rights);
 assert.equal((await call({op:'lesson',course:'sd1-matematika',lesson:1})).status,403);
 rights.set('buyer:sd1-matematika',String(Date.now()-1));assert.equal((await call({op:'quiz',course:'sd1-matematika'})).status,403);
 rights.set('buyer:sd1-matematika',String(Date.now()+100000));
 assert.equal((await call({op:'lesson',course:'sd1-matematika',lesson:1})).status,200);
 r=await call({op:'quiz',course:'sd1-matematika'});assert.equal(r.questions.length,3);assert.ok(!('answer' in r.questions[0]));
 assert.equal((await call({op:'quiz',course:'sd1-matematika',answers:[1,2,1]})).score,100);
 assert.equal((await call({op:'quiz',course:'sd1-matematika',answers:[99,2,1]})).status,400);
 actor={r:'a',id:'admin'};assert.equal((await call({op:'editor',course:'sd1-matematika'})).course.quiz[0].answer,1);
 assert.equal((await call({op:'saveCourse',course:'sd2-matematika',published:true,lessons:[]})).status,400);
 assert.equal((await call({op:'saveCourse',course:'sd2-matematika',published:true,lessons:[{title:'Gratis',content:'Materi gratis',free:true},{title:'Berbayar',content:'Materi berbayar',free:false}]})).status,200);
 console.log('PASS: catalog, free preview, paid content lock, owner isolation, expiry, quiz grading, admin permissions, unpublished courses, and missing bank.');
})();
