/* ==========================================================================
   Shinzora — the UPI payment dialog, shared (brief 1, P11)
   Used by Billing and by the Written by Experts order. It only collects the
   payer's UPI ID, shows the QR and takes the UTR. Nothing in it can mark a
   payment as paid: the operator verifies it. `onDone` runs after the UTR is
   submitted, so the caller can refresh its own list.
   ========================================================================== */

import { esc, qs } from "../../lib/dom.js";
import { icon } from "../../lib/icons.js";
import { money } from "../../lib/format.js";
import { normalizeError } from "../../lib/supabase.js";
import { api } from "../../lib/api.js";
import { statusBadge } from "./components.js";
import { openModal } from "../../ui/modal.js";
import { toast, toastError } from "../../ui/toast.js";
import qrcode from "../../vendor/qrcode.mjs";

export const AWAITING_COPY =
  "Your payment is awaiting verification. It is confirmed within 24 hours and we notify you as soon as it is.";
const PRO_PROCESSING_COPY =
  "Once payment is verified, processing may take up to 24 hours. Your website and domain will be prepared according to your selected service.";

/* The operator's own UPI QR (a static code for the payee account). It is used
   instead of a generated one so the customer pays into the account the operator
   actually reconciles against. If the asset is ever missing, the dialog falls
   back to a QR built from the upi:// intent so a payment is still possible. */
const PAY_QR_SRC = "/assets/payments/upi-qr.png";

export function openPaymentDialog({ payment, upi = null, label, amount, onDone = null }) {
  /* payer → qr → proof → done. The customer's UPI ID comes first (the operator
     matches the bank entry by VPA), then the amount and the QR, then the UTR.
     Nothing in this dialog can mark a payment successful. */
  let step = "payer";
  let payerUpi = "";
  const currency = payment?.currency || "INR";
  const amountText = money(amount, currency);
  /* A plan change is not instant: a person checks the UTR against the bank
     statement. Saying so before money moves is the difference between a
     customer who waits and a customer who thinks it failed. */
  const isPlan = String(payment?.purpose || "").startsWith("subscription:") || Boolean(payment?.plan);

  const modal = openModal({
    title: "Complete your payment",
    desc: `${label} · ${amountText}`,
    size: "md",
    body: `<div id="pay-body"></div>`,
    footer: `<button class="btn btn-ghost" data-modal-close>Close</button>
      <button class="btn btn-primary" id="pay-next">Continue to payment</button>`,
    onMount: (dialog, controller) => {
      const body = qs("#pay-body", dialog);
      const next = qs("#pay-next", dialog);

      const paintPayer = () => {
        body.innerHTML = `
          <div class="field">
            <label class="field-label" for="payer-upi">Your UPI ID</label>
            <input class="input" id="payer-upi" placeholder="name@bank" autocomplete="off"
                   spellcheck="false" inputmode="email" value="${esc(payerUpi)}" />
            <div class="field-hint">The UPI ID you will pay from, so the payment can be matched to your account.</div>
          </div>
          <div class="alert alert-info" style="font-size:var(--fs-2xs)">
            ${icon("info", { size: 14 })}
            <span>Next screen shows the amount and the payment QR.</span>
          </div>`;
        next.textContent = "Continue to payment";
      };

      const paintTerms = () => {
        body.innerHTML = `
          <div class="pay-amount">
            <span class="pay-amount-label">Amount</span>
            <strong class="pay-amount-value">${esc(amountText)}</strong>
            <span class="pay-amount-note">Reference <span class="mono">${esc(payment?.reference || "—")}</span></span>
          </div>
          <ul class="pay-terms">
            <li>${icon("clock", { size: 14 })}<span><strong>Verification takes up to 24 hours.</strong> A person matches your UTR against the bank statement — it is not automatic.</span></li>
            <li>${icon("hourglass", { size: 14 })}<span>Until then the payment shows as <strong>under process</strong>. Your plan does not change yet.</span></li>
            <li>${icon("shield-check", { size: 14 })}<span>Your plan activates the moment the payment is verified, and we notify you. You are charged this amount once.</span></li>
            <li>${icon("x", { size: 14 })}<span>Closing this window or this page does not mark anything as paid.</span></li>
          </ul>
          <label class="pay-consent">
            <input type="checkbox" id="pay-terms-ok" />
            <span>I understand the payment is verified within 24 hours before my plan changes.</span>
          </label>`;
        next.textContent = "Show the payment QR";
      };

      const paintQr = () => {
        const intent = upi?.intent || payment?.upi_string || "";
        body.innerHTML = `
          <div class="pay-amount">
            <span class="pay-amount-label">Amount to pay</span>
            <strong class="pay-amount-value">${esc(amountText)}</strong>
            <span class="pay-amount-note">Reference <span class="mono">${esc(payment?.reference || "—")}</span></span>
          </div>
          <p class="pay-hint">Open any UPI app, scan this QR and pay <strong>${esc(amountText)}</strong>. Then tap “I have paid”.</p>
          <div class="pay-scan">
            <img id="pay-qr-img" src="${PAY_QR_SRC}" alt="UPI QR code for ${esc(upi?.payee_name || "the payee")}" />
            <div class="pay-scan-meta">
              <strong>${esc(upi?.payee_name || "Shinzora")}</strong>
              <span class="mono">${esc(upi?.upi_id || "—")}</span>
            </div>
            <div class="pay-scan-alt" id="pay-qr-alt" hidden></div>
          </div>
          ${
            intent
              ? `<p class="pay-hint dim" style="margin-top:10px">On this phone? <a href="${esc(intent)}">Open your UPI app with the amount filled in</a>.</p>`
              : ""
          }`;
        /* If the uploaded image cannot load, fall back to a generated QR from
           the intent string rather than showing a broken box. */
        const img = qs("#pay-qr-img", body);
        if (img) {
          img.addEventListener("error", () => {
            const alt = qs("#pay-qr-alt", body);
            img.remove();
            if (!alt) return;
            try {
              const qr = qrcode(0, "M");
              qr.addData(intent || `Payment reference ${payment?.reference || ""}`);
              qr.make();
              alt.innerHTML = qr.createSvgTag({ scalable: true, margin: 0 });
              alt.hidden = false;
            } catch {
              alt.innerHTML = `<span class="dim" style="font-size:var(--fs-2xs)">QR unavailable — pay <span class="mono">${esc(upi?.upi_id || "")}</span> via UPI.</span>`;
              alt.hidden = false;
            }
          });
        }
        next.textContent = "I have paid";
      };

      const paintProof = () => {
        body.innerHTML = `
          <div class="field">
            <label class="field-label" for="utr">UPI transaction ID (UTR)</label>
            <input class="input" id="utr" placeholder="12-digit reference from your UPI app" autocomplete="off" inputmode="numeric" />
            <div class="field-hint">This is what the team matches against the bank statement.</div>
          </div>
          <div class="field">
            <label class="field-label" for="note">Note (optional)</label>
            <textarea class="textarea" id="note" rows="2" placeholder="Anything we should know"></textarea>
          </div>
          <div class="alert alert-info" style="font-size:var(--fs-2xs)">
            ${icon("info", { size: 14 })}
            <span>${esc(AWAITING_COPY)}</span>
          </div>`;
        next.textContent = "Submit for verification";
      };

      const paintDone = () => {
        body.innerHTML = `
          <div class="pay-done">
            <span class="pay-done-icon">${icon("hourglass", { size: 22 })}</span>
            <h3>Payment under process</h3>
            <p>You can close this page now. The payment is verified within 24 hours, and your ${isPlan ? "plan" : "order"} becomes active the moment it is.</p>
            <div class="kv" style="margin-top:var(--s-4)"><dt>Amount</dt><dd><strong>${esc(amountText)}</strong></dd></div>
            <div class="kv"><dt>Reference</dt><dd class="mono">${esc(payment?.reference || "")}</dd></div>
            <div class="kv"><dt>Paid from</dt><dd class="mono">${esc(payerUpi)}</dd></div>
            <div class="kv"><dt>Status</dt><dd>${statusBadge("awaiting_verification")}</dd></div>
          </div>`;
        controller.setFooter(`<button class="btn btn-ghost" data-modal-close>Close</button>`);
        toast({ title: "Sent for verification", message: AWAITING_COPY, tone: "success", duration: 9000 });
        onDone?.();
      };

      paintPayer();

      next.addEventListener("click", async () => {
        if (step === "payer") {
          const value = qs("#payer-upi", dialog).value.trim().toLowerCase();
          if (!/^[a-z0-9._-]{2,64}@[a-z]{2,32}$/.test(value)) {
            toast({ title: "Enter your UPI ID", message: "For example name@bank.", tone: "warning" });
            return;
          }
          payerUpi = value;
          if (isPlan) {
            step = "terms";
            paintTerms();
            return;
          }
          step = "qr";
          paintQr();
          return;
        }

        if (step === "terms") {
          if (!qs("#pay-terms-ok", dialog)?.checked) {
            toast({
              title: "Confirm the 24-hour verification",
              message: "Tick the box so we know the timing is clear — your plan changes only after the payment is verified.",
              tone: "warning"
            });
            return;
          }
          step = "qr";
          paintQr();
          return;
        }

        if (step === "qr") {
          step = "proof";
          paintProof();
          return;
        }

        const utr = qs("#utr", dialog).value.trim();
        if (utr.length < 6) {
          toast({ title: "Enter the UPI transaction ID", message: "It is in your UPI app's payment history.", tone: "warning" });
          return;
        }
        next.disabled = true;
        next.innerHTML = `<span class="spinner"></span><span>Submitting…</span>`;
        try {
          await api.payments.submitProof({
            paymentId: payment?.id,
            utr,
            payerUpi,
            paidAt: new Date().toISOString(),
            note: qs("#note", dialog).value.trim()
          });
          step = "done";
          paintDone();
        } catch (error) {
          next.disabled = false;
          next.textContent = "Submit for verification";
          toastError(normalizeError(error));
        }
      });
    }
  });
  void modal;
}
