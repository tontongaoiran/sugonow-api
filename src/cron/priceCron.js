/**
 * SugoNow — src/cron/priceCron.js
 *
 * Scheduled background jobs for price management.
 * Run this file as a separate process alongside the API server.
 *
 * Start:  node src/cron/priceCron.js
 * Or add to PM2:
 *   pm2 start src/cron/priceCron.js --name sugonow-cron
 *
 * Dependencies:
 *   npm install node-cron
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const cron        = require('node-cron');
const { query }   = require('../db/pool');
const { sendSms } = require('../services/smsService');
const {
  forfeitExpiredDeposits,
  fetchDOEPriceFeed,
  getVolatilitySummary,
} = require('../services/priceService');
const {
  dailyFraudScan,
} = require('../services/gpsVerificationService');

console.log('[Cron] SugoNow background jobs starting...');

// ─── MONDAY 6AM — DOE price bulletin reminder ─────────────────────────────────
// Reminds admin to check DOE and update LPG prices weekly.
cron.schedule('0 6 * * 1', async () => {
  console.log('[Cron] Monday DOE price check...');
  try {
    await fetchDOEPriceFeed();
    console.log('[Cron] DOE check complete.');
  } catch (err) {
    console.error('[Cron] DOE check failed:', err.message);
  }
}, { timezone: 'Asia/Manila' });

// ─── DAILY 1AM — Forfeit expired container deposits ───────────────────────────
cron.schedule('0 1 * * *', async () => {
  console.log('[Cron] Daily deposit forfeiture check...');
  try {
    const forfeited = await forfeitExpiredDeposits();
    console.log(`[Cron] Forfeited ${forfeited} expired deposits.`);
  } catch (err) {
    console.error('[Cron] Deposit forfeiture failed:', err.message);
  }
}, { timezone: 'Asia/Manila' });

// ─── DAILY 2AM — GPS fraud scan ───────────────────────────────────────────────
cron.schedule('0 2 * * *', async () => {
  console.log('[Cron] Daily fraud scan...');
  try {
    await dailyFraudScan();
    console.log('[Cron] Fraud scan complete.');
  } catch (err) {
    console.error('[Cron] Fraud scan failed:', err.message);
  }
}, { timezone: 'Asia/Manila' });

// ─── DAILY 3AM — Reset driver daily payout totals ─────────────────────────────
cron.schedule('0 3 * * *', async () => {
  console.log('[Cron] Resetting daily payout totals...');
  try {
    const { rowCount } = await query(
      `UPDATE driver_profiles
       SET daily_payout_total=0, daily_payout_reset=CURRENT_DATE
       WHERE daily_payout_reset < CURRENT_DATE`
    );
    console.log(`[Cron] Reset ${rowCount} driver daily payout totals.`);
  } catch (err) {
    console.error('[Cron] Daily payout reset failed:', err.message);
  }
}, { timezone: 'Asia/Manila' });

// ─── WEEKLY SUNDAY 8PM — Price volatility alert to admin ──────────────────────
// Warn admin if price swings have been large this week, so they're prepared
// for Monday's DOE update.
cron.schedule('0 20 * * 0', async () => {
  console.log('[Cron] Weekly volatility report...');
  try {
    const { rows: exchangeProducts } = await query(
      `SELECT id, product_name FROM product_prices
       WHERE product_type='exchange' AND is_available=TRUE`
    );

    const highVolatility = [];
    for (const p of exchangeProducts) {
      const v = await getVolatilitySummary(p.id, 7);
      if (v.is_high_volatility || parseFloat(v.price_swing ?? 0) > 50) {
        highVolatility.push({
          name:  p.product_name,
          swing: v.price_swing,
          high:  v.highest_price,
          low:   v.lowest_price,
        });
      }
    }

    if (highVolatility.length > 0) {
      const { rows: admins } = await query(
        `SELECT mobile FROM users WHERE role='admin' LIMIT 1`
      );
      if (admins[0]) {
        const msg = `SugoNow price alert: High volatility this week — ` +
          highVolatility.map(p =>
            `${p.name}: ₱${p.low}–₱${p.high} (₱${p.swing} swing)`
          ).join(', ') +
          `. Check DOE bulletin tomorrow and update prices.`;
        await sendSms(admins[0].mobile, msg);
      }
    }
    console.log(`[Cron] Volatility report: ${highVolatility.length} high-volatility products.`);
  } catch (err) {
    console.error('[Cron] Volatility report failed:', err.message);
  }
}, { timezone: 'Asia/Manila' });

// ─── EVERY 5 MINUTES — Clean up expired price discrepancy timeouts ─────────────
// In production, use Bull queue instead. This is a simple fallback.
cron.schedule('*/5 * * * *', async () => {
  try {
    const timeoutMin = 5;
    const { rows } = await query(
      `UPDATE price_discrepancies
       SET customer_action='timeout', responded_at=NOW()
       WHERE customer_action IS NULL
         AND notified_at < NOW() - ($1 || ' minutes')::INTERVAL
       RETURNING booking_id, customer_id`,
      [timeoutMin]
    );

    for (const disc of rows) {
      // Cancel timed-out bookings
      await query(
        `UPDATE bookings SET status='cancelled',
         cancel_reason='Price change not confirmed within 5 minutes.'
         WHERE id=$1 AND status IN ('accepted','pending')`,
        [disc.booking_id]
      );
      // Notify customer
      const { rows: cRows } = await query(
        'SELECT mobile FROM users WHERE id=$1', [disc.customer_id]
      );
      if (cRows[0]) {
        sendSms(cRows[0].mobile,
          'SugoNow: Your LPG order was cancelled — response timeout on price change. No charge applied. Feel free to reorder.'
        ).catch(() => {});
      }
    }
    if (rows.length > 0) {
      console.log(`[Cron] Timed out ${rows.length} price discrepancy confirmations.`);
    }
  } catch (err) {
    console.error('[Cron] Timeout cleanup failed:', err.message);
  }
});

// ─── MONTHLY 1ST, 9AM — Low-stock/no-listing reminder to admin ────────────────
cron.schedule('0 9 1 * *', async () => {
  console.log('[Cron] Monthly business listing check...');
  try {
    const { rows: inactive } = await query(
      `SELECT b.name FROM businesses b
       LEFT JOIN product_prices pp ON pp.business_id=b.id AND pp.is_available=TRUE
       WHERE b.is_active=TRUE AND pp.id IS NULL`
    );
    if (inactive.length > 0) {
      const { rows: admins } = await query(
        'SELECT mobile FROM users WHERE role=\'admin\' LIMIT 1'
      );
      if (admins[0]) {
        await sendSms(admins[0].mobile,
          `SugoNow: ${inactive.length} active business(es) have no products listed: ` +
          inactive.slice(0, 3).map(b => b.name).join(', ') +
          (inactive.length > 3 ? ` and ${inactive.length - 3} more.` : '.') +
          ' Add their products in the admin panel.'
        );
      }
    }
  } catch (err) {
    console.error('[Cron] Business check failed:', err.message);
  }
}, { timezone: 'Asia/Manila' });

console.log('[Cron] All jobs scheduled. Running...');
console.log('  - Monday 6AM:    DOE price check + admin reminder');
console.log('  - Daily 1AM:     Deposit forfeiture');
console.log('  - Daily 2AM:     GPS fraud scan');
console.log('  - Daily 3AM:     Driver payout limit reset');
console.log('  - Sunday 8PM:    Weekly volatility report');
console.log('  - Every 5 min:   Price discrepancy timeout cleanup');
console.log('  - Monthly 1st:   Business listing check');
