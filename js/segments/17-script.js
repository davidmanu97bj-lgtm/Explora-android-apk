(()=>{
  "use strict";
  if(window.ExploraStableDerivationCard)return;

  const VERSION="v2.4.39-cache-busters-final-sync";
  const TRUSTED_SOURCE="weekly-derivation-ranking";
  const STORAGE_PREFIX="explora:derivationRankingDashboard:v2:";
  const LEGACY_PREFIX="explora:last-valid-derivation-card:v1:";
  const state={
    uid:"",
    weeklyPeriodId:"",
    status:"idle",
    lastConfirmed:null,
    authoritativeReady:false,
    renderVersion:0
  };

  const byId=id=>document.getElementById(id);
  const storageKey=weeklyPeriodId=>`${STORAGE_PREFIX}${String(weeklyPeriodId||"active")}`;
  const normalizeDerivedAmount=value=>{
    if(typeof value==="number")return Math.max(0,value);
    const cleaned=String(value??"").replace(/DINERO\s+DERIVADO\s*(?:[·:.-])?\s*/gi,"").replace(/\s+/g," ").trim();
    if(!cleaned)return 0;
    const numeric=cleaned.replace(/[^0-9,.-]/g,"").replace(/\.(?=\d{3}(?:\D|$))/g,"").replace(",", ".");
    return Math.max(0,Number(numeric)||0);
  };
  const formatMoney=value=>new Intl.NumberFormat("es-AR",{style:"currency",currency:"ARS",maximumFractionDigits:0}).format(Math.round(normalizeDerivedAmount(value))).replace("ARS","$").replace(/\s+/g," ");
  const setText=(node,value)=>{const next=String(value??"");if(node&&node.textContent!==next)node.textContent=next};
  const setHidden=(node,value)=>{if(node&&node.hidden!==Boolean(value))node.hidden=Boolean(value)};
  const initials=name=>String(name||"Chofer").trim().split(/\s+/).filter(Boolean).map(part=>part[0]||"").join("").slice(0,2).toUpperCase();
  const validPayload=payload=>Boolean(payload&&Number(payload.derivedAmount)>0&&String(payload.name||"").trim());
  const normalizeLeader=payload=>{
    const derivedAmount=Math.max(0,Math.round(normalizeDerivedAmount(payload?.derivedAmount)));
    return {
      name:String(payload?.name||"Chofer").trim(),
      avatar:String(payload?.avatar||"").trim(),
      derivedAmount,
      bonusAmount:Math.max(0,Math.round(Number(payload?.bonusAmount??derivedAmount*.10)||0)),
      position:Math.max(1,Math.round(Number(payload?.position||1)))
    };
  };
  function nodes(){return{
    card:byId("performanceDerivatorCard"),
    winner:byId("performanceDerivatorWinner"),
    empty:byId("performanceDerivatorEmpty"),
    emptyTitle:byId("performanceDerivatorEmptyTitle"),
    emptyCopy:byId("performanceDerivatorEmptyCopy"),
    avatar:byId("performanceDerivatorAvatar"),
    image:byId("performanceDerivatorAvatarImage"),
    initials:byId("performanceDerivatorAvatarInitials"),
    name:byId("performanceDerivatorName"),
    position:byId("performanceDerivatorPosition"),
    derived:byId("performanceDerivatorDerivedAmount")||byId("performanceDerivatorDerived"),
    bonus:byId("performanceDerivatorBonus")
  }}
  function prunePersisted(activeWeeklyPeriodId){
    try{
      for(let index=localStorage.length-1;index>=0;index--){
        const key=localStorage.key(index)||"";
        if(key.startsWith(LEGACY_PREFIX)||(key.startsWith(STORAGE_PREFIX)&&key!==storageKey(activeWeeklyPeriodId)))localStorage.removeItem(key);
      }
    }catch(_){}
  }
  function loadPersisted(weeklyPeriodId){
    try{
      const raw=localStorage.getItem(storageKey(weeklyPeriodId));
      if(!raw)return null;
      const parsed=JSON.parse(raw);
      if(String(parsed?.weeklyPeriodId||"")!==String(weeklyPeriodId||"")){localStorage.removeItem(storageKey(weeklyPeriodId));return null}
      if(parsed?.status==="available"&&validPayload(parsed?.leader))return{status:"available",leader:normalizeLeader(parsed.leader),weeklyPeriodId};
      if(parsed?.status==="empty")return{status:"empty",leader:null,weeklyPeriodId};
      localStorage.removeItem(storageKey(weeklyPeriodId));
    }catch(_){try{localStorage.removeItem(storageKey(weeklyPeriodId))}catch(__){}}
    return null;
  }
  function persistConfirmed(status,leader=null){
    try{
      localStorage.setItem(storageKey(state.weeklyPeriodId),JSON.stringify({
        version:VERSION,
        weeklyPeriodId:state.weeklyPeriodId,
        status,
        leader:status==="available"?normalizeLeader(leader):null,
        savedAt:Date.now()
      }));
    }catch(_){}
  }
  function setCardState(status,source=""){
    const card=nodes().card;
    state.status=status;
    if(card){card.dataset.rankingState=status;card.dataset.weeklyPeriodId=state.weeklyPeriodId;if(source)card.dataset.rankingSource=source}
  }
  function renderWinner(payload,{source="network"}={}){
    const n=nodes();if(!n.card||!n.winner||!n.empty)return false;
    const leader=normalizeLeader(payload),name=leader.name.toUpperCase(),avatar=leader.avatar;
    setText(n.name,name);setText(n.position,`PUESTO ${leader.position}`);setText(n.derived,formatMoney(leader.derivedAmount));setText(n.bonus,`+${formatMoney(leader.bonusAmount)}`);
    if(n.bonus){const len=n.bonus.textContent.length;n.bonus.dataset.fit=len>16?"tight":len>13?"compact":"normal"}
    if(n.image&&n.initials&&n.avatar){
      n.image.onerror=()=>{
        n.image.removeAttribute("src");n.image.alt="";setHidden(n.image,true);setText(n.initials,initials(leader.name));setHidden(n.initials,false);n.avatar.classList.add("is-empty");n.avatar.setAttribute("aria-hidden","true");
      };
      if(avatar){if(n.image.getAttribute("src")!==avatar)n.image.setAttribute("src",avatar);n.image.alt=`Foto de ${leader.name}`;setHidden(n.image,false);setHidden(n.initials,true);n.avatar.classList.remove("is-empty");n.avatar.removeAttribute("aria-hidden")}
      else{n.image.removeAttribute("src");n.image.alt="";setHidden(n.image,true);setText(n.initials,initials(leader.name));setHidden(n.initials,false);n.avatar.classList.add("is-empty");n.avatar.setAttribute("aria-hidden","true")}
    }
    setHidden(n.empty,true);setHidden(n.winner,false);setCardState("available",source);return true;
  }
  function clearWinnerVisual(n=nodes()){
    setText(n.name,"");setText(n.position,"");setText(n.derived,"$ 0");setText(n.bonus,"");
    if(n.image){n.image.removeAttribute("src");n.image.alt="";setHidden(n.image,true)}
    if(n.initials){setText(n.initials,"");setHidden(n.initials,true)}
    if(n.avatar){n.avatar.classList.add("is-empty");n.avatar.setAttribute("aria-hidden","true")}
  }
  function renderEmptyVisual({status="empty",title="Sé el primero en derivar un viaje",copy="Todavía no hay dinero derivado en esta semana.",source="network"}={}){
    const n=nodes();if(!n.card||!n.winner||!n.empty)return false;
    clearWinnerVisual(n);setText(n.emptyTitle,title);setText(n.emptyCopy,copy);setHidden(n.winner,true);setHidden(n.empty,false);setCardState(status,source);return true;
  }
  function renderLoading(){
    if(state.lastConfirmed?.status==="available")return renderWinner(state.lastConfirmed.leader,{source:"cache"});
    if(state.lastConfirmed?.status==="empty")return renderEmptyVisual({status:"loading",source:"cache",title:"Sé el primero en derivar un viaje",copy:"Comprobando la semana actual…"});
    return renderEmptyVisual({status:"loading",source:"loading",title:"Sé el primero en derivar un viaje",copy:"Comprobando la semana actual…"});
  }
  function renderConfirmedEmpty(){
    state.lastConfirmed={status:"empty",leader:null,weeklyPeriodId:state.weeklyPeriodId};
    state.authoritativeReady=true;
    persistConfirmed("empty");
    return renderEmptyVisual({status:"empty",source:"firestore"});
  }
  function beginSession(uid="",weeklyPeriodId=""){
    const nextUid=String(uid||""),nextPeriod=String(weeklyPeriodId||"");
    if(!nextPeriod)return state.renderVersion;
    if(state.uid===nextUid&&state.weeklyPeriodId===nextPeriod)return state.renderVersion;
    state.uid=nextUid;state.weeklyPeriodId=nextPeriod;state.authoritativeReady=false;state.renderVersion+=1;
    prunePersisted(nextPeriod);
    state.lastConfirmed=loadPersisted(nextPeriod);
    if(state.lastConfirmed?.status==="available")renderWinner(state.lastConfirmed.leader,{source:"cache"});
    else if(state.lastConfirmed?.status==="empty")renderEmptyVisual({status:"loading",source:"cache",copy:"Comprobando la semana actual…"});
    else renderLoading();
    return state.renderVersion;
  }
  function render(payload,options={}){
    const source=String(options.source||"unknown"),uid=String(options.uid??state.uid),weeklyPeriodId=String(options.weeklyPeriodId??state.weeklyPeriodId);
    if(source!==TRUSTED_SOURCE)return false;
    if(uid!==state.uid||weeklyPeriodId!==state.weeklyPeriodId)return false;
    if(options.loading)return renderLoading();
    if(options.error){
      if(state.lastConfirmed?.status==="available")renderWinner(state.lastConfirmed.leader,{source:"cache-error"});
      else if(state.lastConfirmed?.status==="empty")renderEmptyVisual({status:"error",source:"cache-error",copy:"No se pudo confirmar la actualización. Se conserva el último estado de esta semana."});
      else renderEmptyVisual({status:"error",source:"error",title:"Ranking no disponible",copy:"No se pudo confirmar la información de esta semana."});
      setCardState("error",state.lastConfirmed?"cache-error":"error");
      return true;
    }
    if(validPayload(payload)){
      const leader=normalizeLeader(payload);
      state.lastConfirmed={status:"available",leader,weeklyPeriodId:state.weeklyPeriodId};
      state.authoritativeReady=Boolean(options.authoritative||options.settled);
      persistConfirmed("available",leader);
      return renderWinner(leader,{source:"firestore"});
    }
    if(options.authoritative&&options.settled)return renderConfirmedEmpty();
    return renderLoading();
  }
  function clear(){
    state.lastConfirmed=null;state.authoritativeReady=false;state.uid="";state.weeklyPeriodId="";state.status="idle";state.renderVersion+=1;
    const n=nodes();if(n.empty)setHidden(n.empty,true);if(n.winner)setHidden(n.winner,true);if(n.card){delete n.card.dataset.rankingState;delete n.card.dataset.weeklyPeriodId;delete n.card.dataset.rankingSource}
  }
  window.ExploraStableDerivationCard={
    version:VERSION,
    trustedSource:TRUSTED_SOURCE,
    beginSession,
    render,
    clear,
    storageKey,
    getState:()=>({...state,lastConfirmed:state.lastConfirmed?JSON.parse(JSON.stringify(state.lastConfirmed)):null})
  };
})();
