import { doc, updateDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const F = window.ExploraFirebase || {};
const db = F.db || null;
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? "").replace(/[&<>'"]/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" }[c]));
const money = (v) => new Intl.NumberFormat("es-AR", { style:"currency", currency:"ARS", maximumFractionDigits:0 }).format(Number(v) || 0).replace(/\s/g, "");

const state = { rows: [] };

function normalizedId(row = {}) {
  return String(row.id || row.debtId || row.documentId || row.uid || "").trim();
}

function findDebtById(id) {
  const wanted = String(id || "");
  return state.rows.find((row) => normalizedId(row) === wanted)
    || window.ExploraDriverIncidents?.getState?.().rows?.find?.((row) => normalizedId(row) === wanted)
    || window.ExploraDriverIncidents?.getState?.().summary?.normalized?.find?.((row) => normalizedId(row) === wanted)
    || null;
}

function firstAttachment(row = {}) {
  const direct = [
    row.receiptUrl,
    row.comprobanteUrl,
    row.attachmentUrl,
    row.fileUrl,
    row.downloadUrl,
    row.url
  ].find(Boolean);
  if (direct) {
    return {
      url: String(direct),
      name: String(row.receiptName || row.fileName || row.attachmentName || "Comprobante"),
      mime: String(row.receiptMime || row.mimeType || row.contentType || "")
    };
  }

  const arrays = [row.attachments, row.files, row.receipts, row.comprobantes].filter(Array.isArray);
  for (const arr of arrays) {
    const item = arr.find((entry) => entry && (entry.url || entry.receiptUrl || entry.downloadUrl || entry.fileUrl));
    if (item) {
      return {
        url: String(item.url || item.receiptUrl || item.downloadUrl || item.fileUrl),
        name: String(item.name || item.fileName || item.originalName || row.receiptName || "Comprobante"),
        mime: String(item.mime || item.mimeType || item.contentType || row.receiptMime || "")
      };
    }
  }

  return null;
}

function isImageAttachment(attachment = {}) {
  const mime = String(attachment.mime || "").toLowerCase();
  const url = String(attachment.url || "").toLowerCase().split("?")[0];
  return mime.startsWith("image/") || /\.(png|jpe?g|webp|gif|heic|heif)$/i.test(url);
}

function compactDate(row = {}) {
  const raw = row.createdAt?.toDate?.() || row.createdAtMs || row.createdAt || row.updatedAt?.toDate?.() || Date.now();
  const date = raw instanceof Date ? raw : new Date(Number(raw) || raw || Date.now());
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("es-AR", { day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" });
}

function render(rows = []) {
  const box = $("debtNotificationStack");
  if (!box) return;

  state.rows = Array.isArray(rows) ? rows : [];
  const pending = state.rows.filter((row) => (
    row
    && row.acknowledgedByDriver !== true
    && !String(row.status || row.debtStatus || "").toLowerCase().includes("cancel")
  ));

  box.hidden = !pending.length;
  box.innerHTML = pending.map((row) => {
    const id = normalizedId(row);
    const attachment = firstAttachment(row);
    const label = row.reasonLabel || row.reason || row.type || "Pendiente";
    const amount = Number(row.totalAmount || row.amount || row.remainingAmount || row.saldoPendiente || 0);
    const installmentCount = Number(row.installmentCount || row.cantidadCuotas || 1) || 1;
    const installmentAmount = Number(row.weeklyInstallmentAmount || row.cuotaSemanal || amount || 0);
    const dateText = compactDate(row);
    return `
      <article class="debt-notification-card debt-notification-card--soft" data-debt-card-id="${esc(id)}">
        <button class="debt-notification-close" type="button" data-ack-debt="${esc(id)}" aria-label="Cerrar aviso de pendiente">Cerrar</button>
        <div class="debt-notification-head">
          <span class="debt-notification-symbol" aria-hidden="true">!</span>
          <div class="debt-notification-copy">
            <strong>Pendiente registrado</strong>
            <span>${esc(label)} · ${money(amount)}</span>
            <small>${dateText ? `${esc(dateText)} · ` : ""}${installmentCount} pago(s) semanal(es) · Cuota estimada ${money(installmentAmount)}</small>
            ${row.notes ? `<small>${esc(row.notes)}</small>` : ""}
          </div>
        </div>
        ${attachment ? `<button class="debt-photo-mini" type="button" data-notification-attachment="${esc(id)}">ver foto</button>` : ""}
      </article>`;
  }).join("");
}

function ensurePhotoModal() {
  let modal = $("debtPhotoModal");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.id = "debtPhotoModal";
  modal.className = "debt-photo-modal";
  modal.hidden = true;
  modal.innerHTML = `
    <div class="debt-photo-backdrop" data-debt-photo-close></div>
    <section class="debt-photo-sheet" role="dialog" aria-modal="true" aria-labelledby="debtPhotoTitle">
      <header class="debt-photo-header">
        <div>
          <span>Comprobante</span>
          <strong id="debtPhotoTitle">Foto del pendiente</strong>
          <small id="debtPhotoMeta"></small>
        </div>
        <button type="button" class="debt-photo-close" data-debt-photo-close aria-label="Cerrar comprobante">×</button>
      </header>
      <div class="debt-photo-body" id="debtPhotoBody"></div>
      <footer class="debt-photo-footer">
        <a class="debt-photo-open" id="debtPhotoOpen" href="#" target="_blank" rel="noopener">Abrir completo</a>
        <button type="button" data-debt-photo-close>Cerrar</button>
      </footer>
    </section>`;
  document.body.appendChild(modal);
  return modal;
}

function openPhotoModal(row) {
  const attachment = firstAttachment(row);
  if (!attachment?.url) return;

  const modal = ensurePhotoModal();
  const title = $("debtPhotoTitle");
  const meta = $("debtPhotoMeta");
  const body = $("debtPhotoBody");
  const open = $("debtPhotoOpen");
  const label = row.reasonLabel || row.reason || row.type || "Pendiente";
  const amount = Number(row.totalAmount || row.amount || row.remainingAmount || row.saldoPendiente || 0);

  if (title) title.textContent = `${label} · ${money(amount)}`;
  if (meta) meta.textContent = attachment.name || "Archivo cargado por administrador";
  if (open) open.href = attachment.url;
  if (body) {
    body.innerHTML = isImageAttachment(attachment)
      ? `<img src="${esc(attachment.url)}" alt="Comprobante de pendiente">`
      : `<div class="debt-photo-file"><strong>Archivo disponible</strong><span>${esc(attachment.name || "Comprobante")}</span><a href="${esc(attachment.url)}" target="_blank" rel="noopener">Abrir archivo</a></div>`;
  }

  modal.hidden = false;
  document.documentElement.classList.add("debt-photo-modal-open");
}

function closePhotoModal() {
  const modal = $("debtPhotoModal");
  if (!modal) return;
  modal.hidden = true;
  document.documentElement.classList.remove("debt-photo-modal-open");
}

window.addEventListener("explora:driver-debts-updated", (event) => render(event.detail?.rows || []));
window.addEventListener("explora:auth-cleared", () => render([]));

document.addEventListener("click", async (event) => {
  const closePhoto = event.target.closest?.("[data-debt-photo-close]");
  if (closePhoto) {
    closePhotoModal();
    return;
  }

  const attachment = event.target.closest?.("[data-notification-attachment]");
  if (attachment) {
    event.preventDefault();
    const debt = findDebtById(attachment.dataset.notificationAttachment);
    if (debt) openPhotoModal(debt);
    return;
  }

  const button = event.target.closest?.("[data-ack-debt]");
  if (!button) return;
  const id = button.dataset.ackDebt;
  if (!id) return;
  button.disabled = true;
  const previousText = button.textContent;
  button.textContent = "Cerrando…";
  try {
    if (!db) throw new Error("Firestore no está disponible.");
    await updateDoc(doc(db, "deudas_choferes", id), {
      acknowledgedByDriver: true,
      acknowledgedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
  } catch (error) {
    console.error("DEBT_ACK_FAILED", error);
    button.disabled = false;
    button.textContent = previousText || "Cerrar";
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closePhotoModal();
});
