/**
 * SugoNow — src/services/pushNotificationService.js
 *
 * Sends push notifications via Expo's free push relay.
 * https://exp.host/--/api/v2/push/send
 *
 * No Firebase server key needed on the backend — Expo relays to FCM/APNs.
 * The mobile app registers its Expo push token via PATCH /auth/fcm-token,
 * which is stored in users.push_token. We look it up here and send.
 *
 * If a user has no token yet (foreground-only mode), this silently no-ops,
 * so it is safe to call even before Firebase is fully set up.
 */
const axios = require('axios');
const { query } = require('../db/pool');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/**
 * Send a push notification to a user by their stored Expo token.
 * @param {string} userId
 * @param {string} title
 * @param {string} body
 * @param {object} data  - extra payload (type, bookingId, etc.)
 */
async function sendPush(userId, title, body, data = {}) {
  try {
    const { rows } = await query('SELECT push_token FROM users WHERE id=$1', [userId]);
    const token = rows[0]?.push_token;
    if (!token) { console.log(`[PUSH] NO TOKEN for ${userId?.slice(0,8)} — push not sent (this user never registered)`); return { sent: false, reason: 'no_token' }; }
    console.log(`[PUSH] sending to ${userId?.slice(0,8)}: "${title}"`);

    // Expo tokens look like ExponentPushToken[xxxx]
    if (!token.startsWith('ExponentPushToken') && !token.startsWith('ExpoPushToken')) {
      return { sent: false, reason: 'invalid_token' };
    }

    const message = {
      to: token,
      sound: 'default',
      title,
      body,
      data,
      priority: 'high',
      channelId: data.type === 'progress' ? 'sugonow-progress' : 'sugonow-rides',
    };

    const res = await axios.post(EXPO_PUSH_URL, message, {
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      timeout: 8000,
    });

    return { sent: true, receipt: res.data };
  } catch (err) {
    // Never let a push failure break the booking flow
    console.log(`push to ${userId?.slice(0,8)} failed: ${err.message}`);
    return { sent: false, reason: err.message };
  }
}

/**
 * Send the same notification to multiple users (e.g. broadcast).
 */
async function sendPushMany(userIds, title, body, data = {}) {
  const results = await Promise.allSettled(
    userIds.map(id => sendPush(id, title, body, data))
  );
  return results;
}

module.exports = { sendPush, sendPushMany };
