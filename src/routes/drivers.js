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
    const vehQuery = `SELECT v.id, v.vehicle_class, v.plate_number, v.model, v.color, v.verified,
              (v.id = dp.active_vehicle_id) AS is_active
         FROM driver_vehicles v
         JOIN driver_profiles dp ON dp.user_id = v.driver_id
        WHERE v.driver_id = $1
        ORDER BY is_active DESC, v.created_at ASC`;
    let { rows } = await query(vehQuery, [req.user.id]);
    // Auto-heal: a driver who registered before the vehicles table (or whose
    // registration only filled driver_profiles) has no vehicle row yet. Create
    // their first vehicle from their registration details and make it active.
    if (rows.length === 0) {
      const { rows: dp } = await query(
        `SELECT vehicle_type, plate_number, vehicle_model, vehicle_color
           FROM driver_profiles WHERE user_id = $1`, [req.user.id]);
      if (dp[0]) {
        const raw = String(dp[0].vehicle_type || '').trim().toLowerCase();
        const cls = VALID_CLASSES.includes(raw) ? raw : 'tricycle';
        const { rows: nv } = await query(
          `INSERT INTO driver_vehicles (driver_id, vehicle_class, plate_number, model, color, verified)
           VALUES ($1,$2,$3,$4,$5,TRUE) RETURNING id`,
          [req.user.id, cls, dp[0].plate_number || null, dp[0].vehicle_model || null, dp[0].vehicle_color || null]);
        await query(
          `UPDATE driver_profiles SET active_vehicle_id = $1
            WHERE user_id = $2 AND active_vehicle_id IS NULL`, [nv[0].id, req.user.id]);
        ({ rows } = await query(vehQuery, [req.user.id]));
      }
    }
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
      `SELECT vehicle_class, plate_number, verified FROM driver_vehicles
        WHERE id=$1 AND driver_id=$2`, [req.params.id, req.user.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Vehicle not found.' });
    if (rows[0].verified === false)
      return res.status(400).json({ success: false, message: 'This vehicle is awaiting admin approval and cannot be set active yet.' });
    await query(
      `UPDATE driver_profiles
          SET active_vehicle_id=$1, vehicle_type=$2, plate_number=COALESCE($3, plate_number)
        WHERE user_id=$4`,
      [req.params.id, rows[0].vehicle_class, rows[0].plate_number, req.user.id]);
    res.json({ success: true, message: `Now driving your ${rows[0].vehicle_class}.`, vehicle_class: rows[0].vehicle_class });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// PATCH /drivers/vehicles/:id — edit a vehicle. Plate/model/color update instantly.
// A vehicle-TYPE change needs admin re-approval before it affects dispatch: the new
// type is recorded but the vehicle is marked UNVERIFIED, and the dispatch mirror
// (driver_profiles.vehicle_type) is left on the old type until an admin approves.
router.patch('/vehicles/:id', authenticate, requireRole('driver'), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT vehicle_class FROM driver_vehicles WHERE id=$1 AND driver_id=$2`,
      [req.params.id, req.user.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Vehicle not found.' });
    const curClass = rows[0].vehicle_class;
    const newClass = req.body.vehicle_class ? String(req.body.vehicle_class).trim().toLowerCase() : null;
    const plate = (req.body.plate_number || '').trim() || null;
    const model = (req.body.model || '').trim() || null;
    const color = (req.body.color || '').trim() || null;
    await query(
      `UPDATE driver_vehicles SET plate_number=COALESCE($1,plate_number), model=$2, color=$3
        WHERE id=$4 AND driver_id=$5`,
      [plate, model, color, req.params.id, req.user.id]);
    const typeChanged = newClass && VALID_CLASSES.includes(newClass) && newClass !== curClass;
    if (typeChanged) {
      await query(
        `UPDATE driver_vehicles SET vehicle_class=$1, verified=FALSE WHERE id=$2 AND driver_id=$3`,
        [newClass, req.params.id, req.user.id]);
      return res.json({ success: true, pending: true,
        message: `Vehicle details saved. Your TYPE change to ${newClass} was submitted for admin approval and takes effect for bookings once approved.` });
    }
    res.json({ success: true, message: 'Vehicle updated.' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// DELETE /drivers/vehicles/:id — remove a vehicle. Blocked for the ACTIVE vehicle
// (switch first) and the driver's LAST vehicle (they must keep at least one).
router.delete('/vehicles/:id', authenticate, requireRole('driver'), async (req, res) => {
  try {
    const { rows: prof } = await query(
      `SELECT active_vehicle_id FROM driver_profiles WHERE user_id=$1`, [req.user.id]);
    if (prof[0] && String(prof[0].active_vehicle_id) === String(req.params.id))
      return res.status(400).json({ success: false, message: 'You cannot remove the vehicle you are currently driving. Set another vehicle active first.' });
    const { rows: cnt } = await query(
      `SELECT COUNT(*)::int AS n FROM driver_vehicles WHERE driver_id=$1`, [req.user.id]);
    if ((cnt[0]?.n || 0) <= 1)
      return res.status(400).json({ success: false, message: 'You need at least one vehicle. Add another before removing this one.' });
    const { rowCount } = await query(
      `DELETE FROM driver_vehicles WHERE id=$1 AND driver_id=$2`, [req.params.id, req.user.id]);
    if (rowCount === 0) return res.status(404).json({ success: false, message: 'Vehicle not found.' });
    res.json({ success: true, message: 'Vehicle removed.' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /drivers/vehicles/pending — ADMIN: vehicles awaiting approval (e.g. type changes).
router.get('/vehicles/pending', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT v.id, v.vehicle_class, v.plate_number, v.model, v.color,
              u.full_name, u.mobile
         FROM driver_vehicles v JOIN users u ON u.id = v.driver_id
        WHERE v.verified = FALSE
        ORDER BY v.id DESC`);
    res.json({ success: true, vehicles: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// PATCH /drivers/vehicles/:id/verify — ADMIN approves a vehicle (after a type change).
router.patch('/vehicles/:id/verify', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT driver_id, vehicle_class FROM driver_vehicles WHERE id=$1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Vehicle not found.' });
    await query(`UPDATE driver_vehicles SET verified=TRUE WHERE id=$1`, [req.params.id]);
    // If it's the driver's ACTIVE vehicle, sync the dispatch mirror to the approved type.
    await query(
      `UPDATE driver_profiles SET vehicle_type=$1
        WHERE user_id=$2 AND active_vehicle_id=$3`,
      [rows[0].vehicle_class, rows[0].driver_id, req.params.id]);
    res.json({ success: true, message: 'Vehicle approved.' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;