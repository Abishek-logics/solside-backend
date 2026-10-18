const express = require('express');
const cors = require('cors');
const axios = require('axios');
const SunCalc = require('suncalc');

const app = express();

app.use(cors());
app.use(express.json());

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

function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
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

app.post('/api/v1/predict-shade', async (req, res) => {
  try {
    const { origin_lat, origin_lng, dest_lat, dest_lng, departure_time, via_lat, via_lng } = req.body;

    if (!origin_lat || !origin_lng || !dest_lat || !dest_lng || !departure_time) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing required fields: origin_lat, origin_lng, dest_lat, dest_lng, departure_time'
      });
    }

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
    const coordinates = routeData.geometry.coordinates;

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

    for (let i = 0; i < segmentCount; i++) {
      const [startLng, startLat] = coordinates[i];
      const [endLng, endLat] = coordinates[i + 1];

      const segmentDist = segmentDistances[i];
      if (segmentDist === 0) continue;

      const segmentTimeFraction = totalGeometryMeters > 0 ? segmentDist / totalGeometryMeters : 1 / segmentCount;
      const segmentDurationSeconds = busDurationSeconds * segmentTimeFraction;

      const segmentMidpointTime = new Date(startTime.getTime() + (accumulatedTimeSeconds + segmentDurationSeconds / 2) * 1000);
      accumulatedTimeSeconds += segmentDurationSeconds;

      const busHeading = calculateBearing(startLat, startLng, endLat, endLng);

      const sunPos = SunCalc.getPosition(segmentMidpointTime, startLat, startLng);
      const sunAzimuthDeg = ((sunPos.azimuth * (180 / Math.PI)) + 180) % 360;
      const sunElevationDeg = sunPos.altitude * (180 / Math.PI);

      // CRITICAL FIX: Skip solar calculations when the sun is below the horizon
      if (sunElevationDeg <= 0) {
        continue; // Do not count night segments as daylight shade
      }

      daylightTimeSeconds += segmentDurationSeconds;

      const relativeSunAngle = (sunAzimuthDeg - busHeading + 360) % 360;

      if (relativeSunAngle > 0 && relativeSunAngle < 180) {
        // Sun on RIGHT side -> LEFT side is shaded
        leftShadeTimeSeconds += segmentDurationSeconds;
      } else if (relativeSunAngle > 180 && relativeSunAngle < 360) {
        // Sun on LEFT side -> RIGHT side is shaded
        rightShadeTimeSeconds += segmentDurationSeconds;
      } else {
        leftShadeTimeSeconds += segmentDurationSeconds / 2;
        rightShadeTimeSeconds += segmentDurationSeconds / 2;
      }
    }

    // CHECK FOR NIGHT TRIP: If entire trip happens when sun is below horizon
    if (daylightTimeSeconds === 0) {
      return res.json({
        status: 'success',
        engine: 'SolSide-v3.1-NightAware',
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
      engine: 'SolSide-v3.1-NightAware',
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