import ctypes,re,pathlib
source=pathlib.Path('lesgo-study/api/study.js').read_text();script=re.search(r'const progressLua=`([\s\S]*?)`;',source).group(1)
lib=ctypes.CDLL('liblua5.4.so.0');lib.luaL_newstate.restype=ctypes.c_void_p;lib.luaL_openlibs.argtypes=[ctypes.c_void_p];lib.luaL_loadstring.argtypes=[ctypes.c_void_p,ctypes.c_char_p];lib.lua_pcallk.argtypes=[ctypes.c_void_p,ctypes.c_int,ctypes.c_int,ctypes.c_int,ctypes.c_longlong,ctypes.c_void_p];lib.lua_tolstring.argtypes=[ctypes.c_void_p,ctypes.c_int,ctypes.c_void_p];lib.lua_tolstring.restype=ctypes.c_char_p
fixture='''
local hashes,strings,sets={},{},{}
local function h(k) if not hashes[k] then hashes[k]={} end;return hashes[k] end
redis={call=function(op,k,a,b,c)
 if op=='GET' then return strings[k] end
 if op=='SET' then strings[k]=a;return 'OK' end
 if op=='HGET' then return h(k)[a] end
 if op=='HSET' then h(k)[a]=b;return 1 end
 if op=='HINCRBY' then h(k)[a]=(h(k)[a] or 0)+tonumber(b);return h(k)[a] end
 if op=='SADD' then sets[k]=sets[k] or {};sets[k][a]=true;return 1 end
 error(op)
end}
cjson={decode=function(v)return v end,encode=function(v)return v end}
KEYS={'ticket1','progress:child1','stats:child1','days:child1'}
ARGV={'math:0',67,1000,'math',0,'Count','v1','2026-11-19',{score=67}}
local r=save();assert(r[1]=='ok');assert(h('progress:child1')['math:0'].best==67);assert(h('stats:child1').xp==67)
ARGV[2]=100;local twice=save();assert(twice[1]=='already');assert(h('stats:child1').attempts==1);assert(twice[2].result.score==67)
KEYS[1]='ticket2';ARGV[2]=33;save();assert(h('progress:child1')['math:0'].best==67 and h('progress:child1')['math:0'].last==33);assert(h('stats:child1').xp==67)
KEYS[1]='ticket3';ARGV[2]=100;save();assert(h('stats:child1').xp==100 and h('stats:child1').attempts==3)
KEYS={'ticket4','progress:child2','stats:child2','days:child2'};save();assert(h('stats:child2').xp==100);assert(h('stats:child1').attempts==3)
assert(sets['days:child1']['2026-11-19']);assert(h('progress:child2')['math:0'].attempts==1)
'''
code='local function save()\n'+script+'\nend\n'+fixture
state=lib.luaL_newstate();lib.luaL_openlibs(state);status=lib.luaL_loadstring(state,code.encode()) or lib.lua_pcallk(state,0,0,0,0,None);assert status==0,lib.lua_tolstring(state,-1,None)
print('PASS: actual Lua one-time scoring, cached result replay, best vs last, XP improvement only, attempts, and per-child progress isolation.')
