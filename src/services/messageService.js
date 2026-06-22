/**
 * SugoNow — src/services/messageService.js
 * In-app inbox messages (report updates, suspensions, bonuses, general).
 */
const { query } = require('../db/pool');

async function sendMessage(userId, title, body, category = 'general') {
  await query(
    `INSERT INTO user_messages (user_id, title, body, category)
     VALUES ($1,$2,$3,$4)`,
    [userId, title, body, category]
  );
}

// Send to many users at once
async function broadcast(userIds, title, body, category = 'general') {
  for (const uid of userIds) {
    await sendMessage(uid, title, body, category);
  }
}

async function getMessages(userId) {
  const { rows } = await query(
    `SELECT id, title, body, category, read, created_at
     FROM user_messages WHERE user_id=$1
     ORDER BY created_at DESC LIMIT 50`, [userId]);
  return rows;
}

async function unreadCount(userId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM user_messages WHERE user_id=$1 AND read=FALSE`,
    [userId]);
  return rows[0].n;
}

async function markRead(userId, messageId) {
  await query(`UPDATE user_messages SET read=TRUE WHERE id=$1 AND user_id=$2`,
    [messageId, userId]);
}

async function markAllRead(userId) {
  await query(`UPDATE user_messages SET read=TRUE WHERE user_id=$1`, [userId]);
}

module.exports = { sendMessage, broadcast, getMessages, unreadCount, markRead, markAllRead };
