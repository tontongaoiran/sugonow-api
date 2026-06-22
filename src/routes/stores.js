/**
 * SugoNow — src/routes/stores.js (subscription-aware)
 *
 * Customer-facing store browsing.
 * ONLY shows businesses with an active, non-expired subscription.
 */
const express = require('express');
const { query } = require('../db/pool');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// ─── GET /stores/:category/compare — stores + price comparison by category ───
// Works for LPG ('/stores/lpg/compare') and water ('/stores/water/compare'),
// or any category. Returns: { stores:[{...store, products:[...]}], compare:[...] }
router.get('/:category/compare', async (req, res) => {
  try {
    const { zone = 'flora' } = req.query;
    // Category comes from the URL (lpg, water, ...). Whitelist to be safe.
    const ALLOWED = ['lpg', 'water'];
    const category = ALLOWED.includes(req.params.category) ? req.params.category : 'lpg';

    // All active stores of this category in the zone
    const { rows: stores } = await query(
      `SELECT b.id, b.name, b.address, b.lat, b.lng, b.is_open, b.delivery_fee,
              b.closed_until, b.closed_note,
              (COALESCE(b.is_open, TRUE) = FALSE
               AND (b.closed_until IS NULL OR b.closed_until >= CURRENT_DATE)) AS is_closed,
              (b.is_featured = TRUE AND (b.featured_paid_until IS NULL OR b.featured_paid_until >= CURRENT_DATE)) AS is_featured
       FROM businesses b
       JOIN zones z ON z.id = b.zone_id
       WHERE b.is_active = TRUE AND z.slug = $1
         AND b.category = $2
         AND b.merchant_status = 'approved'
         AND COALESCE(b.hidden, FALSE) = FALSE
         AND COALESCE(b.fee_owed, 0) < COALESCE((SELECT COALESCE(NULLIF(value,'')::numeric, 500) FROM app_settings WHERE key='merchant_fee_cap' LIMIT 1), 500)
         AND NOT EXISTS (SELECT 1 FROM users ou WHERE ou.id = b.owner_id AND ou.deleted_at IS NOT NULL)
       ORDER BY is_featured DESC, b.name`,
      [zone, category]
    );

    if (stores.length === 0) {
      return res.json({ success: true, stores: [], compare: [] });
    }

    const ids = stores.map(s => s.id);
    const { rows: products } = await query(
      `SELECT id, business_id, name, price, emoji, unit, stock, brand, weight_kg
       FROM menu_items
       WHERE business_id = ANY($1::uuid[]) AND stock > 0
       ORDER BY weight_kg NULLS LAST, brand NULLS LAST, name, price`,
      [ids]
    );

    // Attach products to each store
    const storeMap = Object.fromEntries(stores.map(s => [s.id, { ...s, products: [] }]));
    products.forEach(p => { storeMap[p.business_id]?.products.push(p); });

    // Build comparison: group by normalized product name → list each store's price
    const compareMap = {};
    products.forEach(p => {
      // Group by brand + weight when present (LPG), else by product name.
      const hasBW = p.brand || p.weight_kg;
      const label = hasBW
        ? `${p.brand || 'LPG'}${p.weight_kg ? ' ' + parseFloat(p.weight_kg) + 'kg' : ''}`
        : p.name;
      const key = label.trim().toLowerCase();
      if (!compareMap[key]) compareMap[key] = {
        product: label, emoji: p.emoji,
        brand: p.brand || null, weight_kg: p.weight_kg ? parseFloat(p.weight_kg) : null,
        options: [] };
      const store = storeMap[p.business_id];
      compareMap[key].options.push({
        store_id: p.business_id, store_name: store?.name,
        price: parseFloat(p.price), product_id: p.id,
      });
    });
    // Sort each product's options by price (cheapest first) + tag lowest
    const compare = Object.values(compareMap).map(c => {
      c.options.sort((a, b) => a.price - b.price);
      c.lowest = c.options[0]?.price ?? null;
      c.highest = c.options[c.options.length - 1]?.price ?? null;
      return c;
    });

    res.json({ success: true, stores: Object.values(storeMap), compare });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /stores — list visible (subscribed) stores ──────────────────────────
router.get('/', async (req, res) => {
  try {
    const { zone = 'flora', category } = req.query;

    // A store is visible only if subscription active AND not expired
    let sql = `
      SELECT b.id, b.name, b.category, b.address, b.lat, b.lng,
             b.is_open, b.delivery_fee, b.store_hours, b.banner_url,
             b.banner_url AS photo_url,
             b.closed_until, b.closed_note,
             -- closed = merchant toggled off AND reopen date hasn't passed
             (COALESCE(b.is_open, TRUE) = FALSE
              AND (b.closed_until IS NULL OR b.closed_until >= CURRENT_DATE)) AS is_closed,
             (b.is_featured = TRUE AND (b.featured_paid_until IS NULL OR b.featured_paid_until >= CURRENT_DATE)) AS is_featured,
             COUNT(mi.id)::int AS product_count
      FROM businesses b
      LEFT JOIN menu_items mi ON mi.business_id = b.id
      JOIN zones z ON z.id = b.zone_id
      WHERE b.is_active = TRUE
        AND z.slug = $1
        AND b.merchant_status = 'approved'
        AND COALESCE(b.hidden, FALSE) = FALSE
        -- fee discipline: stores owing >= the cap are hidden until settled
        AND COALESCE(b.fee_owed, 0) < COALESCE((SELECT COALESCE(NULLIF(value,'')::numeric, 500) FROM app_settings WHERE key='merchant_fee_cap' LIMIT 1), 500)
        AND NOT EXISTS (SELECT 1 FROM users ou WHERE ou.id = b.owner_id AND ou.deleted_at IS NOT NULL)`;
    const params = [zone];
    if (category && category !== 'all') {
      // Accept a single category OR a comma-separated group (e.g. "food,bakery").
      const cats = String(category).split(',').map(c => c.trim()).filter(Boolean);
      if (cats.length === 1) {
        params.push(cats[0]);
        sql += ` AND b.category = $${params.length}`;
      } else if (cats.length > 1) {
        params.push(cats);
        sql += ` AND b.category = ANY($${params.length}::text[])`;
      }
    }
    sql += ` GROUP BY b.id ORDER BY is_featured DESC, b.name`;

    const { rows } = await query(sql, params);
    res.json({ success: true, stores: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});



// ─── GET /stores/search?q= — find stores by NAME or by what they SELL ────────
// "pancit" finds every store with pancit on the menu, with the matched items
// shown so the customer knows why the store appeared.
router.get('/search', authenticate, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ success: true, stores: [] });
    const cats = String(req.query.category || 'food,bakery').split(',').map(c => c.trim());
    const { rows } = await query(
      `SELECT b.id, b.name, b.address, b.category, b.lat, b.lng,
              b.banner_url, b.banner_url AS photo_url,
              (b.is_featured = TRUE AND (b.featured_paid_until IS NULL
               OR b.featured_paid_until >= CURRENT_DATE)) AS is_featured,
              b.delivery_fee, b.is_open, b.closed_until, b.closed_note,
              (COALESCE(b.is_open, TRUE) = FALSE
               AND (b.closed_until IS NULL OR b.closed_until >= CURRENT_DATE)) AS is_closed,
              (SELECT ARRAY(
                 SELECT mi.name FROM menu_items mi
                 WHERE mi.business_id = b.id AND mi.available = TRUE
                   AND mi.name ILIKE '%' || $1 || '%' LIMIT 3
               )) AS matched_products
       FROM businesses b
       WHERE b.is_active = TRUE
         AND b.category = ANY($2)
         AND b.merchant_status = 'approved'
         AND COALESCE(b.hidden, FALSE) = FALSE
         AND COALESCE(b.fee_owed, 0) < COALESCE((SELECT COALESCE(NULLIF(value,'')::numeric, 500) FROM app_settings WHERE key='merchant_fee_cap' LIMIT 1), 500)
         AND NOT EXISTS (SELECT 1 FROM users ou WHERE ou.id = b.owner_id AND ou.deleted_at IS NOT NULL)
         AND (b.name ILIKE '%' || $1 || '%'
              OR EXISTS (SELECT 1 FROM menu_items mi
                         WHERE mi.business_id = b.id AND mi.available = TRUE
                           AND mi.name ILIKE '%' || $1 || '%'))
       ORDER BY b.is_featured DESC, b.name
       LIMIT 25`,
      [q, cats]);
    res.json({ success: true, stores: rows });
  } catch (err) {
    console.error('store search error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /stores/:id — store details + products ──────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const { rows: store } = await query(
      `SELECT id, name, category, address, lat, lng, is_open,
              delivery_fee, store_hours, subscription_status, subscription_expires,
              banner_url, banner_url AS photo_url, closed_until, closed_note, merchant_status,
              (COALESCE(is_open, TRUE) = FALSE
               AND (closed_until IS NULL OR closed_until >= CURRENT_DATE)) AS is_closed,
              COALESCE(hidden, FALSE) AS hidden,
              (COALESCE(fee_owed, 0) >= COALESCE((SELECT COALESCE(NULLIF(value,'')::numeric, 500) FROM app_settings WHERE key='merchant_fee_cap' LIMIT 1), 500)) AS locked_for_fees,
              EXISTS (SELECT 1 FROM users ou WHERE ou.id = b.owner_id AND ou.deleted_at IS NOT NULL) AS owner_deleted
       FROM businesses b WHERE b.id=$1`,
      [req.params.id]
    );
    if (!store[0]) return res.status(404).json({ success: false, message: 'Store not found.' });

    // Block if not yet approved, suspended, manually hidden, fee-locked, or the
    // owner's account was deleted (matches the list endpoints' guard, so a direct
    // link can't reach a store that's correctly hidden everywhere else).
    if (store[0].merchant_status !== 'approved' || store[0].subscription_status === 'suspended'
        || store[0].hidden === true || store[0].locked_for_fees === true
        || store[0].owner_deleted === true) {
      return res.status(403).json({ success: false, message: 'This store is currently unavailable.' });
    }

    const { rows: products } = await query(
      `SELECT id, name, description, price, emoji, category, unit, stock,
              photo_url, has_options
       FROM menu_items
       WHERE business_id=$1 AND stock > 0 AND COALESCE(available, TRUE) = TRUE
       ORDER BY category, name`,
      [req.params.id]
    );
    res.json({ success: true, store: store[0], products });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /stores/:id/order — place a food/store order ───────────────────────
router.post('/:id/order', authenticate, async (req, res) => {
  try {
    const { items, delivery_address, delivery_lat, delivery_lng, payment_method = 'cash' } = req.body;
    if (!items || items.length === 0) {
      return res.status(400).json({ success: false, message: 'Cart is empty.' });
    }
    const { rows: store } = await query(
      `SELECT name, delivery_fee, lat, lng, zone_id, closed_until, closed_note,
              (COALESCE(fee_owed, 0) >= COALESCE((SELECT COALESCE(NULLIF(value,'')::numeric, 500) FROM app_settings WHERE key='merchant_fee_cap' LIMIT 1), 500)) AS locked_for_fees,
              (COALESCE(is_open, TRUE) = FALSE
               AND (closed_until IS NULL OR closed_until >= CURRENT_DATE)) AS is_closed
       FROM businesses WHERE id=$1`,
      [req.params.id]
    );
    if (!store[0]) return res.status(404).json({ success: false, message: 'Store not found.' });
    if (store[0].locked_for_fees) {
      return res.status(403).json({ success: false,
        message: `${store[0].name} is temporarily unavailable. Please try another store.` });
    }
    if (store[0].is_closed) {
      const when = store[0].closed_until
        ? ` They plan to reopen on ${new Date(store[0].closed_until).toLocaleDateString('en-PH', { month: 'long', day: 'numeric' })}.`
        : '';
      return res.status(403).json({ success: false, store_closed: true,
        message: `${store[0].name} is temporarily closed.${when}` +
                 (store[0].closed_note ? ` Note from the store: "${store[0].closed_note}"` : '') });
    }
    if (store[0].lat == null || store[0].lng == null) {
      return res.status(400).json({ success: false,
        message: 'This store has not set its location yet, so we can\'t dispatch a driver. Please try another store.' });
    }

    const itemsTotal = items.reduce((s, it) => s + (parseFloat(it.price) * it.quantity), 0);
    const deliveryFee = parseFloat(store[0].delivery_fee ?? 30);
    const total = itemsTotal + deliveryFee;

    const { rows } = await query(
      `INSERT INTO bookings
         (customer_id, zone_id, service_type, status,
          pickup_lat, pickup_lng, pickup_address,
          dropoff_lat, dropoff_lng, dropoff_address,
          estimated_fare, payment_method, custom_note)
       VALUES ($1,$2,'delivery','pending',$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id`,
      [req.user.id, store[0].zone_id,
       store[0].lat, store[0].lng, store[0].name,
       delivery_lat, delivery_lng, delivery_address || 'Delivery location',
       total, payment_method,
       `ORDER from ${store[0].name}: ` +
         items.map(i => `${i.quantity}x ${i.name}`).join(', ')]
    );

    res.status(201).json({
      success: true, booking_id: rows[0].id,
      order_summary: {
        store: store[0].name,
        items_total: `₱${itemsTotal.toFixed(2)}`,
        delivery_fee: `₱${deliveryFee.toFixed(2)}`,
        total: `₱${total.toFixed(2)}`,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
