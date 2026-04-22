# Castle Gateway v2 — PayTM UPI

Proper UPI intent gateway with `tr`, `tid`, and `mc` parameters — the same fields real payment gateways use. This prevents UPI risk policy errors.

---

## Why this fixes the risk policy error

Real PGs like Razorpay/PayU include these fields in every UPI intent:

| Parameter | Meaning | Your old code | This version |
|---|---|---|---|
| `tr` | Transaction Reference (unique per txn) | ❌ Missing | ✅ Auto-generated |
| `tid` | PSP Transaction ID | ❌ Missing | ✅ Auto-generated |
| `mc` | Merchant Category Code | ❌ Missing | ✅ Set to 5815 |

UPI apps (PayTM, PhonePe, GPay) use `tr` + `mc` to identify this as a **merchant payment** vs a personal P2P transfer. Without them, the risk engine flags it.

---

## Setup

### 1. Edit `server.js` — top section

```js
const MERCHANT = {
  upi : 'paytm.s1h4uwq@pty',         // ← your real PayTM VPA
  name: 'Audiva Fm Private Limited',  // ← must match registered name EXACTLY
  mc  : '5815',                       // ← MCC: 5815=digital goods, 7372=software
};
```

**Common MCC codes:**
- `5815` — Digital goods / media
- `7372` — Software / SaaS
- `5999` — Miscellaneous retail
- `7999` — Entertainment / amusement

### 2. Deploy to Railway

```bash
git init && git add . && git commit -m "init"
# Connect repo to Railway → deploy
```

Railway sets `RAILWAY_PUBLIC_DOMAIN` automatically.

---

## API

### Create Order
```
POST /api/create
Content-Type: application/json

{ "amount": "499.00", "order_id": "ORD001" }
```

**Response:**
```json
{
  "status": "SUCCESS",
  "order_id": "ORD001",
  "amount": "499.00",
  "payment_url": "https://your-app.railway.app/pay/ORD001"
}
```

### Check Status
```
GET /api/status?order_id=ORD001
```

### Verify UTR
```
GET /api/verify?utr=123456789012&order_id=ORD001&amount=499.00
```

### Payment Page
```
GET /pay/ORD001
```
Send this URL to customer.

---

## Notes
- `tr` = timestamp + SHA256 hash of order_id (22 chars, unique per order)
- `tid` = `PG` + tr
- QR encodes the generic `upi://` intent — works with all UPI apps
- PayTM deep link uses `paytmmp://` scheme for direct app open
- Orders stored as JSON in `/data/` directory
- UTR duplicate check prevents double-confirmation
