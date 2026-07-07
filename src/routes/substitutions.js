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

// Recompute a food/delivery booking's total after items change (remove/sub).
// New estimated_fare = (sum of ACTIVE order items) + the stored delivery_fee.
// Only the products portion changes; delivery fee and booking fee stay as-is.
// Returns the new amounts so callers can report them to the apps.
async function recomputeBookingTotal(bookingId) {
  // Active items = anything the driver will actually buy: status 'ok' or null.
  // Excludes removed / unavailable / substituted (the replacement row is 'ok').
  const { rows: pt } = await query(
    `SELECT COALESCE(SUM(unit_price * quantity), 0) AS products_total
     FROM order_items
     WHERE booking_id=$1 AND (status='ok' OR status IS NULL)`, [bookingId]);
  const productsTotal = parseFloat(pt[0]?.products_total || 0);

  const { rows: bk } = await query(
    `SELECT delivery_fee, booking_fee, booking_fee_waived FROM bookings WHERE id=$1`, [bookingId]);
  const deliveryFee = parseFloat(bk[0]?.delivery_fee || 0);

  // estimated_fare bundles products + delivery (booking_fee is tracked separately).
  const newFare = Math.round(productsTotal + deliveryFee);
  await query(`UPDATE bookings SET estimated_fare=$1 WHERE id=$2`, [newFare, bookingId]);

  return {
    products_total: Math.round(productsTotal),
    delivery_fee:   Math.round(deliveryFee),
    estimated_fare: newFare,
    booking_fee:    parseFloat(bk[0]?.booking_fee || 0),
    booking_fee_waived: !!bk[0]?.booking_fee_waived,
  };
}

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

    await query(`UPDATE order_items SET status='unavailable', unavailable_at=NOW() WHERE id=$1`, [order_item_id]);

    // Suggest up to 4 available substitutes from the same store, similar price
    let suggestions = [];
    if (item[0].business_id) {
      const { rows: subs } = await query(
        `SELECT id, name, price, emoji, photo_url,
                COALESCE(has_options, FALSE) AS has_options
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
          `SELECT id, name, price, emoji, photo_url,
                  COALESCE(has_options, FALSE) AS has_options
           FROM menu_items
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
    const { order_item_id, action, substitute_product_id,
            options_text: subOptionsText, unit_price: subUnitPrice } = req.body;
    // action: 'substitute' | 'remove'
    const { rows: orig } = await query(`SELECT * FROM order_items WHERE id=$1`, [order_item_id]);
    if (!orig[0]) return res.status(404).json({ success: false, message: 'Item not found.' });

    if (action === 'remove') {
      await query(`UPDATE order_items SET status='removed' WHERE id=$1`, [order_item_id]);
      // Recompute the order total so the customer pays / driver collects less.
      const totals = await recomputeBookingTotal(orig[0].booking_id);
      // notify driver (now includes the new amount to collect)
      const { rows: b } = await query(`SELECT driver_id FROM bookings WHERE id=$1`, [orig[0].booking_id]);
      if (b[0]?.driver_id) {
        sendPush(b[0].driver_id, 'Customer removed an item',
          `"${orig[0].product_name}" removed. New amount to collect: ₱${totals.estimated_fare}.`,
          { type: 'sub_resolved', bookingId: orig[0].booking_id }).catch(() => {});
      }
      return res.json({ success: true, action: 'removed', totals });
    }

    if (action === 'substitute' && substitute_product_id) {
      const { rows: sp } = await query(
        `SELECT id, name, price FROM menu_items WHERE id=$1`, [substitute_product_id]);
      if (!sp[0]) return res.status(404).json({ success: false, message: 'Substitute not found.' });

      await query(`UPDATE order_items SET status='substituted' WHERE id=$1`, [order_item_id]);
      // Use the customer's customized price + options when provided (the app sends
      // these after they pick add-ons in the options screen); else the base product.
      const finalUnit = (subUnitPrice != null && !isNaN(parseFloat(subUnitPrice)))
        ? parseFloat(subUnitPrice) : parseFloat(sp[0].price);
      const finalOpts = (subOptionsText && String(subOptionsText).trim())
        ? String(subOptionsText).trim() : 'Substitute';
      await query(
        `INSERT INTO order_items
           (booking_id, product_id, product_name, quantity, unit_price,
            options_text, status, substitute_for)
         VALUES ($1,$2,$3,$4,$5,$6,'ok',$7)`,
        [orig[0].booking_id, sp[0].id, sp[0].name, orig[0].quantity,
         finalUnit, finalOpts, order_item_id]
      );
      // Recompute the order total (substitute may cost more or less).
      const totals = await recomputeBookingTotal(orig[0].booking_id);
      const { rows: b } = await query(`SELECT driver_id FROM bookings WHERE id=$1`, [orig[0].booking_id]);
      if (b[0]?.driver_id) {
        sendPush(b[0].driver_id, 'Substitute chosen',
          `Replaced "${orig[0].product_name}" with "${sp[0].name}". New amount to collect: ₱${totals.estimated_fare}.`,
          { type: 'sub_resolved', bookingId: orig[0].booking_id }).catch(() => {});
      }
      return res.json({ success: true, action: 'substituted', substitute: sp[0], totals });
    }

    res.status(400).json({ success: false, message: 'Invalid action.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Auto-remove items left UNAVAILABLE for >3 min (customer didn't respond) ──
// If the customer picks a substitute or removes it first, the status changes and
// this skips it. Otherwise, after 3 minutes we remove it, recompute the order, and
// tell both the customer and driver (their screens then poll the new total).
async function autoResolveStaleUnavailable() {
  try {
    const { rows: stale } = await query(
      `SELECT oi.id, oi.product_name, oi.booking_id, b.driver_id, b.customer_id
         FROM order_items oi
         JOIN bookings b ON b.id = oi.booking_id
        WHERE oi.status = 'unavailable'
          AND oi.unavailable_at IS NOT NULL
          AND oi.unavailable_at < NOW() - INTERVAL '3 minutes'
          AND b.status NOT IN ('completed','cancelled')`);
    for (const it of stale) {
      await query(`UPDATE order_items SET status='removed' WHERE id=$1`, [it.id]);
      const totals = await recomputeBookingTotal(it.booking_id);
      if (it.customer_id) sendPush(it.customer_id, 'Item removed from your order',
        `"${it.product_name}" was auto-removed (no response in 3 min). New total: ₱${totals.estimated_fare}.`,
        { type: 'sub_auto_removed', bookingId: it.booking_id }).catch(() => {});
      if (it.driver_id) sendPush(it.driver_id, 'Item auto-removed',
        `"${it.product_name}" auto-removed. New amount to collect: ₱${totals.estimated_fare}.`,
        { type: 'sub_auto_removed', bookingId: it.booking_id }).catch(() => {});
    }
  } catch (e) { /* best-effort background job */ }
}
setInterval(autoResolveStaleUnavailable, 30000);   // check every 30 seconds

module.exports = router;
