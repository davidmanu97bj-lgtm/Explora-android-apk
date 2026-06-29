import { collection, query, where, limit, onSnapshot, getDocs, addDoc, doc, updateDoc, serverTimestamp, Timestamp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { ref as storageRef, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-storage.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

(() => {
  "use strict";

  const VERSION = "explora-pago-home-v1-on-demand-closure";
  const AR_TZ = "America/Argentina/Cordoba";
  const $ = id => document.getElementById(id);
  const state = {
    tab:"bruto",
    user:null,
    role:"driver",
    profile:{},
    db:null,
    auth:null,
    storage:null,
    drivers:[],
    records:[],
    expenses:[],
    closures:[],
    extra:[],
    unsubscribers:[],
    latestSummary:null,
    pendingClosure:null,
    modalMode:"request",
    modalClosure:null,
    modalFile:null,
    busy:false
  };

  const currency = value => new Intl.NumberFormat("es-AR", { style:"currency", currency:"ARS", maximumFractionDigits:0 }).format(Number(value) || 0).replace(/\s/g, "");
  const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  const abs = value => Math.abs(number(value));
  const safe = value => String(value ?? "").trim();
  const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
  const isAdmin = () => /admin|owner|david/i.test(String(state.role || "")) || /david/i.test(String(state.profile?.nombre || state.profile?.displayName || state.user?.displayName || ""));

  function ms(value) {
    if (!value) return 0;
    if (typeof value?.toMillis === "function") return value.toMillis();
    if (typeof value?.toDate === "function") return value.toDate().getTime();
    if (typeof value === "number") return value > 100000000000 ? value : value * 1000;
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    if (typeof value?.seconds === "number") return value.seconds * 1000 + Math.round((value.nanoseconds || 0) / 1000000);
    return 0;
  }

  function rowMs(row = {}) {
    return Math.max(
      ms(row.createdAt), ms(row.completedAt), ms(row.updatedAt), ms(row.expenseDate), ms(row.fechaISO),
      Number(row.createdAtMs || 0), Number(row.timestampMs || 0), Number(row.completedAtMs || 0)
    );
  }

  function methodOf(row = {}) {
    const raw = safe(row.paymentMethod || row.metodoPago || row.financialCategory || row.receiptPaymentMethod || row.paymentProvider || row.method).toLowerCase();
    if (/cash|efectivo/.test(raw)) return "cash";
    if (/qr/.test(raw)) return "qr";
    if (/card|tarjeta|point/.test(raw)) return "card";
    if (/transfer|alias|transf/.test(raw)) return "transfer";
    return raw || "cash";
  }

  function amountOf(row = {}) {
    return Math.max(0, number(row.amount ?? row.monto ?? row.valor ?? row.finalPrice ?? row.total ?? row.importe));
  }

  function expenseTypeLabel(row = {}) {
    const raw = safe(row.expenseType || row.tipo || row.category || row.categoria || "gasto").toLowerCase();
    const map = { combustible:"Combustible", peajes:"Peaje", peaje:"Peaje", estacionamiento:"Estacionamiento", lavado:"Lavado", mantenimiento:"Mantenimiento", compras:"Compras", gasto:"Gasto" };
    return map[raw] || raw.charAt(0).toUpperCase() + raw.slice(1);
  }

  function paymentLabel(method) {
    return ({ cash:"Cobro efectivo", transfer:"Cobro transferencia", card:"Cobro tarjeta", qr:"Cobro QR" })[method] || "Cobro";
  }

  function dateShort(value) {
    const d = new Date(value || Date.now());
    return new Intl.DateTimeFormat("es-AR", { timeZone:AR_TZ, day:"2-digit", month:"2-digit" }).format(d);
  }

  function displayName() {
    return safe(state.profile?.nombre || state.profile?.nombreCompleto || state.profile?.displayName || state.user?.displayName || state.user?.email?.split("@")[0] || "CHOFER").toUpperCase();
  }

  function getDriverUid() {
    return safe(state.profile?.uid || state.profile?.driverUid || state.profile?.choferUid || state.profileDocumentId || state.user?.uid);
  }

  function clearListeners() {
    for (const unsub of state.unsubscribers.splice(0)) {
      try { unsub?.(); } catch (_) {}
    }
  }

  async function waitFirebase(timeout = 14000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const fb = window.ExploraFirebase || {};
      if (fb.db && fb.auth) {
        state.db = fb.db; state.auth = fb.auth; state.storage = fb.storage || null;
        return fb;
      }
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    throw new Error("Firebase no está disponible para Explora Pago Home.");
  }

  function installShell() {
    if ($("exploraPagoDashboard")) return;
    const shell = document.querySelector(".dashboard-shell-real");
    if (!shell) return;
    const html = `
      <section aria-label="Inicio financiero Explora" class="explora-pay-home" id="exploraPagoDashboard">
        <header class="pay-topbar">
          <div class="pay-hello">
            <span class="pay-avatar" id="payAvatar"><svg viewBox="0 0 24 24"><path d="M7.5 12.5 10 15l6.5-6.5"></path><path d="M3.5 12c2.4-4.4 5.6-4.4 8 0 2.4 4.4 5.6 4.4 9 0"></path></svg></span>
            <strong class="pay-title" id="payGreeting">Hola, CHOFER</strong>
          </div>
          <div class="pay-icons">
            <button class="pay-icon-btn" id="paySearchBtn" type="button" aria-label="Buscar"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-4-4"></path></svg></button>
            <button class="pay-icon-btn" id="payBellBtn" type="button" aria-label="Cierres pendientes"><svg viewBox="0 0 24 24"><path d="M18 9a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"></path><path d="M10 21h4"></path></svg></button>
          </div>
        </header>
        <nav class="pay-tabs" aria-label="Resumen de caja Explora" role="tablist">
          <button class="pay-tab is-active" data-pay-tab="bruto" type="button" role="tab" aria-selected="true">Bruto</button>
          <button class="pay-tab" data-pay-tab="gastos" type="button" role="tab" aria-selected="false">Gastos</button>
          <button class="pay-tab" data-pay-tab="explora" type="button" role="tab" aria-selected="false">Explora</button>
          <button class="pay-tab" data-pay-tab="chofer" type="button" role="tab" aria-selected="false">Chofer</button>
        </nav>
        <section class="pay-main-card" aria-live="polite">
          <div class="pay-main-row">
            <div class="pay-amount-wrap">
              <div class="pay-amount-line"><strong class="pay-amount" id="payMainAmount">—</strong><button class="pay-eye" type="button" aria-label="Ocultar o mostrar monto"><svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"></path><circle cx="12" cy="12" r="3"></circle></svg></button></div>
              <span class="pay-subtitle" id="payMainSubtitle">Cargando caja operativa…</span>
            </div>
            <button class="pay-enter" id="payCardEnterBtn" type="button">Entrar <svg viewBox="0 0 24 24"><path d="M5 12h14"></path><path d="m13 6 6 6-6 6"></path></svg></button>
          </div>
          <div class="pay-actions">
            <button class="pay-action" data-pay-run="nuevo-servicio" type="button"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"></path></svg><span>Registrar<br/>cobro</span></button>
            <button class="pay-action" data-pay-run="cargar-gastos" type="button"><svg viewBox="0 0 24 24"><path d="M4 7.5h14.5A1.5 1.5 0 0 1 20 9v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h11"></path><path d="M16 12h5v4h-5a2 2 0 0 1 0-4Z"></path></svg><span>Cargar<br/>gasto</span></button>
            <button class="pay-action" id="payClosureActionBtn" type="button"><svg viewBox="0 0 24 24"><path d="M7 3h7l4 4v14H7z"></path><path d="M14 3v5h5"></path><path d="M9 14h6M9 17h4"></path></svg><span>Pedir<br/>cierre</span></button>
          </div>
          <div class="pay-liquid-pill"><span id="payPillLabel">Dinero a liquidar</span><strong id="payPillAmount">—</strong></div>
          <div class="pay-extra-lines" id="payExtraLines"></div>
          <div class="pay-status-pill" id="payClosureStatus" hidden><span><b>Cierre pendiente</b><br><small id="payClosureStatusText">—</small></span><button id="payClosureStatusBtn" type="button">Ver</button></div>
        </section>
        <section class="pay-section" aria-labelledby="payActivityTitle">
          <div class="pay-section-head"><h2 id="payActivityTitle">Última actividad</h2><button id="payRefreshBtn" type="button">Actualizar →</button></div>
          <div class="pay-activity-list" id="payActivityList"><div class="pay-activity-empty">Cargando movimientos…</div></div>
        </section>
      </section>
      <button class="pay-floating-spark" id="payQuickClosureBtn" type="button" aria-label="Pedir cierre"><svg viewBox="0 0 24 24"><path d="M12 2 14.8 9.2 22 12l-7.2 2.8L12 22l-2.8-7.2L2 12l7.2-2.8Z"></path></svg></button>
      <nav class="pay-bottom-nav" id="payBottomNav" aria-label="Navegación principal Explora">
        <button class="pay-nav-btn is-active" data-pay-nav="inicio" type="button"><svg viewBox="0 0 24 24"><path d="M3 10.5 12 3l9 7.5"></path><path d="M5 10v10h14V10"></path></svg><span>Inicio</span></button>
        <button class="pay-nav-btn" data-pay-nav="actividad" type="button"><svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"></path></svg><span>Actividad</span></button>
        <button class="pay-nav-btn pay-nav-main" data-pay-run="nuevo-servicio" type="button"><svg viewBox="0 0 24 24"><path d="M8 3H5a2 2 0 0 0-2 2v3"></path><path d="M16 3h3a2 2 0 0 1 2 2v3"></path><path d="M8 21H5a2 2 0 0 1-2-2v-3"></path><path d="M16 21h3a2 2 0 0 0 2-2v-3"></path><path d="M8 8h3v3H8zM13 8h3v3h-3zM8 13h3v3H8zM13 13h3v3h-3z"></path></svg><span>Cobrar</span></button>
        <button class="pay-nav-btn" id="payNavClosure" type="button"><svg viewBox="0 0 24 24"><path d="M7 3h7l4 4v14H7z"></path><path d="M14 3v5h5"></path><path d="M9 14h6M9 17h4"></path></svg><span>Cierre</span></button>
        <button class="pay-nav-btn" data-pay-nav="mas" type="button"><svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h10"></path><path d="M18 17h2M19 16v2"></path></svg><span>Más</span></button>
      </nav>
      <div class="pay-closure-backdrop" id="payClosureBackdrop" aria-hidden="true">
        <section class="pay-closure-modal" role="dialog" aria-modal="true" aria-labelledby="payClosureTitle">
          <header><div><h2 id="payClosureTitle">Cierre a demanda</h2><p id="payClosureSubtitle">Pedí o confirmá un cierre cuando sea necesario.</p></div><button class="pay-closure-close" id="payClosureClose" type="button" aria-label="Cerrar">×</button></header>
          <div class="pay-closure-field" id="payClosureDriverField" hidden><label for="payClosureDriverSelect">Chofer</label><select id="payClosureDriverSelect"><option value="">Cargando choferes…</option></select></div>
          <div class="pay-closure-summary" id="payClosureSummary"></div>
          <div class="pay-closure-field" id="payClosureFileField" hidden><label for="payClosureReceiptInput">Comprobante de transferencia</label><input id="payClosureReceiptInput" type="file" accept="image/*,application/pdf" /></div>
          <div class="pay-closure-message" id="payClosureMessage"></div>
          <div class="pay-closure-actions"><button class="pay-closure-secondary" id="payClosureCancel" type="button">Cancelar</button><button class="pay-closure-primary" id="payClosureSubmit" type="button">Pedir cierre</button></div>
        </section>
      </div>
    `;
    shell.insertAdjacentHTML("afterbegin", html);
    document.body.classList.add("explora-pay-mode");
  }

  function runExistingAction(action) {
    try {
      if (window.ExploraActions?.[action]) { window.ExploraActions[action](); return; }
      const oldButton = Array.from(document.querySelectorAll("[data-action]")).find(el => el.getAttribute("data-action") === action);
      if (oldButton && !oldButton.closest("#exploraPagoDashboard") && !oldButton.closest("#payBottomNav")) oldButton.click();
    } catch (error) { console.warn("EXPLORA_PAY_ACTION_FAILED", action, error); }
  }

  function bindShell() {
    document.querySelectorAll("[data-pay-tab]").forEach(button => button.addEventListener("click", () => {
      state.tab = button.dataset.payTab || "bruto";
      render();
    }));
    document.querySelectorAll("[data-pay-run]").forEach(button => button.addEventListener("click", () => runExistingAction(button.dataset.payRun)));
    $("payClosureActionBtn")?.addEventListener("click", () => openClosureModal("request"));
    $("payQuickClosureBtn")?.addEventListener("click", () => openClosureModal("request"));
    $("payNavClosure")?.addEventListener("click", () => openClosureModal(state.pendingClosure && !isAdmin() ? "confirm" : "request", state.pendingClosure));
    $("payClosureStatusBtn")?.addEventListener("click", () => openClosureModal(state.pendingClosure && !isAdmin() ? "confirm" : "admin-review", state.pendingClosure));
    $("payBellBtn")?.addEventListener("click", () => openClosureModal(state.pendingClosure && !isAdmin() ? "confirm" : "request", state.pendingClosure));
    $("payCardEnterBtn")?.addEventListener("click", () => { if (state.tab === "gastos") runExistingAction("cargar-gastos"); else if (state.tab === "chofer") openClosureModal(state.pendingClosure && !isAdmin() ? "confirm" : "request", state.pendingClosure); else runExistingAction("nuevo-servicio"); });
    $("payRefreshBtn")?.addEventListener("click", () => startRealtime("manual-refresh"));
    $("payClosureClose")?.addEventListener("click", closeClosureModal);
    $("payClosureCancel")?.addEventListener("click", closeClosureModal);
    $("payClosureBackdrop")?.addEventListener("click", event => { if (event.target?.id === "payClosureBackdrop") closeClosureModal(); });
    $("payClosureReceiptInput")?.addEventListener("change", event => { state.modalFile = event.target?.files?.[0] || null; renderClosureModal(); });
    $("payClosureSubmit")?.addEventListener("click", submitClosureModal);
    document.querySelector('[data-pay-nav="actividad"]')?.addEventListener("click", () => $("payActivityTitle")?.scrollIntoView({ behavior:"smooth", block:"start" }));
    document.querySelector('[data-pay-nav="mas"]')?.addEventListener("click", () => runExistingAction(isAdmin() ? "admin-choferes" : "abrir-perfil"));
  }

  async function fetchDrivers() {
    if (!state.db || !isAdmin()) return [];
    const collections = ["choferes", "usuarios"];
    const map = new Map();
    for (const name of collections) {
      try {
        const snap = await getDocs(query(collection(state.db, name), limit(200)));
        snap.forEach(item => {
          const data = item.data() || {};
          const role = safe(data.role || data.rol || data.tipo).toLowerCase();
          const uid = safe(data.uid || data.driverUid || data.choferUid || item.id);
          const driverName = safe(data.nombre || data.nombreCompleto || data.displayName || data.name || data.email || uid);
          if (!uid || /admin/.test(role)) return;
          map.set(uid, { uid, id:item.id, name:driverName, role });
        });
      } catch (error) { console.warn("EXPLORA_PAY_DRIVERS_READ", name, error?.code || error?.message); }
    }
    state.drivers = Array.from(map.values()).sort((a,b)=>a.name.localeCompare(b.name, "es"));
    return state.drivers;
  }

  function scopedQuery(collectionName, uid, max = 180) {
    const col = collection(state.db, collectionName);
    if (isAdmin() && !uid) return query(col, limit(max));
    return query(col, where("driverUid", "==", uid || getDriverUid()));
  }

  async function getScopedDocs(collectionName, uid) {
    const fields = ["driverUid", "choferUid", "uid", "ownerUid"];
    const map = new Map();
    for (const field of fields) {
      try {
        const snap = await getDocs(query(collection(state.db, collectionName), where(field, "==", uid), limit(250)));
        snap.forEach(docSnap => map.set(docSnap.id, { id:docSnap.id, ...docSnap.data() }));
        if (map.size) break;
      } catch (_) {}
    }
    return Array.from(map.values());
  }

  function listenCollection(collectionName, targetArray, uid) {
    try {
      return onSnapshot(scopedQuery(collectionName, uid), snap => {
        state[targetArray] = snap.docs.map(d => ({ id:d.id, ...d.data() }));
        render();
      }, error => {
        console.warn(`EXPLORA_PAY_LISTENER_${collectionName}`, error?.code || error?.message);
      });
    } catch (error) {
      console.warn(`EXPLORA_PAY_LISTENER_SETUP_${collectionName}`, error?.code || error?.message);
      return null;
    }
  }

  function startRealtime(reason = "start") {
    if (!state.db || !state.user) return;
    clearListeners();
    const uid = isAdmin() ? "" : getDriverUid();
    const unsubs = [
      listenCollection("billing_records", "records", uid),
      listenCollection("gastos", "expenses", uid),
      listenCollection("cierres_semanales", "closures", uid)
    ].filter(Boolean);
    state.unsubscribers.push(...unsubs);
    if (isAdmin()) fetchDrivers().then(render).catch(()=>{});
    console.info("EXPLORA_PAY_REALTIME", VERSION, reason);
  }

  function lastClosureMs(rows) {
    const done = rows
      .filter(row => safe(row.closureMode || row.periodType) === "on_demand")
      .filter(row => /confirmed|driver_uploaded|driver_confirmed_zero|completed|closed/i.test(safe(row.status || row.estado)))
      .map(row => Math.max(ms(row.driverUploadedAt), ms(row.confirmedAt), ms(row.closedAt), Number(row.driverUploadedAtMs || 0), Number(row.confirmedAtMs || 0), rowMs(row)))
      .filter(Boolean)
      .sort((a,b)=>b-a);
    return done[0] || 0;
  }

  function pendingClosureFor(uid = getDriverUid()) {
    const pending = state.closures
      .filter(row => safe(row.closureMode || row.periodType) === "on_demand")
      .filter(row => !uid || [row.driverUid,row.choferUid,row.uid].map(safe).includes(uid))
      .filter(row => !/confirmed|completed|closed|cancelled|canceled/i.test(safe(row.status || row.estado)))
      .sort((a,b)=>rowMs(b)-rowMs(a));
    return pending[0] || null;
  }

  function computeSummary({ records = state.records, expenses = state.expenses, closures = state.closures } = {}) {
    const resetMs = lastClosureMs(closures);
    const filteredRecords = records.filter(row => rowMs(row) >= resetMs);
    const filteredExpenses = expenses.filter(row => rowMs(row) >= resetMs);
    let gross = 0, cashInDriver = 0, nonCashInExplora = 0, driverShare = 0, exploraShare = 0;
    for (const row of filteredRecords) {
      const amount = amountOf(row);
      if (!(amount > 0)) continue;
      const method = methodOf(row);
      gross += amount;
      driverShare += amount * .5;
      exploraShare += amount * .5;
      if (method === "cash") cashInDriver += amount;
      else nonCashInExplora += amount;
    }
    let expenseTotal = 0, driverExpenseShare = 0, exploraExpenseShare = 0, expensesPaidByDriver = 0, expensesPaidByExplora = 0;
    for (const row of filteredExpenses) {
      const amount = amountOf(row);
      if (!(amount > 0)) continue;
      const sharedRate = Number.isFinite(Number(row.sharedRate ?? row.porcentajeCompartido))
        ? (Number(row.sharedRate ?? row.porcentajeCompartido) > 1 ? Number(row.sharedRate ?? row.porcentajeCompartido) / 100 : Number(row.sharedRate ?? row.porcentajeCompartido))
        : .5;
      const driverPart = amount * Math.min(1, Math.max(0, sharedRate || .5));
      const exploraPart = amount - driverPart;
      const payer = safe(row.payerRole || row.pagadoPorRol || row.paidByRole || row.pagadoPor || "driver").toLowerCase();
      expenseTotal += amount;
      driverExpenseShare += driverPart;
      exploraExpenseShare += exploraPart;
      if (/explora|admin|empresa|david/.test(payer)) expensesPaidByExplora += amount;
      else expensesPaidByDriver += amount;
    }
    const bonuses = 0;
    const penalties = 0;
    const loans = 0;
    const driverEntitlement = driverShare - driverExpenseShare + bonuses - penalties - loans;
    const driverActualCash = cashInDriver - expensesPaidByDriver;
    const exploraCash = nonCashInExplora - expensesPaidByExplora;
    const netSettlementToDriver = driverEntitlement - driverActualCash;
    const driverFinal = driverEntitlement;
    return {
      resetMs, records:filteredRecords, expenses:filteredExpenses,
      gross, cashInDriver, nonCashInExplora, driverShare, exploraShare,
      expenseTotal, driverExpenseShare, exploraExpenseShare, expensesPaidByDriver, expensesPaidByExplora,
      driverEntitlement, driverActualCash, exploraCash, netSettlementToDriver, driverFinal,
      amountToDriver:Math.max(0, netSettlementToDriver), amountFromDriver:Math.max(0, -netSettlementToDriver)
    };
  }

  function movementRows(summary = computeSummary()) {
    const rows = [];
    for (const row of summary.records) {
      const amount = amountOf(row), method = methodOf(row), at = rowMs(row);
      if (!(amount > 0)) continue;
      rows.push({
        at, type:"payment", title:`${dateShort(at)} · ${paymentLabel(method)}`,
        meta:safe(row.description || row.detalle || row.notes || row.ruta || "Servicio registrado"),
        detail: method === "cash"
          ? `Total cobrado: ${currency(amount)} · Efectivo en mano del chofer: +${currency(amount)} · Parte chofer: ${currency(amount*.5)} · Parte Explora: ${currency(amount*.5)}`
          : `Total cobrado: ${currency(amount)} · Recibido por Explora · Parte chofer a liquidar: ${currency(amount*.5)} · Parte Explora: ${currency(amount*.5)}`,
        amount, positive:true
      });
    }
    for (const row of summary.expenses) {
      const amount = amountOf(row), at = rowMs(row);
      if (!(amount > 0)) continue;
      const shared = Number.isFinite(Number(row.sharedRate ?? row.porcentajeCompartido)) ? (Number(row.sharedRate ?? row.porcentajeCompartido) > 1 ? Number(row.sharedRate ?? row.porcentajeCompartido)/100 : Number(row.sharedRate ?? row.porcentajeCompartido)) : .5;
      const driverPart = amount * Math.min(1, Math.max(0, shared || .5));
      const exploraPart = amount - driverPart;
      rows.push({
        at, type:"expense", title:`${dateShort(at)} · ${expenseTypeLabel(row)}`,
        meta:safe(row.notes || row.descripcion || "Gasto operativo"),
        detail:`Gasto total: -${currency(amount)} · Chofer: -${currency(driverPart)} · Explora: -${currency(exploraPart)} · Pagado por: ${/explora|admin|empresa|david/i.test(safe(row.payerRole || row.pagadoPorRol || row.pagadoPor)) ? "Explora" : "chofer"}`,
        amount:-amount, negative:true
      });
    }
    for (const row of state.closures.filter(r => safe(r.closureMode || r.periodType) === "on_demand")) {
      const at = rowMs(row);
      rows.push({
        at, type:"closure", title:`${dateShort(at)} · Cierre a demanda`,
        meta:safe(row.statusLabel || row.status || "Cierre solicitado"),
        detail:`A rendir: ${currency(row.amountDueFromDriver || 0)} · A cobrar: ${currency(row.amountDueToDriver || 0)}`,
        amount:0
      });
    }
    return rows.sort((a,b)=>b.at-a.at).slice(0,12);
  }

  function render() {
    installShell();
    const summary = computeSummary();
    state.latestSummary = summary;
    state.pendingClosure = pendingClosureFor();
    document.querySelectorAll("[data-pay-tab]").forEach(button => {
      const active = button.dataset.payTab === state.tab;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
    const greeting = $("payGreeting");
    if (greeting) greeting.textContent = `Hola, ${displayName()}`;
    renderMainCard(summary);
    renderClosureStatus(summary);
    renderActivities(summary);
    if ($("payClosureBackdrop")?.classList.contains("is-open")) renderClosureModal();
  }

  function renderMainCard(summary) {
    const amount = $("payMainAmount"), subtitle = $("payMainSubtitle"), pillLabel = $("payPillLabel"), pillAmount = $("payPillAmount"), extra = $("payExtraLines");
    if (!amount || !subtitle || !pillLabel || !pillAmount || !extra) return;
    let main = summary.gross, sub = `Facturado bruto del ciclo abierto`, pill = "Dinero a liquidar", pillValue = summary.amountToDriver;
    const lines = [];
    if (state.tab === "gastos") {
      main = summary.expenseTotal;
      sub = "Gastos totales del ciclo abierto";
      pill = "Gastos compartidos";
      pillValue = summary.expenseTotal;
      lines.push(["Chofer", `-${currency(summary.driverExpenseShare)}`], ["Explora", `-${currency(summary.exploraExpenseShare)}`]);
    } else if (state.tab === "explora") {
      main = summary.exploraCash;
      sub = "Dinero en mano de Explora";
      pill = summary.netSettlementToDriver > 0 ? "Explora debe pagar" : summary.netSettlementToDriver < 0 ? "Chofer debe rendir" : "Liquidación equilibrada";
      pillValue = abs(summary.netSettlementToDriver);
      lines.push(["Transferencia / QR / Tarjeta", currency(summary.nonCashInExplora)], ["Gastos pagados por Explora", `-${currency(summary.expensesPaidByExplora)}`]);
    } else if (state.tab === "chofer") {
      main = summary.driverFinal;
      sub = "Dinero final del chofer después de gastos";
      pill = summary.netSettlementToDriver > 0 ? "A cobrar de Explora" : summary.netSettlementToDriver < 0 ? "A rendir a Explora" : "Equilibrado";
      pillValue = abs(summary.netSettlementToDriver);
      lines.push(["Efectivo en mano", currency(summary.driverActualCash)], ["A cobrar de Explora", currency(summary.amountToDriver)], ["A rendir a Explora", currency(summary.amountFromDriver)]);
    } else {
      main = summary.gross;
      sub = "Facturado bruto del ciclo abierto";
      pill = summary.netSettlementToDriver > 0 ? "Dinero a liquidar por Explora" : summary.netSettlementToDriver < 0 ? "Chofer debe rendir a Explora" : "Liquidación equilibrada";
      pillValue = abs(summary.netSettlementToDriver);
      lines.push(["Efectivo en mano del chofer", currency(summary.driverActualCash)]);
    }
    amount.textContent = currency(main);
    subtitle.innerHTML = `${esc(sub)} <b>${summary.resetMs ? "desde último cierre" : "sin cierre previo"}</b>`;
    pillLabel.textContent = pill;
    pillAmount.textContent = currency(pillValue);
    extra.innerHTML = lines.map(([label,value]) => `<div><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join("");
  }

  function renderClosureStatus(summary) {
    const box = $("payClosureStatus"), text = $("payClosureStatusText"), action = $("payClosureActionBtn");
    if (!box || !text) return;
    const pending = state.pendingClosure;
    box.hidden = !pending;
    if (pending) {
      const due = number(pending.amountDueFromDriver || 0);
      const toDriver = number(pending.amountDueToDriver || 0);
      text.textContent = due > 0 ? `Transferencia pendiente por ${currency(due)}` : toDriver > 0 ? `Explora debe pagar ${currency(toDriver)}` : "Cierre equilibrado pendiente de confirmar";
    }
    if (action) action.querySelector("span").innerHTML = pending && !isAdmin() ? "Confirmar<br/>cierre" : "Pedir<br/>cierre";
  }

  function activityIcon(type) {
    if (type === "expense") return `<svg viewBox="0 0 24 24"><path d="M4 7.5h14.5A1.5 1.5 0 0 1 20 9v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h11"></path><path d="M16 12h5v4h-5a2 2 0 0 1 0-4Z"></path></svg>`;
    if (type === "closure") return `<svg viewBox="0 0 24 24"><path d="M7 3h7l4 4v14H7z"></path><path d="M14 3v5h5"></path></svg>`;
    return `<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"></path></svg>`;
  }

  function renderActivities(summary) {
    const list = $("payActivityList");
    if (!list) return;
    const rows = movementRows(summary);
    if (!rows.length) { list.innerHTML = `<div class="pay-activity-empty">Todavía no hay cobros ni gastos en el ciclo abierto.</div>`; return; }
    list.innerHTML = rows.map(row => `
      <article class="pay-activity">
        <span class="pay-activity-icon">${activityIcon(row.type)}</span>
        <div><div class="pay-activity-title">${esc(row.title)}</div><div class="pay-activity-meta">${esc(row.meta)}</div><div class="pay-activity-detail">${esc(row.detail)}</div></div>
        <strong class="pay-activity-amount ${row.positive ? "is-positive" : row.negative ? "is-negative" : ""}">${row.amount ? (row.amount > 0 ? "+" : "") + currency(row.amount) : ""}</strong>
      </article>
    `).join("");
  }

  async function computeDriverSummary(uid) {
    const [records, expenses, closures] = await Promise.all([
      getScopedDocs("billing_records", uid),
      getScopedDocs("gastos", uid),
      getScopedDocs("cierres_semanales", uid)
    ]);
    return computeSummary({ records, expenses, closures });
  }

  async function openClosureModal(mode = "request", closure = null) {
    if (state.busy) return;
    state.modalMode = mode;
    state.modalClosure = closure || state.pendingClosure || null;
    state.modalFile = null;
    const input = $("payClosureReceiptInput");
    if (input) input.value = "";
    $("payClosureBackdrop")?.classList.add("is-open");
    $("payClosureBackdrop")?.setAttribute("aria-hidden", "false");
    if (isAdmin()) await fetchDrivers();
    renderClosureModal();
  }

  function closeClosureModal() {
    $("payClosureBackdrop")?.classList.remove("is-open");
    $("payClosureBackdrop")?.setAttribute("aria-hidden", "true");
    state.modalFile = null;
    state.modalClosure = null;
    state.busy = false;
  }

  function setModalMessage(message = "", type = "") {
    const box = $("payClosureMessage");
    if (!box) return;
    box.textContent = message;
    box.className = `pay-closure-message ${type ? `is-${type}` : ""}`;
  }

  function renderDriverSelect() {
    const field = $("payClosureDriverField"), select = $("payClosureDriverSelect");
    if (!field || !select) return;
    field.hidden = !isAdmin() || state.modalMode !== "request";
    if (field.hidden) return;
    const options = [`<option value="">Elegir chofer…</option>`].concat(state.drivers.map(driver => `<option value="${esc(driver.uid)}">${esc(driver.name)}</option>`));
    select.innerHTML = options.join("");
  }

  function renderClosureModal() {
    renderDriverSelect();
    const title = $("payClosureTitle"), subtitle = $("payClosureSubtitle"), summary = $("payClosureSummary"), fileField = $("payClosureFileField"), submit = $("payClosureSubmit"), cancel = $("payClosureCancel");
    if (!title || !subtitle || !summary || !fileField || !submit || !cancel) return;
    const closure = state.modalClosure;
    const latest = state.latestSummary || computeSummary();
    fileField.hidden = true;
    cancel.textContent = "Cancelar";
    submit.className = "pay-closure-primary";
    if (state.modalMode === "confirm" && closure) {
      const due = number(closure.amountDueFromDriver || 0), toDriver = number(closure.amountDueToDriver || 0);
      title.textContent = "Confirmar cierre";
      subtitle.textContent = due > 0 ? "Transferí a Explora y cargá la foto del comprobante." : "El cierre no requiere transferencia del chofer.";
      fileField.hidden = !(due > 0);
      submit.textContent = due > 0 ? "Subir comprobante" : "Confirmar cierre";
      summary.innerHTML = `<article><span>Chofer debe rendir</span><strong>${currency(due)}</strong></article><article><span>Explora debe pagar</span><strong>${currency(toDriver)}</strong></article>`;
      return;
    }
    if (state.modalMode === "admin-review" && closure && isAdmin()) {
      const due = number(closure.amountDueFromDriver || 0), toDriver = number(closure.amountDueToDriver || 0);
      title.textContent = "Revisar cierre";
      subtitle.textContent = "Confirmá el cierre cuando el comprobante esté correcto.";
      submit.textContent = "Confirmar recibido";
      summary.innerHTML = `<article><span>Estado</span><strong>${esc(closure.status || "pendiente")}</strong></article><article><span>Chofer debe rendir</span><strong>${currency(due)}</strong></article><article><span>Explora debe pagar</span><strong>${currency(toDriver)}</strong></article>${closure.receiptUrl ? `<article><span>Comprobante</span><strong>cargado</strong></article>` : ""}`;
      return;
    }
    title.textContent = isAdmin() ? "Pedir cierre a un chofer" : "Pedir cierre";
    subtitle.textContent = isAdmin() ? "Elegí el chofer y se calculará el saldo abierto desde su último cierre." : "Se generará una solicitud de cierre con el saldo abierto actual.";
    submit.textContent = "Pedir cierre";
    summary.innerHTML = `<article><span>Bruto abierto</span><strong>${currency(latest.gross)}</strong></article><article><span>Gastos abiertos</span><strong>${currency(latest.expenseTotal)}</strong></article><article><span>A cobrar de Explora</span><strong>${currency(latest.amountToDriver)}</strong></article><article><span>A rendir a Explora</span><strong>${currency(latest.amountFromDriver)}</strong></article>`;
  }

  async function submitClosureModal() {
    if (state.busy) return;
    state.busy = true;
    setModalMessage("Procesando…");
    const submit = $("payClosureSubmit");
    const oldText = submit?.textContent || "Aceptar";
    if (submit) submit.textContent = "Procesando…";
    try {
      if (state.modalMode === "confirm" && state.modalClosure) await driverConfirmClosure(state.modalClosure);
      else if (state.modalMode === "admin-review" && state.modalClosure && isAdmin()) await adminConfirmClosure(state.modalClosure);
      else await requestClosure();
      setModalMessage("Listo.", "ok");
      setTimeout(closeClosureModal, 700);
    } catch (error) {
      console.error("EXPLORA_PAY_CLOSURE", error);
      setModalMessage(error?.message || "No se pudo completar el cierre.", "error");
    } finally {
      state.busy = false;
      if (submit) submit.textContent = oldText;
    }
  }

  async function requestClosure() {
    const user = state.auth?.currentUser;
    if (!user?.uid) throw new Error("No hay sesión activa.");
    let targetUid = getDriverUid();
    let targetName = displayName();
    if (isAdmin()) {
      targetUid = safe($("payClosureDriverSelect")?.value);
      const driver = state.drivers.find(d => d.uid === targetUid);
      if (!targetUid || !driver) throw new Error("Elegí un chofer para pedir el cierre.");
      targetName = driver.name;
    }
    const pending = pendingClosureFor(targetUid);
    if (pending) throw new Error("Ese chofer ya tiene un cierre pendiente.");
    const summary = isAdmin() ? await computeDriverSummary(targetUid) : (state.latestSummary || computeSummary());
    await addDoc(collection(state.db, "cierres_semanales"), {
      closureMode:"on_demand",
      periodType:"on_demand",
      status:"requested",
      estado:"solicitado",
      statusLabel:"Cierre solicitado",
      driverUid:targetUid,
      choferUid:targetUid,
      uid:targetUid,
      driverName:targetName,
      requestedByUid:user.uid,
      requestedByName:displayName(),
      requestedByRole:isAdmin() ? "admin" : "driver",
      gross:Number(summary.gross || 0),
      expenseTotal:Number(summary.expenseTotal || 0),
      cashInDriver:Number(summary.driverActualCash || 0),
      exploraCash:Number(summary.exploraCash || 0),
      netSettlementToDriver:Number(summary.netSettlementToDriver || 0),
      amountDueFromDriver:Number(summary.amountFromDriver || 0),
      amountDueToDriver:Number(summary.amountToDriver || 0),
      cycleStartedAtMs:Number(summary.resetMs || 0),
      requestedAtMs:Date.now(),
      requestedAt:serverTimestamp(),
      createdAt:serverTimestamp(),
      updatedAt:serverTimestamp(),
      version:VERSION
    });
  }

  function extensionForFile(file) {
    const byName = safe(file?.name).match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() || "";
    if (byName) return byName === "jpeg" ? "jpg" : byName;
    const mime = safe(file?.type).toLowerCase();
    if (mime.includes("png")) return "png";
    if (mime.includes("webp")) return "webp";
    if (mime.includes("pdf")) return "pdf";
    return "jpg";
  }

  async function uploadClosureReceipt(closure, file) {
    if (!state.storage) throw new Error("Storage no está disponible.");
    if (!(file instanceof File) || !(file.size > 0)) throw new Error("Seleccioná una foto o PDF del comprobante.");
    if (file.size > 15 * 1024 * 1024) throw new Error("El comprobante supera 15 MB.");
    const ext = extensionForFile(file);
    const closureId = safe(closure.id || closure.closureId || `cierre_${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, "_");
    const driverUid = safe(closure.driverUid || closure.uid || getDriverUid());
    const path = `gastos/${driverUid}/${closureId}/cierre-a-demanda.${ext}`;
    const ref = storageRef(state.storage, path);
    await uploadBytes(ref, file, { contentType:file.type || (ext === "pdf" ? "application/pdf" : "image/jpeg"), customMetadata:{ module:"on_demand_closure", driverUid, closureId, uploadedByUid:state.auth?.currentUser?.uid || "" } });
    const url = await getDownloadURL(ref);
    return { url, path, ext };
  }

  async function driverConfirmClosure(closure) {
    const due = number(closure.amountDueFromDriver || 0);
    let receipt = null;
    if (due > 0) receipt = await uploadClosureReceipt(closure, state.modalFile);
    const ref = doc(state.db, "cierres_semanales", closure.id);
    await updateDoc(ref, {
      status: due > 0 ? "driver_uploaded" : "driver_confirmed_zero",
      estado: due > 0 ? "comprobante_cargado" : "confirmado_sin_transferencia",
      statusLabel: due > 0 ? "Comprobante cargado por chofer" : "Confirmado por chofer",
      receiptUrl:receipt?.url || closure.receiptUrl || null,
      receiptPath:receipt?.path || closure.receiptPath || null,
      receiptUploadedAt:receipt ? serverTimestamp() : null,
      receiptUploadedAtMs:receipt ? Date.now() : null,
      driverUploadedAt:serverTimestamp(),
      driverUploadedAtMs:Date.now(),
      updatedAt:serverTimestamp()
    });
  }

  async function adminConfirmClosure(closure) {
    if (!closure?.id) throw new Error("No se pudo identificar el cierre.");
    await updateDoc(doc(state.db, "cierres_semanales", closure.id), {
      status:"confirmed",
      estado:"confirmado",
      statusLabel:"Cierre confirmado por Explora",
      confirmedByUid:state.auth?.currentUser?.uid || "",
      confirmedByName:displayName(),
      confirmedAt:serverTimestamp(),
      confirmedAtMs:Date.now(),
      updatedAt:serverTimestamp()
    });
  }

  async function refreshSession(user) {
    state.user = user || state.auth?.currentUser || null;
    const session = window.ExploraSession || {};
    state.role = safe(session.role || session.profile?.role || session.profile?.rol || "driver").toLowerCase() || "driver";
    state.profile = session.profile || {};
    state.profileDocumentId = session.profileDocumentId || session.driverId || state.user?.uid || "";
    render();
    startRealtime("session");
  }

  async function boot() {
    try {
      installShell(); bindShell();
      await waitFirebase();
      onAuthStateChanged(state.auth, user => refreshSession(user));
      window.addEventListener("explora:session-opened", () => refreshSession(state.auth?.currentUser));
      window.addEventListener("explora:auth-cleared", () => { clearListeners(); state.user = null; });
      setTimeout(() => refreshSession(state.auth?.currentUser), 1200);
    } catch (error) {
      console.warn("EXPLORA_PAY_BOOT", error?.message || error);
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once:true });
  else boot();
  window.ExploraPagoHome = Object.freeze({ version:VERSION, render, openClosureModal, computeSummary });
})();
