/* ==========================================================================
   Shinzora — Billing
   Plan, usage and payment records.

   Payment doctrine (non-negotiable):
     • A payment is created as `pending` and only moves to `verified` when an
       authorised administrator approves it server-side, or a provider
       webhook/signature confirms it.
     • Closing the window, pressing Escape, reloading or navigating away does
       NOT change a payment's status. Nothing here infers payment from UI
       state — the dialog simply closes.
   ========================================================================== */

import { qs, qsa, esc, on } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { money, date, dateTime, timeAgo, statusLabel } from "../../../lib/format.js";
import { state, plan as currentPlan, aiCredits } from "../../../lib/store.js";
import { sb, normalizeError } from "../../../lib/supabase.js";
import { api, runtimeConfig } from "../../../lib/api.js";
import { PLANS, planById } from "../../../config/env.js";
import { payments as fetchPayments, subscription } from "../data.js";
import { pageHead, setupNotice, skeletonView, statusBadge, emptyState, statCard } from "../components.js";
import { openModal, formDialog } from "../../../ui/modal.js";
import { toast, toastError } from "../../../ui/toast.js";
import qrcode from "../../../vendor/qrcode.mjs";

const AWAITING_COPY =
  "Your payment is awaiting verification. It is confirmed within 24 hours and we notify you as soon as it is.";
const PRO_PROCESSING_COPY =
  "Once payment is verified, processing may take up to 24 hours. Your website and domain will be prepared according to your selected service.";

/* The operator's own UPI QR (a static code for the payee account). It is used
   instead of a generated one so the customer pays into the account the operator
   actually reconciles against. If the asset is ever missing, the dialog falls
   back to a QR built from the upi:// intent so a payment is still possible. */
const PAY_QR_SRC = "/assets/payments/upi-qr.png";

const SERVICES = [
  { id: "website_setup", label: "Managed website setup", amount: 499900, blurb: "We build, review and publish your site for you." },
  { id: "domain_registration", label: "Domain registration (.com / .in)", amount: 0, blurb: "Registrar price at the time of order — never marked up silently." },
  { id: "brand_kit", label: "Brand kit and copywriting", amount: 249900, blurb: "Logo direction, palette, typography and page copy." },
  { id: "store_setup", label: "Store and catalogue setup", amount: 349900, blurb: "Products, prices, shipping text and payment notes." }
];

let paymentRows = [];
let current = null;
let runtime = null;

export default async function render(root) {
  root.innerHTML = skeletonView(3);

  runtime = await runtimeConfig();
  try {
    const [paymentsRes, subRes] = await Promise.all([fetchPayments(60), subscription()]);
    paymentRows = paymentsRes.data;
    current = subRes;
  } catch (error) {
    root.innerHTML = `${pageHead({ title: "Billing" })}${setupNotice(error, "Billing")}`;
    return;
  }

  const plan = currentPlan();
  const credits = aiCredits();
  const percent = credits.limit ? Math.min(100, Math.round((credits.used / credits.limit) * 100)) : 0;
  const upiReady = Boolean(runtime?.payments?.upi_configured);
  const razorpayReady = Boolean(runtime?.payments?.razorpay_configured);
  const pending = paymentRows.filter((row) => ["pending", "awaiting_verification"].includes(row.status));

  root.innerHTML = `
    ${pageHead({
      title: "Billing",
      desc: "Your plan, AI usage and every payment record. Verification is done by a person or a signed provider callback — never by closing a window.",
      actions: `<a class="btn btn-secondary btn-sm" href="/app/?view=settings">${icon("settings", { size: 14 })}Account settings</a>`
    })}

    <div class="grid-4" style="margin-bottom:var(--s-4)">
      ${statCard({ label: "Current plan", value: plan.name, iconName: "crown", foot: current?.current_period_end ? `Renews ${date(current.current_period_end)}` : "No renewal date" })}
      ${statCard({ label: "AI this cycle", value: `${credits.used} / ${credits.limit}`, iconName: "sparkles", foot: `${percent}% used` })}
      ${statCard({ label: "Pending payments", value: String(pending.length), iconName: "clock", foot: pending.length ? "Awaiting verification" : "Nothing outstanding" })}
      ${statCard({ label: "Payment methods", value: upiReady ? "UPI QR" : "Not configured", iconName: "qr-code", foot: razorpayReady ? "Razorpay enabled" : "Razorpay keys absent" })}
    </div>

    ${
      pending.length
        ? `<div class="alert alert-warn" style="margin-bottom:var(--s-4)">
            ${icon("hourglass", { size: 16 })}
            <span>${esc(AWAITING_COPY)}</span>
          </div>`
        : ""
    }

    <div class="grid-main-side">
      <div class="stack gap-4">
        <div class="card">
          <div class="card-head">
            <div>
              <div class="card-title">Plans</div>
              <div class="card-sub">Change any time. Upgrades take effect after payment verification.</div>
            </div>
            <span class="badge badge-neutral">You are on ${esc(plan.name)}</span>
          </div>
          <div class="card-body">
            <div class="grid-3 plan-grid">
              ${PLANS.map(
                (item) => `<div class="plan-card ${item.id === plan.id ? "is-current" : ""}">
                  <div class="row between">
                    <div class="plan-name">${esc(item.name)}</div>
                    ${item.id === plan.id ? `<span class="badge badge-ok">Current</span>` : item.popular ? `<span class="badge badge-brand">Popular</span>` : ""}
                  </div>
                  <div class="plan-price">${item.priceMonthly === 0 ? "Free" : money(item.priceMonthly)}<span>${item.priceMonthly === 0 ? "" : " / month"}</span></div>
                  <div class="plan-tagline">${esc(item.tagline)}</div>
                  <ul class="plan-features">
                    ${item.features.slice(0, 4).map((feature) => `<li>${icon("check", { size: 13 })}<span>${esc(feature)}</span></li>`).join("")}
                  </ul>
                  ${
                    item.id === plan.id
                      ? `<button class="btn btn-secondary btn-sm btn-block" disabled>Your plan</button>`
                      : item.id === "enterprise"
                        ? `<a class="btn btn-secondary btn-sm btn-block" href="mailto:${esc(
                            "official.shinzora@proton.me"
                          )}?subject=Shinzora%20Enterprise">Talk to us</a>`
                        : `<button class="btn btn-primary btn-sm btn-block" data-upgrade="${item.id}">
                            ${item.priceMonthly > plan.priceMonthly ? "Upgrade" : "Switch"} to ${esc(item.name)}
                          </button>`
                  }
                </div>`
              ).join("")}
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <div>
              <div class="card-title">Pay for a service</div>
              <div class="card-sub">One-off services billed separately from your subscription</div>
            </div>
          </div>
          <div class="card-body">
            <div class="stack gap-3">
              ${SERVICES.map(
                (service) => `<div class="row gap-3 service-row">
                  <span class="notif-icon">${icon("briefcase", { size: 14 })}</span>
                  <div class="grow">
                    <div style="font-size:var(--fs-sm);color:var(--text)">${esc(service.label)}</div>
                    <div class="dim" style="font-size:var(--fs-2xs)">${esc(service.blurb)}</div>
                  </div>
                  <div class="row gap-2">
                    <span class="mono" style="font-size:var(--fs-xs);color:var(--text-2)">${service.amount ? esc(money(service.amount)) : "At cost"}</span>
                    <button class="btn btn-secondary btn-sm" data-service="${service.id}">Request</button>
                  </div>
                </div>`
              ).join("")}
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <div class="card-title">Payment history</div>
            <span class="card-sub">${paymentRows.length} records</span>
          </div>
          <div class="card-body" style="padding:0">
            ${
              paymentRows.length
                ? `<div class="table-wrap"><table class="table">
                    <thead><tr><th>Reference</th><th>Purpose</th><th>Amount</th><th>Status</th><th>Created</th><th></th></tr></thead>
                    <tbody>${paymentRows
                      .map(
                        (row) => `<tr>
                          <td class="cell-strong mono">${esc(row.reference || row.id.slice(0, 8).toUpperCase())}</td>
                          <td>${esc(prettyPurpose(row.purpose))}</td>
                          <td>${esc(money(row.amount, row.currency || "INR"))}</td>
                          <td>${statusBadge(row.status)}</td>
                          <td class="dim">${esc(timeAgo(row.created_at))}</td>
                          <td class="cell-actions">
                            ${
                              row.status === "pending"
                                ? `<button class="btn btn-primary btn-sm" data-pay="${esc(row.id)}">Pay now</button>`
                                : row.status === "awaiting_verification"
                                  ? `<button class="btn btn-ghost btn-sm" data-status="${esc(row.id)}">Status</button>`
                                  : `<button class="btn btn-ghost btn-sm" data-receipt="${esc(row.id)}">Receipt</button>`
                            }
                          </td>
                        </tr>`
                      )
                      .join("")}</tbody>
                  </table></div>`
                : emptyState({ icon: "receipt", title: "No payments yet", desc: "Payments you create for plan upgrades or services appear here with their verification status." })
            }
          </div>
        </div>
      </div>

      <div class="stack gap-4">
        <div class="card">
          <div class="card-head"><div class="card-title">How payment works</div></div>
          <div class="card-body">
            <ol class="pay-steps">
              <li class="pay-step"><span class="pay-step-num">1</span><div><strong>Create the request.</strong> We generate a reference, an amount and a UPI QR for the exact service.</div></li>
              <li class="pay-step"><span class="pay-step-num">2</span><div><strong>Pay and submit the reference.</strong> Send the UPI transaction ID (UTR) so the payment can be matched.</div></li>
              <li class="pay-step"><span class="pay-step-num">3</span><div><strong>Verification.</strong> A person checks the UPI statement, or a signed provider webhook confirms it.</div></li>
              <li class="pay-step"><span class="pay-step-num">4</span><div><strong>Activation.</strong> Your plan, project or service is activated only after verification.</div></li>
            </ol>
            <div class="alert alert-warn" style="margin-top:var(--s-4);font-size:var(--fs-2xs)">
              ${icon("shield-alert", { size: 14 })}
              <span>Closing the payment window does not mark a payment as completed. Only verified confirmation changes the status.</span>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div class="card-title">Provider status</div></div>
          <div class="card-body">
            <dl>
              <div class="kv"><dt>UPI QR</dt><dd>${upiReady ? `<span class="badge badge-ok">Configured</span>` : `<span class="badge badge-warn">Not configured</span>`}</dd></div>
              <div class="kv"><dt>Razorpay</dt><dd>${razorpayReady ? `<span class="badge badge-ok">Configured</span>` : `<span class="badge badge-neutral">Keys absent</span>`}</dd></div>
              <div class="kv"><dt>Settlement</dt><dd>Manual verification</dd></div>
              <div class="kv"><dt>Currency</dt><dd>INR</dd></div>
            </dl>
            ${
              upiReady
                ? ""
                : `<p class="muted" style="font-size:var(--fs-2xs);margin-top:10px;line-height:1.6">
                    Add <span class="mono">UPI_ID</span> and <span class="mono">UPI_PAYEE_NAME</span> to the payments Edge Function
                    secrets to enable QR payments. Until then, service requests are recorded and the team will contact you.
                  </p>`
            }
          </div>
        </div>
      </div>
    </div>`;

  /* -------------------------------------------------------------- actions */
  on(root, "click", async (event) => {
    const upgrade = event.target.closest("[data-upgrade]");
    if (upgrade) {
      const target = planById(upgrade.getAttribute("data-upgrade"));
      startPayment({
        purpose: `subscription:${target.id}`,
        label: `${target.name} plan`,
        amount: target.priceMonthly,
        plan: target.id
      });
      return;
    }

    const service = event.target.closest("[data-service]");
    if (service) {
      const item = SERVICES.find((s) => s.id === service.getAttribute("data-service"));
      if (!item.amount) {
        await requestQuote(item);
        return;
      }
      startPayment({ purpose: `service:${item.id}`, label: item.label, amount: item.amount });
      return;
    }

    const pay = event.target.closest("[data-pay]");
    if (pay) {
      const row = paymentRows.find((p) => p.id === pay.getAttribute("data-pay"));
      /* Resuming a pending payment: the intent string is only returned at
         creation time, so the QR step falls back to the operator's static code
         and the payee VPA from the runtime config. */
      openPaymentDialog({
        payment: row,
        label: prettyPurpose(row.purpose),
        amount: row.amount,
        upi: {
          upi_id: runtime?.payments?.upi_id || null,
          payee_name: runtime?.payments?.upi_payee_name || "Shinzora",
          intent: null
        }
      });
      return;
    }

    const status = event.target.closest("[data-status]");
    if (status) {
      const row = paymentRows.find((p) => p.id === status.getAttribute("data-status"));
      try {
        const response = await api.payments.status({ paymentId: row.id });
        toast({
          title: `Status: ${statusLabel(response?.payment?.status || row.status)}`,
          message: response?.payment?.admin_note || AWAITING_COPY,
          duration: 8000
        });
      } catch (error) {
        toastError(normalizeError(error));
      }
      return;
    }

    const receipt = event.target.closest("[data-receipt]");
    if (receipt) {
      const row = paymentRows.find((p) => p.id === receipt.getAttribute("data-receipt"));
      showReceipt(row);
    }
  });

  async function requestQuote(item) {
    const values = await formDialog({
      title: item.label,
      desc: "Registrar and provider costs are passed through at cost. We confirm the exact amount before any payment.",
      fields: [
        { name: "detail", label: "What do you need?", type: "textarea", rows: 3, required: true },
        { name: "contact", label: "Best contact", value: state.profile?.phone || state.user?.email || "" }
      ],
      submitLabel: "Send request"
    });
    if (!values) return;
    try {
      const { error } = await sb.from("service_requests").insert({
        owner_id: state.user.id,
        service_type: item.id,
        title: item.label,
        details: `${values.detail}\n\nContact: ${values.contact}`,
        status: "requested"
      });
      if (error) throw normalizeError(error);
      toast({ title: "Request sent", message: "We will confirm the exact amount before payment." }, { tone: "success" });
    } catch (error) {
      toastError(normalizeError(error));
    }
  }

  async function startPayment({ purpose, label, amount, plan: planId }) {
    try {
      const response = await api.payments.create({ purpose, label, amount, plan: planId || null });
      openPaymentDialog({
        payment: response?.payment,
        upi: response?.upi,
        label,
        amount
      });
      if (response?.payment) paymentRows.unshift(response.payment);
    } catch (error) {
      const normalized = normalizeError(error);
      if (normalized.code === "payments_unconfigured" || normalized.code === "upi_unconfigured") {
        openModal({
          title: "Payment provider not configured",
          size: "sm",
          body: `<p class="muted" style="font-size:var(--fs-sm);line-height:1.7">
            ${esc(normalized.message)}
          </p>
          <p class="muted" style="font-size:var(--fs-xs);line-height:1.7;margin-top:10px">
            ${esc(normalized.hint || "Set the UPI_ID and UPI_PAYEE_NAME secrets for the payments Edge Function, then reload.")}
          </p>`,
          footer: `<button class="btn btn-ghost" data-modal-close>Close</button>
                   <a class="btn btn-primary" href="/support/ticket/?topic=payments">Contact support</a>`
        });
        return;
      }
      toastError(normalized);
    }
  }

  function openPaymentDialog({ payment, upi = null, label, amount }) {
    /* payer → qr → proof → done. The customer's UPI ID comes first (the operator
       matches the bank entry by VPA), then the amount and the QR, then the UTR.
       Nothing in this dialog can mark a payment successful. */
    let step = "payer";
    let payerUpi = "";
    const currency = payment?.currency || "INR";
    const amountText = money(amount, currency);

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
              <h3>Payment submitted</h3>
              <p>You can close this page now. Your payment is confirmed within 24 hours and your plan becomes active the moment it is.</p>
              <div class="kv" style="margin-top:var(--s-4)"><dt>Amount</dt><dd><strong>${esc(amountText)}</strong></dd></div>
              <div class="kv"><dt>Reference</dt><dd class="mono">${esc(payment?.reference || "")}</dd></div>
              <div class="kv"><dt>Paid from</dt><dd class="mono">${esc(payerUpi)}</dd></div>
              <div class="kv"><dt>Status</dt><dd>${statusBadge("awaiting_verification")}</dd></div>
            </div>`;
          controller.setFooter(`<button class="btn btn-ghost" data-modal-close>Close</button>`);
          toast({ title: "Sent for verification", message: AWAITING_COPY, tone: "success", duration: 9000 });
          refreshRows();
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

  function showReceipt(row) {
    openModal({
      title: "Payment receipt",
      desc: row.reference || row.id,
      size: "sm",
      body: `<dl>
        <div class="kv"><dt>Purpose</dt><dd>${esc(prettyPurpose(row.purpose))}</dd></div>
        <div class="kv"><dt>Amount</dt><dd>${esc(money(row.amount, row.currency || "INR"))}</dd></div>
        <div class="kv"><dt>Status</dt><dd>${statusBadge(row.status)}</dd></div>
        <div class="kv"><dt>Verified</dt><dd>${row.verified_at ? esc(dateTime(row.verified_at)) : "—"}</dd></div>
        <div class="kv"><dt>UTR</dt><dd class="mono">${esc(row.utr || "—")}</dd></div>
        <div class="kv"><dt>Created</dt><dd>${esc(dateTime(row.created_at))}</dd></div>
      </dl>`,
      footer: `<button class="btn btn-ghost" data-modal-close>Close</button>
               <button class="btn btn-secondary" data-print>Print</button>`,
      onMount: (dialog) => {
        qs("[data-print]", dialog)?.addEventListener("click", () => window.print());
      }
    });
  }

  async function refreshRows() {
    try {
      const { data } = await fetchPayments(60);
      paymentRows = data;
    } catch {
      /* keep whatever is on screen */
    }
  }

  void qsa;
}

function planIdIsPro(purpose = "") {
  return /pro|enterprise|service:(website_setup|store_setup|brand_kit)/.test(String(purpose));
}

function prettyPurpose(purpose = "") {
  const text = String(purpose);
  if (text.startsWith("subscription:")) {
    const id = text.split(":")[1];
    return `${planById(id).name} plan`;
  }
  if (text.startsWith("service:")) {
    const id = text.split(":")[1];
    return SERVICES.find((service) => service.id === id)?.label || "Service";
  }
  if (text.startsWith("domain:")) return `Domain ${text.split(":")[1]}`;
  return text || "Payment";
}
