const express = require('express');
const cors = require('cors');
const axios = require('axios');
const SunCalc = require('suncalc');

const app = express();

app.use(cors());
app.use(express.json());

// Helper: Calculate bearing angle between two coordinates (in degrees)
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

app.post('/api/v1/predict-shade', async (req, res) => {
  try {
    const { origin_lat, origin_lng, dest_lat, dest_lng, departure_time } = req.body;

    if (!origin_lat || !origin_lng || !dest_lat || !dest_lng || !departure_time) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing required fields: origin_lat, origin_lng, dest_lat, dest_lng, departure_time'
      });
    }

    // 1. Fetch real road geometry & travel duration from OSRM
    const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${origin_lng},${origin_lat};${dest_lng},${dest_lat}?overview=full&geometries=geojson`;
    const routeResponse = await axios.get(osrmUrl);

    if (!routeResponse.data.routes || routeResponse.data.routes.length === 0) {
      return res.status(404).json({ status: 'error', message: 'No route found between coordinates.' });
    }

    const routeData = routeResponse.data.routes[0];
    const durationSeconds = routeData.duration;
    const coordinates = routeData.geometry.coordinates;

    const startTime = new Date(departure_time);
    let leftShadeSum = 0;
    const segmentCount = coordinates.length - 1;

    // 2. Evaluate sun position for each road segment along the route
    for (let i = 0; i < segmentCount; i++) {
      const [startLng, startLat] = coordinates[i];
      const [endLng, endLat] = coordinates[i + 1];

      const segmentBearing = calculateBearing(startLat, startLng, endLat, endLng);
      const segmentTime = new Date(startTime.getTime() + (durationSeconds * 1000 * (i / segmentCount)));

      const sunPos = SunCalc.getPosition(segmentTime, startLat, startLng);
      const sunAzimuthDeg = (sunPos.azimuth * (180 / Math.PI) + 180) % 360;

      let relativeAngle = (sunAzimuthDeg - segmentBearing + 360) % 360;

      if (relativeAngle > 180) {
        leftShadeSum += 100;
      }
    }

    const avgLeftShade = Math.round(leftShadeSum / segmentCount);
    const avgRightShade = 100 - avgLeftShade;
    const recommendedSide = avgLeftShade >= 50 ? 'LEFT' : 'RIGHT';

    // 3. Return dynamic payload
    return res.json({
      status: 'success',
      engine: 'SolSide-v1-OSRM',
      route_details: {
        distance_km: (routeData.distance / 1000).toFixed(2),
        estimated_duration_minutes: Math.round(durationSeconds / 60)
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