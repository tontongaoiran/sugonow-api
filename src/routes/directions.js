/**
 * SugoNow — src/routes/directions.js
 *
 * Proxies Google Directions API so the driver app can draw a road-following
 * route line (not a straight line) and show live distance + ETA.
 *
 * Keeps the API key on the server. Uses the same GOOGLE_MAPS_API_KEY.
 *
 * Mount in server.js:
 *   const directionsRoutes = require('./src/routes/directions');
 *   app.use('/api/v1/directions', directionsRoutes);
 *
 * REQUIRES: "Directions API" enabled in your Google Cloud project
 * (same console where you enabled Places API). Free within the $200/mo credit.
 */
const express = require('express');
const axios   = require('axios');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY;

/**
 * Decode Google's encoded polyline into [{latitude, longitude}, ...]
 * so react-native-maps <Polyline> can draw the road-following path.
 */
function decodePolyline(encoded) {
  const points = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let b, shift = 0, result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; }
    while (b >= 0x20);
    const dlat = (result & 1) ? ~(result >> 1) : (result >> 1);
    lat += dlat;
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; }
    while (b >= 0x20);
    const dlng = (result & 1) ? ~(result >> 1) : (result >> 1);
    lng += dlng;
    points.push({ latitude: lat / 1e5, longitude: lng / 1e5 });
  }
  return points;
}

// ─── GET /directions ──────────────────────────────────────────────────────────
// Params: origin_lat, origin_lng, dest_lat, dest_lng, [waypoint_lat, waypoint_lng]
router.get('/', authenticate, async (req, res) => {
  try {
    const {
      origin_lat, origin_lng, dest_lat, dest_lng,
      waypoint_lat, waypoint_lng,
    } = req.query;

    if (!origin_lat || !origin_lng || !dest_lat || !dest_lng) {
      return res.status(400).json({ success: false, message: 'origin and dest required.' });
    }
    if (!GOOGLE_KEY) {
      return res.status(500).json({ success: false, message: 'Google API key not configured.' });
    }

    const params = {
      origin:      `${origin_lat},${origin_lng}`,
      destination: `${dest_lat},${dest_lng}`,
      key:         GOOGLE_KEY,
      mode:        'driving',
      language:    'en',
    };
    // Optional stopover waypoint (route passes through it)
    if (waypoint_lat && waypoint_lng) {
      params.waypoints = `${waypoint_lat},${waypoint_lng}`;
    }

    const response = await axios.get(
      'https://maps.googleapis.com/maps/api/directions/json', { params }
    );

    if (response.data.status !== 'OK' || !response.data.routes?.length) {
      return res.json({
        success: true,
        // Fallback: straight line if Directions returns nothing
        fallback: true,
        polyline: [
          { latitude: parseFloat(origin_lat), longitude: parseFloat(origin_lng) },
          { latitude: parseFloat(dest_lat),   longitude: parseFloat(dest_lng) },
        ],
        distance_text: null, duration_text: null,
        distance_m: null, duration_s: null,
      });
    }

    const route = response.data.routes[0];
    // Sum all legs (origin→waypoint→dest)
    let distM = 0, durS = 0;
    route.legs.forEach(l => { distM += l.distance.value; durS += l.duration.value; });

    const polyline = decodePolyline(route.overview_polyline.points);

    res.json({
      success: true,
      fallback: false,
      polyline,
      distance_m: distM,
      duration_s: durS,
      distance_text: (distM / 1000).toFixed(1) + ' km',
      duration_text: Math.max(1, Math.round(durS / 60)) + ' min',
      legs: route.legs.map(l => ({
        distance_text: l.distance.text,
        duration_text: l.duration.text,
        start_address: l.start_address,
        end_address:   l.end_address,
      })),
    });
  } catch (err) {
    console.error('directions error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
