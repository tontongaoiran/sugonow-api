/**
 * SugoNow — src/routes/merchant.js  (Batch G2-A)
 *
 * Merchant self-service:
 *   - GET  /merchant/me            -> my business + approval status
 *   - GET  /merchant/dashboard     -> earnings (today/week/month) + order counts
 * Admin:
 *   - GET  /merchant/admin/applications      -> pending/all merchant signups
 *   - POST /merchant/admin/:bizId/approve     -> approve + set fee model + free window
 *   - POST /merchant/admin/:bizId/reject
 *   - POST /merchant/admin/:bizId/suspend
 *
 * Mount: app.use('/api/v1/merchant', require('./src/routes/merchant'));
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const { query } = require('../db/pool');
const { logError } = require('../services/errorLogService');
const { authenticate, requireRole } = require('../middleware/auth');
const { sendSms, sendNotificationSms } = require('../services/smsService');
const M = require('../services/messageService');

// Merchant fee discipline: soft warning at WARN, store hidden at CAP.
// Admin-adjustable via app_settings (merchant_fee_cap / merchant_fee_warn),
// cached 30s. Warn defaults to 80% of the cap when not set separately.
let _feeCache = { at: 0, cap: 500, warn: 400 };
async function feeThresholds() {
  if (Date.now() - _feeCache.at < 30000) return _feeCache;
  try {
    const { rows } = await query(
      `SELECT key, value FROM app_settings WHERE key IN ('merchant_fee_cap','merchant_fee_warn')`);
    const kv = Object.fromEntries(rows.map(r => [r.key, parseFloat(r.value)]));
    const cap = kv.merchant_fee_cap > 0 ? kv.merchant_fee_cap : 500;
    const warn = kv.merchant_fee_warn > 0 ? kv.merchant_fee_warn : Math.round(cap * 0.8);
    _feeCache = { at: Date.now(), cap, warn };
  } catch (e) { logError('feeThresholds', e); }
  return _feeCache;
}

const router = express.Router();
router.use(authenticate);

// ── Photo helpers (same mechanism as the admin catalog) ──
const UPLOAD_DIR = path.join(process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'uploads'), 'products');
function saveBase64Image(base64) {
  try {
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const m = base64.match(/^data:image\/(\w+);base64,(.+)$/);
    let ext = 'jpg', data = base64;
    if (m) { ext = m[1] === 'jpeg' ? 'jpg' : m[1]; data = m[2]; }
    const fname = `mprod_${Date.now()}_${Math.round(Math.random()*1e6)}.${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, fname), Buffer.from(data, 'base64'));
    return `/uploads/products/${fname}`;
  } catch { return null; }
}
function resolvePhoto(photo_base64, photo_url) {
  if (photo_base64 && photo_base64.startsWith('data:image')) return saveBase64Image(photo_base64);
  if (photo_url && /^https?:\/\//i.test(photo_url)) return photo_url;
  return null;
}

// Resolve the merchant's own (approved) business id; returns null if none.
async function myBusinessId(userId) {
  const { rows } = await query(
    `SELECT id FROM businesses WHERE owner_id=$1 ORDER BY created_at DESC NULLS LAST LIMIT 1`,
    [userId]);
  return rows[0]?.id || null;
}

// ════════ MERCHANT ════════

// My business + approval status
router.get('/me', requireRole('merchant'), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, name, category, merchant_status, is_featured, featured_until,
              free_until, commission_type, commission_value, contact_mobile,
              COALESCE(hidden, FALSE) AS hidden,
              COALESCE(is_open, TRUE) AS is_open, closed_until, closed_note, banner_url,
              -- closed = merchant toggled off AND the reopen date hasn't passed
              (COALESCE(is_open, TRUE) = FALSE
               AND (closed_until IS NULL OR closed_until >= CURRENT_DATE)) AS is_closed
       FROM businesses WHERE owner_id=$1
       ORDER BY created_at DESC NULLS LAST LIMIT 1`,
      [req.user.id]);
    if (!rows[0]) {
      return res.json({ success: true, business: null,
        message: 'No business found for this account.' });
    }
    res.json({ success: true, business: rows[0] });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── PATCH /merchant/store — merchant edits their own contact / payout info ──
router.patch('/store', requireRole('merchant'), async (req, res) => {
  try {
    const { contact_mobile, payout_gcash } = req.body;
    const { rows: biz } = await query(
      `SELECT id FROM businesses WHERE owner_id=$1 ORDER BY created_at DESC NULLS LAST LIMIT 1`,
      [req.user.id]);
    if (!biz[0]) return res.status(404).json({ success: false, message: 'No store found.' });
    const sets = [], vals = [];
    if (contact_mobile != null) { vals.push((contact_mobile || '').trim() || null); sets.push(`contact_mobile=$${vals.length}`); }
    // payout_gcash is optional — only set if the column exists (guarded try below).
    if (!sets.length && payout_gcash == null)
      return res.status(400).json({ success: false, message: 'Nothing to update.' });
    if (sets.length) {
      vals.push(biz[0].id);
      await query(`UPDATE businesses SET ${sets.join(', ')} WHERE id=$${vals.length}`, vals);
    }
    if (payout_gcash != null) {
      // Best-effort: store payout number if the column exists; ignore if not.
      try {
        await query(`UPDATE businesses SET payout_gcash=$1 WHERE id=$2`,
          [(payout_gcash || '').trim() || null, biz[0].id]);
      } catch (e) { /* column may not exist yet — non-fatal */ }
    }
    res.json({ success: true, message: 'Store info updated.' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Earnings dashboard. Earnings here = the merchant's product revenue from
// completed orders (NOT the ride fare, which is the driver's). We sum order_items
// for the merchant's business on completed bookings.
router.get('/dashboard', requireRole('merchant'), async (req, res) => {
  try {
    const { rows: biz } = await query(
      `SELECT id FROM businesses WHERE owner_id=$1 ORDER BY created_at DESC NULLS LAST LIMIT 1`,
      [req.user.id]);
    if (!biz[0]) return res.json({ success: true, business: null });
    const businessId = biz[0].id;

    const periods = {
      today: "b.completed_at::date = (NOW() AT TIME ZONE 'Asia/Manila')::date",
      week:  "b.completed_at >= date_trunc('week', NOW() AT TIME ZONE 'Asia/Manila')",
      month: "b.completed_at >= date_trunc('month', NOW() AT TIME ZONE 'Asia/Manila')",
      lastWeek:  "b.completed_at >= date_trunc('week',  NOW() AT TIME ZONE 'Asia/Manila') - INTERVAL '1 week' AND b.completed_at < date_trunc('week',  NOW() AT TIME ZONE 'Asia/Manila')",
      lastMonth: "b.completed_at >= date_trunc('month', NOW() AT TIME ZONE 'Asia/Manila') - INTERVAL '1 month' AND b.completed_at < date_trunc('month', NOW() AT TIME ZONE 'Asia/Manila')",
      total: "TRUE",
    };
    const out = {};
    for (const [k, cond] of Object.entries(periods)) {
      const { rows } = await query(
        `SELECT
            COUNT(DISTINCT b.id)::int AS orders,
            COALESCE(SUM(oi.unit_price * oi.quantity), 0) AS revenue
         FROM order_items oi
         JOIN menu_items mi ON mi.id = oi.product_id
         JOIN bookings b ON b.id = oi.booking_id
         WHERE mi.business_id = $1
           AND b.status = 'completed'
           AND oi.status <> 'unavailable'
           AND ${cond}`,
        [businessId]);
      out[k] = {
        orders: rows[0].orders,
        revenue: Math.round(parseFloat(rows[0].revenue)),
      };
    }

    // Pending (incoming) order count — bookings with this business's items not yet done
    const { rows: pend } = await query(
      `SELECT COUNT(DISTINCT b.id)::int AS n
       FROM order_items oi
       JOIN menu_items mi ON mi.id = oi.product_id
       JOIN bookings b ON b.id = oi.booking_id
       WHERE mi.business_id=$1
         AND b.status IN ('pending','accepted','arrived','in_progress','waiting')`,
      [businessId]);

    res.json({ success: true, earnings: out, pending_orders: pend[0].n });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ════════ ADMIN ════════

// List merchant applications (status: pending|approved|rejected|suspended|all)
router.get('/admin/applications', requireRole('admin'), async (req, res) => {
  try {
    const status = req.query.status;
    const base =
      `SELECT b.id, b.name, b.category, b.merchant_status, b.contact_mobile,
              b.is_featured, b.featured_until, b.free_until,
              b.commission_type, b.commission_value,
              u.full_name AS owner_name, u.mobile AS owner_mobile, u.id AS owner_id
       FROM businesses b
       LEFT JOIN users u ON u.id = b.owner_id
       WHERE b.owner_id IS NOT NULL`;
    const rows = (status && status !== 'all')
      ? (await query(base + ` AND b.merchant_status=$1 ORDER BY b.created_at DESC NULLS LAST`, [status])).rows
      : (await query(base + ` ORDER BY b.merchant_status, b.created_at DESC NULLS LAST`)).rows;
    res.json({ success: true, applications: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Approve a merchant: set fee model + optional free-visibility window
router.post('/admin/:bizId/approve', requireRole('admin'), async (req, res) => {
  try {
    const { commission_type = 'flat', commission_value = 5, free_months = 1 } = req.body;
    const validType = ['percent', 'flat', 'none'].includes(commission_type) ? commission_type : 'flat';
    const months = String(parseInt(free_months) || 0);
    await query(
      `UPDATE businesses
         SET merchant_status='approved',
             commission_type=$1,
             commission_value=$2,
             free_until = (CURRENT_DATE + ($3 || ' months')::interval)::date,
             hidden = FALSE,
             -- Make the store VISIBLE to customers. The customer /stores query
             -- requires: is_active=TRUE, a matching zone_id, subscription active,
             -- and a non-expired (or null) subscription_expires. Set all of them.
             is_active = TRUE,
             zone_id = COALESCE(zone_id, (SELECT id FROM zones WHERE slug='flora' LIMIT 1)),
             subscription_status = 'active',
             subscription_expires = (CURRENT_DATE + INTERVAL '100 years')::date
       WHERE id=$4`,
      [validType, commission_value, months, req.params.bizId]);
    await query(
      `UPDATE merchant_applications SET status='approved', reviewed_by=$1 WHERE business_id=$2`,
      [req.user.id, req.params.bizId]);

    // Tell the merchant the good news by SMS (owner's mobile, else store contact)
    const { rows: who } = await query(
      `SELECT b.name, COALESCE(u.mobile, b.contact_mobile) AS mobile
       FROM businesses b LEFT JOIN users u ON u.id = b.owner_id
       WHERE b.id=$1`, [req.params.bizId]);
    if (who[0]?.mobile) {
      sendSms(who[0].mobile,
        `SugoNow: Congratulations! Your store "${who[0].name}" is now APPROVED. ` +
        `Customers can now see your store and you'll start receiving live orders in the app.`
      ).catch(() => {});
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/admin/:bizId/reject', requireRole('admin'), async (req, res) => {
  try {
    await query(`UPDATE businesses SET merchant_status='rejected', hidden=TRUE, subscription_status='inactive' WHERE id=$1`, [req.params.bizId]);
    await query(`UPDATE merchant_applications SET status='rejected', reviewed_by=$1 WHERE business_id=$2`,
      [req.user.id, req.params.bizId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/admin/:bizId/suspend', requireRole('admin'), async (req, res) => {
  try {
    await query(`UPDATE businesses SET merchant_status='suspended', hidden=TRUE, subscription_status='inactive' WHERE id=$1`, [req.params.bizId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ════════ MERCHANT PRODUCTS (self-service, scoped to own business) ════════

// List my products (includes unavailable)
router.get('/products', requireRole('merchant'), async (req, res) => {
  try {
    const businessId = await myBusinessId(req.user.id);
    if (!businessId) return res.json({ success: true, products: [] });
    const { rows } = await query(
      `SELECT mi.id, mi.name, mi.description, mi.price, mi.emoji, mi.photo_url, mi.has_options,
              mi.available, mi.brand, mi.weight_kg, mi.is_bestseller, mi.category,
              COALESCE(s.sold_30d, 0) AS sold_30d
       FROM menu_items mi
       LEFT JOIN (
         SELECT oi.product_id AS id, SUM(oi.quantity) AS sold_30d
         FROM order_items oi
         JOIN bookings b ON b.id = oi.booking_id
          AND b.status = 'completed'
          AND b.created_at >= NOW() - INTERVAL '30 days'
         WHERE oi.product_id IS NOT NULL
         GROUP BY oi.product_id
       ) s ON s.id = mi.id
       WHERE mi.business_id=$1 ORDER BY mi.sort_order, mi.name`,
      [businessId]);
    res.json({ success: true, products: rows, business_id: businessId });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Create a product on my business
router.post('/products', requireRole('merchant'), async (req, res) => {
  try {
    const businessId = await myBusinessId(req.user.id);
    if (!businessId) return res.status(400).json({ success: false, message: 'No business found for this account.' });

    // Pending AND approved merchants can build their menu. (Pending stores are
    // hidden from customers, so no orders can arrive until admin approves.)
    // Only rejected/suspended accounts are blocked.
    const { rows: st } = await query(`SELECT merchant_status FROM businesses WHERE id=$1`, [businessId]);
    if (!['pending', 'approved'].includes(st[0]?.merchant_status)) {
      return res.status(403).json({ success: false, message: 'Your store account is not active. Please contact SugoNow.' });
    }

    const { name, description, base_price, emoji, category, unit, photo_base64, photo_url,
            option_groups } = req.body;
    if (!name || base_price == null) {
      return res.status(400).json({ success: false, message: 'Name and price are required.' });
    }
    const photo = resolvePhoto(photo_base64, photo_url);
    // Keep only well-formed groups: named, with at least one named choice
    const groups = (Array.isArray(option_groups) ? option_groups : [])
      .map(g => ({
        name: (g.name || '').trim(),
        select_type: g.select_type === 'many' ? 'many' : 'one',
        required: g.required !== false,
        choices: (g.choices || [])
          .map(c => ({ name: (c.name || '').trim(), price_delta: parseFloat(c.price_delta) || 0 }))
          .filter(c => c.name),
      }))
      .filter(g => g.name && g.choices.length > 0);

    const { rows } = await query(
      `INSERT INTO menu_items
         (business_id, name, description, price, emoji, category, unit,
          photo_url, has_options, available, stock, brand, weight_kg)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE,100,$10,$11)
       RETURNING id`,
      [businessId, name.trim(), description || null, parseFloat(base_price),
       emoji || '🍽', category || 'General', unit || 'each', photo, groups.length > 0,
       req.body.brand || null,
       req.body.weight_kg != null ? parseFloat(req.body.weight_kg) : null]);
    const productId = rows[0].id;

    // Same option tables the admin builder and customer screen already use
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      const { rows: gr } = await query(
        `INSERT INTO option_groups (product_id, name, select_type, required, sort_order)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [productId, g.name, g.select_type, g.required, gi]);
      for (let ci = 0; ci < g.choices.length; ci++) {
        await query(
          `INSERT INTO option_choices (group_id, name, price_delta, sort_order)
           VALUES ($1,$2,$3,$4)`,
          [gr[0].id, g.choices[ci].name, g.choices[ci].price_delta, ci]);
      }
    }
    res.status(201).json({ success: true, product_id: productId, photo_url: photo });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Edit my product (ownership enforced via business_id match)
router.patch('/products/:id', requireRole('merchant'), async (req, res) => {
  try {
    const businessId = await myBusinessId(req.user.id);
    if (!businessId) return res.status(400).json({ success: false, message: 'No business found.' });

    // Confirm this product belongs to my business
    const { rows: own } = await query(
      `SELECT id FROM menu_items WHERE id=$1 AND business_id=$2`, [req.params.id, businessId]);
    if (!own[0]) return res.status(403).json({ success: false, message: 'Not your product.' });

    const { name, description, base_price, available, photo_base64, photo_url, brand, weight_kg, category } = req.body;
    const photo = resolvePhoto(photo_base64, photo_url);
    await query(
      `UPDATE menu_items SET
         name = COALESCE($1, name),
         description = COALESCE($2, description),
         price = COALESCE($3, price),
         available = COALESCE($4, available),
         photo_url = COALESCE($5, photo_url),
         brand = COALESCE($7, brand),
         weight_kg = COALESCE($8, weight_kg),
         category = COALESCE($9, category)
       WHERE id=$6`,
      [name ?? null, description ?? null,
       base_price != null ? parseFloat(base_price) : null,
       available, photo, req.params.id,
       brand ?? null, weight_kg != null ? parseFloat(weight_kg) : null,
       category ?? null]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Delete my product
router.delete('/products/:id', requireRole('merchant'), async (req, res) => {
  try {
    const businessId = await myBusinessId(req.user.id);
    if (!businessId) return res.status(400).json({ success: false, message: 'No business found.' });
    const { rows: own } = await query(
      `SELECT id FROM menu_items WHERE id=$1 AND business_id=$2`, [req.params.id, businessId]);
    if (!own[0]) return res.status(403).json({ success: false, message: 'Not your product.' });
    await query(`DELETE FROM menu_items WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Quick toggle availability
router.post('/products/:id/toggle', requireRole('merchant'), async (req, res) => {
  try {
    const businessId = await myBusinessId(req.user.id);
    if (!businessId) return res.status(400).json({ success: false, message: 'No business found.' });
    const { rows } = await query(
      `UPDATE menu_items SET available = NOT available
       WHERE id=$1 AND business_id=$2 RETURNING available`,
      [req.params.id, businessId]);
    if (!rows[0]) return res.status(403).json({ success: false, message: 'Not your product.' });
    res.json({ success: true, available: rows[0].available });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Toggle the "Best Seller" highlight on a food item.
// Rules: food/bakery stores only, item must belong to this merchant, max 3 per store.
const BESTSELLER_MAX = 3;
router.post('/products/:id/bestseller', requireRole('merchant'), async (req, res) => {
  try {
    const businessId = await myBusinessId(req.user.id);
    if (!businessId) return res.status(400).json({ success: false, message: 'No business found.' });

    // Food/bakery only.
    const { rows: biz } = await query(`SELECT category FROM businesses WHERE id=$1`, [businessId]);
    if (!biz[0] || !['food', 'bakery'].includes(biz[0].category)) {
      return res.status(400).json({ success: false, message: 'Best Sellers is available for food stores only.' });
    }

    // Item must be this merchant's.
    const { rows: prod } = await query(
      `SELECT is_bestseller FROM menu_items WHERE id=$1 AND business_id=$2`,
      [req.params.id, businessId]);
    if (!prod[0]) return res.status(403).json({ success: false, message: 'Not your product.' });

    // Enforce the cap only when turning ON.
    if (!prod[0].is_bestseller) {
      const { rows: cnt } = await query(
        `SELECT COUNT(*)::int AS n FROM menu_items WHERE business_id=$1 AND is_bestseller=TRUE`,
        [businessId]);
      if (cnt[0].n >= BESTSELLER_MAX) {
        return res.status(400).json({
          success: false,
          message: `You can highlight up to ${BESTSELLER_MAX} Best Sellers. Turn one off first.`,
        });
      }
    }

    const { rows } = await query(
      `UPDATE menu_items SET is_bestseller = NOT is_bestseller
       WHERE id=$1 AND business_id=$2 RETURNING is_bestseller`,
      [req.params.id, businessId]);
    res.json({ success: true, is_bestseller: rows[0].is_bestseller });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ════════ PRODUCT OPTIONS (customizations: size, sugar level, add-ons…) ════════

// Get my product's option groups (for the editor)
router.get('/products/:id/options', requireRole('merchant'), async (req, res) => {
  try {
    const businessId = await myBusinessId(req.user.id);
    const { rows: own } = await query(
      `SELECT id FROM menu_items WHERE id=$1 AND business_id=$2`, [req.params.id, businessId]);
    if (!own[0]) return res.status(403).json({ success: false, message: 'Not your product.' });

    const { rows: gr } = await query(
      `SELECT id, name, select_type, required, sort_order
       FROM option_groups WHERE product_id=$1 ORDER BY sort_order`, [req.params.id]);
    const groups = [];
    for (const g of gr) {
      const { rows: ch } = await query(
        `SELECT id, name, price_delta, sort_order
         FROM option_choices WHERE group_id=$1 ORDER BY sort_order`, [g.id]);
      groups.push({ ...g, choices: ch });
    }
    res.json({ success: true, option_groups: groups });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Replace my product's option groups (the editor saves the whole set at once).
// Sending an empty list removes all customizations.
router.put('/products/:id/options', requireRole('merchant'), async (req, res) => {
  try {
    const businessId = await myBusinessId(req.user.id);
    const { rows: own } = await query(
      `SELECT id FROM menu_items WHERE id=$1 AND business_id=$2`, [req.params.id, businessId]);
    if (!own[0]) return res.status(403).json({ success: false, message: 'Not your product.' });

    const groups = (Array.isArray(req.body.option_groups) ? req.body.option_groups : [])
      .map(g => ({
        name: (g.name || '').trim(),
        select_type: g.select_type === 'many' ? 'many' : 'one',
        required: g.required !== false,
        choices: (g.choices || [])
          .map(c => ({ name: (c.name || '').trim(), price_delta: parseFloat(c.price_delta) || 0 }))
          .filter(c => c.name),
      }))
      .filter(g => g.name && g.choices.length > 0);

    // Replace everything: simplest model that can't drift out of sync
    await query(
      `DELETE FROM option_choices WHERE group_id IN
         (SELECT id FROM option_groups WHERE product_id=$1)`, [req.params.id]);
    await query(`DELETE FROM option_groups WHERE product_id=$1`, [req.params.id]);

    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      const { rows: gr } = await query(
        `INSERT INTO option_groups (product_id, name, select_type, required, sort_order)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [req.params.id, g.name, g.select_type, g.required, gi]);
      for (let ci = 0; ci < g.choices.length; ci++) {
        await query(
          `INSERT INTO option_choices (group_id, name, price_delta, sort_order)
           VALUES ($1,$2,$3,$4)`,
          [gr[0].id, g.choices[ci].name, g.choices[ci].price_delta, ci]);
      }
    }
    await query(`UPDATE menu_items SET has_options=$1 WHERE id=$2`,
      [groups.length > 0, req.params.id]);
    res.json({ success: true, has_options: groups.length > 0 });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Update my store's pickup location (GPS pin)
router.post('/location', requireRole('merchant'), async (req, res) => {
  try {
    const businessId = await myBusinessId(req.user.id);
    if (!businessId) return res.status(400).json({ success: false, message: 'No business found.' });
    const { lat, lng } = req.body;
    if (lat == null || lng == null) {
      return res.status(400).json({ success: false, message: 'lat and lng are required.' });
    }
    await query(`UPDATE businesses SET lat=$1, lng=$2 WHERE id=$3`,
      [parseFloat(lat), parseFloat(lng), businessId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ════════ STORE STATUS (open / temporarily closed) ════════

// Close my store (optionally until a reopen date, with a note customers see),
// or reopen it. While closed, customers see the notice and can't order.
// If a reopen date is set, the store auto-reopens when that date arrives.
router.post('/store-status', requireRole('merchant'), async (req, res) => {
  try {
    const businessId = await myBusinessId(req.user.id);
    if (!businessId) return res.status(400).json({ success: false, message: 'No business found.' });

    const { action, reopen_date, note } = req.body;
    if (action === 'open') {
      await query(
        `UPDATE businesses SET is_open=TRUE, closed_until=NULL, closed_note=NULL WHERE id=$1`,
        [businessId]);
      return res.json({ success: true, message: 'Your store is now OPEN. Customers can order again.' });
    }
    if (action === 'close') {
      // reopen_date optional: null = closed until the merchant reopens manually
      let until = null;
      if (reopen_date) {
        const d = new Date(reopen_date);
        if (isNaN(d.getTime())) {
          return res.status(400).json({ success: false, message: 'Invalid reopen date.' });
        }
        until = reopen_date;
      }
      await query(
        `UPDATE businesses SET is_open=FALSE, closed_until=$1, closed_note=$2 WHERE id=$3`,
        [until, (note || '').trim().slice(0, 200) || null, businessId]);
      return res.json({ success: true,
        message: until
          ? `Your store is closed and will automatically reopen on ${until}.`
          : 'Your store is closed until you reopen it.' });
    }
    res.status(400).json({ success: false, message: "action must be 'open' or 'close'." });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ════════ BRAND PHOTO (store profile picture customers see) ════════

router.post('/brand-photo', requireRole('merchant'), async (req, res) => {
  try {
    const businessId = await myBusinessId(req.user.id);
    if (!businessId) return res.status(400).json({ success: false, message: 'No business found.' });
    const photo = resolvePhoto(req.body.photo_base64, req.body.photo_url);
    if (!photo) return res.status(400).json({ success: false, message: 'A photo is required.' });
    await query(`UPDATE businesses SET banner_url=$1 WHERE id=$2`, [photo, businessId]);
    res.json({ success: true, banner_url: photo });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ════════ MERCHANT ORDERS (G2-C) ════════

// List orders for my store: active (incoming/in-progress) and recent completed.
// Each order includes its items and, once a driver accepts, the driver name+plate.
router.get('/orders', requireRole('merchant'), async (req, res) => {
  try {
    const businessId = await myBusinessId(req.user.id);
    if (!businessId) return res.json({ success: true, orders: [] });

    // Bookings that contain at least one of this business's products
    const { rows: bookings } = await query(
      `SELECT DISTINCT b.id, b.status, b.created_at, b.estimated_fare,
              b.dropoff_address AS delivery_address,
              cust.full_name AS customer_name, cust.mobile AS customer_mobile,
              drv.full_name AS driver_name, dp.plate_number AS driver_plate
       FROM bookings b
       JOIN order_items oi ON oi.booking_id = b.id
       JOIN menu_items mi ON mi.id = oi.product_id
       LEFT JOIN users cust ON cust.id = b.customer_id
       LEFT JOIN users drv ON drv.id = b.driver_id
       LEFT JOIN driver_profiles dp ON dp.user_id = b.driver_id
       WHERE mi.business_id = $1
       ORDER BY b.created_at DESC
       LIMIT 50`,
      [businessId]);

    // Attach items to each booking
    for (const bk of bookings) {
      const { rows: items } = await query(
        `SELECT oi.product_name, oi.quantity, oi.unit_price, oi.options_text, oi.status
         FROM order_items oi
         JOIN menu_items mi ON mi.id = oi.product_id
         WHERE oi.booking_id = $1 AND mi.business_id = $2`,
        [bk.id, businessId]);
      bk.items = items;
      bk.items_total = items.reduce((s, i) => s + parseFloat(i.unit_price) * i.quantity, 0);
    }

    const active = bookings.filter(b => !['completed', 'cancelled'].includes(b.status));
    const past = bookings.filter(b => ['completed', 'cancelled'].includes(b.status));
    res.json({ success: true, active, past });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ════════ G2-D: FEES & FEATURED ════════

// Merchant: my fee balance + recent fee history
router.get('/fees', requireRole('merchant'), async (req, res) => {
  try {
    const businessId = await myBusinessId(req.user.id);
    if (!businessId) return res.json({ success: true, fee_owed: 0, ledger: [] });
    const { rows: biz } = await query(
      `SELECT fee_owed, fee_paid_total, free_until, commission_type, commission_value,
              is_featured, featured_paid_until
       FROM businesses WHERE id=$1`, [businessId]);
    const { rows: ledger } = await query(
      `SELECT order_value, fee_type, fee_value, fee_amount, was_free, created_at
       FROM merchant_fee_ledger WHERE business_id=$1 ORDER BY created_at DESC LIMIT 30`,
      [businessId]);
    const { rows: pendingPays } = await query(
      `SELECT id, amount, method, gcash_ref, created_at
       FROM merchant_fee_payment_requests
       WHERE business_id=$1 AND status='pending' ORDER BY created_at DESC`,
      [businessId]);
    const owed = parseFloat(biz[0]?.fee_owed || 0);
    const { cap: FEE_OWED_CAP, warn: FEE_OWED_WARN } = await feeThresholds();
    res.json({ success: true, ...biz[0], ledger,
               pending_payments: pendingPays,
               fee_cap: FEE_OWED_CAP, fee_warn: FEE_OWED_WARN,
               locked_for_fees: owed >= FEE_OWED_CAP });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Admin: set/extend featured ("Top Pick"). months defaults to 1 (₱300/mo).
router.post('/admin/:bizId/feature', requireRole('admin'), async (req, res) => {
  try {
    const { months = 1 } = req.body;
    const m = String(parseInt(months) || 1);
    await query(
      `UPDATE businesses
         SET is_featured = TRUE,
             featured_paid_until = (GREATEST(COALESCE(featured_paid_until, CURRENT_DATE), CURRENT_DATE)
                                    + ($1 || ' months')::interval)::date,
             featured_until = (GREATEST(COALESCE(featured_paid_until, CURRENT_DATE), CURRENT_DATE)
                                    + ($1 || ' months')::interval)::date
       WHERE id=$2`,
      [m, req.params.bizId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Admin: remove featured
router.post('/admin/:bizId/unfeature', requireRole('admin'), async (req, res) => {
  try {
    await query(`UPDATE businesses SET is_featured=FALSE, featured_until=NULL, featured_paid_until=NULL WHERE id=$1`,
      [req.params.bizId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Admin: record a fee payment (merchant settles their balance)
router.post('/admin/:bizId/record-payment', requireRole('admin'), async (req, res) => {
  try {
    const { amount, note } = req.body;
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return res.status(400).json({ success: false, message: 'Valid amount required.' });
    await query(
      `INSERT INTO merchant_fee_payments (business_id, amount, note, recorded_by)
       VALUES ($1,$2,$3,$4)`,
      [req.params.bizId, amt, note || null, req.user.id]);
    await query(
      `UPDATE businesses
         SET fee_owed = GREATEST(0, fee_owed - $1),
             fee_paid_total = fee_paid_total + $1
       WHERE id=$2`,
      [amt, req.params.bizId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Merchant: submit a fee payment (GCash ref -> admin verifies, or cash at office)
router.post('/fees/pay', requireRole('merchant'), async (req, res) => {
  try {
    const businessId = await myBusinessId(req.user.id);
    if (!businessId) return res.status(400).json({ success: false, message: 'No business found.' });
    const { amount, method = 'gcash', gcash_ref, receipt_base64, receipt_url } = req.body;
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return res.status(400).json({ success: false, message: 'Enter a valid amount.' });
    if (method === 'gcash' && (!gcash_ref || gcash_ref.trim().length < 4)) {
      return res.status(400).json({ success: false, message: 'Enter the GCash reference number.' });
    }
    // One pending request at a time keeps the ledger simple for everyone
    const { rows: dup } = await query(
      `SELECT id FROM merchant_fee_payment_requests
       WHERE business_id=$1 AND status='pending' LIMIT 1`, [businessId]);
    if (dup[0]) {
      return res.status(409).json({ success: false,
        message: 'You already have a payment awaiting admin confirmation. Please wait for it first.' });
    }
    const receipt = resolvePhoto(receipt_base64, receipt_url);  // optional screenshot
    await query(
      `INSERT INTO merchant_fee_payment_requests (business_id, amount, method, gcash_ref, receipt_url, status)
       VALUES ($1,$2,$3,$4,$5,'pending')`,
      [businessId, amt, method === 'cash' ? 'cash' : 'gcash', (gcash_ref || '').trim() || null, receipt]);
    res.json({ success: true,
      message: method === 'cash'
        ? 'Noted! Pay the cash at the SugoNow office and admin will confirm it.'
        : 'Payment submitted. Admin will verify your GCash payment shortly.' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Admin: activate (or change) a merchant's per-order fee, with an effective
// date and an announcement to the merchant (in-app message + SMS). "Prior
// notice" is part of the merchant terms — the effective date is that notice.
router.post('/admin/:bizId/activate-fees', requireRole('admin'), async (req, res) => {
  try {
    const { commission_type, commission_value, effective_date } = req.body;
    if (!['percent', 'flat', 'none'].includes(commission_type)) {
      return res.status(400).json({ success: false, message: 'commission_type must be percent, flat, or none.' });
    }
    const val = parseFloat(commission_value) || 0;
    // Fees start when free_until passes — so the effective date IS free_until.
    const eff = effective_date || new Date().toISOString().slice(0, 10);
    await query(
      `UPDATE businesses SET commission_type=$1, commission_value=$2, free_until=$3,
              fee_warn_notified=FALSE, fee_lock_notified=FALSE
       WHERE id=$4`,
      [commission_type, val, eff, req.params.bizId]);

    const { rows: who } = await query(
      `SELECT b.name, b.owner_id, COALESCE(u.mobile, b.contact_mobile) AS mobile
       FROM businesses b LEFT JOIN users u ON u.id=b.owner_id WHERE b.id=$1`,
      [req.params.bizId]);
    const feeTxt = commission_type === 'percent' ? `${val}% of the products total`
                 : commission_type === 'flat' ? `₱${val}`
                 : 'no fee';
    const effTxt = new Date(eff).toLocaleDateString('en-PH', { month: 'long', day: 'numeric', year: 'numeric' });
    if (who[0]) {
      const body = commission_type === 'none'
        ? `Good news! Starting ${effTxt}, NO SugoNow fee applies to your orders.`
        : `Starting ${effTxt}, a SugoNow fee of ${feeTxt} applies per completed order. ` +
          `You may adjust your product prices anytime in My Products. ` +
          `Your fee balance is always visible in your merchant account.`;
      if (who[0].owner_id) {
        M.sendMessage(who[0].owner_id, '📢 SugoNow fee update', body, 'general').catch(() => {});
      }
      if (who[0].mobile) {
        sendNotificationSms(who[0].mobile, `SugoNow (${who[0].name}): ${body}`).catch(() => {});
      }
    }
    res.json({ success: true, message: `Fee set to ${feeTxt}, effective ${effTxt}. Merchant notified.` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Admin: pending merchant fee payments (with reused-reference flag)
router.get('/admin/fee-payments', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT pr.id, pr.amount, pr.method, pr.gcash_ref, pr.receipt_url, pr.created_at,
              b.name AS business_name, b.fee_owed,
              EXISTS (SELECT 1 FROM merchant_fee_payment_requests prev
                      WHERE prev.gcash_ref IS NOT NULL AND prev.gcash_ref = pr.gcash_ref
                        AND prev.status='approved' AND prev.id <> pr.id) AS ref_already_used
       FROM merchant_fee_payment_requests pr
       JOIN businesses b ON b.id = pr.business_id
       WHERE pr.status='pending' ORDER BY pr.created_at`);
    res.json({ success: true, pending: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Admin: approve a merchant fee payment -> reduces owed, may unhide the store
router.post('/admin/fee-payments/:id/approve', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM merchant_fee_payment_requests WHERE id=$1 AND status='pending'`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Request not found.' });
    const t = rows[0];

    // Same anti-reuse guard as driver top-ups; admin can override with force
    if (!req.body.force && t.gcash_ref) {
      const { rows: dup } = await query(
        `SELECT id FROM merchant_fee_payment_requests
         WHERE gcash_ref=$1 AND status='approved' AND id<>$2 LIMIT 1`, [t.gcash_ref, t.id]);
      if (dup[0]) {
        return res.status(409).json({ success: false, ref_already_used: true,
          message: `This GCash reference (${t.gcash_ref}) was already approved before. ` +
                   `Confirm it is a NEW, real payment in your GCash before approving again.` });
      }
    }

    // Claim the request FIRST so a double-approval can't credit the same payment
    // twice (record + fee_owed reduction below would otherwise run twice).
    const { rowCount: claimed } = await query(
      `UPDATE merchant_fee_payment_requests SET status='approved', approved_by=$1, resolved_at=NOW()
       WHERE id=$2 AND status='pending'`, [req.user.id, req.params.id]);
    if (claimed === 0) {
      return res.status(409).json({ success: false, message: 'This payment was already processed.' });
    }

    const { rows: before } = await query(
      `SELECT fee_owed FROM businesses WHERE id=$1`, [t.business_id]);
    const { cap: FEE_OWED_CAP, warn: FEE_OWED_WARN } = await feeThresholds();
    const wasLocked = parseFloat(before[0]?.fee_owed || 0) >= FEE_OWED_CAP;

    await query(
      `INSERT INTO merchant_fee_payments (business_id, amount, note, recorded_by)
       VALUES ($1,$2,$3,$4)`,
      [t.business_id, parseFloat(t.amount),
       t.method === 'cash' ? 'Cash at office' : `GCash ref ${t.gcash_ref}`, req.user.id]);
    const { rows: after } = await query(
      `UPDATE businesses
         SET fee_owed = GREATEST(0, fee_owed - $1),
             fee_paid_total = fee_paid_total + $1,
             fee_warn_notified = CASE WHEN fee_owed - $1 < $3 THEN FALSE ELSE fee_warn_notified END,
             fee_lock_notified = CASE WHEN fee_owed - $1 < $4 THEN FALSE ELSE fee_lock_notified END
       WHERE id=$2 RETURNING fee_owed, name, owner_id`,
      [parseFloat(t.amount), t.business_id, FEE_OWED_WARN, FEE_OWED_CAP]);
    // (request already marked approved above)

    // If this payment brought them back under the cap, tell them the store is live
    const nowOwed = parseFloat(after[0]?.fee_owed || 0);
    if (wasLocked && nowOwed < FEE_OWED_CAP) {
      const { rows: u } = await query(
        `SELECT COALESCE(u.mobile, b.contact_mobile) AS mobile FROM businesses b
         LEFT JOIN users u ON u.id=b.owner_id WHERE b.id=$1`, [t.business_id]);
      if (after[0].owner_id) {
        M.sendMessage(after[0].owner_id, '✅ Store visible again',
          `Your payment of ₱${parseFloat(t.amount).toFixed(0)} is confirmed. ` +
          `Your store is visible to customers again. Remaining balance: ₱${nowOwed.toFixed(0)}.`,
          'general').catch(() => {});
      }
      if (u[0]?.mobile) {
        sendSms(u[0].mobile,
          `SugoNow (${after[0].name}): Payment confirmed — your store is visible to customers again!`
        ).catch(() => {});
      }
    }
    res.json({ success: true, remaining_owed: nowOwed,
               message: `Payment approved. Remaining owed: ₱${nowOwed.toFixed(0)}.` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/admin/fee-payments/:id/reject', requireRole('admin'), async (req, res) => {
  try {
    await query(
      `UPDATE merchant_fee_payment_requests SET status='rejected', approved_by=$1, resolved_at=NOW()
       WHERE id=$2`, [req.user.id, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Admin: per-merchant sales monitor (orders + product sales, 30 days & total)
router.get('/admin/sales', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT b2.id, b2.name,
              COUNT(DISTINCT bk.id) FILTER (WHERE bk.completed_at >= NOW() - INTERVAL '30 days')::int AS orders_30d,
              COALESCE(SUM(oi.quantity * oi.unit_price) FILTER (WHERE bk.completed_at >= NOW() - INTERVAL '30 days'), 0) AS sales_30d,
              COUNT(DISTINCT bk.id)::int AS orders_total,
              COALESCE(SUM(oi.quantity * oi.unit_price), 0) AS sales_total,
              COALESCE(b2.fee_owed, 0) AS fee_owed
       FROM businesses b2
       LEFT JOIN menu_items mi ON mi.business_id = b2.id
       LEFT JOIN order_items oi ON oi.product_id = mi.id
       LEFT JOIN bookings bk ON bk.id = oi.booking_id AND bk.status='completed'
       WHERE b2.merchant_status = 'approved' OR b2.owner_id IS NULL
       GROUP BY b2.id, b2.name
       ORDER BY sales_30d DESC`);
    res.json({ success: true, sales: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Admin: merchant SALES monitoring (their revenue, not our commission).
// Summary across all merchants for this week / this month / last month, plus a
// per-merchant leaderboard sorted by this-month sales. Uses oi.unit_price.
router.get('/admin/merchant-sales', requireRole('admin'), async (req, res) => {
  try {
    const TZ = "NOW() AT TIME ZONE 'Asia/Manila'";
    const periods = {
      week:      `b.completed_at >= date_trunc('week',  ${TZ})`,
      month:     `b.completed_at >= date_trunc('month', ${TZ})`,
      lastMonth: `b.completed_at >= date_trunc('month', ${TZ}) - INTERVAL '1 month' AND b.completed_at < date_trunc('month', ${TZ})`,
    };
    const summary = {};
    for (const [k, cond] of Object.entries(periods)) {
      const { rows } = await query(
        `SELECT COALESCE(SUM(oi.unit_price * oi.quantity),0) AS sales,
                COUNT(DISTINCT b.id)::int AS orders
         FROM order_items oi
         JOIN menu_items mi ON mi.id = oi.product_id
         JOIN bookings b ON b.id = oi.booking_id
         WHERE b.status='completed' AND oi.status <> 'unavailable' AND ${cond}`);
      summary[k] = { sales: Math.round(parseFloat(rows[0].sales)), orders: rows[0].orders };
    }
    // Per-merchant leaderboard (this month + all-time).
    const { rows: perM } = await query(
      `SELECT mi.business_id AS id, biz.name,
              COALESCE(SUM(oi.unit_price * oi.quantity) FILTER (
                WHERE b.completed_at >= date_trunc('month', ${TZ})),0) AS month_sales,
              COUNT(DISTINCT b.id) FILTER (
                WHERE b.completed_at >= date_trunc('month', ${TZ}))::int AS month_orders,
              COALESCE(SUM(oi.unit_price * oi.quantity),0) AS total_sales
       FROM order_items oi
       JOIN menu_items mi ON mi.id = oi.product_id
       JOIN businesses biz ON biz.id = mi.business_id
       JOIN bookings b ON b.id = oi.booking_id
       WHERE b.status='completed' AND oi.status <> 'unavailable'
       GROUP BY mi.business_id, biz.name
       ORDER BY month_sales DESC, total_sales DESC`);
    const merchants = perM.map(r => ({
      id: r.id, name: r.name,
      month_sales: Math.round(parseFloat(r.month_sales)),
      month_orders: r.month_orders,
      total_sales: Math.round(parseFloat(r.total_sales)),
    }));
    res.json({ success: true, summary, merchants });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Admin: full merchant list for the web Merchants tab (ALL statuses, incl.
// suspended, so they can be reactivated). One row per business with everything
// the tab needs.
router.get('/admin/merchants', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT b.id, b.name, b.merchant_status, b.hidden,
              COALESCE(b.fee_owed,0) AS fee_owed, COALESCE(b.fee_paid_total,0) AS fee_paid_total,
              b.commission_type, b.commission_value, b.is_featured, b.featured_paid_until, b.free_until,
              u.full_name AS owner_name, u.mobile AS owner_mobile,
              COALESCE((SELECT COUNT(*) FROM merchant_fee_payment_requests pr
                        WHERE pr.business_id=b.id AND pr.status='pending'),0)::int AS pending_payments
       FROM businesses b
       LEFT JOIN users u ON u.id = b.owner_id
       WHERE b.owner_id IS NOT NULL
       ORDER BY (b.merchant_status='suspended') DESC, b.fee_owed DESC, b.name`);
    res.json({ success: true, merchants: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Admin: reactivate a suspended merchant (back to approved + visible).
router.post('/admin/:bizId/reactivate', requireRole('admin'), async (req, res) => {
  try {
    await query(`UPDATE businesses SET merchant_status='approved', hidden=FALSE, subscription_status='active' WHERE id=$1`, [req.params.bizId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Admin: fee summary for all merchants (who owes what)
router.get('/admin/fees', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT b.id, b.name, b.fee_owed, b.fee_paid_total, b.commission_type,
              b.commission_value, b.is_featured, b.featured_paid_until, b.free_until,
              u.full_name AS owner_name, u.mobile AS owner_mobile
       FROM businesses b
       LEFT JOIN users u ON u.id = b.owner_id
       WHERE b.owner_id IS NOT NULL AND b.merchant_status='approved'
       ORDER BY b.fee_owed DESC`);
    res.json({ success: true, merchants: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ════════ GCASH PAYMENT INFO + MERCHANT TOP-PICK REQUESTS ════════

// Anyone logged in: get the SugoNow GCash number + Top Pick price
router.get('/gcash-info', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT key, value FROM app_settings WHERE key IN ('gcash_number','gcash_name','toppick_price')`);
    const info = {};
    rows.forEach(r => { info[r.key] = r.value; });
    res.json({ success: true,
      gcash_number: info.gcash_number || 'Not set',
      gcash_name:   info.gcash_name   || 'SugoNow',
      toppick_price: parseFloat(info.toppick_price) || 300 });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Merchant: submit a Top Pick request with GCash reference (admin approves)
router.post('/feature-request', requireRole('merchant'), async (req, res) => {
  try {
    const businessId = await myBusinessId(req.user.id);
    if (!businessId) return res.status(404).json({ success: false, message: 'No business found.' });
    const gcashRef = (req.body.gcash_ref || '').trim();
    if (!gcashRef) return res.status(400).json({ success: false, message: 'GCash reference number is required.' });

    // Block duplicate pending requests
    const { rows: existing } = await query(
      `SELECT id FROM merchant_feature_requests WHERE business_id=$1 AND status='pending'`,
      [businessId]);
    if (existing[0]) return res.status(400).json({ success: false, message: 'You already have a pending Top Pick request.' });

    const { rows: priceRows } = await query(
      `SELECT value FROM app_settings WHERE key='toppick_price'`);
    const price = parseFloat(priceRows[0]?.value) || 300;

    await query(
      `INSERT INTO merchant_feature_requests (business_id, amount, months, gcash_ref, requested_by)
       VALUES ($1, $2, 1, $3, $4)`,
      [businessId, price, gcashRef, req.user.id]);
    res.json({ success: true, message: 'Top Pick request submitted. Admin will review your payment and feature your store.' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Merchant: see my own feature request status
router.get('/feature-request/me', requireRole('merchant'), async (req, res) => {
  try {
    const businessId = await myBusinessId(req.user.id);
    if (!businessId) return res.json({ success: true, request: null });
    const { rows } = await query(
      `SELECT amount, months, gcash_ref, status, created_at, resolved_at
       FROM merchant_feature_requests WHERE business_id=$1
       ORDER BY created_at DESC LIMIT 1`, [businessId]);
    res.json({ success: true, request: rows[0] || null });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Admin: list pending Top Pick requests
router.get('/admin/feature-requests', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT fr.id, fr.business_id, fr.amount, fr.months, fr.gcash_ref, fr.status, fr.created_at,
              b.name AS business_name, b.category,
              u.full_name AS owner_name, u.mobile AS owner_mobile
       FROM merchant_feature_requests fr
       JOIN businesses b ON b.id = fr.business_id
       LEFT JOIN users u ON u.id = fr.requested_by
       WHERE fr.status='pending'
       ORDER BY fr.created_at ASC`);
    res.json({ success: true, requests: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Admin: approve a Top Pick request -> feature the store
router.post('/admin/feature-requests/:id/approve', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM merchant_feature_requests WHERE id=$1 AND status='pending'`, [req.params.id]);
    const fr = rows[0];
    if (!fr) return res.status(404).json({ success: false, message: 'Request not found or already handled.' });

    const m = String(parseInt(fr.months) || 1);
    await query(
      `UPDATE businesses
         SET is_featured = TRUE,
             featured_paid_until = (GREATEST(COALESCE(featured_paid_until, CURRENT_DATE), CURRENT_DATE)
                                    + ($1 || ' months')::interval)::date,
             featured_until = (GREATEST(COALESCE(featured_paid_until, CURRENT_DATE), CURRENT_DATE)
                                    + ($1 || ' months')::interval)::date
       WHERE id=$2`, [m, fr.business_id]);
    await query(
      `UPDATE merchant_feature_requests SET status='approved', reviewed_by=$1, resolved_at=NOW() WHERE id=$2`,
      [req.user.id, req.params.id]);
    res.json({ success: true, message: 'Top Pick approved and store featured.' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Admin: reject a Top Pick request
router.post('/admin/feature-requests/:id/reject', requireRole('admin'), async (req, res) => {
  try {
    await query(
      `UPDATE merchant_feature_requests SET status='rejected', reviewed_by=$1, resolved_at=NOW()
       WHERE id=$2 AND status='pending'`, [req.user.id, req.params.id]);
    res.json({ success: true, message: 'Request rejected.' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── Admin: get/set the merchant fee cap & warning thresholds ───────────────
router.get('/admin/fee-thresholds', requireRole('admin'), async (req, res) => {
  try { res.json({ success: true, ...(await feeThresholds()) }); }
  catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/admin/fee-thresholds', requireRole('admin'), async (req, res) => {
  try {
    const cap = parseFloat(req.body.cap);
    if (!cap || cap < 100) return res.status(400).json({ success: false, message: 'Cap must be at least ₱100.' });
    const warn = req.body.warn ? parseFloat(req.body.warn) : Math.round(cap * 0.8);
    if (warn >= cap) return res.status(400).json({ success: false, message: 'Warning level must be below the cap.' });
    for (const [k, v] of [['merchant_fee_cap', cap], ['merchant_fee_warn', warn]]) {
      const { rowCount } = await query(`UPDATE app_settings SET value=$1 WHERE key=$2`, [String(v), k]);
      if (rowCount === 0) await query(`INSERT INTO app_settings (key, value) VALUES ($2, $1)`, [String(v), k]);
    }
    _feeCache = { at: 0, cap, warn };   // bust cache
    res.json({ success: true, cap, warn, message: `Store hides at ₱${cap} owed; warns at ₱${warn}.` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;
