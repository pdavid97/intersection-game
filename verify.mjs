// 랭킹 점수 검증: Supabase scores 표의 '검증 대기'(pending) 기록을 엔진으로 다시 계산해 확정(verified) 또는 거절(rejected)
// GitHub Actions에서 10분마다 실행. 필요한 환경 변수: SUPABASE_URL, SUPABASE_SECRET_KEY(비밀 키, GitHub Secrets에만 저장)
// 로컬 시험: node verify.mjs --dry  (서버를 바꾸지 않고 결과만 출력)
import path from 'path';import url from 'url';import fs from 'fs';import {createRequire} from 'module';
const dir=path.dirname(url.fileURLToPath(import.meta.url)),require=createRequire(import.meta.url);
const enginePath=[path.join(dir,'engine.js'),path.join(dir,'..','dist','engine.js')].find(p=>fs.existsSync(p));
const E=require(enginePath);
const URL_=process.env.SUPABASE_URL,KEY=process.env.SUPABASE_SECRET_KEY,DRY=process.argv.includes('--dry');
const MAX_ROWS=+(process.env.MAX_ROWS||40),TIME_BUDGET=+(process.env.TIME_BUDGET_MS||8*60e3);

// ---------- 설정 검사: 화면에서 할 수 있는 조작만으로 만든 설정인지 ----------
const MODES=new Set(['L','LU','U','LT','T','TR','R','B']);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function baseOf(stage){
  if(stage.startsWith('real-')){const R=E.REAL[stage.slice(5)];if(!R)return null;return{base:E.realCfg(R),unlock:null};}
  if(stage.startsWith('L')){const lv=E.LEVELS.find(l=>'L'+l.id===stage);if(!lv)return null;return{base:E.levelCfg(lv),unlock:new Set(lv.unlock)};}
  return null;}
export function check(stage,weather,cfg){
  const b=baseOf(stage);if(!b)return'알 수 없는 스테이지';const {base,unlock}=b,U=k=>!unlock||unlock.has(k);
  if(!cfg||typeof cfg!=='object')return'설정 없음';
  for(const a of E.APPR){const x=cfg.appr&&cfg.appr[a],y=base.appr[a];if(!x)return'접근로 누락';
    if(x.vph!==y.vph||x.pl!==y.pl||x.pr!==y.pr||(x.pu||0)!==(y.pu||0)||(x.ped||0)!==(y.ped||0))return'교통량이 기본값과 다름';}
  const wx=cfg.wx||'clear';if(wx!==weather)return'날씨 표시 불일치';if(!E.WXP[wx])return'알 수 없는 날씨';
  if(cfg.ow!=null){if(!U('oneway'))return'일방통행이 열리지 않은 레벨';for(const a in cfg.ow)if(!E.APPR.includes(a)||!['in','out'].includes(cfg.ow[a]))return'일방통행 값 오류';}
  if(!same(cfg.geo,E.owGeo(base.geo,cfg.ow)))return'도로 모양이 기본값과 다름';
  for(const a of E.APPR){const L=cfg.appr[a].lanes;if(!Array.isArray(L)||L.length!==cfg.geo.nIn[a])return'차로 수 불일치';
    for(const m of L)if(!MODES.has(m))return'차로 용도 오류';
    if(!U('bus')&&L.includes('B')&&!base.appr[a].lanes.includes('B'))return'버스 차로가 열리지 않은 레벨';
    if(!U('uturn')&&L.some(m=>m.includes('U'))&&!same(L,base.appr[a].lanes))return'유턴이 열리지 않은 레벨';
    if(!U('lanes')&&!cfg.ow&&!same(L,base.appr[a].lanes))return'차로 배정이 열리지 않은 레벨';
    if(typeof cfg.appr[a].perm!=='boolean')return'비보호 값 오류';if(!U('perm')&&cfg.appr[a].perm!==base.appr[a].perm)return'비보호가 열리지 않은 레벨';}
  const P=cfg.phases;if(!Array.isArray(P)||!P.length||P.length>8)return'현시 수 오류';
  const CF=E.getConf(cfg.geo),ALL=new Set(E.ALLMOVES),OKPAIR=new Set();
  // 실제 도시 기본 신호에 원래 함께 있는 이동류 쌍(예: 토론토 동서 좌회전 동시 비보호)은 허용
  for(const ph of base.phases)for(const x of ph.m)for(const y of ph.m)OKPAIR.add(x+'|'+y);
  // 보행 신호: 보행 전용 현시(x)는 1개까지, 차량 이동류 없음. 동시 횡단 끄기는 보행 전용 현시가 있을 때만
  const XS=P.filter(p=>p&&p.x),baseX=base.phases.some(p=>p.x),hasPed=E.APPR.some(a=>base.appr[a].ped>0);
  if(XS.length>1)return'보행 전용 현시가 2개 이상';if(XS.some(p=>p.x!==true||!Array.isArray(p.m)||p.m.length))return'보행 전용 현시 값 오류';
  if(XS.length&&!baseX&&(!U('ped')||!hasPed))return'보행 신호가 열리지 않은 레벨';
  if(cfg.pedConc!==undefined&&cfg.pedConc!==true&&cfg.pedConc!==false)return'동시 횡단 값 오류';
  if(cfg.pedConc===false&&(!XS.length||((!U('ped')||!hasPed)&&base.pedConc!==false)))return'동시 횡단 설정 오류';
  for(const ph of P){if(!Array.isArray(ph.m)||!Number.isInteger(ph.g)||ph.g<0||ph.g>180)return'현시 값 오류';
    if(new Set(ph.m).size!==ph.m.length)return'현시 중복';for(const x of ph.m)if(!ALL.has(x))return'이동류 오류';
    for(const x of ph.m)for(const y of ph.m)if(x!==y&&CF[x][y]&&!OKPAIR.has(x+'|'+y))return`충돌하는 이동류를 같은 현시에 넣음(${x}, ${y})`;}
  const cyc=E.cycleOf(cfg);if(cyc<20||cyc>300)return'주기 범위 오류';
  const VP=P.filter(p=>!p.x),VB=base.phases.filter(p=>!p.x);
  if(!U('phases')&&!U('scheme')&&!same(VP.map(p=>[...p.m].sort()),VB.map(p=>[...p.m].sort())))return'현시 구성이 열리지 않은 레벨';
  if(!U('split')&&!U('cycle')&&!same(P.map(p=>p.g),base.phases.map(p=>p.g)))return'신호 시간이 열리지 않은 레벨';
  if(unlock&&!U('cycle')&&!U('phases')&&Math.abs(cyc-E.cycleOf(base))>1)return'주기 길이가 열리지 않은 레벨';
  if(!Number.isInteger(cfg.yellow)||cfg.yellow<2||cfg.yellow>6)return'황색 시간 오류';if(!U('yellow')&&cfg.yellow!==base.yellow)return'황색 시간이 열리지 않은 레벨';
  if(typeof cfg.rtor!=='boolean')return'적색 회전 값 오류';if(!U('rtor')&&cfg.rtor!==base.rtor)return'적색 회전이 열리지 않은 레벨';
  return null;}

// ---------- 서버 ----------
async function api(p,opt={}){const r=await fetch(URL_+'/rest/v1/'+p,{...opt,headers:{apikey:KEY,'Content-Type':'application/json',Prefer:'return=minimal',...(opt.headers||{})}});
  if(!r.ok)throw new Error(`${r.status} ${await r.text()}`);return r.status===204?null:r.json();}
async function main(){
  if(!URL_||!KEY){console.log('SUPABASE_URL, SUPABASE_SECRET_KEY 환경 변수가 필요합니다');process.exit(1);}
  const rows=await api(`scores?select=id,stage_id,weather,score,cfg,version&status=eq.pending&order=created_at.asc&limit=${MAX_ROWS}`,{headers:{Prefer:''}});
  console.log(`엔진 ${E.VER}, 검증 대기 ${rows.length}건`);const t0=Date.now();let ok=0,no=0;
  for(const r of rows){if(Date.now()-t0>TIME_BUDGET){console.log('시간 예산 소진, 나머지는 다음 실행에서');break;}
    const why=check(r.stage_id,r.weather,r.cfg);let patch;
    if(why){patch={status:'rejected',note:why};no++;}
    else{const t=Date.now(),ev=E.evalCfg(r.cfg),st=ev.st;
      patch={status:'verified',claimed_score:r.score,score:ev.score,persons:st.persons,speed:+st.spd.toFixed(2),risk:+st.risk.toFixed(3),
        note:(ev.score!==r.score?`제출 ${r.score}점, 재계산 ${ev.score}점`:'일치')+(r.version!==E.VER?`, 제출 버전 ${r.version}, 검증 엔진 ${E.VER}`:''),};ok++;
      console.log(`  #${r.id} ${r.stage_id} 제출 ${r.score} -> ${ev.score} (${Date.now()-t}ms)`);}
    patch.verified_at=new Date().toISOString();
    if(DRY)console.log('  [dry]',r.id,patch.status,patch.note);else await api(`scores?id=eq.${r.id}`,{method:'PATCH',body:JSON.stringify(patch)});}
  console.log(`확정 ${ok}건, 거절 ${no}건, ${((Date.now()-t0)/1000).toFixed(0)}초`);}
if(import.meta.url===url.pathToFileURL(process.argv[1]).href)main().catch(e=>{console.error(e);process.exit(1);});
