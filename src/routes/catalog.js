/**
 * SugoNow — src/routes/catalog.js
 *
 * Admin product catalog with flexible option groups + photos.
 * Customer-facing product fetch with full option data.
 *
 * Photo upload supports BOTH:
 *   - base64 image (from the admin's gallery/camera) -> saved to /uploads
 *   - a pasted image URL -> stored directly
 *
 * Mount in server.js:
 *   const catalogRoutes = require('./src/routes/catalog');
 *   app.use('/api/v1/catalog', catalogRoutes);
 */
const express = require('express');
const fs   = require('fs');
const path = require('path');
const { query } = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads', 'products');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Save a base64 image, return its public path. Returns null on failure.
function saveBase64Image(base64, hint = 'prod') {
  try {
    const m = base64.match(/^data:image\/(\w+);base64,(.+)$/);
    let ext = 'jpg', data = base64;
    if (m) { ext = m[1] === 'jpeg' ? 'jpg' : m[1]; data = m[2]; }
    const fname = `${hint}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, fname), Buffer.from(data, 'base64'));
    return `/uploads/products/${fname}`;
  } catch { return null; }
}

// Resolve incoming photo input (base64 OR url OR nothing) to a stored value
function resolvePhoto(photo_base64, photo_url) {
  if (photo_base64 && photo_base64.startsWith('data:image')) {
    return saveBase64Image(photo_base64);
  }
  if (photo_url && /^https?:\/\//i.test(photo_url)) return photo_url;
  return null;
}

// ════════ ADMIN ════════
router.use('/admin', authenticate, requireRole('admin'));

// Create a product (optionally with options + photo)
router.post('/admin/products', async (req, res) => {
  try {
    const {
      business_id, name, description, base_price,
      emoji, category, unit, has_options = false,
      photo_base64, photo_url, option_groups = [],
    } = req.body;
    if (!business_id || !name || base_price == null) {
      return res.status(400).json({ success: false, message: 'business_id, name, base_price required.' });
    }
    const photo = resolvePhoto(photo_base64, photo_url);

    const { rows } = await query(
      `INSERT INTO menu_items
         (business_id, name, description, price, emoji, category, unit,
          photo_url, has_options, available, stock)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE,100)
       RETURNING id`,
      [business_id, name, description || null, parseFloat(base_price),
       emoji || '🍽', category || 'General', unit || 'each',
       photo, !!has_options]
    );
    const productId = rows[0].id;

    // Insert option groups + choices
    if (has_options && Array.isArray(option_groups)) {
      for (let gi = 0; gi < option_groups.length; gi++) {
        const g = option_groups[gi];
        const { rows: gr } = await query(
          `INSERT INTO option_groups (product_id, name, select_type, required, sort_order)
           VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [productId, g.name, g.select_type === 'many' ? 'many' : 'one',
           g.required !== false, gi]
        );
        const groupId = gr[0].id;
        for (let ci = 0; ci < (g.choices || []).length; ci++) {
          const c = g.choices[ci];
          await query(
            `INSERT INTO option_choices (group_id, name, price_delta, sort_order)
             VALUES ($1,$2,$3,$4)`,
            [groupId, c.name, parseFloat(c.price_delta || 0), ci]
          );
        }
      }
    }
    res.status(201).json({ success: true, product_id: productId, photo_url: photo });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Edit a product's basic fields / photo / availability
router.patch('/admin/products/:id', async (req, res) => {
  try {
    const { name, description, base_price, available, photo_base64, photo_url } = req.body;
    const photo = resolvePhoto(photo_base64, photo_url);
    await query(
      `UPDATE menu_items SET
         name = COALESCE($1, name),
         description = COALESCE($2, description),
         price = COALESCE($3, price),
         available = COALESCE($4, available),
         photo_url = COALESCE($5, photo_url)
       WHERE id = $6`,
      [name ?? null, description ?? null,
       base_price != null ? parseFloat(base_price) : null,
       available, photo, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/admin/products/:id', async (req, res) => {
  try {
    await query('DELETE FROM menu_items WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// List a business's products (admin view, includes unavailable)
router.get('/admin/products/:businessId', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, name, description, price, emoji, photo_url, has_options, available
       FROM menu_items WHERE business_id=$1 ORDER BY sort_order, name`,
      [req.params.businessId]
    );
    res.json({ success: true, products: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ════════ CUSTOMER ════════
// Get a product with its full option groups + choices
router.get('/products/:id', authenticate, async (req, res) => {
  try {
    const { rows: p } = await query(
      `SELECT id, business_id, name, description, price, emoji, photo_url,
              has_options, available
       FROM menu_items WHERE id=$1`, [req.params.id]
    );
    if (!p[0]) return res.status(404).json({ success: false, message: 'Product not found.' });

    let groups = [];
    if (p[0].has_options) {
      const { rows: gr } = await query(
        `SELECT id, name, select_type, required, sort_order
         FROM option_groups WHERE product_id=$1 ORDER BY sort_order`, [req.params.id]
      );
      for (const g of gr) {
        const { rows: ch } = await query(
          `SELECT id, name, price_delta, available
           FROM option_choices WHERE group_id=$1 AND available=TRUE ORDER BY sort_order`, [g.id]
        );
        groups.push({ ...g, choices: ch });
      }
    }
    res.json({ success: true, product: p[0], option_groups: groups });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
