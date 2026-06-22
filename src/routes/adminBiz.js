/**
 * SugoNow — src/routes/adminBiz.js
 *
 * Admin endpoints for:
 *  - Adding businesses + their products (subscription merchants)
 *  - Listing businesses with subscription status
 *  - Recording subscription payments (extends expiry by 1 month)
 *  - Surge pricing on/off toggle
 *  - Promo on/off + stats
 *
 * Mount in server.js:
 *   const adminBizRoutes = require('./src/routes/adminBiz');
 *   app.use('/api/v1/admin', adminBizRoutes);
 */
const express = require('express');
const { query } = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');
const { getSurge, setSurge, getPromoSettings } = require('../services/pricingExtrasService');

const router = express.Router();
router.use(authenticate, requireRole('admin'));

const SUBSCRIPTION_FEE = 300; // flat ₱300/month

// ─── GET /admin/businesses — list all with subscription status ───────────────
router.get('/businesses', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT b.id, b.name, b.category, b.address, b.lat, b.lng,
              b.is_open, b.delivery_fee, b.store_hours,
              b.subscription_status, b.subscription_expires,
              b.last_payment_date, b.last_payment_amount,
              b.merchant_status, b.owner_id,
              u.full_name AS owner_name, u.mobile AS owner_mobile,
              (b.owner_id IS NOT NULL) AS merchant_registered,
              COALESCE(b.hidden, FALSE) AS hidden,
              (b.is_featured = TRUE AND (b.featured_paid_until IS NULL OR b.featured_paid_until >= CURRENT_DATE)) AS is_featured,
              COUNT(mi.id)::int AS product_count,
              CASE
                WHEN b.subscription_expires IS NULL THEN 'never_subscribed'
                WHEN b.subscription_expires < CURRENT_DATE THEN 'expired'
                ELSE 'active'
              END AS computed_status
       FROM businesses b
       LEFT JOIN menu_items mi ON mi.business_id = b.id
       LEFT JOIN users u ON u.id = b.owner_id
       GROUP BY b.id, u.full_name, u.mobile
       ORDER BY (b.merchant_status='pending') DESC, b.subscription_status DESC NULLS LAST, b.name`
    );
    res.json({ success: true, businesses: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /admin/businesses — add a new business ─────────────────────────────
router.post('/businesses', async (req, res) => {
  try {
    const {
      name, category, address, lat, lng, phone,
      delivery_fee = 30, store_hours = '8:00 AM - 8:00 PM',
    } = req.body;

    if (!name || !category) {
      return res.status(400).json({ success: false, message: 'Name and category required.' });
    }
    // Find Flora zone as default
    const { rows: z } = await query(`SELECT id FROM zones WHERE slug='flora' LIMIT 1`);
    const zoneId = z[0]?.id;

    const { rows } = await query(
      `INSERT INTO businesses
         (name, category, zone_id, address, lat, lng, phone,
          is_active, is_open, is_store, delivery_fee, store_hours,
          subscription_status, subscription_fee)
       VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,TRUE,TRUE,$8,$9,'inactive',$10)
       RETURNING id, name`,
      [name, category, zoneId, address || null,
       lat ? parseFloat(lat) : null, lng ? parseFloat(lng) : null,
       phone || null, parseFloat(delivery_fee), store_hours, SUBSCRIPTION_FEE]
    );
    res.status(201).json({ success: true, business: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /admin/businesses/:id/products — add a product ─────────────────────
router.post('/businesses/:id/products', async (req, res) => {
  try {
    const { name, price, description, emoji, unit, category, stock = 100 } = req.body;
    if (!name || price == null) {
      return res.status(400).json({ success: false, message: 'Product name and price required.' });
    }
    const { rows } = await query(
      `INSERT INTO menu_items
         (business_id, name, description, price, emoji, category, unit, stock)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, name, price`,
      [req.params.id, name, description || null, parseFloat(price),
       emoji || '🛍', category || 'General', unit || 'each', parseInt(stock)]
    );
    res.status(201).json({ success: true, product: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /admin/businesses/:id/products ──────────────────────────────────────
router.get('/businesses/:id/products', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, name, description, price, emoji, category, unit, stock
       FROM menu_items WHERE business_id=$1 ORDER BY name`,
      [req.params.id]
    );
    res.json({ success: true, products: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── DELETE /admin/products/:id ──────────────────────────────────────────────
router.delete('/products/:id', async (req, res) => {
  try {
    await query('DELETE FROM menu_items WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /admin/businesses/:id/pay — record subscription payment ────────────
router.post('/businesses/:id/pay', async (req, res) => {
  try {
    const { amount = SUBSCRIPTION_FEE, months = 1 } = req.body;
    // Extend expiry: if still active, add to current expiry; else from today
    const { rows: b } = await query(
      `SELECT subscription_expires FROM businesses WHERE id=$1`, [req.params.id]
    );
    if (!b[0]) return res.status(404).json({ success: false, message: 'Business not found.' });

    // Always EXTEND from the later of (today, current expiry) — never shorten.
    // This makes recording a payment safe even if the store is on a long free
    // window: it adds months on top, and an expired store restarts from today.
    const today = new Date();
    const current = b[0].subscription_expires ? new Date(b[0].subscription_expires) : today;
    const baseDate = current > today ? current : today;
    const newExpiry = new Date(baseDate);
    newExpiry.setMonth(newExpiry.getMonth() + parseInt(months));
    const newExpiryStr = newExpiry.toISOString().slice(0, 10);

    await query(
      `UPDATE businesses
       SET subscription_status='active', subscription_expires=$1,
           last_payment_date=CURRENT_DATE, last_payment_amount=$2
       WHERE id=$3`,
      [newExpiryStr, parseFloat(amount), req.params.id]
    );
    await query(
      `INSERT INTO subscription_payments
         (business_id, amount, months_added, new_expiry, recorded_by)
       VALUES ($1,$2,$3,$4,$5)`,
      [req.params.id, parseFloat(amount), parseInt(months), newExpiryStr, req.user.id]
    );
    res.json({ success: true, new_expiry: newExpiryStr,
               message: `Subscription active until ${newExpiryStr}` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /admin/businesses/:id/free-period — set a free visibility window ───
// For the "free now, paid later" model. Keeps the store visible for N months
// (or "free for now" = a long window) WITHOUT recording any payment. This is the
// control to use during your launch free period instead of "Record ₱300".
//   body: { months: <number> }  — omit or 0 = "free for now" (100-year window)
router.post('/businesses/:id/free-period', async (req, res) => {
  try {
    const months = parseInt(req.body.months) || 0;
    const { rows: b } = await query(
      `SELECT id FROM businesses WHERE id=$1`, [req.params.id]);
    if (!b[0]) return res.status(404).json({ success: false, message: 'Business not found.' });

    let newExpiryStr;
    if (months <= 0) {
      // "Free for now" — long window; you end it later by recording a paid sub.
      const d = new Date();
      d.setFullYear(d.getFullYear() + 100);
      newExpiryStr = d.toISOString().slice(0, 10);
    } else {
      const d = new Date();
      d.setMonth(d.getMonth() + months);
      newExpiryStr = d.toISOString().slice(0, 10);
    }
    await query(
      `UPDATE businesses
       SET subscription_status='active', subscription_expires=$1
       WHERE id=$2`,
      [newExpiryStr, req.params.id]
    );
    res.json({ success: true, new_expiry: newExpiryStr,
               message: months > 0
                 ? `Free until ${newExpiryStr}`
                 : `Free for now (no expiry during launch)` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PATCH /admin/businesses/:id/toggle — manual show/hide ───────────────────
router.patch('/businesses/:id/toggle', async (req, res) => {
  try {
    const { active } = req.body;
    await query(
      `UPDATE businesses SET subscription_status=$1 WHERE id=$2`,
      [active ? 'active' : 'inactive', req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Surge control ───────────────────────────────────────────────────────────
router.get('/surge', async (req, res) => {
  try {
    res.json({ success: true, surge: await getSurge() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/surge', async (req, res) => {
  try {
    const { active, multiplier, label } = req.body;
    const surge = await setSurge(!!active, multiplier, label);
    res.json({ success: true, surge });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Promo stats ─────────────────────────────────────────────────────────────
router.get('/promo-stats', async (req, res) => {
  try {
    const settings = await getPromoSettings();
    const { rows } = await query(
      `SELECT COUNT(*)::int AS total_redeemed,
              COALESCE(SUM(sugonow_cost),0) AS total_cost,
              COUNT(*) FILTER (WHERE promo_type='free_ride')::int AS free_rides,
              COUNT(*) FILTER (WHERE promo_type='free_delivery')::int AS free_deliveries
       FROM promo_redemptions`
    );
    res.json({ success: true, settings, stats: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/promo-toggle', async (req, res) => {
  try {
    const { active } = req.body;
    await query(`UPDATE app_settings SET value=$1, updated_at=NOW() WHERE key='promo_active'`,
      [active ? 'true' : 'false']);
    res.json({ success: true, active: !!active });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GCash number settings (shown to drivers + merchants for payments) ───────
router.get('/gcash-settings', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT key, value FROM app_settings WHERE key IN ('gcash_number','gcash_name','toppick_price')`);
    const info = {};
    rows.forEach(r => { info[r.key] = r.value; });
    res.json({ success: true, gcash_number: info.gcash_number || '', gcash_name: info.gcash_name || 'SugoNow',
               toppick_price: parseFloat(info.toppick_price) || 300 });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/gcash-settings', async (req, res) => {
  try {
    const { gcash_number, gcash_name, toppick_price } = req.body;
    if (gcash_number != null) {
      await query(
        `INSERT INTO app_settings (key, value) VALUES ('gcash_number', $1)
         ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()`,
        [String(gcash_number).trim()]);
    }
    if (gcash_name != null) {
      await query(
        `INSERT INTO app_settings (key, value) VALUES ('gcash_name', $1)
         ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()`,
        [String(gcash_name).trim()]);
    }
    if (toppick_price != null && !isNaN(parseFloat(toppick_price))) {
      await query(
        `INSERT INTO app_settings (key, value) VALUES ('toppick_price', $1)
         ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()`,
        [String(parseFloat(toppick_price))]);
    }
    res.json({ success: true, message: 'Settings updated.' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;
