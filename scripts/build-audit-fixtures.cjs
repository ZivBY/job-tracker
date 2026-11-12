// Isolated browser fixtures: real UI code, synthetic records, no Firebase/proxy calls.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'output', 'playwright');
fs.mkdirSync(out, { recursive: true });
const mock = `
const initializeApp=()=>({}), getFirestore=()=>({}), getAuth=()=>({});
class GoogleAuthProvider { setCustomParameters(){} }
let auditNextId=0;
const collection=(...a)=>a.slice(1), query=(x)=>x, orderBy=()=>null;
function doc(...args){const ref=args.length===1&&Array.isArray(args[0])?[...args[0],'generated-'+(++auditNextId)]:args.slice(1);ref.id=ref.at(-1);ref.path=ref.join('/');return ref;}
const serverTimestamp=()=>({seconds:Math.floor(Date.now()/1000)});
let auditRecords=[], auditSubscriber=null, auditWrites=[], auditFailure=false;
function auditSnapshot(){ if(auditSubscriber) auditSubscriber({docs:auditRecords.map((x,i)=>({id:x.firestoreId||'fixture-'+i,data:()=>x}))}); }
const onSnapshot=(q,cb)=>{auditSubscriber=cb;queueMicrotask(auditSnapshot);return ()=>{auditSubscriber=null;};};
const getDoc=async()=>({exists:()=>true,data:()=>({name:'Audit fixture'})});
const getDocs=async()=>({docs:[]});
const setDoc=async(ref,fields,options)=>{if(ref.at(-2)!=='jobs')return;auditWrites.push({operation:'setDoc',ref:[...ref],fields});if(auditFailure)throw Error('Simulated offline failure');const index=auditRecords.findIndex(j=>j.firestoreId===ref.id);const value={...(options?.merge&&index>=0?auditRecords[index]:{}),...fields,firestoreId:ref.id};if(index>=0)auditRecords[index]=value;else auditRecords.unshift(value);queueMicrotask(auditSnapshot);}; const deleteDoc=async()=>{};
const signInWithPopup=async()=>{}, signInWithRedirect=async()=>{}, getRedirectResult=async()=>null, setPersistence=async()=>{}, browserLocalPersistence={}, fbSignOut=async()=>{};
function onAuthStateChanged(a,cb){queueMicrotask(()=>cb({uid:'audit-fixture-user',email:ADMIN_EMAIL,displayName:'Audit Fixture',getIdToken:async()=>'fixture-not-a-token'}));}
function auditApply(target,fields){ for(const [key,value] of Object.entries(fields)){const parts=key.split('.');let t=target;for(const p of parts.slice(0,-1))t=t[p]||(t[p]={});t[parts.at(-1)]=value;}}
const updateDoc=async(ref,fields)=>{auditWrites.push({ref,fields});if(auditFailure)throw Error('Simulated offline failure');const found=auditRecords.find(j=>j.firestoreId===ref.at(-1));if(found)auditApply(found,fields);queueMicrotask(auditSnapshot);};
const addDoc=async(ref,fields)=>{auditWrites.push({ref,fields});if(auditFailure)throw Error('Simulated offline failure');const id='added-'+auditWrites.length;auditRecords.unshift({...fields,firestoreId:id});queueMicrotask(auditSnapshot);return {id};};
function auditFixture(n){return Array.from({length:n},(_,i)=>({firestoreId:'fixture-'+i,company:'Fixture Company '+i,role:'Operations Director '+i,loc:'San Francisco',type:'Full-time',stage:i%6,color:'#635BFF',emoji:'F',rejected:false,declined:false,archived:false,notes:'Synthetic notes for measurement only. '.repeat(3),url:'https://example.com/jobs/'+i,recruiterName:'Fixture recruiter',stageHistory:[{stage:0,ts:Date.now()-30*864e5},{stage:i%6,ts:Date.now()-3*864e5}],stageData:{1:{appliedDate:'2026-10-16',resumeVersion:'fixture.pdf'}},stageNotes:{},interviewRounds:[{type:'Phone screen',date:'2026-11-20T10:00',with:'Fixture interviewer',notes:'Synthetic'}],attachments:[],contacts:[],createdAt:{seconds:Math.floor(Date.now()/1000)-i*3600}}));}
window.fetch=async()=>{throw Error('Network disabled in audit fixture');};
window.addEventListener('error',e=>{document.getElementById('audit-log').textContent+='\\nERROR '+e.message;});
window.addEventListener('unhandledrejection',e=>{document.getElementById('audit-log').textContent+='\\nREJECTION '+e.reason;});
`;
const controls=`<aside style="position:sticky;top:0;z-index:100000;background:#e8f3ff;color:#111;padding:8px;font:13px system-ui"><b>SYNTHETIC AUDIT — no live database</b> <button id="audit-bench">Benchmark render</button> <button id="audit-seed">Load 50 fixtures</button> <button id="audit-update">Simulate snapshot</button> <button id="audit-fail">Toggle failed saves</button><pre id="audit-log" style="max-height:140px;overflow:auto;white-space:pre-wrap">Ready</pre></aside>`;
const hooks=`
document.getElementById('audit-seed').onclick=()=>{auditRecords=auditFixture(50);auditSnapshot();};
document.getElementById('audit-update').onclick=auditSnapshot;
document.getElementById('audit-fail').onclick=()=>{auditFailure=!auditFailure;document.getElementById('audit-log').textContent='Failed saves: '+auditFailure;};
document.getElementById('audit-bench').onclick=async()=>{
 const results=[];
 for(const n of [50,200,1000]){
  const times=[];
  for(let r=0;r<6;r++){auditRecords=auditFixture(n); const t=performance.now();auditSnapshot();document.body.offsetHeight;times.push(performance.now()-t);await new Promise(resolve=>requestAnimationFrame(resolve));}
  const measured=times.slice(1).sort((a,b)=>a-b);
  results.push({records:n,medianMs:+measured[2].toFixed(2),maxMs:+measured.at(-1).toFixed(2),nodes:document.querySelectorAll('*').length});
 }
 document.getElementById('audit-log').textContent=JSON.stringify({results,userAgent:navigator.userAgent,viewport:[innerWidth,innerHeight],method:'five warm synchronous snapshot+render+layout samples; no network/auth latency'},null,2);
};
`;
for(const [name,file,baseline] of [['baseline','index.html',true],['fixed','index.html',false],['mobile-fixed','index_mobile.html',false]]){
 let html=baseline?cp.execFileSync('git',['show','HEAD:'+file],{cwd:root,encoding:'utf8'}):fs.readFileSync(path.join(root,file),'utf8');
 html=html.replace('<head>','<head><base href="/">');
 html=html.replace('<body>','<body>'+controls);
 html=html.replace(/import \{[^\n]+from "https:\/\/www\.gstatic\.com\/firebasejs\/[^\n]+;\r?\n/g,'');
 html=html.replace(/if \(['"]serviceWorker['"] in navigator\) \{[\s\S]*?\n\}/g,'');
 html=html.replace(/<script type="module">/, '<script type="module">\n'+mock);
 const end=html.lastIndexOf('</script>');html=html.slice(0,end)+hooks+html.slice(end);
 fs.writeFileSync(path.join(out,'audit-'+name+'.html'),html);
}
console.log('Built isolated baseline/fixed/mobile fixtures in '+out);
