/**
 * SugoNow — src/services/merchantFeeService.js  (Batch G2-D)
 *
 * When an order completes, charge the merchant SugoNow's fee based on the fee
 * model admin set at approval (percent / flat / none). During the merchant's
 * free window (free_until in the future) the fee is WAIVED but still logged
 * (was_free=TRUE) so they can see the value they're getting free.
 *
 * The fee is based on the PRODUCTS subtotal for that store in the order — not
 * the delivery fee (that's the driver's) and not other stores' items.
 */
const { query } = require('../db/pool');

// Charge fees for every merchant whose products are in this booking.
async function chargeMerchantFees(bookingId) {
  try {
    // LPG and water are NOT charged a merchant fee: the driver pays the store
    // directly (collect-first), so SugoNow only earns the delivery fare +
    // booking fee. We still record the sale (order_items), but skip the fee.
    const { rows: svc } = await query(
      `SELECT service_type FROM bookings WHERE id = $1`, [bookingId]);
    if (svc[0] && ['exchange','lpg','water'].includes(svc[0].service_type)) {
      return;  // no merchant fee on LPG/water
    }
    // Idempotency: if this booking already has fee-ledger rows, it was already
    // charged — never charge a merchant twice for the same order, even on a retry
    // or an accidental re-trigger.
    const { rows: existing } = await query(
      `SELECT 1 FROM merchant_fee_ledger WHERE booking_id = $1 LIMIT 1`, [bookingId]);
    if (existing[0]) return;
    // Group the order's items by business, summing each store's product subtotal
    const { rows: perStore } = await query(
      `SELECT mi.business_id,
              COALESCE(SUM(oi.unit_price * oi.quantity), 0) AS order_value
       FROM order_items oi
       JOIN menu_items mi ON mi.id = oi.product_id
       WHERE oi.booking_id = $1 AND oi.status <> 'unavailable'
       GROUP BY mi.business_id`,
      [bookingId]);

    for (const store of perStore) {
      const { rows: bizRows } = await query(
        `SELECT commission_type, commission_value, free_until
         FROM businesses WHERE id = $1`,
        [store.business_id]);
      const biz = bizRows[0];
      if (!biz) continue;

      const orderValue = parseFloat(store.order_value) || 0;
      const feeType  = biz.commission_type || 'percent';
      const feeValue = parseFloat(biz.commission_value) || 0;

      // Compute the fee by model
      let feeAmount = 0;
      if (feeType === 'percent') feeAmount = Math.round(orderValue * (feeValue / 100));
      else if (feeType === 'flat') feeAmount = Math.round(feeValue);
      else feeAmount = 0; // 'none'

      // Free window? (free_until today or later means still free)
      const isFree = biz.free_until && new Date(biz.free_until) >= new Date();
      const charged = isFree ? 0 : feeAmount;

      // Log it (always, even when free — shows the value provided)
      await query(
        `INSERT INTO merchant_fee_ledger
           (business_id, booking_id, order_value, fee_type, fee_value, fee_amount, was_free)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [store.business_id, bookingId, orderValue, feeType, feeValue, feeAmount, !!isFree]);

      // Add to owed balance only if actually charged
      if (charged > 0) {
        await query(
          `UPDATE businesses SET fee_owed = fee_owed + $1 WHERE id = $2`,
          [charged, store.business_id]);
      }
    }
  } catch (e) {
    // Fee accounting must never block order completion
    console.error('chargeMerchantFees error:', e.message);
  }
}

module.exports = { chargeMerchantFees };
