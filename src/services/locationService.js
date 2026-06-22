/**
 * SugoNow — src/services/locationService.js (TEST MODE PATCH)
 *
 * In TEST_MODE, location check is bypassed - always returns Flora as allowed.
 * Production behavior (strict zone check) is preserved when TEST_MODE=false.
 *
 * Adds detailed logging so we can see exact GPS coordinates received.
 */
const { query } = require('../db/pool');

const TEST_MODE = process.env.TEST_MODE === 'true';

console.log('📍 locationService loaded — TEST_MODE =', TEST_MODE);

const haversineKm = (lat1, lng1, lat2, lng2) => {
  const R  = 6371;
  const dL = ((lat2 - lat1) * Math.PI) / 180;
  const dG = ((lng2 - lng1) * Math.PI) / 180;
  const a  = Math.sin(dL/2)**2 +
             Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dG/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
};

const checkLocationAllowed = async (lat, lng) => {
  console.log(`📍 Location check — lat: ${lat}, lng: ${lng} | TEST_MODE: ${TEST_MODE}`);

  if (!lat || !lng) {
    return { allowed: false, zone: null, message: 'Location is required.' };
  }

  // In TEST MODE, always allow and return Flora zone
  if (TEST_MODE) {
    const { rows } = await query(
      `SELECT id, name, slug FROM zones WHERE slug='flora' LIMIT 1`
    );
    console.log('  ✅ TEST MODE — bypassing zone check, returning Flora');
    return {
      allowed: true,
      zone:    rows[0] || { id: null, name: 'Flora', slug: 'flora' },
      message: 'TEST MODE: All locations allowed.',
    };
  }

  // Production zone validation
  const { rows: zones } = await query(
    `SELECT id, name, slug, is_active, center_lat, center_lng, radius_km
     FROM zones ORDER BY is_active DESC, radius_km ASC`
  );

  let nearestZone = null, nearestDistKm = Infinity;

  for (const zone of zones) {
    if (!zone.center_lat || !zone.center_lng) continue;
    const distKm = haversineKm(
      parseFloat(lat), parseFloat(lng),
      parseFloat(zone.center_lat), parseFloat(zone.center_lng)
    );
    console.log(`  Distance to ${zone.name}: ${distKm.toFixed(2)} km (radius: ${zone.radius_km})`);

    if (distKm < (zone.radius_km ?? 15)) {
      if (zone.is_active) {
        return {
          allowed: true, zone,
          distance: Math.round(distKm * 10) / 10,
          message: `Welcome to SugoNow ${zone.name}!`,
        };
      } else {
        return {
          allowed: false, zone,
          message: `SugoNow is coming soon to ${zone.name}!`,
          coming_soon: true,
        };
      }
    }
    if (distKm < nearestDistKm) {
      nearestDistKm = distKm;
      nearestZone = zone;
    }
  }
  return {
    allowed: false, zone: null,
    message: `SugoNow not available in your area. Nearest zone: ${nearestZone?.name ?? 'Flora'} (${Math.round(nearestDistKm)} km away).`,
    outside_all_zones: true,
  };
};

/**
 * Which active zone (by center+radius) contains this point? Returns the zone
 * row or null. (Production logic; mirrors checkLocationAllowed's matching.)
 */
const zoneForPoint = async (lat, lng) => {
  if (lat == null || lng == null) return null;
  // In TEST MODE, mirror checkLocationAllowed: treat every point as Flora so the
  // strict center+radius math doesn't filter out landmarks/destinations during
  // testing. (Production keeps the real zone check below.)
  if (TEST_MODE) {
    const { rows } = await query(`SELECT id, name, slug FROM zones WHERE slug='flora' LIMIT 1`);
    return rows[0] || { id: null, name: 'Flora', slug: 'flora' };
  }
  const { rows: zones } = await query(
    `SELECT id, name, slug, is_active, center_lat, center_lng, radius_km
     FROM zones WHERE is_active = TRUE ORDER BY radius_km ASC`
  );
  let best = null, bestDist = Infinity;
  for (const z of zones) {
    if (!z.center_lat || !z.center_lng) continue;
    const d = haversineKm(parseFloat(lat), parseFloat(lng),
                          parseFloat(z.center_lat), parseFloat(z.center_lng));
    if (d < (z.radius_km ?? 15) && d < bestDist) { best = z; bestDist = d; }
  }
  return best;
};

/**
 * For a DELIVERY, the dropoff must be inside the SAME active zone as the pickup.
 * Rides do NOT call this (their destination can be anywhere).
 * TEST_MODE bypasses the check so testing isn't blocked.
 * Returns { allowed, message }.
 */
const checkDeliveryDestination = async (pickupLat, pickupLng, dropLat, dropLng) => {
  if (TEST_MODE) return { allowed: true, message: 'TEST MODE: destination allowed.' };
  if (dropLat == null || dropLng == null) {
    return { allowed: false, message: 'Delivery destination is required.' };
  }
  const pickupZone = await zoneForPoint(pickupLat, pickupLng);
  if (!pickupZone) {
    return { allowed: false, message: 'Pickup is outside the SugoNow service area.' };
  }
  const dropZone = await zoneForPoint(dropLat, dropLng);
  if (!dropZone || dropZone.slug !== pickupZone.slug) {
    return {
      allowed: false,
      message: `Delivery is only available within ${pickupZone.name}. Please choose a destination inside ${pickupZone.name}.`,
    };
  }
  return { allowed: true, zone: pickupZone, message: `Delivery within ${pickupZone.name}.` };
};

module.exports = { checkLocationAllowed, haversineKm, zoneForPoint, checkDeliveryDestination };