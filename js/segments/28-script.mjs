
import {collection,collectionGroup,doc,getDoc,getDocs,onSnapshot,query,where,runTransaction,setDoc,serverTimestamp} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import {onAuthStateChanged} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
(()=>{
  "use strict";
  if(window.__exploraDerivationRankingDefinitiveRepairV272)return;
  window.__exploraDerivationRankingDefinitiveRepairV272=true;
  const VERSION="v2.4.39-cache-busters-final-sync",RATE=.10,CARD_SOURCE="weekly-derivation-ranking";
  const F=window.ExploraFirebase||{},$=id=>document.getElementById(id);let db=F.db,auth=F.auth;
  const text=v=>String(v??"").trim(),esc=v=>text(v).replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));
  const norm=v=>text(v).normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[\s_-]+/g," ").trim();
  const money=v=>new Intl.NumberFormat("es-AR",{style:"currency",currency:"ARS",maximumFractionDigits:0}).format(Math.round(Number(v)||0)).replace("ARS","$").replace(/\s+/g," ");
  const pick=(o,keys)=>{for(const k of keys){const v=o?.[k];if(v!==undefined&&v!==null&&text(v)!=="")return v}return null};
  const dateMs=v=>{if(!v)return 0;if(typeof v?.toMillis==="function")return v.toMillis();if(Number.isFinite(Number(v?.seconds)))return Number(v.seconds)*1000+Math.floor(Number(v.nanoseconds||0)/1e6);const n=Date.parse(v);return Number.isFinite(n)?n:0};
  function parseMoney(value){
    if(typeof value==="number")return Number.isFinite(value)&&value>=0?Math.round((value+Number.EPSILON)*100)/100:0;
    let s=text(value).replace(/\s+/g,"").replace(/[^0-9,.-]/g,"");
    if(!s||s.startsWith("-")||/^-?0*(?:[.,]0*)?$/.test(s))return 0;
    const comma=s.lastIndexOf(","),dot=s.lastIndexOf(".");
    if(comma>=0&&dot>=0){
      const decimalIndex=Math.max(comma,dot),fraction=s.slice(decimalIndex+1).replace(/[.,]/g,"");
      s=s.slice(0,decimalIndex).replace(/[.,]/g,"")+(fraction.length<=2?"."+fraction:fraction);
    }else if(comma>=0||dot>=0){
      const separator=comma>=0?",":".",parts=s.split(separator),fraction=parts.at(-1)||"";
      s=(parts.length>2||fraction.length===3)?parts.join(""):parts.slice(0,-1).join("")+"."+fraction;
    }
    const n=Number(s);return Number.isFinite(n)&&n>=0?Math.round((n+Number.EPSILON)*100)/100:0;
  }
  const senderKeys=["senderUid","senderId","senderDriverUid","derivatorUid","derivadorUid","fromUid","createdBy","createdByUid","ownerUid","emitterUid","emisorUid","sentByUid","driverSenderUid","originDriverUid","choferOrigenUid","choferOrigenId","derivadorId","originalSenderUid"];
  const receiverKeys=["receiverUid","receiverId","receiverDriverUid","recipientUid","acceptedBy","acceptedByUid","completedBy","completedByUid","billedBy","driverUid","choferUid","receptorUid","assignedDriverUid","receivedByUid","toUid","choferReceptorUid","choferReceptorId","receptorChoferId"];
  const amountKeys=["linkedBillingGrossAmount","billingGrossAmount","confirmedBillingAmount","grossAmount","montoFinal","finalAmount","totalAmount","serviceAmount","billedAmount","amountCharged","derivedAmount","dineroDerivado","cycleDerivedAmount","cycleDineroDerivado","billingAmount","amount","monto","total","confirmedAmount","valorServicio","importe","suggestedAmount","finalPrice"];
  const linkKeys=["derivationId","derivacionId","referralId","sourceDerivationId","linkedDerivationId","originDerivationId","billingServiceId","serviceId","billingId","billingRecordId","cobroId","paymentId","operationId","operacionId","originServiceId","sourceServiceId","documentId"];
  const statusKeys=["estado","status","normalizedStatus","derivationStatus","acceptanceStatus","confirmationStatus","billingStatus","completionStatus","paymentStatus","estadoDerivacion"];
  const excluded=["pending","pendiente","sent","enviada","enviado","rejected","rechazada","rechazado","cancelled","canceled","cancelada","cancelado","anulada","anulado","deleted","eliminada","eliminado","expired","vencida","vencido","refunded","reembolsada","reembolsado","duplicada","duplicado","cerrada rechazada","closed rejected"];
  const state={generation:0,userUid:"",role:"",weekScope:null,profiles:new Map(),profileRows:[],rows:[],sourceRows:[],publicRows:[],loaded:false,loading:false,refreshing:false,pending:false,unsubs:[],observer:null,lastError:null,lastDiagnostic:"",counts:{documentsRead:0,valid:0,duplicates:0,discarded:0,billings:0,reasons:{}},lastContext:{},lastResult:{source:"EMPTY_VALID_RESULT",grossAmount:0,count:0,bonus:0},selfTests:null,selfTestPromise:null,startPromise:null};
  const sessionRole=()=>norm(window.ExploraSession?.role||window.ExploraSession?.profile?.role||window.ExploraAuthSession?.role||(document.body.classList.contains("explora-shared-admin")?"admin":"chofer"));
  const isAdmin=()=>/admin|administrador|owner|superadmin/.test(state.role||sessionRole());
  const activeWeekScope=()=>{const period=window.ExploraFirestoreClock?.getWeeklyPeriod?.()||window.ExploraWeeklyPeriods?.active?.();if(!period?.id)return{id:"",weeklyPeriodId:"",periods:[],legacyIds:[]};const scope=window.ExploraWeeklyPeriods?.scopeFor?.(period.id)||{id:period.id,weeklyPeriodId:period.id,startPeriodId:period.id,endPeriodId:period.id,periods:[period]};return{...scope,id:period.id,weeklyPeriodId:period.id,startPeriodId:period.id,endPeriodId:period.id,periods:[period],legacyIds:[]};};
  const senderUid=o=>text(pick(o,senderKeys)),receiverUid=o=>text(pick(o,receiverKeys));
  const statusText=o=>statusKeys.map(k=>norm(o?.[k])).filter(Boolean).join(" | ");
  const hasExcluded=o=>{const s=statusText(o);return excluded.some(t=>s.includes(t))||o?.deleted===true||o?.isDeleted===true||o?.cancelled===true||o?.canceled===true||o?.refunded===true};
  const accepted=o=>{const s=statusText(o);return o?.accepted===true||o?.aceptada===true||o?.aceptado===true||Boolean(pick(o,["acceptedAt","fechaAceptacion","acceptedByUid"]))||/(accepted|aceptad|confirmad|in progress|en curso|realizad|complet|factur|invoic)/.test(s)};
  const completed=o=>{const s=statusText(o);return o?.completed===true||o?.completada===true||o?.completado===true||o?.realizada===true||o?.realizado===true||o?.confirmed===true||o?.confirmada===true||Boolean(pick(o,["completedAt","confirmedAt","finishedAt","fechaFinalizacion","fechaConfirmacion"]))||/(completed|complet|confirm|finished|realizad|factur|invoic)/.test(s)};
  const billed=o=>{const s=statusText(o);return o?.billed===true||o?.facturada===true||o?.facturado===true||o?.invoiced===true||o?.paid===true||o?.cobrada===true||o?.cobrado===true||o?.paymentConfirmed===true||o?.billingConfirmed===true||Boolean(pick(o,["billedAt","invoicedAt","paidAt","fechaFacturacion","billingRecordId","billingId","paymentId","cobroId"]))||/(billed|factur|invoic|paid|cobrad|complet)/.test(s)};
  const idsFor=(o,id="")=>{const set=new Set([text(id),text(o?.id)]);for(const k of linkKeys){const v=text(o?.[k]);if(v)set.add(v)}return [...set].filter(Boolean)};
  const eventTime=(d,b)=>dateMs(pick(b||{},["billedAt","invoicedAt","paidAt","completedAt","createdAt","updatedAt"]))||dateMs(pick(d||{},["billedAt","invoicedAt","completedAt","confirmedAt","acceptedAt","updatedAt","createdAt"]));
  const resolveAmount=(d,b)=>{for(const src of [b,d])for(const k of amountKeys){const n=parseMoney(src?.[k]);if(n>0)return n}return 0};
  function fingerprint(d,b,gross){const explicit=text(pick(d,["derivationId","derivacionId","referralId","sourceDerivationId","linkedDerivationId","originDerivationId"])||pick(b,["derivationId","derivacionId","referralId","sourceDerivationId","linkedDerivationId","originDerivationId"]));if(explicit)return `derivation:${norm(explicit)}`;const billing=text(pick(b,["billingRecordId","billingId","cobroId","paymentId"])||pick(d,["billingRecordId","billingId","cobroId","paymentId"]));if(billing)return `billing:${norm(billing)}`;const day=new Date(eventTime(d,b)||0).toISOString().slice(0,10);return [senderUid(d)||senderUid(b),receiverUid(d)||receiverUid(b),text(pick(d,["serviceId","concept","description","descripcion"])),day,Number(gross).toFixed(2)].map(norm).join("|")}
  function reason(key){state.counts.discarded++;state.counts.reasons[key]=(state.counts.reasons[key]||0)+1}
  function profileUid(p,id=""){return text(p?.uid||p?.authUid||p?.firebaseUid||p?.userId||p?.driverUid||p?.choferUid||p?.id||id)}
  function profileName(p,fallback="Chofer"){return text(p?.nombreCompleto||p?.fullName||p?.displayName||[p?.nombre,p?.apellido].filter(Boolean).join(" ")||p?.name||p?.nombre||p?.usuario||fallback||"Chofer")}
  function profileAvatar(p){return text(p?.photoURL||p?.avatarUrl||p?.avatar||p?.fotoUrl||p?.profilePhotoUrl||p?.fotoPerfil||p?.foto)}
  function profileFor(alias){return state.profiles.get(norm(alias))||null}
  function canonicalUid(alias){const p=profileFor(alias);return profileUid(p,alias)||text(alias)}
  function addProfile(raw,id,source){const p={id,source,...raw},uid=profileUid(p,id),aliases=[uid,id,p.authUid,p.firebaseUid,p.userId,p.driverUid,p.choferUid,p.driverId,p.choferId,p.email,p.username,p.usuario].map(norm).filter(Boolean);state.profileRows.push(p);aliases.forEach(a=>{const prev=state.profiles.get(a);if(!prev||profileUid(prev).length<uid.length)state.profiles.set(a,p)});}
  async function readProfiles(){state.profiles.clear();state.profileRows=[];const errors=[];for(const name of ["choferes","users","usuarios","drivers","profiles","perfiles"]){try{const s=await getDocs(collection(db,name));state.counts.documentsRead+=s.size;s.forEach(x=>addProfile(x.data()||{},x.id,name));}catch(e){errors.push({name,error:e})}}if(!state.profiles.size&&errors.length===6)throw Object.assign(errors[0].error||new Error("No se pudieron resolver perfiles."),{internalCode:"DERIVATION_RANKING_PROFILE_NOT_RESOLVED"});}
  function billingIndex(rows){const map=new Map();for(const b of rows){if(hasExcluded(b))continue;for(const id of idsFor(b,b.id)){const current=map.get(id);if(!current||eventTime({},b)>eventTime({},current))map.set(id,b)}}return map}
  function normalizeSources(derivations,billings,weekScope=state.weekScope,{commitCounts=true}={}){
    const localCounts={documentsRead:derivations.length+billings.length,valid:0,duplicates:0,discarded:0,billings:billings.length,reasons:{}};
    const discard=key=>{localCounts.discarded++;localCounts.reasons[key]=(localCounts.reasons[key]||0)+1};
    const bi=billingIndex(billings),seen=new Map();
    for(const d of derivations){
      if(hasExcluded(d)){discard("estado_excluido");continue}
      let b=null;for(const id of idsFor(d,d.id)){if(bi.has(id)){b=bi.get(id);break}}
      if(!accepted(d)){discard("no_aceptada");continue}
      if(!completed(d)){discard("no_completada");continue}
      if(!(b||billed(d))){discard("sin_facturacion");continue}
      const time=eventTime(d,b);
      const explicitPeriodId=text(pick(b||d,["weeklyPeriodIdCompleted","weeklyPeriodId","periodId","weekId","periodoSemanalId","periodoId"]));
      const derivedPeriod=explicitPeriodId?window.ExploraWeeklyPeriods?.fromId?.(explicitPeriodId):window.ExploraWeeklyPeriods?.fromDate?.(new Date(time||Date.now()));
      const rowPeriodId=text(derivedPeriod?.id||explicitPeriodId);
      if(weekScope?.id&&rowPeriodId&&rowPeriodId!==weekScope.id){discard("fuera_de_semana");continue}
      if(weekScope?.id&&!rowPeriodId&&!window.ExploraWeeklyPeriods?.contains?.(weekScope,{...d,...(b||{})},time)){discard("fuera_de_semana");continue}
      const rawSender=senderUid(d)||senderUid(b),rawReceiver=receiverUid(d)||receiverUid(b);
      if(!rawSender){discard("derivador_no_resuelto");continue}
      if(rawReceiver&&norm(rawSender)===norm(rawReceiver)){discard("receptor_como_derivador");continue}
      const gross=resolveAmount(d,b);if(!(gross>0)){discard("monto_invalido");continue}
      const key=fingerprint(d,b,gross);if(!key){discard("clave_invalida");continue}
      const candidate={derivationId:text(pick(d,["derivationId","derivacionId","documentId"])||d.id||key),billingId:text(b?.id||pick(b||d,["billingRecordId","billingId","paymentId","cobroId"])||"embedded"),senderUid:canonicalUid(rawSender),senderRawUid:rawSender,receiverUid:canonicalUid(rawReceiver)||rawReceiver,grossAmount:gross,firstAt:time||Number.MAX_SAFE_INTEGER,weeklyPeriodId:rowPeriodId||weekScope?.id||"",source:d,linkedBilling:b,key};
      const previous=seen.get(key);
      if(previous){
        localCounts.duplicates++;
        const previousScore=(previous.linkedBilling?4:0)+(previous.firstAt&&previous.firstAt!==Number.MAX_SAFE_INTEGER?1:0);
        const candidateScore=(b?4:0)+(time?1:0);
        if(candidateScore>previousScore)seen.set(key,candidate);
        continue;
      }
      seen.set(key,candidate);
    }
    const qualified=[...seen.values()];localCounts.valid=qualified.length;
    const byUid=new Map();
    for(const q of qualified){
      const p=profileFor(q.senderUid)||profileFor(q.senderRawUid),uid=profileUid(p,q.senderUid)||q.senderUid;
      const cur=byUid.get(uid)||{uid,name:profileName(p,text(q.source?.emisorName||q.source?.senderName||uid)),avatar:profileAvatar(p)||text(q.source?.emisorPhotoUrl||q.source?.senderPhotoUrl),derivedAmount:0,count:0,projectedBonus:0,firstAt:Number.MAX_SAFE_INTEGER,aliases:new Set(),weeklyPeriodId:weekScope?.id||q.weeklyPeriodId,items:[]};
      cur.derivedAmount=Math.round((cur.derivedAmount+q.grossAmount+Number.EPSILON)*100)/100;cur.count++;cur.projectedBonus=Math.round((cur.derivedAmount*RATE+Number.EPSILON)*100)/100;cur.firstAt=Math.min(cur.firstAt,q.firstAt||Number.MAX_SAFE_INTEGER);[uid,q.senderRawUid,q.senderUid].map(norm).filter(Boolean).forEach(a=>cur.aliases.add(a));cur.items.push(q);byUid.set(uid,cur);
    }
    if(commitCounts)state.counts=localCounts;
    return sortRows([...byUid.values()]);
  }
  function sortRows(rows){return rows.filter(r=>r&&r.uid&&Number(r.derivedAmount)>0).sort((a,b)=>Number(b.derivedAmount)-Number(a.derivedAmount)||Number(b.count)-Number(a.count)||(a.firstAt||Number.MAX_SAFE_INTEGER)-(b.firstAt||Number.MAX_SAFE_INTEGER)||norm(a.name).localeCompare(norm(b.name),"es")||text(a.uid).localeCompare(text(b.uid))).map((r,i)=>({...r,position:i+1,projectedBonus:Math.round(Number(r.derivedAmount)*RATE),bonus:Math.round(Number(r.derivedAmount)*RATE)}))}
  function publicRow(raw,id="",expectedWeeklyPeriodId=state.weekScope?.id||""){const rawWeeklyPeriodId=text(raw?.weeklyPeriodId||raw?.periodoSemanalId||raw?.weekId||raw?.periodId);if(rawWeeklyPeriodId&&expectedWeeklyPeriodId&&rawWeeklyPeriodId!==expectedWeeklyPeriodId)return null;const uid=canonicalUid(pick(raw,["uid","driverUid","choferUid","emisorUid","senderUid"])||id),derived=parseMoney(pick(raw,["derivedAmount","derivedAmountForEmitter","dineroDerivadoBruto","totalDerivedMoney","grossDerivedAmount","derivedMoney"]));if(!uid||!derived)return null;const p=profileFor(uid);return{uid,name:profileName(p,text(pick(raw,["name","driverName","nombreCompleto","emisorName"])||uid)),avatar:profileAvatar(p)||text(pick(raw,["avatar","photoURL","avatarUrl","driverAvatar"])),count:Math.max(0,Math.round(Number(pick(raw,["count","derivationCount","validDerivations","cantidadDerivaciones","serviceCount"])||0))),derivedAmount:derived,projectedBonus:Math.round(derived*RATE),firstAt:Number(raw?.firstAtMs)||dateMs(pick(raw,["firstAt","firstValidDerivationAt","reachedAt","updatedAt","createdAt"]))||Number.MAX_SAFE_INTEGER,weeklyPeriodId:rawWeeklyPeriodId||expectedWeeklyPeriodId,aliases:new Set([norm(uid)])}}
  function mergeRows(...sets){const map=new Map();for(const rows of sets)for(const r of rows||[]){if(!r?.uid||!(Number(r.derivedAmount)>0))continue;const uid=canonicalUid(r.uid),k=norm(uid),p=map.get(k);if(!p){map.set(k,{...r,uid,aliases:new Set(r.aliases||[k])});continue}const prefer=Number(r.derivedAmount)>Number(p.derivedAmount)||(Number(r.derivedAmount)===Number(p.derivedAmount)&&Number(r.count)>Number(p.count));if(prefer)map.set(k,{...p,...r,uid,aliases:new Set([...(p.aliases||[]),...(r.aliases||[]),k])})}return sortRows([...map.values()])}
  async function readCollectionSafe(ref,tag){try{const s=await getDocs(ref);state.counts.documentsRead+=s.size;return{rows:s.docs.map(x=>({id:x.id,...(x.data()||{})})),ok:true,tag}}catch(error){return{rows:[],ok:false,error,tag}}}
  async function readPublicRows(weekScope){
    const canonical=[],errors=[];let successfulDriverReads=0,collectionGroupRead=false;
    for(const parent of ["derivation_ranking_public","ranking_derivaciones_public","performance_public"]){
      const current=await readCollectionSafe(collection(db,parent,weekScope.id,"drivers"),`${parent}/${weekScope.id}/drivers`);
      if(current.ok){successfulDriverReads++;current.rows.forEach(x=>{const r=publicRow(x,x.id,weekScope.id);if(r)canonical.push(r)})}else errors.push(current);
      try{const d=await getDoc(doc(db,parent,weekScope.id));state.counts.documentsRead++;if(d.exists()){const raw=d.data()||{};for(const arr of [raw.rows,raw.drivers,raw.ranking,raw.derivations,raw.items])if(Array.isArray(arr))arr.forEach((x,i)=>{const r=publicRow(x,text(x?.uid||i),weekScope.id);if(r)canonical.push(r)})}}catch(error){errors.push({error,tag:`${parent}/${weekScope.id}`})}
    }
    try{const cg=await getDocs(query(collectionGroup(db,"drivers"),where("weeklyPeriodId","==",weekScope.id)));collectionGroupRead=true;state.counts.documentsRead+=cg.size;cg.forEach(x=>{const r=publicRow(x.data()||{},x.id,weekScope.id);if(r)canonical.push(r)})}catch(error){errors.push({error,tag:`collectionGroup(drivers) where weeklyPeriodId == ${weekScope.id}`})}
    return{rows:mergeRows(canonical),errors,settledCurrent:successfulDriverReads>0||collectionGroupRead,successfulDriverReads};
  }
  async function readEvents(weekScope){
    const got=await readCollectionSafe(collection(db,"derivation_ranking_public",weekScope.id,"events"),`derivation_ranking_public/${weekScope.id}/events`),errors=got.ok?[]:[got],events=got.ok?got.rows:[];
    if(!events.length)return{rows:[],events,errors,settledCurrent:got.ok};
    const derivations=events.map(e=>({...e,id:e.derivationId||e.id,status:e.status||"FACTURADA",estado:e.estado||"FACTURADA",accepted:e.accepted!==false,completed:e.completed!==false,billed:e.billed!==false,finalAmount:e.grossAmount||e.derivedAmount,derivedAmountForEmitter:e.grossAmount||e.derivedAmount,emisorUid:e.senderUid,receptorUid:e.receiverUid,completedAt:e.completedAt||e.updatedAt,weeklyPeriodId:e.weeklyPeriodId||weekScope.id}));
    return{rows:normalizeSources(derivations,[],weekScope),events,errors,settledCurrent:got.ok};
  }
  async function queryByAliases(collectionName,fields,value,map,errors){for(const field of fields){try{const s=await getDocs(query(collection(db,collectionName),where(field,"==",value)));s.forEach(x=>map.set(`${collectionName}:${x.id}`,{id:x.id,...(x.data()||{})}));}catch(error){errors.push({error,tag:`${collectionName} where ${field}`})}}}
  async function readDetailed(weekScope){
    const derivations=new Map(),billings=new Map(),errors=[],uid=state.userUid;let derivationReads=0,billingReads=0;
    if(isAdmin()){
      for(const name of ["derivaciones","historial_derivaciones"]){const r=await readCollectionSafe(collection(db,name),name);if(r.ok){derivationReads++;r.rows.forEach(x=>derivations.set(`${name}:${x.id}`,x))}else errors.push(r)}
      for(const name of ["billing_records","facturaciones","cobros","servicios"]){const r=await readCollectionSafe(collection(db,name),name);if(r.ok){billingReads++;r.rows.forEach(x=>billings.set(`${name}:${x.id}`,x))}else errors.push(r)}
    }else{
      for(const name of ["derivaciones","historial_derivaciones"]){const before=errors.length;await queryByAliases(name,["emisorUid","senderUid","derivadorUid","fromUid","createdByUid","receptorUid","receiverUid","acceptedByUid","completedByUid"],uid,derivations,errors);if(errors.length===before)derivationReads++}
      for(const name of ["billing_records","facturaciones","cobros","servicios"]){const before=errors.length;await queryByAliases(name,["driverUid","choferUid","uid","ownerUid","originalSenderUid","emisorUid","receptorUid"],uid,billings,errors);if(errors.length===before)billingReads++}
    }
    const rows=normalizeSources([...derivations.values()],[...billings.values()],weekScope);state.sourceRows=[...derivations.values()];return{rows,derivations:[...derivations.values()],billings:[...billings.values()],errors,settledCurrent:isAdmin()&&derivationReads>0&&billingReads>0};
  }
  async function upsertFromQualified(q,{silent=true}={}){
    if(!q?.derivationId||!q?.senderUid||!(q.grossAmount>0)||!state.weekScope?.id)return false;
    const weekScope=state.weekScope,eventRef=doc(db,"derivation_ranking_public",weekScope.id,"events",q.derivationId),newSummaryRef=doc(db,"derivation_ranking_public",weekScope.id,"drivers",q.senderUid);
    try{
      await runTransaction(db,async tx=>{
        const oldEventSnap=await tx.get(eventRef),old=oldEventSnap.exists()?oldEventSnap.data():null,oldSender=text(old?.senderUid),oldAmount=parseMoney(old?.grossAmount),oldActive=old?.active!==false&&oldAmount>0,oldSummaryRef=oldSender&&norm(oldSender)!==norm(q.senderUid)?doc(db,"derivation_ranking_public",weekScope.id,"drivers",oldSender):null;
        const refs=[newSummaryRef];if(oldSummaryRef)refs.push(oldSummaryRef);const snaps=[];for(const ref of refs)snaps.push(await tx.get(ref));
        const newSnap=snaps[0],newData=newSnap.exists()?newSnap.data():{},newBaseAmount=parseMoney(newData.derivedAmount||newData.dineroDerivadoBruto),newBaseCount=Math.max(0,Math.round(Number(newData.count||newData.derivationCount||0)));
        const sameSender=oldActive&&norm(oldSender)===norm(q.senderUid),summaryApplied=old?.summaryApplied===true,deltaAmount=q.grossAmount-(sameSender&&summaryApplied?oldAmount:0),deltaCount=oldEventSnap.exists()?(sameSender&&summaryApplied?0:1):1,p=profileFor(q.senderUid);
        tx.set(newSummaryRef,{uid:q.senderUid,driverUid:q.senderUid,name:profileName(p,text(q.source?.emisorName||q.source?.senderName||q.senderUid)),driverName:profileName(p,text(q.source?.emisorName||q.source?.senderName||q.senderUid)),avatar:profileAvatar(p)||text(q.source?.emisorPhotoUrl||q.source?.senderPhotoUrl),derivedAmount:Math.max(0,newBaseAmount+deltaAmount),dineroDerivadoBruto:Math.max(0,newBaseAmount+deltaAmount),count:Math.max(0,newBaseCount+deltaCount),derivationCount:Math.max(0,newBaseCount+deltaCount),bonusProjected:Math.round(Math.max(0,newBaseAmount+deltaAmount)*RATE),firstAtMs:Math.min(Number(newData.firstAtMs)||Number.MAX_SAFE_INTEGER,Number(q.firstAt)||Date.now()),weeklyPeriodId:weekScope.id,startPeriodId:weekScope.startPeriodId,endPeriodId:weekScope.endPeriodId,schemaVersion:272,updatedAt:serverTimestamp()},{merge:true});
        if(oldSummaryRef){const oldSnap=snaps[1],od=oldSnap.exists()?oldSnap.data():{},oa=parseMoney(od.derivedAmount||od.dineroDerivadoBruto),oc=Math.max(0,Math.round(Number(od.count||od.derivationCount||0)));tx.set(oldSummaryRef,{derivedAmount:Math.max(0,oa-oldAmount),dineroDerivadoBruto:Math.max(0,oa-oldAmount),count:Math.max(0,oc-1),derivationCount:Math.max(0,oc-1),bonusProjected:Math.round(Math.max(0,oa-oldAmount)*RATE),updatedAt:serverTimestamp()},{merge:true})}
        tx.set(eventRef,{derivationId:q.derivationId,billingId:q.billingId||"",senderUid:q.senderUid,receiverUid:q.receiverUid||"",grossAmount:q.grossAmount,derivedAmount:q.grossAmount,collaborationRate:RATE,collaborationAmount:Math.round(q.grossAmount*RATE),projectedBonus:Math.round(q.grossAmount*RATE),weeklyPeriodId:q.weeklyPeriodId||weekScope.id,accepted:true,completed:true,billed:true,active:true,status:"FACTURADA",estado:"FACTURADA",completedAt:q.source?.completedAt||q.source?.confirmedAt||q.source?.invoicedAt||serverTimestamp(),summaryApplied:true,updatedAt:serverTimestamp(),schemaVersion:272},{merge:true});
      });return true;
    }catch(error){if(!silent)diagnostic("WRITE_PUBLIC_SUMMARY","DERIVATION_RANKING_PERMISSION_DENIED",error,{derivationId:q.derivationId,senderUid:q.senderUid,receiverUid:q.receiverUid,billingId:q.billingId,amount:q.grossAmount,path:`derivation_ranking_public/${weekScope.id}`});return false}
  }
  async function backfillQualified(rows){const items=[];for(const r of rows||[])for(const q of r.items||[])items.push(q);for(const q of items.slice(0,40))await upsertFromQualified(q,{silent:true});return items.length}
  function renderLoading(){state.loading=true;const list=$("performanceDerivationsList"),status=$("performanceScreenStatus");window.ExploraStableDerivationCard?.render(null,{source:CARD_SOURCE,uid:state.userUid,weeklyPeriodId:state.weekScope?.id||"",loading:true});if(list&&!state.loaded)list.innerHTML='<div class="performance-history-empty">Cargando dinero derivado de la semana activa…</div>';if(status)status.textContent="Sincronizando ranking de derivaciones…";}
  function rowMarkup(r){return `<article class="performance-ranking-row${r.position===1?" is-leader":""}" data-derivation-uid="${esc(r.uid)}"><div class="performance-ranking-percent"><small>PUESTO</small>${r.position}</div><div class="performance-ranking-copy"><strong>${esc(r.name)}</strong><span>TOTAL DERIVADO · ${money(r.derivedAmount)}</span><span class="derivation-ranking-count">DERIVACIONES COMPLETADAS · ${r.count}</span></div><div class="performance-ranking-money"><small>BONO POTENCIAL · 10%</small>+${money(r.projectedBonus)}</div></article>`}
  function render(rows,{force=false,settled=false,error=false}={}){
    if(!state.loaded&&!force)return;state.rows=sortRows(rows);state.loading=false;const leader=state.rows[0]||null,list=$("performanceDerivationsList"),status=$("performanceScreenStatus"),weeklyPeriodId=state.weekScope?.id||"";
    if(leader)window.ExploraStableDerivationCard?.render({name:leader.name,avatar:leader.avatar,derivedAmount:leader.derivedAmount,bonusAmount:leader.projectedBonus,position:leader.position},{source:CARD_SOURCE,authoritative:true,settled:true,uid:state.userUid,weeklyPeriodId});
    else if(settled)window.ExploraStableDerivationCard?.render(null,{source:CARD_SOURCE,authoritative:true,settled:true,uid:state.userUid,weeklyPeriodId});
    else if(error)window.ExploraStableDerivationCard?.render(null,{source:CARD_SOURCE,error:true,uid:state.userUid,weeklyPeriodId});
    else window.ExploraStableDerivationCard?.render(null,{source:CARD_SOURCE,loading:true,uid:state.userUid,weeklyPeriodId});
    if(list){list.dataset.derivationAuthority="v2439";list.innerHTML=state.rows.length?state.rows.map(rowMarkup).join(""):settled?'<div class="performance-history-empty">No hay derivaciones completadas y facturadas en la semana activa.</div>':'<div class="performance-history-empty">No se pudo confirmar el ranking de la semana activa.</div>'}
    if(status){status.textContent=error&&!settled?`Semana ${state.weekScope.weeklyPeriodId||state.weekScope.id} · Sin conexión confirmada`:`Semana ${state.weekScope.weeklyPeriodId||state.weekScope.id} · Actualizado ${new Date().toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit"})}`;status.classList.toggle("is-error",Boolean(error&&!settled))}
  }
  function validateState(rows,detailRows){const issues=[];if(state.counts.valid>0&&!rows.length)issues.push("DERIVATION_RANKING_EMPTY_WITH_VALID_DATA");rows.forEach((r,i)=>{if(r.position!==i+1)issues.push("POSITION_MISMATCH");if(Math.round(r.derivedAmount*.10)!==r.projectedBonus)issues.push("BONUS_MISMATCH")});if(rows.length>1&&rows.some((r,i)=>i>0&&r.derivedAmount>rows[i-1].derivedAmount))issues.push("ORDER_MISMATCH");if(detailRows?.length&&state.userUid&&rows[0]?.uid===state.userUid&&rows.some(r=>r.derivedAmount>rows[0].derivedAmount))issues.push("AUTH_USER_FALSE_LEADER");return[...new Set(issues)]}
  function diagnostic(stage,code,error,extra={}){
    const context={...state.lastContext,...extra},message=text(error?.message||error||"—"),firebaseCode=text(error?.code||"—"),denied=/permission-denied|insufficient permissions/i.test(firebaseCode+" "+message),internal=denied?"DERIVATION_RANKING_PERMISSION_DENIED":code;
    state.lastError={stage,code:internal,error,extra};
    const result=state.lastResult||{source:"EMPTY_VALID_RESULT",grossAmount:0,count:0,bonus:0};
    state.lastDiagnostic=["EXPLORA - ERROR DERIVATION_RANKING_DEFINITIVE_REPAIR","MÓDULO: DERIVATION_RANKING_DEFINITIVE_REPAIR",`ETAPA: ${stage}`,`TIPO_EVENTO: ${context.eventType||"ERROR"}`,`CÓDIGO INTERNO: ${internal}`,`MENSAJE REAL FIREBASE: ${firebaseCode}`,`MENSAJE REAL JAVASCRIPT: ${message}`,`FUNCIÓN: ${context.functionName||"refresh"}`,`UID AUTH: ${state.userUid||auth?.currentUser?.uid||"—"}`,`ROL: ${state.role||"—"}`,`DRIVER UID: ${context.driverUid||state.userUid||"—"}`,`WEEKLY PERIOD ID: ${state.weekScope?.weeklyPeriodId||state.weekScope?.endPeriodId||"—"}`,`RUTA FIRESTORE: ${context.path||"derivation_ranking_public + derivaciones + billing_records"}`,`CONSULTA: ${context.query||"resumen público + fallback por UID"}`,`ESTADO NORMALIZADO: ${context.normalizedStatus||"—"}`,`DERIVATION ID: ${context.derivationId||"—"}`,`SENDER UID: ${context.senderUid||"—"}`,`RECEIVER UID: ${context.receiverUid||"—"}`,`BILLING ID: ${context.billingId||"—"}`,`IMPORTE RESUELTO: ${context.amount!=null?money(context.amount):"—"}`,`CANTIDAD DE DOCUMENTOS LEÍDOS: ${state.counts.documentsRead}`,`CANTIDAD DE DOCUMENTOS VÁLIDOS: ${state.counts.valid}`,`CANTIDAD DE DUPLICADOS DESCARTADOS: ${state.counts.duplicates}`,`FUENTE DEL RESULTADO: ${result.source}`,`TOTAL BRUTO AGREGADO: ${money(result.grossAmount)}`,`CANTIDAD DE DERIVACIONES AGREGADAS: ${result.count}`,`BONO CALCULADO: ${money(result.bonus)}`,`TIMESTAMP: ${new Date().toISOString()}`,`STACK: ${text(error?.stack||"—")}`].join("\n");
    let panel=$("v272DerivationRankingDiagnostic");if(!panel){panel=document.createElement("section");panel.id="v272DerivationRankingDiagnostic";panel.style.cssText="position:fixed;z-index:9999;left:12px;right:12px;bottom:calc(90px + env(safe-area-inset-bottom));max-width:520px;margin:auto;padding:14px;border:1px solid #ff7f87;border-radius:18px;background:#251014;color:#fff;font:12px/1.4 ui-monospace,monospace;max-height:62vh;overflow:auto;box-shadow:0 24px 70px rgba(0,0,0,.55)";document.body.appendChild(panel)}
    panel.innerHTML=`<pre style="white-space:pre-wrap;margin:0 0 10px">${esc(state.lastDiagnostic)}</pre><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><button data-v272-copy type="button" style="min-height:44px;border:1px solid #f5b942;border-radius:12px;background:#2b2110;color:#f5cf75;font-weight:900">COPIAR ERROR</button><button data-v272-retry type="button" style="min-height:44px;border:1px solid #fff3;border-radius:12px;background:#ffffff0d;color:#fff;font-weight:900">REINTENTAR</button></div>`;panel.querySelector("[data-v272-copy]").onclick=()=>navigator.clipboard?.writeText(state.lastDiagnostic);panel.querySelector("[data-v272-retry]").onclick=()=>refresh("diagnostic-retry",{force:true});
  }
  async function refresh(reason="manual",{force=false}={}){
    if(!auth?.currentUser?.uid||!state.weekScope?.id)return;
    if(state.refreshing){state.pending=true;return}
    state.refreshing=true;const generation=state.generation,userUid=auth.currentUser.uid,requestPeriodId=state.weekScope.id;state.userUid=userUid;state.role=sessionRole();if(force||!state.loaded)renderLoading();
    try{
      await readProfiles();if(generation!==state.generation||userUid!==auth.currentUser?.uid||requestPeriodId!==state.weekScope?.id)return;
      const [pub,events,detail]=await Promise.all([readPublicRows(state.weekScope),readEvents(state.weekScope),readDetailed(state.weekScope)]);if(generation!==state.generation||userUid!==auth.currentUser?.uid||requestPeriodId!==state.weekScope?.id||activeWeekScope().id!==requestPeriodId)return;
      state.publicRows=pub.rows;
      const rows=mergeRows(pub.rows,events.rows,detail.rows),grossAmount=Math.round((rows.reduce((sum,r)=>sum+Number(r.derivedAmount||0),0)+Number.EPSILON)*100)/100,count=rows.reduce((sum,r)=>sum+Number(r.count||0),0),settledCurrent=Boolean(pub.settledCurrent||detail.settledCurrent);
      const source=pub.rows.length?"PUBLIC_SUMMARY":(events.rows.length&&detail.rows.length?"MERGED_FALLBACK":events.rows.length?"FALLBACK_DERIVATIONS":detail.rows.length?"FALLBACK_BILLING":"EMPTY_VALID_RESULT");
      state.lastResult={source,grossAmount,count,bonus:Math.round((grossAmount*RATE+Number.EPSILON)*100)/100};state.loaded=Boolean(rows.length||settledCurrent);
      const issues=validateState(rows,detail.rows);render(rows,{force:true,settled:settledCurrent,error:!settledCurrent});
      backfillQualified(detail.rows).then(c=>{if(c&&requestPeriodId===state.weekScope?.id)setTimeout(()=>refresh("post-backfill"),350)}).catch(()=>{});
      if(issues.length)diagnostic("VALIDATE_AGGREGATION",issues[0],new Error(issues.join(" | ")),{functionName:"validateState",query:reason});
      else if(!rows.length&&!settledCurrent&&navigator.onLine!==false){const err=pub.errors[0]?.error||detail.errors[0]?.error||events.errors[0]?.error||new Error("No se pudieron confirmar las fuentes del ranking semanal.");diagnostic("READ_RANKING","DERIVATION_RANKING_READ_FAILED",err,{functionName:"refresh",query:reason});}
      else $("v272DerivationRankingDiagnostic")?.remove();
    }catch(error){
      if(generation===state.generation&&requestPeriodId===state.weekScope?.id)render(state.rows,{force:true,settled:false,error:true});
      const transient=navigator.onLine===false||/unavailable|network|offline|deadline-exceeded/i.test(text(error?.code)+" "+text(error?.message));
      if(!transient)diagnostic("REFRESH_RANKING",error?.internalCode||"DERIVATION_RANKING_AGGREGATION_FAILED",error,{functionName:"refresh",query:reason});
    }finally{state.refreshing=false;if(state.pending){state.pending=false;queueMicrotask(()=>refresh("queued"))}}
  }
  function stop(){state.generation++;clearTimeout(debounceRefresh.t);state.unsubs.splice(0).forEach(fn=>{try{fn()}catch(_){}});state.userUid="";state.role="";state.rows=[];state.sourceRows=[];state.publicRows=[];state.loaded=false;state.loading=false;state.observer?.disconnect?.();state.observer=null;window.ExploraStableDerivationCard?.clear();}
  function debounceRefresh(reason){clearTimeout(debounceRefresh.t);debounceRefresh.t=setTimeout(()=>refresh(reason),120)}
  function subscribe(){
    state.unsubs.splice(0).forEach(fn=>{try{fn()}catch(_){}});
    const generation=state.generation,weeklyPeriodId=state.weekScope?.id||"",userUid=state.userUid;
    if(!weeklyPeriodId||!userUid)return;
    try{
      const unsubscribe=onSnapshot(collection(db,"derivation_ranking_public",weeklyPeriodId,"drivers"),()=>{
        if(generation!==state.generation||userUid!==state.userUid||userUid!==auth?.currentUser?.uid)return;
        if(activeWeekScope().id!==weeklyPeriodId){start();return}
        debounceRefresh("snapshot:derivation_ranking_public");
      },error=>{
        if(generation!==state.generation||userUid!==state.userUid)return;
        if(!/permission-denied/.test(text(error?.code)))diagnostic("PUBLIC_LISTENER","DERIVATION_RANKING_SNAPSHOT_MISMATCH",error,{path:`derivation_ranking_public/${weeklyPeriodId}/drivers`});
      });
      state.unsubs.push(unsubscribe);
    }catch(error){diagnostic("PUBLIC_LISTENER","DERIVATION_RANKING_SNAPSHOT_MISMATCH",error,{path:`derivation_ranking_public/${weeklyPeriodId}/drivers`})}
  }
  function installObserver(){state.observer?.disconnect?.();state.observer=null;}
  function runSelfTests(){
    if(state.selfTestPromise)return state.selfTestPromise;
    state.selfTestPromise=Promise.resolve().then(()=>{
      const weekScope=state.weekScope?.id?state.weekScope:{id:"2026-06-20",weeklyPeriodId:"2026-06-20",startPeriodId:"2026-06-20",endPeriodId:"2026-06-20",periods:[{id:"2026-06-20"}],legacyIds:[]};
      const base={accepted:true,completed:true,billed:true,status:"facturada",weeklyPeriodId:weekScope.weeklyPeriodId||weekScope.id,completedAt:new Date("2026-06-01T12:00:00Z")};
      const build=(derivations,billings=[])=>normalizeSources(derivations,billings,weekScope,{commitCounts:false});
      const checks=[];const check=(name,condition)=>checks.push({name,ok:Boolean(condition)});
      let r=sortRows([publicRow({uid:"A",count:2,derivedAmount:100000,weeklyPeriodId:weekScope.id},"A")].filter(Boolean));check("PUBLIC_SUMMARY_TOTAL_COUNT_BONUS",r[0]?.count===2&&r[0]?.derivedAmount===100000&&r[0]?.projectedBonus===10000);
      r=build([{...base,id:"d1",derivationId:"D1",senderUid:"A",receiverUid:"B"},{...base,id:"d2",derivationId:"D2",senderUid:"A",receiverUid:"C"}],[{...base,id:"b1",derivationId:"D1",grossAmount:40000,driverUid:"B"},{...base,id:"b2",derivationId:"D2",grossAmount:60000,driverUid:"C"}]);check("FALLBACK_TWO_LINKED_BILLINGS",r[0]?.count===2&&r[0]?.derivedAmount===100000);
      r=build([{...base,id:"source-a",derivationId:"D3",senderUid:"A",receiverUid:"B",grossAmount:50000},{...base,id:"source-b",derivationId:"D3",senderUid:"A",receiverUid:"B",grossAmount:50000}],[{...base,id:"billing-d3",derivationId:"D3",grossAmount:50000,driverUid:"B"}]);check("CROSS_SOURCE_DEDUPLICATION",r[0]?.count===1&&r[0]?.derivedAmount===50000);
      check("ARGENTINE_THOUSANDS",parseMoney("100.000")===100000);check("ARGENTINE_DECIMALS",parseMoney("100.000,50")===100000.5);
      check("ACCEPTED_NOT_BILLED_EXCLUDED",build([{...base,id:"d6",status:"aceptada",completed:false,billed:false,senderUid:"A",receiverUid:"B",grossAmount:10000}]).length===0);
      r=build([{...base,id:"doc-1",derivationId:"D7A",senderUid:"A",receiverUid:"B",grossAmount:30000},{...base,id:"doc-2",derivationId:"D7B",senderUid:"A",receiverUid:"C",grossAmount:70000}]);check("VALID_TWO_DOCUMENT_AGGREGATION",r[0]?.count===2&&r[0]?.derivedAmount===100000&&r[0]?.projectedBonus===10000);
      r=build([]);check("EMPTY_IS_VALID",r.length===0);
      r=build([{...base,id:"d9",derivationId:"D9",senderUid:"SENDER",receiverUid:"RECEIVER",grossAmount:50000}]);check("ATTRIBUTED_TO_SENDER",r[0]?.uid==="SENDER"&&!r.some(x=>x.uid==="RECEIVER")&&r[0]?.projectedBonus===5000);
      r=build([{...base,id:"d10",derivationId:"D10",senderUid:"A",receiverUid:"B",grossAmount:100000,netAmount:90000,retentionAmount:10000}]);check("GROSS_NOT_NET",r[0]?.derivedAmount===100000&&r[0]?.projectedBonus===10000);
      const concurrentSelfTest=runSelfTests();check("SHARED_EXECUTION_LOCK",concurrentSelfTest===state.selfTestPromise);
      r=build([{...base,id:"legacy",derivacionId:"DL",fromUid:"LEGACY_SENDER",acceptedByUid:"LEGACY_RECEIVER",importe:"100.000,50",estado:"facturada"}]);check("LEGACY_FIELDS_NORMALIZED",r[0]?.uid==="LEGACY_SENDER"&&r[0]?.derivedAmount===100000.5&&r[0]?.count===1);
      const failed=checks.filter(x=>!x.ok);state.selfTests={ok:failed.length===0,passed:checks.length-failed.length,total:checks.length,failed:failed.map(x=>x.name),version:VERSION};return state.selfTests;
    }).catch(error=>{state.selfTests={ok:false,passed:0,total:12,failed:[text(error?.message||error)],version:VERSION};return state.selfTests;}).finally(()=>{setTimeout(()=>{state.selfTestPromise=null},0)});
    return state.selfTestPromise;
  }
  async function start(){
    if(state.startPromise)return state.startPromise;
    state.startPromise=(async()=>{
      if(!auth?.currentUser?.uid||!db)return;
      const role=sessionRole(),weekScope=activeWeekScope();if(!role||!weekScope?.id)return;
      stop();state.generation++;state.userUid=auth.currentUser.uid;state.role=role;state.weekScope=weekScope;window.ExploraStableDerivationCard?.beginSession(state.userUid,state.weekScope.id);
      const tests=await runSelfTests();if(!tests.ok)diagnostic("SELF_TEST","DERIVATION_RANKING_AGGREGATION_FAILED",new Error(tests.failed.join(" | ")||"SELF_TEST_FAILED"),{functionName:"runSelfTests"});
      await refresh("start",{force:true});if(state.userUid===auth?.currentUser?.uid)subscribe();
    })().finally(()=>{state.startPromise=null});
    return state.startPromise;
  }
  async function upsertFromDerivation(row){if(!row)return false;const rows=normalizeSources([{id:row.derivationId||row.id,...row}],[],state.weekScope||activeWeekScope()),q=rows.flatMap(r=>r.items||[])[0];const ok=await upsertFromQualified(q,{silent:false});if(ok)setTimeout(()=>refresh("upsert-from-derivation"),80);return ok}
  const events=["explora:cobro-registrado","explora:derivacion-aceptada","explora:derivacion-completada","explora:derivacion-facturada","explora:profile-updated","explora:avatar-updated","explora:performance-updated","explora:operational-snapshot-updated","explora:session-ready","explora:session-opened"];
  events.forEach(name=>window.addEventListener(name,event=>{if(name==="explora:derivacion-completada"&&event.detail)upsertFromDerivation(event.detail).catch(()=>{});debounceRefresh(name)}));
  const handlePeriodChange=()=>{const next=activeWeekScope();if(auth?.currentUser?.uid&&next.id&&next.id!==state.weekScope?.id)start();};
  ["explora:weekly-period-changed","explora:operational-period-changed","explora:app-date-refresh"].forEach(name=>window.addEventListener(name,handlePeriodChange));
  window.addEventListener("explora:auth-cleared",stop);document.addEventListener("visibilitychange",()=>{if(!document.hidden){handlePeriodChange();debounceRefresh("visibility")}});
  function bindAuth(){const live=window.ExploraFirebase||{};db=live.db||db;auth=live.auth||auth;if(!db||!auth){setTimeout(bindAuth,100);return}onAuthStateChanged(auth,user=>{if(user?.uid)setTimeout(start,30);else stop()});}
  bindAuth();setInterval(()=>{if(!auth?.currentUser?.uid)return;const next=activeWeekScope();if(next.id!==state.weekScope?.id)start();},60000);
  window.ExploraDerivationRankingDefinitiveRepair={version:VERSION,refresh,start,stop,runSelfTests,upsertFromDerivation,parseMoney,normalizeSources,getState:()=>({rows:state.rows.map(r=>({...r,aliases:[...(r.aliases||[])]})),weekScope:state.weekScope,counts:{...state.counts},selfTests:state.selfTests,lastError:state.lastError})};
})();
