import { doc, updateDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
const F=window.ExploraFirebase||{};const db=F.db||null;const $=id=>document.getElementById(id);
const esc=v=>String(v??"").replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));
const money=v=>new Intl.NumberFormat("es-AR",{style:"currency",currency:"ARS",maximumFractionDigits:0}).format(Number(v)||0).replace(/\s/g,"");
function render(rows=[]){const box=$("debtNotificationStack");if(!box)return;const pending=rows.filter(row=>row.acknowledgedByDriver!==true&&!String(row.status||"").toLowerCase().includes("cancel"));box.hidden=!pending.length;box.innerHTML=pending.map(row=>`<article class="debt-notification-card"><strong>NUEVA DEUDA REGISTRADA</strong><span>${esc(row.reasonLabel||row.reason||"Otro")} · ${money(row.totalAmount||0)}</span><small>${Number(row.installmentCount||1)} pago(s) semanal(es) · Cuota estimada ${money(row.weeklyInstallmentAmount||0)}</small>${row.notes?`<small>${esc(row.notes)}</small>`:""}<div class="debt-notification-actions">${row.receiptUrl?`<button type="button" data-notification-attachment="${esc(row.id)}">VER ARCHIVO</button>`:'<span></span>'}<button class="primary" type="button" data-ack-debt="${esc(row.id)}">ACEPTAR</button></div></article>`).join("");}
window.addEventListener("explora:driver-debts-updated",event=>render(event.detail?.rows||[]));
window.addEventListener("explora:auth-cleared",()=>render([]));
document.addEventListener("click",async e=>{
  const attachment=e.target.closest?.("[data-notification-attachment]");
  if(attachment){const debt=window.ExploraDriverIncidents?.getState?.().rows?.find?.(row=>String(row.id||row.debtId)===attachment.dataset.notificationAttachment);const normalized=debt?window.ExploraDriverIncidents?.getState?.().summary?.normalized?.find?.(row=>row.id===attachment.dataset.notificationAttachment):null;if(normalized?.attachments?.length){window.ExploraDriverIncidents?.show?.();setTimeout(()=>document.querySelector(`[data-debt-attachments="${CSS.escape(normalized.id)}"]`)?.click(),80);}return;}
  const button=e.target.closest?.("[data-ack-debt]");if(!button)return;button.disabled=true;button.textContent="GUARDANDO…";
  try{await updateDoc(doc(db,"deudas_choferes",button.dataset.ackDebt),{acknowledgedByDriver:true,acknowledgedAt:serverTimestamp(),updatedAt:serverTimestamp()});}
  catch(error){console.error("DEBT_ACK_FAILED",error);button.disabled=false;button.textContent="ACEPTAR";}
});
