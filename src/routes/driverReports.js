/**
 * SugoNow — src/routes/driverReports.js
 *
 * Lets DRIVERS file dispute reports to admin (protects drivers).
 * Mount in server.js:  app.use('/api/v1/driver-reports', driverReportRoutes);
 *
 * Reuses the ratings table with is_report=TRUE, but flips the direction:
 * driver_id = reporting driver, customer_id = the customer being reported.
 */
const express = require('express');
const { query } = require('../db/pool');
const { authenticate, requireVerifiedDriver, requireRole } = require('../middleware/auth');

const router = express.Router();

// ─── POST /driver-reports — driver files a dispute ───────────────────────────
router.post('/', authenticate, requireVerifiedDriver, async (req, res) => {
  try {
    const { booking_id, report_type, comment } = req.body;
    if (!report_type) {
      return res.status(400).json({ success: false, message: 'Report type required.' });
    }

    // Get the customer from the booking
    let customerId = null;
    if (booking_id) {
      const { rows } = await query(
        'SELECT customer_id FROM bookings WHERE id=$1 AND driver_id=$2',
        [booking_id, req.user.id]
      );
      customerId = rows[0]?.customer_id || null;
    }

    await query(
      `INSERT INTO ratings
         (booking_id, customer_id, driver_id, stars, comment,
          is_report, report_type)
       VALUES ($1, $2, $3, NULL, $4, TRUE, $5)`,
      [
        booking_id || null,
        customerId,
        req.user.id,
        `[DRIVER REPORT] ${comment || ''}`.trim(),
        report_type,
      ]
    );

    res.json({ success: true, message: 'Report submitted to admin. Thank you.' });
  } catch (err) {
    console.error('driver report error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ════════ APP PROBLEM REPORTS (customers, drivers, merchants) ════════
// Hosted here because this router is already mounted — no server.js change.

// Any signed-in user: report a problem with the app
router.post('/app', authenticate, async (req, res) => {
  try {
    const { category, message, booking_id } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ success: false, message: 'Please describe the problem.' });
    }
    await query(
      `INSERT INTO app_reports (user_id, role, category, message, booking_id)
       VALUES ($1,$2,$3,$4,$5)`,
      [req.user.id, req.user.role || 'customer',
       (category || 'Other').slice(0, 50), message.trim().slice(0, 1000),
       booking_id || null]);
    res.json({ success: true,
      message: 'Thank you! Your report was sent to SugoNow. We read every one.' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Admin: open app reports
router.get('/app/admin', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const { status = 'open' } = req.query;
    const { rows } = await query(
      `SELECT r.id, r.role, r.category, r.message, r.status, r.created_at,
              u.full_name, u.mobile
       FROM app_reports r LEFT JOIN users u ON u.id = r.user_id
       WHERE r.status=$1 ORDER BY r.created_at DESC LIMIT 100`, [status]);
    res.json({ success: true, reports: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.patch('/app/admin/:id/resolve', authenticate, requireRole('admin'), async (req, res) => {
  try {
    await query(
      `UPDATE app_reports SET status='resolved', resolved_by=$1, resolved_at=NOW() WHERE id=$2`,
      [req.user.id, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;
