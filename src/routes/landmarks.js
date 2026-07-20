/**
 * SugoNow — src/routes/landmarks.js
 *
 * Custom local destinations not well-covered by Google Maps.
 *   - Customers: search approved landmarks; suggest new ones (-> approval queue)
 *   - Admin: list/approve/reject/add/delete
 *
 * Mount: app.use('/api/v1/landmarks', require('./src/routes/landmarks'));
 */
const express = require('express');
const { query } = require('../db/pool');
const { zoneForPoint } = require('../services/locationService');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

const CATEGORIES = ['market','school','clinic','store','government','transport','other'];

// ── CUSTOMER: search approved landmarks (mixed into destination search) ──
// If lat/lng are provided, only landmarks inside the customer's active zone are
// returned (Flora users see Flora landmarks; Luna users see Luna — later).
router.get('/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    console.log(`[landmarks/search] q="${q}"`);
    const lat = req.query.lat != null ? parseFloat(req.query.lat) : null;
    const lng = req.query.lng != null ? parseFloat(req.query.lng) : null;

    let rows;
    if (q.length === 0) {
      ({ rows } = await query(
        `SELECT id, name, category, lat, lng, address_hint
         FROM landmarks WHERE status='approved'
         ORDER BY search_count DESC, name LIMIT 30`));
    } else {
      // Word-based, case-insensitive matching: split the query into words and
      // match a landmark if its name contains EVERY word (in any order). So
      // "rural health", "health rural", "joseph", or even one letter all work.
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      const conds = words.map((_, i) => `LOWER(name) LIKE $${i + 1}`).join(' AND ');
      const params = words.map(w => `%${w}%`);
      ({ rows } = await query(
        `SELECT id, name, category, lat, lng, address_hint
         FROM landmarks
         WHERE status='approved' AND (${conds})
         ORDER BY search_count DESC, name LIMIT 30`,
        params));
    }

    // Zone-scope as a SOFT preference, not a hard filter: landmarks inside the
    // customer's zone sort first, but we NEVER drop a matching place. Wrapped in
    // its own try/catch so a zone lookup error can never blank the results —
    // worst case we return the matches unsorted.
    if (lat != null && lng != null && rows.length > 1) {
      try {
        const zone = await zoneForPoint(lat, lng);
        if (zone) {
          const inZone = [], outZone = [];
          for (const r of rows) {
            let z = null;
            try { z = await zoneForPoint(parseFloat(r.lat), parseFloat(r.lng)); } catch {}
            (z && z.slug === zone.slug ? inZone : outZone).push(r);
          }
          rows = [...inZone, ...outZone];
        }
      } catch (e) {
        // Zone sorting failed — keep the matched rows as-is rather than losing them.
        console.error('[landmarks/search] zone sort skipped:', e.message);
      }
    }
    rows = rows.slice(0, q.length === 0 ? 8 : 12);

    console.log(`[landmarks/search] q="${q}" -> ${rows.length} result(s)`);
    res.json({ success: true, landmarks: rows, source: 'sugonow' });
  } catch (err) {
    console.error('[landmarks/search] ERROR:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── CUSTOMER: bump popularity when a landmark is chosen ──
router.post('/:id/pick', async (req, res) => {
  try {
    await query(`UPDATE landmarks SET search_count = search_count + 1 WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── CUSTOMER: suggest a new landmark (goes to approval queue) ──
router.post('/suggest', async (req, res) => {
  try {
    const { name, category, lat, lng, address_hint } = req.body;
    if (!name || lat == null || lng == null) {
      return res.status(400).json({ success: false, message: 'name, lat, lng required.' });
    }
    const cat = CATEGORIES.includes(category) ? category : 'other';
    await query(
      `INSERT INTO landmarks (name, category, lat, lng, address_hint, status, suggested_by)
       VALUES ($1,$2,$3,$4,$5,'pending',$6)`,
      [name.trim(), cat, lat, lng, address_hint || null, req.user.id]);
    res.json({ success: true, message: 'Thanks! Your suggestion will be reviewed by SugoNow.' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ════════ ADMIN ════════
// List (optionally by status)
router.get('/admin/list', requireRole('admin'), async (req, res) => {
  try {
    const status = req.query.status; // 'pending' | 'approved' | 'rejected' | undefined(all)
    const rows = status
      ? (await query(`SELECT l.*, u.full_name AS suggested_by_name, u.role AS suggested_by_role
                      FROM landmarks l LEFT JOIN users u ON u.id=l.suggested_by
                      WHERE l.status=$1 ORDER BY l.created_at DESC`, [status])).rows
      : (await query(`SELECT l.*, u.full_name AS suggested_by_name, u.role AS suggested_by_role
                      FROM landmarks l LEFT JOIN users u ON u.id=l.suggested_by
                      ORDER BY l.status, l.name`)).rows;
    res.json({ success: true, landmarks: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Admin add (auto-approved)
router.post('/admin/add', requireRole('admin'), async (req, res) => {
  try {
    const { name, category, lat, lng, address_hint } = req.body;
    if (!name || lat == null || lng == null) {
      return res.status(400).json({ success: false, message: 'name, lat, lng required.' });
    }
    const cat = CATEGORIES.includes(category) ? category : 'other';
    const { rows } = await query(
      `INSERT INTO landmarks (name, category, lat, lng, address_hint, status, approved_by)
       VALUES ($1,$2,$3,$4,$5,'approved',$6) RETURNING id`,
      [name.trim(), cat, lat, lng, address_hint || null, req.user.id]);
    res.json({ success: true, id: rows[0].id });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/admin/:id/approve', requireRole('admin'), async (req, res) => {
  try {
    await query(`UPDATE landmarks SET status='approved', approved_by=$1 WHERE id=$2`,
      [req.user.id, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/admin/:id/reject', requireRole('admin'), async (req, res) => {
  try {
    await query(`UPDATE landmarks SET status='rejected', approved_by=$1 WHERE id=$2`,
      [req.user.id, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Admin: rename / correct a landmark's name (and optionally category/hint) — fixes a
// misspelled place before customers ever see it. Works on pending OR approved landmarks.
router.post('/admin/:id/rename', requireRole('admin'), async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ success: false, message: 'name required.' });
    const cat  = (req.body.category || '').trim() || null;
    const hint = (req.body.address_hint || '').trim() || null;
    await query(
      `UPDATE landmarks SET name=$1,
              category=COALESCE($2, category),
              address_hint=COALESCE($3, address_hint)
        WHERE id=$4`,
      [name, cat, hint, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.delete('/admin/:id', requireRole('admin'), async (req, res) => {
  try {
    await query(`DELETE FROM landmarks WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── Reverse-resolve a coordinate to the nearest approved landmark name ──
// Returns a label like "near Flora National High School" when within ~250m,
// or the landmark name itself when very close (~80m). null if nothing near.
async function nearestLandmarkLabel(lat, lng, maxMeters = 250) {
  if (lat == null || lng == null) return null;
  const latF = parseFloat(lat), lngF = parseFloat(lng);
  if (Number.isNaN(latF) || Number.isNaN(lngF)) return null;
  // ~0.0025 deg ≈ 275m box prefilter (cheap), then exact distance in JS.
  const d = 0.0025;
  const { rows } = await query(
    `SELECT name, category, lat, lng, address_hint FROM landmarks
     WHERE status='approved'
       AND lat BETWEEN $1 AND $2 AND lng BETWEEN $3 AND $4`,
    [latF - d, latF + d, lngF - d, lngF + d]);
  if (!rows.length) return null;
  const R = 6371000;
  const toRad = (x) => x * Math.PI / 180;
  let best = null, bestM = Infinity;
  for (const r of rows) {
    const dLat = toRad(parseFloat(r.lat) - latF);
    const dLng = toRad(parseFloat(r.lng) - lngF);
    const a = Math.sin(dLat/2)**2 +
      Math.cos(toRad(latF)) * Math.cos(toRad(parseFloat(r.lat))) * Math.sin(dLng/2)**2;
    const m = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    if (m < bestM) { bestM = m; best = r; }
  }
  if (!best || bestM > maxMeters) return null;
  // Very close → use the name directly; nearby → "near <name>".
  return bestM <= 80 ? best.name : `near ${best.name}`;
}

module.exports = router;
module.exports.nearestLandmarkLabel = nearestLandmarkLabel;
