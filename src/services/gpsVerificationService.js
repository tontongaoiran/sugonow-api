/**
 * SugoNow — src/services/gpsVerificationService.js
 *
 * GPS Movement Verification System
 * ─────────────────────────────────────────────────────────────────
 * Prevents ghost rides by verifying real movement during every trip.
 *
 * How it works:
 *  1. When driver starts a ride → GPS pings recorded every 10s via Firebase
 *  2. When driver attempts to complete → verifyRideMovement() is called
 *  3. System checks: total distance, ping count, speed plausibility
 *  4. If verification fails → completion is blocked, fraud flag raised
 *  5. All pings stored in ride_gps_pings for audit trail
 *
 * Ghost ride detection rules:
 *  - Minimum distance: 0.2 km (configurable)
 *  - Minimum pings: 2 per km of route
 *  - Speed sanity: no ping-to-ping jump > 60 km/h (tricycle max)
 *  - Pickup proximity: driver must have been within 100m of pickup point
 *  - Dropoff proximity: driver must have been within 150m of dropoff point
 */

const { query, withTransaction } = require('../db/pool');
const { sendSms }                = require('./smsService');

// Haversine distance in km between two coordinates
const haversineKm = (lat1, lng1, lat2, lng2) => {
  const R  = 6371;
  const dL = ((lat2 - lat1) * Math.PI) / 180;
  const dG = ((lng2 - lng1) * Math.PI) / 180;
  const a  =
    Math.sin(dL / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dG / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

// Load config value from DB
const getConfigVal = async (key, fallback) => {
  try {
    const { rows } = await query('SELECT value FROM app_config WHERE key = $1', [key]);
    return rows[0] ? parseFloat(rows[0].value) : fallback;
  } catch {
    return fallback;
  }
};

// ─── Store a single GPS ping during an active ride ─────────────────────────
// Called from drivers route PATCH /location when booking_id is present
const recordPing = async (bookingId, driverId, lat, lng, accuracyM = null, speedKmh = null) => {
  await query(
    `INSERT INTO ride_gps_pings (booking_id, driver_id, lat, lng, accuracy_m, speed_kmh)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [bookingId, driverId, lat, lng, accuracyM, speedKmh]
  );
  // Increment ping count on booking
  await query(
    'UPDATE bookings SET gps_ping_count = gps_ping_count + 1 WHERE id = $1',
    [bookingId]
  );
};

// ─── Full movement verification at ride completion ─────────────────────────
const verifyRideMovement = async (bookingId) => {
  // Load booking details
  const { rows: bRows } = await query(
    `SELECT b.id, b.driver_id, b.customer_id,
            b.pickup_lat, b.pickup_lng,
            b.dropoff_lat, b.dropoff_lng,
            b.distance_km, b.gps_ping_count,
            b.service_type, b.payment_method,
            u.mobile AS driver_mobile, u.full_name AS driver_name
     FROM bookings b
     JOIN users u ON u.id = b.driver_id
     WHERE b.id = $1`,
    [bookingId]
  );
  if (!bRows[0]) return { verified: false, reason: 'Booking not found.' };
  const booking = bRows[0];

  // Load all GPS pings for this ride
  const { rows: pings } = await query(
    `SELECT lat, lng, speed_kmh, recorded_at
     FROM ride_gps_pings
     WHERE booking_id = $1
     ORDER BY recorded_at ASC`,
    [bookingId]
  );

  // Load thresholds from config
  const [minDistance, minPingsPerKm, maxSpeedKmh] = await Promise.all([
    getConfigVal('ghost_ride_min_distance', 0.2),   // km
    getConfigVal('min_gps_pings_per_km',   2),
    60,   // max tricycle speed km/h
  ]);

  const issues = [];
  const routeKm = parseFloat(booking.distance_km ?? 0);

  // ── Check 1: Minimum ping count ──────────────────────────────────────────
  const minPingsRequired = Math.max(3, Math.ceil(routeKm * minPingsPerKm));
  if (pings.length < minPingsRequired) {
    issues.push({
      type:     'insufficient_pings',
      severity: 'high',
      detail:   `Only ${pings.length} pings recorded, expected ≥ ${minPingsRequired} for ${routeKm} km route.`,
    });
  }

  // ── Check 2: Total distance covered ──────────────────────────────────────
  let totalDistKm = 0;
  for (let i = 1; i < pings.length; i++) {
    totalDistKm += haversineKm(
      parseFloat(pings[i - 1].lat), parseFloat(pings[i - 1].lng),
      parseFloat(pings[i].lat),     parseFloat(pings[i].lng)
    );
  }
  totalDistKm = Math.round(totalDistKm * 100) / 100;

  if (totalDistKm < minDistance) {
    issues.push({
      type:     'insufficient_movement',
      severity: 'critical',
      detail:   `Driver only moved ${totalDistKm} km. Minimum is ${minDistance} km.`,
    });
  }

  // ── Check 3: Speed sanity (no teleportation) ──────────────────────────────
  for (let i = 1; i < pings.length; i++) {
    const dist  = haversineKm(
      parseFloat(pings[i - 1].lat), parseFloat(pings[i - 1].lng),
      parseFloat(pings[i].lat),     parseFloat(pings[i].lng)
    );
    const timeDiffHours =
      (new Date(pings[i].recorded_at) - new Date(pings[i - 1].recorded_at)) / 3600000;
    if (timeDiffHours > 0) {
      const speed = dist / timeDiffHours;
      if (speed > maxSpeedKmh) {
        issues.push({
          type:     'impossible_speed',
          severity: 'high',
          detail:   `GPS jump of ${dist.toFixed(2)} km in ${(timeDiffHours * 60).toFixed(1)} min = ${speed.toFixed(0)} km/h. Tricycles max at ${maxSpeedKmh} km/h.`,
        });
        break; // one is enough to flag
      }
    }
  }

  // ── Check 4: Pickup proximity ─────────────────────────────────────────────
  if (booking.pickup_lat && pings.length > 0) {
    const closestToPickup = Math.min(...pings.map(p =>
      haversineKm(parseFloat(p.lat), parseFloat(p.lng),
        parseFloat(booking.pickup_lat), parseFloat(booking.pickup_lng)) * 1000 // metres
    ));
    if (closestToPickup > 150) {
      issues.push({
        type:     'never_at_pickup',
        severity: 'high',
        detail:   `Driver never came within 150m of pickup. Closest: ${closestToPickup.toFixed(0)}m.`,
      });
    }
  }

  // ── Check 5: Dropoff proximity ────────────────────────────────────────────
  if (booking.dropoff_lat && pings.length > 0) {
    const closestToDropoff = Math.min(...pings.map(p =>
      haversineKm(parseFloat(p.lat), parseFloat(p.lng),
        parseFloat(booking.dropoff_lat), parseFloat(booking.dropoff_lng)) * 1000
    ));
    if (closestToDropoff > 200) {
      issues.push({
        type:     'never_at_dropoff',
        severity: 'medium',
        detail:   `Driver never came within 200m of dropoff. Closest: ${closestToDropoff.toFixed(0)}m.`,
      });
    }
  }

  // ── Decision ──────────────────────────────────────────────────────────────
  const criticalIssues = issues.filter(i => i.severity === 'critical');
  const highIssues     = issues.filter(i => i.severity === 'high');
  const verified       = criticalIssues.length === 0 && highIssues.length === 0;

  // Update booking with verification result
  await query(
    `UPDATE bookings
     SET gps_verified      = $1,
         total_distance_km = $2,
         fraud_flag        = $3,
         fraud_reason      = $4,
         updated_at        = NOW()
     WHERE id = $5`,
    [
      verified,
      totalDistKm,
      !verified,
      issues.length > 0 ? issues.map(i => i.detail).join(' | ') : null,
      bookingId,
    ]
  );

  // Log fraud flags for admin review
  if (!verified) {
    for (const issue of issues) {
      await query(
        `INSERT INTO fraud_flags
           (driver_id, booking_id, flag_type, severity, details)
         VALUES ($1, $2, $3, $4, $5)`,
        [booking.driver_id, bookingId, issue.type, issue.severity, issue.detail]
      );
    }

    // Alert admin via SMS for critical/high issues
    const critOrHigh = issues.filter(i => ['critical','high'].includes(i.severity));
    if (critOrHigh.length > 0) {
      const { rows: adminRows } = await query(
        `SELECT mobile FROM users WHERE role = 'admin' LIMIT 1`
      );
      if (adminRows[0]) {
        await sendSms(
          adminRows[0].mobile,
          `SugoNow FRAUD ALERT: Booking ${bookingId.slice(0,8)} — ` +
          `Driver ${booking.driver_name} failed GPS verification. ` +
          `Issues: ${critOrHigh.map(i => i.type).join(', ')}. Review in admin panel.`
        );
      }
    }
  }

  return {
    verified,
    total_distance_km: totalDistKm,
    ping_count:        pings.length,
    issues,
    can_complete:      verified || issues.every(i => i.severity === 'low'),
  };
};

// ─── Auto-flag suspicious patterns across multiple rides ───────────────────
// Run this as a daily cron job: node -e "require('./gpsVerificationService').dailyFraudScan()"
const dailyFraudScan = async () => {
  console.log('[FraudScan] Starting daily scan...');

  // Drivers completing rides suspiciously fast
  const { rows: fastRides } = await query(
    `SELECT b.driver_id, u.full_name, u.mobile,
            COUNT(*) AS suspicious_count
     FROM bookings b
     JOIN users u ON u.id = b.driver_id
     WHERE b.status = 'completed'
       AND b.started_at IS NOT NULL
       AND b.completed_at IS NOT NULL
       AND (EXTRACT(EPOCH FROM (b.completed_at - b.started_at)) / 60) < 2
       AND b.distance_km > 1
       AND b.created_at > NOW() - INTERVAL '7 days'
     GROUP BY b.driver_id, u.full_name, u.mobile
     HAVING COUNT(*) >= 3`
  );

  for (const driver of fastRides) {
    await query(
      `INSERT INTO fraud_flags (driver_id, flag_type, severity, details)
       VALUES ($1, 'suspicious_speed_pattern', 'high', $2)`,
      [
        driver.driver_id,
        `${driver.suspicious_count} rides completed in < 2 min for > 1 km route in the last 7 days.`,
      ]
    );
    console.log(`[FraudScan] Flagged driver ${driver.full_name} — fast rides: ${driver.suspicious_count}`);
  }

  // Drivers with many rides but 0 GPS pings
  const { rows: noPingRides } = await query(
    `SELECT b.driver_id, u.full_name, COUNT(*) AS count
     FROM bookings b
     JOIN users u ON u.id = b.driver_id
     WHERE b.status = 'completed'
       AND b.gps_ping_count = 0
       AND b.created_at > NOW() - INTERVAL '7 days'
     GROUP BY b.driver_id, u.full_name
     HAVING COUNT(*) >= 2`
  );

  for (const driver of noPingRides) {
    await query(
      `INSERT INTO fraud_flags (driver_id, flag_type, severity, details)
       VALUES ($1, 'zero_gps_pings', 'critical', $2)`,
      [driver.driver_id, `${driver.count} completed rides with 0 GPS pings in 7 days.`]
    );
    console.log(`[FraudScan] Flagged driver ${driver.full_name} — zero ping rides: ${driver.count}`);
  }

  console.log('[FraudScan] Done.');
};

module.exports = { recordPing, verifyRideMovement, dailyFraudScan, haversineKm };
