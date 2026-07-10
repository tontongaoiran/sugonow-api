/**
 * SugoNow — src/routes/admin.js (Final)
 * All admin dashboard endpoints
 */
const express = require('express');
const { query, withTransaction }    = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');
const { sendSms }                   = require('../services/smsService');

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
              uc.full_name AS customer_name,
              ud.full_name AS driver_name,
              (SELECT bz.name FROM order_items oi
                 JOIN menu_items mi ON mi.id = oi.product_id
                 JOIN businesses bz ON bz.id = mi.business_id
                WHERE oi.booking_id = b.id AND bz.owner_id IS NOT NULL
                LIMIT 1) AS merchant_name
       FROM bookings b
       JOIN users uc ON uc.id = b.customer_id
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

// ─── GET /admin/missed-bookings — cancelled bookings, with a reason ──────────
// Powers the web admin "Missed / no-driver" subtab. Classifies each cancelled
// booking: cancelled after a driver accepted, no driver ever found (dispatch
// exhausted), or cancelled before dispatch.
router.get('/missed-bookings', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT b.id, b.service_type, b.status, b.estimated_fare, b.final_fare,
              b.created_at, b.driver_id,
              uc.full_name AS customer_name, uc.mobile AS customer_mobile,
              CASE
                WHEN b.driver_id IS NOT NULL THEN 'cancelled_after_assign'
                WHEN COALESCE(b.dispatch_exhausted, FALSE) THEN 'no_driver'
                ELSE 'cancelled_before_dispatch'
              END AS miss_reason
       FROM bookings b
       JOIN users uc ON uc.id = b.customer_id
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

module.exports = router;
