import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, doc as fDoc, collection as fCol, setDoc, deleteDoc, onSnapshot as fSnap, query as fQuery, orderBy as fOrder, limit as fLimit } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

/* ---------- Firestore adapter (same shape the page used on claude.ai) ---------- */
let fdb=null;
const clean=d=>JSON.parse(JSON.stringify(d));
const snapDoc=s=>({id:s.id,exists:s.exists(),data:()=>s.data(),metadata:s.metadata});
function wrapDoc(r){return {id:r.id,path:r.path,
  set:d=>setDoc(r,clean(d)),
  update:d=>setDoc(r,clean(d),{merge:true}),
  delete:()=>deleteDoc(r),
  onSnapshot:(n,e)=>fSnap(r,{includeMetadataChanges:true},s=>n(snapDoc(s)),e),
  collection:p=>wrapQuery(fCol(r,p))}}
function wrapQuery(q){return {
  doc:id=>wrapDoc(id?fDoc(q,id):fDoc(q)),
  orderBy:(f,d)=>wrapQuery(fQuery(q,fOrder(f,d))),
  limit:n=>wrapQuery(fQuery(q,fLimit(n))),
  onSnapshot:(n,e)=>fSnap(q,{includeMetadataChanges:true},s=>n({docs:s.docs.map(snapDoc),size:s.size,empty:s.empty,metadata:s.metadata}),e)}}
const fsApi={doc:p=>wrapDoc(fDoc(fdb,p)),collection:p=>wrapQuery(fCol(fdb,p))};


const COMMON=["GBP","EUR","USD","MAD","BRL","UYU","ARS","CLP","PEN","COP","BOB","PYG","MXN","CAD","AUD","NZD","CHF","SEK","NOK","DKK","ISK","PLN","CZK","HUF","RON","TRY","AED","EGP","ZAR","INR","THB","VND","IDR","MYR","SGD","HKD","JPY","KRW","CNY"];
const CURRENCIES=(()=>{let all=[];try{all=Intl.supportedValuesOf('currency')}catch(e){}return [...new Set([...COMMON,...all])]})();
const STRONG=new Set(["EUR","USD","GBP","CHF","CAD","AUD","NZD","SGD","KWD","BHD","OMR","JOD"]);
function rateTxt(o,base){if(!o)return '';const s=o.dir==='inv'?`1 ${base} = ${o.per} ${o.currency}`:`1 ${o.currency} = ${o.per??o.rate} ${base}`;return o.src==='auto'?s+` (auto, ${o.rateDate||''})`:s}
const CATS=[["food","Food & drink"],["stay","Accommodation"],["transport","Transport"],["car","Car hire & fuel"],["activity","Activities"],["groceries","Groceries"],["shopping","Shopping"],["other","Other"]];
const catName=k=>k==='payment'?'Settlement':(CATS.find(c=>c[0]===k)||[k,'Other'])[1];

let db=null, canWrite=true, dbState='loading', pendingSync=false;
let fx=[];
const FX_SRC='Mid-market rate from <a href="https://www.exchangerate-api.com" target="_blank" rel="noopener">ExchangeRate-API</a>';
function autoRate(cur,base,date){
  if(!fx.length||cur===base)return null;
  const ok=fx.filter(d=>d.rates&&d.rates[cur]>0&&d.rates[base]>0);if(!ok.length)return null;
  const d=ok.find(x=>x.date<=date)||ok[ok.length-1];
  const fwd=d.rates[base]/d.rates[cur];
  return {fwd,inv:1/fwd,date:d.date};
}
const sig=v=>String(+v.toPrecision(v>=1?6:5));
function applyAuto(){const t=trip();const a=autoRate(fs.currency,t.currency,fs.date);
  if(a){fs.rate=sig(fs.rateDir==='inv'?a.inv:a.fwd);fs.rateSrc='auto';fs.rateDate=a.date;return true}
  return false}
function rateNote(c){
  const t=trip();const a=autoRate(fs.currency,t.currency,fs.date);
  if(fs.rateSrc==='auto'&&a)return `<span class="c-pos" style="font-weight:600">Automatic</span> <span class="muted">${FX_SRC} for ${esc(fmtDate(a.date,{day:'numeric',month:'short',year:'numeric'}))}. Change it if your card or the exchange gave you a different rate.</span>`;
  if(a)return `<span class="muted">Rate entered by hand.</span> <button type="button" class="btn ghost sm" data-a="use-auto">Use automatic rate (${esc(rateTxt({currency:fs.currency,per:sig(fs.rateDir==='inv'?a.inv:a.fwd),dir:fs.rateDir},t.currency))})</button>`;
  return `<span class="muted">No automatic rate available for ${esc(fs.currency)} yet. Use the rate you were charged (card statement or exchange receipt).</span>`;
}
let trips=[], tripId=null, entries=[], entriesFor=null, unsubEntries=null, tab='balances';
const names={}; const pendingNames=new Set();

const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const lsGet=k=>{try{return localStorage.getItem(k)}catch(e){return null}};
const lsSet=(k,v)=>{try{localStorage.setItem(k,v)}catch(e){}};
const uid=p=>p+Math.random().toString(36).slice(2,8)+Date.now().toString(36).slice(-3);
const today=()=>{const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')};

function digits(cur){try{return new Intl.NumberFormat('en',{style:'currency',currency:cur}).resolvedOptions().maximumFractionDigits}catch(e){return 2}}
function fmt(minor,cur){const d=digits(cur);try{return new Intl.NumberFormat(undefined,{style:'currency',currency:cur,minimumFractionDigits:d,maximumFractionDigits:d}).format(minor/10**d)}catch(e){return (minor/10**d).toFixed(d)+' '+cur}}
function fmtSigned(m,cur){return (m>0?'+':m<0?'−':'')+fmt(Math.abs(m),cur)}
function plain(minor,cur){const d=digits(cur);return (minor/10**d).toFixed(d)}
const parseNum=s=>{if(s===''||s==null)return NaN;const n=Number(String(s).replace(/[, ]/g,''));return isFinite(n)?n:NaN};
const toMinor=(n,cur)=>Math.round(n*10**digits(cur));
function fmtDate(iso,opts={day:'numeric',month:'short'}){if(!iso)return '';const [y,m,d]=iso.split('-').map(Number);return new Date(y,m-1,d).toLocaleDateString(undefined,opts)}
function fmtStamp(iso){if(!iso)return '';const d=new Date(iso);return d.toLocaleDateString(undefined,{day:'numeric',month:'short'})+' '+d.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})}
const initials=n=>(n||'?').trim().split(/\s+/).map(w=>w[0]).slice(0,2).join('').toUpperCase();

function toast(msg){const t=$('#toast');t.textContent=msg;t.hidden=false;clearTimeout(toast.t);toast.t=setTimeout(()=>t.hidden=true,2600)}

/* ---------- money maths (integer minor units) ---------- */
function allocate(total,weights){
  const ws=weights.filter(([,w])=>w>0);const sum=ws.reduce((a,[,w])=>a+w,0);if(sum<=0)return {};
  const out={},rem=[];let used=0;
  ws.forEach(([p,w],i)=>{const raw=total*w/sum;const f=Math.floor(raw+1e-9);out[p]=f;used+=f;rem.push([p,raw-f,i])});
  rem.sort((a,b)=>(b[1]-a[1])||(a[2]-b[2]));
  for(let i=0;i<total-used;i++)out[rem[i%rem.length][0]]++;
  return out;
}
function sharesOf(e){
  if(e.kind==='payment')return {[e.to]:e.amountMinor};
  const w=e.splitMode==='equal'?(e.participants||[]).map(p=>[p,1]):Object.entries(e.weights||{}).map(([p,v])=>[p,Number(v)||0]);
  return allocate(e.amountMinor,w);
}
const blank=()=>({paid:0,share:0,sent:0,recv:0,bal:0});
function compute(trip,list){
  const S={};(trip.people||[]).forEach(p=>S[p.id]=blank());
  const get=id=>S[id]||(S[id]=blank());
  let total=0;const byCat={};const rows=[];
  for(const e of list){
    const sh=sharesOf(e),delta={};
    if(!e.voided){
      if(e.kind==='payment'){get(e.paidBy).sent+=e.amountMinor;get(e.to).recv+=e.amountMinor}
      else{get(e.paidBy).paid+=e.amountMinor;total+=e.amountMinor;byCat[e.category]=(byCat[e.category]||0)+e.amountMinor;for(const[p,v]of Object.entries(sh))get(p).share+=v}
      delta[e.paidBy]=(delta[e.paidBy]||0)+e.amountMinor;
      for(const[p,v]of Object.entries(sh))delta[p]=(delta[p]||0)-v;
      for(const[p,v]of Object.entries(delta))get(p).bal+=v;
    }
    const running={};for(const id in S)running[id]=S[id].bal;
    rows.push({e,sh,delta,running});
  }
  return {S,total,byCat,rows};
}
function settlePlan(S){
  const cr=[],dr=[];for(const[id,s]of Object.entries(S)){if(s.bal>0)cr.push([id,s.bal]);else if(s.bal<0)dr.push([id,-s.bal])}
  cr.sort((a,b)=>b[1]-a[1]);dr.sort((a,b)=>b[1]-a[1]);
  const out=[];let i=0,j=0;
  while(i<dr.length&&j<cr.length){const a=Math.min(dr[i][1],cr[j][1]);out.push({from:dr[i][0],to:cr[j][0],amt:a});dr[i][1]-=a;cr[j][1]-=a;if(!dr[i][1])i++;if(!cr[j][1])j++}
  return out;
}

/* ---------- data access ---------- */
const trip=()=>trips.find(t=>t.id===tripId);
const pname=(id,t=trip())=>((t?.people||[]).find(p=>p.id===id)||{}).name||'Removed person';
const ordered=()=>{const byCreated=[...entries].sort((a,b)=>(a.createdAt||'').localeCompare(b.createdAt||'')||a.id.localeCompare(b.id));
  const no={};byCreated.forEach((e,i)=>no[e.id]=i+1);
  const byDate=[...entries].sort((a,b)=>(a.date||'').localeCompare(b.date||'')||(no[a.id]-no[b.id]));
  return {no,byDate}};
const entryCol=id=>db.collection('trips/'+id+'/entries');

async function writeSafe(fn,okMsg){
  try{
    const p=fn();
    Promise.resolve(p).catch(e=>{console.error(e);toast(e?.code==='permission-denied'?'This change was refused by the server. Reload the app and try again.':'A change could not be saved. Reload the app and try again.')});
    if(okMsg)toast(navigator.onLine?okMsg:okMsg+' on this phone. It will sync when you are back online.');
    return true;
  }catch(e){console.error(e);toast('Could not save. Reload the app and try again.');return false}
}

function resolveNames(){}
const who=n=>n||'Someone';
const actor=()=>{const t=trip();const id=t&&lsGet('cs.self.'+t.id);return (t?.people||[]).find(p=>p.id===id)?.name||null};

function subscribeEntries(){
  if(entriesFor===tripId)return;
  if(unsubEntries){unsubEntries();unsubEntries=null}
  entries=[];entriesFor=tripId;
  if(!tripId||!db)return;
  unsubEntries=entryCol(tripId).onSnapshot(s=>{entries=s.docs.map(d=>({id:d.id,...d.data()}));pendingSync=s.metadata.hasPendingWrites;updateNet();if(!$('#modal').innerHTML)render()},err=>{console.error(err);toast('Could not load this trip. Check the invite link or reload.')});
}

/* ---------- rendering ---------- */
function render(){
  renderTripSel();
  const app=$('#app');
  if(dbState==='none'){app.innerHTML=`<div class="notice"><h2>${esc(bootError||'Cost Share is not connected to its database yet')}</h2><p class="muted" style="margin:0">${esc(bootHint||'Add the Firebase settings to firebase-config.js, then reload.')}</p></div>`;return}
  if(dbState==='loading'){app.innerHTML=`<div class="notice"><span class="muted">Loading your trips…</span></div>`;return}
  if(!trips.length){app.innerHTML=`<div class="hero-empty">
      <span class="eyebrow">No trips yet</span>
      <h1>Track who paid for what, together.</h1>
      <p>Create a trip, add the people travelling, and log each dinner, hire car or hotel as it happens. Invite your travel companions with a link and everyone sees the same running balances, and the audit ledger shows how every figure was worked out.</p>
      <div class="acts">${canWrite!==false?`<button class="btn primary" data-a="new-trip">Create a trip</button><button class="btn" data-a="example">Try an example trip</button>`:'<span class="muted">You have view-only access.</span>'}</div></div>`;return}
  const t=trip();if(!t){app.innerHTML='';return}
  const {no,byDate}=ordered();const calc=compute(t,byDate);
  const dates=byDate.filter(e=>!e.voided).map(e=>e.date).sort();
  const span=dates.length?(dates[0]===dates.at(-1)?fmtDate(dates[0],{day:'numeric',month:'short',year:'numeric'}):fmtDate(dates[0])+' – '+fmtDate(dates.at(-1),{day:'numeric',month:'short',year:'numeric'})):'No entries yet';
  const live=entries.filter(e=>!e.voided).length;
  app.innerHTML=`
  <section class="trip">
    <div class="trip-head">
      <div style="display:grid;gap:6px;min-width:0">
        <span class="eyebrow">Trip ledger · ${esc(t.currency)}</span>
        <h1>${esc(t.name)}</h1>
        <div class="meta"><span><b>${span}</b></span><span>Total spend <b class="num">${fmt(calc.total,t.currency)}</b></span><span>${live} ${live===1?'entry':'entries'}</span>${fx.length?`<span>Exchange rates updated <b>${esc(fmtDate(fx[0].date,{day:'numeric',month:'short'}))}</b></span>`:''}</div>
      </div>
      ${canWrite!==false?`<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" data-a="invite">Invite</button><button class="btn primary" data-a="add" ${(t.people||[]).length<2?'disabled title="Add at least two people first"':''}>+ Add expense</button></div>`:''}
    </div>
    <div class="people">${(t.people||[]).map(p=>`<span class="chip"><span class="av">${esc(initials(p.name))}</span>${esc(p.name)}</span>`).join('')||'<span class="muted">No people yet. Add them in the Trip tab.</span>'}</div>
  </section>
  <div class="tabs" role="tablist">
    ${[['balances','Balances'],['entries','Entries'],['audit','Audit'],['trip','Trip & people']].map(([k,l])=>`<button class="tab" role="tab" aria-selected="${tab===k}" data-a="tab" data-v="${k}">${l}</button>`).join('')}
  </div>
  <div class="panel">${tab==='balances'?balancesView(t,calc):tab==='entries'?entriesView(t,byDate,no):tab==='audit'?auditView(t,calc,no):tripView(t)}</div>`;
}

function renderTripSel(){
  const el=$('#tripsel');
  if(dbState!=='ready'||!trips.length){el.innerHTML='';return}
  el.innerHTML=`<label class="muted" for="tripPick" style="font-size:.85rem">Trip</label><select id="tripPick" class="field">${trips.map(t=>`<option value="${esc(t.id)}" ${t.id===tripId?'selected':''}>${esc(t.name)}</option>`).join('')}</select>${canWrite!==false?'<button class="btn sm" data-a="new-trip">New trip</button>':''}`;
}

function balancesView(t,calc){
  const cur=t.currency;const ppl=t.people||[];
  if(!entries.length)return emptyEntries(t);
  const plan=settlePlan(calc.S);
  const rows=ppl.map(p=>{const s=calc.S[p.id]||blank();const b=s.bal;
    const pill=b>0?`<span class="pill pos"><small>gets back</small><span class="num">${fmt(b,cur)}</span></span>`:b<0?`<span class="pill neg"><small>owes</small><span class="num">${fmt(-b,cur)}</span></span>`:`<span class="pill zero">Settled</span>`;
    return `<div class="bal"><div class="bal-name"><span class="av">${esc(initials(p.name))}</span><span>${esc(p.name)}</span></div>${pill}
      <div class="bal-figs"><span>Paid <span class="num">${fmt(s.paid,cur)}</span></span><span>Their share <span class="num">${fmt(s.share,cur)}</span></span>${s.sent||s.recv?`<span>Settled up: sent <span class="num">${fmt(s.sent,cur)}</span>, received <span class="num">${fmt(s.recv,cur)}</span></span>`:''}</div></div>`}).join('');
  const settle=plan.length?plan.map(x=>`<div class="xfer"><div class="xfer-txt"><b>${esc(pname(x.from,t))}</b><span class="arrow">pays</span><b>${esc(pname(x.to,t))}</b><span class="num" style="font-weight:600">${fmt(x.amt,cur)}</span></div>${canWrite!==false?`<button class="btn sm" data-a="pay" data-from="${esc(x.from)}" data-to="${esc(x.to)}" data-amt="${x.amt}">Record payment</button>`:''}</div>`).join(''):`<div class="done">Everyone is square. No payments needed.</div>`;
  const cats=Object.entries(calc.byCat).sort((a,b)=>b[1]-a[1]);const max=cats[0]?.[1]||1;
  const shareMax=Math.max(1,...ppl.map(p=>(calc.S[p.id]||blank()).share));
  return `
  <div class="section"><div class="section-head"><h2>Who owes whom</h2><span class="muted" style="font-size:.85rem">Fewest payments to settle everything</span></div><div class="settle">${settle}</div></div>
  <div class="section"><div class="section-head"><h2>Running balances</h2><span class="muted" style="font-size:.85rem">Paid minus share, after settlements</span></div><div class="bal-list">${rows}</div></div>
  <div class="grid2">
    <div class="section"><h2>Spend by category</h2><div class="bars">${cats.map(([k,v])=>`<div class="bar-row"><span>${esc(catName(k))}</span><span class="num">${fmt(v,cur)}</span><div class="bar"><i style="width:${(v/max*100).toFixed(1)}%"></i></div></div>`).join('')||'<span class="muted">No expenses yet.</span>'}<div class="total-line"><span>Total</span><span class="num">${fmt(calc.total,cur)}</span></div></div></div>
    <div class="section"><h2>Cost per person</h2><div class="bars">${ppl.map(p=>{const v=(calc.S[p.id]||blank()).share;return `<div class="bar-row"><span>${esc(p.name)}</span><span class="num">${fmt(v,cur)}</span><div class="bar"><i style="width:${(v/shareMax*100).toFixed(1)}%"></i></div></div>`}).join('')}<div class="total-line"><span>Total</span><span class="num">${fmt(calc.total,cur)}</span></div></div></div>
  </div>`;
}

function emptyEntries(t){
  const few=(t.people||[]).length<2;
  return `<div class="empty"><h2>Nothing logged yet</h2><p class="muted">${few?'Add everyone travelling in the Trip & people tab, then log the first expense.':'Log the first dinner, ticket or booking. Pick who paid and how to split it, and balances update for everyone.'}</p>${canWrite!==false?(few?'<button class="btn primary" data-a="tab" data-v="trip">Add people</button>':'<button class="btn primary" data-a="add">+ Add expense</button>'):''}</div>`;
}

function splitSummary(e,t){
  if(e.kind==='payment')return `${esc(pname(e.paidBy,t))} paid ${esc(pname(e.to,t))}`;
  const ppl=e.splitMode==='equal'?e.participants||[]:Object.keys(e.weights||{}).filter(k=>Number(e.weights[k])>0);
  const all=(t.people||[]).length===ppl.length;
  const how=e.splitMode==='equal'?(all?'split equally between everyone':'split equally: '+ppl.map(p=>pname(p,t)).join(', ')):e.splitMode==='percent'?'split by %: '+ppl.map(p=>pname(p,t)+' '+(+e.weights[p])+'%').join(', '):'split by amounts';
  return `Paid by ${esc(pname(e.paidBy,t))} · ${esc(how)}`;
}

function entriesView(t,byDate,no){
  if(!entries.length)return emptyEntries(t);
  const days={};[...byDate].reverse().forEach(e=>(days[e.date]=days[e.date]||[]).push(e));
  return Object.entries(days).map(([d,list])=>`<div class="day"><div class="day-h">${esc(fmtDate(d,{weekday:'short',day:'numeric',month:'long',year:'numeric'}))}</div><div class="ent-list">${list.map(e=>`
    <button class="ent ${e.voided?'void':''}" data-a="edit" data-id="${esc(e.id)}">
      <span class="no">#${String(no[e.id]).padStart(3,'0')}</span>
      <span class="d">${e.voided?'<span class="tag void">Voided</span>':''}${e.kind==='payment'?'<span class="tag pay">Settlement</span>':`<span class="tag">${esc(catName(e.category))}</span>`}${esc(e.desc||(e.kind==='payment'?'Payment':''))}</span>
      <span class="amt num">${fmt(e.amountMinor,t.currency)}</span>
      <span class="sub">${splitSummary(e,t)}</span>
      <span class="orig num">${e.orig?esc(fmt(toMinor(e.orig.amount,e.orig.currency),e.orig.currency))+'<br>'+esc(rateTxt(e.orig,t.currency)):''}</span>
    </button>`).join('')}</div></div>`).join('');
}

function auditView(t,calc,no){
  const cur=t.currency,ppl=t.people||[];
  if(!entries.length)return emptyEntries(t);
  const extra=Object.keys(calc.S).filter(id=>!ppl.find(p=>p.id===id));
  const cols=[...ppl.map(p=>({id:p.id,name:p.name})),...extra.map(id=>({id,name:'Removed person'}))];
  const sum=Object.values(calc.S).reduce((a,s)=>a+s.bal,0);
  const paidSum=Object.values(calc.S).reduce((a,s)=>a+s.paid,0),shareSum=Object.values(calc.S).reduce((a,s)=>a+s.share,0);
  const sg=v=>v===0?'<span class="muted">0</span>':`<span class="${v>0?'c-pos':'c-neg'}">${fmtSigned(v,cur)}</span>`;
  const body=calc.rows.map(({e,sh,delta,running})=>`<tr class="${e.voided?'void':''}">
    <td class="num">#${String(no[e.id]).padStart(3,'0')}</td><td>${esc(fmtDate(e.date,{day:'2-digit',month:'short',year:'2-digit'}))}</td>
    <td class="desc"><span class="t">${esc(e.desc||'Payment')}</span>${e.voided?' <span class="tag void">Voided, excluded</span>':''}<div class="muted" style="font-size:.75rem">${e.kind==='payment'?'Settlement → '+esc(pname(e.to,t)):esc(catName(e.category))+' · '+esc({equal:'equal split',percent:'% split',amount:'split by amounts'}[e.splitMode]||'')}${e.notes?' · '+esc(e.notes):''}</div></td>
    <td>${esc(pname(e.paidBy,t))}</td>
    <td class="r num">${fmt(e.amountMinor,cur)}${e.orig?`<div class="muted" style="font-size:.72rem">${esc(fmt(toMinor(e.orig.amount,e.orig.currency),e.orig.currency))}<br>${esc(rateTxt(e.orig,cur))}</div>`:''}</td>
    ${cols.map(c=>`<td class="pl r num">${e.voided?'<span class="muted">—</span>':`${sh[c.id]?`<div class="muted" style="font-size:.72rem">share ${fmt(sh[c.id],cur)}</div>`:''}${delta[c.id]?sg(delta[c.id]):'<span class="muted">·</span>'}`}</td><td class="r num">${sg(running[c.id]||0)}</td>`).join('')}
  </tr>`).join('');
  const log=[];entries.forEach(e=>(e.history||[]).forEach(h=>log.push({...h,e})));log.sort((a,b)=>(b.at||'').localeCompare(a.at||''));
  resolveNames([...new Set(log.map(l=>l.by))]);
  return `
  <div class="section">
    <div class="section-head"><h2>Ledger with running balances</h2><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn sm" data-a="csv-copy">Copy as CSV</button><button class="btn sm" data-a="csv-save" id="csvSave">Download CSV</button></div></div>
    <p class="muted" style="margin:0;font-size:.88rem;max-width:70ch">Each row shows who paid, each person's share, the change to their balance (paid minus share) and their running balance after that entry. Amounts in other currencies are converted at the rate entered with the expense. Voided entries stay on the record but count for nothing.</p>
    <div class="audit-frame"><table class="audit"><thead><tr><th>No.</th><th>Date</th><th>Description</th><th>Paid by</th><th class="r">Amount (${esc(cur)})</th>${cols.map(c=>`<th class="person" colspan="2">${esc(c.name)}</th>`).join('')}</tr>
      <tr><th></th><th></th><th></th><th></th><th></th>${cols.map(()=>'<th class="person r">Change</th><th class="r">Balance</th>').join('')}</tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr><td></td><td></td><td>Totals</td><td></td><td class="r num">${fmt(calc.total,cur)}</td>${cols.map(c=>{const s=calc.S[c.id]||blank();return `<td class="pl r num"><div class="muted" style="font-size:.72rem;font-weight:400">paid ${fmt(s.paid,cur)} · share ${fmt(s.share,cur)}</div></td><td class="r num">${sg(s.bal)}</td>`}).join('')}</tr></tfoot>
    </table></div>
    <div class="check ${sum===0&&paidSum===shareSum?'':'bad'}">${sum===0&&paidSum===shareSum?`✓ Books balance: total paid ${fmt(paidSum,cur)} equals total shares, and all balances sum to zero.`:`Balances do not sum to zero (${fmtSigned(sum,cur)}). Check entries that involve removed people.`}</div>
  </div>
  <div class="section"><h2>Change history</h2><div class="log">${log.map(l=>`<div class="log-row"><time>${esc(fmtStamp(l.at))}</time><span><b>#${String(no[l.e.id]).padStart(3,'0')} ${esc(l.e.desc||'Payment')}</b> · ${esc(l.text)} <span class="muted">by ${esc(who(l.by))}</span></span></div>`).join('')}</div></div>`;
}

function tripView(t){
  const used=new Set();entries.forEach(e=>{used.add(e.paidBy);if(e.to)used.add(e.to);(e.participants||[]).forEach(p=>used.add(p));Object.keys(e.weights||{}).forEach(p=>used.add(p))});
  const w=canWrite!==false;
  return `<div class="grid2">
    <div class="card"><div class="section-head"><h2>People</h2>${w?'<button class="btn sm primary" data-a="person-add">Add person</button>':''}</div>
      <div>${(t.people||[]).map(p=>`<div class="prow"><span class="bal-name"><span class="av">${esc(initials(p.name))}</span>${esc(p.name)}</span>${w?`<span style="display:flex;gap:4px"><button class="btn ghost sm" data-a="person-rename" data-id="${esc(p.id)}">Rename</button>${used.has(p.id)?'':`<button class="btn ghost sm danger" data-a="person-remove" data-id="${esc(p.id)}">Remove</button>`}</span>`:''}</div>`).join('')||'<p class="muted" style="margin:0">Add everyone who is sharing costs on this trip.</p>'}</div>
      ${(t.people||[]).some(p=>used.has(p.id))?'<p class="muted" style="margin:0;font-size:.82rem">People who appear in an entry can be renamed but not removed, so the ledger stays complete.</p>':''}
    </div>
    <div class="card"><div class="section-head"><h2>Trip details</h2>${w?'<button class="btn sm" data-a="trip-edit">Edit</button>':''}</div>
      <dl class="kv"><dt>Name</dt><dd>${esc(t.name)}</dd><dt>Currency</dt><dd>${esc(t.currency)} <span class="muted" style="font-size:.82rem">(all balances are kept in this)</span></dd><dt>Created</dt><dd>${esc(fmtStamp(t.createdAt))}</dd></dl>
      <p class="muted" style="margin:0;font-size:.85rem">Anyone with the invite link can view and add expenses. Entries can be voided but never deleted, so the record stays complete.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn sm" data-a="invite">Share invite link</button><button class="btn sm" data-a="who">${actor()?'You are '+esc(actor())+' · change':'Tell the app who you are'}</button><button class="btn sm ghost danger" data-a="leave">Remove from this phone</button></div>
      ${w&&!entries.length?'<button class="btn sm danger" data-a="trip-delete" style="justify-self:start">Delete this empty trip</button>':''}
    </div>${currencyCard(t)}</div>`;
}

function currencyCard(t){
  const by={};
  entries.filter(e=>!e.voided&&e.kind!=='payment').forEach(e=>{const c=e.orig?e.orig.currency:t.currency;const b=by[c]||(by[c]={orig:0,base:0,n:0});b.orig+=e.orig?toMinor(e.orig.amount,c):e.amountMinor;b.base+=e.amountMinor;b.n++});
  Object.keys(t.rates||{}).forEach(c=>{if(!by[c]&&c!==t.currency)by[c]={orig:0,base:0,n:0}});
  const rows=Object.entries(by).sort((a,b)=>b[1].base-a[1].base);
  return `<div class="card" style="grid-column:1/-1"><div class="section-head"><h2>Currencies on this trip</h2><span class="muted" style="font-size:.85rem">Balances are kept in ${esc(t.currency)}</span></div>
    ${rows.length?`<div class="audit-frame"><table class="audit"><thead><tr><th>Currency</th><th class="r">Spent</th><th class="r">In ${esc(t.currency)}</th><th class="r">Average rate</th><th>Current rate</th></tr></thead><tbody>
    ${rows.map(([c,b])=>{const r=t.rates?.[c];const avg=b.orig&&c!==t.currency?(b.orig/10**digits(c))/(b.base/10**digits(t.currency)):null;
      return `<tr><td>${esc(curLabel(c))}</td><td class="r num">${fmt(b.orig,c)}</td><td class="r num">${fmt(b.base,t.currency)}</td><td class="r num">${avg?`1 ${esc(t.currency)} = ${+avg.toPrecision(5)} ${esc(c)}`:'—'}</td><td class="num">${(()=>{const a=autoRate(c,t.currency,today());if(a)return esc(rateTxt({currency:c,per:sig(STRONG.has(c)?a.fwd:a.inv),dir:STRONG.has(c)?'fwd':'inv',src:'auto',rateDate:a.date},t.currency));if(r)return esc(rateTxt({currency:c,per:r.x,dir:r.dir},t.currency))+` <span class="muted">(entered ${esc(fmtStamp(r.at))})</span>`;return c===t.currency?'—':'<span class="muted">per entry</span>'})()}</td></tr>`}).join('')}
    </tbody></table></div>`:'<p class="muted" style="margin:0">Pay in any currency. Pick it when you add an expense and enter the rate you were charged; the ledger converts it to '+esc(t.currency)+'.</p>'}</div>`;
}

/* ---------- modals ---------- */
function openModal(html,onMount){const m=$('#modal');m.innerHTML=`<div class="overlay" data-a="close-bg"><div class="sheet" role="dialog" aria-modal="true">${html}</div></div>`;onMount&&onMount(m.querySelector('.sheet'));const f=m.querySelector('input,select,textarea');f&&f.focus()}
function closeModal(){$('#modal').innerHTML='';if(dbState==='ready'){render();setTimeout(()=>askWho(false),0)}}

function simpleForm(title,fields,submitLabel,onSubmit){
  openModal(`<div class="sheet-h"><h2>${esc(title)}</h2><button class="x" data-a="close" aria-label="Close">×</button></div>
    <form id="sf" style="display:grid;gap:12px">${fields}<div class="err" id="sfErr" hidden></div>
    <div class="actions"><div class="right"><button type="button" class="btn" data-a="close">Cancel</button><button class="btn primary" type="submit">${esc(submitLabel)}</button></div></div></form>`,
  sheet=>sheet.querySelector('#sf').addEventListener('submit',async ev=>{ev.preventDefault();const err=await onSubmit(new FormData(ev.target));if(err){const e=sheet.querySelector('#sfErr');e.textContent=err;e.hidden=false}else closeModal()}));
}
const curLabel=c=>{try{const n=new Intl.DisplayNames(['en'],{type:'currency'}).of(c);return n&&n!==c?`${c} · ${n}`:c}catch(e){return c}};
const curOptions=sel=>CURRENCIES.map(c=>`<option value="${c}" ${c===sel?'selected':''}>${esc(curLabel(c))}</option>`).join('');
function savedRate(t,cur){const r=t.rates?.[cur];if(r&&r.x)return {rate:String(r.x),rateDir:r.dir||'fwd'};return {rate:'',rateDir:STRONG.has(cur)?'fwd':'inv'}}

function newTripForm(){
  simpleForm('New trip',`<label class="lbl">Trip name<input class="field" id="tn" name="name" placeholder="e.g. Croatia road trip" required maxlength="80"></label>
    <label class="lbl">Settle-up currency (balances and final payments)<select class="field" id="tc" name="currency">${curOptions(trip()?.currency||'GBP')}</select></label>
    <label class="lbl">People travelling (one per line or comma separated)<textarea class="field" id="tp" name="people" rows="3" placeholder="Paul&#10;Sam&#10;Priya"></textarea></label>`,'Create trip',async fd=>{
    const name=String(fd.get('name')).trim();if(!name)return 'Give the trip a name.';
    const people=String(fd.get('people')||'').split(/[\n,]/).map(s=>s.trim()).filter(Boolean).slice(0,30).map(n=>({id:uid('p_'),name:n.slice(0,40)}));
    const id=uid('t_');
    const ok=await writeSafe(()=>db.doc('trips/'+id).set({name:name.slice(0,80),currency:fd.get('currency'),people,createdAt:new Date().toISOString(),createdBy:actor()}),'Trip created');
    if(!ok)return 'Could not create the trip.';
    tripId=id;lsSet('cs.trip',id);addTrip(id);tab=people.length>=2?'balances':'trip';subscribeEntries();render();
  });
}
function editTripForm(){
  const t=trip();const locked=entries.length>0;
  simpleForm('Edit trip',`<label class="lbl">Trip name<input class="field" id="etn" name="name" value="${esc(t.name)}" required maxlength="80"></label>
    <label class="lbl">Settle-up currency (balances and final payments)<select class="field" id="etc" name="currency" ${locked?'disabled':''}>${curOptions(t.currency)}</select>${locked?'<span style="font-weight:400">Locked once entries exist, so past figures never change meaning.</span>':''}</label>`,'Save',async fd=>{
    const name=String(fd.get('name')).trim();if(!name)return 'Give the trip a name.';
    const ok=await writeSafe(()=>db.doc('trips/'+t.id).update({name:name.slice(0,80),...(locked?{}:{currency:fd.get('currency')})}),'Trip updated');return ok?null:'Could not save.';
  });
}
function personForm(pid){
  const t=trip();const p=(t.people||[]).find(x=>x.id===pid);
  simpleForm(p?'Rename person':'Add person',`<label class="lbl">Name<input class="field" id="pn" name="name" value="${esc(p?.name||'')}" required maxlength="40"></label>`,p?'Save':'Add',async fd=>{
    const name=String(fd.get('name')).trim();if(!name)return 'Enter a name.';
    if((t.people||[]).some(x=>x.id!==pid&&x.name.toLowerCase()===name.toLowerCase()))return 'Someone on this trip already has that name.';
    const people=p?(t.people||[]).map(x=>x.id===pid?{...x,name}:x):[...(t.people||[]),{id:uid('p_'),name}];
    const ok=await writeSafe(()=>db.doc('trips/'+t.id).update({people}),p?'Renamed':'Added '+name);return ok?null:'Could not save.';
  });
}
function confirmBox(title,text,label,fn){
  openModal(`<div class="sheet-h"><h2>${esc(title)}</h2><button class="x" data-a="close" aria-label="Close">×</button></div><p style="margin:0">${esc(text)}</p>
    <div class="actions"><div class="right"><button class="btn" data-a="close">Cancel</button><button class="btn primary" id="cfm">${esc(label)}</button></div></div>`,s=>s.querySelector('#cfm').onclick=async()=>{await fn();closeModal()});
}

/* ---------- entry form ---------- */
let fs=null;
function entryForm(existing,preset){
  const t=trip();const ppl=t.people||[];
  if(existing){const e=existing;fs={id:e.id,orig:e,kind:e.kind,desc:e.desc||'',date:e.date,category:e.kind==='payment'?'food':e.category,paidBy:e.paidBy,to:e.to||'',notes:e.notes||'',
      currency:e.orig?e.orig.currency:t.currency,amount:e.orig?String(e.orig.amount):plain(e.amountMinor,t.currency),rate:e.orig?String(e.orig.per??e.orig.rate):'',rateDir:e.orig?.dir||'fwd',rateSrc:e.orig?.src||'manual',rateDate:e.orig?.rateDate||null,
      mode:e.splitMode||'equal',participants:e.splitMode==='equal'?[...(e.participants||[])]:ppl.map(p=>p.id),pct:{},amt:{}};
    if(e.splitMode==='percent')ppl.forEach(p=>fs.pct[p.id]=e.weights?.[p.id]!=null?String(e.weights[p.id]):'');
    if(e.splitMode==='amount')ppl.forEach(p=>fs.amt[p.id]=e.weights?.[p.id]!=null?String(e.weights[p.id]):'');
  } else {
    const last=lsGet('cs.cur.'+t.id);const cur=CURRENCIES.includes(last)?last:t.currency;
    fs={id:null,kind:'expense',desc:'',date:today(),category:'food',paidBy:ppl.find(p=>p.id===lsGet('cs.me.'+t.id))?.id||ppl[0]?.id||'',to:'',notes:'',
      currency:cur,amount:'',...(cur!==t.currency?savedRate(t,cur):{rate:'',rateDir:'fwd'}),rateSrc:'manual',rateDate:null,mode:'equal',participants:ppl.map(p=>p.id),pct:{},amt:{}};
    if(fs.currency!==t.currency)applyAuto();
    if(preset)Object.assign(fs,preset);
  }
  openModal('<div id="ef"></div>',()=>drawEntryForm());
}
function formCalc(){
  const t=trip();const base=t.currency;const n=parseNum(fs.amount);const foreign=fs.currency!==base;const x=parseNum(fs.rate);const inv=fs.rateDir==='inv';
  const r=isNaN(x)||x<=0?NaN:(inv?1/x:x);
  const baseMinor=isNaN(n)||n<=0?0:foreign?(isNaN(r)?0:Math.round((inv?n/x:n*x)*10**digits(base))):toMinor(n,base);
  let weights=[];const ppl=t.people||[];
  if(fs.mode==='equal')weights=fs.participants.map(p=>[p,1]);
  else if(fs.mode==='percent')weights=ppl.map(p=>[p.id,Math.max(0,parseNum(fs.pct[p.id])||0)]);
  else weights=ppl.map(p=>[p.id,Math.max(0,parseNum(fs.amt[p.id])||0)]);
  const shares=fs.kind==='payment'?{}:allocate(baseMinor,weights);
  return {base,n,foreign,r,x,inv,baseMinor,weights,shares};
}
function drawEntryForm(){
  const t=trip();const ppl=t.people||[];const c=formCalc();const pay=fs.kind==='payment';
  const opt=(sel,excl)=>ppl.filter(p=>p.id!==excl).map(p=>`<option value="${esc(p.id)}" ${p.id===sel?'selected':''}>${esc(p.name)}</option>`).join('');
  const splitRows=ppl.map(p=>{
    const sh=c.shares[p.id]||0;
    const ctrl=fs.mode==='equal'?`<input type="checkbox" id="sp_${esc(p.id)}" data-f="part" data-p="${esc(p.id)}" ${fs.participants.includes(p.id)?'checked':''} style="justify-self:end;width:18px;height:18px">`
      :fs.mode==='percent'?`<input class="field" type="number" inputmode="decimal" min="0" max="100" step="any" id="sp_${esc(p.id)}" data-f="pct" data-p="${esc(p.id)}" value="${esc(fs.pct[p.id]??'')}" placeholder="0" aria-label="${esc(p.name)} percent">`
      :`<input class="field" type="number" inputmode="decimal" min="0" step="any" id="sp_${esc(p.id)}" data-f="amt" data-p="${esc(p.id)}" value="${esc(fs.amt[p.id]??'')}" placeholder="0" aria-label="${esc(p.name)} amount">`;
    return `<div class="split-row"><label class="who" for="sp_${esc(p.id)}"><span class="av">${esc(initials(p.name))}</span><span>${esc(p.name)}</span></label>${ctrl}<span class="sh num" data-sh="${esc(p.id)}">${fmt(sh,c.base)}</span></div>`}).join('');
  const hist=fs.orig?.history?.length?`<div class="hist">${fs.orig.history.slice().reverse().slice(0,8).map(h=>`<span>${esc(fmtStamp(h.at))} · ${esc(h.text)} · ${esc(who(h.by))}</span>`).join('')}</div>`:'';
  if(fs.orig)resolveNames([...new Set((fs.orig.history||[]).map(h=>h.by))]);
  $('#ef').innerHTML=`<div class="sheet-h"><h2>${fs.id?(pay?'Edit settlement':'Edit expense'):(pay?'Record a payment':'Add expense')}</h2><button class="x" data-a="close" aria-label="Close">×</button></div>
  <form id="entryForm" style="display:grid;gap:14px" novalidate>
    <div class="seg" role="group" aria-label="Entry type"><button type="button" data-f="kind" data-v="expense" aria-pressed="${!pay}">Expense</button><button type="button" data-f="kind" data-v="payment" aria-pressed="${pay}">Settlement payment</button></div>
    <label class="lbl">${pay?'Note (optional)':'What was it?'}<input class="field" id="f_desc" data-f="desc" value="${esc(fs.desc)}" maxlength="120" placeholder="${pay?'e.g. Bank transfer':'e.g. Dinner at Taberna da Rua'}"></label>
    <div class="row">
      <label class="lbl">Amount<input class="field num" id="f_amount" data-f="amount" type="number" inputmode="decimal" min="0" step="any" value="${esc(fs.amount)}" placeholder="0.00"></label>
      <label class="lbl">Currency<select class="field" id="f_currency" data-f="currency">${curOptions(fs.currency)}</select></label>
    </div>
    ${c.foreign?`<div style="display:grid;gap:8px"><div class="section-head"><span class="eyebrow">Exchange rate</span><div class="seg" role="group" aria-label="Rate direction"><button type="button" data-f="rateDir" data-v="inv" aria-pressed="${c.inv}">1 ${esc(c.base)} = ? ${esc(fs.currency)}</button><button type="button" data-f="rateDir" data-v="fwd" aria-pressed="${!c.inv}">1 ${esc(fs.currency)} = ? ${esc(c.base)}</button></div></div>
      <div class="row" style="align-items:end"><label class="lbl">${c.inv?`How many ${esc(fs.currency)} you got for 1 ${esc(c.base)}`:`Value of 1 ${esc(fs.currency)} in ${esc(c.base)}`}<input class="field num" id="f_rate" data-f="rate" type="number" inputmode="decimal" min="0" step="any" value="${esc(fs.rate)}" placeholder="${c.inv?'e.g. 1250':'e.g. 0.86'}"></label><div class="conv" id="conv">${convTxt(c)}</div></div>
      <div id="rateNote" style="font-size:.8rem">${rateNote(c)}</div></div>`:''}
    <div class="row">
      <label class="lbl">Date<input class="field" type="date" id="f_date" data-f="date" value="${esc(fs.date)}"></label>
      ${pay?'':`<label class="lbl">Category<select class="field" id="f_cat" data-f="category">${CATS.map(([k,l])=>`<option value="${k}" ${k===fs.category?'selected':''}>${l}</option>`).join('')}</select></label>`}
    </div>
    <div class="row">
      <label class="lbl">${pay?'From (who paid)':'Paid by'}<select class="field" id="f_paid" data-f="paidBy">${opt(fs.paidBy)}</select></label>
      ${pay?`<label class="lbl">To (who received it)<select class="field" id="f_to" data-f="to"><option value="">Choose…</option>${opt(fs.to,fs.paidBy)}</select></label>`:''}
    </div>
    ${pay?'':`<div style="display:grid;gap:8px"><div class="section-head"><span class="eyebrow">Split</span><div class="seg" role="group" aria-label="Split method">${[['equal','Equally'],['percent','By %'],['amount','By amounts']].map(([k,l])=>`<button type="button" data-f="mode" data-v="${k}" aria-pressed="${fs.mode===k}">${l}</button>`).join('')}</div></div>
      <div class="split">${splitRows}<div class="split-foot" id="splitFoot">${splitFoot(c)}</div></div></div>`}
    <label class="lbl">Notes for the record (optional)<input class="field" id="f_notes" data-f="notes" value="${esc(fs.notes)}" maxlength="200" placeholder="e.g. Receipt in Sam's photos, card ending 4411"></label>
    <div class="err" id="efErr" hidden></div>
    <div class="actions">${fs.id?(fs.orig.voided?'<button type="button" class="btn" data-a="restore">Restore entry</button>':'<button type="button" class="btn danger" data-a="void">Void entry</button>'):''}
      <div class="right"><button type="button" class="btn" data-a="close">Cancel</button><button type="submit" class="btn primary">${fs.id?'Save changes':'Save'}</button></div></div>
    ${hist}
  </form>`;
}
function splitFoot(c){
  if(fs.mode==='equal')return `<span>${fs.participants.length} of ${(trip().people||[]).length} sharing</span><span class="num">${fs.participants.length?fmt(Math.floor(c.baseMinor/fs.participants.length),c.base)+' each':''}</span>`;
  if(fs.mode==='percent'){const s=c.weights.reduce((a,[,w])=>a+w,0);const left=+(100-s).toFixed(4);return `<span>${+s.toFixed(4)}% allocated</span><span style="display:flex;gap:10px;align-items:center"><span class="${Math.abs(left)<0.001?'c-pos':'c-neg'}">${Math.abs(left)<0.001?'Adds up to 100%':left>0?left+'% left':(-left)+'% too much'}</span><button type="button" class="btn ghost sm" data-a="even-pct">Split evenly</button></span>`}
  const s=c.weights.reduce((a,[,w])=>a+w,0);const tot=isNaN(c.n)?0:c.n;const d=digits(fs.currency);const left=Math.round((tot-s)*10**d)/10**d;
  return `<span>${fmt(Math.round(s*10**d),fs.currency)} of ${fmt(Math.round(tot*10**d),fs.currency)} allocated</span><span class="${left===0?'c-pos':'c-neg'}">${left===0?'Adds up':left>0?fmt(Math.round(left*10**d),fs.currency)+' left':fmt(Math.round(-left*10**d),fs.currency)+' too much'}</span>`;
}
function refreshCalc(){
  const c=formCalc();
  document.querySelectorAll('[data-sh]').forEach(el=>el.textContent=fmt(c.shares[el.dataset.sh]||0,c.base));
  const f=$('#splitFoot');if(f)f.innerHTML=splitFoot(c);
  const conv=$('#conv');if(conv)conv.innerHTML=convTxt(c);
}
function convTxt(c){return c.baseMinor?`= <b class="num">${fmt(c.baseMinor,c.base)}</b> recorded in the ledger`:'Enter the rate you were charged so the ledger can convert it.'}
function validate(c){
  const t=trip();
  if(fs.kind==='expense'&&!fs.desc.trim())return 'Add a short description so everyone recognises the expense.';
  if(isNaN(c.n)||c.n<=0)return 'Enter an amount above zero.';
  if(c.foreign&&(isNaN(c.r)||c.r<=0))return `Enter the exchange rate from ${fs.currency} to ${c.base}.`;
  if(!c.baseMinor)return 'The amount is too small to record.';
  if(!/^\d{4}-\d{2}-\d{2}$/.test(fs.date))return 'Pick a date.';
  if(!fs.paidBy)return 'Choose who paid.';
  if(fs.kind==='payment'){if(!fs.to)return 'Choose who received the payment.';if(fs.to===fs.paidBy)return 'A payment needs two different people.';return null}
  if(fs.mode==='equal'&&!fs.participants.length)return 'Tick at least one person to share this.';
  if(fs.mode==='percent'){const s=c.weights.reduce((a,[,w])=>a+w,0);if(Math.abs(s-100)>0.001)return `Percentages add up to ${+s.toFixed(3)}%. They need to total 100%.`}
  if(fs.mode==='amount'){const d=digits(fs.currency);const s=Math.round(c.weights.reduce((a,[,w])=>a+w,0)*10**d);if(s!==Math.round(c.n*10**d))return `Split amounts total ${fmt(s,fs.currency)} but the expense is ${fmt(Math.round(c.n*10**d),fs.currency)}.`}
  return null;
}
function describeChange(a,b,t){
  const ch=[];const cur=t.currency;
  if(a.desc!==b.desc)ch.push(`description “${a.desc}” → “${b.desc}”`);
  if(a.amountMinor!==b.amountMinor)ch.push(`amount ${fmt(a.amountMinor,cur)} → ${fmt(b.amountMinor,cur)}`);
  if(a.date!==b.date)ch.push(`date ${a.date} → ${b.date}`);
  if(a.paidBy!==b.paidBy)ch.push(`paid by ${pname(a.paidBy,t)} → ${pname(b.paidBy,t)}`);
  if((a.to||'')!==(b.to||''))ch.push(`recipient ${pname(a.to,t)} → ${pname(b.to,t)}`);
  if(a.kind!==b.kind)ch.push(`type ${a.kind} → ${b.kind}`);
  if(a.category!==b.category&&b.kind!=='payment')ch.push(`category → ${catName(b.category)}`);
  if(JSON.stringify(sharesOf(a))!==JSON.stringify(sharesOf(b))&&a.amountMinor===b.amountMinor)ch.push('split changed');
  if((a.notes||'')!==(b.notes||''))ch.push('notes changed');
  return ch.length?'Edited: '+ch.join('; '):'Saved with no changes';
}
async function saveEntry(){
  const t=trip();const c=formCalc();const err=validate(c);const box=$('#efErr');
  if(err){box.textContent=err;box.hidden=false;return}
  const now=new Date().toISOString();
  const doc={kind:fs.kind,desc:fs.desc.trim(),date:fs.date,category:fs.kind==='payment'?'payment':fs.category,amountMinor:c.baseMinor,currency:t.currency,paidBy:fs.paidBy,
    to:fs.kind==='payment'?fs.to:null,splitMode:fs.kind==='payment'?null:fs.mode,participants:fs.kind==='expense'&&fs.mode==='equal'?ppOrder(fs.participants):[],
    weights:fs.kind==='expense'&&fs.mode!=='equal'?Object.fromEntries(c.weights.filter(([,w])=>w>0)):{},
    orig:c.foreign?{amount:c.n,currency:fs.currency,rate:+c.r.toPrecision(10),per:c.x,dir:c.inv?'inv':'fwd',src:fs.rateSrc==='auto'?'auto':'manual',rateDate:fs.rateSrc==='auto'?fs.rateDate:null}:null,notes:fs.notes.trim(),voided:false,updatedAt:now,updatedBy:actor()};
  let body;
  if(fs.id){const o=fs.orig;doc.voided=!!o.voided;body={...doc,createdAt:o.createdAt,createdBy:o.createdBy||null,history:[...(o.history||[]),{at:now,by:actor(),text:describeChange(o,doc,t)}].slice(-40)}}
  else body={...doc,createdAt:now,createdBy:actor(),history:[{at:now,by:actor(),text:fs.kind==='payment'?`Recorded payment of ${fmt(c.baseMinor,t.currency)}`:`Added for ${fmt(c.baseMinor,t.currency)}`}]};
  const ref=fs.id?entryCol(t.id).doc(fs.id):entryCol(t.id).doc();
  const ok=await writeSafe(()=>ref.set(body),fs.id?'Changes saved':fs.kind==='payment'?'Payment recorded':'Expense added');
  if(ok){lsSet('cs.cur.'+t.id,fs.currency);closeModal();
    const prev=t.rates?.[fs.currency];const dir=c.inv?'inv':'fwd';
    if(c.foreign&&!fs.id&&fs.rateSrc!=='auto'&&(!prev||prev.x!==c.x||prev.dir!==dir))writeSafe(()=>db.doc('trips/'+t.id).update({rates:{[fs.currency]:{x:c.x,dir,at:new Date().toISOString()}}}));}
}
const ppOrder=ids=>(trip().people||[]).map(p=>p.id).filter(id=>ids.includes(id));
async function setVoid(v){
  const t=trip();const {id:oid,...o}=fs.orig;const now=new Date().toISOString();
  const ok=await writeSafe(()=>entryCol(t.id).doc(oid).set({...o,voided:v,updatedAt:now,updatedBy:actor(),history:[...(o.history||[]),{at:now,by:actor(),text:v?'Voided (kept on record, excluded from totals)':'Restored'}].slice(-40)}),v?'Entry voided':'Entry restored');
  if(ok)closeModal();
}

/* ---------- example trip ---------- */
async function createExample(){
  const id=uid('t_');const P=['Alex','Sam','Priya','Leo'].map(n=>({id:uid('p_'),name:n}));const [A,S,Pr,L]=P.map(p=>p.id);
  const y=new Date().getFullYear();const d=n=>`${y}-05-${String(n).padStart(2,'0')}`;const now=Date.now();
  const mk=(i,o)=>{const at=new Date(now-(20-i)*60000).toISOString();return {kind:'expense',category:'food',splitMode:'equal',participants:[A,S,Pr,L],weights:{},to:null,orig:null,notes:'',voided:false,currency:'GBP',createdAt:at,updatedAt:at,createdBy:actor(),updatedBy:actor(),history:[{at,by:actor(),text:'Added (example)'}],...o}};
  const eur=(a,r=0.86)=>({orig:{amount:a,currency:'EUR',rate:r},amountMinor:Math.round(a*r*100)});
  const list=[
    mk(1,{desc:'Apartment in Alfama, 3 nights',category:'stay',date:d(9),paidBy:A,amountMinor:54600,notes:'Booked online, confirmation in Alex’s email'}),
    mk(2,{desc:'Hire car, 3 days',category:'car',date:d(9),paidBy:S,...eur(186)}),
    mk(3,{desc:'Dinner at a tasca',date:d(9),paidBy:Pr,...eur(112.4)}),
    mk(4,{desc:'Sintra palace tickets',category:'activity',date:d(10),paidBy:L,...eur(80),splitMode:'equal',participants:[A,S,L],notes:'Priya skipped the palace'}),
    mk(5,{desc:'Fuel and tolls',category:'car',date:d(10),paidBy:S,...eur(64.2)}),
    mk(6,{desc:'Seafood lunch',date:d(11),paidBy:A,...eur(140),splitMode:'percent',weights:{[A]:30,[S]:30,[Pr]:20,[L]:20}}),
    {...mk(7,{kind:'payment',category:'payment',desc:'Bank transfer',date:d(11),paidBy:L,to:A,amountMinor:6000,splitMode:null,participants:[]})},
  ];
  const ok=await writeSafe(()=>db.doc('trips/'+id).set({name:'Example: Lisbon long weekend',currency:'GBP',people:P,createdAt:new Date().toISOString(),createdBy:actor(),example:true}));
  if(!ok)return;
  for(const e of list){await writeSafe(()=>entryCol(id).doc().set(e))}
  tripId=id;lsSet('cs.trip',id);addTrip(id);tab='balances';subscribeEntries();render();toast('Example trip created. Delete it any time once it is empty, or just start a new trip.');
}

/* ---------- CSV ---------- */
function buildCSV(){
  const t=trip();const {no,byDate}=ordered();const calc=compute(t,byDate);const cur=t.currency;const ppl=t.people||[];
  const q=v=>{const s=String(v??'');return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s};
  const head=['No','Date','Type','Description','Category','Paid by','Paid to','Amount ('+cur+')','Original amount','Original currency','Rate (1 original = x '+cur+')','Rate as entered','Split method','Voided','Notes',...ppl.flatMap(p=>[p.name+' share',p.name+' change',p.name+' balance']),'Created','Last edited'];
  const lines=[head.map(q).join(',')];
  calc.rows.forEach(({e,sh,delta,running})=>{lines.push([`#${no[e.id]}`,e.date,e.kind==='payment'?'Settlement':'Expense',e.desc,catName(e.category),pname(e.paidBy,t),e.to?pname(e.to,t):'',plain(e.amountMinor,cur),e.orig?.amount??'',e.orig?.currency??'',e.orig?.rate??'',e.orig?rateTxt(e.orig,cur):'',e.splitMode||'',e.voided?'yes':'',e.notes||'',
    ...ppl.flatMap(p=>[plain(e.voided?0:(sh[p.id]||0),cur),plain(delta[p.id]||0,cur),plain(running[p.id]||0,cur)]),e.createdAt||'',e.updatedAt||''].map(q).join(','))});
  lines.push('');lines.push(['Summary','','','','','','','Total spend',plain(calc.total,cur)].map(q).join(','));
  ppl.forEach(p=>{const s=calc.S[p.id]||blank();lines.push([p.name,'paid',plain(s.paid,cur),'share',plain(s.share,cur),'settlements sent',plain(s.sent,cur),'received',plain(s.recv,cur),'balance',plain(s.bal,cur)].map(q).join(','))});
  settlePlan(calc.S).forEach(x=>lines.push([pname(x.from,t)+' pays '+pname(x.to,t),plain(x.amt,cur)].map(q).join(',')));
  return lines.join('\n');
}
const downloadsCap={save:async({filename,data})=>{const b=new Blob([data],{type:'text/csv'});const u=URL.createObjectURL(b);const a=document.createElement('a');a.href=u;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),3000)}};

/* ---------- events ---------- */
document.addEventListener('click',async ev=>{
  const el=ev.target.closest('[data-a],[data-f]');if(!el)return;
  if(el.dataset.f&&el.tagName==='BUTTON'){ // entry form segmented controls
    const f=el.dataset.f,v=el.dataset.v;
    if(f==='rateDir'&&fs.rateDir!==v){const x=parseNum(fs.rate);fs.rateDir=v;if(fs.rateSrc==='auto')applyAuto();else if(x>0)fs.rate=sig(1/x)}
    if(f==='kind'){fs.kind=v;if(v==='payment'&&!fs.to){fs.to=(trip().people||[]).find(p=>p.id!==fs.paidBy)?.id||''}}
    if(f==='mode'){fs.mode=v;const ppl=trip().people||[];if(v==='percent'&&!Object.values(fs.pct).some(x=>x!==''))evenPct();if(v==='amount'&&!Object.values(fs.amt).some(x=>x!=='')){ppl.forEach(p=>fs.amt[p.id]='')}}
    drawEntryForm();return;
  }
  const a=el.dataset.a;
  if(a==='close-bg'&&ev.target!==el)return;
  switch(a){
    case 'close':case 'close-bg':closeModal();break;
    case 'tab':tab=el.dataset.v;lsSet('cs.tab',tab);render();break;
    case 'new-trip':newTripForm();break;
    case 'example':createExample();break;
    case 'add':entryForm(null);break;
    case 'edit':{const e=entries.find(x=>x.id===el.dataset.id);if(e)entryForm(e);break}
    case 'pay':entryForm(null,{kind:'payment',paidBy:el.dataset.from,to:el.dataset.to,amount:plain(+el.dataset.amt,trip().currency),currency:trip().currency,rate:'',desc:''});break;
    case 'void':setVoid(true);break;
    case 'restore':setVoid(false);break;
    case 'use-auto':if(fs){applyAuto();drawEntryForm()}break;
    case 'even-pct':evenPct();drawEntryForm();break;
    case 'trip-edit':editTripForm();break;
    case 'person-add':personForm(null);break;
    case 'person-rename':personForm(el.dataset.id);break;
    case 'person-remove':{const t=trip();const p=t.people.find(x=>x.id===el.dataset.id);confirmBox('Remove '+p.name+'?',p.name+' is not in any entry yet, so removing them changes no figures.','Remove',()=>writeSafe(()=>db.doc('trips/'+t.id).update({people:t.people.filter(x=>x.id!==p.id)}),'Removed '+p.name));break}
    case 'trip-delete':{const t=trip();confirmBox('Delete “'+t.name+'”?','This trip has no entries. Deleting it removes it for everyone who has the link.','Delete trip',async()=>{if(await writeSafe(()=>db.doc('trips/'+t.id).delete(),'Trip deleted')){forgetTrip(t.id)}});break}
    case 'invite':invite();break;
    case 'who':askWho(true);break;
    case 'set-self':{const t=trip();lsSet('cs.self.'+t.id,el.dataset.id);lsSet('cs.me.'+t.id,el.dataset.id);closeModal();render();break}
    case 'skip-self':{lsSet('cs.self.'+trip().id,'-');closeModal();break}
    case 'leave':{const t=trip();confirmBox('Remove “'+t.name+'” from this phone?','The trip stays available to everyone else. You can rejoin later with the invite link.','Remove',()=>{forgetTrip(t.id)});break}
    case 'csv-copy':{const csv=buildCSV();try{await navigator.clipboard.writeText(csv);toast('Ledger copied as CSV. Paste it into a spreadsheet.')}catch(e){openModal(`<div class="sheet-h"><h2>Ledger CSV</h2><button class="x" data-a="close" aria-label="Close">×</button></div><p class="muted" style="margin:0">Select all and copy, then paste into a spreadsheet.</p><textarea class="field num" id="csvText" rows="12" style="font-size:.75rem">${esc(csv)}</textarea>`,s=>{const ta=s.querySelector('textarea');ta.focus();ta.select()})}break}
    case 'csv-save':{if(!downloadsCap)return;const t=trip();try{await downloadsCap.save({filename:(t.name.replace(/[^\w\- ]+/g,'').trim()||'trip')+' ledger.csv',data:buildCSV()})}catch(e){if(e?.code&&e.code!=='cancelled'&&e.code!=='declined')toast('Download was not saved.')}break}
  }
});
function evenPct(){const ppl=trip().people||[];const n=ppl.length;if(!n)return;const base=Math.floor(10000/n)/100;let left=+(100-base*n).toFixed(2);ppl.forEach((p,i)=>{let v=base;if(i===0)v=+(base+left).toFixed(2);fs.pct[p.id]=String(v)})}
document.addEventListener('input',ev=>{
  const el=ev.target;if(!fs||!el.dataset||!el.dataset.f||el.tagName==='BUTTON')return;const f=el.dataset.f;
  if(f==='part'){const p=el.dataset.p;fs.participants=el.checked?[...new Set([...fs.participants,p])]:fs.participants.filter(x=>x!==p);refreshCalc();return}
  if(f==='pct'){fs.pct[el.dataset.p]=el.value;refreshCalc();return}
  if(f==='amt'){fs.amt[el.dataset.p]=el.value;refreshCalc();return}
  fs[f]=el.value;
  if(f==='currency'){const t=trip();Object.assign(fs,fs.currency===t.currency?{rate:'',rateDir:'fwd'}:savedRate(t,fs.currency),{rateSrc:'manual',rateDate:null});if(fs.currency!==t.currency)applyAuto();drawEntryForm();$('#f_currency')?.focus();return}
  if(f==='rate'){fs.rateSrc='manual';fs.rateDate=null;const n=$('#rateNote');if(n)n.innerHTML=rateNote(formCalc())}
  if(f==='date'&&fs.rateSrc==='auto'&&fs.currency!==trip().currency){applyAuto();const r=$('#f_rate');if(r)r.value=fs.rate;const n=$('#rateNote');if(n)n.innerHTML=rateNote(formCalc())}
  if(f==='paidBy'&&fs.kind==='payment'){if(fs.to===fs.paidBy)fs.to='';drawEntryForm();return}
  if(f==='paidBy')lsSet('cs.me.'+trip().id,fs.paidBy);
  refreshCalc();
});
document.addEventListener('change',ev=>{
  if(ev.target.id==='tripPick'){tripId=ev.target.value;lsSet('cs.trip',tripId);subscribeEntries();render()}
});
document.addEventListener('submit',ev=>{if(ev.target.id==='entryForm'){ev.preventDefault();saveEntry()}});
document.addEventListener('keydown',ev=>{if(ev.key==='Escape'&&$('#modal').innerHTML)closeModal()});

/* ---------- trips on this device, invites, identity ---------- */
let bootError='',bootHint='';
const tripSubs={},tripData={};let pendingJoin=null;
function myTrips(){try{return JSON.parse(lsGet('cs.trips')||'[]')}catch(e){return []}}
function setMyTrips(ids){lsSet('cs.trips',JSON.stringify([...new Set(ids)]))}
function addTrip(id){setMyTrips([...myTrips(),id]);watchTrip(id)}
function forgetTrip(id){setMyTrips(myTrips().filter(x=>x!==id));if(tripSubs[id]){tripSubs[id]();delete tripSubs[id]}delete tripData[id];if(tripId===id)tripId=null;refreshTrips()}
function watchTrip(id){
  if(tripSubs[id]||!db)return;
  tripSubs[id]=db.doc('trips/'+id).onSnapshot(s=>{
    if(s.exists){tripData[id]={id,...s.data()};if(pendingJoin===id){pendingJoin=null;tripId=id;lsSet('cs.trip',id);toast('Joined '+tripData[id].name)}}
    else if(!s.metadata.fromCache){if(pendingJoin===id){pendingJoin=null;toast('That invite link does not match any trip.')}forgetTrip(id);return}
    refreshTrips();
  },err=>{console.error(err);if(pendingJoin===id){pendingJoin=null;toast('Could not open that invite link.')}forgetTrip(id)});
}
function refreshTrips(){
  trips=Object.values(tripData).sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||''));
  dbState='ready';
  if(!trips.find(t=>t.id===tripId)){const saved=lsGet('cs.trip');tripId=(trips.find(t=>t.id===saved)||trips[0]||{}).id||null}
  subscribeEntries();
  if(!$('#modal').innerHTML){render();askWho(false)}
}
function inviteLink(id){return location.origin+location.pathname+'#join='+id}
async function invite(){
  const t=trip();const url=inviteLink(t.id);
  if(navigator.share){try{await navigator.share({title:'Cost Share: '+t.name,text:'Join our trip "'+t.name+'" on Cost Share to log and split costs.',url});return}catch(e){if(e.name==='AbortError')return}}
  try{await navigator.clipboard.writeText(url);toast('Invite link copied. Send it to your travel companions.');return}catch(e){}
  openModal(`<div class="sheet-h"><h2>Invite link</h2><button class="x" data-a="close" aria-label="Close">×</button></div><p class="muted" style="margin:0">Send this link to your travel companions. Anyone with it can view and add expenses.</p><input class="field num" id="invUrl" readonly value="${esc(url)}">`,s=>{const i=s.querySelector('input');i.focus();i.select()});
}
function askWho(force){
  const t=trip();if(!t||!(t.people||[]).length)return;
  if(!force&&lsGet('cs.self.'+t.id))return;
  if($('#modal').innerHTML&&!force)return;
  openModal(`<div class="sheet-h"><h2>Who are you on this trip?</h2><button class="x" data-a="skip-self" aria-label="Close">×</button></div>
    <p class="muted" style="margin:0">Your name goes on the changes you make, so the history shows who added or edited what. It is remembered on this phone only.</p>
    <div style="display:grid;gap:8px">${t.people.map(p=>`<button class="btn" style="justify-content:flex-start" data-a="set-self" data-id="${esc(p.id)}"><span class="av">${esc(initials(p.name))}</span>${esc(p.name)}</button>`).join('')}</div>
    <p class="muted" style="margin:0;font-size:.82rem">Not listed? Close this, then add yourself in the Trip &amp; people tab.</p>`);
}
function handleHash(){
  const m=location.hash.match(/^#join=([A-Za-z0-9_-]{8,40})$/);if(!m)return;
  history.replaceState(null,'',location.pathname+location.search);
  const id=m[1];
  if(tripData[id]){tripId=id;lsSet('cs.trip',id);refreshTrips();return}
  pendingJoin=id;addTrip(id);
}

/* ---------- exchange rates: fetched every time the app opens ---------- */
function mergeFx(list){const by={};[...fx,...list].forEach(d=>{if(d&&d.date&&d.rates)by[d.date]=d});fx=Object.values(by).sort((a,b)=>b.date.localeCompare(a.date))}
let lastFetch=0,serverFxDates=new Set();
async function fetchRates(){
  if(!navigator.onLine||Date.now()-lastFetch<30*60*1000)return;
  lastFetch=Date.now();
  try{
    const r=await fetch('https://open.er-api.com/v6/latest/USD',{cache:'no-store'});const j=await r.json();
    if(j.result!=='success'||!j.rates||j.rates.USD!==1)return;
    const date=new Date(j.time_last_update_unix*1000).toISOString().slice(0,10);
    const rec={date,base:'USD',source:'open.er-api.com (ExchangeRate-API)',providerUpdated:j.time_last_update_utc,fetchedAt:new Date().toISOString(),rates:j.rates};
    lsSet('cs.fx.latest',JSON.stringify(rec));mergeFx([rec]);
    if(db&&!serverFxDates.has(date))db.doc('fx/'+date).set(rec).catch(()=>{});
    if(!$('#modal').innerHTML)render();
  }catch(e){console.warn('Rates fetch failed',e)}
}

/* ---------- connection status ---------- */
function updateNet(){
  const el=$('#net');if(!el)return;
  if(!navigator.onLine){el.textContent='Offline · saving on this phone';el.className='net off';el.hidden=false}
  else if(pendingSync){el.textContent='Syncing…';el.className='net sync';el.hidden=false}
  else el.hidden=true;
}
addEventListener('online',()=>{updateNet();fetchRates()});addEventListener('offline',updateNet);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')fetchRates()});
addEventListener('hashchange',handleHash);

/* ---------- boot ---------- */
(async function boot(){
  tab=lsGet('cs.tab')||'balances';
  try{const l=JSON.parse(lsGet('cs.fx.latest')||'null');if(l)mergeFx([l])}catch(e){}
  updateNet();
  if('serviceWorker' in navigator)navigator.serviceWorker.register('sw.js').catch(()=>{});
  if(!firebaseConfig||!firebaseConfig.projectId){dbState='none';render();return}
  try{
    const app=initializeApp(firebaseConfig);
    fdb=initializeFirestore(app,{localCache:persistentLocalCache({tabManager:persistentMultipleTabManager()})});
    db=fsApi;
    const auth=getAuth(app);
    await new Promise((res,rej)=>{const off=onAuthStateChanged(auth,async u=>{off();if(u)return res(u);try{res((await signInAnonymously(auth)).user)}catch(e){rej(e)}},rej)});
  }catch(e){
    console.error(e);dbState='none';
    bootError=navigator.onLine?'Could not connect to the database':'You are offline';
    bootHint=navigator.onLine?'Check that Anonymous sign-in is enabled in Firebase, then reload.':'Open the app once while online to set it up on this phone. After that it works offline.';
    render();return;
  }
  db.collection('fx').orderBy('date','desc').limit(180).onSnapshot(s=>{
    const list=s.docs.map(d=>d.data()).filter(d=>d&&d.date&&d.rates);
    if(!s.metadata.fromCache)serverFxDates=new Set(list.map(d=>d.date));
    mergeFx(list);
    if(!s.metadata.fromCache)fetchRates();
    if(!$('#modal').innerHTML)render();
  },e=>console.warn(e));
  const ids=myTrips();
  if(!ids.length)dbState='ready';
  ids.forEach(watchTrip);
  handleHash();
  render();
  setTimeout(fetchRates,4000);
})();
