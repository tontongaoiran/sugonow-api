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

// ─── DRIVER VEHICLES: list / add / switch active ─────────────────────────────
// A driver can own several vehicles and switch which one is active. The active
// vehicle's class is MIRRORED into driver_profiles.vehicle_type so all existing
// dispatch/fare queries keep working unchanged.
const VALID_CLASSES = ['motorcycle', 'tricycle', 'car'];

// GET /drivers/vehicles — the driver's vehicles + which is active
router.get('/vehicles', authenticate, requireRole('driver'), async (req, res) => {
  try {
    // Auto-heal: a driver who registered before/without a vehicle row (e.g. a brand-
    // new driver) gets one created from their current vehicle_type, set active. This
    // makes their registration vehicle appear here and stay dispatchable.
    const { rows: have } = await query(
      `SELECT 1 FROM driver_vehicles WHERE driver_id=$1 LIMIT 1`, [req.user.id]);
    if (!have[0]) {
      const { rows: dp } = await query(
        `SELECT COALESCE(NULLIF(TRIM(LOWER(vehicle_type)),''),'tricycle') AS cls, plate_number
           FROM driver_profiles WHERE user_id=$1`, [req.user.id]);
      if (dp[0]) {
        const { rows: nv } = await query(
          `INSERT INTO driver_vehicles (driver_id, vehicle_class, plate_number, verified)
           VALUES ($1,$2,$3,TRUE) RETURNING id`, [req.user.id, dp[0].cls, dp[0].plate_number]);
        await query(`UPDATE driver_profiles SET active_vehicle_id=$1 WHERE user_id=$2 AND active_vehicle_id IS NULL`,
          [nv[0].id, req.user.id]);
      }
    }
    const { rows } = await query(
      `SELECT v.id, v.vehicle_class, v.plate_number, v.model, v.color, v.verified,
              (v.id = dp.active_vehicle_id) AS is_active
         FROM driver_vehicles v
         JOIN driver_profiles dp ON dp.user_id = v.driver_id
        WHERE v.driver_id = $1
        ORDER BY is_active DESC, v.created_at ASC`, [req.user.id]);
    res.json({ success: true, vehicles: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /drivers/vehicles — add a vehicle. If the driver has no active vehicle yet,
// this one becomes active.
router.post('/vehicles', authenticate, requireRole('driver'), async (req, res) => {
  try {
    const cls = String(req.body.vehicle_class || '').trim().toLowerCase();
    if (!VALID_CLASSES.includes(cls))
      return res.status(400).json({ success: false, message: 'Choose a valid vehicle type.' });
    const plate = (req.body.plate_number || '').trim() || null;
    const model = (req.body.model || '').trim() || null;
    const color = (req.body.color || '').trim() || null;
    const { rows } = await query(
      `INSERT INTO driver_vehicles (driver_id, vehicle_class, plate_number, model, color, verified)
       VALUES ($1,$2,$3,$4,$5,TRUE) RETURNING id`,
      [req.user.id, cls, plate, model, color]);
    const newId = rows[0].id;
    // If no active vehicle yet, make this one active + mirror the class.
    const { rows: dp } = await query(
      `SELECT active_vehicle_id FROM driver_profiles WHERE user_id=$1`, [req.user.id]);
    if (!dp[0] || !dp[0].active_vehicle_id) {
      await query(
        `UPDATE driver_profiles SET active_vehicle_id=$1, vehicle_type=$2, plate_number=COALESCE($3, plate_number)
         WHERE user_id=$4`, [newId, cls, plate, req.user.id]);
    }
    res.json({ success: true, id: newId, message: 'Vehicle added.' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// PATCH /drivers/vehicles/:id/activate — switch the active vehicle (instant).
router.patch('/vehicles/:id/activate', authenticate, requireRole('driver'), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT vehicle_class, plate_number FROM driver_vehicles
        WHERE id=$1 AND driver_id=$2`, [req.params.id, req.user.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Vehicle not found.' });
    await query(
      `UPDATE driver_profiles
          SET active_vehicle_id=$1, vehicle_type=$2, plate_number=COALESCE($3, plate_number)
        WHERE user_id=$4`,
      [req.params.id, rows[0].vehicle_class, rows[0].plate_number, req.user.id]);
    res.json({ success: true, message: `Now driving your ${rows[0].vehicle_class}.`, vehicle_class: rows[0].vehicle_class });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;