const express = require('express');
const cors = require('cors');
const axios = require('axios');
const SunCalc = require('suncalc');

const app = express();

app.use(cors());
app.use(express.json());

// Helper 1: Calculate initial bearing between two GPS coordinates (in degrees 0-360)
function calculateBearing(startLat, startLng, destLat, destLng) {
  const startLatRad = (startLat * Math.PI) / 180;
  const destLatRad = (destLat * Math.PI) / 180;
  const dLngRad = ((destLng - startLng) * Math.PI) / 180;

  const y = Math.sin(dLngRad) * Math.cos(destLatRad);
  const x =
    Math.cos(startLatRad) * Math.sin(destLatRad) -
    Math.sin(startLatRad) * Math.cos(destLatRad) * Math.cos(dLngRad);

  const bearingRad = Math.atan2(y, x);
  return ((bearingRad * 180) / Math.PI + 360) % 360;
}

// Helper 2: Calculate distance between two GPS points in meters (Haversine Formula)
function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Earth radius in meters
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

app.post('/api/v1/predict-shade', async, async (req, res) => {
  try {
    const { origin_lat, origin_lng, dest_lat, dest_lng, departure_time, via_lat, via_lng } = req.body;

    if (!origin_lat || !origin_lng || !dest_lat || !dest_lng || !departure_time) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing required fields: origin_lat, origin_lng, dest_lat, dest_lng, departure_time'
      });
    }

    // 1. Build OSRM route URL
    let coordinatesPath = `${origin_lng},${origin_lat}`;
    if (via_lat && via_lng) {
      coordinatesPath += `;${via_lng},${via_lat}`;
    }
    coordinatesPath += `;${dest_lng},${dest_lat}`;

    const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${coordinatesPath}?overview=full&geometries=geojson`;
    const routeResponse = await axios.get(osrmUrl);

    if (!routeResponse.data.routes || routeResponse.data.routes.length === 0) {
      return res.status(404).json({ status: 'error', message: 'No route found between coordinates.' });
    }

    const routeData = routeResponse.data.routes[0];
    const carDurationSeconds = routeData.duration;
    const coordinates = routeData.geometry.coordinates; // Array of [lng, lat]

    // Bus speed correction factor (1.55x for intercity transit)
    const BUS_SPEED_FACTOR = 1.55;
    const busDurationSeconds = carDurationSeconds * BUS_SPEED_FACTOR;
    const totalDistanceMeters = routeData.distance;

    const startTime = new Date(departure_time);

    let rightShadeTimeSeconds = 0;
    let leftShadeTimeSeconds = 0;
    let daylightTimeSeconds = 0;

    const segmentCount = coordinates.length - 1;

    let totalGeometryMeters = 0;
    const segmentDistances = [];
    for (let i = 0; i < segmentCount; i++) {
      const [startLng, startLat] = coordinates[i];
      const [endLng, endLat] = coordinates[i + 1];
      const dist = calculateDistanceMeters(startLat, startLng, endLat, endLng);
      segmentDistances.push(dist);
      totalGeometryMeters += dist;
    }

    let accumulatedTimeSeconds = 0;

    // 2. Evaluate each road segment using 2D Cross-Product Vector Analysis
    for (let i = 0; i < segmentCount; i++) {
      const [startLng, startLat] = coordinates[i];
      const [endLng, endLat] = coordinates[i + 1];

      const segmentDist = segmentDistances[i];
      if (segmentDist === 0) continue;

      const segmentTimeFraction = totalGeometryMeters > 0 ? segmentDist / totalGeometryMeters : 1 / segmentCount;
      const segmentDurationSeconds = busDurationSeconds * segmentTimeFraction;

      const segmentMidpointTime = new Date(startTime.getTime() + (accumulatedTimeSeconds + segmentDurationSeconds / 2) * 1000);
      accumulatedTimeSeconds += segmentDurationSeconds;

      // Get accurate solar coordinates using SunCalc
      const sunPos = SunCalc.getPosition(segmentMidpointTime, startLat, startLng);
      const sunAzimuthDeg = ((sunPos.azimuth * (180 / Math.PI)) + 180) % 360;
      const sunElevationDeg = sunPos.altitude * (180 / Math.PI);

      // Skip night-time segments where sun is below horizon
      if (sunElevationDeg <= 0) {
        continue;
      }

      daylightTimeSeconds += segmentDurationSeconds;

      // 2D Vector Components
      const busDx = endLng - startLng; // East/West travel vector component
      const busDy = endLat - startLat; // North/South travel vector component

      const sunAzimuthRad = (sunAzimuthDeg * Math.PI) / 180;
      const sunX = Math.sin(sunAzimuthRad); // Sun East component
      const sunY = Math.cos(sunAzimuthRad); // Sun North component

      // 2D Cross Product (Determinant) to find relative side placement unambiguously
      const crossProduct = (busDx * sunY) - (busDy * sunX);

      if (crossProduct > 0.00001) {
        // Sun is to the LEFT of the bus heading -> RIGHT side is shaded
        rightShadeTimeSeconds += segmentDurationSeconds;
      } else if (crossProduct < -0.00001) {
        // Sun is to the RIGHT of the bus heading -> LEFT side is shaded
        leftShadeTimeSeconds += segmentDurationSeconds;
      } else {
        // Split evenly if perfectly aligned
        leftShadeTimeSeconds += segmentDurationSeconds / 2;
        rightShadeTimeSeconds += segmentDurationSeconds / 2;
      }
    }

    // Handle Night Trips (Zero daylight hours detected)
    if (daylightTimeSeconds === 0) {
      return res.json({
        status: 'success',
        engine: 'SolSide-v3.2-VectorCross',
        is_night_trip: true,
        route_details: {
          distance_km: (totalDistanceMeters / 1000).toFixed(2),
          estimated_bus_duration_minutes: Math.round(busDurationSeconds / 60),
          estimated_bus_duration_hours: (busDurationSeconds / 3600).toFixed(1)
        },
        recommended_side: 'ANY',
        left_side_shade_percentage: 100,
        right_side_shade_percentage: 100,
        badge_label: '🌙 Night Trip — No Direct Sun Exposure'
      });
    }

    const avgLeftShade = Math.round((leftShadeTimeSeconds / daylightTimeSeconds) * 100);
    const avgRightShade = 100 - avgLeftShade;
    const recommendedSide = avgLeftShade >= avgRightShade ? 'LEFT' : 'RIGHT';

    return res.json({
      status: 'success',
      engine: 'SolSide-v3.2-VectorCross',
      is_night_trip: false,
      route_details: {
        distance_km: (totalDistanceMeters / 1000).toFixed(2),
        estimated_bus_duration_minutes: Math.round(busDurationSeconds / 60),
        estimated_bus_duration_hours: (busDurationSeconds / 3600).toFixed(1)
      },
      recommended_side: recommendedSide,
      left_side_shade_percentage: avgLeftShade,
      right_side_shade_percentage: avgRightShade,
      badge_label: `${recommendedSide === 'LEFT' ? avgLeftShade : avgRightShade}% Shaded Route`
    });

  } catch (error) {
    console.error('Shade Calculation Error:', error.message);
    return res.status(500).json({ status: 'error', message: 'Internal server error processing route.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SolSide backend listening on port ${PORT}`);
});