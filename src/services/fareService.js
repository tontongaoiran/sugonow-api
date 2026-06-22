/**
 * SugoNow — src/services/fareService.js (MEGA)
 *
 * Pricing model (updated):
 * - Base fare MULTIPLIES by passengers: ₱25 × passengers (25/50/75 for 1/2/3)
 * - Distance charged ONCE (not multiplied by passengers): ₱8/km
 * - Stopover: ₱3 per minute of waiting time
 * - 10% first-booking discount
 */
const { query } = require('../db/pool');

const haversineKm = (lat1, lng1, lat2, lng2) => {
  const R  = 6371;
  const dL = ((lat2 - lat1) * Math.PI) / 180;
  const dG = ((lng2 - lng1) * Math.PI) / 180;
  const a  = Math.sin(dL/2)**2 +
             Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dG/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
};

const STOPOVER_RATE_PER_MIN = 3; // ₱3/min waiting

// Flat delivery base fares (NOT multiplied by passengers).
// LPG and deliveries use a flat base + distance, per SugoNow pricing.
// Delivery base fares are admin-editable via app_settings (Fares & Fees), so
// they can be raised during fuel-price/inflation swings without a code change.
// Defaults below match launch pricing and are used if a setting is missing.
const DELIVERY_BASE_DEFAULTS = {
  exchange: 40,   // LPG
  water: 30,      // water refill
  delivery: 20,   // package/store delivery (follows 'food')
  food:     20,   // food / store delivery
  custom:   20,   // custom / pasabuy errand
};
// app_settings keys -> service types. 'food' also drives generic 'delivery'.
let _fareCache = { v: null, t: 0 };
async function getDeliveryBases() {
  if (_fareCache.v && Date.now() - _fareCache.t < 30000) return _fareCache.v;
  const bases = { ...DELIVERY_BASE_DEFAULTS };
  try {
    const { rows } = await query(
      `SELECT key, value FROM app_settings
       WHERE key IN ('fare_base_food','fare_base_lpg','fare_base_water','fare_base_custom')`);
    const m = {};
    for (const r of rows) { const n = parseFloat(r.value); if (!isNaN(n) && n >= 0) m[r.key] = n; }
    if (m.fare_base_food  != null) { bases.food = m.fare_base_food; bases.delivery = m.fare_base_food; }
    if (m.fare_base_lpg   != null) bases.exchange = m.fare_base_lpg;
    if (m.fare_base_water != null) bases.water = m.fare_base_water;
    if (m.fare_base_custom!= null) bases.custom = m.fare_base_custom;
  } catch (e) { /* fall back to defaults */ }
  _fareCache = { v: bases, t: Date.now() };
  return bases;
}

// ── Commission rate: admin-controlled via app_settings ('commission_rate',
// stored as a PERCENT e.g. '15'). Used for the Month-1 commission holiday
// (0%) -> 10% -> 15% ladder, switchable from the Fares & Fees screen with
// no restart. Cached for 30s so fares don't hammer the settings table.
let _commCache = { v: 15, t: 0 };
// ── Errand premium: extra fee for CUSTOM errands (driver shops for the item).
//    Admin-tunable via app_settings 'custom_errand_premium' (default ₱15; 0=off).
async function getErrandPremium() {
  try {
    const { rows } = await query(
      `SELECT value FROM app_settings WHERE key='custom_errand_premium'`);
    if (rows.length && rows[0].value !== '' && rows[0].value != null) {
      const v = parseFloat(rows[0].value);
      return isNaN(v) ? 15 : Math.max(0, v);
    }
  } catch (e) {}
  return 15;  // default
}

async function getCommissionRate() {
  if (Date.now() - _commCache.t < 30000) return _commCache.v;
  try {
    const { rows } = await query(
      `SELECT value FROM app_settings WHERE key='commission_rate'`);
    const v = parseFloat(rows[0]?.value);
    _commCache = { v: isNaN(v) ? 15 : v, t: Date.now() };
  } catch { _commCache.t = Date.now(); }
  return _commCache.v;
}

const getZoneFare = async (zoneSlug = 'flora') => {
  const { rows } = await query(
    'SELECT base_fare, per_km_rate FROM zones WHERE slug=$1', [zoneSlug]
  );
  return {
    base_fare:   parseFloat(rows[0]?.base_fare   ?? 25),
    per_km_rate: parseFloat(rows[0]?.per_km_rate ?? 8),
  };
};

const calculateFare = async ({
  driverLat, driverLng, pickupLat, pickupLng, dropLat, dropLng,
  stopoverLat, stopoverLng, stopoverWaitMin = 0,
  serviceType = 'ride', zone = 'flora',
  passengerCount = 1, isFirstBooking = false,
  surgeMultiplier = 1.0, surgeActive = false,
  includePickupCharge = false,
  containerCount = 1,
  tankCount = 1,
}) => {
  const { base_fare, per_km_rate } = await getZoneFare(zone);
  const passengers = Math.min(3, Math.max(1, parseInt(passengerCount) || 1));

  // Pickup distance (driver → pickup). Charged to the customer only once a
  // driver is assigned (includePickupCharge=true at finalize time).
  const pickupDistKm = (driverLat && driverLng)
    ? haversineKm(driverLat, driverLng, pickupLat, pickupLng) : 0;
  const pickupCharge = includePickupCharge ? Math.round(pickupDistKm * per_km_rate) : 0;

  // Trip distance — if stopover exists, route is pickup → stopover → drop
  let tripDistKm = 0;
  if (stopoverLat && stopoverLng && dropLat && dropLng) {
    tripDistKm = haversineKm(pickupLat, pickupLng, stopoverLat, stopoverLng)
               + haversineKm(stopoverLat, stopoverLng, dropLat, dropLng);
  } else if (dropLat && dropLng) {
    tripDistKm = haversineKm(pickupLat, pickupLng, dropLat, dropLng);
  }

  // PRICING:
  //  - Rides: base × passengers + distance (charged once)
  //  - Deliveries/LPG: flat delivery base + distance (no passenger multiplier)
  const isDelivery = ['exchange', 'water', 'delivery', 'food', 'custom'].includes(serviceType);

  const DELIVERY_BASE = await getDeliveryBases();
  let baseTotal, distanceCharge, fare;
  const distChargeRaw = tripDistKm * per_km_rate;

  if (isDelivery) {
    // Flat base + distance. No passenger multiplier, no extra service multiplier.
    baseTotal      = DELIVERY_BASE[serviceType] ?? 50;
    distanceCharge = distChargeRaw;
    // Water: +₱10 per extra container beyond the first (max 3 containers).
    if (serviceType === 'water') {
      const containers = Math.min(3, Math.max(1, parseInt(containerCount) || 1));
      baseTotal += (containers - 1) * 10;
    }
    // LPG: up to 3 tanks. Each EXTRA tank adds ₱20 flat. The per-km distance
    // charge is counted ONCE for the whole trip (one delivery run), NOT per
    // tank. 1 tank = normal pricing.
    if (serviceType === 'exchange') {
      const tanks = Math.min(3, Math.max(1, parseInt(tankCount) || 1));
      baseTotal += (tanks - 1) * 20;                 // +₱20 per extra tank
      // distanceCharge stays = distChargeRaw (single per-km for the trip)
    }
    fare = Math.round(baseTotal + distanceCharge);
  } else {
    // Ride pricing: base × passengers + distance
    baseTotal      = base_fare * passengers;          // 25/50/75
    distanceCharge = distChargeRaw;                   // charged once
    fare = Math.round(baseTotal + distanceCharge);
  }

  // Stopover waiting charge
  const stopoverCharge = Math.round((parseInt(stopoverWaitMin) || 0) * STOPOVER_RATE_PER_MIN);
  fare += stopoverCharge;
  fare = Math.max(baseTotal, fare); // never below base

  // Custom errand premium (driver shops for the item) — custom orders only.
  let errandPremium = 0;
  if (serviceType === 'custom') {
    errandPremium = await getErrandPremium();
    fare += errandPremium;
  }

  // Pickup distance charge (driver → pickup), added when finalizing on accept
  fare += pickupCharge;

  // Surge pricing (applied system-wide when admin toggles it on)
  let surgeAmount = 0;
  if (surgeActive && surgeMultiplier > 1.0) {
    const surged = Math.round(fare * surgeMultiplier);
    surgeAmount  = surged - fare;
    fare = surged;
  }

  // NOTE: the old "first ride 10% discount" promo has been removed and replaced
  // by the Batch E growth engine (earn-credit, referrals, vouchers).
  const discount = 0, discountNote = null;

  const commRatePct = await getCommissionRate();
  const commission = Math.round(fare * commRatePct / 100);

  return {
    base_fare, per_km_rate,
    base_total:         baseTotal,
    passenger_count:    passengers,
    pickup_distance_km: Math.round(pickupDistKm * 100) / 100,
    pickup_distance_fare: pickupCharge,
    trip_distance_km:   Math.round(tripDistKm   * 100) / 100,
    total_distance_km:  Math.round(tripDistKm   * 100) / 100,
    distance_charge:    Math.round(distanceCharge),
    stopover_wait_min:  parseInt(stopoverWaitMin) || 0,
    stopover_charge:    stopoverCharge,
    errand_premium:     errandPremium,
    tank_count:         serviceType === 'exchange' ? Math.min(3, Math.max(1, parseInt(tankCount) || 1)) : 1,
    surge_active:       surgeActive && surgeMultiplier > 1.0,
    surge_amount:       surgeAmount,
    surge_multiplier:   surgeActive ? surgeMultiplier : 1.0,
    subtotal:           fare + discount,
    discount_amount:    discount,
    discount_note:      discountNote,
    total_fare:         fare,
    is_delivery:        isDelivery,
    delivery_fee:       isDelivery ? fare : 0,
    commission_rate_pct: commRatePct,
    commission_amount:  commission,
    driver_amount:      fare - commission,
    fare_breakdown:     isDelivery
                        ? `₱${baseTotal} base + ₱${Math.round(distanceCharge)} distance` +
                          (errandPremium > 0 ? ` + ₱${errandPremium} errand fee` : '') +
                          (stopoverCharge > 0 ? ` + ₱${stopoverCharge} waiting` : '')
                        : `₱${base_fare}×${passengers} = ₱${baseTotal} base + ₱${Math.round(distanceCharge)} distance` +
                          (stopoverCharge > 0 ? ` + ₱${stopoverCharge} waiting` : ''),
    note: isDelivery
          ? `Delivery: ₱${baseTotal} base fare`
          : `${passengers} passenger(s): base fare ₱${baseTotal}`,
  };
};

const isFirstBooking = async (customerId) => {
  const { rows } = await query(
    "SELECT COUNT(*)::int AS total FROM bookings WHERE customer_id=$1 AND status='completed'",
    [customerId]
  );
  return rows[0].total === 0;
};

const splitFare = (totalFare, rate = 0.15) => ({
  total_fare:        totalFare,
  commission_amount: Math.round(totalFare * rate),
  driver_amount:     totalFare - Math.round(totalFare * rate),
  commission_rate:   rate,
});

module.exports = {
  calculateFare, isFirstBooking, splitFare, getCommissionRate,
  haversineKm, getZoneFare, STOPOVER_RATE_PER_MIN,
};
