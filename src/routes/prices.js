/**
 * SugoNow — src/routes/prices.js
 * LPG and product price management
 */
const express = require('express');
const { query } = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();

// ─── GET /prices/admin/products ───────────────────────────────────────────────
router.get('/admin/products', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT pp.*, b.name AS business_name
       FROM product_prices pp
       JOIN businesses b ON b.id = pp.business_id
       WHERE pp.is_available=TRUE
       ORDER BY b.name, pp.product_name`
    );
    res.json({ success: true, products: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PATCH /prices/admin/products/:id ─────────────────────────────────────────
router.patch('/admin/products/:id', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const { exchange_price, no_tank_price, base_price, reason } = req.body;

    // Get current price for history
    const { rows: current } = await query(
      'SELECT * FROM product_prices WHERE id=$1', [req.params.id]
    );
    if (!current[0]) return res.status(404).json({ success: false, message: 'Product not found.' });

    // Save history
    await query(
      `INSERT INTO price_history
         (product_price_id, business_id, product_name,
          old_exchange_price, old_no_tank_price,
          new_exchange_price, new_no_tank_price,
          reason, changed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        req.params.id, current[0].business_id, current[0].product_name,
        current[0].exchange_price, current[0].no_tank_price,
        exchange_price ?? current[0].exchange_price,
        no_tank_price ?? current[0].no_tank_price,
        reason || 'Admin update', req.user.id,
      ]
    ).catch(() => {});

    // Update price
    await query(
      `UPDATE product_prices
       SET exchange_price = COALESCE($1, exchange_price),
           no_tank_price  = COALESCE($2, no_tank_price),
           base_price     = COALESCE($3, base_price),
           reason         = $4,
           updated_by     = $5,
           updated_at     = NOW()
       WHERE id=$6`,
      [exchange_price, no_tank_price, base_price, reason, req.user.id, req.params.id]
    );

    res.json({ success: true, message: 'Price updated successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
