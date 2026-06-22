/**
 * SugoNow — src/routes/businesses.js
 * Business listings and menu management.
 */

const express = require('express');
const { query } = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /businesses — list all active businesses in a zone
router.get('/', async (req, res) => {
  try {
    const { zone = 'flora', category } = req.query;
    const { rows } = await query(
      `SELECT b.id, b.name, b.category, b.address,
              b.lat, b.lng, b.phone, b.logo_url,
              b.is_open, b.is_featured
       FROM businesses b
       JOIN zones z ON z.id = b.zone_id
       WHERE z.slug = $1
         AND b.is_active = TRUE
         AND ($2::text IS NULL OR b.category = $2)
       ORDER BY b.is_featured DESC, b.name`,
      [zone, category || null]
    );
    res.json({ success: true, businesses: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /businesses/:id/menu
router.get('/:id/menu', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, name, description, price, emoji, is_available
       FROM menu_items
       WHERE business_id = $1 AND is_available = TRUE
       ORDER BY name`,
      [req.params.id]
    );
    res.json({ success: true, items: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /businesses — register a new business (admin approves)
router.post('/', authenticate, async (req, res) => {
  try {
    const { name, category, address, lat, lng, phone, zone = 'flora' } = req.body;
    if (!name || !category) {
      return res.status(400).json({ success: false, message: 'Name and category are required.' });
    }
    const { rows: zRows } = await query('SELECT id FROM zones WHERE slug = $1', [zone]);
    const { rows } = await query(
      `INSERT INTO businesses
         (owner_id, name, category, zone_id, address, lat, lng, phone, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,FALSE)
       RETURNING id`,
      [req.user?.id || null, name, category, zRows[0]?.id, address, lat, lng, phone]
    );
    res.status(201).json({
      success: true,
      business_id: rows[0].id,
      message: 'Business submitted for admin review.',
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Admin: activate a business
router.patch('/:id/activate', authenticate, requireRole('admin'), async (req, res) => {
  try {
    await query('UPDATE businesses SET is_active=TRUE WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
