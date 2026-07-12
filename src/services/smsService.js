/**
 * SugoNow — src/services/smsService.js
 * Sends SMS via Semaphore API. In TEST_MODE, just logs to console.
 *
 * TWO send functions:
 *   sendSms(...)             → ALWAYS sends (essential: OTP, approvals).
 *   sendNotificationSms(...) → only sends when NOTIFICATION_SMS is on
 *                              (high-volume booking/price events; push already
 *                               covers these, so this saves Semaphore credits).
 * Set NOTIFICATION_SMS=false in .env to silence notification SMS (OTP and
 * approvals still send). Default: OFF (false) — safest for credits.
 */
const axios = require('axios');

const TEST_MODE = process.env.TEST_MODE === 'true';
// Notification SMS default OFF unless explicitly enabled.
const NOTIFICATION_SMS_ON = process.env.NOTIFICATION_SMS === 'true';

const sendSms = async (mobile, message) => {
  if (TEST_MODE || !process.env.SEMAPHORE_API_KEY) {
    console.log(`📱 SMS [TEST] to ${mobile}: ${message}`);
    return { success: true, test: true };
  }
  try {
    const res = await axios.post('https://api.semaphore.co/api/v4/priority', {
      apikey:    process.env.SEMAPHORE_API_KEY,
      number:    mobile,
      message,
      sendername: process.env.SEMAPHORE_SENDER || 'SugoNow',
    });
    console.log('  📨 Semaphore HTTP', res.status, '— body:', JSON.stringify(res.data));
    return res.data;
  } catch (err) {
    // Semaphore often returns the real reason in the RESPONSE BODY, not err.message.
    const body = err.response ? JSON.stringify(err.response.data) : '(no response body)';
    console.error('  ❌ SMS error:', err.message, '| status:', err.response?.status, '| body:', body);
    return { success: false, error: err.message, detail: err.response?.data };
  }
};

// Notification SMS — high-volume, push-duplicated events. Gated by the switch.
const sendNotificationSms = async (mobile, message) => {
  if (!NOTIFICATION_SMS_ON) {
    return { success: true, skipped: 'notification_sms_off' };
  }
  return sendSms(mobile, message);
};

module.exports = { sendSms, sendNotificationSms };
