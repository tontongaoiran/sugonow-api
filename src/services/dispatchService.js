/**
 * SugoNow — src/services/dispatchService.js
 *
 * Handles driver dispatch in small BATCHES with fallback:
 * - Notifies the nearest 3 available drivers at once
 * - If none respond in 20s, marks them expired and notifies the next 3 nearest
 * - First driver to accept wins (atomic lock in the accept route); the rest get
 *   "no longer available"
 * - For product orders, prioritizes drivers nearest to the STORE
 * - Skips locked / suspended / zero-wallet drivers
 */
const { query } = require('../db/pool');
const { logError } = require('./errorLogService');
const { sendSms, sendNotificationSms } = require('./smsService');
const { sendPush } = require('./pushNotificationService');

const DISPATCH_TIMEOUT_SEC = 30;   // fallback; live value from app_settings.dispatch_timeout_sec
const DISPATCH_BATCH_SIZE  = 3;    // drivers notified per batch

// ── Admin-tunable timings (cached 30s) ──────────────────────────────────────
// dispatch_timeout_sec: seconds a batch has to accept before rolling over (def 30)
// pending_expiry_min:   minutes a booking keeps searching before it gives up (def 3)
let _dtCache = { v: 30, t: 0 };
async function getDispatchTimeoutSec() {
  if (Date.now() - _dtCache.t < 30000) return _dtCache.v;
  try {
    const { rows } = await query(`SELECT value FROM app_settings WHERE key='dispatch_timeout_sec' LIMIT 1`);
    const v = rows.length && parseFloat(rows[0].value) > 0 ? parseFloat(rows[0].value) : 30;
    _dtCache = { v, t: Date.now() }; return v;
  } catch { return 30; }
}
async function getGiveUpMin() {
  try {
    const { rows } = await query(`SELECT value FROM app_settings WHERE key='pending_expiry_min' LIMIT 1`);
    const v = rows.length && parseFloat(rows[0].value) >= 0 ? parseFloat(rows[0].value) : 3;
    return v;  // 0 = never give up
  } catch { return 3; }
}

/**
 * Get ordered list of eligible drivers nearest to a point.
 * originLat/originLng = customer pickup (for rides) OR store (for orders)
 */
const getNearestDrivers = async (zoneId, originLat, originLng, limit = 10, eligibleVehicle = 'any') => {
  // Only notify drivers whose ACTIVE vehicle matches the booking's eligibility.
  // 'any' = no restriction. Whitelist the class so we never interpolate raw input.
  const VALID_CLASS = { motorcycle: 'motorcycle', tricycle: 'tricycle', car: 'car' };
  const cls = VALID_CLASS[String(eligibleVehicle || '').trim().toLowerCase()];
  const vehicleFilter = cls
    ? `AND TRIM(LOWER(COALESCE(dp.vehicle_type, 'tricycle'))) = '${cls}'`
    : '';
  const { rows } = await query(
    `SELECT u.id, u.mobile, u.full_name,
            dp.current_lat, dp.current_lng,
            dp.is_locked, dp.commission_owed,
            (POWER(dp.current_lat - $2, 2) + POWER(dp.current_lng - $3, 2)) AS dist_sq
     FROM driver_profiles dp
     JOIN users u ON u.id = dp.user_id
     WHERE dp.is_online = TRUE
       AND dp.status = 'verified'
       AND dp.is_locked = FALSE
       AND COALESCE(dp.suspended, FALSE) = FALSE
       AND u.deleted_at IS NULL
       AND COALESCE(u.banned, FALSE) = FALSE
       AND COALESCE(dp.wallet_balance, 0) > 0
       AND dp.current_lat IS NOT NULL
       AND u.zone_id = $1
       ${vehicleFilter}
     ORDER BY dist_sq ASC
     LIMIT $4`,
    [zoneId, originLat, originLng, limit]
  );
  return rows;
};

/**
 * Notify a single driver and record the dispatch attempt
 */
const notifyDriver = async (booking, driver, serviceLabel) => {
  const secs = await getDispatchTimeoutSec();
  await query(
    `INSERT INTO dispatch_attempts (booking_id, driver_id, status)
     VALUES ($1, $2, 'notified')`,
    [booking.id, driver.id]
  );
  sendNotificationSms(driver.mobile,
    `SugoNow: New ${serviceLabel}! ₱${booking.estimated_fare}. ` +
    `You have ${secs} seconds to accept in the app.`
  ).catch(() => {});
  sendPush(driver.id, `🛺 New ${serviceLabel}!`,
    `₱${booking.estimated_fare} · ${secs} seconds to accept`,
    { type: 'new_booking', bookingId: booking.id }
  ).catch(() => {});
  console.log(`  📨 Notified ${driver.full_name} for booking ${booking.id.slice(0,8)}`);
};

/**
 * Start dispatch for a booking - notify first nearest driver
 */
const startDispatch = async (booking, zoneId, originLat, originLng, serviceLabel = 'booking') => {
  const drivers = await getNearestDrivers(zoneId, originLat, originLng, 10, booking.eligible_vehicle || 'any');
  if (drivers.length === 0) {
    // No drivers online right now — flag the booking so the revive loop will
    // notify the next driver who comes online (instead of it sitting silent).
    await query(`UPDATE bookings SET dispatch_exhausted=TRUE WHERE id=$1 AND status='pending'`,
      [booking.id]).catch(() => {});
    console.log('  ⚠️ No available drivers — flagged for revive when one comes online');
    return { dispatched: false, message: 'No drivers available right now.' };
  }
  // Notify the nearest batch (up to DISPATCH_BATCH_SIZE) at once
  const batch = drivers.slice(0, DISPATCH_BATCH_SIZE);
  for (const d of batch) {
    await notifyDriver(booking, d, serviceLabel);
  }
  console.log(`  📨 Notified batch of ${batch.length} for booking ${booking.id.slice(0,8)}`);
  return { dispatched: true, driver: batch[0], batch_size: batch.length };
};

/**
 * Check for expired dispatches and roll over to the next BATCH of drivers.
 * Called periodically by a background interval.
 *
 * Batch logic: expire any attempt older than the timeout. Then, for each
 * still-pending booking that has NO outstanding "notified" attempts left,
 * notify the next batch of nearest drivers who haven't been tried yet. This
 * keeps the "first to accept wins" lock intact while moving in groups of 3.
 */
const processExpiredDispatches = async () => {
  const secs = await getDispatchTimeoutSec();
  const giveUpMin = await getGiveUpMin();
  // 1. Expire any attempts past the timeout
  const { rows: expired } = await query(
    `UPDATE dispatch_attempts SET status='expired', responded_at=NOW()
     WHERE status='notified'
       AND notified_at < NOW() - INTERVAL '${Number(secs)} seconds'
     RETURNING booking_id`
  );
  if (expired.length === 0) return 0;

  // 2. Unique bookings affected
  const bookingIds = [...new Set(expired.map(e => e.booking_id))];

  for (const bookingId of bookingIds) {
    // Only roll over if the booking is still pending AND has no driver yet AND
    // there are no still-"notified" attempts outstanding (i.e. the whole current
    // batch has expired — we don't want to pile on while some are still live).
    const { rows: bk } = await query(
      `SELECT b.id, b.zone_id, b.pickup_lat, b.pickup_lng, b.estimated_fare, b.service_type,
              COALESCE(b.eligible_vehicle, 'any') AS eligible_vehicle,
              (SELECT COUNT(*) FROM dispatch_attempts
                 WHERE booking_id=b.id AND status='notified') AS still_notified
       FROM bookings b
       WHERE b.id=$1 AND b.status='pending' AND b.driver_id IS NULL`,
      [bookingId]
    );
    if (!bk[0] || parseInt(bk[0].still_notified) > 0) continue;

    // 3. Find the next batch of nearest untried drivers
    const { rows: nextDrivers } = await query(
      `SELECT u.id, u.mobile, u.full_name, dp.current_lat, dp.current_lng
       FROM driver_profiles dp
       JOIN users u ON u.id = dp.user_id
       WHERE dp.is_online=TRUE AND dp.status='verified'
         AND dp.is_locked=FALSE AND dp.current_lat IS NOT NULL
         AND COALESCE(dp.suspended, FALSE) = FALSE
         AND u.deleted_at IS NULL
       AND COALESCE(u.banned, FALSE) = FALSE
         AND COALESCE(dp.wallet_balance, 0) > 0
         AND u.zone_id=$1
         AND u.id NOT IN (
           SELECT driver_id FROM dispatch_attempts WHERE booking_id=$2
         )
         AND ($5 = 'any' OR TRIM(LOWER(COALESCE(dp.vehicle_type,'tricycle'))) = TRIM(LOWER($5)))
       ORDER BY (POWER(dp.current_lat-$3,2)+POWER(dp.current_lng-$4,2)) ASC
       LIMIT ${DISPATCH_BATCH_SIZE}`,
      [bk[0].zone_id, bk[0].id, bk[0].pickup_lat, bk[0].pickup_lng, bk[0].eligible_vehicle]
    );

    if (nextDrivers.length > 0) {
      const label = bk[0].service_type === 'delivery' ? 'delivery order' : 'ride';
      for (const d of nextDrivers) {
        await notifyDriver(
          { id: bk[0].id, estimated_fare: bk[0].estimated_fare },
          d, label
        );
      }
      console.log(`  🔄 Rolled booking ${bk[0].id.slice(0,8)} to next batch of ${nextDrivers.length}`);
    } else {
      // Every online driver in range has already been tried this round. As long as
      // the booking is still inside the give-up window, DON'T give up — start a
      // fresh round: clear its attempts so all online drivers become "untried"
      // again and re-notify the nearest batch. This keeps re-pinging every cycle.
      const { rows: onlineCnt } = await query(
        `SELECT COUNT(*)::int AS n FROM driver_profiles dp
           JOIN users u ON u.id=dp.user_id
          WHERE dp.is_online=TRUE AND dp.status='verified' AND dp.is_locked=FALSE
            AND dp.current_lat IS NOT NULL AND COALESCE(dp.suspended,FALSE)=FALSE
            AND u.deleted_at IS NULL AND COALESCE(u.banned,FALSE)=FALSE
            AND COALESCE(dp.wallet_balance,0)>0 AND u.zone_id=$1`, [bk[0].zone_id]);
      const withinWindow = (!(giveUpMin > 0)) ||
        (await query(`SELECT (created_at > NOW() - ($1||' minutes')::interval) AS ok
                      FROM bookings WHERE id=$2`, [String(giveUpMin), bk[0].id])).rows[0]?.ok;
      if (parseInt(onlineCnt[0].n) > 0 && withinWindow) {
        // Fresh round: wipe attempts, re-notify nearest batch, keep the flag OFF.
        await query(`DELETE FROM dispatch_attempts WHERE booking_id=$1`, [bk[0].id]);
        const { rows: freshBatch } = await query(
          `SELECT u.id, u.mobile, u.full_name FROM driver_profiles dp
             JOIN users u ON u.id=dp.user_id
            WHERE dp.is_online=TRUE AND dp.status='verified' AND dp.is_locked=FALSE
              AND dp.current_lat IS NOT NULL AND COALESCE(dp.suspended,FALSE)=FALSE
              AND u.deleted_at IS NULL AND COALESCE(u.banned,FALSE)=FALSE
              AND COALESCE(dp.wallet_balance,0)>0 AND u.zone_id=$1
              AND ($4='any' OR TRIM(LOWER(COALESCE(dp.vehicle_type,'tricycle')))=TRIM(LOWER($4)))
            ORDER BY (POWER(dp.current_lat-$2,2)+POWER(dp.current_lng-$3,2)) ASC
            LIMIT ${DISPATCH_BATCH_SIZE}`,
          [bk[0].zone_id, bk[0].pickup_lat, bk[0].pickup_lng, bk[0].eligible_vehicle]);
        const label = bk[0].service_type === 'delivery' ? 'delivery order' : 'ride';
        // Race guard: a driver may have accepted while we were querying above.
        const { rows: sp } = await query(
          `SELECT 1 FROM bookings WHERE id=$1 AND status='pending' AND driver_id IS NULL`, [bk[0].id]);
        if (!sp[0]) continue;   // already taken — do not re-ping
        for (const d of freshBatch) await notifyDriver({ id: bk[0].id, estimated_fare: bk[0].estimated_fare }, d, label);
        await query(`UPDATE bookings SET dispatch_exhausted=FALSE WHERE id=$1`, [bk[0].id]).catch(() => {});
        console.log(`  🔁 Re-pinged ${freshBatch.length} online driver(s) for booking ${bk[0].id.slice(0,8)} (fresh round)`);
      } else {
        // Truly nobody online (or past the give-up window) — flag so the revive
        // loop pings the next driver who comes online.
        await query(
          `UPDATE bookings SET dispatch_exhausted=TRUE WHERE id=$1 AND status='pending'`,
          [bk[0].id]
        ).catch(() => {});
        console.log(`  ⏳ No online drivers for booking ${bk[0].id.slice(0,8)} (waiting for one to come online)`);
      }
    }
  }
  return expired.length;
};

/**
 * Retry bookings that previously ran out of drivers, in case a driver has since
 * come online. Notifies a fresh batch and clears the exhausted flag.
 */
const retryExhaustedBookings = async () => {
  const giveUpMin = await getGiveUpMin();
  const windowClause = giveUpMin > 0
    ? `AND created_at > NOW() - INTERVAL '${Number(giveUpMin)} minutes'`
    : '';   // 0 = keep trying indefinitely
  const { rows: stuck } = await query(
    `SELECT id, zone_id, pickup_lat, pickup_lng, estimated_fare, service_type,
            COALESCE(eligible_vehicle, 'any') AS eligible_vehicle
     FROM bookings
     WHERE status='pending' AND driver_id IS NULL
       AND dispatch_exhausted=TRUE
       ${windowClause}`
  );
  for (const b of stuck) {
    const { rows: nextDrivers } = await query(
      `SELECT u.id, u.mobile, u.full_name, dp.current_lat, dp.current_lng
       FROM driver_profiles dp
       JOIN users u ON u.id = dp.user_id
       WHERE dp.is_online=TRUE AND dp.status='verified'
         AND dp.is_locked=FALSE AND dp.current_lat IS NOT NULL
         AND COALESCE(dp.suspended, FALSE) = FALSE
         AND u.deleted_at IS NULL
       AND COALESCE(u.banned, FALSE) = FALSE
         AND COALESCE(dp.wallet_balance, 0) > 0
         AND u.zone_id=$1
         AND u.id NOT IN (SELECT driver_id FROM dispatch_attempts WHERE booking_id=$2)
         AND ($5 = 'any' OR TRIM(LOWER(COALESCE(dp.vehicle_type,'tricycle'))) = TRIM(LOWER($5)))
       ORDER BY (POWER(dp.current_lat-$3,2)+POWER(dp.current_lng-$4,2)) ASC
       LIMIT ${DISPATCH_BATCH_SIZE}`,
      [b.zone_id, b.id, b.pickup_lat, b.pickup_lng, b.eligible_vehicle]
    );
    if (nextDrivers.length > 0) {
      const label = b.service_type === 'delivery' ? 'delivery order' : 'ride';
      const { rows: sp } = await query(
        `SELECT 1 FROM bookings WHERE id=$1 AND status='pending' AND driver_id IS NULL`, [b.id]);
      if (!sp[0]) continue;   // accepted meanwhile — skip
      for (const d of nextDrivers) {
        await notifyDriver({ id: b.id, estimated_fare: b.estimated_fare }, d, label);
      }
      await query(`UPDATE bookings SET dispatch_exhausted=FALSE WHERE id=$1`, [b.id]);
      console.log(`  🔁 Retried exhausted booking ${b.id.slice(0,8)} (new drivers available)`);
    }
  }
};

/**
 * Background loop - call once at server startup
 */
// ── Auto-expire pending bookings nobody accepted ────────────────────────────
// A booking stuck in 'pending' past the limit is auto-cancelled and the
// customer is notified, so it stops counting as "searching" forever.
// Threshold from app_settings.pending_expiry_min (default 12 minutes; 0 = off).
async function expireStaleBookings() {
  try {
    const { rows: cfg } = await query(
      `SELECT COALESCE(NULLIF(value,'')::numeric, 3) AS m
       FROM app_settings WHERE key='pending_expiry_min' LIMIT 1`);
    const mins = cfg.length ? parseFloat(cfg[0].m) : 3;
    if (!(mins > 0)) return;  // 0/blank disables auto-expiry
    const { rows } = await query(
      `UPDATE bookings SET status='cancelled', updated_at=NOW()
       WHERE status='pending'
         AND created_at < NOW() - ($1 || ' minutes')::interval
       RETURNING id, customer_id`, [String(mins)]);
    for (const b of rows) {
      sendPush(b.customer_id, '😔 No driver available',
        'Sorry — no driver was available for your booking, so it was cancelled. Please try again in a bit.',
        { type: 'booking_expired', bookingId: b.id }).catch(() => {});
    }
    if (rows.length) console.log(`⌛ Auto-expired ${rows.length} stale pending booking(s)`);
  } catch (e) { logError('expireStaleBookings', e); }
}

// ── Auto-offline drivers who stopped checking in ────────────────────────────
// A driver still flagged is_online but with no location ping for a while has
// likely just closed the app. Mark them offline so the live count is honest
// and dispatch doesn't send them bookings they'll never see.
// Threshold from app_settings.driver_stale_min (default 5 minutes; 0 = off).
// Auto-cancel custom/pasabuy orders where the customer never answered the price
// approval within the admin-set timeout. NO penalty — the customer didn't act in
// bad faith and the driver bought nothing.
async function expireUnapprovedCustom() {
  try {
    const { rows: cfg } = await query(
      `SELECT value FROM app_settings WHERE key='custom_approval_timeout_min' LIMIT 1`);
    const mins = parseFloat(cfg[0]?.value) > 0 ? parseFloat(cfg[0]?.value) : 3;
    const { rows } = await query(
      `UPDATE bookings SET status='cancelled', updated_at=NOW(), price_approval_status='rejected'
       WHERE price_approval_status='pending'
         AND status IN ('accepted','arrived','in_progress')
         AND price_requested_at < NOW() - ($1 || ' minutes')::interval
       RETURNING id, customer_id, driver_id`,
      [String(mins)]);
    for (const b of rows) {
      if (b.customer_id) sendPush(b.customer_id, '❌ Order cancelled',
        'Your custom order was cancelled because the price approval wasn\'t answered in time. No charge — feel free to book again.',
        { type: 'booking_cancelled', bookingId: b.id }).catch(() => {});
      if (b.driver_id) sendPush(b.driver_id, '⌛ Approval timed out',
        'The customer didn\'t approve in time. Order cancelled — you are free for new bookings.',
        { type: 'booking_cancelled', bookingId: b.id }).catch(() => {});
    }
    if (rows.length) console.log(`⌛ Auto-cancelled ${rows.length} unapproved custom order(s)`);
  } catch (e) { logError('expireUnapprovedCustom', e); }
}

async function offlineStaleDrivers() {
  try {
    const { rows: cfg } = await query(
      `SELECT COALESCE(NULLIF(value,'')::numeric, 5) AS m
       FROM app_settings WHERE key='driver_stale_min' LIMIT 1`);
    const mins = cfg.length ? parseFloat(cfg[0].m) : 5;
    if (!(mins > 0)) return;
    const { rows } = await query(
      `UPDATE driver_profiles SET is_online=FALSE
       WHERE is_online=TRUE
         AND COALESCE(updated_at, created_at) < NOW() - ($1 || ' minutes')::interval
       RETURNING user_id`, [String(mins)]);
    if (rows.length) console.log(`💤 Auto-offlined ${rows.length} stale driver(s)`);
  } catch (e) { logError('offlineStaleDrivers', e); }
}

const startDispatchLoop = () => {
  setInterval(async () => {
    try {
      await processExpiredDispatches();
      await retryExhaustedBookings();
      await expireStaleBookings();
      await offlineStaleDrivers();
      await expireUnapprovedCustom();
    } catch (err) {
      console.error('dispatch loop error:', err.message);
    }
  }, 10000); // check every 10s
  console.log(`🔄 Dispatch loop started (batch of ${DISPATCH_BATCH_SIZE}, ${DISPATCH_TIMEOUT_SEC}s timeout)`);
};

module.exports = {
  startDispatch, processExpiredDispatches, retryExhaustedBookings, startDispatchLoop,
  expireStaleBookings, offlineStaleDrivers, expireUnapprovedCustom,
  getNearestDrivers, DISPATCH_TIMEOUT_SEC, DISPATCH_BATCH_SIZE,
};
