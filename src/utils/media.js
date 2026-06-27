/**
 * SugoNow — media.js
 * Stores uploaded images in PostgreSQL (the `media` table) instead of on disk,
 * so photos survive redeploys with no volume/bucket needed. Returns a servable
 * path like "/media/<uuid>" which the GET /media/:id route streams back.
 */
const crypto = require('crypto');
const { query } = require('../db/pool');

// Save raw bytes; returns "/media/<id>" or null.
async function saveMediaBuffer(buffer, mime = 'image/jpeg') {
  if (!buffer || !buffer.length) return null;
  const id = crypto.randomUUID();
  await query('INSERT INTO media (id, mime, data) VALUES ($1, $2, $3)', [id, mime, buffer]);
  return `/media/${id}`;
}

// Save a data-URL or bare base64 string; returns "/media/<id>" or null.
async function saveMediaBase64(input, fallbackMime = 'image/jpeg') {
  if (!input || typeof input !== 'string') return null;
  let mime = fallbackMime, b64 = input;
  const m = /^data:([^;]+);base64,(.+)$/s.exec(input);
  if (m) { mime = m[1]; b64 = m[2]; }
  else if (input.includes(',')) { b64 = input.split(',').pop(); }
  try { return await saveMediaBuffer(Buffer.from(b64, 'base64'), mime); }
  catch { return null; }
}

module.exports = { saveMediaBuffer, saveMediaBase64 };
