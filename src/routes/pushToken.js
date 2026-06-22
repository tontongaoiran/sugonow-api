/**
 * SugoNow — src/routes/pushToken.js
 *
 * Stores the Expo push token sent by the mobile app after login.
 * Mount in server.js:
 *   const pushTokenRoutes = require('./src/routes/pushToken');
 *   app.use('/api/v1/push-token', pushTokenRoutes);
 *
 * The app calls: PATCH /api/v1/push-token  { token: 'ExponentPushToken[...]' }
 */
const express = require('express');
const { query } = require('../db/pool');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

router.patch('/', authenticate, async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ success: false, message: 'Token required.' });
    await query('UPDATE users SET push_token=$1 WHERE id=$2', [token, req.user.id]);
    res.json({ success: true, message: 'Push token saved.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Clear token on logout (optional)
router.delete('/', authenticate, async (req, res) => {
  try {
    await query('UPDATE users SET push_token=NULL WHERE id=$1', [req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
