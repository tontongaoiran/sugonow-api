/**
 * SugoNow — src/routes/places.js (MEGA)
 *
 * Autocomplete restricted to the currently ACTIVE zone.
 * - While only Flora is active → suggestions biased tightly to Flora
 * - When Luna is activated → suggestions shift to Luna
 * Uses a tight radius + strict bounds so only nearby places show.
 */
const express = require('express');
const axios   = require('axios');
const { query } = require('../db/pool');
const router  = express.Router();

const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY;

// Get the primary active zone center (Flora now, Luna later)
const getActiveZoneCenter = async () => {
  const { rows } = await query(
    `SELECT name, slug, center_lat, center_lng, radius_km
     FROM zones WHERE is_active=TRUE
     ORDER BY radius_km ASC LIMIT 1`
  );
  return rows[0] || { name: 'Flora', slug: 'flora',
                      center_lat: 18.1146, center_lng: 121.4228, radius_km: 20 };
};

router.get('/autocomplete', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) {
      return res.json({ success: true, predictions: [] });
    }
    if (!GOOGLE_KEY) {
      return res.status(500).json({ success: false, message: 'Google API key not configured.' });
    }

    const zone = await getActiveZoneCenter();
    const lat  = parseFloat(zone.center_lat);
    const lng  = parseFloat(zone.center_lng);
    const radiusM = Math.round(parseFloat(zone.radius_km) * 1000);

    const response = await axios.get(
      'https://maps.googleapis.com/maps/api/place/autocomplete/json',
      {
        params: {
          input:        q.trim(),
          key:          GOOGLE_KEY,
          location:     `${lat},${lng}`,
          radius:       radiusM,
          strictbounds: true,            // ONLY results within radius
          components:   'country:ph',
          language:     'en',
        },
      }
    );

    if (response.data.status !== 'OK' && response.data.status !== 'ZERO_RESULTS') {
      // strictbounds can sometimes error if too tight — retry without it
      const retry = await axios.get(
        'https://maps.googleapis.com/maps/api/place/autocomplete/json',
        { params: {
            input: q.trim(), key: GOOGLE_KEY,
            location: `${lat},${lng}`, radius: radiusM,
            components: 'country:ph', language: 'en',
        }}
      );
      const preds = (retry.data.predictions || []).map(p => ({
        place_id: p.place_id, description: p.description,
        main_text: p.structured_formatting?.main_text || p.description,
        secondary: p.structured_formatting?.secondary_text || '',
      }));
      return res.json({ success: true, predictions: preds, zone: zone.name });
    }

    const predictions = (response.data.predictions || []).map(p => ({
      place_id:    p.place_id,
      description: p.description,
      main_text:   p.structured_formatting?.main_text || p.description,
      secondary:   p.structured_formatting?.secondary_text || '',
    }));

    res.json({ success: true, predictions, zone: zone.name });
  } catch (err) {
    console.error('autocomplete error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/details', async (req, res) => {
  try {
    const { place_id } = req.query;
    if (!place_id) return res.status(400).json({ success: false, message: 'place_id required' });

    const response = await axios.get(
      'https://maps.googleapis.com/maps/api/place/details/json',
      { params: {
          place_id, key: GOOGLE_KEY,
          fields: 'geometry,name,formatted_address', language: 'en',
      }}
    );
    if (response.data.status !== 'OK') {
      return res.status(500).json({ success: false, message: 'Place details error' });
    }
    const r = response.data.result;
    const loc = r.geometry?.location;
    if (!loc) return res.status(404).json({ success: false, message: 'Location not found' });

    res.json({
      success: true,
      place: { place_id, name: r.name, address: r.formatted_address, lat: loc.lat, lng: loc.lng },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/reverse-geocode', async (req, res) => {
  try {
    const { lat, lng } = req.query;
    if (!lat || !lng) return res.status(400).json({ success: false, message: 'lat/lng required' });
    const response = await axios.get(
      'https://maps.googleapis.com/maps/api/geocode/json',
      { params: { latlng: `${lat},${lng}`, key: GOOGLE_KEY, language: 'en' } }
    );
    res.json({
      success: true,
      address: response.data.results?.[0]?.formatted_address || 'Pinned location',
    });
  } catch (err) {
    res.json({ success: true, address: 'Pinned location' });
  }
});

module.exports = router;
