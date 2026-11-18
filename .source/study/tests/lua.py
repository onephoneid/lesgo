import ctypes,re,pathlib
source=pathlib.Path('api/study.js').read_text()
lib=ctypes.CDLL('liblua5.4.so.0');lib.luaL_newstate.restype=ctypes.c_void_p;lib.luaL_openlibs.argtypes=[ctypes.c_void_p];lib.luaL_loadstring.argtypes=[ctypes.c_void_p,ctypes.c_char_p];lib.lua_pcallk.argtypes=[ctypes.c_void_p,ctypes.c_int,ctypes.c_int,ctypes.c_int,ctypes.c_longlong,ctypes.c_void_p];lib.lua_tolstring.argtypes=[ctypes.c_void_p,ctypes.c_int,ctypes.c_void_p];lib.lua_tolstring.restype=ctypes.c_char_p
functions='\n'.join('local function '+n+'()\n'+re.search(r'const '+n+r'=`([\s\S]*?)`;',source).group(1)+'\nend' for n in ['checkoutLua','submitLua','reviewLua'])
tests='''
local hashes,strings,sets={},{},{}
local function h(k) if not hashes[k] then hashes[k]={} end;return hashes[k] end
redis={call=function(op,k,a,b)
 if op=='HGET' then return h(k)[a] end
 if op=='HSET' then h(k)[a]=b;return 1 end
 if op=='HEXISTS' then return h(k)[a] and 1 or 0 end
 if op=='GET' then return strings[k] end
 if op=='SET' then strings[k]=a;return 'OK' end
 if op=='SADD' or op=='ZADD' then sets[k]=b or a;return 1 end
 if op=='ZREM' then sets[k]=nil;return 1 end
 error(op)
end}
cjson={decode=function(v)return v end,encode=function(v)return v end}
local o={id='order',owner='buyer',course='math',amount=5000,status='awaiting',expiresAt=5000}
KEYS={'checkout','orders','owned'};ARGV={'order',o,1000};assert(checkoutLua()==o)
ARGV={'different',{id='different'},1000};assert(checkoutLua()==o)
KEYS={'orders','pending'};ARGV={'order','other',1000,'A','REF'};assert(submitLua()[1]=='owner')
ARGV[2]='buyer';ARGV[3]=6000;assert(submitLua()[1]=='expired')
ARGV[3]=1000;assert(submitLua()[1]=='ok' and o.status=='pending')
KEYS={'orders','pending','matched','access'};ARGV={'order','verify',1,'bank-ref',1000,'REF','admin'};assert(reviewLua()[1]=='amount')
ARGV[3]=5000;h('matched')['bank-ref']='spp';assert(reviewLua()[1]=='duplicate' and not h('access')['buyer:math'])
h('matched')['bank-ref']=nil;assert(reviewLua()[1]=='ok');assert(h('access')['buyer:math']==2592001000)
assert(reviewLua()[1]=='already');assert(h('access')['buyer:math']==2592001000)
local o2={id='order2',owner='buyer',course='math',amount=5000,status='pending'};h('orders').order2=o2
ARGV={'order2','verify',5000,'bank-ref2',2000,'REF2','admin'};assert(reviewLua()[1]=='ok');assert(h('access')['buyer:math']==5184001000)
local o3={id='order3',owner='buyer',course='other',amount=5000,status='pending'};h('orders').order3=o3
ARGV={'order3','reject',0,'',1000,'wrong','admin'};assert(reviewLua()[1]=='ok' and not h('access')['buyer:other'])
'''
# Define helpers after mocks so the functions capture the Redis global at invocation.
state=lib.luaL_newstate();lib.luaL_openlibs(state);code=functions+'\n'+tests;status=lib.luaL_loadstring(state,code.encode()) or lib.lua_pcallk(state,0,0,0,0,None);assert status==0,lib.lua_tolstring(state,-1,None)
print('PASS: actual Lua checkout idempotency, ownership, expiry, amount, duplicate bank reference, atomic grants, repeated verification, renewal, rejection.')
