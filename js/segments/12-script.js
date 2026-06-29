
(function(){
  var done=false;
  function finish(){
    if(done) return; done=true;
    document.body.classList.add('explora-splash-hidden');
    document.documentElement.style.pointerEvents='';
    document.body.style.pointerEvents='';
    document.documentElement.style.overflow='';
    document.body.style.overflow='';
    var s=document.getElementById('exploraSplash');
    if(s){s.setAttribute('aria-hidden','true');s.style.display='none';s.style.pointerEvents='none';}
    var hasMode=document.body.classList.contains('explora-authenticated')||document.body.classList.contains('explora-admin-authenticated')||document.body.classList.contains('explora-login-visible')||document.body.classList.contains('explora-role-blocked');
    if(!hasMode) document.body.classList.add('explora-login-visible');
  }
  window.ExploraFinishSplash=finish;
  setTimeout(finish,1000);
  window.addEventListener('error',function(){setTimeout(finish,0);});
  window.addEventListener('unhandledrejection',function(){setTimeout(finish,0);});
})();
