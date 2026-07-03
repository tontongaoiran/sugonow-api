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
  const receipt = rows[0];
  if (!receipt) return null;
  // Enrich at READ time (no migration): pull the itemized order lines and the
  // newer money fields (pickup fee, wallet credit) straight from the immutable
  // booking/order records so the customer gets a complete breakdown.
  const { rows: b } = await query(
    `SELECT b.service_type, b.pickup_distance_fare, b.wallet_credit_used,
            b.created_at, u.full_name AS driver_name
       FROM bookings b LEFT JOIN users u ON u.id = b.driver_id
      WHERE b.id = $1`, [bookingId]);
  const { rows: items } = await query(
    `SELECT product_name, quantity, unit_price,
            (unit_price * quantity) AS line_total, options_text
       FROM order_items WHERE booking_id = $1 ORDER BY id`, [bookingId]);
  const products_subtotal = items.reduce(
    (s, i) => s + (parseFloat(i.unit_price) || 0) * (parseInt(i.quantity) || 1), 0);
  return {
    ...receipt,
    service_type:         b[0]?.service_type || receipt.service_type || null,
    driver_name:          b[0]?.driver_name || null,
    pickup_distance_fare: parseFloat(b[0]?.pickup_distance_fare || 0),
    wallet_credit_used:   parseFloat(b[0]?.wallet_credit_used || 0),
    items,
    products_subtotal,
  };
}

async function getCustomerReceipts(customerId, limit = 50) {
  const { rows } = await query(
    `SELECT r.*, b.service_type
       FROM receipts r LEFT JOIN bookings b ON b.id = r.booking_id
      WHERE r.customer_id = $1 ORDER BY r.issued_at DESC LIMIT $2`,
    [customerId, limit]
  );
  return rows;
}

module.exports = { issueReceipt, getReceiptByBooking, getCustomerReceipts, nextReceiptNo };
