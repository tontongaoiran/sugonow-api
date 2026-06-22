/**
 * SugoNow — src/services/priceService.js
 *
 * Core price management logic:
 *  - updatePrice()          — admin updates LPG/water/product prices
 *  - getActivePrice()       — get current price for a product
 *  - reportDiscrepancy()    — driver reports actual vs app price
 *  - resolveDiscrepancy()   — customer accepts or cancels after price change
 *  - holdDeposit()          — create container deposit on order
 *  - releaseDeposit()       — return deposit when empty container collected
 *  - forfeitExpiredDeposits() — daily cron: forfeit 60-day-old deposits
 *  - getPriceHistory()      — audit trail for admin
 *  - getVolatilitySummary() — price swing stats for admin dashboard
 */

const { query, withTransaction } = require('../db/pool');
const { sendSms, sendNotificationSms } = require('./smsService');
const { sendPush }               = require('./pushNotificationService');

// Load config value
const cfg = async (key, fallback) => {
  try {
    const { rows } = await query('SELECT value FROM app_config WHERE key=$1', [key]);
    return rows[0] ? parseFloat(rows[0].value) || rows[0].value : fallback;
  } catch { return fallback; }
};

// ─── UPDATE PRICE ─────────────────────────────────────────────────────────────
// Called from admin panel. Triggers DB log_price_change() trigger automatically.
const updatePrice = async ({
  productPriceId,
  exchangePrice,
  noTankPrice,
  basePrice,
  deliveryFee,
  handlingFee,
  reason,
  effectiveFrom,
  adminId,
  notifyCustomers = false,
}) => {
  return withTransaction(async (client) => {
    // Load current price for comparison
    const { rows: cur } = await client.query(
      'SELECT * FROM product_prices WHERE id=$1', [productPriceId]
    );
    if (!cur[0]) throw new Error('Product not found.');
    const current = cur[0];

    // Update price (trigger auto-logs to price_history)
    const { rows: updated } = await client.query(
      `UPDATE product_prices SET
         exchange_price = COALESCE($1, exchange_price),
         no_tank_price  = COALESCE($2, no_tank_price),
         base_price     = COALESCE($3, base_price),
         delivery_fee   = COALESCE($4, delivery_fee),
         handling_fee   = COALESCE($5, handling_fee),
         reason         = $6,
         effective_from = COALESCE($7, NOW()),
         updated_by     = $8,
         updated_at     = NOW()
       WHERE id = $9
       RETURNING *`,
      [
        exchangePrice ?? null,
        noTankPrice   ?? null,
        basePrice     ?? null,
        deliveryFee   ?? null,
        handlingFee   ?? null,
        reason || 'Price update',
        effectiveFrom ?? null,
        adminId,
        productPriceId,
      ]
    );

    const newPrice = updated[0];
    const change   = (newPrice.exchange_price ?? 0) - (current.exchange_price ?? 0);
    const absChange = Math.abs(change);

    // Notify customers if change is significant
    const notifyThreshold = await cfg('price_change_sms_threshold', 50);
    if (notifyCustomers && absChange >= notifyThreshold) {
      await notifyRecentLPGCustomers(
        current.business_id,
        current.product_name,
        current.exchange_price,
        newPrice.exchange_price,
        change,
        client
      );
    }

    return {
      success:         true,
      product:         newPrice.product_name,
      old_exchange:    current.exchange_price,
      new_exchange:    newPrice.exchange_price,
      change_amount:   change,
      change_pct:      current.exchange_price
        ? ((change / current.exchange_price) * 100).toFixed(1) + '%'
        : null,
    };
  });
};

// Notify customers who ordered this product in the last 30 days
const notifyRecentLPGCustomers = async (businessId, productName, oldPrice, newPrice, change, client) => {
  const { rows: customers } = await client.query(
    `SELECT DISTINCT u.id, u.mobile, u.full_name
     FROM bookings b
     JOIN users u ON u.id = b.customer_id
     WHERE b.created_at > NOW() - INTERVAL '30 days'
       AND b.service_type IN ('food','delivery','exchange')
       AND EXISTS (
         SELECT 1 FROM product_prices pp
         WHERE pp.business_id = $1 AND b.product_price_id = pp.id
       )
     LIMIT 200`,
    [businessId]
  );

  const direction = change > 0 ? 'increased' : 'decreased';
  const msg = `SugoNow: ${productName} price ${direction} by ₱${Math.abs(change)}. ` +
    `New price: ₱${newPrice} (exchange). ` +
    `Open SugoNow to see updated prices.`;

  // Send SMS to each (non-blocking — fire and forget)
  for (const c of customers) {
    sendNotificationSms(c.mobile, msg).catch(() => {});
  }
  console.log(`[PriceService] Notified ${customers.length} customers of price change.`);
};

// ─── GET ACTIVE PRICE ─────────────────────────────────────────────────────────
const getActivePrice = async (productPriceId) => {
  const { rows } = await query(
    `SELECT pp.*, b.name AS business_name, b.address AS business_address
     FROM product_prices pp
     JOIN businesses b ON b.id = pp.business_id
     WHERE pp.id = $1 AND pp.is_available = TRUE`,
    [productPriceId]
  );
  return rows[0] ?? null;
};

// Get all prices for a business
const getBusinessPrices = async (businessId) => {
  const { rows } = await query(
    `SELECT pp.*,
            (SELECT new_exchange_price FROM price_history
             WHERE product_price_id = pp.id
             ORDER BY changed_at DESC LIMIT 1) AS prev_exchange_price,
            (SELECT changed_at FROM price_history
             WHERE product_price_id = pp.id
             ORDER BY changed_at DESC LIMIT 1) AS last_changed_at
     FROM product_prices pp
     WHERE pp.business_id = $1
     ORDER BY pp.product_name`,
    [businessId]
  );
  return rows;
};

// ─── REPORT DISCREPANCY (driver reports actual price at dealer) ───────────────
const reportDiscrepancy = async ({
  bookingId,
  productPriceId,
  driverId,
  customerId,
  appPrice,
  actualPrice,
}) => {
  const difference     = Math.round((actualPrice - appPrice) * 100) / 100;
  const absoDiff       = Math.abs(difference);
  const tolerance      = await cfg('price_discrepancy_tolerance', 20);
  const withinTolerance = absoDiff <= tolerance;

  // Log the discrepancy
  const { rows } = await query(
    `INSERT INTO price_discrepancies
       (booking_id, product_price_id, driver_id, customer_id,
        app_price, actual_price, difference, within_tolerance)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id`,
    [bookingId, productPriceId ?? null, driverId, customerId,
     appPrice, actualPrice, difference, withinTolerance]
  );
  const discrepancyId = rows[0].id;

  // If within tolerance — auto-proceed, no customer notification needed
  if (withinTolerance) {
    await query(
      `UPDATE price_discrepancies
       SET customer_action='auto_proceed', responded_at=NOW()
       WHERE id=$1`,
      [discrepancyId]
    );
    // Update booking with confirmed price
    await query(
      'UPDATE bookings SET confirmed_price=$1 WHERE id=$2',
      [actualPrice, bookingId]
    );
    return {
      action:     'auto_proceed',
      difference,
      message:    `Price difference of ₱${absoDiff} is within the ₱${tolerance} tolerance. Proceeding automatically.`,
    };
  }

  // Outside tolerance — notify customer
  const timeoutMin = await cfg('price_confirm_timeout_minutes', 5);

  // Get customer contact
  const { rows: custRows } = await query(
    'SELECT mobile, full_name FROM users WHERE id=$1', [customerId]
  );
  const customer = custRows[0];

  const notifyMsg =
    difference > 0
      ? `SugoNow: Your LPG order price changed. App showed ₱${appPrice}, actual price is ₱${actualPrice} (+₱${difference}). ` +
        `Reply YES to proceed or NO to cancel. You have ${timeoutMin} minutes.`
      : `SugoNow: Good news! Your LPG order is ₱${Math.abs(difference)} cheaper than expected. ` +
        `Actual price: ₱${actualPrice}. Driver is proceeding.`;

  await sendNotificationSms(customer.mobile, notifyMsg);
  await sendPush(customerId, '⚠️ LPG price changed',
    `Actual price is ₱${actualPrice} (app showed ₱${appPrice}). Tap to confirm or cancel.`,
    { type: 'price_discrepancy', bookingId, discrepancyId }
  );

  await query(
    'UPDATE price_discrepancies SET notified_at=NOW() WHERE id=$1',
    [discrepancyId]
  );

  // If price went DOWN, auto-proceed with actual (lower) price — customer benefits
  if (difference < 0) {
    await query(
      `UPDATE price_discrepancies
       SET customer_action='auto_proceed', responded_at=NOW() WHERE id=$1`,
      [discrepancyId]
    );
    await query('UPDATE bookings SET confirmed_price=$1 WHERE id=$2',
      [actualPrice, bookingId]);
    return {
      action:     'auto_proceed',
      difference,
      message:    `Price is ₱${Math.abs(difference)} lower. Auto-proceeding with reduced price.`,
    };
  }

  // Price is higher — wait for customer response
  // Set a timeout job (in production, use a proper job queue like Bull)
  setTimeout(async () => {
    const { rows: checkRows } = await query(
      'SELECT customer_action FROM price_discrepancies WHERE id=$1',
      [discrepancyId]
    );
    // If still no response after timeout → auto-cancel
    if (!checkRows[0]?.customer_action) {
      await query(
        `UPDATE price_discrepancies
         SET customer_action='timeout', responded_at=NOW() WHERE id=$1`,
        [discrepancyId]
      );
      await query(
        `UPDATE bookings SET status='cancelled', cancel_reason=$1 WHERE id=$2`,
        [`Price discrepancy — customer did not respond within ${timeoutMin} minutes.`, bookingId]
      );
      await sendNotificationSms(customer.mobile,
        `SugoNow: Your LPG order was cancelled — no response to price change notification. No charge applied.`
      );
      console.log(`[PriceService] Discrepancy ${discrepancyId} timed out — booking cancelled.`);
    }
  }, timeoutMin * 60 * 1000);

  return {
    action:          'awaiting_customer',
    discrepancy_id:  discrepancyId,
    difference,
    timeout_minutes: timeoutMin,
    message:         `Customer notified. Waiting up to ${timeoutMin} min for response.`,
  };
};

// ─── RESOLVE DISCREPANCY (customer responds YES or NO) ────────────────────────
const resolveDiscrepancy = async (discrepancyId, customerId, action) => {
  const { rows } = await query(
    `SELECT pd.*, b.driver_id, u.mobile AS driver_mobile
     FROM price_discrepancies pd
     JOIN bookings b ON b.id = pd.booking_id
     JOIN users u ON u.id = b.driver_id
     WHERE pd.id=$1 AND pd.customer_id=$2 AND pd.customer_action IS NULL`,
    [discrepancyId, customerId]
  );
  if (!rows[0]) {
    return { success: false, message: 'Discrepancy not found or already resolved.' };
  }
  const disc = rows[0];

  const customerAction = action === 'accept' ? 'accepted' : 'cancelled';
  await query(
    'UPDATE price_discrepancies SET customer_action=$1, responded_at=NOW() WHERE id=$2',
    [customerAction, discrepancyId]
  );

  if (customerAction === 'accepted') {
    // Update booking with confirmed price
    await query(
      'UPDATE bookings SET confirmed_price=$1 WHERE id=$2',
      [disc.actual_price, disc.booking_id]
    );
    // Notify driver to proceed
    await sendNotificationSms(disc.driver_mobile,
      `SugoNow: Customer accepted the price of ₱${disc.actual_price}. Please proceed with pickup.`
    );
    await sendPush(disc.driver_id, '✅ Customer accepted price',
      `Proceed with LPG pickup at ₱${disc.actual_price}.`,
      { type: 'price_accepted', bookingId: disc.booking_id }
    );
    return { success: true, action: 'accepted', proceed: true };
  } else {
    // Cancel booking
    await query(
      `UPDATE bookings SET status='cancelled', cancel_reason='Customer declined price change.' WHERE id=$1`,
      [disc.booking_id]
    );
    await sendNotificationSms(disc.driver_mobile,
      `SugoNow: Customer declined the new price. Booking cancelled — do not pick up. Thank you.`
    );
    return { success: true, action: 'cancelled', proceed: false };
  }
};

// ─── CONTAINER DEPOSIT MANAGEMENT ─────────────────────────────────────────────
const holdDeposit = async (customerId, bookingId, businessId, productName, depositAmount) => {
  if (!depositAmount || depositAmount <= 0) return null;
  const forfeitDays = await cfg('container_deposit_days', 60);
  const forfeitureDate = new Date();
  forfeitureDate.setDate(forfeitureDate.getDate() + forfeitDays);

  const { rows } = await query(
    `INSERT INTO container_deposits
       (customer_id, booking_id, business_id, product_name,
        deposit_amount, status, forfeiture_date)
     VALUES ($1,$2,$3,$4,$5,'held',$6)
     RETURNING id`,
    [customerId, bookingId, businessId, productName,
     depositAmount, forfeitureDate.toISOString().split('T')[0]]
  );
  return rows[0].id;
};

const releaseDeposit = async (customerId, returnBookingId, businessId, productName) => {
  const { rows } = await query(
    `UPDATE container_deposits
     SET status='returned',
         return_booking_id=$1,
         returned_at=NOW()
     WHERE customer_id=$2
       AND business_id=$3
       AND product_name ILIKE $4
       AND status='held'
     ORDER BY created_at ASC
     LIMIT 1
     RETURNING deposit_amount`,
    [returnBookingId, customerId, businessId, `%${productName}%`]
  );
  if (!rows[0]) return null;

  // Credit deposit back to customer wallet or apply to current order
  return { refunded: rows[0].deposit_amount };
};

const getCustomerDeposits = async (customerId) => {
  const { rows } = await query(
    `SELECT cd.*, b.name AS business_name
     FROM container_deposits cd
     JOIN businesses b ON b.id = cd.business_id
     WHERE cd.customer_id=$1 AND cd.status='held'
     ORDER BY cd.created_at DESC`,
    [customerId]
  );
  const total = rows.reduce((s, r) => s + parseFloat(r.deposit_amount), 0);
  return { deposits: rows, total_held: total };
};

// ─── FORFEIT EXPIRED DEPOSITS (run as daily cron at 1AM) ─────────────────────
const forfeitExpiredDeposits = async () => {
  const { rows } = await query(
    `UPDATE container_deposits
     SET status='forfeited',
         forfeited_at=NOW(),
         forfeiture_note='Auto-forfeited after 60 days — container not returned.'
     WHERE status='held'
       AND forfeiture_date <= CURRENT_DATE
     RETURNING customer_id, business_id, product_name, deposit_amount`
  );

  console.log(`[Deposits] Forfeited ${rows.length} expired deposits.`);

  // Notify customers of forfeiture
  for (const dep of rows) {
    const { rows: cRows } = await query(
      'SELECT mobile FROM users WHERE id=$1', [dep.customer_id]
    );
    if (cRows[0]) {
      sendNotificationSms(cRows[0].mobile,
        `SugoNow: Your ₱${dep.deposit_amount} container deposit for ${dep.product_name} ` +
        `has been forfeited after 60 days. Please return containers promptly in future orders.`
      ).catch(() => {});
    }
  }
  return rows.length;
};

// ─── PRICE HISTORY ────────────────────────────────────────────────────────────
const getPriceHistory = async (productPriceId, limit = 20) => {
  const { rows } = await query(
    `SELECT ph.*,
            u.full_name AS changed_by_name
     FROM price_history ph
     LEFT JOIN users u ON u.id = ph.changed_by
     WHERE ph.product_price_id=$1
     ORDER BY ph.changed_at DESC
     LIMIT $2`,
    [productPriceId, limit]
  );
  return rows;
};

// ─── VOLATILITY SUMMARY ────────────────────────────────────────────────────────
const getVolatilitySummary = async (productPriceId, days = 30) => {
  const { rows } = await query(
    `SELECT
       COUNT(*)::int                           AS change_count,
       MAX(new_exchange_price)::numeric        AS highest_price,
       MIN(new_exchange_price)::numeric        AS lowest_price,
       MAX(new_exchange_price) -
         MIN(new_exchange_price)               AS price_swing,
       AVG(new_exchange_price)::numeric        AS average_price,
       SUM(CASE WHEN exchange_change > 0
           THEN 1 ELSE 0 END)::int             AS increases,
       SUM(CASE WHEN exchange_change < 0
           THEN 1 ELSE 0 END)::int             AS decreases
     FROM price_history
     WHERE product_price_id=$1
       AND changed_at > NOW() - ($2 || ' days')::INTERVAL`,
    [productPriceId, days]
  );

  const current = await getActivePrice(productPriceId);
  return {
    ...rows[0],
    current_price: current?.exchange_price,
    period_days:   days,
    is_high_volatility: parseFloat(rows[0]?.price_swing ?? 0) > 100,
  };
};

// ─── DOE PRICE FEED (weekly auto-sync) ────────────────────────────────────────
// Fetches DOE weekly bulletin and proposes price updates for admin approval.
// In production, run this as a Monday morning cron job.
const fetchDOEPriceFeed = async () => {
  const today = new Date().toISOString().split('T')[0];
  console.log(`[DOE] Fetching price bulletin for ${today}...`);

  try {
    // NOTE: The DOE publishes LPG prices at:
    // https://www.doe.gov.ph/petroleum-products-monitoring
    // The actual fetch requires scraping their PDF bulletin.
    // In Phase 2, integrate with a proper DOE API or scraper service.
    // For now, this is a placeholder that logs to doe_price_feed
    // and flags admin for manual verification.

    await query(
      `INSERT INTO doe_price_feed
         (bulletin_date, region, source_url, raw_data)
       VALUES ($1, 'Cagayan Valley', $2, $3)
       ON CONFLICT (bulletin_date) DO NOTHING`,
      [
        today,
        'https://www.doe.gov.ph/petroleum-products-monitoring',
        JSON.stringify({ note: 'Manual verification required — automated scraper not yet integrated.' }),
      ]
    );

    // SMS admin to check DOE and update prices manually
    const { rows: admins } = await query(
      `SELECT mobile FROM users WHERE role='admin' LIMIT 1`
    );
    if (admins[0]) {
      await sendSms(admins[0].mobile,
        `SugoNow reminder: It's Monday — check the DOE weekly oil bulletin and update LPG prices in the admin panel. doe.gov.ph/petroleum-products-monitoring`
      );
    }
    return { success: true, action: 'admin_notified' };
  } catch (err) {
    console.error('[DOE] Feed error:', err.message);
    return { success: false, error: err.message };
  }
};

module.exports = {
  updatePrice,
  getActivePrice,
  getBusinessPrices,
  reportDiscrepancy,
  resolveDiscrepancy,
  holdDeposit,
  releaseDeposit,
  getCustomerDeposits,
  forfeitExpiredDeposits,
  getPriceHistory,
  getVolatilitySummary,
  fetchDOEPriceFeed,
};
