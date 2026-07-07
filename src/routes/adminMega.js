/**
 * SugoNow — src/routes/adminMega.js
 *
 * Additional admin endpoints (mount alongside existing admin.js):
 * - Reports/complaints viewing & resolution
 * - Transaction analytics (per driver, per town, overall)
 * - Commission clearing (unlock drivers)
 */
const express = require('express');
const { query } = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');
const { sendSms } = require('../services/smsService');
const { sendPush } = require('../services/pushNotificationService');
const G = require('../services/growthService');
const { cooldownSettings, _bustCooldownCache } = require('./bookings');
const { getFareConfig, bustFareConfigCache } = require('../services/fareService');

const DELIVERY_BONUS = 5; // ₱ per completed delivery (Month 1-2 launch promo)

const router = express.Router();
router.use(authenticate, requireRole('admin'));

// ─── GET /admin/reports — complaints (from customers AND drivers) ────────────
router.get('/reports', async (req, res) => {
  try {
    const { resolved = 'false' } = req.query;
    const { rows } = await query(
      `SELECT r.id, r.booking_id, r.stars, r.comment,
              r.report_type, r.resolved, r.created_at,
              r.customer_id, r.driver_id,
              cu.full_name AS customer_name, cu.mobile AS customer_mobile,
              du.full_name AS driver_name, du.mobile AS driver_mobile,
              CASE WHEN r.comment LIKE '[DRIVER REPORT]%'
                   THEN 'driver' ELSE 'customer' END AS filed_by
       FROM ratings r
       LEFT JOIN users cu ON cu.id = r.customer_id
       LEFT JOIN users du ON du.id = r.driver_id
       WHERE r.is_report=TRUE AND r.resolved=$1
       ORDER BY r.created_at DESC LIMIT 100`,
      [resolved === 'true']
    );
    res.json({ success: true, reports: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PATCH /admin/reports/:id/resolve ────────────────────────────────────────
router.patch('/reports/:id/resolve', async (req, res) => {
  try {
    await query('UPDATE ratings SET resolved=TRUE WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /admin/ratings — driver ratings overview ────────────────────────────
router.get('/ratings', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT du.full_name AS driver_name, dp.plate_number,
              dp.rating, dp.total_trips,
              COUNT(r.id)::int AS total_ratings,
              COUNT(r.id) FILTER (WHERE r.is_report)::int AS total_reports
       FROM driver_profiles dp
       JOIN users du ON du.id = dp.user_id
       LEFT JOIN ratings r ON r.driver_id = dp.user_id
       GROUP BY du.full_name, dp.plate_number, dp.rating, dp.total_trips
       ORDER BY dp.rating DESC NULLS LAST`
    );
    res.json({ success: true, ratings: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /admin/analytics — transaction analytics ────────────────────────────
// Commission / revenue oversight — SugoNow's earnings, driver vs merchant.
//  - Driver cut = sum of driver wallet 'commission' debits (commission + booking
//    fee folded together at completion), by transaction date.
//  - Merchant fees collected = approved merchant fee payments, by resolved date.
//  - Outstanding merchant fees = current SUM(fee_owed) snapshot (not period-based).
router.get('/commission-report', async (req, res) => {
  try {
    const TZ = "NOW() AT TIME ZONE 'Asia/Manila'";
    const periods = {
      week:      `>= date_trunc('week',  ${TZ})`,
      month:     `>= date_trunc('month', ${TZ})`,
      lastMonth: `>= date_trunc('month', ${TZ}) - INTERVAL '1 month' AND %COL% < date_trunc('month', ${TZ})`,
    };
    const out = { driver: {}, merchant: {}, total: {} };

    for (const [k, cond] of Object.entries(periods)) {
      // Driver-side cut (commission + booking fee). Stored as negative amounts.
      const dCond = cond.replace('%COL%', 't.created_at');
      const { rows: dr } = await query(
        `SELECT COALESCE(SUM(ABS(t.amount)),0) AS amt
         FROM driver_wallet_transactions t
         WHERE t.type='commission' AND t.created_at ${dCond}`);
      // Merchant fees collected (approved payments) in the period.
      const mCond = cond.replace('%COL%', 'pr.resolved_at');
      const { rows: mr } = await query(
        `SELECT COALESCE(SUM(pr.amount),0) AS amt
         FROM merchant_fee_payment_requests pr
         WHERE pr.status='approved' AND pr.resolved_at ${mCond}`);
      const d = Math.round(parseFloat(dr[0].amt));
      const m = Math.round(parseFloat(mr[0].amt));
      out.driver[k] = d; out.merchant[k] = m; out.total[k] = d + m;
    }

    // All-time collected (for the Overview snapshot).
    const { rows: dAll } = await query(
      `SELECT COALESCE(SUM(ABS(amount)),0) AS amt FROM driver_wallet_transactions WHERE type='commission'`);
    const { rows: mAll } = await query(
      `SELECT COALESCE(SUM(fee_paid_total),0) AS amt FROM businesses`);
    out.driver.total_all  = Math.round(parseFloat(dAll[0].amt));
    out.merchant.total_all = Math.round(parseFloat(mAll[0].amt));
    out.total.total_all   = out.driver.total_all + out.merchant.total_all;

    // Outstanding merchant fees (accrued, not yet paid) — current snapshot.
    const { rows: owed } = await query(
      `SELECT COALESCE(SUM(fee_owed),0) AS amt, COUNT(*) FILTER (WHERE fee_owed > 0)::int AS stores
       FROM businesses`);
    out.merchant.outstanding = Math.round(parseFloat(owed[0].amt));
    out.merchant.outstanding_stores = owed[0].stores;

    res.json({ success: true, ...out });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get('/analytics', async (req, res) => {
  try {
    // Overall
    const overall = await query(
      `SELECT COUNT(*)::int AS total_trips,
              COALESCE(SUM(final_fare),0) AS total_revenue,
              COALESCE(SUM(final_fare*0.15),0) AS total_commission,
              COUNT(*) FILTER (WHERE status='completed')::int AS completed,
              COUNT(*) FILTER (WHERE status='cancelled')::int AS cancelled
       FROM bookings`
    );

    // Per town (zone)
    const perTown = await query(
      `SELECT z.name AS town,
              COUNT(b.id)::int AS trips,
              COALESCE(SUM(b.final_fare),0) AS revenue
       FROM zones z
       LEFT JOIN bookings b ON b.zone_id=z.id AND b.status='completed'
       GROUP BY z.name ORDER BY revenue DESC`
    );

    // Per driver
    const perDriver = await query(
      `SELECT u.full_name AS driver_name, dp.plate_number,
              COUNT(b.id)::int AS trips,
              COALESCE(SUM(b.final_fare),0) AS revenue,
              COALESCE(SUM(b.final_fare*0.15),0) AS commission_generated,
              dp.commission_owed, dp.is_locked, dp.rating
       FROM driver_profiles dp
       JOIN users u ON u.id=dp.user_id
       LEFT JOIN bookings b ON b.driver_id=dp.user_id AND b.status='completed'
       GROUP BY u.full_name, dp.plate_number, dp.commission_owed, dp.is_locked, dp.rating
       ORDER BY revenue DESC`
    );

    // Per merchant (sales through the app + fees owed)
    const perMerchant = await query(
      `SELECT bz.name AS store_name, bz.category,
              COUNT(DISTINCT b.id)::int AS orders,
              COALESCE(SUM(oi.unit_price * oi.quantity), 0) AS gross_sales,
              COALESCE(MAX(bz.fee_owed), 0) AS fee_owed
       FROM businesses bz
       LEFT JOIN menu_items mi ON mi.business_id = bz.id
       LEFT JOIN order_items oi ON oi.product_id = mi.id
       LEFT JOIN bookings b ON b.id = oi.booking_id AND b.status = 'completed'
       GROUP BY bz.id, bz.name, bz.category
       HAVING COUNT(DISTINCT b.id) > 0
       ORDER BY gross_sales DESC`).catch((e) => {
        console.error('per-merchant analytics error:', e.message);
        return { rows: [] };
      });

    // By service type
    const perService = await query(
      `SELECT service_type,
              COUNT(*)::int AS count,
              COALESCE(SUM(final_fare),0) AS revenue
       FROM bookings WHERE status='completed'
       GROUP BY service_type ORDER BY count DESC`
    );

    res.json({
      success: true,
      overall:     overall.rows[0],
      per_town:    perTown.rows,
      per_driver:  perDriver.rows,
      per_merchant: perMerchant.rows,
      per_service: perService.rows,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /admin/transactions — full transaction log ──────────────────────────
router.get('/transactions', async (req, res) => {
  try {
    const { driver_id, limit = 100 } = req.query;
    const { rows } = await query(
      `SELECT b.id, b.service_type, b.status, b.payment_method,
              b.final_fare, b.estimated_fare, b.passenger_count,
              b.pickup_address, b.dropoff_address, b.stopover_address,
              b.stopover_charge, b.completed_at, b.created_at,
              cu.full_name AS customer_name,
              du.full_name AS driver_name, du2.plate_number,
              z.name AS town
       FROM bookings b
       JOIN users cu ON cu.id=b.customer_id
       LEFT JOIN users du ON du.id=b.driver_id
       LEFT JOIN driver_profiles du2 ON du2.user_id=b.driver_id
       LEFT JOIN zones z ON z.id=b.zone_id
       WHERE ($1::uuid IS NULL OR b.driver_id=$1::uuid)
       ORDER BY b.created_at DESC LIMIT $2`,
      [driver_id || null, parseInt(limit)]
    );
    res.json({ success: true, transactions: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /admin/user-analytics — user growth & health at a glance ────────────
router.get('/user-analytics', async (req, res) => {
  try {
    const [byRole, newCounts, repeat, active30, banned] = await Promise.all([
      query(`SELECT role, COUNT(*)::int AS n FROM users
             WHERE deleted_at IS NULL GROUP BY role`),
      query(`SELECT
               COUNT(*) FILTER (WHERE (created_at AT TIME ZONE 'Asia/Manila')::date = (NOW() AT TIME ZONE 'Asia/Manila')::date)::int AS today,
               COUNT(*) FILTER (WHERE created_at >= date_trunc('week',  NOW() AT TIME ZONE 'Asia/Manila'))::int AS week,
               COUNT(*) FILTER (WHERE created_at >= date_trunc('month', NOW() AT TIME ZONE 'Asia/Manila'))::int AS month
             FROM users WHERE deleted_at IS NULL`),
      query(`SELECT COUNT(*)::int AS n FROM (
               SELECT customer_id FROM bookings WHERE status='completed'
               GROUP BY customer_id HAVING COUNT(*) >= 2) t`),
      query(`SELECT COUNT(DISTINCT customer_id)::int AS n FROM bookings
             WHERE created_at >= NOW() - INTERVAL '30 days'`),
      query(`SELECT COUNT(*)::int AS n FROM users WHERE COALESCE(banned,FALSE)=TRUE`),
    ]);
    const roles = {};
    byRole.rows.forEach(r => { roles[r.role] = r.n; });
    res.json({ success: true,
      total_users: Object.values(roles).reduce((s, n) => s + n, 0),
      customers: roles.customer || 0, drivers: roles.driver || 0,
      merchants: roles.merchant || 0,
      new_today: newCounts.rows[0].today, new_week: newCounts.rows[0].week,
      new_month: newCounts.rows[0].month,
      repeat_customers: repeat.rows[0].n,
      active_30d: active30.rows[0].n,
      banned: banned.rows[0].n });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── GET /admin/users — searchable user list with booking counts ─────────────
router.get('/users', async (req, res) => {
  try {
    const { search = '', role } = req.query;
    const { rows } = await query(
      `SELECT u.id, u.full_name, u.mobile, u.role, u.created_at,
              COALESCE(u.banned, FALSE) AS banned, u.ban_reason, u.deleted_at,
              COALESCE(u.unpaid_cancel_fee,0) AS unpaid_cancel_fee,
              COUNT(b.id)::int AS total_bookings,
              COUNT(b.id) FILTER (WHERE b.status='completed')::int AS completed_bookings,
              COUNT(b.id) FILTER (WHERE b.status='cancelled')::int AS cancelled_bookings
       FROM users u
       LEFT JOIN bookings b ON b.customer_id = u.id
       WHERE ($1 = '' OR u.full_name ILIKE '%' || $1 || '%' OR u.mobile LIKE '%' || $1 || '%')
         AND ($2::text IS NULL OR u.role = $2)
       GROUP BY u.id
       ORDER BY u.created_at DESC
       LIMIT 100`,
      [String(search).trim(), role || null]);
    res.json({ success: true, users: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── POST /admin/users/:id/clear-cancel-fee — mark a cancellation fee settled ─
router.post('/users/:id/clear-cancel-fee', async (req, res) => {
  try {
    const { rows } = await query(
      `UPDATE users SET unpaid_cancel_fee=0 WHERE id=$1
       RETURNING full_name, COALESCE(unpaid_cancel_fee,0) AS fee`,
      [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'User not found.' });
    res.json({ success: true, message: 'Cancellation fee cleared.' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── POST /admin/users/:id/ban — suspend a user for terms violations ─────────
router.post('/users/:id/ban', async (req, res) => {
  try {
    const reason  = (req.body.reason || 'Violation of the SugoNow terms of use').trim();
    const message = (req.body.message || '').trim() || null;   // shown to the user
    const days    = parseInt(req.body.days) || 0;              // 0 = indefinite
    const until   = days > 0 ? `NOW() + INTERVAL '${days} days'` : 'NULL';
    const { rows } = await query(
      `UPDATE users SET banned=TRUE, ban_reason=$1, ban_message=$2, suspended_until=${until}
       WHERE id=$3 AND role <> 'admin'
       RETURNING full_name, mobile, role`,
      [reason, message, req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'User not found (admins cannot be banned).' });
    // If a merchant is suspended, hide their store(s) immediately (fully — not
    // just "closed" — so it drops out of customer browse, matching store-suspend).
    if (rows[0].role === 'merchant') {
      await query(`UPDATE businesses SET is_open=FALSE, hidden=TRUE, merchant_status='suspended' WHERE owner_id=$1`, [req.params.id]).catch(() => {});
    }
    const durTxt = days > 0 ? ` for ${days} day(s)` : '';
    sendSms(rows[0].mobile,
      `SugoNow: Your account has been suspended${durTxt}. Reason: ${reason}. ` +
      (message ? message + ' ' : '') +
      `If you believe this is a mistake, visit the SugoNow office in Flora.`).catch(() => {});
    res.json({ success: true, message: `${rows[0].full_name} suspended${durTxt} and notified.` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/users/:id/unban', async (req, res) => {
  try {
    const { rows } = await query(
      `UPDATE users SET banned=FALSE, ban_reason=NULL, ban_message=NULL, suspended_until=NULL WHERE id=$1
       RETURNING full_name, mobile, role`, [req.params.id]);
    if (rows[0]?.role === 'merchant') {
      await query(`UPDATE businesses SET is_open=TRUE, hidden=FALSE, merchant_status='approved' WHERE owner_id=$1`, [req.params.id]).catch(() => {});
    }
    if (!rows[0]) return res.status(404).json({ success: false, message: 'User not found.' });
    sendSms(rows[0].mobile,
      `SugoNow: Good news — your account is active again. Welcome back!`).catch(() => {});
    res.json({ success: true, message: `${rows[0].full_name} unbanned and notified.` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── POST /admin/users/:id/remove — soft-disable (records kept) ──────────────
router.post('/users/:id/remove', async (req, res) => {
  try {
    const { rows } = await query(
      `UPDATE users SET deleted_at=NOW() WHERE id=$1 AND role <> 'admin'
       RETURNING full_name`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'User not found (admins cannot be removed).' });
    res.json({ success: true, message: `${rows[0].full_name} removed (records kept).` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── GET /admin/driver-earnings — what SugoNow owes each driver ──────────────
// CASH trips owe nothing (driver holds the cash; wallet already paid our cut).
// E-WALLET trips: customer paid SugoNow, and the driver's wallet ALSO paid the
// commission + booking fee — so SugoNow owes the driver the FULL collection:
// final_fare + promo covered + LPG product cost + booking fee.
router.get('/driver-earnings', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT u.id, u.full_name, u.mobile, dp.plate_number, dp.wallet_balance,
              COUNT(b.id) FILTER (WHERE b.status='completed'
                AND b.completed_at >= NOW() - INTERVAL '7 days')::int AS trips_7d,
              COUNT(b.id) FILTER (WHERE b.status='completed'
                AND b.service_type <> 'ride'
                AND b.completed_at >= NOW() - INTERVAL '7 days')::int AS deliveries_7d,
              COALESCE(SUM(
                CASE WHEN b.status='completed'
                      AND LOWER(COALESCE(b.payment_method,'')) IN ('gcash','maya','palawan','gotyme')
                THEN COALESCE(b.final_fare,0) + COALESCE(b.promo_discount,0)
                   + COALESCE(b.lpg_product_cost,0) + COALESCE(b.booking_fee,0)
                ELSE 0 END), 0) AS ewallet_collected,
              COALESCE((SELECT SUM(p.amount) FROM admin_driver_payouts p
                        WHERE p.driver_id = u.id), 0) AS paid_out
       FROM users u
       JOIN driver_profiles dp ON dp.user_id = u.id
       LEFT JOIN bookings b ON b.driver_id = u.id
       WHERE u.role='driver' AND u.deleted_at IS NULL
       GROUP BY u.id, u.full_name, u.mobile, dp.plate_number, dp.wallet_balance
       ORDER BY (COALESCE(SUM(
                CASE WHEN b.status='completed'
                      AND LOWER(COALESCE(b.payment_method,'')) IN ('gcash','maya','palawan','gotyme')
                THEN COALESCE(b.final_fare,0) + COALESCE(b.promo_discount,0)
                   + COALESCE(b.lpg_product_cost,0) + COALESCE(b.booking_fee,0)
                ELSE 0 END), 0)
               - COALESCE((SELECT SUM(p.amount) FROM admin_driver_payouts p
                           WHERE p.driver_id = u.id), 0)) DESC, u.full_name`);
    const drivers = rows.map(r => ({ ...r,
      owed: Math.max(0, parseFloat(r.ewallet_collected) - parseFloat(r.paid_out)) }));
    res.json({ success: true, drivers,
      total_owed: drivers.reduce((s, d) => s + d.owed, 0) });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── POST /admin/driver-payouts — record a payout (GCash sent or cash given) ──
router.post('/driver-payouts', async (req, res) => {
  try {
    const { driver_id, amount, method = 'gcash', note } = req.body;
    const amt = parseFloat(amount);
    if (!driver_id || !amt || amt <= 0) {
      return res.status(400).json({ success: false, message: 'driver_id and a valid amount are required.' });
    }
    await query(
      `INSERT INTO admin_driver_payouts (driver_id, amount, method, note, recorded_by)
       VALUES ($1,$2,$3,$4,$5)`,
      [driver_id, amt, method === 'cash' ? 'cash' : 'gcash', note || null, req.user.id]);
    const { rows: u } = await query(`SELECT full_name, mobile FROM users WHERE id=$1`, [driver_id]);
    if (u[0]?.mobile) {
      sendSms(u[0].mobile,
        `SugoNow: Payout of ₱${amt.toFixed(2)} ${method === 'cash' ? 'given in cash' : 'sent to your GCash'}. ` +
        `This covers your e-wallet-paid trips. Salamat sa pagda-drive!`).catch(() => {});
    }
    res.json({ success: true, message: `₱${amt.toFixed(2)} payout recorded for ${u[0]?.full_name || 'driver'}.` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});


// ─── Weekly driver incentive (settings-driven: trips target -> ₱ reward) ────
// Month 1: ₱150 for 15 trips/week. Month 3: switch to ₱300/30 in Fares &
// Fees. ONE incentive, ONE switch — admin and drivers see the same numbers.
async function incentiveSettings() {
  // SAME keys growthService reads — admin and driver cards always agree.
  const { rows } = await query(
    `SELECT key, value FROM app_settings
     WHERE key IN ('milestone_target_trips','milestone_bonus')`);
  const m = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return {
    trips:  parseInt(m.milestone_target_trips ?? '15'),
    amount: parseFloat(m.milestone_bonus ?? '150'),
  };
}

router.get('/milestone-settings', async (req, res) => {
  try { res.json({ success: true, ...(await incentiveSettings()) }); }
  catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/milestone-settings', async (req, res) => {
  try {
    const trips = parseInt(req.body.trips), amount = parseFloat(req.body.amount);
    if (!trips || trips < 1 || !amount || amount < 0) {
      return res.status(400).json({ success: false, message: 'Enter valid trips and amount.' });
    }
    for (const [k, v] of [['milestone_target_trips', trips], ['milestone_bonus', amount],
                          ['milestone_active', 'true']]) {
      const { rowCount } = await query(`UPDATE app_settings SET value=$1 WHERE key=$2`, [String(v), k]);
      if (rowCount === 0) await query(`INSERT INTO app_settings (key, value) VALUES ($2, $1)`, [String(v), k]);
    }
    res.json({ success: true, message: `Weekly incentive set: ₱${amount} for ${trips} trips. Announce it to drivers!` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── Fare config: tiered per-km + product handling fee (admin-editable) ─────
// Tiered distance: 1st km = fare_km1, 2nd km = fare_km2, 3rd km onward = fare_kmN.
// product_fee_pct = % of product price added to delivery fee (food/water/custom).
// product_fee_cap_custom = peso cap on that % for custom errands only.
// fare_use_road_distance = use Google driving distance ('true') vs straight line.
router.get('/farecfg-settings', async (req, res) => {
  try { res.json({ success: true, ...(await getFareConfig()) }); }
  catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/farecfg-settings', async (req, res) => {
  try {
    const km1 = parseFloat(req.body.km1), km2 = parseFloat(req.body.km2), kmN = parseFloat(req.body.kmN);
    const pct = parseFloat(req.body.product_fee_pct);
    const cap = parseFloat(req.body.product_fee_cap_custom);
    const pickupPerKm = parseFloat(req.body.pickup_per_km);
    const pickupCap = parseFloat(req.body.pickup_fee_cap);
    const carBase = parseFloat(req.body.car_base_fare);
    const carPerKm = parseFloat(req.body.car_per_km);
    const useRoad = req.body.use_road_distance !== false && req.body.use_road_distance !== 'false';
    const productActive = req.body.product_fee_active !== false && req.body.product_fee_active !== 'false';
    for (const [label, v] of [['1st km', km1], ['2nd km', km2], ['succeeding km', kmN]]) {
      if (isNaN(v) || v < 0) return res.status(400).json({ success: false, message: `Enter a valid ${label} rate (₱0 or more).` });
    }
    if (isNaN(pct) || pct < 0 || pct > 100) return res.status(400).json({ success: false, message: 'Product fee % must be between 0 and 100.' });
    if (isNaN(cap) || cap < 0) return res.status(400).json({ success: false, message: 'Custom cap must be ₱0 or more.' });
    if (isNaN(pickupPerKm) || pickupPerKm < 0) return res.status(400).json({ success: false, message: 'Pickup ₱/km must be ₱0 or more.' });
    if (isNaN(pickupCap) || pickupCap < 0) return res.status(400).json({ success: false, message: 'Pickup fee cap must be ₱0 or more.' });
    if (isNaN(carBase) || carBase < 0) return res.status(400).json({ success: false, message: 'Car base fare must be ₱0 or more.' });
    if (isNaN(carPerKm) || carPerKm < 0) return res.status(400).json({ success: false, message: 'Car ₱/km must be ₱0 or more.' });
    const pairs = [
      ['fare_km1', km1], ['fare_km2', km2], ['fare_kmN', kmN],
      ['product_fee_pct', pct], ['product_fee_cap_custom', cap],
      ['product_fee_active', productActive ? 'true' : 'false'],
      ['fare_use_road_distance', useRoad ? 'true' : 'false'],
      ['pickup_per_km', pickupPerKm], ['pickup_fee_cap', pickupCap],
      ['car_base_fare', carBase], ['car_per_km', carPerKm],
    ];
    for (const [k, v] of pairs) {
      const { rowCount } = await query(`UPDATE app_settings SET value=$1 WHERE key=$2`, [String(v), k]);
      if (rowCount === 0) await query(`INSERT INTO app_settings (key, value) VALUES ($2, $1)`, [String(v), k]);
    }
    bustFareConfigCache();
    res.json({ success: true, message: `Fares updated: ₱${km1}/₱${km2}/₱${kmN} per km, product fee ${productActive ? pct + '%' : 'OFF'}${productActive ? ` (custom capped ₱${cap})` : ''}, pickup ₱${pickupPerKm}/km (up to ₱${pickupCap}).` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── Cancellation cooldown settings (admin-adjustable) ──────────────────────
router.get('/cooldown-settings', async (req, res) => {
  try { res.json({ success: true, ...(await cooldownSettings()) }); }
  catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/cooldown-settings', async (req, res) => {
  try {
    const active = req.body.active !== false && req.body.active !== 'false';
    const sc = parseInt(req.body.soft_count), sh = parseFloat(req.body.soft_hours);
    const hc = parseInt(req.body.hard_count), hh = parseFloat(req.body.hard_hours);
    if (active) {
      if (!sc || sc < 1) return res.status(400).json({ success: false, message: 'Soft count must be at least 1.' });
      if (!(sh > 0))     return res.status(400).json({ success: false, message: 'Soft pause must be greater than 0 hours.' });
      if (hc && hc <= sc) return res.status(400).json({ success: false, message: 'Hard count must be higher than soft count (or 0 to disable).' });
      if (hc && !(hh > 0)) return res.status(400).json({ success: false, message: 'Hard pause must be greater than 0 hours.' });
    }
    const pairs = [
      ['cooldown_active', active ? 'true' : 'false'],
      ['cooldown_soft_count', sc || 3], ['cooldown_soft_hours', sh || 2],
      ['cooldown_hard_count', hc || 0], ['cooldown_hard_hours', hh || 24],
    ];
    for (const [k, v] of pairs) {
      const { rowCount } = await query(`UPDATE app_settings SET value=$1 WHERE key=$2`, [String(v), k]);
      if (rowCount === 0) await query(`INSERT INTO app_settings (key, value) VALUES ($2, $1)`, [String(v), k]);
    }
    if (_bustCooldownCache) _bustCooldownCache();
    const msg = active
      ? `Cooldown on: ${sc} cancels → ${sh}h pause` + (hc ? `, ${hc} → ${hh}h pause.` : '.')
      : 'Cancellation cooldown turned OFF.';
    res.json({ success: true, message: msg });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── GET /admin/driver-bonuses — weekly trips vs target, pay on hit ─────────
router.get('/driver-bonuses', async (req, res) => {
  try {
    const cfg = await incentiveSettings();
    // Count trips from BOOKINGS — the always-present record. (driver_milestones
    // only fills while milestone_active is ON, so trips completed before the
    // switch was flipped wouldn't appear there. Bookings never have that gap.)
    // bonus_paid is tracked via driver_wallet_transactions this week.
    const { rows } = await query(
      `SELECT u.id, u.full_name, u.mobile,
              COUNT(b.id) FILTER (WHERE b.status='completed'
                AND b.completed_at >= date_trunc('week', NOW() AT TIME ZONE 'Asia/Manila'))::int AS trips_week,
              COALESCE((SELECT SUM(t.amount) FROM driver_wallet_transactions t
                 WHERE t.driver_id = u.id AND t.type = 'milestone_bonus'
                   AND t.created_at >= date_trunc('week', NOW() AT TIME ZONE 'Asia/Manila')), 0) AS paid_week
       FROM users u
       JOIN driver_profiles dp ON dp.user_id = u.id
       LEFT JOIN bookings b ON b.driver_id = u.id
       WHERE u.role='driver' AND u.deleted_at IS NULL
       GROUP BY u.id
       ORDER BY trips_week DESC`);
    const drivers = rows.map(r => ({
      ...r,
      target: cfg.trips, reward: cfg.amount,
      hit: r.trips_week >= cfg.trips,
      owed: (r.trips_week >= cfg.trips && parseFloat(r.paid_week) <= 0) ? cfg.amount : 0,
    })).filter(r => r.trips_week > 0 || parseFloat(r.paid_week) > 0);
    res.json({ success: true, ...cfg, drivers });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/driver-bonuses/:driverId/pay', async (req, res) => {
  try {
    const amt = parseFloat(req.body.amount);
    if (!amt || amt <= 0) return res.status(400).json({ success: false, message: 'Invalid amount.' });
    const method = req.body.method === 'cash' ? 'cash' : 'wallet';
    if (method === 'cash') {
      // Pay the bonus as physical cash: record it in the ledger for audit, but
      // do NOT credit the wallet (the driver is taking it in hand). This is
      // what prevents paying the same bonus twice.
      await query(
        `INSERT INTO driver_wallet_transactions (driver_id, amount, type, note)
         VALUES ($1,$2,'bonus_cash',$3)`,
        [req.params.driverId, 0, `Weekly incentive ₱${amt} paid as CASH (not added to wallet)`]);
    } else {
      await G.creditDriverWallet(req.params.driverId, amt, 'milestone_bonus',
        'Weekly trips incentive');
    }
    // Mark the driver-visible milestone card as paid for this week. Upsert,
    // because the row may not exist yet (trips counted from bookings, not
    // necessarily written to driver_milestones).
    await query(
      `INSERT INTO driver_milestones (driver_id, week_start, trips_done, bonus_paid, bonus_amount)
       VALUES ($1,$2,0,TRUE,$3)
       ON CONFLICT (driver_id, week_start)
       DO UPDATE SET bonus_paid=TRUE, bonus_amount=$3`,
      [req.params.driverId, G.weekStart(), amt]).catch((e) => console.error('milestone paid mark:', e.message));
    res.json({ success: true, message: method === 'cash'
      ? `₱${amt} incentive recorded as CASH paid. Wallet unchanged.`
      : `₱${amt} incentive credited to the driver's wallet.` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── ADMIN: adjust a driver's wallet (credit or debit) with a reason ────────
router.post('/driver-wallet/:driverId/adjust', async (req, res) => {
  try {
    const amt = parseFloat(req.body.amount);              // positive number
    const dir = req.body.direction === 'debit' ? 'debit' : 'credit';
    const reason = (req.body.reason || '').trim();
    if (!amt || amt <= 0) return res.status(400).json({ success: false, message: 'Enter an amount greater than 0.' });
    if (reason.length < 3)  return res.status(400).json({ success: false, message: 'A short reason is required (for your records).' });

    const { rows: cur } = await query(`SELECT wallet_balance FROM driver_profiles WHERE user_id=$1`, [req.params.driverId]);
    if (!cur.length) return res.status(404).json({ success: false, message: 'Driver not found.' });
    const bal = parseFloat(cur[0].wallet_balance || 0);

    if (dir === 'debit') {
      if (amt > bal) return res.status(400).json({ success: false,
        message: `Cannot debit ₱${amt} — balance is only ₱${bal.toFixed(2)}.` });
      await query(`UPDATE driver_profiles SET wallet_balance = wallet_balance - $1 WHERE user_id=$2`, [amt, req.params.driverId]);
      await query(`INSERT INTO driver_wallet_transactions (driver_id, amount, type, note) VALUES ($1,$2,'admin_debit',$3)`,
        [req.params.driverId, -amt, `Admin debit: ${reason}`]);
    } else {
      await G.creditDriverWallet(req.params.driverId, amt, 'admin_credit', `Admin credit: ${reason}`);
    }
    const { rows: nb } = await query(`SELECT wallet_balance FROM driver_profiles WHERE user_id=$1`, [req.params.driverId]);
    res.json({ success: true, balance: parseFloat(nb[0].wallet_balance),
      message: `${dir === 'debit' ? 'Debited' : 'Credited'} ₱${amt}. New balance: ₱${parseFloat(nb[0].wallet_balance).toFixed(2)}.` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── ADMIN: record a wallet cash-out (driver withdrew balance as cash) ──────
router.post('/driver-wallet/:driverId/cashout', async (req, res) => {
  try {
    const amt = parseFloat(req.body.amount);
    if (!amt || amt <= 0) return res.status(400).json({ success: false, message: 'Enter an amount greater than 0.' });
    const { rows: cur } = await query(`SELECT wallet_balance FROM driver_profiles WHERE user_id=$1`, [req.params.driverId]);
    if (!cur.length) return res.status(404).json({ success: false, message: 'Driver not found.' });
    const bal = parseFloat(cur[0].wallet_balance || 0);
    if (amt > bal) return res.status(400).json({ success: false,
      message: `Cannot cash out ₱${amt} — balance is only ₱${bal.toFixed(2)}.` });
    await query(`UPDATE driver_profiles SET wallet_balance = wallet_balance - $1 WHERE user_id=$2`, [amt, req.params.driverId]);
    await query(`INSERT INTO driver_wallet_transactions (driver_id, amount, type, note) VALUES ($1,$2,'cashout',$3)`,
      [req.params.driverId, -amt, `Cash-out: ₱${amt} paid to driver in cash`]);
    const { rows: nb } = await query(`SELECT wallet_balance FROM driver_profiles WHERE user_id=$1`, [req.params.driverId]);
    res.json({ success: true, balance: parseFloat(nb[0].wallet_balance),
      message: `Cash-out of ₱${amt} recorded. New balance: ₱${parseFloat(nb[0].wallet_balance).toFixed(2)}.` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── ADMIN: grant wallet credit to a CUSTOMER (lucky-draw prizes, goodwill) ──
// The credit spends like cash on ANY SugoNow service, including food PRODUCTS.
// The custom message is saved as the wallet-transaction note (so it lives in the
// customer's wallet history — their "inbox") AND pushed as a notification.
// Settlement is automatic: when the customer spends it, the driver collects the
// reduced cash and is reimbursed the credit into their wallet at completion.
router.post('/customer-wallet/:customerId/grant', async (req, res) => {
  try {
    const amt = parseFloat(req.body.amount);
    const message = (req.body.message || '').trim();
    if (isNaN(amt) || amt <= 0)
      return res.status(400).json({ success: false, message: 'Enter an amount greater than ₱0.' });
    const { rows: u } = await query(
      `SELECT id, full_name FROM users WHERE id=$1 AND role='customer'`, [req.params.customerId]);
    if (!u[0]) return res.status(404).json({ success: false, message: 'Customer not found.' });
    const note = message || `SugoNow credit: ₱${amt.toFixed(2)} — use on any service.`;
    await G.addWalletCredit(req.params.customerId, amt, 'admin_grant', note);
    try {
      sendPush(req.params.customerId, '🎉 You received SugoNow credit!',
        message || `You got ₱${amt.toFixed(2)} in credit — use it on any SugoNow service, kasama ang pagkain!`);
    } catch (e) { /* push is best-effort */ }
    const bal = await G.getWalletBalance(req.params.customerId);
    res.json({ success: true, new_balance: bal,
      message: `Granted ₱${amt.toFixed(2)} to ${u[0].full_name}. New balance: ₱${parseFloat(bal).toFixed(2)}.` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});


// ─── ADMIN: a driver's wallet transaction history ───────────────────────────
router.get('/driver-wallet/:driverId/history', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT amount, type, note, created_at
       FROM driver_wallet_transactions WHERE driver_id=$1
       ORDER BY created_at DESC LIMIT 50`, [req.params.driverId]);
    const { rows: b } = await query(
      `SELECT dp.wallet_balance, u.full_name FROM driver_profiles dp
       JOIN users u ON u.id = dp.user_id WHERE dp.user_id=$1`, [req.params.driverId]);
    res.json({ success: true, balance: parseFloat(b[0]?.wallet_balance || 0),
      name: b[0]?.full_name, transactions: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── ADMIN: live list of online drivers (waiting + on-trip) ─────────────────
router.get('/online-drivers', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT u.id, u.full_name AS name, u.mobile,
              dp.vehicle_type, dp.current_lat, dp.current_lng,
              dp.wallet_balance,
              EXTRACT(EPOCH FROM (NOW() - COALESCE(dp.updated_at, dp.created_at)))::int AS seconds_since_ping,
              EXISTS (
                SELECT 1 FROM bookings b
                WHERE b.driver_id = u.id
                  AND b.status IN ('accepted','arrived','in_progress','waiting')
              ) AS on_trip
       FROM driver_profiles dp
       JOIN users u ON u.id = dp.user_id
       WHERE dp.is_online = TRUE AND dp.status = 'verified'
       ORDER BY on_trip ASC, seconds_since_ping ASC`);
    res.json({ success: true, drivers: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── ADMIN: custom errand premium (extra fee because driver shops for it) ───
router.get('/errand-premium', async (req, res) => {
  try {
    const { rows } = await query(`SELECT value FROM app_settings WHERE key='custom_errand_premium'`);
    const v = rows.length && rows[0].value !== '' ? parseFloat(rows[0].value) : 15;
    res.json({ success: true, errand_premium: isNaN(v) ? 15 : v });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});
router.post('/errand-premium', async (req, res) => {
  try {
    const v = req.body.errand_premium === '' || req.body.errand_premium == null ? 15 : parseFloat(req.body.errand_premium);
    if (isNaN(v) || v < 0) return res.status(400).json({ success: false, message: 'Enter 0 or a positive amount.' });
    const { rowCount } = await query(`UPDATE app_settings SET value=$1 WHERE key='custom_errand_premium'`, [String(v)]);
    if (rowCount === 0) await query(`INSERT INTO app_settings (key, value) VALUES ('custom_errand_premium', $1)`, [String(v)]);
    res.json({ success: true, message: `Custom errand premium set to ₱${v}.` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get('/delivery-fares', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT key, value FROM app_settings
       WHERE key IN ('fare_base_food','fare_base_lpg','fare_base_water','fare_base_custom')`);
    const m = {}; for (const r of rows) m[r.key] = parseFloat(r.value);
    const z = await query(`SELECT base_fare, per_km_rate FROM zones WHERE slug='flora' LIMIT 1`);
    res.json({ success: true,
      food:   isNaN(m.fare_base_food)   ? 20 : m.fare_base_food,
      lpg:    isNaN(m.fare_base_lpg)    ? 40 : m.fare_base_lpg,
      water:  isNaN(m.fare_base_water)  ? 30 : m.fare_base_water,
      custom: isNaN(m.fare_base_custom) ? 20 : m.fare_base_custom,
      ride_base: parseFloat(z.rows[0]?.base_fare ?? 25),
      per_km:    parseFloat(z.rows[0]?.per_km_rate ?? 8) });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});
router.post('/delivery-fares', async (req, res) => {
  try {
    const map = { food: 'fare_base_food', lpg: 'fare_base_lpg', water: 'fare_base_water', custom: 'fare_base_custom' };
    for (const [field, key] of Object.entries(map)) {
      if (req.body[field] === undefined || req.body[field] === null || req.body[field] === '') continue;
      const v = parseFloat(req.body[field]);
      if (isNaN(v) || v < 0) return res.status(400).json({ success: false, message: `Enter 0 or more for ${field}.` });
      const { rowCount } = await query(`UPDATE app_settings SET value=$1 WHERE key=$2`, [String(v), key]);
      if (rowCount === 0) await query(`INSERT INTO app_settings (key, value) VALUES ($2,$1)`, [String(v), key]);
    }
    // Shared per-km rate lives on the zone.
    if (req.body.per_km !== undefined && req.body.per_km !== null && req.body.per_km !== '') {
      const pk = parseFloat(req.body.per_km);
      if (isNaN(pk) || pk < 0) return res.status(400).json({ success: false, message: 'Enter 0 or more for per_km.' });
      await query(`UPDATE zones SET per_km_rate=$1 WHERE slug='flora'`, [pk]);
    }
    res.json({ success: true, message: 'Delivery fares updated.' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});
router.get('/cancel-fee', async (req, res) => {
  try {
    const { rows } = await query(`SELECT value FROM app_settings WHERE key='custom_cancel_fee'`);
    const v = rows.length && rows[0].value !== '' ? parseFloat(rows[0].value) : 50;
    res.json({ success: true, cancel_fee: isNaN(v) ? 50 : v });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});
router.post('/cancel-fee', async (req, res) => {
  try {
    const v = req.body.cancel_fee === '' || req.body.cancel_fee == null ? 50 : parseFloat(req.body.cancel_fee);
    if (isNaN(v) || v < 0) return res.status(400).json({ success: false, message: 'Enter 0 or a positive amount.' });
    const { rowCount } = await query(`UPDATE app_settings SET value=$1 WHERE key='custom_cancel_fee'`, [String(v)]);
    if (rowCount === 0) await query(`INSERT INTO app_settings (key, value) VALUES ('custom_cancel_fee', $1)`, [String(v)]);
    res.json({ success: true, message: `Custom cancellation fee set to ₱${v}.` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── ADMIN: staleness thresholds (auto-expire bookings / auto-offline drivers)
router.get('/staleness-settings', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT key, value FROM app_settings
       WHERE key IN ('pending_expiry_min','driver_stale_min','dispatch_timeout_sec')`);
    const kv = Object.fromEntries(rows.map(r => [r.key, parseFloat(r.value)]));
    res.json({ success: true,
      pending_expiry_min: kv.pending_expiry_min != null ? kv.pending_expiry_min : 3,
      driver_stale_min:   kv.driver_stale_min   != null ? kv.driver_stale_min   : 5,
      dispatch_timeout_sec: kv.dispatch_timeout_sec != null ? kv.dispatch_timeout_sec : 30 });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/staleness-settings', async (req, res) => {
  try {
    const pe = req.body.pending_expiry_min === '' || req.body.pending_expiry_min == null
      ? 3 : parseFloat(req.body.pending_expiry_min);
    const ds = req.body.driver_stale_min === '' || req.body.driver_stale_min == null
      ? 5 : parseFloat(req.body.driver_stale_min);
    const dt = req.body.dispatch_timeout_sec === '' || req.body.dispatch_timeout_sec == null
      ? 30 : parseFloat(req.body.dispatch_timeout_sec);
    if (pe < 0 || ds < 0) return res.status(400).json({ success: false, message: 'Minutes cannot be negative (0 = off).' });
    if (!(dt > 0)) return res.status(400).json({ success: false, message: 'Dispatch timeout must be greater than 0 seconds.' });
    for (const [k, v] of [['pending_expiry_min', pe], ['driver_stale_min', ds], ['dispatch_timeout_sec', dt]]) {
      const { rowCount } = await query(`UPDATE app_settings SET value=$1 WHERE key=$2`, [String(v), k]);
      if (rowCount === 0) await query(`INSERT INTO app_settings (key, value) VALUES ($2, $1)`, [String(v), k]);
    }
    res.json({ success: true, message:
      `Riders get ${dt}s to accept; bookings give up after ${pe || 'OFF'} min; drivers auto-offline after ${ds || 'OFF'} min.` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── ADMIN: recent background errors (failure visibility) ───────────────────
router.get('/error-log', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, context, message, meta, created_at
       FROM app_error_log ORDER BY created_at DESC LIMIT 100`);
    res.json({ success: true, errors: rows });
  } catch (err) {
    // If the table doesn't exist yet, return empty rather than 500.
    res.json({ success: true, errors: [], note: 'error log unavailable' });
  }
});

// ─── ADMIN: clear the error log ─────────────────────────────────────────────
router.post('/error-log/clear', async (req, res) => {
  try { await query(`DELETE FROM app_error_log`); res.json({ success: true }); }
  catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;