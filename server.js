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
    const { origin_lat, origin_lng, dest_lat, dest_lng, departure_time, via_lat, via_lng } = req.body;

    if (!origin_lat || !origin_lng || !dest_lat || !dest_lng || !departure_time) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing required fields: origin_lat, origin_lng, dest_lat, dest_lng, departure_time'
      });
    }

    // 1. Construct OSRM URL (supports optional via-waypoint for exact highway targeting)
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

    // 2. BUS SPEED CALIBRATION:
    // OSRM outputs car speeds (~80-100 km/h). Commercial buses average ~50-55 km/h including stops.
    // Factor 1.55 scales a ~4-hour car run to a realistic ~6.5-7 hour intercity bus schedule.
    const BUS_SPEED_FACTOR = 1.55;
    const busDurationSeconds = carDurationSeconds * BUS_SPEED_FACTOR;

    const startTime = new Date(departure_time);
    let leftShadeSum = 0;
    const segmentCount = coordinates.length - 1;

    // 3. Evaluate solar position along each road segment based on adjusted bus time
    for (let i = 0; i < segmentCount; i++) {
      const [startLng, startLat] = coordinates[i];
      const [endLng, endLat] = coordinates[i + 1];

      const segmentBearing = calculateBearing(startLat, startLng, endLat, endLng);
      
      // Calculate exact time the bus passes this segment
      const progressRatio = i / segmentCount;
      const segmentTime = new Date(startTime.getTime() + (busDurationSeconds * 1000 * progressRatio));

      // Compute solar azimuth at segment location and time
      const sunPos = SunCalc.getPosition(segmentTime, startLat, startLng);
      const sunAzimuthDeg = (sunPos.azimuth * (180 / Math.PI) + 180) % 360;

      // Compute relative angle of sun relative to bus heading
      let relativeAngle = (sunAzimuthDeg - segmentBearing + 360) % 360;

      // Relative angle 180° to 360° = Sun on Left (Right gets shade)
      // Relative angle 0° to 180° = Sun on Right (Left gets shade)
      if (relativeAngle > 180) {
        leftShadeSum += 100;
      }
    }

    const avgLeftShade = Math.round(leftShadeSum / segmentCount);
    const avgRightShade = 100 - avgLeftShade;
    const recommendedSide = avgLeftShade >= 50 ? 'LEFT' : 'RIGHT';

    return res.json({
      status: 'success',
      engine: 'SolSide-v2-Predictive',
      route_details: {
        distance_km: (routeData.distance / 1000).toFixed(2),
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