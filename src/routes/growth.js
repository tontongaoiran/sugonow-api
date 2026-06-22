/**
 * SugoNow — src/routes/growth.js
 *
 * Mount in server.js:
 *   const growthRoutes = require('./src/routes/growth');
 *   app.use('/api/v1/growth', growthRoutes);
 */
const express = require('express');
const { query } = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');
const G = require('../services/growthService');

const router = express.Router();

// ════════ CUSTOMER ════════
router.use(authenticate);

// Wallet balance + recent transactions
router.get('/wallet', async (req, res) => {
  try {
    const balance = await G.getWalletBalance(req.user.id);
    const { rows } = await query(
      `SELECT amount, type, note, created_at FROM wallet_transactions
       WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30`, [req.user.id]);
    res.json({ success: true, balance, transactions: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Referral code + stats
router.get('/referral', async (req, res) => {
  try {
    const code = await G.ensureReferralCode(req.user.id);
    const { rows } = await query(
      `SELECT COUNT(*) FILTER (WHERE status='rewarded')::int AS rewarded,
              COUNT(*) FILTER (WHERE status='pending')::int  AS pending
       FROM referrals WHERE referrer_id=$1`, [req.user.id]);
    const s = await G.settings();
    res.json({ success: true, code, reward_amount: s.referral,
               rewarded: rows[0].rewarded, pending: rows[0].pending });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Apply a referral code (new user)
router.post('/referral/apply', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ success: false, message: 'Code required.' });
    const result = await G.applyReferralCode(req.user.id, code.trim().toUpperCase());
    res.json({ success: result.ok, message: result.message });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Active vouchers
router.get('/vouchers', async (req, res) => {
  try {
    // expire stale ones first
    await query(`UPDATE vouchers SET status='expired'
                 WHERE customer_id=$1 AND status='active' AND expires_at < NOW()`, [req.user.id]);
    const { rows } = await query(
      `SELECT id, type, status, expires_at, created_at FROM vouchers
       WHERE customer_id=$1 AND status='active' ORDER BY expires_at`, [req.user.id]);
    res.json({ success: true, vouchers: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ════════ ADMIN: promo settings + milestone management ════════
// Get all growth settings
router.get('/admin/settings', requireRole('admin'), async (req, res) => {
  try {
    const s = await G.settings();
    res.json({ success: true, settings: s });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Update a growth setting
router.post('/admin/settings', requireRole('admin'), async (req, res) => {
  try {
    const { key, value } = req.body;
    const allowed = ['earn_credit_amount','earn_credit_active','referral_amount','referral_active',
      'driver_wallet_min_topup','driver_wallet_active','bundle_voucher_active','bundle_voucher_hours',
      'milestone_active','milestone_target_trips','milestone_min_rating','milestone_bonus'];
    if (!allowed.includes(key)) return res.status(400).json({ success: false, message: 'Invalid setting.' });
    await query(
      `INSERT INTO app_settings (key, value) VALUES ($1,$2)
       ON CONFLICT (key) DO UPDATE SET value=$2`, [key, String(value)]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Admin: drivers who reached this week's milestone (to pay bonuses)
router.get('/admin/milestones', requireRole('admin'), async (req, res) => {
  try {
    const s = await G.settings();
    // Count trips from BOOKINGS (always present) instead of driver_milestones,
    // which only fills while the milestone system is toggled ON. This way a
    // driver who hit the target still shows even if the system was off, or the
    // row was never written. Rating gate tolerates unrated drivers (NULL/0).
    const { rows } = await query(
      `SELECT u.id AS driver_id, u.full_name, u.mobile,
              COALESCE(dp.rating, 0) AS rating,
              COUNT(b.id) FILTER (WHERE b.status='completed'
                AND b.completed_at >= date_trunc('week', NOW() AT TIME ZONE 'Asia/Manila'))::int AS trips_done,
              COALESCE((SELECT SUM(t.amount) FROM driver_wallet_transactions t
                 WHERE t.driver_id = u.id AND t.type IN ('milestone_bonus','bonus_cash')
                   AND t.created_at >= date_trunc('week', NOW() AT TIME ZONE 'Asia/Manila')), 0) AS paid_week,
              COALESCE((SELECT COUNT(*) FROM driver_wallet_transactions t
                 WHERE t.driver_id = u.id AND t.type IN ('milestone_bonus','bonus_cash')
                   AND t.created_at >= date_trunc('week', NOW() AT TIME ZONE 'Asia/Manila')), 0) AS paid_count
       FROM users u
       JOIN driver_profiles dp ON dp.user_id = u.id
       LEFT JOIN bookings b ON b.driver_id = u.id
       WHERE u.role='driver' AND u.deleted_at IS NULL
       GROUP BY u.id, u.full_name, u.mobile, dp.rating
       HAVING COUNT(b.id) FILTER (WHERE b.status='completed'
                AND b.completed_at >= date_trunc('week', NOW() AT TIME ZONE 'Asia/Manila')) >= $1
       ORDER BY trips_done DESC`,
      [s.milestoneTrips]);
    // A driver "qualifies" if they hit the trips AND meet the rating (unrated = eligible).
    const drivers = rows.map(r => {
      const meetsRating = !s.milestoneRating || parseFloat(r.rating) === 0 || parseFloat(r.rating) >= s.milestoneRating;
      const paid = parseInt(r.paid_count) > 0;
      return {
        id: r.driver_id, driver_id: r.driver_id, full_name: r.full_name, mobile: r.mobile,
        rating: parseFloat(r.rating), trips_done: r.trips_done,
        qualifies: meetsRating, bonus_paid: paid,
        below_rating: !meetsRating,
      };
    });
    res.json({ success: true, target: s.milestoneTrips, bonus: s.milestoneBonus,
               min_rating: s.milestoneRating, drivers });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Admin: mark a milestone bonus as paid
router.post('/admin/milestones/:id/pay', requireRole('admin'), async (req, res) => {
  try {
    // :id is the DRIVER id (the milestone list is keyed by driver now). Credit
    // the bonus to the driver's wallet (or record as cash) — the wallet
    // transaction is what marks it paid for the week.
    const driverId = req.params.id;
    const s = await G.settings();
    const amt = parseFloat(req.body.amount) || s.milestoneBonus;
    if (!amt || amt <= 0) return res.status(400).json({ success: false, message: 'Invalid bonus amount.' });
    // Guard against double-pay this week.
    const { rows: already } = await query(
      `SELECT 1 FROM driver_wallet_transactions
       WHERE driver_id=$1 AND type IN ('milestone_bonus','bonus_cash')
         AND created_at >= date_trunc('week', NOW() AT TIME ZONE 'Asia/Manila') LIMIT 1`, [driverId]);
    if (already[0]) return res.status(409).json({ success: false, message: 'This week\'s bonus was already paid to this driver.' });

    const method = req.body.method === 'cash' ? 'cash' : 'wallet';
    if (method === 'cash') {
      await query(
        `INSERT INTO driver_wallet_transactions (driver_id, amount, type, note)
         VALUES ($1,0,'bonus_cash',$2)`,
        [driverId, `Weekly incentive ₱${amt} paid as CASH (not added to wallet)`]);
    } else {
      await G.creditDriverWallet(driverId, amt, 'milestone_bonus', 'Weekly trips incentive');
    }
    // Mirror into driver_milestones so the driver's own card shows paid too.
    const ws = G.weekStart();
    await query(
      `INSERT INTO driver_milestones (driver_id, week_start, trips_done, bonus_paid, bonus_amount)
       VALUES ($1,$2,0,TRUE,$3)
       ON CONFLICT (driver_id, week_start)
       DO UPDATE SET bonus_paid=TRUE, paid_at=NOW(), bonus_amount=$3`,
      [driverId, ws, amt]).catch(() => {});
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;
