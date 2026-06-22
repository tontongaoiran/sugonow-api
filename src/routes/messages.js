/**
 * SugoNow — src/routes/messages.js
 *
 * In-app inbox for customers & drivers, plus admin send.
 * Mount: app.use('/api/v1/messages', require('./src/routes/messages'));
 */
const express = require('express');
const { query } = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');
const M = require('../services/messageService');

const router = express.Router();
router.use(authenticate);

// ── ANY USER: my inbox ──
router.get('/', async (req, res) => {
  try {
    const messages = await M.getMessages(req.user.id);
    const unread = await M.unreadCount(req.user.id);
    res.json({ success: true, messages, unread });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get('/unread-count', async (req, res) => {
  try { res.json({ success: true, unread: await M.unreadCount(req.user.id) }); }
  catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/:id/read', async (req, res) => {
  try { await M.markRead(req.user.id, req.params.id); res.json({ success: true }); }
  catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/read-all', async (req, res) => {
  try { await M.markAllRead(req.user.id); res.json({ success: true }); }
  catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── ADMIN: send a message to a specific user ──
router.post('/admin/send', requireRole('admin'), async (req, res) => {
  try {
    const { user_id, title, body, category } = req.body;
    if (!user_id || !title || !body) {
      return res.status(400).json({ success: false, message: 'user_id, title, body required.' });
    }
    await M.sendMessage(user_id, title, body, category || 'general');
    res.json({ success: true, message: 'Message sent.' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── ADMIN: broadcast to a role (all customers or all drivers) ──
router.post('/admin/broadcast', requireRole('admin'), async (req, res) => {
  try {
    const { role, title, body, category } = req.body;
    if (!role || !title || !body) {
      return res.status(400).json({ success: false, message: 'role, title, body required.' });
    }
    const { rows } = await query(
      `SELECT id FROM users WHERE role=$1 AND deleted_at IS NULL`, [role]);
    await M.broadcast(rows.map(r => r.id), title, body, category || 'general');
    res.json({ success: true, message: `Sent to ${rows.length} ${role}(s).` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;
