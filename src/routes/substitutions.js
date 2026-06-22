/**
 * SugoNow — src/routes/substitutions.js
 *
 * Driver marks an ordered item unavailable at the store; the customer is
 * notified with substitute suggestions (other available products from the
 * same store) and can approve a substitute or remove the item.
 *
 * Mount in server.js:
 *   const subRoutes = require('./src/routes/substitutions');
 *   app.use('/api/v1/substitutions', subRoutes);
 */
const express = require('express');
const { query } = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');
const { sendPush } = require('../services/pushNotificationService');

const router = express.Router();
router.use(authenticate);

// ── DRIVER: mark an order item unavailable + suggest substitutes ─────────────
router.post('/unavailable', requireRole('driver'), async (req, res) => {
  try {
    const { order_item_id } = req.body;
    const { rows: item } = await query(
      `SELECT oi.*, b.customer_id, b.id AS booking_id,
              mi.business_id
       FROM order_items oi
       JOIN bookings b ON b.id = oi.booking_id
       LEFT JOIN menu_items mi ON mi.id = oi.product_id
       WHERE oi.id=$1`, [order_item_id]
    );
    if (!item[0]) return res.status(404).json({ success: false, message: 'Item not found.' });

    await query(`UPDATE order_items SET status='unavailable' WHERE id=$1`, [order_item_id]);

    // Suggest up to 4 available substitutes from the same store, similar price
    let suggestions = [];
    if (item[0].business_id) {
      const { rows: subs } = await query(
        `SELECT id, name, price, emoji, photo_url
         FROM menu_items
         WHERE business_id=$1 AND available=TRUE AND id <> $2
         ORDER BY ABS(price - $3) ASC, name
         LIMIT 4`,
        [item[0].business_id, item[0].product_id, item[0].unit_price]
      );
      suggestions = subs;
    }

    // Notify the customer
    sendPush(item[0].customer_id, '⚠️ Item unavailable',
      `"${item[0].product_name}" is out of stock. Tap to choose a substitute or remove it.`,
      { type: 'substitution', bookingId: item[0].booking_id, orderItemId: order_item_id }
    ).catch(() => {});

    res.json({ success: true, suggestions,
               message: 'Customer notified with substitute options.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── CUSTOMER: see unavailable items + suggestions for a booking ──────────────
router.get('/booking/:bookingId', async (req, res) => {
  try {
    const { rows: items } = await query(
      `SELECT oi.id, oi.product_name, oi.unit_price, oi.status, oi.product_id,
              mi.business_id
       FROM order_items oi
       LEFT JOIN menu_items mi ON mi.id = oi.product_id
       WHERE oi.booking_id=$1 AND oi.status='unavailable'`,
      [req.params.bookingId]
    );
    const result = [];
    for (const it of items) {
      let suggestions = [];
      if (it.business_id) {
        const { rows: subs } = await query(
          `SELECT id, name, price, emoji, photo_url FROM menu_items
           WHERE business_id=$1 AND available=TRUE AND id <> $2
           ORDER BY ABS(price - $3) ASC, name LIMIT 4`,
          [it.business_id, it.product_id, it.unit_price]
        );
        suggestions = subs;
      }
      result.push({ ...it, suggestions });
    }
    res.json({ success: true, unavailable: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── CUSTOMER: choose a substitute OR remove the item ─────────────────────────
router.post('/resolve', async (req, res) => {
  try {
    const { order_item_id, action, substitute_product_id } = req.body;
    // action: 'substitute' | 'remove'
    const { rows: orig } = await query(`SELECT * FROM order_items WHERE id=$1`, [order_item_id]);
    if (!orig[0]) return res.status(404).json({ success: false, message: 'Item not found.' });

    if (action === 'remove') {
      await query(`UPDATE order_items SET status='removed' WHERE id=$1`, [order_item_id]);
      // notify driver
      const { rows: b } = await query(`SELECT driver_id FROM bookings WHERE id=$1`, [orig[0].booking_id]);
      if (b[0]?.driver_id) {
        sendPush(b[0].driver_id, 'Customer removed an item',
          `"${orig[0].product_name}" was removed from the order.`,
          { type: 'sub_resolved', bookingId: orig[0].booking_id }).catch(() => {});
      }
      return res.json({ success: true, action: 'removed' });
    }

    if (action === 'substitute' && substitute_product_id) {
      const { rows: sp } = await query(
        `SELECT id, name, price FROM menu_items WHERE id=$1`, [substitute_product_id]);
      if (!sp[0]) return res.status(404).json({ success: false, message: 'Substitute not found.' });

      await query(`UPDATE order_items SET status='substituted' WHERE id=$1`, [order_item_id]);
      await query(
        `INSERT INTO order_items
           (booking_id, product_id, product_name, quantity, unit_price,
            options_text, status, substitute_for)
         VALUES ($1,$2,$3,$4,$5,$6,'ok',$7)`,
        [orig[0].booking_id, sp[0].id, sp[0].name, orig[0].quantity,
         parseFloat(sp[0].price), 'Substitute', order_item_id]
      );
      const { rows: b } = await query(`SELECT driver_id FROM bookings WHERE id=$1`, [orig[0].booking_id]);
      if (b[0]?.driver_id) {
        sendPush(b[0].driver_id, 'Substitute chosen',
          `Customer replaced "${orig[0].product_name}" with "${sp[0].name}".`,
          { type: 'sub_resolved', bookingId: orig[0].booking_id }).catch(() => {});
      }
      return res.json({ success: true, action: 'substituted', substitute: sp[0] });
    }

    res.status(400).json({ success: false, message: 'Invalid action.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
