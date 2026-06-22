/**
 * SugoNow — src/services/receiptService.js
 *
 * Creates an e-receipt for a completed booking and returns it.
 * Receipt number format: SN-YYYYMMDD-#### (resets daily).
 */
const { query } = require('../db/pool');

async function nextReceiptNo() {
  const today = new Date().toISOString().slice(0, 10);          // YYYY-MM-DD
  const compact = today.replace(/-/g, '');                       // YYYYMMDD
  // Atomic increment of the daily counter
  const { rows } = await query(
    `INSERT INTO receipt_counter (day, seq) VALUES ($1, 1)
     ON CONFLICT (day) DO UPDATE SET seq = receipt_counter.seq + 1
     RETURNING seq`,
    [today]
  );
  const seq = String(rows[0].seq).padStart(4, '0');
  return `SN-${compact}-${seq}`;
}

/**
 * Build and store a receipt for a booking.
 * `extra` lets the caller pass the money breakdown captured at completion.
 */
async function issueReceipt(booking, extra = {}) {
  const receiptNo = await nextReceiptNo();

  const {
    base_fare = 0, distance_charge = 0, delivery_fee = 0,
    lpg_product_cost = 0, stopover_charge = 0, surge_amount = 0,
    discount_amount = 0, promo_discount = 0, booking_fee = 0,
    total_paid, notes = null,
  } = extra;

  const { rows } = await query(
    `INSERT INTO receipts
       (receipt_no, booking_id, customer_id, driver_id, service_type,
        base_fare, distance_charge, delivery_fee, lpg_product_cost,
        stopover_charge, surge_amount, discount_amount, promo_discount,
        booking_fee, total_paid, payment_method,
        pickup_address, dropoff_address, lpg_mode, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     RETURNING *`,
    [
      receiptNo, booking.id, booking.customer_id, booking.driver_id || null,
      booking.service_type,
      base_fare, distance_charge, delivery_fee, lpg_product_cost,
      stopover_charge, surge_amount, discount_amount, promo_discount,
      booking_fee, total_paid, booking.payment_method,
      booking.pickup_address || null, booking.dropoff_address || null,
      booking.lpg_mode || null, notes,
    ]
  );
  return rows[0];
}

async function getReceiptByBooking(bookingId) {
  const { rows } = await query(
    `SELECT * FROM receipts WHERE booking_id = $1 ORDER BY issued_at DESC LIMIT 1`,
    [bookingId]
  );
  return rows[0] || null;
}

async function getCustomerReceipts(customerId, limit = 50) {
  const { rows } = await query(
    `SELECT * FROM receipts WHERE customer_id = $1 ORDER BY issued_at DESC LIMIT $2`,
    [customerId, limit]
  );
  return rows;
}

module.exports = { issueReceipt, getReceiptByBooking, getCustomerReceipts, nextReceiptNo };
