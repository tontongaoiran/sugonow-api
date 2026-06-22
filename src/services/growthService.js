/**
 * SugoNow — src/services/growthService.js
 *
 * Central logic for Batch E:
 *  - Customer wallet (earn-credit, referral rewards, spending on bookings)
 *  - Driver pre-paid wallet (commission auto-deduct, top-ups, ₱0 lockout)
 *  - Referral codes + dual rewards
 *  - Bundle vouchers (LPG/water -> free food delivery)
 *  - Driver weekly milestone tracking
 */
const { query } = require('../db/pool');

// ── Settings ─────────────────────────────────────────────────────────────────
async function settings() {
  const { rows } = await query(
    `SELECT key, value FROM app_settings WHERE key IN
     ('earn_credit_amount','earn_credit_active','referral_amount','referral_active',
      'driver_wallet_min_topup','driver_wallet_active','bundle_voucher_active',
      'bundle_voucher_hours','milestone_active','milestone_target_trips',
      'milestone_min_rating','milestone_bonus')`
  );
  const m = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return {
    earnCredit:        parseFloat(m.earn_credit_amount ?? '30'),
    earnCreditActive:  m.earn_credit_active === 'true',
    referral:          parseFloat(m.referral_amount ?? '20'),
    referralActive:    m.referral_active === 'true',
    driverMinTopup:    parseFloat(m.driver_wallet_min_topup ?? '200'),
    driverWalletActive: m.driver_wallet_active === 'true',
    voucherActive:     m.bundle_voucher_active === 'true',
    voucherHours:      parseInt(m.bundle_voucher_hours ?? '72'),
    milestoneActive:   m.milestone_active === 'true',
    milestoneTrips:    parseInt(m.milestone_target_trips ?? '35'),
    milestoneRating:   parseFloat(m.milestone_min_rating ?? '4.6'),
    milestoneBonus:    parseFloat(m.milestone_bonus ?? '300'),
  };
}

// ════════ CUSTOMER WALLET ════════
async function getWalletBalance(userId) {
  const { rows } = await query(`SELECT wallet_balance FROM users WHERE id=$1`, [userId]);
  return parseFloat(rows[0]?.wallet_balance ?? 0);
}

async function addWalletCredit(userId, amount, type, note, bookingId = null) {
  await query(`UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id=$2`, [amount, userId]);
  await query(
    `INSERT INTO wallet_transactions (user_id, amount, type, booking_id, note)
     VALUES ($1,$2,$3,$4,$5)`,
    [userId, amount, type, bookingId, note]
  );
}

async function spendWallet(userId, amount, bookingId, note = 'Applied to booking') {
  await query(`UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id=$2`, [amount, userId]);
  await query(
    `INSERT INTO wallet_transactions (user_id, amount, type, booking_id, note)
     VALUES ($1,$2,'spend',$3,$4)`,
    [userId, -amount, bookingId, note]
  );
}

// Called when a booking COMPLETES. Grants earn-credit + referral reward + voucher.
async function onBookingCompleted(booking) {
  const s = await settings();
  const customerId = booking.customer_id;

  // 1. Earn-credit: first completed booking only
  if (s.earnCreditActive) {
    const { rows } = await query(`SELECT earn_credit_given FROM users WHERE id=$1`, [customerId]);
    if (rows[0] && !rows[0].earn_credit_given) {
      await addWalletCredit(customerId, s.earnCredit, 'earn_credit',
        'Reward for your first completed booking', booking.id);
      await query(`UPDATE users SET earn_credit_given=TRUE WHERE id=$1`, [customerId]);
    }
  }

  // 2. Referral reward: if this customer was referred and hasn't triggered reward yet
  if (s.referralActive) {
    const { rows: u } = await query(
      `SELECT referred_by, referral_rewarded FROM users WHERE id=$1`, [customerId]);
    if (u[0]?.referred_by && !u[0].referral_rewarded) {
      // reward both sides
      await addWalletCredit(customerId, s.referral, 'referral',
        'Referral bonus — thanks for your first booking!', booking.id);
      await addWalletCredit(u[0].referred_by, s.referral, 'referral',
        'Referral bonus — your friend completed their first booking!', booking.id);
      await query(`UPDATE users SET referral_rewarded=TRUE WHERE id=$1`, [customerId]);
      await query(
        `UPDATE referrals SET status='rewarded', rewarded_at=NOW()
         WHERE referee_id=$1`, [customerId]);
    }
  }

  // 3. Bundle voucher: LPG or water order unlocks free food delivery
  if (s.voucherActive && ['exchange', 'water'].includes(booking.service_type)) {
    const expires = new Date(Date.now() + s.voucherHours * 3600 * 1000);
    await query(
      `INSERT INTO vouchers (customer_id, type, earned_from, expires_at)
       VALUES ($1,'free_food_delivery',$2,$3)`,
      [customerId, booking.id, expires]
    );
  }

  // 4. Driver milestone progress
  if (s.milestoneActive && booking.driver_id) {
    await bumpMilestone(booking.driver_id);
  }
}

// How much wallet credit can be applied to a fare+fee total
async function applicableCredit(userId, totalDue) {
  const bal = await getWalletBalance(userId);
  return Math.min(bal, totalDue);
}

// ════════ REFERRALS ════════
function genCode(userId) {
  // short, human-friendly code derived from the user id + randomness
  return 'SUGO' + Math.random().toString(36).slice(2, 6).toUpperCase();
}

async function ensureReferralCode(userId) {
  const { rows } = await query(`SELECT referral_code FROM users WHERE id=$1`, [userId]);
  if (rows[0]?.referral_code) return rows[0].referral_code;
  let code, ok = false;
  while (!ok) {
    code = genCode(userId);
    const { rows: c } = await query(`SELECT 1 FROM users WHERE referral_code=$1`, [code]);
    ok = c.length === 0;
  }
  await query(`UPDATE users SET referral_code=$1 WHERE id=$2`, [code, userId]);
  return code;
}

// Apply a referral code at signup (or first time). Cannot refer yourself; once only.
async function applyReferralCode(newUserId, code) {
  const { rows: r } = await query(`SELECT id FROM users WHERE referral_code=$1`, [code]);
  if (!r[0]) return { ok: false, message: 'Invalid referral code.' };
  if (r[0].id === newUserId) return { ok: false, message: 'You cannot refer yourself.' };

  const { rows: u } = await query(`SELECT referred_by FROM users WHERE id=$1`, [newUserId]);
  if (u[0]?.referred_by) return { ok: false, message: 'A referral code was already applied.' };

  await query(`UPDATE users SET referred_by=$1 WHERE id=$2`, [r[0].id, newUserId]);
  await query(
    `INSERT INTO referrals (referrer_id, referee_id, status)
     VALUES ($1,$2,'pending') ON CONFLICT (referee_id) DO NOTHING`,
    [r[0].id, newUserId]
  );
  return { ok: true, message: 'Referral applied! You both earn credit after your first booking.' };
}

// ════════ DRIVER WALLET ════════
async function getDriverWallet(driverId) {
  const { rows } = await query(`SELECT wallet_balance FROM driver_profiles WHERE user_id=$1`, [driverId]);
  return parseFloat(rows[0]?.wallet_balance ?? 0);
}

// Deduct commission from driver wallet on a completed trip
async function deductCommission(driverId, amount, bookingId) {
  await query(
    `UPDATE driver_profiles SET wallet_balance = wallet_balance - $1 WHERE user_id=$2`,
    [amount, driverId]);
  await query(
    `INSERT INTO driver_wallet_transactions (driver_id, amount, type, booking_id, note)
     VALUES ($1,$2,'commission',$3,'Commission on completed trip')`,
    [driverId, -amount, bookingId]);
}

async function creditDriverWallet(driverId, amount, type, note, adminId = null) {
  await query(
    `UPDATE driver_profiles SET wallet_balance = wallet_balance + $1 WHERE user_id=$2`,
    [amount, driverId]);
  await query(
    `INSERT INTO driver_wallet_transactions (driver_id, amount, type, note)
     VALUES ($1,$2,$3,$4)`,
    [driverId, amount, type, note]);
}

// Is a driver allowed to accept jobs? (wallet must be > 0)
async function driverCanAccept(driverId) {
  const s = await settings();
  if (!s.driverWalletActive) return true;
  const bal = await getDriverWallet(driverId);
  return bal > 0;
}

// ════════ MILESTONES ════════
function weekStart(d = new Date()) {
  // Compute the Monday week-start in MANILA time, to match the
  // date_trunc('week', NOW() AT TIME ZONE 'Asia/Manila') used for trip counts.
  // A server running in UTC would otherwise land on a different calendar week
  // near the Sun/Mon boundary, so a paid bonus could be written to one week's
  // row while the driver card reads another — showing "pending" forever.
  const manila = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Manila' }));
  const day = manila.getDay();              // 0 Sun ... 6 Sat (Manila)
  const diff = (day === 0 ? -6 : 1) - day;  // back to Monday
  manila.setDate(manila.getDate() + diff);
  const y = manila.getFullYear();
  const m = String(manila.getMonth() + 1).padStart(2, '0');
  const dd = String(manila.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

async function bumpMilestone(driverId) {
  const ws = weekStart();
  await query(
    `INSERT INTO driver_milestones (driver_id, week_start, trips_done)
     VALUES ($1,$2,1)
     ON CONFLICT (driver_id, week_start)
     DO UPDATE SET trips_done = driver_milestones.trips_done + 1`,
    [driverId, ws]);
}

async function getMilestoneProgress(driverId) {
  const s = await settings();
  if (!s.milestoneActive) return null;
  const ws = weekStart();
  // Count COMPLETED BOOKINGS this week — the always-present record. The
  // driver_milestones table only fills while the milestone system is ON, so
  // trips completed before the switch was flipped wouldn't appear there.
  // Counting bookings keeps the driver card and the admin pill in agreement.
  const { rows: bk } = await query(
    `SELECT COUNT(*)::int AS done FROM bookings
     WHERE driver_id=$1 AND status='completed'
       AND completed_at >= date_trunc('week', NOW() AT TIME ZONE 'Asia/Manila')`,
    [driverId]);
  const done = bk[0]?.done ?? 0;
  // bonus_paid still comes from the milestone row (set when admin pays).
  const { rows } = await query(
    `SELECT bonus_paid FROM driver_milestones WHERE driver_id=$1 AND week_start=$2`,
    [driverId, ws]);
  return {
    trips_done: done, target: s.milestoneTrips,
    min_rating: s.milestoneRating, bonus: s.milestoneBonus,
    bonus_paid: rows[0]?.bonus_paid ?? false,
    reached: done >= s.milestoneTrips,
  };
}

// Comprehensive driver dashboard stats: earnings, counts, rating, bonuses
async function getDriverStats(driverId) {
  // Earnings = sum of (final_fare - 15% commission) for completed, paid trips.
  // We compute the driver's net using 85% of final_fare for simplicity/consistency.
  const periods = {
    today: "completed_at::date = (NOW() AT TIME ZONE 'Asia/Manila')::date",
    week:  "completed_at >= date_trunc('week', NOW() AT TIME ZONE 'Asia/Manila')",
    month: "completed_at >= date_trunc('month', NOW() AT TIME ZONE 'Asia/Manila')",
  };
  const out = {};
  for (const [k, cond] of Object.entries(periods)) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS trips,
              COALESCE(SUM(final_fare),0) AS gross,
              COALESCE(SUM(final_fare * 0.85),0) AS net,
              COUNT(*) FILTER (WHERE service_type='ride')::int AS rides,
              COUNT(*) FILTER (WHERE service_type IN ('delivery','food','exchange','custom','water'))::int AS deliveries
       FROM bookings
       WHERE driver_id=$1 AND status='completed' AND ${cond}`,
      [driverId]);
    out[k] = {
      trips: rows[0].trips,
      gross: Math.round(parseFloat(rows[0].gross)),
      net: Math.round(parseFloat(rows[0].net)),
      rides: rows[0].rides,
      deliveries: rows[0].deliveries,
    };
  }

  // Rating + lifetime trips
  const { rows: dp } = await query(
    `SELECT rating, total_trips FROM driver_profiles WHERE user_id=$1`, [driverId]);

  // Bonus history: paid + uncollected
  const { rows: bonuses } = await query(
    `SELECT week_start, trips_done, bonus_paid, bonus_amount
     FROM driver_milestones WHERE driver_id=$1 ORDER BY week_start DESC LIMIT 8`,
    [driverId]);

  const milestone = await getMilestoneProgress(driverId);

  return {
    earnings: out,
    rating: dp[0]?.rating ? parseFloat(dp[0].rating) : null,
    lifetime_trips: dp[0]?.total_trips ?? 0,
    milestone,
    bonuses,
  };
}

module.exports = {
  settings,
  getWalletBalance, addWalletCredit, spendWallet, onBookingCompleted, applicableCredit,
  ensureReferralCode, applyReferralCode,
  getDriverWallet, deductCommission, creditDriverWallet, driverCanAccept,
  bumpMilestone, getMilestoneProgress, getDriverStats, weekStart,
};
