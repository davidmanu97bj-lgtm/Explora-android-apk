import { doc,getDoc,getDocFromServer,getDocs,setDoc,collection,query,where,orderBy,limit,serverTimestamp,runTransaction } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { ref as storageRef,uploadBytes,getDownloadURL,deleteObject } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-storage.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { FINAL_STATES,FINAL_ALERT_STATES,buildStartMutation,buildFinalizeMutation,buildAlertId,buildOperationFingerprint,buildOperationId,buildIncidentKey,buildOutboxEntry,classifyOperationCommit,nextOutboxDeliveryState,pendingReviewRequired } from "./49-mileage-model.mjs";

const VERSION="15.0.10";
const COLLECTION="weekly_mileage";
const ALLOWANCE_KM=20;
const START_GRACE_MS=2*60*60*1000;
const MILEAGE_REMINDER_MS=5*60*1000;
let fb=window.ExploraFirebase||{};
let auth=fb.auth||null;
let db=fb.db||null;
let storage=fb.storage||null;
let authUnsubscribe=null;
let bootstrapPromise=null;
let context=null,currentRecord=null,modalResolve=null,bypassSubmit=false,lastPeriod="",modalOptions={},operationBusy=false;
let modalPromise=null,modalMode="";
let activeAuthUid="",sessionGeneration=0;
let mileageReminderTimer=null,mileageReminderWaitingForUi=false,mileageReminderObserver=null;


function mileageStartComplete(record=currentRecord){
  return Boolean(num(record?.startKm)>0&&clean(record?.startPhotoUrl||record?.startPhotoPath));
}
function stopMileageReminder(){
  if(mileageReminderTimer){clearTimeout(mileageReminderTimer);mileageReminderTimer=null;}
  mileageReminderWaitingForUi=false;
  mileageReminderObserver?.disconnect?.();
  mileageReminderObserver=null;
}
function isBlockingModalOpen(){
  if(operationBusy)return true;
  if(document.hidden)return true;
  if(document.body.classList.contains("new-service-open")||document.body.classList.contains("billing-form-open"))return true;
  if($("newServiceScreen")?.classList.contains("is-open"))return true;
  if($("billingFormBackdrop")?.classList.contains("is-open"))return true;
  if(document.querySelector('.is-open[aria-hidden="false"], [id$="Backdrop"].is-open, dialog[open]'))return true;
  return false;
}
function waitUntilUiFree(){
  if(mileageReminderWaitingForUi)return;
  mileageReminderWaitingForUi=true;
  mileageReminderObserver?.disconnect?.();
  mileageReminderObserver=new MutationObserver(()=>{
    if(isBlockingModalOpen())return;
    mileageReminderObserver?.disconnect?.();
    mileageReminderObserver=null;
    mileageReminderWaitingForUi=false;
    queueMicrotask(()=>tryShowMileageReminder().catch(()=>scheduleMileageReminder()));
  });
  mileageReminderObserver.observe(document.body,{subtree:true,attributes:true,attributeFilter:["class","hidden","aria-hidden"]});
}
function scheduleMileageReminder(delay=MILEAGE_REMINDER_MS){
  if(!isDriver()||mileageStartComplete()){stopMileageReminder();return;}
  if(mileageReminderTimer)clearTimeout(mileageReminderTimer);
  mileageReminderTimer=setTimeout(()=>{mileageReminderTimer=null;tryShowMileageReminder().catch(error=>{console.warn("MILEAGE_REMINDER_FAILED",error);scheduleMileageReminder();})},Math.max(MILEAGE_REMINDER_MS,Number(delay)||MILEAGE_REMINDER_MS));
}
async function tryShowMileageReminder(){
  if(!isDriver()){stopMileageReminder();return false;}
  await refreshContext();
  if(mileageStartComplete()){rememberConfirmedStart(currentRecord);clearStartGrace();stopMileageReminder();return false;}
  if(context?.technicalError){scheduleMileageReminder();return false;}
  ensureStartGraceStarted();
  if(isBlockingModalOpen()){waitUntilUiFree();return false;}
  await openModal("start",{mandatory:false,forClosure:false,reason:"five-minute-reminder"});
  return true;
}
async function startMileageReminder({showWhenReady=true}={}){
  stopMileageReminder();
  if(!isDriver())return;
  try{
    await refreshContext();
    if(mileageStartComplete()){rememberConfirmedStart(currentRecord);clearStartGrace();return;}
    ensureStartGraceStarted();
    if(showWhenReady){
      if(isBlockingModalOpen())waitUntilUiFree();
      else await openModal("start",{mandatory:false,forClosure:false,reason:"session-reminder"});
    }else scheduleMileageReminder();
  }catch(error){
    console.warn("MILEAGE_REMINDER_START_FAILED",error);
    scheduleMileageReminder();
  }
}

function refreshFirebaseRefs(){
  const live=window.ExploraFirebase||{};
  fb=live;
  auth=live.auth||auth||null;
  db=live.db||db||null;
  storage=live.storage||storage||null;
  return {auth,db,storage};
}
async function ensureFirebase({requireStorage=false,timeoutMs=20000}={}){
  const started=Date.now();
  while(Date.now()-started<timeoutMs){
    refreshFirebaseRefs();
    if(auth&&db&&(!requireStorage||storage))return {auth,db,storage};
    await new Promise(resolve=>setTimeout(resolve,80));
  }
  throw Object.assign(new Error(requireStorage?"Firebase o Storage todavía no están disponibles. Reintentá en unos segundos.":"Firebase todavía no está disponible. Reintentá en unos segundos."),{code:requireStorage?"MILEAGE_STORAGE_NOT_READY":"MILEAGE_FIREBASE_NOT_READY"});
}
function bindAuthObserver(){
  refreshFirebaseRefs();
  if(!auth||authUnsubscribe)return false;
  authUnsubscribe=onAuthStateChanged(auth,user=>{
    const previousUid=activeAuthUid;
    activeAuthUid=clean(user?.uid);
    sessionGeneration+=1;
    clearSessionState({preserveAuthIdentity:true});
    if(previousUid&&previousUid!==activeAuthUid)console.info("MILEAGE_SESSION_OWNER_CHANGED",{from:previousUid,to:activeAuthUid||"signed-out"});
    if(user)setTimeout(()=>{const token=captureSessionToken();if(!sessionTokenIsCurrent(token))return;if(isDriver())ensureStartPrompt().catch(()=>{});else if(isAdmin())renderAdminAlerts().catch(()=>{})},900);
  });
  return true;
}
async function bootstrapFirebase(){
  if(bootstrapPromise)return bootstrapPromise;
  bootstrapPromise=(async()=>{
    try{
      await ensureFirebase();bindAuthObserver();
      activeAuthUid=clean(auth?.currentUser?.uid||activeAuthUid);
      const token=captureSessionToken();
      if(isDriver()&&sessionTokenIsCurrent(token)){
        migrateLegacyLocalTasks(token);
        await syncLocalPendings(token).catch(error=>console.warn("MILEAGE_PENDING_SYNC_FAILED",error?.message));
        await reconcilePendingOperations(token).catch(error=>console.warn("MILEAGE_RECONCILIATION_SYNC_FAILED",error?.message));
        await cleanupPendingEvidences(token).catch(error=>console.warn("MILEAGE_EVIDENCE_SYNC_FAILED",error?.message));
      }
      return true
    }finally{bootstrapPromise=null}
  })();
  return bootstrapPromise;
}
const $=id=>document.getElementById(id);
const clean=v=>String(v??"").trim();
const num=value=>{
  if(typeof value==="number")return Number.isFinite(value)?value:0;
  let text=String(value??"").trim().replace(/[^0-9.,-]/g,"");
  if(!text)return 0;
  const hasComma=text.includes(","),hasDot=text.includes(".");
  if(hasComma&&hasDot)text=text.replace(/\./g,"").replace(",",".");
  else if(hasComma)text=text.replace(/\./g,"").replace(",",".");
  else if(hasDot&&/^[-]?\d{1,3}(\.\d{3})+$/.test(text))text=text.replace(/\./g,"");
  const parsed=Number(text);
  return Number.isFinite(parsed)?parsed:0;
};
const money=v=>new Intl.NumberFormat("es-AR",{style:"currency",currency:"ARS",maximumFractionDigits:0}).format(Number(v||0));
const role=()=>clean(window.ExploraSession?.role||window.ExploraSession?.profile?.rol||window.ExploraSession?.profile?.role).toLowerCase();
const isDriver=()=>["chofer","driver"].includes(role());
const isAdmin=()=>["admin","administrador"].includes(role());
const period=()=>window.ExploraCanonicalWeeklyClosure?.getWeeklyPeriod?.()||window.ExploraWeeklyEngine?.getActiveWeeklyPeriod?.()||null;
const recordId=(uid,periodId)=>`${uid}_${periodId}`.replace(/[^a-zA-Z0-9_-]/g,"_");
const timestampMs=value=>value?.toMillis?.()||Date.parse(value||"")||0;
const formatDateTime=value=>{const ms=timestampMs(value);return ms?new Date(ms).toLocaleString("es-AR",{dateStyle:"short",timeStyle:"short"}):""};
const OP_PREFIX="exploraMileageOperation:";
const EVIDENCE_PREFIX="exploraMileageEvidence:";
const PENDING_PREFIX="exploraMileagePending:";
const safeKeyPart=value=>clean(value).replace(/[^a-zA-Z0-9_-]/g,"_")||"unknown";
function captureSessionToken(){return Object.freeze({uid:clean(auth?.currentUser?.uid||activeAuthUid),generation:sessionGeneration})}
function sessionTokenIsCurrent(token){return Boolean(token&&clean(token.uid)&&clean(token.uid)===clean(auth?.currentUser?.uid||activeAuthUid)&&Number(token.generation)===sessionGeneration)}
function assertSessionToken(token,ownerUid=""){
  if(!sessionTokenIsCurrent(token))throw mileageError("MILEAGE_SESSION_CHANGED","La sesión cambió durante la operación. La tarea anterior fue detenida.");
  if(ownerUid&&clean(ownerUid)!==clean(token.uid))throw mileageError("MILEAGE_LOCAL_OWNER_MISMATCH","La tarea local pertenece a otro usuario.");
  return token.uid;
}
function isOwnedByCurrentDriver(item,token=captureSessionToken()){return Boolean(isDriver()&&sessionTokenIsCurrent(token)&&clean(item?.driverUid)===clean(token.uid))}
function scopedOperationPrefix(uid){return `${OP_PREFIX}${safeKeyPart(uid)}:`}
function scopedEvidencePrefix(uid){return `${EVIDENCE_PREFIX}${safeKeyPart(uid)}:`}
function scopedPendingPrefix(uid){return `${PENDING_PREFIX}${safeKeyPart(uid)}:`}
async function sha256Blob(blob){
  const data=await blob.arrayBuffer();
  if(!globalThis.crypto?.subtle)throw mileageError("MILEAGE_CRYPTO_UNAVAILABLE","El navegador no dispone de criptografía segura para registrar el kilometraje.");
  const digest=await crypto.subtle.digest("SHA-256",data);
  return [...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,"0")).join("");
}
function operationStorageKey(kind,mileageRecordId=context?.id,uid=context?.user?.uid||activeAuthUid){return `${scopedOperationPrefix(uid)}${safeKeyPart(mileageRecordId)}:${safeKeyPart(kind)}`}
function evidenceStorageKey(path,uid=context?.user?.uid||activeAuthUid){return `${scopedEvidencePrefix(uid)}${path}`}
function pendingStorageKey(alertId,uid=context?.user?.uid||activeAuthUid){return `${scopedPendingPrefix(uid)}${safeKeyPart(alertId)}`}
function persistOperation(operation){try{if(!clean(operation?.driverUid))throw new Error("missing-driverUid");localStorage.setItem(operationStorageKey(operation.kind,operation.mileageRecordId,operation.driverUid),JSON.stringify(operation))}catch(error){console.warn("MILEAGE_OPERATION_LOCAL_SAVE_FAILED",error?.message)}}
function clearOperation(kind,mileageRecordId=context?.id,uid=context?.user?.uid||activeAuthUid){try{localStorage.removeItem(operationStorageKey(kind,mileageRecordId,uid))}catch(error){console.warn("MILEAGE_OPERATION_LOCAL_CLEAR_FAILED",error?.message)}}
function persistEvidence(evidence){try{if(!clean(evidence?.driverUid))throw new Error("missing-driverUid");localStorage.setItem(evidenceStorageKey(evidence.path,evidence.driverUid),JSON.stringify(evidence))}catch(error){console.warn("MILEAGE_EVIDENCE_LOCAL_SAVE_FAILED",error?.message)}}
function clearEvidence(path,uid=context?.user?.uid||activeAuthUid){try{localStorage.removeItem(evidenceStorageKey(path,uid))}catch(error){console.warn("MILEAGE_EVIDENCE_LOCAL_CLEAR_FAILED",error?.message)}}
function migrateLegacyLocalTasks(token=captureSessionToken()){
  if(!sessionTokenIsCurrent(token)||!isDriver())return;
  const legacy=[];for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);if(key?.startsWith(OP_PREFIX)||key?.startsWith(EVIDENCE_PREFIX)||key?.startsWith(PENDING_PREFIX))legacy.push(key)}
  for(const key of legacy){
    if(key.startsWith(scopedOperationPrefix(token.uid))||key.startsWith(scopedEvidencePrefix(token.uid))||key.startsWith(scopedPendingPrefix(token.uid)))continue;
    try{
      const item=JSON.parse(localStorage.getItem(key)||"{}");if(clean(item?.driverUid)!==token.uid)continue;
      let nextKey="";
      if(key.startsWith(OP_PREFIX))nextKey=operationStorageKey(item.kind,item.mileageRecordId,item.driverUid);
      else if(key.startsWith(EVIDENCE_PREFIX))nextKey=evidenceStorageKey(item.path,item.driverUid);
      else nextKey=pendingStorageKey(item.alertId,item.driverUid);
      if(nextKey){localStorage.setItem(nextKey,JSON.stringify(item));localStorage.removeItem(key)}
    }catch(error){console.warn("MILEAGE_LEGACY_LOCAL_MIGRATION_FAILED",error?.message)}
  }
}
async function prepareOperation({kind,km,vehicleId,expectedRevision,justification="",expectedStatus,file}){
  const processed=await compressPhoto(file),photoHash=await sha256Blob(processed);
  const operationFingerprint=await buildOperationFingerprint({driverUid:context.user.uid,weeklyPeriodId:context.active.id,mileageRecordId:context.id,operationType:kind,expectedRevision,vehicleId,km,photoHash,justification,expectedStatus});
  const operationId=await buildOperationId({driverUid:context.user.uid,weeklyPeriodId:context.active.id,mileageRecordId:context.id,operationType:kind,operationFingerprint});
  const operation={kind,km,vehicleId,expectedRevision,justification,expectedStatus,photoHash,operationFingerprint,operationId,fingerprintAlgorithm:"sha256",driverUid:context.user.uid,weeklyPeriodId:context.active.id,mileageRecordId:context.id,phase:"prepared",createdAtMs:Date.now()};
  persistOperation(operation);return {operation,processed};
}
async function uploadOperationPhoto(prepared){
  await ensureFirebase({requireStorage:true});
  const {operation,processed}=prepared;
  const safeKind=operation.kind.replace(/[^a-z0-9_-]/gi,"_");
  const path=`kilometraje_semanal/${operation.driverUid}/${operation.weeklyPeriodId}/${operation.mileageRecordId}/${safeKind}/r${operation.expectedRevision}/${operation.operationId}.jpg`;
  const reference=storageRef(storage,path);
  operation.phase="photo_upload_pending";operation.photoPath=path;persistOperation(operation);
  await uploadBytes(reference,processed,{contentType:"image/jpeg",customMetadata:{driverUid:operation.driverUid,weeklyPeriodId:operation.weeklyPeriodId,mileageRecordId:operation.mileageRecordId,vehicleId:operation.vehicleId,kind:operation.kind,operationId:operation.operationId,operationFingerprint:operation.operationFingerprint,photoHash:operation.photoHash,confirmed:"false"}});
  const url=await getDownloadURL(reference);
  operation.phase="photo_uploaded";operation.photoUrl=url;operation.photoSize=processed.size;persistOperation(operation);
  persistEvidence({path,url,operationId:operation.operationId,operationFingerprint:operation.operationFingerprint,status:"unconfirmed",driverUid:operation.driverUid,weeklyPeriodId:operation.weeklyPeriodId,mileageRecordId:operation.mileageRecordId,kind:operation.kind,createdAtMs:Date.now()});
  return {...operation,path,url,size:processed.size,mimeType:processed.type};
}
async function readOperationRecordFromServer(operation,token=captureSessionToken()){
  await ensureFirebase();
  assertSessionToken(token,operation?.driverUid);
  const id=clean(operation?.mileageRecordId||context?.id);
  if(!id)throw mileageError("MILEAGE_RECONCILIATION_ID_MISSING","No se pudo identificar el registro a conciliar.");
  const ref=doc(db,COLLECTION,id);
  try{return await getDocFromServer(ref)}
  catch(error){
    if(["unimplemented","failed-precondition"].includes(clean(error?.code)))return getDoc(ref);
    throw error;
  }
}
function persistOperationPhase(operation,phase,error=null){
  if(!operation)return;
  operation.phase=phase;operation.lastAttemptAtMs=Date.now();
  if(error)operation.lastError=clean(error?.code||error?.message||error);
  persistOperation(operation);
}
async function reconcileOperationAfterUncertainCommit(operation,token=captureSessionToken()){
  assertSessionToken(token,operation?.driverUid);
  persistOperationPhase(operation,"reconciliation_pending");
  try{
    const snap=await readOperationRecordFromServer(operation,token);
    const result=classifyOperationCommit(snap.exists()?snap.data():null,operation);
    if(result.status==="confirmed"){
      persistOperationPhase(operation,"transaction_committed");
      confirmEvidence(operation);
      return result;
    }
    if(result.status==="conflicting"){
      persistOperationPhase(operation,"conflict");
      persistEvidence({path:operation.path||operation.photoPath,url:operation.url||operation.photoUrl||"",operationId:operation.operationId,operationFingerprint:operation.operationFingerprint,status:"cleanup_pending",driverUid:operation.driverUid,weeklyPeriodId:operation.weeklyPeriodId,mileageRecordId:operation.mileageRecordId,kind:operation.kind,updatedAtMs:Date.now()});
      return result;
    }
    persistOperationPhase(operation,"rejected");
    return result;
  }catch(error){
    persistOperationPhase(operation,"commit_confirmation_unknown",error);
    persistEvidence({path:operation.path||operation.photoPath,url:operation.url||operation.photoUrl||"",operationId:operation.operationId,operationFingerprint:operation.operationFingerprint,status:"unknown",driverUid:operation.driverUid,weeklyPeriodId:operation.weeklyPeriodId,mileageRecordId:operation.mileageRecordId,kind:operation.kind,lastError:clean(error?.code||error?.message),updatedAtMs:Date.now()});
    return {status:"unknown",reason:clean(error?.code||error?.message)};
  }
}
async function safeDeleteUnconfirmedEvidence(uploaded,token=captureSessionToken()){
  assertSessionToken(token,uploaded?.driverUid);
  const path=clean(uploaded?.path||uploaded?.photoPath);if(!path)return {deleted:false,reason:"missing-path"};
  if(["unknown","commit_confirmation_unknown","reconciliation_pending"].includes(clean(uploaded?.status||uploaded?.phase)))return {deleted:false,reason:"commit-unknown"};
  let snap;
  try{snap=await readOperationRecordFromServer(uploaded,token)}
  catch(error){persistEvidence({...uploaded,path,status:"cleanup_pending",lastError:clean(error?.code||error?.message),updatedAtMs:Date.now()});return {deleted:false,reason:"read-failed"}}
  const record=snap.exists()?snap.data():null;
  if(record&&[clean(record.startPhotoPath),clean(record.endPhotoPath)].includes(path)){
    confirmEvidence(uploaded);return {deleted:false,reason:"referenced"};
  }
  try{await ensureFirebase({requireStorage:true,timeoutMs:4000});await deleteObject(storageRef(storage,path));clearEvidence(path,uploaded.driverUid);if(uploaded?.kind)clearOperation(uploaded.kind,uploaded.mileageRecordId,uploaded.driverUid);return {deleted:true}}
  catch(error){persistEvidence({...uploaded,path,status:"cleanup_pending",lastError:clean(error?.code||error?.message||"delete-failed"),updatedAtMs:Date.now()});return {deleted:false,reason:"delete-failed"}}
}
async function cleanupUnconfirmedEvidence(uploaded){return safeDeleteUnconfirmedEvidence(uploaded)}

async function resolveCommitFailure(error,uploaded){
  if(!uploaded)throw error;
  const result=await reconcileOperationAfterUncertainCommit(uploaded);
  if(result.status==="confirmed")return {confirmed:true};
  if(result.status==="rejected"||result.status==="conflicting")await safeDeleteUnconfirmedEvidence({...uploaded,status:"cleanup_pending"});
  if(result.status==="unknown")throw mileageError("MILEAGE_COMMIT_CONFIRMATION_UNKNOWN","No pudimos confirmar todavía si el registro fue guardado. Reintentá la conciliación cuando vuelva la conexión.",{cause:error});
  throw error;
}
function confirmEvidence(uploaded){if(uploaded?.path||uploaded?.photoPath)clearEvidence(uploaded.path||uploaded.photoPath,uploaded.driverUid);if(uploaded?.kind)clearOperation(uploaded.kind,uploaded.mileageRecordId,uploaded.driverUid)}
async function makeOutbox(incidents=[],operationFingerprint=""){
  const out={};
  for(const item of incidents){
    const incidentType=clean(item.incidentType);if(!incidentType)continue;
    const alertId=idempotentAlertId(context.user.uid,context.active.id,context.id,incidentType);
    const incidentKey=await buildIncidentKey({driverUid:context.user.uid,weeklyPeriodId:context.active.id,mileageRecordId:context.id,incidentType,operationFingerprint});
    out[incidentType]=buildOutboxEntry({alertId,incidentType,incidentKey,operationFingerprint,payload:{...item,driverUid:context.user.uid,driverName:clean(context.profile?.nombre||context.profile?.nombreCompleto||"Chofer"),weeklyPeriodId:context.active.id,mileageRecordId:context.id,vehicleId:context.vehicle?.id||"",vehiclePlate:context.label?.plate||"",source:"weekly_mileage_v15",incidentKey,operationFingerprint}})
  }
  return out;
}
async function processRecordOutbox(record=currentRecord){
  if(!record?.id||!record?.alertOutbox||!db)return;
  for(const [kind,item] of Object.entries(record.alertOutbox||{})){
    if(["delivered","reviewed","cancelled","already_resolved","resolved"].includes(clean(item?.status)))continue;
    const alertId=clean(item?.alertId||idempotentAlertId(record.driverUid,record.weeklyPeriodId,record.id,kind));
    try{
      await runTransaction(db,async tx=>{
        const recRef=doc(db,COLLECTION,record.id),alertRef=doc(db,"weekly_mileage_alerts",alertId);
        const recSnap=await tx.get(recRef),alertSnap=await tx.get(alertRef);
        if(!recSnap.exists())return;
        const latest=recSnap.data()||{},latestItem=latest.alertOutbox?.[kind];
        if(!latestItem||["delivered","reviewed","cancelled","already_resolved","resolved"].includes(clean(latestItem.status)))return;
        const alertData=alertSnap.exists()?alertSnap.data():null;
        const decision=nextOutboxDeliveryState({alert:alertData,outboxItem:{...latestItem,alertId,incidentType:kind},now:serverTimestamp()});
        const nextOutbox={...(latest.alertOutbox||{}),[kind]:decision.outboxMutation};
        if(decision.alertMutation){
          tx.set(alertRef,{...decision.alertMutation,createdAt:alertData?.createdAt||serverTimestamp(),updatedAt:serverTimestamp()},{merge:true});
        }
        const stillPending=Object.values(nextOutbox).some(entry=>!["delivered","reviewed","cancelled","already_resolved","resolved"].includes(clean(entry?.status)));
        const allAdministrativelyResolved=Object.values(nextOutbox).every(entry=>["reviewed","cancelled","already_resolved","resolved"].includes(clean(entry?.status)));
        tx.set(recRef,{alertOutbox:nextOutbox,operationState:stillPending?"outbox_pending":"completed",...(allAdministrativelyResolved?{adminReviewRequired:false,reviewedByAdmin:true,reviewStatus:"reviewed"}:{}),updatedAt:serverTimestamp()},{merge:true});
      });
    }catch(error){
      try{await runTransaction(db,async tx=>{const recRef=doc(db,COLLECTION,record.id),snap=await tx.get(recRef);if(!snap.exists())return;const latest=snap.data()||{},latestItem=latest.alertOutbox?.[kind]||{};if(["reviewed","already_resolved","resolved"].includes(clean(latestItem.status)))return;const nextOutbox={...(latest.alertOutbox||{}),[kind]:{...latestItem,status:"failed_retryable",attempts:Number(latestItem.attempts||0)+1,lastError:clean(error?.code||error?.message),lastAttemptAt:serverTimestamp()}};tx.set(recRef,{alertOutbox:nextOutbox,operationState:"outbox_pending",updatedAt:serverTimestamp()},{merge:true})})}catch(inner){console.warn("MILEAGE_OUTBOX_STATUS_FAILED",inner?.code||inner?.message)}
    }
  }
}
async function reconcilePendingOperations(token=captureSessionToken()){
  if(!navigator.onLine||!db||!isDriver()||!sessionTokenIsCurrent(token))return;
  const prefix=scopedOperationPrefix(token.uid),keys=[];
  for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);if(key?.startsWith(prefix))keys.push(key)}
  for(const key of keys){
    if(!sessionTokenIsCurrent(token))return;
    try{
      const operation=JSON.parse(localStorage.getItem(key)||"{}");
      if(!isOwnedByCurrentDriver(operation,token))continue;
      if(!["commit_confirmation_unknown","reconciliation_pending","transaction_pending"].includes(clean(operation.phase)))continue;
      const result=await reconcileOperationAfterUncertainCommit(operation,token);
      assertSessionToken(token,operation.driverUid);
      if(result.status==="rejected")await safeDeleteUnconfirmedEvidence({...operation,path:operation.photoPath,status:"cleanup_pending"},token);
    }catch(error){if(clean(error?.code)==="MILEAGE_SESSION_CHANGED")return;console.warn("MILEAGE_OPERATION_RECONCILIATION_FAILED",error?.code||error?.message)}
  }
}
async function cleanupPendingEvidences(token=captureSessionToken()){
  if(!navigator.onLine||!isDriver()||!sessionTokenIsCurrent(token))return;
  const prefix=scopedEvidencePrefix(token.uid),keys=[];
  for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);if(key?.startsWith(prefix))keys.push(key)}
  for(const key of keys){
    if(!sessionTokenIsCurrent(token))return;
    try{const item=JSON.parse(localStorage.getItem(key)||"{}");if(!isOwnedByCurrentDriver(item,token))continue;if(item.status==="cleanup_pending"&&item.path)await safeDeleteUnconfirmedEvidence(item,token)}
    catch(error){if(clean(error?.code)==="MILEAGE_SESSION_CHANGED")return;console.warn("MILEAGE_EVIDENCE_CLEANUP_FAILED",error?.message)}
  }
}


function mileageError(code,message,extra={}){return Object.assign(new Error(message),{code,...extra})}
function assertRecordIdentity(data,ctx){
  if(clean(data?.driverUid)&&clean(data.driverUid)!==clean(ctx.user.uid))throw mileageError("MILEAGE_RECORD_OWNER_MISMATCH","El registro pertenece a otro chofer.");
  if(clean(data?.weeklyPeriodId)&&clean(data.weeklyPeriodId)!==clean(ctx.active.id))throw mileageError("MILEAGE_RECORD_PERIOD_MISMATCH","El registro pertenece a otra semana.");
}
function assertExpectedRevision(data,expectedRevision){
  const current=Number(data?.revision||0);
  if(Number.isFinite(expectedRevision)&&current!==expectedRevision)throw mileageError("MILEAGE_CONFLICT","El control cambió en otro dispositivo. Se recargará el estado actual.",{currentRevision:current,expectedRevision});
}
async function transactStart(payload,{late=false,expectedRevision=0}={}){
  await ensureFirebase();
  return runTransaction(db,async tx=>{
    const snap=await tx.get(context.ref),existing=snap.exists()?snap.data():null;
    const result=buildStartMutation(existing,payload,{late,expectedRevision});
    if(result.mutation)tx.set(context.ref,{...result.mutation,createdAt:existing?.createdAt||serverTimestamp(),updatedAt:serverTimestamp()},{merge:true});
    return result;
  });
}
async function transactFinalize(payload,{expectedRevision,allowedStatuses=["tracking"]}={}){
  await ensureFirebase();
  return runTransaction(db,async tx=>{
    const snap=await tx.get(context.ref),existing=snap.exists()?snap.data():null;
    const result=buildFinalizeMutation(existing,payload,{expectedRevision,allowedStatuses});
    if(result.mutation)tx.set(context.ref,{...result.mutation,updatedAt:serverTimestamp()},{merge:true});
    return result;
  });
}


function escapeHtml(value){return clean(value).replace(/[&<>'"]/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[ch]));}
function profileIds(profile={}){return [profile.assignedVehicleId,profile.vehicleId,profile.vehiculoId,profile.autoId,profile.vehiculoAsignado,profile.vehiculo].map(clean).filter(Boolean)}
function identities(uid,profile={}){return [...new Set([uid,profile.id,profile.uid,profile.authUid,profile.firebaseUid,profile.usuario,profile.username,profile.nombre,profile.nombreCompleto].map(clean).filter(Boolean))]}
function normalizedIdentity(value){return clean(value).toLowerCase()}
function vehicleAssignmentValues(vehicle={}){return [vehicle.currentDriverUid,vehicle.currentDriverDocumentId,vehicle.choferId,vehicle.conductorId,vehicle.driverId,vehicle.asignadoA,vehicle.chofer,vehicle.uidChofer,vehicle.currentDriverName].map(normalizedIdentity).filter(Boolean)}
function vehicleIsOperational(vehicle={}){
  const state=normalizedIdentity(vehicle.status||vehicle.estado);
  if(vehicle.isDeleted===true||vehicle.deleted===true||vehicle.eliminado===true||vehicle.disabled===true||vehicle.isDisabled===true)return false;
  if(vehicle.activo===false||vehicle.active===false||vehicle.habilitado===false||vehicle.enabled===false)return false;
  return !["deleted","eliminado","eliminada","inactive","inactivo","inactiva","disabled","deshabilitado","deshabilitada","archived","archivado","archivada"].includes(state);
}
function canonicalAssignmentMatches(vehicle={},uid,profile={}){
  if(!vehicleIsOperational(vehicle)||vehicle.isAssigned===false)return false;
  const allowed=new Set(identities(uid,profile).map(normalizedIdentity));
  const assigned=vehicleAssignmentValues(vehicle);
  return assigned.length>0&&assigned.some(value=>allowed.has(value));
}
function stableHash(text=""){
  let hash=2166136261;
  for(const ch of String(text)){hash^=ch.charCodeAt(0);hash=Math.imul(hash,16777619)}
  return (hash>>>0).toString(36);
}
function incidenceType(error={},extra={}){
  return clean(extra.incidenceType||extra.alertType||extra.alertLabel||extra.code||error?.code||error?.message||"technical-error").toLowerCase().replace(/[^a-z0-9_-]+/g,"-").replace(/^-+|-+$/g,"")||"technical-error";
}
function idempotentAlertId(uid,periodId,mileageRecordId,kind){return buildAlertId(uid,periodId,mileageRecordId||recordId(uid,periodId),kind)}
async function loadProfile(uid){
  await ensureFirebase();
  const session=window.ExploraSession?.profile;
  if(session&&[session.uid,session.authUid,session.firebaseUid,window.ExploraSession?.profileDocumentId].map(clean).includes(uid)) return {...session,id:clean(window.ExploraSession?.profileDocumentId||session.id||uid)};
  for(const id of [uid,clean(window.ExploraSession?.profileDocumentId)]){if(!id)continue;const snap=await getDoc(doc(db,"choferes",id));if(snap?.exists())return {...snap.data(),id:snap.id}}
  for(const field of ["uid","authUid","firebaseUid"]){const snap=await getDocs(query(collection(db,"choferes"),where(field,"==",uid),limit(2)));if(snap&&!snap.empty)return {...snap.docs[0].data(),id:snap.docs[0].id}}
  return session?{...session,id:uid}:null;
}
async function loadVehicle(uid,profile={}){
  await ensureFirebase();
  const candidates=new Map();
  const addCandidate=snap=>{if(!snap?.exists?.())return;const candidate={...snap.data(),id:snap.id};if(canonicalAssignmentMatches(candidate,uid,profile))candidates.set(candidate.id,candidate)};
  for(const id of [...new Set(profileIds(profile))]){try{addCandidate(await getDoc(doc(db,"vehiculos",id)))}catch(error){if(infrastructureError(error))throw error}}
  const fields=["currentDriverUid","currentDriverDocumentId","choferId","conductorId","driverId","asignadoA","chofer","uidChofer"];
  for(const field of fields){
    for(const identity of identities(uid,profile)){
      const snap=await getDocs(query(collection(db,"vehiculos"),where(field,"==",identity),limit(10)));
      snap?.docs?.forEach(addCandidate);
    }
  }
  const valid=[...candidates.values()];
  if(valid.length>1){
    const error=Object.assign(new Error(`Se encontraron ${valid.length} vehículos activos asignados al mismo chofer. El caso requiere revisión administrativa.`),{code:"MILEAGE_MULTIPLE_ACTIVE_VEHICLES",vehicleIds:valid.map(v=>v.id)});
    throw error;
  }
  return valid[0]||null;
}
function vehicleLabel(profile,vehicle){const plate=clean(vehicle?.patente||vehicle?.plate||vehicle?.matricula||profile?.assignedVehiclePlate||profile?.patenteVehiculo).toUpperCase();const model=clean(vehicle?.modelo||vehicle?.model||vehicle?.nombre||profile?.modeloVehiculo);return {plate:plate||"SIN PATENTE",name:model||"Vehículo asignado"}}
async function buildContext(periodId=""){
  await ensureFirebase();
  const user=auth?.currentUser;
  if(!user||!isDriver())return null;
  const activeDefault=period();
  const resolvedPeriodId=clean(periodId||activeDefault?.id);
  if(!resolvedPeriodId)return {user,profile:null,vehicle:null,active:null,label:null,error:"No se pudo determinar la semana operativa.",errorCode:"MILEAGE_PERIOD_UNAVAILABLE"};
  try{
    const profile=await loadProfile(user.uid);
    const vehicle=await loadVehicle(user.uid,profile||{});
    if(!vehicle)return {user,profile,vehicle:null,active:{...(activeDefault||{}),id:resolvedPeriodId},label:null,error:"No se encontró un vehículo asignado.",errorCode:"MILEAGE_VEHICLE_UNASSIGNED"};
    const label=vehicleLabel(profile||{},vehicle);
    const id=recordId(user.uid,resolvedPeriodId);
    return {user,profile,vehicle,active:{...(activeDefault||{}),id:resolvedPeriodId},label,id,ref:doc(db,COLLECTION,id)};
  }catch(error){
    return {user,profile:null,vehicle:null,active:{...(activeDefault||{}),id:resolvedPeriodId},label:null,error:error?.message||"No se pudo consultar el vehículo asignado.",errorCode:error?.code||"MILEAGE_CONTEXT_READ_FAILED",technicalError:error};
  }
}
async function readCurrentRecord(nextContext){
  await ensureFirebase();
  if(!nextContext?.ref)return null;
  let snap;
  try{snap=await getDocFromServer(nextContext.ref)}catch(_){snap=await getDoc(nextContext.ref)}
  if(snap.exists())return {id:snap.id,...snap.data()};
  // Recupera registros creados por versiones anteriores con otro formato de ID.
  // La consulta queda limitada al UID autenticado y luego valida la semana exacta.
  try{
    const fallback=await getDocs(query(collection(db,COLLECTION),where("driverUid","==",nextContext.user.uid),limit(24)));
    const matches=fallback.docs.map(d=>({id:d.id,...d.data()})).filter(row=>clean(row.weeklyPeriodId)===clean(nextContext.active.id));
    matches.sort((a,b)=>timestampMs(b.updatedAt||b.startRecordedAt)-timestampMs(a.updatedAt||a.startRecordedAt));
    const recovered=matches[0]||null;
    if(recovered){nextContext.id=recovered.id;nextContext.ref=doc(db,COLLECTION,recovered.id);return recovered}
  }catch(error){console.warn("MILEAGE_RECORD_FALLBACK_FAILED",error?.code||error?.message)}
  return null;
}
async function refreshContext(){
  const next=await buildContext();
  context=next;
  currentRecord=null;
  if(context?.ref){try{currentRecord=await readCurrentRecord(context)}catch(error){context={...context,error:error?.message||"No se pudo leer el seguimiento.",errorCode:error?.code||"MILEAGE_RECORD_READ_FAILED",technicalError:error}}}
  renderCards();if(currentRecord?.alertOutbox)processRecordOutbox(currentRecord).catch(error=>console.warn("MILEAGE_OUTBOX_PROCESS_FAILED",error?.message));return context;
}
async function activatePeriodContext(periodId){
  context=null;currentRecord=null;
  const next=await buildContext(clean(periodId));
  context=next;
  if(context?.ref){try{currentRecord=await readCurrentRecord(context)}catch(error){context={...context,error:error?.message||"No se pudo leer el seguimiento.",errorCode:error?.code||"MILEAGE_RECORD_READ_FAILED",technicalError:error}}}
  renderCards();if(currentRecord?.alertOutbox)processRecordOutbox(currentRecord).catch(error=>console.warn("MILEAGE_OUTBOX_PROCESS_FAILED",error?.message));return context;
}
async function imageSourceFromFile(file){
  if(typeof createImageBitmap==="function"){
    try{return await createImageBitmap(file)}catch(error){console.info("MILEAGE_IMAGE_BITMAP_FALLBACK",error?.message||"unsupported image bitmap")}
  }
  return await new Promise((resolve,reject)=>{
    const url=URL.createObjectURL(file),img=new Image();
    img.onload=()=>{URL.revokeObjectURL(url);resolve(img)};
    img.onerror=()=>{URL.revokeObjectURL(url);reject(new Error("El teléfono no pudo abrir esta foto. Probá tomar otra imagen en JPG."))};
    img.src=url;
  });
}
async function compressPhoto(file){
  if(!(file instanceof File))throw new Error("Seleccioná una foto del tablero.");
  if(!file.type.startsWith("image/"))throw new Error("La evidencia debe ser una imagen.");
  if(file.size>18*1024*1024)throw new Error("La foto supera 18 MB.");
  const source=await imageSourceFromFile(file),width=source.width||source.naturalWidth,height=source.height||source.naturalHeight;
  if(!width||!height)throw new Error("No se pudo leer el tamaño de la foto.");
  const max=1600,scale=Math.min(1,max/Math.max(width,height)),canvas=document.createElement("canvas");
  canvas.width=Math.max(1,Math.round(width*scale));canvas.height=Math.max(1,Math.round(height*scale));
  const ctx=canvas.getContext("2d");if(!ctx)throw new Error("No se pudo preparar la foto.");ctx.drawImage(source,0,0,canvas.width,canvas.height);source.close?.();
  return await new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(new File([blob],`tablero_${Date.now()}.jpg`,{type:"image/jpeg"})):reject(new Error("No se pudo procesar la foto.")),"image/jpeg",.82));
}
function ensureUi(){
  if($("mileageOverlay"))return;
  const overlay=document.createElement("div");overlay.id="mileageOverlay";overlay.className="mileage-overlay";overlay.hidden=true;overlay.innerHTML=`<section class="mileage-modal" role="dialog" aria-modal="true" aria-labelledby="mileageTitle"><header><div><small class="mileage-kicker">EXPLORA · CONTROL SEMANAL</small><h2 id="mileageTitle">KILOMETRAJE</h2></div><button type="button" id="mileageClose" aria-label="Cerrar">×</button></header><div class="mileage-body" id="mileageBody"></div></section>`;document.body.appendChild(overlay);$("mileageClose").addEventListener("click",()=>closeModal(false));
}
function openModal(mode,options={}){
  ensureUi();
  const overlay=$("mileageOverlay");
  if(modalPromise&&overlay&&!overlay.hidden){
    if(modalMode===mode)return modalPromise;
    const active=modalPromise;
    return active.then(async result=>{await refreshContext().catch(()=>{});if(mode==="end"&&!currentRecord?.startKm)return false;return openModal(mode,options)});
  }
  modalOptions={...options,mode};modalMode=mode;
  const title=$("mileageTitle"),close=$("mileageClose");overlay.hidden=false;document.body.style.overflow="hidden";title.textContent=mode==="start"?"INICIO DE KILOMETRAJE":mode==="end"?"CIERRE DE KILOMETRAJE":"SEGUIMIENTO DE KILOMETRAJE";if(close)close.hidden=Boolean(options.mandatory);
  modalPromise=new Promise(resolve=>{modalResolve=resolve;renderModal(mode,options)});
  return modalPromise;
}
function closeModal(result=false){releasePreview($("mileagePreview"));const overlay=$("mileageOverlay"),close=$("mileageClose"),closingMode=modalMode,closingOptions={...modalOptions};if(overlay)overlay.hidden=true;if(close)close.hidden=false;document.body.style.overflow="";const resolve=modalResolve;modalResolve=null;modalPromise=null;modalMode="";modalOptions={};resolve?.(result);if(closingMode==="start"&&!closingOptions.mandatory){if(result){refreshContext().then(()=>{if(mileageStartComplete()){rememberConfirmedStart(currentRecord);clearStartGrace();stopMileageReminder()}else scheduleMileageReminder()}).catch(()=>scheduleMileageReminder())}else scheduleMileageReminder()}}
function infrastructureError(error){
  const code=clean(error?.code||error?.cause?.code).toLowerCase().replace(/^firebase\//,"");
  const message=clean(error?.message||error?.cause?.message).toLowerCase();
  const aggregate=`${code} ${message}`;
  const firebaseCodes=new Set(["cancelled","unknown","deadline-exceeded","not-found","already-exists","permission-denied","resource-exhausted","failed-precondition","aborted","out-of-range","unimplemented","internal","unavailable","data-loss","unauthenticated"]);
  if(firebaseCodes.has(code)||[...firebaseCodes].some(item=>code.endsWith(`/${item}`)))return true;
  return /(?:firestore|firebase|storage|auth)[\s/:_-]|permission|denied|insufficient|unauthenticated|unauthorized|network|offline|unavailable|deadline|timed?[- ]?out|timeout|resource[- ]?exhausted|quota|bucket|cors|aborted|failed[- ]?precondition|internal error|data[- ]?loss|service unavailable/.test(aggregate);
}
function resolvePendingPeriodId(payload={}){
  const explicit=clean(payload.weeklyPeriodId);
  if(explicit)return explicit;
  const occurredAtMs=Number(payload.occurredAtMs||payload.createdAt||Date.now());
  const fromDate=window.ExploraCanonicalWeeklyClosure?.getWeeklyPeriod?.(new Date(occurredAtMs))?.id;
  return clean(fromDate||closureTargetPeriod()||period()?.id);
}
async function registerCentralPending(error,extra={}){
  try{await ensureFirebase({timeoutMs:5000})}catch(error){console.info("MILEAGE_CENTRAL_PENDING_OFFLINE",error?.code||error?.message)}
  const occurredAtMs=Number(extra.occurredAtMs||Date.now());
  const payload={driverUid:context?.user?.uid||auth?.currentUser?.uid||"",weeklyPeriodId:clean(extra.weeklyPeriodId||context?.active?.id||""),vehicleId:context?.vehicle?.id||"",vehiclePlate:context?.label?.plate||"",reason:error?.code||error?.message||"technical-error",status:"pending_technical_review",source:"weekly_mileage_v15",occurredAtMs,...extra,updatedAt:serverTimestamp()};
  payload.weeklyPeriodId=resolvePendingPeriodId(payload);
  payload.mileageRecordId=clean(payload.mileageRecordId||context?.id||recordId(payload.driverUid,payload.weeklyPeriodId));
  payload.incidenceType=incidenceType(error,payload);
  payload.alertId=idempotentAlertId(payload.driverUid,payload.weeklyPeriodId,payload.mileageRecordId,payload.incidenceType);
  let centralSaved=false;
  try{
    if(db&&payload.driverUid&&payload.weeklyPeriodId){
      const alertRef=doc(db,"weekly_mileage_alerts",payload.alertId),existing=await getDoc(alertRef);
      await setDoc(alertRef,{...payload,createdAt:existing.exists()?(existing.data()?.createdAt||serverTimestamp()):serverTimestamp(),lastOccurredAt:serverTimestamp()},{merge:true});
      centralSaved=true;
    }
  }catch(saveError){console.warn("MILEAGE_ALERT_SAVE_FAILED",saveError?.code||saveError?.message)}
  if(!centralSaved){
    try{localStorage.setItem(pendingStorageKey(payload.alertId,payload.driverUid),JSON.stringify({...payload,createdAt:occurredAtMs,updatedAt:occurredAtMs}))}
    catch(storageError){console.warn("MILEAGE_PENDING_LOCAL_SAVE_FAILED",storageError?.message)}
  }
  return centralSaved;
}
async function syncLocalPendings(token=captureSessionToken()){
  if(!navigator.onLine||!isDriver()||!sessionTokenIsCurrent(token))return;
  await ensureFirebase();
  const prefix=scopedPendingPrefix(token.uid),keys=[];for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);if(key?.startsWith(prefix))keys.push(key)}
  for(const key of keys){
    if(!sessionTokenIsCurrent(token))return;
    try{
      const payload=JSON.parse(localStorage.getItem(key)||"{}");
      if(!isOwnedByCurrentDriver(payload,token))continue;
      payload.weeklyPeriodId=resolvePendingPeriodId(payload);
      if(!payload.driverUid||!payload.weeklyPeriodId)continue;
      payload.mileageRecordId=clean(payload.mileageRecordId||recordId(payload.driverUid,payload.weeklyPeriodId));
      payload.incidenceType=clean(payload.incidenceType||incidenceType({},payload));
      payload.alertId=clean(payload.alertId)||idempotentAlertId(payload.driverUid,payload.weeklyPeriodId,payload.mileageRecordId,payload.incidenceType);
      const alertRef=doc(db,"weekly_mileage_alerts",payload.alertId),existing=await getDoc(alertRef);
      assertSessionToken(token,payload.driverUid);
      await setDoc(alertRef,{...payload,source:"weekly_mileage_v15",createdAt:existing.exists()?(existing.data()?.createdAt||serverTimestamp()):serverTimestamp(),lastOccurredAt:serverTimestamp(),updatedAt:serverTimestamp()},{merge:true});
      assertSessionToken(token,payload.driverUid);localStorage.removeItem(key);
    }catch(error){if(clean(error?.code)==="MILEAGE_SESSION_CHANGED")return;console.warn("MILEAGE_PENDING_SYNC_FAILED",error?.code||error?.message)}
  }
}

function mileageFormReady(){
  const km=num($("mileageKmInput")?.value),photo=$("mileagePhotoInput")?.files?.[0];
  return Number.isInteger(km)&&km>0&&Boolean(photo);
}
function syncMileageFormState(){
  const button=$("mileageSaveBtn"),helper=$("mileageFormHelper");
  if(button&&!operationBusy)button.disabled=!mileageFormReady();
  if(helper){
    const hasKm=Number.isInteger(num($("mileageKmInput")?.value))&&num($("mileageKmInput")?.value)>0;
    const hasPhoto=Boolean($("mileagePhotoInput")?.files?.[0]);
    helper.textContent=!hasKm?"Ingresá el kilometraje exacto que muestra el tablero.":!hasPhoto?"Ahora tomá una foto clara del tablero.":"Datos completos. Ya podés activar el seguimiento.";
    helper.className=`mileage-form-helper${hasKm&&hasPhoto?" is-ready":""}`;
  }
}
function setBusy(busy,statusText=""){
  operationBusy=Boolean(busy);const button=$("mileageSaveBtn"),input=$("mileageKmInput"),photo=$("mileagePhotoInput");
  if(button){button.disabled=operationBusy||!mileageFormReady();button.textContent=operationBusy?(statusText||"GUARDANDO…"):(modalOptions.mode==="start"?"ACTIVAR SEGUIMIENTO":"ANALIZAR KILOMETRAJE")}
  if(input)input.disabled=operationBusy;if(photo)photo.disabled=operationBusy;
}
function showRecoverableError(status,error){status.className="mileage-status is-error";status.textContent=error?.message||"No se pudo guardar.";if(!infrastructureError(error))return;let actions=$("mileageRecoveryActions");if(!actions){actions=document.createElement("div");actions.id="mileageRecoveryActions";actions.className="mileage-modal-actions";status.insertAdjacentElement("afterend",actions)}actions.innerHTML=`<div class="mileage-note">El control no pudo conectarse. El cierre financiero no será alterado ni bloqueado por un problema técnico.</div><button class="mileage-action secondary" id="mileageRetryBtn" type="button">REINTENTAR</button><button class="mileage-action secondary" id="mileageSafeExitBtn" type="button">${modalOptions.forClosure?"CONTINUAR CIERRE CON CONTROL PENDIENTE":"CERRAR Y REINTENTAR MÁS TARDE"}</button>`;$("mileageRetryBtn")?.addEventListener("click",()=>renderModal(modalOptions.mode||"start",modalOptions));$("mileageSafeExitBtn")?.addEventListener("click",async()=>{await registerCentralPending(error);closeModal(Boolean(modalOptions.forClosure))})}
function releasePreview(img){const previous=img?.dataset?.objectUrl;if(previous){URL.revokeObjectURL(previous);delete img.dataset.objectUrl}}
function filePreview(input,img){
  releasePreview(img);const file=input.files?.[0],name=$("mileagePhotoName"),empty=$("mileagePreviewEmpty");
  if(!file){img.hidden=true;img.removeAttribute("src");if(name)name.textContent="Todavía no seleccionaste una foto";if(empty)empty.hidden=false;syncMileageFormState();return}
  const url=URL.createObjectURL(file);img.dataset.objectUrl=url;img.src=url;img.hidden=false;if(name)name.textContent=file.name||"Foto del tablero lista";if(empty)empty.hidden=true;syncMileageFormState();
}
function lastKnownKm(){return Math.max(num(currentRecord?.startKm),num(context?.vehicle?.currentKm),num(context?.vehicle?.kilometraje),num(context?.vehicle?.odometro))}
function finishMileageCommitFast({status,uploaded,sessionToken,message="Control de kilometraje registrado."}={}){
  confirmEvidence(uploaded);
  if(status){
    status.className="mileage-status is-ok";
    status.textContent=message;
  }
  setTimeout(()=>closeModal(true),160);
  setTimeout(async()=>{
    try{
      if(!sessionTokenIsCurrent(sessionToken))return;
      await refreshContext();
      if(!sessionTokenIsCurrent(sessionToken))return;
      await processRecordOutbox(currentRecord);
    }catch(error){
      console.warn("MILEAGE_POST_COMMIT_BACKGROUND_FAILED",error?.code||error?.message||error);
    }
  },0);
}
async function saveStart(){
  const sessionToken=captureSessionToken();assertSessionToken(sessionToken);
  const km=num($("mileageKmInput")?.value),photo=$("mileagePhotoInput")?.files?.[0],status=$("mileageStatus");
  if(operationBusy)return;setBusy(true,"GUARDANDO…");let uploaded=null;
  try{
    status.className="mileage-status";status.textContent="Validando…";
    if(context?.technicalError||context?.errorCode==="MILEAGE_RECORD_READ_FAILED")throw mileageError("MILEAGE_RECORD_UNVERIFIED","No fue posible verificar si ya existe un control. Reintentá antes de registrar datos.");
    if(!context?.vehicle||!context?.ref)throw new Error("No se pudo confirmar el vehículo asignado.");
    const minimum=Math.max(num(context.vehicle?.currentKm),num(context.vehicle?.kilometraje),num(context.vehicle?.odometro));
    if(!Number.isInteger(km)||km<=0)throw new Error("Ingresá un kilometraje entero válido.");
    if(minimum&&km<minimum)throw new Error(`El kilometraje no puede ser menor al último registro (${minimum.toLocaleString("es-AR")} km).`);
    if(!photo)throw new Error("La foto inicial del tablero es obligatoria.");
    const late=Boolean(modalOptions.forClosure),expectedRevision=Number(currentRecord?.revision||0),kind=late?"late_start":"start";
    status.textContent="Preparando evidencia…";assertSessionToken(sessionToken,context?.user?.uid);const prepared=await prepareOperation({kind,km,vehicleId:context.vehicle.id,expectedRevision,expectedStatus:late?"late_start_pending_review":"tracking",file:photo});
    status.textContent="Subiendo foto…";uploaded=await uploadOperationPhoto(prepared);assertSessionToken(sessionToken,uploaded.driverUid);
    const incidents=late?[{incidentType:"late-start",alertStatus:"red",alertLabel:"INICIO REGISTRADO AL CERRAR",reason:"El kilometraje inicial fue registrado recién al momento del cierre."}]:[];
    const payload={schemaVersion:4,moduleVersion:VERSION,driverUid:context.user.uid,driverName:clean(context.profile?.nombre||context.profile?.nombreCompleto||"Chofer"),weeklyPeriodId:context.active.id,vehicleId:context.vehicle.id,startVehicleId:context.vehicle.id,vehiclePlate:context.label?.plate||"",startVehiclePlate:context.label?.plate||"",vehicleName:context.label?.name||"",startKm:km,startPhotoUrl:uploaded.url,startPhotoPath:uploaded.path,startPhotoHash:uploaded.photoHash,startPhotoSize:uploaded.size,startRecordedAt:serverTimestamp(),personalAllowanceKm:ALLOWANCE_KM,operationId:uploaded.operationId,operationFingerprint:uploaded.operationFingerprint,alertOutbox:await makeOutbox(incidents,uploaded.operationFingerprint)};
    assertSessionToken(sessionToken,uploaded.driverUid);await transactStart(payload,{late,expectedRevision});assertSessionToken(sessionToken,uploaded.driverUid);confirmEvidence(uploaded);
    await refreshContext();rememberConfirmedStart(currentRecord);await processRecordOutbox(currentRecord);
    if(late){status.className="mileage-status is-error";status.textContent="El inicio quedó registrado tarde. El cierre continuará marcado para revisión administrativa.";setTimeout(()=>closeModal(true),700)}
    else{clearStartGrace();status.className="mileage-status is-ok";status.textContent="Kilometraje inicial registrado.";setTimeout(()=>closeModal(true),350)}
  }catch(error){
    try{
      const resolution=await resolveCommitFailure(error,uploaded);
      if(resolution?.confirmed){await refreshContext();rememberConfirmedStart(currentRecord);await processRecordOutbox(currentRecord);status.className="mileage-status is-ok";status.textContent="El registro fue confirmado después de conciliar la conexión.";setTimeout(()=>closeModal(true),450);return}
    }catch(resolvedError){error=resolvedError}
    if(["MILEAGE_CONFLICT","MILEAGE_RECORD_FINALIZED","MILEAGE_ALREADY_STARTED"].includes(error?.code))await refreshContext().catch(err=>console.warn("MILEAGE_REFRESH_AFTER_CONFLICT_FAILED",err?.message));showRecoverableError(status,error)
  }finally{setBusy(false)}
}
async function historyAverage(){
  await ensureFirebase();
  let snap;
  try{snap=await getDocs(query(collection(db,COLLECTION),where("driverUid","==",context.user.uid),where("startVehicleId","==",clean(currentRecord?.startVehicleId||currentRecord?.vehicleId||context?.vehicle?.id)),orderBy("endRecordedAt","desc"),limit(12)))}
  catch(error){console.warn("MILEAGE_HISTORY_INDEX_FALLBACK",error?.code||error?.message);snap=await getDocs(query(collection(db,COLLECTION),where("driverUid","==",context.user.uid),limit(24)))}
  const targetVehicleId=clean(currentRecord?.startVehicleId||currentRecord?.vehicleId||context?.vehicle?.id);
  const rows=snap.docs.map(d=>d.data()).filter(r=>r.status==="finalized"&&num(r.revenuePerKm)>0&&r.weeklyPeriodId!==context.active.id&&(!targetVehicleId||clean(r.startVehicleId||r.vehicleId)===targetVehicleId)).sort((a,b)=>timestampMs(b.endRecordedAt||b.updatedAt)-timestampMs(a.endRecordedAt||a.updatedAt)).slice(0,4);
  return {average:rows.reduce((sum,row)=>sum+num(row.revenuePerKm),0)/(rows.length||1),count:rows.length};
}
async function weeklyRevenue(){
  const engine=window.ExploraCanonicalWeeklyClosure;
  if(!engine?.buildCanonicalWeeklyClosureSnapshot)throw Object.assign(new Error("El motor financiero todavía no está disponible. Reintentá en unos segundos."),{code:"MILEAGE_FINANCIAL_ENGINE_UNAVAILABLE"});
  const snapshot=await engine.buildCanonicalWeeklyClosureSnapshot(context.user.uid,context.active.id,{reason:"weekly-mileage-analysis"});
  if(!snapshot||clean(snapshot.weeklyPeriodId)!==clean(context.active.id))throw Object.assign(new Error("No se pudo confirmar la facturación de esta semana."),{code:"MILEAGE_FINANCIAL_SNAPSHOT_INVALID"});
  const gross=Number(snapshot.grossBilling);
  if(!Number.isFinite(gross)||gross<0)throw Object.assign(new Error("La facturación semanal devuelta por el cierre no es válida."),{code:"MILEAGE_FINANCIAL_GROSS_INVALID"});
  return {gross,snapshot};
}
function classify(current,average,count){if(!average||count<2)return {tone:"green",status:"baseline",label:"SEMANA BASE",drop:0,detail:"Esta semana servirá para construir el promedio histórico."};const drop=((average-current)/average)*100;if(drop>25)return {tone:"red",status:"red",label:"KILOMETRAJE PARA REVISAR",drop,detail:"El rendimiento por kilómetro está más de 25% por debajo del promedio reciente."};if(drop>10)return {tone:"yellow",status:"yellow",label:"ATENCIÓN: KILOMETRAJE ELEVADO",drop,detail:"El rendimiento por kilómetro está entre 10% y 25% por debajo del promedio reciente."};return {tone:"green",status:"green",label:"KILOMETRAJE COHERENTE",drop,detail:"Los kilómetros y la facturación están dentro del rango habitual."}}
async function calculateEnd(){
  const endKm=num($("mileageKmInput")?.value),photo=$("mileagePhotoInput")?.files?.[0],status=$("mileageStatus");
  if(operationBusy)return;setBusy(true,"CALCULANDO…");
  try{
    status.className="mileage-status";status.textContent="Calculando con la facturación real…";
    if(!currentRecord?.startKm)throw new Error("Falta el kilometraje inicial de esta semana.");
    if(!photo)throw new Error("La foto final del tablero es obligatoria.");
    const vehicleChanged=Boolean(currentRecord?.startVehicleId&&clean(currentRecord.startVehicleId)!==clean(context?.vehicle?.id));
    if(vehicleChanged){
      if(!Number.isInteger(endKm)||endKm<=0)throw new Error("Ingresá el kilometraje actual del vehículo asignado.");
      renderVehicleChangeResult({endKm,photo});
      return;
    }
    if(!Number.isInteger(endKm)||endKm<currentRecord.startKm)throw new Error("El kilometraje final no puede ser menor al inicial.");
    const totalKm=endKm-num(currentRecord.startKm);if(totalKm===0)throw new Error("El kilometraje final debe ser mayor al inicial.");
    const controlledKm=Math.max(0,totalKm-ALLOWANCE_KM);
    const [{gross,snapshot},{average,count}]=await Promise.all([weeklyRevenue(),historyAverage()]);
    const revenuePerKm=controlledKm>0?gross/controlledKm:0,result=classify(revenuePerKm,average,count);
    renderResult({endKm,totalKm,controlledKm,gross,revenuePerKm,average,count,result,photo,snapshot,vehicleChanged:false});
  }catch(error){showRecoverableError(status,error)}finally{setBusy(false)}
}

function renderVehicleChangeResult(data){
  const body=$("mileageBody");
  body.innerHTML=`<section class="mileage-result" data-tone="red"><small class="mileage-kicker">CAMBIO DE VEHÍCULO DETECTADO</small><h3>CONTROL MANUAL OBLIGATORIO</h3><p>El vehículo asignado al cierre es distinto al registrado al inicio. EXPLORA no mezclará odómetros de autos diferentes ni calculará kilómetros falsos.</p><dl><dt>Vehículo inicial</dt><dd>${escapeHtml(currentRecord?.startVehiclePlate||currentRecord?.vehiclePlate||"SIN PATENTE")}</dd><dt>Vehículo actual</dt><dd>${escapeHtml(context?.label?.plate||"SIN PATENTE")}</dd><dt>Odómetro actual</dt><dd>${num(data.endKm).toLocaleString("es-AR")} km</dd></dl><div class="mileage-warning">El cierre podrá continuar, pero quedará marcado para revisión administrativa y sin cálculo automático de rendimiento.</div></section><label class="mileage-field"><span>JUSTIFICACIÓN DEL CAMBIO</span><textarea id="mileageJustification" maxlength="500" placeholder="Indicá cuándo y por qué se cambió el vehículo."></textarea></label><div class="mileage-modal-actions"><button class="mileage-action" id="mileageConfirmVehicleChange" type="button">REGISTRAR CAMBIO Y CONTINUAR</button><button class="mileage-action secondary" id="mileageBackEnd" type="button">CORREGIR DATOS</button></div><div class="mileage-status" id="mileageStatus"></div>`;
  $("mileageBackEnd")?.addEventListener("click",()=>renderModal("end",{mandatory:true,forClosure:modalOptions.forClosure}));
  $("mileageConfirmVehicleChange")?.addEventListener("click",()=>saveVehicleChangeEnd(data));
}
async function saveVehicleChangeEnd(data){
  const sessionToken=captureSessionToken();assertSessionToken(sessionToken);
  const status=$("mileageStatus"),justification=clean($("mileageJustification")?.value),button=$("mileageConfirmVehicleChange");
  if(operationBusy)return;operationBusy=true;if(button)button.disabled=true;let uploaded=null;
  try{
    if(justification.length<8)throw new Error("Agregá una justificación breve del cambio de vehículo.");
    const expectedRevision=Number(currentRecord?.revision||0);
    status.textContent="Preparando evidencia…";assertSessionToken(sessionToken,context?.user?.uid);const prepared=await prepareOperation({kind:"vehicle_change_end",km:data.endKm,vehicleId:context.vehicle.id,expectedRevision,justification,expectedStatus:"finalized_review_required",file:data.photo});
    status.textContent="Subiendo evidencia…";uploaded=await uploadOperationPhoto(prepared);assertSessionToken(sessionToken,uploaded.driverUid);status.textContent="Registrando cambio…";
    const incidents=[{incidentType:"vehicle-change",alertStatus:"red",alertLabel:"CAMBIO DE VEHÍCULO · REVISIÓN MANUAL",reason:"Cambio de vehículo durante la semana.",startVehicleId:currentRecord?.startVehicleId||"",startVehiclePlate:currentRecord?.startVehiclePlate||currentRecord?.vehiclePlate||"",endVehicleId:context.vehicle.id,endVehiclePlate:context.label?.plate||"",driverJustification:justification}];
    assertSessionToken(sessionToken,uploaded.driverUid);await transactFinalize({driverUid:context.user.uid,weeklyPeriodId:context.active.id,endVehicleId:context.vehicle.id,endVehiclePlate:context.label?.plate||"",vehicleChangedDuringWeek:true,endKm:data.endKm,endPhotoUrl:uploaded.url,endPhotoPath:uploaded.path,endPhotoHash:uploaded.photoHash,endPhotoSize:uploaded.size,endRecordedAt:serverTimestamp(),totalKm:null,controlledKm:null,weeklyGrossRevenue:null,revenuePerKm:null,alertStatus:"red",alertLabel:"CAMBIO DE VEHÍCULO · REVISIÓN MANUAL",driverJustification:justification,adminReviewRequired:true,reviewedByAdmin:false,status:"finalized_review_required",calculatedFromCanonicalClosure:false,operationId:uploaded.operationId,operationFingerprint:uploaded.operationFingerprint,alertOutbox:await makeOutbox(incidents,uploaded.operationFingerprint)},{expectedRevision});
    assertSessionToken(sessionToken,uploaded.driverUid);finishMileageCommitFast({status,uploaded,sessionToken,message:"Cambio registrado para revisión."});
  }catch(error){
    try{const resolution=await resolveCommitFailure(error,uploaded);if(resolution?.confirmed){finishMileageCommitFast({status,uploaded,sessionToken,message:"El cambio fue confirmado después de conciliar la conexión."});return}}catch(resolvedError){error=resolvedError}
    showRecoverableError(status,error)
  }finally{operationBusy=false;if(button)button.disabled=false}
}

function renderResult(data){const body=$("mileageBody");body.innerHTML=`<section class="mileage-result" data-tone="${data.result.tone}"><small class="mileage-kicker">RESULTADO DEL CONTROL</small><h3>${escapeHtml(data.result.label)}</h3><p>${escapeHtml(data.result.detail)}</p><dl><dt>Kilómetros recorridos</dt><dd>${data.totalKm.toLocaleString("es-AR")} km</dd><dt>Uso personal permitido</dt><dd>${ALLOWANCE_KM} km</dd><dt>Kilómetros controlados</dt><dd>${data.controlledKm.toLocaleString("es-AR")} km</dd><dt>Facturación semanal</dt><dd>${money(data.gross)}</dd><dt>Rendimiento actual</dt><dd>${money(data.revenuePerKm)}/km</dd><dt>Promedio histórico</dt><dd>${data.count>=2?`${money(data.average)}/km`:"En construcción"}</dd></dl>${data.result.status==="red"?'<div class="mileage-warning">Este registro quedará marcado y visible para el administrador.</div>':""}</section>${data.result.status!=="green"&&data.result.status!=="baseline"?'<label class="mileage-field"><span>JUSTIFICACIÓN DEL CHOFER</span><textarea id="mileageJustification" maxlength="500" placeholder="Combustible, lavadero, taller, búsqueda de pasajero, traslado autorizado u otro motivo."></textarea></label>':""}<div class="mileage-modal-actions"><button class="mileage-action" id="mileageConfirmEnd" type="button">REGISTRAR Y CONTINUAR</button><button class="mileage-action secondary" id="mileageBackEnd" type="button">CORREGIR DATOS</button></div><div class="mileage-status" id="mileageStatus"></div>`;$("mileageBackEnd").addEventListener("click",()=>renderModal("end",{...modalOptions,mandatory:true}));$("mileageConfirmEnd").addEventListener("click",()=>saveEnd(data))}
async function saveEnd(data){
  const sessionToken=captureSessionToken();assertSessionToken(sessionToken);
  const status=$("mileageStatus"),justification=clean($("mileageJustification")?.value);
  if(operationBusy)return;operationBusy=true;const confirm=$("mileageConfirmEnd"),back=$("mileageBackEnd");if(confirm)confirm.disabled=true;if(back)back.disabled=true;let uploaded=null;
  try{
    if(["yellow","red"].includes(data.result.status)&&justification.length<8)throw new Error("Agregá una justificación breve antes de continuar.");
    if(!context?.vehicle||!context?.ref)throw new Error("No se pudo confirmar el vehículo del cierre.");
    const expectedRevision=Number(currentRecord?.revision||0);
    status.textContent="Preparando evidencia…";assertSessionToken(sessionToken,context?.user?.uid);const prepared=await prepareOperation({kind:"end",km:data.endKm,vehicleId:context.vehicle.id,expectedRevision,justification,expectedStatus:"finalized",file:data.photo});
    status.textContent="Subiendo foto…";uploaded=await uploadOperationPhoto(prepared);assertSessionToken(sessionToken,uploaded.driverUid);status.textContent="Guardando control…";
    const vehicleChanged=Boolean(currentRecord?.startVehicleId&&currentRecord.startVehicleId!==context.vehicle.id);
    const incidents=[];if(data.result.status==="red"||vehicleChanged)incidents.push({incidentType:vehicleChanged?"vehicle-change":"performance",alertStatus:data.result.status,alertLabel:data.result.label,totalKm:data.totalKm,weeklyGrossRevenue:data.gross,revenuePerKm:Math.round(data.revenuePerKm*100)/100,driverJustification:justification,vehicleChangedDuringWeek:vehicleChanged});
    assertSessionToken(sessionToken,uploaded.driverUid);await transactFinalize({driverUid:context.user.uid,weeklyPeriodId:context.active.id,endVehicleId:context.vehicle.id,endVehiclePlate:context.label?.plate||"",vehicleChangedDuringWeek:vehicleChanged,endKm:data.endKm,endPhotoUrl:uploaded.url,endPhotoPath:uploaded.path,endPhotoHash:uploaded.photoHash,endPhotoSize:uploaded.size,endRecordedAt:serverTimestamp(),totalKm:data.totalKm,personalAllowanceKm:ALLOWANCE_KM,controlledKm:data.controlledKm,weeklyGrossRevenue:data.gross,revenuePerKm:Math.round(data.revenuePerKm*100)/100,previousAverageRevenuePerKm:Math.round(data.average*100)/100,historyWeekCount:data.count,performanceDifferencePercent:data.average?Math.round(((data.revenuePerKm-data.average)/data.average)*10000)/100:0,alertStatus:data.result.status,alertLabel:data.result.label,driverJustification:justification,adminReviewRequired:incidents.length>0,reviewedByAdmin:false,status:"finalized",calculatedFromCanonicalClosure:true,operationId:uploaded.operationId,operationFingerprint:uploaded.operationFingerprint,alertOutbox:await makeOutbox(incidents,uploaded.operationFingerprint)},{expectedRevision});
    assertSessionToken(sessionToken,uploaded.driverUid);finishMileageCommitFast({status,uploaded,sessionToken,message:"Control de kilometraje registrado."});
  }catch(error){
    try{const resolution=await resolveCommitFailure(error,uploaded);if(resolution?.confirmed){finishMileageCommitFast({status,uploaded,sessionToken,message:"El cierre fue confirmado después de conciliar la conexión."});return}}catch(resolvedError){error=resolvedError}
    showRecoverableError(status,error)
  }finally{operationBusy=false;if(confirm)confirm.disabled=false;if(back)back.disabled=false}
}
function renderModal(mode,options={}){const body=$("mileageBody");if(context?.technicalError||context?.errorCode==="MILEAGE_RECORD_READ_FAILED"){body.innerHTML=`<div class="mileage-note">${escapeHtml(context?.error||"No fue posible verificar el registro existente.")}</div><div class="mileage-modal-actions"><button class="mileage-action secondary" id="mileageReadRetry" type="button">REINTENTAR</button>${options.forClosure?'<button class="mileage-action secondary" id="mileageReadSafeExit" type="button">CONTINUAR CIERRE CON CONTROL PENDIENTE</button>':""}</div>`;$("mileageReadRetry")?.addEventListener("click",async()=>{await activatePeriodContext(context?.active?.id||closureTargetPeriod());renderModal(mode,options)});$("mileageReadSafeExit")?.addEventListener("click",async()=>{await registerCentralPending(context.technicalError||{code:"MILEAGE_RECORD_READ_FAILED",message:context.error},{incidenceType:"record-read-failure"});closeModal(true)});$("mileageClose").hidden=false;return}if(!context?.vehicle){body.innerHTML=`<div class="mileage-note">${escapeHtml(context?.error||"No se pudo identificar el vehículo asignado.")}</div><button class="mileage-action secondary" id="mileageNoVehicleExit" type="button">${options.forClosure?"CONTINUAR CIERRE CON CONTROL PENDIENTE":"CERRAR"}</button>`;$("mileageNoVehicleExit")?.addEventListener("click",async()=>{if(options.forClosure)await registerCentralPending({code:context?.errorCode||"MILEAGE_VEHICLE_UNAVAILABLE",message:context?.error||"Vehículo no disponible"});closeModal(Boolean(options.forClosure))});$("mileageClose").hidden=false;return}if(mode==="view"){body.innerHTML=renderRecordDetail();$("mileageDetailClose")?.addEventListener("click",()=>closeModal(false));$("mileageClose").hidden=false;return}const start=mode==="start",minimum=start?lastKnownKm():num(currentRecord?.startKm);body.innerHTML=`<div class="mileage-intro"><p>${start?"Registrá el kilometraje actual y una foto del tablero para iniciar el control semanal.":"Registrá el kilometraje final y una foto del tablero para completar el control semanal."}</p><div class="mileage-allowance"><span>USO PERSONAL PERMITIDO</span><strong>${ALLOWANCE_KM} km esta semana</strong></div></div><label class="mileage-field mileage-km-field"><span>${start?"KILOMETRAJE ACTUAL":"KILOMETRAJE FINAL"}</span><input id="mileageKmInput" inputmode="numeric" type="number" min="${minimum}" step="1" placeholder="Ej.: 125000"><small>Ingresá el valor exacto que muestra el tablero.</small></label><div class="mileage-photo"><div class="mileage-photo-heading"><div><strong>FOTO DEL TABLERO</strong><span>Obligatoria</span></div><label class="mileage-photo-button" for="mileagePhotoInput">TOMAR FOTO</label></div><input class="mileage-photo-input" id="mileagePhotoInput" accept="image/*" capture="environment" type="file"><div class="mileage-preview-shell"><div id="mileagePreviewEmpty" class="mileage-preview-empty"><span>Sin foto todavía</span><small>La imagen debe mostrar claramente el kilometraje.</small></div><img class="mileage-preview" id="mileagePreview" hidden alt="Vista previa del tablero"></div><div class="mileage-photo-name" id="mileagePhotoName">Todavía no seleccionaste una foto</div></div><div class="mileage-form-helper" id="mileageFormHelper">Ingresá el kilometraje exacto que muestra el tablero.</div><button class="mileage-action" id="mileageSaveBtn" type="button" disabled>${start?"ACTIVAR SEGUIMIENTO":"ANALIZAR KILOMETRAJE"}</button>${options.mandatory?"":'<button class="mileage-action secondary" id="mileageCancelBtn" type="button">AHORA NO</button>'}<div class="mileage-status" id="mileageStatus"></div>`;$("mileageKmInput").addEventListener("input",syncMileageFormState);$("mileagePhotoInput").addEventListener("change",event=>filePreview(event.target,$("mileagePreview")));$("mileageSaveBtn").addEventListener("click",start?saveStart:calculateEnd);$("mileageCancelBtn")?.addEventListener("click",()=>closeModal(false));syncMileageFormState();$("mileageClose").hidden=Boolean(options.mandatory)}
function mileageUiState(record=currentRecord){
  const status=clean(record?.status);
  const late=status==="late_start_pending_review";
  const review=status==="finalized_review_required"||late||record?.adminReviewRequired===true;
  const completed=status==="finalized"||status==="finalized_review_required";
  return {status,late,review,completed,finalized:completed||late};
}
function renderRecordDetail(){
  if(!currentRecord)return '<div class="mileage-note">Todavía no hay un registro de kilometraje para esta semana.</div>';
  const ui=mileageUiState();
  if(ui.late){
    return `<section class="mileage-result" data-tone="red"><small class="mileage-kicker">CONTROL INCOMPLETO</small><h3>PENDIENTE DE REVISIÓN</h3><div class="mileage-note">El kilometraje inicial fue registrado al momento del cierre. No existe un recorrido semanal validable para calcular kilómetros ni rendimiento.</div><dl><dt>Vehículo</dt><dd>${escapeHtml(currentRecord.vehiclePlate||context.label?.plate||"SIN PATENTE")}</dd><dt>Inicio registrado</dt><dd>${num(currentRecord.startKm).toLocaleString("es-AR")} km</dd><dt>Estado</dt><dd>Revisión administrativa requerida</dd></dl></section><button class="mileage-action secondary" id="mileageDetailClose" type="button">CERRAR</button>`;
  }
  return `<section class="mileage-result" data-tone="${currentRecord.alertStatus==="red"?"red":currentRecord.alertStatus==="yellow"?"yellow":"green"}"><small class="mileage-kicker">${ui.completed?"CONTROL COMPLETADO":"SEGUIMIENTO ACTIVO"}</small><h3>${escapeHtml(ui.completed?currentRecord.alertLabel||"KILOMETRAJE REGISTRADO":"SEMANA EN SEGUIMIENTO")}</h3><dl><dt>Vehículo</dt><dd>${escapeHtml(currentRecord.vehiclePlate||context.label?.plate||"SIN PATENTE")}</dd><dt>Kilometraje inicial</dt><dd>${num(currentRecord.startKm).toLocaleString("es-AR")} km</dd>${ui.completed?`<dt>Kilometraje final</dt><dd>${num(currentRecord.endKm).toLocaleString("es-AR")} km</dd><dt>Total recorrido</dt><dd>${num(currentRecord.totalKm).toLocaleString("es-AR")} km</dd><dt>Rendimiento</dt><dd>${money(currentRecord.revenuePerKm)}/km</dd>`:`<dt>Uso personal permitido</dt><dd>${ALLOWANCE_KM} km</dd>`}</dl></section><button class="mileage-action secondary" id="mileageDetailClose" type="button">CERRAR</button>`
}
function renderCards(){
  ensureUi();let card=$("mileageDashboardCard");
  if(!card){card=document.createElement("section");card.id="mileageDashboardCard";card.className="mileage-dashboard-card";const anchor=$("profilePendingClosureBtn")?.parentElement||document.querySelector("main")||document.body;anchor.insertAdjacentElement("afterend",card);card.addEventListener("click",()=>openModal("view"))}
  if(!context||!isDriver()){card.hidden=true;return}
  card.hidden=false;const ui=mileageUiState(),started=Boolean(currentRecord?.startKm);
  const grace=!started?startGraceState():null;
  const pill=ui.late?"INCOMPLETO":ui.completed?(ui.review?"REVISAR":"COMPLETADO"):started?"ACTIVO":grace?.overdue?"VENCIDO":"PENDIENTE";
  const remainingMinutes=grace?Math.ceil(grace.remainingMs/60000):0;
  const graceText=grace?.overdue?"El plazo de 2 horas venció. Debés registrar kilometraje y foto antes de cargar un nuevo servicio.":`Podés seguir consultando la app, pero antes del primer servicio debés registrar kilometraje y foto. Plazo restante aproximado: ${Math.max(0,remainingMinutes)} min.`;
  const summary=ui.late?"Inicio registrado al cerrar · pendiente de revisión administrativa":ui.completed?`${num(currentRecord.totalKm).toLocaleString("es-AR")} km recorridos · ${money(currentRecord.revenuePerKm)}/km`:started?`Inicio: ${num(currentRecord.startKm).toLocaleString("es-AR")} km · ${ALLOWANCE_KM} km personales permitidos`:graceText;
  card.innerHTML=`<header><div><small>CONTROL DE KILOMETRAJE</small><strong>${escapeHtml(context.label?.plate||"SIN VEHÍCULO")} · ${escapeHtml(context.active?.id||"SEMANA NO DISPONIBLE")}</strong></div><span class="mileage-pill ${!started?"is-pending":ui.review?"is-alert":""}">${pill}</span></header><p>${summary}</p>`;injectClosureCard()
}
function renderInlineMileageFollowup(){
  if(!currentRecord)return '<div class="mileage-inline-empty">Todavía no hay un registro confirmado para esta semana.</div>';
  const ui=mileageUiState();
  const startAt=formatDateTime(currentRecord.startRecordedAt||currentRecord.createdAt||currentRecord.updatedAt);
  const endAt=formatDateTime(currentRecord.endRecordedAt||currentRecord.updatedAt);
  const startPhoto=clean(currentRecord.startPhotoUrl);
  const endPhoto=clean(currentRecord.endPhotoUrl);
  return `<div class="mileage-inline-followup" id="mileageInlineFollowup">
    <div class="mileage-inline-row"><span>Vehículo</span><b>${escapeHtml(currentRecord.vehiclePlate||context?.label?.plate||"SIN PATENTE")}</b></div>
    <div class="mileage-inline-row"><span>Kilometraje inicial</span><b>${num(currentRecord.startKm).toLocaleString("es-AR")} km</b></div>
    <div class="mileage-inline-row"><span>Registrado</span><b>${escapeHtml(startAt||"Fecha no disponible")}</b></div>
    ${ui.completed?`<div class="mileage-inline-row"><span>Kilometraje final</span><b>${num(currentRecord.endKm).toLocaleString("es-AR")} km</b></div><div class="mileage-inline-row"><span>Cierre registrado</span><b>${escapeHtml(endAt||"Fecha no disponible")}</b></div><div class="mileage-inline-row"><span>Total recorrido</span><b>${num(currentRecord.totalKm).toLocaleString("es-AR")} km</b></div>`:'<div class="mileage-inline-row"><span>Estado</span><b>Semana en seguimiento</b></div>'}
    <div class="mileage-inline-actions">${startPhoto?`<a href="${escapeHtml(startPhoto)}" target="_blank" rel="noopener">VER FOTO INICIAL</a>`:""}${endPhoto?`<a href="${escapeHtml(endPhoto)}" target="_blank" rel="noopener">VER FOTO FINAL</a>`:""}</div>
  </div>`;
}
function injectClosureCard(){
  const content=$("weeklyClosureContent");if(!content||!context)return;let card=$("mileageClosureCard");
  const wasExpanded=Boolean(card?.classList.contains("is-expanded"));
  if(!card){card=document.createElement("section");card.id="mileageClosureCard";card.className="mileage-closure-card";const target=$("weeklyClosureLiveState")||content.firstElementChild;target?.insertAdjacentElement("afterend",card)}
  const ui=mileageUiState();
  const heading=ui.late?"CONTROL INCOMPLETO · REVISAR":ui.completed?escapeHtml(currentRecord.alertLabel||"CONTROL COMPLETADO"):currentRecord?.startKm?"SEMANA EN SEGUIMIENTO":"REGISTRO INICIAL PENDIENTE";
  const details=ui.late?`<div><span>Inicio registrado</span><b>${num(currentRecord.startKm).toLocaleString("es-AR")} km</b></div><div><span>Resultado</span><b>Pendiente de revisión</b></div>`:ui.completed?`<div><span>Total recorrido</span><b>${num(currentRecord.totalKm).toLocaleString("es-AR")} km</b></div><div><span>Rendimiento</span><b>${money(currentRecord.revenuePerKm)}/km</b></div>`:"";
  const started=Boolean(currentRecord?.startKm);
  const buttonLabel=ui.finalized?"VER CONTROL":started?"VER SEGUIMIENTO":"REGISTRAR KILOMETRAJE";
  const helper=!ui.finalized&&started?'<p class="mileage-closure-helper">El kilometraje final se solicitará únicamente al confirmar el cierre semanal.</p>':"";
  card.innerHTML=`<small class="mileage-kicker">SEGUIMIENTO DE KILOMETRAJE</small><h3>${heading}</h3><div class="mileage-closure-grid"><div><span>Inicio semanal</span><b>${started?`${num(currentRecord.startKm).toLocaleString("es-AR")} km`:"Pendiente"}</b></div><div><span>Uso personal permitido</span><b>${ALLOWANCE_KM} km</b></div>${details}</div>${helper}<button class="mileage-action secondary" type="button" id="mileageClosureOpen" data-mileage-closure-action="${ui.finalized||started?"view":"start"}" aria-expanded="${wasExpanded?"true":"false"}">${buttonLabel}</button><div id="mileageClosureInlineDetail" ${wasExpanded&&started?"":"hidden"}>${wasExpanded&&started?renderInlineMileageFollowup():""}</div>`;
  if(wasExpanded&&started)card.classList.add("is-expanded");
  const openButton=$("mileageClosureOpen");
  if(openButton){
    openButton.onclick=event=>{
      event.preventDefault();
      event.stopPropagation();
      handleClosureMileageOpen(openButton.dataset.mileageClosureAction||"view",openButton);
    };
  }
}
async function handleClosureMileageOpen(action="view",button=null){
  if(action==="start"&&!currentRecord?.startKm){
    return await openModal("start",{mandatory:false,forClosure:false,source:"closure-summary"});
  }
  const card=$("mileageClosureCard"),detail=$("mileageClosureInlineDetail");
  if(!card||!detail)return false;
  const shouldOpen=detail.hidden;
  detail.hidden=!shouldOpen;
  card.classList.toggle("is-expanded",shouldOpen);
  if(button){button.setAttribute("aria-expanded",shouldOpen?"true":"false");button.textContent=shouldOpen?"OCULTAR SEGUIMIENTO":(mileageUiState().finalized?"VER CONTROL":"VER SEGUIMIENTO")}
  if(shouldOpen){
    detail.innerHTML=renderInlineMileageFollowup();
    detail.scrollIntoView({behavior:"smooth",block:"nearest"});
  }else detail.innerHTML="";
  return true;
}
function startGraceKey(){
  const uid=clean(context?.user?.uid||auth?.currentUser?.uid);
  const periodId=clean(context?.active?.id);
  return uid&&periodId?`explora:mileage-start-grace:${uid}:${periodId}`:"";
}
function ensureStartGraceStarted(){
  if(!context||!isDriver()||currentRecord?.startKm)return 0;
  const key=startGraceKey();if(!key)return 0;
  let started=Number(localStorage.getItem(key)||0);
  if(!(started>0)){started=Date.now();try{localStorage.setItem(key,String(started))}catch(_){}}
  return started;
}
function startGraceState(){
  if(currentRecord?.startKm)return {required:false,overdue:false,remainingMs:0,startedAt:0};
  const startedAt=ensureStartGraceStarted();
  const elapsed=Math.max(0,Date.now()-startedAt);
  return {required:true,overdue:elapsed>=START_GRACE_MS,remainingMs:Math.max(0,START_GRACE_MS-elapsed),startedAt};
}
function clearStartGrace(){const key=startGraceKey();if(key)try{localStorage.removeItem(key)}catch(_){}}
function startConfirmationKey(uid=context?.user?.uid||auth?.currentUser?.uid,periodId=context?.active?.id){
  const owner=clean(uid),week=clean(periodId);return owner&&week?`explora:mileage-start-confirmed:${owner}:${week}`:"";
}
function rememberConfirmedStart(record=currentRecord){
  const key=startConfirmationKey(record?.driverUid,record?.weeklyPeriodId);if(!key||!record?.startKm)return;
  try{localStorage.setItem(key,JSON.stringify({driverUid:record.driverUid,weeklyPeriodId:record.weeklyPeriodId,startKm:num(record.startKm),revision:Number(record.revision||1),savedAt:Date.now()}))}catch(_){}
}
function hasConfirmedStartMarker(){const key=startConfirmationKey();if(!key)return false;try{const data=JSON.parse(localStorage.getItem(key)||"null");return Boolean(data&&clean(data.driverUid)===clean(context?.user?.uid)&&clean(data.weeklyPeriodId)===clean(context?.active?.id)&&num(data.startKm)>0)}catch(_){return false}}
async function ensureStartPrompt(){
  return startMileageReminder({showWhenReady:true});
}
async function ensureMileageBeforeBilling(){
  // Compatibilidad con llamadas antiguas: nunca bloquea Registrar cobro.
  // La verificación y el recordatorio continúan en segundo plano.
  if(isDriver())startMileageReminder({showWhenReady:false}).catch(error=>console.warn("MILEAGE_BACKGROUND_REFRESH",error));
  return true;
}
function closureTargetPeriod(){
  const state=window.ExploraWeeklyClosure?.getState?.()||window.ExploraClosureState||{};
  return clean(state.weeklyPeriodId||state.statusData?.weeklyPeriodId||state.statusData?.closure?.weeklyPeriodId||state.closure?.weeklyPeriodId||"");
}

async function waitClosureTargetPeriod(timeoutMs=3000){
  const started=Date.now();
  while(Date.now()-started<timeoutMs){
    const value=closureTargetPeriod();
    if(value)return value;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  return "";
}
function continueClosureSubmit(){
  bypassSubmit=true;
  queueMicrotask(()=>{
    const form=$("weeklyReceiptForm");
    form?.requestSubmit?.($("weeklyClosureSubmitBtn"));
    setTimeout(()=>{bypassSubmit=false;refreshContext().catch(()=>{})},0);
  });
}
function continueClosureAcknowledgement(button){
  bypassSubmit=true;
  queueMicrotask(()=>{button?.click?.();setTimeout(()=>{bypassSubmit=false;refreshContext().catch(()=>{})},0)});
}
const closureCompleteStatuses=new Set(["finalized","finalized_review_required","late_start_pending_review"]);
async function requireMileageForClosure(){const targetPeriod=closureTargetPeriod();await activatePeriodContext(targetPeriod);if(currentRecord?.startKm&&closureCompleteStatuses.has(currentRecord?.status))return true;return await openModal(currentRecord?.startKm?"end":"start",{mandatory:true,forClosure:true});}
async function interceptClosureSubmit(event){
  if(bypassSubmit||!isDriver())return;
  event.preventDefault();event.stopImmediatePropagation();
  try{
    const targetPeriod=await waitClosureTargetPeriod();
    if(!targetPeriod){await registerCentralPending({code:"MILEAGE_CLOSURE_PERIOD_UNAVAILABLE",message:"El cierre no informó una semana válida."});continueClosureSubmit();return}
    await activatePeriodContext(targetPeriod);
    let ok=Boolean(currentRecord?.startKm&&closureCompleteStatuses.has(currentRecord?.status));
    if(!ok)ok=await openModal(currentRecord?.startKm?"end":"start",{mandatory:true,forClosure:true});
    if(ok)continueClosureSubmit();
  }catch(error){
    await registerCentralPending(error,{code:error?.code||"MILEAGE_CLOSURE_INTERCEPT_FAILED",message:error?.message||"Falló el control de kilometraje al cerrar."});
    continueClosureSubmit();
  }
}
async function interceptAcknowledgement(event){
  if(bypassSubmit||!isDriver())return;
  event.preventDefault();event.stopImmediatePropagation();
  const button=event.target?.closest?.("#weeklyClosureAcknowledgementBtn");
  try{
    const targetPeriod=await waitClosureTargetPeriod();
    if(!targetPeriod){await registerCentralPending({code:"MILEAGE_CLOSURE_PERIOD_UNAVAILABLE",message:"El cierre no informó una semana válida."});continueClosureAcknowledgement(button);return}
    await activatePeriodContext(targetPeriod);
    let ok=Boolean(currentRecord?.startKm&&closureCompleteStatuses.has(currentRecord?.status));
    if(!ok)ok=await openModal(currentRecord?.startKm?"end":"start",{mandatory:true,forClosure:true});
    if(ok)continueClosureAcknowledgement(button);
  }catch(error){
    await registerCentralPending(error,{code:error?.code||"MILEAGE_ACK_INTERCEPT_FAILED",message:error?.message||"Falló el control de kilometraje al confirmar."});
    continueClosureAcknowledgement(button);
  }
}

async function markMileageAlertReviewed({alertId,mileageRecordId="",incidentKey="",incidentType="",synthetic=false,resolution="Revisado por administración"}={}){
  if(!alertId||!db)throw mileageError("MILEAGE_ALERT_ID_MISSING","No se pudo identificar la incidencia.");
  const alertRef=doc(db,"weekly_mileage_alerts",alertId);
  let recordIdValue=clean(mileageRecordId);
  if(!recordIdValue){const initial=await getDoc(alertRef);if(initial.exists())recordIdValue=clean(initial.data()?.mileageRecordId)}
  if(!recordIdValue&&!synthetic)throw mileageError("MILEAGE_ALERT_MISSING","La alerta todavía no se sincronizó o ya no existe.");
  const recordRef=recordIdValue?doc(db,COLLECTION,recordIdValue):null;
  const pendingSnap=recordIdValue?await getDocs(query(collection(db,"weekly_mileage_alerts"),where("mileageRecordId","==",recordIdValue),limit(100))):null;
  const pendingRefs=(pendingSnap?.docs||[]).filter(item=>item.id!==alertId).map(item=>item.ref);
  await runTransaction(db,async tx=>{
    const alertSnap=await tx.get(alertRef);
    const recordSnap=recordRef?await tx.get(recordRef):null;
    const otherSnaps=[];for(const ref of pendingRefs)otherSnaps.push(await tx.get(ref));
    const adminUid=auth?.currentUser?.uid||"";
    const existingAlert=alertSnap.exists()?alertSnap.data():null;
    const record=recordSnap?.exists()?recordSnap.data():null;
    if(!existingAlert&&!record)throw mileageError("MILEAGE_ALERT_MISSING","La incidencia ya no existe.");
    const finalAlready=FINAL_ALERT_STATES.has(clean(existingAlert?.status));
    const resolvedAlert={
      ...(existingAlert||{}),
      alertId,
      mileageRecordId:recordIdValue,
      incidentKey:clean(existingAlert?.incidentKey||incidentKey),
      incidentType:clean(existingAlert?.incidentType||incidentType),
      status:"reviewed",reviewed:true,reviewStatus:"reviewed",
      reviewedByUid:existingAlert?.reviewedByUid||adminUid,
      reviewedAt:existingAlert?.reviewedAt||serverTimestamp(),
      resolution:existingAlert?.resolution||resolution,
      alertRevision:Number(existingAlert?.alertRevision||0)+(finalAlready?0:1),
      updatedAt:serverTimestamp(),createdAt:existingAlert?.createdAt||serverTimestamp()
    };
    if(!finalAlready||!alertSnap.exists())tx.set(alertRef,resolvedAlert,{merge:true});
    if(recordRef&&record){
      const outbox={...(record.alertOutbox||{})};
      for(const [kind,item] of Object.entries(outbox)){
        const matches=clean(item?.alertId)===alertId||Boolean(incidentKey&&clean(item?.incidentKey)===clean(incidentKey));
        if(matches)outbox[kind]={...item,status:"reviewed",reviewedAt:serverTimestamp(),reviewedByUid:adminUid,resolution};
      }
      const otherPending=otherSnaps.filter(snap=>snap.exists()&&!FINAL_ALERT_STATES.has(clean(snap.data()?.status))).map(snap=>snap.data());
      const hasPending=pendingReviewRequired(otherPending,outbox);
      tx.set(recordRef,{alertOutbox:outbox,adminReviewRequired:hasPending,reviewedByAdmin:!hasPending,reviewStatus:hasPending?"pending":"reviewed",lastReviewedAlertId:alertId,reviewedAt:serverTimestamp(),reviewedByUid:adminUid,updatedAt:serverTimestamp()},{merge:true});
    }
  });
  await renderAdminAlerts();
}

function ensureAdminMileagePanel(){
  let overlay=$("mileageAdminOverlay");
  if(overlay)return overlay;
  overlay=document.createElement("div");
  overlay.id="mileageAdminOverlay";
  overlay.className="mileage-overlay";
  overlay.hidden=true;
  overlay.innerHTML=`<section class="mileage-modal mileage-admin-modal" role="dialog" aria-modal="true" aria-labelledby="mileageAdminTitle"><header><div><small class="mileage-kicker">EXPLORA · PANEL ADMINISTRATIVO</small><h2 id="mileageAdminTitle">CONTROL DE KILOMETRAJE</h2></div><button type="button" id="mileageAdminClose" aria-label="Cerrar">×</button></header><div class="mileage-body" id="mileageAdminBody"></div></section>`;
  document.body.appendChild(overlay);
  $("mileageAdminClose")?.addEventListener("click",closeAdminMileagePanel);
  overlay.addEventListener("click",event=>{if(event.target===overlay)closeAdminMileagePanel()});
  return overlay;
}
function closeAdminMileagePanel(){
  const overlay=$("mileageAdminOverlay");
  if(overlay)overlay.hidden=true;
  document.body.style.overflow="";
}
function adminRecordStatus(record){
  if(record?.adminReviewRequired)return {label:"REVISAR",tone:"is-alert"};
  if(record?.endKm||record?.status==="completed"||record?.status==="finalized")return {label:"COMPLETADO",tone:""};
  if(record?.startKm)return {label:"EN CURSO",tone:"is-pending"};
  return {label:"PENDIENTE",tone:"is-pending"};
}
async function openAdminMileagePanel(){
  if(!isAdmin())return;
  await ensureFirebase();
  const overlay=ensureAdminMileagePanel(),body=$("mileageAdminBody");
  overlay.hidden=false;
  document.body.style.overflow="hidden";
  body.innerHTML='<div class="mileage-note">Cargando controles de kilometraje…</div>';
  try{
    let snap;
    try{snap=await getDocs(query(collection(db,COLLECTION),orderBy("updatedAt","desc"),limit(100)))}
    catch(_){snap=await getDocs(query(collection(db,COLLECTION),limit(100)))}
    const rows=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>timestampMs(b.updatedAt||b.createdAt)-timestampMs(a.updatedAt||a.createdAt));
    if(!rows.length){body.innerHTML='<div class="mileage-note">Todavía no hay controles de kilometraje registrados.</div>';return}
    body.innerHTML=`<div class="mileage-admin-summary"><b>${rows.length}</b><span>controles encontrados</span></div><div class="mileage-admin-records">${rows.map(row=>{const status=adminRecordStatus(row);const start=num(row.startKm),end=num(row.endKm),total=num(row.totalKm);return `<article class="mileage-admin-record"><header><div><b>${escapeHtml(row.driverName||row.driverUid||"Chofer")}</b><small>${escapeHtml(row.vehiclePlate||"SIN PATENTE")} · ${escapeHtml(row.weeklyPeriodId||"SEMANA SIN IDENTIFICAR")}</small></div><span class="mileage-pill ${status.tone}">${status.label}</span></header><dl><dt>Inicio</dt><dd>${start?`${start.toLocaleString("es-AR")} km`:"Pendiente"}</dd><dt>Final</dt><dd>${end?`${end.toLocaleString("es-AR")} km`:"Pendiente"}</dd><dt>Recorrido</dt><dd>${total?`${total.toLocaleString("es-AR")} km`:"—"}</dd><dt>Facturación</dt><dd>${money(row.weeklyGrossRevenue||0)}</dd></dl><div class="mileage-admin-actions">${row.startPhotoUrl?`<a class="mileage-admin-link" href="${escapeHtml(row.startPhotoUrl)}" target="_blank" rel="noopener">FOTO INICIAL</a>`:""}${row.endPhotoUrl?`<a class="mileage-admin-link" href="${escapeHtml(row.endPhotoUrl)}" target="_blank" rel="noopener">FOTO FINAL</a>`:""}</div></article>`}).join("")}</div>`;
  }catch(error){
    body.innerHTML=`<div class="mileage-note">No se pudieron cargar los controles: ${escapeHtml(error?.message||"Revisá los permisos de Firebase.")}</div>`;
  }
}
function makeAdminMileageCardInteractive(card){
  if(!card||card.dataset.interactive==="true")return;
  card.dataset.interactive="true";
  card.setAttribute("role","button");
  card.setAttribute("tabindex","0");
  card.setAttribute("aria-label","Abrir controles de kilometraje");
  card.addEventListener("click",event=>{
    if(event.target.closest("a,button"))return;
    openAdminMileagePanel();
  });
  card.addEventListener("keydown",event=>{
    if(event.key==="Enter"||event.key===" "){event.preventDefault();openAdminMileagePanel()}
  });
}

async function renderAdminAlerts(){
  if(!isAdmin())return;
  await ensureFirebase();
  let card=$("mileageAdminAlertsCard");
  if(!card){card=document.createElement("section");card.id="mileageAdminAlertsCard";card.className="mileage-dashboard-card mileage-admin-alerts-card"}
  makeAdminMileageCardInteractive(card)
  const receiptsCard=$("driverStatusCard");
  if(receiptsCard?.parentElement){
    if(card.nextElementSibling!==receiptsCard)receiptsCard.insertAdjacentElement("beforebegin",card);
  }else if(!card.isConnected){
    const fallback=document.querySelector("main")||document.body;
    fallback.prepend(card);
  }
  card.hidden=false;card.innerHTML='<header><div><small>CONTROL DE KILOMETRAJE</small><strong>ALERTAS PARA REVISAR</strong></div><span class="mileage-pill">CARGANDO</span></header><p>Consultando cierres con diferencias…</p>';
  try{
    let snap;
    try{snap=await getDocs(query(collection(db,"weekly_mileage_alerts"),orderBy("updatedAt","desc"),limit(100)))}
    catch(_){snap=await getDocs(query(collection(db,"weekly_mileage_alerts"),limit(100)))}
    let rows=snap.docs.map(d=>({id:d.id,...d.data()})).filter(row=>!FINAL_ALERT_STATES.has(clean(row.status)));
    try{const records=await getDocs(query(collection(db,COLLECTION),where("adminReviewRequired","==",true),limit(100)));for(const d of records.docs){const record={id:d.id,...d.data()};for(const [kind,item] of Object.entries(record.alertOutbox||{})){if(["delivered","reviewed","cancelled","already_resolved","resolved","closed","dismissed","archived"].includes(clean(item?.status)))continue;const alertId=clean(item?.alertId||idempotentAlertId(record.driverUid,record.weeklyPeriodId,record.id,kind));if(!rows.some(r=>clean(r.id)===alertId))rows.push({id:alertId,...(item.payload||{}),driverUid:record.driverUid,weeklyPeriodId:record.weeklyPeriodId,mileageRecordId:record.id,alertLabel:item.payload?.alertLabel||"ALERTA PENDIENTE DE SINCRONIZACIÓN",status:"outbox_pending",outboxPending:true,synthetic:true,incidentType:kind,incidentKey:item.incidentKey||"",updatedAt:record.updatedAt,startPhotoUrl:record.startPhotoUrl,endPhotoUrl:record.endPhotoUrl})}}}catch(error){console.warn("MILEAGE_ADMIN_OUTBOX_SCAN_FAILED",error?.code||error?.message)}
    rows=rows.sort((a,b)=>timestampMs(b.updatedAt||b.createdAt)-timestampMs(a.updatedAt||a.createdAt));
    if(!rows.length){card.innerHTML='<header><div><small>CONTROL DE KILOMETRAJE</small><strong>SIN ALERTAS PENDIENTES</strong></div><span class="mileage-pill">AL DÍA</span></header><p>No hay controles marcados para revisión.</p><span class="mileage-card-open-hint">TOCAR PARA VER CONTROLES →</span>';return}
    card.innerHTML=`<header><div><small>CONTROL DE KILOMETRAJE</small><strong>${rows.length} ALERTA${rows.length===1?"":"S"} PENDIENTE${rows.length===1?"":"S"}</strong></div><span class="mileage-pill is-alert">REVISAR</span></header><div class="mileage-admin-list">${rows.slice(0,20).map(row=>`<article data-alert-id="${escapeHtml(row.id)}"><b>${escapeHtml(row.driverName||row.driverUid||"Chofer")}</b><span>${escapeHtml(row.weeklyPeriodId||"Semana sin identificar")} · ${Number.isFinite(num(row.totalKm))&&num(row.totalKm)>0?`${num(row.totalKm).toLocaleString("es-AR")} km`:"Control incompleto"} · ${money(row.weeklyGrossRevenue||0)}</span><small>${escapeHtml(row.alertLabel||row.reason||"Control pendiente")}</small><div class="mileage-admin-actions">${row.startPhotoUrl?`<a class="mileage-admin-link" href="${escapeHtml(row.startPhotoUrl)}" target="_blank" rel="noopener">FOTO INICIAL</a>`:""}${row.endPhotoUrl?`<a class="mileage-admin-link" href="${escapeHtml(row.endPhotoUrl)}" target="_blank" rel="noopener">FOTO FINAL</a>`:""}<button class="mileage-admin-review" type="button" data-review-alert="${escapeHtml(row.id)}" data-record-id="${escapeHtml(row.mileageRecordId||"")}" data-incident-key="${escapeHtml(row.incidentKey||"")}" data-incident-type="${escapeHtml(row.incidentType||"")}" data-synthetic="${row.synthetic?"true":"false"}">${row.synthetic?"RESOLVER INCIDENCIA":"MARCAR REVISADA"}</button></div></article>`).join("")}</div>${rows.length>20?`<p>Se muestran las 20 alertas más recientes de ${rows.length} pendientes.</p>`:""}`;
    card.querySelectorAll("[data-review-alert]").forEach(button=>button.addEventListener("click",async()=>{button.disabled=true;try{await markMileageAlertReviewed({alertId:button.dataset.reviewAlert,mileageRecordId:button.dataset.recordId,incidentKey:button.dataset.incidentKey,incidentType:button.dataset.incidentType,synthetic:button.dataset.synthetic==="true"})}catch(error){button.disabled=false;button.textContent="REINTENTAR"}}));
  }catch(error){card.innerHTML=`<header><div><small>CONTROL DE KILOMETRAJE</small><strong>NO SE PUDIERON LEER LAS ALERTAS</strong></div><span class="mileage-pill is-alert">ERROR</span></header><p>${escapeHtml(error?.message||"Revisá los permisos de Firebase.")}</p>`}
}

function watch(){
  ensureUi();
  window.addEventListener("online",()=>{bootstrapFirebase().then(async()=>{const token=captureSessionToken();if(!isDriver()||!sessionTokenIsCurrent(token))return;await syncLocalPendings(token);await reconcilePendingOperations(token);await cleanupPendingEvidences(token)}).catch(()=>{})});
  document.addEventListener("submit",event=>{if(event.target?.id==="weeklyReceiptForm")interceptClosureSubmit(event)},true);
  document.addEventListener("click",event=>{
    const mileageButton=event.target?.closest?.("#mileageClosureOpen");
    if(mileageButton){
      event.preventDefault();
      event.stopPropagation();
      handleClosureMileageOpen(mileageButton.dataset.mileageClosureAction||"view");
      return;
    }
    const button=event.target?.closest?.("#weeklyClosureAcknowledgementBtn");
    if(button)interceptAcknowledgement(event);
  },true);
  let mutationQueued=false;
  new MutationObserver(()=>{if(mutationQueued)return;mutationQueued=true;queueMicrotask(()=>{mutationQueued=false;injectClosureCard()})}).observe(document.body,{subtree:true,attributes:true,attributeFilter:["hidden","aria-hidden"]});
  const attemptStart=async()=>{
    try{
      await bootstrapFirebase();
      if(!window.ExploraCanonicalWeeklyClosure||!role())return false;
      if(isDriver())await ensureStartPrompt();else if(isAdmin())await renderAdminAlerts();
      return true;
    }catch(_){return false}
  };
  let delay=250;
  const retry=async()=>{const ok=await attemptStart();if(!ok){delay=Math.min(5000,Math.round(delay*1.5));setTimeout(retry,delay)}};
  retry();
  window.addEventListener("explora:session-opened",()=>{bootstrapFirebase().then(()=>{const token=captureSessionToken();if(!sessionTokenIsCurrent(token))return;if(isDriver())ensureStartPrompt();else if(isAdmin())renderAdminAlerts()}).catch(()=>{})});
  window.addEventListener("explora:weekly-period-changed",()=>{lastPeriod="";setTimeout(()=>ensureStartPrompt().catch(()=>{}),500)});
  window.addEventListener("explora:mi-auto-updated",()=>{if(isDriver())refreshContext().catch(()=>{});else if(isAdmin())renderAdminAlerts().catch(()=>{})});
  window.addEventListener("explora:weekly-closure",()=>{if(isAdmin())renderAdminAlerts().catch(()=>{})});
  document.addEventListener("visibilitychange",()=>{if(!document.hidden){bootstrapFirebase().catch(()=>{});const id=period()?.id;if(id&&id!==lastPeriod){lastPeriod=id;refreshContext().catch(()=>{})}}});
}
function clearSessionState({preserveAuthIdentity=false}={}){
  stopMileageReminder();
  releasePreview($("mileagePreview"));context=null;currentRecord=null;lastPeriod="";operationBusy=false;bypassSubmit=false;
  if(!preserveAuthIdentity){activeAuthUid="";sessionGeneration+=1;}
  closeModal(false);
  const card=$("mileageDashboardCard");if(card)card.hidden=true;
  const adminCard=$("mileageAdminAlertsCard");if(adminCard)adminCard.hidden=true;
  const closureCard=$("mileageClosureCard");closureCard?.remove();
}

window.addEventListener("explora:auth-cleared",()=>clearSessionState());
window.ExploraMileageControl=Object.freeze({version:VERSION,refresh:refreshContext,open:()=>openModal("view"),ensureBeforeBilling:ensureMileageBeforeBilling,startReminder:startMileageReminder,stopReminder:stopMileageReminder,scheduleReminder:scheduleMileageReminder,getStartGraceState:startGraceState,getState:()=>({context,currentRecord,firebaseReady:Boolean(auth&&db),storageReady:Boolean(storage)}),parseNumber:num,classify,ensureFirebase,stableHash,idempotentAlertId,vehicleIsOperational,canonicalAssignmentMatches});
watch();
