/**
 * SugoNow — src/services/smsService.js
 * Sends SMS via Semaphore API. In TEST_MODE, just logs to console.
 *
 * THREE send functions:
 *   sendSms(...)             → ALWAYS sends on the STANDARD route (1 credit).
 *                              Use for welcome texts, approvals, etc.
 *   sendPrioritySms(...)     → ALWAYS sends on the PRIORITY route (2 credits).
 *                              Bypasses Semaphore's shared queue and sends
 *                              immediately — use ONLY for OTP codes, so they
 *                              arrive in seconds instead of waiting in the queue.
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

// Same Semaphore host already in use — we only change the path (messages vs priority).
const SEMAPHORE_BASE = 'https://api.semaphore.co/api/v4';

// Core sender. priority=true uses the premium priority route (2 credits) that
// skips the queue and delivers immediately; priority=false uses the normal
// route (1 credit). Both ALWAYS attempt to send (not gated by NOTIFICATION_SMS).
const postSms = async (mobile, message, priority) => {
  if (TEST_MODE || !process.env.SEMAPHORE_API_KEY) {
    console.log(`📱 SMS [TEST${priority ? ' · PRIORITY' : ''}] to ${mobile}: ${message}`);
    return { success: true, test: true };
  }
  const url = `${SEMAPHORE_BASE}/${priority ? 'priority' : 'messages'}`;
  try {
    const res = await axios.post(url, {
      apikey:     process.env.SEMAPHORE_API_KEY,
      number:     mobile,
      message,
      sendername: process.env.SEMAPHORE_SENDER || 'SugoNow',
    });
    console.log(`  📨 Semaphore HTTP ${res.status} (${priority ? 'priority' : 'standard'}) — body:`, JSON.stringify(res.data));
    return res.data;
  } catch (err) {
    // Semaphore often returns the real reason in the RESPONSE BODY, not err.message.
    const body = err.response ? JSON.stringify(err.response.data) : '(no response body)';
    console.error('  ❌ SMS error:', err.message, '| status:', err.response?.status, '| body:', body);
    return { success: false, error: err.message, detail: err.response?.data };
  }
};

// ALWAYS sends on the standard route (1 credit). For welcome texts, approvals, etc.
const sendSms = (mobile, message) => postSms(mobile, message, false);

// ALWAYS sends on the PRIORITY route (2 credits, immediate). For OTP codes only.
const sendPrioritySms = (mobile, message) => postSms(mobile, message, true);

// Notification SMS — high-volume, push-duplicated events. Gated by the switch.
const sendNotificationSms = async (mobile, message) => {
  if (!NOTIFICATION_SMS_ON) {
    return { success: true, skipped: 'notification_sms_off' };
  }
  return sendSms(mobile, message);
};

module.exports = { sendSms, sendPrioritySms, sendNotificationSms };
