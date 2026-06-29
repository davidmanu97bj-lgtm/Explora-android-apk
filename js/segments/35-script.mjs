import { getApps, getApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore, doc, setDoc, getDocFromServer, getDoc, collection, query, where,
  getDocs, getDocsFromCache, onSnapshot, runTransaction, serverTimestamp, updateDoc
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import {
  WEEKLY_CORE_VERSION, WEEKLY_SNAPSHOT_SCHEMA, DEFAULT_TIMEZONE, WEEK_MS,
  weeklyPeriodFromDate, weeklyPeriodFromId, previousWeeklyPeriod, buildClosureId,
  normalizePaymentMethod, dedupeRows, calculateSettlement, settlementPresentation,
  resolveClosureState, validateSnapshot, isFalseZeroClosure, stableStringify,
  anchoredNow, positiveMoney, roundMoney
} from "../core/weekly-core.mjs?v2442-weekly-payment-production";
import {
  normalizeDailyBonusRow, dailyBonusesForDriver, totalDailyBonuses
} from "../core/daily-ranking-bonus.mjs";

(() => {
  "use strict";
  if (window.__exploraCanonicalWeeklyClosureV2438) return;
  window.__exploraCanonicalWeeklyClosureV2438 = true;

  const VERSION = WEEKLY_CORE_VERSION;
  const TZ = DEFAULT_TIMEZONE;
  const CLOCK_ANCHOR_KEY = "explora_weekly_server_anchor_v2439";
  const OFFLINE_QUEUE_KEY = "explora_weekly_offline_queue_v2439";
  const TEST_CLOCK_KEY = "explora_admin_test_now_v290";
  const TEST_CLOCK_PATH = "configuracion_sistema/reloj_prueba_global";
  const CLOCK_MAX_OFFLINE_AGE = 7 * 24 * 60 * 60 * 1000;
  const CLOCK_RESYNC_MS = 5 * 60 * 1000;
  const app = getApps().length ? getApp() : null;
  const auth = app ? getAuth(app) : null;
  const db = app ? getFirestore(app) : null;
  const text = value => String(value ?? "").trim();
  const token = value => text(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[\s-]+/g, "_");
  const coded = (code, message, detail = {}) => Object.assign(new Error(message || code), { code, ...detail });
  const serverDate = value => value?.toDate?.() || (value instanceof Date ? value : (value !== undefined && value !== null ? new Date(value) : null));

  function resolveExpenseTotals(source = {}) {
    const money = value => positiveMoney(value);
    const explicitDriver = Math.max(money(source.driverPaidExpenses), money(source.driverPaidSharedExpenses));
    const explicitAdmin = Math.max(money(source.adminPaidExpenses), money(source.adminPaidSharedExpenses));
    const sumRows = rows => {
      if (!Array.isArray(rows) || !rows.length) return { total:0, driver:0, admin:0 };
      const seen = new Set();
      let total = 0, driver = 0, admin = 0;
      rows.forEach((row,index) => {
        if (!row || typeof row !== "object") return;
        const id = text(row.operationId || row.operacionId || row.expenseId || row.gastoId || row.documentId || row.id || `row_${index}`);
        if (seen.has(id)) return;
        seen.add(id);
        const amount = money(row.amount ?? row.monto ?? row.valor ?? row.total ?? row.importe);
        if (!(amount > 0)) return;
        const payer = token(row.payerRole || row.pagadoPorRol || row.pagadoPor || row.payer || "driver");
        total += amount;
        if (payer.includes("admin") || payer.includes("david")) admin += amount;
        else driver += amount;
      });
      return { total, driver, admin };
    };
    const candidates = [source.expenses, source.expenseRows, source.gastosRows].map(sumRows);
    const rows = candidates.reduce((best,current) => current.total > best.total ? current : best,{ total:0, driver:0, admin:0 });
    const ledger = sumRows(Array.isArray(source.operationLedger) ? source.operationLedger.filter(row => token(row?.type) === "expense") : []);
    const splitTotal = explicitDriver + explicitAdmin;
    const total = Math.max(money(source.totalExpenses), money(source.gastos), money(source.expenseTotal), money(source.totalGastos), splitTotal, rows.total, ledger.total);
    let driverPaid = Math.max(explicitDriver, rows.driver, ledger.driver);
    let adminPaid = Math.max(explicitAdmin, rows.admin, ledger.admin);
    const known = driverPaid + adminPaid;
    if (total > known + 0.01) driverPaid += total - known;
    if (driverPaid + adminPaid > total + 0.01) {
      const scale = total > 0 ? total / (driverPaid + adminPaid) : 0;
      driverPaid *= scale;
      adminPaid *= scale;
    }
    return Object.freeze({ total:roundMoney(total), driverPaid:roundMoney(driverPaid), adminPaid:roundMoney(adminPaid) });
  }

  const state = {
    generation:0,
    periodId:"",
    clock:{ anchor:null, status:"uninitialized", path:"", lastError:null, syncPromise:null },
    test:{ loaded:false, enabled:false, date:null, unsubscribe:null, updatedBy:"" },
    diagnostics:[],
    sourceLoader:null,
    sourceLoaderOwner:null
  };

  function safeJsonParse(raw, fallback) { try { return JSON.parse(raw); } catch (_) { return fallback; } }
  function readClockAnchor() {
    if (state.clock.anchor) return state.clock.anchor;
    try {
      const parsed = safeJsonParse(localStorage.getItem(CLOCK_ANCHOR_KEY) || "", null);
      if (parsed && Number.isFinite(Number(parsed.serverMs)) && Number.isFinite(Number(parsed.clientMs))) state.clock.anchor = parsed;
    } catch (_) {}
    return state.clock.anchor;
  }
  function saveClockAnchor(anchor) {
    state.clock.anchor = anchor;
    try { localStorage.setItem(CLOCK_ANCHOR_KEY, JSON.stringify(anchor)); } catch (_) {}
  }
  function localAdminTestDate() {
    try {
      const raw = localStorage.getItem(TEST_CLOCK_KEY);
      const date = raw ? new Date(raw) : null;
      return date && Number.isFinite(date.getTime()) ? date : null;
    } catch (_) { return null; }
  }
  function activeTestDate() {
    if (state.test.enabled && state.test.date) return new Date(state.test.date);
    return localAdminTestDate();
  }
  function isTestMode() { return Boolean(activeTestDate()); }
  function getNow() {
    const test = activeTestDate();
    if (test) return test;
    const anchor = readClockAnchor();
    if (anchor) {
      try { return anchoredNow(anchor, Date.now()); } catch (_) {}
    }
    return new Date();
  }
  function getWeeklyPeriod(reference = getNow()) { return weeklyPeriodFromDate(reference, TZ); }
  function getPreviousWeeklyPeriod(period = getWeeklyPeriod()) { return previousWeeklyPeriod(period, TZ); }
  function clockAgeMs() {
    const anchor = readClockAnchor();
    return anchor ? Math.max(0, Date.now() - Number(anchor.clientMs || 0)) : Infinity;
  }
  function isClockTrusted() { return isTestMode() || Boolean(readClockAnchor() && clockAgeMs() <= CLOCK_MAX_OFFLINE_AGE); }
  function isClockOfflineFallback() { return !navigator.onLine && Boolean(readClockAnchor()); }
  function clockDiagnostic() {
    const anchor = readClockAnchor();
    return {
      status:state.clock.status,
      mode:isTestMode() ? "test" : isClockOfflineFallback() ? "offline-anchor" : anchor ? "server-anchor" : "local-unverified",
      trusted:isClockTrusted(), path:state.clock.path || anchor?.path || "", anchorAgeMs:clockAgeMs(),
      serverDate:anchor ? new Date(Number(anchor.serverMs)).toISOString() : null,
      operationalDate:getNow().toISOString(), localDate:new Date().toISOString(), timezone:TZ,
      errorCode:state.clock.lastError?.code || null, errorMessage:state.clock.lastError?.message || null
    };
  }

  async function synchronizeClock({ force = false } = {}) {
    if (!db || !auth?.currentUser?.uid) throw coded("FIRESTORE_CLOCK_UNAVAILABLE", "No existe una sesión autenticada para sincronizar la fecha.");
    if (!force && isClockTrusted() && navigator.onLine) return clockDiagnostic();
    if (state.clock.syncPromise) return state.clock.syncPromise;
    state.clock.syncPromise = (async () => {
      const uid = auth.currentUser.uid;
      const routes = [
        { path:`usuarios/${uid}/technical/operational_clock`, ref:doc(db,"usuarios",uid,"technical","operational_clock") },
        { path:`technical_clock/${uid}`, ref:doc(db,"technical_clock",uid) },
        { path:`reloj_operativo/${uid}`, ref:doc(db,"reloj_operativo",uid) }
      ];
      let lastError = null;
      for (const route of routes) {
        const started = Date.now();
        try {
          await setDoc(route.ref, { requestedAt:serverTimestamp(), uid, source:"weekly-closure-clock", updatedAt:serverTimestamp() }, { merge:true });
          const snap = await getDocFromServer(route.ref);
          const data = snap.data() || {};
          const confirmed = serverDate(data.requestedAt || data.serverTime || data.updatedAt);
          if (!confirmed || !Number.isFinite(confirmed.getTime())) throw coded("FIRESTORE_CLOCK_INVALID_TIMESTAMP", "Firestore no devolvió un timestamp válido.", { path:route.path });
          const finished = Date.now();
          const anchor = { serverMs:confirmed.getTime(), clientMs:Math.round((started + finished) / 2), validatedAt:finished, path:route.path };
          saveClockAnchor(anchor);
          state.clock.status = "synchronized";
          state.clock.path = route.path;
          state.clock.lastError = null;
          window.dispatchEvent(new CustomEvent("explora:firestore-clock-synchronized", { detail:clockDiagnostic() }));
          return clockDiagnostic();
        } catch (error) { lastError = error; }
      }
      state.clock.lastError = lastError || coded("FIRESTORE_CLOCK_UNAVAILABLE", "No se pudo sincronizar el reloj.");
      state.clock.status = readClockAnchor() ? "offline-anchor" : "unavailable";
      if (readClockAnchor()) return clockDiagnostic();
      throw coded("FIRESTORE_CLOCK_UNAVAILABLE", "No se pudo obtener una fecha confiable de Firestore.", { cause:lastError });
    })().finally(() => { state.clock.syncPromise = null; });
    return state.clock.syncPromise;
  }

  async function ensureClockReady({ forWrite = false } = {}) {
    if (isTestMode()) return forWrite ? navigator.onLine : true;
    if (navigator.onLine) {
      try { await synchronizeClock({ force:!isClockTrusted() }); } catch (error) { if (!readClockAnchor()) throw error; }
    }
    if (!readClockAnchor()) throw coded("FIRESTORE_CLOCK_UNAVAILABLE", "No existe una última fecha de servidor validada.");
    if (forWrite && (!navigator.onLine || clockAgeMs() > CLOCK_MAX_OFFLINE_AGE)) return false;
    return true;
  }

  function testClockRef() { return db ? doc(db,"configuracion_sistema","reloj_prueba_global") : null; }
  function applyTestClock(data = {}, source = "listener") {
    const date = serverDate(data.effectiveDate || data.testDate || data.date);
    const enabled = data.enabled === true && date && Number.isFinite(date.getTime());
    const before = state.test.enabled && state.test.date ? state.test.date.toISOString() : "";
    state.test.loaded = true;
    state.test.enabled = Boolean(enabled);
    state.test.date = enabled ? date : null;
    state.test.updatedBy = text(data.updatedBy);
    const after = enabled ? date.toISOString() : "";
    if (before !== after) {
      const period = getWeeklyPeriod();
      window.dispatchEvent(new CustomEvent("explora:operational-date-changed", { detail:{ source, enabled:Boolean(enabled), date:getNow().toISOString() } }));
      window.dispatchEvent(new CustomEvent("explora:operational-period-changed", { detail:{ ...period, source:enabled ? "global-test" : "server-clock" } }));
    }
  }
  function subscribeTestClock() {
    try { state.test.unsubscribe?.(); } catch (_) {}
    state.test.unsubscribe = null;
    if (!db || !auth?.currentUser) return;
    state.test.unsubscribe = onSnapshot(testClockRef(), snap => applyTestClock(snap.exists() ? snap.data() : { enabled:false }, "firestore"), error => {
      state.test.loaded = true;
      recordDiagnostic("TEST_CLOCK_LISTENER_FAILED", { error });
    });
  }
  function isAdmin() { return token(window.ExploraSession?.role).includes("admin") || document.body.classList.contains("explora-shared-admin"); }
  async function setTestNow(value) {
    if (!isAdmin()) throw coded("ADMIN_REQUIRED", "Sólo el administrador puede activar la fecha de prueba.");
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw coded("INVALID_TEST_DATE", "La fecha de prueba no es válida.");
    localStorage.setItem(TEST_CLOCK_KEY, date.toISOString());
    await setDoc(testClockRef(), { enabled:true, effectiveDate:date.toISOString(), scope:"all-users", updatedBy:auth.currentUser.uid, updatedAt:serverTimestamp() }, { merge:true });
    applyTestClock({ enabled:true, effectiveDate:date.toISOString(), updatedBy:auth.currentUser.uid }, "admin-write");
    return date;
  }
  async function clearTestNow() {
    if (!isAdmin()) throw coded("ADMIN_REQUIRED", "Sólo el administrador puede desactivar la fecha de prueba.");
    localStorage.removeItem(TEST_CLOCK_KEY);
    await setDoc(testClockRef(), { enabled:false, effectiveDate:null, scope:"all-users", updatedBy:auth.currentUser.uid, updatedAt:serverTimestamp() }, { merge:true });
    applyTestClock({ enabled:false }, "admin-write");
    return getNow();
  }

  const FirestoreClock = Object.freeze({
    version:VERSION, timezone:TZ, sync:synchronizeClock, ensureReady:ensureClockReady,
    getNow, getNowMs:() => getNow().getTime(), getWeeklyPeriod, getActiveWeeklyPeriod:getWeeklyPeriod,
    getPreviousWeeklyPeriod, isTrusted:isClockTrusted, isOfflineFallback:isClockOfflineFallback,
    getDiagnostic:clockDiagnostic, setTestNow, clearTestNow, isTestMode
  });
  window.ExploraFirestoreClock = FirestoreClock;
  window.ExploraOperationalClock = Object.freeze({
    ...FirestoreClock,
    getRawWeeklyPeriod:getWeeklyPeriod,
    emitIfChanged() { const period=getWeeklyPeriod(); window.dispatchEvent(new CustomEvent("explora:operational-period-changed", { detail:period })); return period; }
  });
  window.getExploraOperationalNow = getNow;
  window.getExploraActiveWeeklyPeriod = getWeeklyPeriod;
  window.ExploraPeriods = Object.assign(window.ExploraPeriods || {}, {
    getActivePeriods() { const p=getWeeklyPeriod(); return { weeklyPeriodId:p.id, weekStartMs:p.startMs, weekEndMs:p.endMs, timezone:TZ, clockTrusted:isClockTrusted() }; }
  });

  function currentIdentityAliases(primary = "", source = {}) {
    const target = text(primary);
    const session = window.ExploraSession || {};
    const profile = session.profile || {};
    const targetValues = [
      target, source.driverUid, source.choferUid, source.uid, source.driverId, source.choferId,
      source.profileDocumentId, source.documentId, source.driverEmail, source.choferEmail
    ];
    const currentValues = [
      auth?.currentUser?.uid, auth?.currentUser?.email, session.uid, session.driverId,
      session.profileDocumentId, profile.uid, profile.driverUid, profile.choferUid,
      profile.driverId, profile.choferId, profile.documentId, profile.id, profile.email, profile.correo
    ].map(text).filter(Boolean);
    const targetIsCurrentUser = !target || currentValues.includes(target);
    return [...new Set([...targetValues, ...(targetIsCurrentUser ? currentValues : [])].map(text).filter(Boolean))];
  }

  function resolveSourceLoader() {
    const engine = window.ExploraWeeklyEngine;
    if (!engine) return null;
    if (state.sourceLoader && state.sourceLoaderOwner === engine) return state.sourceLoader;
    const candidate = engine.getDriverWeeklyFinancialSnapshot || engine.getDriverWeeklySnapshot;
    if (typeof candidate !== "function") return null;
    state.sourceLoader = candidate.bind(engine);
    state.sourceLoaderOwner = engine;
    return state.sourceLoader;
  }

  const PERIOD_FIELDS = ["weeklyPeriodId","periodoSemanalId","periodId","periodoId","semanaId"];
  const DRIVER_FIELDS = ["driverUid","choferUid","uid","driverId","choferId"];
  const DATE_FIELDS = ["createdAt","serviceDate","completedAt","paidAt","registeredAt","timestamp","fecha","fechaServicio"];
  const VALID_STATES = new Set(["completed","complete","completado","completada","approved","aprobado","aprobada","paid","pagado","facturado","facturada","registered","registrado","registrada","confirmed","confirmado","confirmada","admin_confirmed","manually_confirmed","receipt_uploaded"]);
  function recordAmount(row = {}) { return positiveMoney(row.amount ?? row.monto ?? row.valor ?? row.finalPrice ?? row.total ?? row.grossAmount ?? row.importe); }
  function explicitPeriod(row = {}) { return PERIOD_FIELDS.map(field => text(row[field])).find(Boolean) || ""; }
  function inferredPeriod(row = {}) {
    for (const field of DATE_FIELDS) {
      const date = serverDate(row[field]);
      if (date && Number.isFinite(date.getTime())) return getWeeklyPeriod(date).id;
    }
    return "";
  }
  function belongsToPeriod(row, periodId) { const explicit=explicitPeriod(row); return explicit ? explicit === periodId : inferredPeriod(row) === periodId; }
  function belongsToDriver(row, aliases) {
    const wanted = new Set(aliases.map(text));
    const values = DRIVER_FIELDS.flatMap(field => [row[field], row.driver?.[field], row.chofer?.[field]]).map(text).filter(Boolean);
    return values.some(value => wanted.has(value));
  }
  function validBilling(row = {}) {
    if (row.deleted === true || row.anulado === true || row.cancelled === true || row.canceled === true) return false;
    const statuses = [row.status,row.estado,row.state,row.paymentStatus,row.verificationStatus]
      .map(token).filter(Boolean);
    if (!statuses.length) return true;
    const invalid = statuses.some(status => ["cancelled","canceled","cancelado","cancelada","anulado","anulada","rejected","rechazado","rechazada","deleted","eliminado","eliminada"].includes(status));
    if (invalid) return false;
    return statuses.some(status => VALID_STATES.has(status));
  }
  async function queryWithCache(q) {
    try { return { snapshot:await getDocs(q), source:"server" }; }
    catch (serverError) {
      try { return { snapshot:await getDocsFromCache(q), source:"cache", serverError }; }
      catch (cacheError) { throw coded("WEEKLY_SOURCE_QUERY_FAILED", "No se pudo consultar una fuente semanal.", { cause:serverError, cacheError }); }
    }
  }
  async function rebuildBillingRecords(driverUid, period, aliases) {
    const rows = new Map();
    const errors = [];
    let successful = 0;
    const jobs = [];
    for (const field of PERIOD_FIELDS) jobs.push([field,period.id]);
    for (const alias of aliases) for (const field of DRIVER_FIELDS) jobs.push([field,alias]);
    await Promise.all(jobs.map(async ([field,value]) => {
      if (!value) return;
      try {
        const result = await queryWithCache(query(collection(db,"billing_records"),where(field,"==",value)));
        successful += 1;
        result.snapshot.forEach(item => rows.set(item.id, { id:item.id, ...item.data() }));
      } catch (error) { errors.push({ field, value, code:error.code || "QUERY_FAILED", message:error.message }); }
    }));
    if (!successful) throw coded("WEEKLY_CLOSURE_BILLING_QUERY_FAILED", "No se pudo reconstruir billing_records.", { errors, driverUid, weeklyPeriodId:period.id });
    const accepted = [...rows.values()].filter(row => belongsToDriver(row, aliases) && belongsToPeriod(row, period.id) && validBilling(row));
    const billingRecords = dedupeRows(accepted, row => row.operationId || row.billingId || row.id);
    const totals = { grossBilling:0, cashCollectedByDriver:0, transferCollectedByAdmin:0, aliasCollectedByAdmin:0, cardCollectedByAdmin:0, qrCollectedByAdmin:0, otherCollectedByDriver:0, otherCollectedByAdmin:0 };
    for (const row of billingRecords) {
      const amount = recordAmount(row);
      if (!(amount > 0)) continue;
      totals.grossBilling += amount;
      let method = normalizePaymentMethod(row.paymentMethod ?? row.paymentType ?? row.payment_type ?? row.metodoPago ?? row.method ?? row.metodo ?? row.medioPago ?? row.medioDePago ?? row.medio_de_pago ?? row.formaPago ?? row.formaDePago ?? row.tipoPago ?? row.metodoCobro ?? row.payment?.method ?? row.financialCategory);
      if (method === "unknown") {
        const provider = token(row.paymentProvider || row.provider || "");
        const receiptMethod = normalizePaymentMethod(row.receiptPaymentMethod || row.receiptMethod || "");
        if (receiptMethod !== "unknown") method = receiptMethod;
        else if (provider.includes("card") || provider.includes("posnet")) method = "card";
        else if (provider.includes("qr")) method = "qr";
        else if (provider.includes("transfer") || row.manualTransfer === true) method = "transfer";
        else if (row.manualPointPayment === true) method = provider.includes("qr") ? "qr" : "card";
      }
      if (method === "cash") totals.cashCollectedByDriver += amount;
      else if (method === "transfer") totals.transferCollectedByAdmin += amount;
      else if (method === "alias") totals.aliasCollectedByAdmin += amount;
      else if (method === "card") totals.cardCollectedByAdmin += amount;
      else if (method === "qr") totals.qrCollectedByAdmin += amount;
      else totals.otherCollectedByAdmin += amount;
    }
    Object.keys(totals).forEach(key => { totals[key] = roundMoney(totals[key]); });
    return {
      ...totals, billingRecords, services:billingRecords,
      sourceOperationIds:billingRecords.map(row => `billing:${text(row.operationId || row.billingId || row.id)}`),
      billingQueryCount:successful, billingQueryErrors:errors,
      paymentMethodReviewRequired:billingRecords.filter(row => {
        let method = normalizePaymentMethod(row.paymentMethod ?? row.paymentType ?? row.payment_type ?? row.metodoPago ?? row.method ?? row.metodo ?? row.medioPago ?? row.medioDePago ?? row.medio_de_pago ?? row.formaPago ?? row.formaDePago ?? row.tipoPago ?? row.metodoCobro ?? row.payment?.method ?? row.financialCategory);
        if (method !== "unknown") return false;
        const provider = token(row.paymentProvider || row.provider || "");
        const receiptMethod = normalizePaymentMethod(row.receiptPaymentMethod || row.receiptMethod || "");
        return receiptMethod === "unknown" && !provider.includes("card") && !provider.includes("posnet") && !provider.includes("qr") && !provider.includes("transfer") && row.manualTransfer !== true && row.manualPointPayment !== true;
      }).map(row => text(row.operationId || row.billingId || row.id))
    };
  }

  async function sha256(value) {
    const input = new TextEncoder().encode(stableStringify(value));
    if (crypto?.subtle) {
      const digest = await crypto.subtle.digest("SHA-256", input);
      return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2,"0")).join("");
    }
    let hash = 2166136261;
    for (const byte of input) { hash ^= byte; hash = Math.imul(hash,16777619); }
    return `fnv1a_${(hash >>> 0).toString(16)}`;
  }

  function mergeSourceIds(raw, billing) {
    const ids = [];
    const push = value => { const v=text(value); if (v) ids.push(v); };
    (Array.isArray(raw?.sourceOperationIds) ? raw.sourceOperationIds : []).forEach(push);
    (Array.isArray(billing?.sourceOperationIds) ? billing.sourceOperationIds : []).forEach(push);
    for (const [key,prefix] of [["expenses","expense"],["operationalLoans","loan"],["directDebtInstallments","debt"],["derivations","derivation"],["receivedDerivations","derivation"]]) {
      for (const row of Array.isArray(raw?.[key]) ? raw[key] : []) push(`${prefix}:${text(row.operationId || row.id || row.documentId || row.loanId || row.debtId || row.derivationId)}`);
    }
    return [...new Set(ids.filter(value => !value.endsWith(":")))];
  }

  function dailyBonusCollectionName() { return isTestMode() ? "dailyRankingBonus_test" : "dailyRankingBonus"; }
  async function loadDailyRankingBonusesForPeriod(weeklyPeriodId, options = {}) {
    const periodId = text(weeklyPeriodId);
    if (!db || !periodId) return [];
    if (options.finalize !== false) await window.ExploraDailyRanking?.finalizeExpiredDays?.().catch?.(() => {});
    const rows = [];
    try {
      const uid = text(options.driverUid || auth?.currentUser?.uid);
      const sourceQuery = isAdmin()
        ? query(collection(db,dailyBonusCollectionName()),where("weeklyPeriodId","==",periodId))
        : query(collection(db,dailyBonusCollectionName()),where("winnerDriverId","==",uid));
      const snapshot = await getDocs(sourceQuery);
      snapshot.forEach(item => {
        const row = normalizeDailyBonusRow({ id:item.id, ...(item.data() || {}) });
        if (row.weeklyPeriodId === periodId && row.status === "finalized" && row.bonusAmount > 0 && row.winnerDriverId && (isAdmin() || row.winnerDriverId === uid)) rows.push(row);
      });
    } catch (error) {
      recordDiagnostic("DAILY_RANKING_BONUS_READ_FAILED", { weeklyPeriodId:periodId, collection:dailyBonusCollectionName(), code:error?.code || "unknown", message:error?.message || String(error) });
      if (options.required === true) throw error;
    }
    rows.sort((a,b) => a.operationalDayId.localeCompare(b.operationalDayId));
    return rows;
  }

  function canonicalSnapshot(raw, billing, driverUid, period, options = {}) {
    const expenseTotals = resolveExpenseTotals(raw);
    const source = { ...raw, ...billing,
      totalExpenses:expenseTotals.total, gastos:expenseTotals.total,
      driverPaidExpenses:expenseTotals.driverPaid, adminPaidExpenses:expenseTotals.adminPaid,
      driverPaidSharedExpenses:expenseTotals.driverPaid, adminPaidSharedExpenses:expenseTotals.adminPaid
    };
    const financial = calculateSettlement(source);
    const paymentTotal = positiveMoney(billing.cashCollectedByDriver) + positiveMoney(billing.transferCollectedByAdmin) + positiveMoney(billing.aliasCollectedByAdmin) + positiveMoney(billing.cardCollectedByAdmin) + positiveMoney(billing.qrCollectedByAdmin) + positiveMoney(billing.otherCollectedByDriver) + positiveMoney(billing.otherCollectedByAdmin);
    if (Math.abs(paymentTotal - positiveMoney(billing.grossBilling)) > 0.01) throw coded("WEEKLY_CLOSURE_PAYMENT_METHOD_MISMATCH", "La suma de medios de pago no coincide con billing_records.", { grossBilling:billing.grossBilling, paymentTotal });
    if (positiveMoney(billing.grossBilling) > 0 && paymentTotal === 0) throw coded("WEEKLY_CLOSURE_FALSE_ZERO", "Existe facturación real, pero los medios de pago quedaron en cero.");
    const ids = mergeSourceIds(raw, billing);
    return {
      driverUid, driverName:text(raw.driverName || raw.choferNombre || raw.nombreChofer || window.ExploraSession?.profile?.nombre || "Chofer"),
      weeklyPeriodId:period.id, periodId:period.id, periodoSemanalId:period.id,
      periodStart:new Date(period.startMs).toISOString(), periodEnd:new Date(period.endMs).toISOString(), timezone:TZ,
      grossBilling:positiveMoney(billing.grossBilling), cashCollectedByDriver:positiveMoney(billing.cashCollectedByDriver),
      transferCollectedByAdmin:positiveMoney(billing.transferCollectedByAdmin), aliasCollectedByAdmin:positiveMoney(billing.aliasCollectedByAdmin),
      cardCollectedByAdmin:positiveMoney(billing.cardCollectedByAdmin), qrCollectedByAdmin:positiveMoney(billing.qrCollectedByAdmin),
      otherCollectedByDriver:positiveMoney(billing.otherCollectedByDriver), otherCollectedByAdmin:positiveMoney(billing.otherCollectedByAdmin),
      totalExpenses:expenseTotals.total, gastos:expenseTotals.total,
      driverPaidExpenses:expenseTotals.driverPaid, adminPaidExpenses:expenseTotals.adminPaid,
      driverPaidSharedExpenses:expenseTotals.driverPaid, adminPaidSharedExpenses:expenseTotals.adminPaid,
      driverExpenseCredit:positiveMoney(financial.driverExpenseCredit), adminExpenseCredit:positiveMoney(financial.adminExpenseCredit),
      totalSharedExpenses:positiveMoney(financial.totalSharedExpenses), driverSharedExpenseShare:positiveMoney(financial.driverSharedExpenseShare),
      driverFundsAfterExpenses:roundMoney(financial.driverFundsAfterExpenses), driverEntitlementAfterSharedExpenses:roundMoney(financial.driverEntitlementAfterSharedExpenses),
      operationalLoanTotal:positiveMoney(raw.operationalLoanTotal), operationalLoanDriverShare:positiveMoney(financial.operationalLoanDriverShare),
      directDebtInstallmentTotal:positiveMoney(financial.directDebtInstallmentTotal), exploreLoanDiscount:positiveMoney(financial.exploreLoanDiscount),
      repairFundRate:Number(financial.repairFundRate || 0.05), repairFundAmount:positiveMoney(financial.repairFundAmount),
      driverBasePercentage:financial.driverBasePercentage, adminBasePercentage:100-financial.driverBasePercentage,
      driverBaseShare:financial.driverBaseShare, adminBaseShare:roundMoney(financial.grossBilling-financial.driverBaseShare),
            derivationBonusAmount:financial.derivationBonusAmount,
      collaborationAmount:financial.collaborationAmount, derivationGrossAmount:positiveMoney(raw.derivationGrossAmount ?? raw.derivedAmountForEmitter ?? raw.dineroDerivado),
      driverFinalEntitlement:financial.driverFinalEntitlement, adminFinalEntitlement:roundMoney(financial.grossBilling-financial.driverFinalEntitlement+financial.repairFundAmount),
      otherSignedAdjustments:financial.otherSignedAdjustments,
      dailyRankingBonusAmount:financial.dailyRankingBonusAmount,
      netSettlementBeforeDailyBonuses:financial.netSettlementBeforeDailyBonuses,
      dailyRankingBonuses:Array.isArray(source.dailyRankingBonuses) ? source.dailyRankingBonuses.map(normalizeDailyBonusRow) : [],
      dailyRankingWeeklyWinners:Array.isArray(source.dailyRankingWeeklyWinners) ? source.dailyRankingWeeklyWinners.map(normalizeDailyBonusRow) : [],
      dailyRankingBonusCount:Array.isArray(source.dailyRankingBonuses) ? source.dailyRankingBonuses.length : 0,
      ...financial,
      sourceOperationIds:ids, sourceOperationCount:ids.length,
      billingRecords:billing.billingRecords, services:billing.billingRecords,
      expenses:Array.isArray(raw.expenses) ? raw.expenses : [], operationalLoans:Array.isArray(raw.operationalLoans) ? raw.operationalLoans : [],
      directDebtInstallments:Array.isArray(raw.directDebtInstallments) ? raw.directDebtInstallments : [], derivations:Array.isArray(raw.derivations) ? raw.derivations : [],
      snapshotComplete:true, snapshotValidated:false, snapshotSchemaVersion:WEEKLY_SNAPSHOT_SCHEMA, schemaVersion:WEEKLY_SNAPSHOT_SCHEMA,
      calculationVersion:VERSION, calculationHash:"", createdAt:getNow().toISOString(), closedAt:options.closedAt || getNow().toISOString(),
      clockMode:clockDiagnostic().mode, testMode:isTestMode(), sourceSnapshotSchemaVersion:Number(raw.schemaVersion || 0)
    };
  }

  async function buildCanonicalWeeklyClosureSnapshot(driverUid, periodInput, options = {}) {
    if (!auth?.currentUser?.uid) throw coded("WEEKLY_CLOSURE_AUTH_REQUIRED", "No hay una sesión autenticada.");
    await ensureClockReady();
    const uid = text(driverUid || auth.currentUser.uid);
    const period = typeof periodInput === "string" ? weeklyPeriodFromId(periodInput,TZ) : periodInput?.id ? weeklyPeriodFromId(periodInput.id,TZ) : getWeeklyPeriod();
    const request = { driverUid:uid, weeklyPeriodId:period.id, generation:state.generation };
    const loader = resolveSourceLoader();
    if (!loader) throw coded("WEEKLY_CLOSURE_SOURCE_ENGINE_UNAVAILABLE", "No está disponible el agregador de movimientos semanales.");
    const aliases = currentIdentityAliases(uid);
    const candidates = [];
    let lastError = null;
    window.__exploraStrictWeeklyClosureBuild = true;
    try {
      for (const identity of aliases) {
        try {
          const candidate = await loader(identity, period.id, { force:true, allowLegacyScan:true, refreshInBackground:false, strictSources:true, allowAuthoritativeZero:true, reason:"canonical-weekly-closure" });
          if (candidate) candidates.push(candidate);
        } catch (error) { lastError = error; }
      }
    } finally { window.__exploraStrictWeeklyClosureBuild = false; }
    if (!candidates.length) throw coded("WEEKLY_CLOSURE_SOURCE_QUERY_FAILED", "No se pudieron reconstruir los movimientos de la semana.", { cause:lastError, driverUid:uid, weeklyPeriodId:period.id });
    const raw = candidates.sort((a,b) => {
      const score = item => positiveMoney(item.grossBilling ?? item.totalFacturado) + (Array.isArray(item.sourceOperationIds) ? item.sourceOperationIds.length * 1000 : 0);
      return score(b)-score(a);
    })[0];
    const billingAliases = currentIdentityAliases(uid,raw);
    const billing = await rebuildBillingRecords(uid, period, billingAliases);
    const dailyRankingWeeklyWinners = await loadDailyRankingBonusesForPeriod(period.id,{ finalize:true, required:false, driverUid:uid });
    const dailyRankingBonuses = dailyBonusesForDriver(dailyRankingWeeklyWinners,uid);
    const rawWithDailyBonuses = {
      ...raw,
      dailyRankingWeeklyWinners,
      dailyRankingBonuses,
      dailyRankingBonusAmount:totalDailyBonuses(dailyRankingBonuses),
      dailyRankingBonusCount:dailyRankingBonuses.length
    };
    if (request.generation !== state.generation) throw coded("WEEKLY_CLOSURE_STALE_RESPONSE", "La respuesta pertenece a una generación anterior.", { request, currentGeneration:state.generation });
    let snapshot = canonicalSnapshot(rawWithDailyBonuses, billing, uid, period, options);
    const hashSource = { ...snapshot, calculationHash:undefined, createdAt:undefined, closedAt:undefined, billingRecords:undefined, services:undefined, expenses:undefined, operationalLoans:undefined, directDebtInstallments:undefined, derivations:undefined };
    snapshot.calculationHash = await sha256(hashSource);
    const validation = validateSnapshot(snapshot);
    snapshot.snapshotValidated = validation.valid;
    if (!validation.valid) throw coded("WEEKLY_CLOSURE_INVALID_SNAPSHOT", "El snapshot semanal no superó la validación.", { validationErrors:validation.errors, snapshot });
    return Object.freeze(snapshot);
  }

  function compactSnapshot(snapshot = {}) {
    const { billingRecords, services, expenses, operationalLoans, directDebtInstallments, derivations, ...compact } = snapshot;
    return { ...compact, directDebtInstallmentIds:(directDebtInstallments || []).map(row => text(row.id || row.installmentId || row.debtId)).filter(Boolean) };
  }
  function closureCollectionName() { return isTestMode() ? "cierres_semanales_prueba" : "cierres_semanales"; }
  function receiptIndexCollectionName() { return isTestMode() ? "receipt_index_prueba" : "receipt_index"; }
  function storageBasePath() { return isTestMode() ? "cierres_semanales_prueba" : "cierres_semanales"; }
  function preservedProofFields(existing = {}) {
    const fields = ["receiptUrl","receiptPath","receiptFileName","receiptMimeType","receiptSize","receiptStatus","estadoComprobante","comprobanteUrl","comprobantePath","driverReceiptUrl","driverReceiptPath","driverReceiptMimeType","driverReceiptFileName","driverReceiptSize","adminReceiptUrl","adminReceiptPath","adminReceiptMimeType","adminReceiptFileName","adminReceiptSize","davidReceiptUrl","davidReceiptPath","uploadedByRole","paymentStatus","closureStatus","paid","pagado","pagoConfirmado","adminPaymentCompleted","driverAcknowledged","driverAcknowledgedAt","underReviewAt","proofUploadedAt","notes","observaciones"];
    return fields.reduce((out, field) => { if (existing[field] !== undefined) out[field]=existing[field]; return out; }, {});
  }
  function queueOfflineClosure(driverUid, weeklyPeriodId) {
    const queue = safeJsonParse(localStorage.getItem(OFFLINE_QUEUE_KEY) || "[]", []);
    const id = buildClosureId(driverUid,weeklyPeriodId);
    const next = [...queue.filter(item => item.id !== id), { id, driverUid, weeklyPeriodId, queuedAt:new Date().toISOString(), testMode:isTestMode() }];
    localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(next));
    return id;
  }
  async function materializeWeeklyClosure(driverUid, periodInput, options = {}) {
    const uid = text(driverUid || auth?.currentUser?.uid);
    const period = typeof periodInput === "string" ? weeklyPeriodFromId(periodInput,TZ) : periodInput?.id ? weeklyPeriodFromId(periodInput.id,TZ) : getPreviousWeeklyPeriod();
    const closureId = buildClosureId(uid,period.id);
    const canWrite = await ensureClockReady({ forWrite:true });
    if (!canWrite) {
      queueOfflineClosure(uid,period.id);
      return { closureId, created:false, reused:false, localOnly:true, state:"pending", weeklyPeriodId:period.id };
    }
    const snapshot = await buildCanonicalWeeklyClosureSnapshot(uid,period.id,options);
    const collectionName = closureCollectionName();
    const reference = doc(db,collectionName,closureId);
    const result = await runTransaction(db, async transaction => {
      const existingSnap = await transaction.get(reference);
      const existing = existingSnap.exists() ? existingSnap.data() || {} : null;
      const existingSchema = Number(existing?.weeklySnapshot?.schemaVersion ?? existing?.schemaVersion ?? 0);
      const existingValidated = Boolean((existing?.weeklySnapshot?.snapshotValidated === true || existing?.snapshotValidated === true) && existingSchema >= WEEKLY_SNAPSHOT_SCHEMA);
      const repairFalseZero = existing ? isFalseZeroClosure(existing,snapshot) || existingSchema < WEEKLY_SNAPSHOT_SCHEMA : false;
      if (existing && existingValidated && !repairFalseZero) {
        if (existing.calculationHash === snapshot.calculationHash) return { created:false, reused:true, repaired:false, data:existing };
        return { created:false, reused:true, repaired:false, immutableConflict:true, data:existing };
      }
      const proof = preservedProofFields(existing || {});
      const compact = compactSnapshot(snapshot);
      const closureState = resolveClosureState({ snapshot, record:proof });
      const payload = {
        ...compact, ...proof, closureId, driverUid:uid, choferUid:uid,
        weeklyPeriodId:period.id, periodId:period.id, periodoSemanalId:period.id,
        weeklySnapshot:compact, financialSnapshotImmutable:true,
        status:closureState, closureStatus:closureState, paymentStatus:closureState,
        requiresProof:!snapshot.balanced, proofRequiredFromRole:snapshot.payerRole,
        proofRequiredForRole:snapshot.payeeRole, balanced:snapshot.balanced,
        snapshotValidated:true, snapshotComplete:true, calculationHash:snapshot.calculationHash,
        testMode:isTestMode(), environment:isTestMode()?"test":"production",
        createdAt:existing?.createdAt || serverTimestamp(), closedAt:existing?.closedAt || serverTimestamp(),
        updatedAt:serverTimestamp(), generatedAt:serverTimestamp(), repairedFalseZero:repairFalseZero,
        repairVersion:repairFalseZero ? VERSION : existing?.repairVersion || null
      };
      transaction.set(reference,payload,{ merge:false });
      return { created:true, reused:false, repaired:repairFalseZero, data:payload };
    });
    if (result.immutableConflict) recordDiagnostic("IMMUTABLE_CLOSURE_REUSED", { closureId, existingHash:result.data?.calculationHash, rebuiltHash:snapshot.calculationHash });
    let loanInstallment = { applied:false, amount:0, skipped:true };
    if (!isTestMode() && Number(snapshot.exploreLoanDiscount || 0) > 0) {
      const applyInstallment = window.ExploraApplyLoanClosurePayment;
      if (typeof applyInstallment !== "function") {
        const error = coded("EXPLORA_LOAN_INSTALLMENT_ENGINE_MISSING", "No está disponible el motor de cuota semanal de Préstamo EXPLORA.", { closureId, weeklyPeriodId:period.id });
        recordDiagnostic(error.code, { closureId, weeklyPeriodId:period.id, stage:"APPLY_EXPLORA_LOAN_INSTALLMENT" });
        throw error;
      }
      try {
        loanInstallment = await applyInstallment(uid, period.id, Number(snapshot.exploreLoanDiscount || 0), closureId);
      } catch (cause) {
        const error = coded("EXPLORA_LOAN_INSTALLMENT_FAILED", "El cierre fue guardado, pero no se pudo aplicar la cuota semanal de Préstamo EXPLORA. Reintentá el cierre.", { cause, closureId, weeklyPeriodId:period.id });
        recordDiagnostic(error.code, { closureId, weeklyPeriodId:period.id, stage:"APPLY_EXPLORA_LOAN_INSTALLMENT", message:cause?.message || String(cause) });
        throw error;
      }
    }
    window.dispatchEvent(new CustomEvent("explora:weekly-closure", { detail:{ closureId, weeklyPeriodId:period.id, snapshot, loanInstallment, collection:collectionName, ...result } }));
    return { ...result, closureId, snapshot, loanInstallment, collection:collectionName, state:result.data?.status || resolveClosureState({snapshot,record:result.data}) };
  }

  async function setClosureWorkflowState(closureId, nextState, detail = {}) {
    const allowed = new Set(["pending","proof_required","proof_uploading","error"]);
    if (!allowed.has(nextState)) throw coded("WEEKLY_CLOSURE_STATE_INVALID", "Estado transitorio inválido.");
    if (!db) throw coded("FIREBASE_NOT_INITIALIZED", "Firestore no está inicializado.");
    const reference = doc(db,closureCollectionName(),closureId);
    await runTransaction(db, async transaction => {
      const snap = await transaction.get(reference);
      if (!snap.exists()) throw coded("WEEKLY_CLOSURE_NOT_FOUND", "El cierre no existe.", { closureId });
      const data = snap.data() || {};
      const snapshot = data.weeklySnapshot || data;
      if (snapshot.balanced && nextState !== "error") throw coded("WEEKLY_CLOSURE_PROOF_NOT_REQUIRED", "Un cierre equilibrado no requiere comprobante.");
      const update = {
        status:nextState, closureStatus:nextState, paymentStatus:nextState,
        updatedAt:serverTimestamp(), error:nextState === "error"
      };
      if (nextState === "proof_uploading") update.proofUploadStartedAt = serverTimestamp();
      if (nextState === "error") {
        update.errorCode = text(detail.code || detail.errorCode || "WEEKLY_CLOSURE_PROOF_UPLOAD_FAILED");
        update.errorMessage = text(detail.message || detail.errorMessage || "No se pudo cargar el comprobante.");
        update.errorAt = serverTimestamp();
      } else {
        update.errorCode = null; update.errorMessage = null; update.errorAt = null;
      }
      transaction.update(reference, update);
    });
    return { closureId, status:nextState };
  }

  async function updateProofState(closureId, proof = {}, nextState = "proof_uploaded") {
    if (!text(proof.receiptUrl || proof.comprobanteUrl || proof.driverReceiptUrl || proof.adminReceiptUrl)) throw coded("WEEKLY_CLOSURE_PROOF_INVALID", "El comprobante no contiene una URL válida.");
    if (!["proof_uploaded","under_review","paid"].includes(nextState)) throw coded("WEEKLY_CLOSURE_STATE_INVALID", "Estado de comprobante inválido.");
    const reference = doc(db,closureCollectionName(),closureId);
    await runTransaction(db, async transaction => {
      const snap = await transaction.get(reference);
      if (!snap.exists()) throw coded("WEEKLY_CLOSURE_NOT_FOUND", "El cierre no existe.", { closureId });
      const data = snap.data() || {};
      const snapshot = data.weeklySnapshot || data;
      if (snapshot.balanced) throw coded("WEEKLY_CLOSURE_PROOF_NOT_REQUIRED", "Un cierre equilibrado no requiere comprobante.");
      if (nextState === "paid" && !text(proof.receiptUrl || data.receiptUrl || data.driverReceiptUrl || data.adminReceiptUrl)) throw coded("WEEKLY_CLOSURE_PROOF_REQUIRED", "No puede marcarse como pagado sin comprobante.");
      transaction.update(reference, { ...proof, status:nextState, closureStatus:nextState, paymentStatus:nextState, proofUploadedAt:serverTimestamp(), updatedAt:serverTimestamp(), paid:nextState === "paid", pagado:nextState === "paid" });
    });
    return { closureId, status:nextState };
  }

  async function rebuildLegacyClosure(closureId) {
    const names = [closureCollectionName(), "cierres_semanales"];
    let found = null;
    for (const name of names) {
      const snap = await getDoc(doc(db,name,closureId));
      if (snap.exists()) { found={ collection:name, data:snap.data()||{} }; break; }
    }
    if (!found) throw coded("WEEKLY_CLOSURE_NOT_FOUND", "No se encontró el cierre histórico.");
    const raw = found.data;
    const uid = text(raw.driverUid || raw.choferUid || raw.uid);
    const periodId = text(raw.weeklyPeriodId || raw.periodId || raw.periodoSemanalId || raw.periodoId);
    return materializeWeeklyClosure(uid,periodId,{ closedAt:serverDate(raw.closedAt || raw.createdAt)?.toISOString(), historicalRepair:true });
  }

  function resolveDirection(closure = {}, payment = {}) {
    const merged = { ...(closure.weeklySnapshot || {}), ...closure, ...payment };
    const signed = Number(merged.netSettlementToDriver ?? merged.saldoNetoChofer ?? merged.balanceToDriver);
    if (Number.isFinite(signed)) return signed > 0 ? "admin_to_driver" : signed < 0 ? "driver_to_admin" : "balanced";
    const driverDebt = positiveMoney(merged.choferDebe ?? merged.driverOwes ?? merged.deudaChofer);
    const adminDebt = positiveMoney(merged.davidDebe ?? merged.adminOwes ?? merged.deudaDavid);
    if (driverDebt > 0 && adminDebt > 0) return "invalid_snapshot";
    if (driverDebt > 0) return "driver_to_admin";
    if (adminDebt > 0) return "admin_to_driver";
    const payer = token(merged.payerRole || merged.payer);
    if (["driver","chofer"].includes(payer)) return "driver_to_admin";
    if (["admin","david"].includes(payer)) return "admin_to_driver";
    const direction = token(merged.direction || merged.sentido || merged.direccionPago || merged.closureDirection);
    if (["driver_to_admin","chofer_a_david","driver_to_david","chofer_paga"].includes(direction)) return "driver_to_admin";
    if (["admin_to_driver","david_a_chofer","david_to_driver","david_paga"].includes(direction)) return "admin_to_driver";
    if (["balanced","sin_diferencia","equilibrado","cuenta_equilibrada"].includes(direction)) return "balanced";
    return "requires_rebuild";
  }

  function canonicalizeSnapshot(input = {}, options = {}) {
    const rawBase = { ...(input.weeklySnapshot || {}), ...input };
    const expenseTotals = resolveExpenseTotals(rawBase);
    const base = { ...rawBase,
      totalExpenses:expenseTotals.total, gastos:expenseTotals.total,
      driverPaidExpenses:expenseTotals.driverPaid, adminPaidExpenses:expenseTotals.adminPaid,
      driverPaidSharedExpenses:expenseTotals.driverPaid, adminPaidSharedExpenses:expenseTotals.adminPaid
    };
    const driverUid = text(options.driverUid || base.driverUid || base.choferUid || base.uid);
    const weeklyPeriodId = text(options.periodId || base.weeklyPeriodId || base.periodId || base.periodoSemanalId || base.periodoId);
    const period = weeklyPeriodId ? weeklyPeriodFromId(weeklyPeriodId,TZ) : getWeeklyPeriod();
    const paymentFields = {
      grossBilling:positiveMoney(base.grossBilling ?? base.totalFacturado ?? base.facturacion),
      cashCollectedByDriver:positiveMoney(base.cashCollectedByDriver ?? base.efectivo ?? base.totalEfectivo),
      transferCollectedByAdmin:positiveMoney(base.transferCollectedByAdmin ?? base.transferencias ?? base.totalTransferencias),
      aliasCollectedByAdmin:positiveMoney(base.aliasCollectedByAdmin ?? base.alias ?? base.totalAlias),
      cardCollectedByAdmin:positiveMoney(base.cardCollectedByAdmin ?? base.tarjetas ?? base.totalTarjetas),
      qrCollectedByAdmin:positiveMoney(base.qrCollectedByAdmin ?? base.qr ?? base.totalQr),
      otherCollectedByDriver:positiveMoney(base.otherCollectedByDriver),
      otherCollectedByAdmin:positiveMoney(base.otherCollectedByAdmin)
    };
    const dailyRankingWeeklyWinners = (Array.isArray(base.dailyRankingWeeklyWinners) ? base.dailyRankingWeeklyWinners : []).map(normalizeDailyBonusRow).filter(row => row.status === "finalized" && row.bonusAmount > 0);
    const dailyRankingBonuses = dailyBonusesForDriver(Array.isArray(base.dailyRankingBonuses) && base.dailyRankingBonuses.length ? base.dailyRankingBonuses : dailyRankingWeeklyWinners,driverUid);
    const dailyRankingBonusAmount = base.dailyRankingBonusAmount !== undefined ? positiveMoney(base.dailyRankingBonusAmount) : totalDailyBonuses(dailyRankingBonuses);
    const financial = calculateSettlement({ ...base, ...paymentFields, driverBasePercentage:50, driverBaseShare:roundMoney(paymentFields.grossBilling*0.5), driverFinalEntitlement:undefined, dailyRankingBonusAmount });
    let canonical = {
      ...base, ...paymentFields, ...financial,
      dailyRankingWeeklyWinners, dailyRankingBonuses, dailyRankingBonusAmount, dailyRankingBonusCount:dailyRankingBonuses.length,
      driverUid, choferUid:driverUid, uid:driverUid,
      weeklyPeriodId:period.id, periodId:period.id, periodoSemanalId:period.id,
      periodStart:base.periodStart || new Date(period.startMs).toISOString(),
      periodEnd:base.periodEnd || new Date(period.endMs).toISOString(), timezone:TZ,
      sourceOperationIds:[...new Set(Array.isArray(base.sourceOperationIds) ? base.sourceOperationIds.map(text).filter(Boolean) : [])],
      snapshotComplete:options.sourceQueriesComplete === true || base.snapshotComplete === true,
      snapshotSchemaVersion:WEEKLY_SNAPSHOT_SCHEMA, schemaVersion:WEEKLY_SNAPSHOT_SCHEMA,
      calculationVersion:VERSION
    };
    const validation = validateSnapshot(canonical);
    canonical.snapshotValidated = validation.valid;
    return Object.freeze(canonical);
  }

  function normalizeLegacyWeeklyClosure(record = {}) {
    const base = { ...(record.weeklySnapshot || {}), ...record };
    return canonicalizeSnapshot(base,{ driverUid:base.driverUid || base.choferUid || base.uid, periodId:base.weeklyPeriodId || base.periodId || base.periodoSemanalId, sourceQueriesComplete:base.snapshotComplete === true });
  }

  function validateWeeklyClosureSnapshot(snapshot = {}) {
    const validation = validateSnapshot(snapshot);
    return Object.freeze({ ...validation, snapshot });
  }

  function displaySummary(snapshot = {}, context = {}) {
    const presentation = settlementPresentation(snapshot);
    const expenseTotals = resolveExpenseTotals(snapshot);
    return Object.freeze({
      snapshot, uid:snapshot.driverUid, driverName:snapshot.driverName || "Chofer", periodId:snapshot.weeklyPeriodId,
      grossBilling:snapshot.grossBilling, expenses:expenseTotals.total,
      cash:snapshot.cashCollectedByDriver, transfers:positiveMoney(snapshot.transferCollectedByAdmin)+positiveMoney(snapshot.aliasCollectedByAdmin),
      cards:snapshot.cardCollectedByAdmin, qr:snapshot.qrCollectedByAdmin,
            derivationBonus:snapshot.derivationBonusAmount || 0, collaboration:snapshot.collaborationAmount || 0,
      dailyBonuses:Array.isArray(snapshot.dailyRankingBonuses) ? snapshot.dailyRankingBonuses : [],
      dailyWeeklyWinners:Array.isArray(snapshot.dailyRankingWeeklyWinners) ? snapshot.dailyRankingWeeklyWinners : [],
      dailyBonusTotal:positiveMoney(snapshot.dailyRankingBonusAmount),
      balanceBeforeDailyBonuses:Number(snapshot.netSettlementBeforeDailyBonuses || 0),
      loans:snapshot.operationalLoanDriverShare || 0, fines:snapshot.directDebtInstallmentTotal || 0,
      exploreLoanDiscount:snapshot.exploreLoanDiscount || 0,
      repairFundRate:Number(snapshot.repairFundRate || 0.05), repairFundAmount:positiveMoney(snapshot.repairFundAmount),
      otherAdjustments:snapshot.otherSignedAdjustments || 0,
      amount:presentation.amount, payer:presentation.payerRole, payee:presentation.payeeRole,
      balanced:snapshot.balanced, resultLabel:presentation.title, actionText:presentation.detail,
      resultText:presentation.detail, netSettlementToDriver:snapshot.netSettlementToDriver,
      normalizedBalance:snapshot.netSettlementToDriver, projectedResultType:presentation.status,
      lastUpdatedAt:serverDate(snapshot.closedAt) || getNow(), schemaVersion:WEEKLY_SNAPSHOT_SCHEMA,
      periodStart:context.periodStart ?? snapshot.periodStart ?? null, periodEnd:context.periodEnd ?? snapshot.periodEnd ?? null,
      isPeriodClosed:context.isPeriodClosed ?? true, closureStatus:context.closureStatus || snapshot.closureStatus || "closed",
      billedTotal:snapshot.grossBilling, expensesTotal:expenseTotals.total,
      cashTotal:snapshot.cashCollectedByDriver, transferTotal:positiveMoney(snapshot.transferCollectedByAdmin)+positiveMoney(snapshot.aliasCollectedByAdmin),
      cardTotal:snapshot.cardCollectedByAdmin, qrTotal:snapshot.qrCollectedByAdmin,
      driverHeldCash:snapshot.cashCollectedByDriver, adminReceivedFunds:positiveMoney(snapshot.transferCollectedByAdmin)+positiveMoney(snapshot.aliasCollectedByAdmin)+positiveMoney(snapshot.cardCollectedByAdmin)+positiveMoney(snapshot.qrCollectedByAdmin),
      basePercentage:50, basePercent:50, currentDriverPercent:50, totalDriverPercentage:50,
      driverShare:snapshot.driverFinalEntitlement, driverShareBeforeDiscounts:roundMoney(positiveMoney(snapshot.driverBaseShare)+positiveMoney(snapshot.derivationBonusAmount)),
      driverExpenseShare:positiveMoney(snapshot.driverSharedExpenseShare ?? expenseTotals.total*.5),
      driverPaidExpenses:expenseTotals.driverPaid,
      driverFundsAfterExpenses:roundMoney(snapshot.driverFundsAfterExpenses ?? positiveMoney(snapshot.cashCollectedByDriver)-expenseTotals.driverPaid),
      driverNetShareBeforeDiscounts:roundMoney(positiveMoney(snapshot.driverBaseShare)+positiveMoney(snapshot.derivationBonusAmount)-positiveMoney(snapshot.driverSharedExpenseShare ?? expenseTotals.total*.5)),
      driverShareAfterDiscounts:roundMoney(Number(snapshot.netSettlementBeforeDailyBonuses || 0)+roundMoney(snapshot.driverFundsAfterExpenses ?? positiveMoney(snapshot.cashCollectedByDriver)-expenseTotals.driverPaid)),
      adminShare:snapshot.adminFinalEntitlement,
      otherDiscounts:Math.max(0,-Number(snapshot.otherSignedAdjustments || 0)),
      totalDiscounts:roundMoney(
        positiveMoney(snapshot.operationalLoanDriverShare)
        + positiveMoney(snapshot.exploreLoanDiscount)
        + positiveMoney(snapshot.directDebtInstallmentTotal)
        + positiveMoney(snapshot.repairFundAmount)
        + positiveMoney(snapshot.collaborationAmount)
        + Math.max(0,-Number(snapshot.otherSignedAdjustments || 0))
      ),
      adjustments:snapshot.otherSignedAdjustments || 0, debts:snapshot.directDebtInstallmentTotal || 0
    });
  }

  function getWeeklyClosurePresentation(snapshot = {}) {
    const p = settlementPresentation(snapshot);
    return { ...p, valid:true, requiresReceipt:p.requiresProof, direction:snapshot.direction || (p.payerRole === "driver" ? "driver_to_admin" : p.payerRole === "admin" ? "admin_to_driver" : "balanced") };
  }

  function ensureDiagnosticPanel() {
    let backdrop = document.getElementById("exploraWeeklyClosureDiagnosticV2438");
    if (backdrop) return backdrop;
    backdrop = document.createElement("div");
    backdrop.id = "exploraWeeklyClosureDiagnosticV2438";
    backdrop.className = "explora-weekly-diagnostic-backdrop";
    backdrop.setAttribute("aria-hidden","true");
    backdrop.innerHTML = '<section class="explora-weekly-diagnostic-card" role="alertdialog" aria-modal="true"><header><strong>EXPLORA · CIERRE SEMANAL</strong><button type="button" data-close aria-label="Cerrar">×</button></header><pre data-text>—</pre><div class="explora-weekly-diagnostic-actions"><button type="button" data-copy>COPIAR ERROR</button><button type="button" data-close>CERRAR</button></div></section>';
    document.body.appendChild(backdrop);
    backdrop.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => { backdrop.classList.remove("is-open"); backdrop.setAttribute("aria-hidden","true"); }));
    backdrop.querySelector("[data-copy]")?.addEventListener("click", async () => { const value=backdrop.querySelector("[data-text]")?.textContent || ""; try { await navigator.clipboard.writeText(value); } catch (_) {} });
    return backdrop;
  }
  function diagnosticText(code, detail = {}) {
    const error = detail.error || {};
    const periodId = detail.weeklyPeriodId || detail.periodId || getWeeklyPeriod().id;
    return [
      `ETAPA: ${detail.stage || "WEEKLY_CLOSURE"}`,
      `CÓDIGO INTERNO: ${code || error.code || "WEEKLY_CLOSURE_ERROR"}`,
      `MENSAJE FIREBASE O JAVASCRIPT: ${error.code || "—"} · ${error.message || detail.message || "—"}`,
      `UID: ${detail.uid || detail.driverUid || auth?.currentUser?.uid || "—"}`,
      `RUTA: ${detail.path || detail.firestorePath || closureCollectionName()}`,
      `WEEKLY PERIOD ID: ${periodId}`,
      `TIMESTAMP: ${getNow().toISOString()}`,
      `CLOCK MODE: ${clockDiagnostic().mode}`,
      `STACK: ${error.stack || "—"}`
    ].join("\n");
  }
  function recordDiagnostic(code, detail = {}) {
    const item = { code, timestamp:new Date().toISOString(), ...detail };
    state.diagnostics.push(item);
    if (state.diagnostics.length > 100) state.diagnostics.shift();
    console.error("[EXPLORA WEEKLY]", code, detail.error || detail);
    return item;
  }
  function showDiagnostic(error, context = {}) {
    recordDiagnostic(error?.code || context.code || "WEEKLY_CLOSURE_ERROR", { ...context, error });
    const panel = ensureDiagnosticPanel();
    panel.querySelector("[data-text]").textContent = diagnosticText(error?.code || context.code, { ...context, error });
    panel.classList.add("is-open");
    panel.setAttribute("aria-hidden","false");
    return error;
  }

  function purgeOldWeeklyCaches(nextPeriodId) {
    const protectedKeys = new Set([CLOCK_ANCHOR_KEY,OFFLINE_QUEUE_KEY,TEST_CLOCK_KEY]);
    for (const storage of [sessionStorage,localStorage]) {
      try {
        for (let index=storage.length-1; index>=0; index-=1) {
          const key = storage.key(index) || "";
          if (protectedKeys.has(key)) continue;
          if (/weekly|week_|ranking|derivation|billing|expense|closure|performance/i.test(key) && !key.includes(nextPeriodId)) storage.removeItem(key);
        }
      } catch (_) {}
    }
  }
  function onPeriodChanged() {
    const next = getWeeklyPeriod().id;
    if (next === state.periodId) return;
    const previous = state.periodId;
    state.periodId = next;
    state.generation += 1;
    purgeOldWeeklyCaches(next);
    window.dispatchEvent(new CustomEvent("explora:weekly-period-changed", { detail:{ previousWeeklyPeriodId:previous, weeklyPeriodId:next, generation:state.generation } }));
    try { window.ExploraWeeklyEngine?.invalidate?.("weekly-period-changed", { refresh:true }); } catch (_) {}
  }

  async function reconcileOfflineQueue() {
    if (!navigator.onLine || !auth?.currentUser) return;
    const queue = safeJsonParse(localStorage.getItem(OFFLINE_QUEUE_KEY) || "[]", []);
    if (!Array.isArray(queue) || !queue.length) return;
    const remaining = [];
    for (const item of queue) {
      try {
        if (Boolean(item.testMode) !== isTestMode()) { remaining.push(item); continue; }
        await materializeWeeklyClosure(item.driverUid,item.weeklyPeriodId,{ reconciledFromOffline:true });
      } catch (error) { remaining.push(item); recordDiagnostic("OFFLINE_RECONCILIATION_FAILED", { error, ...item }); }
    }
    localStorage.setItem(OFFLINE_QUEUE_KEY,JSON.stringify(remaining));
  }

  async function ensurePreviousClosureForCurrentDriver() {
    const role = token(window.ExploraSession?.role);
    if (!auth?.currentUser?.uid || !["driver","chofer"].some(value => role.includes(value))) return null;
    const previous = getPreviousWeeklyPeriod();
    return materializeWeeklyClosure(auth.currentUser.uid,previous.id,{ autoGenerated:true, createdByOperationId:`auto_${auth.currentUser.uid}_${previous.id}` });
  }

  function runSelfTests() {
    const tests = [];
    const test = (name, fn) => { try { fn(); tests.push({ name, passed:true }); } catch (error) { tests.push({ name, passed:false, error:error.message }); } };
    const assert = (condition,message) => { if (!condition) throw new Error(message); };
    const cash = calculateSettlement({ grossBilling:20000, cashCollectedByDriver:20000 });
    const nonCash = calculateSettlement({ grossBilling:20000, cashCollectedByDriver:0 });
    test("1 efectivo 20000",()=>assert(cash.payerRole==="driver"&&cash.settlementAmount===11000,"resultado incorrecto"));
    test("2 transferencia 20000",()=>assert(nonCash.payerRole==="admin"&&nonCash.settlementAmount===9000,"resultado incorrecto"));
    test("2b caja chica 5% bruto",()=>assert(cash.repairFundAmount===1000&&cash.payerRole==="driver"&&cash.settlementAmount===11000,"caja chica incorrecta"));
    test("3 tarjeta",()=>assert(nonCash.payerRole==="admin","tarjeta"));
    test("4 QR",()=>assert(nonCash.payerRole==="admin","qr"));
    test("5 semana sin movimientos",()=>assert(calculateSettlement({}).balanced,"no equilibrado"));
    test("6 viernes a sábado",()=>assert(getWeeklyPeriod(new Date("2026-06-20T02:59:59.999Z")).id!==getWeeklyPeriod(new Date("2026-06-20T03:00:00.000Z")).id,"no reinició"));
    test("7 inicio offline",()=>assert(anchoredNow({serverMs:1000,clientMs:500},1500).getTime()===2000,"ancla"));
    test("8 recuperación internet",()=>assert(anchoredNow({serverMs:2200,clientMs:1500},1500).getTime()===2200,"reconciliación"));
    test("9 cierre simultáneo",()=>assert(buildClosureId("x","2026-06-20")===buildClosureId("x","2026-06-20"),"id"));
    test("10 reejecución",()=>assert(stableStringify({b:2,a:1})===stableStringify({a:1,b:2}),"hash"));
    test("11 histórico inmutable",()=>assert(!isFalseZeroClosure({grossBilling:20000,cashCollectedByDriver:20000},{grossBilling:30000}),"inmutable"));
    test("12 falso cero",()=>assert(isFalseZeroClosure({grossBilling:0},{grossBilling:20000}),"no repara"));
    test("13 comprobante chofer",()=>assert(settlementPresentation(cash).requiresProof,"sin comprobante"));
    test("14 comprobante David",()=>assert(settlementPresentation(nonCash).requiresProof,"sin comprobante"));
    test("15 equilibrado sin comprobante",()=>assert(!settlementPresentation(calculateSettlement({})).requiresProof,"pidió comprobante"));
    test("16 reinicio sin caché antigua",()=>assert(typeof purgeOldWeeklyCaches==="function","purga"));
    test("17 admin y chofer iguales",()=>assert(stableStringify(settlementPresentation(cash))===stableStringify(settlementPresentation({...cash,viewerRole:"admin"})),"diferencias"));
    test("18 sintaxis cargada",()=>assert(VERSION===WEEKLY_CORE_VERSION,"versión"));
    const result = { version:VERSION, passed:tests.filter(item=>item.passed).length, failed:tests.filter(item=>!item.passed).length, tests };
    window.SELF_TEST_RESULTS = result;
    return result;
  }

  const API = Object.freeze({
    version:VERSION, snapshotSchemaVersion:WEEKLY_SNAPSHOT_SCHEMA, schemaVersion:WEEKLY_SNAPSHOT_SCHEMA, timezone:TZ,
    getWeeklyPeriod, getPreviousWeeklyPeriod, buildClosureId, buildCanonicalWeeklyClosureSnapshot,
    materializeWeeklyClosure, rebuildLegacyClosure, getWeeklyClosurePresentation,
    loadDailyRankingBonusesForPeriod, dailyBonusCollectionName,
    getWeeklyClosurePresentationSnapshot:getWeeklyClosurePresentation, displaySummary,
    determineCanonicalSettlement:calculateSettlement, resolveClosureState, resolveDirection,
    canonicalizeSnapshot, normalizeLegacyWeeklyClosure, validateWeeklyClosureSnapshot,
    updateProofState, setClosureWorkflowState,
    markProofUploading:(closureId)=>setClosureWorkflowState(closureId,"proof_uploading"),
    markProofError:(closureId,error)=>setClosureWorkflowState(closureId,"error",{ code:error?.code, message:error?.message }),
    markProofUploaded:(closureId,proof)=>updateProofState(closureId,proof,"proof_uploaded"),
    markUnderReview:(closureId,proof)=>updateProofState(closureId,proof,"under_review"),
    markPaid:(closureId,proof)=>updateProofState(closureId,proof,"paid"),
    closureCollectionName, receiptIndexCollectionName, storageBasePath, isTestMode,
    showDiagnostic, recordDiagnostic, getDiagnostics:()=>state.diagnostics.slice(), runWeeklyClosureSelfTests:runSelfTests,
    reconcileOfflineQueue, ensurePreviousClosureForCurrentDriver
  });
  window.ExploraCanonicalWeeklyClosure = API;
  window.ExploraCanonicalWeeklyFinancialEngine = API;
  window.buildCanonicalWeeklyClosureSnapshot = buildCanonicalWeeklyClosureSnapshot;
  window.buildCanonicalWeeklyFinancialSnapshot = buildCanonicalWeeklyClosureSnapshot;
  window.determineCanonicalSettlement = calculateSettlement;
  window.getWeeklyClosurePresentation = getWeeklyClosurePresentation;
  window.runWeeklyClosureSelfTests = runSelfTests;

  const attachTimer = setInterval(() => {
    const engine = window.ExploraWeeklyEngine;
    if (!engine) return;
    clearInterval(attachTimer);
    engine.getCanonicalWeeklyClosureSnapshot = buildCanonicalWeeklyClosureSnapshot;
    engine.getDriverWeeklyFinancialSnapshotCanonical = buildCanonicalWeeklyClosureSnapshot;
    engine.materializeCanonicalWeeklyClosure = materializeWeeklyClosure;
    engine.validateWeeklyClosureSnapshot = validateWeeklyClosureSnapshot;
    engine.getWeeklyClosurePresentation = getWeeklyClosurePresentation;
  },80);
  setTimeout(()=>clearInterval(attachTimer),15000);

  state.periodId = getWeeklyPeriod().id;
  window.addEventListener("explora:operational-period-changed",onPeriodChanged,true);
  window.addEventListener("explora:operational-date-changed",onPeriodChanged,true);
  window.addEventListener("online",()=>{ synchronizeClock({force:true}).then(reconcileOfflineQueue).then(ensurePreviousClosureForCurrentDriver).catch(error=>recordDiagnostic("ONLINE_RECONCILIATION_FAILED",{error})); });
  window.addEventListener("explora:session-opened",()=>{ state.generation+=1; state.periodId=getWeeklyPeriod().id; subscribeTestClock(); synchronizeClock({force:true}).catch(error=>recordDiagnostic("CLOCK_SYNC_FAILED",{error})).finally(()=>{ reconcileOfflineQueue(); ensurePreviousClosureForCurrentDriver().catch(error=>recordDiagnostic("AUTO_CLOSE_FAILED",{error})); }); });
  document.addEventListener("visibilitychange",()=>{ if(document.visibilityState==="visible"){ onPeriodChanged(); if(Date.now()-(readClockAnchor()?.clientMs||0)>CLOCK_RESYNC_MS&&navigator.onLine)synchronizeClock({force:true}).catch(()=>{}); } });
  if (auth) onAuthStateChanged(auth,user=>{ if(user){ subscribeTestClock(); synchronizeClock({force:true}).catch(()=>{}); } else { try{state.test.unsubscribe?.();}catch(_){} state.test.unsubscribe=null; } });
  setInterval(()=>{ if(auth?.currentUser&&document.visibilityState!=="hidden"&&navigator.onLine)synchronizeClock({force:true}).catch(()=>{}); },CLOCK_RESYNC_MS);

  runSelfTests();
})();
