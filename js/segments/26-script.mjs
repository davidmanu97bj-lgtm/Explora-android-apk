
(()=>{
  "use strict";
  if(window.__exploraGlobalRankingIndependentAuthV275)return;
  window.__exploraGlobalRankingIndependentAuthV275=true;
  const VERSION="v275-current-cycle-partial-snapshot-safe";
  const normalize=value=>String(value||"").trim().toLowerCase();
  let generation=0,renderRevision=0,sourceRevision=0,periodReady=false;
  let activePeriodId="",profiles=[],weeklyRows=[];
  const profileUid=row=>String(row?.uid||row?.authUid||row?.firebaseUid||row?.userId||row?.driverUid||row?.choferUid||row?.id||"").trim();
  const profileName=row=>String(row?.nombreCompleto||row?.displayName||row?.nombre||row?.name||row?.driverName||"Chofer").trim()||"Chofer";
  const profileAvatar=row=>String(row?.photoURL||row?.avatarUrl||row?.avatar||row?.driverAvatar||"").trim();
  const isEligible=row=>{const uid=profileUid(row),role=normalize(row?.role||row?.rol||row?.tipo||row?.profileType),status=normalize(row?.status||row?.estado);if(!uid)return false;if(row?.isAdmin===true||row?.admin===true||row?.owner===true||row?.superadmin===true)return false;if(row?.deleted===true||row?.isDeleted===true||row?.disabled===true||row?.isDisabled===true||row?.active===false||row?.activo===false||row?.enabled===false)return false;if(/admin|administrador|owner|superadmin|system|sistema/.test(role))return false;if(/deleted|eliminado|disabled|deshabilitado|inactive|inactivo|blocked|bloqueado/.test(status))return false;return !role||role.includes("chofer")||role.includes("driver")||row?.isSimulated===true;};
  const aliases=row=>new Set([profileUid(row),row?.id,row?.email,row?.username,row?.usuario].map(normalize).filter(Boolean));
  const rowUid=row=>String(row?.driverUid||row?.choferUid||row?.uid||row?.userId||row?.ownerUid||row?.id||"").trim();
  const rowBilling=row=>Math.max(0,Number(row?.grossBilling??row?.totalFacturado??row?.facturacionBruta??row?.facturacion??row?.totalBilling??0)||0);
  const rowCount=row=>Math.max(0,Number(row?.serviceCount??row?.cantidadCobros??row?.billingCount??row?.cantidadServicios??0)||0);
  const currentRows=()=>Array.isArray(window.ExploraPerformanceEngine?.getState?.()?.rows)?window.ExploraPerformanceEngine.getState().rows:[];
  function reset(){generation+=1;renderRevision+=1;sourceRevision=0;periodReady=false;activePeriodId="";profiles=[];weeklyRows=[];}
  function mergeIncomingRows(...groups){const map=new Map();for(const group of groups){for(const row of Array.isArray(group)?group:[]){const uid=rowUid(row);if(!uid)continue;const prior=map.get(uid);if(!prior||rowBilling(row)>=rowBilling(prior))map.set(uid,row);}}return [...map.values()];}
  function rebuild(){
    if(!periodReady||weeklyRows.length===0)return;
    const localGeneration=generation;
    const revision=Math.max(++renderRevision,sourceRevision);
    const existing=currentRows();
    const profileSource=profiles.filter(isEligible).length?profiles.filter(isEligible):existing.filter(isEligible);
    const aliasMap=new Map();
    profileSource.forEach(profile=>aliases(profile).forEach(key=>aliasMap.set(key,profile)));
    const byUid=new Map();
    // Se conserva el último podio confirmado. Un snapshot parcial sólo reemplaza
    // los choferes que realmente llegaron desde Firestore.
    existing.filter(isEligible).forEach(row=>{const uid=profileUid(row);if(!uid)return;byUid.set(uid,{...row,uid,driverUid:uid,role:"chofer",eligibilityConfirmed:true,driverName:profileName(row),name:profileName(row),avatar:profileAvatar(row),grossBilling:rowBilling(row),totalFacturado:rowBilling(row),serviceCount:rowCount(row)});});
    profileSource.forEach(profile=>{const uid=profileUid(profile);if(!uid)return;const previous=byUid.get(uid)||{};byUid.set(uid,{...previous,uid,driverUid:uid,role:"chofer",eligibilityConfirmed:true,driverName:profileName(profile),name:profileName(profile),avatar:profileAvatar(profile)||profileAvatar(previous),grossBilling:rowBilling(previous),totalFacturado:rowBilling(previous),serviceCount:rowCount(previous),updatedAt:profile.updatedAt||profile.createdAt||previous.updatedAt||null});});
    weeklyRows.forEach(raw=>{const rawUid=rowUid(raw),profile=aliasMap.get(normalize(rawUid)),uid=profileUid(profile)||rawUid;if(!uid)return;const previous=byUid.get(uid)||{uid,driverUid:uid,role:"chofer",eligibilityConfirmed:true,driverName:profileName(profile)||String(raw.driverName||raw.choferName||raw.nombre||"Chofer"),name:profileName(profile)||String(raw.driverName||raw.choferName||raw.nombre||"Chofer"),avatar:profileAvatar(profile)||String(raw.avatar||raw.photoURL||""),grossBilling:0,totalFacturado:0,serviceCount:0};const amount=rowBilling(raw);previous.grossBilling=amount;previous.totalFacturado=amount;previous.serviceCount=rowCount(raw);previous.updatedAt=raw.updatedAt||raw.calculatedAt||raw.createdAt||previous.updatedAt;byUid.set(uid,previous);});
    const rows=[...byUid.values()].filter(isEligible);
    if(rows.length===0)return;
    queueMicrotask(()=>{if(localGeneration!==generation||revision<sourceRevision)return;window.ExploraPerformanceEngine?.applyRealtimeOperationalRows?.({rows,uid:window.ExploraFirebase?.auth?.currentUser?.uid||"",driverUid:window.ExploraFirebase?.auth?.currentUser?.uid||"",weeklyPeriodId:activePeriodId,snapshotRevision:revision,requestId:revision,activeDriverCount:Math.max(profileSource.length,rows.length),reason:VERSION,operationalUpdatedAt:Date.now(),isConfirmed:true,realtimeCommitted:true,partialSnapshot:weeklyRows.length<rows.length});});
  }
  window.addEventListener("explora:firestore-global-state",event=>{
    const detail=event.detail||{},entities=detail.entities||{},periodId=String(detail.weeklyPeriodId||detail.periodId||window.ExploraPeriods?.getActivePeriods?.().weeklyPeriodId||window.ExploraWeeklyEngine?.getActiveWeeklyPeriod?.().id||"").trim();
    if(!periodId)return;
    if(activePeriodId&&activePeriodId!==periodId)reset();
    activePeriodId=periodId;periodReady=true;sourceRevision=Math.max(sourceRevision+1,Number(detail.revision||0));
    const incomingProfiles=Array.isArray(entities["profiles:public"])?entities["profiles:public"]:[];
    if(incomingProfiles.some(isEligible))profiles=incomingProfiles;
    const ranking=Array.isArray(entities["weekly:ranking"])?entities["weekly:ranking"].filter(row=>String(row.weeklyPeriodId||row.periodoSemanalId||row.periodoId||periodId)===periodId):[];
    const own=Array.isArray(entities["weekly:own"])?entities["weekly:own"].filter(row=>String(row.weeklyPeriodId||row.periodoSemanalId||row.periodoId||periodId)===periodId):[];
    const incoming=mergeIncomingRows(ranking,own);
    // Nunca se reemplaza un ranking válido por una respuesta vacía. Si la consulta
    // global no tiene permisos, weekly:own actualiza sólo al usuario conectado.
    if(incoming.length)weeklyRows=mergeIncomingRows(weeklyRows,incoming);
    rebuild();
  });
  window.addEventListener("explora:firestore-listener-error",event=>{const name=String(event.detail?.name||"");if(name==="weekly:ranking")rebuild();});
  window.addEventListener("explora:auth-cleared",reset);
  window.addEventListener("explora:operational-period-changed",reset);
  window.ExploraCurrentCycleRealtimeGuard={version:VERSION,getState:()=>({activePeriodId,profiles:profiles.length,weeklyRows:weeklyRows.length,sourceRevision,renderRevision})};
})();
