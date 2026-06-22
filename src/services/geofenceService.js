/**
 * SugoNow — src/services/geofenceService.js
 *
 * Center + radius geofencing built on the existing `zones` table
 * (center_lat, center_lng, radius_km). Self-contained: does NOT modify
 * your existing locationService. Any route can import these helpers.
 *
 * Model:
 *   - Presence: a customer/driver must be INSIDE an active zone to use the app.
 *   - Delivery destinations: must be inside the SAME zone (local only).
 *   - Rides: pickup must be in-zone; destination may be anywhere (no check).
 */
const { query } = require('../db/pool');

// Haversine distance in km
function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Load all active zones that have a center + radius defined.
async function getActiveZones() {
  const { rows } = await query(
    `SELECT slug, name, center_lat, center_lng, radius_km
       FROM zones
      WHERE is_active = TRUE
        AND center_lat IS NOT NULL
        AND center_lng IS NOT NULL
        AND radius_km IS NOT NULL`
  );
  return rows;
}

/**
 * Which active zone (if any) contains this point?
 * Returns { slug, name, distance_km } for the nearest containing zone, or null.
 */
async function zoneForPoint(lat, lng) {
  if (lat == null || lng == null) return null;
  const zones = await getActiveZones();
  let best = null;
  for (const z of zones) {
    const d = distanceKm(parseFloat(lat), parseFloat(lng),
                         parseFloat(z.center_lat), parseFloat(z.center_lng));
    if (d <= parseFloat(z.radius_km)) {
      if (!best || d < best.distance_km) {
        best = { slug: z.slug, name: z.name, distance_km: d };
      }
    }
  }
  return best;
}

/**
 * Is this point inside ANY active service area?
 * Returns { inside: bool, zone: {slug,name}|null }.
 */
async function isInServiceArea(lat, lng) {
  const z = await zoneForPoint(lat, lng);
  return { inside: !!z, zone: z ? { slug: z.slug, name: z.name } : null };
}

/**
 * For a DELIVERY, is the destination inside the same zone as the pickup?
 * (Rides skip this — destinations can be anywhere.)
 */
async function isDeliveryAllowed(pickupLat, pickupLng, dropLat, dropLng) {
  const pickupZone = await zoneForPoint(pickupLat, pickupLng);
  if (!pickupZone) return { allowed: false, reason: 'pickup_out_of_area' };
  const dropZone = await zoneForPoint(dropLat, dropLng);
  if (!dropZone) return { allowed: false, reason: 'dropoff_out_of_area', zone: pickupZone };
  if (dropZone.slug !== pickupZone.slug)
    return { allowed: false, reason: 'dropoff_other_zone', zone: pickupZone };
  return { allowed: true, zone: pickupZone };
}

module.exports = { distanceKm, getActiveZones, zoneForPoint, isInServiceArea, isDeliveryAllowed };
