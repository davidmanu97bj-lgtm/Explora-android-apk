
(()=>{
  "use strict";
  if(window.__exploraIdleDashboardRestartV1)return;
  window.__exploraIdleDashboardRestartV1=true;

  const IDLE_MS=120000;
  const CHECK_MS=5000;
  const STORAGE_KEY="explora:dashboard:last-valid:v1";
  const RELOAD_GUARD_KEY="explora:dashboard:auto-reload-guard:v1";
  const MAX_SNAPSHOT_AGE_MS=6*60*60*1000;
  const TARGETS={
    performancePodium:"html",
    performanceDerivatorBody:"html",
    performanceGoalTrack:"html",
    dashboardWeeklyRevenue:"text",
    dashboardWeeklyRevenueMeta:"text",
    dashboardWeeklyExpenses:"text",
    dashboardWeeklyExpensesMeta:"text",
    dashboardReceiptsMeta:"text",
    dashboardExploreLoanMeta:"text",
    driverStatusCard:"html"
  };
  const TRANSIENT_RE=/calculando|cargando|sincronizando|actualizando|comprobando|espera un momento|todav[ií]a no hay choferes disponibles/i;
  const activityEvents=["pointerdown","touchstart","keydown","input","change","scroll","wheel"];
  let lastActivity=Date.now();
  let intervalId=0;
  let reloadScheduled=false;
  let observer=null;
  let saveTimer=0;

  function node(id){return document.getElementById(id)}
  function isDashboardVisible(){
    const main=node("driverDashboardReal");
    if(main&&main.hidden)return false;
    if(document.body.classList.contains("explora-internal-screen-open"))return false;
    const blockers=[
      ".is-open:not(#dialogBackdrop)",
      "[aria-hidden='false'].vehicle-detail-screen",
      ".billing-form-backdrop.is-open",
      ".weekly-closure-overlay:not([hidden])",
      ".dialog-backdrop.open",
      ".admin-shared-screen[aria-hidden='false']"
    ];
    return !blockers.some(sel=>{try{return Boolean(document.querySelector(sel))}catch(_){return false}});
  }
  function hasUnsavedInteraction(){
    const active=document.activeElement;
    if(active&&/^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))return true;
    return Boolean(document.querySelector("form input:not([type='hidden']):not(:disabled), form textarea:not(:disabled), .billing-form-backdrop.is-open, .expense-screen.is-open, .new-service-screen.is-open"));
  }
  function isValidValue(value){
    const clean=String(value||"").replace(/\s+/g," ").trim();
    return clean.length>0&&!TRANSIENT_RE.test(clean);
  }
  function collectSnapshot(){
    const data={savedAt:Date.now(),path:location.pathname,values:{}};
    let validPrimary=0;
    for(const [id,mode] of Object.entries(TARGETS)){
      const el=node(id);if(!el)continue;
      const value=mode==="text"?el.textContent:el.innerHTML;
      if(!isValidValue(value))continue;
      data.values[id]={mode,value};
      if(["performancePodium","performanceDerivatorBody","performanceGoalTrack"].includes(id))validPrimary++;
    }
    return validPrimary>=2?data:null;
  }
  function saveSnapshot(){
    clearTimeout(saveTimer);
    saveTimer=setTimeout(()=>{
      try{
        const data=collectSnapshot();
        if(data)sessionStorage.setItem(STORAGE_KEY,JSON.stringify(data));
      }catch(_){}
    },180);
  }
  function restoreSnapshot(){
    try{
      const raw=sessionStorage.getItem(STORAGE_KEY);if(!raw)return false;
      const data=JSON.parse(raw);
      if(!data||Date.now()-Number(data.savedAt||0)>MAX_SNAPSHOT_AGE_MS)return false;
      if(data.path&&data.path!==location.pathname)return false;
      let restored=0;
      for(const [id,payload] of Object.entries(data.values||{})){
        const el=node(id);if(!el||!payload)continue;
        if(payload.mode==="text")el.textContent=String(payload.value||"");
        else el.innerHTML=String(payload.value||"");
        el.dataset.exploraRestoredSnapshot="true";
        restored++;
      }
      return restored>0;
    }catch(_){return false}
  }
  function noteActivity(){lastActivity=Date.now()}
  function canAutoReload(){
    if(reloadScheduled||!isDashboardVisible()||hasUnsavedInteraction())return false;
    if(document.body.classList.contains("is-scroll-locked"))return false;
    const session=window.ExploraSession||{};
    if(session.closing)return false;
    return true;
  }
  function autoReload(reason){
    if(!canAutoReload())return false;
    try{
      const last=Number(sessionStorage.getItem(RELOAD_GUARD_KEY)||0);
      if(Date.now()-last<45000)return false;
      saveSnapshot();
      const data=collectSnapshot();
      if(data)sessionStorage.setItem(STORAGE_KEY,JSON.stringify(data));
      sessionStorage.setItem(RELOAD_GUARD_KEY,String(Date.now()));
      sessionStorage.setItem("explora:dashboard:auto-reload-reason",String(reason||"idle"));
    }catch(_){}
    reloadScheduled=true;
    setTimeout(()=>location.reload(),120);
    return true;
  }
  function checkIdle(){
    if(Date.now()-lastActivity<IDLE_MS)return;
    if(autoReload(document.visibilityState==="hidden"?"idle-hidden":"idle-visible"))return;
    lastActivity=Date.now()-IDLE_MS+15000;
  }
  function onVisibilityChange(){
    if(document.visibilityState==="hidden"){
      saveSnapshot();
      return;
    }
    const hiddenAt=Number(sessionStorage.getItem("explora:dashboard:hidden-at")||0);
    if(hiddenAt&&Date.now()-hiddenAt>=IDLE_MS){autoReload("resume-after-idle");return;}
    noteActivity();
  }
  function onPageHide(){
    saveSnapshot();
    try{sessionStorage.setItem("explora:dashboard:hidden-at",String(Date.now()))}catch(_){}
  }
  function startObserver(){
    const roots=[node("weeklyRankingLive"),node("performanceGoalViewport"),node("driverStatusCard")].filter(Boolean);
    if(!roots.length)return;
    observer=new MutationObserver(()=>saveSnapshot());
    roots.forEach(root=>observer.observe(root,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:["hidden","class","data-status"]}));
  }
  function init(){
    restoreSnapshot();
    activityEvents.forEach(name=>window.addEventListener(name,noteActivity,{passive:true,capture:true}));
    document.addEventListener("visibilitychange",()=>{
      if(document.visibilityState==="hidden"){
        try{sessionStorage.setItem("explora:dashboard:hidden-at",String(Date.now()))}catch(_){}
      }
      onVisibilityChange();
    },true);
    window.addEventListener("pagehide",onPageHide,{capture:true});
    window.addEventListener("beforeunload",saveSnapshot,{capture:true});
    window.addEventListener("pageshow",event=>{
      restoreSnapshot();
      if(event.persisted)checkIdle();
    });
    startObserver();
    intervalId=window.setInterval(checkIdle,CHECK_MS);
    window.ExploraIdleDashboardRestart={
      version:"1.0.0",
      idleMs:IDLE_MS,
      save:saveSnapshot,
      restore:restoreSnapshot,
      restart:()=>autoReload("manual-api"),
      resetActivity:noteActivity,
      stop:()=>{clearInterval(intervalId);observer?.disconnect?.();}
    };
    saveSnapshot();
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init,{once:true});
  else init();
})();
