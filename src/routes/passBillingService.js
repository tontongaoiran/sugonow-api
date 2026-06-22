/**
 * SugoNow — src/services/passBillingService.js
 *
 * Handles:
 *  - SugoNow Pass (₱99 / 30 days) — WAIVES the ₱5 booking fee (no % discount)
 *  - Booking fee (₱5 platform fee) applied to every booking for non-members
 *  - Driver ledger entries (cash vs e-wallet money flow)
 *
 * Activation rules:
 *  - Paid by e-wallet  -> Pass auto-activates immediately
 *  - Paid by cash      -> recorded as 'pending'; admin confirms to activate
 */
const { query } = require('../db/pool');

// ── Settings ─────────────────────────────────────────────────────────────────
async function getSettings() {
  const { rows } = await query(
    `SELECT key, value FROM app_settings
     WHERE key IN ('booking_fee','booking_fee_active','pass_price','pass_days','pass_active')`
  );
  const m = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return {
    bookingFee:       parseFloat(m.booking_fee ?? '5'),
    bookingFeeActive: m.booking_fee_active === 'true',
    passPrice:        parseFloat(m.pass_price ?? '99'),
    passDays:         parseInt(m.pass_days ?? '30'),
    passActive:       m.pass_active === 'true',
  };
}

const EWALLET_METHODS = ['gcash', 'maya', 'palawan', 'gotyme'];
function isEwallet(method) { return EWALLET_METHODS.includes((method || '').toLowerCase()); }

// ── SugoNow Pass status ──────────────────────────────────────────────────────
async function getPassStatus(customerId) {
  const { rows } = await query(
    `SELECT pass_active, pass_expires, pass_since FROM users WHERE id=$1`, [customerId]
  );
  if (!rows[0]) return { active: false };
  const exp = rows[0].pass_expires ? new Date(rows[0].pass_expires) : null;
  const active = rows[0].pass_active && exp && exp >= new Date();
  return { active, expires: rows[0].pass_expires, since: rows[0].pass_since };
}

function addDays(base, days) {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Activate (or extend) a pass for `days`. Extends from current expiry if still
 * active, else from today.
 */
async function activatePass(customerId, paymentMethod, adminId, subId = null) {
  const settings = await getSettings();
  const { rows: u } = await query(`SELECT pass_expires FROM users WHERE id=$1`, [customerId]);
  const today = new Date();
  let base = today;
  if (u[0]?.pass_expires && new Date(u[0].pass_expires) > today) base = new Date(u[0].pass_expires);
  const expiryStr = addDays(base, settings.passDays);

  await query(
    `UPDATE users SET pass_active=TRUE, pass_expires=$1,
            pass_since=COALESCE(pass_since, CURRENT_DATE) WHERE id=$2`,
    [expiryStr, customerId]
  );
  if (subId) {
    await query(
      `UPDATE pass_subscriptions
       SET status='active', starts_on=CURRENT_DATE, expires_on=$1,
           recorded_by=$2, confirmed_at=NOW()
       WHERE id=$3`,
      [expiryStr, adminId, subId]
    );
  }
  return { expires: expiryStr, price: settings.passPrice };
}

/**
 * Customer initiates a pass purchase.
 *  - e-wallet  -> auto-activate, return active
 *  - cash      -> create a 'pending' subscription; admin must confirm
 */
async function purchasePass(customerId, paymentMethod = 'cash', gcashRef = null, proofUrl = null) {
  const settings = await getSettings();

  // GCash now requires a screenshot + reference and ADMIN confirmation (the
  // customer is paying SugoNow's GCash; admin verifies before activating).
  // Only treat as auto-activating e-wallet if it's a real auto-confirmed method
  // — which, for now, none are. GCash and cash both go to pending.
  const autoActivate = false;

  const { rows } = await query(
    `INSERT INTO pass_subscriptions
       (customer_id, amount, status, payment_method, gcash_ref, proof_url)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [customerId, settings.passPrice, autoActivate ? 'active' : 'pending',
     paymentMethod, gcashRef, proofUrl]
  );
  const subId = rows[0].id;

  if (autoActivate) {
    const r = await activatePass(customerId, paymentMethod, null, subId);
    return { status: 'active', ...r };
  }

  const isGcash = (paymentMethod || '').toLowerCase() === 'gcash';
  return { status: 'pending', price: settings.passPrice,
           message: isGcash
             ? 'Thanks! Admin will verify your GCash payment and activate your Pass shortly.'
             : 'Pay ₱' + settings.passPrice + ' cash at the SugoNow office. Admin will activate your Pass.' };
}

// Admin confirms a pending (cash) pass payment
async function confirmPass(subId, adminId) {
  const { rows } = await query(`SELECT customer_id, payment_method FROM pass_subscriptions WHERE id=$1`, [subId]);
  if (!rows[0]) throw new Error('Subscription not found.');
  return activatePass(rows[0].customer_id, rows[0].payment_method, adminId, subId);
}

// ── Booking fee logic ────────────────────────────────────────────────────────
/**
 * Returns { fee, waived } for a booking. Pass members get the fee waived.
 */
async function bookingFeeFor(customerId) {
  const settings = await getSettings();
  if (!settings.bookingFeeActive) return { fee: 0, waived: false };
  const status = await getPassStatus(customerId);
  if (status.active) return { fee: 0, waived: true };   // Pass member → free
  return { fee: settings.bookingFee, waived: false };
}

// ── Driver ledger ────────────────────────────────────────────────────────────
async function addLedgerEntry(driverId, { bookingId, entryType, direction, amount, note }) {
  await query(
    `INSERT INTO driver_ledger (driver_id, booking_id, entry_type, direction, amount, note)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [driverId, bookingId || null, entryType, direction, amount, note || null]
  );
  if (direction === 'sugonow_owes_driver') {
    await query(
      `UPDATE driver_profiles SET sugonow_owes = sugonow_owes + $1 WHERE user_id=$2`,
      [amount, driverId]
    );
  }
}

async function getDriverLedger(driverId, limit = 50) {
  const { rows } = await query(
    `SELECT * FROM driver_ledger WHERE driver_id=$1 ORDER BY created_at DESC LIMIT $2`,
    [driverId, limit]
  );
  return rows;
}

module.exports = {
  getSettings, isEwallet,
  getPassStatus, purchasePass, confirmPass, activatePass, bookingFeeFor,
  addLedgerEntry, getDriverLedger,
};
