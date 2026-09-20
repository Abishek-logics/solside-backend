const express = require('express');
const cors = require('cors');
const axios = require('axios');
const SunCalc = require('suncalc');

const app = express();
app.use(cors());
app.use(express.json());

// Helper: Calculate bearing angle between two lat/lng points (in degrees)
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

// SolSide Prediction Endpoint
app.post('/api/v1/predict-shade', async (req, res) => {
  try {
    const { origin_lat, origin_lng, dest_lat, dest_lng, departure_time, duration_hours } = req.body;

    if (!origin_lat || !origin_lng || !dest_lat || !dest_lng || !departure_time || !duration_hours) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // 1. Fetch route geometry from OpenStreetMap OSRM API
    const osrmUrl = `http://router.project-osrm.org/route/v1/driving/${origin_lng},${origin_lat};${dest_lng},${dest_lat}?overview=full&geometries=geojson`;
    const routeResponse = await axios.get(osrmUrl);

    if (!routeResponse.data.routes || routeResponse.data.routes.length === 0) {
      return res.status(404).json({ error: 'Route not found' });
    }

    const coordinates = routeResponse.data.routes[0].geometry.coordinates;
    
    // 2. Sample points along route and calculate solar orientation
    const startTime = new Date(departure_time);
    const totalSamples = 10;
    let leftShadeScore = 0;

    for (let i = 0; i < totalSamples; i++) {
      const progressRatio = i / (totalSamples - 1);
      const coordIndex = Math.floor(progressRatio * (coordinates.length - 1));
      const [currentLng, currentLat] = coordinates[coordIndex];

      const sampleTime = new Date(startTime.getTime() + progressRatio * duration_hours * 3600 * 1000);

      const nextIndex = Math.min(coordIndex + 1, coordinates.length - 1);
      const [nextLng, nextLat] = coordinates[nextIndex];
      const routeBearing = calculateBearing(currentLat, currentLng, nextLat, nextLng);

      const sunPosition = SunCalc.getPosition(sampleTime, currentLat, currentLng);
      const sunAzimuthDeg = ((sunPosition.azimuth * 180) / Math.PI + 180) % 360;

      const relativeSunAngle = (sunAzimuthDeg - routeBearing + 360) % 360;

      if (relativeSunAngle > 0 && relativeSunAngle < 180) {
        leftShadeScore++;
      }
    }

    const leftPercentage = Math.round((leftShadeScore / totalSamples) * 100);
    const rightPercentage = 100 - leftPercentage;
    const recommendedSide = leftPercentage >= rightPercentage ? 'LEFT' : 'RIGHT';
    const winningPercentage = Math.max(leftPercentage, rightPercentage);

    return res.json({
      status: 'success',
      engine: 'SolSide-v1',
      recommended_side: recommendedSide,
      left_side_shade_percentage: leftPercentage,
      right_side_shade_percentage: rightPercentage,
      badge_label: `${winningPercentage}% Shaded Route`
    });

  } catch (error) {
    console.error('Error calculating shade:', error.message);
    return res.status(500).json({ error: 'Internal server error calculating route shade' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SolSide Engine running locally on http://localhost:${PORT}`);
});