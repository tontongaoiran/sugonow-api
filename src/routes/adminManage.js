/**
 * SugoNow — src/routes/adminManage.js
 *
 * Admin management actions:
 *  - Suspend / unsuspend a driver (days or indefinite) with a custom message
 *  - Remove a driver account (soft-disable or hard-delete)
 *  - Remove a business (hide or hard-delete)
 *
 * Mount: app.use('/api/v1/admin-manage', require('./src/routes/adminManage'));
 */
const express = require('express');
const { query } = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');
const M = require('../services/messageService');

const router = express.Router();
router.use(authenticate, requireRole('admin'));

// ── List drivers with status (for the management UI) ──
router.get('/drivers', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT u.id, u.full_name, u.mobile, u.deleted_at,
              dp.suspended, dp.suspended_until, dp.suspension_reason,
              dp.wallet_balance, dp.rating, dp.total_trips
       FROM users u JOIN driver_profiles dp ON dp.user_id = u.id
       WHERE u.role='driver'
       ORDER BY u.deleted_at NULLS FIRST, dp.suspended DESC, u.full_name`);
    res.json({ success: true, drivers: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── Suspend a driver ──
router.post('/drivers/:id/suspend', async (req, res) => {
  try {
    const { days, reason, message } = req.body;
    // days null/0/absent = indefinite
    let until = null;
    if (days && parseInt(days) > 0) {
      until = new Date(Date.now() + parseInt(days) * 86400000);
    }
    await query(
      `UPDATE driver_profiles
       SET suspended=TRUE, suspended_until=$1, suspension_reason=$2
       WHERE user_id=$3`,
      [until, reason || 'Policy violation', req.params.id]);
    // also set driver offline
    await query(`UPDATE driver_profiles SET is_online=FALSE WHERE user_id=$1`, [req.params.id]);

    const dur = until ? `until ${until.toLocaleDateString('en-PH')}` : 'indefinitely';
    await M.sendMessage(req.params.id, '🚫 Account Suspended',
      message || `Your SugoNow driver account has been suspended ${dur}. ` +
      `Reason: ${reason || 'policy violation'}. Please report to the SugoNow office in Flora.`,
      'suspension');
    res.json({ success: true, message: `Driver suspended ${dur}.` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── Lift a suspension ──
router.post('/drivers/:id/unsuspend', async (req, res) => {
  try {
    await query(
      `UPDATE driver_profiles
       SET suspended=FALSE, suspended_until=NULL, suspension_reason=NULL
       WHERE user_id=$1`, [req.params.id]);
    await M.sendMessage(req.params.id, '✅ Suspension Lifted',
      'Your SugoNow driver account is active again. You can go online and accept bookings.',
      'general');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── Remove a driver: soft (disable) or hard (delete) ──
router.post('/drivers/:id/remove', async (req, res) => {
  try {
    const { mode } = req.body; // 'soft' | 'hard'
    if (mode === 'hard') {
      await query(`DELETE FROM users WHERE id=$1`, [req.params.id]);
      return res.json({ success: true, message: 'Driver permanently deleted.' });
    }
    // soft: mark deleted, set offline & suspended so they can't act
    await query(`UPDATE users SET deleted_at=NOW() WHERE id=$1`, [req.params.id]);
    await query(`UPDATE driver_profiles SET is_online=FALSE, suspended=TRUE WHERE user_id=$1`,
      [req.params.id]);
    res.json({ success: true, message: 'Driver account disabled (records kept).' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── Remove a business: hide or hard-delete ──
router.post('/businesses/:id/remove', async (req, res) => {
  try {
    const { mode } = req.body; // 'hide' | 'hard'
    if (mode === 'hard') {
      // delete products first if FK doesn't cascade
      await query(`DELETE FROM menu_items WHERE business_id=$1`, [req.params.id]);
      await query(`DELETE FROM businesses WHERE id=$1`, [req.params.id]);
      return res.json({ success: true, message: 'Business and its products permanently deleted.' });
    }
    await query(`UPDATE businesses SET hidden=TRUE, deleted_at=NOW() WHERE id=$1`, [req.params.id]);
    res.json({ success: true, message: 'Business hidden from customers (records kept).' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── Restore a hidden business ──
router.post('/businesses/:id/restore', async (req, res) => {
  try {
    await query(`UPDATE businesses SET hidden=FALSE, deleted_at=NULL WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;
