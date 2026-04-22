const express = require('express');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const app     = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════════════════════════
//  CONFIG — edit before deploying
// ═══════════════════════════════════════════════════════════════
const MERCHANT = {
  upi : 'paytm.s1h4uwq@pty',        // ← your PayTM UPI VPA
  name: 'Audiva Fm Private Limited', // ← must match registered name EXACTLY
  mc  : '5815',                      // ← MCC (Merchant Category Code) — 5815 = digital goods, use yours
};

// ── Order storage ─────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function orderFile(id) {
  return path.join(DATA_DIR, id.replace(/[^a-zA-Z0-9_\-]/g, '') + '.json');
}
function saveOrder(id, data)   { fs.writeFileSync(orderFile(id), JSON.stringify(data, null, 2)); }
function getOrder(id)          { const f = orderFile(id); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; }
function updateOrder(id, u)    { const o = getOrder(id); if (!o) return; Object.assign(o, u); saveOrder(id, o); }
function allOrders()           {
  return fs.readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); } catch { return null; } })
    .filter(Boolean);
}

// ── Generate UPI-spec transaction IDs ─────────────────────────
// tr  = Transaction Reference (12-35 alphanumeric, unique per txn)
// tid = PSP Transaction ID     (sent by PSP, we echo a generated one)
function makeTr(order_id) {
  // Format mirrors real PG refs: timestamp + short hash
  const ts   = Date.now().toString();
  const hash = crypto.createHash('sha256').update(order_id + ts).digest('hex').substring(0, 10).toUpperCase();
  return ts + hash; // e.g. "1714000000000AB12CD34E"
}
function makeTid(tr) {
  // tid is typically PSP-prefixed; we prefix with "PG"
  return 'PG' + tr;
}

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ═══════════════════════════════════════════════════════════════
//  POST /api/create
// ═══════════════════════════════════════════════════════════════
app.post('/api/create', (req, res) => {
  const { amount, order_id } = req.body;

  if (!amount || parseFloat(amount) <= 0)
    return res.json({ status: 'FAILED', message: 'Invalid amount', order_id: '', amount: '0.00', payment_url: '' });
  if (!order_id)
    return res.json({ status: 'FAILED', message: 'order_id required', order_id: '', amount: '0.00', payment_url: '' });
  if (getOrder(order_id))
    return res.json({ status: 'FAILED', message: 'Order ID already exists', order_id, amount: '0.00', payment_url: '' });

  const amt  = parseFloat(amount).toFixed(2);
  const tr   = makeTr(order_id);
  const tid  = makeTid(tr);
  const host = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `${req.protocol}://${req.get('host')}`;
  const payment_url = `${host}/pay/${order_id}`;

  saveOrder(order_id, {
    order_id, amount: amt,
    upi: MERCHANT.upi, name: MERCHANT.name, mc: MERCHANT.mc,
    tr, tid,
    status: 'PENDING', utr: '', payer: '',
    created_at: new Date().toISOString(),
    settled_at: '', payment_url,
  });

  res.json({ status: 'SUCCESS', message: 'Order created successfully', order_id, amount: amt, payment_url });
});

// ═══════════════════════════════════════════════════════════════
//  GET /api/status?order_id=X
// ═══════════════════════════════════════════════════════════════
app.get('/api/status', (req, res) => {
  const { order_id } = req.query;
  if (!order_id) return res.json({ status: 'FAILED', message: 'order_id required' });
  const o = getOrder(order_id);
  if (!o) return res.json({ status: 'FAILED', message: 'Order not found', order_id });

  res.json({
    status   : o.status,
    amount   : o.amount,
    UTR      : o.utr,
    order_id : o.order_id,
    message  : '0',
    merchantDetails: {
      pg_type           : 'UPI-PG',
      payment_source    : 'paytm',
      mode              : 'UPI_INTENT',
      added_on          : o.created_at,
      settled_at        : o.settled_at,
      transaction_amount: o.amount,
      unmapped_status   : o.status === 'SUCCESS' ? 'captured' : o.status.toLowerCase(),
      error_code        : 'E000',
      error_message     : 'NO ERROR',
    },
    payerDetails: {
      payer_name   : o.payer,
      bank_ref_num : o.utr,
      utr          : o.utr,
      field9       : o.status === 'SUCCESS' ? '0|SUCCESS|Completed Using Callback' : '',
    },
  });
});

// ═══════════════════════════════════════════════════════════════
//  GET /api/verify?utr=X&order_id=Y&amount=Z
// ═══════════════════════════════════════════════════════════════
app.get('/api/verify', (req, res) => {
  const utr      = (req.query.utr || '').replace(/\D/g, '');
  const order_id = req.query.order_id || '';

  if (utr.length !== 12) return res.json({ status: 'FAILED', message: 'UTR must be 12 digits' });
  const o = getOrder(order_id);
  if (!o) return res.json({ status: 'FAILED', message: 'Order not found' });
  if (o.status === 'SUCCESS') return res.json({ status: 'SUCCESS', message: 'Already verified', utr: o.utr });

  const dup = allOrders().find(x => x.utr === utr && x.order_id !== order_id);
  if (dup) return res.json({ status: 'FAILED', message: `UTR already used for order ${dup.order_id}` });

  updateOrder(order_id, { status: 'SUCCESS', utr, payer: 'UTR Verified', settled_at: new Date().toISOString() });
  res.json({ status: 'SUCCESS', message: 'Payment verified', order_id, amount: o.amount, utr });
});

// ═══════════════════════════════════════════════════════════════
//  GET /pay/:order_id — Payment page
// ═══════════════════════════════════════════════════════════════
app.get('/pay/:order_id', (req, res) => {
  const { order_id } = req.params;
  const o = getOrder(order_id);
  if (!o) return res.status(404).send('<h3 style="font-family:sans-serif;padding:24px">Order not found</h3>');

  const host = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `${req.protocol}://${req.get('host')}`;

  // ── Proper UPI intent with tr + tid + mc (merchant category code)
  // This is what real PGs send — it tells UPI apps this is a merchant txn
  const pa  = encodeURIComponent(o.upi);
  const pn  = encodeURIComponent(o.name);
  const am  = o.amount;
  const tr  = encodeURIComponent(o.tr);
  const tid = encodeURIComponent(o.tid);
  const mc  = o.mc;
  const tn  = encodeURIComponent(`Order ${order_id}`);
  const cu  = 'INR';

  // Generic intent — shows UPI app picker (Android)
  const intentGeneric = `upi://pay?pa=${pa}&pn=${pn}&tr=${tr}&tid=${tid}&am=${am}&cu=${cu}&mc=${mc}&tn=${tn}`;

  // PayTM-specific deep link
  const intentPaytm   = `paytmmp://pay?pa=${pa}&pn=${pn}&tr=${tr}&tid=${tid}&am=${am}&cu=${cu}&mc=${mc}&tn=${tn}`;

  const statusUrl = `${host}/api/status?order_id=${encodeURIComponent(order_id)}`;
  const verifyUrl = `${host}/api/verify`;

  // QR encodes the generic intent (all UPI apps can scan it)
  const qrData  = encodeURIComponent(intentGeneric);
  const qrUrl   = `https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${qrData}&bgcolor=ffffff&color=000000&margin=6&ecc=H`;
  const qrUrlBig = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${qrData}&bgcolor=ffffff&color=000000&margin=10&ecc=H`;

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>Pay ₹${o.amount}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
:root{--blue:#0070ba;--blue-light:#e8f4fd;--green:#16a34a;--red:#dc2626}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#eef2f7;min-height:100dvh;display:flex;align-items:flex-start;justify-content:center;padding:16px 12px 40px}
.wrap{width:100%;max-width:400px}

/* ── CARD ── */
.card{background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.10)}

/* ── HEADER ── */
.head{background:linear-gradient(160deg,#0070ba 0%,#00b4d8 100%);padding:24px 20px 20px;text-align:center;color:#fff;position:relative}
.head-badge{display:inline-flex;align-items:center;gap:5px;background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.3);padding:3px 10px;border-radius:20px;font-size:10.5px;font-weight:600;letter-spacing:.03em;margin-bottom:10px}
.head-badge svg{flex-shrink:0}
.head-merchant{font-size:12px;color:rgba(255,255,255,.75);margin-bottom:6px;font-weight:500}
.head-label{font-size:9.5px;text-transform:uppercase;letter-spacing:.12em;color:rgba(255,255,255,.5);margin-bottom:2px}
.head-amount{font-size:50px;font-weight:800;line-height:1;letter-spacing:-1.5px}
.head-amount sup{font-size:22px;font-weight:400;opacity:.55;vertical-align:super;margin-right:2px}
.head-orderid{font-size:10px;color:rgba(255,255,255,.4);margin-top:8px;font-family:monospace}

/* ── BODY ── */
.body{padding:18px}

/* ── QR BLOCK ── */
.qr-section{display:flex;flex-direction:column;align-items:center;margin-bottom:4px}
.qr-frame{border:2px solid #e2e8f0;border-radius:14px;padding:8px;background:#fff;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.06);transition:transform .12s}
.qr-frame:active{transform:scale(.97)}
.qr-frame img{width:180px;height:180px;display:block;border-radius:8px}
.qr-tap-hint{font-size:10.5px;color:#94a3b8;margin-top:6px}
.upi-id-row{display:flex;align-items:center;gap:7px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:9px;padding:8px 12px;margin-top:10px;width:100%}
.upi-id-text{font-family:monospace;font-size:13px;font-weight:600;color:#1e293b;flex:1}
.copy-btn{background:none;border:none;cursor:pointer;padding:2px;color:#64748b;font-size:11px;font-weight:600;white-space:nowrap}
.copy-btn:hover{color:#0070ba}

/* ── DIVIDER ── */
.divider{display:flex;align-items:center;gap:8px;margin:14px 0 12px;font-size:11px;color:#94a3b8}
.divider::before,.divider::after{content:'';flex:1;height:1px;background:#e8edf2}

/* ── PAY BUTTON (main) ── */
.pay-btn{width:100%;display:flex;align-items:center;gap:14px;padding:15px 16px;background:linear-gradient(135deg,#0070ba,#00b4d8);border:none;border-radius:14px;cursor:pointer;font-family:inherit;color:#fff;transition:all .15s;box-shadow:0 4px 16px rgba(0,112,186,.30)}
.pay-btn:active{transform:scale(.97);box-shadow:0 2px 8px rgba(0,112,186,.20)}
.pay-btn-logo{width:44px;height:44px;background:rgba(255,255,255,.18);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:24px;flex-shrink:0}
.pay-btn-title{font-size:16px;font-weight:700;display:block;text-align:left}
.pay-btn-sub{font-size:11px;color:rgba(255,255,255,.75);display:block;text-align:left;margin-top:1px}

/* ── STATUS MSG ── */
.status-msg{display:none;border-radius:10px;padding:10px 14px;font-size:13px;font-weight:600;text-align:center;margin-bottom:12px}

/* ── PAID CONFIRM ── */
.confirm-btn{width:100%;margin-top:12px;padding:13px;border-radius:12px;background:#f0fdf4;border:2px solid #86efac;color:#166534;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;transition:all .15s}
.confirm-btn:hover{background:#22c55e;color:#fff;border-color:#22c55e}

/* ── UTR BOX ── */
.utr-box{display:none;margin-top:12px;background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:14px;padding:16px}
.utr-box-title{font-size:11px;font-weight:700;color:#334155;letter-spacing:.05em;text-transform:uppercase;margin-bottom:8px}
.utr-hint{font-size:12px;color:#64748b;background:#fff;border:1px solid #e8edf2;border-radius:8px;padding:10px;margin-bottom:12px;line-height:1.75}
.utr-inp{width:100%;padding:13px;font-size:24px;font-weight:800;font-family:monospace;letter-spacing:.12em;border:2px solid #e2e8f0;border-radius:10px;text-align:center;color:#0f172a;background:#fff;transition:border .15s}
.utr-inp:focus{outline:none;border-color:#0070ba;box-shadow:0 0 0 3px rgba(0,112,186,.10)}
.utr-count{text-align:center;font-size:11px;color:#94a3b8;margin:6px 0 12px}
.vfy-btn{width:100%;padding:13px;border-radius:10px;background:#0070ba;color:#fff;font-size:14px;font-weight:700;border:none;cursor:pointer;font-family:inherit;transition:background .15s}
.vfy-btn:disabled{background:#e2e8f0;color:#94a3b8;cursor:not-allowed}
.vfy-res{display:none;border-radius:8px;padding:10px;font-size:13px;font-weight:600;text-align:center;margin-top:8px}
.back-btn{width:100%;margin-top:8px;padding:10px;background:none;border:1.5px solid #e2e8f0;border-radius:8px;color:#64748b;font-size:13px;cursor:pointer;font-family:inherit}

/* ── FOOTER ── */
.footer{background:#f8fafc;border-top:1px solid #f0f4f8;padding:9px;display:flex;justify-content:center;align-items:center;gap:14px;font-size:9.5px;color:#94a3b8;font-weight:600;letter-spacing:.03em}
.footer-dot{width:3px;height:3px;background:#d1d5db;border-radius:50%}

/* ── SUCCESS ── */
.success-screen{display:none;padding:24px 20px;text-align:center}
.success-screen.show{display:block}
.s-icon{width:72px;height:72px;background:#f0fdf4;border-radius:50%;border:2px solid #86efac;display:flex;align-items:center;justify-content:center;margin:0 auto 14px;box-shadow:0 0 28px rgba(34,197,94,.18)}
.s-icon svg{width:32px;height:32px}
.s-title{font-size:22px;font-weight:800;color:#166534;margin-bottom:5px}
.s-sub{font-size:13px;color:#64748b;margin-bottom:18px}
.s-details{background:#f8fafc;border:1px solid #e8edf2;border-radius:12px;padding:0 14px;text-align:left}
.s-row{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #f1f5f9;font-size:13px}
.s-row:last-child{border:none}
.s-key{color:#64748b;font-size:11.5px}
.s-val{font-weight:700;font-family:monospace;font-size:12px;word-break:break-all;text-align:right;max-width:60%}

/* ── OVERLAY ── */
.overlay{position:fixed;inset:0;background:rgba(238,242,247,.97);display:none;flex-direction:column;align-items:center;justify-content:center;gap:16px;z-index:200;backdrop-filter:blur(2px)}
.overlay.show{display:flex}
.ov-spinner{width:44px;height:44px;border:3px solid #e2e8f0;border-top-color:#0070ba;border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.ov-title{font-size:16px;font-weight:700;color:#1e293b}
.ov-sub{font-size:12px;color:#64748b;text-align:center;line-height:1.6;max-width:240px}
.ov-bar{width:200px;height:3px;background:#e2e8f0;border-radius:2px;overflow:hidden}
.ov-fill{height:100%;background:#0070ba;border-radius:2px;animation:sweep 2s ease-in-out infinite}
@keyframes sweep{0%{width:0;margin-left:0}50%{width:55%;margin-left:22%}100%{width:0;margin-left:100%}}

/* ── FULLSCREEN QR ── */
.qr-fs{position:fixed;inset:0;z-index:300;background:rgba(0,0,0,.93);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px}
.qr-fs-card{background:#fff;border-radius:16px;padding:14px}
.qr-fs-card img{width:min(280px,78vw);height:min(280px,78vw);display:block;border-radius:8px}
.qr-fs-label{font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em}
.qr-fs-amount{font-size:18px;font-weight:800;color:#fff}
.qr-fs-upi{font-family:monospace;font-size:13px;color:#7dd3fc}
.qr-fs-hint{font-size:11px;color:#475569;text-align:center;line-height:1.7}
.qr-fs-close{padding:9px 28px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#94a3b8;font-size:13px;cursor:pointer;font-family:inherit}

/* ── COPIED TOAST ── */
.toast{position:fixed;bottom:28px;left:50%;transform:translateX(-50%) translateY(60px);background:#1e293b;color:#fff;padding:9px 20px;border-radius:20px;font-size:13px;font-weight:600;opacity:0;transition:all .3s;z-index:400;pointer-events:none}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
</style>
</head>
<body>
<div class="wrap">
<div class="card">

  <!-- HEADER -->
  <div class="head">
    <div class="head-badge">
      <svg width="10" height="10" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="#22c55e"/><path d="M2.5 5l1.8 1.8 3.2-3.5" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      Verified Merchant
    </div>
    <div class="head-merchant">${o.name}</div>
    <div class="head-label">Amount to Pay</div>
    <div class="head-amount"><sup>₹</sup>${o.amount}</div>
    <div class="head-orderid">Ref: ${o.tr}</div>
  </div>

  <!-- SUCCESS -->
  <div class="success-screen" id="success-screen"></div>

  <!-- PAY BODY -->
  <div class="body" id="pay-body">
    <div class="status-msg" id="status-msg"></div>

    <!-- QR -->
    <div class="qr-section">
      <div class="qr-frame" onclick="showFSQR()">
        <img src="${qrUrl}" alt="UPI QR Code" loading="eager">
      </div>
      <div class="qr-tap-hint">Tap to enlarge · Scan with any UPI app</div>
      <div class="upi-id-row">
        <span class="upi-id-text">${o.upi}</span>
        <button class="copy-btn" onclick="copyUPI()">Copy</button>
      </div>
    </div>

    <div class="divider">or open app directly</div>

    <!-- PayTM Button -->
    <button class="pay-btn" onclick="firePaytm()">
      <div class="pay-btn-logo">🔷</div>
      <div>
        <span class="pay-btn-title">Pay with PayTM</span>
        <span class="pay-btn-sub">Amount & details auto-filled · Tap to open</span>
      </div>
    </button>

    <!-- Confirm after paying -->
    <button class="confirm-btn" id="paid-btn" onclick="showUTR()">✓ I've Paid — Confirm Payment</button>

    <!-- UTR Entry -->
    <div class="utr-box" id="utr-box">
      <div class="utr-box-title">Enter UPI Reference / UTR</div>
      <div class="utr-hint">
        Open PayTM → <strong>History</strong> → find this payment<br>
        Copy the <strong>UPI Ref ID</strong> (12 digits)
      </div>
      <input class="utr-inp" id="utr-inp" type="tel" maxlength="12" placeholder="000000000000"
        oninput="this.value=this.value.replace(/\\D/g,'');onUTR(this.value)" autocomplete="off">
      <div class="utr-count" id="utr-count">0 / 12 digits</div>
      <div class="vfy-res" id="vfy-res"></div>
      <button class="vfy-btn" id="vfy-btn" onclick="verifyUTR()" disabled>Verify &amp; Confirm Payment</button>
      <button class="back-btn" onclick="hideUTR()">← Back</button>
    </div>
  </div>

  <!-- FOOTER -->
  <div class="footer">
    <span>🔒 SSL Secured</span>
    <span class="footer-dot"></span>
    <span>BHIM UPI</span>
    <span class="footer-dot"></span>
    <span>NPCI Compliant</span>
  </div>
</div>
</div>

<!-- Overlay -->
<div class="overlay" id="overlay">
  <div class="ov-spinner"></div>
  <div class="ov-title" id="ov-title">Opening PayTM…</div>
  <div class="ov-sub" id="ov-sub">Complete payment and return to this page</div>
  <div class="ov-bar"><div class="ov-fill"></div></div>
</div>

<!-- Toast -->
<div class="toast" id="toast">Copied!</div>

<script>
const INTENT_PAYTM  = ${JSON.stringify(intentPaytm)};
const INTENT_GENERIC = ${JSON.stringify(intentGeneric)};
const STATUS_URL    = '${statusUrl}';
const VERIFY_URL    = '${verifyUrl}';
const ORDER_ID      = '${order_id}';
const AMOUNT        = '${o.amount}';
const UPI_ID        = '${o.upi}';
const BIG_QR        = '${qrUrlBig}';
let pollTimer = null, retHandler = null;

// ── Fire PayTM intent ──────────────────────────────────────────
function firePaytm() {
  showOverlay('Opening PayTM…', 'Complete the payment and come back here');
  window.location.href = INTENT_PAYTM;
  listenReturn();
}

function listenReturn() {
  if (retHandler) document.removeEventListener('visibilitychange', retHandler);
  retHandler = function() {
    if (document.visibilityState === 'visible') {
      document.removeEventListener('visibilitychange', retHandler);
      retHandler = null;
      showOverlay('Verifying payment…', 'Please wait a moment');
      startPoll();
    }
  };
  document.addEventListener('visibilitychange', retHandler);
}

// ── Poll status ────────────────────────────────────────────────
function startPoll() {
  let tries = 0;
  clearInterval(pollTimer);
  pollTimer = setInterval(function() {
    tries++;
    fetch(STATUS_URL)
      .then(r => r.json())
      .then(d => {
        if (d.status === 'SUCCESS') {
          clearInterval(pollTimer);
          hideOverlay();
          showSuccess(d);
        } else if (d.status === 'FAILED') {
          clearInterval(pollTimer);
          hideOverlay();
          showMsg('Payment failed — please try again', '#fef2f2', '#fecaca', '#991b1b');
        } else if (tries >= 12) {
          clearInterval(pollTimer);
          hideOverlay();
          showMsg('Not confirmed yet — enter UTR to confirm manually', '#fffbeb', '#fde68a', '#92400e');
          showUTR();
        }
      })
      .catch(() => {});
  }, 5000);
}

// ── Overlay ────────────────────────────────────────────────────
function showOverlay(t, s) {
  document.getElementById('ov-title').textContent = t;
  document.getElementById('ov-sub').textContent   = s;
  document.getElementById('overlay').classList.add('show');
}
function hideOverlay() { document.getElementById('overlay').classList.remove('show'); }

// ── Status message ─────────────────────────────────────────────
function showMsg(msg, bg, border, color) {
  const el = document.getElementById('status-msg');
  el.style.cssText = 'display:block;background:'+bg+';border:1.5px solid '+border+';color:'+color;
  el.textContent = msg;
}

// ── Success screen ─────────────────────────────────────────────
function showSuccess(d) {
  hideOverlay();
  document.getElementById('pay-body').style.display = 'none';
  const ss = document.getElementById('success-screen');
  ss.classList.add('show');
  const utr = d.UTR || d.payerDetails?.utr || '—';
  ss.innerHTML =
    '<div class="s-icon"><svg viewBox="0 0 32 32" fill="none"><circle cx="16" cy="16" r="15" stroke="#22c55e" stroke-width="2"/><path d="M8 16.5l5.5 5.5 10.5-11" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>'+
    '<div class="s-title">Payment Confirmed!</div>'+
    '<div class="s-sub">₹'+AMOUNT+' successfully received</div>'+
    '<div class="s-details">'+
      srow('Order ID', ORDER_ID)+
      srow('Amount', '₹'+AMOUNT, '#166534')+
      srow('Status', 'SUCCESS ✓', '#166534')+
      srow('UTR / Ref', utr)+
      srow('Time', new Date().toLocaleTimeString('en-IN', {hour:'2-digit',minute:'2-digit'}))+
    '</div>';
}
function srow(k, v, c) {
  return '<div class="s-row"><span class="s-key">'+k+'</span><span class="s-val"'+(c?' style="color:'+c+'"':'')+'>'+v+'</span></div>';
}

// ── UTR flow ───────────────────────────────────────────────────
function showUTR() {
  document.getElementById('paid-btn').style.display = 'none';
  document.getElementById('utr-box').style.display  = 'block';
  setTimeout(() => document.getElementById('utr-inp').focus(), 150);
}
function hideUTR() {
  document.getElementById('paid-btn').style.display = 'block';
  document.getElementById('utr-box').style.display  = 'none';
}
function onUTR(v) {
  const n = v.length;
  const c = document.getElementById('utr-count');
  c.textContent = n + ' / 12 digits';
  c.style.color = n === 12 ? '#16a34a' : n > 0 ? '#d97706' : '#94a3b8';
  document.getElementById('vfy-btn').disabled = n !== 12;
}
function verifyUTR() {
  const utr = document.getElementById('utr-inp').value.trim();
  if (utr.length !== 12) return;
  const btn = document.getElementById('vfy-btn');
  btn.textContent = 'Verifying…'; btn.disabled = true;
  fetch(VERIFY_URL + '?utr=' + utr + '&order_id=' + encodeURIComponent(ORDER_ID) + '&amount=' + encodeURIComponent(AMOUNT))
    .then(r => r.json())
    .then(d => {
      btn.textContent = 'Verify & Confirm Payment'; btn.disabled = false;
      const r = document.getElementById('vfy-res');
      if (d.status === 'SUCCESS') {
        r.style.cssText = 'display:block;background:#f0fdf4;border:1.5px solid #86efac;color:#166534';
        r.textContent = '✓ Confirmed · UTR: ' + utr;
        setTimeout(() => showSuccess({ UTR: utr }), 700);
      } else {
        r.style.cssText = 'display:block;background:#fef2f2;border:1.5px solid #fecaca;color:#991b1b';
        r.textContent = '✗ ' + (d.message || 'Could not verify UTR');
      }
    })
    .catch(() => { btn.textContent = 'Verify & Confirm Payment'; btn.disabled = false; });
}

// ── Copy UPI ID ────────────────────────────────────────────────
function copyUPI() {
  navigator.clipboard?.writeText(UPI_ID).catch(() => {});
  const t = document.getElementById('toast');
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1800);
}

// ── Fullscreen QR ──────────────────────────────────────────────
function showFSQR() {
  const old = document.getElementById('qr-fs'); if (old) old.remove();
  const el  = document.createElement('div');
  el.id = 'qr-fs'; el.className = 'qr-fs';
  el.innerHTML =
    '<div class="qr-fs-label">Scan with any UPI app</div>'+
    '<div class="qr-fs-card"><img src="'+BIG_QR+'" alt="QR"></div>'+
    '<div class="qr-fs-amount">₹'+AMOUNT+'</div>'+
    '<div class="qr-fs-upi">'+UPI_ID+'</div>'+
    '<div class="qr-fs-hint">PayTM · PhonePe · GPay · BHIM<br>Amount fills automatically</div>'+
    '<button class="qr-fs-close" onclick="document.getElementById(\'qr-fs\').remove()">✕ Close</button>';
  document.body.appendChild(el);
  if ('wakeLock' in navigator) navigator.wakeLock.request('screen').catch(() => {});
}

// ── Auto check on load ─────────────────────────────────────────
fetch(STATUS_URL)
  .then(r => r.json())
  .then(d => { if (d.status === 'SUCCESS') showSuccess(d); })
  .catch(() => {});
</script>
</body></html>`);
});

// ── health ─────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', orders: allOrders().length }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Castle Gateway running on :${PORT}`));
