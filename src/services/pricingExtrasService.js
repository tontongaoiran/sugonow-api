/**
 * SugoNow — src/services/pricingExtrasService.js
 *
 * Centralizes:
 *  - Surge pricing state (system-wide on/off + multiplier)
 *  - First-booking promo logic (free ride OR free delivery, capped)
 */
const { query } = require('../db/pool');

// ── Surge ──────────────────────────────────────────────────────────────────
async function getSurge() {
  const { rows } = await query(
    `SELECT key, value FROM app_settings
     WHERE key IN ('surge_active','surge_multiplier','surge_label')`
  );
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return {
    active:     map.surge_active === 'true',
    multiplier: parseFloat(map.surge_multiplier ?? '1.25'),
    label:      map.surge_label ?? 'Peak pricing in effect',
  };
}

async function setSurge(active, multiplier, label) {
  await query(`UPDATE app_settings SET value=$1, updated_at=NOW() WHERE key='surge_active'`,
    [active ? 'true' : 'false']);
  if (multiplier != null) {
    await query(`UPDATE app_settings SET value=$1, updated_at=NOW() WHERE key='surge_multiplier'`,
      [String(multiplier)]);
  }
  if (label != null) {
    await query(`UPDATE app_settings SET value=$1, updated_at=NOW() WHERE key='surge_label'`,
      [label]);
  }
  return getSurge();
}

// ── Promo ──────────────────────────────────────────────────────────────────
async function getPromoSettings() {
  const { rows } = await query(
    `SELECT key, value FROM app_settings WHERE key IN ('promo_active','promo_max_value')`
  );
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return {
    active:    map.promo_active === 'true',
    maxValue:  parseFloat(map.promo_max_value ?? '50'),
  };
}

/**
 * Determine if a customer is eligible for the first-booking promo,
 * and whether THIS service type matches their (or any) choice.
 * Returns { eligible, promoType, reason }
 */
async function checkPromoEligibility(customerId, serviceType) {
  const settings = await getPromoSettings();
  if (!settings.active) return { eligible: false, reason: 'promo_inactive' };

  const { rows } = await query(
    `SELECT first_promo_used, promo_choice FROM users WHERE id=$1`, [customerId]
  );
  if (!rows[0]) return { eligible: false, reason: 'no_user' };
  if (rows[0].first_promo_used) return { eligible: false, reason: 'already_used' };

  // Map service to promo type
  const isRide     = serviceType === 'ride';
  const isDelivery = serviceType === 'delivery' || serviceType === 'food' || serviceType === 'exchange';

  // If they already chose, only that type qualifies
  if (rows[0].promo_choice === 'free_ride' && !isRide)
    return { eligible: false, reason: 'chose_ride' };
  if (rows[0].promo_choice === 'free_delivery' && !isDelivery)
    return { eligible: false, reason: 'chose_delivery' };

  const promoType = isRide ? 'free_ride' : 'free_delivery';
  return { eligible: true, promoType, maxValue: settings.maxValue };
}

/**
 * Apply the promo to a fare. Returns the adjusted breakdown.
 * SugoNow covers up to maxValue; customer pays any excess.
 */
function applyPromo(originalFare, maxValue) {
  const sugonowCovers = Math.min(originalFare, maxValue);
  const customerPays  = Math.max(0, originalFare - maxValue);
  return {
    original_fare:  originalFare,
    sugonow_covers: sugonowCovers,
    customer_pays:  customerPays,
    promo_discount: sugonowCovers,
  };
}

/**
 * Lock in the promo after a completed booking.
 */
async function redeemPromo(customerId, bookingId, promoType, fareValue, maxValue) {
  const sugonowCost  = Math.min(fareValue, maxValue);
  const customerPaid = Math.max(0, fareValue - maxValue);

  await query(
    `UPDATE users SET first_promo_used=TRUE, promo_choice=$1 WHERE id=$2`,
    [promoType, customerId]
  );
  await query(
    `INSERT INTO promo_redemptions
       (customer_id, booking_id, promo_type, fare_value, sugonow_cost, customer_paid)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [customerId, bookingId, promoType, fareValue, sugonowCost, customerPaid]
  );
  return { sugonowCost, customerPaid };
}

module.exports = {
  getSurge, setSurge,
  getPromoSettings, checkPromoEligibility, applyPromo, redeemPromo,
};
