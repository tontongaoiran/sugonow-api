/**
 * SugoNow — errorLogService.js
 * Lightweight failure visibility: every swallowed/background error gets
 * console.error'd (shows in the server terminal) AND written to app_error_log
 * (admin-viewable). Logging must NEVER throw or block the caller.
 */
const { query } = require('../db/pool');

// Fire-and-forget: log a non-fatal error without blocking the caller.
async function logError(context, err, meta = {}) {
  const message = (err && err.message) ? err.message : String(err || 'unknown');
  // Always surface in the server console.
  console.error(`⚠️  [${context}] ${message}`);
  // Best-effort persist; if even this fails, swallow (we can't log the logger).
  try {
    await query(
      `INSERT INTO app_error_log (context, message, meta)
       VALUES ($1, $2, $3)`,
      [String(context).slice(0, 120), message.slice(0, 1000), JSON.stringify(meta || {}).slice(0, 2000)]
    );
  } catch (e) {
    console.error('   (error log persist failed:', e.message + ')');
  }
}

module.exports = { logError };
