/**
 * SugoNow — src/routes/receipts.js
 *
 * Mount in server.js:
 *   const receiptRoutes = require('./src/routes/receipts');
 *   app.use('/api/v1/receipts', receiptRoutes);
 */
const express = require('express');
const { authenticate } = require('../middleware/auth');
const { getReceiptByBooking, getCustomerReceipts } = require('../services/receiptService');

const router = express.Router();
router.use(authenticate);

// GET /receipts            -> the logged-in customer's receipt history
router.get('/', async (req, res) => {
  try {
    const receipts = await getCustomerReceipts(req.user.id);
    res.json({ success: true, receipts });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /receipts/booking/:bookingId  -> receipt for one booking
router.get('/booking/:bookingId', async (req, res) => {
  try {
    const receipt = await getReceiptByBooking(req.params.bookingId);
    if (!receipt) return res.status(404).json({ success: false, message: 'No receipt yet.' });
    res.json({ success: true, receipt });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
