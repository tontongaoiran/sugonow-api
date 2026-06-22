/**
 * SugoNow — src/routes/drivers.js
 */
const express = require('express');
const { query } = require('../db/pool');
const { authenticate, requireRole, requireVerifiedDriver } = require('../middleware/auth');

const router = express.Router();

// ─── GET /drivers/nearby ──────────────────────────────────────────────────────
router.get('/nearby', authenticate, async (req, res) => {
  try {
    const { lat, lng } = req.query;
    const { rows } = await query(
      `SELECT u.id, u.full_name AS name, u.mobile,
              dp.plate_number AS plate, dp.rating,
              dp.total_trips AS trips
       FROM driver_profiles dp
       JOIN users u ON u.id = dp.user_id
       WHERE dp.is_online=TRUE AND dp.status='verified'
       ORDER BY ((dp.current_lat - $1)^2 + (dp.current_lng - $2)^2) ASC
       LIMIT 1`,
      [parseFloat(lat || 17.5423), parseFloat(lng || 121.4219)]
    );
    res.json({
      success: true,
      driver:  rows[0] ?? null,
      eta_minutes: rows[0] ? 4 : null,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PATCH /drivers/online-status ─────────────────────────────────────────────
router.patch('/online-status', authenticate, requireVerifiedDriver, async (req, res) => {
  try {
    const { is_online } = req.body;
    await query(
      'UPDATE driver_profiles SET is_online=$1 WHERE user_id=$2',
      [!!is_online, req.user.id]
    );
    res.json({ success: true, is_online });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PATCH /drivers/location ──────────────────────────────────────────────────
router.patch('/location', authenticate, async (req, res) => {
  try {
    const { lat, lng } = req.body;
    await query(
      `UPDATE driver_profiles SET current_lat=$1, current_lng=$2,
              updated_at=NOW() WHERE user_id=$3`,
      [parseFloat(lat), parseFloat(lng), req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
