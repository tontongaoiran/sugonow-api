/**
 * SugoNow — src/routes/admin.js (Final)
 * All admin dashboard endpoints
 */
const express = require('express');
const { query, withTransaction }    = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');
const { sendSms }                   = require('../services/smsService');
const G = require('../services/growthService');
const { sendPush } = require('../services/pushNotificationService');
const { splitFare, getCommissionRate } = require('../services/fareService');
const bcrypt = require('bcryptjs');

const router = express.Router();
router.use(authenticate, requireRole('admin'));

// ─── GET /admin/notifications — pending counts for tab badges ────────────────
// One call returns everything that needs admin attention, so the dashboard can
// show a red badge with a number on each relevant tab.
router.get('/notifications', async (req, res) => {
  try {
    const [drivers, merchants, toppick, pass, flags, helpdesk, complaints, topups] = await Promise.all([
      query(`SELECT COUNT(*)::int AS n FROM driver_profiles WHERE status='pending'`),
      query(`SELECT COUNT(*)::int AS n FROM businesses WHERE merchant_status='pending'`),
      query(`SELECT COUNT(*)::int AS n FROM merchant_feature_requests WHERE status='pending'`).catch(() => ({ rows: [{ n: 0 }] })),
      query(`SELECT COUNT(*)::int AS n FROM pass_subscriptions WHERE status='pending'`).catch(() => ({ rows: [{ n: 0 }] })),
      query(`SELECT COUNT(*)::int AS n FROM fraud_flags WHERE resolved=FALSE`).catch(() => ({ rows: [{ n: 0 }] })),
      query(`SELECT COUNT(*)::int AS n FROM app_reports WHERE status='open'`).catch(() => ({ rows: [{ n: 0 }] })),
      query(`SELECT COUNT(*)::int AS n FROM ratings WHERE is_report=TRUE AND resolved=FALSE`).catch(() => ({ rows: [{ n: 0 }] })),
      query(`SELECT COUNT(*)::int AS n FROM driver_topup_requests WHERE status='pending'`).catch(() => ({ rows: [{ n: 0 }] })),
    ]);
    res.json({
      success: true,
      driver_approvals: drivers.rows[0].n,
      merchant_apps:    merchants.rows[0].n,
      toppick_requests: toppick.rows[0].n,
      pass_payments:    pass.rows[0].n,
      reports:          flags.rows[0].n,
      helpdesk:         helpdesk.rows[0].n,
      complaints:       complaints.rows[0].n,
      topups:           topups.rows[0].n,
      issues:           flags.rows[0].n + helpdesk.rows[0].n + complaints.rows[0].n,
      total: drivers.rows[0].n + merchants.rows[0].n + toppick.rows[0].n
             + pass.rows[0].n + flags.rows[0].n + helpdesk.rows[0].n
             + complaints.rows[0].n,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /admin/dashboard ─────────────────────────────────────────────────────
router.get('/dashboard', async (req, res) => {
  try {
    const [revenue, trips, drivers, customers,
           pending, commission, emptyWallets, flags,
           onlineNow, inProgressNow, pendingNow] = await Promise.all([
      query(`SELECT COALESCE(SUM(final_fare),0) AS total FROM bookings
             WHERE status='completed' AND (completed_at AT TIME ZONE 'Asia/Manila')::date = (NOW() AT TIME ZONE 'Asia/Manila')::date`),
      query(`SELECT COUNT(*)::int AS total FROM bookings
             WHERE status='completed' AND (completed_at AT TIME ZONE 'Asia/Manila')::date = (NOW() AT TIME ZONE 'Asia/Manila')::date`),
      query(`SELECT COUNT(*)::int AS total FROM users WHERE role='driver' AND is_active=TRUE`),
      query(`SELECT COUNT(*)::int AS total FROM users WHERE role='customer' AND is_active=TRUE`),
      query(`SELECT COUNT(*)::int AS total FROM driver_profiles WHERE status='pending'`),
      // REAL commission collected today: the actual commission deducted from
      // driver wallets (type='commission' rows are negative; negate the sum).
      query(`SELECT COALESCE(-SUM(amount),0) AS total FROM driver_wallet_transactions
             WHERE type='commission' AND (created_at AT TIME ZONE 'Asia/Manila')::date = (NOW() AT TIME ZONE 'Asia/Manila')::date`),
      query(`SELECT COUNT(*)::int AS total FROM driver_profiles
             WHERE status='verified' AND COALESCE(wallet_balance,0) <= 0`),
      query(`SELECT COUNT(*)::int AS total FROM fraud_flags WHERE resolved=FALSE`),
      // ── Live ops (right now) ──
      query(`SELECT COUNT(*)::int AS total FROM driver_profiles
             WHERE status='verified' AND COALESCE(is_online,FALSE)=TRUE`),
      query(`SELECT COUNT(*)::int AS total FROM bookings
             WHERE status IN ('accepted','arrived','in_progress','waiting')`),
      query(`SELECT COUNT(*)::int AS total FROM bookings WHERE status='pending'`),
    ]);
    res.json({
      success:          true,
      today_revenue:    parseFloat(revenue.rows[0].total).toFixed(2),
      today_trips:      trips.rows[0].total,
      active_drivers:   drivers.rows[0].total,
      total_customers:  customers.rows[0].total,
      pending_drivers:  pending.rows[0].total,
      total_commission: parseFloat(commission.rows[0].total).toFixed(2),
      empty_wallet_drivers: emptyWallets.rows[0].total,
      open_flags:       flags.rows[0].total,
      // live ops
      drivers_online:   onlineNow.rows[0].total,
      bookings_active:  inProgressNow.rows[0].total,
      bookings_pending: pendingNow.rows[0].total,
    });
  } catch (err) {
    console.error('dashboard error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /admin/drivers ───────────────────────────────────────────────────────
router.get('/drivers', async (req, res) => {
  try {
    const { status } = req.query;
    const { rows } = await query(
      `SELECT u.id, u.full_name, u.mobile, u.profile_photo,
              dp.user_id, dp.plate_number, dp.plate_number AS plate_no, dp.id_type,
              dp.vehicle_type, dp.vehicle_color, dp.vehicle_model,
              COALESCE(dp.wallet_balance, 0) AS wallet_balance,
              dp.id_front_url, dp.id_back_url, dp.selfie_url,
              dp.status, dp.rating, dp.total_trips,
              dp.bond_status, dp.bond_amount,
              dp.registered_lat, dp.registered_lng, dp.registered_address,
              u.barangay, z.name AS zone_name, dp.created_at
       FROM driver_profiles dp
       JOIN users u ON u.id = dp.user_id
       LEFT JOIN zones z ON z.id = u.zone_id
       WHERE ($1::text IS NULL OR dp.status = $1)
       ORDER BY dp.created_at DESC`,
      [status || null]
    );
    res.json({ success: true, drivers: rows, total: rows.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PATCH /admin/drivers/:driverId/status ────────────────────────────────────
router.patch('/drivers/:driverId/status', async (req, res) => {
  try {
    const { status, note } = req.body;
    if (!['verified','rejected','suspended'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status.' });
    }
    const { rowCount } = await query(
      `UPDATE driver_profiles
       SET status=$1, admin_note=$2, reviewed_by=$3,
           reviewed_at=NOW(), updated_at=NOW()
       WHERE user_id=$4`,
      [status, note || null, req.user.id, req.params.driverId]
    );
    if (rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Driver not found.' });
    }
    // Keep the two systems in sync: a driver's login block lives on users.banned
    // (checked by auth). Suspending here also bans; verifying clears the ban so
    // the driver isn't locked out by a leftover flag from the Users tab.
    if (status === 'suspended') {
      await query(`UPDATE users SET banned=TRUE, ban_reason=COALESCE($2,'Suspended by admin') WHERE id=$1`,
        [req.params.driverId, note || null]).catch(() => {});
    } else if (status === 'verified') {
      await query(`UPDATE users SET banned=FALSE, ban_reason=NULL, suspended_until=NULL WHERE id=$1`,
        [req.params.driverId]).catch(() => {});
      await query(`UPDATE users SET ban_message=NULL WHERE id=$1`, [req.params.driverId]).catch(() => {});
    }
    // SMS
    const { rows } = await query(
      'SELECT mobile, full_name FROM users WHERE id=$1', [req.params.driverId]
    );
    if (rows[0]) {
      const msg = status === 'verified'
        ? `SugoNow: ${rows[0].full_name.split(' ')[0]}, your driver account is approved! Top up your wallet in the app to start receiving bookings.`
        : `SugoNow: Your driver application was not approved. ${note || 'Contact support.'}`;
      sendSms(rows[0].mobile, msg).catch(() => {});
    }
    res.json({ success: true, message: `Driver ${status} successfully.` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /admin/bookings ──────────────────────────────────────────────────────
router.get('/bookings', async (req, res) => {
  try {
    const { status, limit = 50 } = req.query;
    const { rows } = await query(
      `SELECT b.id, b.service_type, b.status, b.payment_method,
              b.estimated_fare, b.final_fare, b.pickup_address,
              b.dropoff_address, b.passenger_count, b.discount_amount,
              b.fraud_flag, b.created_at, b.completed_at, b.unlisted_store,
              COALESCE(uc.full_name, b.manual_customer_name) AS customer_name,
              ud.full_name AS driver_name,
              (SELECT bz.name FROM order_items oi
                 JOIN menu_items mi ON mi.id = oi.product_id
                 JOIN businesses bz ON bz.id = mi.business_id
                WHERE oi.booking_id = b.id AND bz.owner_id IS NOT NULL
                LIMIT 1) AS merchant_name
       FROM bookings b
       LEFT JOIN users uc ON uc.id = b.customer_id
       LEFT JOIN users ud ON ud.id = b.driver_id
       WHERE ($1::text IS NULL OR b.status = $1)
       ORDER BY b.created_at DESC LIMIT $2`,
      [status || null, parseInt(limit)]
    );
    res.json({ success: true, bookings: rows, total: rows.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /admin/bookings/:id — full detail for one booking ──────────────────
// Powers the web admin's booking detail view: every booking column (fares, fees,
// notes, parcel/recipient info), the customer & driver, the merchant, and the
// itemised products with their line totals.
router.get('/bookings/:id', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT b.*,
              COALESCE(uc.full_name, b.manual_customer_name) AS customer_name, COALESCE(uc.mobile, b.manual_customer_mobile) AS customer_mobile,
              ud.full_name AS driver_name,   ud.mobile AS driver_mobile,
              (SELECT bz.name FROM order_items oi
                 JOIN menu_items mi ON mi.id = oi.product_id
                 JOIN businesses bz ON bz.id = mi.business_id
                WHERE oi.booking_id = b.id AND bz.owner_id IS NOT NULL
                LIMIT 1) AS merchant_name
         FROM bookings b
         LEFT JOIN users uc ON uc.id = b.customer_id
         LEFT JOIN users ud ON ud.id = b.driver_id
        WHERE b.id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Booking not found.' });

    const { rows: items } = await query(
      `SELECT product_name, quantity, unit_price, options_text, status
         FROM order_items WHERE booking_id = $1 ORDER BY created_at, id`, [req.params.id]);

    res.json({ success: true, booking: rows[0], items });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /admin/manual-booking-options — merchants + drivers for the form ────
router.get('/manual-booking-options', async (req, res) => {
  try {
    const { rows: merchants } = await query(
      `SELECT id, name FROM businesses
        WHERE merchant_status='approved' AND COALESCE(is_active,TRUE)=TRUE
        ORDER BY name`);
    const { rows: drivers } = await query(
      `SELECT dp.user_id AS id, u.full_name AS name, dp.wallet_balance
         FROM driver_profiles dp JOIN users u ON u.id=dp.user_id
        WHERE dp.status='verified' ORDER BY u.full_name`);
    res.json({ success: true, merchants, drivers });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── POST /admin/manual-booking — log a completed Facebook/off-app order ──────
// Reuses the SAME money logic as a real completion: deducts the driver's delivery
// commission from their wallet, adds a merchant fee to the merchant's collectible
// (listed merchants only, flat OR percent), counts the trip toward the milestone,
// and notifies the driver. Pass confirm=false first to PREVIEW the money moves.
router.post('/manual-booking', async (req, res) => {
  try {
    const {
      customer_name, customer_mobile, service_type = 'delivery',
      merchant_id = null, driver_id, product_value = 0, delivery_fee = 0,
      dropoff_address = null, payment_method = 'cash',
      merchant_fee_type = 'percent', merchant_fee_value = 0, confirm = false,
    } = req.body;

    if (!driver_id) return res.status(400).json({ success: false, message: 'Choose the driver.' });
    if (!customer_name || !customer_mobile)
      return res.status(400).json({ success: false, message: 'Enter the customer name and mobile.' });
    const delFee  = parseFloat(delivery_fee)  || 0;
    const prodVal = parseFloat(product_value) || 0;
    if (delFee <= 0) return res.status(400).json({ success: false, message: 'Enter a delivery fee greater than 0.' });

    // Driver commission on the delivery fee (SAME split as a real completion).
    const commRate = (await getCommissionRate()) / 100;
    const commission = Math.round(splitFare(delFee, commRate).commission_amount * 100) / 100;

    // Booking fee — SugoNow's per-order charge (customizable via the booking_fee setting,
    // default ₱5). The customer pays it; SugoNow collects it from the driver's wallet, the
    // same as a real booking. Kept in its own column so it never inflates the driver's net.
    const { rows: bfRows } = await query(
      `SELECT COALESCE(NULLIF(value,'')::numeric, 5) AS fee FROM app_settings WHERE key='booking_fee' LIMIT 1`);
    const bookingFee = bfRows.length ? parseFloat(bfRows[0].fee) : 5;

    // Merchant fee (LISTED merchants only): flat peso OR percent of product value.
    let merchantFee = 0, merchantName = null;
    if (merchant_id) {
      const feeVal = parseFloat(merchant_fee_value) || 0;
      merchantFee = merchant_fee_type === 'flat'
        ? feeVal
        : Math.round((prodVal * feeVal / 100) * 100) / 100;
      const { rows: mr } = await query(`SELECT name FROM businesses WHERE id=$1`, [merchant_id]);
      merchantName = mr[0]?.name || null;
    }

    const { rows: drv } = await query(
      `SELECT u.full_name, dp.wallet_balance
         FROM driver_profiles dp JOIN users u ON u.id=dp.user_id WHERE dp.user_id=$1`, [driver_id]);
    if (!drv[0]) return res.status(404).json({ success: false, message: 'Driver not found.' });
    const driverName = drv[0].full_name;
    const walletAfter = Math.round((parseFloat(drv[0].wallet_balance || 0) - commission - bookingFee) * 100) / 100;

    // PREVIEW — show the money moves, commit nothing.
    if (!confirm) {
      return res.json({
        success: true, preview: true,
        driver_name: driverName, commission, booking_fee: bookingFee, wallet_after: walletAfter,
        merchant_name: merchantName, merchant_fee: merchantFee,
        wallet_goes_negative: walletAfter < 0,
      });
    }

    // COMMIT — create the completed booking, then move the money.
    // Provide a zone and a pickup coord (town origin) so no NOT-NULL column blocks it.
    const finalFare = delFee + prodVal;
    const { rows: zr } = await query(
      `SELECT id FROM zones ORDER BY (slug='flora') DESC NULLS LAST LIMIT 1`);
    const zoneId = zr[0]?.id || null;
    const { rows: origin } = await query(
      `SELECT
         (SELECT NULLIF(value,'')::numeric FROM app_settings WHERE key='delivery_origin_lat' LIMIT 1) AS lat,
         (SELECT NULLIF(value,'')::numeric FROM app_settings WHERE key='delivery_origin_lng' LIMIT 1) AS lng`);
    const oLat = origin[0]?.lat ?? 18.2333;
    const oLng = origin[0]?.lng ?? 121.4200;
    const { rows: bk } = await query(
      `INSERT INTO bookings
         (customer_id, zone_id, driver_id, service_type, status,
          pickup_lat, pickup_lng, pickup_address,
          dropoff_address, final_fare, estimated_fare,
          delivery_fee, booking_fee, payment_method, source,
          manual_customer_name, manual_customer_mobile, created_at, completed_at)
       VALUES (NULL,$1,$2,$3,'completed',$4,$5,'Facebook order',$6,$7,$7,$8,$9,$10,'facebook',$11,$12,NOW(),NOW())
       RETURNING id`,
      [zoneId, driver_id, service_type, oLat, oLng, dropoff_address, finalFare,
       delFee, bookingFee, payment_method, customer_name, customer_mobile]);
    const bookingId = bk[0].id;

    if (commission > 0) await G.deductCommission(driver_id, commission, bookingId);
    // Collect the booking fee from the driver's wallet — its own transaction TYPE so it
    // is never counted as commission in the driver net-earnings calc.
    if (bookingFee > 0) {
      await query(`UPDATE driver_profiles SET wallet_balance = wallet_balance - $1 WHERE user_id=$2`,
        [bookingFee, driver_id]);
      await query(
        `INSERT INTO driver_wallet_transactions (driver_id, amount, type, booking_id, note)
         VALUES ($1,$2,'booking_fee',$3,'Booking fee on Facebook order')`,
        [driver_id, -bookingFee, bookingId]);
    }
    if (merchant_id && merchantFee > 0)
      await query(`UPDATE businesses SET fee_owed = COALESCE(fee_owed,0) + $1 WHERE id=$2`,
        [merchantFee, merchant_id]);
    await query(`UPDATE driver_profiles SET total_trips = total_trips + 1 WHERE user_id=$1`, [driver_id]);
    try { await G.bumpMilestone(driver_id); } catch (e) { /* milestone table sync is non-critical */ }

    sendPush(driver_id, '✅ A trip was logged for you',
      `SugoNow recorded a completed order for you (Facebook). +1 trip toward your weekly incentive!`,
      { type: 'manual_trip' }).catch(() => {});

    res.json({
      success: true, booking_id: bookingId,
      commission, booking_fee: bookingFee, merchant_fee: merchantFee, merchant_name: merchantName, driver_name: driverName,
    });
  } catch (err) {
    console.error('manual-booking error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /admin/driver-cancellations — monitor driver cancels ────────────────
// Recent list + reason breakdown (30d) + per-driver cancel RATE (cancels / trips
// taken), flagged over the tunable cancel_flag_pct threshold.
router.get('/driver-cancellations', async (req, res) => {
  try {
    const { rows: tr } = await query(
      `SELECT COALESCE(NULLIF(value,'')::numeric, 20) AS pct
         FROM app_settings WHERE key='cancel_flag_pct' LIMIT 1`);
    const flagPct = parseFloat(tr[0]?.pct ?? 20);

    const { rows: list } = await query(
      `SELECT dc.id, dc.reason, dc.outcome, dc.note, dc.created_at,
              u.full_name AS driver_name, b.service_type
         FROM driver_cancellations dc
         LEFT JOIN users u ON u.id = dc.driver_id
         LEFT JOIN bookings b ON b.id = dc.booking_id
        ORDER BY dc.created_at DESC LIMIT 100`);

    const { rows: reasons } = await query(
      `SELECT reason, COUNT(*)::int AS n
         FROM driver_cancellations
        WHERE created_at >= NOW() - INTERVAL '30 days'
        GROUP BY reason ORDER BY n DESC`);

    // Rate = cancels / (cancels + completed) per driver. Completed bookings keep
    // their driver_id; cancels are logged — so this is a reliable "of the trips this
    // driver took, what % did they cancel" figure.
    const { rows: rates } = await query(
      `SELECT u.full_name AS driver_name, cc.cancels,
              COALESCE(cp.completed,0)::int AS completed,
              ROUND(100.0 * cc.cancels / NULLIF(cc.cancels + COALESCE(cp.completed,0), 0), 1) AS rate
         FROM (SELECT driver_id, COUNT(*)::int AS cancels FROM driver_cancellations GROUP BY driver_id) cc
         JOIN users u ON u.id = cc.driver_id
         LEFT JOIN (SELECT driver_id, COUNT(*)::int AS completed
                      FROM bookings WHERE status='completed' AND driver_id IS NOT NULL
                     GROUP BY driver_id) cp ON cp.driver_id = cc.driver_id
        ORDER BY rate DESC NULLS LAST`);

    res.json({ success: true, flag_pct: flagPct, list, reasons, rates });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── GET /admin/missed-bookings — cancelled bookings, with a reason ──────────
// Powers the web admin "Missed / no-driver" subtab. Classifies each cancelled
// booking: cancelled after a driver accepted, no driver ever found (dispatch
// exhausted), or cancelled before dispatch.
router.get('/missed-bookings', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT b.id, b.service_type, b.status, b.estimated_fare, b.final_fare,
              b.created_at, b.driver_id,
              COALESCE(uc.full_name, b.manual_customer_name) AS customer_name, COALESCE(uc.mobile, b.manual_customer_mobile) AS customer_mobile,
              CASE
                WHEN b.driver_id IS NOT NULL THEN 'cancelled_after_assign'
                WHEN COALESCE(b.dispatch_exhausted, FALSE) THEN 'no_driver'
                ELSE 'cancelled_before_dispatch'
              END AS miss_reason
       FROM bookings b
       LEFT JOIN users uc ON uc.id = b.customer_id
       WHERE b.status = 'cancelled'
       ORDER BY b.created_at DESC
       LIMIT 100`);
    const no_driver_count = rows.filter(r => r.miss_reason === 'no_driver').length;
    res.json({ success: true, bookings: rows, no_driver_count });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /admin/bonds — DEPRECATED: now returns wallet info ──────────────────
// The bond model was replaced by the pre-paid wallet. This endpoint is kept for
// backward compatibility but now reports each driver's wallet balance instead.
router.get('/bonds', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT u.id, u.full_name, u.mobile,
              dp.wallet_balance,
              dp.plate_number, dp.status AS driver_status,
              (COALESCE(dp.wallet_balance,0) > 0) AS can_receive_bookings
       FROM driver_profiles dp
       JOIN users u ON u.id = dp.user_id
       WHERE u.role='driver'
       ORDER BY dp.wallet_balance ASC, u.full_name ASC`
    );
    res.json({ success: true, drivers: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /admin/bonds/:driverId/activate — DEPRECATED ───────────────────────
// The ₱500 bond was replaced by the pre-paid wallet. A driver goes live by
// topping up their wallet (see the driver wallet endpoints), not by paying a
// bond. This endpoint now just confirms the driver is verified and points the
// admin to the wallet top-up flow.
router.post('/bonds/:driverId/activate', async (req, res) => {
  try {
    return res.status(410).json({
      success: false,
      message: 'The bond system has been replaced by the pre-paid wallet. ' +
               'To let this driver receive bookings, approve a wallet top-up ' +
               'under the driver wallet section instead.',
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /admin/fraud-flags ───────────────────────────────────────────────────
router.get('/fraud-flags', async (req, res) => {
  try {
    const { resolved = 'false' } = req.query;
    const { rows } = await query(
      `SELECT ff.id, ff.flag_type, ff.severity, ff.details,
              ff.resolved, ff.created_at,
              u.full_name AS driver_name, u.mobile AS driver_mobile
       FROM fraud_flags ff
       LEFT JOIN users u ON u.id = ff.driver_id
       WHERE ff.resolved=$1
       ORDER BY CASE ff.severity
         WHEN 'critical' THEN 1 WHEN 'high' THEN 2
         WHEN 'medium' THEN 3 ELSE 4 END,
         ff.created_at DESC LIMIT 100`,
      [resolved === 'true']
    );
    res.json({ success: true, flags: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PATCH /admin/fraud-flags/:id/resolve ─────────────────────────────────────
router.patch('/fraud-flags/:id/resolve', async (req, res) => {
  try {
    const { action, note } = req.body;
    await query('UPDATE fraud_flags SET resolved=TRUE WHERE id=$1', [req.params.id]);
    if (action === 'suspended') {
      const { rows } = await query(
        'SELECT driver_id FROM fraud_flags WHERE id=$1', [req.params.id]
      );
      if (rows[0]?.driver_id) {
        await query(
          `UPDATE driver_profiles SET status='suspended', is_online=FALSE WHERE user_id=$1`,
          [rows[0].driver_id]
        );
      }
    }
    res.json({ success: true, message: `Flag resolved with action: ${action}` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Commission rate (the 0% -> 10% -> 15% ladder switch) ────────────────────
router.get('/commission-rate', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT value FROM app_settings WHERE key='commission_rate'`);
    res.json({ success: true, rate: parseFloat(rows[0]?.value ?? 15) });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/commission-rate', async (req, res) => {
  try {
    const rate = parseFloat(req.body.rate);
    if (isNaN(rate) || rate < 0 || rate > 30) {
      return res.status(400).json({ success: false, message: 'Rate must be between 0 and 30 (%).' });
    }
    const { rowCount } = await query(
      `UPDATE app_settings SET value=$1 WHERE key='commission_rate'`, [String(rate)]);
    if (rowCount === 0) {
      await query(
        `INSERT INTO app_settings (key, value) VALUES ('commission_rate', $1)`, [String(rate)]);
    }
    res.json({ success: true, rate,
      message: `Commission set to ${rate}%. Applies to fares within 30 seconds — no restart.` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── GET /admin/zones ─────────────────────────────────────────────────────────
router.get('/zones', async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT * FROM zones ORDER BY is_active DESC, name'
    );
    res.json({ success: true, zones: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PATCH /admin/zones/:slug ─────────────────────────────────────────────────
router.patch('/zones/:slug', async (req, res) => {
  try {
    const { base_fare, per_km_rate, is_active } = req.body;
    await query(
      `UPDATE zones
       SET base_fare = COALESCE($1, base_fare),
           per_km_rate = COALESCE($2, per_km_rate),
           is_active = COALESCE($3, is_active)
       WHERE slug=$4`,
      [base_fare, per_km_rate, is_active, req.params.slug]
    );
    res.json({ success: true, message: `Zone ${req.params.slug} updated.` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Merchant remove (soft-delete) / reactivate ─────────────────────────────
// Soft-delete keeps order history intact and hides the store everywhere on the
// customer side (stores.js filters on is_active + hidden). Reversible.
router.patch('/merchants/:id/deactivate', async (req, res) => {
  try {
    await query(`UPDATE businesses SET is_active=FALSE, hidden=TRUE WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});
router.patch('/merchants/:id/reactivate', async (req, res) => {
  try {
    await query(`UPDATE businesses SET is_active=TRUE, hidden=FALSE WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── Customers: list (recent first), detail, reset password ─────────────────
router.get('/customers', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const params = [];
    let where = `role='customer'`;
    if (q) { params.push('%' + q + '%'); where += ` AND (full_name ILIKE $1 OR mobile ILIKE $1)`; }
    const { rows } = await query(
      `SELECT id, full_name, mobile, created_at, is_active
         FROM users WHERE ${where}
        ORDER BY created_at DESC NULLS LAST LIMIT 300`, params);
    res.json({ success: true, customers: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});
router.get('/customers/:id', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, full_name, mobile, email, created_at, is_active,
              wallet_balance, referral_code, referred_by
         FROM users WHERE id=$1 AND role='customer'`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Customer not found.' });
    const { rows: bk } = await query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status='completed')::int AS completed,
              COUNT(*) FILTER (WHERE status='cancelled')::int AS cancelled
         FROM bookings WHERE customer_id=$1`, [req.params.id]);
    const { rows: recent } = await query(
      `SELECT service_type, status, final_fare, created_at
         FROM bookings WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 5`, [req.params.id]);
    res.json({ success: true, customer: rows[0], bookings: bk[0], recent });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});
router.post('/customers/:id/reset-password', async (req, res) => {
  try {
    const { rows } = await query(`SELECT id FROM users WHERE id=$1 AND role='customer'`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Customer not found.' });
    const temp = 'Sugo' + Math.floor(1000 + Math.random() * 9000);   // readable temp password
    const hash = await bcrypt.hash(temp, 12);
    await query(`UPDATE users SET password_hash=$1 WHERE id=$2`, [hash, req.params.id]);
    res.json({ success: true, temp_password: temp });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── POST /admin/merchants/:id/reset-password — reset the merchant OWNER's login ──
// :id is the business id; we reset the password of its owner_id user.
router.post('/merchants/:id/reset-password', async (req, res) => {
  try {
    const { rows } = await query(`SELECT owner_id, name FROM businesses WHERE id=$1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Merchant not found.' });
    if (!rows[0].owner_id) return res.status(400).json({ success: false, message: 'This store has no linked owner account to reset.' });
    const temp = 'Sugo' + Math.floor(1000 + Math.random() * 9000);
    const hash = await bcrypt.hash(temp, 12);
    await query(`UPDATE users SET password_hash=$1 WHERE id=$2`, [hash, rows[0].owner_id]);
    res.json({ success: true, temp_password: temp, merchant_name: rows[0].name });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── POST /admin/drivers/:id/reset-password — reset a driver's login ─────────
// :id is the driver's user id (user_id in driver_profiles).
router.post('/drivers/:id/reset-password', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT u.id, u.full_name FROM users u
        WHERE u.id=$1 AND (u.role='driver' OR EXISTS (SELECT 1 FROM driver_profiles dp WHERE dp.user_id=u.id))`,
      [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Driver not found.' });
    const temp = 'Sugo' + Math.floor(1000 + Math.random() * 9000);
    const hash = await bcrypt.hash(temp, 12);
    await query(`UPDATE users SET password_hash=$1 WHERE id=$2`, [hash, req.params.id]);
    res.json({ success: true, temp_password: temp, driver_name: rows[0].full_name });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── GET /admin/today-summary — live "today" pulse (rides the overview poll) ──
router.get('/today-summary', async (req, res) => {
  try {
    const day = `(NOW() AT TIME ZONE 'Asia/Manila')::date`;
    const { rows } = await query(
      `SELECT
         (SELECT COUNT(*)::int FROM bookings WHERE status='completed' AND completed_at::date = ${day}) AS completed_trips,
         (SELECT COALESCE(SUM(final_fare),0) FROM bookings WHERE status='completed' AND completed_at::date = ${day}) AS gmv,
         (SELECT COUNT(*)::int FROM bookings WHERE status='pending') AS pending,
         (SELECT COUNT(*)::int FROM bookings WHERE status IN ('accepted','arrived','in_progress','waiting')) AS in_progress,
         (SELECT COUNT(*)::int FROM users WHERE role='customer' AND created_at::date = ${day}) AS new_customers`);
    res.json({ success: true, today: rows[0] });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── GET /admin/driver-earnings — per-driver monitoring ─────────────────────
// net = fee-only earnings (food/delivery strip the product cost the driver merely
// fronted) MINUS the commission actually charged. "handled" is the full money that
// passed through the driver's hands (includes product cost). Optional ?driver_id.
router.get('/driver-earnings', async (req, res) => {
  try {
    const feeExpr = `
      (CASE WHEN b.service_type IN ('food','delivery')
         THEN GREATEST(0, b.final_fare - COALESCE((
                SELECT SUM(oi.unit_price * oi.quantity) FROM order_items oi
                 WHERE oi.booking_id = b.id AND (oi.status='ok' OR oi.status IS NULL)),0))
         ELSE b.final_fare END)`;
    const { rows } = await query(
      `SELECT u.full_name AS driver_name, dp.user_id AS driver_id,
              (SELECT COUNT(*)::int FROM bookings b WHERE b.driver_id=dp.user_id AND b.status='completed') AS trips,
              (SELECT COALESCE(SUM(b.final_fare),0) FROM bookings b WHERE b.driver_id=dp.user_id AND b.status='completed') AS handled,
              (SELECT COALESCE(SUM(${feeExpr}),0) FROM bookings b WHERE b.driver_id=dp.user_id AND b.status='completed') AS fee,
              (SELECT COALESCE(SUM(dwt.amount),0) FROM driver_wallet_transactions dwt
                 WHERE dwt.driver_id=dp.user_id AND dwt.type='commission') AS commission
         FROM driver_profiles dp JOIN users u ON u.id=dp.user_id
        ORDER BY trips DESC`);
    const drivers = rows.map(r => {
      const fee = parseFloat(r.fee) || 0, commission = parseFloat(r.commission) || 0;
      return {
        driver_id: r.driver_id, driver_name: r.driver_name, trips: r.trips,
        handled: Math.round(parseFloat(r.handled) || 0),
        net: Math.round(fee + commission),   // commission is negative
      };
    });
    res.json({ success: true, drivers });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;
