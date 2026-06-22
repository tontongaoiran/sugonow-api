/**
 * SugoNow — src/routes/driverWallet.js
 *
 * Pre-paid driver wallet: balance, top-up requests, milestone progress,
 * and admin approval / manual cash top-ups.
 *
 * Mount in server.js:
 *   const driverWalletRoutes = require('./src/routes/driverWallet');
 *   app.use('/api/v1/driver-wallet', driverWalletRoutes);
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { query } = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');
const G = require('../services/growthService');

// Save a base64 GCash screenshot to /uploads/payments, return its URL.
const PROOF_DIR = path.join(process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'uploads'), 'payments');
function savePaymentProof(base64) {
  try {
    if (!base64 || !base64.startsWith('data:image')) return null;
    if (!fs.existsSync(PROOF_DIR)) fs.mkdirSync(PROOF_DIR, { recursive: true });
    const m = base64.match(/^data:image\/(\w+);base64,(.+)$/);
    let ext = 'jpg', data = base64;
    if (m) { ext = m[1] === 'jpeg' ? 'jpg' : m[1]; data = m[2]; }
    const fname = `dtopup_${Date.now()}_${Math.round(Math.random()*1e6)}.${ext}`;
    fs.writeFileSync(path.join(PROOF_DIR, fname), Buffer.from(data, 'base64'));
    return `/uploads/payments/${fname}`;
  } catch { return null; }
}

const router = express.Router();
router.use(authenticate);

// ── DRIVER: my wallet balance + recent transactions + milestone ─────────────
router.get('/me', requireRole('driver'), async (req, res) => {
  try {
    const balance = await G.getDriverWallet(req.user.id);
    const s = await G.settings();
    const { rows } = await query(
      `SELECT amount, type, note, created_at FROM driver_wallet_transactions
       WHERE driver_id=$1 ORDER BY created_at DESC LIMIT 30`, [req.user.id]);
    const { rows: pend } = await query(
      `SELECT id, amount, gcash_ref, method, status, created_at FROM driver_topup_requests
       WHERE driver_id=$1 AND status='pending' ORDER BY created_at DESC`, [req.user.id]);
    const milestone = await G.getMilestoneProgress(req.user.id);

    // Suspension status (auto-lift if the window has passed)
    const { rows: sp } = await query(
      `SELECT suspended, suspended_until, suspension_reason FROM driver_profiles WHERE user_id=$1`,
      [req.user.id]);
    let suspended = sp[0]?.suspended || false;
    let suspensionReason = sp[0]?.suspension_reason || null;
    let suspendedUntil = sp[0]?.suspended_until || null;
    if (suspended && suspendedUntil && new Date(suspendedUntil) < new Date()) {
      await query(`UPDATE driver_profiles SET suspended=FALSE, suspended_until=NULL, suspension_reason=NULL WHERE user_id=$1`, [req.user.id]);
      suspended = false; suspensionReason = null; suspendedUntil = null;
    }

    res.json({ success: true, balance, min_topup: s.driverMinTopup,
               can_accept: balance > 0 && !suspended, transactions: rows,
               pending_topups: pend, milestone,
               suspended, suspension_reason: suspensionReason, suspended_until: suspendedUntil });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── DRIVER: submit a GCash top-up request (ref # -> admin approves) ──────────
router.post('/topup/gcash', requireRole('driver'), async (req, res) => {
  try {
    const { amount, gcash_ref, method = 'gcash', proof_base64 } = req.body;
    const s = await G.settings();
    const amt = parseFloat(amount);
    if (!amt || amt < s.driverMinTopup) {
      return res.status(400).json({ success: false,
        message: `Minimum top-up is ₱${s.driverMinTopup}.` });
    }
    const pay = (method || 'gcash').toLowerCase() === 'cash' ? 'cash' : 'gcash';
    let proofUrl = null;
    if (pay === 'gcash') {
      // GCash: require a screenshot. Reference number is optional (a quick aid
      // for the admin) but no longer mandatory.
      proofUrl = savePaymentProof(proof_base64);
      if (!proofUrl) {
        return res.status(400).json({ success: false,
          message: 'Please upload a screenshot of your GCash receipt.' });
      }
    }
    const { rows } = await query(
      `INSERT INTO driver_topup_requests (driver_id, amount, method, gcash_ref, proof_url, status)
       VALUES ($1,$2,$3,$4,$5,'pending') RETURNING id`,
      [req.user.id, amt, pay, gcash_ref ? String(gcash_ref).trim() : null, proofUrl]);
    res.json({ success: true, request_id: rows[0].id,
               message: pay === 'cash'
                 ? 'Cash top-up reserved. Pay at the SugoNow office and admin will credit your wallet.'
                 : 'Top-up submitted. Admin will verify your screenshot and credit your wallet shortly.' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── ADMIN: pending top-up requests ──────────────────────────────────────────
router.get('/admin/pending', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT tr.id, tr.amount, tr.gcash_ref, tr.method, tr.proof_url, tr.created_at,
              u.full_name, u.mobile,
              -- Flag if this GCash reference was ALREADY approved before (possible
              -- reuse / fake). Admin should double-check against actual GCash.
              EXISTS (
                SELECT 1 FROM driver_topup_requests prev
                WHERE prev.gcash_ref = tr.gcash_ref AND tr.gcash_ref IS NOT NULL
                  AND prev.status = 'approved'
              ) AS ref_already_used
       FROM driver_topup_requests tr
       JOIN users u ON u.id = tr.driver_id
       WHERE tr.status='pending' ORDER BY tr.created_at`);
    res.json({ success: true, pending: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── ADMIN: approve a GCash top-up -> credits the driver wallet ──────────────
router.post('/admin/approve/:id', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM driver_topup_requests WHERE id=$1 AND status='pending'`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Request not found.' });
    const t = rows[0];

    // Guard against reusing a GCash reference that was already approved. The
    // admin can override by passing { force: true } after confirming it's a
    // genuinely separate payment.
    if (!req.body.force) {
      const { rows: dup } = await query(
        `SELECT id FROM driver_topup_requests
         WHERE gcash_ref=$1 AND status='approved' AND id<>$2 LIMIT 1`,
        [t.gcash_ref, t.id]);
      if (dup[0]) {
        return res.status(409).json({
          success: false, ref_already_used: true,
          message: `This GCash reference (${t.gcash_ref}) was already approved before. ` +
                   `Confirm it is a NEW, real payment in your GCash before approving again.`,
        });
      }
    }

    await G.creditDriverWallet(t.driver_id, parseFloat(t.amount), 'topup_gcash',
      `GCash top-up (ref ${t.gcash_ref}) approved`);
    await query(
      `UPDATE driver_topup_requests SET status='approved', approved_by=$1, resolved_at=NOW()
       WHERE id=$2`, [req.user.id, req.params.id]);
    res.json({ success: true, message: 'Top-up approved and wallet credited.' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/admin/reject/:id', requireRole('admin'), async (req, res) => {
  try {
    await query(`UPDATE driver_topup_requests SET status='rejected', approved_by=$1, resolved_at=NOW()
                 WHERE id=$2`, [req.user.id, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── ADMIN: manual CASH top-up (driver paid cash at the office) ──────────────
router.post('/admin/topup-cash', requireRole('admin'), async (req, res) => {
  try {
    const { driver_id, amount } = req.body;
    const amt = parseFloat(amount);
    if (!driver_id || !amt || amt <= 0) {
      return res.status(400).json({ success: false, message: 'driver_id and amount required.' });
    }
    await G.creditDriverWallet(driver_id, amt, 'topup_cash', 'Cash top-up at office');
    res.json({ success: true, message: `₱${amt} added to driver wallet.` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── ADMIN: list drivers + wallet balances (to find who to top up) ───────────
router.get('/admin/drivers', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT u.id AS driver_id, u.full_name, u.mobile, dp.wallet_balance, dp.rating
       FROM driver_profiles dp JOIN users u ON u.id = dp.user_id
       ORDER BY dp.wallet_balance ASC`);
    res.json({ success: true, drivers: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── DRIVER: full dashboard stats (earnings, rating, counts, bonuses) ──
router.get('/stats', requireRole('driver'), async (req, res) => {
  try {
    const stats = await G.getDriverStats(req.user.id);
    res.json({ success: true, ...stats });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;
