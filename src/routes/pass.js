/**
 * SugoNow — src/routes/pass.js
 *
 * Customer: view + buy SugoNow Pass.
 * Admin: pass stats + driver ledger (what SugoNow owes / drivers owe).
 *
 * Mount in server.js:
 *   const passRoutes = require('./src/routes/pass');
 *   app.use('/api/v1/pass', passRoutes);
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { query } = require('../db/pool');
const { saveMediaBase64 } = require('../utils/media');
const { authenticate, requireRole } = require('../middleware/auth');
const {
  getSettings, getPassStatus, purchasePass, confirmPass, getDriverLedger,
} = require('../services/passBillingService');

const router = express.Router();

// Save a base64 payment screenshot to /uploads/payments, return its URL
const PROOF_DIR = path.join(process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'uploads'), 'payments');
async function savePaymentProof(base64) {
  // Proof screenshots now persist in Postgres (no disk volume needed).
  if (!base64 || !base64.startsWith('data:image')) return null;
  return saveMediaBase64(base64);
}

// ── CUSTOMER: view pass status + price ───────────────────────────────────────
router.get('/status', authenticate, async (req, res) => {
  try {
    const settings = await getSettings();
    const status = await getPassStatus(req.user.id);
    res.json({
      success: true,
      pass_active: status.active,
      expires: status.expires,
      price: settings.passPrice,
      days: settings.passDays,
      booking_fee: settings.bookingFee,
      benefit: `Skip the ₱${settings.bookingFee} booking fee on every order for ${settings.passDays} days`,
      available: settings.passActive,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── CUSTOMER: buy pass ───────────────────────────────────────────────────────
// E-wallet payment auto-activates. Cash payment is recorded as pending; the
// customer pays at the office and an admin confirms it to activate.
router.post('/buy', authenticate, async (req, res) => {
  try {
    const { payment_method = 'cash', gcash_ref, proof_base64 } = req.body;
    const settings = await getSettings();
    if (!settings.passActive) {
      return res.status(400).json({ success: false, message: 'SugoNow Pass is not available right now.' });
    }
    // For GCash, require a reference number (screenshot optional but encouraged)
    if ((payment_method || '').toLowerCase() === 'gcash' && !(gcash_ref && String(gcash_ref).trim())) {
      return res.status(400).json({ success: false, message: 'Please enter your GCash reference number.' });
    }
    const proofUrl = await savePaymentProof(proof_base64);
    const result = await purchasePass(req.user.id, payment_method,
      gcash_ref ? String(gcash_ref).trim() : null, proofUrl);
    if (result.status === 'active') {
      return res.json({ success: true, status: 'active', expires: result.expires,
                        message: `SugoNow Pass active until ${result.expires}` });
    }
    res.json({ success: true, status: 'pending', price: result.price, message: result.message });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── ADMIN: pending cash pass payments awaiting confirmation ──────────────────
router.get('/admin/pending', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT ps.id, ps.amount, ps.payment_method, ps.gcash_ref, ps.proof_url, ps.created_at,
              u.full_name, u.mobile
       FROM pass_subscriptions ps
       JOIN users u ON u.id = ps.customer_id
       WHERE ps.status = 'pending'
       ORDER BY ps.created_at DESC`
    );
    res.json({ success: true, pending: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── ADMIN: confirm a pending cash pass payment → activates the Pass ──────────
router.post('/admin/confirm/:subId', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const result = await confirmPass(req.params.subId, req.user.id);
    res.json({ success: true, expires: result.expires,
               message: `Pass activated until ${result.expires}` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── ADMIN: pass stats ────────────────────────────────────────────────────────
router.get('/admin/stats', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const { rows: active } = await query(
      `SELECT COUNT(*)::int AS active_passes
       FROM users WHERE pass_active=TRUE AND pass_expires >= CURRENT_DATE`
    );
    const { rows: revenue } = await query(
      `SELECT COUNT(*)::int AS total_sold, COALESCE(SUM(amount),0) AS total_revenue,
              COUNT(*) FILTER (WHERE confirmed_at >= date_trunc('month', CURRENT_DATE))::int AS this_month
       FROM pass_subscriptions WHERE status='active'`
    );
    res.json({ success: true,
               active_passes: active[0].active_passes,
               total_sold: revenue[0].total_sold,
               total_revenue: parseFloat(revenue[0].total_revenue),
               this_month: revenue[0].this_month });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── ADMIN: driver ledgers (what SugoNow owes each driver, and vice versa) ────
router.get('/admin/ledger', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT u.id, u.full_name, u.mobile,
              dp.commission_owed, dp.sugonow_owes,
              (dp.sugonow_owes - dp.commission_owed) AS net_position
       FROM driver_profiles dp
       JOIN users u ON u.id = dp.user_id
       WHERE dp.sugonow_owes > 0 OR dp.commission_owed > 0
       ORDER BY dp.sugonow_owes DESC`
    );
    res.json({ success: true, drivers: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── ADMIN: one driver's ledger detail ────────────────────────────────────────
router.get('/admin/ledger/:driverId', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const entries = await getDriverLedger(req.params.driverId);
    res.json({ success: true, entries });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── ADMIN: record a payout to a driver (clears what SugoNow owes) ────────────
router.post('/admin/payout/:driverId', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const { amount } = req.body;
    const pay = parseFloat(amount);
    if (!pay || pay <= 0) return res.status(400).json({ success: false, message: 'Invalid amount.' });

    const { rows } = await query(
      `UPDATE driver_profiles
       SET sugonow_owes = GREATEST(0, sugonow_owes - $1)
       WHERE user_id = $2 RETURNING sugonow_owes`,
      [pay, req.params.driverId]
    );
    await query(
      `INSERT INTO driver_ledger (driver_id, entry_type, direction, amount, note)
       VALUES ($1,'payout','sugonow_owes_driver',$2,'Payout to driver, recorded by admin')`,
      [req.params.driverId, -pay]
    );
    res.json({ success: true, remaining: parseFloat(rows[0]?.sugonow_owes ?? 0) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── ADMIN: get current fee + pass settings (for the toggle screen) ──────────
router.get('/admin/settings', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const settings = await getSettings();
    res.json({
      success: true,
      booking_fee:        settings.bookingFee,
      booking_fee_active: settings.bookingFeeActive,
      pass_price:         settings.passPrice,
      pass_days:          settings.passDays,
      pass_active:        settings.passActive,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── ADMIN: update fee + pass settings (takes effect on the NEXT booking) ────
// Accepts any subset of: booking_fee_active, booking_fee, pass_active,
// pass_price, pass_days. Each is written to app_settings and read live, so
// changes apply immediately with no restart.
router.post('/admin/settings', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const setKV = async (key, value) => {
      await query(
        `INSERT INTO app_settings (key, value) VALUES ($1,$2)
         ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()`,
        [key, String(value)]);
    };
    const b = req.body;
    if (b.booking_fee_active != null) await setKV('booking_fee_active', b.booking_fee_active ? 'true' : 'false');
    if (b.booking_fee != null && !isNaN(parseFloat(b.booking_fee))) await setKV('booking_fee', parseFloat(b.booking_fee));
    if (b.pass_active != null) await setKV('pass_active', b.pass_active ? 'true' : 'false');
    if (b.pass_price != null && !isNaN(parseFloat(b.pass_price))) await setKV('pass_price', parseFloat(b.pass_price));
    if (b.pass_days != null && !isNaN(parseInt(b.pass_days))) await setKV('pass_days', parseInt(b.pass_days));
    res.json({ success: true, message: 'Settings saved. Takes effect on the next booking.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
