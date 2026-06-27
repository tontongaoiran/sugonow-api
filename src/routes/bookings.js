/**
 * SugoNow — src/routes/bookings.js (MEGA)
 *
 * Full booking lifecycle:
 *  pending → accepted → arrived → in_progress → (waiting) → completed
 *
 * Includes: stopovers, 30s dispatch, driver arrival notify,
 * live GPS tracking, completion, ratings/reports.
 */
const express = require('express');
const { query, withTransaction } = require('../db/pool');
const { saveMediaBase64 } = require('../utils/media');
const { authenticate, requireRole, requireVerifiedDriver } = require('../middleware/auth');
const { calculateFare, isFirstBooking, splitFare, getCommissionRate } = require('../services/fareService');
const { checkLocationAllowed, checkDeliveryDestination } = require('../services/locationService');
const { sendSms, sendNotificationSms } = require('../services/smsService');
const { sendPush } = require('../services/pushNotificationService');
const { startDispatch } = require('../services/dispatchService');
const { getSurge, checkPromoEligibility, applyPromo, redeemPromo } = require('../services/pricingExtrasService');
const { issueReceipt } = require('../services/receiptService');
const { chargeMerchantFees } = require('../services/merchantFeeService');
const { nearestLandmarkLabel } = require('./landmarks');

// Cancellation cooldown thresholds — admin-adjustable via app_settings,
// cached 30s. soft_count cancellations -> soft_hours pause; hard_count -> hard_hours.
// Set hard_count = 0 to disable the long pause; soft_count = 0 disables entirely.
let _cdCache = { at: 0, soft_count: 3, soft_hours: 2, hard_count: 5, hard_hours: 24, active: true };
async function cooldownSettings() {
  if (Date.now() - _cdCache.at < 30000) return _cdCache;
  try {
    const { rows } = await query(
      `SELECT key, value FROM app_settings WHERE key IN
        ('cooldown_active','cooldown_soft_count','cooldown_soft_hours','cooldown_hard_count','cooldown_hard_hours')`);
    const kv = Object.fromEntries(rows.map(r => [r.key, r.value]));
    _cdCache = {
      at: Date.now(),
      active:     kv.cooldown_active ? kv.cooldown_active === 'true' : true,
      soft_count: kv.cooldown_soft_count != null ? parseInt(kv.cooldown_soft_count) : 3,
      soft_hours: kv.cooldown_soft_hours != null ? parseFloat(kv.cooldown_soft_hours) : 2,
      hard_count: kv.cooldown_hard_count != null ? parseInt(kv.cooldown_hard_count) : 5,
      hard_hours: kv.cooldown_hard_hours != null ? parseFloat(kv.cooldown_hard_hours) : 24,
    };
  } catch (e) { logError('cooldownSettings', e); }
  return _cdCache;
}
const { bookingFeeFor, addLedgerEntry } = require('../services/passBillingService');
const G = require('../services/growthService');
const { logError } = require('../services/errorLogService');
const M = require('../services/messageService');

// ── Service-aware status copy for customer notifications ──
// "Pickup" means three different things across rides, food, water, and LPG,
// so each service gets its own wording at accept / arrived / start.
function statusCopy(serviceType, driverName, plate) {
  const who = `${driverName || 'Your driver'}${plate ? ` (${plate})` : ''}`;
  switch (serviceType) {
    case 'water': return {
      acceptSms:   `SugoNow: ${who} is heading your way to collect your empty water containers!`,
      acceptTitle: '💧 Driver on the way!',
      arrivedSms:  'SugoNow: Your driver has arrived to collect your empty containers for refilling.',
      arrivedBody: 'Your driver is here to collect your containers.',
      startTitle:  '💧 Water on the way!',
      startBody:   'Your refilled containers are on the way back to you.',
    };
    case 'exchange': case 'lpg': return {
      // LPG is collect-first: the driver gets the empty tank AND the payment
      // from the customer, exchanges at the store, and returns the filled tank
      // (drivers can't front the cost of a tank).
      acceptSms:   `SugoNow: ${who} is heading your way to collect your empty tank and payment!`,
      acceptTitle: '🔵 Driver on the way!',
      arrivedSms:  'SugoNow: Your driver has arrived — please have your empty tank and payment ready.',
      arrivedBody: 'Your driver is here for your empty tank and payment.',
      startTitle:  '🔵 Exchanging your tank!',
      startBody:   'Your driver is exchanging your tank at the LPG store and will be right back.',
    };
    case 'food': return {
      acceptSms:   `SugoNow: ${who} is heading to the store to get your order!`,
      acceptTitle: '🛍 Driver on the way!',
      arrivedSms:  'SugoNow: Your driver is at the store picking up your order.',
      arrivedBody: 'Your driver is at the store getting your order.',
      startTitle:  '🛍 Order on the way!',
      startBody:   'Your order has been picked up and is on the way to you.',
    };
    case 'delivery': case 'custom': return {
      acceptSms:   `SugoNow: ${who} is heading to pick up your item!`,
      acceptTitle: '📦 Driver on the way!',
      arrivedSms:  'SugoNow: Your driver has arrived at the pickup point for your item.',
      arrivedBody: 'Your driver is at the pickup point for your item.',
      startTitle:  '📦 Item on the way!',
      startBody:   'Your item has been picked up and is on the way to you.',
    };
    default: return {   // ride
      acceptSms:   `SugoNow: ${who} is on the way!`,
      acceptTitle: '🛺 Driver on the way!',
      arrivedSms:  'SugoNow: Your driver has ARRIVED at the pickup point!',
      arrivedBody: 'Your driver is waiting at the pickup location.',
      startTitle:  '🛺 Trip started!',
      startBody:   'You are on your way.',
    };
  }
}

const router = express.Router();

// ─── Merchant notification helpers (G2-C) ────────────────────────────────────
// Find the merchant owner(s) behind a booking's items. A booking's products map
// to menu_items, which belong to a business, which has an owner_id (the merchant
// user). Returns [{ owner_id, business_name }] (usually one store per order).
async function merchantsForBooking(bookingId) {
  const { rows } = await query(
    `SELECT DISTINCT b.owner_id, b.name AS business_name
     FROM order_items oi
     JOIN menu_items mi ON mi.id = oi.product_id
     JOIN businesses b ON b.id = mi.business_id
     WHERE oi.booking_id = $1 AND b.owner_id IS NOT NULL`,
    [bookingId]);
  return rows;
}

// Notify the merchant(s) that a new order came in.
async function notifyMerchantNewOrder(bookingId) {
  try {
    const merchants = await merchantsForBooking(bookingId);
    if (merchants.length === 0) return;
    const { rows: items } = await query(
      `SELECT product_name, quantity FROM order_items WHERE booking_id=$1`, [bookingId]);
    const summary = items.map(i => `${i.quantity}× ${i.product_name}`).join(', ');
    for (const m of merchants) {
      sendPush(m.owner_id, '🛍 New order!',
        summary || 'You have a new SugoNow order.',
        { type: 'merchant_new_order', bookingId }).catch(() => {});
    }
  } catch (e) { logError('notifyMerchantsNewOrder', e, { bookingId }); }
}

// Notify an LPG/water store owner directly by their business id (used when we
// have the chosen store but no product line, e.g. older app builds).
async function notifyLpgWaterStoreByBusiness(businessId, serviceType, bookingId) {
  if (!businessId) return;
  try {
    const { rows } = await query(
      `SELECT owner_id, name FROM businesses WHERE id=$1 AND owner_id IS NOT NULL`, [businessId]);
    if (!rows[0]) return;
    const label = serviceType === 'water' ? 'water' : 'LPG';
    sendPush(rows[0].owner_id, '🛍 New ' + label + ' order!',
      'A customer ordered ' + label + ' from your store. A driver will arrive to collect payment and pick up.',
      { type: 'merchant_new_order', bookingId }).catch(() => {});
  } catch (e) { logError('notifyLpgWaterStoreByBusiness', e); }
}

// Notify the merchant(s) which driver is coming to pick up the order.
async function notifyMerchantDriverAssigned(bookingId, driverName, plate) {
  try {
    const merchants = await merchantsForBooking(bookingId);
    for (const m of merchants) {
      sendPush(m.owner_id, '🛺 Driver assigned',
        `${driverName || 'A driver'} (${plate || 'plate N/A'}) is heading to your store for pickup.`,
        { type: 'merchant_driver_assigned', bookingId }).catch(() => {});
    }
  } catch (e) { logError('notifyMerchantsDriverAssigned', e, { bookingId }); }
}


// ── Standalone location check (used by driver app before going online) ──
// Returns whether a lat/lng is inside an active service zone. TEST_MODE-aware
// (checkLocationAllowed handles the bypass).
// ─── Commissionable base ─────────────────────────────────────────────────────
// Commission is charged ONLY on the service/delivery portion the driver actually
// earns — NEVER on product pass-throughs the driver fronts and recovers from the
// customer (food cart, LPG tank/gas, water). estimated_fare already EXCLUDES the
// LPG/water product cost (those are tracked separately), but for FOOD/DELIVERY it
// bundles the cart total in, so we subtract the products there.
async function getCommissionBase(booking) {
  const fare = parseFloat(booking.estimated_fare ?? 0)
             + parseFloat(booking.promo_discount ?? 0);   // promo-covered part still earns
  const svc = (booking.service_type || '').toLowerCase();
  if (svc === 'food' || svc === 'delivery') {
    // estimated_fare = products_total + delivery_fee -> strip the products.
    let productsTotal = 0;
    try {
      const { rows } = await query(
        `SELECT COALESCE(SUM(unit_price * quantity),0) AS t FROM order_items WHERE booking_id=$1`,
        [booking.id]);
      productsTotal = parseFloat(rows[0]?.t || 0);
    } catch (e) { productsTotal = 0; }
    return Math.max(0, fare - productsTotal);   // delivery fee only
  }
  // ride / exchange(LPG) / water / custom: estimated_fare is already the
  // service/delivery fare (product cost is separate), so commission on it is correct.
  return fare;
}

// Custom approval timeout (minutes), admin-adjustable. Cached 30s.
let _apprCache = { at: 0, mins: 3 };
async function getApprovalTimeoutMin() {
  if (Date.now() - _apprCache.at < 30000) return _apprCache.mins;
  try {
    const { rows } = await query(`SELECT value FROM app_settings WHERE key='custom_approval_timeout_min' LIMIT 1`);
    const m = parseFloat(rows[0]?.value);
    _apprCache = { at: Date.now(), mins: (m > 0 ? m : 3) };
  } catch { _apprCache = { at: Date.now(), mins: 3 }; }
  return _apprCache.mins;
}

router.get('/location-check', async (req, res) => {
  try {
    const { lat, lng } = req.query;
    const result = await checkLocationAllowed(parseFloat(lat), parseFloat(lng));
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/fare-estimate', async (req, res) => {
  try {
    const {
      pickup_lat, pickup_lng, drop_lat, drop_lng,
      stopover_lat, stopover_lng, stopover_wait_min,
      service_type = 'ride', zone = 'flora',
      passenger_count = 1, customer_id, container_count = 1, tank_count = 1,
      location_note,
    } = req.query;

    if (!pickup_lat || !pickup_lng) {
      return res.status(400).json({ success: false, message: 'Pickup coordinates required.' });
    }
    let firstBooking = false;
    if (customer_id) firstBooking = await isFirstBooking(customer_id);

    const surge = await getSurge();

    const fare = await calculateFare({
      pickupLat: parseFloat(pickup_lat), pickupLng: parseFloat(pickup_lng),
      dropLat: drop_lat ? parseFloat(drop_lat) : null,
      dropLng: drop_lng ? parseFloat(drop_lng) : null,
      stopoverLat: stopover_lat ? parseFloat(stopover_lat) : null,
      stopoverLng: stopover_lng ? parseFloat(stopover_lng) : null,
      stopoverWaitMin: parseInt(stopover_wait_min) || 0,
      serviceType: service_type, zone,
      passengerCount: parseInt(passenger_count) || 1,
      isFirstBooking: firstBooking,
      surgeActive: surge.active, surgeMultiplier: surge.multiplier,
      containerCount: parseInt(container_count) || 1,
      tankCount: parseInt(tank_count) || 1,
    });

    // First-booking promo preview (free ride OR free delivery, capped)
    let promo = null;
    if (customer_id) {
      const elig = await checkPromoEligibility(customer_id, service_type);
      if (elig.eligible) {
        const applied = applyPromo(fare.total_fare, elig.maxValue);
        promo = {
          eligible: true, promo_type: elig.promoType,
          max_value: elig.maxValue,
          you_pay: applied.customer_pays,
          sugonow_covers: applied.sugonow_covers,
          label: elig.promoType === 'free_ride'
            ? `FREE first ride (up to ₱${elig.maxValue})!`
            : `FREE first delivery (up to ₱${elig.maxValue})!`,
        };
      }
    }

    // Booking fee (₱5) — waived for SugoNow Pass members
    let bookingFee = { fee: 0, waived: false };
    if (customer_id) bookingFee = await bookingFeeFor(customer_id);

    // Wallet credit the customer could apply (to fee + fare)
    let walletBalance = 0;
    if (customer_id) walletBalance = await G.getWalletBalance(customer_id);
    const totalWithFee = fare.total_fare + bookingFee.fee;
    const creditApplicable = Math.min(walletBalance, totalWithFee);

    res.json({ success: true, ...fare, is_first_booking: firstBooking,
               surge_label: surge.active ? surge.label : null, promo,
               booking_fee: bookingFee.fee,
               booking_fee_waived: bookingFee.waived,
               wallet_balance: walletBalance,
               wallet_credit_applicable: creditApplicable,
               total_after_credit: Math.max(0, totalWithFee - creditApplicable),
               total_with_fee: totalWithFee });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /bookings ──────────────────────────────────────────────────────────
// ─── GET /bookings/vehicle-availability ──────────────────────────────────────
// Tells the app how many motorcycles / tricycles are online near a pickup, so it
// can offer a tricycle when the customer wanted a motorcycle but none are online.
router.get('/vehicle-availability', authenticate, async (req, res) => {
  try {
    const { pickup_lat, pickup_lng } = req.query;
    if (!pickup_lat || !pickup_lng) {
      return res.status(400).json({ success: false, message: 'pickup_lat/lng required.' });
    }
    const locationCheck = await checkLocationAllowed(parseFloat(pickup_lat), parseFloat(pickup_lng));
    const zone = locationCheck.zone;
    if (!zone) return res.json({ success: true, motorcycle: 0, tricycle: 0 });
    const { rows } = await query(
      `SELECT TRIM(LOWER(COALESCE(dp.vehicle_type,'tricycle'))) AS vtype, COUNT(*)::int AS n
       FROM driver_profiles dp JOIN users u ON u.id = dp.user_id
       WHERE dp.is_online = TRUE AND dp.status = 'verified'
         AND dp.is_locked = FALSE AND COALESCE(dp.suspended, FALSE) = FALSE
         AND u.deleted_at IS NULL AND COALESCE(dp.wallet_balance,0) > 0
         AND dp.current_lat IS NOT NULL AND u.zone_id = $1
       GROUP BY vtype`,
      [zone.id]);
    let motorcycle = 0, tricycle = 0;
    for (const r of rows) {
      if (r.vtype === 'motorcycle') motorcycle = r.n;
      else tricycle += r.n;  // treat anything non-motorcycle as tricycle
    }
    res.json({ success: true, motorcycle, tricycle });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── PATCH /bookings/:id/switch-to-tricycle ──────────────────────────────────
// Customer agrees to accept a tricycle after a motorcycle-only search found none.
// Widens eligibility to 'any' and re-dispatches.
router.patch('/:id/switch-to-tricycle', authenticate, requireRole('customer'), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, customer_id, status, zone_id, pickup_lat, pickup_lng, service_type, eligible_vehicle
       FROM bookings WHERE id=$1`, [req.params.id]);
    const bk = rows[0];
    if (!bk) return res.status(404).json({ success: false, message: 'Booking not found.' });
    if (bk.customer_id !== req.user.id) return res.status(403).json({ success: false, message: 'Not your booking.' });
    if (bk.status !== 'pending') return res.status(400).json({ success: false, message: 'This booking is no longer searching.' });
    // Widen to any vehicle and clear the exhausted flag so dispatch retries.
    await query(
      `UPDATE bookings SET eligible_vehicle='any', dispatch_exhausted=FALSE WHERE id=$1`, [bk.id]);
    // Re-dispatch immediately to nearby drivers (now including tricycles).
    try {
      await startDispatch(
        { id: bk.id, estimated_fare: 0, eligible_vehicle: 'any' },
        bk.zone_id, parseFloat(bk.pickup_lat), parseFloat(bk.pickup_lng),
        bk.service_type === 'ride' ? 'ride' : 'booking');
    } catch (e) { logError('switchToTricycleDispatch', e); }
    res.json({ success: true, message: 'Now also looking for tricycles near you.' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/', authenticate, requireRole('customer'), async (req, res) => {
  try {
    // Cancellation cooldown gate — repeated cancellers are paused from booking
    {
      const { rows: cd } = await query(
        `SELECT cancel_cooldown_until FROM users WHERE id=$1`, [req.user.id]);
      const until = cd[0]?.cancel_cooldown_until;
      if (until && new Date(until) > new Date()) {
        const mins = Math.ceil((new Date(until) - new Date()) / 60000);
        return res.status(429).json({ success: false,
          message: `New bookings are paused due to repeated cancellations. Try again in ${mins >= 60 ? Math.ceil(mins/60) + ' hour(s)' : mins + ' minutes'}.` });
      }
    }
    // Unpaid cancellation-fee gate — a customer who cancelled a custom order
    // AFTER the driver bought the goods must settle the fee before booking again.
    {
      const { rows: uf } = await query(
        `SELECT COALESCE(unpaid_cancel_fee,0) AS fee FROM users WHERE id=$1`, [req.user.id]);
      const owed = parseFloat(uf[0]?.fee || 0);
      if (owed > 0) {
        return res.status(402).json({ success: false,
          message: `You have an unpaid cancellation fee of ₱${Math.round(owed)} from a previous custom order. Please settle it at the SugoNow office to book again.` });
      }
    }
    const {
      pickup_lat, pickup_lng, pickup_address,
      dropoff_lat, dropoff_lng, dropoff_address,
      stopover_lat, stopover_lng, stopover_address,
      service_type = 'ride', payment_method = 'cash',
      passenger_count = 1, custom_note, unlisted_store, custom_photo,
      use_promo = false,
      use_wallet = false,
      use_voucher = false,
      lpg_mode, lpg_brand, lpg_size, lpg_est_cost,
      water_mode, container_count = 1, tank_count = 1, location_note,
      refill_where, refill_note,
      vehicle_pref = 'any',
      price_ceiling,
    } = req.body;

    if (!pickup_lat || !pickup_lng) {
      return res.status(400).json({ success: false, message: 'Pickup location required.' });
    }
    const passengers = Math.min(3, Math.max(1, parseInt(passenger_count) || 1));

    // ── Vehicle eligibility (THE one place these rules live) ──────────────
    // LPG -> tricycle only (tanks need a tricycle).
    // Ride with 2+ passengers -> tricycle only (a motorcycle can't take them).
    // Food/store delivery -> any (tricycle or motorcycle).
    // Solo ride -> the customer's choice ('any' | 'tricycle' | 'motorcycle').
    let eligibleVehicle;
    if (service_type === 'exchange' || service_type === 'lpg' || service_type === 'water') {
      eligibleVehicle = 'tricycle';
    } else if (service_type === 'ride' && passengers >= 2) {
      eligibleVehicle = 'tricycle';
    } else if (service_type === 'ride') {
      const pref = String(vehicle_pref || 'any').toLowerCase();
      eligibleVehicle = ['tricycle', 'motorcycle'].includes(pref) ? pref : 'any';
    } else {
      // food, store/delivery, custom errand -> any vehicle
      eligibleVehicle = 'any';
    }

    const locationCheck = await checkLocationAllowed(parseFloat(pickup_lat), parseFloat(pickup_lng));
    if (!locationCheck.allowed) {
      return res.status(403).json({
        success: false, message: locationCheck.message,
        coming_soon: locationCheck.coming_soon ?? false,
      });
    }
    const activeZone = locationCheck.zone;

    // Deliveries must stay inside the service zone; rides may go anywhere.
    const DELIVERY_TYPES = ['food', 'exchange', 'water', 'delivery', 'custom'];
    if (DELIVERY_TYPES.includes(service_type) && dropoff_lat && dropoff_lng) {
      const destCheck = await checkDeliveryDestination(
        parseFloat(pickup_lat), parseFloat(pickup_lng),
        parseFloat(dropoff_lat), parseFloat(dropoff_lng));
      if (!destCheck.allowed) {
        return res.status(403).json({ success: false, message: destCheck.message });
      }
    }

    const firstBooking = await isFirstBooking(req.user.id);
    const hasStopover = !!(stopover_lat && stopover_lng);
    const surge = await getSurge();

    // ── Fare ──
    // For FOOD/DELIVERY orders the customer pays: products total + delivery fee
    // (a distance-based delivery fee), NOT a passenger ride fare. For rides and
    // other services we use the normal distance fare.
    // Moderation: a ban must stop bookings immediately, even if the user's
    // login token was issued before the ban.
    const { rows: banChk } = await query(
      `SELECT COALESCE(banned, FALSE) AS banned FROM users WHERE id=$1`, [req.user.id]);
    if (banChk[0]?.banned) {
      return res.status(403).json({ success: false,
        message: 'Your account has been suspended. Please contact the SugoNow office in Flora.' });
    }

    const isStoreOrder = (service_type === 'food' || service_type === 'delivery');
    const orderItems = Array.isArray(req.body.order_items) ? req.body.order_items : [];

    // ── Store closure check ──
    // If this order contains store products, make sure the store isn't closed.
    // A store counts as closed when the merchant set is_open=FALSE and the
    // reopen date (closed_until) hasn't passed yet (no date = closed until
    // they reopen manually). Once closed_until passes, it auto-reopens.
    if (orderItems.length > 0) {
      const productIds = orderItems.map(it => it.product_id).filter(Boolean);
      if (productIds.length > 0) {
        const { rows: closedBiz } = await query(
          `SELECT DISTINCT b.name, b.closed_until, b.closed_note,
                  (COALESCE(b.fee_owed,0) >= COALESCE((SELECT COALESCE(NULLIF(value,'')::numeric, 500) FROM app_settings WHERE key='merchant_fee_cap' LIMIT 1), 500)) AS locked_for_fees
           FROM menu_items mi JOIN businesses b ON b.id = mi.business_id
           WHERE mi.id = ANY($1::uuid[])
             AND ((b.is_open = FALSE
                   AND (b.closed_until IS NULL OR b.closed_until >= CURRENT_DATE))
                  OR COALESCE(b.fee_owed,0) >= COALESCE((SELECT COALESCE(NULLIF(value,'')::numeric, 500) FROM app_settings WHERE key='merchant_fee_cap' LIMIT 1), 500))`,
          [productIds]);
        if (closedBiz[0]) {
          const cb = closedBiz[0];
          if (cb.locked_for_fees) {
            return res.status(403).json({ success: false, store_closed: true,
              message: `${cb.name} is temporarily unavailable. Please try another store.` });
          }
          const when = cb.closed_until
            ? ` They plan to reopen on ${new Date(cb.closed_until).toLocaleDateString('en-PH', { month: 'long', day: 'numeric' })}.`
            : '';
          return res.status(403).json({ success: false, store_closed: true,
            message: `${cb.name} is temporarily closed.${when}` +
                     (cb.closed_note ? ` Note from the store: "${cb.closed_note}"` : '') });
        }
      }
    }

    const productsTotal = orderItems.reduce(
      (sum, it) => sum + (parseFloat(it.unit_price || 0) * parseInt(it.quantity || 1)), 0);

    const fareData = await calculateFare({
      pickupLat: parseFloat(pickup_lat), pickupLng: parseFloat(pickup_lng),
      dropLat: dropoff_lat ? parseFloat(dropoff_lat) : null,
      dropLng: dropoff_lng ? parseFloat(dropoff_lng) : null,
      stopoverLat: stopover_lat ? parseFloat(stopover_lat) : null,
      stopoverLng: stopover_lng ? parseFloat(stopover_lng) : null,
      stopoverWaitMin: 0, // wait time added later by driver
      serviceType: service_type, zone: activeZone.slug,
      passengerCount: passengers, isFirstBooking: firstBooking,
      surgeActive: surge.active, surgeMultiplier: surge.multiplier,
      containerCount: container_count,
      tankCount: parseInt(tank_count) || 1,
    });

    // For store orders, the "delivery fee" is the distance-based fare from
    // calculateFare (store -> customer), and the customer also pays for the
    // products. total = products + delivery fee.
    const deliveryFee = isStoreOrder ? Math.round(fareData.total_fare) : 0;
    if (isStoreOrder) {
      fareData.products_total = Math.round(productsTotal);
      fareData.delivery_fee = deliveryFee;
      fareData.total_fare = Math.round(productsTotal) + deliveryFee;
    }

    // ── Free-delivery voucher (auto-applied on food orders) ──
    // If the customer has an active free_food_delivery voucher and chose to use
    // it, waive the delivery fee. We mark the voucher used and record the waived
    // amount on the booking (discount_amount/note) so the driver can later be
    // reimbursed for the free delivery (handled at completion).
    let voucherApplied = false, voucherId = null, voucherWaived = 0;
    if (use_voucher && service_type === 'food' && isStoreOrder && deliveryFee > 0) {
      try {
        // expire stale, then grab the soonest-expiring active free-food voucher
        await query(`UPDATE vouchers SET status='expired'
                     WHERE customer_id=$1 AND status='active' AND expires_at < NOW()`,
                    [req.user.id]);
        const { rows: vrows } = await query(
          `SELECT id FROM vouchers
           WHERE customer_id=$1 AND status='active' AND type='free_food_delivery'
           ORDER BY expires_at LIMIT 1`, [req.user.id]);
        if (vrows[0]) {
          voucherId = vrows[0].id;
          voucherWaived = deliveryFee;
          voucherApplied = true;
          // Waive the delivery portion from the customer's total.
          fareData.delivery_fee = 0;
          fareData.total_fare = Math.round(productsTotal);
          // Record on the booking (reuses discount columns) so it's auditable and
          // so the driver can be reimbursed for the free delivery at completion.
          fareData.discount_amount = (parseFloat(fareData.discount_amount) || 0) + voucherWaived;
          fareData.discount_note = ((fareData.discount_note ? fareData.discount_note + ' ' : '') +
                                    `Free-delivery voucher (₱${voucherWaived})`).trim();
        }
      } catch (e) { logError('voucherApply', e); }
    }

    // First-booking promo (customer chose to use it on this booking)
    let promoApplied = null, promoDiscount = 0, finalFare = fareData.total_fare, promoCap = 50;
    if (use_promo) {
      const elig = await checkPromoEligibility(req.user.id, service_type);
      if (elig.eligible) {
        const ap = applyPromo(fareData.total_fare, elig.maxValue);
        promoApplied  = elig.promoType;
        promoDiscount = ap.promo_discount;
        finalFare     = ap.customer_pays; // what customer pays now
        promoCap      = elig.maxValue;
      }
    }

    // ── Give the DRIVER a usable pickup/dropoff label. ──
    // Customer-perspective phrases like "My current location" are useless to a
    // driver. We replace any generic label with: a nearby landmark if we have
    // one ("near Flora Pharmacy"), else a neutral "Pickup pin" the driver taps
    // to navigate (the exact lat/lng is always attached for Waze/Maps handoff).
    const isGeneric = (s) => !s || !s.trim() ||
      /my (current )?location/i.test(s) || /current location/i.test(s) ||
      /^map pin/i.test(s) || /^📍/.test(s.trim()) ||
      /^\(?-?\d+\.\d+/.test(s.trim());
    let pickupLabel = pickup_address, dropoffLabel = dropoff_address;
    try {
      if (isGeneric(pickupLabel)) {
        const lm = await nearestLandmarkLabel(pickup_lat, pickup_lng);
        pickupLabel = lm || 'Pickup pin (tap to navigate)';
      }
      if (dropoff_lat && dropoff_lng && isGeneric(dropoffLabel)) {
        const lm = await nearestLandmarkLabel(dropoff_lat, dropoff_lng);
        dropoffLabel = lm || 'Drop-off pin (tap to navigate)';
      }
    } catch (e) { logError('landmarkEnrich', e); }

    // Booking fee (₱5) — waived for Pass members
    const feeInfo = await bookingFeeFor(req.user.id);

    const { rows } = await query(
      `INSERT INTO bookings
         (customer_id, zone_id, service_type, status,
          pickup_lat, pickup_lng, pickup_address,
          dropoff_lat, dropoff_lng, dropoff_address,
          stopover_lat, stopover_lng, stopover_address, has_stopover,
          distance_km, estimated_fare, payment_method,
          passenger_count, discount_amount, discount_note,
          custom_note, unlisted_store, promo_applied, promo_discount,
          lpg_mode, lpg_brand, lpg_size, lpg_product_cost,
          booking_fee, booking_fee_waived, eligible_vehicle,
          water_mode, container_count, water_cost, refill_where, refill_note)
       VALUES ($1::uuid,$2::uuid,$3,'pending',
               $4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
               $14,$15,$16,$17,$18,$19,$20,$21,$22,$23,
               $24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35)
       RETURNING id, status, estimated_fare`,
      [
        req.user.id, activeZone.id, service_type,
        parseFloat(pickup_lat), parseFloat(pickup_lng), pickupLabel || null,
        dropoff_lat ? parseFloat(dropoff_lat) : null,
        dropoff_lng ? parseFloat(dropoff_lng) : null, dropoffLabel || null,
        stopover_lat ? parseFloat(stopover_lat) : null,
        stopover_lng ? parseFloat(stopover_lng) : null,
        stopover_address || null, hasStopover,
        fareData.trip_distance_km, finalFare, payment_method,
        passengers, fareData.discount_amount, fareData.discount_note,
        custom_note || null, unlisted_store || null,
        promoApplied, promoDiscount,
        lpg_mode || null, lpg_brand || null, lpg_size || null,
        (service_type === 'exchange'
          ? (parseFloat(lpg_est_cost) || 0) * Math.min(3, Math.max(1, parseInt(tank_count) || 1))
          : (lpg_est_cost ? parseFloat(lpg_est_cost) : 0)),
        feeInfo.fee, feeInfo.waived,
        eligibleVehicle,
        service_type === 'water' ? (water_mode || 'refill') : null,
        service_type === 'water' ? Math.min(3, Math.max(1, parseInt(container_count) || 1)) : null,
        service_type === 'water' ? (parseFloat(lpg_est_cost) || 0) : 0,
        service_type === 'water' ? (refill_where || 'nearest') : null,
        service_type === 'water' ? (refill_note || null) : null,
      ]
    );
    const booking = rows[0];

    // Mark the free-delivery voucher as used and link it to this booking, so it
    // can't be reused and so completion can reimburse the driver for it.
    if (voucherApplied && voucherId) {
      try {
        await query(
          `UPDATE vouchers SET status='used', used_on=$1, used_at=NOW()
           WHERE id=$2 AND customer_id=$3 AND status='active'`,
          [booking.id, voucherId, req.user.id]);
      } catch (e) {
        // Fallback if used_on/used_at columns don't exist — at least mark it used.
        try { await query(`UPDATE vouchers SET status='used' WHERE id=$1`, [voucherId]); }
        catch (e2) { logError('voucherMarkUsed', e2); }
      }
      // Record the waived delivery amount on the booking so the driver can be
      // reimbursed for the free delivery at completion (Batch 3).
      try {
        await query(`UPDATE bookings SET voucher_discount=$1 WHERE id=$2`,
                    [voucherWaived, booking.id]);
      } catch (e) { logError('voucherDiscountRecord', e); }
    }

    // Optional "where to find me" note for the driver (any service).
    if (location_note && String(location_note).trim()) {
      try {
        await query(`UPDATE bookings SET location_note=$1 WHERE id=$2`,
          [String(location_note).trim().slice(0, 300), booking.id]);
      } catch (e) { logError('locationNoteSave', e); }
    }

    // Custom/pasabuy price ceiling (the customer's MAX). Stored so the driver
    // can only buy within it; over-ceiling requires in-app approval.
    if (price_ceiling != null && !isNaN(parseFloat(price_ceiling))) {
      try {
        await query(`UPDATE bookings SET price_ceiling=$1 WHERE id=$2`,
          [parseFloat(price_ceiling), booking.id]);
      } catch (e) { logError('priceCeilingSave', e); }
    }

    // Custom-order photo (optional): customer attaches a product photo so the
    // driver can show it at the store. Save it and stamp the URL on the booking.
    if (custom_photo && typeof custom_photo === 'string' && custom_photo.startsWith('data:image')) {
      try {
        const mediaUrl = await saveMediaBase64(custom_photo);
        if (mediaUrl) {
          await query(`UPDATE bookings SET custom_photo_url=$1 WHERE id=$2`,
            [mediaUrl, booking.id]);
        }
      } catch (e) { logError('customPhotoSave', e); }
    }

    // Apply wallet credit if the customer opted in (covers fee + fare)
    if (use_wallet) {
      const totalDue = parseFloat(booking.estimated_fare) + parseFloat(feeInfo.fee);
      const credit = await G.applicableCredit(req.user.id, totalDue);
      if (credit > 0) {
        await G.spendWallet(req.user.id, credit, booking.id,
          'Applied to booking ' + booking.id);
        await query(`UPDATE bookings SET wallet_credit_used=$1 WHERE id=$2`,
          [credit, booking.id]);
      }
    }

    // Save cart line items (for food/delivery with product options) so the
    // substitution flow can reference them later.
    if (Array.isArray(req.body.order_items) && req.body.order_items.length > 0) {
      for (const it of req.body.order_items) {
        await query(
          `INSERT INTO order_items
             (booking_id, product_id, product_name, quantity, unit_price, options_text, status)
           VALUES ($1,$2,$3,$4,$5,$6,'ok')`,
          [booking.id, it.product_id || null, it.product_name || 'Item',
           parseInt(it.quantity || 1), parseFloat(it.unit_price || 0),
           it.options_text || null]
        );
      }
      // G2-C: ping the merchant(s) that a new order arrived
      await notifyMerchantNewOrder(booking.id);
    }

    // ── LPG / Water: record the sale to the chosen store + notify its owner ──
    // These aren't "store orders" in the food sense (the driver pays the store
    // and collects from the customer), but the customer DID pick a real store
    // and product. We create an order_items row for the chosen product so the
    // sale shows in the store's records (order_items → menu_items → business)
    // and notify the owner. We do NOT charge a merchant fee on LPG/water.
    if (['exchange','lpg','water'].includes(service_type)) {
      const productId = req.body.lpg_product_id || req.body.water_product_id || null;
      if (productId) {
        try {
          // Verify the product exists and grab its store-facing details.
          const { rows: prod } = await query(
            `SELECT id, name, price FROM menu_items WHERE id=$1`, [productId]);
          if (prod[0]) {
            const qty = service_type === 'water'
              ? Math.min(3, Math.max(1, parseInt(req.body.container_count) || 1))
              : (service_type === 'exchange' || service_type === 'lpg')
              ? Math.min(3, Math.max(1, parseInt(req.body.tank_count) || 1)) : 1;
            await query(
              `INSERT INTO order_items
                 (booking_id, product_id, product_name, quantity, unit_price, options_text, status)
               VALUES ($1,$2,$3,$4,$5,$6,'ok')`,
              [booking.id, prod[0].id, prod[0].name, qty, parseFloat(prod[0].price || 0),
               service_type === 'water' ? 'Water delivery' : 'LPG order']);
            // Notify the store owner (same mechanism as food).
            await notifyMerchantNewOrder(booking.id);
          } else {
            await notifyLpgWaterStoreByBusiness(req.body.unlisted_store, service_type, booking.id);
          }
        } catch (e) { logError('lpgWaterStoreRecord', e); }
      } else if (req.body.unlisted_store) {
        // Old app build / no product id, but we know the chosen store — notify it.
        try { await notifyLpgWaterStoreByBusiness(req.body.unlisted_store, service_type, booking.id); }
        catch (e) { logError('lpgWaterNotifyFallback', e); }
      }
    }

    // Record promo redemption (locks the user's choice)
    if (promoApplied) {
      await redeemPromo(req.user.id, booking.id, promoApplied,
                        fareData.total_fare, promoCap);
    }

    if (firstBooking) {
      await query('UPDATE users SET first_booking_used=TRUE WHERE id=$1', [req.user.id]);
    }

    // Start 30s dispatch to nearest driver (or nearest to store for delivery)
    const dispatchOrigin = (service_type === 'delivery' || service_type === 'food')
      ? { lat: parseFloat(pickup_lat), lng: parseFloat(pickup_lng) } // pickup = store
      : { lat: parseFloat(pickup_lat), lng: parseFloat(pickup_lng) };
    const label =
      service_type === 'water'    ? 'water delivery' :
      service_type === 'exchange' ? 'LPG delivery'   :
      service_type === 'food'     ? 'food order'     :
      service_type === 'delivery' ? 'delivery order' :
      service_type === 'custom'   ? 'errand'         : 'ride';
    const dispatch = await startDispatch(
      { id: booking.id, estimated_fare: fareData.total_fare, eligible_vehicle: eligibleVehicle },
      activeZone.id, dispatchOrigin.lat, dispatchOrigin.lng, label
    );

    res.status(201).json({
      success: true, booking_id: booking.id, status: 'pending',
      fare: fareData, zone: activeZone.name,
      voucher_applied: voucherApplied, voucher_waived: voucherWaived,
      dispatch: dispatch.dispatched
        ? `Notifying nearest driver (${dispatch.driver.full_name})...`
        : 'No drivers available right now. We will keep trying.',
    });
  } catch (err) {
    console.error('booking error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PATCH /bookings/:id/accept ──────────────────────────────────────────────
router.patch('/:id/accept', authenticate, requireVerifiedDriver, async (req, res) => {
  try {
    // Block suspended drivers
    const { rows: susp } = await query(
      `SELECT suspended, suspended_until FROM driver_profiles WHERE user_id=$1`, [req.user.id]);
    if (susp[0]?.suspended) {
      // auto-lift if the suspension window has passed
      if (susp[0].suspended_until && new Date(susp[0].suspended_until) < new Date()) {
        await query(`UPDATE driver_profiles SET suspended=FALSE, suspended_until=NULL, suspension_reason=NULL WHERE user_id=$1`, [req.user.id]);
      } else {
        return res.status(403).json({ success: false, suspended: true,
          message: 'Your account is suspended. Please report to the SugoNow office in Flora.' });
      }
    }

    // Block if the driver's pre-paid wallet is empty (replaces the old owed/lockout)
    const canAccept = await G.driverCanAccept(req.user.id);
    if (!canAccept) {
      const bal = await G.getDriverWallet(req.user.id);
      return res.status(403).json({
        success: false,
        message: `Your wallet balance is ₱${bal.toFixed(2)}. Top up your SugoNow wallet to accept jobs.`,
        wallet_empty: true,
      });
    }

    // Block if the wallet can't cover THIS booking's full commission.
    // Mirrors the completion math exactly: commission is split on the full fare
    // (fare + promo SugoNow covers), plus the ₱5 booking fee if not waived.
    const { rows: bkMoney } = await query(
      `SELECT estimated_fare, promo_discount, booking_fee, service_type
         FROM bookings WHERE id=$1 AND status='pending'`, [req.params.id]);
    if (bkMoney[0]) {
      const commRate = (await getCommissionRate()) / 100;
      // Same base as completion: service/delivery portion only (no product cost).
      const commBase = await getCommissionBase({ ...bkMoney[0], id: req.params.id });
      const requiredCut = splitFare(commBase, commRate).commission_amount
                        + parseFloat(bkMoney[0].booking_fee ?? 0);
      const bal = await G.getDriverWallet(req.user.id);
      if (bal < requiredCut) {
        return res.status(403).json({
          success: false,
          message: `You can't accept this booking — SugoNow's commission for it is ` +
                   `₱${requiredCut.toFixed(2)} but your wallet only has ₱${bal.toFixed(2)}. ` +
                   `Top up your wallet to accept jobs like this.`,
          wallet_short: true,
          required: requiredCut,
          balance: bal,
        });
      }
    }

    const { rows } = await query(
      `UPDATE bookings SET driver_id=$1, status='accepted', updated_at=NOW()
       WHERE id=$2 AND status='pending' AND driver_id IS NULL
       RETURNING id, customer_id, service_type`,
      [req.user.id, req.params.id]
    );
    if (!rows[0]) return res.status(400).json({ success: false, message: 'Booking no longer available.' });

    // Mark dispatch accepted
    await query(
      `UPDATE dispatch_attempts SET status='accepted', responded_at=NOW()
       WHERE booking_id=$1 AND driver_id=$2`,
      [req.params.id, req.user.id]
    );

    // Notify customer with driver info
    const { rows: dRows } = await query(
      `SELECT u.full_name, dp.plate_number, dp.rating, dp.current_lat, dp.current_lng
       FROM users u JOIN driver_profiles dp ON dp.user_id=u.id WHERE u.id=$1`,
      [req.user.id]
    );

    // ── Finalize fare: add the driver→pickup distance now that we know the driver ──
    let pickupFare = 0, pickupKm = 0;
    try {
      // per_km_rate lives on the ZONE, not the booking — join through zone_id.
      const { rows: bk } = await query(
        `SELECT b.pickup_lat, b.pickup_lng, b.estimated_fare, b.service_type,
                COALESCE(z.per_km_rate, 8) AS per_km_rate
         FROM bookings b LEFT JOIN zones z ON z.id = b.zone_id
         WHERE b.id=$1`,
        [rows[0].id]);
      const drv = dRows[0];
      if (bk[0] && drv?.current_lat && drv?.current_lng) {
        const haversineKm = (la1,lo1,la2,lo2) => {
          const R=6371, toRad=d=>d*Math.PI/180;
          const dLa=toRad(la2-la1), dLo=toRad(lo2-lo1);
          const a=Math.sin(dLa/2)**2+Math.cos(toRad(la1))*Math.cos(toRad(la2))*Math.sin(dLo/2)**2;
          return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
        };
        const rate = parseFloat(bk[0].per_km_rate ?? 8) || 8;
        pickupKm = haversineKm(parseFloat(drv.current_lat), parseFloat(drv.current_lng),
                               parseFloat(bk[0].pickup_lat), parseFloat(bk[0].pickup_lng));
        pickupFare = Math.round(pickupKm * rate);
        await query(
          `UPDATE bookings SET pickup_distance_km=$1, pickup_distance_fare=$2,
             estimated_fare = estimated_fare + $2, fare_finalized=TRUE
           WHERE id=$3`,
          [Math.round(pickupKm*100)/100, pickupFare, rows[0].id]);
      }
    } catch (e) { logError('pickupDistanceFareUpdate', e, { bookingId: rows[0] && rows[0].id }); }

    const { rows: cRows } = await query('SELECT mobile FROM users WHERE id=$1', [rows[0].customer_id]);
    const copy = statusCopy(rows[0].service_type, dRows[0]?.full_name, dRows[0]?.plate_number);
    // Progress updates are PUSH-ONLY to conserve Semaphore credits (the
    // customer is in the app — they just booked). SMS stays reserved for
    // account-critical events: OTP, approvals, suspensions, fee notices.
    sendPush(rows[0].customer_id, copy.acceptTitle,
      `${dRows[0]?.full_name} accepted your booking` +
      (pickupFare > 0 ? ` · +₱${pickupFare} pickup distance added` : ''),
      { type: 'booking_accepted', bookingId: rows[0].id }).catch(() => {});

    // G2-C: tell the merchant which driver is coming to pick up
    notifyMerchantDriverAssigned(rows[0].id, dRows[0]?.full_name, dRows[0]?.plate_number);

    // Return the FULL booking so the driver app has all coordinates immediately
    const { rows: full } = await query(
      `SELECT b.*, u.full_name AS customer_name, u.mobile AS customer_mobile
       FROM bookings b JOIN users u ON u.id = b.customer_id
       WHERE b.id = $1`,
      [rows[0].id]
    );

    // Attach any cart items so the driver can manage substitutions immediately
    const { rows: acceptItems } = await query(
      `SELECT id, product_name, quantity, unit_price, options_text, status
       FROM order_items WHERE booking_id=$1 ORDER BY created_at`,
      [rows[0].id]
    );
    if (full[0]) full[0].order_items = acceptItems;

    res.json({ success: true, booking_id: rows[0].id, booking: full[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PATCH /bookings/:id/decline ─────────────────────────────────────────────
router.patch('/:id/decline', authenticate, requireVerifiedDriver, async (req, res) => {
  try {
    await query(
      `UPDATE dispatch_attempts SET status='declined', responded_at=NOW()
       WHERE booking_id=$1 AND driver_id=$2 AND status='notified'`,
      [req.params.id, req.user.id]
    );
    // Dispatch loop will pick up the next driver automatically
    res.json({ success: true, message: 'Declined. Next driver will be notified.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PATCH /bookings/:id/arrived — driver reached pickup ─────────────────────
router.patch('/:id/arrived', authenticate, requireVerifiedDriver, async (req, res) => {
  try {
    const { rows } = await query(
      `UPDATE bookings SET status='arrived', arrived_at=NOW(), updated_at=NOW()
       WHERE id=$1 AND driver_id=$2 AND status='accepted'
       RETURNING customer_id, service_type`,
      [req.params.id, req.user.id]
    );
    if (!rows[0]) return res.status(400).json({ success: false, message: 'Cannot mark arrived.' });

    const { rows: c } = await query('SELECT mobile FROM users WHERE id=$1', [rows[0].customer_id]);
    const aCopy = statusCopy(rows[0].service_type);
    sendPush(rows[0].customer_id, '📍 Driver has arrived!',
      aCopy.arrivedBody,
      { type: 'driver_arrived', bookingId: req.params.id }).catch(() => {});

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PATCH /bookings/:id/start — begin the trip ──────────────────────────────
router.patch('/:id/start', authenticate, requireVerifiedDriver, async (req, res) => {
  try {
    const { rows } = await query(
      `UPDATE bookings SET status='in_progress', started_at=NOW(), updated_at=NOW()
       WHERE id=$1 AND driver_id=$2 AND status IN ('accepted','arrived')
       RETURNING customer_id, service_type`,
      [req.params.id, req.user.id]
    );
    if (!rows[0]) return res.status(400).json({ success: false, message: 'Cannot start trip.' });
    const sCopy = statusCopy(rows[0].service_type);
    sendPush(rows[0].customer_id, sCopy.startTitle, sCopy.startBody,
      { type: 'trip_started', bookingId: req.params.id }).catch(() => {});
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PATCH /bookings/:id/wait-start — stopover waiting begins ────────────────
router.patch('/:id/wait-start', authenticate, requireVerifiedDriver, async (req, res) => {
  try {
    await query(
      `UPDATE bookings SET status='waiting', wait_started_at=NOW(), updated_at=NOW()
       WHERE id=$1 AND driver_id=$2`,
      [req.params.id, req.user.id]
    );
    res.json({ success: true, message: 'Waiting timer started.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PATCH /bookings/:id/wait-end — stopover waiting ends, compute charge ────
router.patch('/:id/wait-end', authenticate, requireVerifiedDriver, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT wait_started_at, estimated_fare, customer_id FROM bookings
       WHERE id=$1 AND driver_id=$2 AND wait_started_at IS NOT NULL`,
      [req.params.id, req.user.id]
    );
    if (!rows[0]) return res.status(400).json({ success: false, message: 'No active wait timer.' });

    const waitMs  = Date.now() - new Date(rows[0].wait_started_at).getTime();
    const waitMin = Math.ceil(waitMs / 60000);
    const charge  = waitMin * 3; // ₱3/min

    await query(
      `UPDATE bookings
       SET status='in_progress', wait_ended_at=NOW(),
           stopover_wait_min=$1, stopover_charge=$2,
           estimated_fare=estimated_fare+$2, updated_at=NOW()
       WHERE id=$3`,
      [waitMin, charge, req.params.id]
    );

    sendPush(rows[0].customer_id, '⏱ Stopover complete',
      `Waiting: ${waitMin} min · +₱${charge} added to fare`,
      { type: 'wait_ended', bookingId: req.params.id }).catch(() => {});

    res.json({ success: true, wait_minutes: waitMin, charge });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /bookings/:id/ping — driver live location ──────────────────────────
router.post('/:id/ping', authenticate, requireVerifiedDriver, async (req, res) => {
  try {
    const { lat, lng } = req.body;
    if (!lat || !lng) return res.status(400).json({ success: false });
    await query(
      `UPDATE driver_profiles SET current_lat=$1, current_lng=$2, last_ping_at=NOW()
       WHERE user_id=$3`,
      [parseFloat(lat), parseFloat(lng), req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /bookings/:id/track — customer polls driver location ────────────────
router.get('/:id/track', authenticate, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT b.status, b.pickup_lat, b.pickup_lng,
              b.dropoff_lat, b.dropoff_lng, b.arrived_at,
              b.estimated_fare, b.pickup_distance_fare, b.pickup_distance_km,
              b.dispatch_exhausted, b.eligible_vehicle, b.water_mode, b.lpg_mode,
              b.price_ceiling, b.actual_price, b.price_approval_status, b.price_requested_at,
              b.goods_purchased,
              COALESCE(b.wallet_credit_used,0) AS wallet_credit_used,
              COALESCE(b.voucher_discount,0) AS voucher_discount,
              dp.current_lat AS driver_lat, dp.current_lng AS driver_lng,
              dp.last_ping_at, u.full_name AS driver_name, dp.plate_number,
              u.mobile AS driver_mobile,
              dp.vehicle_type, dp.vehicle_color, dp.vehicle_model,
              COALESCE(u.profile_photo, dp.photo_url) AS driver_photo,
              b.payment_method
       FROM bookings b
       LEFT JOIN driver_profiles dp ON dp.user_id=b.driver_id
       LEFT JOIN users u ON u.id=b.driver_id
       WHERE b.id=$1 AND (b.customer_id=$2 OR b.driver_id=$2)`,
      [req.params.id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Booking not found.' });
    const trk = rows[0];
    if (trk.price_approval_status === 'pending' && trk.price_requested_at) {
      const mins = await getApprovalTimeoutMin();
      const elapsed = (Date.now() - new Date(trk.price_requested_at).getTime()) / 1000;
      trk.price_seconds_left = Math.max(0, Math.round(mins * 60 - elapsed));
    }
    // Include the live order items so the driver's shopping checklist reflects
    // removals/substitutions in real time (active items only — removed/unavailable
    // /substituted-original rows are excluded; the substitute replacement is 'ok').
    try {
      const { rows: items } = await query(
        `SELECT id, product_name, quantity, unit_price, options_text, status
         FROM order_items
         WHERE booking_id=$1 AND (status='ok' OR status IS NULL)
         ORDER BY id`, [req.params.id]);
      trk.order_items = items;
    } catch (e) { /* non-fatal — checklist just won't refresh this tick */ }
    res.json({ success: true, tracking: trk });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PATCH /bookings/:id/complete — driver marks done ────────────────────────
router.patch('/:id/complete', authenticate, requireVerifiedDriver, async (req, res) => {
  try {
    const { final_fare, lpg_product_cost } = req.body;
    const { rows: bRows } = await query(
      `SELECT b.*, u.mobile AS customer_mobile FROM bookings b
       JOIN users u ON u.id=b.customer_id
       WHERE b.id=$1 AND b.driver_id=$2 AND b.status IN ('in_progress','waiting','arrived')`,
      [req.params.id, req.user.id]
    );
    if (!bRows[0]) return res.status(400).json({ success: false, message: 'Cannot complete this booking.' });

    const booking = bRows[0];
    // SECURITY: never trust an app-sent fare for the money math. The commission
    // is based on the fare the SERVER calculated and stored at booking/finalize
    // time (estimated_fare). The app may send final_fare ONLY to record what the
    // customer actually paid (e.g. a tip or agreed adjustment), but it can never
    // be LOWER than the server's fare — that would let a hacked app shrink the
    // commission. We clamp to the server value.
    const serverFare = parseFloat(booking.estimated_fare ?? 0);
    const appFare = final_fare != null ? parseFloat(final_fare) : serverFare;
    const customerFare = Math.max(serverFare, isNaN(appFare) ? serverFare : appFare);
    const promoCovered = parseFloat(booking.promo_discount ?? 0);
    const fullFare = customerFare + promoCovered;   // used for customer-facing totals
    const commRate = (await getCommissionRate()) / 100;
    // Commission is charged ONLY on the delivery/service portion the driver earns,
    // never on product pass-throughs (food cart, LPG/water product cost).
    const commissionBase = await getCommissionBase(booking);
    const split = splitFare(commissionBase, commRate);

    // LPG product cost: trust the server-stored value, not the app, for the same
    // reason. Only fall back to an app value if the server has none recorded.
    const lpgCost = parseFloat(booking.lpg_product_cost ?? lpg_product_cost ?? 0);
    const bookingFee = parseFloat(booking.booking_fee ?? 0);   // ₱5 (0 if Pass member)
    // Total the customer hands over = fare + LPG product cost + booking fee
    const totalPaid = customerFare + lpgCost + bookingFee;

    const isEwalletPay = ['gcash','maya','palawan','gotyme'].includes((booking.payment_method || '').toLowerCase());

    // Conditional UPDATE closes a double-tap race: only ONE request can flip the
    // booking to 'completed'. If two requests both passed the SELECT guard above,
    // the second one updates 0 rows here and we bail BEFORE touching money — so
    // commission, trips, merchant fees and rewards can never be applied twice.
    const { rowCount: completedNow } = await query(
      `UPDATE bookings SET status='completed', final_fare=$1,
              lpg_product_cost=$2, payment_status='paid',
              completed_at=NOW(), updated_at=NOW()
       WHERE id=$3 AND status IN ('in_progress','waiting','arrived')`,
      [customerFare, lpgCost, req.params.id]
    );
    if (completedNow === 0) {
      return res.status(409).json({ success: false, message: 'This booking was already completed.' });
    }

    // ── Money flow (pre-paid driver wallet model) ──
    // SugoNow's cut (commission + the ₱5 booking fee for non-Pass members) is
    // deducted from the driver's pre-paid wallet. The driver keeps the cash they
    // collect from the customer; SugoNow's share comes out of their loaded wallet.
    const sugonowCut = split.commission_amount + bookingFee;
    await G.deductCommission(req.user.id, sugonowCut, booking.id);

    // ── Referral/wallet credit reimbursement ──
    // If the customer paid part of the fare with SugoNow credit, they handed the
    // driver LESS cash by exactly that amount. That credit is SugoNow's
    // promotional cost, NOT the driver's — so we reimburse the driver's wallet
    // the credit amount, making them whole. (The driver app shows the reduced
    // "cash to collect" so they never expect the full cash.)
    const creditUsed = parseFloat(booking.wallet_credit_used ?? 0);
    if (creditUsed > 0) {
      try {
        await G.creditDriverWallet(req.user.id, creditUsed, 'credit_reimbursement',
          `Reimbursement: customer paid ₱${creditUsed.toFixed(2)} via SugoNow credit on booking ${booking.id.slice(0,8)}`);
      } catch (e) { logError('creditReimbursement', e); }
    }

    // ── Free-delivery voucher reimbursement (Batch 3) ──
    // If the customer used a free-delivery voucher, the driver delivered for free
    // (the delivery fee was waived from the customer's total). That waived delivery
    // is SugoNow's promotional cost, NOT the driver's — so credit the driver's
    // wallet the waived amount, making them whole for the delivery they performed.
    const voucherDiscount = parseFloat(booking.voucher_discount ?? 0);
    if (voucherDiscount > 0) {
      try {
        await G.creditDriverWallet(req.user.id, voucherDiscount, 'voucher_reimbursement',
          `Reimbursement: free-delivery voucher (₱${voucherDiscount.toFixed(2)}) on booking ${booking.id.slice(0,8)}`);
      } catch (e) { logError('voucherReimbursement', e); }
    }

    await query(
      `UPDATE driver_profiles SET total_trips=total_trips+1 WHERE user_id=$1`,
      [req.user.id]
    );
    await query('UPDATE users SET total_bookings=total_bookings+1 WHERE id=$1',
      [booking.customer_id]);

    // ── Growth rewards: earn-credit, referral, bundle voucher, milestone ──
    try { await G.onBookingCompleted(booking); } catch (e) { logError('onBookingCompleted', e, { bookingId: booking.id }); }

    // ── G2-D: charge SugoNow's fee to any merchant(s) in this order ──
    await chargeMerchantFees(booking.id);

    // ── Fee discipline: warn at ₱400, hide store at ₱500 (once each, flags
    //    reset when a payment brings them back under the threshold) ──
    try {
      // Fee thresholds come from admin settings (cap + warn), not hardcoded.
      const { rows: capRow } = await query(
        `SELECT
           COALESCE((SELECT NULLIF(value,'')::numeric FROM app_settings WHERE key='merchant_fee_cap' LIMIT 1), 500) AS cap,
           COALESCE((SELECT NULLIF(value,'')::numeric FROM app_settings WHERE key='merchant_fee_warn' LIMIT 1), 400) AS warn`);
      const FEE_CAP = parseFloat(capRow[0]?.cap ?? 500);
      const FEE_WARN = parseFloat(capRow[0]?.warn ?? 400);
      const { rows: feeBiz } = await query(
        `SELECT DISTINCT b.id, b.name, b.owner_id, b.fee_owed,
                b.fee_warn_notified, b.fee_lock_notified,
                COALESCE(u.mobile, b.contact_mobile) AS mobile
         FROM order_items oi
         JOIN menu_items mi ON mi.id = oi.product_id
         JOIN businesses b ON b.id = mi.business_id
         LEFT JOIN users u ON u.id = b.owner_id
         WHERE oi.booking_id = $1`, [booking.id]);
      for (const fb of feeBiz) {
        const owed = parseFloat(fb.fee_owed || 0);
        if (owed >= FEE_CAP && !fb.fee_lock_notified) {
          await query(`UPDATE businesses SET fee_lock_notified=TRUE, fee_warn_notified=TRUE WHERE id=$1`, [fb.id]);
          const msg = `Your SugoNow fee balance reached ₱${owed.toFixed(0)} (limit ₱${FEE_CAP.toFixed(0)}), so your ` +
            `store is temporarily hidden from customers. Settle your balance in the app ` +
            `(GCash or cash at the office) and it becomes visible again right after admin confirms.`;
          if (fb.owner_id) M.sendMessage(fb.owner_id, '🚫 Store hidden — fee balance at limit', msg, 'general').catch(() => {});
          if (fb.mobile) sendNotificationSms(fb.mobile, `SugoNow (${fb.name}): ${msg}`).catch(() => {});
        } else if (owed >= FEE_WARN && owed < FEE_CAP && !fb.fee_warn_notified) {
          await query(`UPDATE businesses SET fee_warn_notified=TRUE WHERE id=$1`, [fb.id]);
          const msg = `Heads up: your SugoNow fee balance is ₱${owed.toFixed(0)}. At ₱${FEE_CAP.toFixed(0)} your store ` +
            `is temporarily hidden from customers until settled. You can pay anytime in the app.`;
          if (fb.owner_id) M.sendMessage(fb.owner_id, '⚠️ Fee balance reminder', msg, 'general').catch(() => {});
          if (fb.mobile) sendNotificationSms(fb.mobile, `SugoNow (${fb.name}): ${msg}`).catch(() => {});
        }
      }
    } catch (e) { /* fee notices must never block completion */ }

    // Driver wallet warning if running low
    const dwallet = await G.getDriverWallet(req.user.id);

    // ── Issue the e-receipt ──
    let receipt = null;
    try {
      receipt = await issueReceipt(booking, {
        base_fare:       parseFloat(booking.estimated_fare ?? 0) - parseFloat(booking.stopover_charge ?? 0),
        delivery_fee:    parseFloat(booking.delivery_fee ?? 0),
        lpg_product_cost: lpgCost,
        stopover_charge: parseFloat(booking.stopover_charge ?? 0),
        discount_amount: parseFloat(booking.discount_amount ?? 0),
        promo_discount:  promoCovered,
        booking_fee:     bookingFee,
        total_paid:      totalPaid,
        notes: booking.water_mode
          ? (booking.water_mode === 'with_container'
              ? `Water: ${booking.container_count || 1} filled container(s). Customer paid water + containers on delivery.`
              : `Water refill: ${booking.container_count || 1} container(s). Customer paid water cost on delivery.`)
          : (booking.lpg_mode === 'exchange'
          ? 'LPG tank exchange. Customer paid LPG refill cost on delivery.'
          : (booking.lpg_mode === 'buy_new'
              ? 'New LPG tank purchase. Customer paid full LPG cost on delivery.'
              : null)),
      });
    } catch (e) { /* receipt failure shouldn't block completion */ }

    sendNotificationSms(booking.customer_mobile,
      `SugoNow: Delivery complete! Total: ₱${totalPaid.toFixed(2)}. Receipt ${receipt?.receipt_no || ''}.`
    ).catch(() => {});
    sendPush(booking.customer_id, '✅ Complete!',
      `Total: ₱${totalPaid.toFixed(2)}. Tap to view your receipt & rate your driver.`,
      { type: 'completed', bookingId: req.params.id }).catch(() => {});

    // Cash the driver actually collects = total minus any SugoNow credit the
    // customer already applied (that portion was reimbursed to the driver's
    // wallet above, so they must NOT also collect it as cash).
    const cashToCollect = Math.max(0, totalPaid - creditUsed);
    res.json({ success: true, final_fare: customerFare,
               driver_amount: split.driver_amount,
               full_fare: fullFare, promo_covered: promoCovered,
               lpg_product_cost: lpgCost, total_paid: totalPaid,
               cash_to_collect: cashToCollect, credit_applied: creditUsed,
               sugonow_cut: sugonowCut,
               // Itemized so the driver sees every deduction (−) and reimbursement (+):
               commission_amount: split.commission_amount,   // − from wallet
               commission_rate_pct: Math.round((split.commission_rate ?? commRate) * 100), // e.g. 15
               booking_fee: bookingFee,                       // − from wallet
               credit_reimbursement: creditUsed,              // + to wallet (credit used)
               voucher_reimbursement: voucherDiscount,        // + to wallet (voucher used)
               driver_wallet_balance: dwallet,
               wallet_low: dwallet < 50,
               receipt });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /bookings/:id/rate — customer rates or reports driver ──────────────
router.post('/:id/rate', authenticate, requireRole('customer'), async (req, res) => {
  try {
    const { stars, comment, is_report, report_type } = req.body;
    const { rows: b } = await query(
      'SELECT driver_id FROM bookings WHERE id=$1 AND customer_id=$2',
      [req.params.id, req.user.id]
    );
    if (!b[0]?.driver_id) return res.status(400).json({ success: false, message: 'No driver to rate.' });

    await query(
      `INSERT INTO ratings (booking_id, customer_id, driver_id, stars, comment, is_report, report_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [req.params.id, req.user.id, b[0].driver_id,
       is_report ? null : (parseInt(stars) || 5),
       comment || null, !!is_report, report_type || null]
    );

    // Update driver average rating (only for non-reports)
    if (!is_report) {
      await query(
        `UPDATE driver_profiles SET rating = (
           SELECT ROUND(AVG(stars)::numeric, 2) FROM ratings
           WHERE driver_id=$1 AND is_report=FALSE AND stars IS NOT NULL
         ) WHERE user_id=$1`,
        [b[0].driver_id]
      );
    }
    res.json({ success: true, message: is_report ? 'Report submitted.' : 'Thank you for rating!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PATCH /bookings/:id/cancel ──────────────────────────────────────────────
router.patch('/:id/cancel', authenticate, async (req, res) => {
  try {
    // Capture driver + stage BEFORE cancelling (so we can notify the driver)
    const { rows: pre } = await query(
      `SELECT driver_id, status, customer_id, customer_id AS cust,
              COALESCE(wallet_credit_used, 0) AS wallet_credit_used,
              goods_purchased
       FROM bookings
       WHERE id=$1 AND (customer_id=$2 OR driver_id=$2)`,
      [req.params.id, req.user.id]);
    const driverId = pre[0]?.driver_id || null;
    const cancelledByCustomer = pre[0] && pre[0].customer_id === req.user.id;
    const creditUsed = parseFloat(pre[0]?.wallet_credit_used || 0);

    // If the driver already bought the goods, the customer can't silently cancel
    // in-app — a fee applies and the driver must report the outcome. Tell them.
    if (cancelledByCustomer && pre[0]?.goods_purchased) {
      return res.status(409).json({ success: false,
        message: 'Your driver has already bought the goods. Please contact your driver — a cancellation fee applies and the driver will process it.' });
    }

    const { rows } = await query(
      `UPDATE bookings SET status='cancelled', updated_at=NOW()
       WHERE id=$1 AND (customer_id=$2 OR driver_id=$2)
         AND status IN ('pending','accepted','arrived')
       RETURNING id`,
      [req.params.id, req.user.id]
    );
    if (!rows[0]) {
      // Distinguish "already underway" from "already gone" for a clear message.
      const st = pre[0]?.status;
      if (st === 'in_progress' || st === 'waiting') {
        return res.status(409).json({ success: false,
          message: 'This booking is already out for delivery / on the way and can no longer be cancelled.' });
      }
      if (st === 'completed') {
        return res.status(409).json({ success: false, message: 'This booking is already completed.' });
      }
      if (st === 'cancelled') {
        return res.json({ success: true, alreadyCancelled: true });  // idempotent
      }
      return res.status(400).json({ success: false, message: 'Cannot cancel this booking.' });
    }

    // Notify the assigned driver so their screen frees up + they hear it
    if (driverId && cancelledByCustomer) {
      sendPush(driverId, '❌ Booking cancelled',
        'The customer cancelled this booking. You are free for new ones.',
        { type: 'booking_cancelled', bookingId: req.params.id }).catch(() => {});
    }

    // ── Refund wallet credit applied to this booking (once) ──────────────────
    // If the customer paid part of this booking from their wallet, give it back
    // since the booking won't happen. Guarded: we only refund the amount stored
    // on the booking, then zero it so a double-cancel can't double-refund.
    if (creditUsed > 0 && pre[0]?.customer_id) {
      try {
        await G.addWalletCredit(pre[0].customer_id, creditUsed, 'refund',
          `Refund: booking ${req.params.id} cancelled`);
        await query(`UPDATE bookings SET wallet_credit_used = 0 WHERE id=$1`, [req.params.id]);
      } catch (e) { console.log('wallet refund failed', e?.message); }
    }

    // ── Cancellation cooldown (customers only) ──────────────────────────────
    // Free before a driver accepts. After accept/arrived it counts. Count this
    // week's cancellations (an arrived-then-cancel counts double); 3+ -> 2h
    // pause, 5+ -> 24h pause. Pause, not a fee (cash economy). The create-
    // booking route reads cancel_cooldown_until and blocks new bookings.
    let warning = null;
    const cd = await cooldownSettings();
    const lateStage = pre[0] && (pre[0].status === 'accepted' || pre[0].status === 'arrived');
    if (cd.active && cd.soft_count > 0 && cancelledByCustomer && lateStage) {
      const { rows: cc } = await query(
        `SELECT COUNT(*) FILTER (
                  WHERE status='cancelled'
                  AND updated_at >= date_trunc('week', NOW() AT TIME ZONE 'Asia/Manila')
                )::int AS week_n
         FROM bookings WHERE customer_id=$1`, [req.user.id]);
      const weekN = cc[0]?.week_n ?? 0;
      const weighted = weekN + (pre[0].status === 'arrived' ? 1 : 0);  // arrived counts double
      const fmtH = (h) => h >= 1 ? `${h % 1 === 0 ? h : h.toFixed(1)} hour${h === 1 ? '' : 's'}` : `${Math.round(h * 60)} minutes`;
      if (cd.hard_count > 0 && weighted >= cd.hard_count) {
        const until = new Date(Date.now() + cd.hard_hours * 3600 * 1000);
        await query(`UPDATE users SET cancel_cooldown_until=$1 WHERE id=$2`, [until, req.user.id]);
        warning = `Too many cancellations this week. New bookings are paused for ${fmtH(cd.hard_hours)}.`;
      } else if (weighted >= cd.soft_count) {
        const until = new Date(Date.now() + cd.soft_hours * 3600 * 1000);
        await query(`UPDATE users SET cancel_cooldown_until=$1 WHERE id=$2`, [until, req.user.id]);
        warning = `That is several cancellations this week. New bookings are paused for ${fmtH(cd.soft_hours)}.`;
      } else if (weighted === cd.soft_count - 1 && cd.soft_count >= 2) {
        warning = 'Please cancel only when needed — repeated cancellations pause new bookings.';
      }
    }
    res.json({ success: true, warning });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /bookings/pending-request — driver polls ────────────────────────────
router.get('/pending-request', authenticate, requireVerifiedDriver, async (req, res) => {
  try {
    // Prepaid-wallet gate: a driver with an empty wallet can't take bookings
    // (commission is deducted from the wallet on completion). This replaces the
    // retired commission-lockout system.
    const wbal = await G.getDriverWallet(req.user.id);
    if (!(wbal > 0)) return res.json({ success: true, booking: null, wallet_empty: true });

    const { rows } = await query(
      `SELECT b.id, b.service_type, b.pickup_address, b.dropoff_address,
              b.stopover_address, b.has_stopover, b.estimated_fare,
              b.passenger_count, b.payment_method, b.custom_note, b.custom_photo_url, b.location_note, b.unlisted_store,
              b.pickup_lat, b.pickup_lng, b.dropoff_lat, b.dropoff_lng,
              b.distance_km AS trip_distance_km,
              u.full_name AS customer_name,
              dp.current_lat AS driver_lat, dp.current_lng AS driver_lng
       FROM bookings b
       JOIN dispatch_attempts da ON da.booking_id=b.id
       JOIN users u ON u.id=b.customer_id
       LEFT JOIN driver_profiles dp ON dp.user_id=$1
       WHERE da.driver_id=$1 AND da.status='notified'
         AND b.status='pending'
         AND da.notified_at > NOW() - INTERVAL '25 seconds'
       ORDER BY da.notified_at DESC LIMIT 1`,
      [req.user.id]
    );
    let booking = rows[0] ?? null;
    if (booking) {
      // Compute driver -> pickup distance live so the driver sees it BEFORE accepting
      if (booking.driver_lat && booking.driver_lng && booking.pickup_lat && booking.pickup_lng) {
        const R = 6371, toRad = d => d * Math.PI / 180;
        const dLa = toRad(booking.pickup_lat - booking.driver_lat);
        const dLo = toRad(booking.pickup_lng - booking.driver_lng);
        const a = Math.sin(dLa/2)**2 +
                  Math.cos(toRad(booking.driver_lat)) * Math.cos(toRad(booking.pickup_lat)) *
                  Math.sin(dLo/2)**2;
        booking.pickup_distance_km = Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)) * 100) / 100;
      }
      // For food orders, tell the driver how much CASH to front at the store.
      if (booking.service_type === 'food') {
        const { rows: oi } = await query(
          `SELECT COALESCE(SUM(unit_price * quantity),0) AS order_value
           FROM order_items WHERE booking_id=$1`, [booking.id]);
        booking.order_value = Math.round(parseFloat(oi[0]?.order_value || 0));
      }
    }
    res.json({ success: true, booking });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /bookings/active — driver's current active booking ──────────────────
router.get('/active', authenticate, requireVerifiedDriver, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT b.*, u.full_name AS customer_name, u.mobile AS customer_mobile
       FROM bookings b JOIN users u ON u.id=b.customer_id
       WHERE b.driver_id=$1 AND b.status IN ('accepted','arrived','in_progress','waiting')
       ORDER BY b.updated_at DESC LIMIT 1`,
      [req.user.id]
    );
    const booking = rows[0] ?? null;
    if (booking) {
      const { rows: items } = await query(
        `SELECT id, product_name, quantity, unit_price, options_text, status
         FROM order_items WHERE booking_id=$1 ORDER BY created_at`,
        [booking.id]
      );
      booking.order_items = items;
      // Product cost the driver fronts at the store (food/store orders): sum of
      // the items they'll actually buy — excludes removed / unavailable /
      // substituted-original rows. Computed live from the current items, so it
      // reflects the latest total after any add / remove / substitute.
      booking.products_total = Math.round(
        items
          .filter(i => i.status === 'ok' || i.status == null)
          .reduce((sum, i) => sum + parseFloat(i.unit_price || 0) * (i.quantity || 0), 0)
      );
      // ── Cash the driver should physically collect ──
      // = fare + LPG product cost + booking fee  −  any SugoNow credit the
      //   customer already applied. SugoNow reimburses the credit portion to the
      //   driver's wallet at completion, so collecting only this cash is correct.
      const fare = parseFloat(booking.estimated_fare ?? 0);
      const lpg  = parseFloat(booking.lpg_product_cost ?? 0);
      const bfee = parseFloat(booking.booking_fee ?? 0);
      const credit = parseFloat(booking.wallet_credit_used ?? 0);
      booking.cash_to_collect = Math.max(0, fare + lpg + bfee - credit);
      booking.credit_applied  = credit;   // so the app can explain the reduction
      if (booking.price_approval_status === 'pending' && booking.price_requested_at) {
        const mins = await getApprovalTimeoutMin();
        const elapsed = (Date.now() - new Date(booking.price_requested_at).getTime()) / 1000;
        booking.price_seconds_left = Math.max(0, Math.round(mins * 60 - elapsed));
      }
    }
    res.json({ success: true, booking });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /bookings/my-active — the CUSTOMER's current active booking ─────────
// Used to restore the tracking screen after an app crash/close/reopen.
router.get('/my-active', authenticate, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT b.*,
              du.full_name  AS driver_name,
              dp.plate_number,
              dp.rating     AS driver_rating,
              dp.current_lat AS driver_lat,
              dp.current_lng AS driver_lng
       FROM bookings b
       LEFT JOIN users du ON du.id = b.driver_id
       LEFT JOIN driver_profiles dp ON dp.user_id = b.driver_id
       WHERE b.customer_id = $1
         AND b.status IN ('pending','accepted','arrived','in_progress','waiting')
       ORDER BY b.created_at DESC LIMIT 1`,
      [req.user.id]
    );
    res.json({ success: true, booking: rows[0] ?? null });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /bookings/history ────────────────────────────────────────────────────
router.get('/history', authenticate, async (req, res) => {
  try {
    const field = req.user.role === 'driver' ? 'driver_id' : 'customer_id';
    const { rows } = await query(
      `SELECT * FROM bookings WHERE ${field}=$1 ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json({ success: true, bookings: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Custom/pasabuy price approval ──────────────────────────────────────────
// Driver found the actual price at the store and it's OVER the customer's
// ceiling. Record it and flag the booking so the customer is asked to approve.
router.patch('/:id/request-price-approval', authenticate, requireVerifiedDriver, async (req, res) => {
  try {
    const actual = parseFloat(req.body.actual_price);
    if (!actual || actual <= 0) return res.status(400).json({ success: false, message: 'Enter the actual price.' });
    const { rows } = await query(
      `UPDATE bookings SET actual_price=$1, price_approval_status='pending', price_requested_at=NOW()
       WHERE id=$2 AND driver_id=$3 AND status IN ('accepted','arrived','in_progress')
       RETURNING customer_id, price_ceiling`,
      [actual, req.params.id, req.user.id]);
    if (!rows[0]) return res.status(400).json({ success: false, message: 'Could not request approval for this booking.' });
    // Notify the customer (their tracking screen also polls and will show the prompt).
    sendPush(rows[0].customer_id, '💰 Price approval needed',
      `The actual price is ₱${Math.round(actual)} (your max was ₱${Math.round(rows[0].price_ceiling || 0)}). Open SugoNow to approve or cancel.`)
      .catch(() => {});
    res.json({ success: true, message: 'Customer asked to approve.' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Driver marks that they have PURCHASED the goods. This is the point after which
// a customer refusal incurs a cancellation fee.
router.patch('/:id/mark-purchased', authenticate, requireVerifiedDriver, async (req, res) => {
  try {
    const { rows } = await query(
      `UPDATE bookings SET goods_purchased=TRUE
       WHERE id=$1 AND driver_id=$2 AND status IN ('accepted','arrived','in_progress')
       RETURNING id`,
      [req.params.id, req.user.id]);
    if (!rows[0]) return res.status(400).json({ success: false, message: 'Could not mark this booking.' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Driver reports the customer REFUSED after the goods were bought. Computes the
// two-tier fee, cancels the booking, and records the fee against the customer.
router.patch('/:id/customer-refused', authenticate, requireVerifiedDriver, async (req, res) => {
  try {
    const returnable = req.body.returnable === true;
    const { rows: bk } = await query(
      `SELECT customer_id, actual_price, price_ceiling, goods_purchased
       FROM bookings WHERE id=$1 AND driver_id=$2
         AND status IN ('accepted','arrived','in_progress')`,
      [req.params.id, req.user.id]);
    if (!bk[0]) return res.status(400).json({ success: false, message: 'Could not process this booking.' });
    if (!bk[0].goods_purchased) return res.status(400).json({ success: false, message: 'Mark the goods as purchased first.' });

    // Base fee (admin-adjustable).
    const { rows: cfg } = await query(`SELECT value FROM app_settings WHERE key='custom_cancel_fee' LIMIT 1`);
    const baseFee = parseFloat(cfg[0]?.value) >= 0 ? parseFloat(cfg[0]?.value) : 50;
    // Goods value = the actual price if known, else the ceiling.
    const goodsVal = parseFloat(bk[0].actual_price ?? bk[0].price_ceiling ?? 0);
    // Two-tier: returnable -> just the fee; non-returnable -> goods + fee.
    const feeOwed = returnable ? baseFee : (goodsVal + baseFee);

    // Claim the booking FIRST (conditional flip) so a double-tap can't add the
    // cancellation fee to the customer twice.
    const { rowCount: claimed } = await query(
      `UPDATE bookings SET status='cancelled', updated_at=NOW(),
              goods_returnable=$1, cancellation_fee_owed=$2
       WHERE id=$3 AND status IN ('accepted','arrived','in_progress')`,
      [returnable, feeOwed, req.params.id]);
    if (claimed === 0) {
      return res.status(409).json({ success: false, message: 'This booking was already processed.' });
    }
    // Record the amount owed against the customer; blocks future bookings.
    await query(
      `UPDATE users SET unpaid_cancel_fee = COALESCE(unpaid_cancel_fee,0) + $1 WHERE id=$2`,
      [feeOwed, bk[0].customer_id]);

    sendPush(bk[0].customer_id, '⚠️ Cancellation fee',
      `Because you didn't accept your custom order after the driver bought it, a fee of ₱${Math.round(feeOwed)} applies. Please settle it at the SugoNow office before booking again.`)
      .catch(() => {});
    res.json({ success: true, fee_owed: feeOwed, returnable });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Driver cancels a custom order because the customer never answered the price
// request. NO penalty to the customer (they didn't do anything wrong) and the
// driver bought nothing. Frees both sides.
router.patch('/:id/cancel-no-approval', authenticate, requireVerifiedDriver, async (req, res) => {
  try {
    const { rows } = await query(
      `UPDATE bookings SET status='cancelled', updated_at=NOW(),
              price_approval_status='rejected'
       WHERE id=$1 AND driver_id=$2 AND status IN ('accepted','arrived','in_progress')
         AND price_approval_status='pending'
       RETURNING customer_id`,
      [req.params.id, req.user.id]);
    if (!rows[0]) return res.status(400).json({ success: false, message: 'Could not cancel this booking.' });
    sendPush(rows[0].customer_id, '❌ Order cancelled',
      'Your custom order was cancelled because the price approval was not answered in time. No charge — feel free to book again.',
      { type: 'booking_cancelled', bookingId: req.params.id }).catch(() => {});
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Customer approves or rejects the over-ceiling actual price.
router.patch('/:id/price-decision', authenticate, async (req, res) => {
  try {
    const decision = req.body.decision === 'approve' ? 'approved' : 'rejected';
    const { rows } = await query(
      `UPDATE bookings SET price_approval_status=$1
       WHERE id=$2 AND customer_id=$3 AND price_approval_status='pending'
       RETURNING driver_id, actual_price`,
      [decision, req.params.id, req.user.id]);
    if (!rows[0]) return res.status(400).json({ success: false, message: 'No pending price request found.' });
    // Tell the driver the customer's decision.
    sendPush(rows[0].driver_id,
      decision === 'approved' ? '✅ Price approved' : '🚫 Price rejected',
      decision === 'approved'
        ? `Customer approved ₱${Math.round(rows[0].actual_price)}. You may buy it now.`
        : 'Customer declined the price. Do NOT buy — return to the app.')
      .catch(() => {});
    res.json({ success: true, status: decision });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Current fares for display in the customer Terms (so Terms always match what
// the app actually charges). Read-only.
router.get('/fare-config', authenticate, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT key, value FROM app_settings
       WHERE key IN ('fare_base_food','fare_base_lpg','fare_base_water','fare_base_custom','custom_errand_premium')`);
    const m = {}; for (const r of rows) m[r.key] = parseFloat(r.value);
    const z = await query(`SELECT base_fare, per_km_rate FROM zones WHERE slug='flora' LIMIT 1`);
    res.json({ success: true,
      ride_base: parseFloat(z.rows[0]?.base_fare ?? 25),
      per_km:    parseFloat(z.rows[0]?.per_km_rate ?? 8),
      food:   isNaN(m.fare_base_food)   ? 20 : m.fare_base_food,
      lpg:    isNaN(m.fare_base_lpg)    ? 40 : m.fare_base_lpg,
      water:  isNaN(m.fare_base_water)  ? 30 : m.fare_base_water,
      custom: isNaN(m.fare_base_custom) ? 20 : m.fare_base_custom,
      errand_premium: isNaN(m.custom_errand_premium) ? 15 : m.custom_errand_premium });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;
// Attach helpers AFTER assigning router (assigning module.exports = router
// above would otherwise wipe these). adminMega.js imports these.
module.exports.cooldownSettings = cooldownSettings;
module.exports._bustCooldownCache = () => { _cdCache.at = 0; };
